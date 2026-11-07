// @ts-nocheck
// odd-worktree-tools.ts — the standalone odd-worktree Pi extension.
//
// One package, one surface: the agent worktree tools (create, list, close,
// warp) and the two read/inspect panels they belong to.
//
// Registers three commands:
//   /warp      move this session to another checkout of the project
//   /odd-list  read this checkout's odd/ documents
//   /issues    read this checkout's GitHub issues, with label/assignee,
//              comment and close actions when the repository permits them
//
// and four tools: worktree_create, worktree_list, worktree_close,
// worktree_warp. Create and close prompt for approval when the host offers
// dialog UI; list never mutates anything; warp hands the move to /warp.
//
// Herdr is optional, never required: every Herdr call is attempted first and
// falls back to plain git, so the package works in Pi alone.
//
// The file is plain JavaScript with a .ts extension (// @ts-nocheck, no type
// annotations), so the test copy-to-.mjs loading pattern keeps working under
// plain node.

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// Package-side helpers live in lib/. Tests point GENTLE_WORKTREE_LIB_DIR
// at the real lib dir before importing the copied module; production
// resolves relative to this file.
function libRequire(name) {
  const override = process.env.GENTLE_WORKTREE_LIB_DIR;
  const dir = typeof override === "string" && override.length > 0
    ? override
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  return require(path.join(dir, name));
}

// S21 (round 3): no INTERACTIVE path may block the host event loop. Every
// child reached from a session command, a tool handler or a TUI action —
// create, close, warp, list/open/enter, delete-from-warp, and their
// preflight/evidence reads — goes through this seam, the shared async
// runner, and is awaited. `spawnSync` there froze the whole session for the
// child's lifetime (timeouts reach 120 s), which is what the user hit when a
// create or a Warp delete stalled Pi beyond recovery.
//
// What does NOT change: the binary, the fixed argv and its element order, the
// per-call timeout, the refusal/approval text and the order of side effects.
// The runner resolves the same `{status, stdout, stderr, error}` shape, so the
// callers above are byte-identical; only the wait moved off the loop.
function libRunner(git) {
  // The convention every lib helper uses for its injected runner:
  // `(bin, args, cwd) => Promise<{status, stdout, stderr, error}>`.
  return (bin, args, cwd) => git.runArgvAsync(bin, args, { cwd });
}

// Pi's TUI helpers are resolved lazily INSIDE a handler, never imported at
// module load: a top-level import would force every test loader to stub it.
// Tests replace this seam per load.
let warpTuiLoader = () => import("@earendil-works/pi-tui");

function setWarpTuiLoader(loader) {
  warpTuiLoader = loader;
}

// The herdr binary honors the documented HERDR_BIN_PATH override (tests),
// else `herdr` on PATH.
//
// lib/worktree-git.js `resolveHerdrBinary` is the SINGLE authority and its
// answer is propagated verbatim, including its refusal: under the test harness
// (GENTLE_WORKTREE_LIB_DIR, set only by the test loaders) a value that may be
// the live binary is refused unless the CURRENT test opted in with
// GENTLE_WORKTREE_ALLOW_LIVE_HERDR=1. A `catch {}` around that call used to
// swallow the refusal and then re-apply an inherited HERDR_BIN_PATH here, which
// handed a test process exactly the live binary the authority had just refused
// (a real Herdr workspace, created from a test). No fallback in this file may
// re-decide the binary: the only remaining branch is for a lib that is missing
// entirely, and it fails closed under the harness.
function herdrBinary() {
  let git = null;
  try {
    git = libRequire("worktree-git.js");
  } catch {
    git = null;
  }
  if (git && typeof git.resolveHerdrBinary === "function") {
    return git.resolveHerdrBinary(process.env);
  }
  const harness = process.env.GENTLE_WORKTREE_LIB_DIR;
  if (typeof harness === "string" && harness.length > 0) {
    throw new Error(
      "refusing to run live herdr from a test harness: herdr binary cannot be resolved "
      + "(lib/worktree-git.js is unavailable, so no binary is injected)",
    );
  }
  const bin = process.env.HERDR_BIN_PATH;
  if (typeof bin === "string" && bin.length > 0) return bin;
  return "herdr";
}

// The texts the authority (and the missing-lib branch above) use to refuse.
// Matching on text keeps the boundary between lib and extension small: a
// refusal is a resolved STATE, not an error class shared across it.
const HERDR_REFUSAL_PATTERN = /refusing to run live herdr|herdr binary is not injected/;

function isHerdrRefusal(err) {
  return !!(
    err
    && typeof err.message === "string"
    && HERDR_REFUSAL_PATTERN.test(err.message)
  );
}

function toolCwd(ctx) {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
  return process.cwd();
}

// S11: ONE wording for every surface that needs a checkout. The human
// command and the agent tool both answer a directory outside a Git
// repository with this exact sentence, so neither reads a different
// story about the same condition.
function notGitRepositoryLine(cwd) {
  return `not a git repository: ${cwd}; run 'git init' first`;
}

// Consolidated liveness predicate: the ONE definition of "is this path a
// real, live checkout?" Every call site below (list liveness + prune +
// extras, create idempotency + conflict guard + refusals + verification,
// close pre/post checks + vanished comparison) resolves through this, so
// the question is never re-answered with slightly different logic.
//
// Returns {absolute, real, exists, isDirectory} and never throws:
// - absolute: the path resolved WITHOUT the process cwd (absolute inputs
//   via path.resolve, which never consults the cwd for them; relative
//   inputs against the repository root). A non-absolute input with no
//   repository root yields no state at all (absolute null).
// - real: the symlink-resolved realpath, or null when the filesystem
//   cannot resolve it (missing checkout, dangling link).
// - exists: something is present (statSync, which FOLLOWS symlinks, so a
//   dangling link reads as absent).
// - isDirectory: that something is a directory — a FILE at the path is
//   not a checkout, so liveness always requires exists && isDirectory.
function checkoutState(entryPath, repoRoot) {
  const none = { absolute: null, real: null, exists: false, isDirectory: false };
  try {
    if (typeof entryPath !== "string" || entryPath.length === 0) return { ...none };
    let absolute = null;
    try {
      if (path.isAbsolute(entryPath)) absolute = path.resolve(entryPath);
      else {
        if (typeof repoRoot !== "string" || repoRoot.length === 0) return { ...none };
        absolute = path.resolve(repoRoot, entryPath);
      }
    } catch {
      return { ...none };
    }
    if (absolute === null) return { ...none };
    let exists = false;
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(absolute).isDirectory();
      exists = true;
    } catch {
      exists = false;
      isDirectory = false;
    }
    let real = null;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      real = null;
    }
    return { absolute, real, exists, isDirectory };
  } catch {
    return { absolute: null, real: null, exists: false, isDirectory: false };
  }
}

// Realpath identities of live checkouts, for symlink-transparent
// liveness: a registry row that reaches a live checkout through a
// symlink shares its realpath even though the spellings differ. Built
// through checkoutState: a git entry contributes only when something
// exists there AND it is a directory, so a hand-deleted checkout git
// still records never makes a row live. Relative list paths (never
// expected from git) resolve against the repository root, never the
// process cwd.
function liveIdentities(listed, repoRoot) {
  const ids = new Set();
  for (const entry of listed || []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    if (!st.exists || !st.isDirectory) continue;
    if (st.real !== null) ids.add(st.real);
    else if (st.absolute !== null) ids.add(st.absolute);
  }
  return ids;
}

// A git listing record names a LIVE checkout only through the one
// predicate: its path resolves (absolute inputs directly, relative inputs
// against the repository root, never the process cwd) AND something
// exists there AND it is a directory. A record git still holds for a
// hand-deleted checkout, or for a path replaced by a FILE, is stale and
// never blocks a create, never reads live in the list, and never passes
// the close pre-check.
function isLiveGitRecord(entry, repoRoot) {
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return false;
  const st = checkoutState(entry.path, repoRoot);
  return st.absolute !== null && st.exists && st.isDirectory;
}

// Marks a TypeBox property optional. Production `Type` is the full TypeBox
// export, but older test doubles stub only the constructors the tools
// needed; falling back to the bare schema keeps the module loadable there
// while production still gets true optionals.
// Older test doubles stub only the constructors the tools needed;
// Type.Union is the production shape for string-or-array options, so
// the one option that needs it degrades to a bare string schema when
// the host Type has no Union (tests) instead of failing the load.
function unionSchema(schemas, opts) {
  try {
    if (Type && typeof Type.Union === 'function') return Type.Union(schemas, opts);
  } catch {
    // Fall through to the stub-compatible shape below.
  }
  return Type.String();
}
function opt(schema) {
  if (Type && typeof Type.Optional === "function") return Type.Optional(schema);
  return schema;
}

// Thread identity source precedence (which source won is returned in
// `source` so callers and tests can tell):
//  1. GENTLE_WORKTREE_THREAD environment override (tests).
//  2. The Pi host session id via ctx.sessionManager.getSessionId() — the
//     documented accessor on the session manager, the same one
//     extensions/gentle-herdr-state.ts uses. Never invented, never guessed.
function resolveThread(ctx) {
  const override = process.env.GENTLE_WORKTREE_THREAD;
  if (typeof override === "string" && override.length > 0) {
    return { thread: override, source: "env:GENTLE_WORKTREE_THREAD" };
  }
  let id;
  try {
    id = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function"
      ? ctx.sessionManager.getSessionId()
      : undefined;
  } catch {
    id = undefined;
  }
  if (typeof id === "string" && id.length > 0) {
    return { thread: id, source: "session:getSessionId" };
  }
  return { thread: undefined, source: "none" };
}

function textResult(text, details, isError) {
  const result = { content: [{ type: "text", text }], details };
  if (isError) result.isError = true;
  return result;
}

function errorResult(text, details) {
  return textResult(text, details || {}, true);
}

// The visible text of a TOOL result — the shape `textResult`/`errorResult`
// build: `{ content: [{ type: "text", text }] }`. A warp failure is a
// DIFFERENT shape (`{ text }`), so a refusal forwarded from a tool call must be
// flattened here: reading `.text` off a tool result yields undefined, and the
// reason then never reaches the human at all. Both shapes are accepted exactly
// as they are; nothing is invented.
function toolResultText(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string" && result.text.length > 0) return result.text;
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

// S19 bounded agent text: short ordered lines in the warp moved/to
// spirit. Branch names, paths and session ids reach the transcript
// through these builders only, cleaned by the shared warpClean helper
// (defined below; hoisted) so the text and the card never drift into
// two notions of cleaning. Failure texts are untouched and stay
// byte-identical. `slugOf` mirrors lib/worktree-git.js slugifyBranch —
// the flattened slug the listing prints and warp accepts — so the agent
// text and the card agree without a new import. (Named slugPart: slugOf
// already names the git-backed resolver further below.)
function slugPart(branch) {
  try {
    const slug = String(branch ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? 'worktree' : slug;
  } catch {
    return 'worktree';
  }
}

// S6: a create result names the checkout and where it landed — never an
// issue or ODD association, which this tool no longer accepts, verifies or
// records. `alreadyExists` keeps the historical no-op wording: a thread that
// already owns the checkout gets that checkout back, stated as such.
function createSuccessText(branch, target, alreadyExists) {
  const name = warpClean(branch, 'worktree');
  const head = alreadyExists === true
    ? `created: ${slugPart(branch)} · ${name} · already exists`
    : `created: ${slugPart(branch)} · ${name}`;
  return [head, `path: ${warpClean(target, '(unknown path)')}`].join('\n');
}

// S6: ONE CodeGraph fact per create, read from the creation hooks' own
// `codegraph-init` step — the initialisation is never re-run or inferred here.
// `status` is the hook step's status (`done`, `skipped`, `failed`), or
// `not-run` for a call that reached no hooks at all (the thread's checkout
// already existed).
function codegraphStatus(hooks) {
  const steps = hooks && Array.isArray(hooks.steps) ? hooks.steps : [];
  const step = steps.find((entry) => entry && entry.name === 'codegraph-init');
  if (!step) return { status: 'not-run', detail: 'the creation hooks did not run' };
  if (step.status === 'done') return { status: 'done', detail: '' };
  // The interactive create hands the slow setup to a background task, so the
  // honest fact at return time is "not yet", never a claimed init.
  if (step.status === 'pending') {
    const detail = typeof step.detail === 'string' && step.detail.length > 0 ? step.detail : 'setup runs in the background';
    return { status: 'pending', detail };
  }
  if (step.status === 'skipped') {
    const detail = typeof step.detail === 'string' && step.detail.length > 0 ? step.detail : 'skipped';
    return { status: 'skipped', detail };
  }
  return { status: 'failed', detail: 'init failed' };
}

// S6/S7: the CodeGraph fact for a checkout this call did NOT index. A create
// never initializes an existing checkout's index (the no-double-init rule), so
// the honest answer is the state that checkout already has — read from disk
// (`.codegraph/codegraph.db`, the file `codegraph init` writes) and never
// created, refreshed or removed here. `present` reads as initialized and
// `absent` as not initialized: both are readings of the checkout, not the
// "not run" excuse that said nothing about the index.
function codegraphIndexState(checkoutPath) {
  try {
    const db = path.join(checkoutPath, '.codegraph', 'codegraph.db');
    if (fs.statSync(db).isFile()) return { status: 'present', detail: '' };
  } catch {
    // No readable index: report the absence rather than creating one.
  }
  return { status: 'absent', detail: '' };
}

// The one visible line for that fact: what CodeGraph did, or an honest
// "not initialized"/"not run" with the reason the hook recorded.
function codegraphLine(codegraph) {
  if (!codegraph || typeof codegraph !== 'object') return null;
  switch (codegraph.status) {
    case 'done':
    case 'present':
      return 'codegraph: initialized';
    case 'absent':
      return 'codegraph: not initialized';
    case 'skipped':
    case 'failed':
      return `codegraph: not initialized (${codegraph.detail})`;
    case 'pending':
      return `codegraph: pending (${codegraph.detail})`;
    case 'not-run':
      return `codegraph: not run (${codegraph.detail})`;
    default:
      return null;
  }
}

// Warnings are already summarized prose, but a hook can hand over a child's
// stderr: the create text keeps the one-fact-per-line shape by folding every
// warning onto a single escape-free line, exactly like the card does.
function warningRow(warning) {
  const text = String(warning ?? '')
    .replace(/\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? `warning: ${text}` : null;
}

function closeSuccessText(branch, branchKept) {
  const name = warpClean(branch, 'worktree');
  return `removed: ${slugPart(branch)} · ${name}\n${branchKept === false ? 'branch deleted' : 'branch kept'}`;
}

// Worktree tool card wiring: each registered
// tool draws the compact/expandable native card from lib/worktree-card.js
// through its own renderShell/renderCall/renderResult, so execute,
// schemas, content and details stay exactly as they are. Width helpers
// resolve lazily here — never a top-level package import (S6/S10: every
// test loader stubs only the two package import lines) — preferring the
// real pi-tui measurement (emoji/wide-char aware) and degrading to the
// lib's local fallback when the host has no such module. keyHint rides
// along only when the coding-agent module resolves; otherwise the lib's
// static ctrl+o hint stands in. Renderers are cached per helpers
// identity because Pi re-renders every visible card each frame.
let worktreeCardHelpersOverride;
let worktreeCardCache = null;
// The runtime resolution below runs once per process: rebuilding the
// helpers object on every render would defeat the per-identity card
// cache above (a fresh identity busts it each time). The injectable seam
// still wins whenever set, and resetting it returns to this stable
// resolution — never to a fresh rebuild.
let worktreeCardAutoHelpers;
let worktreeCardAutoResolved = false;

function setWorktreeCardHelpers(helpers) {
  worktreeCardHelpersOverride = helpers;
  worktreeCardCache = null;
}

function loadRuntimeCardHelpers() {
  try {
    const tui = require("@earendil-works/pi-tui");
    const helpers = {};
    if (tui && typeof tui.visibleWidth === "function") helpers.visibleWidth = tui.visibleWidth;
    if (tui && typeof tui.truncateToWidth === "function") {
      helpers.truncateToWidth = (text, width, ellipsis) => tui.truncateToWidth(text, width, ellipsis);
    }
    try {
      const agent = require("@earendil-works/pi-coding-agent");
      if (agent && typeof agent.keyHint === "function") helpers.keyHint = agent.keyHint;
    } catch {
      // keyHint stays on the lib's static fallback; never fatal.
    }
    return helpers;
  } catch {
    return null;
  }
}

function resolveWorktreeCardHelpers() {
  if (worktreeCardHelpersOverride !== undefined) return worktreeCardHelpersOverride || null;
  if (!worktreeCardAutoResolved) {
    worktreeCardAutoResolved = true;
    worktreeCardAutoHelpers = loadRuntimeCardHelpers();
  }
  return worktreeCardAutoHelpers;
}

// Click-to-expand host wiring (docs/worktree-tools.md, "Expanding a card").
// The card's toggle seam is INJECTED, never baked in, because a render hook
// receives theme plus ToolRenderContext and never an ExtensionContext. So the
// extension remembers the CURRENT session's UI handle here, and the injected
// callback reads it when the click arrives. That is also what keeps a card
// from outliving its session: `session_start` replaces the handle and
// `session_shutdown` drops it, so a card re-rendered after a switch toggles
// the live session and never a context the runtime already invalidated.
let worktreeCardUi = null;

// Only a UI that publishes BOTH expansion methods is a toggle target. A
// no-UI mode (`hasUI: false`, json/print) or a host double without the pair
// resolves to null, which is what keeps those cards keyboard-only.
function usableWorktreeCardUi(ctx) {
  try {
    const c = ctx && typeof ctx === "object" ? ctx : null;
    if (!c || c.hasUI === false) return null;
    const ui = c.ui;
    if (!ui || typeof ui.getToolsExpanded !== "function" || typeof ui.setToolsExpanded !== "function") return null;
    return ui;
  } catch {
    return null;
  }
}

// Session lifecycle hooks. Named and idempotent, so a reload, a session
// replacement and an early shutdown all converge on the same state.
function rememberWorktreeCardUi(event, ctx) {
  worktreeCardUi = usableWorktreeCardUi(ctx);
}

function forgetWorktreeCardUi() {
  worktreeCardUi = null;
}

// The toggle the card calls on a hint click: the host's OWN flag, read fresh
// and flipped, so `ctrl+o` and a click can never disagree. A UI that throws is
// contained by the card's seam, so this never breaks the transcript.
function toggleWorktreeCardExpanded() {
  const ui = worktreeCardUi;
  if (!ui) return;
  ui.setToolsExpanded(!ui.getToolsExpanded());
}

// The card dependency object: the resolved helpers plus the host toggle when a
// session UI can take it. Memoized by helpers identity AND seam availability,
// so the per-identity card cache below still hits on every frame instead of
// rebuilding a card per render.
let worktreeCardDepsCache = null;

function worktreeCardDeps() {
  const base = resolveWorktreeCardHelpers() || undefined;
  const seamed = worktreeCardUi !== null;
  const cached = worktreeCardDepsCache;
  if (!cached || cached.base !== base || cached.seamed !== seamed) {
    const deps = seamed ? { ...(base || {}), toggleExpanded: toggleWorktreeCardExpanded } : base;
    worktreeCardDepsCache = { base, seamed, deps };
  }
  return worktreeCardDepsCache.deps;
}

function worktreeCardFor(toolName) {
  const helpers = worktreeCardDeps();
  if (!worktreeCardCache || worktreeCardCache.helpers !== helpers) {
    worktreeCardCache = { helpers, cards: new Map() };
  }
  let card = worktreeCardCache.cards.get(toolName);
  if (!card) {
    card = libRequire("worktree-card.js").createWorktreeCardRenderer(toolName, helpers);
    worktreeCardCache.cards.set(toolName, card);
  }
  return card;
}

// Spreads nothing and keeps the defineTool identity: the card hooks are
// assigned onto the definition, so a failure anywhere above returns the
// tool untouched and execution never depends on rendering. The hooks
// resolve the cached card per invocation (one Map hit) so an injected
// helpers seam set after load still reaches every render.
function withWorktreeCardRenderer(tool) {
  try {
    const card = worktreeCardFor(tool.name);
    tool.renderShell = card.renderShell;
    tool.renderCall = (...args) => worktreeCardFor(tool.name).renderCall(...args);
    tool.renderResult = (...args) => worktreeCardFor(tool.name).renderResult(...args);
  } catch {
    // Rendering stays generic; the tool itself is unaffected.
  }
  // Model text and visual cards are independent presentation layers. Keep
  // backend helpers unchanged so runtime callers retain their raw contract.
  //
  // The same seam turns a herdr resolution REFUSAL into an error result: the
  // guard's refusal (a test harness handing over a possible live binary, or a
  // harness with no binary injected) says the resolution failed, not that the
  // tool crashed. Letting it escape would be an uncaught throw out of a tool
  // handler, so every refusal is answered with its own text and `isError`, and
  // every other exception is re-thrown untouched.
  const execute = tool.execute;
  let format = null;
  try {
    const candidate = libRequire("worktree-model-result.js").formatWorktreeModelResult;
    if (typeof candidate === "function") format = candidate;
  } catch {
    // An unavailable formatter leaves execution and diagnostics untouched.
  }
  if (typeof execute === "function") {
    tool.execute = async function (...args) {
      let result;
      try {
        result = await execute.apply(this, args);
      } catch (err) {
        if (!isHerdrRefusal(err)) throw err;
        result = errorResult(`${tool.name}: ${err.message}`, { tool: tool.name, herdrRefused: true });
      }
      if (!format) return result;
      try {
        return format(tool.name, result);
      } catch {
        // A presentation failure must not hide a completed tool's result.
        return result;
      }
    };
  }
  return tool;
}

// The one sentence every `changes` refusal uses for the accepted forms, so the
// create cannot drift into describing three different contracts.
const CHANGES_FORMS = 'pass \"all\" to copy every pending change, \"none\" to create the worktree from the '
  + 'commit with nothing copied, or an explicit list of checkout-relative file paths';

// S2: the base of a NEW branch — LOCAL `main`, or nothing.
//
// The create used to seed a new branch from whatever `HEAD` the invoking
// checkout had checked out, so a session running inside a linked worktree put
// its own unmerged commits into a branch described as a fresh worktree. The
// base is now the commit `refs/heads/main` points at, read with one fixed argv
// on the async runner (never a shell string, never a blocking child).
//
// There is NO fallback: a repository without a local `main` (a plain
// `git init` lands on `master`, a project may use another trunk, a bare clone
// has no local branches) refuses the create before anything is written, and the
// refusal names the missing base. The resolved base rides back as
// `{source: 'main', ref: 'main', commit}` so the answer states what it used;
// null means "no local main" and every caller treats it as a refusal.
async function resolveCreateBase(runGit, repo) {
  try {
    const out = await runGit("git", ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"], { cwd: repo.root });
    if (out && out.status === 0) {
      const commit = String(out.stdout || "").trim();
      if (commit.length > 0) return { source: "main", ref: "main", commit };
    }
  } catch {
    // An unreadable ref means no base; the caller refuses in plain words.
  }
  return null;
}

// The INTERACTIVE create (the warp panel) returns to the selector as soon as
// the checkout path exists: the SLOW half of the creation hooks — dependency
// install, `codegraph init` — is what made a confirmed create feel like a hang,
// because a package manager can run for minutes. `backgroundHooks` hands that
// half to this managed background task instead of awaiting it, so the path the
// warp needs is usable immediately and the setup finishes behind it.
//
// Nothing is skipped and nothing is orphaned:
//   - the hooks library still runs both phases (through the `setup()` callable
//     it returns), so the checkout is set up exactly as before;
//   - every task is tracked here until it settles, and
//     `awaitPendingCreationSetups` is the seam a test (or a shutdown path) uses
//     to wait for the last one;
//   - each task settles into exactly ONE report, so a failure reaches the human
//     instead of vanishing into a detached promise, and the task itself never
//     rejects (nothing is left unobserved).
const creationSetups = new Set();

// Fold a child's stderr into one escape-free line, the same shape every
// summary row uses, so a multi-line failure cannot break the notification.
function setupReportLine(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The one report a settled setup produces: what ran on success, and the reasons
// on failure — plus the fact that the checkout stays usable either way.
//
// A run in which NO step completed reports NOTHING. Every step can be skipped
// (no lockfile detected, `codegraph` not on PATH), and a "setup finished" toast
// there announces work that never happened — the no-op success the interactive
// create used to show on every such checkout. Failures are never suppressed by
// that rule: a failed step, a failed outcome or any warning is reported first
// and returns, so silence can only ever mean "nothing ran, nothing failed".
function reportCreationSetup({ branch, target, outcome, notify }) {
  if (typeof notify !== 'function') return;
  const steps = outcome && Array.isArray(outcome.steps) ? outcome.steps : [];
  const failed = steps.filter((step) => step && step.status === 'failed');
  const done = steps.filter((step) => step && step.status === 'done');
  const uninformedFailure = !!(outcome && outcome.ok === false);
  const label = (step) => {
    const name = String(step.name || 'setup');
    if (name === 'codegraph-init') return 'codegraph initialized';
    return setupReportLine(name.replace(/^install:/, 'install '));
  };
  const warnings = outcome && Array.isArray(outcome.warnings) ? outcome.warnings : [];
  if (failed.length > 0 || uninformedFailure || warnings.length > 0) {
    const reasons = warnings.length > 0 ? warnings : failed.map((step) => `${step.name} failed`);
    const reasonText = reasons.map(setupReportLine).filter((line) => line.length > 0).join('; ');
    notify(
      `warp: setup for ${branch} finished with problems: ${reasonText.length > 0 ? reasonText : 'the setup reported a failure'} — the checkout at ${target} is usable`,
      'error',
    );
    return;
  }
  if (done.length === 0) return;
  notify(`warp: setup finished for ${branch}: ${done.map(label).join(', ')}`, 'info');
}

// Start (and track) the deferred setup. The returned task never rejects: a
// throwing phase is reported as a failed setup, never as an unhandled rejection.
function startCreationSetup({ run, branch, target, notify }) {
  const task = (async () => {
    let outcome;
    try {
      outcome = await run();
    } catch (err) {
      const message = `creation setup failed: ${(err && err.message) || err}`;
      outcome = { ok: false, steps: [{ name: 'setup', status: 'failed', detail: message }], warnings: [message] };
    }
    try {
      reportCreationSetup({ branch, target, outcome, notify });
    } catch {
      // Reporting is the last step of a settled task: a hostile notify never
      // leaves the task unobserved or the tracking set dirty.
    }
  })();
  creationSetups.add(task);
  const forget = () => { creationSetups.delete(task); };
  task.then(forget, forget);
  return task;
}

// Resolves once every tracked setup has settled. Exported for tests and for a
// shutdown path that must not leave a child running behind it.
async function awaitPendingCreationSetups() {
  while (creationSetups.size > 0) {
    await Promise.all(Array.from(creationSetups));
  }
}

// Core of `worktree_create`: validation (S2, S3) then herdr-first creation
// with a git fallback. Exported for unit tests; the registered tool calls
// it with the live Pi context. It only ever CREATES: the branch plus the
// `changes` selection (S3/S4), and no issue or ODD association is verified,
// written or displayed.
async function executeWorktreeCreate(params, ctx, opts) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  // S53 git-only route (create-from-warp): the wizard creates a plain
  // git checkout plus the registry row and nothing else — never a Herdr
  // workspace (`herdr worktree create/open` is what materialized the
  // stray Herdr worktree the user never asked for). The route reuses
  // every validation and the registry machinery below; only the
  // backends change. Subprocesses run through the async runner here so
  // a hanging child aborts on its bound instead of freezing the
  // interactive session on the main thread.
  const gitOnly = !!(opts && opts.gitOnly === true);
  // `backgroundHooks` is the INTERACTIVE create's speed contract: the checkout
  // plus its registry row are all the warp needs, so the slow half of the hooks
  // (install, codegraph) is handed to a tracked background task instead of
  // being awaited. The AGENT tool never sets it — its result is the agent's only
  // report, so the hooks must have settled before that result is returned.
  const backgroundHooks = !!(opts && opts.backgroundHooks === true);
  // S21: BOTH routes are interactive (the tool handler and the create
  // panel), so both wait for their children on the async runner. The
  // security property is unchanged: fixed argv arrays, values as separate
  // elements, never a shell string.
  const runAsync = libRunner(git);
  const runGit = (bin, argv, runOpts) => git.runArgvAsync(bin, argv, runOpts);

  const branch = params ? params.branch : undefined;
  const cwd = toolCwd(ctx);

  // (b) Branch validation, refusing with the returned reason. The
  // authority is still `git check-ref-format --branch`, awaited.
  const validated = await git.validateBranchAsync(branch, { runAsync });
  if (!validated.ok) {
    return errorResult(
      `invalid branch name ${JSON.stringify(branch)}: ${validated.reason}`,
      { branch },
    );
  }

  // (b2) S3/S4: the `changes` selection — "all", "none" or an explicit file
  // list — and it is MANDATORY. The declared parameter is required, so the host
  // refuses a call that omits it before `execute` runs; this check is the same
  // refusal for every caller that reaches the core directly (the wizard, an
  // internal path, a test), and it runs before any child that can WRITE — the
  // only child before it is the read-only branch-name probe above — so no
  // branch, checkout, registry row or partial copy can exist when the caller
  // never stated what to copy. `null` is how a JSON tool call spells "not
  // provided", so it is refused as an omission too.
  //
  // The value is then normalized by the shared helper: an unusable value fails
  // closed here, for the same reason and with the same three named forms.
  const changesLib = libRequire('worktree-changes.js');
  const rawChanges = params ? params.changes : undefined;
  if (rawChanges === undefined || rawChanges === null) {
    return errorResult(`invalid changes selection: 'changes' is required — ${CHANGES_FORMS} (nothing was created)`, { branch });
  }
  // An empty (or whitespace-only) STRING is a PRESENT but unusable value: the
  // create must name one of the three forms, so "no text" is refused exactly
  // like any other invalid value instead of being read as "copy nothing". (The
  // warp's OPTIONAL `changes` keeps its own, documented rule — omitted, "" or []
  // copy nothing — because it is a different contract and goes through the
  // shared helper untouched; an empty ARRAY stays a legal, if empty, list here.)
  if (typeof rawChanges === 'string' && rawChanges.trim() === '') {
    return errorResult(`invalid changes selection ${JSON.stringify(rawChanges)}: ${CHANGES_FORMS} (nothing was created)`, { branch });
  }
  // S4: the CREATE's own documented value set includes the word "none", while
  // the SHARED helper keeps its original contract (omitted/""/[] mean no copy and
  // the word "none" is not one of its values). The create therefore adapts
  // LOCALLY — "none" becomes the helper's no-copy spelling — instead of widening
  // a helper `worktree_warp` also uses, whose behavior and error text stay
  // exactly as they were.
  const createSelection = typeof rawChanges === 'string' && rawChanges.trim() === 'none' ? [] : rawChanges;
  let selection;
  try {
    selection = changesLib.normalizeChangesSelection(createSelection);
  } catch (err) {
    selection = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!selection || selection.ok !== true) {
    let shown = 'an unusable value';
    try {
      shown = JSON.stringify(rawChanges);
    } catch {
      // A value that cannot even be printed is still refused, never echoed.
    }
    return errorResult(
      `invalid changes selection ${shown}: ${CHANGES_FORMS} (${(selection && selection.error) || 'unusable value'}; nothing was created)`,
      { branch },
    );
  }

  // Thread identity resolves before any mutation so a second checkout for
  // the same thread is never created. Without an identity the call fails
  // closed: it must never adopt another thread's checkout.
  const identity = resolveThread(ctx);
  if (!identity.thread) {
    return errorResult(
      "cannot resolve thread identity: set GENTLE_WORKTREE_THREAD or run inside a Pi session",
      { branch },
    );
  }
  const thread = identity.thread;

  // (c) No association validation happens here: a create takes the branch and
  // nothing else. An `issues`/`odd` field a caller still sends is ignored — it
  // is never verified, never refused and never stored (S1/S6).

  // (d) Repository identity and target path.
  let repo;
  try {
    repo = await git.repoIdentityAsync(cwd, { runAsync });
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { branch });
  }
  // (d0) S3/S4: WHICH pending changes travel. The invoking checkout's pending
  // set is read and the selection matched against it BEFORE the create, so an
  // unknown file refuses with nothing created — never a half-made worktree
  // followed by a failed copy.
  let pendingCopy = null;
  if (selection.mode !== 'none') {
    let source;
    try {
      source = await changesLib.summarizeChanges(cwd, { git });
    } catch (err) {
      source = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!source || source.ok !== true) {
      return errorResult(
        `cannot read the pending changes of ${cwd}: ${(source && source.error) || 'unknown error'} (nothing was created)`,
        { branch },
      );
    }
    const matched = changesLib.matchSelection(source, selection.mode, selection.paths);
    if (!matched || matched.ok !== true) {
      return errorResult(`${(matched && matched.error) || 'invalid changes selection'} (nothing was created)`, { branch });
    }
    // A clean checkout selects nothing: the create is the ordinary one and no
    // copy step runs at all.
    if (matched.entries.length > 0) pendingCopy = { mode: selection.mode, paths: selection.paths };
  }
  // The layouts are pure functions of the identity just read, so the create
  // never spawns git a second time for a path it already knows.
  const target = opts && opts.principalLayout && typeof git.canonicalWorktreePathOf === "function"
    ? git.canonicalWorktreePathOf(repo, branch)
    : typeof git.worktreePathOf === "function"
      ? git.worktreePathOf(repo, branch)
      : git.worktreePath(repo.root, branch);
  const resolvedTarget = path.resolve(target);

  let listed;
  try {
    listed = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { branch },
    );
  }

  // (e) Request idempotency (S9/L31): a session may own SEVERAL worktrees, so
  // the replay case is the SAME request — this thread already registered a row
  // for THIS branch — and only then is its checkout handed back instead of a
  // second one. Another branch is a new checkout with its own row, and a live
  // checkout already sitting on this request's target path is the
  // one-owner-per-path refusal below, never an adoption.
  // This runs BEFORE the (d) refusals on purpose: the thread's own checkout is
  // by definition checked out at its target, so checking (d) first would make
  // this return unreachable.
  const threadRows = (() => {
    try {
      const read = registry.readRegistry(repo.root);
      return read && read.ok === true && Array.isArray(read.worktrees) ? read.worktrees : [];
    } catch {
      return [];
    }
  })();
  // Liveness is the consolidated checkoutState: a row is live only when
  // something exists at its path AND it is a directory AND its resolved
  // realpath matches a live checkout's realpath, so a row that reaches a live
  // checkout through a SYMLINK is live and is never dropped as stale while a
  // hand-deleted checkout git still records is stale (its state has nothing
  // existing, so it can never match). A relative row path can never match.
  const ownedStateOf = (row) => ((row && typeof row.path === "string" && path.isAbsolute(row.path))
    ? checkoutState(row.path, repo.root)
    : { absolute: null, real: null, exists: false, isDirectory: false });
  const ownsLiveCheckout = (row) => {
    const st = ownedStateOf(row);
    return st.real !== null && st.exists && st.isDirectory && liveIdentities(listed, repo.root).has(st.real);
  };
  // Every row is examined, so a duplicate-branch row of another thread ahead of
  // this thread's own can never hide it.
  const owned = threadRows.find((row) => row && row.branch === branch && row.thread === thread) || null;
  if (owned && ownsLiveCheckout(owned)) {
    // Already-exists truth (S1/S6/S7): the requested branch already has this
    // session's checkout, so the call creates nothing, writes nothing and runs
    // no hook — and it says so instead of claiming a create or an update. The
    // registry row already exists (`registered: unchanged`), and the CodeGraph
    // row reports the index the checkout really has, read without initializing
    // anything.
    const codegraph = codegraphIndexState(owned.path);
    return textResult(
      `${createSuccessText(owned.branch, owned.path, true)}\nregistered: unchanged\n${codegraphLine(codegraph)}`,
      { path: owned.path, branch: owned.branch, alreadyExists: true, registered: 'unchanged', codegraph },
      false,
    );
  }
  // Stale entries of THIS session (any branch): dead checkouts its own rows
  // point at. They are remembered, never dropped here — the drop happens after
  // the new checkout verifies, so a refusal or a failed creation below still
  // leaves every row intact with a way back. S9 widened this from the single
  // owned row to all of the session's dead rows, because a create is no longer
  // the session's first checkout: its own ghost rows are cleaned with it, while
  // rows of other sessions are never touched.
  const staleOwned = threadRows.filter((row) => row
    && row.thread === thread
    && !ownsLiveCheckout(row));

  // (d1) S2: a NEW branch is born from LOCAL main, and from nothing else. Both
  // halves are decided here, before any child that could mutate anything (the
  // stale-record prune included):
  //   - adopting an EXISTING branch needs no base at all — it is checked out
  //     as-is — so the requirement below never touches adoption;
  //   - creating a branch requires a local `main` to start from. A repository
  //     without one is refused in plain words with nothing written, instead of
  //     quietly seeding the branch from whatever the invoking checkout has
  //     checked out (the old behavior, which put a linked worktree's unmerged
  //     commits into a "fresh" worktree).
  let branchExists = false;
  try {
    const ref = await runGit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root });
    branchExists = ref.status === 0;
  } catch {
    branchExists = false;
  }
  const baseInfo = branchExists ? null : await resolveCreateBase(runGit, repo);
  if (!branchExists && baseInfo === null) {
    return errorResult(
      `cannot create worktree for branch '${branch}': this repository has no local 'main' branch, and a new `
      + `worktree is always born from local main — create it (git branch main <commit>) and retry; `
      + `nothing was created`,
      { branch },
    );
  }

  // (d) Refusals: the branch already checked out at a LIVE path, the
  // target already a LIVE worktree, or the target inside any checkout /
  // the git common dir. Every record is judged through the one predicate
  // (exists AND is-a-directory): a git record whose path is not a live
  // checkout never blocks a create on its own. When such stale records are
  // the ONLY thing holding the branch or the target path, the tool
  // recovers with a scoped `git worktree prune` (which drops only records
  // whose directories are missing) and proceeds to create; a branch
  // genuinely checked out at a LIVE path is refused exactly as before,
  // with the registry row left intact either way.
  const branchRecords = listed.filter((entry) => entry.branch === branch);
  const liveBranchRecords = branchRecords.filter((entry) => isLiveGitRecord(entry, repo.root));
  const targetRecords = listed.filter((entry) => {
    const st = checkoutState(entry.path, repo.root);
    return st.absolute !== null && st.absolute === resolvedTarget;
  });
  const liveTargetRecords = targetRecords.filter((entry) => isLiveGitRecord(entry, repo.root));
  // Stale records recovered below; reported in details.pruned and in the
  // create warnings so the caller can name what `git worktree prune` took.
  let prunedStale = [];
  if (liveBranchRecords.length === 0 && liveTargetRecords.length === 0
    && (branchRecords.length > 0 || targetRecords.length > 0)) {
    const stalePaths = [];
    for (const entry of [...branchRecords, ...targetRecords]) {
      const st = checkoutState(entry.path, repo.root);
      if (st.absolute !== null && !stalePaths.includes(st.absolute)) stalePaths.push(st.absolute);
    }
    const pruned = await runGit("git", ["worktree", "prune"], { cwd: repo.root });
    if (pruned.status !== 0) {
      const reason = ((pruned.stderr || pruned.error || "unknown error") + "").trim();
      return errorResult(
        `cannot create worktree for branch '${branch}': the branch or target path is recorded at ${stalePaths.join(", ")} but no live checkout exists there, and 'git worktree prune' failed (${reason}); run 'git worktree prune' by hand and retry; the registry was left untouched`,
        { branch, path: target, pruned: [], pruneError: reason },
      );
    }
    let relisted;
    try {
      relisted = await git.listWorktreesAsync(repo.root, { runAsync });
    } catch (err) {
      return errorResult(
        `cannot create worktree for branch '${branch}': the branch or target path is recorded at ${stalePaths.join(", ")} but no live checkout exists there, and the worktree list could not be re-read after pruning (${(err && err.message) || err}); the registry was left untouched`,
        { branch, path: target, pruned: [], pruneError: (err && err.message) || String(err) },
      );
    }
    const stillLiveBranch = relisted.filter((entry) => entry.branch === branch && isLiveGitRecord(entry, repo.root));
    const stillLiveTarget = relisted.filter((entry) => {
      const st = checkoutState(entry.path, repo.root);
      return st.absolute !== null && st.absolute === resolvedTarget && isLiveGitRecord(entry, repo.root);
    });
    if (stillLiveBranch.length > 0) {
      return errorResult(
        `branch '${branch}' is already checked out at ${stillLiveBranch[0].path}: pick another branch or close that worktree first`,
        { branch, path: stillLiveBranch[0].path, pruned: [] },
      );
    }
    if (stillLiveTarget.length > 0) {
      return errorResult(
        `target path ${target} is already a live worktree (branch '${stillLiveTarget[0].branch}'): pick another branch`,
        { branch, path: target, pruned: [] },
      );
    }
    const relistedAbs = new Set();
    for (const entry of relisted) {
      const st = checkoutState(entry.path, repo.root);
      if (st.absolute !== null) relistedAbs.add(st.absolute);
    }
    prunedStale = stalePaths.filter((absolute) => !relistedAbs.has(absolute));
    listed = relisted;
  } else {
    if (liveBranchRecords.length > 0) {
      return errorResult(
        `branch '${branch}' is already checked out at ${liveBranchRecords[0].path}: pick another branch or close that worktree first`,
        { branch, path: liveBranchRecords[0].path },
      );
    }
    const liveAtTarget = liveTargetRecords[0];
    if (liveAtTarget) {
      return errorResult(
        `target path ${target} is already a live worktree (branch '${liveAtTarget.branch}'): pick another branch`,
        { branch, path: target },
      );
    }
  }
  if (await git.isPathInAnyCheckoutAsync(repo.root, target, { runAsync, identity: repo, listed })) {
    return errorResult(
      `target path ${target} is inside an existing checkout: pick another branch`,
      { branch, path: target, pruned: prunedStale },
    );
  }
  // (e2) Occupant (S22, widening I3): ANY pre-existing entry at the target
  // path — an empty or non-empty directory, a file, a FIFO, a symlink, a
  // dangling symlink — is refused before any backend runs, with an
  // actionable message naming what is there and what to do (remove it by
  // hand or pick another branch), never git's raw
  // `fatal: '<path>' already exists`. The empty directory is included
  // precisely because git would silently adopt it. No registry row is
  // written, so removing the occupant lets the next create at the same
  // path succeed. The single exception is the thread's own registered
  // checkout, already returned as `created: false` by the idempotency
  // contract above — everything reaching this point is someone else's
  // entry or no checkout at all.
  try {
    let occupantKind = null;
    try {
      const lst = fs.lstatSync(resolvedTarget);
      if (lst.isSymbolicLink()) {
        let stat = null;
        try {
          stat = fs.statSync(resolvedTarget);
        } catch {
          stat = null;
        }
        // Name the referent when it resolves: a symlink to a file or to
        // a directory says so; a dangling link (nothing resolves) stays
        // a plain symlink with no referent to name.
        if (!stat) occupantKind = "symlink";
        else if (stat.isDirectory()) occupantKind = "symlink to a directory";
        else if (stat.isFile()) occupantKind = "symlink to a file";
        else occupantKind = "symlink";
      } else if (lst.isFile()) {
        occupantKind = "file";
      } else if (lst.isFIFO()) {
        occupantKind = "FIFO";
      } else if (lst.isDirectory()) {
        let empty = false;
        try {
          empty = fs.readdirSync(resolvedTarget).length === 0;
        } catch {
          empty = false;
        }
        occupantKind = empty ? "empty directory" : "non-empty directory";
      } else if (lst.isSocket()) {
        occupantKind = "socket";
      } else {
        occupantKind = "non-directory";
      }
    } catch {
      occupantKind = null;
    }
    if (occupantKind !== null) {
      // "a empty directory" reads wrong; the article follows the kind.
      const article = /^[aeiou]/i.test(occupantKind) ? "an" : "a";
      return errorResult(
        `target path ${target} is occupied by ${article} ${occupantKind}: remove it by hand or pick another branch; the registry was left untouched`,
        { branch, path: target, pruned: prunedStale },
      );
    }
  } catch {
    // A failed probe never blocks: the backends report their own error.
  }

  // No approval dialog: a create touches no existing data — the checkout and
  // its registry row are both new — and the panel's create path never asked
  // either. The confirmation that matters lives in `worktree_close`.

  // (g) Create. S20 branch adoption is resolved BEFORE creating: when
  // `refs/heads/<branch>` already exists (and is not checked out at a
  // live checkout — already refused above), the worktree checks out that
  // EXISTING branch with `git worktree add <target> <branch>` — no `-b`,
  // no base, the ref never created, rewritten or deleted — and the result
  // reports `branchCreated: false` plus a warning naming the adopted
  // branch. Herdr's `worktree create` cannot adopt an existing branch, so
  // the adopt case goes through git and then associates the Herdr
  // workspace BEST-EFFORT via `herdr worktree open --path <path>
  // --cwd <root>`; the checkout succeeding never depends on herdr.
  // When the ref does not exist, creation keeps the herdr-first path
  // with a `git worktree add -b` fallback and reports `branchCreated:
  // true`. Fixed argv only, values as separate elements (herdr rejects
  // --flag=value). Never --focus, never --trust-repository: trusting a
  // repository is a human decision these tools never take. The base is
  // LOCAL MAIN (S2), resolved in (d1) before anything was written: a session
  // working inside a linked worktree can never seed the new branch with its
  // own unmerged commits, and a repository without a local `main` was already
  // refused there instead of falling back to the invoking HEAD.
  const base = baseInfo !== null ? baseInfo.commit : null;
  let createdBy = null;
  let createError = null;
  let branchCreated = null;
  let herdrAssociated = null;
  const adoptWarnings = [];
  if (branchExists) {
    // Adopt: check out the existing branch at the fresh path. No `-b`
    // (the ref already exists), no base (checking out the branch IS the
    // base) — the ref is never created, rewritten or deleted.
    const adopted = await runGit("git", ["worktree", "add", target, branch], { cwd: repo.root, timeoutMs: 120000 });
    if (adopted.status === 0) {
      createdBy = "git";
      branchCreated = false;
      adoptWarnings.push(
        `adopted existing branch '${branch}' at ${target}: the worktree checks out that branch as-is, the branch ref was left untouched`,
      );
      // Best-effort Herdr workspace association: reported, never fatal.
      // Skipped on the git-only route: that checkout is git plus the
      // registry row by design, so no association is expected.
      if (!gitOnly) {
      try {
        const opened = await runGit(herdrBinary(), git.herdrArgv("open", { cwd: repo.root, path: target }), {
          cwd: repo.root,
          timeoutMs: 60000,
        });
        herdrAssociated = opened.status === 0;
      } catch (err) {
        herdrAssociated = false;
      }
      if (herdrAssociated !== true) {
        adoptWarnings.push(
          `herdr workspace association failed for ${target} ('herdr worktree open' did not succeed): the checkout itself is fine, associate it by hand when needed`,
        );
      }
      }
    } else {
      createError = ((adopted.stderr || adopted.error || "unknown error") + "").trim();
    }
  } else {
  // The git-only route skips the herdr-first attempt outright: no
  // `herdr worktree create` runs, so no Herdr workspace is ever
  // materialized from the wizard. The tool path keeps herdr-first
  // with the git fallback below, byte-identical.
  let herdrRes = null;
  if (!gitOnly) {
  const createParams = { cwd: repo.root, branch, path: target };
  if (base) createParams.base = base;
  herdrRes = await runGit(herdrBinary(), git.herdrArgv("create", createParams), {
    cwd: repo.root,
    timeoutMs: 120000,
  });
  }
  if (herdrRes !== null && herdrRes.status === 0) {
    createdBy = "herdr";
    branchCreated = true;
  } else {
    const fallbackArgv = ["worktree", "add", "-b", branch, target];
    if (base) fallbackArgv.push(base);
    const fallback = await runGit("git", fallbackArgv, { cwd: repo.root, timeoutMs: 120000 });
    if (fallback.status === 0) {
      createdBy = "git";
      branchCreated = true;
    } else {
      // Same-branch recovery (H1): the branch ref appeared between the
      // pre-creation resolution above and the fallback (or survives a
      // hand-deleted checkout), so `-b` fails with "already exists".
      // Checking out the existing branch at the fresh path is the
      // recovery — the same adoption semantics, reported the same way;
      // anything else keeps the backend's own error.
      const ref = await runGit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root });
      if (ref.status === 0) {
        const retry = await runGit("git", ["worktree", "add", target, branch], { cwd: repo.root, timeoutMs: 120000 });
        if (retry.status === 0) {
          createdBy = "git";
          branchCreated = false;
          adoptWarnings.push(
            `adopted existing branch '${branch}' at ${target}: the worktree checks out that branch as-is, the branch ref was left untouched`,
          );
        } else {
          createError = ((retry.stderr || retry.error || "unknown error") + "").trim();
        }
      } else {
        createError = ((fallback.stderr || fallback.error || "unknown error") + "").trim();
      }
    }
  }
  }
  if (!createdBy) {
    return errorResult(
      `failed to create worktree for branch '${branch}': ${createError || "herdr and git both failed"}`,
      { branch, path: target, pruned: prunedStale },
    );
  }

  // (h) Verify against git before claiming success: the new checkout must
  // be present at the target path.
  let after;
  try {
    after = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(
      `worktree creation could not be verified at ${target}: ${(err && err.message) || err}`,
      { branch, path: target, createdBy, pruned: prunedStale },
    );
  }
  if (!after.some((entry) => {
    const st = checkoutState(entry.path, repo.root);
    return st.absolute !== null && st.absolute === resolvedTarget;
  })) {
    return errorResult(
      `worktree creation could not be verified at ${target}`,
      { branch, path: target, createdBy, pruned: prunedStale },
    );
  }

  // The stale owned row (if any) is dropped only now that the replacement
  // checkout is verified: every failure above returns with the row intact.
  // Drop by row identity — the (branch, path) pair of the entry this
  // thread owned — never by branch alone and never by a path-key lookup
  // that can match a different row, so a live entry sharing the branch
  // survives whether the stale path is absolute or relative.
  for (const staleRow of staleOwned) {
    try {
      if (typeof registry.removeWorktreeExact === "function") registry.removeWorktreeExact(repo.root, staleRow.branch, staleRow.path);
      else if (typeof staleRow.path === "string" && path.isAbsolute(staleRow.path)) registry.removeWorktreeByPath(repo.root, path.resolve(staleRow.path));
      else registry.removeWorktree(repo.root, staleRow.branch);
    } catch {
      // The upsert below still records the new checkout.
    }
  }

  // I1 one-owner-per-path: when a create lands on its target path, that
  // path ends with exactly ONE registry row — the one just created. Any
  // other row whose path resolves to the same path (whatever its branch or
  // thread, absolute spelling, trailing-slash spelling, or a symlink to the
  // target) is stale by definition and is dropped as part of the create.
  // Never drops a row for a different path; relative rows never match.
  let replacedRows = [];
  try {
    const reread = registry.readRegistry(repo.root);
    const rows = reread && reread.ok === true && Array.isArray(reread.worktrees) ? reread.worktrees : [];
    const targetState = checkoutState(target, repo.root);
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      // Skip a stale-owned row already dropped above (same identity).
      if (staleOwned.some((staleRow) => staleRow.branch === row.branch && staleRow.path === row.path)) continue;
      let same = false;
      try {
        const rowState = checkoutState(row.path, repo.root);
        if (rowState.absolute !== null && targetState.absolute !== null && rowState.absolute === targetState.absolute) same = true;
        else if (rowState.real !== null && targetState.real !== null && rowState.real === targetState.real) same = true;
      } catch {
        same = false;
      }
      if (same) replacedRows.push(row);
    }
    for (const row of replacedRows) {
      try {
        if (typeof registry.removeWorktreeExact === "function") registry.removeWorktreeExact(repo.root, row.branch, row.path);
        else registry.removeWorktree(repo.root, row.branch);
      } catch {
        // Best effort: the upsert below still records the new checkout.
      }
    }
  } catch {
    replacedRows = [];
  }

  // (i) Registry: upsert the entry owned by this thread. A hand-written
  // row that carries this branch but points at a DIFFERENT live checkout
  // is never replaced: that checkout keeps its registration, the new
  // checkout is recorded alongside it, and the conflict is reported as a
  // warning naming the kept checkout. Liveness is the consolidated
  // checkoutState (exists AND is a directory AND realpath equality, never
  // the process cwd), so a row that reaches a live checkout through a
  // symlink is live while a row whose path git still lists but which no
  // longer exists is never a live conflict. EVERY
  // same-branch row is examined, so a live row is warned about regardless
  // of whether a dead row comes first. Only an absolute row path can name
  // a live checkout (never resolved against the process cwd).
  let stored;
  const conflictWarnings = [];
  // S7: what the registry write below ACTUALLY did, reported as its own row.
  // `new` = the branch had no row, `replaced` = an existing row for this
  // branch was overwritten, `appended` = a live checkout at another path kept
  // the branch so the new row was recorded alongside it. It is a statement
  // about the registry, never a created/updated outcome of the tool.
  let registeredOutcome = null;
  try {
    const afterIds = liveIdentities(after, repo.root);
    const targetReal = checkoutState(target, repo.root).real;
    let conflictLive = null;
    // The row this upsert would replace: its legacy association fields are
    // kept, never invented and never discarded (S1: the create writes no
    // association).
    let legacyRow = null;
    try {
      const reread = registry.readRegistry(repo.root);
      const rows = reread && reread.ok === true && Array.isArray(reread.worktrees)
        ? reread.worktrees
        : [];
      for (const row of rows) {
        if (!row || row.branch !== branch) continue;
        if (legacyRow === null) legacyRow = row;
        if (typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
        const rowState = checkoutState(row.path, repo.root);
        if (!rowState.exists || !rowState.isDirectory) continue;
        if (rowState.real === null || !afterIds.has(rowState.real)) continue;
        if (targetReal !== null && rowState.real === targetReal) continue;
        conflictLive = row;
        break;
      }
    } catch {
      conflictLive = null;
    }
    // `issues` is a required registry field, so it is always supplied: a
    // replaced row keeps what it already stored, a brand-new row records an
    // empty list. `odd` is omitted on purpose — the registry keeps a replaced
    // row's stored document and gives a new row none.
    const legacyIssues = legacyRow && Array.isArray(legacyRow.issues) ? legacyRow.issues.slice() : [];
    if (conflictLive) {
      // A row for another live checkout is never copied from: the new row
      // records no association of its own.
      stored = registry.appendWorktree(repo.root, { branch, path: target, thread, issues: [] });
      registeredOutcome = 'appended';
      if (stored.ok) {
        conflictWarnings.push(
          `kept the existing registration for branch '${branch}' at ${conflictLive.path}: a live checkout is recorded there, so the new checkout at ${target} was registered alongside it`,
        );
      }
    } else {
      stored = registry.upsertWorktree(repo.root, { branch, path: target, thread, issues: legacyIssues });
      registeredOutcome = legacyRow === null ? 'new' : 'replaced';
    }
  } catch (err) {
    stored = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!stored.ok) {
    return errorResult(
      `worktree created at ${target} but the registry write failed: ${stored.error}`,
      { branch, path: target, createdBy },
    );
  }

  // (i2) Creation hooks (S8 as narrowed by S21, P2-S3, round-3 S3/L4): copy
  // unversioned files, install by detected stack, codegraph init when
  // available, and link the principal's git-ignored agent/ODD entries
  // (`.agents`, `.pi`, `.claude`, `odd`) — ONCE, inside the hooks themselves,
  // identically for the sync and async runners, never over an existing path.
  // The create therefore adds no link step of its own. Hooks never turn a
  // successful creation into an error: every outcome, including a thrown
  // hook, is reported inside `details.hooks`, and the exact success text
  // stays unchanged. A failed step stays visible via steps + warnings.
  let hooks = { ok: true, steps: [], warnings: [] };
  // The deferred half of the hooks, when the caller asked for it: it is started
  // AFTER the pending-change copy, never before (see (i4)).
  let deferredSetup = null;
  try {
    const hooksLib = libRequire("worktree-hooks.js");
    // The principal checkout owns the shared sources. repo.root is the
    // toplevel of the caller (which may itself be a linked worktree), so
    // the principal is recovered from the shared common dir: for a normal
    // repository <principal>/.git is the common dir.
    const principalRoot = path.basename(repo.commonDir) === ".git"
      ? path.dirname(repo.commonDir)
      : repo.root;
    if (typeof hooksLib.runCreationHooksAsync === 'function') {
      // S21: EVERY create runs the async twin now — the tool handler is as
      // interactive as the wizard. It owns every child until settle
      // (timeout/abort SIGTERMs, waits a bounded grace for close, then
      // SIGKILLs and reaps — POSIX group-wide) while the event loop stays
      // responsive, and awaiting it here preserves ready-before-warp ordering
      // (hooks settle before the warp) without blocking Pi input/render. Both
      // routes take this branch, so the sync runner is never reached; the
      // fallback below only survives for a lib build that predates the twin.
      const runHooksAsync = (bin, argv, runOpts) => git.runArgvAsync(bin, argv, {
        ...runOpts,
        // Abort reaches the effective runner only when the caller supplies
        // a signal (the wizard currently passes none, so none is claimed).
        ...(opts && opts.signal ? { signal: opts.signal } : {}),
      });
      hooks = await hooksLib.runCreationHooksAsync({
        principalRoot,
        worktreePath: target,
        root: repo.root,
        env: process.env,
        runAsync: runHooksAsync,
        ...(opts && opts.signal ? { signal: opts.signal } : {}),
        ...(opts && Number.isFinite(opts.killGraceMs) && opts.killGraceMs > 0 ? { killGraceMs: opts.killGraceMs } : {}),
        ...(backgroundHooks ? { deferSetup: true } : {}),
      });
      // The deferred phases travel as a callable, never as a step list: the
      // steps the create REPORTS are the ones that really ran plus one honest
      // `pending` row per deferred phase.
      if (hooks && typeof hooks.setup === 'function') {
        deferredSetup = hooks.setup;
        const { setup: _deferred, ...summary } = hooks;
        hooks = summary;
      }
    } else {
      hooks = hooksLib.runCreationHooks({
        principalRoot,
        worktreePath: target,
        root: repo.root,
        env: process.env,
      });
    }
  } catch (err) {
    const message = `creation hooks failed: ${(err && err.message) || err}`;
    hooks = {
      ok: false,
      steps: [{ name: "hooks", status: "failed", detail: message }],
      warnings: [message],
    };
  }

  // (i3) S3/S4: carry the selected pending changes — now that the checkout
  // exists, is verified, is registered and its hooks have run, so the copy can
  // never be applied to a half-made worktree. The transfer is the shared
  // lib/worktree-changes.js one (source and destination indices preserved, a
  // destination overlap rejects, a dry-run precedes any write), and every
  // child runs on the async runner, so an interactive create stays responsive
  // while it copies. A failed copy is REPORTED, never hidden: the worktree is
  // already there, so the result names it AND the copy failure instead of
  // pretending the whole call failed or claiming a copy that did not happen.
  let copiedInfo = null;
  let copyError = null;
  if (pendingCopy !== null) {
    let outcome;
    try {
      outcome = await changesLib.copyChanges(
        { from: cwd, to: target, selectMode: pendingCopy.mode, selection: pendingCopy.paths },
        { git },
      );
    } catch (err) {
      outcome = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!outcome || outcome.ok !== true) {
      copyError = (outcome && outcome.error) || 'cannot copy the pending changes';
    } else {
      copiedInfo = {
        files: outcome.files,
        added: outcome.added,
        deleted: outcome.deleted,
        paths: Array.isArray(outcome.copied) ? outcome.copied.slice() : [],
      };
    }
  }

  // (i4) The deferred half of the hooks (install, codegraph) starts HERE —
  // after the copy, never before it. A `codegraph init` writing into the
  // destination while the copy preflights it would read as a destination
  // overlap and turn a good copy into a reported failure, so the copy is the
  // last awaited step and the setup runs behind it. The create returns as soon
  // as the copy settles (or fails, and says so): the setup's own outcome is
  // reported by `reportCreationSetup`, never swallowed and never awaited here.
  let setupPending = false;
  if (deferredSetup !== null) {
    setupPending = true;
    startCreationSetup({
      run: deferredSetup,
      branch,
      target,
      notify: (opts && typeof opts.notify === 'function')
        ? opts.notify
        : (ctx && ctx.ui && typeof ctx.ui.notify === 'function' ? (message, level) => ctx.ui.notify(message, level) : null),
    });
  }

  // (j) Terse success text (S9), whichever backend performed the creation.
  // Hook steps and warnings travel inside details; a failed step is
  // visible there and never becomes an error result. When the write
  // replaced a malformed registry, the sibling backup path travels along
  // so the caller can name it. When no backup could be written the
  // failure travels as registryBackupError (best-effort, never fatal).
  const backupDetails = {};
  if (stored.backup) backupDetails.registryBackup = stored.backup;
  if (stored.backupError) backupDetails.registryBackupError = stored.backupError;
  const pruneWarnings = prunedStale.length > 0
    ? [`pruned ${prunedStale.length} stale worktree record(s) via 'git worktree prune': ${prunedStale.join(", ")}; git no longer records the missing checkout`]
    : [];
  const replacedWarnings = replacedRows.length > 0
    ? [`replaced ${replacedRows.length} stale registry row(s) at the same path ${target}: ${replacedRows.map((r) => `branch '${r.branch}' at ${r.path}`).join(", ")}; one path has one owner, so the row just created is the only registration`]
    : [];
  // S1: a create neither accepts nor records an association, so none can be
  // dropped here — an omitted association leaves the stored row exactly as it
  // is on disk (rows the write does not address are carried through byte for
  // byte). No ODD document therefore reaches the text, the warnings or the
  // details.
  const warnings = [...((hooks && hooks.warnings) || []), ...conflictWarnings, ...pruneWarnings, ...replacedWarnings, ...adoptWarnings];
  // S6: the ONE CodeGraph fact of this create, read from the hooks that just
  // ran (never re-run, never inferred).
  const codegraph = codegraphStatus(hooks);
  // S20 adoption reporting: whether the branch was created or adopted,
  // and (adopt case only) whether the best-effort Herdr workspace
  // association happened. The checkout succeeding never depends on herdr.
  const adoptionDetails = { branchCreated };
  if (herdrAssociated !== null) adoptionDetails.herdrAssociated = herdrAssociated;
  // (l) T41/S50 changes registration: register the checkout just
  // created on the CURRENT session through gentle-shell's
  // `session_worktree_register` host tool, but ONLY when that tool is
  // actually available (listed in ctx.tools and callable through
  // ctx.executeTool — the injectable seam). On success the output ends
  // with ONE short line so the agent does not repeat the call; when
  // the tool is unavailable, the call fails, or anything throws, do
  // nothing and append nothing — the create never fails because of this.
  let changesRegistered = false;
  try {
    const registerLib = libRequire("session-worktree-register.js");
    if (registerLib && typeof registerLib.registerSessionWorktree === "function") {
      changesRegistered = await registerLib.registerSessionWorktree(ctx, target) === true;
    }
  } catch {
    changesRegistered = false;
  }
  // S7: the registry-write fact sits right after the identity rows, before the
  // hook fact: it is the tool's own bookkeeping and must never be inferred.
  const successText = [createSuccessText(branch, target, false), `registered: ${registeredOutcome}`, codegraphLine(codegraph)].filter((line) => typeof line === "string" && line.length > 0);
  if (setupPending) successText.push("setup: running in the background (install, codegraph)");
  if (changesRegistered) successText.push("changes: already registered for this session");
  // S3/S4: what the copy actually did, in the same `N files, +A/-B` shape the
  // rest of the worktree surface uses. A clean selection adds no row.
  if (copiedInfo !== null) {
    successText.push(`copied: ${copiedInfo.files} file${copiedInfo.files === 1 ? '' : 's'}, +${copiedInfo.added}/-${copiedInfo.deleted}`);
  }
  // Every summarized warning follows the create rows exactly once, so a
  // dropped/adopted/pruned fact or a failed hook step stays visible to the
  // agent even when it never opens the card.
  for (const warning of warnings) {
    const row = warningRow(warning);
    if (row !== null) successText.push(row);
  }
  const successBody = successText.join("\n");
  const successDetails = {
    path: target,
    branch,
    registered: registeredOutcome,
    codegraph,
    hooks,
    warnings,
    pruned: prunedStale,
    replacedRows: replacedRows.map((r) => ({ branch: r.branch, path: r.path })),
    changesRegistered,
    ...(setupPending ? { setupPending: true } : {}),
    // S2: the base is reported only when one was used — an ADOPTED branch is
    // checked out as-is, so it has no base to name.
    ...(baseInfo !== null ? { base: baseInfo } : {}),
    ...adoptionDetails,
    ...backupDetails,
    ...(copiedInfo !== null ? { copied: copiedInfo } : {}),
  };
  if (copyError !== null) {
    // The checkout exists and is registered: the failure is the COPY, so the
    // result is an error that still names the worktree the caller now owns, and
    // the details carry the same facts plus the reason. Nothing here rolls the
    // creation back — a created checkout is never silently removed (S2).
    return errorResult(
      `${createSuccessText(branch, target, false)}\n`
      // "not in full" is the only claim the evidence supports: a copy that
      // failed partway leaves the files it landed in the destination (its own
      // error counts them), so the result may never say the copy did not happen.
      + `worktree created at ${target} but the pending changes were NOT copied in full: ${copyError}`,
      { ...successDetails, copyError },
      true,
    );
  }
  return textResult(
    successBody,
    successDetails,
    false,
  );
}

// S3/S4: the `changes` parameter the create requires — "all", "none", or an
// explicit list of checkout-relative file paths.
//
// It is NOT optional. The host validates a tool call against this declaration
// BEFORE `execute` runs, so a call that omits the field is refused there ("must
// have required property 'changes'") and the create never starts; a value that
// is none of the three forms is refused by the same validation and, for any
// caller that reaches the core directly, by the selection check inside it.
//
// The union is spelled with TypeBox's Union/Literal. A Type double without them
// (the plain-node loaders stub the package import) gets the widest shape it can
// build instead of throwing while the module loads, and the value is normalized
// again through lib/worktree-changes.js at the tool boundary — nothing is
// accepted here that the create does not understand.
const CHANGES_DESCRIPTION = "Pending changes of the current checkout to carry into the new worktree (required): "
  + "\"all\" copies every uncommitted change, \"none\" copies nothing so the worktree is born from the commit, "
  + "or a list of checkout-relative file paths copies exactly those. An unusable value, an unknown file "
  + "or a destination that already modifies a selected path refuses the whole create before anything is written.";

function changesParameterSchema(description) {
  try {
    if (typeof Type.Union === "function" && typeof Type.Literal === "function") {
      return Type.Union([Type.Literal("all"), Type.Literal("none"), Type.Array(Type.String())], { description });
    }
  } catch {
    // Fall through to the plain list declaration below.
  }
  return Type.Array(Type.String(), { description });
}

const worktreeCreateTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_create",
  label: "Worktree Create",
  exposure: "codemode",
  description: "Create an agent worktree for a branch at the flattened worktree path, born from local main (a repository without a local main is refused; an existing branch is adopted as-is). A session may own several checkouts: the requested branch is created and registered even when this thread already owns another one, and only the same branch already registered for this thread is reported back instead of created again. `changes` is required and selects which pending changes of the current checkout travel with the new worktree: \"all\", \"none\", or a list of file paths.",
  parameters: Type.Object({
    branch: Type.String({ description: "Branch name to create the worktree for" }),
    changes: changesParameterSchema(CHANGES_DESCRIPTION),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeCreate(params, ctx);
  },
}));

// `worktree_list` output contract (S6, S9, S19, S24) — terse, one line per
// checkout, pinned in tools/worktree-list.test.js. The FIRST column is the
// NAME (S24): the flattened branch slug, or `principal` for the principal
// checkout, so the printed identifier is exactly what `warp` accepts and
// what `close` can take. The absolute path is not dropped: it stays in
// `details.worktrees[].path` (plus `details.worktrees[].name`).
// A worktree carries no issue and no ODD association (S1), so the line names
// the checkout only — there is no `issues=` and no `odd=` cell, and the
// details carry no association field either (the registry keeps its legacy
// records; a listing never rewrites or republishes them):
//   worktree list: <name> <branch> principal
//   worktree list: <name> <branch> thread=<thread>
// A registered entry whose path is not a live checkout gains ` missing`:
//   worktree list: <name> <branch> thread=<thread> missing
// With `all: true`, live checkouts the registry does not know about are
// listed (the principal checkout is never listed as unregistered); the
// session's own one follows the principal and the rest stay path-sorted:
//   worktree list: <name> <branch> unregistered
// The principal checkout (S19) is always listed when git's listing names it,
// and it LEADS (S9: principal, then the session's own checkout, then the
// rest — never duplicating them when the session is in the principal);
// `worktree list: none` is retired and only survives as the degenerate
// fallback when the principal cannot be determined and nothing else is
// listed.
// S16 self-heal: an ABSOLUTE registry path that no longer exists on disk
// (the user deleted the checkout by hand) is removed from the listing AND
// pruned from the registry in one atomic write, so the tool always
// exposes only real checkouts. The pruned paths travel in
// `details.pruned` and in a `details.warnings` line that also says git may
// still record the checkout until `git worktree prune`; when the prune
// write itself fails, the listing still excludes them and says so (plus
// `details.pruneError`). A path that EXISTS but git no longer lists stays
// `missing` and is never pruned. A non-absolute entry can never be
// existence-checked without resolving against the process cwd, so it
// stays listed as `missing` (never live), exactly as before.
async function executeWorktreeList(params, ctx) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const cwd = toolCwd(ctx);

  let repo;
  const runAsync = libRunner(git);
  try {
    // S21: awaited reads only — listing worktrees is an interactive tool.
    repo = await git.repoIdentityAsync(cwd, { runAsync });
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { tool: "worktree_list" });
  }
  const all = !!params && params.all === true;
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(
      `cannot read worktree registry: ${read.error}`,
      { tool: "worktree_list" },
    );
  }
  let live;
  try {
    live = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { tool: "worktree_list" },
    );
  }

  // Cross-check the registry against git, then self-heal (S16), all
  // through the consolidated checkoutState. A row is live only when its
  // state exists AND is a directory AND its resolved identity (realpath,
  // absolute fallback) matches a live checkout's — so a row reaching a
  // live checkout through a symlink is live, while a FILE is never live
  // even when git names its path. A row is pruned only when nothing exists
  // at its path (a FILE exists, so it stays missing and is never pruned).
  // A registry path that is not absolute is never resolved against the
  // process cwd, so it can never match a live checkout and is reported
  // missing (and never pruned). Git's own listing paths resolve through
  // the same predicate, so a relative listing path resolves against the
  // repository root, never the process cwd.
  const liveIds = liveIdentities(live, repo.root);
  // S19: the principal checkout is the main worktree of git's listing.
  // repo.root is the toplevel of the CALLER's checkout (a linked worktree
  // when the session runs inside one), so the main root is recovered from
  // the shared common dir instead — for a normal repository
  // <principal>/.git is the common dir, the same recovery runCreationHooks
  // uses for its sources. The principal is the listing entry whose
  // resolved identity equals that main root: realpath with an absolute
  // fallback (the same rule checkoutState uses, never the process cwd),
  // so a symlink spelling of the principal still finds it. It is printed
  // distinguished (`principal`, never thread=/issues=), is never pruned
  // (the registry holds agent rows only) and is never reported as
  // unregistered. When no listing entry matches, no principal line is
  // invented.
  let principalEntry = null;
  let principalPath = null;
  if (typeof repo.commonDir === "string" && path.basename(repo.commonDir) === ".git") {
    try {
      const rawPrincipal = path.resolve(path.dirname(repo.commonDir));
      const principalState = checkoutState(rawPrincipal, repo.root);
      principalPath = principalState.real !== null ? principalState.real : principalState.absolute;
    } catch {
      principalPath = null;
    }
  }
  if (principalPath !== null) {
    for (const entry of live) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repo.root);
      if (st.absolute === null) continue;
      const entryId = st.real !== null ? st.real : st.absolute;
      if (entryId === principalPath) {
        principalEntry = entry;
        break;
      }
    }
    if (!principalEntry) principalPath = null;
  }
  let principalLine = null;
  let principalItem = null;
  if (principalEntry && principalPath !== null) {
    const principalBranch = principalEntry.branch || "(detached)";
    // S24: the first column is the NAME (`principal`), never the path.
    principalLine = `worktree list: principal ${principalBranch} principal`;
    // S1: the principal holds no registry row and a worktree carries no
    // association, so the item is its identity — no `issues`, no `odd` and no
    // `assignedOdd` field is invented for it.
    principalItem = { name: "principal", path: principalPath, branch: principalBranch, thread: null, status: "live", kind: "principal" };
  }
  const agentRows = [];
  const deadPaths = [];
  // S39 current branch from git (shared helper); the registry field is
  // the fallback. Sole claimants print the live branch; shared checkouts
  // keep their stored names so the ambiguity keeps resolving.
  const liveBranchById = liveBranchMap(live, repo.root);
  const claimCounts = registryClaimCounts(read.worktrees, repo.root);
  for (const entry of read.worktrees) {
    const isAbsoluteRow = typeof entry.path === "string" && path.isAbsolute(entry.path);
    const st = isAbsoluteRow ? checkoutState(entry.path, repo.root) : null;
    const absolute = st ? st.absolute : null;
    // Consolidated existence probe: nothing present (missing checkout,
    // dangling symlink) is pruned; a FILE is present, so it stays listed
    // as missing and is never pruned. Liveness additionally requires a
    // directory (checked below).
    if (absolute !== null && !st.exists) {
      deadPaths.push(entry.path);
      continue;
    }
    // S10: the principal's own registry row is printed as the principal
    // line above, never repeated as an agent row.
    if (principalPath !== null && st && st.absolute !== null) {
      const rowIdentity = st.real !== null ? st.real : st.absolute;
      if (rowIdentity === principalPath) continue;
    }
    // A FILE is never live even when git names its path, and a symlink
    // spelling of a live checkout IS live: liveness is exists AND
    // is-a-directory AND resolved-identity membership, the one predicate.
    const liveHit = st && st.absolute !== null && st.exists && st.isDirectory
      && (st.real !== null ? liveIds.has(st.real) : liveIds.has(st.absolute))
      ? true
      : undefined;
    const thread = typeof entry.thread === "string" && entry.thread.length > 0
      ? entry.thread
      : "unknown";
    const status = liveHit ? "live" : "missing";
    // S24: the first column is the NAME (flattened branch slug); the
    // absolute path stays in details, never in the printed line.
    // S39: a sole claimant shows the CURRENT git branch, not the stale row.
    const rowId = st && st.absolute !== null ? (st.real !== null ? st.real : st.absolute) : null;
    const liveShown = rowId !== null && (claimCounts.get(rowId) || 0) === 1 ? liveBranchById.get(rowId) : undefined;
    const shownBranch = liveShown || entry.branch;
    let rowName = "worktree";
    try {
      rowName = git.slugifyBranch(typeof shownBranch === "string" ? shownBranch : "worktree");
    } catch {
      rowName = "worktree";
    }
    agentRows.push({
      // S1: no `issues=` and no `odd=` cell — a worktree carries neither, and
      // the listing neither reads the stored association nor scans the
      // checkout's `odd/` directory for an inventory.
      line: `worktree list: ${rowName} ${shownBranch} thread=${thread}`
        + (liveHit ? "" : " missing"),
      // Identity only: the legacy association fields the registry still stores
      // stay there (preserved bytes) and are deliberately not republished.
      item: { name: rowName, path: entry.path, branch: shownBranch, thread, status, kind: "agent" },
    });
  }
  // Prune exactly the dead rows in one atomic registry write, best
  // effort: when the write fails the listing below still excludes them
  // and the warning says so.
  let pruned = [];
  let pruneError = null;
  if (deadPaths.length > 0) {
    try {
      const outcome = registry.pruneWorktrees(repo.root, deadPaths);
      if (outcome && outcome.ok) {
        pruned = Array.isArray(outcome.pruned) ? outcome.pruned : [];
        // The prune also reports any legacy ODD associations that went with
        // the removed rows; S1 removed associations from every worktree
        // surface, so no notice about them is emitted here.
      } else {
        pruneError = (outcome && outcome.error) || "unknown prune error";
      }
    } catch (err) {
      pruneError = (err && err.message) || String(err);
    }
  }
  // S9: the listing order is the PRINCIPAL checkout first, then the session's
  // own checkout, then everything else in registry order. Identity is the
  // resolved realpath with an absolute fallback on both legs (never the
  // process cwd and never a lexical resolve alone), so a symlink spelling of a
  // checkout — or of a subdirectory inside one — still matches that checkout.
  // When the session already sits in the principal there is nothing to add:
  // the principal line IS the current line and is never duplicated. The
  // agent-row text contract is unchanged.
  const sessionState = checkoutState(cwd, repo.root);
  const sessionTarget = sessionState.real !== null ? sessionState.real : sessionState.absolute;
  const containsOrEquals = (base, target) => target === base || target.startsWith(base + path.sep);
  let sessionAgent = -1;
  let bestLen = -1;
  if (principalItem !== null && sessionTarget !== null) {
    const principalState = checkoutState(principalItem.path, repo.root);
    const principalBase = principalState.real !== null ? principalState.real : principalState.absolute;
    if (principalBase !== null && containsOrEquals(principalBase, sessionTarget)) {
      bestLen = principalBase.length;
    }
  }
  agentRows.forEach((row, index) => {
    if (typeof row.item.path !== "string" || !path.isAbsolute(row.item.path)) return;
    if (sessionTarget === null) return;
    const rowState = checkoutState(row.item.path, repo.root);
    const base = rowState.real !== null ? rowState.real : rowState.absolute;
    if (base === null) return;
    if (containsOrEquals(base, sessionTarget) && base.length > bestLen) {
      sessionAgent = index;
      bestLen = base.length;
    }
  });
  const lines = [];
  const items = [];
  if (principalLine !== null) {
    lines.push(principalLine);
    items.push(principalItem);
  }
  if (sessionAgent >= 0) {
    lines.push(agentRows[sessionAgent].line);
    items.push(agentRows[sessionAgent].item);
  }
  agentRows.forEach((row, index) => {
    if (index === sessionAgent) return;
    lines.push(row.line);
    items.push(row.item);
  });
  const warnings = [];
  if (deadPaths.length > 0) {
    if (pruneError) {
      warnings.push(
        `could not prune ${deadPaths.length} stale worktree path(s) from the registry (${deadPaths.join(", ")}): ${pruneError}; the listing still excludes them, and git may still record the checkout until 'git worktree prune'`,
      );
    } else {
      warnings.push(
        `pruned ${pruned.length} stale worktree path(s) from the registry: ${pruned.join(", ")}; git may still record the checkout until 'git worktree prune'`,
      );
    }
  }
  if (all) {
    // Only absolute registry paths participate: anything else cannot name
    // a live checkout without resolving against the process cwd. The set
    // comes from the POST-prune registry (re-read; when the re-read fails
    // the pre-prune set minus the pruned paths stands in), so a row pruned
    // above never reappears as "unregistered" just because git still
    // records it. Every git entry is existence-checked on its absolute
    // form (relative entries resolve against the repository root, never
    // the process cwd): a path that does not exist is never reported, in
    // any status, and stays out of details.worktrees as well.
    let postPrune = null;
    try {
      const reread = registry.readRegistry(repo.root);
      if (reread && reread.ok === true && Array.isArray(reread.worktrees)) postPrune = reread.worktrees;
    } catch {
      postPrune = null;
    }
    const registered = new Set();
    for (const entry of postPrune || read.worktrees) {
      if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) continue;
      const st = checkoutState(entry.path, repo.root);
      // Both spellings count: a symlink row and the git spelling of the
      // same checkout share the realpath, so the checkout is never
      // double-reported as unregistered.
      if (st.absolute !== null) registered.add(st.absolute);
      if (st.real !== null) registered.add(st.real);
    }
    if (!postPrune) {
      for (const dropped of pruned) {
        try {
          registered.delete(path.resolve(dropped));
        } catch {
          // Nothing to delete.
        }
      }
    }
    // The principal checkout is never an extra: it already has its
    // distinguished line. Any other live checkout the registry does not
    // know about — including the session's own checkout when it is
    // unregistered — is reported. The principal exclusion is by resolved
    // identity (realpath with absolute fallback), so a symlink spelling
    // of the principal never surfaces as unregistered. When no principal
    // could be determined, the caller's checkout keeps the old exclusion
    // so the degenerate listing stays exactly `worktree list: none`.
    const self = principalPath !== null ? principalPath : path.resolve(repo.root);
    const extra = live
      .filter((entry) => {
        if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return false;
        // Consolidated predicate: only an existing DIRECTORY surfaces,
        // relative entries resolving against the repository root.
        const st = checkoutState(entry.path, repo.root);
        if (st.absolute === null || !st.exists || !st.isDirectory) return false;
        if (registered.has(st.absolute)) return false;
        if (st.real !== null && registered.has(st.real)) return false;
        const entryId = st.real !== null ? st.real : st.absolute;
        if (entryId === self) return false;
        return true;
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // S9: the same order holds for unregistered rows. The session's OWN
    // unregistered checkout sits directly after the principal (never
    // duplicated when the session is in the principal), and the remaining
    // extras follow in path order. The match is deepest-containing on
    // resolved identity, the same rule as the registered session match above.
    let sessionExtra = -1;
    let sessionBest = -1;
    if (sessionTarget !== null) {
      extra.forEach((entry, index) => {
        const st = checkoutState(entry.path, repo.root);
        const base = st.real !== null ? st.real : st.absolute;
        if (base === null) return;
        if (containsOrEquals(base, sessionTarget) && base.length > sessionBest) {
          sessionExtra = index;
          sessionBest = base.length;
        }
      });
    }
    const orderedExtra = sessionExtra >= 0
      ? [extra[sessionExtra], ...extra.filter((_, index) => index !== sessionExtra)]
      : extra;
    const extraLines = [];
    for (const entry of orderedExtra) {
      const branch = entry.branch || "(detached)";
      // Report the resolved absolute form so details.worktrees never
      // carries a relative spelling or a path that does not exist.
      const shown = checkoutState(entry.path, repo.root).absolute || entry.path;
      // S24: the first column is the NAME, exactly what `warp` accepts.
      let extraName = "worktree";
      try {
        extraName = git.slugifyBranch(branch);
      } catch {
        extraName = "worktree";
      }
      extraLines.push({
        line: `worktree list: ${extraName} ${branch} unregistered`,
        // An unregistered checkout has no registry row: the item is its
        // identity, with no association field invented for it (S1).
        item: { name: extraName, path: shown, branch, thread: null, status: "unregistered", kind: "unregistered" },
      });
    }
    const primaryExtra = sessionExtra >= 0 ? extraLines[0] : null;
    const restExtra = sessionExtra >= 0 ? extraLines.slice(1) : extraLines;
    const insertAt = principalItem !== null ? 1 : 0;
    if (primaryExtra) {
      lines.splice(insertAt, 0, primaryExtra.line);
      items.splice(insertAt, 0, primaryExtra.item);
    }
    // Only the current checkout jumps ahead; unrelated unregistered rows
    // retain their previous place after the registered rows.
    lines.push(...restExtra.map((entry) => entry.line));
    items.push(...restExtra.map((entry) => entry.item));
  }
  // S19 retires `worktree list: none`: with the principal line always
  // present there is always something to list. This fallback survives
  // only for the degenerate case where the principal cannot be determined
  // from git's listing and nothing else is listed either.
  if (lines.length === 0) {
    return textResult("worktree list: none", { worktrees: [], count: 0, all, pruned, warnings, pruneError }, false);
  }
  return textResult(lines.join("\n"), { worktrees: items, count: items.length, all, pruned, warnings, pruneError }, false);
}

// Rank registry entries by common-prefix score against the query so an
// unregistered close target can name the closest registered candidates.
function rankCandidates(query, entries) {
  const q = String(query);
  return entries
    .map((entry) => {
      const name = String(entry.branch || "");
      const shared = Math.min(q.length, name.length);
      let score = 0;
      while (score < shared && q[score] === name[score]) score += 1;
      let pathBonus = 0;
      try {
        if (typeof entry.path === "string" && entry.path.includes(q)) {
          pathBonus = Math.min(3, Math.floor(q.length / 4));
        }
      } catch {
        pathBonus = 0;
      }
      return { entry, score: score + pathBonus };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((ranked) => ranked.entry);
}

// Checkouts from the pre-removal snapshot that are gone now, excluding
// the target itself. A hostile or confused remover that deleted another
// checkout fails loudly through this: the caller names the vanished path
// instead of treating the close as successful (or as a bare failure).
// Never throws and never masks the caller's own error. Pass the
// already-fetched post listing when there is one; otherwise one is fetched
// best-effort. When no post-removal listing is available (it failed), the
// comparison falls back to an existence check on the pre-removal live
// paths: a pre-removal live checkout whose directory no longer exists has
// vanished. Every probe is absolute and never consults the process cwd.
async function vanishedCheckouts(git, repoRoot, live, resolvedTarget, after) {
  // S21: the only child here is a fallback listing, awaited like every other
  // interactive read so a slow repository never freezes the host.
  const runAsync = libRunner(git);
  // Identity through the consolidated predicate: compare resolved
  // realpaths (absolute fallback), never bare spellings, so a symlink
  // spelling of a surviving checkout is not misreported as vanished. The
  // target itself is excluded by the same resolved identity (absolute OR
  // realpath), never by lexical spelling alone. Both legs name only paths
  // where NOTHING exists — a path replaced by a FILE reads `missing` in
  // the list and is not reported vanished here either, so list, create and
  // close agree that exists AND is-a-directory is the rule.
  let targetReal = null;
  try {
    targetReal = checkoutState(resolvedTarget, repoRoot).real;
  } catch {
    targetReal = null;
  }
  const isTarget = (st) => {
    if (st.absolute === null) return true;
    if (st.absolute === resolvedTarget) return true;
    if (st.real !== null && targetReal !== null && st.real === targetReal) return true;
    return false;
  };
  const identityOf = (item) => {
    if (!item || typeof item.path !== "string" || item.path.length === 0) return null;
    const st = checkoutState(item.path, repoRoot);
    if (st.absolute === null) return null;
    if (isTarget(st)) return null;
    return { id: st.real !== null ? st.real : st.absolute, absolute: st.absolute, exists: st.exists, isDirectory: st.isDirectory };
  };
  let current = after;
  if (!current) {
    try {
      current = await git.listWorktreesAsync(repoRoot, { runAsync });
    } catch {
      current = null;
    }
  }
  if (current) {
    try {
      const afterSet = new Set();
      for (const item of current) {
        const seen = identityOf(item);
        // The target itself is excluded by identityOf; every other listed
        // record counts as present by resolved identity.
        if (seen !== null) afterSet.add(seen.id);
      }
      const vanished = [];
      for (const item of live || []) {
        const before = identityOf(item);
        if (before === null) continue;
        if (!afterSet.has(before.id)) {
          // Same rule as the fallback: only a path where NOTHING exists
          // has vanished; a FILE reads missing, never vanished.
          if (!before.exists) vanished.push(before.absolute);
        }
      }
      return vanished;
    } catch {
      // Fall through to the existence check below.
    }
  }
  const vanished = [];
  try {
    for (const item of live || []) {
      const before = identityOf(item);
      if (before === null) continue;
      // Only a path where nothing exists has vanished: something present
      // (even a FILE) is reported `missing` elsewhere, never vanished.
      if (!before.exists) vanished.push(before.absolute);
    }
  } catch {
    return [];
  }
  return vanished;
}

// S24 name resolution — the ONE place checkout names resolve to
// checkouts. `worktree_close` (by `name`) and the `warp` command verb
// both call this, never separate logic. A name is the flattened branch
// slug (`slugifyBranch`, already exported by lib/worktree-git.js), or
// `principal` for the principal checkout.
//
// `principal` is `{path, branch} | null` (null when git's listing names
// no principal). Returns either:
// - `{ok: true, kind: "principal", name, path, branch, entry: null}`, or
// - `{ok: true, kind: "agent", name, path, branch, entry}`, or
// - `{ok: false, error, candidates}` where candidates are the known names
//   for the fail-closed message.
// An unknown name fails closed; two registry rows flattening to one name
// are AMBIGUOUS and fail closed naming every matching row, never picking
// one.
// Names are the flattened branch slug, and `principal` is reserved for the
// principal checkout. A branch whose slug is also `principal`, or a live
// checkout the registry does not own that shares a name with a registered
// row, makes that name genuinely ambiguous to whoever read it in the
// listing — so those cases fail closed instead of silently selecting one
// checkout. The caller can always pass the path or the branch.
function slugOf(git, branch) {
  try {
    const slug = typeof branch === "string" ? git.slugifyBranch(branch) : null;
    return typeof slug === "string" && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

function prefixScore(query, slug) {
  const q = String(query);
  const s = String(slug);
  const shared = Math.min(q.length, s.length);
  let score = 0;
  while (score < shared && q[score] === s[score]) score += 1;
  return score;
}

// Live checkouts git lists that no registry row owns, by resolved identity.
// `all: true` prints them, so a name they share with a registered row is
// ambiguous to the reader even though only the registered row is selectable.
// The principal checkout is NOT one of them: it prints as `principal`, never
// by its branch, so a branch whose slug happens to equal the principal's own
// branch slug leaves the name unique instead of colliding with it.
function liveUnregisteredEntries(rows, live, repoRoot, principal) {
  const owned = new Set();
  for (const row of rows) {
    if (!row || typeof row.path !== "string" || row.path.length === 0) continue;
    const st = checkoutState(row.path, repoRoot);
    if (st.absolute !== null) owned.add(st.absolute);
    if (st.real !== null) owned.add(st.real);
  }
  let principalId = null;
  if (principal && typeof principal.path === "string" && principal.path.length > 0) {
    const st = checkoutState(principal.path, repoRoot);
    principalId = st.real !== null ? st.real : st.absolute;
  }
  const out = [];
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    // The same liveness the listing applies: a git record whose directory is
    // gone (prunable) is not printed as an unregistered checkout, so it must
    // not make a name ambiguous either.
    if (!st.exists || !st.isDirectory) continue;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || owned.has(id)) continue;
    if (principalId !== null && id === principalId) continue;
    out.push({ path: id, branch: entry.branch || "(detached)" });
  }
  return out;
}

// S29 name-or-path resolution shared by close (and, through its own
// call below, session open): the SAME field accepts a name OR a path —
// the name first (the caller tries `resolveCheckoutByName`), then the
// path. A path resolves only when it exists, is a directory, and belongs
// to this project's worktrees: it must match a registered row by
// resolved identity AND be a live checkout in git's listing. Anything
// else yields null so the caller fails closed with the name error.
function resolveClosePathEntry(raw, git, read, live, repoRoot) {
  try {
    if (typeof raw !== "string" || raw.length === 0) return null;
    const st = checkoutState(raw, repoRoot);
    if (st.absolute === null || !st.exists || !st.isDirectory) return null;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null) return null;
    if (!liveIdentities(live, repoRoot).has(id)) return null;
    const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid !== null && rid === id) return row;
    }
    return null;
  } catch {
    return null;
  }
}

// S39 current branch, shared by the resolver, the listing, the selector
// and the warp: map each live checkout identity to its CURRENT branch from
// git. The registry row keeps the branch recorded at creation time, so this
// map is the refresh source and the registry field is the fallback only.
function liveBranchMap(live, repoRoot) {
  const map = new Map();
  try {
    for (const record of live || []) {
      if (!record || typeof record.path !== "string" || record.path.length === 0) continue;
      const rst = checkoutState(record.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid === null) continue;
      if (typeof record.branch === "string" && record.branch.length > 0 && !map.has(rid)) {
        map.set(rid, record.branch);
      }
    }
  } catch {
    // No live map: every caller falls back to its registry field.
  }
  return map;
}

// How many registry rows claim each checkout identity. The CURRENT branch
// replaces a row's stored branch only when that row is the checkout's sole
// claimant: several rows may deliberately reach one checkout (a symlink
// spelling kept under its own name), and there the stored names stay so the
// ambiguity keeps resolving.
function registryClaimCounts(rows, repoRoot) {
  const counts = new Map();
  try {
    for (const row of rows || []) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid === null) continue;
      counts.set(rid, (counts.get(rid) || 0) + 1);
    }
  } catch {
    // No counts: callers keep their registry fields.
  }
  return counts;
}

function resolveCheckoutByName(name, git, read, principal, live, repoRoot, opts) {
  // S14: the warp allows a single unregistered match (`{allowUnregistered:
  // true}`); close-by-name and session-open keep the default refusal so
  // their semantics do not change.
  const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
  const extras = liveUnregisteredEntries(rows, live, repoRoot, principal);
  const knownNames = [];
  if (principal) knownNames.push("principal");
  const seen = new Set();
  for (const item of [...rows, ...extras]) {
    const slug = slugOf(git, item && item.branch);
    if (slug === null || seen.has(slug)) continue;
    seen.add(slug);
    knownNames.push(slug);
  }
  if (name === "principal") {
    const clashes = [];
    for (const row of rows) {
      if (slugOf(git, row && row.branch) === "principal") clashes.push(`'${row.branch}' at ${row.path}`);
    }
    for (const extra of extras) {
      if (slugOf(git, extra.branch) === "principal") clashes.push(`'${extra.branch}' at ${extra.path} (unregistered)`);
    }
    if (clashes.length > 0) {
      return {
        ok: false,
        error: `worktree name "principal" is ambiguous: it names the principal checkout and ${clashes.join(", ")}; pass the path or branch instead`,
        candidates: knownNames,
      };
    }
    if (principal) {
      return {
        ok: true, kind: "principal", name: "principal",
        path: principal.path, branch: principal.branch, entry: null,
      };
    }
    return {
      ok: false,
      error: `no registered worktree for "principal": the principal checkout could not be determined; known worktrees: ${knownNames.join(", ") || "(none)"}`,
      candidates: knownNames,
    };
  }
  // S39: a row matches by its stored slug OR by its CURRENT live-branch
  // slug, so the refreshed name the listing and the selector show stays
  // warpable. One row matching twice still counts once.
  const liveById = liveBranchMap(live, repoRoot);
  const matches = [];
  for (const row of rows) {
    if (slugOf(git, row && row.branch) === name) {
      matches.push(row);
      continue;
    }
    if (row && typeof row.path === "string" && path.isAbsolute(row.path)) {
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      const current = rid !== null ? liveById.get(rid) : undefined;
      if (typeof current === "string" && slugOf(git, current) === name) matches.push(row);
    }
  }
  const extraMatches = extras.filter((extra) => slugOf(git, extra.branch) === name);
  if (matches.length + extraMatches.length > 1) {
    const named = [
      ...matches.map((row) => `'${row.branch}' at ${row.path}`),
      ...extraMatches.map((extra) => `'${extra.branch}' at ${extra.path} (unregistered)`),
    ].join(", ");
    return {
      ok: false,
      error: `worktree name "${name}" is ambiguous: ${named}; pass the path or branch instead`,
      candidates: knownNames,
    };
  }
  if (matches.length === 1) {
    const row = matches[0];
    return {
      ok: true, kind: "agent", name,
      path: row.path, branch: row.branch, entry: row,
    };
  }
  if (extraMatches.length === 1) {
    const only = extraMatches[0];
    // S14: the warp moves to a lone unregistered checkout; every other
    // caller keeps the refusal (close never acts on one).
    if (opts && opts.allowUnregistered === true) {
      return {
        ok: true, kind: "unregistered", name,
        path: only.path, branch: only.branch, entry: null,
      };
    }
    return {
      ok: false,
      error: `no registered worktree for ${JSON.stringify(name)}: '${only.branch}' at ${only.path} is unregistered, and neither close nor warp acts on an unregistered checkout`,
      candidates: knownNames,
    };
  }
  // Unknown: fail closed in the style of the unknown-path error, naming
  // the closest known candidates by name.
  const ranked = [
    ...rows.map((row) => ({ branch: row && row.branch, path: row && row.path })),
    ...extras,
  ]
    .map((item) => ({ item, slug: slugOf(git, item.branch) || "" }))
    .sort((a, b) => prefixScore(name, b.slug) - prefixScore(name, a.slug))
    .slice(0, 3);
  const named = ranked.map((item) => `'${item.slug}' (branch '${item.item.branch}') at ${item.item.path}`).join(", ");
  const suffix = ranked.length > 0 ? `: closest worktrees: ${named}` : ": no worktrees are registered";
  return {
    ok: false,
    error: `no registered worktree for ${JSON.stringify(name)}${suffix}`,
    candidates: knownNames,
  };
}

// The principal checkout for name resolution: the live listing entry
// whose resolved identity equals the main root recovered from the shared
// common dir (the same recovery the list uses). Null when git's listing
// names no such entry, so no principal line — and no `principal` name —
// is invented.
function principalForName(git, repoRoot, repo, live) {
  try {
    if (typeof repo.commonDir !== "string" || path.basename(repo.commonDir) !== ".git") return null;
    const rawPrincipal = path.resolve(path.dirname(repo.commonDir));
    const principalState = checkoutState(rawPrincipal, repoRoot);
    const principalPath = principalState.real !== null ? principalState.real : principalState.absolute;
    if (principalPath === null) return null;
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      if (st.absolute === null) continue;
      const entryId = st.real !== null ? st.real : st.absolute;
      if (entryId === principalPath) {
        return { path: principalPath, branch: entry.branch || "(detached)" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Best-effort session-manager string accessor for the close sequence:
// the current session id or session file, or null when the context
// carries no such accessor. Never throws.
function closeSessionString(ctx, method) {
  try {
    const sm = ctx && ctx.sessionManager;
    if (!sm || typeof sm[method] !== "function") return null;
    const value = sm[method]();
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

// S7/S8/S9: the active-session refusal, shared by `worktree_close` and the warp
// panel's Ctrl+D (lib/worktree-session-guard.js).
//
// The guard answers one question per checkout: is a live Pi session working
// there? It reads Gentle Shell's published presence records (heartbeat +
// workspace) and, deterministically, the checkout THIS session stands on. Both
// callers run it, so the tool and the panel can never disagree.
//
// Two outcomes refuse with nothing mutated:
//   - this session is in the checkout: the human is told to warp first
//     (`/warp`), then close. The tool NEVER warps by itself and never closes or
//     opens a Herdr pane/workspace: a destructive action that first moves the
//     session would hide the state it was approved on;
//   - another session is in the checkout: the refusal names its RAW session id,
//     joined from the published transport record whose id hashes to that
//     session's presence header, and asks the human to make sure it finished,
//     then close or warp it away from that session. When no transport record
//     joins, the refusal shows the presence hash and says the id could not be
//     resolved — it never invents an id from a label.
// A stale, unattributable or truncated record blocks nothing — it is disclosed
// in `notices` — because the stores are bounded and can outlive a crashed
// process (L13). The guard is BEST EFFORT and is never claimed to be
// exhaustive.
// Returns {refused, text, notices, guard}. A broken guard module fails closed:
// the removal cannot run without the check that gates it.
async function checkoutSessionGuard({ ctx, target }) {
  let guardLib;
  try {
    guardLib = libRequire("worktree-session-guard.js");
  } catch (err) {
    return {
      refused: true,
      text: `cannot close the worktree at ${target}: the active-session guard is unavailable (${(err && err.message) || err}); the checkout and the registry were left untouched`,
      notices: [],
      guard: { status: "unavailable" },
    };
  }
  if (typeof guardLib.readGentlePresence !== "function" || typeof guardLib.evaluateCheckoutSessions !== "function") {
    return {
      refused: true,
      text: `cannot close the worktree at ${target}: the active-session guard is incomplete; the checkout and the registry were left untouched`,
      notices: [],
      guard: { status: "unavailable" },
    };
  }
  try {
    // Read-only, bounded and awaited so a slow filesystem never freezes the
    // host event loop the human is typing into. The transport registry is what
    // turns a presence hash into the RAW session id a refusal names; when it is
    // absent the guard says so instead of guessing one.
    const presence = await guardLib.readGentlePresence();
    const transport = typeof guardLib.readTransportSessions === "function"
      ? await guardLib.readTransportSessions()
      : null;
    const result = guardLib.evaluateCheckoutSessions({
      targetPath: target,
      presence,
      transport,
      currentSessionId: closeSessionString(ctx, "getSessionId"),
      currentCwd: toolCwd(ctx),
    });
    const notices = Array.isArray(result.notices) ? result.notices : [];
    if (result.verdict !== "clear") {
      return { refused: true, text: result.text, notices: [], guard: result.evidence };
    }
    return { refused: false, text: null, notices, guard: result.evidence };
  } catch (err) {
    return {
      refused: true,
      text: `cannot close the worktree at ${target}: the active-session check failed (${(err && err.message) || err}); the checkout and the registry were left untouched`,
      notices: [],
      guard: { status: "failed" },
    };
  }
}

// gentle-shell owns the live session's permission mode, and its YOLO grant is
// in-memory there: it answers on this host channel with an adapter whose read()
// is "ON" only while the grant still binds THIS live session (upstream
// lib/yolo-session-policy.ts, discovered through `pi.events`).
const YOLO_HOST_CHANNEL = "gentle:yolo:host-ui";
const YOLO_DISCOVERY_TIMEOUT_MS = 100;
let hostEvents = null;

// True only on an explicit "ON" answer. Everything else — gentle-shell absent,
// no `pi.events`, no responder, a malformed answer, a throw or the discovery
// timeout — reads as "not YOLO", so every caller keeps asking.
async function yoloActiveFor(ctx) {
  const events = hostEvents;
  if (!events || typeof events.emit !== "function" || !ctx) return false;
  let adapter = null;
  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; resolve(); }, YOLO_DISCOVERY_TIMEOUT_MS);
    const respond = (value) => {
      if (!value || typeof value !== "object" || typeof value.read !== "function") return;
      if (settled) {
        // A late second answer is disposed rather than read.
        try { value.dispose?.(); } catch { /* display only */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      adapter = value;
      resolve();
    };
    try {
      events.emit(YOLO_HOST_CHANNEL, { context: ctx, respond });
    } catch {
      settled = true;
      clearTimeout(timer);
      resolve();
    }
  });
  if (!adapter) return false;
  try {
    return (await adapter.read()) === "ON";
  } catch {
    return false;
  } finally {
    try { adapter.dispose?.(); } catch { /* display only */ }
  }
}

// Core of `worktree_close` (S7, D6, S6-S9): remove the checkout, keep the
// branch, drop the registry entry. Exported for unit tests; the registered tool
// calls it with the live Pi context, and the warp panel's Ctrl+D calls it with
// `opts.approved` after its own question.
//
// The S7 rule is that the BRANCH IS KEPT: this function never deletes a
// branch, never passes `--trust-repository`, and passes `--force` only when the
// caller asked for it. Removal is `git worktree remove` and nothing else (S6):
// no Herdr workspace is closed, created or retired, and Herdr is never asked to
// remove a checkout. A dirty checkout without `force` fails with the backend's
// own reason and nothing is mutated. The registry entry is dropped only after
// `listWorktrees` confirms the path is gone.
//
// S7-S9: a live Pi session working in the target refuses the close — before the
// approval question and again immediately before the removal — through the
// shared `checkoutSessionGuard`. Nothing is auto-warped and nothing is closed on
// the human's behalf.
async function executeWorktreeClose(params, ctx, opts) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const cwd = toolCwd(ctx);

  const rawPath = params ? params.path : undefined;
  const rawBranch = params ? params.branch : undefined;
  const rawName = params ? params.name : undefined;
  const force = !!params && params.force === true;
  const runAsync = libRunner(git);
  const hasPath = typeof rawPath === "string" && rawPath.length > 0;
  const hasBranch = typeof rawBranch === "string" && rawBranch.length > 0;
  const hasName = typeof rawName === "string" && rawName.length > 0;
  if (!hasPath && !hasBranch && !hasName) {
    return errorResult(
      "worktree_close requires a path or a branch or a name: pass the worktree path, branch, or name to close",
      { force },
    );
  }
  // S24: `name` is a third selector beside `path` and `branch` — at most
  // one of the three. (The pre-existing path+branch pair keeps its
  // agree-or-disagree behaviour below.)
  if (hasName && (hasPath || hasBranch)) {
    return errorResult(
      "worktree_close accepts only one of path, branch, or name: pass only one",
      { path: rawPath, branch: rawBranch, name: rawName, force },
    );
  }

  let repo;
  try {
    // S21: awaited, so a slow `git rev-parse` cannot freeze the confirmed
    // delete's repaint or keyboard input.
    repo = await git.repoIdentityAsync(cwd, { runAsync });
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { force });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(`cannot read worktree registry: ${read.error}`, { force });
  }
  const byPath = hasPath && !hasName ? registry.findByPath(repo.root, rawPath) : null;
  const byBranch = hasBranch && !hasName ? registry.findByBranch(repo.root, rawBranch) : null;
  if (hasPath && hasBranch && byPath && byBranch && byPath.branch !== byBranch.branch) {
    return errorResult(
      `worktree_close path and branch disagree: path resolves to branch '${byPath.branch}' but branch '${rawBranch}' is registered elsewhere; pass only one`,
      { path: rawPath, branch: rawBranch, force },
    );
  }
  // S24: resolve `name` through the shared resolver (the same one `warp`
  // uses). An unknown or ambiguous name fails closed here, before
  // anything is verified or removed.
  let entry = byPath || byBranch || null;
  if (hasName) {
    let liveForName;
    try {
      liveForName = await git.listWorktreesAsync(repo.root, { runAsync });
    } catch (err) {
      return errorResult(
        `cannot list worktrees: ${(err && err.message) || err}`,
        { name: rawName, force },
      );
    }
    const resolved = resolveCheckoutByName(rawName, git, read, principalForName(git, repo.root, repo, liveForName), liveForName, repo.root);
    if (!resolved.ok) {
      // S29: the same field accepts a name OR a path — the name first,
      // then the path. A path resolves only when it exists and belongs
      // to this project's worktrees (checked against the registry and
      // the live listing); anything else fails closed with the name
      // resolution error and no side effect.
      const pathEntry = resolveClosePathEntry(rawName, git, read, liveForName, repo.root);
      if (pathEntry) {
        entry = pathEntry;
      } else {
        return errorResult(resolved.error, { query: rawName, candidates: resolved.candidates, force });
      }
    } else if (resolved.kind === "principal") {
      return errorResult(
        `cannot close the principal checkout at ${resolved.path}: worktree_close only closes registered agent worktrees; the checkout and the registry were left untouched`,
        { name: rawName, path: resolved.path, branch: resolved.branch, force },
      );
    } else {
      entry = resolved.entry;
    }
    // S32: a path that resolves to the principal checkout (or to
    // anything that is not a registered agent worktree) is refused here,
    // before any approval, removal or registry write.
    if (entry) {
      const entryState = checkoutState(entry.path, repo.root);
      const entryId = entryState.real !== null ? entryState.real : entryState.absolute;
      const principalRef = principalForName(git, repo.root, repo, liveForName);
      if (principalRef && typeof principalRef.path === "string") {
        const pst = checkoutState(principalRef.path, repo.root);
        const pid = pst.real !== null ? pst.real : pst.absolute;
        if (entryId !== null && pid !== null && entryId === pid) {
          return errorResult(
            `cannot close the principal checkout at ${principalRef.path}: worktree_close only closes registered agent worktrees; the checkout and the registry were left untouched`,
            { name: rawName, path: principalRef.path, branch: principalRef.branch, force },
          );
        }
      }
    }
  }
  if (!entry) {
    // Never remove an unknown checkout: refuse and name the closest
    // registered candidates instead.
    const query = hasPath ? rawPath : rawBranch;
    if (read.worktrees.length === 0) {
      return errorResult(
        `no registered worktree for ${JSON.stringify(query)}: no worktrees are registered`,
        { query, force },
      );
    }
    const candidates = rankCandidates(query, read.worktrees);
    const named = candidates.map((item) => `'${item.branch}' at ${item.path}`).join(", ");
    return errorResult(
      `no registered worktree for ${JSON.stringify(query)}: closest registered worktrees: ${named}`,
      { query, candidates: candidates.map((item) => ({ branch: item.branch, path: item.path })), force },
    );
  }
  const target = entry.path;
  const branch = entry.branch;
  // C1: a registry entry whose path is not absolute is refused here,
  // before anything is verified or removed. Resolving it against the
  // process cwd would name a checkout relative to wherever the caller
  // happens to run, while `git worktree remove` runs with cwd = the
  // repository root — the check and the removal would name different
  // checkouts. No mutation, no registry change.
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return errorResult(
      `refusing to close worktree for branch '${branch}': registry entry path ${JSON.stringify(target)} is not absolute (registry entry paths must be absolute); the checkout and the registry were left untouched`,
      { branch, path: target, force },
    );
  }
  // The single absolute value derived from the entry: the pre-removal
  // check, any removal argv, and the post-removal verification all use
  // this, never the process cwd.
  // L7: the checkout belongs to a thread. Closing another thread's
  // checkout is legitimate (a delivered thread is often closed from a later
  // session), so this reports the owner instead of refusing: the human sees
  // whose checkout the approval would remove.
  const owner = typeof entry.thread === "string" && entry.thread.length > 0 ? entry.thread : null;
  const resolvedTarget = path.resolve(target);

  let live;
  try {
    live = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { branch, path: target, force },
    );
  }
  // Pre-removal liveness through the same predicate: the target must exist
  // as a directory AND be recorded by git. A hand-deleted checkout git
  // still records, or a path replaced by a FILE, is stale — the entry is
  // kept, exactly like the list's `missing`.
  const closeLiveIds = liveIdentities(live, repo.root);
  const targetState = checkoutState(target, repo.root);
  const targetLive = targetState.absolute !== null && targetState.exists && targetState.isDirectory
    && (targetState.real !== null ? closeLiveIds.has(targetState.real) : closeLiveIds.has(targetState.absolute));
  if (!targetLive) {
    return errorResult(
      `worktree at ${target} is not a live checkout (stale registry entry for branch '${branch}'): the entry was kept`,
      { branch, path: target, force },
    );
  }

  // The warp keyboard delete pins the identity it approved (`opts.expectedReal`,
  // the realpath the selector listed) and this function re-checks it — once
  // before any pre-removal side effect, and again immediately before a remover
  // is invoked. Without that, a path replaced by a symbolic link while the
  // human answered would be handed to `git worktree remove`, which resolves the
  // spelling it is given and would name ANOTHER checkout. No tool reaches this:
  // `worktree_close` calls this function without options.
  const expectedReal = opts && typeof opts.expectedReal === "string" && opts.expectedReal.length > 0
    ? opts.expectedReal
    : null;
  // The approved DIRECTORY, pinned beyond its spelling: `dev`/`ino` name the
  // object a removal would destroy. A realpath comparison alone cannot see a
  // path replaced by a DIFFERENT directory at that same path — the spelling and
  // the resolved path are identical, the object is not — so the warp delete
  // pins the inode and this function re-reads it here.
  const expectedPin = expectedReal !== null && opts && opts.expectedPin && typeof opts.expectedPin === "object"
    ? opts.expectedPin
    : null;
  const pinDev = expectedPin && typeof expectedPin.dev === "number" ? expectedPin.dev : null;
  const pinIno = expectedPin && typeof expectedPin.ino === "number" ? expectedPin.ino : null;
  const identityRefusal = () => {
    const fresh = warpDeleteIdentity(target, repo.root);
    const realMatches = fresh.real !== null && fresh.real === expectedReal;
    // Every offered row is a live checkout's own realpath, never a link, so a
    // path that IS one now is a spelling nobody approved whatever it resolves to.
    const notALink = fresh.link === false;
    const sameDirectory = pinDev === null || pinIno === null
      ? true
      : (fresh.dev === pinDev && fresh.ino === pinIno);
    if (realMatches && notALink && sameDirectory) return null;
    let why;
    if (!realMatches) why = `it now resolves to ${warpIdentityWords(fresh)}`;
    else if (!notALink) why = `its path is now ${warpIdentityWords(fresh)}`;
    else why = "the directory at that path is no longer the confirmed checkout (the path names a different directory)";
    return `refusing to close worktree for branch '${branch}': ${target} no longer resolves to the approved checkout ${JSON.stringify(expectedReal)} (${why}); the checkout and the registry were left untouched`;
  };
  if (expectedReal !== null) {
    const refusal = identityRefusal();
    if (refusal !== null) {
      return errorResult(refusal, { branch, path: target, force, removed: false });
    }
  }

  // S7/S8/S9: a live Pi session working in the target is a REFUSAL, and it is
  // decided BEFORE the approval question: the human is never asked to confirm a
  // removal the guard would refuse, and nothing (checkout, branch, registry) is
  // touched. This runs BEFORE the question so a blocked delete costs one read
  // instead of a dialog that cannot be honored.
  const sessionCheck = await checkoutSessionGuard({ ctx, target: resolvedTarget });
  if (sessionCheck.refused) {
    return errorResult(sessionCheck.text, {
      branch, path: target, force, removed: false, sessionCheck: sessionCheck.guard,
    });
  }

  // Approval when the host offers dialog UI; non-interactive modes
  // proceed without it. A refusal mutates nothing and keeps the entry.
  //
  // S61: the confirmation names the checkout's pending changes when it has
  // any (N files +N/-N read through lib/worktree-changes.js); a clean checkout
  // omits the dirty warning.
  //
  // gentle-shell YOLO waives this confirmation for a CLEAN checkout only: that
  // grant is standing human permission for ordinary work. A checkout with
  // pending changes is never waived, YOLO or not — the branch survives either
  // way and uncommitted work does not. Nothing here ever forces: force still
  // comes only from the caller's params.
  //
  // `opts.approved === true` means the CALLER already asked its own question
  // about exactly this checkout with its own disclosure — that is the warp
  // selector's keyboard delete, which never consults YOLO at all
  // (`warpDeleteCheckout`). It suppresses the second dialog only: every check
  // above and below, the live-session protections and the removal itself are
  // unchanged, and no tool can reach this flag because `worktree_close` calls
  // this function without options.
  const alreadyApproved = !!(opts && opts.approved === true);
  if (ctx && ctx.hasUI && !alreadyApproved) {
    const canAsk = ctx.ui && typeof ctx.ui.confirm === "function";
    let approved = false;
    if (canAsk) {
      let dirtyLine = '';
      // Only a positive "no pending changes" may waive anything: an unreadable
      // or failed summary counts as dirty and keeps asking.
      let dirty = true;
      try {
        const changesLib = libRequire('worktree-changes.js');
        const summary = await changesLib.summarizeChanges(target, { git });
        if (summary && summary.ok === true) {
          dirty = summary.files > 0;
          if (dirty) {
            dirtyLine = ` Pending changes: ${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}.`;
          }
        }
      } catch {
        dirty = true;
      }
      approved = !dirty && await yoloActiveFor(ctx);
      if (!approved) {
        try {
          approved = await ctx.ui.confirm(
            `Close worktree '${branch}'?`,
            `Remove the worktree checkout at ${target} for branch '${branch}'? The branch '${branch}' will be kept.`
              + (owner
                ? ` This checkout is owned by thread '${owner}'.`
                : " This checkout has no recorded owning thread.")
              + dirtyLine,
          );
        } catch {
          approved = false;
        }
      }
    }
    if (!approved) {
      return errorResult(
        `worktree close cancelled: approval declined for branch '${branch}'`,
        { cancelled: true, branch, path: target, force },
      );
    }
  }

  // The removal module is a required control, so a copy that cannot load fails
  // closed instead of falling back to a hand-rolled child.
  let closeLib;
  try {
    closeLib = libRequire("worktree-close-herdr.js");
  } catch (err) {
    return errorResult(
      `cannot remove the worktree at ${target}: the removal module is unavailable (${(err && err.message) || err}); the checkout and the registry were left untouched`,
      { branch, path: target, force, removed: false },
    );
  }

  // S7/S8/S9: rechecked immediately before the removal, after every
  // confirmation and after the awaits above. A session that appeared while the
  // human answered — or whose heartbeat became recent — refuses here, with the
  // checkout, the branch and the registry entry untouched.
  const sessionRecheck = await checkoutSessionGuard({ ctx, target: resolvedTarget });
  if (sessionRecheck.refused) {
    return errorResult(sessionRecheck.text, {
      branch, path: target, force, removed: false, sessionCheck: sessionRecheck.guard,
    });
  }

  // S6: git is the ONLY remover. The Herdr workspace reconcile (closing every
  // workspace of the checkout's group and opening one at the principal) and
  // `herdr worktree remove` are gone: a close never closes, opens or retires a
  // Herdr panel, and it never asks Herdr to remove the checkout. `git worktree
  // remove` runs with a fixed argv, the absolute verified path, and `--force`
  // only when the caller asked for it; the branch is never deleted and
  // --trust-repository is never passed.
  //
  // ORDER IS PART OF THE PROTECTION, not an implementation detail. The
  // active-session recheck just above is an await, and an await is the longest
  // window a swap gets between an identity check and a remover. So the recheck
  // resolves FIRST and the final identity check runs after it, with NO await
  // between that check and the spawn (lib/worktree-close-herdr.js spawns the
  // git child synchronously, before it returns its promise).
  //
  // LIMITATION, stated rather than papered over: `git worktree remove` takes a
  // path and resolves it in ANOTHER process, so the check and the removal
  // cannot be one atomic act — there is no handle-based removal available here
  // (no `openat`/`O_NOFOLLOW` "remove this exact directory") and the filesystem
  // offers no compare-and-swap. A swap landing between this check and the
  // remover's own `stat` is therefore not impossible. What is closed: every
  // await-sized window, plus any replacement of the path (a link, or a
  // different directory at the same path caught by the pinned inode), so an
  // attacker must win a race measured in microseconds inside another process
  // instead of one measured in an arbitrarily slow child.
  if (expectedReal !== null) {
    const refusal = identityRefusal();
    if (refusal !== null) {
      return errorResult(refusal, { branch, path: target, force, removed: false });
    }
  }

  const removal = await closeLib.removeCheckout({
    runAsync: (bin, argv, options) => git.runArgvAsync(bin, argv, options),
    repoRoot: repo.root,
    resolvedTarget,
    force,
  });
  const removedBy = removal.removed ? removal.removedBy : null;
  const removeError = removal.removed ? null : removal.error;
  if (!removedBy) {
    // The remover exited non-zero — but a lying backend may still have
    // deleted a checkout other than the target on its way out, so the
    // vanished comparison runs BEFORE this early return, never after it.
    // Either way the registry entry is kept; only the message differs.
    const vanishedOnFailure = await vanishedCheckouts(git, repo.root, live, resolvedTarget);
    if (vanishedOnFailure.length > 0) {
      return errorResult(
        `worktree removal failed (${removeError || "failed to remove worktree"}) and removed an unexpected checkout at ${vanishedOnFailure[0]}: expected only ${target} to be removed; the checkout and the registry entry were left for inspection`,
        { branch, path: target, force, removed: false, vanished: vanishedOnFailure },
      );
    }
    // The backend's own reason (e.g. git's dirty-checkout refusal) is the
    // whole message; checkout and registry entry are left untouched.
    return errorResult(removeError || "failed to remove worktree", {
      branch, path: target, force, removed: false,
    });
  }

  // Verify against git before dropping the entry: the path must be gone.
  // The check never depends on the post-removal listing alone: when the
  // listing itself fails, the existence fallback above still names a
  // vanished checkout (registry kept) instead of hiding it behind an
  // unverifiable-removal message. Covers both the herdr and git paths.
  let after;
  try {
    after = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    const vanishedWithoutList = await vanishedCheckouts(git, repo.root, live, resolvedTarget, null);
    if (vanishedWithoutList.length > 0) {
      return errorResult(
        `worktree removal removed an unexpected checkout at ${vanishedWithoutList[0]}: expected only ${target} to be removed; the checkout and the registry entry were left for inspection`,
        { branch, path: target, force, removedBy, vanished: vanishedWithoutList },
      );
    }
    return errorResult(
      `worktree removal could not be verified at ${target}: ${(err && err.message) || err}`,
      { branch, path: target, force, removedBy },
    );
  }
  // R4-2: the backend must not have removed anything but the target. A
  // hostile or confused remover that deleted another checkout fails
  // loudly here: the vanished path is named, the close is not treated as
  // successful, and the registry entry is left in place. Covers both the
  // herdr and the git removal paths; a legitimate single-checkout removal
  // (only the target gone) never trips it.
  const vanished = await vanishedCheckouts(git, repo.root, live, resolvedTarget, after);
  if (vanished.length > 0) {
    return errorResult(
      `worktree removal removed an unexpected checkout at ${vanished[0]}: expected only ${target} to be removed; the checkout and the registry entry were left for inspection`,
      { branch, path: target, force, removedBy, vanished },
    );
  }
  if (after.some((item) => {
    const st = checkoutState(item.path, repo.root);
    return st.absolute !== null && st.absolute === resolvedTarget;
  })) {
    return errorResult(
      `worktree removal could not be verified at ${target}: the checkout is still listed`,
      { branch, path: target, force, removedBy },
    );
  }
  let dropped;
  try {
    dropped = registry.removeWorktreeByPath(repo.root, resolvedTarget);
  } catch (err) {
    dropped = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!dropped.ok) {
    return errorResult(
      `worktree removed at ${target} but the registry entry could not be dropped: ${dropped.error}`,
      { branch, path: target, force, removed: true, branchKept: true },
    );
  }
  // The removed/branch-kept contract is byte-identical on every path that was
  // not refused.
  const successLines = [closeSuccessText(branch, true)];
  // S1: a worktree carries no issue and no ODD document, so the close output
  // names no association — no association line, no association warning and no
  // dropped-document list. Nothing is lost either way: the registry writes
  // every row the close does not address back byte for byte, so there is no
  // collapse left to report.
  const successDetails = {
    path: target, branch, removed: true, branchKept: true, thread: owner,
    sessionCheck: sessionRecheck.guard,
  };
  // S7/S8/S9: stale, unattributable and truncated presence evidence is
  // disclosed instead of silently ignored. `warnings` is the channel the
  // model-result formatter keeps verbatim, so each caveat reaches both the human
  // and the agent — and none of them ever blocks the removal.
  if (sessionRecheck.notices.length > 0) {
    successDetails.warnings = [...sessionRecheck.notices];
  }
  return textResult(
    successLines.join("\n"),
    successDetails,
    false,
  );
}

const worktreeListTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_list",
  label: "Worktree List",
  description: "List the principal checkout plus the agent worktrees registered for this repository, cross-checked against live checkouts with their owning thread. The principal leads, then the session's own checkout, then the rest. Pass all:true to also show live checkouts the registry does not know about. Rows whose paths no longer exist are excluded and pruned from the registry.",
  parameters: Type.Object({
    all: opt(Type.Boolean({ description: "Include live checkouts the registry does not know about" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeList(params, ctx);
  },
}));

const worktreeCloseTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_close",
  label: "Worktree Close",
  exposure: "codemode",
  description: "Remove a registered agent worktree checkout while keeping the branch. Pass the worktree name, path, or branch (only one), plus force:true to close a dirty checkout. A live Pi session working in that checkout — this session or another — refuses the close: warp to another checkout first, or let that session finish. The checkout is removed with git; no Herdr workspace is closed, opened or removed.",
  parameters: Type.Object({
    name: opt(Type.String({ description: "Name of the registered worktree to close (the flattened branch slug, or principal)" })),
    path: opt(Type.String({ description: "Path of the registered worktree to close" })),
    branch: opt(Type.String({ description: "Branch of the registered worktree to close" })),
    force: opt(Type.Boolean({ description: "Close even when the checkout is dirty" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeClose(params, ctx);
  },
}));

function warpForkSourceUsable(file) {
  try {
    if (typeof file !== "string" || file.length === 0) return false;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return false;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(4096, st.size));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      let first = null;
      for (const line of buf.toString("utf8", 0, read).split("\n")) {
        if (line.length > 0) {
          first = line;
          break;
        }
      }
      if (first === null) return false;
      if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1);
      const header = JSON.parse(first);
      return !!header && typeof header === "object" && header.type === "session";
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // A close failure never fails the validation.
      }
    }
  } catch {
    return false;
  }
}

// The test seam models the live runtime's view of a session file (a
// fake path the real filesystem never sees), so usability consults it
// too: disk proof first, then the seam's entries. Production passes no
// seam, so only the disk decides there. Never throws.
function warpSourceUsable(file, open) {
  if (warpForkSourceUsable(file)) return true;
  if (typeof open === "function") {
    try {
      const seen = open(file);
      if (Array.isArray(seen)) return true;
      if (seen && typeof seen === "object" && !Array.isArray(seen) && Array.isArray(seen.entries)) return true;
    } catch {
      // An unreadable seam entry is not usable.
    }
  }
  return false;
}

// Fork-source availability of a session about to be CARRIED into another
// checkout: a usable persisted session file (validated above, never a bare
// nonempty string) or in-memory entries the carry path can clone.
//
// S7: no flow calls this any more. It guarded the CREATE flow, which ended in a
// warp and therefore needed a fork source; creation no longer warps, so the
// guard went with that step. It stays exported so tests keep pinning the
// refusal it produced, while every real fork is validated where a warp actually
// forks (`warpForkSourceUsable` / `warpSourceUsable`, above, in the carry path).
function warpCreatePreflight(ctx) {
  const sm = ctx && ctx.sessionManager;
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const file = sm && typeof sm.getSessionFile === "function" ? safe(() => sm.getSessionFile()) : undefined;
  if (typeof file === "string" && file.length > 0 && warpForkSourceUsable(file)) return { ok: true };
  const entries = sm && typeof sm.getEntries === "function" ? safe(() => sm.getEntries()) : undefined;
  const carried = Array.isArray(entries) ? entries : [];
  if (carried.length === 0) {
    return { ok: false, reason: "warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry" };
  }
  return { ok: true };
}

// S61 tool-side handling of the `changes` option: it VALIDATES the selection and
// nothing more. The copy itself belongs to the command (see
// `warpHandoffCopyChanges`), because the tool only QUEUES the move — a copy made
// here would land in a checkout the command can still refuse, and the retry the
// refusal asks for would then fail on its own stranded copy.
// Resolves to {isError:false, selection} or {isError:true, result} with nothing
// queued. Never throws.
function warpToolChangesSelection(params) {
  let raw;
  try {
    raw = params ? params.changes : undefined;
  } catch {
    raw = undefined;
  }
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch (err) {
    return { isError: false, selection: { mode: 'none', paths: [] } };
  }
  let normalized;
  try {
    normalized = changesLib.normalizeChangesSelection(raw);
  } catch (err) {
    return {
      isError: true,
      result: errorResult(`worktree warp: ${(err && err.message) || err}`, { tool: 'worktree_warp' }),
    };
  }
  if (!normalized.ok) {
    return { isError: true, result: errorResult(`worktree warp: ${normalized.error}`, { tool: 'worktree_warp' }) };
  }
  return { isError: false, selection: { mode: normalized.mode, paths: normalized.paths.slice() } };
}

// The handoff's change selection, applied at MOVE time by the command: after
// every refusal check above and before the switch. A handoff refused before this
// point mutates NOTHING, and the copy that does run never mutates the source or
// either index (lib/worktree-changes.js): an unknown file, a destination overlap
// or a drifted snapshot rejects with zero destination mutation. Never throws.
async function warpHandoffCopyChanges({ git, fromCheckout, targetCwd, changes }) {
  if (!changes || changes.mode === 'none') return { ok: true, copied: null };
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch (err) {
    return { ok: true, copied: null };
  }
  let copied;
  try {
    copied = await changesLib.copyChanges(
      { from: fromCheckout, to: targetCwd, selectMode: changes.mode, selection: changes.paths },
      { git },
    );
  } catch (err) {
    // A THROWN copy is not evidence that nothing was written: the failure may
    // have struck after a write landed. The report therefore claims only what is
    // certainly true — the session stays where it is — and sends the human to
    // the destination before retrying.
    return { error: `cannot copy changes: ${(err && err.message) || err} (the session stays where it is; inspect the destination before retrying)` };
  }
  if (!copied || copied.ok !== true) {
    return { error: (copied && copied.error) || 'cannot copy changes' };
  }
  return { ok: true, copied };
}

// The tool's selection preflight: a selection naming a file that is NOT pending
// must refuse BEFORE the handoff is queued, because the command can only refuse
// it — a queued request the command always rejects is the same false success the
// token cap had. Read-only: the shared summary and matcher decide, nothing is
// written. Destination state is deliberately NOT checked here: an overlap may be
// this handoff's own earlier copy, which the command proves byte for byte and
// skips at move time. Never throws.
async function warpHandoffSelectionCheck({ git, fromCheckout, changes }) {
  if (!changes || changes.mode === 'none') return { ok: true };
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch (err) {
    return { ok: true };
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(fromCheckout, { git });
  } catch (err) {
    return { ok: false, error: `cannot read the pending changes: ${(err && err.message) || err} (nothing was queued)` };
  }
  if (!summary || summary.ok !== true) {
    return { ok: false, error: `${(summary && summary.error) || 'cannot read the pending changes'} (nothing was queued)` };
  }
  let matched;
  try {
    matched = changesLib.matchSelection(summary, changes.mode, changes.paths);
  } catch (err) {
    return { ok: false, error: `cannot match the changes selection: ${(err && err.message) || err} (nothing was queued)` };
  }
  if (!matched || matched.ok !== true) {
    return { ok: false, error: `${(matched && matched.error) || 'cannot match the changes selection'}; nothing was queued` };
  }
  return { ok: true };
}

// One side of the proof: what this process can actually observe at a path.
// 'missing' is ENOENT and NOTHING else — a permission error, an I/O error, a
// symlink or any non-regular file reads as 'failed', because a failed read is not
// evidence of absence (treating it as "absent on both sides" is exactly how an
// unreadable selected file was once passed off as an already-applied copy).
// Never throws.
function warpProofRead(file) {
  try {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      return err && err.code === 'ENOENT' ? { state: 'missing' } : { state: 'failed' };
    }
    // A symlink is not provable: the copy materializes the referent's BYTES as a
    // regular file, so "equal content" says nothing about the resulting file
    // type. Any other non-regular file (fifo, socket, device, directory) has no
    // byte content a copy could reproduce either.
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'failed' };
    try {
      return { state: 'bytes', bytes: fs.readFileSync(file) };
    } catch {
      return { state: 'failed' };
    }
  } catch {
    return { state: 'failed' };
  }
}

// Byte-identity proof for a retry whose copy an EARLIER attempt already left in
// the destination (the move failed after the copy). Proven only when EVERY
// selected path holds the same content on both sides — identical bytes on both,
// or a TRACKED DELETION already applied (ENOENT on both) — because that is
// exactly the post-copy state: skipping the copy can then neither lose nor change
// anything, and nothing is written at all. The source, the destination's other
// edits and both indexes are left untouched, and no file is deleted or reverted.
// Anything unreadable (any non-ENOENT failure), non-regular, escaping or
// different reads as NOT proved, so the caller fails closed instead of guessing.
// Never throws.
async function warpHandoffCopyAlreadyApplied({ git, fromCheckout, targetCwd, changes }) {
  const notProved = { ok: false, applied: false, identical: [], differing: [], unreadable: [] };
  try {
    if (!changes || changes.mode === 'none') return notProved;
    if (typeof fromCheckout !== 'string' || fromCheckout.length === 0) return notProved;
    let changesLib = null;
    try {
      changesLib = libRequire('worktree-changes.js');
    } catch (err) {
      return notProved;
    }
    const summary = await changesLib.summarizeChanges(fromCheckout, { git });
    if (!summary || summary.ok !== true) return notProved;
    const matched = changesLib.matchSelection(summary, changes.mode, changes.paths);
    if (!matched || matched.ok !== true || matched.entries.length === 0) return notProved;
    const identical = [];
    const differing = [];
    const unreadable = [];
    for (const entry of matched.entries) {
      const destPath = path.resolve(targetCwd, entry.rel);
      if (!changesLib.isInsideOrEqual(targetCwd, destPath)
        || !changesLib.isInsideOrEqual(fromCheckout, entry.path)) {
        // A path escaping either checkout proves nothing.
        unreadable.push(entry.rel);
        continue;
      }
      const source = warpProofRead(entry.path);
      const dest = warpProofRead(destPath);
      if (source.state === 'failed' || dest.state === 'failed') {
        unreadable.push(entry.rel);
      } else if (source.state === 'missing' && dest.state === 'missing') {
        // Absent on both sides is a deletion already applied — but only a TRACKED
        // deletion travels as a patch. An UNTRACKED entry with no source file is
        // unreadable evidence (the shared helper calls it "the source file is
        // unreadable"), never a proven copy.
        if (entry.untracked === true) unreadable.push(entry.rel);
        else identical.push(entry.rel);
      } else if (source.state === 'bytes' && dest.state === 'bytes') {
        if (Buffer.compare(source.bytes, dest.bytes) === 0) identical.push(entry.rel);
        else differing.push(entry.rel);
      } else {
        // Present on one side only: the copy would still have work to do.
        differing.push(entry.rel);
      }
    }
    return {
      ok: true,
      applied: differing.length === 0 && unreadable.length === 0 && identical.length > 0,
      identical, differing, unreadable,
    };
  } catch {
    return notProved;
  }
}

// How many copied files a report names before it summarizes the rest. A large
// selection must never turn a failure message into a wall of paths.
const WARP_COPY_REPORT_MAX_FILES = 12;

// The `N files: a, b (+M more)` cell every copy report uses. Never throws.
function warpCopyFilesSummary(files) {
  const list = Array.isArray(files) ? files.filter((entry) => typeof entry === 'string') : [];
  const count = list.length;
  const shown = list.slice(0, WARP_COPY_REPORT_MAX_FILES);
  const more = count - shown.length;
  const detail = shown.length === 0 ? '' : `: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  return { count, line: `${count} file${count === 1 ? '' : 's'}${detail}` };
}
// ---------------------------------------------------------------------------
// The warp handoff (`worktree_warp` -> `/warp`).
//
// The host keeps session control on the extension COMMAND context: a tool's
// context carries no `switchSession`, and awaiting `waitForIdle` from inside a
// tool is a self-deadlock (the tool runs inside the turn it would wait for).
// Tools therefore cannot move the session themselves. The one supported route
// is the host's own documented one for this case (see the installed
// `examples/extensions/reload-runtime.ts`): queue the extension COMMAND that
// owns the privileged action with `pi.sendUserMessage(text, {
// expandPromptTemplates: true })`. That dispatches the command immediately —
// even while the tool is still running — with a command context bound to the
// session, and its handler waits for idle before it touches the session, so
// the switch lands after the current turn settles.
//
// The request travels as ONE `@<token>` argument: base64url of a small JSON
// object. The charset is [A-Za-z0-9_-], so a checkout name or path can never
// inject a second argument, a newline, a control character, a second command
// or a shell word — the token is the ONLY thing the command parses. What it
// carries is checkout identity (name, target, source, branch) and the change
// selection; never file contents, environment or credentials. The token is also
// length-bounded, and that bound is enforced on the way OUT as well as in (see
// `prepareWarpHandoff`): a token over the cap was previously queued and then
// always rejected by the command, which reported a move that could never happen.
const WARP_HANDOFF_VERSION = 1;
const WARP_HANDOFF_PREFIX = '@';
const WARP_HANDOFF_MAX_TOKEN = 2048;
const WARP_HANDOFF_MAX_NAME = 200;

// The host API captured at load: `sendUserMessage` is the only supported way
// for a tool to reach a command context. Null until the extension loads.
let warpHandoffPi = null;

// The ONE token contract, shared by the encode and the decode side: a non-empty
// base64url spelling within the length cap. Anything else is refused, and never
// echoed back.
function warpHandoffTokenAccepted(token) {
  return typeof token === 'string'
    && token.length > 0
    && token.length <= WARP_HANDOFF_MAX_TOKEN
    && /^[A-Za-z0-9_-]+$/.test(token);
}

// The change selection as it travels in the token: absent for "copy nothing",
// `{mode: "all"}` for everything, `{mode: "paths", paths: [...]}` for a list.
// The copy is applied by the command at move time, so the selection must travel
// WITH the request instead of being acted on before it is queued. Null means the
// value is not one of those three shapes. Never throws.
function warpHandoffChangesPayload(changes) {
  try {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return undefined;
    if (changes.mode === 'none') return undefined;
    if (changes.mode === 'all') return { mode: 'all' };
    if (changes.mode === 'paths' && Array.isArray(changes.paths) && changes.paths.length > 0) {
      const paths = changes.paths.map((entry) => String(entry));
      if (paths.some((entry) => entry.trim().length === 0)) return null;
      return { mode: 'paths', paths };
    }
    return null;
  } catch {
    return null;
  }
}

// Normalize a decoded/injected `changes` value into the internal shape. Null
// means an unusable shape; `undefined`/absent means "copy nothing". Never throws.
function normalizeHandoffChanges(value) {
  try {
    if (value === undefined || value === null) return { mode: 'none', paths: [] };
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.mode === 'none') return { mode: 'none', paths: [] };
    if (value.mode === 'all') return { mode: 'all', paths: [] };
    if (value.mode === 'paths') {
      if (!Array.isArray(value.paths) || value.paths.length === 0) return null;
      const paths = value.paths;
      if (!paths.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) return null;
      return { mode: 'paths', paths: paths.slice() };
    }
    return null;
  } catch {
    return null;
  }
}

// Encode a handoff request as the single command argument. The token is bounded
// on the way OUT here (length cap and charset), so an oversized or
// unrepresentable request is refused before anything is queued — the defect this
// closes was a cap enforced only on decode, which let the tool queue a token the
// command always rejected. Returns {ok:true, token} or {ok:false, error}; the
// error names the limit but never the rejected value or the produced token.
// Never throws.
function encodeWarpHandoff(request) {
  let token;
  try {
    const payload = {
      v: WARP_HANDOFF_VERSION,
      name: String(request && request.name !== undefined ? request.name : ''),
      target: String(request && request.target !== undefined ? request.target : ''),
      from: String(request && request.from !== undefined ? request.from : ''),
      branch: String(request && request.branch !== undefined ? request.branch : ''),
    };
    const changes = warpHandoffChangesPayload(request && request.changes);
    if (changes === null) {
      return { ok: false, error: 'the warp handoff could not be encoded: the change selection is not "all" or a list of files' };
    }
    if (changes !== undefined) payload.changes = changes;
    token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  } catch {
    return { ok: false, error: 'the warp handoff could not be encoded' };
  }
  if (token.length === 0) {
    return { ok: false, error: 'the warp handoff could not be encoded' };
  }
  if (!warpHandoffTokenAccepted(token)) {
    return {
      ok: false,
      error: `the warp handoff is too large to queue: ${token.length} characters exceeds the ${WARP_HANDOFF_MAX_TOKEN}-character handoff limit; select fewer files in changes, or pass "all", and warp again`,
    };
  }
  return { ok: true, token: `${WARP_HANDOFF_PREFIX}${token}` };
}

// Prepare (encode, bound, and PROVE the command will accept) one handoff
// request. This is the tool's preflight: it runs before the handoff is queued at
// all, so a token the command could never decode refuses here with nothing
// queued, nothing copied and nothing claimed. Returns {ok:true, token, request}
// or {ok:false, error}. Never throws.
function prepareWarpHandoff(request) {
  const encoded = encodeWarpHandoff(request);
  if (!encoded.ok) return encoded;
  // Round-trip through the command's own decoder: the tool may only claim
  // "handoff queued" for a token the command will actually accept.
  const decoded = decodeWarpHandoff(encoded.token);
  if (!decoded.ok) {
    return { ok: false, error: 'the warp handoff could not be verified; nothing was queued' };
  }
  return { ok: true, token: encoded.token, request: decoded.request };
}

// Decode and validate one `@<token>` argument. Strict on purpose: the token is
// the only input this path trusts, so every field is re-checked here (shape,
// version, absolute paths, bounded name, a legal change selection) and any doubt
// reads as a refusal with no echo of the rejected value. Returns {ok:true,
// request} or {ok:false, error}. Never throws.
function decodeWarpHandoff(raw) {
  try {
    if (typeof raw !== 'string' || !raw.startsWith(WARP_HANDOFF_PREFIX)) {
      return { ok: false, error: 'invalid warp handoff' };
    }
    const token = raw.slice(WARP_HANDOFF_PREFIX.length);
    if (!warpHandoffTokenAccepted(token)) {
      return { ok: false, error: 'invalid warp handoff' };
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, error: 'invalid warp handoff' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== WARP_HANDOFF_VERSION) {
      return { ok: false, error: 'invalid warp handoff' };
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const target = typeof payload.target === 'string' ? payload.target : '';
    const from = typeof payload.from === 'string' ? payload.from : '';
    const branch = typeof payload.branch === 'string' ? payload.branch : '';
    if (name.length === 0 || name.length > WARP_HANDOFF_MAX_NAME) {
      return { ok: false, error: 'invalid warp handoff' };
    }
    if (!path.isAbsolute(target) || !path.isAbsolute(from)) {
      return { ok: false, error: 'invalid warp handoff' };
    }
    const changes = normalizeHandoffChanges(payload.changes);
    if (changes === null) {
      return { ok: false, error: 'invalid warp handoff' };
    }
    return { ok: true, request: { name, target, from, branch, changes } };
  } catch {
    return { ok: false, error: 'invalid warp handoff' };
  }
}

// Dispatch the move to the one verb that can perform it. `pi.sendUserMessage`
// returns void by contract (the host runs the command asynchronously), so this
// can only report that the handoff was QUEUED — never that the session moved.
// It dispatches a PREPARED handoff (`prepareWarpHandoff`), so a token the command
// would reject can never leave this function claiming success. A host without
// the route, or one that throws synchronously, refuses here with nothing
// dispatched. Never throws.
function dispatchWarpHandoff(prepared) {
  const pi = warpHandoffPi;
  if (!pi || typeof pi.sendUserMessage !== 'function') {
    return { ok: false, error: 'the host cannot dispatch the warp command here' };
  }
  if (!prepared || prepared.ok !== true || typeof prepared.token !== 'string' || prepared.token.length === 0) {
    return { ok: false, error: (prepared && prepared.error) || 'the warp handoff could not be encoded' };
  }
  try {
    pi.sendUserMessage(`/warp ${prepared.token}`, { expandPromptTemplates: true });
  } catch (err) {
    return { ok: false, error: `the warp handoff could not be queued: ${(err && err.message) || err}` };
  }
  return { ok: true };
}

// Normalize the handoff a command invocation carries (already decoded by
// decodeWarpHandoff; re-read defensively so a direct caller cannot smuggle a
// different shape). Null means an ordinary, name-resolved warp. Never throws.
function normalizeWarpHandoff(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const target = typeof value.target === 'string' ? value.target : '';
    const from = typeof value.from === 'string' ? value.from : '';
    if (name.length === 0 || name.length > WARP_HANDOFF_MAX_NAME) return null;
    if (!path.isAbsolute(target) || !path.isAbsolute(from)) return null;
    const changes = normalizeHandoffChanges(value.changes);
    if (changes === null) return null;
    return {
      name,
      target,
      from,
      branch: typeof value.branch === 'string' ? value.branch : '',
      changes,
    };
  } catch {
    return null;
  }
}

async function executeWorktreeWarpTool(params, ctx, opts) {
  const options = opts || {};  // A tool never switches the session: it queues the handoff to the command
  // that can (see `dispatchWarpHandoff`). A host with no route refuses before
  // any read, so nothing is resolved, copied or claimed.
  if (!warpHandoffPi || typeof warpHandoffPi.sendUserMessage !== "function") {
    return errorResult(
      "worktree warp is unavailable here: the host cannot dispatch the warp command",
      { tool: "worktree_warp" },
    );
  }
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const warpSessions = libRequire("worktree-warp-sessions.js");
  const raw = params && typeof params.name === "string" ? params.name.trim() : "";
  const fromCwd = toolCwd(ctx);
  // S21: the warp is interactive too, so its preflight reads are awaited.
  const runAsync = libRunner(git);
  let repo;
  try {
    repo = await git.repoIdentityAsync(fromCwd, { runAsync });
  } catch (err) {
    return errorResult(notGitRepositoryLine(fromCwd), { tool: "worktree_warp" });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(`worktree warp: cannot read worktree registry: ${read.error}`, { tool: "worktree_warp" });
  }
  let live;
  try {
    live = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(`worktree warp: cannot list worktrees: ${(err && err.message) || err}`, { tool: "worktree_warp" });
  }
  noteWarpDiscovery(repo.root, live);
  const principal = principalForName(git, repo.root, repo, live);
  // The refusal listing: every live selectable checkout as `<name> — <path>`,
  // so the agent can pick without a human.
  const availableCheckouts = () => {
    try {
      const offered = warpOfferedCheckouts(git, read, principal, live, repo.root);
      const listed = offered.map((entry) => `${entry.name} — ${entry.path}`);
      return listed.length > 0 ? listed.join(", ") : "(none)";
    } catch {
      return "(none)";
    }
  };
  if (raw === "") {
    return errorResult(
      `worktree_warp needs a name: pass the worktree name or path; available checkouts: ${availableCheckouts()}`,
      { tool: "worktree_warp" },
    );
  }
  // Name first, then path — one candidate; unknown, foreign or ambiguous
  // fails closed with the listing, exactly like the command's resolver plus
  // the shared path leg.
  let resolved = resolveCheckoutByName(raw, git, read, principal, live, repo.root, { allowUnregistered: true });
  if (!resolved.ok) {
    const pathEntry = resolveClosePathEntry(raw, git, read, live, repo.root);
    if (pathEntry) {
      const entrySlug = slugOf(git, pathEntry.branch);
      resolved = {
        ok: true, kind: "agent", name: entrySlug !== null ? entrySlug : raw,
        path: pathEntry.path, branch: pathEntry.branch, entry: pathEntry,
      };
    } else {
      // A live checkout of this repository reached by path — including one
      // the registry does not own (the warp's lone-unregistered rule) — is
      // not foreign; anything else keeps the name refusal with the listing.
      let byPath = null;
      try {
        const st = checkoutState(raw, repo.root);
        const id = st.real !== null ? st.real : st.absolute;
        if (st.absolute !== null && st.exists && st.isDirectory && id !== null && liveIdentities(live, repo.root).has(id)) {
          let isPrincipal = false;
          try {
            if (principal && typeof principal.path === "string" && principal.path.length > 0) {
              const pst = checkoutState(principal.path, repo.root);
              const pid = pst.real !== null ? pst.real : pst.absolute;
              isPrincipal = pid !== null && pid === id;
            }
          } catch {
            isPrincipal = false;
          }
          if (isPrincipal) {
            byPath = { ok: true, kind: "principal", name: "principal", path: principal.path, branch: principal.branch, entry: null };
          } else {
            let liveBranch = null;
            for (const entry of live) {
              if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
              const est = checkoutState(entry.path, repo.root);
              const eid = est.real !== null ? est.real : est.absolute;
              if (eid !== null && eid === id && typeof entry.branch === "string" && entry.branch.length > 0) { liveBranch = entry.branch; break; }
            }
            const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
            const claimants = rows.filter((row) => {
              try {
                if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) return false;
                const rst = checkoutState(row.path, repo.root);
                const rid = rst.real !== null ? rst.real : rst.absolute;
                return rid !== null && rid === id;
              } catch {
                return false;
              }
            });
            if (claimants.length <= 1) {
              const branch = liveBranch || (claimants.length === 1 ? claimants[0].branch : null);
              if (typeof branch === "string" && branch.length > 0) {
                const slug = slugOf(git, branch);
                byPath = {
                  ok: true, kind: claimants.length === 1 ? "agent" : "unregistered",
                  name: slug !== null ? slug : raw, path: id, branch,
                  entry: claimants.length === 1 ? claimants[0] : null,
                };
              }
            }
          }
        }
      } catch {
        byPath = null;
      }
      if (byPath) {
        resolved = byPath;
      } else {
        return errorResult(
          `worktree warp: ${resolved.error}; available checkouts: ${availableCheckouts()}`,
          { tool: "worktree_warp", name: raw, candidates: resolved.candidates },
        );
      }
    }
  }
  // S39 fail-closed: the target must exist as a directory AND still be a
  // checkout of this repository in git's listing — no fork, no notice, no
  // record write when it is missing or foreign.
  const targetState = checkoutState(resolved.path, repo.root);
  const targetCwd = targetState.real !== null ? targetState.real
    : targetState.absolute !== null ? targetState.absolute
    : path.resolve(resolved.path);
  if (!targetState.exists || !targetState.isDirectory || !liveIdentities(live, repo.root).has(targetCwd)) {
    return errorResult(
      `worktree warp: no live checkout for "${raw}" at ${targetCwd}: the path is missing or is not a checkout of this repository; available checkouts: ${availableCheckouts()}`,
      { tool: "worktree_warp", name: raw },
    );
  }
  // S39 current branch: the registry row keeps the branch recorded at
  // creation time, so the warp shows the checkout's CURRENT branch from git.
  const liveBranch = (registryClaimCounts(read.worktrees, repo.root).get(targetCwd) || 0) <= 1
    ? warpLiveBranchFor(targetCwd, live, repo.root)
    : null;
  let displayName = resolved.name;
  let displayBranch = resolved.branch;
  if (typeof liveBranch === "string" && liveBranch.length > 0) {
    displayBranch = liveBranch;
    if (resolved.kind !== "principal") {
      const liveSlug = slugOf(git, liveBranch);
      if (liveSlug !== null) displayName = liveSlug;
    }
  }
  // Already there: the deepest live checkout containing the session, the
  // rule the listing already uses. No fork, no switch, no message.
  const sessionId = warpSessionIdentity(fromCwd, repo.root);
  const sessionCheckout = warpDeepestContaining(sessionId, [targetCwd, ...warpLiveIdentities(live, repo.root)]);
  if (sessionCheckout !== null && sessionCheckout === targetCwd) {
    return textResult(
      `worktree warp: ${raw} (already there)`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: true, cancelled: false },
      false,
    );
  }
  // S61: the tool's `changes` option (named changes, never copy):
  // omitted/empty [] or "" copies nothing, "all" copies every pending
  // change, a list of files copies only those. The selection is VALIDATED here
  // and carried in the handoff token; the copy itself runs inside the command,
  // at move time, after its refusal checks (see `warpHandoffCopyChanges`) — a
  // copy made here would land in a checkout the command can still refuse, and
  // the retry would then fail on its own stranded copy. No human selector in
  // the tool: the selection copies working-tree changes only (the source is
  // retained, the destination index preserved) through the same
  // lib/worktree-changes.js transfer the command uses.
  const toolChangesGate = warpToolChangesSelection(params);
  if (toolChangesGate && toolChangesGate.isError) return toolChangesGate.result;
  const toolChanges = toolChangesGate && toolChangesGate.selection
    ? toolChangesGate.selection
    : { mode: "none", paths: [] };
  // A selection that names no pending file is refused HERE: the command could
  // only refuse it later, and queueing a request that is already known to fail
  // is the same false "handoff queued" the token cap produced.
  const toolSelectionCheck = await warpHandoffSelectionCheck({
    git, fromCheckout: sessionCheckout || fromCwd, changes: toolChanges,
  });
  if (toolSelectionCheck && toolSelectionCheck.ok !== true) {
    return errorResult(`worktree warp: ${toolSelectionCheck.error}`, { tool: "worktree_warp" });
  }
  // The host keeps session control on the COMMAND context, so this tool never
  // moves the session itself: it resolves and validates the request and then
  // HANDS THE MOVE to the one verb that can perform it
  // (`/warp`, see `dispatchWarpHandoff`). The switch therefore
  // happens only AFTER this turn settles — the command handler waits for idle
  // first — so no message, tool result or pending change is torn mid-turn.
  //
  // The handoff is PREPARED before it is queued: the token is encoded, bounded
  // and round-tripped through the command's own decoder, so "handoff queued" is
  // only ever claimed for a request the command will accept. A refusal here
  // queues nothing and touches no checkout.
  //
  // What this tool may claim: the handoff is QUEUED, never completed. The
  // first line says so, and the details carry no completed-move row (no
  // `fromName`/`name`/`path`/`branch`), so the card falls back to that line
  // instead of painting a move that has not happened. The one visible "moved"
  // card comes from the switched-to session once the move is real.
  const handoffDispatched = dispatchWarpHandoff(prepareWarpHandoff({
    name: displayName,
    target: targetCwd,
    from: fromCwd,
    branch: displayBranch,
    changes: toolChanges,
  }));
  if (!handoffDispatched.ok) {
    return errorResult(
      `worktree warp: ${handoffDispatched.error}`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  const changesNote = toolChanges.mode === "all"
    ? "\nchanges: all (copied when the move lands)"
    : toolChanges.mode === "paths"
      ? `\nchanges: ${toolChanges.paths.length} file${toolChanges.paths.length === 1 ? "" : "s"} (copied when the move lands)`
      : "";
  const pendingText =
    `worktree warp: handoff queued — the session moves when this turn ends\n` +
    `to: ${warpClean(displayName, "worktree")}\n` +
    `path: ${warpClean(targetCwd, "(unknown checkout)")}\n` +
    `branch: ${warpClean(displayBranch, "(detached)")}${changesNote}`;
  return textResult(
    pendingText,
    {
      tool: "worktree_warp", handoff: true, pending: true,
      pendingName: displayName, pendingPath: targetCwd, pendingBranch: displayBranch,
      from: fromCwd, target: targetCwd, kind: resolved.kind,
    },
    false,
  );
}

const worktreeWarpTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_warp",
  label: "Worktree Warp",
  description: "Move this session to another checkout of the project and continue the task there: pass the worktree name or path (no selector). Resumes the checkout's session when it holds the same content, otherwise forks one, then continues working in the new checkout.",
  parameters: Type.Object({
    name: Type.String({ description: "Name of the checkout to move to (the flattened branch slug, or principal), or its path" }),
    changes: opt(unionSchema([Type.String(), Type.Array(Type.String())], { description: "Pending changes to copy into the destination checkout: omit or pass \"\" or [] for no copy, \"all\" for everything, or a list of files for selected changes only" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeWarpTool(params, ctx);
  },
}));

// ---------------------------------------------------------------------------
// Session auto-naming from ODD writes (S1 as narrowed by D7).
//
// The extension observes the Pi tool pipeline for the `read`, `edit` and
// `write` tools. For each call it decides whether the touched path is a
// `.md` document inside the principal checkout's `odd/` directory and, when it
// is, names THIS session after the document that was written (see
// lib/session-auto-name.js). The worktree of the agent's context — resolved
// from the invoking context's working directory and matched against the
// registry entries, never from the file path identity, because `odd/` is a
// symlink into the principal checkout — only supplies the branch suffix of
// that name.
//
// It writes NOTHING to the registry. S1 removed the issue/ODD association from
// every worktree, so this hook records no association, neither from a touched
// path nor from a scan of the worktree's `odd/` directory: a worktree carries
// no document. What stays is the session name, which is a property of the
// session and not of the worktree.
//
// The hook never throws and never blocks the pipeline: any failure (unreadable
// registry, unknown context, a host without the session-name accessors) is
// swallowed, and the handler returns nothing.
// ---------------------------------------------------------------------------

// Only these three tools carry a single document path worth reading for the
// session name.
const ODD_NAMING_TOOLS = new Set(["read", "edit", "write"]);

function oddToolNameOf(event) {
  if (!event || typeof event !== "object") return undefined;
  const name = event.toolName ?? event.tool ?? event.name;
  return typeof name === "string" ? name : undefined;
}

function oddArgsOf(event) {
  if (!event || typeof event !== "object") return undefined;
  return event.args ?? event.input ?? event.params ?? event.arguments;
}

// Path arguments across the tool_call / tool_result shapes: the file tools
// carry the document under `path` (accepted aliases cover older shapes).
function oddTouchedPaths(args) {
  const out = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };
  if (typeof args === "string") {
    push(args);
    return out;
  }
  if (!args || typeof args !== "object") return out;
  const direct = args.path ?? args.file ?? args.filePath ?? args.filename ?? args.target;
  if (Array.isArray(direct)) direct.forEach(push);
  else push(direct);
  const plural = args.paths ?? args.files;
  if (Array.isArray(plural)) plural.forEach(push);
  return out;
}

function oddEventCwd(event, ctx) {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
  if (event && typeof event.cwd === "string" && event.cwd.length > 0) return event.cwd;
  return process.cwd();
}

// The registry entry owning `cwd`: the entry whose worktree root is `cwd`
// itself or its longest enclosing prefix. Anything else — the principal
// checkout, an unregistered directory — yields null and captures nothing.
function oddEntryForCwd(worktrees, cwd) {
  const resolved = path.resolve(cwd);
  let best = null;
  let bestLen = -1;
  for (const entry of worktrees) {
    // Relative registry paths never participate: resolving one against
    // the process cwd would attribute the call to the wrong worktree.
    if (!entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path)) continue;
    let candidate;
    try {
      candidate = path.resolve(entry.path);
    } catch {
      continue;
    }
    if (resolved !== candidate && !resolved.startsWith(candidate + path.sep)) continue;
    if (candidate.length > bestLen) {
      best = entry;
      bestLen = candidate.length;
    }
  }
  return best;
}

// Best-effort real path: the file itself when it exists (resolving the
// worktree `odd/` symlink into the principal checkout), else its parent
// directory plus the basename (covers `write` of a not-yet-created doc),
// else the lexical path.
function oddRealPath(absPath) {
  try {
    return fs.realpathSync(absPath);
  } catch {
    // The file may not exist yet; resolve through its parent instead.
  }
  try {
    return path.join(fs.realpathSync(path.dirname(absPath)), path.basename(absPath));
  } catch {
    return absPath;
  }
}

// `odd/<rel>` for a touched absolute path, or null when the path is not a
// `.md` document inside either the worktree's own `odd/` (lexical, through
// the symlink) or the principal checkout's `odd/` (real path). The returned
// rel is always relative to the shared `odd/` root so every worktree
// records the same document under the same name.
function oddRelFor(absPath, worktreePath, principalRoot) {
  if (typeof absPath !== "string" || absPath.length === 0) return null;
  const lexical = path.resolve(absPath);
  if (!lexical.endsWith(".md")) return null;
  const candidates = [lexical, path.resolve(oddRealPath(lexical))];
  const oddRoots = [path.join(worktreePath, "odd"), path.join(principalRoot, "odd")];
  const bases = [];
  for (const base of oddRoots) {
    bases.push(path.resolve(base));
    try {
      bases.push(path.resolve(fs.realpathSync(base)));
    } catch {
      // An absent `odd/` simply contributes no real base.
    }
  }
  for (const candidate of candidates) {
    for (const base of bases) {
      if (candidate === base) continue;
      if (!candidate.startsWith(base + path.sep)) continue;
      const rel = path.relative(base, candidate).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      return `odd/${rel}`;
    }
  }
  return null;
}

// Bounded (`.md` only) listing of the worktree's own `odd/` directory,
// relative to it (`tasks/plan.md`). Never throws: any unreadable directory
// contributes nothing.
// Hot path: `repoIdentity` spawns two git children (~17ms here) and the ODD
// naming hook runs on EVERY tool_call and tool_result. A session's cwd resolves to
// the same root/common dir for its whole life, so the answer is memoized per
// cwd instead of respawned twice per tool call. Bounded LRU: a long session
// visiting many checkouts keeps the most recent ones, never unbounded state.
const REPO_IDENTITY_CACHE_LIMIT = 32;
const repoIdentityCache = new Map();

function cachedRepoIdentity(git, cwd) {
  const key = String(cwd);
  const hit = repoIdentityCache.get(key);
  if (hit !== undefined) {
    // Refresh recency so the checkout in use is never the one evicted.
    repoIdentityCache.delete(key);
    repoIdentityCache.set(key, hit);
    return hit;
  }
  const value = git.repoIdentity(key);
  repoIdentityCache.set(key, value);
  if (repoIdentityCache.size > REPO_IDENTITY_CACHE_LIMIT) {
    repoIdentityCache.delete(repoIdentityCache.keys().next().value);
  }
  return value;
}

// The pipeline hook proper (M1): every event is observed. Whether a session is
// renamed at all is decided in lib/session-auto-name.js.
function observeOddWriteForNaming(event, ctx, pi, allowPhaseTrigger) {
  const cwd = oddEventCwd(event, ctx);
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  let repo;
  try {
    repo = cachedRepoIdentity(git, cwd);
  } catch {
    return; // Unknown context: not a repository, nothing to name.
  }
  const principalRoot = path.basename(repo.commonDir) === ".git"
    ? path.dirname(repo.commonDir)
    : repo.root;
  // The registry row supplies the branch suffix of the session name and
  // nothing else: this hook never writes it (S1 — a worktree carries no
  // issue and no ODD document, so nothing is associated here).
  const read = registry.readRegistry(repo.root);
  if (!read || read.ok !== true || !Array.isArray(read.worktrees)) return;
  const entry = oddEntryForCwd(read.worktrees, cwd);
  if (!entry) return; // The principal checkout names nothing (D6).
  const touched = [];
  // The absolute path behind each touched rel, so the naming step can read
  // the document's own heading without re-resolving path logic here.
  const absByRel = new Map();
  // The per-call leg applies to the read/edit/write tools, which carry a
  // single document path. Every other tool (notably `bash`) carries no
  // reliably parseable path and contributes nothing.
  if (ODD_NAMING_TOOLS.has(oddToolNameOf(event))) {
    for (const raw of oddTouchedPaths(oddArgsOf(event))) {
      const abs = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
      const rel = oddRelFor(abs, entry.path, principalRoot);
      if (!rel) continue;
      touched.push(rel);
      if (!absByRel.has(rel)) absByRel.set(rel, abs);
    }
  }
  // T2/D2-D7: the touched rels name the session after the ODD task document
  // being WRITTEN. The naming decision (write-only, own name only,
  // idempotent) lives in lib/session-auto-name.js; this is the call site.
  const sessionId = oddSessionId(ctx);
  autoNameSessionFromWrite(pi, entry, oddToolNameOf(event), touched, absByRel, sessionId);
  // D3: an ODD phase transition carries no feature of its own, so it only
  // re-applies the label this session last derived from a write. It is
  // observed on `tool_result` (a gentle-pi tool, not a host event).
  if (allowPhaseTrigger === true) {
    autoNameSessionFromPhase(pi, entry, sessionId, oddToolNameOf(event));
  }
}

// T2/D7: the session NAME is the only session-identity channel Pi exposes
// (`setSessionName`; there is no subject/alias write). The session owns that
// name only while it matches the pattern the plugin itself writes — anything
// else came from a human and is never touched — and the principal checkout
// never reaches this point, because `oddEntryForCwd` already returned null
// for it (D6). A host without the name accessors is left alone rather than
// guessed at: without `getSessionName` the ownership test cannot run.
function oddSessionId(ctx) {
  try {
    const id = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function"
      ? ctx.sessionManager.getSessionId()
      : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// The document text behind a touched rel, or null when it cannot be read
// (the file may not exist yet on `tool_call`, or the write failed). A null
// text falls back to the filename slug inside the module.
function readOddDocumentText(absByRel, rel) {
  if (!absByRel || typeof absByRel.get !== "function") return null;
  const abs = absByRel.get(rel);
  if (typeof abs !== "string" || abs.length === 0) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function autoNameSessionFromWrite(pi, entry, toolName, touched, absByRel, sessionId) {
  try {
    if (!pi || typeof pi.getSessionName !== "function" || typeof pi.setSessionName !== "function") return;
    const auto = libRequire("session-auto-name.js");
    const label = auto.planSessionRename({
      rels: touched,
      isWrite: auto.isWriteToolName(toolName),
      branch: entry && typeof entry.branch === "string" ? entry.branch : "",
      currentName: pi.getSessionName(),
      sessionId,
      readDocument: (rel) => readOddDocumentText(absByRel, rel),
    });
    if (typeof label === "string" && label.length > 0) pi.setSessionName(label);
  } catch {
    // Naming is best effort: it never disturbs the pipeline it rides on.
  }
}

// D3: a `gentle_odd_phase` transition re-applies the label the session last
// derived from an ODD write. The phase names no feature, so nothing is
// invented here; a session that never wrote an ODD document has nothing to
// re-apply and is left alone.
function autoNameSessionFromPhase(pi, entry, sessionId, toolName) {
  try {
    if (!pi || typeof pi.getSessionName !== "function" || typeof pi.setSessionName !== "function") return;
    const auto = libRequire("session-auto-name.js");
    if (toolName !== auto.ODD_PHASE_TOOL_NAME) return;
    const label = auto.planPhaseSessionRename({
      sessionId,
      branch: entry && typeof entry.branch === "string" ? entry.branch : "",
      currentName: pi.getSessionName(),
    });
    if (typeof label === "string" && label.length > 0) pi.setSessionName(label);
  } catch {
    // Naming is best effort: it never disturbs the pipeline it rides on.
  }
}

// The subscribed pipeline handler: never throws, never blocks, returns
// nothing (a `tool_call` return value would mutate or block the call).
// `allowPhaseTrigger` is set only on `tool_result`, where an ODD phase
// transition is observable.
function handleWorktreeOddEvent(event, ctx, pi, allowPhaseTrigger) {
  try {
    observeOddWriteForNaming(event, ctx, pi, allowPhaseTrigger);
  } catch {
    // Any failure is swallowed after the best-effort attempt above.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `/warp <name>` (S23): move the SESSION to another
// checkout by NAME.
//
// The platform keeps session control (`waitForIdle`/`switchSession`) on
// the extension COMMAND context, and that is exactly why the warp is a
// command verb. The agent's `worktree_warp` tool cannot call either, so it
// queues THIS command through `pi.sendUserMessage(..., {
// expandPromptTemplates: true })` (S14, `dispatchWarpHandoff`): one
// implementation of the move, reached by two front doors. The name is
// the flattened branch slug S24 prints (or `principal`), resolved through
// the SAME `resolveCheckoutByName` the close-by-name path uses — one
// place, never two.
//
// Measured scope of the move (nothing over-promised): the SESSION cwd
// changes and the tools operate in the target, while the PROCESS cwd does
// not (Pi never calls `process.chdir`); emitting OSC-7 tells the TERMINAL
// the new cwd, and Herdr honours it natively (ghostty-vt parses OSC 7
// into its pane pwd, so new panes/tabs/workspaces with
// `new_cwd = "follow"` inherit it); the interactive bash shell in that
// pane does NOT change directory, because a child process cannot change
// its parent shell's cwd.
// ---------------------------------------------------------------------------

// Emit OSC-7 announcing the session's new cwd to the terminal — written
// ONLY when the stream is a TTY, so a stream the TUI owns when it is not a
// TTY is never written to. The payload is a file URL, so a path holding a
// space or a non-ASCII character is percent-encoded instead of splitting
// the OSC-7 argument. The stream is injectable so tests can assert the
// exact bytes.
function emitOsc7(stream, cwd) {
  try {
    if (!stream || stream.isTTY !== true || typeof stream.write !== "function") return false;
    if (typeof cwd !== "string" || cwd.length === 0) return false;
    stream.write(`\x1b]7;${pathToFileURL(cwd).href}\x1b\\`);
    return true;
  } catch {
    return false;
  }
}

// Resolve the SessionManager class for the warp without a static package
// import (which would force every extension test double to stub a third
// line): prefer the canonical package export when the loader resolves it
// (the production Pi loader, which already resolves the sibling static
// imports from the same package), else the session instance's own
// constructor — the class that produced it, whose statics (`forkFrom`,
// `create`, `open`) are the mechanism. Null when neither is available.
async function sessionManagerClassFor(ctx) {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    if (mod && mod.SessionManager && typeof mod.SessionManager.forkFrom === "function") {
      return mod.SessionManager;
    }
  } catch {
    // Plain-node test copies cannot resolve the package: fall through to
    // the instance constructor (the injected fake) below.
  }
  try {
    const ctor = ctx && ctx.sessionManager ? ctx.sessionManager.constructor : null;
    if (ctor && typeof ctor.forkFrom === "function") return ctor;
  } catch {
    // Unreachable: fall through to null.
  }
  return null;
}

function warpFail(text, details) {
  return { text, details: details || {}, isError: true };
}

// S18/S19 warp text hygiene. Branch names and checkout paths reach the
// transcript through the two-line moved/to compact and the one-line
// transition notice, so control characters and ANSI escapes are stripped
// at this layer — the card renderer never sees a command notification.
function warpClean(value, fallback) {
  try {
    const line = String(value ?? '')
      .replace(/\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .split('\n')[0].trim().replace(/\s+/g, ' ');
    return line.length > 0 ? line : fallback;
  } catch {
    return fallback;
  }
}

// The S19 compact: exactly two ordered lines — the checkout left, then
// the checkout entered as `name · branch`. Never a paragraph dump; the
// longer explanation lives in the transition notice and the docs.
function warpCompactText(fromDesc, name, branch) {
  const from = warpClean(fromDesc, '(unknown checkout)');
  const toName = warpClean(name, 'worktree');
  const toBranch = warpClean(branch, '(detached)');
  return `moved: ${from}\nto: ${toName} · ${toBranch}`;
}

// The ONE agent-facing transition notice per real move (S18): a single
// line naming the new checkout. Both the fork
// and the resume path send exactly this through withSession; already-there
// warps, cancelled switches (the host never runs withSession for those)
// and refusals never reach it.
function warpNoticeText(targetCwd, branch) {
  const to = warpClean(targetCwd, '(unknown checkout)');
  const cleanBranch = warpClean(branch, '(detached)');
  return `Worktree warp: now in ${to} (branch '${cleanBranch}').`;
}

// Deepest live checkout containing a cwd, by resolved identity — the one
// rule the listing, the selector title and the already-there check share.
// `extraIds` lets the already-there check keep its target-cwd candidate
// without a second notion of containment.
function warpDeepestContaining(sessionId, ids) {
  if (sessionId === null) return null;
  let active = null;
  for (const id of ids || []) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (sessionId === id || sessionId.startsWith(id + path.sep)) {
      if (active === null || id.length > active.length) active = id;
    }
  }
  return active;
}

function warpLiveIdentities(live, repoRoot) {
  const ids = [];
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    const id = st.real !== null ? st.real : st.absolute;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function warpSessionIdentity(fromCwd, repoRoot) {
  const sessionState = checkoutState(fromCwd, repoRoot);
  return sessionState.real !== null ? sessionState.real : sessionState.absolute;
}

// Current branch/head for a checkout identity from git's live listing
// (S39): the registry row keeps name/branch as recorded at creation time,
// so the warp and the listing print the CURRENT branch from git instead.
// Returns the live branch string, or null when git names no such checkout
// (the caller then falls back to the registry field).
function warpLiveBranchFor(targetCwd, live, repoRoot) {
  try {
    if (typeof targetCwd !== "string" || targetCwd.length === 0) return null;
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === targetCwd) {
        if (typeof entry.branch === "string" && entry.branch.length > 0) return entry.branch;
        return null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// `name · branch` for a checkout identity, or null when the session sits
// outside every known checkout (the caller then prints the raw path).
function warpDescribeCheckout(identity, git, live, repoRoot, principal) {
  try {
    if (identity === null) return null;
    if (principal && typeof principal.path === 'string' && principal.path.length > 0) {
      const st = checkoutState(principal.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === identity) {
        return `principal · ${warpClean(principal.branch, '(detached)')}`;
      }
    }
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id === identity) {
        const slug = slugOf(git, entry.branch);
        return `${warpClean(slug || 'worktree', 'worktree')} · ${warpClean(entry.branch || '(detached)', '(detached)')}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// The S42 source name: the checkout's name only — `principal` for the
// principal checkout, the flattened slug for a worktree — or null when the
// session sits outside every known checkout (the caller then falls back to
// the fromDesc text). Parallel to warpDescribeCheckout, which keeps the
// `name · branch` form the agent text prints; the card reads this field
// for its names-only `moved:` row.
function warpDescribeName(identity, git, live, repoRoot, principal) {
  try {
    if (identity === null) return null;
    if (principal && typeof principal.path === 'string' && principal.path.length > 0) {
      const st = checkoutState(principal.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === identity) return 'principal';
    }
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id === identity) {
        const slug = slugOf(git, entry.branch);
        return warpClean(slug || 'worktree', 'worktree');
      }
    }
  } catch {
    return null;
  }
  return null;
}

// True when the target session already carries this exact transition
// record (S18): the fork path then skips a duplicate appendCustomEntry,
// so the custom-entry sequence never accumulates one paragraph per warp.
// Unreadable entries read as absent — the record is history and is never
// silently dropped when it cannot be inspected.
function warpTransitionRecorded(target, fromCwd, targetCwd) {
  try {
    const carried = target && typeof target.getEntries === 'function' ? target.getEntries() : undefined;
    if (!Array.isArray(carried)) return false;
    return carried.some((entry) => entry && entry.type === 'custom'
      && entry.customType === 'worktree-warp' && entry.data
      && entry.data.from === fromCwd && entry.data.to === targetCwd);
  } catch {
    return false;
  }
}

// Core of the `warp` verb. Exported for unit tests, which inject a fake
// SessionManager class plus a fake OSC stream through `opts` and drive a
// fake command context (`waitForIdle`, `sessionManager` with
// `getSessionFile`/`getLeafId`/`getEntries`/`getSessionDir`,
// `switchSession`, `ui.setStatus`, `cwd`); the registered command calls
// it with the live Pi context and notifies the returned text.
//
// Mechanism (S23): `await ctx.waitForIdle()`; capture
// `{file: getSessionFile(), leaf: getLeafId(), cwd: ctx.cwd, sessionDir}`
// and refuse when there is no persisted session; `SessionManager.forkFrom`
// (or, for a session Pi has not written to disk yet — brand-new, living
// only in memory — clone the in-memory entries into a session allocated
// for the target cwd via `SessionManager.create` + `open`); `branch(leaf)`
// (or `resetLeaf()` when there is no leaf) plus one `appendCustomEntry`
// transition record naming both cwds; then
// `ctx.switchSession(targetFile, { withSession: r => r.ui.setStatus(...)
// + r.sendMessage(..., {triggerTurn: false}) })`, whose message names the
// new checkout. `cancelled` is a real outcome: it removes the target session file,
// reports it, and changes nothing else. S17: at
// most ONE fork per checkout — a checkout with a usable recorded session
// resumes that same file with a plain `switchSession` (no fork, no
// branch/append bookkeeping); only a missing, corrupt, or stale record
// forks once and overwrites the record, principal included.
// S61 pending-changes guard: when the source checkout holds uncommitted
// changes, the warp asks whether to copy them into the destination
// checkout (YES COPY / NO COPY), while Esc/Ctrl+C cancels the warp with
// no switch and no mutation. The built-in boolean confirm collapses No
// and Esc, so the choice rides the existing custom inline single-select
// (lib/warp-create-picker.js), never an invented API. A clean checkout
// never prompts; a summary failure degrades to an ordinary warp (no
// copy) instead of blocking the scripted path. Copying uses the shared
// lib/worktree-changes.js transfer (snapshot preflight, destination
// overlap rejects with zero mutation, dry-run patch validation).
let warpDirtyAsker = null;
function setWarpDirtyAsker(asker) {
  warpDirtyAsker = asker;
}
// Returns 'yes' | 'no' | null (null = cancel). Never throws: any UI
// failure reads as cancel (no switch, no mutation).
async function askWarpDirtyChoice(ctx, summaryLine, opts) {
  if (typeof warpDirtyAsker === 'function') {
    try {
      const value = await warpDirtyAsker(ctx, summaryLine);
      if (value === 'yes' || value === 'no' || value === null) return value;
      return null;
    } catch {
      return null;
    }
  }
  if (ctx && ctx.ui && typeof ctx.ui.custom === 'function') {
    let helpers = null;
    try {
      helpers = await warpTuiLoader();
    } catch {
      helpers = null;
    }
    let pickerLib = null;
    try {
      pickerLib = libRequire('warp-create-picker.js');
    } catch {
      pickerLib = null;
    }
    if (pickerLib && typeof pickerLib.createSingleSelect === 'function') {
      let out;
      try {
        out = await ctx.ui.custom(
          (hostTui, theme, _keybindings, done) => pickerLib.createSingleSelect({
            title: `Uncommitted changes: ${summaryLine}. Copy to the destination checkout?`,
            items: ['YES COPY', 'NO COPY'],
            helpers,
            hostTui,
            theme,
            showTab: false,
            confirmLabel: 'choose',
            rowsAvailable: () => {
              try {
                const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
                if (Number.isFinite(rows) && rows > 0) return rows;
              } catch {
                // A hostile host object never breaks the prompt.
              }
              return 24;
            },
            done,
          }),
          WARP_QUESTION_OVERLAY,
        );
      } catch {
        return null;
      }
      if (out === null || out === undefined) return null;
      if (typeof out === 'string') {
        if (out === 'YES COPY') return 'yes';
        if (out === 'NO COPY') return 'no';
      }
      return null;
    }
  }
  // No custom UI (scripted/headless path): ordinary warp, no copy.
  return 'no';
}
// S61 source-dirty gate shared by the warp command. Returns
// {ok:true, copied} to continue, {cancelled:true} to stop with no
// switch, or {error} to refuse with no switch. Never throws.
async function warpMaybeCopyDirty({ ctx, git, fromCheckout, targetCwd, options }) {
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch (err) {
    return { ok: true, copied: null };
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(fromCheckout, { git });
  } catch {
    return { ok: true, copied: null };
  }
  if (!summary || summary.ok !== true || summary.files === 0) return { ok: true, copied: null };
  const summaryLine = `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}`;
  const choice = await askWarpDirtyChoice(ctx, summaryLine, options);
  if (choice === null) return { cancelled: true };
  if (choice === 'no') return { ok: true, copied: null };
  let copied;
  try {
    copied = await changesLib.copyChanges({ from: fromCheckout, to: targetCwd, selectMode: 'all' }, { git });
  } catch (err) {
    return { error: `cannot copy changes: ${(err && err.message) || err} (nothing was warped)` };
  }
  if (!copied || copied.ok !== true) {
    return { error: `${(copied && copied.error) || 'cannot copy changes'} (nothing was warped)` };
  }
  return { ok: true, copied };
}
async function executeWorktreeWarp(rawName, ctx, opts) {
  const options = opts || {};
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  // A handoff (queued by the `worktree_warp` tool) names the checkout it
  // resolved, so this invocation never re-picks a destination: it re-checks
  // that the very same live checkout is still the one the name resolves to
  // and refuses otherwise. An ordinary invocation (a human typing
  // `/warp <name>`) carries none.
  const handoff = normalizeWarpHandoff(options.handoff);
  // A create from the SAME flow already asked the pending-changes question and
  // applied the answer, so this move reuses that answer instead of asking the
  // same question twice: nothing is copied here (a second copy would be refused
  // by the destination as an overlap) and nothing is asked. Only the flow that
  // owns the answer sets it, and only for the checkout that create made.
  const skipDirtyPrompt = options.skipDirtyPrompt === true;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name === "") {
    return warpFail(
      "worktree warp needs a name: use /warp <name> (the flattened branch slug, or principal)",
      { name, alreadyThere: false, cancelled: false },
    );
  }
  if (!ctx || typeof ctx.waitForIdle !== "function" || typeof ctx.switchSession !== "function") {
    return warpFail(
      "worktree warp is only available as a session command: run /warp <name> from a Pi session",
      { name, alreadyThere: false, cancelled: false },
    );
  }
  await ctx.waitForIdle();
  const fromCwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  // S21: the same awaited preflight reads as the tool, so a slow repository
  // never freezes the session that is being moved.
  const runAsync = libRunner(git);
  let repo;
  try {
    repo = await git.repoIdentityAsync(fromCwd, { runAsync });
  } catch (err) {
    return warpFail(`worktree warp: not a git repository: ${fromCwd}`, { name, alreadyThere: false, cancelled: false });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return warpFail(`worktree warp: cannot read worktree registry: ${read.error}`, { name, alreadyThere: false, cancelled: false });
  }
  let live;
  try {
    live = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return warpFail(`worktree warp: cannot list worktrees: ${(err && err.message) || err}`, { name, alreadyThere: false, cancelled: false });
  }
  // S14: this fresh scan is the warp-time discovery refresh.
  noteWarpDiscovery(repo.root, live);
  // The SAME resolver as close-by-name (S14: the warp allows a lone
  // unregistered match): unknown or ambiguous fails closed.
  const resolved = resolveCheckoutByName(name, git, read, principalForName(git, repo.root, repo, live), live, repo.root, { allowUnregistered: true });
  if (!resolved.ok) {
    return warpFail(`worktree warp: ${resolved.error}`, { name, alreadyThere: false, cancelled: false, candidates: resolved.candidates });
  }
  // Normalize the target cwd through the one liveness predicate (a row
  // reaching the checkout through a symlink warps to the real checkout).
  // S39 fail-closed: the target must exist as a directory AND still be a
  // checkout of this repository in git's listing — no fork, no notice,
  // no record write when it is missing or foreign.
  const targetState = checkoutState(resolved.path, repo.root);
  const targetCwd = targetState.real !== null ? targetState.real
    : targetState.absolute !== null ? targetState.absolute
    : path.resolve(resolved.path);
  if (!targetState.exists || !targetState.isDirectory || !liveIdentities(live, repo.root).has(targetCwd)) {
    return warpFail(
      `worktree warp: no live checkout for "${name}" at ${targetCwd}: the path is missing or is not a checkout of this repository; run 'git worktree list' to see the live checkouts`,
      { name, alreadyThere: false, cancelled: false },
    );
  }
  // Handoff drift, refuse-don't-guess (never applied to a human invocation):
  // the destination must still be the checkout the tool resolved, and the
  // session must still sit where the tool left it. Either mismatch means the
  // tree moved between the queue and this turn, so the move the agent was
  // promised is no longer the move this command would perform.
  if (handoff) {
    const handoffState = checkoutState(handoff.target, repo.root);
    const handoffId = handoffState.real !== null ? handoffState.real : handoffState.absolute;
    if (handoffId === null || handoffId !== targetCwd) {
      return warpFail(
        `worktree warp: the checkout for "${name}" changed since the handoff was queued; warp again`,
        { name, alreadyThere: false, cancelled: false },
      );
    }
    const sessionState = checkoutState(fromCwd, repo.root);
    const sessionRoot = sessionState.real !== null ? sessionState.real : sessionState.absolute;
    const handoffSource = checkoutState(handoff.from, repo.root);
    const sourceRoot = handoffSource.real !== null ? handoffSource.real : handoffSource.absolute;
    if (sessionRoot === null || sourceRoot === null || sessionRoot !== sourceRoot) {
      return warpFail(
        "worktree warp: the session moved since the handoff was queued; warp again",
        { name, alreadyThere: false, cancelled: false },
      );
    }
  }
  // S39 current branch: the registry row keeps the branch recorded at
  // creation time, so the warp shows the checkout's CURRENT branch from
  // git (the registry field is the fallback only). Sole claimants refresh;
  // shared checkouts keep the resolved row so the ambiguity keeps resolving.
  // The principal keeps its reserved name whatever the default branch is.
  const liveBranch = (registryClaimCounts(read.worktrees, repo.root).get(targetCwd) || 0) <= 1
    ? warpLiveBranchFor(targetCwd, live, repo.root)
    : null;
  let displayName = resolved.name;
  let displayBranch = resolved.branch;
  if (typeof liveBranch === "string" && liveBranch.length > 0) {
    displayBranch = liveBranch;
    if (resolved.kind !== "principal") {
      const liveSlug = slugOf(git, liveBranch);
      if (liveSlug !== null) displayName = liveSlug;
    }
  }
  // Warping to the checkout the session already runs in reports that and
  // changes nothing: no fork, no switch, no OSC-7. "Already there" is the
  // DEEPEST live checkout containing the session, the rule the listing
  // already uses: a session inside a nested worktree under the principal
  // is not in the principal, while a session in a subdirectory of the
  // target is in the target.
  const sessionId = warpSessionIdentity(fromCwd, repo.root);
  const sessionCheckout = warpDeepestContaining(sessionId, [targetCwd, ...warpLiveIdentities(live, repo.root)]);
  if (sessionCheckout !== null && sessionCheckout === targetCwd) {
    return {
      text: `worktree warp: ${name} (already there)`,
      details: { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: true, cancelled: false },
    };
  }
  // S61: the source checkout's pending changes gate. The destination is
  // resolved and verified above; a dirty source asks YES COPY / NO COPY
  // (Esc/Ctrl+C cancels with no switch), a clean source warps silently.
  // The source is the deepest live checkout containing the session (the
  // same rule the already-there check uses); outside every checkout the
  // session cwd itself is summarized.
  //
  // A HANDOFF never asks: its caller (`worktree_warp`) already validated the
  // requested selection and an interactive picker fired from a queued command
  // would block the move on a prompt nobody asked for. It carries the selection
  // in its token instead, and the copy happens HERE — after every refusal check
  // above and before the switch — so a handoff refused for decode, drift or a
  // selection it cannot match mutates nothing. What the copy CANNOT promise is
  // that the switch then succeeds: a host that cancels or throws after the copy
  // leaves real files in the destination, which is why every later failure goes
  // through `failAfterCopy` (below) and why a retry must prove the copied state
  // byte for byte before it skips anything.
  const dirtyFrom = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root)) || fromCwd;
  // A handoff copy that has landed in the destination is REAL state. It is never
  // rolled back automatically — deleting or reverting files nobody authorized us
  // to touch is exactly the destructive guess this path refuses — so every
  // failure after it names the destination, the copied files and the recovery.
  // `skipped` marks the retry that PROVED the destination already holds exactly
  // those bytes, so the wording says "already holds" instead of "copied now".
  let handoffCopy = null;
  const handoffCopyDetails = () => (handoffCopy
    ? {
      copyDestination: targetCwd,
      copiedFiles: (handoffCopy.copied || []).slice(),
      ...(handoffCopy.skipped === true ? { copyAlreadyPresent: true } : {}),
    }
    : {});
  const handoffCopyLanding = () => {
    const summary = warpCopyFilesSummary(handoffCopy && handoffCopy.copied);
    return handoffCopy && handoffCopy.skipped === true
      ? `${targetCwd} already holds the requested changes (${summary.line}, proved byte for byte from an earlier attempt)`
      : `copied into ${targetCwd} before the move failed: ${summary.line}`;
  };
  const failAfterCopy = (text, details) => {
    if (!handoffCopy) return warpFail(text, details);
    // Two tails, because the two states are not the same: a copy this attempt
    // made is REAL new state, while a skipped copy means the destination already
    // held it and this attempt changed nothing there.
    const tail = handoffCopy.skipped === true
      ? `nothing was overwritten: ${warpClean(dirtyFrom, 'the source checkout')} keeps its pending work and ${targetCwd} keeps the copy it already held\n`
        + `recovery: this attempt changed nothing in ${targetCwd}; warp again (the same byte-for-byte proof runs first), or warp again without changes to leave it as it is`
      : `nothing was rolled back: ${warpClean(dirtyFrom, 'the source checkout')} keeps its pending work and ${targetCwd} keeps its copy\n`
        + 'recovery: warp again with the same changes (a copy the destination already holds byte for byte is skipped, never duplicated), or commit or revert those files in the destination and warp again, or warp again without changes to leave the copy in place';
    return warpFail(`${text}\n\n${handoffCopyLanding()}\n${tail}`, { ...details, ...handoffCopyDetails() });
  };
  if (!handoff) {
    if (skipDirtyPrompt !== true) {
      const dirtyGate = await warpMaybeCopyDirty({
        ctx, git, fromCheckout: dirtyFrom, targetCwd, options: opts,
      });
      if (dirtyGate && dirtyGate.cancelled === true) {
        return warpFail(
          `worktree warp: ${name} cancelled (the session stays in ${fromCwd})`,
          { name, alreadyThere: false, cancelled: true },
        );
      }
      if (dirtyGate && typeof dirtyGate.error === 'string') {
        return warpFail(dirtyGate.error, { name, alreadyThere: false, cancelled: false });
      }
    }
  } else if (handoff.changes && handoff.changes.mode !== 'none') {
    const copyGate = await warpHandoffCopyChanges({
      git, fromCheckout: dirtyFrom, targetCwd, changes: handoff.changes,
    });
    if (copyGate && copyGate.ok === true) {
      handoffCopy = copyGate.copied && Array.isArray(copyGate.copied.copied) && copyGate.copied.copied.length > 0
        ? { copied: copyGate.copied.copied.slice(), skipped: false }
        : null;
    } else {
      // The copy refused. One benign cause: an EARLIER attempt already copied
      // exactly this content and the move failed afterwards (the host cancelled
      // or threw the switch). Prove that state byte for byte and skip the copy
      // only then; otherwise fail closed with the concrete recovery, never
      // guessing and never overwriting what the destination holds.
      const proof = await warpHandoffCopyAlreadyApplied({
        git, fromCheckout: dirtyFrom, targetCwd, changes: handoff.changes,
      });
      if (proof.ok === true && proof.applied === true) {
        handoffCopy = { copied: proof.identical.slice(), skipped: true };
      } else if (proof.ok === true) {
        // Nothing was proven byte for byte, so the copy is NOT skipped. The
        // message says what the destination actually holds — and, separately,
        // which selected files could not be READ, since an unreadable file is
        // not evidence of an absent one. The first line is the copy's own error,
        // which counts any file that DID land (a copy can fail partway), so the
        // safety line below is chosen by that evidence and never promises
        // "nothing was written" while the destination holds files this attempt
        // put there.
        const held = proof.identical.length > 0
          ? `${targetCwd} now holds ${warpCopyFilesSummary(proof.identical).line}; `
          : '';
        const problems = [];
        if (proof.differing.length > 0) {
          problems.push(`${proof.differing.join(', ')} ${proof.differing.length === 1 ? 'does' : 'do'} not match the source byte for byte`);
        }
        if (proof.unreadable.length > 0) {
          problems.push(`${proof.unreadable.join(', ')} could not be read (a permission error, an unsafe file type or a path outside the checkout)`);
        }
        return warpFail(
          `worktree warp: ${copyGate.error}\n\n${held}${problems.join(', and ')}; the copy cannot be skipped\n`
          // The safety sentence is EVIDENCE-BASED, never a blanket promise. A copy
          // can fail PARTWAY: the error above counts the files that landed, and
          // those files really are in the destination now, so the refusal may
          // never claim an unqualified "nothing was overwritten". The scope is
          // named instead — nothing BEYOND the files just listed — which stays
          // true for a full refusal and for a partial copy alike.
          + (proof.identical.length === 0
            ? 'nothing was rolled back and nothing was overwritten\n'
            : 'nothing was rolled back and nothing was overwritten beyond the files listed above\n')
          + `recovery: warp again without changes to leave the destination as it is, or reconcile those files in ${targetCwd} (commit or revert them) and warp again with the same changes`,
          {
            name, alreadyThere: false, cancelled: false,
            copyDestination: targetCwd, copiedFiles: proof.identical.slice(),
          },
        );
      } else {
        return warpFail(`worktree warp: ${copyGate.error}`, { name, alreadyThere: false, cancelled: false });
      }
    }
  }
  // The S19 compact both success paths report: the checkout left, then
  // the checkout entered. One builder, so fork and resume never diverge.
  // fromDesc keeps the `name · branch` form the agent text prints; fromName
  // carries the source worktree's name alone for the card's S42 `moved:` row.
  const sourceCheckout = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root));
  const principalCheckout = principalForName(git, repo.root, repo, live);
  const fromDesc = warpDescribeCheckout(
    sourceCheckout,
    git, live, repo.root, principalCheckout,
  ) || fromCwd;
  const fromName = warpDescribeName(sourceCheckout, git, live, repo.root, principalCheckout)
    || warpClean(fromDesc, '(unknown checkout)');
  const moveText = warpCompactText(fromDesc, displayName, displayBranch);
  // The notice the switched-to session delivers on a FORK: the new fork
  // carries the session's work into a new checkout. One closure, one short
  // notice — never a repeated paragraph (S18). Resumes send nothing (R2):
  // the recorded session already carries its notice, so re-entering must
  // not append another copy; the resume path below only updates status.
  //
  // A HANDOFF always continues (S49): the agent queued a move and stopped
  // waiting for it, so the switched-to session must both confirm the move
  // and start the turn that keeps working in the new checkout — on the fork
  // AND on the resume path, which is silent for a human.
  const warpNotice = warpNoticeText(targetCwd, displayBranch);
  const warpHandoffNotice = `${warpNotice} Continue the task from here.`;
  const warpConfirm = async (r, content, triggerTurn) => {
    try {
      r.ui.setStatus("worktree", `${displayName} (${targetCwd})`);
    } catch {
      // Status is cosmetic; the notice below is not.
    }
    await r.sendMessage({
      customType: "worktree-warp",
      content,
      display: true,
      // S20: the card renderer reads the compact rows from here — never
      // by parsing text — so the styled confirmation, the agent text and
      // the listing identifier cannot drift apart. S42: fromName is the
      // source worktree's name alone for the card's `moved:` row.
      details: { from: fromCwd, to: targetCwd, fromDesc, fromName, name: displayName, branch: displayBranch },
    }, triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
  };
  const warpWithSession = async (r) => {
    await warpConfirm(r, handoff ? warpHandoffNotice : warpNotice, handoff !== null);
  };
  const warpResumeWithSession = async (r) => {
    try {
      r.ui.setStatus("worktree", `${displayName} (${targetCwd})`);
    } catch {
      // Status is cosmetic; the recorded session already carries its
      // confirmation, so no message is sent here (R2).
    }
    if (handoff) await warpConfirm(r, warpHandoffNotice, true);
  };
  // S43 records. The POINT of a session is its ACTIVE branch (the live
  // leaf's parentId path, never all append-only entries) filtered to
  // entries that are NOT our own bookkeeping — the custom marker, the
  // custom_message notice, the session-worktree registration entry and
  // the renames never count as advancement — so a fresh fork's filtered
  // point equals its source's. BOTH sides of every transition are
  // recorded at their post-transition points from FRESH state: the
  // destination file as re-read after the switch, and the source session
  // file just left, each its OWN point. The resume gate below compares
  // the current point against the destination file's actual point (see
  // below); a first visit forks the current work into the target, appends
  // exactly one marker, names the fork after the checkout, and shows
  // exactly one card (R2).
  const warpSessions = libRequire("worktree-warp-sessions.js");
  const smEarly = ctx.sessionManager || {};
  const safeEarly = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const currentFile = typeof smEarly.getSessionFile === "function" ? safeEarly(() => smEarly.getSessionFile()) : undefined;
  let currentEntriesList = [];
  try {
    const seen = typeof smEarly.getEntries === "function" ? safeEarly(() => smEarly.getEntries()) : undefined;
    if (Array.isArray(seen)) currentEntriesList = seen;
  } catch {
    currentEntriesList = [];
  }
  // S43 identity reads. The POINT of a session is its ACTIVE branch
  // filtered to non-bookkeeping entries (lib/worktree-warp-sessions.js):
  // getEntries() returns every branch while getLeafId() selects the live
  // one, so the leaf travels with the entries. File points are recovered
  // from the file itself (installed _buildIndex rule: the last entry is
  // the leaf), seam first, then the file's own lines — the live runtime
  // reopens the manager and keeps appending there, so the file is the
  // actual destination state, never a stale manager or cached fingerprint.
  const currentLeaf = typeof smEarly.getLeafId === "function" ? safeEarly(() => smEarly.getLeafId()) : undefined;
  const currentPoint = warpSessions.sessionPoint(
    currentEntriesList, typeof currentLeaf === "string" ? currentLeaf : undefined,
  );
  const warpFileOpen = options && typeof options.warpSessionFileOpen === "function"
    ? options.warpSessionFileOpen
    : undefined;
  const warpFreshPoint = (sessionFile) => {
    try {
      return warpSessions.pointOfSessionFile(sessionFile, warpFileOpen ? { open: warpFileOpen } : {});
    } catch {
      return null;
    }
  };
  // The checkout being left: the deepest live checkout containing the
  // session, the same rule the already-there check uses. Null when the
  // session sits outside every checkout: then only the destination side
  // is recorded. It never gates the resume decision — S37 compares the
  // destination record against the current session, not this checkout.
  const sourceIdentity = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root));
  // Latest session_info name: the human-visible name the session carries
  // right now (what getSessionName() returns). Used only for the
  // already-there equality checks below, never as the rename base — the
  // latest is the already-appended one, so suffixing onto it stacks a
  // pair of segments per hop.
  const lastSessionInfoName = (entries) => {
    try {
      const list = Array.isArray(entries) ? entries : [];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index];
        if (entry && entry.type === 'session_info' && typeof entry.name === 'string') {
          const clean = warpClean(entry.name, '');
          if (clean.length > 0) return clean;
        }
      }
    } catch {
      // No name: the checkout label stands alone below.
    }
    return '';
  };
  // Base session name for the fork rename: the FIRST session_info
  // entry's name — the session's original name before any warp appended
  // a checkout — because entries arrive in append order while
  // getSessionName() sees only the latest. Falls back to the manager's
  // current name when the entries carry none (getEntries() copies the
  // session while getSessionName() reads the live list, so one can
  // answer when the other cannot). Empty when there is no name at all.
  const firstSessionInfoName = (entries) => {
    try {
      const list = Array.isArray(entries) ? entries : [];
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (entry && entry.type === 'session_info' && typeof entry.name === 'string') {
          const clean = warpClean(entry.name, '');
          if (clean.length > 0) return clean;
        }
      }
    } catch {
      // No base: the caller falls back below.
    }
    return '';
  };
  const currentSessionName = () => {
    try {
      const sm = ctx.sessionManager || {};
      if (typeof sm.getSessionName === 'function') {
        return warpClean(sm.getSessionName(), '');
      }
    } catch {
      // No current name: the checkout label stands alone below.
    }
    return '';
  };
  // Short form: "<base> · <checkout>", the checkout written ONCE as the
  // warp identifier (displayName — the slug the selector shows and
  // `warp <name>` accepts, so "principal" stays "principal" whatever
  // the default branch is). The base is the session's ORIGINAL name, so
  // a second hop re-derives "base · b" instead of stacking
  // "base · a · b"; with no name at all the checkout label alone is
  // the stable default (still a usable name). Sanitized and
  // structurally bounded — one segment per fork, never accumulated.
  // Empty only when there is nothing to say.
  const warpForkName = (entries) => {
    const label = warpClean(displayName, '');
    if (label.length === 0) return '';
    let base = firstSessionInfoName(entries);
    if (base.length === 0) base = currentSessionName();
    if (base.length === 0) return label;
    if (base === label || base.endsWith(` · ${label}`)) return base;
    return `${base} · ${label}`;
  };
  // Name the fork after the checkout through the real
  // SessionManager.open(path).appendSessionInfo(name): a rename is a
  // session_info entry, so it never moves the filtered point. The base
  // name comes from the source entries (the fork inherits them verbatim)
  // while the already-there check reads the fork itself. Best-effort and
  // never on resume: a name that is already there is left alone, and a
  // rename failure never fails the warp that already switched.
  const nameForkAfterCheckout = (renameView, sourceEntries, forkEntries) => {
    try {
      if (!renameView || typeof renameView.appendSessionInfo !== 'function') return;
      const wanted = warpForkName(sourceEntries);
      if (wanted.length === 0) return;
      // The fork inherits the source entries verbatim, so a name that is
      // already there — on either leg — is left alone, never rewritten.
      if (lastSessionInfoName(forkEntries) === wanted) return;
      if (lastSessionInfoName(sourceEntries) === wanted) return;
      renameView.appendSessionInfo(wanted);
    } catch {
      // Best effort: the warp already succeeded.
    }
  };
  const recordBothSides = (destCwd, destFile, destPoint, srcCwd, srcFile, srcPoint) => {
    try {
      // A null destination point skips its side instead of recording a
      // borrowed one: each side reflects its OWN file, never copied.
      if (typeof destFile === 'string' && destFile.length > 0 && destPoint) {
        warpSessions.recordWarpSession(repo.root, destCwd, {
          sessionFile: destFile, tipId: destPoint.tipId, count: destPoint.count,
        });
      }
    } catch {
      // Best effort: the warp already succeeded.
    }
    try {
      if (typeof srcCwd === 'string' && srcCwd.length > 0
        && typeof srcFile === 'string' && srcFile.length > 0) {
        warpSessions.recordWarpSession(repo.root, srcCwd, {
          sessionFile: srcFile, tipId: srcPoint.tipId, count: srcPoint.count,
        });
      }
    } catch {
      // Best effort: the warp already succeeded.
    }
  };
  // S43 resume (point comparison at the gate): the destination owns a
  // warp session whose file is an absolute path that still exists AND
  // whose recorded filtered point equals the CURRENT session's filtered
  // point (our warp markers and renames excluded from both) — then switch
  // to it with NO new fork, no fresh confirmation (R2: it already
  // carries its notice), no rename and no new bookkeeping: the two
  // threads hold the same content. A missing, corrupt, or stale (file
  // gone) destination record — the checkout's first visit — or a record
  // at a DIFFERENT point (real work happened) falls through to the
  // single fork below, which records both sides. The lookup never throws
  // and never writes.
  let recordedSession = null;
  let recordedFreshPoint = null;
  try {
    const recorded = warpSessions.getWarpSession(repo.root, targetCwd);
    // Absolute only: a relative entry can never name a session file
    // without resolving against the process cwd, so it reads as no
    // record and the warp forks again.
    if (recorded && typeof recorded.sessionFile === "string" && recorded.sessionFile.length > 0
      && path.isAbsolute(recorded.sessionFile)) {
      let usable = false;
      try {
        usable = fs.statSync(recorded.sessionFile).isFile();
      } catch {
        usable = false;
      }
      // Equal points mean the same content, so resume; different points
      // mean real work happened, so fork below. Never throws: any
      // comparison failure reads as "fork".
      if (usable) {
        try {
          // Equal points mean the same content, so resume; different points
          // mean real work happened, so fork below. The comparison reads
          // the destination FILE's actual point — never the blindly stale
          // cached fingerprint. An unreadable destination never resumes.
          // Never throws: any comparison failure reads as "fork".
          const freshDestPoint = warpFreshPoint(recorded.sessionFile);
          if (freshDestPoint !== null && warpSessions.samePoint(currentPoint, freshDestPoint)) {
            recordedSession = recorded;
            recordedFreshPoint = freshDestPoint;
          }
        } catch {
          recordedSession = null;
        }
      }
    }
  } catch {
    recordedSession = null;
  }
  const recordedSessionFile = recordedSession !== null ? recordedSession.sessionFile : null;
  if (recordedSessionFile !== null) {
    let resumed;
    try {
      resumed = await ctx.switchSession(recordedSessionFile, { withSession: warpResumeWithSession });
    } catch (err) {
      return failAfterCopy(
        `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the recorded warp session was kept`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    if (resumed && resumed.cancelled === true) {
      // Like the fork path, `cancelled` is a real outcome, not a
      // success — except the recorded file is kept: it still belongs to
      // this checkout, so a later warp resumes it.
      return failAfterCopy(
        `worktree warp: ${name} cancelled (the session stays in ${fromCwd})`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
      );
    }
    // After a successful switch only: refresh both records at their
    // post-transition points. The resume appends nothing, so the
    // destination keeps its recorded point (only the timestamp moves)
    // while the source records the session file just left at its point.
    // Then tell the terminal the new cwd (nothing unless a TTY).
    recordBothSides(
      targetCwd, recordedSessionFile, recordedFreshPoint,
      sourceIdentity, currentFile, currentPoint,
    );
    emitOsc7(options.oscStream || process.stdout, targetCwd);
    return {
      text: moveText,
      details: { name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false, ...handoffCopyDetails() },
    };
  }
  const sm = ctx.sessionManager || {};
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const file = typeof sm.getSessionFile === "function" ? safe(() => sm.getSessionFile()) : undefined;
  const leaf = typeof sm.getLeafId === "function" ? safe(() => sm.getLeafId()) : null;
  const sessionDir = typeof sm.getSessionDir === "function" ? safe(() => sm.getSessionDir()) : undefined;
  let carried = [];
  if (!warpSourceUsable(file, warpFileOpen)) {
    const entries = typeof sm.getEntries === "function" ? safe(() => sm.getEntries()) : undefined;
    carried = Array.isArray(entries) ? entries : [];
    if (carried.length === 0) {
      return failAfterCopy(
        "worktree warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry",
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  const SM = options.sessionManagerClass || await sessionManagerClassFor(ctx);
  if (!SM || typeof SM.forkFrom !== "function") {
    return failAfterCopy(
      "worktree warp is unavailable here: the host SessionManager has no forkFrom",
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  let target = null;
  let targetFile = null;
  // Only a validated source forks; an allocated-but-unwritten file
  // falls through to the in-memory carry path below.
  if (warpSourceUsable(file, warpFileOpen)) {
    // S43 parent priority: fork from the HIGHEST ancestor whose filtered
    // point still equals this session's, so an untouched fork yields a
    // SIBLING (both children of the original) while an advanced session
    // yields its own child. The climb reads the `parentSession` chain and
    // never throws: any unreadable link, mismatch, cycle or depth-cap stop
    // keeps the last good file. `warpSessionFileOpen` is the test seam
    // (open(file) -> {entries, parentSession}); production omits it and
    // the climb reads the real session files.
    let forkSource = file;
    try {
      const climbed = warpSessions.topmostIdenticalAncestor(
        file, currentPoint, warpFileOpen ? { open: warpFileOpen } : {},
      );
      if (typeof climbed === "string" && climbed.length > 0) forkSource = climbed;
    } catch {
      forkSource = file;
    }
    try {
      target = SM.forkFrom(forkSource, targetCwd, sessionDir);
    } catch (err) {
      return failAfterCopy(
        `worktree warp: could not fork the session into ${targetCwd}: ${(err && err.message) || err}`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  } else {
    // Pi has not written this session to disk yet: allocate a session for
    // the target cwd and put the carried entries in its file ourselves,
    // preserving order and ids so the history (and the leaf below)
    // survives.
    try {
      const allocated = SM.create(targetCwd, sessionDir);
      const allocatedFile = allocated && typeof allocated.getSessionFile === "function" ? allocated.getSessionFile() : undefined;
      if (typeof allocatedFile !== "string" || allocatedFile.length === 0) {
        throw new Error("the host allocated no session file for the target");
      }
      const header = typeof allocated.getHeader === "function" ? allocated.getHeader() : null;
      if (!header) throw new Error("the allocated session has no header");
      // Written rather than replayed through the manager's private append:
      // a private append is not guaranteed to reach disk before the switch,
      // and a target holding only its header would silently lose the whole
      // conversation. `wx` never clobbers an existing file.
      const lines = [header, ...carried].map((entry) => `${JSON.stringify(entry)}\n`).join("");
      fs.writeFileSync(allocatedFile, lines, { flag: "wx" });
      target = SM.open(allocatedFile, sessionDir, targetCwd);
    } catch (err) {
      return failAfterCopy(
        `worktree warp: could not carry this session into ${targetCwd}: ${(err && err.message) || err}`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  }
  if (typeof targetFile !== "string" || targetFile.length === 0) {
    return failAfterCopy(
      `worktree warp: the forked session for ${targetCwd} has no session file`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  try {
    if (leaf !== null && leaf !== undefined) target.branch(leaf);
    else target.resetLeaf();
  } catch (err) {
    // S43 sibling case: the fork branched from the highest identical
    // ancestor, which does not carry the current leaf (bookkeeping the
    // fork appended after branching — the real branch() refuses unknown
    // ids). Fall back to the deepest non-bookkeeping entry of the current
    // active branch: the climb guarantees the fork holds it. Reset when
    // the session holds no real entry at all.
    try {
      const liveBranch = warpSessions.activeBranch(
        currentEntriesList, typeof leaf === "string" ? leaf : undefined,
      );
      let anchor = null;
      for (const entry of liveBranch) {
        if (entry && typeof entry.id === "string" && !warpSessions.isWarpBookkeepingEntry(entry)) {
          anchor = entry.id;
        }
      }
      if (anchor !== null) target.branch(anchor);
      else target.resetLeaf();
    } catch (err2) {
      return failAfterCopy(
        `worktree warp: could not position the forked session at ${targetFile}: ${(err2 && err2.message) || err2}; the forked session file was kept for inspection`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  // S18 dedupe: the target may already carry this exact transition (a
  // fork of a session that recorded it), in which case no second record
  // is appended — the custom-entry sequence stays at one per transition.
  // The marker is our own bookkeeping: it advances the raw leaf but never
  // the filtered point, so it can never force a second fork by itself.
  if (!warpTransitionRecorded(target, fromCwd, targetCwd)) {
    try {
      target.appendCustomEntry("worktree-warp", { from: fromCwd, to: targetCwd, name: displayName, branch: displayBranch });
    } catch (err) {
      return failAfterCopy(
        `worktree warp: could not record the transition into ${targetCwd}: ${(err && err.message) || err}; the forked session file was kept for inspection`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  // S23 naming: each fork carries its checkout. Never on resume (that
  // path returns before any fork exists), never when the fork already
  // carries the name, never a warp failure.
  try {
    let renameView = null;
    if (SM && typeof SM.open === "function") {
      renameView = SM.open(targetFile, sessionDir);
    }
    if (!renameView || typeof renameView.appendSessionInfo !== "function") {
      renameView = target && typeof target.appendSessionInfo === "function" ? target : null;
    }
    if (renameView) {
      const seen = typeof renameView.getEntries === "function" ? safe(() => renameView.getEntries()) : undefined;
      nameForkAfterCheckout(renameView, currentEntriesList, Array.isArray(seen) ? seen : []);
    }
  } catch {
    // Best effort: the warp already succeeded.
  }
  let switched;
  try {
    switched = await ctx.switchSession(targetFile, { withSession: warpWithSession });
  } catch (err) {
    return failAfterCopy(
      `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the forked session file was kept at ${targetFile}`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  if (switched && switched.cancelled === true) {
    // `cancelled` is a real outcome, not a success: remove the target
    // session file, report it, change nothing else.
    try {
      fs.unlinkSync(targetFile);
    } catch {
      // Best effort: the report below is what matters.
    }
    return failAfterCopy(
      `worktree warp: ${name} cancelled (the session stays in ${fromCwd}; the forked session file was removed)`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
    );
  }
  // S23: the fork (or the carried memory session) is the destination's
  // warp session at its post-transition point — read AFTER the marker and
  // the rename landed, so what is stored is the filtered point, identical
  // to the source's by the verbatim-copy property (our own appends are
  // excluded from the filter). The target read wins when it carries
  // entries; an empty or unreadable target read falls back to the source
  // point, which names the same filtered position. The source checkout
  // records the session file just left at its own point. Best-effort and
  // only on success: a cancelled switch removed the file above (nothing
  // to record), and a failed record write never fails the warp that
  // already switched.
  try {
    // The destination record comes from FRESH destination state read after
    // the switch (the file the live runtime appended to), never from the
    // stale pre-switch manager and never copied from the source.
    const freshForkPoint = warpFreshPoint(targetFile);
    recordBothSides(targetCwd, targetFile, freshForkPoint, sourceIdentity, currentFile, currentPoint);
  } catch {
    // Best effort: the warp already succeeded.
  }
  // After a successful switch only: tell the terminal the new cwd. The
  // helper writes nothing unless the stream is a TTY.
  emitOsc7(options.oscStream || process.stdout, targetCwd);
  return {
    text: moveText,
    details: { name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false, ...handoffCopyDetails() },
  };
}

// ---------------------------------------------------------------------------
// `/warp` (S11): move the SESSION to another
// checkout of the project through a popup selector, or by explicit `<name>`.
//
// WHY its own command instead of a `warp` verb only: S11 wants the
// project's checkouts offered as a selector with the active checkout shown
// as text, and an explicit `<name>` keeps the scripted path. Both paths end
// in the SAME `executeWorktreeWarp` above — one resolver, one mover — so a
// name carried by more than one live checkout keeps failing closed here
// exactly as it does for the `worktree` verb, and the notification, the
// cancelled outcome and the OSC-7 behaviour stay byte for byte. Session
// control (`waitForIdle`, `switchSession`) exists only on a command
// context, which is why this is a command and never a tool.
// ---------------------------------------------------------------------------

// Live, selectable checkouts for the warp selector (S11, S14): the
// principal checkout first, then the registry rows in registry order, then
// the live checkouts the registry does not own (S14 discovery, in git
// listing order) — every entry live through the ONE liveness predicate
// (`checkoutState`: something exists there AND it is a directory AND git
// still lists it), so a hand-deleted checkout or a path replaced by a file
// is never offered. Nothing here is written to the registry: unregistered
// checkouts are offered without being adopted.
function warpOfferedCheckouts(git, read, principal, live, repoRoot) {
  const liveIds = liveIdentities(live, repoRoot);
  const offered = [];
  if (principal) {
    offered.push({ name: "principal", path: principal.path, branch: principal.branch });
  }
  // S10: a registry row naming the principal's own path is the principal
  // entry already offered above, never a second agent row.
  const principalState = principal && typeof principal.path === "string" && principal.path.length > 0
    ? checkoutState(principal.path, repoRoot)
    : null;
  const principalId = principalState && principalState.absolute !== null
    ? (principalState.real !== null ? principalState.real : principalState.absolute)
    : null;
  const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
  // S39: sole claimants offer the CURRENT git branch; shared checkouts keep
  // their stored names so the ambiguity keeps resolving (and every offered
  // name stays warpable through the resolver's live-slug match).
  const liveBranchById = liveBranchMap(live, repoRoot);
  const claimCounts = registryClaimCounts(rows, repoRoot);
  for (const row of rows) {
    if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
    const st = checkoutState(row.path, repoRoot);
    if (!st.exists || !st.isDirectory) continue;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || !liveIds.has(id)) continue;
    if (principalId !== null && id === principalId) continue;
    const liveShown = (claimCounts.get(id) || 0) === 1 ? liveBranchById.get(id) : undefined;
    const shownBranch = liveShown || row.branch;
    const name = slugOf(git, shownBranch);
    if (name === null) continue;
    offered.push({ name, path: id, branch: typeof shownBranch === "string" ? shownBranch : "(detached)" });
  }
  // S14 discovery: live checkouts the registry does not own are offered
  // too (never written or adopted here). A name already offered keeps its
  // registered row: the duplicate fails closed at resolution time instead
  // of hiding a checkout.
  for (const extra of liveUnregisteredEntries(rows, live, repoRoot, principal)) {
    const name = slugOf(git, extra.branch);
    if (name === null) continue;
    offered.push({ name, path: extra.path, branch: extra.branch || "(detached)" });
  }
  return offered;
}

// The active checkout for the warp selector (S11): the checkout containing
// or equal to the command context's cwd, deepest match winning, the
// principal as a candidate — the SAME rule the listing (S19) and the warp
// already-there check use, never a second notion. Identity is the resolved
// realpath with an absolute fallback on both legs (never the process cwd
// and never a lexical resolve alone), so a symlink spelling of a checkout
// still matches it. Returns the identity string, or null when the session
// sits outside every checkout.
function warpActiveIdentity(live, repoRoot, principal, fromCwd) {
  const sessionState = checkoutState(fromCwd, repoRoot);
  const sessionId = sessionState.real !== null ? sessionState.real : sessionState.absolute;
  if (sessionId === null) return null;
  const ids = [];
  if (principal && typeof principal.path === "string" && principal.path.length > 0) ids.push(principal.path);
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    const id = st.real !== null ? st.real : st.absolute;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  let active = null;
  for (const id of ids) {
    if (sessionId === id || sessionId.startsWith(id + path.sep)) {
      if (active === null || id.length > active.length) active = id;
    }
  }
  return active;
}

// The title entry for the warp selector (S11): the active checkout as
// `{name, path}`, resolved against the offered rows first (so the title
// spells the checkout exactly as the options would), then against the live
// listing for a checkout the registry does not own. A session outside
// every checkout titles itself honestly instead of inventing one.
function warpTitleEntry(git, offered, live, repoRoot, active, fromCwd) {
  const current = offered.find((entry) => entry.path === active);
  if (current) return current;
  if (active !== null) {
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id === active) {
        return { name: slugOf(git, entry.branch) || "worktree", path: active };
      }
    }
  }
  return { name: "unknown", path: fromCwd };
}

// Startup + warp-time discovery (S14): the project's
// live checkouts, refreshed on `session_start` and freshly on every warp
// invocation, so the selector sees checkouts created or closed since the
// session started — including live checkouts the registry does not own.
// Read-only by construction: the scan never writes the registry, never
// adopts anything, never throws. The last successful scan is kept in
// `warpDiscoveryCache` for inspection; every warp still lists fresh before
// acting, so a stale cache can never move the session somewhere stale.
let warpDiscoveryCache = null;

function noteWarpDiscovery(repoRoot, live) {
  warpDiscoveryCache = { repoRoot, live, at: Date.now() };
  return warpDiscoveryCache;
}

// Best-effort live scan for `session_start`: `{repo, live}` or null when
// the session is outside a repository or git cannot list. Never throws,
// never touches the registry.
//
// It reads through the async runner: the sync readers resolve via
// `spawnSync`, which froze the host event loop for the whole scan. Resolves to
// the identical `{repo, live}` shape, or null for the same reasons; never
// rejects. Falls back to the sync readers only when an older installed lib copy
// does not carry the async twins.
async function scanLiveCheckouts(cwd) {
  try {
    const git = libRequire("worktree-git.js");
    const from = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
    const repo = typeof git.repoIdentityAsync === "function"
      ? await git.repoIdentityAsync(from)
      : git.repoIdentity(from);
    const live = typeof git.listWorktreesAsync === "function"
      ? await git.listWorktreesAsync(repo.root)
      : git.listWorktrees(repo.root);
    return { repo, live };
  } catch {
    return null;
  }
}

// Startup work that must not sit on the host's AWAITED `session_start` path
// (the host awaits every handler it is handed, one at a time, so any awaited
// probe delays the first prompt by its own duration) still has to stay honest
// about which session it belongs to: a verdict or a registration that lands
// after `session_shutdown` must not notify a dead UI or write into the session
// that replaced it. Every dispatch captures the epoch below; shutdown advances
// it, so late work drops instead of leaking across sessions.
let startupEpoch = 0;
const startupTasks = new Set();

function beginStartupTask() {
  return startupEpoch;
}

function startupTaskLive(epoch) {
  return epoch === startupEpoch;
}

// Track a deferred startup task until it settles. The tracked promise never
// rejects: a throwing phase settles into silence instead of an unhandled
// rejection, and nothing is left unobserved.
function trackStartupTask(task) {
  const tracked = Promise.resolve(task).then(() => undefined, () => undefined);
  startupTasks.add(tracked);
  const forget = () => { startupTasks.delete(tracked); };
  tracked.then(forget, forget);
  return tracked;
}

// The ONE startup task whose completion `session_start` still waits for: the
// discovery registration, because the registry it appends to is read by the
// very next thing the session does. It is dispatched ahead of the other
// startup work and awaited LAST, so the probes overlap and the host waits for
// the slowest one instead of their sum.
let startupRegistration = null;

// Resolves once every deferred startup task has settled. Exported for tests and
// for a shutdown path that must not leave work behind it.
async function awaitPendingStartupTasks() {
  while (startupTasks.size > 0) {
    await Promise.all(Array.from(startupTasks));
  }
}

// The discovery body the deferred startup task runs: scan, refresh the warp
// cache, register the live checkouts the registry does not own. Read-only
// outside the registry's own append, never throws, and a task whose session
// ended before git answered drops instead of writing into the session that
// replaced it. Returns the scan for tests and in-process callers.
async function runStartupDiscovery(cwd, epoch) {
  try {
    const scanned = await scanLiveCheckouts(cwd);
    if (scanned === null) return null;
    if (!startupTaskLive(epoch)) return null;
    noteWarpDiscovery(scanned.repo.root, scanned.live);
    try {
      const registry = libRequire("worktree-registry.js");
      let principalId = null;
      try {
        if (typeof scanned.repo.commonDir === "string" && path.basename(scanned.repo.commonDir) === ".git") {
          const rawPrincipal = path.resolve(path.dirname(scanned.repo.commonDir));
          const pst = checkoutState(rawPrincipal, scanned.repo.root);
          principalId = pst.real !== null ? pst.real : pst.absolute;
        }
      } catch {
        principalId = null;
      }
      if (typeof registry.registerMissingWorktrees === "function") {
        // S1: discovery only appends rows for live checkouts. It
        // addresses no stored row, so it drops nothing and has no
        // association to report.
        registry.registerMissingWorktrees(scanned.repo.root, scanned.live, principalId);
      }
    } catch {
      // Discovery registration is best-effort: the warp cache above
      // already recorded the scan.
    }
    return scanned;
  } catch {
    return null;
  }
}
function registerWarpMessageRenderer(pi) {
  if (typeof pi?.registerMessageRenderer !== "function") return;
  try {
    const factory = libRequire("worktree-card.js");
    if (typeof factory.createWarpMessageRenderer !== "function") return;
    // Resolved per render (memoized by dependency identity) because the
    // session UI — hence the click seam — is only known after `session_start`,
    // long after this registration runs.
    let cache = null;
    pi.registerMessageRenderer("worktree-warp", (message, options, theme) => {
      const deps = worktreeCardDeps();
      if (!cache || cache.deps !== deps) {
        cache = { deps, render: factory.createWarpMessageRenderer(deps) };
      }
      return cache.render(message, options, theme);
    });
  } catch {
    // The default block still shows the notice; the warp itself is unaffected.
  }
}

// S45: the warp selector's FINAL entry — create a worktree from the
// selector, in TWO steps: the change TYPE first, then the change NAME.
// S47: plain action text with an ellipsis (never the em-dash path shape
// of a checkout row, so it can never collide with one) and always last.
// There is deliberately NO separator row above it: the host selector
// takes a plain string array where EVERY row is selectable
// (ExtensionSelectorComponent moves and confirms over all indices — no
// disabled flag, no divider, no header concept), so a fake blank row
// would itself be pickable. The old `+ ` prefix is gone for the same
// alignment reason the user flagged.
const WARP_CREATE_ENTRY = "Create new worktree…";

// S45: the Conventional Commit change types (skills/branch-pr/SKILL.md),
// in the skill's order with its human labels. `feat` rides first on
// purpose: the host selector highlights the first row, so the default
// highlight lands on it with no extra API.
const WARP_CHANGE_TYPES = [
  { id: "feat", label: "Feature" },
  { id: "fix", label: "Bug fix" },
  { id: "chore", label: "Chore" },
  { id: "docs", label: "Docs" },
  { id: "style", label: "Style" },
  { id: "refactor", label: "Refactor" },
  { id: "perf", label: "Performance" },
  { id: "test", label: "Test" },
  { id: "build", label: "Build" },
  { id: "ci", label: "CI" },
  { id: "revert", label: "Revert" },
];
// Branch names MUST match the skill's shape: `<type>/<slug>`.
const WARP_CREATE_BRANCH_RE = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$/;

// The create panel is the selector's create completion: it asks for exactly
// TWO things — the change type, then the change name (S6) — and then
// `executeWorktreeCreate` runs. It never prompts, the type plus the typed
// name the panel collected is the human intent, and the session warps into
// the fresh checkout. A creation supplies NEITHER `issues` nor `odd`: a
// brand-new row is born without an association, so the invalid, duplicate,
// occupied and principal refusals keep their exact shape.

// The warp surface's overlay geometry (T3/S3-S4, L6). The SELECTOR keeps a
// focusable `ctx.ui.custom()` overlay — gentle-shell's `setWidget()` panel is
// display-only and cannot take keys — but only its geometry changes: anchored
// at the bottom, full width, no margin and no minimum width, so it reads as a
// bottom panel. Its height is the view's own content (S4), never a fixed
// frame, and `rowsAvailable` is the ceiling it may use. Creation uses the same
// bottom geometry with its own compact content height; editing is fullscreen.
const WARP_OVERLAY_MAX_ROWS = 24;
const WARP_SELECTOR_OVERLAY = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({ anchor: "bottom-center", width: "100%", margin: 0 }),
});
const WARP_PANEL_OVERLAY = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({ anchor: "bottom-center", width: "100%", margin: 0, maxHeight: WARP_OVERLAY_MAX_ROWS }),
});
// The pending-changes question is a step of this flow like the panel is, so it
// mounts with the same bottom geometry. Mounted bare it painted as a
// fullscreen component in the middle of the flow, which read as a different
// surface than the panel that had just asked for it.
const WARP_QUESTION_OVERLAY = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({ anchor: "bottom-center", width: "100%", margin: 0 }),
});
function warpOverlayRows(hostTui) {
  let rows = WARP_OVERLAY_MAX_ROWS;
  try {
    const value = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
    if (Number.isFinite(value) && value > 0) rows = value;
  } catch {
    // A hostile host object never breaks the view.
  }
  return Math.min(rows, WARP_OVERLAY_MAX_ROWS);
}

// Map lib/checkout-facts.js's per-fact envelopes to the flat shape
// lib/warp-selector-view.js renders. Each fact stays independently
// honest (S9): an unavailable read is the literal `unavailable`, never
// zero and never an empty list, so the popup can say so.
function warpFactsForView(entry) {
  if (!entry || typeof entry !== "object") return null;
  const value = (fact) => (fact && fact.available === true ? fact.value : "unavailable");
  const branch = entry.branch && entry.branch.available === true
    ? (entry.branch.detached === true || entry.branch.value === null ? "detached" : entry.branch.value)
    : "unavailable";
  const changes = entry.changes && entry.changes.available === true && entry.changes.value
    ? { added: entry.changes.value.added, deleted: entry.changes.value.deleted }
    : "unavailable";
  const compared = entry.aheadBehind && entry.aheadBehind.available === true ? entry.aheadBehind.value : null;
  // S1: the view is handed NO association. `lib/checkout-facts.js` stopped
  // reading `issues`/`odd` facts at all, so mapping them here would only
  // project two permanent "unavailable" cells for a worktree that carries
  // neither an issue list nor an ODD document.
  return {
    branch,
    changes,
    ahead: compared ? compared.ahead : "unavailable",
    behind: compared ? compared.behind : "unavailable",
    createdAt: value(entry.createdAt),
    // S12: the footer names both ages, so the activity fact travels with
    // its reason instead of being dropped here.
    lastActivity: value(entry.lastActivity),
    lastActivityReason: entry.lastActivity && entry.lastActivity.available === false
      && typeof entry.lastActivity.reason === "string"
      ? entry.lastActivity.reason
      : undefined,
  };
}

// Injectable seam for the warp selector's checkout-facts provider (tests):
// production leaves it null and the loop builds lib/checkout-facts.js. Tests
// inject a deterministic delayed provider to prove the selector mounts before
// the facts resolve.
let warpFactsFactory = null;

function setWarpFactsFactory(factory) {
  warpFactsFactory = typeof factory === "function" ? factory : null;
}

// The checkouts the popup hands its view at MOUNT time (S1): only the
// synchronous `peek` cache is read — never a git spawn — so the first frame
// paints immediately and a re-mount reuses whatever ages were already read.
// A checkout with no cached facts keeps no timestamp (it sorts last until the
// background enrichment arrives).
function warpCheckoutsWithCachedActivity(checkoutFacts, entries) {
  const rows = Array.isArray(entries) ? entries : [];
  if (!checkoutFacts || typeof checkoutFacts.peek !== "function") return rows;
  return rows.map((entry) => {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return entry;
    let facts = null;
    try {
      facts = checkoutFacts.peek(entry.path);
    } catch {
      facts = null;
    }
    if (!facts) return entry;
    const activity = facts.lastActivity;
    return {
      ...entry,
      lastActivity: activity,
      createdAt: facts.createdAt,
      lastActivityReason: activity && activity.available === false && typeof activity.reason === "string"
        ? activity.reason
        : undefined,
    };
  });
}

// The checkouts the popup hands its view: every row carries its own
// lastActivity and createdAt, so the VIEW orders the list newest-first and
// no caller re-sorts (S12, S15). The reads share lib/checkout-facts.js's
// cache, and a checkout whose value cannot be read keeps no timestamp and
// sorts last with its reason attached (S9).
async function warpCheckoutsWithActivity(checkoutFacts, entries) {
  const rows = Array.isArray(entries) ? entries : [];
  if (!checkoutFacts || typeof checkoutFacts.facts !== "function") return rows;
  return Promise.all(rows.map(async (entry) => {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return entry;
    let facts = null;
    try {
      facts = await checkoutFacts.facts(entry.path);
    } catch {
      facts = null;
    }
    if (!facts) return entry;
    const activity = facts.lastActivity;
    return {
      ...entry,
      lastActivity: activity,
      createdAt: facts.createdAt,
      lastActivityReason: activity && activity.available === false && typeof activity.reason === "string"
        ? activity.reason
        : undefined,
    };
  }));
}

// S2: the invoking checkout's pending work, offered ONCE at creation time.
//
// The human answers the same YES COPY / NO COPY question (and gets the same
// Esc-means-cancel behaviour) the warp already asks, through the SAME helper
// and the SAME injectable seam (`setWarpDirtyAsker`) — never a second prompt
// implementation. The answer becomes the create path's own `changes`
// selection ("all" or "none"), so the transfer, its preflight and its refusals
// stay in one place. `asked` says whether the human actually answered (a clean
// checkout answers nothing), because the ONE warp that follows this create must
// not ask the same question a second time. Returns {ok:true, copy, asked} /
// {cancelled:true}; never throws.
async function askCreatePendingChanges({ ctx, git, fromCheckout }) {
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch {
    changesLib = null;
  }
  // No helper means the pending set CANNOT be read, which is not the same as
  // "nothing pending": the caller refuses instead of creating blind.
  if (!changesLib || typeof changesLib.summarizeChanges !== 'function') {
    return { error: 'the pending-changes helper is unavailable (lib/worktree-changes.js could not load)' };
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(fromCheckout, { git });
  } catch (err) {
    summary = { ok: false, error: (err && err.message) || String(err) };
  }
  // FAIL CLOSED (S2): only a POSITIVE "nothing pending" answer skips the
  // question. An unreadable summary is not clean — creating from it would
  // silently leave the human's pending work behind right after they asked for a
  // worktree — so the creation is refused with the reason instead.
  if (!summary || summary.ok !== true) {
    return { error: `cannot read the pending changes of ${fromCheckout} (${(summary && summary.error) || 'unknown error'})` };
  }
  if (summary.files === 0) return { ok: true, copy: false, asked: false };
  const summaryLine = `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}`;
  const choice = await askWarpDirtyChoice(ctx, summaryLine);
  if (choice === null) return { cancelled: true };
  return { ok: true, copy: choice === 'yes', asked: true };
}

// Create-then-return (S7): the selector's create completion mounts the
// TWO-STEP panel (S6: the change type, then the change name) as an overlay,
// then runs the SAME creation path `worktree_create` uses — which never
// prompts — and STOPS there. Creation is creation: nothing is warped by
// itself, so the caller can hand the selector back with a fresh listing that
// includes the checkout just made, and the human picks where the session
// goes. The creation carries neither `issues` nor `odd`, so a new row is born
// without an association and the invalid, duplicate, occupied and principal
// refusals keep their shape.
//
// It ALWAYS reports `{ closed: true, created, cancelled?, worktree?, branch? }`
// once the panel closed, so the caller hands the selector back every time: a
// creation, a refusal (its reason already notified, `created: false`) and a
// CANCEL (`cancelled: true`, nothing written) all return to the selector, which
// is what closing the flow means. Only the paths that never reached a panel at
// all (no host UI, the panel cannot load, the panel threw — each already
// notified) return `undefined` and end the flow.
async function warpCreateAndEnter(ctx, git, notify) {
  if (!ctx || !ctx.ui || typeof ctx.ui.custom !== "function") {
    notify?.("warp: the host UI cannot open the create panel here; create one with the worktree_create tool first, then /warp <name>.", "error");
    return undefined;
  }
  let panelLib = null;
  try {
    panelLib = libRequire("warp-create-panel.js");
  } catch (err) {
    notify?.(`warp: the create panel cannot load (${(err && err.message) || err}); nothing was created.`, "error");
    return undefined;
  }
  if (!panelLib || typeof panelLib.createWarpCreatePanel !== "function") {
    notify?.("warp: the create panel cannot load; nothing was created.", "error");
    return undefined;
  }
  let helpers = null;
  try {
    helpers = await warpTuiLoader();
  } catch {
    helpers = null;
  }
  const panelCwd = toolCwd(ctx);
  let out;
  try {
    out = await ctx.ui.custom(
      (hostTui, theme, _keybindings, done) => panelLib.createWarpCreatePanel({
        cwd: panelCwd,
        changeTypes: WARP_CHANGE_TYPES,
        git,
        helpers,
        hostTui,
        theme,
        principalLayout: true,
        rowsAvailable: () => warpOverlayRows(hostTui),
        done,
      }),
      WARP_PANEL_OVERLAY,
    );
  } catch (err) {
    notify?.(`warp: the create panel failed (${(err && err.message) || err}); nothing was created.`, "error");
    return undefined;
  }
  // Esc cancels the CREATION quietly — no branch, no checkout, no registry row
  // — and hands the SELECTOR back like every other way this flow closes (S7):
  // the user asked for the selector to return after the create flow closes, so
  // a human who changes their mind about the name still picks where the session
  // goes, including any checkout just made. `cancelled` distinguishes this from
  // a refusal; closing the RETURNED selector is what ends the flow.
  if (!out || out.ok !== true) return { closed: true, created: false, cancelled: true };
  const rawName = typeof out.name === "string" ? out.name.trim() : "";
  const branch = `${out.type}/${git.slugifyBranch(rawName)}`;
  if (!WARP_CREATE_BRANCH_RE.test(branch)) {
    notify?.(`warp: invalid change name ${JSON.stringify(out.name)}: use at least one letter or digit (for example "name-change"); nothing was created.`, "error");
    return { closed: true, created: false };
  }
  const createParams = { branch };
  // S2: before anything is written, offer the invoking checkout's pending work:
  // the new worktree is either born from the commit or carries what is pending
  // here. A cancel (Esc / Ctrl+C at the question) is a real outcome — no
  // branch, no checkout, no registry row — and hands the selector back like
  // every other way this flow closes.
  const pending = await askCreatePendingChanges({ ctx, git, fromCheckout: panelCwd });
  if (pending.error) {
    // The one thing a create may never do is silently skip the question: the
    // reason is visible (error level), the creation is refused with nothing
    // written, and the selector comes back like every other closed flow.
    notify?.(`warp: the creation was refused: ${pending.error}; nothing was created (fix the checkout's git state and retry)`, 'error');
    return { closed: true, created: false };
  }
  if (pending.cancelled) {
    // Esc/Ctrl+C at the question cancels the CREATION silently, exactly like
    // `esc` on the panel itself: nothing was written, so nothing is reported.
    return { closed: true, created: false, cancelled: true };
  }
  createParams.changes = pending.copy ? 'all' : 'none';
  // S53: the git-only route — a plain git checkout plus the registry row,
  // never a Herdr workspace — reusing the same creation path (validations,
  // refusals, registration), which never prompts. The layout is
  // principal-anchored (S56): the new checkout lands beside the PRINCIPAL
  // checkout even when the panel runs inside a linked worktree, while the
  // branch base is local main (S2).
  //
  // `backgroundHooks` is what makes a confirmed create feel instant: the
  // checkout path is all the warp needs, so the slow setup (install, codegraph)
  // runs behind it and reports itself when it settles. The pending-change copy
  // is still AWAITED inside the create — it must be complete before the session
  // can move, or the human would switch into a checkout that is missing the
  // work they just asked to carry.
  const created = await executeWorktreeCreate(createParams, ctx, {
    gitOnly: true,
    principalLayout: true,
    backgroundHooks: true,
    ...(typeof notify === 'function' ? { notify } : {}),
  });
  if (created && created.isError) {
    // The refusal is a TOOL result, so its words live in `content[].text`
    // (`toolResultText`): it is reported verbatim, because it already names the
    // cause and the next step. An empty refusal still says something truthful
    // instead of notifying `undefined`.
    const reason = toolResultText(created);
    notify?.(reason !== "" ? reason : "warp: the creation was refused; nothing was created.", "error");
    // S7: the panel closed and the create was attempted, so the caller hands
    // the selector back instead of ending the flow on a refusal.
    return { closed: true, created: false };
  }
  const storedBranch = created && created.details && typeof created.details.branch === "string"
    ? created.details.branch
    : branch;
  // S7: the created checkout is a selector ROW, never an automatic move. The
  // name travels back so the caller can report/focus it; the session stays
  // exactly where it is until the human chooses. `dirtyAsked` tells the caller
  // that the pending-changes question was ALREADY answered in this flow, so the
  // one warp that follows must not ask it again.
  return {
    closed: true,
    created: true,
    worktree: slugOf(git, storedBranch) || storedBranch,
    branch: storedBranch,
    dirtyAsked: pending.asked === true,
    dirtyCopy: pending.copy === true,
  };
}

async function warpDeleteCheckout(targetPath, ctx, deps) {
  const git = deps.git;
  const registry = deps.registry;
  const repo = deps.repo;
  const notify = deps.notify;
  const offered = Array.isArray(deps.offered) ? deps.offered : [];
  const principal = deps.principal && typeof deps.principal === "object" ? deps.principal : null;
  const active = typeof deps.active === "string" && deps.active.length > 0 ? deps.active : null;
  let confirmLib = null;
  try {
    confirmLib = libRequire("warp-delete-confirm.js");
  } catch {
    confirmLib = null;
  }
  if (!confirmLib
    || typeof confirmLib.readWarpDeleteEvidence !== "function"
    || typeof confirmLib.warpDeletePrompt !== "function"
    || typeof confirmLib.warpDeleteEvidenceKey !== "function") {
    notify?.("warp: cannot delete a worktree here: the removal disclosure is unavailable; nothing was removed.", "error");
    return;
  }

  // 1. The exact checkout this selector listed, or nothing.
  const target = offered.find((entry) => entry && entry.path === targetPath) || null;
  if (!target) {
    notify?.(`warp: refusing to delete ${JSON.stringify(targetPath)}: it is not one of the checkouts this selector listed; nothing was removed.`, "error");
    return;
  }
  const targetState = checkoutState(target.path, repo.root);
  const targetId = targetState.real !== null ? targetState.real : targetState.absolute;
  // The identity the human is shown and the only checkout this removal may
  // ever name: the path the selector listed, which is a live checkout's own
  // realpath (`warpOfferedCheckouts` offers `st.real`). Everything below pins
  // to this value, never to whatever the path resolves to later.
  const approvedReal = targetState.absolute !== null ? targetState.absolute : path.resolve(target.path);

  // 2. The project itself is never a deletion target.
  if (principal && typeof principal.path === "string" && principal.path.length > 0) {
    const principalState = checkoutState(principal.path, repo.root);
    const principalId = principalState.real !== null ? principalState.real : principalState.absolute;
    if (targetId !== null && principalId !== null && targetId === principalId) {
      notify?.(`warp: refusing to delete the principal checkout at ${principal.path}: it is the project itself; nothing was removed.`, "error");
      return;
    }
  }

  // 3. Neither is the checkout this session stands on.
  if (active !== null) {
    const activeState = checkoutState(active, repo.root);
    const activeId = activeState.real !== null ? activeState.real : activeState.absolute;
    const coversTarget = activeId !== null && targetId !== null
      && (activeId === targetId || activeId.startsWith(targetId + path.sep));
    if (coversTarget) {
      notify?.(`warp: refusing to delete the checkout this session is running in (${target.path}): warp to another checkout first; nothing was removed.`, "error");
      return;
    }
  }

  // S7/S8/S9: the SAME active-session guard `worktree_close` runs, and it runs
  // BEFORE anything reads the pending changes or builds the deletion question.
  // A keypress may never turn into a confirmation dialog for a checkout a live
  // Pi session is working in: the human is told to finish/warp that session
  // first, and the checkout is left exactly as it was. `approvedReal` is the
  // identity the panel listed, so the guard is asked about the same checkout the
  // human is looking at.
  const sessionCheck = await checkoutSessionGuard({ ctx, target: approvedReal });
  if (sessionCheck.refused) {
    notify?.(sessionCheck.text, 'error');
    return;
  }

  // 4. Only a REGISTERED worktree can be closed: the shared close resolves its
  // target through the registry, so a live checkout nobody registered would be
  // asked about and then refused. That is a question a human cannot act on, so
  // it is refused here instead — before the dialog.
  let registered = null;
  try {
    registered = registry.findByPath(repo.root, target.path);
  } catch {
    registered = null;
  }
  if (!registered) {
    notify?.(`warp: refusing to delete ${target.path}: it is a live checkout this repository's worktree registry does not own; nothing was removed.`, "error");
    return;
  }

  // 5. The BEFORE reading: one snapshot of the exact target (its registered
  // row, its LIVE branch, whether it is still a live checkout) together with
  // the disclosure. The same snapshot is taken again AFTER the answer, and each
  // component is compared with its OWN earlier value — never the live branch
  // against the registry row, which legitimately disagree (the listing offers a
  // sole claimant's CURRENT branch, while the row stores the branch it was
  // registered with; B1: comparing the two refused every such deletion).
  const before = await warpDeleteSnapshot({ git, registry, repo, targetPath: target.path, confirmLib });
  if (before.ok !== true) {
    notify?.(before.text, "error");
    return;
  }
  // 5b. The path must STILL BE the checkout the selector listed. A swap that
  // landed between the listing and this reading leaves every other component
  // identical (two DETACHED checkouts share an unknown live branch and the
  // same disclosure), so the identity is the only fact that reveals it — and
  // it is checked here, before any question is asked about a path that no
  // longer names the checkout the human believes they are answering about.
  if (before.identity.real === null || before.identity.real !== approvedReal) {
    notify?.(`warp: refusing to delete ${target.path}: it no longer resolves to the checkout this selector listed (it now resolves to ${warpIdentityWords(before.identity)}); nothing was removed — reopen the warp selector to review the checkouts.`, "error");
    return;
  }
  // 5c. The approved DIRECTORY is pinned too, not only its spelling: the
  // device/inode pair of the object at that path. `dev`/`ino` are read from the
  // SAME reading that just matched the selector's identity, and they travel
  // into the shared close, which re-reads them immediately before the remover
  // is launched — that is what catches a path replaced by ANOTHER directory
  // (identical spelling, identical realpath, different object), the one swap a
  // realpath comparison cannot see. An unreadable pair is a REFUSAL: without it
  // the removal cannot say which directory it is about to destroy.
  if (typeof before.identity.dev !== "number" || typeof before.identity.ino !== "number") {
    notify?.(`warp: refusing to delete ${target.path}: the identity of its directory could not be read, so a path replaced by another directory could not be told apart; nothing was removed — retry, or close it with the worktree_close tool.`, "error");
    return;
  }
  const approvedPin = { real: approvedReal, dev: before.identity.dev, ino: before.identity.ino };
  const evidence = before.evidence;

  // 5a. FAIL CLOSED on unknown evidence: if the pending work cannot be read —
  // the change summary, the CONTENT fingerprint that binds the counts to real
  // bytes, or the ignored files that die with the checkout — nothing can say
  // what this deletion would destroy, so there is no honest question to ask and
  // no answer that could authorize it.
  const changes = evidence.changes && typeof evidence.changes === "object" ? evidence.changes : null;
  if (!changes || changes.status === "unknown") {
    const reason = changes && typeof changes.reason === "string" && changes.reason.length > 0
      ? changes.reason
      : "the change summary failed";
    notify?.(`warp: refusing to delete ${target.path}: its uncommitted changes could not be read (${reason}), so nothing can say what would be lost; nothing was removed — retry, or close it with the worktree_close tool.`, "error");
    return;
  }
  const content = evidence.content && typeof evidence.content === "object" ? evidence.content : null;
  if (!content || content.status !== "known") {
    const reason = content && typeof content.reason === "string" && content.reason.length > 0
      ? content.reason
      : "the pending content could not be fingerprinted";
    notify?.(`warp: refusing to delete ${target.path}: what is pending in it could not be fingerprinted (${reason}), so an identical +/- count could hide different work; nothing was removed — retry, or close it with the worktree_close tool.`, "error");
    return;
  }
  const ignored = evidence.ignored && typeof evidence.ignored === "object" ? evidence.ignored : null;
  if (!ignored || ignored.status === "unknown") {
    const reason = ignored && typeof ignored.reason === "string" && ignored.reason.length > 0
      ? ignored.reason
      : "the ignored-file listing failed";
    notify?.(`warp: refusing to delete ${target.path}: the files git ignores there could not be listed (${reason}), so the removal could destroy work nobody was shown; nothing was removed — retry, or close it with the worktree_close tool.`, "error");
    return;
  }

  const prompt = confirmLib.warpDeletePrompt(
    { name: target.name, path: target.path, branch: target.branch },
    evidence,
  );

  // 6. Always asked. No permission mode is read on this path.
  if (!ctx || !ctx.ui || typeof ctx.ui.confirm !== "function") {
    notify?.(`warp: cannot delete ${target.path}: this host cannot ask the confirmation a removal requires; nothing was removed.`, "error");
    return;
  }
  let approved = false;
  try {
    approved = await ctx.ui.confirm(prompt.title, prompt.body);
  } catch {
    approved = false;
  }
  if (!approved) {
    notify?.(`worktree delete cancelled: nothing was removed at ${target.path}.`, "info");
    return;
  }

  // 7. Revalidate the EXACT target and its evidence after the answer, so a
  // checkout that changed while the dialog was open is never removed on the
  // strength of what the human read a moment ago.
  const after = await warpDeleteSnapshot({ git, registry, repo, targetPath: target.path, confirmLib });
  if (after.ok !== true) {
    notify?.(after.text, "error");
    return;
  }
  const moved = warpDeleteSnapshotDelta(before, after);
  if (moved.length > 0) {
    notify?.(`refusing to delete ${target.path}: the checkout changed while the confirmation was open (${moved.join("; ")}); nothing was removed — run the delete again to review the new state.`, "error");
    return;
  }

  // 8. The shared close, told its own dialog already happened. `force` still
  // comes only from positive dirty evidence. `expectedReal` carries the
  // approval into the removal itself: the close re-reads the identity right
  // before it names a checkout to a backend, so the narrowest possible window
  // remains between that read and the remover. It also RE-RUNS the
  // active-session guard immediately before the removal, so a session that
  // started working in the checkout while the question was open refuses there
  // (S8: the check precedes the question, and it is repeated after it).
  let result;
  try {
    result = await executeWorktreeClose({ path: target.path, force: prompt.force === true }, ctx, { approved: true, expectedReal: approvedReal, expectedPin: approvedPin });
  } catch (err) {
    notify?.(`worktree delete failed at ${target.path}: ${(err && err.message) || err}; inspect the checkout before retrying.`, "error");
    return;
  }
  if (result && result.isError === true) {
    const reason = toolResultText(result) || "the removal reported no reason";
    notify?.(`worktree delete failed at ${target.path}: ${reason}`, "error");
    return;
  }
  notify?.(`worktree deleted: ${target.name} · ${target.path}; the branch '${target.branch}' is kept.`, "info");
}

// The EXACT checkout a deletion names, read on both sides of the question.
// `absolute` is the path the selector offered, `real` the checkout that path
// resolves to right now, and `link`/`linkTarget` say whether that path IS a
// symbolic link — the shape a swap takes, because every offered row is a live
// checkout's own realpath (`warpOfferedCheckouts`), never a link.
function warpDeleteIdentity(targetPath, repoRoot) {
  const state = checkoutState(targetPath, repoRoot);
  let link = false;
  let linkTarget = null;
  let dev = null;
  let ino = null;
  if (state.absolute !== null) {
    try {
      link = fs.lstatSync(state.absolute).isSymbolicLink();
      if (link) linkTarget = fs.readlinkSync(state.absolute);
    } catch {
      // A path that cannot be lstat'ed is not readable as a link; `exists`
      // already reports that it is not there.
      link = false;
      linkTarget = null;
    }
    // The DIRECTORY behind the path (`statSync` follows a link, which is
    // reported above): its device/inode pair is what tells the approved
    // checkout apart from a different directory later placed at the same path,
    // which a realpath comparison cannot see. Best-effort: `null` means the
    // reading is unavailable, and callers decide whether that fails closed.
    try {
      const stats = fs.statSync(state.absolute);
      dev = typeof stats.dev === "number" ? stats.dev : null;
      ino = typeof stats.ino === "number" ? stats.ino : null;
    } catch {
      dev = null;
      ino = null;
    }
  }
  return {
    absolute: state.absolute,
    real: state.real,
    exists: state.exists,
    isDirectory: state.isDirectory,
    link,
    linkTarget,
    dev,
    ino,
  };
}

// Two readings name the same checkout through the same kind of path only when
// every one of these agrees. A realpath that moved is a different checkout; a
// path that became a link (or stopped being one) is a different spelling, so
// whatever a remover resolves it to is no longer the approved target; and a
// `dev`/`ino` pair that moved is a DIFFERENT directory reached through the same
// spelling — the one swap a realpath comparison alone cannot see.
function warpSameIdentity(before, after) {
  const a = before && typeof before === "object" ? before : {};
  const b = after && typeof after === "object" ? after : {};
  return (a.real ?? null) === (b.real ?? null)
    && a.link === b.link
    && (a.linkTarget ?? null) === (b.linkTarget ?? null)
    && a.exists === b.exists
    && a.isDirectory === b.isDirectory
    && (a.dev ?? null) === (b.dev ?? null)
    && (a.ino ?? null) === (b.ino ?? null);
}

// What the path is NOW, in the human's words, for a refusal. A link is named
// with the target it carries and what that resolves to, because "a symlink"
// alone does not say which checkout a remover would reach.
function warpIdentityWords(identity) {
  const read = identity && typeof identity === "object" ? identity : {};
  const real = typeof read.real === "string" ? `'${read.real}'` : "nothing (the path does not resolve)";
  if (read.link === true) {
    const target = typeof read.linkTarget === "string" ? `'${read.linkTarget}'` : "an unreadable target";
    return `a symbolic link to ${target}, which resolves to ${real}`;
  }
  return real;
}

// One reading of the deletion target, taken BEFORE the question and again after
// the answer. Every component is compared with its own twin:
//   - `identity`: the checkout the path resolves to, and whether that path is a
//     symbolic link (see `warpSameIdentity`),
//   - `registered`: the registry row's branch (the row is what the close
//     resolves),
//   - `live`: whether the checkout is still live AND the branch git reports for
//     it (whichever branch it is on — the listing offers a sole claimant's
//     CURRENT branch, so a checkout that was moved to another branch before the
//     dialog is normal and must never look like a mismatch),
//   - `evidence`: the disclosure, whose key covers counts, pending CONTENT and
//     the ignored-file list.
// A component that cannot be read makes the whole snapshot `ok:false`, because
// a comparison against an unreadable value would either pass on nothing or
// refuse on nothing.
async function warpDeleteSnapshot({ git, registry, repo, targetPath, confirmLib }) {
  let freshRead;
  try {
    freshRead = registry.readRegistry(repo.root);
  } catch (err) {
    return { ok: false, text: `refusing to delete ${targetPath}: the worktree registry could not be read (${(err && err.message) || err}); nothing was removed.` };
  }
  if (!freshRead || freshRead.ok !== true) {
    return { ok: false, text: `refusing to delete ${targetPath}: the worktree registry could not be read (${(freshRead && freshRead.error) || "unknown error"}); nothing was removed.` };
  }
  let row = null;
  try {
    row = registry.findByPath(repo.root, targetPath);
  } catch {
    row = null;
  }
  let live;
  try {
    live = await git.listWorktreesAsync(repo.root, { runAsync: libRunner(git) });
  } catch (err) {
    return { ok: false, text: `refusing to delete ${targetPath}: the live worktree listing could not be read (${(err && err.message) || err}); nothing was removed.` };
  }
  const listing = Array.isArray(live) ? live : [];
  const liveIds = liveIdentities(listing, repo.root);
  const identityRead = warpDeleteIdentity(targetPath, repo.root);
  const identity = identityRead.real !== null ? identityRead.real : identityRead.absolute;
  const isLive = identity !== null && identityRead.exists && identityRead.isDirectory && liveIds.has(identity);
  // The branch git reports for THAT identity, never for another spelling of it.
  let liveBranch = null;
  if (isLive) {
    for (const entry of listing) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const entryState = checkoutState(entry.path, repo.root);
      const entryId = entryState.real !== null ? entryState.real : entryState.absolute;
      if (entryId !== identity) continue;
      if (typeof entry.branch === "string" && entry.branch.length > 0) liveBranch = entry.branch;
      break;
    }
  }
  const evidence = await confirmLib.readWarpDeleteEvidence(targetPath, { git });
  return {
    ok: true,
    identity: identityRead,
    registered: { present: row !== null, branch: row && typeof row.branch === "string" ? row.branch : null },
    live: { present: isLive, branch: liveBranch },
    evidence,
    evidenceKey: confirmLib.warpDeleteEvidenceKey(evidence),
  };
}

// What moved between the confirmed reading and the one taken before the removal,
// in the human's words. An empty list is the only state in which the deletion
// may proceed; every entry names ONE component, so a message never says
// "something changed" without saying what.
function warpDeleteSnapshotDelta(before, after) {
  const moved = [];
  // FIRST, because it outranks everything else: when the path stopped naming
  // the approved checkout, no other matching component means anything.
  if (!warpSameIdentity(before.identity, after.identity)) {
    const beforeLink = !!(before.identity && before.identity.link === true);
    const afterLink = !!(after.identity && after.identity.link === true);
    const sameResolution = (before.identity.real ?? null) === (after.identity.real ?? null);
    const sameKind = beforeLink === afterLink
      && (before.identity.linkTarget ?? null) === (after.identity.linkTarget ?? null);
    if (!beforeLink && afterLink) {
      moved.push(`its path was replaced by a symbolic link to the other checkout (it now resolves to ${warpIdentityWords(after.identity)}, not to the confirmed checkout ${warpIdentityWords(before.identity)})`);
    } else if (beforeLink && !afterLink) {
      moved.push(`its path stopped being a symbolic link (it now names ${warpIdentityWords(after.identity)})`);
    } else if (sameResolution && sameKind) {
      // Same spelling, same resolved path, same kind of path — and still a
      // different object: the approved directory was moved aside and another
      // directory put at that path, which only the pinned inode can reveal.
      moved.push("the directory at that path was replaced by a different one (the same path, a different directory: the confirmed checkout is no longer there)");
    } else {
      moved.push(`its resolved checkout changed from ${warpIdentityWords(before.identity)} to ${warpIdentityWords(after.identity)}`);
    }
  }
  if (before.live.present !== after.live.present) {
    moved.push(after.live.present
      ? "the checkout became live again"
      : "it is no longer a live checkout");
  }
  if (before.live.branch !== after.live.branch) {
    moved.push(`its live branch changed from '${before.live.branch === null ? "unknown" : before.live.branch}' to '${after.live.branch === null ? "unknown" : after.live.branch}'`);
  }
  if (before.registered.present !== after.registered.present) {
    moved.push(after.registered.present
      ? "its registry entry came back"
      : "its registry entry disappeared");
  }
  if (before.registered.branch !== after.registered.branch) {
    moved.push(`its registered branch changed from '${before.registered.branch === null ? "unknown" : before.registered.branch}' to '${after.registered.branch === null ? "unknown" : after.registered.branch}'`);
  }
  if (before.evidenceKey !== after.evidenceKey) {
    const beforeContent = before.evidence && before.evidence.content ? before.evidence.content.fingerprint : null;
    const afterContent = after.evidence && after.evidence.content ? after.evidence.content.fingerprint : null;
    const beforeIgnored = before.evidence && before.evidence.ignored ? before.evidence.ignored.files : null;
    const afterIgnored = after.evidence && after.evidence.ignored ? after.evidence.ignored.files : null;
    if (beforeContent !== afterContent) {
      moved.push("its pending content changed");
    } else if (beforeIgnored !== afterIgnored) {
      moved.push("its ignored files changed");
    } else {
      moved.push("its pending work changed");
    }
    moved.push(`confirmed: ${warpEvidenceSummary(before.evidence)}; now: ${warpEvidenceSummary(after.evidence)}`);
  }
  return moved;
}

// One short phrase per evidence read, used only by the refusal above so the
// human can see WHAT moved between the dialog and the removal.
function warpEvidenceSummary(evidence) {
  const read = evidence && typeof evidence === "object" ? evidence : {};
  const changes = read.changes && typeof read.changes === "object" ? read.changes : {};
  let pending;
  if (changes.status === "dirty") {
    const files = Number.isFinite(changes.files) ? changes.files : 0;
    pending = `${files} file${files === 1 ? "" : "s"}, +${changes.added}/-${changes.deleted}`;
  } else if (changes.status === "clean") {
    pending = "no pending changes";
  } else {
    pending = "pending changes unknown";
  }
  const aheadMain = read.aheadMain && typeof read.aheadMain === "object" ? read.aheadMain : {};
  let ahead;
  if (aheadMain.status === "ahead") ahead = `${aheadMain.ahead} ahead of main`;
  else if (aheadMain.status === "none") ahead = "not ahead of main";
  else ahead = "commits ahead of main unknown";
  return `${pending}, ${ahead}`;
}

// Warp selector loop (human selector): the S4 bottom panel and its extended
// list from lib/warp-selector-view.js, mounted through `ctx.ui.custom` as a
// bottom-anchored, full-width overlay whose height the view computes from its
// own content (S3). Returns undefined when the interaction resolved (warp,
// create, delete or cancel) and "fallback" when the host custom UI or the
// overlay is unusable, so the caller falls through to the plain select path.
// Each iteration re-reads the registry and the live git listing fresh.
//
// S1/S4: this surface warps, creates and asks to DELETE. The worktree edit
// panel and the issue/ODD association write are gone, so the markers read here
// are `warp`, `create`, `delete` and `null` — and `delete` is only ever an
// explicit question asked by a human (`warpDeleteCheckout` above); nothing
// here reads a permission mode, and a worktree is never modified.
async function runWarpSelectorLoop(ctx, git, registry, repo, fromCwd, notify) {
  let viewLib = null;
  try {
    viewLib = libRequire("warp-selector-view.js");
  } catch {
    return "fallback";
  }
  if (!viewLib || typeof viewLib.createWarpSelectorView !== "function") return "fallback";
  let factsLib = null;
  try {
    factsLib = libRequire("checkout-facts.js");
  } catch {
    factsLib = null;
  }
  const checkoutFacts = factsLib && typeof factsLib.createCheckoutFacts === "function"
    ? (warpFactsFactory !== null ? warpFactsFactory({ repoRoot: repo.root }) : factsLib.createCheckoutFacts({ repoRoot: repo.root }))
    : null;
  let helpers = null;
  try {
    helpers = await warpTuiLoader();
  } catch {
    helpers = null;
  }
  // S21: every child this loop needs is awaited (`git list`, the create's
  // reads), so the panel keeps repainting and taking keys between them.
  const runAsync = libRunner(git);
  // Duplicate-prompt guard: a create from THIS flow already asked the
  // pending-changes question and applied the answer, so the one warp that
  // follows it — and only when it targets the checkout just created — must not
  // ask the same question again (nor copy a second time, which the destination
  // would refuse as an overlap the human cannot resolve). Any other pick keeps
  // the ordinary gate.
  let createDirtyName = null;
  for (;;) {
    let freshRead;
    try {
      freshRead = registry.readRegistry(repo.root);
    } catch (err) {
      notify?.(`warp: cannot read worktree registry: ${(err && err.message) || err}`, "error");
      return undefined;
    }
    if (!freshRead.ok) {
      notify?.(`warp: cannot read worktree registry: ${freshRead.error}`, "error");
      return undefined;
    }
    let freshLive;
    try {
      // S21: the selector re-reads the live listing on every iteration, so it
      // is awaited — the panel stays repaintable and keyed between reads.
      freshLive = await git.listWorktreesAsync(repo.root, { runAsync });
    } catch (err) {
      notify?.(`warp: cannot list worktrees: ${(err && err.message) || err}`, "error");
      return undefined;
    }
    noteWarpDiscovery(repo.root, freshLive);
    const freshPrincipal = principalForName(git, repo.root, repo, freshLive);
    const freshOffered = warpOfferedCheckouts(git, freshRead, freshPrincipal, freshLive, repo.root);
    const freshActive = warpActiveIdentity(freshLive, repo.root, freshPrincipal, fromCwd);
    const freshCurrent = warpTitleEntry(git, freshOffered, freshLive, repo.root, freshActive, fromCwd);
    const withPrincipalFlag = (principal, offered) => offered.map((entry) => ({
      ...entry,
      isPrincipal: !!(principal && entry.path === principal.path),
    }));
    const reload = async () => {
      try {
        const read = registry.readRegistry(repo.root);
        const live = await git.listWorktreesAsync(repo.root, { runAsync });
        if (!read || read.ok !== true) return null;
        noteWarpDiscovery(repo.root, live);
        const principal = principalForName(git, repo.root, repo, live);
        const offered = warpOfferedCheckouts(git, read, principal, live, repo.root);
        return warpCheckoutsWithActivity(checkoutFacts, withPrincipalFlag(principal, offered));
      } catch {
        return null;
      }
    };
    // S12: the rows carry their own activity/creation values, so the view
    // orders them newest-first and the footer names both ages; nothing here
    // re-sorts. S1: only the synchronous peek cache is used at mount, so the
    // overlay paints before any git work; the full reads run afterwards and
    // apply to the still-alive component.
    const mountEntries = withPrincipalFlag(freshPrincipal, freshOffered);
    const mountedCheckouts = warpCheckoutsWithCachedActivity(checkoutFacts, mountEntries);
    let out;
    try {
      out = await ctx.ui.custom(
        (hostTui, theme, _keybindings, done) => {
          const view = viewLib.createWarpSelectorView({
            checkouts: mountedCheckouts,
            current: { name: freshCurrent.name, path: freshCurrent.path },
            // S4b: the exclusion is by checkout IDENTITY, so the panel and the
            // extended list never offer the current checkout under a second
            // spelling (a symlink, a `..` segment). The same realpath-with-
            // absolute-fallback identity every other surface uses.
            canonicalPath: (value) => {
              const st = checkoutState(value, repo.root);
              if (st.real !== null) return st.real;
              return st.absolute !== null ? st.absolute : value;
            },
            facts: checkoutFacts ? (checkoutPath) => checkoutFacts.facts(checkoutPath).then(warpFactsForView) : undefined,
            reload,
            helpers,
            theme,
            hostTui,
            rowsAvailable: () => warpOverlayRows(hostTui),
            requestRender: () => {
              try {
                if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender();
              } catch {
                // A repaint failure never breaks navigation.
              }
            },
            done,
          });
          // S1 background enrichment: the activity ages arrive after the
          // first frame and are applied to the still-alive component. The
          // view drops late work once it settles, and a failed read can
          // never reject into the host.
          if (checkoutFacts && typeof view.apply === "function") {
            void warpCheckoutsWithActivity(checkoutFacts, mountEntries).then(
              (enriched) => view.apply(enriched),
              () => {},
            );
          }
          return view;
        },
        WARP_SELECTOR_OVERLAY,
      );
    } catch {
      return "fallback";
    }
    if (out === null || out === undefined) return undefined;
    if (out && typeof out === "object" && out.warp) {
      // Neither view offers the checkout the session already stands in, so a
      // resolved warp is always a real move; the listing is still re-read here
      // and an unknown path changes nothing.
      const chosen = freshOffered.find((entry) => entry.path === out.warp);
      if (!chosen) {
        notify?.(`warp: unknown checkout selection ${JSON.stringify(out.warp)}; nothing was moved.`, "error");
        return undefined;
      }
      const warpOptions = createDirtyName !== null && createDirtyName === chosen.name
        ? { skipDirtyPrompt: true }
        : undefined;
      createDirtyName = null;
      const warpOut = await executeWorktreeWarp(chosen.name, ctx, warpOptions);
      if (warpOut.isError) notify?.(warpOut.text, "error");
      return undefined;
    }
    if (out && typeof out === "object" && out.create === true) {
      const made = await warpCreateAndEnter(ctx, git, notify);
      // S7: once the creation flow CLOSES — created, refused with the reason
      // shown, or cancelled with `esc` — the SELECTOR comes back with a freshly
      // read listing, so the human picks where the session goes, including the
      // checkout just created, which is never entered automatically. Closing
      // that returned selector is what ends the flow.
      if (made && made.closed === true) {
        // Remembered for the next pick only: if it is the checkout this create
        // made AND the question was already answered, the warp reuses that
        // answer instead of asking the same thing twice.
        createDirtyName = made.created === true && made.dirtyAsked === true && typeof made.worktree === "string"
          ? made.worktree
          : null;
        continue;
      }
      return undefined;
    }
    if (out && typeof out === "object" && typeof out.delete === "string") {
      // S4: the keyboard delete. `warpDeleteCheckout` owns every rule (the
      // disclosure, the always-asked confirmation, the post-answer
      // revalidation and the shared close); this loop only hands it the fresh
      // listing it just read, so the request is resolved against the state on
      // screen. The selector then comes back with a re-read listing — removed,
      // declined or refused — exactly like the create flow, so a deletion never
      // closes the panel silently.
      await warpDeleteCheckout(out.delete, ctx, {
        git,
        registry,
        repo,
        notify,
        offered: freshOffered,
        principal: freshPrincipal,
        active: freshActive,
      });
      continue;
    }
    notify?.(`warp: unknown checkout selection ${JSON.stringify(out)}; nothing was moved.`, "error");
    return undefined;
  }
}

// Registered before any gate on purpose, exactly like the `worktree`
// toggle: the switch belongs to the Pi session, so it must exist even
// while the worktree tools themselves are unregistered. Hosts without
// commands simply skip it.
function registerWarpCommand(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("warp", {
    description: "Move this session to another checkout of the project: pick from a selector, or warp <name>",
    handler: async (args, ctx) => {
      const notify = ctx?.ui?.notify;
      const raw = String(args ?? "").trim();
      // An agent handoff (queued by the `worktree_warp` tool) travels as ONE
      // `@<token>` argument. It is decoded and re-validated here; a rejected
      // token changes nothing and names no part of what it carried. Everything
      // after this point is the ordinary warpath: the same resolver, the same
      // fork/resume rules, the same records.
      if (raw.startsWith(WARP_HANDOFF_PREFIX)) {
        const decoded = decodeWarpHandoff(raw);
        if (!decoded.ok) {
          notify?.(`worktree warp: ${decoded.error}; nothing was moved.`, "error");
          return;
        }
        const moved = await executeWorktreeWarp(decoded.request.name, ctx, { handoff: decoded.request });
        if (moved && moved.isError) notify?.(moved.text, "error");
        return;
      }
      // An explicit name skips the selector: the scripted path, reusing
      // `executeWorktreeWarp` unchanged (its notifications, its cancelled
      // outcome, its OSC-7 behaviour).
      if (raw !== "") {
        const parts = raw.split(/\s+/).filter((part) => part.length > 0);
        if (parts.length !== 1) {
          notify?.("worktree warp needs exactly one name: use /warp <name> (the flattened branch slug, or principal).", "error");
          return;
        }
        const out = await executeWorktreeWarp(parts[0], ctx);
        // S20 + R1: a real move shows exactly ONE visible confirmation — the
        // styled warp card delivered to the switched-to session — so the
        // command stays silent on success. Already-there warps emit NOTHING
        // (R1: the session is already where it was asked to go); refusals
        // and cancellations send no card, so only failures still notify here.
        if (out.isError) {
          notify?.(out.text, "error");
        }
        return;
      }
      // No argument: offer the project's checkouts as a selector. The
      // listing is read fresh here (never cached): a checkout created or
      // closed since the session started still shows up correctly. Any
      // listing failure fails closed with an actionable message and
      // changes nothing — no selector, no switch.
      const git = libRequire("worktree-git.js");
      const registry = libRequire("worktree-registry.js");
      const fromCwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
      // S21: the command's own fresh scan is awaited too.
      const runAsync = libRunner(git);
      let repo;
      try {
        repo = await git.repoIdentityAsync(fromCwd, { runAsync });
      } catch (err) {
        notify?.(notGitRepositoryLine(fromCwd), "info");
        return;
      }
      const read = registry.readRegistry(repo.root);
      if (!read.ok) {
        notify?.(`warp: cannot read worktree registry: ${read.error}`, "error");
        return;
      }
      let live;
      try {
        live = await git.listWorktreesAsync(repo.root, { runAsync });
      } catch (err) {
        notify?.(`warp: cannot list worktrees: ${(err && err.message) || err}`, "error");
        return;
      }
      // S14: this fresh scan is the warp-time discovery refresh.
      noteWarpDiscovery(repo.root, live);
      // The popup: `runWarpSelectorLoop` mounts the redesigned overlay
      // (popup + extended list) when the host offers ctx.ui.custom. S1/S4:
      // the popup warps, creates, and asks to delete with `ctrl+d`; the edit
      // panel is gone, so a cancel/Esc simply reopens.
      const useCustomWarp = ctx && ctx.ui && typeof ctx.ui.custom === "function";
      if (useCustomWarp) {
        const handled = await runWarpSelectorLoop(ctx, git, registry, repo, fromCwd, notify);
        if (handled !== "fallback") return;
        // "fallback": the host custom UI is unusable here — fall through
        // to the plain select path below, unchanged.
      }
      const principal = principalForName(git, repo.root, repo, live);
      const offered = warpOfferedCheckouts(git, read, principal, live, repo.root);
      const active = warpActiveIdentity(live, repo.root, principal, fromCwd);
      // The active checkout is never an option: it stays out of the list
      // and travels in the title as text instead.
      const others = offered.filter((entry) => entry.path !== active);
      if (others.length === 0) {
        notify?.("warp: no other checkout to move the session to", "info");
        return;
      }
      // The host `select` primitive has no non-selectable rows, so the
      // active checkout travels in the title and `Esc`/undefined is the
      // cancel path. The create entry stays last: it is visually distinct
      // from the checkout rows and never collides with one; it opens the
      // single create panel.
      const current = warpTitleEntry(git, offered, live, repo.root, active, fromCwd);
      const title = `Warp session · current: ${current.name} ${current.path}`;
      const options = [...others.map((entry) => `${entry.name} — ${entry.path}`), WARP_CREATE_ENTRY];
      if (typeof ctx?.ui?.select !== "function") {
        notify?.("warp: the host UI cannot open a checkout selector here; pass a name instead: /warp <name>.", "error");
        return;
      }
      let picked;
      try {
        picked = await ctx.ui.select(title, options);
      } catch {
        picked = undefined;
      }
      // `Esc` cancels silently: no notification, no write, no switch.
      if (picked === undefined) return;
      // The final entry opens the create panel through the existing create
      // path and STOPS there (S7): this host has no custom component to hand
      // back to, so the flow ends after the creation (or its cancellation)
      // instead of moving the session — the next `/warp` lists the
      // checkout just made, and the human picks where to go.
      if (picked === WARP_CREATE_ENTRY) {
        await warpCreateAndEnter(ctx, git, notify);
        return;
      }
      const chosen = others.find((entry) => `${entry.name} — ${entry.path}` === picked);
      if (!chosen) {
        notify?.(`warp: unknown checkout selection ${JSON.stringify(picked)}; nothing was moved.`, "error");
        return;
      }
      const out = await executeWorktreeWarp(chosen.name, ctx);
      // S20 + R1: same single-confirmation rule as the explicit path above:
      // success stays silent (the card is the confirmation), already-there
      // stays silent, only failures notify.
      if (out.isError) {
        notify?.(out.text, "error");
      }
    },
  });
}
let oddTuiLoader = () => import("@earendil-works/pi-tui");

function setOddTuiLoader(loader) {
  oddTuiLoader = loader;
}

// The checkout the session runs in (S2): inside a worktree that is the
// worktree, never the principal. Anything that cannot resolve to a Git root
// fails closed instead of guessing a directory.
function oddCheckoutRoot(cwd) {
  try {
    const repo = libRequire("worktree-git.js").repoIdentity(cwd);
    if (repo && typeof repo.root === "string" && repo.root.length > 0) return repo.root;
  } catch {
    // Not a Git checkout, or git is unavailable: fail closed below.
  }
  return null;
}

// S21: /odd is an INTERACTIVE path, so its checkout read is the ASYNC twin
// (`repoIdentityAsync`, the same two fixed `git rev-parse` probes awaited).
// `spawnSync` here froze the whole session for the child's lifetime — which is
// exactly the «se traba a veces» report — and a slow mount made that lifetime
// seconds long. The synchronous reader stays for the callers that cannot await.
async function oddCheckoutRootAsync(cwd) {
  try {
    const git = libRequire("worktree-git.js");
    const repo = await git.repoIdentityAsync(cwd, { runAsync: libRunner(git) });
    if (repo && typeof repo.root === "string" && repo.root.length > 0) return repo.root;
  } catch {
    // Not a Git checkout, or git is unavailable: fail closed below.
  }
  return null;
}

// The CHEAP listing of one checkout: `odd/tasks` on disk in the documented
// mtime order, with no Git process at all. The viewer paints its first frame
// from this and answers "is there anything to read here?" with it, so opening
// /odd never waits on a history walk.
function oddDocsLocal(root) {
  try {
    const listing = libRequire("odd-docs.js").listOddDocsLocal(root);
    if (listing && typeof listing === "object") return listing;
  } catch {
    // A missing or broken lib never opens a viewer over nothing.
  }
  return { ok: false, reason: "no-checkout", docs: [] };
}

// The ORDERED listing: the same documents ranked by the checkout's own git
// recency (commit time, or a local edit), read through the awaited reader so a
// slow or network-mounted checkout never freezes the host event loop. The caller
// applies it to the OPEN view, so the viewer is never blocked behind it.
async function oddDocsOrdered(root) {
  try {
    const listing = await libRequire("odd-docs.js").listOddDocsAsync(root);
    if (listing && typeof listing === "object") return listing;
  } catch {
    // A missing or broken lib never opens a viewer over nothing.
  }
  return { ok: false, reason: "no-checkout", docs: [] };
}

// The whole listing for a session cwd: checkout root, then the ranked order.
// This is what `r` reloads through, so a reload is awaited off the loop exactly
// like the initial load.
async function oddDocsFor(cwd) {
  const root = await oddCheckoutRootAsync(cwd);
  if (!root) return { ok: false, reason: "no-checkout", docs: [] };
  return oddDocsOrdered(root);
}

function oddTerminalRows(hostTui) {
  try {
    const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
    if (Number.isFinite(rows) && rows > 0) return rows;
  } catch {
    // A hostile host object never breaks the view.
  }
  return 24;
}

// S17: `o` hands the terminal to `$VISUAL`/`$EDITOR`, so Pi has to give it up
// first. Without the handover the TUI keeps its stdin listener and its
// renderer: Escape reaches the odd view as well as nvim (the overlay closes
// behind nvim, so the two screens overlap), frames paint over the editor, and
// keystrokes are split between the two processes.
//
// `tui.stop()` is the host's own suspend (the same call Pi's interactive `!`
// command and `ctrl+z` use): it restores cooked mode, shows the cursor and
// detaches terminal input. `tui.start()` plus a forced repaint take the
// terminal back — and only after the editor has EXITED, because the opener
// resolves when the child SPAWNS. So the child's exit is what the open waits
// for; without it Pi would resume painting under a running nvim.
//
// The opener stays the shared `lib/open-external.js` one (fixed argv, honest
// failure result); this wrapper only adds the terminal lifecycle around it. A
// host that offers no `stop()` (a stub, a non-TUI session) keeps the previous
// behaviour of simply spawning the editor.
function openExternalSuspended(hostTui, target) {
  const opener = libRequire("open-external.js");
  let childExited = null;
  const spawnImpl = (bin, args, options) => {
    const child = spawn(bin, args, options);
    if (child && typeof child.once === "function") {
      childExited = new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once("exit", finish);
        child.once("error", finish);
      });
    }
    return child;
  };
  let suspended = false;
  const resume = () => {
    if (!suspended) return;
    suspended = false;
    try {
      if (hostTui && typeof hostTui.start === "function") hostTui.start();
    } catch {
      // A host that cannot restart still gets the repaint attempt below.
    }
    try {
      if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender(true);
    } catch {
      // A repaint failure never breaks the open.
    }
  };
  try {
    if (hostTui && typeof hostTui.stop === "function") {
      hostTui.stop();
      suspended = true;
    }
  } catch {
    suspended = false;
  }
  return Promise.resolve()
    .then(() => opener.openExternal(target, { spawnImpl }))
    .then(async (result) => {
      if (result && result.ok === true && childExited) {
        // The opener unrefs the child so a DETACHED editor can never hold a
        // session open. Here the session must stay alive until the editor
        // exits, because the terminal is released for exactly that long, so
        // the wait holds a ref'd timer — the same keep-alive Pi uses while its
        // own TUI is suspended. Without it an idle session could exit with
        // nvim still on screen.
        const keepAlive = setInterval(() => {}, 2 ** 30);
        try {
          await childExited;
        } catch {
          // The exit that released the terminal is already the resume trigger.
        } finally {
          clearInterval(keepAlive);
        }
      }
      return result;
    })
    .catch((err) => ({ ok: false, error: (err && err.message) || "open failed" }))
    .finally(resume);
}

async function runOddFallback(ctx, listing) {
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  const select = ctx && ctx.ui ? ctx.ui.select : undefined;
  if (listing.docs.length === 0) {
    if (typeof notify === "function") notify("odd: no documents under odd/tasks/ in this checkout", "info");
    return;
  }
  if (typeof select !== "function") {
    if (typeof notify === "function") {
      notify(`odd: ${listing.docs.length} document(s) under odd/tasks/ (the viewer needs an interactive session)`, "info");
    }
    return;
  }
  let picked = null;
  try {
    picked = await select("Odd documents", listing.docs.map((doc) => doc.name));
  } catch {
    picked = undefined;
  }
  if (picked === undefined || picked === null) return;
  const doc = listing.docs.find((entry) => entry.name === picked);
  if (!doc) return;
  if (typeof notify === "function") notify(doc.path, "info");
}

async function executeOdd(rawArgs, ctx) {
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  const raw = String(rawArgs ?? "").trim();
  if (raw !== "") {
    if (typeof notify === "function") notify(`Unknown option "${raw}". Use /odd-list.`, "error");
    return;
  }
  const cwd = toolCwd(ctx);
  // S21: the checkout read is awaited, never a `spawnSync` probe, and the
  // listing that follows it is the CHEAP one — `odd/tasks` on disk with no Git
  // process at all. So the viewer appears at once even on a checkout whose
  // history walk takes seconds, and the ranked order lands in it afterwards
  // (below). Nothing on this path blocks the host event loop.
  const checkoutRoot = await oddCheckoutRootAsync(cwd);
  if (!checkoutRoot) {
    if (typeof notify === "function") notify(notGitRepositoryLine(cwd), "info");
    return;
  }
  const listing = oddDocsLocal(checkoutRoot);
  if (listing.ok !== true) {
    if (typeof notify === "function") notify(notGitRepositoryLine(cwd), "info");
    return;
  }
  // S9: with nothing to read there is no overlay at all — one muted line,
  // exactly like the changes view answers an empty repository. The cheapest
  // scan already answers this, so an empty checkout costs no Git process.
  if (listing.docs.length === 0) {
    if (typeof notify === "function") notify("No odd documents under odd/tasks/ in this checkout.", "info");
    return;
  }
  // The viewer names only the checkout it reads: nothing is assigned from this
  // surface (S10b), so the root exists solely to know what was listed.
  const checkoutName = path.basename(checkoutRoot);
  let helpers = null;
  try {
    helpers = await oddTuiLoader();
  } catch {
    helpers = null;
  }
  if (helpers && ctx && ctx.ui && typeof ctx.ui.custom === "function") {
    try {
      await ctx.ui.custom(
        (hostTui, theme, _keybindings, done) => {
          // Started INSIDE the factory so the history walk overlaps the overlay
          // instead of preceding it, and never runs at all when the host falls
          // back to the plain menu.
          const settled = oddDocsOrdered(checkoutRoot);
          const view = libRequire("odd-view.js").createOddView({
            docs: listing.docs,
            checkoutName,
            // S1: the viewer reads documents. It is handed NO association prop
            // and NO write callback — a worktree carries no ODD document, so
            // there is nothing to mark as assigned and nothing to save (the view
            // itself has not read these props since S10b).
            // `o` opens the focused document outside Pi through
            // $VISUAL/$EDITOR (key-consistency K3): the shared opener
            // reports honestly, so the view shows the miss or the failure
            // instead of failing silently. S17: the open suspends the TUI for
            // the editor's whole lifetime instead of sharing the terminal with
            // it.
            openExternal: (target) => openExternalSuspended(hostTui, target),
            loadDoc: (doc) => libRequire("odd-docs.js").readOddDoc(doc),
            // S21: the reload is the awaited reader too, so `r` never freezes
            // the frame on a slow history walk.
            reloadDocs: () => oddDocsFor(cwd),
            helpers,
            theme,
            rowsAvailable: () => oddTerminalRows(hostTui),
            requestRender: () => {
              try {
                if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender();
              } catch {
                // A repaint failure never breaks navigation.
              }
            },
            done,
          });
          // The ranked order replaces the cheap one in the LIVE view: the
          // focused document survives by identity, so the reader never loses
          // the pane they are already reading. A walk that could not answer
          // leaves the cheap first frame standing — it is the documented mtime
          // fallback, never an empty viewer.
          settled.then((next) => {
            if (!next || next.ok !== true || !Array.isArray(next.docs)) return;
            if (typeof view.applyDocs === "function") view.applyDocs(next.docs);
          }).catch(() => {
            // The cheap first frame already stands.
          });
          return view;
        },
        // Full screen like the reference Changes view: the point of this
        // surface is reading a long document.
        { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
      );
    } catch {
      // A host that rejects the overlay degrades to the menu below.
      await runOddFallback(ctx, await oddFallbackListing(checkoutRoot, listing));
    }
    return;
  }
  await runOddFallback(ctx, await oddFallbackListing(checkoutRoot, listing));
}

// The plain select menu is the DEGRADED path (no TUI helpers, or a host that
// refused the overlay): there is no live frame to protect, so it keeps the same
// git-ranked order the old synchronous listing handed it. A walk that cannot
// answer leaves the cheap scan in place, so the menu never lists nothing.
async function oddFallbackListing(root, local) {
  const ordered = await oddDocsOrdered(root);
  const usable = ordered && ordered.ok === true && Array.isArray(ordered.docs) && ordered.docs.length > 0;
  return usable ? ordered : local;
}

// `/odd-list` (odd-viewer S1-S8): a two-pane viewer of this checkout's odd/
// documents — the list on the left, the styled markdown on the right.
function registerOddCommand(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("odd-list", {
    description: "Read this checkout's odd documents: list on the left, styled markdown on the right",
    handler: async (args, ctx) => {
      await executeOdd(args, ctx);
    },
  });
}

// ---------------------------------------------------------------------------
// `/issues` (T3 S1,S3): a full-screen four-bucket overlay (My issues /
// Assigned / Involved / All) over the CURRENT checkout's repository issues,
// through this package's own migrated pieces (lib/gh-issues.js for `gh`,
// lib/issues-view.js for the pure view).
//
// GATED INVOCATION: the command is registered eagerly at load so it is always
// discoverable; the session-start `gh` check only decides whether it may open.
// Without an authenticated `gh`, one notification per session names what is
// missing and the command that fixes it, and the handler re-emits it instead
// of opening. The scoped tabs read cursor search pages (author:@me,
// assignee:@me, involves:@me -author:@me), `All` reads the repository's own
// open issue connection, the detail asks for authoritative metadata, and the
// `o` key opens `gh issue view <n> --web -R <pinned>` through a fixed argv
// (never a shell, never an invented opener), with the TUI suspended for the
// open. Assignment to a checkout is deliberately absent: this reader is
// read-only about the worktree↔issue association (S1/S4).
// ---------------------------------------------------------------------------

let issuesTuiLoader = () => import("@earendil-works/pi-tui");

function setIssuesTuiLoader(loader) {
  issuesTuiLoader = loader;
}

// The three scoped buckets are disjoint at the source: `involved` excludes the
// viewer's own issues (they already own a row in `mine`). Each query asks gh
// for last-update ordering so no client re-sorts. `All` is the interactive
// reader's fourth tab: every open issue of the repository, with nothing
// inferred or deduplicated against the three scoped ones.
const ISSUES_PAGE_QUERIES = [
  { id: "mine", label: "My issues", query: "author:@me sort:updated-desc" },
  { id: "assigned", label: "Assigned", query: "assignee:@me sort:updated-desc" },
  { id: "involved", label: "Involved", query: "involves:@me -author:@me sort:updated-desc" },
];

const ISSUES_INTERACTIVE_BUCKETS = [
  ...ISSUES_PAGE_QUERIES,
  // `connection: true` marks the ONE bucket read from the repository's issue
  // connection instead of the search API: GitHub refuses to page a search
  // past 1000 matches, while `repository.issues` walks to its end with an
  // exact total. `query` stays the bucket's search scope for a typed reader
  // query; it is never forwarded to the connection, which takes no text.
  { id: "all", label: "All", query: "sort:updated-desc", connection: true },
];

const ISSUES_FETCH_PAGE_SIZE = 30;

// A failed gate notifies once per session (module lifetime == session). The
// flag flips only when an alert is handed to notify, so a startup without UI
// never consumes the session's single alert.
let issuesGateNotified = false;
// `null` = not probed yet, `true` = gh was usable this session, `false` = the
// last probe failed. Registration is eager; this state gates ONLY the open.
let issuesGateOpen = null;

function issuesPageQuery(spec, rawQuery) {
  const extra = typeof rawQuery === "string" ? rawQuery.trim() : "";
  return extra === "" ? spec.query : `${spec.query} ${extra}`;
}

function issuesListArgs(query, state) {
  return {
    query,
    state: state === "closed" ? "closed" : "open",
    page: 1,
    pageSize: ISSUES_FETCH_PAGE_SIZE,
  };
}

function issuesScopeLabel(name) {
  return typeof name === "string" && name.length > 0 ? name : "gh's default repository";
}

function issuesScopeDriftLine(currentName, pinnedName) {
  return `the checkout's repository changed since this issue list loaded (now ${issuesScopeLabel(currentName)} instead of ${issuesScopeLabel(pinnedName)}); reopen /issues`;
}

// The TUI hands the terminal to another process: a browser open must give it up
// first, exactly like the odd viewer's editor open, or the child's own output
// and the overlay fight over the same stdin/renderer. `stop()` is the host's
// own suspend; `start()` plus a forced repaint take the terminal back once the
// child has been waited for.
function withSuspendedTerminal(hostTui, run) {
  let suspended = false;
  try {
    if (hostTui && typeof hostTui.stop === "function") {
      hostTui.stop();
      suspended = true;
    }
  } catch {
    suspended = false;
  }
  const resume = () => {
    if (!suspended) return;
    suspended = false;
    try {
      if (hostTui && typeof hostTui.start === "function") hostTui.start();
    } catch {
      // A host that cannot restart still gets the repaint attempt below.
    }
    try {
      if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender(true);
    } catch {
      // A repaint failure never breaks the open.
    }
  };
  return Promise.resolve()
    .then(run)
    .catch((err) => ({ ok: false, error: (err && err.message) || "open failed" }))
    .finally(resume);
}

// The `o`-key browser opener: `gh issue view <n> --web` through the file's own
// fixed-argv runner (never a shell, never xdg-open). `-R <owner/name>` is the
// repository the LIST was loaded from, bound when the list loads and passed at
// press time — an issue number on screen always opens the issue it was read
// from, even if the checkout's remote moved while the reader is open.
function issuesOpenInBrowser(hostTui, cwd, number, pinnedIdentity) {
  try {
    const gh = libRequire("gh-issues.js");
    const git = libRequire("worktree-git.js");
    if (!git || typeof git.runArgvAsync !== "function") {
      return Promise.resolve({ ok: false, error: "cannot open the browser: no fixed-argv runner" });
    }
    if (typeof pinnedIdentity !== "string" || pinnedIdentity.length === 0) {
      return Promise.resolve({ ok: false, error: "the issue list has not loaded a repository yet" });
    }
    const bin = gh && typeof gh.ghBinary === "function" ? gh.ghBinary({}) : "gh";
    const argv = ["issue", "view", String(number), "--web", "-R", pinnedIdentity];
    return withSuspendedTerminal(hostTui, async () => {
      const res = await git.runArgvAsync(bin, argv, { cwd, timeoutMs: 30000 });
      if (!res) return { ok: false, error: `cannot open issue #${number} in the browser` };
      if (res.error) return { ok: false, error: res.error };
      if (typeof res.status === "number" && res.status !== 0) {
        const stderr = (res.stderr || "").trim().split("\n")[0];
        return { ok: false, error: stderr || `cannot open issue #${number} in the browser (gh exited with status ${res.status})` };
      }
      return { ok: true };
    });
  } catch (err) {
    return Promise.resolve({ ok: false, error: (err && err.message) || `cannot open issue #${number} in the browser` });
  }
}

function issuesWrapFailure(promise, what) {
  return Promise.resolve(promise).then((res) => {
    if (res && typeof res === "object") return res;
    return { ok: false, error: `${what}: unexpected result` };
  }).catch((err) => ({ ok: false, error: (err && err.message) || `${what}: failed` }));
}

// The no-UI fallback: the three bucket reads happen together, in order, for
// one state. Partial failure keeps the successful pages and reports the first
// error; when every bucket fails the result is `{ok:false}` so the caller
// never reports fake rows.
async function issuesFetchPages(gh, cwd, state, scope) {
  const outcomes = await Promise.all(ISSUES_PAGE_QUERIES.map(async (spec) => {
    const empty = { id: spec.id, label: spec.label, issues: [], total: 0, truncated: false };
    try {
      const res = await gh.listIssues(issuesListArgs(spec.query, state), { cwd, scope });
      if (res && res.ok === true) {
        return {
          ok: true,
          error: null,
          page: {
            id: spec.id,
            label: spec.label,
            issues: res.issues,
            total: res.total,
            truncated: res.truncated === true,
          },
        };
      }
      return { ok: false, error: (res && res.error) || "gh issue list failed", page: empty };
    } catch (err) {
      return { ok: false, error: (err && err.message) || "gh issue list failed", page: empty };
    }
  }));
  const pages = outcomes.map((outcome) => outcome.page);
  const firstError = outcomes.find((outcome) => outcome.ok !== true);
  if (!outcomes.some((outcome) => outcome.ok === true)) {
    return { ok: false, error: (firstError && firstError.error) || "gh issue list failed", pages };
  }
  return { ok: true, pages, loadError: firstError ? firstError.error : null };
}

async function executeIssues(rawArgs, ctx) {
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  const raw = String(rawArgs ?? "").trim();
  if (raw !== "") {
    if (typeof notify === "function") notify(`Unknown option "${raw}". Use /issues.`, "error");
    return;
  }
  const cwd = toolCwd(ctx);
  // The reader belongs to the checkout the session runs in: inside a worktree
  // that is the worktree, never the principal. Anything that cannot resolve to
  // a Git root fails closed instead of guessing.
  const checkoutRoot = await oddCheckoutRootAsync(cwd);
  if (!checkoutRoot) {
    if (typeof notify === "function") notify(notGitRepositoryLine(cwd), "info");
    return;
  }
  let gh = null;
  try {
    gh = libRequire("gh-issues.js");
  } catch (err) {
    if (typeof notify === "function") notify(`issues: cannot load the gh client: ${(err && err.message) || err}`, "error");
    return;
  }
  // The repository identity is PINNED when the list loads, as ONE
  // HOST-QUALIFIED string (`<host>/<owner>/<repo>`, the form gh accepts for
  // GH_REPO and `-R`). The host is part of the identity: the same owner/name on
  // a fork's server and on an enterprise server are different repositories.
  // Every later read, every action and the `o` opener bind exactly that string.
  const ghRepoEnv = () => (typeof process.env.GH_REPO === "string" && process.env.GH_REPO.trim() !== ""
    ? process.env.GH_REPO.trim()
    : null);
  const effectiveRepo = async (fresh) => {
    const envRepo = ghRepoEnv();
    if (envRepo !== null) {
      const normalized = gh.normalizeScopeIdentity(envRepo, process.env);
      if (!normalized || normalized.ok !== true) {
        return { ok: false, error: (normalized && normalized.error) || "cannot normalize the GH_REPO identity" };
      }
      return { ok: true, identity: normalized.identity };
    }
    let scope = null;
    try {
      scope = await gh.checkoutRepoScope({ cwd: checkoutRoot, fresh: fresh === true });
    } catch {
      scope = null;
    }
    if (!scope || scope.ok !== true) {
      return { ok: false, error: (scope && scope.error) || "cannot resolve this checkout's own repository" };
    }
    if (typeof scope.identity === "string" && scope.identity.length > 0) {
      return { ok: true, identity: scope.identity };
    }
    // A checkout with one remote has nothing to disambiguate, so gh resolves
    // it; the answer is qualified with the host gh itself would use (GH_HOST,
    // else github.com), never left as a host-less name.
    let reported = null;
    try {
      reported = await gh.reportedRepoName({ cwd: checkoutRoot, scope: null });
    } catch {
      reported = null;
    }
    if (!reported || reported.ok !== true
      || typeof reported.nameWithOwner !== "string" || reported.nameWithOwner.length === 0) {
      return { ok: false, error: (reported && reported.error) || "cannot resolve this checkout's repository" };
    }
    const normalized = gh.normalizeScopeIdentity(reported.nameWithOwner, process.env);
    if (!normalized || normalized.ok !== true) {
      return { ok: false, error: (normalized && normalized.error) || "cannot normalize the repository identity" };
    }
    return { ok: true, identity: normalized.identity };
  };
  let pinnedRepo;
  let pinnedPromise = null;
  const pinRepo = async () => {
    if (pinnedRepo !== undefined) return pinnedRepo;
    if (pinnedPromise === null) {
      // A FRESH read at open: the identity the list displays is the one the
      // checkout has now, never a scope cached moments before a move.
      pinnedPromise = effectiveRepo(true)
        .catch(() => ({ ok: false, error: "cannot resolve this checkout's own repository" }))
        .then((pin) => {
          pinnedRepo = pin;
          return pin;
        });
    }
    return pinnedPromise;
  };
  const pinnedReadArgs = async () => {
    const pinned = await pinRepo();
    if (!pinned || pinned.ok !== true) {
      return { ok: false, error: (pinned && pinned.error) || "cannot resolve this checkout's own repository" };
    }
    return { ok: true, args: { cwd: checkoutRoot, scope: pinned.identity } };
  };
  // An action runs only while the checkout still resolves to the displayed
  // repository — a resolution failure (including a corrupt configuration)
  // refuses — and then BINDS the pinned name, so it can never send a displayed
  // issue number to another repository.
  const scopeDrift = async () => {
    const pinned = await pinRepo();
    if (!pinned || pinned.ok !== true) {
      return { ok: false, error: (pinned && pinned.error) || "cannot resolve this checkout's own repository" };
    }
    const current = await effectiveRepo(true);
    if (!current || current.ok !== true) {
      return { ok: false, error: (current && current.error) || "cannot verify this checkout's own repository" };
    }
    if (current.identity !== pinned.identity) {
      return { ok: false, error: issuesScopeDriftLine(current.identity, pinned.identity) };
    }
    return { ok: true, scope: pinned.identity };
  };
  // One page per request, straight through the real client. The bucket id
  // selects the EXACT source query; an unknown bucket is an explicit failure
  // and never reaches a subprocess. A typed query rides along as additional
  // search text, so the read searches the COMPLETE bucket. A client error
  // (including the GitHub 1000-match search cap) passes through unchanged.
  const loadIssuePage = (request = {}) => {
    const spec = ISSUES_INTERACTIVE_BUCKETS.find((bucket) => bucket.id === request.bucketId);
    if (!spec) return { ok: false, error: `unknown issues bucket "${String(request.bucketId)}"` };
    const asked = Number(request.limit);
    const limit = Number.isFinite(asked) ? Math.min(1000, Math.max(1, Math.floor(asked))) : 1;
    const cursor = request.cursor == null || request.cursor === "" ? null : String(request.cursor);
    const typed = typeof request.query === "string" ? request.query.trim() : "";
    return issuesWrapFailure((async () => {
      const pinned = await pinnedReadArgs();
      if (pinned.ok !== true) return pinned;
      // The unfiltered `All` bucket reads the repository's issue CONNECTION:
      // cursor-paged to its end with an exact total, instead of a search capped
      // at 1000 matches. It takes NO search text, so only an EMPTY reader query
      // takes this path; a typed query stays on the search API, whose cap is
      // reported honestly rather than routed around.
      if (spec.connection === true && typed === "") {
        if (typeof gh.getIssueConnectionPage !== "function") {
          return { ok: false, error: "cannot read issues: the gh client has no unfiltered issue connection reader" };
        }
        return await gh.getIssueConnectionPage({ after: cursor, first: limit }, pinned.args);
      }
      return await gh.getIssuePage(
        { query: issuesPageQuery(spec, request.query), after: cursor, first: limit },
        pinned.args,
      );
    })(), "cannot read issues");
  };
  const loadLabels = async () => {
    const pinned = await pinnedReadArgs();
    if (pinned.ok !== true) return pinned;
    return await gh.listLabels(pinned.args);
  };
  // The assignee editor's candidates are the repository's assignable users,
  // read lazily on the editor's first open and scoped to this checkout.
  const loadAssignees = async () => {
    const pinned = await pinnedReadArgs();
    if (pinned.ok !== true) return pinned;
    return await gh.listAssignableUsers(pinned.args);
  };
  const checkoutName = path.basename(checkoutRoot);
  // Pin the identity before the overlay mounts, so the first screenful is not
  // a git probe per gh call and every row is read from that one repository.
  await pinRepo();
  let helpers = null;
  try {
    helpers = await issuesTuiLoader();
  } catch {
    helpers = null;
  }
  if (!helpers || !ctx || !ctx.ui || typeof ctx.ui.custom !== "function") {
    // No interactive host: read once so the one-line notice states a real
    // total, then say the viewer needs an interactive session.
    const pinned = await pinnedReadArgs();
    const loaded = pinned.ok === true
      ? await issuesFetchPages(gh, checkoutRoot, "open", pinned.args.scope)
      : { ok: false, error: pinned.error, pages: [] };
    const pages = Array.isArray(loaded.pages) ? loaded.pages : [];
    if (typeof notify === "function") {
      if (loaded.ok !== true) {
        notify(`issues: ${loaded.error || "gh issue list failed"}`, "info");
      } else {
        const total = pages.reduce((sum, page) => sum + (Array.isArray(page.issues) ? page.issues.length : 0), 0);
        notify(`issues: ${total} issue(s) across ${pages.length} pages (the viewer needs an interactive session)`, "info");
      }
    }
    return;
  }
  // The overlay factory's own host object is what the browser opener suspends.
  // Set just before the factory runs so no action can reach a stale host.
  let hostTuiRef = null;
  const actions = {
    // Created names go through `gh label create` first, then the whole delta
    // through `gh issue edit`. A failure at either step returns honestly and
    // the view keeps the editor open with local state unchanged.
    editLabels: (number, add, remove, created) => issuesWrapFailure((async () => {
      const gate = await scopeDrift();
      if (gate.ok !== true) return gate;
      const args = { cwd: checkoutRoot, scope: gate.scope };
      for (const name of Array.isArray(created) ? created : []) {
        if (typeof name !== "string" || name === "") continue;
        const made = await gh.createLabel({ name }, args);
        if (!made || made.ok !== true) return { ok: false, error: (made && made.error) || `cannot create label ${name}` };
      }
      return await gh.editLabels(number, { add, remove }, args);
    })(), "cannot edit labels"),
    postComment: (number, text) => issuesWrapFailure((async () => {
      const gate = await scopeDrift();
      if (gate.ok !== true) return gate;
      return await gh.commentIssue(number, text, { cwd: checkoutRoot, scope: gate.scope });
    })(), "cannot comment"),
    // Assignee toggles save only the add/remove delta through one fixed-argv
    // `gh issue edit`; the repository role check inside the client is the final
    // authority, so a refused save is reported, never assumed.
    editAssignees: (number, { add, remove }) => issuesWrapFailure((async () => {
      const gate = await scopeDrift();
      if (gate.ok !== true) return gate;
      return await gh.editAssignees(number, { add, remove }, { cwd: checkoutRoot, scope: gate.scope });
    })(), "cannot edit assignees"),
    setState: (number, state) => issuesWrapFailure((async () => {
      const gate = await scopeDrift();
      if (gate.ok !== true) return gate;
      return await gh.setIssueState(number, state, { cwd: checkoutRoot, scope: gate.scope });
    })(), "cannot change the issue state"),
    openBrowser: (number) => {
      if (pinnedRepo === undefined) return { ok: false, error: "the issue list has not loaded a repository yet" };
      if (pinnedRepo.ok !== true) {
        return { ok: false, error: pinnedRepo.error || "cannot resolve this checkout's own repository" };
      }
      return issuesOpenInBrowser(hostTuiRef, checkoutRoot, number, pinnedRepo.identity);
    },
  };
  try {
    await ctx.ui.custom(
      (hostTui, theme, _keybindings, done) => {
        hostTuiRef = hostTui;
        return libRequire("issues-view.js").createIssuesView({
          // Bucket metadata only: the rows arrive page by page through
          // `loadIssuePage`, so no accumulated list is handed over. All four
          // tabs are prefetched once at open, so no tab sits at a false zero.
          pages: ISSUES_INTERACTIVE_BUCKETS.map((spec) => ({ id: spec.id, label: spec.label, issues: null })),
          loadIssuePage,
          loadLabels,
          loadAssignees,
          checkoutName,
          prefetchBuckets: true,
          // `includeMetadata` carries the authoritative repository role, the
          // current assignees and the linked PR count into the view; without
          // it the view sees no confirmed capability and offers no editors.
          loadIssue: async (number) => {
            const pinned = await pinnedReadArgs();
            if (pinned.ok !== true) return pinned;
            return await gh.getIssue(number, { ...pinned.args, includeMetadata: true });
          },
          // No association props: a checkout carries no issue list, so nothing
          // is marked as assigned and nothing is saved.
          actions,
          helpers,
          theme,
          rowsAvailable: () => oddTerminalRows(hostTui),
          requestRender: () => {
            try {
              if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender();
            } catch {
              // A repaint failure never breaks navigation.
            }
          },
          done,
        });
      },
      // Full screen like the odd viewer: the point of this surface is reading
      // long issues with their comments.
      { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
    );
  } catch {
    // A host that rejects the overlay degrades to one muted line.
    if (typeof notify === "function") notify("issues: the viewer could not open in this session", "info");
  }
}

// A missing binary needs an install plus login; anything else already carries
// gh's own `gh auth login` wording. The note says the command cannot OPEN,
// never that it is unregistered, because registration is eager.
function issuesGateMessage(error) {
  const text = String(error || "gh check failed");
  if (/ENOENT|not available|not found/i.test(text)) {
    return "issues: the gh CLI is not available; install it (https://cli.github.com) and run `gh auth login` — /issues cannot open until then";
  }
  return `issues: ${text} — /issues cannot open until then`;
}

async function checkIssuesGate(_pi, ctx) {
  try {
    const gh = libRequire("gh-issues.js");
    const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const res = await gh.ghStatus({ cwd });
    issuesGateOpen = !!(res && res.ok === true);
    if (issuesGateOpen) return { ok: true };
    const error = (res && res.error) || "gh check failed";
    if (!issuesGateNotified && ctx && ctx.ui && typeof ctx.ui.notify === "function") {
      try {
        ctx.ui.notify(issuesGateMessage(error), "info");
        issuesGateNotified = true;
      } catch {
        // Notifying never breaks startup.
      }
    }
    return { ok: false, error };
  } catch (err) {
    // The gate must never break startup.
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// The command stays discoverable even before the session gate resolves, so
// running it probes `gh` on demand. A session that already answered `ok` never
// re-probes; a failure notifies the same honest fix every time it is asked.
async function probeIssuesGate(ctx) {
  if (issuesGateOpen === true) return { ok: true };
  let gate;
  try {
    const gh = libRequire("gh-issues.js");
    const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const res = await gh.ghStatus({ cwd });
    gate = res && res.ok === true ? { ok: true } : { ok: false, error: (res && res.error) || "gh check failed" };
  } catch (err) {
    gate = { ok: false, error: (err && err.message) || String(err) };
  }
  issuesGateOpen = gate.ok === true;
  return gate;
}

function registerIssuesCommand(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("issues", {
    description: "Browse fresh GitHub issue pages and details; edit labels/assignees, comment or close when permitted",
    handler: async (args, ctx) => {
      const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
      const gate = await probeIssuesGate(ctx);
      if (gate.ok !== true) {
        if (typeof notify === "function") notify(issuesGateMessage(gate.error), "error");
        return;
      }
      await executeIssues(args, ctx);
    },
  });
}

// ---------------------------------------------------------------------------
// `/codegraph-hook`, `/codegraph-init`, `/codegraph-sync` (T5 S9): the sync
// hook's switch and the two on-demand CLI runs. The bodies live in
// lib/codegraph-commands.js so they are testable without a host; this file only
// registers them and hands their one-line result to the session UI.
//
// GATED REGISTRATION: the three commands do not exist at all in a session whose
// gate says the `codegraph` CLI is absent, so they never appear in that
// session's command list. The gate caches its answer per process (S3), so
// asking at registration time costs one PATH probe for the whole session.
function codegraphCommandsAvailable() {
  try {
    return libRequire("codegraph-session.js").hasCodegraph(process.env) === true;
  } catch {
    return false;
  }
}

function registerCodegraphCommands(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  if (!codegraphCommandsAvailable()) return;
  const render = (ctx, result) => {
    const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
    if (typeof notify === "function") notify(result.text, result.level);
    return result;
  };
  // A command never throws into the host: the lib returns a failure line
  // instead of rejecting, and anything unforeseen is swallowed here.
  const run = async (ctx, work) => {
    try {
      render(ctx, await work());
    } catch {
      // Nothing to report that the lib did not already describe.
    }
  };
  pi.registerCommand("codegraph-hook", {
    description: "Turn the automatic edit/write CodeGraph sync on or off: on, off, status (no argument toggles)",
    handler: async (args, ctx) => {
      await run(ctx, () => libRequire("codegraph-commands.js").codegraphHook(args));
    },
  });
  pi.registerCommand("codegraph-init", {
    description: "Initialize a CodeGraph index in this session's checkout: codegraph init .",
    handler: async (args, ctx) => {
      await run(ctx, () => libRequire("codegraph-commands.js").codegraphInit(args, ctx, {
        run: libRunner(libRequire("worktree-git.js")),
      }));
    },
  });
  pi.registerCommand("codegraph-sync", {
    description: "Sync this session's checkout CodeGraph index: codegraph sync .",
    handler: async (args, ctx) => {
      await run(ctx, () => libRequire("codegraph-commands.js").codegraphSync(args, ctx, {
        run: libRunner(libRequire("worktree-git.js")),
      }));
    },
  });
}

export default function (pi) {
  // A TOOL context has no session control, so `worktree_warp` queues the
  // `/warp` COMMAND through this handle (`sendUserMessage` with
  // prompt-template expansion) — the host-supported way in from a tool.
  warpHandoffPi = pi;
  registerWarpMessageRenderer(pi);
  registerWarpCommand(pi);
  registerOddCommand(pi);
  registerIssuesCommand(pi);
  registerCodegraphCommands(pi);
  pi.registerTool(worktreeCreateTool);
  pi.registerTool(worktreeListTool);
  pi.registerTool(worktreeCloseTool);
  pi.registerTool(worktreeWarpTool);
  if (typeof pi?.on !== "function") return;
  // The card click seam's session lifecycle: remember the live UI on every
  // session start and drop it on shutdown, so no render path ever reaches a
  // context the runtime has invalidated.
  pi.on("session_start", rememberWorktreeCardUi);
  // The session-start `gh` check only gates whether `/issues` may open; the
  // command itself is registered eagerly above.
  pi.on("session_start", async (event, ctx) => {
    await checkIssuesGate(pi, ctx);
  });
  pi.on("session_shutdown", forgetWorktreeCardUi);
  // Nothing deferred survives its session: shutdown advances the startup epoch,
  // so work still in flight drops instead of writing into the session that
  // replaced it.
  pi.on("session_shutdown", () => {
    startupEpoch += 1;
  });
  pi.on("tool_call", (event, ctx) => handleWorktreeOddEvent(event, ctx, pi));
  pi.on("tool_result", (event, ctx) => handleWorktreeOddEvent(event, ctx, pi, true));
  // S1/S3: a successful edit or write asks for ONE background `codegraph sync`
  // of that file's checkout. The call is fire-and-forget — never awaited, its
  // decision never reaches the tool result, and a failure here is swallowed
  // instead of surfacing as a broken edit.
  pi.on("tool_result", (event) => {
    try {
      if (!event || (event.toolName !== "edit" && event.toolName !== "write")) return;
      if (event.isError) return;
      const filePath = event.input && event.input.path;
      if (typeof filePath !== "string" || filePath.length === 0) return;
      libRequire("codegraph-session.js").scheduleSync(filePath);
    } catch {
      // Index freshness is best effort and never touches the tool result.
    }
  });
  // S7: the ODD worktree rules ride the prompt options, appended after the
  // harness's own text. Sync mutation, so the host reads the final string.
  pi.on("before_agent_start", (event) => {
    try {
      libRequire("odd-worktrees-prompt.js").appendOddWorktreesSection(event);
    } catch {
      // The prompt block is best effort.
    }
  });
  // Register every live checkout the registry does not own yet. Dispatched here
  // and awaited by the barrier below: the host runs session_start handlers one
  // at a time, so awaiting the scan inside this handler would put the session's
  // first prompt behind three git reads. Best-effort: never writes user config,
  // never throws, never blocks the session.
  pi.on("session_start", (event, ctx) => {
    try {
      const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd
        : event && typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd
        : process.cwd();
      startupRegistration = trackStartupTask(runStartupDiscovery(cwd, beginStartupTask()));
    } catch {
      // Discovery must never break startup.
    }
  });
  // The startup barrier: registration is the one piece of startup work whose
  // result the next thing the session does depends on, so it is awaited HERE,
  // after the other handlers above have been dispatched.
  pi.on("session_start", async () => {
    const pending = startupRegistration;
    startupRegistration = null;
    if (!pending) return;
    try {
      await pending;
    } catch {
      // Discovery must never break startup.
    }
  });
}

export { executeWorktreeCreate, executeWorktreeList, executeWorktreeClose, resolveThread, executeWorktreeWarp, executeWorktreeWarpTool, emitOsc7, awaitPendingCreationSetups, awaitPendingStartupTasks, scanLiveCheckouts, runStartupDiscovery, setWarpTuiLoader, setOddTuiLoader, setIssuesTuiLoader, setWorktreeCardHelpers, setWarpDirtyAsker, setWarpFactsFactory, warpCreatePreflight, warpForkSourceUsable };

// @ts-nocheck
// odd-worktree-tools.ts — the standalone odd-worktree Pi extension.
//
// One package, one surface: the two agent worktree tools and the four
// read/inspect panels, plus the one tools design it contributes.
//
// Registers four commands:
//   /warp      move this session to another checkout of the project
//   /odd       read this checkout's odd/ documents
//   /files     browse one checkout's files with a live preview, insert the
//              chosen paths into the editor, or open one in $EDITOR
//   /issues    read this checkout's GitHub issues, with label/assignee,
//              comment and close actions when the repository permits them
//
// The bash heading is not a preference of this package either: it contributes one DESIGN
// (`activity`) to gentle-shell-bridge's `/gentle:customize` → `Cards` page, on its
// `Card tools` line when the bridge can group tools (`default` | `activity`) and on
// the per-tool `bash` line on anything older, which the bridge owns, persists and
// repaints (lib/bash-design.js). The skill/ODD file card owns no preference at all: it
// is painted while that same `Card tools` line answers with this design, asked of the
// bridge per paint (lib/file-card-resolver.js), and the host draws its own row for any
// other value. Nothing of that is registered here.
//
// Plus two tools: worktree_create and worktree_list. Create prompts for approval
// when the host offers dialog UI; list never mutates anything; `/warp` is the
// only way to move the session and the panel's ctrl+d is the only way to remove
// a checkout, so no agent surface can do either (S3, S4).
//
// Worktree creation and removal use git; no other workspace manager takes part.
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
//
// One load of this extension reads lib/ from disk ONCE, fresh, and then reuses
// what it read for the rest of its life. Two facts make that the whole contract:
//
//   * the host loads the extension with jiti `moduleCache: false`
//     (pi-coding-agent dist/core/extensions/loader.js:
//     `createJiti(import.meta.url, { moduleCache: false, ... })`), so THIS file
//     is re-read on every load — which is why an updated extension reaches a
//     resumed session at all;
//   * Node's own `require` cache is a different cache, and it survives that
//     load. These lib modules are CommonJS, reached through `require`, so
//     before this fix a reloaded extension kept binding the modules the FIRST
//     load compiled. Observed live: `registry.parseWorktreePorcelain is not a
//     function` — the function exists on disk and the new extension calls it,
//     but the loaded module predates it — and a `neon` configuration that still
//     drew float cards, because lib/card-style.js in memory was the old one.
//
// The host exposes no public loader to reuse: its package export map is `.` and
// `./rpc-entry` only, and the loader itself is `dist/core/extensions/
// jiti-loader.js`, which re-exports `createJiti` from `jiti` — a dependency of
// the host, not of this package, and not a supported import. So the fix stays in
// this package's own seam: drop this load's lib subtree from the require cache
// once, before its first module read, and never again. That is "one load, one
// fresh read": nothing is re-read per call, and no module survives into the next
// load. Nothing here touches Gentle Shell.
const purgedLibDirs = new Set();

// The lib directory this call resolves. Read from the environment each time so
// the tests' `GENTLE_WORKTREE_LIB_DIR` override keeps working exactly as before.
function libDir() {
  const override = process.env.GENTLE_WORKTREE_LIB_DIR;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
}

// Every spelling of `dir` a cache key may carry: as given, and symlink-resolved
// (require keys are the real paths Node loaded).
function libDirSpellings(dir) {
  const spellings = [dir];
  try {
    const resolved = fs.realpathSync(dir);
    if (resolved !== dir) spellings.push(resolved);
  } catch {
    // An unresolvable directory simply has the one spelling; require will fail.
  }
  return spellings;
}

// Drop the lib subtree from the require cache, so the next require of anything
// under it compiles the file as it is on disk now. Only this package's own lib
// directory is touched — never node_modules, never the host.
function purgeLibRequireCache(dir) {
  const prefixes = libDirSpellings(dir).map((spelling) => (spelling.endsWith(path.sep) ? spelling : `${spelling}${path.sep}`));
  const cache = require.cache;
  if (cache === null || typeof cache !== "object") return;
  for (const key of Object.keys(cache)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) delete cache[key];
  }
}

function libRequire(name) {
  const dir = libDir();
  if (!purgedLibDirs.has(dir)) {
    purgedLibDirs.add(dir);
    purgeLibRequireCache(dir);
  }
  return require(path.join(dir, name));
}

// Test seam only, never a public surface: the lib module instance THIS extension
// load actually uses, by file name ("worktree-git.js"). Because one load compiles
// its own lib modules (see above), a test that needs to replace or observe a
// module's behaviour — an injected runner, a fake `gh` client, the pending-warp
// queue — must patch the instance the extension calls, not a `require` of the
// same path, which is a different object after the last load. Production code
// never calls this; `libRequire` is how the extension reaches lib/.
function libModule(name) {
  return libRequire(name);
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
// while production still gets true optionals. (The string-or-array `Union`
// helper went with the `worktree_warp` tool's `changes` option, T6/S3.)
function opt(schema) {
  if (Type && typeof Type.Optional === "function") return Type.Optional(schema);
  return schema;
}

// Thread identity source precedence (which source won is returned in
// `source` so callers and tests can tell):
//  1. GENTLE_WORKTREE_THREAD environment override (tests).
//  2. The Pi host session id via ctx.sessionManager.getSessionId() — the
//     documented accessor on the session manager. Never invented, never
//     guessed.
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

// Warp message card wiring: the warp is a COMMAND, so its one visible
// confirmation is the `worktree-warp` custom message renderer built on
// lib/worktree-card.js. Width helpers resolve lazily here — never a
// top-level package import (S6/S10: every test loader stubs only the two
// package import lines) — preferring the real pi-tui measurement
// (emoji/wide-char aware) and degrading to the lib's local fallback when
// the host has no such module. keyHint rides along only when the
// coding-agent module resolves; otherwise the lib's static ctrl+o hint
// stands in.
let worktreeCardHelpersOverride;
// The runtime resolution below runs once per process: rebuilding the
// helpers object on every render would defeat the per-identity deps
// memo below. The injectable seam still wins whenever set, and resetting
// it returns to this stable resolution — never to a fresh rebuild.
let worktreeCardAutoHelpers;
let worktreeCardAutoResolved = false;

function setWorktreeCardHelpers(helpers) {
  worktreeCardHelpersOverride = helpers;
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

// S1/S4: the `/warp` panel's create front.
//
// The panel is a SECOND caller of the same create, never a second create: the plan,
// the refusals, the hook chain, the one-document write, the registry row, the setup
// runner and the session registration are the ported ones below. The one thing the
// panel keeps of its own is the selection a human can make instead of the tool's
// boolean — a list of checkout-relative paths carried by the existing
// lib/worktree-changes.js transfer once the checkout exists, reported on its own line.
//
// One owner per mode, so exactly one line reaches the human:
//   - "copy everything" becomes `copy_changes: true`, and the ported hook copies and
//     prints the ported `copy_changes:` line;
//   - a path list plans and executes with `copy_changes: false`, so the ported hook
//     never runs the copy (and never prints its line), and the panel's transfer prints
//     its own `copied:` / `copy_changes (paths):` line instead.
function panelChangesSelection(changesLib, raw) {
  // The panel's own selection is optional: omitted means the commit is copied as-is.
  if (raw === undefined || raw === null) return { ok: true, mode: 'none', paths: [] };
  // The panel's documented value set includes the word "none" (lib/worktree-changes.js
  // keeps its own contract, where "none" is spelled by omission), so it is adapted
  // here instead of widening a helper the warp also uses.
  if (typeof raw === 'string' && raw.trim() === 'none') return { ok: true, mode: 'none', paths: [] };
  if (typeof raw === 'string' && raw.trim() === 'all') return { ok: true, mode: 'all', paths: [] };
  let selection;
  try {
    selection = changesLib.normalizeChangesSelection(raw);
  } catch (err) {
    selection = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!selection || selection.ok !== true) {
    let shown = 'an unusable value';
    try {
      shown = JSON.stringify(raw);
    } catch {
      // A value that cannot even be printed is still refused, never echoed.
    }
    return {
      ok: false,
      error: `invalid changes selection ${shown}: ${CHANGES_FORMS} (${(selection && selection.error) || 'unusable value'}; nothing was created)`,
    };
  }
  return selection;
}

async function executeWorktreeCreate(params, ctx, opts) {
  const changesLib = libRequire('worktree-changes.js');
  const branch = params ? params.branch : undefined;
  const selection = panelChangesSelection(changesLib, params ? params.changes : undefined);
  if (selection.ok !== true) return errorResult(selection.error, { branch });
  return runPortedWorktreeCreate(
    {
      request: {
        odd: params ? params.odd : undefined,
        branch,
        // S18: only "copy everything" becomes the boolean the ported hook owns; a path
        // list travels through the panel's own transfer below.
        copy_changes: selection.mode === 'all',
      },
      selection,
      // A completion notice belongs to the caller that asked for one: the panel
      // supplies the UI a human is watching, the tool front supplies none.
      notify: opts && typeof opts.notify === 'function' ? opts.notify : null,
    },
    ctx,
  );
}

// ---- worktree_create (S1, S4) ----
//
// The checkout decisions live in lib/worktree-create.js (plan, execute, view), the
// preparation chain in lib/worktree-hooks.js, the setup plan and its background task
// in lib/worktree-setup.js plus lib/worktree-setup-runner.js, and the one ownership
// rule in lib/worktree-registry.js (the canonical directory, no document). This front
// only joins them: it resolves the canonical main worktree through the package's own
// Git seam, refuses with the ported sentence untouched, and prints the fixed lines the
// view built.

// The ported cores answer `{code, stdout}`; the package's one Git seam is the
// fixed-argv async runner, so this adapter is the only place the two shapes meet and
// every create-side child is awaited instead of blocking the host event loop.
function portedGitSeam(runAsync) {
  return async (cwd, args) => {
    const answer = await runAsync("git", args, cwd);
    return {
      code: answer && typeof answer.status === "number" ? answer.status : 1,
      stdout: answer && typeof answer.stdout === "string" ? answer.stdout : "",
    };
  };
}

// S20/S22 (ported): the setup chain resolved from the closed table and STARTED as
// this package's own tracked task (lib/worktree-setup-runner.js). S4 gives this
// package no configuration file, so setup belongs to every create. The runner owns the
// child, its log under the system temp directory and the completion notice; this front
// only starts it. No state is persisted anywhere (S1/S3): a create never waits for an
// install, prints no setup line and never reports a state it cannot back. The tool
// call supplies no `notify`: an agent's result is its report, so a create fires no UI
// notification the call did not ask for.
async function planPortedWorktreeSetup(input) {
  const runner = libRequire("worktree-setup-runner.js");
  return runner.startWorktreeSetup({
    path: input.path,
    name: input.name,
    sessionId: input.sessionId,
    copiedChanges: input.copiedChanges,
    // The completion notice belongs to the caller that asked for one: the panel
    // supplies the UI a human is watching, the tool supplies none.
    ...(typeof input.notify === "function" ? { notify: input.notify } : {}),
  });
}

/**
 * S1: the whole create, from the canonical main worktree to the printed view.
 *
 * Every refusal is the ported one, returned verbatim: the plan validates the request
 * before anything is written, and nothing here rewrites its sentence. The create owns
 * the same holders the source branch owns — the checkout, the preparation hooks and
 * the session registration — so the line `worktree register in session` only prints
 * when that registration really happened. No record and no registry row is written:
 * the directory the checkout lands in is the only record there is.
 *
 * `input.request` is the ported call (`odd`, `branch`, `copy_changes`).
 * `input.selection` is the PANEL's own selection (`undefined` on the tool front):
 * `{mode: 'none'|'all'|'paths', paths: []}`. A boolean "copy everything" still belongs
 * to the ported `copy_changes` hook, so only `paths` reaches the panel's transfer.
 * `input.notify` is the completion notice a caller asked for; the tool asks for none.
 */
async function runPortedWorktreeCreate(input, ctx) {
  const git = libRequire("worktree-git.js");
  const create = libRequire("worktree-create.js");
  const hooks = libRequire("worktree-hooks.js");
  const registry = libRequire("worktree-registry.js");
  const sessionRegister = libRequire("session-worktree-register.js");
  const selection = input.selection;
  const changesLib = selection === undefined ? null : libRequire("worktree-changes.js");
  const notify = typeof input.notify === "function" ? input.notify : null;
  const request = input.request || {};
  const cwd = toolCwd(ctx);
  const branch = request.branch;
  const runAsync = libRunner(git);
  const portedGit = portedGitSeam(runAsync);

  // A create is attributed in the session registration, so one without a session
  // identity is refused before anything exists on disk.
  const createdBy = resolveThread(ctx).thread;
  if (!createdBy) {
    return errorResult("cannot resolve thread identity: set GENTLE_WORKTREE_THREAD or run inside a Pi session", { branch });
  }

  let repo;
  try {
    repo = await git.repoIdentityAsync(cwd, { runAsync });
  } catch {
    return errorResult(create.WORKTREE_NOT_A_REPOSITORY, { tool: "worktree_create" });
  }
  // The canonical main worktree decides the destination AND runs the create, so a
  // session standing in a linked worktree still creates beside the clone.
  const listing = await portedGit(cwd, ["worktree", "list", "--porcelain"]);
  const liveEntries = registry.parseWorktreePorcelain(listing.code === 0 ? listing.stdout : "");
  const main = liveEntries[0];
  if (main === undefined) return errorResult(`could not list the worktrees of ${repo.root}`, { branch });
  let mainRoot = main.path;
  try {
    mainRoot = fs.realpathSync(main.path);
  } catch {
    // Git's own spelling is all it answered.
  }

  // S11 (warp-branch-field): one ODD is one worktree, so a create for an ODD
  // that already owns one refuses by saying THAT — the answer is "work there",
  // never "pick another odd". Only a LIVE checkout of this clone earns this
  // sentence: a plain directory at the destination keeps the core's own
  // `worktree path already exists` refusal below, untouched. Read-only, so the
  // refusal happens before anything is written.
  if (typeof create.isWorktreeSegment === "function" && create.isWorktreeSegment(request.odd)) {
    let destination = null;
    try {
      destination = create.worktreeDestinationPath(mainRoot, request.odd);
    } catch {
      destination = null;
    }
    if (destination !== null) {
      const target = checkoutState(destination, repo.root);
      const targetId = target.real !== null ? target.real : target.absolute;
      const owner = targetId === null ? undefined : liveEntries.find((entry) => {
        const state = checkoutState(entry.path, repo.root);
        const id = state.real !== null ? state.real : state.absolute;
        return id !== null && id === targetId;
      });
      if (owner !== undefined) {
        return errorResult(
          `odd ${request.odd} already has a worktree: ${owner.path}\nUse that worktree instead of creating another.`,
          { branch, odd: request.odd },
        );
      }
    }
  }

  // The panel's own selection is PREFLIGHTED read-only, before the plan writes anything:
  // an unknown file refuses with nothing created, exactly as this front always did.
  // The copy itself still runs after the checkout exists (below).
  if (selection !== undefined && selection.mode === "paths") {
    let source;
    try {
      source = await changesLib.summarizeChanges(cwd, { git });
    } catch (err) {
      source = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!source || source.ok !== true) {
      return errorResult(
        `cannot read the pending changes of ${cwd}: ${(source && source.error) || "unknown error"} (nothing was created)`,
        { branch },
      );
    }
    let matched;
    try {
      matched = changesLib.matchSelection(source, "paths", selection.paths);
    } catch (err) {
      matched = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!matched || matched.ok !== true) {
      return errorResult(`${(matched && matched.error) || "invalid changes selection"} (nothing was created)`, { branch });
    }
  }

  const decision = await create.planWorktreeCreate(
    {
      odd: request.odd,
      branch,
      // S18: the boolean mode belongs to the ported hook; a path list travels on the
      // panel's own line instead, so the plan never carries both at once.
      copy_changes: request.copy_changes === true,
    },
    { mainRoot },
    { git: portedGit, exists: (target) => fs.existsSync(target) },
  );
  // S1: a refused plan is the result, sentence for sentence.
  if (decision.ok === false) return errorResult(decision.error.message, { branch });

  // S3/S4: no document, no row, no record. The checkout exists at
  // `<repo-name>-worktrees/<odd>`, and that path is the whole record: the panel, the
  // `warp` resolver and a later list all derive this checkout from it.
  const execution = await create.executeWorktreeCreatePlan({
    plan: decision.plan,
    git: portedGit,
  });
  if (execution.ok === false) return errorResult(execution.error.message, { path: decision.plan.path });

  // S19: the hooks run once the worktree exists and before the output is rendered.
  // Nothing here throws: a failing hook is reported by its own outcome, so a create
  // that succeeded is never reported as failed.
  const hooksResult = await hooks.runWorktreeHooks({
    mainRoot,
    // S18: `copy_changes` copies the uncommitted delta of the checkout the call was
    // made in — the session's own checkout, which is not necessarily the canonical
    // main worktree — so a session standing on another branch copies its own line of
    // work instead of main's. `mainRoot` still feeds the main-relative steps.
    changesRoot: cwd,
    path: decision.plan.path,
    odd: decision.plan.odd,
    copyChanges: decision.plan.copyChanges,
    configPath: hooks.worktreeHooksFilePath(repo.commonDir),
    seams: {
      git: portedGit,
      kind: async (target) => {
        try {
          const stats = await fs.promises.lstat(target);
          if (stats.isSymbolicLink()) return "symlink";
          return stats.isDirectory() ? "directory" : "file";
        } catch {
          return undefined;
        }
      },
      readdir: async (target) => {
        try { return await fs.promises.readdir(target); } catch { return []; }
      },
      readText: async (target) => {
        try { return await fs.promises.readFile(target, "utf8"); } catch { return undefined; }
      },
      copyFile: (from, to) => fs.promises.copyFile(from, to),
      mkdir: async (target) => { await fs.promises.mkdir(target, { recursive: true }); },
      symlink: (target, link, type) => fs.promises.symlink(target, link, type),
      platform: process.platform,
    },
  });

  // S18 (panel only): the explicitly selected paths travel through the shared
  // lib/worktree-changes.js transfer ONCE the checkout exists, and after the hooks so
  // nothing they linked or copied is overwritten by a stale read of the source. The
  // boolean mode never reaches here: the tool's `copy_changes` and the panel's "copy
  // everything" are the ported hook's, so one owner runs per mode.
  let panelCopy = null;
  let panelCopyError = null;
  if (selection !== undefined && selection.mode === "paths") {
    let outcome;
    try {
      outcome = await changesLib.copyChanges(
        { from: cwd, to: decision.plan.path, selectMode: "paths", selection: selection.paths },
        { git },
      );
    } catch (err) {
      outcome = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!outcome || outcome.ok !== true) {
      panelCopyError = (outcome && outcome.error) || "cannot copy the selected changes";
    } else {
      panelCopy = {
        files: outcome.files,
        added: outcome.added,
        deleted: outcome.deleted,
        paths: Array.isArray(outcome.copied) ? outcome.copied.slice() : [],
      };
    }
  }

  // S17: only a registration that really happened may claim it did.
  const registered = await sessionRegister.registerSessionWorktree(ctx, decision.plan.path);
  // S21 (ported): the copied count decides whether a lockfile flag may stay frozen.
  // Only one owner ever copied, so the two counts can never both be non-zero.
  const hookCopied = hooksResult.results.find((result) => result.name === "copy_changes")?.copyChanges?.copied ?? 0;
  const copiedChanges = hookCopied + (panelCopy === null ? 0 : panelCopy.files);
  // S1/S3: the chain is started and left behind; it persists no state, so nothing here
  // waits for it and the create prints no setup line.
  await planPortedWorktreeSetup({
    path: decision.plan.path,
    // The checkout IS the ODD, so that is the name the setup reports.
    name: decision.plan.odd,
    sessionId: createdBy,
    copiedChanges,
    notify,
  });

  const view = create.worktreeCreateView({
    plan: decision.plan,
    registered,
    hooks: hooksResult.results,
  });
  // The panel's transfer reports on ITS OWN line, never the ported `copy_changes:` one
  // (that line belongs to the boolean mode): a reader sees one line naming the mode
  // that ran. A failure still names the checkout the human now owns.
  if (panelCopyError !== null) {
    return errorResult(
      `${view.text}\ncopy_changes (paths): ${panelCopyError}`,
      { ...view.details, copyError: panelCopyError },
    );
  }
  if (panelCopy !== null) {
    return textResult(
      `${view.text}\ncopied: ${panelCopy.files} file${panelCopy.files === 1 ? "" : "s"}, +${panelCopy.added}/-${panelCopy.deleted}`,
      { ...view.details, copied: panelCopy },
      false,
    );
  }
  // No renderer is wired to this shape yet: the text and its details are the result,
  // and the card is a later task.
  return textResult(view.text, view.details, false);
}

// ---- S5: the two tools' own cards ----
//
// Both tool definitions render their call and result through
// lib/worktree-cards.js, the renderer that draws on the substrate of
// lib/shell-card.js (S5). The host seam is `renderCall` / `renderResult` on a
// ToolDefinition registered through `defineTool` + `pi.registerTool`
// (@earendil-works/pi-coding-agent `dist/core/extensions/types.d.ts`).
//
// The text measurement those cards need (`visibleWidth`, `truncateToWidth`,
// `wrapTextWithAnsi`) belongs to @earendil-works/pi-tui and is resolved INSIDE
// the hook, never imported at load: this package ships no node_modules, and the
// test loader stubs only the two package import lines. When the host has no such
// module the same hooks answer PLAIN TEXT — the tool's own call name and its own
// result text — so a missing TUI package only costs the frame, never the answer,
// and nothing can throw while the extension loads.
let worktreeToolCardMetricsOverride;
let worktreeToolCardMetricsAuto;
let worktreeToolCardMetricsResolved = false;
let worktreeToolCardsCache;

/** The measurement seam tests inject; `undefined` restores the runtime lookup. */
function setWorktreeToolCardMetrics(metrics) {
  worktreeToolCardMetricsOverride = metrics;
}

function loadRuntimeToolCardMetrics() {
  try {
    const tui = require("@earendil-works/pi-tui");
    if (!tui) return null;
    const { visibleWidth, truncateToWidth, wrapTextWithAnsi } = tui;
    if (
      typeof visibleWidth !== "function"
      || typeof truncateToWidth !== "function"
      || typeof wrapTextWithAnsi !== "function"
    ) return null;
    return {
      visibleWidth: (text) => visibleWidth(text),
      truncateToWidth: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
      wrapTextWithAnsi: (text, width) => wrapTextWithAnsi(text, width),
    };
  } catch {
    return null;
  }
}

function resolveWorktreeToolCardMetrics() {
  if (worktreeToolCardMetricsOverride !== undefined) return worktreeToolCardMetricsOverride || null;
  if (!worktreeToolCardMetricsResolved) {
    worktreeToolCardMetricsResolved = true;
    worktreeToolCardMetricsAuto = loadRuntimeToolCardMetrics();
  }
  return worktreeToolCardMetricsAuto || null;
}

// One factory per metrics identity, so a render never rebuilds the cards. The
// cards need no host handle: expansion is each card's own choice, kept in the
// render context's row state, and the host's `ctrl+o` flag arrives on that same
// context.
function worktreeCardRenderer(toolName, metrics) {
  const cached = worktreeToolCardsCache;
  if (cached === undefined || cached.metrics !== metrics) {
    const cards = libRequire("worktree-cards.js").createWorktreeCards({ metrics });
    worktreeToolCardsCache = { metrics, cards };
  }
  return worktreeToolCardsCache.cards.renderer(toolName);
}

function plainTextComponent(text) {
  const lines = String(text).split("\n");
  return {
    render() { return lines; },
    invalidate() {},
  };
}

// The heading the plain fallback shows: the tool's own name plus the one
// argument that changes what it does, in the same words the card's detail uses.
function worktreeCallPlainText(toolName, args) {
  const value = args !== null && typeof args === "object" ? args : {};
  const detail = toolName === "worktree_create"
    ? (typeof value.branch === "string" && value.branch.length > 0 ? ` ${value.branch}` : "")
    : (value.all === true ? " all" : "");
  return `${toolName.replace("_", " ")}${detail}`;
}

/** The two render hooks one tool definition carries, bound to that tool's card. */
function worktreeToolRenderers(toolName) {
  return {
    // The card frames itself in both styles; without this the host wraps every tool in its own filled box, and a neon
    // frame drawn inside it is two designs at once.
    renderShell: "self",
    renderCall(args, theme, context) {
      const metrics = resolveWorktreeToolCardMetrics();
      if (metrics !== null) {
        try {
          return worktreeCardRenderer(toolName, metrics).renderCall(args, theme, context);
        } catch {
          // The card is presentation; the call is never lost to it.
        }
      }
      return plainTextComponent(worktreeCallPlainText(toolName, args));
    },
    renderResult(result, options, theme, context) {
      const metrics = resolveWorktreeToolCardMetrics();
      if (metrics !== null) {
        try {
          return worktreeCardRenderer(toolName, metrics).renderResult(result, options, theme, context);
        } catch {
          // The card is presentation; the tool's own answer is never lost to it.
        }
      }
      return plainTextComponent(toolResultText(result));
    },
  };
}

/** S1: the `worktree_create` tool's own front — the ported request and nothing else. */
async function executePortedWorktreeCreate(params, ctx) {
  return runPortedWorktreeCreate({
    request: {
      odd: params ? params.odd : undefined,
      branch: params ? params.branch : undefined,
      copy_changes: params ? params.copy_changes === true : false,
    },
  }, ctx);
}

const worktreeCreateTool = defineTool({
  name: "worktree_create",
  label: "Worktree Create",
  // S1: no `exposure`, so the host's `direct` stands and a bare call resolves.
  // `codemode` put the tool behind `tools.worktree_create(...)` inside a script
  // while its sibling `worktree_list` stayed direct, and the prompt names both
  // bare: the asymmetry is what a bare call reported as "Tool not found".
  description: "Create a Git worktree for this clone at <repo-parent>/<repo-name>-worktrees/<odd>, starting from the base branch (main when it exists). `odd` names the ODD this worktree serves and is REQUIRED: it IS the checkout's directory name. The branch is created with the worktree when it does not exist and checked out when it is free; no command ever passes --force. `copy_changes` carries the uncommitted changes of the checkout the call was made from — not necessarily the canonical main checkout — and that source checkout keeps them.",
  parameters: Type.Object({
    odd: Type.String({ description: "The ODD this worktree serves, and the name of its directory under <repo-name>-worktrees. One path segment (letters, digits, dash, underscore, dot). It need not exist as a file." }),
    branch: Type.String({ description: "The branch this worktree works on. It is created with the worktree when it does not exist and checked out when it is free." }),
    copy_changes: opt(Type.Boolean({ description: "Omitted or false copies nothing. true carries the uncommitted changes of the checkout the call was made from — the one the session stands in, not necessarily the main checkout — staged and unstaged plus untracked non-ignored files, into the new worktree; the source checkout keeps them." })),
  }),
  ...worktreeToolRenderers("worktree_create"),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executePortedWorktreeCreate(params || {}, ctx);
  },
});

// ---- worktree_list (S2, S3) ----
//
// Git's own listing is the whole answer: which checkouts exist and which branch each
// one holds. lib/worktree-registry.js adds the one rule Git does not carry — which of
// them this package created, by the canonical
// `<repo-parent>/<repo-name>-worktrees/<odd>` directory — and lib/worktree-list.js
// decides what a reader sees. This front only feeds them. The listing is READ-ONLY:
// it reads no document (there is none), writes nothing and prunes nothing.

async function executePortedWorktreeList(params, ctx) {
  const git = libRequire("worktree-git.js");
  const list = libRequire("worktree-list.js");
  const cwd = toolCwd(ctx);
  const runAsync = libRunner(git);

  let repo;
  try {
    repo = await git.repoIdentityAsync(cwd, { runAsync });
  } catch {
    return errorResult(`not a git repository: ${cwd}`, { tool: "worktree_list" });
  }
  let entries;
  try {
    entries = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(`could not list the worktrees of ${repo.root}: ${(err && err.message) || err}`, { tool: "worktree_list" });
  }
  const main = entries[0];
  if (main === undefined) return errorResult(`could not list the worktrees of ${repo.root}`, { tool: "worktree_list" });
  // The canonical main root decides the directory a checkout must live in to be one
  // of ours, so a session standing in a linked worktree still lists the same set.
  let mainRoot = main.path;
  try {
    mainRoot = fs.realpathSync(main.path);
  } catch {
    // Git's own spelling is all it answered.
  }
  const view = list.worktreeListView({
    entries,
    mainRoot,
    project: path.basename(mainRoot),
    all: params && params.all === true,
  });
  return textResult(view.text, view.details, false);
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
// checkouts. The `/warp` command and the removal path both call this, never
// separate logic. A name is the flattened branch
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

// S7/S8/S9: the active-session refusal, shared by the removal path the warp
// panel's Ctrl+D drives (lib/worktree-session-guard.js).
//
// The guard answers one question per checkout: is a live Pi session working
// there? It reads Gentle Shell's published presence records (heartbeat +
// workspace) and, deterministically, the checkout THIS session stands on. Both
// callers run it, so the panel's refusal and the close can never disagree.
//
// Two outcomes refuse with nothing mutated:
//   - this session is in the checkout: the human is told to warp first
//     (`/warp`), then close. The tool NEVER warps by itself and never closes a
//     pane or workspace: a destructive action that first moves the
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

// Core of a removal (S7, D6, S6-S9): remove the checkout, keep the branch, drop
// the registry entry. Exported for unit tests and called by the warp panel's
// Ctrl+D with `opts.approved` after its own question — it is the panel's only
// removal path, because no agent tool deletes a checkout (S4).
//
// The S7 rule is that the BRANCH IS KEPT: this function never deletes a
// branch, never passes `--trust-repository`, and passes `--force` only when the
// caller asked for it. Removal is `git worktree remove` and nothing else (S6):
// no other process is asked to remove a checkout. A dirty checkout without
// `force` fails with the backend's own reason and nothing is mutated. The
// registry entry is dropped only after `listWorktrees` confirms the path is gone.
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
      "closing a worktree requires a path or a branch or a name: pass the worktree path, branch, or name to close",
      { force },
    );
  }
  // S24: `name` is a third selector beside `path` and `branch` — at most
  // one of the three. (The pre-existing path+branch pair keeps its
  // agree-or-disagree behaviour below.)
  if (hasName && (hasPath || hasBranch)) {
    return errorResult(
      "closing a worktree accepts only one of path, branch, or name: pass only one",
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
  // S3: the rows this resolver matches are Git's own listing. There is no document to
  // read, so a checkout that exists and is listed can be closed by path or branch — and
  // one that Git no longer lists resolves to nothing, the same refusal as before.
  let closeLive;
  try {
    closeLive = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return errorResult(`cannot list worktrees: ${(err && err.message) || err}`, { force });
  }
  const read = { ok: true, worktrees: registry.checkoutRows(closeLive) };
  const byPath = hasPath && !hasName ? registry.findCheckoutByPath(read.worktrees, rawPath) : null;
  const byBranch = hasBranch && !hasName ? registry.findCheckoutByBranch(read.worktrees, rawBranch) : null;
  if (hasPath && hasBranch && byPath && byBranch && byPath.branch !== byBranch.branch) {
    return errorResult(
      `closing a worktree: path and branch disagree: path resolves to branch '${byPath.branch}' but branch '${rawBranch}' is registered elsewhere; pass only one`,
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
        `cannot close the principal checkout at ${resolved.path}: the removal path only closes registered agent worktrees; the checkout and the registry were left untouched`,
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
            `cannot close the principal checkout at ${principalRef.path}: the removal path only closes registered agent worktrees; the checkout and the registry were left untouched`,
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
  // spelling it is given and would name ANOTHER checkout. Only the panel's
  // ctrl+d reaches this function and it always passes its approved identity.
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
  // unchanged, and no caller reaches it without an approval: the panel's
  // ctrl+d is the only removal path.
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
        `worktree delete cancelled: approval declined for branch '${branch}'`,
        { cancelled: true, branch, path: target, force },
      );
    }
  }

  // The removal module is a required control, so a copy that cannot load fails
  // closed instead of falling back to a hand-rolled child.
  let closeLib;
  try {
    closeLib = libRequire("worktree-remove.js");
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

  // S6: git is the ONLY remover. The workspace reconcile (closing every
  // workspace of the checkout's group and opening one at the principal) and an
  // out-of-process `worktree remove` are gone: a close never closes, opens or
  // retires a pane, and it never asks another program to remove the checkout.
  // `git worktree remove` runs with a fixed argv, the absolute verified path,
  // and `--force` only when the caller asked for it; the branch is never
  // deleted and --trust-repository is never passed.
  //
  // ORDER IS PART OF THE PROTECTION, not an implementation detail. The
  // active-session recheck just above is an await, and an await is the longest
  // window a swap gets between an identity check and a remover. So the recheck
  // resolves FIRST and the final identity check runs after it, with NO await
  // between that check and the spawn (lib/worktree-remove.js spawns the
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
  // unverifiable-removal message. Covers the removal path whether or not the
  // post-removal listing succeeds.
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
  // successful, and the registry entry is left in place. A legitimate
  // single-checkout removal (only the target gone) never trips it.
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
  // S3/S4: nothing to drop. The checkout's directory was the only record, and `git
  // worktree remove` above is the whole removal; the branch is kept.
  //
  // The removed/branch-kept contract is byte-identical on every path that was not
  // refused.
  const successLines = [closeSuccessText(branch, true)];
  // S1: a worktree carries no issue and no ODD document, so the close output names no
  // association — no association line and no warning. There is no stored row either,
  // so nothing can be lost by removing the checkout.
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

const worktreeListTool = defineTool({
  name: "worktree_list",
  label: "Worktree List",
  description: "List this clone's Git worktrees: the main worktree first, then the checkouts this package created under <repo-name>-worktrees (each row is its directory's name, which is the ODD, and its branch). Use it to see whether an ODD already has a worktree. Read-only; it writes nothing.",
  parameters: Type.Object({
    all: opt(Type.Boolean({ description: "Omit it: the default lists the ODD checkouts, which is what finds an ODD's worktree. true also lists the worktrees Git knows outside <repo-name>-worktrees, which belong to no ODD; use it only to look for one of those." })),
  }),
  ...worktreeToolRenderers("worktree_list"),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executePortedWorktreeList(params, ctx);
  },
});

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

// S9 (warp-queue-boundary): a refusal that PROVES nothing landed. The copy helper
// ends every one of those with `(nothing was copied)` — a plan-time refusal, a
// path it cannot prove identical, an overlap it will not overwrite, an
// apply-time failure before anything was written — and the destination is
// therefore untouched, which is what makes moving on safe. A copy that landed
// ANY file says so instead (`N of M files already copied`), and a thrown copy
// says nothing about the state at all: neither is read as this case.
const WARP_COPY_NOTHING_LANDED = /nothing was copied/;
const WARP_COPY_PARTIAL = /already copied/;
function warpCopyRefusedWithoutWriting(gate) {
  if (!gate || typeof gate.error !== 'string') return false;
  if (WARP_COPY_PARTIAL.test(gate.error)) return false;
  return WARP_COPY_NOTHING_LANDED.test(gate.error);
}

// The ONE disclosure line of a refused carry-copy (S9): which copies could not
// be carried, and the two facts that follow — nothing was overwritten, and the
// move happened without them. One line, never a second paragraph.
function warpCopyRefusedText(files) {
  const summary = warpCopyFilesSummary(files);
  const what = summary.count > 0
    ? `${summary.line} could not be carried`
    : 'the requested changes could not be carried';
  return `changes not copied: ${what} (the destination refused them); nothing was overwritten`;
}

// The moved result carries that line, and a command front — which never prints a
// result — says it once, so the human learns what the move left behind. Never
// throws, and never prints anything for a move that carries it in its details.
function notifyWarpCopyRefused(notify, out) {
  if (typeof notify !== 'function' || !out || out.isError === true) return;
  const line = out.details && typeof out.details.copyRefused === 'string' ? out.details.copyRefused : null;
  if (line === null || line.length === 0) return;
  try {
    notify(line, 'info');
  } catch {
    // A dead UI never fails a move that already happened.
  }
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
// The warp handoff (`/warp @<token>`).
//
// The host keeps session control on the extension COMMAND context: a tool's
// context carries no `switchSession`, and awaiting `waitForIdle` from inside a
// tool is a self-deadlock (the tool runs inside the turn it would wait for).
// No agent tool warps any more (S3), but the QUEUE still re-dispatches its own
// validated handoff through the host's documented route (see the installed
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
// to re-dispatch the queued `/warp` command from the queue's own timer. Null
// until the extension loads.
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
    // The moment this request was ACCEPTED travels with it, so the move it is
    // re-dispatched into reports ONE real span — request accepted to the
    // hand-off of the confirmation card, the last instant this code can observe
    // it: the host applies the new session, awaits that callback and only then
    // returns from `switchSession`, so the return is NOT in the number (the
    // reading that measures it says the same). Absent when the caller has no such
    // stamp; nothing is invented here.
    const stamped = handoffRequestedAt(request && request.requestedAt);
    if (stamped !== undefined) payload.requestedAt = stamped;
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
  // Round-trip through the command's own decoder: the front may only claim the
  // warp is queued for a token the command will actually accept.
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
    // The request stamp is optional and cosmetic to correctness: a token without
    // one (an older token, or a caller with no clock) simply reports no elapsed
    // time, and an unusable value is dropped rather than refusing the move.
    const requestedAt = handoffRequestedAt(payload.requestedAt);
    return {
      ok: true,
      request: {
        name, target, from, branch, changes,
        ...(requestedAt === undefined ? {} : { requestedAt }),
      },
    };
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
    const requestedAt = handoffRequestedAt(value.requestedAt);
    return {
      name,
      target,
      from,
      branch: typeof value.branch === 'string' ? value.branch : '',
      changes,
      ...(requestedAt === undefined ? {} : { requestedAt }),
    };
  } catch {
    return null;
  }
}

// One acceptance stamp, as the handoff carries it: a finite, non-negative
// millisecond value, or undefined for "this request carries none". Never throws.
function handoffRequestedAt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

// The wall clock this flow reads, as a seam: production reads `Date.now()`, and a
// test may pin the span it measures with `options.now` (the same shape
// `oscStream` uses). This is the ONLY clock in the warp path, and it is never
// read while a card renders: the number it produces travels in the message
// details. Never throws: a hostile clock falls back to the real one.
function warpNow(options) {
  try {
    if (options && typeof options.now === 'function') {
      const value = options.now();
      if (Number.isFinite(value)) return value;
    }
  } catch {
    // Fall through to the real clock.
  }
  return Date.now();
}

// When this warp's request was accepted: the moment the queue accepted it (which
// its handoff token carries, so a request that waited keeps ONE start and its
// wait belongs to the same span), else the moment this invocation began. Never a
// value read at render time.
function warpRequestStart(options, handoff) {
  try {
    if (handoff && Number.isFinite(handoff.requestedAt) && handoff.requestedAt >= 0) return handoff.requestedAt;
  } catch {
    // No usable stamp: measure from now.
  }
  return warpNow(options);
}

// The real span between that start and the last instant this code observes before
// the host returns from the switch: the request's acceptance to the hand-off of the
// confirmation card. The host's own return comes after that hand-off, so it is not
// in the number. Null when the two do not form one (an absent, non-finite or
// backdated pair). Null is never rendered: the card then has no elapsed time at
// all — never a 0 as a stand-in.
function warpMeasuredSpan(startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  const span = endedAt - startedAt;
  return Number.isFinite(span) && span >= 0 ? span : null;
}

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
// naming hook rides every `tool_call` and `tool_result`. A session's cwd resolves
// to the same root/common dir for its whole life, so the answer is memoized per
// cwd instead of respawned twice per tool call. Bounded LRU: a long session
// visiting many checkouts keeps the most recent ones, never unbounded state.
// S8 (T6): the filter below answers most events before this memo is even reached,
// so the common tool call pays neither a `git` nor a lookup.
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

// S8 (T6): the listing behind `git worktree list` is memoized per repository
// root for a SHORT window, so a burst of tool events in one turn costs ONE `git`
// instead of one per event. It is deliberately shorter than a turn, and a listing
// taken BEFORE a checkout was created is never trusted — that is what
// `notBefore` carries, so the memo cannot hide the checkout the agent just made.
const WORKTREE_LISTING_MEMO_MS = 1500;
const WORKTREE_LISTING_CACHE_LIMIT = 32;
const worktreeListingCache = new Map();
// When this process last OBSERVED a checkout being created, or null. Only a
// timestamp: nothing is read from it and no git runs for it.
let worktreeCreatedAt = null;
// The one tool that creates a checkout, so its result is what a memoized listing
// may not predate.
const WORKTREE_CREATE_TOOL = "worktree_create";

function cachedWorktreeListing(git, root, notBefore) {
  const key = String(root);
  const at = Date.now();
  const hit = worktreeListingCache.get(key);
  const age = hit === undefined ? Number.NaN : at - hit.at;
  const recent = Number.isFinite(age) && age >= 0 && age < WORKTREE_LISTING_MEMO_MS;
  // A listing older than `notBefore` — a checkout created after it — answers
  // about a world that no longer exists, so it is bypassed instead of trusted.
  const afterCreation = notBefore === null || notBefore === undefined
    || (hit !== undefined && Number.isFinite(hit.at) && hit.at >= notBefore);
  if (recent && afterCreation) {
    // Refresh recency so the checkout in use is never the one evicted.
    worktreeListingCache.delete(key);
    worktreeListingCache.set(key, hit);
    return hit.live;
  }
  const live = git.listWorktrees(key);
  worktreeListingCache.set(key, { at, live });
  if (worktreeListingCache.size > WORKTREE_LISTING_CACHE_LIMIT) {
    worktreeListingCache.delete(worktreeListingCache.keys().next().value);
  }
  return live;
}

// S8 (T6): a touched path names a session only when it is an ODD TASK document
// (`odd/tasks/*.md`), which is exactly what `lib/session-auto-name.js` derives a
// label from. The test is lexical — the worktree's own `odd/` may be a symlink to
// the principal's, and the document behind either spelling carries the same
// segments — so it costs no child process and no file read.
const ODD_TASK_PARENT = "tasks";
const ODD_ROOT = "odd";

function oddTaskDocumentPath(rawPath, cwd) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return false;
  if (!rawPath.endsWith(".md")) return false;
  let resolved;
  try {
    const abs = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
    resolved = path.resolve(abs);
  } catch {
    return false;
  }
  const segments = resolved.split(path.sep);
  // The file itself is the last segment, so the parent pair is what is looked for.
  for (let i = segments.length - 2; i >= 1; i -= 1) {
    if (segments[i] === ODD_TASK_PARENT && segments[i - 1] === ODD_ROOT) return true;
  }
  return false;
}

// The gentle-pi ODD phase tool, read from `lib/session-auto-name.js` (the module
// that owns the name) once per load instead of per event: this runs on every
// non-naming `tool_result`, so the answer is memoized here.
let oddPhaseToolNameCache;

function oddPhaseToolName() {
  if (oddPhaseToolNameCache === undefined) {
    try {
      const auto = libRequire("session-auto-name.js");
      oddPhaseToolNameCache = typeof auto.ODD_PHASE_TOOL_NAME === "string" ? auto.ODD_PHASE_TOOL_NAME : "";
    } catch {
      oddPhaseToolNameCache = "";
    }
  }
  return oddPhaseToolNameCache;
}

// S8 (T6): can this event name a session at all? The naming path only ever
// applies to the `read`/`edit`/`write` tools touching an `odd/tasks/*.md`
// document, plus the phase trigger, which carries no path and re-applies a label
// the session already derived. Everything else answers `false` HERE — before any
// `git`, which is the whole point: the observer used to spawn two blocking child
// processes per tool call to learn there was nothing to name.
function oddNamingCandidate(event, cwd, allowPhaseTrigger) {
  const toolName = oddToolNameOf(event);
  if (ODD_NAMING_TOOLS.has(toolName)) {
    for (const raw of oddTouchedPaths(oddArgsOf(event))) {
      if (oddTaskDocumentPath(raw, cwd)) return true;
    }
    return false;
  }
  if (allowPhaseTrigger !== true) return false;
  const phaseTool = oddPhaseToolName();
  return phaseTool.length > 0 && toolName === phaseTool;
}

// The pipeline hook proper (M1): every event is observed. Whether a session is
// renamed at all is decided in lib/session-auto-name.js.
function observeOddWriteForNaming(event, ctx, pi, allowPhaseTrigger) {
  // S8 (T6): the create's own result is the fact that a memoized listing may now
  // be wrong. It costs a timestamp and no git, and it is recorded before the
  // filter so the events that follow it in the same turn see the new checkout.
  if (allowPhaseTrigger === true && oddToolNameOf(event) === WORKTREE_CREATE_TOOL) {
    worktreeCreatedAt = Date.now();
  }
  const cwd = oddEventCwd(event, ctx);
  // S8 (T6): filter first, synchronously, with no child process.
  if (!oddNamingCandidate(event, cwd, allowPhaseTrigger)) return;
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
  // Git's listing supplies the checkout this write happened in and its branch. There
  // is no stored row to read (S3): the checkout's own path is the record. S8 (T6):
  // the listing rides a short per-root memo, so a turn's burst of events pays one
  // `git` — and a listing that predates a create is bypassed, so the memo can never
  // hide the checkout the agent just made.
  let live;
  try {
    live = cachedWorktreeListing(git, repo.root, worktreeCreatedAt);
  } catch {
    return;
  }
  const rows = registry.checkoutRows(live);
  if (rows.length === 0) return;
  const entry = oddEntryForCwd(rows, cwd);
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

// The worktree guard (S1–S6, S8–S10): one `tool_call` observation that REFUSES the
// `bash` commands which would take work out of the ODD's own checkout. The decision
// is `lib/worktree-guard.js`'s — text-only, and only for the `bash` tool — and this
// is the wiring that hands it the git answers it needs, which is the only part that
// touches git. Nothing is registered here: the guard adds no command, no tool, no
// option and no setting (S7).
//
// S8: the handler never throws, because a thrown `tool_call` handler blocks the tool
// fail-safe. It returns `{block: true, reason}` to refuse the call and `undefined` to
// let the host run it, exactly like a handler that has nothing to say.

// One git text read: a fixed argv with a bounded timeout (invariant 9), or undefined
// for any answer that is not a value. Never throws.
function readGitTextSync(git, cwd, args) {
  try {
    if (!git || typeof git.runArgv !== "function") return undefined;
    const result = git.runArgv("git", args, { cwd, timeoutMs: 5000 });
    if (!result || result.status !== 0) return undefined;
    const text = String(result.stdout || "").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

// S5: the repository's own default branch, resolved exactly like the create's base
// (`lib/worktree-create.js`): a local `main`, else the branch `origin/HEAD` names,
// else `init.defaultBranch`. A candidate whose ref does not resolve is passed over, so
// there is no `main`/`master` allowlist. Undefined when nothing resolves — the guard
// then refuses no switch (S8), because the real default must stay reachable.
function resolveDefaultBranch(git, root) {
  const candidates = [{ branch: "main", ref: "refs/heads/main" }];
  const originHead = readGitTextSync(git, root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (typeof originHead === "string") {
    const remoteBranch = originHead.replace(/^origin\//, "");
    if (remoteBranch.length > 0) candidates.push({ branch: remoteBranch, ref: `refs/remotes/origin/${remoteBranch}` });
  }
  const configured = readGitTextSync(git, root, ["config", "--get", "init.defaultBranch"]);
  if (typeof configured === "string") candidates.push({ branch: configured, ref: `refs/heads/${configured}` });
  for (const candidate of candidates) {
    if (readGitTextSync(git, root, ["rev-parse", "--verify", "--quiet", candidate.ref])) return candidate.branch;
  }
  return undefined;
}

// The default branch memo, bounded and most-recently-used exactly like
// `repoIdentityCache` above: a session switches branches in a handful of checkouts,
// and a `bash` call must never pay a spawn per call. The answer is a random-access
// fact of the checkout, so it is resolved once per root per process; an entry wraps
// the value because "no resolvable default" is itself an answer worth caching.
const DEFAULT_BRANCH_CACHE_LIMIT = 32;
const defaultBranchCache = new Map();

function cachedDefaultBranch(git, root) {
  const key = String(root);
  const hit = defaultBranchCache.get(key);
  if (hit !== undefined) {
    defaultBranchCache.delete(key);
    defaultBranchCache.set(key, hit);
    return hit.value;
  }
  const value = resolveDefaultBranch(git, key);
  defaultBranchCache.set(key, { value });
  if (defaultBranchCache.size > DEFAULT_BRANCH_CACHE_LIMIT) {
    defaultBranchCache.delete(defaultBranchCache.keys().next().value);
  }
  return value;
}

// S4: the branch that checkout is on RIGHT NOW, read fresh at each judgement and
// NEVER memoized the way `cachedDefaultBranch` is. The branch a checkout points at is
// the one fact a process must not remember: it changes outside this process — a switch
// in another session, a `worktree_create`, a rebase — so a remembered answer would
// judge the next call against a branch that checkout left long ago. A detached HEAD
// and a read that fails both answer undefined, and the guard refuses no switch then.
function readCurrentBranch(git, root) {
  return readGitTextSync(git, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

// The registered `tool_call` handler: the guard's one host surface. A non-`bash` call
// returns before any module is read, and the git answers ride in as the guard's seams:
// the identity and the default branch memoized per checkout, the current branch read
// on demand, so the hot path costs one `Map` hit per call plus one git read for a
// switch.
function guardWorktreeBashCall(event, ctx) {
  try {
    // `ODD_WORKTREE_GUARD=0` turns the guards off for this process, the way
    // `ODD_WORKTREE_PROMPT=0` turns off the prompt blocks. Read per call: a guard is
    // cheap, and an escape hatch that needs a restart is not one.
    if (process.env.ODD_WORKTREE_GUARD === "0") return undefined;
    if (!event || event.toolName !== "bash") return undefined;
    const guard = libRequire("worktree-guard.js");
    if (!guard || typeof guard.decideBashGuard !== "function") return undefined;
    const git = libRequire("worktree-git.js");
    const input = event.input || {};
    const decision = guard.decideBashGuard({
      toolName: event.toolName,
      command: input.command,
      cwd: oddEventCwd(event, ctx),
      repoIdentity: (cwd) => cachedRepoIdentity(git, cwd),
      defaultBranch: (root) => cachedDefaultBranch(git, root),
      currentBranch: (root) => readCurrentBranch(git, root),
      pathExists: (cwd, value) => fs.existsSync(path.resolve(cwd, value)),
    });
    if (decision && decision.block === true && typeof decision.reason === "string") {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  } catch {
    // S8: the guard never throws into the host, and a command it cannot judge passes.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// `/warp <name>` (S23): move the SESSION to another
// checkout by NAME.
//
// The platform keeps session control (`waitForIdle`/`switchSession`) on
// the extension COMMAND context, and that is exactly why the warp is a
// command verb. Nothing else can call either, so the queue re-dispatches THIS
// command through `pi.sendUserMessage(..., {
// expandPromptTemplates: true })` (S14, `dispatchWarpHandoff`): one
// implementation of the move, queued by the same verb that performs it. The name is
// the flattened branch slug S24 prints (or `principal`), resolved through
// the SAME `resolveCheckoutByName` the close-by-name path uses — one
// place, never two.
//
// Measured scope of the move (nothing over-promised): the SESSION cwd
// changes and the tools operate in the target, while the PROCESS cwd does
// not (Pi never calls `process.chdir`); emitting OSC-7 tells the TERMINAL
// the new cwd, and a terminal that parses OSC 7 updates its own pane pwd, so
// new panes/tabs/workspaces inherit it; the interactive bash shell in that
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

// S4/S9: THIS session's own work — the tools it is executing, its agent-task
// counters, and its background jobs — as one answer from
// `lib/worktree-warp-busy.js`: `busy` is true while a tool still executes, an
// agent task runs or queues, OR a job runs.
//
// The job seam is the one `session-worktree-register.js` already uses:
// `ctx.tools` names `job_list` and `ctx.executeTool` calls it. Only those two
// members are kept for a queued warp's lifetime, so a 30-minute record pins one
// host method (and a projected tool list) instead of the whole command context.
// A host without the tool answers `unknown` and blocks nothing.
function warpJobHost(ctx) {
  try {
    if (!ctx || typeof ctx.executeTool !== "function") return null;
    const tools = Array.isArray(ctx.tools) ? ctx.tools : null;
    if (tools === null) return null;
    const executeTool = ctx.executeTool;
    return {
      tools: tools.map((tool) => ({ name: tool && typeof tool.name === "string" ? tool.name : "" })),
      executeTool: (name, args) => executeTool.call(ctx, name, args),
    };
  } catch {
    return null;
  }
}

async function warpSessionActivityById(sessionId, host) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  let lib = null;
  try {
    lib = libRequire("worktree-warp-busy.js");
  } catch {
    return null;
  }
  if (!lib || typeof lib.sessionActivity !== "function") return null;
  try {
    return await lib.sessionActivity({ sessionId, host: host || null });
  } catch {
    return null;
  }
}

// S3/S4 (warp-queue-boundary): the ONE line a queued warp says, anywhere a human
// reads it — the row above the editor, the transcript line, the notice — is one
// brief sentence, exactly like Pi's `Steering:` row. It comes from the module
// that produced the counters, so the row and the notice cannot drift apart, and
// a missing module falls back to the same sentence.
function warpQueuedText(name, activity) {
  try {
    const lib = libRequire("worktree-warp-busy.js");
    if (lib && typeof lib.queuedText === "function") return lib.queuedText(name, activity);
    if (lib && typeof lib.pendingSteeringLine === "function") return lib.pendingSteeringLine(name, activity);
  } catch {
    // fall through to the fixed sentence
  }
  return `Queued: warp ${typeof name === "string" && name.length > 0 ? name : "that checkout"} — waiting for this session's tools, agent tasks and background jobs`;
}

// S9 (warp-idle-gate): the ONE persistent row of a queued warp. It reaches the
// human through `ctx.ui.setWidget`, whose default `aboveEditor` placement the
// host mounts between the status area and the editor — the same zone, and the
// same shape (dim, one truncated line) as Pi's own `Steering:` row. That zone
// already means "standing in line for the work that is running", which is
// exactly what a queued warp is: the request waits for the tool, agent task or
// job, and the row never claims the move happened.
const WARP_STEERING_KEY = "odd-worktree-warp";
const WARP_STEERING_PLACEMENT = "aboveEditor";
// S5 (warp-queue-boundary): the durable fallback. A host that cannot paint the
// zone above the editor (`ctx.ui.setWidget` absent or throwing) gets ONE fixed
// transcript entry — the same shape Pi uses for its own `restored N messages`
// line — carrying the same one-line text, painted once per record and never a
// second line per poll.
const WARP_QUEUE_ENTRY_TYPE = "odd-worktree-warp-queue";

// One line, cut to the terminal width: the row is one row by contract, so a
// narrow terminal loses the tail (with an ellipsis) instead of wrapping into
// several. The trailing space before the ellipsis is dropped, so a cut always
// reads as one word.
function warpTruncateLine(text, width) {
  const room = Number.isSafeInteger(width) && width > 0 ? width : 0;
  if (room === 0) return "";
  const chars = [...String(text ?? "")];
  if (chars.length <= room) return chars.join("");
  return `${chars.slice(0, room - 1).join("").replace(/\s+$/, "")}…`;
}

// The widget content: a component factory, so the row is painted dim and cut to
// the exact width the host offers instead of being wrapped by a `Text`. A theme
// that is absent or throws renders the same line unpainted rather than failing
// the render.
function warpSteeringWidget(line) {
  const text = String(line ?? "");
  return (tui, theme) => ({
    render(width) {
      const cut = warpTruncateLine(text, width);
      if (cut.length === 0) return [];
      try {
        if (theme && typeof theme.fg === "function") {
          const painted = theme.fg("dim", cut);
          if (typeof painted === "string") return [painted];
        }
      } catch {
        // Fall through to the plain row.
      }
      return [cut];
    },
    invalidate() {},
  });
}

// The paint seam the queue holds. Only the bound `setWidget` is captured — not
// the command context around it — because a pending record can live for half an
// hour and must not pin a context it no longer runs in. An empty line clears the
// widget, which the host removes without leaving a blank row behind.
//
// S5 (warp-queue-boundary): when this host offers no such seam, or the seam
// throws, the record falls back to ONE durable transcript entry instead of the
// row. The latch is per call — one painter per pending record — so the entry is
// appended once for the record, never once per poll, and the durable line can
// never be withdrawn (a record's terminal outcome clears the ROW only).
function warpSteeringPainter(ctx) {
  let ui = null;
  try {
    ui = ctx && ctx.ui && typeof ctx.ui.setWidget === "function" ? ctx.ui : null;
  } catch {
    ui = null;
  }
  const setWidget = ui !== null ? ui.setWidget : null;
  let fellBack = false;
  // S8 (warp-queue-boundary): the painter answers whether a surface ACTUALLY took
  // the line, so the queued answer never repeats a sentence the human can already
  // see. `true` means the row above the editor (or the one durable fallback
  // entry) is showing it; `false` means this request has no surface at all.
  return (line) => {
    const text = typeof line === "string" && line.length > 0 ? line : null;
    if (ui === null) {
      if (text === null) return false;
      if (!fellBack) fellBack = warpAppendQueueEntry(text);
      return fellBack === true;
    }
    try {
      const content = text !== null ? warpSteeringWidget(text) : undefined;
      setWidget.call(ui, WARP_STEERING_KEY, content, { placement: WARP_STEERING_PLACEMENT });
      return text !== null;
    } catch {
      // A host that cannot paint here gets the durable entry below instead.
    }
    if (text === null) return false;
    if (!fellBack) fellBack = warpAppendQueueEntry(text);
    return fellBack === true;
  };
}

// The one durable line: `pi.appendEntry` plus the entry renderer registered at
// load. A host without the seam, or one that throws, simply shows nothing — the
// queue itself never depends on presentation.
function warpAppendQueueEntry(line) {
  const pi = warpHandoffPi;
  if (!pi || typeof pi.appendEntry !== "function") return false;
  try {
    pi.appendEntry(WARP_QUEUE_ENTRY_TYPE, { line: String(line) });
    return true;
  } catch {
    return false;
  }
}

// The entry renderer that makes the fallback one plain, dim, width-cut line —
// the same component the row uses, so the two surfaces cannot look different.
function registerWarpQueueEntryRenderer(pi) {
  if (typeof pi?.registerEntryRenderer !== "function") return;
  pi.registerEntryRenderer(WARP_QUEUE_ENTRY_TYPE, (entry, _options, theme) => {
    const line = entry && entry.data && typeof entry.data.line === "string" ? entry.data.line : "";
    return warpSteeringWidget(line)(null, theme);
  });
}

// S10: the in-flight tool counter. The host emits `tool_execution_start` /
// `tool_execution_end` for EVERY tool execution of the session — its own `bash`,
// `read` and the rest, not only this package's tools — so that pair is the
// "something is executing" fact a warp waits for. `tool_call`/`tool_result` is
// not that signal: a blocked or aborted call skips `tool_result`, while every
// finalized call still gets its `tool_execution_end`. The module counts
// top-level executions only, which is also why the queue's own `job_list` probe
// (a nested call inside a parent execution) never counts as busy.
function warpNoteToolExecution(event, ended) {
  try {
    const lib = libRequire("worktree-warp-busy.js");
    const note = lib && (ended ? lib.noteToolEnd : lib.noteToolStart);
    if (typeof note === "function") note(event);
  } catch {
    // A host that cannot feed the counter blocks nothing.
  }
}

// The queue's in-flight counter dies with the session that saw its starts: a
// tool whose end the host could not deliver (a crash or a reload mid-call) must
// not hold a replacement session's warp.
function forgetInFlightWarpTools() {
  try {
    const lib = libRequire("worktree-warp-busy.js");
    if (lib && typeof lib.forgetInFlightTools === "function") lib.forgetInFlightTools();
  } catch {
    // A shutdown never fails on bookkeeping.
  }
}

function warpPendingRefusalText(pending, requestedName) {
  try {
    const lib = libRequire("worktree-warp-busy.js");
    if (lib && typeof lib.pendingWarpRefusalText === "function") return lib.pendingWarpRefusalText(pending, requestedName);
  } catch {
    // fall through to the fixed sentence
  }
  const name = pending && typeof pending.name === "string" && pending.name.length > 0 ? pending.name : "that checkout";
  return `a warp to ${name} is already pending for this session — it runs when this session's tools, agent tasks and background jobs finish; wait for it or let it expire`;
}

// S5: the ONE pending-warp gate. Both fronts ask it, keyed by the session id
// (falling back to the checkout the session stands in) so the tool and the
// command can never disagree about whether a warp is queued. `retry` is true
// only for the pending request's OWN re-dispatched handoff, which must not be
// refused as a second warp.
function warpPendingGate(ctx, fromCwd, handoff) {
  const empty = { key: null, pending: null, retry: false };
  let lib = null;
  try {
    lib = libRequire("worktree-warp-busy.js");
  } catch {
    return empty;
  }
  if (!lib || typeof lib.pendingKeyFor !== "function" || typeof lib.pendingWarpFor !== "function") return empty;
  let key = null;
  try {
    key = lib.pendingKeyFor({ sessionId: closeSessionString(ctx, "getSessionId"), root: fromCwd });
  } catch {
    return empty;
  }
  if (key === null) return empty;
  const pending = lib.pendingWarpFor(key);
  if (!pending) return { key, pending: null, retry: false };
  let retry = false;
  try {
    retry = handoff !== null
      && handoff !== undefined
      && typeof lib.sameWarpHandoff === "function"
      && lib.sameWarpHandoff(pending.handoff, handoff) === true;
  } catch {
    retry = false;
  }
  return { key, pending, retry };
}

// Hold the validated handoff as this session's one pending warp and start its
// poller, which re-dispatches the SAME token through `ctx`-free closures (a
// 30-minute queue must not pin a command context). Never throws; `ok:false`
// with `pending` means another request got there first, and `ok:false` alone
// means this process cannot hold a queue at all.
function warpQueuePending({ ctx, fromCwd, name, prepared, activity }) {
  let lib = null;
  try {
    lib = libRequire("worktree-warp-busy.js");
  } catch {
    return { ok: false };
  }
  if (!lib || typeof lib.queuePendingWarp !== "function" || typeof lib.pendingKeyFor !== "function") return { ok: false };
  const sessionId = closeSessionString(ctx, "getSessionId");
  const host = warpJobHost(ctx);
  let key = null;
  try {
    key = lib.pendingKeyFor({ sessionId, root: fromCwd });
  } catch {
    return { ok: false };
  }
  if (key === null) return { ok: false };
  // Only the bound notifier is captured: the queue outlives this invocation, and
  // a 30-minute record must not pin the whole command context (nor anything it
  // reaches through) just to report an expiry.
  const ui = ctx && ctx.ui && typeof ctx.ui.notify === "function" ? ctx.ui : null;
  // The persistent row (S9) is the same context's `setWidget`, bound once: the
  // queue paints it on every state change and clears it on every terminal
  // outcome. A host without the seam queues exactly as before, and falls back to
  // one durable transcript entry (S5, warp-queue-boundary).
  const paint = warpSteeringPainter(ctx);
  // S2 (warp-queue-boundary): the host's own idle state travels WITH the record,
  // so a dispatch is only ever attempted into an idle host. Only the bound seam
  // is captured; an absent, throwing or unknown answer blocks nothing.
  const isIdle = warpIdleSeam(ctx);
  try {
    return lib.queuePendingWarp({
      key,
      name,
      token: prepared.token,
      handoff: prepared.request,
      activity: activity || null,
      env: process.env,
      host,
      isIdle,
      read: () => warpSessionActivityById(sessionId, host),
      dispatch: (queuedHandoff) => {
        // The queue's own shape carries the acceptance stamp natively
        // (`handoffShape`), so the re-dispatched token reports the SAME one span
        // (request accepted -> the confirmation handed over, exactly as the
        // first dispatch would), never one restarted at dispatch.
        const reprepared = prepareWarpHandoff(queuedHandoff);
        if (!reprepared.ok) return { ok: false, error: reprepared.error };
        return dispatchWarpHandoff(reprepared);
      },
      notify: ui
        ? (text, level) => { try { ui.notify(text, level); } catch { /* a dead UI never fails the queue */ } }
        : null,
      paint,
    });
  } catch {
    return { ok: false };
  }
}

function warpSettlePending(key) {
  if (typeof key !== "string" || key.length === 0) return;
  try {
    const lib = libRequire("worktree-warp-busy.js");
    if (lib && typeof lib.settlePendingWarp === "function") lib.settlePendingWarp(key);
  } catch {
    // Nothing to clear without the module that holds the queue.
  }
}

function warpResumePending(key) {
  if (typeof key !== "string" || key.length === 0) return;
  try {
    const lib = libRequire("worktree-warp-busy.js");
    if (lib && typeof lib.resumePendingWarp === "function") lib.resumePendingWarp(key);
  } catch {
    // The dispatched retry settles or expires on its own.
  }
}

// Nothing deferred survives its session: a queued warp dies with the session
// that asked for it, so no timer outlives the context it would move.
function forgetPendingWarp(ctx) {
  try {
    const lib = libRequire("worktree-warp-busy.js");
    if (!lib || typeof lib.pendingKeyFor !== "function" || typeof lib.settlePendingWarp !== "function") return;
    const root = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : null;
    const key = lib.pendingKeyFor({ sessionId: closeSessionString(ctx, "getSessionId"), root });
    if (key !== null) lib.settlePendingWarp(key);
  } catch {
    // A shutdown never fails on bookkeeping.
  }
}

// S1 (warp-settle-dispatch): the host's own idle state, the busy source the
// counters cannot see. `ctx.isIdle()` is false while Pi processes an agent run,
// an automatic retry, an auto-compaction retry or a queued continuation, so a
// warp typed while the assistant is still thinking is queued like any other
// request even though no tool, task or job reports the work. Null when the
// context offers no such seam, or it throws: the decision then degrades to the
// counters alone, exactly as before.
function warpHostIdle(ctx) {
  try {
    if (ctx && typeof ctx.isIdle === "function") return ctx.isIdle() === true;
  } catch {
    // An unreadable host state blocks nothing.
  }
  return null;
}

// S2 (warp-queue-boundary): that read as a SEAM the pending record holds, so the
// poller can ask the host whether it is idle before every dispatch instead of
// only at request time. `null` when this host offers no such seam: the queue then
// behaves exactly as it does with any other unknown source and blocks nothing.
function warpIdleSeam(ctx) {
  try {
    if (!ctx || typeof ctx.isIdle !== "function") return null;
  } catch {
    return null;
  }
  return () => warpHostIdle(ctx);
}

// The COMMAND front's counters, read ONCE as they are (S2, warp-queue-order):
// a session with a tool executing, agent tasks or background jobs QUEUES the
// warp at once and is never waited on until it drains — a wait made the request
// land on the idle path afterwards, so it never queued (and never painted its
// steering row) and asked the pending-changes question again on every attempt.
//
// S1 (warp-settle-dispatch): the host's own idle state is part of that one
// answer, so a request made while `ctx.isIdle()` is false is queued too. The
// queued request's OWN re-dispatch (`hostIdle: false`) is exempt: the queue
// dispatches it into a settled host by construction, and re-reading the gate
// there could only re-queue the same move.
//
// An absent, empty or throwing session id is NOT a reason to skip the counters:
// the tool counter and the host's `job_list` belong to THIS session whatever its
// id is, and the queue is keyed for the id-less case too (`pendingKeyFor` falls
// back to the checkout the session stands in). Only the agent-task presence hash
// needs the id, and `sessionActivity` answers that source `unknown` — which
// blocks nothing — when it is missing. Null only when the module is unavailable
// (best effort, blocks nothing).
async function warpRequestActivity(ctx, options) {
  const opts = options && typeof options === "object" ? options : {};
  let lib = null;
  try {
    lib = libRequire("worktree-warp-busy.js");
  } catch {
    return null;
  }
  if (!lib || typeof lib.sessionActivity !== "function") return null;
  try {
    return await lib.sessionActivity({
      sessionId: closeSessionString(ctx, "getSessionId"),
      host: warpJobHost(ctx),
      hostIdle: opts.hostIdle === false ? null : warpHostIdle(ctx),
    });
  } catch {
    return null;
  }
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

// S1 (warp-empty-session): what an EMPTY session's warp reports. It names
// WHERE the session now is and never a move: nothing was carried, so the
// `moved:`/`to:` compact — and the card that accompanies it — would claim a
// transition that did not happen.
function warpEmptyText(name, targetCwd) {
  const toName = warpClean(name, 'worktree');
  const to = warpClean(targetCwd, '(unknown checkout)');
  return `worktree warp: ${toName} (empty session, nothing to carry; now at ${to})`;
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
            // S11 (T8, warp-queue-boundary): the ONE question that writes files
            // into another checkout opens on the NON-destructive answer (`NO
            // COPY`) and drops every input event inside a short grace window, so
            // a buffered or double-tapped Enter — the one that submitted the
            // command, or one meant for a queued message — cannot answer a
            // question the human never saw. Both fronts that ask it (the /warp
            // front and the create flow) reach THIS ONE mount, so the wiring
            // lives in the picker lib and is read, never restated here. The
            // visible item order is unchanged.
            ...pickerLib.copyQuestionOptions(),
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
// S61 source-dirty gate shared by the warp command: the answer the human gave at
// REQUEST time is applied here (S1, warp-queue-order), so this path never asks
// the question a second time. A `none` selection copies nothing. Returns
// {ok:true, copied} or {error} to refuse with no switch. Never throws.
async function warpCopyRequestedChanges({ git, fromCheckout, targetCwd, changes }) {
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
      {
        from: fromCheckout,
        to: targetCwd,
        selectMode: changes.mode,
        ...(changes.mode === 'paths' ? { selection: changes.paths } : {}),
      },
      { git },
    );
  } catch (err) {
    return { error: `cannot copy changes: ${(err && err.message) || err} (nothing was warped)` };
  }
  if (!copied || copied.ok !== true) {
    return { error: `${(copied && copied.error) || 'cannot copy changes'} (nothing was warped)` };
  }
  return { ok: true, copied };
}
// S5: the change selection a warp carries, asked ONCE at REQUEST time (S1,
// warp-queue-order) — before the busy decision, so a queued request asks now
// instead of after the session drains, and the immediate move applies the same
// answer instead of asking again. The answer travels in the queued token and
// the copy itself still runs at move time. Cancelling queues nothing. Never
// throws.
async function warpRequestChangesSelection({ ctx, git, fromCheckout, skipPrompt, options }) {
  const none = { ok: true, changes: { mode: 'none', paths: [] } };
  if (skipPrompt === true) return none;
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch {
    return none;
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(fromCheckout, { git });
  } catch {
    return none;
  }
  if (!summary || summary.ok !== true || summary.files === 0) return none;
  const summaryLine = `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}`;
  const choice = await askWarpDirtyChoice(ctx, summaryLine, options);
  if (choice === null) return { cancelled: true };
  return choice === 'yes'
    ? { ok: true, changes: { mode: 'all', paths: [] } }
    : none;
}

// S5: the ONE warp gate every front shares (the tool's queued handoff, a typed
// `/warp <name>`, the selector pick and a create's follow-up warp). While a
// pending warp exists, a SECOND request is refused here — it queues nothing,
// switches nothing and never touches the pending request. The pending retry is
// recognised by its own handoff, so the re-dispatched `/warp @<token>` runs, and
// every terminal outcome (moved, refused, cancelled) clears the record so a
// later warp is accepted again. A retry that finds the counters busy again
// resumes the queue instead of settling it.
async function executeWorktreeWarp(rawName, ctx, opts) {
  const options = opts || {};
  const gate = warpPendingGate(ctx, toolCwd(ctx), normalizeWarpHandoff(options.handoff));
  if (gate.pending && gate.retry !== true) {
    return warpFail(`worktree warp: ${warpPendingRefusalText(gate.pending, rawName)}`, {
      name: typeof rawName === "string" ? rawName.trim() : "",
      alreadyThere: false, cancelled: false, pending: true,
    });
  }
  const out = await performWorktreeWarp(rawName, ctx, options, gate.retry === true);
  if (out && out.stillQueued === true) {
    if (gate.pending && gate.key !== null) warpResumePending(gate.key);
    return out;
  }
  if (gate.key !== null) warpSettlePending(gate.key);
  return out;
}

async function performWorktreeWarp(rawName, ctx, opts, retry) {
  const options = opts || {};
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  // A handoff (queued by this session's own pending warp) names the checkout it
  // resolved, so this invocation never re-picks a destination: it re-checks
  // that the very same live checkout is still the one the name resolves to
  // and refuses otherwise. An ordinary invocation (a human typing
  // `/warp <name>`) carries none.
  const handoff = normalizeWarpHandoff(options.handoff);
  // The span this warp's confirmation reports starts HERE: when its request was
  // accepted. A queued handoff carries that moment in its token, so the wait it
  // spent queued belongs to the same one real span instead of restarting at
  // dispatch. Measured once, reported in the message details — never at render.
  const requestedAt = warpRequestStart(options, handoff);
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
  let live;
  try {
    live = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch (err) {
    return warpFail(`worktree warp: cannot list worktrees: ${(err && err.message) || err}`, { name, alreadyThere: false, cancelled: false });
  }
  // S3: the name resolves against Git's listing. There is no stored row, so a live
  // checkout is warpable the moment it exists and one Git no longer lists is not.
  const read = { ok: true, worktrees: registry.checkoutRows(live) };
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
  // A HANDOFF never asks: the queue already validated the
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
  // S1 (warp-queue-order): the pending-changes question is answered HERE, at
  // REQUEST time and before the busy decision, so a request that will be queued
  // asks ONCE now instead of after the session drains — and the immediate move
  // below applies the very same answer instead of asking it again. A handoff (a
  // queued request's own re-dispatch) never asks: it already carries the answer
  // it was queued with.
  let requestChanges = { mode: 'none', paths: [] };
  if (!handoff) {
    const requestSelection = await warpRequestChangesSelection({
      ctx, git, fromCheckout: dirtyFrom, skipPrompt: skipDirtyPrompt, options: opts,
    });
    if (requestSelection.cancelled === true) {
      return warpFail(
        `worktree warp: ${name} cancelled (the session stays in ${fromCwd})`,
        { name, alreadyThere: false, cancelled: true },
      );
    }
    requestChanges = requestSelection.changes;
  }
  // S2: the counters decide queue-vs-move AS THEY ARE, read once. Nothing here
  // waits for this session's tools, agent tasks or jobs to drain: a request that
  // waited found the session idle afterwards and took the move path, so it never
  // queued, never painted the steering row and asked the copy question again on
  // every attempt. A store that is absent or unreadable blocks nothing. S1: the
  // host's own idle state is part of that answer, so a request made mid-run is
  // queued and the host wait below is never reached.
  const sessionLoad = await warpRequestActivity(ctx, { hostIdle: retry !== true });
  // S5: the QUEUED warp. This session still reports a tool executing, running or
  // queued agent tasks, or an active job, so nothing switches: the request is
  // validated and kept as this session's one pending warp, and
  // lib/worktree-warp-busy.js re-dispatches the SAME handoff once the counters
  // drain. What this returns says queued, never moved, and says plainly what it
  // is waiting for.
  if (sessionLoad && sessionLoad.busy === true) {
    const queuedChanges = handoff ? handoff.changes : requestChanges;
    const queuedHandoff = prepareWarpHandoff({
      name: displayName,
      target: targetCwd,
      from: fromCwd,
      branch: displayBranch,
      changes: queuedChanges,
      // The request was accepted a moment ago (or, on a re-queue, when it was
      // FIRST accepted): the token keeps that one start across the wait.
      requestedAt,
    });
    if (!queuedHandoff.ok) {
      return warpFail(`worktree warp: ${queuedHandoff.error}`, { name, alreadyThere: false, cancelled: false });
    }
    const queued = warpQueuePending({ ctx, fromCwd, name: displayName, prepared: queuedHandoff, activity: sessionLoad });
    // S3/S4 (warp-queue-boundary): ONE brief sentence, exactly the row above the
    // editor — no `queue:` caveat row, no `;`-joined notice, no path dump. The
    // unknown-job disclosure lives in the expiry notice alone.
    const queuedLine = warpQueuedText(displayName, sessionLoad);
    if (!queued.ok && queued.pending) {
      // This IS the pending retry and the workloads filled up again: keep the
      // queue (the wrapper resumes its poller) instead of refusing our own move.
      if (retry === true) {
        return {
          text: queuedLine,
          details: {
            name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind,
            alreadyThere: false, cancelled: false, busy: true, queued: true, pending: true,
          },
          stillQueued: true,
        };
      }
      return warpFail(`worktree warp: ${warpPendingRefusalText(queued.pending, name)}`, {
        name, alreadyThere: false, cancelled: false, pending: true,
      });
    }
    if (!queued.ok) {
      return warpFail(
        "worktree warp: this session still has a tool executing, agent tasks or background jobs and this host cannot hold a queued warp; nothing moved — warp again when they finish",
        { name, alreadyThere: false, cancelled: false, busy: true },
      );
    }
    // S8 (warp-queue-boundary): ONE surface per request. The row above the editor
    // — or its one durable fallback entry — already carries this sentence, so a
    // request whose line was shown prints nothing here: no second copy in the
    // chat. Only a host with no surface at all (no row, no entry) gets the one
    // notice, because otherwise the human would never learn the request is
    // queued. The result object still carries the line either way.
    if (!handoff && queued.painted !== true && ctx && ctx.ui && typeof ctx.ui.notify === "function") {
      try {
        ctx.ui.notify(queuedLine, "info");
      } catch {
        // A dead UI never fails the queue.
      }
    }
    return {
      text: queuedLine,
      details: {
        name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind,
        alreadyThere: false, cancelled: false, busy: true, queued: true, pending: true,
        expiresAt: queued.pending ? queued.pending.expiresAt : null,
      },
      stillQueued: true,
    };
  }
  // The host's own idle wait belongs to the MOVE, never to the request: Pi runs
  // an extension command the moment it is typed, even while the agent is
  // streaming, so a warp requested mid-turn must ask its question, read the
  // counters and QUEUE before anything waits — otherwise the wait parks the
  // whole request until the turn ends and the human sees the question only at
  // idle, with no steering row in between.
  await ctx.waitForIdle();
  // A handoff copy that has landed in the destination is REAL state. It is never
  // rolled back automatically — deleting or reverting files nobody authorized us
  // to touch is exactly the destructive guess this path refuses — so every
  // failure after it names the destination, the copied files and the recovery.
  // `skipped` marks the retry that PROVED the destination already holds exactly
  // those bytes, so the wording says "already holds" instead of "copied now".
  let handoffCopy = null;
  // S9 (warp-queue-boundary): a handoff copy the destination REFUSED without
  // writing anything. The move goes ahead without it, so this holds the one line
  // that says what could not be carried — never an error, never a second
  // paragraph.
  let copyRefused = null;
  const handoffCopyDetails = () => (handoffCopy
    ? {
      copyDestination: targetCwd,
      copiedFiles: (handoffCopy.copied || []).slice(),
      ...(handoffCopy.skipped === true ? { copyAlreadyPresent: true } : {}),
    }
    : copyRefused
      ? { copyDestination: targetCwd, copiedFiles: [], copyRefused: copyRefused.line }
      : {});
  // What the moved result says: the move's own compact, plus the one disclosure
  // line when the carry-copy never happened. One line, no log.
  const movedText = (text) => (copyRefused ? `${text}\n${copyRefused.line}` : text);
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
    // S1: apply the answer the human already gave at request time. No question
    // is asked here — asking it once per request is the point.
    const dirtyGate = await warpCopyRequestedChanges({
      git, fromCheckout: dirtyFrom, targetCwd, changes: requestChanges,
    });
    if (dirtyGate && typeof dirtyGate.error === 'string') {
      return warpFail(dirtyGate.error, { name, alreadyThere: false, cancelled: false });
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
      // only then. One refusal is not a failure at all (S9, warp-queue-boundary):
      // the one that proves nothing landed, because the destination is then
      // untouched and the human asked to move. Everything else fails closed with
      // the concrete recovery, never guessing and never overwriting what the
      // destination holds.
      const proof = await warpHandoffCopyAlreadyApplied({
        git, fromCheckout: dirtyFrom, targetCwd, changes: handoff.changes,
      });
      if (proof.ok === true && proof.applied === true) {
        handoffCopy = { copied: proof.identical.slice(), skipped: true };
      } else if (warpCopyRefusedWithoutWriting(copyGate)) {
        // S9 (warp-queue-boundary): the copy refused and PROVED nothing landed —
        // the destination is untouched, so moving on is always safe. The human
        // asked to move, so the move happens WITHOUT the copy, overwriting
        // nothing, and says so in one line naming the copies it could not carry.
        // A refusal is disclosed, never silently dropped and never turned into a
        // failed warp. A copy that DID land anything is the next branches' hard
        // failure, because that is real state.
        copyRefused = {
          line: warpCopyRefusedText(proof.ok === true
            ? [...proof.identical, ...proof.differing, ...proof.unreadable]
            : []),
        };
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
    // The real span this confirmation reports, and exactly where it ENDS.
    //
    // The installed host applies the new session, awaits this callback, and only
    // then returns from `switchSession`
    // (`core/agent-session-runtime.js`: `apply(...)`,
    // `finishSessionReplacement(options?.withSession)`, `return { cancelled:
    // false }`). The number must travel in the message this callback sends, so
    // the last instant THIS code can observe it is here: immediately before the
    // card is handed over. Both the callback's own final await and the host's
    // return happen AFTER this read, so they are NOT in the number — the label
    // ends at the hand-off, not at the switch's return. Never re-measured, never
    // clamped: a pair that does not form a span sends none at all.
    const elapsedMs = warpMeasuredSpan(requestedAt, warpNow(options));
    await r.sendMessage({
      customType: "worktree-warp",
      content,
      display: true,
      // S20: the card renderer reads the compact rows from here — never
      // by parsing text — so the styled confirmation, the agent text and
      // the listing identifier cannot drift apart. S42: fromName is the
      // source worktree's name alone for the card's `moved:` row. The
      // measured span rides beside them and is the card's bottom-right
      // elapsed time, omitted when there is no real measurement.
      details: {
        from: fromCwd, to: targetCwd, fromDesc, fromName, name: displayName, branch: displayBranch,
        ...(elapsedMs === null ? {} : { durationMs: elapsedMs }),
      },
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
  // S1/S3 (warp-empty-session): the switched-to session of an EMPTY warp is
  // told nothing — no card, and no handoff continuation either, because the
  // session carries no task yet (the already-there no-op answers a handoff
  // with text only, for the same reason). The status line stays: it says
  // WHERE the session is, not what it carried.
  const warpSilentWithSession = async (r) => {
    try {
      r.ui.setStatus("worktree", `${displayName} (${targetCwd})`);
    } catch {
      // Status is cosmetic; the silence is the point.
    }
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
  // S1/S5 (warp-empty-session): an EMPTY session is one whose active branch
  // carries no conversation — no `message` entry with role user or assistant
  // outside the warp bookkeeping, so a rename, the session-worktree
  // registration or a transition marker never counts as content. It has
  // nothing to carry, so its warp changes PATH instead of moving work: never
  // a fork (the host refuses a conversation-less source), never a card, never
  // a "moved:" claim.
  const sessionEmpty = !warpSessions.hasConversation(
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
          // An empty source has no point to compare (its own point is empty
          // by definition), so it RESUMES the destination session whenever
          // that file is readable — the conversation it already holds (S4)
          // or its own emptiness — instead of allocating a copy of nothing. A
          // session with conversation keeps the same-point gate.
          if (freshDestPoint !== null
            && (sessionEmpty || warpSessions.samePoint(currentPoint, freshDestPoint))) {
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
      resumed = await ctx.switchSession(recordedSessionFile, {
        withSession: sessionEmpty ? warpSilentWithSession : warpResumeWithSession,
      });
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
      text: movedText(sessionEmpty ? warpEmptyText(name, targetCwd) : moveText),
      details: {
        name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind,
        alreadyThere: false, cancelled: false,
        ...(sessionEmpty ? { emptySession: true } : {}), ...handoffCopyDetails(),
      },
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
  // S1: an empty session is allowed through without a persisted file or
  // in-memory entries — the refusal below exists because a session with
  // nothing to carry had nothing to warp FOR, and the empty path now changes
  // its path instead of carrying anything.
  if (!sessionEmpty && !warpSourceUsable(file, warpFileOpen)) {
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
  // S3 (warp-empty-session): an empty session changes PATH. There is nothing
  // to carry, so nothing is forked (`forkFrom` refuses a conversation-less
  // source anyway) and the in-place move the host would need does not exist —
  // `switchSession(file)` is the only mount, and a session's cwd comes from
  // its own header. So the equivalent is used: a FRESH session allocated at
  // the target cwd through the same create/switch machinery the non-persisted
  // path uses, with only its header written (`wx`, never clobbering) so the
  // mount and the record both have a real file. The switch is silent: no
  // card, no transition entry, no rename — bookkeeping this flow did not earn.
  if (sessionEmpty) {
    if (!SM || typeof SM.create !== "function") {
      return failAfterCopy(
        "worktree warp is unavailable here: the host SessionManager has no create",
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    let emptyFile = null;
    try {
      const allocated = SM.create(targetCwd, sessionDir);
      const allocatedFile = allocated && typeof allocated.getSessionFile === "function" ? allocated.getSessionFile() : undefined;
      if (typeof allocatedFile !== "string" || allocatedFile.length === 0) {
        throw new Error("the host allocated no session file for the target");
      }
      const header = typeof allocated.getHeader === "function" ? allocated.getHeader() : null;
      if (!header) throw new Error("the allocated session has no header");
      // The file is the header alone: there is no entry to carry, and a file
      // naming the target cwd is what makes the mount and the fresh point
      // real. `wx` never clobbers an existing file.
      fs.writeFileSync(allocatedFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
      emptyFile = allocatedFile;
    } catch (err) {
      return failAfterCopy(
        `worktree warp: could not change this session's path to ${targetCwd}: ${(err && err.message) || err}`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    let changed;
    try {
      changed = await ctx.switchSession(emptyFile, { withSession: warpSilentWithSession });
    } catch (err) {
      return failAfterCopy(
        `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the new session file was kept at ${emptyFile}`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    if (changed && changed.cancelled === true) {
      try {
        fs.unlinkSync(emptyFile);
      } catch {
        // Best effort: the report below is what matters.
      }
      return failAfterCopy(
        `worktree warp: ${name} cancelled (the session stays in ${fromCwd}; the new session file was removed)`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
      );
    }
    // Recording is unchanged: both sides are recorded at their own points, so
    // a later warp finds this destination session again (S2: warping back
    // from an empty session is the same empty case).
    try {
      recordBothSides(
        targetCwd, emptyFile, warpFreshPoint(emptyFile),
        sourceIdentity, currentFile, currentPoint,
      );
    } catch {
      // Best effort: the warp already switched.
    }
    emitOsc7(options.oscStream || process.stdout, targetCwd);
    return {
      text: movedText(warpEmptyText(name, targetCwd)),
      details: {
        name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind,
        alreadyThere: false, cancelled: false, emptySession: true, ...handoffCopyDetails(),
      },
    };
  }
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
    text: movedText(moveText),
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

// No startup task is awaited by `session_start` any more: the one that was — the
// discovery scan — produced a cache nothing reads, so it is dispatched and
// tracked like every other, and the host never waits for a git probe.

// Resolves once every deferred startup task has settled. Exported for tests and
// for a shutdown path that must not leave work behind it.
async function awaitPendingStartupTasks() {
  while (startupTasks.size > 0) {
    await Promise.all(Array.from(startupTasks));
  }
}

// The discovery body the deferred startup task runs: scan and refresh the warp cache.
// S3/S4: there is nothing to register — a checkout this package created is already
// identified by its directory — so startup writes nothing at all. Never throws, and a
// task whose session ended before git answered drops instead of writing into the
// session that replaced it. Returns the scan for tests and in-process callers.
async function runStartupDiscovery(cwd, epoch) {
  try {
    const scanned = await scanLiveCheckouts(cwd);
    if (scanned === null) return null;
    if (!startupTaskLive(epoch)) return null;
    noteWarpDiscovery(scanned.repo.root, scanned.live);
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
    // Resolved per render (memoized by dependency identity) so an injected test
    // seam takes effect on the next card; the renderer needs no session UI.
    let cache = null;
    pi.registerMessageRenderer("worktree-warp", (message, options, theme) => {
      const deps = resolveWorktreeCardHelpers() || undefined;
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

// The create panel is the selector's create completion: it asks for exactly
// TWO things — the BRANCH (`<type>/<name>`, composed by the panel) and the ODD
// that names the checkout's directory (warp-branch-field S1,S2) — and then
// `executeWorktreeCreate` runs. It never prompts: those two answers ARE the
// human's intent, and the branch travels through unchanged (created when it is
// absent, adopted when it exists). A creation supplies NEITHER `issues` nor a
// derived name: a brand-new row is born without an association, so the invalid,
// duplicate, occupied and principal refusals keep their exact shape.

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

// S5 (warp-branch-field): the checkouts that already exist, as absolute paths —
// the evidence the create panel filters its ODD list with. `git worktree list`
// is the live side and the registry is the stored side, and a stored row only
// counts while its directory still exists: reconciling the two is what keeps a
// removed checkout's stale row from hiding an ODD that is free again. Never
// throws — an unreadable side contributes nothing, and the create still refuses
// a collision with its own sentence.
async function warpOccupiedCheckoutPaths(git, cwd) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    try {
      paths.add(path.resolve(value));
    } catch {
      // An unresolvable spelling names no checkout.
    }
  };
  let live = [];
  try {
    live = await git.listWorktreesAsync(cwd, { runAsync: libRunner(git) });
  } catch {
    live = [];
  }
  for (const entry of Array.isArray(live) ? live : []) {
    if (entry && typeof entry === "object") add(entry.path);
  }
  return [...paths];
}

// Create-then-return (S7): the selector's create completion mounts the
// TWO-FIELD panel (the change type and the ODD, where the ODD is picked from the
// ODDs `main` carries with `new odd` as its first entry and its only typed case)
// as an overlay, then runs the SAME creation path `worktree_create` uses — which
// never prompts — and STOPS there. Creation is creation: nothing is warped by
// itself, so the caller can hand the selector back with a fresh listing that
// includes the checkout just made, and the human picks where the session
// goes. The ODD names the checkout's directory (S7), so the create carries it
// and keeps its invalid, duplicate, occupied and principal refusals' shape. There
// is NO second name: the branch is derived from the type and the ODD. A new row
// is still born without an issue association.
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
  // S2: the ODD picker offers the ODDs that exist in `main`, read from its tree
  // with ONE bounded child here — never on a render or a keystroke, and never
  // from the working tree of whichever checkout this session happens to stand
  // in. A read that cannot answer is an EMPTY list: the picker still opens with
  // its `new odd` entry, so an unreadable `odd/tasks` is never an error.
  let oddOptions = [];
  try {
    if (typeof panelLib.listMainOddTasks === "function") {
      oddOptions = await panelLib.listMainOddTasks({ runAsync: libRunner(git), cwd: panelCwd });
    }
  } catch {
    oddOptions = [];
  }
  // S5 (warp-branch-field): one ODD is one worktree, so an ODD whose checkout
  // already exists is not a choice — the create would only refuse it. The
  // evidence is the RECONCILED pair the create itself resolves against: git's
  // live listing plus the registry rows whose directory still exists, so a stale
  // row for a removed checkout never hides an ODD that is free again.
  const occupiedPaths = await warpOccupiedCheckoutPaths(git, panelCwd);
  let out;
  try {
    out = await ctx.ui.custom(
      (hostTui, theme, _keybindings, done) => panelLib.createWarpCreatePanel({
        cwd: panelCwd,
        changeTypes: WARP_CHANGE_TYPES,
        oddOptions,
        occupiedPaths,
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
  // S1/S4 (warp-branch-field): the panel answers the branch it composed and the
  // ODD that names the directory, and the branch travels through UNCHANGED —
  // created when it is absent, adopted when it exists. Nothing derives it from
  // the ODD any more; the create core still owns the branch's own validity.
  const odd = typeof out.odd === "string" ? out.odd.trim() : "";
  if (odd === "") {
    notify?.('warp: the ODD is required: it names the checkout\'s directory (for example "login-ui"); nothing was created.', "error");
    return { closed: true, created: false };
  }
  const branch = typeof out.branch === "string" ? out.branch.trim() : "";
  if (branch === "") {
    notify?.('warp: the branch is required (for example "feat/login-ui"); nothing was created.', "error");
    return { closed: true, created: false };
  }
  const createParams = { branch, odd };
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
  // S53: the panel's create — a plain git checkout plus the registry row —
  // reusing the same creation path (validations,
  // refusals, registration), which never prompts. The layout is
  // principal-anchored (S56): the new checkout lands beside the PRINCIPAL
  // checkout even when the panel runs inside a linked worktree, while the
  // branch base is local main (S2).
  //
  // `backgroundHooks` is what makes a confirmed create feel instant: the
  // checkout path is all the warp needs, so the slow setup (install)
  // runs behind it and reports itself when it settles. The pending-change copy
  // is still AWAITED inside the create — it must be complete before the session
  // can move, or the human would switch into a checkout that is missing the
  // work they just asked to carry.
  const created = await executeWorktreeCreate(createParams, ctx, {
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

  // S7/S8/S9: the SAME active-session guard the close runs, and it runs
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

  // 4. Only a checkout THIS PACKAGE created can be closed. S3 makes the directory the
  // record, so a live checkout outside `<repo-name>-worktrees` was never ours to
  // remove; asking about one would be a question a human cannot act on, so it is
  // refused here — before the dialog.
  const mainRootForDelete = principal && typeof principal.path === "string" && principal.path.length > 0
    ? principal.path
    : repo.root;
  if (!registry.isOwnedCheckout(target.path, mainRootForDelete)) {
    notify?.(`warp: refusing to delete ${target.path}: it is a live checkout this package did not create (it is not under ${registry.worktreeDirectoryPath(mainRootForDelete)}); nothing was removed.`, "error");
    return;
  }

  // 5. The BEFORE reading: one snapshot of the exact target (its registered
  // row, its LIVE branch, whether it is still a live checkout) together with
  // the disclosure. The same snapshot is taken again AFTER the answer, and each
  // component is compared with its OWN earlier value — never the live branch
  // against the registry row, which legitimately disagree (the listing offers a
  // sole claimant's CURRENT branch, while the row stores the branch it was
  // registered with; B1: comparing the two refused every such deletion).
  const before = await warpDeleteSnapshot({ git, repo, targetPath: target.path, confirmLib });
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
    notify?.(`warp: refusing to delete ${target.path}: the identity of its directory could not be read, so a path replaced by another directory could not be told apart; nothing was removed — retry.`, "error");
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
    notify?.(`warp: refusing to delete ${target.path}: its uncommitted changes could not be read (${reason}), so nothing can say what would be lost; nothing was removed — retry.`, "error");
    return;
  }
  const content = evidence.content && typeof evidence.content === "object" ? evidence.content : null;
  if (!content || content.status !== "known") {
    const reason = content && typeof content.reason === "string" && content.reason.length > 0
      ? content.reason
      : "the pending content could not be fingerprinted";
    notify?.(`warp: refusing to delete ${target.path}: what is pending in it could not be fingerprinted (${reason}), so an identical +/- count could hide different work; nothing was removed — retry.`, "error");
    return;
  }
  const ignored = evidence.ignored && typeof evidence.ignored === "object" ? evidence.ignored : null;
  if (!ignored || ignored.status === "unknown") {
    const reason = ignored && typeof ignored.reason === "string" && ignored.reason.length > 0
      ? ignored.reason
      : "the ignored-file listing failed";
    notify?.(`warp: refusing to delete ${target.path}: the files git ignores there could not be listed (${reason}), so the removal could destroy work nobody was shown; nothing was removed — retry.`, "error");
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
  const after = await warpDeleteSnapshot({ git, repo, targetPath: target.path, confirmLib });
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
  const caveats = result && result.details && Array.isArray(result.details.warnings)
    ? result.details.warnings
    : [];
  for (const caveat of caveats) {
    if (typeof caveat !== "string" || caveat.length === 0) continue;
    notify?.(caveat, "warning");
  }
  // S7/S8/S9 as they reach the HUMAN: the shared close publishes the
  // active-session guard's caveats in `details.warnings` — a stale presence
  // record, a session it could not attribute, a truncated scan — and this panel
  // is the only surface that removes a checkout now, so here is where that
  // evidence is disclosed (docs/codebase/invariants.md invariant 4: disclosed,
  // never silently dropped). The guard's own strings are passed through
  // verbatim; one notice per caveat, and none of them changes the fact that the
  // removal happened.
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
//   - `live`: whether the checkout is still live AND the branch git reports for
//     it (whichever branch it is on — the listing offers a sole claimant's
//     CURRENT branch, so a checkout that was moved to another branch before the
//     dialog is normal and must never look like a mismatch),
//   - `evidence`: the disclosure, whose key covers counts, pending CONTENT and
//     the ignored-file list.
// A component that cannot be read makes the whole snapshot `ok:false`, because
// a comparison against an unreadable value would either pass on nothing or
// refuse on nothing.
async function warpDeleteSnapshot({ git, repo, targetPath, confirmLib }) {
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
    let freshLive;
    try {
      // S21: the selector re-reads the live listing on every iteration, so it
      // is awaited — the panel stays repaintable and keyed between reads.
      freshLive = await git.listWorktreesAsync(repo.root, { runAsync });
    } catch (err) {
      notify?.(`warp: cannot list worktrees: ${(err && err.message) || err}`, "error");
      return undefined;
    }
    // S3: the rows the selector offers ARE Git's listing; there is no document to
    // read, so nothing can fail here and nothing has to be kept in step with it.
    const freshRead = { ok: true, worktrees: registry.checkoutRows(freshLive) };
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
        const live = await git.listWorktreesAsync(repo.root, { runAsync });
        const read = { ok: true, worktrees: registry.checkoutRows(live) };
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
      else notifyWarpCopyRefused(notify, warpOut);
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
      // S5: one pending warp per session, refused on EVERY front here — the
      // selector is not even opened for a request that cannot run — except for
      // the pending request's own re-dispatched handoff, which is the move this
      // queue exists to perform.
      const earlyHandoff = raw.startsWith(WARP_HANDOFF_PREFIX) ? decodeWarpHandoff(raw) : null;
      const earlyGate = warpPendingGate(
        ctx,
        toolCwd(ctx),
        earlyHandoff && earlyHandoff.ok === true ? earlyHandoff.request : null,
      );
      if (earlyGate.pending && earlyGate.retry !== true) {
        notify?.(`worktree warp: ${warpPendingRefusalText(earlyGate.pending, raw)}`, "error");
        return;
      }
      // A handoff (this session's own queued warp) travels as ONE
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
        else notifyWarpCopyRefused(notify, moved);
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
        // S9 (warp-queue-boundary): a move that left the requested copy behind
        // says so once — the result text is the card's compact, not a notice.
        if (out.isError) {
          notify?.(out.text, "error");
        } else {
          notifyWarpCopyRefused(notify, out);
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
      let live;
      try {
        live = await git.listWorktreesAsync(repo.root, { runAsync });
      } catch (err) {
        notify?.(`warp: cannot list worktrees: ${(err && err.message) || err}`, "error");
        return;
      }
      // S3: a checkout is offered because Git lists it, not because a document
      // remembers it.
      const read = { ok: true, worktrees: registry.checkoutRows(live) };
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
      // stays silent, only failures notify. S9: a refused carry-copy is
      // disclosed in one line, because the move did happen without it.
      if (out.isError) {
        notify?.(out.text, "error");
      } else {
        notifyWarpCopyRefused(notify, out);
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
    if (typeof notify === "function") notify(`Unknown option "${raw}". Use /odd.`, "error");
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

// `/odd` (odd-viewer S1-S8): a two-pane viewer of this checkout's odd/
// documents — the list on the left, the styled markdown on the right.
function registerOddCommand(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("odd", {
    description: "Read this checkout's odd documents: list on the left, styled markdown on the right",
    handler: async (args, ctx) => {
      await executeOdd(args, ctx);
    },
  });
}

// ---------------------------------------------------------------------------
// `/files` (T7: S9, S14, S17): the file picker over one checkout of this clone.
//
// The command JOINS the modules that already own each half and decides nothing
// they own: `lib/files-index.js` lists Git's files with their change state and
// reads one bounded preview, `lib/files-orders.js` builds the three orders,
// `lib/files-preview.js` paints the preview pane's cells, `lib/files-insert.js`
// formats the text Enter pastes, `lib/files-scope-detail.js` reads the scope's
// Git facts, and `lib/files-scope-view.js` / `lib/files-picker-view.js` paint the
// two overlays. This front resolves the scopes from the package's own worktree
// seam and ownership rule, mounts the two overlays, pastes the insertion and
// hands the terminal to the editor.
//
// Read-only (S16): every child is the package's async runner behind one adapter,
// so nothing is spawned synchronously and nothing blocks the host event loop. The
// panel writes nothing; the only child it starts is the editor `ctrl+e` asks for.
// ---------------------------------------------------------------------------

// T7 honesty: there is no picker without an overlay, and this package offers no
// second surface in its place, so the one line says exactly that.
const FILES_NO_UI_LINE = 'files: the file picker needs an interactive session with overlay support';

// S9: two overlay shapes. The scope step is the small single-choice card; the
// picker takes the whole terminal's height budget (Pi truncates an overlay's rows
// from the bottom, so a smaller percentage would drop the footer line) and the
// width S15 needs for two panes.
const FILES_SCOPE_OVERLAY = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({ anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' }),
});
const FILES_PICKER_OVERLAY = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({ anchor: 'center', width: '85%', minWidth: 76, maxHeight: '100%' }),
});

let filesTuiLoader = () => import('@earendil-works/pi-tui');

function setFilesTuiLoader(loader) {
  filesTuiLoader = loader;
}

// S12: Pi's OWN highlighter and language mapper, resolved LAZILY at open time
// from the package root and never imported at module load — this package ships no
// node_modules, so a static import would break every load (the tests stub only
// the two existing import lines). An absent package leaves the preview plain.
let filesAgentLoader = () => import('@earendil-works/pi-coding-agent');

function setFilesAgentLoader(loader) {
  filesAgentLoader = loader;
}

function filesTerminalRows(hostTui) {
  try {
    const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
    if (Number.isFinite(rows) && rows > 0) return rows;
  } catch {
    // A hostile host object never breaks the panel.
  }
  return 24;
}

function filesRepaint(hostTui) {
  try {
    if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
  } catch {
    // A repaint failure never breaks the panel.
  }
}

// The overlay settles ONCE, and a host that already closed it never turns that
// into a throw on the way out.
function filesSettle(done, value) {
  try {
    if (typeof done === 'function') done(value);
  } catch {
    // A settled overlay is not a failed command.
  }
}

/**
 * S27: every close path of the picker overlay forces ONE full repaint after the
 * overlay settled — the reference's `withOverlayRepaint`
 * (`lib/overlay-repaint.ts:17-26`), which its `/changes` panel wraps around
 * `done` on every close it has (`extensions/gentle-shell.ts:1800`, and
 * `:1804`/`:1808` — `onOpen` closes the overlay, `onClose` closes it too).
 *
 * The order matters and this package now keeps it: the overlay settles and this
 * repaint lands while the terminal is STILL the session's, and only afterwards
 * does `mountFilesPicker` start the editor (which stops the terminal for the
 * duration, `lib/external-editor.ts:19,27-28`). Pi restores the editor behind a
 * closed overlay with an incremental diff render, and a fullscreen overlay's
 * stale cell state survives that pass — the prompt keeps working while the screen
 * stops updating, reported as a frozen session after `ctrl+e`.
 * `requestRender(true)` resets the written-frame state so the next paint rewrites
 * EVERY cell. `done` runs first, so the overlay is torn down before the forced
 * paint is scheduled, and a dead terminal never breaks the close path.
 */
function filesCloseOverlay(hostTui, done) {
  return (value) => {
    filesSettle(done, value);
    try {
      if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender(true);
    } catch {
      // Best-effort repaint: never break the overlay's close path.
    }
  };
}

// The one runner shape the files modules take: `run(args, { cwd, timeoutMs })`
// over ONE fixed argv array and the package's bounded async runner, so no caller
// builds a shell string and no read blocks the host event loop (invariant 9).
function filesRunner(git) {
  return (args, options) => {
    const opts = options !== null && typeof options === 'object' ? options : {};
    const call = { cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined };
    const timeoutMs = Number(opts.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) call.timeoutMs = timeoutMs;
    return git.runArgvAsync('git', args, call);
  };
}

/**
 * S9/S35: the checkouts Git reports for this clone — the principal checkout and
 * the whole live listing behind it. Which of them the step offers by DEFAULT is
 * the session's own business, not this package's (`filesSessionScopes`): a
 * worktree this package created for some ODD is not necessarily one this session
 * works in, and that difference is exactly what `a` is for. `repo.root` is the
 * session's own checkout, whichever worktree it is. The reads are the awaited
 * ones, so opening the picker never freezes the session.
 */
async function filesCheckouts(cwd) {
  const git = libRequire('worktree-git.js');
  const runAsync = libRunner(git);
  const repo = await git.repoIdentityAsync(cwd, { runAsync });
  let entries = [];
  try {
    entries = await git.listWorktreesAsync(repo.root, { runAsync });
  } catch {
    entries = [];
  }
  const main = entries[0];
  let mainRoot = main && typeof main.path === 'string' && main.path.length > 0 ? main.path : repo.root;
  try {
    mainRoot = fs.realpathSync(mainRoot);
  } catch {
    // Git's own spelling is all it answered.
  }
  return { repo, mainRoot, entries };
}

// S9: the ODD directory IS a checkout's identity in this package (invariant 12),
// so a worktree row reads `<odd> · <branch>`; a detached checkout names no branch
// and keeps just its directory.
function filesWorktreeLabel(root, branch) {
  const name = path.basename(root);
  return typeof branch === 'string' && branch.length > 0 ? `${name} · ${branch}` : name;
}

/** The canonical spelling of a path, or the one Git answered when it cannot be resolved. */
function filesCanonicalPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * S20/S35: every worktree of the clone, minus its principal checkout — the list
 * `a` toggles to, and the ONLY row source that asks "which worktrees does Git
 * know", never "which did this session register". Discovered the way
 * `worktree_list` discovers them (Git's own `git worktree list --porcelain`
 * listing) and kept by the SAME liveness rule the default list uses, so a record
 * whose directory is gone is never offered. The root keeps Git's spelling, which
 * is the spelling the default rows carry, so a
 * scope both lists hold is the same scope to the view's cursor.
 */
function filesAllWorktrees(checkouts) {
  const seen = new Set([filesCanonicalPath(checkouts.mainRoot)]);
  const others = [];
  for (const entry of checkouts.entries) {
    if (!isLiveGitRecord(entry, checkouts.repo.root)) continue;
    const canonical = filesCanonicalPath(entry.path);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    others.push({
      root: entry.path,
      kind: 'worktree',
      label: filesWorktreeLabel(entry.path, entry.branch),
    });
  }
  return others;
}

/**
 * S9: the two numbers a scope row and its detail line show. The uncommitted set
 * is the picker's own listing (`state !== "clean"`) and its newest mtime is "the
 * age of the last modification"; the line above the footer is
 * `lib/files-scope-detail.js` with `origin/main` for the principal row and the
 * local `main` for every worktree. A read that failed leaves its fields absent, so
 * the step paints less instead of claiming a zero nobody measured.
 */
async function filesScopeFacts(index, detailLib, run, scope) {
  const facts = {};
  try {
    const listing = await index.listRepositoryEntries({ run, cwd: scope.root });
    if (listing && listing.ok === true && Array.isArray(listing.entries)) {
      let changed = 0;
      let newest;
      for (const entry of listing.entries) {
        if (!entry || entry.state === 'clean') continue;
        changed += 1;
        const mtime = Number(entry.mtimeMs);
        if (Number.isFinite(mtime) && (newest === undefined || mtime > newest)) newest = mtime;
      }
      facts.changedFiles = changed;
      if (newest !== undefined) facts.lastModifiedMs = newest;
    }
    const loaded = await detailLib.loadScopeDetail({
      run,
      cwd: scope.root,
      comparison: scope.kind === 'main' ? detailLib.REMOTE_MAIN : detailLib.LOCAL_MAIN,
    });
    // The view paints the count and the age out of `detail`, and orders the rows
    // by the scope's own `lastModifiedMs`, so both carry the same numbers.
    facts.detail = { ...(loaded !== null && typeof loaded === 'object' ? loaded : {}), ...facts };
  } catch {
    facts.detail = {};
  }
  return { ...scope, ...facts };
}

/**
 * S35: the worktrees THIS SESSION registered through the host's
 * `worktree_register` tool (`session_worktree_register`, reached here through
 * lib/session-worktree-register.js). The tool's durable store is the session
 * itself: one `custom` entry per registration under the shared
 * `gentle-pi.session-worktree/v1` type, carrying `{ sessionId, root, evidence }`.
 * Only the current session's records count — the same current-session check the
 * registry on the host side makes — so a forked or resumed session reads its own
 * rows. An unreadable session manager, a missing session id and a malformed entry
 * all read as "nothing registered", never as a throw.
 */
function filesSessionWorktreeRoots(ctx) {
  const sm = ctx && ctx.sessionManager ? ctx.sessionManager : null;
  if (!sm) return [];
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const sessionId = typeof sm.getSessionId === 'function' ? safe(() => sm.getSessionId()) : undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
  const entries = typeof sm.getEntries === 'function' ? safe(() => sm.getEntries()) : undefined;
  if (!Array.isArray(entries)) return [];
  const warpSessions = libRequire('worktree-warp-sessions.js');
  const roots = [];
  for (const entry of entries) {
    if (!entry || entry.type !== 'custom' || entry.customType !== warpSessions.SESSION_WORKTREE_CUSTOM_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== 'object') continue;
    if (data.sessionId !== sessionId) continue;
    if (typeof data.root !== 'string' || data.root.length === 0) continue;
    roots.push(data.root);
  }
  return roots;
}

/**
 * S35: the DEFAULT rows of the scope step — `main`, the session's own checkout
 * (deduplicated when it IS `main`) and the worktrees this session registered,
 * each only while it is still live. A worktree this package created for another
 * ODD is NOT one of them: that is `a`'s list (`filesAllWorktrees`), and keeping the
 * two apart is the rule. Every root keeps the spelling Git's listing gave it when
 * Git lists it, which is the spelling the `a` list carries, so a scope both lists
 * hold is the same scope to the view's cursor.
 */
function filesSessionScopes(checkouts, cwd, registeredRoots) {
  const byCanonical = new Map();
  for (const entry of Array.isArray(checkouts.entries) ? checkouts.entries : []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const canonical = filesCanonicalPath(entry.path);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, entry);
  }
  const seen = new Set([filesCanonicalPath(checkouts.mainRoot)]);
  const sessionRoot = typeof checkouts.repo.root === 'string' && checkouts.repo.root.length > 0
    ? checkouts.repo.root
    : cwd;
  const scopes = [{ root: checkouts.mainRoot, kind: 'main', label: 'main' }];
  for (const root of [sessionRoot, ...(Array.isArray(registeredRoots) ? registeredRoots : [])]) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const canonical = filesCanonicalPath(root);
    if (seen.has(canonical)) continue;
    const listed = byCanonical.get(canonical);
    const entry = listed === undefined ? { path: root } : listed;
    if (!isLiveGitRecord(entry, checkouts.repo.root)) continue;
    seen.add(canonical);
    scopes.push({
      root: entry.path,
      kind: 'worktree',
      label: filesWorktreeLabel(entry.path, entry.branch),
    });
  }
  return scopes;
}

/**
 * S9/S20/S35: the two lists the scope step offers. `registered` is the default —
 * `main`, the session's own checkout and the worktrees this session registered
 * through `worktree_register` (`filesSessionScopes`) — and `all` is every worktree
 * of the clone Git's listing reports, which is what `a` alone switches to. Both are
 * built here, before the step opens, because the view takes finished lists and
 * never reads Git itself; and both read their facts whether or not there is a
 * second checkout, because S20 always shows the step.
 */
async function filesScopeLists(cwd, ctx) {
  const checkouts = await filesCheckouts(cwd);
  const index = libRequire('files-index.js');
  const detailLib = libRequire('files-scope-detail.js');
  const run = filesRunner(libRequire('worktree-git.js'));
  const read = (scope) => filesScopeFacts(index, detailLib, run, scope);
  const registered = await Promise.all(
    filesSessionScopes(checkouts, cwd, filesSessionWorktreeRoots(ctx)).map((scope) => read(scope)),
  );
  const all = await Promise.all([
    read({ root: checkouts.mainRoot, kind: 'main', label: 'main' }),
    ...filesAllWorktrees(checkouts).map((scope) => read(scope)),
  ]);
  return { registered, all };
}

/**
 * S12: Pi's highlighter and language mapper, resolved once per open. The
 * `highlight` seam hands back `undefined` for anything that is not real syntax
 * colour: Pi paints a language whose grammar it has not loaded with the same
 * uniform code tone it uses for no language at all, and the two passes are how
 * that is told apart. Every throw degrades to plain text, never to a partial
 * paint.
 */
async function filesAgentSeam() {
  let agent;
  try {
    agent = await filesAgentLoader();
  } catch {
    return {};
  }
  if (agent === null || typeof agent !== 'object') return {};
  const highlight = typeof agent.highlightCode === 'function'
    ? (code, language) => {
      try {
        const painted = agent.highlightCode(code, language);
        if (!Array.isArray(painted)) return undefined;
        const plain = agent.highlightCode(code);
        if (Array.isArray(plain) && plain.length === painted.length && plain.every((line, index) => line === painted[index])) {
          return undefined;
        }
        return painted;
      } catch {
        return undefined;
      }
    }
    : undefined;
  const languageForPath = typeof agent.getLanguageFromPath === 'function'
    ? (filePath) => {
      try {
        const language = agent.getLanguageFromPath(filePath);
        return typeof language === 'string' && language.length > 0 ? language : undefined;
      } catch {
        return undefined;
      }
    }
    : undefined;
  return { highlight, languageForPath };
}

/**
 * S7/S8: Enter's payload. The insertion form is `lib/files-insert.js`'s alone
 * (`@` plus the path from the session cwd for a file of this checkout, the real
 * absolute path for any other checkout), it goes into the editor through the
 * host's own paste seam, and NOTHING is sent: the message stays unsent.
 */
function filesInsert(ctx, insertLib, scope, cwd, paths, notify) {
  const text = insertLib.formatFileInsertion(paths, { root: scope.root, kind: scope.kind, cwd });
  if (text.length === 0) return;
  try {
    if (ctx.ui && typeof ctx.ui.pasteToEditor === 'function') {
      ctx.ui.pasteToEditor(text);
      return;
    }
  } catch {
    // Fall through to the honest line: the text never reached the editor.
  }
  if (notify) notify(`files: the editor did not accept the insertion: ${text}`, 'warning');
}

/**
 * S14: the editor handoff. The picker repaints nothing on the way out (its own
 * `finish` guarantees that), and this stops the terminal BEFORE the editor takes
 * it — the same suspend/resume the odd viewer uses — so no frame is torn and the
 * one full repaint happens after the editor EXITS, which is the jolt the
 * reference complained about. The opener is the shared `lib/open-external.js`
 * one, so a missing $VISUAL/$EDITOR is its own sentence, reported here.
 */
async function filesOpenEditor(hostTui, absolutePath, notify) {
  let result;
  try {
    result = await openExternalSuspended(hostTui, absolutePath);
  } catch (err) {
    result = { ok: false, error: (err && err.message) || String(err) };
  }
  if (result && result.ok === true) return;
  if (notify) notify(`files: ${(result && result.error) || 'cannot open the editor'}`, 'warning');
}

/** The picker overlay (S1-S6, S14, S15) over one resolved scope. */
async function mountFilesPicker(ctx, input) {
  const index = libRequire('files-index.js');
  const insertLib = libRequire('files-insert.js');
  const pickerView = libRequire('files-picker-view.js');
  const run = filesRunner(libRequire('worktree-git.js'));
  const agent = await filesAgentSeam();
  const scope = input.scope;
  // S27: the terminal is handed over the way the reference does it — the overlay
  // settles FIRST (`ctrl+e` only RECORDS the file here), so the forced close
  // repaint lands on a live terminal, and the editor starts afterwards, when
  // `ctx.ui.custom` has resolved. The view is disposed in the same `finally` that
  // follows the handoff, so no path leaves it alive.
  let hostTui = null;
  let view = null;
  let openPath = null;
  const disposeView = () => {
    const created = view;
    view = null;
    if (created === null || typeof created.dispose !== 'function') return;
    try {
      created.dispose();
    } catch {
      // A view that cannot clean up is not a failed command.
    }
  };
  try {
    await ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        hostTui = tui;
        const close = filesCloseOverlay(tui, done);
        view = pickerView.createFilesPickerView({
          theme,
          helpers: input.helpers,
          rowsAvailable: () => filesTerminalRows(tui),
          scope,
          cwd: input.cwd,
          // The listing and the preview are the T1 reader's own, read from the scope
          // root rather than the session cwd: the picker browses another checkout.
          loadEntries: () => index.listRepositoryEntries({ run, cwd: scope.root }),
          loadPreview: (relative) => index.readFilePreview(scope.root, relative),
          ...(agent.highlight === undefined ? {} : { highlight: agent.highlight }),
          ...(agent.languageForPath === undefined ? {} : { languageForPath: agent.languageForPath }),
          onInsert: (paths) => filesInsert(ctx, insertLib, scope, input.cwd, paths, input.notify),
          // S27: record only. Spawning here would stop the terminal before the
          // overlay settled, which is exactly the order the reference does not use.
          onOpen: (relative) => {
            openPath = relative;
          },
          onClose: () => close(null),
          requestRender: () => filesRepaint(tui),
        });
        return view;
      },
      FILES_PICKER_OVERLAY,
    );
    if (openPath !== null && hostTui !== null) {
      // The file's real absolute path, never the repository-relative one: the
      // editor is a plain child process and knows no checkout.
      await filesOpenEditor(hostTui, path.join(scope.root, openPath), input.notify);
    }
  } finally {
    // Insert, `esc` and the editor path all land here; the view never outlives it.
    disposeView();
  }
}

async function executeFiles(rawArgs, ctx) {
  const notify = ctx && ctx.ui && typeof ctx.ui.notify === 'function'
    ? (text, level) => {
      try {
        ctx.ui.notify(text, level);
      } catch {
        // A dead UI never fails the command.
      }
    }
    : null;
  const raw = String(rawArgs ?? '').trim();
  if (raw !== '') {
    if (notify) notify(`Unknown option "${raw}". Use /files with no argument.`, 'error');
    return;
  }
  // S17: without an overlay there is no picker to paint, and the one line says
  // so instead of opening a second surface or throwing into the host.
  if (!ctx || !ctx.ui || typeof ctx.ui.custom !== 'function') {
    if (notify) notify(FILES_NO_UI_LINE, 'info');
    return;
  }
  const cwd = toolCwd(ctx);
  let lists;
  try {
    lists = await filesScopeLists(cwd, ctx);
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (notify) {
      notify(/not a git repository/i.test(message) ? notGitRepositoryLine(cwd) : `files: ${message}`, 'info');
    }
    return;
  }
  let helpers = {};
  try {
    helpers = (await filesTuiLoader()) || {};
  } catch {
    helpers = {};
  }
  // S20: the checkout selector opens on EVERY invocation, the session's own
  // checkout included and even when nothing is registered — `a` widens it to
  // every worktree of the clone. Both lists are resolved above, so the step never
  // reads Git or awaits anything while it is painted.
  const scopeView = libRequire('files-scope-view.js');
  const picked = await ctx.ui.custom(
    (hostTui, theme, _keybindings, done) => scopeView.createFilesScopeView({
      scopes: lists.registered,
      allScopes: lists.all,
      theme,
      helpers,
      rowsAvailable: () => filesTerminalRows(hostTui),
      // The step answers the ORIGINAL scope object, which is what the picker
      // then lists: nothing is re-resolved from a label or a path.
      onSelect: (chosen) => filesSettle(done, chosen),
      onClose: () => filesSettle(done, null),
      requestRender: () => filesRepaint(hostTui),
    }),
    FILES_SCOPE_OVERLAY,
  );
  // The `esc` path closes the step and opens nothing else.
  if (!picked) return;
  await mountFilesPicker(ctx, { scope: picked, cwd, helpers, notify });
}

// S36 (files-picker T15): the handler `/files` registered, kept so the bound
// shortcut runs the SAME path — a key and its command can never drift apart.
// `null` until the command is registered.
let filesCommandHandler = null;

// `/files` (files-picker T7): browse one checkout's files, insert the chosen
// paths into the editor, open one in $EDITOR. A handler that threw would break the
// host's command dispatch, so the one unexpected failure is reported as a line.
function registerFilesCommand(pi) {
  if (typeof pi?.registerCommand !== 'function') return;
  const handler = async (args, ctx) => {
    try {
      await executeFiles(args, ctx);
    } catch (err) {
      const notify = ctx && ctx.ui && typeof ctx.ui.notify === 'function' ? ctx.ui.notify : undefined;
      if (typeof notify !== 'function') return;
      const message = String((err && err.message) || err).split('\n')[0];
      try {
        notify(`files: the picker could not open: ${message}`, 'error');
      } catch {
        // A dead UI never turns a failed open into a throw.
      }
    }
  };
  pi.registerCommand('files', {
    description: "Browse one checkout's files with a live preview: enter inserts the paths, ctrl+e opens $EDITOR",
    handler,
  });
  filesCommandHandler = handler;
}

// ---------------------------------------------------------------------------
// `/issues` (T3 S1,S3): a full-screen issues reader over the CURRENT checkout's
// repository issues, through this package's own migrated pieces
// (lib/gh-issues.js for `gh`, lib/issues-view.js for the pure view).
//
// GATED INVOCATION: the command is registered eagerly at load so it is always
// discoverable; the session-start `gh` check only decides whether it may open.
// Without an authenticated `gh`, one notification per session names what is
// missing and the command that fixes it, and the handler re-emits it instead
// of opening. The three scoped tabs read cursor search pages (author:@me,
// assignee:@me, involves:@me -author:@me) and are the only reads opening costs;
// the `All` view (the `g` shortcut, never a tab) reads the repository's own
// open issue connection, unfiltered — a filtered `All` is a capped search
// instead. The detail asks for authoritative metadata, and the
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
// for last-update ordering so no client re-sorts. `All` is NOT a tab: it is the
// interactive reader's shortcut view (S1/S2) — every open issue of the
// repository, with nothing inferred or deduplicated against the three scoped
// ones, marked `lazy` so the mount-time prefetch skips it and it is read the
// first time the reader's shortcut key enters it.
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
  // query; it is never forwarded to the connection, which takes no text — which
  // is why a FILTERED `All` read is a capped search and the view marks that
  // count inexact (S5). `lazy` keeps it out of the tab bar, the tab cycle and
  // the prefetch, so opening `/issues` costs the three scoped reads.
  { id: "all", label: "All", query: "sort:updated-desc", connection: true, lazy: true },
];

const ISSUES_FETCH_PAGE_SIZE = 30;

// A failed gate notifies once per session (module lifetime == session). The
// flag flips only when an alert is handed to notify, so a startup without UI
// never consumes the session's single alert.
let issuesGateNotified = false;
// `null` = not probed yet, `true` = gh was usable this session, `false` = the
// last probe failed. Registration is eager; this state gates ONLY the open.
let issuesGateOpen = null;
// S5 (T8): the probe `session_start` dispatched, and the generation it ran in.
// Nothing in `session_start` awaits it; a surface that needs the verdict (`/issues`)
// awaits this same promise instead of starting a second probe. The generation moves
// on at every session start and shutdown, so a verdict the previous checkout is
// still holding lands nowhere instead of gating the session that replaced it.
let issuesGateProbe = null;
let issuesGateGeneration = 0;

// S3 (issues-sidebar): the rail section beside the `/issues` reader. The
// bridge is read from its published slot, never imported; the section reads ONE
// in-process snapshot per frame and refreshes on its frame TTL and on the
// session's own activity behind the floor below — never at `session_start`, and
// never while it is hidden (T13).
const ISSUES_SIDEBAR_BRIDGE_SLOT = Symbol.for("gentle-shell-bridge/api/v1");
const ISSUES_SIDEBAR_READY_EVENT = "gentle-shell-bridge:ready";
// S2 amended (T11): the ONE hint a host without the bridge gets. It names the
// install command verbatim, because the user's own words were "pone el comando
// de instalacion".
const ISSUES_SIDEBAR_INSTALL_HINT = "the issues rail needs the gentle-shell-bridge plugin: install it with pi install npm:gentle-shell-bridge";
// The announcement window. An empty slot at `session_start` is "not yet" — the
// bridge publishes from its own extension load — so the check waits this long
// before it is honest to call the plugin missing.
const ISSUES_SIDEBAR_INSTALL_WINDOW_MS = 2000;
// "One warning per process" includes a `/reload`, which builds a NEW instance of
// this module: the fact that the human was already told lives on a process-wide
// slot, exactly like the bridge's own published object does.
const ISSUES_SIDEBAR_WARN_SLOT = Symbol.for("odd-worktree/issues-sidebar/install-warned");
// S3 (activity floor): a frame only exists when the host has a reason to produce
// one, so the TTL never fires on a session that is merely in use. The session's
// own events ask for a read at most once per this floor.
const ISSUES_SIDEBAR_ACTIVITY_FLOOR_MS = 30000;
// S10 (T8, L9): what the user asked for in his own words ("deberia ser algo que
// compruebe cada cierto tiempo nomas, como cada 10seg o 20seg") and what the
// parent decided: while the section is DRAWN, one self-scheduled, unref'd timer
// reads the rail at this floor. It is the reason an idle session is no longer
// stale, and the activity hooks below never add a read on top of it.
const ISSUES_SIDEBAR_TIME_FLOOR_MS = 20000;
// S10 (T9, L9): a `bash` command that mutates an issue or a pull request forces
// ONE read after its result — capped to one per this floor, so a script running
// several `gh` writes cannot storm the API.
const ISSUES_SIDEBAR_FORCED_FLOOR_MS = 5000;
// S3 amended (T13, L11: "estas comprobaciones se hacen solo si la sidebar de
// issues esta mostrada, o sea, no hidden"): the DRAWN WINDOW. The activity hooks
// read only while the section was drawn in the last two minutes, and S10 (T8)
// makes it the floor timer's own stop window — the timer stops by itself once the
// section leaves it — so a section the human hid stops the network for good once
// the window passes (no child process, no timer), and showing it again starts
// from `loading…`.
const ISSUES_SIDEBAR_DRAWN_WINDOW_MS = 120000;
// S4 (issues-startup-performance T3): the ONE bound the read cache and its disk
// half share. `lib/related-issues-cache.js` measures how long a FULL read stays
// authoritative from the last full apply; the loader holds a stored entry to the
// SAME bound before it hydrates it, so persistence can never turn a stale entry
// into a fresh one.
const ISSUES_CACHE_FULL_TTL_MS = 600000;
// The most recent `session_start` context: the section's `load` and `open`
// belong to the checkout the session runs in, not to whatever cwd this process
// happens to have.
let issuesSidebarCtx = null;
// T18 (S11): the live binding of the rail section. `issuesSidebarHandle` is the
// section module's handle (its `dispose()` is what finally stops the floor timer),
// `issuesSidebarDisposer` is the bridge's own unregister for it, and
// `issuesSidebarApi` is the published bridge object the bash design was registered
// on. A new publication (a republished bridge) is a new object and therefore a
// new binding; the previous one is torn down before the new one is made, exactly
// like the file picker's own bridge contribution.
let issuesSidebarHandle = null;
let issuesSidebarDisposer = null;
let issuesSidebarApi = null;
let issuesSidebarSubscribed = false;
// S9 (issues-sidebar T14): the process-local cache of the three scoped issue
// views. It is pure (`lib/related-issues-cache.js`), keyed by the PROVEN repository
// identity, and it is the layer that decides what a read means. Its DISK half is
// `lib/issues-cache-store.js` (S4/T3 of issues-startup-performance), reached from
// the async loader alone; a session boundary no longer clears these entries.
let issuesSidebarCache = null;
// S4 (T3): the disk half, built lazily like the cache. Missing or broken, the
// read is exactly the in-process one it always was.
let issuesCacheStore = null;
// S21 (T17): identities a panel write invalidated because it changed the
// VIEWER's own assignment. Dropping the entry is what makes `plan` answer the
// FULL read, but the disk half would hydrate that same stale entry back before
// `plan` sees the drop (an entry past the window is the only one the store
// refuses), so the identity is marked here until a full read lands: the next
// read of it skips hydration. It is keyed by repository identity like the cache
// itself, survives a session boundary for the same reason the disk half does,
// and costs nothing once the read replaces the document.
const issuesSidebarFullReadIdentities = new Set();
// T15 (S9, defect 4): the cache wiring's generation. Every read captures it when
// it STARTS and may write its answer only while it is still current; a session
// boundary, a shutdown or a rebinding moves it on, so a read that outlived its
// session can never apply its answer to the cache the next session reads. A
// discarded answer still returns its rows to the section, whose own token decides
// whether they paint.
let issuesSidebarCacheGeneration = 0;
// T15 (S9, defect 5): every read is numbered when it STARTS (before any await), so
// the cache can ignore an answer that is older than the last one applied for the
// same identity — a full read that finishes late never overwrites a newer one.
let issuesSidebarReadSequence = 0;
// T11: one hint per process. `Armed` keeps two session starts from arming two
// checks; `Announced` is what a late publication sets, so the deferred check
// never speaks over a bridge that arrived; the "already told the human" fact
// itself lives on the process-wide slot above, so `/reload` is silent too.
let issuesSidebarInstallArmed = false;
let issuesSidebarInstallAnnounced = false;
// S1 (issues-sidebar-click T1): ONE rail open at a time. A click on a row (or on
// the overflow row) takes this token SYNCHRONOUSLY before `sendUserMessage`, so
// two clicks in the same tick cannot both pass, and a click while it is held does
// nothing at all: no second command, no overlay, no notice, no paint. The command
// the host runs next RELEASES it — right before the overlay mounts, and on every
// early return or throw before that — and the bounded timer below is the backstop,
// because `sendUserMessage` returns `void` by contract: a command the host never
// runs must not leave the rail dead. The token remembers the session generation
// it was taken under (`issuesSidebarCacheGeneration`, the clock the cache already
// uses), so a click left over by a previous session is inert and can never block
// the next one.
const ISSUES_PANEL_OPEN_GUARD_MS = 10000;
let issuesPanelOpenToken = null;
let issuesPanelOpenTimer = null;
// S2 (issues-sidebar-click T1, second half): the rail row carries the identity the
// section proved when it READ that row, and the click leaves it here as a ONE-SHOT
// hint for the numbered open it dispatches — so that open pins exactly that identity
// with no probe at all. It lives beside the token and is cleared with it, so a hint
// can never outlive the open (`releaseIssuesPanelOpen`).
let issuesPanelOpenHint = null;

function clearIssuesPanelOpenTimer() {
  if (issuesPanelOpenTimer === null) return;
  const timer = issuesPanelOpenTimer;
  issuesPanelOpenTimer = null;
  try {
    clearTimeout(timer);
  } catch {
    // A host timer that cannot be cancelled still fires into a released guard.
  }
}

// Idempotent, and scoped to one token when one is named, so a release can never
// clear a NEWER open's guard.
function releaseIssuesPanelOpen(token) {
  if (token !== undefined && issuesPanelOpenToken !== token) return;
  clearIssuesPanelOpenTimer();
  issuesPanelOpenToken = null;
  // The hint belonged to the open that token guarded: released with it, so no
  // click's identity can ever outlive the open it was taken for.
  issuesPanelOpenHint = null;
}

// Only a token from the CURRENT session generation blocks: `session_start`,
// `session_shutdown` and a bridge rebinding each move that generation on.
function issuesPanelOpenBlocked() {
  if (issuesPanelOpenToken === null) return false;
  return issuesPanelOpenToken.generation === issuesSidebarCacheGeneration;
}

// S2: the one-shot hint a rail click left for the numbered open it dispatched. It
// applies to the SAME number only, and only in the generation it was recorded
// under; taking it consumes it, so the next open of that number proves the identity
// again. A hint for another number is left alone (its own open may still come, and
// any release clears it).
function takeIssuesPanelOpenHint(number) {
  const hint = issuesPanelOpenHint;
  if (hint === null) return null;
  if (!Number.isInteger(number) || hint.number !== number) return null;
  if (hint.generation !== issuesSidebarCacheGeneration) return null;
  issuesPanelOpenHint = null;
  return hint.identity;
}

function armIssuesPanelOpenGuard(token) {
  clearIssuesPanelOpenTimer();
  let timer = null;
  try {
    timer = setTimeout(() => {
      releaseIssuesPanelOpen(token);
    }, ISSUES_PANEL_OPEN_GUARD_MS);
  } catch {
    timer = null;
  }
  // Unref'd: the interval is a safety net for the rail, never a reason for the
  // process to stay alive.
  if (timer && typeof timer.unref === "function") {
    try {
      timer.unref();
    } catch {
      // A host timer without a working unref still bounds the wait.
    }
  }
  issuesPanelOpenTimer = timer;
}

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
// from, even if the checkout's remote moved while the reader is open. The identity
// is normalized with the same function every pinned read uses before it reaches
// `-R`, so no raw value can ever move this open: a value that does not normalize
// is not an identity, and the opener keeps its own "nothing loaded yet" refusal.
function issuesOpenInBrowser(hostTui, cwd, number, pinnedIdentity) {
  try {
    const gh = libRequire("gh-issues.js");
    const git = libRequire("worktree-git.js");
    if (!git || typeof git.runArgvAsync !== "function") {
      return Promise.resolve({ ok: false, error: "cannot open the browser: no fixed-argv runner" });
    }
    const normalized = typeof pinnedIdentity === "string"
      && gh && typeof gh.normalizeScopeIdentity === "function"
      ? gh.normalizeScopeIdentity(pinnedIdentity, process.env)
      : null;
    if (!normalized || normalized.ok !== true || typeof normalized.identity !== "string"
      || normalized.identity.length === 0) {
      return Promise.resolve({ ok: false, error: "the issue list has not loaded a repository yet" });
    }
    const bin = gh && typeof gh.ghBinary === "function" ? gh.ghBinary({}) : "gh";
    const argv = ["issue", "view", String(number), "--web", "-R", normalized.identity];
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

// The ONE identity a browser open is bound to, proven in one order and one
// place: `/issues` pins it when its list loads (S5 of the issues reader) and the
// related-issues section reads and opens with it (issues-sidebar S4/S6), so the
// list and the row click always name the same repository. A non-empty GH_REPO is
// the caller's own scope and is normalized as given; otherwise the checkout's own
// scope decides, and a checkout with ONE remote has no scope identity to pin
// (nothing to disambiguate), so gh's own resolution is normalized instead. Every
// answer is one HOST-QUALIFIED `<host>/<owner>/<repo>` string — the form gh
// accepts for both GH_REPO and `-R` — and the host is part of it, because the
// same owner/name on a fork's server and on an enterprise server are different
// repositories.
async function issuesBrowserRepoIdentity(gh, checkoutRoot, fresh) {
  const envRepo = typeof process.env.GH_REPO === "string" && process.env.GH_REPO.trim() !== ""
    ? process.env.GH_REPO.trim()
    : null;
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
  // A checkout with one remote has nothing to disambiguate, so gh resolves it;
  // the answer is qualified with the host gh itself would use (GH_HOST, else
  // github.com), never left as a host-less name.
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
}

// S1 (issues-sidebar-click T1): the rail click that dispatched this command — if
// one did — owns the single-flight guard, and EVERY exit of the open releases it:
// the early returns below, a throw, and the moment the overlay mounts (which is
// where `openIssuesPanel` releases it, before the human is looking at it). The
// release is scoped to the token captured HERE, so a typed `/issues` (which owns
// no token) releases nothing and can never clear a newer click's guard.
async function executeIssues(rawArgs, ctx, checkoutRoot) {
  const openToken = issuesPanelOpenToken;
  const releaseOpen = () => {
    if (openToken === null) return;
    releaseIssuesPanelOpen(openToken);
  };
  try {
    return await openIssuesPanel(rawArgs, ctx, releaseOpen, checkoutRoot);
  } finally {
    releaseOpen();
  }
}

// S3 (issues-startup-performance T2): `checkoutRoot` is the local resolution the
// command's own gate ALREADY performed (one `git rev-parse` pair) — handed over so
// the open never pays for a second one. Absent, the open resolves it itself exactly
// as before.
async function openIssuesPanel(rawArgs, ctx, releaseOpen, resolvedCheckoutRoot) {
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  const raw = String(rawArgs ?? "").trim();
  // S7: `/issues <number>` (also `#<number>`) opens the same panel on one
  // issue. ONLY a bare positive integer is accepted; every other argument keeps
  // this command's original refusal, so `/issues`, a typo and a second argument
  // behave exactly as before. The number adds nothing before the gate, the
  // checkout resolution or the identity pin — they all run as for a plain open.
  let initialIssue = null;
  if (raw !== "") {
    const match = /^#?(\d+)$/.exec(raw);
    const number = match ? Number(match[1]) : NaN;
    if (!match || !Number.isInteger(number) || number <= 0) {
      if (typeof notify === "function") notify(`Unknown option "${raw}". Use /issues.`, "error");
      return;
    }
    initialIssue = number;
  }
  const cwd = toolCwd(ctx);
  // The reader belongs to the checkout the session runs in: inside a worktree
  // that is the worktree, never the principal. Anything that cannot resolve to
  // a Git root fails closed instead of guessing.
  const checkoutRoot = typeof resolvedCheckoutRoot === "string" && resolvedCheckoutRoot.length > 0
    ? resolvedCheckoutRoot
    : await oddCheckoutRootAsync(cwd);
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
  // S2 (issues-sidebar-click T1, second half): a click on a rail row carries the
  // identity the section proved when it READ that row, and this consumes it as a
  // one-shot hint: that exact identity is pinned with NO probe at all — no `git`,
  // no `gh`, no cached-scope read — so the first frame paints as soon as the TUI
  // helper is loaded. The issue number belongs to the repository the row was read
  // from, so opening THAT repository is the right target even if the checkout has
  // moved since; nothing that mutates rides it, because every action still
  // re-proves the checkout fresh in `scopeDrift` and refuses on drift. A numbered
  // open without a matching hint (a typed `/issues 12`, a stale generation, a hint
  // for another number) takes the cached-scope pin below, and a plain `/issues`
  // keeps the fresh proof.
  const hintedIdentity = initialIssue === null ? null : takeIssuesPanelOpenHint(initialIssue);
  // The repository identity is PINNED when the list loads, as ONE
  // HOST-QUALIFIED string (`<host>/<owner>/<repo>`, the form gh accepts for
  // GH_REPO and `-R`). The proof itself is the shared helper, so the sidebar
  // section opens the same repository this reader does.
  // Every later read, every action and the `o` opener bind exactly that string.
  const effectiveRepo = async (fresh) => issuesBrowserRepoIdentity(gh, checkoutRoot, fresh);
  // S2 (issues-sidebar-click T1): a numbered open — the form the rail dispatches —
  // pins the identity the checkout already proved for the rail's read, so its
  // first frame no longer waits on a fresh `git`/`gh` proof. A typed `/issues`
  // keeps that fresh proof, and a cached pin that cannot be read falls back to it
  // ONCE. Nothing that mutates rides this: `scopeDrift` still re-proves the
  // checkout with a fresh read before every action.
  const pinIdentity = (fresh) => effectiveRepo(fresh)
    .catch(() => ({ ok: false, error: "cannot resolve this checkout's own repository" }));
  let pinnedRepo;
  let pinnedPromise = null;
  const pinRepo = async () => {
    if (pinnedRepo !== undefined) return pinnedRepo;
    if (pinnedPromise === null) {
      const pin = hintedIdentity !== null
        // The click already named the repository this panel opens: pin it as given.
        ? Promise.resolve({ ok: true, identity: hintedIdentity })
        : (initialIssue === null
          ? pinIdentity(true)
          : pinIdentity(false).then((cached) => (cached && cached.ok === true ? cached : pinIdentity(true))));
      pinnedPromise = pin.then((pinned) => {
        pinnedRepo = pinned;
        return pinned;
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
  // a git probe per gh call and every row is read from that one repository. S2
  // (issues-sidebar-click T1): the TUI helper load runs WITH the pin instead of
  // behind it — it is local work, and waiting for the identity first put it on
  // the path the human waits on.
  const helpersPromise = Promise.resolve()
    .then(() => issuesTuiLoader())
    .catch(() => null);
  const [helpers] = await Promise.all([helpersPromise, pinRepo()]);
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
    // authority, so a refused save is reported, never assumed. S21 (T17): the
    // write's own answer says whether it touched the VIEWER's assignment, and
    // that is the one case where the rail's cache entry for this repository is
    // no longer true — so only that case invalidates it.
    editAssignees: (number, { add, remove }) => issuesWrapFailure((async () => {
      const gate = await scopeDrift();
      if (gate.ok !== true) return gate;
      const result = await gh.editAssignees(number, { add, remove }, { cwd: checkoutRoot, scope: gate.scope });
      if (result && result.ok === true && result.self === true) {
        invalidateIssuesSidebarAssignment(gate.scope);
      }
      return result;
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
  // S8 (T4): the identity the panel just proved is the ONLY key that may seed
  // the first frame. Read ONCE, here, so every page of this mount comes from the
  // same entry; a cache entry for another repository (or no entry at all) seeds
  // nothing and this open is exactly the one this command always performed.
  const seededPages = pinnedRepo && pinnedRepo.ok === true
    ? issuesSidebarCachedPages(pinnedRepo.identity)
    : null;
  // S9 (T10): the bucket the numbered open starts on, chosen from the cache the
  // rail filled; a cold cache leaves the view's own fallback to decide.
  const initialBucket = initialIssue === null ? null : issuesSidebarInitialBucket(pinnedRepo, initialIssue);
  // S1 (issues-sidebar-click T1): the open is over the moment the panel mounts, so
  // the rail's clicks take effect again from the next frame on.
  releaseOpen();
  try {
    await ctx.ui.custom(
      (hostTui, theme, _keybindings, done) => {
        hostTuiRef = hostTui;
        return libRequire("issues-view.js").createIssuesView({
          // Bucket metadata only: the rows arrive page by page through
          // `loadIssuePage`, so no accumulated list is handed over. The three
          // scoped tabs are prefetched once at open, so none sits at a false
          // zero; `All` is marked lazy there, so the prefetch skips it and it is
          // read the first time the reader's shortcut key enters it (S1/S2).
          //
          // S8 (T4): a page the RAIL's cache answered is seeded instead, so the
          // first frame paints those rows. The seed is never the last word: the
          // mount always reads the visible bucket, every other seeded page
          // carries no `loaded` stamp, so the first activation reads it, and `r`
          // re-reads the bucket on screen — every seeded row is replaced by a
          // real answer.
          pages: ISSUES_INTERACTIVE_BUCKETS.map((spec) => {
            const seeded = seededPages === null ? null : seededPages.get(spec.id);
            if (seeded === null || seeded === undefined) {
              return { id: spec.id, label: spec.label, issues: null, lazy: spec.lazy === true };
            }
            return {
              id: spec.id,
              label: spec.label,
              issues: seeded.issues,
              lazy: spec.lazy === true,
              total: seeded.total,
              truncated: seeded.truncated,
            };
          }),
          loadIssuePage,
          // S7/S9: a numbered open starts on the bucket the cache says holds
          // the number (`assigned` when it is there, `mine` when it is only
          // there, `assigned` when the cache is cold) with that issue selected;
          // the command already refused anything that is not a positive
          // integer. A plain open passes neither option, so its mount is exactly
          // the previous one.
          ...(initialIssue === null ? {} : { initialBucket, initialIssue }),
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

// S13 (issues-startup-performance T11, corrected): without the `gh` CLI the two
// issues surfaces are NEVER REGISTERED — "/issues nunca se carga ni nunca se agrega
// a sidebar github sidebar, pues no serian funcionales". So there is no dim line, no
// startup notice and no refusal line for that host: with nothing registered there
// is nothing to draw, announce or refuse. The decision is REGISTRATION-TIME and
// LOCAL — one PATH walk through `lib/which-command.js`, never a child process and
// never a `gh` invocation "to see whether gh exists" — and it covers exactly two
// registrations: the `/issues` command and the `GITHUB` rail section.
//
// Every other surface keeps working without `gh` — `/warp`, `/odd`, `/files`,
// the tools, the cards, the bash design, the prompt append and CodeGraph — because
// "no desactiva todo el plugin, eso dije". The only plugin-wide switch in this
// package is the missing `gentle-shell-bridge` (S18).
//
// The guards below stay as DEFENCE IN DEPTH, not as the policy: a `gh` that
// disappears after the extension loaded still fails the gate and the rail's read
// closed, with no child and no network call.
const ISSUES_GH_CLI_MISSING = "the gh CLI is not installed or not on PATH";
// The rail's read-time line for the one case registration cannot cover: `gh` was
// on PATH when this extension loaded and is gone now. It is a dim settled state
// with no child behind it, exactly like its `not a git repository` sibling.
const ISSUES_GH_CLI_MISSING_RAIL = "gh CLI not installed";

// True only when the local probe can PROVE the CLI is absent. A host whose probe
// cannot answer at all is not a missing CLI: failing the surfaces off on an
// internal error would hide the reader for a working install.
function issuesGhCliMissing() {
  try {
    const gh = libRequire("gh-issues.js");
    if (!gh || typeof gh.ghCliPresent !== "function") return false;
    return gh.ghCliPresent({ env: process.env }) === false;
  } catch {
    return false;
  }
}

// The REGISTRATION-time answer, taken once per load. This one is the POLICY: it
// decides whether the two issues surfaces exist at all, so it is asked where they
// register and never again — a chrome-less host keeps no surface and no probe, and
// `/reload` rebuilds this module, so a fresh install is noticed on the next load
// and not before. The live `issuesGhCliMissing()` above stays the RUNTIME question,
// asked by the gate and by the rail's read, so a `gh` that vanishes mid-session
// still fails closed with no child.
const ISSUES_GH_CLI_ABSENT = issuesGhCliMissing();

// The probe alone: `gh api user` (and, through the client, `gh repo view`), which is
// ~1.1 s of network plus the checkout's git probes. It reads and writes no module
// state and no UI, so the background startup task and a typed command can share it,
// and the client's own in-flight cache turns the second caller into a waiter on the
// FIRST probe instead of a second pair of children. Never rejects: a missing or
// broken `gh` is a verdict, not a crash.
//
// S1/S3 (issues-startup-performance T1, T2): and it is STARTUP WORK, never an
// awaited step of `session_start`: the host awaits every handler it is handed, so
// awaiting this probe put `gh api user` (≈485 ms) and `gh repo view` (≈550 ms) —
// serially — in front of the first prompt of every session start AND every session
// switch. `/issues` takes the same verdict when it opens (`probeIssuesGate`), so
// nothing is lost by answering it in the background.
//
// T2: repository-ness comes FIRST, through the same local checkout seam every
// other surface uses, so a session outside a repository costs one `git rev-parse`
// and no `gh` child at all — and says nothing, because that is a state, not an
// error. A late verdict is dropped by the generation `dispatchIssuesGate` captures:
// it sets no state and notifies no dead UI, and `issuesGateNotified` stays clear so
// the next session's gate can still speak.
async function probeIssuesGateStatus(ctx) {
  try {
    const gh = libRequire("gh-issues.js");
    // S13 (T11) defence in depth: with `gh` absent nothing was registered, so this
    // path is a `gh` that vanished after load. It costs no child either way, and
    // the gate then fails like any other `gh` failure.
    if (issuesGhCliMissing()) {
      return { ok: false, error: ISSUES_GH_CLI_MISSING };
    }
    const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    let checkoutRoot = null;
    try {
      checkoutRoot = await oddCheckoutRootAsync(cwd);
    } catch {
      checkoutRoot = null;
    }
    if (!checkoutRoot) {
      return { ok: false, notRepository: true, error: ISSUES_SIDEBAR_NOT_REPOSITORY };
    }
    // S3 (T2): the gate asks gh ONE thing — is it usable this session (installed,
    // authenticated, and able to answer)? `scope: null` keeps the checkout's own
    // repository OUT of it: a checkout whose remote is not a GitHub repository is
    // the READ's question, and the panel answers it with its own honest error
    // instead of being refused before it can even open. Through the client's cache
    // the gate shares one probe with a typed `/issues`, so the second caller waits
    // on the first promise instead of spawning a second pair of children.
    const res = await gh.cachedGhStatus({ cwd: checkoutRoot, scope: null });
    const ok = !!(res && res.ok === true);
    if (ok) return { ok: true, checkoutRoot };
    return { ok: false, error: (res && res.error) || "gh check failed", checkoutRoot };
  } catch (err) {
    // The gate must never break startup.
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Apply a resolved verdict to the session that asked for it: the open state, and the
// ONE startup notice a failing gate hands the human. Split from the probe so the
// caller can drop a verdict whose session was superseded before it landed, and so a
// command that dispatches on its own (`/reload` fires no `session_start`) keeps its
// own, fuller refusal as the only thing it says.
function applyIssuesGateStatus(gate, ctx, notifyStartup = true) {
  issuesGateOpen = !!(gate && gate.ok === true);
  if (issuesGateOpen) return { ok: true, checkoutRoot: gate && gate.checkoutRoot };
  const error = (gate && gate.error) || "gh check failed";
  // S3 (T2): a cwd outside a repository speaks for itself — the surfaces draw the
  // state and there is nothing for the human to fix — so nothing is announced.
  // `gh`'s own wording (`gh auth login`, a killed probe) still is.
  const notRepository = !!(gate && gate.notRepository === true);
  if (notifyStartup && !issuesGateNotified && !notRepository && ctx && ctx.ui && typeof ctx.ui.notify === "function") {
    try {
      ctx.ui.notify(issuesGateMessage(error), "info");
      issuesGateNotified = true;
    } catch {
      // Notifying never breaks startup.
    }
  }
  return {
    ok: false,
    error,
    ...(notRepository ? { notRepository: true } : {}),
  };
}

// S5 (T8): dispatch the session's gate and return at once. The host awaits every
// handler it is handed, one at a time, so awaiting this probe is what delayed the
// first prompt on every open, resume and session switch; it now runs in the
// background and applies its verdict when it lands. A verdict that outlives its
// generation (another checkout, or a shutdown) is dropped whole, so it can neither
// notify a dead UI nor gate the session that replaced it.
function dispatchIssuesGate(ctx, notifyStartup = true) {
  const generation = issuesGateGeneration;
  const probe = probeIssuesGateStatus(ctx).then((gate) => {
    if (generation !== issuesGateGeneration) return gate;
    return applyIssuesGateStatus(gate, ctx, notifyStartup);
  });
  issuesGateProbe = { generation, run: probe };
  trackStartupTask(probe);
  return probe;
}

// The verdict this session already asked for, shared: the dispatched probe while it
// is the current generation's, and a fresh one when the session has none (`/reload`
// fires no `session_start`, and a superseded probe is never reused). A probe
// dispatched from here says nothing on its own: the caller reports its own refusal.
function sessionIssuesGate(ctx) {
  const dispatched = issuesGateProbe;
  if (dispatched !== null && dispatched.generation === issuesGateGeneration) return dispatched.run;
  return dispatchIssuesGate(ctx, false);
}

// The command stays discoverable even before the session gate resolves, so
// running it takes the verdict on demand. A session that already answered `ok` never
// re-probes; while its own probe is still in flight the command WAITS for that one
// promise rather than spawning a second pair of `gh` children, and a failure
// notifies the same honest fix every time it is asked.
//
// S3 (T2): the checkout comes FIRST, from THIS ctx — one local `git rev-parse` pair
// that the panel then reuses — so a cwd outside a repository is handed back as that
// state (the caller draws the shared line) instead of a `gh` error string. S13 (T11)
// defence in depth: a `gh` that disappeared after registration is refused here,
// before any child.
async function probeIssuesGate(ctx) {
  if (issuesGhCliMissing()) {
    return { ok: false, error: ISSUES_GH_CLI_MISSING };
  }
  const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  let checkoutRoot = null;
  try {
    checkoutRoot = await oddCheckoutRootAsync(cwd);
  } catch {
    checkoutRoot = null;
  }
  if (!checkoutRoot) return { ok: false, notRepository: true, error: ISSUES_SIDEBAR_NOT_REPOSITORY };
  if (issuesGateOpen === true) return { ok: true, checkoutRoot };
  let gate = await sessionIssuesGate(ctx);
  // S3 (T2): `notRepository` is a fact about the directory it was measured in, and
  // this ctx just resolved a checkout of its own. A command typed in a session that
  // started elsewhere asks its own question instead of inheriting a refusal about
  // another directory; the shared probe stays shared for every `gh` answer.
  if (gate && gate.notRepository === true) {
    gate = await dispatchIssuesGate(ctx, false);
  }
  if (gate && gate.ok === true) return { ok: true, checkoutRoot };
  return {
    ok: false,
    error: (gate && gate.error) || "gh check failed",
    ...(gate && gate.notRepository === true ? { notRepository: true } : {}),
  };
}

function registerIssuesCommand(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  // S13 (T11, corrected): without the `gh` CLI there is nothing this command could
  // do, so it is never registered — "/issues nunca se carga". The answer is the one
  // recorded at registration, with no child process, and every other command and
  // tool this package contributes is registered above and below regardless.
  if (ISSUES_GH_CLI_ABSENT) return;
  pi.registerCommand("issues", {
    description: "Browse fresh GitHub issue pages and details; edit labels/assignees, comment or close when permitted",
    handler: async (args, ctx) => {
      const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
      const gate = await probeIssuesGate(ctx);
      if (gate.ok !== true) {
        // S1 (issues-sidebar-click T1): the rail click whose command refuses here
        // is over, so the guard goes with it instead of waiting for its timer.
        releaseIssuesPanelOpen();
        // S3 (T2): a cwd outside a repository is the shared statement every
        // surface makes, at info — never a `gh` error and never an error tone.
        if (gate.notRepository === true) {
          if (typeof notify === "function") notify(notGitRepositoryLine(toolCwd(ctx)), "info");
          return;
        }
        if (typeof notify === "function") notify(issuesGateMessage(gate.error), "error");
        return;
      }
      await executeIssues(args, ctx, gate.checkoutRoot);
    },
  });
}

// S2 (issues-sidebar): the published bridge object, read from its Symbol slot
// after its own gate. Absent or malformed is `null` — never an import, never a
// dependency.
function issuesSidebarBridge() {
  try {
    const api = globalThis[ISSUES_SIDEBAR_BRIDGE_SLOT];
    if (!api || api.schema !== "gentle-shell-bridge/api" || api.version !== 1) return null;
    if (typeof api.registerRows !== "function") return null;
    if (typeof api.registerSection !== "function") return null;
    if (typeof api.createStore !== "function") return null;
    return api;
  } catch {
    return null;
  }
}

function issuesSidebarError(err, fallback) {
  if (err && typeof err.message === "string" && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return fallback;
}

// S9 (issues-sidebar T14): ONE cache per extension instance, built lazily so a
// host that never draws the rail never pays for it. A missing cache module is
// not fatal: the read then merges the response's own mine and assigned buckets
// instead of storing them.
function issuesSidebarRelatedCache() {
  if (issuesSidebarCache !== null) return issuesSidebarCache;
  try {
    const factory = libRequire("related-issues-cache.js");
    if (!factory || typeof factory.createIssuesCache !== "function") return null;
    // S4 (T3): the full-read TTL is named ONCE, so the in-memory cache and the
    // loader's hydration hold a stored entry to the same bound.
    issuesSidebarCache = factory.createIssuesCache({ fullTtlMs: ISSUES_CACHE_FULL_TTL_MS });
  } catch {
    issuesSidebarCache = null;
  }
  return issuesSidebarCache;
}

// S4 (T3): the DISK half of the same cache, built lazily exactly like it. A
// missing module is not fatal — the read is then the in-process one it always
// was — and nothing is created here: a host that never draws the rail never
// touches the file.
function issuesSidebarCacheStore() {
  if (issuesCacheStore !== null) return issuesCacheStore;
  try {
    const factory = libRequire("issues-cache-store.js");
    if (!factory || typeof factory.createIssuesCacheStore !== "function") return null;
    issuesCacheStore = factory.createIssuesCacheStore();
  } catch {
    issuesCacheStore = null;
  }
  return issuesCacheStore;
}

// S4 (T3): the read the loader replays into the cache for a stored entry. It is
// the SAME `{ ok, buckets: { <id>: { issueCount, issues } } }` shape a real answer
// has, so the cache's own `apply` re-applies every invariant it owns (the count
// per bucket, the truncation rule, the sort and the cap) instead of this file
// inventing a second way to write an entry.
function issuesSidebarHydratedRead(entry) {
  const buckets = {};
  const source = entry && entry.buckets && typeof entry.buckets === "object" ? entry.buckets : {};
  const counts = entry && entry.counts && typeof entry.counts === "object" ? entry.counts : {};
  for (const spec of ISSUES_PAGE_QUERIES) {
    const rows = Array.isArray(source[spec.id]) ? source[spec.id] : [];
    const count = Number.isInteger(counts[spec.id]) ? counts[spec.id] : rows.length;
    buckets[spec.id] = { issueCount: count, issues: rows };
  }
  return { ok: true, buckets };
}

// S4 (T3): hydrate ONE identity from the disk half, lazily, before `plan` — so a
// warm identity's first read in a new process is already a delta. It runs on the
// async loader alone: never at `session_start`, never on `lines()`/`meta()` and
// never on a paint path, and it answers `false` for every reason it could not
// (an identity already warm in memory, no store, no entry, a late session, an
// entry the cache's own rules would not trust, a hostile document).
async function hydrateIssuesSidebarCache(cache, identity, cacheGeneration) {
  if (cache === null || typeof identity !== "string" || identity.length === 0) return false;
  let warm = null;
  try {
    warm = cache.get(identity);
  } catch {
    warm = null;
  }
  if (warm !== null) return false;
  const store = issuesSidebarCacheStore();
  if (store === null) return false;
  let entry = null;
  try {
    entry = await store.load(identity);
  } catch {
    entry = null;
  }
  if (!entry) return false;
  // T15 (defect 4): a load that answered after its session ended fills nothing.
  if (cacheGeneration !== issuesSidebarCacheGeneration) return false;
  // S4 (T3): persistence never defeats the correctness rules the cache already
  // enforces — an entry whose rows no longer match the count its response reported,
  // or one past the full-read TTL, is one `plan` must answer a FULL read for, so it
  // is never hydrated at all.
  //
  // Nuance accepted here (S4/T3 correction): `cache.apply(..., { full: false })` on a
  // COLD cache takes the `!previous` branch, so it stamps `fullAt` at hydration time
  // — a hydrated entry restarts the full-read clock instead of inheriting the stored
  // one. That is safe: every later read is a delta, and a delta MERGES by issue
  // number and is held to the cache's count invariant, so the moment the cached rows
  // stop matching the `issueCount` its own answer reports the entry is
  // `inconsistent` and `plan` answers a FULL read. The stored `fullAt` still decides
  // WHETHER an entry is hydrated (the TTL check below), so a stale document is never
  // trusted; only the clock of a trusted one is renewed, by at most this
  // process's own lifetime.
  if (entry.inconsistent === true) return false;
  const age = Date.now() - entry.fullAt;
  if (!Number.isFinite(age) || age >= ISSUES_CACHE_FULL_TTL_MS) return false;
  try {
    cache.apply(identity, issuesSidebarHydratedRead(entry), { full: false });
  } catch {
    return false;
  }
  return true;
}

// S4 (T3): the snapshot one answer's `apply` left in the cache, in the shape the
// disk half stores. The rows and the cache's own facts come from the cache (so the
// file can never disagree with memory); the counts come from the response, which is
// the only place the authoritative total lives. Synchronous and side-effect free:
// the write it feeds is queued below.
function issuesSidebarCacheSnapshot(cache, identity, read, plan, sequence) {
  let entry = null;
  try {
    entry = cache.get(identity);
  } catch {
    return null;
  }
  if (!entry || !entry.buckets) return null;
  const readBuckets = read && read.buckets && typeof read.buckets === "object" ? read.buckets : {};
  const counts = {};
  for (const spec of ISSUES_PAGE_QUERIES) {
    const rows = Array.isArray(entry.buckets[spec.id]) ? entry.buckets[spec.id] : [];
    const bucket = readBuckets[spec.id];
    counts[spec.id] = bucket && Number.isInteger(bucket.issueCount) ? bucket.issueCount : rows.length;
  }
  return {
    buckets: entry.buckets,
    counts,
    truncated: entry.truncated,
    inconsistent: entry.inconsistent === true,
    full: plan.full === true,
    syncedAt: Number.isFinite(entry.syncedAt) ? entry.syncedAt : Date.now(),
    lastApplied: Number.isFinite(sequence) ? sequence : issuesSidebarReadSequence,
  };
}

// S4 (T3 correction): the disk half is FIRE AND FORGET, because the read must
// settle the moment `apply` made its answer visible in memory — the section's own
// `running` gate refuses to schedule while a read is in flight, so a read that
// waits for a file write postpones every later read and the rail paints late. Two
// rules keep that freedom safe:
//   - ONE write is in flight per process, so a second save can never interleave
//     its own read-modify-write over the one document;
//   - a save that arrives while one runs lands in a single PENDING slot that the
//     latest entry overwrites, so a stalled disk accumulates nothing and the next
//     finished write carries the newest state (coalescing costs at most one full
//     read later, never correctness).
// A save that never settles therefore defers nothing: the read has already
// returned, the pending slot keeps the newest entry, and no rejection can escape —
// the tracked promise swallows both outcomes.
let issuesCacheWriteInFlight = null;
let issuesCacheWritePending = null;

function drainIssuesSidebarCacheWrites() {
  if (issuesCacheWriteInFlight !== null || issuesCacheWritePending === null) return;
  const job = issuesCacheWritePending;
  issuesCacheWritePending = null;
  let run;
  try {
    run = Promise.resolve(job.store.save(job.identity, job.snapshot));
  } catch {
    run = Promise.resolve(false);
  }
  const settled = run.then(() => undefined, () => undefined);
  issuesCacheWriteInFlight = settled;
  settled.then(() => {
    if (issuesCacheWriteInFlight === settled) issuesCacheWriteInFlight = null;
    drainIssuesSidebarCacheWrites();
  });
}

function queueIssuesSidebarCacheWrite(cache, identity, read, plan, sequence) {
  const store = issuesSidebarCacheStore();
  if (store === null) return false;
  const snapshot = issuesSidebarCacheSnapshot(cache, identity, read, plan, sequence);
  if (snapshot === null) return false;
  issuesCacheWritePending = { store, identity, snapshot };
  drainIssuesSidebarCacheWrites();
  return true;
}

// S4 (T3, L7): a session boundary no longer throws the cache away — the entries
// are the whole point of it, and the next session's first read is a delta because
// they are still there. What a boundary DOES still do is move the generation on,
// so an answer the ended session is still holding can never land in the cache the
// next session reads; the section's snapshot is dropped by `invalidateIssuesSidebar`
// beside it, so no frame drawn afterwards shows the ended session's rows.
function clearIssuesSidebarCache() {
  // The bump comes FIRST, so a read still holding the previous generation can
  // never write an entry this boundary has already moved past.
  issuesSidebarCacheGeneration += 1;
}

// S5 (T8): the client's cached gate answers (`gh-issues.js`) belong to the session
// that paid for them; a session that ends clears them so the next one starts from
// its own probe. Best effort: a missing seam or a failed clear never breaks the end
// of a session.
function clearIssuesGateCache() {
  try {
    const gh = libRequire("gh-issues.js");
    if (gh && typeof gh.clearCachedGhStatus === "function") gh.clearCachedGhStatus();
  } catch {
    // The cache is optional: a failed clear never breaks the end of a session.
  }
}

// S9 consumer half (issues-sidebar) / S8 (issues panel, T4): the panel READS the
// rail's cache so its first frame paints rows instead of waiting for `gh`. It is
// a READER only — the rail owns that entry (its one combined read, its merge, its
// count invariant and its invalidation) — and nothing here clears, shrinks or
// rewrites it.
//
// The key is the identity the panel just PROVED for this checkout, so an entry
// belonging to another repository is never used: no path may serve one
// repository's rows under another's name. No entry means `null`, which is what
// leaves every page exactly as it was before this cache existed (the mount reads
// the three scoped buckets as it always did). `get` answers deep-enough copies,
// so nothing the view does can reach the cached rows.
//
// A bucket the cache reported TRUNCATED (its `issueCount` exceeded what it can
// hold) cannot report an exact total: it is seeded with `truncated: true`, so the
// view paints `N+` and never claims a count it does not have. E17b: the SAME
// holds for an entry the cache calls INCONSISTENT — its cached rows no longer
// match the `issueCount` the response reported (which is why the rail's next sync
// is a full re-read), so a total derived from those rows is exactly the number
// the rail itself refuses to trust.
function issuesSidebarCachedPages(identity) {
  if (issuesSidebarCache === null) return null;
  if (typeof identity !== "string" || identity.length === 0) return null;
  let cached = null;
  try {
    cached = issuesSidebarCache.get(identity);
  } catch {
    cached = null;
  }
  if (!cached || !cached.buckets || typeof cached.buckets !== "object") return null;
  const inexact = cached.inconsistent === true;
  const pages = new Map();
  for (const spec of ISSUES_PAGE_QUERIES) {
    const rows = cached.buckets[spec.id];
    if (!Array.isArray(rows)) continue;
    const truncated = inexact || !!(cached.truncated && cached.truncated[spec.id] === true);
    pages.set(spec.id, { issues: rows, total: rows.length, truncated });
  }
  return pages.size === 0 ? null : pages;
}

// S7 (T8): the rail's rows are the UNION of the two buckets the user named — the
// issues they authored (`mine`) and the ones they are assigned (`assigned`) —
// merged and deduplicated by issue number, with the `assigned` row winning a
// collision (it is the bucket the row's click opens). Each row keeps the bucket
// it came from, so the section can hand it to the opener. `involved` is not part
// of the merge.
//
// The merge never invents a row: a malformed entry with no usable number cannot
// be deduplicated, so it is dropped exactly like the cache drops it.
function mergeRailIssues(buckets) {
  const byNumber = new Map();
  const source = buckets && typeof buckets === 'object' ? buckets : {};
  for (const key of ["mine", "assigned"]) {
    const rows = Array.isArray(source[key]) ? source[key] : [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || !Number.isInteger(row.number) || row.number <= 0) continue;
      if (byNumber.has(row.number) && key !== "assigned") continue;
      byNumber.set(row.number, { ...row, bucket: key });
    }
  }
  return [...byNumber.values()];
}

// S9 (T10) part 3: the bucket a numbered open starts on. The rail's cache already
// knows where the number is: `assigned` when it holds it there, `mine` when it
// holds it ONLY there (the user's own priority — "assigned tiene prioridad"),
// and `assigned` when the cache is cold or unknown, which leaves the view to try
// the other bucket of the pair before it reports the number absent. A cache read
// that throws answers nothing, exactly like no cache: the panel still opens.
function issuesSidebarInitialBucket(pinned, number) {
  if (issuesSidebarCache === null) return "assigned";
  if (!pinned || pinned.ok !== true || typeof pinned.identity !== "string") return "assigned";
  let entry = null;
  try {
    entry = issuesSidebarCache.get(pinned.identity);
  } catch {
    entry = null;
  }
  const has = (key) => {
    const rows = entry && entry.buckets && Array.isArray(entry.buckets[key]) ? entry.buckets[key] : [];
    return rows.some((row) => row && row.number === number);
  };
  if (has("assigned")) return "assigned";
  if (has("mine")) return "mine";
  return "assigned";
}

// S1/S6/S7 + S9: ONE read — a single `gh api graphql` request with the three
// scoped views (`mine`, `assigned`, `involved`) — for the checkout the session
// runs in. `/issues` keeps its own four tabs and the rail DRAWS the merged mine +
// assigned list (S7/T8); the same read fills the process cache, so a later
// consumer can open instantly. The identity is resolved FIRST — through the SAME
// composition `/issues` proves a browser open with, so a single-remote checkout
// has one too — and the read is bound to it; a resolution failure returns the S5
// error and makes no `gh` call at all. The cache decides the size: 100 per bucket
// with no (or an aged, or an inconsistent) entry, the newest 20 afterwards,
// merged by issue number. A failed read never touches the cache and returns the
// S5 error, so the section's T10 stale handling keeps working unchanged.
// `truncated` is true when EITHER contributing bucket's `issueCount` exceeded the
// cache cap, so the real total is larger than the merged rows and the overflow
// row says so.
//
// T15 (S6/S9): the read is numbered and generation-stamped BEFORE its first
// await, so its place in the order is the START, not the answer. A read with no
// bound session context reads nothing at all, and one whose generation moved on
// (shutdown, rebinding) never writes the cache — though it still returns the
// rows it read, for the section's own token to accept or discard.
async function loadIssuesSidebar() {
  const sequence = (issuesSidebarReadSequence += 1);
  const cacheGeneration = issuesSidebarCacheGeneration;
  // S13 (T11) defence in depth: a host without the CLI never mounts this section,
  // so reaching this line means `gh` was on PATH at registration and is gone now.
  // Nothing to read, then — no `gh` child, no cache hydrate, not even the git
  // checkout probe (so this settled state costs zero children, which is what the
  // rail's own test measures). The line is the short dim one, exactly like the
  // non-repository state below, so the section's `stateSettled` keeps NO timer and
  // no later frame retries it.
  if (issuesGhCliMissing()) {
    return { ok: false, error: ISSUES_GH_CLI_MISSING_RAIL, errorTone: "dim" };
  }
  if (issuesSidebarCtx === null) {
    return { ok: false, error: "cannot read issues: the session has ended" };
  }
  const cwd = toolCwd(issuesSidebarCtx);
  let gh;
  try {
    gh = libRequire("gh-issues.js");
  } catch (err) {
    return { ok: false, error: `issues: cannot load the gh client: ${issuesSidebarError(err, "unknown error")}` };
  }
  const checkoutRoot = await oddCheckoutRootAsync(cwd);
  // S12 (T11): a cwd outside a repository is not a failure of the read — there is
  // simply nothing to read. The rail's own line is the short one, in the gray
  // tone, and names no path; `/warp` and `/issues` keep their fuller sentence.
  if (!checkoutRoot) return { ok: false, error: ISSUES_SIDEBAR_NOT_REPOSITORY, errorTone: "dim" };
  let resolved = null;
  try {
    resolved = await issuesBrowserRepoIdentity(gh, checkoutRoot);
  } catch (err) {
    resolved = { ok: false, error: issuesSidebarError(err, "cannot resolve this checkout's own repository") };
  }
  if (!resolved || resolved.ok !== true) {
    return { ok: false, error: (resolved && resolved.error) || "cannot resolve this checkout's own repository" };
  }
  const identity = resolved.identity;
  const cache = issuesSidebarRelatedCache();
  // S21 (T17): a panel write marked this identity, which means its entry was
  // dropped on purpose and the disk half must not hand the stale one back: the
  // write invalidated the buckets, so the next read of them is the full one.
  const mustReadFull = issuesSidebarFullReadIdentities.has(identity);
  if (mustReadFull && cache !== null && typeof cache.drop === "function") {
    try {
      cache.drop(identity);
    } catch {
      // The mark alone still refuses the hydration below.
    }
  }
  // S4 (T3): hydrate the identity from the disk half BEFORE `plan`, so a warm
  // identity's first read in a new process is already a delta. Lazy by identity,
  // best effort, and only ever here. S21: never for an identity a write just
  // invalidated — that read exists to replace what the removed entry said.
  if (!mustReadFull) await hydrateIssuesSidebarCache(cache, identity, cacheGeneration);
  const plan = cache !== null ? cache.plan(identity) : { full: true, first: 20 };
  let read;
  try {
    read = await gh.listRelatedIssues({ first: plan.first }, { cwd: checkoutRoot, scope: identity });
  } catch (err) {
    return { ok: false, error: issuesSidebarError(err, "GitHub query failed") };
  }
  if (!read || read.ok !== true) {
    return { ok: false, error: (read && read.error) || "GitHub query failed" };
  }
  // T15 (defects 4 and 5): only an answer from the current generation, and only
  // one the cache has not already superseded, may write. The rows are returned
  // either way.
  const canWriteCache = cache !== null && issuesSidebarCacheGeneration === cacheGeneration;
  if (canWriteCache) {
    try {
      cache.apply(identity, read, { full: plan.full === true, sequence });
    } catch {
      // A cache that refuses the answer is no reason to lose the read itself.
    }
    // S21 (T17): the full read a write asked for has landed, so the buckets the
    // old entry held are replaced and the mark has done its job.
    if (plan.full === true) issuesSidebarFullReadIdentities.delete(identity);
    // S4 (T3): and only after a successful apply is the entry offered to the disk
    // half, so the file never holds rows memory refused — and only by a read that
    // is still the newest one STARTED, so an older answer can never overwrite the
    // file a newer read just wrote. It is QUEUED, never awaited: the answer is
    // already visible, and a slow disk must not hold the rail's next read.
    if (issuesSidebarReadSequence === sequence) {
      queueIssuesSidebarCacheWrite(cache, identity, read, plan, sequence);
    }
  }
  const cached = canWriteCache ? cache.get(identity) : null;
  const readBuckets = read.buckets && typeof read.buckets === "object" ? read.buckets : null;
  const issues = cached !== null && cached.buckets
    ? mergeRailIssues(cached.buckets)
    : mergeRailIssues({
      mine: readBuckets && readBuckets.mine ? readBuckets.mine.issues : [],
      assigned: readBuckets && readBuckets.assigned ? readBuckets.assigned.issues : [],
    });
  // A bucket whose `issueCount` outruns the rows the same answer carried is
  // truncated: the merged list cannot be the whole result.
  const readTruncated = (key) => {
    const bucket = readBuckets ? readBuckets[key] : null;
    if (!bucket || !Array.isArray(bucket.issues)) return false;
    return Number.isInteger(bucket.issueCount) && bucket.issueCount > bucket.issues.length;
  };
  const truncated = cached !== null && cached.truncated
    ? (cached.truncated.mine === true || cached.truncated.assigned === true)
    : (readTruncated("mine") || readTruncated("assigned"));
  return {
    ok: true,
    identity,
    issues,
    truncated,
    // S2 (issues-sidebar-click T1, correction): the generation this read was taken
    // under, so the section can carry it with the row and the click that opens it
    // can tell a live session's row from one the host retained across a boundary.
    generation: cacheGeneration,
  };
}

// S4 (issues-sidebar, L11/T12): a row click opens the PANEL on that issue
// instead of the browser. It reaches it through the SAME host route the overflow
// row uses — `pi.sendUserMessage("/issues <n>", { expandPromptTemplates: true })`.
//
// S9 (T10) removed the click's second identity proof. The panel PINS and PROVES
// the repository itself when it opens (invariant 6, `executeIssues`'s own pin and
// scope-drift gate), and the section's contract says so; the pre-dispatch proof
// awaited git (and, on a single-remote checkout, `gh`) before dispatching, so a
// click could be refused — or simply take a visible beat — for a repository the
// panel was about to prove anyway, and every refusal landed in a snapshot field
// nothing draws. The click is now synchronous: no awaited read, no generation
// check, no identity comparison. The number alone travels, and the panel decides.
//
// What the click still refuses is a host that truly cannot dispatch: no
// `sendUserMessage`, or one that throws. That refusal is made VISIBLE (S9) —
// one transcript entry through the host's `appendEntry` seam when it has one,
// else the notice seam, and never only the silent snapshot field. The
// `{ ok, error }` this returns is what the section records for its own readers.
//
// The row's bucket (S7/T8) may ride along as a third argument, but this seam does
// not dispatch it: the `/issues <n>` command picks the bucket from the cache when
// it runs, so the panel does not depend on a row the human clicked seconds ago.
// The row's identity rides along for the same reason the number does — it is what
// the section proved for THAT row — and is left as a one-shot hint for the open
// this dispatch starts (S2 above).
// `pi.sendUserMessage` returns void by contract, so this reports that the command
// was dispatched, never that a panel opened. Never throws.
const ISSUES_SIDEBAR_NOT_REPOSITORY = "not a git repository";
const ISSUES_PANEL_REFUSAL_ENTRY = "odd-worktree-issues-refusal";
const ISSUES_PANEL_DISPATCH_FAILED = "the host cannot dispatch the /issues command here";

// S9 (T10): one refusal, one visible surface. The host's own transcript entry is
// first (it survives the frame and needs no permission); the notice seam is the
// fallback a host that exposes one gets. Neither exists → the message lives only
// in the returned `{ ok: false }`, which the section still records.
function announceIssuesPanelRefusal(pi, message) {
  if (pi && typeof pi.appendEntry === "function") {
    try {
      pi.appendEntry(ISSUES_PANEL_REFUSAL_ENTRY, { line: message });
      return true;
    } catch {
      // A host that refuses the entry gets the notice seam below.
    }
  }
  const notify = issuesSidebarCtx && issuesSidebarCtx.ui ? issuesSidebarCtx.ui.notify : undefined;
  if (typeof notify === "function") {
    try {
      notify(message, "warning");
      return true;
    } catch {
      // Nothing left to tell; the caller still gets the refusal.
    }
  }
  return false;
}

// S2 (issues-sidebar-click T1, second half): the identity a rail click may leave as
// the one-shot hint for the open it dispatches. It is normalized with the SAME
// function every pinned read uses (`GH_REPO` in `issuesBrowserRepoIdentity`, a
// caller's `scope` in `scopeForCall`), so the hint is exactly the `<host>/<owner>/<repo>
// the read also keys the rail cache with. A value that does not normalize is no
// identity at all: no hint is recorded and the open takes the cached-scope pin.
function issuesPanelOpenHintIdentity(identity) {
  if (typeof identity !== "string" || identity.trim() === "") return null;
  let gh;
  try {
    gh = libRequire("gh-issues.js");
  } catch {
    return null;
  }
  if (!gh || typeof gh.normalizeScopeIdentity !== "function") return null;
  let normalized;
  try {
    normalized = gh.normalizeScopeIdentity(identity, process.env);
  } catch {
    return null;
  }
  if (!normalized || normalized.ok !== true) return null;
  if (typeof normalized.identity !== "string" || normalized.identity.length === 0) return null;
  return normalized.identity;
}

// Test seam only: the cache/click generation a rail row's read is stamped with.
// A test that models a click the extension cannot construct on its own (one that
// carries a malformed identity) needs the CURRENT generation, and production code
// never reads this — the extension is the one place that owns the clock.
function issuesSidebarGeneration() {
  return issuesSidebarCacheGeneration;
}

function dispatchIssuesPanel(pi, number, identity, _bucket, generation) {
  // S1 (issues-sidebar-click T1): a click while a rail open is in flight has no
  // effect at all — not even a visible refusal — so it returns normally and
  // claims nothing.
  if (issuesPanelOpenBlocked()) return { ok: true };
  const token = { generation: issuesSidebarCacheGeneration };
  issuesPanelOpenToken = token;
  const asked = Number(number);
  const namesIssue = Number.isInteger(asked) && asked > 0;
  // S2 (issues-sidebar-click T1, second half): a click that names an issue AND
  // carries the identity its row was read from leaves both as the one-shot hint the
  // open it dispatches consumes. The dispatch still sends the number alone and stays
  // synchronous; the guard's release clears the hint with the token.
  //
  // Two facts decide whether that identity may still be trusted, and both belong to
  // the row, not to the click:
  // - the GENERATION its read was taken under. `session_start`, `session_shutdown`
  //   and a bridge rebinding move the generation on without invalidating the row
  //   callbacks the host already holds, so a deferred click can land after the
  //   session that read its row has ended. It still dispatches `/<issues> N`, but it
  //   must leave no hint: the repository it names belongs to the session that ended,
  //   and the open's own cached-scope pin is what the next session proved.
  // - the identity itself, normalized (see `issuesPanelOpenHintIdentity`).
  const rowGeneration = Number.isFinite(generation) ? generation : null;
  const hintIdentity = namesIssue && rowGeneration !== null && rowGeneration === token.generation
    ? issuesPanelOpenHintIdentity(identity)
    : null;
  issuesPanelOpenHint = hintIdentity === null
    ? null
    : { number: asked, identity: hintIdentity, generation: token.generation };
  armIssuesPanelOpenGuard(token);
  const command = namesIssue ? `/issues ${asked}` : "/issues";
  if (!pi || typeof pi.sendUserMessage !== "function") {
    // The host cannot dispatch, so nothing will run to release the guard.
    releaseIssuesPanelOpen(token);
    announceIssuesPanelRefusal(pi, ISSUES_PANEL_DISPATCH_FAILED);
    return { ok: false, error: ISSUES_PANEL_DISPATCH_FAILED };
  }
  try {
    pi.sendUserMessage(command, { expandPromptTemplates: true });
  } catch (err) {
    // A dispatch that threw reaches no command either.
    releaseIssuesPanelOpen(token);
    const message = `the /issues command could not be dispatched: ${issuesSidebarError(err, "unknown error")}`;
    announceIssuesPanelRefusal(pi, message);
    return { ok: false, error: message };
  }
  return { ok: true };
}

// S9 (T10): the refusal entry is one plain dim line, exactly like the warp
// queue's durable fallback, so a host that can append entries paints it as text
// instead of an unknown custom shape. A host without the renderer seam simply
// never shows the fallback.
function registerIssuesRefusalEntryRenderer(pi) {
  if (typeof pi?.registerEntryRenderer !== "function") return;
  try {
    pi.registerEntryRenderer(ISSUES_PANEL_REFUSAL_ENTRY, (entry, _options, theme) => {
      const line = entry && entry.data && typeof entry.data.line === "string" ? entry.data.line : "";
      return warpSteeringWidget(line)(null, theme);
    });
  } catch {
    // Presentation only: a host that cannot register it still keeps the entry.
  }
}

// T18 (S11): end ONE binding — the bridge's own unregister first, then the
// section's `dispose()`, each guarded on its own so a teardown that throws still
// leaves the caller free to register the replacement. The slots are cleared
// BEFORE either call, so a re-entrant teardown cannot run twice and nothing keeps
// pointing at a section this module no longer owns. It is what a replacement (a
// republished bridge, a second mount) and `session_shutdown` both perform: without
// it the abandoned section keeps its self-scheduled floor timer alive for the
// rest of its drawn window and keeps reading the same `gh` traffic this feature
// exists to remove.
function teardownIssuesSidebar() {
  const disposer = issuesSidebarDisposer;
  const handle = issuesSidebarHandle;
  issuesSidebarDisposer = null;
  issuesSidebarHandle = null;
  if (disposer !== null) {
    try {
      disposer();
    } catch {
      // A bridge that refuses the unregister still gets its section disposed.
    }
  }
  if (handle !== null && typeof handle.dispose === "function") {
    try {
      handle.dispose();
    } catch {
      // A section that refuses `dispose()` never blocks the replacement.
    }
  }
}

// S3 (issues-sidebar): the repaint the bridge offers is the only thing the
// refresh reports; a host that paints by other means gets nothing extra.
function mountIssuesSidebar(pi, api) {
  let factory;
  try {
    factory = libRequire("issues-section.js");
  } catch {
    return;
  }
  if (!factory || typeof factory.createIssuesSection !== "function") return;
  // T18 (S11): a mount REPLACES the binding, so the previous one is torn down
  // before a new section exists (`/reload`, a republished bridge, a second
  // mount). Tearing down only once the factory is known to exist keeps a broken
  // module from costing the rail that was working.
  teardownIssuesSidebar();
  // T15 (S9, defect 4): binding the section to the bridge is a rebinding of this
  // cache wiring, like `/reload`; an answer a previous binding still holds must
  // not land in the new section's cache. S1 (issues-sidebar-click T1): a rebinding
  // also ends any rail open the previous binding dispatched, so it releases the
  // single-flight guard instead of leaving it to its timer.
  issuesSidebarCacheGeneration += 1;
  releaseIssuesPanelOpen();
  const onRefreshed = typeof api.requestRepaint === "function"
    ? () => {
      try {
        api.requestRepaint();
      } catch {
        // A repaint failure never breaks the section.
      }
    }
    : undefined;
  let handle;
  try {
    handle = factory.createIssuesSection({
      load: () => loadIssuesSidebar(),
      // S10 (T8, L9): the rail re-reads on TIME, not on the session's activity.
      // The section owns the timer (armed by a draw, unref'd, cleared by
      // `invalidate()`/`dispose()`) and stops it once the section leaves the
      // drawn window below, so a hidden section keeps no timer (S11).
      refreshFloorMs: ISSUES_SIDEBAR_TIME_FLOOR_MS,
      timerDrawnWindowMs: ISSUES_SIDEBAR_DRAWN_WINDOW_MS,
      // T12/T17/S9: a row click and the overflow row dispatch the panel command.
      // The row's number and the bucket it came from ride the seam; the panel
      // proves the repository itself when it opens, so no proof runs on the click
      // path (`dispatchIssuesPanel` is synchronous). `openIssuesSidebarIssue` (the
      // browser opener this seam used to run) is gone with its only caller —
      // `issuesOpenInBrowser` survives for `/issues`' own `o` key.
      open: (number, identity, bucket, generation) => dispatchIssuesPanel(pi, number, identity, bucket, generation),
      openAll: () => dispatchIssuesPanel(pi),
      onRefreshed,
    });
  } catch {
    return;
  }
  if (!handle || !handle.section) return;
  let disposer;
  try {
    disposer = api.registerSection(handle.section);
  } catch {
    return;
  }
  issuesSidebarHandle = handle;
  issuesSidebarDisposer = typeof disposer === "function" ? disposer : null;
  issuesSidebarApi = api;
}

// The bridge announces its publication on ONE event, and this package answers it
// with ONE subscription — a second `events.on` for the same announcement would be
// a second surface listening to one fact. Every surface the bridge contributes
// (the issues rail and the bash design) registers its retry here, and the one
// announcement runs them all.
const bridgeReadyRetries = [];
let bridgeReadySubscribed = false;

function subscribeBridgeReady(pi, retry) {
  try {
    if (typeof retry !== "function") return false;
    const events = pi && pi.events ? pi.events : null;
    if (!events || typeof events.on !== "function") return false;
    bridgeReadyRetries.push(retry);
    if (bridgeReadySubscribed) return true;
    bridgeReadySubscribed = true;
    try {
      events.on(ISSUES_SIDEBAR_READY_EVENT, () => {
        for (const run of bridgeReadyRetries.slice()) {
          try {
            run();
          } catch {
            // One surface's retry never breaks another's.
          }
        }
      });
    } catch {
      bridgeReadySubscribed = false;
      bridgeReadyRetries.pop();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// The bash activity design reaches the host ONLY through gentle-shell-bridge's
// published object (`registerToolDesign`), never an import. The bridge owns the
// renderer resolver, the `bash` customize line, its persistence and the repaint of
// cards already on screen, so nothing here depends on extension load order.
// Without a bridge (or one older than the API) nothing is registered.
function registerBashDesignRows(api) {
  try {
    const design = libRequire("bash-design.js");
    if (!design || typeof design.registerBashDesign !== "function") return;
    design.registerBashDesign(api);
  } catch {
    // The design is cosmetic; the host keeps drawing its own bash cards.
  }
}

// S2 (issues-sidebar): the section reaches the rail ONLY through the bridge's
// published object. A host without it is subscribed to the ready announcement
// ONCE and nothing else happens: no notify, no throw, no other surface touched.
// The bash design takes the same two paths, so one subscription carries every
// bridge surface this package contributes.
function registerIssuesSidebar(pi) {
  try {
    const api = issuesSidebarBridge();
    if (api !== null) {
      // T18 (S11): the SAME published object is the same bridge, so a second
      // moment (a `session_start` after a `session_shutdown` disposed the
      // section) binds the rail again only when it has no section; otherwise it
      // contributes nothing twice. A DIFFERENT object is a republished bridge:
      // its surfaces are registered on it and the previous binding is replaced,
      // with `mountIssuesSidebar` tearing the old section down first.
      if (api !== issuesSidebarApi) {
        registerBashDesignRows(api);
        issuesSidebarApi = api;
      } else if (issuesSidebarHandle !== null) {
        return;
      }
      // S13 (T11, corrected): without the `gh` CLI this section is NEVER ADDED to
      // the rail — "nunca se agrega a sidebar github sidebar" — and there is no
      // line, notice or refusal to draw for it, because nothing was registered.
      // Only the GITHUB section is withheld: the bash design above, the picker's
      // `alt+p` shortcut and every other surface still register.
      if (!ISSUES_GH_CLI_ABSENT) mountIssuesSidebar(pi, api);
      return;
    }
    if (issuesSidebarSubscribed) return;
    const subscribed = subscribeBridgeReady(pi, () => {
      // T11: a publication that arrives late makes the missing-plugin hint
      // untrue, so it is recorded before anything else is attempted.
      issuesSidebarInstallAnnounced = true;
      try {
        registerIssuesSidebar(pi);
      } catch {
        // The rail stays absent; every other surface keeps working.
      }
    });
    if (subscribed) issuesSidebarSubscribed = true;
  } catch {
    // The rail is optional: a broken bridge never breaks this extension.
  }
}

// ---------------------------------------------------------------------------
// S36 (files-picker T15): the file picker's ONE key, bound directly.
//
// The key is bound HERE, on the host's own seam and bound once at extension load:
// that is the whole registration this surface makes, and `/files` itself stays a
// command.
// ---------------------------------------------------------------------------

// The env name follows Gentle Shell's own convention (`GENTLE_PI_COMMANDS_KEY`,
// `GENTLE_PI_AGENTS_VIEW_KEY`); the default is a convenience, never a
// requirement: `/files` stays reachable as a command with no key at all.
const FILES_KEYMAP_ENV = "GENTLE_PI_FILES_KEY";
// S41 (round L12): `alt+p`, the human's own call. Pi reports `alt+f` as a conflict
// with `tui.editor.cursorWordRight` (its third default alias); `alt+p` is
// unclaimed on Linux and macOS, where `app.model.cycleBackward` is `shift+ctrl+p`,
// and is that action's key only on Windows and WSL.
const FILES_KEYMAP_DEFAULT = "alt+p";
const FILES_SHORTCUT_DESCRIPTION = "Open the file picker: enter inserts the paths, ctrl+e opens $EDITOR";

// S36: the environment's key when it holds a non-empty one, the default otherwise.
function filesShortcutKey() {
  const configured = process.env[FILES_KEYMAP_ENV];
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    if (trimmed !== "") return trimmed;
  }
  return FILES_KEYMAP_DEFAULT;
}

// S36: bound ONCE, at extension load. A host with no `registerShortcut`, a host
// that throws from it and a host that took no `files` command are the same
// silence: no key, no message, nothing else touched.
function bindFilesShortcut(pi) {
  try {
    if (typeof pi?.registerShortcut !== "function") return;
    const handler = (...args) => {
      const run = filesCommandHandler;
      if (typeof run !== "function") return;
      // The host hands a shortcut the session context; the command's own handler
      // is the ONE implementation, invoked with no argument (exactly `/files`).
      const ctx = args.length > 0 ? args[args.length - 1] : undefined;
      try {
        void run("", ctx);
      } catch {
        // A key never breaks the host.
      }
    };
    pi.registerShortcut(filesShortcutKey(), { description: FILES_SHORTCUT_DESCRIPTION, handler });
  } catch {
    // The key is a convenience: a host that refuses it never breaks this extension.
  }
}

// T11 (S2 amended, L10): discoverability is the ONE thing a host without the
// bridge gets. Nothing throws today — every bridge call is guarded — so this is a
// hint, not error handling: ONE warning per process, from a primary session only
// (the same `GENTLE_PI_AGENTS_CHILD` signal the prompt block uses, so a subagent
// never speaks for the human), naming the install command verbatim.
function warnIssuesSidebarMissing(ctx) {
  if (issuesSidebarInstallWarnedAlready()) return;
  if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  // A host with no notice seam cannot be told anything; the flag stays clear so
  // a later session that does have one still gets the single warning.
  if (typeof notify !== "function") return;
  markIssuesSidebarInstallWarned();
  try {
    notify(ISSUES_SIDEBAR_INSTALL_HINT, "warning");
  } catch {
    // A notice is best effort; it never breaks startup.
  }
}

function issuesSidebarInstallWarnedAlready() {
  try {
    return globalThis[ISSUES_SIDEBAR_WARN_SLOT] === true;
  } catch {
    return false;
  }
}

function markIssuesSidebarInstallWarned() {
  try {
    globalThis[ISSUES_SIDEBAR_WARN_SLOT] = true;
  } catch {
    // A frozen global still gets the warning; only the dedupe is lost.
  }
}

// T11: the check itself, and the part that must be timed honestly. An empty slot
// at `session_start` means "not yet": the bridge publishes from its own load, so
// with a bus the check waits the announcement window and warns only if the slot
// is STILL empty and no announcement arrived in between. A host with no bus can
// never announce, so there it warns at once. The timer is unref'd: a hint never
// holds the process open.
function checkIssuesSidebarInstall(pi, ctx) {
  try {
    if (issuesSidebarInstallWarnedAlready()) return;
    if (issuesSidebarBridge() !== null) return;
    if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;
    const events = pi && pi.events ? pi.events : null;
    if (!events || typeof events.on !== "function") {
      warnIssuesSidebarMissing(ctx);
      return;
    }
    if (issuesSidebarInstallArmed) return;
    issuesSidebarInstallArmed = true;
    let timer;
    try {
      timer = setTimeout(() => {
        issuesSidebarInstallArmed = false;
        try {
          if (issuesSidebarInstallAnnounced) return;
          if (issuesSidebarBridge() !== null) return;
          warnIssuesSidebarMissing(ctx);
        } catch {
          // A failed hint never breaks the session.
        }
      }, ISSUES_SIDEBAR_INSTALL_WINDOW_MS);
    } catch {
      issuesSidebarInstallArmed = false;
      return;
    }
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch {
    // The rail is optional: a failed hint never breaks startup.
  }
}

function rememberIssuesSidebarSession(ctx) {
  if (!ctx || typeof ctx !== "object") return;
  issuesSidebarCtx = ctx;
}

// S6 (issues-sidebar): a session that starts in ANOTHER checkout supersedes the
// previous one HERE, synchronously, before any awaited probe in the handler
// below. The section drops its snapshot (the rail shows the loading row) and
// moves its latest-wins token on, so an answer the previous checkout's read is
// still holding lands nowhere instead of painting the repository the session
// left. A throwing seam never breaks session start.
function invalidateIssuesSidebar() {
  const handle = issuesSidebarHandle;
  if (!handle || typeof handle.invalidate !== "function") return;
  try {
    handle.invalidate();
  } catch {
    // The rail is optional: a failed supersede never breaks startup.
  }
}

// S3 amended (T13, L11): the session's own events ask the section for a read
// ONLY while the section is actually shown. A hidden section must cost nothing —
// no child process, no network, no timer — so the section is asked whether it
// was drawn inside the window, and only then does the activity floor apply (a
// fresher snapshot, a read in flight and a disposed section are the section's own
// business). Best effort like its neighbours: a throwing seam never breaks the
// hook that fired it.
function refreshIssuesSidebarIfDrawn() {
  const handle = issuesSidebarHandle;
  if (!handle) return;
  try {
    if (typeof handle.drawnWithin !== "function") return;
    if (handle.drawnWithin(ISSUES_SIDEBAR_DRAWN_WINDOW_MS) !== true) return;
    if (typeof handle.refreshIfStale !== "function") return;
    handle.refreshIfStale(ISSUES_SIDEBAR_ACTIVITY_FLOOR_MS);
  } catch {
    // A failed activity read never breaks the session; the next frame retries.
  }
}

// S10 (T9): the result of a `bash` call whose COMMAND mutates a GitHub issue or
// pull request is the one moment the plugin knows something changed, so it forces
// ONE read right after that tool ends. The decision is the classifier's
// (`lib/issues-bash-mutation.js`, text only, no child process), and the cap is the
// section's (`forceRefresh`, L9: one forced read per 5 s, so a script running
// several `gh` writes cannot storm the API). Nothing happens for a non-`bash`
// tool — the classifier never even runs — and nothing happens while the section
// is not drawn (S11) or for a result the session that is running did not produce.
// Best effort like its neighbours: a throwing seam never breaks the result it
// rides on.
function forceIssuesSidebarRefreshForBash(event, ctx) {
  try {
    // S10 (T9): the event is read through the SAME accessors every other handler
    // uses — `oddToolNameOf`/`oddArgsOf` accept the host's other spellings, so a
    // result that arrives as `tool`/`args` is the same bash call and forces the
    // same read instead of silently matching nothing.
    if (oddToolNameOf(event) !== "bash") return;
    const handle = issuesSidebarHandle;
    if (!handle) return;
    // S11: the whole feature only serves a section that is on screen.
    if (typeof handle.drawnWithin !== "function") return;
    if (handle.drawnWithin(ISSUES_SIDEBAR_DRAWN_WINDOW_MS) !== true) return;
    // A result from a session that already ended forces nothing: the ctx it
    // carries is not the session this rail belongs to.
    if (!oddSessionStillCurrent(ctx)) return;
    if (typeof handle.forceRefresh !== "function") return;
    const input = oddArgsOf(event);
    const command = input && typeof input === "object" ? input.command : undefined;
    if (typeof command !== "string" || command.length === 0) return;
    const mutation = libRequire("issues-bash-mutation.js");
    if (!mutation || typeof mutation.bashMutatesIssuesOrPullRequests !== "function") return;
    if (mutation.bashMutatesIssuesOrPullRequests(command) !== true) return;
    handle.forceRefresh(ISSUES_SIDEBAR_FORCED_FLOOR_MS);
  } catch {
    // A forced read is best effort: it never breaks the result it rides on.
  }
}

// S21 (T17): a panel write changed the viewer's OWN assignment, so the rail's
// `mine`+`assigned` merge for THIS repository is no longer what the cache
// holds. A DELTA read can never say so: it merges by issue number, so a row
// the viewer was removed from would survive it forever. The entry is dropped
// (which is what makes `plan` answer the full size) and the identity is marked
// so the disk half cannot hydrate it back before that plan, and the rail reads
// NOW when it is on screen — a human's save is one action, so it is neither a
// script that needs the bash anti-storm cap nor something to wait 20 s for.
// Nothing here starts a read for a section nobody is drawing (S11).
function invalidateIssuesSidebarAssignment(identity) {
  if (typeof identity !== "string" || identity.length === 0) return;
  issuesSidebarFullReadIdentities.add(identity);
  const cache = issuesSidebarRelatedCache();
  if (cache !== null && typeof cache.drop === "function") {
    try {
      cache.drop(identity);
    } catch {
      // A cache that refuses the drop still leaves the marked read full.
    }
  }
  const handle = issuesSidebarHandle;
  if (!handle) return;
  try {
    if (typeof handle.drawnWithin !== "function") return;
    if (handle.drawnWithin(ISSUES_SIDEBAR_DRAWN_WINDOW_MS) !== true) return;
    if (typeof handle.refresh !== "function") return;
    const pending = handle.refresh();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    // The rail is optional: a failed refresh never breaks the panel's write.
  }
}

// The event's own session, against the one this rail was bound to. A host that
// gives no id on either side is answered by the drawn window instead, and a rail
// with no remembered session (a `/reload`, a shutdown) is answered with `false`.
function oddSessionStillCurrent(ctx) {
  const current = issuesSidebarCtx === null ? undefined : oddSessionId(issuesSidebarCtx);
  if (current === undefined) return false;
  const event = oddSessionId(ctx);
  return event === undefined || event === current;
}
// ---------------------------------------------------------------------------
// S18 (T14, L13): the bridge gate. This package is a guest of
// gentle-shell-bridge — the rail, the bash design and the `Cards` rows all live
// on its published object (the picker's `alt+p` shortcut is bound on the host
// itself, but only once this gate has registered the command it opens) — and the human's
// answer for what to do without it was exactly "Desactivar todo el plugin":
// register NOTHING. No command, no tool, no message or entry renderer, no card,
// no rail, no hook, no prompt append.
//
// The bridge publishes ASYNCHRONOUSLY, and Pi may load this package before or after
// it, so the registration is DEFERRED rather than eager: everything registers the
// moment the bridge is known present (already on its slot at load, or announced on
// its ready event later), and if the announcement never comes the package registers
// nothing and only says how to install it. Nothing may register twice, whichever
// path arrives first.
//
// The one thing that is NOT deferred is the notice's observer: `ctx.ui.notify`
// lives on a session, so the only way to name the missing plugin in a primary
// session is to observe `session_start` until the gate opens — one hook, kept sole
// while the gate is closed and released the moment the surface registers.
let oddSurfaceRegistered = false;
let bridgeGateDisposer = null;

function releaseBridgeGateObserver() {
  const dispose = bridgeGateDisposer;
  bridgeGateDisposer = null;
  if (typeof dispose !== "function") return;
  try {
    dispose();
  } catch {
    // A host that will not release the observer still has a harmless one.
  }
}

// ONE registration per gate episode. The flag is set FIRST, so a path that fails
// half way can never re-register the parts that did land, and the two gate paths
// (already published at load, announced later) share it: whichever arrives first
// registers, the other is a no-op.
function registerOddWorktreeSurface(pi) {
  if (oddSurfaceRegistered) return false;
  // The bridge is the precondition, whichever path arrives: an announcement with
  // no published object is not a bridge this package may load on.
  if (issuesSidebarBridge() === null) return false;
  oddSurfaceRegistered = true;
  try {
    registerOddWorktreeSurfaceEntries(pi);
  } catch {
    // A host that refuses a registration keeps the rest of the surface.
  }
  releaseBridgeGateObserver();
  return true;
}

// While the bridge is absent: ONE ready-announcement subscription (the bridge may
// publish after us) and ONE session_start observer (the missing-plugin notice).
// Nothing else is registered.
function holdSurfaceForBridge(pi) {
  try {
    subscribeBridgeReady(pi, () => {
      try {
        registerOddWorktreeSurface(pi);
      } catch {
        // The gate stays closed; the announcement is not retried.
      }
    });
  } catch {
    // No bus: a bridge that publishes later is noticed at the next session start.
  }
  if (typeof pi?.on !== "function") return;
  try {
    const dispose = pi.on("session_start", (event, ctx) => {
      // A bridge that was there all along, or arrived without an announcement,
      // makes the notice untrue: register instead of warning.
      if (issuesSidebarBridge() !== null) {
        registerOddWorktreeSurface(pi);
        return;
      }
      checkIssuesSidebarInstall(pi, ctx);
    });
    bridgeGateDisposer = typeof dispose === "function" ? dispose : null;
  } catch {
    // A host that refuses the observer still gets the install line nowhere else.
  }
}

export default function (pi) {
  // A factory call is one registration episode. Pi builds a fresh registry for a
  // `/reload` and expects the same surfaces again, which is why the episode starts
  // HERE; the gate's own two paths share the episode, so neither of them can
  // register the surface twice.
  oddSurfaceRegistered = false;
  // S18 (T14): no bridge, no package. The published object is read from its slot
  // after its own schema and version gate — never imported, never a dependency.
  if (issuesSidebarBridge() !== null) {
    registerOddWorktreeSurface(pi);
    return;
  }
  holdSurfaceForBridge(pi);
}

function registerOddWorktreeSurfaceEntries(pi) {
  // `/warp` is the ONE entry point of the warp queue (S3): no agent surface
  // moves the session, so the command is where a handoff waits and lands.
  warpHandoffPi = pi;
  registerWarpMessageRenderer(pi);
  // S5 (warp-queue-boundary): the durable fallback of the queued line needs a
  // renderer for its own entry type, exactly like Pi's `restored N messages`
  // line. A host without the seam simply never shows the fallback.
  registerWarpQueueEntryRenderer(pi);
  // S9 (T10): the issues-panel refusal's one visible fallback line.
  registerIssuesRefusalEntryRenderer(pi);
  // S2 (issues-sidebar): the rail section, only when gentle-shell-bridge
  // published its API; otherwise one ready-announcement subscription. The same
  // path contributes the bash activity design.
  registerIssuesSidebar(pi);
  registerWarpCommand(pi);
  registerOddCommand(pi);
  // T7 (files-picker): the file picker is the fourth command. It mounts its own
  // overlays, reads Git through the package's async runner and adds no tool.
  registerFilesCommand(pi);
  // S36 (files-picker T15): the picker's ONE key, bound directly on the host and
  // bound once — `alt+p` (S41) unless `GENTLE_PI_FILES_KEY` says otherwise.
  bindFilesShortcut(pi);
  registerIssuesCommand(pi);
  pi.registerTool(worktreeCreateTool);
  pi.registerTool(worktreeListTool);
  if (typeof pi?.on !== "function") return;
  // S5: the cards follow the style chosen in Gentle Shell with no hook of their
  // own. The shell publishes the live value on a process-wide slot and the card
  // substrate reads it on every render; when no host is present the substrate reads
  // `<home>/card-style.json` on every render too. So there is nothing to re-read at
  // `session_start` and nothing cached to invalidate.
  // The session-start `gh` check only gates whether `/issues` may open; the
  // command itself is registered eagerly above. The same boundary is the
  // session context the section's reads belong to.
  // S6 (issues-sidebar): the supersede of a previous checkout's read happens
  // FIRST and synchronously — the session context is remembered and the section
  // is invalidated before anything else in this boundary runs, so an answer the
  // previous checkout's read settles with finds no latest token to win and no
  // snapshot to keep.
  // S3 amended (T13, L11): NO read happens here. A hidden section costs nothing,
  // so the first DRAW is what starts the section's read: an absent snapshot is
  // stale inside `lines()`, which schedules its own refresh. The hidden section
  // therefore makes no child process and no network call, and starts no timer.
  // S1/S2/S3 (issues-startup-performance T1, T2): and NOTHING awaited here spawns a
  // child process or makes a network call. The `gh` gate is dispatched as tracked
  // startup work instead of being awaited, so the host's own await of this handler
  // returns at once — on every session start and every session switch — and it
  // resolves the checkout first, so outside a repository it does not even start a
  // `gh` child. The handler is therefore NOT `async`.
  // S36 (files-picker T15): the picker's key is no longer a bridge contribution
  // that a later moment retries — it is bound ONCE at load through the host's own
  // `registerShortcut`, so this boundary has nothing of the picker's to do.
  pi.on("session_start", (event, ctx) => {
    rememberIssuesSidebarSession(ctx);
    // T16 (S6/S9): a session that starts in another checkout also cuts the CACHE
    // write path, not just the section's snapshot. The identity — not the checkout
    // — keys the cache, so two checkouts of one repository share an entry: an
    // answer the previous checkout's read still holds must not seed the repository
    // the session moved to, or the moved session starts from rows it discarded and
    // its first read would be a delta instead of a full one.
    issuesSidebarCacheGeneration += 1;
    // S1 (issues-sidebar-click T1): a rail click left over by the previous
    // session is over — released here, and inert anyway through the generation
    // above.
    releaseIssuesPanelOpen();
    invalidateIssuesSidebar();
    // T18 (S11): a shutdown disposed the section, and a republished bridge is a
    // new binding. This is the moment both are picked up again; with a live
    // section on the same bridge it is a no-op.
    registerIssuesSidebar(pi);
    // T11 (S2 amended): the missing-plugin hint. It is armed in the same
    // boundary as the section's own state, and it says nothing yet when the
    // host could still announce.
    checkIssuesSidebarInstall(pi, ctx);
    // S5 (T8): the `gh` gate is DISPATCHED here, never awaited. The host awaits
    // every handler it is handed, one at a time, so awaiting it put the first
    // prompt behind `gh api user` + `gh repo view` and the checkout's own git
    // probes on every open, resume and session switch (~1.1 s of network, every
    // time). It now runs in the background and applies its verdict when it lands;
    // the generation it carries is bumped FIRST, so a probe the previous checkout
    // dispatched can never apply its verdict here, and `/issues` awaits this same
    // promise instead of starting a second probe.
    issuesGateGeneration += 1;
    issuesGateProbe = null;
    // S13 (T11): without the CLI there is nothing for this gate to answer and
    // nothing registered to use the answer, so no probe is dispatched at all — no
    // child, no network, nothing said.
    if (!ISSUES_GH_CLI_ABSENT) dispatchIssuesGate(ctx);
  });
  // A queued warp is session state: shutdown clears its record and its timer so
  // nothing outlives the session that asked for the move. S6 (issues-sidebar):
  // a session that ends takes its rail with it. The snapshot is dropped, so a
  // frame drawn afterwards shows the loading row instead of the ended session's
  // rows, the latest-wins token moves on, so a read still in flight lands
  // nowhere and never repaints a torn-down host, and the remembered context is
  // cleared, so a frame drawn after shutdown can never read with a dead
  // session's cwd.
  // S4 (issues-startup-performance T3, L7): the READ CACHE is not session state.
  // `clearIssuesSidebarCache` still moves the generation on — a late answer lands
  // nowhere — but the entries STAY, so the next session's first read is a delta
  // and a rail click opens `/issues` already populated.
  pi.on("session_shutdown", (event, ctx) => {
    forgetPendingWarp(ctx);
    forgetInFlightWarpTools();
    // S1 (issues-sidebar-click T1): an open the ended session dispatched never
    // blocks the next one.
    releaseIssuesPanelOpen();
    invalidateIssuesSidebar();
    clearIssuesSidebarCache();
    // S5 (T8): the gate's own state is session state too. The generation moves on,
    // so a probe still in flight lands nowhere and never notifies a dead UI, and
    // the client's cached answers are dropped so the next session probes afresh
    // instead of inheriting its predecessor's.
    issuesGateGeneration += 1;
    issuesGateProbe = null;
    clearIssuesGateCache();
    issuesSidebarCtx = null;
    // T18 (S11): the session that is ending leaves no floor timer behind. The
    // snapshot was dropped by `invalidateIssuesSidebar` above and the binding is
    // ended here: the bridge's unregister and the section's own `dispose()`, so a
    // frame the host still paints after shutdown arms nothing and reads nothing.
    teardownIssuesSidebar();
  });
  // Nothing deferred survives its session: shutdown advances the startup epoch,
  // so startup work still in flight drops instead of writing into the session
  // that replaced it.
  pi.on("session_shutdown", () => {
    startupEpoch += 1;
  });
  pi.on("tool_call", (event, ctx) => handleWorktreeOddEvent(event, ctx, pi));
  // S1/S3/S4/S9: the worktree guard, the ONE `tool_call` observation that refuses a
  // `bash` command instead of observing it. It sits beside the naming handler and is
  // the only handler that returns a `block` answer; every other tool call is left
  // exactly as the host proposed it. Nothing about it is callable by the agent (S7).
  pi.on("tool_call", (event, ctx) => guardWorktreeBashCall(event, ctx));
  pi.on("tool_result", (event, ctx) => handleWorktreeOddEvent(event, ctx, pi, true));
  // S10 (T9): ONE `tool_result` observation for the rail's forced refresh. It
  // answers the `bash` tool only — every other tool returns before the classifier
  // is even loaded — and it is separate from the naming handler because the two
  // answer different questions about the same event.
  pi.on("tool_result", (event, ctx) => forceIssuesSidebarRefreshForBash(event, ctx));
  // S10: the host's execution pair feeds the queue's in-flight tool counter for
  // EVERY tool of the session, not only this package's.
  pi.on("tool_execution_start", (event) => warpNoteToolExecution(event, false));
  pi.on("tool_execution_end", (event) => warpNoteToolExecution(event, true));
  // S1/S13/S17 (warp-queue-boundary): the turn boundary. Pi delivers a queued
  // input at the end of the current assistant turn, after its tool calls and
  // before the next model call; a pending warp takes effect at that SAME
  // boundary. When the run itself is the only thing still blocking a pending
  // record AND the turn that just ended executed tools, the module ends the run
  // through `ctx.abort()`, ONCE, so the move lands where a queued input would.
  // Nothing is ever sent to the agent: an instruction to a model can be ignored —
  // a text-only answer follows it and no later boundary exists for a safety net —
  // while the abort is deterministic. A turn that executed no tool result is the
  // agent's final answer: the run settles on its own, and the boundary aborts
  // nothing. A record with real workload pending aborts nothing either, and the
  // handler never returns a boundary proposal (the `entries` and `continue`
  // fields stay exactly as the host proposed them).
  //
  // S13 (warp-queue-boundary): the abort must land BETWEEN provider requests, so
  // the module decides SYNCHRONOUSLY here — before it awaits anything — from the
  // record's last sampled activity and the event's own tool evidence, and only an
  // absent or stale sample falls back to an awaited re-read. Ending the run after
  // a read is what cut an assistant message that carried tool calls and repainted
  // every one of them as a failed `Operation aborted` result. Nothing in this
  // handler may await before that decision: `ctx.abort()` fires inside the call
  // below, in the same synchronous stretch as the host's `turn_end`.
  pi.on("turn_end", async (event, ctx) => {
    // S3 (issues-sidebar): the session's own activity is what keeps the rail
    // current, because the host produces no frame on an idle session. The
    // context is remembered FIRST: `/reload` fires no `session_start`, so the
    // next activity is what re-binds the section's reads to the checkout this
    // session actually runs in instead of whatever cwd the host process has.
    // T13: the read itself happens only while the section is drawn.
    rememberIssuesSidebarSession(ctx);
    refreshIssuesSidebarIfDrawn();
    try {
      const lib = libRequire("worktree-warp-busy.js");
      if (!lib || typeof lib.pendingWarpTurnBoundary !== "function") return;
      const abort = ctx && typeof ctx.abort === "function" ? () => { ctx.abort(); } : null;
      const sawTools = Array.isArray(event?.toolResults) && event.toolResults.length > 0;
      await lib.pendingWarpTurnBoundary({ abort, sawTools });
    } catch {
      // A turn boundary must never break the host.
    }
  });
  // S3 (warp-settle-dispatch): the settle boundary. An `agent_settled` handler
  // ticks every pending record once, so a queued warp starts as soon as Pi
  // settles — the counters were already zero while the assistant was thinking,
  // and this is the first moment the host accepts the dispatch — instead of on
  // the next poll. The poller stays as the fallback for a workload that outlives
  // settle (a background job, an agent task) and for a dispatch the host
  // rejects. One tick per record: the record's own `dispatching` guard makes the
  // boundary and a concurrent poll dispatch it at most once, and a throwing
  // tick must never break the host.
  pi.on("agent_settled", async () => {
    try {
      const lib = libRequire("worktree-warp-busy.js");
      if (!lib || typeof lib.pendingWarpKeys !== "function" || typeof lib.pendingWarpTick !== "function") return;
      for (const key of lib.pendingWarpKeys()) {
        try {
          await lib.pendingWarpTick(key);
        } catch {
          // One record's failure never stops the others from being ticked.
        }
      }
    } catch {
      // A settled handler must never break the host.
    }
  });
  // S7: the ODD worktree rules ride the prompt options, appended after the
  // harness's own text. Sync mutation, so the host reads the final string.
  pi.on("before_agent_start", (event, ctx) => {
    // S3 (issues-sidebar): the same activity trigger as the turn boundary, with
    // the same ordering — remember the context, then ask for a read behind the
    // floor. This is the `/reload` recovery: a reload registers no session
    // context at all, so the next activity adopts the one the session runs in.
    // T13: and like the turn boundary, it reads only while the section is drawn.
    rememberIssuesSidebarSession(ctx);
    refreshIssuesSidebarIfDrawn();
    try {
      libRequire("odd-worktrees-prompt.js").appendOddWorktreesSection(event);
    } catch {
      // The prompt block is best effort.
    }
    // The role's CodeGraph text rides the same append-only channel. It only
    // advises a session that already holds a CodeGraph tool.
    try {
      libRequire("codegraph-rules.js").appendCodegraphSection(event);
    } catch {
      // The prompt block is best effort.
    }
  });
  // CodeGraph, only with its CLI installed: the global MCP entry, create-or-sync at session
  // start, the compaction sync, the observed native init and the edit/write sync. Every
  // piece runs in the background and none can fail the host.
  try {
    libRequire("codegraph-session.js").registerCodegraph(pi, { metrics: () => resolveWorktreeToolCardMetrics() });
  } catch {
    // CodeGraph is best effort.
  }
  // S1 (T2): the file cards, through the same host hook. A `read`/`edit`/`write` call whose
  // path names a skill or an ODD artifact heads as that file while the bridge's `Card tools`
  // line answers with this package's activity design; every other call keeps the host's own
  // boxed row, which the card reproduces because the hook decides per tool name and never
  // sees the arguments. No preference of ours is registered: the gate is the bridge's own
  // published reader, asked on every paint. A host without `pi.registerToolRenderer`
  // registers nothing and keeps drawing them itself.
  try {
    libRequire("file-card-resolver.js").registerFileCard(pi, { metrics: () => resolveWorktreeToolCardMetrics() });
  } catch {
    // The card is cosmetic.
  }
  // The live-checkout scan is DISPATCHED and never awaited. Its only product is
  // `warpDiscoveryCache`, which nothing reads — every warp lists fresh before
  // acting — so the old "startup barrier" awaited three git reads for a result the
  // next thing the session does never consumes. Measured on this checkout:
  // 483 ms → 72 ms of awaited `session_start`, and the rest of that 72 ms went with
  // the barrier. The task is still TRACKED, so `awaitPendingStartupTasks` and a
  // shutdown barrier can wait for it, and a failure still cannot break a session.
  pi.on("session_start", (event, ctx) => {
    try {
      const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd
        : event && typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd
        : process.cwd();
      trackStartupTask(runStartupDiscovery(cwd, beginStartupTask()));
    } catch {
      // Discovery must never break startup.
    }
  });
}

export { executeWorktreeCreate, executePortedWorktreeCreate, executePortedWorktreeList, executeWorktreeClose, resolveThread, executeWorktreeWarp, emitOsc7, awaitPendingStartupTasks, scanLiveCheckouts, runStartupDiscovery, setWarpTuiLoader, setOddTuiLoader, setIssuesTuiLoader, setFilesTuiLoader, setFilesAgentLoader, setWorktreeCardHelpers, setWorktreeToolCardMetrics, setWarpDirtyAsker, setWarpFactsFactory, warpCreatePreflight, warpForkSourceUsable, dispatchIssuesPanel, issuesSidebarGeneration, issuesOpenInBrowser, libModule };

'use strict';
// What each checkout has in `odd/tasks`, and what a worktree has that main does
// not (odd-rail-section S10).
//
// The ODD panel draws one collapsible group per checkout registered in the
// session, so the grouping question is answered here, once, as ONE pure async
// function of the machine as it is right now: the main checkout's whole list
// first, then one group per OWNED worktree carrying only its delta against main.
// It caches nothing, writes nothing and keeps no state between calls.
//
// Checkouts (reuse, not duplication): this module owns the ONE enumeration now
// that lib/odd-scan.js is gone — one `git worktree list --porcelain -z` read over
// the package's `runAsync(bin, argv, cwd)` seam, parsed by lib/worktree-registry.js's own
// porcelain parser, the main row first and then the checkouts this package owns,
// i.e. the ones under `<repo-parent>/<repo-name>-worktrees` in worktree-name
// order. Invariant 10: a worktree is a path, not a document, so there is nothing
// to read and nothing is read. A worktree Git knows outside that directory is not
// ours and is not grouped — unless the caller asks for EVERY worktree (S11,
// `all: true` below), which is the `a` mode of the panel and nothing else.
//
// S13: the scope is an INPUT, because this machine holds ~20 worktrees and a diff
// per worktree on every refresh is real cost. `roots` is the set of worktrees the
// SESSION registered. Absent (undefined/null), the enumeration above is unchanged:
// every owned worktree. Present as an array, only what Git lists AND that array
// names is grouped, and the owned-checkout rule no longer applies — registration is
// the authority, so a worktree registered outside
// `<repo-parent>/<repo-name>-worktrees` is included. The main checkout is always
// first and always whole, whether or not `roots` names it, so a root equal to main
// is never a second group and an empty array is `main` alone. A root Git does not
// list (stale, deleted, another clone) contributes nothing and never throws. An
// excluded worktree is never ASKED anything: the git reads below happen only for
// the included ones.
//
// S11: `all: true` is the ADDITIVE third scope, and the only one without a filter:
// every worktree Git lists except main, registered or not and wherever it lives —
// the panel's `a` key, whose meaning is "todos los worktrees, da igual si esta
// registrado o no". It wins over `roots` when a caller passes both, because a
// caller asking for everything cannot also be asking for a subset. Absent or
// false it changes nothing: the two scopes above answer exactly as before, which
// is what every existing caller relies on. Failure is unchanged — an unreadable
// checkout (a stale registration Git still lists) contributes no document and
// never throws.
//
// The MAIN group (S10) carries EVERY document of `<main>/odd/tasks`, scanned by
// lib/odd-docs.js's `listOddDocsLocal` — the `<root>/odd/tasks/*.md` rule
// (non-recursive, regular files only, dotfiles skipped, absent directory = empty)
// stays stated in exactly one place — and no document carries a `status`, because
// against itself nothing is new or modified.
//
// A WORKTREE group carries ONLY the documents that are new or modified relative
// to main, and answering that takes two comparisons, both required:
//
//   (a) THE BRANCH'S OWN WORK, against the MERGE BASE. A plain working-tree diff
//       is not enough: once the worktree commits, its tree matches its own HEAD
//       and the ordinary diff finds nothing. The shape borrowed from
//       lib/worktree-changes.js (`resolveMergeBase`, `git merge-base HEAD <sha>`)
//       and lib/files-index.js (the three-dot comparison against the merge base)
//       is: resolve main's HEAD once, then ask the WORKTREE for
//       `git merge-base HEAD <mainHead>`, and name the documents of that branch
//       with one `git diff --name-status -z --no-renames <base>` — a diff against
//       the merge-base COMMIT with no second revision, so committed and
//       not-yet-committed work both count. `--no-renames` keeps the read
//       read-only (rename detection is what makes Git fetch a missing blob in a
//       partial clone and write a pack) and spells a rename as delete plus add.
//       The working tree's own status is unioned in, exactly as the files panel
//       unions it: a brand-new document that is still untracked has no commit to
//       name it, and "new relative to main" is the case the group exists for.
//
//   (b) THE BYTES. A document the first comparison names is still not a
//       difference when its CONTENT equals main's current copy — the case the
//       user named, where main advanced and the worktree's copy happens to be
//       byte-identical. Both sides are read and compared as buffers; an equal
//       pair is dropped. This is also why `status` is decided by main's own
//       listing rather than by Git's letter: `added` is a path main does not
//       have, `modified` a path it does.
//
// Order (two rules that never fight): the groups come back main first, then the
// owned worktrees by name; within a group the most recently modified document
// comes first, then the ODD name, then the document path — code-unit comparisons
// only, never `localeCompare`, so the sequence is identical on every host and
// every run.
//
// Cost: one `git worktree list`, then per worktree WITH documents to compare one
// `merge-base`, one `diff` and one `status` — and one `rev-parse HEAD` in the main
// checkout for the whole call, resolved lazily so a machine whose worktrees hold
// no documents runs no git beyond the listing. No `git log`, no history walk, no
// per-document process.
//
// Failure is silence, never a throw: an unreadable checkout, an absent
// `odd/tasks`, a `merge-base`, `diff` or `status` that fails or throws, a main
// HEAD that cannot be read — each contributes no document. An empty delta is a
// group with `docs: []`, NOT a missing group: whether an empty group is drawn is
// the CALLER's decision (S10/S13: a worktree with no difference keeps the panel in
// its ordinary main-only listing), so this module never makes that call.

const fs = require('node:fs');
const path = require('node:path');

const { ownedCheckouts, parseWorktreePorcelain } = require('./worktree-registry.js');
const { listOddDocsLocal, TASKS_DIR } = require('./odd-docs.js');

const MAIN = 'main';
// Git wants forward slashes even on Windows, and so does every path this module
// compares against Git's own output.
const TASKS_POSIX = TASKS_DIR.split(path.sep).join('/');

const WORKTREE_LIST_ARGS = ['worktree', 'list', '--porcelain', '-z'];
const HEAD_ARGS = ['rev-parse', 'HEAD'];
// The working tree's own work, limited to the one directory the group is about.
// `--no-optional-locks` keeps the read read-only: the stat-cache refresh Git would
// otherwise write back into `.git/index` is skipped.
const STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
  '--',
  TASKS_POSIX,
];
// (a) above: the branch's net change against the merge-base COMMIT, one fixed
// argv array per call. `--` says the argument list ends before any path could
// start, so a checkout holding a file named like a revision cannot break the read.
const diffArgs = (base) => ['diff', '--name-status', '-z', '--no-renames', base, '--', TASKS_POSIX];

// The one configuration that would corrupt a read: `core.quotePath=false` keeps a
// non-ASCII path readable instead of octal-escaped.
const GIT_CONFIG_ARGS = ['-c', 'core.quotePath=false'];
const GIT_TIMEOUT_MS = 5000;

const compareText = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Worktrees order by name, so the sequence never depends on Git's own. */
function compareCheckout(a, b) {
  const named = compareText(path.basename(a.path), path.basename(b.path));
  return named === 0 ? compareText(a.path, b.path) : named;
}

/** One group's documents: most recently modified first, then name, then path. */
function compareDocs(a, b) {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return compareText(a.name, b.name) || compareText(a.docPath, b.docPath);
}

const samePath = (a, b) => a.length > 1 && b.length > 1 && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * The checkouts to group: the main checkout first, then the worktrees in scope.
 * `entries` is `git worktree list`'s answer, or null when git could not give one —
 * and then the caller's own root is the only checkout there is, reported as the
 * main one because with no listing nothing can tell the two apart. `scope` is the
 * normalized set of registered roots, or null when the caller scoped nothing and
 * every owned worktree is in play (S13). `all` is the unfiltered scope of S11: every
 * listed worktree except main, registration and location ignored.
 */
function checkoutsOf(entries, repoRoot, scope, all) {
  if (entries === null) return [{ root: repoRoot, name: MAIN }];
  const main = entries[0];
  const mainRoot = main && typeof main.path === 'string' && main.path.length > 0 ? main.path : repoRoot;
  const rest = entries.filter((entry) => entry !== main
    && !(entry && typeof entry.path === 'string' && samePath(entry.path, mainRoot)));
  // S11: `all` is the ONE unfiltered scope — every listed worktree except main.
  // Otherwise registration (or its absence) decides, exactly as before.
  let worktrees = [];
  if (all === true) {
    worktrees = rest.filter((entry) => entry && typeof entry.path === 'string' && entry.path.length > 0);
  } else {
    worktrees = scope === null ? ownedCheckouts(rest, mainRoot) : registeredCheckouts(rest, scope);
  }
  const checkouts = [{ root: mainRoot, name: MAIN }];
  for (const entry of worktrees.sort(compareCheckout)) {
    checkouts.push({ root: entry.path, name: path.basename(entry.path) });
  }
  return checkouts;
}

/** A path normalized for comparison: absolute, no trailing separator. */
function normalizedPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(value);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

/**
 * S13: the roots a caller scoped the scan to, as normalized paths — or null when
 * it scoped nothing at all. Only an array scopes: `roots` absent, null or any other
 * shape keeps the "every owned worktree" behaviour an existing caller relies on.
 */
function scopeOf(roots) {
  // Absent means "no scope" (every owned worktree, the unchanged default). A scope that is
  // PRESENT but not a list is a caller mistake and fails closed to main only, never to the
  // most expensive path.
  if (roots === undefined || roots === null) return null;
  if (!Array.isArray(roots)) return new Set();
  const scope = new Set();
  for (const root of roots) {
    const normalized = normalizedPath(root);
    if (normalized !== null) scope.add(normalized);
  }
  return scope;
}

/**
 * S13: the listed checkouts a session registered. Git still decides existence — a
 * registered root it does not list is simply not a checkout — while registration
 * decides scope, so the owned-checkout rule deliberately does not apply here.
 */
function registeredCheckouts(entries, scope) {
  return entries.filter((entry) => {
    if (!entry || typeof entry.path !== 'string') return false;
    const normalized = normalizedPath(entry.path);
    return normalized !== null && scope.has(normalized);
  });
}

/**
 * One checkout's documents in group order, each dated by its own mtime. An
 * unreadable checkout, an absent `odd/tasks` and a document whose timestamp cannot
 * be read all contribute nothing: every row this module returns carries a real
 * modification time.
 */
function scanDocs(root) {
  const listing = listOddDocsLocal(root);
  if (listing.ok !== true) return [];
  const docs = [];
  for (const doc of listing.docs) {
    const mtimeMs = readMtimeMs(doc.path);
    if (mtimeMs === null) continue;
    docs.push({ name: doc.name, docPath: doc.path, mtimeMs });
  }
  return docs.sort(compareDocs);
}

/** Modification time in ms, or null when it cannot be read. */
function readMtimeMs(target) {
  try {
    const stats = fs.statSync(target);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The main group: EVERY document of the main checkout, and deliberately no
 * `status` — against itself nothing is new or modified, so the field is absent
 * rather than invented.
 */
function mainGroup(checkout) {
  return {
    checkoutName: MAIN,
    checkoutRoot: checkout.root,
    isMain: true,
    docs: scanDocs(checkout.root),
  };
}

/**
 * A worktree's delta (comparisons (a) and (b) above), in group order. Nothing it
 * cannot establish ever becomes a row: a worktree with no document of its own to
 * compare costs no git read at all, and a base or a path set it could not read
 * leaves the group empty instead of guessing.
 */
async function deltaOf({ checkout, mainRoot, mainByRel, head, opts }) {
  const docs = scanDocs(checkout.root);
  if (docs.length === 0) return [];
  const base = await mergeBaseOf(checkout.root, mainRoot, head, opts);
  if (base === null) return [];
  const named = await namedPathsOf(checkout.root, base, opts);
  if (named === null) return [];
  const delta = [];
  for (const doc of docs) {
    const rel = relativePosix(checkout.root, doc.docPath);
    if (!named.has(rel)) continue;
    const mainDoc = mainByRel.get(rel);
    if (mainDoc === undefined) {
      // `added`: main has no document of this path, so there is nothing to match.
      delta.push({ ...doc, status: 'added' });
      continue;
    }
    // (b): equal bytes are not a difference, whichever side moved.
    const mine = readBytes(doc.docPath);
    const theirs = readBytes(mainDoc.docPath);
    if (mine === null || theirs === null || mine.equals(theirs)) continue;
    delta.push({ ...doc, status: 'modified' });
  }
  return delta;
}

// (a), base half: the merge base of the worktree's branch with main, resolved the
// way lib/worktree-changes.js resolves it — main's HEAD first, then
// `git merge-base HEAD <sha>` INSIDE the worktree — and memoized for the whole
// call, so one `rev-parse` answers every worktree. Null when either read cannot
// answer, which leaves the group empty rather than comparing against something
// that is not the base.
async function mergeBaseOf(worktreeRoot, mainRoot, head, opts) {
  const mainHead = await mainHeadOf(mainRoot, head, opts);
  if (mainHead === null) return null;
  const base = await runGitAsync(worktreeRoot, ['merge-base', 'HEAD', mainHead], opts);
  if (base === null) return null;
  const tree = base.trim();
  return tree.length > 0 ? tree : null;
}

async function mainHeadOf(mainRoot, head, opts) {
  if (head.resolved !== true) {
    head.resolved = true;
    const answer = await runGitAsync(mainRoot, HEAD_ARGS, opts);
    const sha = answer === null ? '' : answer.trim();
    head.sha = sha.length > 0 ? sha : null;
  }
  return head.sha;
}

// (a), path half: the branch's own work, unioned from the commit diff against the
// merge base and the working tree's status. `null` when either read fails — the
// same closed answer for both, because half a comparison is not a comparison.
async function namedPathsOf(root, base, opts) {
  const diff = await runGitAsync(root, diffArgs(base), opts);
  if (diff === null) return null;
  const status = await runGitAsync(root, STATUS_ARGS, opts);
  if (status === null) return null;
  const named = new Set(parseNameStatusPaths(diff));
  for (const entry of parseStatusPaths(status)) named.add(entry);
  return named;
}

// `--name-status -z` records: `<letter>\0<path>\0`. `--no-renames` means the read
// produces `A`/`M`/`D`/`T` only; a rename or copy record (`<letter>\0<original>\0
// <path>\0`, original first) is still parsed in case a caller ever turns detection
// back on. A deleted path is left out: a document that is gone in the worktree has
// no row to draw.
function parseNameStatusPaths(stdout) {
  const paths = new Set();
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length === 0) continue;
    const letter = record[0];
    const carried = letter === 'R' || letter === 'C';
    const target = fields[index + (carried ? 2 : 1)];
    index += carried ? 2 : 1;
    if (typeof target !== 'string' || target.length === 0) continue;
    if (letter === 'D') continue;
    paths.add(target);
  }
  return paths;
}

// `status --porcelain=v1 -z` records: `<XY> <path>\0`, the original path of a
// rename or copy in the next field, which is consumed so it can never be read as a
// record of its own. A path the working tree deleted is left out for the same
// reason as above.
function parseStatusPaths(stdout) {
  const paths = new Set();
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const target = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') index += 1;
    if (code.includes('D')) continue;
    if (target.length > 0) paths.add(target);
  }
  return paths;
}

/** One file's bytes, or null when it cannot be read (fail closed: no row). */
function readBytes(target) {
  try {
    return fs.readFileSync(target);
  } catch {
    return null;
  }
}

/** A document's path relative to its checkout, POSIX-spelled to match Git's own. */
function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

/**
 * The grouped model: the main checkout's whole list, then one group per worktree in
 * scope carrying only what that worktree has that main does not. `repoRoot` is the
 * repository the git reads run in; `runAsync` is the package's git seam
 * (`(bin, argv, cwd) => Promise<{status, stdout, stderr, error}>`), defaulting to
 * the shared bounded async spawn wrapper. `roots` — optional — is the registered
 * worktrees to group (S13): absent means every owned worktree, and an array means
 * only the listed ones, main always first and always whole. `all` — optional — is
 * S11's unfiltered scope: `true` groups EVERY worktree Git lists except main,
 * registered or not, and wins over `roots`.
 */
async function groupOddDocs(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const repoRoot = absoluteRoot(opts.repoRoot);
  if (repoRoot === null) return [];
  const scope = scopeOf(opts.roots);
  const entries = await listCheckoutEntries(repoRoot, opts);
  const checkouts = checkoutsOf(entries, repoRoot, scope, opts.all === true);
  const main = checkouts[0];
  const groups = [mainGroup(main)];
  if (checkouts.length === 1) return groups;
  // Main's own listing answers both questions a worktree needs from it: which
  // relative paths it has (`added` vs `modified`) and which bytes to compare.
  const mainByRel = new Map(groups[0].docs.map((doc) => [relativePosix(main.root, doc.docPath), doc]));
  const head = { resolved: false, sha: null };
  for (const checkout of checkouts.slice(1)) {
    groups.push({
      checkoutName: checkout.name,
      checkoutRoot: checkout.root,
      isMain: false,
      docs: await deltaOf({ checkout, mainRoot: main.root, mainByRel, head, opts }),
    });
  }
  return groups;
}

/** The root as an absolute path, or null when the caller gave nothing usable. */
function absoluteRoot(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return path.resolve(value);
}

// The one listing read: fixed argv through the seam, parsed by the shared parser.
// `null` means "git could not answer" — not an exception and not an empty machine.
async function listCheckoutEntries(repoRoot, opts) {
  const listed = await runGitAsync(repoRoot, WORKTREE_LIST_ARGS, opts);
  return listed === null ? null : parseWorktreePorcelain(listed);
}

// One read, awaited instead of spawned inline, with the identical
// stdout-or-null contract every git read in this package keeps: a missing
// binary, a non-zero exit, a timeout or a throw is `null`.
function runGitAsync(root, args, opts) {
  let pending = null;
  try {
    pending = asyncRunnerOf(opts)('git', [...GIT_CONFIG_ARGS, ...args], root);
  } catch {
    return Promise.resolve(null);
  }
  return Promise.resolve(pending)
    .then((result) => {
      if (!result || result.error || result.status !== 0) return null;
      return typeof result.stdout === 'string' ? result.stdout : '';
    })
    .catch(() => null);
}

// The injected runner when a caller supplies it, otherwise the shared bounded
// async spawn wrapper — loaded lazily, so a caller that only ever uses its own
// seam never pays for it.
function asyncRunnerOf(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (typeof options.runAsync === 'function') return options.runAsync;
  const worktreeGit = require('./worktree-git.js');
  return (bin, args, cwd) => worktreeGit.runArgvAsync(bin, args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

module.exports = {
  groupOddDocs,
};

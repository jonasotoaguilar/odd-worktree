'use strict';
// Odd document discovery (odd-viewer S2,S6; ordering S10/S12; clone-aware
// recency S13).
//
// Scope is the CHECKOUT the session runs in: `<root>/odd/tasks/*.md`, not
// recursive, never the principal checkout when the session sits in a
// worktree. The caller resolves the root (the command uses the session cwd
// resolved to its Git root); this module only reads what it is given, so it
// stays testable on plain fixture directories.
//
// Recency, and why mtime alone is not enough (S13): a fresh clone stamps every
// file with the checkout time, so mtime says nothing about which document was
// modified last. The signal used for each document follows this priority:
//
//   1. LOCAL EDIT — the file's working-tree content is not what HEAD has
//      (`git status` reports it: modified, staged, added or untracked).
//      Recency = max(its own mtime, its own last commit time). A local edit is
//      therefore at least as new as the commit it edits, and a normal edit
//      (mtime = now) outranks every commit in the repository; a backdated
//      mtime can never demote it below the commit whose content it replaced.
//      An untracked document has no commit, so it is ranked by mtime alone.
//   2. COMMIT — tracked and clean: recency = the last commit time touching the
//      file. This is the rule that makes a fresh clone meaningful, and it
//      deliberately ignores mtime, which in a clone is checkout noise.
//   3. MTIME — no usable git signal (not a repository, git missing, git
//      failing or timing out, unparseable output, a shallow clone without
//      reachable history for that document, or an untracked document).
//
// Documents are then ordered by that timestamp DESCENDING, then display name
// ascending, then raw file name ascending — all code-unit comparisons, never
// `localeCompare`, so the order is identical on every host and every run. A
// document with no timestamp at all (stat failed and no commit time) is kept
// and placed after every ranked one, by name; the list never hides a document
// over a stat failure.
//
// Cost: at most THREE bounded git processes per listing — one `rev-parse HEAD`
// (the memo key), one `git log` for EVERY document's last commit time (never
// one process per document) and one `git status` for the local-edit signal —
// and NONE when `odd/tasks` yields no document. The log walks the commits
// reachable from HEAD that touch the `odd` tasks directory, so the work grows
// with that slice of history and not with the number of documents or the size
// of the tree; it is capped at MAX_LOG_COMMITS commits and each call at
// GIT_TIMEOUT_MS. Measured on a 271-commit checkout (78 commits touching
// `odd/tasks`): ~11 ms on local-speed storage, ~1.6 s on the same history over
// a slow network mount.
//
// That walk is therefore memoized (S13 cost): the parsed commit-time map is a
// pure function of the commits reachable from HEAD, so it is cached per
// repository AND per HEAD commit id. A repeated listing with an unchanged HEAD
// skips the walk and runs only the two cheap calls (`rev-parse`, `status`); a
// new commit changes HEAD and the walk runs again. The local-edit read is NEVER
// memoized — it is the cheap call and the only way an uncommitted edit can
// promote its document — so a dirty file still reorders the list. Nothing about
// a document's CONTENT is cached, only `file name -> commit time in ms`, and
// the cache is bounded (COMMIT_CACHE_LIMIT repositories, oldest evicted) so a
// session visiting many checkouts cannot grow it without limit. A HEAD that
// cannot be resolved is not a cache key at all: the listing walks history
// uncached or, when git cannot answer, degrades to the mtime fallback — it
// never serves a memoized order it cannot justify. A walk that exceeds the cap
// or the timeout degrades to the mtime fallback instead of delaying the listing
// further.
//
// Two readers exist because the viewer is an INTERACTIVE path (S21 «se traba»):
// `listOddDocsAsync` resolves the identical listing with every git read awaited
// instead of spawned synchronously, so a slow or network-mounted checkout can
// never freeze the host event loop while /odd loads or re-lists; and
// `listOddDocsLocal` is the cheap scan alone (mtime order, no git process at
// all) that paints the viewer's first frame and answers "is there anything to
// read here?" without a history walk. The two share the scan, the ordering rule,
// the parsers and the memo, so they cannot disagree about a checkout.
//
// Every failure mode is explicit and read-only: a missing or non-directory
// root fails closed, an absent `odd/tasks` directory is an empty list (a
// checkout simply without documents), and an unreadable document reports an
// error rather than rendering empty content.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASKS_DIR = path.join('odd', 'tasks');
// Git wants forward slashes even on Windows.
const TASKS_PATHSPEC = TASKS_DIR.split(path.sep).join('/');

const GIT_TIMEOUT_MS = 5000;
const MAX_LOG_COMMITS = 5000;
// Mark each commit record so a timestamp is never confused with a file name.
const COMMIT_MARK = '\u001e';

// The commit-time memo (see the cost note above): `root + NUL + HEAD commit id`
// -> `Map<file name, commit time in ms>`. Bounded so a session that lists many
// checkouts (one per worktree) cannot grow it without limit.
const COMMIT_CACHE_LIMIT = 8;
const CACHE_KEY_SEP = '\u0000';
const commitCache = new Map();

// The HEAD probe (memo key only) and the history walk: newest commit first,
// with the time it touched each path.
const HEAD_ARGS = ['rev-parse', '--verify', '--quiet', 'HEAD'];
const LOG_ARGS = [
  'log',
  '-z',
  '--name-only',
  '-n',
  String(MAX_LOG_COMMITS),
  `--format=${COMMIT_MARK}%ct`,
  '--',
  TASKS_PATHSPEC,
];
const STATUS_ARGS = ['status', '--porcelain', '-z', '--', TASKS_PATHSPEC];

// Neutralize the configuration that would corrupt parsing or add work: quoted
// paths, signature verification lines in `git log`, and an fsmonitor daemon in
// `git status` — whatever the host's global config says.
const GIT_CONFIG_ARGS = [
  '-c',
  'core.quotePath=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'core.fsmonitor=false',
];

// Ordered most-recently-modified first (S10/S12), with the display name as the
// deterministic tie-break: every consumer inherits the order from here instead
// of re-sorting its own view (`recent` is this sequence; the view sorts its own
// copy for `name`).
//
// `opts` is an optional seam for tests and hosts: `gitBin` overrides the `git`
// executable (a missing or failing binary is the "git unavailable" path).
// Nothing it carries reaches the row shape.
function listOddDocs(root, opts) {
  const scanned = scanOddDocs(root);
  // An empty listing costs no git process at all (a root that is not a checkout
  // is already answered by the scan).
  if (scanned.ok !== true || scanned.docs.length === 0) return scanned;
  return { ok: true, root: scanned.root, docs: orderDocs(scanned.docs, readGitRecency(scanned.root, opts)) };
}

// The CHEAP listing (S21): the very same scan, ordered by the documented mtime
// fallback, with NO git process of any kind. An interactive caller paints its
// first frame from this and asks for the ranked order separately, so opening the
// viewer never waits on a history walk — and a checkout that turns out to hold
// no document at all answers before git is consulted.
function listOddDocsLocal(root) {
  const scanned = scanOddDocs(root);
  if (scanned.ok !== true || scanned.docs.length === 0) return scanned;
  return { ok: true, root: scanned.root, docs: orderDocs(scanned.docs, null) };
}

// The async twin of `listOddDocs` for interactive callers (S21): the same
// documents in the same order, with every git read AWAITED instead of spawned
// synchronously, so a slow or network-mounted checkout can no longer freeze the
// host event loop while the viewer loads or re-lists. Same rows, same failures
// and the same degradations as the synchronous reader: the directory scan stays
// synchronous because it is the cheap part, and both readers share the ordering
// rule, the parsers and the commit-time memo.
//
// `opts` carries the same `gitBin` seam plus `runAsync`, the package convention
// `(bin, argv, cwd) => Promise<{status, stdout, stderr, error}>` a test or host
// injects to simulate a slow or failing git deterministically.
async function listOddDocsAsync(root, opts) {
  const scanned = scanOddDocs(root);
  if (scanned.ok !== true || scanned.docs.length === 0) return scanned;
  return { ok: true, root: scanned.root, docs: orderDocs(scanned.docs, await readGitRecencyAsync(scanned.root, opts)) };
}

// The directory scan both readers share: `<root>/odd/tasks/*.md`, non-recursive,
// regular files only. Documents come back in directory order — the ordering key
// is applied afterwards, so a scan stays pure and repeatable.
function scanOddDocs(root) {
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
    return { ok: false, reason: 'no-checkout', docs: [] };
  }
  let stats = null;
  try {
    stats = fs.statSync(root);
  } catch {
    return { ok: false, reason: 'no-checkout', docs: [] };
  }
  if (!stats.isDirectory()) return { ok: false, reason: 'no-checkout', docs: [] };
  const dir = path.join(root, TASKS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No odd/tasks directory (or an unreadable one): an empty list, not a
    // failure — the view renders its own empty state.
    return { ok: true, root, docs: [] };
  }
  const docs = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      // A directory named `x.md` is not a document; neither is a symlink to
      // one, so a broken or circular link can never enter the list.
      const entry = fs.lstatSync(full);
      if (!entry.isFile()) continue;
    } catch {
      continue;
    }
    docs.push({ name: name.replace(/\.md$/i, ''), file: name, path: full });
  }
  return { ok: true, root, docs };
}

// The ONE ordering rule, applied to a scan: the ordering key stays OUT of the
// row shape, only the sequence changes. `git` is the recency signal, or null —
// which is exactly the documented mtime fallback.
function orderDocs(docs, git) {
  const keyed = docs.map((doc) => ({ doc, modified: modifiedMs(doc, git, readMtime(doc.path)) }));
  keyed.sort(compareByRecency);
  return keyed.map((entry) => entry.doc);
}

// The per-document recency timestamp, applying the documented priority.
function modifiedMs(doc, git, mtime) {
  const commit = git ? git.commit.get(doc.file) : undefined;
  if (commit === undefined) return mtime; // (3) mtime: no commit for this file
  if (!git.local.has(doc.file)) return commit; // (2) clean: the commit decides
  // (1) local edit: never older than the commit it edits.
  if (mtime === null) return commit;
  return Math.max(mtime, commit);
}

// Both git signals in at most three bounded calls, or null when git cannot
// answer at all. The commit-time read is memoized per repository and HEAD
// commit; the local-edit read is not, so it still runs on every listing. A
// `git log` result with no matching record (shallow clone, or a repository
// without history for these documents) is still a usable answer: the files then
// fall back to mtime individually.
function readGitRecency(root, opts) {
  const head = readHeadCommit(root, opts);
  let commit = head === null ? undefined : cachedCommitTimes(root, head);
  if (commit === undefined) {
    const log = runGit(root, LOG_ARGS, opts);
    // A failed walk with no usable memo leaves no commit signal at all: the
    // listing degrades to mtime rather than to a stale order.
    if (log === null) return null;
    commit = parseCommitTimes(log);
    // Only a resolved HEAD may key the memo; an unresolvable one stays uncached.
    if (head !== null) rememberCommitTimes(root, head, commit);
  }
  // A failed status read costs the local-edit signal only: the commit times
  // are still trustworthy, so the listing degrades instead of failing.
  const status = runGit(root, STATUS_ARGS, opts);
  return {
    commit,
    local: status === null ? new Set() : parseLocalChanges(status),
  };
}

// The async twin of `readGitRecency`: the same three bounded reads in the same
// order, over the awaited runner. The memo lookup and the `file name -> commit
// time` map are SHARED with the synchronous reader, so a checkout one reader
// walked is never walked again by the other, and neither can serve an order it
// did not derive from the same HEAD.
async function readGitRecencyAsync(root, opts) {
  const head = headCommitOf(await runGitAsync(root, HEAD_ARGS, opts));
  let commit = head === null ? undefined : cachedCommitTimes(root, head);
  if (commit === undefined) {
    const log = await runGitAsync(root, LOG_ARGS, opts);
    // A failed walk with no usable memo leaves no commit signal at all: the
    // listing degrades to mtime rather than to a stale order.
    if (log === null) return null;
    commit = parseCommitTimes(log);
    // Only a resolved HEAD may key the memo; an unresolvable one stays uncached.
    if (head !== null) rememberCommitTimes(root, head, commit);
  }
  // A failed status read costs the local-edit signal only, exactly as above.
  const status = await runGitAsync(root, STATUS_ARGS, opts);
  return {
    commit,
    local: status === null ? new Set() : parseLocalChanges(status),
  };
}

// The HEAD commit id, or null when git cannot name one (missing binary, no
// repository, an unborn branch, a timeout). It is only ever a memo key, so an
// unexpected value costs a cache miss and never a wrong order.
function readHeadCommit(root, opts) {
  return headCommitOf(runGit(root, HEAD_ARGS, opts));
}

// The one reading of a HEAD probe's stdout, shared by both readers so they can
// never disagree about which commit the memo is keyed by.
function headCommitOf(stdout) {
  if (stdout === null) return null;
  const head = stdout.trim();
  return head.length > 0 ? head : null;
}

function cacheKey(root, head) {
  return `${root}${CACHE_KEY_SEP}${head}`;
}

// A memo hit, refreshed to the young end of the LRU order so a checkout that
// keeps being listed is not the one another checkout's listing evicts.
function cachedCommitTimes(root, head) {
  const key = cacheKey(root, head);
  const times = commitCache.get(key);
  if (times === undefined) return undefined;
  commitCache.delete(key);
  commitCache.set(key, times);
  return times;
}

// Remember a fresh walk. One entry per repository: a new HEAD replaces the
// previous map (the walk was just redone for it) instead of accumulating a
// history of HEADs, and the size stays within COMMIT_CACHE_LIMIT by evicting the
// oldest entry.
function rememberCommitTimes(root, head, times) {
  for (const key of commitCache.keys()) {
    if (key.slice(0, key.lastIndexOf(CACHE_KEY_SEP)) === root) commitCache.delete(key);
  }
  commitCache.set(cacheKey(root, head), times);
  while (commitCache.size > COMMIT_CACHE_LIMIT) {
    const oldest = commitCache.keys().next();
    if (oldest.done) break;
    commitCache.delete(oldest.value);
  }
}

// Read-only diagnostic snapshot of the memo: its bound, how many repositories
// are remembered, and for each the HEAD it is keyed by plus the remembered
// `file name -> commit time` pairs. A copy, so a caller can never mutate the
// memo — and the shape itself is the guarantee that no document CONTENT is ever
// stored, only those timestamps.
function commitCacheInfo() {
  const entries = [];
  for (const [key, times] of commitCache) {
    const separator = key.lastIndexOf(CACHE_KEY_SEP);
    entries.push({
      root: key.slice(0, separator),
      head: key.slice(separator + 1),
      times: [...times].map(([file, ms]) => [file, ms]),
    });
  }
  return { limit: COMMIT_CACHE_LIMIT, size: commitCache.size, entries };
}

// One fixed-argv read. Returns stdout (possibly empty) on success and null on
// any failure — a missing binary, a non-zero exit, a timeout, an unreadable
// repository. Never throws, never writes.
function runGit(root, args, opts) {
  const bin = gitBinOf(opts);
  let result = null;
  try {
    result = spawnSync(bin, [...GIT_CONFIG_ARGS, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      // `git status` must never refresh the index of a read-only listing.
      env: gitEnv(),
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0) return null;
  return typeof result.stdout === 'string' ? result.stdout : '';
}

// The async twin of `runGit` (S21): the same fixed argv, environment and
// timeout, awaited instead of blocking the host event loop, with the identical
// stdout-or-null contract — every failure (a missing binary, a non-zero exit, a
// timeout, an unreadable repository) is `null` instead of a throw.
function runGitAsync(root, args, opts) {
  const bin = gitBinOf(opts);
  let pending = null;
  try {
    pending = asyncRunnerOf(opts)(bin, [...GIT_CONFIG_ARGS, ...args], root);
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

function gitBinOf(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  return typeof options.gitBin === 'string' && options.gitBin.length > 0 ? options.gitBin : 'git';
}

// The environment every listing read runs with: `git status` must never refresh
// the index of a read-only listing, and git must never stop to prompt.
function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

// The awaited runner the async reader uses: the injected one when a test or a
// host supplies it (the package convention `(bin, argv, cwd) => Promise`),
// otherwise the shared bounded async spawn wrapper every interactive path in
// this package already uses — loaded lazily, so a caller that only ever lists
// synchronously never pays for it.
function asyncRunnerOf(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (typeof options.runAsync === 'function') return options.runAsync;
  const worktreeGit = require('./worktree-git.js');
  return (bin, args, cwd) => worktreeGit.runArgvAsync(bin, args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: gitEnv(),
  });
}

// `git log -z --name-only --format=<mark>%ct` walks commits newest first and
// lists each commit's changed paths. The FIRST record seen for a file name is
// therefore its newest commit — which is exactly the timestamp wanted, with no
// per-file process. Records and paths are matched by FILE NAME inside the
// listed `odd/tasks` directory: the listing is non-recursive and the pathspec
// is that same directory, so a name is unambiguous.
function parseCommitTimes(stdout) {
  const times = new Map();
  let current = null;
  for (const token of stdout.split('\0')) {
    if (token.length === 0) continue;
    if (token.charCodeAt(0) === COMMIT_MARK.charCodeAt(0)) {
      const seconds = Number(token.slice(1));
      current = Number.isFinite(seconds) ? seconds * 1000 : null;
      continue;
    }
    if (current === null) continue;
    const name = token.replace(/^\r?\n/, '');
    if (name.length === 0) continue;
    const base = path.basename(name);
    if (base.length === 0 || base === '.' || base === '..') continue;
    if (!times.has(base)) times.set(base, current);
  }
  return times;
}

// `git status --porcelain -z` reports every entry whose working-tree content is
// not what HEAD has (modified, staged, added, untracked). Any such entry means
// the commit no longer describes the file the user is looking at, so the local
// edit signal applies. A rename/copy entry carries its original path as the
// next token, which is consumed so it can never be read as a status line.
function parseLocalChanges(stdout) {
  const local = new Set();
  const tokens = stdout.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry.length < 3) continue;
    const status = entry.slice(0, 2);
    const name = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') index += 1;
    const base = path.basename(name);
    if (base.length > 0) local.add(base);
  }
  return local;
}

// Modification time in ms, or null when it cannot be read.
function readMtime(target) {
  try {
    const stats = fs.statSync(target);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

// Total order: ranked by recency descending, then display name, then raw file
// name — code-unit comparisons only, so the sequence is stable on every host.
// An unrankable document (no timestamp at all) sorts after every ranked one.
function compareByRecency(left, right) {
  const a = left.modified;
  const b = right.modified;
  if (a !== null && b !== null && a !== b) return b - a;
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  if (left.doc.name !== right.doc.name) return left.doc.name < right.doc.name ? -1 : 1;
  if (left.doc.file !== right.doc.file) return left.doc.file < right.doc.file ? -1 : 1;
  return 0;
}

function readOddDoc(doc) {
  const target = doc && typeof doc.path === 'string' ? doc.path : null;
  if (!target) return { ok: false, error: 'no document selected' };
  try {
    const text = fs.readFileSync(target, 'utf8');
    return { ok: true, text };
  } catch (err) {
    const detail = err && err.message ? err.message : 'unreadable';
    return { ok: false, error: detail };
  }
}

module.exports = {
  listOddDocs,
  listOddDocsLocal,
  listOddDocsAsync,
  readOddDoc,
  commitCacheInfo,
  COMMIT_CACHE_LIMIT,
  TASKS_DIR,
};

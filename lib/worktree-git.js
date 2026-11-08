'use strict';
// Shared git plumbing for the worktree tools (P2-S1 foundation).
//
// Every external process is spawned with a fixed argv array — no shell
// string is ever built, so branch names and paths cannot inject commands.
// `listWorktrees` parses `git worktree list --porcelain -z` itself.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Run a binary with a fixed argument vector. Never a shell string.
function runArgv(bin, args, opts = {}) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('runArgv requires an array of string arguments');
  }
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    return { status: null, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error.message };
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: null };
}

// Async twin of `runArgv` for interactive paths: the same fixed argv
// (never a shell string) over `spawn`, with a bounded timeout that
// reaps the owned child instead of blocking the host event loop. Resolves to
// the same `{status, stdout, stderr, error}` shape, so callers can
// `await` either runner interchangeably. `timeoutMs` defaults to
// 120000 like the longest creation pole; pass a smaller bound for
// network CLIs.
//
// Ownership (S63 follow-up): on timeout — or on `opts.signal` abort — the
// runner SIGTERMs the owned process, waits a bounded `killGraceMs` for
// the `close` event, then SIGKILLs and waits the same bound again before
// settling, so settlement never precedes cleanup and the await never hangs
// on a child that ignores signals. On POSIX the child spawns `detached`
// (its own process group, pgid === pid) and the signals go to the whole
// group, so background grandchildren die with it; only the owned pgid is
// ever signaled, never an unrelated process. On win32 group containment is
// unsupported (negative-pid signals do not exist there): only the owned
// child handle is signaled with the same TERM-then-KILL escalation, and a
// grandchild that outlives its parent may survive — that platform limit is
// stated here, not hidden. `opts.env` rides through to spawn; `opts.signal`
// (AbortSignal) produces `{error: 'aborted'}`; without a signal there is no
// cancellation source and none is claimed.
const KILL_GRACE_MS_DEFAULT = 2000;

// Signal ONLY the owned process (or its owned group on POSIX). The group
// path requires the pgid this runner created (child.pid); anything
// unexpected falls back to the direct child handle. Never throws, never
// touches an unrelated pid.
function ownKill(child, sig) {
  try {
    if (child && typeof child.pid === 'number' && child.pid > 0 && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        // ESRCH (already gone) or no group support: fall through to direct.
      }
    }
  } catch {
    // A hostile child object never breaks the cleanup.
  }
  try {
    if (child && typeof child.kill === 'function') child.kill(sig);
  } catch {
    // Killing a dead child never fails the run.
  }
}

function runArgvAsync(bin, args, opts = {}) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    return Promise.reject(new TypeError('runArgvAsync requires an array of string arguments'));
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : 120000;
  const killGraceMs = Number.isFinite(opts.killGraceMs) && opts.killGraceMs > 0
    ? Math.floor(opts.killGraceMs)
    : KILL_GRACE_MS_DEFAULT;
  let spawnFn = opts.spawnFn;
  if (typeof spawnFn !== 'function') {
    try {
      spawnFn = require('node:child_process').spawn;
    } catch (err) {
      return Promise.resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
    }
  }
  const spawnOpts = { cwd: opts.cwd, windowsHide: true };
  if (opts.input !== undefined) spawnOpts.input = opts.input;
  if (opts.env !== undefined) spawnOpts.env = opts.env;
  // POSIX-only new group: group signals stay inside the owned pgid, so a
  // negative-pid kill can never reach our own process group.
  if (process.platform !== 'win32') spawnOpts.detached = true;
  let child;
  try {
    child = spawnFn(bin, args, spawnOpts);
  } catch (err) {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
  }
  if (!child || typeof child.on !== 'function') {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: 'spawn returned nothing usable' });
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let cleaningUp = false;
    let terminalError = null;
    let timer = null;
    let grace = null;
    let reap = null;
    const clearTimers = () => {
      try { if (timer !== null) clearTimeout(timer); } catch { /* a dead timer never fails the run */ }
      try { if (grace !== null) clearTimeout(grace); } catch { /* a dead timer never fails the run */ }
      try { if (reap !== null) clearTimeout(reap); } catch { /* a dead timer never fails the run */ }
    };
    const detachSignal = () => {
      try {
        if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
          opts.signal.removeEventListener('abort', onAbort);
        }
      } catch { /* a hostile signal never fails the run */ }
    };
    const settle = (value) => {
      if (done) return;
      done = true;
      clearTimers();
      detachSignal();
      resolve(value);
    };
    // Second bound: after SIGKILL the run settles even if `close` never
    // fires (an uninterruptible or fake child), so the await cannot hang.
    const startReap = () => {
      reap = setTimeout(() => {
        settle({ status: null, stdout, stderr, error: terminalError });
      }, killGraceMs);
    };
    const beginCleanup = (error) => {
      if (done || cleaningUp) return;
      cleaningUp = true;
      terminalError = error;
      ownKill(child, 'SIGTERM');
      grace = setTimeout(() => {
        if (done) return;
        ownKill(child, 'SIGKILL');
        startReap();
      }, killGraceMs);
    };
    const onAbort = () => {
      beginCleanup('aborted');
    };
    timer = setTimeout(() => {
      beginCleanup(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    try {
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else if (typeof opts.signal.addEventListener === 'function') {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      }
      child.on('error', (err) => {
        if (cleaningUp) {
          settle({ status: null, stdout, stderr, error: terminalError });
          return;
        }
        settle({ status: null, stdout, stderr, error: (err && err.message) || String(err) });
      });
      child.on('close', (code) => {
        // A close during cleanup is the reap: settle the terminal error
        // now instead of waiting out the grace/reap bounds.
        if (cleaningUp) {
          settle({ status: null, stdout, stderr, error: terminalError });
          return;
        }
        settle({ status: code, stdout, stderr, error: null });
      });
    } catch (err) {
      settle({ status: null, stdout, stderr, error: (err && err.message) || String(err) });
    }
  });
}

// Resolve the process runner for an async git read: the caller's injected
// `opts.runAsync` when present, else the shared async runner. `opts.timeoutMs`
// rides through only when it is a positive finite number, so an unset timeout
// keeps the runner's own default instead of becoming `undefined`.
function asyncRunner(opts = {}) {
  if (typeof opts.runAsync === 'function') return opts.runAsync;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
  return (bin, args, cwd) => runArgvAsync(bin, args, { cwd, timeoutMs });
}

// The exported sync reader is a DOCUMENTED seam: tests replace it to simulate
// identities and listings git would never emit (the same reason
// `isPathInAnyCheckout` reads `module.exports.listWorktrees` instead of the
// internal name). The async twins honor that seam too, so a test that stubs
// the sync reader keeps describing the world the async path sees — the two
// readers can never disagree about a simulated repository.
function overriddenSyncTwin(name, own) {
  try {
    const exported = module.exports[name];
    return typeof exported === 'function' && exported !== own ? exported : null;
  } catch {
    return null;
  }
}

// Identify the repository containing repoRoot.
// Returns {root, commonDir, repoName, parentDir}; throws when repoRoot is
// not inside a git repository (a programmer error, never user input).
function repoIdentity(repoRoot) {
  const top = runArgv('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (top.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const root = path.resolve(top.stdout.trim());
  const common = runArgv('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot });
  if (common.status !== 0) throw new Error(`cannot resolve git common dir: ${repoRoot}`);
  return finishRepoIdentity(repoRoot, root, common);
}

// The resolution shared by the sync and async readers, so both spell the
// common dir identically (see the realpath note below).
function finishRepoIdentity(repoRoot, root, common) {
  const rawCommon = common.stdout.trim();
  // --git-common-dir prints a path relative to the git invocation's own cwd
  // (`.git` at the repository root, `../.git` from one level below), and
  // that cwd may be a symlinked spelling of the real directory. Resolve
  // against its realpath: a lexical base turns `../.git` seen through a
  // symlink into the symlink's parent, and the toplevel is the wrong base
  // outright for a subdirectory (`../.git` there names the repo's parent).
  let base = repoRoot;
  try {
    base = fs.realpathSync(repoRoot);
  } catch {
    // git already ran, so an unreadable cwd keeps the lexical base.
  }
  const commonDir = path.isAbsolute(rawCommon) ? path.normalize(rawCommon) : path.resolve(base, rawCommon);
  // The answer is now known, so hand it to the shared `commonDirFor` memo in
  // BOTH spellings (the caller's path and git's toplevel): a synchronous
  // caller that runs after an identity read — the registry store and the
  // change summary, which cannot await — then reads it instead of spawning
  // its own pair of `git rev-parse` probes (worktree-issues S11).
  rememberCommonDir(repoRoot, commonDir);
  rememberCommonDir(root, commonDir);
  return { root, commonDir, repoName: path.basename(root), parentDir: path.dirname(root) };
}

// Async twin of `repoIdentity` for interactive paths: the same two fixed
// argv reads and the same resolution, awaited instead of blocking the host
// event loop. Rejects with the identical messages, so the two are
// interchangeable to a caller that can await.
async function repoIdentityAsync(repoRoot, opts = {}) {
  const seam = overriddenSyncTwin('repoIdentity', repoIdentity);
  if (seam !== null) return seam(repoRoot);
  const runAsync = asyncRunner(opts);
  const top = await runAsync('git', ['rev-parse', '--show-toplevel'], repoRoot);
  if (!top || top.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const root = path.resolve(String(top.stdout || '').trim());
  const common = await runAsync('git', ['rev-parse', '--git-common-dir'], repoRoot);
  if (!common || common.status !== 0) throw new Error(`cannot resolve git common dir: ${repoRoot}`);
  return finishRepoIdentity(repoRoot, root, common);
}

// S22 (round 3): the shared git common dir of a checkout.
//
// Every registry read/write and every warp-session read used to call
// `repoIdentity`, i.e. two `spawnSync` git probes (~19 ms here) — several
// times per tool event and per repaint once the callers are added up. The
// answer is stable for a checkout inside one process, so it is resolved once
// and shared by every lib that needs the directory. Bounded and
// most-recently-used: an interactive session touches a handful of checkouts,
// and re-inserting on a hit keeps the one in use out of the evicted tail.
const COMMON_DIR_CACHE_LIMIT = 64;
const commonDirCache = new Map();

// Record an ALREADY RESOLVED common dir under one spelling of its repository.
// Bounded and most-recently-used exactly like `commonDirFor`'s own inserts, so
// an async identity read can warm the memo without a second cache or a second
// eviction rule. Never throws: a spelling that cannot be resolved is simply
// not remembered, and the caller that needs it spawns git as it always did.
function rememberCommonDir(spelling, commonDir) {
  if (typeof spelling !== 'string' || spelling.length === 0) return;
  if (typeof commonDir !== 'string' || commonDir.length === 0) return;
  let key;
  try {
    key = path.resolve(spelling);
  } catch {
    return;
  }
  commonDirCache.delete(key);
  commonDirCache.set(key, commonDir);
  if (commonDirCache.size > COMMON_DIR_CACHE_LIMIT) {
    const oldest = commonDirCache.keys().next();
    if (!oldest.done) commonDirCache.delete(oldest.value);
  }
}

function commonDirFor(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    // Never cache a caller-supplied nonsense key: resolve and fail like
    // `repoIdentity` does, so the error stays the caller's to handle.
    return repoIdentity(repoRoot).commonDir;
  }
  const key = path.resolve(repoRoot);
  const hit = commonDirCache.get(key);
  if (hit !== undefined) {
    commonDirCache.delete(key);
    commonDirCache.set(key, hit);
    return hit;
  }
  const { commonDir } = repoIdentity(repoRoot);
  commonDirCache.set(key, commonDir);
  if (commonDirCache.size > COMMON_DIR_CACHE_LIMIT) {
    const oldest = commonDirCache.keys().next();
    if (!oldest.done) commonDirCache.delete(oldest.value);
  }
  return commonDir;
}

// Forget every resolved common dir: for a test that builds a fresh
// repository at the same path, or a long-lived process that moved a checkout.
function resetCommonDirCache() {
  commonDirCache.clear();
}

// Flatten a branch name into a single path component, exactly like the
// AGENTS.md rule: lowercase, runs of non-alphanumerics collapse to one
// `-`, leading/trailing dashes trimmed, `worktree` when nothing survives.
function slugifyBranch(branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'worktree' : slug;
}

// Absolute target path for a branch: <repo-parent>/<repo-name>-worktrees/<slug>.
function worktreePath(repoRoot, branch) {
  return worktreePathOf(repoIdentity(repoRoot), branch);
}

// The pure layout of `worktreePath` over an identity already read, so an
// interactive caller that awaited `repoIdentityAsync` reuses that one read
// instead of spawning git again.
function worktreePathOf(identity, branch) {
  return path.join(identity.parentDir, `${identity.repoName}-worktrees`, slugifyBranch(branch));
}

// The PRINCIPAL checkout of the repository containing repoRoot: the
// checkout that owns the shared git common dir. For a linked worktree
// `git rev-parse --git-common-dir` resolves (through the realpath-aware
// base in repoIdentity) to `<principal>/.git`, so the principal is its
// dirname — no branch-name assumption (`main`, `master`, anything) is
// ever consulted. For the principal itself this is its own root, and
// for anything unresolvable it falls back to the toplevel: callers
// always get a usable directory, never a throw.
function principalRoot(repoRoot) {
  let identity;
  try {
    identity = repoIdentity(repoRoot);
  } catch {
    return repoRoot;
  }
  try {
    if (typeof identity.commonDir === 'string' && path.basename(identity.commonDir) === '.git') {
      const candidate = path.resolve(path.dirname(identity.commonDir));
      return candidate;
    }
  } catch {
    // Fall through to the toplevel below.
  }
  return identity.root;
}

// Canonical target path for a branch: the SAME sibling layout as
// worktreePath, but ALWAYS derived from the principal checkout's
// parent/name — even when the caller runs inside a linked worktree
// (where worktreePath would nest `<worktree>-worktrees/` inside the
// calling checkout). The branch HEAD still comes from the CURRENT
// checkout (creation never changes its base); only the directory
// layout is principal-anchored.
function canonicalWorktreePath(repoRoot, branch) {
  const principal = principalRoot(repoRoot);
  return path.join(path.dirname(principal), `${path.basename(principal)}-worktrees`, slugifyBranch(branch));
}

// The pure layout of `canonicalWorktreePath` over an identity already read:
// the principal is recovered from the shared common dir, and anything else
// (a common dir that is not `<principal>/.git`) falls back to the toplevel,
// exactly like `principalRoot`.
function canonicalWorktreePathOf(identity, branch) {
  const principal = typeof identity.commonDir === 'string' && path.basename(identity.commonDir) === '.git'
    ? path.resolve(path.dirname(identity.commonDir))
    : identity.root;
  return path.join(path.dirname(principal), `${path.basename(principal)}-worktrees`, slugifyBranch(branch));
}

// Unicode bidi control marks that can visually reorder a branch name.
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u2028\u2029]/;

// Validate a branch name. Uses `git check-ref-format --branch` as the
// authority, after rejecting empty names, a leading `-`, whitespace,
// control characters and Unicode bidi marks up front (fail closed).
function validateBranch(name) {
  const refused = refuseMalformedBranch(name);
  if (refused !== null) return refused;
  const checked = runArgv('git', ['check-ref-format', '--branch', name], {});
  if (checked.status !== 0) return { ok: false, reason: `invalid branch name: ${name}` };
  return { ok: true, reason: null };
}

// The pure half of `validateBranch`: every rejection that needs no child.
// Returns the refusal, or null when git still has to answer.
function refuseMalformedBranch(name) {
  if (typeof name !== 'string' || name === '') return { ok: false, reason: 'branch name is empty' };
  if (name.startsWith('-')) return { ok: false, reason: 'branch name must not start with `-`' };
  if (/\s/.test(name)) return { ok: false, reason: 'branch name must not contain whitespace' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(name)) return { ok: false, reason: 'branch name must not contain control characters' };
  if (BIDI_RE.test(name)) return { ok: false, reason: 'branch name must not contain Unicode bidi marks' };
  return null;
}

// Async twin of `validateBranch` for interactive paths: the same refusals in
// the same order, the same `git check-ref-format --branch` authority and the
// same reason strings — only the check-ref-format wait is non-blocking.
async function validateBranchAsync(name, opts = {}) {
  const refused = refuseMalformedBranch(name);
  if (refused !== null) return refused;
  const seam = overriddenSyncTwin('validateBranch', validateBranch);
  if (seam !== null) return seam(name);
  const runAsync = asyncRunner(opts);
  const checked = await runAsync('git', ['check-ref-format', '--branch', name], undefined);
  if (!checked || checked.status !== 0) return { ok: false, reason: `invalid branch name: ${name}` };
  return { ok: true, reason: null };
}

// List every checkout from `git worktree list --porcelain -z`.
// Returns [{path, branch, head, detached, bare}]; branch is null when detached.
function listWorktrees(repoRoot) {
  const listed = runArgv('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repoRoot });
  if (listed.status !== 0) throw new Error(`git worktree list failed: ${(listed.stderr || '').trim()}`);
  return parseWorktreeList(listed.stdout);
}

// Async twin of `listWorktrees` for interactive paths: the same fixed argv and
// the SAME parser, over the async runner, so listing a repository never blocks
// the host event loop. Resolves to the identical entries and rejects with the
// identical message on failure, so the two are interchangeable to a caller
// that can await. The sync API stays for the callers that cannot.
// `opts.runAsync` is the sibling convention `(bin, args, cwd) => Promise`.
async function listWorktreesAsync(repoRoot, opts = {}) {
  const seam = overriddenSyncTwin('listWorktrees', listWorktrees);
  if (seam !== null) return seam(repoRoot);
  const runAsync = typeof opts.runAsync === 'function'
    ? opts.runAsync
    : (bin, args, cwd) => runArgvAsync(bin, args, { cwd, timeoutMs: opts.timeoutMs });
  const listed = await runAsync('git', ['worktree', 'list', '--porcelain', '-z'], repoRoot);
  if (!listed || listed.status !== 0) {
    const stderr = listed && typeof listed.stderr === 'string' ? listed.stderr : '';
    throw new Error(`git worktree list failed: ${stderr.trim()}`);
  }
  return parseWorktreeList(listed.stdout);
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// True when the resolved target is the path of, or inside, any existing
// checkout — or inside the shared git common dir. Used to refuse targets
// that would nest checkouts or clobber repository metadata. Only a LIVE
// checkout blocks: a git record whose path no longer exists as a
// directory never refuses a create (the create path prunes such stale
// records first). Relative listing paths resolve against the repository
// root, never the process cwd.
function isPathInAnyCheckout(repoRoot, target) {
  const identity = repoIdentity(repoRoot);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(identity.root, target);
  // Through the export so tests can simulate listings git would never
  // emit (notably relative paths); production behavior is unchanged.
  const entries = module.exports.listWorktrees(repoRoot);
  return matchesAnyCheckout(identity, resolved, entries);
}

// Async twin of `isPathInAnyCheckout` for interactive paths: the same
// identity read, the same listing (awaited) and the SAME matcher, so a
// create refuses exactly the same targets. `opts.runAsync` is the sibling
// convention `(bin, args, cwd) => Promise`; `opts.list` lets a caller reuse
// a listing it already awaited.
async function isPathInAnyCheckoutAsync(repoRoot, target, opts = {}) {
  const runAsync = asyncRunner(opts);
  const identity = opts.identity !== undefined
    ? opts.identity
    : await repoIdentityAsync(repoRoot, { runAsync });
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(identity.root, target);
  const entries = Array.isArray(opts.listed)
    ? opts.listed
    : await listWorktreesAsync(repoRoot, { runAsync });
  return matchesAnyCheckout(identity, resolved, entries);
}

// The single inside-verdict shared by the sync and async readers.
function matchesAnyCheckout(identity, resolved, entries) {
  if (isInsideOrEqual(identity.commonDir, resolved)) return true;
  // One liveness predicate (exists AND is-a-directory, never the process
  // cwd) plus realpath identity: a symlink spelling of a checkout is the
  // same checkout, so inside-verdicts compare both spellings and realpaths
  // (resolving non-existent tails through their parents, so a not-yet-
  // created subpath through a symlink still matches).
  const realish = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      // Walk up to the nearest existing ancestor, resolve it, re-append.
      let cur = p;
      const tail = [];
      for (let i = 0; i < 32; i += 1) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        tail.unshift(path.basename(cur));
        cur = parent;
        try {
          return path.join(fs.realpathSync(cur), ...tail);
        } catch {
          continue;
        }
      }
      return null;
    }
  };
  const resolvedReal = realish(resolved);
  for (const entry of entries || []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const base = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(identity.root, entry.path);
    let live = false;
    try {
      live = fs.statSync(base).isDirectory();
    } catch {
      live = false;
    }
    if (!live) continue;
    if (isInsideOrEqual(base, resolved)) return true;
    // Realpath identity: the same checkout reached through a symlink must
    // give the same verdict as its real spelling.
    const baseReal = realish(base);
    if (baseReal !== null && resolvedReal !== null && isInsideOrEqual(baseReal, resolvedReal)) return true;
    if (baseReal !== null && baseReal === resolved) return true;
    if (resolvedReal !== null && resolvedReal === base) return true;
  }
  return false;
}



// ---------------------------------------------------------------------
// Commits ahead of / behind a base branch (warp-popup W1).
//
// Nothing else in the repository computes this. The answer is one fixed
// argv call — `git rev-list --left-right --count <base>...HEAD` — whose
// output is `<behind>\t<ahead>`: the left side is what the base has and
// HEAD does not, the right side is what HEAD has and the base does not.
//
// The base is RESOLVED, never assumed: `main` first, then the other
// conventional names, then the branch the principal checkout has checked
// out (git documents that `git worktree list` prints the main worktree
// first, so no branch-name guess is needed), then the conventional
// remote-tracking names. The chosen base rides back in the result, so no
// caller has to re-derive it and nothing is guessed silently. With no
// resolvable base the call fails loudly instead of inventing one; an
// explicitly requested base that does not exist fails the same way.
//
// Every git read goes through `runAsync` (default: the async runner) so a
// repainting caller never blocks on a spawn, and every failure path —
// bad path, not a repository, unparsable output — RESOLVES to
// `{ok:false, error}` instead of throwing.
const BASE_CANDIDATES = [
  { name: 'main', source: 'conventional' },
  { name: 'master', source: 'conventional' },
  { name: 'trunk', source: 'conventional' },
  { name: 'develop', source: 'conventional' },
  { name: 'development', source: 'conventional' },
  { name: 'origin/main', source: 'remote' },
  { name: 'origin/master', source: 'remote' },
  { name: 'origin/trunk', source: 'remote' },
  { name: 'origin/develop', source: 'remote' },
];

// A ref name that is safe as ONE argv element (injection is already
// impossible with a fixed argv; this only rules out a value git would
// reparse, such as a leading `-` flag or a revision expression).
function isPlainRefName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('-')) return false;
  if (/\s/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(name)) return false;
  if (BIDI_RE.test(name)) return false;
  return true;
}

// `<behind>\t<ahead>` -> {behind, ahead}; anything else is unreadable.
function parseAheadBehindCounts(stdout) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(stdout || ''));
  if (!match) return null;
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

// First line of a failed git result, for error strings that stay short.
function gitFailureReason(result) {
  const stderr = result && typeof result.stderr === 'string' ? result.stderr.trim() : '';
  if (stderr.length > 0) return stderr.split('\n')[0];
  if (result && result.error) return result.error;
  return `exit ${result ? result.status : 'unknown'}`;
}

// Compare the checkout at `checkoutPath` against a base branch.
// Resolves to {ok:true, ahead, behind, base, baseSource}, or
// {ok:false, error}. Options: `base` (explicit branch name), `runAsync`
// (injected `(bin, args, cwd) -> Promise<{status, stdout, stderr, error}>`),
// `timeoutMs`, and `principalBranch`.
//
// `principalBranch` is the branch the principal checkout has checked out, for
// a caller that ALREADY read the repository listing (`git worktree list`) —
// the warp selector's facts read does, to answer the branch of every row. A
// string reuses that answer; `null` states "the listing names no principal
// branch" (a detached or bare principal); omitting it (the default) reads the
// listing itself. Either way the same candidate order runs, so the base and
// its `baseSource` are what this function always answered; only the second
// listing — one child process per checkout — is skipped.
async function aheadBehind(checkoutPath, opts = {}) {
  try {
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
      return { ok: false, error: 'checkout path is empty' };
    }
    const checkout = path.resolve(checkoutPath);
    const runAsync = typeof opts.runAsync === 'function'
      ? opts.runAsync
      : (bin, args, cwd) => runArgvAsync(bin, args, { cwd, timeoutMs: opts.timeoutMs });

    // One read of every local and remote-tracking ref name: the set is
    // what makes resolution a lookup instead of a probe per candidate.
    const refs = await runAsync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], checkout);
    if (!refs || refs.status !== 0) {
      return { ok: false, error: `cannot list branches in ${checkout}: ${gitFailureReason(refs)}` };
    }
    const names = new Set(
      String(refs.stdout || '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    );

    let base = null;
    let baseSource = null;
    if (opts.base !== undefined) {
      if (!isPlainRefName(opts.base)) {
        return { ok: false, error: `invalid base branch: ${JSON.stringify(opts.base)}` };
      }
      if (!names.has(opts.base)) return { ok: false, error: `base branch not found: ${opts.base}` };
      base = opts.base;
      baseSource = 'explicit';
    } else {
      // Candidate order: conventions, then the repository's own answer
      // (the principal checkout's branch), then remote-tracking names. The
      // principal's branch comes from the listing the CALLER already read
      // when it supplies one, so this path spawns no second listing.
      const principal = opts.principalBranch !== undefined
        ? (typeof opts.principalBranch === 'string' && opts.principalBranch.length > 0
          ? opts.principalBranch
          : null)
        : await principalBranchOf(checkout, runAsync);
      const ordered = [BASE_CANDIDATES[0], BASE_CANDIDATES[1]];
      if (principal !== null) ordered.push({ name: principal, source: 'principal' });
      ordered.push(...BASE_CANDIDATES.slice(2));
      for (const candidate of ordered) {
        if (!names.has(candidate.name)) continue;
        base = candidate.name;
        baseSource = candidate.source;
        break;
      }
      if (base === null) {
        return { ok: false, error: `no base branch to compare with in ${checkout} (looked for ${BASE_CANDIDATES.map((entry) => entry.name).join(', ')} and the principal checkout's branch)` };
      }
    }

    const counts = await runAsync('git', ['rev-list', '--left-right', '--count', `${base}...HEAD`], checkout);
    if (!counts || counts.status !== 0) {
      return { ok: false, error: `cannot compare with ${base} in ${checkout}: ${gitFailureReason(counts)}` };
    }
    const parsed = parseAheadBehindCounts(counts.stdout);
    if (parsed === null) {
      return { ok: false, error: `unreadable ahead/behind output for ${checkout}: ${JSON.stringify(String(counts.stdout || '').trim())}` };
    }
    return { ok: true, ahead: parsed.ahead, behind: parsed.behind, base, baseSource };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ---------------------------------------------------------------------
// Last commit timestamp of a checkout (warp-popup W7 — S12).
//
// One fixed argv read — `git log -1 --format=%ct HEAD` — the committer
// timestamp in whole seconds. Kept a SEPARATE export from `aheadBehind` so
// a caller that only needs recency pays for one spawn, never the ref
// listing plus the rev-list comparison.
//
// Every failure path RESOLVES to `{ok:false, error}` instead of throwing,
// exactly like `aheadBehind`.
async function lastCommitTime(checkoutPath, opts = {}) {
  try {
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
      return { ok: false, error: 'checkout path is empty' };
    }
    const checkout = path.resolve(checkoutPath);
    const runAsync = typeof opts.runAsync === 'function'
      ? opts.runAsync
      : (bin, args, cwd) => runArgvAsync(bin, args, { cwd, timeoutMs: opts.timeoutMs });
    const log = await runAsync('git', ['log', '-1', '--format=%ct', 'HEAD'], checkout);
    if (!log || log.status !== 0) {
      return { ok: false, error: `cannot read the last commit in ${checkout}: ${gitFailureReason(log)}` };
    }
    const seconds = Number(String(log.stdout || '').trim());
    if (!Number.isFinite(seconds)) {
      return { ok: false, error: `unreadable last-commit output for ${checkout}: ${JSON.stringify(String(log.stdout || '').trim())}` };
    }
    const timestampMs = seconds * 1000;
    return { ok: true, timestampMs, committedAt: new Date(timestampMs).toISOString() };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ---------------------------------------------------------------------
// Oldest root commit timestamp of a checkout (worktree UI S12).
//
// "When the project's git history began" is the only beginning git
// records: the commit(s) with no parent. One fixed argv read —
// `git log --max-parents=0 --format=%ct HEAD` — prints the committer
// timestamp (whole seconds) of EVERY root commit reachable from HEAD, so a
// history with several independent roots yields several lines. The MINIMUM
// is the answer, which makes it deterministic without depending on the
// order git happens to print them in.
//
// Kept a SEPARATE export from `lastCommitTime` so a caller that does not
// need the beginning pays for no extra spawn, and every failure path — not
// a repository, no commit yet, unparsable output — RESOLVES to
// `{ok:false, error}` instead of throwing, exactly like its siblings.
async function firstCommitTime(checkoutPath, opts = {}) {
  try {
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
      return { ok: false, error: 'checkout path is empty' };
    }
    const checkout = path.resolve(checkoutPath);
    const runAsync = typeof opts.runAsync === 'function'
      ? opts.runAsync
      : (bin, args, cwd) => runArgvAsync(bin, args, { cwd, timeoutMs: opts.timeoutMs });
    const log = await runAsync('git', ['log', '--max-parents=0', '--format=%ct', 'HEAD'], checkout);
    if (!log || log.status !== 0) {
      return { ok: false, error: `cannot read the first commit in ${checkout}: ${gitFailureReason(log)}` };
    }
    const raw = String(log.stdout || '').trim();
    const seconds = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (seconds.length === 0) {
      return { ok: false, error: `unreadable first-commit output for ${checkout}: ${JSON.stringify(raw)}` };
    }
    const earliest = Math.min(...seconds);
    const timestampMs = earliest * 1000;
    return { ok: true, timestampMs, committedAt: new Date(timestampMs).toISOString(), rootCount: seconds.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Branch checked out in the PRINCIPAL checkout, read from the listing
// git prints with the main worktree first. Null when that entry is bare,
// detached or unreadable — a missing principal branch is not an error.
async function principalBranchOf(checkout, runAsync) {
  const listed = await runAsync('git', ['worktree', 'list', '--porcelain', '-z'], checkout);
  if (!listed || listed.status !== 0) return null;
  const entries = parseWorktreeList(listed.stdout);
  if (entries.length === 0) return null;
  const principal = entries[0];
  return typeof principal.branch === 'string' && principal.branch.length > 0 ? principal.branch : null;
}

// Parse `git worktree list --porcelain -z` output. Split out from
// `listWorktrees` so the async paths reuse the exact same parsing.
function parseWorktreeList(stdout) {
  // With -z every line is NUL-terminated; a blank token ends a record.
  const tokens = String(stdout || '').split('\0');
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && current.path) entries.push(current);
    current = null;
  };
  for (const token of tokens) {
    if (token === '') {
      flush();
      continue;
    }
    if (token.startsWith('worktree ')) {
      flush();
      current = { path: token.slice('worktree '.length), branch: null, head: null, detached: false, bare: false };
    } else if (current && token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length);
    } else if (current && token.startsWith('branch ')) {
      const ref = token.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (current && token === 'detached') {
      current.detached = true;
    } else if (current && token === 'bare') {
      current.bare = true;
    }
    // `locked` / `prunable` tokens carry no identity and are ignored.
  }
  flush();
  return entries;
}

module.exports = {
  runArgv,
  aheadBehind,
  lastCommitTime,
  firstCommitTime,
  runArgvAsync,
  repoIdentity,
  repoIdentityAsync,
  commonDirFor,
  resetCommonDirCache,
  slugifyBranch,
  worktreePath,
  worktreePathOf,
  principalRoot,
  canonicalWorktreePath,
  canonicalWorktreePathOf,
  validateBranch,
  validateBranchAsync,
  listWorktrees,
  listWorktreesAsync,
  isPathInAnyCheckout,
  isPathInAnyCheckoutAsync,
};

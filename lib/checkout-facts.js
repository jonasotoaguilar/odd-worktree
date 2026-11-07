'use strict';
// Focused-checkout facts for the warp selector (warp-popup W1 — S2, S4, S9).
//
// One call yields everything the selector's footer shows for ONE checkout:
// the branch, when the checkout was created, its last activity, its
// uncommitted-change summary (the file count plus the added/deleted LINE
// counts of the tracked diff and of every untracked file, S16), and the
// commits it is ahead of / behind a base branch. S1: a worktree no longer
// receives issues or ODD documents, so the payload carries NO association
// field at all. Legacy registry rows still store `issues` and `odd`; that data
// is preserved untouched (never migrated, never erased) and is simply never
// read here. The row is still read for the ONE fact it legitimately owns — a
// linked worktree's `createdAt` (S12).
//
// Each fact is its own envelope — `{available:true, value, reason:null}` or
// `{available:false, value:null, reason}` — because S9 forbids rendering an
// unreadable value as a number. A failing git read, a missing registry row
// or a malformed registry is therefore "unavailable", never zero and never
// an empty list. Facts fail independently: a broken registry leaves the git
// facts intact and vice versa. Two facts are about TIME, and what they answer
// depends on the KIND of checkout (S12) rather than on one rule for all: the
// PRINCIPAL is the checkout git lists first, so its `createdAt` is when its
// git history began (the oldest root commit, `source:'root-commit'`), while a
// linked worktree reports when THAT checkout was created — its registry row's
// `createdAt` (`source:'registry'`) or, when that is missing or unreadable,
// the directory's birth time (`source:'birthtime'`). `lastActivity` is the
// winning side of `last commit` vs `newest uncommitted file` for either kind
// (S12), and S8 adds its provenance: an inherited commit older than the
// checkout's own creation is not local modification and is dropped, while a
// later commit or a dirty mtime stays honest. A checkout whose kind cannot be
// established is never treated as the principal, so git's beginning is never
// claimed without evidence.
//
// Cost control (S9 again): the expensive reads — `summarizeChanges` spawns
// two git processes, ahead/behind spawns up to two more, the last-commit
// read one, and the oldest-root-commit read one more but ONLY for the
// principal — only ever run for the checkout the caller names, and the whole
// per-path result is cached for `ttlMs`, so a selector that repaints per
// keystroke does not re-spawn git. The dirty summary is computed once and
// feeds both `changes` and the dirty side of `lastActivity`; the birth-time
// fallback is only stat'ed for a linked worktree with no usable registry row.
// Concurrent callers for the same path share one in-flight read. `facts()`
// is async (the git work is awaited, never spawned inline) and `peek()`
// answers from the cache synchronously at paint time.
//
// Reuse, not duplication: the dirty summary comes from
// lib/worktree-changes.js, the registry row from lib/worktree-registry.js,
// the branch from `listWorktrees`, and the comparison from
// lib/worktree-git.js's `aheadBehind`. The registry file read is local and
// network-free; every net-capable or heavier read, the repository listing
// included, is async so it never blocks the host event loop.

const path = require('node:path');
const fs = require('node:fs');

const gitLib = require('./worktree-git.js');
const changesLib = require('./worktree-changes.js');
const registryLib = require('./worktree-registry.js');

const DEFAULT_TTL_MS = 5000;

function available(value) {
  return { available: true, value, reason: null };
}

function unavailable(reason) {
  const text = typeof reason === 'string' && reason.length > 0 ? reason : 'unavailable';
  return { available: false, value: null, reason: text };
}

function errorText(err) {
  return (err && err.message) || String(err);
}

// Awaits a seam that may be sync or async and never lets a rejection escape.
async function attempt(fn, label) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: `${label}: ${errorText(err)}` };
  }
}

// Build a facts provider for one repository.
//
// Options (every seam is injectable so tests and hosts can substitute it):
//   repoRoot        repository whose registry and worktree listing are read
//   readRegistry    (repoRoot) -> {ok, worktrees, error}
//   listWorktrees   (repoRoot) -> [{path, branch, detached}] or a promise of
//                   the same; the default is the async repository listing
//   summarize       (checkoutPath) -> Promise<summary> (worktree-changes shape)
//   aheadBehind     (checkoutPath) -> Promise<{ok, ahead, behind, base}>
//   lastCommit      (checkoutPath) -> Promise<{ok, timestampMs}> (git log -1)
//   firstCommit     (checkoutPath) -> Promise<{ok, timestampMs}> (oldest root commit)
//   repoIdentity    (checkoutPath) -> identity or a promise of one; the
//                   default is the async `repoIdentityAsync`
//   fs              fs seam for the createdAt birth-time fallback (statSync)
//   runAsync        git runner forwarded to the default git seams
//   ttlMs           cache lifetime in ms (default 5000)
//   now             clock in ms (default Date.now)
function createCheckoutFacts(opts = {}) {
  const repoRoot = typeof opts.repoRoot === 'string' && opts.repoRoot.length > 0 ? opts.repoRoot : null;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const runAsync = typeof opts.runAsync === 'function' ? opts.runAsync : null;
  const fsImpl = opts.fs && typeof opts.fs.statSync === 'function' ? opts.fs : fs;

  const readRegistry = typeof opts.readRegistry === 'function'
    ? opts.readRegistry
    : (root) => registryLib.readRegistry(root);
  const listWorktrees = typeof opts.listWorktrees === 'function'
    ? opts.listWorktrees
    : (root) => gitLib.listWorktreesAsync(root, runAsync ? { runAsync } : {});
  const summarize = typeof opts.summarize === 'function'
    ? opts.summarize
    : (checkout) => summarizeWithIdentity(checkout);
  const aheadBehind = typeof opts.aheadBehind === 'function' ? opts.aheadBehind : null;
  const lastCommit = typeof opts.lastCommit === 'function'
    ? opts.lastCommit
    : (checkout) => gitLib.lastCommitTime(checkout, runAsync ? { runAsync } : {});
  const firstCommit = typeof opts.firstCommit === 'function'
    ? opts.firstCommit
    : (checkout) => gitLib.firstCommitTime(checkout, runAsync ? { runAsync } : {});
  const repoIdentity = typeof opts.repoIdentity === 'function' ? opts.repoIdentity : null;

  // Repository identity of ONE checkout, resolved through the ASYNC twin
  // (worktree-issues S11). `summarizeChanges` resolves the repository root
  // itself, and it can only do that synchronously — `git rev-parse
  // --show-toplevel` plus `--git-common-dir` through `spawnSync`, i.e. two
  // children that freeze the host for their whole lifetime, per checkout. The
  // selector loads every row's facts at once, so N checkouts froze the host N
  // times over while the panel was merely reading. The answer here is the same
  // one, and it is read before `summarizeChanges` runs, so the identity is
  // handed to it instead of re-spawned.
  function identityFor(checkout) {
    const read = repoIdentity !== null
      ? () => repoIdentity(checkout)
      : () => gitLib.repoIdentityAsync(checkout, runAsync ? { runAsync } : {});
    // A read that fails is NOT reported here: it falls through to the shared
    // reader inside `summarizeChanges`, which produces its own verdict and its
    // own message, exactly as before this read existed.
    return Promise.resolve().then(read).catch(() => null);
  }

  // The `git` seam `summarizeChanges` takes: the identity already read, for the
  // path it was read for, and the shared synchronous reader otherwise (a
  // spelling this read did not answer for), so correctness never depends on
  // the pass-through.
  function identitySeam(identity) {
    let resolved = null;
    try {
      resolved = identity && typeof identity.root === 'string' ? path.resolve(identity.root) : null;
    } catch {
      resolved = null;
    }
    return {
      ...gitLib,
      repoIdentity: (target) => {
        try {
          if (resolved !== null && typeof target === 'string' && path.resolve(target) === resolved) return identity;
        } catch {
          // A path that cannot be resolved falls through to the shared reader.
        }
        return gitLib.repoIdentity(target);
      },
    };
  }

  async function summarizeWithIdentity(checkout) {
    const identity = await identityFor(checkout);
    const options = { git: identitySeam(identity) };
    if (runAsync) options.runAsync = runAsync;
    return changesLib.summarizeChanges(checkout, options);
  }

  const cache = new Map(); // absolute checkout path -> {at, facts}
  const inFlight = new Map(); // absolute checkout path -> Promise<facts>
  const listingInFlight = new Map(); // repository root -> Promise<listing entries>

  // Absolute spelling used as the cache key and reported back to the
  // caller; an unusable input stays as the caller wrote it.
  function keyOf(checkoutPath) {
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) return null;
    return path.resolve(checkoutPath);
  }

  // Two spellings of one checkout are the same checkout: the resolved paths
  // first, then the realpaths (a listing may name a symlinked checkout).
  function sameCheckout(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
    if (path.resolve(a) === path.resolve(b)) return true;
    if (typeof fsImpl.realpathSync !== 'function') return false;
    try {
      return fsImpl.realpathSync(a) === fsImpl.realpathSync(b);
    } catch {
      return false;
    }
  }

  // Which KIND of checkout this is (S12). The PRINCIPAL is the one git lists
  // FIRST — `git worktree list` documents the main worktree first — never the
  // calling checkout and never a branch name, so the answer does not depend on
  // where the session runs or on `main`/`master` being called that. A listing
  // that cannot be read leaves the kind unknown, and an unknown kind never
  // claims principal semantics.
  function isPrincipalCheckout(checkout, listing) {
    if (!listing || listing.ok !== true) return false;
    const entries = Array.isArray(listing.value) ? listing.value : [];
    const first = entries[0];
    return Boolean(first) && sameCheckout(first.path, checkout);
  }

  // The listing entry for exactly this checkout (resolve-equality, the
  // same rule the registry's findByPath uses). Unavailable when the
  // listing fails or the path is not a checkout git knows about.
  function branchFact(checkout, listed) {
    if (!listed.ok) return unavailable(listed.error);
    const entries = Array.isArray(listed.value) ? listed.value : [];
    const entry = entries.find((candidate) => candidate && typeof candidate.path === 'string'
      && path.isAbsolute(candidate.path)
      && path.resolve(candidate.path) === checkout);
    if (!entry) return unavailable(`not a known checkout: ${checkout}`);
    // A detached HEAD has no branch name; saying "detached" is honest,
    // inventing a name is not.
    return { ...available(entry.branch), detached: entry.detached === true };
  }

  // Registry row for this checkout — read ONLY for the one fact it owns, a
  // linked worktree's `createdAt`. `ok:false` (malformed/unreadable registry)
  // and "no row" are different reasons but the same verdict: that creation
  // has no registry answer, so the birth-time fallback decides.
  function registryRow(checkout) {
    let read;
    try {
      read = readRegistry(repoRoot || checkout);
    } catch (err) {
      return { row: null, reason: `registry: ${errorText(err)}` };
    }
    if (!read || read.ok !== true) {
      const reason = (read && read.error) || 'cannot read registry';
      return { row: null, reason };
    }
    const rows = Array.isArray(read.worktrees) ? read.worktrees : [];
    const row = rows.find((candidate) => candidate && typeof candidate.path === 'string'
      && path.isAbsolute(candidate.path)
      && path.resolve(candidate.path) === checkout);
    if (!row) return { row: null, reason: 'no registry entry for this checkout' };
    return { row, reason: null };
  }

  // When the checkout was created (S12). The answer depends on the KIND:
  //   principal  — when its git HISTORY began: the oldest root commit. Git
  //                records nothing older, so an unreadable history stays
  //                unavailable instead of borrowing the directory's birth
  //                time (which is when the folder was made, not when the
  //                project started).
  //   worktree   — when THAT checkout was created: its registry row's
  //                `createdAt` (a registration time is never a creation, so
  //                `registeredAt` is ignored) or, when the row has no usable
  //                timestamp, the directory's birth time.
  // `source` names which answer came back — 'root-commit', 'registry' or
  // 'birthtime' — and with none readable the fact stays unavailable.
  function birthTimeMs(checkout) {
    try {
      const ms = Number(fsImpl.statSync(checkout).birthtimeMs);
      if (Number.isFinite(ms) && ms > 0) return ms;
    } catch {
      // A checkout that cannot be stat'ed has no birth time to report.
    }
    return null;
  }

  function createdAtFact(checkout, row, registryReason, principal, root) {
    if (principal) {
      if (root.ok) return { ...available(new Date(root.ms).toISOString()), source: 'root-commit' };
      return { ...unavailable(root.reason), source: null };
    }
    if (row && typeof row.createdAt === 'string' && row.createdAt.length > 0
      && Number.isFinite(Date.parse(row.createdAt))) {
      return { ...available(row.createdAt), source: 'registry' };
    }
    const birth = birthTimeMs(checkout);
    if (birth === null) {
      return { ...unavailable(registryReason || 'no registry entry and no readable birth time'), source: null };
    }
    return { ...available(new Date(birth).toISOString()), source: 'birthtime' };
  }

  // The mtime of the most recently modified uncommitted file in the summary,
  // or null when nothing still exists. Reads the SAME summary the `changes`
  // fact already computed, so last activity never spawns git a second time
  // for the dirty side.
  function latestDirtyMtime(entries) {
    let latest = null;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      let ms;
      try {
        ms = Number(fsImpl.statSync(entry.path).mtimeMs);
      } catch {
        continue; // Deleted since the summary; it contributes nothing.
      }
      if (Number.isFinite(ms) && ms > 0 && (latest === null || ms > latest)) latest = ms;
    }
    return latest;
  }

  // The shared summary measures each untracked file from disk and reports an
  // UNREADABLE one as zero added lines — indistinguishable from an empty
  // file. S16 forbids counting that as a zero, so the untracked entries the
  // summary measured as zero lines are re-opened here: a file that still
  // exists but cannot be read makes the whole fact unavailable, naming the
  // path, instead of a fake zero. Binary files are labelled, not counted, and
  // a file gone since the summary contributes nothing.
  function unreadableUntracked(entries, fsImpl) {
    if (typeof fsImpl.readFileSync !== 'function') return null;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.untracked !== true || typeof entry.path !== 'string') continue;
      if (Number(entry.added) !== 0 || entry.binary === true) continue;
      try {
        fsImpl.readFileSync(entry.path);
      } catch {
        try {
          fsImpl.statSync(entry.path);
        } catch {
          continue; // Gone since the summary; it contributes nothing.
        }
        return entry.rel || entry.path;
      }
    }
    return null;
  }

  async function changesRead(checkout) {
    const summary = await attempt(() => summarize(checkout), 'uncommitted changes');
    if (!summary.ok) return { fact: unavailable(summary.error), latestMtimeMs: null };
    const value = summary.value;
    if (!value || value.ok !== true) {
      return {
        fact: unavailable(`uncommitted changes: ${(value && value.error) || 'unreadable summary'}`),
        latestMtimeMs: null,
      };
    }
    const unreadable = unreadableUntracked(value.entries, fsImpl);
    if (unreadable !== null) {
      return {
        fact: unavailable(`uncommitted changes: cannot read untracked file ${JSON.stringify(unreadable)}`),
        latestMtimeMs: null,
      };
    }
    return {
      fact: available({
        files: value.files,
        added: value.added,
        deleted: value.deleted,
        binaryCount: value.binaryCount || 0,
        text: changesLib.formatChangeSummary(value),
      }),
      latestMtimeMs: latestDirtyMtime(value.entries),
    };
  }

  // The last commit timestamp as an internal `{ok, ms, reason}` so the
  // activity fact can merge it with the dirty mtimes behind one read.
  async function commitRead(checkout) {
    const read = await attempt(() => lastCommit(checkout), 'last commit');
    if (!read.ok) return { ok: false, reason: read.error };
    const value = read.value;
    if (!value || value.ok !== true) {
      return { ok: false, reason: `last commit: ${(value && value.error) || 'unreadable commit'}` };
    }
    const ms = Number(value.timestampMs);
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, reason: 'last commit: unreadable timestamp' };
    return { ok: true, ms };
  }

  // The root commit timestamp as an internal `{ok, ms, reason}`, mirroring
  // `commitRead` so the principal's creation answers in the same shape.
  async function rootCommitRead(checkout) {
    const read = await attempt(() => firstCommit(checkout), 'first commit');
    if (!read.ok) return { ok: false, reason: read.error };
    const value = read.value;
    if (!value || value.ok !== true) {
      return { ok: false, reason: `first commit: ${(value && value.error) || 'unreadable commit'}` };
    }
    const ms = Number(value.timestampMs);
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, reason: 'first commit: unreadable timestamp' };
    return { ok: true, ms };
  }

  // Last activity (S12/S8): the greater of the last commit timestamp and the
  // mtime of the most recently modified uncommitted file. `source` records
  // which side won; with neither readable the fact is unavailable, never a
  // zero time. An inherited pre-checkout commit — one older than the
  // checkout's own creation — is not local modification: when the creation
  // is known it is dropped, and with no local evidence left the fact is
  // unavailable rather than a modification dated before the checkout.
  function activityFact(commit, dirtyMs, createdFact) {
    let createdMs = null;
    if (createdFact && createdFact.available === true) {
      const parsed = Date.parse(createdFact.value);
      if (Number.isFinite(parsed)) createdMs = parsed;
    }
    const inherited = commit.ok && createdMs !== null && commit.ms < createdMs;
    const candidates = [];
    if (commit.ok && !inherited) candidates.push({ ms: commit.ms, source: 'commit' });
    if (Number.isFinite(dirtyMs)) candidates.push({ ms: dirtyMs, source: 'dirty' });
    if (candidates.length === 0) {
      if (inherited) return { ...unavailable('no activity since the checkout was created'), source: null };
      return unavailable(commit.reason || 'no commit and no uncommitted file to read');
    }
    let winner = candidates[0];
    for (const candidate of candidates) {
      if (candidate.ms > winner.ms) winner = candidate;
    }
    return { ...available(new Date(winner.ms).toISOString()), source: winner.source };
  }

  async function aheadBehindFact(checkout, listingRead) {
    // The base is resolved against the repository listing, which this read
    // already awaited for the branch fact, so the shared helper is handed the
    // principal's branch instead of spawning its own `git worktree list` once
    // per checkout (worktree-issues S11). An injected `aheadBehind` seam is
    // called exactly as before.
    const listed = await listingRead;
    const principalBranch = principalBranchFor(checkout, listed);
    const compare = aheadBehind !== null
      ? () => aheadBehind(checkout)
      : () => {
          const options = { principalBranch };
          if (runAsync) options.runAsync = runAsync;
          return gitLib.aheadBehind(checkout, options);
        };
    const compared = await attempt(compare, 'commits ahead/behind');
    if (!compared.ok) return unavailable(compared.error);
    const value = compared.value;
    if (!value || value.ok !== true) {
      return unavailable(`commits ahead/behind: ${(value && value.error) || 'unreadable comparison'}`);
    }
    return available({
      ahead: value.ahead, behind: value.behind, base: value.base, baseSource: value.baseSource,
    });
  }

  // The principal checkout's branch, from the listing this read already has.
  // `undefined` — the answer that keeps the previous behavior — means "this
  // listing does not describe this checkout" (a checkout of ANOTHER
  // repository, which the caller may ask about), so the shared helper reads
  // the repository itself. `null` states that the principal has no branch to
  // offer (detached or bare), which is what such a listing always meant.
  function principalBranchFor(checkout, listed) {
    if (!listed || listed.ok !== true) return undefined;
    const entries = Array.isArray(listed.value) ? listed.value : [];
    const known = entries.some((entry) => entry && typeof entry.path === 'string'
      && path.isAbsolute(entry.path) && path.resolve(entry.path) === checkout);
    if (!known) return undefined;
    const first = entries[0];
    if (!first) return undefined;
    return typeof first.branch === 'string' && first.branch.length > 0 ? first.branch : null;
  }

  // One repository listing per root while it is PENDING (S23): the branch
  // fact and the checkout KIND need the same `git worktree list`, and a
  // selector entry lists every checkout at once, so N concurrent checkouts
  // must not spawn N identical listings. Ownership is published before the
  // seam runs, so a seam that throws synchronously cannot leave an entry
  // without an owner, and it is released the moment it settles: a settled
  // listing is never retained, so a later read asks git again instead of
  // showing a repository state that has since changed.
  function listingFor(root) {
    const key = path.resolve(root);
    const pending = listingInFlight.get(key);
    if (pending) return pending;
    const promise = Promise.resolve().then(() => listWorktrees(root));
    listingInFlight.set(key, promise);
    // Release only OUR entry: an `invalidate()` may already have dropped it
    // and a newer listing may own the key, so a late completion never clears
    // newer work.
    const release = () => {
      if (listingInFlight.get(key) === promise) listingInFlight.delete(key);
    };
    promise.then(release, release);
    return promise;
  }

  async function read(checkout) {
    const startedAt = now();
    // The expensive git reads run together but only for THIS checkout; the
    // cheap synchronous registry read runs first (it answers nothing but the
    // linked worktree's `createdAt`), and the listing is read once because
    // both the branch fact and the checkout KIND need it. The dirty summary is
    // computed once and feeds both `changes` and the dirty side of
    // `lastActivity`.
    const registry = registryRow(checkout);
    // The listing is started FIRST and awaited by both the branch fact and the
    // ahead/behind base, so one `git worktree list` serves the whole read.
    const listingRead = attempt(() => listingFor(repoRoot || checkout), 'git worktree list');
    const [listing, changes, compared, commit] = await Promise.all([
      listingRead,
      changesRead(checkout),
      aheadBehindFact(checkout, listingRead),
      commitRead(checkout),
    ]);
    const principal = isPrincipalCheckout(checkout, listing);
    // The root-commit read only ever runs for the principal: a linked
    // worktree's creation is never git's history beginning.
    const root = principal
      ? await rootCommitRead(checkout)
      : { ok: false, reason: 'not the principal checkout' };
    const createdAt = createdAtFact(checkout, registry.row, registry.reason, principal, root);
    return {
      checkout,
      fetchedAt: startedAt,
      cached: false,
      branch: branchFact(checkout, listing),
      createdAt,
      lastActivity: activityFact(commit, changes.latestMtimeMs, createdAt),
      changes: changes.fact,
      aheadBehind: compared,
    };
  }

  function fresh(entry) {
    return entry !== null && now() - entry.at < ttlMs;
  }

  function clone(entry, extra) {
    return { ...entry.facts, cached: true, ...extra };
  }

  // Resolve the facts for one checkout: cached within the TTL, the shared
  // in-flight read while one is running, otherwise a fresh read.
  async function facts(checkoutPath) {
    const checkout = keyOf(checkoutPath);
    if (checkout === null) {
      return {
        checkout: checkoutPath === undefined ? null : checkoutPath,
        fetchedAt: now(),
        cached: false,
        branch: unavailable('checkout path is empty'),
        createdAt: unavailable('checkout path is empty'),
        lastActivity: unavailable('checkout path is empty'),
        changes: unavailable('checkout path is empty'),
        aheadBehind: unavailable('checkout path is empty'),
      };
    }
    const entry = cache.get(checkout);
    if (entry && fresh(entry)) return clone(entry);
    const pending = inFlight.get(checkout);
    if (pending) return clone({ facts: await pending });
    const promise = read(checkout);
    inFlight.set(checkout, promise);
    try {
      const values = await promise;
      // A read that an `invalidate()` superseded must not repopulate the
      // cache: the in-flight entry is cleared on invalidate, so this guard
      // keeps a slow pre-save read from resurrecting stale facts.
      if (inFlight.get(checkout) === promise) cache.set(checkout, { at: now(), facts: values });
      return values;
    } finally {
      inFlight.delete(checkout);
    }
  }

  // Synchronous paint-time read of the cache: null when nothing was read
  // yet, `stale:true` when the entry is past its TTL (the caller may show
  // it and refresh in the background, but is told it is old).
  function peek(checkoutPath) {
    const checkout = keyOf(checkoutPath);
    if (checkout === null) return null;
    const entry = cache.get(checkout);
    if (!entry) return null;
    return clone(entry, { stale: !fresh(entry) });
  }

  // Drop one checkout's cached facts, or all of them (after a create, a
  // registry edit or a commit the selector itself performed).
  function invalidate(checkoutPath) {
    const checkout = keyOf(checkoutPath);
    if (checkout === null) {
      cache.clear();
      inFlight.clear();
      listingInFlight.clear();
      return;
    }
    cache.delete(checkout);
    // Drop any in-flight read too: its result predates the invalidation.
    inFlight.delete(checkout);
    // The pending listing predates the invalidation as well, so it must not
    // be served to a read that follows it; dropping the ownership makes the
    // next read list again.
    listingInFlight.delete(path.resolve(repoRoot || checkout));
  }

  return { facts, peek, invalidate, ttlMs };
}

module.exports = { createCheckoutFacts, DEFAULT_TTL_MS };

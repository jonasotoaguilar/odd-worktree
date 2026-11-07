'use strict';
// Registry of agent-owned worktrees (P2-S1 foundation).
//
// The file lives at <git-common-dir>/pi-worktrees.json: inside `.git`,
// never in a working tree, never committed, shared by every worktree of
// the repository. Entries carry
// {branch, path, thread, issues[], odd, createdAt, updatedAt}, where `odd`
// is ONE odd document path or `null` (S8: a worktree carries at most one
// associated odd document — the entity rule, not a UI convention).
//
// Reads tolerate malformed content and report it instead of throwing, and
// never delete the file. Writes are atomic (temporary file plus rename)
// and serialized by withRegistryLock, an exclusive lock file beside the
// registry with a bounded wait and stale-lock recovery. Pure Node: the
// only subprocess used is the git plumbing that locates the common dir.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { commonDirFor } = require('./worktree-git.js');

const REGISTRY_VERSION = 1;
const REGISTRY_NAME = 'pi-worktrees.json';
const LOCK_NAME = 'pi-worktrees.lock';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_STALE_MS = 30000;

// S22 (round 3): the storage directory comes from the shared, memoized
// `commonDirFor`, so locating the registry never spawns git more than once per
// checkout and shares that one resolution with the warp-session store.
function resetRegistryCaches() {
  readCache.clear();
}

function registryPath(repoRoot) {
  return path.join(commonDirFor(repoRoot), REGISTRY_NAME);
}

function lockPath(repoRoot) {
  return path.join(commonDirFor(repoRoot), LOCK_NAME);
}

function emptyRegistry() {
  return { ok: true, version: REGISTRY_VERSION, worktrees: [], error: null };
}

// S8 entity rule: a worktree carries AT MOST ONE odd document, stored as a
// single `odd/<rel>` path string, or `null` when it has none. This is the
// ONLY normalization of that field: every read and every write funnels
// through it, so no caller can reintroduce a second one.
//
// Legacy migration (S8b): a row written by an older version may carry the
// old `odd[]` array. It normalizes deterministically to its FIRST entry and
// never fails, and `dropped` names the entries left behind so the WRITE that
// collapsed them can report the loss once instead of discarding a stored
// association silently. An empty array, like an empty string, means "none".
function normalizeOddDoc(value) {
  if (typeof value === 'string') return value.length > 0 ? { odd: value, dropped: [] } : { odd: null, dropped: [] };
  if (Array.isArray(value)) {
    const entries = value.filter((name) => typeof name === 'string' && name.length > 0);
    return { odd: entries.length > 0 ? entries[0] : null, dropped: entries.slice(1) };
  }
  return { odd: null, dropped: [] };
}

function isEntryShape(entry) {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && typeof entry.branch === 'string' && typeof entry.path === 'string';
}

// S8b: a row read from a legacy array carries the names it left behind on a
// NON-enumerable property, so `JSON.stringify` can never persist it while a
// write that COLLAPSES that row can still report the loss once.
function stampDroppedOdds(row, dropped) {
  if (dropped.length === 0) return row;
  Object.defineProperty(row, 'oddDropped', { value: dropped, enumerable: false });
  return row;
}

// S1: a write that addresses ONE row used to rewrite the whole file, so every
// OTHER row was re-serialized from its normalized in-memory shape — and a
// legacy `odd[]` list silently lost the documents past its first entry. A
// worktree carries no association any more, which leaves that loss nowhere to
// be reported: so it must not happen. Each read row therefore remembers the
// entry it was parsed from on a NON-enumerable stamp (invisible to JSON and to
// every caller's view of the row), and the rows a write does not address are
// written back from that entry — byte for byte, unknown fields included.
function stampStoredEntry(row, entry) {
  Object.defineProperty(row, 'storedEntry', { value: entry, enumerable: false });
  return row;
}

// The rows a write persists: an unaddressed row goes back exactly as it came
// in; a row the write BUILT — every write path constructs the row it addresses
// — carries no stamp and is serialized in its normalized shape.
function rowsForWrite(worktrees) {
  return worktrees.map((row) => (Object.prototype.hasOwnProperty.call(row, 'storedEntry')
    ? row.storedEntry
    : row));
}

// The association report a write returns: the entries a supplied legacy list
// lost, plus the ones the ADDRESSED row lost while being persisted. Only a row
// the write built can drop anything — every other row is preserved verbatim
// (rowsForWrite) — so a preserved row never reaches this list.
function reportDroppedOdds(result, addressed, extra = []) {
  const dropped = [...extra];
  for (const row of addressed || []) {
    if (Array.isArray(row && row.oddDropped)) dropped.push(...row.oddDropped);
  }
  if (dropped.length > 0) result.dropped = dropped;
  return result;
}

// Read the registry. Missing means empty; malformed content is reported
// ({ok:false, error}) instead of thrown, and the file is left untouched.
// The parsed result is cached per file identity — inode, size and nanosecond
// mtime — because the registry is read several times per action and a fresh
// JSON parse plus row normalization is the whole cost of a read once git is
// out of the way. `rename` (every write) changes the inode and an in-place
// edit changes mtime/size, so a cached read can never outlive a write, ours
// or another process's. Callers receive a CLONE: the returned rows are
// mutable, and handing out the cached object would let one caller's edit
// reach another caller's next read.
const READ_CACHE_LIMIT = 32;
const readCache = new Map();

function fileIdentity(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

function cloneRead(result) {
  return {
    ok: result.ok,
    version: result.version,
    worktrees: result.worktrees.map((row) => {
      const copy = JSON.parse(JSON.stringify(row));
      // The drop report rides on a NON-enumerable stamp (a legacy association
      // list collapsed at read time), so a plain JSON clone would lose it and
      // a later write would stop reporting what it dropped.
      if (Array.isArray(row.oddDropped)) {
        Object.defineProperty(copy, 'oddDropped', { value: row.oddDropped.slice(), enumerable: false });
      }
      // The verbatim entry a later write persists rides on the same kind of
      // stamp: without it a cached read would hand back a row whose next
      // whole-file write silently normalized the legacy list after all.
      if (row.storedEntry !== undefined) {
        Object.defineProperty(copy, 'storedEntry', {
          value: JSON.parse(JSON.stringify(row.storedEntry)),
          enumerable: false,
        });
      }
      return copy;
    }),
    error: result.error,
  };
}

function readRegistry(repoRoot) {
  const file = registryPath(repoRoot);
  const identity = fileIdentity(file);
  if (identity !== null) {
    const cached = readCache.get(file);
    if (cached && cached.identity === identity) return cloneRead(cached.result);
  }
  const result = readRegistryFresh(file);
  if (identity === null) {
    readCache.delete(file);
  } else {
    readCache.delete(file);
    readCache.set(file, { identity, result });
    if (readCache.size > READ_CACHE_LIMIT) {
      const oldest = readCache.keys().next();
      if (!oldest.done) readCache.delete(oldest.value);
    }
  }
  return cloneRead(result);
}

function readRegistryFresh(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyRegistry();
    return { ok: false, version: null, worktrees: [], error: `cannot read registry: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (err) {
    return { ok: false, version: null, worktrees: [], error: `malformed registry (invalid JSON): ${err.message}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc) || !Array.isArray(doc.worktrees)) {
    return { ok: false, version: null, worktrees: [], error: 'malformed registry (expected {worktrees: []})' };
  }
  const version = doc.version === undefined ? REGISTRY_VERSION : doc.version;
  const worktrees = doc.worktrees.filter(isEntryShape).map((entry) => {
    const odd = normalizeOddDoc(entry.odd);
    return stampStoredEntry(stampDroppedOdds({
      ...entry,
      issues: Array.isArray(entry.issues) ? entry.issues : [],
      odd: odd.odd,
    }, odd.dropped), entry);
  });
  return { ok: true, version, worktrees, error: null };
}

function findEntry(worktrees, predicate) {
  return worktrees.find(predicate) || null;
}

function findByBranch(repoRoot, branch) {
  const read = readRegistry(repoRoot);
  if (!read.ok) return null;
  return findEntry(read.worktrees, (entry) => entry.branch === branch);
}

function findByPath(repoRoot, target) {
  const read = readRegistry(repoRoot);
  if (!read.ok) return null;
  // A relative key matches nothing: registry paths are absolute, and
  // resolving either side against the process cwd would name a checkout
  // relative to wherever the caller happens to run, not the repository.
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  const resolved = path.resolve(target);
  return findEntry(read.worktrees, (entry) => typeof entry.path === 'string'
    && path.isAbsolute(entry.path)
    && path.resolve(entry.path) === resolved);
}

function findByThread(repoRoot, thread) {
  const read = readRegistry(repoRoot);
  if (!read.ok) return null;
  return findEntry(read.worktrees, (entry) => entry.thread === thread);
}

// Acquire the exclusive lock file beside the registry, run fn, release.
// Bounded wait (timeoutMs) with stale-lock recovery (staleMs): a lock
// file older than staleMs is treated as orphaned and removed. Throws on
// timeout so a stuck holder fails loudly instead of hanging forever.
function withRegistryLock(repoRoot, fn, opts = {}) {
  const file = lockPath(repoRoot);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx', 0o644);
      try {
        fs.writeSync(fd, String(process.pid));
      } catch {
        // Best effort owner hint; the lock itself is what matters.
      }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (isStaleLock(file, staleMs)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Lost a race with another recoverer; retry acquisition.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for registry lock ${file}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pollMs, deadline - Date.now()));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Releasing must not mask the callback result.
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // Another stale recovery may have removed it first.
    }
  }
}

function isStaleLock(file, staleMs) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  return Date.now() - stat.mtimeMs > staleMs;
}

function backupCorruptRegistry(file) {
  // Preserve the previous bytes beside the registry before a malformed
  // file is replaced. Best-effort and never fatal: a missing or
  // unreadable file, or a failed copy, simply yields no backup.
  // The backup name carries an unpredictable suffix and is created
  // exclusively (`wx`) so a planted symlink or file at a predictable
  // name is never followed or overwritten; on collision a new name is
  // retried a bounded number of times, then the operation continues
  // WITHOUT a backup (the caller reports that clearly).
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch {
      return null;
    }
    const backup = `${file}.corrupt-${Date.now()}-${suffix}`;
    try {
      fs.writeFileSync(backup, raw, { flag: 'wx' });
      return backup;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      // Best-effort: a failed backup write never leaves litter behind.
      try {
        fs.unlinkSync(backup);
      } catch {
        // Either never created or already gone; nothing to clean.
      }
      return null;
    }
  }
  return null;
}

function validateEntry(entry) {
  if (typeof entry !== 'object' || entry === null) return 'entry must be an object';
  if (typeof entry.branch !== 'string' || entry.branch === '') return 'entry.branch is required';
  if (typeof entry.path !== 'string' || entry.path === '') return 'entry.path is required';
  if (typeof entry.thread !== 'string' || entry.thread === '') return 'entry.thread is required';
  if (!Array.isArray(entry.issues)) return 'entry.issues must be an array (possibly empty)';
  // S8: one document or none. A legacy array is tolerated here (it collapses
  // in storeLocked and the drop is reported); anything else is refused.
  if (entry.odd !== undefined && entry.odd !== null
    && typeof entry.odd !== 'string' && !Array.isArray(entry.odd)) {
    return 'entry.odd must be a single odd document path (or null)';
  }
  return null;
}

// Atomically replace the registry file: write a sibling temp file
// exclusively (`wx`) with an unpredictable suffix, then rename over the
// target. A pre-existing name is never followed or reused: on collision
// a new name is retried a bounded number of times, then the write is
// refused with a clear error. The temp file never survives the call.
function writeRegistryAtomic(file, doc) {
  const payload = `${JSON.stringify({ ...doc, worktrees: rowsForWrite(doc.worktrees) }, null, 2)}\n`;
  let tmp = null;
  let wrote = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch (err) {
      throw new Error(`cannot write registry ${file}: cannot generate a temporary file name: ${(err && err.message) || err}`);
    }
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${suffix}`;
    try {
      fs.writeFileSync(tmp, payload, { flag: 'wx' });
      wrote = true;
      break;
    } catch (err) {
      // A non-EEXIST failure may still have created the temp file
      // (e.g. ENOSPC mid-write): unlink it best-effort so a failed
      // write never leaves litter behind, then rethrow (never success).
      const failedTmp = tmp;
      tmp = null;
      if (err && err.code === 'EEXIST') continue;
      if (failedTmp) {
        try {
          fs.unlinkSync(failedTmp);
        } catch {
          // Best effort: the rethrow below is what matters.
        }
      }
      throw err;
    }
  }
  if (!wrote || !tmp) {
    throw new Error(`cannot write registry ${file}: could not create a unique temporary file after 10 attempts; refusing to follow or reuse an existing path`);
  }
  try {
    fs.renameSync(tmp, file);
    // Our own write must be visible to the next read immediately, not after
    // the caches notice a new inode.
    readCache.delete(file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Either renamed (gone) or never created; nothing to clean.
    }
  }
}

function upsertWorktree(repoRoot, entry, opts = {}) {
  const invalid = validateEntry(entry);
  if (invalid) return { ok: false, error: invalid };
  return withRegistryLock(repoRoot, () => storeLocked(repoRoot, entry, 'upsert'), opts);
}

// Always-append variant of the upsert: the incoming entry is recorded
// WITHOUT replacing any row that already carries its branch. The create
// path uses this when a hand-written row with the same branch points at
// a DIFFERENT live checkout, so that checkout keeps its registration and
// the new checkout is recorded alongside it. Malformed-file handling
// (replace, never merge, with the same best-effort backup) matches the
// upsert exactly.
function appendWorktree(repoRoot, entry, opts = {}) {
  const invalid = validateEntry(entry);
  if (invalid) return { ok: false, error: invalid };
  return withRegistryLock(repoRoot, () => storeLocked(repoRoot, entry, 'append'), opts);
}

function storeLocked(repoRoot, entry, mode) {
    const file = registryPath(repoRoot);
    const read = readRegistry(repoRoot);
    // A malformed file is replaced, never merged: the incoming entry is
    // the only trustworthy data. Reads already reported the damage. The
    // previous bytes are preserved beside the registry first so the
    // damage stays inspectable.
    const backup = read.ok ? null : backupCorruptRegistry(file);
    const worktrees = read.ok ? read.worktrees.slice() : [];
    const now = new Date().toISOString();
    const index = mode === 'upsert'
      ? worktrees.findIndex((item) => item.branch === entry.branch)
      : -1;
    const previous = index >= 0 ? worktrees[index] : null;
    // S8/S1: the row holds one document or none. A SUPPLIED legacy list
    // collapses to its first entry and names the rest in `dropped` (S8b); an
    // OMITTED association leaves the stored value exactly as it is on disk —
    // a legacy list included — because a create is not the operation that
    // discards a document it never looked at.
    const oddSupplied = entry.odd !== undefined;
    const keptStored = !oddSupplied && previous !== null && previous.storedEntry !== undefined;
    const odd = normalizeOddDoc(oddSupplied
      ? entry.odd
      : (previous ? previous.odd : undefined));
    // The row this write replaces is also the only row whose fields are
    // rewritten: its unknown fields (a field this version does not model) are
    // carried over, so an addressed write never sheds data either.
    const base = previous && previous.storedEntry !== undefined ? previous.storedEntry : {};
    const stored = {
      ...base,
      branch: entry.branch,
      path: entry.path,
      thread: entry.thread,
      issues: entry.issues.slice(),
      odd: keptStored ? previous.storedEntry.odd : odd.odd,
      updatedAt: now,
    };
    // S10: a discovery-registered row has no `createdAt` on purpose (the
    // registration time is not the checkout's birth date); a later update
    // must not synthesize one. Only a brand-new create records `createdAt`,
    // and a recorded one is preserved.
    if (previous) {
      if (previous.createdAt !== undefined) stored.createdAt = previous.createdAt;
      if (previous.registeredAt !== undefined) stored.registeredAt = previous.registeredAt;
    } else {
      stored.createdAt = now;
    }
    if (index >= 0) worktrees[index] = stored;
    else worktrees.push(stored);
    writeRegistryAtomic(file, { version: REGISTRY_VERSION, worktrees });
    // Only the row this write replaced can have lost an association; every
    // other row in `read.worktrees` is carried through verbatim.
    const result = reportDroppedOdds(
      { ok: true, entry: stored },
      keptStored || previous === null ? [] : [previous],
      keptStored ? [] : odd.dropped,
    );
    // Name the backup so the caller can report it; absent when the
    // previous registry was valid (or there was nothing to preserve).
    // When the previous file was malformed but no backup could be
    // written, the operation still succeeds (best-effort, never fatal)
    // but the failure is reported clearly via backupError and never
    // clobbers anything.
    if (backup) result.backup = backup;
    else if (!read.ok) result.backupError = `could not preserve malformed registry ${file}: backup unavailable; the registry was replaced without a backup`;
    return result;
}

// Update-in-place for the create-or-update tool (S27/S31): overwrite
// ONLY the supplied fields of the row identified by `key` (branch or
// absolute path, the same matching `removeWorktree` uses) and leave
// every omitted field untouched — so a supplied `issues` (including
// `[]`) and a supplied `odd` (including `null`) REPLACE the stored value
// while an omitted field stays as it was. `odd` is ONE document path (S8):
// a supplied legacy list collapses to its first entry and the dropped
// entries are reported. The branch and the path are never rewritten here.
// Returns {ok, entry} or {ok:false, error}; never throws on a readable
// registry, and writes atomically under the lock.
function updateWorktree(repoRoot, key, patch = {}, opts = {}) {
  const hasIssues = patch && Object.prototype.hasOwnProperty.call(patch, 'issues');
  const hasOdd = patch && Object.prototype.hasOwnProperty.call(patch, 'odd');
  if (hasIssues && !Array.isArray(patch.issues)) {
    return { ok: false, error: 'patch.issues must be an array (possibly empty)' };
  }
  if (hasOdd && patch.odd !== null && typeof patch.odd !== 'string' && !Array.isArray(patch.odd)) {
    return { ok: false, error: 'patch.odd must be a single odd document path (string) or null' };
  }
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    const current = worktrees[index];
    const odd = normalizeOddDoc(hasOdd ? patch.odd : current.odd);
    // Unknown fields the row already carries survive an addressed edit too:
    // this version rewrites the fields it models, never the rest.
    const base = current.storedEntry !== undefined ? current.storedEntry : {};
    const stored = {
      ...base,
      branch: current.branch,
      path: current.path,
      thread: current.thread,
      issues: hasIssues ? patch.issues.slice() : (Array.isArray(current.issues) ? current.issues.slice() : []),
      odd: odd.odd,
      updatedAt: new Date().toISOString(),
    };
    // S10: preserve whatever creation provenance the row already carries —
    // including the deliberate absence a discovery row records, so an edit
    // never turns a registration time into a pretended birth date.
    if (current.createdAt !== undefined) stored.createdAt = current.createdAt;
    if (current.registeredAt !== undefined) stored.registeredAt = current.registeredAt;
    worktrees[index] = stored;
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return reportDroppedOdds({ ok: true, entry: stored }, [current], odd.dropped);
  }, opts);
}

// Startup discovery registration (S28/S10): record every live checkout the
// registry does not already own, without touching any existing row. `live`
// is git's listing. The CANONICAL PRINCIPAL is registered too — `principalPath`
// is its resolved identity, NOT an exclusion — once and idempotently, as the
// FIRST metadata row, so the principal is always listed and its stored
// associations survive. Discovery rows deliberately carry `registeredAt`
// instead of `createdAt`: the registration time is not the checkout's
// filesystem birth date, and an unknown birth stays unknown. Matching is by
// resolved path identity, so a registered row reached through a symlink
// still counts as owned. Returns {ok, registered:[{branch,path}]}; never
// throws on a readable registry — failures report {ok:false, error}.
function registerMissingWorktrees(repoRoot, live, principalPath, opts = {}) {
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error, registered: [] };
    const owned = new Set();
    for (const row of read.worktrees) {
      if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path)) continue;
      try {
        owned.add(path.resolve(row.path));
      } catch {
        // An unresolvable row owns nothing.
      }
      try {
        owned.add(fs.realpathSync(row.path));
      } catch {
        // A missing checkout contributes only its spelling.
      }
    }
    const now = new Date().toISOString();
    const worktrees = read.worktrees.slice();
    const registered = [];

    // Resolve one live listing entry to the absolute path git names plus
    // its resolved identity and branch, or null when it is not a live
    // directory checkout. Never resolves a relative path against the
    // process cwd.
    const resolveLive = (entry) => {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) return null;
      if (!entry.branch || typeof entry.branch !== 'string' || entry.branch.length === 0) return null;
      let absolute;
      try {
        absolute = path.isAbsolute(entry.path) ? path.resolve(entry.path) : null;
      } catch {
        return null;
      }
      if (absolute === null) return null;
      try {
        if (!fs.statSync(absolute).isDirectory()) return null;
      } catch {
        return null;
      }
      let real = null;
      try {
        real = fs.realpathSync(absolute);
      } catch {
        real = null;
      }
      return { absolute, real, id: real !== null ? real : absolute, branch: entry.branch };
    };

    // S10: register the canonical principal FIRST and only once. An existing
    // row reaching the principal's resolved identity (or already claiming its
    // branch) means it is owned; nothing is written. Otherwise the principal
    // row is inserted at index 0, so it is the first metadata row.
    const principalId = typeof principalPath === 'string' && principalPath.length > 0 ? principalPath : null;
    if (principalId !== null) {
      for (const entry of live || []) {
        const info = resolveLive(entry);
        if (!info || info.id !== principalId) continue;
        if (owned.has(info.absolute) || (info.real !== null && owned.has(info.real))) break;
        if (worktrees.some((row) => row.branch === info.branch)) break;
        const stored = {
          branch: info.branch,
          path: info.absolute,
          thread: 'principal',
          issues: [],
          odd: null,
          registeredAt: now,
          updatedAt: now,
        };
        worktrees.unshift(stored);
        owned.add(info.absolute);
        if (info.real !== null) owned.add(info.real);
        registered.push({ branch: stored.branch, path: stored.path });
        break;
      }
    }

    for (const entry of live || []) {
      const info = resolveLive(entry);
      if (!info) continue;
      if (owned.has(info.absolute) || (info.real !== null && owned.has(info.real))) continue;
      if (worktrees.some((row) => row.branch === info.branch)) continue;
      const stored = {
        branch: info.branch,
        path: info.absolute,
        thread: 'discovery',
        issues: [],
        odd: null,
        registeredAt: now,
        updatedAt: now,
      };
      worktrees.push(stored);
      owned.add(info.absolute);
      if (info.real !== null) owned.add(info.real);
      registered.push({ branch: stored.branch, path: stored.path });
    }
    if (registered.length === 0) return { ok: true, registered: [] };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    // Discovery only ever appends rows; it addresses none of the stored ones,
    // so it can report no loss.
    return { ok: true, registered };
  }, opts);
}

function matchesKey(entry, key) {
  if (entry.branch === key) return true;
  // Path keys match by exact absolute path equality only. A branch name
  // (or any other relative string) must never be resolved against the
  // process cwd as a path key: from a different cwd that would match a
  // checkout the caller never named.
  if (typeof key !== 'string' || !path.isAbsolute(key)) return false;
  if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return false;
  try {
    return path.resolve(entry.path) === path.resolve(key);
  } catch {
    return false;
  }
}

function removeWorktree(repoRoot, key, opts = {}) {
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    worktrees.splice(index, 1);
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    // Removing one row addresses no surviving row: each is written verbatim.
    return { ok: true };
  }, opts);
}

// Every identity an absolute path can present: its resolved form, its
// realpath when the filesystem still resolves it, and — via an explicit
// readlink walk that never touches the process cwd — every referent of a
// symlink chain, so a DANGLING link left behind by a removed checkout
// still names the checkout it used to reach. All inputs are absolute, so
// path.resolve here never consults the process cwd.
function pathIdentities(absolutePath) {
  const ids = new Set();
  let resolved;
  try {
    resolved = path.resolve(absolutePath);
  } catch {
    return ids;
  }
  ids.add(resolved);
  try {
    ids.add(fs.realpathSync(absolutePath));
  } catch {
    // Unresolvable (removed checkout, dangling link): the readlink walk
    // below still recovers the referent.
  }
  let current = resolved;
  for (let depth = 0; depth < 10; depth += 1) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break;
    }
    if (!stat.isSymbolicLink()) break;
    let link;
    try {
      link = fs.readlinkSync(current);
    } catch {
      break;
    }
    current = path.resolve(path.dirname(current), link);
    ids.add(current);
    try {
      ids.add(fs.realpathSync(current));
    } catch {
      // Keep walking: a deeper link may still resolve.
    }
  }
  return ids;
}

// Path-identity removal for the close flow: drops every entry that reaches
// the removed checkout — the same absolute value the close resolved,
// verified, and removed, a realpath-equal row, or a row whose path is a
// symlink (live or dangling) to it. A non-absolute key is refused, no
// branch comparison happens here, and a relative row can never match, so
// duplicate branches or a branch that equals another entry's path can
// never divert the drop. Other callers keep using `removeWorktree` with
// its branch behaviour.
function removeWorktreeByPath(repoRoot, absolutePath, opts = {}) {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    return { ok: false, error: `refusing to drop registry entry: path ${JSON.stringify(absolutePath)} is not absolute` };
  }
  const targetIds = pathIdentities(absolutePath);
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    // Drop EVERY row reaching the target: a hand-edited registry may hold
    // duplicate rows sharing one path, or a row whose path is a symlink
    // to the removed checkout, and leaving one behind would keep a stale
    // entry after the close.
    const worktrees = read.worktrees.filter((entry) => {
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return true;
      for (const id of pathIdentities(entry.path)) {
        if (targetIds.has(id)) return false;
      }
      return true;
    });
    if (worktrees.length === read.worktrees.length) return { ok: false, error: `no registered worktree for ${absolutePath}` };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    // The close addresses the row it drops; every surviving row is verbatim.
    return { ok: true };
  }, opts);
}

// Row-identity removal for the create-path stale cleanup: drops the rows
// whose (branch, path) pair exactly equals the selected entry — the ONE
// row the caller identified as its own. Never matches by branch alone
// and never resolves paths, so a live entry sharing the branch (or a
// path that resolves the same) is never diverted onto.
function removeWorktreeExact(repoRoot, branch, entryPath, opts = {}) {
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const worktrees = read.worktrees.filter((entry) => !(entry.branch === branch && entry.path === entryPath));
    if (worktrees.length === read.worktrees.length) return { ok: false, error: `no registered worktree for ${branch}` };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true };
  }, opts);
}

// Batch prune for the list self-heal (S16): drops every row whose
// absolute path is one of `absolutePaths` in ONE locked atomic write.
// Only absolute paths participate on either side — a relative row can
// never name a checkout without resolving against the process cwd, so it
// is never matched here and callers must not pass one. Returns
// {ok, pruned} where pruned lists the dropped entry paths; a write
// failure throws so the caller can still exclude the rows from its
// listing while reporting the failure.
function pruneWorktrees(repoRoot, absolutePaths, opts = {}) {
  const targets = new Set();
  for (const candidate of absolutePaths || []) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try {
      targets.add(path.resolve(candidate));
    } catch {
      // An unresolvable candidate matches nothing.
    }
  }
  if (targets.size === 0) return { ok: true, pruned: [] };
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error, pruned: [] };
    const pruned = [];
    const worktrees = read.worktrees.filter((entry) => {
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return true;
      let resolved;
      try {
        resolved = path.resolve(entry.path);
      } catch {
        return true;
      }
      if (targets.has(resolved)) {
        pruned.push(entry.path);
        return false;
      }
      return true;
    });
    if (pruned.length === 0) return { ok: true, pruned: [] };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    // The pruned rows are gone; every row that stays is written verbatim.
    return { ok: true, pruned };
  }, opts);
}

// Associate ONE odd document with a worktree (S8). A worktree carries at
// most one, so this is a SELECT, not an append: associating another document
// REPLACES the stored one, and `replaced` names the document that lost the
// association so the caller can report it rather than letting it disappear.
// A legacy array in the row collapses here too (`dropped`).
function addOddDoc(repoRoot, key, relPath, opts = {}) {
  if (typeof relPath !== 'string' || relPath === '') return { ok: false, error: 'relPath is required' };
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    // The row as it was read: the only row this selection addresses, so the
    // only one whose collapsed entries are reported.
    const addressed = worktrees[index];
    const previous = normalizeOddDoc(addressed.odd);
    const entry = { ...addressed, odd: relPath, updatedAt: new Date().toISOString() };
    worktrees[index] = entry;
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return reportDroppedOdds({
      ok: true,
      entry,
      added: previous.odd !== relPath,
      replaced: previous.odd !== null && previous.odd !== relPath ? previous.odd : null,
    }, [addressed], previous.dropped);
  }, opts);
}

module.exports = {
  REGISTRY_VERSION,
  normalizeOddDoc,
  registryPath,
  readRegistry,
  findByBranch,
  findByPath,
  findByThread,
  upsertWorktree,
  appendWorktree,
  removeWorktree,
  removeWorktreeByPath,
  removeWorktreeExact,
  pruneWorktrees,
  addOddDoc,
  updateWorktree,
  registerMissingWorktrees,
  withRegistryLock,
};

'use strict';
// The two pieces of index coordination (S3), and nothing else: one init lock per project and one per-project sync
// lease, both shared by every session of this user on the machine (the temp folder is per user, so another account,
// another machine, a terminal or another tool is not seen).
//
// The init lock is a directory in the temp folder holding `owner.json`: an init that creates an index and a sync
// that updates one exclude each other, because CodeGraph's own `init` can hang for good when two start at the same
// instant. Clearing a stale lock happens under a second directory (`<lock>.takeover`), so only one session at a time
// can do it. The lease is a directory with `run/` (the session syncing), `req/` (one file per request waiting for a
// follow-up) and `gate/` (the short mutex the lease and the requests share); a request is only marked as served by a
// run that started after it and finished, so one that cannot be served is reported pending, never dropped and never
// reported as a sync of the caller.
//
// Every external seam is injected with a real default: `dir`, `isAlive`, `now`, `fs`. Nothing here spawns a child,
// so a lock is never held on behalf of a live process this module could not see.

const nodeFs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { canonicalRoot } = require('./codegraph-paths.js');

/** The longest a `codegraph init` is allowed to run; a lock older than this cannot belong to a live one. */
const INIT_TIMEOUT_MS = 600_000;
/** The longest a `codegraph sync` is allowed to run; a lease older than this cannot belong to a live one. */
const SYNC_TIMEOUT_MS = 120_000;
/** The longest an init is allowed to run plus a minute: beyond that the lock is not trusted. */
const LOCK_MAX_AGE_MS = INIT_TIMEOUT_MS + 60_000;
/** One sync may run for its own two minutes; a lease older than this cannot belong to a sync still running. */
const SYNC_LEASE_MAX_AGE_MS = SYNC_TIMEOUT_MS + 60_000;
/** An empty lock directory this young is an owner about to write its record; older ones were abandoned. */
const UNWRITTEN_GRACE_MS = 10_000;
/** Clearing a stale lock takes milliseconds: a takeover guard older than this was left by a session that died. */
const TAKEOVER_GRACE_MS = 10_000;
/** Taking the gate takes milliseconds: one older than this was left by a session that died inside it. */
const GATE_GRACE_MS = 10_000;
/** How long a session waits for the gate before it gives up: there is no safe way to coordinate without it. */
const GATE_TIMEOUT_MS = 30_000;
/**
 * How long a record whose adopted pid may be only the shell around the real init is trusted after that spawn. The
 * shell can die while the init goes on, and the init announces itself in CodeGraph's own lock only a moment later.
 */
const PROXY_TRUST_MS = 60_000;
const DEFAULT_POLL_MS = 50;
/** How long a session whose sync waits for the running one looks for its request to be served. */
const DEFAULT_REQUEST_WAIT_MS = SYNC_LEASE_MAX_AGE_MS + 60_000;

/** The `node:fs` surface these two pieces of state use, so a test can stand in for it. */
const FS_NAMES = ['existsSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'rmSync', 'statSync', 'writeFileSync'];

function fsOf(options) {
  const fs = options && options.fs;
  if (!fs) return nodeFs;
  const merged = {};
  for (const name of FS_NAMES) merged[name] = typeof fs[name] === 'function' ? fs[name] : nodeFs[name];
  return merged;
}

function clockOf(options) {
  return options && typeof options.now === 'function' ? options.now : Date.now;
}

function aliveOf(options) {
  return options && typeof options.isAlive === 'function' ? options.isAlive : processExists;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return Boolean(error) && error.code === 'EPERM';
  }
}

function keyFor(project) {
  return createHash('sha256').update(canonicalRoot(project)).digest('hex').slice(0, 16);
}

/** CodeGraph writes the pid of whatever writes the index here and removes the file when it ends, on failure too. */
const CODEGRAPH_LOCK = path.join('.codegraph', 'codegraph.lock');

/**
 * Whether a CodeGraph process is writing the index of `project` right now, whoever started it (another session, the
 * project daemon, a git hook, a terminal). CodeGraph holds `.codegraph/codegraph.lock` for every operation that
 * writes the index (`init`, `sync`, a file index) and removes it when it ends; reads and queries never hold it. A pid
 * that is not alive left the file behind. Any other error is a false: this never throws.
 */
function codegraphWritingIndex(project, options) {
  const fs = fsOf(options);
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(project, CODEGRAPH_LOCK), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 && processExists(pid);
  } catch {
    return false;
  }
}

// ---- The init lock ----

function lockPath(project, options) {
  const base = options && typeof options.dir === 'string' ? options.dir : os.tmpdir();
  return path.join(base, `pcs-init-${keyFor(project)}`);
}

function ownerIsValid(owner) {
  return Number.isInteger(owner.pid)
    && typeof owner.startedAt === 'number'
    && typeof owner.token === 'string'
    && (owner.initPid === undefined || Number.isInteger(owner.initPid))
    && (owner.initPidAt === undefined || typeof owner.initPidAt === 'number')
    && (owner.initProxy === undefined || typeof owner.initProxy === 'boolean')
    && (owner.kind === undefined || owner.kind === 'init' || owner.kind === 'sync');
}

function readOwner(lock, options) {
  const fs = fsOf(options);
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    return ownerIsValid(owner) ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the lock at `lock` still belongs to someone who is working. A missing lock is not held. */
function held(project, lock, options) {
  const fs = fsOf(options);
  const now = clockOf(options)();
  const isAlive = aliveOf(options);
  let directory;
  try {
    directory = fs.statSync(lock);
  } catch {
    return false;
  }
  const owner = readOwner(lock, options);
  // No readable record: its owner is probably still writing it, unless it has been this way for a while.
  if (owner === undefined) return now - directory.mtimeMs < UNWRITTEN_GRACE_MS;
  if (now - owner.startedAt > LOCK_MAX_AGE_MS) return false;
  if (isAlive(owner.pid)) return true;
  if (owner.initPid !== undefined && isAlive(owner.initPid)) return true;
  // The process writing the index itself, whatever pid this session spawned or adopted: on Windows the adopted pid
  // is the shell, and a shell dies with the session that started it while the init goes on. That pid is another
  // process, so it is judged with the real process table, not with a test hook.
  if (codegraphWritingIndex(project, options)) return true;
  // Right after the spawn CodeGraph has not written its lock yet; until then the record speaks for the init.
  return owner.initProxy === true && owner.initPidAt !== undefined && now - owner.initPidAt < PROXY_TRUST_MS;
}

/** Replaces the owner record in one step, so a reader sees the old record or the new one, never none. */
function writeOwner(lock, owner, options) {
  const fs = fsOf(options);
  const draft = path.join(lock, `owner.${owner.token}.tmp`);
  fs.writeFileSync(draft, JSON.stringify(owner));
  fs.renameSync(draft, path.join(lock, 'owner.json'));
}

/**
 * Clears the stale lock at `lock`; true when the caller may try to take it again. Only the session holding the
 * takeover guard gets this far, and it checks again under the guard: another session may have taken the lock over
 * since this one judged it stale.
 */
function clearStale(project, lock, options, token) {
  const fs = fsOf(options);
  const guard = `${lock}.takeover`;
  try {
    fs.mkdirSync(guard);
  } catch {
    // Someone else is taking it over right now, or died doing it: then the next session gets its turn.
    try {
      if (clockOf(options)() - fs.statSync(guard).mtimeMs > TAKEOVER_GRACE_MS) fs.rmSync(guard, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
    return false;
  }
  try {
    if (held(project, lock, options)) return false;
    const judged = (readOwner(lock, options) || {}).token;
    const aside = `${lock}.stale-${token}`;
    try {
      fs.renameSync(lock, aside);
    } catch {
      return true; // Its owner removed it meanwhile.
    }
    if ((readOwner(aside, options) || {}).token !== judged) {
      // Not the lock judged stale: its owner left and another session took it in between. Give it back.
      try {
        fs.renameSync(aside, lock);
      } catch {
        // The lock is taken again; the moved one is lost either way.
      }
      return false;
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // Leftovers are harmless.
    }
    return true;
  } finally {
    try {
      fs.rmSync(guard, { recursive: true, force: true });
    } catch {
      // A guard left behind expires.
    }
  }
}

/**
 * Takes the init lock of `project`, for an `init` (the default) or a `sync`. Never throws: when the temp folder
 * cannot be used the session goes on as if it had the lock, which is how it behaved before locks existed.
 */
function tryAcquireInitLock(project, options = {}, kind = 'init') {
  const fs = fsOf(options);
  const lock = lockPath(project, options);
  const mine = { pid: process.pid, startedAt: clockOf(options)(), token: randomBytes(8).toString('hex'), kind };
  const adopt = (pid, adoptOptions = {}) => {
    if ((readOwner(lock, options) || {}).token !== mine.token) return;
    mine.initPid = pid;
    mine.initPidAt = clockOf(options)();
    mine.initProxy = adoptOptions.proxy === true;
    try {
      writeOwner(lock, mine, options);
    } catch {
      // The lock still holds while this session lives.
    }
  };
  const release = () => {
    // Only remove what is still ours: after a takeover the lock belongs to someone else.
    const owner = readOwner(lock, options);
    if (owner && owner.token === mine.token) fs.rmSync(lock, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      writeOwner(lock, mine, options);
      return { status: 'acquired', adopt, release };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return { status: 'acquired', adopt: () => {}, release: () => {} };
    }
    if (held(project, lock, options)) return { status: 'busy' };
    if (typeof options.onStale === 'function') {
      try {
        options.onStale();
      } catch {
        // A test hook that throws must not break the lock.
      }
    }
    if (!clearStale(project, lock, options, mine.token)) return { status: 'busy' };
  }
  return { status: 'busy' };
}

/** Whether the init lock of `project` is held right now: a session is writing the index, or CodeGraph still is. */
function isInitLocked(project, options = {}) {
  try {
    return held(project, lockPath(project, options), options);
  } catch {
    return false;
  }
}

/** Whether an init (as opposed to a sync) is running on `project` right now. Reads only. */
function isInitRunning(project, options = {}) {
  try {
    const lock = lockPath(project, options);
    if (!held(project, lock, options)) return false;
    // A record that cannot be read yet is someone writing it: counting it as an init only costs a prefetch.
    return (readOwner(lock, options) || {}).kind !== 'sync';
  } catch {
    return false;
  }
}

/** The lock as a caller injects it: one index writer at a time per project. */
const realInitLock = {
  acquire: (project, options) => tryAcquireInitLock(project, {}, options && options.kind),
  isHeld: (project) => isInitLocked(project),
  isInitRunning: (project) => isInitRunning(project),
};

// ---- The per-project sync lease ----

function stateDir(project, options) {
  const base = options && typeof options.dir === 'string' ? options.dir : os.tmpdir();
  return path.join(base, `pcs-sync-${keyFor(project)}`);
}

const leasePath = (state) => path.join(state, 'run');
const requestsPath = (state) => path.join(state, 'req');
const gatePath = (state) => path.join(state, 'gate');

function leaseIsValid(lease) {
  return Number.isInteger(lease.pid)
    && typeof lease.startedAt === 'number'
    && typeof lease.token === 'string'
    && (lease.cliPid === undefined || Number.isInteger(lease.cliPid))
    && (lease.cliPidAt === undefined || typeof lease.cliPidAt === 'number')
    && (lease.cliProxy === undefined || typeof lease.cliProxy === 'boolean');
}

function readLease(state, options) {
  const fs = fsOf(options);
  try {
    const lease = JSON.parse(fs.readFileSync(path.join(leasePath(state), 'owner.json'), 'utf8'));
    return leaseIsValid(lease) ? lease : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces the record in one step, so a reader sees the old record or the new one, never none. */
function writeLeaseRecord(state, lease, options) {
  const fs = fsOf(options);
  const draft = path.join(leasePath(state), `owner.${lease.token}.tmp`);
  fs.writeFileSync(draft, JSON.stringify(lease));
  fs.renameSync(draft, path.join(leasePath(state), 'owner.json'));
}

function takeLease(state, lease, options) {
  const fs = fsOf(options);
  fs.mkdirSync(leasePath(state));
  writeLeaseRecord(state, lease, options);
}

/** Whether the command this session started is still writing the index after the session itself is gone. */
function cliHeld(project, lease, now, options) {
  if (lease.cliPid === undefined || lease.cliPidAt === undefined) return false;
  // A sync of this package cannot last longer than its own timeout: an older record cannot name a live one.
  if (now - lease.cliPidAt > SYNC_LEASE_MAX_AGE_MS) return false;
  if (aliveOf(options)(lease.cliPid)) return true;
  if (lease.cliProxy !== true) return false;
  // On Windows the spawned shell can die while the command goes on. CodeGraph's own writer lock then names the
  // process that really writes the index; until that appears the record speaks for the command it just started.
  const busy = options && typeof options.codegraphBusy === 'function' ? options.codegraphBusy : codegraphWritingIndex;
  if (busy(project)) return true;
  return now - lease.cliPidAt < PROXY_TRUST_MS;
}

/** Whether the lease at `state` belongs to a sync of this project that is still going on. */
function leaseHeld(state, project, options) {
  const fs = fsOf(options);
  const now = clockOf(options)();
  let directory;
  try {
    directory = fs.statSync(leasePath(state));
  } catch {
    return false;
  }
  const lease = readLease(state, options);
  // No readable record: its owner is probably still writing it, unless it has been this way for a while.
  if (lease === undefined) return now - directory.mtimeMs < UNWRITTEN_GRACE_MS;
  if (now - lease.startedAt <= SYNC_LEASE_MAX_AGE_MS && aliveOf(options)(lease.pid)) return true;
  return cliHeld(project, lease, now, options);
}

/**
 * Restamps this session's record before each run. A run is bounded by its own timeout, so a session that is alive
 * and following up on requests never looks like one that is gone.
 */
function refreshLease(state, token, options) {
  const lease = readLease(state, options);
  if (lease === undefined || lease.token !== token) return;
  try {
    writeLeaseRecord(state, { pid: process.pid, startedAt: clockOf(options)(), token }, options);
  } catch {
    // The record it had is still there.
  }
}

/** Records the command this session just started, so the lease keeps speaking for it after the session dies. */
function adoptCli(state, token, pid, spawn, options) {
  const lease = readLease(state, options);
  if (lease === undefined || lease.token !== token) return;
  try {
    writeLeaseRecord(state, { ...lease, cliPid: pid, cliPidAt: clockOf(options)(), cliProxy: Boolean(spawn) && spawn.proxy === true }, options);
  } catch {
    // The session itself still holds the lease; this only covers its death.
  }
}

/** Forgets the command once the run it belonged to came back. */
function clearCli(state, token, options) {
  const lease = readLease(state, options);
  if (lease === undefined || lease.token !== token) return;
  try {
    writeLeaseRecord(state, { pid: lease.pid, startedAt: lease.startedAt, token: lease.token }, options);
  } catch {
    // The record it had is still there.
  }
}

/**
 * Removes the lease only while the record on disk proves it is still `token`'s. A record that cannot be read is not
 * proof of ownership: another session may be replacing it, or be inside the `mkdir run/` → `owner.json` window of its
 * own takeover, so the folder is left alone. Only a record-less lease older than `UNWRITTEN_GRACE_MS` was abandoned by
 * a session that died, and that one is removed so an interrupted session never wedges the project.
 */
function releaseLease(state, token, options) {
  const fs = fsOf(options);
  const lease = readLease(state, options);
  if (lease === undefined) {
    let directory;
    try {
      directory = fs.statSync(leasePath(state));
    } catch {
      return; // Nothing to release.
    }
    if (clockOf(options)() - directory.mtimeMs < UNWRITTEN_GRACE_MS) return;
  } else if (lease.token !== token) {
    return; // After a takeover the lease belongs to someone else.
  }
  try {
    fs.rmSync(leasePath(state), { recursive: true, force: true });
  } catch {
    // Leftovers expire.
  }
}

function pendingRequests(state, options) {
  try {
    return fsOf(options).readdirSync(requestsPath(state));
  } catch {
    return [];
  }
}

/** The gate could not be taken (or the state could not hold it), so nothing may be assumed about the coordination. */
const GATE_UNAVAILABLE = Symbol('gate-unavailable');

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `action` holding the short per-project mutex that the lease and the pending requests share. */
async function withGate(state, options, action) {
  const fs = fsOf(options);
  const gate = gatePath(state);
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(gate);
      break;
    } catch (error) {
      // Anything but a gate another session holds means there is no usable state to coordinate through.
      if (!error || error.code !== 'EEXIST') return GATE_UNAVAILABLE;
    }
    try {
      if (clockOf(options)() - fs.statSync(gate).mtimeMs > GATE_GRACE_MS) {
        fs.rmSync(gate, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // It is gone already.
    }
    if (Date.now() > deadline) return GATE_UNAVAILABLE;
    await pause(options && Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS);
  }
  try {
    return action();
  } finally {
    try {
      fs.rmSync(gate, { recursive: true, force: true });
    } catch {
      // A dead session's gate expires.
    }
  }
}

/**
 * Takes the lease of `state` for this session: now, or after clearing one left by a sync that is really gone.
 * Nothing is cleared unless the gate was taken for real and the lease still looks dead under it, so a live lease is
 * never removed; `unavailable` means the state could not be used at all and no sync may start (fail closed).
 */
async function claimLease(state, project, token, options) {
  const fs = fsOf(options);
  for (;;) {
    try {
      takeLease(state, { pid: process.pid, startedAt: clockOf(options)(), token }, options);
      return 'acquired';
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return 'unavailable';
    }
    if (leaseHeld(state, project, options)) return 'busy';
    const cleared = await withGate(state, options, () => {
      // Judged again under the gate: another session may have taken the lease since this one looked.
      if (leaseHeld(state, project, options)) return false;
      try {
        fs.rmSync(leasePath(state), { recursive: true, force: true });
      } catch {
        // The owner removed it.
      }
      return true;
    });
    if (cleared === GATE_UNAVAILABLE) return 'unavailable';
    if (cleared === false) return 'busy';
  }
}

/**
 * One extension-started sync per project at a time, and one follow-up per burst of requests that arrived while a run
 * was in progress. The requests of a run are deleted only after it came back, so a runner that dies inside it leaves
 * every pending request for the next session, and the lease is released under the gate only once nothing is pending.
 */
class FileSyncCoordinator {
  constructor(options = {}) {
    this.options = options || {};
  }

  async request(project, attempt) {
    const options = this.options;
    const fs = fsOf(options);
    const state = stateDir(project, options);
    const token = randomBytes(8).toString('hex');
    const marker = path.join(requestsPath(state), token);
    try {
      fs.mkdirSync(requestsPath(state), { recursive: true });
      // The request is recorded before the lease is looked at, and stays there until a run that started after it
      // has finished. A session killed mid-sync loses nothing: its demand is still on disk for the next one.
      fs.writeFileSync(marker, '');
    } catch {
      // Fail closed: without this state the package cannot tell whether another session is already syncing.
      return { status: 'unavailable' };
    }
    const deadline = Date.now() + (Number.isFinite(options.requestWaitMs) ? options.requestWaitMs : DEFAULT_REQUEST_WAIT_MS);
    for (;;) {
      // A missing marker means the run that took it has finished: the demand was served, not merely picked up.
      if (!fs.existsSync(marker)) return { status: 'coalesced' };
      if (Date.now() >= deadline) return { status: 'queued' };
      const claimed = await claimLease(state, project, token, options);
      if (claimed === 'unavailable') return { status: 'unavailable' };
      if (claimed === 'acquired') {
        const result = await this.runAsRunner(state, token, attempt);
        if (result.status === 'unavailable') return { status: 'unavailable' };
        if (result.status === 'ran') return { status: 'ran', ok: result.ok };
        // The index is locked by an init: give the lease back and wait for it like every other request.
        await withGate(state, options, () => releaseLease(state, token, options));
      }
      await pause(Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS);
    }
  }

  /** Runs the sync once for the requests already waiting, then once more per burst that arrived meanwhile. */
  async runAsRunner(state, token, attempt) {
    const options = this.options;
    try {
      for (;;) {
        const served = await withGate(state, options, () => {
          refreshLease(state, token, options);
          return pendingRequests(state, options);
        });
        if (served === GATE_UNAVAILABLE) return { status: 'unavailable' };
        const result = await attempt((pid, spawn) => adoptCli(state, token, pid, spawn, options));
        if (!result.ran) return { status: 'busy' };
        const more = await withGate(state, options, () => {
          clearCli(state, token, options);
          for (const request of served) {
            try {
              fsOf(options).rmSync(path.join(requestsPath(state), request), { force: true });
            } catch {
              // Gone already.
            }
          }
          if (pendingRequests(state, options).length > 0) return true;
          releaseLease(state, token, options);
          return false;
        });
        if (more === GATE_UNAVAILABLE) {
          // The run happened, but its demand could not be marked as served: the next sync serves it again.
          return { status: 'ran', ok: result.ok };
        }
        if (more !== true) return { status: 'ran', ok: result.ok };
      }
    } finally {
      // A throwing sync still lets the next session in; a lease already released or taken over is left alone.
      releaseLease(state, token, options);
    }
  }
}

/** The real coordinator: one per process is enough, the state is on disk. */
function syncLease(options = {}) {
  return new FileSyncCoordinator(options);
}

const realSyncLease = syncLease();

module.exports = {
  INIT_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  LOCK_MAX_AGE_MS,
  SYNC_LEASE_MAX_AGE_MS,
  UNWRITTEN_GRACE_MS,
  PROXY_TRUST_MS,
  DEFAULT_REQUEST_WAIT_MS,
  codegraphWritingIndex,
  tryAcquireInitLock,
  isInitLocked,
  isInitRunning,
  realInitLock,
  syncLease,
  realSyncLease,
};

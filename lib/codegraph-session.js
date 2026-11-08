'use strict';
// Session-scoped CodeGraph freshness for the worktree tools (S1-S6/S8/S9).
//
// Two questions, one gate. `hasCodegraph` answers "is the CLI present" once per
// process and caches it (S3), with `CODEGRAPH_FORCE=1` as the only escape (S4).
// `resolveProjectRoot` answers "which checkout does this file belong to" from
// `git -C <dir> rev-parse --show-toplevel`, cached per directory (S1).
//
// `scheduleSync` is the fire-and-forget entry the extension calls from
// `tool_result`. It never throws and never blocks: the decision object is the
// only synchronous return, and the sync itself is detached, unref'd and never
// awaited (S1). Per resolved root there is ONE debounce timer and one
// `{running, pending}` pair, so a burst of edits collapses and an edit during a
// run starts exactly ONE more afterwards (S2). Across processes an exclusive
// `<root>/.codegraph/pi-sync.lock` guards the run: a held foreign lock is
// skipped (never queued) with one bounded deferred retry, and a lock whose pid
// is dead or whose age passes the TTL is taken over (S2/S8). A root without
// `.codegraph/` is skipped (S6) and a root whose CodeGraph daemon is alive is
// skipped too, because that daemon's watcher already syncs the tree (S5). The
// process-wide switch `/codegraph-hook` flips is `setHookEnabled` below: off
// answers `hook-off` before any probe, read or lock, so nothing is spawned (S9).
//
// Every external effect is injectable through `deps` — `execFile`, `spawn`,
// `exists`, `readFile`, `now`, `setTimeout`/`clearTimeout`, `isAlive`,
// `binaryExists` — so tests never start a real child process or touch the
// network.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const DEBOUNCE_MS = 2000;
const RETRY_DELAY_MS = 5000;
const LOCK_TTL_MS = 5 * 60 * 1000;
const RUN_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_TIMEOUT_MS = 10000;
const LOCK_FILE = 'pi-sync.lock';
const DAEMON_PID_FILE = 'daemon.pid';
const CODEGRAPH_BIN = 'codegraph';

// One answer per process (S3): never re-probe, never re-read PATH.
let gateAnswer = null;
// The process-wide sync switch (S9). `null` follows the environment: enabled
// unless `CODEGRAPH_HOOK=0`, which is the persistent way to start it disabled.
let hookEnabled = null;
// One cache per directory (S1), including the null answers.
const rootCache = new Map();
// One scheduler state per resolved root (S2).
const syncStates = new Map();
let idleWaiters = [];

// --- injectable defaults -------------------------------------------------

function defaultBinaryExists(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultExecFile(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    windowsHide: true,
  });
}

function defaultSpawn(bin, args, opts) {
  return spawn(bin, args, opts);
}

function defaultReadFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // A pid owned by someone else is alive but not signalable.
    return Boolean(err && err.code === 'EPERM');
  }
}

function timers(deps) {
  return {
    setTimeout: typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout,
    clearTimeout: typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout,
  };
}

function pick(deps, name, fallback) {
  return typeof deps[name] === 'function' ? deps[name] : fallback;
}

// --- session gate (S3/S4) ------------------------------------------------

function probeOnPath(bin, env, deps) {
  const exists = pick(deps, 'binaryExists', defaultBinaryExists);
  const rawPath = (env && (env.PATH || env.Path)) || '';
  for (const dir of String(rawPath).split(path.delimiter)) {
    if (dir.length === 0) continue;
    if (exists(path.join(dir, bin))) return true;
  }
  return false;
}

// The session gate. `CODEGRAPH_FORCE=1` answers present without probing, so a
// CLI installed mid-session does not need a restart; every other answer is
// probed once and then frozen for the life of the process.
function hasCodegraph(env, deps = {}) {
  const effectiveEnv = env || process.env;
  if (effectiveEnv.CODEGRAPH_FORCE === '1') return true;
  if (gateAnswer === null) gateAnswer = probeOnPath(CODEGRAPH_BIN, effectiveEnv, deps || {});
  return gateAnswer;
}

function resetCodegraphGate() {
  gateAnswer = null;
}

// --- sync hook switch (S9) ----------------------------------------------

// The switch is process-wide and in memory only: nothing is written to user
// configuration. `on`/`off` from the command set it explicitly; no argument
// toggles whatever it currently reads.
function isHookEnabled(env) {
  if (hookEnabled !== null) return hookEnabled;
  return (env || process.env).CODEGRAPH_HOOK !== '0';
}

function setHookEnabled(enabled) {
  hookEnabled = enabled !== false;
}

// --- project root (S1) --------------------------------------------------

function resolveProjectRoot(dir, deps = {}) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const key = path.resolve(dir);
  if (rootCache.has(key)) return rootCache.get(key);
  const execFile = pick(deps, 'execFile', defaultExecFile);
  let root = null;
  try {
    const out = execFile('git', ['-C', key, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS });
    const text = typeof out === 'string' ? out : out && typeof out.stdout === 'string' ? out.stdout : '';
    const trimmed = text.trim();
    if (trimmed.length > 0) root = trimmed;
  } catch {
    root = null;
  }
  rootCache.set(key, root);
  return root;
}

// --- lock (S2/S8) -------------------------------------------------------

function writeLock(lockPath, pid, now) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid, startedAt: now }));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// `{ok:true}` when this process owns the lock; `{ok:false}` when a live foreign
// lock holds it. A lock whose content is unreadable, whose pid is dead or whose
// age passes the TTL is stale and is taken over. Two processes racing on the
// takeover cannot both win: the second `wx` create loses.
function acquireLock(lockPath, deps) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const pid = Number.isInteger(deps.pid) ? deps.pid : process.pid;
  const ttl = typeof deps.lockTtlMs === 'number' ? deps.lockTtlMs : LOCK_TTL_MS;
  const readFile = pick(deps, 'readFile', defaultReadFile);
  const isAlive = pick(deps, 'isAlive', defaultIsAlive);

  if (writeLock(lockPath, pid, now)) return { ok: true };

  let held = null;
  try {
    held = JSON.parse(readFile(lockPath));
  } catch {
    held = null;
  }
  const heldPid = held && Number.parseInt(held.pid, 10);
  const heldAt = held && Number(held.startedAt);
  const stale = !held
    || !Number.isInteger(heldPid) || heldPid <= 0
    || !Number.isFinite(heldAt) || (now - heldAt) > ttl
    || !isAlive(heldPid);
  if (!stale) return { ok: false };

  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Another process already took the stale lock over; the create below
    // decides who wins.
  }
  return writeLock(lockPath, pid, now) ? { ok: true } : { ok: false };
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone (a takeover) or never created: nothing to release.
  }
}

// --- one background run -------------------------------------------------

// Resolves when the child is launched AND finished (its `close`/`error`), so the
// in-process `running` flag covers the whole sync while the caller never waits
// for it. The lock is held for the same span: a parallel Pi session skips
// instead of racing another sync on the same checkout.
function runSync(root, deps) {
  const lockPath = path.join(root, '.codegraph', LOCK_FILE);
  let lock;
  try {
    lock = acquireLock(lockPath, deps);
  } catch {
    return Promise.resolve('lock-error');
  }
  if (!lock.ok) return Promise.resolve('locked');

  return new Promise((resolve) => {
    let child;
    try {
      child = pick(deps, 'spawn', defaultSpawn)(CODEGRAPH_BIN, ['sync', root], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: deps.env || process.env,
      });
    } catch {
      releaseLock(lockPath);
      resolve('spawn-failed');
      return;
    }
    if (child && typeof child.unref === 'function') {
      try {
        child.unref();
      } catch {
        // An unref failure never changes the outcome.
      }
    }
    let settled = false;
    const timeoutMs = typeof deps.runTimeoutMs === 'number' ? deps.runTimeoutMs : RUN_TIMEOUT_MS;
    let watchdog = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      releaseLock(lockPath);
      resolve('spawned');
    };
    // A sync that hangs keeps the lock and the root's `running` flag, which would
    // wedge that checkout for the rest of the session. Bound it: one SIGTERM, then
    // settle regardless, so the state and the lock come back.
    const t = timers(deps);
    watchdog = t.setTimeout(() => {
      watchdog = null;
      if (child && typeof child.kill === 'function') {
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
      }
      done();
    }, timeoutMs);
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
    if (!child || typeof child.once !== 'function') {
      // No event surface (a minimal double): the launch itself is the end.
      done();
      return;
    }
    child.once('close', done);
    child.once('error', done);
  });
}

function isQuiescent() {
  for (const state of syncStates.values()) {
    if (state.running || state.timer !== null || state.retryTimer !== null) return false;
  }
  return true;
}

function settleIdleWaiters() {
  if (idleWaiters.length === 0 || !isQuiescent()) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

function beginRun(root, state, deps) {
  state.running = true;
  void runSync(root, deps).then((outcome) => {
    state.running = false;
    if (outcome === 'locked' && !state.retried) {
      // One bounded retry: the last edit before a foreign sync still lands,
      // and a lock that stays held never becomes a busy loop.
      state.retried = true;
      const delay = typeof deps.retryDelayMs === 'number' ? deps.retryDelayMs : RETRY_DELAY_MS;
      state.retryTimer = timers(deps).setTimeout(() => {
        state.retryTimer = null;
        beginRun(root, state, deps);
      }, delay);
      return;
    }
    if (outcome !== 'locked') state.retried = false;
    if (state.pending) {
      state.pending = false;
      state.retried = false;
      beginRun(root, state, deps);
      return;
    }
    settleIdleWaiters();
  }).catch(() => {
    state.running = false;
    state.pending = false;
    settleIdleWaiters();
  });
}

// CodeGraph 1.6 writes `{pid, version, socketPath, startedAt}` to daemon.pid and
// tolerates a bare decimal from older versions, so read both shapes.
function daemonPidOf(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{')) {
    try {
      const info = JSON.parse(raw);
      const pid = Number(info && info.pid);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function daemonAlive(codegraphDir, deps) {
  const readFile = pick(deps, 'readFile', defaultReadFile);
  const isAlive = pick(deps, 'isAlive', defaultIsAlive);
  let text;
  try {
    text = readFile(path.join(codegraphDir, DAEMON_PID_FILE));
  } catch {
    return false;
  }
  const pid = daemonPidOf(text);
  return pid !== null && isAlive(pid);
}

// --- entry point --------------------------------------------------------

// The extension's fire-and-forget entry (S1). Never throws, never waits:
// `{scheduled, reason}` describes what was decided, and settled work is
// observable through `whenIdle()`.
function scheduleSync(filePath, deps = {}) {
  const effectiveDeps = deps || {};
  try {
    if (typeof filePath !== 'string' || filePath.length === 0) return { scheduled: false, reason: 'no-path' };
    const env = effectiveDeps.env || process.env;
    // The user's switch wins over everything below: off means no root read, no
    // daemon read, no lock and no child.
    if (!isHookEnabled(env)) return { scheduled: false, reason: 'hook-off' };
    if (!hasCodegraph(env, effectiveDeps)) return { scheduled: false, reason: 'no-codegraph' };
    const root = resolveProjectRoot(path.dirname(path.resolve(filePath)), effectiveDeps);
    if (root === null) return { scheduled: false, reason: 'no-root' };

    const codegraphDir = path.join(root, '.codegraph');
    const exists = pick(effectiveDeps, 'exists', fs.existsSync);
    if (!exists(codegraphDir)) return { scheduled: false, reason: 'no-index' };
    if (daemonAlive(codegraphDir, effectiveDeps)) return { scheduled: false, reason: 'daemon' };

    let state = syncStates.get(root);
    if (state === undefined) {
      state = { timer: null, retryTimer: null, running: false, pending: false, retried: false };
      syncStates.set(root, state);
    }
    if (state.running) {
      state.pending = true;
      return { scheduled: true, reason: 'queued' };
    }
    const t = timers(effectiveDeps);
    if (state.timer !== null) t.clearTimeout(state.timer);
    state.retried = false;
    const delay = typeof effectiveDeps.debounceMs === 'number' ? effectiveDeps.debounceMs : DEBOUNCE_MS;
    state.timer = t.setTimeout(() => {
      state.timer = null;
      beginRun(root, state, effectiveDeps);
    }, delay);
    return { scheduled: true, reason: 'scheduled' };
  } catch {
    return { scheduled: false, reason: 'error' };
  }
}

// Resolves when no root has a timer, a retry or a run in flight, so a test can
// await settled work without sleeping.
function whenIdle() {
  if (isQuiescent()) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

// Test-only full reset: the gate, the hook switch, both caches and the waiters.
function resetCodegraphSession() {
  gateAnswer = null;
  hookEnabled = null;
  rootCache.clear();
  syncStates.clear();
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

module.exports = {
  hasCodegraph,
  isHookEnabled,
  setHookEnabled,
  resetCodegraphGate,
  resetCodegraphSession,
  resolveProjectRoot,
  scheduleSync,
  whenIdle,
};

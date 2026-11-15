'use strict';
// The two pieces of index coordination (S3), through their public surface: one init lock per project, and one
// per-project sync lease shared by the sessions of this user. No real codegraph ever runs here: the attempts are
// injected, and the multi-process cases use a fixture session that speaks the same public API.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  LOCK_MAX_AGE_MS,
  PROXY_TRUST_MS,
  codegraphWritingIndex,
  isInitLocked,
  isInitRunning,
  realInitLock,
  realSyncLease,
  syncLease,
  tryAcquireInitLock,
} = require('../lib/codegraph-lock.js');

const WORKER = path.join(__dirname, 'fixtures', 'codegraph-lock-worker.js');
const scratchDirs = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: the system temp directory is the owner.
    }
  }
});

function temp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

/** A state folder and a project of their own, so these cases never meet the user's locks. */
function scratch() {
  return { dir: temp('cg-lock-state-'), project: temp('cg-lock-project-') };
}

const lockEntries = (dir) => fs.readdirSync(dir).filter((entry) => entry.startsWith('pcs-init-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntilGone = async (pid, deadlineMs) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await pause(100);
  }
  return false;
};

// ---- The init lock ----

test('S3: the first session gets the lock, a second one finds it busy, and releasing frees it', () => {
  const { dir, project } = scratch();
  const first = tryAcquireInitLock(project, { dir });
  assert.equal(first.status, 'acquired');
  assert.equal(isInitLocked(project, { dir }), true);
  assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: 'busy' });
  first.release();
  assert.equal(isInitLocked(project, { dir }), false);
  assert.deepEqual(lockEntries(dir), []);
  const again = tryAcquireInitLock(project, { dir });
  assert.equal(again.status, 'acquired');
  again.release();
});

test('S3: without a lock nothing reads as locked', () => {
  const { dir, project } = scratch();
  assert.equal(isInitLocked(project, { dir }), false);
  assert.equal(isInitRunning(project, { dir }), false);
});

test('S3: different projects have independent locks', () => {
  const { dir, project } = scratch();
  const other = scratch().project;
  const a = tryAcquireInitLock(project, { dir });
  const b = tryAcquireInitLock(other, { dir });
  assert.equal(a.status, 'acquired');
  assert.equal(b.status, 'acquired');
  assert.equal(isInitLocked(other, { dir }), true);
  a.release();
  assert.equal(isInitLocked(other, { dir }), true);
  b.release();
});

test('S3: the same project spelled with a trailing separator shares one lock', () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir });
  assert.equal(held.status, 'acquired');
  const spellings = [project + (process.platform === 'win32' ? '\\' : '/')];
  if (process.platform === 'win32') spellings.push(project.toUpperCase(), project.toLowerCase());
  for (const spelling of spellings) {
    assert.deepEqual(tryAcquireInitLock(spelling, { dir }), { status: 'busy' }, spelling);
    assert.equal(isInitLocked(spelling, { dir }), true, spelling);
  }
  held.release();
});

test('S3: a lock whose process is gone is stale: the next session takes it over', () => {
  const { dir, project } = scratch();
  const dead = tryAcquireInitLock(project, { dir });
  assert.equal(dead.status, 'acquired');
  assert.equal(isInitLocked(project, { dir, isAlive: () => false }), false);
  const taken = tryAcquireInitLock(project, { dir, isAlive: () => false });
  assert.equal(taken.status, 'acquired');
  taken.release();
});

test('S3: a lock older than the longest an init can run is stale even if its pid looks alive', () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir, now: () => Date.now() - LOCK_MAX_AGE_MS - 1_000 });
  assert.equal(held.status, 'acquired');
  assert.equal(isInitLocked(project, { dir, isAlive: () => true }), false);
  const taken = tryAcquireInitLock(project, { dir, isAlive: () => true });
  assert.equal(taken.status, 'acquired');
  taken.release();
});

test('S3: a lock directory that is still being written counts as held; an abandoned one does not', () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir });
  const lockDir = path.join(dir, lockEntries(dir)[0]);
  held.release();
  fs.mkdirSync(lockDir);
  assert.equal(isInitLocked(project, { dir }), true, 'fresh and empty: the owner has not written its record yet');
  const longAgo = new Date(Date.now() - 120_000);
  fs.utimesSync(lockDir, longAgo, longAgo);
  assert.equal(isInitLocked(project, { dir }), false, 'empty for two minutes: abandoned');
  const taken = tryAcquireInitLock(project, { dir });
  assert.equal(taken.status, 'acquired');
  taken.release();
});

test('S3: a damaged owner record is treated like an abandoned lock once it is old enough', () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir });
  const lockDir = path.join(dir, lockEntries(dir)[0]);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), 'not json');
  const longAgo = new Date(Date.now() - 120_000);
  fs.utimesSync(lockDir, longAgo, longAgo);
  assert.equal(isInitLocked(project, { dir }), false);
  held.release();
});

test('S3: releasing never removes a lock that now belongs to someone else', () => {
  const { dir, project } = scratch();
  const mine = tryAcquireInitLock(project, { dir });
  assert.equal(mine.status, 'acquired');
  const taken = tryAcquireInitLock(project, { dir, isAlive: () => false });
  assert.equal(taken.status, 'acquired');
  mine.release();
  assert.equal(isInitLocked(project, { dir }), true, "the new owner's lock must survive the old owner's release");
  taken.release();
});

test('S3: an unusable lock directory never throws: the session simply goes on as if it had the lock', () => {
  const project = scratch().project;
  const dir = path.join(temp('cg-lock-missing-'), 'gone', 'deeper');
  const attempt = tryAcquireInitLock(project, { dir });
  assert.equal(attempt.status, 'acquired');
  attempt.adopt(4242);
  attempt.release();
  assert.equal(isInitLocked(project, { dir }), false);
});

/**
 * `count` sessions that all try at the same instant. The winner keeps the lock until every session has tried: on a
 * busy machine a worker can reach the start line after a fixed hold has ended, and then it rightly takes the lock.
 */
async function sessionsAtOnce(dir, project, count) {
  const startAt = Date.now() + 800;
  const sessions = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, [WORKER, dir, project, String(startAt), 'stdin', 'lock'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise((resolve) => child.once('close', () => resolve()));
    const result = new Promise((resolve) => {
      let out = '';
      const done = () => {
        try {
          resolve(JSON.parse(out.trim().split('\n')[0]));
        } catch {
          resolve({ status: `worker produced no result: ${out.slice(0, 80)}`, pid: 0 });
        }
      };
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) done();
      });
      void closed.then(done);
    });
    return { child, closed, result };
  });
  const results = await Promise.all(sessions.map((session) => session.result));
  // Every session has tried: now the winner may let go.
  for (const session of sessions) session.child.stdin.end();
  await Promise.all(sessions.map((session) => session.closed));
  return results;
}

test('S3: sessions that try at the very same instant: exactly one gets the lock, every time', async () => {
  for (const sessions of [2, 4]) {
    for (let round = 0; round < 2; round++) {
      const { dir, project } = scratch();
      const results = await sessionsAtOnce(dir, project, sessions);
      const winners = results.filter((result) => result.status === 'acquired').length;
      const busy = results.filter((result) => result.status === 'busy').length;
      assert.deepEqual({ winners, busy }, { winners: 1, busy: sessions - 1 }, `${sessions} sessions, round ${round}: ${JSON.stringify(results)}`);
      assert.deepEqual(lockEntries(dir), [], `${sessions} sessions, round ${round}: the winner released the lock`);
    }
  }
});

test('S3: a holder that is killed leaves a lock the next session recognises as stale', async () => {
  const { dir, project } = scratch();
  const child = spawn(process.execPath, [WORKER, dir, project, '0', '60000', 'lock'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', () => resolve()));
  assert.equal(isInitLocked(project, { dir }), true);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  assert.equal(fs.existsSync(path.join(dir, lockEntries(dir)[0])), true, 'a killed process cannot clean up after itself');
  assert.equal(isInitLocked(project, { dir }), false);
  const taken = tryAcquireInitLock(project, { dir });
  assert.equal(taken.status, 'acquired');
  taken.release();
});

test('S3: two sessions that both find the same stale lock: only one of them takes it over', () => {
  const { dir, project } = scratch();
  const old = tryAcquireInitLock(project, { dir, now: () => Date.now() - LOCK_MAX_AGE_MS - 1_000 });
  assert.equal(old.status, 'acquired');
  let rival;
  // The rival runs its whole attempt right after this session judged the lock stale and before it cleared it.
  const mine = tryAcquireInitLock(project, {
    dir,
    onStale: () => {
      if (rival === undefined) rival = tryAcquireInitLock(project, { dir });
    },
  });
  assert.ok(rival, 'the race window was reached');
  assert.deepEqual([mine.status, rival.status].sort(), ['acquired', 'busy']);
  assert.equal(isInitLocked(project, { dir }), true);
  for (const attempt of [mine, rival]) if (attempt.status === 'acquired') attempt.release();
  assert.deepEqual(lockEntries(dir), [], 'the winner release leaves nothing behind, takeover guard included');
});

test('S3: a takeover guard left by a session that died mid-takeover does not block the lock for good', () => {
  const { dir, project } = scratch();
  const old = tryAcquireInitLock(project, { dir, now: () => Date.now() - LOCK_MAX_AGE_MS - 1_000 });
  assert.equal(old.status, 'acquired');
  const guard = path.join(dir, `${lockEntries(dir)[0]}.takeover`);
  fs.mkdirSync(guard);
  assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: 'busy' }, 'a fresh guard: someone is taking over right now');
  const longAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(guard, longAgo, longAgo);
  let taken = tryAcquireInitLock(project, { dir });
  if (taken.status === 'busy') taken = tryAcquireInitLock(project, { dir });
  assert.equal(taken.status, 'acquired');
  taken.release();
  assert.deepEqual(lockEntries(dir), []);
});

test('S3: the lock stays held while the init process lives, even when the session that took it is gone', () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir });
  assert.equal(held.status, 'acquired');
  held.adopt(424242);
  assert.equal(isInitLocked(project, { dir, isAlive: (pid) => pid === 424242 }), true, 'session gone, init alive');
  assert.equal(isInitLocked(project, { dir, isAlive: (pid) => pid === process.pid }), true, 'session alive');
  assert.equal(isInitLocked(project, { dir, isAlive: () => false }), false, 'both gone');
  assert.deepEqual(tryAcquireInitLock(project, { dir, isAlive: (pid) => pid === 424242 }), { status: 'busy' });
  held.release();
  assert.deepEqual(lockEntries(dir), []);
});

test('S3 real: a session that exits while its init process goes on leaves the lock held until that process ends', async () => {
  const { dir, project } = scratch();
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, dir, project, '0', '30000', 'orphan'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.on('close', () => resolve(text));
  });
  const { status, initPid } = JSON.parse(out.trim());
  assert.equal(status, 'acquired');
  try {
    assert.equal(isInitLocked(project, { dir }), true, 'the session is gone but its init is not');
    assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: 'busy' });
  } finally {
    process.kill(initPid);
  }
  await pause(500);
  assert.equal(isInitLocked(project, { dir }), false, 'once the init is gone too, the lock is stale');
});

test('S3: the adopted pid is written atomically: a reader never sees the record vanish', () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir });
  assert.equal(held.status, 'acquired');
  for (let i = 0; i < 200; i++) {
    held.adopt(1000 + i);
    assert.equal(isInitLocked(project, { dir, isAlive: (pid) => pid === 1000 + i }), true, `round ${i}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, lockEntries(dir)[0])), ['owner.json'], 'no temporary files left behind');
  held.release();
});

test('S3: a record that adopted the init process itself is stale as soon as that process is gone', () => {
  const { dir, project } = scratch();
  const start = Date.now();
  const held = tryAcquireInitLock(project, { dir, now: () => start });
  assert.equal(held.status, 'acquired');
  held.adopt(424242);
  // Nothing to wait for: the pid that was adopted is the process that does the work.
  assert.equal(isInitLocked(project, { dir, isAlive: () => false, now: () => start + 1 }), false);
  const taken = tryAcquireInitLock(project, { dir, isAlive: () => false, now: () => start + 1 });
  assert.equal(taken.status, 'acquired');
  taken.release();
  held.release();
});

test("S3: while a CodeGraph process writes the index, the lock stays held whatever pid the session adopted", () => {
  const { dir, project } = scratch();
  const held = tryAcquireInitLock(project, { dir });
  assert.equal(held.status, 'acquired');
  // The pid this session adopted was the shell, and it is gone; the init itself goes on and says so in
  // CodeGraph's own lock, which is the pid that decides.
  held.adopt(424242, { proxy: true });
  fs.mkdirSync(path.join(project, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(project, '.codegraph', 'codegraph.lock'), String(process.pid));
  assert.equal(isInitLocked(project, { dir, isAlive: () => false }), true, 'the init is alive, the session and its shell are not');
  assert.deepEqual(tryAcquireInitLock(project, { dir, isAlive: () => false }), { status: 'busy' });
  held.release();
  assert.equal(isInitLocked(project, { dir }), false, "the record is gone: CodeGraph's lock alone never holds it");
});

test('S3: right after a shell spawned the init, before CodeGraph writes its own lock, the record is still trusted', () => {
  const { dir, project } = scratch();
  const start = Date.now();
  const held = tryAcquireInitLock(project, { dir, now: () => start });
  assert.equal(held.status, 'acquired');
  held.adopt(424242, { proxy: true });
  const dead = { isAlive: () => false };
  assert.equal(isInitLocked(project, { dir, ...dead, now: () => start + 1_000 }), true, 'the shell died and the init has not shown up yet');
  assert.deepEqual(tryAcquireInitLock(project, { dir, ...dead, now: () => start + 1_000 }), { status: 'busy' });
  const later = start + PROXY_TRUST_MS + 1;
  assert.equal(isInitLocked(project, { dir, ...dead, now: () => later }), false, 'after that window no init ever showed up: stale');
  const taken = tryAcquireInitLock(project, { dir, ...dead, now: () => later });
  assert.equal(taken.status, 'acquired');
  taken.release();
  held.release();
});

test('S3: a sync holder locks the index for an init but is not an init running', () => {
  const { dir, project } = scratch();
  const sync = tryAcquireInitLock(project, { dir }, 'sync');
  assert.equal(sync.status, 'acquired');
  assert.equal(isInitLocked(project, { dir }), true, 'the index is being written by this package');
  assert.equal(isInitRunning(project, { dir }), false, 'a sync is not an init');
  assert.deepEqual(tryAcquireInitLock(project, { dir }, 'init'), { status: 'busy' }, 'an init cannot start while the sync runs');
  assert.deepEqual(tryAcquireInitLock(project, { dir }, 'sync'), { status: 'busy' }, 'nor a second sync');
  sync.release();
  assert.equal(isInitLocked(project, { dir }), false);
  assert.equal(isInitRunning(project, { dir }), false);
});

test('S3: an init holder is both locked and an init running', () => {
  const { dir, project } = scratch();
  const init = tryAcquireInitLock(project, { dir });
  assert.equal(init.status, 'acquired');
  assert.equal(isInitLocked(project, { dir }), true);
  assert.equal(isInitRunning(project, { dir }), true);
  assert.deepEqual(tryAcquireInitLock(project, { dir }, 'sync'), { status: 'busy' }, 'a sync cannot start while the init runs');
  init.release();
});

test('S3: the kind of a holder survives adopting the process it started', () => {
  const { dir, project } = scratch();
  const sync = tryAcquireInitLock(project, { dir }, 'sync');
  assert.equal(sync.status, 'acquired');
  sync.adopt(424242);
  assert.equal(isInitLocked(project, { dir }), true);
  assert.equal(isInitRunning(project, { dir }), false);
  sync.release();
});

test('S3 real: the shell of a spawned init dies while the init goes on: the lock stays held and no session takes it over', async () => {
  const { dir, project } = scratch();
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, dir, project, '0', '30000', 'shell'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.on('close', () => resolve(text));
  });
  const { status, initPid: shellPid } = JSON.parse(out.trim());
  assert.equal(status, 'acquired');
  let initPid = 0;
  try {
    initPid = Number(fs.readFileSync(path.join(project, '.codegraph', 'codegraph.lock'), 'utf8'));
  } catch {
    // Reported below.
  }
  assert.ok(initPid > 0, `the init announced itself in CodeGraph's own lock: ${out.trim()}`);
  try {
    // The session is gone. On Windows its shell went with it; elsewhere the Pi that owned it would kill it.
    if (!(await waitUntilGone(shellPid, 3_000))) process.kill(shellPid);
    assert.ok(await waitUntilGone(shellPid, 5_000), 'the shell really is gone');
    process.kill(initPid, 0);
    assert.equal(isInitLocked(project, { dir }), true, 'nobody is left to speak for the lock but the init itself');
    assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: 'busy' }, 'a new session must not start a second init');
  } finally {
    try {
      process.kill(initPid);
    } catch {
      // It is gone already.
    }
  }
  assert.ok(await waitUntilGone(initPid, 10_000), 'the init is gone too');
  assert.equal(isInitLocked(project, { dir }), true, 'its pid is no longer alive, but the shell was never proof of death');
  assert.equal(isInitLocked(project, { dir, now: () => Date.now() + PROXY_TRUST_MS + 1_000 }), false, 'past that window the lock is stale again');
});

test("S3: CodeGraph's own lock names the process writing the index, and counts only a live one", async () => {
  const dir = temp('cg-writing-');
  fs.mkdirSync(path.join(dir, '.codegraph'));
  const lock = path.join(dir, '.codegraph', 'codegraph.lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.equal(codegraphWritingIndex(dir), true);
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolve) => gone.on('close', resolve));
  fs.writeFileSync(lock, String(gone.pid));
  assert.equal(codegraphWritingIndex(dir), false, `dead pid ${gone.pid}`);
  fs.writeFileSync(lock, 'not a pid');
  assert.equal(codegraphWritingIndex(dir), false);
  fs.writeFileSync(lock, '');
  assert.equal(codegraphWritingIndex(dir), false);
  fs.rmSync(lock);
  assert.equal(codegraphWritingIndex(dir), false);
  assert.equal(codegraphWritingIndex(path.join(dir, 'nowhere')), false);
});

test('S3: the module exports the real init lock a caller can wire without a folder of its own', () => {
  assert.equal(typeof realInitLock.acquire, 'function');
  assert.equal(typeof realInitLock.isHeld, 'function');
  assert.equal(typeof realInitLock.isInitRunning, 'function');
  assert.equal(typeof realSyncLease.request, 'function');
});

// ---- The per-project sync lease ----

function lease(prefix) {
  return syncLease({ dir: temp(prefix), pollMs: 5, requestWaitMs: 20_000 });
}

/** A run that fails the test if two of them overlap, and records when each one started. */
function guardedRun(runs, state, holdMs) {
  return async () => {
    assert.equal(state.running, false, 'two syncs of one project ran at the same time');
    state.running = true;
    runs.push({ start: Date.now() });
    try {
      await pause(holdMs);
    } finally {
      state.running = false;
    }
    return { ran: true, ok: true };
  };
}

test('S3: a request during a running sync becomes exactly one follow-up, never a simultaneous run', async () => {
  const { project } = scratch();
  const coordinator = lease('cg-lease-');
  const runs = [];
  const state = { running: false };
  const run = guardedRun(runs, state, 300);
  const first = coordinator.request(project, run);
  await pause(50);
  const requestedAt = [Date.now()];
  const second = coordinator.request(project, run);
  await pause(10);
  requestedAt.push(Date.now());
  const third = coordinator.request(project, run);
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual(a, { status: 'ran', ok: true });
  assert.deepEqual(b, { status: 'coalesced' });
  assert.deepEqual(c, { status: 'coalesced' });
  assert.equal(runs.length, 2, 'one run plus one follow-up for both requests together');
  // Neither request was dropped: each is covered by a run that started after it was made.
  for (const at of requestedAt) assert.ok(runs.some((entry) => entry.start >= at), `request at ${at} is covered: ${JSON.stringify(runs)}`);
});

test('S3: a request that arrives during the follow-up is served by a further one, so no demand is lost', async () => {
  const { project } = scratch();
  const coordinator = lease('cg-lease-');
  const runs = [];
  const state = { running: false };
  const run = guardedRun(runs, state, 250);
  const first = coordinator.request(project, run);
  await pause(50);
  const second = coordinator.request(project, run);
  // The follow-up starts when the first run ends; ask again inside it.
  await pause(250);
  const thirdAt = Date.now();
  const third = coordinator.request(project, run);
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual(a, { status: 'ran', ok: true });
  assert.deepEqual(b, { status: 'coalesced' });
  assert.deepEqual(c, { status: 'coalesced' });
  assert.equal(runs.length, 3, `each request gets a run after it: ${JSON.stringify(runs)}`);
  assert.ok(runs.some((entry) => entry.start >= thirdAt));
});

test('S3: a run that fails still lets the next request through', async () => {
  const { project } = scratch();
  const coordinator = lease('cg-lease-');
  const failed = await coordinator.request(project, async () => ({ ran: true, ok: false }));
  assert.deepEqual(failed, { status: 'ran', ok: false });
  const again = await coordinator.request(project, async () => ({ ran: true, ok: true }));
  assert.deepEqual(again, { status: 'ran', ok: true }, 'the lease of a failed run is released');
});

test('S3: a run that cannot get the index leaves the demand pending and says queued, never coalesced', async () => {
  const { project } = scratch();
  const coordinator = syncLease({ dir: temp('cg-lease-'), pollMs: 5, requestWaitMs: 200 });
  const outcome = await coordinator.request(project, async () => ({ ran: false }));
  assert.deepEqual(outcome, { status: 'queued' }, 'no run happened: coalesced would be a lie');
});

test('S3: different projects sync independently, and one folder spelled two ways is one lease', async () => {
  const { project } = scratch();
  const other = scratch().project;
  const coordinator = lease('cg-lease-');
  const [a, b] = await Promise.all([
    coordinator.request(project, guardedRun([], { running: false }, 200)),
    coordinator.request(other, guardedRun([], { running: false }, 200)),
  ]);
  assert.deepEqual([a.status, b.status], ['ran', 'ran']);

  const runs = [];
  const state = { running: false };
  const respelled = process.platform === 'win32' ? project.toUpperCase() : `${project}/`;
  const first = coordinator.request(project, guardedRun(runs, state, 300));
  await pause(50);
  const second = coordinator.request(respelled, guardedRun(runs, state, 50));
  const [c, d] = await Promise.all([first, second]);
  assert.deepEqual(c, { status: 'ran', ok: true });
  assert.deepEqual(d, { status: 'coalesced' }, 'another spelling of one folder is the same project');
});

test('S3: unusable coordination state starts no sync at all (fail closed)', async () => {
  const file = path.join(temp('cg-lease-file-'), 'not-a-directory');
  fs.writeFileSync(file, '');
  let ran = false;
  const outcome = await syncLease({ dir: file, pollMs: 5, requestWaitMs: 500 }).request(scratch().project, async () => {
    ran = true;
    return { ran: true, ok: true };
  });
  assert.equal(ran, false, 'without its coordination state the package does not risk a second sync');
  assert.deepEqual(outcome, { status: 'unavailable' });
});

// ---- Across processes: cooperative sessions of this user sharing the same temp folder ----

const ledgerPath = (project) => path.join(project, 'runs.log');
const ledgerText = (project) => {
  try {
    return fs.readFileSync(ledgerPath(project), 'utf8');
  } catch {
    return '';
  }
};
const starts = (text) => text.split('\n').filter((line) => line.startsWith('start ')).length;
const lineTime = (text, prefix) => {
  const line = text.split('\n').find((entry) => entry.startsWith(`${prefix} `));
  return line === undefined ? undefined : Number(line.split(' ')[1]);
};

/** One worker session; `firstLine` resolves with the first JSON line it prints, `result` when it ends. */
function runWorker(dir, project, holdMs, mode = 'sync', startAt = 0) {
  const child = spawn(process.execPath, [WORKER, dir, project, String(startAt), String(holdMs), mode], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  let announced = false;
  let announce = () => {};
  const firstLine = new Promise((resolve) => {
    announce = resolve;
  });
  const read = () => {
    if (announced || !out.includes('\n')) return;
    announced = true;
    try {
      announce(JSON.parse(out.trim().split('\n')[0]));
    } catch {
      announce({ pid: 0, requestedAt: 0, returnedAt: 0, outcome: { status: 'unavailable' } });
    }
  };
  child.stdout.on('data', (chunk) => {
    out += chunk;
    read();
  });
  const result = new Promise((resolve) => {
    child.on('close', () => {
      read();
      try {
        resolve(JSON.parse(out.trim().split('\n')[0]));
      } catch {
        resolve({ pid: 0, requestedAt: 0, returnedAt: 0, outcome: { status: 'unavailable' } });
      }
    });
  });
  return { child, firstLine, result };
}

async function waitFor(check, what, deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (check()) return;
    await pause(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The runs the workers recorded: their start and end. A run whose end was never written was killed. */
function recordedRuns(project) {
  const intervals = [];
  for (const line of ledgerText(project).split('\n').filter(Boolean)) {
    const [kind, at] = line.split(' ');
    if (kind === 'start') intervals.push({ start: Number(at), end: Number.POSITIVE_INFINITY });
    else if (kind === 'end' && intervals.length > 0) intervals[intervals.length - 1].end = Number(at);
  }
  return intervals.filter((interval) => Number.isFinite(interval.end));
}

test('S3 real: sessions asking at the same instant: one runs, the others leave their demand to it, never two at once', { timeout: 120_000 }, async () => {
  for (const sessions of [2, 3]) {
    const { dir, project } = scratch();
    const startAt = Date.now() + 2_000;
    const results = await Promise.all(Array.from({ length: sessions }, () => runWorker(dir, project, 600, 'sync', startAt).result));
    const runners = results.filter((result) => result.outcome.status === 'ran');
    const waiters = results.filter((result) => result.outcome.status !== 'ran');
    // A session whose marker lands after the runner's pending-requests snapshot legitimately becomes one
    // follow-up of that run, so "exactly one runner" is stricter than the real guarantee. What must always hold:
    // every demand served, nothing overlapped, at most one follow-up.
    assert.ok(runners.length >= 1 && runners.length <= 2, `${sessions} sessions, at most one follow-up: ${JSON.stringify(results)}`);
    assert.ok(waiters.every((result) => result.outcome.status === 'coalesced'), JSON.stringify(results));
    const runs = recordedRuns(project);
    assert.ok(runs.length >= 1 && runs.length <= 2, `${sessions} sessions, at most one follow-up: ${JSON.stringify(runs)}`);
    for (let index = 1; index < runs.length; index++) {
      assert.ok(runs[index].start >= runs[index - 1].end, `no two syncs overlapped: ${JSON.stringify(runs)}`);
    }
    for (const waiter of waiters) {
      assert.ok(runs.some((entry) => entry.start >= waiter.requestedAt), `the demand of ${waiter.pid} was not lost: ${JSON.stringify(waiter)} ${JSON.stringify(runs)}`);
    }
    const leftovers = fs.readdirSync(dir).filter((entry) => entry.startsWith('pcs-sync-')).filter((entry) => fs.existsSync(path.join(dir, entry, 'run')));
    assert.deepEqual(leftovers, [], `leftover leases in ${dir}`);
  }
});

test('S3 real: a session that asks while another one is syncing is coalesced into exactly one follow-up', { timeout: 120_000 }, async () => {
  const { dir, project } = scratch();
  const running = runWorker(dir, project, 1500);
  await waitFor(() => starts(ledgerText(project)) >= 1, 'the first run to start');
  const requestedAt = Date.now();
  const late = runWorker(dir, project, 100);
  const [first, second] = await Promise.all([running.result, late.result]);
  assert.deepEqual(first.outcome, { status: 'ran', ok: true });
  assert.deepEqual(second.outcome, { status: 'coalesced' });
  const runs = recordedRuns(project);
  assert.equal(runs.length, 2, `one run plus exactly one follow-up: ${JSON.stringify(runs)}`);
  assert.ok(runs[1].start >= runs[0].end, `the follow-up started after the run it was coalesced into: ${JSON.stringify(runs)}`);
  assert.ok(runs[1].start >= requestedAt, 'the follow-up serves the request that arrived during the first run');
  assert.ok(second.requestedAt <= runs[1].start);
});

test('S3 real: a request is not lost when the runner dies inside its follow-up, and is answered only by a completed run', { timeout: 120_000 }, async () => {
  const { dir, project } = scratch();
  const a = runWorker(dir, project, 1200);
  await waitFor(() => starts(ledgerText(project)) >= 1, "A's run to start");
  const b = runWorker(dir, project, 200);
  await waitFor(() => starts(ledgerText(project)) >= 2, "A's follow-up to start");
  a.child.kill('SIGKILL');
  await a.result;
  const bResult = await b.result;
  // The follow-up never completed, so B was not told its demand was served: it takes the lease over and runs.
  assert.deepEqual(bResult.outcome, { status: 'ran', ok: true }, `B served its own demand: ${JSON.stringify(bResult)}`);
  const runs = recordedRuns(project);
  assert.equal(runs.length, 2, `A's completed run and B's: ${JSON.stringify(runs)}`);
  assert.ok(runs[1].start >= runs[0].end, "B's run started only after A's completed run");
  const answered = runs.filter((run) => run.start >= bResult.requestedAt && run.end <= bResult.returnedAt);
  assert.ok(answered.length >= 1, `B was answered by a run that started after it asked and had finished: ${JSON.stringify(runs)} ${JSON.stringify(bResult)}`);
});

test('S3 real: the CLI a killed session started is still an extension sync: the next session waits for it, then syncs', { timeout: 120_000 }, async () => {
  const { dir, project } = scratch();
  const a = runWorker(dir, project, 2500, 'sync-cli');
  const started = await a.firstLine;
  assert.equal(started.status, 'running');
  assert.ok((started.cliPid || 0) > 0, JSON.stringify(started));
  await waitFor(() => ledgerText(project).includes('cli-start'), 'the CLI to start writing the index');
  a.child.kill('SIGKILL');
  await a.result;
  // A second session asks for a sync while the abandoned CLI is still writing.
  const b = runWorker(dir, project, 100);
  const bResult = await b.result;
  assert.deepEqual(bResult.outcome, { status: 'ran', ok: true });
  assert.ok(bResult.requestedAt < Date.now());
  await waitFor(() => ledgerText(project).includes('cli-end'), 'the CLI to finish');
  const runs = recordedRuns(project);
  assert.equal(runs.length, 1, `the abandoned CLI's run never completed; only the second session's did: ${JSON.stringify(runs)}`);
  const cliEnd = lineTime(ledgerText(project), 'cli-end');
  const cliStart = lineTime(ledgerText(project), 'cli-start');
  assert.ok(cliEnd !== undefined && cliStart !== undefined);
  assert.ok(bResult.requestedAt < cliEnd, 'the second session asked while the abandoned CLI was still running');
  assert.ok(runs[0].start >= cliEnd, `the next sync started only after the abandoned CLI ended: ${JSON.stringify(runs)}`);
  assert.throws(() => process.kill(started.cliPid, 0), 'nothing was killed to get there');
});

'use strict';
// A compaction leaves the index stale while the session goes on (S2, S3): one background sync, never an init,
// never a notification, and never a second sync of the same project at the same time as another session's. The
// coordination itself is `lib/codegraph-lock.js`; here it is driven through `compactionSync` and the public lease.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compactionSync } = require('../lib/codegraph-compaction.js');
const { isInitLocked, isInitRunning, syncLease, tryAcquireInitLock } = require('../lib/codegraph-lock.js');
const { SYNC_TIMEOUT_MS } = require('../lib/codegraph-index.js');

const CWD = path.join('some', 'repo');
const has = (...present) => (p) => present.some((name) => p.endsWith(name));
const yes = () => true;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
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
  return { dir: temp('cg-compaction-state-'), project: temp('cg-compaction-project-') };
}

function captured() {
  const entries = [];
  return { entries, log: (entry) => entries.push(entry) };
}

/** The real index lock over one temp folder, as the extension wires it. */
function indexLock(dir) {
  return {
    acquire: (project, options) => tryAcquireInitLock(project, { dir }, options && options.kind),
    isHeld: (project) => isInitLocked(project, { dir }),
    isInitRunning: (project) => isInitRunning(project, { dir }),
  };
}

/** A coordinator that does no coordination: the attempt runs here, now. */
const direct = {
  request: async (_project, attempt) => {
    const result = await attempt(() => {});
    return result.ran ? { status: 'ran', ok: result.ok } : { status: 'queued' };
  },
};
const coalescing = { request: async () => ({ status: 'coalesced' }) };
const queuedElsewhere = { request: async () => ({ status: 'queued' }) };
const unavailable = { request: async () => ({ status: 'unavailable' }) };

test('S2: a compaction of a session with an index runs one quiet sync, never an init', async () => {
  const calls = [];
  const { entries, log } = captured();
  const result = await compactionSync({
    cwd: CWD,
    env: {},
    exists: has('.codegraph'),
    sync: direct,
    log,
    hasBinary: yes,
    run: async (args, cwd, timeoutMs) => {
      calls.push({ args, cwd, timeoutMs });
      return true;
    },
  });
  assert.deepEqual(calls, [{ args: ['sync', '-q'], cwd: CWD, timeoutMs: SYNC_TIMEOUT_MS }]);
  assert.deepEqual(result, { outcome: 'synced' });
  assert.equal(entries.length, 1);
  assert.deepEqual({ cwd: entries[0].cwd, outcome: entries[0].outcome }, { cwd: CWD, outcome: 'synced' });
  assert.ok(entries[0].ms >= 0);
});

test('S2: a git project without an index is left alone: a compaction never initialises it', async () => {
  for (const present of [['.git', 'package.json'], ['.git'], []]) {
    const calls = [];
    const { entries, log } = captured();
    const result = await compactionSync({
      cwd: CWD,
      env: {},
      exists: has(...present),
      sync: direct,
      log,
      lock: null,
      hasBinary: yes,
      run: async (args) => {
        calls.push(args);
        return true;
      },
    });
    assert.deepEqual(calls, [], JSON.stringify(present));
    assert.deepEqual(result, { outcome: 'skipped-no-index' }, JSON.stringify(present));
    assert.equal(entries[0].outcome, 'skipped-no-index');
  }
});

test('S2: a subagent child never starts a compaction sync, even with an index', async () => {
  const calls = [];
  const { entries, log } = captured();
  let coordinated = false;
  const result = await compactionSync({
    cwd: CWD,
    env: { GENTLE_PI_AGENTS_CHILD: '1' },
    exists: has('.codegraph'),
    log,
    hasBinary: yes,
    sync: {
      request: async (project, attempt) => {
        coordinated = true;
        return direct.request(project, attempt);
      },
    },
    run: async (args) => {
      calls.push(args);
      return true;
    },
  });
  assert.deepEqual(result, { outcome: 'skipped-child' });
  assert.deepEqual(calls, []);
  assert.equal(coordinated, false, 'a child does not even look at the coordination');
  assert.equal(entries[0].outcome, 'skipped-child');
});

test('S6: a read-only role starts no index write, and says so', async () => {
  const calls = [];
  const { entries, log } = captured();
  let asked = false;
  const result = await compactionSync({
    cwd: CWD,
    env: {},
    exists: has('.codegraph'),
    log,
    hasBinary: yes,
    role: 'read-only',
    sync: {
      request: async () => {
        asked = true;
        return { status: 'coalesced' };
      },
    },
    run: async (args) => {
      calls.push(args);
      return true;
    },
  });
  assert.deepEqual(result, { outcome: 'skipped-read-only' });
  assert.equal(asked, false);
  assert.deepEqual(calls, []);
  assert.equal(entries[0].outcome, 'skipped-read-only');
});

test('S2: without the codegraph CLI in this process nothing runs, and it is probed once', async () => {
  const probes = [];
  const hasBinary = (command) => {
    probes.push(command);
    return false;
  };
  const calls = [];
  const { entries, log } = captured();
  const input = {
    cwd: CWD,
    env: {},
    exists: has('.codegraph'),
    sync: direct,
    log,
    hasBinary,
    run: async (args) => {
      calls.push(args);
      return true;
    },
  };
  assert.deepEqual(await compactionSync(input), { outcome: 'skipped-no-cli' });
  assert.deepEqual(await compactionSync(input), { outcome: 'skipped-no-cli' });
  assert.deepEqual(probes, ['codegraph']);
  assert.deepEqual(calls, []);
  assert.deepEqual(entries.map((entry) => entry.outcome), ['skipped-no-cli', 'skipped-no-cli']);
});

test('S3: a compaction during an init is not dropped: it waits for the init, then syncs under the lock', async () => {
  const { dir, project } = scratch();
  const lock = indexLock(dir);
  const init = tryAcquireInitLock(project, { dir }, 'init');
  assert.equal(init.status, 'acquired');
  const runs = [];
  const { entries, log } = captured();
  const request = compactionSync({
    cwd: project,
    env: {},
    exists: has('.codegraph'),
    lock,
    log,
    hasBinary: yes,
    sync: syncLease({ dir, pollMs: 5, requestWaitMs: 30_000 }),
    run: async () => {
      // The sync holds the package's index lock while it runs: no init can begin in the middle of it.
      assert.equal(isInitLocked(project, { dir }), true, 'the sync runs holding the index lock');
      assert.equal(isInitRunning(project, { dir }), false, 'a sync holder is not an init');
      runs.push('ran');
      return true;
    },
  });
  await pause(200);
  assert.deepEqual(runs, [], 'the index is being initialised: nothing may sync meanwhile');
  init.release();
  const result = await request;
  assert.deepEqual(result, { outcome: 'synced' });
  assert.deepEqual(runs, ['ran']);
  assert.equal(entries[0].outcome, 'synced');
});

test('S3: a compaction that cannot get the index before it gives up says so and leaves the demand on disk', async () => {
  const { dir, project } = scratch();
  const lock = indexLock(dir);
  const init = tryAcquireInitLock(project, { dir }, 'init');
  assert.equal(init.status, 'acquired');
  const runs = [];
  const { entries, log } = captured();
  const result = await compactionSync({
    cwd: project,
    env: {},
    exists: has('.codegraph'),
    lock,
    log,
    hasBinary: yes,
    sync: syncLease({ dir, pollMs: 5, requestWaitMs: 200 }),
    run: async () => {
      runs.push('ran');
      return true;
    },
  });
  assert.deepEqual(runs, [], 'the init still owns the index');
  assert.deepEqual(result, { outcome: 'queued' }, 'not coalesced: nothing ran for it yet');
  assert.equal(entries[0].outcome, 'queued');
  init.release();
  // A later sync of the same project serves the request the session left behind.
  const later = [];
  const served = await compactionSync({
    cwd: project,
    env: {},
    exists: has('.codegraph'),
    lock,
    hasBinary: yes,
    sync: syncLease({ dir, pollMs: 5, requestWaitMs: 30_000 }),
    run: async () => {
      later.push('ran');
      return true;
    },
    log: () => {},
  });
  assert.deepEqual(served, { outcome: 'synced' });
  assert.deepEqual(later, ['ran'], 'the pending request was served, not lost');
});

test('S3: a failing compaction sync is logged as failed and never thrown, and nothing else is told', async () => {
  for (const failure of ['exit', 'throw']) {
    const { entries, log } = captured();
    const result = await compactionSync({
      cwd: CWD,
      env: {},
      exists: has('.codegraph'),
      log,
      lock: null,
      sync: direct,
      hasBinary: yes,
      run: async () => {
        if (failure === 'throw') throw new Error('boom');
        return false;
      },
    });
    assert.deepEqual(result, { outcome: 'failed' }, failure);
    // The only thing a failure produces is the diagnostic line: no message, no notice, no result to show.
    assert.deepEqual(Object.keys(result), ['outcome'], failure);
    assert.deepEqual(entries.map((entry) => entry.outcome), ['failed'], failure);
  }
});

test('S2: when another session is already syncing, the compaction leaves the run to it', async () => {
  const calls = [];
  const { entries, log } = captured();
  const result = await compactionSync({
    cwd: CWD,
    env: {},
    exists: has('.codegraph'),
    sync: coalescing,
    log,
    hasBinary: yes,
    run: async (args) => {
      calls.push(args);
      return true;
    },
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { outcome: 'coalesced' });
  assert.equal(entries[0].outcome, 'coalesced');
});

test('S2: a compaction whose request is still waiting is logged as queued, never as coalesced', async () => {
  for (const [sync, expected] of [[queuedElsewhere, 'queued'], [unavailable, 'skipped-coordination-unavailable']]) {
    const calls = [];
    const { entries, log } = captured();
    const result = await compactionSync({
      cwd: CWD,
      env: {},
      exists: has('.codegraph'),
      sync,
      log,
      hasBinary: yes,
      run: async (args) => {
        calls.push(args);
        return true;
      },
    });
    assert.deepEqual(calls, [], expected);
    assert.deepEqual(result, { outcome: expected });
    assert.equal(entries[0].outcome, expected);
  }
});

test('S2: the compaction sync reaches the coordinator with the project and the quiet command', async () => {
  const projects = [];
  const { log } = captured();
  await compactionSync({
    cwd: CWD,
    env: {},
    exists: has('.codegraph'),
    log,
    lock: null,
    hasBinary: yes,
    sync: {
      request: async (project, attempt) => {
        projects.push(project);
        assert.deepEqual(await attempt(() => {}), { ran: true, ok: true });
        return { status: 'ran', ok: true };
      },
    },
    run: async (args, cwd) => args[0] === 'sync' && cwd === CWD,
  });
  assert.deepEqual(projects, [CWD]);
});

test('S2: unusable coordination state starts no sync at all (fail closed), and says so', async () => {
  const file = path.join(temp('cg-compaction-file-'), 'not-a-directory');
  fs.writeFileSync(file, '');
  let ran = false;
  const { entries, log } = captured();
  const result = await compactionSync({
    cwd: CWD,
    env: {},
    exists: has('.codegraph'),
    log,
    lock: null,
    hasBinary: yes,
    sync: syncLease({ dir: file, pollMs: 5, requestWaitMs: 500 }),
    run: async () => {
      ran = true;
      return true;
    },
  });
  assert.equal(ran, false, 'without its coordination state the package does not risk a second sync');
  assert.deepEqual(result, { outcome: 'skipped-coordination-unavailable' });
  assert.equal(entries[0].outcome, 'skipped-coordination-unavailable');
});

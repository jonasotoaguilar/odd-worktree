'use strict';
// Index preparation (S2, S3) through the public surface: create-or-sync per root, a linked worktree seeded from the
// main checkout's index, every write under the init lock and the per-project sync lease, and notices that never
// overstate what happened. No real codegraph, daemon or network runs here: the command, the lock, the lease and the
// PATH probe are all injected.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  INIT_TIMEOUT_MS,
  KILL_ESCALATION_MS,
  KILL_WAIT_MS,
  POST_INIT_SYNC_WAIT_MS,
  SYNC_TIMEOUT_MS,
  autoIndex,
  codegraphWritingIndex,
  findIndexRoot,
  indexOutcomeNotice,
  indexStartNotice,
  initHookDecision,
  isNativeInitResult,
  linkedWorktrees,
  noticeTools,
  planIndexAction,
  postInitSyncNotice,
  prepareProject,
  runCodegraph,
  seedLinkedWorktrees,
  seedWorktreeIndex,
  syncAfterNativeInit,
  warmOutcomeNotice,
  worktreeIndexAction,
  worktreeOf,
} = require('../lib/codegraph-index.js');

const CWD = path.join('some', 'repo');
const has = (...present) => (p) => present.some((name) => p.endsWith(name));
const yes = () => true;
const no = () => false;

function fakeRun(calls, ok = true) {
  return async (args, cwd) => {
    calls.push({ args, cwd });
    return ok;
  };
}

let sequence = 0;
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
  sequence += 1;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${sequence}-`)));
  scratchDirs.push(dir);
  return dir;
}

/** A project with no coordination at all: the unit-test shape of one session that runs its own command. */
function bare(extra) {
  return { cwd: CWD, env: {}, reason: 'startup', hasBinary: yes, lock: null, sync: null, ...extra };
}

/** An index lock that records what it was asked and who holds it. */
function recordingLock(log, held, initRunning = held) {
  return {
    acquire: (project, options) => {
      log.push(`acquire:${(options && options.kind) || 'init'}:${project}`);
      return held
        ? { status: 'busy' }
        : { status: 'acquired', adopt: () => {}, release: () => log.push('release') };
    },
    isHeld: () => {
      log.push('isHeld');
      return held;
    },
    isInitRunning: () => initRunning,
  };
}

function fakeLock(log, held) {
  return {
    acquire: () => {
      log.push('lock:acquire');
      return held
        ? { status: 'busy' }
        : {
          status: 'acquired',
          adopt: (pid, options) => log.push(`lock:adopt:${pid}${options && options.proxy ? ':proxy' : ''}`),
          release: () => log.push('lock:release'),
        };
    },
    isHeld: () => {
      log.push('lock:isHeld');
      return held;
    },
  };
}

/** A coordinator that runs the attempt here and now, like a session that found the lease free. */
const runsHere = (log) => ({
  request: async (project, attempt) => {
    if (log !== undefined) log.push(`coordinate:${project}`);
    const result = await attempt(() => {});
    return result.ran ? { status: 'ran', ok: result.ok === true } : { status: 'queued' };
  },
});

// ---- Create-or-sync (S2) ----

test('S2: with .codegraph in the directory where the session starts, a new session runs `codegraph sync` there', async () => {
  const calls = [];
  const result = await autoIndex(bare({ exists: has('.codegraph'), run: fakeRun(calls) }));
  assert.deepEqual(calls, [{ args: ['sync', '-q'], cwd: CWD }]);
  assert.deepEqual(result, { action: 'sync', ok: true });
});

test('S2: .codegraph present never triggers init, even with .git and package.json', async () => {
  const calls = [];
  await autoIndex(bare({ exists: has('.codegraph', '.git', 'package.json'), run: fakeRun(calls) }));
  assert.deepEqual(calls.map((call) => call.args), [['sync', '-q']]);
});

test('S2: no .codegraph, .git and package.json -> `codegraph init -y`', async () => {
  const calls = [];
  const result = await autoIndex(bare({ exists: has('.git', 'package.json'), run: fakeRun(calls) }));
  assert.deepEqual(calls, [{ args: ['init', '-y'], cwd: CWD }]);
  assert.deepEqual(result, { action: 'init', ok: true });
});

test('S2: no .codegraph, .git and composer.json -> `codegraph init -y`', async () => {
  const calls = [];
  await autoIndex(bare({ exists: has('.git', 'composer.json'), run: fakeRun(calls) }));
  assert.deepEqual(calls.map((call) => call.args), [['init', '-y']]);
});

test('S2: every other project marker next to .git also triggers init, and never without .git', async () => {
  for (const marker of ['pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const calls = [];
    await autoIndex(bare({ exists: has('.git', marker), run: fakeRun(calls) }));
    assert.deepEqual(calls.map((call) => call.args), [['init', '-y']], marker);
    const noGit = [];
    await autoIndex(bare({ exists: has(marker), run: fakeRun(noGit) }));
    assert.deepEqual(noGit, [], `${marker} without .git`);
  }
});

test('S2: .git without any project marker does nothing, and so do the markers without .git', async () => {
  const calls = [];
  const result = await autoIndex(bare({ exists: has('.git', 'README.md'), run: fakeRun(calls) }));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'none', ok: true });
  const more = [];
  await autoIndex(bare({ exists: has('package.json', 'composer.json'), run: fakeRun(more) }));
  assert.deepEqual(more, []);
});

test('S2: planIndexAction is a pure decision over the three paths', () => {
  assert.equal(planIndexAction(CWD, has('.codegraph')), 'sync');
  assert.equal(planIndexAction(CWD, has('.git', 'package.json')), 'init');
  assert.equal(planIndexAction(CWD, has()), 'none');
});

test('S2: a subagent child never syncs or inits in the parent project', async () => {
  const calls = [];
  const result = await autoIndex(bare({ env: { GENTLE_PI_AGENTS_CHILD: '1' }, exists: has('.codegraph'), run: fakeRun(calls) }));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'none', ok: true });
});

test('S2: a /reload does nothing; startup, new, resume and fork do', async () => {
  const calls = [];
  await autoIndex(bare({ reason: 'reload', exists: has('.codegraph'), run: fakeRun(calls) }));
  assert.deepEqual(calls, []);
  for (const reason of ['startup', 'new', 'resume', 'fork']) {
    const runs = [];
    await autoIndex(bare({ reason, exists: has('.codegraph'), run: fakeRun(runs) }));
    assert.equal(runs.length, 1, reason);
  }
});

test('S2: a failing or throwing command is reported as not ok and never rejects', async () => {
  const failed = await autoIndex(bare({ exists: has('.codegraph'), run: fakeRun([], false) }));
  assert.deepEqual(failed, { action: 'sync', ok: false });
  const thrown = await autoIndex(bare({
    exists: has('.codegraph'),
    run: async () => {
      throw new Error('boom');
    },
  }));
  assert.deepEqual(thrown, { action: 'sync', ok: false });
});

test('S2: onStart announces the action before the command runs, and only when one runs', async () => {
  for (const [present, expected] of [[['.codegraph'], 'sync'], [['.git', 'package.json'], 'init']]) {
    const order = [];
    await autoIndex(bare({
      exists: has(...present),
      onStart: (action) => order.push(`start:${action}`),
      run: async () => {
        order.push('run');
        return true;
      },
    }));
    assert.deepEqual(order, [`start:${expected}`, 'run']);
  }
  const silent = [];
  const skipped = [
    { present: ['.git'], env: {}, reason: 'startup' },
    { present: ['.codegraph'], env: { GENTLE_PI_AGENTS_CHILD: '1' }, reason: 'startup' },
    { present: ['.codegraph'], env: {}, reason: 'reload' },
  ];
  for (const { present, env, reason } of skipped) {
    await autoIndex(bare({ env, reason, exists: has(...present), onStart: (action) => silent.push(action), run: fakeRun([]) }));
  }
  assert.deepEqual(silent, []);
});

test('S2: a throwing onStart does not stop the command', async () => {
  const calls = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    onStart: () => {
      throw new Error('ui gone');
    },
    run: fakeRun(calls),
  }));
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { action: 'sync', ok: true });
});

test('S6: a read-only role starts no index write at all', async () => {
  const calls = [];
  const readOnly = await autoIndex(bare({ exists: has('.codegraph'), role: 'read-only', run: fakeRun(calls) }));
  assert.deepEqual(readOnly, { action: 'none', ok: true, skipped: 'read-only' });
  const notAllowed = await autoIndex(bare({ exists: has('.git', 'package.json'), mayWrite: false, run: fakeRun(calls) }));
  assert.deepEqual(notAllowed, { action: 'none', ok: true, skipped: 'read-only' });
  assert.deepEqual(calls, []);
});

test('S2: the codegraph CLI presence is probed once per process, and without it nothing runs', async () => {
  const probes = [];
  const hasBinary = (command) => {
    probes.push(command);
    return false;
  };
  const calls = [];
  const first = await autoIndex(bare({ exists: has('.codegraph'), hasBinary, run: fakeRun(calls) }));
  const second = await autoIndex(bare({ exists: has('.git', 'package.json'), hasBinary, run: fakeRun(calls) }));
  assert.deepEqual(probes, ['codegraph']);
  assert.deepEqual(calls, []);
  assert.deepEqual(first, { action: 'none', ok: true, skipped: 'no-cli' });
  assert.deepEqual(second, { action: 'none', ok: true, skipped: 'no-cli' });
});

// ---- Every write under the locks (S3) ----

test('S3: the init runs holding the lock, taken before anything is announced and released afterwards, whatever the outcome', async () => {
  for (const outcome of ['ok', 'fail', 'throw']) {
    const log = [];
    const result = await autoIndex(bare({
      exists: has('.git', 'package.json'),
      lock: fakeLock(log, false),
      onStart: (action) => log.push(`start:${action}`),
      run: async (args) => {
        log.push(`run:${args[0]}`);
        if (outcome === 'throw') throw new Error('boom');
        return outcome === 'ok';
      },
    }));
    assert.deepEqual(log, ['lock:acquire', 'start:init', 'run:init', 'lock:release'], outcome);
    assert.equal(result.action, 'init', outcome);
    assert.equal(result.ok, outcome === 'ok', outcome);
  }
});

test('S3: a session that finds the init lock held does nothing: no init, no announcement', async () => {
  const log = [];
  const result = await autoIndex(bare({
    exists: has('.git', 'package.json'),
    lock: fakeLock(log, true),
    onStart: (action) => log.push(`start:${action}`),
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return true;
    },
  }));
  assert.deepEqual(log, ['lock:acquire']);
  assert.deepEqual(result, { action: 'init', ok: true, joined: true });
});

test('S3: while another session holds the init lock, an existing .codegraph is not synced either', async () => {
  const log = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    lock: fakeLock(log, true),
    onStart: (action) => log.push(`start:${action}`),
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return true;
    },
  }));
  assert.deepEqual(log, ['lock:isHeld']);
  assert.deepEqual(result, { action: 'sync', ok: true, joined: true });
});

test('S3: with no init lock held an existing index is synced under the index lock as a sync', async () => {
  const log = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    lock: recordingLock(log, false),
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return true;
    },
  }));
  assert.deepEqual(log, ['isHeld', `acquire:sync:${CWD}`, 'run:sync', 'release']);
  assert.deepEqual(result, { action: 'sync', ok: true });
});

test("S3: an init that fails while CodeGraph's own lock names a live process is a join, and nothing else runs", async () => {
  const calls = [];
  let created = false;
  const result = await autoIndex(bare({
    exists: (p) => p.endsWith('.git') || p.endsWith('package.json') || (created && p.endsWith('.codegraph')),
    codegraphBusy: () => true,
    run: async (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === 'init') {
        created = true;
        return false;
      }
      return true;
    },
  }));
  assert.deepEqual(calls.map((call) => call.args), [['init', '-y']]);
  assert.deepEqual(result, { action: 'init', ok: true, joined: true });
});

test("S3: an init of this session that creates .codegraph and fails is a failure, not a join", async () => {
  const calls = [];
  let created = false;
  const result = await autoIndex(bare({
    exists: (p) => p.endsWith('.git') || p.endsWith('package.json') || (created && p.endsWith('.codegraph')),
    codegraphBusy: () => false,
    run: async (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === 'init') {
        created = true;
        return false;
      }
      return true;
    },
  }));
  assert.deepEqual(calls.map((call) => call.args), [['init', '-y']]);
  assert.deepEqual(result, { action: 'init', ok: false });
});

test('S3: when another party created .codegraph after planning, this session joins without running or announcing', async () => {
  const log = [];
  let lookups = 0;
  const result = await autoIndex(bare({
    // The first lookup is the plan; by the time this session has the lock, the index is there.
    exists: (p) => {
      if (p.endsWith('.codegraph')) {
        lookups += 1;
        return lookups > 1;
      }
      return p.endsWith('.git') || p.endsWith('package.json');
    },
    lock: fakeLock(log, false),
    onStart: (action) => log.push(`start:${action}`),
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return true;
    },
  }));
  assert.deepEqual(log, ['lock:acquire', 'lock:release']);
  assert.deepEqual(result, { action: 'init', ok: true, joined: true });
  assert.equal(lookups, 2);
});

test('S3: the join does not depend on having a lock: an index created after planning is left alone too', async () => {
  const calls = [];
  let lookups = 0;
  const result = await autoIndex(bare({
    exists: (p) => {
      if (p.endsWith('.codegraph')) {
        lookups += 1;
        return lookups > 1;
      }
      return p.endsWith('.git') || p.endsWith('package.json');
    },
    run: fakeRun(calls),
  }));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'init', ok: true, joined: true });
});

test("S3: the pid of this session's init is adopted by the lock, and only the shell is recorded as a proxy", async () => {
  const log = [];
  await autoIndex(bare({
    exists: has('.git', 'package.json'),
    lock: fakeLock(log, false),
    run: async (args, cwd, timeoutMs, onSpawn) => {
      log.push(`run:${args[0]}:${timeoutMs}`);
      onSpawn(4242);
      return true;
    },
  }));
  assert.deepEqual(log, ['lock:acquire', 'run:init:600000', 'lock:adopt:4242', 'lock:release']);

  const proxied = [];
  await autoIndex(bare({
    exists: has('.git', 'package.json'),
    lock: fakeLock(proxied, false),
    run: async (args, cwd, timeoutMs, onSpawn) => {
      onSpawn(4242, { proxy: true });
      return true;
    },
  }));
  assert.ok(proxied.includes('lock:adopt:4242:proxy'), proxied.join(','));
});

test('S3: an index locked by another sync leaves the request pending, and it is never reported as synced', async () => {
  const log = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    // Another session's sync holds the index, not an init: the index exists and only the lease is missing.
    lock: recordingLock(log, true, false),
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return true;
    },
  }));
  assert.ok(!log.includes('run:sync'), 'nothing was run: the index belongs to another writer');
  assert.deepEqual(result, { action: 'sync', ok: true, queued: true });
});

test('S3: a startup sync goes through the coordinator, which runs the quiet command once', async () => {
  const calls = [];
  const seen = [];
  const result = await autoIndex(bare({ exists: has('.codegraph'), sync: runsHere(seen), run: fakeRun(calls) }));
  assert.deepEqual(seen, [`coordinate:${CWD}`]);
  assert.deepEqual(calls, [{ args: ['sync', '-q'], cwd: CWD }]);
  assert.deepEqual(result, { action: 'sync', ok: true });
});

test('S3: while another session syncs, this one leaves the run to it and says so', async () => {
  const calls = [];
  const announced = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    onStart: (action) => announced.push(action),
    sync: { request: async () => ({ status: 'coalesced' }) },
    run: fakeRun(calls),
  }));
  assert.deepEqual(calls, [], 'this session ran nothing: the other session syncs');
  assert.deepEqual(announced, ['sync']);
  assert.deepEqual(result, { action: 'sync', ok: true, coalesced: true });
});

test('S3: a coalesced startup sync still reports the failure the runner hit', async () => {
  const result = await autoIndex(bare({ exists: has('.codegraph'), sync: runsHere(), run: fakeRun([], false) }));
  assert.deepEqual(result, { action: 'sync', ok: false });
});

test('S3: a startup sync that is still waiting for the index is reported as queued, not as a failure', async () => {
  const calls = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    sync: { request: async () => ({ status: 'queued' }) },
    run: fakeRun(calls),
  }));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'sync', ok: true, queued: true });
});

test('S3: unusable sync coordination starts no sync and is reported as such (fail closed)', async () => {
  const calls = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    sync: { request: async () => ({ status: 'unavailable' }) },
    run: fakeRun(calls),
  }));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'sync', ok: false, unavailable: true });
});

test("S3: a startup sync during another session's sync is coalesced, not skipped as if an init ran", async () => {
  const log = [];
  const calls = [];
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    lock: { ...fakeLock(log, true), isInitRunning: () => false },
    sync: {
      request: async () => {
        log.push('coordinate');
        return { status: 'coalesced' };
      },
    },
    run: fakeRun(calls),
  }));
  assert.deepEqual(log, ['lock:isHeld', 'coordinate'], 'the index is locked by a sync, so this request is coalesced');
  assert.deepEqual(result, { action: 'sync', ok: true, coalesced: true });
});

test('S3: with an init running, startup does not even ask for a coordinated sync', async () => {
  const calls = [];
  let asked = false;
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    lock: { ...fakeLock([], true), isInitRunning: () => true },
    sync: {
      request: async () => {
        asked = true;
        return { status: 'coalesced' };
      },
    },
    run: fakeRun(calls),
  }));
  assert.equal(asked, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'sync', ok: true, joined: true });
});

test('S3: a coordinated startup sync holds the index lock as a sync while it runs', async () => {
  const log = [];
  const lock = {
    acquire: (_project, options) => {
      log.push(`lock:acquire:${(options && options.kind) || 'init'}`);
      return {
        status: 'acquired',
        adopt: (pid) => log.push(`lock:adopt:${pid}`),
        release: () => log.push('lock:release'),
      };
    },
    isHeld: () => false,
    isInitRunning: () => false,
  };
  const result = await autoIndex(bare({
    exists: has('.codegraph'),
    lock,
    sync: runsHere(),
    run: async (args, cwd, timeoutMs, onSpawn) => {
      log.push(`run:${args[0]}`);
      onSpawn(4242);
      return true;
    },
  }));
  assert.deepEqual(log, ['lock:acquire:sync', 'run:sync', 'lock:adopt:4242', 'lock:release']);
  assert.deepEqual(result, { action: 'sync', ok: true });
});

test('S3: an init never goes through the sync coordinator', async () => {
  const calls = [];
  let asked = false;
  await autoIndex(bare({
    exists: has('.git', 'package.json'),
    sync: {
      request: async () => {
        asked = true;
        return { status: 'coalesced' };
      },
    },
    run: fakeRun(calls),
  }));
  assert.equal(asked, false);
  assert.deepEqual(calls.map((call) => call.args), [['init', '-y']]);
});

// ---- A linked worktree indexes its own tree, seeded from the main checkout (S2, S3) ----

/** A repository and one linked worktree of it, built on disk without running git. */
function linkedWorktree(base) {
  const repo = path.join(base, 'repo');
  const worktree = path.join(base, 'wt');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  return { repo, worktree };
}

/** Every real SQLite database, and so every CodeGraph index, starts with these 16 bytes. */
const INDEX_MAGIC = 'SQLite format 3\u0000';

/** A plausible fake index: what a seed copy seam must write now that the copy is validated before it is published. */
const fakeIndex = (payload = 'fake index payload') => INDEX_MAGIC + payload;

test('S2: a directory without .git, a plain repository, a broken pointer and the main checkout are not worktrees', () => {
  const base = temp('cg-worktree-');
  assert.deepEqual(worktreeOf(base), { worktree: false });
  const plain = path.join(base, 'plain');
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
  assert.deepEqual(worktreeOf(plain), { worktree: false });
  const broken = path.join(base, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, '.git'), 'not a gitdir pointer\n');
  assert.deepEqual(worktreeOf(broken), { worktree: false });
  const missing = path.join(base, 'missing');
  fs.mkdirSync(missing);
  fs.writeFileSync(path.join(missing, '.git'), `gitdir: ${path.join(base, 'nowhere')}\n`);
  assert.deepEqual(worktreeOf(missing), { worktree: false });

  const { repo, worktree } = linkedWorktree(path.join(base, 'real'));
  const found = worktreeOf(worktree);
  assert.equal(found.worktree, true, JSON.stringify(found));
  assert.equal(found.commonRoot.toLowerCase(), repo.toLowerCase());
  assert.deepEqual(worktreeOf(repo), { worktree: false });
});

test('S2: the worktree decision is seed, sync or the plain marker decision', () => {
  const base = temp('cg-decision-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'seed bytes');
  assert.deepEqual(worktreeIndexAction(worktree, fs.existsSync), { action: 'seed', commonRoot: repo });

  const plainWorktree = linkedWorktree(path.join(base, 'b')).worktree;
  assert.deepEqual(worktreeIndexAction(plainWorktree, fs.existsSync), { action: 'none' });
  fs.writeFileSync(path.join(plainWorktree, 'package.json'), '{}\n');
  assert.deepEqual(worktreeIndexAction(plainWorktree, fs.existsSync), { action: 'init' });

  fs.mkdirSync(path.join(worktree, '.codegraph'));
  assert.deepEqual(worktreeIndexAction(worktree, fs.existsSync), { action: 'sync' });

  const plain = path.join(base, 'plain-repo');
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
  assert.deepEqual(worktreeIndexAction(plain, fs.existsSync), { action: 'none' });
  fs.writeFileSync(path.join(plain, 'package.json'), '{}\n');
  assert.deepEqual(worktreeIndexAction(plain, fs.existsSync), { action: 'init' });
});

test('S2: seeding copies the db only from a main index nobody is writing, into the worktree', () => {
  const base = temp('cg-seed-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'seed bytes');
  const copied = [];
  const seeded = seedWorktreeIndex({
    worktree,
    commonRoot: repo,
    sourceBusy: () => copied.length > 0,
    copy: (from, to) => {
      copied.push(from);
      fs.writeFileSync(to, fakeIndex('seed bytes'));
      return true;
    },
  });
  assert.equal(seeded, true, 'seeding ran');
  assert.equal(copied.length, 1, 'exactly one copy, of the main index db');
  assert.ok(copied[0].includes(path.join('.codegraph', 'codegraph.db')), JSON.stringify(copied));
  assert.equal(fs.readFileSync(path.join(worktree, '.codegraph', 'codegraph.db'), 'utf8'), fakeIndex('seed bytes'));
});

test('S2: seeding refuses to copy while the main index is being written, and a failed copy leaves nothing', () => {
  const base = temp('cg-seed-busy-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'seed bytes');
  const busy = seedWorktreeIndex({
    worktree,
    commonRoot: repo,
    sourceBusy: () => true,
    copy: () => {
      throw new Error('must not copy');
    },
  });
  assert.equal(busy, false);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false, 'nothing half-seeded');

  const failed = seedWorktreeIndex({ worktree, commonRoot: repo, sourceBusy: () => false, copy: () => false });
  assert.equal(failed, false);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false);
});

test('S2: a linked worktree of a session is seeded under its own index lock, and that lock is released', () => {
  const base = temp('cg-linked-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'main db');
  const log = [];
  const result = seedLinkedWorktrees({
    worktrees: [worktree],
    lock: recordingLock(log, false),
    exists: fs.existsSync,
    sourceBusy: () => false,
    copy: (_from, to) => {
      fs.writeFileSync(to, fakeIndex('seeded db'));
      return true;
    },
  });
  assert.deepEqual(result.seeded, [path.join(worktree, '.codegraph', 'codegraph.db')]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(log, [`acquire:init:${worktree}`, 'release']);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph', 'codegraph.db')), true);
});

test('S2: a worktree whose index another session is writing is skipped and never copied into', () => {
  const base = temp('cg-linked-busy-');
  const { worktree } = linkedWorktree(path.join(base, 'a'));
  let copied = false;
  const result = seedLinkedWorktrees({
    worktrees: [worktree],
    lock: recordingLock([], true),
    exists: fs.existsSync,
    sourceBusy: () => false,
    copy: () => {
      copied = true;
      return true;
    },
  });
  assert.equal(copied, false);
  assert.deepEqual(result.seeded, []);
  assert.deepEqual(result.skipped, [{ worktree, reason: "another session is writing this worktree's index" }]);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false, 'nothing was created in a worktree this session does not own');
});

test('S2: a worktree that already has an index is skipped without taking any lock', () => {
  const base = temp('cg-linked-has-');
  const { worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(worktree, '.codegraph'));
  const log = [];
  const result = seedLinkedWorktrees({
    worktrees: [worktree],
    lock: recordingLock(log, false),
    exists: fs.existsSync,
    sourceBusy: () => false,
    copy: () => {
      throw new Error('must not copy');
    },
  });
  assert.deepEqual(result.skipped, [{ worktree, reason: 'already has an index' }]);
  assert.deepEqual(log, []);
});

test("S2: while the main checkout's index is being written, nothing is copied into a worktree", () => {
  const base = temp('cg-linked-source-');
  const { worktree } = linkedWorktree(path.join(base, 'a'));
  const result = seedLinkedWorktrees({
    worktrees: [worktree],
    lock: recordingLock([], false),
    exists: fs.existsSync,
    sourceBusy: () => true,
    copy: () => {
      throw new Error('must not copy');
    },
  });
  assert.deepEqual(result.skipped, [{ worktree, reason: "the main checkout's index is being written" }]);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false);
});

test('S2: the main checkout itself is never seeded from its own index', () => {
  const base = temp('cg-linked-main-');
  const { repo } = linkedWorktree(path.join(base, 'a'));
  const result = seedLinkedWorktrees({
    worktrees: [repo],
    lock: recordingLock([], false),
    exists: fs.existsSync,
    sourceBusy: () => false,
    copy: () => {
      throw new Error('must not copy');
    },
  });
  assert.deepEqual(result, { seeded: [], skipped: [] });
});

test("S2: without an explicit source check, the main index's own lock decides whether a worktree is seeded", () => {
  const base = temp('cg-linked-fallback-');
  const { worktree } = linkedWorktree(path.join(base, 'a'));
  let copied = false;
  // The worktree's own lock is free; the main checkout's is held, and that is what the fallback reads.
  const lock = {
    acquire: () => ({ status: 'acquired', adopt: () => {}, release: () => {} }),
    isHeld: () => true,
  };
  const result = seedLinkedWorktrees({
    worktrees: [worktree],
    lock,
    exists: fs.existsSync,
    copy: () => {
      copied = true;
      return true;
    },
  });
  assert.equal(copied, false);
  assert.deepEqual(result.seeded, []);
  assert.deepEqual(result.skipped, [{ worktree, reason: "the main checkout's index is being written" }]);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false);
});

test('S2: a copy failure in one worktree does not stop the others and leaves nothing half-built', () => {
  const base = temp('cg-linked-two-');
  const first = linkedWorktree(path.join(base, 'a'));
  const second = linkedWorktree(path.join(base, 'b'));
  fs.mkdirSync(path.join(first.repo, '.codegraph'));
  fs.writeFileSync(path.join(first.repo, '.codegraph', 'codegraph.db'), 'main db');
  fs.mkdirSync(path.join(second.repo, '.codegraph'));
  fs.writeFileSync(path.join(second.repo, '.codegraph', 'codegraph.db'), 'main db');
  let attempts = 0;
  const result = seedLinkedWorktrees({
    worktrees: [first.worktree, second.worktree],
    lock: recordingLock([], false),
    exists: fs.existsSync,
    sourceBusy: () => false,
    copy: (_from, to) => {
      attempts += 1;
      if (attempts === 1) return false; // the first worktree fails
      fs.writeFileSync(to, fakeIndex('seeded db'));
      return true;
    },
  });
  assert.deepEqual(result.seeded, [path.join(second.worktree, '.codegraph', 'codegraph.db')]);
  assert.deepEqual(result.skipped, [{ worktree: first.worktree, reason: 'the seed copy failed' }]);
  assert.equal(fs.existsSync(path.join(first.worktree, '.codegraph')), false, 'the failed one left nothing behind');
});

test('S2: the worktree scan reports what git lists, and nothing when git cannot answer', async () => {
  const porcelain = 'worktree /repo\nHEAD abc\n\nworktree /repo-worktrees/odd\nHEAD def\n\n';
  assert.deepEqual(await linkedWorktrees({ cwd: path.join('some', 'repo'), list: () => porcelain }), ['/repo', '/repo-worktrees/odd']);
  assert.deepEqual(await linkedWorktrees({ cwd: path.join('some', 'repo'), list: () => ['/repo', '/repo-worktrees/odd'] }), ['/repo', '/repo-worktrees/odd']);
  assert.deepEqual(await linkedWorktrees({ cwd: path.join('some', 'repo'), list: () => undefined }), [], 'git failed: no worktrees, no throw');
  assert.deepEqual(await linkedWorktrees({
    cwd: path.join('some', 'repo'),
    list: () => {
      throw new Error('git is gone');
    },
  }), [], 'a throwing lister never reaches the session');
});

test('S2: a session that finds an unindexed linked worktree seeds it and syncs it once', async () => {
  const base = temp('cg-child-worktree-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'main db');
  const log = [];
  const calls = [];
  const result = await autoIndex({
    cwd: worktree,
    env: { GENTLE_PI_AGENTS_CHILD: '1' },
    reason: 'startup',
    exists: fs.existsSync,
    hasBinary: yes,
    lock: fakeLock(log, false),
    copySeed: (_from, to) => {
      fs.writeFileSync(to, fakeIndex('seeded'));
      return true;
    },
    run: fakeRun(calls),
  });
  assert.deepEqual(result, { action: 'seed', ok: true });
  assert.deepEqual(calls.map((call) => call.args), [['sync', '-q']]);
  assert.deepEqual(log, ['lock:acquire', 'lock:isHeld', 'lock:isHeld', 'lock:release'], JSON.stringify(log));
  assert.equal(fs.readFileSync(path.join(worktree, '.codegraph', 'codegraph.db'), 'utf8'), fakeIndex('seeded'));
});

test('S3: a seed whose post-seed sync fails leaves no published db and no directory this session created', async () => {
  const base = temp('cg-seed-rollback-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), fakeIndex('main'));
  const log = [];
  const calls = [];
  const result = await autoIndex({
    cwd: worktree,
    env: {},
    reason: 'startup',
    exists: fs.existsSync,
    hasBinary: yes,
    lock: fakeLock(log, false),
    copySeed: (_from, to) => {
      fs.writeFileSync(to, fakeIndex('seeded'));
      return true;
    },
    run: fakeRun(calls, false),
  });
  assert.deepEqual(result, { action: 'seed', ok: false });
  assert.deepEqual(calls.map((call) => call.args), [['sync', '-q']], 'the one reconciliation it attempted is still the one reported');
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph', 'codegraph.db')), false, 'the published db is gone');
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false, 'the directory this session created is gone');
});

test('S3: a staged copy that is not a plausible index is never published and never synced', async () => {
  const base = temp('cg-seed-garbage-');
  for (const [name, stagedContent] of [['empty', ''], ['not-sqlite', 'not a codegraph index at all\n']]) {
    const { repo, worktree } = linkedWorktree(path.join(base, name));
    fs.mkdirSync(path.join(repo, '.codegraph'));
    fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), fakeIndex('main'));
    const calls = [];
    const result = await autoIndex({
      cwd: worktree,
      env: {},
      reason: 'startup',
      exists: fs.existsSync,
      hasBinary: yes,
      lock: fakeLock([], false),
      copySeed: (_from, to) => {
        fs.writeFileSync(to, stagedContent);
        return true;
      },
      run: fakeRun(calls),
    });
    assert.deepEqual(result, { action: 'seed', ok: false }, name);
    assert.deepEqual(calls, [], `${name}: no sync runs over an index that was never published`);
    assert.equal(fs.existsSync(path.join(worktree, '.codegraph', 'codegraph.db')), false, `${name}: nothing published`);
    assert.equal(fs.existsSync(path.join(worktree, '.codegraph')), false, `${name}: nothing left behind`);
  }
});

test('S3: the staged copy is judged by what the injected fs seam reads, and an unreadable one fails closed', () => {
  const base = temp('cg-seed-read-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), fakeIndex('main'));
  const targetDir = path.join(worktree, '.codegraph');
  const copy = (from, to) => {
    fs.copyFileSync(from, to);
    return true;
  };
  const seed = (fsSeam) => seedWorktreeIndex({ worktree, commonRoot: repo, sourceBusy: no, copy, fs: fsSeam });

  // A read that answers nothing, or throws, is not an index: it fails closed exactly like a failed copy.
  assert.equal(seed({ readFileSync: () => undefined }), false);
  assert.equal(fs.existsSync(targetDir), false, 'an unreadable staged copy publishes nothing');
  assert.equal(seed({
    readFileSync: () => {
      throw new Error('EACCES');
    },
  }), false);
  assert.equal(fs.existsSync(targetDir), false, 'a throwing read publishes nothing');
  assert.equal(seed({ readFileSync: () => 42 }), false, 'an unexpected answer is not guessed into an index');
  assert.equal(fs.existsSync(targetDir), false);

  // Raw bytes and a decoded string are both read, and a real header is a plausible index either way.
  assert.equal(seed({ readFileSync: () => Buffer.from(fakeIndex('bytes')) }), true);
  assert.equal(fs.readFileSync(path.join(targetDir, 'codegraph.db'), 'utf8'), fakeIndex('main'), 'the main db is what gets published');
  assert.equal(seed({ readFileSync: (file) => fs.readFileSync(file, 'utf8') }), true);
  assert.equal(fs.readFileSync(path.join(targetDir, 'codegraph.db'), 'utf8'), fakeIndex('main'));
});

test('S3: the seed is published with one rename, so no second write can leave a half-published db', () => {
  const base = temp('cg-seed-rename-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), fakeIndex('main'));
  const renames = [];
  const seeded = seedWorktreeIndex({
    worktree,
    commonRoot: repo,
    sourceBusy: no,
    copy: (from, to) => {
      fs.copyFileSync(from, to);
      return true;
    },
    fs: {
      renameSync: (from, to) => {
        renames.push([from, to]);
        fs.renameSync(from, to);
      },
      copyFileSync: () => {
        throw new Error('the staged file is moved, never copied a second time');
      },
    },
  });
  assert.equal(seeded, true);
  assert.equal(renames.length, 1, 'one rename publishes the staged copy');
  assert.match(renames[0][0], /codegraph\.db\.seeding$/, 'the staged file is what moves');
  assert.match(renames[0][1], /codegraph\.db$/, 'onto the index path');
  assert.deepEqual(fs.readdirSync(path.join(worktree, '.codegraph')), ['codegraph.db'], 'no staging file is left behind');
});

test('S3: a seam with no rename keeps the older two-write publish of the staged copy', () => {
  const base = temp('cg-seed-copy-fallback-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), fakeIndex('main'));
  const copies = [];
  const seeded = seedWorktreeIndex({
    worktree,
    commonRoot: repo,
    sourceBusy: no,
    copy: (from, to) => {
      fs.copyFileSync(from, to);
      return true;
    },
    fs: {
      copyFileSync: (from, to) => {
        copies.push([from, to]);
        fs.copyFileSync(from, to);
      },
    },
  });
  assert.equal(seeded, true);
  assert.equal(copies.length, 1, 'the publish copies the staged file once, as before');
  assert.match(copies[0][0], /codegraph\.db\.seeding$/);
  assert.match(copies[0][1], /codegraph\.db$/);
  assert.equal(fs.existsSync(path.join(worktree, '.codegraph', 'codegraph.db.seeding')), false, 'the staging file is removed');
});

test('S3: a directory another session published is never removed, not even by a failed seed', async () => {
  const base = temp('cg-seed-owned-');
  const { repo, worktree } = linkedWorktree(path.join(base, 'a'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), fakeIndex('main'));
  const otherDb = path.join(worktree, '.codegraph', 'codegraph.db');
  let checks = 0;
  // Another session publishes while this one waits for the lock, so the existence re-check under the lock sees it.
  const exists = (p) => {
    if (p === path.join(worktree, '.codegraph')) {
      checks += 1;
      if (checks > 1) {
        fs.mkdirSync(path.dirname(otherDb), { recursive: true });
        fs.writeFileSync(otherDb, fakeIndex('other session'));
        return true;
      }
      return false;
    }
    return fs.existsSync(p);
  };
  const calls = [];
  const result = await autoIndex({
    cwd: worktree,
    env: {},
    reason: 'startup',
    exists,
    hasBinary: yes,
    lock: fakeLock([], false),
    copySeed: () => {
      throw new Error('must not copy into a directory another session published');
    },
    run: fakeRun(calls, false),
  });
  assert.deepEqual(result, { action: 'seed', ok: true, joined: true });
  assert.deepEqual(calls, [], 'this session ran nothing over an index it does not own');
  assert.equal(fs.readFileSync(otherDb, 'utf8'), fakeIndex('other session'), "another session's index is untouched");
});

// ---- The CLI seam (S1, S2) ----

test('S2: a timed-out runCodegraph resolves only once the killed process is gone', async () => {
  const dir = temp('cg-run-');
  const pidFile = path.join(dir, 'fake.pid');
  const shim = path.join(dir, 'bin');
  fs.mkdirSync(shim);
  const stub = path.join(__dirname, 'fixtures', 'codegraph-cli-stub.js');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(shim, 'codegraph.cmd'), `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    const file = path.join(shim, 'codegraph');
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
    fs.chmodSync(file, 0o755);
  }
  const oldPath = process.env.PATH || '';
  const oldPidFile = process.env.CODEGRAPH_STUB_PID_FILE;
  process.env.PATH = `${shim}${path.delimiter}${oldPath}`;
  process.env.CODEGRAPH_STUB_PID_FILE = pidFile;
  try {
    const started = Date.now();
    let spawned;
    assert.equal(await runCodegraph(['init', '-y'], dir, 500, (pid, options) => {
      spawned = { pid, proxy: options && options.proxy };
    }), false);
    assert.ok(spawned !== undefined && spawned.pid > 0, 'the pid of the spawned command is reported');
    // On Windows `codegraph` runs through the npm shell shim, so that pid is the shell, not the init.
    assert.equal(spawned.proxy, process.platform === 'win32', JSON.stringify(spawned));
    assert.ok(Date.now() - started < 20_000, 'did not wait long after killing');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0, 'the fake wrote its pid');
    assert.throws(() => process.kill(pid, 0), `the killed init (pid ${pid}) is gone`);
  } finally {
    process.env.PATH = oldPath;
    if (oldPidFile === undefined) delete process.env.CODEGRAPH_STUB_PID_FILE;
    else process.env.CODEGRAPH_STUB_PID_FILE = oldPidFile;
  }
});

/** A stand-in for a spawned child: it records every signal it is asked for and lets the test end it. */
function fakeChild(pid) {
  const handlers = { error: [], close: [] };
  const signals = [];
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    signals,
    kill(signal = 'SIGTERM') {
      signals.push(signal);
      return true;
    },
    on(event, handler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return child;
    },
    end(code, signal) {
      child.exitCode = code;
      child.signalCode = signal;
      for (const handler of handlers.close) handler(code, signal);
      return child;
    },
  };
  return child;
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** Whether a pid is gone, polled because a hard kill is asynchronous on every platform. */
async function gone(pid, deadlineMs = 5_000) {
  const limit = Date.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > limit) return false;
    await sleep(25);
  }
}

/**
 * Waits for a marker a child process writes once it is ready. It polls with a deadline, so a slow start costs the
 * deadline and never a guessed sleep, and the caller proceeds on the evidence instead of on elapsed time.
 */
async function ready(file, deadlineMs = 10_000) {
  const limit = Date.now() + deadlineMs;
  for (;;) {
    if (fs.existsSync(file)) return true;
    if (Date.now() > limit) return false;
    await sleep(5);
  }
}

test('S5: a child that ignores SIGTERM is escalated to SIGKILL, and the timed-out run still reports failure', {
  // A POSIX signal trap is what this case is about; on Windows the escalation is the repeated taskkill the fake-child
  // case pins, and a soft `kill` ends the process outright, so there would be nothing to trap.
  skip: process.platform === 'win32' ? 'POSIX signal trapping' : false,
}, async () => {
  const dir = temp('cg-run-trap-');
  const pidFile = path.join(dir, 'trap.pid');
  const readyFile = path.join(dir, 'trap.ready');
  const termLog = path.join(dir, 'trap.term');
  const stub = path.join(dir, 'trap-cli.js');
  // A real child that traps SIGTERM: only a hard kill ends it. The trap is installed before the marker is written, so
  // the marker is the proof that a soft kill cannot end this process — and the trap records the signal it survived.
  fs.writeFileSync(stub, [
    "'use strict';",
    "const fs = require('node:fs');",
    `const pidFile = ${JSON.stringify(pidFile)};`,
    `const readyFile = ${JSON.stringify(readyFile)};`,
    `const termLog = ${JSON.stringify(termLog)};`,
    'fs.writeFileSync(pidFile, String(process.pid));',
    "process.on('SIGTERM', () => fs.appendFileSync(termLog, 'SIGTERM\\n'));",
    "fs.writeFileSync(readyFile, 'trap installed');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  // The child is started and announces itself first, so the run below cannot signal it before its trap exists: no
  // startup is guessed, and the timeout this case measures starts on a process that is already ready.
  const child = spawn(process.execPath, [stub], { stdio: 'ignore' });
  try {
    assert.equal(await ready(readyFile), true, 'the stub installed its SIGTERM trap before anything signals it');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(pid, child.pid, 'the stub that installed the trap is the process this run will kill');
    const ok = await runCodegraph(['init', '-y'], dir, 30, () => {}, {
      escalationMs: 200,
      killWaitMs: 1_000,
      spawn: () => child,
    });
    assert.equal(ok, false, 'the escalation still reports the timeout, never a success');
    assert.equal(fs.readFileSync(termLog, 'utf8'), 'SIGTERM\n', 'the trap ran: the soft kill reached the child and did not end it');
    assert.equal(await gone(pid, 2_000), true, `the child that trapped SIGTERM (pid ${pid}) is gone`);
  } finally {
    try {
      child.kill('SIGKILL'); // cleanup of this case's own child
    } catch {
      // Already gone.
    }
  }
});

test('S5: a child that dies on SIGTERM is not killed a second time and its failure is reported as before', async () => {
  const dir = temp('cg-run-term-');
  let child;
  const run = runCodegraph(['sync', '-q'], dir, 30, () => {}, {
    platform: 'linux',
    escalationMs: 60,
    spawn: () => {
      child = fakeChild(7001);
      const asked = child.kill;
      // The process really dies of the signal it was sent: the close event follows the kill.
      child.kill = (signal = 'SIGTERM') => {
        const ok = asked(signal);
        setImmediate(() => child.end(null, signal));
        return ok;
      };
      return child;
    },
  });
  assert.equal(await run, false, 'a killed run is a failed run');
  assert.deepEqual(child.signals, ['SIGTERM'], 'only the soft kill was sent');
  await sleep(120); // well past the escalation delay this run armed
  assert.deepEqual(child.signals, ['SIGTERM'], 'a child that already died is never escalated');
});

test('S5: a run that finishes normally neither escalates nor kills anything after it settled', async () => {
  const dir = temp('cg-run-ok-');
  let child;
  const run = runCodegraph(['sync', '-q'], dir, 1_000, () => {}, {
    platform: 'linux',
    escalationMs: 20,
    spawn: () => {
      child = fakeChild(7002);
      setTimeout(() => child.end(0, null), 5);
      return child;
    },
  });
  assert.equal(await run, true, 'a command that came back with 0 succeeded');
  await sleep(60);
  assert.deepEqual(child.signals, [], 'nothing is signalled after a successful run settled');
});

test('S5: the escalation delay is measured from the soft kill, so no hard kill lands before it', async () => {
  const dir = temp('cg-run-escalate-');
  const ESCALATION_MS = 200;
  // The only discount is the millisecond a signal timestamp and the timer queue can disagree by. Nothing is taken off
  // the delay itself: a shorter gap than this is a hard kill that did not wait.
  const SIGNAL_CLOCK_TOLERANCE_MS = 5;
  const received = [];
  const run = runCodegraph(['sync', '-q'], dir, 40, () => {}, {
    platform: 'linux',
    killWaitMs: 1_000,
    escalationMs: ESCALATION_MS,
    spawn: () => {
      const child = fakeChild(7003);
      const asked = child.kill;
      // The child's own record of when each signal reached it: the gap between the two is what "the delay" means here,
      // and it is the one interval this case can measure without the run's own start standing in for it.
      child.kill = (signal = 'SIGTERM') => {
        received.push({ signal, at: Date.now() });
        // Only the hard kill ends it, which is what a SIGTERM-trapping child looks like.
        if (signal === 'SIGKILL') setImmediate(() => child.end(null, signal));
        return asked(signal);
      };
      return child;
    },
  });
  assert.equal(await run, false, 'the escalated run reports the timeout');
  assert.deepEqual(received.map((entry) => entry.signal), ['SIGTERM', 'SIGKILL'], 'exactly one soft kill and one hard kill, in that order');
  const gap = received[1].at - received[0].at;
  assert.ok(gap >= ESCALATION_MS - SIGNAL_CLOCK_TOLERANCE_MS, `the hard kill waited the escalation delay after the soft one (${gap}ms)`);
});

test('S5: a requested escalation beyond the reporting grace is clamped, so the hard kill still lands', async () => {
  const dir = temp('cg-run-clamp-');
  const killWaitMs = 200;
  const requestedMs = 10_000;
  const killedAt = [];
  const started = Date.now();
  const run = runCodegraph(['sync', '-q'], dir, 40, () => {}, {
    platform: 'linux',
    killWaitMs,
    escalationMs: requestedMs,
    spawn: () => {
      const child = fakeChild(7006);
      const asked = child.kill;
      child.kill = (signal = 'SIGTERM') => {
        killedAt.push({ signal, at: Date.now() });
        // Only the hard kill ends it, which is what a SIGTERM-trapping child looks like.
        if (signal === 'SIGKILL') setImmediate(() => child.end(null, signal));
        return asked(signal);
      };
      return child;
    },
  });
  // The hard kill has to land inside the grace, so it is looked for before the run is allowed to report.
  const deadline = Date.now() + 1_000;
  while (!killedAt.some((entry) => entry.signal === 'SIGKILL') && Date.now() < deadline) await sleep(10);
  const hard = killedAt.filter((entry) => entry.signal === 'SIGKILL');
  assert.equal(hard.length, 1, `a requested ${requestedMs}ms escalation is clamped into the ${killWaitMs}ms grace: ${JSON.stringify(killedAt)}`);
  assert.equal(await run, false, 'the escalation still reports the timeout, never a success');
  assert.ok(hard[0].at - started <= killWaitMs, `the hard kill landed inside the reporting grace (${hard[0].at - started}ms)`);
});

test('S5: a run that already timed out never reports success, even when the child exits 0 afterwards', async () => {
  const dir = temp('cg-run-late-ok-');
  const run = runCodegraph(['sync', '-q'], dir, 30, () => {}, {
    platform: 'linux',
    escalationMs: 500,
    spawn: () => {
      const child = fakeChild(7004);
      // A child that traps SIGTERM and then exits cleanly on its own: the timeout already happened.
      setTimeout(() => child.end(0, null), 80);
      return child;
    },
  });
  assert.equal(await run, false, 'the timeout is the outcome, not the exit code that came after it');
});

test('S5: on Windows the hard kill is a second taskkill /T /F, run only while the pid lives', async () => {
  const dir = temp('cg-run-win-');
  const taskkills = [];
  const cli = fakeChild(7005);
  const run = runCodegraph(['sync', '-q'], dir, 20, () => {}, {
    platform: 'win32',
    escalationMs: 40,
    spawn: (command, args) => {
      if (command === 'taskkill') {
        taskkills.push((args || []).join(' '));
        return { on: () => {} };
      }
      // A shell proxy that only goes away once it is asked twice.
      setTimeout(() => cli.end(null, 'SIGKILL'), 200);
      return cli;
    },
  });
  assert.equal(await run, false, 'the timeout is reported');
  assert.deepEqual(taskkills, ['/pid 7005 /T /F', '/pid 7005 /T /F'], 'the escalation re-runs the hard kill while the pid lives');
  assert.deepEqual(cli.signals, [], 'Windows escalates through taskkill, not a POSIX signal');
});

test('S5: the escalation fires inside the reporting grace, never instead of it', () => {
  assert.ok(KILL_ESCALATION_MS > 0, 'the default delay is a positive number of milliseconds');
  assert.ok(KILL_ESCALATION_MS <= 2_000, 'a couple of seconds, not minutes');
  assert.ok(KILL_ESCALATION_MS < KILL_WAIT_MS, 'the hard kill lands inside the grace the run already reports on');
});

test('S2: the constant bounds of a run are the ones the commands use', () => {
  assert.equal(SYNC_TIMEOUT_MS, 120_000);
  assert.equal(INIT_TIMEOUT_MS, 600_000);
  assert.equal(POST_INIT_SYNC_WAIT_MS, 10_000);
});

// ---- The notices (S2, S3) ----

test('S2: the start of each action names that action, so create-or-sync is visible while it happens', () => {
  assert.match(indexStartNotice('init'), /creating the CodeGraph index/);
  assert.match(indexStartNotice('seed'), /seeding this worktree's CodeGraph index/);
  assert.match(indexStartNotice('sync'), /syncing the CodeGraph index/);
});

test('S2: only a run that came back is reported as synced, created or seeded', () => {
  assert.deepEqual(indexOutcomeNotice({ action: 'sync', ok: true }, 'C:\\p'), { text: 'CodeGraph index synced', level: 'info' });
  assert.deepEqual(indexOutcomeNotice({ action: 'init', ok: true }, 'C:\\p'), { text: 'CodeGraph index created', level: 'info' });
  assert.deepEqual(indexOutcomeNotice({ action: 'seed', ok: true }, 'C:\\p'), { text: 'CodeGraph index seeded from the main repo and synced', level: 'info' });
});

test('S3: a queued, joined or coalesced request is never presented as a sync of this session', () => {
  const queued = indexOutcomeNotice({ action: 'sync', ok: true, queued: true }, 'C:\\p');
  assert.match(queued.text, /queued, not run yet/);
  assert.doesNotMatch(queued.text, /synced/i);

  const coalesced = indexOutcomeNotice({ action: 'sync', ok: true, coalesced: true }, 'C:\\p');
  assert.match(coalesced.text, /another session's run completed/);
  assert.doesNotMatch(coalesced.text, /^CodeGraph index synced$/);

  const joinedInit = indexOutcomeNotice({ action: 'init', ok: true, joined: true }, 'C:\\p');
  assert.match(joinedInit.text, /another session is creating the CodeGraph index/);
  const joinedSync = indexOutcomeNotice({ action: 'sync', ok: true, joined: true }, 'C:\\p');
  assert.match(joinedSync.text, /this session did not sync it/);
  assert.doesNotMatch(joinedSync.text, /^CodeGraph index synced$/);
});

test('S3: unusable coordination is a warning that says no sync was started, not a synced index', () => {
  const notice = indexOutcomeNotice({ action: 'sync', ok: false, unavailable: true }, 'C:\\p');
  assert.deepEqual(notice, { text: 'could not coordinate the CodeGraph index sync in C:\\p; no sync was started', level: 'warning' });
});

test('S3: a failed command is a warning naming the action, and never says the index is up to date', () => {
  for (const action of ['sync', 'init', 'seed']) {
    const notice = indexOutcomeNotice({ action, ok: false }, 'C:\\p');
    assert.equal(notice.level, 'warning');
    assert.match(notice.text, new RegExp(`codegraph ${action} failed in C:\\\\p`));
    assert.match(notice.text, /the index is not up to date/);
  }
});

test('S3: the warm-up outcome is reported apart from the index one', () => {
  assert.deepEqual(warmOutcomeNotice('ok', 'C:\\p'), { text: 'CodeGraph ready', level: 'info' });
  assert.deepEqual(warmOutcomeNotice('failed', 'C:\\p'), { text: `CodeGraph warm-up failed in C:\\p`, level: 'warning' });
});

test('S4: a completed post-init sync appends nothing, and a sync that did not complete is one short line', () => {
  assert.equal(postInitSyncNotice('completed'), undefined, 'the tool result stays the whole answer when the sync completed');
  for (const outcome of ['pending', 'failed', 'unavailable', 'skipped-read-only']) {
    const notice = postInitSyncNotice(outcome);
    assert.equal(typeof notice, 'string', outcome);
    assert.equal(notice.includes('\n'), false, `${outcome}: one line, no second paragraph`);
    assert.doesNotMatch(notice, /pi-odd-worktree/, `${outcome}: no plugin prefix`);
    assert.doesNotMatch(notice, /coordinated index sync completed/, `${outcome}: a completed sync is the only thing that says completed`);
  }
  assert.match(postInitSyncNotice('pending'), /pending/);
  assert.match(postInitSyncNotice('pending'), /not confirmed current/);
  assert.doesNotMatch(postInitSyncNotice('pending'), /synced|up to date/i);
  assert.match(postInitSyncNotice('failed'), /failed; this index may be behind/);
  assert.doesNotMatch(postInitSyncNotice('failed'), /synced/);
  assert.match(postInitSyncNotice('unavailable'), /could not start/);
  assert.match(postInitSyncNotice('unavailable'), /not confirmed current/);
  assert.doesNotMatch(postInitSyncNotice('unavailable'), /synced/);
  assert.match(postInitSyncNotice('skipped-read-only'), /read-only/);
  assert.match(postInitSyncNotice('skipped-read-only'), /not confirmed current/);
});

test('S2: the index root is the nearest directory at or above the cwd holding the database', () => {
  const root = temp('cg-notice-');
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), '');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  assert.equal(findIndexRoot(root), root);
  assert.equal(findIndexRoot(path.join(root, 'src')), root);
  assert.equal(findIndexRoot(path.join(root, 'src', 'deep')), root);
});

test('S2: a .codegraph folder without a database is not an index, and no index means no root', () => {
  const root = temp('cg-notice-empty-');
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), '');
  fs.mkdirSync(path.join(root, 'sub', '.codegraph'), { recursive: true });
  assert.equal(findIndexRoot(path.join(root, 'sub')), root, 'the walk continues past a folder without the database');
  assert.equal(findIndexRoot(path.join('some', 'not-indexed'), () => false), undefined);
});

test('S2: the tools of a session are its selected ones plus the ones a child asked for', () => {
  const MCP = 'mcp__codegraph__codegraph_explore';
  assert.deepEqual(noticeTools(['read', 'grep'], ` read, ${MCP} ,mcp__codegraph__*, `, true), ['read', 'grep', MCP, 'mcp__codegraph__*']);
  assert.deepEqual(noticeTools(['bash'], MCP, false), ['bash']);
  assert.deepEqual(noticeTools(['read', MCP], `${MCP},codegraph`, true), ['read', MCP, 'codegraph'], 'no duplicates');
  assert.deepEqual(noticeTools([], '', true), []);
  assert.deepEqual(noticeTools([], undefined, true), []);
});

// ---- The observed native `init` (S3, S6) ----

const nativeInit = (over) => ({ toolName: 'codegraph', isError: false, input: { operation: 'init' }, ...over });

test('S3: only a successful native `codegraph init` is observed; every other call is left alone', () => {
  assert.equal(isNativeInitResult(nativeInit()), true);
  assert.equal(initHookDecision(nativeInit(), undefined), 'sync');
  assert.equal(isNativeInitResult(nativeInit({ isError: true })), false);
  assert.equal(initHookDecision(nativeInit({ isError: true }), undefined), 'skip-failed-init');
  assert.equal(initHookDecision(nativeInit({ input: { operation: 'explore' } }), undefined), 'skip-not-a-native-init');
  assert.equal(initHookDecision(nativeInit({ toolName: 'mcp__codegraph__codegraph_explore', input: {} }), undefined), 'skip-not-a-native-init');
  assert.equal(initHookDecision(nativeInit({ toolName: 'bash', input: { command: 'codegraph init' } }), undefined), 'skip-not-a-native-init');
});

test('S6: a read-only role gets the read-only decision, every other role syncs', () => {
  assert.equal(initHookDecision(nativeInit(), 'read-only'), 'skip-read-only');
  assert.equal(initHookDecision(nativeInit(), 'explorer'), 'sync');
  assert.equal(initHookDecision(nativeInit(), 'writer'), 'sync');
  assert.equal(initHookDecision(nativeInit(), undefined), 'sync', 'the main session is not a read-only role');
});

test('S3: after a successful native init one coordinated sync runs and the result says completed', async () => {
  const cwd = temp('cg-init-hook-');
  const runs = [];
  const seen = [];
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => true,
    sync: runsHere(),
    lock: null,
    run: async (args) => {
      runs.push(args);
      return true;
    },
    log: (entry) => seen.push(entry.outcome),
  });
  assert.equal(outcome, 'completed');
  assert.deepEqual(runs, [['sync', '-q']]);
  assert.deepEqual(seen, ['init-sync-synced']);
});

test('S3: the outcome the hook waits for is bounded, and only a finished run is called completed', async () => {
  const cwd = temp('cg-init-hook-wait-');
  const started = Date.now();
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => true,
    sync: { request: async () => ({ status: 'queued' }) },
    run: async () => true,
    waitMs: 20,
  });
  assert.equal(outcome, 'pending');
  assert.ok(Date.now() - started < 2_000, 'the tool result does not wait for a full sync');
});

test("S3: a sync another session's run completed after this request is completed, not a sync of this session", async () => {
  const cwd = temp('cg-init-hook-coalesced-');
  let ran = false;
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => true,
    sync: { request: async () => ({ status: 'coalesced' }) },
    run: async () => {
      ran = true;
      return true;
    },
  });
  assert.equal(outcome, 'completed');
  assert.equal(ran, false);
});

test('S3: a failed sync is reported as failed, and the command really ran once', async () => {
  const cwd = temp('cg-init-hook-failed-');
  const runs = [];
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => true,
    sync: runsHere(),
    lock: null,
    run: async (args) => {
      runs.push(args);
      return false;
    },
  });
  assert.equal(outcome, 'failed');
  assert.equal(runs.length, 1);
});

test('S3: unusable coordination is reported as unavailable and nothing is run beside it', async () => {
  const cwd = temp('cg-init-hook-unavailable-');
  let ran = false;
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => true,
    sync: { request: async () => ({ status: 'unavailable' }) },
    run: async () => {
      ran = true;
      return true;
    },
  });
  assert.equal(outcome, 'unavailable');
  assert.equal(ran, false, 'no uncoordinated sync may be started as a fallback');
});

test('S6: a read-only role starts no index write at all, and its tool result says why', async () => {
  const cwd = temp('cg-init-hook-role-');
  let asked = false;
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => true,
    role: 'read-only',
    sync: {
      request: async () => {
        asked = true;
        return { status: 'coalesced' };
      },
    },
    run: async () => {
      throw new Error('must not run');
    },
  });
  assert.equal(outcome, 'skipped-read-only');
  assert.equal(asked, false, 'the coordination is not even asked');
  assert.match(postInitSyncNotice(outcome), /read-only/);
});

test('S3: an init that left no index requests nothing, because syncing a missing index would fail', async () => {
  const cwd = temp('cg-init-hook-noindex-');
  let asked = false;
  const outcome = await syncAfterNativeInit({
    cwd,
    exists: () => false,
    sync: {
      request: async () => {
        asked = true;
        return { status: 'coalesced' };
      },
    },
    run: async () => true,
  });
  assert.equal(outcome, 'failed');
  assert.equal(asked, false);
});

// ---- prepareProject: the index first, then whatever the caller warms (S2, S3) ----

function prepareSetup(options) {
  const log = [];
  const input = {
    cwd: CWD,
    env: options.env || {},
    reason: options.reason || 'startup',
    exists: has(...options.present),
    hasBinary: yes,
    lock: null,
    sync: null,
    onStart: (action) => log.push(`start:${action}`),
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return options.run === undefined ? true : options.run;
    },
    onIndexed: (result) => log.push(`indexed:${result.action}:${result.ok}`),
    onWarmStart: () => log.push('warm-start'),
    warm: async (cwd) => {
      log.push(`warm:${cwd}`);
      if (options.warm === 'throw') throw new Error('boom');
      return options.warm === undefined ? true : options.warm;
    },
  };
  return { log, input };
}

test('S2: with an index, the caller warms after the sync, in that order', async () => {
  const { log, input } = prepareSetup({ present: ['.codegraph'] });
  const result = await prepareProject(input);
  assert.deepEqual(log, ['start:sync', 'run:sync', 'indexed:sync:true', 'warm-start', `warm:${CWD}`]);
  assert.deepEqual(result, { index: { action: 'sync', ok: true }, warm: 'ok' });
});

test('S2: a fresh init that worked is warmed too; one that failed is not', async () => {
  const okSetup = prepareSetup({ present: ['.git', 'package.json'] });
  const ok = await prepareProject(okSetup.input);
  assert.deepEqual(okSetup.log, ['start:init', 'run:init', 'indexed:init:true', 'warm-start', `warm:${CWD}`]);
  assert.equal(ok.warm, 'ok');

  const failedSetup = prepareSetup({ present: ['.git', 'package.json'], run: false });
  const failed = await prepareProject(failedSetup.input);
  assert.deepEqual(failedSetup.log, ['start:init', 'run:init', 'indexed:init:false']);
  assert.deepEqual(failed, { index: { action: 'init', ok: false }, warm: 'skipped' });
});

test('S3: while another session holds the init lock, this one neither syncs nor warms', async () => {
  const log = [];
  const result = await prepareProject({
    cwd: CWD,
    env: {},
    reason: 'startup',
    exists: has('.codegraph'),
    hasBinary: yes,
    sync: null,
    lock: { acquire: () => ({ status: 'busy' }), isHeld: () => true },
    run: async (args) => {
      log.push(`run:${args[0]}`);
      return true;
    },
    onWarmStart: () => log.push('warm-start'),
    warm: async () => {
      log.push('warm');
      return true;
    },
  });
  assert.deepEqual(log, []);
  assert.deepEqual(result, { index: { action: 'sync', ok: true, joined: true }, warm: 'skipped' });
});

test('S2: a failed sync still warms, because the index exists', async () => {
  const { log, input } = prepareSetup({ present: ['.codegraph'], run: false });
  const result = await prepareProject(input);
  assert.ok(log.includes(`warm:${CWD}`));
  assert.equal(result.warm, 'ok');
});

test('S2: no index and nothing to init -> nothing is warmed', async () => {
  const { log, input } = prepareSetup({ present: ['.git'] });
  const result = await prepareProject(input);
  assert.deepEqual(log, []);
  assert.deepEqual(result, { index: { action: 'none', ok: true }, warm: 'skipped' });
});

test('S2: subagent children and /reload never warm', async () => {
  for (const options of [{ env: { GENTLE_PI_AGENTS_CHILD: '1' } }, { reason: 'reload' }]) {
    const { log, input } = prepareSetup({ present: ['.codegraph'], ...options });
    const result = await prepareProject(input);
    assert.deepEqual(log, [], JSON.stringify(options));
    assert.equal(result.warm, 'skipped');
  }
});

test('S2: a warm-up that fails or throws is reported as failed and never rejects', async () => {
  for (const warm of [false, 'throw']) {
    const { input } = prepareSetup({ present: ['.codegraph'], warm });
    const result = await prepareProject(input);
    assert.equal(result.warm, 'failed', String(warm));
  }
});

test('S3: a startup sync that coalesced, is queued or has no coordination still warms, because the index exists', async () => {
  for (const [sync, expected] of [
    [{ request: async () => ({ status: 'coalesced' }) }, { action: 'sync', ok: true, coalesced: true }],
    [{ request: async () => ({ status: 'queued' }) }, { action: 'sync', ok: true, queued: true }],
    [{ request: async () => ({ status: 'unavailable' }) }, { action: 'sync', ok: false, unavailable: true }],
  ]) {
    const log = [];
    const result = await prepareProject({
      cwd: CWD,
      env: {},
      reason: 'startup',
      exists: has('.codegraph'),
      hasBinary: yes,
      lock: null,
      sync,
      run: async (args) => {
        log.push(`run:${args[0]}`);
        return true;
      },
      onIndexed: (index) => log.push(`indexed:${index.action}:${index.ok}`),
      warm: async () => {
        log.push('warm');
        return true;
      },
    });
    assert.deepEqual(result.index, expected);
    assert.equal(result.warm, 'ok');
    assert.equal(log[log.length - 1], 'warm');
  }
});

test('S2: an init is never handed to the sync coordinator', async () => {
  const { log, input } = prepareSetup({ present: ['.git', 'package.json'] });
  let asked = false;
  const result = await prepareProject({
    ...input,
    sync: {
      request: async () => {
        asked = true;
        return { status: 'coalesced' };
      },
    },
  });
  assert.equal(asked, false);
  assert.deepEqual(log, ['start:init', 'run:init', 'indexed:init:true', 'warm-start', `warm:${CWD}`]);
  assert.equal(result.index.ok, true);
});

test('S2: startup, new, resume and fork warm', async () => {
  for (const reason of ['startup', 'new', 'resume', 'fork']) {
    const { log, input } = prepareSetup({ present: ['.codegraph'], reason });
    await prepareProject(input);
    assert.ok(log.includes(`warm:${CWD}`), reason);
  }
});

test('S2: without the codegraph CLI a session prepares nothing, and the probe happens once per process', async () => {
  const probes = [];
  const hasBinary = (command) => {
    probes.push(command);
    return false;
  };
  let warmed = false;
  const input = {
    cwd: CWD,
    env: {},
    reason: 'startup',
    exists: has('.codegraph'),
    hasBinary,
    lock: null,
    sync: null,
    run: async () => {
      throw new Error('must not run');
    },
    warm: async () => {
      warmed = true;
      return true;
    },
  };
  const first = await prepareProject(input);
  const second = await prepareProject(input);
  assert.deepEqual(probes, ['codegraph']);
  assert.equal(warmed, false);
  assert.deepEqual(first, { index: { action: 'none', ok: true, skipped: 'no-cli' }, warm: 'skipped' });
  assert.deepEqual(second, first);
});

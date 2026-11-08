'use strict';
// S1-S6/S8: the session gate, the git-toplevel root cache, and the background
// sync scheduler. Every child process and every git read is injected, so this
// suite never starts a real process and never reaches the network; the only
// real filesystem is a throwaway temp directory outside the worktree (the
// `.codegraph/` marker, the lock and the daemon pid are files on disk).
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const session = require('../lib/codegraph-session.js');
const hooksLib = require('../lib/worktree-hooks.js');

const scratch = [];
function tempDir(prefix = 'cg-session-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* teardown is best effort */ }
  }
});

beforeEach(() => {
  session.resetCodegraphSession();
});

const FORCED_ENV = { PATH: '', CODEGRAPH_FORCE: '1' };

function makeRoot() {
  const root = tempDir('cg-root-');
  fs.mkdirSync(path.join(root, '.codegraph'));
  return root;
}

// deps for one scheduler test. `onSpawn` lets a test hold a run open (no
// close event) or release it; `overrides` replaces any other seam.
function makeDeps(root, overrides = {}) {
  const { onSpawn, spawn: launch, ...rest } = overrides;
  const spawns = [];
  const children = [];
  const deps = {
    env: FORCED_ENV,
    execFile: (bin) => {
      assert.equal(bin, 'git');
      return `${root}\n`;
    },
    debounceMs: 10,
    retryDelayMs: 30,
    ...rest,
    spawn: (bin, args, opts) => {
      spawns.push({ bin, args, opts });
      const child = typeof launch === 'function' ? launch(bin, args, opts) : new EventEmitter();
      if (!child) return child;
      const unref = child.unref;
      child.unref = () => {
        child.unrefed = true;
        if (typeof unref === 'function') unref.call(child);
      };
      children.push(child);
      if (typeof onSpawn === 'function') onSpawn(child, children.length - 1);
      return child;
    },
  };
  return { deps, spawns, children };
}

const closeSoon = (child) => setImmediate(() => child.emit('close'));

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('session gate (S3/S4)', () => {
  test('probes PATH once and caches the answer', () => {
    const bin = tempDir('cg-bin-');
    const env = { PATH: `${bin}${path.delimiter}/cg-session-empty-dir` };
    let probes = 0;
    const deps = {
      binaryExists: (file) => {
        probes += 1;
        return path.dirname(file) === bin && path.basename(file) === 'codegraph';
      },
    };
    assert.equal(session.hasCodegraph(env, deps), true);
    const first = probes;
    assert.ok(first > 0, 'the first answer is probed');
    assert.equal(session.hasCodegraph(env, deps), true);
    assert.equal(probes, first, 'a second question never re-probes');
    // A PATH that changed mid-session is not re-read either.
    assert.equal(session.hasCodegraph({ PATH: '/cg-session-other' }, deps), true);
    assert.equal(probes, first);
  });

  test('caches a missing CLI as false', () => {
    const env = { PATH: tempDir('cg-empty-') };
    let probes = 0;
    const deps = { binaryExists: () => { probes += 1; return false; } };
    assert.equal(session.hasCodegraph(env, deps), false);
    const first = probes;
    assert.equal(session.hasCodegraph(env, deps), false);
    assert.equal(probes, first);
  });

  test('CODEGRAPH_FORCE=1 answers present without probing', () => {
    const mustNotProbe = { binaryExists: () => { throw new Error('must not probe'); } };
    assert.equal(session.hasCodegraph({ PATH: '', CODEGRAPH_FORCE: '1' }, mustNotProbe), true);
    // ...and it escapes an answer already cached as false in this session.
    assert.equal(session.hasCodegraph({ PATH: '' }, { binaryExists: () => false }), false);
    assert.equal(session.hasCodegraph({ PATH: '', CODEGRAPH_FORCE: '1' }, mustNotProbe), true);
  });

  test('a false gate means no spawn ever', async () => {
    const root = makeRoot();
    const { deps, spawns } = makeDeps(root, { env: { PATH: tempDir('cg-empty-') } });
    const decision = session.scheduleSync(path.join(root, 'src', 'a.js'), deps);
    assert.deepEqual(decision, { scheduled: false, reason: 'no-codegraph' });
    await session.whenIdle();
    assert.equal(spawns.length, 0);
  });

  test('the gate fails closed when codegraph is absent from the process PATH', () => {
    // One probe per process is the contract; a forced env is the only escape.
    assert.equal(session.hasCodegraph({ PATH: tempDir('cg-empty-') }), false);
  });
});

describe('root resolution (S1)', () => {
  test('returns the git toplevel, cached per directory', () => {
    const root = tempDir('cg-repo-');
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    let calls = 0;
    const deps = { execFile: () => { calls += 1; return `${root}\n`; } };
    assert.equal(session.resolveProjectRoot(sub, deps), root);
    assert.equal(session.resolveProjectRoot(sub, deps), root);
    assert.equal(calls, 1);
    assert.equal(session.resolveProjectRoot(root, deps), root);
    assert.equal(calls, 2, 'each directory is its own cache entry');
  });

  test('returns null outside git and caches the null', () => {
    const notRepo = tempDir('cg-not-repo-');
    let failures = 0;
    const deps = { execFile: () => { failures += 1; throw new Error('fatal: not a git repository'); } };
    assert.equal(session.resolveProjectRoot(notRepo, deps), null);
    assert.equal(session.resolveProjectRoot(notRepo, deps), null);
    assert.equal(failures, 1);
  });

  test('a non-zero git answer resolves to null', () => {
    const dir = tempDir('cg-git-exit-');
    assert.equal(session.resolveProjectRoot(dir, { execFile: () => '' }), null);
  });
});

describe('scheduler (S1/S2/S6/S8)', () => {
  test('two rapid edits produce exactly one sync, detached and unref\'d', async () => {
    const root = makeRoot();
    const file = path.join(root, 'src', 'a.js');
    const { deps, spawns, children } = makeDeps(root, { onSpawn: closeSoon });
    const first = session.scheduleSync(file, deps);
    const second = session.scheduleSync(file, deps);
    assert.equal(first.scheduled, true);
    assert.equal(second.scheduled, true);
    await session.whenIdle();
    assert.equal(spawns.length, 1, 'the second edit only resets the debounce');
    assert.equal(spawns[0].bin, 'codegraph');
    assert.deepEqual(spawns[0].args, ['sync', root]);
    assert.equal(spawns[0].opts.detached, true);
    assert.equal(spawns[0].opts.stdio, 'ignore');
    assert.equal(children[0].unrefed, true, 'the child is unref\'d, never awaited');
  });

  test('an edit during a running sync produces exactly one more', async () => {
    const root = makeRoot();
    const file = path.join(root, 'src', 'a.js');
    const { deps, spawns, children } = makeDeps(root);
    assert.equal(session.scheduleSync(file, deps).scheduled, true);
    await waitFor(() => spawns.length === 1);
    assert.equal(session.scheduleSync(file, deps).reason, 'queued');
    assert.equal(spawns.length, 1, 'nothing starts while the first run is open');
    children[0].emit('close');
    await waitFor(() => spawns.length === 2);
    children[1].emit('close');
    await session.whenIdle();
    assert.equal(spawns.length, 2);
  });

  test('a held foreign lock skips and the deferred retry fires exactly once', async () => {
    const root = makeRoot();
    const lock = path.join(root, '.codegraph', 'pi-sync.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    let lockReads = 0;
    const { deps, spawns } = makeDeps(root, {
      readFile: (file) => {
        if (file === lock) lockReads += 1;
        return fs.readFileSync(file, 'utf8');
      },
    });
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    await session.whenIdle();
    assert.equal(spawns.length, 0, 'a live foreign lock is never taken over');
    assert.equal(lockReads, 2, 'the first attempt plus exactly one deferred retry');
    assert.ok(fs.existsSync(lock), 'the foreign lock is left alone');
  });

  test('a lock released before the retry lets exactly one sync land', async () => {
    const root = makeRoot();
    const lock = path.join(root, '.codegraph', 'pi-sync.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    let lockReads = 0;
    const { deps, spawns } = makeDeps(root, {
      retryDelayMs: 60,
      onSpawn: closeSoon,
      readFile: (file) => {
        if (file === lock) lockReads += 1;
        return fs.readFileSync(file, 'utf8');
      },
    });
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    await waitFor(() => lockReads === 1);
    assert.equal(spawns.length, 0);
    fs.unlinkSync(lock);
    await session.whenIdle();
    assert.equal(spawns.length, 1);
  });

  test('a dead-pid lock is taken over', async () => {
    const root = makeRoot();
    const lock = path.join(root, '.codegraph', 'pi-sync.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 424242, startedAt: Date.now() }));
    const { deps, spawns } = makeDeps(root, { isAlive: () => false, onSpawn: closeSoon });
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    await session.whenIdle();
    assert.equal(spawns.length, 1);
  });

  test('an expired lock TTL is taken over even with a live pid', async () => {
    const root = makeRoot();
    const lock = path.join(root, '.codegraph', 'pi-sync.lock');
    const now = 1_000_000_000_000;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: now - (10 * 60 * 1000) }));
    const { deps, spawns } = makeDeps(root, { now: () => now, onSpawn: closeSoon });
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    await session.whenIdle();
    assert.equal(spawns.length, 1);
  });

  test('a root without .codegraph/ spawns nothing (S6)', async () => {
    const root = tempDir('cg-no-index-');
    const { deps, spawns } = makeDeps(root);
    const decision = session.scheduleSync(path.join(root, 'a.js'), deps);
    assert.deepEqual(decision, { scheduled: false, reason: 'no-index' });
    await session.whenIdle();
    assert.equal(spawns.length, 0);
  });

  test('a live daemon.pid spawns nothing (S5)', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, '.codegraph', 'daemon.pid'), `${process.pid}\n`);
    const { deps, spawns } = makeDeps(root);
    const decision = session.scheduleSync(path.join(root, 'a.js'), deps);
    assert.deepEqual(decision, { scheduled: false, reason: 'daemon' });
    await session.whenIdle();
    assert.equal(spawns.length, 0);
  });

  test('the daemon pidfile in its JSON form counts as live too (S5)', async () => {
    const root = makeRoot();
    // CodeGraph 1.6 writes {pid, version, socketPath, startedAt}; a plain
    // decimal is the legacy shape. Both must be understood.
    fs.writeFileSync(path.join(root, '.codegraph', 'daemon.pid'), JSON.stringify({
      pid: process.pid, version: '1.6.0', socketPath: '/tmp/cg.sock', startedAt: Date.now(),
    }));
    const { deps, spawns } = makeDeps(root);
    assert.deepEqual(session.scheduleSync(path.join(root, 'a.js'), deps), { scheduled: false, reason: 'daemon' });
    await session.whenIdle();
    assert.equal(spawns.length, 0);
  });

  test('a sync that never closes is killed by the run watchdog and the root stays usable (S2)', async () => {
    const root = makeRoot();
    const killed = [];
    const { deps, spawns } = makeDeps(root, {
      runTimeoutMs: 25,
      onSpawn: (child) => { child.kill = (signal) => { killed.push(signal); }; },
    });
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    // The watchdog timer is unref'd on purpose (a settled sync must never keep
    // the host alive), so this test holds the loop itself instead of relying on
    // the runner: without a live handle the loop can drain before 25ms on some
    // Node versions, which would cancel the pending whenIdle().
    await Promise.race([
      session.whenIdle(),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    assert.deepEqual(killed, ['SIGTERM'], 'the stuck child is terminated');
    // The lock came back and the root is not wedged: the next edit syncs.
    const next = makeDeps(root, { onSpawn: closeSoon });
    assert.equal(session.scheduleSync(path.join(root, 'b.js'), next.deps).scheduled, true);
    await session.whenIdle();
    assert.equal(next.spawns.length, 1);
  });

  test('a dead daemon.pid does not suppress the sync', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, '.codegraph', 'daemon.pid'), '424242\n');
    const { deps, spawns } = makeDeps(root, { isAlive: () => false, onSpawn: closeSoon });
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    await session.whenIdle();
    assert.equal(spawns.length, 1);
  });

  test('a thrown spawn error does not propagate and leaves the root usable', async () => {
    const root = makeRoot();
    const lock = path.join(root, '.codegraph', 'pi-sync.lock');
    let attempts = 0;
    const { deps, spawns } = makeDeps(root, {
      spawn: () => { attempts += 1; throw new Error('boom'); },
    });
    assert.doesNotThrow(() => session.scheduleSync(path.join(root, 'a.js'), deps));
    await session.whenIdle();
    assert.equal(attempts, 1);
    assert.equal(spawns.length, 1, 'one launch was attempted');
    assert.ok(!fs.existsSync(lock), 'the lock is released after a failed spawn');
    assert.equal(session.scheduleSync(path.join(root, 'a.js'), deps).scheduled, true);
    await session.whenIdle();
    assert.equal(attempts, 2, 'the root is not stuck in a running state');
  });

  test('a missing or unknown path is a decision, never a throw', async () => {
    const { deps, spawns } = makeDeps(makeRoot());
    assert.doesNotThrow(() => session.scheduleSync(undefined, deps));
    assert.deepEqual(session.scheduleSync('', deps), { scheduled: false, reason: 'no-path' });
    await session.whenIdle();
    assert.equal(spawns.length, 0);
  });
});

// The creation hooks consult the one session gate (S3). An injected
// `hasBinary` stays authoritative, so every pre-existing caller keeps its
// behavior.
describe('codegraph init follows the session gate (S3)', () => {
  function roots() {
    return { principalRoot: tempDir('cg-principal-'), worktreePath: tempDir('cg-worktree-') };
  }

  test('a false gate skips init with a reason that names the session gate', () => {
    const { principalRoot, worktreePath } = roots();
    const runs = [];
    const out = hooksLib.runCreationHooks({
      principalRoot,
      worktreePath,
      env: { PATH: tempDir('cg-empty-') },
      run: (bin, args) => { runs.push([bin, ...args]); return { status: 1, stdout: '', stderr: '', error: null }; },
      unversionedCandidates: [],
    });
    const step = out.steps.find((entry) => entry.name === 'codegraph-init');
    assert.equal(step.status, 'skipped');
    assert.match(step.detail, /session gate/);
    assert.ok(!runs.some(([bin]) => bin === 'codegraph'), 'no codegraph child runs');
  });

  test('the async twin reads the same gate decision', async () => {
    const { principalRoot, worktreePath } = roots();
    const runs = [];
    const out = await hooksLib.runCreationHooksAsync({
      principalRoot,
      worktreePath,
      env: { PATH: tempDir('cg-empty-') },
      runAsync: async (bin, args) => {
        runs.push([bin, ...args]);
        return { status: 1, stdout: '', stderr: '', error: null };
      },
      unversionedCandidates: [],
    });
    const step = out.steps.find((entry) => entry.name === 'codegraph-init');
    assert.equal(step.status, 'skipped');
    assert.match(step.detail, /session gate/);
    assert.ok(!runs.some(([bin]) => bin === 'codegraph'));
  });

  test('an injected hasBinary still decides, unchanged', () => {
    const { principalRoot, worktreePath } = roots();
    const runs = [];
    const out = hooksLib.runCreationHooks({
      principalRoot,
      worktreePath,
      env: { PATH: '' },
      hasBinary: (bin) => bin === 'codegraph',
      run: (bin, args) => {
        runs.push([bin, ...args]);
        return { status: bin === 'codegraph' ? 0 : 1, stdout: '', stderr: '', error: null };
      },
      unversionedCandidates: [],
    });
    const step = out.steps.find((entry) => entry.name === 'codegraph-init');
    assert.equal(step.status, 'done');
    assert.ok(runs.some(([bin, arg]) => bin === 'codegraph' && arg === 'init'));
  });

  test('an injected hasBinary that says no keeps the old skip reason', () => {
    const { principalRoot, worktreePath } = roots();
    const out = hooksLib.runCreationHooks({
      principalRoot,
      worktreePath,
      env: { PATH: '' },
      hasBinary: () => false,
      run: () => ({ status: 1, stdout: '', stderr: '', error: null }),
      unversionedCandidates: [],
    });
    const step = out.steps.find((entry) => entry.name === 'codegraph-init');
    assert.equal(step.status, 'skipped');
    assert.equal(step.detail, 'codegraph not on PATH');
  });
});

// T2: the extension turns a successful edit/write into one scheduling call and
// nothing else. scheduleSync is stubbed here so the assertion is only about the
// wiring (its own behavior is covered above).
describe('extension wiring (T2)', () => {
  test('a successful edit and write schedule a sync; everything else does not', async () => {
    const { loadExtension } = require('./fixtures/load-extension.js');
    const { hooks } = await loadExtension({});
    const handlers = hooks.filter(([name]) => name === 'tool_result').map(([, handler]) => handler);
    assert.ok(handlers.length >= 1, 'a tool_result handler is registered');
    const calls = [];
    const original = session.scheduleSync;
    session.scheduleSync = (filePath) => { calls.push(filePath); return { scheduled: true, reason: 'scheduled' }; };
    try {
      const ctx = { cwd: os.tmpdir() };
      for (const handler of handlers) {
        await handler({ toolName: 'edit', isError: false, input: { path: '/tmp/a.js' } }, ctx);
        await handler({ toolName: 'write', isError: false, input: { path: '/tmp/b.js' } }, ctx);
        await handler({ toolName: 'edit', isError: true, input: { path: '/tmp/c.js' } }, ctx);
        await handler({ toolName: 'bash', isError: false, input: { command: 'ls' } }, ctx);
        await handler({ toolName: 'edit', isError: false, input: {} }, ctx);
        await handler({ toolName: 'edit', isError: false }, ctx);
        await handler({}, ctx);
      }
    } finally {
      session.scheduleSync = original;
    }
    assert.deepEqual(calls, ['/tmp/a.js', '/tmp/b.js']);
  });
});

'use strict';
// S9/T5: the three session commands — `/codegraph-hook`, `/codegraph-init` and
// `/codegraph-sync`.
//
// Two halves. The REGISTRATION half goes through the real extension loader with
// a fake Pi host: the commands exist only when the session gate answers that the
// `codegraph` CLI is present, so a session without it never lists them. The
// BODIES half drives `lib/codegraph-commands.js` directly with injected seams:
// no real `codegraph` child is ever started, and the hook toggle is observed
// through the scheduler's own decision instead of internal state.
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const session = require('../lib/codegraph-session.js');
const commands = require('../lib/codegraph-commands.js');
const { loadExtension } = require('./fixtures/load-extension.js');

const scratch = [];
function tempDir(prefix = 'cg-commands-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

after(() => {
  restoreEnv();
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* teardown is best effort */ }
  }
});

beforeEach(() => {
  restoreEnv();
  session.resetCodegraphSession();
});

// --- fixtures -----------------------------------------------------------

// A directory PATH with no `codegraph` in it, provably: the probe only looks at
// the directories of this PATH string.
function emptyPath() {
  return tempDir('cg-empty-bin-');
}

function binDirWithCodegraph() {
  const dir = tempDir('cg-bin-');
  fs.writeFileSync(path.join(dir, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

function makeCtx(cwd) {
  const notifications = [];
  return { notifications, ctx: { cwd, ui: { notify: (text, level) => { notifications.push([level, text]); } } } };
}

const FORCED_ENV = { PATH: '', CODEGRAPH_FORCE: '1' };

function indexedRoot() {
  const root = tempDir('cg-session-root-');
  fs.mkdirSync(path.join(root, '.codegraph'));
  return root;
}

// One scheduler decision needs a git seam and a spawn seam; the spawn double
// closes immediately so `whenIdle()` settles without sleeping.
function schedulerDeps(root, overrides = {}) {
  const spawns = [];
  const deps = {
    env: FORCED_ENV,
    execFile: (bin, args) => {
      assert.equal(bin, 'git');
      assert.deepEqual(args, ['-C', path.join(root, 'src'), 'rev-parse', '--show-toplevel']);
      return `${root}\n`;
    },
    debounceMs: 5,
    spawn: (bin, args, opts) => {
      spawns.push({ bin, args, opts });
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('close'));
      return child;
    },
    ...overrides,
  };
  return { deps, spawns };
}

// --- registration gate --------------------------------------------------

describe('registration gate (S9)', () => {
  test('no codegraph command is registered when the gate answers false', async () => {
    process.env.PATH = emptyPath();
    delete process.env.CODEGRAPH_FORCE;
    session.resetCodegraphGate();
    const { commands: registered } = await loadExtension({});
    assert.deepEqual([...registered.keys()].sort(), ['issues', 'odd-list', 'warp']);
  });

  test('all three commands are registered once the gate answers true', async () => {
    process.env.PATH = `${binDirWithCodegraph()}${path.delimiter}${emptyPath()}`;
    delete process.env.CODEGRAPH_FORCE;
    session.resetCodegraphGate();
    const { commands: registered } = await loadExtension({});
    assert.deepEqual([...registered.keys()].sort(), [
      'codegraph-hook', 'codegraph-init', 'codegraph-sync', 'issues', 'odd-list', 'warp',
    ]);
    for (const name of ['codegraph-hook', 'codegraph-init', 'codegraph-sync']) {
      const definition = registered.get(name);
      assert.equal(typeof definition.handler, 'function', `${name} has a handler`);
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.description.length > 0, `${name} describes itself`);
    }
  });

  test('CODEGRAPH_FORCE=1 exposes the triple without a CLI probe', async () => {
    process.env.PATH = emptyPath();
    process.env.CODEGRAPH_FORCE = '1';
    session.resetCodegraphGate();
    const { commands: registered } = await loadExtension({});
    assert.equal(registered.has('codegraph-hook'), true);
    assert.equal(registered.has('codegraph-init'), true);
    assert.equal(registered.has('codegraph-sync'), true);
  });

  test('the registered hook handler reports the state through the session UI', async () => {
    process.env.PATH = `${binDirWithCodegraph()}${path.delimiter}${emptyPath()}`;
    delete process.env.CODEGRAPH_FORCE;
    session.resetCodegraphGate();
    const { commands: registered } = await loadExtension({});
    const { notifications, ctx } = makeCtx(tempDir('cg-session-cwd-'));
    await registered.get('codegraph-hook').handler('off', ctx);
    await registered.get('codegraph-hook').handler(undefined, ctx);
    await registered.get('codegraph-hook').handler('status', ctx);
    assert.deepEqual(notifications, [
      ['info', 'codegraph hook: disabled'],
      ['info', 'codegraph hook: enabled'],
      ['info', 'codegraph hook: enabled'],
    ]);
  });
});

// --- /codegraph-hook ----------------------------------------------------

describe('/codegraph-hook (S9)', () => {
  test('the hook starts enabled', () => {
    assert.equal(session.isHookEnabled(), true);
    assert.deepEqual(commands.codegraphHook('status'), { ok: true, level: 'info', text: 'codegraph hook: enabled' });
  });

  test('no argument toggles and status only reports', () => {
    assert.equal(commands.codegraphHook('').text, 'codegraph hook: disabled');
    assert.equal(commands.codegraphHook('status').text, 'codegraph hook: disabled');
    assert.equal(session.isHookEnabled(), false);
    assert.equal(commands.codegraphHook(undefined).text, 'codegraph hook: enabled');
    assert.equal(commands.codegraphHook('status').text, 'codegraph hook: enabled');
    assert.equal(session.isHookEnabled(), true);
  });

  test('on and off set the state explicitly', () => {
    assert.deepEqual(commands.codegraphHook('on'), { ok: true, level: 'info', text: 'codegraph hook: enabled' });
    assert.equal(session.isHookEnabled(), true);
    assert.deepEqual(commands.codegraphHook('off'), { ok: true, level: 'info', text: 'codegraph hook: disabled' });
    assert.equal(session.isHookEnabled(), false);
    assert.deepEqual(commands.codegraphHook('off'), { ok: true, level: 'info', text: 'codegraph hook: disabled' });
    assert.equal(session.isHookEnabled(), false);
  });

  test('an unknown option is refused and changes nothing', () => {
    assert.equal(session.isHookEnabled(), true);
    assert.deepEqual(commands.codegraphHook('maybe'), {
      ok: false,
      level: 'error',
      text: 'codegraph hook: unknown option "maybe". Use on, off or status.',
    });
    assert.equal(session.isHookEnabled(), true);
  });

  test('a disabled hook stops scheduling and does not touch the lock', async () => {
    const root = indexedRoot();
    const { deps, spawns } = schedulerDeps(root);
    commands.codegraphHook('off');
    const decision = session.scheduleSync(path.join(root, 'src', 'a.js'), deps);
    assert.deepEqual(decision, { scheduled: false, reason: 'hook-off' });
    await session.whenIdle();
    assert.equal(spawns.length, 0, 'nothing is spawned while the hook is off');
    assert.equal(fs.existsSync(path.join(root, '.codegraph', 'pi-sync.lock')), false, 'the lock is never taken');
  });

  test('turning the hook back on resumes the sync', async () => {
    const root = indexedRoot();
    const first = schedulerDeps(root);
    commands.codegraphHook('off');
    assert.equal(session.scheduleSync(path.join(root, 'src', 'a.js'), first.deps).reason, 'hook-off');
    await session.whenIdle();
    assert.equal(first.spawns.length, 0);
    commands.codegraphHook('on');
    assert.equal(session.scheduleSync(path.join(root, 'src', 'b.js'), first.deps).scheduled, true);
    await session.whenIdle();
    assert.equal(first.spawns.length, 1);
    assert.equal(first.spawns[0].bin, 'codegraph');
    assert.deepEqual(first.spawns[0].args, ['sync', root]);
  });

  test('CODEGRAPH_HOOK=0 starts the session with the hook already off', async () => {
    process.env.CODEGRAPH_HOOK = '0';
    session.resetCodegraphSession();
    assert.equal(session.isHookEnabled(), false);
    assert.equal(commands.codegraphHook('status').text, 'codegraph hook: disabled');
    const root = indexedRoot();
    const { deps, spawns } = schedulerDeps(root, { env: { ...FORCED_ENV, CODEGRAPH_HOOK: '0' } });
    assert.deepEqual(session.scheduleSync(path.join(root, 'src', 'a.js'), deps), { scheduled: false, reason: 'hook-off' });
    await session.whenIdle();
    assert.equal(spawns.length, 0);
    // `on` is explicit and still wins over the environment.
    commands.codegraphHook('on');
    assert.equal(session.scheduleSync(path.join(root, 'src', 'b.js'), deps).scheduled, true);
    await session.whenIdle();
    assert.equal(spawns.length, 1);
  });
});

// --- /codegraph-init and /codegraph-sync --------------------------------

const OK = { status: 0, stdout: 'indexed\n', stderr: '', error: null };
// Real captures (glyphs included, ANSI stripped). The lines the summarizer reads
// are the plain-text ones; the box glyphs are decoration and never matched.
const CAPTURES = {
  initFresh: (dir) => ({ status: 0, error: null, stderr: '', stdout: [
    '┌  Initializing CodeGraph', '│', `◇  Initialized in ${dir}`, '│',
    'Scanning files...', 'Parsing code...', 'Resolving refs...', '│',
    '◇  Indexed 1 files', '│', '◇  3 nodes, 3 edges in 141ms', '│', '└  Done', '',
  ].join('\n') }),
  initAgain: (dir) => ({ status: 0, error: null, stderr: '', stdout: [
    '┌  Initializing CodeGraph', '│', `▲  Already initialized in ${dir}`, '│',
    '●  Use "codegraph index" to re-index or "codegraph sync" to update', '│', '└  ', '',
  ].join('\n') }),
  syncUpToDate: { status: 0, error: null, stderr: '', stdout: [
    '┌  Syncing CodeGraph', '│', 'Scanning files...', '│', '●  Already up to date', '│', '└  Done', '',
  ].join('\n') },
  syncChanged: { status: 0, error: null, stderr: '', stdout: [
    '┌  Syncing CodeGraph', '│', 'Scanning files...', '◆  Synced 1 changed files', '│',
    '●  Modified: 1 — 4 nodes in 31ms', '│', '└  Done', '',
  ].join('\n') },
  syncNoIndex: (dir) => ({ status: 1, error: null, stdout: '', stderr: `✗  CodeGraph not initialized in ${dir}\n` }),
};

describe('init and sync report what happened, not just the exit code (S9)', () => {
  const runOf = (capture) => ({ run: async () => (typeof capture === 'function' ? capture() : capture) });

  test('a fresh init names the checkout, the files and the graph it built', async () => {
    const cwd = tempDir('cg-report-init-');
    const out = await commands.codegraphInit('', { cwd }, runOf(CAPTURES.initFresh(cwd)));
    assert.deepEqual(out, { ok: true, level: 'info', text: `codegraph init: initialized ${cwd} — 1 file, 3 nodes, 3 edges` });
  });

  test('an init over an existing index says so and points at sync', async () => {
    const cwd = tempDir('cg-report-init2-');
    const out = await commands.codegraphInit('', { cwd }, runOf(CAPTURES.initAgain(cwd)));
    assert.deepEqual(out, { ok: true, level: 'info', text: `codegraph init: already initialized at ${cwd} — nothing to do, use /codegraph-sync to update` });
  });

  test('a sync with nothing to do says exactly that', async () => {
    const cwd = tempDir('cg-report-sync0-');
    const out = await commands.codegraphSync('', { cwd }, runOf(CAPTURES.syncUpToDate));
    assert.deepEqual(out, { ok: true, level: 'info', text: 'codegraph sync: already up to date — nothing to sync' });
  });

  test('a sync that changed files names the count and the nodes', async () => {
    const cwd = tempDir('cg-report-sync1-');
    const out = await commands.codegraphSync('', { cwd }, runOf(CAPTURES.syncChanged));
    assert.deepEqual(out, { ok: true, level: 'info', text: 'codegraph sync: synced 1 changed file — 4 nodes' });
  });

  test('a sync with no index is a failure that names the fix', async () => {
    const cwd = tempDir('cg-report-sync2-');
    const out = await commands.codegraphSync('', { cwd }, runOf(CAPTURES.syncNoIndex(cwd)));
    assert.deepEqual(out, { ok: false, level: 'error', text: 'codegraph sync: no index in this checkout — run /codegraph-init first' });
  });

  test('successful output the summarizer does not recognise still reports success', async () => {
    const cwd = tempDir('cg-report-unknown-');
    const out = await commands.codegraphSync('', { cwd }, runOf({ status: 0, stdout: 'something new\n', stderr: '', error: null }));
    assert.deepEqual(out, { ok: true, level: 'info', text: 'codegraph sync: done' });
  });
});

describe('/codegraph-init and /codegraph-sync (S9)', () => {
  test('init runs `codegraph init .` in the session directory', async () => {
    const cwd = tempDir('cg-init-cwd-');
    const calls = [];
    const out = await commands.codegraphInit('', { cwd }, {
      run: async (bin, args, runCwd) => { calls.push([bin, args, runCwd]); return OK; },
    });
    assert.deepEqual(calls, [['codegraph', ['init', '.'], cwd]]);
    assert.deepEqual(out, { ok: true, level: 'info', text: 'codegraph init: done' });
  });

  test('sync runs `codegraph sync .` in the session directory', async () => {
    const cwd = tempDir('cg-sync-cwd-');
    const calls = [];
    const out = await commands.codegraphSync('', { cwd }, {
      run: async (bin, args, runCwd) => { calls.push([bin, args, runCwd]); return OK; },
    });
    assert.deepEqual(calls, [['codegraph', ['sync', '.'], cwd]]);
    assert.deepEqual(out, { ok: true, level: 'info', text: 'codegraph sync: done' });
  });

  test('the run happens in the process directory when the session has none', async () => {
    const calls = [];
    await commands.codegraphInit('', {}, {
      run: async (bin, args, runCwd) => { calls.push([bin, args, runCwd]); return OK; },
    });
    assert.deepEqual(calls, [['codegraph', ['init', '.'], process.cwd()]]);
  });

  test('a non-zero exit is reported as a failure, never as success', async () => {
    const cwd = tempDir('cg-fail-cwd-');
    const out = await commands.codegraphInit('', { cwd }, {
      run: async () => ({ status: 1, stdout: '', stderr: 'CodeGraph: cannot write index\nat line 2\n', error: null }),
    });
    assert.deepEqual(out, {
      ok: false,
      level: 'error',
      text: 'codegraph init: exit 1 — CodeGraph: cannot write index',
    });
  });

  test('a failed sync reports its own exit status and stderr line', async () => {
    const cwd = tempDir('cg-fail-sync-cwd-');
    const out = await commands.codegraphSync('', { cwd }, {
      run: async () => ({ status: 2, stdout: '', stderr: 'CodeGraph not initialized\n', error: null }),
    });
    assert.deepEqual(out, {
      ok: false,
      level: 'error',
      text: 'codegraph sync: exit 2 — CodeGraph not initialized',
    });
  });

  test('a child that could not be started is reported, not thrown', async () => {
    const cwd = tempDir('cg-nospawn-cwd-');
    const out = await commands.codegraphInit('', { cwd }, {
      run: async () => ({ status: null, stdout: '', stderr: '', error: 'spawn codegraph ENOENT' }),
    });
    assert.deepEqual(out, {
      ok: false,
      level: 'error',
      text: 'codegraph init: failed — spawn codegraph ENOENT',
    });
  });

  test('a thrown child error is reported, not thrown', async () => {
    const cwd = tempDir('cg-throw-cwd-');
    const out = await commands.codegraphSync('', { cwd }, {
      run: async () => { throw new Error('boom'); },
    });
    assert.deepEqual(out, { ok: false, level: 'error', text: 'codegraph sync: failed — boom' });
  });
});

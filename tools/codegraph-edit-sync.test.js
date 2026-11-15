'use strict';
// S9: a successful edit or write asks for one background sync of the edited file's checkout, debounced, never while a daemon
// watches that checkout, never in a read-only role, never without the CLI or an index. Timers, git and the sync are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEditSync } = require('../lib/codegraph-edit-sync.js');

function harness(overrides = {}) {
  const timers = [];
  const calls = { sync: [], toplevel: [] };
  const deps = {
    cwd: '/work/repo',
    available: () => true,
    role: undefined,
    toplevel: async (dir) => {
      calls.toplevel.push(dir);
      return dir.startsWith('/work/repo/wt') ? '/work/repo/wt' : '/work/repo';
    },
    hasIndex: () => true,
    daemonLive: () => false,
    sync: async (root) => {
      calls.sync.push(root);
      return { status: 'synced' };
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    ...overrides,
  };
  const editSync = createEditSync(deps);
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) await timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { editSync, calls, timers, fire };
}

const edit = (file, toolName = 'edit', extra = {}) => ({ toolName, input: { path: file }, isError: false, ...extra });

test('one edit asks for one sync of its checkout after the debounce window', async () => {
  const { editSync, calls, timers, fire } = harness();
  await editSync.onToolResult(edit('/work/repo/src/a.js'));
  assert.deepEqual(calls.sync, [], 'nothing runs before the window ends');
  assert.equal(timers.length, 1);
  await fire();
  assert.deepEqual(calls.sync, ['/work/repo']);
});

test('quick edits of one checkout collapse into one sync, and a relative path resolves against the session cwd', async () => {
  const { editSync, calls, fire } = harness();
  await editSync.onToolResult(edit('src/a.js'));
  await editSync.onToolResult(edit('src/b.js', 'write'));
  await editSync.onToolResult(edit('/work/repo/src/c.js'));
  await fire();
  assert.deepEqual(calls.sync, ['/work/repo']);
});

test('the checkout of the edited file is the target: a worktree syncs that worktree, and each root has its own window', async () => {
  const { editSync, calls, fire } = harness();
  await editSync.onToolResult(edit('/work/repo/src/a.js'));
  await editSync.onToolResult(edit('/work/repo/wt/src/b.js'));
  await fire();
  assert.deepEqual(calls.sync.sort(), ['/work/repo', '/work/repo/wt']);
});

test('the git toplevel is read once per directory', async () => {
  const { editSync, calls } = harness();
  await editSync.onToolResult(edit('/work/repo/src/a.js'));
  await editSync.onToolResult(edit('/work/repo/src/b.js'));
  assert.deepEqual(calls.toplevel, [path.dirname('/work/repo/src/a.js')]);
});

test('a failed edit, another tool, or an event with no path asks for nothing', async () => {
  const { editSync, timers } = harness();
  await editSync.onToolResult(edit('/work/repo/a.js', 'edit', { isError: true }));
  await editSync.onToolResult(edit('/work/repo/a.js', 'bash'));
  await editSync.onToolResult({ toolName: 'edit', input: {}, isError: false });
  await editSync.onToolResult(undefined);
  assert.equal(timers.length, 0);
});

test('no index, a live daemon, a read-only role, a missing CLI or no git checkout each skip silently', async () => {
  for (const override of [
    { hasIndex: () => false },
    { daemonLive: () => true },
    { role: 'read-only' },
    { available: () => false },
    { toplevel: async () => undefined },
  ]) {
    const { editSync, timers } = harness(override);
    await editSync.onToolResult(edit('/work/repo/a.js'));
    assert.equal(timers.length, 0, JSON.stringify(Object.keys(override)));
  }
});

test('an edit during a running sync asks for exactly one more when it ends', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  const { editSync, fire } = harness({
    sync: async (root) => {
      started.push(root);
      if (started.length === 1) await gate;
      return { status: 'synced' };
    },
  });
  await editSync.onToolResult(edit('/work/repo/a.js'));
  const firing = fire();
  await new Promise((resolve) => setImmediate(resolve));
  await editSync.onToolResult(edit('/work/repo/b.js'));
  await editSync.onToolResult(edit('/work/repo/c.js'));
  await fire();
  assert.equal(started.length, 1, 'no second sync starts while the first runs');
  release();
  await firing;
  await fire();
  await fire();
  assert.equal(started.length, 2, 'exactly one follow-up');
});

test('a throwing git, index check or sync never reaches the caller', async () => {
  for (const override of [
    { toplevel: async () => { throw new Error('git'); } },
    { hasIndex: () => { throw new Error('fs'); } },
    { sync: async () => { throw new Error('sync'); } },
  ]) {
    const { editSync, fire } = harness(override);
    await assert.doesNotReject(async () => {
      await editSync.onToolResult(edit('/work/repo/a.js'));
      await fire();
    });
  }
});

test('dispose clears every pending window', async () => {
  const { editSync, timers } = harness();
  await editSync.onToolResult(edit('/work/repo/a.js'));
  await editSync.onToolResult(edit('/work/repo/wt/b.js'));
  editSync.dispose();
  assert.ok(timers.every((timer) => timer.cleared));
});

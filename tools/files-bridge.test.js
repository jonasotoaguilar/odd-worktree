'use strict';
// T15 (S36, S28): the file picker's key is bound directly on the host, and
// gentle-shell-bridge contributes nothing for it. The installed host has no
// reader of the bridge's plugin surface, so a `files` row in Keymaps or in the
// palette could never be listed: the package registers neither.
//
// What this file proves, all of it through the loaded extension:
// - `alt+f` is bound with `pi.registerShortcut` at load, with no bridge present;
// - `GENTLE_PI_FILES_KEY` overrides that key, and an empty (or blank) override
//   falls back to `alt+f`;
// - the bound handler is the SAME path `/files` opens, with the session context
//   the host hands a shortcut;
// - with a complete bridge published, this package still registers NO keymap and
//   NO palette row for `files` and never asks the shell to resolve a key, while
//   the shortcut is still bound;
// - a late bridge announcement and a `session_start` never add those rows and
//   never bind a second key;
// - a host without `registerShortcut`, a host that throws from it, and a missing
//   command handler never break the extension and say nothing.
//
// The bridge slot is process-wide, so it is restored after every test, and the
// environment this file touches is snapshotted and restored in `after`.

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadExtension } = require('./fixtures/load-extension.js');

const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const READY_EVENT = 'gentle-shell-bridge:ready';
// The one line `/files` answers a host with no overlay: the proof that the bound
// key reached the command's own path.
const NO_UI_LINE = 'files: the file picker needs an interactive session with overlay support';

const savedEnv = { ...process.env };
const scratch = [];
after(() => {
  delete globalThis[BRIDGE_SLOT];
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

afterEach(() => {
  delete globalThis[BRIDGE_SLOT];
  delete process.env.GENTLE_PI_FILES_KEY;
});

// A fake bridge on the real slot, complete enough for every surface this package
// could possibly contribute to: it records each registration and each
// resolution, so a `files` row — or even a question about one — is visible.
function installBridge() {
  const keymaps = [];
  const commands = [];
  const resolved = [];
  const api = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerKeymap: (registration) => {
      keymaps.push(registration);
      return () => {};
    },
    registerCommands: (registration) => {
      commands.push(registration);
      return () => {};
    },
    resolveKeymap: (id) => {
      resolved.push(id);
      return { key: 'alt+p' };
    },
  };
  globalThis[BRIDGE_SLOT] = api;
  return { api, keymaps, commands, resolved };
}

// A fake host whose ONE added seam is the shortcut registration the package makes
// itself. `loadExtension` merges it over its own double, so every other
// registration is the loader's real one.
function installHost() {
  const shortcuts = [];
  const pi = {
    registerShortcut: (key, options) => {
      shortcuts.push({ key, options });
    },
  };
  return { pi, shortcuts };
}

function sessionStartHandlers(hooks) {
  return hooks.filter(([event]) => event === 'session_start').map(([, handler]) => handler);
}

async function fireSessionStart(hooks, ctx) {
  for (const handler of sessionStartHandlers(hooks)) {
    const out = handler({}, ctx);
    if (out && typeof out.then === 'function') await out;
  }
}

// `session_start` also runs the `/issues` gate, so no test may reach a real `gh`:
// the fake runner fails fast and the gate closes without a child process.
async function stubGh() {
  const { LIB_DIR } = require('./fixtures/load-extension.js');
  const ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  ghIssues.setGhRunner(async () => ({ status: 1, stdout: '', stderr: 'no gh here', error: null }));
  ghIssues.setGitRunner(async () => ({ status: 1, stdout: '', stderr: 'no git here', error: null }));
}

function notifyHost() {
  const notifications = [];
  return {
    notifications,
    ctx: {
      cwd: practiceCheckout(),
      ui: { notify: (text, level) => notifications.push([level, text]) },
    },
  };
}

// A plain directory with no repository in it: the picker answers early and the
// key's only observable effect is the line it reaches.
function practiceCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-files-bridge-'));
  scratch.push(dir);
  return fs.realpathSync(dir);
}

// The `files` rows a fake bridge was handed, if any: the whole claim S36 removes.
function filesRows(rows) {
  return rows.filter((row) => row && row.id === 'files');
}

// ---------------------------------------------------------------------------
// S36/S28: the key is bound directly, no bridge involved.
// ---------------------------------------------------------------------------

test('S36/S28: the shortcut binds alt+f at load with no bridge present, and /files still registers', async () => {
  delete globalThis[BRIDGE_SLOT];
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1, 'one key is bound');
  assert.equal(host.shortcuts[0].key, 'alt+f', 'the default key is alt+f (S28)');
  assert.equal(typeof host.shortcuts[0].options.handler, 'function');
  assert.equal(typeof host.shortcuts[0].options.description, 'string');
  assert.equal(loaded.commands.has('files'), true, '/files is still registered under its own name');
  assert.equal(globalThis[BRIDGE_SLOT], undefined, 'this package publishes no bridge');
});

test('S36/S28: GENTLE_PI_FILES_KEY overrides the bound key', async () => {
  delete globalThis[BRIDGE_SLOT];
  process.env.GENTLE_PI_FILES_KEY = 'ctrl+shift+f';
  const host = installHost();
  await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1);
  assert.equal(host.shortcuts[0].key, 'ctrl+shift+f', 'the environment variable wins over the default');
});

test('S36/S28: an empty or blank override falls back to alt+f', async () => {
  delete globalThis[BRIDGE_SLOT];
  for (const value of ['', '   ']) {
    process.env.GENTLE_PI_FILES_KEY = value;
    const host = installHost();
    await loadExtension(host.pi);
    assert.equal(host.shortcuts.length, 1, `one key is bound for the override ${JSON.stringify(value)}`);
    assert.equal(host.shortcuts[0].key, 'alt+f', `an empty override is not a key: ${JSON.stringify(value)}`);
  }
});

test('S36: the bound key runs the SAME path /files opens, with the session context', async () => {
  delete globalThis[BRIDGE_SLOT];
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]],
    'the bound key reaches the command handler with the context the host handed it');

  const direct = notifyHost();
  await loaded.commands.get('files').handler('', direct.ctx);
  assert.deepEqual(direct.notifications, [['info', NO_UI_LINE]], 'and the command answers the same way');
});

// ---------------------------------------------------------------------------
// S36: a bridge present and complete still gets NO files row, and no resolve.
// ---------------------------------------------------------------------------

test('S36: a complete bridge receives no keymap row and no palette row for files', async () => {
  const bridge = installBridge();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.deepEqual(filesRows(bridge.keymaps), [], 'no registerKeymap call carries the id files');
  assert.deepEqual(filesRows(bridge.commands), [], 'no registerCommands call carries the id files');
  assert.deepEqual(bridge.keymaps, [], 'and this package contributes no keymap action at all');
  assert.deepEqual(bridge.commands, [], 'nor any palette row');
  assert.deepEqual(bridge.resolved, [], 'the shell is never asked to resolve a key');
  assert.equal(host.shortcuts.length, 1, 'the shortcut is still bound');
  assert.equal(host.shortcuts[0].key, 'alt+f');
  assert.equal(loaded.commands.has('files'), true);
});

test('S36: a late bridge announcement and a session_start add no files row and no second key', async () => {
  await stubGh();
  delete globalThis[BRIDGE_SLOT];
  const subscriptions = [];
  const host = installHost();
  const loaded = await loadExtension({
    ...host.pi,
    events: {
      on: (event, handler) => {
        subscriptions.push({ event, handler });
        return () => {};
      },
    },
  });

  assert.equal(host.shortcuts.length, 1, 'the key is bound once, at load, with no bridge to wait for');
  const ready = subscriptions.filter((entry) => entry.event === READY_EVENT);
  assert.equal(subscriptions.every((entry) => entry.event === READY_EVENT), true, 'and nothing else is listened to');

  // The bridge publishes and announces.
  const bridge = installBridge();
  for (const entry of ready) entry.handler();
  assert.deepEqual(filesRows(bridge.keymaps), [], 'the late bridge is handed no keymap row');
  assert.deepEqual(filesRows(bridge.commands), [], 'nor a palette row');
  assert.deepEqual(bridge.resolved, [], 'and is never asked for a key');
  assert.equal(host.shortcuts.length, 1, 'the announcement binds no second key');

  const ctx = notifyHost().ctx;
  await fireSessionStart(loaded.hooks, ctx);
  await fireSessionStart(loaded.hooks, ctx);
  assert.deepEqual(filesRows(bridge.keymaps), [], 'a session start contributes nothing either');
  assert.deepEqual(filesRows(bridge.commands), []);
  assert.equal(host.shortcuts.length, 1, 'and never stacks a second shortcut');

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]], 'the one key still reaches the picker path');
});

test('S36: a malformed bridge never affects the bound key', async () => {
  const wrongSchema = installBridge();
  wrongSchema.api.schema = 'gentle-shell-bridge/api/v2';
  const host = installHost();
  await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1, 'the key does not depend on the bridge gate');
  assert.equal(host.shortcuts[0].key, 'alt+f');
  assert.deepEqual(wrongSchema.keymaps, [], 'a foreign schema is handed nothing');
  assert.deepEqual(wrongSchema.commands, []);
  assert.deepEqual(wrongSchema.resolved, []);
});

// ---------------------------------------------------------------------------
// A host that cannot take the key never breaks the extension.
// ---------------------------------------------------------------------------

test('S36: a host with no registerShortcut at all still gets /files and never throws', async () => {
  delete globalThis[BRIDGE_SLOT];
  const loaded = await loadExtension({});
  assert.equal(loaded.commands.has('files'), true, 'the command is the whole surface without a key');
  assert.equal(loaded.tools.has('worktree_list'), true, 'no other surface changes');

  const sink = notifyHost();
  await loaded.commands.get('files').handler('', sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]]);
});

test('S36: a host that refuses the shortcut says nothing and keeps the command', async () => {
  delete globalThis[BRIDGE_SLOT];
  installBridge();
  const loaded = await loadExtension({
    registerShortcut: () => { throw new Error('the host refuses the key'); },
  });
  assert.equal(loaded.commands.has('files'), true, 'the command is unaffected');
  const sink = notifyHost();
  await loaded.commands.get('files').handler('', sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]]);
});

test('S36: a missing command handler makes the bound key inert, never a throw', async () => {
  delete globalThis[BRIDGE_SLOT];
  const host = installHost();
  await loadExtension({
    ...host.pi,
    registerCommand: undefined,
  });

  assert.equal(host.shortcuts.length, 1, 'the key is still bound');
  // A host that took no command has no handler for the key to reach; the call
  // must simply do nothing.
  await host.shortcuts[0].options.handler(notifyHost().ctx);
  assert.equal(typeof host.shortcuts[0].options.handler, 'function');
});

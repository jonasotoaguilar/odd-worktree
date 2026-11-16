'use strict';
// T8 (S18, S19): the file picker's place in Gentle Shell, contributed through
// gentle-shell-bridge ONLY — a symbol slot, its schema/version gate and its two
// optional members, never an import and never a dependency.
//
// What this file proves, all of it through the loaded extension:
// - the exact keymap action (`files`, `File picker`, `GENTLE_PI_FILES_KEY`,
//   `alt+p`, command `files`) and the exact palette row (same id and label,
//   command `files`, section `Session`, the host's own title);
// - the key comes from `resolveKeymap`'s answer and is bound with the host's
//   `registerShortcut`, whose handler reaches the SAME `/files` path the command
//   uses; `{ unavailable }` binds nothing and says nothing;
// - no bridge at all: nothing registered, nothing bound, never a throw, and
//   `/files` still works from the command;
// - a bridge that publishes LATER lands both registrations from the one ready
//   announcement;
// - a second registration never stacks a second shortcut;
// - a bridge whose members throw never breaks the extension.
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
});

// A fake bridge on the real slot: it records every registration and answers one
// resolution, exactly the shape the contract publishes (`{ key }` or
// `{ unavailable }`). `members` overrides any member to model a throwing or
// partial bridge.
function installBridge({ key = 'alt+p', members = {} } = {}) {
  const keymaps = [];
  const commands = [];
  const resolved = [];
  const released = [];
  const api = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerKeymap: (registration) => {
      keymaps.push(registration);
      return () => { released.push(`keymap:${registration.id}`); };
    },
    registerCommands: (registration) => {
      commands.push(registration);
      return () => { released.push(`commands:${registration.id}`); };
    },
    resolveKeymap: (id) => {
      resolved.push(id);
      return key === null ? { unavailable: 'the installed gentle-shell publishes no keymap resolver' } : { key };
    },
    ...members,
  };
  globalThis[BRIDGE_SLOT] = api;
  return { api, keymaps, commands, resolved, released };
}

// A fake host whose ONE added seam is the shortcut registration the bridge
// contract asks the plugin to make itself. `loadExtension` merges it over its own
// double, so every other registration is the loader's real one.
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

// ---------------------------------------------------------------------------
// S18/S19: both contributions, exactly as the bridge contract states them.
// ---------------------------------------------------------------------------

test('S18/S19: a published bridge receives the keymap action and the Session palette row', async () => {
  const bridge = installBridge();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.deepEqual(bridge.keymaps, [{
    id: 'files',
    label: 'File picker',
    env: 'GENTLE_PI_FILES_KEY',
    defaultKey: 'alt+p',
    command: 'files',
  }], 'the keymap action is the spec\'s, field for field');

  assert.deepEqual(bridge.commands, [{
    id: 'files',
    label: 'File picker',
    command: 'files',
    section: 'Session',
  }], 'the palette row joins the host\'s own Session section');

  assert.deepEqual(bridge.resolved, ['files'], 'the action\'s key is asked for by its id');
  assert.equal(host.shortcuts.length, 1, 'one key is bound');
  assert.equal(host.shortcuts[0].key, 'alt+p', 'the default resolves to a bound key');
  assert.equal(typeof host.shortcuts[0].options.handler, 'function');
  assert.equal(typeof host.shortcuts[0].options.description, 'string');
  assert.equal(loaded.commands.has('files'), true, '/files is still registered under its own name');
});

test('S18: the effective key is the shell\'s answer, not the default, and its handler is the /files path', async () => {
  const bridge = installBridge({ key: 'ctrl+shift+f' });
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1);
  assert.equal(host.shortcuts[0].key, 'ctrl+shift+f', 'the resolved key wins over the declared default');
  assert.equal(bridge.keymaps[0].defaultKey, 'alt+p', 'the declared default is untouched');
  assert.deepEqual(bridge.resolved, ['files']);

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]],
    'the bound key runs the SAME handler `/files` registered, argument and all');

  // The command itself is untouched by the bridge: same answer, same path.
  const direct = notifyHost();
  await loaded.commands.get('files').handler('', direct.ctx);
  assert.deepEqual(direct.notifications, [['info', NO_UI_LINE]]);
});

test('S18: `{ unavailable }` binds nothing and says nothing', async () => {
  const bridge = installBridge({ key: null });
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 0, 'an unavailable key binds nothing');
  assert.deepEqual(bridge.resolved, ['files'], 'the shell was still asked');
  assert.equal(bridge.keymaps.length, 1, 'the action is still listed in Customize → Keymaps');
  assert.equal(bridge.commands.length, 1, 'the palette row is still contributed');
  assert.equal(loaded.commands.has('files'), true, '/files keeps working with no key at all');

  // The same silence after the bridge is announced later.
  await stubGh();
  await fireSessionStart(loaded.hooks, notifyHost().ctx);
  assert.equal(host.shortcuts.length, 0, 'a second moment never binds an unavailable key');
});

// ---------------------------------------------------------------------------
// No bridge: nothing happens at all.
// ---------------------------------------------------------------------------

test('S18/S19: with no bridge, nothing is registered, nothing is bound and nothing throws', async () => {
  delete globalThis[BRIDGE_SLOT];
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 0);
  assert.equal(loaded.commands.has('files'), true, 'the command is the whole surface without a bridge');
  assert.equal(loaded.tools.has('worktree_create'), true, 'no other surface changes');
  assert.equal(loaded.tools.has('worktree_list'), true);
  assert.equal(globalThis[BRIDGE_SLOT], undefined, 'nothing is published by this package');

  await stubGh();
  await fireSessionStart(loaded.hooks, notifyHost().ctx);
  assert.equal(host.shortcuts.length, 0, 'a session start without a bridge binds nothing');
});

test('S18/S19: a malformed bridge, or one missing the members this feature uses, is not usable', async () => {
  const wrongSchema = installBridge();
  wrongSchema.api.schema = 'gentle-shell-bridge/api/v2';
  const schemaHost = installHost();
  await loadExtension(schemaHost.pi);
  assert.deepEqual(wrongSchema.keymaps, [], 'a foreign schema registers nothing');
  assert.deepEqual(wrongSchema.commands, []);
  assert.equal(schemaHost.shortcuts.length, 0);

  delete globalThis[BRIDGE_SLOT];
  const wrongVersion = installBridge();
  wrongVersion.api.version = 2;
  const versionHost = installHost();
  await loadExtension(versionHost.pi);
  assert.deepEqual(wrongVersion.keymaps, []);
  assert.equal(versionHost.shortcuts.length, 0);

  delete globalThis[BRIDGE_SLOT];
  // The two members this surface uses are OPTIONAL on the bridge: a bridge
  // without them is a bridge this feature cannot use, so it contributes nothing.
  const partial = installBridge({ members: { registerKeymap: undefined, registerCommands: undefined } });
  const partialHost = installHost();
  await loadExtension(partialHost.pi);
  assert.equal(partialHost.shortcuts.length, 0);
  assert.deepEqual(partial.keymaps, [], 'a bridge missing both members contributes nothing');

  delete globalThis[BRIDGE_SLOT];
  const noKeymap = installBridge({ members: { registerKeymap: undefined } });
  const noKeymapHost = installHost();
  await loadExtension(noKeymapHost.pi);
  assert.equal(noKeymapHost.shortcuts.length, 0, 'no registerKeymap means no action and no key');
  assert.deepEqual(noKeymap.commands, [], 'and nothing half-registered');
});

// ---------------------------------------------------------------------------
// A bridge that publishes later, from the ONE ready announcement.
// ---------------------------------------------------------------------------

test('S18/S19: a bridge that publishes later lands both registrations from the ready event', async () => {
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

  assert.equal(subscriptions.length, 1, 'the package answers the announcement with ONE subscription');
  assert.equal(subscriptions[0].event, READY_EVENT);
  assert.equal(host.shortcuts.length, 0, 'nothing is bound while no bridge is published');
  assert.equal(loaded.commands.has('files'), true);

  // The bridge publishes and announces.
  const bridge = installBridge();
  subscriptions[0].handler();

  assert.deepEqual(bridge.keymaps, [{
    id: 'files',
    label: 'File picker',
    env: 'GENTLE_PI_FILES_KEY',
    defaultKey: 'alt+p',
    command: 'files',
  }], 'the late bridge lands the keymap action');
  assert.deepEqual(bridge.commands, [{
    id: 'files',
    label: 'File picker',
    command: 'files',
    section: 'Session',
  }], 'and the palette row');
  assert.deepEqual(bridge.resolved, ['files']);
  assert.equal(host.shortcuts.length, 1);
  assert.equal(host.shortcuts[0].key, 'alt+p', 'the key is bound from the late answer');

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]], 'the late key reaches the picker path');
});

// ---------------------------------------------------------------------------
// Idempotent: a second moment never stacks a second contribution or key.
// ---------------------------------------------------------------------------

test('S18/S19: a second registration never stacks a second shortcut and keeps one row each', async () => {
  await stubGh();
  const bridge = installBridge();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(bridge.keymaps.length, 1);
  assert.equal(bridge.commands.length, 1);
  assert.equal(host.shortcuts.length, 1);

  const ctx = notifyHost().ctx;
  await fireSessionStart(loaded.hooks, ctx);
  await fireSessionStart(loaded.hooks, ctx);

  assert.equal(bridge.keymaps.length, 1, 'the same bridge is never registered twice');
  assert.equal(bridge.commands.length, 1);
  assert.equal(host.shortcuts.length, 1, 'and the same key is never bound twice');
  assert.deepEqual(bridge.released, [], 'nothing was released for a no-op moment');

  // A REPUBLISHED bridge (a `/reload` of gentle-shell) replaces the contribution
  // in place: the previous disposers run first, and the same key is not rebound.
  const republished = installBridge();
  await fireSessionStart(loaded.hooks, ctx);
  assert.deepEqual(bridge.released, ['keymap:files', 'commands:files'],
    'the previous contribution is released before the replacement is made');
  assert.equal(republished.keymaps.length, 1);
  assert.equal(republished.commands.length, 1);
  assert.equal(host.shortcuts.length, 1, 'the same key is still bound exactly once');
});

// ---------------------------------------------------------------------------
// A broken bridge never breaks the extension.
// ---------------------------------------------------------------------------

test('S18/S19: a bridge whose members throw never breaks the extension', async () => {
  const boom = () => { throw new Error('bridge member exploded'); };
  const bridge = installBridge({
    members: {
      registerKeymap: boom,
      registerCommands: boom,
      resolveKeymap: boom,
    },
  });
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 0, 'a throwing resolver binds nothing');
  assert.equal(loaded.commands.has('files'), true, 'the command still registers');
  assert.equal(loaded.tools.has('worktree_list'), true, 'the other surfaces still register');

  await stubGh();
  await fireSessionStart(loaded.hooks, notifyHost().ctx);
  assert.equal(host.shortcuts.length, 0);
  assert.ok(bridge.keymaps.length === 0 && bridge.commands.length === 0,
    'a throwing bridge contributed nothing');
});

test('S18: a host that refuses the shortcut never breaks the extension', async () => {
  installBridge();
  const loaded = await loadExtension({
    registerShortcut: () => { throw new Error('the host refuses the key'); },
  });
  assert.equal(loaded.commands.has('files'), true, 'the command is unaffected');
  const sink = notifyHost();
  await loaded.commands.get('files').handler('', sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]]);
});

test('S18: a host with no registerShortcut at all still gets its contributions', async () => {
  const bridge = installBridge();
  const loaded = await loadExtension({});
  assert.equal(bridge.keymaps.length, 1);
  assert.equal(bridge.commands.length, 1);
  assert.equal(loaded.commands.has('files'), true);
});

// The `Session` section title is the host's own; nothing here invents a second
// spelling for it, so the value the test asserts is the value the catalog holds.
test('S19: the palette section is the host catalog\'s Session title, exactly', async () => {
  const bridge = installBridge();
  await loadExtension({});
  assert.equal(bridge.commands[0].section, 'Session');
  assert.ok(!bridge.commands[0].id.startsWith('command:'), 'the palette namespace is never reused as an id');
  assert.ok(!bridge.keymaps[0].id.startsWith('command:'), 'the bridge refuses a command: id');
});

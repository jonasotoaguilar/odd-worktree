'use strict';
// T19 (S36, S41) and T14 (S18) together: the picker's ONE key is bound directly
// on the host, and the package itself loads only when gentle-shell-bridge is
// published.
//
// What this file proves, all of it through the loaded extension:
// - `alt+p` is bound with `pi.registerShortcut` at load, and `/files` is
//   registered under its own name (S36/S41);
// - `GENTLE_PI_FILES_KEY` overrides that key, and an empty (or blank) override
//   falls back to `alt+p`;
// - the bound handler is the SAME path `/files` opens, with the session context
//   the host hands a shortcut;
// - a complete bridge is handed NO keymap and NO palette row for `files`, and is
//   never asked to resolve a key, while the shortcut is still bound (S36);
// - a late bridge announcement and a `session_start` never add those rows and
//   never bind a second key;
// - a host without `registerShortcut`, a host that throws from it, and a missing
//   command handler never break the extension and say nothing;
// - with NO bridge the package registers NOTHING — no command, no tool, no
//   renderer, no hook, no key — and only ONE notice names the install line (S18,
//   T14); a malformed bridge is the same silence, and the ONE ready announcement
//   is what brings the whole surface to life, exactly once.
//
// Where the two contracts meet (this is the merge of main's T15 with this
// branch's S18): the key is bound at load, but it is bound inside the package's
// single registration episode, so a host with no bridge gets no key because it
// gets no surface at all.
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
//
// S18 (T14): the gate this package loads behind validates the WHOLE published
// object (`schema`, `version`, `registerSection`, `registerRows`, `createStore`),
// so a fake that only carried the picker's two old members would be "no bridge"
// and this suite would test an extension that never loaded. The members no
// assertion here measures are therefore present but inert; `members` overrides
// any of them to model a throwing or partial bridge.
function installBridge({ members = {} } = {}) {
  const keymaps = [];
  const commands = [];
  const resolved = [];
  const api = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerSection: () => () => {},
    registerRows: () => () => {},
    registerToolDesign: () => () => {},
    createStore: () => ({}),
    requestRepaint: () => {},
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
    ...members,
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
// S36/S41: the key is bound directly, no bridge row involved.
// ---------------------------------------------------------------------------

test('S41: the shortcut binds alt+p at load with a complete bridge published, and /files still registers', async () => {
  const bridge = installBridge();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1, 'one key is bound');
  assert.equal(host.shortcuts[0].key, 'alt+p', 'the default key is alt+p (S41)');
  assert.equal(typeof host.shortcuts[0].options.handler, 'function');
  assert.equal(typeof host.shortcuts[0].options.description, 'string');
  assert.equal(loaded.commands.has('files'), true, '/files is still registered under its own name');
  assert.deepEqual(bridge.keymaps, [], 'this package contributes no keymap action at all');
  assert.deepEqual(bridge.commands, [], 'nor any palette row');
  assert.deepEqual(bridge.resolved, [], 'and the shell is never asked to resolve a key');
  assert.notEqual(globalThis[BRIDGE_SLOT], undefined, 'the bridge is the host\'s own published object');
});

test('S41: GENTLE_PI_FILES_KEY overrides the bound key', async () => {
  installBridge();
  process.env.GENTLE_PI_FILES_KEY = 'ctrl+shift+f';
  const host = installHost();
  await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1);
  assert.equal(host.shortcuts[0].key, 'ctrl+shift+f', 'the environment variable wins over the default');
});

test('S41: an empty or blank override falls back to alt+p', async () => {
  installBridge();
  for (const value of ['', '   ']) {
    process.env.GENTLE_PI_FILES_KEY = value;
    const host = installHost();
    await loadExtension(host.pi);
    assert.equal(host.shortcuts.length, 1, `one key is bound for the override ${JSON.stringify(value)}`);
    assert.equal(host.shortcuts[0].key, 'alt+p', `an empty override is not a key: ${JSON.stringify(value)}`);
  }
});

test('S36: the bound key runs the SAME path /files opens, with the session context', async () => {
  installBridge();
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
  assert.equal(host.shortcuts[0].key, 'alt+p');
  assert.equal(loaded.commands.has('files'), true);
});

// ---------------------------------------------------------------------------
// S18 (T14): no bridge, no package. The policy the human chose, verbatim:
// "Desactivar todo el plugin" — when gentle-shell-bridge is not published, this
// extension registers NOTHING: no command, no tool, no renderer, no card, no rail,
// no hook, no prompt append, and no key. The only thing that happens is ONE
// notice naming the install line, in a primary session.
// ---------------------------------------------------------------------------

// The harness may itself run inside an agent child (`GENTLE_PI_AGENTS_CHILD=1`),
// which is exactly the signal the notice's primary-session rule respects, so this
// test owns it: cleared here, restored after.
test('S18/S19 (T14): with no bridge NOTHING registers, and ONE notice names the install line', async () => {
  delete globalThis[BRIDGE_SLOT];
  const savedChild = process.env.GENTLE_PI_AGENTS_CHILD;
  delete process.env.GENTLE_PI_AGENTS_CHILD;
  try {
  const host = installHost();
  const loaded = await loadExtension(host.pi, { bridge: false });

  assert.equal(host.shortcuts.length, 0, 'nothing is bound');
  assert.deepEqual([...loaded.commands.keys()], [], 'no command');
  assert.deepEqual([...loaded.tools.keys()], [], 'no tool');
  assert.deepEqual([...loaded.messageRenderers.keys()], [], 'no message renderer');
  assert.deepEqual([...loaded.entryRenderers.keys()], [], 'no entry renderer');
  assert.deepEqual(loaded.hooks.map(([event]) => event), ['session_start'],
    'the ONE observer the missing-plugin notice needs (notify lives on the session), and nothing else');
  assert.equal(globalThis[BRIDGE_SLOT], undefined, 'nothing is published by this package');

  // The notice: the existing missing-plugin window, in a primary session.
  const sink = notifyHost();
  await fireSessionStart(loaded.hooks, sink.ctx);
  assert.deepEqual(sink.notifications, [[
    'warning',
    'the issues rail needs the gentle-shell-bridge plugin: install it with pi install npm:gentle-shell-bridge',
  ]], 'exactly one notice, naming npm:gentle-shell-bridge and its install line');

  // And the session did not load a surface either.
  assert.deepEqual([...loaded.commands.keys()], [], 'a session start without a bridge still registers no command');
  assert.deepEqual([...loaded.tools.keys()], [], 'and no tool');
  assert.equal(host.shortcuts.length, 0, 'and binds nothing');
  } finally {
    if (savedChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
    else process.env.GENTLE_PI_AGENTS_CHILD = savedChild;
  }
});

test('S18/S19: a malformed bridge is no bridge, and a bridge without the picker\'s old rows is still complete', async () => {
  const wrongSchema = installBridge();
  wrongSchema.api.schema = 'gentle-shell-bridge/api/v2';
  const schemaHost = installHost();
  await loadExtension(schemaHost.pi);
  assert.deepEqual(wrongSchema.keymaps, [], 'a foreign schema registers nothing');
  assert.deepEqual(wrongSchema.commands, []);
  assert.equal(schemaHost.shortcuts.length, 0, 'and binds no key');

  delete globalThis[BRIDGE_SLOT];
  const wrongVersion = installBridge();
  wrongVersion.api.version = 2;
  const versionHost = installHost();
  await loadExtension(versionHost.pi);
  assert.deepEqual(wrongVersion.keymaps, []);
  assert.equal(versionHost.shortcuts.length, 0);

  delete globalThis[BRIDGE_SLOT];
  // The picker's two OLD members (`registerKeymap`, `registerCommands`) are no
  // longer used by any surface, so a bridge without them is still a bridge this
  // package loads behind: the surface registers and the key is bound.
  const partial = installBridge({ members: { registerKeymap: undefined, registerCommands: undefined } });
  const partialHost = installHost();
  const loaded = await loadExtension(partialHost.pi);
  assert.equal(partialHost.shortcuts.length, 1, 'the key comes from the host, not from those members');
  assert.deepEqual(partial.keymaps, [], 'nothing is contributed to a member that is absent');
  assert.equal(loaded.commands.has('files'), true, 'the surface still registers');
});

// ---------------------------------------------------------------------------
// A bridge that publishes later, from the ONE ready announcement.
// ---------------------------------------------------------------------------

// RE-SCOPED (was "a bridge that publishes later lands both registrations from the
// ready event", which assumed the whole package had already registered eagerly at
// load and only the bridge surfaces waited). The announcement is now what brings
// the ENTIRE surface to life, and it may bring it exactly once.
test('S18/S19 (T14): the ready announcement registers the whole surface, exactly once', async () => {
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
  }, { bridge: false });

  // Nothing at all while the bridge is absent, and ONE subscription listening for it.
  assert.deepEqual([...loaded.commands.keys()], [], 'no command before the announcement');
  assert.deepEqual([...loaded.tools.keys()], [], 'no tool either');
  assert.equal(host.shortcuts.length, 0, 'and no key: there is no surface for it to open');
  const ready = subscriptions.filter((entry) => entry.event === READY_EVENT);
  assert.equal(ready.length, 1, 'ONE shared announcement subscription carries the whole gate');
  assert.equal(subscriptions.every((entry) => entry.event === READY_EVENT), true, 'and nothing else is listened to');

  // The bridge publishes and announces.
  const bridge = installBridge();
  for (const entry of ready) entry.handler();

  assert.deepEqual([...loaded.commands.keys()].sort(), ['files', 'issues', 'odd', 'warp'],
    'the four commands arrive with the bridge');
  assert.deepEqual([...loaded.tools.keys()].sort(), ['worktree_create', 'worktree_list'], 'the two tools');
  assert.deepEqual([...loaded.messageRenderers.keys()], ['worktree-warp'], 'the message renderer');
  assert.deepEqual([...loaded.entryRenderers.keys()].sort(), ['odd-worktree-issues-refusal', 'odd-worktree-warp-queue'],
    'both entry renderers');
  const hookNames = new Set(loaded.hooks.map(([event]) => event));
  for (const name of ['session_start', 'session_shutdown', 'tool_call', 'tool_result', 'turn_end', 'before_agent_start']) {
    assert.equal(hookNames.has(name), true, `the ${name} hooks arrive too`);
  }

  // The picker's contribution to the BRIDGE is now none at all: the key is bound
  // on the host, once, as part of that same registration episode.
  assert.deepEqual(filesRows(bridge.keymaps), [], 'the late bridge is handed no keymap row');
  assert.deepEqual(filesRows(bridge.commands), [], 'nor a palette row');
  assert.deepEqual(bridge.resolved, [], 'and is never asked for a key');
  assert.equal(host.shortcuts.length, 1, 'the episode binds the ONE key');
  assert.equal(host.shortcuts[0].key, 'alt+p', 'the default key, from the environment or alt+p');

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]], 'the late key reaches the picker path');

  // A second announcement is a no-op: nothing registers twice, and no second key.
  const commandCount = loaded.commands.size;
  const toolCount = loaded.tools.size;
  const hookCount = loaded.hooks.length;
  for (const entry of ready) entry.handler();
  assert.equal(loaded.commands.size, commandCount, 'a second announcement registers no second command');
  assert.equal(loaded.tools.size, toolCount, 'no second tool');
  assert.equal(loaded.hooks.length, hookCount, 'and no second hook');
  assert.deepEqual(bridge.keymaps, [], 'and no second keymap action');
  assert.deepEqual(bridge.commands, [], 'and no second palette row');
  assert.equal(host.shortcuts.length, 1, 'the same key is still bound exactly once');
});

// ---------------------------------------------------------------------------
// Idempotent: a session start never stacks a second contribution or key.
// ---------------------------------------------------------------------------

test('S36: two session starts add no files row and no second key', async () => {
  await stubGh();
  const bridge = installBridge();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 1);

  const ctx = notifyHost().ctx;
  await fireSessionStart(loaded.hooks, ctx);
  await fireSessionStart(loaded.hooks, ctx);
  assert.deepEqual(filesRows(bridge.keymaps), [], 'a session start contributes nothing');
  assert.deepEqual(filesRows(bridge.commands), []);
  assert.equal(host.shortcuts.length, 1, 'and never stacks a second shortcut');

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]], 'the one key still reaches the picker path');
});

// ---------------------------------------------------------------------------
// A broken bridge never breaks the extension.
// ---------------------------------------------------------------------------

test('S18/S19: a bridge whose members throw never breaks the extension', async () => {
  const boom = () => { throw new Error('bridge member exploded'); };
  // The members that ARE used: the rail's section, the `Cards` rows, the design
  // and the store. The key no longer depends on the bridge at all.
  const bridge = installBridge({
    members: {
      registerSection: boom,
      registerRows: boom,
      registerToolDesign: boom,
      createStore: boom,
    },
  });
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(loaded.commands.has('files'), true, 'the command still registers');
  assert.equal(loaded.tools.has('worktree_list'), true, 'the other surfaces still register');
  assert.equal(host.shortcuts.length, 1, 'and the host bound the key anyway');
  assert.deepEqual(bridge.keymaps, [], 'a throwing bridge contributed no row');
  assert.deepEqual(bridge.commands, []);

  await stubGh();
  await fireSessionStart(loaded.hooks, notifyHost().ctx);
  assert.equal(host.shortcuts.length, 1, 'a session start changes nothing');
});

// ---------------------------------------------------------------------------
// A host that cannot take the key never breaks the extension.
// ---------------------------------------------------------------------------

test('S36: a host with no registerShortcut at all still gets /files and never throws', async () => {
  const loaded = await loadExtension({});
  assert.equal(loaded.commands.has('files'), true, 'the command is the whole surface without a key');
  assert.equal(loaded.tools.has('worktree_list'), true, 'no other surface changes');

  const sink = notifyHost();
  await loaded.commands.get('files').handler('', sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]]);
});

test('S36: a host that refuses the shortcut says nothing and keeps the command', async () => {
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
  installBridge();
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

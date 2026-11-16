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
//
// S18 (T14): the gate this package now loads behind validates the WHOLE published
// object (`schema`, `version`, `registerSection`, `registerRows`, `createStore`),
// so a fake that only carries the picker's two members would be "no bridge" and
// this suite would test an extension that never loaded. The members no assertion
// here measures are therefore present but inert.
function installBridge({ key = 'alt+p', members = {} } = {}) {
  const keymaps = [];
  const commands = [];
  const resolved = [];
  const released = [];
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
// S18 (T14): no bridge, no package. The policy the human chose, verbatim:
// "Desactivar todo el plugin" — when gentle-shell-bridge is not published, this
// extension registers NOTHING: no command, no tool, no renderer, no card, no rail,
// no hook, no prompt append. The only thing that happens is ONE notice naming the
// install line, in a primary session.
//
// RE-SCOPED (was "with no bridge, nothing is registered, nothing is bound and
// nothing throws", which also asserted that `/files` and both worktree tools WERE
// registered — the old policy, where only the bridge surfaces stayed absent).
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

  // The picker's contribution is the one this file owns: it lands off the same
  // announcement, exactly as the eager path did.
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

  // A second announcement is a no-op: nothing registers twice.
  const commandCount = loaded.commands.size;
  const toolCount = loaded.tools.size;
  const hookCount = loaded.hooks.length;
  for (const entry of ready) entry.handler();
  assert.equal(loaded.commands.size, commandCount, 'a second announcement registers no second command');
  assert.equal(loaded.tools.size, toolCount, 'no second tool');
  assert.equal(loaded.hooks.length, hookCount, 'and no second hook');
  assert.equal(bridge.keymaps.length, 1, 'and no second keymap action');
  assert.equal(bridge.commands.length, 1, 'and no second palette row');
  assert.equal(host.shortcuts.length, 1, 'the same key is still bound exactly once');
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

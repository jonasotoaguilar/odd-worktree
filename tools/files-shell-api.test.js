'use strict';
// T19 (S36, S41), T2 (S5) and T14 (S18) together: the picker's and the issues
// panel's keys are bound directly on the host, and the package itself loads only when a
// compatible shell API object is on the published slot (native since native-shell API T2).
//
// What this file proves, all of it through the loaded extension:
// - `alt+p` is bound with `pi.registerShortcut` at load — FIRST and complete —
//   `alt+i` is bound beside it (S5), and `/files` and `/issues` are registered
//   under their own names (S36/S41);
// - `GENTLE_PI_FILES_KEY` / `GENTLE_PI_ISSUES_KEY` override those keys, and an
//   empty (or blank) override falls back to `alt+p` / `alt+i`;
// - without the `gh` CLI `/issues` never registers, and its key is never bound;
// - each bound handler is the SAME path its command opens, with the session
//   context the host hands a shortcut;
// - a complete shell API is handed NO keymap and NO palette row for `files`, and is
//   never asked to resolve a key, while the shortcut is still bound (S36);
// - a `session_start` never adds those rows and never binds a second key;
// - a host without `registerShortcut`, a host that throws from it, and a missing
//   command handler never break the extension and say nothing;
// - with an ABSENT or INCOMPATIBLE slot the package registers NOTHING — no command, no
//   tool, no renderer, no hook, no key — and says nothing either: the install hint, its
//   warn slot and the ready-event hold are gone (S18, T2). The slot is read ONCE per load,
//   so a publication that lands afterwards is picked up by the next load, not by this one.
//
// Where the two contracts meet (this is the merge of main's T15 with this
// branch's S18): the key is bound at load, but it is bound inside the package's
// single registration episode, so a host with no shell API gets no key because it
// gets no surface at all.
//
// The shell API slot is process-wide, so it is restored after every test, and the
// environment this file touches is snapshotted and restored in `after`.

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadExtension, withGhPath } = require('./fixtures/load-extension.js');

const SHELL_SLOT = Symbol.for('odd-worktree/shell-api/v1');
// The one line `/files` answers a host with no overlay: the proof that the bound
// key reached the command's own path.
const NO_UI_LINE = 'files: the file picker needs an interactive session with overlay support';
// The shared statement a directory outside any repository gets, at info. The
// issues key and the `/issues` command must answer with this same line.
const noRepositoryLine = (cwd) => `not a git repository: ${cwd}; run 'git init' first`;

const savedEnv = { ...process.env };
const scratch = [];
after(() => {
  delete globalThis[SHELL_SLOT];
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

afterEach(() => {
  delete globalThis[SHELL_SLOT];
  delete process.env.GENTLE_PI_FILES_KEY;
  delete process.env.GENTLE_PI_ISSUES_KEY;
});

// A fake shell API on the real slot, complete enough for every surface this package
// could possibly contribute to: it records each registration and each
// resolution, so a `files` row — or even a question about one — is visible.
//
// S18 (T14): the gate this package loads behind validates the WHOLE published
// object (`schema`, `version`, `registerSection`, `registerRows`, `createStore`),
// so a fake that only carried the picker's two old members would be "no shell API"
// and this suite would test an extension that never loaded. The members no
// assertion here measures are therefore present but inert; `members` overrides
// any of them to model a throwing or partial shell API.
function installShellApi({ members = {} } = {}) {
  const keymaps = [];
  const commands = [];
  const resolved = [];
  const api = {
    schema: 'odd-worktree/shell-api',
    version: 1,
    registerSection: () => () => {},
    registerRows: () => () => {},
    registerToolDesign: () => () => {},
    // Both modules default Off in the real store; this bridge stores them On so the load keeps the whole surface.
    createStore: () => ({ get: (key) => (key === 'modules' ? { codegraph: true, worktrees: true } : undefined) }),
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
  globalThis[SHELL_SLOT] = api;
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

// A bound key is fire-and-forget for the host — it never awaits the command's own
// async path — so a test that compares its effect with the command's waits for
// both sinks to answer instead of assuming the keypress returned settled.
async function settled(sinks) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (sinks.every((sink) => sink.length > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-files-shell-api-'));
  scratch.push(dir);
  return fs.realpathSync(dir);
}

// The `files` rows a fake shell API was handed, if any: the whole claim S36 removes.
function filesRows(rows) {
  return rows.filter((row) => row && row.id === 'files');
}

// ---------------------------------------------------------------------------
// S36/S41: the key is bound directly, no shell API row involved.
// ---------------------------------------------------------------------------

test('S41/S5: the shortcuts bind alt+p first and alt+i beside it, and both commands still register', async () => {
  const shellApi = installShellApi();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 2, 'the picker key and the issues key are bound, and nothing else');
  assert.equal(host.shortcuts[0].key, 'alt+p', 'the picker key is still bound FIRST, at its default (S41)');
  assert.equal(typeof host.shortcuts[0].options.handler, 'function');
  assert.equal(typeof host.shortcuts[0].options.description, 'string');
  assert.equal(host.shortcuts[1].key, 'alt+i', 'the issues panel follows it at its default (S5)');
  assert.equal(typeof host.shortcuts[1].options.handler, 'function');
  assert.equal(typeof host.shortcuts[1].options.description, 'string');
  assert.notEqual(host.shortcuts[1].options.description, host.shortcuts[0].options.description,
    'each key describes its own surface');
  assert.equal(loaded.commands.has('files'), true, '/files is still registered under its own name');
  assert.equal(loaded.commands.has('issues'), true, 'and /issues is the command behind the second key');
  assert.deepEqual(shellApi.keymaps, [], 'this package contributes no keymap action at all');
  assert.deepEqual(shellApi.commands, [], 'nor any palette row');
  assert.deepEqual(shellApi.resolved, [], 'and the shell is never asked to resolve a key');
  assert.notEqual(globalThis[SHELL_SLOT], undefined, 'the shell API is the host\'s own published object');
});

test('S41: GENTLE_PI_FILES_KEY overrides the bound key', async () => {
  installShellApi();
  process.env.GENTLE_PI_FILES_KEY = 'ctrl+shift+f';
  const host = installHost();
  await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 2);
  assert.equal(host.shortcuts[0].key, 'ctrl+shift+f', 'the environment variable wins over the default');
  assert.equal(host.shortcuts[1].key, 'alt+i', 'and the picker\'s override moves no other key');
});

test('S41: an empty or blank override falls back to alt+p', async () => {
  installShellApi();
  for (const value of ['', '   ']) {
    process.env.GENTLE_PI_FILES_KEY = value;
    const host = installHost();
    await loadExtension(host.pi);
    assert.equal(host.shortcuts.length, 2, `the two keys are bound for the override ${JSON.stringify(value)}`);
    assert.equal(host.shortcuts[0].key, 'alt+p', `an empty override is not a key: ${JSON.stringify(value)}`);
    assert.equal(host.shortcuts[1].key, 'alt+i', `and it moves no other key: ${JSON.stringify(value)}`);
  }
});

test('S36: the bound key runs the SAME path /files opens, with the session context', async () => {
  installShellApi();
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
// S5 (issues-linked-prs-and-alt-i T2): the second host shortcut, `alt+i`.
// ---------------------------------------------------------------------------

test('S5: alt+i binds at load and its handler opens what /issues opens', async () => {
  installShellApi();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 2, 'the issues key is bound beside the picker key');
  assert.equal(host.shortcuts[1].key, 'alt+i', 'the default key is alt+i (S5)');

  // One directory outside any repository: the key and the command must refuse in
  // exactly the same words, which is the observable that they are one path.
  const cwd = practiceCheckout();
  const keyed = [];
  const direct = [];
  const ctxTo = (sink) => ({ cwd, ui: { notify: (text, level) => sink.push([level, text]) } });

  // The `gh` probe answers at CALL time, so it is held present here: the gate this
  // test compares is the repository one, and neither path may reach a real `gh`.
  await withGhPath('present', async () => {
    await host.shortcuts[1].options.handler(ctxTo(keyed));
    await loaded.commands.get('issues').handler('', ctxTo(direct));
    await settled([keyed, direct]);
  });

  assert.equal(keyed.length, 1, 'the key answers exactly once, like the command');
  assert.deepEqual(keyed, direct, 'the key runs the command\'s OWN path, never a copy of it');
  assert.deepEqual(keyed, [['info', noRepositoryLine(cwd)]],
    'and outside a repository the shared statement is the info line');
});

test('S5: GENTLE_PI_ISSUES_KEY overrides the issues key and moves no other key', async () => {
  installShellApi();
  process.env.GENTLE_PI_ISSUES_KEY = 'ctrl+shift+i';
  const host = installHost();
  await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 2);
  assert.equal(host.shortcuts[0].key, 'alt+p', 'the picker key is untouched');
  assert.equal(host.shortcuts[1].key, 'ctrl+shift+i', 'the environment variable wins over the default');
});

test('S5: an empty or blank issues override falls back to alt+i', async () => {
  installShellApi();
  for (const value of ['', '   ']) {
    process.env.GENTLE_PI_ISSUES_KEY = value;
    const host = installHost();
    await loadExtension(host.pi);
    assert.equal(host.shortcuts.length, 2, `the two keys are bound for the override ${JSON.stringify(value)}`);
    assert.equal(host.shortcuts[1].key, 'alt+i', `an empty override is not a key: ${JSON.stringify(value)}`);
    delete process.env.GENTLE_PI_ISSUES_KEY;
  }
});

test('S5: without the gh CLI no issues key is bound, and the picker key still is', async () => {
  installShellApi();
  const host = installHost();
  const loaded = await loadExtension(host.pi, { gh: false });

  assert.equal(loaded.commands.has('issues'), false, 'the gate leaves /issues unregistered');
  assert.deepEqual(host.shortcuts.map((entry) => entry.key), ['alt+p'],
    'so no dead issues key is bound, and the picker key is unaffected');
});

// ---------------------------------------------------------------------------
// S36: a shell API present and complete still gets NO files row, and no resolve.
// ---------------------------------------------------------------------------

test('S36: a complete shell API receives no keymap row and no palette row for files', async () => {
  const shellApi = installShellApi();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.deepEqual(filesRows(shellApi.keymaps), [], 'no registerKeymap call carries the id files');
  assert.deepEqual(filesRows(shellApi.commands), [], 'no registerCommands call carries the id files');
  assert.deepEqual(shellApi.keymaps, [], 'and this package contributes no keymap action at all');
  assert.deepEqual(shellApi.commands, [], 'nor any palette row');
  assert.deepEqual(shellApi.resolved, [], 'the shell is never asked to resolve a key');
  assert.deepEqual(host.shortcuts.map((entry) => entry.key), ['alt+p', 'alt+i'], 'the shortcuts are still bound');
  assert.equal(loaded.commands.has('files'), true);
  assert.equal(loaded.commands.has('issues'), true);
});

// ---------------------------------------------------------------------------
// S18 (T14) as amended by native-shell API T2/T5: the shell API is NATIVE (this package's
// own `lib/shell-api/`), so an ABSENT or INCOMPATIBLE slot is the only case left where this
// package ships nothing. The policy the human chose for that case, "Desactivar todo el
// plugin", still holds — no command, no tool, no renderer, no card, no rail, no hook, no
// prompt append and no key — and nothing is SAID either: there is no install hint, no
// notice and no observer left to say it with.
// ---------------------------------------------------------------------------

test('S18/S19 (T2): with no shell API NOTHING registers and NOTHING is said', async () => {
  delete globalThis[SHELL_SLOT];
  const savedChild = process.env.GENTLE_PI_AGENTS_CHILD;
  delete process.env.GENTLE_PI_AGENTS_CHILD;
  try {
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
  }, { shellApi: false });

  assert.equal(host.shortcuts.length, 0, 'nothing is bound');
  assert.deepEqual([...loaded.commands.keys()], [], 'no command');
  assert.deepEqual([...loaded.tools.keys()], [], 'no tool');
  assert.deepEqual([...loaded.messageRenderers.keys()], [], 'no message renderer');
  assert.deepEqual([...loaded.entryRenderers.keys()], [], 'no entry renderer');
  assert.deepEqual(loaded.hooks, [],
    'and no hook at all: the missing-plugin observer the gate needed is gone');
  assert.equal(globalThis[SHELL_SLOT], undefined, 'nothing is published by this package');
  assert.deepEqual(subscriptions, [], 'and no ready announcement is listened to either');

  // Nothing is ever said: a session start is impossible (no hook was registered) and a
  // publication on the bus reaches no listener of this package.
  const sink = notifyHost();
  await fireSessionStart(loaded.hooks, sink.ctx);
  assert.deepEqual(sink.notifications, [], 'no install hint, no warning, no notice');
  assert.deepEqual([...loaded.commands.keys()], [], 'a session start without a shell API registers no command');
  assert.deepEqual([...loaded.tools.keys()], [], 'and no tool');
  assert.equal(host.shortcuts.length, 0, 'and binds nothing');
  } finally {
    if (savedChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
    else process.env.GENTLE_PI_AGENTS_CHILD = savedChild;
  }
});

test('S18/S19: a malformed shell API is no shell API, and a shell API without the picker\'s old rows is still complete', async () => {
  const wrongSchema = installShellApi();
  wrongSchema.api.schema = 'odd-worktree/shell-api/v2';
  const schemaHost = installHost();
  await loadExtension(schemaHost.pi);
  assert.deepEqual(wrongSchema.keymaps, [], 'a foreign schema registers nothing');
  assert.deepEqual(wrongSchema.commands, []);
  assert.equal(schemaHost.shortcuts.length, 0, 'and binds no key');

  delete globalThis[SHELL_SLOT];
  const wrongVersion = installShellApi();
  wrongVersion.api.version = 2;
  const versionHost = installHost();
  await loadExtension(versionHost.pi);
  assert.deepEqual(wrongVersion.keymaps, []);
  assert.equal(versionHost.shortcuts.length, 0);

  delete globalThis[SHELL_SLOT];
  // The picker's two OLD members (`registerKeymap`, `registerCommands`) are no
  // longer used by any surface, so a shell API without them is still a shell API this
  // package loads behind: the surface registers and the key is bound.
  const partial = installShellApi({ members: { registerKeymap: undefined, registerCommands: undefined } });
  const partialHost = installHost();
  const loaded = await loadExtension(partialHost.pi);
  assert.deepEqual(partialHost.shortcuts.map((entry) => entry.key), ['alt+p', 'alt+i'],
    'the keys come from the host, not from those members');
  assert.deepEqual(partial.keymaps, [], 'nothing is contributed to a member that is absent');
  assert.equal(loaded.commands.has('files'), true, 'the surface still registers');
});

// ---------------------------------------------------------------------------
// A publication that arrives AFTER the factory is not a wake-up path any more.
// ---------------------------------------------------------------------------

// RE-SCOPED (was "the ready announcement registers the whole surface, exactly once",
// which was the deferred gate). The shell API is native and the entry imports it, so its
// object is on the slot BEFORE the factory runs and the slot is read ONCE, in the factory:
// there is no hold, no observer and no announcement subscription left to bring a surface
// to life. A slot that is empty at factory time therefore stays empty for that load, and
// the NEXT load (a `/reload` builds a new module instance) is what picks the shell API up.
test('S18/S19 (T2): a shell API that publishes after the factory is not picked up by that load', async () => {
  delete globalThis[SHELL_SLOT];
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
  }, { shellApi: false });

  // Nothing at all while the slot is empty, and nothing listening for a later arrival.
  assert.deepEqual([...loaded.commands.keys()], [], 'no command before the shell API exists');
  assert.deepEqual([...loaded.tools.keys()], [], 'no tool either');
  assert.deepEqual(loaded.hooks, [], 'no hook');
  assert.equal(host.shortcuts.length, 0, 'and no key');
  assert.deepEqual(subscriptions, [], 'and no announcement subscription: the wait is gone');

  // The shell API publishes afterwards: this load has already read the slot and is done.
  const shellApi = installShellApi();
  assert.deepEqual([...loaded.commands.keys()], [], 'a late publication adds no command');
  assert.deepEqual([...loaded.tools.keys()], [], 'no tool');
  assert.deepEqual(loaded.hooks, [], 'no hook');
  assert.equal(host.shortcuts.length, 0, 'and no key');
  assert.deepEqual(subscriptions, [], 'still nothing listens');

  // The next load is the one that sees it, with the whole surface it always had.
  const nextSubscriptions = [];
  const nextHost = installHost();
  const reloaded = await loadExtension({
    ...nextHost.pi,
    events: {
      on: (event, handler) => {
        nextSubscriptions.push({ event, handler });
        return () => {};
      },
    },
  });
  assert.deepEqual([...reloaded.commands.keys()].sort(), ['files', 'identity', 'issues', 'odd', 'prs', 'warp'],
    'the six commands arrive with the published shell API');
  assert.deepEqual([...reloaded.tools.keys()].sort(), ['worktree_create', 'worktree_list'], 'the two tools');
  assert.deepEqual([...reloaded.messageRenderers.keys()], ['worktree-warp'], 'the message renderer');
  assert.deepEqual([...reloaded.entryRenderers.keys()].sort(),
    ['odd-worktree-issues-refusal', 'odd-worktree-warp-queue'], 'both entry renderers');
  const hookNames = new Set(reloaded.hooks.map(([event]) => event));
  for (const name of ['session_start', 'session_shutdown', 'tool_call', 'tool_result', 'turn_end', 'before_agent_start']) {
    assert.equal(hookNames.has(name), true, `the ${name} hooks are registered`);
  }

  // The picker's contribution to the SHELL API is none at all: the key is bound on the host,
  // once, as part of that same registration episode.
  assert.deepEqual(filesRows(shellApi.keymaps), [], 'the shell API is handed no keymap row');
  assert.deepEqual(filesRows(shellApi.commands), [], 'nor a palette row');
  assert.deepEqual(shellApi.resolved, [], 'and is never asked for a key');
  assert.deepEqual(nextHost.shortcuts.map((entry) => entry.key), ['alt+p', 'alt+i'],
    'the episode binds the picker key and the issues key, once each');

  const sink = notifyHost();
  await nextHost.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]], 'the key reaches the picker path');

  // A second announcement is a no-op: nothing registers twice, and no second key.
  for (const entry of nextSubscriptions) entry.handler();
  assert.deepEqual([...reloaded.commands.keys()].sort(), ['files', 'identity', 'issues', 'odd', 'prs', 'warp'],
    'a repeated announcement registers no second command');
  assert.equal(nextHost.shortcuts.length, 2, 'and binds no second key');
  assert.deepEqual(shellApi.keymaps, [], 'and no second keymap action');
  assert.deepEqual(shellApi.commands, [], 'and no second palette row');
});

// ---------------------------------------------------------------------------
// Idempotent: a session start never stacks a second contribution or key.
// ---------------------------------------------------------------------------

test('S36: two session starts add no files row and no second key', async () => {
  await stubGh();
  const shellApi = installShellApi();
  const host = installHost();
  const loaded = await loadExtension(host.pi);

  assert.equal(host.shortcuts.length, 2);

  const ctx = notifyHost().ctx;
  await fireSessionStart(loaded.hooks, ctx);
  await fireSessionStart(loaded.hooks, ctx);
  assert.deepEqual(filesRows(shellApi.keymaps), [], 'a session start contributes nothing');
  assert.deepEqual(filesRows(shellApi.commands), []);
  assert.equal(host.shortcuts.length, 2, 'and never stacks a second shortcut');

  const sink = notifyHost();
  await host.shortcuts[0].options.handler(sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]], 'the one key still reaches the picker path');
});

// ---------------------------------------------------------------------------
// A broken shell API never breaks the extension.
// ---------------------------------------------------------------------------

test('S18/S19: a shell API whose members throw never breaks the extension', async () => {
  const boom = () => { throw new Error('shell API member exploded'); };
  // The members that ARE used: the rail's section, the `Cards` rows, the design
  // and the store. The key no longer depends on the shell API at all.
  const shellApi = installShellApi({
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
  assert.equal(loaded.tools.has('worktree_list'), false, 'an unreadable store is the default Off: no worktree tools');
  assert.equal(host.shortcuts.length, 2, 'and the host bound both keys anyway');
  assert.deepEqual(shellApi.keymaps, [], 'a throwing shell API contributed no row');
  assert.deepEqual(shellApi.commands, []);

  await stubGh();
  await fireSessionStart(loaded.hooks, notifyHost().ctx);
  assert.equal(host.shortcuts.length, 2, 'a session start changes nothing');
});

// ---------------------------------------------------------------------------
// A host that cannot take the key never breaks the extension.
// ---------------------------------------------------------------------------

test('S36/S5: a host with no registerShortcut at all still gets /files and /issues and never throws', async () => {
  const loaded = await loadExtension({});
  assert.equal(loaded.commands.has('files'), true, 'the command is the whole surface without a key');
  assert.equal(loaded.commands.has('issues'), true, 'and so is /issues: the keys are the convenience, never the surface');
  assert.equal(loaded.tools.has('worktree_list'), true, 'no other surface changes');

  const sink = notifyHost();
  await loaded.commands.get('files').handler('', sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]]);
});

test('S36/S5: a host that refuses the shortcut says nothing and keeps both commands', async () => {
  installShellApi();
  const attempted = [];
  const loaded = await loadExtension({
    registerShortcut: (key) => {
      attempted.push(key);
      throw new Error('the host refuses the key');
    },
  });
  assert.deepEqual(attempted, ['alt+p', 'alt+i'],
    'both keys are offered to the host, in the order they are bound');
  assert.equal(loaded.commands.has('files'), true, 'the picker command is unaffected');
  assert.equal(loaded.commands.has('issues'), true, 'and so is the issues command');
  const sink = notifyHost();
  await loaded.commands.get('files').handler('', sink.ctx);
  assert.deepEqual(sink.notifications, [['info', NO_UI_LINE]]);
});

test('S36: a missing command handler makes the bound key inert, never a throw', async () => {
  installShellApi();
  const host = installHost();
  await loadExtension({
    ...host.pi,
    registerCommand: undefined,
  });

  assert.deepEqual(host.shortcuts.map((entry) => entry.key), ['alt+p'],
    'only the picker binds: a host that took no command registered no issues command either');
  // A host that took no command has no handler for the key to reach; the call
  // must simply do nothing.
  for (const entry of host.shortcuts) {
    await entry.options.handler(notifyHost().ctx);
    assert.equal(typeof entry.options.handler, 'function');
  }
});

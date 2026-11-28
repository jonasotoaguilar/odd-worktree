'use strict';
// S1/S3 (modular-tools): the three module switches, `Codegraph+`, `Worktrees+` and
// `Skills+`. The module reads and writes one persisted document through the shell API's store,
// builds the `Tools` page's rows and says one short thing after a change. It is pure over
// the injected shell API, so nothing here loads the extension. Every switch reads Off until
// its stored value is exactly `true`, and `Codegraph+` needs the CLI before it can be turned on.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const modules = require('../lib/modules.js');

// A shell API whose `createStore` keeps one in-memory file per plugin id, like the real one.
function fakeShellApi(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const createStore = (id) => ({
    get: (key, fallback) => (files.get(id)?.[key] !== undefined ? files.get(id)[key] : fallback),
    set: (key, value) => {
      files.set(id, { ...(files.get(id) ?? {}), [key]: value });
      writes.push([id, key, value]);
    },
  });
  return { api: { createStore }, files, writes };
}

describe('reading the switches', () => {
  test('all three switches are off when nothing is stored, and for every malformed document', () => {
    assert.deepEqual(modules.readModules(fakeShellApi().api), { codegraph: false, worktrees: false, skills: false });
    const bad = [null, 42, 'on', [], { codegraph: 'yes' }, { worktrees: 1 }, { skills: 'yes' }, { codegraph: null }];
    for (const document of bad) {
      const { api } = fakeShellApi({ 'odd-worktree': { modules: document } });
      assert.deepEqual(modules.readModules(api), { codegraph: false, worktrees: false, skills: false }, JSON.stringify(document));
    }
  });

  test('a stored true switches exactly that module on, and one key leaves the others alone', () => {
    const both = fakeShellApi({ 'odd-worktree': { modules: { codegraph: true, skills: true } } });
    assert.deepEqual(modules.readModules(both.api), { codegraph: true, worktrees: false, skills: true });
    const worktrees = fakeShellApi({ 'odd-worktree': { modules: { worktrees: true } } });
    assert.deepEqual(modules.readModules(worktrees.api), { codegraph: false, worktrees: true, skills: false });
  });

  test('no shell API, no createStore and a throwing store all read as off and never throw', () => {
    for (const api of [null, undefined, {}, { createStore: () => { throw new Error('disk'); } }]) {
      assert.deepEqual(modules.readModules(api), { codegraph: false, worktrees: false, skills: false });
    }
  });
});

describe('writing a switch', () => {
  test('writes one key and keeps the other modules and every other key of the document', () => {
    const shellApi = fakeShellApi({ 'odd-worktree': { modules: { worktrees: true }, other: 1 } });
    assert.equal(modules.writeModule(shellApi.api, 'codegraph', true), true);
    assert.deepEqual(shellApi.files.get('odd-worktree'), { modules: { worktrees: true, codegraph: true }, other: 1 });
  });

  test('a failing store or an unknown module writes nothing and reports false', () => {
    assert.equal(modules.writeModule({ createStore: () => { throw new Error('disk'); } }, 'codegraph', true), false);
    const shellApi = fakeShellApi();
    assert.equal(modules.writeModule(shellApi.api, 'nope', true), false);
    assert.deepEqual(shellApi.writes, []);
  });
});

describe('the Tools page rows', () => {
  const rowsOf = (shellApi, notices = [], cli = true) => modules.moduleRowsProvider({
    api: shellApi.api,
    notify: (text) => notices.push(text),
    hasCodegraphCli: () => cli,
  }).rows({});

  test('one provider on the `Tools` page, three Off/On toggles named exactly like the switches', () => {
    const provider = modules.moduleRowsProvider({ api: fakeShellApi().api, notify: () => {} });
    assert.equal(provider.category, 'Tools');
    assert.equal(typeof provider.id, 'string');
    const rows = provider.rows({});
    assert.deepEqual(rows.map((row) => [row.choice.setting, row.choice.value]), [
      ['Codegraph+', 'Off'], ['Codegraph+', 'On'], ['Worktrees+', 'Off'], ['Worktrees+', 'On'],
      ['Skills+', 'Off'], ['Skills+', 'On'],
    ]);
    for (const row of rows) {
      assert.equal(row.category, 'Tools');
      assert.match(row.choice.setting, /^[A-Za-z]+\+?$/, 'a row name the shell API accepts');
      assert.equal(typeof row.action, 'function');
    }
  });

  test('current() follows the stored value, which is Off for all three', () => {
    const shellApi = fakeShellApi({ 'odd-worktree': { modules: { worktrees: true } } });
    assert.deepEqual(rowsOf(shellApi).map((row) => row.choice.current()), [true, false, false, true, true, false]);
    const withSkills = rowsOf(fakeShellApi({ 'odd-worktree': { modules: { skills: true } } }));
    assert.deepEqual(withSkills.map((row) => row.choice.current()), [true, false, true, false, false, true]);
  });

  test('Enter persists first, then says one short thing about the restart', async () => {
    const shellApi = fakeShellApi();
    const notices = [];
    const rows = rowsOf(shellApi, notices);
    await rows[1].action();
    assert.deepEqual(shellApi.files.get('odd-worktree').modules, { codegraph: true });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Codegraph\+ On/);
    assert.match(notices[0], /\/reload/);
    assert.match(notices[0], /new session/);
    assert.ok(notices[0].length < 100, `short: ${notices[0]}`);
    assert.equal(rows[1].choice.current(), true, 'the same page reads the new value');
  });

  test('Codegraph+ On without the CLI writes nothing and says why in one line', async () => {
    const shellApi = fakeShellApi();
    const notices = [];
    const rows = rowsOf(shellApi, notices, false);
    await rows[1].action();
    assert.deepEqual(shellApi.writes, []);
    assert.equal(rows[1].choice.current(), false, 'it stays Off');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Codegraph\+ needs the codegraph CLI/);
    assert.ok(notices[0].length < 100, `short: ${notices[0]}`);
  });

  test('Codegraph+ Off and Worktrees+ either way never ask for the CLI', async () => {
    const shellApi = fakeShellApi();
    const notices = [];
    const asked = [];
    const rows = modules.moduleRowsProvider({
      api: shellApi.api,
      notify: (text) => notices.push(text),
      hasCodegraphCli: () => { asked.push(true); return false; },
    }).rows({});
    await rows[0].action();
    await rows[2].action();
    await rows[3].action();
    assert.deepEqual(asked, []);
    assert.deepEqual(shellApi.files.get('odd-worktree').modules, { worktrees: true });
  });

  test('choosing the value it already has changes nothing and says nothing', async () => {
    const shellApi = fakeShellApi();
    const notices = [];
    const rows = rowsOf(shellApi, notices);
    await rows[0].action();
    assert.deepEqual(shellApi.writes, []);
    assert.deepEqual(notices, []);
  });

  test('a store that cannot write says nothing and never throws', async () => {
    const api = { createStore: () => ({ get: (_k, fallback) => fallback, set: () => { throw new Error('disk'); } }) };
    const notices = [];
    const rows = modules.moduleRowsProvider({ api, notify: (text) => notices.push(text), hasCodegraphCli: () => true }).rows({});
    await assert.doesNotReject(async () => rows[1].action());
    assert.deepEqual(notices, []);
  });

  test('a throwing notify never fails the action', async () => {
    const shellApi = fakeShellApi();
    const rows = modules.moduleRowsProvider({ api: shellApi.api, notify: () => { throw new Error('ui gone'); }, hasCodegraphCli: () => true }).rows({});
    await assert.doesNotReject(async () => rows[1].action());
    assert.deepEqual(shellApi.files.get('odd-worktree').modules, { codegraph: true });
  });

  test('onChange hears the key and the value after the switch was kept, and only then', async () => {
    const heard = [];
    const make = (bridge, cli) => modules.moduleRowsProvider({
      api: bridge.api,
      notify: () => {},
      hasCodegraphCli: () => cli,
      onChange: (key, on) => { heard.push([key, on]); },
    }).rows({});
    const bridge = fakeBridge();
    const rows = make(bridge, true);
    await rows[1].action();
    await rows[3].action();
    await rows[1].action();
    assert.deepEqual(heard, [['codegraph', true], ['worktrees', true]], 'a repeated choice changes nothing, so it is not heard');
    await make(fakeBridge(), false)[1].action();
    const failing = { createStore: () => ({ get: (_k, fallback) => fallback, set: () => { throw new Error('disk'); } }) };
    await modules.moduleRowsProvider({ api: failing, notify: () => {}, hasCodegraphCli: () => true, onChange: (key, on) => heard.push([key, on]) }).rows({})[1].action();
    assert.equal(heard.length, 2, 'a refused switch and an unsaved one are not heard');
  });

  test('a throwing or rejecting onChange never fails the action, and the switch stays kept', async () => {
    for (const onChange of [() => { throw new Error('wiring'); }, async () => { throw new Error('wiring'); }]) {
      const bridge = fakeBridge();
      const rows = modules.moduleRowsProvider({ api: bridge.api, notify: () => {}, hasCodegraphCli: () => true, onChange }).rows({});
      await assert.doesNotReject(async () => rows[1].action());
      assert.deepEqual(bridge.files.get('odd-worktree').modules, { codegraph: true });
    }
  });
});

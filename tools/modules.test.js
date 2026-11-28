'use strict';
// S1/S3 (modular-tools): the two module switches, `Codegraph+` and `Worktrees+`. The
// module reads and writes one persisted document through the shell API's store, builds the
// `Tools` page's rows and says one short thing after a change. It is pure over the
// injected shell API, so nothing here loads the extension.
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
  test('both modules are on when nothing is stored, and for every malformed document', () => {
    assert.deepEqual(modules.readModules(fakeShellApi().api), { codegraph: true, worktrees: true });
    for (const bad of [null, 42, 'off', [], { codegraph: 'no' }, { worktrees: null }]) {
      const { api } = fakeShellApi({ 'odd-worktree': { modules: bad } });
      const read = modules.readModules(api);
      assert.equal(read.codegraph, true, JSON.stringify(bad));
      assert.equal(read.worktrees, true, JSON.stringify(bad));
    }
  });

  test('a stored false switches exactly that module off', () => {
    const { api } = fakeShellApi({ 'odd-worktree': { modules: { codegraph: false } } });
    assert.deepEqual(modules.readModules(api), { codegraph: false, worktrees: true });
  });

  test('no shell API, no createStore and a throwing store all read as on and never throw', () => {
    for (const api of [null, undefined, {}, { createStore: () => { throw new Error('disk'); } }]) {
      assert.deepEqual(modules.readModules(api), { codegraph: true, worktrees: true });
    }
  });
});

describe('writing a switch', () => {
  test('writes one key and keeps the other module and every other key of the document', () => {
    const shellApi = fakeShellApi({ 'odd-worktree': { modules: { worktrees: false }, other: 1 } });
    assert.equal(modules.writeModule(shellApi.api, 'codegraph', false), true);
    assert.deepEqual(shellApi.files.get('odd-worktree'), { modules: { worktrees: false, codegraph: false }, other: 1 });
  });

  test('a failing store or an unknown module writes nothing and reports false', () => {
    assert.equal(modules.writeModule({ createStore: () => { throw new Error('disk'); } }, 'codegraph', false), false);
    const shellApi = fakeShellApi();
    assert.equal(modules.writeModule(shellApi.api, 'nope', false), false);
    assert.deepEqual(shellApi.writes, []);
  });
});

describe('the Tools page rows', () => {
  const rowsOf = (shellApi, notices = []) => modules.moduleRowsProvider({ api: shellApi.api, notify: (text) => notices.push(text) }).rows({});

  test('one provider on the `Tools` page, two Off/On toggles named exactly like the switches', () => {
    const provider = modules.moduleRowsProvider({ api: fakeShellApi().api, notify: () => {} });
    assert.equal(provider.category, 'Tools');
    assert.equal(typeof provider.id, 'string');
    const rows = provider.rows({});
    assert.deepEqual(rows.map((row) => [row.choice.setting, row.choice.value]), [
      ['Codegraph+', 'Off'], ['Codegraph+', 'On'], ['Worktrees+', 'Off'], ['Worktrees+', 'On'],
    ]);
    for (const row of rows) {
      assert.equal(row.category, 'Tools');
      assert.match(row.choice.setting, /^[A-Za-z]+\+?$/, 'a row name the shell API accepts');
      assert.equal(typeof row.action, 'function');
    }
  });

  test('current() follows the stored value, On by default', () => {
    const shellApi = fakeShellApi({ 'odd-worktree': { modules: { worktrees: false } } });
    const rows = rowsOf(shellApi);
    assert.deepEqual(rows.map((row) => row.choice.current()), [false, true, true, false]);
  });

  test('Enter persists first, then says one short thing about the restart', async () => {
    const shellApi = fakeShellApi();
    const notices = [];
    const rows = rowsOf(shellApi, notices);
    await rows[0].action();
    assert.deepEqual(shellApi.files.get('odd-worktree').modules, { codegraph: false });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Codegraph\+ Off/);
    assert.match(notices[0], /\/reload/);
    assert.match(notices[0], /new session/);
    assert.ok(notices[0].length < 100, `short: ${notices[0]}`);
    assert.equal(rows[0].choice.current(), true, 'the same page reads the new value');
  });

  test('choosing the value it already has changes nothing and says nothing', async () => {
    const shellApi = fakeShellApi();
    const notices = [];
    const rows = rowsOf(shellApi, notices);
    await rows[3].action();
    assert.deepEqual(shellApi.writes, []);
    assert.deepEqual(notices, []);
  });

  test('a store that cannot write says nothing and never throws', async () => {
    const api = { createStore: () => ({ get: (_k, fallback) => fallback, set: () => { throw new Error('disk'); } }) };
    const notices = [];
    const rows = modules.moduleRowsProvider({ api, notify: (text) => notices.push(text) }).rows({});
    await assert.doesNotReject(async () => rows[0].action());
    assert.deepEqual(notices, []);
  });

  test('a throwing notify never fails the action', async () => {
    const shellApi = fakeShellApi();
    const rows = modules.moduleRowsProvider({ api: shellApi.api, notify: () => { throw new Error('ui gone'); } }).rows({});
    await assert.doesNotReject(async () => rows[0].action());
    assert.deepEqual(shellApi.files.get('odd-worktree').modules, { codegraph: false });
  });
});

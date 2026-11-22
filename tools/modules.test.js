'use strict';
// S1/S3 (modular-tools): the two module switches, `Codegraph+` and `Worktrees+`. The
// module reads and writes one persisted document through the bridge's store, builds the
// `Tools` page's rows and says one short thing after a change. It is pure over the
// injected bridge, so nothing here loads the extension.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const modules = require('../lib/modules.js');

// A bridge whose `createStore` keeps one in-memory file per plugin id, like the real one.
function fakeBridge(initial = {}) {
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
    assert.deepEqual(modules.readModules(fakeBridge().api), { codegraph: true, worktrees: true });
    for (const bad of [null, 42, 'off', [], { codegraph: 'no' }, { worktrees: null }]) {
      const { api } = fakeBridge({ 'odd-worktree': { modules: bad } });
      const read = modules.readModules(api);
      assert.equal(read.codegraph, true, JSON.stringify(bad));
      assert.equal(read.worktrees, true, JSON.stringify(bad));
    }
  });

  test('a stored false switches exactly that module off', () => {
    const { api } = fakeBridge({ 'odd-worktree': { modules: { codegraph: false } } });
    assert.deepEqual(modules.readModules(api), { codegraph: false, worktrees: true });
  });

  test('no bridge, no createStore and a throwing store all read as on and never throw', () => {
    for (const api of [null, undefined, {}, { createStore: () => { throw new Error('disk'); } }]) {
      assert.deepEqual(modules.readModules(api), { codegraph: true, worktrees: true });
    }
  });
});

describe('writing a switch', () => {
  test('writes one key and keeps the other module and every other key of the document', () => {
    const bridge = fakeBridge({ 'odd-worktree': { modules: { worktrees: false }, other: 1 } });
    assert.equal(modules.writeModule(bridge.api, 'codegraph', false), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), { modules: { worktrees: false, codegraph: false }, other: 1 });
  });

  test('a failing store or an unknown module writes nothing and reports false', () => {
    assert.equal(modules.writeModule({ createStore: () => { throw new Error('disk'); } }, 'codegraph', false), false);
    const bridge = fakeBridge();
    assert.equal(modules.writeModule(bridge.api, 'nope', false), false);
    assert.deepEqual(bridge.writes, []);
  });
});

describe('the Tools page rows', () => {
  const rowsOf = (bridge, notices = []) => modules.moduleRowsProvider({ api: bridge.api, notify: (text) => notices.push(text) }).rows({});

  test('one provider on the `Tools` page, two Off/On toggles named exactly like the switches', () => {
    const provider = modules.moduleRowsProvider({ api: fakeBridge().api, notify: () => {} });
    assert.equal(provider.category, 'Tools');
    assert.equal(typeof provider.id, 'string');
    const rows = provider.rows({});
    assert.deepEqual(rows.map((row) => [row.choice.setting, row.choice.value]), [
      ['Codegraph+', 'Off'], ['Codegraph+', 'On'], ['Worktrees+', 'Off'], ['Worktrees+', 'On'],
    ]);
    for (const row of rows) {
      assert.equal(row.category, 'Tools');
      assert.match(row.choice.setting, /^[A-Za-z]+\+?$/, 'a row name the bridge accepts');
      assert.equal(typeof row.action, 'function');
    }
  });

  test('current() follows the stored value, On by default', () => {
    const bridge = fakeBridge({ 'odd-worktree': { modules: { worktrees: false } } });
    const rows = rowsOf(bridge);
    assert.deepEqual(rows.map((row) => row.choice.current()), [false, true, true, false]);
  });

  test('Enter persists first, then says one short thing about the restart', async () => {
    const bridge = fakeBridge();
    const notices = [];
    const rows = rowsOf(bridge, notices);
    await rows[0].action();
    assert.deepEqual(bridge.files.get('odd-worktree').modules, { codegraph: false });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Codegraph\+ Off/);
    assert.match(notices[0], /\/reload/);
    assert.match(notices[0], /new session/);
    assert.ok(notices[0].length < 100, `short: ${notices[0]}`);
    assert.equal(rows[0].choice.current(), true, 'the same page reads the new value');
  });

  test('choosing the value it already has changes nothing and says nothing', async () => {
    const bridge = fakeBridge();
    const notices = [];
    const rows = rowsOf(bridge, notices);
    await rows[3].action();
    assert.deepEqual(bridge.writes, []);
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
    const bridge = fakeBridge();
    const rows = modules.moduleRowsProvider({ api: bridge.api, notify: () => { throw new Error('ui gone'); } }).rows({});
    await assert.doesNotReject(async () => rows[0].action());
    assert.deepEqual(bridge.files.get('odd-worktree').modules, { codegraph: false });
  });
});

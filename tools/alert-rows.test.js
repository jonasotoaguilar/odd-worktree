'use strict';
// S3/S4 (opencode-usage-alert): the `Alert` page of `/gentle:customize` and its one
// `Deepseek peak` Off/On line. The page sits right after `Notifications`, the line reads
// and writes the boolean `lib/alert-mode.js` owns, and a successful change applies to the
// RUNNING session at once — no `/reload`, no new session, so nothing says "restart".
// Pure over the injected bridge and callbacks; nothing here loads the extension.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const alertMode = require('../lib/alert-mode.js');
const alertRows = require('../lib/alert-rows.js');

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

function provider(api, hooks = {}) {
  const calls = { notify: [], onChange: [] };
  const rows = alertRows.alertRowsProvider({
    api,
    notify: (text) => {
      calls.notify.push(text);
      if (hooks.notify) hooks.notify(text);
    },
    onChange: () => {
      calls.onChange.push(true);
      if (hooks.onChange) hooks.onChange();
    },
  });
  return { provider: rows, calls, rows: (ctx = {}) => rows.rows(ctx) };
}

describe('the Alert page', () => {
  test('is one provider, named, on a page of its own, placed right after Notifications', () => {
    const { provider: page } = provider(fakeBridge().api);
    assert.deepEqual(Object.keys(page).sort(), ['category', 'categoryPlacement', 'id', 'rows']);
    assert.equal(page.id, 'odd-worktree.alert.peak');
    assert.equal(page.category, 'Alert');
    assert.deepEqual(page.categoryPlacement, { after: 'Notifications' });
  });

  test('carries exactly one setting, `Deepseek peak`, as the two rows Off and then On', () => {
    const { rows } = provider(fakeBridge().api);
    const built = rows();
    assert.equal(built.length, 2);
    assert.deepEqual(built.map((row) => [row.choice.setting, row.choice.value]), [
      ['Deepseek peak', 'Off'], ['Deepseek peak', 'On'],
    ]);
    for (const row of built) {
      assert.equal(row.category, 'Alert');
      assert.equal(row.label(), 'Deepseek peak');
      assert.match(row.choice.setting, /^[A-Za-z]+ [A-Za-z]+$/, 'a row name the bridge accepts');
      assert.equal(typeof row.action, 'function');
    }
  });
});

describe('the current value', () => {
  test('is On for a first run, and follows what is stored', () => {
    assert.deepEqual(provider(fakeBridge().api).rows().map((row) => row.choice.current()), [false, true]);
    for (const stored of [true, false]) {
      const bridge = fakeBridge({ 'odd-worktree': { alerts: { deepseekPeak: stored } } });
      assert.deepEqual(provider(bridge.api).rows().map((row) => row.choice.current()), [!stored, stored], String(stored));
    }
  });

  test('is read live: a value changed between two builds is reflected', () => {
    const bridge = fakeBridge();
    const { rows } = provider(bridge.api);
    assert.deepEqual(rows().map((row) => row.choice.current()), [false, true]);
    alertMode.writeDeepseekPeak(bridge.api, false);
    assert.deepEqual(rows().map((row) => row.choice.current()), [true, false]);
    alertMode.writeDeepseekPeak(bridge.api, true);
    assert.deepEqual(rows().map((row) => row.choice.current()), [false, true]);
  });
});

describe('choosing a value', () => {
  test('persists it, then applies it to the running session once', async () => {
    const bridge = fakeBridge();
    const { rows, calls } = provider(bridge.api);
    await rows()[0].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { deepseekPeak: false } });
    assert.equal(calls.onChange.length, 1);
    assert.equal(alertMode.readDeepseekPeak(bridge.api), false);
    await rows()[1].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { deepseekPeak: true } });
    assert.equal(calls.onChange.length, 2);
    assert.equal(alertMode.readDeepseekPeak(bridge.api), true);
  });

  test('keeps the other keys of the store', async () => {
    const bridge = fakeBridge({ 'odd-worktree': { modules: { codegraph: false } } });
    await provider(bridge.api).rows()[0].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), {
      modules: { codegraph: false },
      alerts: { deepseekPeak: false },
    });
  });

  test('says nothing: this switch needs no reload, so no restart notice is printed', async () => {
    const bridge = fakeBridge();
    const { rows, calls } = provider(bridge.api);
    await rows()[0].action();
    await rows()[1].action();
    assert.deepEqual(calls.notify, []);
  });
});

describe('a write the store refuses', () => {
  test('is thrown so the menu reports it, and the running session is not told it changed', async () => {
    const api = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    const { rows, calls } = provider(api);
    await assert.rejects(async () => rows()[0].action(), /Deepseek peak/);
    assert.deepEqual(calls.onChange, []);
  });

  test('is thrown for a host with no store at all, and still calls nothing', async () => {
    const { rows, calls } = provider(undefined);
    await assert.rejects(async () => rows()[0].action(), /Deepseek peak/);
    assert.deepEqual(calls.onChange, []);
  });

  test('leaves the stored value reading On, the way it read before the press', async () => {
    const api = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    await assert.rejects(async () => provider(api).rows()[0].action(), /Deepseek peak/);
    assert.equal(alertMode.readDeepseekPeak(api), true);
  });
});

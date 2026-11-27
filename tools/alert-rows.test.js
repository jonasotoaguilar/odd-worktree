'use strict';
// S5/S7/S8 (opencode-usage-alert): the `Alert` page of `/gentle:customize`. It carries one
// Off/On pair PER provider the peak registry declares, in the registry's declaration order,
// under each provider's own setting label (`Deepseek peak`, then `Claude peak`). Each line
// reads and writes the boolean `lib/alert-mode.js` owns for that provider id, and a
// successful change applies to the RUNNING session at once — no `/reload`, so nothing says
// "restart". Pure over the injected bridge and callbacks; nothing here loads the extension.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const alertMode = require('../lib/alert-mode.js');
const alertRows = require('../lib/alert-rows.js');
const { PROVIDERS } = require('../lib/peak-providers.js');

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

// The rows of one provider's pair: Off first, then On, both under the provider's setting.
function pairOf(rows, setting) {
  return rows.filter((row) => row.choice.setting === setting);
}

function stored(value = {}) {
  return fakeBridge({ 'odd-worktree': { alerts: { peaks: value } } });
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

  test('carries exactly one Off/On pair per registry entry, in declaration order, with its own label', () => {
    const { rows } = provider(fakeBridge().api);
    const built = rows();
    assert.equal(PROVIDERS.length > 0, true, 'the registry declares at least one provider');
    assert.deepEqual(
      built.map((row) => [row.choice.setting, row.choice.value]),
      PROVIDERS.flatMap((entry) => [[entry.setting, 'Off'], [entry.setting, 'On']]),
    );
    // The registry's documented shape: DeepSeek first, Claude second, each under its setting.
    assert.deepEqual(PROVIDERS.map((entry) => entry.id), ['deepseek', 'claude']);
    assert.deepEqual(PROVIDERS.map((entry) => entry.setting), ['Deepseek peak', 'Claude peak']);
    for (const row of built) {
      assert.equal(row.category, 'Alert');
      assert.equal(typeof row.label, 'function');
      assert.equal(typeof row.action, 'function');
    }
  });

  test('labels each pair with its provider\'s setting, not with a fixed name', () => {
    const built = provider(fakeBridge().api).rows();
    for (const entry of PROVIDERS) {
      const pair = pairOf(built, entry.setting);
      assert.equal(pair.length, 2, entry.setting);
      assert.deepEqual(pair.map((row) => row.choice.value), ['Off', 'On'], entry.setting);
      for (const row of pair) assert.equal(row.label(), entry.setting);
    }
  });
});

describe('the current value', () => {
  test('is Off for every provider on a first run, and follows each provider\'s own switch', () => {
    const fresh = provider(fakeBridge().api).rows();
    for (const entry of PROVIDERS) {
      assert.deepEqual(pairOf(fresh, entry.setting).map((row) => row.choice.current()), [true, false], entry.setting);
    }
    for (const entry of PROVIDERS) {
      const built = provider(stored({ [entry.id]: true }).api).rows();
      const pair = pairOf(built, entry.setting);
      assert.deepEqual(pair.map((row) => row.choice.current()), [false, true], entry.setting);
      // Every other provider is untouched by that one provider's value.
      for (const sibling of PROVIDERS.filter((other) => other.id !== entry.id)) {
        assert.deepEqual(
          pairOf(built, sibling.setting).map((row) => row.choice.current()),
          [true, false],
          `${entry.id} vs ${sibling.id}`,
        );
      }
    }
  });

  test('is read live: a value changed between two builds is reflected', () => {
    const bridge = fakeBridge();
    const { rows } = provider(bridge.api);
    const target = PROVIDERS[0];
    const sibling = PROVIDERS[1];
    assert.deepEqual(pairOf(rows(), target.setting).map((row) => row.choice.current()), [true, false]);
    alertMode.writePeakAlert(bridge.api, target.id, true);
    assert.deepEqual(pairOf(rows(), target.setting).map((row) => row.choice.current()), [false, true]);
    assert.deepEqual(pairOf(rows(), sibling.setting).map((row) => row.choice.current()), [true, false]);
    alertMode.writePeakAlert(bridge.api, target.id, false);
    assert.deepEqual(pairOf(rows(), target.setting).map((row) => row.choice.current()), [true, false]);
  });
});

describe('choosing a value', () => {
  test('persists that provider\'s id, then applies it to the running session once', async () => {
    const bridge = fakeBridge();
    const { rows, calls } = provider(bridge.api);
    const target = PROVIDERS[0];
    await pairOf(rows(), target.setting)[1].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { peaks: { [target.id]: true } } });
    assert.equal(calls.onChange.length, 1);
    assert.equal(alertMode.readPeakAlert(bridge.api, target.id), true);
    await pairOf(rows(), target.setting)[0].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { peaks: { [target.id]: false } } });
    assert.equal(calls.onChange.length, 2);
    assert.equal(alertMode.readPeakAlert(bridge.api, target.id), false);
  });

  test('a second provider\'s line writes only its own id and leaves its siblings alone', async () => {
    const bridge = stored({});
    const { rows, calls } = provider(bridge.api);
    await pairOf(rows(), PROVIDERS[0].setting)[1].action();
    await pairOf(rows(), PROVIDERS[1].setting)[1].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), {
      alerts: { peaks: { [PROVIDERS[0].id]: true, [PROVIDERS[1].id]: true } },
    });
    assert.equal(calls.onChange.length, 2);
    await pairOf(rows(), PROVIDERS[0].setting)[0].action();
    assert.equal(alertMode.readPeakAlert(bridge.api, PROVIDERS[0].id), false);
    assert.equal(alertMode.readPeakAlert(bridge.api, PROVIDERS[1].id), true);
  });

  test('keeps the other keys of the store', async () => {
    const bridge = fakeBridge({ 'odd-worktree': { modules: { codegraph: false } } });
    await provider(bridge.api).rows()[0].action();
    assert.deepEqual(bridge.files.get('odd-worktree'), {
      modules: { codegraph: false },
      alerts: { peaks: { [PROVIDERS[0].id]: false } },
    });
  });

  test('says nothing: these switches need no reload, so no restart notice is printed', async () => {
    const bridge = fakeBridge();
    const { rows, calls } = provider(bridge.api);
    for (const row of rows()) await row.action();
    assert.deepEqual(calls.notify, []);
  });
});

describe('a write the store refuses', () => {
  test('is thrown per provider so the menu reports it, and nothing is told it changed', async () => {
    const api = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    const { rows, calls } = provider(api);
    for (const entry of PROVIDERS) {
      const pair = pairOf(rows(), entry.setting);
      await assert.rejects(async () => pair[0].action(), new RegExp(`^Error: ${entry.setting} could not be saved$`), entry.setting);
      await assert.rejects(async () => pair[1].action(), new RegExp(`^Error: ${entry.setting} could not be saved$`), entry.setting);
    }
    assert.deepEqual(calls.onChange, []);
  });

  test('is thrown for a host with no store at all, and still calls nothing', async () => {
    const { rows, calls } = provider(undefined);
    await assert.rejects(async () => rows()[0].action(), /could not be saved$/);
    assert.deepEqual(calls.onChange, []);
  });

  test('leaves the stored value reading Off, the way it read before the press', async () => {
    const api = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    await assert.rejects(async () => provider(api).rows()[1].action(), /could not be saved$/);
    assert.equal(alertMode.readPeakAlert(api, PROVIDERS[0].id), false);
  });
});

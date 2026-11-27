'use strict';
// S4 (opencode-usage-alert): the ONE stored boolean behind the `Deepseek peak` switch and
// the S2 peak line. It lives in this package's own bridge store, `odd-worktree` →
// `alerts` → `{ deepseekPeak?: boolean }`, and reads On unless the stored value is
// exactly `false` — so a first run, a malformed document, a throwing store and a host
// with no bridge at all all leave the alert on. Nothing here loads the extension.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const alertMode = require('../lib/alert-mode.js');

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

describe('the default', () => {
  test('is On, exported, and is what a first run reads', () => {
    assert.equal(alertMode.DEFAULT_DEEPSEEK_PEAK, true);
    assert.equal(alertMode.readDeepseekPeak(fakeBridge().api), true);
  });
});

describe('reading the switch', () => {
  test('On for an absent document, for every malformed one, and for a document without the key', () => {
    assert.equal(alertMode.readDeepseekPeak(fakeBridge({ 'odd-worktree': {} }).api), true);
    for (const bad of [null, 42, 'off', [], { deepseekPeak: 'no' }, { deepseekPeak: null }, { deepseekPeak: 0 }]) {
      const { api } = fakeBridge({ 'odd-worktree': { alerts: bad } });
      assert.equal(alertMode.readDeepseekPeak(api), true, JSON.stringify(bad));
    }
    assert.equal(alertMode.readDeepseekPeak(fakeBridge({ 'odd-worktree': { alerts: { other: 1 } } }).api), true);
  });

  test('a stored false is the only thing that switches it off', () => {
    const { api } = fakeBridge({ 'odd-worktree': { alerts: { deepseekPeak: false } } });
    assert.equal(alertMode.readDeepseekPeak(api), false);
    const on = fakeBridge({ 'odd-worktree': { alerts: { deepseekPeak: true } } });
    assert.equal(alertMode.readDeepseekPeak(on.api), true);
  });

  test('no bridge, no createStore and a throwing store all read On and never throw', () => {
    for (const api of [null, undefined, {}, 42, { createStore: () => { throw new Error('disk'); } }]) {
      assert.equal(alertMode.readDeepseekPeak(api), true);
    }
    const throwing = { createStore: () => ({ get: () => { throw new Error('disk'); }, set: () => {} }) };
    assert.equal(alertMode.readDeepseekPeak(throwing), true);
  });

  test('nothing is written on a read, not even the default', () => {
    const bridge = fakeBridge();
    assert.equal(alertMode.readDeepseekPeak(bridge.api), true);
    assert.equal(alertMode.readDeepseekPeak(bridge.api), true);
    assert.deepEqual(bridge.writes, []);
    assert.equal(bridge.files.has('odd-worktree'), false, 'no document appears at load');
  });
});

describe('writing the switch', () => {
  test('Off then On round-trips, and every read answers the value just written', () => {
    const bridge = fakeBridge();
    assert.equal(alertMode.writeDeepseekPeak(bridge.api, false), true);
    assert.equal(alertMode.readDeepseekPeak(bridge.api), false);
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { deepseekPeak: false } });
    assert.equal(alertMode.writeDeepseekPeak(bridge.api, true), true);
    assert.equal(alertMode.readDeepseekPeak(bridge.api), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { deepseekPeak: true } });
  });

  test('keeps every sibling key of the store and of the alerts document', () => {
    const bridge = fakeBridge({ 'odd-worktree': { modules: { worktrees: false }, alerts: { other: 7 } } });
    assert.equal(alertMode.writeDeepseekPeak(bridge.api, false), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), {
      modules: { worktrees: false },
      alerts: { other: 7, deepseekPeak: false },
    });
  });

  test('a malformed document is replaced rather than thrown at', () => {
    const bridge = fakeBridge({ 'odd-worktree': { alerts: 'nope', other: 1 } });
    assert.equal(alertMode.writeDeepseekPeak(bridge.api, false), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { deepseekPeak: false }, other: 1 });
  });
});

describe('a write that cannot be kept', () => {
  test('reports false and never throws — a missing bridge, a throwing store, a throwing set', () => {
    for (const api of [null, undefined, {}, 42, { createStore: () => { throw new Error('disk'); } }]) {
      assert.equal(alertMode.writeDeepseekPeak(api, false), false);
    }
    const throwing = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    assert.equal(alertMode.writeDeepseekPeak(throwing, false), false);
  });

  test('a read after a refused write still answers the stored value', () => {
    const throwing = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    assert.equal(alertMode.writeDeepseekPeak(throwing, false), false);
    assert.equal(alertMode.readDeepseekPeak(throwing), true);
  });
});

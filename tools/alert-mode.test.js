'use strict';
// S5/S8 (opencode-usage-alert): the stored booleans behind the `Alert` page. ONE boolean
// per peak provider, all Off by default, in this package's own bridge store
// (`odd-worktree` → `alerts` → `{ peaks: { [providerId]: boolean } }`). An absent or
// unparsable document, a missing or throwing store, no bridge at all and an id that was
// never written all answer Off, and nothing is written until a line is touched. Nothing
// here loads the extension.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const alertMode = require('../lib/alert-mode.js');

// The two providers the registry declares today; this module is keyed by plain ids and
// does not import the registry itself.
const DEEPSEEK = 'deepseek';
const CLAUDE = 'claude';

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
  test('is Off, exported, and is what a first run reads for every provider', () => {
    assert.equal(alertMode.DEFAULT_PEAK, false);
    const { api } = fakeBridge();
    assert.equal(alertMode.readPeakAlert(api, DEEPSEEK), false);
    assert.equal(alertMode.readPeakAlert(api, CLAUDE), false);
  });

  test('the store key is exported and is the bridge document the switches share', () => {
    assert.equal(alertMode.ALERTS_KEY, 'alerts');
  });
});

describe('reading one provider', () => {
  test('Off for an absent document, for every malformed one, and for a document without `peaks`', () => {
    assert.equal(alertMode.readPeakAlert(fakeBridge({ 'odd-worktree': {} }).api, DEEPSEEK), false);
    for (const bad of [null, 42, 'off', [], { peaks: 'no' }, { peaks: 7 }, { peaks: [] }, { peaks: null }]) {
      const { api } = fakeBridge({ 'odd-worktree': { alerts: bad } });
      assert.equal(alertMode.readPeakAlert(api, DEEPSEEK), false, JSON.stringify(bad));
      assert.equal(alertMode.readPeakAlert(api, CLAUDE), false, JSON.stringify(bad));
    }
    assert.equal(alertMode.readPeakAlert(fakeBridge({ 'odd-worktree': { alerts: { other: 1 } } }).api, DEEPSEEK), false);
  });

  test('an id that was never written is Off even when a sibling is On', () => {
    const { api } = fakeBridge({ 'odd-worktree': { alerts: { peaks: { [DEEPSEEK]: true } } } });
    assert.equal(alertMode.readPeakAlert(api, DEEPSEEK), true);
    assert.equal(alertMode.readPeakAlert(api, CLAUDE), false);
    assert.equal(alertMode.readPeakAlert(api, 'anthropic'), false);
  });

  test('each provider answers its own stored boolean', () => {
    for (const peaks of [{ [DEEPSEEK]: false, [CLAUDE]: true }, { [DEEPSEEK]: true, [CLAUDE]: false }]) {
      const { api } = fakeBridge({ 'odd-worktree': { alerts: { peaks } } });
      assert.equal(alertMode.readPeakAlert(api, DEEPSEEK), peaks[DEEPSEEK], JSON.stringify(peaks));
      assert.equal(alertMode.readPeakAlert(api, CLAUDE), peaks[CLAUDE], JSON.stringify(peaks));
    }
  });

  test('no bridge, no createStore and a throwing store all read Off and never throw', () => {
    for (const api of [null, undefined, {}, 42, { createStore: () => { throw new Error('disk'); } }]) {
      assert.equal(alertMode.readPeakAlert(api, DEEPSEEK), false);
      assert.equal(alertMode.readPeakAlert(api, CLAUDE), false);
    }
    const throwing = { createStore: () => ({ get: () => { throw new Error('disk'); }, set: () => {} }) };
    assert.equal(alertMode.readPeakAlert(throwing, DEEPSEEK), false);
  });

  test('nothing is written on a read, not even the default', () => {
    const bridge = fakeBridge();
    alertMode.readPeakAlert(bridge.api, DEEPSEEK);
    alertMode.readPeakAlert(bridge.api, CLAUDE);
    assert.deepEqual(bridge.writes, []);
    assert.equal(bridge.files.has('odd-worktree'), false, 'no document appears at load');
  });
});

describe('writing one provider', () => {
  test('On then Off round-trips under `peaks`, and every read answers the value just written', () => {
    const bridge = fakeBridge();
    assert.equal(alertMode.writePeakAlert(bridge.api, DEEPSEEK, true), true);
    assert.equal(alertMode.readPeakAlert(bridge.api, DEEPSEEK), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { peaks: { [DEEPSEEK]: true } } });
    assert.equal(alertMode.writePeakAlert(bridge.api, DEEPSEEK, false), true);
    assert.equal(alertMode.readPeakAlert(bridge.api, DEEPSEEK), false);
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { peaks: { [DEEPSEEK]: false } } });
  });

  test('one provider\'s write leaves its sibling id exactly as it was', () => {
    const bridge = fakeBridge({ 'odd-worktree': { alerts: { peaks: { [CLAUDE]: true } } } });
    assert.equal(alertMode.writePeakAlert(bridge.api, DEEPSEEK, true), true);
    assert.equal(alertMode.readPeakAlert(bridge.api, DEEPSEEK), true);
    assert.equal(alertMode.readPeakAlert(bridge.api, CLAUDE), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), {
      alerts: { peaks: { [CLAUDE]: true, [DEEPSEEK]: true } },
    });
  });

  test('keeps every sibling key of the store and of the alerts document', () => {
    const bridge = fakeBridge({ 'odd-worktree': { modules: { worktrees: false }, alerts: { other: 7 } } });
    assert.equal(alertMode.writePeakAlert(bridge.api, CLAUDE, true), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), {
      modules: { worktrees: false },
      alerts: { other: 7, peaks: { [CLAUDE]: true } },
    });
  });

  test('a malformed document is replaced rather than thrown at', () => {
    const bridge = fakeBridge({ 'odd-worktree': { alerts: 'nope', other: 1 } });
    assert.equal(alertMode.writePeakAlert(bridge.api, DEEPSEEK, true), true);
    assert.deepEqual(bridge.files.get('odd-worktree'), { alerts: { peaks: { [DEEPSEEK]: true } }, other: 1 });
  });
});

describe('a write that cannot be kept', () => {
  test('reports false and never throws — a missing bridge, a throwing store, a throwing set', () => {
    for (const api of [null, undefined, {}, 42, { createStore: () => { throw new Error('disk'); } }]) {
      assert.equal(alertMode.writePeakAlert(api, DEEPSEEK, true), false);
    }
    const throwing = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    assert.equal(alertMode.writePeakAlert(throwing, CLAUDE, true), false);
  });

  test('a read after a refused write still answers Off, the way it read before the press', () => {
    const throwing = { createStore: () => ({ get: (_key, fallback) => fallback, set: () => { throw new Error('read-only'); } }) };
    assert.equal(alertMode.writePeakAlert(throwing, DEEPSEEK, true), false);
    assert.equal(alertMode.readPeakAlert(throwing, DEEPSEEK), false);
  });
});

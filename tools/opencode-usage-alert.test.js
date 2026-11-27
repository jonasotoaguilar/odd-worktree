'use strict';
// S1/S2/S4 (opencode-usage-alert): what the extension registers and draws for the two halves
// absorbed from `pi-opencode-gs`. The libs are unit-tested on their own; this suite is the
// WIRING — the exact event payload, where the row above the editor comes from, and the fact
// that the `Deepseek peak` switch withholds that row in the running session.
//
// The instant is pinned by replacing `Date.now` alone: the sync reads the clock through it,
// and every schedule function takes the instant it reasons about as an argument, so nothing
// else in the process has to be frozen.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { BRIDGE_SLOT, defaultBridge, loadExtension } = require('./fixtures/load-extension.js');

// Tuesday 02:00 UTC is inside the first peak window; 05:00 UTC is the gap between the two.
const PEAK = Date.UTC(2026, 10, 24, 2, 0, 0);
const OFF_PEAK = Date.UTC(2026, 10, 24, 5, 0, 0);

const WIDGET_KEY = 'opencode-go-peak-widget';

/** A payload the reader accepts: three known windows, each with a reset instant. */
function usagePayload() {
  const reset = '2026-11-24T09:00:00Z';
  return {
    usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: reset },
      weekly: { status: 'ok', percent: 30, resetsAt: reset },
      monthly: { status: 'ok', percent: 48, resetsAt: reset },
    },
  };
}

const OK_FETCH = async () => ({ ok: true, redirected: false, url: 'https://opencode.ai/zen/go/v1/usage', json: async () => usagePayload() });

/** A host whose widget map is captured, so a paint is observed where the human sees it. */
function capturingUi() {
  const calls = [];
  const ui = {
    setWidget(key, content, options) {
      calls.push({ key, content, options });
    },
    notify() {},
  };
  const lastFor = (key) => {
    const matching = calls.filter((call) => call.key === key);
    return matching.length === 0 ? undefined : matching[matching.length - 1];
  };
  return { ui, calls, lastFor };
}

/** A bridge whose own-store `alerts` document is the one handed in. */
async function load(alertsDocument, host) {
  const bridge = defaultBridge();
  let document = alertsDocument;
  bridge.api.createStore = () => ({
    get: (key, fallback) => (key === 'alerts' && document !== undefined ? document : fallback),
    set: (key, value) => {
      if (key === 'alerts') document = value;
    },
    delete: () => {},
  });
  const emitted = [];
  // The slot is installed BEFORE the load: the extension reads the published object once, at
  // registration, and the fixture's own default bridge only fills an empty slot.
  globalThis[BRIDGE_SLOT] = bridge.api;
  const loaded = await loadExtension({
    events: { emit: (name, payload) => emitted.push({ name, payload }) },
    ...host,
  });
  return { ...loaded, bridge, emitted, storeDocument: () => document };
}

const saved = globalThis[BRIDGE_SLOT];
afterEach(() => {
  if (saved === undefined) delete globalThis[BRIDGE_SLOT];
  else globalThis[BRIDGE_SLOT] = saved;
});

/** Run `run` with the process clock answering exactly `instant`. */
function atFixedInstant(instant, run) {
  const realNow = Date.now;
  Date.now = () => instant;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

/** The same, for work that awaits: the readiness report syncs while it is still pending. */
async function atFixedInstantAsync(instant, run) {
  const realNow = Date.now;
  Date.now = () => instant;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

describe('the OpenCode Go usage source', () => {
  test('registers one payload with the four contract keys, at load and at every session start', async () => {
    const { emitted, hooks } = await load(undefined);
    const starts = hooks.filter(([name]) => name === 'session_start').length;
    assert.ok(starts > 0, 'the extension observes session starts');
    const registrations = emitted.filter((entry) => entry.name === 'gentle-pi:usage-source/v1');
    assert.equal(registrations.length, 1, 'one source per load, before any session starts');
    const payload = registrations[0].payload;
    assert.deepEqual(Object.keys(payload).sort(), ['fetch', 'pendingNote', 'provider', 'schema']);
    assert.equal(payload.schema, 'gentle-pi.usage-source/v1');
    assert.equal(payload.provider, 'opencode-go');
    assert.equal(payload.pendingNote, 'opencode-go · press r to fetch');
    assert.equal(typeof payload.fetch, 'function');
  });

  test('the fetch carries the peak schedule in its plan field, off-peak included', async () => {
    const { emitted } = await load(undefined);
    const source = emitted.find((entry) => entry.name === 'gentle-pi:usage-source/v1').payload;
    const peak = await source.fetch('key', OK_FETCH, PEAK);
    const off = await source.fetch('key', OK_FETCH, OFF_PEAK);
    assert.match(peak.plan, /^peak /);
    assert.match(off.plan, /^off-peak /);
    assert.deepEqual(
      peak.limits[0].windows.map((window) => window.label),
      ['5h', 'week', 'month'],
      'the panel rows keep their plain window names',
    );
  });

  test('only a missing key marks the provider unreadable', async () => {
    const { emitted } = await load(undefined);
    const source = emitted.find((entry) => entry.name === 'gentle-pi:usage-source/v1').payload;
    const failing = async () => ({ ok: false, status: 500, redirected: false, url: 'https://opencode.ai/zen/go/v1/usage' });
    assert.equal(await source.fetch(undefined, OK_FETCH, PEAK), undefined, 'no key, no snapshot');
    assert.equal(await source.fetch('key', failing, PEAK), undefined, 'an http failure, no snapshot');
  });
});

describe('the DeepSeek peak row', () => {
  test('is drawn over the editor while the window is peak and the provider answered', async () => {
    const { hooks, emitted } = await load(undefined);
    const { ui, lastFor } = capturingUi();
    const ctx = { ui, cwd: os.tmpdir() };
    // The session binds its seam first; the source it emits is what the shell then fetches with.
    for (const [name, hook] of hooks) if (name === 'session_start') hook({}, ctx);
    const source = emitted.filter((entry) => entry.name === 'gentle-pi:usage-source/v1').pop().payload;
    await atFixedInstantAsync(PEAK, () => source.fetch('key', OK_FETCH, PEAK));
    const paint = lastFor(WIDGET_KEY);
    assert.ok(paint, 'the row is painted at all');
    assert.equal(paint.options.placement, 'aboveEditor');
    assert.ok(Array.isArray(paint.content) && paint.content.length === 1, 'one line, not a block');
    assert.match(paint.content[0], /peak/);
    assert.match(paint.content[0], /until /);
  });

  test('is absent off-peak, and absent before any fetch proved the provider', async () => {
    const { hooks, emitted } = await load(undefined);
    const { ui, lastFor } = capturingUi();
    const ctx = { ui, cwd: os.tmpdir() };
    for (const [name, hook] of hooks) if (name === 'session_start') hook({}, ctx);
    const source = emitted.filter((entry) => entry.name === 'gentle-pi:usage-source/v1').pop().payload;
    // The answer proves the provider readable; the clock is what says the window has closed.
    await atFixedInstantAsync(OFF_PEAK, () => source.fetch('key', OK_FETCH, PEAK));
    assert.equal(lastFor(WIDGET_KEY).content, undefined, 'off-peak owns no row at all');

    const fresh = await load(undefined);
    const second = capturingUi();
    for (const [name, hook] of fresh.hooks) {
      if (name === 'session_start') hook({}, { ui: second.ui, cwd: os.tmpdir() });
    }
    assert.equal(second.lastFor(WIDGET_KEY).content, undefined, 'no proof of a key, no row');
  });

  test('the Alert page is one provider on its own category, placed after Notifications', async () => {
    const { bridge } = await load(undefined);
    const alerts = bridge.rows.filter((provider) => provider.category === 'Alert');
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].categoryPlacement, { after: 'Notifications' });
    const rows = alerts[0].rows({});
    assert.deepEqual(
      rows.map((row) => `${row.choice.setting} ${row.choice.value}`),
      ['Deepseek peak Off', 'Deepseek peak On'],
    );
  });

  test('Off withholds the row in the running session, and On brings it back', async () => {
    const { hooks, bridge, emitted, storeDocument } = await load(undefined);
    const alerts = bridge.rows.find((provider) => provider.category === 'Alert');
    const { ui, lastFor } = capturingUi();
    const ctx = { ui, cwd: os.tmpdir() };
    for (const [name, hook] of hooks) if (name === 'session_start') hook({}, ctx);
    const source = emitted.filter((entry) => entry.name === 'gentle-pi:usage-source/v1').pop().payload;
    await atFixedInstantAsync(PEAK, () => source.fetch('key', OK_FETCH, PEAK));

    const off = alerts.rows({}).find((row) => row.choice.value === 'Off');
    atFixedInstant(PEAK, () => off.action({}));
    assert.equal(storeDocument().deepseekPeak, false, 'the choice is persisted');
    assert.equal(lastFor(WIDGET_KEY).content, undefined, 'Off withholds the row at once');

    const on = alerts.rows({}).find((row) => row.choice.value === 'On');
    atFixedInstant(PEAK, () => on.action({}));
    const paint = lastFor(WIDGET_KEY);
    assert.equal(storeDocument().deepseekPeak, true);
    assert.ok(Array.isArray(paint.content), 'On restores the row with no /reload and no new session');
  });

});

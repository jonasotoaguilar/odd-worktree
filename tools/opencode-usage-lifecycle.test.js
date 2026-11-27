'use strict';
'use strict';
// S2 (opencode-usage-alert): the LIFECYCLE of the peak row's one timer, written against the
// independent verification of `c41914c` — the timer reaches the window boundary and stops there
// (a fired timer at the exact off-peak instant must already show no row), the re-arm skips the
// weekend because the schedule does, and a fetch that settles after its session ended can neither
// arm a timer nor speak for the session that replaced it.
//
// The clock and the timer table are both injected, so the cases are deterministic: `advance` fires
// every armed timer in order and moves the clock exactly to its instant, which is what a real
// boundary would do.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const { loadExtension, BRIDGE_SLOT } = require('./fixtures/load-extension.js');

const FRIDAY_END = Date.parse('2026-11-27T10:00:00Z');
const MONDAY_START = Date.parse('2026-11-30T01:00:00Z');
const PEAK = FRIDAY_END - 5000;
const WIDGET = 'opencode-go-peak-widget';
const reply = () => ({ ok: true, json: async () => ({ usage: Object.fromEntries(
  ['rolling', 'weekly', 'monthly'].map((name) => [name, {
    status: 'ok', percent: 25, resetsAt: '2026-11-30T11:25:00Z',
  }]),
) }) });

async function fixture(t) {
  const previous = [globalThis[BRIDGE_SLOT], Date.now, setTimeout, clearTimeout];
  t.after(() => { [globalThis[BRIDGE_SLOT], Date.now, global.setTimeout, global.clearTimeout] = previous; });
  const sources = [];
  const { hooks } = await loadExtension({ events: { emit(name, payload) {
    if (name === 'gentle-pi:usage-source/v1') sources.push(payload);
  } } }, { gh: false });
  let now = PEAK;
  const timers = new Set();
  Date.now = () => now;
  global.setTimeout = (fire, delay) => {
    const timer = { fire, at: now + delay, detached: false, unref() { this.detached = true; return this; } };
    timers.add(timer);
    return timer;
  };
  global.clearTimeout = (timer) => timers.delete(timer);
  const alerts = () => [...timers].filter((timer) => timer.detached);
  const rows = new Map();
  const ctx = { cwd: os.tmpdir(), hasUI: true, ui: {
    notify() {},
    setWidget(key, content) { if (content === undefined) rows.delete(key); else rows.set(key, content); },
  } };
  const event = async (name) => { for (const [type, handler] of hooks) if (type === name) await handler({}, ctx); };
  const advance = (until) => {
    for (;;) {
      const timer = alerts().sort((a, b) => a.at - b.at)[0];
      if (timer === undefined || timer.at > until) break;
      timers.delete(timer);
      now = timer.at;
      timer.fire();
    }
    now = until;
  };
  await event('session_start');
  return { alerts, rows, advance, event, source: () => sources.at(-1) };
}

test('S2: the only unref timer fires at the boundary and skips the weekend', async (t) => {
  const f = await fixture(t);
  assert.ok(await f.source().fetch('probe', reply, PEAK));
  assert.equal(f.rows.has(WIDGET), true);
  assert.deepEqual(f.alerts().map(({ at }) => at), [FRIDAY_END]);
  f.advance(FRIDAY_END);
  assert.equal(f.rows.has(WIDGET), false);
  assert.deepEqual(f.alerts().map(({ at }) => at), [MONDAY_START]);
  f.advance(MONDAY_START);
  assert.equal(f.rows.has(WIDGET), true);
  await f.event('session_shutdown');
  assert.deepEqual(f.alerts(), []);
  assert.equal(f.rows.has(WIDGET), false);
});

for (const replacement of [false, true]) {
  test(`S2: a late reply cannot revive a stopped session (replacement: ${replacement})`, async (t) => {
    const f = await fixture(t);
    let deliver;
    const stale = f.source().fetch('previous-key', () => new Promise((resolve) => { deliver = resolve; }), PEAK);
    await f.event('session_shutdown');
    if (replacement) {
      await f.event('session_start');
      assert.equal(await f.source().fetch('', () => assert.fail('missing key must not fetch'), PEAK), undefined);
    }
    deliver(reply());
    assert.ok(await stale, 'the old caller still gets its snapshot');
    assert.equal(f.rows.has(WIDGET), false);
    assert.deepEqual(f.alerts(), []);
  });
}

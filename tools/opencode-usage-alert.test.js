'use strict';
// S1/S5/S7/S8 (opencode-usage-alert): what the extension registers and draws for the halves
// absorbed from `pi-opencode-gs`. The engine and the rows are unit-tested on their own; this
// suite is the WIRING — the exact event payload, and the fact that the peak rows above the
// editor are one row per provider, gated by that provider's own switch and by its window, never
// by the model this session uses and never by a usage key.
//
// The instants are pinned by replacing `Date.now` alone: the sync reads the clock through it,
// and every schedule function takes the instant it reasons about as an argument.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { SHELL_SLOT, defaultShellApi, loadExtension } = require('./fixtures/load-extension.js');

// Tuesday, inside DeepSeek's first UTC window (01:00–04:00) and outside Claude's.
const DEEPSEEK_PEAK = Date.UTC(2026, 10, 24, 2, 0, 0);
// The same Tuesday afternoon: Claude's window in Pacific STANDARD time (13:00–19:00 UTC here),
// which is where DeepSeek is off-peak. The two windows never overlap today, which is why each
// case pins only the provider it names.
const CLAUDE_PEAK = Date.UTC(2026, 10, 24, 15, 0, 0);

const WIDGET_KEY = 'opencode-go-peak-widget';

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

/** A shell API whose own-store `alerts` document is the one handed in. */
async function load(alertsDocument) {
  const shellApi = defaultShellApi();
  let document = alertsDocument;
  shellApi.api.createStore = () => ({
    get: (key, fallback) => (key === 'alerts' && document !== undefined ? document : fallback),
    set: (key, value) => {
      if (key === 'alerts') document = value;
    },
    delete: () => {},
  });
  const emitted = [];
  // The slot is installed BEFORE the load: the extension reads the published object once, at
  // registration, and the fixture's own default shell API only fills an empty slot.
  globalThis[SHELL_SLOT] = shellApi.api;
  const loaded = await loadExtension({
    events: { emit: (name, payload) => emitted.push({ name, payload }) },
  });
  return { ...loaded, shellApi, emitted, storeDocument: () => document };
}

const saved = globalThis[SHELL_SLOT];
afterEach(() => {
  if (saved === undefined) delete globalThis[SHELL_SLOT];
  else globalThis[SHELL_SLOT] = saved;
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

/** The session boundary, at one instant, exactly as the host calls it. */
function startSessionAt(loaded, ui, instant) {
  const ctx = { ui, cwd: os.tmpdir() };
  atFixedInstant(instant, () => {
    for (const [name, hook] of loaded.hooks) if (name === 'session_start') hook({}, ctx);
  });
  return ctx;
}

const alertRowsOf = (shellApi) => shellApi.rows.find((provider) => provider.category === 'Alert');

describe('the OpenCode Go usage source', () => {
  test('registers one payload with the four contract keys', async () => {
    const { emitted } = await load(undefined);
    const registrations = emitted.filter((entry) => entry.name === 'gentle-pi:usage-source/v1');
    assert.equal(registrations.length, 1, 'one source per load');
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
    const peak = await source.fetch('key', OK_FETCH, DEEPSEEK_PEAK);
    const off = await source.fetch('key', OK_FETCH, CLAUDE_PEAK);
    assert.match(peak.plan, /^peak /);
    assert.match(off.plan, /^off-peak /);
    assert.deepEqual(
      peak.limits[0].windows.map((window) => window.label),
      ['5h', 'week', 'month'],
      'the panel rows keep their plain window names',
    );
  });

  test('a missing key never stops the source from existing', async () => {
    const { emitted } = await load(undefined);
    const source = emitted.find((entry) => entry.name === 'gentle-pi:usage-source/v1').payload;
    assert.equal(await source.fetch(undefined, OK_FETCH, DEEPSEEK_PEAK), undefined, 'no key, no snapshot');
    assert.equal(typeof source.pendingNote, 'string', 'and the panel still has its pending line');
  });
});

describe('the Alert page', () => {
  test('is one provider, one Off/On pair, in the registry order, both Off by default', async () => {
    const { shellApi } = await load(undefined);
    const alerts = alertRowsOf(shellApi);
    assert.ok(alerts, 'the page is registered');
    assert.deepEqual(alerts.categoryPlacement, { after: 'Notifications' });
    const rows = alerts.rows({});
    assert.deepEqual(
      rows.map((row) => `${row.choice.setting} ${row.choice.value}`),
      ['Deepseek peak Off', 'Deepseek peak On', 'Claude peak Off', 'Claude peak On'],
      'a first run reads Off for every provider',
    );
    assert.deepEqual(
      rows.filter((row) => row.choice.current()).map((row) => row.choice.value),
      ['Off', 'Off'],
      'no provider is On until the human says so',
    );
  });

  test('each provider reads and writes its own value, leaving the other alone', async () => {
    const { shellApi, storeDocument } = await load(undefined);
    const alerts = alertRowsOf(shellApi);
    const claudeOn = alerts.rows({}).find((row) => row.choice.setting === 'Claude peak' && row.choice.value === 'On');
    claudeOn.action({});
    assert.deepEqual(storeDocument(), { peaks: { claude: true } });
    const current = alerts.rows({}).filter((row) => row.choice.current());
    assert.deepEqual(
      current.map((row) => `${row.choice.setting} ${row.choice.value}`),
      ['Deepseek peak Off', 'Claude peak On'],
      'DeepSeek stays Off',
    );
  });
});

describe('the peak rows above the editor', () => {
  test('draw nothing while every switch is Off, whatever the clock says', async () => {
    const loaded = await load(undefined);
    const { ui, lastFor } = capturingUi();
    startSessionAt(loaded, ui, DEEPSEEK_PEAK);
    assert.equal(lastFor(WIDGET_KEY).content, undefined, 'Off owns no row');
  });

  test('one provider in peak draws exactly its own row, with no fetch and no key', async () => {
    const loaded = await load({ peaks: { claude: true } });
    const { ui, lastFor } = capturingUi();
    startSessionAt(loaded, ui, CLAUDE_PEAK);
    const paint = lastFor(WIDGET_KEY);
    assert.equal(paint.options.placement, 'aboveEditor');
    assert.equal(paint.content.length, 1, 'one row for one provider');
    assert.match(paint.content[0], /claude/);
    assert.match(paint.content[0], /until /);
  });

  test('DeepSeek and Claude are independent: each switch draws only its own row', async () => {
    const deepseek = await load({ peaks: { deepseek: true } });
    const first = capturingUi();
    startSessionAt(deepseek, first.ui, DEEPSEEK_PEAK);
    assert.equal(first.lastFor(WIDGET_KEY).content.length, 1);
    assert.match(first.lastFor(WIDGET_KEY).content[0], /2× deepseek/);
    // The same switch at Claude's instant draws nothing: a window is a window.
    atFixedInstant(CLAUDE_PEAK, () => {
      for (const [name, hook] of deepseek.hooks) {
        if (name === 'turn_end') hook({}, { ui: first.ui, cwd: os.tmpdir() });
      }
    });
    assert.equal(first.lastFor(WIDGET_KEY).content, undefined, 'DeepSeek off-peak, no row');

    const claude = await load({ peaks: { claude: true } });
    const second = capturingUi();
    startSessionAt(claude, second.ui, DEEPSEEK_PEAK);
    assert.equal(second.lastFor(WIDGET_KEY).content, undefined, 'Claude off-peak at 02:00 UTC');
    atFixedInstant(CLAUDE_PEAK, () => {
      for (const [name, hook] of claude.hooks) {
        if (name === 'turn_end') hook({}, { ui: second.ui, cwd: os.tmpdir() });
      }
    });
    assert.equal(second.lastFor(WIDGET_KEY).content.length, 1);
    assert.match(second.lastFor(WIDGET_KEY).content[0], /claude/);
  });

  test('Off withholds one row in the running session and On brings it back', async () => {
    const loaded = await load({ peaks: { deepseek: true } });
    const { shellApi, storeDocument } = loaded;
    const alerts = alertRowsOf(shellApi);
    const { ui, lastFor } = capturingUi();
    startSessionAt(loaded, ui, DEEPSEEK_PEAK);
    assert.ok(Array.isArray(lastFor(WIDGET_KEY).content));

    const off = alerts.rows({}).find((row) => row.choice.setting === 'Deepseek peak' && row.choice.value === 'Off');
    atFixedInstant(DEEPSEEK_PEAK, () => off.action({}));
    assert.equal(storeDocument().peaks.deepseek, false, 'the choice is persisted');
    assert.equal(lastFor(WIDGET_KEY).content, undefined, 'Off withholds the row at once');

    const on = alerts.rows({}).find((row) => row.choice.setting === 'Deepseek peak' && row.choice.value === 'On');
    atFixedInstant(DEEPSEEK_PEAK, () => on.action({}));
    assert.equal(storeDocument().peaks.deepseek, true);
    assert.ok(Array.isArray(lastFor(WIDGET_KEY).content), 'On restores it with no /reload');
  });

  // The two real windows never overlap today (DeepSeek 01:00–04:00 and 06:00–10:00 UTC, Claude
  // 12:00–18:00 UTC under PDT and 13:00–19:00 UTC under PST), so "two rows at once" is proved where
  // it can be: on the engine, with two providers told apart (tools/peak-schedule.test.js). What the
  // wiring owes that engine is the loop, and the case below is its shape — every provider whose own
  // switch is On contributes its own line, in the registry's order, and nothing merges them.
  test('the rows are built per provider, never merged into one line', async () => {
    const loaded = await load({ peaks: { deepseek: true, claude: true } });
    const { ui, lastFor } = capturingUi();
    startSessionAt(loaded, ui, CLAUDE_PEAK);
    const content = lastFor(WIDGET_KEY).content;
    assert.equal(content.length, 1, 'only Claude is inside its window at 15:00 UTC');
    assert.match(content[0], /^.*claude/);
    assert.doesNotMatch(content[0], /deepseek/, 'the off-peak provider is not mentioned');
    assert.equal(new Set(content).size, content.length, 'one entry per line, no duplicates');
  });
});

'use strict';
// S1 (opencode-usage-alert): the two strings this package paints for the OpenCode Go peak
// schedule — the panel's `plan` field and the one widget line above the input panel. Two
// surfaces, two different freedoms: the panel paints `plan` in its own muted role and inserts
// its own ` · `, so the field is plain text with no leading separator; the widget line paints
// itself, so only its state word is amber.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PEAK_WIDGET_KEY, panelSchedule, peakWidgetLine } = require('../lib/opencode-labels.js');
const { formatBoundaryClock, formatPeakState, peakStateAt } = require('../lib/opencode-peak.js');

const utc = (iso) => Date.parse(iso);
// 2026-09-23 is a Wednesday: 03:40 UTC is inside the first window, 04:30 UTC between windows.
const DURING_PEAK = utc('2026-09-23T03:40:00Z');
const OFF_PEAK = utc('2026-09-23T04:30:00Z');

describe('the panel schedule', () => {
  test('the panel plan is the schedule, with no colour and no leading separator of its own', () => {
    assert.equal(panelSchedule(peakStateAt(DURING_PEAK), DURING_PEAK), 'peak 20m');
    assert.equal(panelSchedule(peakStateAt(OFF_PEAK), OFF_PEAK), 'off-peak 1hr 30m');
    // The panel already prints ` · ` before the field: a leading one would render as ` ·  · `.
    for (const now of [DURING_PEAK, OFF_PEAK]) {
      const plan = panelSchedule(peakStateAt(now), now);
      assert.equal(plan.includes('\x1b['), false, plan);
      assert.equal(plan.startsWith(' '), false, plan);
      assert.equal(plan.startsWith('·'), false, plan);
      assert.equal(plan, formatPeakState(peakStateAt(now), now), 'the field is the state label verbatim');
    }
  });

  test('the schedule is the same text whatever the session model is priced at', () => {
    // The panel is unconditional: the field follows the clock, never a model choice.
    assert.equal(panelSchedule(peakStateAt(OFF_PEAK), OFF_PEAK), 'off-peak 1hr 30m');
    // Friday 10:30 UTC is off-peak until Monday 01:00 UTC; above a day the countdown is whole hours.
    assert.equal(
      panelSchedule(peakStateAt(utc('2026-09-25T10:30:00Z')), utc('2026-09-25T10:30:00Z')),
      'off-peak 2d 14hr',
    );
  });
});

describe('the widget line', () => {
  test('the key is the one this package owns in pi\'s widget map', () => {
    assert.equal(PEAK_WIDGET_KEY, 'opencode-go-peak-widget');
    assert.equal(typeof PEAK_WIDGET_KEY, 'string');
  });

  test('one amber state word, the 2x note, then the boundary in the machine timezone', () => {
    const state = peakStateAt(DURING_PEAK);
    const boundary = formatBoundaryClock(state.until, DURING_PEAK);
    const line = peakWidgetLine(state, DURING_PEAK);
    assert.equal(line, `\x1b[33mpeak\x1b[0m · 2× deepseek · until ${boundary}`);
    // The amber closes right after the state word, so the details stay in the terminal's own
    // foreground instead of inheriting a dimmed amber.
    assert.equal(line.indexOf('\x1b[0m'), `\x1b[33mpeak`.length);
    assert.equal(line.slice(`\x1b[33mpeak\x1b[0m`.length).includes('\x1b'), false, 'no further escape');
    assert.equal(line.includes('\n'), false, 'one line');
  });

  test('there is no off-peak variant of the line: the caller clears the widget instead', () => {
    // Whatever the state object says, the widget text is the peak line; gating is the caller's.
    const line = peakWidgetLine(peakStateAt(OFF_PEAK), OFF_PEAK);
    assert.match(line, /^\x1b\[33mpeak\x1b\[0m · 2× deepseek · until /);
  });
});

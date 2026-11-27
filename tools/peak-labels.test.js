'use strict';
// S1/S5/S7 (opencode-usage-alert): the two strings this package paints for a peak schedule — the
// panel's `plan` field and one widget line per peaking provider. Two surfaces, two different
// freedoms: the panel paints `plan` in its own muted role and inserts its own ` · `, so the field
// is plain text with no leading separator; the widget line paints itself, so only its state word
// is amber. The line carries the provider's own label and nothing invented: DeepSeek's published
// `2×` price multiplier is in its label, Claude has none because Anthropic publishes none.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PEAK_WIDGET_KEY, panelSchedule, peakWidgetLine } = require('../lib/peak-labels.js');
const { providerById } = require('../lib/peak-providers.js');
const { formatBoundaryClock, formatPeakState, peakStateFor } = require('../lib/peak-schedule.js');

const DEEPSEEK = providerById('deepseek');
const CLAUDE = providerById('claude');

const utc = (iso) => Date.parse(iso);
// 2026-09-23 is a Wednesday: 03:40 UTC is inside DeepSeek's first window, 04:30 UTC between them.
const DURING_PEAK = utc('2026-09-23T03:40:00Z');
const OFF_PEAK = utc('2026-09-23T04:30:00Z');
// 2026-07-15 is a Wednesday: 12:30 UTC is 05:30 PDT, inside Claude's window.
const CLAUDE_PEAK = utc('2026-07-15T12:30:00Z');

describe('the panel schedule', () => {
  test('the panel plan is the schedule, with no colour and no leading separator of its own', () => {
    assert.equal(panelSchedule(peakStateFor(DEEPSEEK, DURING_PEAK), DURING_PEAK), 'peak 20m');
    assert.equal(panelSchedule(peakStateFor(DEEPSEEK, OFF_PEAK), OFF_PEAK), 'off-peak 1hr 30m');
    // The panel already prints ` · ` before the field: a leading one would render as ` ·  · `.
    for (const [provider, now] of [
      [DEEPSEEK, DURING_PEAK],
      [DEEPSEEK, OFF_PEAK],
      [CLAUDE, CLAUDE_PEAK],
    ]) {
      const plan = panelSchedule(peakStateFor(provider, now), now);
      assert.equal(plan.includes('\x1b['), false, plan);
      assert.equal(plan.startsWith(' '), false, plan);
      assert.equal(plan.startsWith('·'), false, plan);
      assert.equal(plan, formatPeakState(peakStateFor(provider, now), now), 'the field is the state label verbatim');
    }
  });

  test('the schedule is the same text whatever the session model is priced at', () => {
    // The panel is unconditional: the field follows the clock, never a model choice.
    assert.equal(panelSchedule(peakStateFor(DEEPSEEK, OFF_PEAK), OFF_PEAK), 'off-peak 1hr 30m');
    // Friday 10:30 UTC is off-peak until Monday 01:00 UTC; above a day the countdown is whole hours.
    assert.equal(
      panelSchedule(peakStateFor(DEEPSEEK, utc('2026-09-25T10:30:00Z')), utc('2026-09-25T10:30:00Z')),
      'off-peak 2d 14hr',
    );
  });
});

describe('the widget line', () => {
  test("the key is the one this package owns in pi's widget map", () => {
    assert.equal(PEAK_WIDGET_KEY, 'opencode-go-peak-widget');
    assert.equal(typeof PEAK_WIDGET_KEY, 'string');
  });

  test('one amber state word, the provider label, then the boundary in the machine timezone', () => {
    const state = peakStateFor(DEEPSEEK, DURING_PEAK);
    const boundary = formatBoundaryClock(state.until, DURING_PEAK);
    const line = peakWidgetLine(DEEPSEEK, state, DURING_PEAK);
    assert.equal(line, `\x1b[33mpeak\x1b[0m · 2× deepseek · until ${boundary}`);
    // The amber closes right after the state word, so the details stay in the terminal's own
    // foreground instead of inheriting a dimmed amber.
    assert.equal(line.indexOf('\x1b[0m'), `\x1b[33mpeak`.length);
    assert.equal(line.slice(`\x1b[33mpeak\x1b[0m`.length).includes('\x1b'), false, 'no further escape');
    assert.equal(line.includes('\n'), false, 'one line');
  });

  test('the Claude line carries Claude\'s own label and no invented multiplier', () => {
    const state = peakStateFor(CLAUDE, CLAUDE_PEAK);
    const boundary = formatBoundaryClock(state.until, CLAUDE_PEAK);
    const line = peakWidgetLine(CLAUDE, state, CLAUDE_PEAK);
    assert.equal(line, `\x1b[33mpeak\x1b[0m · claude · until ${boundary}`);
    assert.equal(line.includes('2×'), false, 'Anthropic publishes no multiplier for the window');
    assert.equal(line.indexOf('\x1b[0m'), `\x1b[33mpeak`.length);
    assert.equal(line.slice(`\x1b[33mpeak\x1b[0m`.length).includes('\x1b'), false, 'no further escape');
    assert.equal(line.includes('\n'), false, 'one line');
  });

  test('two providers peaking at once draw two lines, in the registry order, each with its label', () => {
    const until = utc('2026-09-23T04:00:00Z');
    const lines = [DEEPSEEK, CLAUDE].map((provider) =>
      peakWidgetLine(provider, { kind: 'peak', until }, DURING_PEAK),
    );
    assert.equal(lines.length, 2, 'one row per peaking provider, never one merged row');
    const clock = formatBoundaryClock(until, DURING_PEAK);
    assert.deepEqual(lines, [
      `\x1b[33mpeak\x1b[0m · 2× deepseek · until ${clock}`,
      `\x1b[33mpeak\x1b[0m · claude · until ${clock}`,
    ]);
    assert.equal(
      lines[0].endsWith(`until ${clock}`),
      true,
      'the rows differ only by the provider they name',
    );
  });

  test('there is no off-peak variant of the line: the caller clears the widget instead', () => {
    // Whatever the state object says, the widget text is the peak line; gating is the caller's.
    for (const [provider, now] of [
      [DEEPSEEK, OFF_PEAK],
      [CLAUDE, utc('2026-07-15T18:00:00Z')],
    ]) {
      const line = peakWidgetLine(provider, peakStateFor(provider, now), now);
      assert.equal(line.startsWith('\x1b[33mpeak\x1b[0m · '), true, line);
    }
  });
});

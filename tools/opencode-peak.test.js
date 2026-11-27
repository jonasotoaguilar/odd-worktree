'use strict';
// S1 (opencode-usage-alert): OpenCode Go's DeepSeek pricing schedule. Both peak windows are
// published in UTC and only on weekdays, and nothing here reads a clock: every function takes
// the instant it must reason about, so these cases pin the schedule without freezing time.
// 2026-09-23 is a Wednesday, 2026-09-25 a Friday, 2026-09-26 a Saturday, 2026-09-28 a Monday.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  deepseekPeakPricing,
  formatBoundaryClock,
  formatCountdown,
  formatPeakState,
  nextTransition,
  peakStateAt,
} = require('../lib/opencode-peak.js');

const utc = (iso) => Date.parse(iso);

describe('the peak schedule', () => {
  test('both published windows are peak on a weekday', () => {
    for (const iso of ['2026-09-23T01:00:00Z', '2026-09-23T02:30:00Z', '2026-09-23T03:59:59Z']) {
      assert.equal(peakStateAt(utc(iso)).kind, 'peak', iso);
    }
    for (const iso of ['2026-09-23T06:00:00Z', '2026-09-23T08:15:00Z', '2026-09-23T09:59:59Z']) {
      assert.equal(peakStateAt(utc(iso)).kind, 'peak', iso);
    }
  });

  test('window bounds are half-open: a window starts on its first second and ends at its last', () => {
    assert.equal(peakStateAt(utc('2026-09-23T00:59:59Z')).kind, 'off-peak');
    assert.equal(peakStateAt(utc('2026-09-23T04:00:00Z')).kind, 'off-peak');
    assert.equal(peakStateAt(utc('2026-09-23T05:59:59Z')).kind, 'off-peak');
    assert.equal(peakStateAt(utc('2026-09-23T10:00:00Z')).kind, 'off-peak');
  });

  test('weekends are off-peak all day', () => {
    for (const iso of [
      '2026-09-26T02:00:00Z',
      '2026-09-26T08:00:00Z',
      '2026-09-27T02:00:00Z',
      '2026-09-27T08:00:00Z',
    ]) {
      assert.equal(peakStateAt(utc(iso)).kind, 'off-peak', iso);
    }
  });

  test('the boundary it reports is the end of the current state, in both directions', () => {
    const duringPeak = peakStateAt(utc('2026-09-23T03:40:00Z'));
    assert.deepEqual(duringPeak, { kind: 'peak', until: utc('2026-09-23T04:00:00Z') }, 'peak ends at its window close');

    const duringSecondPeak = peakStateAt(utc('2026-09-23T09:45:00Z'));
    assert.equal(duringSecondPeak.until, utc('2026-09-23T10:00:00Z'));

    const betweenWindows = peakStateAt(utc('2026-09-23T04:30:00Z'));
    assert.deepEqual(
      betweenWindows,
      { kind: 'off-peak', until: utc('2026-09-23T06:00:00Z') },
      'the next window is the boundary',
    );

    const beforeAnyWindow = peakStateAt(utc('2026-09-23T00:30:00Z'));
    assert.equal(beforeAnyWindow.until, utc('2026-09-23T01:00:00Z'));
  });

  test('the boundary crosses into the next weekday, skipping the weekend', () => {
    // Friday 10:30 UTC is off-peak until Monday 01:00 UTC; nothing peaks over the weekend.
    assert.deepEqual(peakStateAt(utc('2026-09-25T10:30:00Z')), {
      kind: 'off-peak',
      until: utc('2026-09-28T01:00:00Z'),
    });
    // Sunday evening is off-peak until Monday 01:00 UTC.
    assert.deepEqual(peakStateAt(utc('2026-09-27T23:00:00Z')), {
      kind: 'off-peak',
      until: utc('2026-09-28T01:00:00Z'),
    });
    // Friday's second window ends at 10:00 and the next peak is Monday 01:00.
    assert.deepEqual(peakStateAt(utc('2026-09-25T09:00:00Z')), {
      kind: 'peak',
      until: utc('2026-09-25T10:00:00Z'),
    });
  });

  test('nextTransition is the same boundary the state reports', () => {
    for (const iso of [
      '2026-09-23T00:30:00Z',
      '2026-09-23T03:40:00Z',
      '2026-09-23T04:30:00Z',
      '2026-09-25T10:30:00Z',
      '2026-09-27T23:00:00Z',
    ]) {
      assert.equal(nextTransition(utc(iso)), peakStateAt(utc(iso)).until, iso);
    }
  });

  test('an instant that cannot be read is off-peak with no boundary', () => {
    assert.deepEqual(peakStateAt(Number.NaN), { kind: 'off-peak', until: 0 });
    assert.deepEqual(peakStateAt(Number.POSITIVE_INFINITY), { kind: 'off-peak', until: 0 });
  });
});

describe('the countdown', () => {
  test('countdowns are compact, hour-based and never round down to zero', () => {
    assert.equal(formatCountdown(0), 'now');
    assert.equal(formatCountdown(-5_000), 'now');
    assert.equal(formatCountdown(30_000), '1m');
    assert.equal(formatCountdown(20 * 60_000), '20m');
    assert.equal(formatCountdown(59 * 60_000 + 30_000), '1hr');
    assert.equal(formatCountdown(80 * 60_000), '1hr 20m');
    assert.equal(formatCountdown(3 * 3_600_000 + 20 * 60_000), '3hr 20m');
    assert.equal(formatCountdown(5 * 3_600_000), '5hr');
    assert.equal(formatCountdown(22 * 3_600_000), '22hr');
    assert.equal(formatCountdown(2 * 86_400_000 + 3 * 3_600_000), '2d 3hr');
    assert.equal(formatCountdown(86_400_000 + 19 * 3_600_000), '1d 19hr');
  });

  test('an unreadable remaining time is "now"', () => {
    assert.equal(formatCountdown(Number.NaN), 'now');
    assert.equal(formatCountdown(Number.POSITIVE_INFINITY), 'now');
  });
});

describe('the state label', () => {
  test('the state label names the schedule and the time left in it, with no word between', () => {
    const duringPeak = utc('2026-09-23T03:40:00Z');
    assert.equal(formatPeakState(peakStateAt(duringPeak), duringPeak), 'peak 20m');
    const offPeak = utc('2026-09-23T04:30:00Z');
    assert.equal(formatPeakState(peakStateAt(offPeak), offPeak), 'off-peak 1hr 30m');
    // The asked-for literals, from states the schedule itself can reach.
    assert.equal(
      formatPeakState({ kind: 'off-peak', until: offPeak + 3 * 3_600_000 + 20 * 60_000 }, offPeak),
      'off-peak 3hr 20m',
    );
    assert.equal(
      formatPeakState({ kind: 'off-peak', until: offPeak + 86_400_000 + 19 * 3_600_000 }, offPeak),
      'off-peak 1d 19hr',
    );
    assert.equal(formatPeakState({ kind: 'peak', until: duringPeak + 5 * 3_600_000 }, duringPeak), 'peak 5hr');
    // The countdown is joined to the state by a single space and nothing else.
    for (const label of ['peak 20m', 'off-peak 1hr 30m', 'off-peak 3hr 20m', 'off-peak 1d 19hr', 'peak 5hr']) {
      assert.equal(label.includes('change'), false, label);
      assert.equal(label.includes(' \u00b7 '), false, label);
    }
  });
});

describe('the boundary clock', () => {
  test('the boundary clock is a 24h local time, weekday-prefixed across a date, and "now" when unknown', () => {
    const duringPeak = utc('2026-09-23T03:40:00Z');
    // Same local date: just the clock.
    assert.equal(formatBoundaryClock(utc('2026-09-23T04:00:00Z'), duringPeak, 'UTC'), '04:00');
    // A different local date carries the short en-US weekday.
    const friday = utc('2026-09-25T10:30:00Z');
    assert.equal(formatBoundaryClock(utc('2026-09-28T01:00:00Z'), friday, 'UTC'), 'Mon 01:00');
    // Without a boundary there is nothing to show.
    assert.equal(formatBoundaryClock(Number.NaN, duringPeak, 'UTC'), 'now');
    assert.equal(formatBoundaryClock(Number.POSITIVE_INFINITY, duringPeak, 'UTC'), 'now');
    assert.equal(formatBoundaryClock(utc('2026-09-23T04:00:00Z'), Number.NaN, 'UTC'), 'now');
  });
});

describe('the peak-priced family', () => {
  test('the peak-priced DeepSeek family is recognised whatever provider serves it', () => {
    assert.equal(deepseekPeakPricing('deepseek-v4.1-flash'), true);
    assert.equal(deepseekPeakPricing('deepseek-v4-pro'), true);
    // Spelling drift in the ids is tolerated; the pricing, not the spelling, is the contract.
    assert.equal(deepseekPeakPricing('deepseek-v4-flash'), true);
    assert.equal(deepseekPeakPricing('deepseek-v4.1-flash-high'), true);
    assert.equal(deepseekPeakPricing('kimi-k2'), false);
    assert.equal(deepseekPeakPricing(undefined), false);
  });
});

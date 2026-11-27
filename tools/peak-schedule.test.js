'use strict';
// S5/S7 (opencode-usage-alert): the zone-aware peak engine. DeepSeek's windows are published in
// UTC, Claude's in Pacific time, so the engine reads `zone`, `windows` and `weekdaysOnly` from
// the registry entry it is handed and is otherwise provider-agnostic: a third provider needs no
// change here. Windows are half-open, weekdays are the provider's OWN weekdays, and nothing
// reads a clock — every function takes the instant it must reason about.
//
// The dates below are all 2026 and are the whole point of the zone parameter:
//   09-23 Wed, 09-25 Fri, 09-26 Sat, 09-27 Sun, 09-28 Mon  — DeepSeek's UTC week
//   07-15 Wed, 07-17 Fri, 07-18 Sat, 07-19 Sun, 07-20 Mon  — Claude under PDT (UTC-7)
//   01-14 Wed, 01-17 Sat                                   — Claude under PST (UTC-8)
//   03-06 Fri, 03-09 Mon                                   — across the PST->PDT switch on 03-08
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  earliestUntil,
  formatBoundaryClock,
  formatCountdown,
  formatPeakState,
  nextTransitionFor,
  peakStateFor,
} = require('../lib/peak-schedule.js');
const { providerById } = require('../lib/peak-providers.js');

const DEEPSEEK = providerById('deepseek');
const CLAUDE = providerById('claude');

const utc = (iso) => Date.parse(iso);

// A provider the registry does not declare: the engine is generic, so a future window is a
// plain object here and no code below has to know about it.
const TOKYO = {
  id: 'third',
  setting: 'Third peak',
  label: 'third',
  zone: 'Asia/Tokyo',
  windows: [[9, 17]],
  weekdaysOnly: true,
};
const ALWAYS = {
  id: 'always',
  setting: 'Always peak',
  label: 'always',
  zone: 'UTC',
  windows: [[0, 12]],
  weekdaysOnly: false,
};

describe('the DeepSeek schedule, published in UTC', () => {
  test('both published windows are peak on a weekday', () => {
    for (const iso of ['2026-09-23T01:00:00Z', '2026-09-23T02:30:00Z', '2026-09-23T03:59:59Z']) {
      assert.equal(peakStateFor(DEEPSEEK, utc(iso)).kind, 'peak', iso);
    }
    for (const iso of ['2026-09-23T06:00:00Z', '2026-09-23T08:15:00Z', '2026-09-23T09:59:59Z']) {
      assert.equal(peakStateFor(DEEPSEEK, utc(iso)).kind, 'peak', iso);
    }
  });

  test('window bounds are half-open: a window starts on its first second and ends at its last', () => {
    assert.equal(peakStateFor(DEEPSEEK, utc('2026-09-23T00:59:59Z')).kind, 'off-peak');
    assert.equal(peakStateFor(DEEPSEEK, utc('2026-09-23T04:00:00Z')).kind, 'off-peak');
    assert.equal(peakStateFor(DEEPSEEK, utc('2026-09-23T05:59:59Z')).kind, 'off-peak');
    assert.equal(peakStateFor(DEEPSEEK, utc('2026-09-23T10:00:00Z')).kind, 'off-peak');
  });

  test('weekends are off-peak all day', () => {
    for (const iso of [
      '2026-09-26T02:00:00Z',
      '2026-09-26T08:00:00Z',
      '2026-09-27T02:00:00Z',
      '2026-09-27T08:00:00Z',
    ]) {
      assert.equal(peakStateFor(DEEPSEEK, utc(iso)).kind, 'off-peak', iso);
    }
  });

  test('the reported boundary is the end of the current state, in both directions', () => {
    const duringPeak = peakStateFor(DEEPSEEK, utc('2026-09-23T03:40:00Z'));
    assert.deepEqual(
      duringPeak,
      { kind: 'peak', until: utc('2026-09-23T04:00:00Z') },
      'peak ends at its window close',
    );

    assert.equal(peakStateFor(DEEPSEEK, utc('2026-09-23T09:45:00Z')).until, utc('2026-09-23T10:00:00Z'));

    assert.deepEqual(
      peakStateFor(DEEPSEEK, utc('2026-09-23T04:30:00Z')),
      { kind: 'off-peak', until: utc('2026-09-23T06:00:00Z') },
      'the next window is the boundary',
    );

    assert.equal(peakStateFor(DEEPSEEK, utc('2026-09-23T00:30:00Z')).until, utc('2026-09-23T01:00:00Z'));
  });

  test('the boundary crosses into the next weekday, skipping the weekend', () => {
    // Friday 10:30 UTC is off-peak until Monday 01:00 UTC; nothing peaks over the weekend.
    assert.deepEqual(peakStateFor(DEEPSEEK, utc('2026-09-25T10:30:00Z')), {
      kind: 'off-peak',
      until: utc('2026-09-28T01:00:00Z'),
    });
    // Sunday evening is off-peak until Monday 01:00 UTC.
    assert.deepEqual(peakStateFor(DEEPSEEK, utc('2026-09-27T23:00:00Z')), {
      kind: 'off-peak',
      until: utc('2026-09-28T01:00:00Z'),
    });
    // Friday's second window ends at 10:00 and the next peak is Monday 01:00.
    assert.deepEqual(peakStateFor(DEEPSEEK, utc('2026-09-25T09:00:00Z')), {
      kind: 'peak',
      until: utc('2026-09-25T10:00:00Z'),
    });
  });
});

describe('the Claude schedule, published in Pacific time', () => {
  test('in July the window is 05:00-11:00 PDT, which is 12:00-18:00 UTC', () => {
    assert.equal(localClock(utc('2026-07-15T12:00:00Z'), 'America/Los_Angeles'), '05:00', 'PDT start');
    assert.equal(peakStateFor(CLAUDE, utc('2026-07-15T12:00:00Z')).kind, 'peak', '12:00 UTC starts it');
    assert.equal(peakStateFor(CLAUDE, utc('2026-07-15T12:30:00Z')).kind, 'peak');
    assert.equal(peakStateFor(CLAUDE, utc('2026-07-15T17:59:59.999Z')).kind, 'peak');
    assert.equal(peakStateFor(CLAUDE, utc('2026-07-15T11:59:59.999Z')).kind, 'off-peak', 'a hair early');
    assert.equal(peakStateFor(CLAUDE, utc('2026-07-15T18:00:00Z')).kind, 'off-peak', '18:00 UTC ends it');
  });

  test('in January the same window is 05:00-11:00 PST, which is 13:00-19:00 UTC', () => {
    assert.equal(localClock(utc('2026-01-14T13:00:00Z'), 'America/Los_Angeles'), '05:00', 'PST start');
    assert.equal(peakStateFor(CLAUDE, utc('2026-01-14T13:00:00Z')).kind, 'peak', '13:00 UTC starts it');
    assert.equal(peakStateFor(CLAUDE, utc('2026-01-14T18:59:59.999Z')).kind, 'peak');
    assert.equal(peakStateFor(CLAUDE, utc('2026-01-14T12:59:59.999Z')).kind, 'off-peak', 'a hair early');
    assert.equal(peakStateFor(CLAUDE, utc('2026-01-14T19:00:00Z')).kind, 'off-peak', '19:00 UTC ends it');
  });

  test('the wall clock is what is fixed: the UTC edges move an hour with the offset', () => {
    // The July and January windows start at the same local clock and an hour apart in UTC. That
    // hour is the entire reason the engine carries a zone instead of adding another UTC pair.
    const summerStart = peakStateFor(CLAUDE, utc('2026-07-15T12:00:00Z')).until;
    const winterStart = peakStateFor(CLAUDE, utc('2026-01-14T13:00:00Z')).until;
    assert.equal(summerStart, utc('2026-07-15T18:00:00Z'));
    assert.equal(winterStart, utc('2026-01-14T19:00:00Z'));
    assert.equal(utc('2026-01-14T19:00:00Z') - utc('2026-01-14T13:00:00Z'), 6 * 3_600_000, 'same length');
    assert.equal(utc('2026-07-15T18:00:00Z') - utc('2026-07-15T12:00:00Z'), 6 * 3_600_000, 'same length');
  });

  test('weekends are off-peak for Claude too, under both offsets', () => {
    for (const iso of [
      '2026-07-18T12:00:00Z', // Saturday 05:00 PDT: the window's own start, on a Saturday
      '2026-07-18T16:00:00Z',
      '2026-07-19T17:00:00Z', // Sunday 10:00 PDT
      '2026-01-17T13:00:00Z', // Saturday 05:00 PST
      '2026-01-17T18:30:00Z',
      '2026-01-18T15:00:00Z',
    ]) {
      assert.equal(peakStateFor(CLAUDE, utc(iso)).kind, 'off-peak', iso);
    }
  });

  test('the boundary crosses the Pacific weekend, not the UTC one', () => {
    // Friday 11:00 PDT: the window is over and the next one is Monday 05:00 PDT = 12:00 UTC.
    assert.deepEqual(peakStateFor(CLAUDE, utc('2026-07-17T18:00:00Z')), {
      kind: 'off-peak',
      until: utc('2026-07-20T12:00:00Z'),
    });
    // Sunday evening in Pacific time is off-peak until that same Monday start.
    assert.deepEqual(peakStateFor(CLAUDE, utc('2026-07-19T23:00:00Z')), {
      kind: 'off-peak',
      until: utc('2026-07-20T12:00:00Z'),
    });
    // Friday's own window still ends on Friday.
    assert.deepEqual(peakStateFor(CLAUDE, utc('2026-07-17T16:00:00Z')), {
      kind: 'peak',
      until: utc('2026-07-17T18:00:00Z'),
    });
  });

  test('the boundary follows the DST switch, so the same wall clock answers a different instant', () => {
    // 2026-03-08 is the PST->PDT switch. Friday 03-06 11:00 PST is 19:00 UTC; the next window is
    // Monday 03-09 05:00 PDT, which is 12:00 UTC — the same 05:00 wall clock, one hour earlier.
    assert.deepEqual(peakStateFor(CLAUDE, utc('2026-03-06T19:00:00Z')), {
      kind: 'off-peak',
      until: utc('2026-03-09T12:00:00Z'),
    });
    assert.equal(localClock(utc('2026-03-06T19:00:00Z'), 'America/Los_Angeles'), '11:00', 'still PST');
    assert.equal(localClock(utc('2026-03-09T12:00:00Z'), 'America/Los_Angeles'), '05:00', 'now PDT');
    // The window before the switch ends an hour later in UTC than the one after it.
    assert.equal(peakStateFor(CLAUDE, utc('2026-03-05T14:00:00Z')).until, utc('2026-03-05T19:00:00Z'));
    assert.equal(peakStateFor(CLAUDE, utc('2026-03-10T13:00:00Z')).until, utc('2026-03-10T18:00:00Z'));
  });

  test('the two providers keep their own windows, so both can be told apart at one instant', () => {
    const claudeOnly = utc('2026-07-15T12:00:00Z');
    assert.equal(peakStateFor(CLAUDE, claudeOnly).kind, 'peak');
    assert.equal(peakStateFor(DEEPSEEK, claudeOnly).kind, 'off-peak');

    const deepseekOnly = utc('2026-09-23T02:00:00Z');
    assert.equal(peakStateFor(DEEPSEEK, deepseekOnly).kind, 'peak');
    assert.equal(peakStateFor(CLAUDE, deepseekOnly).kind, 'off-peak');
  });
});

describe('the transition search', () => {
  test('nextTransitionFor is the same boundary the state reports, for both providers', () => {
    for (const [provider, iso] of [
      [DEEPSEEK, '2026-09-23T00:30:00Z'],
      [DEEPSEEK, '2026-09-23T03:40:00Z'],
      [DEEPSEEK, '2026-09-23T04:30:00Z'],
      [DEEPSEEK, '2026-09-25T10:30:00Z'],
      [DEEPSEEK, '2026-09-27T23:00:00Z'],
      [CLAUDE, '2026-07-15T11:30:00Z'],
      [CLAUDE, '2026-07-15T12:00:00Z'],
      [CLAUDE, '2026-07-17T18:00:00Z'],
      [CLAUDE, '2026-07-19T23:00:00Z'],
      [CLAUDE, '2026-01-14T13:00:00Z'],
      [CLAUDE, '2026-03-06T19:00:00Z'],
    ]) {
      assert.equal(nextTransitionFor(provider, utc(iso)), peakStateFor(provider, utc(iso)).until, iso);
    }
  });

  test('a weekend candidate is not a transition: the state across it is unchanged', () => {
    // Saturday's own 05:00 Pacific edge is a candidate, but the predicate is off-peak on both
    // sides of it, so the Friday boundary must survive it.
    const fridayEvening = utc('2026-07-17T18:00:00Z');
    const saturdayEdge = utc('2026-07-18T12:00:00Z');
    assert.equal(peakStateFor(CLAUDE, saturdayEdge - 1).kind, 'off-peak');
    assert.equal(peakStateFor(CLAUDE, saturdayEdge).kind, 'off-peak');
    assert.equal(nextTransitionFor(CLAUDE, fridayEvening), utc('2026-07-20T12:00:00Z'));

    const deepseekSaturday = utc('2026-09-26T01:00:00Z');
    assert.deepEqual(peakStateFor(DEEPSEEK, deepseekSaturday), {
      kind: 'off-peak',
      until: utc('2026-09-28T01:00:00Z'),
    });
  });

  test('a boundary instant belongs to the NEXT state, half-open', () => {
    for (const [provider, boundary, before, after] of [
      [DEEPSEEK, '2026-09-23T04:00:00Z', 'peak', 'off-peak'],
      [DEEPSEEK, '2026-09-23T06:00:00Z', 'off-peak', 'peak'],
      [CLAUDE, '2026-07-15T12:00:00Z', 'off-peak', 'peak'],
      [CLAUDE, '2026-07-15T18:00:00Z', 'peak', 'off-peak'],
      [CLAUDE, '2026-01-14T13:00:00Z', 'off-peak', 'peak'],
      [CLAUDE, '2026-01-14T19:00:00Z', 'peak', 'off-peak'],
    ]) {
      assert.equal(peakStateFor(provider, utc(boundary) - 1).kind, before, `${boundary} - 1ms`);
      assert.equal(peakStateFor(provider, utc(boundary)).kind, after, boundary);
    }
  });
});

describe('the earliest boundary of several providers', () => {
  test('earliestUntil answers the nearest boundary among the states that are peak', () => {
    const early = utc('2026-09-23T04:00:00Z');
    const late = utc('2026-09-23T06:00:00Z');
    assert.equal(
      earliestUntil([
        { kind: 'peak', until: late },
        { kind: 'off-peak', until: early - 3_600_000 },
        { kind: 'peak', until: early },
      ]),
      early,
      'the off-peak state is not a peak boundary, even when it is nearer',
    );
    assert.equal(earliestUntil([{ kind: 'peak', until: late }]), late);
  });

  test('earliestUntil is Infinity when nothing is peaking', () => {
    assert.equal(earliestUntil([]), Number.POSITIVE_INFINITY);
    assert.equal(
      earliestUntil([
        { kind: 'off-peak', until: utc('2026-09-23T06:00:00Z') },
        { kind: 'off-peak', until: utc('2026-09-23T01:00:00Z') },
      ]),
      Number.POSITIVE_INFINITY,
    );
    assert.equal(earliestUntil(undefined), Number.POSITIVE_INFINITY);
  });

  test('two providers peaking at once give one timer at the nearer boundary', () => {
    const deepseek = peakStateFor(DEEPSEEK, utc('2026-09-23T03:40:00Z'));
    const claude = peakStateFor(CLAUDE, utc('2026-07-15T12:30:00Z'));
    assert.deepEqual(
      [deepseek.kind, claude.kind],
      ['peak', 'peak'],
      'the fixtures really are two peak states',
    );
    // Both rows are up, so one timer waits for whichever window closes first — whatever order the
    // states arrive in.
    assert.equal(earliestUntil([deepseek, claude]), utc('2026-07-15T18:00:00Z'));
    assert.equal(earliestUntil([claude, deepseek]), utc('2026-07-15T18:00:00Z'));
  });
});

describe('a provider the registry does not declare', () => {
  test('a third window needs no change to the engine: it is read from the entry', () => {
    // Tokyo 09:00-17:00 JST on weekdays. 2026-09-23 is a Wednesday.
    assert.equal(peakStateFor(TOKYO, utc('2026-09-23T00:00:00Z')).kind, 'peak', '09:00 JST');
    assert.equal(peakStateFor(TOKYO, utc('2026-09-22T23:59:59.999Z')).kind, 'off-peak');
    assert.equal(peakStateFor(TOKYO, utc('2026-09-23T07:59:59.999Z')).kind, 'peak');
    assert.deepEqual(peakStateFor(TOKYO, utc('2026-09-23T08:00:00Z')), {
      kind: 'off-peak',
      until: utc('2026-09-24T00:00:00Z'),
    });
    // Saturday 10:00 JST is a weekend in the provider's own zone.
    assert.equal(peakStateFor(TOKYO, utc('2026-09-26T01:00:00Z')).kind, 'off-peak');
    // Sunday 23:00 JST is off-peak until Monday 09:00 JST.
    assert.equal(peakStateFor(TOKYO, utc('2026-09-27T14:00:00Z')).until, utc('2026-09-28T00:00:00Z'));
  });

  test('weekdaysOnly is honoured: a provider without it peaks on a weekend too', () => {
    // UTC 00:00-12:00 every day.
    assert.equal(peakStateFor(ALWAYS, utc('2026-09-26T06:00:00Z')).kind, 'peak', 'Saturday');
    assert.equal(peakStateFor(ALWAYS, utc('2026-09-27T06:00:00Z')).kind, 'peak', 'Sunday');
    assert.equal(peakStateFor(ALWAYS, utc('2026-09-26T12:00:00Z')).kind, 'off-peak');
    assert.deepEqual(peakStateFor(ALWAYS, utc('2026-09-26T12:30:00Z')), {
      kind: 'off-peak',
      until: utc('2026-09-27T00:00:00Z'),
    });
  });
});

describe('an instant or a provider that cannot be read', () => {
  test('an instant that cannot be read is off-peak with no boundary', () => {
    assert.deepEqual(peakStateFor(DEEPSEEK, Number.NaN), { kind: 'off-peak', until: 0 });
    assert.deepEqual(peakStateFor(DEEPSEEK, Number.POSITIVE_INFINITY), { kind: 'off-peak', until: 0 });
    assert.deepEqual(peakStateFor(CLAUDE, Number.NaN), { kind: 'off-peak', until: 0 });
  });

  test('a provider that is not a registry entry is off-peak with no boundary, never a throw', () => {
    for (const bad of [
      undefined,
      null,
      'deepseek',
      {},
      { zone: 'UTC' },
      { windows: [[1, 4]], zone: 'not a zone' },
      { windows: [], zone: '' },
    ]) {
      assert.deepEqual(peakStateFor(bad, utc('2026-09-23T02:00:00Z')), { kind: 'off-peak', until: 0 }, String(bad));
      assert.equal(nextTransitionFor(bad, utc('2026-09-23T02:00:00Z')), 0, String(bad));
    }
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
    assert.equal(formatPeakState(peakStateFor(DEEPSEEK, duringPeak), duringPeak), 'peak 20m');
    const offPeak = utc('2026-09-23T04:30:00Z');
    assert.equal(formatPeakState(peakStateFor(DEEPSEEK, offPeak), offPeak), 'off-peak 1hr 30m');
    // Claude's window reads the same way: the label is the schedule, never the provider.
    const claudePeak = utc('2026-07-15T13:00:00Z');
    assert.equal(formatPeakState(peakStateFor(CLAUDE, claudePeak), claudePeak), 'peak 5hr');
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

  test('the boundary clock is rendered in whatever zone the caller names', () => {
    const claudePeak = utc('2026-07-15T12:30:00Z');
    const until = peakStateFor(CLAUDE, claudePeak).until;
    assert.equal(formatBoundaryClock(until, claudePeak, 'UTC'), '18:00');
    assert.equal(formatBoundaryClock(until, claudePeak, 'America/Los_Angeles'), '11:00');
    assert.equal(formatBoundaryClock(until, claudePeak, 'Asia/Tokyo'), 'Thu 03:00');
  });
});

/** The wall clock one instant reads in one zone, as `HH:MM`: the assertion the DST cases lean on. */
function localClock(ts, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(new Date(ts));
}

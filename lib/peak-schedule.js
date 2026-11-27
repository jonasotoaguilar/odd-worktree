'use strict';
// The peak-schedule engine: when a provider is peak-priced, and when that answer changes.
//
// A provider comes from `lib/peak-providers.js` and carries the schedule: `windows` are half-open
// `[startHour, endHour)` pairs of hours in `zone`, `weekdaysOnly` drops Saturday and Sunday, and
// `zone` is the zone the provider publishes those hours in. DeepSeek publishes UTC hours, Anthropic
// publishes Pacific ones, and the difference is not cosmetic: 05:00-11:00 Pacific is 12:00-18:00 UTC
// under PDT and 13:00-19:00 UTC under PST, so the hours are read in the provider's own zone and the
// weekdays are the provider's own weekdays.
//
// Nothing here knows about DeepSeek or Claude by name; a provider added to the registry is answered
// with no change to this file. Nothing here reads a clock either: every function takes the instant
// it must reason about, so the panel and the row never disagree and the schedule is testable
// without freezing time.
//
// Converting a local wall hour to an instant needs the zone's offset AT THAT INSTANT, which is
// exactly what is unknown before the conversion: the two-pass correction below applies the offset
// in force at the candidate itself, which is why the answer survives a DST switch instead of
// landing an hour off.

const MS_PER_DAY = 86_400_000;
const MINUTE_MS = 60_000;

// How far ahead to look for the next transition, in local days. A Friday evening puts the next
// window three days out; the extra margin keeps the search correct without ever approximating the
// answer.
const CANDIDATE_DAYS = 10;

// One formatter per zone, built once: `Intl.DateTimeFormat` is the only zone database Node has,
// and building one per call would dominate a schedule that is recomputed on every boundary.
const PARTS_FORMATTERS = new Map();

/** The parts formatter for a zone, or `undefined` when the zone does not resolve. */
function partsFormatterFor(timeZone) {
  const cached = PARTS_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = null;
  }
  PARTS_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/**
 * The local calendar fields one instant reads in one zone. `hourCycle: 'h23'` matters: without it
 * midnight can format as `24`, which would land a candidate a day out.
 */
function localParts(ts, timeZone) {
  const formatter = partsFormatterFor(timeZone);
  if (!formatter) return undefined;
  const fields = {};
  for (const part of formatter.formatToParts(Math.floor(ts / 1000) * 1000)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

/** A provider this engine can schedule, or `undefined`: a malformed one is never reasoned about. */
function scheduledProvider(provider) {
  if (provider === null || typeof provider !== 'object') return undefined;
  if (typeof provider.zone !== 'string' || provider.zone.length === 0) return undefined;
  if (!Array.isArray(provider.windows)) return undefined;
  if (!partsFormatterFor(provider.zone)) return undefined;
  return provider;
}

/** The offset of a zone at one instant, as `local wall clock - UTC`, in milliseconds. */
function zoneOffsetAt(ts, timeZone) {
  const parts = localParts(ts, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant at which one local wall hour starts in one zone: the two-pass offset correction. The
 * first pass treats the wall clock as UTC, the second applies the offset in force at the instant
 * the first pass landed on, so a wall hour on either side of a DST switch converts exactly.
 */
function localHourInstant(timeZone, year, month, day, hour) {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  const firstPass = wall - zoneOffsetAt(wall, timeZone);
  return wall - zoneOffsetAt(firstPass, timeZone);
}

/** The provider's own weekday for a local calendar date. */
function isLocalWeekday({ year, month, day }) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function inAnyWindow(windows, minute) {
  return windows.some(([startHour, endHour]) => minute >= startHour * 60 && minute < endHour * 60);
}

/** The schedule predicate itself, evaluated at one instant in the provider's own zone. */
function isPeakInstant(provider, ts) {
  if (provider.weekdaysOnly === true && !isLocalWeekday(localParts(ts, provider.zone))) return false;
  const parts = localParts(ts, provider.zone);
  return inAnyWindow(provider.windows, parts.hour * 60 + parts.minute);
}

/**
 * Every instant that could be a transition: both edges of every window across the next ten LOCAL
 * days of the provider's zone. Weekends produce candidates too; they are dropped by the transition
 * test in `nextTransitionFor`, which is what keeps a Saturday 05:00 Pacific from being reported as
 * a change.
 */
function candidateInstants(provider, now) {
  const today = localParts(now, provider.zone);
  const instants = [];
  for (let offset = 0; offset < CANDIDATE_DAYS; offset++) {
    // Normalising through `Date.UTC` is what rolls the local date over a month or a year boundary.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    for (const [startHour, endHour] of provider.windows) {
      instants.push(localHourInstant(provider.zone, year, month, day, startHour));
      instants.push(localHourInstant(provider.zone, year, month, day, endHour));
    }
  }
  return instants;
}

/**
 * The next instant at which the schedule actually flips. A candidate counts only when the predicate
 * disagrees across it by one millisecond, so the answer is the end of the current state whether that
 * state is a peak window or an off-peak gap that spans a weekend.
 */
function nextTransitionFor(provider, now) {
  const scheduled = scheduledProvider(provider);
  if (!scheduled || !Number.isFinite(now)) return 0;
  let next = now + CANDIDATE_DAYS * MS_PER_DAY;
  for (const instant of candidateInstants(scheduled, now)) {
    if (instant <= now || instant >= next) continue;
    if (isPeakInstant(scheduled, instant - 1) !== isPeakInstant(scheduled, instant)) next = instant;
  }
  return next;
}

/**
 * Whether `now` falls in a provider's peak window, and when that answer changes. An instant or a
 * provider that cannot be read is off-peak with no boundary (`until: 0`), never a throw: a schedule
 * is drawn above a live editor and must not be able to break it.
 */
function peakStateFor(provider, now) {
  const scheduled = scheduledProvider(provider);
  if (!scheduled || !Number.isFinite(now)) return { kind: 'off-peak', until: 0 };
  const kind = isPeakInstant(scheduled, now) ? 'peak' : 'off-peak';
  return { kind, until: nextTransitionFor(scheduled, now) };
}

/**
 * The nearest boundary among several providers' states: the smallest `until` of the states that are
 * peak. `Infinity` when nothing is peaking, so one timer can wait for the first window that closes
 * instead of one timer per provider — which is what lets two rows appear and disappear together
 * without polling between boundaries.
 */
function earliestUntil(states) {
  let earliest = Number.POSITIVE_INFINITY;
  if (!Array.isArray(states)) return earliest;
  for (const state of states) {
    if (state === null || typeof state !== 'object' || state.kind !== 'peak') continue;
    const until = state.until;
    if (typeof until === 'number' && until < earliest) earliest = until;
  }
  return earliest;
}

/**
 * A compact remaining time, in the same shape the shell uses for quota resets. Rounds up, so a live
 * window never reads as already over.
 */
function formatCountdown(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'now';
  const minutes = Math.ceil(milliseconds / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}hr` : `${hours}hr ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}hr`;
}

/**
 * The next transition as a local clock: `04:00` on the same local date, or `Mon 01:00` when the
 * boundary falls on another one. The instant the schedule actually ends is printed, never a
 * countdown. `timeZone` is optional so a test can pin the locale without freezing the machine's
 * clock.
 */
function formatBoundaryClock(until, now, timeZone) {
  if (!Number.isFinite(until) || !Number.isFinite(now)) return 'now';
  const boundary = new Date(until);
  const clock = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(boundary);
  const localDate = (instant) =>
    new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(instant);
  if (localDate(boundary) === localDate(new Date(now))) return clock;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(boundary);
  return `${weekday} ${clock}`;
}

/**
 * `peak 20m` or `off-peak 3hr 20m`: the state, then the time left in it, with no word between and no
 * colour.
 */
function formatPeakState(state, now) {
  return `${state.kind} ${formatCountdown(state.until - now)}`;
}

module.exports = {
  peakStateFor,
  nextTransitionFor,
  earliestUntil,
  formatCountdown,
  formatBoundaryClock,
  formatPeakState,
};

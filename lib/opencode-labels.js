'use strict';
// The strings this package paints for the OpenCode Go peak schedule.
//
// Two surfaces, two different freedoms:
//
// - The usage panel prints `ProviderUsage.plan` inside its own muted role and never sanitizes
//   it, so the header is plain text: the schedule rides there unconditionally, and red stays
//   reserved for near-limit quota inside the panel. The panel already prints ` · ` before that
//   field, so the field itself carries no leading separator.
// - The widget line is this package's own row above the editor, so it paints itself: `peak` is
//   amber while DeepSeek is peak-priced and closes that escape right away, so the details
//   after it stay in the terminal's normal foreground instead of inheriting a dimmed amber.
//   Off-peak has no widget line at all.
//
// The panel's window labels stay untouched: the rows read `go 5h`, `go week`, `go month`, with
// the schedule only on the provider line.
//
// Nothing here reads a clock; every function takes the instant it must describe.

const { formatBoundaryClock, formatPeakState } = require('./opencode-peak.js');

/** The key this package owns in pi's widget map. */
const PEAK_WIDGET_KEY = 'opencode-go-peak-widget';

const AMBER = '\x1b[33m';
const RESET = '\x1b[0m';

/**
 * The schedule the panel prints on its provider line, between the provider name and the
 * `updated …` note: `off-peak 3hr 20m`.
 *
 * The panel inserts its own ` · ` before this field, so the field never starts with one: a
 * leading separator here would render as a doubled ` ·  · `.
 */
function panelSchedule(state, now) {
  return formatPeakState(state, now);
}

/**
 * The single widget line, shown only while DeepSeek is peak-priced:
 * `peak · 2× deepseek · until 04:00`. There is no off-peak variant; the caller clears the
 * widget instead. The boundary is rendered in the machine's own timezone: `timeZone` is not
 * passed here, only by unit tests that call `formatBoundaryClock` directly.
 *
 * Only the state word carries a color: `peak` is amber and closes it with `\x1b[0m`
 * immediately, so the rest of the line renders in the terminal's own foreground. A dim
 * attribute there would reuse the amber already in effect and paint the details in dull
 * brown-gray, which is neither the amber highlight nor ordinary body text.
 */
function peakWidgetLine(state, now) {
  const clock = formatBoundaryClock(state.until, now);
  return `${AMBER}peak${RESET} · 2× deepseek · until ${clock}`;
}

module.exports = {
  PEAK_WIDGET_KEY,
  panelSchedule,
  peakWidgetLine,
};

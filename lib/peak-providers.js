'use strict';
// The peak schedules this package knows about, in the order the `Alert` section draws them.
//
// Every provider here is a schedule, not a model: the `Alert` row is gated by its own switch and
// its own window and by nothing else (never by the session's model, never by a usage key), and
// one row per peaking provider is drawn from this array in declaration order. Adding a provider
// is adding an entry — the engine, the labels and the wiring all read `zone`, `windows`,
// `weekdaysOnly`, `setting` and `label` from the entry itself.
//
// The windows are half-open `[startHour, endHour)` pairs of LOCAL wall hours in `zone`:
//
//   deepseek  01:00-04:00 and 06:00-10:00 UTC, Monday through Friday   (published in UTC)
//   claude    05:00-11:00 in America/Los_Angeles, Monday through Friday (published in Pacific)
//
// DeepSeek's published price multiplier is `2×`, so its `label` says so. Anthropic publishes no
// multiplier for Claude's window, so Claude's `label` is just the provider name: a made-up `2×`
// or `1.4×` there would be a number this package has no source for.

/** OpenCode Go's DeepSeek windows, in UTC. Both models share the family's published peak. */
const DEEPSEEK = Object.freeze({
  id: 'deepseek',
  setting: 'Deepseek peak',
  label: '2× deepseek',
  zone: 'UTC',
  windows: Object.freeze([Object.freeze([1, 4]), Object.freeze([6, 10])]),
  weekdaysOnly: true,
});

/**
 * Anthropic's Claude window, in Pacific time: weekdays 05:00-11:00 PT. It is a zone, not a UTC
 * pair, because the published hours move with PDT/PST — 12:00-18:00 UTC in summer, 13:00-19:00
 * UTC in winter. The row prints no multiplier: Anthropic publishes none for the window.
 */
const CLAUDE = Object.freeze({
  id: 'claude',
  setting: 'Claude peak',
  label: 'claude',
  zone: 'America/Los_Angeles',
  windows: Object.freeze([Object.freeze([5, 11])]),
  weekdaysOnly: true,
});

/** Every schedule, in the order the `Alert` section draws its rows. Frozen: this is the registry. */
const PROVIDERS = Object.freeze([DEEPSEEK, CLAUDE]);

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/** The provider with this id, or `undefined`: this is how the wiring resolves a stored setting. */
function providerById(id) {
  if (typeof id !== 'string') return undefined;
  return BY_ID.get(id);
}

/** The ids, in declaration order. A fresh array, so a caller cannot edit the registry through it. */
function providerIds() {
  return PROVIDERS.map((provider) => provider.id);
}

module.exports = {
  PROVIDERS,
  providerById,
  providerIds,
};

'use strict';
// S1: ONE decision for the preview scroll bindings the full-screen readers
// share, and ONE honest answer about which of those keys the terminal can
// actually deliver.
//
// The user asked for ctrl+shift+j/k and complained that the footer always
// printed ctrl+j/k regardless of the terminal. The native Pi full-screen
// defaults page the preview on PgUp/PgDn, and ctrl+shift+j/k only exists once
// the terminal negotiates an extended keyboard protocol — so the capability is
// read from the host module (isKittyProtocolActive) instead of being guessed
// from the platform, and the legend names the real pair.
//
// Everything here is pure: the host's TUI helpers are injected, no module
// state exists, and a hostile or partial host degrades to the bounded raw
// table below rather than throwing inside a key handler.

const ACTIONS = Object.freeze({
  PAGE_DOWN: 'page-down',
  PAGE_UP: 'page-up',
  HALF_DOWN: 'half-down',
  HALF_UP: 'half-up',
});

// The primary full-page pair as the extended protocol reports it. Hosts spell
// the modifier order both ways (`ctrl+shift+j` and `shift+ctrl+j`), so both
// names are matched — never a bare ctrl+j, which legacy terminals send as the
// same LF byte as Enter.
const RULES = [
  { action: ACTIONS.PAGE_DOWN, names: ['ctrl+shift+j', 'shift+ctrl+j'] },
  { action: ACTIONS.PAGE_UP, names: ['ctrl+shift+k', 'shift+ctrl+k'] },
  { action: ACTIONS.PAGE_DOWN, names: ['pagedown', 'pageDown'] },
  { action: ACTIONS.PAGE_UP, names: ['pageup', 'pageUp'] },
  // The printable Shift+J/K fallback: the same full-page action, so a legacy
  // terminal keeps a working way to page the preview.
  { action: ACTIONS.PAGE_DOWN, names: ['shift+j', 'J'] },
  { action: ACTIONS.PAGE_UP, names: ['shift+k', 'K'] },
  // The distinct Vim pair stays a HALF page and never stands in for the
  // primary binding.
  { action: ACTIONS.HALF_DOWN, names: ['ctrl+d'] },
  { action: ACTIONS.HALF_UP, names: ['ctrl+u'] },
];

// Bare LF/CR mean Enter on a legacy terminal, and VT is the old ctrl+k byte:
// none of them is a preview scroll key any more.
const FORBIDDEN_RAW = new Set(['\n', '\r', '\x0b']);

// Bounded fallback for exactly these keys, for hosts that inject no helpers or
// an incomplete one. Modifiers other than the ones listed here never resolve.
const RAW_ACTIONS = new Map([
  ['\x1b[6~', ACTIONS.PAGE_DOWN],
  ['\x1b[5~', ACTIONS.PAGE_UP],
  ['\x04', ACTIONS.HALF_DOWN],
  ['\x15', ACTIONS.HALF_UP],
  ['J', ACTIONS.PAGE_DOWN],
  ['K', ACTIONS.PAGE_UP],
  ['\x1b[27;6;106~', ACTIONS.PAGE_DOWN],
  ['\x1b[27;6;107~', ACTIONS.PAGE_UP],
]);
// Extended sequences carrying a press or repeat suffix: CSI-u (modifier 6 is
// shift+ctrl), the extended page keys, and ctrl+d/ctrl+u.
const RAW_PATTERNS = [
  { pattern: /^\x1b\[106;6(?::[12])?u$/, action: ACTIONS.PAGE_DOWN },
  { pattern: /^\x1b\[107;6(?::[12])?u$/, action: ACTIONS.PAGE_UP },
  { pattern: /^\x1b\[57422(?:;1)?u$/, action: ACTIONS.PAGE_DOWN },
  { pattern: /^\x1b\[57421(?:;1)?u$/, action: ACTIONS.PAGE_UP },
  { pattern: /^\x1b\[100;5(?::[12])?u$/, action: ACTIONS.HALF_DOWN },
  { pattern: /^\x1b\[117;5(?::[12])?u$/, action: ACTIONS.HALF_UP },
];
// A release never acts: `:3` is the CSI-u event type for one, and xterm's
// modifyOtherKeys carries the same suffix after the code.
const RELEASE_RAW = /^(\x1b\[\d+(?:;\d+)*:3u|\x1b\[\d+(?:;\d+)+;3~)$/;

/**
 * Whether the host confirms an extended keyboard protocol.
 *
 * Only an explicit `true` counts: a missing, throwing or non-boolean answer is
 * the conservative fallback, so the footer never fabricates OS-specific
 * support the terminal did not negotiate.
 */
function extendedKeysActive(helpers) {
  try {
    if (helpers && typeof helpers.isKittyProtocolActive === 'function') {
      return helpers.isKittyProtocolActive() === true;
    }
  } catch {
    // A throwing capability getter is not a confirmation.
  }
  return false;
}

// Names compare case-insensitively for multi-character ids (`pageDown` vs
// `pagedown`), while a single letter stays exact so `j` can never answer for
// the `J` scroll key.
function sameName(left, right) {
  const a = String(left);
  const b = String(right);
  if (a.length === 1 || b.length === 1) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function actionForName(name) {
  const text = String(name);
  if (text === '') return null;
  for (const rule of RULES) {
    for (const candidate of rule.names) {
      if (sameName(text, candidate)) return rule.action;
    }
  }
  return null;
}

function released(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === 'function' && helpers.isKeyRelease(data) === true) return true;
  } catch {
    // A throwing classifier never claims a release; the raw check below decides.
  }
  return RELEASE_RAW.test(data);
}

// The host's own classifier answers first: its symbolic names are what the
// terminal actually reported, and they are more reliable than any decoder we
// could keep here. A single-letter candidate is never offered to the host
// matcher — host matchers fold letter case, so asking about `J` would make a
// lowercase `j` scroll — while `parseKey` still reads a real `J` exactly.
function actionFromHost(helpers, data) {
  try {
    if (helpers && typeof helpers.matchesKey === 'function') {
      for (const rule of RULES) {
        for (const name of rule.names) {
          if (name.length === 1) continue;
          if (helpers.matchesKey(data, name) === true) return rule.action;
        }
      }
    }
  } catch {
    // Fall through to the parser, then to the bounded table.
  }
  let parsed = null;
  try {
    if (helpers && typeof helpers.parseKey === 'function') parsed = helpers.parseKey(data);
  } catch {
    parsed = null;
  }
  return typeof parsed === 'string' ? actionForName(parsed) : null;
}

function actionFromRaw(data) {
  const exact = RAW_ACTIONS.get(data);
  if (exact) return exact;
  for (const entry of RAW_PATTERNS) {
    if (entry.pattern.test(data)) return entry.action;
  }
  return null;
}

/**
 * The preview action one raw key payload asks for.
 *
 * @param {object|null} helpers the host TUI helpers (matchesKey/parseKey/
 *   isKeyRelease/isKittyProtocolActive); any of them may be missing.
 * @param {unknown} data the payload `handleInput` received.
 * @returns {'page-down'|'page-up'|'half-down'|'half-up'|null} the action, or
 *   null when this payload is not a preview scroll key.
 */
function resolveScrollAction(helpers, data) {
  if (typeof data !== 'string' || data === '') return null;
  if (FORBIDDEN_RAW.has(data)) return null;
  if (released(helpers, data)) return null;
  return actionFromHost(helpers, data) || actionFromRaw(data);
}

/**
 * The footer entries that name the scroll keys this terminal can deliver.
 *
 * @param {object|null} helpers the host TUI helpers.
 * @returns {Array<{text: string, short: string, priority: number}>} legend
 *   entries in the shape the one-row footer compacts and drops from.
 */
function previewScrollKeys(helpers) {
  const primary = extendedKeysActive(helpers)
    ? { text: 'ctrl+shift+j/k scroll', short: 'ctrl+shift+j/k', priority: 52 }
    : { text: 'shift+j/k scroll', short: 'shift+j/k', priority: 52 };
  return [
    primary,
    { text: 'PgUp/PgDn', short: 'PgUp/Dn', priority: 24 },
    { text: 'ctrl+d/u half', short: 'ctrl+d/u', priority: 12 },
  ];
}

module.exports = {
  ACTIONS,
  extendedKeysActive,
  resolveScrollAction,
  previewScrollKeys,
};

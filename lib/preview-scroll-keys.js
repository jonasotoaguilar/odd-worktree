'use strict';
// S1: ONE decision for the preview scroll bindings the full-screen readers
// share, and ONE honest guard about the byte the terminal actually sends.
//
// The default pair is ctrl+j/k — the user asked for it to be printed whatever
// the terminal reports — and the legend names it in both readers. ctrl+shift+j/k
// and the printable Shift+J/K stay working alternatives for a host that only
// negotiates the extended keyboard protocol or only delivers printable keys;
// their hints leave the row so the footer does not list every alias.
//
// The one thing that must never move is Enter: a legacy terminal sends the same
// LF byte for ctrl+j and Enter, so a bare newline is Enter and is refused before
// any host matcher or decoder can claim it as a scroll key.
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

// The default pair, then the shifted alternate. Hosts spell the modifier order
// both ways (`ctrl+shift+j` and `shift+ctrl+j`), so the shifted entry carries
// both names; no rule ever matches a bare `j`/`k`, which move the list
// selection.
const RULES = [
  { action: ACTIONS.PAGE_DOWN, names: ['ctrl+j'] },
  { action: ACTIONS.PAGE_UP, names: ['ctrl+k'] },
  // An extended-protocol terminal distinguishes ctrl+j/k from Enter and also
  // reports the shifted pair; either one pages.
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

// Bare LF/CR mean Enter on a legacy terminal — and that terminal reports the
// same byte as ctrl+j — so neither may page. VT is the legacy ctrl+k byte,
// which those terminals cannot tell apart from a control character either.
// This guard runs BEFORE the host matcher, so no matcher can claim a bare
// newline and Enter keeps its confirm/comment meaning.
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
// Extended sequences carrying a press or repeat suffix: CSI-u (modifier 5 is
// ctrl, 6 is shift+ctrl), the extended page keys, and ctrl+d/ctrl+u.
const RAW_PATTERNS = [
  { pattern: /^\x1b\[106;5(?::[12])?u$/, action: ACTIONS.PAGE_DOWN },
  { pattern: /^\x1b\[107;5(?::[12])?u$/, action: ACTIONS.PAGE_UP },
  { pattern: /^\x1b\[106;6(?::[12])?u$/, action: ACTIONS.PAGE_DOWN },
  { pattern: /^\x1b\[107;6(?::[12])?u$/, action: ACTIONS.PAGE_UP },
  { pattern: /^\x1b\[27;5;106~$/, action: ACTIONS.PAGE_DOWN },
  { pattern: /^\x1b\[27;5;107~$/, action: ACTIONS.PAGE_UP },
  { pattern: /^\x1b\[57422(?:;1)?u$/, action: ACTIONS.PAGE_DOWN },
  { pattern: /^\x1b\[57421(?:;1)?u$/, action: ACTIONS.PAGE_UP },
  { pattern: /^\x1b\[100;5(?::[12])?u$/, action: ACTIONS.HALF_DOWN },
  { pattern: /^\x1b\[117;5(?::[12])?u$/, action: ACTIONS.HALF_UP },
];
// A release never acts: `:3` is the CSI-u event type for one, and xterm's
// modifyOtherKeys carries the same suffix after the code.
const RELEASE_RAW = /^(\x1b\[\d+(?:;\d+)*:3u|\x1b\[\d+(?:;\d+)+;3~)$/;

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
 * The footer entries for the scroll keys the readers share.
 *
 * The legend always names ctrl+j/k: it is the default pair the user asked to
 * see, and the alternates (ctrl+shift+j/k, PgUp/PgDn, J/K, ctrl+d/u) keep
 * working without a token. Only the first entry reaches the one collapsed
 * `doc` token, so the list stays a single labelled target.
 *
 * @returns {Array<{text: string, short: string, priority: number}>} legend
 *   entries in the shape the one-row footer compacts and drops from.
 */
function previewScrollKeys() {
  const primary = { text: 'ctrl+j/k scroll', short: 'ctrl+j/k', priority: 52 };
  return [
    primary,
    { text: 'PgUp/PgDn', short: 'PgUp/Dn', priority: 24 },
    { text: 'ctrl+d/u half', short: 'ctrl+d/u', priority: 12 },
  ];
}

module.exports = {
  ACTIONS,
  resolveScrollAction,
  previewScrollKeys,
};

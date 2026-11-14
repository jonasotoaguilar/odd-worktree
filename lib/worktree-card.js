'use strict';
// Native Pi card renderer for the `/warp` confirmation message (T6/S13).
//
// `createWarpMessageRenderer(deps)` returns the renderer the extension
// registers for the `worktree-warp` customType via
// `pi.registerMessageRenderer`: compact shows the capitalised label plus the
// two ordered name-only rows, expanded adds the checkout path and branch, and
// both ride the transcript's card substrate exactly as the two tool cards do —
// the rounded neon frame or the float rail over the tone background, a ctrl+o
// expand hint on the heading row, and the closing rule.
//
// S5/S6: the style is NOT decided here. Every render composes the card's parts
// (`head`, `body`, `bottom`) and hands them to `floatRows` of
// lib/shell-card.js, which reads the style the shell chose ONCE per render
// (lib/card-style.js) and draws the whole card in it, so this card can never be
// half frame and half rail, and it keeps no tone table of its own: the roles,
// the tone backgrounds, the chrome and the narrow-width fallback are the
// substrate's. Content, order, truncation, the expanded wrapping and the
// ctrl+o hint are the same text in both styles; only the chrome differs.
//
// S5/S9 (T6): the two agent tools that used to share this module's tool cards
// are no longer registered — only `worktree_create` and `worktree_list` are,
// and they draw on lib/worktree-cards.js — so the per-tool call/result
// renderer, its summaries, its ordered detail rows and the model-facing
// formatter it fed are gone with them. What remains is the one surface this
// module still serves: the warp confirmation message.
//
// The tone is the documented `warning` role: the installed Pi theme schema
// exposes no orange role, so the closest documented match — `warning` (yellow
// in the built-in themes) — carries the git-orange tone, and the float card
// paints that tone's background. The substrate owns every role and background
// name; this module names the tone alone, never a role.
//
// No new dependencies and no imports of package-private reference
// modules: width and key-hint helpers arrive via injected `deps`
// ({visibleWidth, truncateToWidth, keyHint}) with small local fallbacks,
// consistent with the libRequire architecture, and the subtree is the
// package's own substrate. Every hook returns a plain Pi component
// ({render(width), invalidate}) and never throws: untrusted strings (branch
// names, paths, message text) are sanitized so no raw ANSI or control
// character can leak into or reshape the transcript.

const { CARD_TONE, cardBottom, cardInnerWidth, cardLine, cardTop, floatRows } = require('./shell-card.js');

// The one tone a moved (or queued) checkout has, and the label it has always
// carried. The substrate turns the tone into the theme's own roles.
const WARP_TONE = CARD_TONE.WARNING;
const EMPTY_TEXT = '(no output)';

// Matches ANSI SGR escapes and OSC 8 hyperlinks; control characters and
// DEL are stripped separately so multi-line structure (\n, \t) survives.
const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function safeText(value) {
  if (typeof value !== 'string') return '';
  return stripAnsi(value).replace(CONTROL_PATTERN, '');
}

function asRecord(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function oneLine(value, fallback) {
  const line = safeText(value).split('\n')[0].trim().replace(/\s+/g, ' ');
  return line.length > 0 ? line : fallback;
}

// Minimal column-width measurement for the local fallback (used only
// when the host injects no helpers): wide East-Asian/emoji code points
// occupy two columns, combining marks none. Runtime rendering goes
// through the real pi-tui visibleWidth; this keeps the fallback honest
// at narrow widths instead of counting code points.
function charWidth(code) {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return 0;
  if (
    (code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

function localVisibleWidth(line) {
  let width = 0;
  for (const char of stripAnsi(line)) width += charWidth(char.codePointAt(0));
  return width;
}

// Visible columns of one row, through the injected measurement and the local
// fallback: the card reads its own drawn rows back (the hint's click cells), so
// it measures what the substrate actually emitted.
function measure(text, helpers) {
  try {
    return helpers.visibleWidth(stripAnsi(text));
  } catch {
    return localVisibleWidth(stripAnsi(text));
  }
}

function localTruncate(line, width, ellipsis = '…') {
  if (localVisibleWidth(line) <= width) return line;
  if (width <= 0) return '';
  const mark = localVisibleWidth(ellipsis) >= width ? '' : ellipsis;
  const budget = width - localVisibleWidth(mark);
  let used = 0;
  let out = '';
  for (const char of line) {
    const next = used + charWidth(char.codePointAt(0));
    if (next > budget) break;
    out += char;
    used = next;
  }
  return out + mark;
}

function resolveHelpers(deps) {
  const d = asRecord(deps);
  return {
    visibleWidth: typeof d.visibleWidth === 'function' ? d.visibleWidth : localVisibleWidth,
    truncateToWidth: typeof d.truncateToWidth === 'function' ? d.truncateToWidth : localTruncate,
    keyHint: typeof d.keyHint === 'function' ? d.keyHint : undefined,
    // Click-to-expand seam: the extension injects the callback that flips the
    // host's GLOBAL tool-expansion state (ctx.ui.setToolsExpanded(!ctx.ui
    // .getToolsExpanded())). It is optional — with no callback the cards stay
    // keyboard-only and expose no mouse handler at all.
    toggleExpanded: typeof d.toggleExpanded === 'function' ? d.toggleExpanded : undefined,
  };
}

function expandHint(helpers, expanded) {
  const suffix = expanded ? 'to collapse' : 'to expand';
  if (helpers.keyHint) {
    try {
      const hinted = helpers.keyHint('app.tools.expand', suffix);
      const clean = oneLine(hinted, '');
      if (clean.length > 0) return clean;
    } catch {
      // Fall through to the static hint below.
    }
  }
  return `ctrl+o ${suffix}`;
}

// Click-to-expand seam (opt-in, host-driven).
//
// The installed pi-tui delivers a click to the component that CLAIMED the
// press: tui-alt-screen.js records `mousePressTarget` from the press dispatch
// result and, on release at the same cell, synthesizes a `click` retargeted to
// that exact component. So the press must return { handled: true } or the click
// never arrives. Both host shells reach a card component: tool cards through
// tool-execution.js's MouseRegion (which dispatches to its child first) and
// message cards through CustomMessageComponent — a Container — forwarding to
// the renderer component.
//
// The card therefore claims the HINT's own cells and nothing else, and only a
// left press/click: everywhere else it returns undefined, so the host's own
// click behavior (the MouseRegion toggle, text selection, links) is exactly
// what it was. The callback flips the host's global expansion state — the
// renderer keeps no expansion state of its own, so the keyboard path
// (app.tools.expand / ctrl+o) stays the single source of truth.

// The hint's cell rectangle inside the rendered card: the row it was drawn on
// and its half-open column range. Read back from the rendered lines, so it
// follows the real geometry of both card styles (float heading band, outputPad
// margin, wrapped heading) instead of a second, drifting calculation. Only the
// card's top rule ever carries the hint text, and it is searched first, so the
// body can never masquerade as a click region.
function locateHint(lines, hint, helpers) {
  const text = typeof hint === 'string' ? oneLine(hint, '') : '';
  if (text.length === 0 || !Array.isArray(lines)) return undefined;
  for (let row = 0; row < lines.length; row += 1) {
    const plain = stripAnsi(String(lines[row]));
    const index = plain.indexOf(text);
    if (index < 0) continue;
    const start = measure(plain.slice(0, index), helpers);
    return { row, start, end: start + measure(text, helpers) };
  }
  return undefined;
}

function hintMouseEvent(event, rect, helpers) {
  if (!rect) return undefined;
  const e = asRecord(event);
  if (e.button !== 'left') return undefined;
  if (e.type !== 'press' && e.type !== 'click') return undefined;
  if (typeof e.x !== 'number' || typeof e.y !== 'number') return undefined;
  if (e.y !== rect.row) return undefined;
  if (!(e.x >= rect.start && e.x < rect.end)) return undefined;
  if (e.type === 'click') {
    try {
      helpers.toggleExpanded();
    } catch {
      // A hostile host callback never breaks the card or the transcript.
    }
    return { handled: true };
  }
  // The press CLAIMS the gesture so the host retargets the synthesized click
  // here, and asks for no repaint so the row it just measured stays valid.
  return { handled: true, render: false };
}

// The component shell every card returns: render once per width, remember where
// the hint landed, and — only when the toggle callback was injected — claim the
// mouse on exactly those cells.
function cardComponent({ helpers, hint, renderLines }) {
  let hintRect;
  const component = {
    render(width) {
      const lines = renderLines(width);
      hintRect = locateHint(lines, hint, helpers);
      return lines;
    },
    invalidate() {},
  };
  if (typeof helpers.toggleExpanded === 'function') {
    component.handleMouse = (event) => hintMouseEvent(event, hintRect, helpers);
  }
  return component;
}

// Host outputPad contract (installed Pi 1.3.0 ToolRenderContext):
// renderShell:self cards apply the pad themselves — the host wraps them
// in a plain Container with no padding, while default-shell content goes
// through setPaddingX(outputPad) on both sides (pi-tui Text: content in
// width − 2×pad, one margin each side). Non-finite or negative pads read
// as zero, so contexts without the field keep the unpadded shape.
function padCount(context) {
  const pad = asRecord(context).outputPad;
  if (typeof pad !== 'number' || !Number.isFinite(pad) || pad <= 0) return 0;
  return Math.floor(pad);
}

// S39 expanded wrapping: in the expanded form NOTHING may be cut — long
// lines wrap to the inner width instead of truncating with an ellipsis.
// Only the compact (collapsed) row may clip. Wrapping is character based
// on visible columns, so every emitted line fits its budget.
function wrapTextToWidth(text, width, helpers) {
  const clean = oneLine(text, '');
  const budget = Math.max(0, Math.floor(width));
  if (budget <= 0) return [clean];
  const widthOf = (line) => measure(line, helpers);
  if (widthOf(clean) <= budget) return [clean];
  const lines = [];
  let current = '';
  for (const char of clean) {
    const next = current + char;
    if (widthOf(next) <= budget || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = char;
    }
  }
  lines.push(current);
  return lines;
}

// ---- the card, on the transcript's one substrate ----

/**
 * The card's parts at the width the substrate hands the renderer: the top rule
 * with the ctrl+o hint right-aligned on it, the rows, and the closing rule. The
 * warp has no duration, so the closing rule carries nothing but itself — one
 * corner, one fact. The chrome, the roles, the padding rows and the two styles
 * are the substrate's: this function never names one.
 *
 * Expanded wraps every row to the inner width, so nothing is cut; compact keeps
 * its single clipped row, so the collapsed card stays the two rows it has
 * always been.
 */
function warpParts({ helpers, theme, rows, hint, expanded, inner }) {
  const head = [cardTop(warpCard(), theme, inner, hint, helpers)];
  const body = expanded
    ? rows
      .flatMap((row) => wrapTextToWidth(row, cardInnerWidth(inner), helpers))
      .map((row) => cardLine(row, WARP_TONE, theme, inner, helpers))
    : rows.map((row) => cardLine(row, WARP_TONE, theme, inner, helpers));
  return { head, body, bottom: cardBottom(WARP_TONE, theme, inner, undefined, helpers) };
}

/**
 * The card's lines at `width`, with the host's own horizontal padding applied
 * here: a message renderer owns its outputPad (the host adds no padding to a
 * custom component), so the card is drawn two pads narrower and every row
 * carries one pad on each side — the same margin whichever style answers.
 *
 * One `floatRows` call per render is the whole style decision: it reads the
 * shell's choice once and draws this card entirely in it.
 */
function warpLines({ helpers, theme, rows, hint, expanded, context, width }) {
  const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  const pad = padCount(context);
  const cardWidth = Math.max(0, target - pad * 2);
  if (cardWidth === 0) return [];
  const lines = floatRows(WARP_TONE, theme, cardWidth, (inner) => warpParts({ helpers, theme, rows, hint, expanded, inner }));
  if (pad === 0) return lines;
  const margin = ' '.repeat(pad);
  return lines.map((line) => `${margin}${line}${margin}`);
}

// Warp confirmation message renderer (customize-command T13/S20).
//
// The warp is a COMMAND, so it never passes through a tool card: its one
// visible confirmation is this custom-message renderer, which the
// extension registers for the `worktree-warp` customType via
// `pi.registerMessageRenderer`. Compact shows the capitalised label plus
// the two S42 name-only rows; expanded appends exactly `path: now in
// "<path>"` and `branch: now in "<branch>"` in that order (S41/S42: the
// long prose notice never enters the card body). Warp failures never send
// a message (they notify instead), so `error` never appears here.
//
// S5/S6: the card is drawn on the transcript's substrate, so it follows the
// style Gentle Shell chose — the neon frame or the float rail — through the
// same `floatRows` call the tool cards use, with the theme's `warning` role as
// the accent. Only the two styles' chrome differs; the heading, the rows, their
// order, the clipping and the hint are one text.
//
// The compact rows read from message.details — never by parsing text — with a
// content fallback when details are malformed; a foreign customType returns
// undefined so the host default renderer takes over. Untrusted strings are
// sanitized exactly like the tool cards, and the hook never throws: a theme or
// a helper that does is a blank card, never a broken transcript.
const WARP_CUSTOM_TYPE = 'worktree-warp';
const WARP_GLYPH = '\u2387';
// The label the card has always carried: the capitalised name, and the one
// detail under it. The substrate paints the label in the accent and the detail
// muted, exactly as it does for a tool card's heading.
const WARP_TITLE = 'Warp';
const WARP_DETAIL = 'moved';

/** The card object the substrate draws: its shape, its tone, its glyph. */
function warpCard() {
  return { title: WARP_TITLE, subtitle: WARP_DETAIL, body: [], tone: WARP_TONE, glyph: WARP_GLYPH };
}

function warpMessageText(message) {
  const content = message ? message.content : undefined;
  if (typeof content === 'string') return safeText(content);
  if (Array.isArray(content)) {
    try {
      return content
        .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
        .map((entry) => safeText(entry.text))
        .join('\n');
    } catch {
      return '';
    }
  }
  return '';
}

// S42 warp compact: EXACTLY two name-only rows — `moved: <source name>`
// then `to: <target name>` — with no branch and no path on either row.
// The source name travels explicitly as details.fromName; details written
// before that field fall back to the name segment of fromDesc (the text
// before "·"), and the target name is details.name. A foreign or
// malformed payload falls back to the message content, never to a throw.
function warpSourceName(details) {
  const named = oneLine(details.fromName, '');
  if (named.length > 0) return named;
  const cut = oneLine(details.fromDesc, '').split('\u00B7')[0].trim().replace(/\s+/g, ' ');
  return cut;
}

function warpCompactRows(message) {
  const details = asRecord(message ? message.details : undefined);
  const from = warpSourceName(details);
  const name = oneLine(details.name, '');
  if (from.length > 0 && name.length > 0) {
    return [`moved: ${from}`, `to: ${name}`];
  }
  return [oneLine(warpMessageText(message), EMPTY_TEXT)];
}

function createWarpMessageRenderer(deps) {
  const helpers = resolveHelpers(deps);
  return function renderWarpMessage(message, options, theme) {
    if (!message || message.customType !== WARP_CUSTOM_TYPE) return undefined;
    const opts = asRecord(options);
    const expanded = opts.expanded === true;
    const context = { outputPad: opts.outputPad };
    let rows = warpCompactRows(message);
    if (expanded) {
      // S42: expanded adds exactly these two rows after the compact pair,
      // in this order — and nothing else (never the prose notice).
      const detail = asRecord(message.details);
      const to = oneLine(detail.to, '');
      const branch = oneLine(detail.branch, '');
      if (to.length > 0) rows = [...rows, `path: now in "${to}"`];
      if (branch.length > 0) rows = [...rows, `branch: now in "${branch}"`];
    }
    const hint = expandHint(helpers, expanded);
    return cardComponent({
      helpers,
      hint,
      // S5/S6: one `floatRows` call inside draws the whole card in the style the
      // shell chose, with the same content in both.
      renderLines: (width) => {
        try {
          return warpLines({ helpers, theme, rows, hint, expanded, context, width });
        } catch {
          // A hostile theme or helper is a blank card, never a broken transcript.
          return [];
        }
      },
    });
  };
}

module.exports = {
  createWarpMessageRenderer,
  wrapTextToWidth,
  safeText,
  stripAnsi,
};

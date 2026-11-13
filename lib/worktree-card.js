'use strict';
// Native Pi card renderer for the `/warp` confirmation message (T6/S13).
//
// `createWarpMessageRenderer(deps)` returns the renderer the extension
// registers for the `worktree-warp` customType via
// `pi.registerMessageRenderer`: compact shows the capitalised label plus the
// two ordered name-only rows, expanded adds the checkout path and branch, and
// both ride the same geometry as the transcript's tool cards (accent left
// border on the outlined fallback, one-column margins and full-width painted
// rows on the float card, a ctrl+o expand hint on the heading row).
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
// paints it behind `toolPendingBg`. No other role is ever passed to theme.fg.
//
// No new dependencies and no imports of package-private reference
// modules: width and key-hint helpers arrive via injected `deps`
// ({visibleWidth, truncateToWidth, keyHint}) with small local fallbacks,
// consistent with the libRequire architecture. Every hook returns a plain
// Pi component ({render(width), invalidate}) and never throws: untrusted
// strings (branch names, paths, message text) are sanitized so no raw ANSI
// or control character can leak into or reshape the transcript.

const ACCENT_BAR = '▎';
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

function themeFg(theme, role, text) {
  try {
    if (theme && typeof theme.fg === 'function') return theme.fg(role, text);
  } catch {
    // A hostile theme never breaks the card; fall through to plain text.
  }
  return text;
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
    const start = floatMeasure(plain.slice(0, index), helpers);
    return { row, start, end: start + floatMeasure(text, helpers) };
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

// Card affordance geometry (hint on top): the ctrl+o expand/collapse hint
// belongs on the card's TOP rule and the closing rule belongs to the
// evidence-backed duration alone (`NNNms`/`N.Ns`) — one corner, one fact. `tailParts` splits a row into its
// lead, the fill and the right-aligned tail, and drops the tail entirely when
// it would leave no fill column, so a card identity is never truncated to
// make room for an affordance. Both card styles build their top row from it.
function tailParts(lead, tail, inner, helpers) {
  const head = typeof lead === 'string' ? lead : '';
  const tailText = typeof tail === 'string' ? oneLine(tail, '') : '';
  if (tailText.length === 0) return { head, fill: '', tail: '' };
  const fill = Math.floor(inner) - floatMeasure(head, helpers) - floatMeasure(tailText, helpers);
  if (fill < 1) return { head, fill: '', tail: '' };
  return { head, fill: ' '.repeat(fill), tail: tailText };
}

// Every row opens with the accent bar (the float-card left border from the
// reference). The header row is the call card's top rule and carries the
// expand hint right-aligned; a null header means a body-only result under
// that rule (the hint lives on the call card's header above it, never
// repeated down here). The closing rule carries the duration only;
// close:false omits it so a paired call leaves the frame to its result.
// Widths too narrow for the bar-plus-space prefix degrade to the bar alone
// rather than overflowing; only width 0 — or padding that leaves no
// column — draws nothing.
function buildCard({ helpers, theme, toneRole, header, rows, hint, duration, width, close = true, context, bgRole, wrap = false }) {
  void bgRole;
  const target = Math.max(0, Math.floor(width));
  if (target === 0) return [];
  const wrapRows = (list, budget) => wrap === true
    ? list.flatMap((row) => wrapTextToWidth(row, budget, helpers))
    : list;
  // S24: the float card when the theme carries the tone background at
  // this width — full-width padded rows in one-column margins — else the
  // outlined card below, byte-identical to before.
  const open = floatOpener(theme, toneRole, target);
  if (open.length > 0) {
    return paintFloatRows(floatCardRows({
      helpers, theme, toneRole, header, rows, hint, duration, close,
      inner: target - FLOAT_MARGIN * 2, wrap,
    }), open);
  }
  const pad = padCount(context);
  const body = target - 2 * pad;
  if (body < 1) return [];
  const bar = themeFg(theme, toneRole, ACCENT_BAR);
  const roomy = body >= 2;
  const prefix = roomy ? `${bar} ` : bar;
  const inner = Math.max(0, body - (roomy ? 2 : 1));
  const fit = (text) => {
    const clean = oneLine(text, '');
    let measured = 0;
    try {
      measured = helpers.visibleWidth(stripAnsi(clean));
    } catch {
      measured = localVisibleWidth(clean);
    }
    if (measured <= inner) return clean;
    try {
      return helpers.truncateToWidth(clean, inner, '…');
    } catch {
      return localTruncate(clean, inner);
    }
  };
  const margin = ' '.repeat(pad);
  const lines = [];
  // S39: expanded wraps every row to the inner width; compact clips via fit().
  const bodyRows = wrap === true ? wrapRows(Array.isArray(rows) ? rows : [], inner) : rows;
  const headRows = header !== null && header !== undefined
    ? (wrap === true ? wrapRows([header], inner) : [fit(header)])
    : [];
  headRows.forEach((line, index) => {
    // the hint rides the last top-rule row, right-aligned; a wrapped
    // header keeps its continuation rows plain.
    const parts = index === headRows.length - 1
      ? tailParts(line, hint, inner, helpers)
      : { head: line, fill: '', tail: '' };
    lines.push(`${margin}${prefix}${themeFg(theme, toneRole, parts.head)}${parts.fill}${parts.tail}${margin}`);
  });
  for (const row of bodyRows) lines.push(`${margin}${prefix}${wrap === true ? row : fit(row)}${margin}`);
  if (close) {
    // the closing rule belongs to the duration alone — right-aligned
    // when the host supplied timing evidence, bare otherwise. Nothing is
    // invented and no placeholder dash ever stands in for a duration.
    const rule = tailParts(fit('─'), duration, inner, helpers);
    lines.push(`${margin}${prefix}${rule.head}${rule.fill}${rule.tail}${margin}`);
  }
  return lines;
}

// S24 float recipe (gentle-shell lib/shell-card.ts, CARD_STYLE.FLOAT),
// ported mechanics, not an approximation: a one-column transparent margin
// on both sides; float chrome { topLeft:"\u258E", topLead:" ",
// topRight:"  ", rule:" ", side:"\u258E", rail:" ", bottomLeft:"\u258E",
// bottomRight:" " }; every row padded to the full target width so the
// painted band is a full-width rectangle; a blank padding row above the
// heading and between heading and body; the opener is theme.bg(role,"")
// minus its trailing \x1b[49m, re-armed after every inner reset and
// closed with \x1b[49m; roles by tone (info/success toolSuccessBg,
// warning toolPendingBg, error toolErrorBg — customMessageBg is used
// nowhere in gentle-shell); outlined fallback when the theme lacks the
// role or the width is under 10; the duration rides the closing rule
// only when it fits and is omitted entirely otherwise, never as a
// placeholder dash. No invented hex ever reaches the transcript — only
// these documented role names.
const FLOAT_CHROME = { topLeft: '\u258E', topLead: ' ', topRight: '  ', rule: ' ', side: '\u258E', rail: ' ', bottomLeft: '\u258E', bottomRight: ' ' };
const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE = { info: 'toolSuccessBg', success: 'toolSuccessBg', warning: 'toolPendingBg', error: 'toolErrorBg' };
const BG_RESET = '\x1b[49m';
// Full resets (pi-tui truncation inserts one) and background resets both
// clear the background.
const BG_CLEARING = /\x1b\[(?:0|49)?m/g;

function floatBgRoleForTone(tone) {
  try {
    if (typeof tone === 'string' && Object.prototype.hasOwnProperty.call(FLOAT_BG_ROLE, tone)) {
      return FLOAT_BG_ROLE[tone];
    }
  } catch {
    // An unusable tone reads as no role: the outlined card below.
  }
  return '';
}

// The tone background opener when the float style applies at this width,
// or "" for the outlined card: width under 10, an unknown tone, a theme
// without theme.bg, or a bg that carries no role (no trailing reset).
function floatOpener(theme, tone, width) {
  try {
    if (Math.floor(width) < FLOAT_MIN_WIDTH) return '';
    const role = floatBgRoleForTone(tone);
    if (!role || !theme || typeof theme.bg !== 'function') return '';
    const painted = theme.bg(role, '');
    if (typeof painted !== 'string' || painted.length === 0) return '';
    return painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : '';
  } catch {
    return '';
  }
}

// Paints every row behind its tone background, re-armed after any reset
// the content carries, inside a transparent one-column margin on both
// sides. Padding rows keep their tone-coloured accent just like content.
function paintFloatRows(rows, open) {
  const margin = ' '.repeat(FLOAT_MARGIN);
  return rows.map((row) => `${margin}${open}${String(row).replace(BG_CLEARING, (reset) => reset + open)}${BG_RESET}${margin}`);
}

function floatMeasure(text, helpers) {
  try {
    return helpers.visibleWidth(stripAnsi(text));
  } catch {
    return localVisibleWidth(stripAnsi(text));
  }
}

function floatFit(text, width, helpers) {
  const clean = oneLine(text, '');
  if (floatMeasure(clean, helpers) <= width) return clean;
  try {
    return helpers.truncateToWidth(clean, width, '\u2026');
  } catch {
    return localTruncate(clean, width);
  }
}

// S39 expanded wrapping: in the expanded form NOTHING may be cut — long
// lines wrap to the inner width instead of truncating with an ellipsis.
// Only the compact (collapsed) row may clip. Wrapping is character based
// on visible columns, so every emitted line fits its budget.
function wrapTextToWidth(text, width, helpers) {
  const clean = oneLine(text, '');
  const budget = Math.max(0, Math.floor(width));
  if (budget <= 0) return [clean];
  const measure = (line) => floatMeasure(line, helpers);
  if (measure(clean) <= budget) return [clean];
  const lines = [];
  let current = '';
  for (const char of clean) {
    const next = current + char;
    if (measure(next) <= budget || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = char;
    }
  }
  lines.push(current);
  return lines;
}

// One float content row at exactly `inner` visible columns: the accent
// bar, one space, the text padded out, one space, the right rail. An
// optional `tail` (the expand hint on the heading row) right-aligns
// inside the content columns and is dropped when it leaves no fill column.
function floatContentRow({ helpers, theme, toneRole, text, inner, paint, noClip = false, tail }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.side);
  const contentCols = Math.max(0, inner - 4);
  // With noClip (S39 expanded) the text was already wrapped to fit, so it
  // is never truncated here.
  const fit = noClip === true ? oneLine(text, '') : floatFit(text, contentCols, helpers);
  const parts = tailParts(fit, tail, contentCols, helpers);
  const styled = typeof paint === 'function' ? paint(parts.head) : parts.head;
  const used = floatMeasure(styled, helpers) + parts.fill.length + floatMeasure(parts.tail, helpers);
  const padded = `${styled}${parts.fill}${parts.tail}${' '.repeat(Math.max(0, contentCols - used))}`;
  return `${bar} ${padded} ${FLOAT_CHROME.rail}`;
}

function floatBlankRow({ theme, toneRole, inner }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.side);
  return `${bar}${' '.repeat(Math.max(0, inner - 1))}`;
}

// The closing rule (hint on top): the evidence-backed duration alone right-aligns
// on it, and only when it fits with at least one fill column — otherwise
// it is omitted entirely, never a placeholder dash. With the float chrome
// the rule itself is spaces, so an omitted duration leaves a blank painted
// band, never a bare dash. The expand hint lives on the heading row above.
function floatBottomRow({ helpers, theme, toneRole, duration, inner }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.bottomLeft);
  const tail = typeof duration === 'string' ? oneLine(duration, '') : '';
  if (tail.length > 0) {
    const tailWidth = floatMeasure(tail, helpers);
    const fill = inner - tailWidth - 3;
    if (fill >= 1) {
      return `${bar}${' '.repeat(fill)} ${floatFit(tail, tailWidth, helpers)} `;
    }
  }
  return `${bar}${' '.repeat(Math.max(0, inner - 1))}`;
}

function floatCardRows({ helpers, theme, toneRole, header, rows, hint, duration, close, inner, wrap = false }) {
  const blank = floatBlankRow({ theme, toneRole, inner });
  const out = [];
  const contentCols = Math.max(0, inner - 4);
  // S39: expanded wraps every row to the content width (noClip below, so
  // nothing is cut); compact keeps the single clipped row.
  const wrapList = (list) => wrap === true
    ? list.flatMap((row) => wrapTextToWidth(row, contentCols, helpers))
    : list;
  const headed = header !== null && header !== undefined;
  if (headed) {
    out.push(blank);
    const headLines = wrapList([header]);
    headLines.forEach((line, index) => {
      // the hint rides the last heading row, right-aligned inside the
      // painted band; a wrapped heading keeps its continuation rows plain.
      out.push(floatContentRow({
        helpers, theme, toneRole, text: line, inner, paint: (fit) => themeFg(theme, toneRole, fit),
        noClip: wrap === true, tail: index === headLines.length - 1 ? hint : undefined,
      }));
    });
  }
  const body = wrapList(Array.isArray(rows) ? rows : []);
  if (body.length > 0) {
    // The separator between heading and body — and the leading padding
    // of a header-less result, so a paired call plus its result still
    // reads as one card with the heading set off from its body.
    out.push(blank);
    for (const row of body) out.push(floatContentRow({ helpers, theme, toneRole, text: row, inner, noClip: wrap === true }));
  }
  if (close) out.push(floatBottomRow({ helpers, theme, toneRole, duration, inner }));
  return out;
}

// Warp confirmation message renderer (customize-command T13/S20).
//
// The warp is a COMMAND, so it never passes through a tool card: its one
// visible confirmation is this custom-message renderer, which the
// extension registers for the `worktree-warp` customType via
// `pi.registerMessageRenderer`. Compact shows the capitalised label plus
// the two ordered lines; expanded adds the checkout path on ctrl+o (S41:
// never repeats in the card body what the notice already says) — the same
// geometry as the transcript's cards
// (accent bar, right-aligned hint, outputPad on the outlined fallback;
// one-column margins and full-width painted rows on the float card). The
// tone is the documented `warning` role: the installed Pi theme schema
// exposes no orange role, so warning (yellow in the built-in themes) is
// the closest documented match for git-orange, and the float card paints
// it behind `toolPendingBg` per the tone table. Compact shows the
// capitalised label plus the two S42 name-only rows; expanded appends
// exactly `path: now in "<path>"` and `branch: now in "<branch>"` in
// that order (S41/S42: the long prose notice never enters the card body).
// Warp failures never send a message (they notify instead), so `error`
// never appears here. The compact rows read from
// message.details — never by parsing text — with a content fallback when
// details are malformed; a foreign customType returns undefined so the
// host default renderer takes over. Untrusted strings are sanitized
// exactly like the tool cards, and the hook never throws.
const WARP_CUSTOM_TYPE = 'worktree-warp';
const WARP_GLYPH = '\u2387';
const WARP_TITLE = 'Warp \u00B7 moved';

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
    const header = `${WARP_GLYPH} ${WARP_TITLE}`;
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
      // S39: expanded wraps long lines to the inner width (nothing cut);
      // only the compact row may clip.
      renderLines: (width) => buildCard({ helpers, theme, toneRole: 'warning', header, rows, hint, duration: undefined, width, close: true, context, wrap: expanded === true }),
    });
  };
}

module.exports = {
  createWarpMessageRenderer,
  wrapTextToWidth,
  floatBgRoleForTone,
  safeText,
  stripAnsi,
};

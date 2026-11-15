'use strict';
// S9: the worktree scope step — the single-choice card `/files` opens behind
// when the clone has more than its principal checkout. It knows only about
// scopes, never about Git or the Pi session: T7 resolves the repository, its
// checkouts, their uncommitted counts and their Git detail, and this component
// orders, paints and routes them.
//
// Ported from the read-only reference (`lib/file-scope-view.ts`), on this
// package's substrate instead of gentle-shell's palette card: `lib/shell-card.js`
// draws the top and bottom rules and the one-role rows, `lib/tui-paint.js` paints
// the label/count pair, the focused band and the footer legend, and
// `lib/view-layout.js` owns the measurement and the list window.
//
// PAINT LAST (AGENTS.md invariant 17): every row is measured and padded as PLAIN
// text and painted afterwards, so the helpers never measure an escape sequence
// this repo composed. The scope rows and the footer are the two rows carrying
// more than one tone, and they are framed here with the card's own `│ ` / ` │`
// chrome, exactly the cells `cardLine` draws, because a row with a label, a
// right-aligned count and a selection band cannot be one role.

const { CARD_TONE, cardBottom, cardInnerWidth, cardLine, cardTop } = require('./shell-card.js');
const { highlight, key, label, legendRow, paint, value } = require('./tui-paint.js');
const { measure, scrollWindow } = require('./view-layout.js');
const { countCell, orderScopes, scopeDetailLine } = require('./files-scope-detail.js');

const TITLE = 'Files';
const SUBTITLE = 'Choose a scope';
const EMPTY_TEXT = 'No checkouts to choose from.';
// The tone every informational card uses; its frame role is the theme's plain
// `border` (lib/shell-card.js FRAME_ROLE), which is why the side cells below are
// painted with that one role.
const TONE = CARD_TONE.INFO;
const FRAME_ROLE = 'border';
const FRAME_SIDE = '│';
// The rows the card spends on chrome: the top rule, one blank row, the detail
// line, the footer legend and the bottom rule. One scope row needs one more.
const CHROME_ROWS = 5;
const MIN_CARD_HEIGHT = CHROME_ROWS + 1;
// Narrower than this and the card cannot hold a label and its count.
const MIN_WIDTH = 20;
const MAX_CARD_HEIGHT = 24;
// 0-based row of the first scope: the top rule and the blank row precede it.
const BODY_TOP = 2;
const MARKER_WIDTH = 2;
const KEY_ROLE = 'accent';

// S9, one option per key (the package's own footer rule): arrows move, enter
// opens, esc closes. `ctrl+j`/`ctrl+k` and `ctrl+c` keep working unadvertised.
const FOOTER_ENTRIES = Object.freeze([
  { key: '↑/↓', text: '↑/↓ move', short: '↑/↓', priority: 100 },
  { key: 'enter', text: 'enter open', short: 'enter', priority: 80 },
  { key: 'esc', text: 'esc close', short: 'esc', priority: 60 },
]);

// The card substrate and the palette both call the injected theme directly, and
// only the palette guards a throwing one. The view wraps it once here, so a
// missing, partial or hostile theme leaves the text plain instead of breaking a
// render — the same guarantee `lib/tui-paint.js` gives on its own.
function guardedTheme(theme) {
  const source = theme !== null && typeof theme === 'object' ? theme : {};
  const call = (name, role, text) => {
    try {
      if (typeof source[name] === 'function') {
        const painted = name === 'bold' ? source[name](text) : source[name](role, text);
        if (typeof painted === 'string') return painted;
      }
    } catch {
      // Fall through to the plain text.
    }
    return String(text);
  };
  return {
    fg: (role, text) => call('fg', role, text),
    bg: (role, text) => call('bg', role, text),
    bold: (text) => call('bold', undefined, text),
  };
}

// The sanitizer a terminal value passes before it is measured: no escape
// sequence and no control character reaches a painted row, so a branch name can
// never move the cursor or break the frame.
function sanitize(value) {
  const text = typeof value === 'string' ? value : (value == null ? '' : String(value));
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

/**
 * Mount the scope step (S9).
 *
 * @param {object} options
 * @param {Array<{root: string, label: string, kind: 'main'|'worktree', lastModifiedMs: number, detail?: object}>} options.scopes
 *   the candidate scopes, in any order; `main` always leads and the rest follow
 *   by recency.
 * @param {object} [options.theme] the host theme; a missing or hostile one leaves text plain.
 * @param {number|Function} [options.rowsAvailable] the terminal rows the host offers, or a reader for them.
 * @param {object} [options.helpers] `visibleWidth`/`truncateToWidth`/`matchesKey`/`isKeyRelease`, injected.
 * @param {number} [options.now] the clock the detail line's age reads once; defaults to `Date.now()`.
 * @param {Function} [options.onSelect] called with the chosen scope.
 * @param {Function} [options.onClose] called when the step closes without a choice.
 * @param {Function} [options.requestRender] called when a key or mouse event changed what is painted.
 * @returns {{render: Function, handleInput: Function, handleMouse: Function, invalidate: Function, dispose: Function}}
 */
function createFilesScopeView(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const theme = guardedTheme(opts.theme);
  const helpers = opts.helpers !== null && typeof opts.helpers === 'object' ? opts.helpers : {};
  const rowsAvailable = opts.rowsAvailable;
  const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : null;
  const scopes = orderScopes(Array.isArray(opts.scopes) ? opts.scopes.slice() : []);
  // The age is computed once when the step opens and never refreshed live (S6).
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();

  let selected = 0;
  let hovered;
  let pointerFrame;
  let completed = false;
  let disposed = false;

  const CARD = Object.freeze({ title: TITLE, subtitle: SUBTITLE, tone: TONE });

  function repaint() {
    try {
      if (requestRender !== null) requestRender();
    } catch {
      // A hostile host callback never breaks the step.
    }
  }

  function clampedSelected() {
    if (scopes.length === 0) return 0;
    return Math.max(0, Math.min(scopes.length - 1, selected));
  }

  function moveSelection(delta) {
    if (scopes.length === 0) return false;
    const next = Math.max(0, Math.min(scopes.length - 1, selected + delta));
    if (next === selected) return false;
    selected = next;
    return true;
  }

  function setHover(index) {
    if (hovered === index) return false;
    hovered = index;
    return true;
  }

  function cardHeight() {
    let available = rowsAvailable;
    if (typeof available === 'function') {
      try {
        available = available();
      } catch {
        return 0;
      }
    }
    const value = Number(available);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(MAX_CARD_HEIGHT, Math.floor(value)));
  }

  function clipPlain(text, room) {
    const value = sanitize(text);
    if (room <= 0) return '';
    if (measure(helpers, value) <= room) return value;
    try {
      if (typeof helpers.truncateToWidth === 'function') {
        const cut = helpers.truncateToWidth(value, room, '…');
        if (typeof cut === 'string') return cut;
      }
    } catch {
      // Fall through to the plain codepoint slice.
    }
    const chars = [...value];
    return chars.length <= room ? value : `${chars.slice(0, Math.max(0, room - 1)).join('')}…`;
  }

  function padPlain(text, width) {
    return text + ' '.repeat(Math.max(0, width - measure(helpers, text)));
  }

  // One row of the card's body, framed with the same chrome `cardLine` draws.
  function frameRow(paintedContent) {
    const side = paint(theme, FRAME_ROLE, FRAME_SIDE);
    return `${side} ${paintedContent} ${side}`;
  }

  function scopeRow(index, focusedIndex, inner) {
    const scope = scopes[index] || {};
    const focused = index === focusedIndex;
    const marker = focused ? '▸ ' : '  ';
    const changed = Number(scope.detail && scope.detail.changedFiles);
    const countText = Number.isFinite(changed) && changed > 0 ? countCell(changed) : '';
    const countWidth = countText === '' ? 0 : measure(helpers, countText);
    const showCount = countWidth > 0 && inner > MARKER_WIDTH + countWidth + 1;
    const room = Math.max(0, inner - MARKER_WIDTH - (showCount ? countWidth + 1 : 0));
    const shownLabel = clipPlain(scope.label !== undefined ? scope.label : scope.root, room);
    const labelWidth = measure(helpers, shownLabel);
    const gap = Math.max(showCount ? 1 : 0, inner - MARKER_WIDTH - labelWidth - (showCount ? countWidth : 0));
    const shownCount = showCount ? countText : '';
    if (focused) return frameRow(highlight(theme, `${marker}${shownLabel}${' '.repeat(gap)}${shownCount}`, true));
    const paintedMarker = paint(theme, KEY_ROLE, marker);
    const paintedLabel = index === hovered ? key(theme, shownLabel) : value(theme, shownLabel);
    const paintedCount = showCount ? paint(theme, KEY_ROLE, countText) : '';
    return frameRow(`${paintedMarker}${paintedLabel}${' '.repeat(gap)}${paintedCount}`);
  }

  function indicatorRow(width, text) {
    return cardLine(text, TONE, theme, width, metrics, 'muted');
  }

  function scopeRows(width, inner, bodyRows, hits) {
    const lines = [];
    if (scopes.length === 0) {
      if (bodyRows > 0) lines.push(frameRow(label(theme, padPlain(clipPlain(EMPTY_TEXT, inner), inner))));
    } else if (bodyRows > 0) {
      const focused = clampedSelected();
      const costs = scopes.map(() => 1);
      let window = scrollWindow(costs, { budget: bodyRows, index: focused });
      // Indicators cost two rows; reserve them only when there is something to
      // point at AND enough body left for them to be honest.
      if ((window.above || window.below) && bodyRows >= 4) {
        window = scrollWindow(costs, { budget: bodyRows - 2, index: focused });
      }
      if (window.above && lines.length < bodyRows) {
        lines.push(indicatorRow(width, `  ↑ ${window.start} more`));
      }
      for (let index = window.start; index < window.end; index += 1) {
        hits.push({ y: BODY_TOP + lines.length, index });
        lines.push(scopeRow(index, focused, inner));
      }
      if (window.below && lines.length < bodyRows) {
        lines.push(indicatorRow(width, `  ↓ ${scopes.length - window.end} more`));
      }
    }
    while (lines.length < bodyRows) lines.push(cardLine('', TONE, theme, width, metrics));
    return lines.slice(0, bodyRows);
  }

  // S9: the focused scope's data directly above the footer. An empty row keeps
  // the card's geometry stable when nothing was measured.
  function detailRow(width) {
    const scope = scopes[clampedSelected()];
    const detail = scope && scope.detail;
    const text = detail === undefined ? '' : scopeDetailLine(detail, now);
    if (text === '') return cardLine('', TONE, theme, width, metrics);
    return cardLine(sanitize(text), TONE, theme, width, metrics, 'muted');
  }

  function footerRow(inner) {
    const legend = legendRow(theme, FOOTER_ENTRIES, inner, (text) => measure(helpers, text));
    // The legend is already painted and already fits `inner`; the padding only
    // fills the frame, and the host helpers measure it ANSI-aware.
    return frameRow(padPlain(legend, inner));
  }

  function metricsWidth(text) {
    return measure(helpers, text);
  }

  // The measurement seam the substrate takes: the same injected helpers the rows
  // are measured with, so a paint and a clip can never disagree.
  const metrics = {
    visibleWidth: (text) => metricsWidth(text),
    truncateToWidth(text, width, ellipsis) {
      try {
        if (typeof helpers.truncateToWidth === 'function') {
          const cut = helpers.truncateToWidth(text, width, ellipsis);
          if (typeof cut === 'string') return cut;
        }
      } catch {
        // Fall through to the plain codepoint slice.
      }
      const chars = [...String(text)];
      return chars.length > width
        ? `${chars.slice(0, Math.max(0, width - 1)).join('')}${ellipsis === undefined ? '' : ellipsis}`
        : String(text);
    },
    wrapTextWithAnsi(text, width) {
      try {
        if (typeof helpers.wrapTextWithAnsi === 'function') {
          const rows = helpers.wrapTextWithAnsi(text, width);
          if (Array.isArray(rows)) return rows;
        }
      } catch {
        // Fall through to the plain codepoint split.
      }
      const chars = [...String(text)];
      const rows = [];
      for (let at = 0; at < chars.length; at += Math.max(1, width)) rows.push(chars.slice(at, at + Math.max(1, width)).join(''));
      return rows.length > 0 ? rows : [''];
    },
  };

  function render(width) {
    const w = Number.isFinite(Number(width)) ? Math.floor(Number(width)) : 0;
    if (w <= 0) {
      pointerFrame = undefined;
      return [];
    }
    const height = cardHeight();
    if (height <= 0) {
      pointerFrame = undefined;
      return [];
    }
    if (w < MIN_WIDTH || height < MIN_CARD_HEIGHT) {
      pointerFrame = undefined;
      return [padPlain(clipPlain(`${TITLE} — enlarge the terminal`, w), w)];
    }
    const inner = cardInnerWidth(w);
    const bodyRows = height - CHROME_ROWS;
    const hits = [];
    const body = scopeRows(w, inner, bodyRows, hits);
    const lines = [
      cardTop(CARD, theme, w, undefined, metrics),
      cardLine('', TONE, theme, w, metrics),
      ...body,
      detailRow(w),
      footerRow(inner),
      cardBottom(TONE, theme, w, undefined, metrics),
    ];
    pointerFrame = completed || disposed ? undefined : {
      width: w,
      height: lines.length,
      bodyTop: BODY_TOP,
      bodyRows: body.length,
      hits,
    };
    return lines;
  }

  function keyMatches(data, names) {
    for (const name of names) {
      try {
        if (typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
      } catch {
        // A throwing matcher never matches; the string fallback decides below.
      }
    }
    const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
    return names.some((name) => text === name || (text === '\n' && name === 'enter'));
  }

  function isRelease(data) {
    try {
      return typeof helpers.isKeyRelease === 'function' && helpers.isKeyRelease(data) === true;
    } catch {
      return false;
    }
  }

  function finish(action) {
    if (completed || disposed) return;
    const scope = action === 'select' ? scopes[clampedSelected()] : undefined;
    if (action === 'select' && !scope) return;
    completed = true;
    pointerFrame = undefined;
    hovered = undefined;
    if (scope === undefined) {
      repaint();
      if (onClose !== null) onClose();
      return;
    }
    repaint();
    // A throwing handoff must not leave a completed step with dead input.
    try {
      if (onSelect !== null) onSelect(scope);
    } catch (error) {
      if (onClose !== null) onClose();
      throw error;
    }
  }

  function handleInput(data) {
    if (completed || disposed || isRelease(data)) return;
    pointerFrame = undefined;
    hovered = undefined;
    // A bare line feed is both ctrl+j and, on non-Kitty terminals, a synonym for
    // enter: the move keys are checked first so ctrl+j moves instead of choosing.
    if (keyMatches(data, ['down', 'ctrl+j'])) {
      if (moveSelection(1)) repaint();
      return;
    }
    if (keyMatches(data, ['up', 'ctrl+k'])) {
      if (moveSelection(-1)) repaint();
      return;
    }
    if (keyMatches(data, ['escape', 'ctrl+c'])) {
      finish('close');
      return;
    }
    if (keyMatches(data, ['enter', 'return'])) finish('select');
  }

  // Mouse events are local to the last painted card, including its borders.
  function handleMouse(event) {
    if (completed || disposed || event === null || typeof event !== 'object') return undefined;
    const moving = event.type === 'move' && event.button === 'none';
    const frame = pointerFrame;
    if (!frame || event.width !== frame.width || event.height !== frame.height) {
      pointerFrame = undefined;
      const changed = setHover(undefined);
      if (changed) repaint();
      return changed && moving ? { handled: true, render: true } : undefined;
    }
    const inside = event.x >= 2 && event.x < frame.width - 2 && event.y >= 0 && event.y < frame.height;
    const inBody = inside && event.y >= frame.bodyTop && event.y < frame.bodyTop + frame.bodyRows;
    const hit = inBody ? frame.hits.find((candidate) => candidate.y === event.y) : undefined;
    if (moving) {
      const changed = setHover(hit === undefined ? undefined : hit.index);
      if (changed) repaint();
      return { handled: true, render: changed };
    }
    if (event.type === 'wheel' && event.wheelDelta) {
      if (!inside) return undefined;
      const changed = moveSelection(Math.sign(Number(event.wheelDelta)));
      const hoverChanged = setHover(undefined);
      if (changed || hoverChanged) {
        pointerFrame = undefined;
        repaint();
      }
      return { handled: true, render: changed || hoverChanged };
    }
    if (event.button !== 'left' || hit === undefined) return undefined;
    if (event.type === 'press') return { handled: true, render: false };
    if (event.type !== 'click') return undefined;
    selected = hit.index;
    finish('select');
    return { handled: true, render: true };
  }

  function invalidate() {
    pointerFrame = undefined;
    hovered = undefined;
  }

  function dispose() {
    disposed = true;
    pointerFrame = undefined;
    hovered = undefined;
  }

  return { render, handleInput, handleMouse, invalidate, dispose };
}

module.exports = { createFilesScopeView, FOOTER_ENTRIES };

'use strict';
// T6 (files-picker S1-S6, S14, S15): the file picker overlay `/files` opens on
// one checkout. It is a COMPOSITION, never a second copy of the rules it paints:
//
//   - the listing, its change state and its ages come from `lib/files-index.js`
//     through the injected `loadEntries` / `loadPreview` seams (T1);
//   - the three orders, their foldable trees and the per-order fold state come
//     from `lib/files-orders.js` (T4): this view only owns the fold SETS and
//     hands them in;
//   - the preview pane, its own box, the `line/total` position, the gutter and
//     the ANSI-aware wrap come from `lib/files-preview.js` (T5): this view paints
//     the cells it returns and never builds one itself;
//   - the frame, the tones and the row chrome come from `lib/shell-card.js`, the
//     key/label vocabulary from `lib/tui-paint.js`, and the measurement and the
//     list window from `lib/view-layout.js`.
//
// PAINT LAST (AGENTS.md invariant 17): every row is composed, clipped and padded
// as PLAIN text and only then painted in its roles, so the injected helpers never
// measure an escape sequence this repo composed. The four pieces of state a key
// changes — the query, the order, the per-order folds and the Tab selection — are
// the picker's own; everything else is read from the modules above.
//
// Round L9 (S22, S24, S25, S26) reshaped the body around the same seams: an info
// row between the search row and the list, the preview box riding that row and
// closing on the list's last row, a rule under the body, a cursor that only rests
// on file rows, and a mark bar painted in a theme role. The geometry is computed
// once per render and both the paint and the hit map read it.
//
// Round L11 (S29-S34) is the trees' round, and it owns no rule the order module
// does not already answer: both trees open folded with a `▾`/`▸` chevron in the
// marker column (S29), an order change replaces that order's fold set with `foldsFor`
// so only the highlighted file's own groups are open (S30), `shift+space` hands the
// set to `toggleOtherFolds` for every group except those (S34), group rows paint in
// the grey role (S31), and the flat order is `files`, where neither fold key is
// named or has any effect (S32, S33). This view still only owns the fold SETS and
// hands them in.
//
// The shapes it consumes are the module contracts in `odd/tasks/files-picker.md`:
// `loadEntries()` resolves `{ ok: true, entries } | { ok: false, message }` with
// entries already changed-first; `loadPreview(path)` resolves one
// `lib/files-index.js` preview object; `buildRows(entries, { order, folded,
// query })` answers the rows; `previewRows(preview, { width, height, scroll,
// highlight, languageForPath, path, metrics })` answers exact-width cells.
//
// Nothing here reads a file, spawns a process, paints a card into the transcript
// or decides which overlay the session is in: the wiring (T7) resolves the scope,
// reads the listing, formats the inserted references and stops the terminal for
// the editor. This module answers keys, hits and rows.

const { CARD_GLYPH, CARD_TONE, cardBottom, cardInnerWidth, cardTop } = require('./shell-card.js');
const {
  highlight: paintFocused,
  key: keyText,
  label,
  legendRow,
  paint,
  value,
} = require('./tui-paint.js');
const { measure, scrollWindow } = require('./view-layout.js');
const { ORDERS, buildRows, foldsFor, holderGroup, nextOrder, toggleFold, toggleOtherFolds } = require('./files-orders.js');
const { previewRows } = require('./files-preview.js');
const { formatAge } = require('./files-index.js');

const TITLE = 'Files';
// The tone every informational card uses; its frame role is the theme's plain
// `border` (lib/shell-card.js FRAME_ROLE), which is why the side cells and the
// pane rule below are painted with that one role.
const TONE = CARD_TONE.INFO;
const FRAME_ROLE = 'border';
const FRAME_SIDE = '\u2502'; // │
const PANE_RULE = '\u2502'; // │
// The ` │ ` between the two panes: one blank cell, the rule, one blank cell.
const PANE_RULE_COLUMNS = 3;
// The list pane's share of the card content width and its cap (S15), so longer
// names and paths fit while the preview keeps the rest.
const LIST_SHARE = 0.45;
const LIST_MAX_WIDTH = 64;
// The card takes the room the terminal offers instead of a short fixed card (S15).
const HEIGHT_RATIO = 0.85;
// The rows the card spends on chrome: the top rule, the search row, the info row
// (S22), the footer and the bottom rule. The rule that closes the body under both
// columns is counted apart, so the body keeps its own row budget (S25).
const CHROME_ROWS = 5;
const BODY_RULE_ROWS = 1;
const MIN_CARD_HEIGHT = CHROME_ROWS + 1;
const MIN_WIDTH = 20;
// 0-based row of the first body row: the top rule, the search row and the info row.
const BODY_TOP = 3;
// The row the info row paints, which is also where the preview's box top border
// and the unboxed fallback's position row ride (S25).
const INFO_TOP = BODY_TOP - 1;
// The rule that closes the body under both columns, on its own row (S25).
const BODY_RULE = '\u2500'; // ─
// The cursor cell, the Tab selection cell and the space before the name. It is
// the same in every row state, so marking a row never moves it (S7).
const MARKER_WIDTH = 3;
const CURSOR_MARK = '\u25b8'; // ▸
const SELECTION_MARK = '\u258f'; // ▏
// S29: the fold state a group row shows, in the marker column's Tab cell — the one
// cell a group row never fills, because a group is never marked (S24). The column
// keeps its three cells, so a group name and a file name start in the same one.
const GROUP_EXPANDED_MARK = '\u25be'; // ▾
const GROUP_COLLAPSED_MARK = '\u25b8'; // ▸
// The flat order's id (S33): the listing without groups, so `space` has nothing to
// fold there and the footer never names it (S32).
const FLAT_ORDER = ORDERS[0];
// One level of the `tree` order's nesting.
const GROUP_INDENT = 2;
const SEARCH_PROMPT = '\u203a'; // ›
const SEARCH_PLACEHOLDER = 'Search';
// The row a pending or absent body paints, so the card never claims a listing it
// does not have (S13).
const LOADING_FILES = 'Loading files \u2026';
const LOADING_PREVIEW = 'Loading preview \u2026';
const NO_FILES = 'No files in this repository.';
const UNTRACKED_BADGE = 'U';
const MODIFIED_BADGE = 'M';

// A preview that has not landed yet paints as the notice shape T5 already knows:
// one message, no line number and no `line/total` position to claim.
const PENDING_PREVIEW = Object.freeze({ kind: 'binary', message: LOADING_PREVIEW });

// The footer (S4): ONE option per key even when several work. `ctrl+c` closes and
// `ctrl+shift+j`/`ctrl+shift+k` scroll, `home`/`end` jump and `ctrl+home`/
// `ctrl+end` reach the preview's edges, but no key hint names them.
const FOOTER_ENTRIES = Object.freeze([
  { key: '\u2191/\u2193', text: '\u2191/\u2193 move', short: '\u2191/\u2193', priority: 90 },
  { key: 'tab', text: 'tab select', short: 'tab', priority: 80 },
  { key: 'ctrl+j/k', text: 'ctrl+j/k scroll', short: 'ctrl+j/k', priority: 30 },
  { key: 'ctrl+o', text: 'ctrl+o order', short: 'ctrl+o', priority: 45 },
  { key: 'ctrl+u', text: 'ctrl+u clear', short: 'ctrl+u', priority: 40 },
  { key: 'ctrl+e', text: 'ctrl+e edit', short: 'ctrl+e', priority: 60 },
  { key: 'enter', text: 'enter insert', short: 'enter', priority: 95 },
  { key: 'esc', text: 'esc close', short: 'esc', priority: 100 },
]);

// The two fold keys a TREE order adds (S32, S34), after `ctrl+o order` where S4
// placed `space fold`. The flat `files` order paints no group, so it names neither.
const TREE_FOOTER_ENTRIES = Object.freeze([
  { key: 'space', text: 'space fold', short: 'space', priority: 50 },
  { key: 'shift+space', text: 'shift+space all', short: 'shift+space', priority: 35 },
]);
// The legend position the fold keys occupy: after move, select, scroll and order.
const FOLD_FOOTER_AT = 4;
// The tree legend, built once: the same entries with the two fold keys spliced in
// where S4 placed `space fold`, so a render never rebuilds it.
const TREE_LEGEND = Object.freeze([
  ...FOOTER_ENTRIES.slice(0, FOLD_FOOTER_AT),
  ...TREE_FOOTER_ENTRIES,
  ...FOOTER_ENTRIES.slice(FOLD_FOOTER_AT),
]);

// The key names a hostile terminal hands over as a raw sequence, spelled the way
// this view names them, so every binding works with no `matchesKey` in reach.
const KEY_SEQUENCES = Object.freeze({
  '\r': 'enter',
  '\n': 'ctrl+j',
  '\t': 'tab',
  '\x1b': 'escape',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x03': 'ctrl+c',
  '\x05': 'ctrl+e',
  '\x0f': 'ctrl+o',
  '\x15': 'ctrl+u',
  '\x0b': 'ctrl+k',
  '\x0a': 'ctrl+j',
  ' ': 'space',
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[7~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1b[8~': 'end',
  '\x1b[1;5H': 'ctrl+home',
  '\x1b[7;5~': 'ctrl+home',
  '\x1b[1;5F': 'ctrl+end',
  '\x1b[8;5~': 'ctrl+end',
  '\x1b[106;6u': 'ctrl+shift+j',
  '\x1b[107;6u': 'ctrl+shift+k',
  '\x1b[106;5u': 'ctrl+j',
  '\x1b[107;5u': 'ctrl+k',
  // S34's key, in the two shapes a terminal actually delivers: Kitty CSI-u
  // (codepoint 32, modifier value 2 = shift) and xterm modifyOtherKeys. The host's
  // own `matchesKey(data, 'shift+space')` accepts both; a legacy terminal cannot
  // tell the chord from a plain space, so it stays the `space fold` key there.
  '\x1b[32;2u': 'shift+space',
  '\x1b[27;2;32~': 'shift+space',
});

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
// sequence and no control character reaches a painted row, so a path or a query
// can never move the cursor or break the frame.
function sanitize(value) {
  const text = typeof value === 'string' ? value : (value == null ? '' : String(value));
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// One sentence a panel can paint, with exactly one full stop — the same rule
// lib/files-index.js uses for the messages it hands this view.
function sentence(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim();
  if (trimmed.length === 0) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// One single Basic-Multilingual-Plane printable character: a paste is never a
// keystroke, so it never lands in the query (S3).
function isSinglePrintable(data) {
  if (typeof data !== 'string' || data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/**
 * Mount the file picker (S1-S6, S14, S15).
 *
 * @param {object} options
 * @param {object} [options.theme] the host theme; a missing or hostile one leaves text plain.
 * @param {object} [options.helpers] `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi`/`matchesKey`/`isKeyRelease`, injected.
 * @param {number|Function} [options.rowsAvailable] the terminal rows the host offers, or a reader for them.
 * @param {{root: string, kind: 'main'|'worktree', label: string}} [options.scope] the checkout being listed; its `root` paints at the title's top-right.
 * @param {string} [options.cwd] the session cwd; the picker emits relative paths, so it only documents the scope.
 * @param {Function} options.loadEntries `() -> Promise<{ok: true, entries} | {ok: false, message}>` (lib/files-index.js).
 * @param {Function} options.loadPreview `(relativePath) -> Promise<preview>` (lib/files-index.js shape).
 * @param {Function} [options.highlight] `(code, language) -> string[]` (the host's `highlightCode`).
 * @param {Function} [options.languageForPath] `(path) -> string|undefined` (the host's `getLanguageFromPath`).
 * @param {number} [options.now] the clock a row age falls back to; defaults to `Date.now()`, read once.
 * @param {Function} [options.onInsert] called with the chosen relative paths, in list order.
 * @param {Function} [options.onOpen] called with the highlighted relative path for `ctrl+e`.
 * @param {Function} [options.onClose] called to settle the overlay.
 * @param {Function} [options.requestRender] called when a key or mouse event changed what is painted.
 * @returns {{render: Function, handleInput: Function, handleMouse: Function, invalidate: Function, dispose: Function}}
 */
function createFilesPickerView(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const theme = guardedTheme(opts.theme);
  const helpers = opts.helpers !== null && typeof opts.helpers === 'object' ? opts.helpers : {};
  const rowsAvailable = opts.rowsAvailable;
  const scope = opts.scope !== null && typeof opts.scope === 'object' ? opts.scope : {};
  const loadEntries = typeof opts.loadEntries === 'function' ? opts.loadEntries : null;
  const loadPreview = typeof opts.loadPreview === 'function' ? opts.loadPreview : null;
  const highlighter = typeof opts.highlight === 'function' ? opts.highlight : undefined;
  const languageForPath = typeof opts.languageForPath === 'function' ? opts.languageForPath : undefined;
  const onInsert = typeof opts.onInsert === 'function' ? opts.onInsert : null;
  const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : null;
  // The ages are computed once when the panel opens and never refreshed live (S6).
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const titleRowWidth = measure(helpers, `${CARD_GLYPH} ${TITLE}`);

  let query = '';
  let order = ORDERS[0];
  let selected = 0;
  let previewScroll = 0;
  let previewScrollLimit = 0;
  let hovered;
  let pointerFrame;
  let entries = [];
  let loaded = false;
  let listingError;
  const foldedByOrder = new Map();
  // Tab multi-select (S7): the paths, in the order the reader marked them.
  const selection = new Set();
  // One preview per path, read once; a failed read keeps its own sentence.
  const previews = new Map();
  let completed = false;
  let disposed = false;

  const CARD = Object.freeze({ title: TITLE, tone: TONE });
  const BLANK_ITEM = Object.freeze({ painted: '', width: 0 });

  function repaint() {
    try {
      if (requestRender !== null) requestRender();
    } catch {
      // A hostile host callback never breaks the panel.
    }
  }

  function clipPlain(text, room) {
    const value = sanitize(text);
    if (room <= 0) return '';
    if (measure(helpers, value) <= room) return value;
    try {
      if (typeof helpers.truncateToWidth === 'function') {
        const cut = helpers.truncateToWidth(value, room, '\u2026');
        if (typeof cut === 'string') return cut;
      }
    } catch {
      // Fall through to the plain codepoint slice.
    }
    const chars = [...value];
    return chars.length <= room ? value : `${chars.slice(0, Math.max(0, room - 1)).join('')}\u2026`;
  }

  // Keep the tail of a path, which is what identifies the checkout.
  function elideLeft(text, room) {
    const value = sanitize(text);
    if (room <= 0) return '';
    if (measure(helpers, value) <= room) return value;
    const chars = [...value];
    let tail = '';
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      const candidate = `${chars[index]}${tail}`;
      if (measure(helpers, candidate) > room - 1) break;
      tail = candidate;
    }
    return `\u2026${tail}`;
  }

  // The measurement seam the substrate takes: the same injected helpers the rows
  // are measured with, so a paint and a clip can never disagree.
  const metrics = {
    visibleWidth: (text) => measure(helpers, text),
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
      for (let at = 0; at < chars.length; at += Math.max(1, width)) {
        rows.push(chars.slice(at, at + Math.max(1, width)).join(''));
      }
      return rows.length > 0 ? rows : [''];
    },
  };

  function frameSide() {
    return paint(theme, FRAME_ROLE, FRAME_SIDE);
  }

  // One row of the card's body, framed with the same chrome `cardLine` draws. The
  // content is PLAIN and exactly the inner width; its roles are painted already.
  function frameRow(paintedContent) {
    const side = frameSide();
    return `${side} ${paintedContent} ${side}`;
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
    const rows = Math.max(0, Math.floor(value));
    // The overlay hands the picker the whole terminal, so the card takes its
    // share of it and never more than it was given (S15).
    return Math.min(rows, Math.max(MIN_CARD_HEIGHT, Math.floor(rows * HEIGHT_RATIO)));
  }

  function paneLayout(inner) {
    const listWidth = Math.max(1, Math.min(LIST_MAX_WIDTH, Math.floor(inner * LIST_SHARE)));
    const previewWidth = Math.max(0, inner - listWidth - PANE_RULE_COLUMNS);
    return { listWidth, previewWidth };
  }

  // ---- the listing, the rows and the fold state -----------------------------

  function currentFolds() {
    let folded = foldedByOrder.get(order);
    if (!folded) {
      // S29: an order that has not been chosen yet opens with every group folded.
      // Choosing one runs `foldsFor` with the highlighted path instead (S30).
      folded = foldsFor(entries, order, undefined);
      foldedByOrder.set(order, folded);
    }
    return folded;
  }

  function rows() {
    return buildRows(entries, { order, folded: currentFolds(), query });
  }

  function selectedRow() {
    const list = rows();
    if (list.length === 0) return undefined;
    return list[Math.max(0, Math.min(list.length - 1, selected))];
  }

  function selectedPath() {
    const row = selectedRow();
    return row !== undefined && row.kind === 'file' ? row.entry.path : undefined;
  }

  // The first and last FILE row: a group row has nothing to preview, insert or
  // mark, so a query, `home`/`end` and every move never park the highlight on one
  // (S3, S24).
  function isFileRow(row) {
    return row !== undefined && row.kind === 'file';
  }

  function firstFileRow() {
    const index = rows().findIndex(isFileRow);
    return index < 0 ? 0 : index;
  }

  function lastFileRow() {
    const list = rows();
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (isFileRow(list[index])) return index;
    }
    return Math.max(0, list.length - 1);
  }

  /**
   * The row a wanted index may come to rest on (S24). A file row is taken as it
   * is; a group row snaps to the nearest file row below it and then above it. The
   * ONE documented exception: when the listing holds no file row at all — every
   * group is folded — the index is kept, so the cursor rests on a group row and
   * `space`/`enter` still have the row that reopens the tree.
   */
  function restOn(list, index) {
    if (list.length === 0) return 0;
    const wanted = Math.max(0, Math.min(list.length - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
    if (isFileRow(list[wanted])) return wanted;
    if (!list.some(isFileRow)) return wanted;
    for (let at = wanted; at < list.length; at += 1) {
      if (isFileRow(list[at])) return at;
    }
    for (let at = wanted - 1; at >= 0; at -= 1) {
      if (isFileRow(list[at])) return at;
    }
    return wanted;
  }

  function selectRow(index) {
    const list = rows();
    if (list.length === 0) return false;
    const next = restOn(list, index);
    if (next === selected) return false;
    selected = next;
    previewScroll = 0;
    return true;
  }

  /**
   * One arrow or wheel step: the next row the cursor may rest on, so a step never
   * stops on a group row (S24). A step past either end changes nothing.
   */
  function moveSelection(delta) {
    const step = Math.sign(Number(delta));
    if (step === 0) return false;
    const list = rows();
    if (list.length === 0) return false;
    // The only rows a step may pass over are group rows, and they are skipped
    // unless no file row is left to rest on at all.
    const anyFile = list.some(isFileRow);
    const from = Math.max(0, Math.min(list.length - 1, selected));
    for (let at = from + step; at >= 0 && at < list.length; at += step) {
      if (!anyFile || isFileRow(list[at])) return selectRow(at);
    }
    return false;
  }

  function setQuery(next) {
    query = next;
    selected = firstFileRow();
    previewScroll = 0;
  }

  function toggleSelection() {
    const path = selectedPath();
    if (path === undefined) return false;
    if (selection.has(path)) selection.delete(path);
    else selection.add(path);
    return true;
  }

  /**
   * space and Enter fold a group (S10, S24, S32). The cursor stands on a FILE row,
   * so the group folded is the one HOLDING that file — its folder in `tree`, its
   * extension group in `ext` — and the cursor then returns to the nearest file
   * row, never to the group. Where the cursor does rest on a group row (the one
   * exception above) the row folds itself, which is how the tree is reopened. A
   * file at the repository root has no folder to fold, a non-empty query holds
   * every group open, and the flat `files` order paints no group at all, so the key
   * is inert in all three cases.
   */
  function toggleFocusedGroup() {
    if (order === FLAT_ORDER || query.length > 0) return false;
    const list = rows();
    if (list.length === 0) return false;
    const index = Math.max(0, Math.min(list.length - 1, selected));
    const row = list[index];
    const target = row.kind === 'group' ? row : holderGroup(list, index);
    if (target === null || target === undefined) return false;
    if (!toggleFold(target, currentFolds())) return false;
    const next = rows();
    const at = next.findIndex((candidate) => candidate.kind === 'group' && candidate.key === target.key);
    selected = restOn(next, at < 0 ? index : at);
    previewScroll = 0;
    return true;
  }

  /**
   * shift+space (S34): toggle every group except the ones holding the highlighted
   * file, through the order module's own rule. The holder groups are left exactly
   * as they are, so the cursor's row never disappears; in the flat `files` order
   * there is nothing to toggle, and a query holds every group open anyway.
   */
  function toggleOtherGroups() {
    if (order === FLAT_ORDER || query.length > 0) return false;
    const previous = selectedPath();
    if (!toggleOtherFolds(entries, order, currentFolds(), previous)) return false;
    selected = restOn(rows(), selected);
    if (selectedPath() !== previous) previewScroll = 0;
    return true;
  }

  /** ctrl+o: the next order, with the highlight following the same FILE (S10). */
  function cycleOrder() {
    const previous = selectedPath();
    order = nextOrder(order);
    // S30: the order is chosen, not remembered — it opens with exactly the groups
    // holding the highlighted file and every other group collapsed (S29, S30).
    foldedByOrder.set(order, foldsFor(entries, order, previous));
    const list = rows();
    const moved = previous === undefined
      ? -1
      : list.findIndex((row) => row.kind === 'file' && row.entry.path === previous);
    selected = restOn(list, moved >= 0 ? moved : selected);
    if (selectedPath() !== previous) previewScroll = 0;
    return true;
  }

  /**
   * Enter's payload (S7): the selected files in LIST order, then any selection a
   * query hides in its marking order, then the highlighted file when Tab never
   * marked it. No file is emitted twice.
   */
  function insertionPaths() {
    const paths = [];
    const seen = new Set();
    const push = (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      paths.push(path);
    };
    for (const row of rows()) {
      if (row.kind === 'file' && selection.has(row.entry.path)) push(row.entry.path);
    }
    for (const path of selection) push(path);
    const highlighted = selectedPath();
    if (highlighted !== undefined) push(highlighted);
    return paths;
  }

  // ---- the preview ----------------------------------------------------------

  /**
   * One highlighter call per preview, kept for that path: T5 decides WHEN to
   * highlight, this seam makes sure a repaint cannot pay for it twice (S12 — the
   * highlight runs once per preview load, never per repaint).
   */
  function highlightOnce() {
    if (highlighter === undefined) return undefined;
    let cached;
    return (code, language) => {
      if (cached !== undefined && cached.code === code && cached.language === language) return cached.painted;
      const painted = highlighter(code, language);
      cached = { code, language, painted };
      return painted;
    };
  }

  function landedPreview(path) {
    const entry = previews.get(path);
    return entry !== undefined && entry.status === 'ready' ? entry.preview : PENDING_PREVIEW;
  }

  function failPreview(path, error) {
    previews.set(path, {
      status: 'ready',
      preview: { kind: 'error', message: sentence(`Cannot read ${path}: ${errorMessage(error)}`) },
      highlight: undefined,
    });
  }

  /** Read the highlighted file's preview once; a pending read paints its own notice. */
  function ensurePreview() {
    const path = selectedPath();
    if (path === undefined || previews.has(path)) return;
    const entry = { status: 'loading', highlight: highlightOnce() };
    previews.set(path, entry);
    if (loadPreview === null) {
      failPreview(path, new Error('no preview reader was supplied'));
      return;
    }
    let pending;
    try {
      pending = loadPreview(path);
    } catch (error) {
      failPreview(path, error);
      return;
    }
    Promise.resolve(pending).then(
      (preview) => {
        if (disposed || completed) return;
        previews.set(path, { status: 'ready', preview, highlight: entry.highlight });
        repaint();
      },
      (error) => {
        if (disposed || completed) return;
        failPreview(path, error);
        repaint();
      },
    );
  }

  function setPreviewScroll(next) {
    const wanted = Math.max(0, Math.min(previewScrollLimit, Math.trunc(next)));
    if (wanted === previewScroll) return false;
    previewScroll = wanted;
    return true;
  }

  function scrollPreview(delta) {
    if (delta === 0) return false;
    return setPreviewScroll(previewScroll + delta);
  }

  // ---- the listing load -----------------------------------------------------

  function settleListing(result) {
    if (disposed || completed) return;
    loaded = true;
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      entries = [];
      listingError = result !== null && typeof result === 'object' && typeof result.message === 'string'
        ? result.message
        : sentence('Cannot list repository files');
    } else {
      entries = Array.isArray(result.entries) ? result.entries : [];
      listingError = undefined;
    }
    // S29: the listing is what the group keys are made of, so the trees' fold sets
    // are seeded from it — every group folded — the moment it lands.
    foldedByOrder.clear();
    for (const target of ORDERS) {
      if (target === FLAT_ORDER) continue;
      foldedByOrder.set(target, foldsFor(entries, target, undefined));
    }
    selected = restOn(rows(), selected);
    repaint();
  }

  function loadListing() {
    if (loaded) return;
    if (loadEntries === null) {
      settleListing({ ok: false, message: sentence('Cannot list repository files: no listing reader was supplied') });
      return;
    }
    let pending;
    try {
      pending = loadEntries();
    } catch (error) {
      settleListing({ ok: false, message: sentence(`Cannot list repository files: ${errorMessage(error)}`) });
      return;
    }
    Promise.resolve(pending).then(settleListing, (error) => {
      settleListing({ ok: false, message: sentence(`Cannot list repository files: ${errorMessage(error)}`) });
    });
  }

  // ---- painting -------------------------------------------------------------

  function titleHint(width) {
    // cardTop spends five cells on the chrome and two around the hint it shows.
    const room = width - 5 - titleRowWidth - 2;
    const close = 'esc';
    if (room < close.length) return undefined;
    const root = sanitize(scope.root === undefined ? '' : scope.root);
    if (root === '') return close;
    const tailRoom = room - close.length - 1;
    if (tailRoom < 4) return close;
    return `${elideLeft(root, tailRoom)} ${close}`;
  }

  // S25: the search row is the LIST pane's width, its right column left blank, so
  // the query reads as the list's own field and the preview owns the body beside
  // it.
  function searchRow(pane, inner) {
    const room = Math.max(0, Math.min(inner, pane.listWidth));
    let plain;
    let painted;
    if (query.length === 0) {
      plain = clipPlain(`${SEARCH_PROMPT} ${SEARCH_PLACEHOLDER}`, room);
      painted = paint(theme, 'dim', plain);
    } else {
      const prompt = `${SEARCH_PROMPT} `;
      const shown = clipPlain(query, Math.max(0, room - measure(helpers, prompt)));
      plain = `${prompt}${shown}`;
      painted = `${paint(theme, 'dim', SEARCH_PROMPT)} ${value(theme, shown)}`;
    }
    const padding = ' '.repeat(Math.max(0, inner - measure(helpers, plain)));
    return frameRow(`${painted}${padding}`);
  }

  /**
   * S22: the files the active query lists, counted through the row builder so the
   * number and the list can never disagree about what a query matches. Folding is
   * not a filter, so the flat `files` rows answer it.
   */
  function listedCount() {
    return buildRows(entries, { order: ORDERS[0], query }).filter(isFileRow).length;
  }

  /**
   * The info row's list cell (S22): `listed/total (selected)`, then a `─` fill and
   * the active order right-aligned at the list pane's edge. Too narrow for the
   * order, the counts keep the column and the order gives way — the footer always
   * names it, so it is never lost.
   */
  function infoItem(listWidth) {
    const counts = `${listedCount()}/${entries.length} (${selection.size})`;
    const countsWidth = measure(helpers, counts);
    const orderText = order;
    const orderWidth = measure(helpers, orderText);
    let plain;
    let painted;
    if (listWidth >= countsWidth + orderWidth + 3) {
      const fill = BODY_RULE.repeat(listWidth - countsWidth - orderWidth - 2);
      plain = `${counts} ${fill} ${orderText}`;
      painted = `${value(theme, counts)} ${paint(theme, 'dim', fill)} ${value(theme, orderText)}`;
    } else if (listWidth >= countsWidth + orderWidth + 1) {
      plain = `${counts} ${orderText}`;
      painted = `${value(theme, counts)} ${value(theme, orderText)}`;
    } else {
      plain = clipPlain(counts, listWidth);
      painted = value(theme, plain);
    }
    const padding = ' '.repeat(Math.max(0, listWidth - measure(helpers, plain)));
    return { painted: `${painted}${padding}`, width: listWidth };
  }

  // The info row: the counts inside the list column, the pane rule, and the
  // preview's first row — its box top — riding the same row (S22, S25).
  function infoRow(pane, previewTopItem) {
    const side = frameSide();
    const rule = paint(theme, FRAME_ROLE, PANE_RULE);
    return `${side} ${padItem(infoItem(pane.listWidth), pane.listWidth)} ${rule} ${padItem(previewTopItem, pane.previewWidth)} ${side}`;
  }

  // S25: the rule that closes the body under both columns, on its own row.
  function bodyRuleRow(inner) {
    return frameRow(paint(theme, FRAME_ROLE, BODY_RULE.repeat(Math.max(0, inner))));
  }

  /** What the panes paint instead of a list, or `undefined` when the list is real. */
  function stateLine() {
    if (listingError !== undefined) return { text: listingError, role: 'error' };
    if (!loaded) return { text: LOADING_FILES, role: 'dim' };
    if (entries.length === 0) return { text: NO_FILES, role: 'dim' };
    if (rows().length === 0) return { text: `No files match "${sanitize(query)}"`, role: 'dim' };
    return undefined;
  }

  function ageOf(entry) {
    if (typeof entry.age === 'string' && entry.age.length > 0) return entry.age;
    if (Number.isFinite(entry.mtimeMs)) return formatAge(entry.mtimeMs, now);
    return '';
  }

  // The trailing badge and age, plain: `/changes` own letters, `U` for a file Git
  // does not track yet and `M` for a tracked one with an uncommitted change (S6).
  function suffixOf(entry) {
    if (entry.state === 'clean') return '';
    const badge = entry.state === 'new' ? UNTRACKED_BADGE : MODIFIED_BADGE;
    const age = ageOf(entry);
    return age === '' ? badge : `${badge} ${age}`;
  }

  function paintSuffix(suffix) {
    const [badge, ...rest] = suffix.split(' ');
    const paintedBadge = paint(theme, 'accent', badge);
    return rest.length === 0 ? paintedBadge : `${paintedBadge} ${paint(theme, 'muted', rest.join(' '))}`;
  }

  // The label a file row paints: its name, then — only where the order asks for
  // it — the parent directory, which the `tree` order already expresses (S15).
  function labelOf(entry, showDirectory) {
    const name = sanitize(entry.path.slice(entry.path.lastIndexOf('/') + 1));
    if (!showDirectory) return { text: name, nameLength: name.length };
    const slash = entry.path.lastIndexOf('/');
    const directory = slash < 0 ? '' : sanitize(entry.path.slice(0, slash));
    if (directory === '') return { text: name, nameLength: name.length };
    return { text: `${name}  ${directory}`, nameLength: name.length };
  }

  function markerPlain(cursor, marked) {
    return `${cursor ? CURSOR_MARK : ' '}${marked ? SELECTION_MARK : ' '} `;
  }

  // A group row's marker column (S29): the cursor mark stays in the cell it always
  // occupies, and the chevron takes the Tab cell — which a group row never fills,
  // because a group is never marked (S24). The column keeps its three cells, so a
  // group name and a file name still start in the same one.
  function groupMarkerPlain(cursor, folded) {
    return `${cursor ? CURSOR_MARK : ' '}${folded ? GROUP_COLLAPSED_MARK : GROUP_EXPANDED_MARK} `;
  }

  // The idle marker (S26): a Tab-marked row's bar carries a theme role in EVERY
  // state, focused or not, so the mark reads in the theme's colour instead of as an
  // unstyled cell. It keeps the marker column's three cells and the same glyph, so
  // marking a row still never moves it (S7).
  function markerIdle(marked) {
    return marked ? ` ${keyText(theme, SELECTION_MARK)} ` : '   ';
  }

  // One list row as `{ painted, width }`: `width` is its PLAIN width, so the
  // caller pads it without ever measuring a painted string.
  function listRowItem(row, index, focusedIndex, listWidth) {
    const cursor = index === focusedIndex;
    const mark = row.kind === 'file' && selection.has(row.entry.path);
    const indent = ' '.repeat(Math.max(0, row.depth) * GROUP_INDENT);
    const indentWidth = Math.max(0, row.depth) * GROUP_INDENT;

    if (row.kind === 'group') {
      const room = Math.max(0, listWidth - MARKER_WIDTH - indentWidth);
      const shown = clipPlain(row.label, room);
      const padding = ' '.repeat(Math.max(0, listWidth - MARKER_WIDTH - indentWidth - measure(helpers, shown)));
      // S31: a group row reads in the neutral grey role, never the file row's text
      // tone, focused row included — the focus band stays the focus cue, and the
      // theme's `bg`/`fg` resets do not cancel each other, so the grey survives it.
      const hoveredRow = !cursor && index === hovered;
      const paintedLabel = hoveredRow ? keyText(theme, shown) : label(theme, shown);
      const content = `${groupMarkerPlain(cursor, row.folded)}${indent}${paintedLabel}${padding}`;
      if (cursor) return { painted: paintFocused(theme, content, true), width: listWidth };
      return { painted: content, width: listWidth };
    }

    const entry = row.entry;
    const suffix = suffixOf(entry);
    const suffixWidth = measure(helpers, suffix);
    // The name leads and the state trails: a narrow pane costs the name first.
    const showsSuffix = suffixWidth > 0 && suffixWidth + MARKER_WIDTH + indentWidth + 1 <= listWidth;
    const labelRoom = Math.max(0, listWidth - MARKER_WIDTH - indentWidth - (showsSuffix ? suffixWidth + 1 : 0));
    const nameLabel = labelOf(entry, row.showDirectory !== false);
    const shown = clipPlain(nameLabel.text, labelRoom);
    const split = Math.min(shown.length, nameLabel.nameLength);
    const name = shown.slice(0, split);
    const tail = shown.slice(split);
    const gapEnd = tail.startsWith('  ') ? 2 : tail.search(/[^ ]/);
    const nameGap = gapEnd === -1 ? tail : tail.slice(0, gapEnd);
    const directory = tail.slice(nameGap.length);
    const gap = ' '.repeat(Math.max(
      0,
      listWidth - MARKER_WIDTH - indentWidth - measure(helpers, shown) - (showsSuffix ? suffixWidth : 0),
    ));
    const plain = `${markerPlain(cursor, mark)}${indent}${shown}${gap}${showsSuffix ? suffix : ''}`;
    if (cursor) return { painted: paintFocused(theme, plain, true), width: listWidth };
    const hoveredRow = !cursor && index === hovered;
    const paintedName = mark || hoveredRow ? keyText(theme, name) : value(theme, name);
    const paintedLabel = directory === ''
      ? paintedName
      : `${paintedName}${nameGap}${paint(theme, 'dim', directory)}`;
    const paintedSuffix = showsSuffix ? paintSuffix(suffix) : '';
    return { painted: `${markerIdle(mark)}${indent}${paintedLabel}${gap}${paintedSuffix}`, width: listWidth };
  }

  function indicatorItem(text, width) {
    const shown = clipPlain(text, width);
    return { painted: label(theme, shown), width: Math.max(0, Math.min(width, measure(helpers, shown))) };
  }

  function listColumn(pane, bodyRows, hits) {
    const list = rows();
    const items = [];
    if (bodyRows <= 0 || list.length === 0) {
      for (let row = 0; row < bodyRows; row += 1) items.push(BLANK_ITEM);
      return items;
    }
    const focused = Math.max(0, Math.min(list.length - 1, selected));
    const costs = list.map(() => 1);
    let window = scrollWindow(costs, { budget: bodyRows, index: focused });
    // Indicators cost two rows; reserve them only when something remains on
    // either side AND the body can still show a row between them.
    if ((window.above || window.below) && bodyRows >= 4) {
      window = scrollWindow(costs, { budget: bodyRows - 2, index: focused });
    }
    if (window.above && items.length < bodyRows) {
      items.push(indicatorItem(`  \u2191 ${window.start} more`, pane.listWidth));
    }
    for (let index = window.start; index < window.end; index += 1) {
      hits.push({ y: BODY_TOP + items.length, index });
      items.push(listRowItem(list[index], index, focused, pane.listWidth));
    }
    if (window.below && items.length < bodyRows) {
      items.push(indicatorItem(`  \u2193 ${list.length - window.end} more`, pane.listWidth));
    }
    while (items.length < bodyRows) items.push(BLANK_ITEM);
    return items.slice(0, bodyRows);
  }

  /**
   * The preview column, one row taller than the body: its FIRST row is what rides
   * the info row — the box's top border with the `line/total` position, or the
   * unboxed fallback's own position row — and the body rows follow it, so the box
   * closes on the list's last body row (S25).
   */
  function previewColumn(pane, bodyRows) {
    const blank = { top: BLANK_ITEM, rows: new Array(Math.max(0, bodyRows)).fill(BLANK_ITEM) };
    const path = selectedPath();
    if (path === undefined || pane.previewWidth <= 0) return blank;
    const entry = previews.get(path);
    const painted = previewRows(landedPreview(path), {
      width: pane.previewWidth,
      height: bodyRows + 1,
      scroll: previewScroll,
      highlight: entry !== undefined ? entry.highlight : undefined,
      languageForPath,
      path,
      metrics,
    });
    // The painted window is what a scroll is clamped against, so the last page is
    // always full and the position indicator never lies.
    previewScrollLimit = painted.maxScroll;
    previewScroll = Math.max(0, Math.min(previewScrollLimit, previewScroll));
    const items = painted.rows.map((row) => ({
      painted: row.cells.map((cell) => paint(theme, cell.role, cell.text)).join(''),
      width: pane.previewWidth,
    }));
    while (items.length < bodyRows + 1) items.push(BLANK_ITEM);
    return { top: items[0] === undefined ? BLANK_ITEM : items[0], rows: items.slice(1, bodyRows + 1) };
  }

  function padItem(item, width) {
    const source = item === undefined ? BLANK_ITEM : item;
    return source.painted + ' '.repeat(Math.max(0, width - source.width));
  }

  // The legend entries the active order earns (S32, S34): the fold keys only while
  // the order paints groups, in the one-key-per-action style of S4.
  function footerEntries() {
    return order === FLAT_ORDER ? FOOTER_ENTRIES : TREE_LEGEND;
  }

  // The footer (S4, S10, S33): the legend names ONE option per key, and the active
  // order paints at its right so the order is always visible.
  function footerRow(inner) {
    const orderText = order;
    const orderWidth = measure(helpers, orderText);
    const legendRoom = Math.max(0, inner - orderWidth - 1);
    const legend = legendRow(theme, footerEntries(), legendRoom, (text) => measure(helpers, text));
    const legendWidth = measure(helpers, legend);
    const gap = ' '.repeat(Math.max(0, inner - legendWidth - orderWidth));
    return frameRow(`${legend}${gap}${value(theme, orderText)}`);
  }

  function render(width) {
    const requested = Number(width);
    const w = Number.isFinite(requested) ? Math.floor(requested) : 0;
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
      return [clipPlain(`${TITLE} \u2014 enlarge the terminal`, w)];
    }
    const inner = cardInnerWidth(w);
    const bodyRows = Math.max(0, height - CHROME_ROWS - BODY_RULE_ROWS);
    const pane = paneLayout(inner);
    ensurePreview();

    const hits = [];
    const state = stateLine();
    // The preview is asked for the body plus the row it rides, so the box's top
    // border lands on the info row and its bottom border on the last body row
    // (S25). A state line has no file to preview, so its right column stays blank.
    const preview = state === undefined ? previewColumn(pane, bodyRows) : undefined;
    const lines = [
      cardTop(CARD, theme, w, titleHint(w), metrics),
      searchRow(pane, inner),
      infoRow(pane, preview === undefined ? BLANK_ITEM : preview.top),
    ];
    if (state !== undefined) {
      // The empty, pending and failed lines are unchanged: one full-width row, the
      // rest of the body blank (S13).
      if (bodyRows > 0) {
        const shown = clipPlain(state.text, inner);
        const padding = ' '.repeat(Math.max(0, inner - measure(helpers, shown)));
        lines.push(frameRow(`${paint(theme, state.role, shown)}${padding}`));
        for (let row = 1; row < bodyRows; row += 1) lines.push(frameRow(' '.repeat(inner)));
      }
    } else {
      const left = listColumn(pane, bodyRows, hits);
      const rule = paint(theme, FRAME_ROLE, PANE_RULE);
      for (let row = 0; row < bodyRows; row += 1) {
        const side = frameSide();
        lines.push(
          `${side} ${padItem(left[row], pane.listWidth)} ${rule} ${padItem(preview.rows[row], pane.previewWidth)} ${side}`,
        );
      }
    }
    lines.push(bodyRuleRow(inner));
    lines.push(footerRow(inner));
    lines.push(cardBottom(TONE, theme, w, undefined, metrics));

    pointerFrame = completed || disposed ? undefined : {
      width: w,
      height: lines.length,
      bodyTop: BODY_TOP,
      bodyRows,
      // The box's top border rides the info row, so that row is part of the
      // preview for the pointer (S25).
      previewTop: INFO_TOP,
      listStart: 2,
      listEnd: 2 + pane.listWidth,
      previewStart: 2 + pane.listWidth + PANE_RULE_COLUMNS,
      previewEnd: 2 + inner,
      hits,
    };
    return lines;
  }

  // ---- input ----------------------------------------------------------------

  function keyMatches(data, names) {
    for (const name of names) {
      try {
        if (typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
      } catch {
        // A throwing matcher never matches; the spelled fallback decides below.
      }
    }
    let text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
    if (typeof text === 'string' && Object.prototype.hasOwnProperty.call(KEY_SEQUENCES, text)) {
      text = KEY_SEQUENCES[text];
    }
    return names.some((name) => text === name);
  }

  function isRelease(data) {
    try {
      return typeof helpers.isKeyRelease === 'function' && helpers.isKeyRelease(data) === true;
    } catch {
      return false;
    }
  }

  function complete() {
    completed = true;
    pointerFrame = undefined;
    hovered = undefined;
  }

  /**
   * Settle the panel (S14). Nothing repaints here: the host owns the frame the
   * panel leaves behind. `onClose` is the extension's single close path, and it
   * settles the overlay and then forces one full repaint while the terminal is
   * still the session's (S27) — the editor handoff only starts after that, from
   * the resolved overlay, so nothing here has to choose between the two.
   */
  function finish(action) {
    if (completed || disposed) return;
    if (action === 'insert') {
      const paths = insertionPaths();
      if (paths.length === 0) return;
      complete();
      // The overlay closes even when the paste throws: a completed panel with
      // dead input would strand the session in the picker.
      try {
        if (onInsert !== null) onInsert(paths);
      } finally {
        if (onClose !== null) onClose();
      }
      return;
    }
    const path = action === 'open' ? selectedPath() : undefined;
    if (action === 'open' && path === undefined) return;
    complete();
    try {
      if (path !== undefined && onOpen !== null) onOpen(path);
    } finally {
      if (onClose !== null) onClose();
    }
  }

  function touch() {
    pointerFrame = undefined;
    hovered = undefined;
  }

  function handleInput(data) {
    if (completed || disposed || isRelease(data)) return;
    touch();
    // ctrl+j/k scroll the preview and the ctrl+shift forms are the same action
    // for terminals where they are the deliverable shape (S4). A bare line feed
    // is ctrl+j here, so it scrolls instead of inserting.
    if (keyMatches(data, ['ctrl+shift+j', 'ctrl+j'])) {
      if (scrollPreview(1)) repaint();
      return;
    }
    if (keyMatches(data, ['ctrl+shift+k', 'ctrl+k'])) {
      if (scrollPreview(-1)) repaint();
      return;
    }
    // ctrl+home/ctrl+end and home/end are compatibility bindings: they work and
    // the footer never names them (S4).
    if (keyMatches(data, ['ctrl+home'])) {
      if (setPreviewScroll(0)) repaint();
      return;
    }
    if (keyMatches(data, ['ctrl+end'])) {
      if (setPreviewScroll(previewScrollLimit)) repaint();
      return;
    }
    if (keyMatches(data, ['up'])) {
      if (moveSelection(-1)) repaint();
      return;
    }
    if (keyMatches(data, ['down'])) {
      if (moveSelection(1)) repaint();
      return;
    }
    if (keyMatches(data, ['home'])) {
      if (selectRow(firstFileRow())) repaint();
      return;
    }
    if (keyMatches(data, ['end'])) {
      if (selectRow(lastFileRow())) repaint();
      return;
    }
    if (keyMatches(data, ['tab'])) {
      if (toggleSelection()) repaint();
      return;
    }
    // shift+space toggles every group except the highlighted file's own (S34), and
    // only where the order paints groups.
    if (keyMatches(data, ['shift+space'])) {
      if (toggleOtherGroups()) repaint();
      return;
    }
    // space folds the focused group row and never reaches the query (S3, S10); in
    // the flat `files` order it does nothing at all (S32).
    if (keyMatches(data, ['space'])) {
      if (toggleFocusedGroup()) repaint();
      return;
    }
    if (keyMatches(data, ['ctrl+o'])) {
      if (cycleOrder()) repaint();
      return;
    }
    if (keyMatches(data, ['escape', 'ctrl+c'])) {
      finish('close');
      return;
    }
    if (keyMatches(data, ['enter'])) {
      // Enter on a group row folds it; on a file row it inserts and closes (S7).
      const focused = selectedRow();
      if (focused !== undefined && focused.kind === 'group') {
        if (toggleFocusedGroup()) repaint();
      } else {
        finish('insert');
      }
      return;
    }
    if (keyMatches(data, ['ctrl+e'])) {
      finish('open');
      return;
    }
    if (keyMatches(data, ['backspace'])) {
      if (query.length > 0) {
        setQuery(query.slice(0, -1));
        repaint();
      }
      return;
    }
    if (keyMatches(data, ['ctrl+u'])) {
      if (query.length > 0) {
        setQuery('');
        repaint();
      }
      return;
    }
    if (isSinglePrintable(data)) {
      setQuery(query + data);
      repaint();
    }
  }

  /** Mouse events are local to the last painted card, including its borders (S5). */
  function handleMouse(event) {
    if (completed || disposed || event === null || typeof event !== 'object') return undefined;
    const moving = event.type === 'move' && event.button === 'none';
    const frame = pointerFrame;
    if (!frame || event.width !== frame.width || event.height !== frame.height) {
      pointerFrame = undefined;
      const changed = hovered !== undefined;
      hovered = undefined;
      return changed && moving ? { handled: true, render: true } : undefined;
    }
    const inBody = event.y >= frame.bodyTop && event.y < frame.bodyTop + frame.bodyRows;
    const inList = inBody && event.x >= frame.listStart && event.x < frame.listEnd;
    const inPreview = event.y >= frame.previewTop && event.y < frame.bodyTop + frame.bodyRows
      && event.x >= frame.previewStart && event.x < frame.previewEnd;
    const hit = inList ? frame.hits.find((candidate) => candidate.y === event.y) : undefined;
    if (moving) {
      const changed = hovered !== (hit === undefined ? undefined : hit.index);
      hovered = hit === undefined ? undefined : hit.index;
      if (changed) repaint();
      return { handled: true, render: changed };
    }
    if (event.type === 'wheel' && event.wheelDelta) {
      const delta = Math.sign(Number(event.wheelDelta));
      if (inList) {
        const changed = moveSelection(delta);
        if (changed) repaint();
        return { handled: true, render: changed };
      }
      if (inPreview) {
        const changed = scrollPreview(delta);
        if (changed) repaint();
        return { handled: true, render: changed };
      }
      return undefined;
    }
    if (event.button !== 'left') return undefined;
    // A preview click never breaks the panel and never changes the selection.
    if (inPreview) return { handled: true, render: false };
    if (!inList) return undefined;
    if (event.type === 'press') return { handled: true, render: false };
    if (event.type !== 'click' || hit === undefined) return undefined;
    const list = rows();
    const row = list[hit.index];
    if (row !== undefined && row.kind === 'group') {
      // S24: a group row folds or unfolds on a click and NEVER takes the cursor. A
      // query holds every group open, so the click changes nothing then.
      if (query.length > 0) return { handled: true, render: false };
      const previous = selectedPath();
      if (!toggleFold(row, currentFolds())) return { handled: true, render: false };
      selected = restOn(rows(), selected);
      if (selectedPath() !== previous) previewScroll = 0;
      repaint();
      return { handled: true, render: true };
    }
    const changed = selectRow(hit.index);
    if (changed) repaint();
    return { handled: true, render: changed };
  }

  function invalidate() {
    pointerFrame = undefined;
    hovered = undefined;
  }

  function dispose() {
    disposed = true;
    pointerFrame = undefined;
    hovered = undefined;
    previews.clear();
  }

  loadListing();

  return { render, handleInput, handleMouse, invalidate, dispose };
}

module.exports = { createFilesPickerView, FOOTER_ENTRIES };

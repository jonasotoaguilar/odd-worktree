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
const { ORDERS, buildRows, nextOrder, toggleFold } = require('./files-orders.js');
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
// The rows the card spends on chrome: the top rule, the search row, one blank
// row, the footer and the bottom rule. Every remaining row belongs to the panes.
const CHROME_ROWS = 5;
const MIN_CARD_HEIGHT = CHROME_ROWS + 1;
const MIN_WIDTH = 20;
// 0-based row of the first body row: the top rule, the search row and the blank row.
const BODY_TOP = 3;
// The cursor cell, the Tab selection cell and the space before the name. It is
// the same in every row state, so marking a row never moves it (S7).
const MARKER_WIDTH = 3;
const CURSOR_MARK = '\u25b8'; // ▸
const SELECTION_MARK = '\u258f'; // ▏
// One level of the `path` tree's nesting.
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
  { key: '\u2191/\u2193', text: '\u2191/\u2193 move', short: '\u2191/\u2193', priority: 100 },
  { key: 'tab', text: 'tab select', short: 'tab', priority: 90 },
  { key: 'ctrl+o', text: 'ctrl+o order', short: 'ctrl+o', priority: 80 },
  { key: 'space', text: 'space fold', short: 'space', priority: 70 },
  { key: 'ctrl+u', text: 'ctrl+u clear', short: 'ctrl+u', priority: 60 },
  { key: 'ctrl+e', text: 'ctrl+e edit', short: 'ctrl+e', priority: 50 },
  { key: 'enter', text: 'enter insert', short: 'enter', priority: 40 },
  { key: 'esc', text: 'esc close', short: 'esc', priority: 30 },
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
      folded = new Set();
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

  // The first and last FILE row: a group row has nothing to preview or insert,
  // so typing and `home`/`end` never park the highlight on one (S3).
  function firstFileRow() {
    const index = rows().findIndex((row) => row.kind === 'file');
    return index < 0 ? 0 : index;
  }

  function lastFileRow() {
    const list = rows();
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].kind === 'file') return index;
    }
    return Math.max(0, list.length - 1);
  }

  function selectRow(index) {
    const total = rows().length;
    if (total === 0) return false;
    const next = Math.max(0, Math.min(total - 1, index));
    if (next === selected) return false;
    selected = next;
    previewScroll = 0;
    return true;
  }

  function moveSelection(delta) {
    if (delta === 0) return false;
    return selectRow(selected + delta);
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
   * space and Enter on a group row (S10): the group folds or unfolds and the
   * highlight stays on that row. A file row has nothing to fold, and a non-empty
   * query holds every group open, so the fold keys are inert then.
   */
  function toggleFocusedGroup() {
    const row = selectedRow();
    if (row === undefined || row.kind !== 'group' || query.length > 0) return false;
    if (!toggleFold(row, currentFolds())) return false;
    const index = rows().findIndex((candidate) => candidate.kind === 'group' && candidate.key === row.key);
    if (index >= 0) selected = index;
    return true;
  }

  /** ctrl+o: the next order, with the highlight following the same FILE (S10). */
  function cycleOrder() {
    const previous = selectedPath();
    order = nextOrder(order);
    const list = rows();
    const moved = previous === undefined
      ? -1
      : list.findIndex((row) => row.kind === 'file' && row.entry.path === previous);
    selected = moved >= 0 ? moved : Math.max(0, Math.min(list.length - 1, selected));
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
    selected = Math.max(0, Math.min(Math.max(0, rows().length - 1), selected));
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

  function searchRow(inner) {
    if (query.length === 0) {
      const prompt = `${SEARCH_PROMPT} ${SEARCH_PLACEHOLDER}`;
      const shown = clipPlain(prompt, inner);
      const padding = ' '.repeat(Math.max(0, inner - measure(helpers, shown)));
      return frameRow(`${paint(theme, 'dim', shown)}${padding}`);
    }
    const shown = clipPlain(query, Math.max(0, inner - measure(helpers, `${SEARCH_PROMPT} `)));
    const used = measure(helpers, `${SEARCH_PROMPT} ${shown}`);
    const padding = ' '.repeat(Math.max(0, inner - used));
    return frameRow(`${paint(theme, 'dim', SEARCH_PROMPT)} ${value(theme, shown)}${padding}`);
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
  // it — the parent directory, which the `path` tree already expresses (S15).
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

  // One list row as `{ painted, width }`: `width` is its PLAIN width, so the
  // caller pads it without ever measuring a painted string.
  function listRowItem(row, index, focusedIndex, listWidth) {
    const cursor = index === focusedIndex;
    const mark = row.kind === 'file' && selection.has(row.entry.path);
    const indent = ' '.repeat(Math.max(0, row.depth) * GROUP_INDENT);
    const indentWidth = Math.max(0, row.depth) * GROUP_INDENT;
    const marker = markerPlain(cursor, mark);

    if (row.kind === 'group') {
      const room = Math.max(0, listWidth - MARKER_WIDTH - indentWidth);
      const shown = clipPlain(row.label, room);
      const plain = `${marker}${indent}${shown}`;
      const padding = ' '.repeat(Math.max(0, listWidth - MARKER_WIDTH - indentWidth - measure(helpers, shown)));
      if (cursor) return { painted: paintFocused(theme, `${plain}${padding}`, true), width: listWidth };
      const hoveredRow = !cursor && index === hovered;
      const paintedLabel = hoveredRow ? keyText(theme, shown) : value(theme, shown);
      return { painted: `${marker}${indent}${paintedLabel}${padding}`, width: listWidth };
    }

    const entry = row.entry;
    const suffix = suffixOf(entry);
    const suffixWidth = measure(helpers, suffix);
    // The name leads and the state trails: a narrow pane costs the name first.
    const showsSuffix = suffixWidth > 0 && suffixWidth + MARKER_WIDTH + indentWidth + 1 <= listWidth;
    const labelRoom = Math.max(0, listWidth - MARKER_WIDTH - indentWidth - (showsSuffix ? suffixWidth + 1 : 0));
    const label = labelOf(entry, row.showDirectory !== false);
    const shown = clipPlain(label.text, labelRoom);
    const split = Math.min(shown.length, label.nameLength);
    const name = shown.slice(0, split);
    const tail = shown.slice(split);
    const gapEnd = tail.startsWith('  ') ? 2 : tail.search(/[^ ]/);
    const nameGap = gapEnd === -1 ? tail : tail.slice(0, gapEnd);
    const directory = tail.slice(nameGap.length);
    const gap = ' '.repeat(Math.max(
      0,
      listWidth - MARKER_WIDTH - indentWidth - measure(helpers, shown) - (showsSuffix ? suffixWidth : 0),
    ));
    const plain = `${marker}${indent}${shown}${gap}${showsSuffix ? suffix : ''}`;
    if (cursor) return { painted: paintFocused(theme, plain, true), width: listWidth };
    const hoveredRow = !cursor && index === hovered;
    const paintedName = mark || hoveredRow ? keyText(theme, name) : value(theme, name);
    const paintedLabel = directory === ''
      ? paintedName
      : `${paintedName}${nameGap}${paint(theme, 'dim', directory)}`;
    const paintedSuffix = showsSuffix ? paintSuffix(suffix) : '';
    return { painted: `${marker}${indent}${paintedLabel}${gap}${paintedSuffix}`, width: listWidth };
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

  function previewColumn(pane, bodyRows) {
    const path = selectedPath();
    if (path === undefined || bodyRows <= 0 || pane.previewWidth <= 0) {
      return new Array(Math.max(0, bodyRows)).fill(BLANK_ITEM);
    }
    const entry = previews.get(path);
    const painted = previewRows(landedPreview(path), {
      width: pane.previewWidth,
      height: bodyRows,
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
    while (items.length < bodyRows) items.push(BLANK_ITEM);
    return items.slice(0, bodyRows);
  }

  function padItem(item, width) {
    const source = item === undefined ? BLANK_ITEM : item;
    return source.painted + ' '.repeat(Math.max(0, width - source.width));
  }

  // The footer (S4, S10): the legend names ONE option per key, and the active
  // order paints at its right so the order is always visible.
  function footerRow(inner) {
    const orderText = order;
    const orderWidth = measure(helpers, orderText);
    const legendRoom = Math.max(0, inner - orderWidth - 1);
    const legend = legendRow(theme, FOOTER_ENTRIES, legendRoom, (text) => measure(helpers, text));
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
    const bodyRows = Math.max(0, height - CHROME_ROWS);
    const pane = paneLayout(inner);
    ensurePreview();

    const hits = [];
    const lines = [cardTop(CARD, theme, w, titleHint(w), metrics), searchRow(inner), frameRow(' '.repeat(inner))];
    const state = stateLine();
    if (state !== undefined) {
      const shown = clipPlain(state.text, inner);
      const padding = ' '.repeat(Math.max(0, inner - measure(helpers, shown)));
      lines.push(frameRow(`${paint(theme, state.role, shown)}${padding}`));
      for (let row = 1; row < bodyRows; row += 1) lines.push(frameRow(' '.repeat(inner)));
    } else {
      const left = listColumn(pane, bodyRows, hits);
      const right = previewColumn(pane, bodyRows);
      const rule = paint(theme, FRAME_ROLE, PANE_RULE);
      for (let row = 0; row < bodyRows; row += 1) {
        const side = frameSide();
        lines.push(
          `${side} ${padItem(left[row], pane.listWidth)} ${rule} ${padItem(right[row], pane.previewWidth)} ${side}`,
        );
      }
    }
    lines.push(footerRow(inner));
    lines.push(cardBottom(TONE, theme, w, undefined, metrics));

    pointerFrame = completed || disposed ? undefined : {
      width: w,
      height: lines.length,
      bodyTop: BODY_TOP,
      bodyRows,
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
   * Settle the panel (S14). Nothing repaints on the way out: the editor handoff
   * stops the terminal, so a repaint before `onOpen` would only be a tear, and a
   * close repaints into a surface that is going away.
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
    // space folds the focused group row and never reaches the query (S3, S10).
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
    const inPreview = inBody && event.x >= frame.previewStart && event.x < frame.previewEnd;
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

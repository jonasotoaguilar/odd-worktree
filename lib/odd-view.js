'use strict';
// Odd viewer component (odd-viewer S3,S4,S6).
//
// S3: the left pane takes the smaller 30% list share and its documents are ONE
// continuously scrolling window — `←`/`→` move it a screenful and the focused
// document always stays inside it; there is no pager and no page marker.
//
// S12: the list opens in the loader's own sequence — most recently modified
// document first — and ONE shortcut (`s`) alternates it with a case-insensitive
// alphabetical order. The focused document survives the toggle, the visible
// window re-anchors on its new position, and the footer names both the key and
// the ACTIVE order.
//
// The host component contract Pi asks for (the same shape the customize
// panel uses in extensions/gentle-worktree-tools.ts): the factory returns
// { render(width), handleInput(data), invalidate(), handleMouse(event) }.
// Selection and scroll are LOCAL state: no key writes, notifies or reloads,
// and `esc` finishes through done(null). Nothing here reads or writes
// during render: the document is read once per view and scrolling only
// moves the window.
//
// S10b: the view is read-only with respect to the checkout↔document
// association. The `assigned`, `saveAssignment` and `assignmentEnabled`
// options the existing callers still pass are accepted and ignored — no
// mark, no toggle, no save — and the association lives in the worktree
// detail instead.
//
// The TUI helpers arrive injected (visibleWidth/truncateToWidth/matchesKey/
// isKeyRelease) because @earendil-works/pi-tui is a lazily imported peer of
// this package: the command loads it and passes it down, and the raw-byte
// fallbacks below keep the keys working when a host provides none. Layout
// follows the reference Changes view: a framed two-pane card, list on the
// left, document on the right, the keys on the ONE row above the bottom rule.

const { renderOddMarkdown, stripAnsi } = require('./odd-markdown.js');
const layout = require('./view-layout.js');
const scrollKeys = require('./preview-scroll-keys.js');
// S11: the ONE palette both readers share. Every footer key, footer
// description, frame title, count, label and live search value paints through
// it, so a shortcut key is always distinguishable from the words beside it and
// this view keeps no second copy of the hostile-theme guards.
const palette = require('./tui-paint.js');
const paint = palette.paint;
const emphasize = palette.emphasize;
const highlight = palette.highlight;

const MIN_WIDTH = 24;
// The initial list width, until the host paints the first frame and the shared
// 30/70 reader rule reports the real one: a conventional 80-column terminal.
const DEFAULT_LIST_WIDTH = layout.paneWidths(layout.innerWidth(80), { listShare: layout.READER_LIST_SHARE }).left;
const EMPTY_LIST = 'no odd documents';
const EMPTY_HINT = 'create one under odd/tasks/';
// S2: ONE legend, ONE terminal row — every key rides the same row instead of
// a second footer row. `text` is the full token, `short` the compact form used
// when the full one does not fit, and `priority` decides what a
// still-too-wide legend drops first (lowest first), so `esc close` outlives
// every other hint.
//
// S4 supersedes the earlier split: ALL hints belong to the footer, including
// the search key, so the search row above carries the query alone.
//
// S1: the preview scroll hints are NOT listed here. They come from the shared
// binding helper and are spliced after the selection hint in `contentKeys()`,
// so this legend and that handler can never disagree about the pair.
//
// S14: every scroll hint names the pane it moves, so the list and the document
// can never be read as the same binding («alguna key generidad como el page o
// half estan demas»).
//
// S8 («salen flecha izq/der ... esta bien el atajo pero demas marcarlo»): the
// list scroll pair keeps its BINDING and leaves this legend. `←`/`→` already
// read as movement, the document token beside them names its own target, and
// `[`/`]` were always undocumented alternates — so the extra `←/→ list` token
// only spent cells on a key the reader could simply try. Only the HINT is gone:
// the handler below still resolves `←`/`→` and `[`/`]`.
const CONTENT_KEYS = [
  { key: '↑↓', text: '↑↓ select', short: '↑↓', priority: 60 },
  // The legend spells the lowercase search key; `T` keeps opening the box.
  { key: 't', text: 't search', short: 't', priority: 45 },
  { key: 'o', text: 'o open', short: 'o open', priority: 40 },
  { key: 'esc', text: 'esc close', short: 'esc close', priority: 70 },
];

// S12: the two list orders and the ONE key that alternates them. `recent` is
// the loader's own sequence (lib/odd-docs.js already sorts by modification
// time, newest first), so this view never re-sorts it; `name` is a sorted COPY
// of the same documents. `s` is free — no other binding in this view uses it —
// and a single token keeps the one-row legend cheap.
const ORDER = Object.freeze({ RECENT: 'recent', NAME: 'name' });
const ORDER_KEY = 's';
// S9: the reload key, the outcome state its footer token reports ('idle' keeps
// the plain `r reload` hint) and where that token sits when the compact legend
// has to give a hint up.
const RELOAD_KEY = 'r';
// S9: the outcome needs a few cells more than the idle `r`, and the reported
// terminal is one where the idle token fits but the row is otherwise full. Placing
// the reload token just above the external-open hint (40) makes the legend give
// up `o open` for the answer instead of pruning the answer itself; it stays below
// `t search` (45) and `s sort` (50), so a live action hint is still preferred over
// a spent reload message on a still-narrower row.
const RELOAD_PRIORITY = 41;

// While the filter box holds the keyboard the footer names THAT interaction
// once — enter and esc each keep the filter, Delete clears the whole query and
// Backspace edits one character (S4). Each is a single token so the extra keys
// never inflate the ONE legend row (S2).
const SEARCH_KEYS = [
  { key: 'type', text: 'type to filter', short: 'type', priority: 40 },
  { key: 'del', text: 'del clear', short: 'del', priority: 50 },
  { key: 'bksp', text: 'bksp edit', short: 'bksp', priority: 20 },
  { key: 'enter/esc', text: 'enter/esc keep', short: 'enter/esc', priority: 60 },
];

// S1: `J`/`K` are the preview paging keys now (the shared binding helper
// resolves them before any list key), so a loose case fallback must never let
// them answer for the `j`/`k` selection bindings — and never the reverse.
const SHIFTED_TWINS = new Set(['j', 'k']);

// Raw terminal bytes per key id, mirroring the installed pi-tui keys.js
// legacy sequences — the same convention lib/warp-create-picker.js uses.
// Bounded to the keys this view binds, so the preview stays drivable when
// the host helper module is absent (a scroll key that reads as frozen is
// worse than a redundant fallback). The preview scroll keys are not here:
// lib/preview-scroll-keys.js owns them, so the handler and the legend can
// never disagree about which pair is live.
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  backspace: ['\x7f', '\b'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  left: ['\x1b[D', '\x1bOD'],
  right: ['\x1b[C', '\x1bOC'],
  delete: ['\x1b[3~', '\x1b[57427u'],
  home: ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[57423u'],
  end: ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[57424u'],
};

// Mouse wheel as SGR / legacy X10 bytes: some hosts deliver the wheel through
// handleMouse, older ones through the input stream. Both are parsed here so a
// wheel notch scrolls the preview either way. Button bit 64 flags the wheel;
// bits 0-1 are the direction (0 = up, 1 = down).
const WHEEL_SGR = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
const WHEEL_LEGACY = /^\x1b\[M([\s\S]{3})$/;

function wheelDeltaFromInput(data) {
  if (typeof data !== 'string' || data.length < 6 || data[0] !== '\x1b') return undefined;
  let button;
  const sgr = WHEEL_SGR.exec(data);
  if (sgr) {
    button = Number.parseInt(sgr[1], 10);
  } else {
    const legacy = WHEEL_LEGACY.exec(data);
    if (!legacy) return undefined;
    button = legacy[1].charCodeAt(0) - 32;
  }
  if (!Number.isFinite(button) || (button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction !== 0 && direction !== 1) return undefined;
  return direction === 0 ? -1 : 1;
}

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the ANSI-stripped codepoint count.
  }
  return [...stripAnsi(text)].length;
}

// S23: every paint re-wraps every listed document name — once to measure the
// rows it costs for paging, once to paint the rows actually shown — so a long
// list paid its whole wrap per keystroke. This memo is owned by ONE view
// instance and keyed by the EXACT name text, the list width and both row
// prefixes (the focus marker changes the rows), so only an unchanged name can
// hit it: a renamed or reloaded list, a resized pane or a moved cursor always
// wraps again and a stale row is unpaintable.
const LABEL_MEMO_ENTRIES = 2000;

function createLabelRows(helpers, limit = LABEL_MEMO_ENTRIES) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : LABEL_MEMO_ENTRIES;
  const entries = new Map();
  // The returned rows are read-only for the callers (cost = length, paint =
  // copy each row), so a hit may hand back the same array.
  return function labelRows(text, width, first, rest) {
    const key = `${width}\u0000${first}\u0000${rest}\u0000${text}`;
    const cached = entries.get(key);
    if (cached) {
      // Re-insert, so the Map's own order is the eviction order.
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const rows = layout.wrapLabel(helpers, text, width, { first, rest });
    entries.set(key, rows);
    while (entries.size > max) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return rows;
  };
}

function fit(helpers, text, width) {
  const clean = String(text).split('\n')[0] ?? '';
  if (measure(helpers, clean) <= width) return clean;
  try {
    if (helpers && typeof helpers.truncateToWidth === 'function') {
      const cut = helpers.truncateToWidth(clean, width, '…');
      if (typeof cut === 'string') return cut;
    }
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...clean];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : clean;
}

function pad(helpers, text, width) {
  const clipped = fit(helpers, text, width);
  return clipped + ' '.repeat(Math.max(0, width - measure(helpers, clipped)));
}

// A row that carries its main text on the left and a value on the right edge
// (S13: the scroll position shares the search row). The value is dropped
// rather than allowed to crowd the left text out when the row is too narrow —
// S14 outranks it, so the Search widget and its page marker always survive.
function withRight(helpers, left, right, width) {
  if (right === '') return pad(helpers, left, width);
  const room = width - measure(helpers, right) - 2;
  if (room < 8) return pad(helpers, left, width);
  if (measure(helpers, left) > room) return pad(helpers, left, width);
  const head = fit(helpers, left, room);
  const gap = Math.max(1, width - measure(helpers, head) - measure(helpers, right));
  return `${head}${' '.repeat(gap)}${right}`;
}

// S2: a key legend stays on ONE row. The full text is used while it fits;
// otherwise the legend compacts to its short tokens and then drops its
// lowest-priority keys (display order never changes, and no token carries a
// newline), so it never wraps onto a second row. The caller still pads, which
// keeps the row cell-exact if a single token is wider than the pane. The
// compaction and the role painting live in lib/tui-paint.js (S11), so the
// painted row and the measured one can never disagree.

function keyMatches(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the raw fallback below decides.
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    for (const name of names) {
      const raw = RAW_KEY_BYTES[String(name).toLowerCase()];
      if (raw && raw.includes(data)) return true;
    }
  }
  // A host that classifies the raw bytes can still resolve the same name
  // through its public parser, which is why the parser is consulted before the
  // plain string comparison: a host may name one byte `pageDown` while another
  // spells it `pagedown`.
  let parsed = null;
  try {
    if (helpers && typeof helpers.parseKey === 'function') parsed = helpers.parseKey(data);
  } catch {
    // A throwing parser falls through to the plain comparison.
  }
  if (typeof parsed === 'string' && parsed.length > 0
    && names.some((name) => sameKeyName(parsed, name))) return true;
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  return names.some((name) => sameKeyName(text, name));
}

// Key ids are loose about case because hosts spell them differently
// (`pageDown` vs `pagedown`); only a shifted letter whose unshifted twin is a
// live binding (`J` next to `j`) stays case-sensitive.
function sameKeyName(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return true;
  const shiftedLetter = (text) => text.length === 1 && text >= 'A' && text <= 'Z';
  if (shiftedLetter(a) && !shiftedLetter(b) && SHIFTED_TWINS.has(b.toLowerCase())) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function isKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === 'function') return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases; normal handling follows.
  }
  return false;
}

// S12: case-insensitive alphabetical order by display name, with the raw name
// as the deterministic tie-break for names that differ only in case. Plain
// code-unit comparison, never `localeCompare`: the painted order must not
// change with the host locale.
function compareByName(left, right) {
  const a = String((left && left.name) || '');
  const b = String((right && right.name) || '');
  const folded = a.toLowerCase();
  const other = b.toLowerCase();
  if (folded !== other) return folded < other ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeLoad(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'document unreadable' };
  if (result.ok === true && typeof result.text === 'string') return { ok: true, text: result.text };
  if (result.ok === false) return { ok: false, error: String(result.error || 'document unreadable') };
  return { ok: false, error: 'document unreadable' };
}

function createOddView(options = {}) {
  const {
    helpers = null,
    theme = null,
    rowsAvailable = null,
    requestRender = null,
    done = null,
    loadDoc = null,
    reloadDocs = null,
    openExternal = null,
  } = options;
  // S10b: `options.assigned`, `options.saveAssignment` and
  // `options.assignmentEnabled` are deliberately not read: the association
  // belongs to the worktree detail, and this view stays read-only.
  let docs = Array.isArray(options.docs) ? options.docs.slice() : [];
  const entries = new Map();
  const state = { index: 0, scroll: 0, query: '', searching: false, listStart: 0, order: ORDER.RECENT };
  let openError = null;
  // S9: 'idle' | 'reloaded' | 'failed' — the outcome of the last `r` press.
  let reloadState = 'idle';
  let bodyRows = 1;
  // S23: the per-instance document-name memo (see createLabelRows).
  const labelRows = createLabelRows(helpers);
  // The list pane width of the last frame, so a key press pages against the
  // layout the reader is actually looking at.
  let listWidthCache = DEFAULT_LIST_WIDTH;

  // S24/S25: the title is the viewer and the count, nothing more. The
  // checkout/branch identity is not repeated here (it is the session's own
  // checkout) and neither is the selected document — that rides the status
  // row next to the preview. `checkoutName` stays accepted for the existing
  // callers but is deliberately not rendered. S11/S13: the two parts are
  // separate tokens so the header can paint the viewer with the theme's
  // secondary title role and the count muted; `titleText` joins them for the
  // plain fallback line.
  const TITLE_NAME = '✎ Odd';

  function titleParts() {
    return { name: TITLE_NAME, count: `${docs.length} documents` };
  }

  function titleText() {
    const parts = titleParts();
    return `${parts.name} · ${parts.count}`;
  }

  // The visible list: the filter narrows by document name
  // (case-insensitive substring), exactly like the issues viewer keeps its
  // query after leaving the box — selection indexes into this list. S12: the
  // ACTIVE order decides the sequence of the filtered rows; the recency order
  // is whatever the loader returned, so this view only ever sorts a copy.
  function shown() {
    const q = state.query.trim().toLowerCase();
    const matched = q === ''
      ? docs
      : docs.filter((docEntry) => String((docEntry && docEntry.name) || '').toLowerCase().includes(q));
    if (state.order !== ORDER.NAME) return matched;
    return matched.slice().sort(compareByName);
  }

  function availableRows() {
    try {
      if (typeof rowsAvailable === 'function') {
        const value = Math.floor(rowsAvailable());
        if (Number.isFinite(value) && value > 0) return value;
      }
    } catch {
      // A hostile rows source never breaks the view.
    }
    return 24;
  }

  function repaint() {
    try {
      if (typeof requestRender === 'function') requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function current() {
    const list = shown();
    return list[state.index] || null;
  }

  function renderLines(entry, text, width) {
    entry.lines = renderOddMarkdown(text, {
      width,
      paint: (role, value) => paint(theme, role, value),
      emphasis: (value) => emphasize(theme, value),
      measure: (value) => measure(helpers, value),
    });
    entry.text = text;
    entry.width = width;
  }

  // One read per document per view: the entry keeps its text and rendered
  // lines, so re-selecting a document never re-reads or blocks a frame.
  function ensureEntry(docEntry) {
    if (!docEntry) return null;
    const key = docEntry.path || docEntry.name;
    let entry = entries.get(key);
    if (entry) return entry;
    entry = { status: 'loading', lines: [], text: '', width: 0 };
    entries.set(key, entry);
    if (typeof loadDoc !== 'function') {
      entry.status = 'error';
      entry.error = 'document unreadable';
      return entry;
    }
    let pending = null;
    try {
      pending = loadDoc(docEntry, key);
    } catch (err) {
      entry.status = 'error';
      entry.error = (err && err.message) || 'document unreadable';
      return entry;
    }
    const settle = (result) => {
      const normalized = normalizeLoad(result);
      if (normalized.ok) {
        entry.status = 'ready';
        renderLines(entry, normalized.text, entry.width || MIN_WIDTH);
      } else {
        entry.status = 'error';
        entry.error = normalized.error;
      }
      repaint();
    };
    // A synchronous reader (this package reads a local file) settles before
    // the next frame, so selecting a document never shows a placeholder for
    // a read that already finished.
    if (pending && typeof pending.then === 'function') {
      pending.then(settle).catch((err) => {
        entry.status = 'error';
        entry.error = (err && err.message) || 'document unreadable';
        repaint();
      });
    } else {
      settle(pending);
    }
    return entry;
  }

  function clampScroll() {
    const entry = current() ? ensureEntry(current()) : null;
    const total = entry && entry.status === 'ready' ? entry.lines.length : 0;
    const max = Math.max(0, total - Math.max(1, bodyRows));
    if (state.scroll > max) state.scroll = max;
    if (state.scroll < 0) state.scroll = 0;
  }

  // One place moves the document window, so every input path (keyboard,
  // wheel event, wheel bytes) clamps and repaints identically and none of
  // them writes or reads outside the view.
  function scrollBy(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    state.scroll += delta;
    clampScroll();
    repaint();
  }

  // The host delivers a wheel notch as a TuiMouseEvent (type `wheel`, a
  // signed `wheelDelta`). The preview is the reading surface, so the wheel
  // moves it from anywhere in the frame and never touches the list
  // selection. Only the wheel is consumed; other events stay unhandled so
  // the host keeps its own mouse behavior.
  function handleMouse(event) {
    if (!event || event.type !== 'wheel') return undefined;
    const delta = Number(event.wheelDelta);
    if (!Number.isFinite(delta) || delta === 0) return undefined;
    scrollBy(delta);
    return { handled: true, render: true };
  }

  // S3: the list is ONE continuous window whose capacity follows the rows each
  // wrapped name actually needs, never a fixed document count. (The older "para
  // odd igual, si son muchas igual se pagina" page marker went with the pager.)
  function listCosts() {
    return shown().map((docEntry) => labelRows(String((docEntry && docEntry.name) || ''), listWidthCache, '▸ ', '  ').length);
  }

  // The window the list paints: bounded by the body budget and always holding
  // the focused document.
  function listWindow() {
    return layout.scrollWindow(listCosts(), {
      budget: Math.max(1, bodyRows),
      index: state.index,
      start: state.listStart,
    });
  }

  // S12: the order token names the ACTIVE order, so the ONE footer row says
  // which sequence the list is in as well as which key flips it. It is built
  // per frame (the order changes) and keeps the key/description split the rest
  // of the palette uses: `s` is the key run, ` sort: …` its description.
  function orderKey() {
    return {
      key: ORDER_KEY,
      text: `${ORDER_KEY} sort: ${state.order === ORDER.NAME ? 'name' : 'recent'}`,
      short: ORDER_KEY,
      priority: 50,
    };
  }

  // S1: the reader legend is the static keys plus the scroll hints the shared
  // binding helper says this terminal can actually deliver.
  //
  // S14: the document pane's hints — the page pair, the half-page pair and the
  // printable fallback — all scroll the SAME target, so they collapse into the
  // ONE token that says so ("ctrl+j/k scroll"). Only the HINT collapses: the
  // handler keeps resolving every one of those keys, so no binding is lost with
  // its alias.
  function contentKeys() {
    const documentScroll = palette.scrollHint(scrollKeys.previewScrollKeys(), 'scroll');
    // S12 and S9 splice their live-state tokens in beside the actions: the
    // order toggle next to the search hint, the reload outcome where `r` sits.
    const [selectKey, searchKey, ...actionKeys] = CONTENT_KEYS;
    return [
      selectKey,
      documentScroll,
      orderKey(),
      searchKey,
      reloadKey(),
      ...actionKeys,
    ].filter((entry) => entry !== null && entry !== undefined);
  }

  // S9 («el r en odd no hace nada pareceria»): a reload that finds the same
  // directory changes no row, so the only way the key can report that it ran is
  // its own token. Like `s sort: …` it names live state — the outcome of the
  // LAST reload — and it never claims a success the reload did not report.
  //
  // The token keeps two spellings: the full one (`r reload failed`) wherever the
  // whole legend fits, and the compact one (`r reloaded`, `r failed`) for the
  // short tier, because the reported ~60-column row has room for the outcome only
  // from `o open`'s cells (see RELOAD_PRIORITY).
  function reloadKey() {
    let text = `${RELOAD_KEY} reload`;
    let short = RELOAD_KEY;
    if (reloadState === 'reloaded') {
      text = `${RELOAD_KEY} reloaded`;
      short = text;
    } else if (reloadState === 'failed') {
      text = `${RELOAD_KEY} reload failed`;
      short = `${RELOAD_KEY} failed`;
    }
    return { key: RELOAD_KEY, text, short, priority: RELOAD_PRIORITY };
  }

  // S3: ←/→ scroll the list a screenful. There is no page to move to, so the
  // window simply moves over the one list and the focused document follows it
  // into the new screen when it scrolled out of view.
  function scrollList(step) {
    const costs = listCosts();
    if (costs.length === 0) return;
    const budget = Math.max(1, bodyRows);
    const target = layout.shiftWindow(costs, { budget, start: state.listStart, step });
    if (target === state.listStart) return;
    state.listStart = target;
    const win = layout.scrollWindow(costs, { budget, index: target, start: target });
    state.listStart = win.start;
    if (state.index < win.start || state.index >= win.end) {
      state.index = win.start;
      state.scroll = 0;
      ensureEntry(current());
    }
    repaint();
  }

  // S12: `s` alternates the loader's recency order with a case-insensitive
  // alphabetical one. The focused document is remembered by identity and
  // re-found in the new sequence, so the reader keeps reading the SAME document
  // instead of whatever lands at the old index; the document's own reading
  // position is untouched, because it is still the same document. The list
  // window is re-anchored on the new position so the focus is painted even when
  // its alphabetical place is far from the old one.
  function toggleOrder() {
    const focused = current();
    const focusedKey = focused ? (focused.path || focused.name) : null;
    state.order = state.order === ORDER.NAME ? ORDER.RECENT : ORDER.NAME;
    const list = shown();
    let next = Math.min(state.index, Math.max(0, list.length - 1));
    if (focusedKey !== null) {
      const at = list.findIndex((docEntry) => docEntry && (docEntry.path || docEntry.name) === focusedKey);
      if (at >= 0) next = at;
    }
    state.index = Math.max(0, next);
    const win = layout.scrollWindow(listCosts(), { budget: Math.max(1, bodyRows), index: state.index, start: 0 });
    state.listStart = win.start;
    ensureEntry(current());
    repaint();
  }

  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    const title = titleText();
    if (w < MIN_WIDTH || height < 4) {
      return [pad(helpers, fit(helpers, `${title} — enlarge the terminal`, w), w)].slice(0, Math.max(1, Math.min(height, 1)));
    }
    const list = shown();
    if (state.index >= list.length) state.index = Math.max(0, list.length - 1);
    // S3: the shared 30/70 reader rule owns this geometry, so ODD matches the
    // issues reader with the smaller list index and the larger reading pane.
    // CARD_PADDING covers the frame's own `│ ` and ` │` cells, so this inner
    // width fills the terminal exactly: the right border belongs in the last
    // cell (S24/S27 — no trailing slack, corners and edges stay aligned).
    const inner = layout.innerWidth(w);
    const panes = layout.paneWidths(inner, { listShare: layout.READER_LIST_SHARE });
    const listWidth = panes.left;
    listWidthCache = listWidth;
    const rightWidth = panes.right;
    // S8: the fixed chrome is reserved FIRST — top rule, search row, the ONE
    // footer legend and the bottom rule — and whatever rows remain is the
    // body, so page capacity is the real viewport height, not a guessed 20.
    bodyRows = Math.max(1, height - 4);
    const docEntry = current();
    const entry = docEntry ? ensureEntry(docEntry) : null;
    // The document reflows to the pane width: a resize re-renders it rather
    // than clipping an earlier, wider layout.
    if (entry && entry.status === 'ready' && entry.width !== rightWidth) {
      renderLines(entry, entry.text, rightWidth);
    }
    clampScroll();
    const totalLines = entry && entry.status === 'ready' ? entry.lines.length : 0;
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    const lines = [];
    // S11/S13: the header uses the palette — the title takes the theme's
    // `dim` title role (bold), the `·` separator is the dim label role —
    // while the COUNT alone is muted, so a number never competes with the title
    // for attention and the title never competes with the accent a button owns.
    const parts = titleParts();
    const topLeft = `${border('╭─')} ${palette.title(theme, parts.name)}${palette.label(theme, ' · ')}${palette.count(theme, parts.count)} `;
    // S27: no top-right `esc` text (the /changes frame has none) — the corner
    // and the right border stay in the terminal's last cell.
    const topRight = border('─╮');
    lines.push(`${topLeft}${border('─'.repeat(Math.max(0, w - measure(helpers, topLeft) - measure(helpers, topRight))))}${topRight}`);

    // S13/S26: one row carries the search widget and the reading position. S4:
    // the key that opens the box lives in the footer now, never in this row, and
    // S3 removed the page marker with the pager. S11: the `›` prompt and the
    // idle `Search` label paint the dim LABEL role while a live query is the
    // VALUE role, in and out of the box.
    const searchText = state.searching
      ? `${palette.label(theme, '› ')}${palette.value(theme, `${state.query}█`)}`
      : (state.query
        ? `${palette.label(theme, '› ')}${palette.value(theme, state.query)}`
        : `${palette.label(theme, '› ')}${palette.label(theme, 'Search')}`);
    // S14: the reading position of an open document keeps the right edge.
    //
    // S10 («pagina/linea ... sale el 1-, esta demas»): the position names how
    // far this screen reaches against the document total. The old
    // `start-end/total` range restated the window's first line — always the line
    // just above the pane, and `1` at the top — so the useful number is kept and
    // the redundant one dropped.
    const visibleThrough = Math.min(totalLines, Math.max(0, state.scroll) + Math.max(1, bodyRows));
    const scrollMark = totalLines > 0 ? `${visibleThrough}/${totalLines}` : '';
    const searchCell = withRight(helpers, searchText, scrollMark, inner);
    lines.push(`${border('│')} ${pad(helpers, searchCell, inner)} ${border('│')}`);

    const listLines = [];
    if (docs.length === 0) {
      listLines.push(paint(theme, 'muted', EMPTY_LIST));
      listLines.push(paint(theme, 'dim', EMPTY_HINT));
    } else if (list.length === 0) {
      listLines.push(paint(theme, 'muted', '(no matches)'));
    } else {
      // S3/S5/S17: each name wraps over the rows it needs — at spaces and at
      // its own hyphens — and the ONE window paints the documents whose wrapped
      // rows fit the body budget, keeping the focused document inside it.
      const win = listWindow();
      state.listStart = win.start;
      for (let at = win.start; at < win.end; at += 1) {
        const focused = at === state.index;
        const rows = labelRows(String((list[at] && list[at].name) || ''), listWidth, focused ? '▸ ' : '  ', '  ');
        for (const row of rows) {
          listLines.push(highlight(theme, pad(helpers, row, listWidth), focused));
        }
      }
    }
    const contentLines = [];
    if (!docEntry) {
      if (docs.length === 0) {
        contentLines.push(paint(theme, 'muted', EMPTY_LIST));
        contentLines.push(paint(theme, 'dim', EMPTY_HINT));
      } else {
        contentLines.push(paint(theme, 'muted', `(no matches for filter "${state.query}")`));
      }
    } else if (entry.status === 'error') {
      contentLines.push(paint(theme, 'error', `unreadable: ${entry.error}`));
    } else if (entry.status === 'ready' && entry.lines.length === 0) {
      contentLines.push(paint(theme, 'muted', '(empty document)'));
    } else if (entry.status === 'ready') {
      contentLines.push(...entry.lines.slice(state.scroll, state.scroll + bodyRows));
    } else {
      contentLines.push(paint(theme, 'muted', 'loading…'));
    }
    // A failed open is shown, never claimed as success: the error rides
    // above the document so the untouched selection it explains stays visible.
    if (openError) {
      contentLines.unshift(paint(theme, 'error', `open failed: ${openError}`));
    }
    for (let row = 0; row < bodyRows; row += 1) {
      const left = pad(helpers, listLines[row] ?? '', listWidth);
      const right = pad(helpers, contentLines[row] ?? '', rightWidth);
      lines.push(`${border('│')} ${left} ${divider} ${right} ${border('│')}`);
    }
    lines.push(`${border('│')} ${pad(helpers, palette.legendRow(theme, state.searching ? SEARCH_KEYS : contentKeys(), inner, (text) => measure(helpers, text)), inner)} ${border('│')}`);
    lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
    return lines.map((line) => pad(helpers, line, w));
  }

  function selectNext(step) {
    const list = shown();
    if (list.length === 0) return;
    state.index = (state.index + step + list.length) % list.length;
    state.scroll = 0;
    ensureEntry(current());
    repaint();
  }

  // The `T`/`/` name filter (key-consistency K3/S5, same behaviour as
  // the wizard's search box and the issues viewer): typing narrows the
  // list live, Backspace edits, Enter/Esc leaves the box with the filter
  // kept. Anything else is ignored while filtering.
  function handleSearchInput(data) {
    if (keyMatches(helpers, data, ['enter', 'return'])) {
      state.searching = false;
      state.index = 0;
      state.listStart = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.searching = false;
      state.index = 0;
      state.listStart = 0;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      state.query = state.query.slice(0, -1);
      state.index = 0;
      state.listStart = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    // S4: Delete clears the WHOLE query while the search input is active;
    // Backspace above keeps deleting one character. The box stays open so a
    // new query needs no extra keypress.
    if (keyMatches(helpers, data, ['delete'])) {
      state.query = '';
      state.index = 0;
      state.listStart = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    const typed = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
    if (typeof typed === 'string' && [...typed].length === 1) {
      state.query += typed;
      state.index = 0;
      state.listStart = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    return false;
  }

  function handleInput(data) {
    if (isKeyRelease(helpers, data)) return;
    // The wheel can also arrive as raw SGR/X10 bytes on hosts that do not
    // dispatch mouse events: both paths scroll the preview, never the list.
    const wheel = wheelDeltaFromInput(data);
    if (wheel !== undefined) {
      scrollBy(wheel);
      return;
    }
    // While filtering, only the search keys answer: Enter/Esc leaves the
    // box with the filter kept, typing narrows live. Everything else —
    // arrows, toggles, `o` — is ignored until the box is left.
    if (state.searching) {
      if (handleSearchInput(data)) return;
      return;
    }
    // S1: the shared binding helper owns the preview scroll keys, so this
    // handler and the footer legend can never disagree about which pair is
    // live. ctrl+j/k page wherever the host reports them apart from Enter,
    // ctrl+shift+j/k and the printable J/K are working alternates, ctrl+d/u
    // keep their half-page step, and bare LF/ctrl+j is not a scroll key — a
    // legacy terminal sends it for Enter too.
    const scrollAction = scrollKeys.resolveScrollAction(helpers, data);
    if (scrollAction) {
      const page = Math.max(1, bodyRows - 1);
      const halved = scrollAction === scrollKeys.ACTIONS.HALF_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_UP;
      const step = halved ? Math.max(1, Math.floor(page / 2)) : page;
      const down = scrollAction === scrollKeys.ACTIONS.PAGE_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_DOWN;
      scrollBy(down ? step : -step);
      return;
    }
    if (keyMatches(helpers, data, ['escape', 'ctrl+c', 'q'])) {
      if (typeof done === 'function') done(null);
      return;
    }
    // `t`/`T` or `/` opens the name filter on the current query, for editing.
    if (keyMatches(helpers, data, ['t', 'T', '/'])) {
      state.searching = true;
      repaint();
      return;
    }
    // S12: `s` alternates the list order (recency ↔ alphabetical). The filter
    // box returns above, so the letter stays a query character while it is
    // open — the order never flips under someone typing.
    if (keyMatches(helpers, data, [ORDER_KEY])) {
      toggleOrder();
      return;
    }
    // `o` opens the focused document outside Pi through $VISUAL/$EDITOR:
    // the injected opener reports honestly, so a missing editor or a
    // failed spawn shows its error instead of failing silently.
    if (keyMatches(helpers, data, ['o'])) {
      const focused = current();
      if (!focused) return;
      if (typeof openExternal !== 'function') {
        openError = 'the viewer has no external opener';
        repaint();
        return;
      }
      const target = (typeof focused.path === 'string' && focused.path.length > 0)
        ? focused.path
        : focused.name;
      let result = null;
      try {
        result = openExternal(target);
      } catch (err) {
        result = { ok: false, error: (err && err.message) || 'open failed' };
      }
      Promise.resolve(result).then((settled) => {
        if (settled && settled.ok === true) openError = null;
        else openError = (settled && settled.error) || 'open failed';
        repaint();
      }).catch((err) => {
        openError = (err && err.message) || 'open failed';
        repaint();
      });
      return;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      selectNext(1);
      return;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      selectNext(-1);
      return;
    }
    // D3: left/right scroll the ACTIVE list and nothing else (S3: a screenful of
    // the one list, never a page); Tab never touches a single-dataset reader.
    if (keyMatches(helpers, data, ['right', ']'])) {
      scrollList(1);
      return;
    }
    if (keyMatches(helpers, data, ['left', '['])) {
      scrollList(-1);
      return;
    }
    if (keyMatches(helpers, data, ['end'])) {
      state.scroll = Number.MAX_SAFE_INTEGER;
      clampScroll();
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['home'])) {
      state.scroll = 0;
      repaint();
      return;
    }
    // S9: `r` re-lists AND re-reads. The listing is refreshed from disk, every
    // cached document is dropped so the open one is read again (an edit cannot
    // hide behind a cached body), and the outcome rides the footer token so a
    // reload that changes no row is still visible. A reload that cannot re-read
    // the directory keeps the documents it already has and reports the failure
    // instead of appearing to do nothing. S21: `reloadDocs` may answer a
    // PROMISE — the interactive caller re-lists through the awaited Git reader,
    // so a slow history walk is never a blocking read inside this key handler
    // (the view keeps painting and the outcome lands when the listing does).
    if (keyMatches(helpers, data, [RELOAD_KEY])) {
      if (typeof reloadDocs !== 'function') return;
      let result = null;
      try {
        result = reloadDocs();
      } catch {
        reloadState = 'failed';
        repaint();
        return;
      }
      const settle = (next) => {
        if (!next || next.ok !== true || !Array.isArray(next.docs)) {
          reloadState = 'failed';
          repaint();
          return;
        }
        docs = next.docs.slice();
        entries.clear();
        reloadState = 'reloaded';
        // The filter survives a reload: clamp the selection into the
        // still-visible list, exactly like the issues viewer keeps its query.
        if (state.index >= shown().length) state.index = Math.max(0, shown().length - 1);
        state.scroll = 0;
        ensureEntry(current());
        repaint();
      };
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(settle).catch(() => {
          reloadState = 'failed';
          repaint();
        });
      } else {
        settle(result);
      }
    }
  }

  function invalidate() {}

  // S21: the list can be handed to an OPEN view a second time — the command
  // paints the cheap local scan at once and applies the git-ranked order when
  // the checkout's history walk answers, so the viewer never waits on git to
  // appear and a slow walk never freezes it. This behaves like the `s` order
  // toggle, never like a reload: the focused document is re-found by IDENTITY
  // (the reader keeps reading the same file instead of whatever lands at the old
  // index), the window re-anchors on its new position, and the rendered
  // documents are KEPT — only the order moved, so re-reading them would cost the
  // reader the pane they are already reading (and could only surface a
  // difference the settled order never claimed). An answer that is not a list
  // leaves the open view exactly as it is.
  function applyDocs(next) {
    if (!Array.isArray(next)) return;
    const focused = current();
    const focusedKey = focused ? (focused.path || focused.name) : null;
    docs = next.slice();
    const list = shown();
    let target = Math.min(state.index, Math.max(0, list.length - 1));
    if (focusedKey !== null) {
      const at = list.findIndex((docEntry) => docEntry && (docEntry.path || docEntry.name) === focusedKey);
      if (at >= 0) target = at;
    }
    state.index = Math.max(0, target);
    const win = layout.scrollWindow(listCosts(), { budget: Math.max(1, bodyRows), index: state.index, start: 0 });
    state.listStart = win.start;
    ensureEntry(current());
    repaint();
  }

  // The selected document starts loading as soon as the view exists, so the
  // first frame the host paints already carries content instead of a
  // placeholder.
  ensureEntry(current());

  return { render, handleInput, invalidate, handleMouse, applyDocs, state };
}

module.exports = { createOddView, CONTENT_KEYS, SEARCH_KEYS, EMPTY_LIST, EMPTY_HINT };

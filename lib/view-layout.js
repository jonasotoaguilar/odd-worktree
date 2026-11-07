'use strict';
// Shared layout for the full-screen readers (issues-view, odd-view). One place
// decides how wide the left list is and how many of its wrapped rows fit the
// real body budget, so the two readers cannot drift apart the way they did when
// each kept its own 34/36-column cap and its own fixed page size (S3, S5, S8,
// D3).
//
// S3 also decides HOW the list moves: the issues and ODD readers scroll one
// continuous window (`scrollWindow`/`shiftWindow`) with no page navigation. The
// discrete `paginate` bounds the retired full-screen worktree detail was built
// on stay exported for the layout tests and any paginated caller.
//
// Everything here is pure and injected: width measurement arrives through the
// caller's TUI helpers, and no module-level state exists.
//
// Widths are counted in terminal cells, so a wide character costs what the
// host says it costs, never a codepoint count.

// The frame's own cells: `│ ` on the left and ` │` on the right.
const CARD_PADDING = 4;
// The divider between the two panes: ` │ `.
const DIVIDER = 3;
// The preview keeps at least this many cells on a terminal that can afford
// it, and shrinks first on one that cannot.
const PREVIEW_MIN = 24;
// The left pane never drops below this while the terminal has room for it.
const LIST_MIN = 8;
// The default share is the 40% list / 60% preview split (S5) the retired
// full-screen worktree detail was built on; the readers pass their own below.
const LIST_SHARE = 0.4;
// The issues and ODD readers ask for the smaller 30% share instead (S3): their
// list is a short index of titles, so the reading pane gets the room.
const READER_LIST_SHARE = 0.3;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampInt(value, min, max) {
  const low = Math.ceil(num(min));
  const high = Math.floor(num(max));
  const wanted = Math.round(num(value));
  if (high <= low) return Math.max(1, Math.min(low, high));
  return Math.max(low, Math.min(high, wanted));
}

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the plain codepoint count.
  }
  return [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].length;
}

/** Inner card width: the outer width minus the frame's own cells. */
function innerWidth(width) {
  return Math.max(1, Math.floor(num(width)) - CARD_PADDING);
}

/**
 * The two pane widths for one inner width.
 *
 * `options.listShare` selects the list's share of the inner width; it defaults
 * to the 40% the retired full-screen worktree detail was built on, and the
 * issues and ODD readers pass `READER_LIST_SHARE` for their smaller 30% index
 * (S3). The floors below
 * only speak on a terminal too narrow for the split: both panes stay positive
 * and the list keeps its minimum before the divider does.
 *
 * @param {number} inner the inner card width in cells.
 * @param {{listShare?: number}} [options] the list's share of `inner`.
 * @returns {{left: number, right: number, divider: number}}
 */
function paneWidths(inner, options = {}) {
  const usable = Math.max(2, Math.floor(num(inner)));
  const asked = num(options && options.listShare);
  const share = asked > 0 && asked < 1 ? asked : LIST_SHARE;
  const listFloor = Math.min(LIST_MIN, Math.max(1, usable - DIVIDER - 1));
  let left = Math.round(usable * share);
  if (left < listFloor) left = listFloor;
  const previewFloor = Math.min(PREVIEW_MIN, Math.max(1, Math.floor(usable / 3)));
  const maxLeft = usable - previewFloor - DIVIDER;
  if (left > maxLeft) left = Math.max(listFloor, maxLeft);
  left = clampInt(left, 1, Math.max(1, usable - DIVIDER - 1));
  const right = Math.max(1, usable - left - DIVIDER);
  return { left, right, divider: DIVIDER };
}

/**
 * ONE list label's break opportunities.
 *
 * Whitespace separates words, and a hyphen ends a segment too, so a
 * hyphenated name splits at its own separators instead of mid-word (S17).
 * `glue` says the piece attaches directly to the one before it — a hyphen
 * stays with the piece it closes, which is what makes the join lossless.
 */
function labelAtoms(text) {
  const atoms = [];
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const pieces = word.split(/(?<=-)/);
    for (let at = 0; at < pieces.length; at += 1) {
      atoms.push({ text: pieces[at], glue: at > 0 });
    }
  }
  return atoms;
}

/**
 * ONE list label wrapped to the pane width.
 *
 * `first` prefixes the first row (the focus marker) and `rest` every
 * continuation row, both measured out of the available text width so the
 * first row never loses a cell to the marker. Rows break at spaces and at
 * hyphens; only a segment wider than the whole pane is hard-broken, because a
 * title is never truncated to fit a row budget (S3, S17).
 */
function wrapLabel(helpers, text, width, options = {}) {
  const first = String(options.first ?? '  ');
  const rest = String(options.rest ?? '  ');
  const total = Math.max(1, Math.floor(num(width)));
  const firstRoom = Math.max(1, total - measure(helpers, first));
  const restRoom = Math.max(1, total - measure(helpers, rest));
  const rows = [];
  let room = firstRoom;
  let line = '';
  const push = (value, nextRoom) => {
    rows.push(value);
    room = nextRoom;
    line = '';
  };
  for (const atom of labelAtoms(text)) {
    const glued = line === '' ? atom.text : (atom.glue ? `${line}${atom.text}` : `${line} ${atom.text}`);
    if (measure(helpers, glued) <= room) {
      line = glued;
      continue;
    }
    if (line !== '') push(line, restRoom);
    let tail = atom.text;
    while (measure(helpers, tail) > room) {
      const cut = hardCut(helpers, tail, room);
      if (cut === '') break;
      push(cut, restRoom);
      tail = tail.slice(cut.length);
    }
    line = tail;
  }
  if (line !== '' || rows.length === 0) rows.push(line);
  return rows.map((row, at) => `${at === 0 ? first : rest}${row}`);
}

// The longest prefix of `text` that fits `room` cells, at least one character
// so a pane narrower than a single glyph still advances.
function hardCut(helpers, text, room) {
  const chars = [...text];
  let cut = '';
  for (const char of chars) {
    if (measure(helpers, cut + char) > room) break;
    cut += char;
  }
  return cut === '' ? chars[0] ?? '' : cut;
}

/** How many screen rows one wrapped label costs at `width`. */
function rowCost(helpers, text, width, options = {}) {
  return wrapLabel(helpers, text, width, options).length;
}

/**
 * Page bounds for a list whose items cost `rowCosts[i]` screen rows.
 *
 * The discrete page bounds are kept from the retired full-screen worktree
 * detail; the issues and ODD readers use `scrollWindow`/`shiftWindow` below
 * instead (S3). A page holds as many
 * whole items as fit `budget` rows; an item is never split across pages, an
 * item taller than the budget still gets its own page, and every item lands on
 * exactly one page (S8: capacity follows the wrapped titles and the real body
 * height, never a fixed item count).
 *
 * @returns {Array<{start: number, end: number, rows: number}>}
 */
function paginate(rowCosts, budget) {
  const list = Array.isArray(rowCosts) ? rowCosts : [];
  const size = Math.max(1, Math.floor(num(budget)));
  const pages = [];
  let start = 0;
  while (start < list.length) {
    let end = start;
    let rows = 0;
    while (end < list.length) {
      const cost = Math.max(1, Math.ceil(num(list[end])));
      if (end > start && rows + cost > size) break;
      rows += cost;
      end += 1;
    }
    pages.push({ start, end, rows });
    start = end;
  }
  if (pages.length === 0) pages.push({ start: 0, end: 0, rows: 0 });
  return pages;
}

/** The (clamped) page that holds `index`, 1-based like the footer reads it. */
function pageForIndex(pages, index) {
  const bounds = Array.isArray(pages) && pages.length > 0 ? pages : [{ start: 0, end: 0, rows: 0 }];
  const wanted = Math.max(0, Math.floor(num(index)));
  for (let at = 0; at < bounds.length; at += 1) {
    if (wanted >= bounds[at].start && wanted < bounds[at].end) {
      return { page: at + 1, bounds: bounds[at] };
    }
  }
  const last = bounds.length - 1;
  return { page: last + 1, bounds: bounds[last] };
}

/** The requested (clamped) page with its 1-based number and total count. */
function pageOf(rowCosts, options = {}) {
  const pages = paginate(rowCosts, options.budget);
  const wanted = Math.max(1, Math.floor(num(options.page)) || 1);
  const page = Math.min(wanted, pages.length);
  return { page, pageCount: pages.length, start: pages[page - 1].start, end: pages[page - 1].end };
}

// One item's row cost, clamped to at least one row so a zero or hostile cost
// can never make the window consume unbounded items.
function costOf(value) {
  return Math.max(1, Math.ceil(num(value)));
}

function toCosts(rowCosts) {
  return Array.isArray(rowCosts) ? rowCosts.map(costOf) : [];
}

// An item index clamped into `0..max`. Unlike `clampInt` this is happy with a
// zero-width range, which a one-item list has.
function clampIndex(value, max) {
  const wanted = Math.floor(num(value));
  if (!Number.isFinite(wanted)) return 0;
  return Math.max(0, Math.min(Math.max(0, max), wanted));
}

// The index just past the last item fully inside `budget` rows from `start`.
// The first item is always included, so an item taller than the budget still
// gets a window of its own.
function windowEnd(costs, start, budget) {
  let rows = 0;
  let end = start;
  while (end < costs.length) {
    if (end > start && rows + costs[end] > budget) break;
    rows += costs[end];
    end += 1;
  }
  return end;
}

// The furthest a window may start while still holding `index` inside `budget`
// rows — `index` sits on the window's last row.
function windowStartFor(costs, index, budget) {
  let rows = costs[index];
  let at = index;
  while (at > 0 && rows + costs[at - 1] <= budget) {
    rows += costs[at - 1];
    at -= 1;
  }
  return at;
}

/**
 * ONE continuous list window: no pages, only the rows that fit the body.
 *
 * The reader keeps its scroll position as the index of the first painted item
 * (`start`), and this decides the window that paints `index` without leaving
 * blank rows at the bottom while items remain above it (S3). The focused item
 * is always inside the returned window: a selection below the window pushes it
 * down until the focused row sits on its last row, and a selection above it
 * pulls it back up.
 *
 * @param {number[]} rowCosts the screen rows each item needs, in list order.
 * @param {{budget?: number, index?: number, start?: number}} [options] the body
 *   row budget, the focused item and the wanted first item.
 * @returns {{start: number, end: number, rows: number, above: boolean, below: boolean}}
 *   the painted item range, the rows it spends and whether items remain on
 *   either side of it.
 */
function scrollWindow(rowCosts, options = {}) {
  const costs = toCosts(rowCosts);
  const count = costs.length;
  if (count === 0) return { start: 0, end: 0, rows: 0, above: false, below: false };
  const budget = Math.max(1, Math.floor(num(options && options.budget)));
  const index = clampIndex(options && options.index, count - 1);
  const tailStart = windowStartFor(costs, count - 1, budget);
  let start = clampIndex(options && options.start, count - 1);
  // A window that stops short of the list's end shows its last full screen
  // instead of trailing blank rows.
  if (start > tailStart) start = tailStart;
  if (index < start) {
    start = index;
  } else if (index >= windowEnd(costs, start, budget)) {
    const wanted = windowStartFor(costs, index, budget);
    // Prefer a full window at the bottom, but never at the cost of hiding the
    // focused row: keep the focused window when the full one would drop it.
    start = (wanted > tailStart && index < windowEnd(costs, tailStart, budget)) ? tailStart : wanted;
  }
  const end = windowEnd(costs, start, budget);
  let rows = 0;
  for (let at = start; at < end; at += 1) rows += costs[at];
  return { start, end, rows, above: start > 0, below: end < count };
}

/**
 * The window start `step` screenfuls away from `start`, for ←/→ scrolling.
 *
 * A forward step begins at the item just past the last visible one, a backward
 * step returns to the screen above it, and a step that would run past either
 * end clamps to the first or the last FULL window — so scrolling never parks on
 * a half-empty screen (S3).
 *
 * @param {number[]} rowCosts the screen rows each item needs, in list order.
 * @param {{budget?: number, start?: number, step?: number}} [options]
 * @returns {number} the index of the first item to paint.
 */
function shiftWindow(rowCosts, options = {}) {
  const costs = toCosts(rowCosts);
  const count = costs.length;
  if (count === 0) return 0;
  const budget = Math.max(1, Math.floor(num(options && options.budget)));
  const at = clampIndex(options && options.start, count - 1);
  const step = Math.trunc(num(options && options.step));
  if (step === 0) return at;
  const tailStart = windowStartFor(costs, count - 1, budget);
  if (step > 0) {
    let cursor = at;
    for (let moved = 0; moved < step; moved += 1) {
      const end = windowEnd(costs, cursor, budget);
      if (end >= count) return Math.min(cursor, tailStart);
      cursor = end;
    }
    return Math.min(cursor, tailStart);
  }
  let cursor = at;
  for (let moved = 0; moved < -step; moved += 1) {
    if (cursor <= 0) return 0;
    cursor = windowStartFor(costs, cursor - 1, budget);
  }
  return Math.max(0, cursor);
}

module.exports = {
  CARD_PADDING,
  DIVIDER,
  PREVIEW_MIN,
  LIST_MIN,
  READER_LIST_SHARE,
  innerWidth,
  measure,
  paneWidths,
  wrapLabel,
  rowCost,
  paginate,
  pageForIndex,
  pageOf,
  scrollWindow,
  shiftWindow,
};

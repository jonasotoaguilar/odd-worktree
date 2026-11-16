'use strict';
// The file picker's preview pane (S11, S12): the pure half of `/files`' right
// pane. It reads no file and paints nothing itself — `lib/files-index.js` already
// bounded the read, and the view paints these cells with the theme — so one
// `readFilePreview` result becomes an exact row/cell list here and can be
// asserted without a repository, a theme or a live highlighter.
//
// What the pane owns:
//   - its own rounded box inside the given width, with the `line/total` position
//     embedded at the right of the TOP border;
//   - a dim gutter numbering each file line once, its wrapped continuation rows
//     aligned under the same text column;
//   - a left-side wrap instead of an ellipsis: a line wider than the pane
//     continues on the next row, so the numbers show it is the same line;
//   - the optional injected highlighter: it runs ONCE per call on the bounded
//     text, and a highlighted row goes through the injected ANSI-aware wrapper so
//     a colour run survives the wrap;
//   - the honest notices: a binary/error message and the truncation row.
//
// Plain text is measured and clipped as PLAIN text; a role is attached afterwards
// (AGENTS.md invariant 17). The measurement helpers are injected (`metrics`), never
// statically imported: `visibleWidth`, `truncateToWidth` and `wrapTextWithAnsi`.
//
// Cell roles are exactly the three the view paints: `dim` is the gutter, `border`
// is the box frame, and `text` is every content cell (a source line, a notice, the
// position label). A highlighted cell keeps the `text` role and already carries
// the highlighter's own escapes, so the view never re-tones it.

const BOX_TOP_LEFT = '╭';
const BOX_TOP_RIGHT = '╮';
const BOX_BOTTOM_LEFT = '╰';
const BOX_BOTTOM_RIGHT = '╯';
const BOX_HORIZONTAL = '─';
const BOX_VERTICAL = '│';
// The box's two vertical border columns and its top and bottom border rows.
const BOX_COLUMNS = 2;
const BOX_ROWS = 2;
// The box paints only when the body can hold its two border rows plus one
// usable content row, and when one cell is left between its border columns.
const BOX_MIN_BODY_ROWS = BOX_ROWS + 1;
const BOX_MIN_WIDTH = BOX_COLUMNS + 1;
// One space between the line-number gutter and its text.
const GUTTER_GAP = ' ';
// The row appended to a preview the reader cut short.
const TRUNCATED_NOTICE = '… preview truncated.';
// Stripped from file text before it reaches a cell: a file's own escape
// sequences are data, never paint, and a control character could break the box.
const OSC_ESCAPE_PATTERN = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const NON_OSC_ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f-\u009f]/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A whole, non-negative number; anything else is nothing. */
function whole(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** File text as terminal-safe plain text: no escape sequence, no control character. */
function sanitize(value) {
  return String(value == null ? '' : value)
    .replace(OSC_ESCAPE_PATTERN, '')
    .replace(NON_OSC_ANSI_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '');
}

/** One preview line: a tab is two plain cells, so the box stays aligned. */
function displayPreviewText(value) {
  return sanitize(value).replace(/\t/g, '  ');
}

/**
 * The rows one plain line wraps into at `width` cells, cut on grapheme
 * boundaries only, so a wide grapheme is never split across two rows. A
 * non-positive width never wraps; a grapheme wider than a whole row still gets
 * its own row (the content cell decides whether it fits the pane).
 */
function wrapByCells(text, width, metrics) {
  if (width <= 0) return [text];
  const rows = [];
  let row = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = metrics.visibleWidth(segment);
    if (used > 0 && used + cells > width) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += segment;
    used += cells;
  }
  rows.push(row);
  return rows;
}

/** An ANSI-aware wrap that answers nothing usable falls back to the whole line. */
function wrapHighlighted(text, width, metrics) {
  if (width <= 0) return [text];
  try {
    const rows = metrics.wrapTextWithAnsi(text, width);
    if (Array.isArray(rows) && rows.length > 0 && rows.every((row) => typeof row === 'string')) return rows;
  } catch {
    // Fall through to the unpainted line.
  }
  return [text];
}

/**
 * The highlighter's lines, or `undefined` for the plain preview. Every failure —
 * no highlighter, no path resolver, an unknown language, a throw from either, a
 * list that does not line up with the file — degrades whole, never per line, so
 * the pane is never blank, never an error and never a partial paint. The
 * highlighter runs ONCE per call, on the text the byte budget already bounded.
 */
function highlightedLines(lines, highlight, languageForPath, path) {
  if (lines.length === 0) return undefined;
  if (typeof highlight !== 'function' || typeof languageForPath !== 'function') return undefined;
  if (typeof path !== 'string' || path.length === 0) return undefined;
  try {
    const language = languageForPath(path);
    if (typeof language !== 'string' || language.length === 0) return undefined;
    const painted = highlight(lines.join('\n'), language);
    if (!Array.isArray(painted) || painted.length !== lines.length) return undefined;
    if (!painted.every((line) => typeof line === 'string')) return undefined;
    return painted;
  } catch {
    return undefined;
  }
}

/**
 * The lines the pane paints, in file order: one per source line with its real
 * number, and — for a truncated read — the unnumbered notice row after them. A
 * binary or error preview is one message line with no number and no position.
 */
function previewLines(preview, highlight, languageForPath, path) {
  const value = preview && typeof preview === 'object' ? preview : { kind: 'error', message: '' };
  if (value.kind === 'binary' || value.kind === 'error') {
    return {
      kind: value.kind,
      total: 0,
      truncated: false,
      lines: [{ text: displayPreviewText(value.message), number: undefined, highlighted: false }],
    };
  }
  if (value.kind !== 'text' || !Array.isArray(value.lines)) {
    return {
      kind: 'error',
      total: 0,
      truncated: false,
      lines: [{ text: displayPreviewText(value.message), number: undefined, highlighted: false }],
    };
  }
  const plain = value.lines.map(displayPreviewText);
  const painted = highlightedLines(plain, highlight, languageForPath, path);
  const lines = plain.map((text, index) => {
    const paintedText = painted === undefined ? text : painted[index];
    return { text: paintedText, number: index + 1, highlighted: paintedText !== text };
  });
  if (value.truncated === true) lines.push({ text: TRUNCATED_NOTICE, number: undefined, highlighted: false });
  return { kind: 'text', total: plain.length, truncated: value.truncated === true, lines };
}

/** The last line that starts at or before `row`; a continuation belongs to its line. */
function lineAtRow(rowStarts, row) {
  let low = 0;
  let high = Math.max(0, rowStarts.length - 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rowStarts[middle] <= row) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The file line the top painted row belongs to, walking back over the notice row. */
function topLineNumber(built, rowStarts, row) {
  if (built.lines.length === 0) return undefined;
  let index = lineAtRow(rowStarts, row);
  while (index > 0 && built.lines[index].number === undefined) index -= 1;
  return built.lines[index].number;
}

/** `top/total`, plus `+` when the reader truncated the file; undefined without line numbers. */
function positionLabel(built, rowStarts, scroll) {
  if (built.kind !== 'text') return undefined;
  const top = topLineNumber(built, rowStarts, scroll) ?? built.total;
  return `${Math.min(built.total, top)}/${built.total}${built.truncated ? '+' : ''}`;
}

/**
 * One content row's cells at `interiorWidth`: the dim gutter, one gap, the text
 * and the padding that keeps the box square. A grapheme wider than the text
 * column borrows the gap, and one wider than the whole interior paints its
 * gutter alone rather than breaking the frame.
 */
function contentCells(gutter, text, interiorWidth, metrics) {
  if (interiorWidth <= 0) return [];
  const rawGutterWidth = metrics.visibleWidth(gutter);
  const gutterWidth = Math.min(interiorWidth, rawGutterWidth);
  const shownGutter = gutterWidth === rawGutterWidth ? gutter : metrics.truncateToWidth(gutter, gutterWidth, '');
  const textWidth = metrics.visibleWidth(text);
  const room = Math.max(0, interiorWidth - gutterWidth - GUTTER_GAP.length);
  let gap = GUTTER_GAP;
  let shown = text;
  if (textWidth > room) {
    if (gutterWidth + textWidth <= interiorWidth) gap = '';
    else shown = '';
  }
  const used = gutterWidth + metrics.visibleWidth(gap) + metrics.visibleWidth(shown);
  const padding = ' '.repeat(Math.max(0, interiorWidth - used));
  const cells = [];
  if (shownGutter.length > 0) cells.push({ text: shownGutter, role: 'dim' });
  const content = `${gap}${shown}${padding}`;
  if (content.length > 0) cells.push({ text: content, role: 'text' });
  return cells;
}

/** The box's top border with the position at its right; without a label it is all dashes. */
function topBorderCells(interiorWidth, label, metrics) {
  const cells = [{ text: BOX_TOP_LEFT, role: 'border' }];
  if (label === undefined) {
    if (interiorWidth > 0) cells.push({ text: BOX_HORIZONTAL.repeat(interiorWidth), role: 'border' });
    cells.push({ text: BOX_TOP_RIGHT, role: 'border' });
    return cells;
  }
  const position = interiorWidth > 0 ? metrics.truncateToWidth(label, interiorWidth, '…') : '';
  const positionWidth = Math.min(interiorWidth, metrics.visibleWidth(position));
  const gap = Math.min(1, Math.max(0, interiorWidth - positionWidth));
  const fill = Math.max(0, interiorWidth - positionWidth - gap);
  if (fill > 0) cells.push({ text: BOX_HORIZONTAL.repeat(fill), role: 'border' });
  const tail = `${' '.repeat(gap)}${position}`;
  if (tail.length > 0) cells.push({ text: tail, role: 'text' });
  cells.push({ text: BOX_TOP_RIGHT, role: 'border' });
  return cells;
}

/** The box's bottom border: one border-tone run between its two corners. */
function bottomBorderCells(interiorWidth) {
  const cells = [{ text: BOX_BOTTOM_LEFT, role: 'border' }];
  if (interiorWidth > 0) cells.push({ text: BOX_HORIZONTAL.repeat(interiorWidth), role: 'border' });
  cells.push({ text: BOX_BOTTOM_RIGHT, role: 'border' });
  return cells;
}

/** One boxed content row: the interior framed by the box's two border columns. */
function boxedCells(interior) {
  return [
    { text: BOX_VERTICAL, role: 'border' },
    ...interior,
    { text: BOX_VERTICAL, role: 'border' },
  ];
}

/** The unbordered position row: the label at the pane's right, or a blank row. */
function positionRowCells(width, label, metrics) {
  if (width <= 0) return [];
  if (label === undefined) return [{ text: ' '.repeat(width), role: 'text' }];
  const shown = metrics.visibleWidth(label) <= width ? label : metrics.truncateToWidth(label, width, '…');
  const padding = Math.max(0, width - metrics.visibleWidth(shown));
  return [{ text: `${' '.repeat(padding)}${shown}`, role: 'text' }];
}

/**
 * The preview pane's rows.
 *
 * @param {{kind: string, lines?: string[], message?: string, truncated?: boolean}} preview
 *   the object `lib/files-index.js` `readFilePreview` returns.
 * @param {{width: number, height: number, scroll?: number, highlight?: Function,
 *   languageForPath?: Function, path?: string, metrics: object}} options
 *   `width`/`height` are the pane's cells and rows including the box (when it
 *   paints); `scroll` is the first painted wrapped row.
 * @returns {{rows: Array<{cells: Array<{text: string, role: string}>}>, maxScroll: number, boxed: boolean}}
 */
function previewRows(preview, options) {
  const settings = options || {};
  const metrics = settings.metrics;
  const width = whole(settings.width);
  const height = whole(settings.height);
  const boxed = height >= BOX_MIN_BODY_ROWS && width >= BOX_MIN_WIDTH;
  const interiorWidth = boxed ? width - BOX_COLUMNS : width;
  const contentRows = boxed ? Math.max(0, height - BOX_ROWS) : Math.max(0, height - 1);
  const built = previewLines(
    preview,
    settings.highlight,
    settings.languageForPath,
    settings.path
  );
  const gutterWidth = Math.max(1, String(built.total).length);
  const textWidth = Math.max(0, interiorWidth - gutterWidth - GUTTER_GAP.length);

  // Flatten the lines into painted rows once, so the window, the scroll math and
  // the position all count the same rows.
  const rowStarts = [];
  const painted = [];
  for (const line of built.lines) {
    rowStarts.push(painted.length);
    const rows = line.highlighted
      ? wrapHighlighted(line.text, textWidth, metrics)
      : wrapByCells(line.text, textWidth, metrics);
    painted.push(...rows);
  }
  const totalRows = painted.length;
  const maxScroll = Math.max(0, totalRows - contentRows);
  const requested = Number.isFinite(settings.scroll) ? Math.trunc(settings.scroll) : 0;
  const scroll = Math.max(0, Math.min(maxScroll, requested));
  const rows = [];

  if (width <= 0 || height <= 0) return { rows, maxScroll, boxed };

  const label = positionLabel(built, rowStarts, scroll);
  const contentCellAt = (row) => {
    if (row >= totalRows) return contentCells(' '.repeat(gutterWidth), '', interiorWidth, metrics);
    const lineIndex = lineAtRow(rowStarts, row);
    const line = built.lines[lineIndex];
    const offset = row - rowStarts[lineIndex];
    const gutter = offset === 0 && line.number !== undefined
      ? String(line.number).padStart(gutterWidth)
      : ' '.repeat(gutterWidth);
    return contentCells(gutter, painted[row] == null ? '' : painted[row], interiorWidth, metrics);
  };

  if (boxed) {
    rows.push({ cells: topBorderCells(interiorWidth, label, metrics) });
    for (let offset = 0; offset < contentRows; offset += 1) {
      rows.push({ cells: boxedCells(contentCellAt(scroll + offset)) });
    }
    rows.push({ cells: bottomBorderCells(interiorWidth) });
  } else {
    rows.push({ cells: positionRowCells(width, label, metrics) });
    for (let offset = 0; offset < contentRows; offset += 1) {
      rows.push({ cells: contentCellAt(scroll + offset) });
    }
  }
  return { rows, maxScroll, boxed };
}

module.exports = { previewRows };

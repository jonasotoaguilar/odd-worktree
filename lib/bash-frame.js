'use strict';
// The bash card's FRAME and CLOSING RULE, as rows. Pure: strings in, strings out — no Pi, no
// theme object, no filesystem. A caller passes a `paint(text)` function, so the colour is
// whichever theme role the caller resolved and this module never names a palette.
//
// Two jobs, both on rows the host already drew:
//   * `paintFrame` repaints every frame cell of a row (corners, rules, the side bars) in ONE
//     role, so no row shows two colours side by side and the whole box reads as part of the label
//     it belongs to. Text between the cells is never touched.
//   * `elapsedRow` writes a finished call's duration into the closing rule, right-aligned
//     against the corner (neon) or the end of the bar row (float), when it fits.
//
// Both keep every row's width and re-issue the host's own escapes after what they paint, so the
// content that follows keeps the host's colour.

const ESCAPE = /\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/uy;
const SGR = /\u001b\[[0-9;]*m/gu;

/** The row's visible characters with their raw offsets (SGR and OSC-8 skipped). */
function visibleChars(line) {
  const chars = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === '\u001b') {
      ESCAPE.lastIndex = index;
      const escape = ESCAPE.exec(line);
      if (escape !== null) {
        index += escape[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(line.codePointAt(index));
    chars.push({ char, raw: index });
    index += char.length;
  }
  return chars;
}

/** Columns one character takes: combining marks none, East Asian wide and emoji two. */
function charColumns(char) {
  const code = char.codePointAt(0);
  if (/\p{M}/u.test(char) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

const textColumns = (text) => Array.from(text).reduce((sum, char) => sum + charColumns(char), 0);
const rowColumns = (line) => visibleChars(line).reduce((sum, entry) => sum + charColumns(entry.char), 0);

/** The SGR escapes the host had issued before a raw offset: what is in force there. */
function sgrBefore(row, raw) {
  return (row.slice(0, raw).match(SGR) ?? []).join('');
}

const RULE = '─';
// The first cell of a framed row: the outline's corners and side, or the float bar.
const FIRST_CELLS = new Set(['╭', '│', '╰', '▎']);
const OUTLINE = new Set(['╭', '│', '╰']);
const LAST_CELLS = new Set(['╮', '│', '╯']);

/** The indexes (into `chars`) of the cells that draw the frame on this row. */
function frameCells(chars) {
  const cells = new Set();
  const first = chars.findIndex((entry) => entry.char.trim() !== '');
  if (first < 0 || !FIRST_CELLS.has(chars[first].char)) return cells;
  cells.add(first);
  if (!OUTLINE.has(chars[first].char)) return cells;
  let last = chars.length - 1;
  while (last > first && chars[last].char.trim() === '') last -= 1;
  if (last > first && LAST_CELLS.has(chars[last].char)) cells.add(last);
  if (chars[first].char === '│') return cells;
  // A top or closing rule: its lead, the rule before the corner, and every long run of rule.
  if (chars[first + 1]?.char === RULE) cells.add(first + 1);
  if (cells.has(last) && chars[last - 1]?.char === RULE) cells.add(last - 1);
  for (let index = first; index <= last; index += 1) {
    if (chars[index].char !== RULE) continue;
    let end = index;
    while (end + 1 <= last && chars[end + 1].char === RULE && chars[end + 1].raw === chars[end].raw + 1) end += 1;
    if (end - index + 1 >= 3) for (let at = index; at <= end; at += 1) cells.add(at);
    index = end;
  }
  return cells;
}

/**
 * The row with every frame cell painted by `paint(text)`; the row itself when it has none.
 * A contiguous run is painted in one call, and the host's escapes in force at its end are issued
 * again after it.
 */
function paintFrame(row, paint) {
  const chars = visibleChars(row);
  const cells = frameCells(chars);
  if (cells.size === 0) return row;
  const runs = [];
  for (const index of [...cells].sort((a, b) => a - b)) {
    const run = runs[runs.length - 1];
    if (run !== undefined && run.end === index - 1) run.end = index;
    else runs.push({ start: index, end: index });
  }
  let next = row;
  for (const run of runs.reverse()) {
    const from = chars[run.start].raw;
    const to = chars[run.end].raw + chars[run.end].char.length;
    const text = chars.slice(run.start, run.end + 1).map((entry) => entry.char).join('');
    next = `${next.slice(0, from)}${paint(text)}${sgrBefore(row, to)}${next.slice(to)}`;
  }
  return next;
}

/**
 * Elapsed time for a closing rule, or `undefined` when there is no reliable duration.
 * Sub-second runs read in milliseconds, longer ones in seconds with one decimal.
 */
function cardElapsed(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

// A closing rule keeps at least this much rule beside the duration, or it stays a plain rule.
const MIN_RULE = 3;

/**
 * The closing row with `text` right-aligned in it, or `undefined` when the row is not a closing
 * row or has no room. `paint` colours the duration only. Neon: `╰──── 120ms ─╯`. Float: the bar
 * and spaces, the duration ending one space before the row's end.
 */
function elapsedRow(row, text, paint) {
  const chars = visibleChars(row);
  const first = chars.findIndex((entry) => entry.char.trim() !== '');
  if (first < 0) return undefined;
  let last = chars.length - 1;
  while (last > first && chars[last].char.trim() === '') last -= 1;
  const width = textColumns(text);
  let span;
  let tail = '';
  if (chars[first].char === '╰' && chars[last].char === '╯') {
    const rule = chars.slice(first + 1, last);
    if (rule.length === 0 || !rule.every((entry) => entry.char === RULE)) return undefined;
    if (rule.length - (width + 2) < MIN_RULE) return undefined;
    span = { from: last - (width + 2), to: last - 1, lead: ' ', trail: ' ' };
  } else if (chars[first].char === '▎' && last === first) {
    const spaces = chars.length - 1 - first;
    if (spaces < width + 1 + MIN_RULE) return undefined;
    span = { from: chars.length - 1 - width, to: chars.length - 1, lead: '', trail: '' };
    tail = ' ';
  } else {
    return undefined;
  }
  const from = chars[span.from].raw;
  const to = chars[span.to].raw + chars[span.to].char.length;
  const inner = `${span.lead}${paint(text)}${span.trail}`;
  // Float: the duration replaces the last `width + 1` columns, so the closing space stays.
  const replaced = span.lead === '' ? `${paint(text)}${tail}` : inner;
  return `${row.slice(0, from)}${replaced}${sgrBefore(row, from)}${row.slice(to)}`;
}

module.exports = { cardElapsed, elapsedRow, paintFrame, rowColumns, sgrBefore, textColumns, visibleChars };

'use strict';
// Odd document markdown renderer (odd-viewer S5).
//
// Pure text in, styled lines out: no host API, no theme implementation and
// no filesystem access live here, so the renderer runs headless in tests.
// The caller injects the paint seam (`paint(role, text)`, plus optional
// `emphasis` for bold and `measure` for width), which keeps every role name
// out of this module and lets a theme-less host render plain text.
//
// Scope is deliberately the shape this repository's odd documents actually
// use (inventoried: file title, `## Specs`, `## Tasks`, `## Log`, occasional
// `## Design`/`## Reconciliation`/`## Known environmental failures` with
// `###` sub-headings, task tables, bullets, GitHub task rows, fenced code
// and inline code). Consecutive blank lines collapse to one separator and
// trailing blanks are trimmed: every source line with content reaches the
// output, and nothing inside a line is lost — a long line wraps instead.

const BLOCK_ROLES = {
  heading1: 'mdHeading',
  heading2: 'mdHeading',
  heading3: 'accent',
  heading4: 'muted',
  bullet: 'text',
  code: 'dim',
  quote: 'muted',
  rule: 'border',
};

const LIST_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const CHECKBOX = /^\[( |x|X)\]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_RULE = /^[\s|:-]+$/;
const QUOTE = /^\s*>\s?(.*)$/;

// A rendered markdown line can come from someone else's tracker (the Issues
// preview), so a control sequence in the source is display data and never an
// instruction: ANSI/OSC sequences and the remaining C0 controls are dropped
// before anything is parsed, and a tab becomes spaces so the width budget below
// matches what the terminal draws.
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\x1b[@-Z\\-_]?/g;
const C0_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeSource(value) {
  return String(value ?? '')
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(C0_CONTROL, '')
    .replace(/\t/g, '  ');
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
}

function defaultMeasure(text) {
  return [...stripAnsi(text)].length;
}

function makeContext(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawWidth = Number(opts.width);
  const width = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.floor(rawWidth) : 80;
  // Off by default: an odd document keeps the line-per-line shape its authors
  // wrote. The Issues preview turns it on, because there a single newline
  // inside a paragraph is a space (github-flavored markdown).
  const flowParagraphs = opts.flowParagraphs === true;
  const paint = typeof opts.paint === 'function' ? opts.paint : (_role, text) => String(text);
  const emphasis = typeof opts.emphasis === 'function' ? opts.emphasis : (text) => String(text);
  const measure = typeof opts.measure === 'function' ? opts.measure : defaultMeasure;
  const safePaint = (role, text) => {
    try {
      const painted = paint(role, String(text));
      return typeof painted === 'string' ? painted : String(text);
    } catch {
      // A hostile theme never breaks the renderer.
      return String(text);
    }
  };
  const safeEmphasis = (text) => {
    try {
      const bold = emphasis(String(text));
      return typeof bold === 'string' ? bold : String(text);
    } catch {
      return String(text);
    }
  };
  const safeMeasure = (text) => {
    try {
      const size = Number(measure(text));
      if (Number.isFinite(size)) return size;
    } catch {
      // Fall through to the plain codepoint count.
    }
    return defaultMeasure(text);
  };
  return { width, flowParagraphs, paint: safePaint, emphasis: safeEmphasis, measure: safeMeasure };
}

// Inline spans -> styled words. Emphasis and code are applied per WORD so
// every emitted word carries a balanced escape sequence: the wrapper below
// joins words with plain spaces, which is what keeps a wrapped line
// measurable without ever cutting through an escape.
function inlineTokens(text) {
  const tokens = [];
  const source = String(text);
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|__([^_]+)__/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > cursor) tokens.push({ text: source.slice(cursor, match.index), style: 'text' });
    if (match[1] !== undefined) tokens.push({ text: match[1], style: 'code' });
    else if (match[2] !== undefined) tokens.push({ text: match[2], style: 'bold' });
    else if (match[3] !== undefined) tokens.push({ text: match[3], style: 'text' });
    else if (match[5] !== undefined) tokens.push({ text: match[5], style: 'bold' });
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) tokens.push({ text: source.slice(cursor), style: 'text' });
  return tokens;
}

function styleOf(ctx, style, word) {
  if (style === 'code') return ctx.paint('accent', ctx.paint('dim', word));
  if (style === 'dim') return ctx.paint('dim', word);
  if (style === 'bold') return ctx.emphasis(ctx.paint('text', word));
  return ctx.paint('text', word);
}

function wordsOf(ctx, text) {
  const words = [];
  let previousText = null;
  for (const token of inlineTokens(text)) {
    // A word stays glued when no source whitespace separates it from the
    // previous word: the previous token ends with a non-space and this one
    // starts with one (tokens partition the source, so adjacency is exact).
    // Later words inside one token always follow whitespace, never glued.
    const gluedToken = previousText !== null && !/\s$/.test(previousText) && !/^\s/.test(token.text);
    let first = true;
    for (const part of String(token.text).split(/\s+/)) {
      if (part.length > 0) {
        words.push({ painted: styleOf(ctx, token.style, part), style: token.style, word: part, glued: first && gluedToken && words.length > 0 });
        first = false;
      }
    }
    previousText = token.text;
  }
  return words;
}

// Hard split for a single word wider than the line: it is cut, never
// dropped, so no content disappears silently.
function splitWord(ctx, word, width) {
  const pieces = [];
  let current = '';
  for (const char of Array.from(word.word)) {
    const next = current + char;
    if (ctx.measure(next) > width && current.length > 0) {
      pieces.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces.map((piece) => styleOf(ctx, word.style, piece));
}

function wrapWords(ctx, words, width) {
  // Glued words form one atom joined without a space; line breaks happen
  // only between atoms (where the source had whitespace), except for the
  // hard split of an atom wider than the line below.
  const atoms = [];
  for (const word of words) {
    if (word.glued && atoms.length > 0) {
      const last = atoms[atoms.length - 1];
      last.words.push(word);
      last.painted += word.painted;
    } else {
      atoms.push({ words: [word], painted: word.painted });
    }
  }
  for (const atom of atoms) atom.size = ctx.measure(atom.painted);
  const lines = [];
  let current = '';
  let currentWidth = 0;
  const flush = () => {
    if (currentWidth > 0) lines.push(current);
    current = '';
    currentWidth = 0;
  };
  for (const atom of atoms) {
    if (atom.size > width) {
      if (atom.words.length === 1) {
        flush();
        for (const piece of splitWord(ctx, atom.words[0], width)) {
          if (ctx.measure(piece) >= width) lines.push(piece);
          else {
            current = piece;
            currentWidth = ctx.measure(piece);
          }
        }
        flush();
        continue;
      }
      flush();
      for (const word of atom.words) {
        const size = ctx.measure(word.painted);
        if (size > width) {
          flush();
          for (const piece of splitWord(ctx, word, width)) {
            if (ctx.measure(piece) >= width) lines.push(piece);
            else {
              current = piece;
              currentWidth = ctx.measure(piece);
            }
          }
          flush();
          continue;
        }
        if (currentWidth === 0) {
          current = word.painted;
          currentWidth = size;
        } else if (currentWidth + size <= width) {
          current += word.painted;
          currentWidth += size;
        } else {
          flush();
          current = word.painted;
          currentWidth = size;
        }
      }
      continue;
    }
    if (currentWidth === 0) {
      current = atom.painted;
      currentWidth = atom.size;
      continue;
    }
    if (currentWidth + 1 + atom.size <= width) {
      current = `${current} ${atom.painted}`;
      currentWidth += 1 + atom.size;
      continue;
    }
    flush();
    current = atom.painted;
    currentWidth = atom.size;
  }
  flush();
  return lines;
}

function hardWrap(ctx, text, width) {
  const words = [];
  for (const part of String(text).split(/\s+/)) {
    if (part.length > 0) words.push({ painted: ctx.paint('dim', part), style: 'dim', word: part });
  }
  return wrapWords(ctx, words, width);
}

// A line that opens its own block: blank, fence, heading, rule, quote, list or
// ordered item, or a table header (a `|…|` row followed by its `|---|` rule).
function startsBlock(raw, index) {
  const line = raw[index];
  if (line === undefined || String(line).trim().length === 0) return true;
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  if (LIST_ITEM.test(line) || ORDERED_ITEM.test(line)) return true;
  return isTableStart(raw, index);
}

function isTableStart(raw, index) {
  const header = raw[index];
  if (header === undefined || !TABLE_ROW.test(header)) return false;
  const rule = raw[index + 1];
  if (rule === undefined || !TABLE_ROW.test(rule)) return false;
  return TABLE_RULE.test(TABLE_ROW.exec(rule)[1]);
}

function renderTableRow(ctx, line, width) {
  const inner = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|').map((cell) => cell.trim());
  const text = cells.join(' | ');
  return wrapWords(ctx, wordsOf(ctx, text), width);
}

// Blank-line policy: one separator between blocks, none at the start or
// end. Returns true when a separator was emitted.
function pushSeparator(lines) {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
}

function renderOddMarkdown(text, options) {
  const ctx = makeContext(options);
  const width = ctx.width;
  const source = sanitizeSource(text).replace(/\r\n?/g, '\n');
  if (source.trim().length === 0) return [];
  const raw = source.split('\n');
  const lines = [];
  let index = 0;
  while (index < raw.length) {
    const line = raw[index];
    if (line.trim().length === 0) {
      pushSeparator(lines);
      index += 1;
      continue;
    }
    if (FENCE.test(line)) {
      pushSeparator(lines);
      index += 1;
      const body = [];
      while (index < raw.length && !FENCE.test(raw[index])) {
        body.push(raw[index]);
        index += 1;
      }
      if (index < raw.length) index += 1;
      for (const codeLine of body) {
        const wrapped = hardWrap(ctx, codeLine.length > 0 ? codeLine : ' ', Math.max(1, width - 2));
        for (const piece of wrapped) lines.push(`  ${piece}`);
      }
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const label = heading[2];
      const mark = level === 1 ? '▌ ' : level === 2 ? '▌ ' : level === 3 ? '  ▪ ' : '    · ';
      const role = level === 1 ? BLOCK_ROLES.heading1 : level === 2 ? BLOCK_ROLES.heading2 : level === 3 ? BLOCK_ROLES.heading3 : BLOCK_ROLES.heading4;
      pushSeparator(lines);
      const painted = level <= 2
        ? ctx.paint(role, ctx.emphasis(`${mark}${label}`))
        : ctx.paint(role, `${mark}${label}`);
      lines.push(...wrapWords(ctx, [{ painted, style: 'text', word: `${mark}${label}` }], width));
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      pushSeparator(lines);
      lines.push(ctx.paint(BLOCK_ROLES.rule, '─'.repeat(width)));
      index += 1;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const wrapped = wrapWords(ctx, wordsOf(ctx, quote[1]), Math.max(1, width - 2));
      for (const piece of wrapped) lines.push(`${ctx.paint(BLOCK_ROLES.quote, '│')} ${piece}`);
      index += 1;
      continue;
    }
    if (isTableStart(raw, index)) {
      const rows = [];
      let cursor = index;
      while (cursor < raw.length && TABLE_ROW.test(raw[cursor])) {
        rows.push(raw[cursor]);
        cursor += 1;
      }
      for (const row of rows) {
        const separator = TABLE_RULE.test(TABLE_ROW.exec(row)[1]);
        if (separator) continue;
        lines.push(...renderTableRow(ctx, row, width));
      }
      index = cursor;
      continue;
    }
    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      const indent = listItem[1].replace(/\t/g, '  ');
      const rest = listItem[3];
      const checkbox = CHECKBOX.exec(rest);
      const mark = checkbox ? (checkbox[1].trim().length > 0 ? '☑ ' : '☐ ') : '• ';
      const content = checkbox ? checkbox[2] : rest;
      const prefix = `${indent}${mark}`;
      const prefixWidth = ctx.measure(prefix);
      const wrapped = wrapWords(ctx, wordsOf(ctx, content), Math.max(1, width - prefixWidth));
      wrapped.forEach((piece, at) => {
        lines.push(at === 0 ? `${ctx.paint(BLOCK_ROLES.bullet, prefix)}${piece}` : ' '.repeat(prefixWidth) + piece);
      });
      index += 1;
      continue;
    }
    const ordered = ORDERED_ITEM.exec(line);
    if (ordered) {
      const indent = ordered[1].replace(/\t/g, '  ');
      const prefix = `${indent}${ordered[2]}. `;
      const prefixWidth = ctx.measure(prefix);
      const wrapped = wrapWords(ctx, wordsOf(ctx, ordered[3]), Math.max(1, width - prefixWidth));
      wrapped.forEach((piece, at) => {
        lines.push(at === 0 ? `${ctx.paint(BLOCK_ROLES.bullet, prefix)}${piece}` : ' '.repeat(prefixWidth) + piece);
      });
      index += 1;
      continue;
    }
    pushSeparator(lines);
    // Flow mode joins the plain lines up to the next block into ONE paragraph,
    // so a hard-wrapped body reads the way its author wrote it instead of one
    // line plus a separator per source line.
    const paragraph = [line.trim()];
    index += 1;
    while (ctx.flowParagraphs && !startsBlock(raw, index)) {
      paragraph.push(String(raw[index]).trim());
      index += 1;
    }
    lines.push(...wrapWords(ctx, wordsOf(ctx, paragraph.join(' ')), width));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

module.exports = { renderOddMarkdown, stripAnsi, defaultMeasure };

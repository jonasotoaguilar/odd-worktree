'use strict';
// T5 (S11, S12): the pure preview pane of `/files`. It reads no file and paints
// nothing itself: `previewRows` turns one `readFilePreview` result into the exact
// rows and cells the view draws, at a given pane width and height, with the
// gutter, the `line/total` position, the ANSI-aware wrap of a highlighted line
// and every plain-text degradation of the injected highlighter.
//
// Asserted through the public output only: cell text and role, the row count,
// `boxed` and `maxScroll`. No module-internal state is read.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { previewRows } = require('../lib/files-preview.js');

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => String(value).replace(ANSI, '');
const textOf = (row) => row.cells.map((cell) => cell.text).join('');
const plainOf = (row) => stripAnsi(textOf(row));
const plainRows = (result) => result.rows.map(plainOf);

// The injected measurement seam the host provides. The test copy measures ANSI
// as zero width and counts code points, so an assertion can state the PAINTED
// width without importing the host package (CI installs nothing).
function createMetrics() {
  return {
    visibleWidth(text) {
      return [...stripAnsi(text)].length;
    },
    truncateToWidth(text, width, ellipsis = '…') {
      if (width <= 0) return '';
      const value = String(text);
      if (this.visibleWidth(value) <= width) return value;
      const mark = ellipsis === undefined ? '' : String(ellipsis);
      const room = Math.max(0, width - [...stripAnsi(mark)].length);
      return [...stripAnsi(value)].slice(0, room).join('') + mark;
    },
    wrapTextWithAnsi(text, width) {
      return plainChunks(text, width);
    },
  };
}

const METRICS = createMetrics();

function plainChunks(text, width) {
  if (width <= 0) return [text];
  const characters = [...text];
  const rows = [];
  for (let index = 0; index < characters.length; index += width) {
    rows.push(characters.slice(index, index + width).join(''));
  }
  return rows.length > 0 ? rows : [''];
}

function render(preview, options) {
  return previewRows(preview, {
    width: 16,
    height: 6,
    scroll: 0,
    metrics: METRICS,
    ...options,
  });
}

const TEXT_PREVIEW = { kind: 'text', lines: ['alpha', 'beta', 'gamma'], truncated: false };

describe('the preview paints its rounded box, gutter and position (S11)', () => {
  test('a text preview fills the pane as a box with one numbered row per line', () => {
    const out = render(TEXT_PREVIEW);

    assert.equal(out.boxed, true);
    assert.equal(out.maxScroll, 0);
    assert.equal(out.rows.length, 6);
    assert.deepEqual(plainRows(out), [
      '╭────────── 1/3╮',
      '│1 alpha       │',
      '│2 beta        │',
      '│3 gamma       │',
      '│              │',
      '╰──────────────╯',
    ]);

    // The position is embedded at the right of the TOP border: one gap after the
    // dashes, then the label, then the closing corner.
    assert.deepEqual(out.rows[0].cells, [
      { text: '╭', role: 'border' },
      { text: '──────────', role: 'border' },
      { text: ' 1/3', role: 'text' },
      { text: '╮', role: 'border' },
    ]);
    // The number is the dim gutter, the text is plain text, one gap between them.
    assert.deepEqual(out.rows[1].cells, [
      { text: '│', role: 'border' },
      { text: '1', role: 'dim' },
      { text: ' alpha'.padEnd(13), role: 'text' },
      { text: '│', role: 'border' },
    ]);
    // A row past the end of the file is an empty boxed row, not a short one.
    assert.deepEqual(out.rows[4].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' '.repeat(13), role: 'text' },
      { text: '│', role: 'border' },
    ]);
    assert.deepEqual(out.rows[5].cells, [
      { text: '╰', role: 'border' },
      { text: '──────────────', role: 'border' },
      { text: '╯', role: 'border' },
    ]);
  });

  test('the position names the top visible line and follows the scroll', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line${index + 1}`);
    const preview = { kind: 'text', lines, truncated: false };

    const top = render(preview, { width: 12, height: 5 });
    assert.equal(top.boxed, true);
    assert.equal(top.maxScroll, 7);
    assert.deepEqual(plainRows(top), [
      '╭───── 1/10╮',
      '│ 1 line1  │',
      '│ 2 line2  │',
      '│ 3 line3  │',
      '╰──────────╯',
    ]);

    const middle = render(preview, { width: 12, height: 5, scroll: 2 });
    assert.deepEqual(plainRows(middle), [
      '╭───── 3/10╮',
      '│ 3 line3  │',
      '│ 4 line4  │',
      '│ 5 line5  │',
      '╰──────────╯',
    ]);

    const end = render(preview, { width: 12, height: 5, scroll: 999 });
    assert.deepEqual(plainRows(end), [
      '╭───── 8/10╮',
      '│ 8 line8  │',
      '│ 9 line9  │',
      '│10 line10 │',
      '╰──────────╯',
    ]);
  });
});

describe('a long line wraps under the same text column (S11)', () => {
  test('a wrapped line is numbered once and its continuation keeps the column', () => {
    const out = render({ kind: 'text', lines: ['abcdefghij'], truncated: false }, { width: 12, height: 5 });

    assert.equal(out.boxed, true);
    assert.equal(out.maxScroll, 0);
    assert.deepEqual(plainRows(out), [
      '╭────── 1/1╮',
      '│1 abcdefgh│',
      '│  ij      │',
      '│          │',
      '╰──────────╯',
    ]);
    // The continuation row leaves its gutter blank and starts its text in the
    // same column as the first row's text.
    assert.deepEqual(out.rows[2].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' ij'.padEnd(9), role: 'text' },
      { text: '│', role: 'border' },
    ]);
  });

  test('a scroll that stops inside a wrapped line still reports that line', () => {
    const preview = { kind: 'text', lines: ['abcdefghij', 'second'], truncated: false };
    const out = render(preview, { width: 12, height: 4, scroll: 1 });

    assert.equal(out.maxScroll, 1);
    assert.equal(plainRows(out)[0], '╭────── 1/2╮');
    assert.deepEqual(out.rows[1].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' ij'.padEnd(9), role: 'text' },
      { text: '│', role: 'border' },
    ]);
  });
});

describe('the injected highlighter colours the preview (S12)', () => {
  const PREVIEW = { kind: 'text', lines: ['abcdefghij'], truncated: false };

  test('a highlighted line goes through the ANSI-aware wrapper, once per call', () => {
    const highlightCalls = [];
    const wrapperCalls = [];
    const highlight = (code, lang) => {
      highlightCalls.push({ code, lang });
      return ['\x1b[31mabcdefghij\x1b[0m'];
    };
    const metrics = {
      ...METRICS,
      wrapTextWithAnsi(text, width) {
        wrapperCalls.push({ text, width });
        return ['\x1b[31mabcdefgh', 'ij\x1b[0m'];
      },
    };

    const out = render(PREVIEW, {
      width: 12,
      height: 5,
      highlight,
      languageForPath: () => 'txt',
      path: 'a.txt',
      metrics,
    });

    assert.deepEqual(highlightCalls, [{ code: 'abcdefghij', lang: 'txt' }]);
    assert.deepEqual(wrapperCalls, [{ text: '\x1b[31mabcdefghij\x1b[0m', width: 8 }]);
    assert.deepEqual(out.rows[1].cells, [
      { text: '│', role: 'border' },
      { text: '1', role: 'dim' },
      { text: ' \x1b[31mabcdefgh', role: 'text' },
      { text: '│', role: 'border' },
    ]);
    assert.deepEqual(out.rows[2].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' ij\x1b[0m'.padEnd(13), role: 'text' },
      { text: '│', role: 'border' },
    ]);
    // The gutter keeps its dim tone and the colour arrives on the text role only.
    for (const row of out.rows) assert.equal(METRICS.visibleWidth(textOf(row)), 12);
  });

  test('without a highlighter the plain path never touches the ANSI wrapper', () => {
    const metrics = {
      ...METRICS,
      wrapTextWithAnsi() {
        throw new Error('the plain path must not use the ANSI wrapper');
      },
    };
    const out = render({ kind: 'text', lines: ['alpha'], truncated: false }, { width: 12, height: 5, metrics });

    assert.equal(textOf(out.rows[1]).includes('\x1b'), false);
    assert.deepEqual(out.rows[1].cells, [
      { text: '│', role: 'border' },
      { text: '1', role: 'dim' },
      { text: ' alpha'.padEnd(9), role: 'text' },
      { text: '│', role: 'border' },
    ]);
  });

  test('a highlighter that paints the text unchanged keeps the plain preview', () => {
    const plain = render({ kind: 'text', lines: ['alpha', 'beta'], truncated: false }, { width: 20, height: 5 });
    const out = render({ kind: 'text', lines: ['alpha', 'beta'], truncated: false }, {
      width: 20,
      height: 5,
      highlight: (code) => code.split('\n'),
      languageForPath: () => 'txt',
      path: 'a.txt',
    });
    assert.deepEqual(out, plain);
  });

  test('every highlighter failure degrades to the same plain preview', () => {
    const preview = { kind: 'text', lines: ['alpha', 'beta'], truncated: false };
    const base = render(preview, { width: 20, height: 5 });
    const failures = [
      {
        name: 'the highlighter throws',
        options: { highlight: () => { throw new Error('no theme'); }, languageForPath: () => 'js', path: 'a.js' },
      },
      {
        name: 'the highlighter answers something that is not a list',
        options: { highlight: () => 'not a list', languageForPath: () => 'js', path: 'a.js' },
      },
      {
        name: 'the highlighter answers fewer lines than the file',
        options: { highlight: () => ['only one'], languageForPath: () => 'js', path: 'a.js' },
      },
      {
        name: 'the highlighter answers a non-string line',
        options: { highlight: () => ['one', undefined], languageForPath: () => 'js', path: 'a.js' },
      },
      {
        name: 'the language is unknown',
        options: { highlight: () => ['one', 'two'], languageForPath: () => undefined, path: 'a.unknown' },
      },
      {
        name: 'the language is empty',
        options: { highlight: () => ['one', 'two'], languageForPath: () => '', path: 'a.unknown' },
      },
      {
        name: 'the language resolver throws',
        options: { highlight: () => ['one', 'two'], languageForPath: () => { throw new Error('no theme'); }, path: 'a.js' },
      },
      {
        name: 'there is no language resolver',
        options: { highlight: () => ['one', 'two'], path: 'a.js' },
      },
      {
        name: 'there is no path to resolve',
        options: { highlight: () => ['one', 'two'], languageForPath: () => 'js' },
      },
    ];
    for (const failure of failures) {
      assert.deepEqual(render(preview, { width: 20, height: 5, ...failure.options }), base, failure.name);
    }
  });

  test('an unknown language never calls the highlighter at all', () => {
    let calls = 0;
    const out = render({ kind: 'text', lines: ['alpha'], truncated: false }, {
      width: 20,
      height: 5,
      highlight: () => {
        calls += 1;
        return ['painted'];
      },
      languageForPath: () => undefined,
      path: 'a.unknown',
    });
    assert.equal(calls, 0);
    assert.deepEqual(out, render({ kind: 'text', lines: ['alpha'], truncated: false }, { width: 20, height: 5 }));
  });
});

describe('a binary, an error and a truncation are notices (S11)', () => {
  test('a binary preview paints its message instead of bytes, with no position label', () => {
    const out = render(
      { kind: 'binary', message: 'Binary file — preview not available.' },
      { width: 24, height: 4 }
    );

    assert.equal(out.boxed, true);
    assert.equal(out.maxScroll, 0);
    assert.deepEqual(plainRows(out), [
      '╭──────────────────────╮',
      '│  Binary file — previe│',
      '│  w not available.    │',
      '╰──────────────────────╯',
    ]);
    assert.deepEqual(out.rows[1].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' Binary file — previe', role: 'text' },
      { text: '│', role: 'border' },
    ]);
  });

  test('an error preview paints the reader message, not an empty pane', () => {
    const out = render(
      { kind: 'error', message: 'Cannot read nope.txt (ENOENT).' },
      { width: 24, height: 4 }
    );

    assert.equal(out.boxed, true);
    assert.equal(out.maxScroll, 0);
    assert.equal(plainOf(out.rows[0]).includes('/'), false);
    assert.equal(out.rows[0].cells.some((cell) => cell.role === 'text'), false);
    assert.equal(plainOf(out.rows[1]).includes('Cannot read nope.txt'), true);
    assert.deepEqual(out.rows[1].cells[2], { text: ' Cannot read nope.txt', role: 'text' });
  });

  test('a truncated preview paints the notice row and marks the position', () => {
    const out = render({ kind: 'text', lines: ['alpha', 'beta'], truncated: true });

    assert.equal(out.maxScroll, 0);
    assert.deepEqual(plainRows(out), [
      '╭───────── 1/2+╮',
      '│1 alpha       │',
      '│2 beta        │',
      '│  … preview tr│',
      '│  uncated.    │',
      '╰──────────────╯',
    ]);
    // The notice is not a file line: its gutter stays blank.
    assert.deepEqual(out.rows[3].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' … preview tr', role: 'dim' },
      { text: '│', role: 'border' },
    ]);
    assert.deepEqual(out.rows[4].cells, [
      { text: '│', role: 'border' },
      { text: ' ', role: 'dim' },
      { text: ' uncated.'.padEnd(13), role: 'dim' },
      { text: '│', role: 'border' },
    ]);
  });

  // S3: the notice is chrome, not a file line, so it paints dim; the file lines,
  // the position label and the gutter keep the roles they always had.
  test('the truncation notice paints dim while the file lines keep text', () => {
    const out = render({ kind: 'text', lines: ['alpha', 'beta'], truncated: true });

    assert.deepEqual(out.rows[0].cells[2], { text: ' 1/2+', role: 'text' });
    assert.deepEqual(out.rows[1].cells, [
      { text: '│', role: 'border' },
      { text: '1', role: 'dim' },
      { text: ' alpha'.padEnd(13), role: 'text' },
      { text: '│', role: 'border' },
    ]);
    assert.deepEqual(out.rows[2].cells[2], { text: ' beta'.padEnd(13), role: 'text' });
    const noticeRows = out.rows.slice(3, 5);
    for (const row of noticeRows) assert.equal(row.cells[2].role, 'dim');
    for (const row of out.rows) {
      for (const cell of row.cells) assert.ok(['dim', 'border', 'text'].includes(cell.role), cell.role);
    }
  });

  // S4: the `+` follows the reader's truncation flag alone, so a preview clipped
  // per line reads `5/5`, not `5/5+`.
  test('a per-line width clip paints no plus on the position label', () => {
    const clipped = `${'x'.repeat(11)}\u2026`;
    const out = render({ kind: 'text', lines: [clipped, 'beta', 'gamma', 'delta', 'epsilon'], truncated: false });

    assert.deepEqual(out.rows[0].cells, [
      { text: '╭', role: 'border' },
      { text: '─'.repeat(10), role: 'border' },
      { text: ' 1/5', role: 'text' },
      { text: '╮', role: 'border' },
    ]);
    assert.equal(out.rows.length, 6, 'every file line counts and no notice row follows');
    assert.equal(out.rows.some((row) => plainOf(row).includes('preview truncated.')), false);
  });
});

describe('the scroll is clamped to the preview (S11)', () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line${index + 1}`);
  const preview = { kind: 'text', lines, truncated: false };

  test('a negative scroll paints the first page and an oversized one the last', () => {
    const zero = render(preview, { width: 12, height: 5, scroll: 0 });
    assert.deepEqual(render(preview, { width: 12, height: 5, scroll: -4 }), zero);

    const end = render(preview, { width: 12, height: 5, scroll: 999 });
    assert.equal(end.maxScroll, 7);
    assert.equal(plainRows(end)[0], '╭───── 8/10╮');
    assert.equal(plainOf(end.rows[1]).includes('line8'), true);
  });

  test('a fractional scroll is truncated and an unknown one falls to the top', () => {
    assert.equal(plainRows(render(preview, { width: 12, height: 5, scroll: 2.9 }))[0], '╭───── 3/10╮');
    assert.deepEqual(
      render(preview, { width: 12, height: 5, scroll: Number.NaN }),
      render(preview, { width: 12, height: 5, scroll: 0 })
    );
  });
});

describe('a short body paints the preview unbordered (S11)', () => {
  test('two rows paint the position row and one content row with no frame', () => {
    const out = render({ kind: 'text', lines: ['alpha'], truncated: false }, { width: 16, height: 2 });

    assert.equal(out.boxed, false);
    assert.deepEqual(plainRows(out), [' '.repeat(13) + '1/1', '1' + ' alpha'.padEnd(15)]);
    assert.deepEqual(out.rows[1].cells, [
      { text: '1', role: 'dim' },
      { text: ' alpha'.padEnd(15), role: 'text' },
    ]);
    assert.equal(plainRows(out).some((row) => /[╭╮╰╯│─]/.test(row)), false);
  });

  test('one row paints only the position row', () => {
    const out = render({ kind: 'text', lines: ['alpha'], truncated: false }, { width: 16, height: 1 });

    assert.equal(out.boxed, false);
    assert.deepEqual(plainRows(out), [' '.repeat(13) + '1/1']);
    assert.equal(out.maxScroll, 1);
  });

  test('a pane narrower than the box frame keeps the content unbordered', () => {
    const out = render({ kind: 'text', lines: ['alpha'], truncated: false }, { width: 2, height: 4 });

    assert.equal(out.boxed, false);
    assert.equal(out.rows.length, 4);
    assert.equal(plainRows(out).some((row) => /[╭╮╰╯│─]/.test(row)), false);
  });
});

describe('preview text is painted as terminal-safe plain text (S11)', () => {
  test('an escape sequence is stripped and a tab becomes two cells', () => {
    const out = render(
      { kind: 'text', lines: ['\u001b[31mred\u001b[0m\tx'], truncated: false },
      { width: 20, height: 5 }
    );

    assert.equal(textOf(out.rows[1]).includes('\u001b'), false);
    assert.equal(plainOf(out.rows[1]).includes('red  x'), true);
  });
});

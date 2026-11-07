'use strict';
// T2 (odd-viewer S5) tests: lib/odd-markdown.js — the pure markdown ->
// styled-lines renderer for the document pane.
//
// Contract under test (observable output only): headings of every level
// this repo's odd documents use (`#`, `##`, `###`) get a heading mark and
// keep their text; list items, GitHub task rows (checked and unchecked),
// ordered items and table rows are recognised; fenced code and blockquotes
// are recognised; nothing is dropped — every source line's words reach the
// output — and no rendered line exceeds the requested width, so a long
// paragraph wraps instead of being truncated.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { renderOddMarkdown } = require('../lib/odd-markdown.js');

// The injected paint seam: roles are tagged so tests can assert styling
// without depending on a theme implementation.
const tag = (role, text) => `<${role}>${text}</${role}>`;
const opts = (width) => ({ width, paint: tag, measure: (s) => [...strip(s)].length });
function strip(value) {
  return String(value).replace(/<\/?[a-z][a-zA-Z]*>/g, '');
}
function plain(lines) {
  return lines.map(strip).join('\n');
}

describe('renderOddMarkdown', () => {
  test('renders the document heading and each section heading with its level mark', () => {
    const source = [
      '# Odd viewer: read the documents',
      '',
      '## Specs',
      'S1. one line.',
      '',
      '### Deep section',
      'detail.',
    ].join('\n');
    const lines = renderOddMarkdown(source, opts(60));
    const body = plain(lines);
    assert.ok(body.includes('Odd viewer: read the documents'), 'the document title keeps its text');
    assert.ok(!body.includes('# Odd viewer'), 'the raw # marker is replaced by the heading mark');
    assert.ok(body.includes('Specs'), 'the section heading keeps its text');
    assert.ok(body.includes('Deep section'), 'the nested heading keeps its text');
    assert.ok(lines.some((line) => line.startsWith('<mdHeading>')), 'headings use the mdHeading role');
    const specLine = lines.findIndex((line) => strip(line).includes('Specs'));
    const deepLine = lines.findIndex((line) => strip(line).includes('Deep section'));
    assert.ok(specLine >= 0 && deepLine > specLine, 'headings stay in source order');
  });

  test('renders list items, task rows and table rows', () => {
    const source = [
      '## Tasks',
      'T1 | S1 | done | a task row.',
      '- a plain bullet',
      '- [ ] an open task',
      '- [x] a done task',
      '1. an ordered item',
      '',
      '| ID | Spec | Route |',
      '| --- | --- | --- |',
      '| T2 | S5 | implement |',
    ].join('\n');
    const lines = renderOddMarkdown(source, opts(60));
    const body = plain(lines);
    for (const copy of [
      'T1 | S1 | done | a task row.',
      'a plain bullet',
      'an open task',
      'a done task',
      'an ordered item',
      'T2 | S5 | implement',
    ]) {
      assert.ok(body.includes(copy), `lost content: ${copy}`);
    }
    assert.ok(/•\s+a plain bullet/.test(body), 'bullets carry a • mark');
    assert.ok(/☐\s+an open task/.test(body), 'an open task row carries an unchecked box');
    assert.ok(/☑\s+a done task/.test(body), 'a done task row carries a checked box');
    assert.ok(/1\.\s+an ordered item/.test(body), 'an ordered item keeps its number');
  });

  test('renders fenced code and blockquotes without their markers leaking', () => {
    const source = [
      'text before',
      '',
      '> a quoted line',
      '',
      '```sh',
      'git worktree list',
      '```',
      '',
      'text after',
    ].join('\n');
    const lines = renderOddMarkdown(source, opts(60));
    const body = plain(lines);
    assert.ok(body.includes('git worktree list'), 'the code body survives');
    assert.ok(body.includes('a quoted line'), 'the quote text survives');
    assert.ok(!body.includes('```'), 'the fence marker is not rendered as text');
    assert.ok(!/^>/m.test(body), 'the quote marker is not rendered as text');
  });

  test('wraps a long paragraph to the width instead of cutting it', () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const lines = renderOddMarkdown(words, opts(24));
    assert.ok(lines.length > 1, 'a long paragraph occupies several lines');
    for (const line of lines) {
      assert.ok(strip(line).length <= 24, `line exceeds the width: ${strip(line)}`);
    }
    const joined = plain(lines).replace(/\n/g, ' ');
    for (const word of words.split(' ')) {
      assert.ok(joined.includes(word), `wrapped output lost ${word}`);
    }
  });

  test('honours an inline emphasis and code span without breaking the width budget', () => {
    const lines = renderOddMarkdown('a **bold** value and `inline code` here', opts(80));
    const body = plain(lines);
    assert.ok(body.includes('bold'), 'bold text survives');
    assert.ok(body.includes('inline code'), 'inline code survives');
    for (const line of lines) assert.ok(strip(line).length <= 80);
  });

  test('an empty document renders nothing', () => {
    assert.deepEqual(renderOddMarkdown('', opts(40)), []);
    assert.deepEqual(renderOddMarkdown('   \n\n', opts(40)), []);
  });

  test('keeps punctuation glued to inline spans attached', () => {
    const source = 'see `/x/y`, and **bold**, done.';
    for (const width of [80, 20]) {
      const lines = renderOddMarkdown(source, opts(width));
      const body = plain(lines);
      assert.ok(body.includes('/x/y,'), `width ${width}: code span keeps its glued comma: ${JSON.stringify(body)}`);
      assert.ok(body.includes('bold,'), `width ${width}: bold span keeps its glued comma: ${JSON.stringify(body)}`);
      assert.ok(!body.includes('/x/y ,'), `width ${width}: no space before the code comma: ${JSON.stringify(body)}`);
      assert.ok(!body.includes('bold ,'), `width ${width}: no space before the bold comma: ${JSON.stringify(body)}`);
    }
  });
});

// S12 (Issues preview): GitHub-flavored markdown treats a single newline inside
// a paragraph as a space, so a body whose lines were hard-wrapped at the author's
// terminal reads as ONE paragraph. The ODD documents keep their own
// line-per-line shape, so the joined form is an explicit option and the default
// is unchanged.
describe('renderOddMarkdown joins wrapped paragraphs when asked (S12)', () => {
  const flow = (width) => ({ width, paint: tag, measure: (s) => [...strip(s)].length, flowParagraphs: true });

  test('consecutive plain source lines become one paragraph', () => {
    const source = 'first source line\nsecond source line';
    assert.equal(plain(renderOddMarkdown(source, flow(200))), 'first source line second source line');
    assert.equal(plain(renderOddMarkdown(source, opts(200))), 'first source line\n\nsecond source line',
      'the ODD document shape keeps one source line per block by default');
  });

  test('a joined paragraph still wraps to the requested width', () => {
    const source = 'alpha beta gamma delta epsilon zeta eta theta';
    const lines = renderOddMarkdown(source, flow(16));
    assert.ok(lines.length > 1, 'the joined paragraph wraps');
    for (const line of lines) assert.ok(strip(line).length <= 16, `line exceeds the width: ${strip(line)}`);
    assert.equal(plain(lines).replace(/\n/g, ' '), source, 'every word survives the join and the wrap');
  });

  test('headings, lists, quotes and code blocks keep their own blocks', () => {
    const source = [
      'lead in',
      'continues here',
      '## Steps',
      '- one',
      '- two',
      '> quoted',
      '```sh',
      'ls',
      '```',
      'trailing text',
    ].join('\n');
    const body = plain(renderOddMarkdown(source, flow(80)));
    assert.ok(body.includes('lead in continues here'), 'plain lines joined into one paragraph');
    assert.ok(!body.includes('continues here ## Steps'), 'a heading ends the paragraph');
    assert.ok(/▌ Steps/.test(body), 'the heading keeps its mark');
    assert.ok(/•\s+one/.test(body), 'list items stay their own rows');
    assert.ok(body.includes('quoted') && !/\n>/.test(body), 'the quote keeps its own block');
    assert.ok(body.includes('ls'), 'the code body survives');
    assert.ok(body.includes('trailing text'), 'text after a fence is not swallowed');
  });
});

// S12: the preview renders text that came from someone else's issue tracker, so
// the renderer treats control sequences as display data. Roles are asserted
// through the injected paint seam, never through a theme.
describe('renderOddMarkdown styles and sanitizes untrusted text (S12)', () => {
  const roles = (width) => ({
    width,
    paint: tag,
    emphasis: (text) => `<strong>${text}</strong>`,
    measure: (s) => [...strip(s)].length,
  });

  test('inline code and bold take their own roles', () => {
    const body = renderOddMarkdown('use `gh auth` and **today**', roles(80)).join('\n');
    assert.match(body, /<accent><dim>gh<\/dim><\/accent>/, 'inline code is accent on dim');
    assert.match(body, /<strong><text>today<\/text><\/strong>/, 'bold goes through the emphasis seam');
  });

  test('a fenced block renders indented, dim, and inside the width budget', () => {
    const source = ['```', 'git worktree add /tmp/very-long-branch-name-here ok', '```'].join('\n');
    const lines = renderOddMarkdown(source, roles(24));
    assert.ok(lines.length > 1, 'a long code line wraps');
    for (const line of lines) {
      assert.match(line, /^ {2}<dim>/, `code rows are indented and dim: ${JSON.stringify(line)}`);
      assert.ok(strip(line).length <= 24, `code row exceeds the width: ${strip(line)}`);
    }
    const withoutSpace = (value) => String(value).replace(/\s+/g, '');
    assert.equal(withoutSpace(plain(lines)), withoutSpace('git worktree add /tmp/very-long-branch-name-here ok'),
      'no code character is dropped by the wrap');
    const wide = renderOddMarkdown(source, roles(200));
    assert.equal(plain(wide), '  git worktree add /tmp/very-long-branch-name-here ok', 'a code line that fits is untouched');
  });

  test('escape sequences, OSC titles and control characters never reach the output', () => {
    const source = 'plain \x1b[31mred\x1b[0m \x1b]0;owned\x07text\x08\x07 end';
    const lines = renderOddMarkdown(source, roles(80));
    const joined = lines.join('');
    assert.ok(!joined.includes('\x1b'), 'no escape byte reaches the output');
    assert.ok(!joined.includes('\x07'), 'no BEL reaches the output');
    assert.ok(!joined.includes('\x08'), 'no backspace reaches the output');
    assert.equal(plain(lines), 'plain red text end', 'the visible text of the line survives intact');
  });

  test('a tab is folded to spaces so the width budget matches the terminal', () => {
    const body = plain(renderOddMarkdown('a\tb', roles(80)));
    assert.ok(!body.includes('\t'), 'no raw tab reaches the output');
    assert.equal(body, 'a b');
  });
});

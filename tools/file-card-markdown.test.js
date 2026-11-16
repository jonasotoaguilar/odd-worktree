'use strict';
// T3 (S3/S5): the file card's document body — Pi's own Markdown renderer, and the theme
// table that gives every Markdown element a theme ROLE.
//
// Every case goes through the module's public surface only: the theme table it builds,
// and the rows it asks a renderer for. Nothing here reads a module internal, a
// repository or a terminal. The renderer is the host's; the cases that need the real one
// are skipped when this machine has no `@earendil-works/pi-tui` (CI installs none), and
// the rest drive an injected stand-in, so the table itself is always verified.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  MARKDOWN_ATTRIBUTES,
  MARKDOWN_ROLES,
  fileCardMarkdownTheme,
  loadMarkdownClass,
  markdownRows,
} = require('../lib/file-card-markdown.js');

// The roles the host's own theme tokens declare for Markdown (`theme-tokens.ts:67-76`).
const HOST_ROLES = {
  heading: 'mdHeading',
  link: 'mdLink',
  linkUrl: 'mdLinkUrl',
  code: 'mdCode',
  codeBlock: 'mdCodeBlock',
  codeBlockBorder: 'mdCodeBlockBorder',
  quote: 'mdQuote',
  quoteBorder: 'mdQuoteBorder',
  hr: 'mdHr',
  listBullet: 'mdListBullet',
};

/** A theme that records every role it was asked for and paints nothing. */
function recordingTheme() {
  const asked = [];
  return {
    asked,
    fg(role, text) {
      asked.push(role);
      return text;
    },
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
  };
}

test('the table maps every Markdown element to the host role the spec names (S3)', () => {
  assert.deepEqual({ ...MARKDOWN_ROLES }, HOST_ROLES, 'the role table is the spec\'s, element for element');
  const theme = recordingTheme();
  const table = fileCardMarkdownTheme(theme);
  for (const [element, role] of Object.entries(HOST_ROLES)) {
    table[element]('x');
    assert.equal(theme.asked.at(-1), role, `${element} paints ${role}`);
  }
  // `mdListBullet`, never `mdBullet`: the host names no such role.
  assert.equal(Object.values(MARKDOWN_ROLES).includes('mdBullet'), false);
});

test('the text attributes come from the theme\'s own handlers, when it has them', () => {
  assert.deepEqual([...MARKDOWN_ATTRIBUTES].sort(), ['bold', 'italic', 'strikethrough', 'underline']);
  const calls = [];
  const theme = {
    fg: (_role, text) => text,
    bold: (text) => { calls.push(['bold', text]); return `<b>${text}</b>`; },
    italic: (text) => { calls.push(['italic', text]); return `<i>${text}</i>`; },
    underline: (text) => { calls.push(['underline', text]); return `<u>${text}</u>`; },
    strikethrough: (text) => { calls.push(['strikethrough', text]); return `<s>${text}</s>`; },
  };
  const table = fileCardMarkdownTheme(theme);
  assert.equal(table.bold('x'), '<b>x</b>');
  assert.equal(table.italic('x'), '<i>x</i>');
  assert.equal(table.underline('x'), '<u>x</u>');
  assert.equal(table.strikethrough('x'), '<s>x</s>');
  assert.deepEqual(calls.map(([name]) => name), ['bold', 'italic', 'underline', 'strikethrough']);

  // A theme that carries none, or one that throws: the text survives untouched rather
  // than the document losing a word.
  for (const missing of [undefined, null, {}, { bold: 42 }, { bold: () => { throw new Error('boom'); } }, { bold: () => 42 }]) {
    const bare = fileCardMarkdownTheme(missing);
    assert.equal(bare.bold('kept'), 'kept', String(missing));
    assert.equal(bare.italic('kept'), 'kept');
  }
});

test('a role the theme cannot paint leaves the text as it was', () => {
  for (const theme of [undefined, null, {}, { fg: () => { throw new Error('boom'); } }, { fg: () => 42 }, { fg: 'not a function' }]) {
    const table = fileCardMarkdownTheme(theme);
    for (const element of Object.keys(HOST_ROLES)) assert.equal(table[element]('kept'), 'kept', `${element} with ${String(theme)}`);
  }
});

test('the rows come from the renderer the caller names, and the theme table with them', () => {
  const seen = [];
  class FakeMarkdown {
    constructor(source, paddingX, paddingY, theme) {
      seen.push({ source, paddingX, paddingY, theme });
    }

    render(width) {
      seen.push({ width });
      return ['one', 'two'];
    }

    invalidate() {}
  }
  const theme = recordingTheme();
  const rows = markdownRows('# A', theme, 33, FakeMarkdown);
  assert.deepEqual(rows, ['one', 'two']);
  assert.equal(seen[0].source, '# A');
  assert.equal(seen[0].paddingX, 0, 'the card owns the frame, so the renderer is unpadded');
  assert.equal(seen[0].paddingY, 0);
  assert.equal(seen[1].width, 33, 'the renderer is asked for the width the body has');
  seen[0].theme.heading('x');
  assert.equal(theme.asked.at(-1), 'mdHeading', 'the table handed over is this module\'s');
});

test('a document that cannot be drawn answers no rows, so the caller keeps its plain source', () => {
  const rowsOf = (markdownClass, extra) => markdownRows(extra?.source ?? '# A', {}, 40, markdownClass);
  assert.deepEqual(rowsOf(null), [], 'a host that has none');
  assert.deepEqual(rowsOf(() => { throw new Error('constructor exploded'); }), [], 'a renderer that throws before returning a component');
  assert.deepEqual(rowsOf(class { render() { throw new Error('render exploded'); } }), [], 'a renderer that throws while drawing');
  assert.deepEqual(rowsOf(class { render() { return []; } }), [], 'a renderer that draws nothing');
  assert.deepEqual(rowsOf(class { render() { return ['', '   ']; } }), [], 'a renderer that draws only blanks');
  assert.deepEqual(rowsOf(class { render() { return 'not rows'; } }), [], 'a renderer that answers a shape this cannot read');
  assert.deepEqual(rowsOf(class { render() { return ['ok']; } }, { source: '   ' }), [], 'a blank source draws nothing');
  assert.deepEqual(markdownRows('# A', {}, 0, class { render() { return ['ok']; } }), [], 'no width, no body');
});

test('the host package is resolved lazily, so a host without it costs no import', () => {
  // Reading the module never loads the package; only asking for the class does.
  const source = readFileSync(join(__dirname, '..', 'lib', 'file-card-markdown.js'), 'utf8');
  const requires = source.match(/require\('([^']+)'\)/gu) ?? [];
  assert.deepEqual(requires, ["require('@earendil-works/pi-tui')"], 'the one require is the host package, inside the function');
  // Whatever this machine has, the answer is a function or undefined — never a throw.
  const Markdown = loadMarkdownClass();
  assert.equal(Markdown === undefined || typeof Markdown === 'function', true, String(typeof Markdown));
  assert.equal(loadMarkdownClass(), Markdown, 'the answer is settled once per process');
});

test('the real renderer paints every element with the role the table gave it (S3)', (t) => {
  const Markdown = loadMarkdownClass();
  if (Markdown === undefined) {
    t.skip('requires @earendil-works/pi-tui');
    return;
  }
  const asked = [];
  const theme = {
    fg(role, text) {
      asked.push(role);
      return `[${role}]${text}[/]`;
    },
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
  };
  const source = [
    '# Design',
    '',
    '- one',
    '',
    'Some `code` here',
    '',
    '```',
    'const a = 1;',
    '```',
    '',
    '> quoted',
    '',
    '---',
  ].join('\n');
  const rows = markdownRows(source, theme, 40, Markdown);
  assert.ok(rows.length > 0, 'the document drew rows');
  const body = rows.join('\n');
  for (const role of ['mdHeading', 'mdListBullet', 'mdCode', 'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr']) {
    assert.equal(asked.includes(role), true, `${role} was asked for`);
    assert.equal(body.includes(`[${role}]`), true, `${role} paints its cells`);
  }
  // Headings, quotes and rules are DRAWN, not typed: the source's own markers are gone.
  assert.doesNotMatch(body, /^# Design$/mu);
  assert.doesNotMatch(body, /^> quoted$/mu);
});

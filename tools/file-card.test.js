'use strict';
// T3 (S1/S2): the file card — a `read`, `edit` or `write` call whose path names a
// customized skill or an ODD artifact heads as that file, on this package's card
// substrate (`lib/shell-card.js`), through the host's `registerToolRenderer` hook.
//
// Every case goes through the public surface: the resolver's slots, the heading and
// row helpers the module exports, and the lines a component draws for a width.
// Nothing reads module-internal state, a repository or a terminal, and no case spawns
// anything.
//
// The text seam and the themes are the fakes `tools/bash-card.test.js` uses: this
// package has no node_modules, so width measurement, truncation and wrapping are
// injected, and colour only ever arrives as `theme.fg(role, text)`. The two switches
// and the content level are the process-wide slots the shell publishes, and the
// preference document lives in a scratch home, so no case reads or writes the real
// Pi home.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

const {
  FILE_TOOLS,
  PREVIEW_ROWS,
  fileCardHeading,
  fileResultRows,
} = require('../lib/file-card.js');
const { createFileCardResolver, registerFileCard } = require('../lib/file-card-resolver.js');
const { CARD_FILES_SLOT, writeCardFileSwitch } = require('../lib/card-files-mode.js');
const { CARD_CONTENT_SLOT } = require('../lib/card-content.js');
const { CARD_STYLE, CARD_STYLE_SLOT } = require('../lib/card-style.js');

// ---- the injected text seam (fakes: plain ASCII, each character one column) ----

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const chars = (value) => [...stripAnsi(value)];

const metrics = {
  visibleWidth(value) {
    return chars(value).length;
  },
  truncateToWidth(value, width, ellipsis = '') {
    if (width <= 0) return '';
    if (this.visibleWidth(value) <= width) return value;
    const tail = ellipsis ?? '';
    const keep = Math.max(0, width - [...tail].length);
    return chars(value).slice(0, keep).join('') + tail;
  },
  wrapTextWithAnsi(value, width) {
    const text = stripAnsi(value);
    if (width <= 0) return [text];
    return text.split('\n').flatMap((line) => {
      const lines = [];
      let current = '';
      for (const word of line.split(' ')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if ([...candidate].length <= width) {
          current = candidate;
          continue;
        }
        if (current !== '') {
          lines.push(current);
          current = '';
        }
        if ([...word].length <= width) {
          current = word;
          continue;
        }
        const rest = [...word];
        while (rest.length > width) lines.push(rest.splice(0, width).join(''));
        current = rest.join('');
      }
      lines.push(current);
      return lines;
    });
  },
};

const plainTheme = { fg: (_role, value) => value };

/** A theme that tags every painted cell, so a case can see which role painted what. */
const taggedTheme = {
  fg(role, value) {
    return `<${role}>${value}</${role}>`;
  },
};

/** A theme that can paint the float band (a `bg` that returns its own reset). */
const bandTheme = {
  fg: (_role, value) => value,
  bg: (_role, value) => `\x1b[48;5;240m${value}\x1b[49m`,
};

// The two slots the shell publishes, and a scratch preference home.
const savedHome = process.env.GENTLE_PI_CONFIG_HOME;
let configHome;

before(() => {
  configHome = mkdtempSync(join(tmpdir(), 'odd-worktree-file-card-'));
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

beforeEach(() => {
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  delete globalThis[CARD_FILES_SLOT];
  delete globalThis[CARD_CONTENT_SLOT];
});

after(() => {
  delete globalThis[CARD_STYLE_SLOT];
  delete globalThis[CARD_FILES_SLOT];
  delete globalThis[CARD_CONTENT_SLOT];
  if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
  rmSync(configHome, { recursive: true, force: true });
});

// ---- the resolver under test ----

function fileResolver(options) {
  const registered = [];
  const cards = createFileCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => registered.push(resolver),
    ...options,
  });
  assert.equal(cards.registered, true, 'the probe accepted the resolver');
  assert.equal(registered.length, 1, 'exactly one resolver reached the host hook');
  return registered[0];
}

/** A host that draws the three file tools itself, in the self shell the substrate expects. */
const HOST = {
  renderShell: 'self',
  renderCall: () => ({ render: () => ['host read call'], invalidate() {} }),
  renderResult: () => ({ render: () => ['host read result'], invalidate() {} }),
};

const SKILL = 'lib/skills/one/SKILL.md';
const ODD = 'odd/tasks/cards-skill-odd.md';

function callRows(resolver, tool, args, theme, width = 60, context = { isPartial: false }) {
  return resolver(tool, () => HOST).renderCall(args, theme, context).render(width);
}

const callRow = (resolver, tool, args, theme, context = { isPartial: false }) => callRows(resolver, tool, args, theme, 60, context)[0];

function resultRows(resolver, tool, args, result, options = { isPartial: false }, theme = plainTheme, width = 60, context = {}) {
  return resolver(tool, () => HOST).renderResult(result, options, theme, { args, ...context }).render(width);
}

const textResult = (text, extra) => ({ content: [{ type: 'text', text }], details: {}, ...(extra ?? {}) });

/** The visible text of a cell, with the ANSI a real theme paints and the tags the fake theme wraps it in removed. */
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');

/** The visible content of a body row, without the neon frame. */
const bodyText = (row) => unpaint(row).replace(/^│ /, '').replace(/ +│$/, '');

/**
 * The content of a row inside the host's own outer box: the box's left pad and the
 * width fill removed, so a case can compare it with the row the chain itself drew.
 */
const unbox = (row) => unpaint(row).replace(/^ /u, '').replace(/ +$/u, '');

/**
 * A theme that records the background roles it is asked for, painted as the ANSI the
 * fake metrics strips, so a case can see the host box's role and measure its width.
 */
function boxTheme() {
  const roles = [];
  const codes = { toolPendingBg: 33, toolErrorBg: 1, toolSuccessBg: 2 };
  return {
    roles,
    fg: (_role, value) => value,
    bg(role, value) {
      roles.push(role);
      return `\x1b[48;5;${codes[role] ?? 9}m${value}\x1b[49m`;
    },
  };
}

/** Every row the card draws must be exactly the width the host asked for. */
function assertFramed(rows, width) {
  for (const row of rows) assert.equal(metrics.visibleWidth(unpaint(row)), width, `"${unpaint(row)}" is not ${width} wide`);
}

// ---- the heading ----

test('a skill call heads with its mark, its label, the tool and the path', () => {
  const resolver = fileResolver();
  const row = callRow(resolver, 'read', { path: SKILL }, taggedTheme);
  const text = unpaint(row);
  assert.match(text, /▤ skill · read lib\/skills\/one\/SKILL\.md/u, text);
  assert.ok(row.includes('<toolTitle>▤ skill</toolTitle>'), 'the label keeps the read card\'s own title role');
  assert.ok(row.includes('<muted>·</muted>'), 'the one separator is painted muted');
  assert.equal(text.split('·').length - 1, 1, 'exactly one separator');
  assert.match(text, /[^ ] · [^ ]/u, 'one space on each side of the separator');
  assert.match(text, /^╭─ /, 'the collapsed call is the card\'s own top rule');
  assert.match(text, /╮$/, 'the row is framed');
  assertFramed([row], 60);
});

test('an odd call names its file while collapsed and its whole path once expanded', () => {
  const resolver = fileResolver();
  const args = { path: ODD };
  const collapsed = unpaint(callRow(resolver, 'read', args, taggedTheme));
  assert.match(collapsed, /📑 odd · read cards-skill-odd\.md/u, collapsed);
  assert.equal(collapsed.includes('odd/tasks'), false, 'the collapsed heading names the file, not its folder');
  assert.ok(callRow(resolver, 'read', args, taggedTheme).includes('<mdHeading>📑 odd</mdHeading>'), 'the ODD label wears the theme\'s mdHeading role');

  const expanded = callRows(resolver, 'read', args, plainTheme, 80, { isPartial: false, expanded: true }).map(bodyText).join('\n');
  assert.match(expanded, /📑 odd · read odd\/tasks\/cards-skill-odd\.md/u, expanded);
  assert.match(unpaint(collapsed), /^╭─ /u);

  // The heading is the classifier's answer, never a guess: a path it declines is
  // undefined, which is what keeps the chain's own row.
  assert.equal(fileCardHeading('read', { path: 'src/app.js' }, false), undefined);
  assert.equal(fileCardHeading('read', { path: ODD }, true).identity, 'odd');
  assert.equal(fileCardHeading('read', { path: SKILL }, false).identity, 'skill');
});

test('only a read names a line range', () => {
  const resolver = fileResolver();
  assert.match(unpaint(callRow(resolver, 'read', { path: ODD, offset: 10, limit: 30 }, plainTheme)), /read cards-skill-odd\.md:10-39/u);
  assert.match(unpaint(callRow(resolver, 'read', { path: ODD, offset: 7 }, plainTheme)), /read cards-skill-odd\.md:7\b/u);
  for (const tool of ['write', 'edit']) {
    const text = unpaint(callRow(resolver, tool, { path: ODD, offset: 10, limit: 30, content: '# a\n' }, plainTheme));
    assert.match(text, new RegExp(`${tool} cards-skill-odd\\.md`, 'u'), text);
    assert.doesNotMatch(text, /:\d/u, `${tool} states no line range`);
  }
});

// ---- the rows the card does not own ----

test('a path that names neither a skill nor an ODD artifact is the chain\'s own drawing', () => {
  const resolver = fileResolver();
  const slot = resolver('read', () => HOST);
  assert.equal(slot.renderShell, 'self', 'the card frames itself, so the host draws no filled box under it');
  assert.deepEqual(slot.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(60).map(unbox), ['host read call']);
  assert.deepEqual(
    slot.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(60).map(unbox),
    ['host read result'],
  );
  // A folder that merely holds the word is no identity either, and neither is a
  // document called SKILL.md outside a `skills` folder.
  for (const path of ['lib/skillset/notes.md', 'docs/oddity.md', 'odd/work/a.md', 'notes/SKILL.md', '', undefined, 42]) {
    assert.deepEqual(slot.renderCall({ path }, plainTheme, { isPartial: false }).render(60).map(unbox), ['host read call'], String(path));
  }
  // A detail too long for the row is forwarded as the chain drew it, never clipped by us.
  assert.deepEqual(slot.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: true }).render(20).map(unbox), ['host read call']);
});

test('every tool this card does not own is handed back exactly as the chain resolved it', () => {
  const resolver = fileResolver();
  const hostRenderers = { renderShell: 'self', renderCall: () => 'host call', renderResult: () => 'host result' };
  for (const toolName of ['bash', 'grep', 'find', 'ls', 'cat', 'codegraph', 'mcp__codegraph__codegraph_explore', 'worktree_create', 'worktree_list', 'READ', undefined, 42]) {
    assert.equal(resolver(toolName, () => hostRenderers), hostRenderers, `${String(toolName)} is the host's own row, byte for byte`);
  }
  assert.equal(resolver('grep', () => undefined), undefined, 'a chain that resolves nothing stays nothing');
  // A chain whose next() throws is never a lost row: an owned tool with an identity
  // still draws its card, and one without an identity has nothing to forward.
  const broken = resolver('read', () => {
    throw new Error('chain exploded');
  });
  assert.equal(broken.renderShell, 'self');
  assert.deepEqual(broken.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(60), []);
  assert.match(unpaint(broken.renderCall({ path: ODD }, plainTheme, { isPartial: false }).render(60)[0]), /📑 odd/u);
  // The three owned tool names, and no fourth.
  assert.deepEqual([...FILE_TOOLS].sort(), ['edit', 'read', 'write']);
});

// ---- S1: the two switches, read per paint ----

test('each switch forwards only its own kind, and reading it per paint repaints a drawn row', () => {
  const resolver = fileResolver();
  const skillCall = resolver('read', () => HOST).renderCall({ path: SKILL }, plainTheme, { isPartial: false });
  const oddCall = resolver('read', () => HOST).renderCall({ path: ODD }, plainTheme, { isPartial: false });
  assert.match(unpaint(skillCall.render(60)[0]), /▤ skill/u, 'both cards are on by default');

  globalThis[CARD_FILES_SLOT] = { skill: false, odd: true };
  try {
    assert.deepEqual(skillCall.render(60).map(unbox), ['host read call'], 'Card skill off: the chain draws the row');
    assert.match(unpaint(oddCall.render(60)[0]), /📑 odd/u, 'Card odd is still on');
  } finally {
    delete globalThis[CARD_FILES_SLOT];
  }
  assert.match(unpaint(skillCall.render(60)[0]), /▤ skill/u, 'switching back repaints the same component');

  globalThis[CARD_FILES_SLOT] = { skill: true, odd: false };
  try {
    assert.deepEqual(oddCall.render(60).map(unbox), ['host read call'], 'Card odd off: only the odd row is forwarded');
    assert.match(unpaint(skillCall.render(60)[0]), /▤ skill/u, 'Card skill is still on');
  } finally {
    delete globalThis[CARD_FILES_SLOT];
  }
});

test('a switch saved through the package\'s own writer is the switch the card paints', () => {
  const resolver = fileResolver();
  delete globalThis[CARD_FILES_SLOT];
  const saved = writeCardFileSwitch('odd', false);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  try {
    delete globalThis[CARD_FILES_SLOT];
    assert.deepEqual(
      resolver('read', () => HOST).renderCall({ path: ODD }, plainTheme, { isPartial: false }).render(60).map(unbox),
      ['host read call'],
      'the saved document decides, not only the live cell',
    );
    assert.match(
      unpaint(resolver('read', () => HOST).renderCall({ path: SKILL }, plainTheme, { isPartial: false }).render(60)[0]),
      /▤ skill/u,
      'the other kind is untouched',
    );
  } finally {
    const restored = writeCardFileSwitch('odd', true);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    // The writer publishes the slot on success; the next case must not inherit it.
    delete globalThis[CARD_FILES_SLOT];
  }
});

// ---- the host's own outer box, reproduced for every row this card hands back ----

test('a forwarded read call keeps the host\'s own box', () => {
  const resolver = fileResolver();
  const theme = boxTheme();
  const rows = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, theme, { isPartial: true }).render(40);
  assert.equal(rows.length, 1, 'one host row, one boxed row');
  const text = unpaint(rows[0]);
  assert.equal(metrics.visibleWidth(text), 40, 'the box pads the row to the width the host asked for');
  assert.equal(text.startsWith(' host read call'), true, `exactly one column of padding on the left: ${JSON.stringify(text)}`);
  assert.equal(text.endsWith('  '), true, 'the row is filled on the right, never cut');
  assert.deepEqual(theme.roles, ['toolPendingBg'], 'a call still streaming wears the pending background');

  // `outputPad` is the host's own padding, and one column is only the default.
  const widePad = boxTheme();
  const padded = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, widePad, { isPartial: false, outputPad: 3 }).render(40);
  assert.match(unpaint(padded[0]), /^ {3}host read call/u, 'the host pad is the one the context states');
  assert.equal(metrics.visibleWidth(unpaint(padded[0])), 40);
});

test('a forwarded result wears the host background its state names', () => {
  const resolver = fileResolver();
  const args = { path: 'src/app.js' };
  const slot = resolver('read', () => HOST);

  const settled = boxTheme();
  slot.renderResult(textResult('code'), { isPartial: false }, settled, { args }).render(40);
  assert.deepEqual(settled.roles, ['toolSuccessBg'], 'a settled result is the success background');

  const failed = boxTheme();
  const failedRows = slot.renderResult(textResult('boom', { isError: true }), { isPartial: false }, failed, { args }).render(40);
  assert.deepEqual(failed.roles, ['toolErrorBg'], 'a failed result is the error background');
  assert.equal(unbox(failedRows[0]), 'host read result', 'the chain\'s own row is kept');

  // `isError` stated in the render options is the same state as the result flag.
  const fromOptions = boxTheme();
  slot.renderResult(textResult('boom'), { isPartial: false, isError: true }, fromOptions, { args }).render(40);
  assert.deepEqual(fromOptions.roles, ['toolErrorBg']);

  // A streamed result is the pending background, from the context's own flag.
  const partial = boxTheme();
  slot.renderResult(textResult('code'), { isPartial: true }, partial, { args }).render(40);
  assert.deepEqual(partial.roles, ['toolPendingBg']);
});

test('the forwarded text is byte-identical to the row the chain drew, and is never cut', () => {
  const resolver = fileResolver();
  const width = 40;
  const pad = 1;
  const call = resolver('read', () => HOST);
  const hostCallRows = HOST.renderCall({ path: 'src/app.js' }, plainTheme, {}).render(width - pad * 2);
  const forwardedCall = call.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(width);
  assert.deepEqual(forwardedCall.map(unbox), hostCallRows.map(stripAnsi), 'the same text the chain drew, at the box\'s inner width');

  // A row wider than the box budget is kept, not clipped: the outer box loses its fill,
  // never a character.
  const long = 'x'.repeat(120);
  const LONG = { renderShell: 'self', renderCall: () => ({ render: () => [long], invalidate() {} }) };
  const longRows = resolver('read', () => LONG).renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(20);
  assert.equal(unbox(longRows[0]), long, 'a row too wide for the box keeps every column');

  // The result slot reproduces the same box: the host's own renderer is asked for the
  // inner width and its rows come back padded to the outer one.
  const hostResultRows = HOST.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(width - pad * 2);
  const forwardedResult = resolver('read', () => HOST)
    .renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } })
    .render(width);
  assert.deepEqual(forwardedResult.map(unbox), hostResultRows.map(stripAnsi));
});

test('a chain row that cannot be drawn adds nothing and never throws', () => {
  const resolver = fileResolver();
  const THROWING_COMPONENT = {
    renderShell: 'self',
    renderCall: () => ({
      render: () => {
        throw new Error('render exploded');
      },
      invalidate() {},
    }),
    renderResult: () => {
      throw new Error('renderer exploded');
    },
  };
  const slot = resolver('read', () => THROWING_COMPONENT);
  assert.deepEqual(slot.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(40), []);
  assert.doesNotThrow(() => slot.renderCall({ path: 'src/app.js' }, boxTheme(), { isPartial: false }).render(40));
  assert.deepEqual(slot.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(40), []);

  // No inherited slot at all is no box either, and no throw.
  const nothing = resolver('read', () => undefined);
  assert.deepEqual(nothing.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(40), []);
  assert.doesNotThrow(() => nothing.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(40));

  // A theme that cannot paint a background still draws the padded row.
  const bare = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: true }).render(40);
  assert.match(unpaint(bare[0]), /^ host read call +$/u, 'a theme without bg keeps the box\'s padding');
});

test('a row forwarded because its switch is off is the same boxed row as a path with no identity', () => {
  const resolver = fileResolver();
  const plain = boxTheme();
  const off = boxTheme();
  const plainRows = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, plain, { isPartial: false }).render(40);
  globalThis[CARD_FILES_SLOT] = { skill: false, odd: false };
  try {
    const offRows = resolver('read', () => HOST).renderCall({ path: ODD }, off, { isPartial: false }).render(40);
    assert.deepEqual(offRows, plainRows, 'both are the host\'s own boxed row');
    assert.deepEqual(off.roles, plain.roles);
  } finally {
    delete globalThis[CARD_FILES_SLOT];
  }
});

// ---- S2: the content level, read per paint ----

test('the content level is read per paint: `minimal` is the call alone, `default` the bounded preview', () => {
  const resolver = fileResolver();
  const args = { path: 'odd/tasks/notes.json' };
  const result = textResult(['one', 'two', 'three', 'four', 'five', 'six'].join('\n'));
  const component = resolver('read', () => HOST).renderResult(result, { isPartial: false }, plainTheme, { args });

  const defaultRows = component.render(60);
  assert.equal(defaultRows.length, PREVIEW_ROWS + 1, 'three preview rows and the closing rule');
  assert.deepEqual(defaultRows.slice(0, PREVIEW_ROWS).map(bodyText), ['one', 'two', 'three'], 'a document previews from its top');
  assert.match(unpaint(defaultRows.at(-1)), /^╰/u);

  globalThis[CARD_CONTENT_SLOT] = 'minimal';
  try {
    const minimalRows = component.render(60);
    assert.equal(minimalRows.length, 1, 'a minimized card is the call alone plus its closing rule');
    assert.match(unpaint(minimalRows[0]), /^╰/u, 'the one row is the closing rule');
  } finally {
    delete globalThis[CARD_CONTENT_SLOT];
  }
  assert.deepEqual(component.render(60), defaultRows, 'flipping the level back repaints the same rows');

  const expanded = resolver('read', () => HOST)
    .renderResult(result, { expanded: true, isPartial: false }, plainTheme, { args })
    .render(60);
  assert.equal(expanded.length, 7, 'expanding is the reader\'s own ask: the whole result');
  assert.deepEqual(expanded.slice(0, 6).map(bodyText), ['one', 'two', 'three', 'four', 'five', 'six']);
});

test('the row decision itself says which level withholds a body, and a failure still says why', () => {
  assert.deepEqual(fileResultRows({ content: 'minimal', text: 'a\nb', failed: false, expanded: false }), []);
  assert.equal(fileResultRows({ content: 'default', text: 'a\nb\nc\nd', failed: false, expanded: false })[0].text, 'a\nb\nc');
  const failed = fileResultRows({ content: 'minimal', text: 'ENOENT', failed: true, expanded: false });
  assert.deepEqual(failed, [{ text: 'ENOENT', role: 'error' }], 'a minimized failure keeps its reason');
  assert.deepEqual(fileResultRows({ content: 'default', text: '   ', failed: false, expanded: false }), [], 'no output draws no row');
});

// ---- S2: both styles, read per paint ----

test('the same card is drawn in both styles, and the style is read on every paint', () => {
  const resolver = fileResolver();
  const draw = (style, run) => {
    globalThis[CARD_STYLE_SLOT] = style;
    try {
      return run();
    } finally {
      globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
    }
  };
  const call = (style) => draw(style, () => callRows(resolver, 'read', { path: SKILL }, bandTheme, 60));
  const result = (style) => draw(style, () => resultRows(resolver, 'read', { path: SKILL }, textResult('a\nb\nc\nd'), { isPartial: false }, bandTheme));

  const neon = call(CARD_STYLE.NEON);
  const float = call(CARD_STYLE.FLOAT);
  assert.match(unpaint(neon[0]), /^╭─/u, 'neon draws its rounded frame');
  assert.ok(float.some((row) => unpaint(row).includes('▎')), 'float draws its rail');
  assert.equal(float.some((row) => /[╭╮╰╯]/u.test(unpaint(row))), false, 'float draws no box');

  // One card's content, two chromes: the same words in both styles.
  const content = (rows) => rows
    .map((row) => unpaint(row).replace(/[╭╮╰╯─│▎]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' | ');
  assert.equal(content(neon), content(float));
  assert.equal(content(result(CARD_STYLE.FLOAT)), content(result(CARD_STYLE.NEON)), 'the body is the same in both styles');
});

// ---- L5: the expanded Markdown body ----

test('an expanded read of a Markdown file renders the document, not its source', () => {
  const resolver = fileResolver();
  const source = ['# Design', '', '## Specs', '', 'Some **bold** text and `code`', ''].join('\n');
  const rows = resultRows(resolver, 'read', { path: ODD }, textResult(source), { expanded: true, isPartial: false }, plainTheme, 60);
  const body = rows.slice(0, -1).map(bodyText).join('\n');
  assert.doesNotMatch(body, /## /u, `a Markdown heading is drawn, not typed: ${JSON.stringify(body)}`);
  assert.doesNotMatch(body, /\*\*/u, 'emphasis is consumed by the renderer');
  assert.match(body, /Design/u);
  assert.match(body, /▌ Specs|Specs/u, 'the heading keeps its own mark');
  assert.match(body, /Some bold text and code/u);

  // A write draws the content it wrote, which the call carries and the result does not echo.
  const written = resultRows(
    resolver,
    'write',
    { path: ODD, content: '## Task\n\n- one\n' },
    textResult('Wrote 20 bytes'),
    { expanded: true, isPartial: false },
    plainTheme,
    60,
  );
  const writtenBody = written.slice(0, -1).map(bodyText).join('\n');
  assert.match(writtenBody, /Task/u);
  assert.doesNotMatch(writtenBody, /## Task/u, 'the write body is the document it wrote');
});

test('a collapsed row, a failed call and a non-Markdown file keep their plain rows', () => {
  const resolver = fileResolver();
  const source = ['# Design', '', '## Specs'].join('\n');
  const collapsed = resultRows(resolver, 'read', { path: ODD }, textResult(source), { isPartial: false }, plainTheme, 60);
  assert.deepEqual(collapsed.slice(0, -1).map(bodyText), ['# Design', '', '## Specs'], 'a preview is the file\'s own rows');

  const failed = resultRows(resolver, 'read', { path: ODD }, textResult(source, { isError: true }), { expanded: true, isPartial: false }, plainTheme, 60);
  assert.match(unpaint(failed[0]), /^│ # Design/u, 'a failure keeps its rows as they were reported');

  const json = resultRows(resolver, 'read', { path: 'odd/tasks/data.json' }, textResult('{"a":1}'), { expanded: true, isPartial: false }, plainTheme, 60);
  assert.deepEqual(json.slice(0, -1).map(bodyText), ['{"a":1}'], 'a non-Markdown file is drawn as it is');
});

test('an edit draws its diff and is never rendered as a document', () => {
  const resolver = fileResolver();
  const diff = ['@@ -1,2 +1,2 @@', '-**old**', '+**new**'].join('\n');
  const args = { path: ODD, old_string: '**old**', new_string: '**new**' };
  const collapsed = resultRows(resolver, 'edit', args, textResult('Edited', { details: { diff } }), { isPartial: false }, plainTheme, 60);
  assert.deepEqual(collapsed.slice(0, -1).map(bodyText), ['@@ -1,2 +1,2 @@', '-**old**', '+**new**'], 'the diff is the edit\'s rows');

  const expanded = resultRows(resolver, 'edit', args, textResult('Edited', { details: { diff } }), { expanded: true, isPartial: false }, plainTheme, 60);
  const body = expanded.slice(0, -1).map(bodyText).join('\n');
  assert.equal(body, diff, 'expanding an edit shows the whole diff, not a document');
  assert.doesNotMatch(body, /▌/u, 'a Markdown path does not turn an edit into a document');

  // A result that carries no diff is its own text.
  const plain = resultRows(resolver, 'edit', args, textResult('Edited 2 lines'), { isPartial: false }, plainTheme, 60);
  assert.deepEqual(plain.slice(0, -1).map(bodyText), ['Edited 2 lines']);
});

test('a failed result keeps its error rows and the error tone', () => {
  const resolver = fileResolver();
  const rows = resultRows(resolver, 'read', { path: ODD }, textResult('ENOENT: no such file', { isError: true }), { isPartial: false }, taggedTheme);
  assert.match(rows[0], /^<error>│<\/error>/u, 'a failure paints its frame in the error role');
  assert.match(rows[0], /<error>ENOENT: no such file<\/error>/u, 'and its reason too');
  assert.match(rows.at(-1), /^<error>╰/u);
  assertFramed(rows, 60);

  // The host's own `isError` in the render options is the same flag.
  const fromOptions = resultRows(resolver, 'read', { path: ODD }, textResult('boom'), { isPartial: false, isError: true }, taggedTheme);
  assert.match(fromOptions[0], /^<error>│/u);
});

test('a call still running is the warning tone and closes its own frame', () => {
  const resolver = fileResolver();
  const rows = callRows(resolver, 'read', { path: ODD }, taggedTheme, 40, { isPartial: true });
  assert.equal(rows.length, 3, 'a heading, the running row and the closed frame');
  assert.match(rows[0], /^<warning>╭<\/warning>/u, 'pending is the warning tone');
  assert.match(rows[1], /^<warning>│<\/warning> <muted>running…<\/muted>/u);
  assert.match(rows[2], /^<warning>╰/u);
  assertFramed(rows, 40);
  assert.equal(callRows(resolver, 'read', { path: ODD }, plainTheme, 40, { isPartial: false }).length, 1, 'a settled call leaves the closing rule to its result');
});

// ---- the identity's two columns are the metrics', never a hand count ----

test('the ODD mark\'s two columns are measured by the injected seam', () => {
  // The same seam, counting the artifact mark as the two columns it occupies. A card
  // that hand-counted the glyph would pad a column off.
  const wide = (value) => [...stripAnsi(value)].reduce((total, char) => total + (char === '📑' ? 2 : 1), 0);
  const wideMetrics = {
    visibleWidth: wide,
    truncateToWidth(value, width, ellipsis = '') {
      if (width <= 0) return '';
      if (wide(value) <= width) return value;
      const keep = Math.max(0, width - [...ellipsis].length);
      return [...stripAnsi(value)].slice(0, keep).join('') + ellipsis;
    },
    wrapTextWithAnsi: metrics.wrapTextWithAnsi,
  };
  const resolver = fileResolver({ metrics: wideMetrics });
  for (const width of [20, 40, 60, 80]) {
    const call = callRows(resolver, 'read', { path: ODD, offset: 3, limit: 7 }, plainTheme, width);
    for (const row of call) assert.equal(wide(row), width, `"${row}" is not ${width} columns`);
    const result = resultRows(resolver, 'read', { path: ODD }, textResult('a\nb'), { isPartial: false }, plainTheme, width);
    for (const row of result) assert.equal(wide(row), width, `"${row}" is not ${width} columns`);
  }
});

// ---- paint last: no painted string is ever measured ----

test('the body is measured and clipped as plain text, and painted only afterwards', () => {
  const seen = [];
  const spyMetrics = {
    visibleWidth(value) {
      seen.push(value);
      return metrics.visibleWidth(value);
    },
    truncateToWidth(value, width, ellipsis) {
      seen.push(value);
      return metrics.truncateToWidth(value, width, ellipsis);
    },
    wrapTextWithAnsi(value, width) {
      seen.push(value);
      return metrics.wrapTextWithAnsi(value, width);
    },
  };
  const resolver = fileResolver({ metrics: spyMetrics });
  for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
    globalThis[CARD_STYLE_SLOT] = style;
    try {
      const call = callRows(resolver, 'read', { path: ODD, offset: 1, limit: 9 }, taggedTheme, 44);
      const result = resultRows(resolver, 'read', { path: ODD }, textResult('# Title\n\n## Specs\n\nBody text'), { expanded: true, isPartial: false }, taggedTheme, 44);
      const edit = resultRows(resolver, 'edit', { path: ODD }, textResult('Edited', { details: { diff: '-a\n+b' } }), { isPartial: false }, taggedTheme, 44);
      assert.ok([...call, ...result, ...edit].some((row) => row.includes('<')), `${style}: the rows were painted`);
    } finally {
      globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
    }
  }
  assert.ok(seen.length > 0, 'the seams were used');
  for (const value of seen) {
    assert.equal(typeof value, 'string');
    assert.equal(value.includes(String.fromCharCode(27)), false, `a painted string reached the measurement seam: ${JSON.stringify(value)}`);
    assert.doesNotMatch(value, /<\/?[a-zA-Z][a-zA-Z0-9]*>/u, `a painted row reached the measurement seam: ${JSON.stringify(value)}`);
  }
});

// ---- geometry ----

test('the card draws at every width the host may ask for', () => {
  const resolver = fileResolver();
  for (const width of [0, 1, 2, 3, 5, 9, 10, 12, 16, 61]) {
    for (const drawn of [
      callRows(resolver, 'read', { path: ODD }, plainTheme, width, { isPartial: true }),
      callRows(resolver, 'read', { path: ODD, offset: 2, limit: 4 }, plainTheme, width, { isPartial: false, expanded: true }),
      resultRows(resolver, 'read', { path: SKILL }, textResult('a\nb\nc\nd'), { isPartial: false }, plainTheme, width),
      resultRows(resolver, 'write', { path: ODD }, textResult('# T\n\n## S'), { expanded: true, isPartial: false }, plainTheme, width),
    ]) {
      for (const row of drawn) assert.ok(metrics.visibleWidth(unpaint(row)) <= width, `"${unpaint(row)}" overflows ${width}`);
    }
  }
});

// ---- the factory's contract ----

test('the factory registers through the host hook when it can, and fails open when it cannot', () => {
  const seen = [];
  const registered = createFileCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => seen.push(resolver),
  });
  assert.equal(registered.registered, true);
  assert.equal(seen[0], registered.resolver);

  // No hook is an older host: nothing of ours is drawn, and nothing throws.
  const none = createFileCardResolver({ metrics, theme: plainTheme });
  assert.equal(none.registered, false);
  assert.doesNotThrow(() => none.resolver('read', () => undefined));

  // A hook that throws is the same as none.
  const hostile = createFileCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: () => {
      throw new Error('hook refused');
    },
  });
  assert.equal(hostile.registered, false);
  assert.match(unpaint(hostile.resolver('read', () => HOST).renderCall({ path: ODD }, plainTheme, { isPartial: false }).render(60)[0]), /📑 odd/u);

  // The measurement seam is part of the contract, and the factory says which one is missing.
  assert.throws(() => createFileCardResolver(), /metrics/u);
  const broken = { ...metrics, wrapTextWithAnsi: undefined };
  assert.throws(() => createFileCardResolver({ metrics: broken }), /wrapTextWithAnsi/u);

  // A seam resolved late (the host's TUI package is loaded inside the hook) is read per paint.
  const late = createFileCardResolver({
    metrics: () => metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => seen.push(resolver),
  });
  assert.equal(late.resolver('read', () => HOST).renderShell, 'self');
  // A seam that resolves to nothing leaves the row to the host.
  const absent = createFileCardResolver({
    metrics: () => undefined,
    theme: plainTheme,
    registerToolRenderer: (resolver) => seen.push(resolver),
  });
  assert.equal(absent.resolver('read', () => HOST), HOST, 'the host\'s own row keeps the row');
});

test('registerFileCard wires the Pi host in, and a host without the hook loses nothing', () => {
  const registered = [];
  const outcome = registerFileCard({ registerToolRenderer: (resolver) => registered.push(resolver) }, { metrics, theme: plainTheme });
  assert.equal(outcome.registered, true);
  assert.equal(registered.length, 1, 'exactly one resolver reached the host');
  assert.equal(registered[0], outcome.resolver);

  assert.deepEqual(registerFileCard(undefined, { metrics, theme: plainTheme }), { registered: false, resolver: undefined });
  assert.deepEqual(registerFileCard({}, { metrics, theme: plainTheme }), { registered: false, resolver: undefined });
  // A host whose hook throws, and a missing seam: the card is cosmetic, so both fail open.
  const hostile = registerFileCard({ registerToolRenderer: () => { throw new Error('no'); } }, { metrics, theme: plainTheme });
  assert.equal(hostile.registered, false);
  assert.equal(registerFileCard({ registerToolRenderer: () => {} }, {}).registered, false);
});

// ---- purity ----

test('the card modules carry no colour, no escape and no host package', () => {
  for (const file of ['file-card.js', 'file-card-resolver.js']) {
    const source = readFileSync(join(__dirname, '..', 'lib', file), 'utf8');
    assert.doesNotMatch(source, /@earendil-works/u, `${file} requires no host package`);
    assert.doesNotMatch(source, /\\u001b|\\x1b|String\.fromCharCode\(27\)/u, `${file} writes no escape sequence down`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/u, `${file} writes no hexadecimal colour`);
    assert.doesNotMatch(source, /require\(['"](?!\.\/|node:)/u, `${file} imports only its own modules and Node builtins`);
    assert.doesNotMatch(source, /registerTool\(|\.execute\b|registerCommand\(/u, `${file} registers and runs nothing`);
  }
  // This card's own tone table is `lib/shell-card.js`'s alone. The ONLY background
  // roles named here are the host's own box roles, reproduced for the rows this card
  // hands back (a resolver cannot see a call's args, so it cannot tell the host's
  // default-shell read/write rows apart at claim time).
  const card = readFileSync(join(__dirname, '..', 'lib', 'file-card.js'), 'utf8');
  const named = [...card.matchAll(/\btool[A-Za-z]+Bg\b/gu)].map((match) => match[0]);
  assert.deepEqual([...new Set(named)].sort(), ['toolErrorBg', 'toolPendingBg', 'toolSuccessBg'], 'only the host box\'s three roles are named');
  const resolver = readFileSync(join(__dirname, '..', 'lib', 'file-card-resolver.js'), 'utf8');
  assert.doesNotMatch(resolver, /tool(?:Success|Pending|Error)Bg/u, 'the resolver names no background role at all');
});

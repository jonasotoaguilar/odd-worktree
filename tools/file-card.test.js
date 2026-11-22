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
// injected, and colour only ever arrives as `theme.fg(role, text)`. The one switch is
// the bridge's published reader (`api.resolveToolDesignSelection`), a process-wide slot
// this file publishes and withdraws; the content level is the shell's own slot.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { after, afterEach, beforeEach, test } = require('node:test');

const {
  FILE_TOOLS,
  PREVIEW_ROWS,
  fileCardHeading,
  fileResultRows,
} = require('../lib/file-card.js');
const { createFileCardResolver, registerFileCard } = require('../lib/file-card-resolver.js');
// The design this package registers on the bridge's `Card activity` line: the card's one
// switch is that line's answer for the tool being drawn, so the card is only painted
// for a tool the line actually covers.
const { toolsActivityDesign } = require('../lib/bash-design.js');
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

// The two slots the shell publishes, and the bridge's own published object.
const BRIDGE_API_SLOT = Symbol.for('gentle-shell-bridge/api/v1');

beforeEach(() => {
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  delete globalThis[CARD_CONTENT_SLOT];
  delete globalThis[BRIDGE_API_SLOT];
});

afterEach(() => {
  delete globalThis[BRIDGE_API_SLOT];
});

after(() => {
  delete globalThis[CARD_STYLE_SLOT];
  delete globalThis[CARD_CONTENT_SLOT];
  delete globalThis[BRIDGE_API_SLOT];
});

// ---- the bridge's one switch (S1/S7) ----

const ACTIVITY = Object.freeze({ kind: 'design', design: { id: 'odd-worktree.bash-activity' } });
const NATIVE = Object.freeze({ kind: 'native' });

/**
 * A published bridge object, exactly as the host hands it over: identity, major version,
 * its release, and the ONE optional reader this card asks. `selection` is an answer or a
 * function of the tool being drawn; `asked` collects every question.
 */
function publishedBridge(selection, asked) {
  return {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    VERSION: '0.7.0',
    registerToolDesign: () => () => {},
    resolveToolDesignSelection(tool) {
      if (asked !== undefined) asked.push(tool);
      return typeof selection === 'function' ? selection(tool) : selection;
    },
  };
}

/** Publish a bridge on the slot the host publishes it on, and hand it back. */
function publishBridge(selection, asked) {
  const api = publishedBridge(selection, asked);
  globalThis[BRIDGE_API_SLOT] = api;
  return api;
}

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

/** A host that draws the three file tools itself, in the DEFAULT shell: Pi's `read` and `write` renderers declare no shell, so the host wraps them in its own box. */
const HOST = {
  renderCall: () => ({ render: () => ['host read call'], invalidate() {} }),
  renderResult: () => ({ render: () => ['host read result'], invalidate() {} }),
};

/** A host renderer that frames itself: Pi's `edit` declares `renderShell: 'self'`, and the host draws NO box around it. */
const HOST_EDIT = {
  renderShell: 'self',
  renderCall: () => ({ render: () => ['host edit call'], invalidate() {} }),
  renderResult: () => ({ render: () => ['host edit result'], invalidate() {} }),
};

/** The rows that carry content: the host box's own padding rows are blank. */
const boxedContent = (rows) => rows.filter((row) => unpaint(row).trim() !== '');

/** The text of the rows a forwarded group contributes, blanks aside. */
const forwardedText = (rows) => boxedContent(rows).map(unbox);

/** A background-painted blank row: the full width, and nothing on it. */
function assertBlankRow(row, width) {
  assert.equal(metrics.visibleWidth(unpaint(row)), width, `the blank row is not ${width} wide: ${JSON.stringify(unpaint(row))}`);
  assert.equal(unpaint(row).trim(), '', 'the blank row carries no text');
  assert.ok(row.length > 0, 'the blank row is drawn, not omitted');
}

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
 * One body row's CONTENT as painted: the card's own frame cells — its side and its rail —
 * removed, the content's own roles kept. The frame wears the identity's role, so a case
 * about what a document's rows wear has to look past it.
 */
const bodyPaint = (rows) => rows
  .replace(/^<[A-Za-z]+>(?:│|▎)<\/[A-Za-z]+> /gmu, '')
  .replace(/ +<[A-Za-z]+>(?:│|▎)<\/[A-Za-z]+>$/gmu, '');

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
  assert.match(text, /▤ skill · read one\/SKILL\.md/u, text);
  assert.ok(row.includes('<mdHeading>▤</mdHeading> <mdHeading>skill</mdHeading>'), 'the glyph and the label wear the theme\'s mdHeading role');
  assert.ok(row.includes('<muted>·</muted>'), 'the one separator is painted muted');
  assert.equal(text.split('·').length - 1, 1, 'exactly one separator');
  assert.match(text, /[^ ] · [^ ]/u, 'one space on each side of the separator');
  assert.match(text, /^╭─ /, 'the collapsed call is the card\'s own top rule');
  assert.match(text, /╮$/, 'the row is framed');
  assertFramed([row], 60);
});

// The convention is the folder, and it holds for every tool the card claims: a reference
// file below a `skills` folder is that skill's, so reading, writing or editing it heads as
// that skill, and anything below an `odd` folder heads as that ODD whatever it is called.
test('read, write and edit all wear the identity of the folder their file lives in', () => {
  const resolver = fileResolver();
  for (const tool of ['read', 'write', 'edit']) {
    const skill = unpaint(callRow(resolver, tool, { path: 'skills/merge-pr/references/commands.md' }, plainTheme));
    assert.match(skill, new RegExp(`▤ skill · ${tool} merge-pr/references/commands\\.md`, 'u'), skill);
    const odd = unpaint(callRow(resolver, tool, { path: 'odd/design/notes.md' }, plainTheme));
    assert.match(odd, new RegExp(`📑 odd · ${tool} notes\\.md`, 'u'), odd);
  }
});

test('an odd call names its file while collapsed and its whole path once expanded', () => {
  const resolver = fileResolver();
  const args = { path: ODD };
  const collapsed = unpaint(callRow(resolver, 'read', args, taggedTheme));
  assert.match(collapsed, /📑 odd · read cards-skill-odd\.md/u, collapsed);
  assert.equal(collapsed.includes('odd/tasks'), false, 'the collapsed heading names the file, not its folder');
  assert.ok(
    callRow(resolver, 'read', args, taggedTheme).includes('<mdHeading>📑</mdHeading> <mdHeading>odd</mdHeading>'),
    'the ODD mark and label wear the theme\'s mdHeading role',
  );

  const expanded = callRows(resolver, 'read', args, plainTheme, 80, { isPartial: false, expanded: true }).map(bodyText).join('\n');
  assert.match(expanded, /📑 odd · read odd\/tasks\/cards-skill-odd\.md/u, expanded);
  assert.match(unpaint(collapsed), /^╭─ /u);

  // The heading is the classifier's answer, never a guess: a path it declines is
  // undefined, which is what keeps the chain's own row.
  assert.equal(fileCardHeading('read', { path: 'src/app.js' }, false), undefined);
  assert.equal(fileCardHeading('read', { path: ODD }, true).identity, 'odd');
  assert.equal(fileCardHeading('read', { path: SKILL }, false).identity, 'skill');
});

test('the heading wears one theme role per element (S2)', () => {
  const resolver = fileResolver();
  const row = callRow(resolver, 'read', { path: SKILL, offset: 2, limit: 3 }, taggedTheme);

  // The glyph AND the label wear the identity's own role (`mdHeading` for both
  // identities); the label is the only one bolded, and the glyph is never bold.
  assert.equal(row.includes('<mdHeading>▤</mdHeading>'), true, `the glyph wears the title role: ${row}`);
  assert.equal(row.includes('<mdHeading>skill</mdHeading>'), true, 'the label wears the title role');
  // The `·` separator in `muted`, the tool name in `dim`, the path in `accent`, the
  // range in `warning` — in that order, on one row.
  assert.equal(row.includes('<muted>·</muted> <dim>read</dim> <accent>one/SKILL.md</accent><warning>:2-4</warning>'), true, row);
  assert.equal(row.includes('<accent>one/SKILL.md</accent>'), true, 'the path is the accent role');
  assert.equal(row.includes('<dim>read</dim>'), true, 'the tool name is the dim role');

  // A theme with a bold attribute: the label carries it, inside the role.
  const boldTheme = { fg: (role, value) => `<${role}>${value}</${role}>`, bold: (value) => `*${value}*` };
  const bolded = callRow(resolver, 'read', { path: SKILL }, boldTheme);
  assert.equal(bolded.includes('<mdHeading>*skill*</mdHeading>'), true, `the label is bold: ${bolded}`);
  assert.equal(bolded.includes('<mdHeading>*▤*</mdHeading>'), false, 'the glyph is not bold');

  // An ODD artifact heads in the theme's own `mdHeading`, and while collapsed it names its
  // file, in the accent role like every path.
  const odd = callRow(resolver, 'read', { path: ODD, offset: 10, limit: 30 }, taggedTheme);
  assert.equal(odd.includes('<mdHeading>📑</mdHeading>'), true, odd);
  assert.equal(odd.includes('<mdHeading>odd</mdHeading>'), true, odd);
  assert.equal(odd.includes('<dim>read</dim> <accent>cards-skill-odd.md</accent><warning>:10-39</warning>'), true, odd);
});

// The title role of BOTH identities is the theme's `mdHeading`: the card carries no
// colour of its own, so the theme decides what a skill and an ODD artifact look like.
test('both identities head in the theme\'s mdHeading role', () => {
  const resolver = fileResolver();
  for (const [path, head] of [[SKILL, '<mdHeading>▤</mdHeading> <mdHeading>skill</mdHeading>'], [ODD, '<mdHeading>📑</mdHeading> <mdHeading>odd</mdHeading>']]) {
    const row = callRow(resolver, 'read', { path }, taggedTheme);
    assert.equal(row.includes(head), true, `${path}: ${row}`);
    assert.equal(/<toolTitle>/u.test(row), false, `no cell wears the old skill role: ${row}`);
  }
});

// The tool name is the theme's `dim` grey: the call is the quiet part of the heading,
// the path is what the card is about.
test('the tool name is painted in dim, for a read and for a write', () => {
  const resolver = fileResolver();
  for (const tool of ['read', 'write']) {
    const row = callRow(resolver, tool, { path: ODD, content: '# a\n' }, taggedTheme);
    assert.equal(row.includes(`<dim>${tool}</dim>`), true, `${tool}: ${row}`);
    assert.equal(row.includes(`<muted>·</muted> <dim>${tool}</dim> <accent>cards-skill-odd.md</accent>`), true, `${tool}: ${row}`);
  }
});

// A collapsed skill names the path from the skill's own folder down; expanding it
// states the whole path, so nothing is lost, it is only deferred.
test('a collapsed skill names its path from its skill folder down, expanded states all of it', () => {
  const resolver = fileResolver();
  const path = '/home/dev/lib/skills/one/SKILL.md';
  const collapsed = callRow(resolver, 'read', { path }, taggedTheme);
  const text = unpaint(collapsed);
  assert.match(text, /▤ skill · read one\/SKILL\.md/u, text);
  assert.equal(text.includes('/home/dev'), false, 'the folders above the skill are not named while collapsed');
  assert.equal(collapsed.includes('<accent>one/SKILL.md</accent>'), true, `the named path is the accent role: ${collapsed}`);

  const expanded = callRows(resolver, 'read', { path }, plainTheme, 120, { isPartial: false, expanded: true })
    .map(unpaint)
    .join('\n');
  assert.match(expanded, /read \/home\/dev\/lib\/skills\/one\/SKILL\.md/u, expanded);
});

// The whole frame is the identity's: an idle call's corners, rules, sides and closing
// rule wear the same role as its label. A live call keeps its tone, because the state
// speaks first (`TONE_OWNS_BOX`).
test('an idle file card wears its identity role around the whole frame', () => {
  const resolver = fileResolver();
  for (const path of [SKILL, ODD]) {
    const call = callRow(resolver, 'read', { path }, taggedTheme);
    assert.ok(call.startsWith('<mdHeading>╭</mdHeading>'), `${path}: the top-left corner wears the identity role: ${call}`);
    assert.ok(call.endsWith('<mdHeading>╮</mdHeading>'), `${path}: the top-right corner too: ${call}`);

    const closed = resultRows(resolver, 'read', { path }, textResult('body line'), { isPartial: false }, taggedTheme);
    assert.ok(closed[0].startsWith('<mdHeading>│</mdHeading>'), `${path}: the sides wear it: ${closed[0]}`);
    assert.ok(closed[0].endsWith('<mdHeading>│</mdHeading>'), `${path}: both sides: ${closed[0]}`);
    assert.ok(closed.at(-1).startsWith('<mdHeading>╰</mdHeading>'), `${path}: the closing rule too: ${closed.at(-1)}`);
  }

  // A running call and a failed one keep their own tone: the state speaks first.
  const running = callRow(resolver, 'read', { path: SKILL }, taggedTheme, { isPartial: true });
  assert.ok(running.startsWith('<warning>╭</warning>'), `a running call keeps the warning tone: ${running}`);
  const failed = resultRows(resolver, 'read', { path: SKILL }, textResult('ENOENT', { isError: true }), { isPartial: false }, taggedTheme);
  assert.ok(failed[0].startsWith('<error>│</error>'), `a failed call keeps the error tone: ${failed[0]}`);
});

test('a heading that fits keeps every role through the expansion too', () => {
  const resolver = fileResolver();
  const rows = callRows(resolver, 'read', { path: ODD, offset: 2, limit: 3 }, taggedTheme, 80, { isPartial: false, expanded: true });
  const heading = rows[0];
  // Expanded states the whole path, and the whole path is still the accent role.
  assert.equal(heading.includes('<accent>odd/tasks/cards-skill-odd.md</accent>'), true, heading);
  assert.equal(heading.includes('<warning>:2-4</warning>'), true, heading);
  assert.equal(heading.includes('<mdHeading>odd</mdHeading>'), true, heading);
});

test('an expanded heading that overflows states its identity on the rule and its path once', () => {
  const resolver = fileResolver();
  const rows = callRows(resolver, 'read', { path: ODD }, plainTheme, 40, { isPartial: false, expanded: true });
  const text = rows.map(unpaint).join('\n');
  // The continued layout drops the detail AND the segments it is drawn from: the rule
  // states the identity alone, exactly as the baseline did, and the full detail follows
  // on the rows below it.
  assert.equal(unpaint(rows[0]), `╭─ 📑 odd ${'─'.repeat(30)}╮`, `the identity alone on the rule: ${unpaint(rows[0])}`);
  assert.equal(text.includes('odd/tasks'), true, 'the whole path is stated below');
  assert.equal(text.split('odd/tasks/cards-skill-odd.md').length - 1, 1, `the path is stated once: ${text}`);
  assert.equal(text.split('·').length - 1, 1, `one separator, never two: ${text}`);
  assert.match(unpaint(rows[1]), /^│ · read odd\/tasks\/cards-skill-odd\.md +│$/u, `the detail continues once: ${unpaint(rows[1])}`);
  assertFramed(rows, 40);
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
  assert.deepEqual(forwardedText(slot.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(60)), ['host read call']);
  assert.deepEqual(
    forwardedText(slot.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(60)),
    ['host read result'],
  );
  // A folder that merely holds the word is no identity either, and neither is a
  // document called SKILL.md outside a `skills` folder.
  for (const path of ['lib/skillset/notes.md', 'docs/oddity.md', 'odd-work/a.md', 'notes/SKILL.md', '', undefined, 42]) {
    assert.deepEqual(forwardedText(slot.renderCall({ path }, plainTheme, { isPartial: false }).render(60)), ['host read call'], String(path));
  }
  // A detail too long for the row is forwarded as the chain drew it, never clipped by us.
  assert.deepEqual(forwardedText(slot.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: true }).render(20)), ['host read call']);
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

// ---- S1/S7: one switch, asked of the bridge on every paint ----

test('the bridge\'s answer decides, and asking it per paint repaints a drawn row', () => {
  const resolver = fileResolver();
  const asked = [];
  const call = resolver('read', () => HOST).renderCall({ path: SKILL }, plainTheme, { isPartial: false });

  // A bridge that names another value (the reserved `default`, a design of the line that
  // has left it, or one that does not cover this tool) means the host's own card.
  publishBridge(NATIVE, asked);
  assert.deepEqual(forwardedText(call.render(60)), ['host read call'], 'native: the chain draws the row');
  assert.deepEqual(asked, ['read'], 'the question names the tool being painted');

  // The same component is asked again on the next frame: a mid-session switch reaches a
  // card already on screen.
  genActivity();
  assert.match(unpaint(call.render(60)[0]), /▤ skill/u, 'activity: the card repaints itself');
  assert.deepEqual(asked, ['read', 'read'], 'one question per paint, never cached');

  function genActivity() {
    globalThis[BRIDGE_API_SLOT] = publishedBridge(ACTIVITY, asked);
  }
});

test('every answer that is not this package\'s activity design is the host\'s own card', () => {
  const resolver = fileResolver();
  const cases = [
    ['native', NATIVE],
    ['missing', { kind: 'missing', id: 'gone.design' }],
    ['not-covered', { kind: 'not-covered', id: 'other.design' }],
    ['another design', { kind: 'design', design: { id: 'someone-else.bash-design' } }],
  ];
  for (const [label, answer] of cases) {
    publishBridge(answer);
    assert.deepEqual(
      forwardedText(resolver('read', () => HOST).renderCall({ path: ODD }, plainTheme, { isPartial: false }).render(60)),
      ['host read call'],
      label,
    );
    assert.deepEqual(
      forwardedText(resolver('read', () => HOST).renderResult(textResult('# x'), { isPartial: false }, plainTheme, { args: { path: ODD } }).render(60)),
      ['host read result'],
      `${label} (result)`,
    );
  }
});

test('the question is asked per painted tool: one tool can be carded while another is not', () => {
  const resolver = fileResolver();
  const asked = [];
  publishBridge((tool) => (tool === 'read' ? ACTIVITY : NATIVE), asked);
  assert.match(
    unpaint(resolver('read', () => HOST).renderCall({ path: SKILL }, plainTheme, { isPartial: false }).render(60)[0]),
    /▤ skill/u,
    'read is covered by the activity design',
  );
  assert.deepEqual(
    forwardedText(resolver('write', () => HOST).renderCall({ path: ODD, content: '# x' }, plainTheme, { isPartial: false }).render(60)),
    ['host read call'],
    'write is not: the host draws that row',
  );
  assert.deepEqual(asked, ['read', 'write'], 'each paint asked about the tool it draws');
});

test('no bridge and a bridge older than the reader both paint the card, never hide it', () => {
  // The resolver-absence case this feature pins: a host whose published object has no
  // `resolveToolDesignSelection` (gentle-shell-bridge before 0.7.0), and no bridge at
  // all. Neither may hide the card, because neither can answer the question.
  const resolver = fileResolver();
  delete globalThis[BRIDGE_API_SLOT];
  assert.match(
    unpaint(resolver('read', () => HOST).renderCall({ path: SKILL }, plainTheme, { isPartial: false }).render(60)[0]),
    /▤ skill/u,
    'no bridge: the card paints, exactly as before the switch was joined',
  );

  globalThis[BRIDGE_API_SLOT] = { schema: 'gentle-shell-bridge/api', version: 1, VERSION: '0.6.0', registerToolDesign: () => () => {} };
  assert.match(
    unpaint(resolver('read', () => HOST).renderCall({ path: ODD }, plainTheme, { isPartial: false }).render(60)[0]),
    /📑 odd/u,
    'an older bridge: the card still paints',
  );
  assert.match(
    unpaint(resolver('read', () => HOST).renderResult(textResult('# Design'), { isPartial: false }, plainTheme, { args: { path: ODD } }).render(60)[0]),
    /^│ /u,
    'and so does its body',
  );
});

test('a foreign, hostile or unreadable bridge never hides the card', () => {
  const resolver = fileResolver();
  const draw = () => unpaint(resolver('read', () => HOST).renderCall({ path: ODD }, plainTheme, { isPartial: false }).render(60)[0]);

  // Another library on the same slot: its gate fails, and this package still paints.
  globalThis[BRIDGE_API_SLOT] = { schema: 'someone-else/api', version: 1, resolveToolDesignSelection: () => NATIVE };
  assert.match(draw(), /📑 odd/u, 'a foreign object on the slot is no bridge');

  // A reader that throws breaks the bridge's own contract; the card stays visible.
  globalThis[BRIDGE_API_SLOT] = { ...publishedBridge(NATIVE), resolveToolDesignSelection: () => { throw new Error('boom'); } };
  assert.match(draw(), /📑 odd/u, 'a reader that throws never hides a row');

  // An answer in a shape this build does not know is unreadable, not a refusal.
  globalThis[BRIDGE_API_SLOT] = publishedBridge({ kind: 'future-kind' });
  assert.match(draw(), /📑 odd/u, 'an unknown kind keeps the card');
});

test('S1: a write is covered by the Card activity line, so its file card paints and `default` restores the host row', () => {
  // A bridge answers from the design's own `tools` list, exactly as it resolves
  // coverage: a tool the line does not name is `not-covered`, which is the host's own
  // card. `write` is declared on that line so the file card can be asked about it.
  const design = toolsActivityDesign();
  const asked = [];
  publishBridge((tool) => (design.tools.includes(tool) ? { kind: 'design', design } : { kind: 'not-covered' }), asked);
  const resolver = fileResolver();
  for (const tool of ['read', 'write']) {
    assert.equal(design.tools.includes(tool), true, `${tool} is covered by the Card activity line`);
    const row = callRow(resolver, tool, { path: ODD, content: '# x\n' }, plainTheme);
    assert.match(unpaint(row), /📑 odd/u, `${tool}: the file card paints its heading`);
    assert.match(unpaint(row), new RegExp(`${tool} cards-skill-odd\\.md`, 'u'), `${tool}: and names the call`);
  }
  // S3: `edit` is on the line too, scoped to the paths this card claims, so an edit of an
  // ODD artifact wears the file card where no unscoped line could have covered it before.
  const edit = callRow(resolver, 'edit', { path: ODD, oldText: 'a', newText: 'b' }, plainTheme);
  assert.match(unpaint(edit), /📑 odd/u, 'an edit of an ODD artifact is this card\'s row now');
  assert.deepEqual(asked, ['read', 'write', 'edit'], 'each paint asked about the tool it draws');

  // `default` is the bridge's `native`: the host draws every row again.
  publishBridge(NATIVE);
  assert.deepEqual(
    forwardedText(resolver('write', () => HOST).renderCall({ path: ODD, content: '# x\n' }, plainTheme, { isPartial: false }).render(60)),
    ['host read call'],
    'default: no write file card',
  );
});

// ---- S3/S4/S8: the scoped claim, and the call's arguments that make it answer ----

/**
 * The bridge's own resolution (gentle-shell-bridge 0.9.0), reduced to what this design declares: a
 * tool no line names is `not-covered`; a scope that declines the call, and a call that arrives with
 * no arguments at all, are `native`; everything else is the design.
 */
function scopedBridge(design, asked) {
  return {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    VERSION: '0.9.0',
    registerToolDesign: () => () => {},
    resolveToolDesignSelection(tool, args) {
      if (asked !== undefined) asked.push([tool, args]);
      if (!design.tools.includes(tool)) return { kind: 'not-covered' };
      const scopes = design.scopes === null || typeof design.scopes !== 'object' ? {} : design.scopes;
      const scope = Object.hasOwn(scopes, tool) ? scopes[tool] : undefined;
      if (scope === undefined) return { kind: 'design', design };
      if (args === undefined) return { kind: 'native' };
      return scope.matches({ tool, args }) === true ? { kind: 'design', design } : { kind: 'native' };
    },
  };
}

function publishScoped(design, asked) {
  const api = scopedBridge(design, asked);
  globalThis[BRIDGE_API_SLOT] = api;
  return api;
}

test('S4: the gate asks the bridge with the call\'s own arguments', () => {
  const asked = [];
  publishScoped(toolsActivityDesign(), asked);
  const resolver = fileResolver();
  const callArgs = { path: SKILL, offset: 1, limit: 10 };
  assert.match(unpaint(callRow(resolver, 'read', callArgs, plainTheme)), /▤ skill/u, 'the read card paints');
  const resultArgs = { path: ODD, oldText: 'a', newText: 'b' };
  resolver('edit', () => HOST).renderResult(textResult('ok'), { isPartial: false }, plainTheme, { args: resultArgs }).render(60);
  assert.deepEqual(asked.map(([tool]) => tool), ['read', 'edit'], 'one question per painted tool');
  // A scope is only answerable with the call in hand, so the SAME object the host holds travels
  // with the question — the call's for the call half, the one the result half carries for its own.
  assert.equal(asked[0][1], callArgs, 'the call half passes the arguments, by reference');
  assert.equal(asked[1][1], resultArgs, 'the result half passes the ones it holds');
});

test('S3: a scoped claim paints a write and an edit of a skill or an ODD artifact, and only those', () => {
  publishScoped(toolsActivityDesign());
  const resolver = fileResolver();
  const cases = [
    [SKILL, { content: '# x\n' }, /▤ skill/u, /one\/SKILL\.md/u],
    [ODD, { oldText: 'a', newText: 'b' }, /📑 odd/u, /cards-skill-odd\.md/u],
    ['odd/work/plan.md', { content: '# x\n' }, /📑 odd/u, /plan\.md/u],
    ['a/skills/b/references/deep/x.md', { oldText: 'a', newText: 'b' }, /▤ skill/u, /b\/references\/deep\/x\.md/u],
  ];
  for (const [path, extra, identity, name] of cases) {
    for (const tool of ['write', 'edit']) {
      const row = callRow(resolver, tool, { path, ...extra }, plainTheme);
      const text = unpaint(row);
      assert.match(text, identity, `${tool} of ${path} wears its identity`);
      assert.match(text, name, `${tool} of ${path} names its file`);
      assert.ok(text.includes(tool), `${tool} of ${path} names the tool`);
    }
  }
  // A path the scope does not claim is no file card's row, so the chain keeps it.
  for (const path of ['src/app.ts', 'lib/skillset/notes.md', 'docs/oddity.md', 'notes/SKILL.md']) {
    for (const tool of ['write', 'edit']) {
      assert.deepEqual(
        forwardedText(resolver(tool, () => HOST).renderCall({ path }, plainTheme, { isPartial: false }).render(60)),
        ['host read call'],
        `${tool} of ${path}`,
      );
    }
  }
});

test('S8: read keeps the claim it had, so its card is the scoped line\'s own rows unchanged', () => {
  const draw = (design) => {
    publishScoped(design);
    const resolver = fileResolver();
    return {
      call: callRows(resolver, 'read', { path: SKILL, offset: 1, limit: 10 }, plainTheme),
      result: resultRows(resolver, 'read', { path: SKILL }, textResult('# Design'), { isPartial: false }, plainTheme, 60),
    };
  };
  const scoped = toolsActivityDesign();
  // The registration an older bridge takes, and the one this card has always been painted by.
  const legacy = toolsActivityDesign({ scopes: false });
  assert.equal(Object.hasOwn(scoped.scopes, 'read'), false, 'read is claimed for every call, never scoped');
  assert.deepEqual(draw(scoped), draw(legacy), 'the same call and result rows, byte for byte');
  assert.match(unpaint(draw(scoped).call[0]), /▤ skill/u, 'and the card still paints its heading');
});

// ---- the host's own outer box, reproduced for every row this card hands back ----

test('a forwarded read call draws the host box\'s own blank rows around its rows', () => {
  const resolver = fileResolver();
  const width = 40;
  const settled = boxTheme();
  const rows = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, settled, { isPartial: false }).render(width);
  assert.equal(rows.length, 2, 'the box opens with one blank row, then the call the host drew');
  assertBlankRow(rows[0], width);
  assert.deepEqual([...new Set(settled.roles)], ['toolSuccessBg'], 'a settled call is the settled background, blank row included');

  const text = unpaint(rows[1]);
  assert.equal(metrics.visibleWidth(text), width, 'the box pads the row to the width the host asked for');
  assert.equal(text.startsWith(' host read call'), true, `exactly one column of padding on the left: ${JSON.stringify(text)}`);
  assert.equal(text.endsWith('  '), true, 'the row is filled on the right, never cut');

  // `outputPad` is the host's own padding, and one column is only the default.
  const widePad = boxTheme();
  const padded = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, widePad, { isPartial: false, outputPad: 3 }).render(width);
  assert.match(unpaint(padded[1]), /^ {3}host read call/u, 'the host pad is the one the context states');
  assert.equal(metrics.visibleWidth(unpaint(padded[1])), width);
  assertBlankRow(padded[0], width);
});

test('an awaiting call carries the box\'s closing blank and loses it once the result arrives', () => {
  const resolver = fileResolver();
  const width = 30;
  const awaiting = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, boxTheme(), { isPartial: true }).render(width);
  assert.equal(awaiting.length, 3, 'blank, the call, blank: the host paints a complete box before the result');
  assertBlankRow(awaiting[0], width);
  assertBlankRow(awaiting[2], width);

  // The host re-renders the call when the result lands, and the result then owns the
  // closing blank.
  const settled = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, boxTheme(), { isPartial: false }).render(width);
  assert.equal(settled.length, 2, 'the call no longer closes the box');
  assertBlankRow(settled[0], width);
  const result = resolver('read', () => HOST).renderResult(textResult('code'), { isPartial: false }, boxTheme(), { args: { path: 'src/app.js' } }).render(width);
  assert.equal(result.length, 2, 'the result rows, then the box\'s closing blank');
  assertBlankRow(result.at(-1), width);
});

test('a forwarded result closes the box with the background its state names', () => {
  const resolver = fileResolver();
  const args = { path: 'src/app.js' };
  const width = 40;
  const settled = boxTheme();
  const settledRows = resolver('read', () => HOST).renderResult(textResult('code'), { isPartial: false }, settled, { args }).render(width);
  assert.deepEqual([...new Set(settled.roles)], ['toolSuccessBg'], 'a settled result is the success background');
  assert.equal(unbox(settledRows[0]), 'host read result', 'the chain\'s own row is kept');
  assertBlankRow(settledRows.at(-1), width);

  const failed = boxTheme();
  resolver('read', () => HOST).renderResult(textResult('boom', { isError: true }), { isPartial: false }, failed, { args }).render(width);
  assert.deepEqual([...new Set(failed.roles)], ['toolErrorBg'], 'a failed result is the error background');

  // `isError` stated in the render options is the same state as the result flag.
  const fromOptions = boxTheme();
  resolver('read', () => HOST).renderResult(textResult('boom'), { isPartial: false, isError: true }, fromOptions, { args }).render(width);
  assert.deepEqual([...new Set(fromOptions.roles)], ['toolErrorBg']);

  // A streamed result is the pending background, from the context's own flag.
  const partial = boxTheme();
  resolver('read', () => HOST).renderResult(textResult('code'), { isPartial: true }, partial, { args }).render(width);
  assert.deepEqual([...new Set(partial.roles)], ['toolPendingBg']);
});

test('a forwarded edit row is returned exactly as the chain drew it', () => {
  const resolver = fileResolver();
  const args = { path: 'src/app.js' };
  for (const partial of [true, false]) {
    const theme = boxTheme();
    const rows = resolver('edit', () => HOST_EDIT).renderCall(args, theme, { isPartial: partial }).render(40);
    // Pi's edit renderer declares `renderShell: 'self'`: the host draws NO box around
    // it, so this card adds none — no blank, no pad, no background.
    assert.deepEqual(rows, ['host edit call'], 'exactly the chain\'s rows');
    assert.equal(rows[0].startsWith(' '), false, 'no left pad');
    assert.equal(rows[0].includes(String.fromCharCode(27)), false, 'no background paint');
    assert.deepEqual(theme.roles, [], 'the box asks the theme for no background at all');
  }
  const resultTheme = boxTheme();
  const result = resolver('edit', () => HOST_EDIT).renderResult(textResult('Edited'), { isPartial: false }, resultTheme, { args }).render(40);
  assert.deepEqual(result, ['host edit result']);
  assert.deepEqual(resultTheme.roles, []);
});

test('a chain renderer that declares no shell is the default shell, like the host', () => {
  const resolver = fileResolver();
  const UNDECLARED = {
    renderCall: () => ({ render: () => ['host call'], invalidate() {} }),
    renderResult: () => ({ render: () => ['host result'], invalidate() {} }),
  };
  const DECLARED = {
    renderShell: 'default',
    renderCall: () => ({ render: () => ['host call'], invalidate() {} }),
    renderResult: () => ({ render: () => ['host result'], invalidate() {} }),
  };
  for (const inherited of [UNDECLARED, DECLARED]) {
    const rows = resolver('read', () => inherited).renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(24);
    assert.equal(rows.length, 2, 'the default shell opens with a blank row');
    assertBlankRow(rows[0], 24);
    assert.equal(rows[1].startsWith(' '), true, 'and pads the chain\'s row horizontally');
    assert.equal(unbox(rows[1]), 'host call');
  }
});

test('the forwarded text is byte-identical to the row the chain drew, and is never cut', () => {
  const resolver = fileResolver();
  const width = 40;
  const pad = 1;
  const hostCallRows = HOST.renderCall({ path: 'src/app.js' }, plainTheme, {}).render(width - pad * 2);
  const forwardedCall = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(width);
  assert.deepEqual(forwardedText(forwardedCall), hostCallRows.map(stripAnsi), 'the same text the chain drew, at the box\'s inner width');

  // A row wider than the box budget is kept, not clipped: the outer box loses its fill,
  // never a character.
  const long = 'x'.repeat(120);
  const LONG = { renderCall: () => ({ render: () => [long], invalidate() {} }) };
  const longRows = resolver('read', () => LONG).renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(20);
  assert.equal(unbox(boxedContent(longRows)[0]), long, 'a row too wide for the box keeps every column');

  // The result slot reproduces the same box: the host's own renderer is asked for the
  // inner width and its rows come back padded to the outer one.
  const hostResultRows = HOST.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(width - pad * 2);
  const forwardedResult = resolver('read', () => HOST)
    .renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } })
    .render(width);
  assert.deepEqual(forwardedText(forwardedResult), hostResultRows.map(stripAnsi));
});

test('a chain row that cannot be drawn adds nothing and never throws', () => {
  const resolver = fileResolver();
  const THROWING_COMPONENT = {
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
  // No row means no box either: the blank rows only accompany rows that were drawn.
  const slot = resolver('read', () => THROWING_COMPONENT);
  assert.deepEqual(slot.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(40), []);
  assert.doesNotThrow(() => slot.renderCall({ path: 'src/app.js' }, boxTheme(), { isPartial: true }).render(40));
  assert.deepEqual(slot.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(40), []);

  // The same for a renderer that frames itself.
  const selfSlot = resolver('read', () => ({ renderShell: 'self', renderCall: () => ({ render: () => { throw new Error('nope'); } }), renderResult: () => ({ render: () => { throw new Error('nope'); } }) }));
  assert.deepEqual(selfSlot.renderCall({ path: 'src/app.js' }, boxTheme(), { isPartial: false }).render(40), []);

  // No inherited slot at all is no box either, and no throw.
  const nothing = resolver('read', () => undefined);
  assert.deepEqual(nothing.renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: false }).render(40), []);
  assert.doesNotThrow(() => nothing.renderResult(textResult('code'), { isPartial: false }, plainTheme, { args: { path: 'src/app.js' } }).render(40));

  // A theme that cannot paint a background still draws the box's padding and blanks.
  const bare = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, plainTheme, { isPartial: true }).render(40);
  assertBlankRow(bare[0], 40);
  assert.match(unpaint(bare[1]), /^ host read call +$/u, 'a theme without bg keeps the box\'s padding');
});

test('a row the bridge\'s answer withholds is the same boxed row as a path with no identity', () => {
  const resolver = fileResolver();
  const plain = boxTheme();
  const withheld = boxTheme();
  const plainRows = resolver('read', () => HOST).renderCall({ path: 'src/app.js' }, plain, { isPartial: false }).render(40);
  publishBridge(NATIVE);
  const withheldRows = resolver('read', () => HOST).renderCall({ path: ODD }, withheld, { isPartial: false }).render(40);
  assert.deepEqual(withheldRows, plainRows, 'both are the host\'s own boxed row');
  assert.deepEqual(withheld.roles, plain.roles);
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

// ---- S3/S4/S5: the document body, drawn by Pi's own Markdown renderer ----

/**
 * A stand-in for Pi's `Markdown` component that behaves the way the real one does where
 * this card depends on it: it asks the theme TABLE it was handed for every element, and
 * every row it returns is already PAINTED. A heading goes through `heading`, a bullet
 * through `listBullet`, inline code through `code`, a fence through `codeBlockBorder` and
 * `codeBlock`, a quote through `quoteBorder` and `quote`, and a rule through `hr`.
 */
class OutlineMarkdown {
  constructor(source, paddingX, paddingY, theme) {
    this.source = source;
    this.theme = theme;
    this.padding = { paddingX, paddingY };
  }

  render() {
    const theme = this.theme;
    let fenced = false;
    return this.source.split('\n').map((line) => {
      if (line.startsWith('```')) {
        fenced = !fenced;
        return theme.codeBlockBorder(line);
      }
      if (fenced) return theme.codeBlock(line);
      if (line.startsWith('# ')) return theme.heading(line.slice(2));
      if (line.startsWith('- ')) return `${theme.listBullet('-')} ${line.slice(2)}`;
      if (line.startsWith('> ')) return `${theme.quoteBorder('>')} ${theme.quote(line.slice(2))}`;
      if (line === '---') return theme.hr('────');
      return line.replace(/`([^`]+)`/gu, (_match, code) => theme.code(code));
    });
  }

  invalidate() {}
}

// A document with every element S3 names, one per row.
const DOCUMENT = [
  '# Design',
  '- one',
  'Some `inline` code',
  '```',
  'const a = 1;',
  '```',
  '> quoted',
  '---',
].join('\n');

const documentResolver = () => fileResolver({ markdownClass: OutlineMarkdown });

test('the document is drawn by the host renderer, one theme role per element (S3)', () => {
  const resolver = documentResolver();
  const rows = resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { expanded: true, isPartial: false }, taggedTheme, 60);
  // The raw rows: `bodyText` strips the very tags these cases read.
  const body = rows.slice(0, -1).join('\n');

  assert.equal(body.includes('<mdHeading>Design</mdHeading>'), true, `a heading wears mdHeading: ${body}`);
  assert.equal(body.includes('<mdListBullet>-</mdListBullet>'), true, 'a bullet wears mdListBullet');
  assert.equal(body.includes('<mdCode>inline</mdCode>'), true, 'inline code wears mdCode');
  assert.equal(body.includes('<mdCodeBlockBorder>```</mdCodeBlockBorder>'), true, 'a fence wears mdCodeBlockBorder');
  assert.equal(body.includes('<mdCodeBlock>const a = 1;</mdCodeBlock>'), true, 'fenced content wears mdCodeBlock');
  assert.equal(body.includes('<mdQuoteBorder>></mdQuoteBorder>'), true, 'a quote border wears mdQuoteBorder');
  assert.equal(body.includes('<mdQuote>quoted</mdQuote>'), true, 'quoted text wears mdQuote');
  assert.equal(body.includes('<mdHr>'), true, 'a rule wears mdHr');
});

// A theme that paints real, zero-width ANSI and records the roles it was asked for: the
// fake metrics strips ANSI, so its widths are the host's own visible widths.
function ansiRoles() {
  const roles = [];
  return {
    roles,
    fg(role, value) {
      roles.push(role);
      return `\x1b[36m${value}\x1b[39m`;
    },
    bold: (value) => `\x1b[1m${value}\x1b[22m`,
  };
}

test('S5: the document\'s painted rows are placed, never painted again', () => {
  const resolver = documentResolver();
  const rows = resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { expanded: true, isPartial: false }, taggedTheme, 60);
  const body = rows.slice(0, -1).join('\n');
  // The body role is the one this card paints its own rows with; the document's rows keep
  // exactly the paint they arrived with, so none of them carries it.
  assert.equal(body.includes('<text>'), false, `the body role is never applied over the document: ${body}`);
  assert.equal(body.split('<mdHeading>Design</mdHeading>').length - 1, 1, 'each painted cell is placed once');

  // The same document with a theme that paints real, zero-width ANSI: the sequences survive,
  // and each row is still exactly the width the host asked for — proof that the placement
  // measured it with the ANSI-aware seam and not with a codepoint count.
  const ansiTheme = ansiRoles();
  const ansiRows = resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { expanded: true, isPartial: false }, ansiTheme, 60);
  assert.equal(ansiRows.slice(0, -1).join('\n').includes('\x1b[36m'), true, 'the document keeps the host paint');
  for (const row of ansiRows) assert.equal(metrics.visibleWidth(row), 60, `"${row}" is not 60 columns`);
});

test('S4: the collapsed preview is the first drawn rows of the same document, with its roles', () => {
  const resolver = documentResolver();
  const collapsed = resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { isPartial: false }, taggedTheme, 60);
  assert.equal(collapsed.length, PREVIEW_ROWS + 1, 'three preview rows and the closing rule');
  const preview = collapsed.slice(0, PREVIEW_ROWS).join('\n');
  assert.equal(preview.includes('<mdHeading>Design</mdHeading>'), true, `the first drawn row is the heading: ${preview}`);
  assert.equal(preview.includes('<mdListBullet>-</mdListBullet>'), true);
  assert.equal(preview.includes('<mdCode>inline</mdCode>'), true);
  assert.equal(preview.includes('<mdCodeBlock>const a = 1;</mdCodeBlock>'), false, 'the preview stops at its budget');
  // Not the raw source: no heading is typed out while the renderer can draw it.
  assert.doesNotMatch(unpaint(preview), /^# Design$/mu, 'a preview is not the file\'s own text');

  // `minimal` still suppresses the whole body, preview included.
  globalThis[CARD_CONTENT_SLOT] = 'minimal';
  try {
    const minimal = resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { isPartial: false }, taggedTheme, 60);
    assert.equal(minimal.length, 1, 'the closing rule alone');
    assert.match(unpaint(minimal[0]), /^╰/u);
  } finally {
    delete globalThis[CARD_CONTENT_SLOT];
  }

  // A write previews the document it wrote, exactly as a read previews the one it read.
  const written = resultRows(
    resolver,
    'write',
    { path: ODD, content: '# Task\n\n- one\n' },
    textResult('Wrote 20 bytes'),
    { isPartial: false },
    taggedTheme,
    60,
  );
  const writtenBody = written.slice(0, -1).join('\n');
  assert.equal(writtenBody.includes('<mdHeading>Task</mdHeading>'), true, writtenBody);
  assert.equal(written.slice(0, -1).length, PREVIEW_ROWS, 'the preview budget is the same');
});

test('a document the renderer cannot draw falls back to the plain source, unstyled', () => {
  const source = ['# Design', '', '## Specs', '', 'Body text'].join('\n');
  const drawsNothing = class { render() { return []; } invalidate() {} };
  const throws = class { render() { throw new Error('renderer exploded'); } invalidate() {} };
  const blanks = class { render() { return ['', '   ']; } invalidate() {} };
  const cases = [
    ['no renderer', null],
    ['a renderer that throws', throws],
    ['a renderer that draws nothing', drawsNothing],
    ['a renderer that draws only blanks', blanks],
  ];
  for (const [label, markdownClass] of cases) {
    const resolver = fileResolver({ markdownClass });
    const rows = resultRows(resolver, 'read', { path: ODD }, textResult(source), { expanded: true, isPartial: false }, taggedTheme, 60);
    const body = rows.slice(0, -1).join('\n');
    assert.equal(body.includes('# Design'), true, `${label}: the source is shown`);
    assert.equal(body.includes('## Specs'), true, `${label}: every line of it`);
    assert.equal(bodyPaint(rows.slice(0, -1).join('\n')).includes('<mdHeading>'), false, `${label}: in no Markdown role`);
  }
});

test('a write whose document cannot be drawn shows the document it wrote, never the result (S3)', () => {
  const source = ['# Design', '', '## Specs', '', 'Body text'].join('\n');
  const drawsNothing = class { render() { return []; } invalidate() {} };
  const throws = class { render() { throw new Error('renderer exploded'); } invalidate() {} };
  const cases = [
    ['no renderer', null],
    ['a renderer that throws', throws],
    ['a renderer that draws nothing', drawsNothing],
  ];
  for (const [label, markdownClass] of cases) {
    const resolver = fileResolver({ markdownClass });
    const args = { path: ODD, content: source };
    const result = textResult('Successfully wrote 42 bytes');
    for (const options of [{ isPartial: false }, { expanded: true, isPartial: false }]) {
      const written = resultRows(resolver, 'write', args, result, options, taggedTheme, 60);
      const body = written.slice(0, -1).join('\n');
      assert.equal(unpaint(body).includes('Successfully wrote'), false, `${label}: the result is never a write's body`);
      assert.equal(body.includes('# Design'), true, `${label}: the document is`);
      // Expanded, the whole document; collapsed, its first rows, exactly as a read's.
      assert.equal(body.includes('Body text'), options.expanded === true, `${label}: ${JSON.stringify(options)}`);
      assert.equal(bodyPaint(body).includes('<mdHeading>'), false, `${label}: and it is drawn as plain source`);
    }
    // A read keeps the text it read, exactly as before.
    const read = resultRows(resolver, 'read', { path: ODD }, textResult(source), { expanded: true, isPartial: false }, taggedTheme, 60);
    assert.equal(read.slice(0, -1).join('\n').includes('## Specs'), true, `${label}: a read keeps its result text`);
  }
});

test('the real host renderer draws the document with the theme roles (S3)', (t) => {
  let Markdown;
  try {
    ({ Markdown } = require('@earendil-works/pi-tui'));
  } catch {
    t.skip('requires @earendil-works/pi-tui');
    return;
  }
  const resolver = fileResolver({ markdownClass: Markdown });
  const source = ['# Design', '', '## Specs', '', 'Some **bold** text and `code`', '', '- one', ''].join('\n');
  const theme = ansiRoles();
  const rows = resultRows(resolver, 'read', { path: ODD }, textResult(source), { expanded: true, isPartial: false }, theme, 60);
  const body = rows.slice(0, -1).join('\n');
  assert.doesNotMatch(body, /## Specs/u, `a heading is drawn, not typed: ${JSON.stringify(rows.map(unpaint))}`);
  assert.equal(theme.roles.includes('mdHeading'), true, 'headings wear mdHeading');
  assert.equal(theme.roles.includes('mdListBullet'), true, 'bullets wear mdListBullet');
  assert.equal(theme.roles.includes('mdCode'), true, 'inline code wears mdCode');
  assert.match(body, /Design/u);
  assertFramed(rows, 60);
});

test('a failed call and a non-Markdown file keep their plain rows (S8)', () => {
  const resolver = documentResolver();
  const source = ['# Design', '', '## Specs'].join('\n');

  const failed = resultRows(resolver, 'read', { path: ODD }, textResult(source, { isError: true }), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.match(unpaint(failed[0]), /^│ # Design/u, 'a failure keeps its rows as they were reported');
  assert.equal(failed.slice(0, -1).join('\n').includes('<mdHeading>'), false, 'a failure is never a document');

  const json = resultRows(resolver, 'read', { path: 'odd/tasks/data.json' }, textResult('{"a":1}'), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.deepEqual(json.slice(0, -1).map(bodyText), ['{"a":1}'], 'a non-Markdown file is drawn as it is');
});

// ---- S1/S2/S3/S4/S5/S6: an edit states the fragment it leaves, drawn as a document ----

// The two shapes an `edit` call arrives in: the `edits` array the harness folds a legacy
// pair into (one entry per replacement), and the flat top-level pair itself.
const EDITS = [{ oldText: '# Old heading', newText: '# Handoff\n\nBody text' }, { oldText: 'x', newText: '```\nconst a = 1;\n```' }];
const FRAGMENT = ['# Handoff', '', 'Body text', '```', 'const a = 1;', '```'].join('\n');
// The host's own rows for that call: a hunk header, the removed lines and the added ones.
const EDIT_DIFF = ['@@ -2,3 +2,3 @@', '-# Old heading', '-removed line', '+# Handoff', '+Body text'].join('\n');
const editResult = () => textResult('Edited', { details: { diff: EDIT_DIFF } });

test('an edit of a Markdown skill or ODD artifact draws the fragment it leaves (S1)', () => {
  const resolver = documentResolver();
  const rows = resultRows(resolver, 'edit', { path: ODD, edits: EDITS }, editResult(), { expanded: true, isPartial: false }, taggedTheme, 60);
  const body = rows.slice(0, -1).join('\n');
  // The fragment is a document, drawn in the renderer's own roles.
  assert.equal(body.includes('<mdHeading>Handoff</mdHeading>'), true, `the fragment's heading is drawn as a heading: ${body}`);
  assert.equal(body.includes('<mdCodeBlock>const a = 1;</mdCodeBlock>'), true, 'so is its fenced block');
  // None of the host's diff rows are left: no hunk header, no gutter, no `+`/`-` marker,
  // and no line the edit removed.
  const text = unpaint(body);
  assert.equal(text.includes('@@'), false, 'no hunk header');
  assert.equal(text.includes('removed line'), false, 'a line the edit removed is never shown');
  assert.equal(text.includes('-# Old heading'), false, 'no removed marker');
  assert.equal(text.includes('+# Handoff'), false, 'no added marker');
  assert.doesNotMatch(text, /^\s*\d+ │/mu, 'no line-number gutter');
  // A host diff that carries a gutter row of its own reaches the body no more than the
  // rest of it does: no digit ever stands beside the diff's own bar.
  const gutted = resultRows(
    resolver,
    'edit',
    { path: ODD, edits: EDITS },
    textResult('Edited', { details: { diff: ['@@ -1,1 +1,1 @@', ' 12 │ -old line', ' 12 │ +new line'].join('\n') } }),
    { expanded: true, isPartial: false },
    taggedTheme,
    60,
  );
  assert.doesNotMatch(unpaint(gutted.slice(0, -1).join('\n')), /\d+\s*│|│\s*\d+/u, 'a gutter row is never drawn');
  // The same rows a read of the resulting text draws, exactly.
  const read = resultRows(resolver, 'read', { path: ODD }, textResult(FRAGMENT), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.deepEqual(rows, read, 'the fragment is drawn exactly as a read of it is');

  // The legacy flat shape is the same call, so it draws the same fragment.
  const flat = resultRows(
    resolver,
    'edit',
    { path: ODD, oldText: '# Old heading', newText: FRAGMENT },
    editResult(),
    { expanded: true, isPartial: false },
    taggedTheme,
    60,
  );
  assert.deepEqual(flat, rows, 'either call shape states the same fragment');

  // A skill's Markdown file is the same card: the claim is the identity, not the tool. The
  // rows must be the ones a read of that same fragment on that same skill path draws, so a
  // skill card that fell back to its raw source, or to the diff, cannot pass.
  const skillEdit = resultRows(resolver, 'edit', { path: SKILL, edits: EDITS }, editResult(), { expanded: true, isPartial: false }, taggedTheme, 60);
  const skillRead = resultRows(resolver, 'read', { path: SKILL }, textResult(FRAGMENT), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.deepEqual(skillEdit, skillRead, 'a skill edit draws exactly a read of its fragment');
  const skillBody = skillEdit.slice(0, -1).join('\n');
  const skillText = unpaint(skillBody);
  assert.equal(skillBody.includes('<mdHeading>Handoff</mdHeading>'), true, 'in the renderer\'s own roles');
  assert.equal(skillBody.includes('<mdCodeBlock>const a = 1;</mdCodeBlock>'), true, 'fenced block included');
  assert.equal(skillText.includes('@@'), false, 'and never the diff');
  assert.equal(skillText.includes('-# Old heading'), false, 'no removed marker');
  assert.equal(skillText.includes('+# Handoff'), false, 'no added marker');
  assert.doesNotMatch(skillText, /\d+\s*│|│\s*\d+/u, 'no line-number gutter');
});

// The array is the whole source when it is present: only an ABSENT or non-array `edits`
// falls back to the legacy pair, so a pair beside an empty array states nothing.
test('an `edits` array, even an empty one, is the whole source (S2)', () => {
  const resolver = documentResolver();
  const args = { path: ODD, edits: [], newText: '# Competing legacy text' };
  const rows = resultRows(resolver, 'edit', args, editResult(), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.deepEqual(rows.slice(0, -1).map(bodyText), EDIT_DIFF.split('\n'), 'the diff rows, not the legacy fragment beside the array');
  assert.equal(rows.slice(0, -1).join('\n').includes('Competing legacy text'), false, 'the pair is not drawn at all');
});

test('a pure deletion keeps the edit\'s rows, with no invented placeholder (S3)', () => {
  const resolver = documentResolver();
  // Longer than the preview budget, so the collapsed and the expanded case draw different
  // amounts of the same diff.
  const lines = ['@@ -1,4 +1,0 @@', '-# Design', '-Body text', '-More body', '-Last body'];
  const result = textResult('Edited', { details: { diff: lines.join('\n') } });
  for (const edits of [[{ oldText: '# Design\nBody text', newText: '' }], [{ oldText: 'a', newText: '   \n ' }]]) {
    const collapsed = resultRows(resolver, 'edit', { path: ODD, edits }, result, { isPartial: false }, taggedTheme, 60);
    assert.deepEqual(collapsed.slice(0, -1).map(bodyText), lines.slice(0, PREVIEW_ROWS), 'collapsed: the first rows of the diff, capped as any body is');
    const expanded = resultRows(resolver, 'edit', { path: ODD, edits }, result, { expanded: true, isPartial: false }, taggedTheme, 60);
    assert.deepEqual(expanded.slice(0, -1).map(bodyText), lines, 'expanded: the whole diff, row for row, never a document');
    assert.equal(bodyPaint(expanded.slice(0, -1).join('\n')).includes('<mdHeading>'), false, 'and none of it is drawn as Markdown');
  }
  // A result that carries no diff is its own text, exactly as before.
  const plain = resultRows(resolver, 'edit', { path: ODD, edits: [{ newText: '' }] }, textResult('Edited 2 lines'), { isPartial: false }, plainTheme, 60);
  assert.deepEqual(plain.slice(0, -1).map(bodyText), ['Edited 2 lines'], 'no wording is invented for the deleted fragment');
});

test('a failed edit keeps its error rows, and no other path becomes a document (S4)', () => {
  const resolver = documentResolver();
  const failed = resultRows(resolver, 'edit', { path: ODD, edits: EDITS }, textResult('ENOENT: no such file', { isError: true }), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.deepEqual(failed.slice(0, -1).map(bodyText), ['ENOENT: no such file'], 'exactly the error, with no body row of its own');
  const failedBody = failed.slice(0, -1).join('\n');
  assert.equal(failedBody.includes('<mdHeading>'), false, 'a failed edit is never a document');
  assert.match(failed[0], /^<error>│/u, 'and it wears the error role');

  // A non-Markdown ODD artifact keeps its diff.
  const json = resultRows(resolver, 'edit', { path: 'odd/tasks/data.json', edits: [{ newText: '## Handoff' }] }, editResult(), { isPartial: false }, plainTheme, 60);
  assert.deepEqual(json.slice(0, -1).map(bodyText), ['@@ -2,3 +2,3 @@', '-# Old heading', '-removed line'], 'a non-Markdown path keeps its diff rows');

  // A path with no skill or ODD identity is no row of this card at all: the chain keeps it.
  const forwarded = resolver('edit', () => HOST_EDIT)
    .renderResult(editResult(), { isPartial: false }, plainTheme, { args: { path: 'docs/notes.md', edits: EDITS } })
    .render(60);
  assert.deepEqual(forwarded, ['host edit result'], 'an ordinary Markdown file is the chain\'s row');
});

test('without a Markdown renderer the edit body is the same fragment, never the diff (S6)', () => {
  const drawsNothing = class { render() { return []; } invalidate() {} };
  const throws = class { render() { throw new Error('renderer exploded'); } invalidate() {} };
  const cases = [['no renderer', null], ['a renderer that throws', throws], ['a renderer that draws nothing', drawsNothing]];
  // The fragment's own lines are all such a host can draw: its first PREVIEW_ROWS collapsed,
  // every one of them expanded. Asserted exactly, so a dropped heading or fence row fails.
  const lines = FRAGMENT.split('\n');
  for (const [label, markdownClass] of cases) {
    const resolver = fileResolver({ markdownClass });
    const args = { path: ODD, edits: EDITS };
    for (const options of [{ isPartial: false }, { expanded: true, isPartial: false }]) {
      const rows = resultRows(resolver, 'edit', args, editResult(), options, taggedTheme, 60);
      const expected = options.expanded === true ? lines : lines.slice(0, PREVIEW_ROWS);
      assert.deepEqual(rows.slice(0, -1).map(bodyText), expected, `${label}: every fragment row it draws, in order`);
      assert.match(unpaint(rows.at(-1)), /^╰.*╯$/u, `${label}: and its own closing rule`);
      assert.equal(bodyPaint(rows.slice(0, -1).join('\n')).includes('<mdHeading>'), false, `${label}: as plain source, in no Markdown role`);
    }
  }
});

test('a collapsed edit previews the fragment exactly like a write of it (S5)', () => {
  const resolver = documentResolver();
  const args = { path: ODD, edits: [{ newText: DOCUMENT }] };
  const collapsed = resultRows(resolver, 'edit', args, editResult(), { isPartial: false }, taggedTheme, 60);
  const write = resultRows(resolver, 'write', { path: ODD, content: DOCUMENT }, textResult('Wrote 42 bytes'), { isPartial: false }, taggedTheme, 60);
  assert.equal(collapsed.length, PREVIEW_ROWS + 1, 'three preview rows and the closing rule');
  assert.deepEqual(collapsed.slice(0, PREVIEW_ROWS), write.slice(0, PREVIEW_ROWS), 'the same preview a write of the document draws');
  const preview = collapsed.slice(0, PREVIEW_ROWS).join('\n');
  assert.equal(preview.includes('<mdHeading>Design</mdHeading>'), true, `the preview starts at the fragment's top: ${preview}`);
  assert.equal(preview.includes('<mdCodeBlock>const a = 1;</mdCodeBlock>'), false, 'the preview stops at its budget');

  // Expanded, all of it: exactly the rows a write of the same document draws, so a row
  // dropped from the middle cannot pass, and every drawn row of the document is there.
  const expanded = resultRows(resolver, 'edit', args, editResult(), { expanded: true, isPartial: false }, taggedTheme, 60);
  const expandedWrite = resultRows(resolver, 'write', { path: ODD, content: DOCUMENT }, textResult('Wrote 42 bytes'), { expanded: true, isPartial: false }, taggedTheme, 60);
  assert.deepEqual(expanded, expandedWrite, 'expanding an edit is the whole document, row for row');
  assert.ok(expanded.length > PREVIEW_ROWS + 1, 'and it is more than the collapsed preview draws');
  assert.equal(unpaint(expanded.slice(0, -1).join('\n')).includes('@@'), false, 'and no diff row anywhere');

  // `minimal` draws the call alone: the heading above it is still the call's, and the
  // result is its closing rule with no body under it.
  globalThis[CARD_CONTENT_SLOT] = 'minimal';
  try {
    const call = callRows(resolver, 'edit', args, taggedTheme, 60);
    assert.equal(call.length, 1, 'the call is its one heading row at either level');
    assert.match(unpaint(call[0]), /📑 odd/u, 'and it still heads as the ODD artifact');
    assert.match(unpaint(call[0]), /edit/u, 'naming the tool');
    assert.match(unpaint(call[0]), /cards-skill-odd\.md/u, 'and the file');
    const minimal = resultRows(resolver, 'edit', args, editResult(), { isPartial: false }, taggedTheme, 60);
    assert.equal(minimal.length, 1, 'the closing rule alone');
    assert.match(unpaint(minimal[0]), /^╰.*╯$/u, 'with no body above it');
    assert.doesNotMatch(unpaint(minimal[0]), /Design|quoted|```/u, 'and nothing of the document on it');
    assertFramed(minimal, 60);
  } finally {
    delete globalThis[CARD_CONTENT_SLOT];
  }
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

// ---- paint last: no row of OURS is ever measured after it was painted ----

test('the plain body is measured and clipped as plain text, and painted only afterwards', () => {
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
  // No document renderer: every row below takes the plain path this card owns.
  const resolver = fileResolver({ metrics: spyMetrics, markdownClass: null });
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

test('the document\'s rows reach the seam PAINTED, and the ANSI-aware width is what measures them', () => {
  // S5: the one exception to "paint last", and the host's own: Pi's renderer hands back
  // painted rows, so they are measured as they are (with a visible width, never a codepoint
  // count) and no role of ours is applied over them.
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
  const resolver = fileResolver({ metrics: spyMetrics, markdownClass: OutlineMarkdown });
  const theme = ansiRoles();
  const rows = resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { expanded: true, isPartial: false }, theme, 44);
  assert.ok(seen.includes('\x1b[36mDesign\x1b[39m'), 'the document\'s own painted heading reached the seam, escape and all');
  assertFramed(rows, 44);
});

// ---- geometry ----

test('the card draws at every width the host may ask for', () => {
  const resolver = documentResolver();
  for (const width of [0, 1, 2, 3, 5, 9, 10, 12, 16, 61]) {
    for (const drawn of [
      callRows(resolver, 'read', { path: ODD }, plainTheme, width, { isPartial: true }),
      callRows(resolver, 'read', { path: ODD, offset: 2, limit: 4 }, plainTheme, width, { isPartial: false, expanded: true }),
      resultRows(resolver, 'read', { path: SKILL }, textResult('a\nb\nc\nd'), { isPartial: false }, plainTheme, width),
      resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { isPartial: false }, plainTheme, width),
      resultRows(resolver, 'read', { path: ODD }, textResult(DOCUMENT), { expanded: true, isPartial: false }, plainTheme, width),
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

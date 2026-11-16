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
  assert.ok(row.includes('<toolTitle>▤</toolTitle> <toolTitle>skill</toolTitle>'), 'the glyph and the label keep the read card\'s own title role');
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

  // The glyph AND the label wear the identity's own role (`toolTitle` for a skill); the
  // label is the only one bolded, and the glyph is never bold.
  assert.equal(row.includes('<toolTitle>▤</toolTitle>'), true, `the glyph wears the title role: ${row}`);
  assert.equal(row.includes('<toolTitle>skill</toolTitle>'), true, 'the label wears the title role');
  // The `·` separator in `muted`, the tool name unpainted, the path in `accent`, the range
  // in `warning` — in that order, on one row.
  assert.equal(row.includes('<muted>·</muted> read <accent>lib/skills/one/SKILL.md</accent><warning>:2-4</warning>'), true, row);
  assert.equal(row.includes('<accent>lib/skills/one/SKILL.md</accent>'), true, 'the path is the accent role');
  assert.equal(row.includes('read '), true, 'the tool name is unpainted: no role wraps it');
  assert.doesNotMatch(row, /<[a-z]+>read<\/[a-z]+>/u, 'never a role around the tool name');

  // A theme with a bold attribute: the label carries it, inside the role.
  const boldTheme = { fg: (role, value) => `<${role}>${value}</${role}>`, bold: (value) => `*${value}*` };
  const bolded = callRow(resolver, 'read', { path: SKILL }, boldTheme);
  assert.equal(bolded.includes('<toolTitle>*skill*</toolTitle>'), true, `the label is bold: ${bolded}`);
  assert.equal(bolded.includes('<toolTitle>*▤*</toolTitle>'), false, 'the glyph is not bold');

  // An ODD artifact heads in the theme's own `mdHeading`, and while collapsed it names its
  // file, in the accent role like every path.
  const odd = callRow(resolver, 'read', { path: ODD, offset: 10, limit: 30 }, taggedTheme);
  assert.equal(odd.includes('<mdHeading>📑</mdHeading>'), true, odd);
  assert.equal(odd.includes('<mdHeading>odd</mdHeading>'), true, odd);
  assert.equal(odd.includes('read <accent>cards-skill-odd.md</accent><warning>:10-39</warning>'), true, odd);
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
  for (const path of ['lib/skillset/notes.md', 'docs/oddity.md', 'odd/work/a.md', 'notes/SKILL.md', '', undefined, 42]) {
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
    assert.equal(body.includes('<mdHeading>'), false, `${label}: in no Markdown role`);
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

'use strict';
// The two advisory message cards: `gentle-pi.exploration-budget` and
// `gentle-pi.verifier-settle-reminder` are sent by Gentle Shell with no renderer registered
// for either, so Pi draws its default box and no card style ever reaches them. This package
// paints them on its own card substrate (`lib/shell-card.js`) through gentle-shell-bridge's
// message-design surface, in whichever style the host has chosen and always in full.
//
// Both designs FOLLOW the `Card tags` line this package's tool design is selected on, so the
// human picks `activity` once and these paint with it — live, per pass, with no switch of their
// own. Every case below goes through the public surface: `registerMessageCards` (the wire), the
// designs it registers, and the rows `apply` answers for a width. The text seam and the themes
// are the fakes `tools/jobs-card.test.js` uses; the bridge is the published object a
// process-wide slot holds.
const assert = require('node:assert/strict');
const { after, afterEach, beforeEach, test } = require('node:test');

const { MESSAGE_TYPES, bridgeTakesFollows, registerMessageCards } = require('../lib/message-card.js');
const { BASH_DESIGN_ID, TOOLS_LINE, toolsActivityDesign } = require('../lib/bash-design.js');
const { CARD_CONTENT, CARD_CONTENT_SLOT } = require('../lib/card-content.js');
const { CARD_STYLE, CARD_STYLE_SLOT } = require('../lib/card-style.js');

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const chars = (value) => [...stripAnsi(value)];

const metrics = {
  visibleWidth: (value) => chars(value).length,
  truncateToWidth(value, width, ellipsis = '') {
    if (width <= 0) return '';
    if (this.visibleWidth(value) <= width) return value;
    const tail = ellipsis ?? '';
    return chars(value).slice(0, Math.max(0, width - [...tail].length)).join('') + tail;
  },
  wrapTextWithAnsi(value, width) {
    const text = stripAnsi(value);
    if (width <= 0) return [text];
    return text.split('\n').flatMap((line) => {
      const lines = [];
      let current = '';
      for (const word of line.split(' ')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if ([...candidate].length <= width) { current = candidate; continue; }
        if (current !== '') { lines.push(current); current = ''; }
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
const taggedTheme = { fg: (role, value) => `<${role}>${value}</${role}>` };
const bandTheme = { fg: (_role, value) => value, bg: (_role, value) => `\x1b[48;5;240m${value}\x1b[49m` };
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');

const BRIDGE_API_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const EXPLORATION = 'gentle-pi.exploration-budget';
const VERIFIER = 'gentle-pi.verifier-settle-reminder';
const ACTIVITY = 'odd-worktree.bash-activity';
const OTHER_DESIGN = 'acme.tools';

beforeEach(() => {
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  delete globalThis[CARD_CONTENT_SLOT];
  delete globalThis[BRIDGE_API_SLOT];
});
afterEach(() => { delete globalThis[BRIDGE_API_SLOT]; });
after(() => {
  delete globalThis[CARD_STYLE_SLOT];
  delete globalThis[CARD_CONTENT_SLOT];
  delete globalThis[BRIDGE_API_SLOT];
});

/** A follow the bridge validates: `{ line, id }`, both non-empty, never the reserved `native`. */
const validFollow = (follow) => follow !== null
  && typeof follow === 'object'
  && typeof follow.line === 'string' && follow.line.trim() !== ''
  && typeof follow.id === 'string' && follow.id.trim() !== ''
  && follow.id.trim() !== 'native';

/**
 * The published bridge object (gentle-shell-bridge@0.12.0's shape, and the older one it replaced).
 * `validatesFollows` is the 0.12.0 discipline — a registration whose `follows` is malformed is
 * refused whole; without it, the object is a pre-0.12.0 bridge that ignores the unknown field.
 * `toolLine` is the `Card tags` line's live value: `undefined` means the line does not exist.
 */
function publishBridge(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const state = {
    designs: [],
    calls: [],
    disposed: 0,
    applies: 0,
    resolutions: 0,
    toolLine: settings.toolLine,
    version: settings.version,
  };
  const api = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerToolDesign: () => () => {},
    resolveToolDesignSelection: () => ({ kind: 'native' }),
    registerMessageDesign(registrations) {
      const list = Array.isArray(registrations) ? registrations : [registrations];
      state.calls.push(list);
      if (settings.validatesFollows === true) {
        for (const design of list) {
          if (design.follows !== undefined && !validFollow(design.follows)) throw new Error('gentle-shell-bridge: invalid message design: follows must be `{ line, id }`');
        }
      }
      const disposers = list.map((design) => {
        state.designs.push(design);
        return () => {
          state.disposed += 1;
          state.designs = state.designs.filter((kept) => kept !== design);
        };
      });
      return () => { for (const dispose of disposers) dispose(); };
    },
  };
  if (settings.version !== undefined) api.VERSION = settings.version;
  globalThis[BRIDGE_API_SLOT] = api;
  return state;
}

/** The module's own report, plus the bridge it registered on. */
function registered(options = {}) {
  const bridge = publishBridge({ version: '0.12.1', toolLine: ACTIVITY, validatesFollows: true, ...options });
  const outcome = registerMessageCards({ metrics, theme: plainTheme });
  return { ...outcome, bridge };
}

const designFor = (outcome, customType) => outcome.designs.find((design) => design.customType === customType);

/**
 * The bridge's own follow rule (`docs/contract.md` §15, "Following a tool design's switch"): a
 * design is selected exactly while the tool line it follows answers its id, resolved LIVE, and
 * with no design selected the message keeps the host's own output, byte for byte.
 */
function selectedDesign(state, customType) {
  state.resolutions += 1;
  const design = state.designs.find((candidate) => candidate.customType === customType);
  if (design === undefined || design.follows === undefined) return undefined;
  if (state.toolLine === undefined) return undefined;
  return state.toolLine === design.follows.id ? design : undefined;
}

/** One pass of the message's component, exactly as the bridge runs it. */
function renderMessage(state, customType, lines, width = 70) {
  const design = selectedDesign(state, customType);
  if (design === undefined) return lines;
  state.applies += 1;
  return design.apply([...lines], { width, customType, theme: plainTheme, render: { expanded: false, outputPad: 1, message: {} } });
}

/** The plain body the bridge hands a design for a host-less type: `[customType]`, a blank row, the text. */
const plainBody = (customType, text) => [`[${customType}]`, '', ...text.split('\n')];

/** The rows one design paints for a message, through the context Pi hands a message renderer. */
function cards(outcome, customType, text, context = {}, width = 70) {
  const design = designFor(outcome, customType);
  assert.notEqual(design, undefined, `${customType} is registered`);
  return design.apply(plainBody(customType, text), { width, customType, theme: plainTheme, render: { expanded: false, outputPad: 1, message: {} }, ...context });
}

function assertFramed(rows, width) {
  for (const row of rows) assert.equal(metrics.visibleWidth(unpaint(row)), width, `"${unpaint(row)}" is not ${width} wide`);
}

/** The body text of a neon card: each drawn row stripped of the frame, joined and squeezed. */
const bodyText = (rows) => rows
  .map(unpaint)
  .filter((row) => row.startsWith('│'))
  .map((row) => row.replace(/^│ ?/u, '').replace(/ *│$/u, ''))
  .join(' ')
  .replace(/\s+/gu, ' ');

/** The exact top rule of a neon card: the frame, the heading and the fill that closes it. */
function headOf(heading, width) {
  return `╭─ ${heading} ${'─'.repeat(width - metrics.visibleWidth(heading) - 5)}╮`;
}

const STARTED = [
  'Exploration budget: 1,234 tracked lookups and 56,789 UTF-8 text bytes (an approximate evidence budget).',
  'Ongoing discovery needs one configured explorer, even if read-only or initially small.',
  'This is runtime context for the original task, not a new user request.',
].join('\n');
const VERIFIER_TEXT = 'Verification reminder: your final message declares `Risk: item 3`, but no independent verifier was launched for this prompt. Now launch `gentle-ai-verify` with the `Risk: item 3` line in its `task`.';
const EXPLORATION_HEADING = '⌕ Exploration budget · 1,234 tracked lookups · 56,789 text bytes';
const VERIFIER_HEADING = '⚑ Verifier reminder · Risk: item 3';

// ---- the wire, and the one switch ----

test('both alerts register on the message-design surface, one design per custom type', () => {
  const outcome = registered();
  assert.equal(outcome.registered, true);
  assert.equal(outcome.bridge.calls.length, 1, 'one all-or-nothing registration');
  assert.equal(outcome.bridge.designs.length, 2);
  assert.deepEqual(outcome.bridge.designs.map((design) => design.customType), [EXPLORATION, VERIFIER]);
  for (const design of outcome.bridge.designs) {
    assert.equal(design.line, undefined, 'an ungrouped design, not a line');
    assert.equal(design.types, undefined);
    assert.equal(typeof design.id, 'string');
    assert.ok(design.id.length > 0);
    assert.equal(typeof design.label, 'string');
    assert.ok(design.label.length > 0);
    assert.ok(design.label !== 'default' && design.label !== 'native', 'a reserved label is refused by the bridge');
    assert.equal(typeof design.apply, 'function');
  }
  assert.equal(new Set(outcome.bridge.designs.map((design) => design.id)).size, 2, 'one id per design');
  assert.deepEqual([...MESSAGE_TYPES], [EXPLORATION, VERIFIER]);
});

test('each design FOLLOWS the line and the design id this package already registers its tool design on', () => {
  const outcome = registered();
  const toolDesign = toolsActivityDesign({ scopes: false });
  for (const design of outcome.bridge.designs) {
    assert.deepEqual(design.follows, { line: TOOLS_LINE, id: BASH_DESIGN_ID }, design.customType);
    assert.equal(design.follows.line, toolDesign.line, 'the follow names the line the bash design registers on');
    assert.equal(design.follows.id, toolDesign.id, 'and the id that line answers with');
  }
  // A card that follows contributes no value of its own: the menu gains no `Message …` row.
  assert.deepEqual(outcome.bridge.designs.map((design) => design.follows.id), [ACTIVITY, ACTIVITY]);
  assert.notEqual(outcome.bridge.designs[0].follows, outcome.bridge.designs[1].follows, 'one follow object per design');
});

test('while Card tags answers activity the message is the card', () => {
  const wire = registered({ toolLine: ACTIVITY });
  const rows = renderMessage(wire.bridge, EXPLORATION, plainBody(EXPLORATION, STARTED));
  assert.equal(unpaint(rows[0]), headOf(EXPLORATION_HEADING, 70));
  assert.equal(wire.bridge.applies, 1);
});

test('the line answering native, another design or nothing hands the message back byte-identical', () => {
  for (const [name, toolLine] of [
    ['the host\'s own value', 'native'],
    ['another plugin\'s design', OTHER_DESIGN],
    ['a value naming a design that is gone', 'odd-worktree.bash-activity-gone'],
    ['a line that does not exist', undefined],
  ]) {
    const wire = registered({ toolLine });
    assert.equal(wire.registered, true, `${name}: the designs are registered whatever the line says`);
    assert.equal(wire.bridge.designs.length, 2);
    for (const [customType, text] of [[EXPLORATION, STARTED], [VERIFIER, VERIFIER_TEXT]]) {
      const input = plainBody(customType, text);
      const rows = renderMessage(wire.bridge, customType, input);
      assert.deepEqual(rows, input, `${name}: ${customType} keeps the host's rows, bytes included`);
      assert.equal(wire.bridge.applies, 0, `${name}: ${customType} never reaches the card`);
    }
  }
});

test('a live flip repaints the message and turns it off again, with no re-registration', () => {
  const wire = registered({ toolLine: 'native' });
  assert.equal(wire.registered, true, 'the bridge decides per pass, so the designs are always registered');
  const input = plainBody(EXPLORATION, STARTED);
  assert.deepEqual(renderMessage(wire.bridge, EXPLORATION, input), input, 'off');
  wire.bridge.toolLine = ACTIVITY;
  const on = renderMessage(wire.bridge, EXPLORATION, input);
  assert.equal(unpaint(on[0]), headOf(EXPLORATION_HEADING, 70), 'flipped on');
  assert.ok(on.length > 1 + STARTED.split('\n').length - 1, 'the body is there');
  wire.bridge.toolLine = 'native';
  assert.deepEqual(renderMessage(wire.bridge, EXPLORATION, input), input, 'flipped off again');
  wire.bridge.toolLine = ACTIVITY;
  assert.deepEqual(renderMessage(wire.bridge, EXPLORATION, input), on, 'and back on, unchanged');
  assert.equal(wire.bridge.calls.length, 1, 'one registration for all of it');
  assert.ok(wire.bridge.resolutions >= 4, 'the follow was read on every pass');
});

test('registration needs no store, so no seed is written for a switch that already exists', () => {
  // The fake publishes no `createStore`: a module that seeded anything would have to throw here.
  const outcome = registered();
  assert.equal(outcome.registered, true);
  assert.equal(globalThis[BRIDGE_API_SLOT].createStore, undefined);
});

// ---- the older bridge: never a switch of our own ----

test('a bridge that cannot express the follow gets NO registration, never a Message switch of its own', () => {
  for (const [name, version] of [
    ['the release before it', '0.11.0'],
    ['a much older one', '0.7.0'],
    ['the release that has follows but not the order', '0.12.0'],
    ['the cutoff with a prerelease suffix', '0.12.1-rc.1'],
    ['the cutoff with a build suffix', '0.12.1+build.7'],
  ]) {
    const bridge = publishBridge({ version, toolLine: ACTIVITY, validatesFollows: false });
    assert.deepEqual(registerMessageCards({ metrics, theme: plainTheme }), { registered: false, designs: [], dispose: undefined }, name);
    assert.equal(bridge.calls.length, 0, `${name}: nothing reached the bridge`);
  }
});

test('a release that cannot be read registers nothing at all: no probe, no api call, no store read', () => {
  for (const [name, version] of [['no release member', undefined], ['a release that cannot be read', 'v0.12'], ['the release before the floor', '0.12.0'], ['a prerelease of the floor', '0.12.1-rc.1'], ['a build suffix on the floor', '0.12.1+build.7'], ['a prerelease above the floor', '0.12.2-rc.1'], ['a build suffix above the floor', '0.12.2+build.7'], ['trailing text after the numbers', '0.12.2garbage'], ['four parts', '1.0.0.0'], ['empty', '']]) {
    for (const validatesFollows of [false, true]) {
      const bridge = publishBridge({ version, toolLine: ACTIVITY, validatesFollows });
      assert.deepEqual(registerMessageCards({ metrics, theme: plainTheme }), { registered: false, designs: [], dispose: undefined }, name);
      // The api is never asked: a probe cannot tell a refused follow from an unrelated refusal, and a
      // bridge that ignores the field would take the real designs as a `Message <type>` switch.
      assert.equal(bridge.calls.length, 0, `${name}: nothing reaches the bridge`);
      assert.deepEqual(bridge.designs, [], `${name}: nothing of ours can become a switch`);
    }
  }
});

test('a width too narrow for one body row hands the rows straight back', () => {
  const outcome = registered();
  for (const customType of MESSAGE_TYPES) {
    const design = designFor(outcome, customType);
    const lines = plainBody(customType, 'Exploration budget: 3 tracked lookups.');
    for (const width of [1, 4, 5]) {
      const context = { width, customType, theme: plainTheme, render: { expanded: false, outputPad: 1, message: {} } };
      assert.deepEqual(design.apply(lines, context), lines, `${customType} at width ${width}`);
    }
    const painted = design.apply(lines, { width: 40, customType, theme: plainTheme, render: { expanded: false, outputPad: 1, message: {} } });
    assert.notDeepEqual(painted, lines, `${customType}: a usable width still paints`);
  }
});

test('a later release registers, and a bridge with no message-design surface registers nothing', () => {
  for (const version of ['0.12.1', '0.12.2', '0.13.0', '1.0.0']) {
    assert.equal(registered({ version }).registered, true, version);
  }
  // The capability itself, asked of two bridges: the release string decides, and nothing is asked of
  // the bridge when it cannot be read as at least 0.12.1 (fail closed, never a probe).
  assert.equal(bridgeTakesFollows({ VERSION: '0.12.1' }), true);
  assert.equal(bridgeTakesFollows({ VERSION: '0.12.0' }), false, 'the follow exists there, but a stale message id could veto it');
  assert.equal(bridgeTakesFollows({ VERSION: '0.11.9' }), false);
  assert.equal(bridgeTakesFollows({ VERSION: '0.12.1-rc.1' }), false);
  assert.equal(bridgeTakesFollows({ VERSION: '0.12.2-rc.1' }), false, 'a suffix above the floor is unreadable, not newer');
  assert.equal(bridgeTakesFollows({ VERSION: '0.12.2garbage' }), false, 'trailing text is unreadable');
  assert.equal(bridgeTakesFollows({ VERSION: '1.0.0.0' }), false, 'four parts are unreadable');
  assert.equal(bridgeTakesFollows({ VERSION: '0.12' }), false, 'a two-part release below the floor is still below it');
  assert.equal(bridgeTakesFollows({}), false, 'an unreadable release is not asked and not used');
  const bare = publishBridge({ version: '0.12.1' });
  delete globalThis[BRIDGE_API_SLOT].registerMessageDesign;
  assert.deepEqual(registerMessageCards({ metrics, theme: plainTheme }), { registered: false, designs: [], dispose: undefined });
  assert.equal(bare.calls.length, 0);
  delete globalThis[BRIDGE_API_SLOT];
  assert.deepEqual(registerMessageCards({ metrics, theme: plainTheme }), { registered: false, designs: [], dispose: undefined }, 'no bridge');
});

test('a refused registration is a no-registration, never a throw', () => {
  const bridge = publishBridge({ version: '0.12.1', toolLine: ACTIVITY, validatesFollows: true });
  const api = globalThis[BRIDGE_API_SLOT];
  api.registerMessageDesign = () => { bridge.calls.push('refused'); throw new Error('refused'); };
  assert.deepEqual(registerMessageCards({ metrics, theme: plainTheme }), { registered: false, designs: [], dispose: undefined });
  assert.equal(bridge.calls.length, 1);
});

// ---- the heading (S5) ----

test('the exploration alert heads with its own mark, its name and the numbers the message states', () => {
  const rows = cards(registered(), EXPLORATION, STARTED);
  assert.equal(rows[0], headOf(EXPLORATION_HEADING, 70));
});

test('the verifier alert heads with its own mark, its name and the risk item the message states', () => {
  const rows = cards(registered(), VERIFIER, VERIFIER_TEXT);
  assert.equal(rows[0], headOf(VERIFIER_HEADING, 70));
});

test('a message that states no numbers is headed by its name alone, with no invented detail', () => {
  const outcome = registered();
  const bare = 'Exploration budget: this request used its lookups.';
  assert.equal(cards(outcome, EXPLORATION, bare)[0], headOf('⌕ Exploration budget', 70));
  assert.equal(cards(outcome, VERIFIER, 'Verification reminder: launch the verifier.')[0], headOf('⚑ Verifier reminder', 70));
});

test('the marks are this package\'s own: ⌕ for the budget, ⚑ for the reminder', () => {
  const outcome = registered();
  assert.match(unpaint(cards(outcome, EXPLORATION, STARTED)[0]), /^╭─ ⌕ Exploration budget/u);
  assert.match(unpaint(cards(outcome, VERIFIER, VERIFIER_TEXT)[0]), /^╭─ ⚑ Verifier reminder/u);
});

// ---- the body (S2) ----

test('every row of the message is drawn at every content level, and the bridge\'s own decorations are dropped', () => {
  const outcome = registered();
  for (const level of [CARD_CONTENT.DEFAULT, CARD_CONTENT.MINIMAL]) {
    globalThis[CARD_CONTENT_SLOT] = level;
    for (const [customType, text] of [[EXPLORATION, STARTED], [VERIFIER, VERIFIER_TEXT]]) {
      const rows = cards(outcome, customType, text, { content: level, keyHint: () => 'ctrl+o to expand' });
      const joined = rows.map(unpaint).join('\n');
      const body = bodyText(rows);
      assert.doesNotMatch(joined, new RegExp(`\\[${customType.replace(/\./gu, '\\.')}\\]`, 'u'), `${customType} at ${level}: no label row`);
      assert.match(body, /^Exploration budget: 1,234 tracked lookups|^Verification reminder: your final message/u, `${customType} at ${level}: the body starts straight away`);
      for (const line of text.split('\n')) {
        assert.ok(body.includes(line.replace(/\s+/gu, ' ')), `${customType} at ${level}: "${line}" is drawn`);
      }
      assert.doesNotMatch(joined, /to expand|to collapse|ctrl\+o/u, `${customType} at ${level}: no expand hint, even though the host offers one`);
    }
  }
  delete globalThis[CARD_CONTENT_SLOT];
});

test('a long message is never capped: a twelve-row body draws twelve rows at minimal', () => {
  const outcome = registered();
  globalThis[CARD_CONTENT_SLOT] = CARD_CONTENT.MINIMAL;
  const body = Array.from({ length: 12 }, (_unused, index) => `row ${index + 1} of the advisory message`);
  const rows = cards(outcome, VERIFIER, body.join('\n'), {}).map(unpaint);
  for (const line of body) assert.ok(rows.some((row) => row.includes(line)), `"${line}" is drawn`);
  assert.equal(rows.length, 1 + body.length + 1, 'the heading, every body row and the closing rule');
  delete globalThis[CARD_CONTENT_SLOT];
});

test('a body wider than the card is wrapped, never cut: the last words are still drawn', () => {
  const outcome = registered();
  const rows = cards(outcome, EXPLORATION, STARTED, {}, 40);
  const body = bodyText(rows);
  assert.ok(body.includes('initially small.'), 'the tail of the second row survives');
  assert.ok(body.includes('not a new user request.'), 'the tail of the third row survives');
  assertFramed(rows, 40);
});

test('expanding the host card changes nothing: there is nothing behind the card to reveal', () => {
  const outcome = registered();
  const collapsed = cards(outcome, EXPLORATION, STARTED);
  const expanded = cards(outcome, EXPLORATION, STARTED, { render: { expanded: true, outputPad: 1, message: {} } });
  assert.deepEqual(expanded, collapsed);
});

test('the rows the design is handed come back unchanged', () => {
  const input = plainBody(EXPLORATION, STARTED);
  const copy = [...input];
  designFor(registered(), EXPLORATION).apply(input, { width: 70, customType: EXPLORATION, theme: plainTheme, render: { expanded: false, outputPad: 1, message: {} } });
  assert.deepEqual(input, copy);
});

// ---- the style (S3) ----

test('the style is read from the host on every paint, never from the context', () => {
  const outcome = registered();
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  const float = cards(outcome, EXPLORATION, STARTED, { cardStyle: { kind: 'native' }, theme: bandTheme }).map(unpaint);
  assert.match(float[0], /^\s*▎/u, 'the host says float, so the rail is drawn');
  assert.doesNotMatch(float.join('\n'), /[╭╮╰╯]/u);
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  const neon = cards(outcome, EXPLORATION, STARTED, { cardStyle: { kind: 'native' }, theme: bandTheme }).map(unpaint);
  assert.match(neon[0], /^╭/u, 'the same design, flipped back, repaints the frame');
  assert.doesNotMatch(neon.join('\n'), /▎/u);
});

test('a mid-session flip repaints a card already on screen, in both directions', () => {
  const outcome = registered();
  const seen = [CARD_STYLE.NEON, CARD_STYLE.FLOAT, CARD_STYLE.NEON].map((style) => {
    globalThis[CARD_STYLE_SLOT] = style;
    return cards(outcome, VERIFIER, VERIFIER_TEXT, { theme: bandTheme }).map(unpaint)[0];
  });
  assert.match(seen[0], /^╭/u);
  assert.match(seen[1], /^\s*▎/u);
  assert.match(seen[2], /^╭/u);
});

// ---- the palette (S5) ----

test('each card wears its own tone: info for the budget, warning for the reminder', () => {
  const outcome = registered();
  const budget = designFor(outcome, EXPLORATION).apply(plainBody(EXPLORATION, STARTED), { width: 70, customType: EXPLORATION, theme: taggedTheme, render: { expanded: false, outputPad: 1, message: {} } });
  // Both cards name ONE theme role for the frame and the name, so an informational card is never the
  // theme's plain border with no colour of its own: `accent` for the budget.
  assert.ok(budget[0].includes('<accent>⌕</accent>'), budget[0]);
  assert.ok(budget[0].includes('<accent>╭'), 'the frame wears the identity role, not the plain border');
  assert.ok(budget[0].includes('<muted>'), 'the detail stays the muted subtitle');
  const reminder = designFor(outcome, VERIFIER).apply(plainBody(VERIFIER, VERIFIER_TEXT), { width: 70, customType: VERIFIER, theme: taggedTheme, render: { expanded: false, outputPad: 1, message: {} } });
  // WARNING owns the box: frame and name both carry the warning role.
  assert.ok(reminder[0].includes('<warning>⚑</warning>'), reminder[0]);
  assert.ok(reminder[0].includes('<warning>╭'), 'the frame carries the tone');
});

test('every row fits the width the host asked for, at narrow and wide terminals, in both styles', () => {
  const outcome = registered();
  for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
    globalThis[CARD_STYLE_SLOT] = style;
    for (const width of [24, 40, 70, 120]) {
      for (const [customType, text] of [[EXPLORATION, STARTED], [VERIFIER, VERIFIER_TEXT]]) {
        const design = designFor(outcome, customType);
        const rows = design.apply(plainBody(customType, text), { width, customType, theme: bandTheme, render: { expanded: false, outputPad: 1, message: {} } });
        assertFramed(rows, width);
        assert.ok(rows.length > 2, `${customType} at ${width}/${style} draws a body`);
        for (const row of rows) assert.equal(typeof row, 'string');
      }
    }
  }
});

// ---- the fallbacks (S4) ----

const PI_BOX = Object.freeze(['╭ Pi\'s own box ╮', '│ the body │', '╰──────────╯']);

test('a design that cannot measure hands the message back to Pi, because only the bridge knows its box', () => {
  const outcome = registered();
  assert.notEqual(designFor(outcome, EXPLORATION), undefined);
  // The bridge's own rule (docs/contract.md §15): a throwing design loses only its own output.
  const drawThrough = (design) => {
    try {
      return design.apply(plainBody(EXPLORATION, STARTED), { width: 70, customType: EXPLORATION, theme: plainTheme, render: { message: {} } });
    } catch {
      return PI_BOX;
    }
  };
  // Registered WITHOUT a measurement seam: the card cannot measure, so it throws instead of
  // answering rows wider than the terminal, and the bridge draws Pi's box.
  const noSeam = registerMessageCards({ theme: plainTheme });
  assert.equal(noSeam.registered, true, 'a host without a seam still registers the design');
  assert.equal(drawThrough(designFor(noSeam, EXPLORATION)), PI_BOX, 'no metrics seam');
  // A seam that is asked per paint and answers nothing usable is the same no.
  const lateSeam = registerMessageCards({ metrics: () => undefined, theme: plainTheme });
  assert.equal(drawThrough(designFor(lateSeam, EXPLORATION)), PI_BOX, 'a seam that answers nothing');
  // The seam arriving later draws the card, with no re-registration.
  let seam;
  const arriving = registerMessageCards({ metrics: () => seam, theme: plainTheme });
  assert.equal(drawThrough(designFor(arriving, EXPLORATION)), PI_BOX, 'still nothing to measure');
  seam = metrics;
  assert.match(drawThrough(designFor(arriving, EXPLORATION))[0], /^╭─ ⌕ Exploration budget/u, 'the seam is read on every paint');
});

test('a hostile message or context is never turned into rows that break the frame', () => {
  const outcome = registered();
  const design = designFor(outcome, EXPLORATION);
  const context = { width: 70, customType: EXPLORATION, theme: plainTheme, render: { message: {} } };
  // Not an array, no rows at all, and members that are not rows: the card still draws, and every
  // row it answers is a string.
  for (const lines of ['garbage', undefined, [], [null, 42, {}, 'the message']]) {
    const rows = design.apply(lines, context);
    assert.ok(Array.isArray(rows));
    for (const row of rows) assert.equal(typeof row, 'string');
  }
  assert.ok(design.apply([null, 42, {}, 'the message'], context).some((row) => unpaint(row).includes('the message')));
  // A theme that throws repaints nothing rather than breaking the render loop.
  const throwing = { fg: () => { throw new Error('boom'); }, bg: () => { throw new Error('boom'); } };
  assert.throws(() => design.apply(plainBody(EXPLORATION, STARTED), { ...context, theme: throwing }));
});

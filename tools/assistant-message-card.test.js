'use strict';
// The assistant's FINAL answer, drawn as a card on this package's substrate: while this
// package's `Card message` switch is On (`lib/card-message.js`) and the component's own
// `hasToolCalls` is false, `AssistantMessageComponent.render` answers the card instead of Pi's
// plain block; a message with tool calls, the switch Off and every shell API it cannot read get
// the host's own rows back byte for byte. Its heading states the fixed `Gentleman`, the clock and
// the turn stats of the session history.
//
// Everything below observes the public seam: the shim is installed on a STUB class exactly as the
// extension installs it on Pi's, the shell API is the published object a process-wide slot holds,
// the style is the slot Gentle Shell writes, and the rows are read by calling `render` on the
// component — the same call the host makes on every frame.
const assert = require('node:assert/strict');
const { after, afterEach, beforeEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  IDENTITY,
  formatDuration,
  installAssistantMessageCard,
  paintAnswer,
  turnStats,
  uninstallAssistantMessageCard,
} = require('../lib/assistant-message-card.js');
const { installUserPromptCard, uninstallUserPromptCard } = require('../lib/user-prompt-card.js');
const { CARD_STYLE, CARD_STYLE_SLOT } = require('../lib/card-style.js');
// The extension itself, loaded the way `tools/fixtures/load-extension.js` loads it: the deferred
// install's guard lives there, so the test has to reach the module's own seam.
const fixture = require('./fixtures/load-extension.js');

const SHELL_API_SLOT = Symbol.for('odd-worktree/shell-api/v1');

// ---- the theme: one role per painted cell ----
//
// The card paints a theme ROLE, never a colour, so the stub turns each role into a distinct SGR
// code. A row can then be read back cell by cell (`cells`), which is how "the frame and the title
// wear `mdHeading`" is asserted without reading any internal state.
const ROLE_CODE = { mdHeading: '96', accent: '35', border: '34', text: '37', dim: '2', muted: '90', success: '32', warning: '33', error: '31' };
const BG_CODE = { toolSuccessBg: '48;5;240', toolPendingBg: '48;5;214', toolErrorBg: '48;5;203' };
const MARKDOWN_CODE = '36';

function roleTheme() {
  const roles = [];
  return {
    roles,
    fg(role, text) {
      roles.push(role);
      return `\x1b[${ROLE_CODE[role] ?? '39'}m${text}\x1b[39m`;
    },
    bg(role, text) {
      roles.push(`bg:${role}`);
      return `\x1b[${BG_CODE[role] ?? '49'}m${text}\x1b[49m`;
    },
  };
}

const plainTheme = { fg: (_role, value) => value };
// The float style paints its band through the theme's own `bg`; a theme without one keeps the
// neon outline (`lib/shell-card.js`), so the two style claims below need a band-capable theme.
const bandTheme = { fg: (_role, value) => value, bg: (_role, value) => `\x1b[48;5;240m${value}\x1b[49m` };
const taggedTheme = { fg: (role, value) => `<${role}>${value}</${role}>` };

// Pi's answer-zone markers, exactly as `AssistantMessageComponent.render` writes them: the start of
// the zone on the first row, its end and its final marker on the last. They are OSC sequences, not
// SGR paint, so they are zero width and every helper below strips them as such.
const OSC133_ZONE_START = '\x1b]133;A\x07';
const OSC133_ZONE_END = '\x1b]133;B\x07';
const OSC133_ZONE_FINAL = '\x1b]133;C\x07';
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_ZONE_FINAL;

const ANSI = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07]*\x07/g;
const stripAnsi = (value) => value.replace(ANSI, '').replace(OSC, '');
const chars = (value) => [...stripAnsi(value)];
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');
/** The rows the card actually draws: the blank separation row above the frame is not one of them. */
const framed = (rows) => rows.filter((row) => unpaint(row) !== '');

/** One row as `{ char, code }` cells: the SGR in force when each visible character was drawn. */
function cells(row) {
  const SGR = /\x1b\[([0-9;]*)m/y;
  const ZONE = /\x1b\][^\x07]*\x07/y;
  const out = [];
  let code = '0';
  let index = 0;
  while (index < row.length) {
    SGR.lastIndex = index;
    const match = SGR.exec(row);
    if (match !== null) {
      code = match[1];
      index = SGR.lastIndex;
      continue;
    }
    // An OSC sequence is a marker, not a cell: no column, no role.
    ZONE.lastIndex = index;
    if (ZONE.exec(row) !== null) {
      index = ZONE.lastIndex;
      continue;
    }
    out.push({ char: row[index], code });
    index += 1;
  }
  return out;
}

// ---- the measurement seam (the one `tools/user-prompt-card.test.js` uses, ANSI preserved) ----

function makeMetrics(counts) {
  const bump = (name) => {
    if (counts !== undefined) counts[name] += 1;
  };
  return {
    visibleWidth(value) {
      bump('visibleWidth');
      return chars(value).length;
    },
    truncateToWidth(value, width, ellipsis = '') {
      bump('truncateToWidth');
      if (width <= 0) return '';
      if (chars(value).length <= width) return value;
      const tail = ellipsis ?? '';
      const plain = [...stripAnsi(value)];
      return plain.slice(0, Math.max(0, width - [...tail].length)).join('') + tail;
    },
    wrapTextWithAnsi(value, width) {
      bump('wrapTextWithAnsi');
      if (width <= 0) return [value];
      if (chars(value).length <= width) return [value];
      const rows = [];
      let current = '';
      for (const word of stripAnsi(value).split(' ')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if ([...candidate].length <= width) {
          current = candidate;
          continue;
        }
        if (current !== '') rows.push(current);
        current = word;
      }
      rows.push(current);
      return rows;
    },
  };
}

const metrics = makeMetrics();

// ---- the stub host: Pi's `AssistantMessageComponent` and its content container ----

/**
 * Pi's `Spacer(1)`: the one blank row `updateContent` puts before the first visible block. The
 * card drops it from its body and keeps one blank row above its frame instead.
 */
class StubSpacer {
  constructor(size = 1) {
    this.size = size;
  }

  render() {
    return Array.from({ length: this.size }, () => '');
  }
}

/** One text block: its rows arrive ALREADY painted, exactly like Pi's Markdown output. */
class StubText {
  constructor(lines, code = MARKDOWN_CODE) {
    this.lines = lines;
    this.code = code;
  }

  render(width) {
    this.widths = [...(this.widths ?? []), width];
    // A renderer that refuses the document: the card must answer the host's own rows.
    if (this.lines === 'THROW') throw new Error('the renderer blew up');
    if (this.lines === 'NOT_ROWS') return 'not rows';
    if (this.lines === 'EMPTY_BODY') return [];
    // Rows the renderer already painted: the card must PLACE them, never repaint them.
    return String(this.lines).split('\n').map((line) => `\x1b[${this.code}m${line}\x1b[39m`);
  }
}

/**
 * Pi's `Container`: its children's rows, in order.
 */
class StubContainer {
  constructor(children) {
    this.children = children;
  }

  render(width) {
    // A render at one width that fails: the card's own body render, and only that one.
    if (this.throwAt === width) throw new Error('the content container blew up');
    return this.children.flatMap((child) => child.render(width));
  }
}

/**
 * Pi's answer, as this card sees it: a `Container` whose only child (`children[0]`) holds the
 * `Spacer` and the message's blocks, plus the fields `render` reads.
 *
 * `render(width)` is Pi's own (`assistant-message.js`): the container's rows, and — ONLY for a
 * message without tool calls — the answer zone's start prefixed on the first row and its end plus
 * final markers prefixed on the last.
 */
class AssistantMessageComponent {
  constructor(message, options = {}) {
    this.message = message;
    this.contentContainer = new StubContainer(options.children ?? [new StubSpacer(1), new StubText(messageText(message))]);
    this.children = [this.contentContainer];
    this.hasToolCalls = Array.isArray(message.content)
      && message.content.some((block) => block !== null && typeof block === 'object' && block.type === 'toolCall');
    this.isStreaming = false;
    this.lastMessage = message;
    this.messageId = options.messageId;
    this.timestamp = options.timestamp;
  }

  render(width) {
    const lines = this.contentContainer.render(width);
    if (this.hasToolCalls || lines.length === 0) return lines;
    const zoned = [...lines];
    zoned[0] = OSC133_ZONE_START + zoned[0];
    zoned[zoned.length - 1] = OSC133_ZONE_CLOSE + zoned[zoned.length - 1];
    return zoned;
  }
}

// Pi's own rows, called through the function the shim wraps: the byte-for-byte reference.
const NATIVE_RENDER = AssistantMessageComponent.prototype.render;
const nativeRows = (component, width) => NATIVE_RENDER.call(component, width);

const ANSWER = 'the answer is three lines\nalways wrapped at the inner width\nand never clipped';
const ANSWER_LINES = ANSWER.split('\n');

/** The message's own text, as Pi's Markdown child receives it. */
const messageText = (message) => (Array.isArray(message.content)
  ? message.content.filter((block) => block !== null && typeof block === 'object' && block.type === 'text').map((block) => block.text).join('\n')
  : '');

const finalMessage = (text = ANSWER) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
const toolMessage = () => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'working' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
  stopReason: 'toolUse',
});

function answerComponent(options = {}) {
  return new AssistantMessageComponent(options.message ?? finalMessage(), options);
}

// ---- the published shell API, and the slots the runtime reads ----

/**
 * The published shell API plus the store its readers use: `card-message` is the switch the card
 * asks (`lib/card-message.js`), one in-memory document map behind `createStore('odd-worktree')`,
 * merged per key exactly like the shell API's own store.
 */
function publishShellApi(options = {}) {
  const documents = new Map([['odd-worktree', { 'card-message': { schema: 1, on: options.cardMessage !== false } }]]);
  const state = { documents, repaints: 0 };
  globalThis[SHELL_API_SLOT] = {
    schema: 'odd-worktree/shell-api',
    version: 1,
    registerSection: () => () => {},
    registerRows: () => () => {},
    registerToolDesign: () => () => {},
    resolveKeymap: () => ({ unavailable: 'the test shell API publishes no key' }),
    createStore: (id) => ({
      get: (key, fallback) => {
        const document = documents.get(id);
        return document !== undefined && Object.hasOwn(document, key) ? document[key] : fallback;
      },
      set: (key, value) => {
        documents.set(id, { ...(documents.get(id) ?? {}), [key]: value });
      },
      delete: (key) => {
        const document = documents.get(id) ?? {};
        const { [key]: _gone, ...rest } = document;
        documents.set(id, rest);
      },
    }),
    requestRepaint: () => {
      state.repaints += 1;
    },
  };
  return state;
}

/** The `Card message` document, written the way the row's action writes it. */
function setCardMessage(state, on) {
  state.documents.set('odd-worktree', { ...(state.documents.get('odd-worktree') ?? {}), 'card-message': { schema: 1, on } });
}

function install(options = {}) {
  const seams = options.seams ?? {};
  return installAssistantMessageCard({
    component: options.component ?? AssistantMessageComponent,
    metrics: seams.metrics ?? (() => metrics),
    theme: seams.theme ?? (() => (seams.paint === undefined ? plainTheme : seams.paint)),
    entries: seams.entries,
  });
}

/** The card's heading row: the first row of a paint that states the name (the row above it is blank). */
const headingRow = (component, width = 60) => {
  const row = component.render(width).find((candidate) => unpaint(candidate).includes('Gentleman'));
  return row === undefined ? '' : unpaint(row);
};

beforeEach(() => {
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
});
afterEach(() => {
  uninstallAssistantMessageCard();
  uninstallUserPromptCard();
  delete globalThis[SHELL_API_SLOT];
  delete globalThis[CARD_STYLE_SLOT];
});
after(() => {
  uninstallAssistantMessageCard();
  uninstallUserPromptCard();
  delete globalThis[SHELL_API_SLOT];
  delete globalThis[CARD_STYLE_SLOT];
});

// ---- S5/S6/S7: the final answer is a card, headed `✿ Gentleman` ----

test('with Card message On a final answer is a card headed ✿ Gentleman · HH:MM', () => {
  publishShellApi();
  const outcome = install();
  assert.equal(outcome.installed, true);
  const component = answerComponent();
  const rows = component.render(60);
  assert.notDeepEqual(rows, nativeRows(component, 60), 'the card replaces Pi\'s own block');
  assert.match(headingRow(component), /^╭─ ✿ Gentleman · \d{2}:\d{2} /u, 'the mark, the fixed name and the clock');
  assert.equal(unpaint(rows.at(-1)).startsWith('╰'), true, 'the frame is closed by a rule');
  for (const line of ANSWER_LINES) {
    assert.ok(rows.some((row) => unpaint(row).includes(line)), `"${line}" is part of the body`);
  }
  for (const row of framed(rows)) assert.equal(chars(row).length, 60, `"${unpaint(row)}" is 60 wide`);
});

test('in float the same answer is the same card in the rail style, never half of each', () => {
  publishShellApi();
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  install({ seams: { paint: bandTheme } });
  const component = answerComponent();
  const rows = component.render(60);
  assert.ok(rows.some((row) => /^\s*▎ ✿ Gentleman /u.test(unpaint(row))), 'the rail style, with the same heading');
  assert.doesNotMatch(rows.map(unpaint).join('\n'), /[╭╮╰╯]/u, 'no neon corner survives a float card');
  for (const row of framed(rows)) assert.equal(chars(row).length, 60, `"${unpaint(row)}" is 60 wide`);
});

test('S5/D4: a message with tool calls is NOT a card: the host\'s very same rows array', () => {
  publishShellApi();
  install();
  const component = answerComponent({ message: toolMessage() });
  const hostRows = nativeRows(component, 60);
  assert.equal(paintAnswer(component, hostRows, 60, {}, NATIVE_RENDER), hostRows, 'the very array the host handed over');
  assert.deepEqual(component.render(60), nativeRows(component, 60), 'and the mounted render is Pi\'s, byte for byte');
  assert.doesNotMatch(unpaint(hostRows.join('\n')), /[╭╮╰╯]/u, 'no frame is drawn over it');
});

test('S5/D4: a component whose hasToolCalls is not a boolean is answered natively too', () => {
  publishShellApi();
  install();
  for (const [name, value] of [['absent', undefined], ['a string', 'false'], ['null', null], ['a number', 0]]) {
    const component = answerComponent();
    if (value === undefined) delete component.hasToolCalls;
    else component.hasToolCalls = value;
    assert.deepEqual(component.render(60), nativeRows(component, 60), name);
  }
});

test('with Card message Off the host\'s own rows come back unchanged: the very array', () => {
  publishShellApi({ cardMessage: false });
  install();
  const component = answerComponent();
  const hostRows = nativeRows(component, 60);
  assert.equal(paintAnswer(component, hostRows, 60, {}, NATIVE_RENDER), hostRows, 'the very array the host handed over');
  assert.deepEqual(component.render(60), nativeRows(component, 60), 'and the mounted render is Pi\'s, byte for byte');
});

test('with no published shell API at all the host\'s own rows come back unchanged', () => {
  delete globalThis[SHELL_API_SLOT];
  install();
  const component = answerComponent();
  assert.deepEqual(component.render(60), nativeRows(component, 60));
});

test('flipping Card message repaints the same mounted component, with no re-install', () => {
  const shellApi = publishShellApi();
  install();
  const component = answerComponent();
  assert.match(headingRow(component), /^╭─ ✿ Gentleman /u, 'on');
  setCardMessage(shellApi, false);
  assert.deepEqual(component.render(60), nativeRows(component, 60), 'off: Pi\'s own rows, byte for byte');
  setCardMessage(shellApi, true);
  assert.match(headingRow(component), /^╭─ ✿ Gentleman /u, 'on again, the same card');
});

test('a width too small to draw a frame hands the rows straight back', () => {
  publishShellApi();
  install();
  const component = answerComponent();
  for (const width of [0, 1, 4, 5]) {
    assert.deepEqual(component.render(width), nativeRows(component, width), `width ${width}`);
  }
  assert.notDeepEqual(component.render(6), nativeRows(component, 6), 'a usable width still paints');
  assert.equal(unpaint(component.render(6)[1]).startsWith('╭─'), true, 'and it paints a frame');
});

// ---- the body: Pi's own rows at the INNER width, never repainted ----

test('the body is rendered at the frame\'s inner width, through the ORIGINAL render, and never overflows', () => {
  publishShellApi();
  install();
  const component = answerComponent();
  const body = component.contentContainer.children[1];
  const rows = component.render(60);
  // Neon at 60 draws its frame at 60 and its body at 56 (`cardInnerWidth`): the width the wrapper
  // was handed is only the shim's own gate, and the row that is placed is the one drawn for 56.
  assert.equal(body.widths.at(-1), 56, 'the body is rendered at the frame\'s INNER width');
  assert.equal(chars(rows[1]).length, 60, 'and the frame it is placed in is the full width');
  for (const row of framed(rows)) assert.equal(chars(row).length, 60, `"${unpaint(row)}" is 60 wide`);
  for (const line of ANSWER_LINES) {
    assert.ok(rows.some((row) => unpaint(row).includes(line)), `"${line}" fits inside the frame`);
  }
});

test('the frame costs exactly its own rows: one blank row above it, Pi\'s Spacer row gone', () => {
  publishShellApi();
  install();
  const rows = answerComponent().render(60).map(unpaint);
  assert.equal(rows[0], '', 'one blank row keeps the separation the Spacer row gave');
  assert.equal(rows[1].startsWith('╭─'), true, 'and the frame starts right after it');
  assert.equal(rows.filter((row) => row === '').length, 1, 'never two blank rows');
  // The body is exactly Pi's own lines, in order, once each.
  const body = rows.filter((row) => ANSWER_LINES.some((line) => row.includes(line)));
  assert.equal(body.length, ANSWER_LINES.length);
});

test('Pi\'s zone markers appear once on the card\'s first and last row, never on a body row', () => {
  publishShellApi();
  install();
  const component = answerComponent();
  const rows = component.render(60);
  assert.ok(rows[0].startsWith(OSC133_ZONE_START), 'the zone starts where the card starts');
  // Pi's ORDER, byte for byte: end and then final, PREFIXED on the last row.
  assert.ok(rows.at(-1).startsWith(OSC133_ZONE_CLOSE), 'end then final, before the last row');
  assert.equal(rows.at(-1).endsWith(OSC133_ZONE_CLOSE), false, 'never appended after the row');
  const joined = rows.join('\n');
  assert.equal(joined.split(OSC133_ZONE_START).length - 1, 1, 'one start marker');
  assert.equal(joined.split(OSC133_ZONE_CLOSE).length - 1, 1, 'one close marker');
  for (const row of rows.slice(1, -1)) {
    assert.equal(row.includes(OSC133_ZONE_START) || row.includes(OSC133_ZONE_CLOSE), false, 'no body row carries one');
  }
  assert.equal(chars(rows[1]).length, 60, 'the markers are zero width: the frame still fits exactly');
  const again = component.render(60);
  assert.equal(again[0].split(OSC133_ZONE_START).length - 1, 1, 'a repaint writes the marker once');
});

test('a body that draws no row, or one that throws at the inner width, answers native', () => {
  publishShellApi();
  install();
  const empty = answerComponent({ children: [new StubSpacer(1), new StubText('EMPTY_BODY')] });
  assert.deepEqual(empty.render(60), nativeRows(empty, 60), 'no row at all');
  const throwing = answerComponent();
  throwing.contentContainer.throwAt = 56;
  assert.deepEqual(throwing.render(60), nativeRows(throwing, 60), 'a body that throws at the inner width');
});

test('a metrics seam that throws, or a theme that throws, answers the host\'s rows', () => {
  publishShellApi();
  install({ seams: { metrics: () => { throw new Error('no tui package'); }, theme: () => { throw new Error('no theme'); } } });
  assert.deepEqual(answerComponent().render(60), nativeRows(answerComponent(), 60), 'both seams throw');
  uninstallAssistantMessageCard();
  install({ seams: { metrics: () => ({}), theme: () => ({}) } });
  const unusable = answerComponent();
  assert.deepEqual(unusable.render(60), nativeRows(unusable, 60), 'a metrics object that cannot measure');
  uninstallAssistantMessageCard();
  const hostile = { fg: () => { throw new Error('boom'); }, bg: () => { throw new Error('boom'); } };
  install({ seams: { paint: hostile } });
  const throwing = answerComponent();
  assert.deepEqual(throwing.render(60), nativeRows(throwing, 60), 'a theme that throws');
});

// ---- S6: the frame and the title wear `mdHeading` ----

const FRAME_CHARS = new Set(['╭', '╮', '╰', '╯', '─', '│', '▎']);

function assertHeadingChrome(rows, style) {
  const frame = rows.flatMap((row) => cells(row)).filter((cell) => FRAME_CHARS.has(cell.char));
  assert.ok(frame.length > 0, `${style}: the card draws a frame`);
  for (const cell of frame) {
    assert.equal(cell.code, ROLE_CODE.mdHeading, `${style}: "${cell.char}" is painted in the mdHeading role`);
  }
  const body = rows.flatMap((row) => cells(row)).filter((cell) => cell.code === MARKDOWN_CODE);
  assert.ok(body.length > 0, `${style}: the body keeps the paint its own renderer gave it`);
  const head = cells(rows.find((row) => unpaint(row).includes('Gentleman')));
  const mark = head.find((cell) => cell.char === '✿');
  assert.equal(mark.code, ROLE_CODE.mdHeading, `${style}: the mark wears the title role`);
  for (const letter of ['G', 'e', 'n']) {
    const cell = head.find((candidate) => candidate.char === letter);
    assert.equal(cell.code, ROLE_CODE.mdHeading, `${style}: "${letter}" of the name wears mdHeading`);
  }
}

test('the frame and the title wear mdHeading in neon, and the body keeps its own paint', () => {
  publishShellApi();
  const paint = roleTheme();
  install({ seams: { paint } });
  const rows = answerComponent().render(60);
  assertHeadingChrome(rows, 'neon');
  assert.equal(paint.roles.includes('text'), false, 'no body row is repainted in the body role');
});

test('the frame and the title wear mdHeading in float too', () => {
  publishShellApi();
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  install({ seams: { paint: roleTheme() } });
  assertHeadingChrome(answerComponent().render(60), 'float');
});

test('the card identity names Gentleman in mdHeading, and the substrate\'s own mark', () => {
  assert.equal(IDENTITY.title, 'Gentleman', 'the fixed name, never read from /identity');
  assert.equal(IDENTITY.titleRole, 'mdHeading');
  assert.equal(IDENTITY.railRole, 'mdHeading');
  assert.equal(IDENTITY.tone, 'info');
  publishShellApi();
  install();
  const head = unpaint(answerComponent().render(60).find((row) => row.includes('Gentleman')));
  assert.match(head, /✿ Gentleman/u, 'the mark is the substrate default, unoverridden');
});

// ---- S7: the heading's clock ----

/** Local 24-hour `HH:MM`, zero padded: the clock the heading is expected to carry. */
const localClock = (instant) => `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;

/** The `HH:MM` a heading row draws after its separator, read from the row's own cells. */
function headingClock(row) {
  const line = cells(row);
  const dot = line.findIndex((cell) => cell.char === '·');
  if (dot < 0) return undefined;
  return line.slice(dot + 2, dot + 7).map((cell) => cell.char).join('');
}

test('S7: a restored answer heads the clock Pi stored on it, and the clock is muted', () => {
  publishShellApi();
  const paint = roleTheme();
  install({ seams: { paint } });
  const at = '2026-11-23T19:12:59Z';
  const expected = localClock(new Date(at));
  const component = answerComponent({ timestamp: at });
  const rows = component.render(60);
  assert.ok(headingRow(component).includes(`✿ Gentleman · ${expected}`), `the stored instant, local: ${expected}`);
  const head = rows.find((row) => unpaint(row).includes('Gentleman'));
  assert.equal(headingClock(head), expected, 'five clock columns, zero padded, no seconds');
  const line = cells(head);
  const dot = line.findIndex((cell) => cell.char === '·');
  assert.equal(line[dot].code, ROLE_CODE.muted, 'the separator wears the muted role');
  for (const cell of line.slice(dot + 2, dot + 7)) {
    assert.equal(cell.code, ROLE_CODE.muted, `"${cell.char}" of the clock is muted`);
  }
});

test('S7: without a timestamp the first-paint clock is used, unchanged on every later paint', () => {
  publishShellApi();
  install();
  const realNow = Date.now;
  try {
    Date.now = () => new Date(2026, 0, 2, 9, 7, 30).getTime();
    const component = answerComponent();
    const first = headingRow(component);
    assert.ok(first.includes('✿ Gentleman · 09:07'), `the clock of the first paint: ${first}`);
    Date.now = () => new Date(2026, 0, 2, 17, 45, 0).getTime();
    assert.equal(headingRow(component), first, 'a later paint never drifts');
    const other = answerComponent();
    assert.ok(headingRow(other).includes('✿ Gentleman · 17:45'), 'each answer keeps its own first-paint clock');
  } finally {
    Date.now = realNow;
  }
});

test('S7: with no clock at all the heading is ✿ Gentleman alone, inventing nothing', () => {
  publishShellApi();
  install({ seams: { paint: taggedTheme } });
  const realNow = Date.now;
  try {
    Date.now = () => Number.NaN;
    const component = answerComponent();
    const head = component.render(60).find((row) => unpaint(row).includes('Gentleman'));
    assert.ok(head.includes('<mdHeading>✿ Gentleman</mdHeading>'), 'the mark and the name wear the title role together');
    const plain = unpaint(head);
    assert.match(plain, /^╭─ ✿ Gentleman /u, 'the heading is the name alone');
    assert.equal(plain.includes('·'), false, 'no subtitle separator');
    assert.doesNotMatch(plain, /\d{1,2}:\d{2}|ago/u, 'no time is invented');
    const unreadable = answerComponent({ timestamp: 'yesterday' });
    assert.equal(headingRow(unreadable).includes('·'), false, 'an unreadable timestamp invents no clock');
  } finally {
    Date.now = realNow;
  }
});

// ---- S8: the turn stats, from the session history ----

/**
 * The entries `ctx.sessionManager.getEntries()` returns: Pi's message entries
 * (`{ type: "message", id, parentId, timestamp, message: { role } }`), which is the shape this
 * package's own readers filter on (`lib/worktree-warp-sessions.js`).
 */
const entry = (id, role, at) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: at,
  message: { role, content: role === 'assistant' ? [{ type: 'text', text: id }] : [{ type: 'text', text: id }] },
});

/**
 * The spec's own sample (S8/L4): one input at 19:00, seventeen assistant entries in the turn it
 * opened, the last of them at 19:58:20, and the NEXT input after that answer — so the final answer
 * is the seventeenth, 58m20s after the input that started the turn.
 */
function seventeenTurns() {
  const entries = [entry('u1', 'user', '2026-11-23T19:00:00Z')];
  for (let index = 1; index <= 16; index += 1) {
    entries.push(entry(`a${index}`, 'assistant', `2026-11-23T19:${String(index).padStart(2, '0')}:00Z`));
  }
  entries.push(entry('a17', 'assistant', '2026-11-23T19:58:20Z'));
  entries.push(entry('u2', 'user', '2026-11-23T20:10:00Z'));
  return entries;
}

test('S8: the heading carries the turns and the elapsed time of the history', () => {
  publishShellApi();
  // The answer closes the turn the previous input opened: seventeen assistant entries after it.
  install({ seams: { entries: () => seventeenTurns() } });
  const component = answerComponent({ messageId: 'a17', timestamp: '2026-11-23T19:58:20Z' });
  const head = headingRow(component);
  assert.match(head, /· \d{2}:\d{2} \(17 turns · 58m20s\) /u, `the parenthesis after the clock: ${head}`);
});

test('S8: one assistant answer after one input is 1 turn, singular', () => {
  publishShellApi();
  const entries = [entry('u1', 'user', '2026-11-23T18:00:00Z'), entry('a1', 'assistant', '2026-11-23T18:00:42Z')];
  install({ seams: { entries: () => entries } });
  const at = '2026-11-23T18:00:42Z';
  const head = headingRow(answerComponent({ timestamp: at, messageId: 'a1' }));
  assert.ok(head.includes(`· ${localClock(new Date(at))} (1 turn · 42s) `), `singular, in seconds under a minute: ${head}`);
});

test('S8: no history seam, a throwing seam and a non-array answer all omit the parenthesis', () => {
  const cases = [
    ['absent', undefined],
    ['throwing', () => { throw new Error('the session is gone'); }],
    ['answering nothing', () => undefined],
    ['answering a string', () => 'entries'],
    ['answering an object', () => ({ entries: [] })],
  ];
  publishShellApi();
  for (const [name, seam] of cases) {
    install({ seams: { entries: seam } });
    const plain = unpaint(answerComponent({ timestamp: '2026-11-23T19:58:20Z' }).render(60).find((row) => row.includes('Gentleman')));
    assert.match(plain, /· \d{2}:\d{2} /u, `${name}: the clock is still there`);
    assert.equal(plain.includes('('), false, `${name}: and nothing is invented`);
    uninstallAssistantMessageCard();
  }
});

test('S8: a history with no previous input omits the parenthesis too', () => {
  publishShellApi();
  install({ seams: { entries: () => [entry('a1', 'assistant', '2026-11-23T19:58:20Z')] } });
  const plain = unpaint(answerComponent({ messageId: 'a1' }).render(60).find((row) => row.includes('Gentleman')));
  assert.equal(plain.includes('('), false);
});

// ---- `turnStats` and the duration formatter, as the pure functions they are ----

test('turnStats: one user input and one assistant answer is 1 turn', () => {
  const stats = turnStats([entry('u1', 'user', '2026-11-23T18:00:00Z'), entry('a1', 'assistant', '2026-11-23T18:00:42Z')], 'a1', 0);
  assert.deepEqual(stats, { turns: 1, elapsedMs: 42_000 });
});

test('turnStats: 17 assistant entries between two user inputs print 17 turns and 58m20s', () => {
  const stats = turnStats(seventeenTurns(), 'a17', 0);
  // From the previous input (19:00) to the final answer (19:58:20): its own turn, once.
  assert.deepEqual(stats, { turns: 17, elapsedMs: 58 * 60_000 + 20_000 });
});

test('turnStats: a live message (id not found) counts itself and ends at nowMs', () => {
  const entries = [
    entry('u1', 'user', '2026-11-23T18:00:00Z'),
    entry('a1', 'assistant', '2026-11-23T18:01:00Z'),
    entry('u2', 'user', '2026-11-23T19:00:00Z'),
    entry('a2', 'assistant', '2026-11-23T19:02:00Z'),
  ];
  const now = Date.parse('2026-11-23T19:02:30Z');
  assert.deepEqual(turnStats(entries, 'not-persisted-yet', now), { turns: 2, elapsedMs: 150_000 });
  assert.deepEqual(turnStats(entries, undefined, now), { turns: 2, elapsedMs: 150_000 }, 'a missing id is the same live message');
});

test('turnStats: no previous user input gives undefined', () => {
  assert.equal(turnStats([entry('a1', 'assistant', '2026-11-23T18:00:00Z')], 'a1', 0), undefined);
  assert.equal(turnStats([], 'a1', 0), undefined);
  assert.equal(turnStats(undefined, 'a1', 0), undefined, 'a non-array history is no history');
});

test('turnStats: a resumed session uses the entry\'s stored timestamp, not nowMs', () => {
  const entries = [entry('u1', 'user', '2026-11-23T18:00:00Z'), entry('a1', 'assistant', '2026-11-23T18:21:00Z')];
  const stats = turnStats(entries, 'a1', Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(stats.elapsedMs, 21 * 60_000, 'the stored gap, never the clock of the paint');
});

test('turnStats: an unparseable timestamp states the turns and no elapsed time', () => {
  const entries = [entry('u1', 'user', 'not a date'), entry('a1', 'assistant', '2026-11-23T18:21:00Z')];
  assert.deepEqual(turnStats(entries, 'a1', 0), { turns: 1, elapsedMs: undefined });
  const missing = [{ type: 'message', id: 'u1', message: { role: 'user' } }, entry('a1', 'assistant', '2026-11-23T18:21:00Z')];
  assert.deepEqual(turnStats(missing, 'a1', 0), { turns: 1, elapsedMs: undefined });
});

test('turnStats: a backwards clock never reports a negative time, and garbage entries are skipped', () => {
  const entries = [entry('u1', 'user', '2026-11-23T18:00:00Z'), null, 'junk', entry('a1', 'assistant', '2026-11-23T17:00:00Z')];
  assert.deepEqual(turnStats(entries, 'a1', 0), { turns: 1, elapsedMs: 0 });
});

test('turnStats: only user/assistant message roles count, and entry.role is accepted too', () => {
  const entries = [
    { type: 'message', id: 'u1', role: 'user', timestamp: '2026-11-23T18:00:00Z' },
    { type: 'custom', id: 'c1', customType: 'odd-worktree.odd-touch', timestamp: '2026-11-23T18:00:10Z', data: {} },
    { type: 'message', id: 'a1', message: { role: 'assistant' }, timestamp: '2026-11-23T18:01:00Z' },
    { type: 'message', id: 'r1', message: { role: 'toolResult' }, timestamp: '2026-11-23T18:01:30Z' },
  ];
  assert.deepEqual(turnStats(entries, 'a1', 0), { turns: 1, elapsedMs: 60_000 });
});

test('formatDuration: seconds under a minute, minutes under an hour, hours zero pad the minutes', () => {
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59_999), '59s');
  assert.equal(formatDuration(60_000), '1m0s');
  assert.equal(formatDuration(58 * 60_000 + 20_000), '58m20s');
  assert.equal(formatDuration(60 * 60_000 + 2 * 60_000 + 20_000), '1h02m20s');
  assert.equal(formatDuration(2 * 3_600_000 + 5_000), '2h00m5s');
  assert.equal(formatDuration(Number.NaN), '0s', 'an unreadable time is never printed as a number');
});

// ---- the shim: one wrapper per card, torn down on demand ----

test('installing twice wraps once, and uninstall restores the original render byte for byte', () => {
  publishShellApi();
  const first = install();
  assert.equal(first.installed, true);
  const wrapped = AssistantMessageComponent.prototype.render;
  assert.notEqual(wrapped, NATIVE_RENDER);
  const second = install();
  assert.equal(second.installed, true);
  assert.equal(AssistantMessageComponent.prototype.render, wrapped, 'a second install adds no second layer');
  assert.match(headingRow(answerComponent()), /^╭─ ✿ Gentleman /u, 'the card is still drawn through one wrapper');
  install({ seams: { paint: taggedTheme } });
  assert.ok(answerComponent().render(60).some((row) => row.includes('<mdHeading>✿ Gentleman</mdHeading>')), 'the newest logic paints');
  uninstallAssistantMessageCard();
  assert.equal(AssistantMessageComponent.prototype.render, NATIVE_RENDER, 'the original function is back');
  const fresh = answerComponent();
  assert.deepEqual(fresh.render(60), nativeRows(fresh, 60));
});

test('two cards, two cells: installing one never unwraps the other', () => {
  publishShellApi();
  class PromptComponent {
    render() {
      return ['native prompt'];
    }
  }
  class AnswerComponent {
    render() {
      return ['native answer'];
    }
  }
  const promptNative = PromptComponent.prototype.render;
  const answerNative = AnswerComponent.prototype.render;
  installUserPromptCard({ component: PromptComponent, metrics: () => metrics, theme: () => plainTheme });
  installAssistantMessageCard({ component: AnswerComponent, metrics: () => metrics, theme: () => plainTheme });
  assert.notEqual(PromptComponent.prototype.render, promptNative, 'the prompt class is wrapped');
  assert.notEqual(AnswerComponent.prototype.render, answerNative, 'and so is the answer class');
  uninstallAssistantMessageCard();
  assert.equal(AnswerComponent.prototype.render, answerNative, 'the answer card unwraps');
  assert.notEqual(PromptComponent.prototype.render, promptNative, 'and leaves the prompt card wrapped');
  installAssistantMessageCard({ component: AnswerComponent, metrics: () => metrics, theme: () => plainTheme });
  assert.notEqual(AnswerComponent.prototype.render, answerNative);
  uninstallUserPromptCard();
  assert.equal(PromptComponent.prototype.render, promptNative, 'the prompt card unwraps');
  assert.notEqual(AnswerComponent.prototype.render, answerNative, 'and leaves the answer card wrapped');
  uninstallAssistantMessageCard();
});

test('a class without render, an absent class and a component with no rows install and answer native', () => {
  publishShellApi();
  const refused = installAssistantMessageCard({});
  assert.equal(refused.installed, false);
  assert.equal(typeof refused.uninstall, 'function', 'a refused install still answers an inert uninstall');
  assert.equal(installAssistantMessageCard({ component: class Empty {} }).installed, false);
  assert.equal(installAssistantMessageCard({ component: 42 }).installed, false);
  assert.equal(AssistantMessageComponent.prototype.render, NATIVE_RENDER, 'nothing was wrapped for a class that cannot draw');
  install();
  const empty = answerComponent({ children: [] });
  assert.deepEqual(empty.render(60), nativeRows(empty, 60), 'a component that renders no row is no card');
});

// ---- the wiring: the deferred install and the live session's history ----

async function loadExtensionModule(loader, events = {}) {
  process.env.GENTLE_WORKTREE_LIB_DIR = fixture.LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-worktree-amc-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, fixture.stubbedSource());
    const namespace = await import(pathToFileURL(copy).href);
    if (typeof namespace.setAssistantMessageCardHostLoader !== 'function') {
      throw new Error('the extension exposes no seam for the deferred assistant-card install');
    }
    const hooks = [];
    const host = {
      registerCommand() {},
      registerTool() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      appendEntry() {},
      on: (event, handler) => hooks.push([event, handler]),
      events,
    };
    namespace.setAssistantMessageCardHostLoader(loader);
    namespace.default(host);
    return { namespace, hooks };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const drain = () => new Promise((resolve) => setImmediate(resolve));

const sessionHooks = (hooks, event) => hooks.filter(([name]) => name === event).map(([, handler]) => handler);

/** The `pi` double's ctx for one session start, with the manager Pi hands a session. */
const ctxOf = (entries) => ({ cwd: process.cwd(), sessionManager: { getEntries: () => entries } });

test('the wiring installs the answer card on session_start and restores it on shutdown', async () => {
  const previous = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  class Host {
    render(width) {
      return [`native ${width}`];
    }
  }
  const native = Host.prototype.render;
  const { namespace, hooks } = await loadExtensionModule(() => ({ AssistantMessageComponent: Host }));
  namespace.setWorktreeToolCardMetrics(metrics);
  try {
    assert.ok(sessionHooks(hooks, 'session_shutdown').length > 0, 'the teardown is registered');
    for (const handler of sessionHooks(hooks, 'session_start')) await handler({}, ctxOf([]));
    await drain();
    assert.notEqual(Host.prototype.render, native, 'the live session patches the class');
    for (const handler of sessionHooks(hooks, 'session_shutdown')) await handler({}, {});
    assert.equal(Host.prototype.render, native, 'and its shutdown restores it, byte for byte');
  } finally {
    for (const handler of sessionHooks(hooks, 'session_shutdown')) await handler({}, {});
    if (previous === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previous;
  }
});

test('the wiring hands the card the CURRENT session\'s own history for its stats', async () => {
  const previous = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  const entries = [entry('u1', 'user', '2026-11-23T18:00:00Z'), entry('a1', 'assistant', '2026-11-23T18:00:42Z')];
  class Host {
    constructor() {
      this.hasToolCalls = false;
      this.timestamp = '2026-11-23T18:00:42Z';
      this.messageId = 'a1';
    }

    render() {
      return ['native answer'];
    }
  }
  const { namespace, hooks } = await loadExtensionModule(() => ({ AssistantMessageComponent: Host }));
  namespace.setWorktreeToolCardMetrics(metrics);
  try {
    for (const handler of sessionHooks(hooks, 'session_start')) await handler({}, ctxOf(entries));
    await drain();
    const rows = new Host().render(60);
    assert.ok(rows.some((row) => unpaint(row).includes('(1 turn · 42s)')), `the history the session started with: ${rows.map(unpaint).join(' | ')}`);
    for (const handler of sessionHooks(hooks, 'session_shutdown')) await handler({}, {});
    assert.deepEqual(new Host().render(60), ['native answer'], 'the session that ended owns no card any more');
  } finally {
    for (const handler of sessionHooks(hooks, 'session_shutdown')) await handler({}, {});
    if (previous === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previous;
  }
});

'use strict';
// The user's own prompt, drawn as a card on this package's substrate: while this package's
// `Card message` switch is On (`lib/card-message.js`), `UserMessageComponent.render` answers the
// card instead of Pi's plain block; with it Off, and for every shell API it cannot read, the
// host's own rows come back byte for byte. `Card activity` no longer decides this card.
//
// Everything below observes the public seam: the shim is installed on a STUB class exactly as
// the extension installs it on Pi's, the shell API is the published object a process-wide slot
// holds, the style is the slot Gentle Shell writes, and the rows are read by calling `render`
// on the component — the same call the host makes on every frame.
const assert = require('node:assert/strict');
const { after, afterEach, beforeEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { installUserPromptCard, paintPrompt, uninstallUserPromptCard } = require('../lib/user-prompt-card.js');
const { CARD_STYLE, CARD_STYLE_SLOT } = require('../lib/card-style.js');
// The extension itself, loaded the way `tools/fixtures/load-extension.js` loads it: the deferred
// install's guard lives there, so the test has to reach the module's own seam.
const fixture = require('./fixtures/load-extension.js');

const SHELL_API_SLOT = Symbol.for('odd-worktree/shell-api/v1');
const ACTIVITY = 'odd-worktree.bash-activity';

// ---- the theme: one role per painted cell ----
//
// The card paints a theme ROLE, never a colour, so the stub turns each role into a distinct
// SGR code. A row can then be read back cell by cell (`cells`), which is how "every chrome
// cell wears the accent" and "no user-message background is left anywhere" are asserted
// without reading any internal state.
const ROLE_CODE = { accent: '35', border: '34', text: '37', dim: '2', muted: '90', success: '32', warning: '33', error: '31' };
const BG_CODE = { toolSuccessBg: '48;5;240', toolPendingBg: '48;5;214', toolErrorBg: '48;5;203' };
const MARKDOWN_CODE = '36';
const USER_MESSAGE_BG_CODE = '48;5;236';

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

// Pi's prompt-zone markers, exactly as `UserMessageComponent.render` writes them: the start of
// the zone on the first row, its end and its final marker on the last. They are OSC sequences,
// not SGR paint, so they are zero width and every helper below strips them as such.
const OSC133_ZONE_START = '\x1b]133;A\x07';
const OSC133_ZONE_END = '\x1b]133;B\x07';
const OSC133_ZONE_FINAL = '\x1b]133;C\x07';
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_ZONE_FINAL;

const ANSI = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07]*\x07/g;
const stripAnsi = (value) => value.replace(ANSI, '').replace(OSC, '');
const chars = (value) => [...stripAnsi(value)];
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');

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

// ---- the measurement seam (the one `tools/message-card.test.js` uses, ANSI preserved) ----

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
const countingMetrics = () => {
  const counts = { visibleWidth: 0, truncateToWidth: 0, wrapTextWithAnsi: 0 };
  return { counts, metrics: makeMetrics(counts) };
};

// ---- the stub host: Pi's `UserMessageComponent` and its Markdown child ----

const markdownTheme = { heading: (text) => text, code: (text) => text };

/** Pi's Markdown, as the card sees it: the constructor takes the six arguments Pi passes. */
class StubMarkdown {
  constructor(text, paddingX, paddingY, theme, defaultTextStyle, options) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    // Pi's MarkdownTheme is captured when the child is BUILT: a theme switched later is
    // visible to a freshly built child and invisible to this one, exactly like Pi's own.
    this.code = StubMarkdown.code;
    this.defaultTextStyle = defaultTextStyle;
    this.options = options;
    StubMarkdown.made.push(this);
  }

  render(width) {
    this.widths = [...(this.widths ?? []), width];
    // A renderer that refuses the document: the card must answer the host's own rows.
    if (this.text === 'THROW') throw new Error('the renderer blew up');
    if (this.text === 'NOT_ROWS') return 'not rows';
    if (this.text === 'EMPTY_BODY') return [];
    // Pi's Markdown hands the host's composed `transform` the WHOLE text and the content width
    // before it parses anything (`markdown.js`: `this.options.transform?.(this.text, contentWidth)`),
    // so a stub that ignored it could never show what an extension transformer does to a prompt.
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const transformed = this.options?.transform?.(String(this.text), contentWidth) ?? this.text;
    // Rows the renderer already painted: the card must PLACE them, never repaint them.
    const lines = String(transformed).split('\n').map((line) => `\x1b[${this.code}m${line}\x1b[39m`);
    // Pi's Markdown pads its content with `paddingY` blank rows above and below
    // (`emptyLines.concat(contentLines, emptyLines)`), and the stub models that: a clone that
    // keeps the host's padding costs the terminal two rows per prompt.
    const blank = ' '.repeat(Math.max(0, width));
    const pad = Array.from({ length: this.paddingY }, () => blank);
    return [...pad, ...lines, ...pad];
  }
}
StubMarkdown.made = [];
StubMarkdown.code = MARKDOWN_CODE;

/** Pi's user message: a `Container` whose one child is the Markdown the card rebuilds. */
class UserMessageComponent {
  constructor(text, options = {}) {
    this.text = text;
    this.outputPad = 1;
    this.empty = options.empty === true;
    this.children = options.children !== undefined
      ? options.children
      : [new StubMarkdown(
        text,
        options.paddingX ?? 1,
        1,
        options.markdownTheme !== undefined ? options.markdownTheme : markdownTheme,
        { color: (content) => `\x1b[37m${content}\x1b[39m`, bgColor: (content) => `\x1b[${USER_MESSAGE_BG_CODE}m${content}\x1b[49m` },
        options.markdownOptions ?? { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
      )];
  }

  // Pi's own block, in Pi's own shape: the card either replaces it whole or leaves it alone,
  // with the prompt-zone markers on its first and last row in Pi's OWN order — `start`
  // prefixed on the first row, `end` then `final` prefixed on the last
  // (`user-message.js`: `last = OSC133_ZONE_END + OSC133_ZONE_FINAL + last`).
  render(width) {
    if (this.empty) return [];
    const lines = [`\x1b[2mnative ${width}\x1b[22m`, `native ${this.text}`];
    const zoned = [...lines];
    zoned[0] = OSC133_ZONE_START + zoned[0];
    zoned[zoned.length - 1] = OSC133_ZONE_CLOSE + zoned[zoned.length - 1];
    return zoned;
  }
}

// Pi's own rows, called through the function the shim wraps: the byte-for-byte reference.
const NATIVE_RENDER = UserMessageComponent.prototype.render;
const nativeRows = (component, width) => NATIVE_RENDER.call(component, width);

const PROMPT = ['explain the card', 'and keep `this` visible'].join('\n');

function promptComponent(text = PROMPT) {
  return new UserMessageComponent(text);
}

// ---- the published shell API, and the slots the runtime reads ----

/**
 * The published shell API plus the store its readers use: `card-message` is the switch the card asks
 * (`lib/card-message.js`) and `identity` the name its heading wears — one in-memory document map
 * behind `createStore('odd-worktree')`, merged per key exactly like the shell API's own store, so a
 * write here is what the next paint has to see.
 */
function publishShellApi(answer, options = {}) {
  const documents = new Map([['odd-worktree', { 'card-message': { schema: 1, on: options.cardMessage !== false } }]]);
  const state = { answer, calls: [], documents };
  globalThis[SHELL_API_SLOT] = {
    schema: 'odd-worktree/shell-api',
    version: 1,
    resolveToolDesignSelection(tool) {
      state.calls.push(tool);
      const value = state.answer;
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(tool);
      return value;
    },
    createStore: (id) => ({
      get: (key, fallback) => {
        const document = documents.get(id);
        return document !== undefined && Object.hasOwn(document, key) ? document[key] : fallback;
      },
      set: (key, value) => {
        documents.set(id, { ...(documents.get(id) ?? {}), [key]: value });
      },
    }),
  };
  return state;
}

/** The `Card message` document, written the way the row's action writes it. */
function setCardMessage(state, on) {
  state.documents.set('odd-worktree', { ...(state.documents.get('odd-worktree') ?? {}), 'card-message': { schema: 1, on } });
}

const ACTIVITY_ANSWER = { kind: 'design', design: { id: ACTIVITY } };

function install(options = {}) {
  const seams = options.seams ?? {};
  const component = options.component ?? UserMessageComponent;
  return installUserPromptCard({
    component,
    metrics: seams.metrics ?? (() => (seams.counting === undefined ? metrics : seams.counting)),
    theme: seams.theme ?? (() => (seams.paint === undefined ? plainTheme : seams.paint)),
  });
}

beforeEach(() => {
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  StubMarkdown.made = [];
  StubMarkdown.code = MARKDOWN_CODE;
});
afterEach(() => {
  uninstallUserPromptCard();
  delete globalThis[SHELL_API_SLOT];
  delete globalThis[CARD_STYLE_SLOT];
});
after(() => {
  uninstallUserPromptCard();
  delete globalThis[SHELL_API_SLOT];
  delete globalThis[CARD_STYLE_SLOT];
});

// ---- S1 (card-message): the card follows `Card message`, never again `Card activity` ----

test('while Card message is On the prompt is a card headed ✿ You', () => {
  const shellApi = publishShellApi(ACTIVITY_ANSWER);
  const outcome = install();
  assert.equal(outcome.installed, true);
  const component = promptComponent();
  const rows = component.render(60);
  assert.notDeepEqual(rows, nativeRows(component, 60), 'the card replaces Pi\'s own block');
  const head = unpaint(rows[0]);
  assert.match(head, /^╭─ ✿ You /u, 'the first design: the dead-flower mark and the name, on the frame');
  assert.equal(unpaint(rows[rows.length - 1]).startsWith('╰'), true, 'the frame is closed by a rule');
  assert.ok(rows.some((row) => unpaint(row).includes('explain the card')), 'the prompt is the body');
  assert.ok(rows.some((row) => unpaint(row).includes('and keep `this` visible')), 'every row of it is drawn');
  assert.deepEqual(shellApi.calls, [], 'the prompt card no longer asks the `Card activity` line');
  for (const row of rows) assert.equal(chars(row).length, 60, `"${unpaint(row)}" is 60 wide`);
});

test('with Card activity answering activity and Card message Off the prompt is NOT a card', () => {
  publishShellApi(ACTIVITY_ANSWER, { cardMessage: false });
  install();
  const component = promptComponent();
  assert.deepEqual(component.render(60), nativeRows(component, 60),
    'the tool line no longer decides this card');
});

test('with Card message On and Card activity at its default the prompt IS a card', () => {
  publishShellApi({ kind: 'native' });
  install();
  const component = promptComponent();
  assert.notDeepEqual(component.render(60), nativeRows(component, 60),
    'the switch alone decides it');
  assert.match(unpaint(component.render(60)[0]), /^╭─ ✿ You /u);
});

test('with Card message Off the host\'s own rows come back unchanged: the very array', () => {
  publishShellApi(ACTIVITY_ANSWER, { cardMessage: false });
  install();
  const component = promptComponent();
  const hostRows = nativeRows(component, 60);
  assert.equal(paintPrompt(component, hostRows, 60, {}), hostRows, 'the array the host handed over, not a copy');
  assert.deepEqual(component.render(60), nativeRows(component, 60), 'and the mounted render is byte for byte Pi\'s');
});

test('an unusable shell API, or a store that throws, hands Pi\'s own rows back byte for byte', () => {
  const cases = [
    ['no published shell API at all', () => { delete globalThis[SHELL_API_SLOT]; }],
    ['an object that is not a shell API', () => { globalThis[SHELL_API_SLOT] = 'native'; }],
    ['a null slot', () => { globalThis[SHELL_API_SLOT] = null; }],
    ['a shell API of another version', () => { publishShellApi(ACTIVITY_ANSWER); globalThis[SHELL_API_SLOT].version = 2; }],
    ['another plugin\'s schema', () => { publishShellApi(ACTIVITY_ANSWER); globalThis[SHELL_API_SLOT].schema = 'other/api'; }],
    ['a shell API with no store', () => { publishShellApi(ACTIVITY_ANSWER); delete globalThis[SHELL_API_SLOT].createStore; }],
    ['a store that throws', () => { publishShellApi(ACTIVITY_ANSWER); globalThis[SHELL_API_SLOT].createStore = () => { throw new Error('disk'); }; }],
    ['a document that cannot be read', () => {
      publishShellApi(ACTIVITY_ANSWER);
      globalThis[SHELL_API_SLOT].createStore = () => ({ get: () => { throw new Error('disk'); }, set: () => {} });
    }],
  ];
  install();
  for (const [name, publish] of cases) {
    publish();
    const component = promptComponent();
    assert.deepEqual(component.render(60), nativeRows(component, 60), name);
  }
});

// ---- S2: the gate is read per paint, never cached ----

test('flipping Card message repaints the same mounted component, with no re-install', () => {
  const shellApi = publishShellApi(ACTIVITY_ANSWER);
  install();
  const component = promptComponent();
  const card = component.render(60);
  assert.match(unpaint(card[0]), /^╭─ ✿ You /u, 'on');
  setCardMessage(shellApi, false);
  assert.deepEqual(component.render(60), nativeRows(component, 60), 'off: Pi\'s own rows, byte for byte');
  setCardMessage(shellApi, true);
  assert.deepEqual(component.render(60), card, 'on again, the same card');
  assert.deepEqual(shellApi.calls, [], 'the switch was read on every paint, and the tool line never asked');
});

test('a width too small to draw a frame hands the rows straight back', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const component = promptComponent();
  for (const width of [0, 1, 4, 5]) {
    assert.deepEqual(component.render(width), nativeRows(component, width), `width ${width}`);
  }
  assert.notDeepEqual(component.render(6), nativeRows(component, 6), 'a usable width still paints');
});

// ---- identity-command: the heading is the person's name, read on every paint ----

/**
 * The published shell API plus the store `lib/user-identity.js` reads: one in-memory document map
 * behind `createStore('odd-worktree')`, merged per key exactly like the shell API's own store. No
 * invalidation call exists: a name is written here and the next paint has to see it.
 */
function publishIdentityShellApi() {
  const documents = new Map();
  publishShellApi(ACTIVITY_ANSWER);
  globalThis[SHELL_API_SLOT].createStore = (id) => ({
    get: (key, fallback) => {
      const document = documents.get(id);
      return document !== undefined && Object.hasOwn(document, key) ? document[key] : fallback;
    },
    set: (key, value) => {
      documents.set(id, { ...(documents.get(id) ?? {}), [key]: value });
    },
  });
  return {
    documents,
    setName: (name) => documents.set('odd-worktree', { ...(documents.get('odd-worktree') ?? {}), identity: { schema: 1, name } }),
    forgetName: () => documents.set('odd-worktree', {}),
  };
}

const headOf = (component, width = 60) => unpaint(component.render(width)[0]);

test('a stored name heads the card instead of You', () => {
  const shellApi = publishIdentityShellApi();
  shellApi.setName('Jona');
  install();
  const rows = promptComponent().render(60);
  assert.match(unpaint(rows[0]), /^╭─ ✿ Jona /u, 'the heading is the name');
  assert.equal(rows.some((row) => unpaint(row).includes('You')), false, 'nothing of the card still heads with You');
});

test('without a stored name the heading is still You, byte for byte as before', () => {
  publishIdentityShellApi();
  install();
  assert.match(headOf(promptComponent()), /^╭─ ✿ You /u);
});

test('a name changed between two paints of the SAME component recomposes: no stale You', () => {
  const shellApi = publishIdentityShellApi();
  install();
  const component = promptComponent();
  assert.match(headOf(component), /^╭─ ✿ You /u, 'nothing stored: You');
  shellApi.setName('Jona');
  assert.match(headOf(component), /^╭─ ✿ Jona /u, 'the name is read per paint, so the memo cannot serve the old head');
  shellApi.setName('Ana');
  assert.match(headOf(component), /^╭─ ✿ Ana /u, 'and a second change follows the same way');
  shellApi.forgetName();
  assert.match(headOf(component), /^╭─ ✿ You /u, 'cleared: You is back on the same component');
});

test('a malformed identity document is no name: the card paints You', () => {
  for (const document of [{ schema: 2, name: 'Jona' }, { schema: 1, name: 42 }, { schema: 1, name: '  ' }, 'Jona', null]) {
    const made = publishIdentityShellApi();
    made.documents.set('odd-worktree', { identity: document });
    install();
    assert.match(headOf(promptComponent()), /^╭─ ✿ You /u, JSON.stringify(document));
    uninstallUserPromptCard();
  }
});

test('with no shell API at all the host\'s own rows come back unchanged', () => {
  delete globalThis[SHELL_API_SLOT];
  install();
  const component = promptComponent();
  assert.deepEqual(component.render(60), nativeRows(component, 60));
});

// ---- S3/S4: the accent frame in both styles, the body untouched ----

const FRAME_CHARS = new Set(['╭', '╮', '╰', '╯', '─', '│', '▎']);

function assertAccentChrome(rows, style) {
  const frame = rows.flatMap((row) => cells(row)).filter((cell) => FRAME_CHARS.has(cell.char));
  assert.ok(frame.length > 0, `${style}: the card draws a frame`);
  for (const cell of frame) {
    assert.equal(cell.code, ROLE_CODE.accent, `${style}: "${cell.char}" is painted in the accent role`);
  }
  const body = rows.flatMap((row) => cells(row)).filter((cell) => cell.code === MARKDOWN_CODE);
  assert.ok(body.length > 0, `${style}: the body keeps the paint its own renderer gave it`);
  assert.equal(
    rows.flatMap((row) => cells(row)).some((cell) => cell.code === USER_MESSAGE_BG_CODE),
    false,
    `${style}: nothing keeps the user message's background`,
  );
}

test('in neon the whole frame and the name wear the accent, and the body keeps its own paint', () => {
  publishShellApi(ACTIVITY_ANSWER);
  const paint = roleTheme();
  install({ seams: { paint } });
  const component = promptComponent();
  const rows = component.render(60);
  assert.match(unpaint(rows[0]), /^╭─ ✿ You /u);
  assertAccentChrome(rows, 'neon');
  const head = cells(rows[0]);
  const mark = head.find((cell) => cell.char === '✿');
  assert.equal(mark.code, ROLE_CODE.accent, 'the mark wears the title role');
  for (const letter of ['Y', 'o', 'u']) {
    const cell = head.find((candidate) => candidate.char === letter);
    assert.equal(cell.code, ROLE_CODE.accent, `"${letter}" of the name wears the accent`);
  }
  assert.equal(paint.roles.includes('text'), false, 'no body row is repainted in the body role');
  assert.equal(paint.roles.some((role) => role.startsWith('bg:userMessage')), false, 'the user message background is never painted');
});

test('in float the whole rail wears the accent too, and the band is the card\'s own', () => {
  publishShellApi(ACTIVITY_ANSWER);
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  const paint = roleTheme();
  install({ seams: { paint } });
  const component = promptComponent();
  const rows = component.render(60);
  // Float pads one blank band row above the heading, so the heading is found, not assumed first.
  assert.ok(rows.some((row) => /^\s*▎ ✿ You /u.test(unpaint(row))), 'the rail style, with the same mark and name');
  assert.match(unpaint(rows[0]), /^\s*▎/u, 'the band opens with the rail');
  assert.doesNotMatch(rows.map(unpaint).join('\n'), /[╭╮╰╯]/u, 'no neon corner survives a float card');
  assertAccentChrome(rows, 'float');
  assert.equal(paint.roles.includes('bg:userMessageBg'), false, 'the user message background is never painted');
  const rails = rows.flatMap((row) => cells(row)).filter((cell) => cell.char === '▎');
  assert.ok(rails.length >= 3, 'the heading, the body and the closing rail are all drawn');
  for (const row of rows) assert.equal(chars(row).length, 60, `"${unpaint(row)}" is 60 wide`);
});

test('a mid-session style flip repaints a prompt already on screen, in both directions', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install({ seams: { paint: bandTheme } });
  const component = promptComponent();
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  const neon = unpaint(component.render(60)[0]);
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  const float = unpaint(component.render(60)[0]);
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  const back = unpaint(component.render(60)[0]);
  assert.match(neon, /^╭─/u);
  assert.match(float, /^\s*▎/u);
  assert.match(back, /^╭─/u);
});

test('the prompt is never capped: every row of a long message is drawn', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const body = Array.from({ length: 12 }, (_unused, index) => `row ${index + 1} of the prompt`);
  const rows = promptComponent(body.join('\n')).render(60).map(unpaint);
  for (const line of body) assert.ok(rows.some((row) => row.includes(line)), `"${line}" is drawn`);
});

// ---- S5: the body is Pi's own Markdown, rebuilt without the background ----

test('the body rows are the child\'s own Markdown rebuilt with no background and no side padding', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const component = promptComponent();
  const original = component.children[0];
  component.render(60);
  assert.equal(StubMarkdown.made.length, 2, 'one clone, built from the child\'s own constructor');
  const clone = StubMarkdown.made[1];
  assert.notEqual(clone, original);
  assert.equal(clone.constructor, original.constructor);
  assert.equal(clone.text, original.text, 'the prompt itself');
  assert.equal(clone.paddingX, 0, 'no side padding: the card frames it');
  assert.equal(clone.paddingY, 0, 'no vertical padding either: the frame is the spacing, as in the file cards');
  assert.equal(clone.theme, original.theme, 'the host\'s own Markdown theme');
  assert.equal(clone.options, original.options, 'the host\'s own options, so markers and transformers keep working');
  assert.equal(clone.defaultTextStyle.bgColor, undefined, 'the user message background is dropped');
  assert.equal(typeof clone.defaultTextStyle.color, 'function', 'the text colour is the body\'s own paint');
});

// ---- prompt-card-mark: the ❯ an extension transformer prepends - ` ❯ ` in pi-pretty ----

/**
 * pi-pretty's own markdown transformer, as the host composes it: the user's markdown comes back
 * prefixed with ` ❯ ` and an empty prompt is left alone (`dist/index.js`: `" ❯ " + markdown`).
 */
const prettyTransform = (markdown) => (markdown.trim() === '' ? markdown : ` ❯ ${markdown}`);

/** A prompt whose Markdown carries the host's composed `transform`, exactly as Pi wires it. */
function decoratedPrompt(text = PROMPT) {
  return new UserMessageComponent(text, {
    markdownOptions: { preserveOrderedListMarkers: true, preserveBackslashEscapes: true, transform: prettyTransform },
  });
}

test('the ❯ an extension transformer prepends is dropped, and the body starts at the frame padding', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const rows = decoratedPrompt().render(60);
  assert.equal(rows.some((row) => unpaint(row).includes('❯')), false, 'no row carries the decoration');
  const body = rows.filter((row) => row.includes('explain the card'));
  assert.equal(body.length, 1, 'the first line is one body row');
  assert.ok(unpaint(body[0]).startsWith('│ explain the card'), `the message starts at the frame padding: ${unpaint(body[0])}`);
  assert.ok(rows.some((row) => unpaint(row).includes('and keep `this` visible')), 'every line of the prompt is still drawn');
  for (const row of rows) assert.equal(chars(row).length, 60, `"${unpaint(row)}" is 60 wide`);
});

test('a prompt with no transformer is drawn byte for byte as before', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const component = promptComponent();
  component.timestamp = '2026-01-02T09:07:00Z';
  const clock = localClock(new Date(component.timestamp));
  // The rows this card drew BEFORE the decoration was removed, pinned: no transformer, no
  // decoration, so the body, the frame and the prompt-zone markers are untouched to the byte.
  const pinned = [
    OSC133_ZONE_START + `╭─ ✿ You · ${clock} ${'─'.repeat(42)}╮`,
    `│ \x1b[${MARKDOWN_CODE}mexplain the card\x1b[39m${' '.repeat(40)} │`,
    `│ \x1b[${MARKDOWN_CODE}mand keep \`this\` visible\x1b[39m${' '.repeat(33)} │`,
    OSC133_ZONE_CLOSE + `╰${'─'.repeat(58)}╯`,
  ];
  assert.deepEqual(component.render(60), pinned);
});

test('a prompt that starts with ❯ keeps exactly one ❯: only the decoration is consumed', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const rows = decoratedPrompt('❯ my own mark\nsecond line').render(60).map(unpaint);
  const body = rows.filter((row) => row.includes('my own mark'));
  assert.equal(body.length, 1, 'the user\'s line is one body row');
  assert.ok(body[0].startsWith('│ ❯ my own mark'), `the user\'s own mark stays at the frame padding: ${body[0]}`);
  assert.equal(body[0].split('❯').length - 1, 1, 'exactly one ❯: the decoration, never the user\'s own');
});

test('the body re-wraps at the full inner width: the decoration costs no columns', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  // Exactly the inner width of a 60-column card (`cardInnerWidth(60)`): one body row undecorated,
  // and one row plus a mark-only row when the three decoration columns still eat the line.
  const line = 'x'.repeat(56);
  const rows = decoratedPrompt(line).render(60);
  assert.equal(rows.length, 3, 'the frame and ONE body row: the 56 columns fit');
  assert.ok(rows[1].includes(line), 'the whole line is on its one row, with no three-column slack');
  assert.equal(chars(rows[1]).length, 60, 'and the row still fills the frame');
});

test('a steady frame rebuilds nothing, and a width change or a style flip redraws', () => {
  publishShellApi(ACTIVITY_ANSWER);
  const counting = countingMetrics();
  const countingPaint = { fg: (_role, value) => value, bg: (_role, value) => `\x1b[48;5;240m${value}\x1b[49m` };
  install({ seams: { counting: counting.metrics, paint: countingPaint } });
  const component = promptComponent();
  component.render(60);
  const first = { ...counting.counts };
  assert.ok(first.wrapTextWithAnsi > 0, 'the first frame measures the body');
  component.render(60);
  assert.deepEqual(counting.counts, first, 'a steady frame costs no measurement at all');
  component.render(62);
  assert.ok(counting.counts.wrapTextWithAnsi > first.wrapTextWithAnsi, 'a new width is drawn');
  const beforeStyle = counting.counts.wrapTextWithAnsi;
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  const rows = component.render(62);
  assert.ok(counting.counts.wrapTextWithAnsi > beforeStyle, 'a style flip is drawn again, never served from the memo');
  assert.match(unpaint(rows[0]), /^\s*▎/u);
});

test('the card carries Pi\'s prompt-zone markers on its own first and last row, exactly once', () => {
  const shellApi = publishShellApi(ACTIVITY_ANSWER);
  install();
  const component = promptComponent();
  const rows = component.render(60);
  assert.ok(rows[0].startsWith(OSC133_ZONE_START), 'the prompt zone starts where the card starts');
  // Pi's ORDER, byte for byte: the zone-end marker and then the final one, PREFIXED on the last
  // row (`OSC133_ZONE_END + OSC133_ZONE_FINAL + last`), never appended after it.
  assert.ok(rows.at(-1).startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL), 'end then final, before the last row');
  assert.equal(rows.at(-1).endsWith(OSC133_ZONE_CLOSE), false, 'the close markers are not appended after the row');
  const joined = rows.join('\n');
  assert.equal(joined.split(OSC133_ZONE_START).length - 1, 1, 'one start marker, never two');
  assert.equal(joined.split(OSC133_ZONE_CLOSE).length - 1, 1, 'one end marker, never two');
  for (const row of rows.slice(1, -1)) {
    assert.equal(row.includes(OSC133_ZONE_START) || row.includes(OSC133_ZONE_CLOSE), false, 'no body row carries one');
  }
  assert.equal(chars(rows[0]).length, 60, 'the marker is zero width: the frame still fits exactly');
  // A repaint against the same markers adds no second copy.
  const again = component.render(60);
  assert.equal(again[0].split(OSC133_ZONE_START).length - 1, 1, 'a repaint writes the marker once');
  // The native path is the host's own output, marker for marker, never a card row.
  setCardMessage(shellApi, false);
  const native = component.render(60);
  assert.deepEqual(native, NATIVE_RENDER.call(component, 60), 'byte for byte, markers included');
  assert.ok(native[0].startsWith(OSC133_ZONE_START) && native.at(-1).startsWith(OSC133_ZONE_CLOSE));
  assert.equal(native.length, 2, 'the host\'s two rows, with no frame around them');
});

// ---- the rows the terminal pays for ----

test('the card pays for the frame only: the clone adds no vertical padding row', () => {
  // The FRAME is the spacing. `lib/file-card-markdown.js` builds its document body with
  // `new Renderer(source, 0, 0, …)` and `lib/message-card.js` hands the substrate plain rows, so
  // no card body carries Markdown's own vertical padding: a prompt of N lines is N body rows,
  // and a blank row the clone put there is a row the terminal pays for with nothing in it.
  publishShellApi(ACTIVITY_ANSWER);
  install({ seams: { paint: bandTheme } });
  // The frame's own rows: neon is the heading and the closing rule; float adds the two padding
  // rows of its band above the heading and between the heading and the body.
  for (const [style, frame] of [[CARD_STYLE.NEON, 2], [CARD_STYLE.FLOAT, 4]]) {
    globalThis[CARD_STYLE_SLOT] = style;
    for (const [lines, text] of [[1, 'one line'], [2, 'one line\ntwo lines']]) {
      const rows = promptComponent(text).render(60).map(unpaint);
      for (const row of rows) assert.equal(chars(row).length, 60, `${style}: "${row}" is 60 wide`);
      assert.equal(rows.length, frame + lines, `${style}: ${lines} line(s) are exactly the frame's ${frame} rows plus ${lines} body rows`);
      // And the body is exactly those lines, in order: no blank row the clone put there.
      const body = rows.filter((row) => row.includes('line'));
      assert.equal(body.length, lines, `${style}: ${lines} painted line(s)`);
      for (let index = 1; index < body.length; index += 1) {
        assert.ok(body[index].indexOf('line') > 0, `${style}: body line ${index + 1} is drawn`);
      }
    }
  }
});

// ---- the memo: a style at the same inner width still recomposes ----

test('float at the width whose inner equals a neon draw recomposes, with no outline inside the band', () => {
  // Neon at 60 composes at inner 60; float at 62 composes at inner 60 too (it gives two columns
  // to its margins). The chrome is decided by the requested width and the style, not by the
  // inner width alone, so the memo may not serve the neon parts to the float draw.
  publishShellApi(ACTIVITY_ANSWER);
  install({ seams: { paint: bandTheme } });
  const component = promptComponent();
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  const neon = component.render(60);
  assert.ok(neon.some((row) => unpaint(row).includes('╭')), 'the neon card drew the rounded frame');
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  const float = component.render(62);
  // A fresh component has no memo at all: that is exactly what the same instance must match.
  const fresh = promptComponent().render(62);
  assert.deepEqual(float, fresh, 'float at 62 is drawn, not served the neon parts');
  for (const row of float) {
    assert.doesNotMatch(unpaint(row), /[╭╮╰╯]/u, `no rounded glyph inside the float band: ${unpaint(row)}`);
  }
  assert.match(unpaint(float[0]), /^\s*▎/u, 'the float band still opens with its rail');
  assert.equal(chars(float[0]).length, 62, 'and it is still exactly 62 columns wide');
});

// ---- D4: the body follows the live theme, not the one it was cloned under ----

test('a theme switch repaints a mounted prompt body, never the theme it was cloned under', () => {
  // Pi's MarkdownTheme is captured when the child is built, so a clone that outlives a theme
  // switch keeps painting the old colours while a freshly built prompt is already new. The
  // clone memo is therefore keyed on the theme used for THIS paint and rebuilds the clone when
  // it differs (the card's paint is live: the theme instance behind Pi's slot changes).
  publishShellApi(ACTIVITY_ANSWER);
  const CODE_A = MARKDOWN_CODE;
  const CODE_B = '94';
  const themeA = { fg: (_role, text) => text, bg: (_role, text) => `\x1b[48;5;236m${text}\x1b[49m` };
  const themeB = { fg: (_role, text) => text, bg: (_role, text) => `\x1b[48;5;237m${text}\x1b[49m` };
  let live = themeA;
  install({ seams: { theme: () => live } });
  const mounted = promptComponent();
  const first = mounted.render(60);
  assert.ok(first.some((row) => cells(row).some((cell) => cell.code === CODE_A)), 'the first paint is theme A\'s body');
  // The host switches its theme: a fresh prompt is built under B, and the mounted one must follow.
  StubMarkdown.code = CODE_B;
  live = themeB;
  const second = mounted.render(60);
  const fresh = promptComponent().render(60);
  assert.deepEqual(second, fresh, 'the mounted prompt paints exactly like one built under the new theme');
  for (const row of second) {
    assert.equal(cells(row).some((cell) => cell.code === CODE_A), false, `no cell keeps the old theme: ${unpaint(row)}`);
  }
  assert.ok(second.some((row) => cells(row).some((cell) => cell.code === CODE_B)), 'the new theme paints the body');
});

// ---- D5: a deferred install may not patch a class after its session ended ----

/**
 * Load THIS extension (the same stubbing `tools/fixtures/load-extension.js` does) and hand back
 * its own module namespace, because the deferred install's seam lives there: a test must be able
 * to make Pi's package resolve LATE, after the session ended. The shell API is published before the
 * factory runs, exactly as the fixture does, so the activity design registers.
 */
async function loadExtensionModule(loader, events = {}, options = {}) {
  process.env.GENTLE_WORKTREE_LIB_DIR = fixture.LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-worktree-upc-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, fixture.stubbedSource());
    const namespace = await import(pathToFileURL(copy).href);
    if (typeof namespace.setUserPromptCardHostLoader !== 'function') {
      throw new Error('the extension exposes no seam for the deferred prompt-card install');
    }
    const hooks = [];
    const host = {
      registerCommand() {},
      registerTool() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      appendEntry() {},
      on: (event, handler) => hooks.push([event, handler]),
      // The host's event bus, when a test needs the shell API's ready announcement (`pi.events`).
      events,
    };
    // A host SHAPE a test needs: an `on` that accepts some events and refuses others, or none at
    // all (`null`), which is how a host that cannot own a teardown is modelled.
    if (options.on !== undefined) {
      if (options.on === null) delete host.on;
      else host.on = options.on;
    }
    namespace.setUserPromptCardHostLoader(loader);
    namespace.default(host);
    return { namespace, hooks };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every hook the extension registered for one event, emitted the way the host would. */
const extensionSession = (hooks) => (event) => Promise.all(hooks.filter(([name]) => name === event).map(([, handler]) => handler({}, {})));

const drain = () => new Promise((resolve) => setImmediate(resolve));

test('an install whose import resolves after shutdown patches nothing', async () => {
  // `installUserPromptCard()` awaits a dynamic import; a session that ends inside that window
  // must not be patched afterwards, or the prototype stays wrapped into the next session.
  const shellApi = fixture.defaultShellApi();
  const previousShellApi = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = shellApi.api;
  class LateHost {
    render(width) {
      return [`native ${width}`];
    }
  }
  const native = LateHost.prototype.render;
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve({ UserMessageComponent: LateHost });
  });
  try {
    const { hooks } = await loadExtensionModule(() => gate);
    const emit = extensionSession(hooks);
    const shutdowns = hooks.filter(([event]) => event === 'session_shutdown').map(([, handler]) => handler);
    assert.ok(shutdowns.length > 0, 'the session boundary is registered');
    await emit('session_start');
    await drain();
    assert.equal(LateHost.prototype.render, native, 'nothing is patched while the import is pending');
    // The session ends BEFORE Pi's package resolves.
    for (const handler of shutdowns) await handler({}, {});
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(LateHost.prototype.render, native, 'a late install patches nothing after shutdown');
  } finally {
    if (previousShellApi === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previousShellApi;
  }
});

// ---- S7: the install lifecycle survives the epoch it belongs to ----

test('S7: a pending install from a closed session cannot suppress the next install', async () => {
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  class Host {
    render() {
      return ['native'];
    }
  }
  const native = Host.prototype.render;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { hooks } = await loadExtensionModule(() => (++calls === 1 ? pending : { UserMessageComponent: Host }));
  const emit = extensionSession(hooks);
  try {
    await emit('session_start');
    await drain();
    assert.equal(calls, 1, 'the session start armed one import');
    await emit('session_shutdown');
    await emit('session_start');
    release({ UserMessageComponent: Host });
    await drain();
    assert.equal(calls, 2, 'the new session drives its OWN install, not the closed one\'s');
    assert.notEqual(Host.prototype.render, native, 'the new session is patched');
  } finally {
    await emit('session_shutdown');
  }
});

test('S7: shell API readiness after shutdown cannot arm a host import', async () => {
  delete globalThis[SHELL_API_SLOT];
  class Host {
    render() {
      return ['native'];
    }
  }
  const native = Host.prototype.render;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const listeners = new Map();
  const { hooks } = await loadExtensionModule(() => pending, {
    on: (event, handler) => listeners.set(event, handler),
  });
  for (const [event, handler] of [...hooks]) {
    if (event === 'session_shutdown') await handler({}, {});
  }
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  listeners.get('odd-worktree:shell-ready')?.();
  release({ UserMessageComponent: Host });
  await drain();
  assert.equal(Host.prototype.render, native);
});

test('S7: factory load does not arm a host import before session_start', async () => {
  // Pi loads the factory before any session exists, and caches it across sessions. A load may
  // neither arm the host import nor patch the class until a `session_start` opens the session
  // that owns the card.
  const previousShellApi = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  class Host {
    render() {
      return ['native'];
    }
  }
  const native = Host.prototype.render;
  let calls = 0;
  const { hooks } = await loadExtensionModule(() => {
    calls += 1;
    return { UserMessageComponent: Host };
  });
  const emit = extensionSession(hooks);
  try {
    // A macrotask: every microtask of the load has run by now.
    await drain();
    assert.equal(calls, 0, 'no loader call before a session exists');
    assert.equal(Host.prototype.render, native, 'and an untouched prototype');
    await emit('session_start');
    await drain();
    assert.equal(calls, 1, 'the first session drives exactly one install');
    assert.notEqual(Host.prototype.render, native, 'and the class is patched then');
    await emit('session_shutdown');
    assert.equal(Host.prototype.render, native, 'and its shutdown restores it');
  } finally {
    await emit('session_shutdown');
    if (previousShellApi === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previousShellApi;
  }
});

test('S7 (T2): with no shell API on the slot nothing is registered, and a silent publication never arms an install', async () => {
  // The gate observer is gone (native-shell API T2): the shell API publishes at module load, the
  // factory reads the slot ONCE, and a load that found it empty keeps no observer to be woken by.
  // What S7 still guarantees is the other half: a load that DID find the shell API owns the shutdown
  // that unwraps the card, which is what the first test above proves.
  const previousShellApi = globalThis[SHELL_API_SLOT];
  delete globalThis[SHELL_API_SLOT];
  class Host {
    render() {
      return ['native'];
    }
  }
  const native = Host.prototype.render;
  const { hooks } = await loadExtensionModule(() => ({ UserMessageComponent: Host }));
  const emit = extensionSession(hooks);
  try {
    assert.deepEqual(hooks, [], 'a load with no shell API registers no hook at all');
    // A SILENT publication: nothing announces it, and nothing is listening for it either.
    globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
    await emit('session_start');
    await drain();
    assert.equal(Host.prototype.render, native, 'nothing installs: no session boundary was owned');
  } finally {
    await emit('session_shutdown');
    if (previousShellApi === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previousShellApi;
  }
});

// ---- S7: owning the teardown is a precondition of installing ----

test('S7: a host that refuses the shutdown hook owns no patch', async () => {
  // Owning a teardown is a PRECONDITION of installing (fail closed). A host that accepts
  // `session_start` and refuses `session_shutdown` would otherwise leave the card installed with
  // nobody to unwrap it, so it gets no patch at all: its prompt stays Pi's own.
  const previousShellApi = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  class Host {
    render() {
      return ['native'];
    }
  }
  const native = Host.prototype.render;
  let calls = 0;
  const accepted = [];
  try {
    await loadExtensionModule(
      () => {
        calls += 1;
        return { UserMessageComponent: Host };
      },
      {},
      {
        on: (event, handler) => {
          // The start hook is accepted; the shutdown hook is refused.
          if (event === 'session_shutdown') throw new Error('this host refuses the shutdown hook');
          accepted.push([event, handler]);
        },
      },
    );
    await drain();
    assert.equal(calls, 0, 'the loader is never called: no teardown, no patch');
    assert.equal(Host.prototype.render, native, 'and the prototype is never patched');
    // A session that starts anyway cannot open a session this load does not own.
    for (const [event, handler] of accepted) {
      if (event === 'session_start') await handler({}, {});
    }
    await drain();
    assert.equal(calls, 0, 'no session start arms an unowned install');
    assert.equal(Host.prototype.render, native, 'and the class stays Pi\'s own');
  } finally {
    if (previousShellApi === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previousShellApi;
  }
});

test('S7: a host with no session hooks owns no patch either', async () => {
  const previousShellApi = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = fixture.defaultShellApi().api;
  class Host {
    render() {
      return ['native'];
    }
  }
  const native = Host.prototype.render;
  let calls = 0;
  try {
    await loadExtensionModule(
      () => {
        calls += 1;
        return { UserMessageComponent: Host };
      },
      {},
      { on: null },
    );
    await drain();
    assert.equal(calls, 0, 'a host with no `on` owns no teardown, so the loader is never called');
    assert.equal(Host.prototype.render, native, 'and the prototype stays untouched');
  } finally {
    if (previousShellApi === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previousShellApi;
  }
});

// ---- S5/S6: one wrapper per process, torn down on demand ----

test('installing twice wraps once, and uninstall restores the original render byte for byte', () => {
  publishShellApi(ACTIVITY_ANSWER);
  const first = install();
  assert.equal(first.installed, true);
  const wrapped = UserMessageComponent.prototype.render;
  assert.notEqual(wrapped, NATIVE_RENDER);
  const second = install();
  assert.equal(second.installed, true);
  assert.equal(UserMessageComponent.prototype.render, wrapped, 'a second install adds no second layer');
  const component = promptComponent();
  assert.match(unpaint(component.render(60)[0]), /^╭─ ✿ You /u, 'the card is still drawn through one wrapper');
  // The wrapper always calls the MOST RECENTLY installed logic, which is what a `/reload`
  // relies on: a second install with its own seams paints with those seams, not with the first.
  install({ seams: { paint: taggedTheme } });
  assert.ok(component.render(60)[0].includes('<accent>✿ You</accent>'), 'the newest logic paints');
  uninstallUserPromptCard();
  assert.equal(UserMessageComponent.prototype.render, NATIVE_RENDER, 'the original function is back');
  const fresh = promptComponent();
  assert.deepEqual(fresh.render(60), nativeRows(fresh, 60));
});

test('a class without render, an absent class and a component with no Markdown install and answer native', () => {
  publishShellApi(ACTIVITY_ANSWER);
  const refused = installUserPromptCard({});
  assert.equal(refused.installed, false);
  assert.equal(typeof refused.uninstall, 'function', 'a refused install still answers an inert uninstall');
  assert.equal(installUserPromptCard({ component: class Empty {} }).installed, false);
  assert.equal(installUserPromptCard({ component: 42 }).installed, false);
  assert.equal(UserMessageComponent.prototype.render, NATIVE_RENDER, 'nothing was wrapped for a class that cannot draw');
  const shapes = [
    ['no children at all', () => new UserMessageComponent(PROMPT, { children: null })],
    ['an empty child list', () => new UserMessageComponent(PROMPT, { children: [] })],
    ['a child that is not an object', () => new UserMessageComponent(PROMPT, { children: ['markdown'] })],
    ['a non-numeric paddingX', () => new UserMessageComponent(PROMPT, { paddingX: '1' })],
    ['no Markdown theme', () => new UserMessageComponent(PROMPT, { markdownTheme: null })],
  ];
  install();
  for (const [name, build] of shapes) {
    const component = build();
    assert.deepEqual(component.render(60), nativeRows(component, 60), name);
  }
  // A child whose constructor is not a function, and one that is no Markdown at all.
  const constructorless = promptComponent();
  constructorless.children[0].constructor = undefined;
  assert.deepEqual(constructorless.render(60), nativeRows(constructorless, 60), 'constructor not a function');
  const plain = promptComponent();
  plain.children[0] = { text: PROMPT, paddingX: 1, theme: {} };
  assert.deepEqual(plain.render(60), nativeRows(plain, 60), 'a plain object is no Markdown');
});

test('a body the card cannot read answers native: no row, an answer that is not rows, a renderer that throws', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  for (const [name, text] of [['a body that draws no row', 'EMPTY_BODY'], ['an answer that is not rows', 'NOT_ROWS'], ['a renderer that throws', 'THROW']]) {
    const component = promptComponent(text);
    assert.deepEqual(component.render(60), nativeRows(component, 60), name);
  }
});

test('a metrics or theme seam that throws, or answers nothing usable, answers native too', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install({
    seams: {
      metrics: () => { throw new Error('no tui package'); },
      theme: () => { throw new Error('no theme'); },
    },
  });
  const component = promptComponent();
  assert.deepEqual(component.render(60), nativeRows(component, 60), 'both seams throw');
  uninstallUserPromptCard();
  install({ seams: { metrics: () => ({}), theme: () => ({}) } });
  assert.deepEqual(promptComponent().render(60), nativeRows(promptComponent(), 60), 'a metrics object that cannot measure');
  uninstallUserPromptCard();
  install({ seams: { metrics: () => undefined, theme: () => undefined } });
  assert.deepEqual(promptComponent().render(60), nativeRows(promptComponent(), 60), 'seams that answer nothing');
  uninstallUserPromptCard();
  const hostile = { fg: () => { throw new Error('boom'); }, bg: () => { throw new Error('boom'); } };
  install({ seams: { paint: hostile } });
  assert.deepEqual(promptComponent().render(60), nativeRows(promptComponent(), 60), 'a theme that throws');
});

test('an empty prompt draws no card: the host\'s own nothing comes back', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const component = new UserMessageComponent(PROMPT, { empty: true });
  assert.deepEqual(component.render(60), []);
});

// ---- S1 (prompt-card-fix): the heading's clock, in grey beside the name ----

/** Local 24-hour `HH:MM`, zero padded: the clock the heading is expected to carry. */
const localClock = (instant) => `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;

/** The `HH:MM` a heading row draws after its separator, read from the row's own cells. */
function headingClock(row) {
  const line = cells(row);
  const dot = line.findIndex((cell) => cell.char === '·');
  if (dot < 0) return undefined;
  return line.slice(dot + 2, dot + 7).map((cell) => cell.char).join('');
}

test('S1: a component with a timestamp heads ✿ You · <local HH:MM>, and the clock is muted', () => {
  publishShellApi(ACTIVITY_ANSWER);
  const paint = roleTheme();
  install({ seams: { paint } });
  // The instant the host sets on a prompt rebuilt from a session entry: an ISO string in UTC.
  const at = '2026-11-23T19:12:59Z';
  const expected = localClock(new Date(at));
  const component = promptComponent();
  component.timestamp = at;
  const rows = component.render(60);
  const head = unpaint(rows[0]);
  assert.match(head, /^╭─ ✿ You · \d{2}:\d{2} /u, 'the name, the separator and the clock, on the frame');
  assert.ok(head.includes(`✿ You · ${expected}`), `the clock is the local HH:MM of that instant: ${expected}`);
  assert.equal(headingClock(rows[0]), expected, 'five clock columns, zero padded, no seconds');
  // The role actually painted on the separator and on each clock column.
  const line = cells(rows[0]);
  const dot = line.findIndex((cell) => cell.char === '·');
  assert.equal(line[dot].code, ROLE_CODE.muted, 'the separator wears the muted role');
  for (const cell of line.slice(dot + 2, dot + 7)) {
    assert.equal(cell.code, ROLE_CODE.muted, `"${cell.char}" of the clock is painted muted`);
  }
  const mark = line.find((cell) => cell.char === '✿');
  assert.equal(mark.code, ROLE_CODE.accent, 'the mark still wears the accent with the name');
});

test('S1: without a timestamp the first-paint clock is used, unchanged on every later paint', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install();
  const realNow = Date.now;
  try {
    Date.now = () => new Date(2026, 0, 2, 9, 7, 30).getTime();
    const component = promptComponent();
    const first = unpaint(component.render(60)[0]);
    assert.ok(first.includes('✿ You · 09:07'), `the clock of the first paint: ${first}`);
    // The clock moves on: a later frame keeps the arrival time, it never drifts.
    Date.now = () => new Date(2026, 0, 2, 17, 45, 0).getTime();
    const later = unpaint(component.render(60)[0]);
    assert.equal(later, first, 'a later paint is the same heading, to the cell');
    // A component built now has its OWN arrival time, captured on its own first paint.
    const other = promptComponent();
    assert.ok(unpaint(other.render(60)[0]).includes('✿ You · 17:45'), 'each prompt keeps its own first-paint clock');
    assert.ok(unpaint(other.render(60)[0]).includes('✿ You · 17:45'), 'and it holds on the next paint too');
  } finally {
    Date.now = realNow;
  }
});

test('S1: a component with neither a timestamp nor a clock shows ✿ You alone, inventing nothing', () => {
  publishShellApi(ACTIVITY_ANSWER);
  install({ seams: { paint: taggedTheme } });
  const realNow = Date.now;
  try {
    // No clock to read at all, and nothing on the component: the heading is the name.
    Date.now = () => Number.NaN;
    const component = promptComponent();
    const head = component.render(60)[0];
    assert.ok(head.includes('<accent>✿ You</accent>'), 'the mark and the name wear the title role together');
    const plain = unpaint(head);
    assert.match(plain, /^╭─ ✿ You /u, 'the heading is the name alone');
    assert.equal(plain.includes('·'), false, 'no subtitle separator');
    assert.doesNotMatch(plain, /\d{1,2}:\d{2}|ago/u, 'no time is invented');
    // A timestamp nothing can read is no clock either: still nothing invented.
    const unreadable = promptComponent();
    unreadable.timestamp = 'yesterday';
    assert.equal(unpaint(unreadable.render(60)[0]).includes('·'), false, 'an unreadable timestamp invents no clock');
  } finally {
    Date.now = realNow;
  }
});

// ---- S2 (prompt-card-fix): a restored session repaints — once per install ----

/**
 * The shell API a repaint assertion needs: the published object every surface here reads, with a
 * `requestRepaint` recorder and the gate's own reader. `extra` replaces a member per case.
 */
function repaintShellApi(extra = {}) {
  const api = fixture.defaultShellApi().api;
  const state = { repaints: 0 };
  api.requestRepaint = () => {
    state.repaints += 1;
  };
  api.resolveToolDesignSelection = () => ACTIVITY_ANSWER;
  Object.assign(api, extra);
  return { api, state };
}

/**
 * Load this extension with one published shell API and drive the session that owns the deferred
 * install — the only path that knows a session is live. Answers the host class and the hooks, so
 * a test can watch the prototype and a paint.
 */
async function loadPromptCardSession(shellApi) {
  const previous = globalThis[SHELL_API_SLOT];
  globalThis[SHELL_API_SLOT] = shellApi;
  class Host {
    render(width) {
      return [`native ${width}`];
    }
  }
  const native = Host.prototype.render;
  const { hooks } = await loadExtensionModule(() => ({ UserMessageComponent: Host }));
  const emit = extensionSession(hooks);
  const shutdown = async () => {
    await emit('session_shutdown');
    if (previous === undefined) delete globalThis[SHELL_API_SLOT];
    else globalThis[SHELL_API_SLOT] = previous;
  };
  return { Host, native, emit, shutdown };
}

test('S2: a successful install asks the shell API for exactly one repaint, and no paint asks again', async () => {
  const shellApi = repaintShellApi();
  const session = await loadPromptCardSession(shellApi.api);
  try {
    await session.emit('session_start');
    await drain();
    assert.notEqual(session.Host.prototype.render, session.native, 'the class is patched by the live session');
    assert.equal(shellApi.state.repaints, 1, 'the restored transcript is asked to repaint once');
    // Painting is what the request produced: it never asks for another repaint itself.
    const component = new session.Host();
    component.render(60);
    component.render(62);
    assert.equal(shellApi.state.repaints, 1, 'a paint requests none, and a steady frame neither');
    // A second `session_start` is a re-install: it asks again, exactly once.
    await session.emit('session_start');
    await drain();
    assert.equal(shellApi.state.repaints, 2, 'the re-install path asks for its own single repaint');
  } finally {
    await session.shutdown();
  }
});

test('S2: an install the gate never armed, and a shell API with no requestRepaint, ask for none', async () => {
  // (a) The shell API refuses the design registration, so the install was never armed: no request.
  const refused = repaintShellApi({
    registerToolDesign: () => {
      throw new Error('this shell API refuses the activity design');
    },
  });
  const ungated = await loadPromptCardSession(refused.api);
  try {
    await ungated.emit('session_start');
    await drain();
    assert.equal(ungated.Host.prototype.render, ungated.native, 'nothing was installed for a gated line');
    assert.equal(refused.state.repaints, 0, 'an install that never happened asks for nothing');
  } finally {
    await ungated.shutdown();
  }
  // (b) The member is optional: the install succeeds and no member is there to call.
  const absent = repaintShellApi({});
  delete absent.api.requestRepaint;
  const memberless = await loadPromptCardSession(absent.api);
  try {
    assert.equal('requestRepaint' in absent.api, false, 'the published shell API carries no such member');
    await memberless.emit('session_start');
    await drain();
    assert.notEqual(memberless.Host.prototype.render, memberless.native, 'the install still happened');
    assert.equal(absent.state.repaints, 0, 'and nothing was asked for');
  } finally {
    await memberless.shutdown();
  }
});

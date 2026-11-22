'use strict';
// S10: the CodeGraph card, drawn on this package's own card substrate
// (lib/shell-card.js) through the host's `registerToolRenderer` resolver.
//
// Every case goes through the module's public surface: the pure row builders
// (`codegraphCallRows`, `codegraphResultRows`, `codegraphShape`) and the resolver
// `createCodegraphCardResolver` hands back, read as the lines a component draws
// for a width. Nothing reads module-internal state, a repository, an index or a
// terminal, and no case spawns anything.
//
// The text seam and the themes are the fakes tools/worktree-cards.test.js uses:
// this package has no node_modules, so width measurement, truncation and
// wrapping are injected, and colour only ever arrives as `theme.fg(role, text)`.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const { LIB_DIR, defaultBridge, stubbedSource } = require('./fixtures/load-extension.js');

const {
  CARD_CONTENT,
  CODEGRAPH_MARK,
  CODEGRAPH_MCP_TOOL,
  CODEGRAPH_TITLE_ROLE,
  CODEGRAPH_TOOL,
  cardContentLevel,
  codegraphCallRows,
  codegraphResultRows,
  codegraphShape,
  createCodegraphCardResolver,
  isCodeGraphCardTool,
} = require('../lib/codegraph-card.js');
const { CARD_STYLE } = require('../lib/card-style.js');
const {
  EXPLORE,
  INIT_EXISTING,
  INIT_FAILED,
  INIT_FRESH,
  QUERY,
  SYNC_CHANGED,
} = require('./fixtures/card-codegraph-outputs.js');

const MCP_PREFIXED_TOOL = 'mcp__codegraph__codegraph_explore';

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

// ---- themes: a theme is an injected fg(role, text) ----

const plainTheme = {
  fg(_role, value) {
    return value;
  },
};

/** A theme that can also paint the float background, so the text stays readable. */
function paintTheme() {
  const roles = { fg: [], bg: [] };
  return {
    roles,
    fg(role, value) {
      roles.fg.push(role);
      return value;
    },
    bg(role, value) {
      roles.bg.push(role);
      return `\x1b[48;5;240m${value}\x1b[49m`;
    },
  };
}

const taggedTheme = {
  fg(role, value) {
    return `<${role}>${value}</${role}>`;
  },
};

function recordingTheme() {
  const roles = [];
  return {
    roles,
    fg(role, value) {
      roles.push(role);
      return value;
    },
  };
}

/** A theme that names every role it paints and can paint the float background, so a cell's role is readable. */
function railTheme() {
  const roles = { fg: [], bg: [] };
  return {
    roles,
    fg(role, value) {
      roles.fg.push(role);
      return `<${role}>${value}</${role}>`;
    },
    bg(role, value) {
      roles.bg.push(role);
      return `\x1b[48;5;240m${value}\x1b[49m`;
    },
  };
}

// S10: the style seam — the process-wide slot Gentle Shell publishes — and a
// scratch preference home, so no case reads or writes the real user's document.
const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');
const CARD_CONTENT_SLOT = Symbol.for('gentle-pi.card-content');

const savedHome = process.env.GENTLE_PI_CONFIG_HOME;
let configHome;

before(() => {
  configHome = mkdtempSync(join(tmpdir(), 'odd-worktree-codegraph-card-'));
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
});

after(() => {
  delete globalThis[CARD_STYLE_SLOT];
  delete globalThis[CARD_CONTENT_SLOT];
  if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
  rmSync(configHome, { recursive: true, force: true });
});

function withContent(content, run) {
  if (content === undefined) delete globalThis[CARD_CONTENT_SLOT];
  else globalThis[CARD_CONTENT_SLOT] = content;
  try {
    return run();
  } finally {
    delete globalThis[CARD_CONTENT_SLOT];
  }
}

// ---- the switch: the bridge's `Card tags` line (S11) ----

// S11 (modular-tools): the card is a DESIGN, so it paints only while the bridge's `Card tags` line
// answers with this package's activity design. The slot is published here exactly as the host
// publishes it; `selection` is an answer or a function of the tool being drawn, and `asked`
// collects every question.
const BRIDGE_API_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const ACTIVITY_DESIGN_ID = 'odd-worktree.bash-activity';

function publishBridge(selection, asked = []) {
  globalThis[BRIDGE_API_SLOT] = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    VERSION: '0.12.1',
    resolveToolDesignSelection(tool) {
      asked.push(tool);
      return typeof selection === 'function' ? selection(tool) : selection;
    },
  };
  return asked;
}

/** Every tool the card paints wears the activity design: the switch is ON. */
const ACTIVITY_ON = (tool) => (isCodeGraphCardTool(tool) || tool === 'bash' ? { kind: 'design', design: { id: ACTIVITY_DESIGN_ID } } : { kind: 'not-covered', id: ACTIVITY_DESIGN_ID });
publishBridge(ACTIVITY_ON);
after(() => {
  delete globalThis[BRIDGE_API_SLOT];
});

// ---- the resolver under test ----

/** No hook at all would be the host's own: every case here registers through the probe. */
function cardFor(options) {
  const registered = [];
  const cards = createCodegraphCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: (resolver) => registered.push(resolver),
    ...options,
  });
  assert.equal(cards.registered, true, 'the probe accepted the resolver');
  assert.equal(registered.length, 1, 'exactly one resolver reached the host hook');
  return registered[0];
}

/** A host that draws bash itself: its renderers draw nothing here, which is all a forwarded row needs to be. */
const HOST_BASH = {
  renderShell: 'self',
  renderCall: () => ({ render: () => [], invalidate() {} }),
  renderResult: () => ({ render: () => [], invalidate() {} }),
};

/** One tool row as the host drives it: the resolver, then the slot it returned. */
function renderersFor(resolver, toolName, inherited) {
  return resolver(toolName, () => (inherited === undefined && toolName === 'bash' ? HOST_BASH : inherited));
}

function callRows(resolver, toolName, args, theme, context, width) {
  const slot = renderersFor(resolver, toolName);
  assert.equal(typeof slot.renderCall, 'function', `${toolName} renders its call`);
  return slot.renderCall(args, theme, context ?? {}).render(width);
}

function resultRows(resolver, toolName, result, options, theme, context, width) {
  const slot = renderersFor(resolver, toolName);
  assert.equal(typeof slot.renderResult, 'function', `${toolName} renders its result`);
  return slot.renderResult(result, options, theme, context ?? {}).render(width);
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], details: {}, ...(isError ? { isError: true } : {}) };
}

/** The text a cell draws, with both the ANSI a real theme paints and the tags the fake theme wraps it in removed. */
const unpaint = (value) => stripAnsi(value).replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, '');

/** The visible content of a body row, without the neon frame. */
const bodyText = (row) => unpaint(row).replace(/^│ /, '').replace(/ +│$/, '');

/** Every row the card draws must be exactly the width the host asked for. */
function assertFramed(rows, width) {
  for (const row of rows) assert.equal(metrics.visibleWidth(unpaint(row)), width, `"${unpaint(row)}" is not ${width} wide`);
}


// ---- the identity ----

test('the native tool, the MCP explore tool and a bash call are one card', () => {
  assert.equal(CODEGRAPH_TOOL, 'codegraph');
  assert.equal(CODEGRAPH_MCP_TOOL, 'codegraph_explore');
  assert.equal(CODEGRAPH_MARK, '\u{F01BC}');
  assert.equal(CODEGRAPH_TITLE_ROLE, 'mdCode');

  assert.deepEqual(codegraphShape(CODEGRAPH_TOOL, { operation: 'explore', query: 'auth login' }), {
    surface: 'tool',
    operation: 'explore',
    query: 'auth login',
  });
  // The MCP tool arrives under its bare name or the prefixed form the host reports.
  for (const name of [CODEGRAPH_MCP_TOOL, MCP_PREFIXED_TOOL]) {
    assert.deepEqual(codegraphShape(name, { query: 'auth login', maxFiles: 5 }), {
      surface: 'mcp',
      operation: 'explore',
      query: 'auth login',
    });
  }
  assert.deepEqual(codegraphShape('bash', { command: 'codegraph explore --path /tmp/ws -- auth login' }), {
    surface: 'bash',
    command: 'codegraph explore --path /tmp/ws -- auth login',
    operation: 'explore',
    query: 'auth login',
  });

  // The same call heads the same way whatever surface it came from: one program, one
  // card. The two tools name the operation; the bash card names the command it ran.
  const native = codegraphShape(CODEGRAPH_TOOL, { operation: 'explore', query: 'auth login' });
  const mcp = codegraphShape(MCP_PREFIXED_TOOL, { query: 'auth login' });
  const shell = codegraphShape('bash', { command: 'cd /tmp/ws && codegraph explore -- auth login' });
  assert.deepEqual(codegraphCallRows(native), codegraphCallRows(mcp));
  assert.equal(codegraphCallRows(shell)[0].text, codegraphCallRows(native)[0].text, 'one mark and one name');
  assert.deepEqual(codegraphCallRows(native), [
    { text: '\u{F01BC} codegraph', role: 'mdCode' },
    { text: 'explore auth login', role: 'muted' },
  ]);
  assert.deepEqual(codegraphCallRows(shell)[1], { text: 'cd /tmp/ws && codegraph explore -- auth login', role: 'muted' }, 'a bash call names the command it ran');
  // No row carries a colour or an escape of its own: the shell paints the roles above.
  for (const row of codegraphCallRows(native)) {
    assert.equal(row.text.includes(String.fromCharCode(27)), false, row.text);
    assert.doesNotMatch(row.text, /#[0-9a-fA-F]{6}\b/, row.text);
  }
});

test('S6: the MCP heading names the explored checkout briefly, and never its full path', () => {
  const resolver = cardFor({ cwd: '/work/repo' });
  const EXPLORED = '/home/jona/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell';
  const heading = (args, width = 120) => stripAnsi(callRows(resolver, MCP_PREFIXED_TOOL, args, plainTheme, { isPartial: false }, width)[0]);

  const elsewhere = heading({ query: 'auth login', projectPath: EXPLORED });
  assert.ok(elsewhere.includes(`${CODEGRAPH_MARK} codegraph · explore auth login · gentle-shell`), 'the last segment continues the heading');
  assert.doesNotMatch(elsewhere, /Gentleman-Programming|\/home\/jona/, 'the full path never appears');

  for (const projectPath of [undefined, '', '/work/repo', '/work/repo/']) {
    const rows = heading({ query: 'auth login', ...(projectPath === undefined ? {} : { projectPath }) });
    assert.match(rows, /codegraph · explore auth login/);
    assert.doesNotMatch(rows, / · gentle-shell| · repo/, `${String(projectPath)} names no other checkout`);
  }
  assert.match(heading({ query: 'auth login', projectPath: 'gentle-shell' }), / · gentle-shell/, 'a bare name other than this checkout is named');
  assert.doesNotMatch(
    stripAnsi(callRows(cardFor({ cwd: '/work/repo/gentle-shell' }), MCP_PREFIXED_TOOL, { query: 'auth login', projectPath: 'gentle-shell' }, plainTheme, { isPartial: false }, 120)[0]),
    / · gentle-shell/,
    'a bare name equal to the cwd name names no other checkout',
  );

  // The shape carries the segment for the MCP tool only, and reads the seam per paint.
  assert.deepEqual(codegraphShape(MCP_PREFIXED_TOOL, { query: 'auth', projectPath: EXPLORED }, '/work/repo'), {
    surface: 'mcp',
    operation: 'explore',
    query: 'auth',
    project: 'gentle-shell',
  });
  assert.deepEqual(codegraphShape(MCP_PREFIXED_TOOL, { query: 'auth', projectPath: '/work/repo' }, '/work/repo'), { surface: 'mcp', operation: 'explore', query: 'auth' });
  assert.deepEqual(codegraphShape(MCP_PREFIXED_TOOL, { query: 'auth', projectPath: EXPLORED }), { surface: 'mcp', operation: 'explore', query: 'auth', project: 'gentle-shell' }, 'an unanswerable seam shows the explicit argument');

  // A seam that moves with the session re-decides on the next paint.
  let cwd = '/work/repo';
  const live = cardFor({ cwd: () => cwd });
  const liveHeading = () => stripAnsi(callRows(live, MCP_PREFIXED_TOOL, { query: 'auth', projectPath: '/work/repo' }, plainTheme, { isPartial: false }, 120)[0]);
  assert.doesNotMatch(liveHeading(), / · repo/);
  cwd = '/work/other';
  assert.match(liveHeading(), / · repo/, 'the same renderer follows the session it now belongs to');
});

test('a call whose operation is not known yet says so instead of guessing one', () => {
  assert.deepEqual(codegraphShape(CODEGRAPH_TOOL, {}), { surface: 'tool', operation: '...' });
  // The MCP tool's own name is the operation it runs.
  assert.deepEqual(codegraphShape(CODEGRAPH_MCP_TOOL, {}), { surface: 'mcp', operation: 'explore' });
  // Only a call that named exactly one payload word has a query; options are never read as one.
  assert.deepEqual(codegraphShape('bash', { command: 'codegraph query "a b"' }), { surface: 'bash', command: 'codegraph query "a b"', operation: 'query', query: 'a b' });
  assert.deepEqual(codegraphShape('bash', { command: 'codegraph query --path /tmp/ws alpha' }), { surface: 'bash', command: 'codegraph query --path /tmp/ws alpha', operation: 'query' });
  // An invocation with no readable operation is still the card: it names the command.
  assert.deepEqual(codegraphShape('bash', { command: 'codegraph --help' }), { surface: 'bash', command: 'codegraph --help' });
});

test('the two tool names are the card\'s, and nothing else is', () => {
  for (const toolName of [CODEGRAPH_TOOL, CODEGRAPH_MCP_TOOL, MCP_PREFIXED_TOOL]) {
    assert.equal(isCodeGraphCardTool(toolName), true, toolName);
  }
  for (const toolName of ['read', 'grep', 'edit', 'write', 'bash', 'powershell', 'codegraph_status', undefined, 42]) {
    assert.equal(isCodeGraphCardTool(toolName), false, String(toolName));
  }
});

// ---- the card, on the shell's own substrate ----

test('a call draws one heading with the CodeGraph mark and the operation as its detail', () => {
  const resolver = cardFor();
  const rows = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, taggedTheme, { isPartial: false }, 60);
  assert.equal(rows.length, 1, 'a settled call draws its heading and lets the result close the frame');
  assert.match(rows[0], /^<mdCode>╭<\/mdCode><mdCode>─ <\/mdCode>/, 'the frame carries the CodeGraph role, not the plain border');
  assert.match(rows[0], /<mdCode>󰆼 codegraph<\/mdCode>/, 'the label carries the CodeGraph title role');
  assert.match(rows[0], /<muted>·<\/muted> <muted>init<\/muted>/, 'the operation is the heading detail');
  assertFramed(rows, 60);

  // The same heading for the MCP tool, because it is the same program; a bash call
  // is the same card too but names the command it ran instead of an operation.
  const mcp = callRows(resolver, MCP_PREFIXED_TOOL, { query: 'auth' }, plainTheme, { isPartial: false }, 60);
  const bash = callRows(resolver, 'bash', { command: 'codegraph explore auth' }, plainTheme, { isPartial: false }, 60);
  assert.match(stripAnsi(mcp[0]), /󰆼 codegraph · explore auth/, 'the query is part of the detail');
  assert.match(stripAnsi(bash[0]), /󰆼 codegraph · explore auth/, 'a bash call names the input it ran, without repeating the program');

  // A call still streaming its arguments says so rather than guessing an operation.
  const streaming = callRows(resolver, CODEGRAPH_TOOL, {}, plainTheme, { isPartial: false }, 60);
  assert.match(stripAnsi(streaming[0]), /· \.\.\./, 'no operation yet is shown as "..."');
});

test('a settled card paints its whole box in the CodeGraph role, a running or failed one keeps its tone', () => {
  const resolver = cardFor();
  // Neon: the frame, not only the label, wears the CodeGraph role.
  const call = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, taggedTheme, { isPartial: false }, 60);
  assert.match(call[0], /^<mdCode>╭<\/mdCode><mdCode>─ <\/mdCode><mdCode>󰆼 codegraph<\/mdCode> <muted>·<\/muted> <muted>init<\/muted><mdCode> /, 'corners, lead and rule are the CodeGraph role');
  assert.equal(call[0].includes('<border>'), false, 'no cell of the box keeps the plain border role');
  const result = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_FRESH), { isPartial: false }, taggedTheme, { args: { operation: 'init' } }, 60);
  assert.match(result[0], /^<mdCode>│<\/mdCode> /, 'the result continues the same box');
  assert.match(result.at(-1), /^<mdCode>╰/);
  // The bash surface is the same card, so it paints the same box.
  const bash = callRows(resolver, 'bash', { command: 'codegraph status' }, taggedTheme, { isPartial: false }, 60);
  assert.match(bash[0], /^<mdCode>╭<\/mdCode>/);

  // A running call keeps its warning tone and a failed one its error tone: an active
  // state speaks for the call, so no identity role overrides it.
  const running = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, taggedTheme, { isPartial: true }, 40);
  assert.match(running[0], /^<warning>╭<\/warning>/);
  assert.match(running[1], /^<warning>│<\/warning> /);
  assert.match(running[2], /^<warning>╰<\/warning>/);
  const failed = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_FAILED, true), { isPartial: false }, taggedTheme, { args: { operation: 'init' } }, 60);
  assert.match(failed[0], /^<error>│<\/error> /);
  assert.match(failed.at(-1), /^<error>╰/);
});

test('the float card paints its rail in the CodeGraph role and keeps the tone band', () => {
  const resolver = cardFor();
  const theme = railTheme();
  globalThis[CARD_STYLE_SLOT] = CARD_STYLE.FLOAT;
  try {
    const rows = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, theme, { isPartial: false }, 40);
    assert.ok(rows.length > 0, 'the float card draws');
    for (const row of rows) assert.ok(row.includes('<mdCode>▎</mdCode>'), `"${row}" does not paint its rail in the CodeGraph role`);
    assert.equal(rows.join('\n').includes('<border>'), false, 'the left rail is the CodeGraph role and nothing of the band is plain border');
    assert.deepEqual(theme.roles.bg, ['toolSuccessBg'], 'the tone still decides the band the rail rides on');

    // A running card keeps its tone, band and rail alike.
    const running = railTheme();
    const pending = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, running, { isPartial: true }, 40);
    assert.ok(pending.join('\n').includes('<warning>▎</warning>'));
    assert.equal(pending.join('\n').includes('<mdCode>▎</mdCode>'), false);
    assert.deepEqual(running.roles.bg, ['toolPendingBg']);
  } finally {
    globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
  }
});

test('a running call is the warning tone and closes its own frame', () => {
  const resolver = cardFor();
  const rows = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, taggedTheme, { isPartial: true }, 40);
  assert.equal(rows.length, 3, 'a heading, the running row and the closed frame');
  assert.match(rows[0], /^<warning>╭<\/warning>/, 'pending is the warning tone');
  assert.match(rows[1], /^<warning>│<\/warning> <muted>running…<\/muted>/);
  assert.match(rows[2], /^<warning>╰/);
  assertFramed(rows, 40);

  const failed = callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, taggedTheme, { isPartial: false, isError: true }, 40);
  assert.match(failed[0], /^<error>╭<\/error>/, 'a failed call is the error tone');
});

test('a collapsed result is the one factual row the output supports, in the muted role', () => {
  const resolver = cardFor();
  for (const [operation, text, expected] of [
    ['init', INIT_FRESH, '→ initialized'],
    ['init', INIT_EXISTING, '→ already initialized'],
    ['sync', SYNC_CHANGED, '→ synced 3 changed files'],
    ['query', QUERY, '→ 2 results'],
  ]) {
    const args = operation === 'query' ? { command: 'codegraph query alpha' } : { command: `codegraph ${operation}` };
    const rows = resultRows(resolver, 'bash', textResult(text), { isPartial: false }, taggedTheme, { args }, 60);
    assert.equal(rows.length, 2, `${operation}: one body row and the closing rule`);
    assert.equal(bodyText(rows[0]), expected, `${operation} collapses to its own fact`);
    assert.match(rows[0], /<muted>/, `${operation}: the preview is the muted role`);
    assert.match(rows[1], /^<mdCode>╰/, `${operation}: the result closes the frame in the CodeGraph role`);
    assertFramed(rows, 60);
  }

  // The MCP explore tool's own header sentence is the row the card states.
  const explore = resultRows(resolver, MCP_PREFIXED_TOOL, textResult(EXPLORE), { isPartial: false }, plainTheme, {}, 60);
  assert.equal(bodyText(explore[0]), '→ 2 symbols in 1 file');
});

test('S4: an expanded init draws its outcome row and the index facts, never the CLI advisory', () => {
  const resolver = cardFor();
  const expanded = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_EXISTING), { expanded: true, isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
  assert.deepEqual(expanded.slice(0, -1).map(bodyText), ['→ already initialized'], 'the same one-row outcome the collapsed card states');
  assert.doesNotMatch(expanded.slice(0, -1).map(bodyText).join('\n'), /Use "codegraph index"/, 'the CLI advisory line never reaches the card');

  const fresh = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_FRESH), { expanded: true, isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
  assert.deepEqual(
    fresh.slice(0, -1).map(bodyText),
    ['→ initialized', 'Indexed 1 files', '3 nodes, 2 edges in 208ms'],
    'the outcome row plus the index facts, and nothing else',
  );
  assert.doesNotMatch(fresh.slice(0, -1).map(bodyText).join('\n'), /Initializing CodeGraph|└  Done|Scanning files/, 'the progress chrome is not an index fact');
  assertFramed(fresh, 80);

  // Expanding is the reader's own ask, so the rows arrive at any content level.
  withContent(CARD_CONTENT.MINIMAL, () => {
    const atMinimal = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_FRESH), { expanded: true, isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
    assert.deepEqual(atMinimal, fresh, 'the reader asked for everything and gets the facts');
  });

  // The same card for a bash `codegraph init`.
  const bash = resultRows(resolver, 'bash', textResult(INIT_EXISTING), { expanded: true, isPartial: false }, plainTheme, { args: { command: 'codegraph init -y /tmp/ws' } }, 80);
  assert.deepEqual(bash.slice(0, -1).map(bodyText), ['→ already initialized']);
  assert.doesNotMatch(bash.slice(0, -1).map(bodyText).join('\n'), /Use "codegraph index"/);
});

test('S4: the collapsed init outcome row is drawn at both content levels', () => {
  const resolver = cardFor();
  for (const [text, expected] of [[INIT_FRESH, '→ initialized'], [INIT_EXISTING, '→ already initialized']]) {
    withContent(CARD_CONTENT.MINIMAL, () => {
      const rows = resultRows(resolver, CODEGRAPH_TOOL, textResult(text), { isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
      assert.deepEqual(rows.slice(0, -1).map(bodyText), [expected], 'a card of this package never loses its outcome row to minimal');
      assertFramed(rows, 80);
    });
    const atDefault = resultRows(resolver, CODEGRAPH_TOOL, textResult(text), { isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
    assert.deepEqual(atDefault.slice(0, -1).map(bodyText), [expected], 'the default level draws the same row');
  }

  withContent(CARD_CONTENT.MINIMAL, () => {
    const rows = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_FRESH), { isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
    assert.equal(rows.slice(0, -1).map(bodyText).join('\n').includes('Indexed 1 files'), false,
      'minimal keeps the outcome alone; the index facts wait for the expansion');

    // Preserved: minimal hides every other operation's body...
    const sync = resultRows(resolver, 'bash', textResult(SYNC_CHANGED), { isPartial: false }, plainTheme, { args: { command: 'codegraph sync' } }, 80);
    assert.deepEqual(sync.slice(0, -1).map(bodyText), [], 'a minimized sync still draws the call alone');
    // ...and a failure still says why, at either level.
    const failed = resultRows(resolver, CODEGRAPH_TOOL, textResult(INIT_FAILED, true), { isPartial: false }, plainTheme, { args: { operation: 'init' } }, 80);
    assert.match(failed.slice(0, -1).map(bodyText).join('\n'), /Failed: EACCES/, 'a minimized failure still says why');
  });
});

test('a card body row is painted in the output role, the preview in muted, a failure in error', () => {
  const resolver = cardFor();
  assert.match(
    resultRows(resolver, CODEGRAPH_MCP_TOOL, textResult(EXPLORE), { expanded: true, isPartial: false }, taggedTheme, {}, 80)[0],
    /<toolOutput>/,
    'the expanded output is the theme toolOutput role',
  );
  const failure = resultRows(resolver, 'bash', textResult(INIT_FAILED, true), { isPartial: false }, taggedTheme, { args: { command: 'codegraph init' } }, 80);
  assert.match(failure[0], /<error>/, 'a failure paints its reason in the error role');
  assert.match(bodyText(failure[0]), /Failed: EACCES/);
  assert.match(failure.slice(0, -1).map(bodyText).join('\n'), /run "codegraph init" again/, 'the instruction the program printed stays with the reason');

  // No colour is written down: every cell asks the theme for one of its own roles.
  const recorder = recordingTheme();
  callRows(resolver, MCP_PREFIXED_TOOL, { query: 'auth' }, recorder, { isPartial: false }, 80);
  resultRows(resolver, MCP_PREFIXED_TOOL, textResult(EXPLORE), { isPartial: false }, recorder, {}, 80);
  assert.deepEqual([...new Set(recorder.roles)].sort(), ['mdCode', 'muted'], 'the CodeGraph role paints the box and the label, the preview the muted role');
  const expandedRecorder = recordingTheme();
  resultRows(resolver, MCP_PREFIXED_TOOL, textResult(EXPLORE), { expanded: true, isPartial: false }, expandedRecorder, {}, 80);
  assert.deepEqual([...new Set(expandedRecorder.roles)].sort(), ['mdCode', 'toolOutput'], 'an expanded body is the shell\'s tool-output role');
});

// ---- a bash call that runs codegraph is the CodeGraph card ----

/**
 * The content of a heading and of any detail it wrapped onto body rows, with the
 * chrome, the mark and the title removed: what the reader reads there.
 */
function headingText(rows) {
  return rows
    .map((row, index) => {
      const text = unpaint(row);
      if (index > 0) return text.replace(/^│ /, '').replace(/ +│$/, '').replace(/^· /, '');
      return text.replace(/^╭─ /, '').replace(/ ─*╮$/, '').replace(/^󰆼 codegraph(?: · )?/, '');
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The two compositions the session really ran. Both are one CodeGraph card.
const HELP_AND_STATUS = 'codegraph --help 2>&1 | head -60; echo "--- STATUS ---"; codegraph status 2>&1 | head -40';
const THREE_QUERIES = [
  'echo "=== codegraph query cardBodyRows ==="; codegraph query cardBodyRows 2>&1 | head -20; echo;',
  'echo "=== codegraph callers worktreeListView ==="; codegraph callers worktreeListView 2>&1 | head -20; echo;',
  'echo "=== codegraph node warpPendingGate ==="; codegraph node warpPendingGate 2>&1 | head -40',
].join(' ');

test('a bash call that runs codegraph is the CodeGraph card, and names the command it ran', () => {
  const resolver = cardFor();
  const collapsed = callRows(resolver, 'bash', { command: HELP_AND_STATUS }, taggedTheme, { isPartial: false }, 40);
  assert.equal(collapsed.length, 1, 'a collapsed call is one line: no operation label and no second heading');
  assert.match(collapsed[0], /<mdCode>󰆼 codegraph<\/mdCode>/, 'the CodeGraph mark and name');
  assert.match(collapsed[0], /<muted>·<\/muted> <muted>--help/, 'the input after the program is the heading detail');
  assert.match(collapsed[0], /--help .*…/, 'a command too wide for the rule ends in an ellipsis instead of a second row');
  assert.doesNotMatch(collapsed[0], /STATUS/, 'only what fits stays visible collapsed');
  assertFramed(collapsed, 40);

  // Expanded, the whole command is drawn: every line of it, wrapped, and nothing lost.
  const expanded = callRows(resolver, 'bash', { command: HELP_AND_STATUS }, taggedTheme, { isPartial: false, expanded: true }, 80);
  assert.ok(expanded.length > 1, 'the command continues on the rows below the rule');
  assert.equal(headingText(expanded), HELP_AND_STATUS.slice('codegraph '.length), 'the complete input after the program is the heading detail');
  assertFramed(expanded, 80);

  // A multi-line command keeps every line too, once the reader expands it.
  const script = 'codegraph status\necho done';
  assert.equal(headingText(callRows(resolver, 'bash', { command: 'codegraph status; echo done' }, plainTheme, { isPartial: false, expanded: true }, 80)), 'status; echo done');
  assert.equal(headingText(callRows(resolver, 'bash', { command: script }, plainTheme, { isPartial: false, expanded: true }, 80)), 'status echo done', 'a multi-line command keeps both of its lines');
});

test('any codegraph subcommand counts, and several of them in one command are one card', () => {
  const resolver = cardFor();
  for (const command of [
    'codegraph --help',
    'codegraph status',
    'codegraph callers worktreeListView',
    'codegraph node warpPendingGate',
    'codegraph status 2>&1 | head -40',
    'npx codegraph status',
    'pnpm exec codegraph status',
    HELP_AND_STATUS,
    THREE_QUERIES,
  ]) {
    const rows = callRows(resolver, 'bash', { command }, plainTheme, { isPartial: false }, 60);
    assert.equal(rows.length, 1, command);
    assert.match(stripAnsi(rows[0]), /󰆼 codegraph · /, command);
    const detail = headingText(rows);
    assert.ok(command.includes(detail.endsWith('…') ? detail.slice(0, -1) : detail), `${command} is the detail the card names`);
  }
});

test('S5: a bash codegraph call names the input after the program, its arguments included', () => {
  const resolver = cardFor();
  const detail = (command) => headingText(callRows(resolver, 'bash', { command }, plainTheme, { isPartial: false, expanded: true }, 120));
  assert.equal(detail('codegraph status .'), 'status .', 'the argument after the subcommand is part of the detail');
  assert.equal(detail('codegraph init /tmp/ws'), 'init /tmp/ws');
  assert.equal(detail('codegraph'), '', 'a bare call has no input to name');

  for (const command of [
    '/usr/local/bin/codegraph status .',
    'npx codegraph status .',
    'pnpm exec codegraph status .',
    'yarn codegraph status .',
    'bunx codegraph status .',
    'cd /tmp/ws && codegraph status .',
    'codegraph status .; echo done',
    'codegraph status . | head',
    'codegraph status . || true',
  ]) {
    const rows = callRows(resolver, 'bash', { command }, plainTheme, { isPartial: false }, 120);
    assert.match(stripAnsi(rows[0]), /󰆼 codegraph/, `${command} is the CodeGraph card`);
    assert.doesNotMatch(stripAnsi(rows[0]), /\$ bash/, `${command} never falls back to the generic heading`);
  }
});

test('a bash command that only mentions codegraph stays the host\'s own row', () => {
  const resolver = cardFor();
  const seen = [];
  const host = {
    renderShell: 'self',
    renderCall(...args) {
      seen.push(args);
      return { render: () => ['host bash call'], invalidate() {} };
    },
    renderResult: () => ({ render: () => ['host bash result'], invalidate() {} }),
  };
  const slot = resolver('bash', () => host);
  for (const command of ['echo codegraph init', 'cat codegraph.json', 'grep -r codegraph src', 'pnpm test && ls']) {
    assert.equal(codegraphShape('bash', { command }), undefined, command);
    assert.deepEqual(slot.renderCall({ command }, plainTheme, { isPartial: false }).render(60), ['host bash call'], command);
  }
  assert.equal(seen.length, 4, 'every mention-only command reached the host renderer');
});

test('a bash CodeGraph card keeps the three content levels: the command, a three-row preview, everything', () => {
  const resolver = cardFor();
  const output = Array.from({ length: 8 }, (_, index) => `row ${index + 1}`).join('\n');
  const args = { command: 'codegraph status' };
  assert.match(stripAnsi(callRows(resolver, 'bash', args, plainTheme, { isPartial: false }, 60)[0]), /󰆼 codegraph · status/, 'the collapsed default shows the input it ran');

  const preview = resultRows(resolver, 'bash', textResult(output), { isPartial: false }, plainTheme, { args }, 60);
  assert.equal(preview.length, 4, 'at most three rows of output preview and the closing rule');
  assert.equal(preview.slice(0, -1).map(bodyText).join('\n'), 'row 6\nrow 7\nrow 8');

  withContent(CARD_CONTENT.MINIMAL, () => {
    const minimal = resultRows(resolver, 'bash', textResult(output), { isPartial: false }, plainTheme, { args }, 60);
    assert.equal(minimal.length, 1, 'the minimal level draws the command line alone');
    assert.match(minimal[0], /^╰/, 'the result only closes the frame the call above opened');
  });

  const expanded = resultRows(resolver, 'bash', textResult(output), { expanded: true, isPartial: false }, plainTheme, { args }, 60);
  assert.equal(expanded.slice(0, -1).map(bodyText).join('\n'), output, 'expanded shows every row it printed');
});

test('a minimized card draws no result at all, and a failure still says why', () => {
  const resolver = cardFor();
  const args = { command: 'codegraph query alpha' };
  withContent(CARD_CONTENT.MINIMAL, () => {
    const minimal = resultRows(resolver, 'bash', textResult(QUERY), { isPartial: false }, plainTheme, { args }, 60);
    assert.equal(minimal.length, 1, 'the call alone is the card');
    assert.match(minimal[0], /^╰/, 'the result only closes the frame the call above opened');
    assert.equal(minimal.some((row) => stripAnsi(row).includes('→ 2 results')), false);

    const failure = resultRows(resolver, 'bash', textResult(INIT_FAILED, true), { isPartial: false }, plainTheme, { args: { command: 'codegraph init' } }, 80);
    assert.match(bodyText(failure[0]), /Failed: EACCES/, 'a failure always says why, at either level');
  });
  // Back at the default level the same inputs draw the preview again.
  const restored = resultRows(resolver, 'bash', textResult(QUERY), { isPartial: false }, plainTheme, { args }, 60);
  assert.equal(bodyText(restored[0]), '→ 2 results');
});

test('a partial result shows the rows it already has, and leaves the closing rule to the final one', () => {
  const resolver = cardFor();
  const args = { command: 'codegraph init' };
  const rows = resultRows(resolver, 'bash', textResult('┌  Initializing CodeGraph\n│'), { isPartial: true }, plainTheme, { args }, 60);
  assert.match(bodyText(rows[0]), /Initializing CodeGraph/, 'the rows the tool printed are the card');
  assert.equal(rows.some((row) => row.startsWith('╰')), false, 'a streamed result does not close the frame yet');
});

test('the elapsed time rides the closing rule, and a very narrow card still draws', () => {
  const resolver = cardFor();
  const rows = resultRows(resolver, MCP_PREFIXED_TOOL, textResult(EXPLORE), { isPartial: false }, plainTheme, { durationMs: 1200 }, 60);
  assert.match(rows.at(-1), / 1\.2s ╯$/);
  for (const width of [0, 1, 2, 3, 5, 9, 12]) {
    for (const drawn of [
      callRows(resolver, CODEGRAPH_TOOL, { operation: 'init' }, plainTheme, { isPartial: true }, width),
      resultRows(resolver, MCP_PREFIXED_TOOL, textResult(EXPLORE), { isPartial: false }, plainTheme, {}, width),
      resultRows(resolver, MCP_PREFIXED_TOOL, textResult(EXPLORE), { expanded: true, isPartial: false }, plainTheme, {}, width),
    ]) {
      for (const row of drawn) assert.ok(metrics.visibleWidth(row) <= width, `"${stripAnsi(row)}" overflows ${width}`);
    }
  }
});

test('the content level is read on every paint, so a card on screen repaints when it changes', () => {
  const resolver = cardFor();
  const slot = renderersFor(resolver, MCP_PREFIXED_TOOL);
  const component = slot.renderResult(textResult(EXPLORE), { isPartial: false }, plainTheme, {});
  // The reader of the process-wide slot: no injected reader, so the shell's own level answers.
  const before = component.render(60);
  assert.match(bodyText(before[0]), /→ 2 symbols in 1 file/, 'the default level draws the preview');

  globalThis[CARD_CONTENT_SLOT] = CARD_CONTENT.MINIMAL;
  try {
    const minimized = component.render(60);
    assert.notDeepEqual(minimized, before, 'the same component repaints at the level now in force');
    assert.equal(minimized.some((row) => stripAnsi(row).includes('2 symbols')), false, 'and the preview is gone');
    // No rebuild, no new resolver: the very component already on screen is the one that changed.
    globalThis[CARD_CONTENT_SLOT] = CARD_CONTENT.DEFAULT;
    assert.deepEqual(component.render(60), before, 'and back again');
  } finally {
    delete globalThis[CARD_CONTENT_SLOT];
  }

  // A reader injected by the caller answers instead, also read on every paint.
  let level = CARD_CONTENT.DEFAULT;
  const injected = cardFor({ cardContent: () => level });
  const injectedSlot = renderersFor(injected, MCP_PREFIXED_TOOL);
  const injectedComponent = injectedSlot.renderResult(textResult(EXPLORE), { isPartial: false }, plainTheme, {});
  assert.match(bodyText(injectedComponent.render(60)[0]), /→ 2 symbols/);
  level = CARD_CONTENT.MINIMAL;
  assert.equal(injectedComponent.render(60).some((row) => stripAnsi(row).includes('2 symbols')), false);
});

test('cardContentLevel reads the process-wide slot and only the two known levels', () => {
  assert.equal(cardContentLevel({}), CARD_CONTENT.DEFAULT, 'an unset slot is the default preview level');
  assert.equal(cardContentLevel({ [CARD_CONTENT_SLOT]: 'minimal' }), CARD_CONTENT.MINIMAL);
  for (const junk of ['everything', 42, null, {}, []]) {
    assert.equal(cardContentLevel({ [CARD_CONTENT_SLOT]: junk }), CARD_CONTENT.DEFAULT, 'a value this package cannot read is the safe level');
  }
});

// ---- the resolver: what it owns, and what it must hand back untouched ----

test('every tool the card does not own is handed back exactly as the chain resolved it', () => {
  const resolver = cardFor();
  const hostRenderers = { renderCall: () => 'host call', renderResult: () => 'host result' };
  for (const toolName of ['read', 'grep', 'edit', 'write', 'powershell', 'worktree_create', 'codegraph_status', undefined, 42]) {
    assert.equal(resolver(toolName, () => hostRenderers), hostRenderers, `${String(toolName)} is the host's own row`);
  }
  // A chain that resolves nothing stays nothing: this package adds no renderer to an unrelated tool.
  assert.equal(resolver('read', () => undefined), undefined);

  // A bash call that is not CodeGraph forwards to the host's own drawing, with its own arguments.
  const calls = [];
  const host = {
    renderShell: 'self',
    renderCall(...args) {
      calls.push(['call', ...args]);
      return { render: () => ['host bash call'], invalidate() {} };
    },
    renderResult(...args) {
      calls.push(['result', ...args]);
      return { render: () => ['host bash result'], invalidate() {} };
    },
  };
  const bash = resolver('bash', () => host);
  assert.equal(typeof bash.renderCall, 'function', 'bash is decided per call, so its slot is always ours to decide');
  const args = { command: 'pnpm test' };
  const context = { isPartial: false };
  assert.deepEqual(bash.renderCall(args, plainTheme, context).render(40), ['host bash call']);
  assert.equal(calls[0][1], args, 'the host renderer receives the very arguments the host handed us');
  assert.equal(calls[0][2], plainTheme);
  assert.equal(calls[0][3], context);
  assert.deepEqual(bash.renderResult(textResult('ok'), { isPartial: false }, plainTheme, { args }).render(40), ['host bash result']);
  assert.equal(calls[1][1].content[0].text, 'ok');

  // A bash call whose command DOES run CodeGraph is the card's.
  const codegraph = bash.renderCall({ command: 'codegraph init' }, plainTheme, { isPartial: false }).render(60);
  assert.match(stripAnsi(codegraph[0]), /󰆼 codegraph · init/);
});

test('the resolver takes its host seams as options and degrades to drawing nothing without the hook', () => {
  // No registerToolRenderer at all: an older host, or one whose renderer chain refuses the probe.
  const none = createCodegraphCardResolver({ metrics, theme: plainTheme });
  assert.equal(none.registered, false, 'without the hook nothing is registered, so nothing of ours is drawn');
  assert.doesNotThrow(() => none.resolver('codegraph', () => undefined));

  let seen;
  const cards = createCodegraphCardResolver({
    metrics,
    theme: plainTheme,
    cardContent: () => CARD_CONTENT.DEFAULT,
    registerToolRenderer: (resolver) => {
      seen = resolver;
    },
  });
  assert.equal(cards.registered, true);
  assert.equal(seen, cards.resolver, 'the host hook receives this factory\'s resolver');

  // A hook that throws while registering is the same as no hook: the host keeps drawing.
  const hostile = createCodegraphCardResolver({
    metrics,
    theme: plainTheme,
    registerToolRenderer: () => {
      throw new Error('no such hook');
    },
  });
  assert.equal(hostile.registered, false);

  // The measurement seam is required, and the factory says which one is missing.
  assert.throws(() => createCodegraphCardResolver(), /metrics/);
  assert.throws(() => createCodegraphCardResolver({ registerToolRenderer: () => {} }), /metrics/);
  const broken = { ...metrics, wrapTextWithAnsi: undefined };
  assert.throws(() => createCodegraphCardResolver({ metrics: broken }), /wrapTextWithAnsi/);
  // A metrics seam resolved late (the host's TUI package is loaded inside the hook) is read per paint.
  const late = createCodegraphCardResolver({
    metrics: () => metrics,
    theme: plainTheme,
    registerToolRenderer: () => {},
  });
  assert.equal(late.registered, true);
  assert.match(stripAnsi(late.resolver('codegraph', () => undefined).renderCall({ operation: 'init' }, plainTheme, { isPartial: false }).render(60)[0]), /codegraph/);
});

test('a renderer that throws draws nothing and never breaks the transcript', () => {
  const resolver = cardFor();
  // The theme itself throws on every role it is asked for.
  const hostileTheme = {
    fg() {
      throw new Error('Unknown theme color');
    },
  };
  const call = resolver('codegraph', () => undefined).renderCall({ operation: 'init' }, hostileTheme, { isPartial: false });
  assert.deepEqual(call.render(60), [], 'a card that cannot be painted draws no rows');
  const result = resolver(MCP_PREFIXED_TOOL, () => undefined).renderResult(textResult(EXPLORE), { isPartial: false }, hostileTheme, {});
  assert.deepEqual(result.render(60), []);

  // The host's own renderer throws while drawing a bash row that is not CodeGraph's.
  const throwing = resolver('bash', () => ({
    renderShell: 'self',
    renderCall() {
      throw new Error('host renderer exploded');
    },
    renderResult() {
      throw new Error('host renderer exploded');
    },
  }));
  assert.doesNotThrow(() => throwing.renderCall({ command: 'ls' }, plainTheme, { isPartial: false }).render(40));
  assert.doesNotThrow(() => throwing.renderResult(textResult('ok'), { isPartial: false }, plainTheme, { args: { command: 'ls' } }).render(40));
  assert.deepEqual(throwing.renderCall({ command: 'ls' }, plainTheme, { isPartial: false }).render(40), [], 'and draws nothing of its own');

  // A chain whose next() throws is the host's own drawing, and no CodeGraph card is lost.
  const broken = resolver('read', () => {
    throw new Error('chain exploded');
  });
  assert.equal(broken, undefined, 'a foreign tool with no usable chain stays the host\'s');
  assert.doesNotThrow(() => resolver('codegraph', () => {
    throw new Error('chain exploded');
  }).renderCall({ operation: 'init' }, plainTheme, { isPartial: false }).render(60));
});

// ---- the host's shell: this card frames itself, so the host must not frame it too ----

test('the native and MCP CodeGraph tools declare a self shell, or the host draws its own filled box under the card', () => {
  const resolver = cardFor();
  assert.equal(resolver(CODEGRAPH_TOOL, () => undefined).renderShell, 'self');
  assert.equal(resolver(MCP_PREFIXED_TOOL, () => undefined).renderShell, 'self');
  assert.equal(resolver(CODEGRAPH_MCP_TOOL, () => undefined).renderShell, 'self');
});

test('a bash row is drawn by this card only on a host whose bash row already frames itself', () => {
  const resolver = cardFor();
  const self = { renderShell: 'self', renderCall: () => 'host-call', renderResult: () => 'host-result' };
  const drawn = resolver('bash', () => self);
  assert.equal(drawn.renderShell, 'self', 'the card keeps the shell the host row already had');
  assert.notEqual(drawn.renderCall, self.renderCall, 'and draws a CodeGraph command itself');
  // A host row inside the default filled box: this card would be drawn on top of the box, which is two designs at once.
  const boxed = { renderCall: () => 'host-call', renderResult: () => 'host-result' };
  assert.equal(resolver('bash', () => boxed), boxed, 'the host row is returned untouched');
});

test('a host with no bash renderer of its own keeps drawing every bash row itself', () => {
  const resolver = cardFor();
  assert.equal(resolver('bash', () => undefined), undefined, 'no command loses its drawing on such a host');
  assert.equal(resolver('bash', () => {
    throw new Error('chain exploded');
  }), undefined);
});

// ---- S5's two styles, one card ----

/** The card's text with every chrome cell removed: what the reader actually reads. */
function contentOf(rows) {
  return rows
    .map((row) => unpaint(row).replace(/[╭╮╰╯─│▎]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' | ');
}

test('the same CodeGraph card is the same text in float and in neon, and only the chrome differs', () => {
  const resolver = cardFor();
  const theme = paintTheme();
  const draw = (style, run) => {
    globalThis[CARD_STYLE_SLOT] = style;
    try {
      return run();
    } finally {
      globalThis[CARD_STYLE_SLOT] = CARD_STYLE.NEON;
    }
  };
  const call = (style) => draw(style, () => callRows(resolver, CODEGRAPH_TOOL, { operation: 'query', query: 'alpha' }, theme, { isPartial: false }, 60));
  const result = (style) => draw(style, () => resultRows(resolver, CODEGRAPH_TOOL, textResult(QUERY), { isPartial: false }, theme, { args: { operation: 'query' }, durationMs: 1200 }, 60));

  assert.equal(contentOf(call(CARD_STYLE.FLOAT)), contentOf(call(CARD_STYLE.NEON)), 'one heading, two chromes');
  assert.equal(contentOf(result(CARD_STYLE.FLOAT)), contentOf(result(CARD_STYLE.NEON)), 'one preview row and one elapsed time');
  assert.match(contentOf(result(CARD_STYLE.FLOAT)), /1\.2s$/);
  assert.equal(call(CARD_STYLE.NEON).some((row) => row.includes('▎')), false, 'neon draws no rail');
  assert.equal(result(CARD_STYLE.FLOAT).some((row) => /[╭╮╰╯─│]/.test(row)), false, 'float draws no box');
  assert.ok(result(CARD_STYLE.FLOAT).every((row) => row.includes('\x1b[48;5;240m')), 'the float card paints the tone background');
  for (const row of result(CARD_STYLE.FLOAT)) assert.equal(metrics.visibleWidth(unpaint(row)), 60, 'a float row is the width it was given');
});

test('an unreadable call or output draws nothing instead of throwing', () => {
  const resolver = cardFor();
  for (const value of [undefined, null, 42, {}, [], { content: 'nope' }, { content: [{ type: 'text', text: 42 }] }]) {
    assert.doesNotThrow(() => codegraphShape(value, value));
    assert.doesNotThrow(() => codegraphShape('bash', value));
    assert.deepEqual(codegraphResultRows({ shape: { operation: 'init' }, text: value, expanded: false, isPartial: false, failed: false, content: CARD_CONTENT.DEFAULT }), []);
    assert.doesNotThrow(() => resolver('bash', () => HOST_BASH).renderCall(value, plainTheme, { isPartial: false }).render(40));
  }
  // The native tool's own arguments are the only place its operation comes from.
  assert.deepEqual(codegraphShape('bash', { command: 'ls' }), undefined);
  assert.deepEqual(codegraphShape('read', { command: 'codegraph init' }), undefined);
});

// ---- S11: the switch is the bridge's `Card tags` line ----
//
// The card paints a CALL; it does not run CodeGraph. So no module switch decides it: the line
// the activity design owns does, asked on every paint. `activity` selected claims it, and every
// other answer — `native`, `not-covered`, `missing`, another plugin's design, a reader that
// throws, or no reader at all — hands the chain's own rows back without asking one slot.

test('S11: `activity` selected claims the CodeGraph tools and a bash call that runs the program', () => {
  publishBridge(ACTIVITY_ON);
  const resolver = cardFor();
  for (const tool of [CODEGRAPH_TOOL, CODEGRAPH_MCP_TOOL]) {
    const slot = resolver(tool, () => HOST_BASH);
    assert.equal(slot?.renderShell, 'self', `${tool} is drawn as a self-framed card`);
    assert.equal(typeof slot.renderCall, 'function', `${tool}: the card draws the call`);
    assert.equal(typeof slot.renderResult, 'function', `${tool}: the card draws the result`);
  }
  const bash = resolver('bash', () => HOST_BASH);
  assert.equal(bash?.renderShell, 'self', 'a bash call on a self-framed chain is the card’s');
});

test('S11: `native`, `not-covered`, `missing`, another design and a throwing reader hand every row back', () => {
  const answers = [
    { kind: 'native' },
    { kind: 'not-covered', id: ACTIVITY_DESIGN_ID },
    { kind: 'missing', id: 'gone.design' },
    { kind: 'design', design: { id: 'someone.else' } },
    { kind: 'design' },
    { kind: 'design', design: null },
    undefined,
    null,
  ];
  for (const answer of answers) {
    publishBridge(() => answer);
    const resolver = cardFor();
    for (const tool of [CODEGRAPH_TOOL, CODEGRAPH_MCP_TOOL, 'bash']) {
      assert.equal(resolver(tool, () => HOST_BASH), HOST_BASH, `${tool} under ${JSON.stringify(answer)}`);
    }
  }
  publishBridge(() => { throw new Error('bridge exploded'); });
  assert.equal(cardFor()(CODEGRAPH_TOOL, () => HOST_BASH), HOST_BASH, 'a throwing reader is a no');
  publishBridge(ACTIVITY_ON);
});

test('S11: with no reader at all the card claims nothing, and a host without the hook registers nothing', () => {
  globalThis[BRIDGE_API_SLOT] = { schema: 'gentle-shell-bridge/api', version: 1 };
  assert.equal(cardFor()(CODEGRAPH_TOOL, () => HOST_BASH), HOST_BASH, 'an older bridge has no switch to follow');
  delete globalThis[BRIDGE_API_SLOT];
  assert.equal(cardFor()(CODEGRAPH_TOOL, () => HOST_BASH), HOST_BASH, 'no bridge, no switch, no card');
  publishBridge(ACTIVITY_ON);
  const { registerCodegraphCard } = require('../lib/codegraph-card.js');
  assert.deepEqual(registerCodegraphCard({}, {}), { registered: false, resolver: undefined }, 'no host hook, no registration');
});

// ---- purity ----

test('the modules carry no colour, no escape and no host package', () => {
  for (const file of ['codegraph-card.js', 'codegraph-card-preview.js']) {
    const source = readFileSync(join(__dirname, '..', 'lib', file), 'utf8');
    assert.doesNotMatch(source, /@earendil-works/, `${file} requires no host package`);
    assert.doesNotMatch(source, /\\u001b|\\x1b|String\.fromCharCode\(27\)/, `${file} writes no escape sequence down`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, `${file} writes no hexadecimal colour`);
    assert.doesNotMatch(source, /require\(['"](?!\.\/|node:)/, `${file} imports only its own modules and Node builtins`);
    // S1: no model-facing tool is registered, executed or shadowed — the card only draws. The
    // one host seam it touches is the renderer hook, through `registerCodegraphCard`.
    assert.doesNotMatch(source, /registerTool\(|\.execute\b|registerCommand\(/, `${file} registers and runs nothing`);
  }
});

// ---- S5: the composition, not the isolated resolver ----
//
// Every case above drives ONE resolver. The row the user reported wrong was decided
// by the chain the host builds from ALL of them: `resolveToolRenderers` calls the
// extension's resolvers in load order, each `next` resolving the following one, and
// the tool's own renderers last. That order is a fact of the extension file, so this
// block loads the extension itself against the fake host, collects the resolvers it
// registers, and renders a bash call through the chain the host would run.
//
// Both cards wear the classifier's `codegraph` mark for such a command, so the
// heading alone cannot say which one drew the row. What tells them apart is the body
// the CodeGraph card composes from the CLI's own output, and whether the bash card's
// slots were ever asked: they are captured here and stated to be untouched.

/** The `codegraph` CLI, faked for the one probe the extension makes. */
async function withCodegraphCli(run) {
  // `cliAvailable` asks whether the binary is on PATH (`existsSync`, no spawn), and a
  // host without it registers no CodeGraph card at all (invariant 19). The directory
  // is scratch and PATH is restored before anything else runs.
  const dir = mkdtempSync(join(tmpdir(), 'odd-worktree-codegraph-cli-'));
  writeFileSync(join(dir, 'codegraph'), '');
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await run();
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The extension loaded as the host loads it, and the resolvers it registered, in order. */
async function loadComposedExtension() {
  const savedLibDir = process.env.GENTLE_WORKTREE_LIB_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'odd-worktree-composed-'));
  const copy = join(dir, 'odd-worktree-tools.mjs');
  writeFileSync(copy, stubbedSource());
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  try {
    const mod = await import(pathToFileURL(copy).href);
    const resolvers = [];
    const host = {
      registerCommand: () => {},
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
      on: () => {},
      registerToolRenderer: (resolver) => resolvers.push(resolver),
    };
    await withCodegraphCli(() => {
      // S18 (T14): the extension registers nothing without gentle-shell-bridge, so
      // this file's own host publishes the shared fixture's bridge before the factory
      // runs. This load's bridge also answers the `Card tags` reader with the activity
      // design (S11), which is the switch the CodeGraph card follows.
      const previous = globalThis[BRIDGE_API_SLOT];
      globalThis[BRIDGE_API_SLOT] = { ...defaultBridge().api, resolveToolDesignSelection: ACTIVITY_ON };
      try {
        mod.default(host);
      } finally {
        if (previous === undefined) delete globalThis[BRIDGE_API_SLOT];
        else globalThis[BRIDGE_API_SLOT] = previous;
      }
    });
    // The cards measure text through the extension's own injected seam, so the test
    // supplies it after the load — the way the other card suites inject theirs.
    mod.setWorktreeToolCardMetrics(metrics);
    return { mod, resolvers };
  } finally {
    if (savedLibDir === undefined) delete process.env.GENTLE_WORKTREE_LIB_DIR;
    else process.env.GENTLE_WORKTREE_LIB_DIR = savedLibDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The host's chain for one tool: the registered resolvers in order, then what comes after them. */
function hostChain(resolvers, toolName, base = HOST_BASH) {
  const resolve = (index) => (index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base);
  return resolve(0);
}

/** One bash row down a chain, as the host drives it: its call and its result, as drawn lines. */
function drawThrough(resolvers, command, output) {
  const slot = hostChain(resolvers, 'bash');
  assert.equal(slot?.renderShell, 'self', `${command} is drawn as a self-framed card`);
  const call = slot.renderCall({ command }, plainTheme, { isPartial: false }).render(64).map(unpaint);
  const result = slot.renderResult(textResult(output), { isPartial: false }, plainTheme, { args: { command } }).render(64).map(unpaint);
  return { call, result };
}

let composed;
let codegraphAt;

before(async () => {
  composed = await loadComposedExtension();
  // Only the CodeGraph card claims the native `codegraph` tool.
  codegraphAt = composed.resolvers.findIndex((resolver) => resolver(CODEGRAPH_TOOL, () => HOST_BASH) !== HOST_BASH);
});

after(() => {
  composed = undefined;
});

test('the extension registers the CodeGraph card through the host hook', () => {
  assert.notEqual(codegraphAt, -1, 'the CodeGraph card is registered through the host hook');
});

test('a bash call that runs no CodeGraph is drawn exactly as the host draws it', () => {
  // The activity heading is applied by the bridge's design (lib/bash-design.js), never by a
  // resolver of this package: the chain hands this row to the host's own renderers.
  const drawn = drawThrough(composed.resolvers, 'pnpm test', 'Tests 12 passed');
  const host = drawThrough([], 'pnpm test', 'Tests 12 passed');
  assert.deepEqual(drawn, host);
});

test('a `codegraph status .` bash call is drawn by the CodeGraph card', () => {
  const output = ['┌  CodeGraph status', '│', '◆  Workspace: /tmp/ws', '●  42 nodes, 66 edges', '│', '└  Done'].join('\n');
  const drawn = drawThrough(composed.resolvers, 'codegraph status .', output);
  const heading = drawn.call.join('\n');
  assert.ok(heading.includes(`${CODEGRAPH_MARK} ${CODEGRAPH_TOOL}`), `the heading carries the CodeGraph mark and name in "${heading}"`);
  assert.match(heading, /codegraph · status \./, 'the subcommand and its argument are the heading detail');
  assert.ok(drawn.result.some((row) => row.includes('◆  Workspace: /tmp/ws')), 'the body is the CLI output the CodeGraph card composes');
});

test('a `codegraph init` bash call is drawn by the CodeGraph card', () => {
  const drawn = drawThrough(composed.resolvers, 'codegraph init', INIT_FRESH);
  const heading = drawn.call.join('\n');
  assert.ok(heading.includes(`${CODEGRAPH_MARK} ${CODEGRAPH_TOOL}`), `the heading carries the CodeGraph mark and name in "${heading}"`);
  assert.match(heading, /codegraph · init/, 'the operation is the heading detail');
});

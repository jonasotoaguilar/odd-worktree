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
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, test } = require('node:test');

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
  assert.match(stripAnsi(bash[0]), /󰆼 codegraph · codegraph explore auth/, 'a bash call names the command it ran');

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

test('expanding the card draws the whole CLI output it printed', () => {
  const resolver = cardFor();
  const args = { command: 'codegraph init -y /tmp/ws' };
  const collapsed = resultRows(resolver, 'bash', textResult(INIT_FRESH), { isPartial: false }, plainTheme, { args }, 60);
  assert.equal(collapsed.length, 2, 'a collapsed result is bounded');

  const expanded = resultRows(resolver, 'bash', textResult(INIT_FRESH), { expanded: true, isPartial: false }, plainTheme, { args }, 60);
  assert.ok(expanded.length > collapsed.length, 'expanded shows all of it');
  assertFramed(expanded, 60);
  const body = expanded.slice(0, -1).map(bodyText).join('\n');
  assert.equal(body, INIT_FRESH.trimEnd(), 'the expanded body is the output itself, row for row');
  assert.match(body, /Indexed 1 files/);
  assert.match(body, /└  Done/);
  // Expanding is the reader's own ask, so the full output arrives at any content level.
  withContent(CARD_CONTENT.MINIMAL, () => {
    const atMinimal = resultRows(resolver, 'bash', textResult(INIT_FRESH), { expanded: true, isPartial: false }, plainTheme, { args }, 60);
    assert.deepEqual(atMinimal, expanded, 'the reader asked for everything and gets everything');
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
  assert.match(collapsed[0], /<muted>·<\/muted> <muted>codegraph --help 2>&…<\/muted>/, 'the command is the heading detail');
  assert.match(collapsed[0], /codegraph --help 2>&…/, 'a command too wide for the rule ends in an ellipsis instead of a second row');
  assert.doesNotMatch(collapsed[0], /STATUS/, 'only what fits stays visible collapsed');
  assertFramed(collapsed, 40);

  // Expanded, the whole command is drawn: every line of it, wrapped, and nothing lost.
  const expanded = callRows(resolver, 'bash', { command: HELP_AND_STATUS }, taggedTheme, { isPartial: false, expanded: true }, 80);
  assert.ok(expanded.length > 1, 'the command continues on the rows below the rule');
  assert.equal(headingText(expanded), HELP_AND_STATUS, 'the complete command is the heading detail');
  assertFramed(expanded, 80);

  // A multi-line command keeps every line too, once the reader expands it.
  const script = 'codegraph status\necho done';
  assert.equal(headingText(callRows(resolver, 'bash', { command: 'codegraph status; echo done' }, plainTheme, { isPartial: false, expanded: true }, 80)), 'codegraph status; echo done');
  assert.equal(headingText(callRows(resolver, 'bash', { command: script }, plainTheme, { isPartial: false, expanded: true }, 80)), 'codegraph status echo done', 'a multi-line command keeps both of its lines');
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
    assert.ok(command.startsWith(detail.endsWith('…') ? detail.slice(0, -1) : detail), `${command} is the detail the card names`);
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
  assert.match(stripAnsi(callRows(resolver, 'bash', args, plainTheme, { isPartial: false }, 60)[0]), /󰆼 codegraph · codegraph status/, 'the collapsed default shows the command line');

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
  assert.match(stripAnsi(codegraph[0]), /󰆼 codegraph · codegraph init/);
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

// ---- purity ----

test('the modules carry no colour, no escape and no host package', () => {
  for (const file of ['codegraph-card.js', 'codegraph-card-preview.js']) {
    const source = readFileSync(join(__dirname, '..', 'lib', file), 'utf8');
    assert.doesNotMatch(source, /@earendil-works/, `${file} requires no host package`);
    assert.doesNotMatch(source, /\\u001b|\\x1b|String\.fromCharCode\(27\)/, `${file} writes no escape sequence down`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, `${file} writes no hexadecimal colour`);
    assert.doesNotMatch(source, /require\(['"](?!\.\/|node:)/, `${file} imports only its own modules and Node builtins`);
    // S1: no model-facing tool is registered, executed or shadowed — the card only draws.
    assert.doesNotMatch(source, /registerTool\(|\.execute\b|registerCommand\(|registerToolRenderer\(/, `${file} registers and runs nothing`);
  }
});

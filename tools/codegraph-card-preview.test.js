'use strict';
// S10 preview: the collapsed CodeGraph card only states facts the program
// printed. Every case goes through lib/codegraph-card-preview.js and its
// injected-free surface (the module is pure: no Pi, no theme, no disk), and the
// inputs are the recorded output shapes in tools/fixtures/card-codegraph-outputs.js
// or the command strings a `bash` call carries.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CODEGRAPH_MARK,
  CODEGRAPH_TITLE_ROLE,
  CODEGRAPH_TOOL,
  codeGraphCollapsedRows,
  codeGraphInitOutcome,
  codeGraphPreview,
  codeGraphResultSummary,
  codeGraphSyncOutcome,
  codegraphCallDetail,
  codegraphCallFromCommand,
  projectPathSegment,
  cardText,
} = require('../lib/codegraph-card-preview.js');
const {
  EXPLORE,
  EXPLORE_PINNED,
  INIT_EXISTING,
  INIT_FACTS,
  INIT_FAILED,
  INIT_FRESH,
  QUERY,
  QUERY_EMPTY,
  SYNC_CHANGED,
  SYNC_NO_FILES,
  SYNC_UP_TO_DATE,
} = require('./fixtures/card-codegraph-outputs.js');

test('the identity is the tool name, its own mark and the theme role its card wears', () => {
  assert.equal(CODEGRAPH_TOOL, 'codegraph');
  assert.equal(CODEGRAPH_MARK, '\u{F01BC}', 'the database glyph is the tool\'s own icon');
  assert.equal(CODEGRAPH_TITLE_ROLE, 'mdCode', 'the title role is the shell theme\'s own slot, never a colour');
});

test('an init card collapses to the one sentence the tool printed', () => {
  assert.equal(codeGraphInitOutcome(INIT_FRESH), 'initialized');
  assert.equal(codeGraphInitOutcome(INIT_EXISTING), 'already initialized');
  // No concluding sentence is no outcome: the card keeps the rows it has.
  assert.equal(codeGraphInitOutcome(INIT_FACTS), undefined);
  assert.equal(codeGraphInitOutcome(INIT_FAILED), undefined);
  assert.deepEqual(codeGraphCollapsedRows('init', INIT_FRESH, false, false), { text: '→ initialized', rows: 1, tail: false });
  assert.deepEqual(codeGraphCollapsedRows('init', INIT_EXISTING, false, false), { text: '→ already initialized', rows: 1, tail: false });
});

test('an init without a concluding sentence previews the facts it reported', () => {
  assert.deepEqual(codeGraphCollapsedRows('init', INIT_FACTS, false, false), {
    text: '◆  Indexed 2 files\n●  5 nodes, 7 edges in 239ms',
    rows: 3,
    tail: true,
  });
});

test('a sync is told apart from an init, in the words sync itself printed', () => {
  assert.equal(codeGraphSyncOutcome(SYNC_CHANGED), 'synced 3 changed files');
  assert.equal(codeGraphSyncOutcome(SYNC_NO_FILES), 'synced 1 changed files');
  assert.equal(codeGraphSyncOutcome(SYNC_UP_TO_DATE), 'already up to date');
  // An init log states no sync outcome, and a sync log states no init one.
  assert.equal(codeGraphSyncOutcome(INIT_FRESH), undefined);
  assert.equal(codeGraphInitOutcome(SYNC_CHANGED), undefined);
  assert.deepEqual(codeGraphCollapsedRows('sync', SYNC_CHANGED, false, false), { text: '→ synced 3 changed files', rows: 1, tail: false });
  assert.deepEqual(codeGraphCollapsedRows('sync', SYNC_UP_TO_DATE, false, false), { text: '→ already up to date', rows: 1, tail: false });
  // A sync that printed no such sentence keeps the rows it did print.
  const quiet = ['┌  Syncing CodeGraph', '│', 'Resolved 4 pending references', '└  Done'].join('\n');
  assert.equal(codeGraphSyncOutcome(quiet), undefined);
  assert.deepEqual(codeGraphCollapsedRows('sync', quiet, false, false), {
    text: '┌  Syncing CodeGraph\nResolved 4 pending references\n└  Done',
    rows: 3,
    tail: true,
  });
});

test('a query and an explore summarize the count their own output stated', () => {
  assert.equal(codeGraphResultSummary('query', QUERY), '2 results');
  assert.equal(codeGraphResultSummary('query', QUERY_EMPTY), '0 results');
  assert.equal(codeGraphResultSummary('explore', EXPLORE), '2 symbols in 1 file');
  assert.equal(codeGraphResultSummary('explore', EXPLORE_PINNED), '1 symbol in 2 files', 'a further clause on the same sentence states more, not something else');
  // A shape the module cannot read yields no count at all.
  assert.equal(codeGraphResultSummary('query', 'some unexpected banner'), undefined);
  assert.equal(codeGraphResultSummary('explore', '**Exploration: alpha**'), undefined);
  assert.equal(codeGraphResultSummary('init', QUERY), undefined);
  assert.deepEqual(codeGraphCollapsedRows('query', QUERY, false, false), { text: '→ 2 results', rows: 1, tail: false });
  assert.deepEqual(codeGraphCollapsedRows('explore', EXPLORE, false, false), { text: '→ 2 symbols in 1 file', rows: 1, tail: false });
});

test('an unreadable shape keeps the rows it printed, and a failure its reason', () => {
  const unknown = ['first printed row', 'second printed row'].join('\n');
  assert.deepEqual(codeGraphCollapsedRows('query', unknown, false, false), { text: unknown, rows: 3, tail: true });
  const failed = codeGraphCollapsedRows('init', INIT_FAILED, true, false);
  assert.match(failed.text, /Failed: EACCES/);
  assert.match(failed.text, /run "codegraph init" again/, 'the instruction the program printed stays with the reason');
  // A withheld card draws no rows, but a failure always says why.
  assert.equal(codeGraphCollapsedRows('query', QUERY, false, true), undefined);
  assert.match(codeGraphCollapsedRows('init', INIT_FAILED, true, true).text, /Failed:/);
  // An empty result is no row at all, not a zero it did not state.
  assert.equal(codeGraphCollapsedRows('query', '  \n\n', false, false), undefined);
});

test('the preview keeps the last rows it printed and drops the progress box', () => {
  assert.equal(codeGraphPreview(INIT_FRESH), ['◆  Indexed 1 files', '●  3 nodes, 2 edges in 208ms', '└  Done'].join('\n'));
  assert.equal(codeGraphPreview('', 3), '');
  assert.equal(codeGraphPreview('a\nb\nc\nd', 2), 'c\nd');
});

test('the identity reads the operation and query from the bash command', () => {
  assert.deepEqual(codegraphCallFromCommand('codegraph init /tmp/ws'), { operation: 'init' });
  assert.deepEqual(codegraphCallFromCommand('codegraph sync'), { operation: 'sync' });
  assert.deepEqual(codegraphCallFromCommand('codegraph query --path /tmp/ws --limit 5 -- alpha'), { operation: 'query', query: 'alpha' });
  assert.deepEqual(codegraphCallFromCommand('codegraph explore --path /tmp/ws --max-files 5 -- "a b"'), { operation: 'explore', query: 'a b' });
  // Without a `--` separator only a lone payload is readable; flags are never guessed into the query.
  assert.deepEqual(codegraphCallFromCommand('codegraph query alpha'), { operation: 'query', query: 'alpha' });
  assert.deepEqual(codegraphCallFromCommand('codegraph query --path /tmp/ws alpha'), { operation: 'query' });
  // A composition belongs to its last CodeGraph step.
  assert.deepEqual(codegraphCallFromCommand('cd /tmp/ws && codegraph init'), { operation: 'init' });
  assert.deepEqual(codegraphCallFromCommand('CI=1 codegraph init'), { operation: 'init' });
  assert.deepEqual(codegraphCallFromCommand('/usr/local/bin/codegraph init'), { operation: 'init' });
  assert.deepEqual(codegraphCallFromCommand('codegraph explore auth && git status'), { operation: 'explore', query: 'auth' });
  assert.equal(codegraphCallDetail({ operation: 'init' }), 'init');
  assert.equal(codegraphCallDetail({ operation: 'query', query: 'alpha' }), 'query alpha');
});

test('every codegraph invocation is a CodeGraph call, whatever its subcommand or composition', () => {
  // The deciding fact is that `codegraph` is the command word of a segment: no
  // operation is read for the card's heading, so a subcommand this reader cannot
  // interpret, a flags-only invocation and several subcommands in one command all
  // count — and none of them needs an operation to be drawn.
  for (const [command, expected] of [
    ['codegraph', {}],
    ['codegraph --help', {}],
    ['codegraph --version', {}],
    ['codegraph status', { operation: 'status' }],
    ['codegraph callers worktreeListView', { operation: 'callers' }],
    ['codegraph node warpPendingGate', { operation: 'node' }],
    ['codegraph status 2>&1 | head -40', { operation: 'status' }],
    ['codegraph init && ./script', { operation: 'init' }],
    ['codegraph init; rm -rf src', { operation: 'init' }],
    // A package runner that executes the program it names is the program too.
    ['npx codegraph status', { operation: 'status' }],
    ['pnpm exec codegraph status', { operation: 'status' }],
  ]) {
    assert.deepEqual(codegraphCallFromCommand(command), expected, command);
  }

  // The commands a session really ran, one whole composition each.
  const helpAndStatus = 'codegraph --help 2>&1 | head -60; echo "--- STATUS ---"; codegraph status 2>&1 | head -40';
  assert.deepEqual(codegraphCallFromCommand(helpAndStatus), { operation: 'status' }, 'the last CodeGraph step names the operation');
  const queries = [
    'echo "=== codegraph query cardBodyRows ==="; codegraph query cardBodyRows 2>&1 | head -20; echo;',
    'echo "=== codegraph callers worktreeListView ==="; codegraph callers worktreeListView 2>&1 | head -20; echo;',
    'echo "=== codegraph node warpPendingGate ==="; codegraph node warpPendingGate 2>&1 | head -40',
  ].join(' ');
  assert.equal(codegraphCallFromCommand(queries) !== undefined, true, 'a sequence of CodeGraph steps is one CodeGraph call');
});

test('S5: any segment whose program is codegraph is a CodeGraph call, with its arguments', () => {
  for (const [command, expected] of [
    ['codegraph', {}],
    ['codegraph status .', { operation: 'status' }],
    ['codegraph status', { operation: 'status' }],
    ['/usr/local/bin/codegraph status .', { operation: 'status' }],
    ['npx codegraph status .', { operation: 'status' }],
    ['pnpm exec codegraph status .', { operation: 'status' }],
    ['yarn codegraph status .', { operation: 'status' }],
    ['yarn exec codegraph status .', { operation: 'status' }],
    ['bunx codegraph status .', { operation: 'status' }],
    ['cd /tmp/ws && codegraph status .', { operation: 'status' }],
    ['codegraph status .; echo done', { operation: 'status' }],
    ['codegraph status . | head', { operation: 'status' }],
    ['codegraph status . || true', { operation: 'status' }],
  ]) {
    assert.deepEqual(codegraphCallFromCommand(command), expected, command);
  }

  // A string or a different program that merely mentions it is never the program.
  for (const command of ['echo codegraph', 'echo "codegraph status ."', 'git -C codegraph status', 'node codegraph.js init', 'cat codegraph status .']) {
    assert.equal(codegraphCallFromCommand(command), undefined, command);
  }
});

test('S6: the explored project is a last path segment, and only when it is not the session cwd', () => {
  const checkout = '/home/jona/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell';
  assert.equal(projectPathSegment(checkout, '/work/repo'), 'gentle-shell', 'the last segment, never the full path');
  assert.equal(projectPathSegment(`${checkout}/`, '/work/repo'), 'gentle-shell', 'a trailing slash is not part of the segment');
  assert.equal(projectPathSegment('C:\\work\\gentle-shell', 'C:\\other'), 'gentle-shell', 'either path separator');
  assert.equal(projectPathSegment('/work/repo', '/work/repo'), undefined, 'the session cwd names no other checkout');
  assert.equal(projectPathSegment('/work/repo/', '/work/repo'), undefined, 'a trailing slash does not make it another checkout');
  assert.equal(projectPathSegment('gentle-shell', '/work/repo/gentle-shell'), undefined, 'a bare name compares equal to the same name as cwd');
  assert.equal(projectPathSegment('gentle-shell', '/work/repo'), 'gentle-shell', 'a bare name elsewhere is another checkout');
  assert.equal(projectPathSegment(undefined, '/work/repo'), undefined);
  assert.equal(projectPathSegment('', '/work/repo'), undefined);
  assert.equal(projectPathSegment('   ', '/work/repo'), undefined);
  assert.equal(projectPathSegment(checkout, undefined), 'gentle-shell', 'a seam that cannot answer still names the explicit argument');
});

test('a command that merely mentions codegraph is not a CodeGraph call', () => {
  for (const command of [
    'echo codegraph init',
    'git log --grep codegraph',
    'cat codegraph.json',
    'node codegraph.js init',
    'mytool codegraph init',
    'codegraph-cli init',
    'pnpm test',
    'pnpm test && ls',
    'grep -r codegraph src',
    '',
  ]) {
    assert.equal(codegraphCallFromCommand(command), undefined, command);
  }
  // A value that is not a command string is no call, and never throws.
  for (const value of [undefined, null, 42, {}, []]) assert.equal(codegraphCallFromCommand(value), undefined);
});

test('tool output reaches the card as text, without the terminal sequences around it', () => {
  assert.equal(cardText('\u001B[36mSearch\u001B[39m\u0000 \u001B]0;title\u0007'), 'Search ');
  const coloured = `\u001B[36mSearch Results for "alpha":\u001B[39m\n\nfunction    alpha\n  src/a.ts:1`;
  assert.equal(codeGraphResultSummary('query', cardText(coloured)), '1 result');
});

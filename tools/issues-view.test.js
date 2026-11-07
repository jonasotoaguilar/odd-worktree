'use strict';
// T2 (issues-panel S1,S3) tests: the migrated lib/issues-view.js — the pure
// four-bucket issues overlay (list on the left, issue detail on the right) that
// `/issues` mounts once that command is wired. The view moved whole from the
// source package's issues panel, so these tests pin the same contract there.
//
// Contract under test, as observable output only: the component renders
// exactly the requested rows at the requested width; tabs carry counts;
// search opens/filters/leaves keeping the filter; pagination bounds and the
// totals line; selection movement; right-pane scroll to the last line;
// labels/state/author/dates/reactions/comments; label editor; comment
// input; close confirm; the lazy page/label loader seams (S19);
// open-only listing with no state toggle (S10a); empty/error/
// gh-unavailable states; no key outside S8 mutates state.
//
// S9/S10/S11/S13/S14/S15 additions: the fourth `All` bucket, a visited tab that
// reuses its rows and page, the fixed page indicator on the search row, the
// server search seam (query in every page request, no local re-filter, cursors
// bound to their query, stale answers dropped), and the write lock with the
// comment caret.
//
// S17: the generic `?` key-help overlay is gone; the footer legend is the
// only key reference.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createIssuesView } = require('../lib/issues-view.js');
const ghIssues = require('../lib/gh-issues.js');
const layout = require('../lib/view-layout.js');

// Optional real host helpers, guarded exactly like tools/odd-view.test.js:
// CI installs no dependencies, so the byte-level key assertions run only
// when the installed matcher resolves and skip honestly when it does not.
let realTui = null;
try {
  realTui = require('@earendil-works/pi-tui');
} catch {
  realTui = null;
}

afterEach(() => {
  ghIssues.setGhRunner(null);
});

function strip(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

const helpers = {
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// S11: a theme that RECORDS which role it was asked to paint each string with
// and paints every role with its own SGR code, so a rendered line can be read
// for the ROLE behind a token instead of trusting an eyeballed colour. A role
// the map does not name still gets its own code, so an unexpected role shows up
// instead of passing silently.
const ROLE_SGR = { accent: 96, customMessageLabel: 33, muted: 90, dim: 2, border: 34, error: 91, text: 39, mdHeading: 35 };
// T9 (S13): the title role is `customMessageLabel`, the one the Pi Agents view
// paints its own frame title with (gentle-pi/lib/agents-view.ts:42,437), so the
// expectations below name the role LITERALLY instead of reading it back out of
// the table they are meant to pin. `TITLE_PAINT` is the raw escape a recording
// theme emits for that role + bold.
const TITLE_PAINT = '\x1b[1m\x1b[33m';
const CLOSE_PAINT = '\x1b[0m\x1b[22m';

function recordingTheme() {
  const calls = [];
  const code = (role) => ROLE_SGR[role] ?? 95;
  return {
    calls,
    fg(role, text) {
      const value = String(text);
      calls.push({ role, text: value });
      return `\x1b[${code(role)}m${value}\x1b[0m`;
    },
    bold(text) {
      const value = String(text);
      calls.push({ role: 'bold', text: value });
      return `\x1b[1m${value}\x1b[22m`;
    },
    bg(role, text) {
      calls.push({ role: `bg:${role}`, text: String(text) });
      return String(text);
    },
  };
}

// S16: every permission the editors gate on, confirmed true. Fixtures that
// mean to open an editor carry this explicitly; a fixture without it is a
// repository where editing is not permitted.
const EDITABLE = { canEditLabels: true, canEditAssignees: true, canCreateLabels: true, canCloseIssues: true };

function issue(number, overrides = {}) {
  return {
    number,
    title: `issue title ${number}`,
    state: 'open',
    author: 'octo',
    labels: [{ name: 'bug' }],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 1800_000).toISOString(),
    commentsCount: 0,
    reactions: { total: 0, plusOne: 3 },
    url: `https://example.test/i/${number}`,
    body: `body of issue ${number}`,
    ...overrides,
  };
}

function pagesOf(lists) {
  const names = ['My issues', 'Assigned', 'Involved'];
  return lists.map((rows, at) => ({ id: `p${at}`, label: names[at], issues: rows, total: rows.length }));
}

// One server page answer and one issue row carrying its cursor, as the
// `loadIssuePage` seam delivers them.
function pageResult(issues, extra = {}) {
  return { ok: true, issues, total: issues.length, hasNextPage: false, ...extra };
}

function cursorRow(cursor, row) {
  return { ...row, cursor };
}

function makeView(opts = {}) {
  const paints = [];
  let settled = 'pending';
  const actions = opts.actions || {};
  const view = createIssuesView({
    pages: opts.pages,
    issues: opts.issues,
    loadIssue: opts.loadIssue,
    loadPages: opts.loadPages,
    loadIssuePage: opts.loadIssuePage,
    loadLabels: opts.loadLabels,
    loadAssignees: opts.loadAssignees,
    assigned: opts.assigned,
    saveAssignment: opts.saveAssignment,
    actions,
    labels: opts.labels,
    helpers: opts.helpers || helpers,
    theme: opts.theme || plainTheme,
    rowsAvailable: () => opts.rows || 24,
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
    checkoutName: opts.checkoutName,
    ghAvailable: opts.ghAvailable,
    loadError: opts.loadError,
    assignmentEnabled: opts.assignmentEnabled,
    // S9: the remote-search debounce clock is injected, so a burst of typing is
    // observed without wall-clock waits.
    scheduleQuery: opts.scheduleQuery,
    cancelSchedule: opts.cancelSchedule,
  });
  return { view, done: () => settled, paints };
}

// A scheduler the test owns: nothing fires until `fire()` is called, so the
// debounce window (and any stale callback inside it) is fully deterministic.
function manualScheduler() {
  const entries = [];
  return {
    entries,
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs, cancelled: false };
      entries.push(entry);
      return entry;
    },
    cancel: (entry) => { if (entry) entry.cancelled = true; },
    live: () => entries.filter((entry) => !entry.cancelled),
    fire() {
      const live = entries.filter((entry) => !entry.cancelled);
      for (const entry of live) entry.fn();
      return live.length;
    },
  };
}

// A promise whose settlement the test owns, so no expectation depends on
// wall-clock timing.
function deferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pagesResult(lists, extra = {}) {
  const names = ['My issues', 'Assigned', 'Involved'];
  return {
    ok: true,
    pages: lists.map((rows, at) => ({ id: `p${at}`, label: names[at], issues: rows, total: rows.length })),
    ...extra,
  };
}

// S3: the issues reader asks view-layout for the smaller 30% list share, so
// every geometry helper here reads the same allocation the view paints.
function readerPanes(width) {
  return layout.paneWidths(layout.innerWidth(width), { listShare: layout.READER_LIST_SHARE });
}

function bodyOf(view, width) {
  const lines = view.render(width);
  for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `not ${width} wide: "${strip(line)}"`);
  return strip(lines.join('\n'));
}

// The RIGHT (document) pane of every body row, one entry per row, so a test can
// name WHICH row a token landed on instead of only that it was painted.
function rightRows(view, width, rows = 24) {
  const panes = readerPanes(width);
  return view.render(width)
    .slice(4, Math.max(4, rows - 2))
    .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join('').trimEnd());
}

// The body row the caret is painted on. Written as a helper because the defect
// these tests pin is WHICH row carries it, not that it is painted at all.
function caretRow(rows) {
  const at = rows.findIndex((row) => row.includes('█'));
  assert.notEqual(at, -1, `no caret painted in the pane: ${JSON.stringify(rows)}`);
  return at;
}

// Only the LEFT pane of every body row, so a list assertion can never be
// satisfied by the preview on the right: S3 puts titles left and the number
// right, and the two are trimmed to different widths.
function leftColumn(view, width, rows = 24) {
  const panes = readerPanes(width);
  return view.render(width)
    .slice(4, Math.max(4, rows - 2))
    .map((line) => [...strip(line)].slice(2, 2 + panes.left).join(''))
    .join('\n');
}

describe('issues view tabs and list', () => {
  test('renders the framed card with the three tabs and their counts', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1), issue(2)], [issue(3)], []]),
      issues: [issue(1), issue(2)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    // Width 124: the footer grew by the two mandated copy keys (K4), so
    // the card needs the extra room to show its full tail incl. esc close.
    const body = bodyOf(view, 124);
    assert.match(body, /My issues.*2/, 'first tab carries its count');
    assert.match(body, /Assigned.*1/, 'second tab carries its count');
    assert.match(body, /Involved.*0/, 'third tab carries its count');
    assert.match(body, /issue title 1/, 'the current page rows are listed');
    assert.match(body, /esc close/, 'the footer names the close key');
  });

  test('tab switches buckets (D3)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [issue(2)], [issue(3)]]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /issue title 1/);
    view.handleInput('tab');
    assert.equal(view.state.page, 1);
    assert.match(bodyOf(view, 100), /issue title 2/);
    view.handleInput('shift+tab');
    assert.equal(view.state.page, 0);
  });

  test('up/down and j/k move the selection; home/end jump', async () => {
    const rows = [issue(1), issue(2), issue(3)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('down');
    assert.equal(view.state.index, 1);
    view.handleInput('j');
    assert.equal(view.state.index, 2);
    view.handleInput('up');
    assert.equal(view.state.index, 1);
    view.handleInput('k');
    assert.equal(view.state.index, 0);
    view.handleInput('end');
    assert.equal(view.state.index, 2);
    view.handleInput('home');
    assert.equal(view.state.index, 0);
  });

  test('the tab carries the issue count and the fixed indicator only the page position', async () => {
    const rows = [issue(1, { title: 'alpha bug' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'alpha bug' }), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /My issues \(1\)/, 'the open tab names its count');
    assert.ok(!/page/i.test(strip(view.render(100)[1])), 'the search row carries no page marker (S3)');
    assert.ok(!leftColumn(view, 100, 12).includes('page'), 'the list spends no row on the indicator');
    assert.ok(!/\b1 issues?\b/.test(body.replace('My issues', '')), 'no second total is repeated below the list');
  });

  test('the window follows the body budget and scrolls instead of paging (S3)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => issue(i + 1));
    const { view } = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    // The body is 12 rows minus the 6 frame rows, so six single-row titles fit
    // and the rest scroll into view instead of moving to a second page.
    const visible = () => leftColumn(view, 100, 12).split('\n').map((row) => row.trim()).filter(Boolean);
    assert.equal(visible().length, 6, 'the window holds exactly the body budget');
    assert.equal(view.state.listStart, 0, 'the window starts at the first row');
    assert.ok(!/page/i.test(bodyOf(view, 100)), 'no page marker is printed');
    assert.ok(!/\b10 issues\b/.test(bodyOf(view, 100)), 'the count is not repeated under the list');
    view.handleInput(']');
    assert.equal(view.state.listStart, 4, '→ scrolls to the last full window of the one list');
    assert.equal(visible().at(-1), 'issue title 10', 'the last row is reachable by scrolling');
    view.handleInput('[');
    assert.equal(view.state.listStart, 0, '← scrolls back to the first screen');
    view.handleInput('[');
    assert.equal(view.state.listStart, 0, '← never scrolls before the first row');
  });

  test('the state filter is gone: f changes nothing and closed rows never list (S10a)', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const before = bodyOf(view, 100);
    assert.match(before, /issue title 1/);
    assert.ok(!before.includes('issue title 2'), 'closed rows are never listed');
    const snapshot = JSON.stringify(view.state);
    view.handleInput('f');
    assert.equal(JSON.stringify(view.state), snapshot, 'f no longer toggles any state');
    assert.equal(bodyOf(view, 100), before, 'f repaints nothing');
    assert.ok(!/f[:(]/.test(before), 'no state indicator survives in the frame');
  });
});

describe('issues view search', () => {
  test('the idle search row reads as a search widget, never the broken "T// search"', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.ok(!body.includes('T// search'), 'the broken hint is gone');
    assert.match(body, /› Search/, 'the idle row names the Search widget');
    assert.ok(!body.includes('(T)') && !body.includes('(t)'), 'no parenthetical hint sits above the footer');
    assert.match(bodyOf(view, 160), /t search/, 'the footer names the search key in lowercase');
  });

  test('lowercase t opens the search and uppercase T keeps working', async () => {
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.render(160);
    view.handleInput('t');
    assert.equal(view.state.searching, true, 'lowercase t opens the search box');
    view.handleInput('escape');
    view.handleInput('T');
    assert.equal(view.state.searching, true, 'uppercase T still opens it');
  });

  test('Delete clears the whole active query, Backspace one character, and only typing advertises clearing', async () => {
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'alpha cr') view.handleInput(ch);
    const footerOf = () => strip(view.render(80).at(-2));
    assert.match(bodyOf(view, 80), /› alpha cr█/);
    assert.match(footerOf(), /del clear/, 'the footer advertises clearing while the input is active');
    assert.ok(!bodyOf(view, 80).includes('beta typo'), 'the query filters the other row out');
    view.handleInput('backspace');
    assert.equal(view.state.query, 'alpha c', 'Backspace deletes one character');
    view.handleInput('delete');
    assert.equal(view.state.query, '', 'Delete clears the WHOLE query');
    const body = bodyOf(view, 80);
    assert.match(body, /› █/, 'the input row shows the emptied query');
    assert.match(footerOf(), /del clear/, 'the clearing hint stays while the input is still active');
    assert.match(body, /beta typo/, 'clearing the query lists every row again');
    view.handleInput('enter');
    assert.ok(!footerOf().includes('del clear'), 'the clearing hint leaves with the input');
  });

  test('T opens the box, typing filters live, Enter leaves keeping the filter', async () => {
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    assert.equal(view.state.searching, true);
    for (const ch of 'beta') view.handleInput(ch);
    const filtered = bodyOf(view, 100);
    assert.match(filtered, /issue title 2/);
    assert.ok(!filtered.includes('alpha crash'), 'live filter hides the other row');
    view.handleInput('enter');
    assert.equal(view.state.searching, false);
    assert.equal(view.state.query, 'beta', 'the filter is kept after leaving');
    assert.ok(!bodyOf(view, 100).includes('alpha crash'));
  });

  test('/ also opens; Esc leaves keeping the filter; @ and # tokens filter', async () => {
    const rows = [
      issue(7, { title: 'login flow', author: 'alice' }),
      issue(8, { title: 'logout flow', author: 'bob' }),
    ];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('/');
    for (const ch of '@bob') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /issue title 8/);
    view.handleInput('escape');
    assert.equal(view.state.searching, false);
    assert.equal(view.state.query, '@bob');
    view.handleInput('T');
    view.state.query = '';
    view.state.searching = true;
    for (const ch of '#7') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /issue title 7/);
    assert.ok(!bodyOf(view, 100).includes('issue title 8'), '#number selects the issue');
  });
});

describe('issues view right pane', () => {
  test('renders labels, state, author, dates, reactions, body and separated comments', async () => {
    const comments = [
      { id: 1, author: 'bob', createdAt: new Date(Date.now() - 600_000).toISOString(), body: 'first comment', reactions: { total: 1, plusOne: 2 } },
      { id: 2, author: 'carol', createdAt: new Date(Date.now() - 300_000).toISOString(), body: 'second comment', reactions: { total: 0, plusOne: 0 } },
    ];
    const { view } = makeView({
      pages: pagesOf([[issue(1, { title: 'Big bug', labels: [{ name: 'bug' }, { name: 'urgent' }] })], [], []]),
      issues: [issue(1, { title: 'Big bug', labels: [{ name: 'bug' }, { name: 'urgent' }] })],
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'Big bug', labels: [{ name: 'bug' }, { name: 'urgent' }] }), comments }),
      rows: 30,
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /Big bug/);
    assert.match(body, /open/);
    assert.match(body, /bug/, 'labels row names the labels');
    assert.match(body, /urgent/);
    assert.match(body, /octo/, 'author is shown');
    assert.match(body, /created/, 'created date is shown');
    assert.match(body, /updated/, 'updated date is shown');
    assert.match(body, /👍 3/, 'reactions are shown');
    assert.match(body, /2 comments/);
    assert.match(body, /first comment/);
    assert.match(body, /second comment/);
    assert.match(body, /bob/);
    assert.match(body, /carol/);
  });

  test('ctrl+shift+j/pgDn scroll to the last line of a long issue; home resets to the top', async () => {
    const longBody = Array.from({ length: 100 }, (_, i) => `body line ${i + 1}`).join('\n');
    const { view } = makeView({
      pages: pagesOf([[issue(1, { body: longBody })], [], []]),
      issues: [issue(1, { body: longBody })],
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('ctrl+shift+j');
    assert.ok(view.state.scroll > 0, 'ctrl+shift+j scrolls the issue pane');
    for (let i = 0; i < 20 && !bodyOf(view, 100).includes('body line 100'); i += 1) view.handleInput('pagedown');
    const bottom = bodyOf(view, 100);
    assert.match(bottom, /body line 100/, 'the last line is reachable via the pane scroll keys');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0);
  });

  test('a failed loadIssue renders its error instead of fake content', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: () => ({ ok: false, error: 'boom' }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /boom/);
  });
});

// S1: extended paging and printable Shift+J/K share a full-page action;
// ctrl+d/u retain their half-page action and j/k select. These also exercise
// the installed matcher with the bytes a terminal emits.
describe('round3: every tab is read at open, and a switch never refetches', { concurrency: false }, () => {
  // The reported defect: opening Issues showed `All (0)` while the repository
  // had open issues, and each tab refetched on every switch. The reader must
  // read all four buckets ONCE when it opens, show their real totals, and reuse
  // them while switching.
  function serverView(extra = {}) {
    const requests = [];
    const queue = [];
    const view = createIssuesView({
      helpers,
      prefetchBuckets: true,
      rowsAvailable: () => 24,
      requestRender: () => {},
      done: () => {},
      loadIssuePage: (request) => {
        requests.push(request);
        return new Promise((resolve) => queue.push({ request, resolve }));
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...extra,
    });
    return { view, requests, queue };
  }

  function answer(queue, bucketId, numbers, total = numbers.length) {
    const at = queue.findIndex((entry) => entry.request.bucketId === bucketId);
    assert.ok(at >= 0, `no pending request for ${bucketId}`);
    const [entry] = queue.splice(at, 1);
    entry.resolve({ ok: true, issues: numbers.map((n) => ({ ...issue(n), cursor: `c${n}` })), total, hasNextPage: false });
  }

  test('all four buckets are requested when the view opens', async () => {
    const { view, requests } = serverView();
    view.render(120);
    await tick();
    assert.deepEqual(requests.map((entry) => entry.bucketId).sort(), ['all', 'assigned', 'involved', 'mine']);
  });

  test('an unvisited tab shows its real total instead of a false zero, and switching reads nothing', async () => {
    const { view, requests, queue } = serverView();
    // ONE layout: a resize legitimately invalidates recorded page boundaries,
    // so the reuse assertion belongs to a stable viewport.
    view.render(160);
    await tick();
    answer(queue, 'mine', [1]);
    answer(queue, 'assigned', []);
    answer(queue, 'involved', []);
    answer(queue, 'all', [1], 1);
    await tick();
    const frame = bodyOf(view, 160);
    assert.match(frame, /All \(1\)/, `All reports the repository total: ${frame.split('\n')[2]}`);
    assert.match(frame, /My issues \(1\)/, 'the active bucket keeps its own count');
    const before = requests.length;
    for (let step = 0; step < 3; step += 1) {
      view.handleInput('tab');
      await tick();
    }
    assert.equal(requests.length, before, 'switching between loaded tabs reads nothing again');
  });

  test('a bucket that has not answered yet is unknown, never a zero', async () => {
    const { view, queue } = serverView();
    view.render(120);
    await tick();
    // The active bucket answers; the other three are still in flight.
    answer(queue, 'mine', [1]);
    await tick();
    const tabs = bodyOf(view, 160).split('\n').find((line) => line.includes('My issues')) ?? '';
    assert.match(tabs, /Assigned \(–\)/, `unread bucket is unknown: ${tabs}`);
    assert.doesNotMatch(tabs, /Assigned \(0\)/, 'an unread bucket never claims zero');
  });
});

describe('issues view preview scroll variants (S15)', () => {
  const skipReal = realTui ? false : 'requires @earendil-works/pi-tui';
  const longBody = Array.from({ length: 100 }, (_, i) => `body line ${i + 1}`).join('\n');

  function realKeyView() {
    return makeView({
      helpers: realTui,
      pages: pagesOf([[issue(1, { body: longBody }), issue(2, { body: longBody })], [], []]),
      issues: [issue(1, { body: longBody }), issue(2, { body: longBody })],
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
  }

  test('ctrl+d/ctrl+u and shifted J/K scroll the pane, j/k still move the list', { skip: skipReal }, async () => {
    const { view } = realKeyView();
    await tick();
    view.render(100);
    view.handleInput('\x1b[6~');            // PageDown: the full-page step
    const paged = view.state.scroll;
    assert.ok(paged > 0, 'PageDown scrolls the pane');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home returns to the top first');
    view.handleInput('\x04');               // ctrl+d
    const half = view.state.scroll;
    assert.ok(half > 0, 'raw ctrl+d scrolls the pane down');
    assert.ok(half < paged, 'ctrl+d moves half a page, less than PageDown');
    assert.equal(view.state.index, 0, 'ctrl+d never moves the list selection');
    view.handleInput('\x15');               // ctrl+u
    assert.equal(view.state.scroll, 0, 'raw ctrl+u scrolls the pane back up');
    view.handleInput('\x1b[100;5u');        // Kitty ctrl+d
    assert.ok(view.state.scroll > 0, 'Kitty ctrl+d scrolls the pane down');
    view.handleInput('\x1b[117;5u');        // Kitty ctrl+u
    assert.equal(view.state.scroll, 0, 'Kitty ctrl+u scrolls the pane back up');
    view.handleInput('\x04');
    view.handleInput('K');                  // shifted K scrolls up
    assert.equal(view.state.scroll, 0, 'K scrolls the pane back up');
    view.handleInput('J');                  // shifted J scrolls down
    assert.ok(view.state.scroll > 0, 'J scrolls the pane down');
    assert.equal(view.state.index, 0, 'J never moves the list selection');
    view.handleInput('home');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'j still moves the list selection');
    view.handleInput('k');
    assert.equal(view.state.index, 0, 'k still moves the list selection');
    view.handleInput('\n');                 // legacy Enter is not a scroll alias
    assert.equal(view.state.scroll, 0, 'LF never scrolls the pane');
    view.handleInput('\x0b');
    assert.equal(view.state.scroll, 0, 'legacy ctrl+k never scrolls the pane');
    view.handleInput('\x1b[6~');
    assert.equal(view.state.scroll, paged, 'PageDown still scrolls a full page');
    view.handleInput('\x1b[5~');
    assert.equal(view.state.scroll, 0, 'PageUp still scrolls the page back');
  });
});

// S10b: the issues viewer is read-only with respect to the checkout↔issue
// association. The options the existing callers still pass (`assigned`,
// `saveAssignment`, `assignmentEnabled`) are accepted and ignored: no mark,
// no toggle, no save, no unsaved claim — and no key that writes.
describe('issues view read-only association (S10b)', () => {
  const ASSIGNED = [1];

  function inertView(overrides = {}) {
    const saves = [];
    const rows = [issue(1), issue(2)];
    const made = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      assigned: ASSIGNED,
      saveAssignment: (nums) => { saves.push(nums); return { ok: true }; },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
      ...overrides,
    });
    return { ...made, saves, rows };
  }

  test('no association mark, hint or unsaved claim renders even when assigned and saveAssignment are passed', async () => {
    const { view } = inertView({ assignmentEnabled: true });
    await tick();
    for (const width of [80, 160]) {
      const body = bodyOf(view, width);
      assert.ok(!body.includes('space assign'), `width ${width}: no Space hint`);
      assert.ok(!body.includes('ctrl+s save'), `width ${width}: no save hint`);
      assert.ok(!body.includes('unsaved'), `width ${width}: no unsaved claim`);
      assert.ok(!/\d+ assigned/.test(body), `width ${width}: no assigned count`);
      // S3: the left row is the title alone — the number lives in the preview.
      const left = leftColumn(view, width);
      assert.match(left, /issue title 1/, 'the issue row still renders');
      assert.ok(!left.includes('#1'), 'no issue number in the left list');
      assert.ok(!/[✓✎]/.test(left), 'no assignment mark on the row');
      assert.match(left, /issue title 2/, 'the other row still renders');
      assert.ok(!/[✓✎]/.test(left), 'no assignment mark on the other row either');
    }
    assert.match(bodyOf(view, 160), /x close/, 'the footer legend stays');
  });

  test('space and ctrl+s change nothing: no save call, no state change, no repaint difference', async () => {
    const { view, saves } = inertView();
    await tick();
    const snapshot = JSON.stringify(view.state);
    const rendered = view.render(80).join('\n');
    for (const key of ['space', ' ', 'ctrl+s']) view.handleInput(key);
    await tick();
    assert.deepEqual(saves, [], 'the injected save callback is never reached');
    assert.equal(JSON.stringify(view.state), snapshot, 'no state changed');
    assert.equal(view.render(80).join('\n'), rendered, 'nothing repainted differently');
    assert.ok(!bodyOf(view, 80).includes('unsaved'), 'no pending-assignment claim appears');
    assert.ok(!/[✓✎]/.test(bodyOf(view, 80)), 'no assignment mark appears');
  });

  test('the association options are inert: the frame is identical with them and with the gate off', async () => {
    const common = {
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    };
    const plain = makeView(common);
    const passed = makeView({ ...common, assigned: ASSIGNED, saveAssignment: () => ({ ok: true }), assignmentEnabled: true });
    const gatedOff = makeView({ ...common, assigned: ASSIGNED, saveAssignment: () => ({ ok: true }), assignmentEnabled: false });
    await tick();
    const expected = plain.view.render(80).join('\n');
    assert.equal(passed.view.render(80).join('\n'), expected, 'assigned/saveAssignment/assignmentEnabled change no cell');
    assert.equal(gatedOff.view.render(80).join('\n'), expected, 'assignmentEnabled false changes no cell either');
  });

  test('reading, search and the GitHub actions stay usable with the options passed', async () => {
    const writes = [];
    const { view } = inertView({
      assignmentEnabled: false,
      actions: {
        setState: () => { writes.push('setState'); return { ok: true }; },
        postComment: () => { writes.push('postComment'); return { ok: true }; },
        editLabels: () => { writes.push('editLabels'); return { ok: true }; },
        openBrowser: () => { writes.push('openBrowser'); return { ok: true }; },
      },
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'title 2') view.handleInput(ch);
    assert.match(bodyOf(view, 80), /issue title 2/);
    assert.ok(!bodyOf(view, 80).includes('issue title 1'), 'search still filters');
    view.handleInput('enter');
    view.handleInput('T');
    for (let i = 0; i < 7; i += 1) view.handleInput('backspace');
    view.handleInput('enter');
    assert.match(leftColumn(view, 80), /issue title 1/, 'the query clears again');
    const beforeF = bodyOf(view, 80);
    view.handleInput('f');
    assert.equal(bodyOf(view, 80), beforeF, 'the removed state key repaints nothing');
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm', 'close still asks first');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(writes, ['setState'], 'the GitHub action ran, the association did not');
  });
});

describe('issues view editors and confirmations', () => {
  test('L opens the label editor; toggle plus create plus ctrl+s applies', async () => {
    const calls = [];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      actions: {
        editLabels: (number, add, remove, created) => { calls.push([number, add, remove, created]); return { ok: true }; },
      },
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: { canEditLabels: true, canCreateLabels: true } }),
        comments: [],
      }),
    });
    await tick();
    view.handleInput('L');
    assert.equal(view.state.mode, 'labels');
    let body = bodyOf(view, 100);
    assert.match(body, /bug/);
    assert.match(body, /docs/);
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1, 'one apply call');
    assert.deepEqual(calls[0][0], 1);
    assert.ok(calls[0][1].includes('docs'), 'docs was added');
    assert.equal(view.state.mode, 'list', 'success closes the editor');
  });

  test('a failed label apply keeps the editor and shows the error', async () => {
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      actions: { editLabels: () => ({ ok: false, error: 'nope' }) },
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: { canEditLabels: true, canCreateLabels: true } }),
        comments: [],
      }),
    });
    await tick();
    view.handleInput('L');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'labels', 'failure keeps the editor open');
    assert.match(bodyOf(view, 100), /nope/);
  });

  test('c opens the comment input; Enter is a newline, ctrl+s posts and refreshes the detail, esc asks before discarding', async () => {
    const calls = [];
    const loads = [];
    let comments = [];
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: {
        postComment: (number, text) => {
          calls.push([number, text]);
          comments = [{ author: 'octo', createdAt: new Date().toISOString(), body: text }];
          return { ok: true };
        },
      },
      loadIssue: (n, detailOptions) => {
        loads.push([n, detailOptions]);
        return { ok: true, issue: issue(n), comments: comments.slice() };
      },
    });
    await tick();
    view.handleInput('c');
    assert.equal(view.state.mode, 'comment');
    for (const ch of 'hi') view.handleInput(ch);
    view.handleInput('enter');
    for (const ch of 'there') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /hi/);
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [1, 'hi\nthere']);
    assert.equal(view.state.mode, 'list');
    const refreshes = loads.filter(([, detailOptions]) => detailOptions && detailOptions.refresh === true);
    assert.deepEqual(refreshes.map(([number]) => number), [1], 'the posted issue detail is refetched, never served from cache');
    const posted = bodyOf(view, 100);
    assert.match(posted, /hi/);
    assert.match(posted, /there/, 'the new comment is visible without reopening the issue');

    view.handleInput('c');
    for (const ch of 'draft') view.handleInput(ch);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc on a non-empty draft asks instead of discarding');
    assert.match(bodyOf(view, 100), /Discard this draft/, 'the ask names what is at stake');
    view.handleInput('y');
    assert.equal(view.state.mode, 'list', 'y discards the draft');
    assert.equal(calls.length, 1, 'discard posts nothing');
  });

  test('a failed refresh after a posted comment is visible and never claims updated data', async () => {
    let posted = false;
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: () => { posted = true; return { ok: true }; } },
      loadIssue: (n, detailOptions) => {
        if (posted && detailOptions && detailOptions.refresh === true) return { ok: false, error: 'gh timed out' };
        return { ok: true, issue: issue(n), comments: [] };
      },
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'still posted') view.handleInput(ch);
    view.handleInput('ctrl+s');
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /unreadable: gh timed out/, 'the failed refresh is visible');
    assert.match(body, /comment posted/, 'the posted result is reported truthfully');
    assert.ok(!body.includes('(end of issue)'), 'cached content is never presented as refreshed');
  });

  test('a failed comment post keeps the draft and shows the error', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: () => ({ ok: false, error: 'rate limited' }) },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'hey') view.handleInput(ch);
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'comment');
    assert.match(bodyOf(view, 100), /rate limited/);
  });

  test('x and X close the issue, and a closed issue leaves the open list (S10a)', async () => {
    const calls = [];
    const openRows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([openRows, [], []]),
      issues: openRows,
      actions: { setState: (number, state) => { calls.push([number, state]); return { ok: true }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    });
    await tick();
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm');
    assert.match(bodyOf(view, 100), /Confirm close #1/, 'the confirm names the close');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(calls, [[1, 'closed']], 'x closes through the injected action');
    const afterClose = bodyOf(view, 100);
    assert.ok(!leftColumn(view, 100).includes('issue title 1'), 'the closed issue leaves the open list at once');
    assert.match(afterClose, /My issues \(1\)/, 'the tab count drops with it');
    assert.match(leftColumn(view, 100), /issue title 2/, 'the remaining open issue stays listed');

    view.handleInput('X');
    assert.equal(view.state.mode, 'confirm', 'X asks the same close confirmation');
    assert.match(bodyOf(view, 100), /Confirm close #2/, 'X names a close, never a reopen');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(calls, [[1, 'closed'], [2, 'closed']], 'X closes too: the view has no reopen path');
    assert.match(bodyOf(view, 100), /no issues/, 'the emptied list says so honestly');
  });

  test('o opens in the browser without changing state; r reloads', async () => {
    let opened = null;
    let rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: {
        openBrowser: (number) => { opened = number; return { ok: true }; },
        reload: () => ({ ok: true, issues: [issue(1), issue(5, { title: 'fresh issue' })] }),
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const before = JSON.stringify({ page: view.state.page, index: view.state.index });
    view.handleInput('o');
    assert.equal(opened, 1);
    assert.equal(JSON.stringify({ page: view.state.page, index: view.state.index }), before);
    view.handleInput('r');
    await tick();
    assert.match(bodyOf(view, 100), /fresh issue/);
  });

  test('the generic ? help overlay is gone and the footer legend stays (S17)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    });
    await tick();
    const before = bodyOf(view, 160);
    assert.ok(!before.includes('? help'), 'no ? hint anywhere');
    assert.ok(!before.includes('Keys'), 'no key-help overlay before the key');
    view.handleInput('?');
    const after = bodyOf(view, 160);
    assert.equal(after, before, '? repaints nothing: there is no overlay to open');
    assert.equal(view.state.help, undefined, 'no help state survives');
    assert.match(after, /esc close/, 'the footer shortcut legend survives');
    assert.match(after, /x close/, 'the footer documents the close key');
    assert.ok(!after.includes('f open/closed'), 'the removed state-toggle key is gone from the legend');
  });
});

describe('issues view states and key discipline', () => {
  test('empty page renders the empty state, not fake rows', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 80), /no issues/i);
  });

  test('loadError renders the error state', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      loadError: 'network down',
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 80), /network down/);
  });

  test('gh unavailable renders its own state', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      ghAvailable: false,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 80), /gh unavailable/i);
  });

  test('end selects the last issue and leaves the detail scroll at the top', async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `body line ${i + 1}`).join('\n');
    const rows = [issue(1, { body: longBody }), issue(2, { body: longBody }), issue(3, { body: longBody })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('ctrl+shift+j');
    assert.ok(view.state.scroll > 0, 'precondition: the pane is scrolled');
    view.handleInput('end');
    assert.equal(view.state.index, 2, 'end selects the last issue');
    assert.equal(view.state.scroll, 0, 'end resets the newly selected issue to its top');
    const bottom = bodyOf(view, 100);
    assert.match(bottom, /body line 1/, 'the top of the last issue is shown, not the scrolled bottom');
  });

  test('home selects the first issue and leaves the detail scroll at the top', async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `body line ${i + 1}`).join('\n');
    const rows = [issue(1, { body: longBody }), issue(2, { body: longBody }), issue(3, { body: longBody })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('end');
    view.handleInput('ctrl+shift+j');
    assert.ok(view.state.scroll > 0, 'precondition: the pane is scrolled');
    view.handleInput('home');
    assert.equal(view.state.index, 0, 'home selects the first issue');
    assert.equal(view.state.scroll, 0, 'home resets the newly selected issue to its top');
    const top = bodyOf(view, 100);
    assert.match(top, /body line 1/, 'the top of the first issue is shown');
  });

  test('a bounded fetch marks the count on the tab and never repeats it below the list', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    const truncated = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length, truncated: true }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(truncated.view, 100), /My issues \(5\+\)/, 'the tab marks the bounded count');
    assert.ok(!/5\+ issues/.test(bodyOf(truncated.view, 100)), 'the bound is never repeated below the list');
    const plain = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(plain.view, 100), /My issues \(5\)/, 'a plain fetch renders the exact count');
    assert.ok(!bodyOf(plain.view, 100).includes('5+'), 'a plain fetch never carries the + marker');
  });

  test('esc closes with null; no key outside S8 changes state', async () => {
    const { view, done } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const snapshot = JSON.stringify(view.state);
    const rendered = view.render(80).join('\n');
    // `a` is no longer foreign: S16 binds it to the assignee editor (and it
    // stays inert for this permission-less fixture, which S16 covers).
    // ctrl+u/d are real half-page bindings, checked in the scroll tests.
    for (const key of ['e', 'p', 'z', 'd', 'w', 'v', 'u', 'g', 'i', 'm', 'h', 'b', 's', 'n', 'alt+x']) {
      view.handleInput(key);
    }
    assert.equal(JSON.stringify(view.state), snapshot, 'foreign keys change nothing');
    assert.equal(view.render(80).join('\n'), rendered, 'foreign keys repaint nothing');
    view.handleInput('escape');
    assert.equal(done(), null);
  });
});

describe('issues view relative dates past a month (adopted reference idea 2)', () => {
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const DAY = 86400_000;

  function datedView(createdAgo, updatedAgo) {
    return makeView({
      pages: pagesOf([[issue(1, { createdAt: at(createdAgo), updatedAt: at(updatedAgo) })], [], []]),
      issues: [issue(1, { createdAt: at(createdAgo), updatedAt: at(updatedAgo) })],
      rows: 30,
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { createdAt: at(createdAgo), updatedAt: at(updatedAgo) }),
        comments: [],
      }),
    });
  }

  test('renders mo and y units instead of an ISO date', async () => {
    const { view } = datedView(60 * DAY, 400 * DAY);
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /2mo ago/, 'sixty days renders as months');
    assert.match(body, /1y ago/, 'four hundred days renders as years');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(body), 'no ISO date fallback for old dates');
  });

  test('month/year boundaries cut at 30 days and 365 days', async () => {
    const first = datedView(29 * DAY, 29 * DAY);
    await tick();
    assert.match(bodyOf(first.view, 100), /29d ago/, 'twenty-nine days still renders as days');
    const second = datedView(30 * DAY, 364 * DAY);
    await tick();
    const middle = bodyOf(second.view, 100);
    assert.match(middle, /1mo ago/, 'thirty days renders as one month');
    assert.match(middle, /12mo ago/, '364 days still renders as months');
    const third = datedView(365 * DAY, 730 * DAY);
    await tick();
    const old = bodyOf(third.view, 100);
    assert.match(old, /1y ago/);
    assert.match(old, /2y ago/);
  });

  test('keeps just now, minutes, hours and days', async () => {
    const now = datedView(10_000, 5 * 60_000);
    await tick();
    const fresh = bodyOf(now.view, 100);
    assert.match(fresh, /just now/);
    assert.match(fresh, /5m ago/);
    const hours = datedView(3 * 3600_000, 9 * DAY);
    await tick();
    const older = bodyOf(hours.view, 100);
    assert.match(older, /3h ago/);
    assert.match(older, /9d ago/);
  });
});

describe('issues view detail assignees (adopted reference idea 1)', () => {
  test('the detail shows one assignee row when the issue is assigned', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 30,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { assignees: ['alice', 'bob'] }), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /assignees: alice, bob/);
  });

  test('the detail hides the assignee row when nobody is assigned', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 30,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.ok(!bodyOf(view, 100).includes('assignees'), 'no assignee row without assignees');
  });
});

describe('issues view preview metadata (S9)', () => {
  test('shows every assignee, projects and a nonzero linked PR count, and omits empty metadata', async () => {
    const full = issue(5, {
      assignees: [{ login: 'ann' }, { login: 'bob' }],
      projects: [{ title: 'Roadmap', url: 'https://example.test/p/1' }],
      linkedPullRequestCount: 2,
    });
    const rich = makeView({
      pages: pagesOf([[full], [], []]),
      issues: [full],
      loadIssue: () => ({ ok: true, issue: full, comments: [] }),
    });
    await tick();
    const body = bodyOf(rich.view, 120);
    assert.match(body, /assignees: ann, bob/, 'every assigned person is shown');
    assert.match(body, /projects: Roadmap/, 'the associated project is shown');
    assert.match(body, /linked PRs: 2/, 'the nonzero PR count is shown');

    const bare = issue(6, { metadataError: 'Project metadata is unavailable or incomplete (read:project)' });
    const empty = makeView({
      pages: pagesOf([[bare], [], []]),
      issues: [bare],
      loadIssue: () => ({ ok: true, issue: bare, comments: [] }),
    });
    await tick();
    const thin = bodyOf(empty.view, 120);
    assert.ok(!/projects?:/i.test(thin), 'an issue without projects names none');
    assert.ok(!/linked PR/i.test(thin), 'a zero PR count is omitted, never rendered as "0 PR"');
    assert.ok(!/read:project|scope/i.test(thin), 'no scope text leaks into the compact preview');
    assert.match(thin, /metadata unavailable/, 'unavailable metadata is one concise status');
  });
});

describe('issues view Copy removal (S7)', () => {
  test('y and Y are inert: no clipboard write and no copy notice', async () => {
    const calls = [];
    const rows = [issue(76, { title: 'copy me' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: { copyText: (text) => { calls.push(text); return { ok: true, via: 'test-clipboard' }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'copy me' }), comments: [] }),
    });
    await tick();
    const before = bodyOf(view, 160);
    view.handleInput('y');
    view.handleInput('Y');
    await tick();
    assert.deepEqual(calls, [], 'y and Y never touch the clipboard');
    const after = bodyOf(view, 160);
    assert.equal(after, before, 'both keys repaint nothing');
    assert.ok(!after.includes('Copied'), 'no copy claim is rendered');
    assert.ok(!after.includes('clipboard'), 'no clipboard failure path is rendered either');
  });

  test('Y copies neither the issue URL nor anything else', async () => {
    const url = 'https://example.test/i/76';
    const rows = [issue(76, { url })];
    const copies = [];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: { copyText: (text) => { copies.push(text); return { ok: true, via: 'test' }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { url }), comments: [] }),
    });
    await tick();
    view.handleInput('Y');
    await tick();
    assert.deepEqual(copies, [], 'the URL is not copied');
    assert.ok(!bodyOf(view, 100).includes('Copied'), 'nothing claims a copy');
  });

  test('a clipboard failure seam is never consulted, so no miss is claimed either', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(76)], [], []]),
      issues: [issue(76)],
      actions: { copyText: () => ({ ok: false, error: 'no clipboard tool available' }) },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('y');
    await tick();
    const body = bodyOf(view, 100);
    assert.ok(!body.includes('clipboard unavailable'), 'the copy seam is never consulted');
    assert.ok(!body.includes('Copied'), 'no success or miss notice exists');
  });

  test('the footer never names a copy key', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.ok(!bodyOf(view, 160).includes('y/Y'), 'no copy hint anywhere');
  });
});

describe('issues view comment discard confirmation (adopted reference idea 4)', () => {
  function commentView(post) {
    return makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: post },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
  }

  test('esc on a non-empty draft asks once; n keeps editing with the text intact', async () => {
    const { view } = commentView(() => ({ ok: true }));
    await tick();
    view.handleInput('c');
    for (const ch of 'keep me') view.handleInput(ch);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'still editing after the first esc');
    assert.match(bodyOf(view, 100), /Discard this draft\? \(y discard/);
    view.handleInput('n');
    assert.equal(view.state.mode, 'comment', 'n returns to editing');
    assert.equal(view.state.commentText, 'keep me', 'the draft survives the round trip');
    assert.match(bodyOf(view, 100), /keep me/);
  });

  test('esc at the ask returns to editing too', async () => {
    const { view } = commentView(() => ({ ok: true }));
    await tick();
    view.handleInput('c');
    for (const ch of 'keep me') view.handleInput(ch);
    view.handleInput('escape');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc at the ask returns to editing');
    assert.equal(view.state.commentText, 'keep me');
  });

  test('y at the ask discards the draft without posting', async () => {
    const calls = [];
    const { view } = commentView((number, text) => { calls.push([number, text]); return { ok: true }; });
    await tick();
    view.handleInput('c');
    for (const ch of 'throw away') view.handleInput(ch);
    view.handleInput('escape');
    view.handleInput('y');
    await tick();
    assert.equal(view.state.mode, 'list');
    assert.equal(view.state.commentText, '');
    assert.deepEqual(calls, [], 'discarding posts nothing');
  });

  test('esc on an empty draft discards at once without asking', async () => {
    const { view } = commentView(() => ({ ok: true }));
    await tick();
    view.handleInput('c');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list', 'an empty draft needs no confirmation');
  });
});

describe('issues view comments render whole (adopted reference idea 5: no silent cut)', () => {
  test('renders every comment with no silent cut and no cut line', async () => {
    const now = new Date().toISOString();
    const comments = Array.from({ length: 25 }, (_, i) => ({
      id: i, author: 'alice', createdAt: now, body: `comment body ${i}`, reactions: { total: 0, plusOne: 0 },
    }));
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 130,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /comment body 0/);
    assert.match(body, /comment body 24/, 'the last comment renders too');
    assert.ok(!body.includes('showing last'), 'no cut means no cut line');
  });
});

describe('issues view lazy page loading (S19)', () => {
  test('mount paints an honest loading state instead of claiming zero issues', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const wide = bodyOf(view, 160);
    assert.match(wide, /loading issues/, 'the wait is named');
    assert.ok(!/0 issues/.test(wide), 'a pending fetch never renders a zero count');
    assert.ok(!/page/i.test(wide), 'a pending fetch renders no page marker');
    assert.match(wide, /esc close/, 'the footer legend is there from the first paint');

    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    const loaded = bodyOf(view, 160);
    assert.match(loaded, /issue title 1/, 'the first paint after the fetch lists the rows');
    assert.match(loaded, /My issues \(1\)/);
  });

  test('mounting and the first render never block on the fetch', async () => {
    const gate = deferred();
    const started = Date.now();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const painted = strip(view.render(80).join('\n'));
    const elapsed = Date.now() - started;
    assert.match(painted, /loading issues/);
    // The gate is still open: a blocking mount could not have painted at all.
    assert.ok(elapsed < 150, `mount plus first paint took ${elapsed}ms with the fetch pending`);
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
  });

  test('the loader is asked for the filter state and its rows replace the pages', async () => {
    const asked = [];
    const { view } = makeView({
      loadPages: ({ state }) => {
        asked.push(state);
        return pagesResult([[issue(1), issue(2, { state: 'closed' })], [issue(3)], [issue(4)]]);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(asked, ['open'], 'the first fetch asks for the default state');
    const body = bodyOf(view, 80);
    assert.match(body, /My issues/);
    assert.match(body, /Assigned/);
    assert.match(body, /Involved/);
    view.handleInput('tab');
    assert.match(bodyOf(view, 80), /issue title 3/, 'each page keeps its own rows');
  });

  test('a failed load renders the honest error and paints no fake rows', async () => {
    const { view } = makeView({
      loadPages: () => ({ ok: false, error: 'gh issue list failed: HTTP 401: Bad credentials' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /failed to load issues: gh issue list failed: HTTP 401: Bad credentials/);
    assert.ok(!body.includes('issue title'), 'no rows were invented');
    assert.match(bodyOf(view, 160), /esc close/, 'the footer legend survives the error');
  });

  test('a partially failed load keeps the pages it has and names the failure', async () => {
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1)], [], []], { loadError: 'gh issue list failed: timed out' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 160);
    assert.match(body, /issue title 1/, 'the pages that did load render');
    assert.match(body, /timed out/, 'the failure is named, never hidden');
  });

  test('a stale answer never wins over the newest request', async () => {
    const pending = [];
    const { view } = makeView({
      loadPages: ({ state }) => {
        const entry = deferred();
        pending.push({ state, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    assert.deepEqual(pending.map((p) => p.state), ['open'], 'the mount read asks for open');
    view.handleInput('r');
    view.handleInput('r');
    assert.deepEqual(pending.map((p) => p.state), ['open', 'open', 'open'], 'every reload asks for open again');
    const newest = pending[2].entry;
    const stale = pending[1].entry;
    newest.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    stale.resolve(pagesResult([[issue(2)], [], []]));
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the newest open-only answer is the one shown');
    assert.match(body, /issue title 1/, 'the newest answer paints its row');
    assert.ok(!body.includes('issue title 2'), 'the stale answer never paints');
  });

  test('closing stops every later repaint and a late load changes nothing', async () => {
    const gate = deferred();
    const { view, done, paints } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const before = paints.length;
    view.handleInput('escape');
    assert.equal(done(), null, 'esc still closes with null');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.equal(paints.length, before, 'a late answer repaints nothing after close');
  });
});

describe('issues view open-only list (S10a)', () => {
  // A state-honest source, like `gh --state <state>`: each state carries
  // only its own rows and its own total. The view only ever asks for open.
  function stateSource(rows) {
    const asked = [];
    const pages = (state) => {
      asked.push(state);
      const matching = rows.filter((row) => String(row.state || 'open') === state);
      return pagesResult([matching, [], []]);
    };
    return { asked, pages };
  }

  test('the default fetch asks for open and the tab names the open count', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' }), issue(3, { state: 'closed' })];
    const source = stateSource(rows);
    const { view } = makeView({
      loadPages: ({ state }) => source.pages(state),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(source.asked, ['open'], 'the first fetch asks gh for open only');
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the tab counts the open row it lists');
    assert.ok(!body.includes('My issues (3)'), 'the all-state total is never shown while only open issues list');
    assert.ok(!body.includes('issue title 2'), 'closed rows stay out of the list');
    assert.ok(!/page/i.test(body), 'no page marker is printed (S3)');
    assert.ok(!/f[:(]/.test(body), 'no state indicator is left in the frame');
    assert.ok(!bodyOf(view, 160).includes('open/closed'), 'the removed toggle never reaches the legend');
  });

  test('an all-state total never inflates the open count (reported symptom)', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' }), issue(3, { state: 'closed' })];
    const { view } = makeView({
      // A source that answers an open request with every state and an
      // all-state total: the counts must follow the rows actually shown.
      loadPages: () => pagesResult([rows, [], []]),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the tab counts the one open issue it lists');
    assert.ok(!body.includes('My issues (3)'), 'closed issues never inflate the open tab');
    assert.ok(!/page/i.test(body), 'no page marker is printed (S3)');
    assert.ok(!body.includes('issue title 2'), 'no closed row is listed under open');
    assert.ok(!/\b2 issues\b|\b3 issues\b/.test(body), 'no closed row inflates a count');
  });

  test('f is inert: no other state is ever requested and closed rows never count', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' }), issue(3, { state: 'closed' })];
    const source = stateSource(rows);
    const asked = [];
    const { view } = makeView({
      loadPages: ({ state }) => source.pages(state),
      actions: {
        reload: ({ state }) => { asked.push(`reload:${state}`); return source.pages(state); },
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(source.asked, ['open'], 'the mount fetch asks for open');
    const before = bodyOf(view, 80);
    view.handleInput('f');
    await tick();
    assert.deepEqual(source.asked, ['open'], 'f never asks gh for another state');
    assert.deepEqual(asked, [], 'f never refetches through the reload seam');
    assert.equal(bodyOf(view, 80), before, 'f repaints nothing');
    view.handleInput('r');
    await tick();
    assert.deepEqual(asked, ['reload:open'], 'a reload asks for open, never for closed');
    assert.equal(source.asked.includes('closed'), false, 'the closed state is never requested');
    const reloaded = bodyOf(view, 80);
    assert.match(reloaded, /My issues \(1\)/, 'only the open row is counted');
    assert.ok(!reloaded.includes('issue title 2'), 'closed rows stay out of the reloaded list');
    assert.equal(view.state.index, 0, 'the selection stays on the first open row');
    assert.equal(view.state.listStart, 0, 'the list window stays at the top');
    assert.equal(view.state.scroll, 0, 'the detail scroll stays at the top');
  });

  test('a bounded fetch marks the count on the tab only', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    const { view } = makeView({
      loadPages: () => ({
        ok: true,
        pages: [{ id: 'p0', label: 'My issues', issues: rows, total: 500, truncated: true }],
      }),
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(500\+\)/, 'the tab marks the bounded count');
    assert.ok(!/500\+ issues|5\+ issues/.test(body), 'the bound is never repeated below the list');
  });

  test('opening, searching and the removed state key issue no write action', async () => {
    const writes = [];
    const rows = [issue(1), issue(2, { state: 'closed' })];
    const { view } = makeView({
      loadPages: ({ state }) => pagesResult([
        rows.filter((row) => (row.state || 'open') === state), [], [],
      ]),
      loadLabels: () => ({ ok: true, labels: [{ name: 'bug' }] }),
      actions: {
        reload: ({ state }) => pagesResult([rows.filter((row) => (row.state || 'open') === state), [], []]),
        editLabels: () => { writes.push('editLabels'); return { ok: true }; },
        postComment: () => { writes.push('postComment'); return { ok: true }; },
        setState: () => { writes.push('setState'); return { ok: true }; },
        openBrowser: () => { writes.push('openBrowser'); return { ok: true }; },
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'issue') view.handleInput(ch);
    view.handleInput('enter');
    view.handleInput('f');
    await tick();
    view.handleInput('tab');
    view.handleInput('down');
    assert.deepEqual(writes, [], 'no key outside the four write actions writes');
  });
});

describe('issues view lazy labels (S19)', () => {
  test('labels load on the first L, never at mount, and only once', async () => {
    let labelCalls = 0;
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1, { labels: [{ name: 'bug' }] })], [], []]),
      loadLabels: () => {
        labelCalls += 1;
        return { ok: true, labels: [{ name: 'bug' }, { name: 'docs' }] };
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    });
    await tick();
    assert.equal(labelCalls, 0, 'opening the view never fetches labels');
    view.handleInput('L');
    await tick();
    assert.equal(labelCalls, 1, 'the first L fetches them');
    const body = bodyOf(view, 80);
    assert.match(body, /docs/, 'the editor lists the fetched labels');
    view.handleInput('escape');
    view.handleInput('L');
    await tick();
    assert.equal(labelCalls, 1, 'a second open reuses the loaded labels');
  });

  test('a label load failure is shown honestly and retried on the next open', async () => {
    let labelCalls = 0;
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1, { labels: [{ name: 'bug' }] })], [], []]),
      loadLabels: () => {
        labelCalls += 1;
        return { ok: false, error: 'gh label list failed: rate limited' };
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    await tick();
    const body = bodyOf(view, 160);
    assert.match(body, /labels unreadable: gh label list failed: rate limited/);
    assert.match(body, /\+ create new/, 'creating a new label stays reachable');
    view.handleInput('escape');
    view.handleInput('L');
    await tick();
    assert.equal(labelCalls, 2, 'reopening the editor retries the failed fetch');
  });

  test('a pending label fetch shows the wait and only esc leaves the editor', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1)], [], []]),
      loadLabels: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    const loading = bodyOf(view, 80);
    assert.match(loading, /loading labels/);
    view.handleInput('space');
    assert.equal(view.state.labelIndex, 0, 'toggling waits for the real list');
    gate.resolve({ ok: true, labels: [{ name: 'bug' }] });
    await tick();
    assert.match(bodyOf(view, 80), /bug/, 'the labels land in the open editor');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list');
  });
});

describe('issues view over the real gh client (argv, status, stderr)', () => {
  test('reads ask for the requested state, and a gh failure surfaces honestly', async () => {
    const calls = [];
    ghIssues.setGhRunner((_bin, argv) => {
      calls.push(argv.slice());
      if (argv[0] === 'issue' && argv[1] === 'list') {
        return { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials', error: null };
      }
      return { status: 0, stdout: '[]', stderr: '', error: null };
    });
    const { view } = makeView({
      loadPages: ({ state }) => ghIssues.listIssues({ query: 'author:@me', state, page: 1, pageSize: 30 }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'crash') view.handleInput(ch);
    view.handleInput('enter');
    view.handleInput('f');
    await tick();
    view.handleInput('r');
    await tick();
    const lists = calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list');
    assert.equal(lists.length, 2, 'the mount read and the reload');
    assert.deepEqual(
      lists.map((argv) => argv[argv.indexOf('--state') + 1]),
      ['open', 'open'],
      'open is the only state ever requested',
    );
    assert.ok(!calls.some((argv) => argv.includes('closed')), 'the closed state is never requested');
    assert.ok(lists.every((argv) => argv.includes('--search')), 'each read carries the page query');
    const body = bodyOf(view, 80);
    assert.match(body, /failed to load issues: gh issue list failed: HTTP 401: Bad credentials/);
    const writes = calls.filter((argv) => argv[0] === 'issue'
      && ['edit', 'comment', 'close', 'reopen'].includes(argv[1]));
    assert.deepEqual(writes, [], 'opening, searching and toggling write nothing');
  });

  test('eagerly supplied pages keep naming their reported total (legacy contract)', async () => {
    const { view } = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: [issue(1)], total: 45 }],
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(45\)/, 'the eager page keeps its own reported total');
    assert.ok(!/page/i.test(body), 'no page marker is printed (S3)');
    assert.ok(!/\b45 issues\b/.test(body), 'the total is named once, on the tab');
  });
});

describe('issues view concise header (S25)', () => {
  const CHECKOUT = 'feat-yolo-worktree-confirmations';

  test('the header repeats neither the checkout nor the active tab', async () => {
    const { view } = makeView({
      checkoutName: CHECKOUT,
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    });
    await tick();
    const header = strip(view.render(80)[0]);
    assert.match(header, /◈ Issues/, 'the header names the surface');
    assert.ok(!header.includes('My issues'), 'the header never repeats the active tab the tab row shows');
    assert.ok(!header.includes(CHECKOUT), 'the header never repeats the checkout/branch');
    assert.ok(!bodyOf(view, 80).includes(CHECKOUT), 'no part of the frame repeats the checkout');
    assert.ok(!/#\d/.test(header), 'the header repeats no issue id the list or preview already shows');
    const body = bodyOf(view, 160);
    assert.match(body, /My issues \(1\)/, 'the tab count survives the trim');
    assert.match(body, /x close/, 'the close legend survives the trim');
    assert.ok(!/page/i.test(body), 'no page marker is printed (S3)');
    assert.ok(!body.includes('f open/closed'), 'the removed state toggle legend stays gone');
    const beforeSpace = strip(view.render(80).join('\n'));
    view.handleInput('space');
    const after = strip(view.render(80).join('\n'));
    assert.equal(after, beforeSpace, 'space changes nothing, the header included');
    assert.ok(!after.includes('unsaved'), 'the header never claims a pending assignment');
  });

  test('the loading header is the surface name alone, with no checkout', async () => {
    const gate = deferred();
    const { view } = makeView({
      checkoutName: CHECKOUT,
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const loading = bodyOf(view, 160);
    assert.match(loading, /◈ Issues/, 'the header still names the surface');
    assert.ok(!loading.includes(CHECKOUT), 'the loading header repeats no checkout');
    assert.match(loading, /loading issues/, 'the loading state survives');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.ok(!bodyOf(view, 160).includes(CHECKOUT), 'the loaded frame repeats no checkout either');
  });
});

describe('issues view dedicated search row (S26)', () => {
  function chrome(view, width) {
    return view.render(width).map(strip);
  }

  test('the search widget sits directly below the title and the tabs follow it', async () => {
    const { view } = makeView({
      checkoutName: 'feat-yolo-worktree-confirmations',
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 160]) {
      const lines = chrome(view, width);
      assert.match(lines[0], /◈ Issues/, 'row 1 is the concise title');
      assert.ok(!/search/i.test(lines[0]), 'the title buries nothing about search');
      assert.match(lines[1], /› Search(?! \(T\))/, 'row 2 is the dedicated Search widget');
      assert.match(lines[2], /My issues \(1\)/, 'row 3 carries the tabs and their counts');
      assert.match(lines[2], /Assigned \(0\)/, 'every tab count stays');
      assert.ok(!/f[:(]/.test(lines[3]), 'row 4 carries notices only, no state toggle');
      assert.equal(lines.length, 24, 'the chrome plus body still fills the terminal exactly');
    }
  });

  test('an active query renders in the search widget at 80 and 160', async () => {
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'beta') view.handleInput(ch);
    for (const width of [80, 160]) {
      const lines = chrome(view, width);
      assert.match(lines[1], /› beta█/, 'the query renders in the search widget');
      assert.ok(!lines[1].includes('enter/esc keep'), 'the input row repeats no key hint');
      assert.match(lines[2], /My issues/, 'the tabs stay below the search row');
      const footer = lines[lines.length - 2];
      assert.match(footer, /enter\/esc keep/, 'the footer names the search keys of this interaction once');
      assert.ok(!footer.includes('esc close'), 'the close hint belongs to the reading interaction only');
    }
    view.handleInput('enter');
    const settled = chrome(view, 80);
    assert.match(settled[1], /› beta(?! \(T)/, 'a kept filter shows its query in the widget');
    assert.ok(!settled.join('\n').includes('alpha crash'), 'the kept filter still filters the list');
  });

  test('errors and notices keep their own visible row, even while typing', async () => {
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    let lines = chrome(view, 80);
    assert.match(lines[3], /labels cannot be edited/, 'the refusal lands on the notice row');
    view.handleInput('T');
    view.handleInput('1');
    lines = chrome(view, 80);
    assert.match(lines[1], /› 1█/, 'the query row stays the input');
    assert.match(lines[3], /labels cannot be edited/, 'the error never disappears while typing');
  });

  test('a long notice truncates inside the frame instead of overflowing it', async () => {
    const longError = 'the issue page could not be read: gh timed out after 30s while querying the remote repository for this bucket';
    const { view } = makeView({
      pages: pagesOf([[issue(76)], [], []]),
      issues: [issue(76)],
      loadError: longError,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 160]) {
      for (const line of view.render(width)) {
        assert.equal(helpers.visibleWidth(line), width, `every row keeps the exact cell width at ${width}`);
      }
    }
    assert.match(chrome(view, 80)[3], /the issue page could not be read/, 'the notice still shows on the notice row');
  });

  test('the loading frame keeps the search widget directly under the title', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const loading = chrome(view, 160);
    assert.match(loading[0], /◈ Issues/, 'row 1 is the title');
    assert.match(loading[1], /› Search/, 'row 2 is the search widget while loading');
    assert.match(loading.join('\n'), /loading issues/, 'the loading state stays');
    assert.match(loading[loading.length - 2], /esc close/, 'the footer legend stays');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.match(chrome(view, 160)[1], /› Search/, 'the widget stays under the title after loading');
  });
});

describe('issues view frame header (S27)', () => {
  test('no top-right esc text; right border and corners stay cell-aligned', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 160]) {
      const lines = view.render(width);
      const first = strip(lines[0]);
      assert.ok(!/esc/.test(first), 'the header carries no esc text');
      assert.ok(first.startsWith('╭─'), 'the top-left corner is intact');
      assert.ok(first.endsWith('─╮'), 'the top-right corner is intact');
      for (const line of lines) {
        assert.equal(helpers.visibleWidth(line), width, `cell width at ${width}`);
        assert.match(strip(line), /[│╮╯]$/, 'the right border stays in the last column');
      }
    }
    const wide = view.render(160);
    assert.match(strip(wide[wide.length - 2]), /esc close/, 'the footer still names Esc');
    const narrow = view.render(80);
    assert.match(strip(narrow[narrow.length - 2]), /↑↓ move/, 'the narrow footer keeps the legend head');
    assert.equal(helpers.visibleWidth(narrow[narrow.length - 2]), 80, 'the truncated footer stays cell-exact');
  });

  test('the loader and error frames also drop the top-right esc', async () => {
    const gate = deferred();
    const loading = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    for (const width of [80, 160]) {
      const lines = loading.view.render(width);
      assert.ok(!/esc/.test(strip(lines[0])), 'no esc in the loading header');
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width);
    }
    const failed = makeView({
      loadPages: () => ({ ok: false, error: 'gh issue list failed: HTTP 401' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const lines = failed.view.render(80);
    assert.ok(!/esc/.test(strip(lines[0])), 'no esc in the error header');
    for (const line of lines) assert.equal(helpers.visibleWidth(line), 80);
    const wide = failed.view.render(160);
    assert.match(strip(wide[wide.length - 2]), /esc close/, 'the footer keeps the Esc shortcut');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
  });
});

// S2: the footer legend is ONE terminal row; a legend wider than the card is
// compacted (short tokens, then the lowest-priority keys dropped) instead of
// being ellipsis-clipped inside the frame.
describe('S2: one-row key legends', () => {
  const WIDTHS = [40, 60, 80, 120];

  test('the footer legend owns exactly one row at every width', async () => {
    for (const width of WIDTHS) {
      const { view } = makeView({
        pages: pagesOf([[issue(1)], [], []]),
        issues: [issue(1)],
        loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      });
      await tick();
      const lines = view.render(width);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `width ${width}: row is not ${width} wide`);
      const legend = lines.map(strip).filter((line) => /esc close|↑↓ move/.test(line));
      assert.equal(legend.length, 1, `width ${width}: exactly one footer row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑↓ move/, `width ${width}: the movement keys survive`);
      assert.match(legend[0], /esc close/, `width ${width}: the close key survives`);
    }
  });
});

// S13: the issues frame says each thing once. The search key is named by the
// search row alone, the issue total by the tab alone, the active bucket by the
// tab row (never by the header too), and while the box holds the keyboard the
// footer names its keys once instead of the input and the footer both doing it.
describe('S13: the issues frame repeats nothing', () => {
  const rows = [issue(1), issue(2)];
  const footerOf = (lines) => lines[lines.length - 2];
  const tokensOf = (footer) => footer.split('·').map((token) => token.trim());

  async function opened(opts = {}) {
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...opts,
    });
    await tick();
    return view;
  }

  test('the active bucket is named by the tab, not by the header too', async () => {
    const view = await opened();
    const lines = view.render(80).map(strip);
    assert.match(lines[0], /◈ Issues/, 'the header names the surface');
    assert.ok(!lines[0].includes('My issues'), 'the header never repeats the tab below it');
    assert.match(lines[2], /▸ My issues \(2\)/, 'the tab row marks the active bucket and its count');
  });

  test('the search key is named by the footer alone, never above it', async () => {
    const view = await opened();
    const lines = view.render(80).map(strip);
    const footer = footerOf(lines);
    assert.match(lines[1], /› Search/, 'the search row names the widget');
    assert.ok(!lines[1].includes('(T)'), 'no key hint rides the search row');
    assert.equal((lines.join('\n')).match(/\(T\)/g), null, 'no parenthesised T hint survives');
    assert.ok(tokensOf(footer).some((token) => /^t( search)?$/.test(token)), `the footer owns the search key: ${footer}`);
  });

  test('while searching the footer names the search keys once and the input carries only the query', async () => {
    const view = await opened();
    view.handleInput('T');
    view.handleInput('t');
    const lines = view.render(80).map(strip);
    const body = lines.join('\n');
    assert.match(lines[1], /› t█/, 'the input row carries the live query');
    assert.ok(!lines[1].includes('enter'), 'the input row repeats no key hint');
    assert.ok(!lines[1].includes('esc'), 'the input row names no escape key');
    const footer = footerOf(lines);
    assert.match(footer, /enter\/esc keep/, 'the footer names the search keys of this interaction');
    assert.ok(!footer.includes('esc close'), 'the close hint belongs to the reading interaction only');
    assert.equal((body.match(/esc/g) || []).length, 1, `one escape hint for the current interaction: ${body}`);
    assert.equal((body.match(/enter/g) || []).length, 1, 'one enter hint for the current interaction');
  });

  test('leaving the box restores the reading legend with its one escape hint', async () => {
    const view = await opened();
    view.handleInput('T');
    view.handleInput('t');
    view.handleInput('enter');
    const lines = view.render(80).map(strip);
    const footer = footerOf(lines);
    assert.match(footer, /esc close/, 'the reading legend returns');
    assert.ok(!footer.includes('enter/esc keep'), 'the search keys leave with the box');
    assert.equal((lines.join('\n').match(/esc/g) || []).length, 1, 'still one escape hint');
  });

  test('the issue total lives in the tab, never a second time under the list', async () => {
    const view = await opened();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(2\)/, 'the tab carries the total');
    assert.ok(!/\b2 issues\b/.test(body), 'no row under the list repeats it');
    assert.ok(!/page/i.test(strip(view.render(80)[1])), 'the search row carries no page marker');
  });

  test('no chrome row repeats the focused issue title the list and preview already show', async () => {
    const view = await opened();
    const lines = view.render(100).map(strip);
    for (const row of lines.slice(0, 4)) {
      assert.ok(!row.includes('issue title 1'), `chrome repeats no focused title: ${row}`);
    }
  });
});

// S16/D2: label and assignee editing is a repository capability, never the
// fact that the user is authenticated. Issue detail carries
// `permissions:{canEditLabels,canEditAssignees,canCreateLabels}`; absent or
// unknown reads as false, so the footer hint disappears AND the key cannot
// enter the editor — the same gate for both, and no loader or write runs.
describe('S16: repository permissions gate the label and assignee editors', () => {
  const users = () => ({ ok: true, users: [{ login: 'ann', name: 'Ann' }, { login: 'bob', name: '' }, { login: 'carol', name: 'Carol' }] });

  test('the footer names each editor only for a permission confirmed true', async () => {
    const cases = [
      [EDITABLE, true],
      [{}, false],
      [undefined, false],
      [{ canEditLabels: 'yes', canEditAssignees: 1 }, false],
    ];
    for (const [permissions, shown] of cases) {
      const rows = [issue(1)];
      const { view } = makeView({
        pages: pagesOf([rows, [], []]),
        issues: rows,
        loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions }), comments: [] }),
      });
      await tick();
      const body = bodyOf(view, 220);
      assert.equal(body.includes('L labels'), shown, `labels hint for ${JSON.stringify(permissions)}`);
      assert.equal(body.includes('a assign'), shown, `assignees hint for ${JSON.stringify(permissions)}`);
    }
  });

  test('l and a neither enter an editor nor load or write without permission', async () => {
    for (const permissions of [undefined, {}, { canEditLabels: false, canEditAssignees: false }]) {
      const calls = [];
      const rows = [issue(1)];
      const { view } = makeView({
        pages: pagesOf([rows, [], []]),
        issues: rows,
        labels: [{ name: 'bug' }],
        loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions }), comments: [] }),
        loadAssignees: () => { calls.push('loadAssignees'); return users(); },
        actions: {
          editLabels: () => { calls.push('editLabels'); return { ok: true }; },
          editAssignees: () => { calls.push('editAssignees'); return { ok: true }; },
        },
      });
      await tick();
      view.handleInput('l');
      view.handleInput('a');
      await tick();
      assert.equal(view.state.mode, 'list', `no editor opens for ${JSON.stringify(permissions)}`);
      assert.deepEqual(calls, [], 'no loader and no write ran');
      assert.match(bodyOf(view, 124), /permission/, 'the refusal names the missing permission');
    }
  });

  test('a opens the assignee editor preselected and saves add/remove deltas', async () => {
    const calls = [];
    const loads = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n, opts) => {
        loads.push(opts);
        const assignees = loads.length === 1 ? [{ login: 'bob' }] : [{ login: 'ann' }];
        return { ok: true, issue: issue(n, { permissions: EDITABLE, assignees }), comments: [] };
      },
      loadAssignees: () => users(),
      actions: { editAssignees: (number, changes) => { calls.push([number, changes]); return { ok: true }; } },
    });
    await tick();
    view.handleInput('a');
    assert.equal(view.state.mode, 'assignees');
    await tick();
    const editor = bodyOf(view, 100);
    assert.match(editor, /\[x\] bob/, 'the current assignee starts selected');
    assert.match(editor, /\[ \] ann/, 'an unassigned user starts unselected');
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(calls, [[1, { add: ['ann'], remove: ['bob'] }]], 'one delta call: add ann, remove bob');
    assert.equal(view.state.mode, 'list', 'success leaves the editor');
    assert.deepEqual(loads[1], { refresh: true }, 'the saved detail is refetched, never served from the cache');
    const body = bodyOf(view, 100);
    assert.match(body, /assignees: ann/, 'the preview shows the refetched assignees');
    assert.ok(!body.includes('assignees: bob'), 'the pre-save detail is gone');
  });

  test('the create-label row and key need canCreateLabels, not just triage', async () => {
    const created = [];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }],
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: { canEditLabels: true, canCreateLabels: false } }),
        comments: [],
      }),
      actions: { editLabels: (_n, add, remove, made) => { created.push([add, remove, made]); return { ok: true }; } },
    });
    await tick();
    view.handleInput('l');
    assert.equal(view.state.mode, 'labels', 'triage permission alone still opens the editor');
    const editor = bodyOf(view, 100);
    assert.ok(!editor.includes('create new'), 'no create row without canCreateLabels');
    view.handleInput('n');
    assert.equal(view.state.labelCreating, false, 'n starts no creation');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(created, [[[], [], []]], 'no label creation was sent');
  });

  test('a rejected assignee save keeps the editor, the toggles and a visible error', async () => {
    const loads = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n, opts) => {
        loads.push(opts);
        return { ok: true, issue: issue(n, { permissions: EDITABLE, assignees: [{ login: 'bob' }] }), comments: [] };
      },
      loadAssignees: () => users(),
      actions: { editAssignees: () => ({ ok: false, error: 'permission denied by GitHub' }) },
    });
    await tick();
    view.handleInput('a');
    await tick();
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'assignees', 'the editor stays open');
    const body = bodyOf(view, 100);
    assert.match(body, /permission denied by GitHub/, 'the server rejection is visible');
    assert.match(body, /\[x\] ann/, 'the local toggle survives the rejection');
    assert.match(body, /\[x\] bob/, 'the stored assignee is unchanged');
    assert.equal(loads.length, 1, 'a failed save refetches nothing');
  });

  test('moving focus to an issue without permissions withdraws both hints and both keys', async () => {
    const calls = [];
    const rows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, n === 1 ? { permissions: EDITABLE } : {}), comments: [] }),
      loadAssignees: () => { calls.push('loadAssignees'); return users(); },
    });
    await tick();
    assert.match(bodyOf(view, 220), /L labels/, 'the permitted issue shows the hint');
    view.handleInput('j');
    await tick();
    const body = bodyOf(view, 220);
    assert.ok(!body.includes('L labels'), 'the labels hint is gone');
    assert.ok(!body.includes('a assign'), 'the assignees hint is gone');
    view.handleInput('a');
    await tick();
    assert.equal(view.state.mode, 'list', 'the key cannot enter the editor');
    assert.deepEqual(calls, [], 'no assignee loader ran');
  });
});

// «igual en issues en los atajos … si intento darle a close debe revisar si
// tengo permisos primero, si no tengo alerta y no me deja ni intentar cerrarla»
// and «si no tengo permiso de crear label pero si de asignar deberia poder
// entrar a labels pero no deberia aparecer opcion ni keybinding para crear
// label». Closing (and reopening) is the same TRIAGE-level capability the label
// and assignee editors need, so the key resolves the repository permission
// BEFORE it opens the confirmation and never reaches the write without it.
// Reading the issue detail is that evidence's cache, so `r` re-reads it.
describe('issues close/reopen permission gate', () => {
  const TRIAGE = { canEditLabels: true, canEditAssignees: true, canCloseIssues: true, canCreateLabels: false };
  const READ_ONLY = { canEditLabels: false, canEditAssignees: false, canCloseIssues: false, canCreateLabels: false };

  test('x and X open no confirmation and write nothing without canCloseIssues', async () => {
    for (const permissions of [undefined, {}, READ_ONLY, { canCloseIssues: 'yes' }]) {
      const calls = [];
      const rows = [issue(1)];
      const { view } = makeView({
        pages: pagesOf([rows, [], []]),
        issues: rows,
        loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions }), comments: [] }),
        actions: { setState: (n, state) => { calls.push([n, state]); return { ok: true }; } },
      });
      await tick();
      view.handleInput('x');
      assert.equal(view.state.mode, 'list', `x opens no confirmation for ${JSON.stringify(permissions)}`);
      view.handleInput('X');
      assert.equal(view.state.mode, 'list', `X opens no confirmation for ${JSON.stringify(permissions)}`);
      assert.deepEqual(calls, [], 'no state write was attempted');
      const body = bodyOf(view, 200);
      assert.ok(!body.includes('x close'), 'the footer names no close key without the permission');
      assert.match(bodyOf(view, 124), /permission/, 'the refusal names the missing permission');
    }
  });

  test('with TRIAGE the close key is offered, confirms and then writes', async () => {
    const calls = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: TRIAGE }), comments: [] }),
      actions: { setState: (n, state) => { calls.push([n, state]); return { ok: true }; } },
    });
    await tick();
    assert.match(bodyOf(view, 200), /x close/, 'the triage viewer is offered the close key');
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm', 'the confirmation still asks first');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(calls, [[1, 'closed']], 'the close reaches the injected action');
  });

  test('with TRIAGE the labels editor opens and names no create keybinding', async () => {
    const created = [];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      loadIssue: (n) => ({ ok: true, issue: issue(n, { labels: [{ name: 'bug' }], permissions: TRIAGE }), comments: [] }),
      actions: { editLabels: (_n, add, remove, made) => { created.push([add, remove, made]); return { ok: true }; } },
    });
    await tick();
    view.handleInput('l');
    assert.equal(view.state.mode, 'labels', 'triage permission alone still opens the editor');
    assert.match(bodyOf(view, 120), /Labels \(space toggle/, 'the existing labels are listed');
    const editor = bodyOf(view, 120);
    assert.ok(!editor.includes('n new'), 'the editor names no create keybinding');
    assert.ok(!editor.includes('create new'), 'no create row is listed');
    view.handleInput('n');
    assert.equal(view.state.labelCreating, false, 'n starts no creation');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(created, [[[], [], []]], 'no label creation was sent');
  });

  test('with WRITE the same editor offers the create row and the n keybinding', async () => {
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }],
      loadIssue: (n) => ({ ok: true, issue: issue(n, { labels: [{ name: 'bug' }], permissions: EDITABLE }), comments: [] }),
      actions: { editLabels: () => ({ ok: true }) },
    });
    await tick();
    view.handleInput('l');
    assert.equal(view.state.mode, 'labels');
    const editor = bodyOf(view, 120);
    assert.match(editor, /n new/, 'the WRITE viewer is told how to create one');
    assert.match(editor, /create new/, 'the create row is listed');
    view.handleInput('n');
    assert.equal(view.state.labelCreating, true, 'n starts the creation');
  });

  test('r re-reads the issue detail, so a granted permission reaches the keys', async () => {
    let permissions = READ_ONLY;
    const loads = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n, opts) => {
        loads.push(opts || null);
        return { ok: true, issue: issue(n, { permissions }), comments: [] };
      },
      actions: { setState: () => ({ ok: true }) },
    });
    await tick();
    assert.ok(!bodyOf(view, 200).includes('x close'), 'the read-only viewer has no close key');
    view.handleInput('x');
    assert.equal(view.state.mode, 'list');
    permissions = TRIAGE;
    view.handleInput('r');
    await tick();
    assert.deepEqual(loads[1], { refresh: true }, 'the refresh re-reads the detail that carries the permission');
    assert.match(bodyOf(view, 200), /x close/, 'the refreshed permission reaches the footer');
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm', 'and the key opens the confirmation');
  });

  test('commenting stays ungated: c opens and posts on a read-only repository', async () => {
    const posts = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: READ_ONLY }), comments: [] }),
      actions: { postComment: (n, text) => { posts.push([n, text]); return { ok: true }; } },
    });
    await tick();
    assert.match(bodyOf(view, 200), /c comment/, 'the comment key needs no repository capability');
    view.handleInput('c');
    assert.equal(view.state.mode, 'comment');
    for (const ch of 'hi') view.handleInput(ch);
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(posts, [[1, 'hi']], 'the comment reaches the injected action');
  });
});

// S3/S5/D1/D3: the widened wrapping left list and the server-page seam.
describe('issues left list width, wrapping and fresh pages (S3/S5/D1/D3)', () => {
  // One issue carrying its server cursor, as D1 delivers it.
  function cursorIssue(cursor, row) {
    return { ...row, cursor };
  }

  function page(issues, extra = {}) {
    return { ok: true, issues, total: issues.length, hasNextPage: false, ...extra };
  }

  test('the left pane takes the smaller 30% list share at 40, 80, 120 and 200 columns', async () => {
    for (const width of [40, 80, 120, 200]) {
      const { view } = makeView({
        rows: 24,
        loadIssuePage: () => page([cursorIssue('c1', issue(1, { title: 'short title' }))]),
        loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      });
      await tick();
      const expected = readerPanes(width).left;
      const bodyRow = strip(view.render(width)[5]);
      const chars = [...bodyRow];
      assert.equal(chars.indexOf('│', 2), 3 + expected, `${width}: the left pane is ${expected} cells`);
      // S3: the reader list is the smaller share; the READING pane owns the rest.
      const reading = readerPanes(width).right;
      assert.ok(reading > expected, `${width}: the preview is the larger pane (${expected}/${reading})`);
      if (width >= 100) assert.ok(expected < layout.paneWidths(layout.innerWidth(width)).left, `${width}: smaller than the worktree detail 40% list`);
    }
  });

  test('the left list shows the full wrapped title and never the issue number', async () => {
    const title = 'wrapped title that keeps every single word of the issue visible';
    const { view } = makeView({
      rows: 30,
      loadIssuePage: () => page([cursorIssue('c1', issue(7, { title }))]),
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title }), comments: [] }),
    });
    await tick();
    const left = leftColumn(view, 80, 30);
    assert.ok(!left.includes('#7'), 'the issue number is not in the left list');
    assert.equal(left.replace(/\s+/g, ' ').includes(title), true, 'the whole title is readable');
    const rows = left.split('\n').filter((row) => row.trim() !== '');
    assert.ok(rows.length > 1, 'a title too long for one row wraps onto the next');
    assert.ok(rows.slice(0, rows.length - 1).length >= 2, 'the wrap uses as many rows as it needs');
  });

  test('the request limit comes from the viewport body height, never from a fixed 20', async () => {
    for (const [rows, expected] of [[12, 6], [14, 8], [30, 24], [40, 34]]) {
      const calls = [];
      const { view } = makeView({
        rows,
        loadIssuePage: (request) => {
          calls.push(request);
          return page([cursorIssue('c1', issue(1))]);
        },
      });
      await tick();
      assert.equal(calls.length, 1, `${rows}: one mount read`);
      assert.equal(calls[0].limit, expected, `${rows}: limit is the body-row upper bound`);
      assert.equal(calls[0].cursor, null, `${rows}: the first page starts at the head`);
      assert.equal(calls[0].bucketId, 'mine', `${rows}: the request names its bucket`);
      assert.ok(view);
    }
  });

  test('the appended read continues after the LAST LOADED row and keeps the body budget', async () => {
    const calls = [];
    const served = [
      cursorIssue('ca', issue(1, { title: 'alpha beta gamma delta epsilon zeta eta theta' })),
      cursorIssue('cb', issue(2, { title: 'one two three four five six seven eight nine ten' })),
    ];
    const { view } = makeView({
      rows: 12,
      loadIssuePage: (request) => {
        calls.push(request);
        return request.cursor === null
          ? page(served, { hasNextPage: true })
          : page([cursorIssue('cc', issue(3))]);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const left = leftColumn(view, 40, 12);
    assert.match(left, /alpha/, 'the first row is painted');
    view.handleInput(']');
    assert.equal(calls.length, 2, 'scrolling to the loaded bottom asked for the next page');
    assert.equal(calls[1].cursor, 'cb', 'the read continues after the last LOADED row');
    assert.equal(calls[1].limit, 6, 'the limit follows the body budget again');
    assert.equal(calls[1].query, '', 'and the active query');
  });

  test('r re-reads the list from the head and tab switches the bucket', async () => {
    const calls = [];
    const { view } = makeView({
      rows: 12,
      loadIssuePage: (request) => {
        calls.push(request);
        const issues = request.cursor === null
          ? [cursorIssue('ca', issue(1)), cursorIssue('cb', issue(2))]
          : [cursorIssue('cc', issue(3))];
        return page(issues, { hasNextPage: request.cursor === null });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    leftColumn(view, 60, 12);
    view.handleInput(']');
    assert.equal(calls.length, 2, 'scrolling reads the next page');
    await tick();
    const appended = leftColumn(view, 60, 12);
    assert.match(appended, /issue title 3/, 'the appended row is in the one list');
    view.handleInput('[');
    assert.equal(calls.length, 2, 'scrolling back is a window move, never a request');
    view.handleInput('r');
    assert.equal(calls.length, 3, 'r re-reads the list');
    assert.equal(calls[2].cursor, null, 'r re-reads from the head of the current query');
    assert.equal(calls[2].bucketId, 'mine');
    view.handleInput('tab');
    assert.equal(calls.length, 4, 'the new bucket is read on selection');
    assert.equal(calls[3].bucketId, 'assigned', 'tab moves to the next bucket');
  });

  test('r refreshes the focused preview even when the page answers with the same issues', async () => {
    const served = [cursorIssue('ca', issue(1)), cursorIssue('cb', issue(2))];
    let comments = [];
    let loads = 0;
    const { view } = makeView({
      rows: 20,
      loadIssuePage: () => page(served, { hasNextPage: false }),
      loadIssue: (n) => {
        loads += 1;
        return { ok: true, issue: issue(n), comments: comments.slice() };
      },
    });
    await tick();
    leftColumn(view, 60, 20);
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'the second issue is focused');
    comments = [{ author: 'ann', createdAt: new Date().toISOString(), body: 'fresh comment' }];
    const before = loads;
    view.handleInput('r');
    await tick();
    assert.ok(loads > before, 'the focused detail is refetched');
    const body = bodyOf(view, 60);
    assert.match(body, /#2 /, 'the reader stays on the same issue');
    assert.match(body, /fresh comment/, 'the refreshed preview shows the new comment');
  });

  test('a resize keeps the loaded rows, and a stale answer never paints over a newer read', async () => {
    const pending = [];
    const { view } = makeView({
      rows: 30,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(page([cursorIssue('c1', issue(1)), cursorIssue('c2', issue(2))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    view.handleInput(']');
    assert.equal(pending[1].request.cursor, 'c2', 'the appended read continues after the loaded rows');
    pending[1].entry.resolve(page([cursorIssue('c3', issue(3))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    // S3: a resize changes the window geometry only — the rows are the data and
    // stay exactly as loaded.
    bodyOf(view, 60);
    assert.equal(pending.length, 2, 'the resize reads nothing again');
    const resized = leftColumn(view, 60, 30);
    assert.match(resized, /issue title 1/, 'the loaded rows stay painted');
    assert.match(resized, /issue title 3/);
    view.handleInput('r');
    assert.equal(pending.length, 3, 'r asks again');
    pending[2].entry.resolve(page([cursorIssue('c4', issue(9, { title: 'newest answer' }))]));
    await tick();
    pending[1].entry.resolve(page([cursorIssue('c0', issue(8, { title: 'stale answer' }))], { hasNextPage: true }));
    await tick();
    const left = leftColumn(view, 60, 30);
    assert.match(left, /newest answer/, 'the newest request paints');
    assert.ok(!left.includes('stale answer'), 'an earlier answer never overwrites it');
  });

  test('an answer for an inactive bucket paints into that bucket, never into the visible one', async () => {
    const pending = [];
    const { view } = makeView({
      rows: 30,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    // The first bucket is read, then the reader moves to the second one and
    // scrolls: that append is still in flight when the reader moves on.
    pending[0].entry.resolve(page([cursorIssue('a1', issue(1))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    view.handleInput('tab');
    pending[1].entry.resolve(page([cursorIssue('b1', issue(2))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    view.handleInput(']');
    assert.equal(pending[2].request.cursor, 'b1', 'the second bucket has an append in flight');
    view.handleInput('tab');
    pending[3].entry.resolve(page([cursorIssue('c1', issue(3))]));
    await tick();
    bodyOf(view, 120);
    pending[2].entry.resolve(page([cursorIssue('b2', issue(9, { title: 'appended while away' }))]));
    await tick();
    // S3: an answer belongs to ITS bucket. The visible bucket is untouched…
    assert.ok(!leftColumn(view, 120, 30).includes('appended while away'), 'the visible bucket is never overwritten');
    // …and shift+tab walks back to Assigned without reading it again.
    view.handleInput('shift+tab');
    const left = leftColumn(view, 120, 30);
    assert.match(left, /issue title 2/, 'the bucket keeps the rows it read');
    assert.match(left, /appended while away/, 'its appended page landed in its own list');
    assert.equal(pending.length, 4, 'the return costs no extra read');
  });

  test('a failed page load is shown truthfully while the view stays mounted', async () => {
    const { view } = makeView({
      loadIssuePage: () => ({ ok: false, error: 'gh issue list failed: HTTP 403: rate limited' }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /failed to load issues: gh issue list failed: HTTP 403: rate limited/);
    assert.ok(!body.includes('issue title'), 'no rows are invented');
    assert.match(bodyOf(view, 160), /esc close/, 'the footer still names the close key');
  });

  test('static pages stay supported with no loader at all', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1, { title: 'static row' })], [], []]),
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'static row' }), comments: [] }),
    });
    await tick();
    assert.match(leftColumn(view, 100), /static row/, 'the eager pages still render');
    assert.ok(!/page/i.test(bodyOf(view, 100)), 'no page marker is printed (S3)');
    assert.ok(!leftColumn(view, 100).includes('#1'), 'the eager path drops the number too');
  });
});

// S9/S13/S15: the fourth All bucket, a tab switch that reuses what it already
// loaded, and search over the COMPLETE bucket through the server page seam.
// Every request is a public input: the loader receives
// {bucketId, cursor, limit, query}.
describe('issues view All tab, tab cache and server search (S9/S13/S15)', () => {
  test('the fourth tab All lists every open issue of the repository with no dedup', async () => {
    const requests = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => {
        requests.push(request);
        if (request.bucketId === 'all') {
          return pageResult([cursorRow('a1', issue(76, { title: 'belt and braces' })), cursorRow('a2', issue(77))], { total: 2 });
        }
        return pageResult([cursorRow('m1', issue(76, { title: 'belt and braces' }))], { total: 1 });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const tabs = strip(view.render(100)[2]);
    assert.match(tabs, /▸ My issues \(1\)/, 'the default bucket is still first');
    assert.match(tabs, /Assigned \(–\)/);
    assert.match(tabs, /Involved \(–\)/);
    assert.match(tabs, /All \(–\)/, 'an unread tab is unknown, never a false zero');
    assert.equal(requests.length, 1, 'only the default bucket was read');
    assert.equal(requests[0].bucketId, 'mine');
    view.handleInput('tab');
    view.handleInput('tab');
    view.handleInput('tab');
    await tick();
    assert.equal(view.state.page, 3, 'All is the fourth and last tab');
    assert.equal(requests[requests.length - 1].bucketId, 'all', 'All reads the whole open repository');
    assert.match(strip(view.render(100)[2]), /All \(2\)/, 'the All tab counts the whole open repository');
    const left = leftColumn(view, 100);
    assert.match(left, /belt and braces/, 'an issue that also lists under My issues lists here too');
    assert.match(left, /issue title 77/, 'the other open issue is listed');
    assert.equal(left.split('belt and braces').length - 1, 1, 'the list holds no duplicate row');
  });

  test('returning to a visited bucket reuses its rows and window with no request and no loading flash', async () => {
    const requests = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => {
        requests.push(request);
        return pageResult([cursorRow('p1', issue(1)), cursorRow('p2', issue(2))], { hasNextPage: true });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.equal(requests.length, 1, 'the mount read the first bucket once');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    assert.equal(requests.length, 2, 'scrolling reads the next page');
    const beforeSwitch = view.state.listStart;
    view.handleInput('tab');
    await tick();
    assert.equal(requests.length, 3, 'a bucket visited for the first time is read');
    view.handleInput('shift+tab');
    await tick();
    assert.equal(requests.length, 3, 'returning to the visited bucket reads nothing');
    assert.equal(view.state.loading, false, 'the switch never enters the loading state');
    assert.equal(view.state.listStart, beforeSwitch, 'the bucket keeps the window the reader left it on');
    const rendered = strip(view.render(100).join('\n'));
    assert.match(rendered, /issue title 2/, 'the loaded rows paint again');
    assert.ok(!rendered.includes('loading'), 'no loading line and no loading flash on the reused frame');
  });

  test('every page request names its bucket, row budget and exact query, and a new query starts at the head', async () => {
    const clock = manualScheduler();
    const requests = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        requests.push(request);
        const head = request.cursor === null;
        return pageResult([cursorRow(head ? 'q1' : 'q2', issue(head ? 1 : 2))], { hasNextPage: true, total: 2 });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(
      requests[0],
      { bucketId: 'mine', cursor: null, limit: 18, query: '' },
      'the mount read names its bucket, its body-row budget and the empty query',
    );
    view.handleInput('T');
    for (const ch of 'label:bug') view.handleInput(ch);
    assert.equal(requests.length, 1, 'typing only schedules the read');
    clock.fire();
    await tick();
    assert.equal(requests.length, 2, 'the settled burst is ONE request');
    assert.deepEqual(
      requests[1],
      { bucketId: 'mine', cursor: null, limit: 18, query: 'label:bug' },
      'the read carries the whole query, at the head of its own result set',
    );
    view.handleInput('enter');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    assert.deepEqual(
      requests[2],
      { bucketId: 'mine', cursor: 'q1', limit: 18, query: 'label:bug' },
      'the appended read continues after the last loaded row of the same query',
    );
    view.handleInput('r');
    await tick();
    assert.deepEqual(
      requests[3],
      { bucketId: 'mine', cursor: null, limit: 18, query: 'label:bug' },
      'r re-reads the list from the head of the current query',
    );
    assert.equal(view.state.index, 0, 'the refreshed list starts the reader at the top');
  });

  test('a stale query answer never replaces the newer query state', async () => {
    const clock = manualScheduler();
    const pending = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(pageResult([cursorRow('m1', issue(1))], { total: 1 }));
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    clock.fire();
    assert.deepEqual(pending.slice(1).map((entry) => entry.request.query), ['a'], 'the settled query is read once');
    view.handleInput('b');
    clock.fire();
    assert.deepEqual(pending.slice(1).map((entry) => entry.request.query), ['a', 'ab'], 'the next settled query reads its own');
    pending[2].entry.resolve(pageResult([cursorRow('n1', issue(2, { title: 'ab match' }))], { total: 1 }));
    await tick();
    pending[1].entry.resolve(pageResult([cursorRow('o1', issue(3, { title: 'a only match' }))], { total: 1 }));
    await tick();
    const left = leftColumn(view, 100);
    assert.match(left, /ab match/, 'the newest query answer paints');
    assert.ok(!left.includes('a only match'), 'the answer for the older query never paints');
    assert.equal(view.state.loading, false);
  });

  test('server answers are never re-filtered as literal text for GitHub operators', async () => {
    const clock = manualScheduler();
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: () => pageResult([cursorRow('x1', issue(5, { title: 'crash on logout' }))], { total: 1 }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'label:bug') view.handleInput(ch);
    clock.fire();
    await tick();
    assert.equal(view.state.query, 'label:bug');
    const left = leftColumn(view, 100);
    assert.match(
      left,
      /crash on logout/,
      'a row the server matched for label:bug still lists although its title holds no operator word',
    );
  });

  test('a search result that lands on the second server page is selectable and previews its detail', async () => {
    const loads = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => (request.cursor === null
        ? pageResult([cursorRow('s1', issue(41, { title: 'first hit' }))], { hasNextPage: true, total: 2 })
        : pageResult([cursorRow('s2', issue(42, { title: 'second hit' }))], { hasNextPage: false, total: 2 })),
      loadIssue: (n) => {
        loads.push(n);
        return { ok: true, issue: issue(n), comments: [] };
      },
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'is:open') view.handleInput(ch);
    await tick();
    // The box holds the keyboard, so the filter is committed before paging.
    view.handleInput('enter');
    await tick();
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    const left = leftColumn(view, 100);
    assert.match(left, /first hit/, 'the page already read stays in the list');
    assert.match(left, /second hit/, 'the appended page of the search answer is listed below it');
    assert.equal((left.match(/first hit/g) || []).length, 1, 'the first page is never repeated');
    // The appended rows land below the reader, so moving onto one previews it.
    view.handleInput('j');
    await tick();
    assert.ok(loads.includes(42), 'the appended row previews its own detail');
    assert.match(bodyOf(view, 100), /#42/, 'the focused row is the appended issue');
  });
});

// S3: the pager and its position marker are gone. The search row carries the
// widget alone, in every state, and the list spends its whole body budget on
// issues.
describe('issues search row without a page marker (S3)', () => {
  test('the search row carries no page marker, including for one row and while typing', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 24,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 120]) {
      const lines = view.render(width).map(strip);
      assert.match(lines[1], /› Search/, 'the search widget keeps its row');
      assert.ok(!/page/i.test(lines[1]), `width ${width}: no page marker is printed`);
      assert.ok(!leftColumn(view, width).includes('page'), `width ${width}: the list spends no row on a marker`);
      assert.ok(!/page/i.test(lines[lines.length - 2]), 'the footer still carries keys only');
    }
    view.handleInput('T');
    view.handleInput('1');
    assert.ok(!/page/i.test(strip(view.render(80)[1])), 'no marker appears while the query is typed');
    view.handleInput('escape');
    assert.ok(!/page/i.test(strip(view.render(80)[1])), 'and none after the query is kept');
  });

  test('a server frame prints no page marker and appends the next page instead', async () => {
    const calls = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => {
        calls.push(request);
        return request.cursor === null
          ? { ok: true, issues: [cursorRow('n1', issue(1))], total: 2, hasNextPage: true }
          : { ok: true, issues: [cursorRow('n2', issue(2))], total: 2, hasNextPage: false };
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.ok(!/page/i.test(strip(view.render(100)[1])), 'a confirmed next page prints no marker');
    assert.equal(calls.length, 1, 'opening reads one page only');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    assert.equal(calls.length, 2, 'scrolling to the loaded bottom reads the next page');
    assert.ok(!/page/i.test(strip(view.render(100)[1])), 'still no marker');
    const left = leftColumn(view, 100);
    assert.match(left, /issue title 1/, 'the read page stays above');
    assert.match(left, /issue title 2/, 'the appended page extends the one list');
  });
});

// S10/S11: a write owns the view from its key until its answer, and the comment
// caret marks the real insertion point. Every action is a deferred public seam,
// so the busy frame, the key lock and the unlock are observed without timers.
describe('issues view pending writes and comment caret (S10/S11)', () => {
  const LOCKED_KEYS = ['ctrl+s', 'tab', 'shift+tab', 'escape', 'enter', 'y', 'j', 'k', 'down', 'up', 'T', 'q', 'x', 'r', 'right', 'left'];

  test('a label save paints its busy frame first, locks every key, then unlocks on success', async () => {
    const gate = deferred();
    const calls = [];
    let saved = ['bug'];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view, paints } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: saved.map((name) => ({ name })), permissions: EDITABLE }),
        comments: [],
      }),
      actions: {
        editLabels: (n, add, remove, created) => {
          calls.push([n, add, remove, created]);
          saved = ['bug', ...add];
          return gate.promise;
        },
      },
    });
    await tick();
    view.handleInput('L');
    view.handleInput('down');
    view.handleInput('space');
    const before = paints.length;
    view.handleInput('ctrl+s');
    assert.ok(paints.length > before, 'the busy state repaints before the answer arrives');
    assert.equal(view.state.saving, 'labels', 'the pending write is recorded at once');
    const busy = strip(view.render(100).join('\n'));
    assert.match(busy, /saving labels/, 'the busy frame names what is in flight');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    assert.equal(calls.length, 1, 'no second write is sent');
    assert.equal(view.state.mode, 'labels', 'the editor stays the visible state');
    assert.equal(view.state.page, 0, 'no tab move while pending');
    assert.equal(view.state.index, 0, 'no list move while pending');
    assert.equal(view.state.searching, false, 'no typing while pending');
    assert.equal(strip(view.render(100).join('\n')), busy, 'the pending frame is stable while keys arrive');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'the answer unlocks the view');
    assert.equal(view.state.mode, 'list');
    const settled = bodyOf(view, 100);
    assert.match(settled, /labels: bug, docs/, 'the refetched preview shows the saved labels');
    assert.ok(!settled.includes('saving labels'), 'the busy line is gone once it settled');
    assert.deepEqual(calls, [[1, ['docs'], [], []]], 'exactly one apply with the toggled delta');
  });

  test('a rejected label save unlocks and keeps the toggles', async () => {
    const gate = deferred();
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: EDITABLE }),
        comments: [],
      }),
      actions: { editLabels: () => gate.promise },
    });
    await tick();
    view.handleInput('L');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    gate.resolve({ ok: false, error: 'permission denied by GitHub' });
    await tick();
    assert.equal(view.state.saving, null, 'a rejected save unlocks the view');
    assert.equal(view.state.mode, 'labels', 'the editor stays open');
    const body = bodyOf(view, 100);
    assert.match(body, /permission denied by GitHub/, 'the real error is shown');
    assert.match(body, /\[x\] docs/, 'the toggled label survives the rejection');
    assert.ok(!body.includes('saving labels'), 'the busy line is gone');
  });

  test('an assignee save locks the view while pending and shows the saved state after', async () => {
    const gate = deferred();
    const calls = [];
    let assignees = [{ login: 'bob' }];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE, assignees }), comments: [] }),
      loadAssignees: () => ({ ok: true, users: [{ login: 'ann', name: 'Ann' }, { login: 'bob', name: '' }] }),
      actions: {
        editAssignees: (n, changes) => {
          calls.push([n, changes]);
          assignees = [{ login: 'ann' }];
          return gate.promise;
        },
      },
    });
    await tick();
    view.handleInput('a');
    await tick();
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    assert.equal(view.state.saving, 'assignees');
    assert.match(strip(view.render(100).join('\n')), /saving assignees/, 'the busy frame names the save');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    assert.equal(calls.length, 1, 'no duplicate assignee write');
    assert.match(bodyOf(view, 100), /\[x\] ann/, 'the pending frame keeps the draft toggles');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'success unlocks the view');
    assert.equal(view.state.mode, 'list');
    assert.deepEqual(calls, [[1, { add: ['ann'], remove: ['bob'] }]], 'one delta write');
    assert.match(bodyOf(view, 100), /assignees: ann/, 'the refetched preview shows the saved assignee');
  });

  test('a comment save locks typing while pending, then shows the posted comment', async () => {
    const gate = deferred();
    const calls = [];
    let comments = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: comments.slice() }),
      actions: {
        postComment: (n, text) => {
          calls.push([n, text]);
          comments = [{ author: 'octo', createdAt: new Date().toISOString(), body: text }];
          return gate.promise;
        },
      },
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'ship it') view.handleInput(ch);
    view.handleInput('ctrl+s');
    assert.equal(view.state.saving, 'comment');
    assert.match(strip(view.render(100).join('\n')), /posting comment/, 'the busy frame names the post in flight');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    for (const ch of 'xyz') view.handleInput(ch);
    assert.equal(view.state.commentText, 'ship it', 'typing is locked while the post is pending');
    assert.equal(view.state.mode, 'comment', 'esc cannot leave a pending post');
    assert.equal(calls.length, 1, 'no second post');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'success unlocks the view');
    assert.equal(view.state.mode, 'list', 'success leaves the editor');
    const settled = bodyOf(view, 100);
    assert.match(settled, /ship it/, 'the posted comment is displayed');
    assert.match(settled, /comment posted/);
    assert.equal(view.state.commentText, '', 'the sent draft is cleared');
  });

  test('a close save locks the confirmation while pending and then drops the issue', async () => {
    const gate = deferred();
    const calls = [];
    const rows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
      actions: { setState: (n, state) => { calls.push([n, state]); return gate.promise; } },
    });
    await tick();
    view.handleInput('x');
    view.handleInput('enter');
    assert.equal(view.state.saving, 'close');
    assert.match(strip(view.render(100).join('\n')), /closing issue/, 'the busy frame names the close');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    assert.equal(calls.length, 1, 'no duplicate close');
    assert.equal(view.state.mode, 'confirm', 'the confirmation stays visible while pending');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'success unlocks the view');
    assert.equal(view.state.mode, 'list');
    assert.deepEqual(calls, [[1, 'closed']], 'one close write');
    assert.ok(!leftColumn(view, 100).includes('issue title 1'), 'the closed issue leaves the open list');
    assert.match(leftColumn(view, 100), /issue title 2/, 'the remaining open issue stays listed');
  });

  test('a failed save keeps the draft and its error, and the view is usable again', async () => {
    const gate = deferred();
    const calls = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      actions: { postComment: (n, text) => { calls.push([n, text]); return gate.promise; } },
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'keep this') view.handleInput(ch);
    view.handleInput('ctrl+s');
    gate.resolve({ ok: false, error: 'rate limited' });
    await tick();
    assert.equal(view.state.saving, null, 'a rejected save unlocks the view');
    assert.equal(view.state.mode, 'comment', 'the editor and its draft survive the failure');
    const body = bodyOf(view, 100);
    assert.match(body, /rate limited/, 'the real error is shown');
    assert.match(body, /keep this/, 'the draft is preserved');
    assert.ok(!body.includes('posting comment'), 'the busy line is gone');
    assert.equal(calls.length, 1);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc still asks before discarding a draft');
    assert.match(strip(view.render(100).join('\n')), /Discard this draft/, 'the safe cancel behaviour is unchanged');
  });

  test('the comment editor paints the caret at the insertion point (S11)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    assert.match(bodyOf(view, 100), /█/, 'an empty draft shows where typing lands');
    for (const ch of 'hi') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /hi█/, 'the caret follows the typed text');
    view.handleInput('enter');
    for (const ch of 'there') view.handleInput(ch);
    const body = bodyOf(view, 100);
    assert.match(body, /there█/, 'on a new line the caret sits after the last typed character');
    assert.ok(!/h█i/.test(body), 'the caret is never detached from the insertion point');
    view.handleInput('backspace');
    assert.match(bodyOf(view, 100), /ther█/, 'Backspace moves the caret back with the text');
  });

  test('the caret lands on the real line on the first frame after opening and after enter (S11)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    // The header owns the first body row, so the insertion point of an empty
    // draft is the row directly under it — never the one below that.
    let rows = rightRows(view, 100);
    assert.match(rows[0], /Leave a comment/, 'the editor header owns the first body row');
    assert.equal(caretRow(rows), 1, 'an empty draft puts the caret on the first line under the header');
    assert.equal(rows[1], '█', 'and that line holds nothing but the caret');
    assert.equal(rows[2], '', 'no blank line is left between the header and the caret');

    for (const ch of 'hi') view.handleInput(ch);
    rows = rightRows(view, 100);
    assert.equal(caretRow(rows), 1, 'typing keeps the caret on the line typing continues on');
    assert.match(rows[1], /hi█/);

    // Enter opens the line under the typed text, so that IS the insertion row.
    view.handleInput('enter');
    rows = rightRows(view, 100);
    assert.equal(rows[1], 'hi', 'enter commits the typed line above');
    assert.equal(caretRow(rows), 2, 'enter moves the caret onto the new line, not one below it');
    assert.equal(rows[2], '█', 'the new line holds nothing but the caret');
    assert.equal(rows[3], '', 'the caret is not detached from the line it belongs to');

    for (const ch of 'there') view.handleInput(ch);
    rows = rightRows(view, 100);
    assert.equal(caretRow(rows), 2, 'typing after enter continues on the row the caret is on');
    assert.equal(rows[2], 'there█');
  });

  test('a full line still pushes the caret onto the next row (S11 preserved)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    const rightWidth = readerPanes(100).right;
    assert.ok(rightWidth > 0, 'the pane has room to fill');
    for (const ch of 'x'.repeat(rightWidth)) view.handleInput(ch);
    const rows = rightRows(view, 100);
    assert.equal(rows[1], 'x'.repeat(rightWidth), 'the typed line fills the pane exactly');
    assert.equal(caretRow(rows), 2, 'a line with no room left wraps the caret onto the next row');
    assert.equal(rows[2], '█');
  });
});

// S9 (round 3, second pass): remote search is debounced. The clock is injected
// (scheduleQuery/cancelSchedule), so a burst of typing, the stale answer inside
// the wait and every flush point are observed without wall-clock waits.
describe('issues remote search scheduling (S9)', () => {
  function scheduledServerView(clock, serve, overrides = {}) {
    const requests = [];
    const made = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        requests.push(request);
        return serve(request);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...overrides,
    });
    return { ...made, requests };
  }

  test('a burst of typing schedules ONE read for the query it settles on', async () => {
    const clock = manualScheduler();
    const { view, requests, paints } = scheduledServerView(clock, () => pageResult([cursorRow('m1', issue(1))], { total: 1 }));
    await tick();
    assert.equal(requests.length, 1, 'the mount read is never debounced');
    const before = paints.length;
    view.handleInput('T');
    for (const ch of 'crash') view.handleInput(ch);
    assert.equal(view.state.query, 'crash', 'the query is recorded at once');
    assert.match(strip(view.render(100)[1]), /› crash█/, 'the box shows the query and its caret at once');
    assert.equal(requests.length, 1, 'no request per keystroke');
    assert.ok(paints.length > before, 'each keystroke repaints the box');
    assert.equal(view.state.searchPending, true, 'the scheduled read is visible state');
    const waiting = strip(view.render(100).join('\n'));
    assert.match(waiting, /searching/, 'the frame names the search being scheduled');
    assert.match(waiting, /issue title 1/, 'the rows already loaded stay on screen');
    assert.ok(!waiting.includes('loading issues'), 'no full-screen loader flash while typing');
    assert.equal(clock.live().length, 1, 'one live callback, never one per keystroke');
    assert.ok(clock.live()[0].delayMs >= 100 && clock.live()[0].delayMs <= 250,
      `a short fixed debounce delay: ${clock.live()[0].delayMs}`);
    clock.fire();
    assert.equal(requests.length, 2, 'the settled query reads once');
    assert.deepEqual(requests[1], { bucketId: 'mine', cursor: null, limit: 18, query: 'crash' });
    assert.equal(view.state.searchPending, false, 'the wait ends when the read starts');
  });

  test('an answer for the previous query cannot paint while the new one waits', async () => {
    const clock = manualScheduler();
    const pending = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(pageResult([cursorRow('m1', issue(1, { title: 'mount row' }))], { total: 1 }));
    await tick();
    leftColumn(view, 100);
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('enter');            // the 'a' read is in flight
    assert.deepEqual(pending[1].request, { bucketId: 'mine', cursor: null, limit: 18, query: 'a' });
    view.handleInput('T');
    view.handleInput('b');                // 'ab' waits, so 'a' is already stale
    pending[1].entry.resolve(pageResult([cursorRow('o1', issue(9, { title: 'a only match' }))], { total: 1 }));
    await tick();
    const waiting = leftColumn(view, 100);
    assert.match(waiting, /mount row/, 'the rows on screen are the ones the reader last saw');
    assert.ok(!waiting.includes('a only match'), 'the answer for the superseded query never paints');
    clock.fire();
    pending[2].entry.resolve(pageResult([cursorRow('n1', issue(3, { title: 'ab match' }))], { total: 1 }));
    await tick();
    assert.match(leftColumn(view, 100), /ab match/, 'only the newest query answer paints');
    assert.equal(pending.length, 3, 'exactly three reads: mount, flushed query, settled query');
  });

  test('leaving the box reads the pending query once and never twice', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, () => pageResult([cursorRow('b1', issue(2))], { total: 1 }));
    await tick();
    view.handleInput('T');
    for (const ch of 'bug') view.handleInput(ch);
    assert.equal(requests.length, 1, 'typing waits for the debounce');
    view.handleInput('enter');
    assert.equal(view.state.searching, false);
    assert.equal(requests.length, 2, 'leaving the box issues the read now');
    assert.deepEqual(requests[1], { bucketId: 'mine', cursor: null, limit: 18, query: 'bug' });
    assert.equal(clock.live().length, 0, 'the pending callback is cancelled, not left to fire');
    clock.fire();
    assert.equal(requests.length, 2, 'a cancelled callback never reads');
    view.handleInput('T');
    view.handleInput('x');
    view.handleInput('escape');
    assert.equal(requests.length, 3, 'escape keeps the filter and reads it once too');
    assert.equal(view.state.query, 'bugx', 'escape never changes the typed query');
    assert.equal(clock.live().length, 0);
  });

  test('a refresh under a pending query reads page one of that query only once', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, () => pageResult([cursorRow('g1', issue(1))], { total: 2, hasNextPage: true }));
    await tick();
    view.handleInput('T');
    for (const ch of 'lab') view.handleInput(ch);
    view.handleInput('enter');
    leftColumn(view, 100);
    view.handleInput('r');
    assert.equal(requests.length, 3, 'the explicit refresh reads the current page of the current query');
    assert.deepEqual(requests[2], { bucketId: 'mine', cursor: null, limit: 18, query: 'lab' },
      'never an old cursor, never the previous query');
    clock.fire();
    assert.equal(requests.length, 3, 'no second request from a cancelled callback');
  });

  test('static local search stays immediate and never schedules', async () => {
    const clock = manualScheduler();
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'beta') view.handleInput(ch);
    assert.equal(view.state.searchPending, false, 'a local list filters without a scheduled read');
    assert.equal(clock.entries.length, 0, 'nothing is scheduled for local search');
    const body = bodyOf(view, 100);
    assert.match(body, /issue title 2/, 'the local filter applies at once');
    assert.ok(!body.includes('alpha crash'), 'the other local row is filtered out');
  });

  test('a late answer after the reader closed paints nothing', async () => {
    const clock = manualScheduler();
    const gate = deferred();
    const paints = [];
    let settled = 'pending';
    const view = createIssuesView({
      rowsAvailable: () => 24,
      helpers,
      theme: plainTheme,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      requestRender: () => { paints.push(true); },
      done: (result) => { settled = result; },
      loadIssuePage: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    view.handleInput('T');
    view.handleInput('q');
    view.handleInput('enter');
    view.handleInput('escape');
    assert.equal(settled, null, 'esc still closes with null');
    const before = paints.length;
    gate.resolve(pageResult([cursorRow('z1', issue(5))], { total: 1 }));
    await tick();
    assert.equal(paints.length, before, 'a late answer repaints nothing after close');
  });

  // S9: rows answer ONE query. A search that fails must never leave the
  // previous query's rows (or its total) looking like this query's result.
  test('a failed search for a new query drops the previous query rows and count', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, (request) => {
      if (request.query === 'z') {
        if (request.bucketId === 'mine') {
          return { ok: false, error: 'GitHub issue search exceeds 1000 matches; narrow the filter', truncated: true };
        }
        return pageResult([cursorRow('a1', issue(7, { title: 'assigned match' }))], { total: 1 });
      }
      return pageResult([cursorRow('f1', issue(1)), cursorRow('f2', issue(2))], { total: 2 });
    });
    await tick();
    assert.match(strip(view.render(100)[2]), /▸ My issues \(2\)/, 'the unfiltered read names its own count');
    view.handleInput('T');
    view.handleInput('z');
    view.handleInput('enter');
    await tick();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], { bucketId: 'mine', cursor: null, limit: 18, query: 'z' });
    const body = bodyOf(view, 100);
    assert.match(body, /failed to load issues: GitHub issue search exceeds 1000 matches; narrow the filter/,
      'the search cap is reported honestly');
    assert.ok(!body.includes('issue title 1'), 'the previous query row is never presented as this query result');
    assert.ok(!body.includes('issue title 2'), 'no unfiltered row survives the failed search');
    assert.ok(!/1000\+/.test(body), 'no truncated result is claimed as the full dataset');
    assert.equal(view.state.loading, false, 'the failure ends the loading state');
    assert.equal(view.state.page, 0, 'the failure leaves the reader on the bucket that failed');
    // S9: the count falls back to UNKNOWN instead of reusing another query's
    // total, and only the bucket that failed lost its rows.
    view.handleInput('tab');
    await tick();
    const tabs = strip(view.render(100)[2]);
    assert.match(tabs, /My issues \(–\)/, 'a total from another query is unknown, never reused');
    assert.match(tabs, /▸ Assigned \(1\)/, 'the bucket that answered keeps its own count');
    const left = leftColumn(view, 100);
    assert.match(left, /assigned match/, 'the bucket that answered paints its rows');
    assert.ok(!left.includes('issue title 1'), 'the failed bucket keeps presenting no rows');
  });

  // S9: the clear is per bucket. A failure on the bucket on screen never
  // reaches into another bucket's own rows.
  test('a failed query clears only the bucket that failed', async () => {
    const clock = manualScheduler();
    const assigned = deferred();
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        if (request.query === 'z') {
          if (request.bucketId === 'assigned') return assigned.promise;
          return { ok: false, error: 'GitHub issue search exceeds 1000 matches; narrow the filter' };
        }
        return request.bucketId === 'assigned'
          ? pageResult([cursorRow('a1', issue(2, { title: 'assigned row' }))], { total: 1 })
          : pageResult([cursorRow('m1', issue(1, { title: 'mine row' }))], { total: 1 });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('tab');
    await tick();
    assert.match(leftColumn(view, 100), /assigned row/, 'the second bucket read its own rows');
    view.handleInput('shift+tab');
    await tick();
    view.handleInput('T');
    view.handleInput('z');
    view.handleInput('enter');
    await tick();
    assert.ok(!bodyOf(view, 100).includes('mine row'), 'the failing bucket lost its rows');
    view.handleInput('tab');
    await tick();
    assert.match(leftColumn(view, 100), /assigned row/,
      'the other bucket keeps the rows of its own query while it reads the new one');
    assigned.resolve(pageResult([cursorRow('a2', issue(5, { title: 'assigned match' }))], { total: 1 }));
    await tick();
    assert.match(leftColumn(view, 100), /assigned match/, 'and its own answer paints when it lands');
    assert.ok(!leftColumn(view, 100).includes('assigned row'), 'the bucket result is replaced, not appended');
  });

  // S9: the reported blocker — All painted its unfiltered connection rows under
  // a failed typed search, and the same rows never came back after the reader
  // cleared the query.
  test('All drops its connection rows when a typed query fails, and reads them again after', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, (request) => {
      if (request.query !== '') {
        return { ok: false, error: 'GitHub issue search exceeds 1000 matches; narrow the filter', truncated: true };
      }
      if (request.bucketId === 'all') {
        return pageResult([cursorRow('a1', issue(41, { title: 'all connection row' }))], { total: 2, hasNextPage: true });
      }
      return pageResult([cursorRow('m1', issue(40, { title: 'mine row' }))], { total: 1 });
    });
    await tick();
    view.handleInput('tab');
    view.handleInput('tab');
    view.handleInput('tab');
    await tick();
    assert.equal(view.state.page, 3, 'All is the fourth tab');
    assert.match(strip(view.render(100)[2]), /▸ All \(2\+\)/, 'All names the connection total');
    assert.match(leftColumn(view, 100), /all connection row/, 'All paints the connection rows');
    view.handleInput('T');
    view.handleInput('z');
    view.handleInput('enter');
    await tick();
    assert.equal(requests.at(-1).bucketId, 'all', 'the typed query reads the bucket on screen');
    assert.equal(requests.at(-1).query, 'z');
    let body = bodyOf(view, 100);
    assert.match(body, /failed to load issues: GitHub issue search exceeds 1000 matches/);
    assert.ok(!body.includes('all connection row'),
      'the unfiltered connection rows are never presented as matches for the query');
    // Clearing the query is a new read of the connection, and it paints again.
    view.handleInput('T');
    view.handleInput('delete');
    clock.fire();
    await tick();
    assert.equal(requests.at(-1).bucketId, 'all');
    assert.equal(requests.at(-1).query, '', 'the cleared query reads the connection source again');
    body = bodyOf(view, 100);
    assert.match(body, /all connection row/, 'the connection rows come back with the query cleared');
    assert.match(strip(view.render(100)[2]), /▸ All \(2\+\)/, 'and its own count comes back with them');
    assert.ok(!body.includes('failed to load issues'), 'the failure is gone once a read answers');
  });

  // S9: a continuation page is the SAME query. Its failure is reported, but the
  // rows already read for that query stay — they are still that query's rows.
  test('a failed append keeps the rows of the query they belong to', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, (request) => (request.cursor === null
      ? pageResult([cursorRow('c1', issue(1, { title: 'first page row' }))], { total: 2, hasNextPage: true })
      : { ok: false, error: 'gh issue list failed: HTTP 502: bad gateway' }));
    await tick();
    assert.match(strip(view.render(100)[2]), /▸ My issues \(2\+\)/, 'the first page names its own count');
    view.handleInput(']');
    await tick();
    assert.equal(requests.length, 2, 'reaching the loaded bottom asks for the next page');
    assert.equal(requests[1].cursor, 'c1', 'the append continues after the last loaded row');
    const body = bodyOf(view, 100);
    assert.match(body, /first page row/, 'the rows of the same query stay painted');
    assert.equal(body.split('first page row').length - 1, 1, 'and are never duplicated');
    assert.match(body, /502: bad gateway/, 'the failed continuation is reported');
    assert.ok(!body.includes('failed to load issues'), 'a failed append is a note, not a blank list');
    assert.match(strip(view.render(100)[2]), /▸ My issues \(2\+\)/, 'the count still describes the rows listed');
  });

  // S9: an explicit refresh reads the SAME query again. Its failure keeps the
  // rows the reader is on (the preview beside them survives too).
  test('a failed refresh of the same query keeps the rows it already showed', async () => {
    const clock = manualScheduler();
    let reads = 0;
    const { view } = scheduledServerView(clock, () => {
      reads += 1;
      return reads === 1
        ? pageResult([cursorRow('r1', issue(1, { title: 'refresh row' }))], { total: 1 })
        : { ok: false, error: 'gh issue list failed: HTTP 500: server error' };
    });
    await tick();
    assert.match(leftColumn(view, 100), /refresh row/);
    view.handleInput('r');
    await tick();
    assert.equal(reads, 2, 'the refresh reads the query again');
    const body = bodyOf(view, 100);
    assert.match(body, /refresh row/, 'the rows of the same query stay painted');
    assert.match(body, /500: server error/, 'the failure is reported on the note row');
    assert.match(strip(view.render(100)[2]), /▸ My issues \(1\)/, 'the count still describes the rows listed');
  });

  // S9: the answer that clears rows is the one for the query on screen. A
  // superseded query's failure is dropped exactly like its rows would be.
  test('a failed answer for a superseded query neither paints nor clears', async () => {
    const clock = manualScheduler();
    const pending = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(pageResult([cursorRow('m1', issue(1, { title: 'mount row' }))], { total: 1 }));
    await tick();
    leftColumn(view, 100);
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('enter');
    assert.deepEqual(pending[1].request, { bucketId: 'mine', cursor: null, limit: 18, query: 'a' });
    view.handleInput('T');
    view.handleInput('b');
    clock.fire();
    assert.deepEqual(pending[2].request, { bucketId: 'mine', cursor: null, limit: 18, query: 'ab' });
    pending[1].entry.resolve({ ok: false, error: 'GitHub issue search exceeds 1000 matches' });
    await tick();
    const waiting = leftColumn(view, 100);
    assert.match(waiting, /mount row/, 'the rows on screen are never cleared by a stale failure');
    assert.ok(!strip(view.render(100).join('\n')).includes('1000 matches'), 'and its error never paints');
    pending[2].entry.resolve(pageResult([cursorRow('n1', issue(3, { title: 'ab match' }))], { total: 1 }));
    await tick();
    assert.match(leftColumn(view, 100), /ab match/, 'only the newest query answer paints');
  });
});

// S3: with no pager there is no position marker to reserve or clip, so an empty
// result and a long query simply own the whole search row.
describe('issues search row for empty and long results (S3)', () => {
  function rightColumn(view, width, rows = 24) {
    const panes = readerPanes(width);
    return view.render(width)
      .slice(4, Math.max(4, rows - 2))
      .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join(''))
      .join('\n');
  }

  test('an empty result prints no page marker and keeps the empty state', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const lines = view.render(100).map(strip);
    assert.match(lines[1], /› Search/, 'the search widget keeps its row');
    assert.ok(!/page/i.test(lines[1]), 'the empty list prints no page marker');
    assert.ok(!leftColumn(view, 100).includes('page'), 'the list still holds rows only');
    assert.match(bodyOf(view, 100), /no issues/i);
  });

  test('an empty server result says so honestly and invents no count', async () => {
    const clock = manualScheduler();
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: () => pageResult([], { total: 0 }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.ok(!/page/i.test(strip(view.render(100)[1])), 'no page marker is printed');
    assert.match(rightColumn(view, 100), /no issues/, 'the empty pane says so honestly');
  });

  test('a long query is clipped in the display only: the caret stays where typing lands', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)]], [], []),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const long = 'author:@me label:bug is:open no:assignee sort:updated-desc milestone:v1 project:roadmap';
    view.handleInput('T');
    for (const ch of long) view.handleInput(ch);
    assert.equal(view.state.query, long, 'the stored query keeps every character');
    const row = strip(view.render(80)[1]);
    assert.match(row, /…/, 'the displayed query is clamped');
    assert.match(row, /█/, 'the caret stays visible where typing lands');
    assert.ok(!row.includes(long), 'the display never claims to hold the whole query');
  });

  test('a query the pane can hold is not touched', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)]], [], []),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'bug') view.handleInput(ch);
    assert.match(strip(view.render(120)[1]), /› bug█/, 'a short query renders verbatim');
  });
});

// S16 (T6 hand-over): the Issues preview is the SAME formatter the worktree
// detail uses — lib/issue-preview.js — so the two surfaces cannot drift.
describe('issues preview shares lib/issue-preview.js (S16)', () => {
  const { issueDetailLines } = require('../lib/issue-preview.js');

  function rightColumn(view, width, rows = 24) {
    const panes = readerPanes(width);
    return view.render(width)
      .slice(4, Math.max(4, rows - 2))
      .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join(''))
      .join('\n');
  }

  const detail = issue(7, {
    title: 'shared preview title',
    labels: [{ name: 'bug' }, { name: 'urgent' }],
    assignees: [{ login: 'ann' }, { login: 'bob' }],
    projects: [{ title: 'Roadmap' }],
    linkedPullRequestCount: 2,
    reactions: { plusOne: 4 },
    commentsCount: 2,
    body: 'the body the preview renders',
  });
  const comments = [
    { author: 'carol', createdAt: new Date(Date.now() - 300_000).toISOString(), body: 'first shared comment' },
    { author: 'dave', createdAt: new Date(Date.now() - 60_000).toISOString(), body: 'second shared comment' },
  ];

  function previewView(theme = plainTheme) {
    return makeView({
      pages: pagesOf([[detail], [], []]),
      issues: [detail],
      rows: 40,
      theme,
      loadIssue: () => ({ ok: true, issue: detail, comments }),
    });
  }

  test('the ready pane is exactly what issueDetailLines renders', async () => {
    const { view } = previewView();
    await tick();
    const panes = readerPanes(100);
    const expected = issueDetailLines(detail, comments, { width: panes.right })
      .map((line) => line.trimEnd());
    const actual = rightColumn(view, 100, 40).split('\n').map((line) => line.trimEnd());
    // Trailing padding rows are frame, not preview.
    while (expected.length > 0 && expected[expected.length - 1] === '') expected.pop();
    while (actual.length > 0 && actual[actual.length - 1] === '') actual.pop();
    assert.deepEqual(actual, expected, 'every field, label, count, blank line and end marker matches the shared formatter');
  });

  // T9 (S13): the right-pane issue title is a TITLE, so it takes the same role
  // the shared table gives the frame title and every other title — the preview
  // formatter asks the palette for it instead of hardcoding `accent`.
  test('the preview title takes the shared title role the formatter paints', async () => {
    const calls = [];
    const theme = {
      fg: (role, text) => { calls.push([role, text]); return String(text); },
      bg: (_role, text) => String(text),
    };
    const { view } = previewView(theme);
    await tick();
    view.render(100);
    assert.ok(
      calls.some(([role, text]) => role === 'customMessageLabel' && text === '#7 shared preview title'),
      'the title is painted with the shared title role',
    );
    assert.ok(
      !calls.some(([role, text]) => role === 'accent' && text === '#7 shared preview title'),
      'the title is not painted with the button accent',
    );
  });

  test('the error and loading panes stay the view own status lines', async () => {
    const failing = makeView({
      pages: pagesOf([[detail], [], []]),
      issues: [detail],
      rows: 40,
      loadIssue: () => ({ ok: false, error: 'gh timed out' }),
    });
    await tick();
    assert.match(rightColumn(failing.view, 100, 40), /unreadable: gh timed out/,
      'a failed detail read keeps its honest status line');
  });
});


describe('round3 shared preview bindings and lossless comments', () => {
  async function scrollingView(extra = {}) {
    const rows = [issue(1), issue(2)];
    const result = makeView({
      pages: pagesOf([rows, [], []]), issues: rows, rows: 18,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: 'body line\n'.repeat(150) }), comments: [] }),
      ...extra,
    });
    result.view.render(220);
    await tick();
    result.view.render(220);
    return result;
  }

  test('ctrl+j/k and the extended pair page before a case-folding host can select', async () => {
    const { view, paints } = await scrollingView({ helpers: {
      ...helpers,
      matchesKey: (data, name) => name.length === 1
        ? data.toLowerCase() === name.toLowerCase() : data === name,
    } });
    view.handleInput('pagedown');
    const page = view.state.scroll;
    assert.ok(page > 0);
    for (const key of ['ctrl+j', '\x1b[106;5u', '\x1b[27;5;106~', 'ctrl+shift+j', 'shift+ctrl+j', '\x1b[106;6u', '\x1b[27;6;106~', 'J']) {
      view.handleInput('home');
      view.handleInput(key);
      assert.equal(view.state.scroll, page, `${key} pages the document down`);
      assert.equal(view.state.index, 0, 'paging never selects');
    }
    for (const key of ['ctrl+k', '\x1b[107;5u', '\x1b[27;5;107~', 'ctrl+shift+k', '\x1b[107;6u', 'K']) {
      view.handleInput('home');
      view.handleInput('pagedown');
      const down = view.state.scroll;
      view.handleInput(key);
      assert.ok(view.state.scroll < down, `${key} pages the document up`);
    }
    view.handleInput('home');
    const before = paints.length;
    view.handleInput('\x1b[106;6:3u');
    assert.equal(view.state.scroll, 0);
    assert.equal(paints.length, before, 'release never repaints');
    for (const key of ['\n', '\r', '\x0b', 'enter']) {
      view.handleInput(key);
      assert.equal(view.state.scroll, 0, `${JSON.stringify(key)}: a bare newline and the legacy ctrl+k byte never scroll`);
    }
    view.handleInput('ctrl+d');
    assert.equal(view.state.scroll, Math.max(1, Math.floor(page / 2)), 'half-page stays distinct');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'lowercase still selects');
    view.handleInput('t');
    view.handleInput('J');
    assert.equal(view.state.query, 'J', 'search receives text, not preview paging');
  });

  test('the legend always names ctrl+j/k doc, never a fabricated capability', async () => {
    for (const active of [false, true]) {
      const { view } = await scrollingView({ helpers: { ...helpers, isKittyProtocolActive: () => active } });
      const footer = strip(view.render(220).at(-2));
      assert.equal(footer.split('ctrl+j/k doc').length - 1, 1, `kitty ${active}: one labelled document token: ${footer}`);
      assert.ok(!footer.includes('ctrl+shift'), `kitty ${active}: the shifted alternate leaves the legend: ${footer}`);
      assert.ok(!footer.includes('shift+j/k'), `kitty ${active}: the printable alternate leaves the legend: ${footer}`);
    }
  });

  test('a bare newline stays Enter: it confirms and never scrolls, even when the host calls it ctrl+j', async () => {
    // The installed matcher reports the same 0x0a byte as BOTH `ctrl+j` and
    // `enter` while no extended protocol is active. On that terminal Enter must
    // keep its confirm meaning and the byte must never page the document.
    const lfIsCtrlJ = {
      ...helpers,
      matchesKey: (data, name) => data === name || (data === '\n' && (name === 'enter' || name === 'ctrl+j')),
      parseKey: (data) => (data === '\n' ? 'ctrl+j' : null),
    };
    const calls = [];
    const rows = [issue(1), issue(2)];
    const confirmView = makeView({
      helpers: lfIsCtrlJ,
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
      actions: { setState: (n, state) => { calls.push([n, state]); return { ok: true }; } },
    }).view;
    confirmView.render(160);
    await tick();
    confirmView.handleInput('x');
    assert.equal(confirmView.state.mode, 'confirm', 'x opens the close confirmation');
    confirmView.handleInput('\n');
    await tick();
    assert.deepEqual(calls, [[1, 'closed']], 'the newline confirms the close instead of scrolling');
    assert.equal(confirmView.state.scroll, 0, 'the newline never paged the document');

    const commentView = makeView({
      helpers: lfIsCtrlJ,
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
    }).view;
    await tick();
    commentView.render(160);
    commentView.handleInput('c');
    assert.equal(commentView.state.mode, 'comment');
    commentView.handleInput('h');
    commentView.handleInput('i');
    commentView.handleInput('\n');
    assert.equal(commentView.state.commentText, 'hi\n', 'the newline starts a comment line instead of scrolling');
    assert.equal(commentView.state.scroll, 0, 'and the document never moved');

    const { view: scrolling } = await scrollingView({ helpers: lfIsCtrlJ });
    scrolling.handleInput('ctrl+j');
    assert.ok(scrolling.state.scroll > 0, 'the distinguishable ctrl+j still pages the document');
  });

  test('the Issues preview keeps every character of an overlong comment token', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]), issues: [issue(1)],
      loadIssue: () => ({ ok: true, issue: issue(1), comments: [{ author: 'writer', body: 'X'.repeat(2500) }] }),
    });
    view.render(110);
    await tick();
    let seen = '';
    let previous = null;
    for (let step = 0; step < 200; step += 1) {
      const body = view.render(110).slice(4, -2).map(strip);
      const scroll = view.state.scroll;
      const overlap = previous === null ? 0 : Math.max(0, previous + body.length - scroll);
      seen += body.slice(overlap).join('');
      if (previous === scroll) break;
      previous = scroll;
      view.handleInput('pagedown');
    }
    assert.equal((seen.match(/X/g) || []).length, 2500);
    assert.match(seen, /end of issue/);
  });
});

// S14: the user read the extra document-scroll tokens as noise — «alguna key
// generidad como el page o half estan demas (nose para que es)». The footer now
// spends ONE token per scroll target and names that target in the token
// (`ctrl+j/k doc` for the reading pane, `]/[ pane` for the list beside it),
// while every key whose hint left the row keeps the binding the old legend
// advertised.
describe('issues footer names each scroll target once (S14)', () => {
  const longBody = Array.from({ length: 100 }, (_, i) => `body line ${i + 1}`).join('\n');

  function scrollView(extra = {}) {
    const rows = Array.from({ length: 12 }, (_, i) => issue(i + 1, { body: longBody }));
    const result = makeView({
      pages: pagesOf([rows, [issue(20), issue(21)], [issue(30)]]),
      issues: rows,
      rows: 16,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
      ...extra,
    });
    result.view.render(160);
    return result;
  }

  const footerOf = (view, width) => strip(view.render(width).at(-2));

  test('the document-scroll hints collapse to ONE token that names its target', async () => {
    for (const active of [true, false]) {
      const { view } = scrollView({ helpers: { ...helpers, isKittyProtocolActive: () => active } });
      await tick();
      const footer = footerOf(view, 160);
      assert.equal(footer.split('ctrl+j/k doc').length - 1, 1, `the document hint is named once with its target: ${footer}`);
      for (const gone of ['PgUp', 'PgDn', 'PgUp/Dn', 'ctrl+d/u', 'half', 'ctrl+shift', 'shift+j/k doc']) {
        assert.ok(!footer.includes(gone), `the redundant "${gone}" token is gone: ${footer}`);
      }
    }
  });

  test('list and document scrolling stay distinguishable, with no bare "scroll" left', async () => {
    const { view } = scrollView();
    await tick();
    const footer = footerOf(view, 160);
    assert.ok(footer.includes(']/[ pane'), `the list hint names the pane it scrolls: ${footer}`);
    assert.ok(!footer.includes('scroll'), `no unlabelled scroll token is left to guess at: ${footer}`);
  });

  test('every document-scroll binding keeps working after its hint left the row', async () => {
    const { view } = scrollView();
    await tick();
    view.render(160);
    for (const key of ['pagedown', '\x1b[6~', 'ctrl+j', '\x1b[106;5u', 'ctrl+shift+j', 'J']) {
      view.handleInput('home');
      assert.equal(view.state.scroll, 0, `home returns the document to the top: ${key}`);
      view.handleInput(key);
      assert.ok(view.state.scroll > 0, `${key} still pages the document down`);
      assert.equal(view.state.index, 0, `${key} never moves the list selection`);
    }
    view.handleInput('home');
    view.handleInput('pagedown');
    const page = view.state.scroll;
    view.handleInput('home');
    view.handleInput('ctrl+d');
    const half = view.state.scroll;
    assert.ok(half > 0 && half < page, `ctrl+d is still half a page: ${half} of ${page}`);
    view.handleInput('ctrl+u');
    assert.equal(view.state.scroll, 0, 'ctrl+u is still half a page back up');
    for (const key of ['pageup', '\x1b[5~', 'ctrl+k', '\x1b[107;5u', 'ctrl+shift+k', 'K']) {
      view.handleInput('pagedown');
      const down = view.state.scroll;
      assert.ok(down > 0, `pagedown has somewhere to come back from: ${key}`);
      view.handleInput(key);
      assert.ok(view.state.scroll < down, `${key} still pages the document up`);
    }
    view.handleInput('pagedown');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home still returns the document to the top');
    view.handleInput('pagedown');
    view.handleInput('end');
    assert.equal(view.state.scroll, 0, 'end still shows the last issue from its own top');
    assert.equal(view.state.index, 11, 'end still selects the last issue');
  });

  test('the list scroll and the bucket keys keep their own bindings', async () => {
    const { view } = scrollView();
    await tick();
    view.render(160);
    assert.equal(view.state.listStart, 0);
    view.handleInput(']');
    const moved = view.state.listStart;
    assert.ok(moved > 0, '] still scrolls the list a screenful');
    view.handleInput('[');
    assert.ok(view.state.listStart < moved, '[ still scrolls the list back');
    for (const [key, bucket] of [['right', 1], ['tab', 2], ['left', 1], ['shift+tab', 0]]) {
      view.handleInput(key);
      assert.equal(view.state.page, bucket, `${key} still switches buckets`);
      assert.equal(view.state.scroll, 0, `${key} never scrolls the document`);
    }
  });

  test('the collapsed legend stays exactly ONE row at narrow widths', async () => {
    const { view } = scrollView();
    await tick();
    for (const width of [100, 80, 60]) {
      const lines = view.render(width);
      assert.equal(lines.length, 16, `the frame keeps its 16-row budget at ${width}`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `the frame stays ${width} wide`);
      const footer = strip(lines.at(-2));
      assert.ok(footer.startsWith('│ ') && footer.endsWith(' │'), `the legend fills one row cell-exact: ${footer}`);
      assert.ok(footer.includes('esc close'), `the close hint outlives the trim at ${width}: ${footer}`);
      assert.ok(!footer.includes('PgUp') && !footer.includes('ctrl+d/u'), `no dropped token returns at ${width}: ${footer}`);
    }
  });
});

// S3 (T3): the reader no longer pages the list. The left pane takes the smaller
// 30% share, the list is ONE continuous window that scrolls by a screenful, and
// on the server seam the next cursor page APPENDS to the rows already loaded —
// search still reads the complete bucket through `query`, so no local filter is
// ever the source of truth.
describe('issues continuous list scrolling instead of pages (S3)', () => {
  const readerPanes = (width) => layout.paneWidths(layout.innerWidth(width), { listShare: layout.READER_LIST_SHARE });

  test('the left pane takes the smaller 30/70 share at 80, 120 and 200 columns', async () => {
    for (const width of [80, 120, 200]) {
      const { view } = makeView({
        rows: 24,
        loadIssuePage: () => pageResult([cursorRow('c1', issue(1, { title: 'short title' }))]),
        loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      });
      await tick();
      const expected = readerPanes(width).left;
      const bodyRow = strip(view.render(width)[5]);
      assert.equal([...bodyRow].indexOf('│', 2), 3 + expected, `${width}: the left pane is ${expected} cells`);
      assert.ok(expected < layout.paneWidths(layout.innerWidth(width)).left, `${width}: it is narrower than the old 40% list`);
    }
  });

  test('no page marker renders anywhere in the frame', async () => {
    const rows = Array.from({ length: 30 }, (_, at) => issue(at + 1));
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.ok(!/page \d/i.test(body), 'no page indicator is printed');
    assert.match(strip(view.render(100)[1]), /› Search/, 'the search row carries the widget alone');
  });

  test('the footer names no page key', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 24,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const footer = strip(view.render(200).at(-2));
    assert.ok(!/page/i.test(footer), `the legend drops the page hint: ${footer}`);
    // S10: the arrows switch buckets now, so the legend names THEM as the
    // bucket key and keeps `]`/`[` as the list scroll.
    assert.match(footer, /←→ bucket/, 'the bucket switch is still named, arrows only');
    assert.ok(!footer.includes('tab'), 'tab keeps working but leaves the legend');
    // S14: the token names the pane it scrolls, and the document pane's aliases
    // are collapsed into the one labelled token beside it.
    assert.match(footer, /\]\/\[ pane/, 'the list scroll key is still named, with its target');
    assert.match(footer, /ctrl\+j\/k doc/, 'the document scroll is named once with its target');
  });

  test('a long list scrolls continuously: the window moves a screen at a time', async () => {
    const rows = Array.from({ length: 30 }, (_, at) => issue(at + 1));
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    // 12 rows leave 6 body rows, so the first window paints issues 1..6.
    const first = leftColumn(view, 100, 12);
    assert.match(first, /issue title 1/);
    assert.match(first, /issue title 6/);
    assert.ok(!first.includes('issue title 7'), 'the rest of the list is below the window');
    view.handleInput(']');
    const second = leftColumn(view, 100, 12).split('\n').map((row) => row.trim().replace(/^[▸ ] /, ''));
    assert.equal(second[0], 'issue title 7', '→ scrolls to the next screen starting after the last visible row');
    assert.equal(second[5], 'issue title 12');
    assert.ok(!second.includes('issue title 1'), 'the previous screen scrolled away');
    view.handleInput('[');
    const back = leftColumn(view, 100, 12).split('\n').map((row) => row.trim().replace(/^[▸ ] /, ''));
    assert.equal(back[0], 'issue title 1', '← scrolls back to the first screen');
  });

  test('the selection walks past the window edge and the list follows it', async () => {
    const rows = Array.from({ length: 20 }, (_, at) => issue(at + 1));
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (let step = 0; step < 6; step += 1) view.handleInput('down');
    assert.equal(view.state.index, 6, 'the seventh issue is focused');
    const left = leftColumn(view, 100, 12);
    assert.ok(!left.includes('issue title 1'), 'the window scrolled past the first row');
    assert.match(left, /▸ issue title 7/, 'the focused row is painted at the window edge');
  });

  test('home and end move the window to the first and the last loaded row', async () => {
    const rows = Array.from({ length: 25 }, (_, at) => issue(at + 1));
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('end');
    assert.equal(view.state.index, 24);
    assert.match(leftColumn(view, 100, 12), /▸ issue title 25/, 'the last issue is painted');
    view.handleInput('home');
    assert.equal(view.state.index, 0);
    assert.match(leftColumn(view, 100, 12), /▸ issue title 1/, 'the first issue is painted again');
  });

  test('scrolling to the bottom of the server list appends the next cursor page', async () => {
    const calls = [];
    const { view } = makeView({
      rows: 12,
      loadIssuePage: (request) => {
        calls.push(request);
        if (request.cursor === null) {
          return pageResult([
            cursorRow('c1', issue(1)),
            cursorRow('c2', issue(2)),
            cursorRow('c3', issue(3)),
          ], { hasNextPage: true });
        }
        return pageResult([cursorRow('c4', issue(4)), cursorRow('c5', issue(5))]);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.equal(calls.length, 1, 'opening reads one page, never the whole bucket');
    leftColumn(view, 60, 12);
    view.handleInput(']');
    assert.equal(calls.length, 2, 'scrolling to the loaded bottom asks for the next page');
    assert.equal(calls[1].cursor, 'c3', 'the appended read starts after the last loaded row');
    assert.equal(calls[1].bucketId, 'mine', 'the appended read stays in the same bucket');
    await tick();
    const left = leftColumn(view, 60, 12);
    assert.match(left, /issue title 1/, 'the first page stays in the list above the appended rows');
    assert.match(left, /issue title 5/, 'the appended page extends the list instead of replacing it');
  });

  test('the appended read repeats the active query instead of the page text', async () => {
    const calls = [];
    const clock = manualScheduler();
    const { view } = makeView({
      rows: 12,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        calls.push(request);
        return pageResult([cursorRow(`c${calls.length}`, issue(calls.length))], { hasNextPage: true });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    leftColumn(view, 60, 12);
    view.handleInput('T');
    for (const char of 'label:bug') view.handleInput(char);
    view.handleInput('enter');
    clock.fire();
    await tick();
    const afterQuery = calls.at(-1);
    assert.equal(afterQuery.query, 'label:bug', 'the query rides the request');
    assert.equal(afterQuery.cursor, null, 'a new query starts at the head of its own result set');
    leftColumn(view, 60, 12);
    view.handleInput(']');
    await tick();
    const appended = calls.at(-1);
    assert.equal(appended.query, 'label:bug', 'the appended page searches the same query');
    assert.ok(appended.cursor !== null, 'the appended page continues from the loaded rows');
  });

  test('a bucket with no next page stops asking for more', async () => {
    const calls = [];
    const { view } = makeView({
      rows: 12,
      loadIssuePage: (request) => {
        calls.push(request);
        return pageResult([cursorRow('c1', issue(1)), cursorRow('c2', issue(2))]);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    leftColumn(view, 60, 12);
    for (let step = 0; step < 3; step += 1) view.handleInput(']');
    assert.equal(calls.length, 1, 'a complete bucket is never re-read by scrolling');
  });

  test('a resize keeps the loaded rows instead of re-reading page one', async () => {
    const calls = [];
    const { view } = makeView({
      rows: 30,
      loadIssuePage: (request) => {
        calls.push(request);
        return pageResult([cursorRow('c1', issue(1)), cursorRow('c2', issue(2))], { hasNextPage: true });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    bodyOf(view, 120);
    bodyOf(view, 60);
    assert.equal(calls.length, 1, 'the window geometry changed, not the data');
    const left = leftColumn(view, 60, 30);
    assert.match(left, /issue title 1/, 'the rows stay painted after the resize');
    assert.match(left, /issue title 2/);
  });

  test('the All tab still lists the repository and keeps the query', async () => {
    const calls = [];
    const clock = manualScheduler();
    const { view } = makeView({
      rows: 20,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        calls.push(request);
        return pageResult([cursorRow('a1', issue(41, { title: 'all tab hit' }))]);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const tabs = strip(view.render(120)[2]);
    assert.match(tabs, /All/, 'the fourth tab survives the layout change');
    view.handleInput('tab');
    view.handleInput('tab');
    view.handleInput('tab');
    assert.equal(view.state.page, 3, 'tab reaches the All bucket');
    await tick();
    assert.equal(calls.at(-1).bucketId, 'all', 'All reads its own bucket');
    assert.match(leftColumn(view, 120, 20), /all tab hit/);
    view.handleInput('T');
    for (const char of 'bug') view.handleInput(char);
    clock.fire();
    await tick();
    assert.equal(calls.at(-1).query, 'bug', 'search still rides the All bucket read');
    assert.equal(calls.at(-1).bucketId, 'all');
  });
});

// ---------------------------------------------------------------------------
// S10/S11: the arrows switch buckets exactly like `tab` (the list keeps its
// other scroll keys), and every footer/header token paints through the injected
// theme with a role that distinguishes a shortcut KEY from its description, a
// title from its count, a label from a live value.
describe('issues view bucket arrows and palette (S10/S11)', () => {
  const rows = Array.from({ length: 10 }, (_, at) => issue(at + 1));

  function twoBucketView(extra = {}) {
    return makeView({
      pages: [
        { id: 'p0', label: 'My issues', issues: rows, total: rows.length },
        { id: 'p1', label: 'Assigned', issues: [issue(99)], total: 1 },
      ],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...extra,
    });
  }

  test('←/→ switch buckets like tab and never scroll the list (S10)', async () => {
    const { view } = twoBucketView();
    await tick();
    bodyOf(view, 100);
    // The list scroll keys are the OTHER bindings and keep their behaviour.
    view.handleInput(']');
    assert.equal(view.state.listStart, 4, '] still scrolls the list one screenful');
    assert.equal(view.state.page, 0, '] never switches buckets');
    view.handleInput('[');
    assert.equal(view.state.listStart, 0, '[ still scrolls the list back');
    view.handleInput('right');
    assert.equal(view.state.page, 1, '→ switches to the next bucket like tab');
    assert.equal(view.state.listStart, 0, '→ scrolled no list');
    assert.match(bodyOf(view, 100), /issue title 99/, 'the next bucket paints after →');
    view.handleInput('left');
    assert.equal(view.state.page, 0, '← switches back a bucket');
    view.handleInput('tab');
    assert.equal(view.state.page, 1, 'tab still switches forward');
    view.handleInput('shift+tab');
    assert.equal(view.state.page, 0, 'shift+tab still switches back');
  });

  test('the footer names the bucket arrows and keeps the list scroll keys (S10)', async () => {
    const { view } = twoBucketView({ rows: 24 });
    await tick();
    const footer = strip(view.render(200).at(-2));
    assert.match(footer, /←→ bucket/, 'the arrows are named as the bucket switch');
    assert.ok(!footer.includes('tab'), 'tab keeps working but leaves the legend');
    assert.match(footer, /\]\/\[ pane/, 'the list scroll keeps its own keys in the legend');
    assert.ok(!/←\/→ scroll/.test(footer), 'the old arrow-scroll hint is gone');
  });

  test('the preview scroll keys keep paging the issue pane (S10 preserve)', async () => {
    const longBody = Array.from({ length: 100 }, (_, at) => `body line ${at + 1}`).join('\n');
    const { view } = makeView({
      pages: pagesOf([[issue(1, { body: longBody })], [], []]),
      issues: [issue(1, { body: longBody })],
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('pagedown');
    assert.ok(view.state.scroll > 0, 'PageDown still scrolls the preview');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home still returns to the top');
    view.handleInput('ctrl+d');
    assert.ok(view.state.scroll > 0, 'ctrl+d still scrolls half a page');
  });

  test('the footer paints keys accent+bold and descriptions muted (S11)', async () => {
    const theme = recordingTheme();
    const { view } = twoBucketView({ rows: 24, theme });
    await tick();
    const footer = view.render(200).at(-2);
    assert.match(footer, /\x1b\[1m\x1b\[96m↑↓\x1b\[0m\x1b\[22m/, 'the key token is painted accent+bold');
    assert.match(footer, /\x1b\[90m move/, 'its description is painted muted');
    assert.match(footer, /\x1b\[1m\x1b\[96m←→\x1b\[0m\x1b\[22m/, 'a compound key token is ONE key run');
    assert.match(footer, /\x1b\[90m doc/, 'the scroll hint target is muted, not accent');
    assert.match(footer, /\x1b\[1m\x1b\[96mctrl\+j\/k\x1b\[0m\x1b\[22m\x1b\[90m doc/, 'the collapsed scroll hint paints key and target apart');
    assert.ok(theme.calls.some((call) => call.role === 'accent' && call.text === '↑↓'),
      'the accent role is requested from the injected theme');
    assert.ok(theme.calls.some((call) => call.role === 'bold' && call.text.includes('↑↓')),
      'the key is bolded through the theme, never by a literal escape');
    assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text.includes('move')),
      'the description asks the injected theme for the muted role');
  });

  // T9 (S13): the frame title and the active tab are TITLES, so they take the
  // Agents view's own title role; the footer keys keep the primary accent. The
  // preview's own heading now asks the same shared table for its title role.
  test('the header palette: secondary title, secondary active tab, muted counts (S11, S13)', async () => {
    const theme = recordingTheme();
    const { view } = twoBucketView({ rows: 24, theme });
    await tick();
    const lines = view.render(120);
    assert.ok(lines[0].includes(`${TITLE_PAINT}◈ Issues${CLOSE_PAINT}`),
      'the frame title is the shared title role, bold');
    assert.ok(theme.calls.some((call) => call.role === 'customMessageLabel' && call.text === '◈ Issues'),
      'the title asks the injected theme for the title role');
    assert.ok(!theme.calls.some((call) => call.role === 'accent' && call.text === '◈ Issues'),
      'the title never takes the button accent');
    const tabs = lines[2];
    assert.ok(tabs.includes(`${TITLE_PAINT}▸ My issues${CLOSE_PAINT}`),
      'the active tab label is a title too');
    assert.match(tabs, /\x1b\[90m \(10\)/, 'the active tab count is muted');
    assert.match(tabs, /\x1b\[90mAssigned \(1\)\x1b\[0m/, 'an inactive tab label and its count are both muted');
    assert.ok(lines.join('\n').includes(`${TITLE_PAINT}#1 issue title 1`),
      'the right-pane document title shares the frame title role (S13)');
  });

  test('a hostile theme never breaks the frame and keeps the keys and focus readable (S11)', async () => {
    const hostile = {
      fg() { throw new Error('no colour support'); },
      bold() { throw new Error('no bold support'); },
      bg() { throw new Error('no background support'); },
    };
    const { view } = twoBucketView({ rows: 24, theme: hostile });
    await tick();
    const body = strip(view.render(120).join('\n'));
    assert.match(body, /◈ Issues/, 'the frame title still renders without colour');
    assert.match(body, /↑↓ move/, 'the footer still names the key and its description');
    assert.match(body, /▸ My issues/, 'the active tab keeps its mark, so focus survives monochrome');
    assert.match(body, /› Search/, 'the search widget still renders');
  });

  test('the search row paints its label dim and its live value as ordinary text (S11, S13)', async () => {
    const theme = recordingTheme();
    const { view } = twoBucketView({ rows: 24, theme });
    await tick();
    const idle = view.render(120)[1];
    assert.match(idle, /\x1b\[2m› \x1b\[0m\x1b\[2mSearch/, 'the idle search widget is dim, never accent');
    view.handleInput('T');
    for (const char of 'bug') view.handleInput(char);
    const live = view.render(120)[1];
    assert.match(live, /\x1b\[2m› \x1b\[0m/, 'the prompt keeps the dim label role while typing');
    assert.match(live, /\x1b\[39mbug/, 'the live query value is the theme text role');
    assert.ok(!/\x1b\[96mbug/.test(live), 'the typed value is never the button accent');
  });
});

// S12: «em issues, la preview igual hagamoslo como un md estilizado». The
// preview's FREE TEXT — the issue body and every comment body — renders through
// `lib/odd-markdown.js`, the same renderer the ODD document pane uses, so a
// report written in markdown reads as headings, inline formatting and code
// instead of raw syntax. The metadata rows (number, title, state, labels,
// counts) stay the shared formatter's own (S16), and a control sequence in a
// body is display data: it can neither paint nor move the cursor.
describe('issues preview renders styled markdown (S12)', () => {
  const PANE_TOP = 4;
  function rightPane(view, width, rows = 40) {
    const panes = readerPanes(width);
    return view.render(width)
      .slice(PANE_TOP, Math.max(PANE_TOP, rows - 2))
      .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join(''))
      .join('\n');
  }

  async function viewFor(body, { comments = [], theme = plainTheme } = {}) {
    const detail = issue(9, { body, title: 'markdown body' });
    const built = makeView({
      pages: pagesOf([[detail], [], []]),
      issues: [detail],
      rows: 40,
      theme,
      loadIssue: () => ({ ok: true, issue: detail, comments }),
    });
    built.view.render(100);
    await tick();
    built.view.render(100);
    return built.view;
  }

  test('a heading in the body renders as a heading, not as raw syntax', async () => {
    const view = await viewFor('## Steps\n\nrun the tool');
    const text = rightPane(view, 100);
    assert.ok(!text.includes('## Steps'), 'the raw heading marker never reaches the pane');
    assert.match(text, /▌ Steps/, 'the heading keeps its mark');
    assert.match(text, /run the tool/, 'the body below the heading survives');
  });

  test('inline code and bold lose their markers and keep their words', async () => {
    const view = await viewFor('use `gh auth` and **now** please');
    const text = rightPane(view, 100);
    assert.ok(!text.includes('`gh auth`'), 'the code marker is gone');
    assert.ok(!text.includes('**now**'), 'the bold marker is gone');
    assert.match(text, /gh auth/);
    assert.match(text, /now please/);
  });

  test('a fenced block renders its body without the fence markers', async () => {
    const view = await viewFor('before\n\n```sh\ngit status\n```\n\nafter');
    const text = rightPane(view, 100);
    assert.ok(!text.includes('```'), 'no fence marker reaches the pane');
    assert.match(text, /git status/);
    assert.match(text, /before/);
    assert.match(text, /after/);
  });

  test('the markdown roles come from the theme, like the ODD document pane', async () => {
    const theme = recordingTheme();
    const view = await viewFor('## Steps\n\nuse `gh` now', { theme });
    assert.ok(theme.calls.some((call) => call.role === 'mdHeading' && call.text.includes('Steps')),
      'a heading is painted mdHeading');
    assert.ok(theme.calls.some((call) => call.role === 'dim' && call.text.includes('gh')),
      'inline code is painted dim');
    assert.ok(theme.calls.some((call) => call.role === 'bold' && call.text.includes('#9 markdown body')),
      'the issue title keeps the shared formatter styling');
  });

  test('a comment body is markdown too, and keeps its author heading', async () => {
    const view = await viewFor('issue body', {
      comments: [{ author: 'ann', createdAt: new Date().toISOString(), body: '- first point\n- second point' }],
    });
    const text = rightPane(view, 100);
    assert.match(text, /ann/, 'the comment author row survives');
    assert.ok(!text.includes('- first point'), 'the bullet marker is replaced by the renderer mark');
    assert.match(text, /• first point/);
    assert.match(text, /second point/);
  });

  test('control sequences in a body cannot paint or move the cursor', async () => {
    const view = await viewFor('plain \x1b[31mred\x1b[0m \x1b]0;owned\x07text');
    const panes = readerPanes(100);
    const raw = view.render(100)
      .slice(PANE_TOP, 38)
      .map((line) => [...line].slice(5 + panes.left, 5 + panes.left + panes.right).join(''))
      .join('\n');
    assert.ok(!raw.includes('\x1b'), 'no escape sequence from the issue body reaches the pane');
    assert.ok(!raw.includes('\x07'), 'no BEL from the issue body reaches the pane');
    assert.match(strip(raw), /plain red text/);
  });

  test('a markdown body keeps the reader scroll, the width, and every word', async () => {
    const items = Array.from({ length: 40 }, (_, at) => `- item ${at + 1}`);
    const view = await viewFor(['## Checklist', '', ...items].join('\n'));
    const pane = readerPanes(100);
    const first = rightPane(view, 100).split('\n')[0];
    view.handleInput('pagedown');
    view.render(100);
    const scroll = view.state.scroll;
    assert.ok(scroll > 0, 'the page key moved the document');
    const moved = rightPane(view, 100).split('\n')[0];
    assert.notEqual(moved, first, 'the pane actually moved');
    view.render(100);
    assert.equal(view.state.scroll, scroll, 'a repaint keeps the scroll position');
    assert.equal(rightPane(view, 100).split('\n')[0], moved, 'and the same first row');
    let seen = '';
    view.handleInput('home');
    for (let step = 0; step < 40; step += 1) {
      seen += `${rightPane(view, 100)}\n`;
      if (seen.includes('(end of issue)')) break;
      view.handleInput('pagedown');
    }
    for (let at = 1; at <= 40; at += 1) assert.match(seen, new RegExp(`item ${at}\\b`), `lost item ${at}`);
    assert.match(seen, /\(end of issue\)/, 'the end marker is still reachable by paging');
    assert.ok(!seen.includes('…'), 'no markdown row is wider than the pane');
    assert.equal(readerPanes(100).right, pane.right);
  });
});

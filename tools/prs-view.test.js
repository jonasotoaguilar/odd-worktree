'use strict';
// T2 (prs-panel S1,S2,S3,S6,S7): lib/prs-view.js — the pure pull request panel,
// cloned from lib/issues-view.js: the same framed reader (search row, tabs, note
// row, list | pane, one footer legend), the same server-page and search seams,
// the same capability-gated editors and the same error handling — with the
// pull request buckets, the merge mode, the linked-issues editor and the two
// cross-surface seams the contract adds (`actions.insert` on Enter,
// `actions.openLinked` on a click over one linked issue number).
//
// Everything asserted here is observable output: the painted frame, the state a
// key leaves behind, and the exact arguments the injected seams receive.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createPrsView } = require('../lib/prs-view.js');
const layout = require('../lib/view-layout.js');

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

// Every permission a pull request surface gates on, confirmed true. A fixture
// that omits it is a repository where nothing may be written (S2).
const EDITABLE = {
  canEditLabels: true,
  canCreateLabels: true,
  canEditAssignees: true,
  canClosePullRequests: true,
  canMerge: true,
  canEditLinkedIssues: true,
};

const NOW = Date.now();

function pullRequest(number, overrides = {}) {
  return {
    number,
    title: `pull request ${number}`,
    state: 'open',
    isDraft: false,
    author: 'octo',
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'ana' }],
    createdAt: new Date(NOW - 3600_000).toISOString(),
    updatedAt: new Date(NOW - 1800_000).toISOString(),
    commentsCount: 0,
    reactions: { plusOne: 2 },
    url: `https://example.test/p/${number}`,
    reviewers: [{ login: 'cara', state: 'APPROVED' }],
    linkedIssues: [12, 14],
    additions: 40,
    deletions: 5,
    changedFiles: 3,
    commits: 7,
    committedAt: new Date(NOW - 7200_000).toISOString(),
    checks: { total: 5, passed: 4, failed: 1, pending: 0, state: 'FAILURE', failing: ['build'] },
    mergeable: true,
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeMethods: { merge: true, squash: false, rebase: false },
    mergeDefaults: { merge: { subject: `Merge pull request #${number} from octo/branch`, body: `pull request ${number}` } },
    body: `body of pull request ${number}`,
    ...overrides,
  };
}

// One page answer per bucket, as the `loadPullRequestPage` seam delivers it
// (`{ok, rows, totalCount, hasMore, cursor}`). Every request is recorded.
function pageSource(map, options = {}) {
  const calls = [];
  const cursorRows = options.cursorRows || null;
  const load = async (request) => {
    calls.push(request);
    const all = map[request.bucketId] || [];
    if (cursorRows && cursorRows[request.bucketId]) {
      const pages = cursorRows[request.bucketId];
      // `cursor` is the cursor that continues AFTER that page, so a request
      // carrying one reads the page after the page it came from.
      const at = request.cursor === null
        ? 0
        : pages.findIndex((page) => page.cursor === request.cursor) + 1;
      const page = pages[at] || { rows: [], cursor: null };
      return { ok: true, rows: page.rows, totalCount: all.length, hasMore: page.cursor !== null, cursor: page.cursor };
    }
    if (options.byQuery && typeof options.byQuery[request.query] !== 'undefined') {
      const rows = options.byQuery[request.query];
      return { ok: true, rows, totalCount: rows.length, hasMore: false, cursor: null };
    }
    return { ok: true, rows: all, totalCount: all.length, hasMore: false, cursor: null };
  };
  return { load, calls };
}

function makeView(opts = {}) {
  const paints = [];
  let settled = 'pending';
  const actions = opts.actions || {};
  const view = createPrsView({
    pages: opts.pages,
    loadPullRequestPage: opts.loadPullRequestPage,
    loadPullRequest: opts.loadPullRequest
      || ((number) => ({ ok: true, pullRequest: pullRequest(number), comments: [] })),
    loadLabels: opts.loadLabels,
    loadAssignees: opts.loadAssignees,
    loadIssueCandidates: opts.loadIssueCandidates,
    permissions: opts.permissions,
    labels: opts.labels,
    actions,
    helpers: opts.helpers || helpers,
    theme: opts.theme || plainTheme,
    rowsAvailable: () => opts.rows || 24,
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
    ghAvailable: opts.ghAvailable,
    loadError: opts.loadError,
    prefetchBuckets: opts.prefetchBuckets,
    initialBucket: opts.initialBucket,
    initialPullRequest: opts.initialPullRequest,
    scheduleQuery: opts.scheduleQuery,
    cancelSchedule: opts.cancelSchedule,
  });
  return { view, done: () => settled, paints };
}

// A scheduler the test owns: nothing fires until `fire()` is called, so the
// debounce window is fully deterministic.
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

function deferred() {
  let resolve = () => {};
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// T20: the linked-issues candidate seam. `pages` is one entry per read, each
// with the rows it answers, the cursor that continues AFTER it, and whether the
// repository has more; every request is recorded. A read request with `after`
// continues from the page whose cursor it names.
function candidateSource(pages, options = {}) {
  const calls = [];
  const load = async (request) => {
    calls.push(request);
    if (typeof options.fail === 'string') return { ok: false, error: options.fail };
    const after = request.after == null ? null : request.after;
    const at = after === null ? 0 : pages.findIndex((page) => page.cursor === after) + 1;
    const page = pages[at] || { rows: [], hasMore: false, cursor: null };
    return { ok: true, rows: page.rows, hasMore: page.hasMore === true, cursor: page.cursor ?? null };
  };
  return { load, calls };
}

// S3: the reader asks view-layout for the smaller 30% list share, so every
// geometry helper here reads the same allocation the view paints.
function readerPanes(width) {
  return layout.paneWidths(layout.innerWidth(width), { listShare: layout.READER_LIST_SHARE });
}

function bodyOf(view, width) {
  const lines = view.render(width);
  for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `not ${width} wide: "${strip(line)}"`);
  return strip(lines.join('\n'));
}

// The RIGHT (pane) side of every body row, so an assertion about the preview can
// never be satisfied by the list on the left.
function rightRows(view, width, rows = 24) {
  const panes = readerPanes(width);
  return view.render(width)
    .slice(4, Math.max(4, rows - 2))
    .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join(''));
}

function rightOf(view, width, rows = 24) {
  return rightRows(view, width, rows).join('\n');
}

function leftOf(view, width, rows = 24) {
  const panes = readerPanes(width);
  return view.render(width)
    .slice(4, Math.max(4, rows - 2))
    .map((line) => [...strip(line)].slice(2, 2 + panes.left).join(''))
    .join('\n');
}

// The frame coordinates of a painted token inside the pane, so a click test
// names the cell the reader would hit instead of assuming a layout.
function paneCell(view, width, needle, rows = 24) {
  const panes = readerPanes(width);
  const lines = view.render(width);
  for (let y = 4; y < Math.min(4 + (rows - 6), lines.length); y += 1) {
    const cells = [...strip(lines[y])];
    const right = cells.slice(5 + panes.left, 5 + panes.left + panes.right).join('');
    const at = right.indexOf(needle);
    if (at >= 0) return { x: 5 + panes.left + at, y, widthCells: width, rows };
  }
  throw new Error(`not painted in the pane: ${needle}`);
}

function click(view, cell, needle) {
  return view.handleMouse({
    type: 'click',
    button: 'left',
    x: cell.x + (needle || 0),
    y: cell.y,
    width: cell.widthCells,
    height: cell.rows,
  });
}

describe('prs view buckets, list and search (S1, S3)', () => {
  test('renders the framed reader with the three pull request tabs and their counts', async () => {
    const source = pageSource({
      mine: [pullRequest(1), pullRequest(2)],
      review: [pullRequest(3)],
      involved: [],
    });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    const body = bodyOf(view, 150);
    assert.match(body, /◈ Pull requests/);
    assert.match(body, /My Pull Request.*2/, 'the first tab names the count it lists');
    assert.match(body, /Needs My Review.*–/, 'a bucket nobody has read is unknown, never an invented zero');
    assert.match(body, /Involved.*–/);
    assert.doesNotMatch(body, /All \(/, 'the lazy view is a shortcut, not a fourth tab');
    assert.match(body, /pull request 1/);
    assert.match(body, /enter insert/, 'S7: the footer names the insert key');
    assert.match(body, /g all prs/);
    assert.match(body, /esc close/);
    assert.equal(source.calls.length, 1, 'opening reads the bucket in view only');
    assert.deepEqual(source.calls[0], { bucketId: 'mine', cursor: null, limit: 18, query: '' });
  });

  test('prefetchBuckets reads every scoped tab once, so no tab sits at a false zero', async () => {
    const source = pageSource({
      mine: [pullRequest(1), pullRequest(2)],
      review: [pullRequest(3)],
      involved: [],
    });
    const { view } = makeView({ loadPullRequestPage: source.load, prefetchBuckets: true });
    await tick();
    const body = bodyOf(view, 150);
    assert.match(body, /My Pull Request.*2/);
    assert.match(body, /Needs My Review.*1/);
    assert.match(body, /Involved.*0/);
    assert.deepEqual(source.calls.map((request) => request.bucketId).sort(), ['involved', 'mine', 'review']);
    assert.equal(source.calls.length, 3, 'the lazy page is not prefetched');
  });

  test('tab and the arrows switch buckets; shift+tab and left go back', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [pullRequest(2)], involved: [pullRequest(3)] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    view.handleInput('tab');
    await tick();
    assert.equal(view.state.page, 1);
    assert.match(bodyOf(view, 150), /pull request 2/);
    view.handleInput('right');
    await tick();
    assert.equal(view.state.page, 2);
    view.handleInput('left');
    await tick();
    assert.equal(view.state.page, 1);
    view.handleInput('shift+tab');
    await tick();
    assert.equal(view.state.page, 0);
  });

  test('a bucket that already answered paints its rows again instead of refetching', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [pullRequest(2)], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    view.handleInput('tab');
    await tick();
    const calls = source.calls.length;
    view.handleInput('shift+tab');
    await tick();
    assert.equal(source.calls.length, calls, 'a visited tab reuses its rows');
    assert.match(bodyOf(view, 150), /pull request 1/);
  });

  test('only open pull requests are listed, and a closed row never inflates the count', async () => {
    const source = pageSource({ mine: [pullRequest(1), pullRequest(2, { state: 'CLOSED' })], review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    const left = leftOf(view, 150);
    assert.match(left, /pull request 1/);
    assert.doesNotMatch(left, /pull request 2/);
    assert.match(bodyOf(view, 150), /My Pull Request.*1/, 'the count describes the rows actually listed');
  });

  test('j/k, the arrows, home and end move the selection', async () => {
    const source = pageSource({ mine: [pullRequest(1), pullRequest(2), pullRequest(3)], review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load });
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

  test('S3: ] and [ scroll the one list window a screenful at a time', async () => {
    const rows = [];
    for (let at = 1; at <= 30; at += 1) rows.push(pullRequest(at));
    const source = pageSource({ mine: rows, review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load, rows: 10 });
    await tick();
    assert.equal(view.state.listStart, 0);
    view.handleInput(']');
    assert.ok(view.state.listStart > 0, 'the window moved into the list');
    const moved = view.state.listStart;
    view.handleInput('[');
    assert.ok(view.state.listStart < moved, 'the same key pair scrolls back');
  });

  test('S3: reaching the last loaded row continues the read after its cursor', async () => {
    const pages = [
      { cursor: 'c1', rows: [pullRequest(1), pullRequest(2), pullRequest(3)] },
      { cursor: null, rows: [pullRequest(4)] },
    ];
    const source = pageSource({ mine: pages[0].rows.concat(pages[1].rows), review: [], involved: [] }, { cursorRows: { mine: pages } });
    const { view } = makeView({ loadPullRequestPage: source.load, rows: 12 });
    await tick();
    const firstLimit = source.calls[0].limit;
    view.handleInput('down');
    view.handleInput('down');
    await tick();
    assert.equal(source.calls.length, 2, 'one continued read');
    assert.equal(source.calls[1].cursor, 'c1');
    assert.equal(source.calls[1].bucketId, 'mine');
    assert.equal(source.calls[1].limit, firstLimit);
    const left = leftOf(view, 150, 12);
    assert.match(left, /pull request 1/);
    assert.match(left, /pull request 4/);
  });

  test('S1: g opens all prs over the connection read, and the same key returns', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [pullRequest(2)], involved: [], all: [pullRequest(9)] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    view.handleInput('g');
    await tick();
    assert.equal(view.state.page, 3, 'the lazy page owns one state');
    assert.deepEqual(source.calls.at(-1), { bucketId: 'all', cursor: null, limit: 18, query: '' });
    const inside = bodyOf(view, 150);
    assert.match(inside, /▸ All/);
    assert.doesNotMatch(inside, /My Pull Request/, 'inside the lazy view the bar names only it');
    assert.match(inside, /g related prs/);
    assert.match(inside, /pull request 9/);
    const reads = source.calls.length;
    view.handleInput('g');
    await tick();
    assert.equal(view.state.page, 0, 'the same key returns to the tab the reader came from');
    assert.equal(source.calls.length, reads, 'returning reuses the rows already read');
    assert.match(bodyOf(view, 150), /g all prs/);
  });

  test('S3: the search reads the server with the query instead of re-filtering locally', async () => {
    const scheduler = manualScheduler();
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] }, {
      byQuery: { '': [pullRequest(1)], ok: [pullRequest(5, { title: 'unrelated title 5' })] },
    });
    const { view } = makeView({ loadPullRequestPage: source.load, scheduleQuery: scheduler.schedule, cancelSchedule: scheduler.cancel });
    await tick();
    view.handleInput('t');
    view.handleInput('o');
    view.handleInput('k');
    assert.equal(view.state.query, 'ok', 'the query applies at once');
    assert.equal(scheduler.live().length, 1, 'one debounced read for the settled query');
    view.handleInput('enter');
    await tick();
    assert.equal(view.state.searching, false, 'enter keeps the filter and leaves the box');
    const searched = source.calls.filter((request) => request.query === 'ok');
    assert.ok(searched.length >= 1, 'the query reached the server');
    assert.equal(searched[0].limit, 18);
    const left = leftOf(view, 150);
    assert.match(left, /unrelated title 5/, 'the server answer is the result, never re-filtered as literal text');
    view.handleInput('t');
    view.handleInput('delete');
    assert.equal(view.state.query, '', 'delete clears the whole query');
  });

  test('S3: leaving the search box with esc keeps the filter', async () => {
    const scheduler = manualScheduler();
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load, scheduleQuery: scheduler.schedule, cancelSchedule: scheduler.cancel });
    await tick();
    view.handleInput('t');
    view.handleInput('7');
    view.handleInput('escape');
    assert.equal(view.state.searching, false);
    assert.equal(view.state.query, '7');
    await tick();
    assert.ok(source.calls.some((request) => request.query === '7'));
  });

  test('S3: the pane scrolls with the shared preview bindings', async () => {
    const body = Array.from({ length: 60 }, (_value, at) => `paragraph ${at}`).join('\n');
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { body }), comments: [] }),
    });
    await tick();
    // The pane's page size is a fact of the painted frame, so the reader has
    // already seen the first frame before these keys mean anything.
    assert.match(rightOf(view, 150), /paragraph 0/);
    assert.equal(view.state.scroll, 0);
    view.handleInput('ctrl+j');
    assert.ok(view.state.scroll > 0, 'a page down moves the pane');
    const down = view.state.scroll;
    view.handleInput('ctrl+k');
    assert.ok(view.state.scroll < down, 'a page up moves it back');
    view.handleInput('ctrl+d');
    assert.ok(view.state.scroll > 0 && view.state.scroll < down, 'ctrl+d is a half page');
  });

  test('S3: the pane carries the Changes and Checks summary blocks', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    const pane = rightOf(view, 150);
    assert.match(pane, /3 files changed \+40 -5/);
    assert.match(pane, /7 commits 2h ago/);
    assert.match(pane, /5 checks · 1 failed/);
    assert.match(pane, /failing: build/);
  });
});

describe('prs view capabilities (S2)', () => {
  test('a read-only repository gets no editor, merge or close hint at all', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 150);
    assert.doesNotMatch(body, /l labels/);
    assert.doesNotMatch(body, /a assign/);
    assert.doesNotMatch(body, /x close/);
    assert.doesNotMatch(body, /m merge/);
    assert.doesNotMatch(body, /i linked/);
    assert.match(body, /c comment/, 'commenting needs no capability beyond read access');
    assert.match(body, /enter insert/);
  });

  test('each refused key names the missing permission and calls no seam', async () => {
    const calls = { labels: 0, assignees: 0, close: 0, merge: 0, linked: 0 };
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number), comments: [] }),
      actions: {
        editLabels: () => { calls.labels += 1; return { ok: true }; },
        editAssignees: () => { calls.assignees += 1; return { ok: true }; },
        close: () => { calls.close += 1; return { ok: true }; },
        merge: () => { calls.merge += 1; return { ok: true }; },
        editLinkedIssues: () => { calls.linked += 1; return { ok: true }; },
      },
    });
    await tick();
    view.handleInput('l');
    assert.equal(view.state.mode, 'list', 'no editor opened');
    assert.match(bodyOf(view, 150), /labels cannot be edited: this repository permission is missing/);
    view.handleInput('a');
    assert.match(bodyOf(view, 150), /assignees cannot be edited: this repository permission is missing/);
    view.handleInput('x');
    assert.equal(view.state.mode, 'list', 'no confirmation opened');
    assert.match(bodyOf(view, 150), /pull requests cannot be closed: this repository permission is missing/);
    view.handleInput('m');
    assert.equal(view.state.mode, 'list');
    assert.match(bodyOf(view, 150), /pull requests cannot be merged: this repository permission is missing/);
    view.handleInput('i');
    assert.equal(view.state.mode, 'list');
    assert.match(bodyOf(view, 150), /linked issues cannot be edited: this repository permission is missing/);
    assert.deepEqual(calls, { labels: 0, assignees: 0, close: 0, merge: 0, linked: 0 });
  });

  test('a confirmed capability set puts every hint on the footer', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { permissions: EDITABLE }),
        comments: [],
      }),
    });
    await tick();
    const body = bodyOf(view, 170);
    for (const hint of ['l labels', 'a assign', 'x close', 'm merge', 'i linked', 'o web', 'enter insert']) {
      assert.ok(body.includes(hint), `the footer names ${hint}`);
    }
  });
});

describe('prs view merge mode (S2)', () => {
  test('m opens the merge step over only the methods the repository allows', async () => {
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { permissions: EDITABLE }),
        comments: [],
      }),
    });
    await tick();
    view.handleInput('m');
    assert.equal(view.state.mode, 'merge');
    const pane = rightOf(view, 150);
    assert.match(pane, /Type: merge/);
    assert.doesNotMatch(pane, /squash|rebase/, 'a method the repository does not allow is never offered');
    assert.match(pane, /Commit message:/);
    assert.match(pane, /Merge pull request #87 from octo\/branch/, "GitHub's own proposal prefills the message");
    assert.match(pane, /Description:/);
    assert.match(pane, /pull request 87/, 'the description is prefilled too');
    assert.match(pane, /Confirm merge/);
    assert.match(pane, /Cancel/);
    assert.match(bodyOf(view, 150), /ctrl\+s merge/);
  });

  test('the message and the description are editable and the confirm sends them', async () => {
    const merged = [];
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeDefaults: { merge: { subject: 'subject A', body: 'body A' } },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    view.handleInput('down');
    view.handleInput('backspace');
    view.handleInput('backspace');
    view.handleInput('Z');
    view.handleInput('down');
    view.handleInput('!');
    const pane = rightOf(view, 150);
    assert.match(pane, /subjectZ/);
    assert.match(pane, /body A!/);
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0], { number: 87, options: { method: 'merge', subject: 'subjectZ', body: 'body A!' } });
    assert.equal(view.state.mode, 'list');
    assert.match(bodyOf(view, 150), /merged/, 'the outcome is named');
    assert.doesNotMatch(leftOf(view, 150), /pull request 87/, 'a merged pull request leaves the open list');
  });

  test('enter walks the fields and confirms from the Confirm merge row', async () => {
    const merged = [];
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    view.handleInput('enter');
    view.handleInput('enter');
    view.handleInput('enter');
    assert.equal(view.state.mergeField, 3, 'the Confirm merge row has the focus');
    view.handleInput('enter');
    await tick();
    assert.equal(merged.length, 1);
    assert.equal(merged[0].options.method, 'merge');
  });

  test('esc cancels without reaching the merge seam', async () => {
    let calls = 0;
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      actions: { merge: () => { calls += 1; return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    view.handleInput('escape');
    assert.equal(calls, 0);
    assert.equal(view.state.mode, 'list');
    assert.match(rightOf(view, 150), /body of pull request 1/, 'the pane is the preview again');
  });

  test('the offered type cycles only through the allowed methods, with their own defaults', async () => {
    const merged = [];
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeMethods: { merge: true, squash: true, rebase: false },
          mergeDefaults: {
            merge: { subject: 'merge subject', body: 'merge body' },
            squash: { subject: 'squash subject', body: 'squash body' },
          },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    assert.match(rightOf(view, 150), /Type: ◂ merge ▸/, 'the only reachable method is the one on screen');
    view.handleInput('right');
    const pane = rightOf(view, 150);
    assert.match(pane, /Type: ◂ squash ▸/);
    assert.match(pane, /squash subject/);
    assert.doesNotMatch(pane, /merge subject/);
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(merged[0].options, { method: 'squash', subject: 'squash subject', body: 'squash body' });
  });

  test('a rebase merge sends the method alone', async () => {
    const merged = [];
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeMethods: { merge: false, squash: false, rebase: true },
          mergeDefaults: { rebase: {} },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(merged[0], { number: 1, options: { method: 'rebase' } });
  });

  test('a draft pull request is never mergeable, whatever the permission says', async () => {
    const source = pageSource({ mine: [pullRequest(1, { isDraft: true })], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { isDraft: true, permissions: EDITABLE }),
        comments: [],
      }),
    });
    await tick();
    assert.doesNotMatch(bodyOf(view, 170), /m merge/);
    view.handleInput('m');
    assert.equal(view.state.mode, 'list');
    assert.match(bodyOf(view, 150), /pull requests cannot be merged: this repository permission is missing/);
  });

  test('a repository that allows no merge method refuses the same way', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeMethods: { merge: false, squash: false, rebase: false },
        }),
        comments: [],
      }),
    });
    await tick();
    view.handleInput('m');
    assert.equal(view.state.mode, 'list');
    assert.match(bodyOf(view, 150), /pull requests cannot be merged: this repository permission is missing/);
  });

  test('the confirmed number is the one the step names and the row it highlights', async () => {
    const merged = [];
    const rows = [pullRequest(87), pullRequest(88)];
    const pending = deferred();
    let reads = 0;
    const loadPullRequestPage = () => {
      reads += 1;
      return reads === 1 ? { ok: true, rows } : pending.promise;
    };
    const { view } = makeView({
      loadPullRequestPage,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeDefaults: { merge: { subject: `subject ${number}`, body: `body ${number}` } },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('r');
    view.handleInput('m');
    pending.resolve({ ok: true, rows: [rows[1], rows[0]] });
    await tick();
    assert.match(rightOf(view, 150), /Confirm merge #87/, 'the confirmation names the number it will merge');
    const left = leftOf(view, 150);
    assert.match(left, /▸ pull request 87/, 'the row that will merge carries the cursor');
    assert.doesNotMatch(left, /▸ pull request 88/, 'no other row is highlighted by the merge step');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(merged, [{ number: 87, options: { method: 'merge', subject: 'subject 87', body: 'body 87' } }]);
  });

  test('a rebase merge offers neither a commit message nor a description', async () => {
    const merged = [];
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeMethods: { rebase: true },
          mergeDefaults: { rebase: {} },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    const pane = rightOf(view, 150);
    assert.match(pane, /Type: rebase/);
    assert.doesNotMatch(pane, /Commit message|Description/, 'a rebase merge takes neither field, so neither is offered');
    view.handleInput('down');
    assert.equal(view.state.mergeField, 3, 'down reaches the confirm row without passing a hidden field');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(merged, [{ number: 1, options: { method: 'rebase' } }]);
  });

  test('the merge fields stay reachable up and down without landing on a hidden one', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeMethods: { rebase: true },
          mergeDefaults: { rebase: {} },
        }),
        comments: [],
      }),
    });
    await tick();
    view.handleInput('m');
    const visited = new Set();
    for (let at = 0; at < 5; at += 1) {
      visited.add(view.state.mergeField);
      view.handleInput('down');
    }
    assert.deepEqual([...visited].sort((left, right) => left - right), [0, 3, 4],
      'only the type, the confirm and the cancel rows hold the focus');
  });

  test('a refused merge keeps the confirmation on screen and names the error', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      actions: { merge: () => ({ ok: false, error: 'branch protection refuses this merge' }) },
    });
    await tick();
    view.handleInput('m');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'merge', 'the step stays open so the reader can retry');
    assert.match(bodyOf(view, 150), /branch protection refuses this merge/);
  });
});

describe('prs view writes (S2)', () => {
  test('x asks once and then closes the pull request', async () => {
    const closed = [];
    const source = pageSource({ mine: [pullRequest(7)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      actions: { close: (number) => { closed.push(number); return { ok: true }; } },
    });
    await tick();
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm');
    assert.match(rightOf(view, 150), /Confirm close #7/);
    assert.match(rightOf(view, 150), /This will close the pull request on GitHub\./);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list');
    assert.equal(closed.length, 0, 'a cancelled confirmation writes nothing');
    view.handleInput('x');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(closed, [7]);
    assert.equal(view.state.mode, 'list');
    assert.doesNotMatch(leftOf(view, 150), /pull request 7/);
  });

  test('c posts a comment and names the outcome; a failure keeps the draft', async () => {
    const posted = [];
    let answer = { ok: true };
    const source = pageSource({ mine: [pullRequest(5)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      actions: { postComment: (number, body) => { posted.push({ number, body }); return answer; } },
    });
    await tick();
    view.handleInput('c');
    assert.equal(view.state.mode, 'comment');
    view.handleInput('h');
    view.handleInput('i');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(posted, [{ number: 5, body: 'hi' }]);
    assert.equal(view.state.mode, 'list');
    assert.match(bodyOf(view, 150), /comment posted/);

    answer = { ok: false, error: 'comment refused' };
    view.handleInput('c');
    view.handleInput('n');
    view.handleInput('o');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'comment', 'a refused post keeps the editor');
    assert.equal(view.state.commentText, 'no', 'and keeps what was typed');
    assert.match(bodyOf(view, 150), /comment refused/);
  });

  test('the comment editor posts the number it opened on, whatever a reload did', async () => {
    const posted = [];
    let reads = 0;
    let finish = () => {};
    const rows = [pullRequest(42), pullRequest(43)];
    const { view } = makeView({
      loadPullRequestPage: () => {
        reads += 1;
        return reads === 1 ? { ok: true, rows } : new Promise((resolve) => { finish = resolve; });
      },
      actions: { postComment: (number, body) => { posted.push({ number, body }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('r');
    view.handleInput('c');
    view.handleInput('h');
    view.handleInput('i');
    // The reload lands with the OTHER pull request under the cursor, then drops
    // the row the composer named altogether.
    finish({ ok: true, rows: [rows[1]] });
    await tick();
    assert.equal(view.state.index, 0);
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(posted, [{ number: 42, body: 'hi' }], 'the composer posted to the pull request it named');
  });

  test('a refused comment keeps both the draft and the number it was opened on', async () => {
    const posted = [];
    let answer = { ok: false, error: 'comment refused' };
    const source = pageSource({ mine: [pullRequest(7), pullRequest(8)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      actions: { postComment: (number, body) => { posted.push({ number, body }); return answer; } },
    });
    await tick();
    view.handleInput('c');
    view.handleInput('h');
    view.handleInput('i');
    view.handleInput('ctrl+s');
    await tick();
    await tick();
    answer = { ok: true };
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(posted, [{ number: 7, body: 'hi' }, { number: 7, body: 'hi' }],
      'a retry posts to the same pull request the composer named');
  });

  test('l applies label add/remove deltas and can create a label the repository allows', async () => {
    const applied = [];
    const source = pageSource({ mine: [pullRequest(3)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      loadLabels: () => ({ ok: true, labels: [{ name: 'bug' }, { name: 'docs' }] }),
      actions: { editLabels: (number, add, remove, created) => { applied.push({ number, add, remove, created }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('l');
    await tick();
    assert.equal(view.state.mode, 'labels');
    let pane = rightOf(view, 150);
    assert.match(pane, /\[x\] bug/, "the row's own label starts selected");
    assert.match(pane, /\[ \] docs/);
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('n');
    view.handleInput('u');
    view.handleInput('enter');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].number, 3);
    assert.deepEqual(applied[0].add, ['docs', 'u']);
    assert.deepEqual(applied[0].remove, ['bug']);
    assert.deepEqual(applied[0].created, ['u']);
    assert.equal(view.state.mode, 'list');
  });

  test('a repository that may label but not create never offers creation', async () => {
    const applied = [];
    const source = pageSource({ mine: [pullRequest(3)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { permissions: { canEditLabels: true, canCreateLabels: false } }),
        comments: [],
      }),
      loadLabels: () => ({ ok: true, labels: [{ name: 'bug' }, { name: 'docs' }] }),
      actions: { editLabels: (number, add, remove, created) => { applied.push({ number, add, remove, created }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('l');
    await tick();
    const pane = rightOf(view, 150);
    assert.match(pane, /\[x\] bug/);
    assert.doesNotMatch(pane, /create new/, 'the picker offers no creation without the capability');
    view.handleInput('n');
    await tick();
    assert.doesNotMatch(rightOf(view, 150), /new:/, 'n opens no creation row without the capability');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(applied, [{ number: 3, add: [], remove: [], created: [] }],
      'the draft was applied with no created label');
  });

  test('a toggled assignee sends the delta that assigns and unassigns the viewer', async () => {
    const applied = [];
    const source = pageSource({ mine: [pullRequest(4)], review: [], involved: [] });
    const viewerOnly = (number) => ({
      ok: true,
      pullRequest: pullRequest(number, { permissions: EDITABLE, assignees: [{ login: 'octo' }] }),
      comments: [],
    });
    const unassigned = (number) => ({
      ok: true,
      pullRequest: pullRequest(number, { permissions: EDITABLE, assignees: [] }),
      comments: [],
    });
    let detail = viewerOnly;
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => detail(number),
      loadAssignees: () => ({ ok: true, users: [{ login: 'octo', name: 'Octo' }] }),
      actions: { editAssignees: (number, delta) => { applied.push({ number, delta }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('a');
    await tick();
    assert.equal(view.state.mode, 'assignees');
    assert.match(rightOf(view, 150), /\[x\] octo \(Octo\)/);
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(applied, [{ number: 4, delta: { add: [], remove: ['octo'] } }]);

    detail = unassigned;
    view.handleInput('r');
    await tick();
    view.handleInput('a');
    await tick();
    assert.match(rightOf(view, 150), /\[ \] octo \(Octo\)/);
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(applied[1], { number: 4, delta: { add: ['octo'], remove: [] } });
  });

  test('i edits the linked issues as add/remove deltas', async () => {
    const applied = [];
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    // T20: `n` opens the candidate list, so the added number is PICKED there and
    // never typed into a bare field.
    const candidates = candidateSource([{
      rows: [
        { number: 12, title: 'Twelve', state: 'open' },
        { number: 14, title: 'Fourteen', state: 'open' },
        { number: 77, title: 'Seventy seven', state: 'open' },
      ],
      hasMore: false,
      cursor: null,
    }]);
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      loadIssueCandidates: candidates.load,
      actions: { editLinkedIssues: (number, delta) => { applied.push({ number, delta }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('i');
    await tick();
    assert.equal(view.state.mode, 'linkedIssues');
    let pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #12 Tw/);
    assert.match(pane, /\[x\] #14 Fo/);
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('n');
    await tick();
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('enter');
    pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #77 Se/, 'the picked number is part of the draft');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(applied, [{ number: 6, delta: { add: [77], remove: [14] } }]);
    assert.equal(view.state.mode, 'list');
  });

  test('T20: the linked toggles name each issue by number and title', async () => {
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    const candidates = candidateSource([{
      rows: [
        { number: 61, title: 'TEMP: rail check 1', state: 'open' },
        { number: 77, title: 'Another linked issue', state: 'open' },
      ],
      hasMore: false,
      cursor: null,
    }]);
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { permissions: EDITABLE, linkedIssues: [61, 77] }),
        comments: [],
      }),
      loadIssueCandidates: candidates.load,
    });
    await tick();
    view.handleInput('i');
    await tick();
    const pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #61 TEMP: rail check 1/, 'the toggle is `#N title`, never a bare number');
    assert.match(pane, /\[x\] #77 Another linked issue/);
    assert.equal(candidates.calls.length, 1, 'the titles are read once when the editor opens');
    assert.deepEqual(candidates.calls[0], { after: null, pageSize: 18 });
  });

  test('T20: n lists the repository issues with the linked ones first and checked', async () => {
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    // The seam answers hotspots first; the linked numbers must still come first.
    const candidates = candidateSource([{
      rows: [
        { number: 20, title: 'Newest open issue', state: 'open' },
        { number: 12, title: 'Twelve', state: 'open' },
        { number: 14, title: 'Fourteen', state: 'open' },
      ],
      hasMore: false,
      cursor: null,
    }]);
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      loadIssueCandidates: candidates.load,
    });
    await tick();
    view.handleInput('i');
    await tick();
    view.handleInput('n');
    await tick();
    const pane = rightRows(view, 150).join('\n');
    assert.match(pane, /\[x\] #12 Twelve/);
    assert.match(pane, /\[x\] #14 Fourteen/);
    assert.match(pane, /\[ \] #20 Newest open issue/);
    const linkedAt = pane.indexOf('[x] #12');
    const otherAt = pane.indexOf('[ ] #20');
    assert.ok(linkedAt >= 0 && otherAt > linkedAt, 'the linked issues are painted before the rest');
  });

  test('T20: the candidate list reads the next page as it scrolls', async () => {
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    const row = (number) => ({ number, title: `Issue ${number}`, state: 'open' });
    const candidates = candidateSource([
      { rows: [1, 2, 3, 4].map(row), hasMore: true, cursor: 'c4' },
      { rows: [5, 6, 7, 8].map(row), hasMore: false, cursor: null },
    ]);
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE, linkedIssues: [] }), comments: [] }),
      loadIssueCandidates: candidates.load,
      rows: 10,
    });
    await tick();
    view.handleInput('i');
    await tick();
    view.handleInput('n');
    await tick();
    assert.equal(candidates.calls.length, 1, 'the editor open read the first page once');
    assert.equal(candidates.calls[0].after, null);
    assert.equal(candidates.calls[0].pageSize, 4, 'a page is the pane row budget');
    view.handleInput('ctrl+j');
    await tick();
    assert.equal(candidates.calls.length, 2, 'scrolling down reads the next page');
    assert.equal(candidates.calls[1].after, 'c4', 'the continuation is the previous page cursor');
    assert.match(rightOf(view, 150, 10), /#5 Issue 5/, 'the next page joins the list');
  });

  test('T20: space toggles a candidate, enter keeps it and esc discards it', async () => {
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    const candidates = candidateSource([{
      rows: [
        { number: 12, title: 'Twelve', state: 'open' },
        { number: 20, title: 'Twenty', state: 'open' },
      ],
      hasMore: false,
      cursor: null,
    }]);
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE, linkedIssues: [12] }), comments: [] }),
      loadIssueCandidates: candidates.load,
    });
    await tick();
    view.handleInput('i');
    await tick();
    view.handleInput('n');
    await tick();
    view.handleInput('down');
    view.handleInput('space');
    assert.match(rightOf(view, 150), /\[x\] #20 Twenty/, 'space toggles the focused row');
    view.handleInput('enter');
    let pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #12 Twelve/);
    assert.match(pane, /\[x\] #20 Twenty/, 'enter keeps the selection back in the toggles');
    // A second, fresh draft: the list's own pick is discarded on esc.
    view.handleInput('escape');
    view.handleInput('i');
    await tick();
    view.handleInput('n');
    await tick();
    view.handleInput('down');
    view.handleInput('space');
    assert.match(rightOf(view, 150), /\[x\] #20 Twenty/);
    view.handleInput('escape');
    pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #12 Twelve/);
    assert.doesNotMatch(pane, /#20/, 'esc leaves the list without keeping the pick');
  });

  test('T20: a failed candidate read keeps the toggles and paints the error', async () => {
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    const candidates = candidateSource([], { fail: 'rate limited' });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      loadIssueCandidates: candidates.load,
    });
    await tick();
    view.handleInput('i');
    await tick();
    let pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #12/);
    assert.match(pane, /\[x\] #14/);
    assert.match(pane, /issues unreadable: rate limited/);
    view.handleInput('n');
    await tick();
    pane = rightOf(view, 150);
    assert.match(pane, /issues unreadable: rate limited/);
    assert.match(pane, /\[x\] #12/, 'the linked toggles are still part of the draft');
    view.handleInput('escape');
    pane = rightOf(view, 150);
    assert.match(pane, /\[x\] #12/);
  });

  test('T20: picked candidates save ONE delta and never duplicate a linked number', async () => {
    const applied = [];
    const source = pageSource({ mine: [pullRequest(6)], review: [], involved: [] });
    const candidates = candidateSource([{
      rows: [
        { number: 12, title: 'Twelve', state: 'open' },
        { number: 20, title: 'Twenty', state: 'open' },
      ],
      hasMore: false,
      cursor: null,
    }]);
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE, linkedIssues: [12] }), comments: [] }),
      loadIssueCandidates: candidates.load,
      actions: { editLinkedIssues: (number, delta) => { applied.push({ number, delta }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('i');
    await tick();
    view.handleInput('n');
    await tick();
    view.handleInput('space');
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('space');
    view.handleInput('space');
    view.handleInput('enter');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(applied, [{ number: 6, delta: { add: [20], remove: [] } }]);
  });

  test('o opens the pull request on the web and r asks the list to be read again', async () => {
    const opened = [];
    const source = pageSource({ mine: [pullRequest(8)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      actions: { openBrowser: (number) => opened.push(number) },
    });
    await tick();
    view.handleInput('o');
    assert.deepEqual(opened, [8]);
    const reads = source.calls.length;
    view.handleInput('r');
    await tick();
    assert.ok(source.calls.length > reads, 'r re-reads the bucket on screen');
    assert.equal(view.state.index, 0, 'the refresh keeps the reader on the row');
  });

  test('a write in flight owns the keyboard until it settles', async () => {
    const pending = deferred();
    const source = pageSource({ mine: [pullRequest(2)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({ ok: true, pullRequest: pullRequest(number, { permissions: EDITABLE }), comments: [] }),
      actions: { close: () => pending.promise },
    });
    await tick();
    view.handleInput('x');
    view.handleInput('enter');
    assert.equal(view.state.saving, 'close');
    assert.match(bodyOf(view, 150), /closing pull request…/);
    view.handleInput('escape');
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm', 'no second write and no close while the first is in flight');
    pending.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null);
    assert.equal(view.state.mode, 'list');
  });
});

describe('prs view cross-links and insert (S6, S7)', () => {
  test('S7: enter inserts the focused pull request and closes the panel', async () => {
    const inserted = [];
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view, done } = makeView({
      loadPullRequestPage: source.load,
      actions: { insert: (text) => inserted.push(text) },
    });
    await tick();
    view.handleInput('enter');
    assert.deepEqual(inserted, ['PR #87']);
    assert.equal(done(), null, 'the panel closes after the insert');
  });

  test('S7: enter inside the search box keeps the filter and inserts nothing', async () => {
    const inserted = [];
    const scheduler = manualScheduler();
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view, done } = makeView({
      loadPullRequestPage: source.load,
      scheduleQuery: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      actions: { insert: (text) => inserted.push(text) },
    });
    await tick();
    view.handleInput('t');
    view.handleInput('enter');
    assert.deepEqual(inserted, []);
    assert.equal(view.state.searching, false);
    assert.equal(done(), 'pending', 'the panel stays open');
  });

  test('S7: enter without an insert seam refuses instead of closing', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view, done } = makeView({ loadPullRequestPage: source.load });
    await tick();
    view.handleInput('enter');
    assert.equal(done(), 'pending');
    assert.match(bodyOf(view, 150), /insert is unavailable/);
  });

  test('S6: each linked issue number is its own click target', async () => {
    const opened = [];
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      actions: { openLinked: (target) => opened.push(target) },
    });
    await tick();
    const first = paneCell(view, 150, '#12');
    assert.deepEqual(click(view, first), { handled: true, render: false });
    assert.deepEqual(opened, [{ kind: 'issue', number: 12 }]);
    const second = paneCell(view, 150, '#14');
    assert.deepEqual(click(view, second), { handled: true, render: false });
    assert.deepEqual(opened, [{ kind: 'issue', number: 12 }, { kind: 'issue', number: 14 }]);
  });

  test('S6: a click that is not on one of those numbers opens nothing', async () => {
    const opened = [];
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      actions: { openLinked: (target) => opened.push(target) },
    });
    await tick();
    const first = paneCell(view, 150, '#12');
    // The separator right after `#12`, and the pull request's own number in the
    // title, are not linked issue ranges.
    assert.equal(click(view, first, 3), undefined);
    const title = paneCell(view, 150, '#87');
    assert.equal(click(view, title), undefined);
    assert.deepEqual(opened, []);
  });
});

describe('prs view states and startup (S1, S3)', () => {
  test('without gh the frame names the missing CLI and lists no rows', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load, ghAvailable: false });
    const body = bodyOf(view, 150);
    assert.match(body, /gh unavailable: install gh and authenticate to use \/prs/);
    assert.doesNotMatch(body, /pull request 1/);
  });

  test('a failed read states the failure instead of painting fake rows', async () => {
    const { view } = makeView({
      loadPullRequestPage: async () => ({ ok: false, error: 'boom' }),
    });
    await tick();
    assert.match(bodyOf(view, 150), /failed to load pull requests: boom/);
    assert.doesNotMatch(bodyOf(view, 150), /no pull requests/);
  });

  test('an empty bucket says so honestly', async () => {
    const source = pageSource({ mine: [], review: [], involved: [] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    const body = bodyOf(view, 150);
    assert.match(body, /no pull requests/);
    assert.match(body, /nothing to show here/);
  });

  test('initialBucket and initialPullRequest open on that bucket with that pull request', async () => {
    const source = pageSource({
      mine: [pullRequest(1)],
      review: [pullRequest(2), pullRequest(3)],
      involved: [],
    });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      initialBucket: 'review',
      initialPullRequest: 3,
    });
    await tick();
    assert.equal(view.state.page, 1, 'the requested bucket is on screen');
    assert.equal(source.calls[0].bucketId, 'review');
    assert.equal(view.state.index, 1, 'the requested pull request holds the focus');
    assert.match(rightOf(view, 150), /#3 pull request 3/);
  });

  test('a numbered open whose own read fails says where it looked', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [pullRequest(2)], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: () => ({ ok: false, error: 'Could not resolve to a PullRequest' }),
      initialBucket: 'mine',
      initialPullRequest: 99,
    });
    await tick();
    assert.match(bodyOf(view, 150), /#99 is not in My Pull Request/);
    assert.equal(view.state.index, 0, 'no invented row holds the focus');
  });

  test('the lazy view names which read is on screen', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [], all: [pullRequest(9)] });
    const { view } = makeView({ loadPullRequestPage: source.load });
    await tick();
    view.handleInput('g');
    await tick();
    assert.match(bodyOf(view, 150), /via connection \(exact total\)/);
  });
});

// ---------------------------------------------------------------------------
// S5/S6 (D7): a numbered open is answered by the NUMBER, not by whatever the
// scoped buckets happen to hold — a merged pull request or another author's
// open one is fetched by number, shown with its state, and never offered a
// write it cannot take.
// ---------------------------------------------------------------------------
describe('prs view numbered opens by number (S5, S6)', () => {
  test('a numbered open of a merged pull request fetches it by number and shows its state read-only', async () => {
    const fetched = [];
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => {
        fetched.push(number);
        return {
          ok: true,
          pullRequest: pullRequest(number, { state: 'MERGED', permissions: EDITABLE }),
          comments: [],
        };
      },
      initialBucket: 'mine',
      initialPullRequest: 87,
    });
    await tick();
    assert.ok(fetched.includes(87), 'the detail seam is asked for exactly the number');
    assert.match(rightOf(view, 150), /#87 pull request 87/);
    assert.match(rightOf(view, 150), /\[merged\]/, "GitHub's state is shown, not invented as open");
    assert.match(leftOf(view, 150), /pull request 87/, 'the fetched pull request is in the list');
    const body = bodyOf(view, 170);
    assert.match(body, /c comment/, 'the footer is painted; only its write hints are gone');
    for (const hint of ['l labels', 'a assign', 'x close', 'm merge', 'i linked']) {
      assert.ok(!body.includes(hint), `a merged pull request offers no ${hint}`);
    }
    for (const key of ['l', 'a', 'x', 'm', 'i']) view.handleInput(key);
    assert.equal(view.state.mode, 'list', 'no editor, confirmation or merge step opens');
  });

  test("a numbered open of another author's open pull request shows it with the writes the role allows", async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { author: 'someone-else', permissions: EDITABLE }),
        comments: [],
      }),
      initialBucket: 'mine',
      initialPullRequest: 42,
    });
    await tick();
    assert.match(rightOf(view, 150), /#42 pull request 42/);
    assert.match(rightOf(view, 150), /by someone-else/);
    assert.match(rightOf(view, 150), /\[open\]/);
    assert.match(bodyOf(view, 170), /x close/, 'an open pull request keeps the writes the role allows');
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm');
    assert.match(rightOf(view, 150), /Confirm close #42/);
  });

  test('the pinned pull request leaves the list when the reader picks another tab', async () => {
    const source = pageSource({ mine: [pullRequest(1)], review: [pullRequest(2)], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { state: 'MERGED', permissions: EDITABLE }),
        comments: [],
      }),
      initialBucket: 'mine',
      initialPullRequest: 87,
    });
    await tick();
    assert.match(leftOf(view, 150), /pull request 87/);
    view.handleInput('tab');
    await tick();
    const left = leftOf(view, 150);
    assert.doesNotMatch(left, /pull request 87/, "another tab paints its own bucket");
    assert.match(left, /pull request 2/);
  });
});

// ---------------------------------------------------------------------------
// S2 (D1): a confirmation acts on the number it showed, whatever an in-flight
// reload does to the rows behind it.
// ---------------------------------------------------------------------------
describe('prs view confirmations keep their target (S2)', () => {
  function reloadInFlight() {
    const rows = [pullRequest(87), pullRequest(88)];
    let reads = 0;
    const pending = deferred();
    const loadPullRequestPage = () => {
      reads += 1;
      return reads === 1 ? { ok: true, rows } : pending.promise;
    };
    return { rows, pending, loadPullRequestPage };
  }

  test('the close confirmation writes the number it showed, never the substituted row', async () => {
    const closed = [];
    const reload = reloadInFlight();
    const { view } = makeView({
      loadPullRequestPage: reload.loadPullRequestPage,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, { permissions: EDITABLE }),
        comments: [],
      }),
      actions: { close: (number) => { closed.push(number); return { ok: true }; } },
    });
    await tick();
    view.handleInput('r');
    view.handleInput('x');
    assert.match(rightOf(view, 150), /Confirm close #87/);
    reload.pending.resolve({ ok: true, rows: [reload.rows[1], reload.rows[0]] });
    await tick();
    assert.equal(view.state.index, 0, 'the reload put the OTHER pull request under the focus');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(closed, [87], 'the confirmation closed the pull request it named');
  });

  test('the merge confirmation merges the number its step opened on', async () => {
    const merged = [];
    const reload = reloadInFlight();
    const { view } = makeView({
      loadPullRequestPage: reload.loadPullRequestPage,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeDefaults: { merge: { subject: `subject ${number}`, body: `body ${number}` } },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('r');
    view.handleInput('m');
    assert.equal(view.state.mode, 'merge');
    reload.pending.resolve({ ok: true, rows: [reload.rows[1], reload.rows[0]] });
    await tick();
    assert.equal(view.state.index, 0, 'the reload put the OTHER pull request under the focus');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(merged.length, 1);
    assert.equal(merged[0].number, 87, 'the merge step merged the pull request it opened on');
    assert.deepEqual(merged[0].options, { method: 'merge', subject: 'subject 87', body: 'body 87' });
  });

  test('j and k are text in the merge fields, and the arrows still move between them', async () => {
    const merged = [];
    const source = pageSource({ mine: [pullRequest(87)], review: [], involved: [] });
    const { view } = makeView({
      loadPullRequestPage: source.load,
      loadPullRequest: (number) => ({
        ok: true,
        pullRequest: pullRequest(number, {
          permissions: EDITABLE,
          mergeDefaults: { merge: { subject: 'S', body: 'B' } },
        }),
        comments: [],
      }),
      actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    });
    await tick();
    view.handleInput('m');
    view.handleInput('tab');
    assert.equal(view.state.mergeField, 1, 'the commit message holds the focus');
    view.handleInput('j');
    view.handleInput('k');
    assert.equal(view.state.mergeField, 1, 'typing j and k never navigates the form');
    view.handleInput('down');
    assert.equal(view.state.mergeField, 2, 'the arrow still moves to the next field');
    view.handleInput('j');
    const pane = rightOf(view, 150);
    assert.match(pane, /Sjk/);
    assert.match(pane, /Bj/);
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(merged, [{ number: 87, options: { method: 'merge', subject: 'Sjk', body: 'Bj' } }]);
  });
});

// ---------------------------------------------------------------------------
// S2 (D3): an editor re-reads its capability for its OWN number at save time,
// so a reload that revoked it writes nothing.
// ---------------------------------------------------------------------------
describe('prs view editors re-check their capability at save time (S2)', () => {
  const EDITORS = [
    ['l', 'canEditLabels', 'editLabels', ['space'],
      'labels cannot be edited: this repository permission is missing'],
    ['a', 'canEditAssignees', 'editAssignees', ['space'],
      'assignees cannot be edited: this repository permission is missing'],
    ['i', 'canEditLinkedIssues', 'editLinkedIssues', ['n', '1', '2', 'enter'],
      'linked issues cannot be edited: this repository permission is missing'],
  ];

  for (const [key, capability, seam, edit, sentence] of EDITORS) {
    test(`${seam} writes nothing when the reload revoked its capability`, async () => {
      const writes = [];
      let permission = true;
      let reads = 0;
      let finish = () => {};
      const rows = [pullRequest(87)];
      const { view } = makeView({
        loadPullRequestPage: () => {
          reads += 1;
          if (reads === 1) return { ok: true, rows };
          return new Promise((resolve) => { finish = resolve; });
        },
        loadPullRequest: (number) => ({
          ok: true,
          pullRequest: pullRequest(number, { permissions: { [capability]: permission } }),
          comments: [],
        }),
        labels: [{ name: 'bug' }],
        loadAssignees: () => ({ ok: true, users: [{ login: 'alice' }] }),
        actions: { [seam]: (...args) => { writes.push([seam, args]); return { ok: true }; } },
      });
      await tick();
      view.handleInput('r');
      view.handleInput(key);
      await tick();
      for (const step of edit) view.handleInput(step);
      permission = false;
      finish({ ok: true, rows });
      await tick();
      view.handleInput('ctrl+s');
      await tick();
      assert.deepEqual(writes, [], 'a lapsed capability never reaches the write seam');
      assert.equal(view.state.mode, 'list', 'the editor closed instead of writing');
      assert.match(bodyOf(view, 150), new RegExp(sentence));
    });
  }
});

'use strict';
// T12 (prs-panel S2): the defects the T11 independent verification recorded —
// D16 (a fence nested in a list container, and a body that ENDS inside an
// unclosed one), D17 (the merge and close highlight losing its captured row),
// D18 (the composer never naming its own pull request), D19 (the fallback write
// scope dropping an enterprise host) and D20 (a stale capability, or a target
// that is no longer open, reaching a confirmation's write seam).
//
// Every case reproduces the defect through a public seam — the client's
// exported writes, or the panel's keys and the frame it paints — and never
// through the modules' internal storage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrsClient } = require('../lib/gh-prs');
const { createPrsView } = require('../lib/prs-view');

const pin = { scope: 'github.com/octo/repo' };
const ENTERPRISE = 'github.company.example/amber/widget';
const ok = (x) => ({ status: 0, stdout: JSON.stringify(x), stderr: '', error: null });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (number, extra = {}) => ({ number, title: `PR ${number}`, state: 'open', isDraft: false, ...extra });
const strip = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '');
const frame = (view) => view.render(140).map(strip).join('\n');
const leftPane = (view) => view.render(140).map((line) => strip(line).split('│')[1] || '').join('\n');
const send = (view, ...keys) => keys.forEach((key) => view.handleInput(key));

// A `gh` double that answers the role/state reads and records every write child
// with the scope and the environment it was spawned with.
function clientMock({ permission = 'WRITE', state = 'OPEN', body = 'PR body', reported = 'amber/widget' } = {}) {
  const writes = [];
  const children = [];
  // The injected child seam, resolving a call exactly like lib/gh-issues.js:
  // an explicit pin wins and a bare `owner/name` is qualified with the default
  // host, otherwise the environment's own GH_REPO stands.
  const runGh = async (argv, opts = {}) => {
    const env = opts.env || {};
    const scoped = typeof opts.scope === 'string' && opts.scope !== '';
    const repo = scoped
      ? (opts.scope.split('/').length === 3 ? opts.scope : `github.com/${opts.scope}`)
      : (typeof env.GH_REPO === 'string' && env.GH_REPO !== '' ? env.GH_REPO : null);
    children.push({ argv: argv.slice(), scope: opts.scope, repo });
    if (argv[0] === 'repo' && argv[1] === 'view') return ok({ nameWithOwner: reported });
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      return ok({
        data: {
          repository: {
            viewerPermission: permission,
            mergeCommitAllowed: true,
            squashMergeAllowed: false,
            rebaseMergeAllowed: false,
            pullRequest: {
              state,
              isDraft: false,
              closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
          viewer: { login: 'octocat' },
        },
      });
    }
    if (argv[0] === 'pr' && argv[1] === 'view') return ok({ body });
    writes.push(argv.slice());
    return ok('');
  };
  return { client: createPrsClient({ issues: { runGh } }), writes, children };
}

// ---------------------------------------------------------------------------
// D16 (S2), amended by D27: the body edit no longer reads Markdown. A line the
// panel wrote carries its marker and is the only line a removal may delete, and
// a body whose fence runs do not pair up is refused rather than appended to.
// ---------------------------------------------------------------------------
const MARK = '<!-- odd-worktree:linked -->';
test('S2: a fence nested in a list item is code, so its example survives a removal', async () => {
  const body = [
    'Intro',
    '- item:',
    '',
    '    ```text',
    '    Closes #915',
    '    ```',
    '',
    `Closes #915 ${MARK}`,
  ].join('\n');
  const { client, writes } = clientMock({ body });

  const res = await client.editLinkedIssues(87, { remove: [915] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [[
    'pr',
    'edit',
    '87',
    '--body',
    'Intro\n- item:\n\n    ```text\n    Closes #915\n    ```\n\n',
  ]], 'only the marked line outside the list container is removed');
});

test('S2: adding a closing line to a body that ends inside an unclosed fence is refused', async () => {
  const body = 'Intro\n```text\nCloses #12';
  const { client, writes } = clientMock({ body });

  const res = await client.editLinkedIssues(87, { add: [14] }, pin);

  assert.equal(res.ok, false, 'a line appended inside the code block is never written');
  assert.equal(res.error, 'the pull request body ends inside an unclosed code fence or comment');
  assert.deepEqual(writes, [], 'nothing is written at all');
});

// ---------------------------------------------------------------------------
// D17 (S2): the list window follows the number a confirmation captured, even
// when a reload moved it out of the visible slice.
// ---------------------------------------------------------------------------
test('S2: the close confirmation\'s row stays visible when a reload moves it away', async () => {
  const rows = Array.from({ length: 40 }, (_, at) => row(100 + at));
  let calls = 0;
  let finish;
  const closed = [];
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => ({
      ok: true,
      pullRequest: { ...row(number), permissions: { canClosePullRequests: true } },
    }),
    actions: { close: (number) => { closed.push(number); return { ok: true }; } },
    rowsAvailable: () => 20,
  });
  await tick();
  send(view, 'end');
  send(view, 'r');
  send(view, 'x');
  assert.match(frame(view), /Confirm close #139/);
  finish({ ok: true, rows: rows.slice().reverse() });
  await tick();
  assert.match(frame(view), /Confirm close #139/, 'the confirmation still names the captured number');
  assert.match(leftPane(view), /▸ PR 139/, 'the window scrolled to the row that will close');
  send(view, 'enter');
  await tick();
  assert.deepEqual(closed, [139]);
});

test('S2: a confirmation whose row left the list still names the captured number', async () => {
  const rows = [row(139), row(138)];
  let calls = 0;
  let finish;
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => ({
      ok: true,
      pullRequest: { ...row(number), permissions: { canClosePullRequests: true } },
    }),
    actions: {},
    rowsAvailable: () => 20,
  });
  await tick();
  send(view, 'r');
  send(view, 'x');
  // The reload drops the captured row from the list altogether.
  finish({ ok: true, rows: [rows[1]] });
  await tick();
  assert.match(frame(view), /Confirm close #139/, 'the step still names the row the list lost');
  assert.doesNotMatch(leftPane(view), /139/, 'no row claims to be the captured pull request');
});

// ---------------------------------------------------------------------------
// D18 (S2): the composer names its own pull request and highlights its row, so
// what the reader sees is where the comment goes.
// ---------------------------------------------------------------------------
test('S2: the comment composer names and highlights the number it will post to', async () => {
  const rows = Array.from({ length: 40 }, (_, at) => row(100 + at));
  let calls = 0;
  let finish;
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => ({ ok: true, pullRequest: { ...row(number) } }),
    actions: {},
    rowsAvailable: () => 20,
  });
  await tick();
  send(view, 'end');
  send(view, 'r');
  send(view, 'c');
  finish({ ok: true, rows: rows.slice().reverse() });
  await tick();
  assert.match(frame(view), /Comment on #139/, 'the composer names the captured number');
  assert.match(leftPane(view), /▸ PR 139/, 'the composer highlights the row it will post to');
});

// ---------------------------------------------------------------------------
// D19 (S2): with no pin and no checkout the fallback scope keeps the host the
// environment named, for every write.
// ---------------------------------------------------------------------------
test('S2: an enterprise-host GH_REPO reaches every write of the fallback scope', async () => {
  const writes = {
    close: (client) => client.closePullRequest(64, { env: { GH_REPO: ENTERPRISE } }),
    merge: (client) => client.mergePullRequest(64, { method: 'merge' }, { env: { GH_REPO: ENTERPRISE } }),
    labels: (client) => client.editLabels(64, { add: ['needs-work'] }, { env: { GH_REPO: ENTERPRISE } }),
    assignees: (client) => client.editAssignees(64, { remove: ['alice'] }, { env: { GH_REPO: ENTERPRISE } }),
    linked: (client) => client.editLinkedIssues(64, { add: [12] }, { env: { GH_REPO: ENTERPRISE } }),
  };
  for (const [name, call] of Object.entries(writes)) {
    const { client, children } = clientMock();
    const res = await call(client);
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    const spawned = children.filter((child) => !(child.argv[0] === 'repo' && child.argv[1] === 'view'));
    assert.ok(spawned.length > 0, `${name} spawned nothing`);
    for (const child of spawned) {
      assert.equal(child.repo, ENTERPRISE,
        `${name}: ${child.argv.slice(0, 2).join(' ')} kept the enterprise host, not ${child.repo}`);
    }
  }
});

// ---------------------------------------------------------------------------
// D20 (S2): the captured number's own detail is re-read before its confirm or
// save proceeds, so a reload can never write with another pull request's
// capability, and a target that is no longer open writes nothing.
// ---------------------------------------------------------------------------
const CAPTURED_STEPS = [
  {
    name: 'close',
    key: 'x',
    capability: 'canClosePullRequests',
    opened: /Confirm close #42/,
    save: 'enter',
    seam: 'close',
    refusal: 'pull requests cannot be closed: this repository permission is missing',
    notOpen: (number) => `pull request #${number} is not open; it cannot be closed`,
  },
  {
    name: 'merge',
    key: 'm',
    capability: 'canMerge',
    opened: /Confirm merge #42/,
    save: 'ctrl+s',
    seam: 'merge',
    refusal: 'pull requests cannot be merged: this repository permission is missing',
    notOpen: (number) => `pull request #${number} is not open; it cannot be merged`,
  },
  {
    name: 'linked issues',
    key: 'i',
    capability: 'canEditLinkedIssues',
    opened: /Linked issues/,
    save: 'ctrl+s',
    seam: 'editLinkedIssues',
    refusal: 'linked issues cannot be edited: this repository permission is missing',
    notOpen: (number) => `pull request #${number} is not open; its linked issues cannot be edited`,
  },
];

// A server-mode view whose first page lands, whose reload is HELD, and whose
// detail answers each number with the capability and state the case sets.
function capturedView(step, { permission = () => true, state = () => 'open' } = {}) {
  const rows = [row(42), row(43)];
  const writes = [];
  const reads = [];
  let calls = 0;
  let finish;
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => {
      reads.push(number);
      return {
        ok: true,
        pullRequest: {
          ...row(number, { state: state(number) }),
          permissions: { [step.capability]: permission(number) },
          mergeMethods: { merge: true },
          mergeDefaults: { merge: { subject: 'S', body: 'B' } },
          linkedIssues: [],
        },
      };
    },
    actions: { [step.seam]: (...args) => { writes.push(args); return { ok: true }; } },
    rowsAvailable: () => 30,
  });
  return { view, writes, reads, reload: () => finish({ ok: true, rows: [rows[1], rows[0]] }) };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const step of CAPTURED_STEPS) {
  test(`S2: ${step.name} re-reads the captured number before it writes`, async () => {
    let allowed = true;
    const run = capturedView(step, { permission: (number) => allowed || number !== 42 });
    await tick();
    send(run.view, 'r');
    send(run.view, step.key);
    assert.match(frame(run.view), step.opened, `${step.name}: the step opened on the captured number`);
    // The capability the pane painted lapses while the reload reorders the rows.
    allowed = false;
    run.reload();
    await tick();
    send(run.view, step.save);
    await tick();
    assert.deepEqual(run.writes, [], `${step.name}: a lapsed capability reaches no seam`);
    assert.match(frame(run.view), new RegExp(escape(step.refusal)),
      `${step.name}: the refusal names the capability`);
  });

  test(`S2: ${step.name} refuses a captured number that is no longer open`, async () => {
    let fresh = 'open';
    const run = capturedView(step, { state: (number) => (number === 42 ? fresh : 'open') });
    await tick();
    send(run.view, 'r');
    send(run.view, step.key);
    assert.match(frame(run.view), step.opened, `${step.name}: the step opened on the captured number`);
    fresh = 'MERGED';
    run.reload();
    await tick();
    send(run.view, step.save);
    await tick();
    assert.deepEqual(run.writes, [], `${step.name}: a merged pull request reaches no seam`);
    assert.match(frame(run.view), new RegExp(escape(step.notOpen(42))),
      `${step.name}: the refusal names the state`);
  });
}

test('S2: the client refuses a close, a merge and a linked edit of a non-open pull request', async () => {
  const calls = {
    close: (client) => client.closePullRequest(64, pin),
    merge: (client) => client.mergePullRequest(64, { method: 'merge' }, pin),
    linked: (client) => client.editLinkedIssues(64, { add: [12] }, pin),
  };
  const sentences = {
    close: 'pull request #64 is not open; it cannot be closed',
    merge: 'pull request #64 is not open; it cannot be merged',
    linked: 'pull request #64 is not open; its linked issues cannot be edited',
  };
  for (const [name, call] of Object.entries(calls)) {
    const { client, writes } = clientMock({ state: 'MERGED' });
    const res = await call(client);
    assert.equal(res.ok, false, `${name}: a merged pull request is not written`);
    assert.equal(res.error, sentences[name]);
    assert.deepEqual(writes, [], `${name}: no write child ran`);
  }
});

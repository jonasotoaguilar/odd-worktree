'use strict';
// T14 (prs-panel S2): the defects the T13 verdict left open, exercised through
// the public client and panel seams — never a real `gh`, never a real write.
// D21 (fence refusal) and the D23/D24 scope rules live in the client; D22
// (reserved confirmation row) and D25/D26 (newest detail answer wins, every
// editor save gated) live in the panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrsClient, setGhRunner } = require('../lib/gh-prs');
const { createPrsView } = require('../lib/prs-view');

const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const ok = (doc) => ({ status: 0, stdout: JSON.stringify(doc) });
const ENTERPRISE = 'github.company.example/amber/widget';
const GITHUB = 'github.com/amber/widget';

// A recorder over the client's child seam. Reads answer the shapes the client
// parses; every write is collected instead of run.
function recorder(t, fixture = {}) {
  const calls = [];
  const writes = [];
  const run = async (_bin, argv, opts = {}) => {
    const env = opts.env || {};
    const call = { argv: argv.slice(), repo: env.GH_REPO, host: env.GH_HOST };
    calls.push(call);
    switch (argv.slice(0, 2).join(' ')) {
      case 'repo view': {
        const repo = env.GH_REPO || GITHUB;
        return ok({ nameWithOwner: repo.split('/').slice(-2).join('/') });
      }
      case 'api graphql':
        return ok({
          data: {
            search: {
              issueCount: 0,
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [],
            },
            repository: {
              viewerPermission: fixture.role || 'WRITE',
              mergeCommitAllowed: true,
              pullRequest: {
                state: 'OPEN',
                isDraft: false,
                closingIssuesReferences: { nodes: [] },
              },
            },
            viewer: { login: 'pat' },
          },
        });
      case 'pr view':
        return ok({
          number: 64,
          title: 'Ticket',
          state: 'OPEN',
          body: fixture.body ?? 'Summary\n',
        });
      default:
        writes.push(call);
        return ok({});
    }
  };
  setGhRunner(run);
  t.after(() => setGhRunner(null));
  return { client: createPrsClient(), calls, writes };
}

function graphqlRead(calls) {
  return calls.find((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
}

// ---------------------------------------------------------------------------
// D21/D27 (S2): a body whose fence runs do not pair up refuses the edit
// outright — add and remove alike — and writes nothing. The body's loose fence
// total is odd: the only run is the one the rule refuses to guess at.
// ---------------------------------------------------------------------------
test('D21: an odd fence total this reader cannot resolve refuses the body edit', async (t) => {
  const body = '```js `x`\nCloses #915\n';
  const { client, writes } = recorder(t, { body });

  const removed = await client.editLinkedIssues(64, { remove: [915] }, { scope: GITHUB });
  assert.deepEqual(removed, {
    ok: false,
    error: 'the pull request body ends inside an unclosed code fence or comment',
  });
  const added = await client.editLinkedIssues(64, { add: [916] }, { scope: GITHUB });
  assert.equal(added.ok, false);
  assert.equal(added.error, 'the pull request body ends inside an unclosed code fence or comment');
  assert.deepEqual(writes, [], 'nothing is written for a body this reader cannot read');
});

// ---------------------------------------------------------------------------
// D23 (S2): `gh api`/GraphQL never take their host from GH_REPO, so every
// gated read and write names the scope's API host, and a github.com scope adds
// nothing at all.
// ---------------------------------------------------------------------------
const GATED_WRITES = [
  ['close', (client, options) => client.closePullRequest(64, options)],
  ['merge', (client, options) => client.mergePullRequest(64, { method: 'merge', subject: 's', body: '' }, options)],
  ['labels', (client, options) => client.editLabels(64, { add: ['support'] }, options)],
  ['assignees', (client, options) => client.editAssignees(64, { add: ['pat'] }, options)],
  ['linked', (client, options) => client.editLinkedIssues(64, { add: [915] }, options)],
  ['create label', (client, options) => client.createLabel({ name: 'support' }, options)],
];

for (const [name, write] of GATED_WRITES) {
  test(`D23: ${name} carries the enterprise API host and GH_HOST on every child`, async (t) => {
    const { client, calls, writes } = recorder(t, { body: 'Summary\n' });

    const result = await write(client, { env: { GH_REPO: ENTERPRISE } });

    assert.equal(result.ok, true, result.error);
    const lookup = graphqlRead(calls);
    assert.ok(lookup, 'the gated role read ran');
    assert.equal(lookup.argv[3], `query=${lookup.argv[3].slice('query='.length)}`,
      'the query stays in its own argv slot');
    const at = lookup.argv.indexOf('--hostname');
    assert.equal(at >= 0 ? lookup.argv[at + 1] : null, 'github.company.example',
      'the GraphQL lookup names the enterprise API host');
    assert.equal(lookup.host, 'github.company.example', 'and the child carries GH_HOST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].host, 'github.company.example', 'the write child carries GH_HOST too');
    assert.equal(writes[0].repo, ENTERPRISE, 'and the pinned enterprise repository');
  });
}

test('D28: a github.com scope names github.com explicitly on every child', async (t) => {
  // D28 replaced the "a github.com scope adds nothing" rule: gh's own default
  // may itself be an Enterprise server, so the host is always named, github.com
  // included, and it can never drift in either direction.
  const { client, calls, writes } = recorder(t, { body: 'Summary\n' });

  assert.equal((await client.closePullRequest(64, { scope: GITHUB })).ok, true);

  const lookup = graphqlRead(calls);
  assert.equal(lookup.argv[lookup.argv.indexOf('--hostname') + 1], 'github.com');
  assert.equal(lookup.host, 'github.com');
  assert.equal(writes[0].host, 'github.com');
  assert.equal(writes[0].repo, GITHUB);
});

test('D23: an enterprise page read names the host on its GraphQL child', async (t) => {
  const { client, calls } = recorder(t);

  const page = await client.getPullRequestPage({ bucket: 'mine' }, { env: { GH_REPO: ENTERPRISE } });

  assert.equal(page.ok, true, page.error);
  const lookup = graphqlRead(calls);
  const at = lookup.argv.indexOf('--hostname');
  assert.equal(at >= 0 ? lookup.argv[at + 1] : null, 'github.company.example');
  assert.equal(lookup.host, 'github.company.example');
});

// ---------------------------------------------------------------------------
// D24 (S2): with no pin and no checkout, the ambient repository is resolved
// ONCE and pinned for the role read and the write alike.
// ---------------------------------------------------------------------------
test('D24: an ambient default that moves mid-write cannot redirect the close', async (t) => {
  let ambient = GITHUB;
  const calls = [];
  const writes = [];
  setGhRunner(async (_bin, argv, opts = {}) => {
    const env = opts.env || {};
    const call = { argv: argv.slice(), repo: env.GH_REPO || ambient };
    calls.push(call);
    if (argv.slice(0, 2).join(' ') === 'repo view') {
      return ok({ nameWithOwner: call.repo.split('/').slice(-2).join('/') });
    }
    if (argv.slice(0, 2).join(' ') === 'api graphql') {
      ambient = 'github.com/copper/widget';
      return ok({ data: { repository: { viewerPermission: 'WRITE', pullRequest: { state: 'OPEN' } } } });
    }
    writes.push(call);
    return ok({});
  });
  t.after(() => setGhRunner(null));

  const result = await createPrsClient().closePullRequest(64);

  assert.equal(result.ok, true, result.error);
  assert.equal(graphqlRead(calls).repo, GITHUB);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].repo, GITHUB, 'the write runs in the repository the role read proved');
});

// ---------------------------------------------------------------------------
// The panel seams: a small harness with a held reload, so a detail read can be
// ordered by hand.
// ---------------------------------------------------------------------------
const METHODS = { merge: true };
const ALL_CAPS = {
  canClosePullRequests: true,
  canMerge: true,
  canEditLabels: true,
  canCreateLabels: true,
  canEditAssignees: true,
  canEditLinkedIssues: true,
};
const row = (number, state = 'open') => ({ number, title: `Ticket-${number}`, author: 'someone-else', state });
const detail = (number, props = {}) => ({
  ok: true,
  pullRequest: {
    ...row(number),
    body: 'Summary',
    isDraft: false,
    mergeMethods: METHODS,
    mergeDefaults: { merge: { subject: 'Subject', body: 'Details' } },
    linkedIssues: [915],
    ...props,
  },
  permissions: props.permissions || ALL_CAPS,
});
const page = (rows) => ({ ok: true, rows, hasMore: false, totalCount: rows.length });
const keys = (view, ...inputs) => inputs.forEach((input) => view.handleInput(input));
const display = (view, width = 130) => view.render(width).join('\n');

async function panel(options = {}) {
  const held = deferred();
  const writes = [];
  const others = Array.from({ length: 30 }, (_, index) => row(100 + index));
  let opens = 0;
  let read = (number) => detail(number);
  const actions = Object.fromEntries(
    ['close', 'merge', 'commentPullRequest', 'editLinkedIssues', 'editLabels', 'editAssignees']
      .map((name) => [name, (...args) => { writes.push([name, ...args]); return { ok: true }; }]),
  );
  const view = createPrsView({
    rowsAvailable: () => (typeof options.rowsAvailable === 'function'
      ? options.rowsAvailable()
      : (options.rowsAvailable ?? 19)),
    loadPullRequestPage: ({ bucketId }) => (bucketId === 'mine' && (opens += 1) === 2
      ? held.promise
      : page([row(64), ...others])),
    loadPullRequest: (number, opts) => read(number, opts),
    labels: [{ name: 'support' }],
    loadAssignees: () => ({ ok: true, users: [{ login: 'pat' }] }),
    actions,
  });
  await tick();
  return { view, held, writes, others, readFrom: (fn) => { read = fn; } };
}

// ---------------------------------------------------------------------------
// D22 (S2): the captured target's own line is reserved a pane row in a short
// frame, and a frame too short to hold it refuses to confirm.
// ---------------------------------------------------------------------------
test('D22: a short frame still paints Confirm merge #N, and the merge proceeds', async () => {
  const { view, held, writes, others } = await panel({ rowsAvailable: () => 10 });
  keys(view, 'r', 'm');
  held.resolve(page(others));
  await tick();

  const rendered = display(view);
  assert.match(rendered, /Confirm merge #64/);
  keys(view, 'ctrl+s');
  await tick();
  assert.deepEqual(writes.map((call) => call.slice(0, 2)), [['merge', 64]]);
});

test('D22: a frame too short to hold the confirmation refuses to confirm', async () => {
  const { view, writes } = await panel({ rowsAvailable: () => 6 });

  keys(view, 'm', 'ctrl+s');
  await tick();
  assert.deepEqual(writes, [], 'a merge in a frame that cannot name its target writes nothing');
  assert.match(display(view), /the terminal is too short to confirm this pull request/);

  // The step stays open so the reader can enlarge the terminal and retry.
  assert.equal(view.state.mode, 'merge');
  keys(view, 'escape', 'x', 'enter');
  await tick();
  assert.deepEqual(writes, [], 'the same rule holds for the close confirmation');
  assert.match(display(view), /the terminal is too short to confirm this pull request/);

  keys(view, 'escape', 'c', 'h', 'i', 'ctrl+s');
  await tick();
  assert.deepEqual(writes, [], 'and for the composer, which also names its target');
  assert.match(display(view), /the terminal is too short to confirm this pull request/);
});

// ---------------------------------------------------------------------------
// D25 (S2): the NEWEST detail read for a number decides, in both directions.
// ---------------------------------------------------------------------------
test('D25: a stale negative read never blocks a newer positive answer', async () => {
  const { view, held, writes, others, readFrom } = await panel();
  const stale = deferred();
  const newer = deferred();
  let reads = 0;
  keys(view, 'r', 'x');
  readFrom((number) => (number !== 64 ? detail(number) : (++reads === 1 ? stale.promise : newer.promise)));
  keys(view, 'enter');
  held.resolve(page([row(64), ...others]));
  await tick();
  newer.resolve(detail(64));
  await tick();
  stale.resolve({ ok: false, error: 'gone' });
  await tick();

  assert.deepEqual(writes.map((call) => call.slice(0, 2)), [['close', 64]],
    'the newest positive answer authorizes the close');
});

// ---------------------------------------------------------------------------
// D26 (S2): every editor save is gated on a fresh read, label creation
// included, whatever a reorder did to the list.
// ---------------------------------------------------------------------------
test('D26: a new-label save after a reorder re-reads the creation capability', async () => {
  const { view, held, writes, others, readFrom } = await panel();
  keys(view, 'r', 'l', 'n', 'N', 'e', 'w', 'enter');
  readFrom((number) => (number === 64
    ? detail(64, { permissions: { ...ALL_CAPS, canCreateLabels: false } })
    : detail(number)));
  held.resolve(page([...others, row(64)]));
  await tick();
  keys(view, 'ctrl+s');
  await tick();

  assert.deepEqual(writes, []);
  assert.match(display(view), /new labels cannot be created: this repository permission is missing/);
});

test('D26: an assignee save on a pull request merged meanwhile writes nothing', async () => {
  const { view, held, writes, others, readFrom } = await panel();
  keys(view, 'r', 'a');
  await tick();
  keys(view, 'space');
  readFrom((number) => (number === 64 ? detail(64, { state: 'merged' }) : detail(number)));
  held.resolve(page(others));
  await tick();
  keys(view, 'ctrl+s');
  await tick();

  assert.deepEqual(writes, []);
  assert.match(display(view), /pull request #64 is not open; its assignees cannot be edited/);
});

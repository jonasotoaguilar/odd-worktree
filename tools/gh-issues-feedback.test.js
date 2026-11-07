'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const gh = require('../lib/gh-issues.js');
afterEach(() => gh.setGhRunner(null));
const ok = (doc) => ({ status: 0, stdout: JSON.stringify(doc), stderr: '' });
const field = (argv, name) => argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const node = (number) => ({ number, title: `Issue ${number}`, state: 'OPEN', author: { login: 'author' }, labels: { nodes: [] }, comments: { totalCount: 0 } });
function runner(handler) {
  const calls = [];
  gh.setGhRunner(async (_bin, argv) => {
    calls.push(argv);
    if (argv[0] === 'repo') return ok({ nameWithOwner: 'owner/repo' });
    return handler(argv);
  });
  return calls;
}

test('fresh pages preserve the server query, per-row cursor and requested capacity', async () => {
  let round = 0;
  const calls = runner((argv) => {
    assert.equal(argv[0], 'api');
    assert.match(field(argv, 'search'), /repo:owner\/repo/);
    assert.match(field(argv, 'search'), /assignee:@me/);
    assert.equal(field(argv, 'first'), '7');
    assert.equal(field(argv, 'cursor'), 'previous');
    return ok({ data: { search: { issueCount: 12, pageInfo: { hasNextPage: true, endCursor: 'next' }, edges: [{ cursor: 'next', node: { ...node(4), title: `Fresh ${++round}` } }] } } });
  });
  const params = { query: 'assignee:@me', after: 'previous', first: 7 };
  const first = await gh.getIssuePage(params);
  const second = await gh.getIssuePage(params);
  assert.equal(first.ok, true);
  assert.equal(first.issues[0].cursor, 'next');
  assert.equal(first.total, 12);
  assert.equal(first.hasNextPage, true);
  assert.equal(second.issues[0].title, 'Fresh 2');
  assert.equal(calls.filter((argv) => argv[0] === 'api').length, 2, 'each page request is fresh');
});

test('page budgets larger than one API page are fetched without dropping cursors', async () => {
  const calls = runner((argv) => {
    const after = field(argv, 'cursor');
    const count = Number(field(argv, 'first'));
    const start = after ? 101 : 1;
    return ok({ data: { search: { issueCount: 160, pageInfo: { hasNextPage: start + count <= 160, endCursor: `c${start + count - 1}` }, edges: Array.from({ length: count }, (_, i) => ({ cursor: `c${start + i}`, node: node(start + i) })) } } });
  });
  const result = await gh.getIssuePage({ first: 145 });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 145);
  assert.equal(result.issues[144].cursor, 'c145');
  assert.deepEqual(calls.filter((argv) => argv[0] === 'api').map((argv) => field(argv, 'first')), ['100', '45']);
});

test('invalid page inputs produce no subprocess calls', async () => {
  const calls = runner(() => ok({}));
  for (const first of [0, -1, 1.5, NaN, 1001]) assert.equal((await gh.getIssuePage({ first })).ok, false);
  for (const params of [null, [], 'bad']) assert.equal((await gh.getIssuePage(params)).ok, false);
  assert.equal(calls.length, 0);
});

test('GraphQL errors and malformed page cursors are failures, never fake empty pages', async () => {
  runner(() => ok({ errors: [{ message: 'Forbidden' }] }));
  assert.equal((await gh.getIssuePage({ first: 5 })).ok, false);
  runner(() => ok({ data: { search: { issueCount: 1, pageInfo: { hasNextPage: true }, edges: [{ node: node(1) }] } } }));
  assert.equal((await gh.getIssuePage({ first: 5 })).ok, false);
});

test('assignable users paginate and deduplicate actual repository candidates', async () => {
  runner((argv) => {
    const after = field(argv, 'cursor');
    return ok({ data: { repository: { assignableUsers: { nodes: after ? [{ login: 'bob', name: 'Bob' }, { login: 'alice' }] : [{ login: 'alice', name: 'Alice' }], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'users-next' } } } } });
  });
  const result = await gh.listAssignableUsers();
  assert.equal(result.ok, true);
  assert.deepEqual(result.users.map((user) => user.login), ['alice', 'bob']);
});

test('assignee toggles add and remove using fixed argv with confirmed triage rights', async () => {
  const calls = runner((argv) => {
    if (argv[0] === 'api') return ok({ data: { repository: { viewerPermission: 'TRIAGE' } } });
    return { status: 0, stdout: '', stderr: '' };
  });
  const result = await gh.editAssignees(3, { add: ['alice', 'bob'], remove: ['charlie'] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((argv) => argv[0] === 'issue'), ['issue', 'edit', '3', '--add-assignee', 'alice', '--add-assignee', 'bob', '--remove-assignee', 'charlie']);
});

test('denied and unknown repository roles cannot issue an assignee mutation', async () => {
  for (const role of ['READ', null, 'UNKNOWN_ROLE']) {
    const calls = runner(() => ok({ data: { repository: { viewerPermission: role } } }));
    const result = await gh.editAssignees(3, { add: ['alice'], remove: [] });
    assert.equal(result.ok, false);
    assert.equal(calls.some((argv) => argv[0] === 'issue'), false);
  }
});

test('malformed assignee changes are rejected before any read or write', async () => {
  const calls = runner(() => ok({}));
  for (const args of [null, [], 'bad', { add: ['--help'] }, { remove: ['bad,user'] }, { add: 'alice' }, { add: ['alice'], remove: ['alice'] }]) {
    assert.equal((await gh.editAssignees(3, args)).ok, false);
  }
  assert.equal((await gh.editAssignees(0, { add: ['alice'] })).ok, false);
  assert.equal(calls.length, 0);
});

test('permission and relation metadata is explicit and omits absent project/PR data', async () => {
  runner(() => ok({ data: { repository: { viewerPermission: 'TRIAGE', issue: { assignees: { nodes: [{ login: 'alice' }, { login: 'bob' }] }, projectItems: { nodes: [{ project: { title: 'Roadmap', url: 'https://example.invalid/project' } }] }, closedByPullRequestsReferences: { totalCount: 2 } } } } }));
  const result = await gh.getIssueMetadata(3);
  assert.equal(result.ok, true);
  assert.deepEqual(result.permissions, { canEditLabels: true, canEditAssignees: true, canCreateLabels: false });
  assert.deepEqual(result.assignees, ['alice', 'bob']);
  assert.equal(result.projects[0].title, 'Roadmap');
  assert.equal(result.linkedPullRequestCount, 2);
  runner(() => ok({ data: { repository: { viewerPermission: 'READ', issue: { assignees: { nodes: [] }, projectItems: { nodes: [] }, closedByPullRequestsReferences: { totalCount: 0 } } } } }));
  const empty = await gh.getIssueMetadata(3);
  assert.equal(empty.permissions.canEditLabels, false);
  assert.equal('projects' in empty, false);
  assert.equal('linkedPullRequestCount' in empty, false);
});

test('project scope failures preserve confirmed triage rights, assignees and linked PRs', async () => {
  runner((argv) => {
    if (field(argv, 'query').includes('projectItems')) return ok({ errors: [{ message: 'read:project scope required' }] });
    return ok({ data: { repository: { viewerPermission: 'WRITE', issue: { assignees: { nodes: [{ login: 'alice' }] }, closedByPullRequestsReferences: { totalCount: 2 } } } } });
  });
  const result = await gh.getIssueMetadata(3);
  assert.equal(result.ok, true);
  assert.equal(result.permissions.canEditAssignees, true);
  assert.equal(result.permissions.canCreateLabels, true);
  assert.deepEqual(result.assignees, ['alice']);
  assert.equal(result.linkedPullRequestCount, 2);
  assert.equal('projects' in result, false);
  assert.match(result.metadataError, /read:project/);
});

test('assignee mutation failures are not converted to success', async () => {
  runner((argv) => argv[0] === 'api' ? ok({ data: { repository: { viewerPermission: 'WRITE' } } }) : { status: 1, stdout: '', stderr: 'Forbidden' });
  const result = await gh.editAssignees(3, { add: ['alice'], remove: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Forbidden/);
});

// T2 (S2): the unfiltered `All` bucket reads the repository's own issue
// CONNECTION, which is cursor-paged with no 1000-match search ceiling and
// reports the exact total. `getIssuePage` (the typed-search path) keeps its
// search semantics and its honest cap.
const connection = (edges, { totalCount = edges.length, hasNextPage = false, endCursor = null } = {}) => ok({
  data: {
    repository: {
      issues: { totalCount, pageInfo: { hasNextPage, endCursor }, edges },
    },
  },
});
const connectionRunner = (handler) => {
  const calls = [];
  gh.setGhRunner(async (_bin, argv) => {
    calls.push(argv);
    if (argv[0] === 'repo') return ok({ nameWithOwner: 'owner/repo' });
    return handler(argv);
  });
  // A live view: the array fills as the call runs, after this returns.
  return () => calls.filter((argv) => argv[0] === 'api');
};

test('unfiltered All reads the issue connection with an exact total and per-row cursors', async () => {
  let seen = null;
  const calls = connectionRunner((argv) => {
    seen = field(argv, 'query');
    assert.equal(field(argv, 'first'), '30');
    assert.equal(field(argv, 'cursor'), undefined, 'a head read starts the connection');
    return connection([
      { cursor: 'c1', node: node(1) },
      { cursor: 'c2', node: node(2) },
      { cursor: 'c3', node: node(3) },
    ], { totalCount: 1500, hasNextPage: true, endCursor: 'c3' });
  });
  const result = await gh.getIssueConnectionPage({ first: 30 });
  assert.equal(result.ok, true);
  assert.equal(calls().length, 1);
  assert.doesNotMatch(seen, /search\(/, 'never the capped search API');
  assert.match(seen, /issues\(states: \[OPEN\], first: \$first, after: \$cursor/);
  assert.match(seen, /orderBy: \{field: UPDATED_AT, direction: DESC\}/, 'ordering belongs to the query');
  assert.match(seen, /totalCount/);
  assert.match(seen, /edges \{\s*cursor\s+node \{/, 'every edge carries its own cursor');
  assert.equal(result.total, 1500, 'the exact server total, never a page length');
  assert.equal(result.hasNextPage, true);
  assert.deepEqual(result.issues.map((row) => row.cursor), ['c1', 'c2', 'c3']);
  assert.deepEqual(result.issues.map((row) => row.number), [1, 2, 3]);
  assert.equal(result.issues[0].state, 'open');
  assert.equal(result.issues[0].body, '', 'the connection never asks for bodies');
});

test('more than 1000 issues page past the search cap through the connection', async () => {
  const served = [];
  const calls = connectionRunner((argv) => {
    const after = field(argv, 'cursor');
    const count = Number(field(argv, 'first'));
    const start = (after ? Number(after.slice(1)) : 0) + 1;
    const end = start + count - 1;
    served.push(`${start}-${end}`);
    return connection(
      Array.from({ length: count }, (_, i) => ({ cursor: `c${start + i}`, node: node(start + i) })),
      { totalCount: 1500, hasNextPage: end < 1500, endCursor: `c${end}` },
    );
  });
  const head = await gh.getIssueConnectionPage({ first: 1000 });
  assert.equal(head.ok, true, '1000 rows is a page size here, not a result cap');
  assert.equal(head.issues.length, 1000);
  assert.equal(head.total, 1500);
  assert.equal(head.hasNextPage, true);
  assert.equal(head.issues[999].cursor, 'c1000');
  const tail = await gh.getIssueConnectionPage({ first: 500, after: head.issues[999].cursor });
  assert.equal(tail.ok, true);
  assert.equal(tail.issues.length, 500);
  assert.equal(tail.issues[0].number, 1001, 'the continuation crosses the 1000-match search ceiling');
  assert.equal(tail.issues[499].number, 1500);
  assert.equal(tail.total, 1500);
  assert.equal(tail.hasNextPage, false);
  const requested = calls().map((argv) => field(argv, 'first'));
  assert.equal(requested.length, 15, 'ten server pages for the head request, five for the continuation');
  assert.deepEqual(requested.slice(0, 10), Array(10).fill('100'));
  assert.deepEqual(requested.slice(10), Array(5).fill('100'));
  assert.ok(calls()[10].includes('cursor=c1000'), 'the continuation resumes at the last delivered row');
  assert.equal(served[0], '1-100');
  assert.equal(served[9], '901-1000');
  assert.equal(served[10], '1001-1100');
});

test('the state filter is explicit and never collapses closed into open', async () => {
  const cases = [
    ['open', 'states: [OPEN]'],
    ['closed', 'states: [CLOSED]'],
    ['all', 'states: [OPEN, CLOSED]'],
    ['CLOSED', 'states: [CLOSED]'],
  ];
  for (const [state, literal] of cases) {
    const queries = [];
    connectionRunner((argv) => {
      queries.push(field(argv, 'query'));
      return connection([], { totalCount: 0 });
    });
    const result = await gh.getIssueConnectionPage({ first: 5, state });
    assert.equal(result.ok, true);
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes(literal), `${state} asks for ${literal}`);
    if (state.toLowerCase() === 'closed') assert.doesNotMatch(queries[0], /OPEN/, 'a closed read never widens to open');
  }
  const calls = connectionRunner(() => connection([]));
  for (const state of ['archived', 'OPEN,CLOSED', 0, true]) {
    const bad = await gh.getIssueConnectionPage({ first: 5, state });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid issue state/);
  }
  assert.equal(calls().length, 0, 'an unknown state never reaches a subprocess');
});

test('a connection request refuses search text instead of silently ignoring it', async () => {
  const calls = connectionRunner(() => connection([]));
  for (const query of ['assignee:@me', 'sort:created-asc', 'is:closed']) {
    const result = await gh.getIssueConnectionPage({ first: 5, query });
    assert.equal(result.ok, false);
    assert.match(result.error, /no search text/);
  }
  assert.equal(calls().length, 0, 'a refused request never reaches a subprocess');
  const blank = await gh.getIssueConnectionPage({ first: 5, query: '   ' });
  assert.equal(blank.ok, true, 'blank text is no text');
});

test('invalid connection page inputs produce no subprocess calls', async () => {
  const calls = connectionRunner(() => connection([]));
  for (const first of [0, -1, 1.5, NaN, 1001]) assert.equal((await gh.getIssueConnectionPage({ first })).ok, false);
  for (const after of ['', 5, {}, []]) assert.equal((await gh.getIssueConnectionPage({ first: 5, after })).ok, false);
  for (const params of [null, [], 'bad']) assert.equal((await gh.getIssueConnectionPage(params)).ok, false);
  assert.equal(calls().length, 0);
});

test('GraphQL errors, malformed connections and duplicate rows are failures, never fake pages', async () => {
  const failures = [
    [ok({ errors: [{ message: 'Forbidden' }] }), /Forbidden/],
    [ok({ data: { repository: { issues: { pageInfo: { hasNextPage: false }, edges: [] } } } }), /invalid issue page/],
    [ok({ data: { repository: { issues: { totalCount: -1, pageInfo: { hasNextPage: false }, edges: [] } } } }), /invalid issue page/],
    [connection([{ node: node(1) }]), /invalid issue cursor or duplicate issue/],
    [connection([{ cursor: 'c1', node: node(1) }, { cursor: 'c1', node: node(2) }]), /invalid issue cursor or duplicate issue/],
    [connection([{ cursor: 'c1', node: node(1) }, { cursor: 'c2', node: node(1) }]), /invalid issue cursor or duplicate issue/],
    [connection([], { totalCount: 4, hasNextPage: true, endCursor: null }), /did not advance/],
  ];
  for (const [response, pattern] of failures) {
    runner(() => response);
    const result = await gh.getIssueConnectionPage({ first: 5 });
    assert.equal(result.ok, false, `expected a failure for ${pattern}`);
    assert.match(String(result.error), pattern);
  }
  let round = 0;
  runner(() => {
    round += 1;
    const start = (round - 1) * 100 + 1;
    return connection(
      Array.from({ length: 100 }, (_, i) => ({ cursor: `c${start + i}`, node: node(start + i) })),
      { totalCount: 500, hasNextPage: true, endCursor: 'same' },
    );
  });
  const stalled = await gh.getIssueConnectionPage({ first: 200 });
  assert.equal(stalled.ok, false);
  assert.match(String(stalled.error), /did not advance/);
  runner(() => connection(
    [{ cursor: 'c1', node: node(1) }, { cursor: 'c2', node: node(2) }],
    { totalCount: 10, hasNextPage: true, endCursor: 'c2' },
  ));
  const oversized = await gh.getIssueConnectionPage({ first: 1 });
  assert.equal(oversized.ok, false);
  assert.match(String(oversized.error), /exceeded the requested issue page size/);
});

test('a failed continuation page is a failure, never a short page', async () => {
  let round = 0;
  runner(() => {
    round += 1;
    if (round === 1) return connection(Array.from({ length: 100 }, (_, i) => ({ cursor: `c${i + 1}`, node: node(i + 1) })), { totalCount: 260, hasNextPage: true, endCursor: 'c100' });
    return { status: 1, stdout: '', stderr: 'API rate limit exceeded', error: null };
  });
  const result = await gh.getIssueConnectionPage({ first: 150 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /API rate limit exceeded/);
  assert.equal('issues' in result, false, 'no partial page is handed out as data');
});

test('a short server page stops the fill and keeps the server hasNextPage', async () => {
  let round = 0;
  runner(() => {
    round += 1;
    if (round === 1) return connection(Array.from({ length: 100 }, (_, i) => ({ cursor: `c${i + 1}`, node: node(i + 1) })), { totalCount: 400, hasNextPage: true, endCursor: 'c100' });
    return connection(Array.from({ length: 20 }, (_, i) => ({ cursor: `c${101 + i}`, node: node(101 + i) })), { totalCount: 400, hasNextPage: true, endCursor: 'c120' });
  });
  const result = await gh.getIssueConnectionPage({ first: 150 });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 120, 'a short page is honored, never refilled');
  assert.equal(result.issues[119].cursor, 'c120', 'the caller continues from the last delivered row');
  assert.equal(result.hasNextPage, true);
  assert.equal(result.total, 400);
});

test('the typed-search path keeps its search semantics and its honest cap', async () => {
  const calls = runner((argv) => {
    assert.match(field(argv, 'search'), /is:open/);
    assert.match(field(argv, 'search'), /sort:updated-desc/);
    return ok({ data: { search: { issueCount: 12, pageInfo: { hasNextPage: true, endCursor: 'next' }, edges: [{ cursor: 'next', node: node(4) }] } } });
  });
  const result = await gh.getIssuePage({ query: 'assignee:@me', first: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.total, 12);
  assert.equal(result.issues[0].cursor, 'next');
  runner(() => ok({ data: { search: { issueCount: 1001, pageInfo: { hasNextPage: true, endCursor: 'next' }, edges: [{ cursor: 'next', node: node(4) }] } } }));
  const capped = await gh.getIssuePage({ first: 7 });
  assert.equal(capped.ok, false);
  assert.equal(capped.truncated, true);
  assert.match(String(capped.error), /1000/);
  assert.equal(calls.filter((argv) => argv[0] === 'api').length, 1);
});

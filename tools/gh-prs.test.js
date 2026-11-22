'use strict';
// T1 (prs-panel S1-S3): tests for lib/gh-prs.js, the `gh` client of the `/prs`
// panel. It is the pull request sibling of lib/gh-issues.js, so it keeps the
// same contract: fixed argv (never a shell string), `--json`/GraphQL data
// parsed and normalized, repository identity pinned and validated, and every
// call answering `{ok:true, ...}` or `{ok:false, error}` without ever throwing.
//
// The runner seam (`setGhRunner`) means no test invokes the real `gh`. The
// fixtures under tools/fixtures/gh-pr-*.json carry payloads in the EXACT shapes
// `gh pr view --json …` and `gh api graphql` answer with (fields recorded from
// gh's documented `--json` set and the GraphQL schema); they are not dumps of a
// live run, because no authenticated `gh` is available in this environment.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ghIssues = require('../lib/gh-issues.js');
const ghPrsModule = require('../lib/gh-prs.js');
// The client is built with the issue module INJECTED (the extension passes its
// own `libRequire('gh-issues.js')` instance in T5); no lib module may require it.
const ghPrs = ghPrsModule.bindIssuesClient(ghIssues);

const FIXTURES = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function okJson(stdout) {
  return { status: 0, stdout, stderr: '', error: null };
}

// Every non-scope test binds the repository explicitly, so the identity lookup
// costs no `gh repo view` child and each assertion counts exactly the children
// the call under test runs.
const PINNED = { scope: 'octo/repo' };

// Recorder: captures (bin, argv) and answers from a script of outcomes.
function makeRunner(script) {
  const calls = [];
  const queue = Array.isArray(script) ? script.slice() : [script];
  const runner = (bin, argv, runOpts) => {
    calls.push({ bin, argv: argv.slice(), runOpts: { ...(runOpts || {}) } });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(calls[calls.length - 1]);
    return Promise.resolve({ status: 0, stdout: '', stderr: '', error: null, ...(next || {}) });
  };
  return { runner, calls };
}

// The GraphQL query a child carries (`-f query=…`).
function queryOf(call) {
  const at = call.argv.indexOf('-f');
  return at >= 0 ? String(call.argv[at + 1]).replace(/^query=/, '') : '';
}

// A GraphQL variable the child carries (`-F name=value`), or null.
function fieldOf(call, name) {
  for (let at = 0; at < call.argv.length - 1; at += 1) {
    if (call.argv[at] === '-F' && String(call.argv[at + 1]).startsWith(`${name}=`)) {
      return String(call.argv[at + 1]).slice(name.length + 1);
    }
  }
  return null;
}

// A metadata/permission answer shaped like the real `viewerPermission` query.
function pullRequestGraphql({
  permission = 'WRITE', merge = true, squash = true, rebase = false, isDraft = false, viewer = 'octocat',
} = {}) {
  const calls = [];
  const runner = async (_bin, argv) => {
    calls.push(argv.slice());
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const query = queryOf({ argv });
      if (query.includes('viewer { login }')) {
        return okJson(JSON.stringify({
          data: { repository: { viewerPermission: permission }, viewer: { login: viewer } },
        }));
      }
      return okJson(JSON.stringify({
        data: {
          repository: {
            viewerPermission: permission,
            mergeCommitAllowed: merge,
            squashMergeAllowed: squash,
            rebaseMergeAllowed: rebase,
            pullRequest: {
              isDraft,
              state: 'OPEN',
              closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      }));
    }
    return okJson('');
  };
  return { runner, calls };
}

// A repository-permission answer shaped like the client's own role read.
function okPermission(permission = 'WRITE') {
  return okJson(JSON.stringify({ data: { repository: { viewerPermission: permission } } }));
}

function argvStartingWith(calls, first, second) {
  return calls.find((argv) => argv[0] === first && argv[1] === second);
}

const NO_CAPABILITIES = {
  canEditLabels: false,
  canCreateLabels: false,
  canEditAssignees: false,
  canClosePullRequests: false,
  canMerge: false,
  canEditLinkedIssues: false,
};

beforeEach(() => {
  ghPrs.setGhRunner(null);
});

// ---------------------------------------------------------------------------
// S1: the three scoped buckets read through the search API, exactly like the
// issues panel's buckets, and the caller's typed query rides that same search.
// ---------------------------------------------------------------------------
describe('the three buckets read through the repository search', () => {
  test('the mine bucket asks for my open pull requests and normalizes every row', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-search-page.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'mine', pageSize: 30 }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 1, 'one GraphQL request');
    const call = calls[0];
    assert.deepEqual(call.argv.slice(0, 2), ['api', 'graphql']);
    assert.match(queryOf(call), /search\(query: \$search, type: ISSUE/);
    assert.equal(fieldOf(call, 'search'), 'repo:octo/repo is:pr is:open author:@me sort:updated-desc');
    assert.equal(fieldOf(call, 'first'), '30');
    assert.equal(fieldOf(call, 'cursor'), null, 'the first page starts the connection');

    assert.equal(res.totalCount, 2, 'the search reports its exact match count');
    assert.equal(res.hasMore, false);
    assert.equal(res.cursor, null);
    assert.equal(res.rows.length, 2);

    const row = res.rows[0];
    assert.equal(row.number, 87);
    assert.equal(row.title, 'feat: the prs panel');
    assert.equal(row.state, 'open');
    assert.equal(row.isDraft, false);
    assert.equal(row.author, 'jonasotoaguilar');
    assert.deepEqual(row.labels, [{ name: 'enhancement', color: 'a2eeef', description: 'New feature or request' }]);
    assert.deepEqual(row.assignees, ['octocat']);
    assert.equal(row.commentsCount, 2);
    assert.equal(row.reviewDecision, 'REVIEW_REQUIRED');
    assert.equal(row.createdAt, '2026-10-18T04:21:27Z');
    assert.equal(row.updatedAt, '2026-10-19T08:00:00Z');
    assert.equal(row.url, 'https://github.com/jonasotoaguilar/herdr-gentle-shell/pull/87');
    assert.deepEqual(row.reactions, { total: 3, plusOne: 0 });
    assert.equal(row.isPullRequest, true);
    assert.equal(row.body, '', 'the list never asks for bodies');
    assert.equal(row.cursor, 'Y3Vyc29yOnYyOpK5MjAyNi0xMC0xOVQwODowMDowMFo', 'every row keeps its own cursor');

    assert.equal(res.rows[1].number, 86);
    assert.equal(res.rows[1].isDraft, true);
    assert.equal(res.rows[1].reviewDecision, '');
  });

  test('the review and involved buckets carry their own qualifier', async () => {
    for (const [bucket, qualifier] of [['review', 'review-requested:@me'], ['involved', 'involves:@me']]) {
      const { runner, calls } = makeRunner(okJson(fixture('gh-pr-search-page.json')));
      ghPrs.setGhRunner(runner);

      const res = await ghPrs.getPullRequestPage({ bucket }, PINNED);

      assert.equal(res.ok, true, res.error);
      assert.equal(fieldOf(calls[0], 'search'), `repo:octo/repo is:pr is:open ${qualifier} sort:updated-desc`);
    }
  });

  test('a typed query rides the bucket search and an explicit sort is never doubled', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-search-page.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'mine', query: 'label:bug sort:created-asc' }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(fieldOf(calls[0], 'search'),
      'repo:octo/repo is:pr is:open author:@me label:bug sort:created-asc');
  });

  test('a cursor page continues from the endCursor the previous page handed back', async () => {
    const page = (edges, { issueCount, hasNextPage, endCursor }) => okJson(JSON.stringify({
      data: {
        search: {
          issueCount,
          pageInfo: { hasNextPage, endCursor },
          edges: edges.map(([cursor, number]) => ({ cursor, node: { number, title: `pr ${number}`, state: 'OPEN' } })),
        },
      },
    }));
    const { runner, calls } = makeRunner([
      page([['c1', 87], ['c2', 86]], { issueCount: 3, hasNextPage: true, endCursor: 'p1' }),
      page([['c3', 85]], { issueCount: 3, hasNextPage: false, endCursor: null }),
    ]);
    ghPrs.setGhRunner(runner);

    const firstPage = await ghPrs.getPullRequestPage({ bucket: 'mine', pageSize: 3 }, PINNED);

    assert.equal(firstPage.ok, true, firstPage.error);
    assert.equal(firstPage.rows.length, 2, 'a short server page is a valid page, never filled by a second request');
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.cursor, 'p1');

    const secondPage = await ghPrs.getPullRequestPage(
      { bucket: 'mine', pageSize: 3, cursor: firstPage.cursor }, PINNED,
    );

    assert.equal(secondPage.ok, true, secondPage.error);
    assert.deepEqual(secondPage.rows.map((row) => row.number), [85]);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.cursor, null);
    assert.equal(fieldOf(calls[1], 'cursor'), 'p1', 'the next request resumes at the handed-back cursor');
  });

  test('an invalid bucket, page size or cursor is refused without a child', async () => {
    const { runner, calls } = makeRunner(okJson('{}'));
    ghPrs.setGhRunner(runner);

    const invalid = [
      await ghPrs.getPullRequestPage({ bucket: 'bogus' }, PINNED),
      await ghPrs.getPullRequestPage({ bucket: 'mine', pageSize: 0 }, PINNED),
      await ghPrs.getPullRequestPage({ bucket: 'mine', pageSize: 1001 }, PINNED),
      await ghPrs.getPullRequestPage({ bucket: 'mine', cursor: '' }, PINNED),
    ];

    for (const res of invalid) assert.equal(res.ok, false);
    assert.match(String(invalid[0].error), /invalid bucket "bogus": want mine, review, involved or all/);
    assert.match(String(invalid[1].error), /pageSize must be 1\.\.1000/);
    assert.match(String(invalid[3].error), /pageSize must be 1\.\.1000/);
    assert.equal(calls.length, 0, 'no child runs for a rejected page');
  });

  test('a search past GitHub\'s 1000-match cap fails honestly instead of truncating', async () => {
    const { runner } = makeRunner(okJson(JSON.stringify({
      data: { search: { issueCount: 1200, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } },
    })));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'involved' }, PINNED);

    assert.equal(res.ok, false);
    assert.equal(res.truncated, true);
    assert.match(String(res.error), /exceeds 1000 matches/);
  });

  test('a malformed search page fails closed', async () => {
    const { runner } = makeRunner(okJson(JSON.stringify({ data: { search: {} } })));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'mine' }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /invalid pull request page/);
  });
});

// ---------------------------------------------------------------------------
// S1: the lazy `all prs` bucket is the repository CONNECTION, pageable to its
// exact total, and a typed query there stays a capped search.
// ---------------------------------------------------------------------------
describe('the All bucket reads the repository connection', () => {
  test('getPullRequestConnectionPage asks for open pull requests with their exact total', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-connection-page.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestConnectionPage({ pageSize: 30 }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.match(queryOf(call), /pullRequests\(states: OPEN, first: \$first, after: \$cursor/);
    assert.match(queryOf(call), /orderBy: \{field: UPDATED_AT, direction: DESC\}/);
    assert.equal(fieldOf(call, 'owner'), 'octo');
    assert.equal(fieldOf(call, 'name'), 'repo');
    assert.equal(fieldOf(call, 'first'), '30');
    assert.equal(res.totalCount, 2);
    assert.equal(res.hasMore, false);
    assert.equal(res.cursor, null);
    assert.deepEqual(res.rows.map((row) => row.number), [87, 86]);
    assert.equal(res.rows[0].isDraft, false);
    assert.equal(res.rows[1].isDraft, true);
  });

  test('the all bucket without search text is the connection, and its short page keeps its boundary', async () => {
    const { runner, calls } = makeRunner(okJson(JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            totalCount: 5,
            pageInfo: { hasNextPage: true, endCursor: 'p1' },
            edges: [
              { cursor: 'c1', node: { number: 87, title: 'pr 87', state: 'OPEN' } },
              { cursor: 'c2', node: { number: 86, title: 'pr 86', state: 'OPEN' } },
            ],
          },
        },
      },
    })));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'all', pageSize: 3 }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.match(queryOf(calls[0]), /pullRequests\(states: OPEN/);
    assert.equal(res.rows.length, 2);
    assert.equal(res.hasMore, true, 'the connection still has pages after this short one');
    assert.equal(res.cursor, 'p1');
    assert.equal(res.totalCount, 5);
  });

  test('the all bucket with typed text stays a capped search with no bucket qualifier', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-search-page.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'all', query: 'review:approved' }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(fieldOf(calls[0], 'search'), 'repo:octo/repo is:pr is:open review:approved sort:updated-desc');
  });
});

// ---------------------------------------------------------------------------
// S1/S3: the detail read plus the metadata read — checks rollup, reviewers,
// linked issues, the merge methods the repository allows and GitHub's own merge
// proposals.
// ---------------------------------------------------------------------------
describe('getPullRequest: detail and metadata', () => {
  test('the pane payload carries every fact the summary draws', async () => {
    const { runner, calls } = makeRunner([
      okJson(fixture('gh-pr-view.json')),
      okJson(fixture('gh-pr-metadata.json')),
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, { includeMetadata: true }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 2, 'one detail read and one metadata read');
    assert.deepEqual(calls[0].argv.slice(0, 3), ['pr', 'view', '87']);
    assert.ok(calls[0].argv.includes('--json'));

    const pr = res.pullRequest;
    assert.equal(pr.number, 87);
    assert.equal(pr.state, 'open');
    assert.equal(pr.isDraft, false);
    assert.equal(pr.author, 'jonasotoaguilar');
    assert.deepEqual(pr.assignees, ['octocat']);
    assert.equal(pr.body, JSON.parse(fixture('gh-pr-view.json')).body, 'the body arrives byte for byte');
    assert.deepEqual(pr.reactions, { total: 3, plusOne: 0 });
    assert.equal(pr.commentsCount, 2);
    assert.equal(pr.baseRefName, 'main');
    assert.equal(pr.headRefName, 'feat/prs-panel');
    assert.equal(pr.additions, 412);
    assert.equal(pr.deletions, 31);
    assert.equal(pr.changedFiles, 9);
    assert.equal(pr.commits, 2, 'the commit count is the commit list length');
    assert.equal(pr.committedAt, '2026-10-19T07:30:00Z', 'the newest commit date');
    assert.equal(pr.mergeable, 'MERGEABLE');
    assert.equal(pr.mergeStateStatus, 'BLOCKED');
    assert.equal(pr.reviewDecision, 'REVIEW_REQUIRED');
    assert.deepEqual(pr.reviewers, [
      { login: 'reviewer-two', state: 'REQUESTED' },
      { login: 'reviewer-one', state: 'APPROVED' },
    ], 'an outstanding request is REQUESTED and a submitted review keeps its state');
    assert.deepEqual(pr.linkedIssues, [14, 63], 'closingIssuesReferences, deduplicated and sorted');
    assert.equal(pr.linkedIssuesTruncated, false);
    assert.deepEqual(pr.checks, {
      total: 5, passed: 3, failed: 1, pending: 1, state: 'FAILURE', failing: ['build'],
    });
    assert.deepEqual(pr.mergeMethods, { merge: true, squash: true }, 'only the methods the repository allows');
    assert.deepEqual(pr.mergeDefaults, {
      merge: {
        subject: 'Merge pull request #87 from jonasotoaguilar/feat/prs-panel',
        body: 'feat: the prs panel',
      },
      squash: { subject: 'feat: the prs panel', body: '' },
    });
    assert.deepEqual(pr.permissions, {
      canEditLabels: true,
      canCreateLabels: true,
      canEditAssignees: true,
      canClosePullRequests: true,
      canMerge: true,
      canEditLinkedIssues: true,
    });
    assert.equal(pr.permissions.canCreateLabels, true,
      'the metadata carries the label-creation capability the picker needs');
    assert.equal(pr.metadataError, null);
    assert.deepEqual(pr.unavailable, []);

    assert.equal(res.comments.length, 2);
    assert.equal(res.comments[0].author, 'reviewer-one');
    assert.equal(res.comments[0].body, 'Looks good to me');
    assert.deepEqual(res.comments[0].reactions, { total: 2, plusOne: 2 });
    assert.equal(res.comments[1].id, 'IC_kwDOA2');
  });

  test('a lost metadata read fails closed and names what is missing', async () => {
    const { runner } = makeRunner([
      okJson(fixture('gh-pr-view.json')),
      { status: 1, stdout: '', stderr: 'permission read failed', error: null },
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, { includeMetadata: true }, PINNED);

    assert.equal(res.ok, true, 'the detail read still answers');
    const pr = res.pullRequest;
    assert.deepEqual(pr.permissions, NO_CAPABILITIES, 'nothing is confirmed without a permission read');
    assert.deepEqual(pr.mergeMethods, {}, 'no method is claimed for a read that failed');
    assert.deepEqual(pr.mergeDefaults, {});
    assert.match(String(pr.metadataError), /permission read failed/);
    assert.deepEqual(pr.unavailable, ['permissions', 'merge methods']);
    assert.deepEqual(pr.linkedIssues, [14, 63], 'the detail read already carried the linked issues');
  });

  test('a draft pull request cannot be merged, whatever the permission', async () => {
    const { runner } = makeRunner([
      okJson(fixture('gh-pr-view.json')),
      okJson(JSON.stringify({
        data: {
          repository: {
            viewerPermission: 'WRITE',
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
            pullRequest: {
              isDraft: true,
              closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      })),
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, { includeMetadata: true }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.pullRequest.permissions.canMerge, false);
    assert.equal(res.pullRequest.permissions.canClosePullRequests, true);
  });

  test('a repository that allows no merge method offers none', async () => {
    const { runner } = makeRunner([
      okJson(fixture('gh-pr-view.json')),
      okJson(JSON.stringify({
        data: {
          repository: {
            viewerPermission: 'ADMIN',
            mergeCommitAllowed: false,
            squashMergeAllowed: false,
            rebaseMergeAllowed: false,
            pullRequest: {
              isDraft: false,
              closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      })),
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, { includeMetadata: true }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.pullRequest.mergeMethods, {});
    assert.deepEqual(res.pullRequest.mergeDefaults, {});
    assert.equal(res.pullRequest.permissions.canMerge, false);
  });

  test('a truncated linked-issue page is marked instead of passed off as whole', async () => {
    const { runner } = makeRunner([
      okJson(fixture('gh-pr-view.json')),
      okJson(JSON.stringify({
        data: {
          repository: {
            viewerPermission: 'WRITE',
            mergeCommitAllowed: true,
            squashMergeAllowed: false,
            rebaseMergeAllowed: false,
            pullRequest: {
              isDraft: false,
              closingIssuesReferences: { nodes: [{ number: 5 }], pageInfo: { hasNextPage: true } },
            },
          },
        },
      })),
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, { includeMetadata: true }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.pullRequest.linkedIssues, [5]);
    assert.equal(res.pullRequest.linkedIssuesTruncated, true);
  });

  test('a detail read without metadata keeps the fail-closed shape', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-view.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, {}, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 1, 'no metadata child');
    assert.deepEqual(res.pullRequest.permissions, NO_CAPABILITIES);
    assert.deepEqual(res.pullRequest.mergeMethods, {});
    assert.deepEqual(res.pullRequest.mergeDefaults, {});
    assert.deepEqual(res.pullRequest.linkedIssues, [14, 63]);
    assert.equal(res.pullRequest.metadataError, null);
  });
});

// ---------------------------------------------------------------------------
// S2 + invariant 7: the capability map. Only a literal permitted role yields a
// capability, and merge additionally needs a non-draft pull request and at
// least one method the repository allows.
// ---------------------------------------------------------------------------
describe('pullRequestPermissions fails closed', () => {
  test('the roles that may edit a pull request, and the ones that may not', () => {
    const nonDraft = { isDraft: false, mergeMethods: { merge: true } };

    assert.deepEqual(ghPrs.pullRequestPermissions('WRITE', nonDraft), {
      canEditLabels: true,
      canCreateLabels: true,
      canEditAssignees: true,
      canClosePullRequests: true,
      canMerge: true,
      canEditLinkedIssues: true,
    });
    for (const role of ['MAINTAIN', 'ADMIN']) {
      assert.equal(ghPrs.pullRequestPermissions(role, nonDraft).canMerge, true, `${role} may merge`);
    }

    // TRIAGE may manage labels and assignees; it may not close, merge, create a
    // repository label or rewrite the body of somebody else's pull request.
    assert.deepEqual(ghPrs.pullRequestPermissions('TRIAGE', nonDraft), {
      canEditLabels: true,
      canCreateLabels: false,
      canEditAssignees: true,
      canClosePullRequests: false,
      canMerge: false,
      canEditLinkedIssues: false,
    });
  });

  test('label creation is write-level, confirmed at WRITE and up alone', () => {
    for (const role of ['WRITE', 'MAINTAIN', 'ADMIN']) {
      assert.equal(ghPrs.pullRequestPermissions(role).canCreateLabels, true, `${role} may create a label`);
    }
    for (const role of ['TRIAGE', 'READ', 'NONE', 'write', null, undefined, true, {}]) {
      assert.equal(ghPrs.pullRequestPermissions(role).canCreateLabels, false,
        `${JSON.stringify(role)} confirms no label creation`);
    }
  });

  test('read access, an unknown role and a missing role all confirm nothing', () => {
    const nonDraft = { isDraft: false, mergeMethods: { merge: true, squash: true, rebase: true } };
    for (const role of ['READ', 'NONE', 'write', 'TRIAGE ', null, undefined, true, {}]) {
      assert.deepEqual(ghPrs.pullRequestPermissions(role, nonDraft), NO_CAPABILITIES,
        `${JSON.stringify(role)} confirms no capability`);
    }
  });

  test('merge needs a non-draft pull request and an allowed method', () => {
    assert.equal(ghPrs.pullRequestPermissions('ADMIN', { isDraft: true, mergeMethods: { merge: true } }).canMerge, false);
    assert.equal(ghPrs.pullRequestPermissions('ADMIN', { isDraft: false, mergeMethods: {} }).canMerge, false);
    assert.equal(ghPrs.pullRequestPermissions('ADMIN').canMerge, false,
      'a caller with no pull request facts confirms no merge');
  });
});

// ---------------------------------------------------------------------------
// S2: every mutation's argv, one element per value, never a shell string.
// ---------------------------------------------------------------------------
describe('mutations: their exact argv', () => {
  test('commentPullRequest passes the body as one argv element', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.commentPullRequest(87, 'looks good; $(rm -rf /) `id`', PINNED);

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(calls[0].argv, ['pr', 'comment', '87', '--body', 'looks good; $(rm -rf /) `id`']);
  });

  test('an empty comment body and a non-integer number are refused without a child', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghPrs.setGhRunner(runner);

    const empty = await ghPrs.commentPullRequest(87, '   ', PINNED);
    const invalid = await ghPrs.commentPullRequest('abc', 'hi', PINNED);

    assert.equal(empty.ok, false);
    assert.match(String(empty.error), /comment body must be a non-empty string/);
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /invalid pull request number "abc": want a positive integer/);
    assert.equal(calls.length, 0);
  });

  test('editLabels applies and removes labels through the pull request surface', async () => {
    const { runner, calls } = makeRunner([okPermission(), okJson('')]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLabels(87, { add: ['bug'], remove: ['wontfix'] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(argvStartingWith(calls.map((call) => call.argv), 'pr', 'edit'),
      ['pr', 'edit', '87', '--add-label', 'bug', '--remove-label', 'wontfix']);
    assert.match(queryOf(calls[0]), /viewerPermission/, 'the role is read before the write');
    const noop = await ghPrs.editLabels(87, {}, PINNED);
    assert.equal(noop.ok, true);
    assert.equal(calls.length, 2, 'an empty edit runs no child');
  });

  test('listLabels and createLabel are repository-level and mirrored here', async () => {
    const { runner, calls } = makeRunner([
      okJson(fixture('gh-label-list.json')), okPermission(), okJson('{"name":"triage"}'),
    ]);
    ghPrs.setGhRunner(runner);

    const labels = await ghPrs.listLabels(PINNED);
    assert.equal(labels.ok, true, labels.error);
    assert.ok(labels.labels.length >= 1);
    const created = await ghPrs.createLabel({ name: 'triage', color: 'FBCA04' }, PINNED);

    assert.equal(created.ok, true, created.error);
    assert.deepEqual(calls[0].argv.slice(0, 2), ['label', 'list']);
    assert.match(queryOf(calls[1]), /viewerPermission/, 'creating a label reads the role first');
    assert.deepEqual(calls[2].argv, ['label', 'create', 'triage', '--color', 'FBCA04']);
  });

  test('closePullRequest closes exactly one pull request', async () => {
    const { runner, calls } = makeRunner([okPermission(), okJson('')]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.closePullRequest(87, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.match(queryOf(calls[0]), /viewerPermission/, 'the role is read before the write');
    assert.deepEqual(argvStartingWith(calls.map((call) => call.argv), 'pr', 'close'), ['pr', 'close', '87']);
  });

  test('mergePullRequest pins the method flag and the proposals it was given', async () => {
    const fake = pullRequestGraphql({ merge: true, squash: true, rebase: false });
    ghPrs.setGhRunner(fake.runner);

    const res = await ghPrs.mergePullRequest(
      87, { method: 'merge', subject: 'Merge pull request #87', body: 'feat: the prs panel' }, PINNED,
    );

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(argvStartingWith(fake.calls, 'pr', 'merge'),
      ['pr', 'merge', '87', '--merge', '--subject', 'Merge pull request #87', '--body', 'feat: the prs panel']);
  });

  test('squash carries no proposal when none was given, and rebase takes neither', async () => {
    const squash = pullRequestGraphql({ merge: false, squash: true, rebase: false });
    ghPrs.setGhRunner(squash.runner);
    const squashed = await ghPrs.mergePullRequest(87, { method: 'squash' }, PINNED);
    assert.equal(squashed.ok, true, squashed.error);
    assert.deepEqual(argvStartingWith(squash.calls, 'pr', 'merge'), ['pr', 'merge', '87', '--squash']);

    const rebase = pullRequestGraphql({ merge: false, squash: false, rebase: true });
    ghPrs.setGhRunner(rebase.runner);
    const rebased = await ghPrs.mergePullRequest(87, { method: 'rebase', subject: 'ignored', body: 'ignored' }, PINNED);
    assert.equal(rebased.ok, true, rebased.error);
    assert.deepEqual(argvStartingWith(rebase.calls, 'pr', 'merge'), ['pr', 'merge', '87', '--rebase'],
      'a rebase merge takes neither a subject nor a body');
  });

  test('merge refuses a method the repository does not allow', async () => {
    const fake = pullRequestGraphql({ merge: true, squash: false, rebase: false });
    ghPrs.setGhRunner(fake.runner);

    const res = await ghPrs.mergePullRequest(87, { method: 'squash' }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /the repository does not allow the "squash" merge method/);
    assert.equal(argvStartingWith(fake.calls, 'pr', 'merge'), undefined, 'no merge child runs');
  });

  test('merge refuses a draft pull request', async () => {
    const fake = pullRequestGraphql({ isDraft: true });
    ghPrs.setGhRunner(fake.runner);

    const res = await ghPrs.mergePullRequest(87, { method: 'merge' }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /pull request #87 is a draft/);
    assert.equal(argvStartingWith(fake.calls, 'pr', 'merge'), undefined);
  });

  test('merge refuses a repository that allows no method and a viewer who may not merge', async () => {
    const none = pullRequestGraphql({ merge: false, squash: false, rebase: false });
    ghPrs.setGhRunner(none.runner);
    const noMethod = await ghPrs.mergePullRequest(87, { method: 'merge' }, PINNED);
    assert.equal(noMethod.ok, false);
    assert.match(String(noMethod.error), /allows no merge method/);

    const readOnly = pullRequestGraphql({ permission: 'READ' });
    ghPrs.setGhRunner(readOnly.runner);
    const denied = await ghPrs.mergePullRequest(87, { method: 'merge' }, PINNED);
    assert.equal(denied.ok, false);
    assert.match(String(denied.error), /Repository permission does not allow merging pull requests/);
    assert.equal(argvStartingWith(readOnly.calls, 'pr', 'merge'), undefined);
  });

  test('an unknown merge method is refused before any child runs', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.mergePullRequest(87, { method: 'fast-forward' }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /invalid merge method "fast-forward": want merge, squash or rebase/);
    assert.equal(calls.length, 0);
  });

  test('editAssignees checks the permission and then toggles the viewer', async () => {
    const fake = pullRequestGraphql({ permission: 'WRITE', viewer: 'octocat' });
    ghPrs.setGhRunner(fake.runner);

    const res = await ghPrs.editAssignees(87, { add: ['octocat'], remove: ['someone'] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.self, true, 'the toggle names the authenticated viewer');
    assert.deepEqual(argvStartingWith(fake.calls, 'pr', 'edit'),
      ['pr', 'edit', '87', '--add-assignee', 'octocat', '--remove-assignee', 'someone']);
  });

  test('editAssignees refuses a denied permission and a malformed login', async () => {
    const readOnly = pullRequestGraphql({ permission: 'READ' });
    ghPrs.setGhRunner(readOnly.runner);
    const denied = await ghPrs.editAssignees(87, { add: ['octocat'] }, PINNED);
    assert.equal(denied.ok, false);
    assert.match(String(denied.error), /does not allow changing pull request assignees/);
    assert.equal(argvStartingWith(readOnly.calls, 'pr', 'edit'), undefined);

    const { runner, calls } = makeRunner(okJson(''));
    ghPrs.setGhRunner(runner);
    const malformed = await ghPrs.editAssignees(87, { add: ['not a login!'] }, PINNED);
    assert.equal(malformed.ok, false);
    assert.match(String(malformed.error), /invalid assignee changes/);
    assert.equal(calls.length, 0);
  });

  test('a failing mutation reports gh\'s own words', async () => {
    const { runner } = makeRunner({ status: 1, stdout: '', stderr: 'Could not resolve to a PullRequest', error: null });
    ghPrs.setGhRunner(runner);

    const closed = await ghPrs.closePullRequest(87, PINNED);
    const commented = await ghPrs.commentPullRequest(87, 'hi', PINNED);
    const merged = await ghPrs.mergePullRequest(87, { method: 'merge' }, PINNED);

    for (const res of [closed, commented, merged]) {
      assert.equal(res.ok, false);
      assert.match(String(res.error), /Could not resolve/);
    }
  });
});

// ---------------------------------------------------------------------------
// S2 (D2): a capability is read AGAIN by the client itself, so a pane painted
// from a lost permission still never issues a write child. Read access keeps
// the one ungated write S2 names: the comment.
// ---------------------------------------------------------------------------
describe('every write re-reads the repository role before it runs', () => {
  const WRITES = [
    ['closePullRequest', 'does not allow closing pull requests', (client) => client.closePullRequest(87, PINNED)],
    ['createLabel', 'does not allow creating labels', (client) => client.createLabel({ name: 'needs-work' }, PINNED)],
    ['editLabels', 'does not allow editing pull request labels',
      (client) => client.editLabels(87, { add: ['bug'] }, PINNED)],
    ['editLinkedIssues', 'does not allow editing pull request linked issues',
      (client) => client.editLinkedIssues(87, { add: [12] }, PINNED)],
  ];

  for (const [name, sentence, call] of WRITES) {
    test(`${name} fails closed on READ access and names the missing permission`, async () => {
      const { runner, calls } = makeRunner(okPermission('READ'));
      ghPrs.setGhRunner(runner);

      const res = await call(ghPrs);

      assert.equal(res.ok, false, `${name} is refused`);
      assert.match(String(res.error), new RegExp(sentence));
      assert.equal(calls.length, 1, 'the role read is the only child');
      assert.match(queryOf(calls[0]), /viewerPermission/);
      const write = calls.find((entry) => !(entry.argv[0] === 'api' && entry.argv[1] === 'graphql'));
      assert.equal(write, undefined, `${name} spawns no write child`);
    });
  }

  test('a TRIAGE role may label but may not close, create or rewrite the body', async () => {
    const triage = pullRequestGraphql({ permission: 'TRIAGE' });
    ghPrs.setGhRunner(triage.runner);

    const labelled = await ghPrs.editLabels(87, { add: ['bug'] }, PINNED);
    assert.equal(labelled.ok, true, labelled.error);
    const created = await ghPrs.createLabel({ name: 'needs-work' }, PINNED);
    const closed = await ghPrs.closePullRequest(87, PINNED);
    const linked = await ghPrs.editLinkedIssues(87, { add: [12] }, PINNED);

    for (const res of [created, closed, linked]) assert.equal(res.ok, false);
    assert.match(String(created.error), /does not allow creating labels/);
    assert.match(String(closed.error), /does not allow closing pull requests/);
    assert.match(String(linked.error), /does not allow editing pull request linked issues/);
    assert.equal(argvStartingWith(triage.calls, 'pr', 'close'), undefined);
    assert.equal(argvStartingWith(triage.calls, 'label', 'create'), undefined);
    assert.equal(triage.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'edit').length, 1,
      'the one write that ran is the label edit');
  });

  test('a comment stays ungated, exactly like the issue client', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.commentPullRequest(87, 'hi', PINNED);

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(calls.map((call) => call.argv), [['pr', 'comment', '87', '--body', 'hi']],
      'no role read and no gate stands in front of a comment');
  });
});

// ---------------------------------------------------------------------------
// S2 (D13): a write and the role read that authorizes it share ONE resolved
// repository scope. The checkout is resolved once, and every child of the write
// — the role read included — runs under the identity it proved, so a remote
// that moves between the two children cannot authorize one repository and write
// under another.
// ---------------------------------------------------------------------------
describe('a write shares one resolved scope with its role read', () => {
  const CALLS = [
    ['closePullRequest', (client, opts) => client.closePullRequest(87, opts),
      (argv) => argv[0] === 'pr' && argv[1] === 'close'],
    ['editLabels', (client, opts) => client.editLabels(87, { add: ['bug'] }, opts),
      (argv) => argv[0] === 'pr' && argv[1] === 'edit' && argv.includes('--add-label')],
    ['editAssignees', (client, opts) => client.editAssignees(87, { add: ['octocat'] }, opts),
      (argv) => argv[0] === 'pr' && argv[1] === 'edit' && argv.includes('--add-assignee')],
    ['editLinkedIssues', (client, opts) => client.editLinkedIssues(87, { add: [99] }, opts),
      (argv) => argv[0] === 'pr' && argv[1] === 'edit' && argv.includes('--body')],
    ['mergePullRequest', (client, opts) => client.mergePullRequest(87, { method: 'merge' }, opts),
      (argv) => argv[0] === 'pr' && argv[1] === 'merge'],
  ];

  // A checkout whose remote MOVES: every resolution hands back a new repository,
  // so a child that resolves on its own writes somewhere the role read never saw.
  function movingCheckout() {
    const resolved = [];
    const children = [];
    const checkoutRepoScope = async () => {
      resolved.push(`github.com/octo/repo-${resolved.length + 1}`);
      return { ok: true, identity: resolved.at(-1), nameWithOwner: `octo/repo-${resolved.length}` };
    };
    const runGh = async (argv, opts = {}) => {
      let identity = null;
      if (opts.scope !== undefined) {
        identity = opts.scope === null || opts.scope === '' ? null : String(opts.scope);
      } else if (typeof opts.cwd === 'string' && opts.cwd !== '') {
        const scope = await checkoutRepoScope({ ...opts, fresh: opts.freshScope === true });
        if (scope.ok !== true) return { status: null, stdout: '', stderr: '', error: scope.error };
        identity = scope.identity;
      }
      children.push({ argv: argv.slice(), identity });
      if (argv[0] === 'repo') return okJson(JSON.stringify({ nameWithOwner: 'octo/base' }));
      if (argv[0] === 'api' && queryOf({ argv }).includes('viewer { login }')) {
        return okJson(JSON.stringify({
          data: { repository: { viewerPermission: 'WRITE' }, viewer: { login: 'octocat' } },
        }));
      }
      if (argv[0] === 'api') {
        return okJson(JSON.stringify({
          data: {
            repository: {
              viewerPermission: 'WRITE',
              mergeCommitAllowed: true,
              squashMergeAllowed: false,
              rebaseMergeAllowed: false,
              pullRequest: {
                isDraft: false,
                state: 'OPEN',
                closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          },
        }));
      }
      if (argv[0] === 'pr' && argv[1] === 'view') return okJson(JSON.stringify({ body: 'Closes #12' }));
      return okJson('');
    };
    return { runGh, checkoutRepoScope, children, resolved };
  }

  for (const [name, call, isWrite] of CALLS) {
    test(`${name} authorizes and writes in the same resolved repository`, async () => {
      const checkout = movingCheckout();
      const client = ghPrsModule.createPrsClient({ issues: checkout });

      const res = await call(client, { cwd: '/checkout' });

      assert.equal(res.ok, true, res.error);
      assert.equal(checkout.resolved.length, 1, 'the checkout is resolved once for the whole write');
      const writes = checkout.children.filter((child) => isWrite(child.argv));
      assert.equal(writes.length, 1, `${name} spawns exactly one write child`);
      assert.equal(writes[0].identity, 'github.com/octo/repo-1',
        `${name} wrote under the repository the role read proved`);
      for (const child of checkout.children.filter((entry) => entry.argv[0] !== 'repo')) {
        assert.equal(child.identity, writes[0].identity,
          `${child.argv.slice(0, 2).join(' ')} ran under ${child.identity}, not the write's identity`);
      }
    });
  }

  test('an unprovable checkout refuses before the role read or the write runs', async () => {
    const children = [];
    const client = ghPrsModule.createPrsClient({
      issues: {
        runGh: async (argv) => { children.push(argv.slice()); return okJson(''); },
        checkoutRepoScope: async () => ({ ok: false, error: 'cannot resolve the repository' }),
      },
    });

    const res = await client.closePullRequest(87, { cwd: '/checkout' });

    assert.equal(res.ok, false);
    assert.match(String(res.error), /cannot resolve the repository/);
    assert.deepEqual(children, [], 'nothing runs against a repository it could not prove');
  });
});

// ---------------------------------------------------------------------------
// S2: GitHub has no mutation for the Development panel, so a linked issue is a
// `Closes #N` line in the body — appended or removed, with every other byte of
// the body preserved exactly.
// ---------------------------------------------------------------------------
describe('editLinkedIssues rewrites only the closing lines', () => {
  test('adding a linked issue appends one Closes line and keeps the body byte for byte', async () => {
    const { runner, calls } = makeRunner([okPermission(), okJson(fixture('gh-pr-view.json')), okJson('')]);
    ghPrs.setGhRunner(runner);
    const original = JSON.parse(fixture('gh-pr-view.json')).body;

    const res = await ghPrs.editLinkedIssues(87, { add: [71] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, true);
    assert.match(queryOf(calls[0]), /viewerPermission/, 'the role is read before the body edit');
    const argv = calls[2].argv;
    assert.deepEqual(argv.slice(0, 4), ['pr', 'edit', '87', '--body']);
    const body = argv[argv.indexOf('--body') + 1];
    assert.equal(body, `${original}\nCloses #71\n`);
    assert.ok(body.startsWith(original), 'the original body is untouched');
    assert.equal(res.body, body);
  });

  test('removing a linked issue keeps CRLF endings and every other byte', async () => {
    const original = 'Summary line\r\n\r\nfixes #14\r\nCloses #63\r\nTrailing words';
    const { runner, calls } = makeRunner([
      okPermission(),
      okJson(JSON.stringify({ body: original })),
      okJson(''),
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLinkedIssues(87, { remove: [14] }, PINNED);

    assert.equal(res.ok, true, res.error);
    const body = calls[2].argv[calls[2].argv.indexOf('--body') + 1];
    assert.equal(body, 'Summary line\r\n\r\nCloses #63\r\nTrailing words');
    assert.equal(res.changed, true);
  });

  test('a number already declared changes nothing and runs no edit child', async () => {
    const { runner, calls } = makeRunner([okPermission(), okJson(fixture('gh-pr-view.json'))]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLinkedIssues(87, { add: [63] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, false);
    assert.equal(calls.length, 2, 'the role and the body read ran; no edit child did');
  });

  test('invalid linked-issue changes are refused without a child', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghPrs.setGhRunner(runner);

    for (const changes of [
      { add: [0] },
      { add: ['71'] },
      { add: [71], remove: [71] },
      { add: [-3] },
    ]) {
      const res = await ghPrs.editLinkedIssues(87, changes, PINNED);
      assert.equal(res.ok, false, `${JSON.stringify(changes)} is refused`);
      assert.match(String(res.error), /invalid linked-issue changes: supply distinct positive issue numbers/);
    }
    assert.equal(calls.length, 0);
  });

  test('an unreadable body is reported instead of being overwritten', async () => {
    const { runner, calls } = makeRunner([
      okPermission(),
      { status: 1, stdout: '', stderr: 'Could not resolve to a PullRequest', error: null },
    ]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLinkedIssues(87, { add: [71] }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /cannot read the body of pull request #87/);
    assert.equal(calls.length, 2, 'no edit runs on a body that could not be read');
    assert.equal(argvStartingWith(calls.map((call) => call.argv), 'pr', 'edit'), undefined);
  });
});

// ---------------------------------------------------------------------------
// S2 (D4, D5): only the lines that really declare a closing issue may change,
// and a merge refuses rather than sending facts GitHub never confirmed or a
// message the reader cleared.
// ---------------------------------------------------------------------------
describe('merge and the body edit fail closed on missing facts', () => {
  test('a fenced Closes example survives the removal of the real closing line', async () => {
    const body = 'Intro\n```text\nCloses #12\n```\nCloses #12\nKeep me';
    const { runner, calls } = makeRunner([okPermission(), okJson(JSON.stringify({ body })), okJson('')]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLinkedIssues(87, { remove: [12] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, true);
    const written = calls[2].argv[calls[2].argv.indexOf('--body') + 1];
    assert.equal(written, 'Intro\n```text\nCloses #12\n```\nKeep me',
      'the example inside the fence is code, so it is untouched');
  });

  test('a fenced Closes line is not a declaration, so the same number is added for real', async () => {
    const body = 'Example:\n~~~\nCloses #71\n~~~';
    const { runner, calls } = makeRunner([okPermission(), okJson(JSON.stringify({ body })), okJson('')]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLinkedIssues(87, { add: [71] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, true);
    const written = calls[2].argv[calls[2].argv.indexOf('--body') + 1];
    assert.equal(written, `${body}\nCloses #71\n`, 'the real declaration is appended after the fence');
  });

  test('an unclosed fence keeps every later closing line untouched', async () => {
    const body = '```\nCloses #12\nmore code';
    const { runner, calls } = makeRunner([okPermission(), okJson(JSON.stringify({ body }))]);
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.editLinkedIssues(87, { remove: [12] }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, false, 'nothing outside the fence declares #12');
    assert.equal(calls.length, 2, 'no edit child runs for a body that changes nothing');
  });

  test('merge refuses a metadata read that never carried the draft state', async () => {
    const { runner, calls } = makeRunner(okJson(JSON.stringify({
      data: {
        repository: {
          viewerPermission: 'WRITE',
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } },
        },
      },
    })));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.mergePullRequest(87, { method: 'merge' }, PINNED);

    assert.equal(res.ok, false, 'a missing draft fact is never read as "not a draft"');
    assert.match(String(res.error), /the draft state is missing/);
    assert.equal(argvStartingWith(calls.map((call) => call.argv), 'pr', 'merge'), undefined);
  });

  test('a cleared description is sent empty and a cleared commit message is refused', async () => {
    const fake = pullRequestGraphql({ merge: true, squash: false, rebase: false });
    ghPrs.setGhRunner(fake.runner);

    const cleared = await ghPrs.mergePullRequest(87, { method: 'merge', subject: 'Merge it', body: '' }, PINNED);

    assert.equal(cleared.ok, true, cleared.error);
    assert.deepEqual(argvStartingWith(fake.calls, 'pr', 'merge'),
      ['pr', 'merge', '87', '--merge', '--subject', 'Merge it', '--body', ''],
      'an explicitly cleared description reaches gh as empty');

    const blank = pullRequestGraphql({ merge: true, squash: false, rebase: false });
    ghPrs.setGhRunner(blank.runner);
    const refused = await ghPrs.mergePullRequest(87, { method: 'merge', subject: '   ', body: 'kept' }, PINNED);

    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /the merge commit message must not be empty/);
    assert.equal(blank.calls.length, 0, 'the refusal happens before any child runs');
  });

  test('rebase ignores both fields, cleared or not', async () => {
    const fake = pullRequestGraphql({ merge: false, squash: false, rebase: true });
    ghPrs.setGhRunner(fake.runner);

    const res = await ghPrs.mergePullRequest(87, { method: 'rebase', subject: '', body: '' }, PINNED);

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(argvStartingWith(fake.calls, 'pr', 'merge'), ['pr', 'merge', '87', '--rebase']);
  });
});

// ---------------------------------------------------------------------------
// S5 (T4's read): ONE aliased GraphQL answers the rail's two buckets with their
// EXACT match counts, so the header's `n pr` is never a count of the rows it
// happened to fetch.
// ---------------------------------------------------------------------------
describe('listRailPullRequests: one aliased read', () => {
  test('the rail read asks twice in one request and reports exact counts', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-rail.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.listRailPullRequests(PINNED);

    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 1, 'ONE gh child');
    const query = queryOf(calls[0]);
    assert.match(query, /mine: search\(query: "repo:octo\/repo is:pr is:open author:@me sort:updated-desc"/);
    assert.match(query, /review: search\(query: "repo:octo\/repo is:pr is:open review-requested:@me sort:updated-desc"/);
    assert.match(query, /issueCount/);
    assert.match(query, /closingIssuesReferences/);
    assert.deepEqual(res.counts, { mine: 3, review: 1 });
    assert.deepEqual(res.mine, [
      { number: 87, linkedIssues: [14, 63] },
      { number: 86, linkedIssues: [] },
      { number: 85, linkedIssues: [70] },
    ]);
    assert.deepEqual(res.review, [{ number: 86, linkedIssues: [] }]);
  });

  test('an invalid window is refused without a child', async () => {
    const { runner, calls } = makeRunner(okJson('{}'));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.listRailPullRequests({ first: 0 }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /invalid first 0: want an integer 1\.\.100/);
    assert.equal(calls.length, 0);
  });

  test('a missing alias, a malformed count and a numberless node all fail closed', async () => {
    const shapes = [
      JSON.stringify({ data: { mine: { issueCount: 0, nodes: [] } } }),
      JSON.stringify({ data: { mine: { issueCount: 'x', nodes: [] }, review: { issueCount: 0, nodes: [] } } }),
      JSON.stringify({ data: { mine: { issueCount: 1, nodes: [{ number: 0 }] }, review: { issueCount: 0, nodes: [] } } }),
    ];
    for (const stdout of shapes) {
      const { runner } = makeRunner(okJson(stdout));
      ghPrs.setGhRunner(runner);
      const res = await ghPrs.listRailPullRequests(PINNED);
      assert.equal(res.ok, false, `${stdout} is refused`);
      assert.ok(String(res.error).length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// invariant 6: the identity the panel displayed is pinned and validated, and a
// call whose pin the live environment cannot honour fails closed before any
// child runs. The checkout scope itself is resolved by the caller (the issue
// client owns that read; a `lib/` module may not pull it), so a call without a
// pin runs gh in the named checkout and lets gh resolve.
// ---------------------------------------------------------------------------
describe('repository identity pinning', () => {
  const roots = [];
  after(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd, args) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  }

  // A real fork checkout, only so a case can prove the pin does not depend on
  // what that checkout's remotes currently say. gh's own `repo view` answers
  // the BASE repository of a fork.
  function makeCheckout() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-prs-scope-')));
    roots.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['commit', '--allow-empty', '-m', 'init']);
    git(dir, ['remote', 'add', 'origin', 'git@github.com:myfork/project.git']);
    git(dir, ['remote', 'add', 'upstream', 'git@github.com:original/project.git']);
    return dir;
  }

  // gh's own behavior: `repo view` answers the BASE repository of a fork, while
  // repo-scoped commands honour GH_REPO.
  function githubFake({ base = 'original/project' } = {}) {
    const calls = [];
    const runner = async (bin, argv, runOpts) => {
      const env = (runOpts && runOpts.env) || {};
      const scoped = typeof env.GH_REPO === 'string' && env.GH_REPO !== '';
      calls.push({
        bin,
        argv: argv.slice(),
        repo: scoped ? env.GH_REPO : base,
        scoped,
        cwd: runOpts ? runOpts.cwd : undefined,
      });
      if (argv[0] === 'repo' && argv[1] === 'view') return okJson(JSON.stringify({ nameWithOwner: base }));
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = queryOf({ argv });
        if (query.includes('pullRequests(')) return okJson(fixture('gh-pr-connection-page.json'));
        return okJson(fixture('gh-pr-search-page.json'));
      }
      if (argv[0] === 'pr' && argv[1] === 'view') return okJson(fixture('gh-pr-view.json'));
      return okJson('');
    };
    return { runner, calls };
  }

  test('every read and write carries the checkout fork, never the base gh resolves', async () => {
    const checkout = makeCheckout();
    const gh = githubFake();
    ghPrs.setGhRunner(gh.runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'mine' }, { cwd: checkout });

    assert.equal(res.ok, true, res.error);
    const scoped = gh.calls.filter((call) => !(call.argv[0] === 'repo' && call.argv[1] === 'view'));
    assert.ok(scoped.length > 0, 'the read reached gh');
    for (const call of scoped) assert.equal(call.repo, 'github.com/myfork/project');
    assert.ok(gh.calls.every((call) => call.cwd === checkout), 'every child runs in the named checkout');
    const searches = gh.calls.flatMap((call) => call.argv).filter((value) => value.startsWith('search=repo:'));
    assert.equal(searches[0], 'search=repo:myfork/project is:pr is:open author:@me sort:updated-desc');
    assert.ok(!gh.calls.some((call) => call.argv.some((value) => String(value).includes('original/project'))),
      'no call is scoped to the upstream base');
  });

  test('a pinned identity keeps reads and writes on the displayed repository after the remote moved', async () => {
    const checkout = makeCheckout();
    const gh = githubFake();
    ghPrs.setGhRunner(gh.runner);
    const pin = 'github.com/myfork/project';
    git(checkout, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);

    const res = await ghPrs.getPullRequestPage({ bucket: 'mine' }, { cwd: checkout, scope: pin });

    assert.equal(res.ok, true, res.error);
    assert.ok(gh.calls.length > 0);
    for (const call of gh.calls) assert.equal(call.repo, pin, 'the pin answers, never the moved remote');
    const searches = gh.calls.flatMap((call) => call.argv).filter((value) => value.startsWith('search=repo:'));
    assert.equal(searches[0], 'search=repo:myfork/project is:pr is:open author:@me sort:updated-desc');

    const comment = await ghPrs.commentPullRequest(87, 'hello', { cwd: checkout, scope: pin });

    assert.equal(comment.ok, true, comment.error);
    assert.equal(gh.calls.find((call) => call.argv[0] === 'pr' && call.argv[1] === 'comment').repo, pin);
    assert.ok(!gh.calls.some((call) => call.repo.includes('otherfork')), 'nothing reached the new remote');
  });

  test('a pin the live environment cannot honour is refused before any child runs', async () => {
    const checkout = makeCheckout();
    const gh = githubFake();
    ghPrs.setGhRunner(gh.runner);
    const env = { ...process.env, GH_HOST: 'acme.ghe.com' };

    const read = await ghPrs.getPullRequestPage(
      { bucket: 'mine' }, { cwd: checkout, scope: 'github.com/myfork/project', env },
    );
    const close = await ghPrs.closePullRequest(87, { cwd: checkout, scope: 'github.com/myfork/project', env });
    const merged = await ghPrs.mergePullRequest(87, { method: 'merge' }, {
      cwd: checkout, scope: 'github.com/myfork/project', env,
    });

    assert.equal(read.ok, false, 'the pin is refused, never redirected');
    assert.match(String(read.error), /GH_HOST selects acme\.ghe\.com/);
    assert.equal(close.ok, false);
    assert.equal(merged.ok, false);
    assert.equal(gh.calls.length, 0, 'no gh command ran for a redirectable pin');
  });

  test('an ambient GH_REPO never overrides the pinned identity', async () => {
    const checkout = makeCheckout();
    const gh = githubFake();
    ghPrs.setGhRunner(gh.runner);

    const res = await ghPrs.getPullRequestPage(
      { bucket: 'mine' },
      { cwd: checkout, scope: 'github.com/myfork/project', env: { ...process.env, GH_REPO: 'ambient/other' } },
    );

    assert.equal(res.ok, true, res.error);
    assert.ok(gh.calls.length > 0);
    assert.ok(gh.calls.every((call) => call.repo === 'github.com/myfork/project'),
      'every call carries the pin, never the ambient GH_REPO');
  });

  test('a checkout whose remote moved somewhere unprovable fails closed, and the pin still answers', async () => {
    const checkout = makeCheckout();
    const gh = githubFake();
    ghPrs.setGhRunner(gh.runner);
    const first = await ghPrs.getPullRequestPage({ bucket: 'mine' }, { cwd: checkout });
    assert.equal(first.ok, true, first.error);

    git(checkout, ['remote', 'set-url', 'origin', '/srv/git/project.git']);
    const before = gh.calls.length;

    const close = await ghPrs.closePullRequest(87, { cwd: checkout });

    assert.equal(close.ok, false, 'a write never falls back to gh base resolution');
    assert.match(String(close.error), /local path, not a GitHub repository/);
    assert.equal(gh.calls.length, before, 'the write is refused before any child runs');

    const pinned = await ghPrs.getPullRequestPage(
      { bucket: 'mine' }, { cwd: checkout, scope: 'github.com/myfork/project' },
    );
    assert.equal(pinned.ok, true, 'the identity already displayed still answers reads');
    assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/myfork/project'));
  });

  test('a pin naming a server that is not GitHub fails closed', async () => {
    const gh = githubFake();
    ghPrs.setGhRunner(gh.runner);

    const res = await ghPrs.getPullRequestPage({ bucket: 'mine' }, { scope: 'gitlab.com/myfork/project', env: {} });

    assert.equal(res.ok, false);
    assert.match(String(res.error), /not a GitHub host/);
    assert.equal(gh.calls.length, 0, 'no gh command runs for an unprovable host');
  });

  test('the module never builds a shell string for gh', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gh-prs.js'), 'utf8');
    assert.ok(!/exec\s*\(\s*['"`]/.test(src), 'no child_process.exec with a shell string');
    assert.ok(!/\bexecSync\s*\(/.test(src), 'no child_process.execSync');
    assert.ok(!/shell\s*:\s*true/.test(src), 'no shell:true spawn option');
    assert.ok(!/\bspawnSync\s*\(/.test(src), 'the host event loop is never blocked');
  });
});

// ---------------------------------------------------------------------------
// The client is a factory over the INJECTED issue module, so the extension owns
// the single instance of that module and this one only borrows its seams.
// ---------------------------------------------------------------------------
describe('createPrsClient over an injected issue module', () => {
  test('the injected module supplies the seams the client calls', async () => {
    const calls = [];
    const injected = {
      setGhRunner(fn) { injected.injectedRunner = fn; },
      normalizeScopeIdentity: () => ({ ok: false, error: 'is on a server this client refuses' }),
      runGh: async (argv) => {
        calls.push(argv.slice());
        return okJson(fixture('gh-pr-search-page.json'));
      },
    };
    const client = ghPrsModule.createPrsClient({ issues: injected });

    const refused = await client.getPullRequestPage({ bucket: 'mine' }, { scope: 'octo/repo' });

    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /is on a server this client refuses/);
    assert.equal(calls.length, 0, 'a refused pin spawns nothing, through the injected runGh too');

    // With a loader that accepts the pin, the reads travel through the injected
    // `runGh` (the module's own child seam) and the injected `setGhRunner`.
    const client2 = ghPrsModule.createPrsClient({
      issues: {
        ...injected,
        normalizeScopeIdentity: () => ({
          ok: true, host: 'github.com', nameWithOwner: 'octo/repo', identity: 'github.com/octo/repo',
        }),
      },
    });
    const injectedRunner = () => Promise.resolve(okJson(''));
    client2.setGhRunner(injectedRunner);
    assert.equal(injected.injectedRunner, injectedRunner, 'the client forwards its runner to the injected module');

    const page = await client2.getPullRequestPage({ bucket: 'mine' }, { scope: 'octo/repo' });
    assert.equal(page.ok, true, page.error);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['api', 'graphql']);
  });
  test('a client whose module exports no such seam falls back to the local copy', async () => {
    const calls = [];
    let clientRunner = null;
    const client = ghPrsModule.createPrsClient({
      issues: {
        setGhRunner(fn) { clientRunner = fn; },
        runGh: async (argv) => {
          calls.push(argv.slice());
          if (argv[0] === 'repo' && argv[1] === 'view') {
            return okJson(JSON.stringify({ nameWithOwner: 'octo/repo' }));
          }
          return okJson(fixture('gh-pr-search-page.json'));
        },
      },
    });

    // `scope: null` asks for gh's OWN answer, which the local fallback reads
    // with the same `gh repo view` child the issue client runs.
    const res = await client.getPullRequestPage({ bucket: 'mine' }, { scope: null });

    assert.equal(res.ok, true, res.error);
    assert.deepEqual(calls[0], ['repo', 'view', '--json', 'nameWithOwner']);
    assert.equal(fieldOf({ argv: calls[1] }, 'search'),
      'repo:octo/repo is:pr is:open author:@me sort:updated-desc');
    client.setGhRunner(null);
    assert.equal(clientRunner, null, 'the local seam still forwards to the injected module');
  });
});

// ---------------------------------------------------------------------------
// Every failure shape is `{ ok: false }`, never a throw.
// ---------------------------------------------------------------------------
describe('failure shapes: nothing throws', () => {
  test('a missing gh CLI fails closed on every read and write', async () => {
    const { runner } = makeRunner({ status: null, stdout: '', stderr: '', error: 'spawn gh ENOENT: gh CLI is not available' });
    ghPrs.setGhRunner(runner);

    const results = [
      await ghPrs.getPullRequestPage({ bucket: 'mine' }, PINNED),
      await ghPrs.getPullRequestConnectionPage({}, PINNED),
      await ghPrs.getPullRequest(87, { includeMetadata: true }, PINNED),
      await ghPrs.listRailPullRequests(PINNED),
      await ghPrs.commentPullRequest(87, 'hi', PINNED),
      await ghPrs.closePullRequest(87, PINNED),
      await ghPrs.editLinkedIssues(87, { add: [71] }, PINNED),
      await ghPrs.listLabels(PINNED),
    ];

    for (const res of results) {
      assert.equal(res.ok, false);
      assert.match(String(res.error), /ENOENT/i);
    }
  });

  test('an unauthenticated gh reports the auth failure', async () => {
    const { runner } = makeRunner({ status: 1, stdout: '', stderr: 'To authenticate, please run `gh auth login`.', error: null });
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, {}, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /gh auth login/);
  });

  test('malformed JSON and an empty body fail closed', async () => {
    for (const stdout of ['not json at all{{{', '']) {
      const { runner } = makeRunner(okJson(stdout));
      ghPrs.setGhRunner(runner);
      const page = await ghPrs.getPullRequestPage({ bucket: 'mine' }, PINNED);
      const detail = await ghPrs.getPullRequest(87, {}, PINNED);
      assert.equal(page.ok, false);
      assert.equal(detail.ok, false);
      assert.ok(String(page.error).length > 0);
      assert.ok(String(detail.error).length > 0);
    }
  });

  test('a throwing or rejecting runner still answers { ok: false }', async () => {
    ghPrs.setGhRunner(() => Promise.reject(new Error('boom')));
    const rejected = await ghPrs.getPullRequestPage({ bucket: 'mine' }, PINNED);
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /boom/);

    ghPrs.setGhRunner(() => { throw new Error('sync boom'); });
    const thrown = await ghPrs.getPullRequest(87, {}, PINNED);
    assert.equal(thrown.ok, false);
    assert.match(String(thrown.error), /sync boom/);
  });

  test('a non-integer pull request number is refused without a child', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-pr-view.json')));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest('87a', { includeMetadata: true }, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /invalid pull request number "87a": want a positive integer/);
    assert.equal(calls.length, 0);
  });

  test('a pull request detail payload of the wrong shape fails closed', async () => {
    const { runner } = makeRunner(okJson('{"title":"no number here"}'));
    ghPrs.setGhRunner(runner);

    const res = await ghPrs.getPullRequest(87, {}, PINNED);

    assert.equal(res.ok, false);
    assert.match(String(res.error), /returned an unexpected shape/);
  });
});

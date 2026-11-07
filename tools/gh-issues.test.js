'use strict';
// T2 (issues-panel S1,S3): tests for the migrated lib/gh-issues.js — the only
// place that runs `gh`. CommonJS, injectable runner, fixed argv (never a shell
// string), JSON parsed, never throws. The client moved whole from the source
// package's issues panel, so its contract is pinned here unchanged.
//
// Contract under test: every call returns `{ok:true, ...}` or
// `{ok:false, error}`; the runner seam means tests never invoke the real
// `gh` — injected runners return captured REAL `gh` JSON payloads saved
// under tools/fixtures/ (captured with `gh issue list/view`, `gh label
// list`, `gh api user` and `gh repo view` in the source repository).

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ghIssues = require('../lib/gh-issues.js');

const FIXTURES = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Recorder: captures (bin, argv) and answers from a script of outcomes.
// An outcome is {status, stdout, stderr, error} like the real runner.
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

function okJson(stdout) {
  return { status: 0, stdout, stderr: '', error: null };
}

beforeEach(() => {
  ghIssues.setGhRunner(null);
});

describe('happy path over captured real gh JSON', () => {
  test('ghStatus reports the authenticated login', async () => {
    const { runner, calls } = makeRunner([
      okJson(fixture('gh-api-user.json')),
      okJson(fixture('gh-repo-view.json')),
    ]);
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.ghStatus();
    assert.equal(res.ok, true);
    assert.equal(res.login, 'jonasotoaguilar');
    assert.equal(res.nameWithOwner, 'jonasotoaguilar/herdr-gentle-shell');
    assert.equal(calls[0].bin, 'gh');
    assert.deepEqual(calls[0].argv, ['api', 'user']);
  });

  test('repoInfo reports nameWithOwner and viewer', async () => {
    const { runner } = makeRunner([
      okJson(fixture('gh-repo-view.json')),
      okJson(fixture('gh-api-user.json')),
    ]);
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.repoInfo();
    assert.equal(res.ok, true);
    assert.equal(res.nameWithOwner, 'jonasotoaguilar/herdr-gentle-shell');
    assert.equal(res.viewer, 'jonasotoaguilar');
  });

  test('listIssues normalizes the captured list payload', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-issue-list.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: 'author:@me', page: 1, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.equal(res.page, 1);
    assert.equal(res.pageSize, 30);
    assert.ok(res.total >= 1);
    assert.equal(res.issues.length, res.total);
    const issue = res.issues[0];
    assert.equal(issue.number, 76);
    assert.equal(issue.state, 'open');
    assert.equal(issue.author, 'jonasotoaguilar');
    assert.ok(Array.isArray(issue.labels));
    assert.equal(typeof issue.commentsCount, 'number');
    assert.equal(typeof issue.reactions.total, 'number');
    assert.equal(typeof issue.url, 'string');
    assert.equal(typeof issue.body, 'string');
    assert.equal(calls[0].bin, 'gh');
    assert.ok(calls[0].argv.includes('issue'));
    assert.ok(calls[0].argv.includes('list'));
  });

  test('getIssue returns the issue with normalized comments', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-issue-view.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(76);
    assert.equal(res.ok, true);
    assert.equal(res.issue.number, 76);
    assert.equal(res.issue.state, 'open');
    assert.ok(Array.isArray(res.comments));
    assert.deepEqual(calls[0].argv.slice(0, 3), ['issue', 'view', '76']);
    assert.ok(calls[0].argv.includes('--json'));
  });

  test('listLabels normalizes the captured label payload', async () => {
    const { runner } = makeRunner(okJson(fixture('gh-label-list.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listLabels();
    assert.equal(res.ok, true);
    assert.ok(res.labels.length >= 1);
    assert.equal(typeof res.labels[0].name, 'string');
    assert.ok('color' in res.labels[0]);
    assert.ok('description' in res.labels[0]);
  });

  test('createLabel posts name, color and description', async () => {
    const { runner, calls } = makeRunner(okJson('{"name":"triage"}'));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.createLabel({ name: 'triage', color: 'FBCA04', description: 'needs triage' });
    assert.equal(res.ok, true);
    assert.equal(res.label.name, 'triage');
    assert.deepEqual(calls[0].argv.slice(0, 3), ['label', 'create', 'triage']);
    assert.ok(calls[0].argv.includes('--color'));
    assert.ok(calls[0].argv.includes('FBCA04'));
  });

  test('editLabels passes add and remove label flags', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.editLabels(76, { add: ['bug'], remove: ['wontfix'] });
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0].argv.slice(0, 3), ['issue', 'edit', '76']);
    assert.ok(calls[0].argv.includes('--add-label'));
    assert.ok(calls[0].argv.includes('bug'));
    assert.ok(calls[0].argv.includes('--remove-label'));
    assert.ok(calls[0].argv.includes('wontfix'));
  });

  test('commentIssue passes the body as one argv element', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.commentIssue(76, 'looks good to me');
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0].argv.slice(0, 3), ['issue', 'comment', '76']);
    assert.ok(calls[0].argv.includes('--body'));
    assert.ok(calls[0].argv.includes('looks good to me'));
  });

  test('setIssueState closes and reopens', async () => {
    const { runner, calls } = makeRunner([okJson(''), okJson('')]);
    ghIssues.setGhRunner(runner);
    const closed = await ghIssues.setIssueState(76, 'closed');
    assert.equal(closed.ok, true);
    assert.deepEqual(calls[0].argv, ['issue', 'close', '76']);
    const opened = await ghIssues.setIssueState(76, 'open');
    assert.equal(opened.ok, true);
    assert.deepEqual(calls[1].argv, ['issue', 'reopen', '76']);
  });
});

describe('failure shapes: nothing throws', () => {
  test('missing gh binary (ENOENT) fails closed on every read call', async () => {
    const { runner } = makeRunner({ status: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' });
    ghIssues.setGhRunner(runner);
    for (const res of [
      await ghIssues.ghStatus(),
      await ghIssues.repoInfo(),
      await ghIssues.listIssues({ page: 1, pageSize: 10 }),
      await ghIssues.getIssue(1),
      await ghIssues.listLabels(),
    ]) {
      assert.equal(res.ok, false);
      assert.match(String(res.error), /ENOENT/i);
    }
  });

  test('unauthenticated gh reports the auth failure', async () => {
    const { runner } = makeRunner({
      status: 1, stdout: '', stderr: 'To authenticate, please run `gh auth login`.', error: null,
    });
    ghIssues.setGhRunner(runner);
    const status = await ghIssues.ghStatus();
    assert.equal(status.ok, false);
    assert.match(String(status.error), /gh auth login/);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(list.ok, false);
    assert.match(String(list.error), /gh auth login/);
  });

  test('empty result reads as an empty list, not an error', async () => {
    const { runner } = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(runner);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 30 });
    assert.equal(list.ok, true);
    assert.deepEqual(list.issues, []);
    assert.equal(list.total, 0);
    const labels = await ghIssues.listLabels();
    assert.equal(labels.ok, true);
    assert.deepEqual(labels.labels, []);
  });

  test('malformed JSON fails closed', async () => {
    const { runner } = makeRunner(okJson('this is not json{{{'));
    ghIssues.setGhRunner(runner);
    for (const res of [
      await ghIssues.listIssues({ page: 1, pageSize: 10 }),
      await ghIssues.getIssue(1),
      await ghIssues.listLabels(),
      await ghIssues.ghStatus(),
    ]) {
      assert.equal(res.ok, false);
      assert.ok(String(res.error).length > 0);
    }
  });

  test('empty body fails closed', async () => {
    const { runner } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(list.ok, false);
    assert.ok(String(list.error).length > 0);
  });

  test('a throwing or rejecting runner still returns {ok:false}', async () => {
    ghIssues.setGhRunner(() => Promise.reject(new Error('boom')));
    const rejected = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /boom/);
    ghIssues.setGhRunner(() => { throw new Error('sync boom'); });
    const thrown = await ghIssues.getIssue(1);
    assert.equal(thrown.ok, false);
    assert.match(String(thrown.error), /sync boom/);
  });

  test('non-zero exit on a write call reports the stderr', async () => {
    const { runner } = makeRunner({ status: 1, stdout: '', stderr: 'Could not resolve to an Issue', error: null });
    ghIssues.setGhRunner(runner);
    const edited = await ghIssues.editLabels(999999, { add: ['bug'], remove: [] });
    assert.equal(edited.ok, false);
    assert.match(String(edited.error), /Could not resolve/);
    const commented = await ghIssues.commentIssue(999999, 'hi');
    assert.equal(commented.ok, false);
    const state = await ghIssues.setIssueState(999999, 'closed');
    assert.equal(state.ok, false);
    const created = await ghIssues.createLabel({ name: 'x' });
    assert.equal(created.ok, false);
  });

  test('invalid inputs fail closed without running gh', async () => {
    const { runner, calls } = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(runner);
    assert.equal((await ghIssues.getIssue('abc')).ok, false);
    assert.equal((await ghIssues.commentIssue(1, '')).ok, false);
    assert.equal((await ghIssues.commentIssue(1, '   ')).ok, false);
    assert.equal((await ghIssues.setIssueState(1, 'bogus')).ok, false);
    assert.equal((await ghIssues.createLabel({ name: '' })).ok, false);
    assert.equal(calls.length, 0);
  });
});

describe('paging', () => {
  function manyIssues(n) {
    const items = [];
    for (let i = 1; i <= n; i += 1) {
      items.push({
        number: i, title: `issue ${i}`, state: 'OPEN', stateReason: '',
        author: { login: 'someone' }, labels: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
        comments: [], reactionGroups: [],
        url: `https://example.test/issues/${i}`, body: '',
      });
    }
    return JSON.stringify(items);
  }

  test('pages slice the in-memory fetch: page 3 of 65 at size 30', async () => {
    const { runner, calls } = makeRunner(okJson(manyIssues(65)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: '', page: 3, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 65);
    assert.equal(res.page, 3);
    assert.equal(res.pageSize, 30);
    assert.equal(res.issues.length, 5);
    assert.equal(res.issues[0].number, 61);
    // The fetch asks gh for a bounded superset, never an offset flag.
    const limitAt = calls[0].argv.indexOf('--limit');
    assert.ok(limitAt >= 0);
    assert.ok(Number(calls[0].argv[limitAt + 1]) >= 65);
    assert.ok(!calls[0].argv.includes('--offset'));
    assert.ok(!calls[0].argv.includes('--page'));
  });

  test('truncated is set exactly when the fetch bound is reached', async () => {
    function manyIssues(n) {
      const items = [];
      for (let i = 1; i <= n; i += 1) {
        items.push({
          number: i, title: `issue ${i}`, state: 'OPEN', stateReason: '',
          author: { login: 'someone' }, labels: [],
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
          comments: [], reactionGroups: [],
          url: `https://example.test/issues/${i}`, body: '',
        });
      }
      return JSON.stringify(items);
    }
    const full = makeRunner(okJson(manyIssues(5)));
    ghIssues.setGhRunner(full.runner);
    const reached = await ghIssues.listIssues({ page: 1, pageSize: 5 }, { fetchMax: 5 });
    assert.equal(reached.ok, true);
    assert.equal(reached.truncated, true, 'fetch count reaching the bound marks truncation');
    const limitAt = full.calls[0].argv.indexOf('--limit');
    assert.equal(full.calls[0].argv[limitAt + 1], '5', 'the injectable bound drives --limit');
    const short = makeRunner(okJson(manyIssues(3)));
    ghIssues.setGhRunner(short.runner);
    const notReached = await ghIssues.listIssues({ page: 1, pageSize: 5 }, { fetchMax: 5 });
    assert.equal(notReached.ok, true);
    assert.ok(!notReached.truncated, 'a short fetch carries no truncation marker');
  });

  test('a page past the end reads as empty, not an error', async () => {
    const { runner } = makeRunner(okJson(manyIssues(10)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: '', page: 4, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.issues, []);
    assert.equal(res.total, 10);
  });
});

describe('listAllOpenIssues: cursor pagination of the whole open set', () => {
  function pageNode(number) {
    return {
      number,
      title: `issue ${number}`,
      state: 'OPEN',
      stateReason: '',
      author: { login: 'octo' },
      labels: { nodes: [] },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      url: `https://example.test/issues/${number}`,
      comments: { totalCount: 0 },
      reactionGroups: [],
    };
  }

  function page(numbers, { totalCount = numbers.length, hasNextPage = false, endCursor = null } = {}) {
    return okJson(JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount,
            pageInfo: { hasNextPage, endCursor },
            nodes: numbers.map(pageNode),
          },
        },
      },
    }));
  }

  const repoView = okJson('{"nameWithOwner":"octo/repo"}\n');
  const numbers = (from, to) => {
    const list = [];
    for (let n = from; n <= to; n += 1) list.push(n);
    return list;
  };
  const graphqlCalls = (calls) => calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
  const variable = (call, name) => call.argv.find((entry) => entry.startsWith(`${name}=`));

  test('250 open issues take three cursor pages, one request each', async () => {
    const { runner, calls } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: 'c1' }),
      page(numbers(101, 200), { totalCount: 250, hasNextPage: true, endCursor: 'c2' }),
      page(numbers(201, 250), { totalCount: 250 }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 250, 'every open issue, from a 250-issue repository');
    assert.equal(res.total, 250);
    assert.equal(res.pages, 3);
    assert.equal(calls.length, 4, 'one repository lookup plus one request per page');
    const pages = graphqlCalls(calls);
    assert.equal(pages.length, 3);
    for (const call of pages) {
      assert.equal(variable(call, 'owner'), 'owner=octo');
      assert.equal(variable(call, 'name'), 'name=repo');
      assert.equal(variable(call, 'first'), 'first=100');
      assert.ok(!call.argv.includes('--search'), 'server pagination, never the search API');
      const queryAt = call.argv.indexOf('-f');
      assert.ok(queryAt >= 0, 'the query travels as a raw -f field');
      const query = call.argv[queryAt + 1];
      assert.match(query, /^query=/);
      assert.match(query, /issues\(states: OPEN/);
      assert.match(query, /after: \$cursor/);
      assert.match(query, /pageInfo/);
      assert.match(query, /totalCount/);
    }
    assert.equal(variable(pages[0], 'cursor'), undefined, 'the first page starts the connection');
    assert.equal(variable(pages[1], 'cursor'), 'cursor=c1');
    assert.equal(variable(pages[2], 'cursor'), 'cursor=c2');
  });

  test('more than 600 open issues page to the end and all of them arrive', async () => {
    const script = [repoView];
    for (let start = 1; start <= 601; start += 100) {
      const end = Math.min(start + 99, 620);
      const hasNextPage = end < 620;
      script.push(page(numbers(start, end), {
        totalCount: 620,
        hasNextPage,
        endCursor: hasNextPage ? `c${end}` : null,
      }));
    }
    const { runner } = makeRunner(script);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 620, 'no fixed issue cap: the whole connection arrives');
    assert.equal(res.total, 620);
    assert.equal(res.pages, 7);
  });

  test('a repeated cursor fails the whole snapshot', async () => {
    const { runner } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: 'stuck' }),
      page(numbers(101, 200), { totalCount: 250, hasNextPage: true, endCursor: 'stuck' }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /repeated the cursor/);
  });

  test('a page carrying GraphQL errors fails the whole snapshot', async () => {
    const { runner } = makeRunner([
      repoView,
      okJson(JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] })),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /API rate limit exceeded/);
  });

  test('a terminal page short of the reported total fails: no partial snapshot', async () => {
    const { runner } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: 'c1' }),
      page(numbers(101, 200), { totalCount: 250, hasNextPage: false, endCursor: null }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /200 of 250 open issues/);
  });

  test('hasNextPage without a cursor fails instead of looping', async () => {
    const { runner } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: null }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /without a cursor/);
  });

  test('a malformed connection and an unresolved repository both fail closed', async () => {
    const malformed = makeRunner([repoView, okJson(JSON.stringify({ data: { repository: { issues: {} } } }))]);
    ghIssues.setGhRunner(malformed.runner);
    const bad = await ghIssues.listAllOpenIssues();
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /unexpected shape/);

    const noRepo = makeRunner({ status: 1, stdout: '', stderr: 'no git remotes found', error: null });
    ghIssues.setGhRunner(noRepo.runner);
    const unresolved = await ghIssues.listAllOpenIssues();
    assert.equal(unresolved.ok, false);
    assert.match(String(unresolved.error), /no git remotes found/);
  });

  test('a failing page request reports the transport error', async () => {
    const { runner } = makeRunner([
      repoView,
      { status: null, stdout: '', stderr: '', error: 'gh timed out after 30000ms' },
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /timed out/);
  });

  test('the row shape matches the list rows the rest of the client returns', async () => {
    const { runner } = makeRunner([repoView, page([7], { totalCount: 1 })]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, true);
    assert.equal(res.issues[0].number, 7);
    assert.equal(res.issues[0].state, 'open');
    assert.equal(res.issues[0].author, 'octo');
    assert.deepEqual(res.issues[0].labels, []);
    assert.equal(res.issues[0].commentsCount, 0);
    assert.equal(res.issues[0].url, 'https://example.test/issues/7');
    assert.equal(res.issues[0].body, '', 'the snapshot never asks gh for bodies');
  });
});

describe('honest totals: one bounded fetch, page sliced in memory', () => {
  function honestIssues(n) {
    const items = [];
    for (let i = 1; i <= n; i += 1) {
      items.push({
        number: i, title: `issue ${i}`, state: 'OPEN', stateReason: '',
        author: { login: 'someone' }, labels: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
        comments: [], reactionGroups: [],
        url: `https://example.test/issues/${i}`, body: `body ${i}`,
      });
    }
    return JSON.stringify(items);
  }

  test('page 1 of a 25-item set reports total 25 with 20 rows, fetched once up to the bound', async () => {
    const { runner, calls } = makeRunner(okJson(honestIssues(25)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: 'involves:@me', page: 1, pageSize: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 25, 'the total is what was fetched, never the page size');
    assert.equal(res.issues.length, 20);
    assert.equal(res.issues[0].number, 1);
    assert.equal(calls.length, 1, 'exactly one fetch for the page');
    const limitAt = calls[0].argv.indexOf('--limit');
    assert.ok(limitAt >= 0);
    assert.equal(calls[0].argv[limitAt + 1], '500', 'one fetch up to the bound, never page * pageSize');
    assert.equal(res.truncated, false);
  });

  test('page 2 of the same 25-item set reports the same total 25 with 5 rows', async () => {
    const { runner } = makeRunner(okJson(honestIssues(25)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: 'involves:@me', page: 2, pageSize: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 25, 'every page of one fetch reports the same total');
    assert.equal(res.issues.length, 5);
    assert.equal(res.issues[0].number, 21);
  });

  test('a bound-reached fetch reports truncated:true while an under-bound one reports false', async () => {
    const full = makeRunner(okJson(honestIssues(25)));
    ghIssues.setGhRunner(full.runner);
    const reached = await ghIssues.listIssues({ page: 1, pageSize: 20 }, { fetchMax: 25 });
    assert.equal(reached.ok, true);
    assert.equal(reached.total, 25);
    assert.equal(reached.truncated, true, 'a fetch that reached the bound is a lower bound');
    const limitAt = full.calls[0].argv.indexOf('--limit');
    assert.equal(full.calls[0].argv[limitAt + 1], '25', 'the injectable bound drives --limit, not the page');
    const short = makeRunner(okJson(honestIssues(24)));
    ghIssues.setGhRunner(short.runner);
    const notReached = await ghIssues.listIssues({ page: 1, pageSize: 20 }, { fetchMax: 25 });
    assert.equal(notReached.ok, true);
    assert.equal(notReached.total, 24);
    assert.equal(notReached.truncated, false, 'a short fetch is exact');
  });

  test('wholeResult returns the one bounded fetch instead of a page of it', async () => {
    const { runner, calls } = makeRunner(okJson(honestIssues(250)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ state: 'open', wholeResult: true }, { fetchMax: 251 });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'one bounded read, never one per logical page');
    assert.equal(res.issues.length, 250, 'the whole fetched result, not a page of it');
    assert.equal(res.total, 250);
    assert.equal(res.truncated, false);
  });

  test('a wholeResult fetch that fills the bound is reported truncated', async () => {
    const { runner } = makeRunner(okJson(honestIssues(45)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ state: 'open', wholeResult: true }, { fetchMax: 45 });
    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 45);
    assert.equal(res.truncated, true, 'a bound that filled proves nothing about the rest');
  });

  test('the list fetch omits body while the detail fetch keeps it', async () => {
    const { runner, calls } = makeRunner(okJson(honestIssues(3)));
    ghIssues.setGhRunner(runner);
    const listed = await ghIssues.listIssues({ page: 1, pageSize: 20 });
    assert.equal(listed.ok, true);
    const jsonAt = calls[0].argv.indexOf('--json');
    assert.ok(jsonAt >= 0);
    assert.ok(!calls[0].argv[jsonAt + 1].split(',').includes('body'), 'the list stays light: no body');
    const view = makeRunner(okJson(fixture('gh-issue-view.json')));
    ghIssues.setGhRunner(view.runner);
    const detail = await ghIssues.getIssue(76);
    assert.equal(detail.ok, true);
    const detailAt = view.calls[0].argv.indexOf('--json');
    assert.ok(view.calls[0].argv[detailAt + 1].split(',').includes('body'), 'the detail pane keeps body');
  });
});

describe('proof of a missing issue (S7d)', () => {
  test('issue-specific "could not resolve to an Issue" is proof', async () => {
    const { runner } = makeRunner({
      status: 1,
      stdout: '',
      stderr: 'GraphQL: Could not resolve to an Issue with the number of 999. (repository.issue)',
      error: null,
    });
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(999);
    assert.equal(res.ok, false);
    assert.equal(res.notFound, true);
  });

  test('a repository-level "Not Found (HTTP 404)" is not proof', async () => {
    const { runner } = makeRunner({
      status: 1,
      stdout: '',
      stderr: 'HTTP 404: Not Found (https://api.github.com/graphql)',
      error: null,
    });
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(999);
    assert.equal(res.ok, false);
    assert.equal(res.notFound, false, 'an inaccessible repository says nothing about this number');
  });
});

describe('argv shell safety', () => {
  test('a hostile query arrives as ONE argv element, never a command string', async () => {
    const hostile = 'hello; rm -rf / $(evil) `id` | cat /etc/passwd && echo pwned';
    const { runner, calls } = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: hostile, page: 1, pageSize: 10 });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    const { bin, argv } = calls[0];
    assert.equal(bin, 'gh');
    assert.ok(Array.isArray(argv));
    assert.ok(argv.every((entry) => typeof entry === 'string'));
    const searchAt = argv.indexOf('--search');
    assert.ok(searchAt >= 0);
    // The whole search string, ordering qualifier included, is still ONE
    // argv element.
    assert.equal(argv[searchAt + 1], `${hostile} sort:updated-desc`);
    // No shell join anywhere: the hostile text is one element, and no
    // element contains shell glue joining it with gh syntax.
    assert.equal(argv.filter((entry) => entry.includes('rm -rf')).length, 1);
  });

  test('a hostile comment body arrives as ONE argv element', async () => {
    const hostile = 'nice $(touch /tmp/pwned); drop it';
    const { runner, calls } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.commentIssue(7, hostile);
    assert.equal(res.ok, true);
    const bodyAt = calls[0].argv.indexOf('--body');
    assert.ok(bodyAt >= 0);
    assert.equal(calls[0].argv[bodyAt + 1], hostile);
  });

  test('the module source never builds a shell string for gh', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gh-issues.js'), 'utf8');
    assert.ok(!/exec\s*\(/.test(src), 'no child_process.exec with a shell string');
    assert.ok(!/execSync\s*\(/.test(src), 'no child_process.execSync with a shell string');
    assert.ok(!/shell\s*:\s*true/.test(src), 'no shell:true spawn option');
  });
});

describe('list ordering: the query carries it (S10)', () => {
  // Payload rows whose updatedAt rises with the number, so a JavaScript
  // re-sort by updatedAt desc would visibly change the order.
  function rowsInOrder(numbers) {
    return JSON.stringify(numbers.map((n) => ({
      number: n, title: `issue ${n}`, state: 'OPEN', stateReason: '',
      author: { login: 'someone' }, labels: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: `2026-01-0${n}T00:00:00Z`,
      comments: [], reactionGroups: [],
      url: `https://example.test/issues/${n}`, body: '',
    })));
  }

  test('asks gh for last-update ordering through the search query', async () => {
    const bare = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(bare.runner);
    await ghIssues.listIssues({ page: 1, pageSize: 10 });
    const bareAt = bare.calls[0].argv.indexOf('--search');
    assert.ok(bareAt >= 0, 'the ordering travels in the search query, not in a JS sort');
    assert.equal(bare.calls[0].argv[bareAt + 1], 'sort:updated-desc');

    const withQuery = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(withQuery.runner);
    await ghIssues.listIssues({ query: 'author:@me', page: 1, pageSize: 10 });
    const queryAt = withQuery.calls[0].argv.indexOf('--search');
    assert.equal(withQuery.calls[0].argv[queryAt + 1], 'author:@me sort:updated-desc');
  });

  test('an explicit caller sort is respected, never doubled', async () => {
    for (const query of ['sort:created-asc', 'author:@me sort:created-asc']) {
      const { runner, calls } = makeRunner(okJson('[]'));
      ghIssues.setGhRunner(runner);
      await ghIssues.listIssues({ query, page: 1, pageSize: 10 });
      const searchAt = calls[0].argv.indexOf('--search');
      const search = calls[0].argv[searchAt + 1];
      assert.equal(search, query, 'the caller sort survives verbatim');
      assert.equal((search.match(/sort:/gi) || []).length, 1, 'exactly one sort qualifier');
    }
  });

  test('rows keep the order the runner returned: no re-sort in JavaScript', async () => {
    const { runner } = makeRunner(okJson(rowsInOrder([3, 1, 2])));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.issues.map((issue) => issue.number), [3, 1, 2]);
  });
});

describe('detail assignees (adopted reference idea 1)', () => {
  test('getIssue exposes assignees from the detail payload', async () => {
    const doc = JSON.parse(fixture('gh-issue-view.json'));
    doc.assignees = [{ login: 'alice' }, { login: 'bob' }];
    const { runner, calls } = makeRunner(okJson(JSON.stringify(doc)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(76);
    assert.equal(res.ok, true);
    assert.deepEqual(res.issue.assignees, ['alice', 'bob']);
    const jsonAt = calls[0].argv.indexOf('--json');
    assert.ok(jsonAt >= 0);
    assert.ok(calls[0].argv[jsonAt + 1].split(',').includes('assignees'), 'the detail fetch asks gh for assignees');
  });

  test('getIssue defaults assignees to [] when gh omits them', async () => {
    const { runner } = makeRunner(okJson(fixture('gh-issue-view.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(76);
    assert.equal(res.ok, true);
    assert.deepEqual(res.issue.assignees, []);
  });

  test('listIssues rows keep their shape: no assignees key', async () => {
    const { runner } = makeRunner(okJson(fixture('gh-issue-list.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ page: 1, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.ok(res.issues.length >= 1);
    assert.ok(!('assignees' in res.issues[0]), 'the list row shape is unchanged');
  });
});

// ---------------------------------------------------------------------------
// Fork scope (worktree reliability S5): a fork checkout configures `origin`
// (the fork) and `upstream` (the original), and `gh repo view` resolves the
// BASE — the original — for exactly that layout. Every tab used to read the
// original's issues. The checkout's own repository is the one it pushes to, so
// resolution and every gh call are scoped to it.
//
// The remote configuration is real, isolated git configuration in a temporary
// checkout: no network, no other repository, and the injected runner models
// gh's own answers (base from `repo view`, GH_REPO for repo-scoped commands).
// ---------------------------------------------------------------------------
describe('fork scope (S5)', () => {
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

  // A real checkout whose remotes model a fork: origin (the fork) plus
  // upstream (the original), or whatever layout the case names.
  function makeCheckout({ remotes = [['origin', 'myfork/project'], ['upstream', 'original/project']], pushRemote = null } = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-fork-')));
    roots.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['commit', '--allow-empty', '-m', 'init']);
    // A bare `owner/name` becomes a GitHub URL; a full URL or a local path is
    // used verbatim, so a case can model a non-GitHub remote.
    for (const [name, repo] of remotes) {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.includes(':') || repo.startsWith('/')
        ? repo
        : `git@github.com:${repo}.git`;
      git(dir, ['remote', 'add', name, url]);
    }
    if (pushRemote) git(dir, ['config', `branch.${git(dir, ['branch', '--show-current']).trim()}.pushRemote`, pushRemote]);
    return dir;
  }

  function okJson(stdout) {
    return { status: 0, stdout, stderr: '', error: null };
  }

  // gh's own behavior: `repo view` answers the BASE repository for a fork
  // layout (probed against gh 2.102.1 with origin=fork + upstream=original),
  // while repo-scoped commands honour GH_REPO.
  function github({ base = 'original/project', fork = 'myfork/project' } = {}) {
    const calls = [];
    const runner = async (bin, argv, runOpts) => {
      const env = (runOpts && runOpts.env) || {};
      const repo = typeof env.GH_REPO === 'string' && env.GH_REPO !== '' ? env.GH_REPO : base;
      calls.push({ bin, argv: argv.slice(), repo, scoped: typeof env.GH_REPO === 'string' && env.GH_REPO !== '' });
      if (argv[0] === 'repo' && argv[1] === 'view') return okJson(JSON.stringify({ nameWithOwner: base }));
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const queryAt = argv.indexOf('-f');
        const query = queryAt >= 0 ? argv[queryAt + 1] : '';
        if (query.includes('type: ISSUE')) {
          return okJson(JSON.stringify({
            data: { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } },
          }));
        }
        if (query.includes('edges { cursor node')) {
          return okJson(JSON.stringify({
            data: { repository: { issues: {
              totalCount: 0,
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [],
            } } },
          }));
        }
        return okJson(JSON.stringify({
          data: { repository: { issues: {
            totalCount: 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          } } },
        }));
      }
      if (argv[0] === 'issue' && argv[1] === 'list') return okJson('[]');
      if (argv[0] === 'issue' && argv[1] === 'view') return okJson(fixture('gh-issue-view.json'));
      if (argv[0] === 'label' && argv[1] === 'list') return okJson('[]');
      return okJson('');
    };
    const graphqlOwner = (call) => {
      for (let at = 0; at < call.argv.length - 1; at += 1) {
        if (call.argv[at] === '-F' && call.argv[at + 1].startsWith('owner=')) return call.argv[at + 1].slice('owner='.length);
      }
      return null;
    };
    const repoScoped = calls.filter((call) => !(call.argv[0] === 'repo' && call.argv[1] === 'view'));
    return { runner, calls, repoScoped, graphqlOwner, fork };
  }

  test('every scoped tab and the All connection read the checkout fork, not the base gh resolves', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const searched = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(searched.ok, true);
    const connection = await ghIssues.getIssueConnectionPage({ first: 5 }, { cwd: checkout });
    assert.equal(connection.ok, true);

    const graphql = gh.calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
    assert.equal(graphql.length, 2, 'one search read and one connection read');
    for (const call of graphql) {
      const owner = gh.graphqlOwner(call);
      if (owner !== null) assert.equal(owner, 'myfork', 'the connection read names the fork');
      assert.ok(!call.argv.some((value) => value.includes('original/project')),
        `no read carries the upstream repository (${call.argv.join(' ')})`);
    }
    const searchField = gh.calls
      .flatMap((call) => call.argv)
      .find((value) => value.startsWith('search=repo:'));
    assert.match(searchField, /search=repo:myfork\/project is:issue is:open/, 'the scoped search names the fork');
    assert.ok(!gh.calls.some((call) => call.argv.some((value) => value.includes('repo:original/project'))),
      'no read is scoped to the upstream repo');
  });

  test('the session snapshot and margin list read the fork through GH_REPO', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const snapshot = await ghIssues.listAllOpenIssues({ cwd: checkout });
    assert.equal(snapshot.ok, true);
    const margin = await ghIssues.listIssues({ state: 'all', page: 1, pageSize: 20 }, { cwd: checkout, fetchMax: 20 });
    assert.equal(margin.ok, true);

    const list = gh.calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.ok(list, 'the margin reached gh issue list');
    // The scope is HOST-QUALIFIED: the same owner/name on another server can
    // never be reached by an environment change.
    assert.equal(list.repo, 'github.com/myfork/project', 'gh issue list is scoped to the fork, not the upstream');
    const snapshotGraphql = gh.calls.find((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
    assert.equal(gh.graphqlOwner(snapshotGraphql), 'myfork', 'the open snapshot reads the fork');
  });

  test('detail, labels and every repo-scoped write command carry the fork scope', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    assert.equal((await ghIssues.getIssue(76, { cwd: checkout })).ok, true);
    assert.equal((await ghIssues.listLabels({ cwd: checkout })).ok, true);

    const detail = gh.calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'view');
    const labels = gh.calls.find((call) => call.argv[0] === 'label' && call.argv[1] === 'list');
    assert.equal(detail.repo, 'github.com/myfork/project', 'the detail reads the fork issue');
    assert.equal(labels.repo, 'github.com/myfork/project', 'the repository labels are the fork\'s labels');
  });

  test('the branch push remote decides the fork when origin is the original', async () => {
    const checkout = makeCheckout({
      remotes: [['origin', 'original/project'], ['fork', 'myfork/project']],
      pushRemote: 'fork',
    });
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const info = await ghIssues.repoInfo({ cwd: checkout });
    assert.equal(info.ok, true);
    assert.equal(info.nameWithOwner, 'myfork/project', 'the branch push remote is the checkout\'s own repository');

    await ghIssues.listIssues({ page: 1, pageSize: 5 }, { cwd: checkout, fetchMax: 5 });
    const list = gh.calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.equal(list.repo, 'github.com/myfork/project');
  });

  test('a branch that only tracks upstream still scopes to origin, the fork', async () => {
    // The common fork clone: `origin` is the fork and the local branch tracks
    // `upstream` only to stay current, so the tracking remote is NOT the scope.
    const checkout = makeCheckout();
    const branch = git(checkout, ['branch', '--show-current']).trim();
    git(checkout, ['config', `branch.${branch}.remote`, 'upstream']);
    git(checkout, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const info = await ghIssues.repoInfo({ cwd: checkout });
    assert.equal(info.nameWithOwner, 'myfork/project', 'the tracked upstream never becomes the scope');
  });

  test('a single-remote checkout keeps gh resolution exactly, with no scope injected', async () => {
    const checkout = makeCheckout({ remotes: [['origin', 'myfork/project']] });
    const gh = github({ base: 'myfork/project', fork: 'myfork/project' });
    ghIssues.setGhRunner(gh.runner);

    const info = await ghIssues.repoInfo({ cwd: checkout });
    assert.equal(info.ok, true);
    assert.equal(info.nameWithOwner, 'myfork/project', 'gh\'s answer is unchanged');
    await ghIssues.listIssues({ page: 1, pageSize: 5 }, { cwd: checkout, fetchMax: 5 });
    const list = gh.calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.equal(list.scoped, false, 'a non-fork checkout runs gh exactly as before');
  });

  test('a repository lookup failure is reported unchanged, never masked by the fork override', async () => {
    const checkout = makeCheckout();
    const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
    const calls = [];
    ghIssues.setGhRunner(async (bin, argv, runOpts) => {
      calls.push({ argv: argv.slice(), env: (runOpts && runOpts.env) || {} });
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return { status: 1, stdout: '', stderr: 'not authenticated: run gh auth login', error: null };
      }
      return ok('[]');
    });

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, false);
    assert.match(page.error, /cannot resolve the repository: not authenticated: run gh auth login/);
    assert.ok(!calls.some((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql'),
      'a failed resolution never falls through to a scoped read');
  });

  // A head remote that cannot be PROVEN to name a GitHub repository must never
  // become GH_REPO: a guessed owner/name would send a read — or worse a write —
  // to an unrelated repository. Resolution fails closed and no gh command runs.
  test('a local or file checkout remote fails closed: no gh read or write runs', async () => {
    const checkout = makeCheckout({
      remotes: [['origin', 'file:///srv/mirror/project.git'], ['upstream', 'original/project']],
    });
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    const list = await ghIssues.listIssues({ state: 'open', page: 1, pageSize: 5 }, { cwd: checkout, fetchMax: 5 });
    const detail = await ghIssues.getIssue(7, { cwd: checkout });
    const labels = await ghIssues.listLabels({ cwd: checkout });
    const comment = await ghIssues.commentIssue(7, 'hello', { cwd: checkout });
    const close = await ghIssues.setIssueState(7, 'closed', { cwd: checkout });
    const edit = await ghIssues.editLabels(7, { add: ['bug'] }, { cwd: checkout });

    for (const outcome of [page, list, detail, labels, comment, close, edit]) {
      assert.equal(outcome.ok, false, 'the read or write is refused');
      assert.match(outcome.error, /checkout remote "origin" is a local path, not a GitHub repository/);
    }
    assert.equal(gh.calls.length, 0,
      'no gh read and no gh write ran, so nothing can be redirected to another repository');
  });

  test('a checkout remote on a non-GitHub host fails closed instead of being read as owner/name', async () => {
    const checkout = makeCheckout({
      remotes: [['origin', 'https://gitlab.com/myfork/project.git'], ['upstream', 'original/project']],
    });
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, false);
    assert.match(page.error, /checkout remote "origin" is on gitlab\.com, which is not a GitHub host/);
    const comment = await ghIssues.commentIssue(7, 'hello', { cwd: checkout });
    assert.equal(comment.ok, false, 'a write is refused too');
    assert.equal(gh.calls.length, 0, 'the GitLab path never becomes a GitHub owner/name');
  });

  test('the selected head remote is never swapped for a supported one', async () => {
    // `origin` is a valid GitHub fork, but this branch pushes to a GitLab
    // remote: the SELECTED remote decides, and its failure is final.
    const checkout = makeCheckout({
      remotes: [['origin', 'myfork/project'], ['fork', 'https://gitlab.com/myfork/project.git']],
      pushRemote: 'fork',
    });
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, false);
    assert.match(page.error, /checkout remote "fork" is on gitlab\.com/,
      'the refusal names the selected remote, never a substituted one');
    assert.equal(gh.calls.length, 0, 'the GitHub origin is not used as a fallback');
  });

  test('encoded or malformed repository identifiers are rejected', async () => {
    const cases = [
      ['https://github.com/my%20fork/project.git', 'a percent-encoded owner'],
      ['https://github.com/-bad-/project.git', 'an owner with a leading hyphen'],
      ['https://github.com/myfork/project/extra.git', 'a path with more than owner/name'],
    ];
    for (const [url, label] of cases) {
      const checkout = makeCheckout({ remotes: [['origin', url], ['upstream', 'original/project']] });
      const gh = github();
      ghIssues.setGhRunner(gh.runner);
      const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
      assert.equal(page.ok, false, label);
      assert.match(page.error, /checkout remote "origin" names an invalid GitHub repository/, label);
      assert.equal(gh.calls.length, 0, `no gh command runs for ${label}`);
    }
  });

  test('a self-hosted GitHub host is accepted only when GH_HOST names it', async () => {
    const remotes = [['origin', 'git@github.mycorp.com:myfork/project.git'], ['upstream', 'git@github.mycorp.com:original/project.git']];
    const deniedCheckout = makeCheckout({ remotes });
    const denied = await ghIssues.checkoutRepoScope({ cwd: deniedCheckout, env: { ...process.env, GH_HOST: '' } });
    assert.equal(denied.ok, false, 'a self-hosted server without GH_HOST is not consistently reachable');
    assert.match(denied.error, /gh reaches only when GH_HOST selects it/);

    // A fresh checkout: the scope answer is cached per checkout.
    const allowedCheckout = makeCheckout({ remotes });
    const allowed = await ghIssues.checkoutRepoScope({
      cwd: allowedCheckout,
      env: { ...process.env, GH_HOST: 'github.mycorp.com' },
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.nameWithOwner, 'myfork/project');
    assert.equal(allowed.identity, 'github.mycorp.com/myfork/project');
  });

  test('a single-remote checkout keeps the unchanged baseline, even for a local remote', async () => {
    const checkout = makeCheckout({ remotes: [['origin', '/srv/mirror/project.git']] });
    const gh = github({ base: 'someone/project' });
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, true, 'no scope is invented for a checkout that names one remote');
    assert.ok(gh.calls.length > 0, 'gh resolves the repository exactly as before');
    assert.ok(gh.calls.every((call) => call.scoped === false), 'no GH_REPO is injected');
  });

  // A cached scope must never outlive a changed remote: the same owner/name on
  // a different account is a different repository, and a write would land there.
  test('a changed checkout remote is picked up before the next read and the next write', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const first = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(first.ok, true);
    assert.ok(gh.calls.some((call) => call.argv.some((value) => value.includes('repo:myfork/project'))),
      'the first read targets the original fork');

    // The fork moves mid-session (a rename, a transfer, a corrected remote).
    git(checkout, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);

    const beforeWrite = gh.calls.length;
    const comment = await ghIssues.commentIssue(7, 'hello', { cwd: checkout });
    assert.equal(comment.ok, true);
    const writes = gh.calls.slice(beforeWrite);
    assert.ok(writes.length > 0, 'the write reached gh');
    for (const call of writes) {
      assert.equal(call.repo, 'github.com/otherfork/project', 'the write follows the changed remote');
    }
    assert.ok(!writes.some((call) => call.repo === 'github.com/myfork/project'), 'no write targets the old fork');

    const beforeRead = gh.calls.length;
    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, true);
    const reads = gh.calls.slice(beforeRead);
    assert.ok(reads.some((call) => call.argv.some((value) => value.includes('repo:otherfork/project'))),
      'the next read follows the changed remote');
    assert.ok(!reads.some((call) => call.argv.some((value) => value.includes('repo:myfork/project'))),
      'no read targets the old fork');
  });

  test('GH_HOST and the checkout remote must name the same server', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: checkout, env: { ...process.env, GH_HOST: 'acme.ghe.com' } },
    );
    assert.equal(page.ok, false);
    assert.match(page.error, /is on github\.com, but GH_HOST selects acme\.ghe\.com/);
    assert.equal(gh.calls.length, 0, 'the same owner/name is never sent to another server');
  });

  test('a ghe.com checkout remote requires GH_HOST and must match it', async () => {
    const remotes = [
      ['origin', 'https://acme.ghe.com/myfork/project.git'],
      ['upstream', 'https://acme.ghe.com/original/project.git'],
    ];
    const mismatched = makeCheckout({ remotes });
    const gh = github();
    ghIssues.setGhRunner(gh.runner);
    const denied = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: mismatched, env: { ...process.env, GH_HOST: 'other.ghe.com' } },
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error, /is on acme\.ghe\.com, but GH_HOST selects other\.ghe\.com/);
    assert.equal(gh.calls.length, 0);

    // Without GH_HOST, gh's API host is github.com while the repository lives
    // on the enterprise server, so the same owner/name would read two different
    // repositories. The scope fails closed instead.
    const derived = makeCheckout({ remotes });
    const derivedScope = await ghIssues.checkoutRepoScope({ cwd: derived, env: { ...process.env, GH_HOST: '' } });
    assert.equal(derivedScope.ok, false, 'an enterprise remote needs its host named');
    assert.match(derivedScope.error, /gh reaches only when GH_HOST selects it/);

    // When GH_HOST is set, it must be the same server — then the scope holds.
    const matched = makeCheckout({ remotes });
    const matchedScope = await ghIssues.checkoutRepoScope({
      cwd: matched,
      env: { ...process.env, GH_HOST: 'acme.ghe.com' },
    });
    assert.equal(matchedScope.ok, true);
    assert.equal(matchedScope.nameWithOwner, 'myfork/project');
    assert.equal(matchedScope.identity, 'acme.ghe.com/myfork/project');
  });

  test('a git resolution error fails closed instead of trusting gh base resolution', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);
    ghIssues.setGitRunner((argv) => {
      if (argv[0] === 'config') {
        return { status: null, stdout: '', stderr: '', error: 'spawn git ENOENT: git is not available' };
      }
      return { status: 0, stdout: '', stderr: '', error: null };
    });
    try {
      const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
      assert.equal(page.ok, false);
      assert.match(page.error, /cannot read this checkout's git configuration/);
      const write = await ghIssues.commentIssue(7, 'hello', { cwd: checkout });
      assert.equal(write.ok, false, 'the write is refused too');
      assert.equal(gh.calls.length, 0, 'no gh command falls back to gh base resolution');
    } finally {
      ghIssues.setGitRunner(null);
    }
  });

  test('an unexpected resolution throw fails closed', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);
    ghIssues.setGitRunner(() => {
      throw new Error('unexpected resolver failure');
    });
    try {
      const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
      assert.equal(page.ok, false);
      assert.match(page.error, /cannot resolve the checkout's own repository/);
      const write = await ghIssues.commentIssue(7, 'hello', { cwd: checkout });
      assert.equal(write.ok, false, 'the write is refused too');
      assert.equal(gh.calls.length, 0, 'a throw never degrades to gh base resolution');
    } finally {
      ghIssues.setGitRunner(null);
    }
  });

  // B1: a caller that already displayed rows from one repository passes that
  // identity explicitly, so reads and writes keep using it even after the
  // checkout's remote moves. The viewer relies on this to bind its actions.
  test('an explicit scope binds reads and writes to the displayed repository', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);
    const scope = 'myfork/project';
    git(checkout, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout, scope });
    assert.equal(page.ok, true);
    const searches = gh.calls.flatMap((call) => call.argv).filter((value) => value.startsWith('search=repo:'));
    assert.ok(searches.length > 0);
    assert.ok(searches.every((value) => value.startsWith('search=repo:myfork/project')),
      'the pinned identity answers the read, never the moved remote');

    const comment = await ghIssues.commentIssue(7, 'hello', { cwd: checkout, scope });
    assert.equal(comment.ok, true);
    const commentCall = gh.calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'comment');
    assert.equal(commentCall.repo, 'github.com/myfork/project', 'the pinned identity receives the write');
    assert.ok(!gh.calls.some((call) => call.repo === 'github.com/otherfork/project'),
      'nothing was sent to the new remote');
  });

  // B2: a config read that exits nonzero because the configuration is corrupt
  // or unreadable is NOT "no repository". It must fail closed instead of
  // falling back to gh's base resolution.
  test('a corrupt or unreadable checkout configuration fails closed', async () => {
    const checkout = makeCheckout();
    fs.appendFileSync(path.join(checkout, '.git', 'config'), '\n[broken\n');
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, false);
    assert.match(page.error, /cannot read this checkout's git configuration/);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 5 }, { cwd: checkout, fetchMax: 5 });
    assert.equal(list.ok, false, 'the list read is refused too');
    const write = await ghIssues.commentIssue(7, 'hello', { cwd: checkout });
    assert.equal(write.ok, false, 'the write is refused too');
    assert.equal(gh.calls.length, 0, 'no gh command falls back to gh base resolution');
  });

  // The distinguishable clean case: a directory that is NOT a git repository
  // stays on the unchanged baseline (gh resolves for itself).
  test('a plain directory keeps gh resolution and injects no scope', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-plain-scope-')));
    roots.push(plain);
    const gh = github({ base: 'someone/project' });
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: plain });
    assert.equal(page.ok, true, 'not a repository is not a resolution failure');
    assert.ok(gh.calls.length > 0, 'gh resolves the repository exactly as before');
    assert.ok(gh.calls.every((call) => call.scoped === false), 'no GH_REPO is injected');
  });

  // B2: the fork clone that adds the upstream under its own name and never
  // uses `origin` (remotes: upstream + myfork, branch tracking upstream). The
  // tracking remote is the BASE, so reading it as the scope listed the
  // original's issues. The only NON-BASE remote is the fork, and that is the
  // checkout's own repository.
  test('a fork with myfork and upstream, tracking upstream, scopes to myfork', async () => {
    const checkout = makeCheckout({
      remotes: [['upstream', 'original/project'], ['myfork', 'myfork/project']],
    });
    const branch = git(checkout, ['branch', '--show-current']).trim();
    git(checkout, ['config', `branch.${branch}.remote`, 'upstream']);
    git(checkout, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const info = await ghIssues.repoInfo({ cwd: checkout });
    assert.equal(info.ok, true);
    assert.equal(info.nameWithOwner, 'myfork/project', 'the tracked upstream is never the scope');
    await ghIssues.listIssues({ page: 1, pageSize: 5 }, { cwd: checkout, fetchMax: 5 });
    const list = gh.calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.equal(list.repo, 'github.com/myfork/project', 'the only non-base remote is the scope');
    assert.ok(!gh.calls.some((call) => call.repo === 'github.com/original/project'),
      'nothing reads the base repository');
  });

  // B2: two non-base remotes and no attach point is AMBIGUOUS. Guessing one
  // could read or write another fork, and the base is never chosen silently.
  test('two non-base remotes with no attach point fail closed instead of guessing', async () => {
    const checkout = makeCheckout({
      remotes: [
        ['upstream', 'original/project'],
        ['fork-a', 'forka/project'],
        ['fork-b', 'forkb/project'],
      ],
    });
    const branch = git(checkout, ['branch', '--show-current']).trim();
    git(checkout, ['config', `branch.${branch}.remote`, 'upstream']);
    git(checkout, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage({ first: 5 }, { cwd: checkout });
    assert.equal(page.ok, false, 'an ambiguous fork selection fails closed');
    assert.match(page.error, /cannot tell which checkout remote/);
    assert.match(page.error, /"fork-a", "fork-b"/);
    assert.equal(gh.calls.length, 0, 'no gh command runs for an ambiguous scope');
  });

  // B1: the pinned identity carries its HOST. A pin for github.com cannot be
  // redirected to an enterprise server by an ambient GH_HOST, and a pin that
  // ever selects another server fails closed before gh runs.
  test('a host-qualified pin fails closed when GH_HOST selects another server', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: checkout, scope: 'github.com/myfork/project', env: { GH_HOST: 'acme.ghe.com' } },
    );
    assert.equal(page.ok, false, 'the pin is refused, never redirected');
    assert.match(page.error, /GH_HOST selects acme\.ghe\.com/);
    assert.equal(gh.calls.length, 0, 'no gh command ran for the redirected pin');

    const comment = await ghIssues.commentIssue(
      7,
      'hello',
      { cwd: checkout, scope: 'github.com/myfork/project', env: { GH_HOST: 'acme.ghe.com' } },
    );
    assert.equal(comment.ok, false, 'the same refusal covers writes');
    assert.equal(gh.calls.length, 0, 'no write ran either');
  });

  test('an ambient GH_REPO cannot override the pinned identity', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: checkout, scope: 'github.com/myfork/project', env: { GH_REPO: 'ambient/other' } },
    );
    assert.equal(page.ok, true);
    assert.ok(gh.calls.length > 0);
    assert.ok(gh.calls.every((call) => call.repo === 'github.com/myfork/project'),
      'every call carries the pin, never the ambient GH_REPO');
  });

  test('a pin naming a server that is not GitHub fails closed', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const page = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: checkout, scope: 'gitlab.com/myfork/project', env: {} },
    );
    assert.equal(page.ok, false);
    assert.match(page.error, /not a GitHub host/);
    assert.equal(gh.calls.length, 0, 'no gh command runs for an unprovable host');
  });

  // B1: an enterprise pin is only consistent when GH_HOST names its server,
  // because gh api/GraphQL (searches and connections) use the default host.
  test('an enterprise pin needs GH_HOST, and then travels host-qualified', async () => {
    const checkout = makeCheckout();
    const gh = github();
    ghIssues.setGhRunner(gh.runner);

    const denied = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: checkout, scope: 'acme.ghe.com/myfork/project', env: {} },
    );
    assert.equal(denied.ok, false, 'an enterprise pin without GH_HOST fails closed');
    assert.match(denied.error, /gh reaches only when GH_HOST selects it/);
    assert.equal(gh.calls.length, 0);

    const allowed = await ghIssues.getIssuePage(
      { first: 5 },
      { cwd: checkout, scope: 'acme.ghe.com/myfork/project', env: { GH_HOST: 'acme.ghe.com' } },
    );
    assert.equal(allowed.ok, true, 'the matching host is accepted');
    assert.ok(gh.calls.length > 0);
    assert.ok(gh.calls.every((call) => call.repo === 'acme.ghe.com/myfork/project'),
      'every call carries the enterprise host');
  });
});

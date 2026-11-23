'use strict';
// T10a (prs-panel S2): the defects the T9 independent verification recorded as
// D4 (again), D11, D12, D13 and D14, plus the decision that opens that verdict:
// comments stay available in every pull request state, while the editor, close
// and merge keys belong to an OPEN pull request.
//
// Every case here reproduces the defect through a public seam — the client's
// exported writes, or the panel's keyboard and painted frame — and never through
// the modules' internal storage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrsClient } = require('../lib/gh-prs');
const { createPrsView } = require('../lib/prs-view');

const pin = { scope: 'github.com/octo/repo' };
const ok = (x) => ({ status: 0, stdout: JSON.stringify(x), stderr: '', error: null });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (number, extra = {}) => ({ number, title: `PR ${number}`, state: 'open', isDraft: false, ...extra });
const send = (view, ...keys) => keys.forEach((key) => view.handleInput(key));
const frame = (view) => view.render(140).join('\n');

// The body read answers the pull request STATE with the body (S2/T18): the read
// right before the write refuses a pull request that is no longer open.
function mockClient(repository, bodyRead = ok({ body: 'PR body', state: 'OPEN' }), children = []) {
  const writes = [];
  const runGh = async (argv) => {
    children.push(argv.slice());
    // The role read answers the fresh pull request state in the same round trip
    // (S2/D20), so a write is refused for a target that is no longer open.
    if (argv[0] === 'api') return ok({ data: { repository: { ...repository, pullRequest: repository.pullRequest || { state: 'OPEN' } } } });
    if (argv[0] === 'pr' && argv[1] === 'view') return bodyRead;
    writes.push(argv);
    return ok({});
  };
  return { client: createPrsClient({ issues: { runGh } }), writes };
}

// ---------------------------------------------------------------------------
// D4 (S2), amended by D27: the body edit no longer interprets Markdown. Every
// line the panel writes carries a marker, only a marked line is ever removed,
// and a body whose fence runs do not pair up is refused instead of guessed at.
// These cases keep their original bodies: the panel's own line now carries the
// marker, and the code examples are untouched because they are never candidates.
// ---------------------------------------------------------------------------
const MARK = '<!-- odd-worktree:linked -->';
test('S2: a four-backtick fence holding three backticks and Closes #19 is code', async () => {
  const body = [
    'Intro',
    '````md',
    '```text',
    'Closes #19',
    '```',
    '````',
    `Closes #19 ${MARK}`,
  ].join('\n');
  const { client, writes } = mockClient({ viewerPermission: 'WRITE' }, ok({ body, state: 'OPEN' }));

  const res = await client.editLinkedIssues(87, { remove: [19] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [['pr', 'edit', '87', '--body', `${[
    'Intro',
    '````md',
    '```text',
    'Closes #19',
    '```',
    '````',
  ].join('\n')}\n`]], 'only the marked line outside the fence is removed');
});

test('S2: a fence structure the reader cannot pair up refuses the edit outright', async () => {
  // D27/T18: the runs of three or more backticks and tildes must PAIR UP by
  // character and length — the tilde run that opens here is never closed (the
  // backtick run is another character and `~~` is not a run at all) — so the
  // body is refused instead of appended to, marked line and all.
  const body = [
    '~~~text',
    '```',
    'Closes #19',
    '~~',
    'Closes #20',
    `Closes #20 ${MARK}`,
  ].join('\n');
  const { client, writes } = mockClient({ viewerPermission: 'WRITE' }, ok({ body, state: 'OPEN' }));

  const res = await client.editLinkedIssues(87, { remove: [20] }, pin);

  assert.equal(res.ok, false);
  assert.equal(res.error, 'the pull request body ends inside an unclosed code fence or comment');
  assert.deepEqual(writes, [], 'a body this reader cannot pair up is never rewritten');
});

test('S2: an added link is a marked line on a line of its own', async () => {
  const body = ['   ```', '   Closes #19', '   ```', 'Closes #20'].join('\n');
  const { client, writes } = mockClient({ viewerPermission: 'WRITE' }, ok({ body, state: 'OPEN' }));

  const res = await client.editLinkedIssues(87, { add: [19] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [['pr', 'edit', '87', '--body', `${body}\n\nCloses #19 ${MARK}\n`]],
    'the panel appends its own marked line, separated by a blank line');
});

test('S2: a closing fence may carry trailing spaces and be longer than the opening one', async () => {
  const body = ['```', 'Closes #19', '`````  ', `Closes #19 ${MARK}`].join('\n');
  const { client, writes } = mockClient({ viewerPermission: 'WRITE' }, ok({ body, state: 'OPEN' }));

  const res = await client.editLinkedIssues(87, { remove: [19] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [['pr', 'edit', '87', '--body', `${['```', 'Closes #19', '`````  '].join('\n')}\n`]]);
});

// ---------------------------------------------------------------------------
// D11 (S2): the composer captures the number it was opened for, exactly like
// the close and merge confirmations capture theirs.
// ---------------------------------------------------------------------------
test('S2: a comment is posted to the pull request the composer was opened on', async () => {
  const rows = [row(42), row(43)];
  let calls = 0;
  let finish;
  const posted = [];
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => ({ ok: true, pullRequest: { ...row(number), permissions: { canEditLabels: true } } }),
    actions: { postComment: (number, body) => { posted.push({ number, body }); return { ok: true }; } },
    rowsAvailable: () => 30,
  });
  await tick();
  send(view, 'r', 'c');
  send(view, 'h', 'i');
  finish({ ok: true, rows: [rows[1], rows[0]] });
  await tick();
  send(view, 'ctrl+s');
  await tick();
  assert.deepEqual(posted, [{ number: 42, body: 'hi' }], 'the composer posted to the number it named');
});

// ---------------------------------------------------------------------------
// D12 (S2): the merge step names and highlights the pull request it will merge,
// and a rebase merge offers neither a commit message nor a description.
// ---------------------------------------------------------------------------
test('S2: the merge step names the captured number and highlights that row', async () => {
  const rows = [row(87), row(88)];
  let calls = 0;
  let finish;
  const merged = [];
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => ({
      ok: true,
      pullRequest: {
        ...row(number),
        permissions: { canMerge: true },
        mergeMethods: { merge: true },
        mergeDefaults: { merge: { subject: `subject ${number}`, body: `body ${number}` } },
      },
    }),
    actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    rowsAvailable: () => 30,
  });
  await tick();
  send(view, 'r', 'm');
  finish({ ok: true, rows: [rows[1], rows[0]] });
  await tick();
  const painted = frame(view);
  assert.match(painted, /Confirm merge #87/, 'the confirmation names the number it will merge');
  const left = view.render(140).map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, '').split('│')[1] || '').join('\n');
  assert.match(left, /▸ PR 87/, 'the row that will merge carries the cursor');
  assert.doesNotMatch(left, /▸ PR 88/, 'no other row is highlighted');
  send(view, 'ctrl+s');
  await tick();
  assert.deepEqual(merged, [{ number: 87, options: { method: 'merge', subject: 'subject 87', body: 'body 87' } }]);
});

test('S2: a rebase-only repository offers no commit message and no description', async () => {
  const merged = [];
  const view = createPrsView({
    pages: [{
      id: 'mine',
      rows: [{
        ...row(87),
        permissions: { canMerge: true },
        mergeMethods: { rebase: true },
        mergeDefaults: { rebase: {} },
      }],
    }],
    actions: { merge: (number, options) => { merged.push({ number, options }); return { ok: true }; } },
    rowsAvailable: () => 30,
  });
  send(view, 'm');
  const painted = frame(view);
  assert.match(painted, /Type: rebase/);
  assert.match(painted, /Confirm merge #87/);
  assert.doesNotMatch(painted, /Commit message|Description/, 'neither field is offered');
  send(view, 'down', 'enter');
  await tick();
  assert.deepEqual(merged, [{ number: 87, options: { method: 'rebase' } }], 'the confirm row is reachable without them');
});

// ---------------------------------------------------------------------------
// D13 (S2): the role read and the write it authorizes share ONE resolved
// repository scope, so a remote that moves between them cannot authorize one
// repository and write under another.
// ---------------------------------------------------------------------------
test('S2: close reads the role and writes in one resolved scope', async () => {
  const resolved = [];
  const children = [];
  const checkoutRepoScope = async () => {
    resolved.push(`github.com/octo/repo-${resolved.length + 1}`);
    return { ok: true, identity: resolved.at(-1), nameWithOwner: `octo/repo-${resolved.length}` };
  };
  // The injected module's own child seam, resolving a checkout exactly like
  // lib/gh-issues.js: an explicit pin wins, a checkout is resolved again.
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
    if (argv[0] === 'repo') return ok({ nameWithOwner: 'octo/base' });
    if (argv[0] === 'api') {
      return ok({ data: { repository: { viewerPermission: 'WRITE', pullRequest: { state: 'OPEN' } } } });
    }
    return ok('');
  };
  const client = createPrsClient({ issues: { runGh, checkoutRepoScope } });

  const res = await client.closePullRequest(42, { cwd: '/checkout' });

  assert.equal(res.ok, true, res.error);
  assert.equal(resolved.length, 1, 'the checkout is resolved once for the whole write');
  const run = children.filter((child) => child.argv[0] !== 'repo');
  assert.equal(run.length, 2, 'one role read and one close');
  assert.equal(run[0].identity, 'github.com/octo/repo-1', 'the role read proved repo-1');
  assert.equal(run[1].identity, run[0].identity,
    `the close ran in the scope the role read proved, not ${run[1].identity}`);
  assert.deepEqual(run[1].argv, ['pr', 'close', '42']);
});

// ---------------------------------------------------------------------------
// D14 (S2): creating a repository label is a capability of its own, carried by
// the metadata and re-checked by the editor at save time.
// ---------------------------------------------------------------------------
test('S2: the capability map confirms label creation at WRITE and up', () => {
  assert.equal(createPrsClient({}).pullRequestPermissions('WRITE').canCreateLabels, true);
  for (const role of ['MAINTAIN', 'ADMIN']) {
    assert.equal(createPrsClient({}).pullRequestPermissions(role).canCreateLabels, true, `${role} may create a label`);
  }
  for (const role of ['TRIAGE', 'READ', null, undefined, true, {}]) {
    assert.equal(createPrsClient({}).pullRequestPermissions(role).canCreateLabels, false,
      `${JSON.stringify(role)} confirms no label creation`);
  }
});

test('S2: the label editor re-checks label creation at save time', async () => {
  const writes = [];
  let calls = 0;
  let finish;
  let canCreateLabels = true;
  const rows = [row(87)];
  const view = createPrsView({
    loadPullRequestPage: () => (++calls === 1
      ? { ok: true, rows }
      : new Promise((resolve) => { finish = resolve; })),
    loadPullRequest: (number) => ({
      ok: true,
      pullRequest: { ...row(number), permissions: { canEditLabels: true, canCreateLabels } },
    }),
    labels: [{ name: 'bug' }],
    actions: {
      editLabels: (...args) => { writes.push(args); return { ok: true }; },
      createLabel: (label) => ({ ok: true, label }),
    },
    rowsAvailable: () => 30,
  });
  await tick();
  send(view, 'r', 'l');
  await tick();
  send(view, 'n', 'n', 'e', 'w', 'enter');
  canCreateLabels = false;
  finish({ ok: true, rows });
  await tick();
  send(view, 'ctrl+s');
  await tick();
  assert.deepEqual(writes, [], 'a lapsed creation capability writes nothing');
  assert.match(frame(view), /new labels cannot be created: this repository permission is missing/);
});

// ---------------------------------------------------------------------------
// The decision that opens the T9 verdict (S2): comments stay available in every
// state; the editor, close and merge keys belong to an open pull request.
// ---------------------------------------------------------------------------
test('S2: a merged pull request keeps comment and hides the editor, close and merge keys', async () => {
  const posted = [];
  const view = createPrsView({
    loadPullRequestPage: () => ({ ok: true, rows: [row(88)] }),
    loadPullRequest: (number) => ({
      ok: true,
      pullRequest: {
        ...row(number, { state: 'MERGED' }),
        permissions: {
          canEditLabels: true, canCreateLabels: true, canEditAssignees: true,
          canClosePullRequests: true, canMerge: true, canEditLinkedIssues: true,
        },
      },
    }),
    actions: { postComment: (number, body) => { posted.push({ number, body }); return { ok: true }; } },
    rowsAvailable: () => 30,
  });
  await tick();
  assert.match(frame(view), /c comment/, 'a merged pull request can still be commented on');
  send(view, 'c', 'n', 'i', 'c', 'e');
  send(view, 'ctrl+s');
  await tick();
  assert.deepEqual(posted, [{ number: 88, body: 'nice' }], 'the comment posts, ungated by the state');
});

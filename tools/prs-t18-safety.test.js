'use strict';
// T18 (prs-panel S2, D27): the four safety defects an independent verification
// found in the marker-based linked-issue body edit, reproduced through the
// public client seam with a recorder for EVERY child.
//
// The rule the four cases below pin is one sentence: this panel may only ever
// delete the exact line it wrote, only where that line is not an example, only
// when the body's fences and comments pair up, and only while the pull request
// is still OPEN — otherwise it refuses and no `pr edit` child runs at all.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrsClient } = require('../lib/gh-prs');

const pin = { scope: 'github.com/octo/repo' };
const ok = (doc) => ({ status: 0, stdout: JSON.stringify(doc), stderr: '', error: null });
const MARK = '<!-- odd-worktree:linked -->';
const UNREADABLE = 'the pull request body ends inside an unclosed code fence or comment';
const LINK_NOT_OURS = 'that link was not added by this panel; remove it on GitHub';
const MARKUP_LINK = 'that link sits inside a code fence or comment in the body; remove it on GitHub';
const BODY_CHANGED = 'the pull request body changed while it was being edited';
const NOT_OPEN = 'pull request #87 is not open; its linked issues cannot be edited';

// The recorder: the role read and the body reads answer from the fixture, and
// every OTHER child is a write this panel would have run. A refused edit
// therefore proves on its own that no `pr edit` child left the client.
function recorder(options = {}) {
  const children = [];
  const writes = [];
  let reads = 0;
  // The injected issue client's own runner seam: `(argv, options)`, so every
  // child the client spawns is recorded here.
  const run = async (argv, runOpts = {}) => {
    children.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) } });
    const head = argv.slice(0, 2).join(' ');
    if (head === 'api graphql') {
      return ok({ data: { repository: { viewerPermission: 'WRITE', pullRequest: { state: 'OPEN' } } } });
    }
    if (head === 'pr view') {
      reads += 1;
      const answer = typeof options.read === 'function' ? options.read(reads) : { body: options.body, state: 'OPEN' };
      return ok(answer);
    }
    writes.push(argv.slice());
    return ok({});
  };
  const client = createPrsClient({ issues: { runGh: run } });
  return { client, children, writes };
}

function bodyReads(children) {
  return children.filter((child) => child.argv.slice(0, 2).join(' ') === 'pr view');
}

// ---------------------------------------------------------------------------
// Defect 1: a removal deleted the panel's own line even when it sat INSIDE a
// fenced or HTML-commented example of that very line.
// ---------------------------------------------------------------------------
test('T18/D27: a marked line inside a paired fence is never deleted', async () => {
  const body = `Intro\n\`\`\`text\nCloses #12 ${MARK}\n\`\`\`\nTail\n`;
  const { client, writes } = recorder({ body });

  const res = await client.editLinkedIssues(87, { remove: [12] }, pin);

  assert.deepEqual(res, { ok: false, error: MARKUP_LINK },
    'the line is an example of what this panel writes, not a declaration it may delete');
  assert.deepEqual(writes, [], 'no pr edit child runs for a refused removal');
});

test('T18/D27: a marked line inside an HTML comment is never deleted', async () => {
  const body = `Intro\n<!--\ntemplate example:\nCloses #12 ${MARK}\n-->\nTail\n`;
  const { client, writes } = recorder({ body });

  const res = await client.editLinkedIssues(87, { remove: [12] }, pin);

  assert.deepEqual(res, { ok: false, error: MARKUP_LINK }, 'a commented-out example is not a declaration');
  assert.deepEqual(writes, [], 'no pr edit child runs for a refused removal');
});

test('T18/D27: a marked line outside the fence is still the line a removal deletes', async () => {
  const body = `Intro\n\`\`\`text\nCloses #12\n\`\`\`\nCloses #12 ${MARK}\nTail\n`;
  const { client, writes } = recorder({ body });

  const res = await client.editLinkedIssues(87, { remove: [12] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [['pr', 'edit', '87', '--body', 'Intro\n```text\nCloses #12\n```\nTail\n']],
    'only the real marked line outside the example is removed');
});

// ---------------------------------------------------------------------------
// Defect 2: a human line that merely LOOKED like the panel's line was deleted.
// Only `Closes #N <!-- odd-worktree:linked -->`, byte for byte, is the panel's.
// ---------------------------------------------------------------------------
test('T18/D27: a look-alike line is refused, never deleted', async () => {
  const lookAlikes = [
    `CLOSES #12 ${MARK}`,
    `closes #12 ${MARK}`,
    `Fix #12 ${MARK}`,
    `Closes  #12 ${MARK}`,
    `Closes #12  ${MARK}`,
    `Closes #12 ${MARK} `,
    `Closes #12 ${MARK}\t`,
    `Closes #012 ${MARK}`,
  ];
  for (const lookAlike of lookAlikes) {
    const body = `Intro\n${lookAlike}\nTail\n`;
    const { client, writes } = recorder({ body });

    const res = await client.editLinkedIssues(87, { remove: [12] }, pin);

    assert.deepEqual(res, { ok: false, error: LINK_NOT_OURS }, `${JSON.stringify(lookAlike)} is not this panel's line`);
    assert.deepEqual(writes, [], `${JSON.stringify(lookAlike)} is never rewritten`);
  }
});

test('T18/D27: the exact marked line is deleted, CRLF ending included', async () => {
  const body = `Intro\r\nCloses #12 ${MARK}\r\nTail\r\n`;
  const { client, writes } = recorder({ body });

  const res = await client.editLinkedIssues(87, { remove: [12] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [['pr', 'edit', '87', '--body', 'Intro\r\nTail\r\n']],
    'a CRLF line is the panel\'s own line too, and the CR that ends it is tolerated');
});

// ---------------------------------------------------------------------------
// Defect 3: an ADD appended its line inside an unclosed four-backtick fence,
// because the structure check counted runs instead of pairing them.
// ---------------------------------------------------------------------------
test('T18/D27: an unclosed four-backtick fence refuses the add, and the removal too', async () => {
  const bodies = [
    `Intro\n\`\`\`\`markdown\n\`\`\`sh\nmake install\n`,
    `Intro\n\`\`\`\`text\n~~~\na tilde example\n`,
    `Intro\n\`\`\`\`\n\`\`\`\nCloses #12 ${MARK}\n`,
  ];
  for (const body of bodies) {
    for (const changes of [{ add: [14] }, { remove: [12] }]) {
      const { client, writes } = recorder({ body });

      const res = await client.editLinkedIssues(87, changes, pin);

      assert.deepEqual(res, { ok: false, error: UNREADABLE }, `${JSON.stringify(changes)} on ${JSON.stringify(body)}`);
      assert.deepEqual(writes, [], 'nothing is written into a fence that is still open');
    }
  }
});

test('T18/D27: a paired four-backtick fence still lets the real line go', async () => {
  const body = `Intro\n\`\`\`\`md\n\`\`\`text\nCloses #19\n\`\`\`\n\`\`\`\`\nCloses #12 ${MARK}\n`;
  const { client, writes } = recorder({ body });

  const res = await client.editLinkedIssues(87, { remove: [12] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(writes, [['pr', 'edit', '87', '--body', 'Intro\n````md\n```text\nCloses #19\n```\n````\n']],
    'the inner three-backtick run is content of the four-backtick fence');
});

// ---------------------------------------------------------------------------
// Defect 4: the body was written after the pull request had been closed or
// merged during the re-reads.
// ---------------------------------------------------------------------------
test('T18/D27: the write-time re-read carries the state', async () => {
  const { client, children, writes } = recorder({ body: 'Intro\nTail\n' });

  const res = await client.editLinkedIssues(87, { add: [14] }, pin);

  assert.equal(res.ok, true, res.error);
  assert.equal(writes.length, 1, 'the edit ran once');
  const reads = bodyReads(children);
  assert.equal(reads.length, 2, 'the body is read twice');
  assert.ok(reads[1].argv.includes('body,state'),
    `the re-read asks for the state too, not ${JSON.stringify(reads[1].argv)}`);
});

test('T18/D27: a pull request that is no longer open refuses the write and writes nothing', async () => {
  for (const state of ['MERGED', 'CLOSED']) {
    let reads = 0;
    const { client, writes } = recorder({
      read: () => (++reads === 1 ? { body: 'Intro\nTail\n', state: 'OPEN' } : { body: 'Intro\nTail\n', state }),
    });

    const res = await client.editLinkedIssues(87, { add: [14] }, pin);

    assert.deepEqual(res, { ok: false, error: NOT_OPEN }, `${state} refuses the body edit`);
    assert.deepEqual(writes, [], `no pr edit child runs for a ${state} pull request`);
  }
});

test('T18/D27: the re-read must prove the state, never assume it', async () => {
  let reads = 0;
  const { client, writes } = recorder({
    read: () => (++reads === 1 ? { body: 'Intro\nTail\n', state: 'OPEN' } : { body: 'Intro\nTail\n' }),
  });

  const res = await client.editLinkedIssues(87, { add: [14] }, pin);

  assert.equal(res.ok, false, 'a re-read without a state proves nothing');
  assert.match(String(res.error), /returned an unexpected shape/);
  assert.deepEqual(writes, [], 'no pr edit child runs on a re-read that could not be read');
});

test('T18/D27: the body comparison stays exact', async () => {
  let reads = 0;
  const { client, writes } = recorder({
    read: () => (++reads === 1
      ? { body: 'Intro\nTail\n', state: 'OPEN' }
      : { body: 'Intro\nTail ', state: 'OPEN' }),
  });

  const res = await client.editLinkedIssues(87, { add: [14] }, pin);

  assert.deepEqual(res, { ok: false, error: BODY_CHANGED }, 'one byte of difference is still a difference');
  assert.deepEqual(writes, [], 'an author\'s edit is never overwritten');
});

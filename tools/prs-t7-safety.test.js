'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrsClient } = require('../lib/gh-prs');
const { createPrsView } = require('../lib/prs-view');

const pin = { scope: 'github.com/octo/repo' };
const ok = (x) => ({ status: 0, stdout: JSON.stringify(x) });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (number) => ({ number, title: `PR ${number}`, state: 'open', isDraft: false });
const send = (view, ...keys) => keys.forEach((key) => view.handleInput(key));
function mockClient(repository, bodyRead = ok({body: 'PR body'})) {
  const writes = [];
  const runGh = async (argv) => {
    // The role read answers the fresh pull request state in the same round trip
    // (S2/D20), so a write is refused for a target that is no longer open.
    if (argv[0] === 'api') return ok({data: {repository: {...repository, pullRequest: repository.pullRequest || {state: 'OPEN'}}}});
    if (argv[0] === 'pr' && argv[1] === 'view') return bodyRead;
    writes.push(argv);
    return ok({});
  };
  return { client: createPrsClient({issues: {runGh}}), writes };
}

for (const [action, call] of Object.entries({
  close: (c) => c.closePullRequest(87, pin),
  createLabel: (c) => c.createLabel({name:'needs-work'}, pin),
  editLabels: (c) => c.editLabels(87, {add:['needs-work']}, pin),
  editLinkedIssues: (c) => c.editLinkedIssues(87, {add:[12]}, pin),
  editAssignees: (c) => c.editAssignees(87, {remove:['alice']}, pin),
})) {
  test(`S2: ${action} rechecks READ before issuing a write`, async () => {
    const {client, writes} = mockClient({viewerPermission:'READ'});
    const result = await call(client);
    assert.deepEqual(writes, []);
    assert.equal(result.ok, false);
  });
}

test('S2: merge refuses missing draft metadata', async () => {
  const {client, writes} = mockClient({viewerPermission:'WRITE', mergeCommitAllowed:true, pullRequest:{}});
  const result = await client.mergePullRequest(87, {method:'merge'}, pin);
  assert.deepEqual(writes, []);
  assert.equal(result.ok, false);
});

// S2 (D27): the body edit no longer interprets Markdown. A line the panel wrote
// carries its marker, only a marked line is ever removed, and the fenced example
// — which carries none — survives because it was never a candidate. The added
// link is a marked line on a line of its own.
test('S2: a linked edit removes only the marked line, never a fenced Markdown example', async () => {
  const body = 'Intro 🧪\r\n```text\r\nCloses #12\r\n```\nCloses #12 <!-- odd-worktree:linked -->\r\nKeep me \t\nend';
  const wanted = `${body.replace('```\nCloses #12 <!-- odd-worktree:linked -->\r\n','```\n')}\r\n\r\nCloses #14 <!-- odd-worktree:linked -->\r\n`;
  const {client, writes} = mockClient({viewerPermission:'WRITE'}, ok({body}));
  await client.editLinkedIssues(87, {add:[14], remove:[12]}, pin);
  assert.deepEqual(writes, [['pr','edit','87','--body', wanted]]);
});

test('S2: close never acts on an asynchronously substituted PR', async () => {
  const rows = [row(87),row(88)];
  let calls = 0, finish;
  const closed = [];
  const view = createPrsView({
    loadPullRequestPage: () => ++calls === 1 ? {ok:true, rows} : new Promise(resolve => { finish = resolve; }),
    loadPullRequest: (number) => ({ok:true, pullRequest:{...row(number), permissions:{canClosePullRequests:true}}}),
    actions: {close: (n) => { closed.push(n); return {ok:true}; }},
    rowsAvailable: () => 30,
  });
  await tick();
  send(view,'down','up','r','x');
  assert.match(view.render(120).join('\n'),/Confirm close #87/);
  finish({ok:true, rows:[rows[1],rows[0]]});
  await tick();
  send(view,'enter');
  assert.ok(closed.length === 0 || closed[0] === 87, `closed ${closed}`);
});

test('S2: typing letters in the merge editor does not navigate its fields', async () => {
  const writes = [];
  const view = createPrsView({pages:[{id:'mine',rows:[{
    ...row(87), permissions:{canMerge:true}, mergeMethods:{merge:true},
    mergeDefaults:{merge:{subject:'M',body:'B'}},
  }]}], actions:{merge:(...args)=>{ writes.push(args); return {ok:true}; }}});
  send(view,'m','tab','backspace','j','k','tab','backspace','j','k','ctrl+s');
  // S2/D20: the merge re-reads its own detail before the seam is reached, so
  // the write settles on the next turn rather than inside the key press.
  await tick();
  assert.deepEqual(writes, [[87,{method:'merge',subject:'jk',body:'jk'}]]);
});

test('S2: an open editor cannot save after a capability is revoked', async () => {
  const writes = [];
  for (const [key, capability, seam, edit] of [
    ['l','canEditLabels','editLabels',['space']],
    ['a','canEditAssignees','editAssignees',['space']],
    ['i','canEditLinkedIssues','editLinkedIssues',['n','1','2','enter']],
  ]) {
    let calls = 0, finish, permission = true;
    const rows = [row(87)];
    const view = createPrsView({
      loadPullRequestPage: () => ++calls === 1 ? {ok:true, rows} : new Promise(resolve => { finish = resolve; }),
      loadPullRequest: (n) => ({ok:true,pullRequest:{...row(n),permissions:{[capability]:permission}}}),
      labels:[{name:'bug'}], loadAssignees:()=>({ok:true,users:[{login:'alice'}]}),
      actions:{[seam]:(...args)=>{writes.push([seam,args]);return {ok:true};}},
    });
    await tick();
    send(view,'r',key);
    await tick();
    send(view,...edit);
    permission = false;
    finish({ok:true, rows});
    await tick();
    send(view,'ctrl+s');
  }
  assert.deepEqual(writes, []);
});

test('S6: numbered open fetches a linked PR outside every scoped bucket', async () => {
  const fetched = [];
  createPrsView({initialPullRequest:87,
    loadPullRequestPage:({bucketId})=>({ok:true,rows:bucketId==='all'?[row(87)]:[row(88)]}),
    loadPullRequest:(n)=>{fetched.push(n);return {ok:true,pullRequest:row(n)};},
  });
  await tick();
  assert.ok(fetched.includes(87));
});
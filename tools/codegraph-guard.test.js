'use strict';
// T1 (S1, S2, S5, S6, S7) and T6 (S3): the decision core of the two CodeGraph reminders. From one
// finished tool call, the session's own checkout, the role and what the request already used, it decides
// one text or none, keeps the once-per-key state, re-arms guard 2 at every new request, and forgets
// everything on a compaction or a new session. Git is a fake toplevel map here: no child, no network, no
// real agent directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodegraphGuard } = require('../lib/codegraph-guard.js');

// The approved texts of S1 and S2, written out so a reworded reminder fails here. S3 took the trailing
// ", if it applies" off both sentences.
const ANOTHER = (root) => `This call went to ${root}, another checkout. Follow the CodeGraph rule: call \`mcp__codegraph__codegraph_explore\` with \`projectPath\` set to ${root} first.`;
const MCP = 'Follow the CodeGraph rule: call `mcp__codegraph__codegraph_explore` first.';

const ROOTS = {
  '/repo': '/repo',
  '/repo/src': '/repo',
  '/repo/a.ts': undefined, // a file has no toplevel: the resolver falls back to its directory
  '/repo/src/a.ts': undefined,
  '/other': '/other',
  '/other/src': '/other',
  '/other/a.ts': undefined,
  '/other/src/a.ts': undefined,
  '/third': '/third',
  '/third/a.ts': undefined,
  '/tmp': undefined,
};

function setup(overrides = {}) {
  const reads = [];
  const toplevel = overrides.toplevel || (async (dir) => {
    reads.push(dir);
    return ROOTS[dir];
  });
  const guard = createCodegraphGuard({
    env: { ...(overrides.env || {}) },
    argv: overrides.argv || ['node', '/bin/pi'],
    toplevel,
    // The fake checkouts are not real directories: every path here is a directory, so one git read answers.
    isDirectory: overrides.isDirectory || (() => true),
  });
  guard.observeTools(overrides.tools || ['read', 'grep', 'bash', 'codegraph', 'mcp__codegraph__codegraph_explore']);
  return { guard, reads, ctx: overrides.ctx || { cwd: '/repo' } };
}

const read = (path) => ({ toolName: 'read', input: { path }, isError: false, content: [] });
const grep = (path) => (path === undefined
  ? { toolName: 'grep', input: { pattern: 'x' }, isError: false, content: [] }
  : { toolName: 'grep', input: { pattern: 'x', path }, isError: false, content: [] });
const bash = (command) => ({ toolName: 'bash', input: { command }, isError: false, content: [] });
const explore = (projectPath) => ({
  toolName: 'mcp__codegraph__codegraph_explore',
  input: projectPath === undefined ? {} : { projectPath },
  isError: false,
  content: [],
});

// ---- the texts (S1, S2) ----

test('a call to another checkout is told to explore it with projectPath, once per checkout', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(read('/other/src/a.ts'), ctx), ANOTHER('/other'));
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined, 'the same checkout is reminded once');
  assert.equal(await guard.onToolResult(grep('/third'), ctx), ANOTHER('/third'), 'a second checkout gets its own reminder');
});

test('a child gets no reminder: its own rule text already says it and it lives a message or two', async () => {
  const child = (agent, tools) => setup({
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: tools },
    argv: ['node', `/tmp/gentle-pi-subagent-${agent}-a1b2c3/bin.js`],
    tools: [],
  });
  const explorer = child('gentle-ai-explore', 'read,bash,codegraph');
  assert.equal(await explorer.guard.onToolResult(bash('cat src/a.ts'), explorer.ctx), undefined);
  const worker = child('gentle-ai-worker', 'read,bash,mcp__codegraph__codegraph_explore');
  assert.equal(await worker.guard.onToolResult(bash('cat src/a.ts'), worker.ctx), undefined);
});

// ---- who gets which guard (S1, S2) ----

test('guard 1 belongs to the primary session: a child is never told it reached another checkout', async () => {
  const { guard, ctx } = setup({
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash,mcp__codegraph__codegraph_explore' },
    argv: ['node', '/tmp/gentle-pi-subagent-gentle-ai-worker-a1b2c3/bin.js'],
    tools: [],
  });
  assert.equal(await guard.onToolResult(read('/other/src/a.ts'), ctx), undefined);
});

test('a review agent gets no reminder at all', async () => {
  const { guard, ctx } = setup({
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash,mcp__codegraph__codegraph_explore' },
    argv: ['node', '/tmp/gentle-pi-subagent-review-code-a1b2c3/bin.js'],
    tools: [],
  });
  assert.equal(await guard.onToolResult(bash('cat src/a.ts'), ctx), undefined);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined);
});

test('a session holding no CodeGraph tool gets nothing (the prompt section\'s gate)', async () => {
  const { guard, reads, ctx } = setup({ tools: ['read', 'grep', 'bash'] });
  assert.equal(await guard.onToolResult(read('src/a.ts'), ctx), undefined);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined);
  assert.deepEqual(reads, [], 'and no git read is spent on it');
});

// ---- what counts (S3) ----

test('a call that is not a search or read is never a subject', async () => {
  const { guard, reads, ctx } = setup();
  for (const event of [
    { toolName: 'edit', input: { path: '/repo/a.ts' }, isError: false, content: [] },
    { toolName: 'write', input: { path: '/repo/a.ts' }, isError: false, content: [] },
    { toolName: 'worktree_list', input: {}, isError: false, content: [] },
  ]) {
    assert.equal(await guard.onToolResult(event, ctx), undefined);
  }
  assert.deepEqual(reads, []);
});

test('the reminder stays once per other checkout for the whole session', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  assert.equal(await guard.onToolResult(read('/other/b.ts'), ctx), undefined, 'the checkout already heard it');
  assert.equal(await guard.onToolResult(read('/third/a.ts'), ctx), ANOTHER('/third'), 'an unseen checkout gets its own');
});

test('an explore aimed at a checkout satisfies its reminder for the session', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(explore('/other'), ctx), undefined, 'an explore call is no search call');
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined, 'the checkout was already explored');
});

// ---- precision (S5) ----

test('guard 1 stays silent for a checkout this session already explored, without using its slot', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(explore('/other'), ctx), undefined, 'an explore call is no search call');
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined, 'already explored');
  assert.equal(await guard.onToolResult(read('/third/a.ts'), ctx), ANOTHER('/third'), 'another checkout still gets its reminder');
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined);
});

test('guard 1 understands an explore aimed at a directory inside that checkout', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult(explore('/other/src'), ctx);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined);
});

test('a call that failed earns no reminder and spends no slot', async () => {
  const { guard, ctx } = setup();
  const failed = (event) => ({ ...event, isError: true });
  assert.equal(await guard.onToolResult(failed(grep()), ctx), undefined, 'a failed grep gave the model nothing to read');
  assert.equal(await guard.onToolResult(failed(read('/other/a.ts')), ctx), undefined, 'nor did a failed read of another checkout');
  assert.equal(await guard.onToolResult(read('/third/a.ts'), ctx), ANOTHER('/third'), 'the slot it would have used is still free');
});

test('a failed CodeGraph call records no explored checkout', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult({ toolName: 'mcp__codegraph__codegraph_explore', input: { projectPath: '/other' }, isError: true, content: [] }, ctx);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'), 'a call that failed proved nothing');
});

// ---- reset (S7) ----

test('a compaction forgets the checkouts it reminded and the ones it explored', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult(explore('/other'), ctx);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined);
  assert.equal(await guard.onToolResult(read('/third/a.ts'), ctx), ANOTHER('/third'));
  guard.onCompacted();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'), 'the explored checkout was forgotten');
  assert.equal(await guard.onToolResult(read('/third/a.ts'), ctx), ANOTHER('/third'), 'and so was the reminded one');
});

test('a new session in the same process forgets it too', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  guard.onNewSession();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
});

// ---- robustness (S8) ----

test('a git read that throws or answers nothing never fails the tool result', async () => {
  let calls = 0;
  const { guard, ctx } = setup({
    toplevel: async () => {
      calls += 1;
      if (calls === 1) throw new Error('git is gone');
      return undefined;
    },
  });
  assert.equal(await guard.onToolResult(grep(), ctx), undefined);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined);
});

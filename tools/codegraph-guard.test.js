'use strict';
// T1 (S1, S2, S5, S6, S7): the decision core of the two CodeGraph reminders. From one finished tool
// call, the session's own checkout, the role and what the session already used, it decides one text or
// none, keeps the once-per-key state, and forgets it on a compaction or a new session. Git is a fake
// toplevel map here: no child, no network, no real agent directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodegraphGuard } = require('../lib/codegraph-guard.js');

// The approved texts of S1 and S2, written out so a reworded reminder fails here.
const ANOTHER = (root) => `This call went to ${root}, another checkout. Follow the CodeGraph rule: call \`mcp__codegraph__codegraph_explore\` with \`projectPath\` set to ${root} first.`;
const NATIVE = 'Follow the CodeGraph rule: run `codegraph` `query` or `explore` first, if it applies.';
const MCP = 'Follow the CodeGraph rule: call `mcp__codegraph__codegraph_explore` first, if it applies.';

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

test('the primary session is pointed at the native operations when it holds the native tool', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
});

test('a session holding only the MCP tool is pointed at the MCP call instead', async () => {
  const { guard, ctx } = setup({ tools: ['grep', 'mcp__codegraph__codegraph_explore'] });
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
});

test('an explore agent gets the native wording, every other child the MCP one', async () => {
  const child = (agent, tools) => setup({
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: tools },
    argv: ['node', `/tmp/gentle-pi-subagent-${agent}-a1b2c3/bin.js`],
    tools: [],
  });
  const explorer = child('gentle-ai-explore', 'read,bash,codegraph');
  assert.equal(await explorer.guard.onToolResult(bash('cat src/a.ts'), explorer.ctx), NATIVE);
  const worker = child('gentle-ai-worker', 'read,bash,mcp__codegraph__codegraph_explore');
  assert.equal(await worker.guard.onToolResult(bash('cat src/a.ts'), worker.ctx), MCP);
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

test('a read of a config or a doc is not a code read', async () => {
  const { guard, ctx } = setup();
  for (const file of ['src/README.md', 'package.json', 'a.yml', 'a.yaml', 'a.toml', 'notes.txt']) {
    assert.equal(await guard.onToolResult(read(file), ctx), undefined, file);
  }
  assert.equal(await guard.onToolResult(read('src/a.ts'), ctx), NATIVE);
});

test('a path with no git checkout triggers nothing, and uses up no slot', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(read('/tmp/a.ts'), ctx), undefined);
  assert.equal(await guard.onToolResult(read('src/a.ts'), ctx), NATIVE, 'the own checkout was still unreminded');
});

// ---- guard 2's key is the session's own checkout (S7) ----

test('guard 2 is once per session, and a warp to another checkout re-arms it', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined);
  const warped = { cwd: '/third' };
  assert.equal(await guard.onToolResult(read('/third/a.ts'), warped), NATIVE, 'the new checkout has not been reminded');
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

test('guard 2 stays silent once the session used CodeGraph, and the silent attempt used no slot', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult({ toolName: 'codegraph', input: { operation: 'query' }, isError: false, content: [] }, ctx);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined, 'the graph was already used');
  guard.onCompacted();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE, 'the slot was never consumed');
});

// ---- reset (S7) ----

test('a compaction forgets both guards', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  guard.onCompacted();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
});

test('a new session in the same process forgets both guards too', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  guard.onNewSession();
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
});

test('a compaction forgets what the session already explored and used', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult(explore('/other'), ctx);
  await guard.onToolResult({ toolName: 'codegraph', input: { operation: 'query' }, isError: false, content: [] }, ctx);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined);
  guard.onCompacted();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  assert.equal(await guard.onToolResult(grep(), ctx), NATIVE);
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

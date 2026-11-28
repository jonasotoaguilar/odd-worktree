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

test('the primary session is pointed at the MCP call, whatever else it holds', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
});

test('a session holding only the MCP tool is pointed at the same MCP call', async () => {
  const { guard, ctx } = setup({ tools: ['grep', 'mcp__codegraph__codegraph_explore'] });
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
});

test('neither sentence ends in ", if it applies" any more (S3)', async () => {
  const both = setup();
  const mcp = setup({ tools: ['grep', 'mcp__codegraph__codegraph_explore'] });
  const texts = [await both.guard.onToolResult(grep(), both.ctx), await mcp.guard.onToolResult(grep(), mcp.ctx)];
  assert.deepEqual(texts, [MCP, MCP]);
  for (const text of texts) {
    assert.ok(!text.includes('if it applies'), text);
    assert.ok(text.endsWith(' first.'), text);
  }
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

test('a read of a config or a doc is not a code read', async () => {
  const { guard, ctx } = setup();
  for (const file of ['src/README.md', 'package.json', 'a.yml', 'a.yaml', 'a.toml', 'notes.txt']) {
    assert.equal(await guard.onToolResult(read(file), ctx), undefined, file);
  }
  assert.equal(await guard.onToolResult(read('src/a.ts'), ctx), MCP);
});

test('a path with no git checkout triggers nothing, and uses up no slot', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(read('/tmp/a.ts'), ctx), undefined);
  assert.equal(await guard.onToolResult(read('src/a.ts'), ctx), MCP, 'the own checkout was still unreminded');
});

// ---- guard 2's key is the session's own checkout (S7) ----

test('guard 2 reminds on the first search of a checkout, and a warp to another checkout re-arms it', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined);
  const warped = { cwd: '/third' };
  assert.equal(await guard.onToolResult(read('/third/a.ts'), warped), MCP, 'the new checkout has not been reminded');
});

// ---- guard 2 reminds once per checkout per request (S3, S7) ----

const use = (toolName) => ({ toolName, input: { operation: 'query' }, isError: false, content: [] });

/** The texts the guard answered over `count` back-to-back searches in one checkout. */
async function row(guard, ctx, count) {
  const texts = [];
  for (let call = 0; call < count; call += 1) texts.push(await guard.onToolResult(grep(), ctx));
  return texts;
}

const silent = (count) => Array(count).fill(undefined);

test('one reminder per request, whatever the number of searches after it (S3, S7)', async () => {
  const { guard, ctx } = setup();
  // One first search plus 8, 9 and 17 more: the searches at 8, 9 and 17 since the reminder earn nothing.
  const texts = [await guard.onToolResult(grep(), ctx)];
  for (const count of [8, 9, 17]) texts.push(...await row(guard, ctx, count));
  const reminded = texts.map((text, index) => (text === undefined ? undefined : index + 1)).filter((at) => at !== undefined);
  assert.deepEqual(reminded, [1], 'only the first search of the checkout is reminded, never the 8th, 9th or 17th after it');
  assert.deepEqual(texts.filter((text) => text !== undefined), [MCP]);
});

test('a CodeGraph use neither earns a reminder nor re-arms the one already given (S3)', async () => {
  const forUse = setup();
  assert.equal(await forUse.guard.onToolResult(grep(), forUse.ctx), MCP, 'the first reminder');
  assert.deepEqual(await row(forUse.guard, forUse.ctx, 4), silent(4));
  assert.equal(await forUse.guard.onToolResult(use('codegraph'), forUse.ctx), undefined, 'a use is no search call');
  assert.deepEqual(await row(forUse.guard, forUse.ctx, 9), silent(9), 'the checkout already had its one reminder');

  const forExplore = setup();
  assert.equal(await forExplore.guard.onToolResult(grep(), forExplore.ctx), MCP);
  await forExplore.guard.onToolResult(explore('/repo'), forExplore.ctx);
  assert.deepEqual(await row(forExplore.guard, forExplore.ctx, 17), silent(17), 'the MCP explore call re-arms nothing either');
});

test('each checkout hears its own one reminder in a request (S3)', async () => {
  const { guard, ctx } = setup();
  const warped = { cwd: '/third' };
  assert.equal(await guard.onToolResult(read('src/a.ts'), ctx), MCP, 'the /repo checkout reminds on its first search');
  assert.deepEqual(await row(guard, ctx, 17), silent(17), 'and never again in this request');
  assert.equal(await guard.onToolResult(read('/third/a.ts'), warped), MCP, 'a warp to /third has its own reminder');
  assert.deepEqual(await row(guard, warped, 17), silent(17), 'once, and then never again either');
  assert.deepEqual(await row(guard, ctx, 17), silent(17), 'and /repo stays silent');
});

// ---- a new request re-arms guard 2 (S7) ----
//
// Each new request forgets guard 2's first-search slots and its `used` flag, so the first search of every
// request is reminded again; guard 1's slots and the explored checkouts stay per session.

test('a new request reminds its first search again (S7)', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP, 'the first search of the request reminds');
  assert.deepEqual(await row(guard, ctx, 17), silent(17), 'and no later search of it does');
  guard.onNewRequest();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP, 'the next request is reminded on its first search');
  assert.deepEqual(await row(guard, ctx, 17), silent(17), 'it hears it once too');
});

test('a CodeGraph use in the previous request does not silence the first search of the next (S7)', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult(use('codegraph'), ctx);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined, 'the graph was already used in this request');
  guard.onNewRequest();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP, 'a new request starts with the graph unused');
});

test('a new request keeps guard 1 once per other checkout across requests (S7)', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  guard.onNewRequest();
  assert.equal(await guard.onToolResult(read('/other/b.ts'), ctx), undefined, 'a new request is no new checkout');
  assert.equal(await guard.onToolResult(read('/third/a.ts'), ctx), ANOTHER('/third'), 'an unseen checkout still gets its reminder');
  guard.onNewRequest();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined, 'and it stays once per session');
});

test('a new request does not forget the checkouts the session already explored (S7)', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(explore('/other'), ctx), undefined, 'an explore call is no search call');
  guard.onNewRequest();
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), undefined, 'guard 1 stays satisfied by that explore');
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

test('a session that used CodeGraph before its first search is not reminded on that first search', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult(use('codegraph'), ctx);
  assert.equal(await guard.onToolResult(grep(), ctx), undefined, 'the graph was already used');
  guard.onCompacted();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP, 'the first-search reminder was never consumed');
});

test('a call that failed earns no reminder and spends no slot', async () => {
  const { guard, ctx } = setup();
  const failed = (event) => ({ ...event, isError: true });
  assert.equal(await guard.onToolResult(failed(grep()), ctx), undefined, 'a failed grep gave the model nothing to read');
  assert.equal(await guard.onToolResult(failed(read('/other/a.ts')), ctx), undefined, 'nor did a failed read of another checkout');
  assert.equal(await guard.onToolResult(grep(), ctx), MCP, 'the slot it would have used is still free');
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
});

test('a failed CodeGraph call is no use of it either', async () => {
  const { guard, ctx } = setup();
  await guard.onToolResult({ toolName: 'codegraph', input: { operation: 'query' }, isError: true, content: [] }, ctx);
  assert.equal(await guard.onToolResult(grep(), ctx), MCP, 'a call that failed proved nothing');
});

// ---- reset (S7) ----

test('a compaction forgets both guards', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  guard.onCompacted();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
});

test('a new session in the same process forgets both guards too', async () => {
  const { guard, ctx } = setup();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
  assert.equal(await guard.onToolResult(read('/other/a.ts'), ctx), ANOTHER('/other'));
  guard.onNewSession();
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
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
  assert.equal(await guard.onToolResult(grep(), ctx), MCP);
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

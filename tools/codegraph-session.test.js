'use strict';
// T5: the one place that wires CodeGraph into a session: session start (the global MCP entry, create-or-sync, the warm-up),
// compaction, the observed native init, the edit/write sync, the two reminders appended to a search call's result, and
// shutdown. Only with the CLI installed, and nothing here may throw into the host. Every collaborator is injected, so no
// test runs codegraph, a daemon or touches a real agent directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { registerCodegraph, onCodegraphSwitch } = require('../lib/codegraph-session.js');

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
  };
}

function setup(overrides = {}) {
  const pi = fakePi();
  const calls = { agentTools: [], mcp: [], prepare: [], compaction: [], init: [], edit: [], card: [], dispose: 0, notices: [] };
  const impl = {
    ensureCodegraphServer: async (input) => {
      calls.mcp.push(input);
      return { status: 'added', changes: ['command'] };
    },
    prepareProject: async (input) => {
      calls.prepare.push(input);
      if (typeof input.onStart === 'function') input.onStart('sync');
      return { index: { action: 'sync', ok: true }, warm: 'skipped' };
    },
    compactionSync: async (input) => {
      calls.compaction.push(input);
      return 'synced';
    },
    syncAfterNativeInit: async (input) => {
      calls.init.push(input);
      return 'completed';
    },
    createEditSync: () => ({
      onToolResult: async (event, ctx) => {
        calls.edit.push([event, ctx]);
      },
      dispose: () => {
        calls.dispose += 1;
      },
    }),
    warmUpDaemon: async () => true,
    // The agents' tools.json check is its own module's (tools/codegraph-agent-tools.test.js): here it only records.
    registerAgentToolsSync: (_pi, options) => {
      calls.agentTools.push(options);
      return { registered: true };
    },
    ...(overrides.impl || {}),
  };
  const result = registerCodegraph(pi, {
    metrics: overrides.metrics || (() => ({ metrics: true })),
    env: { PI_CODING_AGENT_DIR: '/agent', ...(overrides.env || {}) },
    argv: overrides.argv || ['node', '/bin/pi'],
    toplevel: overrides.toplevel,
    isDirectory: overrides.isDirectory || (() => true),
    hasBinary: overrides.hasBinary || (() => true),
    enabled: overrides.enabled,
    joinIndexWork: overrides.joinIndexWork,
    delay: overrides.delay,
    impl,
  });
  const ctx = {
    cwd: '/work/repo',
    ui: { notify: (text, level) => calls.notices.push([text, level]) },
  };
  const run = async (name, event, c = ctx) => {
    let last;
    for (const handler of pi.handlers.get(name) || []) last = await handler(event, c);
    await new Promise((resolve) => setImmediate(resolve));
    return last;
  };
  return { pi, calls, ctx, run, result };
}

test('without the CodeGraph CLI nothing is registered at all, but the agents\' tools.json is still checked', () => {
  const { pi, result, calls } = setup({ hasBinary: () => false });
  assert.equal(result.registered, false);
  assert.equal(pi.handlers.size, 0);
  assert.equal(calls.agentTools.length, 1);
  assert.equal(calls.agentTools[0].enabled, true);
  assert.equal(calls.agentTools[0].hasCli(), false, 'a module On without its CLI takes the entry out');
});

test('with the module Off the one registration only checks tools.json: no handler, no index, no MCP entry', async () => {
  const { pi, result, calls, run } = setup({ enabled: false });
  assert.equal(result.registered, false);
  assert.equal(pi.handlers.size, 0);
  assert.equal(calls.agentTools.length, 1);
  assert.equal(calls.agentTools[0].enabled, false);
  await run('session_start', { reason: 'startup' });
  assert.deepEqual([calls.mcp, calls.prepare], [[], []]);
});

test('with the module On and the CLI the agents\' tools.json check is registered with both facts', () => {
  const { calls } = setup();
  assert.equal(calls.agentTools.length, 1);
  assert.equal(calls.agentTools[0].enabled, true);
  assert.equal(calls.agentTools[0].hasCli(), true);
  assert.equal(calls.agentTools[0].env.PI_CODING_AGENT_DIR, '/agent');
});


test('a primary session start ensures the MCP entry once, prepares the index and reports the change', async () => {
  const { calls, run } = setup();
  await run('session_start', { reason: 'startup' });
  await run('session_start', { reason: 'new' });
  assert.equal(calls.mcp.length, 1, 'the entry is checked once per process');
  assert.equal(calls.mcp[0].agentDir, '/agent');
  assert.equal(calls.prepare.length, 2);
  assert.equal(calls.prepare[0].cwd, '/work/repo');
  assert.equal(calls.prepare[0].reason, 'startup');
  assert.ok(calls.notices.some(([text]) => /mcp\.json/.test(text) && /reload/i.test(text)), 'one notice says Pi must reload');
});

test('the agent directory falls back to ~/.pi/agent when the host names none', async () => {
  const { calls, run } = setup({ env: { PI_CODING_AGENT_DIR: undefined } });
  await run('session_start', { reason: 'startup' });
  assert.equal(calls.mcp[0].agentDir, path.join(os.homedir(), '.pi', 'agent'));
});

test('a subagent child never touches the MCP entry', async () => {
  const { calls, run } = setup({ env: { GENTLE_PI_AGENTS_CHILD: '1' } });
  await run('session_start', { reason: 'startup' });
  assert.equal(calls.mcp.length, 0);
});

test('an invalid MCP file is reported as a warning and left alone', async () => {
  const { calls, run } = setup({ impl: { ensureCodegraphServer: async () => ({ status: 'invalid' }) } });
  await run('session_start', { reason: 'startup' });
  assert.ok(calls.notices.some(([text, level]) => /mcp\.json/.test(text) && level === 'warning'));
});

test('an unchanged entry says nothing', async () => {
  const { calls, run } = setup({ impl: { ensureCodegraphServer: async () => ({ status: 'unchanged' }) } });
  await run('session_start', { reason: 'startup' });
  assert.equal(calls.notices.filter(([text]) => /mcp\.json/.test(text)).length, 0);
});

test('session start never waits for the preparation', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { pi, ctx } = setup({ impl: { prepareProject: () => gate } });
  const started = pi.handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
  const settled = await Promise.race([Promise.resolve(started).then(() => 'returned'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 50))]);
  release({ index: { action: 'none', ok: true }, warm: 'skipped' });
  assert.equal(settled, 'returned');
});

test('a compaction asks for one sync of the session checkout', async () => {
  const { calls, run } = setup();
  await run('session_compact', {});
  assert.equal(calls.compaction.length, 1);
  assert.equal(calls.compaction[0].cwd, '/work/repo');
});

test('S4: a successful native init is followed by one coordinated sync and appends nothing to the result', async () => {
  const { calls, run } = setup();
  const patch = await run('tool_result', {
    toolName: 'codegraph',
    input: { operation: 'init' },
    isError: false,
    content: [{ type: 'text', text: 'initialized' }],
  });
  assert.equal(calls.init.length, 1);
  assert.equal(calls.init[0].cwd, '/work/repo');
  assert.equal(patch, undefined, "the tool's own content is the whole answer");
});

test('S4: a post-init sync that did not complete appends one short line naming the failure', async () => {
  const { run } = setup({ impl: { syncAfterNativeInit: async () => 'failed' } });
  const patch = await run('tool_result', {
    toolName: 'codegraph',
    input: { operation: 'init' },
    isError: false,
    content: [{ type: 'text', text: 'initialized' }],
  });
  assert.equal(patch.content.length, 2, 'one extra part, not a paragraph');
  assert.deepEqual(patch.content[0], { type: 'text', text: 'initialized' }, 'the tool result keeps its own words first');
  assert.equal(patch.content[1].text.includes('\n'), false, 'one line');
  assert.doesNotMatch(patch.content[1].text, /pi-odd-worktree/);
  assert.match(patch.content[1].text, /failed/);
  assert.match(patch.content[1].text, /not confirmed current|may be behind/);
});

test('a failed init, another operation or another tool changes nothing and starts no sync', async () => {
  const { calls, run } = setup();
  for (const event of [
    { toolName: 'codegraph', input: { operation: 'init' }, isError: true, content: [] },
    { toolName: 'codegraph', input: { operation: 'query' }, isError: false, content: [] },
    { toolName: 'bash', input: {}, isError: false, content: [] },
  ]) {
    assert.equal(await run('tool_result', event), undefined);
  }
  assert.equal(calls.init.length, 0);
});

test('S4: a read-only role gets the one skipped line and no sync', async () => {
  const { calls, run } = setup({ env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash,codegraph' } });
  const patch = await run('tool_result', { toolName: 'codegraph', input: { operation: 'init' }, isError: false, content: [] });
  assert.equal(calls.init.length, 0);
  assert.equal(patch.content.length, 1);
  assert.match(patch.content[0].text, /read-only/);
  assert.equal(patch.content[0].text.includes('\n'), false, 'one short line');
});

test('an init aimed at another checkout is left to its own index', async () => {
  const { calls, run } = setup();
  const patch = await run('tool_result', { toolName: 'codegraph', input: { operation: 'init', worktree: 'other' }, isError: false, content: [] });
  assert.equal(patch, undefined);
  assert.equal(calls.init.length, 0);
});

test('every tool result also feeds the edit sync, with the session context', async () => {
  const { calls, ctx, run } = setup();
  const event = { toolName: 'edit', input: { path: 'a.js' }, isError: false, content: [] };
  await run('tool_result', event);
  assert.deepEqual(calls.edit, [[event, ctx]]);
});

test('shutdown clears the edit sync windows', async () => {
  const { calls, run } = setup();
  await run('session_shutdown', {});
  assert.equal(calls.dispose, 1);
});

test('a throwing collaborator never reaches the host', async () => {
  const boom = async () => {
    throw new Error('boom');
  };
  const { run } = setup({ impl: { ensureCodegraphServer: boom, prepareProject: boom, compactionSync: boom, syncAfterNativeInit: boom } });
  await assert.doesNotReject(async () => {
    await run('session_start', { reason: 'startup' });
    await run('session_compact', {});
    await run('tool_result', { toolName: 'codegraph', input: { operation: 'init' }, isError: false, content: [] });
  });
});

// ---- the host contract: a lifecycle handler is never awaited by the host ----
//
// The host applies what a `pi.on()` handler returns, and waits for a thenable, so an index preparation
// handed back from `session_start` would sit on Pi's own startup path. No other test can see that: each
// one calls the handler and awaits it itself, which works just as well for a promise as for `undefined`.
// Two handlers may answer with a promise:
//
//   - `tool_result`, whose only host-visible wait is the bounded post-init race (`POST_INIT_SYNC_WAIT_MS`);
//   - `tool_call` (S2), whose promise is the bounded join of index work this process had ALREADY started —
//     Pi awaits that hook before the tool runs and blocks the tool when it throws (docs/extensions.md:3253),
//     so it answers `undefined` whenever nothing is in flight and can neither throw nor answer a block.

test('no lifecycle handler hands the host a promise, and only tool_result and tool_call answer with one', async () => {
  const { pi, ctx } = setup();
  const events = {
    session_start: { reason: 'startup' },
    session_compact: {},
    before_agent_start: { systemPromptOptions: { selectedTools: ['read'] } },
    session_shutdown: {},
  };
  assert.deepEqual([...pi.handlers.keys()].sort(), ['before_agent_start', 'session_compact', 'session_shutdown', 'session_start', 'tool_call', 'tool_result'], 'the wiring registers these and nothing else');
  for (const [name, handlers] of pi.handlers) {
    for (const handler of handlers) {
      const returned = handler(events[name] || {}, ctx);
      if (name === 'tool_result') {
        assert.equal(typeof returned?.then, 'function', 'tool_result is the one handler whose patch is the answer');
        await returned;
        continue;
      }
      if (name === 'tool_call') {
        // S2: the join may answer with a promise, but with nothing in flight it answers `undefined` and
        // Pi runs the tool at once. Either way the answer settles on its own and is never a block.
        if (returned !== undefined) assert.equal(typeof returned.then, 'function', 'tool_call answers a thenable or nothing');
        assert.equal(await returned, undefined, 'and never a block');
        continue;
      }
      assert.equal(returned, undefined, `${name} must hand the host nothing: its work runs off the host's path`);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('the work a synchronous handler starts still runs after it has answered the host', async () => {
  let releasePrepare;
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  let releaseCompaction;
  const compactionGate = new Promise((resolve) => {
    releaseCompaction = resolve;
  });
  const prepared = [];
  const compacted = [];
  const { pi, ctx } = setup({
    impl: {
      prepareProject: (input) => {
        prepared.push(input);
        return prepareGate;
      },
      compactionSync: (input) => {
        compacted.push(input);
        return compactionGate;
      },
    },
  });
  pi.handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
  pi.handlers.get('session_compact')[0]({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared.length, 1, 'the index preparation is requested without the host waiting for it');
  assert.equal(compacted.length, 1, 'the compaction sync is requested without the host waiting for it');
  releasePrepare({ index: { action: 'none', ok: true }, warm: 'skipped' });
  releaseCompaction('synced');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared[0].cwd, '/work/repo', 'and it is the session checkout that is prepared');
});

// ---- the two reminders (T3: S1, S2, S5, S6, S7) ----
//
// One extra text part on the result of a search call, never a separate message and never a block. The
// session's tools come from `before_agent_start` (the only source), the checkouts from one cached fake
// git toplevel, and the texts are the approved ones, written out here.

const NATIVE_REMINDER = 'Follow the CodeGraph rule: call `mcp__codegraph__codegraph_explore` first.';
const MCP_REMINDER = 'Follow the CodeGraph rule: call `mcp__codegraph__codegraph_explore` first.';
const anotherReminder = (root) => `This call went to ${root}, another checkout. Follow the CodeGraph rule: call \`mcp__codegraph__codegraph_explore\` with \`projectPath\` set to ${root} first.`;

const SESSION_TOOLS = { systemPromptOptions: { selectedTools: ['read', 'grep', 'bash', 'codegraph'] } };

// What git answers for a directory inside a checkout: its toplevel, at any depth, and nothing outside one.
function checkoutMap(map = { '/work/repo': '/work/repo', '/work/other': '/work/other' }) {
  return async (dir) => {
    for (let at = dir; ;) {
      if (Object.prototype.hasOwnProperty.call(map, at)) return map[at];
      const parent = path.dirname(at);
      if (parent === at) return undefined;
      at = parent;
    }
  };
}

const readEvent = (path, extra = {}) => ({
  toolName: 'read',
  input: { path },
  isError: false,
  content: [{ type: 'text', text: 'source' }],
  ...extra,
});

test('a child is not reminded', async () => {
  const { run } = setup({
    toplevel: checkoutMap(),
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,grep,mcp__codegraph__codegraph_explore' },
    argv: ['node', '/tmp/gentle-pi-subagent-gentle-ai-worker-ab12cd/instructions.md'],
  });
  await run('before_agent_start', { systemPromptOptions: { selectedTools: [] } });
  assert.equal(await run('tool_result', readEvent('src/a.ts')), undefined);
});

test('a worker child and a review agent are told nothing', async () => {
  const worker = setup({
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash,mcp__codegraph__codegraph_explore' },
    argv: ['node', '/tmp/gentle-pi-subagent-gentle-ai-worker-a1b2c3/bin.js'],
    toplevel: checkoutMap(),
  });
  const workerPatch = await worker.run('tool_result', readEvent('src/a.ts'));
  assert.equal(workerPatch, undefined);

  const reviewer = setup({
    env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash,mcp__codegraph__codegraph_explore' },
    argv: ['node', '/tmp/gentle-pi-subagent-review-code-a1b2c3/bin.js'],
    toplevel: checkoutMap(),
  });
  assert.equal(await reviewer.run('tool_result', readEvent('src/a.ts')), undefined);
});

test('a git read that throws never fails the tool result', async () => {
  const { run } = setup({
    toplevel: async () => {
      throw new Error('git is gone');
    },
  });
  await run('before_agent_start', SESSION_TOOLS);
  await assert.doesNotReject(async () => {
    assert.equal(await run('tool_result', readEvent('src/a.ts')), undefined);
  });
});

// ---- S2: the bounded join on the pre-execution hook (T6) ----
//
// Before a CodeGraph search runs, the index work this process already has in flight for that checkout is
// awaited — never started, never exceeded, and never able to fail the call. Pi awaits a `tool_call` handler
// before the tool runs and BLOCKS the tool when that handler throws (docs/extensions.md:3253), so this handler
// answers `undefined` for every other tool and whenever nothing is in flight, and the promise it does answer
// with is bounded and never rejects.

const searchCall = (toolName = 'codegraph', input = { operation: 'query' }) => ({ toolName, input, toolCallId: 'call-1' });

function gateOf() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return { gate, release: (value) => release(value) };
}

test('S2: a search joins the session-start preparation already in flight, and starts none of its own', async () => {
  const gate = gateOf();
  const preparations = [];
  const { pi, calls, ctx } = setup({
    impl: {
      prepareProject: (input) => {
        preparations.push(input);
        return gate.gate;
      },
    },
  });
  pi.handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparations.length, 1);
  const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
  assert.equal(typeof returned?.then, 'function', 'the search waits for the preparation in flight');
  // Settlement is tracked as a flag, not as a value: `undefined` is both what the handler answers and what a promise
  // that has not settled yet looks like, so a value cannot tell an early answer from one still pending.
  let releasedAt;
  let settledAfter;
  void returned.then(() => {
    settledAfter = releasedAt;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settledAfter, undefined, 'the join was still in flight while the preparation had not been released');
  releasedAt = Date.now();
  gate.release({ index: { action: 'sync', ok: true }, warm: 'skipped' });
  assert.equal(await returned, undefined, 'the handler answers undefined, never a block');
  assert.equal(settledAfter, releasedAt, 'the release is what ended the wait, nothing else');
  assert.equal(preparations.length, 1, 'joining starts no preparation, sync, init or seed');
  assert.equal(calls.init.length, 0);
  assert.deepEqual(calls.edit, [], 'and nothing reaches the edit sync');
});

test('S2: a search joins a post-init sync already in flight', async () => {
  const gate = gateOf();
  const { pi, ctx, run } = setup({ impl: { syncAfterNativeInit: () => gate.gate } });
  const result = run('tool_result', { toolName: 'codegraph', input: { operation: 'init' }, isError: false, content: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
  assert.equal(typeof returned?.then, 'function', 'the index write the init hook started is joined');
  gate.release('completed');
  await result;
  assert.equal(await returned, undefined);
});

test('S2: a search joins the compaction sync already in flight, bounded by the same budget', async () => {
  const gate = gateOf();
  const budgets = [];
  const compacted = [];
  const { pi, ctx } = setup({
    impl: {
      compactionSync: (input) => {
        compacted.push(input);
        return gate.gate;
      },
    },
    delay: (ms) => {
      budgets.push(ms);
      return gate.gate;
    },
  });
  assert.equal(pi.handlers.get('session_compact')[0]({}, ctx), undefined, 'the host is still handed nothing');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(compacted.length, 1, 'the compaction asked for one sync');
  const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
  assert.equal(typeof returned?.then, 'function', 'the search waits for the compaction sync in flight');
  let settled = false;
  void returned.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'the join was still in flight while the compaction sync had not finished');
  gate.release({ outcome: 'synced' });
  assert.equal(await returned, undefined, 'the handler answers undefined, never a block');
  assert.deepEqual(budgets, [5000], 'the same five-second budget bounds the wait');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.handlers.get('tool_call')[0](searchCall(), ctx), undefined, 'once it settled, a search waits for nothing');
});

test('S2: a compaction sync that throws never reaches the host and leaves a search unblocked', async () => {
  const { pi, ctx } = setup({
    impl: {
      compactionSync: () => {
        throw new Error('boom');
      },
    },
  });
  assert.equal(pi.handlers.get('session_compact')[0]({}, ctx), undefined, 'the host is handed nothing');
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.handlers.get('tool_call')[0](searchCall(), ctx), undefined, 'a failed compaction is not something to join');
});

test('S2: a search joins a running edit-sync window, bounded by the same budget', async () => {
  const gate = gateOf();
  const asked = [];
  let busy = true;
  const { pi, ctx } = setup({
    impl: {
      createEditSync: () => ({
        onToolResult: async () => {},
        dispose: () => {},
        inFlight: () => busy,
        whenIdle: (root, budgetMs) => {
          asked.push([root, budgetMs]);
          return gate.gate;
        },
      }),
    },
  });
  const returned = pi.handlers.get('tool_call')[0](searchCall('mcp__codegraph__codegraph_explore'), ctx);
  assert.equal(typeof returned?.then, 'function');
  assert.deepEqual(asked, [['/work/repo', 5000]], 'the window of the same checkout, with the default budget');
  busy = false;
  assert.equal(pi.handlers.get('tool_call')[0](searchCall(), ctx), undefined, 'an idle window is not waited for');
  gate.release('done');
  assert.equal(await returned, undefined);
});

test('S2: an idle checkout adds no wait at all', () => {
  const { pi, ctx } = setup();
  const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
  assert.equal(returned, undefined, 'nothing in flight: the tool runs at once');
});

test('S2: every other tool answers undefined at once, even while the index is being written', async () => {
  const gate = gateOf();
  const { pi, ctx } = setup({ impl: { prepareProject: () => gate.gate } });
  pi.handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  for (const event of [
    { toolName: 'bash', input: { command: 'ls' } },
    { toolName: 'read', input: { path: 'src/a.js' } },
    { toolName: 'grep', input: { pattern: 'x' } },
    { toolName: 'mcp__context7__query-docs', input: {} },
    { toolName: 'codegraph', input: { operation: 'init' } },
    { toolName: 'codegraph', input: { operation: 'sync' } },
    { toolName: 'codegraph', input: { operation: 'status' } },
    { toolName: 'codegraph', input: {} },
    { toolName: 'codegraph' },
    {},
  ]) {
    assert.equal(pi.handlers.get('tool_call')[0](event, ctx), undefined, JSON.stringify(event));
  }
  assert.equal(typeof pi.handlers.get('tool_call')[0](searchCall('codegraph', { operation: 'explore' }), ctx)?.then, 'function', 'the two search operations are the ones that join');
  gate.release({ index: { action: 'none', ok: true }, warm: 'skipped' });
});

test('S2: a join that throws leaves the call unblocked', () => {
  const { pi, ctx } = setup({
    joinIndexWork: () => {
      throw new Error('boom');
    },
  });
  assert.equal(pi.handlers.get('tool_call')[0](searchCall(), ctx), undefined, 'a failing seam never reaches the host');
});

test('S2: a join that rejects is swallowed', async () => {
  const { pi, ctx } = setup({ joinIndexWork: () => Promise.reject(new Error('boom')) });
  assert.equal(await pi.handlers.get('tool_call')[0](searchCall(), ctx), undefined);
});

test('S2: a join that never settles is capped by its budget and never blocks the tool', async () => {
  let askedMs;
  const { pi, ctx } = setup({
    joinIndexWork: () => new Promise(() => {}),
    delay: (ms) => {
      askedMs = ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
  });
  const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
  assert.equal(typeof returned?.then, 'function');
  assert.equal(await returned, undefined, 'the budget ends the wait, not the work');
  assert.equal(askedMs, 5000, 'the default budget is five seconds');
});

test('S2: a delay seam that throws still ends the wait instead of awaiting work that never settles', async () => {
  const { pi, ctx } = setup({
    env: { ODD_WORKTREE_CODEGRAPH_JOIN_MS: '250' },
    joinIndexWork: () => new Promise(() => {}),
    delay: () => {
      throw new Error('no timer here');
    },
  });
  const started = Date.now();
  const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
  assert.equal(typeof returned?.then, 'function', 'the search still gets an answer to wait for');
  let guard;
  const capped = new Promise((resolve) => {
    guard = setTimeout(() => resolve('unbounded'), 1_000);
  });
  try {
    assert.equal(await Promise.race([returned, capped]), undefined, 'a throwing timer seam answers at once, never with the joined work');
  } finally {
    clearTimeout(guard);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `the wait settled well inside the small bound (${elapsed}ms)`);
});

test('S2: the join budget is five seconds, overridable, and 0 disables the join entirely', () => {
  const asked = [];
  const joinIndexWork = (root, budgetMs) => {
    asked.push([root, budgetMs]);
    return undefined;
  };
  for (const [env, expected] of [
    [{}, 5000],
    [{ ODD_WORKTREE_CODEGRAPH_JOIN_MS: '250' }, 250],
    [{ ODD_WORKTREE_CODEGRAPH_JOIN_MS: '0' }, 0],
    [{ ODD_WORKTREE_CODEGRAPH_JOIN_MS: 'later' }, 5000],
    [{ ODD_WORKTREE_CODEGRAPH_JOIN_MS: '-5' }, 5000],
  ]) {
    const { pi, ctx } = setup({ joinIndexWork, env });
    const returned = pi.handlers.get('tool_call')[0](searchCall(), ctx);
    const label = JSON.stringify(env);
    assert.equal(returned, undefined, `${label}: the seam answered nothing to wait for`);
    if (expected === 0) {
      assert.equal(asked.length, 0, 'a disabled join is not even attempted');
      continue;
    }
    assert.deepEqual(asked.pop(), ['/work/repo', expected], label);
  }
  assert.deepEqual(asked, []);
});

test('a kept Codegraph+ switch wires the MCP entry and the agents; any other switch is not CodeGraph\'s', async () => {
  const fs = require('node:fs');
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-switch-agent-'));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-switch-home-'));
  try {
    const env = { PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_CONFIG_HOME: configHome };
    assert.equal(await onCodegraphSwitch('worktrees', true, { env }), undefined);
    assert.deepEqual([fs.readdirSync(agentDir), fs.readdirSync(configHome)], [[], []], 'another switch writes nothing');
    const on = await onCodegraphSwitch('codegraph', true, { env });
    assert.equal(on.mcp.status, 'added');
    assert.equal(on.tools.status, 'created');
    assert.ok(JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers.codegraph);
    const off = await onCodegraphSwitch('codegraph', false, { env });
    assert.equal(off.tools.status, 'updated');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configHome, 'tools.json'), 'utf8')), {});
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

'use strict';
// T5: the one place that wires CodeGraph into a session: session start (the global MCP entry, create-or-sync, the warm-up),
// compaction, the observed native init, the edit/write sync and shutdown. Only with the CLI installed, and nothing here may
// throw into the host. Every collaborator is injected, so no test runs codegraph, a daemon or touches a real agent directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { registerCodegraph } = require('../lib/codegraph-session.js');

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
  const calls = { mcp: [], prepare: [], compaction: [], init: [], edit: [], card: [], dispose: 0, notices: [] };
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
    createCodegraphCardResolver: (options) => {
      calls.card.push(options);
      return { registered: true };
    },
    ...(overrides.impl || {}),
  };
  const result = registerCodegraph(pi, {
    metrics: overrides.metrics || (() => ({ metrics: true })),
    env: { PI_CODING_AGENT_DIR: '/agent', ...(overrides.env || {}) },
    hasBinary: overrides.hasBinary || (() => true),
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

test('without the CodeGraph CLI nothing is registered at all', () => {
  const { pi, result } = setup({ hasBinary: () => false });
  assert.equal(result.registered, false);
  assert.equal(pi.handlers.size, 0);
});

test('the CodeGraph card is registered once through the host hook, with the extension\'s own text metrics', () => {
  const registered = [];
  const { calls, pi } = setup();
  assert.equal(calls.card.length, 1);
  assert.deepEqual(calls.card[0].metrics(), { metrics: true });
  assert.equal(typeof calls.card[0].registerToolRenderer, 'function');
  pi.registerToolRenderer = (resolver) => registered.push(resolver);
  calls.card[0].registerToolRenderer('resolver');
  assert.deepEqual(registered, ['resolver'], 'the hook is looked up when it is used');
});

test('a host without the renderer hook is given no registration to call', () => {
  const { calls } = setup();
  assert.equal(calls.card[0].registerToolRenderer('x'), undefined, 'a missing hook is a no-op, never a throw');
});

test('without the CLI the card is not registered either', () => {
  const { calls } = setup({ hasBinary: () => false });
  assert.equal(calls.card.length, 0);
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

test('a successful native init is followed by one coordinated sync and its outcome is appended to the result', async () => {
  const { calls, run } = setup();
  const patch = await run('tool_result', {
    toolName: 'codegraph',
    input: { operation: 'init' },
    isError: false,
    content: [{ type: 'text', text: 'initialized' }],
  });
  assert.equal(calls.init.length, 1);
  assert.equal(calls.init[0].cwd, '/work/repo');
  assert.equal(patch.content.length, 2);
  assert.equal(patch.content[0].text, 'initialized', 'the tool result is kept whole');
  assert.match(patch.content[1].text, /sync completed/);
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

test('a read-only role gets the skipped line and no sync', async () => {
  const { calls, run } = setup({ env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash,codegraph' } });
  const patch = await run('tool_result', { toolName: 'codegraph', input: { operation: 'init' }, isError: false, content: [] });
  assert.equal(calls.init.length, 0);
  assert.match(patch.content[0].text, /read-only/);
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

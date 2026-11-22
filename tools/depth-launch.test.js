'use strict';
// `/depth`'s launch (S4, S5, S8): the command starts ONE background `gentle-ai-explore` through the host's own
// `subagent_run` tool, with the Depth task and nothing else. Progress, cancellation and the delivery of the handoff are
// gentle-agents', so this module has no widget, no timer and no message of its own; it only decides whether the launch can
// happen and says in one sentence what did or did not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchDepth, DEPTH_AGENT, DEPTH_TOOL } = require('../lib/depth-launch.js');
const { DEPTH_RETURN_HEADINGS } = require('../lib/depth-task.js');

const STARTED = {
  content: [{ type: 'text', text: 'Started gentle-ai-explore in the background as task abc-1.' }],
  details: {},
};

function host({ outcome = STARTED, tools = [{ name: 'subagent_run' }, { name: 'job_list' }], throws } = {}) {
  const calls = [];
  const ctx = {
    tools,
    executeTool: async (name, args) => {
      calls.push({ name, args });
      if (throws) throw throws;
      return outcome;
    },
  };
  return { ctx, calls };
}

test('the names the launch depends on are the host agent and tool', () => {
  assert.equal(DEPTH_AGENT, 'gentle-ai-explore');
  assert.equal(DEPTH_TOOL, 'subagent_run');
});

test('it starts one background explorer, with exactly the arguments the host tool accepts', async () => {
  const { ctx, calls } = host();
  const request = 'make the error messages clearer\n\n- keep «exactly» this';
  const result = await launchDepth(request, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'subagent_run');
  // `subagent_run` rejects any other key (additionalProperties: false), so the set is closed.
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['agent', 'label', 'mode', 'task']);
  assert.equal(calls[0].args.agent, 'gentle-ai-explore');
  assert.equal(calls[0].args.mode, 'background');
  assert.equal(calls[0].args.label, 'depth: make the error messages clearer');
  assert.ok(calls[0].args.task.endsWith(`## Request\n\n${request}`), 'the request goes in verbatim, last');
  for (const heading of DEPTH_RETURN_HEADINGS) assert.ok(calls[0].args.task.includes(heading), heading);

  assert.deepEqual(result, {
    ok: true,
    level: 'info',
    message: 'Exploring in the background (depth: make the error messages clearer). The handoff arrives in this session when it finishes.',
  });
});

test('a blank request starts nothing and says how to use the command', async () => {
  for (const blank of ['', '  \n', undefined, null]) {
    const { ctx, calls } = host();
    const result = await launchDepth(blank, ctx);
    assert.equal(calls.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.level, 'error');
    assert.match(result.message, /^\/depth needs a request: \/depth <request>\./);
    assert.match(result.message, /does not see this chat/);
  }
});

test('without the host tool nothing starts, and the sentence names the tool', async () => {
  const noTool = { executeTool: async () => assert.fail('must not be called') };
  const cases = [
    { ...noTool },
    { ...noTool, tools: [] },
    { ...noTool, tools: [{ name: 'job_list' }] },
    { ...noTool, tools: 'subagent_run' },
    { tools: [{ name: 'subagent_run' }] },
    undefined,
    null,
  ];
  for (const ctx of cases) {
    const result = await launchDepth('fix the login', ctx);
    assert.equal(result.ok, false);
    assert.equal(result.level, 'error');
    assert.match(result.message, /subagent_run/);
    assert.match(result.message, /does not offer it/);
  }
});

test('a refusal from the host tool is shown with its own words', async () => {
  const { ctx, calls } = host({ outcome: { isError: true, content: [{ type: 'text', text: 'Background subagents need an interactive session.' }] } });
  const result = await launchDepth('fix the login', ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    ok: false,
    level: 'error',
    message: "/depth couldn't start the explorer: Background subagents need an interactive session.",
  });
});

test('a refusal with no text, a thrown error and an empty answer each become one sentence', async () => {
  const silent = await launchDepth('x', host({ outcome: { isError: true, content: [] } }).ctx);
  assert.equal(silent.message, "/depth couldn't start the explorer: the subagent_run tool reported an error.");

  const thrown = await launchDepth('x', host({ throws: new Error('boom') }).ctx);
  assert.equal(thrown.ok, false);
  assert.equal(thrown.message, "/depth couldn't start the explorer: boom");

  // `null`, not `undefined`: the double's default parameter would turn `undefined` into a successful start.
  const empty = await launchDepth('x', host({ outcome: null }).ctx);
  assert.equal(empty.ok, false);
  assert.match(empty.message, /^\/depth couldn't start the explorer:/);
});

test('a hostile context never makes it throw', async () => {
  const hostile = {
    get tools() {
      throw new Error('no tools for you');
    },
    executeTool: async () => STARTED,
  };
  const result = await launchDepth('fix the login', hostile);
  assert.equal(result.ok, false);
  assert.match(result.message, /subagent_run/);
});

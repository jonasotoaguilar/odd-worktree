'use strict';
// `/depth` through the registered command (S4, S5, S6): the extension's one new command starts the explorer by itself,
// through the host's `subagent_run` tool, and answers with one notice. The launch rules are in tools/depth-launch.test.js;
// this suite proves the command is wired to them in the loaded extension, behind the same gate as the others.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension } = require('./fixtures/load-extension.js');

function makeCtx({ tools = [{ name: 'subagent_run' }], outcome = { content: [{ type: 'text', text: 'Started gentle-ai-explore in the background as task t-1.' }] } } = {}) {
  const calls = [];
  const notes = [];
  const ctx = {
    tools,
    executeTool: async (name, args) => {
      calls.push({ name, args });
      return outcome;
    },
    ui: { notify: (message, level) => notes.push({ message, level }) },
  };
  return { ctx, calls, notes };
}

test('/depth is a registered command that says what it does', async () => {
  const { commands } = await loadExtension({});
  const depth = commands.get('depth');
  assert.ok(depth, '/depth is registered');
  assert.equal(typeof depth.handler, 'function');
  assert.match(depth.description, /background/);
});

test('/depth <request> starts one background explorer with the request verbatim and says so', async () => {
  const { commands } = await loadExtension({});
  const { ctx, calls, notes } = makeCtx();
  await commands.get('depth').handler('  make the error messages clearer  ', ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'subagent_run');
  assert.equal(calls[0].args.agent, 'gentle-ai-explore');
  assert.equal(calls[0].args.mode, 'background');
  assert.ok(calls[0].args.task.endsWith('## Request\n\nmake the error messages clearer'));
  assert.deepEqual(notes, [
    { message: 'Exploring in the background (depth: make the error messages clearer). The handoff arrives in this session when it finishes.', level: 'info' },
  ]);
});

test('/depth with no request starts nothing and shows the usage as an error', async () => {
  const { commands } = await loadExtension({});
  const { ctx, calls, notes } = makeCtx();
  await commands.get('depth').handler('', ctx);
  assert.equal(calls.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, 'error');
  assert.match(notes[0].message, /^\/depth needs a request: \/depth <request>\./);
});

test('/depth without the host tool says so, and a context with no ui does not throw', async () => {
  const { commands } = await loadExtension({});
  const { ctx, calls, notes } = makeCtx({ tools: [] });
  await commands.get('depth').handler('fix the login', ctx);
  assert.equal(calls.length, 0);
  assert.match(notes[0].message, /subagent_run/);
  assert.equal(notes[0].level, 'error');

  await assert.doesNotReject(commands.get('depth').handler('fix the login', { tools: [], executeTool: async () => ({}) }));
  await assert.doesNotReject(commands.get('depth').handler(undefined, undefined));
});

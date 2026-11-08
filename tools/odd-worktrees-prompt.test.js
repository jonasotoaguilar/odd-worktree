'use strict';
// S7: the `## ODD worktrees` section and its append-only injection. The two
// texts are the contract, so they are asserted verbatim; the gate is injected
// so no test depends on whether the machine has the CLI.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const prompt = require('../lib/odd-worktrees-prompt.js');

const fs = require('node:fs');
const path = require('node:path');

const PROMPT_DIR = path.resolve(__dirname, '..', 'lib', 'odd-prompt');
const WITH_FILE = path.join(PROMPT_DIR, 'odd-worktrees.with-codegraph.md');
const WITHOUT_FILE = path.join(PROMPT_DIR, 'odd-worktrees.without-codegraph.md');
const WITH_CODEGRAPH = fs.readFileSync(WITH_FILE, 'utf8').trim();
const WITHOUT_CODEGRAPH = fs.readFileSync(WITHOUT_FILE, 'utf8').trim();

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

function clearEnv() {
  delete process.env.ODD_WORKTREE_PROMPT;
  delete process.env.GENTLE_PI_AGENTS_CHILD;
}

function run(event, deps = {}) {
  return prompt.appendOddWorktreesSection(event, deps);
}

const present = () => true;
const absent = () => false;
const primaryEvent = (options) => ({ systemPromptOptions: options });

describe('section text', () => {
  test('the CodeGraph variant is exactly the specified text', () => {
    const options = {};
    assert.equal(run(primaryEvent(options), { env: {}, hasCodegraph: present }), undefined);
    assert.equal(options.appendSystemPrompt, WITH_CODEGRAPH);
  });

  test('the variant without CodeGraph is exactly the specified text', () => {
    const options = {};
    run(primaryEvent(options), { env: {}, hasCodegraph: absent });
    assert.equal(options.appendSystemPrompt, WITHOUT_CODEGRAPH);
  });
});

describe('append-only injection', () => {
  test('existing harness text is preserved verbatim and the block follows it', () => {
    const harness = 'You are Pi.\n\nUse the tools.';
    const options = { appendSystemPrompt: harness };
    run(primaryEvent(options), { env: {}, hasCodegraph: absent });
    assert.ok(options.appendSystemPrompt.startsWith(harness), 'existing text is the prefix');
    assert.equal(options.appendSystemPrompt, `${harness}\n\n${WITHOUT_CODEGRAPH}`);
  });

  test('a trailing newline in the existing text keeps the separator minimal', () => {
    const harness = 'You are Pi.\n';
    const options = { appendSystemPrompt: harness };
    run(primaryEvent(options), { env: {}, hasCodegraph: absent });
    assert.equal(options.appendSystemPrompt, `${harness}\n${WITHOUT_CODEGRAPH}`);
  });

  test('never returns or assigns systemPrompt', () => {
    const event = { systemPromptOptions: {}, systemPrompt: 'harness-owned' };
    const returned = run(event, { env: {}, hasCodegraph: absent });
    assert.equal(returned, undefined);
    assert.equal(event.systemPrompt, 'harness-owned');
    assert.ok(!('systemPrompt' in event.systemPromptOptions));
  });

  test('idempotent across two calls', () => {
    const options = {};
    run(primaryEvent(options), { env: {}, hasCodegraph: present });
    const once = options.appendSystemPrompt;
    run(primaryEvent(options), { env: {}, hasCodegraph: present });
    assert.equal(options.appendSystemPrompt, once);
    assert.equal(options.appendSystemPrompt, WITH_CODEGRAPH);
  });

  test('a variant switch mid-session never duplicates the heading', () => {
    const options = {};
    run(primaryEvent(options), { env: {}, hasCodegraph: absent });
    run(primaryEvent(options), { env: {}, hasCodegraph: present });
    const headings = options.appendSystemPrompt.split('## ODD worktrees').length - 1;
    assert.equal(headings, 1, 'the section is injected once, whatever the variant');
  });
});

describe('session gating', () => {
  test('a named agent gets nothing', () => {
    for (const event of [
      { agentName: 'worker', systemPromptOptions: {} },
      { agent: 'worker', systemPromptOptions: {} },
      { agent: { name: 'worker' }, systemPromptOptions: {} },
      { name: 'worker', systemPromptOptions: {} },
      { subagent: { name: 'worker' }, systemPromptOptions: {} },
    ]) {
      run(event, { env: {}, hasCodegraph: present });
      assert.equal(event.systemPromptOptions.appendSystemPrompt, undefined);
    }
  });

  test('a GENTLE_PI_AGENTS_CHILD worker gets nothing', () => {
    clearEnv();
    process.env.GENTLE_PI_AGENTS_CHILD = '1';
    const options = {};
    run(primaryEvent(options), { env: process.env, hasCodegraph: present });
    assert.equal(options.appendSystemPrompt, undefined);
  });

  test('ODD_WORKTREE_PROMPT=0 suppresses the block entirely', () => {
    clearEnv();
    process.env.ODD_WORKTREE_PROMPT = '0';
    const options = {};
    run(primaryEvent(options), { env: process.env, hasCodegraph: present });
    assert.equal(options.appendSystemPrompt, undefined);
  });

  test('missing systemPromptOptions is a no-op that never throws', () => {
    assert.doesNotThrow(() => run({}, { env: {}, hasCodegraph: present }));
    assert.doesNotThrow(() => run(undefined, { env: {}, hasCodegraph: present }));
    assert.doesNotThrow(() => run({ systemPromptOptions: null }, { env: {}, hasCodegraph: present }));
  });
});

describe('extension wiring (T3)', () => {
  test('before_agent_start appends the section to the prompt options', async () => {
    clearEnv();
    const { loadExtension } = require('./fixtures/load-extension.js');
    const { hooks } = await loadExtension({});
    const handlers = hooks.filter(([name]) => name === 'before_agent_start').map(([, handler]) => handler);
    assert.equal(handlers.length, 1, 'exactly one before_agent_start handler');
    const options = {};
    await handlers[0]({ systemPromptOptions: options }, { cwd: os.tmpdir() });
    assert.ok(
      options.appendSystemPrompt === WITH_CODEGRAPH || options.appendSystemPrompt === WITHOUT_CODEGRAPH,
      'the injected block is one of the two exact variants',
    );
    assert.doesNotThrow(() => handlers[0]({}, {}));
  });
});

describe('the section is prose on disk', () => {
  test('both variants live in their own Markdown file and are what gets injected', () => {
    assert.ok(fs.existsSync(WITH_FILE), 'the CodeGraph variant file exists');
    assert.ok(fs.existsSync(WITHOUT_FILE), 'the plain variant file exists');
    assert.equal(prompt.WITH_CODEGRAPH, WITH_CODEGRAPH);
    assert.equal(prompt.WITHOUT_CODEGRAPH, WITHOUT_CODEGRAPH);
  });

  test('each file opens with the section heading that makes injection idempotent', () => {
    for (const text of [WITH_CODEGRAPH, WITHOUT_CODEGRAPH]) {
      assert.ok(text.startsWith('## ODD worktrees'), text.split('\n')[0]);
    }
  });

  test('only the CodeGraph variant mentions CodeGraph', () => {
    assert.match(WITH_CODEGRAPH, /codegraph init/);
    assert.match(WITH_CODEGRAPH, /codegraph sync/);
    assert.doesNotMatch(WITHOUT_CODEGRAPH, /codegraph/i);
  });

  test('neither variant instructs the agent to warp', () => {
    for (const text of [WITH_CODEGRAPH, WITHOUT_CODEGRAPH]) {
      assert.doesNotMatch(text, /worktree_warp/);
      assert.doesNotMatch(text, /move the session/i);
    }
  });
});

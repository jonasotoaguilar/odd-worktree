'use strict';
// S7: the `## ODD worktrees` section and its append-only injection. The text is
// the contract, so it is asserted verbatim. There is exactly ONE section: the
// package promises no CodeGraph work, so no gate and no variant selection.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const prompt = require('../lib/odd-worktrees-prompt.js');

const fs = require('node:fs');
const path = require('node:path');

const PROMPT_DIR = path.resolve(__dirname, '..', 'lib', 'odd-prompt');
const SECTION_FILE = path.join(PROMPT_DIR, 'odd-worktrees.md');
const SECTION = fs.readFileSync(SECTION_FILE, 'utf8').trim();

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

const primaryEvent = (options) => ({ systemPromptOptions: options });

describe('section text', () => {
  test('the section is exactly the specified text', () => {
    const options = {};
    assert.equal(run(primaryEvent(options), { env: {} }), undefined);
    assert.equal(options.appendSystemPrompt, SECTION);
  });
});

describe('append-only injection', () => {
  test('existing harness text is preserved verbatim and the block follows it', () => {
    const harness = 'You are Pi.\n\nUse the tools.';
    const options = { appendSystemPrompt: harness };
    run(primaryEvent(options), { env: {} });
    assert.ok(options.appendSystemPrompt.startsWith(harness), 'existing text is the prefix');
    assert.equal(options.appendSystemPrompt, `${harness}\n\n${SECTION}`);
  });

  test('a trailing newline in the existing text keeps the separator minimal', () => {
    const harness = 'You are Pi.\n';
    const options = { appendSystemPrompt: harness };
    run(primaryEvent(options), { env: {} });
    assert.equal(options.appendSystemPrompt, `${harness}\n${SECTION}`);
  });

  test('never returns or assigns systemPrompt', () => {
    const event = { systemPromptOptions: {}, systemPrompt: 'harness-owned' };
    const returned = run(event, { env: {} });
    assert.equal(returned, undefined);
    assert.equal(event.systemPrompt, 'harness-owned');
    assert.ok(!('systemPrompt' in event.systemPromptOptions));
  });

  test('idempotent across two calls', () => {
    const options = {};
    run(primaryEvent(options), { env: {} });
    const once = options.appendSystemPrompt;
    run(primaryEvent(options), { env: {} });
    assert.equal(options.appendSystemPrompt, once);
    assert.equal(options.appendSystemPrompt, SECTION);
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
      run(event, { env: {} });
      assert.equal(event.systemPromptOptions.appendSystemPrompt, undefined);
    }
  });

  test('a GENTLE_PI_AGENTS_CHILD worker gets nothing', () => {
    clearEnv();
    process.env.GENTLE_PI_AGENTS_CHILD = '1';
    const options = {};
    run(primaryEvent(options), { env: process.env });
    assert.equal(options.appendSystemPrompt, undefined);
  });

  test('ODD_WORKTREE_PROMPT=0 suppresses the block entirely', () => {
    clearEnv();
    process.env.ODD_WORKTREE_PROMPT = '0';
    const options = {};
    run(primaryEvent(options), { env: process.env });
    assert.equal(options.appendSystemPrompt, undefined);
  });

  test('missing systemPromptOptions is a no-op that never throws', () => {
    assert.doesNotThrow(() => run({}, { env: {} }));
    assert.doesNotThrow(() => run(undefined, { env: {} }));
    assert.doesNotThrow(() => run({ systemPromptOptions: null }, { env: {} }));
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
    assert.equal(options.appendSystemPrompt, SECTION, 'the injected block is the one exact section');
    assert.doesNotThrow(() => handlers[0]({}, {}));
  });
});

describe('the section is prose on disk', () => {
  test('the section lives in its own Markdown file and is what gets injected', () => {
    assert.ok(fs.existsSync(SECTION_FILE), 'the section file exists');
    assert.equal(prompt.SECTION, SECTION);
  });

  test('the file opens with the section heading that makes injection idempotent', () => {
    assert.ok(SECTION.startsWith('## ODD worktrees'), SECTION.split('\n')[0]);
  });

  test('the one section promises no CodeGraph work', () => {
    assert.doesNotMatch(SECTION, /codegraph/i);
  });

  test('the section states the checkout naming rule once, as the ODD', () => {
    const prose = SECTION.replace(/\s+/g, ' ');
    assert.equal(
      SECTION.match(/<repo-parent>\/<repo-name>-worktrees\//g).length,
      1,
      'the destination is stated once',
    );
    assert.match(prose, /directory IS the ODD/);
    assert.doesNotMatch(prose, /defaults to the branch/i);
    assert.doesNotMatch(prose, /first segment/i);
    assert.doesNotMatch(prose, /<name>/);
  });

  test('the section never instructs the agent to warp', () => {
    assert.doesNotMatch(SECTION, /worktree_warp/);
    assert.doesNotMatch(SECTION, /move the session/i);
  });
});

// The policy the block states, in its three paragraphs.
describe('the section states the worktree policy', () => {
  const prose = () => SECTION.replace(/\s+/g, ' ');

  test('a worktree is the ODD: find the assignment, resume it, create it, carry pending work', () => {
    const text = prose();
    assert.match(text, /A worktree lives at `/, text);
    assert.match(text, /directory IS the ODD/, text);
    assert.match(text, /`worktree_list` finds existing assignments, so resume one instead of duplicating it/, text);
    assert.match(text, /`worktree_create` creates it/, text);
    assert.match(text, /carry them with `copy_changes: true`/, text);
  });

  test('one ODD, one worktree, and parallel subagents that edit different files', () => {
    const text = prose();
    assert.match(text, /One ODD, one worktree\./, text);
    assert.match(text, /Work on the same feature goes into its ODD, adding tasks/, text);
    assert.match(text, /a different feature is a different ODD, with another worktree/, text);
    assert.match(text, /delegate several subagents in parallel/, text);
    assert.match(text, /as long as they do not edit the same files/, text);
  });

  test('after the merge the branch is kept and the worktree removed, unless a session stands there', () => {
    const text = prose();
    assert.match(text, /After the merge, keep the branch and remove the worktree, unless a session is standing in that checkout/, text);
    assert.doesNotMatch(text, /never remove/i);
  });

  // The rule only: no removal mechanism reaches the agent, because none is the
  // agent's. This is the whole point of the paragraph.
  test('the section names no removal mechanism', () => {
    assert.doesNotMatch(SECTION, /ctrl\+d|git worktree remove|worktree_remove|\/warp/);
  });
});

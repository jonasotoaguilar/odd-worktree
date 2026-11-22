'use strict';
// S7 and (T3) S5: the `## ODD worktrees` section and its append-only injection. The
// text is the contract, so it is asserted verbatim. There is exactly ONE primary
// section, plus the one short block a child that WRITES gets (S5): the same heading,
// its own file, and only for the three kinds of writing child.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const prompt = require('../lib/odd-worktrees-prompt.js');

const fs = require('node:fs');
const path = require('node:path');

const PROMPT_DIR = path.resolve(__dirname, '..', 'lib', 'odd-prompt');
const SECTION_FILE = path.join(PROMPT_DIR, 'odd-worktrees.md');
const SECTION = fs.readFileSync(SECTION_FILE, 'utf8').trim();

// S5: the one-line block a CHILD that writes gets. It lives in its own file, so it is
// read here the way it is read on disk; a file that is gone fails the cases below.
const CHILD_FILE = path.join(PROMPT_DIR, 'odd-worktrees-child.md');
const childSection = () => fs.readFileSync(CHILD_FILE, 'utf8').trim();

// The argv a subagent child really runs with: one directory named after the agent.
function childArgv(agent) {
  if (typeof agent !== 'string') return ['node', path.join(os.tmpdir(), 'plain-agent', 'instructions.md')];
  return ['node', path.join(os.tmpdir(), `gentle-pi-subagent-${agent}-ab12cd`, 'instructions.md')];
}

const CHILD_ENV = { GENTLE_PI_AGENTS_CHILD: '1' };

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

  test('a GENTLE_PI_AGENTS_CHILD session gets the child block, never the primary one', () => {
    clearEnv();
    process.env.GENTLE_PI_AGENTS_CHILD = '1';
    const options = {};
    run(primaryEvent(options), { env: process.env });
    assert.equal(options.appendSystemPrompt, childSection(), 'a child whose name cannot be read is the generic child');
    assert.notEqual(options.appendSystemPrompt, SECTION);
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
    assert.ok(handlers.length >= 1, 'the section has a before_agent_start handler');
    const options = {};
    for (const handler of handlers) await handler({ systemPromptOptions: options }, { cwd: os.tmpdir() });
    assert.equal(options.appendSystemPrompt, SECTION, 'the injected block is the one exact section, appended once');
    for (const handler of handlers) assert.doesNotThrow(() => handler({}, {}));
  });
});

// ---------------------------------------------------------------------------
// S5: the child block — one short line, and only for a child that writes.
// ---------------------------------------------------------------------------
describe('S5: a child that writes gets one short block', () => {
  test('the block lives in its own file, opens with the idempotency heading and states the rule in two sentences at most', () => {
    const text = childSection();
    assert.ok(text.startsWith('## ODD worktrees'), text.split('\n')[0]);
    assert.match(text.replace(/\s+/g, ' '), /work only under the worktree of your workspace root/i);
    assert.match(text.replace(/\s+/g, ' '), /primary checkout on the default branch/i);
    assert.match(text.replace(/\s+/g, ' '), /stop and report/i);
    assert.match(text.replace(/\s+/g, ' '), /instead of writing/i);
    const sentences = (text.replace(/\s+/g, ' ').match(/[.!?](\s|$)/g) || []).length;
    assert.ok(sentences <= 2, `two sentences at most, got ${sentences}`);
    assert.notEqual(text, SECTION, 'the child block is not the primary block');
  });

  test('gentle-ai-worker, jd-fix-agent and a child whose agent name cannot be read get it', () => {
    for (const agent of ['gentle-ai-worker', 'jd-fix-agent', undefined]) {
      const options = {};
      run(primaryEvent(options), { env: CHILD_ENV, argv: childArgv(agent) });
      assert.equal(options.appendSystemPrompt, childSection(), String(agent));
    }
  });

  test('a child whose name is outside the table is the generic child, and gets it too', () => {
    const options = {};
    run(primaryEvent(options), { env: CHILD_ENV, argv: childArgv('some-unknown-agent') });
    assert.equal(options.appendSystemPrompt, childSection());
  });

  test('explore, verify, the two judges and every review-* child get nothing', () => {
    for (const agent of ['gentle-ai-explore', 'gentle-ai-verify', 'jd-judge-a', 'jd-judge-b', 'review-a', 'review-verify']) {
      const options = {};
      run(primaryEvent(options), { env: CHILD_ENV, argv: childArgv(agent) });
      assert.equal(options.appendSystemPrompt, undefined, agent);
    }
  });

  test('a child block is appended after the harness text and is idempotent', () => {
    const harness = 'You are Pi.\n\nUse the tools.';
    const options = { appendSystemPrompt: harness };
    run(primaryEvent(options), { env: CHILD_ENV, argv: childArgv('gentle-ai-worker') });
    assert.ok(options.appendSystemPrompt.startsWith(harness), 'existing text is the prefix');
    assert.equal(options.appendSystemPrompt, `${harness}\n\n${childSection()}`);
    const once = options.appendSystemPrompt;
    run(primaryEvent(options), { env: CHILD_ENV, argv: childArgv('gentle-ai-worker') });
    assert.equal(options.appendSystemPrompt, once, 'a second call adds nothing');
  });

  test('ODD_WORKTREE_PROMPT=0 suppresses the child block too', () => {
    const options = {};
    run(primaryEvent(options), { env: { ...CHILD_ENV, ODD_WORKTREE_PROMPT: '0' }, argv: childArgv('gentle-ai-worker') });
    assert.equal(options.appendSystemPrompt, undefined);
  });

  test('the primary session keeps its own block, unchanged', () => {
    const options = {};
    run(primaryEvent(options), { env: {}, argv: childArgv('gentle-ai-worker') });
    assert.equal(options.appendSystemPrompt, SECTION, 'a primary session gets the primary block');
    assert.notEqual(SECTION, childSection());
  });

  test('a missing child file falls back to the heading alone, never a crash', () => {
    const missing = path.join(os.tmpdir(), `odd-prompt-missing-${process.pid}`, 'odd-worktrees-child.md');
    assert.equal(prompt.readPromptFile(missing), null);
    assert.equal(prompt.sectionFromFile(missing, prompt.CHILD_FALLBACK), prompt.CHILD_FALLBACK);
    assert.equal(prompt.CHILD_FALLBACK.trim(), '## ODD worktrees');
    assert.equal(prompt.CHILD_SECTION, childSection());
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

// The policy the block states, in its five paragraphs.
describe('the section states the worktree policy', () => {
  const prose = () => SECTION.replace(/\s+/g, ' ');

  test('the work happens in the ODD\'s worktree, never in the primary checkout or on the default branch', () => {
    const text = prose();
    assert.match(text, /Every write goes in a worktree, whatever the size of the task, a one-line fix included\. Never write in the primary checkout or on the default branch/, text);
    assert.doesNotMatch(text, /An ODD writes/, 'no task size decides whether the rule applies');
    assert.match(text, /Reading anywhere is fine, and a request that stays read-only needs no worktree/, text);
    // The rule is the premise: it opens the section, before the worktree is described.
    assert.ok(text.indexOf('Never write in the primary checkout') < text.indexOf('A worktree lives at'), text);
  });

  test('a worktree is the ODD: find the assignment, resume it, create it, carry pending work', () => {
    const text = prose();
    assert.match(text, /A worktree lives at `/, text);
    assert.match(text, /directory IS the ODD/, text);
    assert.match(text, /Before your first `edit` or `write`: 1\. Run `worktree_list`\./, text);
    assert.match(text, /2\. If the ODD has a worktree, work there\./, text);
    assert.match(text, /3\. If not, run `worktree_create`/, text);
    assert.match(text, /`copy_changes: true` if the pending changes of the current checkout belong to that work/, text);
  });

  test('one ODD, one worktree', () => {
    const text = prose();
    assert.match(text, /One ODD, one worktree\./, text);
    assert.match(text, /An ODD is one request and its follow-ups, big or small: everything that belongs to it goes into the same ODD and worktree/, text);
    assert.match(text, /an unrelated request is another ODD with its own worktree/, text);
    assert.doesNotMatch(text, /area of work/i, 'the unit is a request, never an area of the code');
  });

  test('independent units are delegated in parallel, each into the ODD\'s worktree, and never onto the same file', () => {
    const text = prose();
    assert.match(text, /Delegate an ODD's independent units of behavior to agents in parallel, each with the `workspace_root` of that ODD's worktree; the only limit is that two agents never edit the same file/, text);
    assert.doesNotMatch(text, /same or different worktrees/, 'one ODD has one worktree, so the choice does not exist');
  });

  test('after the merge the default branch is always updated; only the removal waits for a dirty tree or a session standing there', () => {
    const text = prose();
    assert.match(text, /After the merge, update the default branch\. Then remove the worktree, keeping its branch, unless its tree is dirty or a session is standing in it/, text);
    assert.doesNotMatch(text, /never remove/i);
  });

  // The rule only: no removal mechanism reaches the agent, because none is the
  // agent's. This is the whole point of the paragraph.
  test('the section names no removal mechanism', () => {
    assert.doesNotMatch(SECTION, /ctrl\+d|git worktree remove|worktree_remove|\/warp/);
  });
});

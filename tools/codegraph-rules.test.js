'use strict';
// The `## CodeGraph` section: one approved text per role, selected from the
// session's own facts and appended to the prompt options. The package runs,
// probes and writes no CodeGraph; the section only advises a session that
// already holds a CodeGraph tool. The texts are read from disk, never hardcoded.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rules = require('../lib/codegraph-rules.js');

const DIR = rules.PROMPT_DIR;
const file = (variant) => fs.readFileSync(path.join(DIR, `${variant}.md`), 'utf8').trim();
const MCP = 'mcp__codegraph__codegraph_explore';

function run(options, env, argv) {
  const event = { systemPromptOptions: options };
  const returned = rules.appendCodegraphSection(event, { env, argv });
  assert.equal(returned, undefined, 'the mutation is the whole contract');
  return options.appendSystemPrompt;
}

const child = (agent, tools = [MCP]) => ({
  env: { GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: tools.join(',') },
  argv: ['node', `/tmp/gentle-pi-subagent-${agent}-ab12cd/instructions.md`],
});

describe('the seven texts on disk', () => {
  const prose = (variant) => file(variant).replace(/\s+/g, ' ');

  test('every text is the CodeGraph heading and names the MCP tool, and nothing else CodeGraph', () => {
    for (const variant of rules.VARIANTS) {
      const text = file(variant);
      assert.ok(text.startsWith('## CodeGraph'), variant);
      assert.ok(text.includes(`\`${MCP}\``), `${variant} names the MCP tool in full`);
      assert.ok(text.includes('`mcp__codegraph__codegraph_explore` returns, in one call,'), `${variant} says what one call returns`);
      assert.doesNotMatch(text, /`query`|`explore`|`codegraph`|operation:|⚠/, `${variant} names no native tool, operation or icon`);
    }
    assert.doesNotMatch(rules.VARIANTS.map(file).join('\n'), /`codegraph_explore`/, 'never named without its prefix');
  });

  test('every text says what one call returns, in the terms the tool documents', () => {
    for (const variant of rules.VARIANTS) {
      const text = prose(variant);
      assert.match(text, /source verbatim with line numbers/, `${variant} names the source`);
      assert.match(text, /the call paths/, `${variant} names the relationships`);
      assert.match(text, /the tests that already touch (it|them)/, `${variant} names the existing tests`);
      assert.match(text, /what (a|the) (change|edit|patch|regression)/, `${variant} names the impact`);
    }
  });

  test('every text says how to ask, and what to do with the answer', () => {
    for (const variant of rules.VARIANTS) {
      const text = prose(variant);
      assert.match(text, /Name the symbols or files when you know them; a plain question works when you do not/, variant);
      assert.match(text, /already read: do not read them again/, `${variant} says the blocks need no second read`);
      assert.match(text, /Read the files it only names, or flags as changed on disk/, `${variant} reads the files the answer only names, and the ones it flags`);
    }
  });

  test('every text names the search it replaces', () => {
    for (const variant of rules.VARIANTS) {
      assert.match(prose(variant), /`grep`, `rg`, `fd`, `find`, `read` or `cat`|during initial discovery/, variant);
    }
  });

  test('no text names a category instead of the situations, lists what the tool is not for, or makes it a ritual', () => {
    for (const variant of rules.VARIANTS) {
      const text = prose(variant);
      assert.doesNotMatch(text, /discovery that comes|the work that comes before|before anything is edited|not better for|stay with the direct tools|keep the direct tools|stay available|only tool you need|test leads/i, variant);
    }
  });

  test('no text explains how CodeGraph works: no index, reindex, sync or init', () => {
    for (const variant of rules.VARIANTS) {
      assert.doesNotMatch(file(variant), /index|reindex|\bsync\b|\binit\b|stale|daemon/i, variant);
    }
  });
});

describe('each role scopes the index to its own job', () => {
  const prose = (variant) => file(variant).replace(/\s+/g, ' ');

  test('the orchestrator names the four situations it meets, and what scope and size depend on', () => {
    const text = prose('orchestrator');
    for (const situation of [
      'about to change code you have not read',
      'tracing a bug or a flow across files',
      'what an edit would reach before you or a worker touch it',
      'size a task or hand it off',
    ]) {
      assert.ok(text.includes(situation), situation);
    }
    assert.match(text, /a verdict comes from the source and the tests/i, text);
  });

  test('the orchestrator keeps one exemption and one projectPath rule, and no concrete example', () => {
    const text = prose('orchestrator');
    assert.match(text, /Read an exact file path, or search an exact string, directly/, text);
    assert.match(text, /read a file before you edit it/i, text);
    assert.match(text, /Set `projectPath` when the code you need is in another worktree or another git project/, text);
    assert.match(text, /never present one workspace's answer as another's/, text);
    assert.match(text, /Refine a miss with a name the answer surfaced/, text);
    assert.doesNotMatch(file('orchestrator'), /^\|/m);
    assert.doesNotMatch(text, /colou?r|"add an option|"use the/i, 'a rule states the situation, never one example of it');
    assert.doesNotMatch(text, /authori[sz]ation|ask first/i);
  });

  test('explore replaces the chain of greps, follows the call paths and defers what code does to the source', () => {
    const text = prose('explore');
    assert.match(text, /which replaces the chain of greps and reads that would answer the same question/, text);
    assert.match(text, /Follow the call paths it returns instead of grepping for callers/, text);
    assert.match(text, /then stop/, text);
    assert.match(text, /Cite `path:line` from what it returned/, text);
    assert.match(text, /the answer says where code lives, not what it does/, text);
    assert.match(text, /Your handoff is evidence you observed/, text);
  });

  test('verify chooses probes from the index and keeps the probe as the proof', () => {
    const text = prose('verify');
    assert.match(text, /once you know what the spec requires and you need that reach to choose interaction and regression probes/, text);
    assert.match(text, /The answer is a map, never evidence/, text);
    assert.match(text, /the probe is what proves, a verdict comes from the source you read and the checks you ran/, text);
    assert.match(text, /a probe that contradicts the graph is the one that is right/, text);
    assert.match(text, /Derive your probes from the request, not from the tests it lists/, text);
    assert.match(text, /Run only the commands the parent or your role authorizes, in the required isolation/, text);
  });

  test('worker uses the index for what the edit must keep working, and never widens its scope', () => {
    const text = prose('worker');
    assert.match(text, /what the edit has to keep working/, text);
    assert.match(text, /find the implementation you should reuse instead of writing a second one/, text);
    assert.match(text, /query the old name to find what still points at it/, text);
    assert.match(text, /read a file before you edit it/i, text);
    assert.match(text, /never widens the scope you were given/, text);
    assert.match(text, /stay as delegated, and you report a needed route instead of following it/, text);
  });

  test('fix keeps the patch inside the finding\'s reach, in the checkout it is authorized to fix', () => {
    const text = prose('fix');
    assert.match(text, /the whole reach of the patch, so the fix stays inside it/, text);
    assert.match(text, /in the checkout you are authorized to fix/, text);
    assert.match(text, /Confirm the finding in the source/, text);
    assert.match(text, /never widens the patch: stay within the authorized batch and its allowed edit surfaces/, text);
  });

  test('judges sweep with the index in initial discovery and leave it aside in scoped re-judgment', () => {
    const text = prose('judge');
    assert.match(text, /Call it during initial discovery/, text);
    assert.match(text, /when this checkout is the supplied `initial_review_tree`/, text);
    assert.match(text, /The answer is a map, never proof/, text);
    assert.match(text, /confirm every finding in the supplied source at the exact location you cite/, text);
    assert.match(text, /report a relationship you have not read as unverified/, text);
    assert.match(text, /During scoped re-judgment, resolve only the frozen rows and the fix diff, and leave this tool aside/, text);
  });

  test('the generic text keeps the same criterion for a role with no text of its own', () => {
    const text = prose('generic');
    assert.match(text, /about to change code you have not read, tracing a flow or an error across files/, text);
    assert.match(text, /Read an exact file path, or search an exact string, directly/, text);
    assert.match(text, /read a file before you edit it/i, text);
  });
});

describe('selection', () => {
  test('a primary session holding the native tool gets the orchestrator text', () => {
    assert.equal(run({ selectedTools: ['codegraph', 'read'] }, {}, ['node']), file('orchestrator'));
  });

  test('each gentle-shell agent gets its own text', () => {
    const cases = {
      'gentle-ai-explore': 'explore',
      'gentle-ai-verify': 'verify',
      'gentle-ai-worker': 'worker',
      'jd-fix-agent': 'fix',
      'jd-judge-a': 'judge',
      'jd-judge-b': 'judge',
    };
    for (const [agent, variant] of Object.entries(cases)) {
      const { env, argv } = child(agent);
      assert.equal(run({ selectedTools: [] }, env, argv), file(variant), agent);
    }
  });

  test('a child whose name is unknown or unreadable gets the generic text', () => {
    const unknown = child('some-other-agent');
    assert.equal(run({ selectedTools: [] }, unknown.env, unknown.argv), file('generic'));
    assert.equal(run({ selectedTools: [] }, unknown.env, ['node', 'no-directory-here']), file('generic'));
  });

  test('the agent name is cut against the known names, so the random suffix is not part of it', () => {
    assert.equal(rules.agentNameFromArgv(['x', '/t/gentle-pi-subagent-jd-judge-a-9f/i.md']), 'jd-judge-a');
    // An unrecognised name keeps the directory's spelling; the `review-` prefix is what recognises a reviewer.
    assert.equal(rules.agentNameFromArgv(['x', '/t/gentle-pi-subagent-review-risk-9f/i.md']), 'review-risk-9f');
    assert.equal(rules.agentNameFromArgv(['x', 7, null]), undefined);
    assert.equal(rules.agentNameFromArgv(undefined), undefined);
  });

  test('both judges share one text and no variant is missing', () => {
    assert.equal(rules.VARIANT_BY_AGENT['jd-judge-a'], rules.VARIANT_BY_AGENT['jd-judge-b']);
    for (const variant of Object.values(rules.VARIANT_BY_AGENT)) assert.ok(rules.VARIANTS.includes(variant));
  });
});

describe('gates', () => {
  test('a session holding no CodeGraph tool gets nothing', () => {
    assert.equal(run({ selectedTools: ['read', 'bash'] }, {}, ['node']), undefined);
    const worker = child('gentle-ai-worker', ['read', 'edit']);
    assert.equal(run({ selectedTools: [] }, worker.env, worker.argv), undefined);
  });

  test('the MCP wildcard counts as the explore tool', () => {
    const worker = child('gentle-ai-worker', ['mcp__codegraph__*']);
    assert.equal(run({ selectedTools: [] }, worker.env, worker.argv), file('worker'));
  });

  test('a review-* agent gets nothing even when it holds a CodeGraph tool', () => {
    const reviewer = child('review-risk', [MCP, 'codegraph']);
    assert.equal(run({ selectedTools: [] }, reviewer.env, reviewer.argv), undefined);
  });

  test('ODD_WORKTREE_PROMPT=0 suppresses it with the worktrees block', () => {
    assert.equal(run({ selectedTools: ['codegraph'] }, { ODD_WORKTREE_PROMPT: '0' }, ['node']), undefined);
  });

  test('a child never gets the orchestrator text', () => {
    const { env } = child('gentle-ai-worker');
    assert.notEqual(run({ selectedTools: [] }, env, ['node']), file('orchestrator'));
  });
});

describe('append-only injection', () => {
  test('existing harness text stays the prefix and the section follows it', () => {
    const harness = 'You are Pi.\n\n## ODD worktrees\n\nText.';
    const out = run({ selectedTools: ['codegraph'], appendSystemPrompt: harness }, {}, ['node']);
    assert.equal(out, `${harness}\n\n${file('orchestrator')}`);
  });

  test('a trailing newline keeps the separator minimal', () => {
    assert.equal(
      run({ selectedTools: ['codegraph'], appendSystemPrompt: 'Harness.\n' }, {}, ['node']),
      `Harness.\n\n${file('orchestrator')}`,
    );
  });

  test('idempotent by heading, and never assigns or returns systemPrompt', () => {
    const event = { systemPromptOptions: { selectedTools: ['codegraph'] }, systemPrompt: 'harness-owned' };
    rules.appendCodegraphSection(event, { env: {}, argv: ['node'] });
    const once = event.systemPromptOptions.appendSystemPrompt;
    rules.appendCodegraphSection(event, { env: {}, argv: ['node'] });
    assert.equal(event.systemPromptOptions.appendSystemPrompt, once);
    assert.equal(event.systemPrompt, 'harness-owned');
    assert.ok(!('systemPrompt' in event.systemPromptOptions));
  });

  test('never throws on a hostile event', () => {
    for (const event of [undefined, null, {}, { systemPromptOptions: null }, { systemPromptOptions: { selectedTools: 5 } }]) {
      assert.doesNotThrow(() => rules.appendCodegraphSection(event, { env: {}, argv: ['node'] }));
    }
    const frozen = Object.freeze({ selectedTools: ['codegraph'] });
    assert.doesNotThrow(() => rules.appendCodegraphSection({ systemPromptOptions: frozen }, { env: {}, argv: ['node'] }));
  });
});

describe('a file that cannot be used', () => {
  function scratch(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rules-'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
  }

  test('a missing or heading-less text falls back to the generic one; no generic is no section', () => {
    const dir = scratch({ 'generic.md': '## CodeGraph\n\nGeneric.', 'worker.md': 'no heading here' });
    try {
      assert.equal(rules.sectionText('worker', dir), '## CodeGraph\n\nGeneric.');
      assert.equal(rules.sectionText('explore', dir), '## CodeGraph\n\nGeneric.');
      assert.equal(rules.sectionText('generic', dir), '## CodeGraph\n\nGeneric.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const empty = scratch({});
    try {
      assert.equal(rules.sectionText('worker', empty), null);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('extension wiring', () => {
  test('before_agent_start injects the section for a session that holds the tool', async () => {
    const saved = { ...process.env };
    delete process.env.GENTLE_PI_AGENTS_CHILD;
    delete process.env.ODD_WORKTREE_PROMPT;
    try {
      const { loadExtension } = require('./fixtures/load-extension.js');
      const { hooks } = await loadExtension({});
      const handlers = hooks.filter(([name]) => name === 'before_agent_start').map(([, handler]) => handler);
      assert.ok(handlers.length >= 1, 'the section has a before_agent_start handler');
      const options = { selectedTools: ['codegraph'] };
      for (const handler of handlers) await handler({ systemPromptOptions: options }, { cwd: os.tmpdir() });
      assert.equal(options.appendSystemPrompt.split('## CodeGraph').length - 1, 1, 'the section is appended once');
      assert.ok(options.appendSystemPrompt.includes(file('orchestrator')));
      assert.ok(options.appendSystemPrompt.includes('## ODD worktrees'), 'the worktrees block is still there');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

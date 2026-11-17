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
  test('each opens with the shared heading and names the same six search tools', () => {
    for (const variant of rules.VARIANTS) {
      const text = file(variant).replace(/\s+/g, ' ');
      assert.ok(text.startsWith('## CodeGraph'), variant);
      assert.match(text, /before you search or read code/, `${variant} gates searching and reading code`);
      for (const binary of ['fd', 'find', 'rg', 'grep', 'read', 'cat']) {
        assert.ok(text.includes(`\`${binary}\``), `${variant} names ${binary}`);
      }
      assert.match(text, /other tools stay|may skip it/, `${variant} leaves the other tools available`);
    }
  });

  test('no text tells an agent to create, refresh or locate an index', () => {
    for (const variant of rules.VARIANTS) {
      assert.doesNotMatch(file(variant), /\binit\b|\bsync\b|create it|no index|fall back to/i, variant);
    }
  });

  test('only the roles holding the native tool name its operations; the MCP tool is named in full', () => {
    for (const variant of ['orchestrator', 'explore']) {
      assert.match(file(variant), /`codegraph` `query`/, variant);
    }
    for (const variant of ['verify', 'worker', 'fix', 'judge']) {
      const text = file(variant);
      assert.ok(text.includes(`\`${MCP}\``), variant);
      assert.doesNotMatch(text, /`query`|`explore`|`codegraph`/, variant);
    }
    assert.doesNotMatch(file('generic'), /`query`|`explore`|`mcp__/, 'generic names no operation');
    assert.doesNotMatch(
      rules.VARIANTS.map(file).join('\n'),
      /`codegraph_explore`/,
      'the MCP tool is never named without its prefix',
    );
  });

  test('only the orchestrator points the MCP tool at another checkout, through projectPath, and still delegates', () => {
    const text = file('orchestrator').replace(/\s+/g, ' ');
    assert.ok(text.includes(`\`${MCP}\``), 'it names the MCP tool in full');
    assert.match(text, /`projectPath`/, 'it names the argument that selects the checkout');
    assert.match(text, /sibling worktree/, 'it covers a worktree of the same project');
    assert.match(text, /another git project/, 'it covers another project');
    assert.match(text, /delegate/, 'it keeps delegation for what a look does not settle');
    assert.match(text, /never present/, 'it keeps one workspace\'s answer from standing for another');
    for (const variant of rules.VARIANTS.filter((name) => name !== 'orchestrator')) {
      assert.doesNotMatch(file(variant), /projectPath/, `${variant} does not name projectPath`);
    }
  });
});

describe('the orchestrator and explore texts stay inside their role', () => {
  const prose = (variant) => file(variant).replace(/\s+/g, ' ');

  test('the orchestrator sizes with the graph only when one read batch does not already explain the change', () => {
    const text = prose('orchestrator');
    assert.match(text, /before you plan or size a change that one read batch does not already explain/, text);
    assert.match(text, /a file or location you already know/, 'a known location needs no call, not only a known file');
    assert.match(text, /which is what scope, size and any handoff depend on/, 'the small path has no handoff');
  });

  test('the orchestrator looks at the ODD\'s own worktree through projectPath when the session runs elsewhere', () => {
    const text = prose('orchestrator');
    assert.match(text, /An ODD works in its own worktree: when the session runs elsewhere, look at that worktree, at a sibling worktree or at another git project/, text);
    assert.match(text, /`projectPath` set to that checkout/, text);
  });

  test('the orchestrator repeats no permission rule: that one is stated, and guarded, elsewhere', () => {
    assert.doesNotMatch(prose('orchestrator'), /authori[sz]ation|ask first|permission/i);
  });

  test('the explorer\'s second look has a stop', () => {
    assert.match(prose('explore'), /when the next layer is what the question needs, then stop/);
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

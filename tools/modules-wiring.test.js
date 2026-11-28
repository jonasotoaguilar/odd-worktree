'use strict';
// S1/S2 (modular-tools): what the extension registers for each setting of the two module
// switches. The switches are read ONCE, when the extension registers, from the shell API's
// store, and a missing document leaves all three out. The shared test bridge
// (`fixtures/load-extension.js`) stores them On, so every other suite in this package loads the
// whole thing; the cases here hand their own document in.
const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SHELL_SLOT, defaultShellApi, loadExtension } = require('./fixtures/load-extension.js');

// The prompt assertions below read the extension's own `before_agent_start`, which honors these
// two switches from the ambient environment: a suite that ran inside a subagent child (or under
// `ODD_WORKTREE_PROMPT=0`) would otherwise assert against a prompt the extension was told to keep
// empty. They are cleared once here, so the cases are the same in every environment.
const savedPromptEnv = {
  child: process.env.GENTLE_PI_AGENTS_CHILD,
  prompt: process.env.ODD_WORKTREE_PROMPT,
};
delete process.env.GENTLE_PI_AGENTS_CHILD;
delete process.env.ODD_WORKTREE_PROMPT;
after(() => {
  for (const [key, value] of [['GENTLE_PI_AGENTS_CHILD', savedPromptEnv.child], ['ODD_WORKTREE_PROMPT', savedPromptEnv.prompt]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const saved = globalThis[SHELL_SLOT];
afterEach(() => {
  if (saved === undefined) delete globalThis[SHELL_SLOT];
  else globalThis[SHELL_SLOT] = saved;
});

// A shell API whose own-store `modules` document is the one handed in; everything else the
// default shell API does stays as it is.
async function load(modules, { selection, host } = {}) {
  const shellApi = defaultShellApi();
  const document = modules === undefined ? undefined : { ...modules };
  shellApi.api.createStore = () => ({
    get: (key, fallback) => (key === 'modules' && document !== undefined ? document : fallback),
    set: () => {},
    delete: () => {},
  });
  // S11: the `Card activity` reader the CodeGraph card follows, when a case needs one.
  if (typeof selection === 'function') shellApi.api.resolveToolDesignSelection = selection;
  globalThis[SHELL_SLOT] = shellApi.api;
  const loaded = await loadExtension(host || {});
  return { ...loaded, shellApi };
}

const BOTH = { codegraph: true, worktrees: true };

/** The activity design, as the shell API answers it while `Card activity` is on `activity`. */
const ACTIVITY = () => ({ kind: 'design', design: { id: 'odd-worktree.bash-activity' } });

const toolCallHandlers = (loaded) => loaded.hooks.filter(([name]) => name === 'tool_call').length;

async function promptOf(loaded, selectedTools) {
  const options = { selectedTools };
  for (const [name, handler] of loaded.hooks) {
    if (name === 'before_agent_start') await handler({ systemPromptOptions: options }, { cwd: os.tmpdir() });
  }
  return options.appendSystemPrompt ?? '';
}

describe('the Tools page', () => {
  test('the extension registers one provider on the `Tools` page, whatever the switches say', async () => {
    for (const modules of [undefined, { codegraph: false }, { worktrees: false }, { codegraph: false, worktrees: false }]) {
      const { shellApi } = await load(modules);
      const tools = shellApi.rows.filter((provider) => provider.category === 'Tools');
      assert.equal(tools.length, 1, JSON.stringify(modules));
      assert.deepEqual(
        tools[0].rows({}).map((row) => `${row.choice.setting} ${row.choice.value}`),
        ['Codegraph+ Off', 'Codegraph+ On', 'Worktrees+ Off', 'Worktrees+ On', 'Skills+ Off', 'Skills+ On'],
      );
      assert.deepEqual(
        tools[0].categoryPlacement,
        { after: 'Sections' },
        'the page is placed by the shell API, right after the host Sections page',
      );
    }
  });
});

describe('Worktrees+', () => {
  test('on: the two tools, /warp, its card and every worktree guard and text', async () => {
    const loaded = await load(BOTH);
    assert.deepEqual([...loaded.tools.keys()].filter((name) => name.startsWith('worktree_')).sort(), ['worktree_create', 'worktree_list']);
    assert.ok(loaded.commands.has('warp'));
    assert.ok(loaded.messageRenderers.has('worktree-warp'));
    assert.match(await promptOf(loaded, []), /## ODD worktrees/);
  });

  test('off: no tools, no /warp, no warp card, no worktree text and fewer guards, while everything else stays', async () => {
    const on = await load(BOTH);
    const off = await load({ ...BOTH, worktrees: false });
    assert.equal([...off.tools.keys()].some((name) => name.startsWith('worktree_')), false);
    assert.equal(off.commands.has('warp'), false);
    assert.equal(off.messageRenderers.has('worktree-warp'), false);
    assert.doesNotMatch(await promptOf(off, []), /## ODD worktrees/);
    // Worktrees+ gates the two worktree guards and nothing else, now that the read rules are
    // the `Skills+` half.
    assert.equal(toolCallHandlers(on) - toolCallHandlers(off), 2);
    // The two read rules are their own module, and the CodeGraph wiring adds ONE `tool_call`
    // observation of its own, and only where its CLI is installed — so neither answer is this
    // half's.
    assert.ok(toolCallHandlers(off) <= 3, `at most the two read rules and the CodeGraph observation, got ${toolCallHandlers(off)}`);
    for (const name of ['odd', 'files']) assert.ok(off.commands.has(name), `${name} stays`);
    assert.equal(off.hooks.some(([hook]) => hook === 'agent_settled'), false, 'the warp settle tick goes');
  });

  test('off keeps the CodeGraph text and the issues surface', async () => {
    const off = await load({ ...BOTH, worktrees: false });
    assert.match(await promptOf(off, ['codegraph']), /## CodeGraph/);
    assert.ok(off.commands.has('issues'));
  });
});

describe('Skills+', () => {
  test('off (the default): the two read rules are not registered, and no worktree surface moves', async () => {
    const on = await load({ skills: true, worktrees: true, codegraph: true });
    const off = await load({ skills: false, worktrees: true, codegraph: true });
    assert.equal(toolCallHandlers(on) - toolCallHandlers(off), 2, 'the skill-read guard and the whole-read rule');
    assert.equal(toolCallHandlers(off), toolCallHandlers(await load({ worktrees: true, codegraph: true })), 'an unset switch and a stored false are the same half');
    for (const loaded of [off, await load({ skills: false, worktrees: true, codegraph: true })]) {
      assert.ok(loaded.tools.has('worktree_create'), 'the worktree tools stay');
      assert.ok(loaded.commands.has('warp'), '/warp stays');
      assert.match(await promptOf(loaded, []), /## ODD worktrees/, 'the worktree text stays');
    }
  });

  test('on: the two read rules register without the worktree half', async () => {
    const on = await load({ skills: true, worktrees: false, codegraph: true });
    // Two worktree guards gone, the two read rules still here.
    assert.equal(toolCallHandlers(on) - toolCallHandlers(await load({ worktrees: false, codegraph: true })), 2);
    assert.equal(on.commands.has('warp'), false, 'the worktree half is still off');
  });
});

describe('Codegraph+', () => {
  test('on: the role text rides the prompt of a session holding a CodeGraph tool', async () => {
    assert.match(await promptOf(await load(BOTH), ['codegraph']), /## CodeGraph/);
  });

  test('off: no CodeGraph text, and the worktrees half is untouched', async () => {
    const off = await load({ ...BOTH, codegraph: false });
    const prompt = await promptOf(off, ['codegraph']);
    assert.doesNotMatch(prompt, /## CodeGraph/);
    assert.match(prompt, /## ODD worktrees/);
    assert.ok(off.tools.has('worktree_create'));
    assert.ok(off.commands.has('warp'));
  });
});

describe('the CodeGraph card', () => {
  // The card claims `codegraph` on EVERY answer, because Pi resolves a tool's renderers once,
  // when it mounts the card, and never asks again: the `Card activity` line is read inside the
  // component, on every paint, and a flipped line repaints the card already on screen. What this
  // file can observe is the ROWS — with any answer but `activity`, and with no reader at all, the
  // chain's own renderer keeps them untouched — and that the card is still the one answering,
  // which is what a flip depends on. (This load injects no text seam, so the card itself degrades
  // to the host's drawing here; tools/codegraph-card.test.js proves the card's own rows.)
  const CHAIN = {
    renderShell: 'self',
    renderCall: () => ({ render: () => ['the chain drew this'], invalidate() {} }),
    renderResult: () => ({ render: () => ['the chain drew this too'], invalidate() {} }),
  };

  /** The CodeGraph card's own answer on this load, as the call rows it draws — or [] when none claims. */
  const cardRows = async (modules, selection) => {
    const resolvers = [];
    await load(modules, { selection, host: { registerToolRenderer: (resolver) => resolvers.push(resolver) } });
    return resolvers
      .map((resolver) => resolver('codegraph', () => CHAIN))
      .filter((slot) => slot !== CHAIN && slot?.renderShell === 'self' && typeof slot.renderCall === 'function')
      .map((slot) => slot.renderCall({ operation: 'status' }, undefined, { isPartial: false }).render(24));
  };

  test('is a design of the `Card activity` line: activity on answers it, and Codegraph+ off keeps it', async () => {
    for (const modules of [undefined, { codegraph: false }]) {
      assert.deepEqual(await cardRows(modules, ACTIVITY), [['the chain drew this']], `the card answers whatever the line says (${JSON.stringify(modules)})`);
    }
  });

  test('is not a module surface: native, another answer and no reader hand every row back to the chain', async () => {
    for (const [name, selection] of [
      ['native', () => ({ kind: 'native' })],
      ['another plugin\'s design', () => ({ kind: 'design', design: { id: 'acme.tools' } })],
      ['no reader at all', undefined],
    ]) {
      for (const modules of [undefined, { codegraph: false }]) {
        assert.deepEqual(await cardRows(modules, selection), [['the chain drew this']], `${name} (${JSON.stringify(modules)}): the rows are the chain's`);
      }
    }
  });
});

describe('both off', () => {
  test('is the default: nothing stored leaves both halves out', async () => {
    for (const modules of [undefined, {}, { codegraph: 'yes', worktrees: 1 }]) {
      const loaded = await load(modules);
      assert.equal(await promptOf(loaded, ['codegraph']), '', JSON.stringify(modules));
      assert.equal([...loaded.tools.keys()].some((name) => name.startsWith('worktree_')), false, JSON.stringify(modules));
      assert.equal(loaded.commands.has('warp'), false, JSON.stringify(modules));
    }
  });

  test('the package keeps its transversal surface and adds neither half', async () => {
    const off = await load({ codegraph: false, worktrees: false });
    assert.equal(await promptOf(off, ['codegraph']), '');
    assert.equal(off.tools.size, 0);
    for (const name of ['odd', 'files', 'issues']) assert.ok(off.commands.has(name), `${name} stays`);
  });
});

// S2/S3: what the switch wires beyond its own value. The fixture points the agent directory and the config home at
// scratch directories, so these cases read and write only those; the CLI is a file named `codegraph` on a scratch PATH.
describe('Codegraph+ wiring', () => {
  const AGENT_NAMES = ['gentle-ai-explore', 'gentle-ai-verify', 'gentle-ai-worker', 'jd-fix-agent', 'jd-judge-a', 'jd-judge-b'];
  const mcpFile = () => path.join(process.env.PI_CODING_AGENT_DIR, 'mcp.json');
  const toolsFile = () => path.join(process.env.GENTLE_PI_CONFIG_HOME, 'tools.json');
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const clean = () => [mcpFile(), toolsFile()].forEach((file) => fs.rmSync(file, { force: true }));

  /** Runs `body` with `codegraph` on PATH (or without it), then restores PATH. */
  async function withCli(present, body) {
    const saved = process.env.PATH;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-cli-'));
    if (present) fs.writeFileSync(path.join(bin, 'codegraph'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = bin;
    try {
      await body();
    } finally {
      process.env.PATH = saved;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  /** The page's rows over a store that keeps what the page writes. */
  async function pageRows(initial) {
    const loaded = await load(initial);
    let document = initial === undefined ? undefined : { ...initial };
    loaded.shellApi.api.createStore = () => ({
      get: (key, fallback) => (key === 'modules' && document !== undefined ? document : fallback),
      set: (key, value) => { if (key === 'modules') document = value; },
      delete: () => {},
    });
    return loaded.shellApi.rows.find((provider) => provider.category === 'Tools').rows({});
  }

  const startSession = async (loaded) => {
    for (const [name, handler] of loaded.hooks) {
      if (name === 'session_start') {
        try {
          await handler({ reason: 'startup' }, { cwd: os.tmpdir(), ui: { notify: () => {} } });
        } catch {
          // Another handler of the same event is not what these cases look at.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  test('turning Codegraph+ On adds the server to the MCP configuration and the agents to tools.json', async () => {
    clean();
    await withCli(true, async () => {
      const rows = await pageRows({});
      clean();
      await rows[1].action();
    });
    assert.deepEqual(readJson(mcpFile()).mcpServers.codegraph.args, ['serve', '--mcp']);
    assert.deepEqual(Object.keys(readJson(toolsFile())).sort(), AGENT_NAMES);
    assert.deepEqual(readJson(toolsFile())['gentle-ai-explore'], { add: ['mcp__codegraph'] });
  });

  test('turning it On without the CLI writes neither file', async () => {
    clean();
    await withCli(false, async () => {
      const rows = await pageRows({});
      clean();
      await rows[1].action();
    });
    assert.equal(fs.existsSync(mcpFile()), false);
    assert.equal(fs.existsSync(toolsFile()), false);
  });

  test('turning it Off takes the agents out and leaves the MCP entry the user has', async () => {
    clean();
    await withCli(true, async () => {
      const rows = await pageRows({ codegraph: true });
      clean();
      fs.writeFileSync(toolsFile(), JSON.stringify({ 'gentle-ai-explore': { add: ['mcp__codegraph', 'web_search'] }, other: { add: ['x'] } }));
      fs.writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' } } }));
      await rows[0].action();
    });
    assert.deepEqual(readJson(toolsFile()), { 'gentle-ai-explore': { add: ['web_search'] }, other: { add: ['x'] } });
    assert.ok(readJson(mcpFile()).mcpServers.codegraph);
  });

  test('a session start checks the file: Off or no CLI takes the agents out, On with the CLI puts them back', async () => {
    const seed = () => fs.writeFileSync(toolsFile(), JSON.stringify(Object.fromEntries(AGENT_NAMES.map((name) => [name, { add: ['mcp__codegraph'] }]))));
    for (const [modules, cli, expected] of [
      [{ codegraph: false, worktrees: true }, true, {}],
      [{ codegraph: true, worktrees: true }, false, {}],
      [{ codegraph: true, worktrees: true }, true, Object.fromEntries(AGENT_NAMES.map((name) => [name, { add: ['mcp__codegraph'] }]))],
    ]) {
      await withCli(cli, async () => {
        const loaded = await load(modules);
        clean();
        seed();
        await startSession(loaded);
      });
      assert.deepEqual(readJson(toolsFile()), expected, `${JSON.stringify(modules)} cli=${cli}`);
    }
    await withCli(true, async () => {
      const loaded = await load({ codegraph: true, worktrees: true });
      clean();
      await startSession(loaded);
    });
    assert.deepEqual(Object.keys(readJson(toolsFile())).sort(), AGENT_NAMES, 'a missing file is created while On');
  });
});

'use strict';
// S1/S2 (modular-tools): what the extension registers for each setting of the two module
// switches. The switches are read ONCE, when the extension registers, from the bridge's
// store, and a missing document keeps everything on — so every other suite in this package
// loads the whole thing.
const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { BRIDGE_SLOT, defaultBridge, loadExtension } = require('./fixtures/load-extension.js');

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

const saved = globalThis[BRIDGE_SLOT];
afterEach(() => {
  if (saved === undefined) delete globalThis[BRIDGE_SLOT];
  else globalThis[BRIDGE_SLOT] = saved;
});

// A bridge whose own-store `modules` document is the one handed in; everything else the
// default bridge does stays as it is.
async function load(modules, { selection, host } = {}) {
  const bridge = defaultBridge();
  const document = modules === undefined ? undefined : { ...modules };
  bridge.api.createStore = () => ({
    get: (key, fallback) => (key === 'modules' && document !== undefined ? document : fallback),
    set: () => {},
    delete: () => {},
  });
  // S11: the `Card activity` reader the CodeGraph card follows, when a case needs one.
  if (typeof selection === 'function') bridge.api.resolveToolDesignSelection = selection;
  globalThis[BRIDGE_SLOT] = bridge.api;
  const loaded = await loadExtension(host || {});
  return { ...loaded, bridge };
}

/** The activity design, as the bridge answers it while `Card activity` is on `activity`. */
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
      const { bridge } = await load(modules);
      const tools = bridge.rows.filter((provider) => provider.category === 'Tools');
      assert.equal(tools.length, 1, JSON.stringify(modules));
      assert.deepEqual(
        tools[0].rows({}).map((row) => `${row.choice.setting} ${row.choice.value}`),
        ['Codegraph+ Off', 'Codegraph+ On', 'Worktrees+ Off', 'Worktrees+ On'],
      );
      assert.deepEqual(
        tools[0].categoryPlacement,
        { after: 'Sections' },
        'the page is placed by the bridge, right after the host Sections page',
      );
    }
  });
});

describe('Worktrees+', () => {
  test('on (the default): the two tools, /warp, its card and every worktree guard and text', async () => {
    const loaded = await load(undefined);
    assert.deepEqual([...loaded.tools.keys()].filter((name) => name.startsWith('worktree_')).sort(), ['worktree_create', 'worktree_list']);
    assert.ok(loaded.commands.has('warp'));
    assert.ok(loaded.messageRenderers.has('worktree-warp'));
    assert.match(await promptOf(loaded, []), /## ODD worktrees/);
  });

  test('off: no tools, no /warp, no warp card, no worktree text and fewer guards, while everything else stays', async () => {
    const on = await load(undefined);
    const off = await load({ worktrees: false });
    assert.equal([...off.tools.keys()].some((name) => name.startsWith('worktree_')), false);
    assert.equal(off.commands.has('warp'), false);
    assert.equal(off.messageRenderers.has('worktree-warp'), false);
    assert.doesNotMatch(await promptOf(off, []), /## ODD worktrees/);
    // Worktrees+ gates the two worktree guards and the two read rules.
    assert.equal(toolCallHandlers(on) - toolCallHandlers(off), 4);
    // The CodeGraph wiring adds ONE `tool_call` observation of its own, and only where its CLI is
    // installed — so a host without it leaves zero, and neither answer is this half's.
    assert.ok(toolCallHandlers(off) <= 1, `at most the CodeGraph observation is left, got ${toolCallHandlers(off)}`);
    for (const name of ['odd', 'files']) assert.ok(off.commands.has(name), `${name} stays`);
    assert.equal(off.hooks.some(([hook]) => hook === 'agent_settled'), false, 'the warp settle tick goes');
  });

  test('off keeps the CodeGraph text and the issues surface', async () => {
    const off = await load({ worktrees: false });
    assert.match(await promptOf(off, ['codegraph']), /## CodeGraph/);
    assert.ok(off.commands.has('issues'));
  });
});

describe('Codegraph+', () => {
  test('on (the default): the role text rides the prompt of a session holding a CodeGraph tool', async () => {
    assert.match(await promptOf(await load(undefined), ['codegraph']), /## CodeGraph/);
  });

  test('off: no CodeGraph text, and the worktrees half is untouched', async () => {
    const off = await load({ codegraph: false });
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
  test('the package keeps its transversal surface and adds neither half', async () => {
    const off = await load({ codegraph: false, worktrees: false });
    assert.equal(await promptOf(off, ['codegraph']), '');
    assert.equal(off.tools.size, 0);
    for (const name of ['odd', 'files', 'issues']) assert.ok(off.commands.has(name), `${name} stays`);
  });
});

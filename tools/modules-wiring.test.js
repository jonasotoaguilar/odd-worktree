'use strict';
// S1/S2 (modular-tools): what the extension registers for each setting of the two module
// switches. The switches are read ONCE, when the extension registers, from the bridge's
// store, and a missing document keeps everything on — so every other suite in this package
// loads the whole thing.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { BRIDGE_SLOT, defaultBridge, loadExtension } = require('./fixtures/load-extension.js');

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
  // S11: the `Card tags` reader the CodeGraph card follows, when a case needs one.
  if (typeof selection === 'function') bridge.api.resolveToolDesignSelection = selection;
  globalThis[BRIDGE_SLOT] = bridge.api;
  const loaded = await loadExtension(host || {});
  return { ...loaded, bridge };
}

/** The activity design, as the bridge answers it while `Card tags` is on `activity`. */
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
    // the naming handler, the bash guard and the write guard go; the skill-read guard stays
    assert.equal(toolCallHandlers(on) - toolCallHandlers(off), 3);
    assert.ok(toolCallHandlers(off) >= 1, 'the skill-read guard is transversal');
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
  const cardResolvers = async (modules, selection) => {
    const resolvers = [];
    await load(modules, { selection, host: { registerToolRenderer: (resolver) => resolvers.push(resolver) } });
    return resolvers.filter((resolver) => resolver('codegraph', () => undefined) !== undefined).length;
  };

  test('is a design of the `Card tags` line: activity on paints it, and Codegraph+ off keeps it', async () => {
    assert.equal(await cardResolvers(undefined, ACTIVITY), 1, 'activity on, both modules on');
    assert.equal(await cardResolvers({ codegraph: false }, ACTIVITY), 1, 'Codegraph+ off does not take the card away');
  });

  test('is not a module surface: native leaves every row to the chain', async () => {
    assert.equal(await cardResolvers(undefined, () => ({ kind: 'native' })), 0);
    assert.equal(await cardResolvers({ codegraph: false }, () => ({ kind: 'native' })), 0);
    assert.equal(await cardResolvers(undefined, undefined), 0, 'no reader, no switch, no card');
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

'use strict';
// S1-S5 (skill-read-full): a skill's or an ODD's Markdown is read whole, the decision the
// extension's `tool_call` handler makes is a mutation of the host's own input, and the rule
// follows the `Worktrees+` module switch.
//
// The pure half is exercised directly; the wiring half loads the extension and drives
// the registered handlers with the event the host sends, which is the only way to prove
// the mutation reaches the tool.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { isArtifactMarkdown, keepArtifactReadWhole } = require('../lib/artifact-read-full.js');
const { BRIDGE_SLOT, defaultBridge, loadExtension } = require('./fixtures/load-extension.js');

// S5: the module switch is read from the bridge's own store when the extension registers, so a
// suite that turns `Worktrees+` off publishes the document first and restores the slot after.
const savedBridge = globalThis[BRIDGE_SLOT];
async function loadWithModules(modules) {
  const bridge = defaultBridge();
  bridge.api.createStore = () => ({
    get: (key, fallback) => (key === 'modules' && modules !== undefined ? modules : fallback),
    set: () => {},
    delete: () => {},
  });
  globalThis[BRIDGE_SLOT] = bridge.api;
  try {
    return await loadExtension({});
  } finally {
    if (savedBridge === undefined) delete globalThis[BRIDGE_SLOT];
    else globalThis[BRIDGE_SLOT] = savedBridge;
  }
}

const SKILL = '/home/me/project/skills/release/SKILL.md';

describe('what counts as an artifact\'s Markdown', () => {
  test('a .md below a skills or an odd folder, at any depth', () => {
    for (const path of [
      SKILL,
      'skills/release/SKILL.md',
      '/a/b/skills/x/references/notes.md',
      'C:\\repo\\skills\\x\\SKILL.MD',
      'odd/tasks/a.md',
      '/home/me/project/odd/tasks/section-placement.md',
    ]) {
      assert.equal(isArtifactMarkdown(path), true, path);
    }
  });

  test('everything else is not: other folders, a non-Markdown file, a sibling name, no path', () => {
    for (const path of [
      'lib/skillset/notes.md',
      'docs/oddity.md',
      'skills/release/scripts/run.js',
      'skills/release/SKILL',
      undefined,
      null,
      42,
      '',
    ]) {
      assert.equal(isArtifactMarkdown(path), false, String(path));
    }
  });
});

describe('the patch', () => {
  test('offset and limit are dropped, and both are reported', () => {
    const input = { path: SKILL, offset: 1, limit: 90 };
    assert.deepEqual(keepArtifactReadWhole('read', input), { patched: true, dropped: ['offset', 'limit'] });
    assert.deepEqual(input, { path: SKILL }, 'the host executes a whole read');
  });

  test('one field alone is dropped alone', () => {
    const onlyOffset = { path: SKILL, offset: 12 };
    assert.deepEqual(keepArtifactReadWhole('read', onlyOffset), { patched: true, dropped: ['offset'] });
    assert.deepEqual(onlyOffset, { path: SKILL });
    const onlyLimit = { path: SKILL, limit: 5 };
    assert.deepEqual(keepArtifactReadWhole('read', onlyLimit), { patched: true, dropped: ['limit'] });
    assert.deepEqual(onlyLimit, { path: SKILL });
  });

  test('a whole read, another tool and a non-skill path are untouched', () => {
    const whole = { path: SKILL };
    assert.deepEqual(keepArtifactReadWhole('read', whole), { patched: false, dropped: [] });
    assert.deepEqual(whole, { path: SKILL });

    const other = { path: 'lib/odd-worktree-worktrees/x.md', offset: 1, limit: 2, extra: 'kept' };
    assert.deepEqual(keepArtifactReadWhole('read', other), { patched: false, dropped: [] });
    assert.deepEqual(other, { path: 'lib/odd-worktree-worktrees/x.md', offset: 1, limit: 2, extra: 'kept' });

    const edit = { path: SKILL, offset: 1, limit: 2 };
    assert.deepEqual(keepArtifactReadWhole('edit', edit), { patched: false, dropped: [] });
    assert.deepEqual(edit, { path: SKILL, offset: 1, limit: 2 });
  });

  test('a hostile input never throws', () => {
    for (const value of [null, undefined, 42, 'path', []]) {
      assert.doesNotThrow(() => keepArtifactReadWhole('read', value));
      assert.deepEqual(keepArtifactReadWhole('read', value), { patched: false, dropped: [] });
    }
    const hostile = { get path() { throw new Error('boom'); }, offset: 1 };
    assert.deepEqual(keepArtifactReadWhole('read', hostile), { patched: false, dropped: [] });
  });
});

describe('the extension wiring', () => {
  const readEvent = (input) => ({ type: 'tool_call', toolName: 'read', toolCallId: 'call-1', input });

  const runToolCall = async (loaded, event, ctx = { cwd: os.tmpdir() }) => {
    let answer;
    for (const [name, handler] of loaded.hooks) {
      if (name !== 'tool_call') continue;
      const result = await handler(event, ctx);
      if (result !== undefined) answer = result;
    }
    return answer;
  };

  test('a skill read with a range is executed whole, and the call is not blocked', async () => {
    const loaded = await loadExtension({});
    const event = readEvent({ path: SKILL, offset: 1, limit: 90 });
    const answer = await runToolCall(loaded, event);
    assert.equal(answer, undefined, 'nothing is blocked: the call still runs');
    assert.deepEqual(event.input, { path: SKILL }, 'the host executes a whole read');
  });

  test('an ordinary read keeps its range, byte for byte', async () => {
    const loaded = await loadExtension({});
    const event = readEvent({ path: 'lib/skill-read-full.js', offset: 3, limit: 40 });
    await runToolCall(loaded, event);
    assert.deepEqual(event.input, { path: 'lib/skill-read-full.js', offset: 3, limit: 40 });
  });

  test('S5: worktrees+ off leaves the read exactly as the host proposed it', async () => {
    const loaded = await loadWithModules({ worktrees: false });
    const event = readEvent({ path: SKILL, offset: 1, limit: 90 });
    await runToolCall(loaded, event);
    assert.deepEqual(event.input, { path: SKILL, offset: 1, limit: 90 });
  });

  test('an odd artifact read with a range is executed whole too', async () => {
    const loaded = await loadExtension({});
    const event = readEvent({ path: 'odd/tasks/x.md', offset: 40, limit: 10 });
    await runToolCall(loaded, event);
    assert.deepEqual(event.input, { path: 'odd/tasks/x.md' });
  });

  test('the old bash guard still refuses a skill printed with a reader', async () => {
    const loaded = await loadExtension({});
    const event = { type: 'tool_call', toolName: 'bash', toolCallId: 'call-2', input: { command: `cat ${SKILL}` } };
    const answer = await runToolCall(loaded, event);
    assert.equal(answer?.block, true, 'the bash reader is still refused');
    assert.match(answer.reason, /read/);
  });
});

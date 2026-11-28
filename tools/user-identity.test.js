'use strict';
// identity-command (S1-S4): the user's own name. `/identity <name>` stores it in the shell API's
// store, the user prompt card heads with it instead of `You`, and one line about it is appended
// to the orchestrator's prompt; `/identity clear` takes it away again.
//
// Everything below observes the public seam: `lib/user-identity.js`'s own answers, the document a
// fake store received, the exact string the prompt append produced, and the command the extension
// registered on a fake host. No internal state is read.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../lib/user-identity.js');
const fixture = require('./fixtures/load-extension.js');

const SHELL_SLOT = Symbol.for('odd-worktree/shell-api/v1');
const STORE = 'odd-worktree';

// A shell API whose `createStore` keeps ONE in-memory document per plugin id, with the same
// key-merge the published store has (`get` and `set` only). `deletable: false` models that real
// store exactly: the shell API's `Store` interface has no `delete`.
function fakeShellApi(initial = {}, options = {}) {
  const documents = new Map(Object.entries(initial));
  const writes = [];
  const store = {
    get(key, fallback) {
      const document = documents.get(STORE);
      return document !== undefined && Object.hasOwn(document, key) ? document[key] : fallback;
    },
    set(key, value) {
      documents.set(STORE, { ...(documents.get(STORE) ?? {}), [key]: value });
      writes.push([key, value]);
    },
  };
  if (options.deletable !== false) {
    store.delete = (key) => {
      const document = { ...(documents.get(STORE) ?? {}) };
      delete document[key];
      documents.set(STORE, document);
      writes.push([key]);
    };
  }
  return { api: { schema: 'odd-worktree/shell-api', version: 1, createStore: () => store }, documents, writes };
}

const stored = (name) => ({ [STORE]: { identity: { schema: 1, name } } });

// ---- D2: what a name may be ----

describe('the name a command may store', () => {
  test('it is trimmed, its internal runs collapse to one space, and its control characters are dropped', () => {
    assert.equal(identity.normalizeIdentityName('  Jona  '), 'Jona');
    assert.equal(identity.normalizeIdentityName('Jona   Soto'), 'Jona Soto');
    assert.equal(identity.normalizeIdentityName('Jona\t\nSoto'), 'Jona Soto');
    assert.equal(identity.normalizeIdentityName('Jo\u0000na'), 'Jona', 'a C0 control is dropped');
    assert.equal(identity.normalizeIdentityName('Jona\u009b'), 'Jona', 'a C1 control is dropped');
    assert.equal(identity.normalizeIdentityName('Jona \u0001 Soto'), 'Jona Soto', 'a dropped control leaves no second space');
    assert.equal(identity.normalizeIdentityName('Jona\u007f'), 'Jona', 'DEL is dropped too');
  });

  test('an empty, blank, non-string or over-long name is refused', () => {
    for (const bad of ['', '   ', '\u0000\u0001', 42, null, undefined, {}, [], true]) {
      assert.equal(identity.normalizeIdentityName(bad), undefined, String(bad));
    }
    assert.equal(identity.normalizeIdentityName('a'.repeat(40)), 'a'.repeat(40), 'forty characters is a name');
    assert.equal(identity.normalizeIdentityName('a'.repeat(41)), undefined, 'forty-one is not');
    assert.equal(identity.normalizeIdentityName('😀'.repeat(40)), '😀'.repeat(40), 'code points are counted, not UTF-16 units');
    assert.equal(identity.normalizeIdentityName(`😀${'a'.repeat(40)}`), undefined, 'one code point past the limit');
  });

  test('a name may not carry a markdown heading run, while an ordinary `#` is still a name', () => {
    // A stored name reaches the system prompt, and every one of this package's prompt blocks is
    // found by its `## <heading>` marker: a name that could form one would make an older block
    // disappear (S3). `C#` and `#designer` form no heading and stay names.
    assert.equal(identity.normalizeIdentityName('## CodeGraph'), undefined);
    assert.equal(identity.normalizeIdentityName('Jona ## ODD worktrees'), undefined);
    assert.equal(identity.normalizeIdentityName('Jona ##'), 'Jona ##', 'a `##` with no space after it is no heading run');
    assert.equal(identity.normalizeIdentityName('C#'), 'C#');
    assert.equal(identity.normalizeIdentityName('#designer'), '#designer');
  });
});

// ---- D1: where the name lives ----

describe('reading the stored name', () => {
  test('the stored name is read back, and every unreadable document is no name at all', () => {
    assert.equal(identity.readIdentityName(fakeShellApi(stored('Jona')).api), 'Jona');
    assert.equal(identity.readIdentityName(fakeShellApi(stored('  Jona   Soto ')).api), 'Jona Soto', 'read normalizes');
    for (const document of [
      'Jona',
      42,
      [],
      null,
      { schema: 2, name: 'Jona' },
      { schema: '1', name: 'Jona' },
      { name: 'Jona' },
      { schema: 1, name: 42 },
      { schema: 1, name: '   ' },
      { schema: 1 },
    ]) {
      const shellApi = fakeShellApi({ [STORE]: { identity: document } });
      assert.equal(identity.readIdentityName(shellApi.api), undefined, JSON.stringify(document));
    }
  });

  test('no api, no store and a throwing store answer no name and never throw', () => {
    assert.equal(identity.readIdentityName(undefined), undefined);
    assert.equal(identity.readIdentityName(null), undefined);
    assert.equal(identity.readIdentityName({}), undefined);
    assert.equal(identity.readIdentityName({ schema: 'odd-worktree/shell-api', version: 1 }), undefined);
    assert.equal(identity.readIdentityName({ createStore: () => { throw new Error('disk'); } }), undefined);
    const throwing = fakeShellApi();
    throwing.api.createStore = () => ({ get: () => { throw new Error('disk'); }, set: () => {} });
    assert.equal(identity.readIdentityName(throwing.api), undefined);
  });
});

describe('writing the stored name', () => {
  test('the name is one document named `identity`, and every other document survives it', () => {
    const shellApi = fakeShellApi({ [STORE]: { modules: { worktrees: false } } });
    assert.equal(identity.writeIdentityName(shellApi.api, '  Jona  '), true);
    assert.deepEqual(shellApi.documents.get(STORE), {
      modules: { worktrees: false },
      identity: { schema: 1, name: 'Jona' },
    });
    assert.equal(identity.readIdentityName(shellApi.api), 'Jona', 'and it reads back');
  });

  test('a refused name and an api with no store write nothing and answer false', () => {
    const shellApi = fakeShellApi();
    for (const bad of ['', '   ', 42, null, 'a'.repeat(41)]) {
      assert.equal(identity.writeIdentityName(shellApi.api, bad), false, String(bad));
    }
    assert.deepEqual(shellApi.writes, [], 'nothing was written');
    assert.deepEqual(shellApi.documents.get(STORE), undefined, 'and no document was created');
    assert.equal(identity.writeIdentityName(undefined, 'Jona'), false);
    assert.equal(identity.writeIdentityName({}, 'Jona'), false);
    assert.equal(identity.writeIdentityName({ createStore: () => { throw new Error('disk'); } }, 'Jona'), false);
  });
});

describe('clearing the stored name', () => {
  test('after a clear there is no name, and every other document survives it', () => {
    const shellApi = fakeShellApi({ [STORE]: { identity: { schema: 1, name: 'Jona' }, modules: { codegraph: false } } });
    assert.equal(identity.clearIdentityName(shellApi.api), true);
    assert.equal(identity.readIdentityName(shellApi.api), undefined);
    assert.deepEqual(shellApi.documents.get(STORE), { modules: { codegraph: false } }, 'the other document survives');
  });

  test('a store with no delete (the published one) removes the name by overwriting the document', () => {
    const shellApi = fakeShellApi({ [STORE]: { identity: { schema: 1, name: 'Jona' }, modules: { codegraph: false } } }, { deletable: false });
    assert.equal(identity.clearIdentityName(shellApi.api), true);
    assert.equal(identity.readIdentityName(shellApi.api), undefined, 'the strict read refuses the cleared document');
    assert.deepEqual(shellApi.documents.get(STORE), {
      modules: { codegraph: false },
      identity: { schema: 1, name: null },
    }, 'no name survives it');
  });

  test('nothing stored is nothing to clear, and no store clears nothing either', () => {
    assert.equal(identity.clearIdentityName(fakeShellApi().api), false);
    assert.equal(identity.clearIdentityName(undefined), false);
    assert.equal(identity.clearIdentityName({}), false);
    assert.equal(identity.clearIdentityName(fakeShellApi(), 'x'), false, 'an api that is not an object');
  });

  test('an already-cleared store is not written again', () => {
    // The published store has no `delete`, so a clear overwrites the document with the cleared
    // shape: a second clear on that store must find no name and write nothing.
    const shellApi = fakeShellApi({ [STORE]: { identity: { schema: 1, name: 'Jona' } } }, { deletable: false });
    assert.equal(identity.clearIdentityName(shellApi.api), true);
    const writes = shellApi.writes.length;
    assert.equal(identity.clearIdentityName(shellApi.api), false, 'there is nothing left to clear');
    assert.equal(shellApi.writes.length, writes, 'and nothing is written');
  });
});

// ---- D3: the exact strings ----

describe('the block', () => {
  test('the line is one sentence and the section is the marker plus it', () => {
    assert.equal(identity.identityLine('Jona'), "The user's name is Jona.");
    assert.equal(identity.identitySection('Jona'), "## User identity\n\nThe user's name is Jona.");
    assert.equal(identity.identityLine('  Jona   Soto  '), "The user's name is Jona Soto.", 'the line is built from the normalized name');
    assert.equal(identity.identityLine('   '), '', 'a name that does not normalize states nothing');
    assert.equal(identity.identitySection('   '), '');
  });
});

// ---- D4: where it is injected ----

describe('the prompt append', () => {
  const name = stored('Jona');

  test('the block is appended after the existing text, keeping every existing byte its prefix', () => {
    const cases = [
      ['', "## User identity\n\nThe user's name is Jona."],
      ['base', "base\n\n## User identity\n\nThe user's name is Jona."],
      ['base\n', "base\n\n## User identity\n\nThe user's name is Jona."],
      ['base\n\n', "base\n\n## User identity\n\nThe user's name is Jona."],
    ];
    for (const [before, after] of cases) {
      const event = { systemPromptOptions: { appendSystemPrompt: before } };
      identity.appendUserIdentitySection(event, { api: fakeShellApi(name).api, env: {} });
      assert.equal(event.systemPromptOptions.appendSystemPrompt, after, JSON.stringify(before));
    }
  });

  test('a second call appends nothing, and a block already there is left alone', () => {
    const event = { systemPromptOptions: { appendSystemPrompt: 'base' } };
    const deps = { api: fakeShellApi(name).api, env: {} };
    identity.appendUserIdentitySection(event, deps);
    const once = event.systemPromptOptions.appendSystemPrompt;
    identity.appendUserIdentitySection(event, deps);
    assert.equal(event.systemPromptOptions.appendSystemPrompt, once, 'idempotent');
    assert.equal(once.split(identity.SECTION_MARKER).length - 1, 1, 'the marker is written exactly once');
  });

  test('no stored name injects nothing', () => {
    const event = { systemPromptOptions: { appendSystemPrompt: 'base' } };
    identity.appendUserIdentitySection(event, { api: fakeShellApi().api, env: {} });
    assert.equal(event.systemPromptOptions.appendSystemPrompt, 'base');
  });

  test('the marker MENTIONED inside other text is not the block', () => {
    // Only a line that IS the heading counts: prose that happens to name the block must not
    // suppress the one line a stored name states.
    const event = { systemPromptOptions: { appendSystemPrompt: 'See ## User identity for the name.' } };
    identity.appendUserIdentitySection(event, { api: fakeShellApi(name).api, env: {} });
    assert.equal(event.systemPromptOptions.appendSystemPrompt,
      "See ## User identity for the name.\n\n## User identity\n\nThe user's name is Jona.");
  });

  test('a name that could form another block heading is refused, so no ordering can cost a block', () => {
    assert.equal(identity.identitySection('## CodeGraph'), '', 'a heading run is not a name');
    assert.equal(identity.identitySection('Jona'), "## User identity\n\nThe user's name is Jona.");
  });

  test('a child session and a named-agent event get nothing, both keeping the text they had', () => {
    const child = { systemPromptOptions: { appendSystemPrompt: 'base' } };
    identity.appendUserIdentitySection(child, { api: fakeShellApi(name).api, env: { GENTLE_PI_AGENTS_CHILD: '1' } });
    assert.equal(child.systemPromptOptions.appendSystemPrompt, 'base', 'a child gets none of it');
    for (const agentEvent of [
      { agentName: 'reviewer' },
      { agent: 'reviewer' },
      { agent: { name: 'reviewer' } },
      { name: 'reviewer' },
      { subagent: { name: 'reviewer' } },
    ]) {
      const event = { systemPromptOptions: { appendSystemPrompt: 'base' }, ...agentEvent };
      identity.appendUserIdentitySection(event, { api: fakeShellApi(name).api, env: {} });
      assert.equal(event.systemPromptOptions.appendSystemPrompt, 'base', JSON.stringify(agentEvent));
    }
  });

  test('a missing or unusable systemPromptOptions writes nothing and throws nothing', () => {
    for (const event of [undefined, null, {}, { systemPromptOptions: null }, { systemPromptOptions: 'text' }, { systemPromptOptions: 42 }]) {
      assert.doesNotThrow(() => identity.appendUserIdentitySection(event, { api: fakeShellApi(name).api, env: {} }), String(event));
    }
    const stringly = { systemPromptOptions: { appendSystemPrompt: 42 } };
    identity.appendUserIdentitySection(stringly, { api: fakeShellApi(name).api, env: {} });
    assert.equal(stringly.systemPromptOptions.appendSystemPrompt, `## User identity\n\nThe user's name is Jona.`, 'a non-string value is not a prefix');
  });

  test('without an injected api the name is read from the published shell API, and no shell API injects nothing', () => {
    const shellApi = fakeShellApi(name);
    const previous = globalThis[SHELL_SLOT];
    globalThis[SHELL_SLOT] = shellApi.api;
    try {
      assert.equal(identity.currentIdentityName(), 'Jona');
      const event = { systemPromptOptions: { appendSystemPrompt: 'base' } };
      identity.appendUserIdentitySection(event, { env: {} });
      assert.equal(event.systemPromptOptions.appendSystemPrompt, "base\n\n## User identity\n\nThe user's name is Jona.");
      delete globalThis[SHELL_SLOT];
      assert.equal(identity.currentIdentityName(), undefined, 'no shell API, no name');
      const unset = { systemPromptOptions: { appendSystemPrompt: 'base' } };
      identity.appendUserIdentitySection(unset, { env: {} });
      assert.equal(unset.systemPromptOptions.appendSystemPrompt, 'base');
    } finally {
      if (previous === undefined) delete globalThis[SHELL_SLOT];
      else globalThis[SHELL_SLOT] = previous;
    }
  });
});

// ---- D6: the command surface ----

// The fixture drives registrations through a fake host, so the command is cheap to load here: the
// shell API is published on the real slot BEFORE the extension loads, exactly as the fixture does,
// and its store is one this test can read back.
function commandShellApi() {
  const shellApi = fixture.defaultShellApi();
  const documents = new Map();
  const writes = [];
  const repaints = [];
  shellApi.api.createStore = (id) => ({
    get: (key, fallback) => {
      const document = documents.get(id);
      return document !== undefined && Object.hasOwn(document, key) ? document[key] : fallback;
    },
    set: (key, value) => {
      documents.set(id, { ...(documents.get(id) ?? {}), [key]: value });
      writes.push([id, key, value]);
    },
    delete: (key) => {
      const document = { ...(documents.get(id) ?? {}) };
      delete document[key];
      documents.set(id, document);
      writes.push([id, key]);
    },
  });
  shellApi.api.requestRepaint = () => repaints.push(repaints.length + 1);
  return { api: shellApi.api, documents, writes, repaints };
}

const NOT_SET = 'identity: not set · messages head with "You"';
const REFUSAL = 'identity: a name needs 1-40 printable characters and no markdown heading';

/** The extension loaded over a shell API this test owns, with a live session that owns the repaint. */
async function loadIdentityCommand(initialIdentity, modules) {
  const made = commandShellApi();
  if (initialIdentity !== undefined) made.documents.set(STORE, { identity: initialIdentity });
  if (modules !== undefined) made.documents.set(STORE, { ...(made.documents.get(STORE) ?? {}), modules });
  const previous = globalThis[SHELL_SLOT];
  globalThis[SHELL_SLOT] = made.api;
  try {
    const loaded = await fixture.loadExtension({});
    for (const [event, handler] of loaded.hooks) {
      if (event === 'session_start') await handler({}, {});
    }
    const command = loaded.commands.get('identity');
    assert.notEqual(command, undefined, '/identity is registered with the shell API present');
    const notifications = [];
    const ctx = { ui: { notify: (text, level) => notifications.push(level === undefined ? [text] : [text, level]) } };
    // Loading seeds documents of its own (the bash design's marker), which are not this
    // command's writes: the baseline starts where the command starts.
    made.writes.length = 0;
    return {
      command,
      ctx,
      notifications,
      hooks: loaded.hooks,
      documents: made.documents,
      writes: made.writes,
      repaints: made.repaints,
      restore: () => {
        if (previous === undefined) delete globalThis[SHELL_SLOT];
        else globalThis[SHELL_SLOT] = previous;
      },
    };
  } catch (error) {
    if (previous === undefined) delete globalThis[SHELL_SLOT];
    else globalThis[SHELL_SLOT] = previous;
    throw error;
  }
}

describe('/identity', () => {
  test('the command says what it does, and its bare form reports the state without writing', async () => {
    const loaded = await loadIdentityCommand();
    try {
      assert.match(loaded.command.description, /clear/, 'the description names the reserved word');
      await loaded.command.handler('', loaded.ctx);
      assert.deepEqual(loaded.notifications, [[NOT_SET]], 'nothing set, said plainly');
      assert.deepEqual(loaded.writes, [], 'and nothing written');
      assert.deepEqual(loaded.repaints, [], 'no repaint for a report');

      await loaded.command.handler(undefined, loaded.ctx);
      assert.deepEqual(loaded.notifications.at(-1), [NOT_SET], 'no argument is the same report');
    } finally {
      loaded.restore();
    }
  });

  test('a name is stored, the state is said, and exactly one repaint is asked for', async () => {
    const loaded = await loadIdentityCommand();
    try {
      await loaded.command.handler('  Jona  ', loaded.ctx);
      assert.deepEqual(loaded.documents.get(STORE).identity, { schema: 1, name: 'Jona' }, 'the name is persisted');
      assert.deepEqual(loaded.notifications, [['identity: Jona']]);
      assert.equal(loaded.repaints.length, 1, 'one repaint, so the prompts already on screen head with the name');
      assert.equal(loaded.documents.get(STORE).identity.schema, 1, 'S1: the name survives a restart, it is a document');

      await loaded.command.handler('', loaded.ctx);
      assert.deepEqual(loaded.notifications.at(-1), ['identity: Jona'], 'the bare form reports it');
      assert.equal(loaded.repaints.length, 1, 'a report repaints nothing');
    } finally {
      loaded.restore();
    }
  });

  test('the same name again says it and repaints nothing, and a refused name writes nothing', async () => {
    const loaded = await loadIdentityCommand();
    try {
      await loaded.command.handler('Jona', loaded.ctx);
      const writes = loaded.writes.length;
      await loaded.command.handler('Jona', loaded.ctx);
      assert.deepEqual(loaded.notifications.at(-1), ['identity: Jona'], 'the state is still said');
      assert.equal(loaded.repaints.length, 1, 'an unchanged name repaints nothing');
      assert.deepEqual(loaded.writes.slice(writes), [], 'and rewrites nothing');

      for (const bad of ['a'.repeat(41), '\u0000']) {
        await loaded.command.handler(bad, loaded.ctx);
        assert.deepEqual(loaded.notifications.at(-1), [REFUSAL, 'error'], `${JSON.stringify(bad)} is refused`);
        assert.deepEqual(loaded.documents.get(STORE).identity, { schema: 1, name: 'Jona' }, 'the stored name is untouched');
      }
      assert.equal(loaded.repaints.length, 1, 'a refusal repaints nothing');
    } finally {
      loaded.restore();
    }
  });

  test('`clear` (any case) unsets the name, says so, repaints once, and is not a name', async () => {
    const loaded = await loadIdentityCommand();
    try {
      await loaded.command.handler('Jona', loaded.ctx);
      await loaded.command.handler('CLEAR', loaded.ctx);
      assert.equal(Object.hasOwn(loaded.documents.get(STORE), 'identity'), false, 'the document is gone from the store');
      assert.deepEqual(loaded.notifications.at(-1), [NOT_SET], 'the state is back to You');
      assert.equal(loaded.repaints.length, 2, 'the set and the clear each asked for one repaint');

      await loaded.command.handler('clear', loaded.ctx);
      assert.deepEqual(loaded.notifications.at(-1), [NOT_SET], 'clearing nothing says the state');
      assert.equal(loaded.repaints.length, 2, 'and asks for no second repaint');
    } finally {
      loaded.restore();
    }
  });

  test('a value that only BECOMES `clear` after normalization is the reserved word, never a name', async () => {
    // The reserved check runs on the NORMALIZED value: otherwise `cle\u0001ar` would be stored as
    // `clear` — a name the command could never unset, because `clear` is always the verb.
    const loaded = await loadIdentityCommand();
    try {
      await loaded.command.handler('Jona', loaded.ctx);
      await loaded.command.handler('cle\u0001ar', loaded.ctx);
      assert.equal(Object.hasOwn(loaded.documents.get(STORE), 'identity'), false, 'it cleared instead of storing `clear`');
      assert.deepEqual(loaded.notifications.at(-1), [NOT_SET]);
    } finally {
      loaded.restore();
    }
  });

  test('a throwing notify never breaks the handler, and neither does a session with no UI', async () => {
    const loaded = await loadIdentityCommand();
    try {
      const throwing = { ui: { notify: () => { throw new Error('the UI died'); } } };
      assert.doesNotThrow(() => loaded.command.handler('Jona', throwing), 'a dead UI is not a failed write');
      assert.deepEqual(loaded.documents.get(STORE).identity, { schema: 1, name: 'Jona' }, 'the write still happened');
      assert.doesNotThrow(() => loaded.command.handler('', {}), 'a session with no UI says nothing and does not throw');
      assert.doesNotThrow(() => loaded.command.handler('Ana', undefined));
      assert.deepEqual(loaded.documents.get(STORE).identity, { schema: 1, name: 'Ana' });
    } finally {
      loaded.restore();
    }
  });

  // T4: the wiring itself, through the hook the host actually receives — the module's own append
  // is asserted above, and this is the proof that the extension calls it for every session start.
  test('the extension appends the one line from its before_agent_start hook, and nothing for a child', async () => {
    // This suite may itself run inside a child session (`GENTLE_PI_AGENTS_CHILD=1`), which is a
    // guard the block honours: the orchestrator case is the one that starts from a clean env.
    const savedChild = process.env.GENTLE_PI_AGENTS_CHILD;
    delete process.env.GENTLE_PI_AGENTS_CHILD;
    const loaded = await loadIdentityCommand({ schema: 1, name: 'Jona' }, { worktrees: false, codegraph: false });
    const emit = async (event) => {
      for (const [name, handler] of loaded.hooks) {
        if (name === 'before_agent_start') await handler(event, {});
      }
      return event;
    };
    try {
      const event = await emit({ systemPromptOptions: { appendSystemPrompt: 'base' } });
      assert.equal(event.systemPromptOptions.appendSystemPrompt,
        "base\n\n## User identity\n\nThe user's name is Jona.", 'the block rides the same hook as the other two');

      process.env.GENTLE_PI_AGENTS_CHILD = '1';
      const child = await emit({ systemPromptOptions: { appendSystemPrompt: 'base' } });
      assert.equal(child.systemPromptOptions.appendSystemPrompt, 'base', 'a child session gets none of it');
    } finally {
      if (savedChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
      else process.env.GENTLE_PI_AGENTS_CHILD = savedChild;
      loaded.restore();
    }
  });

  test('the identity block rides BESIDE an older block, and neither loses its marker', async () => {
    // The two older appends run before this one, and each is idempotent by its own heading: with a
    // name stored, one event must carry both blocks, the identity one last.
    const loaded = await loadIdentityCommand({ schema: 1, name: 'Jona' }, { worktrees: true, codegraph: false });
    try {
      const event = { systemPromptOptions: { appendSystemPrompt: 'base' } };
      for (const [name, handler] of loaded.hooks) {
        if (name === 'before_agent_start') await handler(event, {});
      }
      const text = event.systemPromptOptions.appendSystemPrompt;
      assert.ok(text.includes('## ODD worktrees'), 'the older block is still there');
      assert.ok(text.includes('## User identity'), 'and the name block was added');
      assert.ok(text.indexOf('## ODD worktrees') < text.indexOf('## User identity'), 'the identity block goes last');
    } finally {
      loaded.restore();
    }
  });
});

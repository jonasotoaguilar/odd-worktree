'use strict';
// T8 (odd-rail-section S8, S9): the extension's wiring of lib/odd-session.js.
//
// What the host registers, through the fake host only (the events the host really
// sends, the entries it really receives):
// - ONE `tool_result` observation that records a `write` or an `edit` landing on an
//   `odd/tasks/*.md` document against THIS session and persists it as ONE
//   `odd-worktree.odd-touch` entry (S8). `read`, `bash` and `grep` never do, and
//   neither does a document outside `odd/tasks` or nested below it.
// - It is NOT behind `Worktrees+`: the ODD rail only exists with that module on, so the
//   attribution has to be recording already when it is OFF, and a case here proves the
//   touch is still registered and persisted with the module off while the existing
//   worktree observations keep their own gate.
// - A FAILED result records nothing and appends nothing: `tool_result` is
//   observed, not `tool_call`, so a write that never landed leaves no phantom row.
// - The persisted entry is the one shape Pi documents for a CustomEntry and the
//   shape this package's other readers filter on, it is painted NOWHERE (no entry
//   renderer is registered, so the transcript gains no line — verified in
//   docs/extensions.md: a custom entry renders only when paired with
//   `registerEntryRenderer`), and `session_start` restores them for a new and for a
//   resumed session, so a resumed session remembers what it touched.
// - A registered touch asks the injected refresh callback for ONE immediate
//   refresh; with no callback set that request is a no-op, and a touch never
//   depends on it.
// - A host without an `appendEntry` seam, or one that throws, still records the
//   touch and reports nothing.
// - The existing `tool_call` observations of a write on an `odd/tasks` document are
//   unchanged (no block, no phantom entry).
//
// A SUBAGENT's write never reaches this handler — it runs in its own session — which
// is by design (S9): no event, no touch, and the filesystem scan is what covers it.
// The last case documents that rather than working around it.
//
// No fs fixture, no git: the rule is lexical, and every `cwd` below is a path that
// does not exist on purpose, so a git probe an existing observer makes answers
// "not a repository" instead of reading this machine.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  BRIDGE_SLOT,
  LIB_DIR,
  defaultBridge,
  loadExtension,
  stubbedSource,
  withGhPath,
} = require('./fixtures/load-extension.js');

const CWD = '/odd-session-wiring/checkout';
const ENTRY_TYPE = 'odd-worktree.odd-touch';
const TASKS = path.join(CWD, 'odd', 'tasks');

const savedBridge = globalThis[BRIDGE_SLOT];
afterEach(() => {
  if (savedBridge === undefined) delete globalThis[BRIDGE_SLOT];
  else globalThis[BRIDGE_SLOT] = savedBridge;
});

// A bridge whose `modules` document is the one handed in (everything else on), which is
// how the Tools page turns `Worktrees+` off; `undefined` keeps the default document.
function publishBridge(modules) {
  const bridge = defaultBridge();
  if (modules !== undefined) {
    bridge.api.createStore = () => ({
      get: (key, fallback) => (key === 'modules' ? modules : fallback),
      set: () => {},
      delete: () => {},
    });
  }
  globalThis[BRIDGE_SLOT] = bridge.api;
  return bridge;
}

// The extension's own module namespace, which the shared fixture's loader does not
// return: the record lives on module scope (`oddSession`), like this package's other
// test seams (`libModule`, `setWarpTuiLoader`, ...), so the assertions read it there.
// Everything else is the fixture's setup — the same stubbed source, the same lib
// override and the same published bridge.
async function loadModule(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-session-wiring-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const mod = await import(pathToFileURL(copy).href);
    const hooks = [];
    const entries = [];
    const entryRenderers = new Map();
    const host = {
      registerCommand: () => {},
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerEntryRenderer: (type, renderer) => { entryRenderers.set(type, renderer); },
      on: (event, handler) => { hooks.push([event, handler]); },
    };
    // T8: the guard `warpAppendQueueEntry` uses — a host may have no seam, and a seam
    // that throws is the same "nothing to persist" — is only observable if the host
    // can be built without one.
    if (opts.appendEntry !== 'absent') {
      host.appendEntry = (customType, data) => {
        if (opts.appendEntry === 'throwing') throw new Error('no entry for you');
        entries.push({ customType, data });
      };
    }
    mod.default(host);
    return { mod, host, hooks, entries, entryRenderers };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The fixture's own `gh` PATH switch, so the presence probe is deterministic and no case
// depends on the machine it runs on (this suite registers no `gh` surface, but the load
// does run that probe).
const presentGh = (run) => withGhPath('present', run);

const handlersOf = (loaded, event) => loaded.hooks.filter(([name]) => name === event).map(([, handler]) => handler);

function ctxOf(entries = [], calls = []) {
  return {
    cwd: CWD,
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: {
      getEntries: () => {
        calls.push('getEntries');
        return entries;
      },
      getSessionFile: () => undefined,
      getSessionId: () => 'session-1',
      getLeafId: () => null,
    },
  };
}

// The host's own delivery: every handler of that event, in registration order, one at
// a time, awaited the way the host awaits them.
async function fire(loaded, event, payload, ctx) {
  const results = [];
  for (const handler of handlersOf(loaded, event)) {
    results.push(await handler(payload, ctx));
  }
  return results;
}

const writeEvent = (target = 'odd/tasks/alpha.md', extra = {}) => ({
  toolName: 'write',
  toolCallId: 'call-1',
  input: { path: target, content: '# alpha' },
  isError: false,
  ...extra,
});

const touches = (loaded) => (loaded.mod.oddSession === null ? [] : loaded.mod.oddSession.touched());
const touchEntries = (loaded) => loaded.entries.filter((entry) => entry.customType === ENTRY_TYPE);

describe('a write or an edit on an odd/tasks document (S8)', () => {
  test('is recorded against this session and persisted as ONE entry that paints nothing', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      assert.ok(loaded.mod.oddSession, 'the record exists once the worktree module registers');
      assert.equal(loaded.entryRenderers.has(ENTRY_TYPE), false, 'an unrendered entry draws no transcript line');

      await fire(loaded, 'tool_result', writeEvent(), ctxOf());

      const persisted = touchEntries(loaded);
      assert.equal(persisted.length, 1);
      assert.deepEqual(Object.keys(persisted[0]).sort(), ['customType', 'data']);
      assert.deepEqual(Object.keys(persisted[0].data).sort(), ['at', 'path']);
      assert.equal(persisted[0].data.path, path.join(TASKS, 'alpha.md'));
      assert.equal(Number.isFinite(persisted[0].data.at), true);
      assert.deepEqual(touches(loaded), [
        { path: path.join(TASKS, 'alpha.md'), name: 'alpha', at: persisted[0].data.at },
      ]);

      await fire(loaded, 'tool_result', { ...writeEvent('odd/tasks/beta.md'), toolName: 'edit' }, ctxOf());
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['beta', 'alpha']);
      assert.deepEqual(touchEntries(loaded).map((entry) => entry.data.path), [
        path.join(TASKS, 'alpha.md'),
        path.join(TASKS, 'beta.md'),
      ]);
    });
  });

  test('a relative target is persisted absolute, resolved against the call’s cwd', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      await fire(loaded, 'tool_result', writeEvent('./odd/tasks/../tasks/alpha.md'), ctxOf());
      assert.deepEqual(touchEntries(loaded).map((entry) => entry.data.path), [path.join(TASKS, 'alpha.md')]);
    });
  });

  test('a re-touch moves the document to the front while the record keeps one row per document', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/alpha.md'), ctxOf());
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/beta.md'), ctxOf());
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/alpha.md'), ctxOf());
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['alpha', 'beta']);
      // ONE entry per observation: the persisted sequence lets a later `restore`
      // keep the newest `at`, which is why the record itself never repeats a path.
      assert.deepEqual(touchEntries(loaded).map((entry) => entry.data.path), [
        path.join(TASKS, 'alpha.md'),
        path.join(TASKS, 'beta.md'),
        path.join(TASKS, 'alpha.md'),
      ]);
    });
  });

  test('every other tool and every non-document target registers nothing', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      for (const toolName of ['read', 'bash', 'grep', 'find', 'ls', 'worktree_create']) {
        await fire(loaded, 'tool_result', { ...writeEvent(), toolName }, ctxOf());
      }
      for (const target of ['docs/alpha.md', 'odd/alpha.md', 'odd/tasks/nested/alpha.md', 'odd/tasks/.alpha.md', 'odd/tasks/alpha.txt']) {
        await fire(loaded, 'tool_result', writeEvent(target), ctxOf());
      }
      assert.deepEqual(touches(loaded), []);
      assert.deepEqual(loaded.entries, []);
    });
  });

  test('a FAILED write leaves no row and no entry', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/alpha.md', { isError: true }), ctxOf());
      assert.deepEqual(touches(loaded), []);
      assert.deepEqual(loaded.entries, []);
    });
  });

  test('asks for one immediate refresh, and an unset callback is a no-op', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      // No callback set: the touch still lands.
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/alpha.md'), ctxOf());
      assert.equal(touches(loaded).length, 1);

      const requested = [];
      loaded.mod.setOddSessionRefresh(() => requested.push('refresh'));
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/beta.md'), ctxOf());
      await fire(loaded, 'tool_result', { ...writeEvent('odd/tasks/gamma.md'), toolName: 'read' }, ctxOf());
      assert.equal(requested.length, 1);
      // Unsetting it is the same no-op as never setting it.
      loaded.mod.setOddSessionRefresh(null);
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/delta.md'), ctxOf());
      assert.equal(requested.length, 1);
    });
  });

  test('a host without the appendEntry seam, or one that throws, still records the touch', async () => {
    await presentGh(async () => {
      for (const seam of ['absent', 'throwing']) {
        publishBridge(undefined);
        const loaded = await loadModule({ appendEntry: seam });
        await fire(loaded, 'tool_result', writeEvent('odd/tasks/alpha.md'), ctxOf());
        assert.deepEqual(touches(loaded).map((touch) => touch.name), ['alpha'], seam);
        assert.deepEqual(loaded.entries, [], seam);
      }
    });
  });
});

describe('the session boundary (S8/S9)', () => {
  // Pi's CustomEntry shape (docs/session-format.md), which is what every reader in
  // this package filters on: `type === "custom"`, `customType`, `data`.
  const touchEntry = (id, file, at) => ({
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    customType: ENTRY_TYPE,
    data: { path: path.join(TASKS, file), at },
  });

  test('a resumed session remembers what it touched, and a new one restores the same way', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      assert.deepEqual(touches(loaded), []);
      const persisted = [
        { type: 'message', id: 'm', role: 'user' },
        touchEntry('a', 'alpha.md', 1000),
        { type: 'custom', customType: 'odd-worktree.other', data: { path: '/x/odd/tasks/nope.md', at: 2000 } },
        touchEntry('b', 'beta.md', 3000),
      ];
      const calls = [];
      await fire(loaded, 'session_start', { reason: 'resume' }, ctxOf(persisted, calls));
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['beta', 'alpha']);
      assert.ok(calls.length > 0, 'the handler reads the session manager’s own entries');

      loaded.mod.oddSession.clear();
      assert.deepEqual(touches(loaded), []);
      await fire(loaded, 'session_start', { reason: 'new' }, ctxOf(persisted, calls));
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['beta', 'alpha']);
    });
  });

  test('a resumed session then records a new touch on top of the restored ones', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      await fire(loaded, 'session_start', { reason: 'resume' }, ctxOf([touchEntry('a', 'alpha.md', 1000)]));
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/gamma.md'), ctxOf());
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['gamma', 'alpha']);
    });
  });

  test('a session manager that cannot answer restores nothing and throws nothing', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      const broken = {
        cwd: CWD,
        ui: { notify: () => {} },
        sessionManager: {
          getEntries: () => {
            throw new Error('no entries');
          },
        },
      };
      await fire(loaded, 'session_start', { reason: 'resume' }, broken);
      assert.deepEqual(touches(loaded), []);
    });
  });
});

describe('a subagent’s write (S9)', () => {
  test('never reaches this session’s record: no event, no touch', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      // A subagent runs in its OWN session, so its `write` of an `odd/tasks` document
      // is observed by its own handler and by nobody else. The parent's record grows
      // only from an event the parent's own host delivers — there is none here — and
      // the document is covered by the filesystem scan, which is the source of truth
      // for existence, location and recency (S9).
      await fire(loaded, 'session_start', { reason: 'startup' }, ctxOf([]));
      assert.deepEqual(touches(loaded), []);
      assert.deepEqual(loaded.entries, []);
    });
  });
});

describe('the module switch and the neighbouring observations', () => {
  test('with Worktrees+ OFF a write or an edit of an odd/tasks document is STILL recorded and persisted', async () => {
    await presentGh(async () => {
      publishBridge({ worktrees: false });
      const loaded = await loadModule();
      // The ODD rail is `Worktrees+`'s surface, so the attribution of what this session
      // writes cannot be behind that switch: the record exists and grows with the module
      // off, and a resumed session restores it there too.
      assert.ok(loaded.mod.oddSession, 'the record exists with the worktree module off');
      await fire(loaded, 'tool_result', writeEvent('odd/tasks/alpha.md'), ctxOf());
      await fire(loaded, 'tool_result', { ...writeEvent('odd/tasks/beta.md'), toolName: 'edit' }, ctxOf());
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['beta', 'alpha']);
      assert.deepEqual(touchEntries(loaded).map((entry) => entry.data.path), [
        path.join(TASKS, 'alpha.md'),
        path.join(TASKS, 'beta.md'),
      ]);
      await fire(loaded, 'session_start', { reason: 'resume' }, ctxOf([
        {
          type: 'custom',
          id: 'a',
          parentId: null,
          timestamp: new Date(1000).toISOString(),
          customType: ENTRY_TYPE,
          data: { path: path.join(TASKS, 'gamma.md'), at: 1000 },
        },
      ]));
      assert.deepEqual(touches(loaded).map((touch) => touch.name), ['gamma']);
    });
  });

  // The shared fixture's own fake host, which is what a suite that asserts the
  // registered surface uses.
  test('only the existing worktree observations stay behind the switch: the touch one does not', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const on = await loadExtension({});
      publishBridge({ worktrees: false });
      const off = await loadExtension({});
      const onToolResult = handlersOf(on, 'tool_result').length;
      const offToolResult = handlersOf(off, 'tool_result').length;
      // Exactly ONE `tool_result` observation is the worktree half's: the ODD-naming
      // observer. The touch observation and the issues one are NOT, so the gap is one.
      assert.equal(onToolResult - offToolResult, 1);
      assert.ok(offToolResult >= 2, 'the touch observation is still registered with the module off');

      const ctx = ctxOf();
      for (const handler of handlersOf(off, 'tool_result')) await handler(writeEvent(), ctx);
      assert.deepEqual(off.entries.map((entry) => entry.customType), [ENTRY_TYPE]);
    });
  });

  test('a write on an odd/tasks document reaches the existing tool_call observations unchanged', async () => {
    await presentGh(async () => {
      publishBridge(undefined);
      const loaded = await loadModule();
      const results = await fire(loaded, 'tool_call', writeEvent(), ctxOf());
      assert.ok(results.length >= 4, 'the naming observer and the guards are all still there');
      for (const result of results) assert.equal(result, undefined, 'nothing blocks a write on an odd document');
      assert.deepEqual(touches(loaded), [], 'a call that has not finished is not a touch');
    });
  });
});

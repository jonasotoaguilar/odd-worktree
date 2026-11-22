'use strict';
// T4, second half (odd-rail-section S1, S5, S6, S7, S9, S12, S13): the ODD rail
// section as the HOST sees it, through the fake host and the bridge's published
// object only.
//
// What this asserts, in the order the extension really does it:
// - The section is registered on the bridge with id `odd-worktree.odd-rail`, title
//   `ODD` and `placement: { after: "agents" }` (S1), and with `Worktrees+` OFF —
//   the corrected S7: registration is what gates the rail, never the module — and
//   with NO bridge nothing is registered at all (the bridge object is the only
//   gate).
// - The rows come from the grouped model scoped to the SESSION's registered
//   worktrees: one row per ODD name (S12), `meta` naming the copy the click opens
//   (S5), main's whole list when nothing is registered, and nothing from a
//   registered worktree whose delta is empty (S13).
// - A `write`/`edit` recorded by T8 reorders the touched ODD first and forces an
//   IMMEDIATE refresh — observable without any second draw, because the section's
//   own TTL keeps `lines()` from reading again (S9).
// - A click dispatches exactly ONE `/odd <path>` message through the one-shot
//   guard, a second click inside the guard window dispatches nothing, and running
//   the command releases the guard (S6).
// - `session_shutdown` disposes the section: the bridge's unregister runs and the
//   disposed section neither reads nor dispatches again.
//
// The git reads are observed through the module instance THIS load uses
// (`libModule('worktree-git.js').runArgvAsync`), so the evidence is the argv and
// the checkout each read ran in, never a count the source could satisfy some
// other way.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  BRIDGE_SLOT,
  LIB_DIR,
  defaultBridge,
  stubbedSource,
  withGhPath,
} = require('./fixtures/load-extension.js');

const RAIL_ID = 'odd-worktree.odd-rail';
const SESSION_WORKTREE_CUSTOM_TYPE = 'gentle-pi.session-worktree/v1';

const scratch = [];
function track(dir) {
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

// A repository whose `odd/tasks` holds two documents with deliberately distinct
// mtimes, so a frame can tell which order the rail drew them in.
function makeRepo() {
  const dir = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-rail-wiring-'))));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  const tasks = path.join(dir, 'odd', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'first.md'), '# body of first\n');
  fs.writeFileSync(path.join(tasks, 'second.md'), '# body of second\n');
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(tasks, 'first.md'), now - 100, now - 100);
  fs.utimesSync(path.join(tasks, 'second.md'), now - 200, now - 200);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

// The worktree directory the package owns (`<repo-parent>/<repo-name>-worktrees`),
// which is the one the grouped model treats as owned.
function addWorktree(repo, name) {
  const owned = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  fs.mkdirSync(owned, { recursive: true });
  const root = path.join(owned, name);
  git(repo, ['worktree', 'add', '-b', `feat/${name}`, root, 'main']);
  return root;
}

function writeTask(root, name, body, secondsAgo = 0) {
  const tasks = path.join(root, 'odd', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  const file = path.join(tasks, `${name}.md`);
  fs.writeFileSync(file, body);
  if (secondsAgo > 0) {
    const stamp = Date.now() / 1000 - secondsAgo;
    fs.utimesSync(file, stamp, stamp);
  }
  return file;
}

// One extension load per test with a bridge that records what the rail registers
// and what it releases. `modules` is the bridge's own store document, so
// `{ worktrees: false }` is exactly the Worktrees+ switch a host would have.
let loads = 0;
async function load(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const bridge = defaultBridge();
  const sections = [];
  const disposers = [];
  const repaints = [];
  const document = opts.modules === undefined ? undefined : { ...opts.modules };
  bridge.api.createStore = () => ({
    get: (key, fallback) => (key === 'modules' && document !== undefined ? document : fallback),
    set: () => {},
    delete: () => {},
  });
  bridge.api.requestRepaint = () => { repaints.push(1); };
  bridge.api.registerSection = (section) => {
    sections.push(section);
    const disposer = () => {
      disposers.push(section.id);
      if (opts.disposerThrows === true) throw new Error('no unregister for you');
    };
    return disposer;
  };
  globalThis[BRIDGE_SLOT] = bridge.api;
  // A host with no bridge registers nothing, so the case below removes the object
  // and then publishes one late, exactly like the plugin's own `ready` event.
  if (opts.noBridge === true) delete globalThis[BRIDGE_SLOT];
  return withGhPath('present', async () => {
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-rail-ext-'));
    try {
      const copy = path.join(dir, 'odd-worktree-tools.mjs');
      fs.writeFileSync(copy, stubbedSource());
      loads += 1;
      const mod = await import(`${pathToFileURL(copy).href}?load=${loads}`);
      const commands = new Map();
      const tools = new Map();
      const hooks = [];
      const ready = [];
      const messages = [];
      const host = {
        registerCommand: (name, handler) => commands.set(name, handler),
        registerTool: (tool) => tools.set(tool.name, tool),
        registerMessageRenderer: () => {},
        registerEntryRenderer: () => {},
        appendEntry: () => {},
        sendUserMessage: (text, options) => { messages.push({ text, options }); },
        on: (event, handler) => { hooks.push([event, handler]); },
        // The bridge announces its publication on ONE event; a host without the
        // seam never subscribes, so the fallback below needs it to exist.
        events: { on: (event, handler) => { ready.push({ event, handler }); } },
      };
      mod.default(host);
      return { mod, host, bridge, sections, disposers, repaints, commands, tools, hooks, ready, messages };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function sectionOf(loaded) {
  return loaded.sections.find((section) => section && section.id === RAIL_ID);
}

function ctxFor(repo, registeredRoots = []) {
  return {
    cwd: repo,
    hasUI: true,
    mode: 'tui',
    sessionManager: {
      getSessionId: () => 'thread-1',
      getEntries: () => registeredRoots.map((root) => ({
        type: 'custom',
        customType: SESSION_WORKTREE_CUSTOM_TYPE,
        data: { sessionId: 'thread-1', root, evidence: 'session:tool' },
      })),
    },
    ui: { notify: () => {}, custom: undefined, select: undefined },
  };
}

// The session_start hook is what captures the ctx the section's `load` reads.
function startSession(loaded, ctx) {
  for (const [event, handler] of loaded.hooks) {
    if (event === 'session_start') handler({}, ctx);
  }
}

function shutdown(loaded, ctx) {
  for (const [event, handler] of loaded.hooks) {
    if (event === 'session_shutdown') handler({}, ctx);
  }
}

function noteWrite(loaded, ctx, file) {
  for (const [event, handler] of loaded.hooks) {
    if (event !== 'tool_result') continue;
    handler({ toolName: 'write', isError: false, input: { path: file } }, ctx);
  }
}

// The rows the rail drew, as the host reads them: label, right-hand meta.
async function waitForRows(section, ctx, count) {
  const deadline = Date.now() + 20_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = section.lines(ctx) || [];
    if (rows.length === count && rows.every((row) => row.label !== 'loading…')) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} rows; last frame was ${JSON.stringify(rows.map((row) => row.label))}`);
}

// The same frame, twice: only a FORCED read can change it, because the section's
// own TTL (a minute) makes `lines()` schedule nothing.
async function offset(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function observeGit(mod) {
  const gitLib = mod.libModule('worktree-git.js');
  const real = gitLib.runArgvAsync;
  const calls = [];
  gitLib.runArgvAsync = (bin, argv, options) => {
    calls.push({ argv: [...argv], cwd: options && options.cwd });
    return real.call(gitLib, bin, argv, options);
  };
  return {
    calls,
    clear: () => { calls.length = 0; },
    listing: () => calls.filter((call) => call.argv.includes('worktree') && call.argv.includes('list')),
    restore: () => { gitLib.runArgvAsync = real; },
  };
}

const savedBridge = globalThis[BRIDGE_SLOT];
after(() => {
  if (savedBridge === undefined) delete globalThis[BRIDGE_SLOT];
  else globalThis[BRIDGE_SLOT] = savedBridge;
});

describe('registration (S1, corrected S7)', () => {
  test('the rail is registered with Worktrees+ OFF, titled ODD, right after AGENTS', async () => {
    const loaded = await load({ modules: { codegraph: true, worktrees: false } });
    const section = sectionOf(loaded);
    assert.ok(section, 'the ODD rail is a section of its own');
    assert.equal(section.title, 'ODD');
    assert.deepEqual(section.placement, { after: 'agents' });
    assert.equal(typeof section.lines, 'function', 'the host paints it through `lines`');
    // Corrected S7: the rail is not one of the Worktrees+ surfaces. With that
    // module off the worktree TOOLS are gone — and the rail is still there, so
    // nothing it registered read `oddModules.worktrees`.
    assert.deepEqual([...loaded.tools.keys()], [], 'Worktrees+ off registers no worktree tool');
    assert.ok(loaded.commands.has('odd'), 'and `/odd` is still the command a click dispatches');
  });

  test('with no bridge nothing is registered, and a late publication registers it', async () => {
    const loaded = await load({ noBridge: true });
    assert.equal(globalThis[BRIDGE_SLOT], undefined, 'the slot really is empty');
    assert.deepEqual(loaded.sections, [], 'nothing is contributed without a bridge');

    // The plugin publishes afterwards and announces it: the ONE subscription the
    // extension made answers with the section.
    globalThis[BRIDGE_SLOT] = loaded.bridge.api;
    const ready = loaded.ready.filter((entry) => entry.event === 'gentle-shell-bridge:ready');
    assert.equal(ready.length, 1, 'one subscription for the announcement');
    for (const entry of ready) entry.handler();
    assert.equal(loaded.sections.filter((section) => section.id === RAIL_ID).length, 1,
      'the late publication registers the rail once');
  });
});

describe('the rows the rail draws (S5, S12, S13)', () => {
  test('main only when no worktree is registered, and one row per name with `main` as meta', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const ctx = ctxFor(repo, []);
    startSession(loaded, ctx);
    const section = sectionOf(loaded);
    const rows = await waitForRows(section, ctx, 2);
    assert.deepEqual(rows.map((row) => [row.label, row.meta]), [['first', 'main'], ['second', 'main']],
      'newest first, each row naming the checkout the click opens');
    assert.equal(typeof rows[0].onClick, 'function', 'a row is clickable');
  });

  test('a registered worktree contributes its own delta, and the newest copy of a name is elected', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const worktree = addWorktree(repo, 'wt-a');
      // Byte-identical copies: nothing of its own, so it contributes no row (S13).
      for (const name of ['first', 'second']) {
        writeTask(worktree, name, fs.readFileSync(path.join(repo, 'odd', 'tasks', `${name}.md`), 'utf8'), 300);
      }
      const ctx = ctxFor(repo, [worktree]);
      startSession(loaded, ctx);
      const section = sectionOf(loaded);
      const mainOnly = await waitForRows(section, ctx, 2);
      assert.deepEqual(mainOnly.map((row) => row.meta), ['main', 'main'],
        'a registered worktree with no delta adds no row and no chrome');
      assert.ok(observed.listing().length > 0, 'the grouping ran, so the empty delta is a real answer');

      // Now the worktree works on one of main's ODDs and on one of its own.
      writeTask(worktree, 'second', '# body of second, changed here\n');
      writeTask(worktree, 'wt-only', '# body of wt-only\n');
      shutdown(loaded, ctx);
      // A fresh load for a fresh projection: the section is a new binding.
      const again = await load();
      const ctxAgain = ctxFor(repo, [worktree]);
      startSession(again, ctxAgain);
      const rows = await waitForRows(sectionOf(again), ctxAgain, 3);
      const byName = new Map(rows.map((row) => [row.label, row]));
      assert.equal(byName.get('second').meta, 'wt-a', 'the newest copy is the worktree’s');
      assert.equal(byName.get('wt-only').meta, 'wt-a', 'a worktree-only ODD is one row of its own');
      assert.equal(byName.get('first').meta, 'main');
      assert.equal(rows.length, 3, 'two main ODDs plus the worktree’s own, one row each');
      assert.ok(rows.some((row) => row.label === 'second' && row.meta === 'wt-a'));
    } finally {
      observed.restore();
    }
  });

  test('the body holds four rows and one inert `N more` line (S2)', async () => {
    const loaded = await load();
    const repo = makeRepo();
    for (const name of ['third', 'fourth', 'fifth', 'sixth']) {
      writeTask(repo, name, `# body of ${name}\n`, 400);
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'more']);
    const ctx = ctxFor(repo, []);
    startSession(loaded, ctx);
    const section = sectionOf(loaded);
    const deadline = Date.now() + 20_000;
    let rows = [];
    while (Date.now() < deadline) {
      rows = section.lines(ctx) || [];
      if (rows.length === 5 && rows[0].label !== 'loading…') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rows.length, 5, 'four ODDs and the elision line');
    assert.equal(rows[4].label, '2 more');
    assert.equal(rows[4].tone, 'dim');
    assert.equal(rows[4].onClick, null, 'the elision row is inert');
  });
});

describe('attribution and the click (S6, S9)', () => {
  test('a write recorded by T8 sends its ODD first and forces the refresh', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const ctx = ctxFor(repo, []);
    startSession(loaded, ctx);
    const section = sectionOf(loaded);
    const before = await waitForRows(section, ctx, 2);
    assert.deepEqual(before.map((row) => row.label), ['first', 'second'], 'recency, untouched');

    // A `write` landing on `second.md`: the record moves it to the front and asks
    // for ONE refresh. Nothing here draws for it — the change must arrive through
    // the forced read, because `lines()` inside the TTL starts no read of its own.
    noteWrite(loaded, ctx, path.join(repo, 'odd', 'tasks', 'second.md'));
    const deadline = Date.now() + 20_000;
    let rows = section.lines(ctx) || [];
    while (Date.now() < deadline) {
      rows = section.lines(ctx) || [];
      if (rows[0] && rows[0].label === 'second') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(rows.map((row) => row.label), ['second', 'first'],
      'the touched ODD is first; the order came from the forced refresh, not a draw');
    assert.ok(loaded.repaints.length > 0, 'the applied read repainted the rail');
  });

  test('a click dispatches ONE /odd message, a second click inside the guard dispatches nothing', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const ctx = ctxFor(repo, []);
    startSession(loaded, ctx);
    const section = sectionOf(loaded);
    const rows = await waitForRows(section, ctx, 2);
    const target = path.join(repo, 'odd', 'tasks', 'first.md');

    rows[0].onClick();
    rows[0].onClick();
    await offset(30);
    assert.deepEqual(loaded.messages.map((message) => message.text), [`/odd ${target}`],
      'exactly one dispatch, from the row the human clicked');
    assert.deepEqual(loaded.messages[0].options, { expandPromptTemplates: true },
      'dispatched as a prompt-template message, exactly like the issues rail');

    // Running the command releases the guard, so the next click is a new open.
    const pending = loaded.commands.get('odd').handler(target, ctx);
    pending.catch(() => {});
    try { await pending; } catch {}
    rows[0].onClick();
    await offset(30);
    assert.equal(loaded.messages.length, 2, 'the guard was released when the command ran');
    assert.equal(loaded.messages[1].text, `/odd ${target}`);
  });

  test('a path with a space round-trips through the click into the /odd target', async () => {
    const loaded = await load();
    const repo = makeRepo();
    const spaced = writeTask(repo, 'with space', '# body of with space\n');
    const ctx = ctxFor(repo, []);
    startSession(loaded, ctx);
    const section = sectionOf(loaded);
    const deadline = Date.now() + 20_000;
    let rows = [];
    while (Date.now() < deadline) {
      rows = section.lines(ctx) || [];
      if (rows.length === 3 && rows[0].label !== 'loading…') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const row = rows.find((entry) => entry.label === 'with space');
    assert.ok(row, `the ODD whose name holds a space is a row: ${JSON.stringify(rows.map((r) => r.label))}`);
    row.onClick();
    await offset(30);
    assert.equal(loaded.messages.length, 1);
    const message = loaded.messages[0].text;
    // THE round-trip: the command the host runs receives the argument the same way
    // Pi hands a `/command <args>` message over — the rest of the line, verbatim.
    const args = message.startsWith('/odd ') ? message.slice('/odd '.length) : '';
    assert.equal(args, spaced, 'the absolute document path travels unchanged');
    const notify = [];
    const oddCtx = { ...ctxFor(repo, []), ui: { notify: (text) => { notify.push(text); } } };
    await loaded.commands.get('odd').handler(args, oddCtx);
    // The accepted answer is the viewer's own line (this host has no overlay); a
    // refused target answers the sentence every unknown argument has always got.
    assert.equal(notify.some((line) => /^Unknown option "/.test(line)), false,
      `the command accepted the spaced path instead of refusing it: ${JSON.stringify(notify)}`);
  });
});

describe('teardown (S6, S9)', () => {
  test('session_shutdown disposes the section and stops it reading and dispatching', async () => {
    const loaded = await load();
    const observed = observeGit(loaded.mod);
    try {
      const repo = makeRepo();
      const ctx = ctxFor(repo, []);
      startSession(loaded, ctx);
      const section = sectionOf(loaded);
      const rows = await waitForRows(section, ctx, 2);
      shutdown(loaded, ctx);
      assert.ok(loaded.disposers.includes(RAIL_ID), 'the bridge’s own unregister ran for the rail');

      observed.clear();
      section.lines(ctx);
      rows[0].onClick();
      noteWrite(loaded, ctx, path.join(repo, 'odd', 'tasks', 'second.md'));
      await offset(40);
      assert.deepEqual(observed.calls, [], 'a disposed section starts no git read');
      assert.deepEqual(loaded.messages, [], 'and dispatches nothing');
    } finally {
      observed.restore();
    }
  });
});

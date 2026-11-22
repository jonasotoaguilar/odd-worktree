'use strict';
// T3 (S1,S3,S4) public command tests: the `/issues` command in
// extensions/odd-worktree-tools.ts, driven through the registered handler.
//
// Contract under test (observable behavior only — registration, the notified
// text, the overlay options, the rendered marks, the registry bytes, the argv
// reaching the injected `gh` runner; never internal names):
// - the command is registered eagerly at load, and the session-start `gh`
//   check only gates the INVOCATION: a missing or unauthenticated `gh`
//   notifies once per session with what is missing and the command that fixes
//   it, then refuses on invocation instead of opening;
// - no argument opens the four-bucket overlay through ctx.ui.custom with the
//   odd viewer's full-screen options, fed by cursor pages: the three scoped
//   searches (author:@me, assignee:@me, involves:@me -author:@me), the
//   unfiltered `All` connection, the detail, repo labels and assignable users;
// - the repository identity is PINNED host-qualified when the list loads:
//   every page, detail, label and assignee read binds it, and the `o` opener
//   opens `gh issue view <n> --web -R <pinned>` (fixed argv, terminal
//   suspended for the open) rather than whatever the checkout resolves to now;
// - a mutation runs only while the checkout still resolves to the displayed
//   repository, and otherwise refuses without running `gh`; a client failure
//   keeps the draft, shows the error and claims no success;
// - no worktree↔issue association exists: the view is handed no `assigned`,
//   no `saveAssignment` and no `assignmentEnabled`, and reading writes nothing.
//
// The TypeScript extension is plain JS under the hood, so the shared fixture
// copies it to a temporary .mjs with the package imports stubbed; `gh` is
// injected through the real lib/gh-issues.js `setGhRunner` seam (same module
// instance the extension loads via GENTLE_WORKTREE_LIB_DIR), so no live `gh`
// runs and no real GitHub mutation is possible.

const { test, describe, after, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LIB_DIR, stubbedSource, installDefaultBridge, withGhPath } = require('./fixtures/load-extension.js');

// The client and git seam the extension itself loaded. One extension load compiles
// its own lib modules, so a fake must reach THAT instance — the extension's
// `libModule` seam — instead of a separate `require` of the same path. Each load
// below rebinds these, so a case always patches the instance its handler uses.
let ghIssues = require('../lib/gh-issues.js');
let worktreeGit = require('../lib/worktree-git.js');

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeRepo({ tag = 'issues' } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-issues-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

afterEach(() => {
  ghIssues.setGhRunner(null);
  ghIssues.setGhWhich(null);
  // S5 (T8): the gate's clock seam and its cache are process state too; every
  // test loads its own extension instance, and a leftover fake clock must not
  // reach the next one.
  if (typeof ghIssues.setGateClock === 'function') ghIssues.setGateClock(null);
  if (typeof ghIssues.clearCachedGhStatus === 'function') ghIssues.clearCachedGhStatus();
  // S8 (T4): the rail's published bridge is process-wide, so no test may leave
  // one behind for the next.
  delete globalThis[Symbol.for('gentle-shell-bridge/api/v1')];
});

// S4 (T3): the read cache has a disk half now, so every test gets its own cache
// directory — no test inherits a warm identity from another, and nothing here can
// touch the real `$XDG_CACHE_HOME`/home.
beforeEach(() => {
  process.env.XDG_CACHE_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-cache-')));
});

const FIXTURES = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// A fresh copy per load: module-level gate state belongs to one runtime load,
// exactly like the host's rebuilt command registry.
//
// S13 (T11): the issues surfaces are registered only when the local presence probe
// finds `gh`, and that probe reads PATH (the extension compiles its own
// `lib/gh-issues.js`, so a seam set here would not reach it). The load therefore
// runs with a PATH that answers the way the case asked — present unless it passes
// `{ gh: false }` — so the machine the suite runs on decides nothing.
async function loadExtension(options = {}) {
  // S18 (T14): the extension registers nothing without gentle-shell-bridge, so
  // this file's own host publishes the shared fixture's bridge before the load.
  installDefaultBridge();
  return withGhPath(options && options.gh === false ? 'absent' : 'present', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-ext-')));
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const commands = new Map();
    const hooks = [];
    const api = {
      registerTool: () => {},
      registerCommand: (name, definition) => { commands.set(name, definition); },
      registerMessageRenderer: () => {},
      on: (event, handler) => { hooks.push([event, handler]); return () => {}; },
    };
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const mod = await import(pathToFileURL(copy).href);
    const factory = mod.default;
    factory(api);
    ghIssues = mod.libModule('gh-issues.js');
    worktreeGit = mod.libModule('worktree-git.js');
    modsFor.set(hooks, mod);
    return { commands, hooks, api, mod, factory };
  });
}

function sessionStartHandlers(hooks) {
  return hooks.filter(([event]) => event === 'session_start').map(([, handler]) => handler);
}

// The module one load produced, keyed by the hooks it registered: the startup work
// `session_start` DISPATCHES (never awaits, T1) is reachable only through it.
const modsFor = new Map();

async function fireSessionStart(hooks, ctx) {
  for (const handler of sessionStartHandlers(hooks)) {
    const out = handler({}, ctx);
    if (out && typeof out.then === 'function') await out;
  }
  // S1/S2 (T1): the `gh` gate is no longer on the AWAITED path — it is dispatched
  // as tracked startup work — so a test that asserts on the gate's own answer
  // waits for that work here, the way the host's shutdown barrier does, instead of
  // racing it. The one test that proves the awaited path is free of it fires the
  // handlers itself and never reaches this helper.
  const mod = modsFor.get(hooks);
  if (mod && typeof mod.awaitPendingStartupTasks === 'function') {
    await mod.awaitPendingStartupTasks();
  }
}

// This file is about the `gh` gate and the panel. The missing-bridge hint is another surface
// (tools/issues-section.test.js owns it) and it fires ONCE per process, so which test here saw it
// first would depend on execution order: a test that counts notifications passed only because an
// earlier one had already consumed the hint. The fixtures leave it out, so every count below means
// the same thing alone or in the full run.
const BRIDGE_HINT = /gentle-shell-bridge/;
const recordNote = (notes) => (message, level) => {
  if (!BRIDGE_HINT.test(String(message))) notes.push([message, level]);
};

function gateCtx(cwd, notes) {
  return { cwd, ui: { notify: recordNote(notes) } };
}

const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

function makeHostTui(rows = 24) {
  const paints = [];
  const lifecycle = [];
  const stops = [];
  return {
    paints,
    lifecycle,
    stops,
    tui: {
      terminal: { rows },
      stop: (options) => { lifecycle.push('stop'); stops.push(options); },
      start: () => lifecycle.push('start'),
      requestRender: (force) => { lifecycle.push('render'); paints.push(force === true); },
    },
  };
}

function makeCtx({ cwd, customImpl } = {}) {
  const notes = [];
  const customs = [];
  const selects = [];
  const ctx = {
    cwd,
    ui: {
      notify: recordNote(notes),
      select: async (title, options) => { selects.push([title, options]); return undefined; },
    },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, customs, selects };
}

function openComponent(factory, host) {
  let settled = 'pending';
  const component = factory(host.tui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  assert.equal(typeof component.invalidate, 'function');
  return { component, done: () => settled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// Captures the options the extension mounts the real view with, leaving every
// client call real and injectable. The patched module is the extension's OWN view
// instance (`attach`), taken from the load that will mount it.
function captureIssuesView() {
  const holder = { options: null };
  let lib;
  let original;
  return {
    holder,
    attach(mod) {
      lib = mod.libModule('issues-view.js');
      original = lib.createIssuesView;
      lib.createIssuesView = (options) => {
        holder.options = options;
        return { render: () => [], handleInput: () => {}, invalidate: () => {} };
      };
    },
    restore() {
      if (lib) lib.createIssuesView = original;
    },
  };
}

// One issue node in the shape both GraphQL page queries ask for.
function graphqlIssueNode(row) {
  return {
    number: row.number,
    title: row.title,
    state: String(row.state || 'OPEN').toUpperCase(),
    stateReason: '',
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: { login: (row.author && row.author.login) || 'someone' },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reactionGroups: [],
  };
}

function graphqlField(argv, name, flag = '-F') {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
  }
  return null;
}

// The cursor-paged SEARCH snapshot the scoped tabs read through
// `getIssuePage`: every edge carries its own opaque cursor.
function graphqlSearchPage(argv, rows) {
  const first = Number(graphqlField(argv, 'first'));
  const after = graphqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('row-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      search: {
        issueCount: rows.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `row-${start + page.length - 1}` : null },
        edges: page.map((row, at) => ({ cursor: `row-${start + at}`, node: graphqlIssueNode(row) })),
      },
    },
  });
}

// The cursor-paged CONNECTION snapshot the unfiltered `All` bucket reads.
function graphqlConnectionPage(argv, rows) {
  const first = Number(graphqlField(argv, 'first'));
  const after = graphqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('conn-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      repository: {
        issues: {
          totalCount: rows.length,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `conn-${start + page.length - 1}` : null },
          edges: page.map((row, at) => ({ cursor: `conn-${start + at}`, node: graphqlIssueNode(row) })),
        },
      },
    },
  });
}

// Every call that read the repository issue CONNECTION — the `All` bucket's
// source. A search call is not one of them.
function connectionReads(calls) {
  return calls
    .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
    .map((call) => ({
      query: graphqlField(call.argv, 'query', '-f') || '',
      first: graphqlField(call.argv, 'first'),
      cursor: graphqlField(call.argv, 'cursor'),
      argv: call.argv,
    }))
    .filter((read) => read.query.includes('issues(states: [') && read.query.includes('edges { cursor node'));
}

// The exact source query each fresh search page asked for, with the client's
// own `repo:… is:issue is:open` prefix removed.
function searchQueries(calls) {
  return calls
    .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
    .map((call) => graphqlField(call.argv, 'search'))
    .filter((value) => value !== null)
    .map((value) => value.replace(/^repo:\S+ is:issue is:open /, ''));
}

// Pattern-matching `gh` runner over the captured real-`gh` fixtures: answers by
// argv shape and records every call, so the action tests pin the exact fixed
// argv each write reaches `gh` with. `WRITE` is the default role because the
// label test creates a label, which needs canCreateLabels.
function makeIssuesRunner({ failComment = false, role = 'WRITE', connectionRows = null } = {}) {
  const calls = [];
  const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
  const rows = JSON.parse(fixture('gh-issue-list.json'));
  const runner = async (bin, argv, opts) => {
    calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const query = graphqlField(argv, 'query', '-f') || '';
      if (query.includes('assignableUsers')) {
        return ok(JSON.stringify({ data: { repository: { assignableUsers: {
          nodes: [{ login: 'jonasotoaguilar', name: 'Jonathan Soto' }, { login: 'octocat', name: 'Octo Cat' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } }));
      }
      if (query.includes('projectItems')) {
        return ok(JSON.stringify({ data: { repository: { issue: {
          projectItems: { nodes: [], pageInfo: { hasNextPage: false } },
        } } } }));
      }
      if (query.includes('viewerPermission')) {
        return ok(JSON.stringify({ data: { repository: {
          viewerPermission: role,
          issue: {
            assignees: { nodes: [{ login: 'jonasotoaguilar' }], pageInfo: { hasNextPage: false } },
            closedByPullRequestsReferences: { nodes: [{ number: 69 }, { number: 77 }], pageInfo: { hasNextPage: false } },
          },
        } } }));
      }
      if (query.includes('type: ISSUE')) return ok(graphqlSearchPage(argv, rows));
      if (query.includes('edges { cursor node')) return ok(graphqlConnectionPage(argv, connectionRows || rows));
      return ok(JSON.stringify({ data: { repository: { issues: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } } }));
    }
    if (argv[0] === 'api') return ok(fixture('gh-api-user.json'));
    if (argv[0] === 'repo') return ok(fixture('gh-repo-view.json'));
    if (argv[0] === 'issue' && argv[1] === 'list') return ok(fixture('gh-issue-list.json'));
    if (argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')) {
      return ok(fixture('gh-issue-view.json'));
    }
    if (argv[0] === 'label' && argv[1] === 'list') return ok(fixture('gh-label-list.json'));
    if (argv[0] === 'label' && argv[1] === 'create') return ok('{}');
    if (argv[0] === 'issue' && argv[1] === 'comment') {
      if (failComment) return { status: 1, stdout: '', stderr: 'rate limited', error: null };
      return ok('');
    }
    if (argv[0] === 'issue' && (argv[1] === 'edit' || argv[1] === 'close' || argv[1] === 'reopen')) {
      return ok('');
    }
    return ok('');
  };
  return { runner, calls };
}

function registryFile(root) {
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  const commonDir = path.isAbsolute(common) ? common : path.resolve(root, common);
  return path.join(commonDir, 'pi-worktrees.json');
}

// Gate the extension through session_start with a scratch cwd (so the
// unrelated worktree discovery never touches the fixture repo), then run the
// command handler against the fixture checkout.
async function openIssues(root, { runner, rows = 24, prepare, args = '' } = {}) {
  const loaded = await loadExtension();
  // `prepare` receives the load that is about to run the command, so a test's fake
  // lands on the instance the command actually mounts.
  if (typeof prepare === 'function') prepare(loaded.mod);
  ghIssues.setGhRunner(runner || makeIssuesRunner().runner);
  const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
  await fireSessionStart(loaded.hooks, gateCtx(scratch, []));
  const def = loaded.commands.get('issues');
  assert.ok(def, 'expected the issues command to be registered');
  loaded.mod.setIssuesTuiLoader(async () => stubTui);
  const host = makeHostTui(rows);
  let factory = null;
  const { ctx, notes, customs } = makeCtx({
    cwd: root,
    customImpl: async (captured) => { factory = captured; return null; },
  });
  await def.handler(args, ctx);
  assert.ok(factory, 'the overlay opens');
  const { component, done } = openComponent(factory, host);
  await tick();
  return { component, notes, customs, commands: loaded.commands, done, host };
}

// The options the command mounts the real view with, over the real injected
// `gh`, while every client call the extension makes stays real and injectable.
async function capturedIssuesOptions(root, options = {}) {
  const injected = options.runner
    ? { runner: options.runner, calls: options.calls || [] }
    : makeIssuesRunner(options);
  const capture = captureIssuesView();
  try {
    const loaded = await loadExtension();
    capture.attach(loaded.mod);
    ghIssues.setGhRunner(injected.runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(loaded.hooks, gateCtx(scratch, []));
    loaded.mod.setIssuesTuiLoader(async () => stubTui);
    const host = makeHostTui(options.rows || 24);
    const { ctx } = makeCtx({ cwd: root });
    ctx.ui.custom = async (factory) => {
      factory(host.tui, {}, {}, () => {});
      return null;
    };
    await loaded.commands.get('issues').handler(options.args || '', ctx);
    await tick();
    assert.ok(capture.holder.options, 'the command mounts the view');
    return {
      options: capture.holder.options,
      calls: injected.calls,
      host,
      restore: capture.restore,
    };
  } catch (err) {
    capture.restore();
    throw err;
  }
}

describe('/issues gate (S3)', () => {
  test('registers the command eagerly, independent of the gh check', async () => {
    const { commands } = await loadExtension();
    const def = commands.get('issues');
    assert.ok(def, 'the command is registered at load');
    assert.equal(typeof def.handler, 'function');
    assert.match(def.description, /GitHub issue/i);
  });

  test('an authenticated gate keeps the command and notifies nothing', async () => {
    const { commands, hooks } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const notes = [];
    await fireSessionStart(hooks, gateCtx(makeRepo({ tag: 'gate-ok' }), notes));
    assert.ok(commands.has('issues'));
    assert.deepEqual(notes, []);
  });

  test('a missing gh notifies the fix once at startup and again on invocation, opening nothing', async () => {
    const { commands, hooks, mod } = await loadExtension();
    // T11 (S13): the CLI's PRESENCE is pinned here, because this test is about the
    // other failure — a `gh` that is installed and whose own child cannot be
    // spawned (an ENOENT from the runner). The local presence check would
    // otherwise answer first on a machine that has no `gh` at all, which is a
    // different state with its own line.
    ghIssues.setGhWhich(() => '/usr/local/bin/gh');
    ghIssues.setGhRunner(async (bin) => ({
      status: null, stdout: '', stderr: '', error: `spawn ${bin} ENOENT: gh CLI is not available`,
    }));
    const root = makeRepo({ tag: 'gate-missing' });
    const notes = [];
    await fireSessionStart(hooks, gateCtx(root, notes));
    await fireSessionStart(hooks, gateCtx(root, notes));
    // S5 (T8): the gate is decided in the background now, so the session start
    // returns before the verdict lands. The notice still arrives, and still once.
    assert.ok(await waitFor(() => notes.length === 1), 'the startup notification never arrived');
    assert.ok(commands.has('issues'), 'the command stays discoverable');
    assert.equal(notes.length, 1, 'exactly one startup notification per session');
    assert.match(notes[0][0], /gh CLI is not available/, 'the note names what is missing');
    assert.match(notes[0][0], /gh auth login/, 'the note names the command that fixes it');
    assert.ok(!/unregistered/.test(notes[0][0]), 'the command is registered eagerly');
    assert.match(notes[0][0], /cannot open/, 'the note names the real consequence');

    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes: invokeNotes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'invocation without gh opens nothing');
    assert.equal(invokeNotes.length, 1, 'invocation reports the honest dependency error');
    assert.match(invokeNotes[0][0], /gh auth login/);
    assert.equal(invokeNotes[0][1], 'error');
  });

  test('an unauthenticated gh notifies the login fix on invocation and opens nothing', async () => {
    const { commands, mod } = await loadExtension();
    ghIssues.setGhRunner(async () => ({
      status: 1, stdout: '', stderr: 'Failed to log in: authentication required', error: null,
    }));
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: makeRepo({ tag: 'gate-auth' }), customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay while unauthenticated');
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /gh auth login/, 'the note names the login fix');
  });
});

// ---------------------------------------------------------------------------
// S13 (T11, corrected): without the `gh` CLI the two issues surfaces are NOT
// REGISTERED — `/issues` never loads and the `GITHUB` rail section is never added
// to the rail — so there is no line, notice or refusal for them: nothing appears,
// because nothing was registered. The decision is a LOCAL presence answer (a PATH
// walk, no child process, no `gh` invocation to find out whether `gh` exists), and
// every other surface this package contributes keeps working. A `gh` that is
// present but unauthenticated is NOT this state and keeps the login fix it always
// had.
// ---------------------------------------------------------------------------
describe('a missing gh CLI registers no issues surface (S13, T11)', () => {
  test('without the CLI neither the command nor the rail section exists', async () => {
    const { commands } = await loadExtension({ gh: false });

    assert.equal(commands.has('issues'), false, '/issues never loads without the CLI');
    // Everything else is still there: a missing `gh` is not a plugin-wide switch.
    assert.ok(commands.has('warp'), '/warp still registers');
    assert.ok(commands.has('odd'), '/odd still registers');
    assert.ok(commands.has('files'), '/files still registers');
  });

  test('the decision costs no child process, at load or at session start', async () => {
    const { hooks, mod } = await loadExtension({ gh: false });
    const { runner, calls } = makeIssuesRunner();
    ghIssues.setGhRunner(runner);

    const root = makeRepo({ tag: 'cli-missing-gate' });
    const notes = [];
    await fireSessionStart(hooks, gateCtx(root, notes));

    assert.deepEqual(calls, [], 'a missing CLI is answered locally: no gh child is ever spawned');
    assert.deepEqual(notes, [], 'and nothing is said: there is no surface to say it on');
    assert.equal(typeof mod, 'object');
  });

  test('with the CLI present the command is registered (PRESERVE)', async () => {
    const { commands } = await loadExtension();
    assert.ok(commands.has('issues'), '/issues loads when the CLI is on PATH');
    assert.equal(typeof commands.get('issues').handler, 'function');
  });

  test('an unauthenticated gh that IS present keeps the login fix (PRESERVE)', async () => {
    const { commands, mod } = await loadExtension();
    ghIssues.setGhWhich(() => '/usr/local/bin/gh');
    ghIssues.setGhRunner(async () => ({
      status: 1, stdout: '', stderr: 'Failed to log in: authentication required', error: null,
    }));
    mod.setIssuesTuiLoader(async () => stubTui);

    const { ctx, customs, notes } = makeCtx({
      cwd: makeRepo({ tag: 'cli-present-unauth' }),
      customImpl: async () => null,
    });
    await commands.get('issues').handler('', ctx);

    assert.equal(customs.length, 0, 'no overlay while unauthenticated');
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /gh auth login/, 'the presence check never intercepts an authentication failure');
    assert.equal(notes[0][1], 'error');
    assert.equal(/not installed/.test(notes[0][0]), false, 'a present gh is never reported as missing');
  });
});

// S1/S2 (T1, T2 of the startup theory): `session_start` must resolve without
// waiting on any child process or network call. The `gh` gate used to be AWAITED
// there — `gh api user` (≈485 ms) then `gh repo view` (≈550 ms), serially, on
// every session start AND every session switch — and `/issues` probes `gh` on
// demand anyway, so nothing is lost by dispatching it as startup work instead.
// Outside a repository there is nothing to check at all, so the gate resolves the
// checkout first and spawns nothing (T2/S3).
describe('session startup takes no gh call (S1, S2)', () => {
  test('the awaited session_start resolves while the injected gh runner is still pending', async () => {
    const { hooks } = await loadExtension();
    const calls = [];
    let release = null;
    ghIssues.setGhRunner((bin, argv) => {
      calls.push({ bin, argv: argv.slice() });
      return new Promise((resolve) => {
        release = () => resolve({ status: 0, stdout: '{"login":"me"}', stderr: '', error: null });
      });
    });
    const root = makeRepo({ tag: 'startup-nonblocking' });
    // The handlers are fired HERE, not through `fireSessionStart`: that helper
    // waits for the dispatched startup work, and this is precisely the work the
    // awaited path must not wait for.
    const fired = sessionStartHandlers(hooks).map((handler) => Promise.resolve(handler({}, gateCtx(root, []))));
    const settled = await Promise.race([
      Promise.all(fired).then(() => 'resolved'),
      new Promise((resolve) => { setTimeout(() => resolve('blocked'), 500); }),
    ]);
    assert.equal(settled, 'resolved',
      'the awaited session_start path never waits on a child process or a network call');

    // Dispatched, not dropped: the probe is still startup work, so the session's
    // own gate answer still arrives in the background.
    assert.equal(await waitFor(() => calls.length > 0), true,
      'the gh gate still probes, off the awaited path');
    if (typeof release === 'function') release();
  });

  test('a session outside a repository makes no gh call at startup, and stays silent', async () => {
    const { hooks } = await loadExtension();
    const { runner, calls } = makeIssuesRunner();
    ghIssues.setGhRunner(runner);
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-startup-plain-'))));
    const notes = [];
    await fireSessionStart(hooks, gateCtx(outside, notes));
    assert.deepEqual(calls, [], 'outside a repository there is nothing to check, so no gh child runs');
    assert.deepEqual(notes, [], 'and nothing is said: a non-repository cwd is not an error');
  });
});

// S5 (T8): the gate is network work (`gh api user` then `gh repo view`, plus the
// checkout's own git probes) and the host awaits every `session_start` handler it
// is handed, so awaiting it there put the first prompt behind the whole probe on
// every open, resume and switch. What the gate DECIDES is unchanged; only WHEN it
// runs. These cases drive the registered handlers only.
describe('S5 (T8): the issues gate never delays session_start', () => {
  const ghOk = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
  const USER_OK = ghOk(JSON.stringify({ login: 'me' }));
  const USER_FAIL = { status: 1, stdout: '', stderr: 'Failed to log in: authentication required', error: null };

  // A fake `gh` that answers the gate's two commands, records the checkout of
  // every `gh api user` it was asked for, and lets the test decide when that one
  // call answers.
  function gateRunner({ user = () => Promise.resolve(USER_OK) } = {}) {
    const gateCalls = [];
    const runner = (_bin, argv, opts = {}) => {
      if (argv[0] === 'api' && argv[1] === 'user') {
        gateCalls.push(opts.cwd);
        return user(opts.cwd);
      }
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return Promise.resolve(ghOk(JSON.stringify({ nameWithOwner: 'myfork/project' })));
      }
      return Promise.resolve(ghOk(''));
    };
    return { runner, gateCalls };
  }

  // The gate resolves the CHECKOUT before it asks gh anything (S3/T2), so a
  // session's cwd has to be a real checkout for a probe to run at all: a bare
  // temporary directory is the non-repository state, which by design spawns
  // nothing. What these cases measure — dispatch, the TTL, the shared probe, the
  // generation — is unchanged; only the preconditions of the directory moved.
  function scratchCheckout(tag) {
    return makeRepo({ tag: `gate-${tag}` });
  }

  function sessionShutdownHandlers(hooks) {
    return hooks.filter(([event]) => event === 'session_shutdown').map(([, handler]) => handler);
  }

  async function fireSessionShutdown(hooks, ctx) {
    for (const handler of sessionShutdownHandlers(hooks)) {
      const out = handler({}, ctx);
      if (out && typeof out.then === 'function') await out;
    }
  }

  // Fire the host's session_start handlers and give them a bounded window to
  // resolve, so a handler that waits for `gh` fails an assertion below instead of
  // hanging the suite.
  async function fireSessionStartPromptly(hooks, ctx) {
    const pending = sessionStartHandlers(hooks).map((handler) => Promise.resolve(handler({}, ctx)));
    const outcome = await Promise.race([
      Promise.all(pending).then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    return { outcome, pending };
  }

  // A window in which a NEW probe would have reached the injected `gh` (the client
  // reads the checkout's local git configuration first). Nothing arriving inside it
  // is the evidence that a cached answer was reused.
  const settleWindow = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

  test('session_start returns while the gate is still pending, and the probe still runs', async () => {
    const { hooks } = await loadExtension();
    const held = [];
    ghIssues.setGhRunner(gateRunner({ user: () => new Promise((resolve) => { held.push(resolve); }) }).runner);
    const notes = [];
    const { outcome } = await fireSessionStartPromptly(hooks, gateCtx(scratchCheckout('pending'), notes));
    assert.equal(outcome, 'returned', 'session_start never waits for the network gate');
    assert.ok(await waitFor(() => held.length === 1), 'the probe never ran in the background');
    assert.deepEqual(notes, [], 'and decides nothing before it answers');
    held[0](USER_OK);
    await tick();
    assert.deepEqual(notes, [], 'a usable gh still says nothing, exactly as before');
  });

  test('a verdict that lands late still notifies the same sentence and still refuses /issues', async () => {
    const { hooks, commands, mod } = await loadExtension();
    const held = [];
    ghIssues.setGhRunner(gateRunner({ user: () => new Promise((resolve) => { held.push(resolve); }) }).runner);
    const root = scratchCheckout('deferred');
    const notes = [];
    const { outcome } = await fireSessionStartPromptly(hooks, gateCtx(root, notes));
    assert.equal(outcome, 'returned', 'the session start does not wait for the verdict');
    assert.deepEqual(notes, [], 'the startup note waits for the verdict');
    assert.ok(await waitFor(() => held.length === 1), 'the probe never ran in the background');

    held[0]({ status: null, stdout: '', stderr: '', error: 'spawn gh ENOENT: gh CLI is not available' });
    assert.ok(await waitFor(() => notes.length === 1), 'the deferred verdict never notified');
    assert.match(notes[0][0], /gh CLI is not available/, 'the note names what is missing');
    assert.match(notes[0][0], /gh auth login/, 'the note names the command that fixes it');
    assert.match(notes[0][0], /cannot open/, 'the note names the real consequence');
    assert.equal(notes[0][1], 'info');

    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes: invokeNotes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'invocation without gh opens nothing');
    assert.equal(invokeNotes.length, 1, 'invocation reports its own, fuller error');
    assert.match(invokeNotes[0][0], /gh auth login/);
    assert.equal(invokeNotes[0][1], 'error');
  });

  test('concurrent probes share one call and a settled answer is reused inside the TTL', async () => {
    const { hooks } = await loadExtension();
    const held = [];
    const gate = gateRunner({ user: () => new Promise((resolve) => { held.push(resolve); }) });
    ghIssues.setGhRunner(gate.runner);
    const root = scratchCheckout('share');
    const other = scratchCheckout('share-other');

    // Two session starts for ONE checkout while the first probe is in flight.
    await fireSessionStartPromptly(hooks, gateCtx(root, []));
    await fireSessionStartPromptly(hooks, gateCtx(root, []));
    assert.ok(await waitFor(() => gate.gateCalls.length === 1), 'the gate never probed');
    assert.equal(gate.gateCalls.length, 1, 'concurrent probes for one checkout share one gh call');
    held[0](USER_OK);
    await tick();

    // A settled success is reused for the rest of its TTL.
    await fireSessionStartPromptly(hooks, gateCtx(root, []));
    await settleWindow();
    assert.equal(gate.gateCalls.length, 1, 'a later session reuses the answer it already paid for');

    // Another checkout pays for its own.
    await fireSessionStartPromptly(hooks, gateCtx(other, []));
    assert.ok(await waitFor(() => gate.gateCalls.length === 2), 'a different checkout never probed');
    assert.deepEqual(gate.gateCalls, [root, other], 'and the cache is keyed by the checkout');
    held[1](USER_OK);
    await tick();
  });

  test('a success is reused for minutes, a failure only for seconds', async () => {
    const { hooks } = await loadExtension();
    const clock = { at: 1_000_000 };
    ghIssues.setGateClock(() => clock.at);

    const okRoot = scratchCheckout('ttl-ok');
    const okGate = gateRunner();
    ghIssues.setGhRunner(okGate.runner);
    await fireSessionStart(hooks, gateCtx(okRoot, []));
    await waitFor(() => okGate.gateCalls.length === 1);
    clock.at += 60_000;
    await fireSessionStart(hooks, gateCtx(okRoot, []));
    await settleWindow();
    assert.equal(okGate.gateCalls.length, 1, 'a success inside its TTL is reused, not re-probed');
    clock.at += 5 * 60_000;
    await fireSessionStart(hooks, gateCtx(okRoot, []));
    await waitFor(() => okGate.gateCalls.length === 2);
    assert.equal(okGate.gateCalls.length, 2, 'past the success TTL the gate probes again');

    const failRoot = scratchCheckout('ttl-fail');
    const failGate = gateRunner({ user: () => Promise.resolve(USER_FAIL) });
    ghIssues.setGhRunner(failGate.runner);
    await fireSessionStart(hooks, gateCtx(failRoot, []));
    await waitFor(() => failGate.gateCalls.length === 1);
    clock.at += 10_000;
    await fireSessionStart(hooks, gateCtx(failRoot, []));
    await settleWindow();
    assert.equal(failGate.gateCalls.length, 1, 'a failure inside its short TTL is reused');
    clock.at += 30_000;
    await fireSessionStart(hooks, gateCtx(failRoot, []));
    await waitFor(() => failGate.gateCalls.length === 2);
    assert.equal(failGate.gateCalls.length, 2, 'past the short TTL the failure is probed again');
  });

  test('a verdict from a superseded checkout never applies to the session that replaced it', async () => {
    const { hooks } = await loadExtension();
    const held = new Map();
    ghIssues.setGhRunner(gateRunner({
      user: (cwd) => new Promise((resolve) => { held.set(cwd, resolve); }),
    }).runner);
    const checkoutA = scratchCheckout('supersede-a');
    const checkoutB = scratchCheckout('supersede-b');
    const notesA = [];
    const notesB = [];

    await fireSessionStartPromptly(hooks, gateCtx(checkoutA, notesA));
    await waitFor(() => held.has(checkoutA));
    await fireSessionStartPromptly(hooks, gateCtx(checkoutB, notesB));
    await waitFor(() => held.has(checkoutB));

    // The previous checkout's verdict lands now, after its session was superseded.
    held.get(checkoutA)(USER_FAIL);
    await tick();
    await tick();
    assert.deepEqual(notesA, [], 'a superseded verdict never notifies the session it belonged to');

    held.get(checkoutB)(USER_OK);
    await tick();
    assert.deepEqual(notesB, [], 'the live session keeps its own verdict');
    assert.equal(held.size, 2, 'no extra probe ran');
  });

  test('session_shutdown drops the gate cache, so the next session probes afresh', async () => {
    const { hooks } = await loadExtension();
    const clock = { at: 2_000_000 };
    ghIssues.setGateClock(() => clock.at);
    const gate = gateRunner();
    ghIssues.setGhRunner(gate.runner);
    const root = scratchCheckout('shutdown');
    const ctx = gateCtx(root, []);

    await fireSessionStart(hooks, ctx);
    await waitFor(() => gate.gateCalls.length === 1);
    clock.at += 1_000;
    await fireSessionStart(hooks, ctx);
    await settleWindow();
    assert.equal(gate.gateCalls.length, 1, 'inside the TTL the same checkout is reused');

    await fireSessionShutdown(hooks, ctx);
    await fireSessionStart(hooks, ctx);
    await waitFor(() => gate.gateCalls.length === 2);
    assert.equal(gate.gateCalls.length, 2, 'a new session never inherits the probe its predecessor paid for');
  });

  test('the cache holds a handful of checkouts, never every one ever seen', async () => {
    const { hooks } = await loadExtension();
    const gate = gateRunner();
    ghIssues.setGhRunner(gate.runner);
    const scopes = Array.from({ length: 10 }, (_, index) => scratchCheckout(`bound-${index}`));
    for (const scope of scopes) await fireSessionStart(hooks, gateCtx(scope, []));
    await waitFor(() => gate.gateCalls.length === scopes.length);
    assert.equal(gate.gateCalls.length, scopes.length, 'every checkout probed once');

    await fireSessionStart(hooks, gateCtx(scopes.at(-1), []));
    await settleWindow();
    assert.equal(gate.gateCalls.length, scopes.length, 'the newest checkout is still cached');

    await fireSessionStart(hooks, gateCtx(scopes[0], []));
    await waitFor(() => gate.gateCalls.length === scopes.length + 1);
    assert.equal(gate.gateCalls.length, scopes.length + 1,
      'the oldest checkout was evicted instead of the cache growing without bound');
  });
});

describe('/issues overlay and arguments', () => {
  test('opens full screen fed by the three scoped searches, and leaves All until it is asked for', async () => {
    const root = makeRepo({ tag: 'issues-open' });
    const { runner, calls } = makeIssuesRunner();
    const { component, customs, notes } = await openIssues(root, { runner });
    assert.equal(customs.length, 1, 'the overlay opens once');
    assert.deepEqual(customs[0][1], {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 },
    });
    assert.deepEqual(notes, [], 'opening writes no notification');
    const listSearches = calls
      .filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list')
      .map((call) => call.argv[call.argv.indexOf('--search') + 1]);
    assert.deepEqual(listSearches, [], 'the viewer reads fresh pages, never a list cache');
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'every scoped tab is read once with its own exact query');
    assert.equal(connectionReads(calls).length, 0,
      'opening the panel reads no connection page: All is read when it is entered (S2)');
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues/);
    assert.match(body, /Assigned/);
    assert.match(body, /Involved/);
    assert.doesNotMatch(clean(component.render(110)[2]), /\bAll\b/, 'All is no longer a tab (S1)');
    assert.match(body, /76/, 'the listed issue number');
    assert.match(body, /chore: update/, 'the listed issue title');
    assert.match(body, /◈ Issues/, 'the header names the surface');
    assert.ok(!body.includes(path.basename(root)), 'the header never repeats the checkout name');
  });

  test('All is read the first time the shortcut enters it, and re-entering reuses it (S1/S2)', async () => {
    const root = makeRepo({ tag: 'issues-all-lazy' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    assert.equal(connectionReads(calls).length, 0, 'the mount reads no connection page');
    assert.equal(searchQueries(calls).length, 3, 'and exactly the three scoped searches');
    component.handleInput('g');
    await tick();
    const reads = connectionReads(calls);
    assert.equal(reads.length, 1, 'entering All issues one connection read');
    const bar = clean(component.render(110)[2]);
    assert.match(bar, /▸ All \(\d+\)/, `the bar reads only the All view: ${bar}`);
    for (const label of ['My issues', 'Assigned', 'Involved']) {
      assert.ok(!bar.includes(label), `the scoped tabs leave the bar in the All view: ${bar}`);
    }
    // The full legend only fits a wide frame; the label is what is under test.
    assert.match(clean(component.render(200).at(-2)), /g related issues/,
      'inside All the hint says the key goes back (D1)');
    component.handleInput('g');
    await tick();
    assert.match(clean(component.render(200).at(-2)), /g all issues/,
      'outside All the hint names what the key opens (D1)');
    assert.equal(connectionReads(calls).length, 1, 'leaving All reads nothing');
    component.handleInput('g');
    await tick();
    assert.equal(connectionReads(calls).length, 1, 're-entering All reuses the page it read (S2)');
  });

  test('a typed filter is read by the three scoped tabs, and the All view searches instead of connecting (S3/S4/S5)', async () => {
    const root = makeRepo({ tag: 'issues-filter' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    const mount = searchQueries(calls).length;
    assert.equal(mount, 3, 'the mount read the three scoped buckets');
    component.handleInput('t');
    for (const ch of 'label:bug') component.handleInput(ch);
    await waitFor(() => searchQueries(calls).length >= mount + 3);
    await tick();
    assert.deepEqual(searchQueries(calls).slice(mount), [
      'author:@me sort:updated-desc label:bug',
      'assignee:@me sort:updated-desc label:bug',
      'involves:@me -author:@me sort:updated-desc label:bug',
    ], 'the settled filter re-reads all three scoped buckets, each with its own scope');
    component.handleInput('enter');
    await tick();
    // Entering All while the filter is on is a SEARCH read: the connection takes
    // no text, and the search count is capped, so the view never claims it exact.
    const before = searchQueries(calls).length;
    component.handleInput('g');
    await waitFor(() => searchQueries(calls).length > before);
    await tick();
    assert.deepEqual(searchQueries(calls).slice(before), ['sort:updated-desc label:bug'],
      'a filtered All goes through the search path, with the filter');
    assert.equal(connectionReads(calls).length, 0, 'and never reads the unfiltered connection');
    await waitFor(() => /▸ All \(\d+\+\)/.test(clean(component.render(110)[2])));
    assert.match(clean(component.render(110)[2]), /▸ All \(\d+\+\)/,
      'a filtered All marks its count inexact instead of claiming an exact total');
    assert.match(clean(component.render(110)[3]), /via search/, 'the frame names the read on screen');
  });

  // S5: the route trims a whitespace-only query into "no filter" and takes the
  // repository CONNECTION, so the note the view paints has to name that same
  // read — the route and the note decide from one fact.
  test('a whitespace-only filter takes the connection read, and the note names it (S5)', async () => {
    const root = makeRepo({ tag: 'issues-blank-filter' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    const mount = searchQueries(calls).length;
    assert.equal(mount, 3, 'the mount read the three scoped buckets');
    component.handleInput('g');
    await waitFor(() => connectionReads(calls).length === 1);
    await tick();
    component.handleInput('t');
    component.handleInput(' ');
    await waitFor(() => connectionReads(calls).length === 2);
    await tick();
    assert.deepEqual(searchQueries(calls).slice(mount), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'the scoped tabs re-read their own searches with no stray text appended');
    assert.equal(connectionReads(calls).length, 2,
      'the All view reads the repository connection again, never a search');
    const note = clean(component.render(110)[3]);
    assert.match(note, /via connection \(exact total\)/, `the note names the read on screen: ${note}`);
    const bar = clean(component.render(110)[2]);
    assert.match(bar, /▸ All \(\d+\)/, `and the exact connection total wears no mark: ${bar}`);
    assert.ok(!/\(\d+\+\)/.test(bar), `no inexact total is claimed for an exact read: ${bar}`);
  });

  test('an argument notifies and opens nothing', async () => {
    const root = makeRepo({ tag: 'issues-args' });
    const { commands, mod, hooks } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(hooks, gateCtx(scratch, []));
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('issues').handler('extra', ctx);
    assert.equal(customs.length, 0, 'no overlay for an argument');
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0], ['Unknown option "extra". Use /issues.', 'error']);
  });

  test('outside a Git checkout notifies the shared line at info and spawns no gh', async () => {
    const { commands, mod, hooks } = await loadExtension();
    const { runner, calls } = makeIssuesRunner();
    ghIssues.setGhRunner(runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(hooks, gateCtx(scratch, []));
    mod.setIssuesTuiLoader(async () => stubTui);
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-plain-'))));
    const { ctx, customs, selects, notes } = makeCtx({ cwd: outside, customImpl: async () => null });
    await commands.get('issues').handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay outside a checkout');
    assert.equal(selects.length, 0, 'no fallback selector outside a checkout');
    assert.deepEqual(notes, [[`not a git repository: ${outside}; run 'git init' first`, 'info']]);
    assert.deepEqual(calls, [],
      'the refusal is the checkout’s own answer: it never asks gh, which could only report its own error');
  });
});

describe('/issues is read-only about the worktree association', () => {
  // S3/S4: the association's document is gone. The property this case proves is the
  // one that survives it — /issues is handed no association option and every read and
  // keypress writes nothing at all.
  test('the mounted view is handed no association option and reading writes nothing', async () => {
    const root = makeRepo({ tag: 'issues-readonly' });
    const file = registryFile(root);
    assert.equal(fs.existsSync(file), false, 'the fixture starts with no worktree document');
    const { runner } = makeIssuesRunner();
    const capture = captureIssuesView();
    try {
      await openIssues(root, { runner, prepare: (mod) => capture.attach(mod) });
      const options = capture.holder.options;
      for (const key of ['assigned', 'assignedOdd', 'saveAssignment', 'assignmentEnabled']) {
        assert.equal(key in options, false, `the view is handed no ${key}: ${JSON.stringify(Object.keys(options))}`);
      }
    } finally {
      capture.restore();
    }
    assert.equal(fs.existsSync(file), false, 'reading writes no worktree document');

    const { component } = await openIssues(root, { runner });
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(fs.existsSync(file), false, 'the removed association keys write nothing');
  });
});

describe('/issues actions (S3,S4)', () => {
  test('label toggle, create-new, comment, browser and close reach gh with fixed argv', async () => {
    const root = makeRepo({ tag: 'issues-actions' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    const ghCalls = () => calls.filter((call) => call.bin === 'gh');

    component.handleInput('L');
    assert.equal(component.state.mode, 'labels');
    await tick();
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'a successful label apply closes the editor');
    const edit = ghCalls().find((call) => call.argv[1] === 'edit');
    assert.ok(edit, 'the label toggle reaches gh issue edit');
    assert.equal(edit.cwd, root, 'the write runs in this checkout');
    assert.deepEqual(edit.argv.slice(0, 3), ['issue', 'edit', '76']);
    assert.ok(edit.argv.includes('--add-label'), 'additions ride --add-label');
    assert.ok(edit.argv.includes('bug'), 'the toggled label is applied');
    assert.ok(!edit.argv.join(' ').includes('&&'), 'fixed argv: no shell string');

    component.handleInput('L');
    component.handleInput('n');
    for (const ch of 'triage') component.handleInput(ch);
    component.handleInput('enter');
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => ghCalls().some((call) => call.argv[1] === 'create')), 'a new label reaches gh label create');
    const create = ghCalls().find((call) => call.argv[1] === 'create');
    assert.deepEqual(create.argv.slice(0, 3), ['label', 'create', 'triage']);
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'creating a label applies and closes the editor');

    component.handleInput('c');
    assert.equal(component.state.mode, 'comment');
    for (const ch of 'hi') component.handleInput(ch);
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'a posted comment closes the input');
    const comment = ghCalls().find((call) => call.argv[1] === 'comment');
    assert.deepEqual(comment.argv, ['issue', 'comment', '76', '--body', 'hi']);

    component.handleInput('x');
    assert.equal(component.state.mode, 'confirm');
    assert.match(clean(component.render(110).join('\n')), /Confirm close #76/);
    component.handleInput('enter');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'the close settles');
    assert.ok(!clean(component.render(110).join('\n')).includes('#76'), 'the closed issue leaves the open list at once');
    const close = ghCalls().find((call) => call.argv[1] === 'close');
    assert.deepEqual(close.argv, ['issue', 'close', '76']);
    assert.equal(ghCalls().some((call) => call.argv[1] === 'reopen'), false, 'the view has no reopen path');
  });

  test('the mounted view refuses close, labels and assign on READ, and offers no label creation on TRIAGE', async () => {
    const mutations = (calls) => calls.filter((call) => call.argv[0] === 'issue'
      && ['edit', 'close', 'reopen'].includes(call.argv[1]))
      .concat(calls.filter((call) => call.argv[0] === 'label' && call.argv[1] === 'create'));

    const readRoot = makeRepo({ tag: 'issues-role-read' });
    const read = makeIssuesRunner({ role: 'READ' });
    const { component: readOnly } = await openIssues(readRoot, { runner: read.runner });
    const readFrame = () => clean(readOnly.render(200).join('\n'));
    assert.ok(await waitFor(() => readFrame().includes('c comment')), 'the reader is painted');
    assert.ok(!readFrame().includes('L labels'), 'a read-only viewer is offered no label editor');
    assert.ok(!readFrame().includes('a assign'), 'no assignee editor either');
    assert.ok(!readFrame().includes('x/X close'), 'and no close key');

    for (const key of ['x', 'X', 'L', 'a']) readOnly.handleInput(key);
    await tick();
    assert.equal(readOnly.state.mode, 'list', 'no editor opens without the capability');
    assert.equal(readOnly.state.confirm, null, 'no close confirmation is staged');
    assert.match(readFrame(), /permission/, 'the refusal names the missing permission');
    assert.deepEqual(mutations(read.calls), [], 'no mutation was even attempted');

    const triageRoot = makeRepo({ tag: 'issues-role-triage' });
    const triage = makeIssuesRunner({ role: 'TRIAGE' });
    const { component: triaged } = await openIssues(triageRoot, { runner: triage.runner });
    const triageFrame = () => clean(triaged.render(200).join('\n'));
    assert.ok(await waitFor(() => triageFrame().includes('l labels')), 'triage may open the label editor');

    triaged.handleInput('L');
    assert.equal(triaged.state.mode, 'labels', 'the triage viewer reaches the editor');
    await tick();
    assert.ok(!triageFrame().includes('create new'), 'no create row without the WRITE right');
    assert.ok(!triageFrame().includes('n new'), 'and no create keybinding either');
    triaged.handleInput('n');
    assert.equal(triaged.state.labelCreating, false, 'n starts no creation');
    triaged.handleInput('escape');
    assert.equal(triaged.state.mode, 'list');

    triaged.handleInput('x');
    assert.equal(triaged.state.mode, 'confirm', 'triage may close');
    triaged.handleInput('enter');
    assert.ok(await waitFor(() => triage.calls.some((call) => call.argv[1] === 'close')), 'the close reached gh');
    assert.deepEqual(triage.calls.filter((call) => call.argv[1] === 'close').map((call) => call.argv),
      [['issue', 'close', '76']], 'one fixed-argv close, and no label creation');
  });

  test('the browser opener runs fixed argv and suspends the terminal for the open', async () => {
    const root = makeRepo({ tag: 'issues-open-browser' });
    const { runner } = makeIssuesRunner();
    const run = await capturedIssuesOptions(root, { runner });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv, opts) => {
      gitCalls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener reports success');
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
    assert.equal(gitCalls.length, 1, 'the browser opener runs once');
    assert.deepEqual(gitCalls[0].argv,
      ['issue', 'view', '76', '--web', '-R', 'github.com/jonasotoaguilar/herdr-gentle-shell']);
    assert.equal(gitCalls[0].cwd, root, 'the opener runs in this checkout');
    assert.ok(!gitCalls[0].argv.join(' ').includes('xdg-open'), 'never an invented opener');
    assert.deepEqual(run.host.lifecycle, ['stop', 'start', 'render'],
      'the TUI is suspended for the browser open and taken back afterwards');
    assert.deepEqual(run.host.stops, [{ preserveScreen: true }],
      'the suspend preserves the screen: a bare stop stamps the whole alt-screen frame into scrollback');
    assert.deepEqual(run.host.paints, [true], 'the terminal is forced to repaint on resume');
  });

  test('r re-reads the current page fresh, and the removed state toggle reads nothing', async () => {
    const root = makeRepo({ tag: 'issues-reload' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    const primed = searchQueries(calls);
    assert.equal(primed.length, 3, 'the mount read every scoped bucket once');
    const connections = connectionReads(calls).length;
    assert.equal(connections, 0, 'and no page of the All connection (S2)');

    const before = clean(component.render(110).join('\n'));
    component.handleInput('f');
    await tick();
    assert.deepEqual(searchQueries(calls), primed, 'f fetches nothing: no other state is asked for');
    assert.equal(clean(component.render(110).join('\n')), before, 'f repaints nothing');

    component.handleInput('r');
    await tick();
    assert.deepEqual(searchQueries(calls).slice(primed.length), ['author:@me sort:updated-desc'],
      'a reload re-reads the current page fresh');
    assert.equal(connectionReads(calls).length, connections, 'the reload left the All connection page alone');
    assert.equal(calls.some((call) => call.argv.includes('--state')), false,
      'the list API is never asked for any state');
  });

  test('a failing comment keeps the draft, shows the error and changes nothing', async () => {
    const root = makeRepo({ tag: 'issues-fail' });
    const { runner, calls } = makeIssuesRunner({ failComment: true });
    const { component } = await openIssues(root, { runner });
    component.handleInput('c');
    for (const ch of 'hey') component.handleInput(ch);
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => calls.some((call) => call.argv[1] === 'comment')), 'the comment reached gh');
    await tick();
    assert.equal(component.state.mode, 'comment', 'the failure keeps the input open');
    assert.equal(component.state.commentText, 'hey', 'the draft survives the failure');
    assert.match(clean(component.render(110).join('\n')), /rate limited/, 'the error surfaces honestly');
    assert.equal(calls.filter((call) => call.argv[1] === 'comment').length, 1, 'one attempt, no retry');
  });
});

describe('/issues page seam (S5,D1)', () => {
  async function mountCapturing(root, rows = 24) {
    const base = makeIssuesRunner();
    // The extension's OWN view and client, taken after the load: one load compiles
    // its own lib modules, so the fakes go on the instance the command mounts.
    let lib;
    let realCreate;
    let realPage;
    const order = [];
    const pages = [];
    const holder = { options: null };
    const restore = () => {
      if (!lib) return;
      lib.createIssuesView = realCreate;
      ghIssues.getIssuePage = realPage;
    };
    let mounted = null;
    let loaded = null;
    try {
      loaded = await loadExtension();
      lib = loaded.mod.libModule('issues-view.js');
      realCreate = lib.createIssuesView;
      realPage = ghIssues.getIssuePage;
      ghIssues.getIssuePage = (params, opts) => {
        order.push('page');
        pages.push({ params, opts });
        return realPage(params, opts);
      };
      lib.createIssuesView = (options) => {
        holder.options = options;
        order.push('view');
        return realCreate(options);
      };
      ghIssues.setGhRunner(base.runner);
      const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
      await fireSessionStart(loaded.hooks, gateCtx(scratch, []));
      loaded.mod.setIssuesTuiLoader(async () => stubTui);
      const { ctx } = makeCtx({ cwd: root });
      ctx.ui.custom = async (factory) => {
        order.push('custom');
        mounted = openComponent(factory, makeHostTui(rows));
        return null;
      };
      await loaded.commands.get('issues').handler('', ctx);
      await tick();
    } catch (err) {
      restore();
      throw err;
    }
    return { order, pages, holder, base, mounted, restore };
  }

  test('the overlay mounts before any page read, with bucket metadata only', async () => {
    const root = makeRepo({ tag: 'issues-order' });
    const run = await mountCapturing(root);
    try {
      assert.equal(run.order[0], 'custom', 'the overlay opens before anything is read');
      assert.deepEqual(run.order.slice(0, 3), ['custom', 'view', 'page'],
        'the view mounts first, and its own mount asks for the first page');
      const options = run.holder.options;
      assert.deepEqual(options.pages.map((page) => [page.id, page.label, page.issues]), [
        ['mine', 'My issues', null],
        ['assigned', 'Assigned', null],
        ['involved', 'Involved', null],
        ['all', 'All', null],
      ], 'bucket metadata only: no accumulated rows are handed to the view');
      assert.deepEqual(options.pages.filter((page) => page.lazy === true).map((page) => page.id), ['all'],
        'the All bucket is marked lazy so the mount-time prefetch skips it (S2)');
      assert.equal(options.loadPages, undefined, 'no eager/lazy-list loader is passed beside the fresh seam');
      assert.equal(typeof options.loadIssuePage, 'function');
      const first = run.pages[0];
      assert.deepEqual(first.params, { query: 'author:@me sort:updated-desc', after: null, first: first.params.first });
      assert.ok(Number.isInteger(first.params.first) && first.params.first >= 1, 'the limit is a row budget');
      assert.equal(first.opts.cwd, root);
    } finally {
      run.restore();
    }
  });

  test('the loader passes the exact bucket query, cursor, dynamic limit and pinned scope', async () => {
    const root = makeRepo({ tag: 'issues-seam' });
    const narrow = await mountCapturing(root, 24);
    let narrowLimit = null;
    try {
      narrowLimit = narrow.pages[0].params.first;
      const asked = await narrow.holder.options.loadIssuePage({ bucketId: 'assigned', cursor: 'row-3', limit: 7 });
      assert.equal(asked.ok, true, 'the real client answered the page');
      const call = narrow.pages[narrow.pages.length - 1];
      assert.deepEqual(call.params, { query: 'assignee:@me sort:updated-desc', after: 'row-3', first: 7 },
        'the bucket query, the caller cursor and the caller limit pass straight through');
      assert.deepEqual(call.opts, { cwd: root, scope: 'github.com/jonasotoaguilar/herdr-gentle-shell' },
        'the page read is scoped to this checkout and bound to the pinned identity');

      const before = narrow.pages.length;
      await narrow.holder.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5 });
      await narrow.holder.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5 });
      assert.deepEqual(narrow.pages.slice(before).map((entry) => entry.params), [
        { query: 'involves:@me -author:@me sort:updated-desc', after: null, first: 5 },
        { query: 'involves:@me -author:@me sort:updated-desc', after: null, first: 5 },
      ], 'identical requests read again instead of answering from a cache');

      const subprocesses = narrow.base.calls.length;
      assert.deepEqual(narrow.holder.options.loadIssuePage({ bucketId: 'bogus', cursor: null, limit: 5 }),
        { ok: false, error: 'unknown issues bucket "bogus"' }, 'an unknown bucket fails explicitly');
      assert.equal(narrow.base.calls.length, subprocesses, 'an unknown bucket never runs gh');
    } finally {
      narrow.restore();
    }

    const wide = await mountCapturing(root, 60);
    try {
      const wideLimit = wide.pages[0].params.first;
      assert.ok(wideLimit > narrowLimit,
        `the limit follows the viewport row budget: ${narrowLimit} at 24 rows, ${wideLimit} at 60`);
    } finally {
      wide.restore();
    }
  });

  test('the All bucket reads the open connection, and a typed query stays on the search API', async () => {
    const root = makeRepo({ tag: 'issues-all' });
    const run = await capturedIssuesOptions(root);
    try {
      const before = run.calls.length;
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 5 });
      assert.equal(asked.ok, true, 'the real client answered the All page');
      const reads = connectionReads(run.calls.slice(before));
      assert.equal(reads.length, 1, 'one connection read answered the All bucket');
      assert.deepEqual(searchQueries(run.calls.slice(before)), [], 'the All bucket never used the search API');
      assert.equal(reads[0].cursor, null, 'a head read starts the connection at its first row');
      assert.equal(reads[0].first, '5', 'the caller limit bounds the connection page');
      assert.match(reads[0].query, /issues\(states: \[OPEN\], first: \$first, after: \$cursor/);
      assert.match(reads[0].query, /orderBy: \{field: UPDATED_AT, direction: DESC\}/);
      assert.ok(!reads[0].query.includes('search('), 'never the 1000-match search API');
      assert.ok(!reads[0].argv.some((entry) => entry.startsWith('search=')), 'no search text reaches the connection');
      const rows = JSON.parse(fixture('gh-issue-list.json')).length;
      assert.equal(asked.total, rows, 'the whole open set is the bucket total');
      for (const issue of asked.issues) assert.equal(typeof issue.cursor, 'string', 'every row keeps its own cursor');

      const typedBefore = run.calls.length;
      const typed = await run.options.loadIssuePage({ bucketId: 'all', cursor: 'row-2', limit: 4, query: '  label:bug  ' });
      assert.equal(typed.ok, true, 'the typed All search answered');
      assert.deepEqual(searchQueries(run.calls.slice(typedBefore)), ['sort:updated-desc label:bug'],
        'a typed query keeps the bucket ordering and rides the search API');
      assert.equal(connectionReads(run.calls.slice(typedBefore)).length, 0,
        'a typed query never reaches the connection, which takes no search text');

      const scopedBefore = run.calls.length;
      await run.options.loadIssuePage({ bucketId: 'mine', cursor: 'row-2', limit: 7, query: '  label:bug is:open  ' });
      assert.deepEqual(searchQueries(run.calls.slice(scopedBefore)), ['author:@me sort:updated-desc label:bug is:open'],
        'the bucket scope stays and the typed operators ride along');
      const bareBefore = run.calls.length;
      await run.options.loadIssuePage({ bucketId: 'assigned', cursor: null, limit: 5 });
      assert.deepEqual(searchQueries(run.calls.slice(bareBefore)), ['assignee:@me sort:updated-desc'],
        'no query means no extra search text');
      const blankBefore = run.calls.length;
      await run.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5, query: '   ' });
      assert.deepEqual(searchQueries(run.calls.slice(blankBefore)), ['involves:@me -author:@me sort:updated-desc'],
        'a blank query is absent, never a trailing space');
    } finally {
      run.restore();
    }
  });

  test('more than 1000 open issues page to the end through the All bucket', async () => {
    const root = makeRepo({ tag: 'issues-all-1200' });
    const total = 1200;
    const rows = Array.from({ length: total }, (_, at) => ({
      number: at + 1,
      title: `synthetic issue ${at + 1}`,
      state: 'OPEN',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      url: `https://github.com/o/r/issues/${at + 1}`,
    }));
    const run = await capturedIssuesOptions(root, { connectionRows: rows });
    try {
      const before = run.calls.length;
      const seen = [];
      let cursor = null;
      let pages = 0;
      for (;;) {
        const page = await run.options.loadIssuePage({ bucketId: 'all', cursor, limit: 100 });
        assert.equal(page.ok, true, `page ${pages + 1} loaded: ${page.error || ''}`);
        assert.equal(page.total, total, 'every page reports the exact server total');
        assert.ok(page.issues.length > 0, 'a page never comes back empty mid-walk');
        cursor = page.issues[page.issues.length - 1].cursor;
        seen.push(...page.issues.map((issue) => issue.number));
        pages += 1;
        if (page.hasNextPage !== true) break;
        assert.ok(pages <= 12, 'the walk ends: 1200 rows at 100 per page is 12 pages');
      }
      assert.equal(pages, 12, 'exactly the pages the 1200 rows need');
      assert.deepEqual(seen, rows.map((row) => row.number), 'every open issue arrives once, in order');
      const reads = connectionReads(run.calls.slice(before));
      assert.equal(reads.length, 12, 'every page was a connection read');
      assert.equal(reads[1].cursor, 'conn-99', 'each continuation resumes after the last row shown');
      assert.deepEqual(searchQueries(run.calls.slice(before)), [], 'no page read the capped search');
    } finally {
      run.restore();
    }
  });

  test('the active bucket names the real total, not the rows one page fetched', async () => {
    const root = makeRepo({ tag: 'issues-totals' });
    const rows = Array.from({ length: 45 }, (_, at) => ({
      number: at + 1,
      title: `issue ${at + 1} chore: update`,
      state: 'OPEN',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      url: `https://example.test/issues/${at + 1}`,
    }));
    const { runner } = makeIssuesRunner({ connectionRows: null });
    // The scoped tabs read the search API, so the fixture rows are replaced by
    // a search page carrying the same 45 rows the connection would.
    const wrapped = async (bin, argv, opts) => {
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = graphqlField(argv, 'query', '-f') || '';
        if (query.includes('type: ISSUE')) {
          return { status: 0, stdout: graphqlSearchPage(argv, rows), stderr: '', error: null };
        }
      }
      return runner(bin, argv, opts);
    };
    const { component } = await openIssues(root, { runner: wrapped });
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues \(45/);
    assert.ok(!body.includes('+ issues'), 'the total is never repeated below the list');
  });
});

describe('/issues repository identity (S5)', () => {
  const forkRoots = [];
  after(() => {
    for (const dir of forkRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  function makeForkRepo({ tag = 'issues-fork', remotes = [['origin', 'myfork/project'], ['upstream', 'original/project']] } = {}) {
    const root = makeRepo({ tag });
    forkRoots.push(root);
    for (const [name, repo] of remotes) {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.includes(':') || repo.startsWith('/')
        ? repo
        : `git@github.com:${repo}.git`;
      git(root, ['remote', 'add', name, url]);
    }
    return root;
  }

  function forkRunner({ repoView = 'original/project' } = {}) {
    const base = makeIssuesRunner();
    const runner = async (bin, argv, opts) => {
      const env = (opts && opts.env) || {};
      const repo = typeof env.GH_REPO === 'string' && env.GH_REPO !== '' ? env.GH_REPO : repoView;
      base.calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined, repo });
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: repoView }), stderr: '', error: null };
      }
      const before = base.calls.length;
      const out = await base.runner(bin, argv, opts);
      base.calls.length = before;
      return out;
    };
    return { runner, calls: base.calls };
  }

  function searchScopes(calls) {
    return calls
      .flatMap((call) => call.argv)
      .filter((value) => value.startsWith('search=repo:'))
      .map((value) => value.slice('search=repo:'.length).split(' ')[0]);
  }

  test('every tab, the detail, labels and assignees read the checkout fork', async () => {
    const root = makeForkRepo();
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      const before = gh.calls.length;
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab answered`);
      }
      const reads = gh.calls.slice(before);
      assert.deepEqual(
        searchScopes(reads.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')),
        ['myfork/project', 'myfork/project', 'myfork/project'],
        'each scoped tab searches the fork, never the upstream',
      );
      for (const read of connectionReads(reads)) {
        assert.equal(graphqlField(read.argv, 'owner'), 'myfork', 'the All tab walks the fork issue connection');
        assert.equal(graphqlField(read.argv, 'name'), 'project');
      }
      assert.ok(!reads.some((call) => call.argv.some((value) => value.includes('original/project'))),
        'no tab read carries the upstream repository');

      const scopedBefore = gh.calls.length;
      assert.equal((await run.options.loadIssue(76)).ok, true, 'the detail opened through the real client');
      assert.equal((await run.options.loadLabels()).ok, true);
      assert.equal((await run.options.loadAssignees()).ok, true);
      const scoped = gh.calls.slice(scopedBefore);
      assert.ok(scoped.length >= 3, 'the detail, label and assignee reads ran');
      for (const call of scoped) {
        assert.equal(call.repo, 'github.com/myfork/project',
          `the read is scoped to the fork, host included (${call.argv.join(' ')})`);
      }
    } finally {
      run.restore();
    }
  });

  test('the browser opener opens the fork issue, not the upstream one', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-open' });
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv, opts) => {
      gitCalls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true);
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
    assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web', '-R', 'github.com/myfork/project'],
      'the browser opens the checkout fork issue on the fork server');
  });

  test('a single-remote checkout binds the opener to the repository gh resolves', async () => {
    const root = makeForkRepo({ tag: 'issues-nofork', remotes: [['origin', 'myfork/project']] });
    const gh = forkRunner({ repoView: 'myfork/project' });
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (bin, argv) => {
      gitCalls.push({ bin, argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      assert.equal((await run.options.actions.openBrowser(76)).ok, true);
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
    assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web', '-R', 'github.com/myfork/project'],
      'the opener binds the one repository gh resolved for this checkout');
  });

  test('a non-GitHub checkout remote fails every read and the opener without running gh', async () => {
    const root = makeForkRepo({
      tag: 'issues-fork-local',
      remotes: [['origin', 'file:///srv/mirror/project.git'], ['upstream', 'original/project']],
    });
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (_bin, argv) => {
      gitCalls.push({ argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, false, `the ${bucketId} tab is refused`);
        assert.match(asked.error, /is a local path, not a GitHub repository/);
      }
      const labels = await run.options.loadLabels();
      assert.equal(labels.ok, false, 'the label editor read is refused');
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, false, 'the opener refuses instead of opening another repository');
      assert.match(opened.error, /is a local path, not a GitHub repository/);
      assert.deepEqual(gitCalls, [], 'the browser opener never ran');
      // S1/S3 (T1, T2): the session gate is dispatched startup work now and no
      // longer warms a session-wide `ok` from a scratch cwd, so THIS command's own
      // on-demand health probe (`gh api user`, `gh repo view`) runs here. That probe
      // asks gh whether it is usable; it reads nothing of this repository. No READ
      // and no opener reaches gh from a checkout it cannot name.
      const reads = gh.calls.filter((call) => call.argv[0] === 'issue'
        || call.argv[0] === 'label'
        || (call.argv[0] === 'api' && call.argv[1] === 'graphql'));
      assert.deepEqual(reads, [], 'no repository read left this checkout');
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
  });

  test('after the remote moves, every action refuses and reads keep the displayed repository', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-drift' });
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    const gitCalls = [];
    const original = worktreeGit.runArgvAsync;
    worktreeGit.runArgvAsync = async (_bin, argv) => {
      gitCalls.push({ argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const bound = await run.options.actions.postComment(76, 'bound');
      assert.equal(bound.ok, true, 'a write before the move succeeds');
      const boundCall = gh.calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'comment').pop();
      assert.equal(boundCall.repo, 'github.com/myfork/project', 'and it binds the displayed repository');

      git(root, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);
      const before = gh.calls.length;

      const comment = await run.options.actions.postComment(76, 'hello');
      assert.equal(comment.ok, false, 'the comment is refused');
      assert.match(comment.error, /changed since this issue list loaded/);
      assert.equal((await run.options.actions.editLabels(76, ['bug'], [], [])).ok, false, 'the label edit is refused');
      assert.equal((await run.options.actions.setState(76, 'closed')).ok, false, 'the close is refused');
      assert.equal((await run.options.actions.editAssignees(76, { add: ['bob'], remove: [] })).ok, false,
        'the assignee edit is refused');
      const opened = await run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener still opens the repository the rows came from');
      assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web', '-R', 'github.com/myfork/project'],
        'the browser opens the displayed repository, never the one the checkout resolves to now');

      const mutations = gh.calls.slice(before).filter((call) => call.argv[0] === 'issue'
        && ['edit', 'comment', 'close', 'reopen'].includes(call.argv[1]));
      assert.deepEqual(mutations, [], 'no mutating gh command ran after the drift');
      assert.ok(!gh.calls.slice(before).some((call) => call.argv[0] === 'label' && call.argv[1] === 'create'),
        'no label was created on the new fork');

      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab still reads the loaded repository`);
      }
      const reads = gh.calls.slice(before);
      assert.ok(reads.some((call) => call.argv.some((value) => value.includes('repo:myfork/project'))),
        'the reads carry the displayed repository');
      assert.ok(!reads.some((call) => call.repo === 'github.com/otherfork/project'), 'nothing reached the new fork');
    } finally {
      worktreeGit.runArgvAsync = original;
      run.restore();
    }
  });

  test('an ambient GH_REPO cannot override the pinned identity', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-env-repo' });
    const gh = forkRunner();
    const savedRepo = process.env.GH_REPO;
    delete process.env.GH_REPO;
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      process.env.GH_REPO = 'ambient/other';
      const refused = await run.options.actions.postComment(76, 'hello');
      assert.equal(refused.ok, false, 'the write is refused on the drift');
      assert.match(refused.error, /changed since this issue list loaded/);

      const before = gh.calls.length;
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true);
      assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/myfork/project'),
        'the read carries the pin, not the ambient GH_REPO');
    } finally {
      if (run) run.restore();
      if (savedRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = savedRepo;
    }
  });

  test('an explicit GH_REPO is pinned host-qualified and used', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-env-pin' });
    const gh = forkRunner();
    const savedRepo = process.env.GH_REPO;
    process.env.GH_REPO = 'ambient/repo';
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      const before = gh.calls.length;
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true);
      assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/ambient/repo'),
        'the pinned GH_REPO is host-qualified and used');
    } finally {
      if (run) run.restore();
      if (savedRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = savedRepo;
    }
  });
});

describe('/issues registration survives a reused module', () => {
  test('each runtime load registers the command', async () => {
    const { commands, factory } = await loadExtension();
    assert.ok(commands.has('issues'));
    const reloaded = new Map();
    const api = {
      registerTool: () => {},
      registerCommand: (name, definition) => reloaded.set(name, definition),
      registerMessageRenderer: () => {},
      on: () => () => {},
    };
    factory(api);
    assert.ok(reloaded.has('issues'), 'a reload must not inherit a registered flag from the old runtime');
    reloaded.clear();
    factory(api);
    assert.ok(reloaded.has('issues'), 'a rebuilt registry on the same API must also regain the command');
  });
});

// S7 (issues-all-toggle): `/issues <number>` opens the same panel on `Assigned`
// with that issue selected and its detail shown, exactly as if the reader had
// moved to Assigned and arrowed down to it. Anything that is not a bare
// positive integer (optionally `#`-prefixed) keeps the command's original
// refusal. S8 (the sidebar's cache) is another task and is not exercised here.
describe('/issues <number> opens the panel on one issue (S7)', () => {
  const assignedSearches = (calls) => searchQueries(calls).filter((query) => query.startsWith('assignee:@me'));

  function syntheticRow(number, title = `assigned issue ${number}`) {
    return {
      number,
      title,
      state: 'OPEN',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      url: `https://example.test/issues/${number}`,
    };
  }

  // A runner that answers the scoped SEARCH reads from per-bucket row lists,
  // and everything else from the shared fixture runner, so the mounted view's
  // own cursor paging is exercised through the real client seam.
  function pagedSearchRunner(rowsByBucket) {
    const base = makeIssuesRunner();
    const calls = [];
    const runner = async (bin, argv, opts) => {
      calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = graphqlField(argv, 'query', '-f') || '';
        if (query.includes('type: ISSUE')) {
          const search = graphqlField(argv, 'search') || '';
          const rows = search.includes('assignee:@me') ? rowsByBucket.assigned
            : search.includes('involves:@me') ? rowsByBucket.involved
              : rowsByBucket.mine;
          return { status: 0, stdout: graphqlSearchPage(argv, rows || []), stderr: '', error: null };
        }
      }
      return base.runner(bin, argv, opts);
    };
    return { runner, calls };
  }

  test('a bare number opens on Assigned with that row selected and its detail shown', async () => {
    const root = makeRepo({ tag: 'issues-one-number' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner, args: '76' });
    await tick();
    const frame = clean(component.render(200).join('\n'));
    assert.match(frame, /▸ Assigned/, 'the panel opens on the Assigned tab');
    assert.match(frame, /▸ chore: update/, 'the matching row is the selected one');
    assert.ok(calls.some((call) => call.argv[0] === 'issue' && call.argv[1] === 'view'
      && call.argv.includes('76') && call.argv.includes('--json')),
    'the requested issue detail was read through gh');
    assert.equal(searchQueries(calls).length, 3, 'opening still reads exactly the three scoped buckets');
    assert.equal(connectionReads(calls).length, 0, 'and never the All connection (S2)');
  });

  test('the #-prefixed form opens the same panel on the same issue', async () => {
    const root = makeRepo({ tag: 'issues-one-hash' });
    const { runner } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner, args: '#76' });
    await tick();
    const frame = clean(component.render(200).join('\n'));
    assert.match(frame, /▸ Assigned/);
    assert.match(frame, /▸ chore: update/);
  });

  test('anything else keeps the exact old refusal and opens nothing', async () => {
    const root = makeRepo({ tag: 'issues-one-refused' });
    const { commands, mod, hooks } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(hooks, gateCtx(scratch, []));
    mod.setIssuesTuiLoader(async () => stubTui);
    for (const arg of ['0', '-3', '12abc', 'all', '5 6', '#', '#0']) {
      const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
      await commands.get('issues').handler(arg, ctx);
      assert.equal(customs.length, 0, `${arg}: no overlay is opened`);
      assert.deepEqual(notes, [[`Unknown option "${arg}". Use /issues.`, 'error']], `${arg}: the old refusal is unchanged`);
    }
  });

  test('a number that is not in Assigned says so and keeps the first row', async () => {
    const root = makeRepo({ tag: 'issues-one-missing' });
    const { runner } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner, args: '51' });
    assert.ok(await waitFor(() => clean(component.render(200).join('\n')).includes('#51 is not in Assigned')));
    const frame = clean(component.render(200).join('\n'));
    assert.match(frame, /#51 is not in Assigned/, 'the note row names the miss');
    assert.match(frame, /▸ chore: update/, 'the first row is still the selection');
  });

  test('a number on a later Assigned page is found by paging and selected', async () => {
    const root = makeRepo({ tag: 'issues-one-page2' });
    const rows = Array.from({ length: 18 }, (_, at) => syntheticRow(at + 1));
    const { runner, calls } = pagedSearchRunner({ mine: [], assigned: [...rows, syntheticRow(51)], involved: [] });
    const { component } = await openIssues(root, { runner, args: '51' });
    await tick();
    const frame = clean(component.render(200).join('\n'));
    assert.match(frame, /▸ assigned issue 51/, 'the second-page match is selected');
    assert.equal(assignedSearches(calls).length, 2, 'exactly one more page was read to find it');
  });

  test('paging for a missing number stops at five Assigned pages', async () => {
    const root = makeRepo({ tag: 'issues-one-bound' });
    const rows = Array.from({ length: 200 }, (_, at) => syntheticRow(at + 1));
    const { runner, calls } = pagedSearchRunner({ mine: [], assigned: rows, involved: [] });
    const { component } = await openIssues(root, { runner, args: '999' });
    assert.ok(await waitFor(() => assignedSearches(calls).length >= 5));
    await tick();
    assert.equal(assignedSearches(calls).length, 5, 'the bound is five Assigned pages in total');
    const frame = clean(component.render(200).join('\n'));
    assert.match(frame, /#999 is not in Assigned/, 'the panel discloses the miss');
    assert.match(frame, /▸ assigned issue 1/, 'the first row stays selected');
  });

  test('plain /issues still opens on My issues and is handed no initial issue', async () => {
    const root = makeRepo({ tag: 'issues-one-plain' });
    const run = await capturedIssuesOptions(root);
    try {
      assert.equal('initialBucket' in run.options, false, 'a plain open passes no initial bucket');
      assert.equal('initialIssue' in run.options, false, 'and no initial issue');
    } finally {
      run.restore();
    }
    const { runner } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    const frame = clean(component.render(200).join('\n'));
    assert.match(frame, /▸ My issues/, 'a plain open still starts on My issues');
    assert.ok(!frame.includes('is not in'), 'and paints no initial-issue note');
  });
});

// ---------------------------------------------------------------------------
// S8 (the panel ODD's T4; the sidebar ODD's S9 consumer half): the rail's
// process cache is what makes the first frame instant. The cache is filled by
// the section's ONE combined read — through the published bridge — and the
// panel READS it, keyed by the identity the panel itself just proved.
//
// The contract under test, through the public surface only:
// - with an entry for the proved identity, the three scoped pages are seeded
//   from it, so the first frame paints rows instead of `loading…`;
// - the seeded open STILL reads: the visible bucket's page read is issued at
//   mount and its answer replaces the seeded rows, and every other seeded tab
//   is read the first time it is activated — nothing is seeded forever;
// - with NO entry the panel behaves exactly as before (the same notes, the same
//   three scoped reads and the same first frame);
// - a bucket the cache reported TRUNCATED never renders an exact total (`N+`);
// - the panel never writes the cache: a second open paints the same seeded rows.
// ---------------------------------------------------------------------------

describe('/issues opens from the rail cache (S8/T4)', () => {
  const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
  // The identity both halves prove for the fixture checkout: one remote would
  // have no scope identity, and `makeRepo` has none at all, so gh's own answer
  // (`tools/fixtures/gh-repo-view.json`) is normalized host-qualified.
  const IDENTITY = 'github.com/jonasotoaguilar/herdr-gentle-shell';

  function installBridge() {
    const registered = [];
    globalThis[BRIDGE_SLOT] = {
      schema: 'gentle-shell-bridge/api',
      version: 1,
      registerRows: () => {},
      // T5 of odd-rail-section: the bridge carries TWO sections now, so this double
      // records the `GITHUB` one it is about. Every registration still receives a
      // disposer, so the `ODD` rail registers alongside rather than being refused.
      registerSection: (section) => {
        if (section && section.id === 'odd-worktree.issues') registered.push(section);
        return () => {};
      },
      createStore: () => ({}),
      requestRepaint: () => {},
    };
    return registered;
  }

  // One issue node in the shape the rail's combined read asks for.
  function relatedNode(row) {
    const stamp = row.updatedAt || '2026-02-01T00:00:00Z';
    return {
      number: row.number,
      title: row.title,
      state: 'OPEN',
      stateReason: '',
      url: `https://example.test/issues/${row.number}`,
      createdAt: stamp,
      updatedAt: stamp,
      author: { login: 'me' },
      labels: { nodes: [] },
      // T10 (S9): the assignees the panel's first frame can show without
      // waiting for the detail read.
      assignees: { nodes: Array.isArray(row.assignees) ? row.assignees.map((login) => ({ login })) : [] },
      comments: { totalCount: 0 },
      reactionGroups: [],
      timelineItems: { nodes: [] },
    };
  }

  // The rail's ONE combined answer: three aliased buckets, each with its exact
  // `issueCount`. `counts` overrides a count, which is how a bucket past the
  // cache's cap becomes `truncated`.
  function relatedAnswer({ mine = [], assigned = [], involved = [], counts = {} } = {}) {
    const bucket = (key, rows) => ({
      issueCount: Number.isInteger(counts[key]) ? counts[key] : rows.length,
      nodes: rows.map(relatedNode),
    });
    return {
      data: {
        mine: bucket('mine', mine),
        assigned: bucket('assigned', assigned),
        involved: bucket('involved', involved),
      },
    };
  }

  function issueRow(number, title) {
    return {
      number,
      title,
      state: 'OPEN',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      url: `https://example.test/issues/${number}`,
    };
  }

  // The detail `gh issue view` answers with when a test holds it and then
  // releases it: one row's whole issue, with a body.
  function defaultIssueDetail(row) {
    return {
      number: row.number,
      title: row.title,
      state: 'OPEN',
      body: `body of issue ${row.number}`,
      author: { login: 'me' },
      labels: [],
      assignees: [],
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      url: `https://example.test/issues/${row.number}`,
    };
  }

  // A runner over the shared fixture runner: the rail's combined read answers
  // from `related`, and the panel's page reads can be HELD so the seeded first
  // frame is observable before any answer lands.
  function cacheRunner({ related, holdPages = false, holdDetail = false, fixtureIssue = defaultIssueDetail }) {
    const base = makeIssuesRunner();
    const calls = [];
    const held = [];
    const heldDetails = [];
    const runner = async (bin, argv, opts) => {
      calls.push({ bin, argv: argv.slice(), env: { ...((opts && opts.env) || {}) }, cwd: opts ? opts.cwd : undefined });
      if (holdDetail && argv[0] === 'issue' && argv[1] === 'view') {
        const entry = { argv: argv.slice(), release: null };
        entry.answer = new Promise((resolve) => {
          entry.release = (row) => resolve({
            status: 0, stdout: JSON.stringify(fixtureIssue(row)), stderr: '', error: null,
          });
        });
        heldDetails.push(entry);
        return entry.answer;
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = graphqlField(argv, 'query', '-f') || '';
        if (query.includes('mine: search(')) {
          return { status: 0, stdout: JSON.stringify(related), stderr: '', error: null };
        }
        if (holdPages && query.includes('type: ISSUE')) {
          const entry = { argv: argv.slice(), release: null };
          entry.answer = new Promise((resolve) => {
            entry.release = (rows) => resolve({
              status: 0, stdout: graphqlSearchPage(argv, rows), stderr: '', error: null,
            });
          });
          held.push(entry);
          return entry.answer;
        }
      }
      return base.runner(bin, argv, opts);
    };
    return { runner, calls, held, heldDetails };
  }

  // Mount `/issues` over an already-loaded extension. The component is the real
  // view, against the real (injected) client.
  async function mountIssues(loaded, root, { args = '' } = {}) {
    loaded.mod.setIssuesTuiLoader(async () => stubTui);
    let factory = null;
    const { ctx, notes } = makeCtx({ cwd: root });
    ctx.ui.custom = async (captured) => { factory = captured; return null; };
    await loaded.commands.get('issues').handler(args, ctx);
    assert.ok(factory, 'the overlay opens');
    const { component } = openComponent(factory, makeHostTui(24));
    return { component, notes };
  }

  // The rail fills the cache exactly as it does in a live session: the bridge is
  // published BEFORE the extension loads (that is when the section is
  // registered), `session_start` binds the checkout, and ONE drawn frame starts
  // the section's read.
  async function warmRail(root, related, options = {}) {
    const registered = installBridge();
    const loaded = await loadExtension();
    const gh = cacheRunner({
      related,
      holdPages: true,
      holdDetail: options.holdDetail === true,
      fixtureIssue: options.fixtureIssue || defaultIssueDetail,
    });
    ghIssues.setGhRunner(gh.runner);
    await fireSessionStart(loaded.hooks, gateCtx(root, []));
    assert.equal(registered.length, 1, 'the rail section is registered through the bridge');
    const section = registered[0];
    const ctx = { cwd: root, ui: { notify: () => {} } };
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = section.lines(ctx);
      if (!(rows.length === 1 && rows[0].label === 'loading…')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const labels = section.lines(ctx).map((row) => row.label);
    assert.ok(labels.length > 0 && labels[0] !== 'loading…',
      `the rail never filled the cache (saw ${JSON.stringify(labels)})`);
    return { loaded, gh, section, labels };
  }

  test('a warmed cache paints the cached rows on the first frame and still reads', async () => {
    const root = makeRepo({ tag: 'issues-cache-warm' });
    const related = relatedAnswer({
      mine: [{ number: 12, title: 'Newer twelve', updatedAt: '2026-02-02T00:00:00Z' },
        { number: 11, title: 'Older eleven', updatedAt: '2026-02-01T00:00:00Z' }],
      assigned: [{ number: 21, title: 'Assigned twenty-one', updatedAt: '2026-02-03T00:00:00Z' }],
      involved: [{ number: 31, title: 'Involved thirty-one', updatedAt: '2026-02-04T00:00:00Z' }],
    });
    const warmed = await warmRail(root, related);
    const { loaded, gh } = warmed;
    assert.deepEqual(warmed.labels,
      ['#21 Assigned twenty-one', '#12 Newer twelve', '#11 Older eleven'],
      'the rail draws the merged mine+assigned list it caches (S7/T8)');
    const railRead = gh.calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')[0];
    assert.equal(railRead.env.GH_REPO, IDENTITY,
      'the cache entry is keyed by the identity the rail proved for this checkout');

    const { component } = await mountIssues(loaded, root);
    const first = clean(component.render(200).join('\n'));
    // The list row is the title alone (the number lives in the preview beside
    // it), and the seeded frames are what is on screen before any page read
    // answers — which is exactly what the cache is for.
    assert.match(first, /Newer twelve/, 'the cached row is painted before any page read answers');
    assert.match(first, /Older eleven/);
    assert.match(first, /▸ My issues \(2\)/, 'and the seeded bucket reports the rows it holds');
    assert.match(first, /Assigned \(1\)/);
    assert.match(first, /Involved \(1\)/);

    // The seeded open STILL reads: the visible bucket (My issues) asks for its
    // own page at mount, so the seeded rows are replaced by a real answer.
    await waitFor(() => gh.held.length === 1, 'opening never started the visible bucket\'s own read');
    assert.deepEqual(searchQueries(gh.held), ['author:@me sort:updated-desc'],
      'the held read is the visible bucket\'s scoped search');

    gh.held[0].release([issueRow(40, 'Fresh forty')]);
    await waitFor(() => clean(component.render(200).join('\n')).includes('Fresh forty'));
    const afterAnswer = clean(component.render(200).join('\n'));
    assert.ok(!afterAnswer.includes('Newer twelve'),
      'the real answer replaced the seeded row instead of sitting beside it');

    // A seeded tab that mount did not read is read on its FIRST activation: the
    // seed is never the tab's only data.
    component.handleInput('tab');
    await waitFor(() => gh.held.length === 2, 'the activated seeded tab never read its own page');
    assert.deepEqual(searchQueries([gh.held[1]]), ['assignee:@me sort:updated-desc'],
      'the Assigned tab reads its own bucket the first time it is entered');

    // The panel never writes the cache: a second open still paints the SAME
    // seeded rows, not the answer the first open read — and it backs them with
    // its own read again.
    const second = await mountIssues(loaded, root);
    const secondFrame = clean(second.component.render(200).join('\n'));
    assert.match(secondFrame, /Newer twelve/, 'the cache still holds the rail\'s rows');
    await waitFor(() => gh.held.length === 3, 'the second open never read its own page');
    assert.deepEqual(searchQueries([gh.held[2]]), ['author:@me sort:updated-desc'],
      'the second open reads the visible bucket again');
  });

  // S7 (T8): an issue that is BOTH authored and assigned is one merged row, and
  // the assigned bucket wins the collision — so clicking it opens on Assigned,
  // exactly as the user asked ("assigned tiene prioridad").
  test('a number in both mine and assigned opens on Assigned', async () => {
    const root = makeRepo({ tag: 'issues-seed-both' });
    const related = relatedAnswer({
      mine: [{ number: 13, title: 'Both thirteen', updatedAt: '2026-02-03T00:00:00Z' }],
      assigned: [{ number: 13, title: 'Both thirteen', updatedAt: '2026-02-03T00:00:00Z' }],
    });
    const { loaded } = await warmRail(root, related);
    const { component } = await mountIssues(loaded, root, { args: '13' });
    const frame = clean(component.render(240).join('\n'));
    const bar = frame.split('\n').find((line) => line.includes('Assigned')) ?? '';
    assert.match(bar, /▸ Assigned/, 'the assigned bucket wins the collision');
    assert.ok(!frame.includes('is not in'), 'and the number is found, not reported missing');
  });

  // S9 (T10) part 2: the rail's cached row is the panel's seed, so the FIRST
  // frame of a numbered open already carries the issue's identity — number,
  // title, labels, assignees, author — while the body is still on its way. The
  // defect was the opposite: a bare `loading…` pane for facts the rail knew.
  test('a numbered open paints the seeded facts on its first frame, with the body behind them', async () => {
    const root = makeRepo({ tag: 'issues-seed-detail' });
    const related = relatedAnswer({
      assigned: [{
        number: 22,
        title: 'Assigned twenty-two',
        updatedAt: '2026-02-02T00:00:00Z',
        assignees: ['ana'],
      }],
    });
    const { loaded, gh } = await warmRail(root, related, { holdDetail: true });
    const { component } = await mountIssues(loaded, root, { args: '22' });
    await waitFor(() => gh.heldDetails.length === 1, 'the detail read never started');

    const first = clean(component.render(240).join('\n'));
    assert.match(first, /#22 Assigned twenty-two/, 'the number and title are on screen at once');
    assert.match(first, /\[open\]/, 'and the state the row already carried');
    assert.match(first, /assignees: ana/, 'so are the assignees the rail cached');
    assert.match(first, /\(no labels\)/, 'and the labels line, honest about a row that carried none');
    assert.match(first, /by me/, 'and the author');
    // S9: the frame opens ON the issue. The body marker still names the read,
    // but only under those facts — never a bare `loading…` pane.
    assert.match(first, /loading…/, 'the body read still names itself under the facts');
    assert.match(first, /#22 Assigned twenty-two[\s\S]*loading…/,
      'the facts come first and the read is named below them — never a bare loading pane');
    assert.ok(!first.includes('body of issue 22'),
      'the body is not invented from a row that never carried it');

    // The body follows behind the facts, in the same pane.
    gh.heldDetails[0].release({ number: 22, title: 'Assigned twenty-two' });
    assert.ok(await waitFor(() => clean(component.render(240).join('\n')).includes('body of issue 22')),
      'the detail read replaced the pending frame');
  });

  // S9 (T10) part 3: the command picks the bucket from the cache — `assigned`
  // when the number is there, `mine` when it is only there. A number that is
  // only authored therefore opens on My issues, selected and loaded.
  test('a number that is only in mine opens on My issues', async () => {
    const root = makeRepo({ tag: 'issues-seed-mine' });
    const related = relatedAnswer({
      mine: [{ number: 61, title: 'Mine sixty-one', updatedAt: '2026-02-03T00:00:00Z' }],
      assigned: [{ number: 21, title: 'Assigned twenty-one', updatedAt: '2026-02-02T00:00:00Z' }],
    });
    const { loaded, gh } = await warmRail(root, related);
    assert.deepEqual(gh.held.length, 0, 'the rail read answers no page');

    const { component } = await mountIssues(loaded, root, { args: '61' });
    const frame = clean(component.render(240).join('\n'));
    const bar = frame.split('\n').find((line) => line.includes('My issues')) ?? '';
    assert.match(bar, /▸ My issues/, 'the reader lands on My issues, which holds the number');
    assert.match(frame, /Mine sixty-one/, 'and its row is on screen');
    assert.ok(!frame.includes('is not in'), 'no miss is reported for a number the rail had');
    assert.ok(await waitFor(() => gh.held.length >= 1), 'the visible bucket still reads its own page');
    assert.deepEqual(searchQueries([gh.held[0]]), ['author:@me sort:updated-desc'],
      'and the page it reads is My issues, the bucket the cache chose');
  });

  test('with no cache the panel opens exactly as before', async () => {
    const root = makeRepo({ tag: 'issues-cache-empty' });
    const base = makeIssuesRunner();
    const calls = [];
    const held = [];
    // No bridge at all: no rail, no draw, so no entry for this identity.
    const loaded = await loadExtension();
    ghIssues.setGhRunner(async (bin, argv, opts) => {
      calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = graphqlField(argv, 'query', '-f') || '';
        if (query.includes('type: ISSUE')) {
          const entry = { argv: argv.slice(), release: null };
          entry.answer = new Promise((resolve) => {
            entry.release = (rows) => resolve({
              status: 0, stdout: graphqlSearchPage(argv, rows), stderr: '', error: null,
            });
          });
          held.push(entry);
          return entry.answer;
        }
      }
      return base.runner(bin, argv, opts);
    });
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-gate-')));
    await fireSessionStart(loaded.hooks, gateCtx(scratch, []));

    const { component, notes } = await mountIssues(loaded, root);
    await waitFor(() => held.length === 3, 'the open never read the three scoped buckets');
    assert.deepEqual(notes, [], 'an empty cache produces no note');
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'the open reads the three scoped buckets exactly as before');
    assert.equal(connectionReads(calls).length, 0, 'and never the All connection');
    // `render(100)` produces the full-screen frame the host paints. Runs of box
    // drawing and padding are collapsed so the assertion states the frame's
    // CONTENT — the box, the search row, the loading line and the footer, with
    // today's blank body rows. A seeded frame would carry rows here instead.
    const frame = clean(component.render(100).join('\n'));
    const shape = frame.split('\n').map((line) => line
      .trimEnd()
      .replace(/─{2,}/g, '─…')
      .replace(/ {2,}/g, ' '));
    assert.deepEqual(shape, [
      '╭─ ◈ Issues ─…╮',
      '│ › Search │',
      '│ loading issues… │',
      ...new Array(19).fill('│ │'),
      // S11: no issue is under the cursor on the first frame, so the five
      // tokens that act on one are absent; every other hint stays.
      '│ ↑↓ move · ctrl+j/k scroll · ←→ bucket · t search · g all issues · esc close │',
      '╰─…╯',
    ], 'the first frame is today\'s loading frame, byte for byte');
  });

  test('a truncated cached bucket never claims an exact total', async () => {
    const root = makeRepo({ tag: 'issues-cache-truncated' });
    const assigned = Array.from({ length: 105 }, (_, at) => ({
      number: 100 + at,
      title: `assigned ${100 + at}`,
      updatedAt: '2026-02-01T00:00:00Z',
    }));
    const related = relatedAnswer({
      mine: [{ number: 12, title: 'Mine twelve', updatedAt: '2026-02-02T00:00:00Z' }],
      assigned,
      counts: { assigned: 105 },
    });
    const { loaded } = await warmRail(root, related);

    const { component } = await mountIssues(loaded, root);
    const first = clean(component.render(240).join('\n'));
    assert.match(first, /Assigned \(100\+\)/, 'a bucket the cache truncated is painted as inexact');
    assert.ok(!/Assigned \(100\)/.test(first), 'and never with an exact total it does not have');
    assert.ok(!/Assigned \(105\)/.test(first), 'nor with a count no surface read');
  });

  // T17 (E17b): the rail refuses to trust an entry whose cached rows no longer
  // match the `issueCount` the response reported (its next sync is a full
  // re-read), so a total derived from those rows is exactly the number the rail
  // itself refuses to claim. The panel must paint it inexact too.
  // E18 (S4, verify round 5 blocker b): a seeded page is rows on screen before its
  // own read answers, and the verifier's exact scenario is `/issues 22` over a
  // seeded `Assigned` of `[21, 22]` with that page still in flight: the initial
  // selection landed on 21, and `c` then `ctrl+s` posted a comment on 21 while the
  // human asked for 22. A mutation on an issue nobody chose is the one thing the
  // identity work exists to prevent.
  //
  // The property: with `Assigned` seeded and `/issues <n>` where `n` is the second
  // seeded row, no mutation of any kind — comment, labels, assignees, close — can
  // reach any row other than `n`.
  test('a seeded Assigned page never lends a mutation to another issue (E18)', async () => {
    const root = makeRepo({ tag: 'issues-seed-mutation' });
    const related = relatedAnswer({
      assigned: [
        { number: 21, title: 'Assigned twenty-one', updatedAt: '2026-02-03T00:00:00Z' },
        { number: 22, title: 'Assigned twenty-two', updatedAt: '2026-02-02T00:00:00Z' },
      ],
    });
    const warmed = await warmRail(root, related);
    const { loaded, gh } = warmed;
    const { component } = await mountIssues(loaded, root, { args: '22' });
    const frame = () => clean(component.render(240).join('\n'));
    const writes = () => gh.calls.filter((call) => call.argv[0] === 'issue'
      && ['comment', 'edit', 'close'].includes(call.argv[1]));

    assert.ok(await waitFor(() => gh.held.length >= 1), 'the numbered open issued its own Assigned read');
    assert.deepEqual(searchQueries([gh.held[0]]), ['assignee:@me sort:updated-desc'],
      'the held read is the bucket the panel was opened on');

    // The verifier's exact scenario: `c`, then `ctrl+s`, in that window.
    component.handleInput('c');
    for (const ch of 'looks right') component.handleInput(ch);
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => writes().length > 0), 'the comment reached gh');
    assert.deepEqual(writes().map((call) => call.argv.slice(0, 3)), [['issue', 'comment', '22']],
      'the comment names the issue the human asked for, never the seeded #21');

    // The page's own answer lands. The correct issue is still the only one any
    // mutation can reach.
    gh.held[0].release([
      issueRow(21, 'Assigned twenty-one'),
      issueRow(22, 'Assigned twenty-two'),
    ]);
    assert.ok(await waitFor(() => frame().includes('l labels')),
      'the answer is on screen and the detail confirmed the role');

    component.handleInput('l');
    await tick();
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => writes().some((call) => call.argv[1] === 'edit'
      && call.argv.includes('--add-label'))), 'the label save reached gh');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'the label save closed the editor');
    // A successful write re-reads the detail, and the editor keys are only
    // offered once that answer confirms the repository role again.
    const roleBack = await waitFor(() => frame().includes('l labels'));
    if (!roleBack) console.log('DEBUG2>>>\n' + frame().split('\n').filter((line) => !line.trim().startsWith('│') || line.includes('Assigned twenty') || line.includes('·')).join('\n') + '\n<<<DEBUG2');
    assert.ok(roleBack, 'the refreshed detail confirms the role');

    component.handleInput('a');
    // S10: the editor's title is its name alone; its keys are the footer row.
    assert.ok(await waitFor(() => frame().includes('Assignees') && frame().includes('space toggle')),
      'the assignee editor opened');
    assert.ok(await waitFor(() => !frame().includes('loading assignees')), 'the assignable users answered');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    const assigneeWrite = (call) => call.argv[1] === 'edit'
      && (call.argv.includes('--add-assignee') || call.argv.includes('--remove-assignee'));
    assert.ok(await waitFor(() => writes().some(assigneeWrite)), 'the assignee save reached gh');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'the assignee save closed the editor');
    assert.ok(await waitFor(() => frame().includes('x close')), 'the refreshed detail confirms the role again');

    component.handleInput('x');
    component.handleInput('enter');
    assert.ok(await waitFor(() => writes().some((call) => call.argv[1] === 'close')), 'the close reached gh');

    assert.deepEqual(writes().map((call) => call.argv[2]), ['22', '22', '22', '22'],
      'every mutation this panel ran named #22, the issue the human asked for');
    assert.equal(writes().some((call) => call.argv[2] === '21'), false,
      'and not one of them ever named the seeded #21');
  });

  test('an inconsistent cached entry never claims an exact total', async () => {
    const root = makeRepo({ tag: 'issues-cache-inconsistent' });
    // ONE read whose assigned `issueCount` (2) outruns the nodes it returned
    // (1): the count invariant breaks on the very first apply, which is exactly
    // the state a departed issue leaves behind between two rail reads.
    const related = relatedAnswer({
      mine: [{ number: 12, title: 'Mine twelve', updatedAt: '2026-02-02T00:00:00Z' }],
      assigned: [{ number: 21, title: 'Assigned twenty-one', updatedAt: '2026-02-03T00:00:00Z' }],
      counts: { assigned: 2 },
    });
    const { loaded } = await warmRail(root, related);

    const { component } = await mountIssues(loaded, root);
    const first = clean(component.render(240).join('\n'));
    assert.match(first, /Assigned \(1\+\)/, 'an entry the rail calls inconsistent is seeded inexact');
    assert.ok(!/Assigned \(1\)(?!\+)/.test(first), 'and never with the exact total it cannot prove');
  });
});

// ---------------------------------------------------------------------------
// S21 (T17), the human's own words: «me la asigne a mi o me quite la
// asignacion … no se refresca altiro los tabs … actualmente eso demora o no
// refrezca de hecho hasta que lo cierro y abro panel». This drives the REAL
// panel over the injected `gh` client, and the REAL rail section over the
// published bridge, so every assertion below is a read or a write that reached
// `gh`:
// - a save that changed the VIEWER's own assignment drops the rail's cached
//   entry for this repository, so the rail's next read is the FULL one (a delta
//   merges by issue number and can never express a removal) and it starts now,
//   not on the 20 s floor;
// - the panel reads the `assigned` bucket again and its count and rows follow;
// - a write that did not land invalidates nothing: no rail read, no page read,
//   the pre-write rows and count stay, and the draft stays open with the error.
// ---------------------------------------------------------------------------
describe('/issues reflects a self-assignment on the panel and the rail (S21/T17)', () => {
  const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
  const VIEWER = 'jonasotoaguilar';

  // The one repository state both surfaces read. `assignees` is what makes an
  // issue `assigned` to the viewer; `mine` is authorship, which an assignment
  // never changes.
  function repoState() {
    return {
      issues: new Map([
        [12, { number: 12, title: 'Mine twelve', mine: true, assignees: [], updatedAt: '2026-02-02T00:00:00Z' }],
        [21, { number: 21, title: 'Assigned twenty-one', mine: false, assignees: [VIEWER], updatedAt: '2026-02-03T00:00:00Z' }],
      ]),
    };
  }

  const authored = (state) => [...state.issues.values()].filter((row) => row.mine);
  const assignedToViewer = (state) => [...state.issues.values()].filter((row) => row.assignees.includes(VIEWER));

  function searchRow(row) {
    return {
      number: row.number,
      title: row.title,
      state: 'OPEN',
      url: `https://example.test/issues/${row.number}`,
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
      author: { login: row.mine ? VIEWER : 'octocat' },
    };
  }

  function relatedNode(row) {
    return {
      ...searchRow(row),
      labels: { nodes: [] },
      assignees: { nodes: row.assignees.map((login) => ({ login })) },
      comments: { totalCount: 0 },
      reactionGroups: [],
      timelineItems: { nodes: [] },
    };
  }

  function relatedAnswer(state) {
    const bucket = (rows) => ({ issueCount: rows.length, nodes: rows.map(relatedNode) });
    return { data: { mine: bucket(authored(state)), assigned: bucket(assignedToViewer(state)), involved: bucket([]) } };
  }

  function assignmentRunner(state, failure) {
    const calls = [];
    const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
    const runner = async (bin, argv, opts) => {
      calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const query = graphqlField(argv, 'query', '-f') || '';
        const search = graphqlField(argv, 'search');
        if (query.includes('mine: search(')) return ok(JSON.stringify(relatedAnswer(state)));
        if (search !== null) {
          if (search.includes('assignee:@me')) return ok(graphqlSearchPage(argv, assignedToViewer(state).map(searchRow)));
          if (search.includes('involves:@me')) return ok(graphqlSearchPage(argv, []));
          return ok(graphqlSearchPage(argv, authored(state).map(searchRow)));
        }
        if (query.includes('assignableUsers')) {
          return ok(JSON.stringify({ data: { repository: { assignableUsers: {
            nodes: [{ login: VIEWER, name: 'Jonathan Soto' }, { login: 'octocat', name: 'Octo Cat' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } } } }));
        }
        // The assignee mutation's own permission read: it names the viewer too,
        // which is what makes the save's answer able to say "this one was mine".
        if (query.includes('viewer {')) {
          return ok(JSON.stringify({ data: { repository: { viewerPermission: 'WRITE' }, viewer: { login: VIEWER } } }));
        }
        if (query.includes('projectItems')) {
          return ok(JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [], pageInfo: { hasNextPage: false } } } } } }));
        }
        if (query.includes('viewerPermission')) {
          const number = Number(graphqlField(argv, 'number', '-F'));
          const row = state.issues.get(number);
          return ok(JSON.stringify({ data: { repository: {
            viewerPermission: 'WRITE',
            issue: {
              assignees: { nodes: (row ? row.assignees : []).map((login) => ({ login })), pageInfo: { hasNextPage: false } },
              closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          } } }));
        }
        return ok(JSON.stringify({ data: {} }));
      }
      if (argv[0] === 'api') return ok(fixture('gh-api-user.json'));
      if (argv[0] === 'repo') return ok(fixture('gh-repo-view.json'));
      if (argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')) {
        const number = Number(argv[2]);
        const row = state.issues.get(number);
        return ok(JSON.stringify({
          number,
          title: row.title,
          state: 'OPEN',
          body: `body of issue ${number}`,
          author: { login: row.mine ? VIEWER : 'octocat' },
          labels: [],
          createdAt: row.updatedAt,
          updatedAt: row.updatedAt,
          url: `https://example.test/issues/${number}`,
          comments: [],
        }));
      }
      if (argv[0] === 'issue' && argv[1] === 'edit') {
        if (failure && failure.on === true) return { status: 1, stdout: '', stderr: 'Forbidden', error: null };
        const row = state.issues.get(Number(argv[2]));
        for (let index = 3; index < argv.length; index += 1) {
          const flag = argv[index];
          const login = argv[index + 1];
          if (flag === '--add-assignee' && row) row.assignees = [...new Set([...row.assignees, login])];
          if (flag === '--remove-assignee' && row) row.assignees = row.assignees.filter((name) => name !== login);
        }
        return ok('');
      }
      if (argv[0] === 'label' && argv[1] === 'list') return ok(fixture('gh-label-list.json'));
      return ok('');
    };
    return { runner, calls };
  }

  // The rail fills its cache exactly as a live session does: the bridge is
  // published BEFORE the extension loads, `session_start` binds the checkout,
  // and ONE drawn frame starts the read.
  async function warmRail(root, state, options = {}) {
    const registered = [];
    globalThis[BRIDGE_SLOT] = {
      schema: 'gentle-shell-bridge/api',
      version: 1,
      registerRows: () => {},
      // T5 of odd-rail-section: record the `GITHUB` section this case is about; the
      // `ODD` rail registers on the same double and is simply not what is read here.
      registerSection: (section) => {
        if (section && section.id === 'odd-worktree.issues') registered.push(section);
        return () => {};
      },
      createStore: () => ({}),
      requestRepaint: () => {},
    };
    const loaded = await loadExtension();
    const gh = assignmentRunner(state, options.failure);
    ghIssues.setGhRunner(gh.runner);
    await fireSessionStart(loaded.hooks, gateCtx(root, []));
    assert.equal(registered.length, 1, 'the rail section is registered through the bridge');
    const section = registered[0];
    const ctx = { cwd: root, ui: { notify: () => {} } };
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = section.lines(ctx);
      if (!(rows.length === 1 && rows[0].label === 'loading…')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { loaded, gh, section, ctx };
  }

  async function mountPanel(loaded, root) {
    loaded.mod.setIssuesTuiLoader(async () => stubTui);
    let factory = null;
    const { ctx } = makeCtx({ cwd: root });
    ctx.ui.custom = async (captured) => { factory = captured; return null; };
    await loaded.commands.get('issues').handler('', ctx);
    assert.ok(factory, 'the overlay opens');
    const host = makeHostTui(24);
    const { component } = openComponent(factory, host.tui);
    return { component, host };
  }

  const isRailRead = (call) => call.argv[0] === 'api' && call.argv[1] === 'graphql'
    && (graphqlField(call.argv, 'query', '-f') || '').includes('mine: search(');
  const railReads = (gh) => gh.calls.filter(isRailRead);
  const railQuery = (call) => graphqlField(call.argv, 'query', '-f');
  const assigneeWrites = (gh) => gh.calls.filter((call) => call.argv[0] === 'issue'
    && call.argv[1] === 'edit'
    && (call.argv.includes('--add-assignee') || call.argv.includes('--remove-assignee')));
  const frameOf = (component) => clean(component.render(240).join('\n'));

  test('unassigning yourself repaints the tab, refetches the full rail entry and counts one less', async () => {
    const root = makeRepo({ tag: 'issues-self-assign' });
    const state = repoState();
    const { loaded, gh, section, ctx } = await warmRail(root, state);
    assert.equal(section.meta(ctx), '2 issues', 'the rail starts with both rows');

    const { component } = await mountPanel(loaded, root);
    // `Assigned` is where the viewer's own row lives; the tab reads it on entry.
    component.handleInput('tab');
    assert.ok(await waitFor(() => frameOf(component).includes('Assigned twenty-one')),
      'the Assigned tab paints the viewer\'s row before the write');

    // The editor key requires the repository role the DETAIL confirms, so the
    // press waits for that answer exactly like the panel's other editor tests.
    assert.ok(await waitFor(() => frameOf(component).includes('a assign')), 'the detail confirmed the role');
    component.handleInput('a');
    assert.ok(await waitFor(() => frameOf(component).includes('Assignees') && frameOf(component).includes('space toggle')),
      'the assignee editor opened');
    assert.ok(await waitFor(() => !frameOf(component).includes('loading assignees')),
      'the assignable users answered');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => assigneeWrites(gh).length === 1), 'the assignee save reached gh');
    assert.deepEqual(assigneeWrites(gh)[0].argv,
      ['issue', 'edit', '21', '--remove-assignee', VIEWER],
      'the write names the viewer exactly as the editor toggled it');

    // The panel: the Assigned bucket was read again and its count follows.
    assert.ok(await waitFor(() => frameOf(component).includes('Assigned (0)')),
      'the Assigned tab count follows the removal without reopening the panel');
    assert.ok(!frameOf(component).includes('Assigned twenty-one'), 'and the row is gone');
    const assignedReads = gh.calls
      .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
      .map((call) => graphqlField(call.argv, 'search'))
      .filter((value) => value !== null && value.includes('assignee:@me'));
    assert.ok(assignedReads.length >= 2, 'the write invalidated the Assigned page, so it was read again');

    // The rail: one read started by the write itself, and it is the FULL one —
    // a delta could only merge by issue number and could never drop the row.
    assert.ok(await waitFor(() => railReads(gh).length >= 2), 'the write started a rail read of its own');
    assert.match(railQuery(railReads(gh)[1]), /first: 100/,
      'the dropped entry makes the next rail read the full size, so a removal can land');
    assert.ok(await waitFor(() => section.meta(ctx) === '1 issues'), 'the rail count follows the removal');
    assert.deepEqual(section.lines(ctx).map((row) => row.label), ['#12 Mine twelve'],
      'and the merged rows are the ones the full read answered');
  });

  test('a rejected assignee save repaints nothing and keeps the row and the count', async () => {
    const root = makeRepo({ tag: 'issues-self-assign-fail' });
    const state = repoState();
    // GitHub refuses the write: the answer is the only source of truth here, so
    // a rejection that reached the surface must leave every row and count alone.
    const failure = { on: false };
    const { loaded, gh, section, ctx } = await warmRail(root, state, { failure });
    const { component } = await mountPanel(loaded, root);
    component.handleInput('tab');
    assert.ok(await waitFor(() => frameOf(component).includes('Assigned twenty-one')), 'the row is on screen');
    assert.ok(await waitFor(() => frameOf(component).includes('a assign')), 'the detail confirmed the role');
    component.handleInput('a');
    assert.ok(await waitFor(() => !frameOf(component).includes('loading assignees')), 'the users answered');
    component.handleInput('space');
    const before = railReads(gh).length;
    failure.on = true;
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => /Forbidden/.test(frameOf(component))), 'the rejection is visible');
    await tick();
    await tick();
    assert.equal(component.state.mode, 'assignees', 'the editor keeps the draft');
    assert.equal(railReads(gh).length, before, 'a failed write invalidates nothing, so no rail read starts');
    assert.equal(section.meta(ctx), '2 issues', 'the rail keeps the pre-write count');
    assert.match(frameOf(component), /Assigned \(1\)/, 'and the panel keeps the pre-write count');
    assert.ok(frameOf(component).includes('Assigned twenty-one'), 'the row never left');
  });
});

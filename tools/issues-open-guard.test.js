'use strict';
// T1 (issues-sidebar-click S1, S2): the rail click's single-flight guard and the
// numbered open's cached-scope identity pin, driven through the loaded extension
// with a fake host, a fake bridge and injected `gh`/`git` seams.
//
// Contract under test, through the public surface only:
// - while a rail click is being opened, every further rail click — the same row,
//   another numbered row, the overflow row — is a no-op: exactly ONE
//   `/issues …` message reaches the host, nothing is appended, notified or
//   repainted, and the click callback returns normally (no throw, no refusal);
// - the effect comes back when the open is over: the panel mounted, an early
//   return before it (the gh gate, a cwd outside a checkout, no interactive
//   host, a failed identity proof), a throw, or the bounded safety interval —
//   unref'd, about ten seconds — for a command the host never ran;
// - a typed `/issues` is never held back by a click in flight;
// - the guard belongs to one session generation: a click left over by a
//   previous session never blocks the next one, and a shutdown releases it;
// - a numbered open (`/issues <n>`, the form the rail dispatches) pins the
//   identity from the checkout's CACHED scope, so its first frame is seeded from
//   the rail's cache for that identity, while a plain `/issues` keeps the FRESH
//   proof; a cached pin that cannot be read falls back to the fresh one once;
// - the identity pin and the TUI helper load start together.
//
// Every child process is injected: `gh` through lib/gh-issues.js `setGhRunner`,
// the identity read's `git` through its `setGitRunner`, and the checkouts live
// under os.tmpdir() and are removed in `after()`. The bridge slot is
// process-wide, so it is always deleted again.

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LIB_DIR, stubbedSource } = require('./fixtures/load-extension.js');
const { pathToFileURL } = require('node:url');

const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
// `waitFor` and the timer fixtures poll with the REAL timer, even while one test
// replaces the global one to fake the safety interval.
const realSetTimeout = setTimeout;

const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

// The lib instance the extension load actually uses, so an injected runner
// reaches the code under test.
let ghIssues = null;
let restores = [];

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

afterEach(() => {
  delete globalThis[BRIDGE_SLOT];
  if (ghIssues) {
    ghIssues.setGhRunner(null);
    ghIssues.setGitRunner(null);
  }
  for (const restore of restores) {
    try { restore(); } catch {}
  }
  restores = [];
});

function track(dir) {
  roots.push(dir);
  return dir;
}

// A fresh copy per load (the fixture's stubbed source is cached, the module is
// not), returning the module namespace so a test can reach the lib instance THIS
// load uses and the extension's test seams.
async function loadExtension(pi) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-guard-ext-')));
  const copy = path.join(dir, 'odd-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbedSource());
  const commands = new Map();
  const hooks = [];
  const api = {
    registerTool: () => {},
    registerCommand: (name, definition) => { commands.set(name, definition); },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (customType, data) => { entries.push({ customType, data }); },
    on: (event, handler) => { hooks.push([event, handler]); return () => {}; },
    ...pi,
  };
  const entries = [];
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(api);
  return { commands, hooks, api, mod, entries };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A real checkout with TWO remotes (a fork), the case whose identity comes from
// the checkout's OWN git configuration: a CACHED scope read then reuses what the
// rail already proved, while a FRESH one reads git again. That is the difference
// the numbered open is tested against. `singleRemote` builds the other shape — one
// remote, so gh's own `repo view` is the whole identity — which is the shape whose
// cached-scope pin still paid that network call before the click carried its row's
// identity.
function makeCheckout({ singleRemote = false } = {}) {
  const dir = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-guard-'))));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  git(dir, ['remote', 'add', 'origin', 'git@github.com:myfork/project.git']);
  if (!singleRemote) git(dir, ['remote', 'add', 'upstream', 'git@github.com:original/project.git']);
  return dir;
}

function okJson(stdout) {
  return { status: 0, stdout, stderr: '', error: null };
}

function issue(number, updatedAt = '2024-01-01T00:00:00Z') {
  return { number, title: `Issue ${number}`, state: 'OPEN', updatedAt };
}

// Nine issues: seven painted rows and the overflow row, so a click on any row of
// the body and on the overflow row is available to the guard tests.
function nineIssues() {
  return Array.from({ length: 9 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return issue(100 + index, `2024-01-${day}T00:00:00Z`);
  });
}

// The GraphQL node the rail's ONE combined read returns for a test row.
function graphqlNode(item) {
  return {
    number: item.number,
    title: typeof item.title === 'string' ? item.title : '',
    state: 'OPEN',
    stateReason: '',
    url: '',
    createdAt: '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    author: { login: 'me' },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reactionGroups: [],
    timelineItems: { nodes: [] },
  };
}

function relatedAnswer({ mine = [], assigned = [], involved = [] } = {}) {
  const bucket = (rows) => ({ issueCount: rows.length, nodes: rows.map(graphqlNode) });
  return { data: { mine: bucket(mine), assigned: bucket(assigned), involved: bucket(involved) } };
}

// gh's answers for the rail's combined read and the gate.
function fakeGithub({ assigned = [], gate = true } = {}) {
  const calls = [];
  const runner = async (bin, argv, runOpts = {}) => {
    calls.push({ bin, argv: argv.slice(), cwd: runOpts.cwd });
    if (argv[0] === 'api' && argv[1] === 'user') {
      return gate ? okJson('{"login":"me"}') : { status: 1, stdout: '', stderr: 'not logged in', error: null };
    }
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      return okJson(JSON.stringify(relatedAnswer({ assigned })));
    }
    return okJson('');
  };
  return { runner, calls };
}

function realGit(argv, cwd) {
  try {
    const stdout = execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return { status: 0, stdout, stderr: '', error: null };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
      error: null,
    };
  }
}

// The identity read's own git seam, over the fixture's REAL git configuration but
// with the head remote's URL under the test's control: flipping `remoteUrl.value`
// models a checkout whose remote moved, and the CACHED scope keeps the identity it
// already proved (a fingerprint over the unchanged configuration still matches)
// while the FRESH one reads the new URL.
function identityGit({ remoteUrl = { value: 'git@github.com:myfork/project.git' }, failConfigReads = 0 } = {}) {
  const calls = [];
  let configReads = 0;
  return {
    calls,
    remoteUrl,
    run: (argv, opts = {}) => {
      calls.push(argv.slice());
      if (argv[0] === 'config') {
        configReads += 1;
        if (configReads <= failConfigReads) return { status: 1, stdout: '', stderr: 'bad config', error: null };
        return realGit(argv, opts.cwd);
      }
      if (argv[0] === 'remote' && argv[1] === 'get-url') {
        return { status: 0, stdout: `${remoteUrl.value}\n`, stderr: '', error: null };
      }
      return realGit(argv, opts.cwd);
    },
  };
}

function installBridge() {
  const registered = [];
  const repaints = [];
  globalThis[BRIDGE_SLOT] = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerRows: () => {},
    registerSection: (section) => { registered.push(section); return () => {}; },
    createStore: () => ({}),
    requestRepaint: () => { repaints.push(1); },
  };
  return { registered, repaints };
}

function sessionStartHandlers(hooks) {
  return hooks.filter(([event]) => event === 'session_start').map(([, handler]) => handler);
}

async function fireSessionStart(hooks, ctx) {
  for (const handler of sessionStartHandlers(hooks)) {
    const out = handler({}, ctx);
    if (out && typeof out.then === 'function') await out;
  }
}

async function fireHook(hooks, event, ctx) {
  for (const handler of hooks.filter(([name]) => name === event).map(([, fn]) => fn)) {
    const out = handler({ toolResults: [] }, ctx);
    if (out && typeof out.then === 'function') await out;
  }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
  throw new Error(message);
}

// Let a deferred click and its promise chain settle before the next assertion.
async function settle(ms = 25) {
  await new Promise((resolve) => realSetTimeout(resolve, ms));
}

// Only a drawn section reads, so the draw IS the trigger: poll it until its own
// TTL read has landed.
async function waitForRows(section, ctx) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = section.lines(ctx);
    if (!(rows.length === 1 && rows[0].label === 'loading…')) return rows;
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
  throw new Error('the section never left loading');
}

// `draw: false` runs the session in a SECOND checkout: the startup `gh` probe
// warms nothing in the fixture checkout under test, so a numbered open there meets
// a COLD scope cache and has to prove the identity — the pattern the command tests
// use for the same reason.
async function harness({ assigned = nineIssues(), draw = true, gate = true, singleRemote = false } = {}) {
  const checkout = makeCheckout({ singleRemote });
  const { registered, repaints } = installBridge();
  const sent = [];
  const loaded = await loadExtension({
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
  });
  ghIssues = loaded.mod.libModule('gh-issues.js');
  const gh = fakeGithub({ assigned, gate });
  ghIssues.setGhRunner(gh.runner);
  const identity = identityGit();
  ghIssues.setGitRunner(identity.run);
  loaded.mod.setIssuesTuiLoader(async () => stubTui);
  const notices = [];
  const sessionCwd = draw ? checkout : makeCheckout();
  const ctx = { cwd: sessionCwd, ui: { notify: (text, level) => { notices.push({ text, level }); } } };
  await fireSessionStart(loaded.hooks, ctx);
  const section = registered[0];
  const rows = draw && section ? await waitForRows(section, ctx) : [];
  return { checkout, loaded, gh, identity, registered, section, rows, sent, notices, repaints, ctx };
}

// The host running the command a click dispatched. `custom` records the mount
// instead of drawing; `false` models a host with no overlay support at all.
function commandCtx(cwd, { custom = true, notices = [] } = {}) {
  const customs = [];
  const ctx = { cwd, ui: { notify: (text, level) => { notices.push({ text, level }); } } };
  if (custom) {
    ctx.ui.custom = async (factory, options) => {
      customs.push({ factory, options });
      return null;
    };
  }
  return { ctx, customs, notices };
}

function numberOf(label) {
  const match = /^#(\d+)/.exec(String(label));
  assert.ok(match, `a row label starts with its issue number (saw ${label})`);
  return Number(match[1]);
}

// Capture the options the command mounts the real view with: the module instance
// THIS extension load uses is patched, never a separate `require`.
function captureIssuesView(mod) {
  const holder = { options: null };
  const lib = mod.libModule('issues-view.js');
  const original = lib.createIssuesView;
  lib.createIssuesView = (options) => {
    holder.options = options;
    return { render: () => [], handleInput: () => {}, invalidate: () => {} };
  };
  restores.push(() => { lib.createIssuesView = original; });
  return holder;
}

// A host's own terminal object, enough for the factory the command mounts.
function hostTui() {
  return { stop: () => {}, start: () => {}, requestRender: () => {} };
}

// ---------------------------------------------------------------------------
// S1: one open at a time, and the effect is invisible to the click.
// ---------------------------------------------------------------------------

test('S1: two rapid clicks on one row send exactly one /issues message and announce nothing', async () => {
  const h = await harness();
  const row = h.rows[0];
  const number = numberOf(row.label);
  const paintedBefore = h.repaints.length;
  const labelsBefore = h.rows.map((row) => row.label);

  assert.doesNotThrow(() => row.onClick(), 'the click itself is never refused');
  assert.doesNotThrow(() => row.onClick(), 'and a second one is not refused either');
  await waitFor(() => h.sent.length > 0, 'the click never dispatched its command');
  await settle();

  assert.deepEqual(h.sent, [{ text: `/issues ${number}`, opts: { expandPromptTemplates: true } }],
    'one open at a time: the second click sent nothing');
  assert.equal(h.loaded.entries.length, 0, 'nothing was appended for the swallowed click');
  assert.deepEqual(h.notices, [], 'and nothing was notified');
  assert.equal(h.repaints.length, paintedBefore, 'and the rail repainted nothing for it');
  assert.deepEqual(h.section.lines(h.ctx).map((label) => label.label), labelsBefore,
    'and the rail paints exactly what it painted before the click');
});

test('S1: a click on another numbered row while one is opening is a no-op', async () => {
  const h = await harness();
  const first = numberOf(h.rows[0].label);
  h.rows[0].onClick();
  h.rows[2].onClick();
  await waitFor(() => h.sent.length > 0, 'the first click never dispatched');
  await settle();
  assert.deepEqual(h.sent, [{ text: `/issues ${first}`, opts: { expandPromptTemplates: true } }],
    'a different row is swallowed exactly like the same one');
  assert.equal(h.loaded.entries.length, 0);
  assert.deepEqual(h.notices, []);
});

test('S1: the overflow row is guarded like a numbered row, in both orders', async () => {
  const nine = await harness();
  assert.equal(nine.rows.length, 8, 'seven issue rows plus the overflow row');
  assert.equal(nine.rows[7].label, 'and 2 more issues');
  nine.rows[7].onClick();
  nine.rows[0].onClick();
  await waitFor(() => nine.sent.length > 0, 'the overflow click never dispatched');
  await settle();
  assert.deepEqual(nine.sent, [{ text: '/issues', opts: { expandPromptTemplates: true } }],
    'the overflow row opened the panel and the numbered click behind it did nothing');

  const numbered = await harness();
  const number = numberOf(numbered.rows[0].label);
  numbered.rows[0].onClick();
  numbered.rows[7].onClick();
  await waitFor(() => numbered.sent.length > 0, 'the numbered click never dispatched');
  await settle();
  assert.deepEqual(numbered.sent, [{ text: `/issues ${number}`, opts: { expandPromptTemplates: true } }],
    'and the overflow row is swallowed while a numbered open is in flight');
});

test('S1: the rail works again once the first panel mounted', async () => {
  const h = await harness();
  const first = numberOf(h.rows[0].label);
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the first click never dispatched');

  const { ctx, customs } = commandCtx(h.checkout);
  await h.loaded.commands.get('issues').handler(String(first), ctx);
  assert.equal(customs.length, 1, 'the panel mounted');

  const second = numberOf(h.rows[1].label);
  h.rows[1].onClick();
  await waitFor(() => h.sent.length === 2, 'the click after a mounted panel was swallowed');
  assert.deepEqual(h.sent[1], { text: `/issues ${second}`, opts: { expandPromptTemplates: true } });
});

test('S1: a gh gate that refuses releases the guard', async () => {
  const h = await harness({ gate: false });
  const number = numberOf(h.rows[0].label);
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');

  const { ctx, customs } = commandCtx(h.checkout);
  await h.loaded.commands.get('issues').handler(String(number), ctx);
  assert.equal(customs.length, 0, 'the gate refusal opened nothing');

  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 2, 'the refused command left the rail dead');
});

test('S1: a host with no overlay support releases the guard', async () => {
  const h = await harness();
  const number = numberOf(h.rows[0].label);
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');

  const { ctx, customs } = commandCtx(h.checkout, { custom: false });
  await h.loaded.commands.get('issues').handler(String(number), ctx);
  assert.equal(customs.length, 0, 'no overlay exists to mount');

  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 2, 'the ended open left the rail dead');
});

test('S1: a cwd outside a checkout releases the guard', async () => {
  const h = await harness();
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');

  const outside = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-guard-plain-')));
  const { ctx, customs, notices } = commandCtx(outside);
  await h.loaded.commands.get('issues').handler('12', ctx);
  assert.equal(customs.length, 0, 'nothing opens outside a checkout');
  assert.equal(notices.length, 1, 'and the shared line is still said');

  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 2, 'the early return left the rail dead');
});

test('S1: a failed identity proof still mounts and releases the guard', async () => {
  const h = await harness();
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');

  // The identity cannot be proven at all: the cached read and its one fresh
  // fallback both fail, and the panel still opens (S5 reports the failure). The
  // open names ANOTHER number than the click, because a click's own number now
  // rides its row identity and pins it without a proof at all (S2 below) — the
  // click still owns the guard that this failed open has to release.
  ghIssues.setGitRunner(() => ({ status: 1, stdout: '', stderr: 'bad config', error: null }));
  const holder = captureIssuesView(h.loaded.mod);
  const { ctx, customs } = commandCtx(h.checkout);
  ctx.ui.custom = async (factory) => { customs.push(1); factory(hostTui(), {}, {}, () => {}); return null; };
  await h.loaded.commands.get('issues').handler('12', ctx);
  assert.equal(customs.length, 1, 'the overlay mounted despite the failed proof');
  assert.equal((await holder.options.loadIssuePage({ bucketId: 'assigned', limit: 5 })).ok, false,
    'and its reads report the unproven identity');

  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 2, 'the failed proof left the rail dead');
});

test('S1: a throw before the overlay releases the guard', async () => {
  const h = await harness();
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');

  const { ctx } = commandCtx(h.checkout);
  const hostile = { toString() { throw new Error('boom'); } };
  await assert.rejects(h.loaded.commands.get('issues').handler(hostile, ctx), /boom/,
    'the command still fails as loudly as before');

  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 2, 'the throw left the rail dead');
});

test('S1: the bounded safety interval releases the guard when the host never runs the command', async () => {
  const h = await harness();
  const row = h.rows[0];
  const number = numberOf(row.label);
  const timers = [];
  const unrefd = [];
  const saved = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn, ms) => {
      const timer = { fn, ms, ran: false, unref: () => { unrefd.push(timer); }, ref: () => {} };
      timers.push(timer);
      return timer;
    };
    row.onClick();
    await drainDeferred(timers);
    assert.deepEqual(h.sent, [{ text: `/issues ${number}`, opts: { expandPromptTemplates: true } }],
      'the first click still dispatches');

    const armed = timers.filter((timer) => timer.ms > 0);
    assert.equal(armed.length, 1, 'exactly one bounded safety timer was armed');
    assert.ok(armed[0].ms >= 5000 && armed[0].ms <= 15000,
      `the safety interval is about ten seconds (saw ${armed[0].ms}ms)`);
    assert.deepEqual(unrefd, [armed[0]], 'and it is unref\'d, so it never holds the process open');

    row.onClick();
    await drainDeferred(timers);
    assert.equal(h.sent.length, 1, 'while it is armed, a further click is still a no-op');

    armed[0].fn();
    row.onClick();
    await drainDeferred(timers);
    assert.deepEqual(h.sent[1], { text: `/issues ${number}`, opts: { expandPromptTemplates: true } },
      'the interval releases the guard even though no command ever ran');
  } finally {
    globalThis.setTimeout = saved;
  }
});

// Run every zero-delay callback the fake scheduler holds — the rail defers a
// click onto one — and let the promises they settle flush.
async function drainDeferred(timers) {
  for (let pass = 0; pass < 20; pass += 1) {
    const due = timers.filter((timer) => timer.ms === 0 && timer.ran !== true);
    if (due.length === 0) return;
    for (const timer of due) {
      timer.ran = true;
      timer.fn();
    }
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

test('S1: a click from the previous session never blocks the next one', async () => {
  const h = await harness();
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');
  // The host never ran the click's command; the session ends and a new one starts.
  await fireSessionStart(h.loaded.hooks, h.ctx);
  const rows = await waitForRows(h.section, h.ctx);

  const number = numberOf(rows[1].label);
  rows[1].onClick();
  await waitFor(() => h.sent.length === 2, "the next session's click was swallowed by the previous one");
  assert.deepEqual(h.sent[1], { text: `/issues ${number}`, opts: { expandPromptTemplates: true } });
});

test('S1: a shutdown releases the guard', async () => {
  const h = await harness();
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');
  await fireHook(h.loaded.hooks, 'session_shutdown', h.ctx);

  h.rows[1].onClick();
  await waitFor(() => h.sent.length === 2, 'a shutdown left the next click dead');
});

test('S1: a typed /issues is never swallowed by a click in flight', async () => {
  const h = await harness();
  h.rows[0].onClick();
  await waitFor(() => h.sent.length === 1, 'the click never dispatched');

  const { ctx, customs } = commandCtx(h.checkout);
  await h.loaded.commands.get('issues').handler('', ctx);
  assert.equal(customs.length, 1, 'the typed command opens its panel exactly as before');
});

// ---------------------------------------------------------------------------
// S2: the numbered open pins the cached scope, and starts both loads together.
// ---------------------------------------------------------------------------

// The pages the mount was handed, by bucket id.
function pageOf(options, id) {
  const page = options.pages.find((entry) => entry.id === id);
  assert.ok(page, `the mount is handed the ${id} page`);
  return page;
}

test('S2: a numbered open pins the identity from the checkout\'s cached scope', async () => {
  const h = await harness();
  assert.ok(h.rows.slice(0, 7).some((row) => numberOf(row.label) === 104), 'the rail read the fixture rows');
  // The checkout's remote "moves" after the rail proved its repository: a FRESH
  // proof would name another repository, the CACHED one keeps the first.
  h.identity.remoteUrl.value = 'git@github.com:myfork/renamed.git';
  const identityCallsBefore = h.identity.calls.length;

  const holder = captureIssuesView(h.loaded.mod);
  const { ctx, customs } = commandCtx(h.checkout);
  ctx.ui.custom = async (factory) => { customs.push(1); factory(hostTui(), {}, {}, () => {}); return null; };
  await h.loaded.commands.get('issues').handler('104', ctx);
  assert.equal(customs.length, 1, 'the panel mounted');

  const options = holder.options;
  assert.equal(options.initialIssue, 104);
  assert.equal(options.initialBucket, 'assigned', 'the cache says which tab holds the number');
  assert.deepEqual(pageOf(options, 'assigned').issues.map((row) => row.number).sort((a, b) => a - b),
    [100, 101, 102, 103, 104, 105, 106, 107, 108],
    'the first frame is seeded from the rail cache for the identity the checkout already proved');
  assert.equal(pageOf(options, 'assigned').total, 9, 'and reports the count that cache holds');
  assert.deepEqual(pageOf(options, 'mine').issues, [],
    'a bucket the cache holds empty is seeded empty, exactly like the cache says');
  assert.ok(h.identity.calls.length - identityCallsBefore <= 1,
    'the pin cost at most the cache validation, never a fresh proof');
  assert.ok(!h.identity.calls.slice(identityCallsBefore).some((argv) => argv[0] === 'remote'),
    'the numbered open never re-read the checkout\'s remotes');
});

test('S2 (preserve): a plain /issues keeps its fresh identity proof', async () => {
  const h = await harness();
  h.identity.remoteUrl.value = 'git@github.com:myfork/renamed.git';
  const identityCallsBefore = h.identity.calls.length;

  const holder = captureIssuesView(h.loaded.mod);
  const { ctx, customs } = commandCtx(h.checkout);
  ctx.ui.custom = async (factory) => { customs.push(1); factory(hostTui(), {}, {}, () => {}); return null; };
  await h.loaded.commands.get('issues').handler('', ctx);
  assert.equal(customs.length, 1, 'the panel mounted');

  const options = holder.options;
  assert.equal('initialIssue' in options, false, 'a plain open is handed no initial issue');
  assert.ok(h.identity.calls.slice(identityCallsBefore).some((argv) => argv[0] === 'remote'),
    'the plain open proved the checkout again');
  for (const page of options.pages) {
    assert.equal(page.issues, null,
      `the fresh proof named the moved repository, which the cache does not hold (saw ${page.id})`);
  }
});

test('S2: the identity pin and the TUI helper load start together', async () => {
  const h = await harness({ draw: false });
  let loaderStarted = false;
  h.loaded.mod.setIssuesTuiLoader(async () => { loaderStarted = true; return stubTui; });

  let releaseConfig = null;
  const held = new Promise((resolve) => { releaseConfig = resolve; });
  let configHeld = false;
  const base = h.identity.run;
  ghIssues.setGitRunner((argv, opts) => {
    if (argv[0] === 'config' && configHeld !== true) {
      configHeld = true;
      return held.then(() => base(argv, opts));
    }
    return base(argv, opts);
  });

  const { ctx, customs } = commandCtx(h.checkout);
  const pending = h.loaded.commands.get('issues').handler('12', ctx);
  await waitFor(() => configHeld, 'the numbered open never started its identity pin');
  assert.equal(loaderStarted, true, 'the TUI helper load starts WITH the pin, not after it settles');
  releaseConfig();
  await pending;
  assert.equal(customs.length, 1, 'and the panel still mounts once the pin answers');
});

test('S2: a cached pin that cannot be read falls back to the fresh proof once', async () => {
  const h = await harness({ draw: false });
  // The FIRST identity read is the numbered open's cached one: it fails, and the
  // fresh proof behind it answers.
  const failing = identityGit({ failConfigReads: 1 });
  ghIssues.setGitRunner(failing.run);

  const holder = captureIssuesView(h.loaded.mod);
  const { ctx, customs } = commandCtx(h.checkout);
  ctx.ui.custom = async (factory) => { customs.push(1); factory(hostTui(), {}, {}, () => {}); return null; };
  await h.loaded.commands.get('issues').handler('104', ctx);
  assert.equal(customs.length, 1, 'the panel mounted');
  assert.equal(holder.options.initialIssue, 104);

  const configReads = failing.calls.filter((argv) => argv[0] === 'config').length;
  const remoteReads = failing.calls.filter((argv) => argv[0] === 'remote' && argv[1] === 'get-url').length;
  assert.equal(configReads, 2, 'the cached read failed once and the fresh fallback read once');
  assert.equal(remoteReads, 1, 'the fallback proved the identity, once');
});

test('S2: both proofs failing keeps today\'s failure, and the panel still opens', async () => {
  const h = await harness({ draw: false });
  ghIssues.setGitRunner(() => ({ status: 1, stdout: '', stderr: 'bad config', error: null }));

  const holder = captureIssuesView(h.loaded.mod);
  const { ctx, customs } = commandCtx(h.checkout);
  ctx.ui.custom = async (factory) => { customs.push(1); factory(hostTui(), {}, {}, () => {}); return null; };
  await h.loaded.commands.get('issues').handler('12', ctx);
  assert.equal(customs.length, 1, 'the panel still opens with an unproven identity');
  const page = await holder.options.loadIssuePage({ bucketId: 'assigned', limit: 5 });
  assert.equal(page.ok, false);
  assert.match(page.error, /git configuration|cannot resolve this checkout's own repository|own repository/,
    'the read reports the unproven identity, exactly as before');
});

// ---------------------------------------------------------------------------
// S2, second half: the row's identity rides the click, so the numbered open
// pins THAT repository with no probe at all.
// ---------------------------------------------------------------------------

// The identity work a call did: the identity's own `git` seam (the cached-scope
// read and the fresh proof both go through it) plus gh's own repository
// resolution, which is the whole proof of a SINGLE-remote checkout. Everything
// else a mount runs is a read of issues, never the identity.
function identityChildren(h, before) {
  return {
    git: h.identity.calls.slice(before.git),
    gh: h.gh.calls.slice(before.gh)
      .filter((call) => call.bin === 'gh' && call.argv[0] === 'repo' && call.argv[1] === 'view'),
  };
}

function rowFor(h, number) {
  const row = h.rows.find((candidate) => numberOf(candidate.label) === number);
  assert.ok(row, `the rail painted a row for #${number}`);
  return row;
}

// Click a rail row and then run the command the host would run for it, with the
// view captured instead of drawn. `cwd` is the checkout the command runs in: the
// rail's own by default, or a SECOND checkout whose identity scope cache is cold
// — the only way to see a cached-scope pin cost anything at all.
async function clickOpen(h, { row, number, cwd } = {}) {
  const target = row === undefined ? h.rows[0] : row;
  const asked = number === undefined ? numberOf(target.label) : number;
  const sentBefore = h.sent.length;
  target.onClick();
  await waitFor(() => h.sent.length > sentBefore, 'the click never dispatched its command');
  assert.deepEqual(h.sent[h.sent.length - 1],
    { text: `/issues ${asked}`, opts: { expandPromptTemplates: true } },
    'the click dispatched that row\'s number');
  return await runOpen(h, { cwd: cwd === undefined ? h.checkout : cwd, args: String(asked) });
}

async function runOpen(h, { cwd, args }) {
  const holder = captureIssuesView(h.loaded.mod);
  const { ctx, customs, notices } = commandCtx(cwd);
  ctx.ui.custom = async (factory) => { customs.push(1); factory(hostTui(), {}, {}, () => {}); return null; };
  await h.loaded.commands.get('issues').handler(args, ctx);
  assert.equal(customs.length, 1, 'the panel mounted');
  return { holder, options: holder.options, notices, ctx };
}

test('S2: a click carrying an identity pins it with no identity probe and seeds from the rail cache', async () => {
  // A SINGLE-remote checkout: there is no fork remote to read, so gh's own
  // `repo view` IS the identity proof — the ~0.6 s call a cached-scope pin still
  // paid before a click carried the identity of the row it came from.
  const h = await harness({ singleRemote: true });
  const row = rowFor(h, 104);
  // The checkout's remote "moves" after the rail proved its repository. Nothing on
  // this open path reads it again — and nothing needs to: the row's number belongs
  // to the repository it was READ from, and every action still re-proves the
  // checkout fresh (the drift test below refuses on exactly this).
  h.identity.remoteUrl.value = 'git@github.com:myfork/renamed.git';
  const before = { git: h.identity.calls.length, gh: h.gh.calls.length };

  const { options } = await clickOpen(h, { row });

  assert.equal(options.initialIssue, 104, 'the panel opened on the clicked number');
  assert.equal(options.initialBucket, 'assigned', 'the cache says which tab holds the number');
  assert.deepEqual(pageOf(options, 'assigned').issues.map((entry) => entry.number).sort((a, b) => a - b),
    [100, 101, 102, 103, 104, 105, 106, 107, 108],
    'the first frame is seeded from the rail cache for the identity the ROW was read from');
  assert.equal(pageOf(options, 'assigned').total, 9, 'and reports the count that cache holds');
  const children = identityChildren(h, before);
  assert.deepEqual(children.git, [], 'the clicked identity needed no git child at all');
  assert.deepEqual(children.gh, [], 'and no gh repository probe either');
});

test('S2: the row identity hint is one-shot — the next numbered open takes the cached-scope pin', async () => {
  const h = await harness();
  // A SECOND checkout of the same repository: its scope cache is cold, so an open
  // that does NOT ride the hint has to read git to pin the identity.
  const cold = makeCheckout();
  const beforeFirst = { git: h.identity.calls.length, gh: h.gh.calls.length };
  const first = await clickOpen(h, { row: rowFor(h, 104), cwd: cold });
  assert.equal(first.options.initialIssue, 104);
  assert.deepEqual(identityChildren(h, beforeFirst), { git: [], gh: [] },
    'the clicked open pinned the row identity with no probe at all');

  // The same number again, with no click behind it: the hint was consumed by the
  // open above, so this one falls back to the checkout's cached scope.
  const beforeSecond = { git: h.identity.calls.length, gh: h.gh.calls.length };
  const second = await runOpen(h, { cwd: cold, args: '104' });
  assert.equal(second.options.initialIssue, 104);
  assert.ok(identityChildren(h, beforeSecond).git.length > 0,
    'the second numbered open proved the identity again — the hint is one-shot');
});

test('S2: a hint for another number is ignored and that open takes the cached-scope pin', async () => {
  const h = await harness();
  const cold = makeCheckout();
  const sentBefore = h.sent.length;
  rowFor(h, 104).onClick();
  await waitFor(() => h.sent.length > sentBefore, 'the click never dispatched its command');

  const before = { git: h.identity.calls.length, gh: h.gh.calls.length };
  const { options } = await runOpen(h, { cwd: cold, args: '105' });
  assert.equal(options.initialIssue, 105, 'the open is the number that was asked for');
  assert.ok(identityChildren(h, before).git.length > 0,
    'a hint for another number never pins anything: the open proved its own identity');
  assert.deepEqual(pageOf(options, 'assigned').issues.map((entry) => entry.number).sort((a, b) => a - b),
    [100, 101, 102, 103, 104, 105, 106, 107, 108],
    'and still seeds from the cache for the identity it proved');
});

test('S2: a hint from a previous generation is ignored and the open takes the cached-scope pin', async () => {
  const h = await harness();
  const cold = makeCheckout();
  const sentBefore = h.sent.length;
  rowFor(h, 104).onClick();
  await waitFor(() => h.sent.length > sentBefore, 'the click never dispatched its command');
  // The session boundary moves the cache generation on, so a click left over by
  // the previous session names nothing this one may pin. (The same boundary also
  // releases the guard and with it the hint; the generation stamp is the second
  // guard, and what this pins is the outcome: no pin without a proof.)
  await fireSessionStart(h.loaded.hooks, h.ctx);

  const before = { git: h.identity.calls.length, gh: h.gh.calls.length };
  const { options } = await runOpen(h, { cwd: cold, args: '104' });
  assert.equal(options.initialIssue, 104);
  assert.ok(identityChildren(h, before).git.length > 0,
    'the previous generation\'s hint pinned nothing: the open proved its own identity');
});

test('S2: an action in a panel opened from a click still refuses when the checkout drifted', async () => {
  const h = await harness();
  const { options } = await clickOpen(h, { row: rowFor(h, 104) });
  // The remote moves AFTER the click, which the row pinned without re-reading: this
  // is the drift only `scopeDrift` can catch, and it is caught fresh on every action.
  h.identity.remoteUrl.value = 'git@github.com:myfork/renamed.git';
  const before = { git: h.identity.calls.length, gh: h.gh.calls.length };

  const refused = await options.actions.setState(104, 'closed');
  assert.equal(refused.ok, false, 'the write is refused on the drift');
  assert.match(refused.error, /changed since this issue list loaded/,
    'the refusal is the scope-drift line, naming the repository it found');
  assert.ok(identityChildren(h, before).git.length > 0, 'the action re-proved the checkout fresh');
  const mutations = h.gh.calls.slice(before.gh)
    .filter((call) => call.argv[0] === 'issue' && ['edit', 'comment', 'close', 'reopen'].includes(call.argv[1]));
  assert.deepEqual(mutations, [], 'no mutating gh command ran after the drift');
});

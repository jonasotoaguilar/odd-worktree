'use strict';
// T1/T2 (issues-sidebar S1-S7): the rail section and its wiring.
//
// Contract under test, through the public surface only:
// - the section merges the two buckets (`author:@me`, `assignee:@me`), keeps
//   ONE row per issue, sorts by `updatedAt` descending, caps at `maxRows`, and
//   reads `#<number> <title>` with the relation in `meta`;
// - `lines()`/`meta()` are synchronous frames over an in-process snapshot: a
//   never-settled read still answers, two stale frames schedule ONE refresh,
//   and `onRefreshed` fires once per landed refresh;
// - a row click defers `open(number)` off the paint path, exactly once, and a
//   failing opener lands in the snapshot instead of escaping the caller;
// - the three states are rows (`loading…`, `no open issues`, ONE error row),
//   never a throw;
// - the extension reaches the rail ONLY through gentle-shell-bridge's
//   published object (read from its Symbol slot, never imported): present it
//   registers one section, absent it subscribes to the ready announcement
//   once and registers nothing;
// - at `session_start` the section reads the checkout's own repository:
//   `checkoutRepoScope({cwd})` then both `gh issue list` searches scoped to
//   that pinned identity, and a failed resolution is the error row with NO
//   `gh` call.
//
// Every child process is injected: `gh` goes through lib/gh-issues.js
// `setGhRunner`, git through its `setGitRunner`, and the checkouts live under
// os.tmpdir() and are removed in `after()`. The bridge slot is process-wide, so
// it is always deleted again.

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LIB_DIR, loadExtension } = require('./fixtures/load-extension.js');
const { createIssuesSection } = require('../lib/issues-section.js');

const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');

// The lib instance the LAST extension load actually uses (its first libRequire
// purges this directory once and then reuses the cache), so patching it with
// `setGhRunner`/`setGitRunner` reaches the section's own reads.
let ghIssues = null;

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
});

function track(dir) {
  roots.push(dir);
  return dir;
}

// A manual scheduler: the section's refresh and its click callbacks are queued
// and only run when a test says so, so "deferred" is observable.
function manualSchedule() {
  const queue = [];
  return {
    schedule: (fn) => { queue.push(fn); },
    pending: () => queue.length,
    async flush() {
      while (queue.length > 0) {
        const fn = queue.shift();
        await fn();
      }
    },
  };
}

function issue(number, title, updatedAt) {
  return { number, title, updatedAt };
}

// ---------------------------------------------------------------------------
// T1: lib/issues-section.js, the pure module.
// ---------------------------------------------------------------------------

test('S1/S4: both buckets merge, dedupe, sort, label and cap', async () => {
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: 'github.com/myfork/project',
      mine: [issue(3, 'Mine older', '2024-01-01T00:00:00Z'), issue(1, 'Both', '2024-04-01T00:00:00Z')],
      assigned: [issue(2, 'Assigned', '2024-03-01T00:00:00Z'), issue(1, 'Both', '2024-04-01T00:00:00Z')],
    }),
    open: () => {},
    schedule: sched.schedule,
    maxRows: 3,
  });
  handle.section.lines({});
  await sched.flush();

  const rows = handle.section.lines({});
  assert.deepEqual(rows.map((row) => row.label), ['#1 Both', '#2 Assigned', '#3 Mine older']);
  assert.deepEqual(rows.map((row) => row.meta), ['mine + assigned', 'assigned', 'mine'],
    'the relation is the row meta, and an issue in both buckets appears once');
  assert.deepEqual(rows.map((row) => row.tone), ['accent', 'accent', 'text']);
  assert.ok(rows.every((row) => typeof row.onClick === 'function'));
  assert.equal(handle.section.meta({}), '2 mine · 2 assigned',
    'the heading counts each bucket before dedupe');

  const cappedSched = manualSchedule();
  const capped = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: 'github.com/myfork/project',
      mine: [issue(3, 'Mine older', '2024-01-01T00:00:00Z'), issue(1, 'Both', '2024-04-01T00:00:00Z')],
      assigned: [issue(2, 'Assigned', '2024-03-01T00:00:00Z'), issue(1, 'Both', '2024-04-01T00:00:00Z')],
    }),
    open: () => {},
    schedule: cappedSched.schedule,
    maxRows: 2,
  });
  capped.section.lines({});
  await cappedSched.flush();
  assert.deepEqual(capped.section.lines({}).map((row) => row.label), ['#1 Both', '#2 Assigned'],
    'the row list is capped at maxRows');
});

test('S3: a frame never waits, two stale frames schedule one refresh, and onRefreshed fires once per landing', async () => {
  // A read that never settles: the frame still answers immediately, twice, and
  // schedules exactly one refresh.
  const neverSched = manualSchedule();
  const never = createIssuesSection({
    load: () => new Promise(() => {}),
    open: () => {},
    schedule: neverSched.schedule,
  });
  const first = never.section.lines({});
  const second = never.section.meta({});
  assert.deepEqual(first, [{ label: 'loading…', tone: 'dim' }]);
  assert.equal(second, undefined);
  assert.deepEqual(never.section.lines({}), [{ label: 'loading…', tone: 'dim' }]);
  assert.equal(neverSched.pending(), 1, 'two stale frames schedule exactly one refresh');

  // A ready snapshot goes stale on the TTL and schedules again; each landed
  // refresh calls onRefreshed once.
  let clock = 1000;
  let landed = 0;
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({ ok: true, identity: 'github.com/myfork/project', mine: [], assigned: [] }),
    open: () => {},
    schedule: sched.schedule,
    now: () => clock,
    ttlMs: 100,
    onRefreshed: () => { landed += 1; },
  });
  handle.section.lines({});
  await sched.flush();
  assert.equal(landed, 1);
  assert.deepEqual(handle.section.lines({}), [{ label: 'no open issues', tone: 'dim' }]);
  assert.equal(sched.pending(), 0, 'a fresh snapshot schedules nothing');
  clock += 200;
  handle.section.lines({});
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'the stale snapshot schedules one refresh');
  await sched.flush();
  assert.equal(landed, 2);
});

test('S4: a click defers open, calls it once, and never lets a failure escape', async () => {
  const opened = [];
  const sched = manualSchedule();
  let failure = null;
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: 'github.com/myfork/project',
      mine: [issue(7, 'Click me', '2024-01-01T00:00:00Z')],
      assigned: [],
    }),
    open: (number) => {
      opened.push(number);
      if (failure) throw failure;
    },
    schedule: sched.schedule,
  });
  handle.section.lines({});
  await sched.flush();

  handle.section.lines({})[0].onClick();
  assert.deepEqual(opened, [], 'the opener never runs on the paint path');
  await sched.flush();
  assert.deepEqual(opened, [7], 'one click opens that issue exactly once');

  failure = new Error('no browser here');
  let escaped = null;
  try {
    handle.section.lines({})[0].onClick();
    await sched.flush();
  } catch (err) {
    escaped = err;
  }
  assert.equal(escaped, null, 'the failure never escapes into the caller');
  assert.deepEqual(opened, [7, 7]);
  assert.equal(handle.snapshot().error, 'no browser here');

  const asyncSched = manualSchedule();
  const asyncHandle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: 'github.com/myfork/project',
      mine: [issue(8, 'Async click', '2024-01-01T00:00:00Z')],
      assigned: [],
    }),
    open: () => Promise.reject(new Error('async opener failed')),
    schedule: asyncSched.schedule,
  });
  await asyncHandle.refresh();
  asyncHandle.section.lines({})[0].onClick();
  await asyncSched.flush();
  assert.equal(asyncHandle.snapshot().error, 'async opener failed',
    'an async opener rejection lands in the snapshot, not in the host');
});

test('S5: loading, empty and error are rows, never a throw', async () => {
  const loading = createIssuesSection({
    load: async () => ({ ok: true, identity: 'github.com/myfork/project', mine: [], assigned: [] }),
    open: () => {},
    schedule: () => {},
  });
  assert.deepEqual(loading.section.lines({}), [{ label: 'loading…', tone: 'dim' }]);

  const empty = createIssuesSection({
    load: async () => ({ ok: true, identity: 'github.com/myfork/project', mine: [], assigned: [] }),
    open: () => {},
    schedule: () => {},
  });
  await empty.refresh();
  assert.deepEqual(empty.section.lines({}), [{ label: 'no open issues', tone: 'dim' }]);

  const failed = createIssuesSection({
    load: async () => ({ ok: false, error: "cannot resolve this checkout's own repository" }),
    open: () => {},
    schedule: () => {},
  });
  await failed.refresh();
  assert.deepEqual(failed.section.lines({}), [{
    label: "cannot resolve this checkout's own repository",
    tone: 'error',
  }]);
  assert.equal(failed.section.meta({}), undefined);

  const thrown = createIssuesSection({
    load: async () => { throw new Error('kaboom'); },
    open: () => {},
    schedule: () => {},
  });
  await thrown.refresh();
  assert.deepEqual(thrown.section.lines({}), [{ label: 'kaboom', tone: 'error' }],
    'a throwing read is ONE error row, not a throw');
});

// ---------------------------------------------------------------------------
// T2: the bridge wiring in extensions/odd-worktree-tools.ts.
// ---------------------------------------------------------------------------

function installBridge() {
  const registered = [];
  const repaints = [];
  globalThis[BRIDGE_SLOT] = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerRows: () => {},
    registerSection: (section) => {
      registered.push(section);
      return () => {};
    },
    createStore: () => ({}),
    requestRepaint: () => { repaints.push(1); },
  };
  return { registered, repaints };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A checkout with the given remotes. The two-remote default is a fork (a
// scope identity to pin); ONE remote is the case that has none, so the
// identity has to come from gh's own resolution (T4).
function makeCheckout(remotes = [
  ['origin', 'git@github.com:myfork/project.git'],
  ['upstream', 'git@github.com:original/project.git'],
]) {
  const dir = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-section-'))));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  for (const [name, url] of remotes) git(dir, ['remote', 'add', name, url]);
  return dir;
}

function okJson(stdout) {
  return { status: 0, stdout, stderr: '', error: null };
}

// gh's answers for the section: identity probes plus the two list searches.
// `repoView` is what gh's OWN resolution answers for the checkout.
function sectionGithub({ mine = [], assigned = [], repoView = 'original/project' } = {}) {
  const calls = [];
  const runner = async (bin, argv, runOpts) => {
    const env = (runOpts && runOpts.env) || {};
    calls.push({ bin, argv: argv.slice(), env: { ...env } });
    if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
    if (argv[0] === 'repo' && argv[1] === 'view') return okJson(JSON.stringify({ nameWithOwner: repoView }));
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const at = argv.indexOf('--search');
      const search = at >= 0 ? argv[at + 1] : '';
      if (search.includes('author:@me')) return okJson(JSON.stringify(mine));
      if (search.includes('assignee:@me')) return okJson(JSON.stringify(assigned));
      return okJson('[]');
    }
    return okJson('');
  };
  return { runner, calls };
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

async function waitFor(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

// The section's synchronous frame is the only public read; poll it until the
// eager `session_start` refresh has landed (loading stops).
async function waitForRows(section, ctx) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = section.lines(ctx);
    if (!(rows.length === 1 && rows[0].label === 'loading…')) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the section never left loading');
}

test('S2: a published bridge receives exactly one section with the decided identity', async () => {
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  assert.equal(registered.length, 1, 'exactly one section is registered');
  const section = registered[0];
  assert.equal(section.id, 'odd-worktree.issues');
  assert.equal(section.title, 'ISSUES');
  assert.equal(section.rowLabel, 'issues');
  assert.equal(section.defaultVisible, true);
  assert.equal(typeof section.lines, 'function');
  assert.equal(typeof section.meta, 'function');
  assert.equal(loaded.commands.has('issues'), true, 'every other surface still registers');
});

test('S2: with no bridge and no events, nothing registers and nothing throws', async () => {
  delete globalThis[BRIDGE_SLOT];
  const loaded = await loadExtension({});
  assert.equal(loaded.commands.has('issues'), true);
  assert.equal(loaded.tools.has('worktree_create'), true);
  assert.equal(loaded.tools.has('worktree_list'), true);
});

test('S2: with no bridge but events, the ready announcement is subscribed once', async () => {
  delete globalThis[BRIDGE_SLOT];
  const subscriptions = [];
  const loaded = await loadExtension({
    events: {
      on: (event, handler) => {
        subscriptions.push({ event, handler });
        return () => {};
      },
    },
  });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].event, 'gentle-shell-bridge:ready');
  subscriptions[0].handler();
  assert.equal(subscriptions.length, 1, 'a ready announcement is never a second subscription');
  assert.equal(loaded.commands.has('issues'), true);
});

test("S6: session_start reads both buckets from the checkout's own repository", async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    mine: [{ number: 11, title: 'Mine one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    assigned: [{ number: 12, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);

  assert.deepEqual(rows.map((row) => row.label), ['#12 Assigned one', '#11 Mine one']);
  assert.deepEqual(rows.map((row) => row.meta), ['assigned', 'mine']);
  assert.equal(section.meta(ctx), '1 mine · 1 assigned');

  const lists = gh.calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
  assert.equal(lists.length, 2, 'one read per bucket');
  const searches = lists.map((call) => {
    const at = call.argv.indexOf('--search');
    return at >= 0 ? call.argv[at + 1] : null;
  });
  assert.deepEqual(searches.slice().sort(), [
    'assignee:@me sort:updated-desc',
    'author:@me sort:updated-desc',
  ]);
  for (const call of lists) {
    assert.equal(call.env.GH_REPO, 'github.com/myfork/project', 'the read carries the pinned identity');
    assert.equal(call.argv[call.argv.indexOf('--state') + 1], 'open');
    assert.equal(call.argv[call.argv.indexOf('--limit') + 1], '20', 'the fetch is capped at 20');
  }
});

test("S6: a failed scope resolution is one error row and makes no gh call", async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub();
  ghIssues.setGhRunner(gh.runner);
  // The checkout's own repository cannot be proven: the client fails closed.
  ghIssues.setGitRunner((argv) => {
    if (argv[0] === 'config') {
      return { status: null, stdout: '', stderr: '', error: 'spawn git ENOENT: git is not available' };
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  });

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);

  assert.equal(rows.length, 1, 'one error row');
  assert.equal(rows[0].tone, 'error');
  assert.match(rows[0].label, /cannot read this checkout's git configuration/);
  assert.equal(section.meta(ctx), undefined);
  assert.equal(gh.calls.length, 0, 'no gh call runs without a proven identity');
});

// ---------------------------------------------------------------------------
// T4 (S4 amended): a single-remote checkout has NO scope identity to pin, so
// the identity the row opens and the identity the buckets are read with is the
// one gh itself resolves, normalized host-qualified exactly as `/issues` does.
// ---------------------------------------------------------------------------

test('S4: a single-remote checkout opens the row with the identity gh resolves', async () => {
  // ONE remote: `checkoutRepoScope()` answers `identity: null`, so the opener
  // must reach the repository gh resolves instead of refusing.
  const checkout = makeCheckout([['origin', 'git@github.com:myfork/project.git']]);
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    repoView: 'myfork/project',
    mine: [{ number: 11, title: 'Mine one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);
  const worktreeGit = require(path.join(LIB_DIR, 'worktree-git.js'));
  const opened = [];
  const original = worktreeGit.runArgvAsync;
  worktreeGit.runArgvAsync = async (bin, argv, opts) => {
    if (argv[0] === 'issue') {
      opened.push({ bin, argv: argv.slice(), cwd: opts && opts.cwd });
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    return original(bin, argv, opts);
  };
  try {
    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];
    const rows = await waitForRows(section, ctx);
    assert.deepEqual(rows.map((row) => row.label), ['#11 Mine one'],
      'the single-remote checkout still lists its issues');
    rows[0].onClick();
    await waitFor(() => opened.length > 0, 'the click never reached the browser opener');
  } finally {
    worktreeGit.runArgvAsync = original;
  }
  assert.equal(opened.length, 1, 'one click opens one issue');
  assert.deepEqual(opened[0].argv, ['issue', 'view', '11', '--web', '-R', 'github.com/myfork/project'],
    'the row opens the identity gh resolved for this checkout, host-qualified');
});

test('S1/S6: a single-remote checkout reads both buckets with the identity gh resolves', async () => {
  const checkout = makeCheckout([['origin', 'git@github.com:myfork/project.git']]);
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    repoView: 'myfork/project',
    mine: [{ number: 11, title: 'Mine one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    assigned: [{ number: 12, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#12 Assigned one', '#11 Mine one']);

  const lists = gh.calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
  assert.equal(lists.length, 2, 'one read per bucket');
  const searches = lists.map((call) => {
    const at = call.argv.indexOf('--search');
    return at >= 0 ? call.argv[at + 1] : null;
  });
  assert.deepEqual(searches.slice().sort(), [
    'assignee:@me sort:updated-desc',
    'author:@me sort:updated-desc',
  ]);
  for (const call of lists) {
    assert.equal(call.env.GH_REPO, 'github.com/myfork/project',
      'the read carries the identity gh resolved for this checkout, host-qualified, so the list and the click agree');
    assert.equal(call.argv[call.argv.indexOf('--state') + 1], 'open');
    assert.equal(call.argv[call.argv.indexOf('--limit') + 1], '20', 'the fetch is capped at 20');
  }
});

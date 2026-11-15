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
// - a row click defers `open(number, identity)` off the paint path, exactly
//   once, and a failing opener lands in the snapshot instead of escaping the
//   caller; the identity is the one the ROW was built from, so a row retained
//   across a checkout change opens the repository it was read from;
// - a read still in flight at `session_shutdown` repaints nothing and lands
//   nowhere;
// - `refreshIfStale(maxAgeMs)` is the activity seam: one read for an absent or
//   aged snapshot, nothing for a fresh one, one in flight, or a disposed one;
// - the three states are rows (`loading…`, `no open issues`, ONE error row),
//   never a throw;
// - the extension reaches the rail ONLY through gentle-shell-bridge's
//   published object (read from its Symbol slot, never imported): present it
//   registers one section, absent it subscribes to the ready announcement
//   once and registers nothing;
// - at `session_start` the section reads the checkout's own repository:
//   `checkoutRepoScope({cwd})` then both `gh issue list` searches scoped to
//   that pinned identity, and a failed resolution is the error row with NO
//   `gh` call;
// - the session's own activity drives the section (`before_agent_start`,
//   `turn_end`) behind a 30 s floor, which is what recovers a `/reload` (no
//   `session_start` fires) and what keeps an idle session free of calls;
// - `session_shutdown` drops the snapshot and forgets the session context.
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

test('S4: an opener that RESOLVES { ok: false } records its error and keeps the ready rows', async () => {
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: 'github.com/myfork/project',
      mine: [issue(9, 'Open fails', '2024-01-01T00:00:00Z')],
      assigned: [],
    }),
    // The extension's real opener catches and RESOLVES this shape; it never
    // rejects.
    open: () => Promise.resolve({ ok: false, error: 'cannot open the issue in the browser' }),
    schedule: sched.schedule,
  });
  await handle.refresh();
  const rows = handle.section.lines({});
  assert.deepEqual(rows.map((row) => row.label), ['#9 Open fails']);

  rows[0].onClick();
  await sched.flush();

  assert.equal(handle.snapshot().error, 'cannot open the issue in the browser',
    'a resolved { ok: false } failure lands in the snapshot like a throw');
  assert.equal(handle.snapshot().status, 'ready');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#9 Open fails'],
    'a click failure never turns a ready list into an error row');
});

test('S3: only lines() schedules the TTL refresh, a meta-only frame schedules nothing', async () => {
  let clock = 1000;
  let loads = 0;
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => {
      loads += 1;
      return { ok: true, identity: 'github.com/myfork/project', mine: [], assigned: [] };
    },
    open: () => {},
    schedule: sched.schedule,
    now: () => clock,
    ttlMs: 100,
  });

  // An absent snapshot: the collapsed header draws `meta()` alone.
  assert.equal(handle.section.meta({}), undefined);
  assert.equal(sched.pending(), 0, 'a meta-only frame over an absent snapshot schedules nothing');
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'the drawn body schedules exactly one refresh');
  await sched.flush();
  assert.equal(loads, 1);
  assert.equal(handle.section.meta({}), '0 mine · 0 assigned');

  // A ready snapshot past its TTL: still only the drawn body schedules.
  clock += 200;
  handle.section.meta({});
  assert.equal(sched.pending(), 0, 'a meta-only frame over a stale snapshot schedules nothing');
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'the drawn body schedules exactly one refresh');
  await sched.flush();
  assert.equal(loads, 2, 'the stale frame starts exactly one read');
});

test('S1/S6: an explicit refresh never coalesces, and an older answer never overwrites the latest', async () => {
  const deferred = [];
  const handle = createIssuesSection({
    load: () => new Promise((resolve) => { deferred.push(resolve); }),
    open: () => {},
    schedule: () => {},
  });

  // Repository A's read is in flight when a checkout switch fires the second
  // explicit refresh for repository B.
  const first = handle.refresh();
  const second = handle.refresh();
  assert.equal(deferred.length, 2, 'an explicit refresh starts its own read instead of joining the in-flight one');

  deferred[1]({
    ok: true,
    identity: 'github.com/myfork/repo-b',
    mine: [issue(20, 'B issue', '2024-02-01T00:00:00Z')],
    assigned: [],
  });
  await second;
  assert.equal(handle.snapshot().identity, 'github.com/myfork/repo-b');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#20 B issue']);
  assert.equal(handle.section.meta({}), '1 mine · 0 assigned');

  // A settles later: its rows are dropped, never applied over B's.
  deferred[0]({
    ok: true,
    identity: 'github.com/myfork/repo-a',
    mine: [issue(10, 'A issue', '2024-01-01T00:00:00Z')],
    assigned: [issue(11, 'A assigned', '2024-01-02T00:00:00Z')],
  });
  await first;
  assert.equal(handle.snapshot().identity, 'github.com/myfork/repo-b');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#20 B issue'],
    'the older answer never overwrites the newer one');
  assert.equal(handle.section.meta({}), '1 mine · 0 assigned',
    'the metadata is the newer repository\'s too');
});

test('S6: invalidate drops the snapshot and an in-flight answer never lands', async () => {
  // The supersede the session boundary performs: the current snapshot is gone
  // (the rail shows its loading row), the queued TTL refresh no longer counts
  // as scheduled, and nothing is read or repainted by the drop itself.
  let clock = 1000;
  let loads = 0;
  let landed = 0;
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => {
      loads += 1;
      return {
        ok: true,
        identity: 'github.com/myfork/repo-a',
        mine: [issue(10, 'A issue', '2024-01-01T00:00:00Z')],
        assigned: [],
      };
    },
    open: () => {},
    schedule: sched.schedule,
    now: () => clock,
    ttlMs: 100,
    onRefreshed: () => { landed += 1; },
  });

  handle.section.lines({});
  await sched.flush();
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#10 A issue']);
  assert.equal(landed, 1);

  // A stale frame queues the one TTL refresh it is allowed to queue.
  clock += 200;
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'a stale frame queues one refresh');

  handle.invalidate();

  assert.equal(handle.snapshot(), null, 'invalidate drops the snapshot');
  assert.deepEqual(handle.section.lines({}), [{ label: 'loading…', tone: 'dim' }],
    'the rail falls back to the loading row, never the previous repository\'s rows');
  assert.equal(handle.section.meta({}), undefined, 'the heading counts nothing after a supersede');
  assert.equal(sched.pending(), 2,
    'invalidate clears the scheduled flag, so the next frame queues its own refresh');
  assert.equal(loads, 1, 'invalidate starts no read of its own');
  assert.equal(landed, 1, 'invalidate never repaints');

  // The read that was in flight when the session switched settles afterwards:
  // its answer is discarded by the bumped token instead of being applied.
  const late = [];
  let lateLoads = 0;
  let lateLanded = 0;
  const inflightHandle = createIssuesSection({
    load: () => {
      lateLoads += 1;
      return new Promise((resolve) => { late.push(resolve); });
    },
    open: () => {},
    schedule: () => {},
    onRefreshed: () => { lateLanded += 1; },
  });
  const ready = inflightHandle.refresh();
  late[0]({
    ok: true,
    identity: 'github.com/myfork/repo-a',
    mine: [issue(30, 'A thirty', '2024-01-01T00:00:00Z')],
    assigned: [],
  });
  await ready;
  assert.deepEqual(inflightHandle.section.lines({}).map((row) => row.label), ['#30 A thirty']);
  assert.equal(lateLanded, 1);

  const inFlight = inflightHandle.refresh();
  inflightHandle.invalidate();
  assert.deepEqual(inflightHandle.section.lines({}), [{ label: 'loading…', tone: 'dim' }]);

  late[1]({
    ok: true,
    identity: 'github.com/myfork/repo-a',
    mine: [issue(31, 'A thirty-one', '2024-01-01T00:00:00Z')],
    assigned: [],
  });
  await inFlight;
  assert.equal(inflightHandle.snapshot(), null, 'the in-flight answer never lands after invalidate');
  assert.deepEqual(inflightHandle.section.lines({}), [{ label: 'loading…', tone: 'dim' }],
    'the previous repository\'s late rows never paint');
  assert.equal(lateLanded, 1, 'a discarded answer never repaints');
  assert.equal(lateLoads, 2, 'invalidate itself read nothing');

  // After `dispose()` the drop is a no-op: the disposed module keeps answering
  // the snapshot it was left with, and nothing throws.
  const disposedHandle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: 'github.com/myfork/repo-a',
      mine: [issue(40, 'Ready', '2024-01-01T00:00:00Z')],
      assigned: [],
    }),
    open: () => {},
    schedule: () => {},
  });
  await disposedHandle.refresh();
  disposedHandle.dispose();
  assert.doesNotThrow(() => disposedHandle.invalidate(), 'invalidate never throws');
  assert.deepEqual(disposedHandle.section.lines({}).map((row) => row.label), ['#40 Ready'],
    'invalidate after dispose changes nothing');
});

// T7 (S3 amended): the activity floor. Because a frame only exists when the
// host has a reason to produce one, the TTL alone never fires on a session that
// is merely in use. The caller asks for a read on its own events; the module
// decides whether one is due.
test('S3: refreshIfStale reads an absent or aged snapshot and nothing else', async () => {
  let clock = 1000;
  let loads = 0;
  const handle = createIssuesSection({
    load: async () => {
      loads += 1;
      return {
        ok: true,
        identity: 'github.com/myfork/project',
        mine: [issue(5, 'Five', '2024-01-01T00:00:00Z')],
        assigned: [],
      };
    },
    open: () => {},
    schedule: () => {},
    now: () => clock,
  });

  // An absent snapshot: the activity trigger starts ONE read.
  assert.equal(handle.refreshIfStale(30000), true, 'an absent snapshot starts a read');
  await waitFor(() => handle.snapshot() !== null, 'the activity read never landed');
  assert.equal(loads, 1);
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#5 Five']);

  // Fresher than the floor, and just under it: nothing starts.
  assert.equal(handle.refreshIfStale(30000), false, 'a snapshot fresher than the floor starts nothing');
  clock += 29999;
  assert.equal(handle.refreshIfStale(30000), false, 'an age below the floor starts nothing');
  assert.equal(loads, 1);

  // At the floor exactly: one more read.
  clock += 1;
  assert.equal(handle.refreshIfStale(30000), true, 'an age at the floor starts one read');
  await waitFor(() => loads === 2 && handle.snapshot().at === clock, 'the second activity read never landed');
  assert.equal(handle.refreshIfStale(30000), false, 'the landed snapshot is fresh again');

  // A read already in flight is never doubled.
  let inFlightLoads = 0;
  const inFlight = createIssuesSection({
    load: () => {
      inFlightLoads += 1;
      return new Promise(() => {});
    },
    open: () => {},
    schedule: () => {},
  });
  assert.equal(inFlight.refreshIfStale(30000), true, 'the first activity read starts');
  assert.equal(inFlight.refreshIfStale(30000), false, 'a read already in flight is never doubled');
  assert.equal(inFlightLoads, 1);

  // After dispose() nothing starts, however stale the snapshot would be, and
  // the seam never throws.
  let disposedLoads = 0;
  const disposedHandle = createIssuesSection({
    load: async () => {
      disposedLoads += 1;
      return { ok: true, identity: 'github.com/myfork/project', mine: [], assigned: [] };
    },
    open: () => {},
    schedule: () => {},
    now: () => clock,
  });
  await disposedHandle.refresh();
  disposedHandle.dispose();
  clock += 600000;
  assert.doesNotThrow(() => disposedHandle.refreshIfStale(30000), 'refreshIfStale never throws');
  assert.equal(disposedHandle.refreshIfStale(30000), false, 'a disposed section starts nothing');
  assert.equal(disposedLoads, 1, 'dispose stops the read, not the staleness');
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
    calls.push({ bin, argv: argv.slice(), env: { ...env }, cwd: runOpts && runOpts.cwd });
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

function hooksFor(hooks, event) {
  return hooks.filter(([name]) => name === event).map(([, handler]) => handler);
}

// Fire one host event's handlers in registration order, awaiting the async ones.
async function fireHook(hooks, event, ctx) {
  for (const handler of hooksFor(hooks, event)) {
    const out = handler({ toolResults: [] }, ctx);
    if (out && typeof out.then === 'function') await out;
  }
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

// S6: the supersede is synchronous. A session that starts in ANOTHER checkout
// drops the previous checkout's snapshot and stops trusting its in-flight read
// BEFORE the handler awaits the `gh` gate, so an answer that settles during that
// await is discarded instead of painting the previous repository's rows.
test("S6: a session starting in another checkout drops the previous checkout's answer", async () => {
  const checkoutA = makeCheckout([
    ['origin', 'git@github.com:myfork/project-a.git'],
    ['upstream', 'git@github.com:original/project-a.git'],
  ]);
  const checkoutB = makeCheckout([
    ['origin', 'git@github.com:myfork/project-b.git'],
    ['upstream', 'git@github.com:original/project-b.git'],
  ]);
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));

  // Every `gh issue list` call is HELD, so the test decides when each bucket
  // answers; the second checkout's gate probe (`gh api user`) is held too.
  const lists = [];
  const gates = [];
  ghIssues.setGhRunner((_bin, argv, runOpts = {}) => {
    const cwd = runOpts.cwd;
    const env = runOpts.env || {};
    if (argv[0] === 'api' && argv[1] === 'user') {
      if (cwd === checkoutB) return new Promise((resolve) => { gates.push(resolve); });
      return Promise.resolve(okJson('{"login":"me"}'));
    }
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return Promise.resolve(okJson(JSON.stringify({ nameWithOwner: 'myfork/ignored' })));
    }
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const at = argv.indexOf('--search');
      const entry = { cwd, search: at >= 0 ? argv[at + 1] : null, repo: env.GH_REPO, settle: null };
      const answer = new Promise((resolve) => {
        entry.settle = (payload) => resolve(okJson(JSON.stringify(payload)));
      });
      lists.push(entry);
      return answer;
    }
    return Promise.resolve(okJson(''));
  });

  const ctxA = { cwd: checkoutA, ui: { notify: () => {} } };
  const ctxB = { cwd: checkoutB, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctxA);
  assert.equal(registered.length, 1, 'exactly one section is registered');
  const section = registered[0];

  // The bridge's repaint is where the rail's next frame is observable, so what
  // it records is what the rail would have painted.
  const painted = [];
  globalThis[BRIDGE_SLOT].requestRepaint = () => {
    painted.push(section.lines(ctxB).map((row) => row.label));
  };

  await waitFor(() => lists.length === 2, 'the first checkout never read its buckets');
  assert.deepEqual(lists.map((entry) => entry.repo), [
    'github.com/myfork/project-a',
    'github.com/myfork/project-a',
  ], 'the first session reads its own checkout');

  // The session moves to the second checkout. Its handler is fired without
  // awaiting: it holds on the `gh` gate, which is the window the defect lived in.
  const bPending = [];
  for (const handler of sessionStartHandlers(loaded.hooks)) {
    try {
      bPending.push(Promise.resolve(handler({}, ctxB)));
    } catch (err) {
      bPending.push(Promise.reject(err));
    }
  }
  await waitFor(() => gates.length === 1, 'the second session never reached its gh gate');

  // The first checkout's two answers settle NOW — before the second session's
  // gate has answered. They belong to a superseded session and are dropped.
  lists.find((entry) => entry.repo === 'github.com/myfork/project-a' && /author:@me/.test(entry.search))
    .settle([{ number: 10, title: 'A mine', state: 'OPEN', updatedAt: '2024-01-01T00:00:00Z' }]);
  lists.find((entry) => entry.repo === 'github.com/myfork/project-a' && /assignee:@me/.test(entry.search))
    .settle([{ number: 11, title: 'A assigned', state: 'OPEN', updatedAt: '2024-02-01T00:00:00Z' }]);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(gates.length, 1, 'the second session is still waiting on its gh gate');
  assert.deepEqual(painted, [], 'nothing from the previous checkout ever repaints the rail');
  const during = section.lines(ctxB).map((row) => row.label);
  assert.ok(
    !during.some((label) => label.includes('A mine') || label.includes('A assigned')),
    `the previous checkout's rows never paint (saw ${JSON.stringify(during)})`,
  );

  // Only now does the gate answer, and the second session reads its own buckets.
  gates[0](okJson('{"login":"me"}'));
  await Promise.all(bPending);
  await waitFor(() => lists.length === 4, "the second checkout's owns reads never ran");
  const bLists = lists.slice(2);
  assert.deepEqual(bLists.map((entry) => entry.repo), [
    'github.com/myfork/project-b',
    'github.com/myfork/project-b',
  ], "the second session's reads carry its own pinned identity");

  bLists.find((entry) => /author:@me/.test(entry.search))
    .settle([{ number: 21, title: 'B mine', state: 'OPEN', updatedAt: '2024-03-01T00:00:00Z' }]);
  bLists.find((entry) => /assignee:@me/.test(entry.search)).settle([]);
  await waitFor(
    () => section.lines(ctxB).some((row) => row.label === '#21 B mine'),
    "the second checkout's rows never painted",
  );
  assert.ok(painted.some((labels) => labels.includes('#21 B mine')), 'the landed read repaints the rail');
  assert.equal(lists.length, 4, 'no extra read ran');
  assert.ok(
    !painted.some((labels) => labels.includes('#10 A mine') || labels.includes('#11 A assigned')),
    "the previous checkout's rows never painted a frame",
  );
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

// ---------------------------------------------------------------------------
// T7 (S3 amended): the activity floor in the extension. A frame only exists
// when the host has a reason to produce one (the bridge ships no timer), so the
// 60 s TTL on a drawn frame never fires in a session that is merely in use: a
// live session showed `no open issues` for minutes while three issues existed,
// and corrected itself only when the human sent a message. The session's own
// events (`before_agent_start`, `turn_end`) ask for a read behind a 30 s floor.
// ---------------------------------------------------------------------------

test("S3: the activity after a reload reads the session's own checkout", async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    mine: [{ number: 11, title: 'Mine one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    assigned: [{ number: 12, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);

  assert.equal(registered.length, 1);
  const section = registered[0];
  // The state `/reload` leaves: a section registered with no session context
  // and no snapshot, because a reload fires no `session_start`. `meta()` never
  // schedules, so asking it first does not create the very read under test.
  assert.equal(section.meta({}), undefined, 'a reload leaves the section with no snapshot');

  // The next activity carries the session's own context and must adopt it
  // BEFORE it asks for a read.
  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireHook(loaded.hooks, 'before_agent_start', ctx);

  const rows = await waitForRows(section, ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#12 Assigned one', '#11 Mine one'],
    'the section shows the reloaded session\'s rows');

  const lists = gh.calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
  assert.equal(lists.length, 2, 'one read per bucket');
  for (const call of lists) {
    assert.equal(call.env.GH_REPO, 'github.com/myfork/project',
      "the read is bound to the session's own checkout, not the host process's cwd");
    assert.equal(call.cwd, checkout, 'the read runs in the session\'s own checkout');
  }
  const searches = lists.map((call) => {
    const at = call.argv.indexOf('--search');
    return at >= 0 ? call.argv[at + 1] : null;
  });
  assert.deepEqual(searches.slice().sort(), [
    'assignee:@me sort:updated-desc',
    'author:@me sort:updated-desc',
  ]);
});

test('S3: session_shutdown drops the ended rows and clears the session context', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  // Two different answers, so what a frame paints tells the test WHICH context
  // its read used: the ended checkout's identity, or the one of whatever cwd
  // the host process happens to have once the session context is gone.
  const calls = [];
  ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
    const env = runOpts.env || {};
    calls.push({ argv: argv.slice(), env: { ...env }, cwd: runOpts.cwd });
    if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return okJson(JSON.stringify({ nameWithOwner: 'original/project' }));
    }
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const at = argv.indexOf('--search');
      const search = at >= 0 ? argv[at + 1] : '';
      if (!/author:@me/.test(search)) return okJson('[]');
      const mine = env.GH_REPO === 'github.com/myfork/project'
        ? { number: 11, title: 'Mine one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }
        : { number: 77, title: 'Host process repo', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' };
      return okJson(JSON.stringify([mine]));
    }
    return okJson('');
  });

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#11 Mine one'], 'the session drew its own rows first');

  await fireHook(loaded.hooks, 'session_shutdown', ctx);

  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    "the ended session's rows are gone, the rail falls back to the loading row");

  // A frame drawn after shutdown must not read with the ended session's cwd:
  // the remembered context is cleared, so nothing is bound to that checkout.
  const before = calls.length;
  section.lines(ctx);
  await waitFor(
    () => !(section.lines(ctx).length === 1 && section.lines(ctx)[0].label === 'loading…'),
    'the post-shutdown frame never settled',
  );
  const after = calls.slice(before);
  assert.ok(
    !after.some((call) => call.cwd === checkout || call.env.GH_REPO === 'github.com/myfork/project'),
    `no read after shutdown uses the dead session's context (saw ${JSON.stringify(after.map((call) => [call.argv[0], call.cwd, call.env.GH_REPO]))})`,
  );
  assert.ok(
    !section.lines(ctx).some((row) => row.label === '#11 Mine one'),
    "the ended session's rows never paint again",
  );
});

// ---------------------------------------------------------------------------
// T7 (S4/S6, verify round 3): the two lifecycle findings. A row the host keeps
// on screen outlives the checkout its snapshot belonged to, and a read that was
// in flight when the session ended outlives the session.
// ---------------------------------------------------------------------------

test('S4: a row retained across a checkout change opens the identity it was built from', async () => {
  const opened = [];
  const deferred = [];
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: () => new Promise((resolve) => { deferred.push(resolve); }),
    open: (number, identity) => { opened.push({ number, identity }); },
    schedule: sched.schedule,
  });

  // Repository A's snapshot, and the row object the rail was handed for it.
  const aRead = handle.refresh();
  deferred[0]({
    ok: true,
    identity: 'github.com/original/repo-a',
    mine: [issue(11, 'A eleven', '2024-01-01T00:00:00Z')],
    assigned: [],
  });
  await aRead;
  const rowA = handle.section.lines({})[0];
  assert.equal(rowA.label, '#11 A eleven');

  // The session moves: the snapshot is superseded and B's read lands.
  handle.invalidate();
  const bRead = handle.refresh();
  deferred[1]({
    ok: true,
    identity: 'github.com/original/repo-b',
    mine: [issue(11, 'B eleven', '2024-02-01T00:00:00Z')],
    assigned: [],
  });
  await bRead;
  assert.equal(handle.snapshot().identity, 'github.com/original/repo-b');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#11 B eleven']);

  // A retained frame is clicked AFTER B's rows replaced it on the rail.
  rowA.onClick();
  await sched.flush();
  assert.deepEqual(
    opened,
    [{ number: 11, identity: 'github.com/original/repo-a' }],
    "the retained row opens the repository it was read from, never the current snapshot's",
  );

  // An absent identity is passed through as it is: the opener, not the module,
  // decides that nothing opens instead of guessing a repository.
  const noIdentity = createIssuesSection({
    load: async () => ({
      ok: true,
      mine: [issue(12, 'No identity', '2024-01-01T00:00:00Z')],
      assigned: [],
    }),
    open: (number, identity) => { opened.push({ number, identity }); },
    schedule: sched.schedule,
  });
  await noIdentity.refresh();
  noIdentity.section.lines({})[0].onClick();
  await sched.flush();
  assert.deepEqual(opened[opened.length - 1], { number: 12, identity: null },
    'an absent identity reaches the opener unchanged');
});

test('S4: a row clicked after the session moved to another checkout still opens its own repository', async () => {
  const checkoutA = makeCheckout([
    ['origin', 'git@github.com:myfork/project-a.git'],
    ['upstream', 'git@github.com:original/project-a.git'],
  ]);
  const checkoutB = makeCheckout([
    ['origin', 'git@github.com:myfork/project-b.git'],
    ['upstream', 'git@github.com:original/project-b.git'],
  ]);
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  ghIssues.setGhRunner((_bin, argv, runOpts = {}) => {
    const env = runOpts.env || {};
    if (argv[0] === 'api' && argv[1] === 'user') return Promise.resolve(okJson('{"login":"me"}'));
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return Promise.resolve(okJson(JSON.stringify({ nameWithOwner: 'myfork/project-a' })));
    }
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const at = argv.indexOf('--search');
      const search = at >= 0 ? argv[at + 1] : '';
      const mine = [{
        number: 11,
        title: env.GH_REPO === 'github.com/myfork/project-a' ? 'A eleven' : 'B eleven',
        state: 'OPEN',
        updatedAt: '2024-01-01T00:00:00Z',
      }];
      return Promise.resolve(okJson(JSON.stringify(search.includes('author:@me') ? mine : [])));
    }
    return Promise.resolve(okJson(''));
  });

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
    const ctxA = { cwd: checkoutA, ui: { notify: () => {} } };
    const ctxB = { cwd: checkoutB, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctxA);
    assert.equal(registered.length, 1);
    const section = registered[0];
    await waitForRows(section, ctxA);
    const rowA = section.lines(ctxA)[0];
    assert.equal(rowA.label, '#11 A eleven');

    // The session moves to the second checkout, whose read lands after it.
    await fireSessionStart(loaded.hooks, ctxB);
    await waitFor(
      () => section.lines(ctxB).some((row) => row.label === '#11 B eleven'),
      "the second checkout's rows never painted",
    );

    // The host still holds A's frame, so this click happens after B's snapshot
    // landed — the exact window the finding lived in.
    rowA.onClick();
    await waitFor(() => opened.length > 0, 'the retained row never reached the browser opener');
  } finally {
    worktreeGit.runArgvAsync = original;
  }

  assert.equal(opened.length, 1, 'one click opens one issue');
  assert.deepEqual(opened[0].argv, ['issue', 'view', '11', '--web', '-R', 'github.com/myfork/project-a'],
    'the retained row opens its own repository, never the checkout the session moved to');
  assert.ok(!opened[0].argv.includes('github.com/myfork/project-b'),
    "never the new checkout's repository");
  assert.equal(opened[0].cwd, checkoutB,
    'the child still runs in the current checkout; -R, not the cwd, decides the repository');
});

test('S6: a read in flight at session_shutdown never repaints the rail', async () => {
  const checkout = makeCheckout();
  const { registered, repaints } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));

  // Both bucket reads are HELD, so the test decides when they settle.
  const lists = [];
  ghIssues.setGhRunner((_bin, argv) => {
    if (argv[0] === 'api' && argv[1] === 'user') return Promise.resolve(okJson('{"login":"me"}'));
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return Promise.resolve(okJson(JSON.stringify({ nameWithOwner: 'myfork/project' })));
    }
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const entry = { settle: null };
      entry.answer = new Promise((resolve) => {
        entry.settle = (payload) => resolve(okJson(JSON.stringify(payload)));
      });
      lists.push(entry);
      return entry.answer;
    }
    return Promise.resolve(okJson(''));
  });

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  await waitFor(() => lists.length === 2, 'the first read never reached gh');

  // The session ends while its read is still waiting on gh.
  await fireHook(loaded.hooks, 'session_shutdown', ctx);
  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    'shutdown drops the rows the ended session had');

  // The read that was in flight when the session ended settles now.
  for (const entry of lists) entry.settle([]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(repaints, [], 'a read that outlived the session never repaints the rail');
  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    'its answer lands nowhere: the section holds no rows');
});

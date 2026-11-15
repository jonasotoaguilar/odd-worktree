'use strict';
// T1/T2/T8/T9/T10/T11 (issues-sidebar S1-S7): the rail section and its wiring.
//
// Contract under test, through the public surface only:
// - ONE source (S1): the checkout repository's OPEN issues ASSIGNED to the
//   viewer. No authored bucket, no merge, no dedupe and no per-row relation:
//   every row is drawn in the host's `text` tone and carries NO `meta` — with a
//   single source a mark on every row would mark nothing — while the header
//   reports `<n> assigned`;
// - a row reads `#<number> <title>` sorted by `updatedAt` descending, and the
//   body paints at most SEVEN of them (S4); a read that produced more appends
//   ONE eighth, dim, clickable `and N more issues` row (`N+` when the read hit
//   its fetch bound) and a click on it dispatches `/issues`;
// - ONE combined GraphQL read (S9/T14) returns the rows AND their
//   pull-request cross-reference facts (`author:@me`, `assignee:@me` and
//   `involves:@me -author:@me` in one request), feeds a process cache and leaves
//   every failure to the section's own read state; a row whose issue has a pull
//   request wears the marker, one without carries no `meta`;
// - a failed refresh over an on-screen list keeps every row and reports
//   `<n> assigned · stale` (T10), while a failed first read is still one error
//   row;
// - a host with no bridge gets ONE warning per process naming
//   `pi install npm:gentle-shell-bridge` (T11), primary sessions only, after
//   the announcement window and never once the bridge announced;
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
// - the drawn section reads the checkout's own repository ONCE:
//   `checkoutRepoScope({cwd})` then ONE `gh issue list` search for the assigned
//   open issues, scoped to that pinned identity, and a failed resolution is the
//   error row with NO `gh` call;
// - a hidden section costs nothing (T13): `session_start` reads nothing at all,
//   `drawnWithin(window)` is false until `lines()`/`meta()` draws (and false
//   again after `invalidate()`/`dispose()`), and the session's own activity
//   (`before_agent_start`, `turn_end`) reads ONLY while it is true — behind the
//   same 30 s floor, which is what recovers a `/reload` (no `session_start`
//   fires) and what keeps an idle session free of calls;
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
// T11's "one warning per process" lives on a process-wide slot, so a test that
// expects the warning must not inherit another test's.
const WARNED_SLOT = Symbol.for('odd-worktree/issues-sidebar/install-warned');
const IDENTITY = 'github.com/myfork/project';

// The harness may ITSELF run inside an agent child (`GENTLE_PI_AGENTS_CHILD=1`),
// which is exactly the signal the missing-bridge warning respects, so these tests
// own it: cleared for the file, restored once at the end.
const savedChildEnv = process.env.GENTLE_PI_AGENTS_CHILD;
delete process.env.GENTLE_PI_AGENTS_CHILD;
after(() => {
  if (savedChildEnv === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
  else process.env.GENTLE_PI_AGENTS_CHILD = savedChildEnv;
});

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
  delete globalThis[WARNED_SLOT];
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

// `count` assigned issues, newest last in the array so a sorted paint is
// distinguishable from the read order.
function issueList(count) {
  return Array.from({ length: count }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return issue(index + 1, `Issue ${index + 1}`, `2024-01-${day}T00:00:00Z`);
  });
}

function readyLoad(issues, truncated = false) {
  return async () => ({ ok: true, identity: IDENTITY, issues, truncated });
}

// ---------------------------------------------------------------------------
// T1/T8: lib/issues-section.js, the pure module.
// ---------------------------------------------------------------------------

test('S1/S4: the assigned issues sort by updatedAt, read #<number> <title> and cap at seven', async () => {
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: readyLoad([
      issue(3, 'Older', '2024-01-01T00:00:00Z'),
      issue(1, 'Newest', '2024-04-01T00:00:00Z'),
      issue(2, 'Middle', '2024-03-01T00:00:00Z'),
    ]),
    open: () => {},
    openAll: () => {},
    schedule: sched.schedule,
  });
  handle.section.lines({});
  await sched.flush();

  const rows = handle.section.lines({});
  assert.deepEqual(rows.map((row) => row.label), ['#1 Newest', '#2 Middle', '#3 Older'],
    'rows sort by updatedAt descending, never by the order they were read in');
  assert.deepEqual(rows.map((row) => row.tone), ['text', 'text', 'text'],
    'every issue row is the host\'s plain text tone');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['label', 'onClick', 'tone'],
    'a row is its label, its tone and its click — nothing else');

  const snap = handle.snapshot();
  assert.deepEqual(Object.keys(snap).sort(),
    ['at', 'error', 'identity', 'issues', 'rows', 'status', 'truncated'],
    'the snapshot reports exactly what a caller can observe, with no bucket fields left');
  assert.equal(snap.status, 'ready');
  assert.equal(snap.identity, IDENTITY);
  assert.equal(snap.truncated, false);
  assert.equal(snap.issues.length, 3);
  assert.equal(snap.error, null);
  assert.equal(handle.snapshot().mine, undefined, 'no `mine` bucket survives');
  assert.equal(handle.snapshot().assigned, undefined, 'no `assigned` bucket survives');
});

test('S4: seven or fewer issues paint no overflow row at all', async () => {
  const seven = createIssuesSection({ load: readyLoad(issueList(7)), open: () => {}, openAll: () => {}, schedule: () => {} });
  await seven.refresh();
  const sevenRows = seven.section.lines({});
  assert.equal(sevenRows.length, 7, 'exactly seven issues fill the body on their own');
  assert.ok(sevenRows.every((row) => !/more issues$/.test(row.label)), 'no overflow row appears');

  const fewer = createIssuesSection({ load: readyLoad(issueList(2)), open: () => {}, openAll: () => {}, schedule: () => {} });
  await fewer.refresh();
  assert.deepEqual(fewer.section.lines({}).map((row) => row.label), ['#2 Issue 2', '#1 Issue 1'],
    'fewer than seven issues paint only their own rows');
});

test('S4: no issue row carries a meta — the header reports the count instead', async () => {
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  const rows = handle.section.lines({});
  for (const row of rows) {
    assert.equal('meta' in row, false, `no row carries a meta (saw ${JSON.stringify(row)})`);
  }
  assert.equal(handle.section.meta({}), '2 assigned', 'the heading names the one relation and its count');
});

test('S4: more than seven issues paint seven rows plus one dim, clickable overflow row', async () => {
  const opened = [];
  const openedAll = [];
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: readyLoad(issueList(9)),
    open: (number) => { opened.push(number); },
    openAll: () => { openedAll.push(1); },
    schedule: sched.schedule,
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  assert.equal(rows.length, 8, 'seven issue rows plus the one overflow row');
  assert.deepEqual(rows.slice(0, 7).map((row) => row.label),
    ['#9 Issue 9', '#8 Issue 8', '#7 Issue 7', '#6 Issue 6', '#5 Issue 5', '#4 Issue 4', '#3 Issue 3'],
    'the body keeps the seven most recently updated issues');
  assert.equal(rows[7].label, 'and 2 more issues');
  assert.equal(rows[7].tone, 'dim');
  assert.equal('meta' in rows[7], false, 'the overflow row carries no meta either');
  assert.equal(typeof rows[7].onClick, 'function');
  assert.equal(handle.section.meta({}), '9 assigned',
    'the header counts every issue read, before any display cap');

  rows[7].onClick();
  assert.deepEqual(openedAll, [], 'the overflow click never runs on the paint path');
  await sched.flush();
  assert.deepEqual(openedAll, [1], 'the overflow row opens the /issues panel exactly once');
  assert.deepEqual(opened, [], 'the overflow row opens the panel, never one issue');

  // The overflow seam classifies its outcome exactly like an issue row's click:
  // a resolved `{ ok: false }` is recorded, never thrown.
  const failingSched = manualSchedule();
  const failing = createIssuesSection({
    load: readyLoad(issueList(9)),
    open: () => {},
    openAll: () => Promise.resolve({ ok: false, error: 'cannot open the issues panel' }),
    schedule: failingSched.schedule,
  });
  await failing.refresh();
  failing.section.lines({})[7].onClick();
  await failingSched.flush();
  assert.equal(failing.snapshot().error, 'cannot open the issues panel',
    'a failed panel dispatch lands in the snapshot instead of escaping');
  assert.equal(failing.section.lines({}).length, 8, 'a dispatch failure never turns the list into an error row');
});

test('S4: a read that reached its fetch bound writes the overflow count with a +', async () => {
  const handle = createIssuesSection({
    load: readyLoad(issueList(20), true),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  const rows = handle.section.lines({});
  assert.equal(rows.length, 8);
  assert.equal(rows[7].label, 'and 13+ more issues',
    'the bound was reached, so the real total is larger than the rows counted here');
  assert.equal(rows[7].tone, 'dim');
  assert.equal(handle.section.meta({}), '20 assigned', 'the header reports the count it read');
});

// T9 (S4 amended, L8): the ONE marker left on a row is not about the relation:
// an issue that already has at least one pull request referencing it wears the
// Nerd Font pull-request glyph, and one without a pull request wears no meta at
// all. The fact is best effort — it arrives as `hasPullRequest` on the issue
// entry the read answered with — so it travels through the snapshot too and a
// decoration never changes a row's tone.
test('S4 (T9): an issue with a pull request carries the pull-request glyph, one without carries no meta', async () => {
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [
        { ...issue(4, 'Waits for a merge', '2024-02-01T00:00:00Z'), hasPullRequest: true },
        issue(3, 'Nobody opened a PR', '2024-01-01T00:00:00Z'),
      ],
      truncated: false,
    }),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  assert.deepEqual(rows.map((row) => row.label), ['#4 Waits for a merge', '#3 Nobody opened a PR']);
  assert.equal(rows[0].meta, '\ue726', 'the row whose issue has a pull request wears the glyph');
  assert.equal('meta' in rows[1], false, 'the row without one carries no meta at all');
  assert.deepEqual(rows.map((row) => row.tone), ['text', 'text'],
    'the marker never turns a row into an accent');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['label', 'meta', 'onClick', 'tone'],
    'the marker is the row\'s only extra field');

  const snap = handle.snapshot();
  assert.equal(snap.issues[0].hasPullRequest, true, 'the fact is observable on the snapshot');
  assert.equal(snap.issues[1].hasPullRequest, false,
    'an issue the decoration did not answer for reports the fact as false, never undefined');
  assert.equal(handle.section.meta({}), '2 assigned', 'the marker never changes the count');
});

test('S4 (T9): only a literal true marks a row — an ambiguous answer marks nothing', async () => {
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [
        { ...issue(6, 'Unknown', '2024-03-01T00:00:00Z'), hasPullRequest: 'yes' },
        { ...issue(5, 'One PR', '2024-02-01T00:00:00Z'), hasPullRequest: true },
      ],
      truncated: false,
    }),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  const rows = handle.section.lines({});
  assert.equal('meta' in rows[0], false, 'anything but a literal true is no marker');
  assert.equal(rows[1].meta, '\ue726');
  assert.equal(handle.snapshot().issues[0].hasPullRequest, false);
});

test('S3: a frame never waits, two stale frames schedule one refresh, and onRefreshed fires once per landing', async () => {
  // A read that never settles: the frame still answers immediately, twice, and
  // schedules exactly one refresh.
  const neverSched = manualSchedule();
  const never = createIssuesSection({
    load: () => new Promise(() => {}),
    open: () => {},
    openAll: () => {},
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
    load: readyLoad([]),
    open: () => {},
    openAll: () => {},
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
    load: readyLoad([issue(7, 'Click me', '2024-01-01T00:00:00Z')]),
    open: (number) => {
      opened.push(number);
      if (failure) throw failure;
    },
    openAll: () => {},
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
    load: readyLoad([issue(8, 'Async click', '2024-01-01T00:00:00Z')]),
    open: () => Promise.reject(new Error('async opener failed')),
    openAll: () => {},
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
    load: readyLoad([issue(9, 'Open fails', '2024-01-01T00:00:00Z')]),
    // The extension's real opener catches and RESOLVES this shape; it never
    // rejects.
    open: () => Promise.resolve({ ok: false, error: 'cannot open the issue in the browser' }),
    openAll: () => {},
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
      return { ok: true, identity: IDENTITY, issues: [], truncated: false };
    },
    open: () => {},
    openAll: () => {},
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
  assert.equal(handle.section.meta({}), '0 assigned');

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
    openAll: () => {},
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
    issues: [issue(20, 'B issue', '2024-02-01T00:00:00Z')],
    truncated: false,
  });
  await second;
  assert.equal(handle.snapshot().identity, 'github.com/myfork/repo-b');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#20 B issue']);
  assert.equal(handle.section.meta({}), '1 assigned');

  // A settles later: its rows are dropped, never applied over B's.
  deferred[0]({
    ok: true,
    identity: 'github.com/myfork/repo-a',
    issues: [issue(10, 'A issue', '2024-01-01T00:00:00Z')],
    truncated: false,
  });
  await first;
  assert.equal(handle.snapshot().identity, 'github.com/myfork/repo-b');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#20 B issue'],
    'the older answer never overwrites the newer one');
  assert.equal(handle.section.meta({}), '1 assigned',
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
        issues: [issue(10, 'A issue', '2024-01-01T00:00:00Z')],
        truncated: false,
      };
    },
    open: () => {},
    openAll: () => {},
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
    openAll: () => {},
    schedule: () => {},
    onRefreshed: () => { lateLanded += 1; },
  });
  const ready = inflightHandle.refresh();
  late[0]({
    ok: true,
    identity: 'github.com/myfork/repo-a',
    issues: [issue(30, 'A thirty', '2024-01-01T00:00:00Z')],
    truncated: false,
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
    issues: [issue(31, 'A thirty-one', '2024-01-01T00:00:00Z')],
    truncated: false,
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
    load: readyLoad([issue(40, 'Ready', '2024-01-01T00:00:00Z')]),
    open: () => {},
    openAll: () => {},
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
        identity: IDENTITY,
        issues: [issue(5, 'Five', '2024-01-01T00:00:00Z')],
        truncated: false,
      };
    },
    open: () => {},
    openAll: () => {},
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
    openAll: () => {},
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
      return { ok: true, identity: IDENTITY, issues: [], truncated: false };
    },
    open: () => {},
    openAll: () => {},
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

// T10 (S5 amended, L9): a failed refresh over a list that is already on screen
// is a transient stall (`gh` was killed by its 30 s bound, not an empty
// repository), so the rows stay exactly as they were and the failure is
// disclosed instead: `<n> assigned · stale`, `error` recording the reason and
// `status` a fourth value a caller can tell from `ready`.
test('S5 (T10): a failed refresh keeps every ready row and reports it stale', async () => {
  let clock = 1000;
  let answer = {
    ok: true,
    identity: IDENTITY,
    issues: [
      { ...issue(2, 'Has a pull request', '2024-02-01T00:00:00Z'), hasPullRequest: true },
      issue(1, 'Plain', '2024-01-01T00:00:00Z'),
    ],
    truncated: false,
  };
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => answer,
    open: () => {},
    openAll: () => {},
    schedule: sched.schedule,
    now: () => clock,
    ttlMs: 100,
  });

  await handle.refresh();
  const ready = handle.section.lines({});
  const successfulAt = handle.snapshot().at;
  assert.equal(handle.section.meta({}), '2 assigned');
  assert.equal(ready[0].meta, '\ue726', 'the marker is part of what is on screen');

  clock += 200;
  answer = { ok: false, error: 'gh timed out after 30000ms' };
  await handle.refresh();

  const stale = handle.snapshot();
  assert.equal(stale.status, 'stale', 'a fourth status tells the caller it is a stale list');
  assert.equal(stale.error, 'gh timed out after 30000ms', 'the reason is recorded for a caller');
  assert.equal(stale.at, successfulAt,
    'the age stays the last SUCCESSFUL read, which is what keeps the TTL retrying');
  assert.deepEqual(handle.section.lines({}), ready,
    'the rows stay exactly as they were: same rows, same order, same markers');
  assert.equal(handle.section.meta({}), '2 assigned · stale', 'the header discloses the stall');

  // A second failure changes nothing about the rows, and a success replaces the
  // stale list as it always did.
  clock += 200;
  await handle.refresh();
  assert.equal(handle.snapshot().status, 'stale');
  assert.deepEqual(handle.section.lines({}), ready, 'a repeated failure never drops a row');

  clock += 200;
  answer = {
    ok: true,
    identity: IDENTITY,
    issues: [issue(3, 'Back again', '2024-04-01T00:00:00Z')],
    truncated: false,
  };
  await handle.refresh();
  assert.equal(handle.snapshot().status, 'ready', 'the next success clears the stale state');
  assert.equal(handle.snapshot().error, null);
  assert.equal(handle.snapshot().at, clock, 'a success moves the age again');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#3 Back again']);
  assert.equal(handle.section.meta({}), '1 assigned', 'the stale suffix is gone with the stall');
});

test('S5 (T10): a failed first read is still ONE error row, and a success clears a stale list', async () => {
  let answer = { ok: false, error: 'cannot resolve this checkout\'s own repository' };
  const handle = createIssuesSection({
    load: async () => answer,
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });

  await handle.refresh();
  assert.equal(handle.snapshot().status, 'error');
  assert.deepEqual(handle.section.lines({}), [{
    label: "cannot resolve this checkout's own repository",
    tone: 'error',
  }], 'nothing was ever on screen, so the failure is still the one error row');
  assert.equal(handle.section.meta({}), undefined, 'an error row has no count and no stale suffix');

  answer = {
    ok: true,
    identity: IDENTITY,
    issues: [issue(8, 'Eight', '2024-05-01T00:00:00Z')],
    truncated: false,
  };
  await handle.refresh();
  assert.equal(handle.snapshot().status, 'ready');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#8 Eight']);

  answer = { ok: false, error: 'gh timed out after 30000ms' };
  await handle.refresh();
  assert.equal(handle.snapshot().status, 'stale');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#8 Eight'],
    'the row survives the stall that used to erase it');

  answer = { ok: true, identity: IDENTITY, issues: [], truncated: false };
  await handle.refresh();
  assert.equal(handle.snapshot().status, 'ready');
  assert.deepEqual(handle.section.lines({}), [{ label: 'no open issues', tone: 'dim' }],
    'a success after the stale list draws the empty state again');
  assert.equal(handle.section.meta({}), '0 assigned');
});

test('S5: loading, empty and error are rows, never a throw', async () => {
  const loading = createIssuesSection({
    load: readyLoad([]),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  assert.deepEqual(loading.section.lines({}), [{ label: 'loading…', tone: 'dim' }]);

  const empty = createIssuesSection({
    load: readyLoad([]),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await empty.refresh();
  assert.deepEqual(empty.section.lines({}), [{ label: 'no open issues', tone: 'dim' }]);

  const failed = createIssuesSection({
    load: async () => ({ ok: false, error: "cannot resolve this checkout's own repository" }),
    open: () => {},
    openAll: () => {},
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
    openAll: () => {},
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

// The one query a `gh api graphql` call sends, without gh's `query=` prefix.
function graphqlQueryOf(call) {
  const at = call.argv.indexOf('-f');
  if (at < 0 || at + 1 >= call.argv.length) return null;
  const raw = call.argv[at + 1];
  return raw.startsWith('query=') ? raw.slice('query='.length) : raw;
}

// A test row becomes the GraphQL node the combined read returns. A row may
// carry the whole node shape already; the row-level fields are the ones these
// tests speak in, and `hasPullRequest` becomes the cross-reference source the
// marker is derived from.
function graphqlNode(item) {
  const entry = item && typeof item === 'object' ? item : {};
  const timeline = entry.timelineItems && Array.isArray(entry.timelineItems.nodes)
    ? entry.timelineItems.nodes
    : (entry.hasPullRequest === true ? [{ source: { __typename: 'PullRequest' } }] : []);
  const labels = entry.labels && typeof entry.labels === 'object' && Array.isArray(entry.labels.nodes)
    ? entry.labels
    : { nodes: Array.isArray(entry.labels) ? entry.labels : [] };
  const comments = entry.comments && typeof entry.comments === 'object'
    ? entry.comments
    : { totalCount: Number.isInteger(entry.commentsCount) ? entry.commentsCount : 0 };
  return {
    number: entry.number,
    title: typeof entry.title === 'string' ? entry.title : '',
    state: typeof entry.state === 'string' ? entry.state : 'OPEN',
    stateReason: entry.stateReason === undefined ? '' : entry.stateReason,
    url: typeof entry.url === 'string' ? entry.url : '',
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    author: entry.author && typeof entry.author === 'object'
      ? entry.author
      : { login: typeof entry.author === 'string' ? entry.author : 'me' },
    labels,
    comments,
    reactionGroups: Array.isArray(entry.reactionGroups) ? entry.reactionGroups : [],
    timelineItems: { nodes: timeline },
  };
}

// The combined read's answer (`listRelatedIssues`): three aliased buckets, each
// with its exact issueCount and nodes. `counts` overrides a bucket's count to
// model an issue that left the result between two reads.
function relatedAnswer({ mine = [], assigned = [], involved = [], counts = {} } = {}) {
  const bucket = (key, rows) => ({
    issueCount: Number.isInteger(counts[key]) ? counts[key] : rows.length,
    nodes: rows.map(graphqlNode),
  });
  return {
    data: {
      mine: bucket('mine', mine),
      assigned: bucket('assigned', assigned),
      involved: bucket('involved', involved),
    },
  };
}

// gh's answers for the section: the identity probes plus the ONE combined
// GraphQL read. `repoView` is what gh's OWN resolution answers for the checkout.
function sectionGithub({ issues = [], mine = [], involved = [], counts = {}, repoView = 'original/project' } = {}) {
  const calls = [];
  const runner = async (bin, argv, runOpts) => {
    const env = (runOpts && runOpts.env) || {};
    calls.push({ bin, argv: argv.slice(), env: { ...env }, cwd: runOpts && runOpts.cwd });
    if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
    if (argv[0] === 'repo' && argv[1] === 'view') return okJson(JSON.stringify({ nameWithOwner: repoView }));
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      return okJson(JSON.stringify(relatedAnswer({ mine, assigned: issues, involved, counts })));
    }
    return okJson('');
  };
  return { runner, calls };
}

function graphqlCalls(calls) {
  return calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
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
// `waitForRows` poll draws the section until its own TTL read has landed
// (loading stops); only a drawn section reads, so the draw IS the trigger.
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

test("S6: session_start reads ONLY the assigned issues of the checkout's own repository", async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [
      { number: 11, title: 'Assigned older', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' },
      { number: 12, title: 'Assigned newer', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' },
    ],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);

  assert.deepEqual(rows.map((row) => row.label), ['#12 Assigned newer', '#11 Assigned older']);
  assert.ok(rows.every((row) => !('meta' in row)), 'no row reports a relation');
  assert.equal(section.meta(ctx), '2 assigned');

  const reads = graphqlCalls(gh.calls);
  assert.equal(reads.length, 1, 'exactly one gh call: the combined read, nothing else');
  assert.equal(reads[0].env.GH_REPO, 'github.com/myfork/project', 'the read carries the pinned identity');
  const query = graphqlQueryOf(reads[0]);
  for (const qualifier of ['author:@me', 'assignee:@me', 'involves:@me -author:@me']) {
    assert.ok(query.includes(`repo:myfork/project is:issue is:open ${qualifier} sort:updated-desc`),
      `the combined read carries ${qualifier}`);
  }
  assert.equal((query.match(/first: 100/g) || []).length, 3, 'the first sync reads 100 per bucket');
});

test('S4: nine assigned issues paint seven rows plus an overflow row that dispatches /issues once', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const sent = [];
  const loaded = await loadExtension({
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
  });
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: issueList(9).map((item, index) => ({
      number: 100 + index,
      title: item.title,
      state: 'OPEN',
      updatedAt: item.updatedAt,
    })),
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  await waitForRows(section, ctx);

  const rows = section.lines(ctx);
  assert.equal(rows.length, 8, 'seven issue rows plus the one overflow row');
  assert.equal(rows[7].label, 'and 2 more issues');
  assert.equal(rows[7].tone, 'dim');
  assert.equal('meta' in rows[7], false, 'the overflow row carries no meta');
  assert.equal(section.meta(ctx), '9 assigned', 'the header counts every issue read');
  assert.equal(graphqlCalls(gh.calls).length, 1, 'one read, never one per bucket');

  rows[7].onClick();
  assert.deepEqual(sent, [], 'the dispatch is deferred off the paint path');
  await waitFor(() => sent.length > 0, 'the overflow click never dispatched /issues');
  assert.deepEqual(sent, [{ text: '/issues', opts: { expandPromptTemplates: true } }],
    'the overflow row dispatches the /issues command exactly once');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1, 'one click is one dispatch');
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

  // Every combined read is HELD, so the test decides when each one answers; the
  // second checkout's gate probe (`gh api user`) is held too.
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
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const entry = { cwd, repo: env.GH_REPO, query: graphqlQueryOf({ argv }), settle: null };
      entry.answer = new Promise((resolve) => {
        entry.settle = (payload) => resolve(okJson(JSON.stringify(payload)));
      });
      lists.push(entry);
      return entry.answer;
    }
    return Promise.resolve(okJson(''));
  });

  const ctxA = { cwd: checkoutA, ui: { notify: () => {} } };
  const ctxB = { cwd: checkoutB, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctxA);
  assert.equal(registered.length, 1, 'exactly one section is registered');
  const section = registered[0];

  // T13 (S3 amended): `session_start` reads nothing — a hidden section costs
  // nothing — so the checkout's first read starts when the rail DRAWS the
  // section. This test rewrote its old `waitFor(lists.length === 1)` here for
  // exactly that reason.
  section.lines(ctxA);

  // The bridge's repaint is where the rail's next frame is observable, so what
  // it records is what the rail would have painted.
  const painted = [];
  globalThis[BRIDGE_SLOT].requestRepaint = () => {
    painted.push(section.lines(ctxB).map((row) => row.label));
  };

  await waitFor(() => lists.length === 1, 'the first checkout never read its issues');
  assert.deepEqual(lists.map((entry) => entry.repo), ['github.com/myfork/project-a'],
    'the first session reads its own checkout');
  assert.ok(lists[0].query.includes('assignee:@me'),
    'the one read carries the assigned search');

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

  // The first checkout's answer settles NOW — before the second session's gate
  // has answered. It belongs to a superseded session and is dropped.
  lists[0].settle(relatedAnswer({ assigned: [{ number: 10, title: 'A ten', state: 'OPEN', updatedAt: '2024-01-01T00:00:00Z' }] }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(gates.length, 1, 'the second session is still waiting on its gh gate');
  assert.deepEqual(painted, [], 'nothing from the previous checkout ever repaints the rail');
  const during = section.lines(ctxB).map((row) => row.label);
  assert.ok(
    !during.some((label) => label.includes('A ten')),
    `the previous checkout's rows never paint (saw ${JSON.stringify(during)})`,
  );

  // Only now does the gate answer, and the second session reads its own issues.
  gates[0](okJson('{"login":"me"}'));
  await Promise.all(bPending);
  const bList = () => lists.find((entry) => entry.cwd === checkoutB);
  await waitFor(() => bList() !== undefined, "the second checkout's own read never ran");
  assert.equal(bList().repo, 'github.com/myfork/project-b',
    "the second session's read carries its own pinned identity");

  bList().settle(relatedAnswer({ assigned: [{ number: 21, title: 'B twenty-one', state: 'OPEN', updatedAt: '2024-03-01T00:00:00Z' }] }));
  await waitFor(
    () => section.lines(ctxB).some((row) => row.label === '#21 B twenty-one'),
    "the second checkout's rows never painted",
  );
  assert.ok(painted.some((labels) => labels.includes('#21 B twenty-one')), 'the landed read repaints the rail');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lists.length, 2, 'no extra read ran');
  assert.ok(
    !painted.some((labels) => labels.includes('#10 A ten')),
    "the previous checkout's rows never painted a frame",
  );
});

test('S4 (T9): the ONE combined read supplies both the rows and their pull-request markers', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const calls = [];
  ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
    const env = runOpts.env || {};
    calls.push({ argv: argv.slice(), env: { ...env }, cwd: runOpts.cwd });
    if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return okJson(JSON.stringify({ nameWithOwner: 'original/project' }));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      return okJson(JSON.stringify(relatedAnswer({
        assigned: [
          { number: 11, title: 'Has a PR', updatedAt: '2024-05-01T00:00:00Z', hasPullRequest: true },
          { number: 12, title: 'No PR', updatedAt: '2024-06-01T00:00:00Z' },
          { number: 13, title: 'Two PRs', updatedAt: '2024-07-01T00:00:00Z', timelineItems: { nodes: [
            { source: { __typename: 'Issue' } },
            { source: { __typename: 'PullRequest' } },
          ] } },
        ],
      })));
    }
    return okJson('');
  });

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  await waitForRows(section, ctx);

  const rows = section.lines(ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#13 Two PRs', '#12 No PR', '#11 Has a PR']);
  assert.equal(rows[0].meta, '\ue726', 'two pull requests mark the row exactly like one');
  assert.equal('meta' in rows[1], false, 'an issue no pull request references carries no marker');
  assert.equal(rows[2].meta, '\ue726');
  assert.deepEqual(rows.map((row) => row.tone), ['text', 'text', 'text'],
    'the marker never turns a row into an accent');
  assert.equal(section.meta(ctx), '3 assigned', 'the marker never changes the count');

  // T14: the marker read T9 introduced is gone — the same read that returns the
  // rows returns their cross-reference facts, so there is no second call.
  const graphql = graphqlCalls(calls);
  assert.equal(graphql.length, 1, 'exactly one GraphQL read serves every row and its marker');
  assert.equal(graphql[0].env.GH_REPO, 'github.com/myfork/project',
    'the read carries the identity the checkout already proved');
  assert.equal(calls.some((call) => call.argv[0] === 'issue' && call.argv[1] === 'list'), false,
    'no separate list read remains');
  const query = graphqlQueryOf(graphql[0]);
  assert.ok(query !== null, 'the read sends one query argument');
  assert.equal((query.match(/first: 100/g) || []).length, 3, 'the first sync reads 100 per bucket');
  for (const qualifier of ['author:@me', 'assignee:@me', 'involves:@me -author:@me']) {
    assert.ok(query.includes(`repo:myfork/project is:issue is:open ${qualifier} sort:updated-desc`),
      `the combined read carries ${qualifier}`);
  }
  assert.ok(query.includes('timelineItems(first: 10, itemTypes: [CROSS_REFERENCED_EVENT])'),
    'the marker selection rides each row');
});

// T14 rewrote this test: its old premise — a separate marker read that fails
// while the list read succeeds — no longer exists. The decoration is still best
// effort in the only way it can be now: a row whose node carries no
// cross-referenced pull request simply has no marker, and the section stays
// ready. A failed combined read is the section's own read failure (S5/T10).
test('S4 (T9): a row without a cross-referenced pull request carries no marker and the section stays ready', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [
      { number: 11, title: 'Has a PR', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z', hasPullRequest: true },
      { number: 12, title: 'No PR', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' },
    ],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);

  assert.deepEqual(rows.map((row) => row.label), ['#12 No PR', '#11 Has a PR'],
    'the rows are the combined read\'s own');
  assert.equal('meta' in rows[0], false, 'the decoration is simply absent');
  assert.equal(rows[1].meta, '\ue726', 'the row with a pull request keeps its one marker');
  const meta = section.meta(ctx);
  assert.equal(meta, '2 assigned', 'the section stays ready, never stale');
  assert.ok(!String(meta).includes('stale'), 'a decoration never reports a stall');
});

// ---------------------------------------------------------------------------
// T11 (S2 amended, L10): a host without the bridge gets ONE warning per process,
// primary sessions only, naming the install command. An empty slot at
// `session_start` is "not yet" — the check waits the announcement window — while
// a host with no bus can never announce and is warned at once.
// ---------------------------------------------------------------------------

function warningTexts(notices) {
  return notices.filter((notice) => notice.level === 'warning').map((notice) => notice.text);
}

// The gate and the section's own read still have to answer: a T11 test fires a
// real `session_start`, so no child may ever reach the real `gh`.
async function bridgeWarnHarness({ events } = {}) {
  const checkout = makeCheckout();
  const loaded = await loadExtension(events ? { events } : {});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);
  const notices = [];
  const ctx = { cwd: checkout, ui: { notify: (text, level) => { notices.push({ text, level }); } } };
  return { loaded, checkout, notices, ctx };
}

test('S2 (T11): with no bridge and no bus, ONE warning names the install command', async () => {
  delete globalThis[BRIDGE_SLOT];
  const { loaded, notices, ctx } = await bridgeWarnHarness();

  await fireSessionStart(loaded.hooks, ctx);
  assert.deepEqual(warningTexts(notices), [
    'the issues rail needs the gentle-shell-bridge plugin: install it with pi install npm:gentle-shell-bridge',
  ], 'a host that can never announce is told at once, with the command');

  // One warning for the whole process: a second session start says nothing.
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(warningTexts(notices).length, 1, 'a second session_start never repeats the warning');

  // And neither does a `/reload`, which builds a new instance of the extension:
  // the human was already told, once, for this process.
  const reloaded = await bridgeWarnHarness();
  await fireSessionStart(reloaded.loaded.hooks, reloaded.ctx);
  assert.deepEqual(warningTexts(reloaded.notices), [], 'a reloaded extension stays silent');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(warningTexts(notices).length, 1);
});

test('S2 (T11): with a bus, a silent window warns once, and a late bridge cancels it', async () => {
  // A host whose bus stays silent: the warning only lands after the window.
  delete globalThis[BRIDGE_SLOT];
  const silent = await bridgeWarnHarness({ events: { on: () => () => {} } });
  const startedAt = Date.now();
  await fireSessionStart(silent.loaded.hooks, silent.ctx);
  assert.deepEqual(warningTexts(silent.notices), [],
    'an empty slot at session_start is "not yet", never "not installed"');
  await waitFor(
    () => warningTexts(silent.notices).length === 1,
    'the deferred check never warned',
  );
  assert.ok(Date.now() - startedAt >= 1000, 'the warning waits for the announcement window');
  assert.match(warningTexts(silent.notices)[0], /pi install npm:gentle-shell-bridge/,
    'the warning names the install command verbatim');

  // A bridge that announces inside the window cancels the warning entirely.
  delete globalThis[BRIDGE_SLOT];
  const subscriptions = [];
  const latched = await bridgeWarnHarness({
    events: { on: (event, handler) => { subscriptions.push({ event, handler }); return () => {}; } },
  });
  await fireSessionStart(latched.loaded.hooks, latched.ctx);
  assert.deepEqual(warningTexts(latched.notices), [], 'nothing is said before the window closes');
  assert.equal(subscriptions.length, 1, 'the section is subscribed to the ready announcement');
  subscriptions[0].handler();
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.deepEqual(warningTexts(latched.notices), [],
    'a late announcement cancels the warning the window would have produced');
});

test('S2 (T11): a published bridge and a child session are never warned about', async () => {
  // The bridge is installed: nothing is missing, so nothing is said, now or
  // after the window.
  const published = installBridge();
  const withBridge = await bridgeWarnHarness();
  await fireSessionStart(withBridge.loaded.hooks, withBridge.ctx);
  assert.equal(published.registered.length, 1, 'the section still registers');
  assert.deepEqual(warningTexts(withBridge.notices), [], 'an installed bridge is not a missing one');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(warningTexts(withBridge.notices), []);

  // A child session never speaks for the human: the prompt block's own child
  // signal is the test, and the warning stays silent.
  delete globalThis[BRIDGE_SLOT];
  const child = await bridgeWarnHarness();
  const saved = process.env.GENTLE_PI_AGENTS_CHILD;
  process.env.GENTLE_PI_AGENTS_CHILD = '1';
  try {
    await fireSessionStart(child.loaded.hooks, child.ctx);
  } finally {
    if (saved === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
    else process.env.GENTLE_PI_AGENTS_CHILD = saved;
  }
  assert.deepEqual(warningTexts(child.notices), [], 'a subagent never warns about a missing plugin');
});

// ---------------------------------------------------------------------------
// T4 (S4 amended): a single-remote checkout has NO scope identity to pin, so
// the identity the row opens and the identity the read uses is the one gh
// itself resolves, normalized host-qualified exactly as `/issues` does.
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
    issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
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
    assert.deepEqual(rows.map((row) => row.label), ['#11 Assigned one'],
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

test('S1/S6: a single-remote checkout reads only the assigned issues with the identity gh resolves', async () => {
  const checkout = makeCheckout([['origin', 'git@github.com:myfork/project.git']]);
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    repoView: 'myfork/project',
    issues: [
      { number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' },
      { number: 12, title: 'Assigned two', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' },
    ],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#12 Assigned two', '#11 Assigned one']);

  const reads = graphqlCalls(gh.calls);
  assert.equal(reads.length, 1, 'exactly one read');
  assert.equal(reads[0].env.GH_REPO, 'github.com/myfork/project',
    'the read carries the identity gh resolved for this checkout, host-qualified, so the list and the click agree');
  const query = graphqlQueryOf(reads[0]);
  assert.ok(query.includes('repo:myfork/project is:issue is:open assignee:@me sort:updated-desc'));
  assert.equal((query.match(/first: 100/g) || []).length, 3, 'the first sync reads 100 per bucket');
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
    issues: [
      { number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' },
      { number: 12, title: 'Assigned two', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' },
    ],
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
  assert.deepEqual(rows.map((row) => row.label), ['#12 Assigned two', '#11 Assigned one'],
    'the section shows the reloaded session\'s rows');

  const reads = graphqlCalls(gh.calls);
  assert.equal(reads.length, 1, 'exactly one read');
  assert.equal(reads[0].env.GH_REPO, 'github.com/myfork/project',
    "the read is bound to the session's own checkout, not the host process's cwd");
  assert.equal(reads[0].cwd, checkout, 'the read runs in the session\'s own checkout');
  const query = graphqlQueryOf(reads[0]);
  assert.ok(query.includes('repo:myfork/project is:issue is:open assignee:@me sort:updated-desc'),
    'the combined read carries the assigned search');
  assert.equal((query.match(/first: 100/g) || []).length, 3, 'the first sync reads 100 per bucket');
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
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const assigned = env.GH_REPO === 'github.com/myfork/project'
        ? { number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }
        : { number: 77, title: 'Host process repo', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' };
      return okJson(JSON.stringify(relatedAnswer({ assigned: [assigned] })));
    }
    return okJson('');
  });

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#11 Assigned one'], 'the session drew its own rows first');

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
    !section.lines(ctx).some((row) => row.label === '#11 Assigned one'),
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
    openAll: () => {},
    schedule: sched.schedule,
  });

  // Repository A's snapshot, and the row object the rail was handed for it.
  const aRead = handle.refresh();
  deferred[0]({
    ok: true,
    identity: 'github.com/original/repo-a',
    issues: [issue(11, 'A eleven', '2024-01-01T00:00:00Z')],
    truncated: false,
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
    issues: [issue(11, 'B eleven', '2024-02-01T00:00:00Z')],
    truncated: false,
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
    load: async () => ({ ok: true, issues: [issue(12, 'No identity', '2024-01-01T00:00:00Z')], truncated: false }),
    open: (number, identity) => { opened.push({ number, identity }); },
    openAll: () => {},
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
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const assigned = [{
        number: 11,
        title: env.GH_REPO === 'github.com/myfork/project-a' ? 'A eleven' : 'B eleven',
        state: 'OPEN',
        updatedAt: '2024-01-01T00:00:00Z',
      }];
      return Promise.resolve(okJson(JSON.stringify(relatedAnswer({ assigned }))));
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

  // The combined read is HELD, so the test decides when it settles.
  const lists = [];
  ghIssues.setGhRunner((_bin, argv) => {
    if (argv[0] === 'api' && argv[1] === 'user') return Promise.resolve(okJson('{"login":"me"}'));
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return Promise.resolve(okJson(JSON.stringify({ nameWithOwner: 'myfork/project' })));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
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
  // T13 (S3 amended): no read happens before a frame, so the section is DRAWN
  // here and its own TTL path is what reaches gh. This test rewrote its old
  // "the read never reached gh" wait, which assumed the removed eager read.
  section.lines(ctx);
  await waitFor(() => lists.length === 1, 'the drawn section never reached gh');

  // The session ends while its read is still waiting on gh.
  await fireHook(loaded.hooks, 'session_shutdown', ctx);
  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    'shutdown drops the rows the ended session had');

  // The read that was in flight when the session ended settles now.
  for (const entry of lists) entry.settle(relatedAnswer({ assigned: [] }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(repaints, [], 'a read that outlived the session never repaints the rail');
  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    'its answer lands nowhere: the section holds no rows');
});

// ---------------------------------------------------------------------------
// T13 (S3 amended, L11): a hidden section costs nothing — no child process, no
// network, no timer. The module records when it was last DRAWN (`lines()` and
// `meta()` are the drawing calls), answers `drawnWithin(window)`, and the
// extension reads on the session's own activity ONLY while that answer is true.
// ---------------------------------------------------------------------------

test('S3 (T13): drawnWithin is false until a frame is drawn, and only inside the window', async () => {
  let clock = 5000;
  let loads = 0;
  const handle = createIssuesSection({
    load: async () => {
      loads += 1;
      return { ok: true, identity: IDENTITY, issues: [], truncated: false };
    },
    open: () => {},
    openAll: () => {},
    schedule: () => {},
    now: () => clock,
  });

  assert.equal(typeof handle.drawnWithin, 'function',
    'the caller asks the section whether it was drawn instead of guessing');
  assert.equal(handle.drawnWithin(120000), false, 'a never-drawn section is not a drawn one');
  assert.equal(handle.drawnWithin(0), false, 'no window makes an undrawn section drawn');

  // The unchanged seam: an explicit caller may still ask for a read, drawn or
  // not. A landed read is a read, never a draw — only a frame says the section
  // is on screen.
  assert.equal(handle.refreshIfStale(30000), true,
    'refreshIfStale still reads an absent snapshot whether or not a frame was drawn');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loads, 1, 'the explicit seam made its one read');
  assert.equal(handle.snapshot().status, 'ready');
  assert.equal(handle.drawnWithin(120000), false, 'a landed read is not a drawn frame');

  // The collapsed header IS a drawing call: the host painted the section.
  handle.section.meta({});
  assert.equal(handle.drawnWithin(0), true, 'the collapsed header stamps the frame');

  clock += 120000;
  assert.equal(handle.drawnWithin(120000), true, 'the window includes its own edge');
  clock += 1;
  assert.equal(handle.drawnWithin(120000), false, 'a draw older than the window is outside it');

  handle.section.lines({});
  assert.equal(handle.drawnWithin(120000), true, 'the drawn body stamps it again');

  handle.invalidate();
  assert.equal(handle.drawnWithin(120000), false, 'a superseded section is not a drawn one');

  handle.section.lines({});
  assert.equal(handle.drawnWithin(120000), true, 'the next frame draws it again');

  handle.dispose();
  assert.equal(handle.drawnWithin(120000), false, 'a disposed section is never drawn');
});

test('S3 (T13): a hidden section makes no gh call, and the drawn window gates the activity hooks', async () => {
  // The extension builds the section with the module's default clock, so the
  // clock is offset BEFORE the extension loads (the default `now` captures the
  // `Date.now` it is handed) and the drawn window moves without adding, removing
  // or racing a real timer.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const gh = sectionGithub({
      issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    });
    ghIssues.setGhRunner(gh.runner);
    const ctx = { cwd: checkout, ui: { notify: () => {} } };

    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];

    // NO frame drawn: the session starts, an agent starts and a turn ends, and
    // the section reads nothing at all.
    await fireHook(loaded.hooks, 'before_agent_start', ctx);
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, 0, 'a hidden section makes no gh read at all');
    assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
      'a hidden section has no rows to show, because it was never read');

    // The section becomes visible: one frame is what starts its own read.
    await waitFor(() => graphqlCalls(gh.calls).length === 1, 'the drawn section never read its issues');
    const drawnRows = await waitForRows(section, ctx);
    assert.deepEqual(drawnRows.map((row) => row.label), ['#11 Assigned one'],
      'the drawn frame paints the read it started');
    assert.equal(graphqlCalls(gh.calls).length, 1, 'the drawn frame started exactly one combined read');

    // Drawn 31 s ago, inside the two-minute window: activity reads behind the
    // unchanged 30 s floor.
    offset = 31000;
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === 2,
      'a drawn section never read on the turn boundary');

    // The drawn window has passed: the same hooks read nothing at all.
    offset = 161000;
    const quiet = gh.calls.length;
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await fireHook(loaded.hooks, 'before_agent_start', ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(gh.calls.length, quiet, 'a section outside the drawn window makes no gh call');
    assert.equal(graphqlCalls(gh.calls).length, 2, 'and no combined read either');

    // Drawn again, the section works again: the frame's own TTL starts the read.
    section.lines(ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === 3, 'the redrawn section never read again');
  } finally {
    Date.now = realNow;
  }
});

test('S3 (T13): a session that shut down reads nothing on a later activity', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);
  const ctx = { cwd: checkout, ui: { notify: () => {} } };

  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  // The section is on screen and drew its rows.
  section.lines(ctx);
  await waitFor(() => graphqlCalls(gh.calls).length === 1, 'the drawn section never read its issues');
  await waitForRows(section, ctx);

  // Shutdown supersedes the drawn frame: the section is showing nothing, so the
  // next activity must not start a read.
  await fireHook(loaded.hooks, 'session_shutdown', ctx);
  const before = gh.calls.length;
  await fireHook(loaded.hooks, 'turn_end', ctx);
  await fireHook(loaded.hooks, 'before_agent_start', ctx);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(gh.calls.length, before, 'a shut-down session reads nothing on a later activity');
});

// ---------------------------------------------------------------------------
// T14 (S9): ONE combined read feeds a process-local cache of all three scoped
// views, and the rail keeps drawing only the assigned bucket. The wiring asks
// the cache for a plan BEFORE the read — 100 per bucket with no entry, the
// newest 20 afterwards — makes exactly ONE `gh` child per refresh, applies the
// answer and returns the cached assigned rows. A count mismatch (an issue closed
// or unassigned) makes the next refresh full; a failed read touches nothing, so
// the T10 stale list survives; a shutdown clears the cache.
// ---------------------------------------------------------------------------

test('S9 (T14): the first refresh reads 100 per bucket, the next reads 20 and merges them', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    const answers = [
      relatedAnswer({
        assigned: [
          { number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' },
          { number: 12, title: 'Twelve', updatedAt: '2024-02-01T00:00:00Z' },
        ],
      }),
      relatedAnswer({
        assigned: [
          { number: 12, title: 'Twelve (updated)', updatedAt: '2024-03-01T00:00:00Z' },
          { number: 13, title: 'Thirteen', updatedAt: '2024-04-01T00:00:00Z' },
        ],
        counts: { assigned: 3 },
      }),
    ];
    ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
      calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        return okJson(JSON.stringify(answers.shift()));
      }
      return okJson('');
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];
    const baseline = calls.length; // the session gate's own identity probes

    const firstRows = await waitForRows(section, ctx);
    assert.deepEqual(firstRows.map((row) => row.label), ['#12 Twelve', '#11 Eleven']);

    let reads = graphqlCalls(calls);
    assert.equal(reads.length, 1, 'one combined read serves the first refresh');
    assert.equal(calls.length, baseline + 1, 'exactly ONE gh child per refresh');
    let query = graphqlQueryOf(reads[0]);
    assert.equal((query.match(/first: 100/g) || []).length, 3, 'the first sync reads 100 per bucket');
    assert.equal(reads[0].env.GH_REPO, IDENTITY, 'the read carries the pinned identity');

    // The section's 60 s TTL starts the next frame's refresh; the cache is well
    // inside its ten-minute full-read window, so the read is the newest 20.
    offset = 61000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(calls).length === 2, 'the delta refresh never ran');
    await waitFor(
      () => section.lines(ctx).some((row) => row.label === '#13 Thirteen'),
      'the delta rows never merged with the cached ones',
    );

    reads = graphqlCalls(calls);
    assert.equal(calls.length, baseline + 2, 'one gh child per refresh, never more');
    query = graphqlQueryOf(reads[1]);
    assert.equal((query.match(/first: 20/g) || []).length, 3, 'later syncs read the newest 20 per bucket');
    assert.deepEqual(section.lines(ctx).map((row) => row.label),
      ['#13 Thirteen', '#12 Twelve (updated)', '#11 Eleven'],
      'the delta merged by number and kept the rows it did not mention');
  } finally {
    Date.now = realNow;
  }
});

test('S9 (T14): an issue that left the assigned set makes the next refresh a full read', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    const answers = [
      relatedAnswer({
        assigned: [
          { number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' },
          { number: 12, title: 'Twelve', updatedAt: '2024-02-01T00:00:00Z' },
        ],
      }),
      // Issue 11 was closed: the delta (the newest rows) cannot see it, so the
      // cached two rows no longer match the reported one.
      relatedAnswer({
        assigned: [{ number: 12, title: 'Twelve', updatedAt: '2024-03-01T00:00:00Z' }],
        counts: { assigned: 1 },
      }),
      // The next plan is a full read, which replaces the bucket.
      relatedAnswer({
        assigned: [{ number: 12, title: 'Twelve', updatedAt: '2024-03-01T00:00:00Z' }],
        counts: { assigned: 1 },
      }),
    ];
    ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
      calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        return okJson(JSON.stringify(answers.shift()));
      }
      return okJson('');
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    const section = registered[0];
    const firstRows = await waitForRows(section, ctx);
    assert.deepEqual(firstRows.map((row) => row.label), ['#12 Twelve', '#11 Eleven']);

    offset = 61000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(calls).length === 2, 'the delta refresh never ran');
    let query = graphqlQueryOf(graphqlCalls(calls)[1]);
    assert.equal((query.match(/first: 20/g) || []).length, 3, 'the mismatch-causing read is a delta');
    assert.deepEqual(section.lines(ctx).map((row) => row.label), ['#12 Twelve', '#11 Eleven'],
      'the merge cannot remove a row it did not see');

    offset = 122000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(calls).length === 3, 'the repair refresh never ran');
    query = graphqlQueryOf(graphqlCalls(calls)[2]);
    assert.equal((query.match(/first: 100/g) || []).length, 3,
      'the count mismatch made the NEXT plan a full read');
    await waitFor(
      () => section.lines(ctx).map((row) => row.label).join('|') === '#12 Twelve',
      'the full read never replaced the bucket',
    );
    assert.equal(section.meta(ctx), '1 assigned');
  } finally {
    Date.now = realNow;
  }
});

test('S9 (T14): a failed read keeps the cache and the section stale, so the next read is incremental', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    const answers = [
      relatedAnswer({
        assigned: [
          { number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' },
          { number: 12, title: 'Twelve', updatedAt: '2024-02-01T00:00:00Z' },
        ],
      }),
      null, // the stalled read
      relatedAnswer({
        assigned: [
          { number: 12, title: 'Twelve (updated)', updatedAt: '2024-03-01T00:00:00Z' },
          { number: 13, title: 'Thirteen', updatedAt: '2024-04-01T00:00:00Z' },
        ],
        counts: { assigned: 3 },
      }),
    ];
    ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
      calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const answer = answers.shift();
        if (answer === null) return { status: 1, stdout: '', stderr: 'HTTP 502: bad gateway', error: null };
        return okJson(JSON.stringify(answer));
      }
      return okJson('');
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    const section = registered[0];
    await waitForRows(section, ctx);
    assert.equal(section.meta(ctx), '2 assigned');

    offset = 61000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(calls).length === 2, 'the failing refresh never ran');
    await waitFor(() => String(section.meta(ctx)).includes('· stale'), 'the failure never reported stale');
    assert.deepEqual(section.lines(ctx).map((row) => row.label), ['#12 Twelve', '#11 Eleven'],
      'a failed read never erases the rows already on screen');

    // The cache's last SUCCESSFUL apply was two minutes ago, well inside the
    // ten-minute full-read window, so the recovery read is the newest 20 — the
    // failed read did not clear or invalidate the entry.
    offset = 122000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(calls).length === 3, 'the recovery refresh never ran');
    const query = graphqlQueryOf(graphqlCalls(calls)[2]);
    assert.equal((query.match(/first: 20/g) || []).length, 3,
      'a failed read leaves the cache intact, so the recovery stays incremental');
    await waitFor(
      () => section.lines(ctx).some((row) => row.label === '#13 Thirteen'),
      'the recovery read never merged',
    );
    assert.deepEqual(section.lines(ctx).map((row) => row.label),
      ['#13 Thirteen', '#12 Twelve (updated)', '#11 Eleven']);
  } finally {
    Date.now = realNow;
  }
});

test('S9 (T14): session_shutdown clears the cache, so the next session reads in full', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const calls = [];
  const answers = [
    relatedAnswer({
      assigned: [{ number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' }],
    }),
    relatedAnswer({
      assigned: [{ number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' }],
    }),
  ];
  ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
    calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
    if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      return okJson(JSON.stringify(answers.shift()));
    }
    return okJson('');
  });

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  const section = registered[0];
  await waitForRows(section, ctx);
  assert.equal((graphqlQueryOf(graphqlCalls(calls)[0]).match(/first: 100/g) || []).length, 3);

  await fireHook(loaded.hooks, 'session_shutdown', ctx);
  // A new session on the same checkout: without the clear, the recent entry
  // would answer a delta plan (`first: 20`) at once.
  await fireSessionStart(loaded.hooks, ctx);
  section.lines(ctx);
  await waitFor(() => graphqlCalls(calls).length === 2, 'the new session never read its issues');
  const query = graphqlQueryOf(graphqlCalls(calls)[1]);
  assert.equal((query.match(/first: 20/g) || []).length, 0, 'no delta plan survived the shutdown');
  assert.equal((query.match(/first: 100/g) || []).length, 3,
    'a cleared cache reads every bucket in full again');
});

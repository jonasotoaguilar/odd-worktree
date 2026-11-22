'use strict';
// T1/T2/T8/T9/T10/T11 (issues-sidebar S1-S7): the rail section and its wiring.
//
// Contract under test, through the public surface only:
// - the rows are the UNION of the checkout repository's OPEN issues the viewer
//   authored and the ones they are assigned (S7/T8), merged and deduplicated by
//   number, ordered `updatedAt` descending, each row keeping the bucket it came
//   from so its click can ask for it — while the header reports the merged count
//   alone (`8 issues`, never `8 assigned`, and `8 issues · stale` while stalled);
//   the heading reads `GITHUB` and the count names its unit (S12/T10);
// - a row reads `#<number> <title>`, and the body paints at most SEVEN of them
//   (S4); a read that produced more appends ONE eighth, dim, clickable
//   `and N more issues` row (`N+` when the read hit its fetch bound) and a click
//   on it dispatches `/issues`;
// - ONE combined GraphQL read (S9/T14) returns the rows AND their
//   pull-request cross-reference facts (`author:@me`, `assignee:@me` and
//   `involves:@me -author:@me` in one request), feeds a process cache and leaves
//   every failure to the section's own read state; a row whose issue has a pull
//   request wears that pull request's NUMBER behind the glyph the human asked
//   for — `\ue726 #69` (S7/T5) — in the bridge's
//   right-hand `meta` column — painted `muted` by the bridge itself, which is
//   the gray the user asked for — and one without a pull request carries no
//   `meta`;
// - a failed refresh over an on-screen list keeps every row and reports
//   `<n> issues · stale` (T10), while a failed first read is still one error row —
//   except a session cwd that is not a repository (S12/T11), whose one line is
//   exactly `not a git repository` in the `dim` tone, never `error`;
// - a host with no bridge gets ONE warning per process naming
//   `pi install npm:gentle-shell-bridge` (T11), primary sessions only, after
//   the announcement window and never once the bridge announced;
// - `lines()`/`meta()` are synchronous frames over an in-process snapshot: a
//   never-settled read still answers, two stale frames schedule ONE refresh,
//   and `onRefreshed` fires once per landed refresh;
// - a row click defers `open(number, identity, bucket)` off the paint path,
//   exactly once, and a failing opener lands in the snapshot instead of escaping
//   the caller; the identity is the one the ROW was built from, so a row
//   retained across a checkout change opens the repository it was read from;
//   the click itself proves NOTHING (S9/T10): the panel proves its own identity
//   when it opens, and a host that cannot dispatch says so visibly;
// - a read still in flight at `session_shutdown` repaints nothing and lands
//   nowhere;
// - `refreshIfStale(maxAgeMs)` is the activity seam: one read for an absent or
//   aged snapshot, nothing for a fresh one, one in flight, or a disposed one;
// - the rail's SECOND read is the repository's pull requests (S4/S5, T4):
//   `loadPullRequests` answers `{ ok, mine, review }`, the header reads
//   `<n> issues · <m> pr` with `m` the distinct numbers in mine ∪ review (`<n>
//   issues` alone while that read is unavailable, `· stale` kept), the read
//   obeys the same TTL, the same self-scheduled floor and the same drawn window
//   as the issues read, never blocks a frame, and a failed read keeps the last
//   count. A row whose issue has a linked pull request sends its click to
//   `open(number, { pullRequest, pullRequestBucket })` — `review` beats `mine`,
//   and a pull request in neither is `all` — while every other row keeps the
//   four arguments it always had; DEFAULT_ROW_LABEL is `github` (S4),
// - the three states are rows (`loading…`, `no open issues`, ONE error row),
//   never a throw;
// - the extension reaches the rail ONLY through gentle-shell-bridge's
//   published object (read from its Symbol slot, never imported): present it
//   registers one section, absent it subscribes to the ready announcement
//   once and registers nothing;
// - the drawn section reads the checkout's own repository ONCE:
//   `checkoutRepoScope({cwd})` then ONE combined `gh api graphql` read of the
//   three scoped buckets, and a failed resolution is the error row with NO `gh`
//   call;
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

const { test, after, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LIB_DIR, loadExtension, stubbedSource, installDefaultBridge } = require('./fixtures/load-extension.js');
const { pathToFileURL } = require('node:url');
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

// T8 (S10): the drawn section now keeps a real, unref'd floor timer, and a test
// that ends while the section is still drawn would leave that timer to fire 20 s
// later — in a later test, with no runner of its own. The clock jumps ten minutes
// between tests, so every such timer finds the section OUTSIDE its drawn window
// and stops without reading (and without arming another one). Nothing else about
// the suite notices: every assertion measures a distance between two instants of
// the same test.
let suiteClockSkewMs = 0;
const realDateNow = Date.now;
Date.now = () => realDateNow() + suiteClockSkewMs;

afterEach(() => {
  delete globalThis[BRIDGE_SLOT];
  delete globalThis[WARNED_SLOT];
  suiteClockSkewMs += 10 * 60 * 1000;
  if (ghIssues) {
    ghIssues.setGhRunner(null);
    ghIssues.setGitRunner(null);
    ghIssues.setGhWhich(null);
  }
});

// S4 (T3): the read cache has a disk half, so every test starts from an EMPTY
// cache directory of its own: no test can inherit a warm identity from another
// (which would silently turn a full read into a delta), and nothing here ever
// touches a real `$XDG_CACHE_HOME` or home. A test that needs the directory to
// survive two loads names its own and restores this one.
beforeEach(() => {
  process.env.XDG_CACHE_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-cache-home-')));
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
  assert.equal(handle.section.meta({}), '2 issues', 'the heading names the one relation and its count');
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
  assert.equal(handle.section.meta({}), '9 issues',
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
  assert.equal(handle.section.meta({}), '20 issues', 'the header reports the count it read');
});

// T9 amended (S8): the mark is the pull request's NUMBER, not a glyph, and the
// bridge paints the right-hand `meta` column in its own `muted` role — that is
// the gray the user asked for, segment by segment. The row's `tone` stays
// `text`, so nothing paints the whole row gray to gray one mark.
test('S8 (T9): an issue whose pull request is #69 carries `#69`, one without a number carries no meta', async () => {
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [
        { ...issue(4, 'Waits for a merge', '2024-02-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 69 },
        { ...issue(3, 'Nobody opened a PR', '2024-01-01T00:00:00Z'), hasPullRequest: false, pullRequestNumber: null },
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
  assert.equal(rows[0].meta, '\ue726 #69', 'the row whose issue has a pull request carries its number');
  assert.equal('meta' in rows[1], false, 'the row without one carries no meta at all');
  assert.deepEqual(rows.map((row) => row.tone), ['text', 'text'],
    'the marker never turns the row gray: the bridge paints only the meta column muted');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['label', 'meta', 'onClick', 'tone'],
    'the marker is the row\'s only extra field');

  const snap = handle.snapshot();
  assert.equal(snap.issues[0].hasPullRequest, true, 'the fact is observable on the snapshot');
  assert.equal(snap.issues[0].pullRequestNumber, 69, 'so is the number the mark is drawn from');
  assert.equal(snap.issues[1].hasPullRequest, false,
    'an issue the decoration did not answer for reports the fact as false, never undefined');
  assert.equal(snap.issues[1].pullRequestNumber, null,
    'and no reference reports null instead of a number nobody opened');
  assert.equal(handle.section.meta({}), '2 issues', 'the marker never changes the count');
});

test('S8 (T9): only a positive integer number marks a row — anything else marks nothing', async () => {
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [
        { ...issue(6, 'Unknown', '2024-03-01T00:00:00Z'), hasPullRequest: 'yes', pullRequestNumber: 'yes' },
        { ...issue(5, 'One PR', '2024-02-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 70 },
        { ...issue(4, 'Zero', '2024-01-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 0 },
      ],
      truncated: false,
    }),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  const rows = handle.section.lines({});
  assert.equal('meta' in rows[0], false, 'anything but a positive integer is no mark');
  assert.equal(rows[1].meta, '\ue726 #70');
  assert.equal('meta' in rows[2], false, 'a zero is not a pull request number');
  assert.equal(handle.snapshot().issues[0].hasPullRequest, false);
  assert.equal(handle.snapshot().issues[0].pullRequestNumber, null);
});

// S7 (T5, issues-startup-performance): the mark the human asked for is the
// nerd-font pull-request glyph, ONE space, then `#` and the number —
// `\ue726 #69`. It still comes from the timeline the ONE combined read already
// carries (no per-issue call), it still names the LAST associated pull request,
// and a row whose issue has none still carries no mark at all (S6).
test('S7 (T5): a marked row reads `\\ue726 #69` — the glyph, one space, `#` and the number', async () => {
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [
        { ...issue(4, 'Newest pull request', '2024-03-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 71 },
        { ...issue(3, 'One pull request', '2024-02-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 69 },
        { ...issue(2, 'No pull request', '2024-01-01T00:00:00Z'), hasPullRequest: false, pullRequestNumber: null },
      ],
      truncated: false,
    }),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();

  const rows = handle.section.lines({});
  assert.equal(rows[0].meta, '\ue726 #71',
    'the glyph, one space, `#` and the number — the LAST associated pull request');
  assert.equal(rows[1].meta, '\ue726 #69', 'a single pull request wears the same mark');
  assert.equal('meta' in rows[2], false, 'a row whose issue has no pull request keeps no mark');
  assert.equal(rows[0].meta.codePointAt(0), 0xe726,
    'the glyph is U+E726, nf-dev-git_pull_request');
  assert.equal(rows[0].meta.length, '\ue726 #71'.length, 'exactly one glyph, one space and the number');
  assert.equal(rows[0].meta.slice(1), ' #71', 'the glyph is followed by ONE space, a `#` and the number');
  assert.equal(handle.section.meta({}), '3 issues', 'the mark never changes the count');
});

// T11 (S12): a checkout that is not a repository is its own state: ONE short
// line, in the gray tone the rail already has for secondary text, never the
// error red. The wording belongs to the rail alone; the command notices keep
// their own sentence.
test('S12 (T11): a checkout that is not a repository paints one dim line, never an error row', async () => {
  const handle = createIssuesSection({
    load: async () => ({ ok: false, error: 'not a git repository', errorTone: 'dim' }),
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });
  await handle.refresh();
  assert.deepEqual(handle.section.lines({}), [{ label: 'not a git repository', tone: 'dim' }],
    'one short gray line, with no path and no git advice');
  assert.equal(handle.section.meta({}), undefined, 'and no count to report');
});

// S3 (T2): outside a repository there is nothing to check, so the state is not a
// failure to retry. The line stays until a session boundary supersedes it: a
// frame, the activity seam and the TTL re-read nothing, so a session that is not
// in a checkout costs no child process and no timer however long it lives.
test('S3 (T2): a non-repository line is a state, so no frame and no activity retries it', async () => {
  let reads = 0;
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => {
      reads += 1;
      return { ok: false, error: 'not a git repository', errorTone: 'dim' };
    },
    open: () => {},
    openAll: () => {},
    schedule: sched.schedule,
    // A clock far past every window: nothing here is excused by being fresh.
    now: () => Date.now() + 3600000,
  });
  handle.section.lines({});
  await sched.flush();
  assert.deepEqual(handle.section.lines({}), [{ label: 'not a git repository', tone: 'dim' }]);
  assert.equal(reads, 1, 'the first read is the one that stated it');

  assert.equal(handle.refreshIfStale(0), false, 'the activity seam starts nothing');
  handle.section.lines({});
  handle.section.meta({});
  await sched.flush();
  assert.equal(reads, 1, 'no refresh: a non-repository session has nothing to check');

  // An EXPLICIT refresh is still the caller's own decision, exactly as before.
  await handle.refresh();
  assert.equal(reads, 2);
});

// S3/S13 (T2, T11): a `dim` state is a STATE, not a failure to retry — a cwd
// outside a repository is the one the section draws that way, and a `gh` that
// vanished after load reaches the same shape — so the floor timer a draw armed is
// dropped the moment the toned line lands, instead of surviving to its next fire
// only to find the state already settled. The line stays, and no later frame arms
// another one.
test('S3/S13 (T2, T11): a settled (dim) state owns no floor timer', async () => {
  const timers = [];
  let reads = 0;
  const handle = createIssuesSection({
    load: async () => {
      reads += 1;
      return { ok: false, error: 'nothing to read here', errorTone: 'dim' };
    },
    open: () => {},
    openAll: () => {},
    schedule: () => {},
    refreshFloorMs: 20000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  handle.section.lines({});
  assert.equal(timers.length, 1, 'the draw armed the one floor timer');
  await handle.refresh();
  assert.deepEqual(handle.section.lines({}), [{ label: 'nothing to read here', tone: 'dim' }]);
  assert.equal(reads, 1, 'the read that stated it is the only read');
  assert.equal(timers[0].cleared, true, 'the settled line cleared the timer the draw had armed');
  handle.section.lines({});
  handle.section.meta({});
  assert.equal(timers.length, 1, 'and a settled state arms no second timer');
});

// S7 (T8): the rows are one merged list, but each row remembers the bucket it
// came from, so its click can ask the panel for that bucket. The module never
// merges — the extension owns the read — it only carries the tag the read set.
test('S7 (T8): a row keeps its bucket, and its click hands it to the opener', async () => {
  const opened = [];
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [
        { ...issue(11, 'Mine eleven', '2024-02-01T00:00:00Z'), bucket: 'mine' },
        { ...issue(22, 'Assigned twenty-two', '2024-01-01T00:00:00Z'), bucket: 'assigned' },
      ],
      truncated: false,
    }),
    open: (number, identity, bucket) => { opened.push({ number, identity, bucket }); },
    openAll: () => {},
    schedule: sched.schedule,
  });
  await handle.refresh();
  const rows = handle.section.lines({});
  assert.deepEqual(rows.map((row) => row.label), ['#11 Mine eleven', '#22 Assigned twenty-two']);
  assert.deepEqual(handle.snapshot().issues.map((item) => item.bucket), ['mine', 'assigned'],
    'the merged rows keep the bucket each one came from');

  rows[0].onClick();
  await sched.flush();
  assert.deepEqual(opened, [{ number: 11, identity: IDENTITY, bucket: 'mine' }],
    'the click asks for the bucket the row was read from');
});

// S2 (issues-sidebar-click T1, correction): the caller's read answers with the
// generation it was taken under, and that opaque token rides the row into the
// `open` seam. The section never reads it — it is how the opener tells a row read
// by the session that is still running from one the host retained across a
// session boundary. A load that carries no generation hands `null`, so nothing
// depends on the field existing.
test('S2 (correction): the open seam carries the generation the row was read under', async () => {
  const sched = manualSchedule();
  const opened = [];
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      issues: [issue(11, 'Mine eleven', '2024-02-01T00:00:00Z')],
      truncated: false,
      generation: 7,
    }),
    open: (number, identity, bucket, generation) => { opened.push({ number, identity, bucket, generation }); },
    openAll: () => {},
    schedule: sched.schedule,
  });
  await handle.refresh();
  handle.section.lines({})[0].onClick();
  await sched.flush();
  assert.deepEqual(opened, [{ number: 11, identity: IDENTITY, bucket: undefined, generation: 7 }],
    'the click hands the opener the read\'s own generation, unchanged');

  const bare = [];
  const schedBare = manualSchedule();
  const noGeneration = createIssuesSection({
    load: readyLoad([issue(12, 'Mine twelve', '2024-02-01T00:00:00Z')]),
    // The two seams this case does not speak about are named `_` so a reader sees
    // that the SHAPE is the contract: only a bare opener proves what `generation`
    // is when the read carried none.
    open: (number, _identity, _bucket, generation) => { bare.push({ number, generation }); },
    openAll: () => {},
    schedule: schedBare.schedule,
  });
  await noGeneration.refresh();
  noGeneration.section.lines({})[0].onClick();
  await schedBare.flush();
  assert.deepEqual(bare, [{ number: 12, generation: null }],
    'a read that carries no generation hands `null`, never `undefined` or a clock of its own');
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
  assert.equal(handle.section.meta({}), '0 issues');

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
  assert.equal(handle.section.meta({}), '1 issues');

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
  assert.equal(handle.section.meta({}), '1 issues',
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
      { ...issue(2, 'Has a pull request', '2024-02-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 69 },
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
  assert.equal(handle.section.meta({}), '2 issues');
  assert.equal(ready[0].meta, '\ue726 #69', 'the marker is part of what is on screen');

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
  assert.equal(handle.section.meta({}), '2 issues · stale', 'the header discloses the stall');

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
  assert.equal(handle.section.meta({}), '1 issues', 'the stale suffix is gone with the stall');
});

// S12 (T10, issues-startup-performance): the rail's heading names the source —
// `GITHUB`, not `ISSUES` — and the right-hand count names its unit: `7 issues`,
// and `7 issues · stale` while the list is stalled. The number is still the one
// the last read produced, and no snapshot still means no count at all.
test('S12 (T10): the heading reads GITHUB and the count reads `7 issues`', async () => {
  let answer = { ok: true, identity: IDENTITY, issues: issueList(7), truncated: false };
  const handle = createIssuesSection({
    load: async () => answer,
    open: () => {},
    openAll: () => {},
    schedule: () => {},
  });

  assert.equal(handle.section.title, 'GITHUB', 'the heading names the source, not the subject');
  assert.equal(handle.section.meta({}), undefined, 'no snapshot still means no count at all');

  await handle.refresh();
  assert.equal(handle.section.meta({}), '7 issues', 'the count says what it counts');

  answer = { ok: false, error: 'gh timed out after 30000ms' };
  await handle.refresh();
  assert.equal(handle.snapshot().status, 'stale');
  assert.equal(handle.section.meta({}), '7 issues · stale', 'the stale suffix keeps its own wording');
  assert.equal(handle.section.lines({}).length, 7, 'and the seven rows stay on screen');
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
  assert.equal(handle.section.meta({}), '0 issues');
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
// T4 (S4, S5): the rail's second read — the checkout repository's pull requests.
//
// `loadPullRequests` is the seam T5 provides, shaped like
// `listRailPullRequests`: `{ ok, mine, review }`, each row a
// `{ number, linkedIssues }`. It decides exactly two things: the header's `pr`
// count (the DISTINCT numbers in mine ∪ review) and which PR panel a row's click
// opens. It is a read like the issues one — same TTL, same self-scheduled floor,
// same drawn window, never awaited by a frame — and a failed read keeps the last
// count, because a `gh` killed by its bound must never cost the human a number it
// already had.
// ---------------------------------------------------------------------------

// The two buckets as the seam answers them. A bare number is a row with no linked
// issues, which is what most of these tests need.
function railBuckets({ mine = [], review = [] } = {}) {
  const row = (entry) => (typeof entry === 'number' ? { number: entry, linkedIssues: [] } : entry);
  return { ok: true, mine: mine.map(row), review: review.map(row) };
}

function railPullRequests(buckets, onRead = null) {
  return async () => {
    if (onRead !== null) onRead();
    return railBuckets(buckets);
  };
}

// S4: `n issues · n pr` is the one header the human asked for, and `pr` counts
// the distinct numbers in the union of the two buckets the rail reads — a pull
// request that is both mine and awaiting my review is ONE pr.
test('S4 (T4): the header reads `n issues · m pr`, m the distinct pull requests in mine ∪ review', async () => {
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    loadPullRequests: railPullRequests({ mine: [69, 70], review: [70, 71] }),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();

  assert.equal(handle.section.meta({}), '2 issues · 3 pr',
    '70 is in both buckets and counts once');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#2 Issue 2', '#1 Issue 1'],
    'the pull-request count never changes a row');
  assert.equal(handle.section.rowLabel, 'github', 'S4 renames the customize row too');
});

// S4: the seam is optional. A caller that names none — every existing wiring —
// gets exactly the section it had: the bare issues count and the four click
// arguments.
test('S4 (T4, re-pinned): without the pull-request seam the header stays `n issues`', async () => {
  const opened = [];
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      generation: 7,
      truncated: false,
      issues: [{ ...issue(4, 'No pull requests at all', '2024-01-01T00:00:00Z'), bucket: 'assigned' }],
    }),
    open: (...args) => { opened.push(args); },
    openAll: () => {},
    schedule: sched.schedule,
  });
  await handle.refresh();
  assert.equal(handle.section.meta({}), '1 issues', 'no pull-request read, no `pr` segment');

  handle.section.lines({})[0].onClick();
  await sched.flush();
  assert.deepEqual(opened, [[4, IDENTITY, 'assigned', 7]],
    'the row without a linked pull request keeps the call it always made');
});

// S5: the read is never awaited. `lines()`/`meta()` stay synchronous over one
// snapshot, so a pull-request read still in flight leaves the header exactly as
// it was and the frame still answers.
test('S5 (T4): a frame never waits for the pull-request read', async () => {
  const pending = [];
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    loadPullRequests: () => new Promise((resolve) => pending.push(resolve)),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();

  assert.equal(handle.section.meta({}), '2 issues', 'a read still in flight adds no segment');
  assert.deepEqual(handle.section.lines({}).map((row) => row.label), ['#2 Issue 2', '#1 Issue 1'],
    'and the rows are drawn as usual');

  pending.shift()(railBuckets({ mine: [69] }));
  await settleFrames();
  assert.equal(handle.section.meta({}), '2 issues · 1 pr', 'the settled answer paints the count');
});

// S4: a failed pull-request read is a stall, never a lost number: the last count
// stays on screen (and so does the issues list's own `· stale`).
test('S4 (T4): a failed pull-request read keeps the last count, and `· stale` is kept', async () => {
  let prReads = 0;
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    loadPullRequests: async () => {
      prReads += 1;
      if (prReads === 1) return railBuckets({ mine: [69], review: [70] });
      return { ok: false, error: 'gh timed out' };
    },
    open: () => {},
    openAll: () => {},
    // `ttlMs: 0` makes every read stale, so the second refresh re-reads both.
    ttlMs: 0,
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();
  assert.equal(handle.section.meta({}), '2 issues · 2 pr');

  await handle.refresh();
  await settleFrames();
  assert.equal(prReads, 2, 'the second refresh asked again');
  assert.equal(handle.section.meta({}), '2 issues · 2 pr',
    'a failed pull-request read keeps the count it had instead of blanking the header');

  // And a failing ISSUES read still owns the `· stale` suffix, after the pr count.
  const failingIssues = createIssuesSection({
    load: (() => {
      let reads = 0;
      return async () => {
        reads += 1;
        if (reads === 1) return { ok: true, identity: IDENTITY, issues: issueList(2), truncated: false };
        return { ok: false, error: 'gh timed out' };
      };
    })(),
    loadPullRequests: railPullRequests({ mine: [69] }),
    open: () => {},
    openAll: () => {},
    ttlMs: 0,
    schedule: (fn) => { fn(); },
  });
  await failingIssues.refresh();
  await settleFrames();
  assert.equal(failingIssues.section.meta({}), '2 issues · 1 pr');
  await failingIssues.refresh();
  await settleFrames();
  assert.equal(failingIssues.section.meta({}), '2 issues · 1 pr · stale',
    'the stalled count keeps both numbers and says it is stale');
});

// S5: the click routing the human asked for. An issue that has a linked pull
// request opens the PR panel on THAT pull request, and only when the issue has
// none does the row keep the arguments it always passed.
test('S5 (T4): a row with a linked pull request opens the PR panel — review beats mine, neither is `all`', async () => {
  const opened = [];
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      generation: 7,
      truncated: false,
      issues: [
        { ...issue(63, 'Mine and awaiting review', '2024-04-01T00:00:00Z'), bucket: 'assigned', hasPullRequest: true, pullRequestNumber: 69 },
        { ...issue(64, 'Only mine', '2024-03-01T00:00:00Z'), bucket: 'assigned', hasPullRequest: true, pullRequestNumber: 70 },
        { ...issue(65, 'Neither bucket', '2024-02-01T00:00:00Z'), bucket: 'assigned', hasPullRequest: true, pullRequestNumber: 71 },
        { ...issue(66, 'No pull request', '2024-01-01T00:00:00Z'), bucket: 'assigned', hasPullRequest: false, pullRequestNumber: null },
      ],
    }),
    loadPullRequests: railPullRequests({ mine: [69, 70], review: [69] }),
    open: (...args) => { opened.push(args); },
    openAll: () => {},
    schedule: sched.schedule,
  });
  await handle.refresh();
  await sched.flush();

  const rows = handle.section.lines({});
  assert.equal(rows[0].meta, '\ue726 #69', 'the mark is untouched by the routing');
  for (const row of rows) row.onClick();
  await sched.flush();

  assert.deepEqual(opened, [
    [63, { pullRequest: 69, pullRequestBucket: 'review' }],
    [64, { pullRequest: 70, pullRequestBucket: 'mine' }],
    [65, { pullRequest: 71, pullRequestBucket: 'all' }],
    [66, IDENTITY, 'assigned', 7],
  ], 'a row with no linked pull request keeps the call it always made');
});

// S5: the routing is a fact of the read that is current WHEN THE CLICK RUNS, so
// a click on a retained row is answered by the buckets the rail holds now — a
// forced read (the caller knows something changed) moves the same row's
// destination.
test('S5 (T4): a click is routed by the buckets the rail holds when it runs', async () => {
  const opened = [];
  let prReads = 0;
  const sched = manualSchedule();
  const handle = createIssuesSection({
    load: async () => ({
      ok: true,
      identity: IDENTITY,
      truncated: false,
      issues: [{ ...issue(63, 'Linked', '2024-01-01T00:00:00Z'), hasPullRequest: true, pullRequestNumber: 69 }],
    }),
    loadPullRequests: async () => {
      prReads += 1;
      return prReads === 1 ? railBuckets({ mine: [69] }) : railBuckets({ review: [69] });
    },
    open: (...args) => { opened.push(args); },
    openAll: () => {},
    schedule: sched.schedule,
  });
  await handle.refresh();
  await sched.flush();

  handle.section.lines({})[0].onClick();
  await sched.flush();

  await handle.forceRefresh(0);
  await sched.flush();
  assert.equal(prReads, 2, 'the forced read asked for the pull requests again');
  handle.section.lines({})[0].onClick();
  await sched.flush();

  assert.deepEqual(opened, [
    [63, { pullRequest: 69, pullRequestBucket: 'mine' }],
    [63, { pullRequest: 69, pullRequestBucket: 'review' }],
  ], 'the same row routes to `mine` and then to `review` as the buckets move');
});

// S4/S5: the PR count is part of the snapshot a session boundary drops. A read
// from the previous session that settles afterwards paints nothing.
test('S4/S5 (T4): invalidate() drops the pull-request count, and a late answer lands nowhere', async () => {
  const pending = [];
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    loadPullRequests: () => new Promise((resolve) => pending.push(resolve)),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  handle.section.lines({});
  await settleFrames();
  assert.equal(pending.length, 1, 'the drawn frame started the pull-request read');

  handle.invalidate();
  assert.equal(handle.section.meta({}), undefined, 'the loading header claims neither count');

  pending.shift()(railBuckets({ mine: [69] }));
  await settleFrames();
  assert.equal(handle.section.meta({}), undefined,
    'the answer the superseded read delivers lands nowhere');
});

// S4/S5: outside a repository there is nothing to read, so the pull-request read
// is not started either — the same settled state the issues read reports.
test('S4/S5 (T4): a settled repository state starts no pull-request read at all', async () => {
  let prReads = 0;
  const timers = fakeTimerSeam();
  const handle = createIssuesSection({
    load: async () => ({ ok: false, error: 'not a git repository', errorTone: 'dim' }),
    loadPullRequests: async () => {
      prReads += 1;
      return railBuckets({ mine: [69] });
    },
    open: () => {},
    openAll: () => {},
    now: () => timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    refreshFloorMs: 20000,
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();
  handle.section.lines({});
  handle.section.meta({});
  await settleFrames();

  assert.equal(prReads, 0, 'a dim state costs no child, so it costs no pull-request read either');
  assert.equal(timers.armed.length, 0, 'and it keeps no floor timer');
  assert.equal(handle.section.meta({}), undefined);
});

// S4: the pull-request read obeys the SAME rules the issues read does: the frame
// TTL, the self-scheduled floor while the section is drawn, and the drawn window
// that stops it.
test('S4 (T4): the pull-request read follows the frame TTL, the floor and the drawn window', async () => {
  const timers = fakeTimerSeam();
  let issueReads = 0;
  let prReads = 0;
  const handle = createIssuesSection({
    load: async () => {
      issueReads += 1;
      return { ok: true, identity: IDENTITY, issues: [], truncated: false };
    },
    loadPullRequests: async () => {
      prReads += 1;
      return railBuckets({ mine: [69] });
    },
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
    now: () => timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    refreshFloorMs: 20000,
    timerDrawnWindowMs: 120000,
  });

  handle.section.lines({});
  await settleFrames();
  assert.equal(issueReads, 1);
  assert.equal(prReads, 1, 'the drawn frame made its own pull-request read');

  handle.section.lines({});
  handle.section.meta({});
  await settleFrames();
  assert.equal(prReads, 1, 'a fresh read is never repeated by a frame');

  timers.take();
  await settleFrames();
  assert.equal(prReads, 2, 'the floor reads the pull requests on its own, once per floor');

  // Nobody draws the section for longer than the drawn window: the timer stops
  // and reads nothing at all.
  timers.clock += 121000;
  timers.take();
  await settleFrames();
  assert.equal(prReads, 2, 'a section outside its drawn window reads nothing');
  assert.equal(timers.armed.length, 0, 'and keeps no timer');
});

// ---------------------------------------------------------------------------
// T2: the bridge wiring in extensions/odd-worktree-tools.ts.
// ---------------------------------------------------------------------------

function installBridge() {
  const registered = [];
  const repaints = [];
  // T18 (S11): every section registration's own disposer is observable, so a
  // replacement can be asserted to UNREGISTER the binding it replaces before the
  // new section is registered (the order the tear-down contract names).
  const released = [];
  globalThis[BRIDGE_SLOT] = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    registerRows: () => {},
    registerSection: (section) => {
      registered.push(section);
      return () => { released.push(section); };
    },
    createStore: () => ({}),
    requestRepaint: () => { repaints.push(1); },
  };
  return { registered, repaints, released };
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
// tests speak in, and `hasPullRequest`/`pullRequestNumber` become the
// cross-reference source the marker and its number are derived from.
function graphqlNode(item) {
  const entry = item && typeof item === 'object' ? item : {};
  const source = (number) => ({ source: { __typename: 'PullRequest', ...(Number.isInteger(number) ? { number } : {}) } });
  const timeline = entry.timelineItems && Array.isArray(entry.timelineItems.nodes)
    ? entry.timelineItems.nodes
    : (entry.hasPullRequest === true ? [source(entry.pullRequestNumber)] : []);
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

// D9 (S4): the rail's pull-request read is a GraphQL request of its own and is
// now issued as early as a cold start allows, so it is not one of the ISSUES
// reads these assertions order and count. It is told apart by the qualifier only
// it carries.
function graphqlCalls(calls) {
  return calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql'
    && !call.argv.join(' ').includes('is:pr'));
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

// Fire one host event with a SPECIFIC payload: `fireHook` sends the
// `turn_end`-shaped event, while a `tool_call`/`tool_result` handler must see the
// tool it rides on.
async function fireEvent(hooks, name, event, ctx) {
  for (const handler of hooksFor(hooks, name)) {
    const out = handler(event, ctx);
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

// D9 (S4): the rail's `· M pr` segment is a SECOND read, and it now lands as
// early as a cold start allows (a stored entry paints at once, the live answer
// follows). A test about the ISSUES count therefore asserts the part it is
// about: the issues number and the `· stale` mark stay exact, and whichever
// pull-request count the same header already carries is not what the test reads.
function issuesCount(text) {
  return String(text).replace(/ · \d+ pr/, '');
}

// S1/S2 (issues-startup-performance T1): the `gh` gate is DISPATCHED startup work
// now, not an awaited step of `session_start`, so it settles a moment after the
// host's handlers return. A test that counts `gh` children waits for that work to
// go quiet first, instead of racing it. `fireSessionStart` cannot wait for it here
// (the extension module the fixture imports is private to the fixture), so the
// observable — the injected runner's own call list — is what settles.
async function settleStartup(calls) {
  let seen = -1;
  for (let attempt = 0; attempt < 100 && seen !== calls.length; attempt += 1) {
    seen = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// S1/S2 (issues-startup-performance T1) / S10 (T8): quiet is NOT a barrier. The
// session gate is DISPATCHED startup work, so its two identity probes
// (`gh api user`, then `gh repo view`) land whenever the host gets to the probe —
// on a loaded CI runner that is long after `session_start` returned, and after any
// short quiet window a test uses to guess that startup went quiet. A test that
// counts `gh` children therefore counts the gate's probes as the rail's read: it
// is the `expected 1, actual 3` PR #89 reported, and the two extra children are
// the gate's, in the gate's own order (a destroyed rail read is not involved).
//
// The barrier is the gate's OWN coalescing seam. `probeIssuesGateStatus` asks the
// client one cached question — `cachedGhStatus({ cwd: checkoutRoot, scope: null })`
// — and the client holds one promise per repository while that question is in
// flight, so asking it here is either the same promise or the same cached answer.
// Once it answers, the gate's children have already landed (or never will: the
// gate finds the answer cached), and everything the injected runner records
// afterwards belongs to the surfaces the test itself drives.
async function awaitIssuesGateSettled(cwd) {
  if (!ghIssues || typeof ghIssues.cachedGhStatus !== 'function') return;
  try {
    await ghIssues.cachedGhStatus({ cwd, scope: null });
  } catch {
    // A gate that refuses its own probe is still settled: nothing else spawns.
  }
}

test('S2: a published bridge receives exactly one section with the decided identity', async () => {
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  assert.equal(registered.length, 1, 'exactly one section is registered');
  const section = registered[0];
  assert.equal(section.id, 'odd-worktree.issues');
  assert.equal(section.title, 'GITHUB');
  // S4 (T4, re-pinned): the customize row used to read `issues`; the human asked
  // for `github`, because the section now carries pull requests beside them.
  assert.equal(section.rowLabel, 'github');
  assert.equal(section.defaultVisible, true);
  // gentle-shell-bridge 0.13.0: the card is placed at the end of the rail, stated
  // rather than left to the bridge's default.
  assert.equal(section.placement, 'end');
  assert.equal(typeof section.lines, 'function');
  assert.equal(typeof section.meta, 'function');
  assert.equal(loaded.commands.has('issues'), true, 'every other surface still registers');
});

// RE-SCOPED (was "with no bridge and no events, nothing registers and nothing
// throws", which asserted that `/issues` and both worktree tools still registered
// without a bridge — the old policy, where only the bridge surfaces waited).
// S18 (T14, the human's "Desactivar todo el plugin"): with no bridge NOTHING of
// this package loads, not one command, tool, renderer, card or rail.
test('S18 (T14): with no bridge and no events, NOTHING registers and nothing throws', async () => {
  delete globalThis[BRIDGE_SLOT];
  const loaded = await loadExtension({}, { bridge: false });
  assert.deepEqual([...loaded.commands.keys()], [], 'no command at all');
  assert.deepEqual([...loaded.tools.keys()], [], 'no tool at all');
  assert.deepEqual([...loaded.messageRenderers.keys()], [], 'no message renderer');
  assert.deepEqual([...loaded.entryRenderers.keys()], [], 'no entry renderer');
  assert.deepEqual(loaded.hooks.map(([event]) => event), ['session_start'],
    'only the observer the missing-plugin notice needs');
});

// RE-SCOPED (was "with no bridge but events, the ready announcement is subscribed
// once", which also asserted `/issues` was registered). The subscription is still
// exactly one — it now carries the whole gate — and an announcement with no bridge
// on the slot still registers nothing.
test('S2/S18 (T14): with no bridge but events, the ready announcement is subscribed once and registers nothing yet', async () => {
  delete globalThis[BRIDGE_SLOT];
  const subscriptions = [];
  const loaded = await loadExtension({
    events: {
      on: (event, handler) => {
        subscriptions.push({ event, handler });
        return () => {};
      },
    },
  }, { bridge: false });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].event, 'gentle-shell-bridge:ready');
  assert.deepEqual([...loaded.commands.keys()], [], 'still nothing registered');
  subscriptions[0].handler();
  assert.equal(subscriptions.length, 1, 'a ready announcement is never a second subscription');
  assert.deepEqual([...loaded.commands.keys()], [], 'an announcement with no published bridge registers nothing');

  // The bridge publishes and the SAME subscription registers the surface, once.
  installBridge();
  subscriptions[0].handler();
  assert.equal(loaded.commands.has('issues'), true, 'the published bridge brings the command');
  assert.equal(loaded.tools.has('worktree_list'), true, 'and the tools');
  const counted = loaded.hooks.length;
  subscriptions[0].handler();
  assert.equal(loaded.hooks.length, counted, 'a second announcement registers nothing twice');
});

// S7 (T8): ONE combined read, and the rail draws the UNION of the two buckets the
// user named — the issues they authored and the ones they are assigned — merged
// by number, ordered by `updatedAt` descending, under the bare merged count.
test("S6/S7 (T8): session_start reads the checkout's mine AND assigned issues, merged under a bare count", async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [
      { number: 11, title: 'Assigned older', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' },
      { number: 12, title: 'Assigned newer', state: 'OPEN', updatedAt: '2024-06-01T00:00:00Z' },
      // 13 is BOTH authored and assigned: it is one row, and it is the assigned
      // one (that is the bucket its click opens). 14 is only authored.
      { number: 13, title: 'Both thirteen', state: 'OPEN', updatedAt: '2024-07-01T00:00:00Z' },
    ],
    mine: [
      { number: 13, title: 'Both thirteen', state: 'OPEN', updatedAt: '2024-07-01T00:00:00Z' },
      { number: 14, title: 'Only mine fourteen', state: 'OPEN', updatedAt: '2024-04-01T00:00:00Z' },
    ],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);

  assert.deepEqual(rows.map((row) => row.label),
    ['#13 Both thirteen', '#12 Assigned newer', '#11 Assigned older', '#14 Only mine fourteen'],
    'one merged list, deduplicated by number, newest first');
  assert.equal(section.meta(ctx), '4 issues', 'the header is the merged count alone, never `4 assigned`');
  assert.ok(rows.every((row) => !('meta' in row)), 'no row reports a relation');
  const snap = section.lines(ctx);
  assert.equal(snap.length, 4);

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

// S7 (T8): `truncated` is true when EITHER contributing bucket hit the cache cap:
// the overflow row's `N+` says the real total is larger than the merged rows.
test('S7 (T8): a truncated mine bucket alone still writes the overflow count with a +', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [
      { number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' },
    ],
    mine: issueList(9).map((item, index) => ({
      number: 100 + index,
      title: item.title,
      state: 'OPEN',
      updatedAt: item.updatedAt,
    })),
    // The mine bucket reported more issues than the cache could hold.
    counts: { mine: 150 },
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);
  assert.equal(rows.length, 8, 'seven merged rows plus the one overflow row');
  assert.equal(rows[7].label, 'and 3+ more issues',
    'either contributing bucket being truncated makes the count inexact');
  assert.equal(section.meta(ctx), '10 issues', 'the header counts the merged rows it has');
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
  assert.equal(section.meta(ctx), '9 issues', 'the header counts every issue read');
  assert.equal(graphqlCalls(gh.calls).length, 1, 'one read, never one per bucket');

  rows[7].onClick();
  assert.deepEqual(sent, [], 'the dispatch is deferred off the paint path');
  await waitFor(() => sent.length > 0, 'the overflow click never dispatched /issues');
  assert.deepEqual(sent, [{ text: '/issues', opts: { expandPromptTemplates: true } }],
    'the overflow row dispatches the /issues command exactly once');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1, 'one click is one dispatch');
});

test("S6: a failed scope resolution is one error row and reads no gh", async () => {
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
  // S1/S3 (T1, T2): the session gate asks gh whether gh is USABLE (`gh api user`,
  // `gh repo view`) and passes `scope: null`, so it never resolves this checkout's
  // identity through gh — the local checkout check is what decides whether there is
  // anything to read. What must never happen is a READ without a proven identity.
  assert.deepEqual(graphqlCalls(gh.calls), [], 'no issue read runs without a proven identity');
  assert.ok(gh.calls.every((call) => (call.argv[0] === 'api' && call.argv[1] === 'user')
    || (call.argv[0] === 'repo' && call.argv[1] === 'view')),
  `every child is the gate's own health probe (saw ${JSON.stringify(gh.calls.map((call) => call.argv))})`);
});

// S12 (T11): a cwd that is not a repository is not an ERROR — nothing is broken,
// there is simply nothing to read. The rail says so with one short line in the
// gray tone it already has for secondary text, and names no path: the human
// knows where they are. The command notices keep their own, fuller sentence.
test('S12 (T11): a session outside a repository paints one short dim line, and the command keeps its wording', async () => {
  const notGit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-not-git-')));
  const { registered } = installBridge();
  const notices = [];
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub();
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: notGit, ui: { notify: (text, level) => { notices.push({ text, level }); } } };
  await fireSessionStart(loaded.hooks, ctx);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);

  assert.deepEqual(rows, [{ label: 'not a git repository', tone: 'dim' }],
    'one short line, no path, no git advice, and never the error tone');
  assert.equal(section.meta(ctx), undefined, 'and no count');
  assert.equal(graphqlCalls(gh.calls).length, 0, 'and no issue read runs at all');

  // The command's own notices are untouched by this: `/issues` still says the
  // full sentence it always did.
  const notes = [];
  const commandCtx = { cwd: notGit, ui: { notify: (text, level) => { notes.push([text, level]); } } };
  await loaded.commands.get('issues').handler('', commandCtx);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], `not a git repository: ${notGit}; run 'git init' first`,
    'the command notice keeps its own wording');
});

// A checkout that IS a repository but has no remote at all is the same kind of
// state one step further in: gh cannot name a repository because there is
// nothing to resolve from, so the rail says it in one short gray line — never
// gh's long failure sentence in the red tone — and it reads nothing.
// The boundary of that state: ONLY gh's no-remote refusal becomes the gray line.
// Every other failure keeps today's long error row, and an unknown wording
// degrades to it instead of being read as "nothing to do here".
for (const [stderr, label, tone] of [
  ['no git remotes found\nrun git remote add origin <url> first', 'not a GitHub repository', 'dim'],
  ['NO GIT REMOTES found', 'not a GitHub repository', 'dim'],
  ['gh: Not logged in', 'cannot resolve the repository: gh: Not logged in', 'error'],
  ['no remotes configured for this checkout',
    'cannot resolve the repository: no remotes configured for this checkout', 'error'],
  ['', 'cannot resolve the repository: gh exited with status 1', 'error'],
]) {
  test(`S12 (T11) parity: gh's ${JSON.stringify(stderr.split('\n')[0])} paints ${tone}`, async () => {
    const checkout = makeCheckout([]);
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    ghIssues.setGhRunner(async (bin, argv) => {
      calls.push({ bin, argv: argv.slice() });
      if (argv[0] === 'repo') return { status: 1, stdout: '', stderr, error: null };
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      assert.fail(`unexpected issue read: ${argv.join(' ')}`);
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];
    const rows = await waitForRows(section, ctx);

    assert.deepEqual(rows, [{ label, tone }], 'one row, in the role this failure earns');
    assert.equal(section.meta(ctx), undefined, 'and no count');
    assert.equal(graphqlCalls(calls).length, 0, 'and no issue read at all');
  });
}

// S13 (T11, corrected): without the `gh` CLI the rail section is NEVER ADDED —
// "/issues nunca se carga ni nunca se agrega a sidebar github sidebar". The decision
// is a LOCAL presence answer (a PATH walk; the module answers `ghCliPresent`, no
// child), so the host pays no `gh` child, no git child and no read at all, and there
// is no line, notice or refusal to draw: nothing appears, because nothing was
// registered. Every other surface the package contributes is still there.
test('S13 (T11): without the gh CLI the GITHUB section is never added to the rail', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  // The decision is the real probe over PATH — no seam, because registration reads
  // it before any module instance a test could patch exists.
  const loaded = await loadExtension({}, { gh: false });
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub();
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);

  assert.deepEqual(registered, [], 'no section is added to the rail: there is nothing to draw');
  assert.equal(loaded.commands.has('issues'), false, '/issues never loads either');
  await settleStartup(gh.calls);
  assert.deepEqual(gh.calls, [], 'and no gh child runs — not even the session gate\'s health probe');
  // A missing `gh` is not a plugin-wide switch: the rest of the surface is here.
  assert.ok(loaded.commands.has('warp'), '/warp still registers');
  assert.ok(loaded.commands.has('odd'), '/odd still registers');
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

test('S8 (T9): the ONE combined read supplies both the rows and the pull-request number each marker draws', async () => {
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
          { number: 11, title: 'Has a PR', updatedAt: '2024-05-01T00:00:00Z', hasPullRequest: true, pullRequestNumber: 69 },
          { number: 12, title: 'No PR', updatedAt: '2024-06-01T00:00:00Z' },
          { number: 13, title: 'Two PRs', updatedAt: '2024-07-01T00:00:00Z', timelineItems: { nodes: [
            { source: { __typename: 'Issue', number: 5 } },
            { source: { __typename: 'PullRequest', number: 70 } },
            { source: { __typename: 'PullRequest', number: 71 } },
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
  // S3 (issues-sidebar-click): the mark is the NEWEST pull request's number, so
  // the fixture's later event (#71) wins over the earlier one (#70).
  assert.equal(rows[0].meta, '\ue726 #71', 'an issue with several pull requests marks the NEWEST number');
  assert.equal('meta' in rows[1], false, 'an issue no pull request references carries no marker');
  assert.equal(rows[2].meta, '\ue726 #69');
  assert.deepEqual(rows.map((row) => row.tone), ['text', 'text', 'text'],
    'only the meta column is gray: the row keeps the plain text tone');
  assert.equal(issuesCount(section.meta(ctx)), '3 issues', 'the marker never changes the count');

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
  assert.ok(query.includes('timelineItems(last: 10, itemTypes: [CROSS_REFERENCED_EVENT])'),
    'the marker selection rides each row and reads the newest events');
  assert.ok(query.includes('... on PullRequest { number }'),
    'and the selection asks for the number the mark prints (S8)');
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
      { number: 11, title: 'Has a PR', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z', hasPullRequest: true, pullRequestNumber: 69 },
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
  assert.equal(rows[1].meta, '\ue726 #69', 'the row with a pull request carries its number');
  const meta = section.meta(ctx);
  assert.equal(issuesCount(meta), '2 issues', 'the section stays ready, never stale');
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
  // S18 (T14): the shared fixture publishes a default bridge, and this harness is
  // about the ABSENT one, so it opts out: the slot is exactly what the test left.
  const loaded = await loadExtension(events ? { events } : {}, { bridge: false });
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

// T12 rewrote this test: its old assertion was the browser argv the row click
// used to reach (`issue view 11 --web -R github.com/myfork/project`). A row click
// now dispatches `/issues 11` instead — the panel proves its own identity when it
// opens — so the browser argv it pinned is impossible to keep. What is still this
// test's subject is the READ: a single-remote checkout has no scope identity to
// pin, so the read must carry the identity gh itself resolves.
test('S4 (T4/T12): a single-remote checkout lists its issues, and a row click opens the panel on that issue', async () => {
  // ONE remote: `checkoutRepoScope()` answers `identity: null`, so the identity
  // the read (and, before T12, the opener) uses is the one gh itself resolves.
  const checkout = makeCheckout([['origin', 'git@github.com:myfork/project.git']]);
  const { registered } = installBridge();
  const sent = [];
  const loaded = await loadExtension({
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
  });
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
    await waitFor(() => sent.length > 0, 'the click never dispatched /issues');
  } finally {
    worktreeGit.runArgvAsync = original;
  }
  assert.deepEqual(sent, [{ text: '/issues 11', opts: { expandPromptTemplates: true } }],
    'the row click dispatches the panel command for that issue, exactly once');
  assert.deepEqual(opened, [], 'the click no longer opens a browser');
  const reads = graphqlCalls(gh.calls);
  assert.equal(reads[0].env.GH_REPO, 'github.com/myfork/project',
    'the read carries the identity gh resolved for this checkout, host-qualified');
});

// T12: the deferred click contract is unchanged — off the paint path, a recorded
// `{ ok, error }`, never a throw. T10 (S9) adds the one thing the old shape
// lacked: a host that cannot dispatch is TOLD so visibly, never by a silent
// snapshot field alone.
test('S9 (T10): a host that cannot dispatch leaves a visible transcript entry, never silence', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
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
    const section = registered[0];
    const rows = await waitForRows(section, ctx);
    assert.equal(rows[0].label, '#11 Assigned one');
    // The click returns immediately and never throws; the refusal is both
    // recorded for a caller AND appended as one transcript entry.
    assert.equal(rows[0].onClick(), undefined, 'the deferred click never throws at the caller');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(opened, [], 'no browser open runs when the host cannot dispatch');
    assert.equal(loaded.entries.length, 1, 'the refusal is one visible transcript entry');
    assert.match(String(loaded.entries[0].data && loaded.entries[0].data.line),
      /cannot dispatch the \/issues command/, 'the entry names the refusal');
    assert.deepEqual(section.lines(ctx).map((row) => row.label), ['#11 Assigned one'],
      'the recorded refusal never turns the ready list into an error row');
    assert.equal(section.meta(ctx), '1 issues', 'and the header still counts the list it has');
  } finally {
    worktreeGit.runArgvAsync = original;
  }
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
  // S10 (T8): this test reads the `gh` children themselves, so the dispatched gate
  // is settled through its own coalesced question before shutdown — a late probe
  // must not be mistaken for a read the dead session started.
  await awaitIssuesGateSettled(checkout);
  assert.equal(registered.length, 1);
  const section = registered[0];
  const rows = await waitForRows(section, ctx);
  assert.deepEqual(rows.map((row) => row.label), ['#11 Assigned one'], 'the session drew its own rows first');

  await fireHook(loaded.hooks, 'session_shutdown', ctx);

  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    "the ended session's rows are gone, the rail falls back to the loading row");

  // T18 (S11): the session that ended DISPOSED its section, so a frame the host
  // still paints reads nothing at all — no cwd of the dead session is ever used,
  // and no floor timer outlives the shutdown.
  const before = calls.length;
  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    'a frame after shutdown still paints the loading row');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(calls.length, before, 'a frame drawn after shutdown reads nothing');
  assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
    "the ended session's rows never paint again");
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

// T12 wrote this test to assert that a row retained across a checkout change
// dispatched `/issues 11` — the number alone, so the panel proved its own
// repository. T17 (E17a) then compared the row's identity with this checkout's
// before dispatching, and T10 (S9) removes that second proof again: the panel
// pins and proves the identity itself when it opens (invariant 6), and the
// pre-dispatch proof was exactly what left a click dead with no visible effect.
// What is left — and what this test states — is the dispatch itself: the number
// alone travels, and whatever repository the click came from, the panel decides.
test('S9 (T10): a retained row dispatches its number, and the panel proves its own identity', async () => {
  const checkoutA = makeCheckout([
    ['origin', 'git@github.com:myfork/project-a.git'],
    ['upstream', 'git@github.com:original/project-a.git'],
  ]);
  const checkoutB = makeCheckout([
    ['origin', 'git@github.com:myfork/project-b.git'],
    ['upstream', 'git@github.com:original/project-b.git'],
  ]);
  const { registered } = installBridge();
  const sent = [];
  const loaded = await loadExtension({
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
  });
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
    // landed. The click dispatches the NUMBER alone — the panel is what proves
    // the repository it opens, exactly like a plain `/issues 11` typed by hand.
    rowA.onClick();
    await waitFor(() => sent.length > 0, 'the retained row never dispatched /issues');

    assert.deepEqual(sent, [{ text: '/issues 11', opts: { expandPromptTemplates: true } }],
      'the click dispatches the number alone, with no repository on the command line');
    assert.deepEqual(opened, [], 'and opens no browser');
    assert.ok(section.lines(ctxB).some((row) => row.label === '#11 B eleven'),
      'the ready list is never disturbed by the click');
    assert.equal(section.meta(ctxB), '1 issues', 'and the header still counts it');
  } finally {
    worktreeGit.runArgvAsync = original;
  }
});

// T10 (S9): the seam's answer. The seam is exported for exactly this contract
// (like the other test seams in the extension): it is the function the row click
// defers, and it is where the click's whole behaviour is observable without a
// host. It loads the extension the way the host does, with a stub `pi`.
async function loadSeam(pi = {}) {
  // S18 (T14): this file's own loader needs the bridge its host would have, or the
  // extension registers nothing and there is no session at all to reach a notice.
  installDefaultBridge();
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-seam-')));
  const copy = path.join(dir, 'odd-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbedSource());
  const hooks = [];
  const host = {
    registerCommand: () => {},
    registerTool: () => {},
    registerMessageRenderer: () => {},
    on: (event, handler) => { hooks.push([event, handler]); return () => {}; },
    ...pi,
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(host);
  return { mod, hooks };
}

// T10 (S9) part 1: the pre-dispatch proof is gone. A row click dispatches
// `/issues <n>` synchronously — no awaited checkout probe, no generation check —
// because the panel pins and proves the identity itself when it opens. The proof
// was the thing that left a click dead with no visible effect: it awaited git
// (and, on a single-remote checkout, `gh`) and its failures only reached a field
// nothing draws.
test('S9 (T10): a click dispatches `/issues <n>` synchronously, with no awaited identity read', async () => {
  const checkout = makeCheckout();
  const sent = [];
  const dispatch = { sendUserMessage: (text, opts) => { sent.push({ text, opts }); } };
  const { mod, hooks } = await loadSeam(dispatch);
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  ghIssues.setGhRunner(sectionGithub({}).runner);
  const worktreeGit = require(path.join(LIB_DIR, 'worktree-git.js'));
  const reads = [];
  const original = worktreeGit.runArgvAsync;
  worktreeGit.runArgvAsync = async (bin, argv, opts) => {
    reads.push({ bin, argv: argv.slice() });
    return original(bin, argv, opts);
  };
  try {
    await fireSessionStart(hooks, { cwd: checkout, ui: { notify: () => {} } });
    const before = reads.length;
    // A row names a repository, and this one names another checkout: neither
    // fact is read on this path any more, and the dispatch happens before the
    // call returns — it is not a promise to await.
    const outcome = mod.dispatchIssuesPanel(dispatch, 11, 'github.com/other/project', 'mine');
    assert.deepEqual(outcome, { ok: true }, 'the click answers at once');
    assert.deepEqual(sent, [{ text: '/issues 11', opts: { expandPromptTemplates: true } }],
      'the number alone reaches the panel');
    assert.equal(reads.length, before, 'no checkout identity is read on the click path');
  } finally {
    worktreeGit.runArgvAsync = original;
  }
});

// T10 (S9) part 1, second half: a host that truly cannot dispatch is told so,
// visibly. The first surface is the host's own transcript entry seam; a host
// without it gets the notice seam instead. The snapshot field keeps recording
// the outcome, but it is never the only place the refusal lands.
test('S9 (T10): a host with no sendUserMessage appends the refusal as a transcript entry', async () => {
  const entries = [];
  const host = { appendEntry: (customType, data) => { entries.push({ customType, data }); } };
  const { mod } = await loadSeam(host);
  const outcome = mod.dispatchIssuesPanel(host, 11);
  assert.equal(outcome.ok, false, 'the refusal is still reported to the caller');
  assert.match(outcome.error, /cannot dispatch the \/issues command/);
  assert.equal(entries.length, 1, 'exactly one visible entry, never silence');
  assert.match(String(entries[0].data && entries[0].data.line), /cannot dispatch the \/issues command/,
    'the entry carries the refusal the caller got');
});

test('S9 (T10): with no entry seam, the refusal reaches the host notice seam', async () => {
  const notices = [];
  const host = { appendEntry: undefined };
  const { mod, hooks } = await loadSeam(host);
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  ghIssues.setGhRunner(sectionGithub({}).runner);
  const checkout = makeCheckout();
  await fireSessionStart(hooks, {
    cwd: checkout,
    ui: { notify: (text, level) => { notices.push({ text, level }); } },
  });
  const outcome = mod.dispatchIssuesPanel(host, 11);
  assert.equal(outcome.ok, false);
  assert.ok(notices.some((notice) => /cannot dispatch the \/issues command/.test(notice.text)),
    'a host with only a notice seam is told there too');
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
// T8 (S10, S11, L9): the rail re-reads on TIME, not on activity. While the
// section is DRAWN it keeps ONE self-scheduled, unref'd timer at the floor L9
// names (20 s): one read per floor, never a burst, never two reads in flight.
// The timer keeps no clock of its own — it fires through the same injected
// `setTimer`/`clearTimer` seams as everything else here — and it stops by itself
// the moment the section is no longer drawn (the `drawnWithin` window), and it
// is cleared by `invalidate()` and `dispose()`.
// ---------------------------------------------------------------------------

// The injected clock plus one list of pending timers: a test fires exactly the
// timer the section armed, at the instant that timer was armed for.
function fakeTimerSeam(start = 100000) {
  const seam = {
    clock: start,
    armed: [],
    setTimer(fn, ms) {
      const timer = {
        at: seam.clock + ms,
        ms,
        fn,
        fired: false,
        cleared: false,
        unrefCalls: 0,
        unref() { this.unrefCalls += 1; },
      };
      seam.armed.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (!timer) return;
      timer.cleared = true;
      seam.armed = seam.armed.filter((pending) => pending !== timer);
    },
    take() {
      const timer = seam.armed.shift();
      if (!timer) throw new Error('the section armed no timer to fire');
      // A fire never rewinds the clock: a test that jumped the clock forward
      // (to model a section nobody drew for a while) keeps that instant.
      seam.clock = Math.max(seam.clock, timer.at);
      timer.fired = true;
      timer.fn();
      return timer;
    },
  };
  return seam;
}

// Let the section's own deferred read settle: its `schedule` runs inline, so
// only the promise chain is left.
async function settleFrames() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('S10 (T8): a drawn section reads on its own timer at the floor, one read per floor', async () => {
  const timers = fakeTimerSeam();
  let loads = 0;
  const handle = createIssuesSection({
    load: async () => {
      loads += 1;
      return { ok: true, identity: IDENTITY, issues: [], truncated: false };
    },
    schedule: (fn) => { fn(); },
    now: () => timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    refreshFloorMs: 20000,
    timerDrawnWindowMs: 120000,
  });

  // A section nobody draws starts nothing: no read and no timer (S11).
  await settleFrames();
  assert.equal(loads, 0, 'an undrawn section reads nothing');
  assert.equal(timers.armed.length, 0, 'an undrawn section keeps no timer');

  // The first frame arms the floor's timer, and it never keeps the process alive.
  handle.section.lines({});
  await settleFrames();
  assert.equal(loads, 1, 'the drawn frame made its own TTL read');
  assert.equal(timers.armed.length, 1, 'one timer, armed by the drawn frame');
  assert.equal(timers.armed[0].ms, 20000, 'the floor L9 names');
  assert.equal(timers.armed[0].unrefCalls, 1, 'the timer is unref\'d, so it never holds the process');

  // More frames while it is armed never add a timer: one read per floor, never a burst.
  handle.section.lines({});
  handle.section.meta({});
  assert.equal(timers.armed.length, 1, 'a frame never stacks a second timer');

  // The fire is the read, and it arms exactly the next floor.
  timers.take();
  await settleFrames();
  assert.equal(loads, 2, 'the timer fired exactly one read');
  assert.equal(timers.armed.length, 1, 'and armed the next floor, once');
  assert.equal(timers.armed[0].ms, 20000);

  // The next fire reads again: the rail keeps itself current on an idle session.
  timers.take();
  await settleFrames();
  assert.equal(loads, 3, 'the second floor fired its own read');
  assert.equal(timers.armed.length, 1);
});

test('S10/S11 (T8): the timer never overlaps a read, and it stops once the section is not drawn', async () => {
  const timers = fakeTimerSeam();
  const pending = [];
  let loads = 0;
  const handle = createIssuesSection({
    load: () => {
      loads += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
    schedule: (fn) => { fn(); },
    now: () => timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    refreshFloorMs: 20000,
    timerDrawnWindowMs: 120000,
  });

  handle.section.lines({});
  await settleFrames();
  assert.equal(loads, 1, 'the drawn frame started its read');

  // The timer fires while that read is still in flight: it starts nothing.
  timers.take();
  await settleFrames();
  assert.equal(loads, 1, 'never two reads in flight');
  assert.equal(timers.armed.length, 1, 'the timer still arms the next floor');

  pending.shift()({ ok: true, identity: IDENTITY, issues: [], truncated: false });
  await settleFrames();
  assert.equal(handle.snapshot().status, 'ready');

  // Nobody drew the section for longer than the drawn window: the fire starts
  // nothing and the timer keeps nothing.
  timers.clock += 121000;
  timers.take();
  await settleFrames();
  assert.equal(loads, 1, 'a section outside the drawn window reads nothing');
  assert.equal(timers.armed.length, 0, 'and it keeps no timer');
});

test('S10/S11 (T8): invalidate and dispose clear the timer, and a queued callback is inert', async () => {
  const timers = fakeTimerSeam();
  let loads = 0;
  const handle = createIssuesSection({
    load: async () => {
      loads += 1;
      return { ok: true, identity: IDENTITY, issues: [], truncated: false };
    },
    schedule: (fn) => { fn(); },
    now: () => timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    refreshFloorMs: 20000,
    timerDrawnWindowMs: 120000,
  });

  handle.section.lines({});
  await settleFrames();
  assert.equal(loads, 1);
  const onInvalidate = timers.armed.shift();
  handle.invalidate();
  assert.equal(onInvalidate.cleared, true, 'invalidate clears the floor timer');
  // A host that already queued the callback still runs it: it must be inert.
  timers.clock = onInvalidate.at;
  onInvalidate.fn();
  await settleFrames();
  assert.equal(loads, 1, 'a cleared timer reads nothing');
  assert.equal(timers.armed.length, 0, 'and arms nothing');

  handle.section.lines({});
  await settleFrames();
  assert.equal(loads, 2, 'the redrawn section reads again');
  const onDispose = timers.armed.shift();
  handle.dispose();
  assert.equal(onDispose.cleared, true, 'dispose clears the floor timer');
  timers.clock = onDispose.at;
  onDispose.fn();
  await settleFrames();
  assert.equal(loads, 2, 'a disposed section reads nothing');
  assert.equal(timers.armed.length, 0);
});

test('S11 (T8): a caller that names no floor keeps the module timer-free', async () => {
  const timers = fakeTimerSeam();
  const handle = createIssuesSection({
    load: async () => ({ ok: true, identity: IDENTITY, issues: [], truncated: false }),
    schedule: (fn) => { fn(); },
    now: () => timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  handle.section.lines({});
  await settleFrames();
  assert.equal(handle.snapshot().status, 'ready');
  assert.equal(timers.armed.length, 0, 'no floor, no timer: the module schedules nothing by itself');
  handle.dispose();
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
    // S1/S2 (T1) / S10 (T8): the gate's two identity probes are DISPATCHED startup
    // work and land whenever the host gets to them — this test counts `gh`
    // children, so it settles them through the gate's own coalesced question
    // before taking a baseline, never through elapsed quiet.
    await awaitIssuesGateSettled(checkout);
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
  // S10 (T8): the dispatched gate's probes are settled here for the same reason as
  // the drawn-window case above: this test measures a `gh` child count.
  await awaitIssuesGateSettled(checkout);
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
// T8/T9 (S10, S11, L9): the rail refreshes on TIME and after a mutating `bash`.
// The extension arms the section's own floor timer at 20 s (L9) while the
// section is drawn, its activity hooks add no read on top of a fresh one, and a
// `bash` result whose command mutates an issue or a pull request forces ONE read
// behind the 5 s anti-storm cap. Nothing at all happens while the section is not
// drawn (S11), and a result from a session that already ended forces nothing.
// ---------------------------------------------------------------------------

test('S10 (T8): a drawn section reads on the extension\'s own 20 s timer, and activity adds nothing', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  // The section's floor timer is the ONE timer this test owns: it is captured
  // instead of waited for, so the 20 s floor is exercised without 20 idle
  // seconds. Every other delay goes to the host's own `setTimeout`.
  const armed = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 20000) {
      const timer = { fn, ms, fired: false, cleared: false, issuesFloorTimer: true, unref() {} };
      armed.push(timer);
      return timer;
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && handle.issuesFloorTimer === true) {
      handle.cleared = true;
      return;
    }
    return realClearTimeout(handle);
  };
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const gh = sectionGithub({
      issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    });
    ghIssues.setGhRunner(gh.runner);
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];

    // A hidden section: no frame, no timer, no read (S11).
    await fireHook(loaded.hooks, 'before_agent_start', ctx);
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await new Promise((resolve) => realSetTimeout(resolve, 120));
    assert.equal(armed.length, 0, 'a hidden section keeps no timer');
    assert.equal(graphqlCalls(gh.calls).length, 0, 'a hidden section reads nothing');

    // The drawn frame arms ONE unref'd timer at the floor L9 names.
    await waitForRows(section, ctx);
    assert.equal(armed.length, 1, 'the drawn frame armed one timer');
    assert.equal(armed[0].ms, 20000, 'the floor is 20 s (L9)');
    const reads = graphqlCalls(gh.calls).length;
    assert.equal(reads, 1, 'the drawn frame made its own read');

    // The timer fires at its floor: exactly one read, and the next floor armed.
    offset = 25000;
    armed[0].fired = true;
    armed[0].fn();
    await waitFor(() => graphqlCalls(gh.calls).length === reads + 1,
      'the drawn section\'s floor timer started no read');
    assert.equal(armed.length, 2, 'the fire armed the next floor');

    // The session's own activity adds no read on top of the timer's own.
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await fireHook(loaded.hooks, 'before_agent_start', ctx);
    await new Promise((resolve) => realSetTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads + 1, 'activity added no read inside the floor');

    // The session boundary clears the timer, and a callback already queued by
    // the host reads nothing.
    await fireHook(loaded.hooks, 'session_shutdown', ctx);
    assert.equal(armed[1].cleared, true, 'session_shutdown cleared the floor timer');
    offset = 50000;
    armed[1].fired = true;
    armed[1].fn();
    await new Promise((resolve) => realSetTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads + 1, 'a cleared timer reads nothing');
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

// T18 (S11, PR #89 review): the extension stored the bridge's unregister and the
// section's handle but ran neither, so a section that was REPLACED — a republished
// bridge, a second mount — kept its 20 s floor timer alive for the rest of its
// drawn window. A replaced section must be torn down before the replacement is
// registered, and must read nothing afterwards: that duplicate `gh` traffic is
// exactly what this feature exists to remove.
test('S11 (T18): a re-mount tears the replaced section down, so it reads nothing', async () => {
  const floor = captureFloorTimers();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const firstBridge = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const gh = sectionGithub({
      issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    });
    ghIssues.setGhRunner(gh.runner);
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    await awaitIssuesGateSettled(checkout);
    assert.equal(firstBridge.registered.length, 1, 'the first bridge holds the first section');
    const replaced = firstBridge.registered[0];
    await waitForRows(replaced, ctx);
    assert.equal(graphqlCalls(gh.calls).length, 1, 'the first section read once');
    assert.equal(floor.armed.length, 1, 'and armed its own floor timer');

    // A republished bridge is a NEW published object, so the rail binds again on
    // the next session boundary — while the replaced section is still live.
    const republished = installBridge();
    await fireSessionStart(loaded.hooks, ctx);
    await awaitIssuesGateSettled(checkout);

    // The replaced section must be inert: a frame the host still paints (and the
    // clock moving past the floor with it) starts no read at all.
    const reads = graphqlCalls(gh.calls).length;
    replaced.lines(ctx);
    offset = 25000;
    for (const timer of floor.armed.slice(1)) timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads,
      'the replaced section kept reading after the re-mount');
    assert.equal(floor.armed.length, 1, 'and the replaced section armed no floor timer');

    // The replacement was registered, and the binding it replaced was unregistered
    // FIRST — the tear-down order the contract names.
    assert.equal(republished.registered.length, 1, 'the new bridge holds the replacement section');
    assert.deepEqual(firstBridge.released, [replaced], 'the replaced binding was unregistered first');
  } finally {
    Date.now = realNow;
    floor.restore();
  }
});

// T18 (S11): a session that ends takes its timer with it. `invalidate()` dropped
// the snapshot but left the section alive, so one frame the host painted after
// shutdown re-armed the floor and kept reading for the rest of the drawn window.
test('S11 (T18): a shut-down session leaves no floor timer behind', async () => {
  const floor = captureFloorTimers();
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
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    await awaitIssuesGateSettled(checkout);
    const section = registered[0];
    await waitForRows(section, ctx);
    assert.equal(graphqlCalls(gh.calls).length, 1, 'the drawn section made its own read');
    assert.equal(floor.armed.length, 1, 'and armed the floor');

    // One floor fires, so a second floor is armed when the session ends.
    offset = 25000;
    floor.armed[0].fn();
    await waitFor(() => graphqlCalls(gh.calls).length === 2, 'the floor timer started no read');
    // Let that read settle, so the only read the post-shutdown frame could start
    // is its own (a read still in flight would mask it behind `running`).
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(floor.armed.length, 2, 'the fire armed the next floor');

    await fireHook(loaded.hooks, 'session_shutdown', ctx);
    assert.equal(floor.armed[1].cleared, true, 'shutdown cleared the armed floor');

    // The host can still paint the frame it held when the session ended, and that
    // draw would re-open the drawn window. A shut-down section must arm nothing and
    // start no read, however many floors pass inside that window.
    section.lines(ctx);
    offset = 25000 + 60000;
    for (const timer of floor.armed.slice(2)) timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(floor.armed.length, 2, 'a shut-down section armed no floor timer');
    // A read attempt settles an ended-session error row; the disposed section keeps
    // the loading row, so this is what "nothing reads" looks like from outside.
    assert.deepEqual(section.lines(ctx), [{ label: 'loading…', tone: 'dim' }],
      'a shut-down section started a read after its session ended');
  } finally {
    Date.now = realNow;
    floor.restore();
  }
});

// The rail's floor is a REAL 20 s timer (the extension's own constant) and no test
// waits 20 s for it: a test that needs the floor fires the captured callback
// itself, exactly like the host would. Every other delay still goes to the host.
function captureFloorTimers() {
  const armed = [];
  const hostSetTimeout = globalThis.setTimeout;
  const hostClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 20000) {
      const timer = { fn, ms, cleared: false, issuesFloorTimer: true, unref() {} };
      armed.push(timer);
      return timer;
    }
    return hostSetTimeout(fn, ms, ...rest);
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && handle.issuesFloorTimer === true) {
      handle.cleared = true;
      return;
    }
    return hostClearTimeout(handle);
  };
  return {
    armed,
    restore() {
      globalThis.setTimeout = hostSetTimeout;
      globalThis.clearTimeout = hostClearTimeout;
    },
  };
}

// S10 (T8) L9: ONE floor window is ONE read. The floor is the only thing that
// buys a read — a drawn frame, a session event and a timer callback all ask the
// section, and none of them may add a second read inside the same window: that
// is the duplicate `gh` traffic this feature exists to remove. And a read that
// LANDS starts the next window, so an answer arriving does not immediately start
// another read (requirement 2): its own settling instant is the floor's zero.
test('S10 (T8): one floor window is ONE read, however many frames, activity events and timer fires land in it', async () => {
  const floor = captureFloorTimers();
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
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];
    const reads = () => graphqlCalls(gh.calls).length;

    // The drawn frame's own read, and the one floor it armed.
    await waitForRows(section, ctx);
    assert.equal(reads(), 1, 'the drawn frame made its own read');
    assert.equal(floor.armed.length, 1, 'and armed ONE floor timer');

    // Twenty more frames and ten session events, all inside that floor: not one
    // read. The TTL has not expired and the activity floor is untouched.
    for (let index = 0; index < 20; index += 1) section.lines(ctx);
    section.meta(ctx);
    for (let index = 0; index < 5; index += 1) {
      await fireHook(loaded.hooks, 'turn_end', ctx);
      await fireHook(loaded.hooks, 'before_agent_start', ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(reads(), 1, 'a floor window is ONE read, whatever lands inside it');

    // The floor timer firing to its floor is the window's one read.
    offset = 25000;
    floor.armed[0].fn();
    await waitFor(() => reads() === 2, 'the floor timer started no read');
    assert.equal(floor.armed.length, 2, 'and it armed the next floor');

    // The same callback a second time (a host that had already queued it) is
    // inert: the section moved its token on when it armed the next floor.
    floor.armed[0].fn();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(reads(), 2, 'a repeated callback adds no read');

    // The read has landed: its settling instant is the floor's zero, so neither
    // frames nor activity nor a stale callback start a read on top of it.
    for (let index = 0; index < 10; index += 1) section.lines(ctx);
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(reads(), 2, 'an answer that landed started no further read');
  } finally {
    Date.now = realNow;
    floor.restore();
  }
});

test('S10 (T9): a mutating bash result forces one read, capped to one per 5 s', async () => {
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
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];
    await waitForRows(section, ctx);
    const reads = graphqlCalls(gh.calls).length;
    assert.equal(reads, 1);

    const bashResult = (command) => ({ toolName: 'bash', input: { command }, toolResults: [] });

    // The mutating result forces exactly one read, right after it.
    await fireEvent(loaded.hooks, 'tool_result', bashResult('gh issue close 11'), ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === reads + 1,
      'a mutating bash result forced no read');

    // A second write inside the 5 s cap forces nothing (L9).
    await fireEvent(loaded.hooks, 'tool_result', bashResult('gh pr merge 3'), ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads + 1, 'the anti-storm cap held');

    // A read-only command and a non-bash tool force nothing either.
    await fireEvent(loaded.hooks, 'tool_result', bashResult('gh issue list --limit 5'), ctx);
    await fireEvent(loaded.hooks, 'tool_result', { toolName: 'write', input: { command: 'gh issue close 12' }, toolResults: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads + 1, 'only a mutating bash forces a read');

    // Past the cap the next mutation forces its own read.
    offset = 6000;
    await fireEvent(loaded.hooks, 'tool_result', bashResult('gh issue reopen 11'), ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === reads + 2,
      'a mutation past the cap forced no read');

    // A result from a session that already ended forces nothing.
    await fireEvent(loaded.hooks, 'tool_result', bashResult('gh issue close 11'), {
      ...ctx,
      sessionManager: { getSessionId: () => 'session-that-ended' },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads + 2, 'an ended session\'s result forces nothing');
  } finally {
    Date.now = realNow;
  }
});

// S10 (T9): the host does not have to spell a tool event the way our other
// handlers read it first. `oddToolNameOf` accepts `toolName`, `tool` and `name`,
// and `oddArgsOf` accepts `args`, `input`, `params` and `arguments`, so the one
// handler that forces a read has to read the event through the same pair — a
// `tool`/`args` result is the same bash call and must force the same read.
test('S10 (T9): a mutating bash named under `tool`/`args` forces the same read', async () => {
  const realNow = Date.now;
  Date.now = () => realNow();
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const gh = sectionGithub({
      issues: [{ number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' }],
    });
    ghIssues.setGhRunner(gh.runner);
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    const section = registered[0];
    await waitForRows(section, ctx);
    const reads = graphqlCalls(gh.calls).length;

    await fireEvent(loaded.hooks, 'tool_result', { tool: 'bash', args: { command: 'gh issue close 11' }, toolResults: [] }, ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === reads + 1,
      'a mutating bash carried under `tool`/`args` forced no read');
  } finally {
    Date.now = realNow;
  }
});

test('S11 (T9): a hidden section forces no read, and a mutating result after shutdown does nothing', async () => {
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
    const ctx = { cwd: checkout, ui: { notify: () => {} }, sessionManager: { getSessionId: () => 'session-one' } };

    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);

    // Nothing was ever drawn, so nothing is forced (S11).
    await fireEvent(loaded.hooks, 'tool_result', { toolName: 'bash', input: { command: 'gh issue close 11' }, toolResults: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, 0, 'a hidden section forces no read at all');

    // Drawn, then shut down: the section is showing nothing again.
    const section = registered[0];
    await waitForRows(section, ctx);
    const reads = graphqlCalls(gh.calls).length;
    await fireHook(loaded.hooks, 'session_shutdown', ctx);
    offset = 6000;
    await fireEvent(loaded.hooks, 'tool_result', { toolName: 'bash', input: { command: 'gh issue close 11' }, toolResults: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(gh.calls).length, reads, 'a result after shutdown forces nothing');
  } finally {
    Date.now = realNow;
  }
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
    // S1 (issues-startup-performance T1) / S5 (T8): the session gate is dispatched
    // startup work now, so its own identity probes are counted once they have
    // landed — which is what makes the baseline below count the refreshes and
    // nothing else. The barrier is the gate's own coalescing seam, never elapsed
    // quiet: a quiet window is exactly what a loaded runner breaks.
    await awaitIssuesGateSettled(checkout);
    await settleStartup(calls);
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

// S10 (T8) / PR #89: the child count a refresh is measured by must be the
// refresh's OWN children. The session gate is dispatched startup work, so its two
// identity probes land whenever the host gets to them — and on the loaded CI
// runner that produced `expected 1, actual 3` they landed inside the measured
// window, after a quiet call list had been taken as "startup is over". The gate's
// answers are slowed here exactly where a loaded runner slows them (its first
// child), which makes the window deterministic instead of machine-dependent: no
// quiet window can fall between `gh api user` and `gh repo view`, so an
// unguarded baseline always miscounts. The rail itself reads ONCE.
test('S10 (T8): the dispatched session gate never inflates the rail read\'s child count (PR #89)', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
      calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
      if (argv[0] === 'api' && argv[1] === 'user') {
        // The gate's first child straddles the quiet window a barrier-free baseline
        // uses, so its SECOND child (`gh repo view`, spawned only once this one
        // answers) lands after that baseline — exactly what a loaded CI runner did
        // to this count.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return okJson('{"login":"me"}');
      }
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return okJson(JSON.stringify({ nameWithOwner: 'original/project' }));
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        // The rail's own read answers last, so the frame below cannot be drawn
        // before the gate's second child has reached the runner.
        await new Promise((resolve) => setTimeout(resolve, 80));
        return okJson(JSON.stringify(relatedAnswer({
          assigned: [
            { number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' },
            { number: 12, title: 'Twelve', updatedAt: '2024-02-01T00:00:00Z' },
          ],
        })));
      }
      return okJson('');
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    assert.equal(registered.length, 1);
    const section = registered[0];

    // The barrier the counting test uses: the gate's own coalesced question, asked
    // from here, so its children have landed before the baseline is taken.
    await awaitIssuesGateSettled(checkout);
    await settleStartup(calls);
    const baseline = calls.length;

    const rows = await waitForRows(section, ctx);
    assert.deepEqual(rows.map((row) => row.label), ['#12 Twelve', '#11 Eleven']);
    assert.equal(calls.length - baseline, 1, 'the refresh spawns exactly ONE gh child');
    assert.equal(graphqlCalls(calls).length, 1, 'and that child is the ONE combined read');
    assert.equal(graphqlCalls(calls).length, calls.length - baseline,
      'so nothing the session gate dispatches is counted as the rail\'s read');
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
    assert.equal(issuesCount(section.meta(ctx)), '1 issues');
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
    assert.equal(issuesCount(section.meta(ctx)), '2 issues');

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

// S4 (issues-startup-performance T3, L7): a session boundary is NOT a cache
// boundary. `session_shutdown` still drops the section's snapshot (no frame drawn
// afterwards shows the ended session's rows) and still advances the cache
// generation (an answer the ended session is holding lands nowhere) — but the
// ENTRIES stay, so the next session's first read is a delta instead of a full
// re-read. Before T3 the shutdown cleared them and this test asserted a full read.
test('S4 (T3): the cache survives a session_shutdown/start pair, so the next read is a delta', async () => {
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
  assert.equal((graphqlQueryOf(graphqlCalls(calls)[0]).match(/first: 100/g) || []).length, 3,
    'the first read of a cold cache is the full one');

  await fireHook(loaded.hooks, 'session_shutdown', ctx);
  assert.equal(section.meta(ctx), undefined,
    'the snapshot is still dropped: no frame drawn afterwards shows the ended rows');

  await fireSessionStart(loaded.hooks, ctx);
  // T18 (S11): the shutdown disposed the ended section, so the new session's
  // boundary binds the rail again; its fresh section is the one that reads.
  const resumed = registered[registered.length - 1];
  assert.notEqual(resumed, section, 'the new session binds the rail again');
  resumed.lines(ctx);
  await waitFor(() => graphqlCalls(calls).length === 2, 'the new session never read its issues');
  const query = graphqlQueryOf(graphqlCalls(calls)[1]);
  assert.equal((query.match(/first: 20/g) || []).length, 3,
    'the surviving entry answers a delta plan, so the new session asks only for the newest rows');
});

// ---------------------------------------------------------------------------
// T15 (S3, S6, S9; verify round 3): the deferred refresh and the cache that
// feeds it are now held to the same latest-wins discipline the snapshot already
// had. One RED test per reproduced defect, through the public surface only.
// ---------------------------------------------------------------------------

test('S3 (T15): a failed refresh starts the activity floor, so the same instant starts nothing', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    let fail = false;
    ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
      calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        if (fail) return { status: 1, stdout: '', stderr: 'HTTP 502: bad gateway', error: null };
        return okJson(JSON.stringify(relatedAnswer({
          assigned: [{ number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' }],
        })));
      }
      return okJson('');
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    const section = registered[0];
    await waitForRows(section, ctx);
    assert.equal(graphqlCalls(calls).length, 1, 'the drawn frame made its one read');

    // 30 s after that success the floor allows the activity refresh, and THIS
    // attempt fails.
    fail = true;
    offset = 30000;
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await waitFor(() => graphqlCalls(calls).length === 2, 'the failing activity refresh never ran');
    await waitFor(() => String(section.meta(ctx)).includes('· stale'), 'the failure never reported stale');

    // The failed ATTEMPT is what starts the floor: at this same instant nothing
    // may start another read.
    const before = graphqlCalls(calls).length;
    await fireHook(loaded.hooks, 'turn_end', ctx);
    await fireHook(loaded.hooks, 'before_agent_start', ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(calls).length, before,
      'a failed attempt starts the floor, so no activity retries the same instant');
  } finally {
    Date.now = realNow;
  }
});

test('S3 (T15): after a failed refresh the frame TTL is measured from the attempt, not the last success', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const checkout = makeCheckout();
    const { registered } = installBridge();
    const loaded = await loadExtension({});
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const calls = [];
    let fail = false;
    ghIssues.setGhRunner(async (_bin, argv, runOpts = {}) => {
      calls.push({ argv: argv.slice(), env: { ...(runOpts.env || {}) }, cwd: runOpts && runOpts.cwd });
      if (argv[0] === 'api' && argv[1] === 'user') return okJson('{"login":"me"}');
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return okJson(JSON.stringify({ nameWithOwner: 'myfork/project' }));
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        if (fail) return { status: 1, stdout: '', stderr: 'HTTP 502: bad gateway', error: null };
        return okJson(JSON.stringify(relatedAnswer({
          assigned: [{ number: 11, title: 'Eleven', updatedAt: '2024-01-01T00:00:00Z' }],
        })));
      }
      return okJson('');
    });

    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    const section = registered[0];
    await waitForRows(section, ctx);
    assert.equal(graphqlCalls(calls).length, 1, 'the first read succeeded');

    // One minute after the success the frame TTL starts a refresh that fails.
    fail = true;
    offset = 61000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(calls).length === 2, 'the failed TTL refresh never ran');
    await waitFor(() => String(section.meta(ctx)).includes('· stale'), 'the failure never reported stale');

    // A frame at that same instant must not queue a retry: the TTL runs from the
    // failed attempt, not from the success that preceded it.
    const before = graphqlCalls(calls).length;
    section.lines(ctx);
    section.lines(ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(graphqlCalls(calls).length, before,
      'the frame TTL waits for the ten-minute-style window from the attempt, never a tight retry');
  } finally {
    Date.now = realNow;
  }
});

test('S3 (T15): a refresh queued before invalidate() or dispose() never reads', async () => {
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
  });

  // The drawn frame queues the section's own refresh on the injected scheduler.
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'the stale frame queued one refresh');
  handle.invalidate();
  await sched.flush();
  assert.equal(loads, 0, 'a callback queued before invalidate() started no read');

  // The same holds for a callback queued before dispose().
  handle.section.lines({});
  assert.equal(sched.pending(), 1, 'the new frame queued its own refresh');
  handle.dispose();
  await sched.flush();
  assert.equal(loads, 0, 'a callback queued before dispose() started no read');
});

test('S3 (T15): a refresh queued before session_shutdown reads nothing and repaints nothing', async () => {
  const checkout = makeCheckout();
  const { registered, repaints } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub({
    issues: [{ number: 11, title: 'Eleven', state: 'OPEN', updatedAt: '2024-01-01T00:00:00Z' }],
  });
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: checkout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  const section = registered[0];

  // The frame queues its refresh on the host's macrotask scheduler; the session
  // ends synchronously, before that callback can run.
  section.lines(ctx);
  await fireHook(loaded.hooks, 'session_shutdown', ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(graphqlCalls(gh.calls).length, 0, 'the queued callback never starts a read');
  assert.deepEqual(repaints, [], 'and it never repaints a torn-down host');
});

test('S9 (T15): a read in flight at session_shutdown never repopulates the cache', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));

  // Every combined read is HELD, so the test decides when each one answers.
  const lists = [];
  ghIssues.setGhRunner((_bin, argv, runOpts = {}) => {
    const env = runOpts.env || {};
    if (argv[0] === 'api' && argv[1] === 'user') return Promise.resolve(okJson('{"login":"me"}'));
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return Promise.resolve(okJson(JSON.stringify({ nameWithOwner: 'original/project' })));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const entry = { repo: env.GH_REPO, query: graphqlQueryOf({ argv }), settle: null };
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
  const section = registered[0];
  section.lines(ctx);
  await waitFor(() => lists.length === 1, 'the drawn section never read its issues');

  // The session ends while its read is still in flight.
  await fireHook(loaded.hooks, 'session_shutdown', ctx);

  // The read that outlived the session answers NOW: it must not write the cache
  // shutdown just cleared.
  lists[0].settle(relatedAnswer({
    assigned: [{ number: 11, title: 'Gone eleven', updatedAt: '2024-01-01T00:00:00Z' }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  // A new session on the same checkout draws: an emptied cache means its first
  // read is the full one. T18 (S11): shutdown disposed the previous section, so
  // the new session's boundary binds a fresh one; that is the section it draws.
  await fireSessionStart(loaded.hooks, ctx);
  const resumed = registered[registered.length - 1];
  assert.notEqual(resumed, section, 'the new session binds the rail again');
  resumed.lines(ctx);
  await waitFor(() => lists.length === 2, 'the new session never read its issues');
  assert.equal((lists[1].query.match(/first: 100/g) || []).length, 3,
    'the shut-down read never repopulated the cache, so the next refresh is a full read');

  lists[1].settle(relatedAnswer({
    assigned: [{ number: 22, title: 'New twenty-two', updatedAt: '2024-02-01T00:00:00Z' }],
  }));
  await waitFor(
    () => resumed.lines(ctx).some((row) => row.label === '#22 New twenty-two'),
    'the new session never painted its own rows',
  );
  assert.ok(!resumed.lines(ctx).some((row) => row.label === '#11 Gone eleven'),
    "the ended session's answer never became cached rows");
});

test('S6/S9 (T16): a checkout switch cuts the previous read out of the cache', async () => {
  // Two checkouts of the SAME repository: the identity keys the cache, so this is
  // the case where a stale answer can seed the repository the session moved to.
  const firstCheckout = makeCheckout();
  const secondCheckout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));

  const lists = [];
  ghIssues.setGhRunner((_bin, argv, runOpts = {}) => {
    const env = runOpts.env || {};
    if (argv[0] === 'api' && argv[1] === 'user') return Promise.resolve(okJson('{"login":"me"}'));
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return Promise.resolve(okJson(JSON.stringify({ nameWithOwner: 'original/project' })));
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const entry = { repo: env.GH_REPO, query: graphqlQueryOf({ argv }), settle: null };
      entry.answer = new Promise((resolve) => {
        entry.settle = (payload) => resolve(okJson(JSON.stringify(payload)));
      });
      lists.push(entry);
      return entry.answer;
    }
    return Promise.resolve(okJson(''));
  });

  const ctxA = { cwd: firstCheckout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctxA);
  const section = registered[0];
  section.lines(ctxA);
  await waitFor(() => lists.length === 1, 'the drawn section never read its issues');

  // The session moves to another checkout of the same repository while A's read
  // is still in flight.
  const ctxB = { cwd: secondCheckout, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctxB);

  // A's answer lands after the move: the section discarded it, so the cache must
  // not adopt it either.
  lists[0].settle(relatedAnswer({
    assigned: [{ number: 11, title: 'Left behind', updatedAt: '2024-01-01T00:00:00Z' }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  section.lines(ctxB);
  await waitFor(() => lists.length === 2, 'the moved session never read its issues');
  assert.equal((lists[1].query.match(/first: 100/g) || []).length, 3,
    "the abandoned checkout's answer never seeded the cache, so the moved session starts with a full read");

  lists[1].settle(relatedAnswer({
    assigned: [{ number: 22, title: 'Fresh twenty-two', updatedAt: '2024-02-01T00:00:00Z' }],
  }));
  await waitFor(
    () => section.lines(ctxB).some((row) => row.label === '#22 Fresh twenty-two'),
    'the moved session never painted its own rows',
  );
  assert.ok(!section.lines(ctxB).some((row) => row.label === '#11 Left behind'),
    "the previous checkout's rows never survive the move");
  assert.equal(issuesCount(section.meta(ctxB)), '1 issues', 'the header counts only the moved session rows');
});

// T10 (S9): the pre-dispatch proof E18 described is gone, so there is no window
// in which a proof can outlive its session. The click is synchronous: it answers
// before any session boundary can move, and the number alone travels — the panel
// is the one surface that pins and proves the repository it opens. This states
// the removal, so a proof creeping back onto the click path fails here.
test('S9 (T10): the click path holds no proof a session move could outlive', async () => {
  const checkoutA = makeCheckout([['origin', 'git@github.com:myfork/project.git']]);
  const checkoutB = makeCheckout([['origin', 'git@github.com:myfork/project.git']]);
  const sent = [];
  const dispatch = { sendUserMessage: (text, opts) => { sent.push({ text, opts }); } };
  const { mod, hooks } = await loadSeam(dispatch);
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  ghIssues.setGhRunner(sectionGithub({ repoView: 'myfork/project' }).runner);
  await fireSessionStart(hooks, { cwd: checkoutA, ui: { notify: () => {} } });

  const worktreeGit = require(path.join(LIB_DIR, 'worktree-git.js'));
  const original = worktreeGit.runArgvAsync;
  const held = [];
  worktreeGit.runArgvAsync = async (bin, argv, opts) => {
    if (bin === 'git' && argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') {
      held.push({ bin, argv: argv.slice() });
    }
    return original(bin, argv, opts);
  };
  try {
    // The click answers BEFORE the session moves, and it proves nothing: no
    // checkout probe runs on the click path at all.
    const outcome = mod.dispatchIssuesPanel(dispatch, 11, 'github.com/myfork/project');
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(sent, [{ text: '/issues 11', opts: { expandPromptTemplates: true } }],
      'the click dispatched its issue');
    assert.deepEqual(held, [], 'no checkout proof ran on the click path');
    // The session then moves. Its own startup work may well read the checkout —
    // that is the session's start, not the click — and the dispatch is untouched:
    // nothing re-sends it and nothing drops it.
    await fireSessionStart(hooks, { cwd: checkoutB, ui: { notify: () => {} } });
    assert.equal(sent.length, 1, 'a later session move never re-dispatches or drops it');
  } finally {
    worktreeGit.runArgvAsync = original;
  }
});

// ---------------------------------------------------------------------------
// T2 (S3) and T3 (S4): what a session costs outside a repository, and how long
// the read cache lives.
// ---------------------------------------------------------------------------

// S3 (T2): a cwd outside a repository is stated, not probed. The rail's own read
// already answers the short dim line without a `gh` child; the session gate used
// to probe `gh` there anyway (two children per session start), which is exactly
// the "no frequent checks" the user asked to stop.
test('S3 (T2): a session outside a repository paints the dim row and spawns no gh child', async () => {
  const outside = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-outside-')));
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
  const gh = sectionGithub();
  ghIssues.setGhRunner(gh.runner);

  const ctx = { cwd: outside, ui: { notify: () => {} } };
  await fireSessionStart(loaded.hooks, ctx);
  const rows = await waitForRows(registered[0], ctx);
  assert.deepEqual(rows, [{ label: 'not a git repository', tone: 'dim' }],
    'one dim row, never the error tone');
  assert.equal(registered[0].meta(ctx), undefined, 'and no count');

  // The session gate runs off the awaited startup path now, so it gets its own
  // window before "spawned nothing" is asserted.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(gh.calls, [],
    'no gh child and no network call at all: the checkout answers this, and the gate never asks gh either');
});

// S4 (T3): the entries also outlive the PROCESS. A new load is a new in-process
// cache, so the identity is hydrated from the disk half under
// `$XDG_CACHE_HOME/odd-worktree/` before `plan`, and the first read is a delta.
test('S4 (T3): a warm identity survives a process restart, so its first read is a delta', async () => {
  const cacheHome = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-warm-home-')));
  const savedCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    const checkout = makeCheckout();
    const row = { number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' };

    // One process: load the extension, draw the rail, shut the session down.
    const runProcess = async () => {
      const { registered } = installBridge();
      const loaded = await loadExtension({});
      ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
      const gh = sectionGithub({ issues: [row] });
      ghIssues.setGhRunner(gh.runner);
      const ctx = { cwd: checkout, ui: { notify: () => {} } };
      await fireSessionStart(loaded.hooks, ctx);
      await waitForRows(registered[0], ctx);
      // S4 (T3 correction): the write is fired, never awaited by the read, so the
      // test waits for the document it produces — the one observable the next
      // process reads.
      await waitFor(
        () => fs.existsSync(path.join(cacheHome, 'odd-worktree', 'issues-cache.json')),
        'the disk half never wrote its document',
      );
      await fireHook(loaded.hooks, 'session_shutdown', ctx);
      return graphqlCalls(gh.calls);
    };

    const firstReads = await runProcess();
    assert.equal(firstReads.length, 1);
    assert.ok(graphqlQueryOf(firstReads[0]).includes('first: 100'), 'a cold process reads everything');

    const secondReads = await runProcess();
    assert.equal(secondReads.length, 1);
    assert.ok(graphqlQueryOf(secondReads[0]).includes('first: 20'),
      'the restarted process hydrates the identity from disk before `plan`, so it only asks for the delta');
  } finally {
    if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedCacheHome;
  }
});

// S4 (T3): persistence never defeats the correctness rules the in-memory cache
// already enforces. An entry that is `inconsistent` (its rows no longer match the
// count the response reported) or older than the full-read TTL is NOT hydrated,
// so `plan` still answers the full read it always did.
test('S4 (T3): a stored entry past its full TTL, or inconsistent, is still read whole', async () => {
  const cacheHome = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-issues-stale-home-')));
  const savedCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    const checkout = makeCheckout();
    const row = { number: 11, title: 'Assigned one', state: 'OPEN', updatedAt: '2024-05-01T00:00:00Z' };
    const { createIssuesCacheStore } = require('../lib/issues-cache-store.js');
    const seeded = createIssuesCacheStore({ dir: path.join(cacheHome, 'odd-worktree') });
    const seed = (overrides) => seeded.save(IDENTITY, {
      buckets: { mine: [], assigned: [row], involved: [] },
      counts: { mine: 0, assigned: 1, involved: 0 },
      truncated: { mine: false, assigned: false, involved: false },
      inconsistent: false,
      full: true,
      syncedAt: Date.now(),
      lastApplied: 1,
      ...overrides,
    });

    const readQuery = async () => {
      const { registered } = installBridge();
      const loaded = await loadExtension({});
      ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
      const gh = sectionGithub({ issues: [row] });
      ghIssues.setGhRunner(gh.runner);
      const ctx = { cwd: checkout, ui: { notify: () => {} } };
      await fireSessionStart(loaded.hooks, ctx);
      await waitForRows(registered[0], ctx);
      return graphqlQueryOf(graphqlCalls(gh.calls)[0]);
    };

    await seed({ syncedAt: Date.now() - 3600000 });
    assert.ok((await readQuery()).includes('first: 100'),
      'an entry older than the full-read TTL is re-read whole, exactly like the in-memory cache plans it');

    await seed({ inconsistent: true });
    assert.ok((await readQuery()).includes('first: 100'),
      'an inconsistent entry is never trusted for a total either');
  } finally {
    if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedCacheHome;
  }
});

// S4 (T3, correction): the disk half is FIRE AND FORGET. The read has already
// answered — `apply` made it visible in memory — so waiting for a file write puts
// the filesystem back on the rail's path: the section's own `running` gate refuses
// to schedule while a read is in flight, so one slow or stalled write postpones
// every later read and the rail paints late. The two tests below hold the write
// and watch what the rail does while it never settles.
test('S4 (T3): a held save defers no read, and the newest entry waits behind it instead of interleaving', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  // The extension's OWN disk half, held: nothing is written until the test says so.
  // The module instance is required AFTER the load (the load purges the lib cache
  // once), so this is the very object the extension's `libRequire` gets.
  const store = require(path.join(LIB_DIR, 'issues-cache-store.js'));
  const originalFactory = store.createIssuesCacheStore;
  const saves = [];
  const held = [];
  store.createIssuesCacheStore = () => ({
    load: async () => null,
    directory: () => null,
    save: (identity, snapshot) => {
      saves.push({ identity, snapshot });
      return new Promise((resolve) => { held.push(resolve); });
    },
  });
  try {
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const gh = sectionGithub({
      issues: [
        { number: 11, title: 'Eleven', state: 'OPEN', updatedAt: '2024-01-01T00:00:00Z' },
        { number: 12, title: 'Twelve', state: 'OPEN', updatedAt: '2024-02-01T00:00:00Z' },
      ],
    });
    ghIssues.setGhRunner(gh.runner);
    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    const section = registered[0];

    // 1) The first answer paints although its write has not settled: the read path
    // never waits for the disk.
    const rows = await waitForRows(section, ctx);
    assert.deepEqual(rows.map((row) => row.label), ['#12 Twelve', '#11 Eleven'],
      'the read settles and the rail paints while the disk half is still pending');
    assert.equal(saves.length, 1, 'the answer was still offered to the disk half');
    assert.equal(saves[0].identity, IDENTITY, 'for the identity the read was proven against');
    assert.equal(held.length, 1, 'and that one write is the one in flight');

    // 2) A held write is not a running READ: the next stale frame starts its own
    // read on time instead of queueing behind the filesystem.
    offset = 61000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === 2,
      'a held save blocked the next read');
    assert.deepEqual(section.lines(ctx).map((row) => row.label), ['#12 Twelve', '#11 Eleven'],
      'and the rail keeps painting the rows the cache holds');
    assert.equal(saves.length, 1,
      'the second answer is COALESCED behind the write in flight — never a second interleaved save');

    // 3) When the held write settles, the newest entry is the very next thing
    // written, so the stalled save cost the file nothing.
    held[0](true);
    await waitFor(() => saves.length === 2, 'the coalesced entry never followed the held one');
    assert.equal(saves[1].snapshot.lastApplied, 2, 'the write that follows carries the LATEST read');
    assert.equal(held.length, 2, 'exactly one write is in flight again — never two');

    // 4) And a save that NEVER settles defers nothing either: the third stale frame
    // still reads, and the stalled write keeps the only in-flight slot.
    offset = 122000;
    section.lines(ctx);
    await waitFor(() => graphqlCalls(gh.calls).length === 3,
      'a save that never settles blocked a later read');
    assert.equal(saves.length, 2, 'a stalled write accumulates no second save');
  } finally {
    store.createIssuesCacheStore = originalFactory;
    Date.now = realNow;
  }
});

test('S4 (T3): a save that REJECTS never escapes as an unhandled rejection and never blocks the rail', async () => {
  const checkout = makeCheckout();
  const { registered } = installBridge();
  const loaded = await loadExtension({});
  // The extension's OWN disk half, refusing every write.
  const store = require(path.join(LIB_DIR, 'issues-cache-store.js'));
  const originalFactory = store.createIssuesCacheStore;
  store.createIssuesCacheStore = () => ({
    load: async () => null,
    directory: () => null,
    save: async () => { throw new Error('EACCES: the cache directory is not writable'); },
  });
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    ghIssues = require(path.join(LIB_DIR, 'gh-issues.js'));
    const gh = sectionGithub({
      issues: [{ number: 11, title: 'Eleven', state: 'OPEN', updatedAt: '2024-01-01T00:00:00Z' }],
    });
    ghIssues.setGhRunner(gh.runner);
    const ctx = { cwd: checkout, ui: { notify: () => {} } };
    await fireSessionStart(loaded.hooks, ctx);
    const rows = await waitForRows(registered[0], ctx);
    assert.deepEqual(rows.map((row) => row.label), ['#11 Eleven'],
      'a write that cannot be committed costs the entry, never the read');
    // Two turns of the loop is enough for a rejected save to surface if it were
    // going to: it never does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, [], 'a refused save is silence, not an unhandled rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    store.createIssuesCacheStore = originalFactory;
  }
});

// ---------------------------------------------------------------------------
// T8b (S4): the header's `pr` count is EXACT, and a cold start paints it from
// the disk at once.
//
// D8: the rail's read reports an exact `issueCount` per bucket while carrying at
// most a window of rows. The count is the distinct numbers in mine ∪ review PLUS
// the remainder of each bucket's total — the numbers the answer never carried,
// which cannot be deduplicated against anything and so are counted one by one.
// It is never less than what is known: a total below the rows it came with, a
// hostile total, or no total at all leaves the distinct count alone.
//
// D9: `hydratePullRequests` is the stored entry's own seam. The section asks it
// only from a read it already dispatched (never from a frame, never from a
// session path), paints it only while no read has painted a count yet, and the
// live answer always replaces it. The stored entry never settles the read: the
// live read is asked every time its own TTL says so, and a settled state — no
// repository proof — reads no entry at all.
// ---------------------------------------------------------------------------

// `total` is the bucket's exact `issueCount`, which the window of `rows` may
// under-represent.
function countedBuckets(buckets, totals) {
  return async () => ({
    ok: true,
    mine: (buckets.mine || []).map((number) => ({ number, linkedIssues: [] })),
    review: (buckets.review || []).map((number) => ({ number, linkedIssues: [] })),
    counts: totals,
  });
}

test('S4 (T8b, D8): the pr count adds each bucket\'s unfetched remainder', async () => {
  const numbers = Array.from({ length: 50 }, (_, index) => index + 1);
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    // The verifier's own case: `issueCount=51` with 50 nodes and an empty
    // review painted `2 issues · 50 pr`, dropping the one row the window cut.
    loadPullRequests: countedBuckets({ mine: numbers, review: [] }, { mine: 51, review: 0 }),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();

  assert.equal(handle.section.meta({}), '2 issues · 51 pr',
    'the unfetched remainder of a bucket counts too, so the header is never short');
});

test('S4 (T8b, D8): remainders are added per bucket, and no total can lower the count', async () => {
  const mine = Array.from({ length: 50 }, (_, index) => index + 1);
  const overlapping = createIssuesSection({
    load: readyLoad(issueList(2)),
    // Two buckets, both cut: 50 fetched (1..50) + 69 = 51 distinct numbers, plus
    // one remainder each — 69 shared with nothing, since a remainder's number was
    // never carried.
    loadPullRequests: countedBuckets({ mine, review: [50, 69] }, { mine: 51, review: 3 }),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await overlapping.refresh();
  await settleFrames();
  assert.equal(overlapping.section.meta({}), '2 issues · 53 pr',
    'each bucket\'s remainder counts, and the fetched numbers still dedupe');

  const hostile = createIssuesSection({
    load: readyLoad(issueList(2)),
    // A total BELOW the rows it came with, and a total that is not a count at
    // all: neither is trusted, and neither can shrink what the rows prove.
    loadPullRequests: countedBuckets({ mine, review: [69] }, { mine: 3, review: 'many' }),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await hostile.refresh();
  await settleFrames();
  assert.equal(hostile.section.meta({}), '2 issues · 51 pr',
    'the distinct numbers stay the floor, whatever a total claims');
});

test('S4 (T8b, D9): a cold start paints the stored count while the live read is held, and the live answer replaces it', async () => {
  const pending = [];
  const hydrated = [];
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    hydratePullRequests: async (identity) => {
      hydrated.push(identity);
      return { mine: [{ number: 69, linkedIssues: [1] }], review: [], syncedAt: 1 };
    },
    loadPullRequests: () => new Promise((resolve) => pending.push(resolve)),
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();

  assert.deepEqual(hydrated, [IDENTITY], 'the entry is asked for the identity the issues read proved');
  assert.equal(handle.section.meta({}), '2 issues · 1 pr',
    'the stored count paints at once, before the live read answers');

  pending.shift()(railBuckets({ mine: [69, 70] }));
  await settleFrames();
  assert.equal(handle.section.meta({}), '2 issues · 2 pr', 'the live answer replaces the stored one');
});

test('S4 (T8b, D9): the stored entry never settles the read, and a failed live read keeps its count', async () => {
  const pending = [];
  let hydrations = 0;
  let liveReads = 0;
  let failNext = false;
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    hydratePullRequests: async () => {
      hydrations += 1;
      return { mine: [{ number: 69, linkedIssues: [] }], review: [], syncedAt: 1 };
    },
    loadPullRequests: () => {
      liveReads += 1;
      if (failNext) return { ok: false, error: 'gh timed out' };
      return new Promise((resolve) => pending.push(resolve));
    },
    open: () => {},
    openAll: () => {},
    // `ttlMs: 0` makes every attempt stale, so the second refresh asks again.
    ttlMs: 0,
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();
  assert.equal(liveReads, 1, 'a stored entry does not defeat the live read: it was asked anyway');
  assert.equal(handle.section.meta({}), '2 issues · 1 pr');
  pending.shift()(railBuckets({ mine: [69, 70] }));
  await settleFrames();
  assert.equal(handle.section.meta({}), '2 issues · 2 pr');

  failNext = true;
  await handle.refresh();
  await settleFrames();
  assert.equal(liveReads, 2, 'the next attempt asks the live read again, stored entry or not');
  assert.equal(hydrations, 1, 'nothing is hydrated over a count that is already painted');
  assert.equal(handle.section.meta({}), '2 issues · 2 pr', 'a failed read keeps the count it had');
});

test('S4 (T8b, D9): a settled state reads no stored entry at all', async () => {
  let hydrations = 0;
  let liveReads = 0;
  const handle = createIssuesSection({
    load: async () => ({ ok: false, error: 'not a git repository', errorTone: 'dim' }),
    hydratePullRequests: async () => {
      hydrations += 1;
      return { mine: [{ number: 69, linkedIssues: [] }], review: [], syncedAt: 1 };
    },
    loadPullRequests: async () => {
      liveReads += 1;
      return railBuckets({ mine: [69] });
    },
    open: () => {},
    openAll: () => {},
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();

  assert.deepEqual(handle.section.lines({}), [{ label: 'not a git repository', tone: 'dim' }]);
  assert.equal(hydrations, 0, 'a settled state hydrates nothing from the disk');
  assert.equal(liveReads, 0, 'and reads no pull requests');
  assert.equal(handle.section.meta({}), undefined, 'nor paints a count it was never given');
});

// ---------------------------------------------------------------------------
// T10b (S4): D9 — both settlements of the pull-request read repaint the header.
//
// The issues read already asks the section's own notifier for a repaint when it
// lands (`replace()` reads `onRefreshed`). The `pr` count is painted from a
// SECOND state, so its two settlements — the stored entry from the disk and the
// live answer — must ask for the same repaint, or the header keeps its old count
// until some unrelated event produces a frame. A frame asks for none: the
// notifier is reached from a landed read alone (invariants 24-28 keep every
// session path and every frame free of the read), and a disposed or superseded
// section still repaints nothing.
// ---------------------------------------------------------------------------

test('S4 (T10b, D9): the live pull-request settlement asks for one repaint, and a frame asks for none', async () => {
  const pending = [];
  let repaints = 0;
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    loadPullRequests: () => new Promise((resolve) => pending.push(resolve)),
    open: () => {},
    openAll: () => {},
    onRefreshed: () => { repaints += 1; },
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();
  assert.equal(handle.section.meta({}), '2 issues', 'the issues read painted its own header, with no `pr` count yet');
  const painted = repaints;

  // The two drawing calls are frames over the in-process snapshot: neither is a
  // reason to repaint anything.
  handle.section.lines({});
  handle.section.meta({});
  await settleFrames();
  assert.equal(repaints, painted, 'a frame never asks for a repaint');

  pending.shift()(railBuckets({ mine: [69] }));
  await settleFrames();
  assert.equal(repaints, painted + 1, 'the settled pull-request read repaints the header it changed');
  assert.equal(handle.section.meta({}), '2 issues · 1 pr', 'and the repaint is what the new count is painted by');
});

test('S4 (T10b, D9): the hydration asks for one repaint when the stored count paints', async () => {
  let settleStored = null;
  let repaints = 0;
  const handle = createIssuesSection({
    load: readyLoad(issueList(2)),
    hydratePullRequests: () => new Promise((resolve) => { settleStored = resolve; }),
    loadPullRequests: () => new Promise(() => {}),
    open: () => {},
    openAll: () => {},
    onRefreshed: () => { repaints += 1; },
    schedule: (fn) => { fn(); },
  });
  await handle.refresh();
  await settleFrames();
  assert.equal(typeof settleStored, 'function', 'the dispatched read asked the disk for the stored entry');
  assert.equal(handle.section.meta({}), '2 issues', 'nothing was painted from the disk yet');
  const painted = repaints;

  settleStored({ mine: [{ number: 69, linkedIssues: [] }], review: [], syncedAt: 1 });
  await settleFrames();
  assert.equal(repaints, painted + 1, 'the hydration repaints the header it just painted from the disk');
  assert.equal(handle.section.meta({}), '2 issues · 1 pr');

  // A state that keeps its count (`stale`) repaints nothing on top of a refusal
  // that has nothing to paint: the settled section is not a reason to paint.
  handle.dispose();
  const afterDispose = repaints;
  await settleFrames();
  assert.equal(repaints, afterDispose, 'a disposed section repaints nothing');
});

'use strict';
// The checkout's issues as a gentle-shell rail section (odd/tasks/
// issues-sidebar.md, T1: S1, S3, S4, S5; S7/T8 of rail-cards-fixes merged the
// authored `mine` bucket into the assigned one).
//
// Pure and injectable: a reader (`load`), two openers (`open`, `openAll`), a
// clock, a scheduler and a repaint callback all arrive as options, so nothing
// here imports another lib module, runs a child process or reads the clock on
// its own. The shell API calls `lines(ctx)`/`meta(ctx)` once per frame and both
// must return synchronously: they read ONE in-process snapshot and only ever
// SCHEDULE the refresh, so a frame never waits on `gh`.
//
// ONE source (`load` answers `{ ok, identity, issues, truncated }`): ONE merged
// list of the checkout repository's OPEN issues the viewer authored and the ones
// they are assigned, deduplicated by issue number by the caller that owns the
// read. A row is its label and its one pull-request number mark (S8/T9, drawn as
// `\ue726 #69` by S7/T5), never a relation; the header reports the merged count
// alone (`8 issues`, `8 issues · stale`), because the rail never separates `mine`
// from `assigned`. The heading reads `GITHUB` (S12/T10).
//
// `load` may also answer `{ ok: false, error, errorTone: 'dim' }` for a state
// that is not an error at all — a cwd outside a repository — so that one line is
// gray instead of red (S12/T11). A toned state is SETTLED (S3/T2 of
// issues-startup-performance): there is nothing to check outside a repository, so
// no later frame and no activity read retries it — only a session boundary
// supersedes it, exactly like the snapshot it replaced.
//
// Rows are ordered by `updatedAt` descending and the body paints at most SEVEN
// of them; when the read produced more, ONE eighth row in the `dim` tone reads
// `and N more issues`, `N` being the issues beyond the seven and written `N+`
// when the read reached its fetch bound (so the real total is larger). That
// keeps the body at the host's eight-row maximum, which is why the shell API's own
// inert `… +N more` elision never appears. The overflow row opens the `/issues`
// panel through the `openAll` seam.
//
// A row's `onClick` defers its opener onto the scheduler: it never runs on the
// paint path, it runs once per click, and a throw, a rejected promise or a
// resolved `{ ok: false, error }` is recorded in the snapshot's `error` instead
// of escaping into the host. The identity the row was BUILT from travels with
// it (`open(number, identity, bucket, generation)`), so a row the host retains
// across a checkout change still opens the repository it was read from instead of
// whatever snapshot is current when the human clicks — and the generation its read
// was taken under travels too, so a click the host retained across a session
// boundary cannot claim the repository of a session that has ended. Every state is
// a row — `loading…`, `no open issues`, ONE error row — and neither `lines()` nor
// `meta()` ever throws. Only `lines()` ever schedules a READ: a collapsed section
// draws solely its heading through `meta()`, so it reads nothing. What both
// drawing calls do own is the floor timer below (S10/T8), which a collapsed but
// drawn section keeps alive exactly like a drawn body — the heading is a frame the
// host painted, so the rail is on screen.
//
// A session that starts in ANOTHER checkout supersedes this one through
// `invalidate()`: the snapshot is dropped (the rail shows the loading row, never
// the previous repository's rows) and the latest-wins token moves on, so an
// answer the previous checkout's read delivers afterwards is discarded instead
// of applied. That drop is synchronous by design — the caller performs it the
// moment the session boundary fires.
//
// `refreshIfStale(maxAgeMs)` is the seam the caller's own activity uses: a frame
// only exists when the host has a reason to produce one, so the TTL on a drawn
// frame never fires on a session that is only being used. The caller asks for a
// read on the session's own activity behind a floor — but ONLY while the section
// is actually on screen: `lines()` and `meta()` are the drawing calls and each
// stamps WHEN it was last drawn, `drawnWithin(maxAgeMs)` answers whether a draw
// happened inside that window, and `invalidate()`/`dispose()` clear it. A hidden
// section therefore starts nothing at all: no child process, no network, no
// timer. The module reads no clock but the one it was injected with.
//
// S10 (T8, L9): the activity floor alone never refreshes an IDLE session, and the
// user's own words were "deberia ser algo que compruebe cada cierto tiempo nomas,
// como cada 10seg o 20seg". So a caller that names a `refreshFloorMs` gets the
// other half: while the section is DRAWN the module keeps ONE self-scheduled,
// unref'd timer at that floor, which fires one read, arms the next floor, and
// stops by itself once the section leaves the drawn window. It is armed by a
// draw, so a section nobody draws keeps no timer (S11) — and it is cleared by
// `invalidate()` and `dispose()`, which is what a session boundary performs.
//
// `forceRefresh(minIntervalMs)` is the second seam:
// ONE read the caller knows is worth starting right now (a `bash` command that
// mutated an issue or a pull request, S10/T9), bypassing the frame TTL and the
// activity floor but never the anti-storm cap the caller names.
//
// The module never leaves a timer or a state write behind after `dispose()`:
// whatever the read lands with is dropped silently.
//
// T4 (S4, S5): the rail reads the repository's PULL REQUESTS beside its issues.
// `loadPullRequests` is the second seam — shaped like `listRailPullRequests`,
// `{ ok, mine, review }`, each row a `{ number, linkedIssues }` — and it decides
// exactly two things. It names the header's `pr` count, the DISTINCT numbers in
// the union of the two buckets, so the row reads `7 issues · 3 pr` (`7 issues`
// alone while that read is unavailable, and `· stale` is still kept after the
// issues list stalls). And it routes a row's click: an issue the read marked
// with a pull request opens the PR panel on it, `review` beating `mine`, while a
// pull request in neither bucket is `all`. Both decisions are the rail's own —
// the seam costs no child on a frame, both reads obey the same TTL, the same
// self-scheduled floor and the same drawn window, and a failed pull-request read
// keeps the last count instead of blanking a number the human already had.

const DEFAULT_TTL_MS = 60000;
// S11: how long a section counts as DRAWN after its last frame when the module
// owns the time check itself. It is the caller's window unless it names one.
const DEFAULT_TIMER_DRAWN_WINDOW_MS = 120000;
// The host's body holds eight rows and the eighth is the overflow row, so a
// larger `maxRows` would push the shell API's own inert elision into play: the
// retained rows are capped one below the body.
const BODY_MAX_ROWS = 8;
const DEFAULT_MAX_ROWS = BODY_MAX_ROWS - 1;
const LOADING_ROW = { label: 'loading…', tone: 'dim' };
const EMPTY_ROW = { label: 'no open issues', tone: 'dim' };
// S8 (T9): the ONE mark a row can carry is the pull request's NUMBER, and S7
// (T5) puts the nerd-font pull-request glyph in front of it: `\ue726 #69`, the
// glyph, ONE space, `#` and the number. `meta` is the shell API's right-hand,
// right-aligned segment and it paints it in its own idle `muted` role
// (`lib/shell-api/section-panel.ts`, `IDLE_META_ROLE = 'muted'`), which
// IS the gray the user asked for — so the mark is gray while the row's `tone`
// stays the plain `text` and nothing paints the whole row gray to gray one
// segment. The number is the LAST associated pull request (the read hands it
// over already decided); no number, no mark. There is still exactly ONE click
// target on the line — the issue — because the shell API's `SectionRow` carries a
// single `onClick`, so a second target (the pull request in a browser) has no
// contract today. This is noted where the mark is built.
const PR_MARK_GLYPH = '\ue726';
const READ_FAILED = 'cannot read issues';
// T4 (S4): the second read's own failure sentence, kept beside the first one.
const PULL_REQUESTS_FAILED = 'cannot read pull requests';
// T12 (S4, L11) moved the row click's destination into the extension: the row
// dispatches `/issues <number>` and the panel proves its own repository, so the
// fallback line a failed click is recorded with no longer names a browser.
const OPEN_FAILED = 'cannot open the issue';
const OPEN_ALL_FAILED = 'cannot open the issues panel';

function textOf(value, fallback) {
  if (value && typeof value.message === 'string' && value.message.length > 0) return value.message;
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

function updatedAtValue(item) {
  const raw = item && typeof item === 'object' ? item.updatedAt : null;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function issueRows(issues, limit) {
  // Descending by the ISO `updatedAt`; a missing date sorts last, so the order
  // is deterministic across frames. S7 (T8): the read hands over one MERGED list
  // (mine + assigned, deduplicated by number), so the order here is the merged
  // order and the cap is the same seven.
  return issues
    .slice()
    .sort((left, right) => updatedAtValue(right) - updatedAtValue(left))
    .slice(0, limit)
    .map((item) => {
      const title = typeof item.title === 'string' ? item.title : '';
      // The ONE linked pull request the row knows: the same normalized number the
      // mark is drawn from, kept on the internal row (never on the painted one)
      // so the deferred click can route to it (T4, S5).
      const pullRequest = Number.isInteger(item.pullRequestNumber) && item.pullRequestNumber > 0
        ? item.pullRequestNumber
        : null;
      // `number` and `bucket` stay on the snapshot row so the deferred click
      // binds the issue AND the bucket it came from. The painted row below
      // exposes only its label, tone, click and — when its issue has a linked
      // pull request — that pull request's number as `meta`. A row without one
      // carries NO `meta` key at all, so nothing pends on `undefined` meaning the
      // same thing as absent.
      //
      // S8 (T9): the whole line keeps ONE click target, the issue itself. The
      // `#<number>` mark shares the row's single `onClick` because a
      // `SectionRow` has exactly one, so a click on the number opens the issue
      // too; the shell API has no per-segment handler to open the pull request
      // instead.
      const row = {
        label: `#${item.number} ${title}`,
        tone: 'text',
        onClick: null,
        number: item.number,
        bucket: item.bucket,
        pullRequest,
      };
      if (pullRequest !== null) {
        row.meta = `${PR_MARK_GLYPH} #${pullRequest}`;
      }
      return row;
    });
}

function overflowRow(hidden, truncated) {
  const suffix = truncated === true ? '+' : '';
  return { label: `and ${hidden}${suffix} more issues`, tone: 'dim', onClick: null };
}

function createIssuesSection(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const load = typeof opts.load === 'function' ? opts.load : null;
  // T4 (S4, S5): the second seam, optional exactly like `load`: a caller that
  // names none reads no pull requests and paints the header it always painted.
  const loadPullRequests = typeof opts.loadPullRequests === 'function' ? opts.loadPullRequests : null;
  // D9 (S4): the stored entry's seam, optional too. It answers the rows a
  // PREVIOUS process read for one repository identity, so a cold start paints
  // `N issues · M pr` while the live read is still in flight. It is where the
  // entry sleeps between processes, never what a read means: the section decides
  // when it is asked (from a dispatched read alone), when it may paint (only
  // while no read has painted a count) and that the live answer replaces it.
  const hydratePullRequests = typeof opts.hydratePullRequests === 'function' ? opts.hydratePullRequests : null;
  const open = typeof opts.open === 'function' ? opts.open : null;
  const openAll = typeof opts.openAll === 'function' ? opts.openAll : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : (fn) => setTimeout(fn, 0);
  // S10 (T8): the two timer seams, injected exactly like `schedule` so a test
  // drives the floor without waiting for it. No floor named, no timer: a caller
  // that only wants the frame TTL gets the module it always had.
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : (fn, ms) => setTimeout(fn, ms);
  const cancelTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : (timer) => clearTimeout(timer);
  const refreshFloorMs = Number.isFinite(opts.refreshFloorMs) && opts.refreshFloorMs > 0
    ? opts.refreshFloorMs
    : null;
  const timerDrawnWindowMs = Number.isFinite(opts.timerDrawnWindowMs) && opts.timerDrawnWindowMs >= 0
    ? opts.timerDrawnWindowMs
    : DEFAULT_TIMER_DRAWN_WINDOW_MS;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const requestedRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0
    ? Math.floor(opts.maxRows)
    : DEFAULT_MAX_ROWS;
  const maxRows = Math.min(requestedRows, DEFAULT_MAX_ROWS);
  const sectionId = typeof opts.sectionId === 'string' && opts.sectionId.length > 0 ? opts.sectionId : 'odd-worktree.issues';
  const title = typeof opts.title === 'string' && opts.title.length > 0 ? opts.title : 'GITHUB';
  const rowLabel = typeof opts.rowLabel === 'string' && opts.rowLabel.length > 0 ? opts.rowLabel : 'github';
  const onRefreshed = typeof opts.onRefreshed === 'function' ? opts.onRefreshed : null;

  let snapshot = null;
  // A refresh that is scheduled but has not started, and the one that runs.
  // Both are module state so two stale frames schedule ONE refresh and a frame
  // drawn while it runs schedules nothing. `runToken` is the latest-wins
  // boundary: an explicit refresh never coalesces onto an older in-flight run,
  // and a result from a run that is no longer the latest is dropped.
  let scheduled = false;
  let running = null;
  let runToken = 0;
  let disposed = false;
  // T15 (S3, defects 1 and 2): two facts the stale checks need besides the
  // snapshot. `lastAttemptAt` is when the last read SETTLED, success or failure,
  // so a failing `gh` starts the floor/TTL instead of being retried at the same
  // instant; `generation` is the token a DEFERRED refresh captured when it was
  // queued, so a callback that outlives `invalidate()`/`dispose()`/its checkout
  // starts no read at all. `snapshot.at` still means the last SUCCESSFUL read
  // (S5 keeps the stale header at that time) — the attempt time is separate.
  let lastAttemptAt = null;
  let generation = 0;
  // S3 amended (T13, L11): WHEN the section was last DRAWN. A hidden section
  // costs nothing, so the caller asks (`drawnWithin`) before an activity read and
  // reads only when the host actually painted the section recently. `lines()` and
  // `meta()` are the drawing calls, and a superseded (`invalidate()`) or disposed
  // section is showing nothing, so both clear it.
  let lastDrawnAt = null;
  // S10 (T8): the ONE self-scheduled floor timer, and the token that makes a
  // callback the host already queued inert once the timer was cleared.
  let timer = null;
  let timerToken = 0;
  // S10 (T9): when the last FORCED read started, so the caller's anti-storm cap
  // measures from it. Null until one runs.
  let lastForcedAt = null;
  // T4 (S4, S5): the pull-request read's own state, guarded and versioned exactly
  // like the issues read's. `pullRequests` is `null` until a read lands, which is
  // what makes the header fall back to `N issues` (the read is T5's seam, so a
  // caller that never supplies one, or whose first read never succeeds, has no
  // count to paint). A FAILED read keeps the last rows and count — a settle that
  // produced no numbers never takes away the ones already on screen.
  let pullRequests = null;
  let pullRequestsScheduled = false;
  let pullRequestsRunning = null;
  let pullRequestsToken = 0;
  let pullRequestsLastAttemptAt = null;

  // The time the staleness checks measure from: the last SETTLED attempt when
  // there is one, otherwise the last snapshot. Measuring the TTL from a failed
  // attempt is what keeps a frame after a failure from retrying immediately.
  function lastAttempt() {
    if (lastAttemptAt !== null) return lastAttemptAt;
    return snapshot === null ? null : snapshot.at;
  }

  // S3 (T2 of issues-startup-performance): a failure the caller TONED — the one
  // dim line a cwd outside a git repository draws — is a STATE, not a failure to
  // retry. There is nothing to check outside a repository, so the activity floor,
  // the frame TTL and every later frame schedule nothing at all: the line stays
  // until a session boundary supersedes it (`invalidate()`/`dispose()`). An
  // explicit `refresh()` is still the caller's own decision.
  function stateSettled() {
    return snapshot !== null
      && snapshot.status === 'error'
      && (snapshot.tone === 'dim' || snapshot.tone === 'muted');
  }

  function isStale() {
    if (snapshot === null) return true;
    if (stateSettled()) return false;
    const age = now() - lastAttempt();
    return !Number.isFinite(age) || age >= ttlMs;
  }

  function ensureFresh() {
    // T4 (S4): the pull-request read is asked FIRST and behind its own guards, so
    // an issues read already in flight never suppresses it and a fresh issues
    // snapshot never keeps an aged `pr` count on screen.
    ensureFreshPullRequests();
    if (disposed || scheduled || running !== null) return;
    if (!isStale()) return;
    const queuedGeneration = generation;
    scheduled = true;
    try {
      schedule(() => {
        // T15 (defect 2): a callback that outlived the section it was queued
        // for — an `invalidate()`, a `dispose()` or a newer checkout — does
        // nothing. It leaves `scheduled` to whichever callback still owns it.
        if (disposed || queuedGeneration !== generation) return undefined;
        scheduled = false;
        // A run that started while this one was queued already covers the
        // staleness: the TTL path starts nothing besides its own run.
        if (running !== null) return undefined;
        return refresh();
      });
    } catch {
      scheduled = false;
    }
  }

  // S10 (T8): drop the floor timer. The token moves on FIRST, so a callback the
  // host already queued cannot read through a timer this section no longer owns.
  function clearFloorTimer() {
    timerToken += 1;
    if (timer === null) return;
    const handle = timer;
    timer = null;
    try {
      cancelTimer(handle);
    } catch {
      // A timer the host will not cancel still finds the token moved on.
    }
  }

  // S10 (T8, L9): arm the ONE floor timer. It is armed by a DRAW and never by a
  // second timer of its own while one is running, so a burst of frames can never
  // stack two reads; the fire turns into the next floor's arm.
  function armFloorTimer() {
    if (disposed || refreshFloorMs === null || timer !== null) return;
    // S11/S3 (T2): a state the caller toned — a cwd outside a repository — has
    // nothing to check, so it keeps no timer either.
    if (stateSettled()) return;
    const token = (timerToken += 1);
    let handle = null;
    try {
      handle = setTimer(() => {
        // A timer that was cleared (or superseded) while the host held its
        // callback: the token is what makes it inert.
        if (token !== timerToken) return;
        timer = null;
        if (disposed) return;
        if (stateSettled()) return;
        // S11: the moment the section is no longer drawn, the timer stops by
        // itself — no read, and no next floor.
        if (!drawnWithin(timerDrawnWindowMs)) return;
        // One read per floor: a read already in flight owns this instant.
        refreshIfStale(refreshFloorMs);
        armFloorTimer();
      }, refreshFloorMs);
    } catch {
      timer = null;
      return;
    }
    timer = handle;
    // Unref'd: the floor is never a reason for the process to stay alive.
    if (handle && typeof handle.unref === 'function') {
      try {
        handle.unref();
      } catch {
        // A handle without a working unref still bounds the wait.
      }
    }
  }

  // T10b (S4, D9): the ONE repaint request a landed read makes. The issues read
  // reaches it through `replace()`, and both settlements of the pull-request read
  // call it themselves: the `pr` count is a SECOND state, so a header that grew its
  // `· M pr` segment would otherwise keep the old count until an unrelated frame.
  // A frame never asks (it only schedules the read), a superseded answer never asks
  // (the token check happens before the state is written), and a host without the
  // notifier pays nothing.
  function requestRepaint() {
    if (onRefreshed === null) return;
    try {
      onRefreshed();
    } catch {
      // A repaint failure never breaks the frame that reads the snapshot.
    }
  }

  function replace(next) {
    snapshot = next;
    requestRepaint();
  }

  function apply(result) {
    const at = now();
    // T15 (defect 1): every settled attempt — success or failure — starts the
    // floor and the frame TTL. `snapshot.at` is left alone by the failure branch
    // below, which is what keeps it the last SUCCESSFUL read.
    lastAttemptAt = at;
    if (result && result.ok === true) {
      // S8 (T9): the per-issue mark facts are normalized here, once, so every
      // entry the snapshot exposes reports them in one shape — an absent or
      // ambiguous answer is `hasPullRequest: false` and `pullRequestNumber:
      // null`, never `undefined`, and the row renders no mark.
      // S7 (T8): the bucket the row came from is carried through the same way,
      // so the click can ask it of the opener.
      const rawIssues = Array.isArray(result.issues) ? result.issues : [];
      const issues = rawIssues.map((item) => {
        const entry = item && typeof item === 'object' ? item : {};
        const number = Number(entry.pullRequestNumber);
        return {
          ...entry,
          hasPullRequest: entry.hasPullRequest === true,
          pullRequestNumber: Number.isInteger(number) && number > 0 ? number : null,
        };
      });
      // S4: the identity is captured HERE, together with the rows it labels, so
      // the click never reads the current snapshot. A row retained on screen
      // across a checkout change keeps the repository its number was read from.
      const identity = result.identity === undefined ? null : result.identity;
      const truncated = result.truncated === true;
      // S2 (issues-sidebar-click T1, correction): the generation the caller's read
      // was taken under rides the row into the `open` seam, opaquely. The section
      // never reads it and keeps no second clock: it is how the opener tells a row
      // read by the session that is still running from one the host retained across
      // a session boundary. A read that carries none hands `null`.
      const readGeneration = result.generation === undefined ? null : result.generation;
      const rows = issueRows(issues, maxRows);
      for (const row of rows) {
        row.onClick = deferSeam(invokeOpen(row, identity, readGeneration), OPEN_FAILED);
      }
      if (issues.length > maxRows) {
        const row = overflowRow(issues.length - maxRows, truncated);
        row.onClick = deferSeam(() => (openAll === null ? undefined : openAll()), OPEN_ALL_FAILED);
        rows.push(row);
      }
      replace({
        status: 'ready',
        at,
        identity,
        issues,
        error: null,
        rows,
        truncated,
      });
      // T4 (S4): this is the read that proves the checkout's repository, so the
      // pull-request read starts HERE on a cold section — a collapsed first frame
      // draws no body and nothing else would ask for it until the next floor.
      ensureFreshPullRequests();
      return;
    }
    const error = textOf(result && result.error, READ_FAILED);
    // S5 amended (T10): once a list is on screen, a failed refresh is a
    // transient stall, not an empty repository — a `gh` killed by its 30 s bound
    // must never cost the human seven good rows. The rows stay exactly as they
    // were (same rows, same order, same markers), `error` records the reason for
    // a caller, and `status` becomes the fourth value `stale`. `at` keeps the
    // time of the last SUCCESSFUL read, so the TTL still sees an aged snapshot
    // and keeps retrying. Only a failure with nothing to show is an error row.
    if (snapshot !== null && (snapshot.status === 'ready' || snapshot.status === 'stale')) {
      replace({ ...snapshot, status: 'stale', error });
      return;
    }
    // S12 (T11): the caller may say a failure is not an error at all — a cwd
    // outside a repository is one short gray line, not the red the read failures
    // wear. Only the two secondary roles it asks for are honored; every other
    // failure keeps the `error` tone.
    const tone = result && (result.errorTone === 'dim' || result.errorTone === 'muted')
      ? result.errorTone
      : 'error';
    replace({
      status: 'error',
      at,
      identity: null,
      issues: [],
      error,
      tone,
      rows: [],
      truncated: false,
    });
    // S13 (T11) / S3 (T2): a TONED failure is a STATE, not a failure to retry — a
    // cwd outside a repository, or a missing `gh` CLI — so it owns no timer either.
    // The draw that preceded it armed the floor, and that one is dropped HERE
    // instead of surviving to its next fire only to find the state settled.
    if (tone === 'dim' || tone === 'muted') clearFloorTimer();
  }

  // T4 (S5): the click's destination. An issue the read marked with a linked pull
  // request opens the PR panel on THAT pull request and carries the routing
  // object the panel needs — `{ pullRequest, pullRequestBucket }`; every other
  // row keeps the four arguments it always passed. The bucket is decided against
  // the buckets the rail holds WHEN THE CLICK RUNS, so a retained row follows the
  // read that has landed since it was painted. `review` beats `mine`, and a pull
  // request in neither is `all` — the row still opens a PR panel even when the
  // rail's own read could not place it.
  function invokeOpen(row, identity, readGeneration) {
    if (open === null) return () => undefined;
    if (row.pullRequest === null) {
      return () => open(row.number, identity, row.bucket, readGeneration);
    }
    const number = row.pullRequest;
    return () => open(row.number, { pullRequest: number, pullRequestBucket: pullRequestBucket(number) });
  }

  // T4 (S4): one pull-request row, normalized to the one shape the rail reads: a
  // positive integer number and the issues it links. A row without a usable
  // number is not a pull request and is dropped, exactly like the issues read
  // drops an issue it cannot paint.
  function pullRequestRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const kept = [];
    for (const item of list) {
      const entry = item && typeof item === 'object' ? item : {};
      const number = Number.isInteger(entry.number) && entry.number > 0 ? entry.number : null;
      if (number === null) continue;
      const linkedIssues = Array.isArray(entry.linkedIssues)
        ? entry.linkedIssues.filter((linked) => Number.isInteger(linked) && linked > 0)
        : [];
      kept.push({ number, linkedIssues });
    }
    return kept;
  }

  // T4 (S5): which bucket a pull request belongs to, from the rail's own read.
  // No read (or a read that knows neither bucket) is `all`.
  function pullRequestBucket(number) {
    if (pullRequests === null) return 'all';
    if (pullRequests.review.has(number)) return 'review';
    if (pullRequests.mine.has(number)) return 'mine';
    return 'all';
  }

  // T4 (S4): the count the header paints — the DISTINCT numbers in mine ∪ review.
  // `null` means no count has ever been read, which is the header the section had
  // before the seam existed.
  function pullRequestCount() {
    return pullRequests === null ? null : pullRequests.count;
  }

  // D8 (S4): the count one read (or one stored entry) proves, as the bucket sets
  // it also routes clicks with. The base is the DISTINCT numbers the answer
  // CARRIED. A bucket that reports an exact total larger than the rows it came
  // with was cut by its own window, and every such cut row is a pull request the
  // answer proved exists but never named: its number cannot be deduplicated
  // against anything, so each one counts on its own. A total that is not a count,
  // or one below the rows that came with it, adds nothing — the fetched numbers
  // stay the floor, so no header is ever short of what is known.
  function pullRequestUniverse(mine, review, totals) {
    const mined = new Set(mine.map((row) => row.number));
    const reviewed = new Set(review.map((row) => row.number));
    const distinct = new Set([...mined, ...reviewed]);
    const claimed = totals !== null && typeof totals === 'object' ? totals : {};
    const remainder = (total, fetched) => (Number.isInteger(total) && total > fetched ? total - fetched : 0);
    return {
      mine: mined,
      review: reviewed,
      count: distinct.size + remainder(claimed.mine, mined.size) + remainder(claimed.review, reviewed.size),
    };
  }

  function pullRequestsStale(maxAgeMs) {
    if (pullRequests === null) return true;
    const from = pullRequestsLastAttemptAt === null ? pullRequests.at : pullRequestsLastAttemptAt;
    const age = now() - from;
    return !Number.isFinite(age) || age >= maxAgeMs;
  }

  // T4 (S4): the pull-request read rides the SAME repository the issues read
  // proved. While that proof is missing — no snapshot yet, or the settled state a
  // cwd outside a repository or a missing `gh` draws — nothing is read, which is
  // what keeps a non-repository checkout free of the child invariant 28 forbids.
  function repositoryProved() {
    return snapshot !== null && (snapshot.status === 'ready' || snapshot.status === 'stale');
  }

  // T4 (S4): one settled pull-request read. A success replaces the rows and their
  // count; a failure only marks the state stalled and KEEPS the count, because a
  // `gh` killed by its bound must never cost the human a number already painted.
  // A failure with nothing ever read paints nothing at all.
  function applyPullRequests(result) {
    const at = now();
    pullRequestsLastAttemptAt = at;
    if (result && result.ok === true) {
      const mine = pullRequestRows(result.mine);
      const review = pullRequestRows(result.review);
      const universe = pullRequestUniverse(mine, review, result.counts);
      pullRequests = {
        status: 'ready',
        at,
        mine: universe.mine,
        review: universe.review,
        count: universe.count,
        error: null,
      };
      // T10b (S4, D9): the count the header paints just changed, so the frame the
      // human reads it in is asked for here — the same request the issues read
      // makes when its own rows land.
      requestRepaint();
      return;
    }
    const error = textOf(result && result.error, PULL_REQUESTS_FAILED);
    if (pullRequests === null) return;
    pullRequests = { ...pullRequests, status: 'stale', error };
    // T10b (S4, D9): the settled attempt changed this state (its status), so it
    // asks for the frame too; nothing asks while no count has ever been painted.
    requestRepaint();
  }

  // T4 (S4): the same guard the issues read has — one read in flight, one queued,
  // nothing outside a repository, nothing after `dispose()` or a session
  // boundary — so a frame never waits and two stale frames start ONE read. The
  // threshold is the caller's: the frame TTL by default, the activity floor while
  // the section is drawn, and `0` for the caller's one forced read.
  function ensureFreshPullRequests(maxAgeMs = ttlMs) {
    if (disposed || loadPullRequests === null) return;
    if (pullRequestsScheduled || pullRequestsRunning !== null) return;
    if (!repositoryProved()) return;
    if (!pullRequestsStale(maxAgeMs)) return;
    const queuedGeneration = generation;
    pullRequestsScheduled = true;
    try {
      schedule(() => {
        if (disposed || queuedGeneration !== generation) return undefined;
        pullRequestsScheduled = false;
        if (pullRequestsRunning !== null) return undefined;
        return refreshPullRequests();
      });
    } catch {
      pullRequestsScheduled = false;
    }
  }

  function refreshPullRequests() {
    if (disposed || loadPullRequests === null) return Promise.resolve(pullRequests);
    const token = (pullRequestsToken += 1);
    let pending;
    try {
      pending = Promise.resolve(loadPullRequests());
    } catch (err) {
      pending = Promise.reject(err);
    }
    // D9 (S4): the stored entry is asked BESIDE the live read, never instead of
    // it, and never awaited by this one: the disk is fast enough to paint the
    // cold-start header while `gh` is still answering, and a slow disk postpones
    // no read. `token` is what keeps a hydration from outliving the read it rode.
    hydratePullRequestsFrom(token);
    const run = pending.then(
      (result) => {
        if (disposed || token !== pullRequestsToken) return pullRequests;
        applyPullRequests(result);
        return pullRequests;
      },
      (err) => {
        if (disposed || token !== pullRequestsToken) return pullRequests;
        applyPullRequests({ ok: false, error: textOf(err, PULL_REQUESTS_FAILED) });
        return pullRequests;
      },
    );
    pullRequestsRunning = run;
    const settle = () => {
      if (pullRequestsRunning === run) pullRequestsRunning = null;
    };
    run.then(settle, settle);
    return run;
  }

  // D9 (S4): one hydration, dispatched by the read that just started. Nothing is
  // asked for a count already painted (the live answer, or the one this section
  // already has, is the truth), for a section with no repository proof to key the
  // entry with, or for a settled section — a `dim` state (no `gh`, not a
  // repository) reads no disk and starts nothing, exactly like its read. A
  // throwing or rejecting seam is silence: the live read still answers.
  function hydratePullRequestsFrom(token) {
    if (hydratePullRequests === null || pullRequests !== null) return;
    const identity = snapshot === null ? null : snapshot.identity;
    if (typeof identity !== 'string' || identity.length === 0) return;
    let pending;
    try {
      pending = Promise.resolve(hydratePullRequests(identity));
    } catch {
      return;
    }
    pending.then((stored) => {
      if (disposed || token !== pullRequestsToken) return;
      // A live answer that landed FIRST owns the paint: a stored number never
      // contradicts one the repository just answered.
      if (pullRequests !== null) return;
      if (stored === null || typeof stored !== 'object') return;
      const mine = pullRequestRows(stored.mine);
      const review = pullRequestRows(stored.review);
      // T10b (S4, D15): the entry carries each bucket's TOTAL beside its rows, so
      // the cold start paints the number the live read painted — the rows it
      // carried plus what each total says the window cut. A total the store could
      // not prove is already `null` here, and a document of a previous version is
      // silence, never a failure.
      const universe = pullRequestUniverse(mine, review, stored.counts);
      // The AGE the count carries is the moment the stored read landed, never
      // now: an old entry can never pass for a fresh one, and the TTL that the
      // caller's live read obeys keeps counting from where the disk left it.
      pullRequests = {
        status: 'ready',
        at: Number.isFinite(stored.syncedAt) ? stored.syncedAt : null,
        mine: universe.mine,
        review: universe.review,
        count: universe.count,
        error: null,
      };
      // T10b (S4, D9): a count painted from the disk is a count the header did not
      // have a frame for either, so it asks for one exactly like the live answer.
      requestRepaint();
    }, () => {});
  }

  function recordOpenError(err, fallback) {    if (disposed) return;
    const error = textOf(err, fallback);
    if (snapshot === null) {
      replace({
        status: 'error',
        at: now(),
        identity: null,
        issues: [],
        error,
        rows: [],
        truncated: false,
      });
      return;
    }
    // One field changes: a click failure never turns a ready list into an
    // error row, it is only recorded for the next reader.
    snapshot = { ...snapshot, error };
  }

  // A resolved `{ ok: false, error }` is how the extension's openers report a
  // failure (they catch and resolve, never reject), so it takes the same path a
  // throw does. A resolved `{ ok: true }` or a plain `undefined` records
  // nothing, and a ready list stays a ready list.
  function applyOpenOutcome(outcome, fallback) {
    if (disposed) return undefined;
    if (outcome && typeof outcome === 'object' && outcome.ok === false) {
      recordOpenError(outcome.error, fallback);
    }
    return undefined;
  }

  // One click is one deferred run of one injected seam, and the run's outcome is
  // classified here: never a throw on the paint path, never an unhandled
  // rejection, and a failure lands in the snapshot instead of the host.
  function deferSeam(invoke, fallback) {
    return () => {
      if (disposed) return undefined;
      try {
        schedule(() => {
          if (disposed) return undefined;
          let outcome;
          try {
            outcome = invoke();
          } catch (err) {
            recordOpenError(err, fallback);
            return undefined;
          }
          if (outcome && typeof outcome.then === 'function') {
            return Promise.resolve(outcome).then(
              (value) => applyOpenOutcome(value, fallback),
              (err) => recordOpenError(err, fallback),
            );
          }
          return applyOpenOutcome(outcome, fallback);
        });
      } catch {
        // A scheduler that refuses the work leaves the list as it was.
      }
      return undefined;
    };
  }

  // An explicit refresh always starts its own read: coalescing it onto a run the
  // previous checkout started would land that checkout's rows. The latest run
  // wins, so an older run that settles later is dropped instead of overwriting
  // it. The TTL path guards itself in `ensureFresh` and never reaches this while
  // a run is in flight.
  function refresh() {
    if (disposed) return Promise.resolve(snapshot);
    // T4 (S4): an explicit read reads the pull requests too, whatever the caller
    // was told to refresh — the header and the routers are one snapshot of the
    // repository.
    ensureFreshPullRequests();
    const token = (runToken += 1);
    let pending;
    try {
      pending = load === null ? Promise.resolve({ ok: false, error: READ_FAILED }) : Promise.resolve(load());
    } catch (err) {
      pending = Promise.reject(err);
    }
    const run = pending.then(
      (result) => {
        if (disposed || token !== runToken) return snapshot;
        apply(result);
        return snapshot;
      },
      (err) => {
        if (disposed || token !== runToken) return snapshot;
        apply({ ok: false, error: textOf(err, READ_FAILED) });
        return snapshot;
      },
    );
    running = run;
    const settle = () => {
      if (running === run) running = null;
    };
    run.then(settle, settle);
    return run;
  }

  // S6: the supersede the session boundary performs when the checkout changes.
  // Dropping the snapshot is what makes the rail fall back to the loading row;
  // bumping the token is what makes an in-flight answer from the previous
  // checkout land nowhere. It starts no read, reports no repaint and never
  // throws, and after `dispose()` it does nothing at all. S10 (T8,T9): the
  // session boundary also clears the floor timer and the forced-read cap, so
  // nothing timed outlives the session that armed it.
  function invalidate() {
    if (disposed) return;
    snapshot = null;
    runToken += 1;
    scheduled = false;
    lastDrawnAt = null;
    clearFloorTimer();
    lastForcedAt = null;
    // T15 (defects 1 and 2): the previous checkout's attempt no longer sets the
    // floor, and a refresh already queued for it is now stale.
    lastAttemptAt = null;
    // T4 (S4, S5): the `pr` count and the buckets a click is routed by belong to
    // the checkout this session left, so they go with the rows — the header falls
    // back to `N issues` and the newest token makes a late answer land nowhere.
    pullRequests = null;
    pullRequestsToken += 1;
    pullRequestsScheduled = false;
    pullRequestsLastAttemptAt = null;
    generation += 1;
  }

  // S3 (activity floor): the caller's session events ask for a read at most once
  // per floor. It goes through `refresh()`, so the latest-wins token is the same
  // one an explicit refresh uses, and it starts ONE read when the snapshot is
  // absent or at least `maxAgeMs` old. A fresher snapshot, a read already in
  // flight and a disposed module start nothing. It answers whether a read
  // started, and it never throws or rejects.
  function refreshIfStale(maxAgeMs) {
    if (disposed) return false;
    // T4 (S4): the pull-request read has its own TTL, so the activity seam asks
    // it on its own terms — at the floor it was given, exactly like the issues
    // read below — even when the issues list is fresh.
    ensureFreshPullRequests(maxAgeMs);
    if (running !== null) return false;
    // S3 (T2): nothing to check outside a repository, so the activity seam starts
    // nothing either — however long the session lives there.
    if (stateSettled()) return false;
    if (snapshot !== null) {
      // T15 (defect 1): a failed attempt starts the activity floor too.
      const age = now() - lastAttempt();
      if (Number.isFinite(age) && age < maxAgeMs) return false;
    }
    try {
      const pending = refresh();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // S10 (T9): the caller's ONE forced read. It bypasses the frame TTL and the
  // activity floor — the caller knows something changed — but never the anti-storm
  // cap it names, and never a read already in flight. It answers whether a read
  // started, and it never throws.
  function forceRefresh(minIntervalMs) {
    if (disposed) return false;
    // T4 (S4): a forced read is worth the pull requests too — the caller knows a
    // mutation landed — so it starts one now, still behind the one-read-in-flight
    // guard and never behind the caller's anti-storm cap, which stays the issues
    // read's.
    ensureFreshPullRequests(0);
    if (running !== null) return false;
    // S3 (T2): nothing to check outside a repository, so nothing is forced there.
    if (stateSettled()) return false;
    let at = null;
    try {
      at = now();
    } catch {
      at = null;
    }
    if (lastForcedAt !== null && Number.isFinite(at)) {
      const age = at - lastForcedAt;
      if (!Number.isFinite(age) || age < minIntervalMs) return false;
    }
    try {
      const pending = refresh();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      lastForcedAt = Number.isFinite(at) ? at : null;
      return true;
    } catch {
      return false;
    }
  }

  function lines(_ctx) {
    try {
      // S3 amended (T13): a drawn body is the host painting the section, and that
      // is what the caller's activity trigger is gated on.
      noteDrawn();
      ensureFresh();
      if (snapshot === null) return [{ ...LOADING_ROW }];
      if (snapshot.status === 'error') return [{ label: snapshot.error, tone: snapshot.tone || 'error' }];
      if (snapshot.rows.length === 0) return [{ ...EMPTY_ROW }];
      // A copy per frame: the host may keep the array it was handed, and the
      // snapshot stays the one source the TTL and the clicks read. A row's
      // marker travels with it, so a stale list keeps the markers it had.
      return snapshot.rows.map((row) => (row.meta === undefined
        ? { label: row.label, tone: row.tone, onClick: row.onClick }
        : { label: row.label, tone: row.tone, meta: row.meta, onClick: row.onClick }));
    } catch {
      return [{ ...LOADING_ROW }];
    }
  }

  // S12 (T10): the heading names its units. `7 issues`, and — from T4 (S4) — the
  // pull requests the same repository holds for the viewer: `7 issues · 2 pr`,
  // where the second number is the DISTINCT numbers in mine ∪ review. The `pr`
  // segment appears only once a read has landed, so a caller with no seam (or a
  // first read that failed) keeps the header it always had. A stalled list still
  // has both counts — the ones its last successful reads produced — and says so
  // (`· stale`) instead of hiding either failure.
  function headerText(stale) {
    const issues = `${snapshot.issues.length} issues`;
    const pullRequestNumbers = pullRequestCount();
    const counted = pullRequestNumbers === null ? issues : `${issues} · ${pullRequestNumbers} pr`;
    return stale ? `${counted} · stale` : counted;
  }

  function meta(_ctx) {
    try {
      // S3 amended (T13): a collapsed header is still a drawn section — the host
      // painted it — so it stamps the drawn frame like the body does.
      noteDrawn();
      // The heading only reads the snapshot. A collapsed section is drawn with
      // this call alone, so scheduling a refresh here would make it cost the
      // network it is supposed to cost nothing. S7 (T8): the count is the MERGED
      // list's length, before any display cap. The rail never separates mine from
      // assigned, so it never names either. No snapshot is no count.
      if (snapshot === null) return undefined;
      if (snapshot.status === 'stale') return headerText(true);
      if (snapshot.status !== 'ready') return undefined;
      return headerText(false);
    } catch {
      return undefined;
    }
  }

  function snapshotOf() {
    return snapshot;
  }

  // S3 amended (T13, L11): a drawing call stamps the frame. A clock that throws
  // or answers nonsense costs the drawn window, never the frame itself.
  function noteDrawn() {
    try {
      const at = now();
      if (Number.isFinite(at)) lastDrawnAt = at;
    } catch {
      // The frame is drawn; only its stamp is lost.
    }
    // S10 (T8): the drawn frame is also what owns the floor timer — a section the
    // host stops painting keeps it no longer than the drawn window.
    armFloorTimer();
  }

  // S3 amended (T13, L11): true only while a successful draw happened at or
  // after `now() - maxAgeMs`. An undrawn, superseded or disposed section answers
  // false, and that answer is what keeps a hidden section free: the caller reads
  // only on `true`. It starts no work and never throws.
  function drawnWithin(maxAgeMs) {
    if (disposed || lastDrawnAt === null) return false;
    let at;
    try {
      at = now();
    } catch {
      return false;
    }
    const age = at - lastDrawnAt;
    return Number.isFinite(age) && age <= maxAgeMs;
  }

  function dispose() {
    disposed = true;
    scheduled = false;
    lastDrawnAt = null;
    clearFloorTimer();
    lastForcedAt = null;
    // T15 (defect 2): a refresh already queued for this section is stale.
    generation += 1;
    // T4 (S4): the pull-request read is dropped the same way, so nothing it lands
    // with outlives the session that asked for it.
    pullRequestsScheduled = false;
    pullRequestsToken += 1;
  }

  const section = {
    id: sectionId,
    title,
    rowLabel,
    defaultVisible: true,
    // shell API 0.13.0 lets a section name where it sits in the rail.
    // The GITHUB card goes AFTER every native card — the shell API's own default,
    // which an older shell API simply ignores — and it is said here so the placement
    // does not depend on a default another release could change.
    placement: 'end',
    meta,
    lines,
  };

  return { section, refresh, refreshIfStale, forceRefresh, invalidate, drawnWithin, snapshot: snapshotOf, dispose };
}

module.exports = { createIssuesSection };

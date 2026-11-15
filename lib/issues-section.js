'use strict';
// The checkout's assigned issues as a gentle-shell rail section (odd/tasks/
// issues-sidebar.md, T1: S1, S3, S4, S5; corrected by T8 to the user's
// assigned-only list).
//
// Pure and injectable: a reader (`load`), two openers (`open`, `openAll`), a
// clock, a scheduler and a repaint callback all arrive as options, so nothing
// here imports another lib module, runs a child process or reads the clock on
// its own. The bridge calls `lines(ctx)`/`meta(ctx)` once per frame and both
// must return synchronously: they read ONE in-process snapshot and only ever
// SCHEDULE the refresh, so a frame never waits on `gh`.
//
// ONE source (`load` answers `{ ok, identity, issues, truncated }`): the
// checkout repository's OPEN issues ASSIGNED to the viewer. There is no second
// bucket, no merge by issue number and no per-row relation — a row is its label
// and nothing else, because a mark on every row would mark nothing. The header
// reports the count instead (`<n> assigned`).
//
// Rows are ordered by `updatedAt` descending and the body paints at most SEVEN
// of them; when the read produced more, ONE eighth row in the `dim` tone reads
// `and N more issues`, `N` being the issues beyond the seven and written `N+`
// when the read reached its fetch bound (so the real total is larger). That
// keeps the body at the host's eight-row maximum, which is why the bridge's own
// inert `… +N more` elision never appears. The overflow row opens the `/issues`
// panel through the `openAll` seam.
//
// A row's `onClick` defers its opener onto the scheduler: it never runs on the
// paint path, it runs once per click, and a throw, a rejected promise or a
// resolved `{ ok: false, error }` is recorded in the snapshot's `error` instead
// of escaping into the host. The identity the row was BUILT from travels with
// it (`open(number, identity)`), so a row the host retains across a checkout
// change still opens the repository it was read from instead of whatever
// snapshot is current when the human clicks. Every state is a row — `loading…`,
// `no open issues`, ONE error row — and neither `lines()` nor `meta()` ever
// throws. Only `lines()` ever schedules work: a collapsed section draws solely
// its heading through `meta()`, so it costs nothing.
//
// A session that starts in ANOTHER checkout supersedes this one through
// `invalidate()`: the snapshot is dropped (the rail shows the loading row, never
// the previous repository's rows) and the latest-wins token moves on, so an
// answer the previous checkout's read delivers afterwards is discarded instead
// of applied. That drop is synchronous by design — the caller performs it the
// moment the session boundary fires, before any probe it awaits.
//
// `refreshIfStale(maxAgeMs)` is the seam the caller's own activity uses: a frame
// only exists when the host has a reason to produce one, so the TTL on a drawn
// frame never fires on a session that is only being used. The caller asks for a
// read on the session's own activity behind a floor — but ONLY while the section
// is actually on screen: `lines()` and `meta()` are the drawing calls and each
// stamps WHEN it was last drawn, `drawnWithin(maxAgeMs)` answers whether a draw
// happened inside that window, and `invalidate()`/`dispose()` clear it. A hidden
// section therefore starts nothing at all: no child process, no network, no
// timer. The module reads no clock but the one it was injected with, and it
// starts no work of its own — only `lines()` or an explicit caller call.
//
// The module never leaves a timer or a state write behind after `dispose()`:
// whatever the read lands with is dropped silently.

const DEFAULT_TTL_MS = 60000;
// The host's body holds eight rows and the eighth is the overflow row, so a
// larger `maxRows` would push the bridge's own inert elision into play: the
// retained rows are capped one below the body.
const BODY_MAX_ROWS = 8;
const DEFAULT_MAX_ROWS = BODY_MAX_ROWS - 1;
const LOADING_ROW = { label: 'loading…', tone: 'dim' };
const EMPTY_ROW = { label: 'no open issues', tone: 'dim' };
// T9 (S4 amended): the ONE marker a row can carry, and it is not about the
// relation — an issue that already has at least one pull request referencing it
// wears the Nerd Font pull-request glyph. One PR or five, the mark is the same.
// Nerd Font dependent by nature (a terminal without one draws a box) and one
// column wide, because a row wider than the given width drops the whole rail.
const PULL_REQUEST_GLYPH = '\ue726';
const READ_FAILED = 'cannot read issues';
const OPEN_FAILED = 'cannot open the issue in the browser';
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
  // is deterministic across frames.
  return issues
    .slice()
    .sort((left, right) => updatedAtValue(right) - updatedAtValue(left))
    .slice(0, limit)
    .map((item) => {
      const title = typeof item.title === 'string' ? item.title : '';
      // `number` stays on the snapshot row so the deferred click binds it; the
      // painted row below exposes only its label, tone, click and — when the
      // issue already has a pull request — its one marker. A row without a pull
      // request carries NO `meta` key at all, so nothing pends on `undefined`
      // meaning the same thing as absent.
      const row = { label: `#${item.number} ${title}`, tone: 'text', onClick: null, number: item.number };
      if (item.hasPullRequest === true) row.meta = PULL_REQUEST_GLYPH;
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
  const open = typeof opts.open === 'function' ? opts.open : null;
  const openAll = typeof opts.openAll === 'function' ? opts.openAll : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : (fn) => setTimeout(fn, 0);
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const requestedRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0
    ? Math.floor(opts.maxRows)
    : DEFAULT_MAX_ROWS;
  const maxRows = Math.min(requestedRows, DEFAULT_MAX_ROWS);
  const sectionId = typeof opts.sectionId === 'string' && opts.sectionId.length > 0 ? opts.sectionId : 'odd-worktree.issues';
  const title = typeof opts.title === 'string' && opts.title.length > 0 ? opts.title : 'ISSUES';
  const rowLabel = typeof opts.rowLabel === 'string' && opts.rowLabel.length > 0 ? opts.rowLabel : 'issues';
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
  // S3 amended (T13, L11): WHEN the section was last DRAWN. A hidden section
  // costs nothing, so the caller asks (`drawnWithin`) before an activity read and
  // reads only when the host actually painted the section recently. `lines()` and
  // `meta()` are the drawing calls, and a superseded (`invalidate()`) or disposed
  // section is showing nothing, so both clear it.
  let lastDrawnAt = null;

  function isStale() {
    if (snapshot === null) return true;
    const age = now() - snapshot.at;
    return !Number.isFinite(age) || age >= ttlMs;
  }

  function ensureFresh() {
    if (disposed || scheduled || running !== null) return;
    if (!isStale()) return;
    scheduled = true;
    try {
      schedule(() => {
        scheduled = false;
        if (disposed) return undefined;
        // A run that started while this one was queued already covers the
        // staleness: the TTL path starts nothing besides its own run.
        if (running !== null) return undefined;
        return refresh();
      });
    } catch {
      scheduled = false;
    }
  }

  function replace(next) {
    snapshot = next;
    if (onRefreshed !== null) {
      try {
        onRefreshed();
      } catch {
        // A repaint failure never breaks the frame that reads the snapshot.
      }
    }
  }

  function apply(result) {
    const at = now();
    if (result && result.ok === true) {
      // T9: the per-issue marker fact is normalized here, once, so every entry
      // the snapshot exposes reports it as a boolean — an absent or ambiguous
      // answer is `false`, never `undefined`, and the row renders no marker.
      const rawIssues = Array.isArray(result.issues) ? result.issues : [];
      const issues = rawIssues.map((item) => {
        const entry = item && typeof item === 'object' ? item : {};
        return { ...entry, hasPullRequest: entry.hasPullRequest === true };
      });
      // S4: the identity is captured HERE, together with the rows it labels, so
      // the click never reads the current snapshot. A row retained on screen
      // across a checkout change keeps the repository its number was read from.
      const identity = result.identity === undefined ? null : result.identity;
      const truncated = result.truncated === true;
      const rows = issueRows(issues, maxRows);
      for (const row of rows) {
        row.onClick = deferSeam(() => (open === null ? undefined : open(row.number, identity)), OPEN_FAILED);
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
    replace({
      status: 'error',
      at,
      identity: null,
      issues: [],
      error,
      rows: [],
      truncated: false,
    });
  }

  function recordOpenError(err, fallback) {
    if (disposed) return;
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
  // throws, and after `dispose()` it does nothing at all.
  function invalidate() {
    if (disposed) return;
    snapshot = null;
    runToken += 1;
    scheduled = false;
    lastDrawnAt = null;
  }

  // S3 (activity floor): the caller's session events ask for a read at most once
  // per floor. It goes through `refresh()`, so the latest-wins token is the same
  // one an explicit refresh uses, and it starts ONE read when the snapshot is
  // absent or at least `maxAgeMs` old. A fresher snapshot, a read already in
  // flight and a disposed module start nothing. It answers whether a read
  // started, and it never throws or rejects.
  function refreshIfStale(maxAgeMs) {
    if (disposed) return false;
    if (running !== null) return false;
    if (snapshot !== null) {
      const age = now() - snapshot.at;
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

  function lines(_ctx) {
    try {
      // S3 amended (T13): a drawn body is the host painting the section, and that
      // is what the caller's activity trigger is gated on.
      noteDrawn();
      ensureFresh();
      if (snapshot === null) return [{ ...LOADING_ROW }];
      if (snapshot.status === 'error') return [{ label: snapshot.error, tone: 'error' }];
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

  function meta(_ctx) {
    try {
      // S3 amended (T13): a collapsed header is still a drawn section — the host
      // painted it — so it stamps the drawn frame like the body does.
      noteDrawn();
      // The heading only reads the snapshot. A collapsed section is drawn with
      // this call alone, so scheduling a refresh here would make it cost the
      // network it is supposed to cost nothing. The count is every issue the
      // read answered with, before any display cap. A stale list still has a
      // count — it is the one the last successful read produced — and it says so
      // instead of hiding the failure.
      if (snapshot === null) return undefined;
      if (snapshot.status === 'stale') return `${snapshot.issues.length} assigned · stale`;
      if (snapshot.status !== 'ready') return undefined;
      return `${snapshot.issues.length} assigned`;
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
  }

  const section = {
    id: sectionId,
    title,
    rowLabel,
    defaultVisible: true,
    meta,
    lines,
  };

  return { section, refresh, refreshIfStale, invalidate, drawnWithin, snapshot: snapshotOf, dispose };
}

module.exports = { createIssuesSection };

'use strict';
// The ODDs this machine is working on, as gentle-shell's second rail section
// (odd/tasks/odd-rail-section.md, T3: S1, S2, S5, S6).
//
// Pure and injectable: the read (`load`), the opener (`open`), a clock, a
// scheduler, the two timer seams and a repaint callback all arrive as options, so
// nothing here walks a directory, runs git or reads the clock on its own. The
// bridge calls `lines(ctx)` once per frame and it must answer synchronously: it
// reads ONE in-process snapshot and only ever SCHEDULES the read, so a frame
// never waits on the scan.
//
// ONE source (`load` resolves an ARRAY of `{ name, docPath, checkoutRoot,
// checkoutName, mtimeMs }`): the caller owns the walk of every owned checkout's
// `odd/` directory and the dedupe that keeps the most recently modified ODD
// (S3/S4), and it hands the rows over already ordered most-recent-first. The
// section never re-sorts — the order it resolves is the order drawn — and a read
// that rejects or throws is a failure like any other.
//
// At most FOUR rows (S2: "maximo 4, si hay mas sale linea 5 con N more"). A row
// is its label — the ODD's name — its click and its right-hand `meta`: the
// checkout name VERBATIM, `main` or the worktree's own name, never a path (S5).
// More than four appends ONE fifth row in the `dim` tone reading `N more`, `N`
// being the total beyond the four; that row is inert (`onClick: null`), because
// there is nothing behind it to open. Exactly four ODDs paint four rows and no
// elision row at all.
//
// S1: the section carries `placement: { after: "agents" }`, which is what puts
// the card right after the native AGENTS rail part. It carries no `meta`: no
// header count was asked for.
//
// S6: a row's `onClick` defers its opener onto the scheduler — it never runs on
// the paint path, it runs once per click, and it calls
// `open({ name, docPath, checkoutRoot })` with the target the ROW was built
// from, so a row the host retained across a refresh opens the ODD it was read
// from. A throw or a rejected promise from the opener is recorded in the
// snapshot's `error` instead of escaping into the host, and it never costs a row.
//
// A read that fails keeps the rows already on screen: the status becomes `stale`
// (the fourth value the issues section uses too), `error` records the reason and
// `at` keeps the time of the last SUCCESSFUL read. The TTL is measured from the
// last SETTLED attempt, success or failure, so a failure is not retried at the
// same instant. Only a failure with nothing to show is the ONE error row.
//
// `refreshFloorMs` is the issues section's floor timer, unchanged: while the
// section is DRAWN it keeps ONE self-scheduled, unref'd timer at that floor,
// which fires one read, arms the next floor and stops by itself once the section
// leaves the `drawnWindowMs` window. It is armed by a draw, so a section nobody
// draws keeps no timer at all — and no read either.
//
// `invalidate()` is the session boundary: the snapshot is dropped (the rail
// shows the loading row again), the latest-wins token moves on so an answer
// already on its way is discarded, and the floor timer is cleared. The module
// leaves no timer and no state write behind after `dispose()`.

const DEFAULT_TTL_MS = 60000;
// How long a section counts as DRAWN after its last frame. It is the caller's
// window unless it names one.
const DEFAULT_DRAWN_WINDOW_MS = 120000;
// S2: the body holds four ODDs; anything beyond them is the ONE elision row.
const MAX_ROWS = 4;
const LOADING_ROW = { label: 'loading…', tone: 'dim' };
const READ_FAILED = 'cannot read the ODDs';
const OPEN_FAILED = 'cannot open the ODD';

function textOf(value, fallback) {
  if (value && typeof value.message === 'string' && value.message.length > 0) return value.message;
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

// S2/S5: the fifth line. It is the issues section's elision row with its click
// removed — the count is what the four rows left out, and there is no panel to
// open for "the rest".
function elisionRow(total) {
  return { label: `${total - MAX_ROWS} more`, tone: 'dim', onClick: null };
}

function createOddRailSection(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const load = typeof opts.load === 'function' ? opts.load : null;
  const open = typeof opts.open === 'function' ? opts.open : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : (fn) => setTimeout(fn, 0);
  // The timer seams are injected exactly like `schedule`, so a caller (and a
  // test) drives the floor without waiting for it. No floor named, no timer.
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : (fn, ms) => setTimeout(fn, ms);
  const cancelTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : (handle) => clearTimeout(handle);
  const refreshFloorMs = Number.isFinite(opts.refreshFloorMs) && opts.refreshFloorMs > 0
    ? opts.refreshFloorMs
    : null;
  const drawnWindowMs = Number.isFinite(opts.drawnWindowMs) && opts.drawnWindowMs >= 0
    ? opts.drawnWindowMs
    : DEFAULT_DRAWN_WINDOW_MS;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const requestRepaint = typeof opts.requestRepaint === 'function' ? opts.requestRepaint : null;

  let snapshot = null;
  // A read that is scheduled but has not started, and the one that runs. Both are
  // module state so two stale frames schedule ONE read and a frame drawn while it
  // runs schedules nothing. `runToken` is the latest-wins boundary: a result from
  // a read that is no longer the latest is dropped instead of applied.
  let scheduled = false;
  let running = null;
  let runToken = 0;
  let disposed = false;
  // When the last read SETTLED, success or failure — the instant the TTL
  // measures from, so a failing scan is not retried at the same instant. And the
  // token a DEFERRED refresh captured when it was queued, so a callback that
  // outlives `invalidate()`/`dispose()` starts no read at all.
  let lastAttemptAt = null;
  let generation = 0;
  // When the section was last DRAWN; an undrawn section costs nothing.
  let lastDrawnAt = null;
  // The ONE self-scheduled floor timer, and the token that makes a callback the
  // host already queued inert once the timer was cleared.
  let timer = null;
  let timerToken = 0;

  // The time the staleness checks measure from: the last SETTLED attempt when
  // there is one, otherwise the last snapshot.
  function lastAttempt() {
    if (lastAttemptAt !== null) return lastAttemptAt;
    return snapshot === null ? null : snapshot.at;
  }

  function isStale() {
    if (snapshot === null) return true;
    const age = now() - lastAttempt();
    return !Number.isFinite(age) || age >= ttlMs;
  }

  function ensureFresh() {
    if (disposed || scheduled || running !== null) return;
    if (!isStale()) return;
    const queuedGeneration = generation;
    scheduled = true;
    try {
      schedule(() => {
        // A callback that outlived the section it was queued for — an
        // `invalidate()`, a `dispose()` or a newer checkout — does nothing. It
        // leaves `scheduled` to whichever callback still owns it.
        if (disposed || queuedGeneration !== generation) return undefined;
        scheduled = false;
        // A read that started while this one was queued already covers the
        // staleness: the TTL path starts nothing besides its own read.
        if (running !== null) return undefined;
        return refresh();
      });
    } catch {
      scheduled = false;
    }
  }

  // Drop the floor timer. The token moves on FIRST, so a callback the host
  // already queued cannot read through a timer this section no longer owns.
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

  // Arm the ONE floor timer. It is armed by a DRAW and never by a second timer of
  // its own while one is running, so a burst of frames can never stack two reads;
  // its fire turns into the next floor's arm.
  function armFloorTimer() {
    if (disposed || refreshFloorMs === null || timer !== null) return;
    const token = (timerToken += 1);
    let handle = null;
    try {
      handle = setTimer(() => {
        // A timer that was cleared (or superseded) while the host held its
        // callback: the token is what makes it inert.
        if (token !== timerToken) return;
        timer = null;
        if (disposed) return;
        // The moment the section is no longer drawn, the timer stops by itself —
        // no read, and no next floor.
        if (!drawnWithin(drawnWindowMs)) return;
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

  function replace(next) {
    snapshot = next;
    if (requestRepaint !== null) {
      try {
        requestRepaint();
      } catch {
        // A repaint failure never breaks the frame that reads the snapshot.
      }
    }
  }

  function apply(items) {
    const at = now();
    // Every settled attempt — success or failure — starts the frame TTL.
    lastAttemptAt = at;
    const list = Array.isArray(items) ? items : [];
    const rows = [];
    for (const item of list.slice(0, MAX_ROWS)) {
      const entry = item && typeof item === 'object' ? item : {};
      const name = typeof entry.name === 'string' ? entry.name : '';
      // S6: the target travels with the row it was built from, so the click never
      // reads the current snapshot to learn where the ODD lives.
      const target = { name, docPath: entry.docPath, checkoutRoot: entry.checkoutRoot };
      const row = {
        label: name,
        tone: 'text',
        // The click is one deferred run of the injected opener; a failure lands
        // in the snapshot instead of the host.
        onClick: deferSeam(() => (open === null ? undefined : open(target)), OPEN_FAILED),
      };
      // S5: the checkout name goes through VERBATIM — `main` or the worktree's
      // own name. The section never touches a path. An entry that answers no
      // name carries no `meta` key at all, so nothing pends on `undefined`
      // meaning the same thing as absent.
      if (typeof entry.checkoutName === 'string') row.meta = entry.checkoutName;
      rows.push(row);
    }
    if (list.length > MAX_ROWS) rows.push(elisionRow(list.length));
    replace({ status: 'ready', at, error: null, total: list.length, rows });
  }

  // A failed read. While a list is on screen this is a transient stall, not an
  // empty machine: the rows stay exactly as they were (same rows, same order,
  // same metadata), `error` records the reason and `status` becomes `stale`.
  // `at` keeps the time of the last SUCCESSFUL read, while `lastAttemptAt` — set
  // by the caller before this runs — is what keeps the retry behind the TTL.
  function applyFailure(err) {
    const at = now();
    lastAttemptAt = at;
    const error = textOf(err, READ_FAILED);
    if (snapshot !== null && (snapshot.status === 'ready' || snapshot.status === 'stale')) {
      replace({ ...snapshot, status: 'stale', error });
      return;
    }
    replace({ status: 'error', at, error, total: 0, rows: [] });
  }

  function recordOpenError(err, fallback) {
    if (disposed) return;
    const error = textOf(err, fallback);
    if (snapshot === null) {
      replace({ status: 'error', at: now(), error, total: 0, rows: [] });
      return;
    }
    // One field changes: a click failure never turns a ready list into an error
    // row, it is only recorded for the next reader.
    snapshot = { ...snapshot, error };
  }

  function recordOpenOutcome(outcome, fallback) {
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
              (value) => recordOpenOutcome(value, fallback),
              (err) => recordOpenError(err, fallback),
            );
          }
          return recordOpenOutcome(outcome, fallback);
        });
      } catch {
        // A scheduler that refuses the work leaves the list as it was.
      }
      return undefined;
    };
  }

  // An explicit read always starts its own: the latest run wins, so an older one
  // that settles later is dropped instead of overwriting it. The TTL path guards
  // itself in `ensureFresh` and never reaches this while a read is in flight.
  function refresh() {
    if (disposed) return Promise.resolve(snapshot);
    const token = (runToken += 1);
    let pending;
    try {
      pending = load === null ? Promise.reject(new Error(READ_FAILED)) : Promise.resolve(load());
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
        applyFailure(err);
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

  // The read an activity trigger or the floor timer asks for: it starts ONE read
  // when the snapshot is absent or at least `maxAgeMs` old, and nothing at all
  // while a read is in flight or after `dispose()`. It answers whether a read
  // started, and it never throws or rejects.
  function refreshIfStale(maxAgeMs) {
    if (disposed) return false;
    if (running !== null) return false;
    if (snapshot !== null) {
      // A failed attempt starts the floor too.
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

  // The supersede a session boundary performs. Dropping the snapshot is what
  // makes the rail fall back to the loading row; bumping the token is what makes
  // an in-flight answer land nowhere. It starts no read, repaints nothing, and
  // after `dispose()` it does nothing at all.
  function invalidate() {
    if (disposed) return;
    snapshot = null;
    runToken += 1;
    scheduled = false;
    lastDrawnAt = null;
    clearFloorTimer();
    // The previous session's attempt no longer sets the TTL, and a refresh
    // already queued for it is now stale.
    lastAttemptAt = null;
    generation += 1;
  }

  function lines(_ctx) {
    try {
      // A drawn body is the host painting the section, and that is what owns the
      // floor timer.
      noteDrawn();
      ensureFresh();
      if (snapshot === null) return [{ ...LOADING_ROW }];
      if (snapshot.status === 'error') return [{ label: snapshot.error, tone: 'error' }];
      // A ready list with nothing in it draws no rows at all: there is no copy
      // this module may invent for an empty scan.
      // A copy per frame: the host may keep the array it was handed, and the
      // snapshot stays the one source the TTL and the clicks read.
      return snapshot.rows.map((row) => (row.meta === undefined
        ? { label: row.label, tone: row.tone, onClick: row.onClick }
        : { label: row.label, tone: row.tone, meta: row.meta, onClick: row.onClick }));
    } catch {
      return [{ ...LOADING_ROW }];
    }
  }

  // A drawing call stamps the frame. A clock that throws or answers nonsense
  // costs the drawn window, never the frame itself.
  function noteDrawn() {
    try {
      const at = now();
      if (Number.isFinite(at)) lastDrawnAt = at;
    } catch {
      // The frame is drawn; only its stamp is lost.
    }
    // The drawn frame is also what owns the floor timer — a section the host
    // stops painting keeps it no longer than the drawn window.
    armFloorTimer();
  }

  // True only while a draw happened at or after `now() - maxAgeMs`. An undrawn,
  // superseded or disposed section answers false, and that answer is what keeps
  // a hidden section free. It starts no work and never throws.
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
    // A refresh already queued for this section is stale.
    generation += 1;
  }

  const section = {
    id: 'odd-worktree.odd-rail',
    title: 'ODD',
    rowLabel: 'odd',
    defaultVisible: true,
    // S1: right after the native AGENTS part, never at the top.
    placement: { after: 'agents' },
    lines,
  };

  return { section, refresh, refreshIfStale, invalidate, drawnWithin, dispose };
}

module.exports = { createOddRailSection };

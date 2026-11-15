'use strict';
// The checkout's related issues as a gentle-shell rail section (odd/tasks/
// issues-sidebar.md, T1: S1, S3, S4, S5).
//
// Pure and injectable: a reader (`load`), an opener (`open`), a clock, a
// scheduler and a repaint callback all arrive as options, so nothing here
// imports another lib module, runs a child process or reads the clock on its
// own. The bridge calls `lines(ctx)`/`meta(ctx)` once per frame and both must
// return synchronously: they read ONE in-process snapshot and only ever
// SCHEDULE the refresh, so a frame never waits on `gh`.
//
// The row list is the two buckets the user asked for (`author:@me` and
// `assignee:@me`) merged by issue number: an issue in both shows once, its
// `meta` names the relation (`mine`, `assigned`, `mine + assigned`) and its
// tone follows it. Rows are ordered by `updatedAt` descending and capped at
// the fetch bound, so the host's own body cap is the only clipping left to it.
//
// A row's `onClick` defers the opener onto the scheduler: it never runs on the
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
// read at session start, on a drawn frame, and on the session's own activity
// behind a floor; this module starts no timer and reads no clock but the one it
// was injected with.
//
// The module never leaves a timer or a state write behind after `dispose()`:
// whatever the read lands with is dropped silently.

const DEFAULT_TTL_MS = 60000;
const DEFAULT_MAX_ROWS = 20;
const LOADING_ROW = { label: 'loading…', tone: 'dim' };
const EMPTY_ROW = { label: 'no open issues', tone: 'dim' };
const READ_FAILED = 'cannot read issues';

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

function issueRows(mine, assigned, limit) {
  const byNumber = new Map();
  const collect = (item, relation) => {
    if (!item || typeof item !== 'object') return;
    const key = item.number;
    const entry = byNumber.get(key);
    if (entry) {
      entry.relations.add(relation);
      return;
    }
    byNumber.set(key, { item, relations: new Set([relation]) });
  };
  for (const item of mine) collect(item, 'mine');
  for (const item of assigned) collect(item, 'assigned');
  const merged = [...byNumber.values()];
  // Descending by the ISO `updatedAt`; a missing date sorts last and ties keep
  // the bucket order (mine first), which is deterministic across frames.
  merged.sort((left, right) => updatedAtValue(right.item) - updatedAtValue(left.item));
  return merged.slice(0, limit).map(({ item, relations }) => {
    const both = relations.has('mine') && relations.has('assigned');
    const meta = both ? 'mine + assigned' : (relations.has('mine') ? 'mine' : 'assigned');
    const title = typeof item.title === 'string' ? item.title : '';
    return {
      label: `#${item.number} ${title}`,
      meta,
      tone: meta === 'mine' ? 'text' : 'accent',
      onClick: null,
      number: item.number,
    };
  });
}

function createIssuesSection(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const load = typeof opts.load === 'function' ? opts.load : null;
  const open = typeof opts.open === 'function' ? opts.open : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : (fn) => setTimeout(fn, 0);
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.floor(opts.maxRows) : DEFAULT_MAX_ROWS;
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
      const mine = Array.isArray(result.mine) ? result.mine : [];
      const assigned = Array.isArray(result.assigned) ? result.assigned : [];
      // S4: the identity is captured HERE, together with the rows it labels, so
      // the click never reads the current snapshot. A row retained on screen
      // across a checkout change keeps the repository its number was read from.
      const identity = result.identity === undefined ? null : result.identity;
      const rows = issueRows(mine, assigned, maxRows);
      for (const row of rows) row.onClick = deferOpen(row.number, identity);
      replace({
        status: 'ready',
        at,
        identity,
        mine,
        assigned,
        error: null,
        rows,
      });
      return;
    }
    replace({
      status: 'error',
      at,
      identity: null,
      mine: [],
      assigned: [],
      error: textOf(result && result.error, READ_FAILED),
      rows: [],
    });
  }

  function recordOpenError(err) {
    if (disposed) return;
    const error = textOf(err, 'cannot open the issue in the browser');
    if (snapshot === null) {
      replace({
        status: 'error',
        at: now(),
        identity: null,
        mine: [],
        assigned: [],
        error,
        rows: [],
      });
      return;
    }
    // One field changes: a click failure never turns a ready list into an
    // error row, it is only recorded for the next reader.
    snapshot = { ...snapshot, error };
  }

  // A resolved `{ ok: false, error }` is how the extension's opener reports a
  // failure (it catches and resolves, never rejects), so it takes the same
  // path a throw does. A resolved `{ ok: true }` or a plain `undefined`
  // records nothing, and a ready list stays a ready list.
  function applyOpenOutcome(outcome) {
    if (disposed) return undefined;
    if (outcome && typeof outcome === 'object' && outcome.ok === false) {
      recordOpenError(outcome.error);
    }
    return undefined;
  }

  function deferOpen(number, identity) {
    return () => {
      if (disposed) return undefined;
      try {
        schedule(() => {
          if (disposed) return undefined;
          if (open === null) return undefined;
          let outcome;
          try {
            outcome = open(number, identity);
          } catch (err) {
            recordOpenError(err);
            return undefined;
          }
          // An async opener must not leave an unhandled rejection behind; the
          // failure belongs in the snapshot like a synchronous throw.
          if (outcome && typeof outcome.then === 'function') {
            return Promise.resolve(outcome).then(
              (value) => applyOpenOutcome(value),
              (err) => recordOpenError(err),
            );
          }
          return applyOpenOutcome(outcome);
        });
      } catch {
        // A scheduler that refuses the work leaves the list as it was.
      }
      return undefined;
    };
  }

  // An explicit refresh (the eager `session_start` read) always starts its own
  // read: coalescing it onto a run the previous checkout started would land
  // that checkout's rows. The latest run wins, so an older run that settles
  // later is dropped instead of overwriting it. The TTL path guards itself in
  // `ensureFresh` and never reaches this while a run is in flight.
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
  }

  // S3 (activity floor): the caller's session events ask for a read at most once
  // per floor. It goes through `refresh()`, so the latest-wins token is the same
  // one an eager refresh uses, and it starts ONE read when the snapshot is
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
      ensureFresh();
      if (snapshot === null) return [{ ...LOADING_ROW }];
      if (snapshot.status === 'error') return [{ label: snapshot.error, tone: 'error' }];
      if (snapshot.rows.length === 0) return [{ ...EMPTY_ROW }];
      // A copy per frame: the host may keep the array it was handed, and the
      // snapshot stays the one source the TTL and dedupe read.
      return snapshot.rows.map((row) => ({
        label: row.label,
        meta: row.meta,
        tone: row.tone,
        onClick: row.onClick,
      }));
    } catch {
      return [{ ...LOADING_ROW }];
    }
  }

  function meta(_ctx) {
    try {
      // The heading only reads the snapshot. A collapsed section is drawn with
      // this call alone, so scheduling a refresh here would make it cost the
      // network it is supposed to cost nothing.
      if (snapshot === null || snapshot.status !== 'ready') return undefined;
      return `${snapshot.mine.length} mine · ${snapshot.assigned.length} assigned`;
    } catch {
      return undefined;
    }
  }

  function snapshotOf() {
    return snapshot;
  }

  function dispose() {
    disposed = true;
    scheduled = false;
  }

  const section = {
    id: sectionId,
    title,
    rowLabel,
    defaultVisible: true,
    meta,
    lines,
  };

  return { section, refresh, refreshIfStale, invalidate, snapshot: snapshotOf, dispose };
}

module.exports = { createIssuesSection };

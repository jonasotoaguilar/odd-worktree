'use strict';
// S9 (issues-sidebar, T14): the in-process cache of the three scoped issue
// views the rail's ONE combined read answers (`mine`, `assigned`, `involved`).
//
// Pure by contract: no imports, no child process and no clock but the one
// injected. State is process memory only — nothing is ever written to disk —
// and it is kept per repository identity (`<host>/<owner>/<repo>`), so a session
// that moves between checkouts can never show one repository's rows under
// another's name.
//
// The first sync reads up to 100 per bucket and REPLACES it. Later syncs read
// the newest 20 and MERGE by issue number. A merge cannot see an issue that was
// closed or unassigned (it simply leaves the result), so after every apply each
// bucket that is not truncated is held to one invariant: the cached row count
// must equal the `issueCount` the same response reported. A mismatch is exactly
// how a departed issue is detected, and it makes the NEXT `plan` a full re-read
// of the three buckets. A bucket whose `issueCount` exceeds `bucketCap` is
// `truncated`: the invariant is skipped for it — a bucket the cache cannot hold
// whole is never held to a count it cannot store — and the truncation is
// reported to the caller instead of being looped over.
//
// Two times are kept per entry (T15): `fullAt` moves only when a FULL apply
// replaces the buckets, and `syncedAt` moves on every apply and is what `get`
// reports. `plan` compares `fullAt` with `fullTtlMs`, so a steady stream of
// deltas can never postpone the ten-minute full re-read.
//
// `apply` also accepts the caller's start-ordered `sequence` (T15): a response
// whose sequence is older than the last one applied for that identity is ignored
// whole, so a full read that finishes after a newer one can never overwrite it.
//
// `get` hands out copies, so a consumer can never mutate the cache through a
// frame it rendered. `apply` never throws: a failed or malformed answer leaves
// the cached entry exactly as it was.

const BUCKET_KEYS = ['mine', 'assigned', 'involved'];
// The two read sizes S9 names: the first sync is the full one, every later one
// is the newest 20 that can still change what the rail shows.
const FULL_FIRST = 100;
const DELTA_FIRST = 20;
const DEFAULT_FULL_TTL_MS = 600000;
const DEFAULT_BUCKET_CAP = 100;

function updatedAtValue(row) {
  const raw = row && typeof row === 'object' ? row.updatedAt : null;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function copyIssue(row) {
  const copy = { ...row };
  if (Array.isArray(row.labels)) copy.labels = row.labels.map((label) => (label && typeof label === 'object' ? { ...label } : label));
  if (Array.isArray(row.assignees)) copy.assignees = row.assignees.slice();
  if (row.reactions && typeof row.reactions === 'object') copy.reactions = { ...row.reactions };
  return copy;
}

// The rows of one bucket, deduplicated by issue number (a later occurrence
// replaces an earlier one) and stored as copies. A row without a usable number
// cannot be merged or counted, so it never enters the cache.
function normalizeRows(rows) {
  const byNumber = new Map();
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!Number.isInteger(row.number) || row.number <= 0) continue;
    byNumber.set(row.number, copyIssue(row));
  }
  return [...byNumber.values()];
}

// A delta MERGES by issue number. The freshly read row is the newer one, so it
// replaces the stored row; a stored row whose number the delta did not mention
// stays exactly as it was (which is what lets the count invariant notice an
// issue that left the result).
function mergeRows(previous, incoming) {
  const byNumber = new Map();
  for (const row of previous || []) byNumber.set(row.number, copyIssue(row));
  for (const row of incoming) {
    const existing = byNumber.get(row.number);
    if (existing === undefined || updatedAtValue(row) >= updatedAtValue(existing)) {
      byNumber.set(row.number, row);
    }
  }
  return [...byNumber.values()];
}

function sortAndTrim(rows, cap) {
  return rows
    .slice()
    .sort((left, right) => updatedAtValue(right) - updatedAtValue(left))
    .slice(0, cap);
}

function createIssuesCache(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const fullTtlMs = Number.isFinite(opts.fullTtlMs) && opts.fullTtlMs >= 0
    ? opts.fullTtlMs
    : DEFAULT_FULL_TTL_MS;
  const bucketCap = Number.isInteger(opts.bucketCap) && opts.bucketCap > 0
    ? opts.bucketCap
    : DEFAULT_BUCKET_CAP;
  const entries = new Map();

  // The injected clock is the module's only notion of time; a clock that throws
  // or answers nonsense costs the staleness window, never a caller.
  function clock() {
    try {
      const value = now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function plan(identity) {
    const entry = entries.get(identity);
    if (!entry) return { full: true, first: FULL_FIRST };
    if (entry.inconsistent === true) return { full: true, first: FULL_FIRST };
    // T15 (S9, defect 3): the ten-minute bound is measured from the last FULL
    // read. Every delta stamps `syncedAt`, but only a full apply moves `fullAt`,
    // so a steady stream of deltas can never postpone the full re-read forever.
    const age = clock() - entry.fullAt;
    if (!Number.isFinite(age) || age >= fullTtlMs) return { full: true, first: FULL_FIRST };
    return { full: false, first: DELTA_FIRST };
  }

  function apply(identity, response, applyOptions = {}) {
    const buckets = response && response.ok === true && response.buckets && typeof response.buckets === 'object'
      ? response.buckets
      : null;
    if (buckets === null) {
      return { consistent: false, truncated: { mine: false, assigned: false, involved: false } };
    }
    const full = Boolean(applyOptions && applyOptions.full === true);
    // T15 (S9, defect 5): the caller numbers a read when it STARTS. An answer
    // older than the last one applied for this identity is ignored whole — a
    // full read that finishes after a newer one can never overwrite it.
    const sequence = Number.isFinite(applyOptions && applyOptions.sequence) ? applyOptions.sequence : null;
    const previous = entries.get(identity);
    if (sequence !== null && previous && Number.isFinite(previous.lastApplied)
      && sequence <= previous.lastApplied) {
      return { consistent: false, truncated: { ...previous.truncated } };
    }
    const at = clock();
    const next = {
      buckets: {},
      counts: {},
      truncated: {},
      inconsistent: false,
      fullAt: full || !previous ? at : previous.fullAt,
      syncedAt: at,
      lastApplied: sequence !== null
        ? sequence
        : (previous && Number.isFinite(previous.lastApplied) ? previous.lastApplied : null),
    };
    for (const key of BUCKET_KEYS) {
      const bucket = buckets[key] && typeof buckets[key] === 'object' ? buckets[key] : null;
      if (!bucket || !Number.isInteger(bucket.issueCount) || bucket.issueCount < 0
        || !Array.isArray(bucket.issues)) {
        // A malformed answer is not a state change: the cached entry stays as
        // it was and the caller is told the result is not trustworthy.
        return { consistent: false, truncated: { mine: false, assigned: false, involved: false } };
      }
      const incoming = normalizeRows(bucket.issues);
      const merged = full || !previous ? incoming : mergeRows(previous.buckets[key], incoming);
      next.buckets[key] = sortAndTrim(merged, bucketCap);
      next.counts[key] = bucket.issueCount;
      next.truncated[key] = bucket.issueCount > bucketCap;
      if (!next.truncated[key] && next.buckets[key].length !== bucket.issueCount) {
        next.inconsistent = true;
      }
    }
    entries.set(identity, next);
    return {
      consistent: next.inconsistent === false,
      truncated: { ...next.truncated },
    };
  }

  function get(identity) {
    const entry = entries.get(identity);
    if (!entry) return null;
    const buckets = {};
    for (const key of BUCKET_KEYS) {
      buckets[key] = entry.buckets[key].map(copyIssue);
    }
    return {
      buckets,
      truncated: { ...entry.truncated },
      syncedAt: entry.syncedAt,
    };
  }

  function drop(identity) {
    entries.delete(identity);
  }

  function clear() {
    entries.clear();
  }

  return { get, plan, apply, drop, clear };
}

module.exports = { createIssuesCache };

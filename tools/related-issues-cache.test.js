'use strict';
// S9 (issues-sidebar, T14): lib/related-issues-cache.js — the in-process cache of the
// three scoped issue views (`mine`, `assigned`, `involved`).
//
// Pure by contract: no imports, no child process and no clock but the one
// injected. Everything below asserts the PUBLIC object only:
// - `plan(identity)` answers a full read (100 per bucket) with no entry, an
//   entry older than `fullTtlMs` or an entry a previous apply left inconsistent,
//   and an incremental read (20 per bucket) otherwise;
// - a full apply replaces each bucket, a delta merges by issue number and a
//   newer row wins, and every bucket is sorted by `updatedAt` descending and
//   trimmed to `bucketCap`;
// - the invariant: a bucket that is not truncated must cache exactly the count
//   the response reported, and a mismatch is what makes the NEXT plan a full
//   read (a closed or unassigned issue simply leaves a delta's result);
// - a bucket whose `issueCount` exceeds `bucketCap` is `truncated` and skips the
//   invariant;
// - `get` answers copies, `drop` removes one identity and `clear` removes all.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIssuesCache } = require('../lib/related-issues-cache.js');

const ID = 'github.com/myfork/project';
const OTHER = 'github.com/myfork/other';

function issue(number, updatedAt, extra = {}) {
  return { number, title: `Issue ${number}`, updatedAt, ...extra };
}

function bucket(rows, issueCount) {
  return {
    issueCount: Number.isInteger(issueCount) ? issueCount : rows.length,
    issues: rows,
  };
}

function response({ mine = [], assigned = [], involved = [], counts = {} } = {}) {
  return {
    ok: true,
    buckets: {
      mine: bucket(mine, counts.mine),
      assigned: bucket(assigned, counts.assigned),
      involved: bucket(involved, counts.involved),
    },
  };
}

function numbers(rows) {
  return rows.map((row) => row.number);
}

test('a full apply fills every bucket, sorted by updatedAt descending', () => {
  const cache = createIssuesCache();
  assert.equal(cache.get(ID), null, 'nothing is cached before the first read');
  assert.deepEqual(cache.plan(ID), { full: true, first: 100 }, 'no entry means a full read');

  const outcome = cache.apply(ID, response({
    mine: [issue(1, '2024-01-01T00:00:00Z'), issue(2, '2024-03-01T00:00:00Z')],
    assigned: [issue(3, '2024-02-01T00:00:00Z'), issue(4, '2024-04-01T00:00:00Z')],
    involved: [issue(5, '2024-01-15T00:00:00Z')],
  }), { full: true });

  assert.deepEqual(outcome, {
    consistent: true,
    truncated: { mine: false, assigned: false, involved: false },
  });
  const got = cache.get(ID);
  assert.deepEqual(numbers(got.buckets.mine), [2, 1]);
  assert.deepEqual(numbers(got.buckets.assigned), [4, 3]);
  assert.deepEqual(numbers(got.buckets.involved), [5]);
  assert.equal(typeof got.syncedAt, 'number');
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 },
    'a fresh, consistent entry reads only the newest 20 per bucket');
});

test('get answers copies: a caller cannot mutate the cache', () => {
  const cache = createIssuesCache();
  cache.apply(ID, response({ assigned: [issue(1, '2024-01-01T00:00:00Z', { labels: [{ name: 'bug' }] })] }), { full: true });

  const first = cache.get(ID);
  first.buckets.assigned[0].title = 'changed outside';
  first.buckets.assigned[0].labels.push({ name: 'injected' });
  first.buckets.assigned.length = 0;
  first.truncated.assigned = true;

  const second = cache.get(ID);
  assert.equal(second.buckets.assigned[0].title, 'Issue 1', 'the stored row is untouched');
  assert.deepEqual(second.buckets.assigned[0].labels, [{ name: 'bug' }]);
  assert.equal(second.truncated.assigned, false);
});

test('a delta merges by issue number and a newer row replaces the older one', () => {
  const cache = createIssuesCache();
  cache.apply(ID, response({
    assigned: [issue(1, '2024-01-01T00:00:00Z'), issue(2, '2024-02-01T00:00:00Z')],
  }), { full: true });

  const outcome = cache.apply(ID, response({
    assigned: [
      issue(2, '2024-05-01T00:00:00Z', { title: 'Issue 2 (updated)' }),
      issue(3, '2024-06-01T00:00:00Z'),
    ],
    counts: { assigned: 3 },
  }), { full: false });

  assert.equal(outcome.consistent, true, 'every delta row merged and the count still matches');
  const got = cache.get(ID);
  assert.deepEqual(numbers(got.buckets.assigned), [3, 2, 1]);
  assert.equal(got.buckets.assigned[1].title, 'Issue 2 (updated)', 'the newer row won');
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 });
});

test('each bucket is sorted by updatedAt and trimmed to bucketCap', () => {
  const cache = createIssuesCache({ bucketCap: 3 });
  const outcome = cache.apply(ID, response({
    assigned: [
      issue(1, '2024-01-01T00:00:00Z'),
      issue(2, '2024-05-01T00:00:00Z'),
      issue(3, '2024-03-01T00:00:00Z'),
      issue(4, '2024-02-01T00:00:00Z'),
      issue(5, '2024-04-01T00:00:00Z'),
    ],
    counts: { assigned: 5 },
  }), { full: true });

  assert.deepEqual(numbers(cache.get(ID).buckets.assigned), [2, 5, 3], 'the three newest survive');
  assert.equal(outcome.truncated.assigned, true, 'the bucket holds more than the cap');
  assert.equal(outcome.consistent, true, 'a truncated bucket skips the count invariant');
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 });
});

test('a delta after an issue left the set breaks the invariant and the next plan is full', () => {
  const cache = createIssuesCache();
  cache.apply(ID, response({
    assigned: [issue(1, '2024-01-01T00:00:00Z'), issue(2, '2024-02-01T00:00:00Z')],
  }), { full: true });

  // Issue 1 was closed, so the delta (the newest 20) cannot see it: the cached
  // rows still hold two issues while the response reports one.
  const outcome = cache.apply(ID, response({
    assigned: [issue(2, '2024-03-01T00:00:00Z')],
  }), { full: false });

  assert.equal(outcome.consistent, false, 'the mismatch is detected, never hidden');
  assert.equal(outcome.truncated.assigned, false);
  assert.deepEqual(cache.plan(ID), { full: true, first: 100 },
    'the next sync re-reads every bucket in full');

  // A full re-read clears the inconsistency.
  const repaired = cache.apply(ID, response({ assigned: [issue(2, '2024-03-01T00:00:00Z')] }), { full: true });
  assert.equal(repaired.consistent, true);
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 });
});

test('a truncated bucket skips the count invariant on a delta too', () => {
  const cache = createIssuesCache({ bucketCap: 2 });
  const first = cache.apply(ID, response({
    assigned: [issue(1, '2024-01-01T00:00:00Z'), issue(2, '2024-02-01T00:00:00Z')],
    counts: { assigned: 50 },
  }), { full: true });
  assert.deepEqual(first.truncated, { mine: false, assigned: true, involved: false });
  assert.equal(first.consistent, true, 'a bucket larger than the cap is never held to a count it cannot store');

  const delta = cache.apply(ID, response({
    assigned: [issue(1, '2024-03-01T00:00:00Z'), issue(3, '2024-04-01T00:00:00Z')],
    counts: { assigned: 50 },
  }), { full: false });
  assert.equal(delta.consistent, true, 'the invariant stays skipped while the bucket is truncated');
  assert.deepEqual(numbers(cache.get(ID).buckets.assigned), [3, 1], 'merged, sorted and capped');
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 });
});

test('fullTtlMs makes an aged entry plan a full read', () => {
  let clock = 1000;
  const cache = createIssuesCache({ now: () => clock, fullTtlMs: 600000 });
  cache.apply(ID, response({ assigned: [issue(1, '2024-01-01T00:00:00Z')] }), { full: true });

  clock += 599999;
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 });
  clock += 1;
  assert.deepEqual(cache.plan(ID), { full: true, first: 100 },
    'an entry older than ten minutes re-reads in full');
});

test('entries are keyed by repository identity', () => {
  const cache = createIssuesCache();
  cache.apply(ID, response({ assigned: [issue(1, '2024-01-01T00:00:00Z')] }), { full: true });

  assert.equal(cache.get(OTHER), null, 'another repository sees nothing');
  assert.deepEqual(cache.plan(OTHER), { full: true, first: 100 });

  cache.apply(OTHER, response({ assigned: [issue(9, '2024-02-01T00:00:00Z')] }), { full: true });
  assert.deepEqual(numbers(cache.get(ID).buckets.assigned), [1]);
  assert.deepEqual(numbers(cache.get(OTHER).buckets.assigned), [9]);
});

test('drop removes one identity and clear removes every identity', () => {
  const cache = createIssuesCache();
  cache.apply(ID, response({ assigned: [issue(1, '2024-01-01T00:00:00Z')] }), { full: true });
  cache.apply(OTHER, response({ assigned: [issue(2, '2024-01-01T00:00:00Z')] }), { full: true });

  cache.drop(ID);
  assert.equal(cache.get(ID), null);
  assert.deepEqual(cache.plan(ID), { full: true, first: 100 });
  assert.deepEqual(numbers(cache.get(OTHER).buckets.assigned), [2], 'the other identity survives');

  cache.clear();
  assert.equal(cache.get(OTHER), null);
  assert.deepEqual(cache.plan(OTHER), { full: true, first: 100 });
});

test('apply never throws and a failed answer leaves the cached entry untouched', () => {
  const cache = createIssuesCache();
  cache.apply(ID, response({ assigned: [issue(1, '2024-01-01T00:00:00Z')] }), { full: true });

  for (const bad of [null, undefined, {}, { ok: false, error: 'gh failed' }]) {
    const outcome = cache.apply(ID, bad, { full: false });
    assert.equal(outcome.consistent, false);
    assert.ok(outcome.truncated, 'the outcome still reports the three buckets');
  }
  assert.deepEqual(numbers(cache.get(ID).buckets.assigned), [1],
    'a failed answer never mutates the cache');
  assert.deepEqual(cache.plan(ID), { full: false, first: 20 });
});

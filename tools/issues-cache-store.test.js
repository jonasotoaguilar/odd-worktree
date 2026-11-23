'use strict';
// T3 (issues-startup-perf S4): lib/issues-cache-store.js — the DISK half of the
// issues read cache.
//
// Contract under test, through the public surface only (`load`, `save`,
// `directory`):
// - ONE small versioned JSON document holds an entry per repository identity,
//   keyed exactly like `lib/related-issues-cache.js` keys its own entries, and
//   under `$XDG_CACHE_HOME/odd-worktree/` (falling back to
//   `~/.cache/odd-worktree/`);
// - an entry round-trips: the three bucket rows, `counts`, `truncated`,
//   `inconsistent`, `fullAt`, `syncedAt` and `lastApplied`;
// - `fullAt` moves only on a FULL apply, exactly like the in-memory cache;
// - the document is bounded: the oldest identities are dropped past a small cap;
// - every failure is silence, never an exception and never a half-written
//   document: a malformed document, a wrong version, a hostile entry, an
//   unreadable directory, a failed atomic write and a machine with no home all
//   answer `null`/`false`;
// - the write is atomic: a temp file in the same directory and a rename, so a
//   failure leaves the previous document exactly as it was.
//
// The `fs` seam and the directory are injected, so nothing here touches a real
// cache directory and every temp tree lives under os.tmpdir() and is removed.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIssuesCacheStore } = require('../lib/issues-cache-store.js');

const FILE = 'issues-cache.json';
const IDENTITY = 'github.com/myfork/project';
const OTHER = 'github.com/myfork/other';

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tempDir(tag = 'store') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `odd-issues-${tag}-`)));
  roots.push(dir);
  return dir;
}

function row(number, extra = {}) {
  return { number, title: `Issue ${number}`, updatedAt: '2024-01-01T00:00:00Z', state: 'OPEN', ...extra };
}

// What the loader hands over after a successful apply: the three bucket rows from
// the cache plus the facts only the loader and its response know.
function snapshot(overrides = {}) {
  return {
    buckets: { mine: [row(1)], assigned: [row(2), row(3)], involved: [] },
    counts: { mine: 1, assigned: 2, involved: 0 },
    truncated: { mine: false, assigned: false, involved: false },
    inconsistent: false,
    full: true,
    syncedAt: 1000,
    lastApplied: 4,
    ...overrides,
  };
}

function documentAt(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
}

function store(dir, extra = {}) {
  return createIssuesCacheStore({ dir, env: {}, ...extra });
}

test('S4: an entry round-trips through ONE small versioned document', async () => {
  const dir = tempDir('store-roundtrip');
  const cache = store(dir);
  assert.equal(await cache.save(IDENTITY, snapshot()), true);

  const entry = await cache.load(IDENTITY);
  assert.ok(entry, 'the entry the save wrote is the entry the load answers');
  assert.deepEqual(entry.buckets.mine.map((item) => item.number), [1]);
  assert.deepEqual(entry.buckets.assigned.map((item) => item.number), [2, 3]);
  assert.deepEqual(entry.buckets.involved, []);
  assert.equal(entry.buckets.assigned[0].title, 'Issue 2', 'the row itself survives, not just its number');
  assert.deepEqual(entry.counts, { mine: 1, assigned: 2, involved: 0 });
  assert.deepEqual(entry.truncated, { mine: false, assigned: false, involved: false });
  assert.equal(entry.inconsistent, false);
  assert.equal(entry.fullAt, 1000, 'a full apply stamps fullAt');
  assert.equal(entry.syncedAt, 1000);
  assert.equal(entry.lastApplied, 4);

  assert.deepEqual(fs.readdirSync(dir), [FILE], 'exactly one document, no stray file');
  const doc = documentAt(dir);
  assert.equal(doc.version, 2, 'the document is versioned');
  assert.equal(doc.identities.length, 1);
  assert.equal(doc.identities[0].identity, IDENTITY, 'the entry is keyed by the repository identity');
});

test('S4: a delta keeps the stored fullAt, a full apply moves it', async () => {
  const dir = tempDir('store-full-at');
  const cache = store(dir);
  await cache.save(IDENTITY, snapshot({ full: true, syncedAt: 1000, lastApplied: 1 }));
  await cache.save(IDENTITY, snapshot({ full: false, syncedAt: 5000, lastApplied: 2 }));

  const entry = await cache.load(IDENTITY);
  assert.equal(entry.fullAt, 1000, 'a steady stream of deltas never postpones the full re-read');
  assert.equal(entry.syncedAt, 5000, 'the sync time moves with every apply');
  assert.equal(entry.lastApplied, 2);

  await cache.save(IDENTITY, snapshot({ full: true, syncedAt: 9000, lastApplied: 3 }));
  assert.equal((await cache.load(IDENTITY)).fullAt, 9000, 'a full apply moves it');
});

test('S4: the document lives under $XDG_CACHE_HOME, else under the injected home', async () => {
  const base = tempDir('store-xdg');
  const fromXdg = createIssuesCacheStore({ env: { XDG_CACHE_HOME: base } });
  assert.equal(fromXdg.directory(), path.join(base, 'odd-worktree'));
  await fromXdg.save(IDENTITY, snapshot());
  assert.ok(fs.existsSync(path.join(base, 'odd-worktree', FILE)), 'the document is inside the XDG directory');

  const home = tempDir('store-home');
  const fromHome = createIssuesCacheStore({ env: {}, home });
  assert.equal(fromHome.directory(), path.join(home, '.cache', 'odd-worktree'),
    'a machine without XDG falls back to ~/.cache');
  await fromHome.save(IDENTITY, snapshot());
  assert.ok(fs.existsSync(path.join(home, '.cache', 'odd-worktree', FILE)));
});

test('S4: the document is bounded — the oldest identities are dropped past the cap', async () => {
  const dir = tempDir('store-bound');
  const cache = store(dir);
  for (let index = 1; index <= 9; index += 1) {
    await cache.save(`github.com/myfork/project-${index}`, snapshot({ syncedAt: index }));
  }
  assert.equal(await cache.load('github.com/myfork/project-1'), null, 'the oldest identity is gone');
  for (let index = 2; index <= 9; index += 1) {
    assert.ok(await cache.load(`github.com/myfork/project-${index}`), `identity ${index} is kept`);
  }
  assert.equal(documentAt(dir).identities.length, 8, 'the document holds eight identities at most');

  // Re-saving an identity moves it to the newest end, so it outlives a later save.
  await cache.save('github.com/myfork/project-2', snapshot({ syncedAt: 20 }));
  await cache.save('github.com/myfork/project-10', snapshot({ syncedAt: 10 }));
  assert.ok(await cache.load('github.com/myfork/project-2'), 'a refreshed identity is the newest, not the oldest');
  assert.equal(await cache.load('github.com/myfork/project-3'), null, 'and the identity that was oldest goes');
});

test('S4: a malformed document is silence, and the next save replaces it', async () => {
  const dir = tempDir('store-malformed');
  fs.writeFileSync(path.join(dir, FILE), '{ this is not json');
  const cache = store(dir);
  assert.equal(await cache.load(IDENTITY), null, 'a document that does not parse answers nothing');
  assert.equal(await cache.save(IDENTITY, snapshot()), true);
  assert.ok(await cache.load(IDENTITY));
});

test('S4: a wrong version is silence, and the next save writes the current one', async () => {
  const dir = tempDir('store-version');
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({
    version: 99,
    identities: [{ identity: IDENTITY, buckets: { mine: [row(1)], assigned: [], involved: [] } }],
  }));
  const cache = store(dir);
  assert.equal(await cache.load(IDENTITY), null, 'a version this module does not know is never read');
  assert.equal(await cache.save(IDENTITY, snapshot()), true);
  assert.equal(documentAt(dir).version, 2);
});

test('S4: a hostile entry is dropped and every other identity still answers', async () => {
  const dir = tempDir('store-hostile');
  const cache = store(dir);
  await cache.save(OTHER, snapshot());
  const doc = documentAt(dir);
  doc.identities.push({ identity: IDENTITY, buckets: 'not buckets', counts: {}, truncated: {}, inconsistent: false, fullAt: 1, syncedAt: 1, lastApplied: 1 });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(doc));

  assert.equal(await cache.load(IDENTITY), null, 'an entry whose shape is wrong is not a cached read');
  assert.ok(await cache.load(OTHER), 'the neighbour it was written beside is untouched');
});

test('S4: a failed atomic write leaves the previous document and never throws', async () => {
  const dir = tempDir('store-atomic');
  const cache = store(dir);
  await cache.save(IDENTITY, snapshot({ syncedAt: 1000, lastApplied: 1 }));

  const failing = store(dir, {
    fs: {
      ...fs.promises,
      rename: async () => { throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }); },
    },
  });
  assert.equal(await failing.save(IDENTITY, snapshot({ syncedAt: 9000, lastApplied: 2 })), false,
    'a write that cannot be committed answers false instead of throwing');

  const entry = await cache.load(IDENTITY);
  assert.equal(entry.syncedAt, 1000, 'the previous document is exactly as it was');
  assert.deepEqual(fs.readdirSync(dir), [FILE], 'and the temp file it wrote is not left behind');
});

test('S4: an unreadable directory or a missing document is silence', async () => {
  const dir = tempDir('store-unreadable');
  const missing = store(path.join(dir, 'not-created-yet'));
  assert.equal(await missing.load(IDENTITY), null, 'a missing document is nothing to hydrate');

  const unreadable = store(dir, {
    fs: {
      ...fs.promises,
      readFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
    },
  });
  assert.equal(await unreadable.load(IDENTITY), null, 'an unreadable directory answers nothing');
});

test('S4: a machine with no home and no XDG has no cache directory, and says so by silence', async () => {
  const cache = createIssuesCacheStore({ env: {}, home: null });
  assert.equal(cache.directory(), null, 'there is no directory to name');
  assert.equal(await cache.load(IDENTITY), null);
  assert.equal(await cache.save(IDENTITY, snapshot()), false);
});

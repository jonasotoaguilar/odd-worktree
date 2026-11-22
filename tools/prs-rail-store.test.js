'use strict';
// T4 (S4, S5): lib/prs-rail-store.js — the DISK half of the rail's pull-request
// read.
//
// Contract under test, through the public surface only (`load`, `save`,
// `directory`):
// - ONE small versioned JSON document holds an entry per repository identity,
//   keyed exactly as the rail keys its reads (`<host>/<owner>/<repo>`) and under
//   `$XDG_CACHE_HOME/odd-worktree/` (falling back to `~/.cache/odd-worktree/`),
//   so a cold start paints the `pr` count before any child runs;
// - an entry round-trips the two buckets the rail counts — the viewer's own pull
//   requests (`mine`) and the ones they must review (`review`) — each row's
//   number and the issues it links (`linkedIssues`), plus `syncedAt`;
// - the count is DERIVED from those rows (the distinct numbers in mine ∪
//   review), so a stored count can never contradict the rows it is painted from
//   and persistence cannot turn a stale entry into a fresh one;
// - the document is bounded: the oldest identities are dropped past eight;
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

const { createPrsRailStore } = require('../lib/prs-rail-store.js');

const FILE = 'prs-rail.json';
const IDENTITY = 'github.com/myfork/project';
const OTHER = 'github.com/myfork/other';

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tempDir(tag = 'store') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `odd-prs-${tag}-`)));
  roots.push(dir);
  return dir;
}

function row(number, linkedIssues = []) {
  return { number, title: `Pull ${number}`, updatedAt: '2024-01-01T00:00:00Z', linkedIssues };
}

// What the loader hands over after a successful rail read: the two buckets and
// when it read them.
function snapshot(overrides = {}) {
  return {
    mine: [row(69, [63])],
    review: [row(70, [64, 65]), row(69, [63])],
    syncedAt: 1000,
    ...overrides,
  };
}

function documentAt(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
}

function store(dir, extra = {}) {
  return createPrsRailStore({ dir, env: {}, ...extra });
}

test('S4: an entry round-trips through ONE small versioned document', async () => {
  const dir = tempDir('store-roundtrip');
  const cache = store(dir);
  assert.equal(await cache.save(IDENTITY, snapshot()), true);

  const entry = await cache.load(IDENTITY);
  assert.ok(entry, 'the entry the save wrote is the entry the load answers');
  assert.deepEqual(entry.mine.map((item) => item.number), [69]);
  assert.deepEqual(entry.review.map((item) => item.number), [70, 69],
    'a pull request in both buckets keeps its place in both');
  assert.deepEqual(entry.mine[0].linkedIssues, [63], 'the linked issues survive, not just the number');
  assert.deepEqual(entry.review[0].linkedIssues, [64, 65]);
  assert.equal(entry.syncedAt, 1000);

  assert.deepEqual(fs.readdirSync(dir), [FILE], 'exactly one document, no stray file');
  const doc = documentAt(dir);
  assert.equal(doc.version, 1, 'the document is versioned');
  assert.equal(doc.identities.length, 1);
  assert.equal(doc.identities[0].identity, IDENTITY, 'the entry is keyed by the repository identity');
});

// S4: the header paints the distinct numbers in mine ∪ review, never a sum and
// never a number read out of the document — 69 is in both buckets and counts
// once.
test('S4: the count is the distinct union of the two buckets, derived from the rows', async () => {
  const dir = tempDir('store-count');
  const cache = store(dir);
  await cache.save(IDENTITY, snapshot());
  assert.equal((await cache.load(IDENTITY)).count, 2, '69 in both buckets is one pull request');

  await cache.save(IDENTITY, snapshot({ mine: [], review: [] }));
  assert.equal((await cache.load(IDENTITY)).count, 0, 'no pull request is a real count');
});

test('S4: a stored count that contradicts its rows is never trusted', async () => {
  const dir = tempDir('store-forged-count');
  const cache = store(dir);
  await cache.save(IDENTITY, snapshot());
  const doc = documentAt(dir);
  doc.identities[0].count = 99;
  doc.identities[0].mine = [row(69), row(71)];
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(doc));

  const entry = await cache.load(IDENTITY);
  assert.equal(entry.count, 3, 'the rows decide the count (69, 70, 71), never the 99 written beside them');
  assert.deepEqual(entry.mine.map((item) => item.number), [69, 71]);
});

test('S4: the document lives under $XDG_CACHE_HOME, else under the injected home', async () => {
  const base = tempDir('store-xdg');
  const fromXdg = createPrsRailStore({ env: { XDG_CACHE_HOME: base } });
  assert.equal(fromXdg.directory(), path.join(base, 'odd-worktree'));
  await fromXdg.save(IDENTITY, snapshot());
  assert.ok(fs.existsSync(path.join(base, 'odd-worktree', FILE)), 'the document is inside the XDG directory');

  const home = tempDir('store-home');
  const fromHome = createPrsRailStore({ env: {}, home });
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
    identities: [{ identity: IDENTITY, mine: [row(69)], review: [], syncedAt: 1 }],
  }));
  const cache = store(dir);
  assert.equal(await cache.load(IDENTITY), null, 'a version this module does not know is never read');
  assert.equal(await cache.save(IDENTITY, snapshot()), true);
  assert.equal(documentAt(dir).version, 1);
});

test('S4: a hostile entry is dropped and every other identity still answers', async () => {
  const dir = tempDir('store-hostile');
  const cache = store(dir);
  await cache.save(OTHER, snapshot());
  const doc = documentAt(dir);
  doc.identities.push({ identity: IDENTITY, mine: 'not rows', review: [], syncedAt: 1 });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(doc));

  assert.equal(await cache.load(IDENTITY), null, 'an entry whose shape is wrong is not a cached read');
  assert.ok(await cache.load(OTHER), 'the neighbour it was written beside is untouched');
});

// S4: a row the rail would drop is dropped here too, so nothing counts a pull
// request that has no number or links an issue that is not one.
test('S4: unusable rows and linked issues are dropped, and the count follows the survivors', async () => {
  const dir = tempDir('store-rows');
  const cache = store(dir);
  await cache.save(IDENTITY, {
    mine: [
      { number: 69, linkedIssues: [63, 'x', 0, 63, 64] },
      { number: 0, linkedIssues: [1] },
      { number: 'seventy', linkedIssues: [] },
      'not a row',
    ],
    review: [{ number: 70, linkedIssues: 'not links' }],
    syncedAt: 2000,
  });

  const entry = await cache.load(IDENTITY);
  assert.deepEqual(entry.mine.map((item) => item.number), [69], 'only a positive integer number is a row');
  assert.deepEqual(entry.mine[0].linkedIssues, [63, 64], 'links are positive integers, in order, without repeats');
  assert.deepEqual(entry.review[0].linkedIssues, [], 'a bucket that is not a link list links nothing');
  assert.equal(entry.count, 2, 'the dropped rows count nothing');
});

test('S4: a failed atomic write leaves the previous document and never throws', async () => {
  const dir = tempDir('store-atomic');
  const cache = store(dir);
  await cache.save(IDENTITY, snapshot({ syncedAt: 1000 }));

  const failing = store(dir, {
    fs: {
      ...fs.promises,
      rename: async () => { throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }); },
    },
  });
  assert.equal(await failing.save(IDENTITY, snapshot({ syncedAt: 9000 })), false,
    'a write that cannot be committed answers false instead of throwing');

  const entry = await cache.load(IDENTITY);
  assert.equal(entry.syncedAt, 1000, 'the previous document is exactly as it was');
  assert.deepEqual(fs.readdirSync(dir), [FILE], 'and the temp file it wrote is not left behind');
});

test('S4: an unreadable directory or a missing document is silence', async () => {
  const dir = tempDir('store-unreadable');
  const missing = store(path.join(dir, 'not-created-yet'));
  assert.equal(await missing.load(IDENTITY), null, 'a missing document is nothing to paint');

  const unreadable = store(dir, {
    fs: {
      ...fs.promises,
      readFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
    },
  });
  assert.equal(await unreadable.load(IDENTITY), null, 'an unreadable directory answers nothing');
});

test('S4: an fs seam that throws from every call is silence, never an exception', async () => {
  const thrower = async () => { throw new Error('EIO: i/o error'); };
  const broken = createPrsRailStore({
    dir: tempDir('store-broken'),
    env: {},
    fs: { readFile: thrower, writeFile: thrower, mkdir: thrower, rename: thrower, unlink: thrower },
  });
  assert.equal(await broken.load(IDENTITY), null);
  assert.equal(await broken.save(IDENTITY, snapshot()), false);
});

test('S4: a machine with no home and no XDG has no cache directory, and says so by silence', async () => {
  const cache = createPrsRailStore({ env: {}, home: null });
  assert.equal(cache.directory(), null, 'there is no directory to name');
  assert.equal(await cache.load(IDENTITY), null);
  assert.equal(await cache.save(IDENTITY, snapshot()), false);
});

test('S4: an identity this module cannot key is never read or written', async () => {
  const dir = tempDir('store-identity');
  const cache = store(dir);
  assert.equal(await cache.load(''), null);
  assert.equal(await cache.load(null), null);
  assert.equal(await cache.save('', snapshot()), false);
  assert.equal(await cache.save(IDENTITY, null), false, 'a snapshot that is not one is not written');
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written at all');
});

'use strict';
// T4 (odd-rail-section S9, S12, S13 and S5's tie rule): lib/odd-rail-model.js, the
// pure row model the rail's section draws from.
//
// What is asserted here, through the module's ONE public function:
// - ONE row per ODD NAME, never one per checkout (S12): a name present in main and
//   in a worktree is one entry, and the elected copy is the one the click opens.
// - The election is Option A, the user's decision: the MOST RECENT `mtimeMs` wins;
//   on an exact tie MAIN wins; between two worktrees the FIRST GROUP in order keeps
//   it — so the answer never depends on the order a caller happened to sort with.
// - Order (S9): the names `oddSession.touched()` names first, by the touch's `at`
//   most recent first, then everything else by `mtimeMs` descending, then by name
//   in code units (never `localeCompare`, so every host agrees).
// - Attribution only ORDERS: a touched name no group lists produces no row, and a
//   touch never adds a row, removes one or duplicates one.
// - A worktree group with `docs: []` contributes nothing (S13), and a malformed
//   group, document or touch is skipped instead of thrown on.
// - Pure: no fs, no git, no clock, and the inputs are never mutated.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { railRows } = require('../lib/odd-rail-model.js');

const MAIN = 'main';
const DOC_DIR = path.resolve('/odd-rail-model/checkout/odd/tasks');
const WT_DIR = path.resolve('/odd-rail-model/checkout-worktrees/wt-a');
const WT_B = path.resolve('/odd-rail-model/checkout-worktrees/wt-b');

// The three fields a row carries besides its own `mtimeMs`, so an assertion about
// WHICH copy was elected reads as one comparison.
const picked = (rows) => rows.map((row) => [row.name, row.checkoutName, row.docPath]);

// T2 (odd-rail-session-scope S2): the association is the rail's FILTER, so every
// call names one. `all(...)` is "this session is associated with all of them",
// which is what the pre-association cases below mean by "draw the list".
const all = (...names) => new Set(names);

function doc(name, root, mtimeMs) {
  return { name, docPath: path.join(root, 'odd', 'tasks', `${name}.md`), mtimeMs };
}

// The main group always carries every document; a worktree carries only its delta.
function mainGroup(names, times = {}) {
  return {
    checkoutName: MAIN,
    checkoutRoot: path.resolve('/odd-rail-model/checkout'),
    isMain: true,
    docs: names.map((name) => doc(name, path.resolve('/odd-rail-model/checkout'), times[name] ?? 0)),
  };
}

function worktreeGroup(name, root, docs) {
  return { checkoutName: name, checkoutRoot: root, isMain: false, docs };
}

describe('one row per ODD name (S12)', () => {
  test('a name in main and in a worktree is ONE row, and the newest copy is elected', () => {
    const groups = [
      mainGroup(['alpha', 'beta'], { alpha: 1000, beta: 2000 }),
      worktreeGroup('wt-a', WT_DIR, [doc('alpha', WT_DIR, 3000)]),
    ];
    const rows = railRows({ groups, touched: [], associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) });
    assert.deepEqual(
      picked(rows),
      [
        ['alpha', 'wt-a', path.join(WT_DIR, 'odd', 'tasks', 'alpha.md')],
        ['beta', MAIN, path.join('/odd-rail-model/checkout/odd/tasks', 'beta.md')],
      ],
      'one row per name, the elected copy named by `checkoutName`',
    );
    // Order is recency: the elected alpha (3000) is newer than beta (2000).
    assert.equal(rows[0].mtimeMs, 3000);
    assert.equal(rows[1].mtimeMs, 2000);
  });

  test('an exact tie between main and a worktree keeps main (S5)', () => {
    const groups = [
      mainGroup(['alpha'], { alpha: 5000 }),
      worktreeGroup('wt-a', WT_DIR, [doc('alpha', WT_DIR, 5000)]),
    ];
    assert.deepEqual(picked(railRows({ groups, touched: [], associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) })), [
      ['alpha', MAIN, path.join('/odd-rail-model/checkout/odd/tasks', 'alpha.md')],
    ]);
  });

  test('an exact tie between two worktrees keeps the FIRST group in order', () => {
    const groups = [
      mainGroup([], {}),
      worktreeGroup('wt-a', WT_DIR, [doc('alpha', WT_DIR, 7000)]),
      worktreeGroup('wt-b', WT_B, [doc('alpha', WT_B, 7000)]),
    ];
    assert.deepEqual(picked(railRows({ groups, touched: [], associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) })), [
      ['alpha', 'wt-a', path.join(WT_DIR, 'odd', 'tasks', 'alpha.md')],
    ]);
  });

  test('a newer worktree copy beats an older main copy, and main is never an override', () => {
    const groups = [
      mainGroup(['alpha'], { alpha: 10 }),
      worktreeGroup('wt-a', WT_DIR, [doc('alpha', WT_DIR, 20)]),
    ];
    assert.deepEqual(picked(railRows({ groups, touched: [], associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) })), [
      ['alpha', 'wt-a', path.join(WT_DIR, 'odd', 'tasks', 'alpha.md')],
    ]);
  });

  test('a worktree group with no delta contributes nothing (S13)', () => {
    const groups = [
      mainGroup(['alpha', 'beta'], { alpha: 200, beta: 100 }),
      worktreeGroup('wt-a', WT_DIR, []),
    ];
    const rows = railRows({ groups, touched: [], associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) });
    assert.deepEqual(rows.map((row) => [row.name, row.checkoutName]), [['alpha', MAIN], ['beta', MAIN]],
      'main only, and no row for the empty worktree');
  });
});

describe('order: attribution first, then recency, then name (S9)', () => {
  test('a touched name comes first, ordered by its touch, most recent first', () => {
    const groups = [mainGroup(['alpha', 'beta', 'gamma'], { alpha: 900, beta: 800, gamma: 700 })];
    const touched = [
      { path: path.join(DOC_DIR, 'gamma.md'), name: 'gamma', at: 20 },
      { path: path.join(DOC_DIR, 'beta.md'), name: 'beta', at: 10 },
    ];
    assert.deepEqual(railRows({ groups, touched, associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) }).map((row) => row.name), ['gamma', 'beta', 'alpha'],
      'the MOST recent touch is first, then the older one, then plain recency');
  });

  test('a touched name no group lists produces no row, and never a duplicate (S9)', () => {
    const groups = [mainGroup(['alpha'], { alpha: 1 })];
    const touched = [{ path: path.join(DOC_DIR, 'ghost.md'), name: 'ghost', at: 99 }];
    assert.deepEqual(railRows({ groups, touched, associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) }).map((row) => row.name), ['alpha'],
      'attribution only orders: it adds nothing and removes nothing');
  });

  test('equal mtimes order by name in code units, never locale', () => {
    const groups = [mainGroup(['a', 'B', 'b'], { a: 1, B: 1, b: 1 })];
    assert.deepEqual(railRows({ groups, touched: [], associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) }).map((row) => row.name), ['B', 'a', 'b'],
      'code units put B (66) before a (97); localeCompare would not');
  });

  test('an equal touch instant keeps the record’s own order', () => {
    const groups = [mainGroup(['alpha', 'beta'], { alpha: 10, beta: 20 })];
    const touched = [
      { path: path.join(DOC_DIR, 'beta.md'), name: 'beta', at: 50 },
      { path: path.join(DOC_DIR, 'alpha.md'), name: 'alpha', at: 50 },
    ];
    assert.deepEqual(railRows({ groups, touched, associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) }).map((row) => row.name), ['beta', 'alpha']);
  });
});

describe('malformed input is skipped, never thrown on', () => {
  test('garbage groups, documents and touches answer an empty or partial list', () => {
    assert.deepEqual(railRows({}), []);
    assert.deepEqual(railRows(), []);
    assert.deepEqual(railRows({ groups: 'nope', touched: 'nope', associated: all('alpha') }), []);
    assert.deepEqual(railRows({ groups: [null, 7, {}, { docs: 'nope' }], touched: [null, 5], associated: all('alpha') }), []);
    const rows = railRows({
      groups: [
        { docs: [{ name: 'alpha', docPath: '/x/alpha.md', mtimeMs: 4 }, null, { name: 5 }, { docPath: '/y/z.md' }] },
        { docs: [{ name: 'beta', docPath: '/x/beta.md', mtimeMs: 'nonsense' }] },
      ],
      touched: [{ name: 'alpha' }, null, { at: 3 }, { name: '', at: 1 }],
      associated: all('alpha', 'beta'),
    });
    assert.deepEqual(rows.map((row) => [row.name, row.mtimeMs]), [['alpha', 4], ['beta', 0]],
      'a document with no usable time sorts oldest and reports 0; a touch with no instant is ignored');
  });

  test('the inputs are never mutated', () => {
    const groups = [mainGroup(['alpha', 'beta'], { alpha: 2, beta: 1 })];
    const touched = [{ path: path.join(DOC_DIR, 'beta.md'), name: 'beta', at: 9 }];
    const groupsBefore = JSON.stringify(groups);
    const touchedBefore = JSON.stringify(touched);
    railRows({ groups, touched, associated: all(...groups.flatMap((g) => (g.docs || []).map((d) => d.name))) });
    assert.equal(JSON.stringify(groups), groupsBefore);
    assert.equal(JSON.stringify(touched), touchedBefore);
  });

  test('it is pure: the module loads nothing but the model it exports', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'odd-rail-model.js'), 'utf8');
    for (const forbidden of ['node:fs', 'node:child_process', 'node:os', 'Date.now', 'localeCompare(']) {
      assert.equal(source.includes(forbidden), false, `lib/odd-rail-model.js must not use ${forbidden}`);
    }
    assert.deepEqual(Object.keys(require('../lib/odd-rail-model.js')), ['railRows']);
  });
});

// T2 (odd-rail-session-scope S2): the association is the FILTER. The rail lists
// only the ODDs the session is associated with — never "everything on disk" — and
// the live touch record is unioned in, so a document this session just wrote shows
// even before the history read sees it.
describe('only the session’s association draws (S2)', () => {
  test('the associated names are drawn, and every other document on disk is not', () => {
    const groups = [mainGroup(['alpha', 'beta', 'gamma'], { alpha: 900, beta: 800, gamma: 700 })];
    assert.deepEqual(
      railRows({ groups, touched: [], associated: all('beta') }).map((row) => row.name),
      ['beta'],
      'a fresh session associated with one ODD draws one row, not the four the disk holds',
    );
    assert.deepEqual(
      railRows({ groups, touched: [], associated: all('gamma', 'alpha') }).map((row) => row.name),
      ['alpha', 'gamma'],
      'the election and the recency order are unchanged inside the association',
    );
  });

  test('an empty association draws nothing at all', () => {
    const groups = [mainGroup(['alpha', 'beta'], { alpha: 2, beta: 1 })];
    assert.deepEqual(railRows({ groups, touched: [], associated: new Set() }), []);
    assert.deepEqual(railRows({ groups, associated: new Set() }), []);
  });

  test('a live touch is unioned in, and a touched name with no document stays hidden', () => {
    const groups = [mainGroup(['alpha', 'beta', 'gamma'], { alpha: 900, beta: 800, gamma: 700 })];
    const touched = [
      { path: path.join(DOC_DIR, 'gamma.md'), name: 'gamma', at: 30 },
      { path: path.join(DOC_DIR, 'ghost.md'), name: 'ghost', at: 20 },
    ];
    assert.deepEqual(
      railRows({ groups, touched, associated: all('beta') }).map((row) => row.name),
      ['gamma', 'beta'],
      'the touched document draws (first, by its touch) although history does not name it yet',
    );
    assert.equal(
      railRows({ groups, touched, associated: all('beta') }).some((row) => row.name === 'ghost'),
      false,
      'a touched name no group lists produces nothing, exactly as before',
    );
    // A touch never ADDS a name outside the election to the association: it is one
    // of the names already elected by the grouped model, not a row of its own.
    assert.equal(railRows({ groups, touched, associated: all() }).length, 1);
  });

  test('a garbage association draws nothing instead of throwing', () => {
    const groups = [mainGroup(['alpha'], { alpha: 1 })];
    for (const associated of [undefined, null, 'alpha', 42, {}, [null, 5]]) {
      assert.deepEqual(railRows({ groups, touched: [], associated }), [], String(associated));
    }
    // The two accepted shapes, and a malformed member inside one of them.
    assert.deepEqual(railRows({ groups, touched: [], associated: new Set(['alpha']) }).map((row) => row.name), ['alpha']);
    assert.deepEqual(railRows({ groups, touched: [], associated: ['alpha', null, 7] }).map((row) => row.name), ['alpha']);
    assert.deepEqual(railRows({ groups, touched: [], associated: new Set([null, '']) }), []);
  });
});

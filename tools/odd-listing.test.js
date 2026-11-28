'use strict';
// T14 (odd-rail-section L11's redesign): lib/odd-listing.js, the ONE listing value
// the ODD panel's list and the bare `/odd` menu both consume, so their labels and
// their ORDER can never diverge again and no two rows can collide.
//
// What is asserted here, through the module's TWO public exports:
// - Identity is the RESOLVED ABSOLUTE PATH (L11): the same document reached from
//   two groups, or spelled with a `./` or a trailing separator, is ONE entry and
//   ONE menu row, and the first occurrence is the one that is kept.
// - Labels (L11 defect: two worktrees sharing a basename both read
//   `collision (same checkout)`): a unique name stays EXACTLY the name; a name
//   that appears twice is labelled `<name> (<checkoutName>)`; two checkouts with
//   the SAME `checkoutName` are distinguished by the SHORTEST distinguishing
//   trailing path segments (`a/proj-x` vs `b/proj-x`, and deeper when two roots
//   still end alike); a generated label that still hits a literal document name
//   (or another label) takes ` #2`, ` #3`. Every label in the listing is unique.
// - Order: ONE comparator (`compareEntries`) — `mtimeMs` descending, then name in
//   code units, then the CHECKOUT that holds the copy, then path in code units,
//   exactly the rule lib/odd-docs.js's `orderDocs` and lib/odd-group.js's
//   `compareDocs` already use. A caller that
//   hands an entry a finite `order` keeps ITS sequence (the extension passes main's
//   lib/odd-docs.js rank, whose commit recency is not mtime), with
//   `compareEntries` breaking ties; a caller that hands nothing gets the
//   comparator's order, exactly as before. The menu is the panel's order flattened
//   group by group, main's group first, so picking the first entry opens what the
//   panel's first row shows (L11 defect: `/odd`'s degraded menu order had regressed
//   against 53ae2b2, whose menu read a main checkout's documents in that rank).
// - Checkout: every entry carries `checkout`, the checkout it was listed from — the
//   model's own `checkoutName`, disambiguated by the same rule the labels use when two
//   checkouts share a basename. The panel reads it at a row's right edge
//   (odd-dedupe S6); the menu rows do not carry it, so the degraded menu is unchanged.
// - Fail closed: junk is skipped, never thrown on; a document with no readable
//   mtime is the oldest (`mtimeMs` 0) and still appears; an empty group vanishes.
// - Pure: no fs, no git, no clock, and the inputs are never mutated.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const listing = require('../lib/odd-listing.js');
const { buildListing, compareEntries } = listing;

const SRC = path.join(__dirname, '..', 'lib', 'odd-listing.js');
const MAIN_ROOT = path.resolve('/odd-listing/checkout');
const TASKS = path.join(MAIN_ROOT, 'odd', 'tasks');
const rootOf = (...parts) => path.resolve('/odd-listing', ...parts);

// A grouped-model document (`odd-group.js`'s shape) and its group.
const doc = (root, name, mtimeMs) => ({ name, docPath: path.join(root, 'odd', 'tasks', `${name}.md`), mtimeMs });
const checkoutGroup = (checkoutName, checkoutRoot, docs, isMain = false) => ({
  checkoutName,
  checkoutRoot,
  isMain,
  docs,
});

// Labels in the order the listing draws them, which is what the panel shows.
const labelsOf = (result) => result.groups.flatMap((group) => group.entries.map((entry) => entry.label));
// The panel's order flattened: name and label of every menu row, in order.
const menuOf = (result) => result.menu.map((row) => [row.name, row.label]);
// The panel list's labels; the menu carries the very same ones (asserted below).
const everyLabel = (result) => labelsOf(result);

describe('identity is the resolved absolute path', () => {
  test('the same path twice is emitted ONCE, and the first occurrence is kept', () => {
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [
          doc(MAIN_ROOT, 'alpha', 10),
          { name: 'alpha', docPath: path.join(MAIN_ROOT, 'odd', 'tasks', './alpha.md'), mtimeMs: 99 },
        ], true),
      ],
    });
    assert.equal(result.menu.length, 1, 'one document, one menu row');
    assert.deepEqual(result.groups[0].entries, [
      { path: path.join(TASKS, 'alpha.md'), name: 'alpha', mtimeMs: 10, checkout: 'main', label: 'alpha' },
    ], 'the FIRST occurrence supplies name, time and label');
  });

  test('the same path reached from two groups is ONE entry in the first group', () => {
    const shared = path.join(TASKS, 'alpha.md');
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10)], true),
        checkoutGroup('wt-a', rootOf('checkout-worktrees', 'wt-a'), [
          { name: 'alpha', docPath: `${shared}/`, mtimeMs: 20 },
          { name: 'beta', docPath: path.join(rootOf('checkout-worktrees', 'wt-a'), 'odd', 'tasks', 'beta.md'), mtimeMs: 5 },
        ]),
      ],
    });
    assert.deepEqual(result.menu.map((row) => row.path), [
      shared,
      path.join(rootOf('checkout-worktrees', 'wt-a'), 'odd', 'tasks', 'beta.md'),
    ], 'the duplicate path is not offered twice, and it stays in the group that first held it');
    assert.deepEqual(result.groups.map((group) => group.entries.length), [1, 1]);
    assert.equal(result.menu.filter((row) => row.label === 'alpha').length, 1);
  });

  test('a group whose only document was already emitted vanishes (no empty group)', () => {
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10)], true),
        checkoutGroup('wt-a', rootOf('checkout-worktrees', 'wt-a'), [
          { name: 'alpha', docPath: path.join(MAIN_ROOT, 'odd', 'tasks', 'alpha.md'), mtimeMs: 10 },
        ]),
      ],
    });
    assert.deepEqual(result.groups.map((group) => group.checkoutName), ['main']);
  });
});

describe('labels: derived, unique, and stable', () => {
  test('a unique name stays EXACTLY the name, with no suffix and no decoration', () => {
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10)], true),
        checkoutGroup('wt-a', rootOf('checkout-worktrees', 'wt-a'), [doc(rootOf('checkout-worktrees', 'wt-a'), 'beta', 20)]),
      ],
    });
    assert.deepEqual(labelsOf(result), ['alpha', 'beta'], 'the baseline’s plain text survives');
    assert.deepEqual(menuOf(result), [['alpha', 'alpha'], ['beta', 'beta']]);
  });

  test('a name that appears more than once is labelled `<name> (<checkoutName>)`', () => {
    const wtRoot = rootOf('checkout-worktrees', 'wt-a');
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'collision', 10)], true),
        checkoutGroup('wt-a', wtRoot, [doc(wtRoot, 'collision', 20)]),
      ],
    });
    assert.deepEqual(labelsOf(result), ['collision (main)', 'collision (wt-a)']);
  });

  test('(a) two checkouts sharing a basename get DISTINCT, stable labels (fixture of L11)', () => {
    const a = rootOf('a', 'proj-x');
    const b = rootOf('b', 'proj-x');
    const groups = [
      checkoutGroup('proj-x', a, [doc(a, 'collision', 10)]),
      checkoutGroup('proj-x', b, [doc(b, 'collision', 20)]),
    ];
    const result = buildListing({ groups });
    assert.deepEqual(labelsOf(result), ['collision (a/proj-x)', 'collision (b/proj-x)'],
      'the shortest trailing segments that tell the two roots apart, never `checkoutName` twice');
    assert.equal(new Set(labelsOf(result)).size, 2, 'distinct labels');
    assert.deepEqual(
      result.menu.map((row) => [row.path, row.label]),
      [
        [path.join(a, 'odd', 'tasks', 'collision.md'), 'collision (a/proj-x)'],
        [path.join(b, 'odd', 'tasks', 'collision.md'), 'collision (b/proj-x)'],
      ],
      'and distinct menu rows, each pointing at its own copy',
    );
    // Stable: the same model answers the same labels, and the answer is the model's.
    assert.deepEqual(labelsOf(buildListing({ groups })), labelsOf(result));
  });

  test('the shortest distinguishing segments are chosen per checkout, not per pair', () => {
    const a = rootOf('a', 'proj-x');
    const b = rootOf('b', 'proj-x');
    const sub = rootOf('a', 'sub', 'proj-x');
    const result = buildListing({
      groups: [
        checkoutGroup('proj-x', a, [doc(a, 'collision', 10)]),
        checkoutGroup('proj-x', b, [doc(b, 'collision', 20)]),
        checkoutGroup('proj-x', sub, [doc(sub, 'collision', 30)]),
      ],
    });
    assert.deepEqual(labelsOf(result), [
      'collision (a/proj-x)',
      'collision (b/proj-x)',
      'collision (sub/proj-x)',
    ], 'two trailing segments already tell all three roots apart');
  });

  test('when two segments still end alike, the labels go one segment deeper', () => {
    const x = rootOf('x', 'p', 'proj-x');
    const y = rootOf('y', 'p', 'proj-x');
    const result = buildListing({
      groups: [
        checkoutGroup('proj-x', x, [doc(x, 'collision', 10)]),
        checkoutGroup('proj-x', y, [doc(y, 'collision', 20)]),
      ],
    });
    assert.deepEqual(labelsOf(result), ['collision (x/p/proj-x)', 'collision (y/p/proj-x)']);
  });

  test('(b) a document literally named like a generated label does not collide', () => {
    const wtRoot = rootOf('checkout-worktrees', 'wt');
    const literal = path.join(TASKS, 'x (main).md');
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [
          doc(MAIN_ROOT, 'x', 100),
          { name: 'x (main)', docPath: literal, mtimeMs: 50 },
        ], true),
        checkoutGroup('wt', wtRoot, [doc(wtRoot, 'x', 90)]),
      ],
    });
    const labels = labelsOf(result);
    assert.equal(new Set(labels).size, labels.length, `every label is unique: ${labels.join(' | ')}`);
    assert.equal(result.menu.length, 3, 'no row was dropped or merged to reach uniqueness');
    assert.deepEqual(labels, ['x (main) #2', 'x (main)', 'x (wt)'],
      'the literal document keeps its exact name; the generated label is the one that moves');
    // The menu is unique too, and carries the same labels as the panel list.
    assert.deepEqual(menuOf(result), [
      ['x', 'x (main) #2'],
      ['x (main)', 'x (main)'],
      ['x', 'x (wt)'],
    ]);
    assert.equal(new Set(result.menu.map((row) => row.label)).size, 3);
  });

  test('two documents with one name inside one checkout are numbered', () => {
    const first = path.join(TASKS, 'same.md');
    const second = path.join(MAIN_ROOT, 'odd', 'archive', 'same.md');
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [
          { name: 'same', docPath: second, mtimeMs: 10 },
          { name: 'same', docPath: first, mtimeMs: 10 },
        ], true),
      ],
    });
    assert.deepEqual(result.groups[0].entries.map((entry) => [entry.path, entry.label]), [
      [second, 'same (main)'],
      [first, 'same (main) #2'],
    ], 'the path tie-break decides the order (`archive` before `tasks`), and the label counter follows it');
  });

  test('every label in a mixed listing is unique, panel list and menu alike', () => {
    const a = rootOf('a', 'proj-x');
    const b = rootOf('b', 'proj-x');
    const wtRoot = rootOf('checkout-worktrees', 'wt-a');
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [
          doc(MAIN_ROOT, 'alpha', 100),
          doc(MAIN_ROOT, 'collision', 90),
          { name: 'collision (main)', docPath: path.join(TASKS, 'collision (main).md'), mtimeMs: 80 },
          doc(MAIN_ROOT, 'proj-x', 70),
        ], true),
        checkoutGroup('proj-x', a, [doc(a, 'collision', 60), doc(a, 'proj-x', 50)]),
        checkoutGroup('proj-x', b, [doc(b, 'collision', 40), doc(b, 'proj-x', 30)]),
        checkoutGroup('wt-a', wtRoot, [doc(wtRoot, 'collision', 20)]),
      ],
    });
    const labels = everyLabel(result);
    assert.equal(new Set(labels).size, labels.length, `unique across the whole listing: ${labels.join(' | ')}`);
    assert.equal(result.menu.length, 9, 'every document exactly once');
    // A literal name still wins its exact text.
    assert.equal(
      result.groups[0].entries.find((entry) => entry.path === path.join(TASKS, 'collision (main).md')).label,
      'collision (main)',
    );
  });
});

describe('each entry carries the checkout that holds it', () => {
  test('an entry names its own checkout, and two checkouts sharing a basename are told apart', () => {
    const a = rootOf('a', 'proj-x');
    const b = rootOf('b', 'proj-x');
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10)], true),
        checkoutGroup('proj-x', a, [doc(a, 'beta', 20)]),
        checkoutGroup('proj-x', b, [doc(b, 'gamma', 30)]),
      ],
    });
    assert.deepEqual(result.groups.map((group) => group.entries.map((entry) => entry.checkout)), [
      ['main'],
      ['a/proj-x'],
      ['b/proj-x'],
    ], 'a checkout alone keeps the name the model gave it; twins get the distinguishing segments');
    assert.equal(new Set(result.groups.flatMap((group) => group.entries.map((entry) => entry.checkout))).size, 3,
      'so the panel can never paint the same right-hand cell for two different copies');
  });
});

describe('order: ONE comparator, flattened group by group', () => {
  test('a main-only listing is mtime DESC, then name (the pre-redesign baseline)', () => {
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        doc(MAIN_ROOT, 'older', 1000),
        doc(MAIN_ROOT, 'newest', 3000),
        doc(MAIN_ROOT, 'middle', 2000),
      ], true)],
    });
    assert.deepEqual(result.menu.map((row) => row.name), ['newest', 'middle', 'older']);
    assert.deepEqual(result.menu.map((row) => row.path), [
      path.join(TASKS, 'newest.md'),
      path.join(TASKS, 'middle.md'),
      path.join(TASKS, 'older.md'),
    ]);
    assert.deepEqual(result.groups[0].entries.map((entry) => entry.name), ['newest', 'middle', 'older']);
  });

  test('a main-only listing with tied mtimes orders by name in code units, never locale', () => {
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        doc(MAIN_ROOT, 'a', 5000),
        doc(MAIN_ROOT, 'B', 5000),
        doc(MAIN_ROOT, 'b', 5000),
      ], true)],
    });
    assert.deepEqual(result.menu.map((row) => row.name), ['B', 'a', 'b'],
      'code units put B (66) before a (97); localeCompare would not');
  });

  test('an equal time and name are broken by the path in code units', () => {
    const early = path.join(MAIN_ROOT, 'a', 'x.md');
    const late = path.join(MAIN_ROOT, 'b', 'x.md');
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        { name: 'x', docPath: late, mtimeMs: 7 },
        { name: 'x', docPath: early, mtimeMs: 7 },
      ], true)],
    });
    assert.deepEqual(result.groups[0].entries.map((entry) => entry.path), [early, late]);
  });

  test('an equal time and name are broken by the checkout, then the path', () => {
    const main = { name: 'x', checkout: 'main', path: '/p/z/x.md', mtimeMs: 7 };
    const worktree = { name: 'x', checkout: 'zz', path: '/p/a/x.md', mtimeMs: 7 };
    assert.deepEqual([worktree, main].sort(compareEntries), [main, worktree],
      'the checkout decides in code units (`main` before `zz`), never the path or the locale');
    // The path is still the last resort, for two entries of the SAME checkout.
    const first = { name: 'x', checkout: 'main', path: '/p/a/x.md', mtimeMs: 7 };
    const second = { name: 'x', checkout: 'main', path: '/p/b/x.md', mtimeMs: 7 };
    assert.deepEqual([second, first].sort(compareEntries), [first, second]);
  });

  test('the menu is main’s group first, then each group in the order given', () => {
    const wtA = rootOf('checkout-worktrees', 'wt-a');
    const wtB = rootOf('checkout-worktrees', 'wt-b');
    const result = buildListing({
      groups: [
        checkoutGroup('wt-a', wtA, [doc(wtA, 'a-old', 10), doc(wtA, 'a-new', 30)]),
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'root', 20)], true),
        checkoutGroup('wt-b', wtB, [doc(wtB, 'b-only', 99)]),
      ],
    });
    assert.deepEqual(result.groups.map((group) => group.checkoutName), ['main', 'wt-a', 'wt-b']);
    assert.deepEqual(result.menu.map((row) => row.name), ['root', 'a-new', 'a-old', 'b-only'],
      'each group’s entries in comparator order; the groups keep the panel’s order');
    assert.deepEqual(result.menu.map((row) => row.name), result.groups.flatMap((group) => group.entries.map((entry) => entry.name)),
      'the menu is exactly the panel list flattened — one order, never two');
  });

  // L11/T16: the order a caller HANDS OVER is preserved. Main's documents are
  // ranked by lib/odd-docs.js (commit recency, then display name) and the caller
  // passes that rank as each entry's `order`; the listing must not re-rank them by
  // mtime, or the menu's first entry opens a different file than the rank named.
  test('a caller’s per-entry order is the PRIMARY key, and compareEntries only breaks ties', () => {
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        { ...doc(MAIN_ROOT, 'main-two', 2000), order: 1 },
        { ...doc(MAIN_ROOT, 'main-one', 1000), order: 0 },
        { ...doc(MAIN_ROOT, 'main-three', 3000), order: 2 },
      ], true)],
    });
    assert.deepEqual(result.menu.map((row) => row.name), ['main-one', 'main-two', 'main-three'],
      'mtime alone would read main-three, main-two, main-one');
    assert.deepEqual(result.groups[0].entries.map((entry) => entry.name), ['main-one', 'main-two', 'main-three'],
      'the panel list and the menu draw the one preserved order');
    assert.deepEqual(Object.keys(result.groups[0].entries[0]).sort(), ['checkout', 'label', 'mtimeMs', 'name', 'path'],
      'the order signal stays out of the entry value');
  });

  test('a tied order falls back to compareEntries, and an unordered entry comes last', () => {
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        doc(MAIN_ROOT, 'unranked-old', 9000),
        { ...doc(MAIN_ROOT, 'tied-b', 500), order: 0 },
        { ...doc(MAIN_ROOT, 'tied-a', 700), order: 0 },
      ], true)],
    });
    assert.deepEqual(result.menu.map((row) => row.name), ['tied-a', 'tied-b', 'unranked-old'],
      'a tie is compareEntries’ answer, and a caller that ordered nothing stays behind what was ordered');
  });

  // The fallback half of the same rule: a caller that gives NO order signal gets
  // exactly the comparator order this module answered before the signal existed.
  test('a caller who gives NO order gets compareEntries’ order', () => {
    const docs = [
      doc(MAIN_ROOT, 'main-two', 2000),
      doc(MAIN_ROOT, 'main-one', 1000),
      doc(MAIN_ROOT, 'main-three', 3000),
    ];
    const result = buildListing({ groups: [checkoutGroup('main', MAIN_ROOT, docs, true)] });
    assert.deepEqual(result.menu.map((row) => row.name), ['main-three', 'main-two', 'main-one']);
    assert.deepEqual(result.menu.map((row) => row.name), docs.slice().sort(compareEntries).map((entry) => entry.name));
  });

  test('compareEntries is the ONE comparator and it sorts a copy without mutating it', () => {
    const entries = [
      { name: 'b', path: '/p/b', mtimeMs: 5 },
      { name: 'a', path: '/p/a', mtimeMs: 5 },
      { name: 'z', path: '/p/z', mtimeMs: 9 },
      { name: 'a', path: '/p/a', mtimeMs: 5 },
    ];
    const before = JSON.stringify(entries);
    const sorted = entries.slice().sort(compareEntries);
    assert.deepEqual(sorted.map((entry) => `${entry.name}:${entry.mtimeMs}`), ['z:9', 'a:5', 'a:5', 'b:5']);
    assert.equal(JSON.stringify(entries), before, 'the comparator is pure');
    assert.equal(compareEntries(entries[1], { ...entries[1] }), 0, 'equal keys answer 0');
    assert.equal(compareEntries(entries[2], entries[1]) < 0, true, 'a newer document sorts first');
    assert.equal(compareEntries(entries[1], entries[2]) > 0, true, 'and the reverse is the mirror');
    // A new entry with an unreadable time is the oldest, exactly as the listing stores it.
    assert.equal(compareEntries({ name: 'a', path: '/p/a', mtimeMs: 0 }, entries[1]) > 0, true,
      'a name tie at mtime 0 loses to a real time');
    // The menu of a one-group listing IS this sort applied to its entries.
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        doc(MAIN_ROOT, 'b', 5),
        doc(MAIN_ROOT, 'z', 9),
        doc(MAIN_ROOT, 'a', 5),
      ], true)],
    });
    assert.deepEqual(
      result.menu.map((row) => row.path),
      result.groups[0].entries.slice().sort(compareEntries).map((entry) => entry.path),
    );
  });
});

describe('fail closed on junk', () => {
  test('malformed input answers an empty listing, never a throw', () => {
    for (const input of [undefined, null, {}, { groups: 'nope' }, { groups: null }, { groups: [] }]) {
      assert.deepEqual(buildListing(input), { groups: [], menu: [] });
    }
    assert.deepEqual(buildListing({ groups: [null, 7, 'group', { docs: 'nope' }, { entries: 5 }] }), { groups: [], menu: [] });
  });

  test('a malformed group or entry is skipped and the rest still lists', () => {
    const result = buildListing({
      groups: [
        null,
        checkoutGroup('main', MAIN_ROOT, [
          doc(MAIN_ROOT, 'alpha', 10),
          null,
          42,
          { name: 7, docPath: path.join(TASKS, 'numeric.md'), mtimeMs: 5 },
          { name: 'no-path' },
          { docPath: path.join(TASKS, 'anonymous.md'), mtimeMs: 5 },
          { name: '', docPath: path.join(TASKS, 'blank.md'), mtimeMs: 5 },
        ], true),
        { checkoutName: 'junk', checkoutRoot: MAIN_ROOT, docs: [undefined] },
      ],
    });
    assert.deepEqual(result.menu.map((row) => row.name), ['alpha']);
    assert.deepEqual(result.groups.map((group) => group.checkoutName), ['main'], 'a group with no usable entry vanishes');
  });

  test('a document with no readable mtime is the oldest and still appears', () => {
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [
        { name: 'dated', docPath: path.join(TASKS, 'dated.md'), mtimeMs: 4000 },
        { name: 'no-time', docPath: path.join(TASKS, 'no-time.md') },
        { name: 'nonsense', docPath: path.join(TASKS, 'nonsense.md'), mtimeMs: 'nonsense' },
        { name: 'infinite', docPath: path.join(TASKS, 'infinite.md'), mtimeMs: Number.POSITIVE_INFINITY },
      ], true)],
    });
    assert.deepEqual(result.menu.map((row) => [row.name, row.label]), [
      ['dated', 'dated'],
      ['infinite', 'infinite'],
      ['no-time', 'no-time'],
      ['nonsense', 'nonsense'],
    ], 'the three untimed documents tie at 0 and order by name in code units (`-` is 45, `n` is 110)');
    assert.deepEqual(result.groups[0].entries.map((entry) => entry.mtimeMs), [4000, 0, 0, 0],
      'no time is reported as 0, never as a time the document never had');
  });

  test('empty groups vanish and an all-empty model answers no group and no menu', () => {
    assert.deepEqual(buildListing({ groups: [checkoutGroup('main', MAIN_ROOT, [], true)] }), { groups: [], menu: [] });
    const result = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10)], true),
        checkoutGroup('wt-a', rootOf('checkout-worktrees', 'wt-a'), []),
        checkoutGroup('wt-b', rootOf('checkout-worktrees', 'wt-b'), []),
      ],
    });
    assert.deepEqual(result.groups.map((group) => group.checkoutName), ['main']);
  });
});

describe('the value shape, and purity', () => {
  test('the listing carries exactly the documented fields', () => {
    const result = buildListing({
      groups: [checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10)], true)],
    });
    assert.deepEqual(Object.keys(result).sort(), ['groups', 'menu']);
    assert.deepEqual(Object.keys(result.groups[0]).sort(), ['checkoutName', 'checkoutRoot', 'entries', 'isMain']);
    assert.deepEqual(Object.keys(result.groups[0].entries[0]).sort(), ['checkout', 'label', 'mtimeMs', 'name', 'path']);
    assert.deepEqual(Object.keys(result.menu[0]).sort(), ['label', 'name', 'path']);
    assert.equal(result.groups[0].isMain, true);
    assert.equal(result.groups[0].checkoutRoot, MAIN_ROOT);
  });

  test('a group without a checkoutName names itself after its root', () => {
    const wt = rootOf('checkout-worktrees', 'wt-a');
    const result = buildListing({ groups: [{ checkoutRoot: wt, docs: [doc(wt, 'alpha', 10)] }] });
    assert.equal(result.groups[0].checkoutName, 'wt-a');
    assert.equal(result.groups[0].isMain, false);
  });

  test('a listing handed back in is the same listing (round trip is idempotent)', () => {
    const wt = rootOf('checkout-worktrees', 'wt-a');
    const first = buildListing({
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10), doc(MAIN_ROOT, 'beta', 30)], true),
        checkoutGroup('wt-a', wt, [doc(wt, 'alpha', 20)]),
      ],
    });
    assert.deepEqual(buildListing({ groups: first.groups }), first);
  });

  test('the inputs are never mutated', () => {
    const wt = rootOf('checkout-worktrees', 'wt-a');
    const input = {
      groups: [
        checkoutGroup('main', MAIN_ROOT, [doc(MAIN_ROOT, 'alpha', 10), doc(MAIN_ROOT, 'beta', 30)], true),
        checkoutGroup('proj-x', rootOf('a', 'proj-x'), [doc(rootOf('a', 'proj-x'), 'alpha', 20)]),
        checkoutGroup('proj-x', rootOf('b', 'proj-x'), [doc(rootOf('b', 'proj-x'), 'alpha', 25)]),
        checkoutGroup('wt-a', wt, []),
      ],
    };
    const before = JSON.stringify(input);
    buildListing(input);
    assert.equal(JSON.stringify(input), before);
  });

  test('it is pure: no fs, no git, no clock, and only the two documented exports', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    for (const forbidden of ['node:fs', 'node:child_process', 'node:os', 'Date.now', 'new Date', 'localeCompare(']) {
      assert.equal(source.includes(forbidden), false, `lib/odd-listing.js must not use ${forbidden}`);
    }
    assert.deepEqual(Object.keys(listing).sort(), ['buildListing', 'compareEntries']);
  });
});

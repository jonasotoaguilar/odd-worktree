'use strict';
// T4 (S10, S23): the listing orders. These tests pin the pure row builder the
// panel composes: `files` is one flat list, `tree` a folder tree and `ext` one
// level of extension groups, each foldable through the view's per-order fold set
// and forced open by a query. Everything is asserted through the public surface
// (`ORDERS`, `nextOrder`, `buildRows`, `groupKey`, `holderGroup`, `toggleFold`,
// `holderKeys`, `foldsFor`, `everyGroupFolded`, `toggleEveryFold`): no painting, no
// filesystem, no module-internal state.
//
// S23 renamed the folder order from `path` to `tree` — the id, the cycle and the
// row builder — so every assertion here names `tree`; what it paints did not
// change. S33 renamed the flat order from `modified` to `files`, and S29/S30 added
// the fold rules: every group folded by default, and only the focused file's groups
// open when an order is chosen. S39 replaced S34's "every other group" toggle with
// ONE toggle over every group, which `everyGroupFolded` states the direction of.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  ORDERS,
  nextOrder,
  buildRows,
  groupKey,
  holderGroup,
  toggleFold,
  holderKeys,
  foldsFor,
  everyGroupFolded,
  toggleEveryFold,
} = require('../lib/files-orders.js');

function entry(path, state, mtimeMs) {
  const value = { path, state };
  if (mtimeMs !== undefined) value.mtimeMs = mtimeMs;
  return value;
}

// Deliberately NOT in the listing's own order: the builder owns the `files`
// order, so it is asserted against an unsorted input.
const ENTRIES = [
  entry('lib/view-layout.js', 'updated', 3000),
  entry('README.md', 'clean', 1500),
  entry('lib/files-orders.js', 'new', 5000),
  entry('AGENTS.md', 'clean', 1000),
  entry('lib/odd-prompt/odd-worktrees.md', 'clean', 2000),
  entry('docs/reference.md', 'updated', 4000),
  entry('tools/files-orders.test.js', 'new', 3500),
  entry('LICENSE', 'clean', 800),
];

// One observable line per row: its indentation, its label or path, whether a
// group paints folded and whether a file carries its directory.
function shape(rows) {
  return rows.map((row) => {
    const indent = '  '.repeat(row.depth);
    if (row.kind === 'group') return `${indent}[${row.label}]${row.folded ? ' folded' : ''}`;
    return `${indent}${row.entry.path}${row.showDirectory ? ' (dir)' : ''}`;
  });
}

function paths(rows) {
  return rows.filter((row) => row.kind === 'file').map((row) => row.entry.path);
}

describe('the order cycle (S10, S33)', () => {
  test('cycles files -> tree -> ext and back', () => {
    assert.deepEqual(ORDERS, ['files', 'tree', 'ext']);
    assert.equal(nextOrder('files'), 'tree');
    assert.equal(nextOrder('tree'), 'ext');
    assert.equal(nextOrder('ext'), 'files');
  });

  test('an order it does not know starts the cycle at files', () => {
    assert.equal(nextOrder('bogus'), 'files');
    assert.equal(nextOrder(''), 'files');
    assert.equal(nextOrder(undefined), 'files');
  });

  test('S33: the flat order is named files, and the old name is not an order', () => {
    assert.equal(ORDERS.includes('modified'), false, 'the order is not called modified anywhere');
    assert.equal(nextOrder('modified'), 'files', 'the old id starts the cycle at the default');
    assert.deepEqual(
      buildRows(ENTRIES, { order: 'modified' }),
      buildRows(ENTRIES, { order: 'files' }),
      'the old id falls back to the flat listing it always painted',
    );
  });
});

describe('files: one flat file list (S10, S33)', () => {
  test('changed files come first by recency, then clean files, ties by path', () => {
    const rows = buildRows(ENTRIES, { order: 'files' });
    assert.deepEqual(paths(rows), [
      'lib/files-orders.js',
      'docs/reference.md',
      'tools/files-orders.test.js',
      'lib/view-layout.js',
      'AGENTS.md',
      'LICENSE',
      'README.md',
      'lib/odd-prompt/odd-worktrees.md',
    ]);
  });

  test('a file row is flat, at the root depth and shows its parent directory', () => {
    const rows = buildRows(ENTRIES, { order: 'files' });
    assert.deepEqual(shape(rows), [
      'lib/files-orders.js (dir)',
      'docs/reference.md (dir)',
      'tools/files-orders.test.js (dir)',
      'lib/view-layout.js (dir)',
      'AGENTS.md (dir)',
      'LICENSE (dir)',
      'README.md (dir)',
      'lib/odd-prompt/odd-worktrees.md (dir)',
    ]);
    for (const row of rows) {
      assert.equal(row.kind, 'file');
      assert.equal(row.depth, 0);
    }
  });

  test('a changed file without an mtime sorts after the timed changes and before clean files', () => {
    const rows = buildRows([
      entry('b.md', 'clean'),
      entry('x.js', 'updated'),
      entry('a.js', 'new', 100),
      entry('y.js', 'updated', 200),
    ], { order: 'files' });
    assert.deepEqual(paths(rows), ['y.js', 'a.js', 'x.js', 'b.md']);
  });

  test('no group is ever painted, and fold keys are inert', () => {
    const unfolded = buildRows(ENTRIES, { order: 'files' });
    const folded = buildRows(ENTRIES, { order: 'files', folded: new Set(['lib', 'docs', 'AGENTS.md']) });
    assert.deepEqual(folded, unfolded);
    assert.equal(unfolded.some((row) => row.kind === 'group'), false);
  });
});

describe('tree: the folder tree (S10, S23)', () => {
  test('subfolders come first and then the folder own files, root folders before root files', () => {
    const rows = buildRows(ENTRIES, { order: 'tree' });
    assert.deepEqual(shape(rows), [
      '[docs]',
      '  docs/reference.md',
      '[lib]',
      '  [odd-prompt]',
      '    lib/odd-prompt/odd-worktrees.md',
      '  lib/files-orders.js',
      '  lib/view-layout.js',
      '[tools]',
      '  tools/files-orders.test.js',
      'AGENTS.md',
      'LICENSE',
      'README.md',
    ]);
  });

  test('a file row does not repeat the directory the tree already shows', () => {
    for (const row of buildRows(ENTRIES, { order: 'tree' })) {
      if (row.kind === 'file') assert.equal(row.showDirectory, false);
    }
  });

  test('a root file paints at depth 0 and one inside a folder one level deeper', () => {
    const rows = buildRows(ENTRIES, { order: 'tree' });
    const byPath = new Map(rows.filter((row) => row.kind === 'file').map((row) => [row.entry.path, row.depth]));
    assert.equal(byPath.get('AGENTS.md'), 0);
    assert.equal(byPath.get('docs/reference.md'), 1);
    assert.equal(byPath.get('lib/files-orders.js'), 1);
    assert.equal(byPath.get('lib/odd-prompt/odd-worktrees.md'), 2);
  });

  test('folding a folder keeps its group row, marks it folded and hides its descendants', () => {
    const rows = buildRows(ENTRIES, { order: 'tree', folded: new Set(['lib']) });
    assert.deepEqual(shape(rows), [
      '[docs]',
      '  docs/reference.md',
      '[lib] folded',
      '[tools]',
      '  tools/files-orders.test.js',
      'AGENTS.md',
      'LICENSE',
      'README.md',
    ]);
  });

  test('a nested folder folds on its own full path key', () => {
    const rows = buildRows(ENTRIES, { order: 'tree', folded: new Set(['lib/odd-prompt']) });
    assert.deepEqual(shape(rows), [
      '[docs]',
      '  docs/reference.md',
      '[lib]',
      '  [odd-prompt] folded',
      '  lib/files-orders.js',
      '  lib/view-layout.js',
      '[tools]',
      '  tools/files-orders.test.js',
      'AGENTS.md',
      'LICENSE',
      'README.md',
    ]);
  });

  test('every group paints expanded until its key is folded', () => {
    const rows = buildRows(ENTRIES, { order: 'tree' });
    for (const row of rows) {
      if (row.kind === 'group') assert.equal(row.folded, false);
    }
  });
});

describe('ext: one level of extension groups (S10)', () => {
  test('one group per extension, named with its dot, and the extensionless group last', () => {
    const rows = buildRows(ENTRIES, { order: 'ext' });
    assert.deepEqual(shape(rows), [
      '[.js]',
      '  lib/files-orders.js (dir)',
      '  lib/view-layout.js (dir)',
      '  tools/files-orders.test.js (dir)',
      '[.md]',
      '  AGENTS.md (dir)',
      '  README.md (dir)',
      '  docs/reference.md (dir)',
      '  lib/odd-prompt/odd-worktrees.md (dir)',
      '[(none)]',
      '  LICENSE (dir)',
    ]);
  });

  test('files inside a group are alphabetical by path and paint their directory', () => {
    const rows = buildRows(ENTRIES, { order: 'ext' });
    assert.deepEqual(paths(rows).slice(0, 3), [
      'lib/files-orders.js',
      'lib/view-layout.js',
      'tools/files-orders.test.js',
    ]);
    for (const row of rows.filter((value) => value.kind === 'file')) {
      assert.equal(row.showDirectory, true);
      assert.equal(row.depth, 1);
    }
  });

  test('a folded extension keeps its group row and hides its files', () => {
    const rows = buildRows(ENTRIES, { order: 'ext', folded: new Set(['md']) });
    assert.deepEqual(shape(rows), [
      '[.js]',
      '  lib/files-orders.js (dir)',
      '  lib/view-layout.js (dir)',
      '  tools/files-orders.test.js (dir)',
      '[.md] folded',
      '[(none)]',
      '  LICENSE (dir)',
    ]);
  });

  test('the extensionless group folds on its own empty key', () => {
    const rows = buildRows(ENTRIES, { order: 'ext', folded: new Set(['']) });
    assert.deepEqual(shape(rows).slice(-1), ['[(none)] folded']);
    assert.equal(paths(rows).includes('LICENSE'), false);
  });

  test('a dotfile is extensionless and a compound name groups under its last suffix', () => {
    const rows = buildRows([
      entry('.gitignore', 'clean'),
      entry('archive.tar.gz', 'clean'),
      entry('a.js', 'clean'),
    ], { order: 'ext' });
    assert.deepEqual(shape(rows), [
      '[.gz]',
      '  archive.tar.gz (dir)',
      '[.js]',
      '  a.js (dir)',
      '[(none)]',
      '  .gitignore (dir)',
    ]);
  });
});

describe('fold state is per order (S10)', () => {
  test('a tree key does not fold an extension group', () => {
    const unfolded = buildRows(ENTRIES, { order: 'ext' });
    assert.deepEqual(buildRows(ENTRIES, { order: 'ext', folded: new Set(['lib', 'docs']) }), unfolded);
  });

  test('a fold key from one order does not touch the tree either', () => {
    const unfolded = buildRows(ENTRIES, { order: 'tree' });
    assert.deepEqual(buildRows(ENTRIES, { order: 'tree', folded: new Set(['md']) }), unfolded);
  });

  test('toggleFold adds and removes the focused group key in that order set', () => {
    const group = { kind: 'group', key: 'lib', label: 'lib', depth: 0, folded: false };
    const folded = new Set();
    assert.equal(toggleFold(group, folded), true);
    assert.deepEqual([...folded], ['lib']);
    assert.equal(toggleFold(group, folded), true);
    assert.equal(folded.has('lib'), false);
  });

  test('toggleFold does nothing for a file row or no set', () => {
    const file = { kind: 'file', entry: ENTRIES[0], depth: 0, showDirectory: true };
    const folded = new Set();
    assert.equal(toggleFold(file, folded), false);
    assert.equal(folded.size, 0);
    assert.equal(toggleFold({ kind: 'group', key: 'lib' }, undefined), false);
  });

  test('holderGroup names the group row that holds a file row (S24)', () => {
    for (const order of ['tree', 'ext']) {
      const rows = buildRows(ENTRIES, { order });
      const byPath = new Map(rows.map((row, index) => [row, index]));
      for (const [row, index] of byPath) {
        if (row.kind !== 'file' || row.depth === 0) continue;
        const holder = holderGroup(rows, index);
        // The file's parent folder (tree) or its extension group (ext) is the
        // nearest group row above it, one depth shallower.
        assert.equal(holder.kind, 'group', `${order}: ${row.entry.path} has a holder`);
        assert.equal(holder.depth, row.depth - 1, `${order}: ${row.entry.path} holder depth`);
        const above = rows.slice(0, index).filter((value) => value.kind === 'group' && value.depth === row.depth - 1);
        assert.equal(holder, above[above.length - 1], `${order}: ${row.entry.path} holder is the nearest one above`);
      }
    }
  });

  test('holderGroup answers the extension group in ext and the folder in tree', () => {
    const tree = buildRows(ENTRIES, { order: 'tree' });
    const nested = tree.findIndex((row) => row.kind === 'file' && row.entry.path === 'lib/odd-prompt/odd-worktrees.md');
    assert.equal(holderGroup(tree, nested).key, 'lib/odd-prompt');
    const root = tree.findIndex((row) => row.kind === 'file' && row.entry.path === 'README.md');
    assert.equal(holderGroup(tree, root), null, 'a root file has no folder to fold');

    const ext = buildRows(ENTRIES, { order: 'ext' });
    const markdown = ext.findIndex((row) => row.kind === 'file' && row.entry.path === 'README.md');
    assert.equal(holderGroup(ext, markdown).key, 'md');
    const license = ext.findIndex((row) => row.kind === 'file' && row.entry.path === 'LICENSE');
    assert.equal(holderGroup(ext, license).key, '', 'the extensionless group is a holder too');
  });

  test('holderGroup has no holder for a group row, no rows or no index', () => {
    const rows = buildRows(ENTRIES, { order: 'tree' });
    assert.equal(holderGroup(rows, 0), null, 'a group row holds no group');
    assert.equal(holderGroup(rows, 99), null);
    assert.equal(holderGroup([], 0), null);
    assert.equal(holderGroup(undefined, 0), null);
    const flat = buildRows(ENTRIES, { order: 'files' });
    assert.equal(holderGroup(flat, 0), null, 'the flat list has no groups at all');
  });

  test('groupKey names a group row and nothing else', () => {
    assert.equal(groupKey({ kind: 'group', key: 'lib/odd-prompt', label: 'odd-prompt', depth: 1, folded: false }), 'lib/odd-prompt');
    assert.equal(groupKey({ kind: 'file', entry: ENTRIES[0], depth: 0, showDirectory: true }), null);
    assert.equal(groupKey(undefined), null);
  });
});

describe('the query filters files and forces groups open (S10)', () => {
  test('the query matches the path case-insensitively', () => {
    assert.deepEqual(paths(buildRows(ENTRIES, { order: 'files', query: 'ReAdMe' })), ['README.md']);
    assert.deepEqual(paths(buildRows(ENTRIES, { order: 'files', query: 'REFERENCE' })), ['docs/reference.md']);
  });

  test('it filters on the whole path, not the file name', () => {
    const rows = buildRows(ENTRIES, { order: 'tree', query: 'odd-prompt/' });
    assert.deepEqual(shape(rows), [
      '[lib]',
      '  [odd-prompt]',
      '    lib/odd-prompt/odd-worktrees.md',
    ]);
  });

  test('a non-empty query reopens a folded tree group', () => {
    const rows = buildRows(ENTRIES, {
      order: 'tree',
      folded: new Set(['lib', 'tools']),
      query: 'orders',
    });
    assert.deepEqual(shape(rows), [
      '[lib]',
      '  lib/files-orders.js',
      '[tools]',
      '  tools/files-orders.test.js',
    ]);
    assert.equal(rows.every((row) => row.kind !== 'group' || row.folded === false), true);
  });

  test('a non-empty query reopens a folded extension group', () => {
    const rows = buildRows(ENTRIES, { order: 'ext', folded: new Set(['md', '']), query: 'license' });
    assert.deepEqual(shape(rows), [
      '[(none)]',
      '  LICENSE (dir)',
    ]);
  });

  test('an empty query is the unfolded listing, and clears the filter', () => {
    const unfolded = buildRows(ENTRIES, { order: 'tree', folded: new Set(['lib']) });
    assert.deepEqual(buildRows(ENTRIES, { order: 'tree', folded: new Set(['lib']), query: '' }), unfolded);
    assert.deepEqual(buildRows(ENTRIES, { order: 'tree', folded: new Set(['lib']), query: undefined }), unfolded);
    assert.equal(paths(buildRows(ENTRIES, { order: 'files', query: '' })).length, ENTRIES.length);
  });
});

describe('the row builder is pure (S10)', () => {
  test('it never mutates the entries, the options or the fold set', () => {
    const frozenEntries = Object.freeze(ENTRIES.map((value) => Object.freeze({ ...value })));
    const folded = new Set(['lib']);
    const options = { order: 'tree', folded, query: '' };
    const before = JSON.stringify({ entries: frozenEntries, order: options.order, query: options.query, folded: [...folded] });
    buildRows(frozenEntries, options);
    buildRows(frozenEntries, { order: 'ext', folded, query: 'md' });
    buildRows(frozenEntries, { order: 'files' });
    const after = JSON.stringify({ entries: frozenEntries, order: options.order, query: options.query, folded: [...folded] });
    assert.equal(after, before);
    assert.deepEqual([...folded], ['lib']);
  });

  test('it reuses the entries by reference and returns a fresh row list per call', () => {
    const rows = buildRows(ENTRIES, { order: 'files' });
    assert.equal(rows[0].entry, ENTRIES.find((value) => value.path === 'lib/files-orders.js'));
    assert.notEqual(buildRows(ENTRIES, { order: 'tree' }), buildRows(ENTRIES, { order: 'tree' }));
  });

  test('a row carries exactly the documented fields and no painted text', () => {
    for (const order of ORDERS) {
      for (const row of buildRows(ENTRIES, { order })) {
        const keys = Object.keys(row).sort();
        if (row.kind === 'group') assert.deepEqual(keys, ['depth', 'folded', 'key', 'kind', 'label']);
        else assert.deepEqual(keys, ['depth', 'entry', 'kind', 'showDirectory']);
      }
      assert.equal(JSON.stringify(buildRows(ENTRIES, { order })).includes('\u001b'), false);
    }
  });

  test('an empty listing paints no rows in every order', () => {
    for (const order of ORDERS) assert.deepEqual(buildRows([], { order }), []);
    assert.deepEqual(buildRows(undefined, { order: 'tree' }), []);
  });

  test('an unknown order falls back to the default files list', () => {
    assert.deepEqual(buildRows(ENTRIES, { order: 'bogus' }), buildRows(ENTRIES, { order: 'files' }));
  });
});

describe('the group keys that hold a file (S30)', () => {
  test('tree: every folder on the way down, the top one first', () => {
    assert.deepEqual(holderKeys('src/web/test.ts', 'tree'), ['src', 'src/web']);
    assert.deepEqual(holderKeys('lib/view-layout.js', 'tree'), ['lib']);
    assert.deepEqual(holderKeys('AGENTS.md', 'tree'), [], 'a repository-root file expands no group');
  });

  test('ext: only the extension group, the empty key for an extensionless file', () => {
    assert.deepEqual(holderKeys('src/web/test.ts', 'ext'), ['ts']);
    assert.deepEqual(holderKeys('LICENSE', 'ext'), ['']);
  });

  test('the flat files order holds no group, and neither does a missing path', () => {
    assert.deepEqual(holderKeys('src/web/test.ts', 'files'), []);
    assert.deepEqual(holderKeys('src/web/test.ts', undefined), []);
    assert.deepEqual(holderKeys(undefined, 'tree'), []);
    assert.deepEqual(holderKeys('', 'ext'), []);
  });
});

describe('the fold set an order opens with (S29, S30)', () => {
  const keysOf = (order) => buildRows(ENTRIES, { order }).filter((row) => row.kind === 'group').map((row) => row.key);

  test('every group is folded when no file is focused', () => {
    for (const order of ['tree', 'ext']) {
      const folded = foldsFor(ENTRIES, order, undefined);
      assert.deepEqual([...folded].sort(), keysOf(order).sort(), `${order}: every group key is folded`);
      const groups = buildRows(ENTRIES, { order, folded }).filter((row) => row.kind === 'group');
      assert.equal(groups.every((row) => row.folded === true), true, `${order}: every group row paints folded`);
    }
  });

  test('tree: only the folders holding the focused file stay open', () => {
    const rows = buildRows(ENTRIES, {
      order: 'tree',
      folded: foldsFor(ENTRIES, 'tree', 'lib/odd-prompt/odd-worktrees.md'),
    });
    assert.deepEqual(shape(rows), [
      '[docs] folded',
      '[lib]',
      '  [odd-prompt]',
      '    lib/odd-prompt/odd-worktrees.md',
      '  lib/files-orders.js',
      '  lib/view-layout.js',
      '[tools] folded',
      'AGENTS.md',
      'LICENSE',
      'README.md',
    ]);
  });

  test('ext: only the extension group holding the focused file stays open', () => {
    const rows = buildRows(ENTRIES, {
      order: 'ext',
      folded: foldsFor(ENTRIES, 'ext', 'lib/files-orders.js'),
    });
    assert.deepEqual(shape(rows), [
      '[.js]',
      '  lib/files-orders.js (dir)',
      '  lib/view-layout.js (dir)',
      '  tools/files-orders.test.js (dir)',
      '[.md] folded',
      '[(none)] folded',
    ]);
  });

  test('a repository-root file opens no group in tree, and only its extension in ext', () => {
    const tree = buildRows(ENTRIES, { order: 'tree', folded: foldsFor(ENTRIES, 'tree', 'README.md') });
    const treeGroups = tree.filter((row) => row.kind === 'group');
    assert.ok(treeGroups.length > 0, 'the tree listing has groups');
    assert.equal(treeGroups.every((row) => row.folded === true), true, 'tree: every group stays folded');
    assert.equal(paths(tree).includes('README.md'), true, 'the root file still paints at the top level');

    // `ext` groups by extension, not by folder, so a root file still has a group.
    const ext = buildRows(ENTRIES, { order: 'ext', folded: foldsFor(ENTRIES, 'ext', 'README.md') });
    assert.deepEqual(shape(ext), [
      '[.js] folded',
      '[.md]',
      '  AGENTS.md (dir)',
      '  README.md (dir)',
      '  docs/reference.md (dir)',
      '  lib/odd-prompt/odd-worktrees.md (dir)',
      '[(none)] folded',
    ]);
  });

  test('the flat files order has no group to fold, and an empty listing either', () => {
    assert.equal(foldsFor(ENTRIES, 'files', 'README.md').size, 0);
    assert.equal(foldsFor(ENTRIES, 'files', undefined).size, 0);
    assert.equal(foldsFor([], 'tree', 'README.md').size, 0);
    assert.equal(foldsFor(undefined, 'ext', undefined).size, 0);
  });
});

describe('shift+space toggles every group at once (S39, S40)', () => {
  const treeKeys = () => buildRows(ENTRIES, { order: 'tree' })
    .filter((row) => row.kind === 'group')
    .map((row) => row.key)
    .sort();
  const extKeys = () => buildRows(ENTRIES, { order: 'ext' })
    .filter((row) => row.kind === 'group')
    .map((row) => row.key)
    .sort();

  test('a tree with any group still expanded collapses EVERY group, the focused file folders included', () => {
    const folded = foldsFor(ENTRIES, 'tree', 'lib/odd-prompt/odd-worktrees.md');
    assert.equal(folded.has('lib'), false, 'the focused file folders start open');
    assert.equal(toggleEveryFold(ENTRIES, 'tree', folded), true);
    assert.deepEqual([...folded].sort(), treeKeys(), 'every group is folded, holders included');
  });

  test('a tree whose every group is collapsed expands every group instead', () => {
    const folded = new Set(treeKeys());
    assert.equal(toggleEveryFold(ENTRIES, 'tree', folded), true);
    assert.equal(folded.size, 0, 'no group is left folded');
  });

  test('a mixed tree collapses on the first press and expands on the second', () => {
    const folded = new Set(['docs']);
    assert.equal(toggleEveryFold(ENTRIES, 'tree', folded), true);
    assert.deepEqual([...folded].sort(), treeKeys(), 'the first press collapses everything');
    assert.equal(toggleEveryFold(ENTRIES, 'tree', folded), true);
    assert.equal(folded.size, 0, 'the second press expands everything');
  });

  test('ext is one level and toggles the same way', () => {
    const folded = foldsFor(ENTRIES, 'ext', 'lib/files-orders.js');
    assert.equal(folded.has('js'), false);
    assert.equal(toggleEveryFold(ENTRIES, 'ext', folded), true);
    assert.deepEqual([...folded].sort(), extKeys(), 'the focused extension group collapses too');
    assert.equal(toggleEveryFold(ENTRIES, 'ext', folded), true);
    assert.equal(folded.size, 0, 'every extension group is open again');
  });

  test('it never touches the flat files order, no set, or a listing with no group', () => {
    const folded = new Set();
    assert.equal(toggleEveryFold(ENTRIES, 'files', folded), false);
    assert.equal(folded.size, 0);
    assert.equal(toggleEveryFold(ENTRIES, 'tree', undefined), false);
    assert.equal(toggleEveryFold([], 'tree', folded), false);
    assert.equal(toggleEveryFold([entry('README.md', 'clean')], 'tree', folded), false, 'a root file is no group');
    assert.equal(folded.size, 0);
  });

  test('everyGroupFolded names the direction the legend paints (S40)', () => {
    assert.equal(everyGroupFolded(ENTRIES, 'tree', new Set(treeKeys())), true, 'every group collapsed');
    assert.equal(everyGroupFolded(ENTRIES, 'tree', foldsFor(ENTRIES, 'tree', 'lib/files-orders.js')), false,
      'the focused file folders open');
    assert.equal(everyGroupFolded(ENTRIES, 'ext', new Set(extKeys())), true);
    assert.equal(everyGroupFolded(ENTRIES, 'ext', new Set(['md'])), false);
    assert.equal(everyGroupFolded(ENTRIES, 'files', new Set()), true, 'the flat order paints no group, so none is open');
  });
});

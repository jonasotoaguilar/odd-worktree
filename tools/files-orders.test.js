'use strict';
// T4 (S10): the listing orders. These tests pin the pure row builder the panel
// composes: `modified` is one flat list, `path` a folder tree and `ext` one
// level of extension groups, each foldable through the view's per-order fold
// set and forced open by a query. Everything is asserted through the public
// surface (`ORDERS`, `nextOrder`, `buildRows`, `groupKey`, `toggleFold`): no
// painting, no filesystem, no module-internal state.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ORDERS, nextOrder, buildRows, groupKey, toggleFold } = require('../lib/files-orders.js');

function entry(path, state, mtimeMs) {
  const value = { path, state };
  if (mtimeMs !== undefined) value.mtimeMs = mtimeMs;
  return value;
}

// Deliberately NOT in the listing's own order: the builder owns the `modified`
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

describe('the order cycle (S10)', () => {
  test('cycles modified -> path -> ext and back', () => {
    assert.deepEqual(ORDERS, ['modified', 'path', 'ext']);
    assert.equal(nextOrder('modified'), 'path');
    assert.equal(nextOrder('path'), 'ext');
    assert.equal(nextOrder('ext'), 'modified');
  });

  test('an order it does not know starts the cycle at modified', () => {
    assert.equal(nextOrder('bogus'), 'modified');
    assert.equal(nextOrder(''), 'modified');
    assert.equal(nextOrder(undefined), 'modified');
  });
});

describe('modified: one flat file list (S10)', () => {
  test('changed files come first by recency, then clean files, ties by path', () => {
    const rows = buildRows(ENTRIES, { order: 'modified' });
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
    const rows = buildRows(ENTRIES, { order: 'modified' });
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
    ], { order: 'modified' });
    assert.deepEqual(paths(rows), ['y.js', 'a.js', 'x.js', 'b.md']);
  });

  test('no group is ever painted, and fold keys are inert', () => {
    const unfolded = buildRows(ENTRIES, { order: 'modified' });
    const folded = buildRows(ENTRIES, { order: 'modified', folded: new Set(['lib', 'docs', 'AGENTS.md']) });
    assert.deepEqual(folded, unfolded);
    assert.equal(unfolded.some((row) => row.kind === 'group'), false);
  });
});

describe('path: the folder tree (S10)', () => {
  test('subfolders come first and then the folder own files, root folders before root files', () => {
    const rows = buildRows(ENTRIES, { order: 'path' });
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
    for (const row of buildRows(ENTRIES, { order: 'path' })) {
      if (row.kind === 'file') assert.equal(row.showDirectory, false);
    }
  });

  test('a root file paints at depth 0 and one inside a folder one level deeper', () => {
    const rows = buildRows(ENTRIES, { order: 'path' });
    const byPath = new Map(rows.filter((row) => row.kind === 'file').map((row) => [row.entry.path, row.depth]));
    assert.equal(byPath.get('AGENTS.md'), 0);
    assert.equal(byPath.get('docs/reference.md'), 1);
    assert.equal(byPath.get('lib/files-orders.js'), 1);
    assert.equal(byPath.get('lib/odd-prompt/odd-worktrees.md'), 2);
  });

  test('folding a folder keeps its group row, marks it folded and hides its descendants', () => {
    const rows = buildRows(ENTRIES, { order: 'path', folded: new Set(['lib']) });
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
    const rows = buildRows(ENTRIES, { order: 'path', folded: new Set(['lib/odd-prompt']) });
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
    const rows = buildRows(ENTRIES, { order: 'path' });
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
  test('a path key does not fold an extension group', () => {
    const unfolded = buildRows(ENTRIES, { order: 'ext' });
    assert.deepEqual(buildRows(ENTRIES, { order: 'ext', folded: new Set(['lib', 'docs']) }), unfolded);
  });

  test('a fold key from one order does not touch the path tree either', () => {
    const unfolded = buildRows(ENTRIES, { order: 'path' });
    assert.deepEqual(buildRows(ENTRIES, { order: 'path', folded: new Set(['md']) }), unfolded);
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

  test('groupKey names a group row and nothing else', () => {
    assert.equal(groupKey({ kind: 'group', key: 'lib/odd-prompt', label: 'odd-prompt', depth: 1, folded: false }), 'lib/odd-prompt');
    assert.equal(groupKey({ kind: 'file', entry: ENTRIES[0], depth: 0, showDirectory: true }), null);
    assert.equal(groupKey(undefined), null);
  });
});

describe('the query filters files and forces groups open (S10)', () => {
  test('the query matches the path case-insensitively', () => {
    assert.deepEqual(paths(buildRows(ENTRIES, { order: 'modified', query: 'ReAdMe' })), ['README.md']);
    assert.deepEqual(paths(buildRows(ENTRIES, { order: 'modified', query: 'REFERENCE' })), ['docs/reference.md']);
  });

  test('it filters on the whole path, not the file name', () => {
    const rows = buildRows(ENTRIES, { order: 'path', query: 'odd-prompt/' });
    assert.deepEqual(shape(rows), [
      '[lib]',
      '  [odd-prompt]',
      '    lib/odd-prompt/odd-worktrees.md',
    ]);
  });

  test('a non-empty query reopens a folded path group', () => {
    const rows = buildRows(ENTRIES, {
      order: 'path',
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
    const unfolded = buildRows(ENTRIES, { order: 'path', folded: new Set(['lib']) });
    assert.deepEqual(buildRows(ENTRIES, { order: 'path', folded: new Set(['lib']), query: '' }), unfolded);
    assert.deepEqual(buildRows(ENTRIES, { order: 'path', folded: new Set(['lib']), query: undefined }), unfolded);
    assert.equal(paths(buildRows(ENTRIES, { order: 'modified', query: '' })).length, ENTRIES.length);
  });
});

describe('the row builder is pure (S10)', () => {
  test('it never mutates the entries, the options or the fold set', () => {
    const frozenEntries = Object.freeze(ENTRIES.map((value) => Object.freeze({ ...value })));
    const folded = new Set(['lib']);
    const options = { order: 'path', folded, query: '' };
    const before = JSON.stringify({ entries: frozenEntries, order: options.order, query: options.query, folded: [...folded] });
    buildRows(frozenEntries, options);
    buildRows(frozenEntries, { order: 'ext', folded, query: 'md' });
    buildRows(frozenEntries, { order: 'modified' });
    const after = JSON.stringify({ entries: frozenEntries, order: options.order, query: options.query, folded: [...folded] });
    assert.equal(after, before);
    assert.deepEqual([...folded], ['lib']);
  });

  test('it reuses the entries by reference and returns a fresh row list per call', () => {
    const rows = buildRows(ENTRIES, { order: 'modified' });
    assert.equal(rows[0].entry, ENTRIES.find((value) => value.path === 'lib/files-orders.js'));
    assert.notEqual(buildRows(ENTRIES, { order: 'path' }), buildRows(ENTRIES, { order: 'path' }));
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
    assert.deepEqual(buildRows(undefined, { order: 'path' }), []);
  });

  test('an unknown order falls back to the default modified list', () => {
    assert.deepEqual(buildRows(ENTRIES, { order: 'bogus' }), buildRows(ENTRIES, { order: 'modified' }));
  });
});

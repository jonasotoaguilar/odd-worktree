'use strict';
// The file picker's listing orders (S10, S23, S33): the pure row builder the panel
// paints. `files` is one flat list, changed first by recency then clean; `tree` is
// an IDE-style folder tree where every folder's subfolders come first and its own
// files after them (so at the top level every folder group paints before the files
// at the repository root); `ext` is one level of extension groups named with their
// dot, alphabetical by path inside and the extensionless group last.
// S23 named the folder order `tree` everywhere — the id, the cycle, this builder
// and the footer — because `path` read as a file path, not as a folder tree. S33
// named the flat order `files` for the same reason: `modified` described a filter
// by modification, while the order is the listing without groups.
//
// The module only decides rows and their fold state: it paints nothing, reads
// no file and mutates neither its entries nor its options. The view holds one
// fold set per order and hands it in, so `toggleFold` / `groupKey` are the only
// single-row mutating surfaces, `toggleEveryFold` is the whole-tree one, and all
// of them touch only the set the caller owns. `holderGroup` answers the one
// structural question the view's `space` needs — which group row holds a file row
// — while `holderKeys` / `foldsFor` answer the ones S29, S30 and S39 need: which
// groups a file lives in, the fold set an order opens with, and the group the
// cursor returns to after the whole tree folds. `everyGroupFolded` states the
// direction S40's legend paints.
//
// Entry shape is the listing seam's (lib/files-index.js): `{ path, state:
// "new" | "updated" | "clean", mtimeMs? }`, already changed-first by recency
// then clean. `files` re-applies that rule here so the order is the module's own,
// not a property of the caller's array.

const { posix } = require('node:path');

const ORDERS = ['files', 'tree', 'ext'];
const DEFAULT_ORDER = 'files';
// The extensionless group's painted name; its key is the empty string.
const EXTENSIONLESS_GROUP = '(none)';

// Byte order, not locale order, so an order is the same on every machine.
function byCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lastSegment(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

// A dotfile such as `.gitignore` has no extension; `a.tar.gz` groups under `gz`.
function extensionOf(path) {
  const extension = posix.extname(posix.basename(path));
  return extension.startsWith('.') ? extension.slice(1) : extension;
}

function isEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.length > 0;
}

function pushTo(map, key, value) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

// A folder is reached once per file below it, but the tree paints it once.
function addSubfolder(map, parent, child) {
  const children = map.get(parent);
  if (children) children.add(child);
  else map.set(parent, new Set([child]));
}

// The listing's own order: changed files first, newest first (an entry without
// an mtime after the timed ones), then clean files, ties by path.
function compareFiles(left, right) {
  const leftChanged = left.state !== 'clean';
  const rightChanged = right.state !== 'clean';
  if (leftChanged !== rightChanged) return leftChanged ? -1 : 1;
  if (leftChanged) {
    const leftTimed = Number.isFinite(left.mtimeMs);
    const rightTimed = Number.isFinite(right.mtimeMs);
    if (leftTimed && rightTimed && left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
    if (leftTimed !== rightTimed) return leftTimed ? -1 : 1;
  }
  return byCodePoint(left.path, right.path);
}

function matchesQuery(entry, query) {
  if (query.length === 0) return true;
  return entry.path.toLowerCase().includes(query.toLowerCase());
}

function foldSetHas(folded, key) {
  if (folded instanceof Set) return folded.has(key);
  if (Array.isArray(folded)) return folded.includes(key);
  return false;
}

function fileRows(entries) {
  return entries
    .slice()
    .sort(compareFiles)
    .map((entry) => ({ kind: 'file', entry, depth: 0, showDirectory: true }));
}

// The `tree` order: every folder on the way down gets a group row (even one
// holding no file of its own), its subfolders paint before its own files, and
// both are alphabetical by name. A folded folder keeps its row and hides
// everything below it.
function treeRows(entries, isFolded) {
  const ownFiles = new Map();
  const subfolders = new Map();
  for (const entry of entries) {
    const directory = posix.dirname(entry.path);
    const folder = directory === '.' ? '' : directory;
    pushTo(ownFiles, folder, entry);
    let current = folder;
    while (current !== '') {
      const slash = current.lastIndexOf('/');
      const parent = slash < 0 ? '' : current.slice(0, slash);
      addSubfolder(subfolders, parent, current);
      current = parent;
    }
  }

  const rows = [];
  const paint = (folder, depth) => {
    const children = [...(subfolders.get(folder) ?? [])].sort(
      (left, right) => byCodePoint(lastSegment(left), lastSegment(right)) || byCodePoint(left, right),
    );
    for (const child of children) {
      const folded = isFolded(child);
      rows.push({ kind: 'group', key: child, label: lastSegment(child), depth, folded });
      if (!folded) paint(child, depth + 1);
    }
    const files = [...(ownFiles.get(folder) ?? [])].sort(
      (left, right) => byCodePoint(posix.basename(left.path), posix.basename(right.path)) || byCodePoint(left.path, right.path),
    );
    for (const entry of files) rows.push({ kind: 'file', entry, depth, showDirectory: false });
  };
  paint('', 0);
  return rows;
}

// The `ext` tree, one level deep: one group per extension named with its dot,
// the files inside alphabetical by path, and the extensionless group last.
function extensionRows(entries, isFolded) {
  const groups = new Map();
  for (const entry of entries) pushTo(groups, extensionOf(entry.path), entry);
  const extensions = [...groups.keys()].sort((left, right) =>
    left === '' ? 1 : right === '' ? -1 : byCodePoint(left, right),
  );
  const rows = [];
  for (const extension of extensions) {
    const folded = isFolded(extension);
    const label = extension === '' ? EXTENSIONLESS_GROUP : `.${extension}`;
    rows.push({ kind: 'group', key: extension, label, depth: 0, folded });
    if (folded) continue;
    const files = [...(groups.get(extension) ?? [])].sort((left, right) => byCodePoint(left.path, right.path));
    for (const entry of files) rows.push({ kind: 'file', entry, depth: 1, showDirectory: true });
  }
  return rows;
}

/**
 * The next order `ctrl+o` selects. An order the module does not know starts the
 * cycle at the default `files` instead of leaving the list unrendered.
 */
function nextOrder(order) {
  const index = ORDERS.indexOf(order);
  return ORDERS[(index + 1) % ORDERS.length];
}

/**
 * The rows the list paints for one order (S10). Pure: the entries, the options
 * and the fold set are only read. `folded` is a group key set (or an array of
 * keys) the view owns per order; a non-empty `query` filters file rows on their
 * whole path, case-insensitively, and forces every group open, so a match is
 * never hidden behind a fold.
 */
function buildRows(entries, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const order = ORDERS.includes(opts.order) ? opts.order : DEFAULT_ORDER;
  const query = typeof opts.query === 'string' ? opts.query : '';
  const folded = opts.folded;
  const matched = (Array.isArray(entries) ? entries : []).filter(
    (entry) => isEntry(entry) && matchesQuery(entry, query),
  );
  if (matched.length === 0) return [];
  if (order === 'files') return fileRows(matched);
  // A non-empty query forces every group open: the fold keys are inert then.
  const forced = query.length > 0;
  const isFolded = (key) => !forced && foldSetHas(folded, key);
  return order === 'tree' ? treeRows(matched, isFolded) : extensionRows(matched, isFolded);
}

/**
 * The key a group row folds on, or null for a file row. `tree` keys are the
 * folder's repository-relative path and `ext` keys are the bare extension (the
 * empty string for the extensionless group), so each order's set is its own.
 */
function groupKey(row) {
  return row && row.kind === 'group' && typeof row.key === 'string' ? row.key : null;
}

/**
 * space / Enter on a group row: toggle its key in the caller's per-order fold
 * set. True when a group was toggled; a file row or no set changes nothing.
 */
function toggleFold(row, foldedSet) {
  const key = groupKey(row);
  if (key === null || !(foldedSet instanceof Set)) return false;
  if (foldedSet.has(key)) foldedSet.delete(key);
  else foldedSet.add(key);
  return true;
}

/**
 * The group row that HOLDS the file row at `index`: the nearest group row above it
 * exactly one depth shallower — the file's folder in `tree`, its extension group in
 * `ext`. `space` folds that group from a file row (S10), so where a file lives is
 * asked here rather than guessed by the view.
 *
 * Null for a group row, a file row at the top level (a repository-root file in
 * `tree` has no folder to fold), the flat `files` list and an out-of-range
 * index.
 */
function holderGroup(rows, index) {
  const list = Array.isArray(rows) ? rows : [];
  const wanted = Number.isInteger(index) ? index : -1;
  const row = wanted >= 0 && wanted < list.length ? list[wanted] : undefined;
  if (!row || row.kind !== 'file') return null;
  for (let at = wanted - 1; at >= 0; at -= 1) {
    const candidate = list[at];
    if (candidate && candidate.kind === 'group' && candidate.depth === row.depth - 1) return candidate;
  }
  return null;
}

/**
 * The group keys that HOLD a file (S29, S30): in `tree` its folders from the top
 * down (`src`, `src/web` for `src/web/test.ts`), in `ext` its extension group (the
 * empty key for a file without an extension), and nothing for the flat `files`
 * order or for a file at the repository root, which has no folder to open.
 */
function holderKeys(path, order) {
  if (typeof path !== 'string' || path.length === 0) return [];
  if (order === 'tree') {
    const directory = posix.dirname(path);
    if (directory === '.' || directory === path) return [];
    const keys = [];
    let current = '';
    for (const part of directory.split('/')) {
      current = current === '' ? part : `${current}/${part}`;
      keys.push(current);
    }
    return keys;
  }
  if (order === 'ext') return [extensionOf(path)];
  return [];
}

/** Every group key one tree order paints for a listing, folded or not (S29, S34). */
function treeGroupKeys(entries, order) {
  if (order !== 'tree' && order !== 'ext') return [];
  const keys = [];
  for (const row of buildRows(entries, { order })) {
    if (row.kind === 'group') keys.push(row.key);
  }
  return keys;
}

/**
 * The fold set an order opens with (S29, S30): every group folded except the ones
 * holding `path`. Without a focused file every group is folded, which is how both
 * trees start; a repository-root file has no folder, so it opens nothing and every
 * group stays collapsed.
 */
function foldsFor(entries, order, path) {
  const open = new Set(holderKeys(path, order));
  const folded = new Set();
  for (const key of treeGroupKeys(entries, order)) {
    if (!open.has(key)) folded.add(key);
  }
  return folded;
}

/**
 * Whether every group of a tree order is collapsed (S40): the footer asks it to
 * name the action `shift+space` would perform. The flat `files` order paints no
 * group, so none of them is open and the answer is true; an empty listing is the
 * same empty truth, and the key itself still does nothing there.
 */
function everyGroupFolded(entries, order, foldedSet) {
  return treeGroupKeys(entries, order).every((key) => foldSetHas(foldedSet, key));
}

/**
 * `shift+space` in a tree order (S39): ONE toggle over every group of the active
 * order. When every group is already collapsed it expands them all, otherwise it
 * collapses them all — the groups holding the highlighted file included, so no
 * group is ever held open across the toggle. The view is what parks the cursor on
 * the group row the file came from. Mutates `foldedSet` the way `toggleFold` does
 * and answers whether it changed anything: false for the flat `files` order, no set
 * at all, or a listing that paints no group.
 */
function toggleEveryFold(entries, order, foldedSet) {
  if (!(foldedSet instanceof Set)) return false;
  const keys = treeGroupKeys(entries, order);
  if (keys.length === 0) return false;
  const expanding = keys.every((key) => foldedSet.has(key));
  for (const key of keys) {
    if (expanding) foldedSet.delete(key);
    else foldedSet.add(key);
  }
  return true;
}

module.exports = {
  ORDERS,
  nextOrder,
  buildRows,
  groupKey,
  holderGroup,
  holderKeys,
  foldsFor,
  everyGroupFolded,
  toggleFold,
  toggleEveryFold,
};

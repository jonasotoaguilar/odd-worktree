'use strict';
// T8 / S8b migration regressions: a registry row written by an older version
// carries `odd[]`. The entity rule keeps ONE document, so every read
// normalizes it deterministically to its FIRST entry, and a write that
// COLLAPSES an addressed row reports the entries left behind once
// (`dropped: [...]`) — a stored association never disappears silently.
//
// S1 narrowed that further: the worktree no longer carries an association at
// all, so the write paths that rewrite the whole file for an UNRELATED row
// must not normalize anything on the way through. Those rows keep their
// stored documents byte for byte, which is why no drop report reaches a
// worktree output any more. This file pins both halves: preservation for the
// rows a write does not address, and the one-document rule plus its report
// for the row it does.
//
// These cases are independent of tools/worktree-registry-odd.test.js: they
// pin the migration behaviour of the WRITE paths that rewrite the whole file
// (unrelated upsert, every removal writer, prune, discovery), of addOddDoc,
// and of the three ways `upsertWorktree` can talk about `odd` (omitted,
// null, empty). They also pin that the non-enumerable migration marker can
// never be serialized into the registry.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// and asserts through the registry's public API plus the bytes on disk.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const registryLib = require('../lib/worktree-registry.js');

const LEGACY = ['odd/tasks/first.md', 'odd/tasks/second.md', 'odd/tasks/third.md'];

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-mig-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function checkoutPath(root, slug) {
  return path.join(path.dirname(root), `${path.basename(root)}-${slug}`);
}

function row(branch, root) {
  return { branch, path: checkoutPath(root, branch.replace(/[^a-z0-9]+/gi, '-')), thread: `thread-${branch}`, issues: [] };
}

function writeRegistryFile(root, rows) {
  const file = registryLib.registryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: registryLib.REGISTRY_VERSION, worktrees: rows }, null, 2)}\n`);
  return file;
}

// A legacy registry: one row carrying the old array, plus one unrelated row
// the write paths can act on without touching the legacy row.
function legacyRepo(tag) {
  const root = makeRepo(tag);
  const legacy = row('feat/legacy', root);
  const other = row('feat/other', root);
  const file = writeRegistryFile(root, [
    { ...legacy, odd: LEGACY.slice() },
    { ...other, odd: 'odd/tasks/other.md' },
  ]);
  return { root, legacy, other, file };
}

function storedRow(root, branch) {
  const raw = fs.readFileSync(registryLib.registryPath(root), 'utf8');
  return JSON.parse(raw).worktrees.find((entry) => entry.branch === branch);
}

function oddOf(root, branch) {
  return registryLib.findByBranch(root, branch).odd;
}

describe('S8b migration: legacy odd[] rows normalize to ONE document', { concurrency: false }, () => {
  test('a READ of a legacy row never rewrites the file and never fails', () => {
    const { root, file } = legacyRepo('read');
    const before = fs.readFileSync(file, 'utf8');

    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, true, `a read never fails on a legacy array: ${read.error}`);
    assert.equal(read.worktrees.find((entry) => entry.branch === 'feat/legacy').odd, LEGACY[0]);
    assert.equal(oddOf(root, 'feat/legacy'), LEGACY[0], 'the lookups inherit the same first entry');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'reading migrated nothing: the bytes are identical');
  });

  test('a write to an UNRELATED row leaves the legacy row byte for byte, with no report', () => {
    const { root, other } = legacyRepo('unrelated');
    // Nothing about the legacy row is supplied: the write still persists the
    // whole file, and it must carry that row through untouched.
    const written = registryLib.upsertWorktree(root, {
      branch: 'feat/other', path: other.path, thread: 'thread-feat/other', issues: [7],
    });
    assert.equal(written.ok, true, `expected the write to succeed: ${JSON.stringify(written)}`);
    assert.equal('dropped' in written, false, 'a row nobody addressed lost nothing, so nothing is reported');
    assert.equal(oddOf(root, 'feat/legacy'), LEGACY[0], 'the in-memory view keeps ONE document');
    assert.deepEqual(storedRow(root, 'feat/legacy').odd, LEGACY, 'the stored list survives verbatim');

    const again = registryLib.updateWorktree(root, 'feat/other', { issues: [7, 8] });
    assert.equal(again.ok, true);
    assert.equal('dropped' in again, false, 'and still nothing to report');
    assert.deepEqual(storedRow(root, 'feat/legacy').odd, LEGACY, 'after every write');
  });

  test('removeWorktree leaves the surviving legacy row byte for byte', () => {
    const { root, other } = legacyRepo('remove');
    const removed = registryLib.removeWorktree(root, 'feat/other');
    assert.equal(removed.ok, true, `expected the removal to succeed: ${JSON.stringify(removed)}`);
    assert.equal('dropped' in removed, false, 'removing one row destroys nothing of another');
    assert.deepEqual(storedRow(root, 'feat/legacy').odd, LEGACY, 'every stored document survives');
    assert.equal(registryLib.findByBranch(root, 'feat/other'), null, 'the removed row is gone');
  });

  test('removeWorktreeByPath leaves the surviving legacy row byte for byte', () => {
    const { root, other } = legacyRepo('remove-path');
    const removed = registryLib.removeWorktreeByPath(root, other.path);
    assert.equal(removed.ok, true, `expected the removal to succeed: ${JSON.stringify(removed)}`);
    assert.equal('dropped' in removed, false);
    assert.deepEqual(storedRow(root, 'feat/legacy').odd, LEGACY);
  });

  test('removeWorktreeExact leaves the surviving legacy row byte for byte', () => {
    const { root, other } = legacyRepo('remove-exact');
    const removed = registryLib.removeWorktreeExact(root, other.branch, other.path);
    assert.equal(removed.ok, true, `expected the removal to succeed: ${JSON.stringify(removed)}`);
    assert.equal('dropped' in removed, false);
    assert.deepEqual(storedRow(root, 'feat/legacy').odd, LEGACY);
  });

  test('pruneWorktrees leaves the surviving legacy row byte for byte', () => {
    const { root, other } = legacyRepo('prune');
    const pruned = registryLib.pruneWorktrees(root, [other.path]);
    assert.equal(pruned.ok, true, `expected the prune to succeed: ${JSON.stringify(pruned)}`);
    assert.deepEqual(pruned.pruned, [other.path], 'the dead row was pruned');
    assert.equal('dropped' in pruned, false, 'the prune write destroys nothing of a row it kept');
    assert.deepEqual(storedRow(root, 'feat/legacy').odd, LEGACY);
  });

  test('addOddDoc over a legacy row replaces it, reporting the drop and the replacement', () => {
    const { root } = legacyRepo('add');
    const added = registryLib.addOddDoc(root, 'feat/legacy', 'odd/tasks/chosen.md');
    assert.equal(added.ok, true, `expected the association to succeed: ${JSON.stringify(added)}`);
    assert.equal(added.entry.odd, 'odd/tasks/chosen.md', 'the chosen document is the ONLY association');
    assert.equal(added.added, true);
    assert.equal(added.replaced, LEGACY[0], 'the first entry lost the association, and that is reported');
    assert.deepEqual(added.dropped, LEGACY.slice(1), 'and the entries the legacy array lost are reported too');
    assert.equal(storedRow(root, 'feat/legacy').odd, 'odd/tasks/chosen.md');

    const repeat = registryLib.addOddDoc(root, 'feat/legacy', 'odd/tasks/chosen.md');
    assert.equal(repeat.added, false, 'a repeat association is idempotent');
    assert.equal(repeat.replaced, null);
    assert.equal('dropped' in repeat, false, 'a normalized row drops nothing');
  });

  test('upsert says nothing, null or an empty list: keep, clear, clear', () => {
    const root = makeRepo('upsert-forms');
    const target = row('feat/forms', root);
    assert.equal(registryLib.upsertWorktree(root, { ...target, odd: 'odd/tasks/kept.md' }).ok, true);

    const omitted = registryLib.upsertWorktree(root, { ...target, issues: [1] });
    assert.equal(omitted.ok, true);
    assert.equal(omitted.entry.odd, 'odd/tasks/kept.md', 'an omitted odd keeps the association');
    assert.equal('dropped' in omitted, false, 'and reports nothing');

    const cleared = registryLib.upsertWorktree(root, { ...target, odd: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.entry.odd, null, 'null clears the association');
    assert.equal(storedRow(root, 'feat/forms').odd, null);

    assert.equal(registryLib.addOddDoc(root, 'feat/forms', 'odd/tasks/back.md').ok, true);
    const emptied = registryLib.upsertWorktree(root, { ...target, odd: [] });
    assert.equal(emptied.ok, true, 'an empty list is the legacy spelling of "none"');
    assert.equal(emptied.entry.odd, null, 'and normalizes to null, never to []');
    assert.equal(storedRow(root, 'feat/forms').odd, null);
  });

  test('no migration marker is ever serialized into the registry', () => {
    const { root, other } = legacyRepo('serialize');
    registryLib.upsertWorktree(root, { branch: 'feat/other', path: other.path, thread: 'thread-feat/other', issues: [2] });
    registryLib.removeWorktree(root, 'feat/other');

    const raw = fs.readFileSync(registryLib.registryPath(root), 'utf8');
    assert.ok(!raw.includes('oddDropped'), `the non-enumerable marker never reaches the file:\n${raw}`);
    assert.ok(!raw.includes('"dropped"'), 'and neither does the report');
    const stored = JSON.parse(raw).worktrees.find((entry) => entry.branch === 'feat/legacy');
    assert.deepEqual(stored.odd, LEGACY, 'the row still holds every stored document');
    assert.equal('oddDropped' in stored, false);

    // The marker exists only on the in-memory read, where a write that
    // addresses this row can still find it; it never survives serialization
    // and is never an observable field of the row.
    const reread = registryLib.readRegistry(root).worktrees.find((entry) => entry.branch === 'feat/legacy');
    assert.equal(Object.keys(reread).includes('oddDropped'), false, 'the stamp is invisible to a caller');
    assert.equal(JSON.stringify(reread).includes('oddDropped'), false, 'and never serializes');
    assert.equal(reread.odd, LEGACY[0], 'the in-memory view keeps ONE document');
  });
});


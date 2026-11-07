'use strict';
// T8 / S8-S8b: the ENTITY rule — a worktree carries AT MOST ONE odd
// document. It is an invariant of the registry row, not a UI convention:
// the row holds one document path string or `null`, and the registry
// enforces it on EVERY read and EVERY write so no caller can reintroduce a
// second one.
//
// S8b migration: a legacy row that already stores an array normalizes
// deterministically to its FIRST entry, reads never fail on it, and the
// write that normalized it REPORTS the dropped entries once (`dropped`)
// instead of letting a stored association disappear silently.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// and asserts through the public registry interface plus the bytes on disk,
// never an internal helper. Only the fixture dirs tracked in `roots` are
// removed.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const registryLib = require('../lib/worktree-registry.js');

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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-regodd-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function checkoutPath(root, slug) {
  return path.join(path.dirname(root), `${path.basename(root)}-${slug}-wt`);
}

function entry(branch, root, extra = {}) {
  return {
    branch,
    path: checkoutPath(root, branch.replace(/[^a-z0-9]+/gi, '-')),
    thread: `thread-${branch}`,
    issues: [],
    ...extra,
  };
}

// The row exactly as it sits in the registry FILE: proof that the entity —
// not just the in-memory read — holds one document or none.
function storedRows(root) {
  const raw = fs.readFileSync(registryLib.registryPath(root), 'utf8');
  return JSON.parse(raw).worktrees;
}

function storedRow(root, branch) {
  return storedRows(root).find((row) => row.branch === branch);
}

// Hand-write a registry file, exactly as an older version of this package
// left it (rows carrying `odd[]`).
function writeLegacyRegistry(root, rows) {
  const file = registryLib.registryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ version: registryLib.REGISTRY_VERSION, worktrees: rows }, null, 2);
  fs.writeFileSync(file, `${payload}\n`);
  return file;
}

describe('S8: a worktree carries at most ONE odd document', { concurrency: false }, () => {
  test('a write of one document stores it as a single path string, never a list', () => {
    const root = makeRepo('one');
    const written = registryLib.upsertWorktree(root, entry('feat/one', root, { odd: 'odd/tasks/a.md' }));
    assert.equal(written.ok, true, `expected the write to succeed: ${JSON.stringify(written)}`);
    assert.equal(written.entry.odd, 'odd/tasks/a.md', 'the write result carries the single path');
    assert.ok(!Array.isArray(written.entry.odd), 'the write result never carries a list');

    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, true);
    assert.equal(read.worktrees.length, 1);
    assert.equal(read.worktrees[0].odd, 'odd/tasks/a.md', 'a read returns the same single path');
    assert.equal(registryLib.findByBranch(root, 'feat/one').odd, 'odd/tasks/a.md', 'the lookups inherit it');

    const stored = storedRow(root, 'feat/one');
    assert.equal(stored.odd, 'odd/tasks/a.md', 'the row on disk holds the string');
    assert.equal(Array.isArray(stored.odd), false, 'the row on disk never holds a list');
  });

  test('an empty list is "no association": the row stores null, not []', () => {
    const root = makeRepo('empty');
    const written = registryLib.upsertWorktree(root, entry('feat/empty', root, { odd: [] }));
    assert.equal(written.ok, true);
    assert.equal(written.entry.odd, null, 'an empty list normalizes to null');
    assert.equal(storedRow(root, 'feat/empty').odd, null, 'the row on disk holds null');
    assert.equal(registryLib.findByBranch(root, 'feat/empty').odd, null);
  });

  test('a write of two legacy entries collapses to the FIRST and reports the dropped ones once', () => {
    const root = makeRepo('legacy-write');
    const written = registryLib.upsertWorktree(root, entry('feat/drop', root, {
      odd: ['odd/tasks/first.md', 'odd/tasks/second.md', 'odd/tasks/third.md'],
    }));
    assert.equal(written.ok, true, 'a legacy list is normalized, never refused by the registry');
    assert.equal(written.entry.odd, 'odd/tasks/first.md', 'the FIRST stored entry wins deterministically');
    assert.deepEqual(written.dropped, ['odd/tasks/second.md', 'odd/tasks/third.md'], 'the dropped entries are reported');
    assert.equal(storedRow(root, 'feat/drop').odd, 'odd/tasks/first.md', 'only one document reaches the file');

    // Reported ONCE: the row is normalized now, so the next write drops nothing.
    const again = registryLib.updateWorktree(root, 'feat/drop', { issues: [] });
    assert.equal(again.ok, true);
    assert.equal('dropped' in again, false, 'a write that normalizes nothing reports nothing');
    assert.equal(registryLib.findByBranch(root, 'feat/drop').odd, 'odd/tasks/first.md', 'and the association survives');
  });

  test('a legacy row already storing a list reads as its FIRST entry and never fails', () => {
    const root = makeRepo('legacy-read');
    const file = writeLegacyRegistry(root, [
      { ...entry('feat/legacy', root), odd: ['odd/tasks/first.md', 'odd/tasks/second.md'] },
      { ...entry('feat/blank', root), odd: [] },
      { ...entry('feat/missing', root) },
    ]);
    const before = fs.readFileSync(file, 'utf8');

    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, true, 'a read never fails on a legacy array');
    assert.equal(read.error, null);
    const oddOf = (branch) => read.worktrees.find((row) => row.branch === branch).odd;
    assert.equal(oddOf('feat/legacy'), 'odd/tasks/first.md', 'the legacy list reads as one document');
    assert.equal(oddOf('feat/blank'), null, 'an empty list reads as no association');
    assert.equal(oddOf('feat/missing'), null, 'a row without the field reads as no association');
    assert.equal(registryLib.findByBranch(root, 'feat/legacy').odd, 'odd/tasks/first.md');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a read never rewrites the file');
  });

  test('the write over a legacy row normalizes the file and reports the drop', () => {
    const root = makeRepo('legacy-migrate');
    writeLegacyRegistry(root, [
      { ...entry('feat/legacy', root), odd: ['odd/tasks/first.md', 'odd/tasks/second.md'] },
    ]);
    const updated = registryLib.updateWorktree(root, 'feat/legacy', { issues: [] });
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.dropped, ['odd/tasks/second.md'], 'the collapsing write reports what it dropped');
    assert.equal(storedRow(root, 'feat/legacy').odd, 'odd/tasks/first.md', 'the file now holds one document');
    assert.equal(registryLib.updateWorktree(root, 'feat/legacy', { issues: [] }).dropped, undefined, 'reported once');
  });

  test('associating another document REPLACES the stored one and never adds a second', () => {
    const root = makeRepo('replace');
    registryLib.upsertWorktree(root, entry('feat/replace', root, { odd: 'odd/tasks/a.md' }));

    const swapped = registryLib.addOddDoc(root, 'feat/replace', 'odd/tasks/b.md');
    assert.equal(swapped.ok, true);
    assert.equal(swapped.entry.odd, 'odd/tasks/b.md', 'the new document is the ONLY association');
    assert.equal(swapped.added, true);
    assert.equal(swapped.replaced, 'odd/tasks/a.md', 'the replaced association is reported, never dropped silently');
    assert.equal(storedRow(root, 'feat/replace').odd, 'odd/tasks/b.md');

    const same = registryLib.addOddDoc(root, 'feat/replace', 'odd/tasks/b.md');
    assert.equal(same.ok, true);
    assert.equal(same.added, false, 'a repeat association is idempotent');
    assert.equal(same.replaced, null, 'and replaces nothing');
    assert.equal(registryLib.findByBranch(root, 'feat/replace').odd, 'odd/tasks/b.md');
  });

  test('no write path can leave two documents behind: update, add and upsert agree', () => {
    const root = makeRepo('all-writes');
    registryLib.upsertWorktree(root, entry('feat/w', root, { odd: 'odd/tasks/a.md' }));

    const patched = registryLib.updateWorktree(root, 'feat/w', { odd: ['odd/tasks/x.md', 'odd/tasks/y.md'] });
    assert.equal(patched.ok, true, `the registry normalizes a legacy list instead of failing: ${JSON.stringify(patched)}`);
    assert.equal(patched.entry.odd, 'odd/tasks/x.md');
    assert.deepEqual(patched.dropped, ['odd/tasks/y.md']);

    const cleared = registryLib.updateWorktree(root, 'feat/w', { odd: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.entry.odd, null, 'null clears the association');

    const replaced = registryLib.updateWorktree(root, 'feat/w', { odd: 'odd/tasks/z.md' });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.entry.odd, 'odd/tasks/z.md');

    // An upsert that says nothing about odd keeps the stored association.
    const untouched = registryLib.upsertWorktree(root, entry('feat/w', root, {}));
    assert.equal(untouched.ok, true);
    assert.equal(untouched.entry.odd, 'odd/tasks/z.md', 'an omitted odd keeps the single association');

    for (const row of storedRows(root)) {
      assert.ok(row.odd === null || typeof row.odd === 'string', `row holds one document or none: ${JSON.stringify(row.odd)}`);
    }
  });

  test('startup discovery registers rows with no association, never an empty list', () => {
    const root = makeRepo('discovery');
    const live = [{ branch: 'feat/live', path: root }];
    const registered = registryLib.registerMissingWorktrees(root, live, root);
    assert.equal(registered.ok, true, `expected discovery to register: ${JSON.stringify(registered)}`);
    assert.deepEqual(registered.registered.map((row) => row.branch), ['feat/live']);
    const row = registryLib.findByBranch(root, 'feat/live');
    assert.equal(row.odd, null, 'a discovered row carries no association');
    assert.equal(storedRow(root, 'feat/live').odd, null, 'and the file holds null');
  });

  test('a value that is neither a path nor a list is refused without writing', () => {
    const root = makeRepo('refuse');
    registryLib.upsertWorktree(root, entry('feat/r', root, { odd: 'odd/tasks/a.md' }));
    const before = fs.readFileSync(registryLib.registryPath(root), 'utf8');
    const refused = registryLib.updateWorktree(root, 'feat/r', { odd: 42 });
    assert.equal(refused.ok, false, 'a non-path odd value is refused');
    assert.match(refused.error, /odd/i, `the refusal names odd: ${refused.error}`);
    assert.equal(fs.readFileSync(registryLib.registryPath(root), 'utf8'), before, 'a refused write changes nothing');
  });
});

'use strict';
// S1: the worktree registry never destroys data a write was not asked to
// change.
//
// A registry row can still hold the legacy `odd[]` array an older version
// wrote (S8b), and it can hold fields this version knows nothing about. A
// write that addresses ONE row used to rewrite the whole file, normalizing
// every other row on the way through: the stored documents of rows nobody
// touched were destroyed, and the writer had to report that loss. S1 removes
// the association from the product, so the report has no place left to
// travel — which means the loss itself must go.
//
// The contract these tests pin, through the public API plus the bytes on
// disk:
//   - a row a write does NOT address keeps its stored association, its
//     `issues` list and every unknown field, byte for byte, including a
//     legacy `odd[]` array and a row that never had the field at all;
//   - the row a write DOES address keeps the one-document rule: a supplied
//     legacy list collapses to its first entry and the rest are reported
//     once (S8b), and an omitted association leaves the stored value as it
//     is on disk;
//   - an unreadable (malformed) registry is still replaced with a best-effort
//     backup rather than merged.
//
// Every test builds its own isolated fixture repository under os.tmpdir().

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const registryLib = require('../lib/worktree-registry.js');

const LEGACY_ODD = ['odd/tasks/first.md', 'odd/tasks/second.md', 'odd/tasks/third.md'];

const roots = [];
after(() => {
  for (const dir of roots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-reg-${tag}-`)));
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

// A row exactly as an older version left it: the legacy association list,
// an `issues` list, and a field this version does not model at all.
function legacyRow(root) {
  return {
    branch: 'feat/legacy',
    path: checkoutPath(root, 'legacy'),
    thread: 'thread-legacy',
    issues: [11, 12],
    odd: LEGACY_ODD.slice(),
    note: 'kept verbatim',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

function writeRegistryFile(root, rows) {
  const file = registryLib.registryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: registryLib.REGISTRY_VERSION, worktrees: rows }, null, 2)}\n`);
  return file;
}

function legacyRepo(tag) {
  const root = makeRepo(tag);
  const other = row('feat/other', root);
  const legacy = legacyRow(root);
  writeRegistryFile(root, [legacy, { ...other, odd: 'odd/tasks/other.md' }]);
  return { root, legacy, other };
}

function storedRow(root, branch) {
  const raw = fs.readFileSync(registryLib.registryPath(root), 'utf8');
  return JSON.parse(raw).worktrees.find((entry) => entry.branch === branch);
}

// Byte-for-byte: the parsed row equals the original in values AND key order.
function assertKeptVerbatim(root, original) {
  const stored = storedRow(root, original.branch);
  assert.deepEqual(stored, original, `the unaddressed row is preserved verbatim: ${JSON.stringify(stored)}`);
  assert.equal(
    JSON.stringify(stored),
    JSON.stringify(original),
    'not one byte of the stored row changed, key order included',
  );
}

// Each entry is one whole-file write that addresses a DIFFERENT row.
const UNRELATED_WRITES = [
  ['upsertWorktree', ({ root, other }) => registryLib.upsertWorktree(root, { ...other, issues: [7] })],
  ['appendWorktree', ({ root, other }) => registryLib.appendWorktree(root, { ...other, issues: [7] })],
  ['updateWorktree', ({ root }) => registryLib.updateWorktree(root, 'feat/other', { issues: [7, 8] })],
  ['removeWorktree', ({ root }) => registryLib.removeWorktree(root, 'feat/other')],
  ['removeWorktreeByPath', ({ root, other }) => registryLib.removeWorktreeByPath(root, other.path)],
  ['removeWorktreeExact', ({ root, other }) => registryLib.removeWorktreeExact(root, other.branch, other.path)],
  ['pruneWorktrees', ({ root, other }) => registryLib.pruneWorktrees(root, [other.path])],
  ['registerMissingWorktrees', ({ root }) => {
    const live = checkoutPath(root, 'new-live');
    fs.mkdirSync(live, { recursive: true });
    roots.push(live);
    return registryLib.registerMissingWorktrees(root, [{ branch: 'feat/new-live', path: live }], null);
  }],
];

describe('S1: a registry write never destroys an association it does not address', { concurrency: false }, () => {
  for (const [name, run] of UNRELATED_WRITES) {
    test(`${name} leaves another row's stored documents, issues and fields byte for byte`, () => {
      const fixture = legacyRepo(`keep-${name}`);
      const before = fs.readFileSync(registryLib.registryPath(fixture.root), 'utf8');
      const result = run(fixture);
      assert.equal(result.ok, true, `expected the write to succeed: ${JSON.stringify(result)}`);
      assert.equal('dropped' in result, false, 'nothing was lost, so nothing is reported');
      assertKeptVerbatim(fixture.root, fixture.legacy);
      // The row that WAS addressed is the only one that changed.
      assert.notEqual(fs.readFileSync(registryLib.registryPath(fixture.root), 'utf8'), before);
      assert.equal(registryLib.findByBranch(fixture.root, 'feat/legacy').odd, LEGACY_ODD[0],
        'reads still resolve the legacy list to ONE document in memory');
    });
  }

  test('a row without an odd or issues field gains neither', () => {
    const root = makeRepo('bare-row');
    const other = row('feat/other', root);
    const bare = { branch: 'feat/bare', path: checkoutPath(root, 'bare'), thread: 'thread-bare' };
    writeRegistryFile(root, [bare, { ...other, odd: null }]);
    const result = registryLib.upsertWorktree(root, { ...other, issues: [3] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const stored = storedRow(root, 'feat/bare');
    assert.deepEqual(Object.keys(stored), ['branch', 'path', 'thread'],
      'a write invents no `issues`/`odd` on a row it did not address');
    assert.equal(JSON.stringify(stored), JSON.stringify(bare), 'the row is byte-identical');
  });

  test('a malformed registry is still replaced behind a backup, never merged', () => {
    const root = makeRepo('malformed');
    const file = registryLib.registryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const written = registryLib.upsertWorktree(root, { branch: 'feat/new', path: checkoutPath(root, 'new'), thread: 't', issues: [] });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(typeof written.backup, 'string', 'the damaged bytes are preserved beside the registry');
    assert.equal(fs.readFileSync(written.backup, 'utf8'), '{ not json', 'the backup holds the previous bytes');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file, 'utf8')).worktrees.map((entry) => entry.branch),
      ['feat/new'],
      'the incoming row is the only trustworthy data',
    );
  });
});

describe('S1/S8: the row a write addresses keeps the one-document rule', { concurrency: false }, () => {
  test('an addressed legacy row collapses to its FIRST entry and reports the rest once', () => {
    const { root } = legacyRepo('addressed-update');
    const updated = registryLib.updateWorktree(root, 'feat/legacy', { issues: [11] });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.deepEqual(updated.dropped, LEGACY_ODD.slice(1), 'the collapse of the addressed row is reported');
    assert.equal(storedRow(root, 'feat/legacy').odd, LEGACY_ODD[0], 'the file holds one document');
    const again = registryLib.updateWorktree(root, 'feat/legacy', { issues: [11, 12] });
    assert.equal('dropped' in again, false, 'reported once, never on every later write');
  });

  test('an upsert that omits the association leaves the stored list exactly as it is', () => {
    const { root, legacy } = legacyRepo('addressed-omitted');
    const written = registryLib.upsertWorktree(root, {
      branch: legacy.branch, path: legacy.path, thread: legacy.thread, issues: [11, 12, 13],
    });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal('dropped' in written, false, 'an association nobody changed is not a loss');
    const stored = storedRow(root, legacy.branch);
    assert.deepEqual(stored.odd, LEGACY_ODD, 'the stored list is untouched');
    assert.deepEqual(stored.issues, [11, 12, 13], 'the supplied field is the one that changes');
    assert.equal(stored.note, 'kept verbatim', 'a field this version does not model survives an addressed write too');
  });

  test('a supplied legacy list still collapses to ONE document and reports the rest', () => {
    const root = makeRepo('supplied-list');
    const target = row('feat/supplied', root);
    const written = registryLib.upsertWorktree(root, {
      ...target, issues: [], odd: ['odd/tasks/x.md', 'odd/tasks/y.md'],
    });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.deepEqual(written.dropped, ['odd/tasks/y.md'], 'the caller-supplied list keeps its first entry only');
    assert.equal(storedRow(root, 'feat/supplied').odd, 'odd/tasks/x.md');
  });

  test('addOddDoc replaces the addressed row\'s document and reports the replacement', () => {
    const { root } = legacyRepo('addressed-add');
    const added = registryLib.addOddDoc(root, 'feat/legacy', 'odd/tasks/chosen.md');
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.entry.odd, 'odd/tasks/chosen.md');
    assert.equal(added.replaced, LEGACY_ODD[0], 'the document that lost the association is named');
    assert.deepEqual(added.dropped, LEGACY_ODD.slice(1), 'and the legacy entries the selection replaced');
    assert.equal(storedRow(root, 'feat/legacy').odd, 'odd/tasks/chosen.md');
    // The other row of the fixture is untouched by the addressed write.
    assert.equal(storedRow(root, 'feat/other').odd, 'odd/tasks/other.md');
  });
});

describe('S1: the registry file carries no report and no marker', { concurrency: false }, () => {
  test('neither the drop report nor the migration stamp ever reaches the file', () => {
    const { root, other } = legacyRepo('serialize');
    registryLib.upsertWorktree(root, { ...other, issues: [2] });
    registryLib.removeWorktree(root, 'feat/other');
    const raw = fs.readFileSync(registryLib.registryPath(root), 'utf8');
    assert.ok(!raw.includes('oddDropped'), `the non-enumerable marker never reaches the file:\n${raw}`);
    assert.ok(!raw.includes('"dropped"'), 'and neither does the report');
    const reread = registryLib.readRegistry(root).worktrees.find((entry) => entry.branch === 'feat/legacy');
    assert.equal(Object.keys(reread).includes('oddDropped'), false, 'the stamp is never an observable field');
    assert.equal(JSON.stringify(reread).includes('oddDropped'), false, 'and never serializes');
    assert.equal(reread.odd, LEGACY_ODD[0], 'the in-memory view keeps the single-document rule');
  });
});

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
// The same promise holds one level up. `<git-common-dir>/pi-worktrees.json`
// is ONE document with MORE THAN ONE owner: this module owns `worktrees`, and
// the clone-metadata reader (`lib/worktree-metadata.js`) owns `kind` and
// `records`. This module never interprets those keys, so no write may reshape,
// reorder or drop one — and a file that never carried one must never gain it.
// The metadata reader accepts a `worktrees`-only document as a valid EMPTY
// store, so a dropped `kind`/`records` would lose every record with no error
// anywhere: the silent loss these tests exist to prevent.
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

function writeRegistryFile(root, rows, extra = {}) {
  const file = registryLib.registryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: registryLib.REGISTRY_VERSION, worktrees: rows, ...extra }, null, 2)}\n`);
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

  test('a row created without an association omits the key instead of writing null', () => {
    const root = makeRepo('absent-odd');
    const target = row('feat/absent-odd', root);
    const written = registryLib.upsertWorktree(root, target);
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(Object.prototype.hasOwnProperty.call(storedRow(root, target.branch), 'odd'), false,
      'the document omits the absent association');
    assert.equal(Object.prototype.hasOwnProperty.call(written.entry, 'odd'), false,
      'and so does the row the write returns');
  });

  test('an update that omits an absent association never invents odd: null', () => {
    const root = makeRepo('absent-odd-update');
    const target = row('feat/absent-update', root);
    assert.equal(registryLib.upsertWorktree(root, target).ok, true);
    const updated = registryLib.updateWorktree(root, target.branch, { issues: [1] });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(Object.prototype.hasOwnProperty.call(storedRow(root, target.branch), 'odd'), false,
      'the absent association stays absent through a later update');
    assert.equal(Object.prototype.hasOwnProperty.call(updated.entry, 'odd'), false,
      'and the returned row agrees');
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

// -------------------------------------------------- the shared document
//
// The same promise holds one level up. `<git-common-dir>/pi-worktrees.json` is
// ONE document with MORE THAN ONE owner: this module owns `worktrees`, and the
// clone-metadata reader (`lib/worktree-metadata.js`) owns `kind` and `records`.
// This module never interprets those keys, so no write may reshape, reorder or
// drop them — and a file that never carried them must never gain them. The
// metadata reader accepts a `worktrees`-only document as a valid EMPTY store,
// so a dropped `kind`/`records` would lose every record without an error
// anywhere: the failure these tests exist to prevent.
const metadataLib = require('../lib/worktree-metadata.js');

// The sibling's records, shaped exactly as the metadata side stores them.
const SHARED_RECORDS = {
  '/tmp/fixture-original': {
    odd: 'odd/tasks/worktree-tools-v2.md',
    createdAt: '2024-02-03T04:05:06.000Z',
    createdBy: 'session-original',
    adminId: 'fixture-original',
    branchAtCreation: 'main',
    baseRef: 'origin/main',
    hooks: [{ name: 'copy-inputs', status: 'applied', detail: '3 files' }],
    setup: {
      status: 'ready',
      steps: [{
        command: 'npm ci',
        status: 'ready',
        logPath: '/tmp/fixture-original-setup.log',
        exitCode: 0,
        endedAt: '2024-02-03T04:06:06.000Z',
      }],
      jobId: 'job-original',
      command: 'npm ci',
      exitCode: 0,
      endedAt: '2024-02-03T04:06:06.000Z',
    },
    lastSeen: { at: '2024-02-05T04:05:06.000Z', branch: 'main', status: 'active' },
  },
  '/tmp/fixture-feature': {
    odd: 'odd/tasks/worktree-tools-v2.md',
    createdAt: '2024-02-04T05:06:07.000Z',
    createdBy: 'session-feature',
    adminId: 'fixture-feature',
    branchAtCreation: 'feat/feature',
    baseRef: 'main',
    hooks: [{ name: 'copy-inputs', status: 'skipped' }],
    setup: {
      status: 'pending',
      steps: [],
      detail: 'no background job registry in this session',
    },
    lastSeen: { at: '2024-02-06T05:06:07.000Z', branch: 'feat/feature', status: 'foreign' },
  },
};

// A shared file in the exact bytes the metadata side writes for it: `kind`
// first, `worktrees` in one stable position, `records` key-sorted last.
function writeSharedRegistryFile(root, rows, records = SHARED_RECORDS) {
  const file = registryLib.registryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = metadataLib.serializeWorktreeMetadataFile({
    kind: metadataLib.WORKTREE_METADATA_KIND,
    version: registryLib.REGISTRY_VERSION,
    worktrees: rows,
    records,
  });
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

function sharedFixture(tag) {
  const root = makeRepo(tag);
  const rows = [row('feat/one', root), row('feat/two', root)];
  const { file, bytes } = writeSharedRegistryFile(root, rows);
  return { root, rows, file, bytes };
}

// Every top-level key this module does not own, checked the way the rows are:
// the document's key order, and each sibling value's own bytes.
function assertSiblingKeysKept(file, beforeRaw, { sameKeyOrder = true } = {}) {
  const before = JSON.parse(beforeRaw);
  const written = fs.readFileSync(file, 'utf8');
  const after = JSON.parse(written);
  if (sameKeyOrder) {
    assert.deepEqual(Object.keys(after), Object.keys(before),
      `the shared document keeps its key order:\n${written}`);
  }
  for (const key of Object.keys(before)) {
    if (key === 'worktrees') continue;
    assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]),
      `\`${key}\` is carried through byte for byte:\n${written}`);
  }
}

// The stronger form available for a real shared document: the registry's own
// output is still exactly what the metadata side would serialize, so an
// untouched file the registry had to rewrite keeps its canonical bytes.
function assertCanonicalSharedDocument(file) {
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(metadataLib.serializeWorktreeMetadataFile(JSON.parse(written)), written,
    `the registry emitted the metadata side's own canonical bytes:\n${written}`);
}

// Anything a write left beside the registry: a temp file would mean the atomic
// path leaked, a `.corrupt-` backup would mean a two-owner document was read as
// damage.
function registrySiblings(file) {
  return fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.`));
}

// Every whole-file write this module exposes, each addressing a row while both
// sibling keys sit in the same document.
const SHARED_WRITES = [
  ['upsertWorktree (add)', ({ root }) => registryLib.upsertWorktree(root, row('feat/added', root))],
  ['appendWorktree (add)', ({ root }) => registryLib.appendWorktree(root, row('feat/appended', root))],
  ['updateWorktree', ({ root }) => registryLib.updateWorktree(root, 'feat/one', { issues: [7] })],
  ['addOddDoc', ({ root }) => registryLib.addOddDoc(root, 'feat/one', 'odd/tasks/chosen.md')],
  ['removeWorktree', ({ root }) => registryLib.removeWorktree(root, 'feat/two')],
  ['removeWorktreeByPath', ({ root, rows }) => registryLib.removeWorktreeByPath(root, rows[1].path)],
  ['removeWorktreeExact', ({ root, rows }) => registryLib.removeWorktreeExact(root, rows[1].branch, rows[1].path)],
  ['pruneWorktrees', ({ root, rows }) => registryLib.pruneWorktrees(root, [rows[1].path])],
  ['registerMissingWorktrees', ({ root }) => {
    const live = checkoutPath(root, 'shared-live');
    fs.mkdirSync(live, { recursive: true });
    roots.push(live);
    return registryLib.registerMissingWorktrees(root, [{ branch: 'feat/shared-live', path: live }], null);
  }],
];

describe('S4b: the registry carries the shared-document keys it does not own', { concurrency: false }, () => {
  test('a two-owner document reads as the same registry, never as damage', () => {
    const { root, rows, file, bytes } = sharedFixture('shared-read');
    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, true, `a sibling key is not a corruption: ${JSON.stringify(read)}`);
    assert.equal(read.error, null);
    assert.equal(read.version, registryLib.REGISTRY_VERSION, 'and not an unknown version');
    assert.deepEqual(read.worktrees.map((entry) => entry.branch), rows.map((entry) => entry.branch),
      'the rows read exactly as they do without the sibling keys');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a read never rewrites the file');
    assert.deepEqual(registrySiblings(file), [], 'and a good document is never backed up as corrupt');
  });

  for (const [name, run] of SHARED_WRITES) {
    test(`${name} carries \`kind\` and \`records\` through byte for byte`, () => {
      const fixture = sharedFixture(`shared-${name.split(' ')[0]}`);
      const before = fs.readFileSync(fixture.file, 'utf8');
      const result = run(fixture);
      assert.equal(result.ok, true, `expected the write to succeed: ${JSON.stringify(result)}`);
      assertSiblingKeysKept(fixture.file, before);
      assertCanonicalSharedDocument(fixture.file);
      assert.deepEqual(registrySiblings(fixture.file), [],
        'the write left neither a temp file nor a corruption backup behind');
      assert.notDeepEqual(JSON.parse(fs.readFileSync(fixture.file, 'utf8')).worktrees, JSON.parse(before).worktrees,
        'the worktrees edit that was asked for did land');
      assert.equal(registryLib.readRegistry(fixture.root).ok, true, 'the two-owner document is readable again');
    });
  }

  test('`kind` and `records` survive an add, then a remove, then a prune', () => {
    const fixture = sharedFixture('shared-sequence');
    const steps = [
      ['add', () => registryLib.upsertWorktree(fixture.root, row('feat/added', fixture.root))],
      ['remove', () => registryLib.removeWorktree(fixture.root, 'feat/two')],
      ['prune', () => registryLib.pruneWorktrees(fixture.root, [checkoutPath(fixture.root, 'feat-one')])],
    ];
    for (const [step, run] of steps) {
      const before = fs.readFileSync(fixture.file, 'utf8');
      const result = run();
      assert.equal(result.ok, true, `${step}: ${JSON.stringify(result)}`);
      assertSiblingKeysKept(fixture.file, before);
      assertCanonicalSharedDocument(fixture.file);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file, 'utf8')).worktrees.map((entry) => entry.branch),
      ['feat/added'], 'the three edits left only the row the add created');
  });

  test('a metadata-written file survives a registry write and is still read by the metadata side', () => {
    const root = makeRepo('shared-metadata-e2e');
    const file = registryLib.registryPath(root);
    assert.equal(registryLib.upsertWorktree(root, row('feat/one', root)).ok, true);
    // The metadata side writes its own keys into the same clone file.
    const recordPath = checkoutPath(root, 'shared-records');
    const record = { ...SHARED_RECORDS['/tmp/fixture-original'] };
    metadataLib.saveWorktreeMetadataRecords(file, { [recordPath]: record });
    const metadataBytes = fs.readFileSync(file, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(metadataBytes)), ['kind', 'version', 'worktrees', 'records'],
      `the metadata side wrote the shared document:\n${metadataBytes}`);

    // A registry write the other owner knows nothing about.
    const written = registryLib.upsertWorktree(root, row('feat/two', root));
    assert.equal(written.ok, true, JSON.stringify(written));
    assertSiblingKeysKept(file, metadataBytes);
    assertCanonicalSharedDocument(file);

    const reread = metadataLib.readWorktreeMetadataStore(file);
    assert.equal(reread.status, 'valid', `the metadata side still reads the file: ${JSON.stringify(reread)}`);
    assert.deepEqual(Object.keys(reread.file.records), [recordPath], 'its records are all still there, none invented');
    assert.deepEqual(reread.file.records[recordPath], record, 'and unchanged');
    assert.deepEqual(reread.file.worktrees.map((entry) => entry.branch), ['feat/one', 'feat/two'],
      'while its view of the registry array is the current one');
  });

  test('a write over a file that never carried the sibling keys never invents them', () => {
    const root = makeRepo('shared-absent');
    const file = writeRegistryFile(root, [row('feat/one', root)]);
    assert.equal(registryLib.upsertWorktree(root, row('feat/two', root)).ok, true);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(doc), ['version', 'worktrees'],
      `no empty records map and no kind are invented: ${JSON.stringify(doc)}`);

    // The same holds for a clone whose registry does not exist yet.
    const fresh = makeRepo('shared-absent-fresh');
    assert.equal(registryLib.upsertWorktree(fresh, row('feat/one', fresh)).ok, true);
    const freshDoc = JSON.parse(fs.readFileSync(registryLib.registryPath(fresh), 'utf8'));
    assert.deepEqual(Object.keys(freshDoc), ['version', 'worktrees'],
      `a first write stays exactly as shaped today: ${JSON.stringify(freshDoc)}`);
  });

  test('`records` without `worktrees` still reads as the malformed registry it reads today', () => {
    const root = makeRepo('shared-no-worktrees');
    const file = registryLib.registryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = metadataLib.serializeWorktreeMetadataFile({
      kind: metadataLib.WORKTREE_METADATA_KIND,
      version: registryLib.REGISTRY_VERSION,
      records: SHARED_RECORDS,
    });
    fs.writeFileSync(file, bytes);
    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, false, 'the file is not a registry until `worktrees` exists');
    assert.equal(read.version, null);
    assert.deepEqual(read.worktrees, []);
    assert.equal(read.error, 'malformed registry (expected {worktrees: []})', 'the message is unchanged');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a read never rewrites the file');
  });

  test('the write that replaces such a document keeps the sibling keys and still backs up the bytes', () => {
    const root = makeRepo('shared-no-worktrees-write');
    const file = registryLib.registryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const damaged = metadataLib.serializeWorktreeMetadataFile({
      kind: metadataLib.WORKTREE_METADATA_KIND,
      version: registryLib.REGISTRY_VERSION,
      records: SHARED_RECORDS,
    });
    fs.writeFileSync(file, damaged);
    const written = registryLib.upsertWorktree(root, row('feat/new', root));
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(typeof written.backup, 'string', 'the damaged bytes are preserved beside the registry');
    assert.equal(fs.readFileSync(written.backup, 'utf8'), damaged, 'the backup holds the previous bytes');
    assertSiblingKeysKept(file, damaged, { sameKeyOrder: false });
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(doc), ['kind', 'version', 'worktrees', 'records'],
      'the completed document takes the stable order this file has always had');
    assert.deepEqual(doc.worktrees.map((entry) => entry.branch), ['feat/new'],
      'the worktrees side is replaced, never merged');
  });

  test('an unmodelled top-level key is tolerated on read and carried through on write', () => {
    const root = makeRepo('shared-unknown-key');
    const file = writeRegistryFile(root, [row('feat/one', root)], { kind: 'future.sibling', later: { kept: true } });
    const bytes = fs.readFileSync(file, 'utf8');
    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, true, 'a key this version does not model is tolerated, never a corruption');
    assert.equal(registryLib.upsertWorktree(root, row('feat/two', root)).ok, true);
    assertSiblingKeysKept(file, bytes);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(doc), ['version', 'worktrees', 'kind', 'later'],
      'the key keeps its place and its bytes; worktrees keeps the position it held');
  });
});

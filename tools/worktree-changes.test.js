'use strict';
// S61/T47 tests: lib/worktree-changes.js — the shared pending-changes
// helper (dirty summary + safe copy). Real isolated git repos; the helper
// shells out to git only. Every assertion goes through the public functions,
// never internals.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const changes = require('../lib/worktree-changes.js');

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// A directory OUTSIDE every checkout, tracked for teardown: the isolation these
// tests need to prove that nothing escaped the destination.
function trackOutsideDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-outside-${tag}-`));
  roots.push(dir);
  return dir;
}

function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-changes-${name}-`));
  roots.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'alpha\nbeta\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function addWorktree(root, branch) {
  git(root, ['worktree', 'add', '-b', branch, path.join(root, '..', `wt-${branch.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}`)]);
  const list = git(root, ['worktree', 'list', '--porcelain']).split('\n');
  let current = null;
  for (const line of list) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    if (line === `branch refs/heads/${branch}`) return current;
  }
  throw new Error(`worktree for ${branch} not found`);
}

describe('summarizeChanges', { concurrency: false }, () => {
  test('a clean checkout reports zero files', async () => {
    const root = makeRepo('clean');
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 0);
    assert.equal(summary.added, 0);
    assert.equal(summary.deleted, 0);
  });

  test('a tracked modification counts staged and unstaged once, not twice', async () => {
    const root = makeRepo('staged-unstaged');
    // Staged change plus a further unstaged change to the SAME file:
    // the HEAD diff holds both, counted once.
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO-staged\n');
    git(root, ['add', 'a.txt']);
    fs.appendFileSync(path.join(root, 'a.txt'), 'three-unstaged\n');
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 1, JSON.stringify(summary.entries));
    const entry = summary.entries[0];
    assert.equal(entry.rel, 'a.txt');
    assert.equal(entry.added, 2);
    assert.equal(entry.deleted, 1);
    assert.equal(summary.added, 2);
    assert.equal(summary.deleted, 1);
  });

  test('untracked files count added lines and deletions remove lines', async () => {
    const root = makeRepo('untracked-deletion');
    fs.writeFileSync(path.join(root, 'new.txt'), 'l1\nl2\nl3\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'alpha\n');
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 2);
    const byRel = Object.fromEntries(summary.entries.map((e) => [e.rel, e]));
    assert.equal(byRel['new.txt'].added, 3);
    assert.equal(byRel['new.txt'].untracked, true);
    assert.equal(byRel['b.txt'].added, 0);
    assert.equal(byRel['b.txt'].deleted, 1);
  });

  test('a rename is one entry and binary files never fake line counts', async () => {
    const root = makeRepo('rename-binary');
    git(root, ['mv', 'a.txt', 'renamed.txt']);
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e, 0x47, 0x0a]);
    fs.writeFileSync(path.join(root, 'blob.bin'), binary);
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    const byRel = Object.fromEntries(summary.entries.map((e) => [e.rel, e]));
    assert.ok(byRel['renamed.txt'], `rename entry present: ${JSON.stringify(summary.entries)}`);
    assert.equal(byRel['renamed.txt'].status, 'renamed');
    assert.equal(byRel['blob.bin'].binary, true);
    assert.equal(byRel['blob.bin'].added, 0, 'binary added lines are never faked');
    assert.equal(summary.binaryCount, 1);
    assert.match(changes.formatChangeSummary(summary), /\(1 binary\)/);
  });

  test('a tracked binary modification labels binary with zero counts', async () => {
    const root = makeRepo('tracked-binary');
    const start = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0b]);
    fs.writeFileSync(path.join(root, 'img.bin'), start);
    git(root, ['add', 'img.bin']);
    git(root, ['commit', '-m', 'add binary']);
    fs.appendFileSync(path.join(root, 'img.bin'), Buffer.from([0x00, 0xff, 0x01]));
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    const entry = summary.entries.find((e) => e.rel === 'img.bin');
    assert.ok(entry, 'binary modification is reported');
    assert.equal(entry.binary, true);
    assert.equal(entry.added, 0);
    assert.equal(entry.deleted, 0);
  });

  test('formatChangeSummary is exact on clean and dirty checkouts', async () => {
    assert.equal(changes.formatChangeSummary({ files: 0, added: 0, deleted: 0, binaryCount: 0 }), '0 files, +0/-0');
    assert.equal(changes.formatChangeSummary({ files: 1, added: 2, deleted: 1, binaryCount: 0 }), '1 file, +2/-1');
    assert.equal(changes.formatChangeSummary({ files: 2, added: 3, deleted: 1, binaryCount: 0 }), '2 files, +3/-1');
  });

  test('timeout/failure reports precisely and mutates nothing', async () => {
    const root = makeRepo('timeout');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    const before = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
    const summary = await changes.summarizeChanges(root, {
      runAsync: async () => ({ status: null, stdout: '', stderr: '', error: 'timed out after 5ms' }),
    });
    assert.equal(summary.ok, false);
    assert.match(summary.error, /timed out/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), before, 'a failed read mutates nothing');
  });
});

describe('normalizeChangesSelection', { concurrency: false }, () => {
  test('omitted, empty string and empty list all mean no copy', () => {
    assert.deepEqual(changes.normalizeChangesSelection(undefined), { ok: true, mode: 'none', paths: [] });
    assert.deepEqual(changes.normalizeChangesSelection(''), { ok: true, mode: 'none', paths: [] });
    assert.deepEqual(changes.normalizeChangesSelection([]), { ok: true, mode: 'none', paths: [] });
  });
  test('"all" copies everything and a list copies those files', () => {
    assert.deepEqual(changes.normalizeChangesSelection('all'), { ok: true, mode: 'all', paths: [] });
    const listed = changes.normalizeChangesSelection(['a.txt']);
    assert.equal(listed.ok, true);
    assert.equal(listed.mode, 'paths');
  });
  // PRESERVE (S61): the shared helper is the WARP's contract and is not part of
  // the S3/S4 create change, so it keeps its original value set and its original
  // wording byte for byte. The create accepts the word "none" by adapting
  // LOCALLY before calling this helper (tools/worktree-create-tool.test.js).
  test('the helper keeps its original contract: "none" is not a value, and the wording is unchanged', () => {
    assert.equal(changes.normalizeChangesSelection('none').ok, false);
    assert.equal(
      changes.normalizeChangesSelection('none').error,
      'invalid changes selection \"none\": pass \"all\", a list of files, or leave it empty for no copy',
    );
    assert.equal(
      changes.normalizeChangesSelection('some').error,
      'invalid changes selection \"some\": pass \"all\", a list of files, or leave it empty for no copy',
    );
    assert.equal(
      changes.normalizeChangesSelection(['']).error,
      'invalid changes selection: every entry must be a non-empty file path',
    );
    assert.equal(
      changes.normalizeChangesSelection(42).error,
      'invalid changes selection: pass \"all\", a list of files, or leave it empty for no copy',
    );
  });
  test('anything else fails closed', () => {
    assert.equal(changes.normalizeChangesSelection('some').ok, false);
    assert.equal(changes.normalizeChangesSelection(42).ok, false);
    assert.equal(changes.normalizeChangesSelection(['']).ok, false);
  });
});

describe('copyChanges', { concurrency: false }, () => {
  test('copy all moves tracked and untracked changes; source retained, destination index preserved', async () => {
    const root = makeRepo('copy-all');
    const src = addWorktree(root, 'feat/copy-src');
    const dest = addWorktree(root, 'feat/copy-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(src, 'new.txt'), 'fresh\nfile\n');
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied.sort(), ['a.txt', 'new.txt']);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'fresh\nfile\n');
      // Source retained: nothing was stashed, moved or reset.
      assert.equal(fs.readFileSync(path.join(src, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.ok(fs.existsSync(path.join(src, 'new.txt')));
      // Destination index preserved: working-tree changes only, nothing staged.
      const cached = git(dest, ['diff', '--cached', '--name-only']).trim();
      assert.equal(cached, '', 'the destination index stays untouched');
      const sourceCached = git(src, ['diff', '--cached', '--name-only']).trim();
      assert.equal(sourceCached, '', 'the source index stays untouched');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('selected files copy only those files', async () => {
    const root = makeRepo('copy-selected');
    const src = addWorktree(root, 'feat/sel-src');
    const dest = addWorktree(root, 'feat/sel-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(src, 'b.txt'), 'ALPHA\nbeta\n');
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['a.txt'] });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied, ['a.txt']);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'alpha\nbeta\n', 'unselected files stay clean');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('a destination that already modifies a selected path rejects with zero mutation', async () => {
    const root = makeRepo('copy-overlap');
    const src = addWorktree(root, 'feat/over-src');
    const dest = addWorktree(root, 'feat/over-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nSRC\n');
      fs.writeFileSync(path.join(dest, 'a.txt'), 'one\nDEST\n');
      const beforeDest = fs.readFileSync(path.join(dest, 'a.txt'), 'utf8');
      const beforeSrc = fs.readFileSync(path.join(src, 'a.txt'), 'utf8');
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false);
      assert.match(copied.error, /destination already modifies/);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), beforeDest, 'destination untouched');
      assert.equal(fs.readFileSync(path.join(src, 'a.txt'), 'utf8'), beforeSrc, 'source untouched');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('a deletion and a binary copy travel safely', async () => {
    const root = makeRepo('copy-del-bin');
    const src = addWorktree(root, 'feat/db-src');
    const dest = addWorktree(root, 'feat/db-dest');
    try {
      fs.rmSync(path.join(src, 'b.txt'));
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x01]);
      fs.writeFileSync(path.join(src, 'blob.bin'), binary);
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.equal(fs.existsSync(path.join(dest, 'b.txt')), false, 'the deletion applies');
      assert.ok(fs.readFileSync(path.join(dest, 'blob.bin')).equals(binary), 'binary bytes survive');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('foreign checkouts, traversal, symlink escape and .git all refuse without mutation', async () => {
    const first = makeRepo('foreign-a');
    const second = makeRepo('foreign-b');
    fs.writeFileSync(path.join(first, 'a.txt'), 'changed\n');
    const beforeFirst = fs.readFileSync(path.join(first, 'a.txt'), 'utf8');
    const beforeSecond = fs.readFileSync(path.join(second, 'a.txt'), 'utf8');
    const foreign = await changes.copyChanges({ from: first, to: second, selectMode: 'all' });
    assert.equal(foreign.ok, false);
    assert.match(foreign.error, /different repositories/);
    assert.equal(fs.readFileSync(path.join(first, 'a.txt'), 'utf8'), beforeFirst);
    assert.equal(fs.readFileSync(path.join(second, 'a.txt'), 'utf8'), beforeSecond);

    const root = makeRepo('escape');
    const src = addWorktree(root, 'feat/esc-src');
    const dest = addWorktree(root, 'feat/esc-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO\n');
      const traversal = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['../a.txt'] });
      assert.equal(traversal.ok, false, 'traversal refuses');
      const gitInternal = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['.git/HEAD'] });
      assert.equal(gitInternal.ok, false, '.git refuses');
      // A symlink escaping the checkout never enters the summary, so
      // selecting it fails closed as unknown.
      fs.symlinkSync(path.join(os.tmpdir()), path.join(src, 'link-out'));
      const summary = await changes.summarizeChanges(src);
      assert.equal(summary.ok, true);
      assert.ok(!summary.entries.some((e) => e.rel === 'link-out'), 'escape symlinks are not summarized');
      const escaped = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['link-out'] });
      assert.equal(escaped.ok, false, 'symlink escape refuses');
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\ntwo\n', 'rejected copies change nothing');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });
});

// ---------------------------------------------------------------------------
// The destination a warp or create lands in is routinely built from ANOTHER
// base: `worktree_create` seeds the new branch from LOCAL MAIN, and a worktree
// made before the source branch's last commit carries none of its files. The
// PENDING edit must still travel there — and the source branch's COMMITTED
// delta must not: diffing the destination HEAD against the source working tree
// would import it and overwrite destination-only content. Both consumers (the
// human `/warp` command and the `worktree_create` tool) go through this one
// helper, so these cases are the regression evidence for both.
describe('copyChanges onto a destination built from another base', { concurrency: false }, () => {
  const EIGHT = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';

  function removeWorktrees(root, ...checkouts) {
    for (const checkout of checkouts) {
      git(root, ['worktree', 'remove', '--force', checkout]);
    }
  }

  test('a file only the source branch has is created, and its committed siblings stay behind', async () => {
    const root = makeRepo('div-new-file');
    const src = addWorktree(root, 'feat/div-new-src');
    const dest = addWorktree(root, 'feat/div-new-dest');
    try {
      // The source branch COMMITS a new file plus a change to a file both
      // branches share, then edits the new file without committing. The
      // destination, created from main, has neither.
      fs.writeFileSync(path.join(src, 'late.js'), 'export const one = 1;\n');
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nCOMMITTED-ON-THE-SOURCE-BRANCH\n');
      git(src, ['add', '.']);
      git(src, ['commit', '-m', 'source branch: add late.js and touch a.txt']);
      fs.writeFileSync(path.join(src, 'late.js'), 'export const one = 1;\nexport const two = 2;\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied, ['late.js'], 'only the pending file is selected');
      assert.equal(
        fs.readFileSync(path.join(dest, 'late.js'), 'utf8'),
        'export const one = 1;\nexport const two = 2;\n',
        'the pending version of the file the destination never had is created there',
      );
      assert.equal(
        fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'),
        'one\ntwo\n',
        "the source branch's COMMITTED change never travels",
      );
      assert.equal(git(dest, ['diff', '--cached', '--name-only']).trim(), '', 'the destination index stays untouched');
      assert.equal(git(src, ['diff', '--cached', '--name-only']).trim(), '', 'the source index stays untouched');
      assert.equal(
        fs.readFileSync(path.join(src, 'late.js'), 'utf8'),
        'export const one = 1;\nexport const two = 2;\n',
        'the source keeps its pending work',
      );
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  test('the pending edit merges where the destination committed its own change nearby', async () => {
    const root = makeRepo('div-context');
    fs.writeFileSync(path.join(root, 'long.txt'), EIGHT);
    git(root, ['add', 'long.txt']);
    git(root, ['commit', '-m', 'long.txt on main']);
    const src = addWorktree(root, 'feat/div-ctx-src');
    const dest = addWorktree(root, 'feat/div-ctx-dest');
    try {
      // Destination-only COMMITTED work on line 5 ...
      fs.writeFileSync(path.join(dest, 'long.txt'), 'l1\nl2\nl3\nl4\nDEST-L5\nl6\nl7\nl8\n');
      git(dest, ['commit', '-am', 'destination: line 5']);
      // ... while the source's PENDING hunk sits on line 8, three context
      // lines away: the raw patch no longer matches, a three-way merge does.
      fs.writeFileSync(path.join(src, 'long.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nSRC-L8-PENDING\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied, ['long.txt']);
      assert.equal(
        fs.readFileSync(path.join(dest, 'long.txt'), 'utf8'),
        'l1\nl2\nl3\nl4\nDEST-L5\nl6\nl7\nSRC-L8-PENDING\n',
        "the destination's own line and the source's pending edit both survive",
      );
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\ntwo\n', 'unselected files stay clean');
      assert.equal(git(dest, ['diff', '--cached', '--name-only']).trim(), '', 'the destination index stays untouched');
      assert.equal(git(src, ['diff', '--cached', '--name-only']).trim(), '', 'the source index stays untouched');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  test('a real conflict refuses the whole selection and mutates nothing', async () => {
    const root = makeRepo('div-conflict');
    fs.writeFileSync(path.join(root, 'long.txt'), EIGHT);
    git(root, ['add', 'long.txt']);
    git(root, ['commit', '-m', 'long.txt on main']);
    const src = addWorktree(root, 'feat/div-conf-src');
    const dest = addWorktree(root, 'feat/div-conf-dest');
    try {
      // Both sides rework the SAME line, so no automatic answer exists.
      fs.writeFileSync(path.join(dest, 'long.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nDEST-L8\n');
      git(dest, ['commit', '-am', 'destination: line 8']);
      fs.writeFileSync(path.join(src, 'long.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nSRC-L8-PENDING\n');
      // A second, perfectly copyable file in the same selection: it must NOT
      // land either, because a refused selection is refused whole.
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nSRC-PENDING\n');
      const destLongBefore = fs.readFileSync(path.join(dest, 'long.txt'), 'utf8');
      const destABefore = fs.readFileSync(path.join(dest, 'a.txt'), 'utf8');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a conflict is never resolved silently');
      assert.match(copied.error, /conflicts/, `the reason names the conflict: ${copied.error}`);
      assert.match(copied.error, /long\.txt/);
      // The human answer the caller cannot compose for itself: this is the
      // shared helper's own wording, and the warp command and the agent tools
      // both surface it verbatim after their own refusal checks.
      assert.match(copied.error, /resolve the conflict first/, `the error says how to get unstuck: ${copied.error}`);
      assert.match(copied.error, /warp again without copying/, `the error offers the do-not-copy retry: ${copied.error}`);
      assert.match(copied.error, /nothing was copied/);
      assert.equal(fs.readFileSync(path.join(dest, 'long.txt'), 'utf8'), destLongBefore, 'the destination keeps its own line');
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), destABefore, 'the copyable sibling never lands either');
      assert.equal(git(dest, ['status', '--porcelain']).trim(), '', 'no conflict markers, no partial write');
      assert.equal(git(dest, ['diff', '--cached', '--name-only']).trim(), '', 'the destination index stays untouched');
      assert.equal(fs.readFileSync(path.join(src, 'long.txt'), 'utf8'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nSRC-L8-PENDING\n', 'the source keeps its work');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  test('a path the destination branch removed is refused, never resurrected', async () => {
    const root = makeRepo('div-dest-removed');
    const src = addWorktree(root, 'feat/div-rm-src');
    const dest = addWorktree(root, 'feat/div-rm-dest');
    try {
      fs.rmSync(path.join(dest, 'b.txt'));
      git(dest, ['commit', '-am', 'destination drops b.txt']);
      fs.writeFileSync(path.join(src, 'b.txt'), 'alpha\nBETA-PENDING\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a file the other side deleted is not silently restored');
      assert.match(copied.error, /b\.txt/);
      assert.match(copied.error, /nothing was copied/);
      assert.match(copied.error, /resolve the conflict first/, `the refusal also says how to get unstuck: ${copied.error}`);
      assert.match(copied.error, /warp again without copying/, `the refusal offers the do-not-copy retry: ${copied.error}`);
      assert.equal(fs.existsSync(path.join(dest, 'b.txt')), false, "the destination's deletion survives");
      assert.equal(git(dest, ['status', '--porcelain']).trim(), '', 'the destination is untouched');
      assert.equal(fs.readFileSync(path.join(src, 'b.txt'), 'utf8'), 'alpha\nBETA-PENDING\n', 'the source keeps its edit');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  test('a destination symbolic link at a selected path is refused, never written through', async () => {
    const root = makeRepo('div-symlink');
    const src = addWorktree(root, 'feat/div-lnk-src');
    const dest = addWorktree(root, 'feat/div-lnk-dest');
    try {
      // The destination's a.txt is a symlink pointing at another checkout's
      // file, and its target still holds the source base byte for byte, so the
      // destination reports no change on that path. Writing the pending edit
      // there would follow the link out of the checkout.
      const victim = path.join(root, 'victim.txt');
      fs.writeFileSync(victim, 'one\ntwo\n');
      fs.unlinkSync(path.join(dest, 'a.txt'));
      fs.symlinkSync(victim, path.join(dest, 'a.txt'));
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO-PENDING\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['a.txt'] });
      assert.equal(copied.ok, false, 'a link at the destination path is never followed');
      assert.match(copied.error, /symbolic link/);
      assert.match(copied.error, /nothing was copied/);
      assert.equal(fs.readFileSync(victim, 'utf8'), 'one\ntwo\n', 'the link target outside the destination is untouched');
      assert.equal(fs.lstatSync(path.join(dest, 'a.txt')).isSymbolicLink(), true, 'the destination link survives');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // Content that does not survive a UTF-8 roundtrip must never be rewritten,
  // and content that does must never be rewritten either: the merge output is
  // read back from disk as BYTES, and the base is only used when git can prove
  // it reproduces the recorded blob exactly.
  test('a non-UTF-8 base is refused instead of being rewritten with replacement characters', async () => {
    const root = makeRepo('merge-latin1');
    const latin = (lines) => Buffer.from(`${lines.join('\n')}\n`, 'latin1'); // 0xE9, never a NUL byte
    const baseLines = ['latin-1', 'caf\u00e9-line', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
    fs.writeFileSync(path.join(root, 'bin.txt'), latin(baseLines));
    git(root, ['add', 'bin.txt']);
    git(root, ['commit', '-m', 'latin-1 file on main']);
    const src = addWorktree(root, 'feat/div-l1-src');
    const dest = addWorktree(root, 'feat/div-l1-dest');
    try {
      // Destination-only COMMITTED edit at L5; the source's pending edit is at
      // L8, whose hunk context covers L5, so the raw patch cannot apply.
      fs.writeFileSync(path.join(dest, 'bin.txt'), latin([...baseLines.slice(0, 4), 'DEST-L5', ...baseLines.slice(5)]));
      git(dest, ['commit', '-am', 'destination: L5']);
      fs.writeFileSync(path.join(src, 'bin.txt'), latin([...baseLines.slice(0, 7), 'SRC-L8-PENDING']));
      const destBefore = fs.readFileSync(path.join(dest, 'bin.txt'));

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a base that is not plain UTF-8 text is never merged');
      assert.match(copied.error, /UTF-8/, `the reason names the encoding limit: ${copied.error}`);
      assert.match(copied.error, /warp again without copying/, 'the refusal still says how to get unstuck');
      assert.match(copied.error, /nothing was copied/);
      const destAfter = fs.readFileSync(path.join(dest, 'bin.txt'));
      assert.deepEqual(destAfter, destBefore, "the destination keeps its own bytes, its own line included");
      assert.equal(
        destAfter.includes(Buffer.from([0xef, 0xbf, 0xbd])),
        false,
        'no replacement characters were written anywhere',
      );
      assert.equal(git(dest, ['status', '--porcelain']).trim(), '', 'the destination worktree and index are untouched');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // PRESERVE (byte fidelity): a UTF-8 file merges byte for byte, multi-byte
  // characters included, and the destination's own line survives — the result
  // is never "the source's file".
  test('a UTF-8 merge keeps every byte and the destination edit', async () => {
    const root = makeRepo('merge-utf8');
    const text = (lines) => Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    const baseLines = ['caf\u00e9 \u65e5\u672c\u8a9e', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
    fs.writeFileSync(path.join(root, 'u.txt'), text(baseLines));
    git(root, ['add', 'u.txt']);
    git(root, ['commit', '-m', 'utf-8 file on main']);
    const src = addWorktree(root, 'feat/div-u8-src');
    const dest = addWorktree(root, 'feat/div-u8-dest');
    try {
      fs.writeFileSync(path.join(dest, 'u.txt'), text([...baseLines.slice(0, 4), 'DEST-L5', ...baseLines.slice(5)]));
      git(dest, ['commit', '-am', 'destination: L5']);
      fs.writeFileSync(path.join(src, 'u.txt'), text([...baseLines.slice(0, 7), 'SRC-L8-PENDING']));

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(
        fs.readFileSync(path.join(dest, 'u.txt')),
        text([...baseLines.slice(0, 4), 'DEST-L5', ...baseLines.slice(5, 7), 'SRC-L8-PENDING']),
        "the destination's own line and the pending edit are both there, byte for byte",
      );
      assert.equal(git(dest, ['diff', '--cached', '--name-only']).trim(), '', 'the destination index stays untouched');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // The destination's own pending work is refused by the overlap preflight, but
  // an UNTRACKED destination entry that git cannot see as a change (a dangling
  // symlink) must never be written through: `copyFileSync` would follow it out
  // of the checkout.
  test('an untracked copy never writes through a dangling symlink in the destination', async () => {
    const root = makeRepo('dangling-link');
    const src = addWorktree(root, 'feat/div-dg-src');
    const dest = addWorktree(root, 'feat/div-dg-dest');
    try {
      fs.writeFileSync(path.join(src, 'new.txt'), 'fresh\ncontent\n');
      const outside = path.join(root, 'outside.txt'); // does not exist yet
      fs.symlinkSync(outside, path.join(dest, 'new.txt'));

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a dangling link at the destination path is refused');
      assert.match(copied.error, /symbolic link/);
      assert.match(copied.error, /nothing was copied/);
      assert.equal(fs.existsSync(outside), false, 'nothing was written outside the destination checkout');
      assert.equal(fs.lstatSync(path.join(dest, 'new.txt')).isSymbolicLink(), true, 'the destination link survives');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // An unreadable selected file is not a deletion: reporting it as one would
  // tell the human the source deleted a file it still has.
  test('an unreadable selected file is reported as unreadable, never as a deletion', async () => {
    const root = makeRepo('unreadable-src');
    const src = addWorktree(root, 'feat/div-un-src');
    const dest = addWorktree(root, 'feat/div-un-dest');
    try {
      fs.writeFileSync(path.join(dest, 'a.txt'), 'one\nDEST\n');
      git(dest, ['commit', '-am', 'destination: diverged']);
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nSRC-PENDING\n');
      const srcFile = fs.realpathSync(path.join(src, 'a.txt'));
      const poisoned = {
        ...fs,
        readFileSync(target, ...rest) {
          if (path.resolve(String(target)) === srcFile) {
            const err = new Error(`EACCES: permission denied, open '${target}'`);
            err.code = 'EACCES';
            throw err;
          }
          return fs.readFileSync(target, ...rest);
        },
      };

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' }, { fs: poisoned });
      assert.equal(copied.ok, false);
      assert.match(copied.error, /cannot be read/, `the reason is the unreadable file: ${copied.error}`);
      assert.doesNotMatch(copied.error, /deletes/, `an unreadable file is never called a deletion: ${copied.error}`);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\nDEST\n', "the destination's own line survives");
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // PRESERVE: creating the missing directories level by level must still build
  // an ordinary nested path — the guard only refuses a component that already
  // escapes the checkout.
  test('PRESERVE: an untracked file in a directory the destination lacks is still created', async () => {
    const root = makeRepo('nested-create');
    const src = addWorktree(root, 'feat/div-nc-src');
    const dest = addWorktree(root, 'feat/div-nc-dest');
    try {
      fs.mkdirSync(path.join(src, 'deep/nested'), { recursive: true });
      fs.writeFileSync(path.join(src, 'deep/nested/new.txt'), 'fresh\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.equal(fs.readFileSync(path.join(dest, 'deep/nested/new.txt'), 'utf8'), 'fresh\n');
      assert.equal(fs.lstatSync(path.join(dest, 'deep')).isSymbolicLink(), false, 'a real directory was created');
      assert.equal(fs.lstatSync(path.join(dest, 'deep/nested')).isDirectory(), true);
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // A path is only safe to write when every component between the destination
  // checkout and the target is a real directory INSIDE that checkout: a
  // symlinked parent would carry the write out of the worktree, and the file's
  // own lstat cannot see it.
  test('an untracked copy never writes through a symlinked parent directory', async () => {
    const root = makeRepo('link-parent-untracked');
    const src = addWorktree(root, 'feat/div-lpu-src');
    const dest = addWorktree(root, 'feat/div-lpu-dest');
    const outside = trackOutsideDir('link-parent-untracked');
    try {
      fs.mkdirSync(path.join(src, 'sub'));
      fs.writeFileSync(path.join(src, 'sub/new.txt'), 'fresh\ncontent\n');
      fs.symlinkSync(outside, path.join(dest, 'sub'));

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a symlinked parent at the destination is refused');
      assert.match(copied.error, /symbolic link/);
      assert.match(copied.error, /nothing was copied/);
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the destination checkout');
      assert.equal(fs.lstatSync(path.join(dest, 'sub')).isSymbolicLink(), true, 'the destination link survives');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  test('a created tracked file never writes through a symlinked parent directory', async () => {
    const root = makeRepo('link-parent-create');
    const src = addWorktree(root, 'feat/div-lpc-src');
    const dest = addWorktree(root, 'feat/div-lpc-dest');
    const outside = trackOutsideDir('link-parent-create');
    try {
      // The file is new on the source branch, so the destination (built from
      // main) gets it as a create — and its parent there is a link out.
      fs.mkdirSync(path.join(src, 'pkg'));
      fs.writeFileSync(path.join(src, 'pkg/late.js'), 'export const a = 1;\n');
      git(src, ['add', 'pkg/late.js']);
      git(src, ['commit', '-m', 'source branch adds pkg/late.js']);
      fs.writeFileSync(path.join(src, 'pkg/late.js'), 'export const a = 1;\nexport const b = 2;\n');
      fs.symlinkSync(outside, path.join(dest, 'pkg'));

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a symlinked parent at the destination is refused');
      assert.match(copied.error, /symbolic link/);
      assert.match(copied.error, /nothing was copied/);
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the destination checkout');
      assert.equal(fs.lstatSync(path.join(dest, 'pkg')).isSymbolicLink(), true, 'the destination link survives');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // The same escape through a LOCATION a link cannot cover, because it does not
  // exist yet: `mkdir -p` under a link would create the directory outside.
  test('a new nested directory is never created through a symlinked parent', async () => {
    const root = makeRepo('link-parent-nested');
    const src = addWorktree(root, 'feat/div-lpn-src');
    const dest = addWorktree(root, 'feat/div-lpn-dest');
    const outside = trackOutsideDir('link-parent-nested');
    try {
      fs.mkdirSync(path.join(src, 'deep/nested'), { recursive: true });
      fs.writeFileSync(path.join(src, 'deep/nested/new.txt'), 'fresh\n');
      fs.symlinkSync(outside, path.join(dest, 'deep'));

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false, 'a symlinked ancestor is refused before anything is created');
      assert.match(copied.error, /symbolic link/);
      assert.deepEqual(fs.readdirSync(outside), [], 'no directory and no file were created outside');
      assert.equal(fs.existsSync(path.join(dest, 'deep/nested')), false, 'no directory was created through the link');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // PRESERVE: the ordinary case — the destination still holds the source's own
  // base — keeps copying exactly as before, modes and indexes included. This is
  // the behaviour the divergent-base work must not disturb.
  test('PRESERVE: an identical base still carries staged content, the unstaged sibling and the mode', async () => {
    const root = makeRepo('div-preserve');
    const src = addWorktree(root, 'feat/div-pre-src');
    const dest = addWorktree(root, 'feat/div-pre-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nSTAGED\n');
      fs.chmodSync(path.join(src, 'a.txt'), 0o755);
      git(src, ['add', 'a.txt']);
      fs.writeFileSync(path.join(src, 'b.txt'), 'alpha\nUNSTAGED\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied.sort(), ['a.txt', 'b.txt']);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\nSTAGED\n');
      assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'alpha\nUNSTAGED\n');
      assert.notEqual(fs.statSync(path.join(dest, 'a.txt')).mode & 0o111, 0, 'the pending executable bit travels');
      assert.equal(git(dest, ['diff', '--cached', '--name-only']).trim(), '', 'the destination index stays untouched');
      assert.equal(git(src, ['diff', '--cached', '--name-only']).trim(), 'a.txt', 'the source keeps its staged entry');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });
});

// ---------------------------------------------------------------------------
// Three failure shapes the divergent-base work left behind:
//   * a POSIX file name may legally contain a backslash, so splitting a path on
//     BOTH separators invents a directory component the selection never named
//     and leaves the file one level too deep;
//   * an apply-time failure can strike AFTER an earlier plan already landed, so
//     "nothing was copied" is then false and must not be printed;
//   * an lstat that fails for a reason other than "nothing is there" says
//     nothing about deletion, and must never be read as one.
describe('copyChanges: path spelling, partial-copy reporting and deletion diagnosis', { concurrency: false }, () => {
  function removeWorktrees(root, ...checkouts) {
    for (const checkout of checkouts) {
      git(root, ['worktree', 'remove', '--force', checkout]);
    }
  }

  // A backslash is a separator on Windows ONLY. On POSIX it is an ordinary
  // character inside a file name, so the copy must treat `back\slash.txt` as
  // ONE component: no stray directory, and the file at the top level.
  test('a POSIX file name containing a backslash stays one component, with no stray directory', async (t) => {
    if (path.sep !== '/') return t.skip('POSIX-only: on Windows a backslash IS a path separator');
    const root = makeRepo('backslash-name');
    const src = addWorktree(root, 'feat/bs-src');
    const dest = addWorktree(root, 'feat/bs-dest');
    const weird = 'back\\slash.txt';
    try {
      fs.writeFileSync(path.join(src, weird), 'root-backslash\n');
      fs.mkdirSync(path.join(src, 'nested'));
      fs.writeFileSync(path.join(src, 'nested', weird), 'nested-backslash\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied.sort(), [weird, `nested/${weird}`].sort());

      assert.equal(
        fs.readFileSync(path.join(dest, weird), 'utf8'),
        'root-backslash\n',
        'the file keeps its own name, backslash included',
      );
      assert.equal(
        fs.existsSync(path.join(dest, 'back')),
        false,
        'a backslash inside a file name never becomes a directory',
      );
      assert.deepEqual(
        fs.readdirSync(dest).filter((name) => name !== '.git').sort(),
        ['a.txt', 'b.txt', 'nested', weird].sort(),
        'the destination holds exactly the selection plus its own files',
      );
      assert.deepEqual(fs.readdirSync(path.join(dest, 'nested')), [weird], 'the created directory holds the file itself');
      assert.equal(
        fs.existsSync(path.join(dest, 'nested', 'back')),
        false,
        'no stray directory inside the created directory either',
      );
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // PRESERVE (platform separator): an ordinary slash-separated path still
  // creates its missing directories level by level.
  test('PRESERVE: a slash-separated untracked path still creates one real directory level', async () => {
    const root = makeRepo('slash-levels');
    const src = addWorktree(root, 'feat/sl-src');
    const dest = addWorktree(root, 'feat/sl-dest');
    try {
      fs.mkdirSync(path.join(src, 'one/two'), { recursive: true });
      fs.writeFileSync(path.join(src, 'one/two/three.txt'), 'deep\n');

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.equal(fs.readFileSync(path.join(dest, 'one/two/three.txt'), 'utf8'), 'deep\n');
      assert.equal(fs.lstatSync(path.join(dest, 'one')).isDirectory(), true);
      assert.equal(fs.lstatSync(path.join(dest, 'one/two')).isDirectory(), true);
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // An apply-time failure can land after a plan already succeeded. The report
  // must name what is actually on disk; "nothing was copied" would be a claim
  // the human cannot verify and that is simply false.
  test('an apply-time failure names the files that already landed', async () => {
    const root = makeRepo('partial-copy');
    const src = addWorktree(root, 'feat/pc-src');
    const dest = addWorktree(root, 'feat/pc-dest');
    const blockedDir = path.resolve(path.join(dest, 'blocked'));
    try {
      fs.writeFileSync(path.join(src, 'a-first.txt'), 'first\n');
      fs.mkdirSync(path.join(src, 'blocked'));
      fs.writeFileSync(path.join(src, 'blocked/second.txt'), 'second\n');
      // The first copy lands; creating the second one's directory fails at
      // apply time (a plan may not create anything, so this is only visible
      // once the writes begin).
      const poisoned = {
        ...fs,
        mkdirSync(target, ...rest) {
          if (path.resolve(String(target)) === blockedDir) {
            const err = new Error(`EACCES: permission denied, mkdir '${target}'`);
            err.code = 'EACCES';
            throw err;
          }
          return fs.mkdirSync(target, ...rest);
        },
      };

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' }, { fs: poisoned });
      assert.equal(copied.ok, false, 'the copy is reported as failed');
      assert.doesNotMatch(
        copied.error,
        /nothing was copied/,
        `a copy that landed one file never claims nothing was copied: ${copied.error}`,
      );
      assert.match(copied.error, /1 of 2 files already copied/, `the report counts what landed: ${copied.error}`);
      assert.match(copied.error, /"a-first\.txt"/, `the report names what landed: ${copied.error}`);
      assert.match(copied.error, /the rest were not copied/, `the report says the rest did not land: ${copied.error}`);
      assert.match(copied.error, /inspect the destination before retrying/, 'the human is told to look before retrying');

      // The report matches the disk: that is the whole point.
      assert.equal(fs.readFileSync(path.join(dest, 'a-first.txt'), 'utf8'), 'first\n', 'the first file really did land');
      assert.equal(fs.existsSync(path.join(dest, 'blocked')), false, 'the second file did not land');
      assert.equal(fs.existsSync(path.join(dest, 'blocked/second.txt')), false);
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // A tracked entry whose metadata cannot be inspected says nothing about
  // whether the file is there: it is a refusal, never a deletion (treating it
  // as one would silently drop the file from the copy).
  test('a source entry that cannot be inspected is refused, never treated as a deletion', async () => {
    const root = makeRepo('uninspectable-src');
    const src = addWorktree(root, 'feat/ui-src');
    const dest = addWorktree(root, 'feat/ui-dest');
    const srcFile = path.resolve(path.join(src, 'a.txt'));
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nSRC-PENDING\n');
      const poisoned = {
        ...fs,
        lstatSync(target, ...rest) {
          if (path.resolve(String(target)) === srcFile) {
            const err = new Error(`EACCES: permission denied, lstat '${target}'`);
            err.code = 'EACCES';
            throw err;
          }
          return fs.lstatSync(target, ...rest);
        },
      };

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' }, { fs: poisoned });
      assert.equal(copied.ok, false, 'an entry that cannot be inspected is not copied blindly');
      assert.match(copied.error, /could not be inspected/, `the reason is the inspection failure: ${copied.error}`);
      assert.match(copied.error, /never treated as a deletion/, `it is not diagnosed as a deletion: ${copied.error}`);
      assert.match(copied.error, /nothing was copied/, 'nothing was written');
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the destination is untouched');
      assert.equal(fs.readFileSync(path.join(src, 'a.txt'), 'utf8'), 'one\nSRC-PENDING\n', 'the source keeps its edit');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // The mirror case: a path with nothing behind it is GONE (a deletion), and
  // calling it unreadable would describe a file the source no longer has.
  test('a source file that vanished is reported as gone, not as unreadable', async () => {
    const root = makeRepo('vanished-src');
    const src = addWorktree(root, 'feat/vn-src');
    const dest = addWorktree(root, 'feat/vn-dest');
    const srcFile = path.resolve(path.join(src, 'new.txt'));
    try {
      fs.writeFileSync(path.join(src, 'new.txt'), 'fresh\n');
      const poisoned = {
        ...fs,
        lstatSync(target, ...rest) {
          if (path.resolve(String(target)) === srcFile) {
            const err = new Error(`ENOENT: no such file or directory, lstat '${target}'`);
            err.code = 'ENOENT';
            throw err;
          }
          return fs.lstatSync(target, ...rest);
        },
      };

      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' }, { fs: poisoned });
      assert.equal(copied.ok, false, 'a vanished file cannot be copied');
      assert.match(copied.error, /is gone/, `the reason names the deletion: ${copied.error}`);
      assert.doesNotMatch(copied.error, /unreadable/, `a deletion is never called unreadable: ${copied.error}`);
      assert.match(copied.error, /nothing was copied/);
      assert.equal(fs.existsSync(path.join(dest, 'new.txt')), false, 'nothing was written');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });

  // PRESERVE: a real tracked deletion still travels (the ENOENT path the fix
  // keeps treating as a deletion).
  test('PRESERVE: a tracked deletion still applies to the destination', async () => {
    const root = makeRepo('deletion-preserve');
    const src = addWorktree(root, 'feat/dp-src');
    const dest = addWorktree(root, 'feat/dp-dest');
    try {
      fs.rmSync(path.join(src, 'b.txt'));
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['b.txt'] });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied, ['b.txt']);
      assert.equal(fs.existsSync(path.join(dest, 'b.txt')), false, 'the deletion travels');
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the sibling is untouched');
    } finally {
      removeWorktrees(root, src, dest);
    }
  });
});

'use strict';
// T1 (odd-rail-section S3, S4, and S5's tie rule) tests: lib/odd-scan.js — the
// ODDs this machine is working on across EVERY owned checkout.
//
// Contract under test: one row per ODD name, carrying the absolute document
// path, the absolute root and the name of the checkout that owns it (`main`, or
// the worktree's own last path segment) and the document's modification time.
// Every owned checkout is scanned (S3, main first), an ODD present in several
// checkouts is ONE row — the most recently modified document (S4) — and an exact
// mtime tie goes to the main checkout (S5). The whole list comes back most recent
// first, uncapped (the rail caps at 4, not this scan), and the function never
// throws: an absent `odd/tasks` is an empty checkout, an unreadable checkout
// contributes nothing, and a git read that cannot name the checkouts leaves the
// caller's own root as the only one.
//
// Git is the injected `runAsync` seam every neighbouring module already takes, so
// no test spawns git or touches a real worktree. The checkouts themselves are real
// directories under the system temp directory, shaped by the one rule that decides
// which checkouts are ours (invariant 10): `<root>` is the main checkout and
// `<root>-worktrees/<name>` are the owned ones.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanOddAcrossWorktrees } = require('../lib/odd-scan.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// A machine-shaped tree: the base directory, the main checkout and the one
// directory this package creates worktrees in.
function machine(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `odd-scan-${tag}-`));
  roots.push(base);
  const mainRoot = path.join(base, 'repo');
  fs.mkdirSync(mainRoot, { recursive: true });
  return {
    base,
    mainRoot,
    worktreesDir: path.join(base, 'repo-worktrees'),
    worktree: (name) => path.join(base, 'repo-worktrees', name),
    outside: (name) => path.join(base, name),
  };
}

// One ODD document, stamped so the ordering assertions never depend on how fast
// the fixture happens to be written.
function writeDoc(checkout, name, iso) {
  const dir = path.join(checkout, 'odd', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${name}.md`);
  fs.writeFileSync(target, `# ${name}\n`);
  if (iso !== undefined) setMtime(target, iso);
  return target;
}

function setMtime(target, iso) {
  const when = new Date(iso);
  fs.utimesSync(target, when, when);
}

// `git worktree list --porcelain -z` exactly as Git writes it: one
// NUL-terminated field per line, a blank field between records, main first.
function porcelain(paths) {
  return paths
    .map((target) => `worktree ${target}\0HEAD ${'0'.repeat(40)}\0branch refs/heads/main\0\0`)
    .join('');
}

// The git seam: a recording fake, so the fixed argv and cwd are asserted from
// observed calls instead of from the source.
function fakeGit(tag, paths) {
  const calls = [];
  const runAsync = async (bin, argv, cwd) => {
    calls.push({ bin, argv, cwd, tag });
    return { status: 0, stdout: porcelain(paths), stderr: '' };
  };
  return { calls, runAsync };
}

const names = (rows) => rows.map((row) => row.name);

describe('S3: every owned checkout is scanned', () => {
  test('an ODD in the main checkout and one in an owned worktree are both found', async () => {
    const box = machine('two');
    const worktree = box.worktree('odd-rail');
    const mainDoc = writeDoc(box.mainRoot, 'main-odd', '2020-01-01T00:00:00.000Z');
    const worktreeDoc = writeDoc(worktree, 'rail-odd', '2020-02-01T00:00:00.000Z');
    const git = fakeGit('two', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(rows, [
      {
        name: 'rail-odd',
        docPath: worktreeDoc,
        checkoutRoot: worktree,
        checkoutName: 'odd-rail',
        mtimeMs: Date.parse('2020-02-01T00:00:00.000Z'),
      },
      {
        name: 'main-odd',
        docPath: mainDoc,
        checkoutRoot: box.mainRoot,
        checkoutName: 'main',
        mtimeMs: Date.parse('2020-01-01T00:00:00.000Z'),
      },
    ]);
  });

  test('a worktree outside the owned directory is not scanned', async () => {
    const box = machine('outside');
    const outside = box.outside('somewhere-else');
    writeDoc(box.mainRoot, 'mine', '2020-01-01T00:00:00.000Z');
    writeDoc(outside, 'not-mine', '2020-03-01T00:00:00.000Z');
    const git = fakeGit('outside', [box.mainRoot, outside]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(names(rows), ['mine']);
  });

  test('the git read is one fixed-argv `git worktree list` in the given root', async () => {
    const box = machine('argv');
    writeDoc(box.mainRoot, 'one', '2020-01-01T00:00:00.000Z');
    const worktree = box.worktree('odd-a');
    writeDoc(worktree, 'two', '2020-02-01T00:00:00.000Z');
    const git = fakeGit('argv', [box.mainRoot, worktree]);

    await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(git.calls.length, 1, 'one listing read, never one per checkout');
    assert.equal(git.calls[0].bin, 'git');
    assert.deepEqual(git.calls[0].argv, [
      '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain', '-z',
    ]);
    assert.equal(git.calls[0].cwd, box.mainRoot);
  });

  test('only `odd/tasks/*.md` counts: not nested, not a dotfile', async () => {
    const box = machine('scan');
    writeDoc(box.mainRoot, 'real', '2020-01-01T00:00:00.000Z');
    writeDoc(path.join(box.mainRoot, 'odd', 'tasks', 'nested'), 'deep', '2020-02-01T00:00:00.000Z');
    writeDoc(box.mainRoot, '.hidden', '2020-03-01T00:00:00.000Z');
    fs.writeFileSync(path.join(box.mainRoot, 'odd', 'tasks', 'notes.txt'), 'not a document\n');
    const git = fakeGit('scan', [box.mainRoot]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(names(rows), ['real']);
  });

  test('the list is not capped here: more than four ODDs all come back', async () => {
    const box = machine('uncapped');
    const ins = [
      '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', '2020-03-01T00:00:00.000Z',
      '2020-04-01T00:00:00.000Z', '2020-05-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z',
    ];
    for (const [index, iso] of ins.entries()) writeDoc(box.mainRoot, `odd-${index}`, iso);
    const git = fakeGit('uncapped', [box.mainRoot]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(rows.length, 6);
    assert.deepEqual(names(rows), ['odd-5', 'odd-4', 'odd-3', 'odd-2', 'odd-1', 'odd-0']);
  });
});

describe('S4: the most recently modified copy wins', () => {
  test('a newer copy in a worktree replaces the main one', async () => {
    const box = machine('newer-wt');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'shared', '2020-01-01T00:00:00.000Z');
    const newest = writeDoc(worktree, 'shared', '2020-05-01T00:00:00.000Z');
    const git = fakeGit('newer-wt', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(rows.length, 1, 'one row per ODD name');
    assert.equal(rows[0].checkoutName, 'odd-rail');
    assert.equal(rows[0].docPath, newest);
    assert.equal(rows[0].mtimeMs, Date.parse('2020-05-01T00:00:00.000Z'));
  });

  test('a newer copy in the main checkout keeps the main one', async () => {
    const box = machine('newer-main');
    const worktree = box.worktree('odd-rail');
    writeDoc(worktree, 'shared', '2020-01-01T00:00:00.000Z');
    const newest = writeDoc(box.mainRoot, 'shared', '2020-05-01T00:00:00.000Z');
    const git = fakeGit('newer-main', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkoutName, 'main');
    assert.equal(rows[0].docPath, newest);
  });

  test('two worktrees holding the same ODD keep only the newer one', async () => {
    const box = machine('newer-both');
    const older = box.worktree('odd-a');
    const newer = box.worktree('odd-b');
    writeDoc(older, 'shared', '2020-01-01T00:00:00.000Z');
    writeDoc(newer, 'shared', '2020-04-01T00:00:00.000Z');
    const git = fakeGit('newer-both', [box.mainRoot, older, newer]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkoutName, 'odd-b');
  });
});

describe('S5: an exact mtime tie goes to main', () => {
  test('equally recent copies report the main checkout', async () => {
    const box = machine('tie');
    const worktree = box.worktree('odd-rail');
    const stamp = '2020-03-01T00:00:00.000Z';
    const mainDoc = writeDoc(box.mainRoot, 'shared', stamp);
    writeDoc(worktree, 'shared', stamp);
    const git = fakeGit('tie', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkoutName, 'main');
    assert.equal(rows[0].checkoutRoot, box.mainRoot);
    assert.equal(rows[0].docPath, mainDoc);
  });

  test('the tie rule holds even when the worktree copy is as recent as they come', async () => {
    const box = machine('tie-late');
    const worktree = box.worktree('odd-a');
    const stamp = '2020-03-01T00:00:00.000Z';
    writeDoc(box.mainRoot, 'shared', stamp);
    writeDoc(worktree, 'shared', stamp);
    const git = fakeGit('tie-late', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkoutName, 'main');
  });
});

describe('the main checkout', () => {
  test('is the checkout git lists first, and its row is named main', async () => {
    // `git worktree list` documents the main worktree first; that entry is the
    // main row here exactly as it is in lib/worktree-list.js.
    const box = machine('first');
    const listed = box.outside('listed-first');
    writeDoc(box.mainRoot, 'mine', '2020-01-01T00:00:00.000Z');
    writeDoc(listed, 'theirs', '2020-02-01T00:00:00.000Z');
    const git = fakeGit('first', [listed, box.mainRoot]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(names(rows), ['theirs']);
    assert.equal(rows[0].checkoutName, 'main');
    assert.equal(rows[0].checkoutRoot, listed);
  });
});

describe('order', () => {
  test('most recent first, then by name, and the order never depends on the scan', async () => {
    const box = machine('order');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'b', '2020-03-01T00:00:00.000Z');
    writeDoc(box.mainRoot, 'a', '2020-01-01T00:00:00.000Z');
    writeDoc(worktree, 'd', '2020-03-01T00:00:00.000Z');
    writeDoc(worktree, 'c', '2020-02-01T00:00:00.000Z');
    const git = fakeGit('order', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    // b and d share a timestamp: the name decides, in code-unit order.
    assert.deepEqual(names(rows), ['b', 'd', 'c', 'a']);
  });
});

describe('fail closed, never throw', () => {
  test('a machine with no ODD anywhere answers an empty list', async () => {
    const box = machine('empty');
    const worktree = box.worktree('odd-rail');
    fs.mkdirSync(worktree, { recursive: true });
    const git = fakeGit('empty', [box.mainRoot, worktree]);

    assert.deepEqual(await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync }), []);
  });

  test('a checkout without odd/tasks contributes nothing while the others still list', async () => {
    const box = machine('absent');
    const worktree = box.worktree('odd-rail');
    fs.mkdirSync(worktree, { recursive: true });
    writeDoc(box.mainRoot, 'only', '2020-01-01T00:00:00.000Z');
    const git = fakeGit('absent', [box.mainRoot, worktree]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(names(rows), ['only']);
  });

  test('an unreadable checkout contributes nothing and never fails the scan', async () => {
    const box = machine('unreadable');
    const gone = box.worktree('odd-gone');
    const present = box.worktree('odd-here');
    writeDoc(present, 'here', '2020-01-01T00:00:00.000Z');
    const git = fakeGit('unreadable', [box.mainRoot, gone, present]);

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(names(rows), ['here']);
    assert.equal(rows[0].checkoutName, 'odd-here');
  });

  test('a failing git read leaves the caller root as the only checkout', async () => {
    const box = machine('git-fails');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'mine', '2020-01-01T00:00:00.000Z');
    writeDoc(worktree, 'theirs', '2020-02-01T00:00:00.000Z');
    const runAsync = async () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync });

    assert.deepEqual(names(rows), ['mine']);
    assert.equal(rows[0].checkoutName, 'main');
  });

  test('a git seam that throws is the same silence', async () => {
    const box = machine('git-throws');
    writeDoc(box.mainRoot, 'mine', '2020-01-01T00:00:00.000Z');
    const runAsync = async () => {
      throw new Error('spawn failed');
    };

    const rows = await scanOddAcrossWorktrees({ repoRoot: box.mainRoot, runAsync });

    assert.deepEqual(names(rows), ['mine']);
  });

  test('a repo root that is not a usable path answers an empty list', async () => {
    const git = fakeGit('no-root', []);
    assert.deepEqual(await scanOddAcrossWorktrees({ repoRoot: '', runAsync: git.runAsync }), []);
    assert.deepEqual(await scanOddAcrossWorktrees({ repoRoot: 42, runAsync: git.runAsync }), []);
    assert.deepEqual(await scanOddAcrossWorktrees({}), []);
    assert.equal(git.calls.length, 0, 'no git read without a root to read');
  });
});

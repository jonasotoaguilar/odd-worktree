'use strict';
// T7 (odd-rail-section S10) tests: lib/odd-group.js — the grouped model the ODD
// panel draws, one group per checkout.
//
// Contract under test: an Array of groups, the MAIN checkout first (named `main`,
// `isMain: true`) carrying EVERY document of its `odd/tasks` with no `status`
// field, then one group per OWNED worktree (invariant 10: a worktree is a path,
// not a document) named by the last segment of that path, carrying ONLY the
// documents that are new or modified relative to main.
//
// "New or modified" is two comparisons, both required: the candidate set is what
// the worktree's branch changed relative to the MERGE BASE with main (`git
// merge-base HEAD <mainHead>`, then a name-status diff against that base), so a
// change that is already COMMITTED still counts where a plain working-tree diff
// would find nothing; and a document whose BYTES equal main's current copy is
// dropped even when that first comparison names it — the "main advanced, the
// worktree's copy is byte-identical" case. `status` is `added` when main has no
// document at that path and `modified` otherwise.
//
// Git is the injected `runAsync` seam every neighbouring module already takes, so
// no test spawns git or touches a real worktree: the fake answers `worktree list`,
// `rev-parse HEAD`, `merge-base`, `diff --name-status` and `status`, and the
// assertions read the observed argv instead of the source. The checkouts are real
// directories under the system temp directory, shaped by the one rule that decides
// which worktrees are ours: `<root>` is the main checkout and
// `<root>-worktrees/<name>` are the owned ones.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { groupOddDocs } = require('../lib/odd-group.js');

const MAIN_HEAD = 'a'.repeat(40);
const MERGE_BASE = 'b'.repeat(40);

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// A machine-shaped tree: the base directory, the main checkout and the one
// directory this package creates worktrees in.
function machine(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `odd-group-${tag}-`));
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

// One ODD document with EXACT bytes: the content comparison is the point of the
// module, so no fixture may carry a stray newline it did not ask for.
function writeDoc(checkout, name, { body = `# ${name}\n`, at } = {}) {
  const dir = path.join(checkout, 'odd', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${name}.md`);
  fs.writeFileSync(target, body);
  if (at !== undefined) setMtime(target, at);
  return target;
}

function setMtime(target, iso) {
  const when = new Date(iso);
  fs.utimesSync(target, when, when);
}

const mtimeOf = (target) => fs.statSync(target).mtimeMs;

// `git worktree list --porcelain -z` exactly as Git writes it: one NUL-terminated
// field per line, a blank field between records, main first.
function porcelain(paths) {
  return paths
    .map((target) => `worktree ${target}\0HEAD ${'0'.repeat(40)}\0branch refs/heads/main\0\0`)
    .join('');
}

// `--name-status -z`: `<letter>\0<path>\0` per record.
const nameStatus = (records) => records.map(([letter, rel]) => `${letter}\0${rel}\0`).join('');

// `status --porcelain=v1 -z`: `<XY> <path>\0` per record.
const statusOutput = (records) => records.map((entry) => `${entry}\0`).join('');

// The git seam: a recording fake answering every read this module makes, per
// checkout, so the fixed argv and the cwd are asserted from observed calls.
function stripConfig(argv) {
  const args = [...argv];
  while (args.length > 1 && args[0] === '-c') args.splice(0, 2);
  return args;
}

// Flags that come before the verb of a read, so the fake answers the verb the
// module actually asked for instead of the last option.
const OPTION_PREFIXES = new Set(['--no-optional-locks']);

function primaryOf(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c') {
      index += 1;
      continue;
    }
    if (OPTION_PREFIXES.has(args[index])) continue;
    return args[index];
  }
  return '';
}

function fakeGit(options = {}) {
  const calls = [];
  const deltas = new Map();
  const statuses = new Map();
  const failing = new Set(options.fail || []);
  const runAsync = async (bin, argv, cwd) => {
    calls.push({ bin, argv: [...argv], cwd });
    if (options.throws === true) throw new Error('spawn failed');
    const args = stripConfig(argv);
    const verb = primaryOf(args);
    if (failing.has(verb)) return { status: 128, stdout: '', stderr: `fatal: ${verb} failed` };
    switch (verb) {
      case 'worktree':
        return { status: 0, stdout: porcelain(options.paths || []), stderr: '' };
      case 'rev-parse':
        return { status: 0, stdout: `${options.head === undefined ? MAIN_HEAD : options.head}\n`, stderr: '' };
      case 'merge-base':
        return { status: 0, stdout: `${options.base === undefined ? MERGE_BASE : options.base}\n`, stderr: '' };
      case 'diff':
        return { status: 0, stdout: nameStatus(deltas.get(cwd) || []), stderr: '' };
      case 'status':
        return { status: 0, stdout: statusOutput(statuses.get(cwd) || []), stderr: '' };
      default:
        return { status: 1, stdout: '', stderr: `unexpected read: ${verb}` };
    }
  };
  return {
    calls,
    runAsync,
    delta: (root, records) => deltas.set(root, records),
    status: (root, records) => statuses.set(root, records),
    verbs: () => calls.map((call) => ({
      verb: primaryOf(stripConfig(call.argv)),
      args: stripConfig(call.argv),
      cwd: call.cwd,
    })),
  };
}

const contract = (group) => ({
  checkoutName: group.checkoutName,
  checkoutRoot: group.checkoutRoot,
  isMain: group.isMain,
  docs: group.docs.map((doc) => ({ name: doc.name, status: doc.status })),
});

describe('S10: the main group carries EVERY document, with no status', () => {
  test('every document of main odd/tasks is listed and none carries a status', async () => {
    const box = machine('main-all');
    const older = writeDoc(box.mainRoot, 'alpha', { at: '2020-01-01T00:00:00.000Z' });
    const newer = writeDoc(box.mainRoot, 'beta', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups, [
      {
        checkoutName: 'main',
        checkoutRoot: box.mainRoot,
        isMain: true,
        docs: [
          { name: 'beta', docPath: newer, mtimeMs: mtimeOf(newer) },
          { name: 'alpha', docPath: older, mtimeMs: mtimeOf(older) },
        ],
      },
    ]);
    assert.deepEqual(Object.keys(groups[0].docs[0]).sort(), ['docPath', 'mtimeMs', 'name']);
  });

  test('only `odd/tasks/*.md` counts: not nested, not a dotfile, not another suffix', async () => {
    const box = machine('main-rule');
    writeDoc(box.mainRoot, 'real', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(path.join(box.mainRoot, 'odd', 'tasks', 'nested'), 'deep', { at: '2020-02-01T00:00:00.000Z' });
    writeDoc(box.mainRoot, '.hidden', { at: '2020-03-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(box.mainRoot, 'odd', 'tasks', 'notes.txt'), 'not a document\n');
    const git = fakeGit({ paths: [box.mainRoot] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['real']);
  });

  test('main with no odd/tasks is a group with no documents, not a missing group', async () => {
    const box = machine('main-empty');
    const git = fakeGit({ paths: [box.mainRoot] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups, [
      { checkoutName: 'main', checkoutRoot: box.mainRoot, isMain: true, docs: [] },
    ]);
  });
});

describe('S10: a worktree carries only its delta against main', () => {
  test('only the documents git names are listed, and nothing that matches main', async () => {
    const box = machine('delta');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'alpha', { body: 'shared\n', at: '2020-01-01T00:00:00.000Z' });
    writeDoc(box.mainRoot, 'beta', { body: 'main version\n', at: '2020-01-02T00:00:00.000Z' });
    writeDoc(worktree, 'alpha', { body: 'shared\n', at: '2020-01-01T00:00:00.000Z' });
    const changed = writeDoc(worktree, 'beta', { body: 'worktree version\n', at: '2020-03-01T00:00:00.000Z' });
    const fresh = writeDoc(worktree, 'gamma', { body: '# gamma\n', at: '2020-04-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['M', 'odd/tasks/beta.md'], ['A', 'odd/tasks/gamma.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(contract(groups[1]), {
      checkoutName: 'odd-rail',
      checkoutRoot: worktree,
      isMain: false,
      docs: [
        { name: 'gamma', status: 'added' },
        { name: 'beta', status: 'modified' },
      ],
    });
    assert.deepEqual(groups[1].docs.map((doc) => doc.docPath), [fresh, changed]);
    assert.deepEqual(groups[1].docs.map((doc) => doc.mtimeMs), [mtimeOf(fresh), mtimeOf(changed)]);
    // Main still carries every one of its own documents, alpha included.
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['beta', 'alpha']);
  });

  test('added is a path main does not have; modified is a path it does', async () => {
    const box = machine('statuses');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'kept', { body: 'main\n' });
    writeDoc(worktree, 'kept', { body: 'worktree\n', at: '2020-02-01T00:00:00.000Z' });
    writeDoc(worktree, 'brand-new', { body: '# brand-new\n', at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['M', 'odd/tasks/kept.md'], ['A', 'odd/tasks/brand-new.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(contract(groups[1]).docs, [
      { name: 'kept', status: 'modified' },
      { name: 'brand-new', status: 'added' },
    ]);
  });

  test('a document git does not name is not a difference, even when its bytes differ', async () => {
    // Main moved ahead: the worktree sits at the merge base and holds the OLD
    // copy. Different bytes, but nothing of the worktree's own, so no row.
    const box = machine('unnamed');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'shared', { body: 'main advanced\n', at: '2020-05-01T00:00:00.000Z' });
    writeDoc(worktree, 'shared', { body: 'the old copy\n', at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups[1].docs, []);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['shared']);
  });

  test('a byte-identical copy is not a difference even when the merge base names it', async () => {
    // The case the user named: main advanced, and the worktree's copy of the
    // same path ends up byte-identical. The comparison against the merge base
    // still names it, so only the CONTENT comparison can drop it.
    const box = machine('identical');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'shared', { body: '# shared\n\nsame bytes\n' });
    writeDoc(worktree, 'shared', { body: '# shared\n\nsame bytes\n' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['M', 'odd/tasks/shared.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups[1].docs, []);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['shared']);
  });

  test('a committed change still counts: the diff is against the merge base, not the working tree', async () => {
    const box = machine('committed');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'spec', { body: 'before\n' });
    writeDoc(worktree, 'spec', { body: 'after\n', at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['M', 'odd/tasks/spec.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(contract(groups[1]).docs, [{ name: 'spec', status: 'modified' }]);
    // The base is resolved the way lib/worktree-changes.js resolves it: main's
    // HEAD first, then the merge base of the two, INSIDE the worktree.
    assert.deepEqual(
      git.verbs().filter((call) => call.verb === 'rev-parse').map((call) => call),
      [{ verb: 'rev-parse', args: ['rev-parse', 'HEAD'], cwd: box.mainRoot }],
    );
    assert.deepEqual(git.verbs().filter((call) => call.verb === 'merge-base'), [
      { verb: 'merge-base', args: ['merge-base', 'HEAD', MAIN_HEAD], cwd: worktree },
    ]);
    // The diff names paths against that merge base with no second revision, so
    // the comparison is the branch's own work (committed or not), never HEAD.
    assert.deepEqual(git.verbs().filter((call) => call.verb === 'diff'), [
      {
        verb: 'diff',
        args: ['diff', '--name-status', '-z', '--no-renames', MERGE_BASE, '--', 'odd/tasks'],
        cwd: worktree,
      },
    ]);
  });

  test('an untracked new document counts, as it does in the files panel', async () => {
    const box = machine('untracked');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'alpha', { body: 'shared\n' });
    writeDoc(worktree, 'alpha', { body: 'shared\n' });
    writeDoc(worktree, 'draft', { body: '# draft\n', at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.status(worktree, ['?? odd/tasks/draft.md']);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(contract(groups[1]).docs, [{ name: 'draft', status: 'added' }]);
    assert.deepEqual(
      git.verbs().filter((call) => call.verb === 'status').map((call) => call.args),
      [['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'odd/tasks']],
    );
  });

  test('a main document the worktree does not have is no worktree row at all', async () => {
    const box = machine('deleted');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'gone', { body: '# gone\n' });
    writeDoc(worktree, 'kept', { body: '# kept\n', at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['D', 'odd/tasks/gone.md'], ['A', 'odd/tasks/kept.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(contract(groups[1]).docs, [{ name: 'kept', status: 'added' }]);
  });
});

describe('S10: group order and per-group order', () => {
  test('main is first, then the owned worktrees by name; a foreign worktree is not a group', async () => {
    const box = machine('order-groups');
    const oddB = box.worktree('odd-b');
    const oddA = box.worktree('odd-a');
    const outside = box.outside('somewhere-else');
    writeDoc(box.mainRoot, 'main-odd', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddB, 'b-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddA, 'a-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(outside, 'foreign', { at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, oddB, outside, oddA] });
    git.delta(oddB, [['A', 'odd/tasks/b-doc.md']]);
    git.delta(oddA, [['A', 'odd/tasks/a-doc.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-a', 'odd-b']);
    assert.deepEqual(groups.map((group) => group.isMain), [true, false, false]);
  });

  test('within a group: most recently modified first, then by name in code-unit order', async () => {
    const box = machine('order-docs');
    const worktree = box.worktree('odd-rail');
    const stamp = '2020-03-01T00:00:00.000Z';
    writeDoc(box.mainRoot, 'b', { at: stamp });
    writeDoc(box.mainRoot, 'a', { at: stamp });
    writeDoc(box.mainRoot, 'z', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'B', { body: 'worktree B\n', at: stamp });
    writeDoc(worktree, 'a', { body: 'worktree a\n', at: stamp });
    writeDoc(worktree, 'older', { body: 'worktree older\n', at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [
      ['M', 'odd/tasks/B.md'], ['M', 'odd/tasks/a.md'], ['A', 'odd/tasks/older.md'],
    ]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    // `B` sorts before `a` by code unit, never by locale.
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['a', 'b', 'z']);
    assert.deepEqual(groups[1].docs.map((doc) => doc.name), ['B', 'a', 'older']);
  });
});

describe('fail closed, never throw', () => {
  test('an empty delta keeps the group with no documents: the caller decides not to draw it', async () => {
    const box = machine('empty-delta');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'alpha', { body: 'shared\n' });
    writeDoc(worktree, 'alpha', { body: 'shared\n' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.equal(groups.length, 2);
    assert.deepEqual(groups[1], {
      checkoutName: 'odd-rail',
      checkoutRoot: worktree,
      isMain: false,
      docs: [],
    });
  });

  test('a worktree without odd/tasks keeps its group and contributes nothing', async () => {
    const box = machine('absent-dir');
    const worktree = box.worktree('odd-rail');
    fs.mkdirSync(worktree, { recursive: true });
    writeDoc(box.mainRoot, 'mine', { at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-rail']);
    assert.deepEqual(groups[1].docs, []);
    assert.equal(git.calls.length, 1, 'no document, no git read');
  });

  test('an unreadable checkout keeps its group and contributes nothing', async () => {
    const box = machine('unreadable');
    const gone = box.worktree('odd-gone');
    const here = box.worktree('odd-here');
    writeDoc(here, 'here', { at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, gone, here] });
    git.delta(here, [['A', 'odd/tasks/here.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-gone', 'odd-here']);
    assert.deepEqual(groups[1].docs, []);
    assert.deepEqual(contract(groups[2]).docs, [{ name: 'here', status: 'added' }]);
    assert.equal(
      git.verbs().filter((call) => call.cwd === gone).length,
      0,
      'a checkout with no documents to compare is never asked about',
    );
  });

  test('a merge base that cannot be resolved empties the worktree group and never throws', async () => {
    const box = machine('no-base');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'old', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'fresh', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree], fail: ['merge-base'] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups[1].docs, []);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['old']);
  });

  test('a failing diff read or status read empties the worktree group and never throws', async () => {
    for (const verb of ['diff', 'status']) {
      const box = machine(`fail-${verb}`);
      const worktree = box.worktree('odd-rail');
      writeDoc(box.mainRoot, 'shared', { body: 'main\n' });
      writeDoc(worktree, 'shared', { body: 'worktree\n', at: '2020-02-01T00:00:00.000Z' });
      const git = fakeGit({ paths: [box.mainRoot, worktree], fail: [verb] });
      git.delta(worktree, [['M', 'odd/tasks/shared.md']]);
      git.status(worktree, [' M odd/tasks/shared.md']);

      const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

      assert.deepEqual(groups[1].docs, [], `${verb} failed, so nothing is claimed`);
      assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['shared']);
    }
  });

  test('a failing worktree listing leaves main as the only group', async () => {
    const box = machine('list-fails');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'mine', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'theirs', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree], fail: ['worktree'] });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main']);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['mine']);
  });

  test('a git seam that throws is the same silence', async () => {
    const box = machine('git-throws');
    writeDoc(box.mainRoot, 'mine', { at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot], throws: true });

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main']);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['mine']);
  });

  test('a root that is not a usable path answers no groups and reads no git', async () => {
    const git = fakeGit({ paths: [] });

    assert.deepEqual(await groupOddDocs({ repoRoot: '', runAsync: git.runAsync }), []);
    assert.deepEqual(await groupOddDocs({ repoRoot: 42, runAsync: git.runAsync }), []);
    assert.deepEqual(await groupOddDocs({}), []);
    assert.equal(git.calls.length, 0, 'no git read without a root to read');
  });
});

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
// S1-S5 (odd-dedupe): those two lists are CANDIDATES. A worktree CHAIN (a worktree
// created from another feature branch) repeats its ancestor's ODD documents, so one
// name arrives in several groups, and exactly ONE copy per name is drawn across main
// and every grouped worktree. Identity is CONTENT (sha256 of the copy's bytes, read
// only for a name that has more than one copy), an unreadable copy is UNKNOWN rather
// than identical, main wins an identical pair, and otherwise the newest copy wins —
// with the ORIGIN worktree (the grouped checkout NAMED after the ODD) winning between
// identical copies main does not have.
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
    // Main still carries every document it KEEPS: `beta` is drawn from the worktree
    // now, because its copy is the newer one (S3), so only `alpha` is left here.
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['alpha']);
  });

  test('added is a path main does not have; modified is a path it does', async () => {
    const box = machine('statuses');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'kept', { body: 'main\n', at: '2020-01-01T00:00:00.000Z' });
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
    writeDoc(box.mainRoot, 'spec', { body: 'before\n', at: '2020-01-01T00:00:00.000Z' });
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
    // The worktree's two copies are NEWER, so they are the ones drawn (S3) and the
    // code-unit tie between them is what its own order shows.
    const newer = '2020-04-01T00:00:00.000Z';
    writeDoc(box.mainRoot, 'b', { at: stamp });
    writeDoc(box.mainRoot, 'a', { at: stamp });
    writeDoc(box.mainRoot, 'z', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'B', { body: 'worktree B\n', at: newer });
    writeDoc(worktree, 'a', { body: 'worktree a\n', at: newer });
    writeDoc(worktree, 'older', { body: 'worktree older\n', at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [
      ['M', 'odd/tasks/B.md'], ['M', 'odd/tasks/a.md'], ['A', 'odd/tasks/older.md'],
    ]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    // `a` is drawn from the worktree (its copy is newer), so main keeps `b` and `z`.
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['b', 'z']);
    // `B` sorts before `a` by code unit, never by locale.
    assert.deepEqual(groups[1].docs.map((doc) => doc.name), ['B', 'a', 'older']);
  });
});

// S1-S5 (odd-dedupe): the candidate lists above can name the SAME ODD in several
// groups, because a worktree chain inherits its ancestor's documents. The panel and
// the rail draw one row per name, so the copies are ELECTED here: one per name
// across main and every grouped worktree, the losers dropped from their own group.
// Identity is the copy's own bytes; recency is the copy's own mtime; the ORIGIN is
// the grouped worktree NAMED after the ODD, which is how this package creates one.
describe('S1-S5: one ODD name is drawn once across main and every worktree', () => {
  // Every group's document names, flattened in group order: a repeat is a duplicate.
  const drawn = (groups) => groups.flatMap((group) => group.docs.map((doc) => doc.name));

  test('S1: one name is never drawn in two groups, in either scope', async () => {
    const box = machine('dedupe-s1');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'shared', { body: 'main\n', at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'shared', { body: 'worktree, newer\n', at: '2020-03-01T00:00:00.000Z' });

    for (const scope of [{ roots: [worktree] }, { all: true }]) {
      const git = fakeGit({ paths: [box.mainRoot, worktree] });
      git.delta(worktree, [['M', 'odd/tasks/shared.md']]);

      const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, ...scope });

      assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-rail']);
      assert.deepEqual(drawn(groups), ['shared'], `one copy under ${JSON.stringify(scope)}`);
    }
  });

  test('S2: an identical copy in main and a worktree is drawn only from main', async () => {
    const box = machine('dedupe-s2');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'shared', { body: '# shared\n\nthe same bytes\n' });
    writeDoc(worktree, 'shared', { body: '# shared\n\nthe same bytes\n', at: '2020-03-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['M', 'odd/tasks/shared.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['shared'], 'main keeps its own copy');
    assert.deepEqual(groups[1].docs, [], 'the identical worktree copy is not drawn');
    assert.deepEqual(drawn(groups), ['shared']);
  });

  test('S3: different content draws only the most recently modified copy', async () => {
    const box = machine('dedupe-s3');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'shared', { body: 'main, older\n', at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'shared', { body: 'worktree, newer\n', at: '2020-06-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['M', 'odd/tasks/shared.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups[0].docs, [], 'main holds the older copy, so it is not drawn');
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'shared', status: 'modified' }]);
    assert.deepEqual(drawn(groups), ['shared']);
  });

  test('S4: identical copies with no main copy keep the origin worktree', async () => {
    const box = machine('dedupe-s4');
    // `no-bridge-naming` is the worktree that created the ODD, so it is the origin;
    // `card-file` was created from its branch and inherited the document.
    const origin = box.worktree('no-bridge-naming');
    const chained = box.worktree('card-file');
    writeDoc(origin, 'no-bridge-naming', { body: '# no-bridge-naming\n', at: '2020-01-01T00:00:00.000Z' });
    writeDoc(chained, 'no-bridge-naming', { body: '# no-bridge-naming\n', at: '2020-05-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, chained, origin] });
    git.delta(origin, [['A', 'odd/tasks/no-bridge-naming.md']]);
    git.delta(chained, [['A', 'odd/tasks/no-bridge-naming.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'card-file', 'no-bridge-naming']);
    assert.deepEqual(groups[1].docs, [], 'the inheriting worktree loses the identical copy');
    assert.deepEqual(contract(groups[2]).docs, [{ name: 'no-bridge-naming', status: 'added' }]);
    assert.deepEqual(drawn(groups), ['no-bridge-naming'], 'the ORIGIN wins, not the newest copy');
  });

  test('S5: the reported chain lists each name only under the worktree that owns it', async () => {
    const box = machine('dedupe-s5');
    // The reported shape: `card-file` was created from `feat/card-message`, so it
    // inherits BOTH of the ancestor branches' ODD documents, and main has neither.
    const cardMessage = box.worktree('card-message');
    const noBridge = box.worktree('no-bridge-naming');
    const cardFile = box.worktree('card-file');
    writeDoc(cardMessage, 'card-message', { body: '# card-message\n', at: '2020-01-01T00:00:00.000Z' });
    writeDoc(noBridge, 'no-bridge-naming', { body: '# no-bridge-naming\n', at: '2020-01-02T00:00:00.000Z' });
    writeDoc(cardFile, 'card-message', { body: '# card-message\n', at: '2020-02-01T00:00:00.000Z' });
    writeDoc(cardFile, 'no-bridge-naming', { body: '# no-bridge-naming\n', at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, cardMessage, noBridge, cardFile] });
    git.delta(cardMessage, [['A', 'odd/tasks/card-message.md']]);
    git.delta(noBridge, [['A', 'odd/tasks/no-bridge-naming.md']]);
    git.delta(cardFile, [['A', 'odd/tasks/card-message.md'], ['A', 'odd/tasks/no-bridge-naming.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), [
      'main', 'card-file', 'card-message', 'no-bridge-naming',
    ]);
    const byCheckout = new Map(groups.map((group) => [group.checkoutName, group.docs.map((doc) => doc.name)]));
    assert.deepEqual(byCheckout.get('card-file'), [], 'the chain draws none of the inherited names');
    assert.deepEqual(byCheckout.get('card-message'), ['card-message']);
    assert.deepEqual(byCheckout.get('no-bridge-naming'), ['no-bridge-naming']);
    // Attribution: every row is drawn from the group of the worktree it belongs to,
    // which is what the panel's label and the rail's row read.
    for (const group of groups) {
      for (const doc of group.docs) assert.equal(group.checkoutName, doc.name);
    }
  });

  test('preserve: a unique new document stays added, an identical copy stays dropped, an empty delta stays a group', async () => {
    const box = machine('dedupe-preserve');
    const oddA = box.worktree('odd-a');
    const oddB = box.worktree('odd-b');
    writeDoc(box.mainRoot, 'shared', { body: '# shared\n\nsame bytes\n', at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddA, 'shared', { body: '# shared\n\nsame bytes\n', at: '2020-01-01T00:00:00.000Z' });
    const fresh = writeDoc(oddA, 'fresh', { body: '# fresh\n', at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, oddA, oddB] });
    git.delta(oddA, [['M', 'odd/tasks/shared.md'], ['A', 'odd/tasks/fresh.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-a', 'odd-b']);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['shared'], 'main still lists its own document');
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'fresh', status: 'added' }]);
    assert.deepEqual(groups[1].docs.map((doc) => doc.docPath), [fresh], 'nobody else copies it, so it stays');
    assert.deepEqual(groups[2].docs, [], 'a group with no delta keeps docs: []');
  });
});

// S13: the machine holds ~20 worktrees, so computing a merge-base diff for every
// one of them on every refresh is wasted work. The scope is an INPUT: `roots` is
// the set of worktrees the session registered, and only what Git lists AND that set
// names is grouped — a worktree left out is never asked a single git question, which
// is what these tests read from the fake's argv log. An absent `roots` is the old
// behaviour, unchanged: every OWNED worktree.
describe('S13: `roots` scopes the scan to the worktrees a session registered', () => {
  test('without `roots` every owned worktree is grouped, exactly as before', async () => {
    const box = machine('scope-absent');
    const oddA = box.worktree('odd-a');
    const oddB = box.worktree('odd-b');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddA, 'a-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddB, 'b-doc', { at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, oddA, oddB] });
    git.delta(oddA, [['A', 'odd/tasks/a-doc.md']]);
    git.delta(oddB, [['A', 'odd/tasks/b-doc.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-a', 'odd-b']);
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'a-doc', status: 'added' }]);
    assert.deepEqual(contract(groups[2]).docs, [{ name: 'b-doc', status: 'added' }]);
    assert.deepEqual(
      git.verbs().filter((call) => call.verb === 'merge-base').map((call) => call.cwd),
      [oddA, oddB],
      'no scope means every owned worktree is compared',
    );
  });

  test('`roots: undefined` and `roots: null` are the same as no scope at all', async () => {
    const box = machine('scope-null');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'wt-doc', { at: '2020-02-01T00:00:00.000Z' });
    const answers = [];
    for (const roots of [undefined, null]) {
      const git = fakeGit({ paths: [box.mainRoot, worktree] });
      git.delta(worktree, [['A', 'odd/tasks/wt-doc.md']]);
      answers.push({
        groups: await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, roots }),
        compared: git.verbs().filter((call) => call.verb === 'merge-base').map((call) => call.cwd),
      });
    }

    assert.deepEqual(answers[0].groups, answers[1].groups);
    assert.deepEqual(answers[0].groups.map((group) => group.checkoutName), ['main', 'odd-rail']);
    assert.deepEqual(answers[1].compared, [worktree]);
  });

  test('only the listed worktrees are grouped, and an excluded one costs no git read', async () => {
    const box = machine('scope-selects');
    const oddA = box.worktree('odd-a');
    const oddB = box.worktree('odd-b');
    const oddC = box.worktree('odd-c');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddA, 'a-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddB, 'b-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(oddC, 'c-doc', { at: '2020-01-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, oddA, oddB, oddC] });
    git.delta(oddA, [['A', 'odd/tasks/a-doc.md']]);
    git.delta(oddB, [['A', 'odd/tasks/b-doc.md']]);
    git.delta(oddC, [['A', 'odd/tasks/c-doc.md']]);

    const groups = await groupOddDocs({
      repoRoot: box.mainRoot,
      runAsync: git.runAsync,
      roots: [oddA, oddC],
    });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-a', 'odd-c']);
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'a-doc', status: 'added' }]);
    assert.deepEqual(contract(groups[2]).docs, [{ name: 'c-doc', status: 'added' }]);
    assert.deepEqual(
      git.verbs().filter((call) => call.cwd === oddB).map((call) => call.args),
      [],
      'an unregistered worktree is never asked anything, not even its own delta',
    );
    assert.deepEqual(
      git.verbs().filter((call) => call.cwd === oddA).map((call) => call.verb),
      ['merge-base', 'diff', 'status'],
    );
    assert.deepEqual(
      git.verbs().filter((call) => call.cwd === oddC).map((call) => call.verb),
      ['merge-base', 'diff', 'status'],
    );
  });

  test('a registered worktree outside <repo>-worktrees is included: registration is the authority', async () => {
    const box = machine('scope-outside');
    const outside = box.outside('elsewhere');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(outside, 'foreign-doc', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, outside] });
    git.delta(outside, [['A', 'odd/tasks/foreign-doc.md']]);

    // A trailing separator is the same root: paths compare normalized.
    const groups = await groupOddDocs({
      repoRoot: box.mainRoot,
      runAsync: git.runAsync,
      roots: [`${outside}${path.sep}`],
    });

    assert.deepEqual(groups.map((group) => [group.checkoutName, group.isMain]), [
      ['main', true],
      ['elsewhere', false],
    ]);
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'foreign-doc', status: 'added' }]);
  });

  test('a registered root Git does not list contributes nothing and never throws', async () => {
    const box = machine('scope-stale');
    const live = box.worktree('odd-live');
    const stale = box.worktree('odd-stale');
    const clone = box.outside('another-clone');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(live, 'live-doc', { at: '2020-02-01T00:00:00.000Z' });
    fs.mkdirSync(clone, { recursive: true });
    const git = fakeGit({ paths: [box.mainRoot, live] });
    git.delta(live, [['A', 'odd/tasks/live-doc.md']]);

    const groups = await groupOddDocs({
      repoRoot: box.mainRoot,
      runAsync: git.runAsync,
      roots: [stale, clone, live],
    });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-live']);
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'live-doc', status: 'added' }]);
    for (const absent of [stale, clone]) {
      assert.deepEqual(git.verbs().filter((call) => call.cwd === absent), [], 'a stale root is never read');
    }
  });

  test('an empty `roots` is main only, and no worktree is read', async () => {
    const box = machine('scope-empty');
    const worktree = box.worktree('odd-rail');
    const doc = writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'wt-doc', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['A', 'odd/tasks/wt-doc.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, roots: [] });

    assert.deepEqual(groups, [
      {
        checkoutName: 'main',
        checkoutRoot: box.mainRoot,
        isMain: true,
        docs: [{ name: 'main-doc', docPath: doc, mtimeMs: mtimeOf(doc) }],
      },
    ]);
    assert.equal(git.calls.length, 1, 'the one listing read, and no worktree read at all');
  });

  test('a `roots` that is present but not a list fails closed to main only', async () => {
    const box = machine('scope-malformed');
    const worktree = box.worktree('odd-rail');
    const doc = writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'wt-doc', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['A', 'odd/tasks/wt-doc.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, roots: 'odd-rail' });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main']);
    assert.equal(groups[0].docs[0].docPath, doc);
    assert.equal(git.calls.length, 1, 'the one listing read, and no worktree read at all');
  });

  test('main is always first and is never duplicated when it is itself in `roots`', async () => {
    const box = machine('scope-main');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'wt-doc', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree] });
    git.delta(worktree, [['A', 'odd/tasks/wt-doc.md']]);

    const groups = await groupOddDocs({
      repoRoot: box.mainRoot,
      runAsync: git.runAsync,
      roots: [`${box.mainRoot}${path.sep}`, worktree],
    });

    assert.deepEqual(groups.map((group) => [group.checkoutName, group.isMain]), [
      ['main', true],
      ['odd-rail', false],
    ]);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['main-doc']);
  });
});

// S11: `a` in the panel means EVERY worktree of this clone, "registered or not".
// The default enumeration above is the owned-checkout rule, which is the right
// default for every existing caller; `all: true` is the explicit, ADDITIVE
// switch that drops that filter and groups every worktree Git lists except main.
// It wins over `roots` when a caller passes both, and it changes nothing about
// failure: an unreadable checkout still contributes no document and never throws.
describe('S11: `all` groups every worktree Git lists, not just the owned ones', () => {
  test('`all: true` groups a worktree outside <repo>-worktrees, which the default excludes', async () => {
    const box = machine('all-outside');
    const outside = box.outside('elsewhere');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(outside, 'foreign-doc', { at: '2020-02-01T00:00:00.000Z' });

    // The premise: the unchanged default really omits it, and asks it nothing.
    const byDefault = fakeGit({ paths: [box.mainRoot, outside] });
    byDefault.delta(outside, [['A', 'odd/tasks/foreign-doc.md']]);
    const scoped = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: byDefault.runAsync });
    assert.deepEqual(scoped.map((group) => group.checkoutName), ['main']);
    assert.deepEqual(byDefault.verbs().filter((call) => call.cwd === outside), [],
      'the owned-checkout rule never asks a foreign worktree anything');

    const git = fakeGit({ paths: [box.mainRoot, outside] });
    git.delta(outside, [['A', 'odd/tasks/foreign-doc.md']]);
    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, all: true });

    assert.deepEqual(groups.map((group) => [group.checkoutName, group.isMain]), [
      ['main', true],
      ['elsewhere', false],
    ]);
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'foreign-doc', status: 'added' }]);
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['main-doc'], 'main stays first and whole');
  });

  test('`all` wins over `roots` when a caller passes both', async () => {
    const box = machine('all-wins');
    const owned = box.worktree('odd-rail');
    const outside = box.outside('elsewhere');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(owned, 'owned-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(outside, 'foreign-doc', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, owned, outside] });
    git.delta(owned, [['A', 'odd/tasks/owned-doc.md']]);
    git.delta(outside, [['A', 'odd/tasks/foreign-doc.md']]);

    const groups = await groupOddDocs({
      repoRoot: box.mainRoot,
      runAsync: git.runAsync,
      roots: [owned],
      all: true,
    });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'elsewhere', 'odd-rail']);
    assert.deepEqual(contract(groups[1]).docs, [{ name: 'foreign-doc', status: 'added' }]);
    assert.deepEqual(contract(groups[2]).docs, [{ name: 'owned-doc', status: 'added' }]);
  });

  test('a stale worktree Git still lists is skipped under `all` and never throws', async () => {
    const box = machine('all-stale');
    const gone = box.outside('gone');
    const live = box.outside('live');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(live, 'live-doc', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, gone, live] });
    git.delta(live, [['A', 'odd/tasks/live-doc.md']]);

    const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, all: true });

    assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'gone', 'live']);
    assert.deepEqual(groups[1].docs, [], 'an unreadable checkout contributes no document');
    assert.deepEqual(contract(groups[2]).docs, [{ name: 'live-doc', status: 'added' }]);
    assert.deepEqual(git.verbs().filter((call) => call.cwd === gone), [],
      'and it is never asked a git question');
  });

  test('`roots` absent and `all` absent is exactly today’s owned-worktree enumeration', async () => {
    const box = machine('all-absent');
    const owned = box.worktree('odd-rail');
    const outside = box.outside('elsewhere');
    writeDoc(box.mainRoot, 'main-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(owned, 'owned-doc', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(outside, 'foreign-doc', { at: '2020-02-01T00:00:00.000Z' });
    const shapes = [undefined, false];
    for (const all of shapes) {
      const git = fakeGit({ paths: [box.mainRoot, owned, outside] });
      git.delta(owned, [['A', 'odd/tasks/owned-doc.md']]);
      git.delta(outside, [['A', 'odd/tasks/foreign-doc.md']]);

      const groups = await groupOddDocs({ repoRoot: box.mainRoot, runAsync: git.runAsync, all });

      assert.deepEqual(groups.map((group) => group.checkoutName), ['main', 'odd-rail'],
        `all: ${all} keeps the default scope`);
      assert.deepEqual(git.verbs().filter((call) => call.cwd === outside), [],
        'the foreign worktree is still never read');
    }
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

  test('S13: `failClosed` answers no model where the default answers a synthetic main', async () => {
    const box = machine('list-fails-closed');
    const worktree = box.worktree('odd-rail');
    writeDoc(box.mainRoot, 'mine', { at: '2020-01-01T00:00:00.000Z' });
    writeDoc(worktree, 'theirs', { at: '2020-02-01T00:00:00.000Z' });
    const git = fakeGit({ paths: [box.mainRoot, worktree], fail: ['worktree'] });

    // The default is the documented degradation, unchanged: the caller's own
    // root is the only checkout there is, reported as main.
    const degraded = await groupOddDocs({ repoRoot: worktree, runAsync: git.runAsync });
    assert.deepEqual(degraded.map((group) => group.checkoutName), ['main']);
    assert.deepEqual(degraded[0].docs.map((doc) => doc.name), ['theirs'],
      'the default still answers the session checkout as main');

    // `failClosed` is S13's strict reading: a listing that cannot be read is no
    // model, never a linked checkout dressed as main.
    assert.equal(await groupOddDocs({ repoRoot: worktree, runAsync: git.runAsync, failClosed: true }), null);
    // False (and absent) are the default, byte for byte.
    assert.deepEqual(await groupOddDocs({ repoRoot: worktree, runAsync: git.runAsync, failClosed: false }), degraded);
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

// ---------------------------------------------------------------------------
// T17/F1 (L11): MAIN is the first listed entry that is a WORKING TREE. Git's
// listing is not "the main checkout first" for every repository shape: a
// repository created with `git init --separate-git-dir` has its METADATA directory
// listed where the main checkout would be (Git derives that record from the common
// dir), so electing `entries[0]` blindly made main a directory with no `odd/tasks`
// — and bare `/odd` reported "No odd documents under odd/tasks/ in this checkout."
// for a checkout that owns a document. These tests build the real repositories
// through the real CLI and read them with the module's own git seam, because the
// shape under test is Git's, not the parser's.
//
// A standard repository keeps today's answer byte for byte: the pinned standard
// case below and every fake-seam case above it.
describe('T17/F1: main is elected from the listing’s attributes, never its position alone', () => {
  const { spawnSync } = require('node:child_process');

  function runGit(args, cwd) {
    const answer = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (answer.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${answer.stderr}`);
    return answer.stdout;
  }

  // The module's seam, run against the real binary: the same contract as the fake
  // (`{status, stdout, stderr, error}`), so the reads under test are Git's own.
  function realSeam() {
    return (bin, argv, cwd) => Promise.resolve().then(() => {
      const answer = spawnSync(bin, argv, { cwd, encoding: 'utf8' });
      return {
        status: answer.status,
        stdout: answer.stdout === null ? '' : answer.stdout,
        stderr: answer.stderr === null ? '' : answer.stderr,
        error: answer.error,
      };
    });
  }

  function configure(root) {
    runGit(['config', 'user.email', 'test@example.test'], root);
    runGit(['config', 'user.name', 'Test'], root);
  }

  function commitAll(root, message) {
    runGit(['add', '-A'], root);
    runGit(['commit', '-m', message], root);
  }

  // A real repository whose git dir is NOT the checkout: `git init
  // --separate-git-dir <meta> <checkout>` leaves `<checkout>/.git` a link file and
  // makes Git print `<meta>` as the worktree record.
  function separateGitDirRepo(tag) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `odd-group-sep-${tag}-`)));
    roots.push(base);
    const meta = path.join(base, 'git-meta');
    const checkout = path.join(base, 'checkout');
    runGit(['init', '--separate-git-dir', meta, checkout], base);
    configure(checkout);
    writeDoc(checkout, 'main-one', { at: '2020-01-01T00:00:00.000Z' });
    commitAll(checkout, 'init');
    return { base, meta, checkout };
  }

  test('F1: a separate git dir keeps the working tree as main, with its documents', async (t) => {
    const repo = separateGitDirRepo('listing');
    const listed = runGit(['worktree', 'list', '--porcelain'], repo.checkout);
    t.diagnostic(`git's own record: ${JSON.stringify(listed)}`);

    const groups = await groupOddDocs({ repoRoot: repo.checkout, runAsync: realSeam(), failClosed: true });

    assert.ok(Array.isArray(groups), 'the listing answered, so there is a model');
    assert.equal(groups.length, 1, 'main is the only checkout there is');
    assert.equal(groups[0].checkoutName, 'main');
    assert.equal(groups[0].checkoutRoot, repo.checkout,
      'main is the WORKING TREE the listing could not name')
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['main-one'],
      'and its own document is listed');
    assert.deepEqual(Object.keys(groups[0].docs[0]).sort(), ['docPath', 'mtimeMs', 'name'],
      'the row shape is unchanged (no invented status for main)');
  });

  // T18/F1 (L11): the METADATA record is never a checkout. A separate git dir lists
  // that directory in the record Git would print for the working tree, and a session
  // standing in a LINKED checkout of such a repository used to elect it: bare /odd
  // answered "no documents" for a repository whose main checkout owns one, and a
  // document written into the metadata tree appeared as main's instead of the real
  // one. Main is the working tree that OWNS the common dir.
  test('F1: a linked session of a separate git dir elects the real working tree, never the metadata tree', async (t) => {
    const repo = separateGitDirRepo('linked-session');
    const owned = path.join(repo.base, 'checkout-worktrees', 'linked-one');
    runGit(['worktree', 'add', '-b', 'feat/linked-one', owned], repo.checkout);
    writeDoc(owned, 'private', { at: '2020-03-01T00:00:00.000Z' });
    // The metadata tree is not a checkout, so a document under its own `odd/tasks` is
    // nobody's document — the case that made it "appear as main".
    writeDoc(repo.meta, 'metadata-only', { at: '2020-05-01T00:00:00.000Z' });
    const listed = runGit(['worktree', 'list', '--porcelain'], owned);
    t.diagnostic(`git's own record: ${JSON.stringify(listed)}`);

    const groups = await groupOddDocs({ repoRoot: owned, roots: [], runAsync: realSeam(), failClosed: true });

    assert.ok(Array.isArray(groups), 'the listing answered, so there is a model');
    assert.equal(groups.length, 1, 'nothing is registered, so main is the only group');
    assert.equal(groups[0].checkoutRoot, repo.checkout,
      'main is the working tree that owns the common dir, not the metadata record');
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['main-one'],
      'and the metadata tree is not a checkout: its document is not main\u2019s');
  });

  test('F1 preserve: a standard repository elects the same main it always did', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-group-standard-')));
    roots.push(base);
    const root = path.join(base, 'repo');
    runGit(['init', '-b', 'main', root], base);
    configure(root);
    writeDoc(root, 'feature', { at: '2020-01-01T00:00:00.000Z' });
    commitAll(root, 'init');
    const owned = path.join(base, 'repo-worktrees', 'odd-rail');
    runGit(['worktree', 'add', '-b', 'feat/odd-rail', owned, 'main'], root);
    writeDoc(owned, 'delta', { at: '2020-02-01T00:00:00.000Z' });
    runGit(['add', '-A'], owned);
    runGit(['commit', '-m', 'delta'], owned);

    const groups = await groupOddDocs({ repoRoot: root, runAsync: realSeam(), failClosed: true });

    assert.deepEqual(groups.map((group) => [group.checkoutName, group.isMain, group.checkoutRoot]), [
      ['main', true, root],
      ['odd-rail', false, owned],
    ], 'the main record is still main, and the worktree still follows it');
    assert.deepEqual(groups[0].docs.map((doc) => doc.name), ['feature']);
    assert.deepEqual(groups[1].docs.map((doc) => [doc.name, doc.status]), [['delta', 'added']]);
  });
});

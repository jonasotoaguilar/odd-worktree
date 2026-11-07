'use strict';
// S22 (round 3): reading the registry must not spawn git.
//
// The reported symptom was a plugin that made every tool call and every
// repaint feel heavy. `readRegistry` resolved the storage path through
// `repoIdentity` — two `spawnSync` git probes, ~19 ms on this machine — on
// EVERY call, and the interactive paths read the registry several times per
// action (once per tool event, once per list/detail/selector read). The
// resolution is cached per checkout and the parsed file per (inode, mtime,
// size), so a repeated read costs no child and a write is still seen at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cache-'));
  const run = (args) => {
    const res = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout;
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return root;
}

// A fresh module (no warm state) with every `spawnSync` counted, so the
// assertions describe one process, not a previous test's cache.
function loadWithCounter() {
  const libPath = require.resolve('../lib/worktree-registry.js');
  delete require.cache[libPath];
  const seen = [];
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (bin, args, opts) => {
    seen.push({ bin: String(bin), args: Array.isArray(args) ? args.slice() : [] });
    return original(bin, args, opts);
  };
  const registry = require('../lib/worktree-registry.js');
  return {
    registry,
    seen,
    gitSpawns: () => seen.filter((call) => call.bin === 'git').length,
    restore: () => {
      childProcess.spawnSync = original;
    },
  };
}

function entry(overrides = {}) {
  return {
    branch: 'feat/one',
    path: '/tmp/one',
    thread: 'test-thread',
    issues: [],
    odd: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('five registry reads in one checkout resolve the repository once, not once per read', () => {
  const root = makeRepo();
  const loaded = loadWithCounter();
  try {
    for (let index = 0; index < 5; index += 1) {
      const read = loaded.registry.readRegistry(root);
      assert.equal(read.ok, true);
    }
    // `git rev-parse --show-toplevel` + `--git-common-dir`, the first time only.
    assert.equal(loaded.gitSpawns(), 2,
      `one resolution for the checkout, not one per read: ${JSON.stringify(loaded.seen)}`);
  } finally {
    loaded.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write through the registry is visible to the very next read', () => {
  const root = makeRepo();
  const loaded = loadWithCounter();
  try {
    const written = loaded.registry.upsertWorktree(root, entry());
    assert.equal(written.ok, true, `upsert: ${JSON.stringify(written)}`);
    const read = loaded.registry.readRegistry(root);
    assert.equal(read.ok, true);
    assert.equal(read.worktrees.length, 1, 'the row written under the lock is read back');
    assert.equal(read.worktrees[0].branch, 'feat/one');
  } finally {
    loaded.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('another process writing the registry invalidates a cached read', () => {
  const root = makeRepo();
  const loaded = loadWithCounter();
  try {
    assert.equal(loaded.registry.readRegistry(root).worktrees.length, 0, 'nothing registered yet');
    const file = path.join(fs.realpathSync(root), '.git', 'pi-worktrees.json');
    // A different writer: same path, written in place, like a hand edit.
    const doc = { version: 1, worktrees: [{ ...entry({ branch: 'feat/external', path: '/tmp/external' }) }] };
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    const read = loaded.registry.readRegistry(root);
    assert.equal(read.worktrees.length, 1, 'the external write is seen, never a stale empty registry');
    assert.equal(read.worktrees[0].branch, 'feat/external');
  } finally {
    loaded.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two checkouts of the same repository never share one cache slot, and a caller cannot mutate a cached doc', () => {
  const root = makeRepo();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cache-wt-'));
  const loaded = loadWithCounter();
  try {
    assert.equal(loaded.registry.upsertWorktree(root, entry()).ok, true);
    const linked = path.join(other, 'linked');
    const added = childProcess.spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat/linked', linked, 'HEAD'],
      { cwd: root, encoding: 'utf8' });
    assert.equal(added.status, 0, added.stderr);
    const first = loaded.registry.readRegistry(root);
    first.worktrees.push(entry({ branch: 'feat/mutated' }));
    const again = loaded.registry.readRegistry(root);
    assert.equal(again.worktrees.length, 1, 'the cached document is never handed out for mutation');
    const fromLinked = loaded.registry.readRegistry(linked);
    assert.deepEqual(fromLinked.worktrees.map((row) => row.branch), ['feat/one'],
      'both checkouts read the same shared registry file');
  } finally {
    loaded.restore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('a cached read still carries the hidden drop report a later write needs', () => {
  const root = makeRepo();
  const loaded = loadWithCounter();
  try {
    const file = path.join(fs.realpathSync(root), '.git', 'pi-worktrees.json');
    const legacy = { version: 1, worktrees: [{ ...entry({ branch: 'feat/legacy' }), odd: ['odd/tasks/first.md', 'odd/tasks/second.md'] }] };
    fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
    // Read twice: the second one comes from the cache.
    assert.equal(loaded.registry.readRegistry(root).worktrees[0].odd, 'odd/tasks/first.md');
    assert.equal(loaded.registry.readRegistry(root).worktrees[0].odd, 'odd/tasks/first.md');
    const updated = loaded.registry.updateWorktree(root, 'feat/legacy', { issues: [] });
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.dropped, ['odd/tasks/second.md'],
      'the collapsing write still names the document it dropped');
  } finally {
    loaded.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

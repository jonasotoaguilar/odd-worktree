'use strict';
// S2/S4 behavior of the three checkout tools, exercised through the REGISTERED
// tool objects against a real temporary repository. Herdr is deliberately
// unusable (HERDR_BIN_PATH names a binary that does not exist), so every
// create/list/close below proves the plain git route: the package has no Herdr
// requirement at all.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadExtension } = require('./fixtures/load-extension.js');

const scratch = [];
function track(dir) {
  scratch.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// A deterministic `codegraph` shim keeps the creation hooks off the developer's
// PATH-dependent tooling; the rest of PATH is preserved so git still resolves.
const HOOK_BIN = path.resolve(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-hookbin-'))));
fs.writeFileSync(path.join(HOOK_BIN, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// No Herdr workspace can be created from this path: it does not exist.
const NO_HERDR = path.join(os.tmpdir(), 'odd-worktree-no-such-herdr-binary');

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-repo-')));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function makeCtx(repoRoot, thread = 'thread-1') {
  const notifications = [];
  return {
    notifications,
    ctx: {
      cwd: repoRoot,
      hasUI: false,
      mode: 'tui',
      sessionManager: { getSessionId: () => thread },
      ui: {
        confirm: async () => true,
        notify: (text, level) => { notifications.push([level, text]); },
      },
    },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => (part && part.text) || '').join('\n');
}

function listWorktreePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function branches(root) {
  return git(root, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort();
}

let tools;
before(async () => {
  process.env.HERDR_BIN_PATH = NO_HERDR;
  process.env.GENTLE_WORKTREE_THREAD = 'thread-1';
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  ({ tools } = await loadExtension({}));
});

describe('worktree_list', () => {
  test('a fresh repository lists its principal checkout only', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, resultText(result));
    assert.equal(
      resultText(result),
      `worktrees: 1 (name · branch · path)\nprincipal · main · ${fs.realpathSync(repo)}`,
    );
    assert.equal(result.details.count, 1);
    assert.deepEqual(result.details.worktrees.map((row) => row.kind), ['principal']);
    assert.equal(result.details.worktrees[0].path, fs.realpathSync(repo));
  });

  test('a directory outside a repository is refused by the help text', async () => {
    const loose = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-loose-')));
    const { ctx } = makeCtx(loose);
    const result = await tools.get('worktree_list').execute('call-2', {}, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(resultText(result), `not a git repository: ${loose}`);
  });
});

describe('worktree_create', () => {
  test('creates the checkout and its registry row without Herdr', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_create').execute(
      'call-3',
      { branch: 'feat/x', changes: 'none' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(result.isError, true, resultText(result));
    const rows = resultText(result).split('\n');
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-x');
    assert.equal(rows[0], 'created: feat-x · feat/x');
    assert.equal(rows[1], `path: ${target}`);
    assert.equal(rows[2], 'registered: new');
    assert.ok(fs.existsSync(target), 'the checkout exists on disk');
    assert.ok(listWorktreePaths(repo).includes(target), 'git knows the checkout');
    assert.ok(branches(repo).includes('feat/x'), 'the branch exists');

    const listed = await tools.get('worktree_list').execute('call-4', {}, undefined, undefined, ctx);
    assert.equal(
      resultText(listed),
      `worktrees: 2 (name · branch · path)\nprincipal · main · ${fs.realpathSync(repo)}\nfeat-x · feat/x · ${target}`,
    );
  });

  test('refuses an invalid branch name and writes nothing', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const before = { paths: listWorktreePaths(repo), branches: branches(repo) };
    const result = await tools.get('worktree_create').execute(
      'call-5',
      { branch: 'bad..name', changes: 'none' },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^invalid branch name/);
    assert.deepEqual({ paths: listWorktreePaths(repo), branches: branches(repo) }, before);
  });

  test('refuses a call that never states what to copy', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_create').execute('call-6', { branch: 'feat/y' }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^invalid changes selection: 'changes' is required/);
    assert.equal(listWorktreePaths(repo).length, 1, 'no checkout was added');
  });
});

describe('worktree_close', () => {
  test('removes the checkout and keeps the branch', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute(
      'call-7',
      { branch: 'feat/close-me', changes: 'none' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-close-me');

    const closed = await tools.get('worktree_close').execute('call-8', { name: 'feat-close-me' }, undefined, undefined, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.equal(
      resultText(closed),
      `outcome: removed\nname: feat-close-me\nbranch: feat/close-me\npath: ${target}\nbranch state: kept`,
    );
    assert.equal(fs.existsSync(target), false, 'the checkout is gone');
    assert.equal(listWorktreePaths(repo).includes(target), false);
    assert.ok(branches(repo).includes('feat/close-me'), 'the branch is kept');

    const listed = await tools.get('worktree_list').execute('call-9', {}, undefined, undefined, ctx);
    assert.equal(
      resultText(listed),
      `worktrees: 1 (name · branch · path)\nprincipal · main · ${fs.realpathSync(repo)}`,
    );
  });

  test('an unknown name is refused and leaves the repository untouched', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_close').execute('call-10', { name: 'nope' }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(resultText(result), 'no registered worktree for "nope": no worktrees are registered');
    assert.equal(listWorktreePaths(repo).length, 1);
  });
});

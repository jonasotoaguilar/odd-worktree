'use strict';
// S6: `worktree_close` removes a checkout with `git worktree remove` and NOTHING
// else. The Herdr workspace reconcile it used to run — closing every workspace
// of the checkout's group and opening a fresh one at the principal — is gone:
// this package never closes or opens a Herdr panel, and it never asks Herdr to
// remove a worktree (that route retires the workspace behind the human's back).
//
// What is pinned here:
//   - the removal argv is git's, fixed, with the absolute target and `--force`
//     only when the caller asked for it;
//   - the removal helper reports the backend's own reason and never throws;
//   - the module exports no panel-mutating or session-evidence helper;
//   - the extension's close surface contains no Herdr workspace action and no
//     `herdr worktree remove`, and a real close spawns no Herdr process at all.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SRC, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

const lib = require('../lib/worktree-close-herdr.js');

const TARGET = '/tmp/repo-worktrees/feat-doomed';
const PRINCIPAL = '/tmp/repo';

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

describe('S6: the removal surface is git-only', () => {
  test('the removal argv is git worktree remove with the absolute target', () => {
    assert.deepEqual(lib.gitRemovalArgv(TARGET, false), ['worktree', 'remove', TARGET]);
    assert.deepEqual(lib.gitRemovalArgv(TARGET, true), ['worktree', 'remove', '--force', TARGET]);
    assert.throws(() => lib.gitRemovalArgv('relative/path', false), TypeError);
  });

  test('a removal asks git exactly once, with the caller root and timeout', async () => {
    const calls = [];
    const out = await lib.removeCheckout({
      runAsync: async (bin, argv, options) => {
        calls.push({ bin, argv, options });
        return { status: 0, stdout: '', stderr: '' };
      },
      repoRoot: PRINCIPAL,
      resolvedTarget: TARGET,
      force: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'git');
    assert.deepEqual(calls[0].argv, ['worktree', 'remove', '--force', TARGET]);
    assert.equal(calls[0].options.cwd, PRINCIPAL);
    assert.equal(calls[0].options.timeoutMs, lib.REMOVE_TIMEOUT_MS);
    assert.deepEqual(out, { removed: true, removedBy: 'git' });
  });

  test('the backend reason travels back verbatim, and no failure ever throws', async () => {
    const failed = await lib.removeCheckout({
      runAsync: async () => ({ status: 1, stdout: '', stderr: "fatal: '/x' contains modified or untracked files\nsecond line\n" }),
      repoRoot: PRINCIPAL,
      resolvedTarget: TARGET,
      force: false,
    });
    assert.equal(failed.removed, false);
    assert.equal(failed.error, "fatal: '/x' contains modified or untracked files\nsecond line");

    const noRunner = await lib.removeCheckout({ runAsync: null, repoRoot: PRINCIPAL, resolvedTarget: TARGET, force: false });
    assert.equal(noRunner.removed, false);
    assert.match(noRunner.error, /runner/);

    const thrown = await lib.removeCheckout({
      runAsync: () => { throw new Error('spawn exploded'); },
      repoRoot: PRINCIPAL,
      resolvedTarget: TARGET,
      force: false,
    });
    assert.equal(thrown.removed, false);
    assert.equal(thrown.error, 'spawn exploded');
  });

  test('no panel-mutating or session-evidence helper survives in the module', () => {
    for (const gone of [
      'reconcileHerdrWorkspace',
      'reconcileHerdrWorkspaceAsync',
      'workspaceEntryForPath',
      'workspaceEntriesForPath',
      'orderedGroupMembers',
      'parseWorkspaceList',
      'parseWorkspaceCreateId',
      'agentsInCheckout',
    ]) {
      assert.equal(lib[gone], undefined, `${gone} is not part of the removal surface`);
    }
    assert.deepEqual(Object.keys(lib).sort(), ['REMOVE_TIMEOUT_MS', 'gitRemovalArgv', 'removeCheckout']);
    const source = fs.readFileSync(path.resolve(__dirname, '../lib/worktree-close-herdr.js'), 'utf8');
    for (const forbidden of ['workspace close', 'workspace create', "'workspace'", "'herdr'", '"herdr"']) {
      assert.equal(source.includes(forbidden), false, `the module never names ${forbidden}`);
    }
  });

  test('the extension contains no Herdr workspace action and no Herdr removal', () => {
    const source = stubbedSource();
    for (const gone of [
      'reconcileHerdrWorkspace',
      'herdrWorkspaceId',
      'herdrArgv("remove"',
      '"workspace", "close"',
      '"workspace", "create"',
      "'workspace close'",
    ]) {
      assert.equal(source.includes(gone), false, `${gone} is gone from the close surface`);
    }
    assert.ok(source.includes('libRequire("worktree-close-herdr.js")'), 'the git removal helper is the removal surface');
    assert.ok(source.includes('removeCheckout'), 'the close uses the git-only removal');
  });
});

describe('S6: a real close spawns no Herdr process', () => {
  const savedEnv = { ...process.env };
  const NO_HERDR = path.join(os.tmpdir(), 'odd-worktree-no-such-herdr-binary');
  const HOOK_BIN = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-hookbin-')));
  fs.writeFileSync(path.join(HOOK_BIN, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const HERDR_LOG = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-herdr-log-'))), 'argv.log');
  const HERDR_SHIM = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-herdr-bin-'))), 'herdr');
  fs.writeFileSync(HERDR_SHIM, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(HERDR_LOG)}\nexit 1\n`, { mode: 0o755 });
  const AGENT_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-agent-home-')));

  let tools;
  before(async () => {
    process.env.HERDR_BIN_PATH = NO_HERDR;
    delete process.env.GENTLE_PI_AGENT_HOME;
    process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
    process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
    ({ tools } = await loadExtension({}));
  });

  after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  });

  function git(cwd, args) {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
    return out.stdout.trim();
  }

  function makeRepo() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-repo-')));
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.test']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-m', 'init']);
    return dir;
  }

  function makeCtx(repoRoot) {
    return {
      cwd: repoRoot,
      hasUI: false,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'close-session' },
      ui: { confirm: async () => true, notify: () => {} },
    };
  }

  function resultText(result) {
    return (result.content || []).map((part) => (part && part.text) || '').join('\n');
  }

  test('closing a checkout never closes a panel, creates one, or asks Herdr to remove anything', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('c1', { branch: 'feat/quiet', changes: 'none' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-quiet');

    // From here on any Herdr spawn would leave a line in the log.
    process.env.HERDR_BIN_PATH = HERDR_SHIM;
    try {
      const closed = await tools.get('worktree_close').execute('c2', { name: 'feat-quiet' }, undefined, undefined, ctx);
      assert.notEqual(closed.isError, true, resultText(closed));
    } finally {
      process.env.HERDR_BIN_PATH = NO_HERDR;
    }
    assert.equal(fs.existsSync(target), false, 'git removed the checkout');
    const log = fs.existsSync(HERDR_LOG) ? fs.readFileSync(HERDR_LOG, 'utf8').trim() : '';
    assert.equal(log, '', `the close spawned no Herdr process at all: ${log}`);
  });
});

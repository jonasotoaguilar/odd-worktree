'use strict';
// S6/T9b: a removal uses `git worktree remove` and NOTHING else. The module is
// `lib/worktree-remove.js`, so the suite is named after the removal it covers;
// the cases below drive the extension's own close (the seam the warp panel's
// ctrl+d calls — the `worktree_delete` tool that used to wrap it is unregistered,
// T6/S4).
//
// What is pinned here, with teeth:
//   - the removal argv is git's, fixed, absolute, with `--force` only when the
//     caller asked for it, and a relative target is refused before any child;
//   - a real close spawns `git` and no other binary, exactly one
//     `worktree remove <absolute target>` argv, with the caller's root and the
//     helper's own timeout;
//   - the removal is awaited, so the host event loop keeps turning while git
//     runs (a blocking spawn would fail the argv assertions above as well);
//   - a failing git leaves the checkout AND the branch in place and reports
//     git's own refusal to the caller;
//   - the helper itself never throws and never loses the backend's reason.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LIB_DIR, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

const lib = require('../lib/worktree-remove.js');

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

describe('the removal argv is git\'s, fixed and absolute', () => {
  test('the removal argv is git worktree remove with the absolute target', () => {
    assert.deepEqual(lib.gitRemovalArgv(TARGET, false), ['worktree', 'remove', TARGET]);
    assert.deepEqual(lib.gitRemovalArgv(TARGET, true), ['worktree', 'remove', '--force', TARGET]);
    // Neither the branch nor `--trust-repository` is ever part of it.
    assert.equal(lib.gitRemovalArgv(TARGET, true).includes('--force'), true);
    assert.equal(lib.gitRemovalArgv(TARGET, true).length, 4);
    assert.throws(() => lib.gitRemovalArgv('relative/path', false), TypeError);
  });

  test('the module exposes one remover and nothing that reconciles anything else', () => {
    assert.deepEqual(Object.keys(lib).sort(), ['REMOVE_TIMEOUT_MS', 'gitRemovalArgv', 'removeCheckout']);
  });
});

describe('removeCheckout asks one awaited git child', () => {
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
});

describe('a real close removes with git alone', () => {
  const savedEnv = { ...process.env };
  const HOOK_BIN = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-hookbin-')));
  const AGENT_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-agent-home-')));

  let tools;
  let mod;
  before(async () => {
    delete process.env.GENTLE_PI_AGENT_HOME;
    process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
    process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
    // The refusal asserted below is git's OWN sentence, so the child's locale is
    // pinned instead of matching a translation.
    process.env.LC_ALL = 'C';
    process.env.LANG = 'C';
    ({ tools } = await loadExtension({}));
    mod = await loadStubbedModule();
  });

  // The removal the panel's ctrl+d drives is an exported seam of the extension
  // module, not a registered tool (T6/S4), so this file keeps that namespace
  // beside the registrations: same stubs, same lib override, same copy.
  async function loadStubbedModule() {
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-mod-'));
    try {
      const copy = path.join(dir, 'odd-worktree-tools.mjs');
      fs.writeFileSync(copy, stubbedSource());
      return await import(pathToFileURL(copy).href);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

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
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-repo-')));
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.test']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-m', 'init']);
    return fs.realpathSync(dir);
  }

  function makeCtx(repoRoot) {
    return {
      cwd: repoRoot,
      hasUI: false,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'remove-session' },
      ui: { confirm: async () => true, notify: () => {} },
    };
  }

  function resultText(result) {
    return (result.content || []).map((part) => (part && part.text) || '').join('\n');
  }

  function branches(root) {
    return git(root, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort();
  }

  // The checkout git itself reports for a branch, so the test never guesses the
  // flattened directory the create front derived.
  function checkoutFor(root, branch) {
    return git(root, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .find((entry) => entry !== root && fs.existsSync(entry) && git(entry, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch);
  }

  async function createCheckout(toolsByName, repo, branch) {
    // S7: the checkout's directory is the ODD, so it is the branch's own last
    // segment — one ODD per create, and the branch lookup below still finds the
    // checkout the create wrote.
    const odd = branch.slice(branch.lastIndexOf('/') + 1);
    const created = await toolsByName.get('worktree_create').execute(
      'remove-create', { branch, odd }, undefined, undefined, makeCtx(repo),
    );
    assert.notEqual(created.isError, true, resultText(created));
    const target = checkoutFor(repo, branch);
    assert.ok(target, `the create made no checkout for ${branch}`);
    return target;
  }

  // Every child the close spawns is recorded through the one async argv runner
  // the extension hands the removal module. A blocking spawn would bypass this
  // seam entirely, which is what makes the argv assertions below meaningful.
  function recordChildren() {
    const gitLib = require('../lib/worktree-git.js');
    const original = gitLib.runArgvAsync;
    const calls = [];
    gitLib.runArgvAsync = async (bin, argv, options) => {
      calls.push({ bin, argv, options });
      return original(bin, argv, options);
    };
    return {
      calls,
      restore() { gitLib.runArgvAsync = original; },
    };
  }

  test('a close spawns git only, with one fixed worktree remove argv', async () => {
    const repo = makeRepo();
    const target = await createCheckout(tools, repo, 'feat/doomed');

    const recorder = recordChildren();
    let closed;
    try {
      closed = await mod.executeWorktreeClose({ name: 'feat-doomed' }, makeCtx(repo));
    } finally {
      recorder.restore();
    }

    assert.notEqual(closed.isError, true, resultText(closed));
    assert.equal(fs.existsSync(target), false, 'git removed the checkout');
    assert.ok(branches(repo).includes('feat/doomed'), 'the branch is kept');

    const binaries = [...new Set(recorder.calls.map((call) => call.bin))];
    assert.deepEqual(binaries, ['git'], 'the removal path runs git and nothing else');
    const removals = recorder.calls.filter((call) => call.argv[0] === 'worktree' && call.argv[1] === 'remove');
    assert.equal(removals.length, 1, 'exactly one remover invocation');
    assert.deepEqual(removals[0].argv, ['worktree', 'remove', target], 'the argv is fixed: no branch, no --force, no --trust-repository');
    assert.equal(fs.realpathSync(removals[0].options.cwd), repo, 'the remover runs in the repository root');
    assert.equal(removals[0].options.timeoutMs, lib.REMOVE_TIMEOUT_MS);
  });

  test('the removal is awaited, so the host keeps turning while git runs', async () => {
    const repo = makeRepo();
    const target = await createCheckout(tools, repo, 'feat/slow');

    const gitLib = require('../lib/worktree-git.js');
    const original = gitLib.runArgvAsync;
    const order = [];
    gitLib.runArgvAsync = async (bin, argv, options) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        order.push('remover:start');
        // A slow remover: the window only the caller's own event loop can use.
        const ticks = await new Promise((resolve) => {
          let fired = 0;
          const interval = setInterval(() => { fired += 1; }, 1);
          setTimeout(() => { clearInterval(interval); resolve(fired); }, 25);
        });
        order.push(ticks > 0 ? 'host:turned' : 'host:blocked');
        const out = await original(bin, argv, options);
        order.push('remover:end');
        return out;
      }
      return original(bin, argv, options);
    };
    try {
      const closing = mod.executeWorktreeClose({ name: 'feat-slow' }, makeCtx(repo));
      // Yield once so the close reaches the remover before the assertion below.
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(fs.existsSync(target), 'the await means the checkout survives until git answers');
      const closed = await closing;
      assert.notEqual(closed.isError, true, resultText(closed));
      assert.deepEqual(order, ['remover:start', 'host:turned', 'remover:end'], 'the event loop kept turning while the remover ran');
    } finally {
      gitLib.runArgvAsync = original;
    }
    assert.equal(fs.existsSync(target), false, 'the awaited removal then completes');
    assert.ok(branches(repo).includes('feat/slow'), 'the branch is kept');
  });

  test('a failing git leaves the checkout and the branch and reports the refusal', async () => {
    const repo = makeRepo();
    const target = await createCheckout(tools, repo, 'feat/dirty');
    // Real git refuses this removal: an untracked file in the checkout and no
    // force. No shim decides the failure, so the refusal is the backend's own.
    fs.writeFileSync(path.join(target, 'uncommitted.txt'), 'work in progress\n');

    const recorder = recordChildren();
    let refused;
    try {
      refused = await mod.executeWorktreeClose({ name: 'feat-dirty' }, makeCtx(repo));
    } finally {
      recorder.restore();
    }

    assert.equal(refused.isError, true, 'a refusal is an error result');
    assert.match(resultText(refused), /contains modified or untracked files/);
    assert.match(resultText(refused), /use --force/);
    assert.ok(resultText(refused).includes(target), `the refusal names the checkout git refused: ${resultText(refused)}`);
    assert.equal(fs.existsSync(target), true, 'the checkout survives');
    assert.equal(fs.existsSync(path.join(target, 'uncommitted.txt')), true, 'the pending work survives');
    assert.ok(branches(repo).includes('feat/dirty'), 'the branch survives');
    const removals = recorder.calls.filter((call) => call.argv[0] === 'worktree' && call.argv[1] === 'remove');
    assert.equal(removals.length, 1);
    assert.deepEqual(removals[0].argv, ['worktree', 'remove', target], 'no --force was added on the caller\'s behalf');
    // The registry entry stays: the checkout is still a registered worktree, so
    // the next listing still finds it instead of silently forgetting it.
    const listed = await tools.get('worktree_list').execute('remove-4', {}, undefined, undefined, makeCtx(repo));
    assert.match(resultText(listed), /feat-dirty|feat\/dirty/);
  });
});

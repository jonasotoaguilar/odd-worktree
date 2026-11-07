'use strict';
// S24 (round 3): closing the checkout the session is inside reconciles the
// Herdr workspace group AFTER warping out, and that reconcile used
// `spawnSync` children (timeouts up to 60 s) on the host's event loop. The
// async twin must be indistinguishable in behaviour and must leave the loop
// free while a slow Herdr answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const lib = require('../lib/worktree-close-herdr.js');

const RESOLVED = '/tmp/repo-worktrees/feat-doomed';
const PRINCIPAL = '/tmp/repo';
const SESSION = { file: '/tmp/session.jsonl', id: 'abc' };

// The same document shapes the sync tests use: `worktree list` prints
// {result:{worktrees:[{path,open_workspace_id}]}}.
const WORKTREE_LIST = JSON.stringify({
  result: { worktrees: [{ path: RESOLVED, branch: 'feat/doomed', open_workspace_id: 'ws-linked' }] },
});

// The scripted answers, in the exact order the reconcile asks for them.
function script({ members = ['ws-linked', 'ws-root'], closeStatus = 0, createStatus = 0 } = {}) {
  return (argv) => {
    const line = argv.join(' ');
    if (line.startsWith('worktree list')) return { status: 0, stdout: WORKTREE_LIST, stderr: '' };
    if (line.startsWith('workspace list')) {
      return {
        status: 0,
        stdout: JSON.stringify({ result: { workspaces: members.map((id) => ({ workspace_id: id })) } }),
        stderr: '',
      };
    }
    if (line.startsWith('workspace close')) {
      return {
        status: closeStatus,
        stdout: '',
        stderr: closeStatus === 0 ? '' : 'workspace_not_found: gone',
      };
    }
    if (line.startsWith('workspace create')) {
      return {
        status: createStatus,
        stdout: createStatus === 0 ? JSON.stringify({ result: { workspace: { workspace_id: 'ws-principal' } } }) : '',
        stderr: createStatus === 0 ? '' : 'herdr: cannot create workspace',
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected argv: ${line}` };
  };
}

function argvLog() {
  const seen = [];
  const run = (argv, timeoutMs) => {
    seen.push({ argv: argv.slice(), timeoutMs });
    return script()(argv);
  };
  return { seen, run };
}

test('the async reconcile answers exactly like the sync one, on every outcome', async () => {
  const cases = [
    { name: 'reconciled', options: {} },
    { name: 'partial close', options: { closeStatus: 1 } },
    { name: 'partial open', options: { createStatus: 1 } },
    { name: 'no group', options: { members: [] } },
  ];
  for (const testCase of cases) {
    const responses = script(testCase.options);
    const syncSeen = [];
    const asyncSeen = [];
    const syncOut = lib.reconcileHerdrWorkspace({
      run: (argv, timeoutMs) => {
        syncSeen.push({ argv: argv.slice(), timeoutMs });
        return responses(argv);
      },
      repoRoot: PRINCIPAL,
      resolvedTarget: RESOLVED,
      principalPath: PRINCIPAL,
      session: SESSION,
      force: false,
    });
    const asyncOut = await lib.reconcileHerdrWorkspaceAsync({
      runAsync: async (argv, timeoutMs) => {
        asyncSeen.push({ argv: argv.slice(), timeoutMs });
        return responses(argv);
      },
      repoRoot: PRINCIPAL,
      resolvedTarget: RESOLVED,
      principalPath: PRINCIPAL,
      session: SESSION,
      force: false,
    });
    assert.deepEqual(asyncOut, syncOut, `${testCase.name}: same result shape and text`);
    assert.deepEqual(asyncSeen, syncSeen, `${testCase.name}: same argv, order and timeouts`);
  }
});

test('a missing runner is skipped, never a rejection', async () => {
  const out = await lib.reconcileHerdrWorkspaceAsync({
    runAsync: null,
    repoRoot: PRINCIPAL,
    resolvedTarget: RESOLVED,
    principalPath: PRINCIPAL,
    session: SESSION,
    force: false,
  });
  assert.equal(out.status, 'skipped');
  assert.match(out.notice, /herdr is unavailable/);
});

test('a throwing runner degrades to a skip with the same notice as the sync twin', async () => {
  const boom = () => {
    throw new Error('herdr exploded');
  };
  const syncOut = lib.reconcileHerdrWorkspace({
    run: boom, repoRoot: PRINCIPAL, resolvedTarget: RESOLVED, principalPath: PRINCIPAL, session: SESSION, force: false,
  });
  const asyncOut = await lib.reconcileHerdrWorkspaceAsync({
    runAsync: boom, repoRoot: PRINCIPAL, resolvedTarget: RESOLVED, principalPath: PRINCIPAL, session: SESSION, force: false,
  });
  assert.deepEqual(asyncOut, syncOut);
  assert.equal(asyncOut.status, 'skipped');
});

test('a slow Herdr never blocks the host event loop', async () => {
  const responses = script();
  let ticks = 0;
  let last = process.hrtime.bigint();
  let worstGapMs = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    worstGapMs = Math.max(worstGapMs, Number(now - last) / 1e6);
    last = now;
    ticks += 1;
  }, 10);
  try {
    const started = process.hrtime.bigint();
    const out = await lib.reconcileHerdrWorkspaceAsync({
      // 400 ms per Herdr answer, the shape a hung Herdr CLI produces.
      runAsync: (argv) => new Promise((resolve) => {
        setTimeout(() => resolve(responses(argv)), 400);
      }),
      repoRoot: PRINCIPAL,
      resolvedTarget: RESOLVED,
      principalPath: PRINCIPAL,
      session: SESSION,
      force: false,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(out.status, 'reconciled', 'the reconcile still finished');
    assert.ok(elapsedMs > 1200, `the whole sequence really waited: ${elapsedMs.toFixed(0)} ms`);
    assert.ok(ticks >= 60, `the loop kept ticking during the wait: ${ticks} ticks over ${elapsedMs.toFixed(0)} ms`);
    assert.ok(worstGapMs < 250, `no single gap froze the loop: longest gap ${worstGapMs.toFixed(0)} ms`);
  } finally {
    clearInterval(timer);
  }
});

test('the twin is exported beside the sync one', () => {
  assert.equal(typeof lib.reconcileHerdrWorkspaceAsync, 'function');
  assert.equal(typeof lib.reconcileHerdrWorkspace, 'function');
  assert.equal(path.basename(require.resolve('../lib/worktree-close-herdr.js')), 'worktree-close-herdr.js');
});

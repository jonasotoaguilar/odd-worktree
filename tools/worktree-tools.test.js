'use strict';
// S2/S4 behavior of the three checkout tools, exercised through the REGISTERED
// tool objects against a real temporary repository. Herdr is deliberately
// unusable (HERDR_BIN_PATH names a binary that does not exist), so every
// create/list/close below proves the plain git route: the package has no Herdr
// requirement at all.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

// S7/S8/S9: the active-session guard reads Gentle Shell's published presence
// store. Pin it to a throwaway agent home so no test can see (or be blocked by)
// the developer's real sessions, and publish synthetic records into it.
const AGENT_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-agent-home-')));
const PRESENCE = path.join(AGENT_HOME, 'gentle-agents', 'presence');
// One published session: the heartbeat header plus the discovery sidecar that
// carries its workspace (the shape upstream orchestrator-presence.ts writes).
function publishSession({
  sessionId, label = 'Worker', workspace, heartbeat = Date.now(), incarnationIndex = 1, discovery = true,
} = {}) {
  fs.mkdirSync(PRESENCE, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(PRESENCE, 0o700); } catch { /* explicit mode is best effort */ }
  const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  const incarnation = `1000000${incarnationIndex}-0000-4000-8000-00000000000${incarnationIndex}`;
  fs.writeFileSync(path.join(PRESENCE, `${sessionHash}.${incarnation}.header.json`), JSON.stringify({
    schema: 1,
    sessionHash,
    incarnation,
    label,
    heartbeat,
    generation: 1,
    counts: { running: 0, queued: 0, waiting: 0, finished: 0 },
    digest: 'a'.repeat(64),
    unavailable: null,
  }));
  if (discovery) {
    fs.writeFileSync(path.join(PRESENCE, `${sessionHash}.${incarnation}.discovery.json`), JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation,
      generation: 1,
      metadata: { activation: 'b'.repeat(64), workspace, tasks: [], omitted: 0 },
    }));
  }
  return sessionHash;
}

// One published transport activation: the ONLY place a raw session id is
// published. The guard joins it to a presence header by hashing the id.
function publishTransport({ sessionId, token = 'AbCdEfGhIjKlMnOpQrStUv', createdAt = Date.now() }) {
  const base = path.join(AGENT_HOME, 'gentle-agents');
  const dir = path.join(base, 'transport', 'presence');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(base, 0o700);
    fs.chmodSync(path.join(base, 'transport'), 0o700);
    fs.chmodSync(dir, 0o700);
  } catch { /* explicit modes are best effort */ }
  const file = path.join(dir, `${sessionId}.${token}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessionId,
    endpoint: `/tmp/gentle-pi-1000/0123456789abcdef0123456789abcdef/${token}.sock`,
    createdAt,
  }), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

function makeUiCtx(repoRoot, thread = 'thread-1') {
  const notifications = [];
  const confirmations = [];
  return {
    notifications,
    confirmations,
    ctx: {
      cwd: repoRoot,
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => thread },
      ui: {
        confirm: async (title, body) => {
          confirmations.push({ title, body });
          return true;
        },
        notify: (text, level) => { notifications.push([level, text]); },
      },
    },
  };
}

let tools;
before(async () => {
  process.env.HERDR_BIN_PATH = NO_HERDR;
  process.env.GENTLE_WORKTREE_THREAD = 'thread-1';
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  delete process.env.GENTLE_PI_AGENT_HOME;
  process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
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

  // S7/S8/S9: the shared active-session guard. Every case asserts the checkout,
  // the branch and the registry row survive a refusal, and that a refusal never
  // reaches the approval question.
  test('another live Gentle Shell session in the target refuses the close', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('call-s1', { branch: 'feat/busy', changes: 'none' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-busy');
    const sessionHash = publishSession({ sessionId: 'worker-9', label: 'Worker', workspace: target });

    const closed = await tools.get('worktree_close').execute('call-s2', { name: 'feat-busy' }, undefined, undefined, ctx);
    assert.equal(closed.isError, true, 'a live session blocks the close');
    const text = resultText(closed);
    assert.match(text, /working in that checkout/);
    assert.match(text, /'Worker'/);
    assert.ok(text.includes(sessionHash.slice(0, 12)), `the refusal names the session: ${text}`);
    assert.match(text, /finish/);
    assert.match(text, /\/warp/);
    assert.match(text, /left untouched/);
    assert.ok(fs.existsSync(target), 'the checkout survives a refusal');
    assert.ok(listWorktreePaths(repo).includes(target), 'git still knows the checkout');
    assert.ok(branches(repo).includes('feat/busy'), 'the branch is untouched');
    const listed = await tools.get('worktree_list').execute('call-s3', {}, undefined, undefined, ctx);
    assert.equal(resultText(listed).split('\n').length, 3, 'the registry row is kept');
  });

  test('this session\u2019s own checkout is refused with a warp instruction, never auto-warped', async () => {
    const repo = makeRepo();
    const { ctx: creator } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('call-s4', { branch: 'feat/mine', changes: 'none' }, undefined, undefined, creator);
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-mine');
    // The session now STANDS in the checkout: no presence record is needed for
    // the deterministic cwd check to catch it.
    const { ctx } = makeCtx(target);
    const closed = await tools.get('worktree_close').execute('call-s5', { name: 'feat-mine' }, undefined, undefined, ctx);
    assert.equal(closed.isError, true);
    const text = resultText(closed);
    assert.match(text, /this session is working in that checkout/);
    assert.match(text, /\/warp/);
    assert.match(text, /left untouched/);
    assert.equal(/session warped/.test(text), false, 'the tool never warps by itself');
    assert.ok(fs.existsSync(target), 'the checkout survives the refusal');
    assert.ok(branches(repo).includes('feat/mine'), 'the branch is untouched');
  });

  test('a blocked close never asks for approval', async () => {
    const repo = makeRepo();
    const { ctx: creator } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s6', { branch: 'feat/blocked-ui', changes: 'none' }, undefined, undefined, creator);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-blocked-ui');
    publishSession({ sessionId: 'ui-worker', label: 'UI Worker', workspace: target, incarnationIndex: 2 });
    const { ctx, confirmations } = makeUiCtx(repo);
    const closed = await tools.get('worktree_close').execute('call-s7', { name: 'feat/blocked-ui' }, undefined, undefined, ctx);
    assert.equal(closed.isError, true);
    assert.equal(confirmations.length, 0, 'the session check runs before the approval question');
    assert.ok(fs.existsSync(target));
  });

  test('a live session in another checkout does not block', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s8', { branch: 'feat/free', changes: 'none' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-free');
    publishSession({ sessionId: 'other-worker', label: 'Other', workspace: repo, incarnationIndex: 3 });
    const closed = await tools.get('worktree_close').execute('call-s9', { name: 'feat-free' }, undefined, undefined, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.equal(fs.existsSync(target), false);
  });

  test('the refusal names the RAW session id joined from the transport registry', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s12', { branch: 'feat/joined', changes: 'none' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-joined');
    const sessionHash = publishSession({ sessionId: 'raw-worker-9', label: 'Raw', workspace: target, incarnationIndex: 7 });
    publishTransport({ sessionId: 'raw-worker-9' });

    const closed = await tools.get('worktree_close').execute('call-s13', { name: 'feat-joined' }, undefined, undefined, ctx);
    assert.equal(closed.isError, true);
    const text = resultText(closed);
    assert.ok(text.includes('id raw-worker-9'), text);
    assert.equal(text.includes(sessionHash.slice(0, 12)), false, 'a joined id is shown, not the hash');
    assert.equal(text.includes('could not be resolved'), false);
    assert.ok(fs.existsSync(target), 'the checkout survives the refusal');
    assert.ok(branches(repo).includes('feat/joined'), 'the branch is untouched');
  });

  test('without a transport record the refusal discloses that the id could not be resolved', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s14', { branch: 'feat/unjoined', changes: 'none' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-unjoined');
    const sessionHash = publishSession({ sessionId: 'unjoined-worker', label: 'Unjoined', workspace: target, incarnationIndex: 8 });

    const closed = await tools.get('worktree_close').execute('call-s15', { name: 'feat-unjoined' }, undefined, undefined, ctx);
    assert.equal(closed.isError, true);
    const text = resultText(closed);
    assert.ok(text.includes(sessionHash.slice(0, 12)), text);
    assert.match(text, /could not be resolved/);
    assert.match(text, /presence hash/);
    assert.ok(fs.existsSync(target), 'the checkout survives the refusal');
  });

  test('live-but-unattributable evidence is disclosed in the close output and never blocks', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s16', { branch: 'feat/advisory', changes: 'none' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-advisory');
    publishSession({ sessionId: 'legacy-peer', label: 'Legacy', workspace: null, heartbeat: Date.now(), incarnationIndex: 9, discovery: false });

    const closed = await tools.get('worktree_close').execute('call-s17', { name: 'feat-advisory' }, undefined, undefined, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.match(resultText(closed), /published no workspace/);
    assert.match(resultText(closed), /best effort/);
    assert.equal(fs.existsSync(target), false, 'the unattributable record does not block removal');
  });

  test('a stale record is disclosed as best effort and does not block', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s10', { branch: 'feat/stale', changes: 'none' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'feat-stale');
    publishSession({
      sessionId: 'crashed-worker', label: 'Crashed', workspace: target,
      heartbeat: Date.now() - 10 * 60 * 1000, incarnationIndex: 4,
    });
    const closed = await tools.get('worktree_close').execute('call-s11', { name: 'feat-stale' }, undefined, undefined, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    const text = resultText(closed);
    assert.match(text, /stale Gentle Shell presence record ignored/);
    assert.match(text, /best effort/);
    assert.equal(fs.existsSync(target), false);
    assert.ok(branches(repo).includes('feat/stale'), 'the branch is kept');
  });
});

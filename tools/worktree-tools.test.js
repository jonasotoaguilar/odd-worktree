'use strict';
// S2/S4 behavior of the two registered checkout tools, exercised through the
// REGISTERED tool objects against a real temporary repository, plus the shared
// removal the warp panel's ctrl+d drives (`executeWorktreeClose`) — the agent
// tool that used to wrap it is unregistered (T6/S4), so the close cases call it
// directly.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LIB_DIR, stubbedSource } = require('./fixtures/load-extension.js');

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

// An empty bin directory ahead of PATH keeps a create off the developer's
// PATH-dependent tooling; the rest of PATH is preserved so git still resolves.
const HOOK_BIN = path.resolve(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-hookbin-'))));

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

// S3/S4: the document this package used to keep, named so a test can assert it was
// never written.
function cloneDocument(root) {
  return path.join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'pi-worktrees.json');
}

// The abbreviation the ported listing and the create both print for the base commit.
function shortHead(root) {
  return git(root, ['rev-parse', '--short=7', 'HEAD']);
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
let extensionMod;
let extensionHooks;
before(async () => {
  process.env.GENTLE_WORKTREE_THREAD = 'thread-1';
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  delete process.env.GENTLE_PI_AGENT_HOME;
  process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
  ({ tools, mod: extensionMod, hooks: extensionHooks } = await loadExtensionWithModule({}));
});

// The create is instant on BOTH fronts, and its setup runs on the ported
// `lib/worktree-setup-runner.js` task rather than on any seam this file could
// reach; this file therefore loads the extension itself — same stubs, same lib
// override, same fake host as the shared fixture — and keeps the registrations.
async function loadExtensionWithModule(pi) {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-ext-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const mod = await import(pathToFileURL(copy).href);
    const commands = new Map();
    const tools = new Map();
    const hooks = [];
    mod.default({
      registerCommand: (name, handler) => { commands.set(name, handler); },
      registerTool: (tool) => { tools.set(tool.name, tool); },
      registerMessageRenderer: () => {},
      on: (event, handler) => { hooks.push([event, handler]); },
      ...pi,
    });
    return { mod, commands, tools, hooks };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('worktree_list', () => {
  test('a fresh repository lists its principal checkout only', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, resultText(result));
    assert.deepEqual(resultText(result).split('\n'), [
      `project: ${path.basename(repo)}`,
      `path: ${fs.realpathSync(repo)}`,
      `main: main ${shortHead(repo)}`,
    ]);
    assert.equal(result.details.worktrees.length, 1);
    assert.equal(result.details.worktrees[0].path, fs.realpathSync(repo));
    assert.equal(result.details.hiddenOutside, 0);
    assert.equal('hiddenGone' in result.details, false, 'no stored row can be gone any more');
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
  for (const existing of [false, true]) {
    test(`reports branchState ${existing ? 'existing' : 'created'} for a ${existing ? 'pre-existing' : 'new'} branch`, async () => {
      const repo = makeRepo();
      const branch = existing ? 'feat/existing' : 'feat/new';
      if (existing) git(repo, ['branch', branch]);
      const { ctx } = makeCtx(repo);
      const result = await tools.get('worktree_create').execute('call-branch', { branch, odd: 'odd-branch' }, undefined, undefined, ctx);
      assert.notEqual(result.isError, true, resultText(result));
      assert.equal(result.details.branchState, existing ? 'existing' : 'created');
      assert.ok(branches(repo).includes(branch), 'the branch exists');
    });
  }
  test('creates the checkout and writes nothing: the directory is the whole record', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_create').execute(
      'call-3',
      { branch: 'feat/x', odd: 'odd-x' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(result.isError, true, resultText(result));
    // S7: the checkout IS the ODD, so the branch (`feat/x`) names nothing on disk.
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'odd-x');
    assert.deepEqual(resultText(result).split('\n'), [
      `worktree created: ${target}`,
      'branch: feat/x (created)',
      'odd: odd-x',
      `base: main@${shortHead(repo)}`,
      'worktree register failed',
    ]);
    assert.equal(result.details.name, 'odd-x', 'the printed name is the directory basename');
    assert.ok(fs.existsSync(target), 'the checkout exists on disk');
    assert.ok(listWorktreePaths(repo).includes(target), 'git knows the checkout');
    assert.ok(branches(repo).includes('feat/x'), 'the branch exists');

    // S3/S4: no document, no row, no record. A create followed by a list leaves the
    // clone exactly as Git left it.
    assert.equal(fs.existsSync(cloneDocument(repo)), false, 'no list document is written');
    assert.equal(fs.existsSync(path.join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'pi-worktrees.lock')), false, 'no lock file is written');

    const listed = await tools.get('worktree_list').execute('call-4', {}, undefined, undefined, ctx);
    assert.deepEqual(resultText(listed).split('\n'), [
      `project: ${path.basename(repo)}`,
      `path: ${fs.realpathSync(repo)}`,
      `main: main ${shortHead(repo)}`,
      '1 odd-x feat/x',
    ]);
    assert.equal(listed.details.worktrees[1].name, 'odd-x', 'the ODD is the directory basename');
    assert.equal('odd' in listed.details.worktrees[1], false, 'the output carries no odd field');
  });

  test('an omitted odd is refused with the odd segment sentence and writes nothing', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const before = { paths: listWorktreePaths(repo), branches: branches(repo) };
    const result = await tools.get('worktree_create').execute('call-nodd', { branch: 'feat/no-odd' }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(
      resultText(result),
      'invalid odd name: undefined\nodd must be a single path segment (letters, digits, dash, underscore, dot)',
    );
    assert.deepEqual({ paths: listWorktreePaths(repo), branches: branches(repo) }, before, 'nothing was created');
    assert.equal(fs.existsSync(path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'no-odd')), false);
  });

  test('a refused odd writes neither section of the clone document', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_create').execute('call-nodd-doc', { branch: 'feat/no-odd-doc', odd: 'a/b' }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(
      resultText(result),
      'invalid odd name: "a/b"\nodd must be a single path segment (letters, digits, dash, underscore, dot)',
    );
    assert.equal(fs.existsSync(cloneDocument(repo)), false, 'no document is written');
    assert.equal(fs.existsSync(path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`)), false, 'no checkout directory');
  });

  test('the registration line only prints when the host tool accepted the path', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const registered = [];
    const hostCtx = {
      ...ctx,
      tools: [{ name: 'session_worktree_register' }],
      executeTool: async (name, args) => {
        registered.push([name, args]);
        return { isError: false };
      },
    };
    const result = await tools.get('worktree_create').execute('call-reg', { branch: 'feat/reg', odd: 'reg' }, undefined, undefined, hostCtx);
    assert.notEqual(result.isError, true, resultText(result));
    assert.match(resultText(result), /^worktree register in session$/m);
    assert.equal(result.details.registered, true);
    assert.deepEqual(registered, [
      ['session_worktree_register', { path: path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'reg') }],
    ]);
  });

  test('refuses an odd that is not one path segment, and writes nothing', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const before = { paths: listWorktreePaths(repo), branches: branches(repo) };
    const result = await tools.get('worktree_create').execute(
      'call-5',
      { branch: 'feat/login', odd: '../escape' },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(
      resultText(result),
      'invalid odd name: "../escape"\nodd must be a single path segment (letters, digits, dash, underscore, dot)',
    );
    assert.deepEqual({ paths: listWorktreePaths(repo), branches: branches(repo) }, before);
  });

  test('refuses the base branch as the worktree branch and writes nothing', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const before = { paths: listWorktreePaths(repo), branches: branches(repo) };
    const result = await tools.get('worktree_create').execute('call-6', { branch: 'main', odd: 'base' }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(resultText(result), 'branch main is the base branch; pick the branch this worktree should work on');
    assert.deepEqual({ paths: listWorktreePaths(repo), branches: branches(repo) }, before);
  });

  test('copy_changes carries the principal checkout\u2019s uncommitted changes when the call is made there', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_create').execute(
      'call-copy-principal',
      { branch: 'feat/copy-principal', odd: 'copy-principal', copy_changes: true },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(result.isError, true, resultText(result));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'copy-principal');
    assert.equal(fs.readFileSync(path.join(target, 'pending.txt'), 'utf8'), 'pending\n', 'the principal\u2019s uncommitted file travelled');
    assert.match(resultText(result), /^copy_changes: 1 changes copied$/m);
    assert.equal(fs.readFileSync(path.join(repo, 'pending.txt'), 'utf8'), 'pending\n', 'the source checkout keeps its change');
  });

  test('copy_changes carries the calling checkout\u2019s changes and never the principal\u2019s', async () => {
    const repo = makeRepo();
    const calling = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'calling');
    fs.mkdirSync(path.dirname(calling), { recursive: true });
    git(repo, ['worktree', 'add', '-b', 'feat/calling', calling]);
    fs.writeFileSync(path.join(repo, 'principal-only.txt'), 'principal\n');
    fs.writeFileSync(path.join(calling, 'calling-only.txt'), 'calling\n');
    const { ctx } = makeCtx(calling);
    const result = await tools.get('worktree_create').execute(
      'call-copy-calling',
      { branch: 'feat/copy-calling', odd: 'copy-calling', copy_changes: true },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(result.isError, true, resultText(result));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'copy-calling');
    assert.equal(fs.readFileSync(path.join(target, 'calling-only.txt'), 'utf8'), 'calling\n', 'the calling checkout\u2019s uncommitted file travelled');
    assert.equal(
      fs.existsSync(path.join(target, 'principal-only.txt')),
      false,
      'the principal\u2019s uncommitted file stays where it belongs',
    );
    assert.equal(fs.readFileSync(path.join(calling, 'calling-only.txt'), 'utf8'), 'calling\n', 'the calling checkout keeps its change');
    assert.equal(fs.readFileSync(path.join(repo, 'principal-only.txt'), 'utf8'), 'principal\n', 'the principal keeps its change');
  });
});

describe('the shared close the panel deletion drives', () => {
  test('removes the checkout and keeps the branch', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute(
      'call-7',
      { branch: 'feat/close-me', odd: 'close-me' },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'close-me');

    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-close-me' }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.equal(
      resultText(closed),
      'removed: feat-close-me · feat/close-me\nbranch kept',
      'the close reports the removal and the kept branch in its own words',
    );
    assert.deepEqual(
      { path: closed.details.path, branch: closed.details.branch, removed: closed.details.removed, branchKept: closed.details.branchKept },
      { path: target, branch: 'feat/close-me', removed: true, branchKept: true },
    );
    assert.equal(fs.existsSync(target), false, 'the checkout is gone');
    assert.equal(listWorktreePaths(repo).includes(target), false);
    assert.ok(branches(repo).includes('feat/close-me'), 'the branch is kept');

    const listed = await tools.get('worktree_list').execute('call-9', {}, undefined, undefined, ctx);
    // S3: the listing writes nothing and there is no record to go stale — a directory
    // that does not exist is simply not listed.
    assert.deepEqual(resultText(listed).split('\n'), [
      `project: ${path.basename(repo)}`,
      `path: ${fs.realpathSync(repo)}`,
      `main: main ${shortHead(repo)}`,
    ]);
  });

  test('an unknown name is refused and leaves the repository untouched', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await extensionMod.executeWorktreeClose({ name: 'nope' }, ctx);
    assert.equal(result.isError, true);
    assert.equal(
      resultText(result),
      `no registered worktree for "nope": closest worktrees: 'main' (branch 'main') at ${fs.realpathSync(repo)}`,
    );
    assert.equal(listWorktreePaths(repo).length, 1);
  });

  // S7/S8/S9: the shared active-session guard. Every case asserts the checkout,
  // the branch and the registry row survive a refusal, and that a refusal never
  // reaches the approval question.
  test('another live Gentle Shell session in the target refuses the close', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('call-s1', { branch: 'feat/busy', odd: 'busy' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'busy');
    const sessionHash = publishSession({ sessionId: 'worker-9', label: 'Worker', workspace: target });

    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-busy' }, ctx);
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
    assert.equal(resultText(listed).split('\n').length, 4, 'the registry row is kept and still listed');
  });

  test('this session\u2019s own checkout is refused with a warp instruction, never auto-warped', async () => {
    const repo = makeRepo();
    const { ctx: creator } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('call-s4', { branch: 'feat/mine', odd: 'mine' }, undefined, undefined, creator);
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'mine');
    // The session now STANDS in the checkout: no presence record is needed for
    // the deterministic cwd check to catch it.
    const { ctx } = makeCtx(target);
    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-mine' }, ctx);
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
    await tools.get('worktree_create').execute('call-s6', { branch: 'feat/blocked-ui', odd: 'blocked-ui' }, undefined, undefined, creator);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'blocked-ui');
    publishSession({ sessionId: 'ui-worker', label: 'UI Worker', workspace: target, incarnationIndex: 2 });
    const { ctx, confirmations } = makeUiCtx(repo);
    const closed = await extensionMod.executeWorktreeClose({ name: 'feat/blocked-ui' }, ctx);
    assert.equal(closed.isError, true);
    assert.equal(confirmations.length, 0, 'the session check runs before the approval question');
    assert.ok(fs.existsSync(target));
  });

  test('a live session in another checkout does not block', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s8', { branch: 'feat/free', odd: 'free' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'free');
    publishSession({ sessionId: 'other-worker', label: 'Other', workspace: repo, incarnationIndex: 3 });
    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-free' }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.equal(fs.existsSync(target), false);
  });

  test('the refusal names the RAW session id joined from the transport registry', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s12', { branch: 'feat/joined', odd: 'joined' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'joined');
    const sessionHash = publishSession({ sessionId: 'raw-worker-9', label: 'Raw', workspace: target, incarnationIndex: 7 });
    publishTransport({ sessionId: 'raw-worker-9' });

    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-joined' }, ctx);
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
    await tools.get('worktree_create').execute('call-s14', { branch: 'feat/unjoined', odd: 'unjoined' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'unjoined');
    const sessionHash = publishSession({ sessionId: 'unjoined-worker', label: 'Unjoined', workspace: target, incarnationIndex: 8 });

    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-unjoined' }, ctx);
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
    await tools.get('worktree_create').execute('call-s16', { branch: 'feat/advisory', odd: 'advisory' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'advisory');
    publishSession({ sessionId: 'legacy-peer', label: 'Legacy', workspace: null, heartbeat: Date.now(), incarnationIndex: 9, discovery: false });

    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-advisory' }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.deepEqual(
      closed.details.warnings.filter((warning) => /published no workspace|best effort/.test(warning)).length,
      closed.details.warnings.filter((warning) => /published no workspace/.test(warning)).length,
      `every caveat says it is best effort: ${JSON.stringify(closed.details.warnings)}`,
    );
    assert.ok(closed.details.warnings.some((warning) => /published no workspace/.test(warning)), JSON.stringify(closed.details.warnings));
    assert.equal(fs.existsSync(target), false, 'the unattributable record does not block removal');
  });

  test('a stale record is disclosed as best effort and does not block', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    await tools.get('worktree_create').execute('call-s10', { branch: 'feat/stale', odd: 'stale' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'stale');
    publishSession({
      sessionId: 'crashed-worker', label: 'Crashed', workspace: target,
      heartbeat: Date.now() - 10 * 60 * 1000, incarnationIndex: 4,
    });
    const closed = await extensionMod.executeWorktreeClose({ name: 'feat-stale' }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    const caveats = closed.details.warnings || [];
    assert.ok(caveats.some((warning) => /stale Gentle Shell presence record ignored/.test(warning)), JSON.stringify(caveats));
    assert.ok(caveats.some((warning) => /best effort/.test(warning)), JSON.stringify(caveats));
    assert.equal(fs.existsSync(target), false);
    assert.ok(branches(repo).includes('feat/stale'), 'the branch is kept');
  });
});

// ---------------------------------------------------------------------------
// S4/S22: the create starts the setup chain on this package's own tracked task.
// The tool returns in milliseconds, the record already says `running`, and the
// ported table's command finishes afterwards. The tool front never notifies a UI
// its call did not ask for.
// ---------------------------------------------------------------------------
describe('the create starts its setup behind the answer and persists no state', { concurrency: false }, () => {
  function binWith(name, script) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-bin-')));
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
    return dir;
  }

  test('a lockfile starts the ported install, and the create returns before it finishes', async () => {
    const repo = makeRepo();
    const markerDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-wt-marker-')));
    const argvLog = path.join(markerDir, 'argv.log');
    const doneLog = path.join(markerDir, 'done.log');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n');
    git(repo, ['add', 'package-lock.json']);
    git(repo, ['commit', '-m', 'lockfile']);
    // The shim records its argv at once, then sleeps, so "finished" is an
    // observation about the child, not about a string that happens to match.
    const bin = binWith('npm', [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${argvLog}'`,
      "printf 'npm starting\\n'",
      'sleep 1',
      "printf 'npm done\\n'",
      `printf '%s\\n' "$*" >> '${doneLog}'`,
      '',
    ].join('\n'));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'setup');
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      const { ctx, notifications } = makeCtx(repo);
      const created = await tools.get('worktree_create').execute('setup-1', { branch: 'feat/setup', odd: 'setup' }, undefined, undefined, ctx);
      assert.notEqual(created.isError, true, resultText(created));

      // S1: the create prints no setup line at all; at call time it cannot know.
      assert.doesNotMatch(resultText(created), /setup:/, 'the create reports no setup state');
      assert.equal('setup' in created.details, false);

      // Observed ordering: the command has NOT finished when the call returns.
      assert.equal(fs.existsSync(doneLog), false, 'the install was still running when the create returned');

      // S8: the chain still runs, and its log lands under the system temp
      // directory — never inside either checkout — while the clone keeps no record.
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(doneLog) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(fs.existsSync(doneLog), true, 'the install finished in the background');
      assert.deepEqual(fs.readFileSync(argvLog, 'utf8').trim().split('\n'), ['ci'], 'one npm invocation, argv ci');
      assert.equal(fs.readFileSync(doneLog, 'utf8').trim(), 'ci', 'the command completed exactly once');
      const setupLogs = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('odd-worktree-setup-'));
      assert.ok(setupLogs.length > 0, 'the task wrote its log under the system temp directory');
      for (const name of setupLogs) {
        const logPath = path.join(os.tmpdir(), name);
        assert.equal(fs.readFileSync(path.join(logPath, 'step-1.log'), 'utf8').includes('npm done'), true, 'the log carries the command output');
        assert.equal(logPath.startsWith(`${repo}${path.sep}`), false, 'the log is never inside the main checkout');
        assert.equal(logPath.startsWith(`${target}${path.sep}`), false, 'the log is never inside the created checkout');
        track(logPath);
      }

      // S3/S4: nothing about the chain is stored anywhere in the clone.
      assert.equal(fs.existsSync(cloneDocument(repo)), false, 'no setup state is persisted');
      assert.deepEqual(notifications, [], 'the tool front never notifies a UI its call did not ask for');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test('a root with no lockfile starts nothing and prints no setup line', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('setup-2', { branch: 'feat/plain', odd: 'plain' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    assert.doesNotMatch(resultText(created), /setup/, 'a skipped chain is not reported by the create either');
    assert.equal(fs.existsSync(cloneDocument(repo)), false, 'and nothing is stored to remember the skip');
  });
});

// ---- S5: the two tools draw their own cards ----
//
// The card module and the substrate have their own suites; this block proves the
// WIRING. The registered `worktree_create` and `worktree_list` definitions the
// host received must carry both render hooks, and each hook must draw its own
// tool's card at the requested width. Measurement is the host's
// `@earendil-works/pi-tui` seam, injected here exactly as the extension injects
// it at render time. With no metrics the same hooks answer plain text: a host
// without that package still shows the tool's own answer and never throws.
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => String(value).replace(ANSI, '');
const cardColumns = (value) => [...stripAnsi(value)].length;

// The same plain-ASCII text seam tools/worktree-cards.test.js injects: this
// package ships no node_modules, so measurement is always a seam.
const cardMetrics = {
  visibleWidth: (value) => cardColumns(value),
  truncateToWidth(value, width, ellipsis = '') {
    if (width <= 0) return '';
    const chars = [...stripAnsi(value)];
    if (chars.length <= width) return value;
    const tail = ellipsis ?? '';
    return chars.slice(0, Math.max(0, width - [...tail].length)).join('') + tail;
  },
  wrapTextWithAnsi(value, width) {
    const words = stripAnsi(value).split(' ');
    if (width <= 0) return [stripAnsi(value)];
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if ([...candidate].length <= width) {
        current = candidate;
        continue;
      }
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      if ([...word].length <= width) {
        current = word;
        continue;
      }
      const rest = [...word];
      while (rest.length > width) lines.push(rest.splice(0, width).join(''));
      current = rest.join('');
    }
    lines.push(current);
    return lines;
  },
};

const CARD_THEME = { fg: (_role, value) => value };

function assertCardFrame(rows, width) {
  assert.ok(rows.length >= 2, 'a card draws at least a top and a bottom row');
  for (const row of rows) {
    assert.equal(cardColumns(row), width, `"${stripAnsi(row)}" is not ${width} columns wide`);
  }
  assert.ok(stripAnsi(rows[0]).startsWith('╭'), 'the card opens with a rounded frame');
  assert.ok(stripAnsi(rows[rows.length - 1]).startsWith('╰'), 'the card closes with a rounded frame');
}

function assertResultFrame(rows, width) {
  for (const row of rows) {
    assert.equal(cardColumns(row), width, `"${stripAnsi(row)}" is not ${width} columns wide`);
  }
  assert.ok(stripAnsi(rows[0]).startsWith('│'), 'the result body sits inside the frame the call opened');
  assert.ok(stripAnsi(rows[rows.length - 1]).startsWith('╰'), 'the result closes the card');
}

describe('the two tools draw their own card (S5)', { concurrency: false }, () => {
  after(() => { extensionMod.setWorktreeToolCardMetrics(undefined); });

  test('both registered definitions carry the call and result hooks', () => {
    for (const name of ['worktree_create', 'worktree_list']) {
      const tool = tools.get(name);
      assert.equal(typeof tool.renderCall, 'function', `${name} renders its call`);
      assert.equal(typeof tool.renderResult, 'function', `${name} renders its result`);
    }
  });

  test('worktree_create renders its call and result as a framed card', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_create').execute('card-create', { branch: 'feat/card', odd: 'card' }, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, resultText(result));

    extensionMod.setWorktreeToolCardMetrics(cardMetrics);
    const tool = tools.get('worktree_create');
    const state = {};
    const callRows = tool.renderCall({ branch: 'feat/card' }, CARD_THEME, { state }).render(60);
    assertCardFrame(callRows, 60);
    assert.match(stripAnsi(callRows[0]), /worktree create/);
    assert.match(stripAnsi(callRows[0]), /feat\/card/);

    const resultRows = tool.renderResult(result, { expanded: false }, CARD_THEME, { state, durationMs: 1234 }).render(60);
    assertResultFrame(resultRows, 60);
    assert.ok(
      stripAnsi(resultRows.join('\n')).includes('worktree created:'),
      'the card body is the tool’s own answer, never a reformat',
    );
  });

  test('worktree_list renders its call and result as a framed card', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const result = await tools.get('worktree_list').execute('card-list', {}, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, resultText(result));

    extensionMod.setWorktreeToolCardMetrics(cardMetrics);
    const tool = tools.get('worktree_list');
    const state = {};
    const callRows = tool.renderCall({}, CARD_THEME, { state }).render(60);
    assertCardFrame(callRows, 60);
    assert.match(stripAnsi(callRows[0]), /worktree list/);

    const resultRows = tool.renderResult(result, { expanded: true }, CARD_THEME, { state, durationMs: 250 }).render(60);
    assertResultFrame(resultRows, 60);
    assert.ok(
      stripAnsi(resultRows.join('\n')).includes(`project: ${path.basename(repo)}`),
      'the card body is the tool’s own answer, never a reformat',
    );
  });

  test('without host metrics both hooks fall back to plain text and never throw', () => {
    extensionMod.setWorktreeToolCardMetrics(null);
    const tool = tools.get('worktree_list');
    assert.deepEqual(
      tool.renderCall({ all: true }, CARD_THEME, { state: {} }).render(60),
      ['worktree list all'],
      'the plain call names the tool and its one argument',
    );
    const result = { content: [{ type: 'text', text: 'project: demo\npath: /tmp/demo' }], details: {} };
    assert.deepEqual(
      tool.renderResult(result, { expanded: false }, CARD_THEME, { state: {} }).render(60),
      ['project: demo', 'path: /tmp/demo'],
      'the plain result IS the tool text',
    );
  });
});


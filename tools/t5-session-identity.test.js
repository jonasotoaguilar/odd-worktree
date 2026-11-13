'use strict';
// T5 durability regressions (verification blocker S7): a deletion refusal must
// name the REAL active session id, not a hash prefix and not a label.
//
// The identity is a JOIN across two published Gentle Shell stores:
//   - the presence header, keyed by `sessionHash` = sha256(sessionId)
//     (lib/orchestrator-presence.ts), which carries label, heartbeat and the
//     session's workspace;
//   - the transport activation record
//     `<agent home>/gentle-agents/transport/presence/<sessionId>.<token>.json`
//     (lib/agents-session-transport.ts), the only published place the raw id
//     appears.
// A validated transport record whose id hashes to the header's sessionHash
// names that session. Nothing else may: no label, no prefix, no saved history.
//
// These cases are written against the PUBLIC surfaces only — the two exported
// guard functions and the extension's exported `executeWorktreeClose` (the seam
// the warp panel's ctrl+d drives; the `worktree_delete` tool is unregistered,
// T6/S4) — so they keep working if internals move. Every fixture is a throwaway repository and agent
// home under the system temp directory; no real worktree, presence store or
// session is touched.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LIB_DIR, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');

const guard = require('../lib/worktree-session-guard.js');

const NOW = 1_800_000_000_000;
const TOKEN_A = 'AbCdEfGhIjKlMnOpQrStUv';
const TOKEN_B = 'ZbCdEfGhIjKlMnOpQrStUv';
const roots = [];

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function agentHome() {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), 't5-identity-home-')));
}

function checkout(tag) {
  return fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), `t5-identity-${tag}-`))));
}

const digest = (id) => crypto.createHash('sha256').update(id).digest('hex');
const incarnation = (n) => `3000000${n}-0000-4000-8000-00000000000${n}`;

function publishPresence(home, {
  sessionId, label = 'Worker', workspace = null, heartbeat = NOW, incarnationIndex = 1, discovery = true,
} = {}) {
  const dir = path.join(home, 'gentle-agents', 'presence');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const sessionHash = digest(sessionId);
  const inc = incarnation(incarnationIndex);
  fs.writeFileSync(path.join(dir, `${sessionHash}.${inc}.header.json`), JSON.stringify({
    schema: 1,
    sessionHash,
    incarnation: inc,
    label,
    heartbeat,
    generation: 1,
    counts: { running: 0, queued: 0, waiting: 0, finished: 0 },
    digest: 'a'.repeat(64),
    unavailable: null,
  }));
  if (discovery) {
    fs.writeFileSync(path.join(dir, `${sessionHash}.${inc}.discovery.json`), JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation: inc,
      generation: 1,
      metadata: { activation: 'b'.repeat(64), workspace: workspace ?? '', tasks: [], omitted: 0 },
    }));
  }
  return sessionHash;
}

function publishTransport(home, { sessionId, token = TOKEN_A, createdAt = NOW - 1000, endpoint = null } = {}) {
  const base = path.join(home, 'gentle-agents');
  const dir = path.join(base, 'transport', 'presence');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const owned of [base, path.join(base, 'transport'), dir]) {
    try { fs.chmodSync(owned, 0o700); } catch { /* best effort */ }
  }
  const file = path.join(dir, `${sessionId}.${token}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessionId,
    endpoint: endpoint ?? `/tmp/gentle-pi-1000/0123456789abcdef0123456789abcdef/${token}.sock`,
    createdAt,
  }), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

async function readStores(home) {
  const env = { PI_CODING_AGENT_DIR: home };
  return {
    presence: await guard.readGentlePresence({ env, now: NOW }),
    transport: await guard.readTransportSessions({ env }),
  };
}

async function evaluate(target, home, extra = {}) {
  const { presence, transport } = await readStores(home);
  return guard.evaluateCheckoutSessions({
    targetPath: target, presence, transport, now: NOW, ...extra,
  });
}

describe('S7 identity join: hash -> raw session id', () => {
  test('the raw id is resolved deterministically from its own transport record', async () => {
    const home = agentHome();
    const target = checkout('resolve');
    const sessionHash = publishPresence(home, { sessionId: 'worker-alpha', label: 'Alpha', workspace: target });
    publishTransport(home, { sessionId: 'worker-alpha' });
    assert.equal(digest('worker-alpha'), sessionHash, 'the presence hash is sha256 of the published id');

    const result = await evaluate(target, home);
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].rawSessionId, 'worker-alpha');
    assert.ok(result.text.includes('id worker-alpha'), result.text);
    assert.equal(result.text.includes(sessionHash.slice(0, 12)), false, 'never the hash when the id resolves');
    assert.equal(result.evidence.resolved, 1);
    assert.equal(result.evidence.unresolved, 0);
  });

  test('another session never lends its id to this hash', async () => {
    const home = agentHome();
    const target = checkout('cross');
    publishPresence(home, { sessionId: 'worker-alpha', label: 'Alpha', workspace: target });
    publishTransport(home, { sessionId: 'worker-beta', token: TOKEN_B });
    const result = await evaluate(target, home);
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, null);
    assert.equal(result.text.includes('worker-beta'), false);
    assert.match(result.text, /could not be resolved/);
  });

  test('no transport record means the refusal DISCLOSES the unresolved id', async () => {
    const home = agentHome();
    const target = checkout('nojoin');
    const sessionHash = publishPresence(home, { sessionId: 'worker-alpha', label: 'Alpha', workspace: target });
    const result = await evaluate(target, home);
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, null);
    assert.ok(result.text.includes(`presence ${sessionHash.slice(0, 12)}`), result.text);
    assert.match(result.text, /published no transport record/);
    assert.match(result.text, /could not be resolved/);
    assert.equal(result.evidence.unresolved, 1);
  });

  test('the record body and the endpoint are never read beyond the published keys', async () => {
    const home = agentHome();
    const target = checkout('no-secret');
    publishPresence(home, { sessionId: 'worker-alpha', label: 'Alpha', workspace: target });
    // A readable file where the endpoint string points: nothing may open it.
    const endpointDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 't5-identity-endpoint-')));
    const secretFile = path.join(endpointDir, 'transcript.jsonl');
    fs.writeFileSync(secretFile, '{"secret":"must-not-be-read"}\n');
    publishTransport(home, { sessionId: 'worker-alpha', endpoint: secretFile });
    const result = await evaluate(target, home);
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, 'worker-alpha', 'the join only needs sessionId');
    assert.equal(JSON.stringify(result).includes('must-not-be-read'), false);
  });

  test('the current session keeps its warp-first refusal, joined or not', async () => {
    const home = agentHome();
    const target = checkout('self');
    publishPresence(home, { sessionId: 'mine', label: 'Me', workspace: target });
    publishTransport(home, { sessionId: 'mine' });
    const result = await evaluate(target, home, { currentSessionId: 'mine' });
    assert.equal(result.verdict, 'current');
    assert.match(result.text, /this session is working in that checkout/);
    assert.match(result.text, /\/warp/);
  });
});

describe('S7 identity join through the removal the panel drives', () => {
  const savedEnv = { ...process.env };
  const HOOK_BIN = track(fs.mkdtempSync(path.join(os.tmpdir(), 't5-identity-hookbin-')));
  const AGENT_HOME = agentHome();

  let tools;
  let mod;
  before(async () => {
    process.env.GENTLE_WORKTREE_THREAD = 't5-thread';
    delete process.env.GENTLE_PI_AGENT_HOME;
    process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
    process.env.PATH = `${HOOK_BIN}${path.delimiter}${process.env.PATH || ''}`;
    ({ tools } = await loadExtension({}));
    mod = await loadStubbedModule();
  });

  // The removal these refusals are observed through is the extension module's
  // exported close — the seam the warp panel's ctrl+d drives. The
  // `worktree_delete` TOOL that used to wrap it is unregistered (T6/S4), so the
  // namespace is loaded beside the registrations: same stubs, same lib override.
  async function loadStubbedModule() {
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't5-identity-mod-'));
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

  function makeRepo(tag) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `t5-identity-repo-${tag}-`)));
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
      sessionManager: { getSessionId: () => 't5-session' },
      ui: { confirm: async () => true, notify: () => {} },
    };
  }

  function resultText(result) {
    return (result.content || []).map((part) => (part && part.text) || '').join('\n');
  }

  test('the refusal shows the raw id and leaves the checkout, branch and registry intact', async () => {
    const repo = makeRepo('joined');
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('t5-c1', { branch: 'feat/t5-joined', odd: 't5-joined' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 't5-joined');
    const sessionHash = publishPresence(AGENT_HOME, { sessionId: 'raw-session-7', label: 'Worker', workspace: target, heartbeat: Date.now(), incarnationIndex: 4 });
    publishTransport(AGENT_HOME, { sessionId: 'raw-session-7' });

    const closed = await mod.executeWorktreeClose({ name: 'feat-t5-joined' }, ctx);
    assert.equal(closed.isError, true);
    const text = resultText(closed);
    assert.ok(text.includes('id raw-session-7'), text);
    assert.equal(text.includes(sessionHash.slice(0, 12)), false);
    assert.equal(closed.details.sessionCheck.resolved, 1);
    assert.equal(closed.details.sessionCheck.unresolved, 0);
    // Nothing was mutated: the checkout, git's listing, the branch and the row.
    assert.ok(fs.existsSync(target), 'the checkout survives');
    assert.ok(git(repo, ['worktree', 'list', '--porcelain']).includes(target), 'git still lists it');
    assert.ok(git(repo, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/t5-joined'), 'the branch survives');
    const listed = await tools.get('worktree_list').execute('t5-c3', {}, undefined, undefined, ctx);
    assert.equal(resultText(listed).split('\n').length, 4, 'the registry row survives');
  });

  test('the refusal discloses an unresolved id instead of inventing one', async () => {
    const repo = makeRepo('unjoined');
    const ctx = makeCtx(repo);
    await tools.get('worktree_create').execute('t5-c4', { branch: 'feat/t5-unjoined', odd: 't5-unjoined' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 't5-unjoined');
    const sessionHash = publishPresence(AGENT_HOME, { sessionId: 'raw-session-8', label: 'Worker', workspace: target, heartbeat: Date.now(), incarnationIndex: 5 });

    const closed = await mod.executeWorktreeClose({ name: 'feat-t5-unjoined' }, ctx);
    assert.equal(closed.isError, true);
    const text = resultText(closed);
    assert.ok(text.includes(`presence ${sessionHash.slice(0, 12)}`), text);
    assert.match(text, /could not be resolved/);
    assert.equal(closed.details.sessionCheck.unresolved, 1);
    assert.ok(fs.existsSync(target), 'the checkout survives');
  });

  test('the clear path shows the best-effort notices and still removes the checkout', async () => {
    const repo = makeRepo('notices');
    const ctx = makeCtx(repo);
    await tools.get('worktree_create').execute('t5-c6', { branch: 'feat/t5-notice', odd: 't5-notice' }, undefined, undefined, ctx);
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 't5-notice');
    // A live peer whose discovery sidecar never published a workspace: it can
    // never be attributed to this checkout, and it must never block.
    publishPresence(AGENT_HOME, { sessionId: 'legacy-peer', label: 'Legacy', heartbeat: Date.now(), incarnationIndex: 6, discovery: false });

    const closed = await mod.executeWorktreeClose({ name: 'feat-t5-notice' }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    assert.ok(Array.isArray(closed.details.warnings) && closed.details.warnings.length > 0, 'the notice travels in details');
    assert.ok(
      closed.details.warnings.some((warning) => /published no workspace/.test(warning)),
      JSON.stringify(closed.details.warnings),
    );
    assert.ok(
      closed.details.warnings.every((warning) => /best effort/.test(warning)),
      `every caveat is disclosed as best effort: ${JSON.stringify(closed.details.warnings)}`,
    );
    assert.equal(fs.existsSync(target), false, 'the notice never blocks the removal');
  });
});

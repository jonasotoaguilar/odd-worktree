'use strict';
// S4: a warp never lands while THIS session still has running agent tasks.
//
// The counters come from Gentle Shell's published presence store (one header
// per live session, validated and bounded by lib/worktree-session-guard.js), so
// the tests publish a header for their own session id and drive both fronts:
// the `worktree_warp` tool (which must queue NOTHING) and the `/warp` command
// (which must refuse instead of switching).
//
// Background jobs are deliberately NOT asserted: gentle-shell keeps them in
// memory and publishes no durable, session-attributable evidence, so no test
// could prove that half.
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

const HOOK_BIN = path.resolve(track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-hookbin-'))));
fs.writeFileSync(path.join(HOOK_BIN, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const NO_HERDR = path.join(os.tmpdir(), 'odd-worktree-no-such-herdr-binary');
const AGENT_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-agent-home-')));
const PRESENCE = path.join(AGENT_HOME, 'gentle-agents', 'presence');
const SESSION_ID = 'thread-1';
const SESSION_HASH = crypto.createHash('sha256').update(SESSION_ID).digest('hex');

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-repo-')));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

// One published header for THIS session. `counts` is the only thing under test;
// the digest/incarnation shapes are what the reader validates.
function publishSession({ running = 0, queued = 0, waiting = 0, heartbeat = Date.now(), label = 'Busy session' } = {}) {
  fs.mkdirSync(PRESENCE, { recursive: true, mode: 0o700 });
  fs.chmodSync(PRESENCE, 0o700);
  const incarnation = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(PRESENCE, `${SESSION_HASH}.${incarnation}.header.json`), JSON.stringify({
    schema: 1,
    sessionHash: SESSION_HASH,
    incarnation,
    label,
    heartbeat,
    generation: 1,
    counts: { running, queued, waiting, finished: 0 },
    digest: 'c'.repeat(64),
    unavailable: null,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(PRESENCE, `${SESSION_HASH}.${incarnation}.discovery.json`), JSON.stringify({
    schema: 1, sessionHash: SESSION_HASH, incarnation, generation: 1,
    metadata: { activation: 'd'.repeat(64), workspace: '/tmp/workspace', tasks: [], omitted: 0 },
  }), { mode: 0o600 });
}

function clearPresence() {
  try { fs.rmSync(PRESENCE, { recursive: true, force: true }); } catch { /* absent is fine */ }
}

const notifications = [];
function makeCtx(cwd, extra = {}) {
  const switches = [];
  return {
    switches,
    ctx: {
      cwd,
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => SESSION_ID },
      ui: {
        notify: (text, level) => { notifications.push([level, text]); },
        ...extra,
      },
      waitForIdle: async () => {},
      switchSession: async (file) => { switches.push(file); return { cancelled: false }; },
    },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => (part && part.text) || '').join('\n');
}

let host;
let commands;
let tools;
before(async () => {
  process.env.HERDR_BIN_PATH = NO_HERDR;
  process.env.GENTLE_WORKTREE_THREAD = SESSION_ID;
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  delete process.env.GENTLE_PI_AGENT_HOME;
  process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
  // The command front's wait is bounded by this budget; tests never wait.
  process.env.ODD_WORKTREE_WARP_BUSY_WAIT_MS = '0';
  const sent = [];
  const loaded = await loadExtension({ sendUserMessage: (text, options) => { sent.push([text, options]); } });
  host = loaded.host;
  host.sent = sent;
  commands = loaded.commands;
  tools = loaded.tools;
});

describe('lib/worktree-warp-busy.js', () => {
  const busyLib = require('../lib/worktree-warp-busy.js');

  test('reads only this session’s own counters', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-lib-')));
    const dir = path.join(home, 'gentle-agents', 'presence');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mine = crypto.createHash('sha256').update('session-a').digest('hex');
    const other = crypto.createHash('sha256').update('session-b').digest('hex');
    const write = (hash, running) => fs.writeFileSync(path.join(dir, `${hash}.11111111-2222-4333-8444-555555555555.header.json`), JSON.stringify({
      schema: 1, sessionHash: hash, incarnation: '11111111-2222-4333-8444-555555555555',
      label: 'L', heartbeat: 1000, generation: 1,
      counts: { running, queued: 0, waiting: 0, finished: 0 },
      digest: 'e'.repeat(64), unavailable: null,
    }));
    write(mine, 2);
    write(other, 7);

    const activity = await busyLib.sessionActivity({ sessionId: 'session-a', env: { PI_CODING_AGENT_DIR: home }, now: 1000 });
    assert.equal(activity.status, 'ok');
    assert.equal(activity.running, 2);
    assert.equal(activity.busy, true);
  });

  test('a missing store is unavailable and blocks nothing', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-empty-')));
    const activity = await busyLib.sessionActivity({ sessionId: 'session-a', env: { PI_CODING_AGENT_DIR: home } });
    assert.equal(activity.status, 'unavailable');
    assert.equal(activity.busy, false);
  });

  test('a stale heartbeat is not evidence of running work', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-stale-')));
    const dir = path.join(home, 'gentle-agents', 'presence');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mine = crypto.createHash('sha256').update('session-a').digest('hex');
    fs.writeFileSync(path.join(dir, `${mine}.11111111-2222-4333-8444-555555555555.header.json`), JSON.stringify({
      schema: 1, sessionHash: mine, incarnation: '11111111-2222-4333-8444-555555555555',
      label: 'L', heartbeat: 1000, generation: 1,
      counts: { running: 3, queued: 0, waiting: 0, finished: 0 },
      digest: 'e'.repeat(64), unavailable: null,
    }));
    const activity = await busyLib.sessionActivity({ sessionId: 'session-a', env: { PI_CODING_AGENT_DIR: home }, now: 600000 });
    assert.equal(activity.status, 'ok');
    assert.equal(activity.busy, false);
  });

  test('the bounded wait drains, and reports when the budget runs out', async () => {
    const answers = [
      { busy: true, running: 2, queued: 0, label: 'L', status: 'ok' },
      { busy: true, running: 1, queued: 0, label: 'L', status: 'ok' },
      { busy: false, running: 0, queued: 0, label: 'L', status: 'ok' },
    ];
    let index = 0;
    const slept = [];
    const drained = await busyLib.waitForSessionActivity({
      read: async () => answers[Math.min(index++, answers.length - 1)],
      sleep: async (ms) => { slept.push(ms); },
      waitMs: 6000,
      pollMs: 2000,
    });
    assert.equal(drained.activity.busy, false);
    assert.equal(drained.waitedOut, false);
    assert.deepEqual(slept, [2000, 2000]);

    const never = await busyLib.waitForSessionActivity({
      read: async () => ({ busy: true, running: 1, queued: 0, label: 'L', status: 'ok' }),
      sleep: async () => {},
      waitMs: 3000,
      pollMs: 2000,
    });
    assert.equal(never.waitedOut, true);
    assert.equal(never.waited, 3000);
  });

  test('the refusal text names agent tasks and admits jobs are invisible', () => {
    const text = busyLib.busyText({ running: 2, queued: 1, label: 'Worker' });
    assert.match(text, /2 running and 1 queued agent task\(s\) on "Worker"/);
    assert.match(text, /background jobs are not visible here/);
  });
});

describe('warp fronts while this session is busy', () => {
  test('the tool queues nothing while an agent task is running', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-1', { branch: 'feat/busy', changes: 'none' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 1 });
    host.sent.length = 0;
    const refused = await tools.get('worktree_warp').execute('busy-2', { name: 'feat-busy' }, undefined, undefined, ctx);
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), /^worktree warp: this session still has 1 running agent task\(s\)/);
    assert.equal(host.sent.length, 0, 'nothing may be queued while a task runs');
    assert.equal(refused.details.busy, true);
  });

  test('the tool queues the handoff once the counters drain', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-3', { branch: 'feat/free', changes: 'none' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 0 });
    host.sent.length = 0;
    const queued = await tools.get('worktree_warp').execute('busy-4', { name: 'feat-free' }, undefined, undefined, ctx);
    assert.notEqual(queued.isError, true, resultText(queued));
    assert.match(resultText(queued), /^worktree warp: handoff queued/);
    assert.equal(host.sent.length, 1);
  });

  test('the command refuses and never switches while an agent task is running', async () => {
    const repo = makeRepo();
    const { ctx, switches } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-5', { branch: 'feat/busy-cmd', changes: 'none' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 2 });
    notifications.length = 0;
    await commands.get('warp').handler('feat-busy-cmd', ctx);
    assert.equal(switches.length, 0, 'the session must not move under a running task');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0], 'error');
    assert.match(notifications[0][1], /^worktree warp: this session still has 2 running agent task\(s\)/);
  });

  test('an unavailable presence store does not block the command', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-6', { branch: 'feat/no-store', changes: 'none' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    clearPresence();
    notifications.length = 0;
    await commands.get('warp').handler('feat-no-store', ctx);
    // Whatever this minimal host context can or cannot do later, the busy
    // refusal must not appear: without evidence nothing is claimed to be busy.
    const busyRefusals = notifications.filter(([, text]) => /still has .* agent task/.test(String(text)));
    assert.deepEqual(busyRefusals, [], `no busy refusal without evidence: ${JSON.stringify(notifications)}`);
  });
});

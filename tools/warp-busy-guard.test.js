'use strict';
// S4/S5/S9: a warp waits for THIS session's own background work — its agent
// tasks AND its background jobs — and the request is QUEUED while that work runs.
//
// Two sources are driven here:
//   - the agent-task counters, published in Gentle Shell's presence store (one
//     header per live session, validated and bounded by
//     lib/worktree-session-guard.js), which the tests write for their own id;
//   - the `job_list` host tool, reached through `ctx.tools` + `ctx.executeTool`
//     (the same seam `session_worktree_register` uses), whose text is one line
//     per job: `job-1 · running · Probe · 3s · /tmp/…/job-1.log`.
//
// The front is driven through the public surface: `/warp`, which validates the
// request, keeps it PENDING and re-dispatches the SAME validated handoff once
// neither workload is running. A pending warp is never replaced: a second
// request — including one in the same turn — is refused. (T6/S3: the
// `worktree_warp` TOOL is no longer registered, so there is no second front.)
//
// A job whose status field is not running/queued is finished, a `job_list` that
// is missing, fails or answers in an unknown shape is UNKNOWN (never "no jobs"),
// and unknown blocks nothing.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LIB_DIR, loadExtension, stubbedSource } = require('./fixtures/load-extension.js');
const busyLib = require('../lib/worktree-warp-busy.js');

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
const NO_HERDR = path.join(os.tmpdir(), 'odd-worktree-no-such-herdr-binary');
const AGENT_HOME = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-agent-home-')));
const PRESENCE = path.join(AGENT_HOME, 'gentle-agents', 'presence');
const SESSION_ID = 'thread-1';
const SESSION_HASH = crypto.createHash('sha256').update(SESSION_ID).digest('hex');
const INCARNATION = '11111111-2222-4333-8444-555555555555';

function pendingKey() {
  return busyLib.pendingKeyFor({ sessionId: SESSION_ID });
}

function settlePending() {
  busyLib.settlePendingWarp(pendingKey());
}

// The queue is ONE record per session, held in this process and shared by every
// test in this file: each test clears its own, and this backstop keeps an
// unrelated assertion failure from leaking a record into the tests after it.
afterEach(() => { settlePending(); });

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
  fs.writeFileSync(path.join(PRESENCE, `${SESSION_HASH}.${INCARNATION}.header.json`), JSON.stringify({
    schema: 1,
    sessionHash: SESSION_HASH,
    incarnation: INCARNATION,
    label,
    heartbeat,
    generation: 1,
    counts: { running, queued, waiting, finished: 0 },
    digest: 'c'.repeat(64),
    unavailable: null,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(PRESENCE, `${SESSION_HASH}.${INCARNATION}.discovery.json`), JSON.stringify({
    schema: 1, sessionHash: SESSION_HASH, incarnation: INCARNATION, generation: 1,
    metadata: { activation: 'd'.repeat(64), workspace: '/tmp/workspace', tasks: [], omitted: 0 },
  }), { mode: 0o600 });
}

function clearPresence() {
  try { fs.rmSync(PRESENCE, { recursive: true, force: true }); } catch { /* absent is fine */ }
}

// A bounded wait for a background poller/timer to become observable. The budgets
// are injected (env or pendingWarpTick), so nothing here waits on a real warp.
async function until(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const notifications = [];
function makeCtx(cwd, extra = {}) {
  return {
    cwd,
    hasUI: true,
    mode: 'tui',
    sessionManager: { getSessionId: () => SESSION_ID },
    ui: {
      notify: (text, level) => { notifications.push([level, text]); },
      ...extra,
    },
    waitForIdle: async () => {},
    switchSession: async () => ({ cancelled: false }),
  };
}

// This session's background jobs, as the host's `job_list` tool reports them:
// one line per job, `id · status · label · elapsed · log`. `mode` selects the
// other answers a host can give instead of a job list: `absent` (the tool is not
// registered), `error` (the call fails) and `unparsable` (a shape the parser does
// not know). Returns the mutable state the test drives.
function addJobs(ctx, jobs = [], mode = 'ok') {
  const state = { jobs, mode, calls: 0 };
  ctx.tools = mode === 'absent' ? [] : [{ name: 'job_list' }];
  ctx.executeTool = async (name) => {
    if (name !== 'job_list') return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
    state.calls += 1;
    if (state.mode === 'error') return { isError: true, content: [{ type: 'text', text: 'job_list failed' }] };
    if (state.mode === 'unparsable') return { content: [{ type: 'text', text: 'something else entirely' }] };
    const lines = state.jobs.map((job) => `${job.id} · ${job.status} · ${job.label || 'Probe de job'} · 3s · /tmp/gentle-jobs-1/${job.id}.log`);
    return { content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'No background jobs in this session.' }] };
  };
  return state;
}

// The minimal host session manager a warp needs: an empty session (no entries)
// changes PATH through `create` + `switchSession`, which is the cheapest real
// move a test can drive end to end.
function makeSessionHost(world) {
  class FakeSession {
    constructor(cwd, file, header) {
      this.cwd = cwd;
      this.file = file;
      this.header = header;
    }

    getSessionFile() { return this.file; }

    getSessionDir() { return world.sessionDir; }

    getSessionId() { return SESSION_ID; }

    getSessionName() { return ''; }

    getHeader() { return this.header; }

    getEntries() { return []; }

    getLeafId() { return null; }

    static create(cwd, dir) {
      world.created += 1;
      const file = path.join(dir || world.sessionDir, `created-${world.created}.jsonl`);
      world.createdFiles.push(file);
      return new FakeSession(cwd, file, { type: 'session', version: 3, id: `id-${world.created}`, timestamp: 1, cwd });
    }

    static forkFrom() {
      throw new Error('an empty session must never fork');
    }
  }
  return FakeSession;
}

// A ctx that can really MOVE: an empty session changes PATH through `create` +
// `switchSession` (the cheapest real move a test can drive), and every switch is
// recorded so "nothing moved" is an observation instead of an absence.
function movableCtx(repo) {
  const world = { sessionDir: track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-sessions-'))), created: 0, createdFiles: [] };
  const SM = makeSessionHost(world);
  const switches = [];
  const ctx = makeCtx(repo);
  ctx.sessionManager = Object.assign(new SM(null, null, null), { getSessionId: () => SESSION_ID });
  ctx.sessionManager.constructor = SM;
  ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
  return { ctx, switches };
}

let host;
let commands;
let tools;
let hooks;
let mod;
before(async () => {
  process.env.HERDR_BIN_PATH = NO_HERDR;
  process.env.GENTLE_WORKTREE_THREAD = SESSION_ID;
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  delete process.env.GENTLE_PI_AGENT_HOME;
  process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
  // The command front's bounded drain attempt: tests never wait for it.
  process.env.ODD_WORKTREE_WARP_BUSY_WAIT_MS = '0';
  // The queue's lifetime and poll interval are injected per test; these defaults
  // keep the poller quiet while a test drives `pendingWarpTick` itself.
  process.env.ODD_WORKTREE_WARP_PENDING_MS = '600000';
  process.env.ODD_WORKTREE_WARP_PENDING_POLL_MS = '60000';
  const sent = [];
  const loaded = await loadExtension({ sendUserMessage: (text, options) => { sent.push([text, options]); } });
  host = loaded.host;
  host.sent = sent;
  commands = loaded.commands;
  tools = loaded.tools;
  hooks = loaded.hooks;
  mod = await loadStubbedModule();
});

// The extension module's own exported seams (the removal path the panel drives)
// are not part of the registration surface, so this file loads the same stubbed
// module the shared fixture copies and keeps the namespace beside the tools.
async function loadStubbedModule() {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-mod-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    return await import(pathToFileURL(copy).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function resultText(result) {
  return (result.content || []).map((part) => (part && part.text) || '').join('\n');
}

// ---------------------------------------------------------------------------
// The module itself: counters, texts and the pending queue (injected clock).
// ---------------------------------------------------------------------------
describe('lib/worktree-warp-busy.js', () => {
  test('reads only this session’s own counters', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-lib-')));
    const dir = path.join(home, 'gentle-agents', 'presence');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mine = crypto.createHash('sha256').update('session-a').digest('hex');
    const other = crypto.createHash('sha256').update('session-b').digest('hex');
    const write = (hash, running) => fs.writeFileSync(path.join(dir, `${hash}.${INCARNATION}.header.json`), JSON.stringify({
      schema: 1, sessionHash: hash, incarnation: INCARNATION,
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
    fs.writeFileSync(path.join(dir, `${mine}.${INCARNATION}.header.json`), JSON.stringify({
      schema: 1, sessionHash: mine, incarnation: INCARNATION,
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

  test('the queue texts name both workloads and no longer disclaim jobs', () => {
    assert.equal(
      busyLib.queuedText({ running: 2, queued: 1, jobs: { active: 1, status: 'ok' } }),
      'handoff queued — waiting for 2 running agent task(s) and 1 queued agent task(s) and 1 running background job before the move',
    );
    assert.equal(
      busyLib.queuedText({ running: 0, queued: 0, jobs: { active: 2, status: 'ok' } }),
      'handoff queued — waiting for 2 running background jobs before the move',
    );
    assert.equal(busyLib.queuedText({ running: 1, jobs: { active: 0, status: 'ok' } }), 'handoff queued — waiting for 1 running agent task(s) before the move');
    // The old disclaimer is gone now that jobs are covered.
    assert.equal(/not observable/.test(busyLib.queuedText({ running: 1, jobs: { active: 0, status: 'ok' } })), false);
    assert.equal(/not observable/.test(busyLib.expiredText('feat-x', 30)), false);

    assert.equal(busyLib.jobsUnknownText({ jobs: { status: 'ok', active: 0 } }), '', 'a readable job list needs no caveat');
    assert.match(
      busyLib.jobsUnknownText({ jobs: { status: 'unavailable' } }),
      /^the background-job state is unknown \(job_list is not available on this host\), so confirm any bash_background or monitor job finished$/,
    );
    assert.match(busyLib.jobsUnknownText({ jobs: { status: 'error' } }), /unknown \(job_list failed\)/);
    assert.match(busyLib.jobsUnknownText({ jobs: { status: 'unparsable' } }), /unknown \(job_list answered in an unexpected shape\)/);

    assert.match(busyLib.expiredText('feat-x', 30), /the pending warp to feat-x expired after 30 min with nothing moved/);
    assert.match(busyLib.expiredText('feat-x', 30), /agent tasks and background jobs finish/);
    assert.match(busyLib.expiredText('feat-x', 30, { jobs: { status: 'error' } }), /\(the background-job state is unknown \(job_list failed\)/);
    assert.match(
      busyLib.pendingWarpRefusalText({ name: 'feat-x' }, 'feat-y'),
      /^a warp to feat-x is already pending for this session — it runs when the pending agent tasks and background jobs finish; wait for it or let it expire$/,
    );
  });

  test('a job is active only while its status field says running or queued', () => {
    const line = (status) => `job-1 · ${status} · Probe de job · 3s · /tmp/gentle-jobs-1/job-1.log`;
    assert.deepEqual(busyLib.parseJobList(line('running')), { status: 'ok', active: 1, count: 1 });
    assert.deepEqual(busyLib.parseJobList(line('queued')), { status: 'ok', active: 1, count: 1 });
    assert.deepEqual(busyLib.parseJobList(`m-1 · monitor running · Watch · 4s · /tmp/gentle-jobs-1/m-1.log`), { status: 'ok', active: 1, count: 1 });
    for (const finished of ['exited 0', 'failed 1', 'stopped', 'monitor stopped']) {
      assert.deepEqual(busyLib.parseJobList(line(finished)), { status: 'ok', active: 0, count: 1 }, `${finished} is finished, never active`);
    }
    assert.equal(busyLib.parseJobList(`${line('running')}\n${line('exited 0')}`).active, 1, 'only the running row counts');
    assert.deepEqual(busyLib.parseJobList('No background jobs in this session.'), { status: 'ok', active: 0, count: 0 });
    assert.deepEqual(busyLib.parseJobList(''), { status: 'ok', active: 0, count: 0 });
    assert.equal(busyLib.parseJobList('job-1 is doing something').status, 'unparsable', 'an unknown shape is not an empty list');
  });

  test('sessionActivity merges this session’s jobs through the host tool', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-jobs-')));
    const plain = makeCtx(os.tmpdir());
    const ctx = makeCtx(os.tmpdir());
    const jobs = addJobs(ctx, [{ id: 'job-1', status: 'running' }]);

    const running = await busyLib.sessionActivity({ sessionId: SESSION_ID, env: { PI_CODING_AGENT_DIR: home }, host: ctx });
    assert.equal(running.jobs.status, 'ok');
    assert.equal(running.jobs.active, 1);
    assert.equal(running.jobsUnknown, false);
    assert.equal(running.busy, true, 'a running job alone makes the session busy');
    assert.equal(jobs.calls, 1);

    jobs.jobs[0].status = 'exited 0';
    const done = await busyLib.sessionActivity({ sessionId: SESSION_ID, env: { PI_CODING_AGENT_DIR: home }, host: ctx });
    assert.equal(done.jobs.active, 0);
    assert.equal(done.busy, false, 'a finished job is not work');

    const noTool = await busyLib.sessionActivity({ sessionId: SESSION_ID, env: { PI_CODING_AGENT_DIR: home }, host: plain });
    assert.equal(noTool.jobs.status, 'unavailable', 'no host seam is unknown, never "no jobs"');
    assert.equal(noTool.jobsUnknown, true);
    assert.equal(noTool.busy, false, 'an unknown job state blocks nothing');
  });

  test('the wait, pending and poll budgets are parsed, defaulted and clamped', () => {
    assert.equal(busyLib.DEFAULT_WAIT_MS, 60000);
    assert.equal(busyLib.MAX_WAIT_MS, 600000);
    assert.equal(busyLib.waitBudgetMs({}), 60000);
    assert.equal(busyLib.waitBudgetMs({ ODD_WORKTREE_WARP_BUSY_WAIT_MS: '' }), 60000);
    assert.equal(busyLib.waitBudgetMs({ ODD_WORKTREE_WARP_BUSY_WAIT_MS: '5000' }), 5000);
    assert.equal(busyLib.waitBudgetMs({ ODD_WORKTREE_WARP_BUSY_WAIT_MS: '-1' }), 60000);
    assert.equal(busyLib.waitBudgetMs({ ODD_WORKTREE_WARP_BUSY_WAIT_MS: 'abc' }), 60000);
    assert.equal(busyLib.waitBudgetMs({ ODD_WORKTREE_WARP_BUSY_WAIT_MS: '999999999' }), 600000);

    assert.equal(busyLib.DEFAULT_PENDING_MS, 30 * 60 * 1000);
    assert.equal(busyLib.pendingBudgetMs({}), 30 * 60 * 1000);
    assert.equal(busyLib.pendingBudgetMs({ ODD_WORKTREE_WARP_PENDING_MS: '1500' }), 1500);
    assert.equal(busyLib.pendingBudgetMs({ ODD_WORKTREE_WARP_PENDING_MS: 'nope' }), 30 * 60 * 1000);
    assert.equal(busyLib.pendingBudgetMs({ ODD_WORKTREE_WARP_PENDING_MS: '999999999999' }), busyLib.MAX_PENDING_MS);
    assert.equal(busyLib.pendingPollMs({}), busyLib.DEFAULT_PENDING_POLL_MS);
    assert.equal(busyLib.pendingPollMs({ ODD_WORKTREE_WARP_PENDING_POLL_MS: '999999999999' }), busyLib.MAX_PENDING_POLL_MS);
  });

  test('the queue keys on the session id, then on the checkout root', () => {
    assert.equal(busyLib.pendingKeyFor({ sessionId: 's-1', root: '/repo' }), 'session:s-1');
    assert.equal(busyLib.pendingKeyFor({ sessionId: '', root: '/repo' }), 'root:/repo');
    assert.equal(busyLib.pendingKeyFor({}), null);
    assert.equal(busyLib.pendingKeyFor(null), null);
  });

  test('sameWarpHandoff matches only the same move and change selection', () => {
    const base = { name: 'feat-x', target: '/t', from: '/f', branch: 'feat/x', changes: { mode: 'none', paths: [] } };
    assert.equal(busyLib.sameWarpHandoff(base, { ...base }), true);
    assert.equal(busyLib.sameWarpHandoff(base, { ...base, changes: { mode: 'all', paths: [] } }), false);
    assert.equal(busyLib.sameWarpHandoff(base, { ...base, changes: { mode: 'paths', paths: ['a'] } }), false);
    assert.equal(busyLib.sameWarpHandoff(base, { ...base, target: '/other' }), false);
    assert.equal(busyLib.sameWarpHandoff(base, null), false);
  });

  test('the pending warp waits for the counters, then dispatches the same handoff once', async () => {
    const key = 'session:lib-queue';
    const clock = { now: 1000 };
    const dispatched = [];
    const handoff = { name: 'feat-q', target: '/t', from: '/f', branch: 'feat/q', changes: { mode: 'none', paths: [] } };
    let activity = { busy: true, running: 2, queued: 0 };
    const queued = busyLib.queuePendingWarp({
      key,
      name: 'feat-q',
      token: '@token',
      handoff,
      now: () => clock.now,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '10000', ODD_WORKTREE_WARP_PENDING_POLL_MS: '1000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => activity,
      dispatch: (queuedHandoff, token) => { dispatched.push([queuedHandoff, token]); return { ok: true }; },
    });
    try {
      assert.equal(queued.ok, true);
      assert.equal(busyLib.pendingWarpFor(key).name, 'feat-q');
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'waiting');
      assert.deepEqual(dispatched, [], 'a busy session dispatches nothing');

      activity = { busy: false, running: 0, queued: 0 };
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'dispatched');
      assert.deepEqual(dispatched, [[handoff, '@token']], 'the SAME validated handoff is re-dispatched');
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'waiting');
      assert.equal(dispatched.length, 1, 'one queued warp is never dispatched twice');
      assert.equal(busyLib.pendingWarpFor(key).dispatching, true);
    } finally {
      assert.equal(busyLib.settlePendingWarp(key).name, 'feat-q');
      assert.equal(busyLib.pendingWarpFor(key), null);
    }
  });

  test('a second queue is refused and leaves the pending warp untouched', () => {
    const key = 'session:lib-second';
    const first = { name: 'feat-first', target: '/t', from: '/f', branch: 'feat/first', changes: { mode: 'none', paths: [] } };
    const second = { name: 'feat-second', target: '/t2', from: '/f', branch: 'feat/second', changes: { mode: 'none', paths: [] } };
    const deps = {
      now: () => 1000,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '10000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => ({ busy: true }),
      dispatch: () => ({ ok: true }),
    };
    try {
      assert.equal(busyLib.queuePendingWarp({ key, name: 'feat-first', token: '@one', handoff: first, ...deps }).ok, true);
      const refused = busyLib.queuePendingWarp({ key, name: 'feat-second', token: '@two', handoff: second, ...deps });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'pending');
      assert.equal(refused.pending.name, 'feat-first');
      assert.deepEqual(busyLib.pendingWarpFor(key).handoff, first);
    } finally {
      busyLib.settlePendingWarp(key);
    }
  });

  test('the pending warp expires with a notice that nothing moved, and clears', async () => {
    const key = 'session:lib-expiry';
    const clock = { now: 1000 };
    const notified = [];
    const deps = {
      now: () => clock.now,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '1000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => ({ busy: true, running: 1 }),
      dispatch: () => { throw new Error('an expired warp must not dispatch'); },
      notify: (text, level) => { notified.push([level, text]); },
    };
    const handoff = { name: 'feat-e', target: '/t', from: '/f', branch: 'feat/e', changes: { mode: 'none', paths: [] } };
    assert.equal(busyLib.queuePendingWarp({ key, name: 'feat-e', token: '@e', handoff, ...deps }).ok, true);
    clock.now += 1000;
    assert.equal((await busyLib.pendingWarpTick(key)).status, 'expired');
    assert.equal(busyLib.pendingWarpFor(key), null, 'an expired request is cleared, so a later warp is accepted');
    assert.equal(notified.length, 1);
    assert.equal(notified[0][0], 'error');
    assert.match(notified[0][1], /the pending warp to feat-e expired after 1 min with nothing moved/);
  });

  test('a refused re-dispatch stays queued instead of throwing', async () => {
    const key = 'session:lib-refused';
    const deps = {
      now: () => 1000,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '10000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => ({ busy: false }),
      dispatch: () => ({ ok: false, error: 'the host cannot dispatch the warp command here' }),
    };
    const handoff = { name: 'feat-r', target: '/t', from: '/f', branch: 'feat/r', changes: { mode: 'none', paths: [] } };
    try {
      assert.equal(busyLib.queuePendingWarp({ key, name: 'feat-r', token: '@r', handoff, ...deps }).ok, true);
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'waiting');
      const record = busyLib.pendingWarpFor(key);
      assert.notEqual(record, null);
      assert.equal(record.dispatching, false, 'a refused dispatch is retried, not lost');
      // Resuming after a refused dispatch re-arms the poller for the same key.
      assert.equal(busyLib.resumePendingWarp(key), true);
      assert.equal(busyLib.pendingWarpFor(key).dispatching, false);
    } finally {
      busyLib.settlePendingWarp(key);
    }
  });
});

// ---------------------------------------------------------------------------
// The queue front while this session has work (T6/S3: `/warp` is the only
// front — `worktree_warp` is not registered any more, so every case here drives
// the command handler).
// ---------------------------------------------------------------------------
describe('/warp queues while this session has agent tasks or jobs', () => {
  test('a busy session gets the queued wording naming the work and the jobs caveat', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-1', { branch: 'feat/busy' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 1 });
    addJobs(ctx, [], 'absent');
    host.sent.length = 0;
    notifications.length = 0;
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    await commands.get('warp').handler('feat-busy', ctx);

    assert.equal(switches.length, 0, 'the session must not move under running work');
    assert.equal(host.sent.length, 0, 'the command front re-dispatches later, not now');
    const queued = notifications.find(([level]) => level === 'info');
    assert.ok(queued, JSON.stringify(notifications));
    assert.match(queued[1], /^worktree warp: handoff queued — waiting for 1 running agent task\(s\) before the move/);
    assert.match(
      queued[1],
      /queue: the background-job state is unknown \(job_list is not available on this host\), so confirm any bash_background or monitor job finished$/,
    );
    assert.equal(/not observable/.test(queued[1]), false, 'nothing claims jobs are invisible');
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the request is kept pending');
    settlePending();
  });

  test('queued counters queue the warp; waiting and finished counters do not', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-3', { branch: 'feat/queued' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 0, queued: 2, waiting: 1, finished: 4 });
    notifications.length = 0;
    await commands.get('warp').handler('feat-queued', ctx);
    assert.equal(switches.length, 0, 'queued counters are work the move must wait for');
    assert.equal(
      notifications.filter(([level, text]) => level === 'info' && /waiting for 2 queued agent task\(s\) before the move/.test(String(text))).length,
      1,
      JSON.stringify(notifications),
    );
    settlePending();

    publishSession({ running: 0, queued: 0, waiting: 4, finished: 9 });
    notifications.length = 0;
    await commands.get('warp').handler('feat-queued', ctx);
    assert.equal(switches.length, 1, 'waiting and finished counters are not work');
    assert.deepEqual(notifications, [], 'a real move notifies nothing');
  });

  test('a running job queues the warp, and a second request while one is pending is refused', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-j1', { branch: 'feat/jobs' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const second = await tools.get('worktree_create').execute('busy-j2', { branch: 'feat/two' }, undefined, undefined, ctx);
    assert.notEqual(second.isError, true, resultText(second));

    const jobs = addJobs(ctx, [{ id: 'job-1', status: 'running', label: 'Probe de job' }]);
    host.sent.length = 0;
    notifications.length = 0;
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    await commands.get('warp').handler('feat-jobs', ctx);

    assert.equal(switches.length, 0, 'a running job holds the move');
    assert.equal(
      notifications.filter(([, text]) => /^worktree warp: handoff queued — waiting for 1 running background job before the move/.test(String(text))).length,
      1,
      JSON.stringify(notifications),
    );
    assert.ok(jobs.calls > 0, 'the job list was actually read through the host tool');
    assert.equal(host.sent.length, 0, 'the command front re-dispatches later, not now');
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the request is kept pending');

    // A DIFFERENT checkout is a second warp: refused while the first is pending.
    notifications.length = 0;
    await commands.get('warp').handler('feat-two', ctx);
    assert.equal(switches.length, 0, 'the refused second request switches nothing');
    assert.equal(notifications.length, 1, JSON.stringify(notifications));
    assert.equal(notifications[0][0], 'error');
    assert.match(
      notifications[0][1],
      /^worktree warp: a warp to feat-jobs is already pending for this session — it runs when the pending agent tasks and background jobs finish; wait for it or let it expire$/,
    );
    settlePending();
  });

  test('a running agent task and a running job are both named', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-j4', { branch: 'feat/both' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 2 });
    addJobs(ctx, [{ id: 'job-7', status: 'queued' }]);
    notifications.length = 0;
    await commands.get('warp').handler('feat-both', ctx);
    const queued = notifications.find(([, text]) => /handoff queued/.test(String(text)));
    assert.ok(queued, JSON.stringify(notifications));
    assert.match(
      queued[1],
      /^worktree warp: handoff queued — waiting for 2 running agent task\(s\) and 1 running background job before the move/,
    );
    // Both workloads were readable, so nothing disclaims jobs any more.
    assert.equal(/not observable/.test(queued[1]), false, 'the job disclaimer is gone');
    assert.equal(/agent-task counters only/.test(queued[1]), false);
    assert.equal(/queue:/.test(queued[1]), false, 'a readable job list adds no caveat row');
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null);
    settlePending();
  });

  test('an unavailable, failing or unparsable job list blocks nothing and is disclosed only then', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-j6', { branch: 'feat/unknown' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    publishSession({ running: 1 });

    // No host seam at all: the plain ctx has neither `tools` nor `executeTool`.
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-unknown', ctx);
    const noSeam = notifications.find(([, text]) => /handoff queued/.test(String(text)));
    assert.ok(noSeam, JSON.stringify(notifications));
    assert.match(noSeam[1], /waiting for 1 running agent task\(s\) before the move/);
    assert.match(noSeam[1], /queue: the background-job state is unknown \(job_list is not available on this host\)/);
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'an unavailable job list never blocks the warp');
    settlePending();

    for (const [mode, reason] of [['error', 'job_list failed'], ['unparsable', 'job_list answered in an unexpected shape']]) {
      addJobs(ctx, [], mode);
      notifications.length = 0;
      await commands.get('warp').handler('feat-unknown', ctx);
      const outcome = notifications.find(([, text]) => /handoff queued/.test(String(text)));
      assert.ok(outcome, `${mode}: ${JSON.stringify(notifications)}`);
      assert.match(outcome[1], new RegExp(`queue: the background-job state is unknown \\(${reason}\\)`));
      assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, `a ${mode} job list never blocks the warp`);
      settlePending();
    }

    // An unknown job list with NO agent task either: the move is performed and
    // nothing claims a queue it did not create.
    clearPresence();
    const { ctx: moveCtx, switches } = movableCtx(repo);
    addJobs(moveCtx, [], 'unparsable');
    notifications.length = 0;
    await commands.get('warp').handler('feat-unknown', moveCtx);
    assert.equal(switches.length, 1, `an unknown job list blocks nothing (${JSON.stringify(notifications)})`);
    assert.deepEqual(notifications, [], 'nothing claims a queue it did not create');
  });

  test('a queued (busy) warp mutates no checkout and no registry row', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-8', { branch: 'feat/intact' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    const registryPath = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']), 'pi-worktrees.json');
    const listBefore = git(repo, ['worktree', 'list', '--porcelain']);
    const registryBefore = crypto.createHash('sha256').update(fs.readFileSync(registryPath)).digest('hex');

    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    await commands.get('warp').handler('feat-intact', ctx);
    assert.equal(switches.length, 0);
    assert.ok(notifications.some(([, text]) => /handoff queued/.test(String(text))), JSON.stringify(notifications));

    assert.equal(git(repo, ['worktree', 'list', '--porcelain']), listBefore, 'the listing changed');
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(registryPath)).digest('hex'),
      registryBefore,
      'the registry changed',
    );
    settlePending();
  });
});

// ---------------------------------------------------------------------------
// The command front: the request stays PENDING and the queue performs the move.
// ---------------------------------------------------------------------------
describe('the /warp front queues the move and performs it after the counters drain', () => {
  test('it never switches while an agent task runs, and says the warp is queued', async () => {
    const repo = makeRepo();
    const world = { sessionDir: track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-sessions-'))), created: 0, createdFiles: [] };
    const SM = makeSessionHost(world);
    const switches = [];
    const ctx = makeCtx(repo);
    ctx.sessionManager = Object.assign(new SM(null, null, null), { getSessionId: () => SESSION_ID });
    ctx.sessionManager.constructor = SM;
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    const created = await tools.get('worktree_create').execute('busy-10', { branch: 'feat/cmd' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 2 });
    notifications.length = 0;
    host.sent.length = 0;
    await commands.get('warp').handler('feat-cmd', ctx);

    assert.equal(switches.length, 0, 'the session must not move under running tasks');
    assert.equal(host.sent.length, 0, 'the command front re-dispatches later, not now');
    assert.equal(notifications.length, 1, JSON.stringify(notifications));
    assert.equal(notifications[0][0], 'info');
    assert.match(
      notifications[0][1],
      /^worktree warp: handoff queued — waiting for 2 running agent task\(s\) before the move/,
    );
    const record = busyLib.pendingWarpFor(pendingKey());
    assert.notEqual(record, null, 'the request is kept pending');
    assert.equal(record.name, 'feat-cmd');
    settlePending();
  });

  test('the pending warp re-dispatches the same handoff once the counters drain, and the move lands', async () => {
    const repo = makeRepo();
    const world = { sessionDir: track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-sessions-'))), created: 0, createdFiles: [] };
    const SM = makeSessionHost(world);
    const switches = [];
    const ctx = makeCtx(repo);
    ctx.sessionManager = Object.assign(new SM(null, null, null), { getSessionId: () => SESSION_ID });
    ctx.sessionManager.constructor = SM;
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    const created = await tools.get('worktree_create').execute('busy-11', { branch: 'feat/drain' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 1, queued: 1 });
    host.sent.length = 0;
    await commands.get('warp').handler('feat-drain', ctx);
    assert.equal(switches.length, 0);
    assert.equal(host.sent.length, 0);

    // The counters drain: the poller re-dispatches the SAME validated handoff.
    publishSession({ running: 0, queued: 0 });
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'dispatched');
    assert.equal(host.sent.length, 1, 'the queued warp re-dispatches itself');
    const [message, options] = host.sent[0];
    assert.deepEqual(options, { expandPromptTemplates: true });
    assert.ok(message.startsWith('/warp @'), `the queued command is /warp (${message})`);

    // That exact handoff is not a second warp: it performs the queued move.
    notifications.length = 0;
    await commands.get('warp').handler(message.slice('/warp '.length), ctx);
    assert.deepEqual(notifications, [], 'a real move notifies nothing');
    assert.equal(switches.length, 1, 'the queued move landed once the counters drained');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'a move clears the pending record');

    // A later warp is accepted again: a busy session queues it instead of being
    // refused as a second request.
    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-drain', ctx);
    assert.deepEqual(notifications.filter(([, text]) => /already pending/.test(String(text))), [], JSON.stringify(notifications));
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'a later warp queues again');
    settlePending();
  });

  test('a second warp is refused while one is pending, and queues nothing', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const first = await tools.get('worktree_create').execute('busy-13', { branch: 'feat/one' }, undefined, undefined, ctx);
    assert.notEqual(first.isError, true, resultText(first));
    const second = await tools.get('worktree_create').execute('busy-14', { branch: 'feat/two' }, undefined, undefined, ctx);
    assert.notEqual(second.isError, true, resultText(second));

    publishSession({ running: 2 });
    notifications.length = 0;
    await commands.get('warp').handler('feat-one', ctx);
    const queued = busyLib.pendingWarpFor(pendingKey());
    assert.notEqual(queued, null);

    // The second request is refused and queues nothing.
    host.sent.length = 0;
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    notifications.length = 0;
    await commands.get('warp').handler('feat-two', ctx);
    assert.equal(switches.length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0], 'error');
    assert.match(
      notifications[0][1],
      /^worktree warp: a warp to feat-one is already pending for this session — it runs when the pending agent tasks and background jobs finish; wait for it or let it expire$/,
    );
    assert.equal(host.sent.length, 0, 'a refused second warp queues nothing');

    // The pending request is untouched by the refusal.
    const after = busyLib.pendingWarpFor(pendingKey());
    assert.equal(after.name, 'feat-one');
    assert.equal(after.queuedAt, queued.queuedAt);
    settlePending();
  });

  test('an expired pending warp notices that nothing moved and clears for a later warp', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-16', { branch: 'feat/expire' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 1 });
    notifications.length = 0;
    const previousBudget = process.env.ODD_WORKTREE_WARP_PENDING_MS;
    process.env.ODD_WORKTREE_WARP_PENDING_MS = '1';
    try {
      await commands.get('warp').handler('feat-expire', ctx);
    } finally {
      process.env.ODD_WORKTREE_WARP_PENDING_MS = previousBudget;
    }
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null);

    const expired = await until(() => notifications.some(([, text]) => /expired .* with nothing moved/.test(String(text))));
    assert.equal(expired, true, `the queue noticed nothing: ${JSON.stringify(notifications)}`);
    const [, text] = notifications.find(([, entry]) => /expired .* with nothing moved/.test(String(entry)));
    assert.match(text, /^worktree warp: the pending warp to feat-expire expired after 1 min with nothing moved/);
    assert.match(text, /agent tasks and background jobs finish/);
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'an expired queue is cleared');

    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-expire', ctx);
    assert.deepEqual(notifications.filter(([, entry]) => /already pending/.test(String(entry))), [], `a new warp is accepted after expiry: ${JSON.stringify(notifications)}`);
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'a new warp is queued after the expiry');
    settlePending();
  });

  test('a running background job keeps the move pending until the job reports exited', async () => {
    const repo = makeRepo();
    const world = { sessionDir: track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-sessions-'))), created: 0, createdFiles: [] };
    const SM = makeSessionHost(world);
    const switches = [];
    const ctx = makeCtx(repo);
    ctx.sessionManager = Object.assign(new SM(null, null, null), { getSessionId: () => SESSION_ID });
    ctx.sessionManager.constructor = SM;
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    const jobs = addJobs(ctx, [{ id: 'job-1', status: 'running', label: 'Probe de job' }]);
    const created = await tools.get('worktree_create').execute('busy-j20', { branch: 'feat/jobwait' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    // No agent task at all: the JOB is the only thing standing in the way.
    clearPresence();
    notifications.length = 0;
    host.sent.length = 0;
    await commands.get('warp').handler('feat-jobwait', ctx);

    assert.equal(switches.length, 0, 'the session must not move while a job is running');
    assert.equal(host.sent.length, 0, 'the command front re-dispatches later, not now');
    assert.equal(notifications.length, 1, JSON.stringify(notifications));
    assert.equal(notifications[0][0], 'info');
    assert.match(notifications[0][1], /^worktree warp: handoff queued — waiting for 1 running background job before the move/);
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'a running job keeps the request pending');

    // Still running: the poller waits, and nothing is re-dispatched.
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'waiting');
    assert.equal(host.sent.length, 0);
    assert.equal(switches.length, 0);

    // The job exits: the poller re-dispatches the SAME handoff, and it lands.
    jobs.jobs[0].status = 'exited 0';
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'dispatched');
    assert.equal(host.sent.length, 1, 'the queued warp re-dispatches itself once the job is finished');
    const [message, options] = host.sent[0];
    assert.deepEqual(options, { expandPromptTemplates: true });
    assert.ok(message.startsWith('/warp @'), `the queued command is /warp (${message})`);
    await commands.get('warp').handler(message.slice('/warp '.length), ctx);
    assert.equal(switches.length, 1, 'the move lands only after the job finished');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'a move clears the pending record');
  });

  test('a refused queued warp clears the record, so a later warp is accepted', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-r1', { branch: 'feat/refused' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    // The command front queues the request while a job runs, so it is pending.
    clearPresence();
    const jobs = addJobs(ctx, [{ id: 'job-3', status: 'running' }]);
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-refused', ctx);
    assert.ok(notifications.some(([, text]) => /handoff queued/.test(String(text))), JSON.stringify(notifications));
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null);

    // The job finishes: the queue re-dispatches the SAME validated handoff.
    jobs.jobs[0].status = 'exited 0';
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'dispatched');
    assert.equal(host.sent.length, 1, 'the queued warp re-dispatches itself');
    const token = host.sent[0][0];
    // The registry is unreadable when that warp runs: a terminal refusal, so the
    // record must be cleared.
    const registryPath = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']), 'pi-worktrees.json');
    fs.writeFileSync(registryPath, 'not json');
    notifications.length = 0;
    await commands.get('warp').handler(token.slice('/warp '.length), ctx);
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'a refused queued warp is cleared');

    // A later warp is accepted again, not blocked by a dead record.
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, worktrees: [] }));
    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-refused', ctx);
    assert.deepEqual(notifications.filter(([, entry]) => /already pending/.test(String(entry))), [], `a new warp is accepted, not refused as pending: ${JSON.stringify(notifications)}`);
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null);
    settlePending();
  });

  test('a handoff token for another checkout is refused while one is pending', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const first = await tools.get('worktree_create').execute('busy-18', { branch: 'feat/held' }, undefined, undefined, ctx);
    assert.notEqual(first.isError, true, resultText(first));
    const second = await tools.get('worktree_create').execute('busy-19', { branch: 'feat/other' }, undefined, undefined, ctx);
    assert.notEqual(second.isError, true, resultText(second));

    // Queue a handoff for feat-other first: the busy front holds the request.
    clearPresence();
    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-other', ctx);
    assert.equal(host.sent.length, 0, 'the busy front re-dispatches later, not now');
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the handoff is now pending');

    // A DIFFERENT handoff (feat-held) is a second warp.
    const heldHandoff = `@${Buffer.from(JSON.stringify({
      v: 1,
      name: 'feat-held',
      target: path.join(repo, '..', 'other-checkout'),
      from: repo,
      branch: 'feat/held',
    }), 'utf8').toString('base64url')}`;
    notifications.length = 0;
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    await commands.get('warp').handler(heldHandoff, ctx);
    assert.equal(switches.length, 0);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0][1], /^worktree warp: a warp to feat-other is already pending for this session/);
    settlePending();
  });
});

// ---------------------------------------------------------------------------
// S4 boundaries: what the queue must NOT block, every entry path, and the
// surfaces that keep working while this session reports running work.
// ---------------------------------------------------------------------------
describe('boundaries: negative cases, every front, unaffected surfaces', () => {
  function writeOtherSession(counts) {
    fs.mkdirSync(PRESENCE, { recursive: true, mode: 0o700 });
    fs.chmodSync(PRESENCE, 0o700);
    const other = crypto.createHash('sha256').update('thread-2').digest('hex');
    fs.writeFileSync(path.join(PRESENCE, `${other}.${INCARNATION}.header.json`), JSON.stringify({
      schema: 1, sessionHash: other, incarnation: INCARNATION, label: 'Other session',
      heartbeat: Date.now(), generation: 1,
      counts: { running: 0, queued: 0, waiting: 0, finished: 0, ...counts },
      digest: 'f'.repeat(64), unavailable: null,
    }), { mode: 0o600 });
  }

  test('an absent presence store queues nothing and lets the move land', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-21', { branch: 'feat/nostore' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    clearPresence();
    notifications.length = 0;
    await commands.get('warp').handler('feat-nostore', ctx);
    assert.equal(switches.length, 1, `an absent store blocks nothing and waits for nothing (${JSON.stringify(notifications)})`);
    assert.deepEqual(notifications, [], 'nothing was queued, so nothing is announced');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'nothing is left pending');
  });

  test('a stale heartbeat and an unreadable record are no evidence of work', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-23', { branch: 'feat/stale' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 3, heartbeat: Date.now() - 600000 });
    notifications.length = 0;
    await commands.get('warp').handler('feat-stale', ctx);
    assert.equal(switches.length, 1, `a stale heartbeat is not evidence: ${JSON.stringify(notifications)}`);
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null);

    publishSession({ running: 3 });
    fs.chmodSync(PRESENCE, 0o755);
    try {
      notifications.length = 0;
      await commands.get('warp').handler('feat-stale', ctx);
      assert.equal(switches.length, 2, `an unsafe store is no evidence: ${JSON.stringify(notifications)}`);
    } finally {
      fs.chmodSync(PRESENCE, 0o700);
    }
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null);
  });

  test('another session’s running tasks never block this session', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-26', { branch: 'feat/other' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    clearPresence();
    writeOtherSession({ running: 5, queued: 3 });
    notifications.length = 0;
    await commands.get('warp').handler('feat-other', ctx);
    assert.equal(switches.length, 1, `a peer's work is not this session's: ${JSON.stringify(notifications)}`);
    assert.deepEqual(notifications, [], 'nothing was queued, so nothing is announced');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'nothing is left pending');
  });

  test('the selector pick is queued, never switched, while this session is busy', async () => {
    const repo = makeRepo();
    const createCtx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-28', { branch: 'feat/pick' }, undefined, undefined, createCtx);
    assert.notEqual(created.isError, true, resultText(created));

    const switches = [];
    const picks = [];
    const ctx = {
      cwd: repo,
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => SESSION_ID },
      ui: {
        notify: (text, level) => { notifications.push([level, text]); },
        confirm: async () => true,
        select: async (_title, options) => {
          const want = picks.shift();
          return want ? options.find((option) => String(option).startsWith(`${want} `)) : undefined;
        },
      },
      waitForIdle: async () => {},
      switchSession: async (file) => { switches.push(file); return { cancelled: false }; },
    };

    publishSession({ running: 2 });
    notifications.length = 0;
    picks.push('feat-pick');
    await commands.get('warp').handler('', ctx);
    assert.equal(switches.length, 0, 'the selector must not move the session under a running task');
    assert.equal(notifications.filter(([, text]) => /handoff queued — waiting for 2 running/.test(String(text))).length, 1);
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the selector pick is kept pending');
    settlePending();
  });

  test('session shutdown clears the pending warp', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-sd1', { branch: 'feat/shutdown' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-shutdown', ctx);
    assert.ok(notifications.some(([, text]) => /handoff queued/.test(String(text))), JSON.stringify(notifications));
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the request is pending before shutdown');

    for (const [, handler] of hooks.filter(([name]) => name === 'session_shutdown')) {
      await handler({}, ctx);
    }
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'nothing deferred survives its session');
  });

  test('list, create and delete still work while this session reports running work', async () => {
    const repo = makeRepo();
    const ctx = {
      cwd: repo,
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => SESSION_ID },
      ui: {
        notify: (text, level) => { notifications.push([level, text]); },
        confirm: async () => true,
      },
      waitForIdle: async () => {},
      switchSession: async () => ({ cancelled: false }),
    };
    publishSession({ running: 2, queued: 1 });

    const listed = await tools.get('worktree_list').execute('busy-29', {}, undefined, undefined, ctx);
    assert.notEqual(listed.isError, true, resultText(listed));
    const created = await tools.get('worktree_create').execute('busy-30', { branch: 'feat/surface' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const closed = await mod.executeWorktreeClose({ name: 'feat-surface', force: true }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    settlePending();
  });
});

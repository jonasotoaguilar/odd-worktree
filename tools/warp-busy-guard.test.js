'use strict';
// S4/S5/S9: a warp waits for THIS session's own work — the tools it is
// executing, its agent tasks AND its background jobs — and the request is
// QUEUED while that work runs.
//
// Three sources are driven here:
//   - the host's `tool_execution_start` / `tool_execution_end` pair, which the
//     extension registers and which fires for EVERY tool of the session (a
//     running bash or read, not only this package's tools);
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
const { LIB_DIR, stubbedSource } = require('./fixtures/load-extension.js');
// The queue the extension itself loaded: one extension load compiles its own lib
// modules, so every fake and every assertion below addresses THAT instance by the
// extension's `libModule` seam instead of a separate `require` of the same path.
let busyLib = require('../lib/worktree-warp-busy.js');

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
afterEach(() => {
  settlePending();
  // The tool counter is process memory shared by the whole file: a failed test
  // must not leak an execution into the test after it.
  busyLib.forgetInFlightTools();
  widgetPaints.length = 0;
  // The pending-changes question is a module seam shared by the whole file: a
  // failed test must not leave its asker behind for the tests after it.
  if (mod && typeof mod.setWarpDirtyAsker === 'function') mod.setWarpDirtyAsker(null);
});

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

// The pending-changes question, driven through the module's own seam (the same
// helper every front uses) instead of a rendered picker: `calls` is what the
// human was asked, so a question asked twice is observable. `answer` is 'yes',
// 'no', null (cancel) or a function of the summary line.
function dirtyAsker(answer) {
  const calls = [];
  mod.setWarpDirtyAsker(async (_ctx, summaryLine) => {
    calls.push(summaryLine);
    return typeof answer === 'function' ? answer(_ctx, summaryLine) : answer;
  });
  return calls;
}

// The destination the create really writes, from the create's own rule
// (<repo-parent>/<repo-name>-worktrees/<odd>) instead of a remembered spelling.
function portedDestination(repo, odd) {
  return require('../lib/worktree-create.js').worktreeDestinationPath(fs.realpathSync(repo), odd);
}

// S8/S9: the queued warp's persistent line reaches the human through
// `ctx.ui.setWidget(key, content, { placement: "aboveEditor" })` — the zone
// immediately above the input. The test records every call and renders the
// component factory the queue handed over, so the line, its dim styling and its
// one-row truncation are observed exactly as the host would draw them.
const widgetPaints = [];
const WIDGET_KEY = 'odd-worktree-warp';
const WIDGET_DIM = (text) => `\u001b[2m${text}\u001b[0m`;

function widgetPaintsFor(ctx) {
  return widgetPaints.filter((entry) => entry.ctx === ctx);
}

// The widget as it stands: how many paints happened, and the rows the last one
// renders at `width`. `lines: null` means the line was CLEARED (or never shown).
function widgetState(ctx, width = 200) {
  const paints = widgetPaintsFor(ctx);
  const last = paints.length > 0 ? paints[paints.length - 1] : null;
  if (last === null || last.content === undefined) return { paints: paints.length, lines: null, last };
  const theme = { fg: (role, text) => (role === 'dim' ? WIDGET_DIM(text) : text) };
  const component = last.content({}, theme);
  return { paints: paints.length, lines: component.render(width), last };
}

function makeCtx(cwd, extra = {}) {
  const ctx = {
    cwd,
    hasUI: true,
    mode: 'tui',
    sessionManager: { getSessionId: () => SESSION_ID },
    ui: {
      notify: (text, level) => { notifications.push([level, text]); },
      setWidget: (key, content, options) => { widgetPaints.push({ ctx, key, content, options }); },
      ...extra,
    },
    waitForIdle: async () => {},
    switchSession: async () => ({ cancelled: false }),
  };
  return ctx;
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
  process.env.GENTLE_WORKTREE_THREAD = SESSION_ID;
  process.env.PATH = `${HOOK_BIN}${path.delimiter}${savedEnv.PATH || ''}`;
  delete process.env.GENTLE_PI_AGENT_HOME;
  process.env.PI_CODING_AGENT_DIR = AGENT_HOME;
  // The queue's lifetime and poll interval are injected per test; these defaults
  // keep the poller quiet while a test drives `pendingWarpTick` itself.
  process.env.ODD_WORKTREE_WARP_PENDING_MS = '600000';
  process.env.ODD_WORKTREE_WARP_PENDING_POLL_MS = '60000';
  const sent = [];
  const loaded = await loadStubbedModule({ sendUserMessage: (text, options) => { sent.push([text, options]); } });
  host = loaded.host;
  host.sent = sent;
  commands = loaded.commands;
  tools = loaded.tools;
  hooks = loaded.hooks;
  mod = loaded.mod;
  busyLib = mod.libModule('worktree-warp-busy.js');
});

// The registration surface AND the extension's own exported seams, from ONE load:
// a load compiles its own lib modules, so the queue a test asserts and the front
// that fills it must belong to the same instance (tools/package-surface.test.js
// pins the freshness; this file pins that one load serves both).
async function loadStubbedModule(pi) {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-mod-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const mod = await import(pathToFileURL(copy).href);
    const localCommands = new Map();
    const localTools = new Map();
    const localHooks = [];
    const host = {
      registerCommand: (name, handler) => { localCommands.set(name, handler); },
      registerTool: (tool) => { localTools.set(tool.name, tool); },
      registerMessageRenderer: () => {},
      on: (event, handler) => { localHooks.push([event, handler]); },
      ...pi,
    };
    mod.default(host);
    return { mod, commands: localCommands, tools: localTools, hooks: localHooks, host };
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
      /^a warp to feat-x is already pending for this session — it runs when this session's tools, agent tasks and background jobs finish; wait for it or let it expire$/,
    );
  });

  test('the steering line names the wait, on one line, and never a move', () => {
    // The same phrase the queued notice uses, so the row and the notice cannot
    // describe different work.
    assert.equal(
      busyLib.pendingSteeringLine('feat-x', {
        running: 1, queued: 0, jobs: { active: 2, status: 'ok' }, tools: { inFlight: 1 },
      }),
      'Queued: warp feat-x — waiting for 1 running agent task(s) and 2 running background jobs and 1 tool still executing',
    );
    assert.equal(
      busyLib.pendingSteeringLine('feat-x', { running: 0, queued: 0, jobs: { active: 0, status: 'ok' }, tools: { inFlight: 1 } }),
      'Queued: warp feat-x — waiting for 1 tool still executing',
    );
    // Nothing readable: the workloads are named in words, never promised.
    assert.equal(
      busyLib.pendingSteeringLine('feat-x', null),
      "Queued: warp feat-x — waiting for this session's tools, agent tasks and background jobs",
    );
    assert.equal(
      busyLib.pendingSteeringLine('', {}),
      "Queued: warp that checkout — waiting for this session's tools, agent tasks and background jobs",
    );
    // A name can never break the one-row contract, and it never claims a move.
    assert.equal(
      busyLib.pendingSteeringLine('feat\nline two', { running: 1 }),
      'Queued: warp feat line two — waiting for 1 running agent task(s)',
    );
    for (const claim of ['moved', 'switched', 'now in', 'done']) {
      assert.equal(busyLib.pendingSteeringLine('feat-x', { running: 1 }).includes(claim), false, claim);
    }
  });

  test('the queue paints its line while it waits, and clears it on dispatch, expiry and settle', async () => {
    const key = 'session:lib-steering';
    const clock = { now: 1000 };
    const paints = [];
    const activity = { busy: true, running: 1, queued: 0, jobs: { status: 'ok', active: 0 }, tools: { inFlight: 0 } };
    const handoff = { name: 'feat-s', target: '/t', from: '/f', branch: 'feat/s', changes: { mode: 'none', paths: [] } };
    const queued = busyLib.queuePendingWarp({
      key,
      name: 'feat-s',
      token: '@s',
      handoff,
      activity,
      now: () => clock.now,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '10000', ODD_WORKTREE_WARP_PENDING_POLL_MS: '1000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => activity,
      dispatch: () => ({ ok: true }),
      paint: (line) => { paints.push(line); },
    });
    try {
      assert.equal(queued.ok, true);
      // The line is shown at QUEUE time, naming the work already known.
      assert.deepEqual(paints, ['Queued: warp feat-s — waiting for 1 running agent task(s)']);

      // The same reason is not repainted: a 30-minute queue is one row, not a
      // repaint every poll.
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'waiting');
      assert.equal(paints.length, 1);

      // The reason changes, so the line does.
      activity.running = 0;
      activity.jobs = { status: 'ok', active: 2 };
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'waiting');
      assert.equal(paints.length, 2);
      assert.equal(paints[1], 'Queued: warp feat-s — waiting for 2 running background jobs');

      // The work drains: the dispatch clears the line, and never a claim of a
      // move that has not happened.
      activity.busy = false;
      activity.jobs = { status: 'ok', active: 0 };
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'dispatched');
      assert.equal(paints[paints.length - 1], null, 'a dispatch clears the line');

      // Every terminal outcome clears it: settling here is the move/refusal/
      // cancellation/shutdown path, and it never paints again.
      const before = paints.length;
      busyLib.settlePendingWarp(key);
      assert.equal(paints.length, before, 'an already cleared line is not repainted');
    } finally {
      busyLib.settlePendingWarp(key);
    }
  });

  test('an expired queue clears the line together with the record', async () => {
    const key = 'session:lib-steering-expiry';
    const clock = { now: 1000 };
    const paints = [];
    const handoff = { name: 'feat-se', target: '/t', from: '/f', branch: 'feat/se', changes: { mode: 'none', paths: [] } };
    const deps = {
      now: () => clock.now,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '1000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => ({ busy: true, running: 1 }),
      dispatch: () => { throw new Error('an expired warp must not dispatch'); },
      paint: (line) => { paints.push(line); },
    };
    assert.equal(busyLib.queuePendingWarp({ key, name: 'feat-se', token: '@se', handoff, activity: { busy: true, running: 1 }, ...deps }).ok, true);
    assert.deepEqual(paints, ['Queued: warp feat-se — waiting for 1 running agent task(s)']);
    clock.now += 1000;
    assert.equal((await busyLib.pendingWarpTick(key)).status, 'expired');
    assert.equal(paints[paints.length - 1], null, 'the expired request leaves no line behind');
    assert.equal(paints.length, 2, 'and it does not repaint a line it already cleared');
  });

  test('a queue with no widget seam still runs: the line is a convenience, never state', async () => {
    const key = 'session:lib-steering-absent';
    const deps = {
      now: () => 1000,
      env: { ODD_WORKTREE_WARP_PENDING_MS: '5000' },
      timers: { set: () => null, clear: () => {} },
      read: async () => ({ busy: false }),
      dispatch: () => ({ ok: true }),
    };
    const handoff = { name: 'feat-na', target: '/t', from: '/f', branch: 'feat/na', changes: { mode: 'none', paths: [] } };
    try {
      assert.equal(busyLib.queuePendingWarp({ key, name: 'feat-na', token: '@na', handoff, ...deps }).ok, true);
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'dispatched');
    } finally {
      busyLib.settlePendingWarp(key);
    }
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

  test('an executing tool is the third workload, counted from the host’s execution pair', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-tools-')));
    const env = { PI_CODING_AGENT_DIR: home };
    clearPresence();
    assert.equal((await busyLib.sessionActivity({ sessionId: SESSION_ID, env })).busy, false, 'nothing executes at the start');

    busyLib.noteToolStart({ toolCallId: 'call-bash-1', toolName: 'bash' });
    const running = await busyLib.sessionActivity({ sessionId: SESSION_ID, env });
    assert.equal(running.tools.inFlight, 1);
    assert.equal(running.busy, true, 'a tool still executing makes the session busy');
    assert.equal(
      busyLib.queuedText(running),
      'handoff queued — waiting for 1 tool still executing before the move',
    );

    // A second tool is counted too, and only its own end releases it.
    busyLib.noteToolStart({ toolCallId: 'call-read-2', toolName: 'read' });
    assert.equal((await busyLib.sessionActivity({ sessionId: SESSION_ID, env })).tools.inFlight, 2);
    busyLib.noteToolEnd({ toolCallId: 'call-bash-1' });
    const one = await busyLib.sessionActivity({ sessionId: SESSION_ID, env });
    assert.equal(one.tools.inFlight, 1);
    assert.equal(one.busy, true, 'one tool still executing still holds the move');
    busyLib.noteToolEnd({ toolCallId: 'call-read-2' });
    const idleAgain = await busyLib.sessionActivity({ sessionId: SESSION_ID, env });
    assert.equal(idleAgain.tools.inFlight, 0);
    assert.equal(idleAgain.busy, false, 'no tool left executing is not work');
    busyLib.forgetInFlightTools();
  });

  test('a nested call is never counted, and an unmatched end cannot go negative', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-nested-')));
    const env = { PI_CODING_AGENT_DIR: home };
    clearPresence();
    // The queue's own `job_list` probe (and any codemode child) runs INSIDE a
    // parent execution that is already counted: a warp must never wait on its
    // own probe.
    busyLib.noteToolStart({ toolCallId: 'parent-1/0', parentToolCallId: 'parent-1', toolName: 'job_list' });
    assert.equal(busyLib.inFlightToolCount(), 0);
    assert.equal((await busyLib.sessionActivity({ sessionId: SESSION_ID, env })).busy, false, 'a nested call alone is not a busy session');

    // A blocked call still gets its `tool_execution_end` without a start: that is
    // a no-op, never a negative count.
    busyLib.noteToolEnd({ toolCallId: 'never-started' });
    assert.equal(busyLib.inFlightToolCount(), 0);
    busyLib.forgetInFlightTools();
  });

  test('a tool that never ends is bounded by the pending lifetime, and shutdown clears it', async () => {
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-busy-stuck-')));
    const env = { PI_CODING_AGENT_DIR: home };
    const key = 'session:lib-toolstuck';
    const clock = { now: 1000 };
    const notified = [];
    const handoff = { name: 'feat-stuck', target: '/t', from: '/f', branch: 'feat/stuck', changes: { mode: 'none', paths: [] } };
    clearPresence();
    try {
      busyLib.noteToolStart({ toolCallId: 'call-stuck', toolName: 'bash' });
      const queued = busyLib.queuePendingWarp({
        key,
        name: 'feat-stuck',
        token: '@stuck',
        handoff,
        now: () => clock.now,
        env: { ODD_WORKTREE_WARP_PENDING_MS: '1000', ODD_WORKTREE_WARP_PENDING_POLL_MS: '1000' },
        timers: { set: () => null, clear: () => {} },
        read: () => busyLib.sessionActivity({ sessionId: SESSION_ID, env }),
        dispatch: () => { throw new Error('a tool still executing must hold the move'); },
        notify: (text, level) => { notified.push([level, text]); },
      });
      assert.equal(queued.ok, true);
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'waiting', 'a tool that never ends keeps the request queued');

      // The record’s OWN lifetime bounds the wait: nothing is wedged forever.
      clock.now += 1000;
      assert.equal((await busyLib.pendingWarpTick(key)).status, 'expired');
      assert.equal(notified.length, 1);
      assert.equal(notified[0][0], 'error');
      assert.match(notified[0][1], /^worktree warp: the pending warp to feat-stuck expired after 1 min with nothing moved/);
      assert.equal(busyLib.pendingWarpFor(key), null, 'the expired record is cleared');

      // A session replacement starts from no in-flight tool.
      busyLib.forgetInFlightTools();
      assert.equal((await busyLib.sessionActivity({ sessionId: SESSION_ID, env })).busy, false, 'a shutdown starts with no tool executing');
    } finally {
      busyLib.settlePendingWarp(key);
      busyLib.forgetInFlightTools();
    }
  });

  test('the pending and poll budgets are parsed, defaulted and clamped', () => {
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
describe('/warp queues while this session has tools, agent tasks or jobs', () => {
  test('a busy session gets the queued wording naming the work and the jobs caveat', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-1', { branch: 'feat/busy', odd: 'busy' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-3', { branch: 'feat/queued', odd: 'queued' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-j1', { branch: 'feat/jobs', odd: 'jobs' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const second = await tools.get('worktree_create').execute('busy-j2', { branch: 'feat/two', odd: 'two' }, undefined, undefined, ctx);
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
      /^worktree warp: a warp to feat-jobs is already pending for this session — it runs when this session's tools, agent tasks and background jobs finish; wait for it or let it expire$/,
    );
    settlePending();
  });

  test('a warp typed while the host is still streaming queues before anything waits for idle', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-live', { branch: 'feat/live', odd: 'live' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    addJobs(ctx, [{ id: 'job-1', status: 'running' }]);
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    // The turn never settles: a front that waits for idle would park the whole
    // request here, so the question and the queue would only happen at idle.
    let idleWaits = 0;
    ctx.waitForIdle = () => { idleWaits += 1; return new Promise(() => {}); };
    notifications.length = 0;
    host.sent.length = 0;
    const key = pendingKey();
    try {
      const answered = await Promise.race([
        commands.get('warp').handler('feat-live', ctx).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 400)),
      ]);
      assert.equal(answered, 'returned', 'the request must not wait for the turn to settle');
      assert.notEqual(busyLib.pendingWarpFor(key), null, 'the request is queued while the turn still runs');
      assert.equal(switches.length, 0, 'nothing moves under a running job');
      assert.equal(host.sent.length, 0, 'the re-dispatch happens later, not now');
      assert.equal(
        widgetState(ctx).lines.length > 0,
        true,
        'the steering row is painted while the turn still runs',
      );
      assert.match(String(widgetState(ctx).lines[0]), /Queued: warp feat-live/);
      assert.equal(idleWaits, 0, 'the request asked and queued before ever waiting for idle');
    } finally {
      busyLib.settlePendingWarp(key);
    }
  });

  test('a running agent task and a running job are both named', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-j4', { branch: 'feat/both', odd: 'both' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-j6', { branch: 'feat/unknown', odd: 'unknown' }, undefined, undefined, ctx);
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

  test('a tool executing in this session queues the warp, and the move lands once it ends', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    addJobs(ctx, []);
    const created = await tools.get('worktree_create').execute('busy-t1', { branch: 'feat/toolbusy', odd: 'toolbusy' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    clearPresence();
    host.sent.length = 0;
    notifications.length = 0;

    // The host announces a bash tool of THIS session: it is executing now.
    const starts = hooks.filter(([name]) => name === 'tool_execution_start');
    assert.ok(starts.length > 0, 'the extension registers the host’s execution pair');
    for (const [, handler] of starts) await handler({ toolCallId: 'call-bash-9', toolName: 'bash', args: { command: 'sleep 5' } }, ctx);

    await commands.get('warp').handler('feat-toolbusy', ctx);
    assert.equal(switches.length, 0, 'the session must not move while a tool executes');
    assert.equal(host.sent.length, 0, 'the command front re-dispatches later, not now');
    const queued = notifications.find(([, text]) => /handoff queued/.test(String(text)));
    assert.ok(queued, JSON.stringify(notifications));
    assert.match(queued[1], /^worktree warp: handoff queued — waiting for 1 tool still executing before the move/);
    assert.equal(/queue:/.test(queued[1]), false, 'a readable empty job list adds no caveat row');
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the request is kept pending');

    // Still executing: the same poller waits, and nothing is re-dispatched.
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'waiting');
    assert.equal(host.sent.length, 0);
    assert.equal(switches.length, 0);

    // The tool’s result arrives: the poller re-dispatches the SAME handoff. That
    // run executes no tool of its own, so it performs the move instead of
    // blocking on itself.
    for (const [, handler] of hooks.filter(([name]) => name === 'tool_execution_end')) {
      await handler({ toolCallId: 'call-bash-9', toolName: 'bash', result: {}, isError: false }, ctx);
    }
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'dispatched');
    assert.equal(host.sent.length, 1, 'the queued warp re-dispatches itself once the tool ends');
    const [message, options] = host.sent[0];
    assert.deepEqual(options, { expandPromptTemplates: true });
    assert.ok(message.startsWith('/warp @'), `the queued command is /warp (${message})`);
    notifications.length = 0;
    await commands.get('warp').handler(message.slice('/warp '.length), ctx);
    assert.equal(switches.length, 1, 'the queued move landed once the tool ended');
    assert.deepEqual(notifications, [], 'a real move notifies nothing and does not block on itself');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'a move clears the pending record');
  });

  test('a second warp while a tool executes is refused, and the pending one is never replaced', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const first = await tools.get('worktree_create').execute('busy-t2', { branch: 'feat/toolone', odd: 'toolone' }, undefined, undefined, ctx);
    assert.notEqual(first.isError, true, resultText(first));
    const second = await tools.get('worktree_create').execute('busy-t3', { branch: 'feat/tooltwo', odd: 'tooltwo' }, undefined, undefined, ctx);
    assert.notEqual(second.isError, true, resultText(second));
    clearPresence();
    for (const [, handler] of hooks.filter(([name]) => name === 'tool_execution_start')) {
      await handler({ toolCallId: 'call-grep-1', toolName: 'grep', args: {} }, ctx);
    }
    try {
      notifications.length = 0;
      await commands.get('warp').handler('feat-toolone', ctx);
      const queued = busyLib.pendingWarpFor(pendingKey());
      assert.notEqual(queued, null, 'the tool keeps the request pending');
      assert.equal(queued.name, 'feat-toolone');
      const shown = widgetState(ctx);
      assert.deepEqual(shown.lines, [WIDGET_DIM('Queued: warp feat-toolone — waiting for 1 tool still executing')]);

      notifications.length = 0;
      await commands.get('warp').handler('feat-tooltwo', ctx);
      assert.equal(switches.length, 0);
      assert.equal(notifications.length, 1, JSON.stringify(notifications));
      assert.equal(notifications[0][0], 'error');
      assert.match(notifications[0][1], /^worktree warp: a warp to feat-toolone is already pending for this session/);
      assert.equal(busyLib.pendingWarpFor(pendingKey()).name, 'feat-toolone', 'the pending request is never replaced');
      // A refused SECOND warp settles nothing: the pending request is still
      // waiting, so its line is still on screen, unchanged and unpainted.
      assert.equal(widgetState(ctx).paints, shown.paints, 'the refusal repaints nothing');
      assert.deepEqual(widgetState(ctx).lines, shown.lines, 'the pending line survives the refusal');
    } finally {
      settlePending();
      busyLib.forgetInFlightTools();
    }
  });

  test('the queued warp is visible above the editor: one dim line, and the line follows the queue', async (t) => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    addJobs(ctx, []);
    const created = await tools.get('worktree_create').execute('busy-line', { branch: 'feat/line', odd: 'line' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    clearPresence();
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;

    assert.equal(widgetState(ctx).lines, null, 'no queue, no line');
    for (const [, handler] of hooks.filter(([name]) => name === 'tool_execution_start')) {
      await handler({ toolCallId: 'call-line-1', toolName: 'bash', args: { command: 'sleep 5' } }, ctx);
    }
    t.diagnostic('step 1 — one bash tool of this session starts executing; no warp asked yet → nothing painted');
    assert.equal(widgetState(ctx).lines, null, 'a tool executing alone paints nothing');

    await commands.get('warp').handler('feat-line', ctx);
    const shown = widgetState(ctx);
    t.diagnostic(`step 2 — /warp feat-line while the tool runs → setWidget(${JSON.stringify(shown.last.key)}, …, ${JSON.stringify(shown.last.options)}) → ${JSON.stringify(shown.lines)}`);
    assert.deepEqual(shown.lines, [WIDGET_DIM('Queued: warp feat-line — waiting for 1 tool still executing')]);
    assert.equal(shown.last.key, WIDGET_KEY);
    assert.deepEqual(shown.last.options, { placement: 'aboveEditor' });
    assert.equal(switches.length, 0, 'the session has not moved');

    // A narrow terminal truncates the row instead of wrapping it into several.
    const narrow = widgetState(ctx, 24);
    assert.deepEqual(narrow.lines, [WIDGET_DIM('Queued: warp feat-line…')]);
    assert.equal(widgetState(ctx, 1).lines.length, 1, 'one row even at a single column');
    assert.deepEqual(widgetState(ctx, 1).lines, [WIDGET_DIM('…')]);

    // The reason has not changed, so the poller does not repaint the row.
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'waiting');
    assert.equal(widgetState(ctx).paints, shown.paints, 'an unchanged reason is not repainted');

    // The tool ends: the queue dispatches, and the line goes with it.
    for (const [, handler] of hooks.filter(([name]) => name === 'tool_execution_end')) {
      await handler({ toolCallId: 'call-line-1', toolName: 'bash', result: {}, isError: false }, ctx);
    }
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'dispatched');
    t.diagnostic('step 3 — the tool ends → the queue re-dispatches the same handoff → the line is cleared');
    assert.equal(widgetState(ctx).lines, null, 'a dispatch clears the line');

    const [message] = host.sent[0];
    notifications.length = 0;
    await commands.get('warp').handler(message.slice('/warp '.length), ctx);
    t.diagnostic('step 4 — the queued handoff runs → the session moved, no line left behind');
    assert.equal(switches.length, 1, 'the queued move landed once the tool ended');
    assert.equal(widgetState(ctx).lines, null);
  });

  test('a queued (busy) warp mutates no checkout and writes no document', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-8', { branch: 'feat/intact', odd: 'intact' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    // S3/S4: the list document is gone. "Nothing was written" is now asserted against
    // the absence of any file, before and after the queued request.
    const documentPath = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']), 'pi-worktrees.json');
    const listBefore = git(repo, ['worktree', 'list', '--porcelain']);
    assert.equal(fs.existsSync(documentPath), false, 'the create writes no list document');

    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    await commands.get('warp').handler('feat-intact', ctx);
    assert.equal(switches.length, 0);
    assert.ok(notifications.some(([, text]) => /handoff queued/.test(String(text))), JSON.stringify(notifications));

    assert.equal(git(repo, ['worktree', 'list', '--porcelain']), listBefore, 'the listing changed');
    assert.equal(fs.existsSync(documentPath), false, 'the queued warp writes no list document either');
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
    const created = await tools.get('worktree_create').execute('busy-10', { branch: 'feat/cmd', odd: 'cmd' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-11', { branch: 'feat/drain', odd: 'drain' }, undefined, undefined, ctx);
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
    const first = await tools.get('worktree_create').execute('busy-13', { branch: 'feat/one', odd: 'one' }, undefined, undefined, ctx);
    assert.notEqual(first.isError, true, resultText(first));
    const second = await tools.get('worktree_create').execute('busy-14', { branch: 'feat/two', odd: 'two' }, undefined, undefined, ctx);
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
      /^worktree warp: a warp to feat-one is already pending for this session — it runs when this session's tools, agent tasks and background jobs finish; wait for it or let it expire$/,
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
    const created = await tools.get('worktree_create').execute('busy-16', { branch: 'feat/expire', odd: 'expire' }, undefined, undefined, ctx);
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
    assert.deepEqual(widgetState(ctx).lines, [WIDGET_DIM('Queued: warp feat-expire — waiting for 1 running agent task(s)')], 'the queued warp is visible');

    const expired = await until(() => notifications.some(([, text]) => /expired .* with nothing moved/.test(String(text))));
    assert.equal(expired, true, `the queue noticed nothing: ${JSON.stringify(notifications)}`);
    const [, text] = notifications.find(([, entry]) => /expired .* with nothing moved/.test(String(entry)));
    assert.match(text, /^worktree warp: the pending warp to feat-expire expired after 1 min with nothing moved/);
    assert.match(text, /agent tasks and background jobs finish/);
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'an expired queue is cleared');
    assert.equal(widgetState(ctx).lines, null, 'an expired warp clears its line');

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
    const created = await tools.get('worktree_create').execute('busy-j20', { branch: 'feat/jobwait', odd: 'jobwait' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-r1', { branch: 'feat/refused', odd: 'refused' }, undefined, undefined, ctx);
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
    assert.ok(widgetState(ctx).lines, 'the row is up while the handoff waits');
    assert.equal((await busyLib.pendingWarpTick(pendingKey())).status, 'dispatched');
    assert.equal(host.sent.length, 1, 'the queued warp re-dispatches itself');
    const token = host.sent[0][0];
    // The created checkout is gone when that warp runs, so the name no longer
    // resolves: a terminal refusal, and the record must be cleared.
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'refused');
    git(repo, ['worktree', 'remove', target]);
    notifications.length = 0;
    await commands.get('warp').handler(token.slice('/warp '.length), ctx);
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'a refused queued warp is cleared');
    assert.equal(widgetState(ctx).lines, null, 'a refused queued warp clears its line');

    // A later warp is accepted again, not blocked by a dead record. The branch still
    // exists, and a checkout for it is made again so the name resolves.
    git(repo, ['worktree', 'add', target, 'feat/refused']);
    publishSession({ running: 1 });
    host.sent.length = 0;
    notifications.length = 0;
    await commands.get('warp').handler('feat-refused', ctx);
    assert.deepEqual(notifications.filter(([, entry]) => /already pending/.test(String(entry))), [], `a new warp is accepted, not refused as pending: ${JSON.stringify(notifications)}`);
    assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null);
    settlePending();
  });

  test('a refused handoff clears the line it was showing', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-r2', { branch: 'feat/live-refused', odd: 'live-refused' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));

    // The queue holds the request while a job runs, so its row is on screen.
    clearPresence();
    const jobs = addJobs(ctx, [{ id: 'job-lr', status: 'running' }]);
    notifications.length = 0;
    await commands.get('warp').handler('feat-live-refused', ctx);
    const record = busyLib.pendingWarpFor(pendingKey());
    assert.notEqual(record, null);
    assert.deepEqual(widgetState(ctx).lines, [WIDGET_DIM('Queued: warp feat-live-refused — waiting for 1 running background job')]);

    // The job finishes and the checkout disappears between the queue and the
    // move, which runs straight away: a terminal REFUSAL while the row is still
    // on screen, so this is the refusal itself clearing it (no dispatch first).
    jobs.jobs[0].status = 'exited 0';
    git(repo, ['worktree', 'remove', path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'live-refused')]);
    notifications.length = 0;
    const refused = await mod.executeWorktreeWarp('feat-live-refused', ctx, { handoff: record.handoff });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'the refusal settles the record');
    assert.equal(widgetState(ctx).lines, null, 'and clears the line it was showing');
  });

  test('a handoff token for another checkout is refused while one is pending', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const first = await tools.get('worktree_create').execute('busy-18', { branch: 'feat/held', odd: 'held' }, undefined, undefined, ctx);
    assert.notEqual(first.isError, true, resultText(first));
    const second = await tools.get('worktree_create').execute('busy-19', { branch: 'feat/other', odd: 'other' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-21', { branch: 'feat/nostore', odd: 'nostore' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    clearPresence();
    notifications.length = 0;
    await commands.get('warp').handler('feat-nostore', ctx);
    assert.equal(switches.length, 1, `an absent store blocks nothing and waits for nothing (${JSON.stringify(notifications)})`);
    assert.deepEqual(notifications, [], 'nothing was queued, so nothing is announced');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'nothing is left pending');
    // A warp that moves immediately was never queued, so it never paints the
    // "waiting" row: the line belongs to the queue, not to the warp.
    assert.equal(widgetPaintsFor(ctx).length, 0, 'an immediate move paints nothing above the editor');
  });

  test('a stale heartbeat and an unreadable record are no evidence of work', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('busy-23', { branch: 'feat/stale', odd: 'stale' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-26', { branch: 'feat/other', odd: 'other' }, undefined, undefined, ctx);
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
    const created = await tools.get('worktree_create').execute('busy-28', { branch: 'feat/pick', odd: 'pick' }, undefined, undefined, createCtx);
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
    const created = await tools.get('worktree_create').execute('busy-sd1', { branch: 'feat/shutdown', odd: 'shutdown' }, undefined, undefined, ctx);
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

  test('a session shutdown clears the in-flight tools, so a lost end cannot wedge the next session', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    for (const [, handler] of hooks.filter(([name]) => name === 'tool_execution_start')) {
      await handler({ toolCallId: 'call-lost-end', toolName: 'bash', args: {} }, ctx);
    }
    assert.equal(busyLib.inFlightToolCount(), 1, 'the tool is executing before shutdown');
    for (const [, handler] of hooks.filter(([name]) => name === 'session_shutdown')) {
      await handler({}, ctx);
    }
    assert.equal(busyLib.inFlightToolCount(), 0, 'a replacement session starts with no tool executing');
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
    const created = await tools.get('worktree_create').execute('busy-30', { branch: 'feat/surface', odd: 'surface' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    const closed = await mod.executeWorktreeClose({ name: 'feat-surface', force: true }, ctx);
    assert.notEqual(closed.isError, true, resultText(closed));
    settlePending();
  });
});

// ---------------------------------------------------------------------------
// warp-queue-order T1 (S1-S3, S5): the pending-changes question is asked at
// REQUEST time and a busy session is queued AT ONCE. The counters are read as
// they are, never waited on: a request that waited found the session idle
// afterwards, skipped the queue (so no steering row was ever painted) and asked
// the same question again on every attempt.
// ---------------------------------------------------------------------------
describe('warp-queue-order: ask the copy question at request time, then queue', () => {
  test('a busy session asks once, at request time, and queues at once', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-1', { branch: 'feat/now', odd: 'now' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    // Pending work in the checkout the session stands in, so the question has
    // something to ask about.
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    clearPresence();
    // The session's own job is running when the request arrives, and it is over
    // by a SECOND read of the counters: a front that waits for them to drain
    // reads twice and then takes the idle path.
    const jobState = { reads: 0 };
    ctx.tools = [{ name: 'job_list' }];
    ctx.executeTool = async (name) => {
      if (name !== 'job_list') return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
      jobState.reads += 1;
      const status = jobState.reads === 1 ? 'running' : 'exited 0';
      return { content: [{ type: 'text', text: `job-1 \u00b7 ${status} \u00b7 Probe \u00b7 3s \u00b7 /tmp/gentle-jobs-1/job-1.log` }] };
    };
    const asked = dirtyAsker('yes');
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    try {
      await commands.get('warp').handler('feat-now', ctx);

      assert.deepEqual(asked, ['1 file, +1/-0'], 'the pending-changes question is asked once, at request time');
      assert.equal(jobState.reads, 1, 'the counters are read once, as they are, instead of polled until they drain');
      assert.equal(switches.length, 0, 'the session must not move under its own running job');
      assert.equal(host.sent.length, 0, 'nothing is re-dispatched now');
      const record = busyLib.pendingWarpFor(pendingKey());
      assert.notEqual(record, null, 'the request is queued immediately');
      assert.deepEqual(record.handoff.changes, { mode: 'all', paths: [] }, 'the answer given at request time travels in the handoff');
      // S3: the row is up from the moment the request is queued, and it never
      // claims a move.
      assert.deepEqual(widgetState(ctx).lines, [WIDGET_DIM('Queued: warp feat-now — waiting for 1 running background job')]);
      assert.deepEqual(notifications, [
        ['info', 'worktree warp: handoff queued — waiting for 1 running background job before the move'],
      ]);

      // S2: attempts two and three are the existing pending-warp refusal, ask no
      // question and change nothing.
      const queuedAt = record.queuedAt;
      for (const attempt of [2, 3]) {
        notifications.length = 0;
        await commands.get('warp').handler('feat-now', ctx);
        assert.deepEqual(notifications, [['error',
          "worktree warp: a warp to feat-now is already pending for this session \u2014 it runs when this session's tools, agent tasks and background jobs finish; wait for it or let it expire",
        ]], `attempt ${attempt}`);
        assert.equal(switches.length, 0, `attempt ${attempt} switches nothing`);
        assert.equal(host.sent.length, 0, `attempt ${attempt} queues nothing`);
        const after = busyLib.pendingWarpFor(pendingKey());
        assert.equal(after.queuedAt, queuedAt, `attempt ${attempt} never replaced the pending request`);
        assert.deepEqual(after.handoff, record.handoff, `attempt ${attempt} left the pending handoff untouched`);
      }
      assert.deepEqual(asked, ['1 file, +1/-0'], 'one question per request, never one per attempt');
    } finally {
      settlePending();
    }
  });

  test('an idle session applies the answer it was given, and never asks again', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-2', { branch: 'feat/quiet', odd: 'quiet' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    clearPresence();
    addJobs(ctx, []);
    const asked = dirtyAsker('yes');
    notifications.length = 0;
    await commands.get('warp').handler('feat-quiet', ctx);
    assert.deepEqual(asked, ['1 file, +1/-0'], 'the question is asked exactly once');
    assert.equal(switches.length, 1, 'a session with no work moves straight away');
    assert.equal(
      fs.readFileSync(path.join(created.details.path, 'pending.txt'), 'utf8'),
      'pending\n',
      'the answer given at request time is what gets copied',
    );
    assert.deepEqual(notifications, [], 'a real move notifies nothing');
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'nothing was queued');
  });

  test('NO COPY travels in the queued handoff as no changes', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-3', { branch: 'feat/nocopy', odd: 'nocopy' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    clearPresence();
    addJobs(ctx, [{ id: 'job-nc', status: 'running' }]);
    const asked = dirtyAsker('no');
    notifications.length = 0;
    try {
      await commands.get('warp').handler('feat-nocopy', ctx);
      assert.deepEqual(asked, ['1 file, +1/-0']);
      const record = busyLib.pendingWarpFor(pendingKey());
      assert.notEqual(record, null, 'the request is queued');
      assert.deepEqual(record.handoff.changes, { mode: 'none', paths: [] }, 'NO COPY queues a handoff that carries no changes');
      assert.deepEqual(notifications, [
        ['info', 'worktree warp: handoff queued — waiting for 1 running background job before the move'],
      ]);
      assert.equal(switches.length, 0);
    } finally {
      settlePending();
    }
  });

  test('cancelling the question queues nothing and moves nothing', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-4', { branch: 'feat/cancel', odd: 'cancel' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    clearPresence();
    addJobs(ctx, [{ id: 'job-c', status: 'running' }]);
    const asked = dirtyAsker(null);
    notifications.length = 0;
    widgetPaints.length = 0;
    await commands.get('warp').handler('feat-cancel', ctx);
    assert.deepEqual(asked, ['1 file, +1/-0']);
    assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'a cancelled question queues nothing');
    assert.equal(switches.length, 0, 'and switches nothing');
    assert.equal(widgetState(ctx).lines, null, 'and paints no steering row');
    assert.deepEqual(notifications, [['error', `worktree warp: feat-cancel cancelled (the session stays in ${repo})`]]);
  });

  test('a create that already asked suppresses the second question and the copy', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-5', { branch: 'feat/skip', odd: 'skip' }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    fs.writeFileSync(path.join(repo, 'pending.txt'), 'pending\n');
    clearPresence();
    addJobs(ctx, []);
    const asked = dirtyAsker('yes');
    notifications.length = 0;
    const out = await mod.executeWorktreeWarp('feat-skip', ctx, { skipDirtyPrompt: true });
    assert.notEqual(out.isError, true, JSON.stringify(out));
    assert.deepEqual(asked, [], 'the question is not asked twice');
    assert.equal(switches.length, 1, 'the move still lands');
    assert.equal(
      fs.existsSync(path.join(created.details.path, 'pending.txt')),
      false,
      'and nothing is copied a second time',
    );
  });
});

describe('warp-queue-order: the counters are sampled even without a session id', () => {
  // A host whose session identity is missing (absent, empty or a throwing
  // `getSessionId`) still has a tool counter and a `job_list` tool. The counters
  // belong to THIS session, not to its id: an id-less warp must queue for exactly
  // the same work an id-ful one waits for, keyed by the checkout it stands in.
  function ctxWithoutSessionId(repo) {
    const { ctx, switches } = movableCtx(repo);
    ctx.sessionManager.getSessionId = () => null;
    return { ctx, switches };
  }

  test('the library samples tools and jobs with no session id at all', async () => {
    const ctx = makeCtx(makeRepo());
    clearPresence();
    // The contract the front relies on: only the agent-task source needs an id
    // (it answers `unknown`, which blocks nothing), while the tool counter and
    // the host's `job_list` are sampled regardless — this is what the baseline
    // front's `waitForSessionActivity` -> `sessionActivity` also did with a null
    // id, so dropping the counters was a regression, not a baseline rule.
    addJobs(ctx, [{ id: 'job-lib-noid', status: 'running' }]);
    const withJob = await busyLib.sessionActivity({ sessionId: null, host: ctx });
    assert.equal(withJob.jobs.active, 1, 'a running job is sampled without any id');
    assert.equal(withJob.busy, true);
    assert.equal(withJob.status, 'unknown', 'only the agent-task source answers unknown without an id');

    addJobs(ctx, []);
    busyLib.noteToolStart({ toolCallId: 'call-lib-noid', toolName: 'bash' });
    try {
      const withTool = await busyLib.sessionActivity({ sessionId: null, host: ctx });
      assert.equal(withTool.tools.inFlight, 1, 'an executing tool is sampled without any id');
      assert.equal(withTool.busy, true);
    } finally {
      busyLib.forgetInFlightTools();
    }
  });

  test('a warp with no session id still queues while a tool is executing', async () => {
    const repo = makeRepo();
    const maker = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-9', { branch: 'feat/noid', odd: 'noid' }, undefined, undefined, maker);
    assert.notEqual(created.isError, true, resultText(created));

    const { ctx, switches } = ctxWithoutSessionId(repo);
    clearPresence();
    addJobs(ctx, []);
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    const rootKey = busyLib.pendingKeyFor({ root: repo });
    const starts = hooks.filter(([name]) => name === 'tool_execution_start');
    assert.ok(starts.length > 0, 'the extension registers the host’s execution pair');
    for (const [, handler] of starts) await handler({ toolCallId: 'call-noid-1', toolName: 'bash', args: {} }, ctx);
    try {
      await commands.get('warp').handler('feat-noid', ctx);
      assert.equal(switches.length, 0, 'the session must not move while a tool executes');
      assert.equal(host.sent.length, 0, 'nothing is re-dispatched now');
      const record = busyLib.pendingWarpFor(rootKey);
      assert.notEqual(record, null, 'the request is queued under the checkout it stands in');
      assert.equal(record.name, 'feat-noid');
      assert.deepEqual(widgetState(ctx).lines, [WIDGET_DIM('Queued: warp feat-noid — waiting for 1 tool still executing')]);
      assert.deepEqual(notifications, [
        ['info', 'worktree warp: handoff queued — waiting for 1 tool still executing before the move'],
      ]);
    } finally {
      busyLib.settlePendingWarp(rootKey);
    }
  });

  test('a warp with no session id still queues while a background job is running', async () => {
    const repo = makeRepo();
    const maker = makeCtx(repo);
    const created = await tools.get('worktree_create').execute('qo-10', { branch: 'feat/noidjob', odd: 'noidjob' }, undefined, undefined, maker);
    assert.notEqual(created.isError, true, resultText(created));

    const { ctx, switches } = ctxWithoutSessionId(repo);
    clearPresence();
    addJobs(ctx, [{ id: 'job-noid', status: 'running' }]);
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    const rootKey = busyLib.pendingKeyFor({ root: repo });
    try {
      await commands.get('warp').handler('feat-noidjob', ctx);
      assert.equal(switches.length, 0, 'the session must not move while a job runs');
      assert.equal(host.sent.length, 0, 'nothing is re-dispatched now');
      const record = busyLib.pendingWarpFor(rootKey);
      assert.notEqual(record, null, 'the request is queued under the checkout it stands in');
      assert.equal(record.name, 'feat-noidjob');
      assert.deepEqual(widgetState(ctx).lines, [WIDGET_DIM('Queued: warp feat-noidjob — waiting for 1 running background job')]);
      assert.deepEqual(notifications, [
        ['info', 'worktree warp: handoff queued — waiting for 1 running background job before the move'],
      ]);
    } finally {
      busyLib.settlePendingWarp(rootKey);
    }
  });
});

// ---------------------------------------------------------------------------
// warp-queue-order T2 (S4): the summary, the question and the copy use the
// checkout the session STANDS IN, never the principal checkout.
// ---------------------------------------------------------------------------
describe('warp-queue-order: the copy source is the session’s own checkout', () => {
  // Two pending files in the PRINCIPAL and one in the checkout the session
  // stands in, so a summary that read the principal could never be mistaken for
  // the right one (2 files, +2/-0 instead of 1 file, +1/-0).
  function seedBothCheckouts(repo, sessionCheckout) {
    fs.writeFileSync(path.join(repo, 'principal-one.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'principal-two.txt'), 'two\n');
    fs.writeFileSync(path.join(sessionCheckout, 'here-only.txt'), 'here\n');
  }

  test('the warp summarizes, asks about and copies from the session’s checkout', async () => {
    const repo = makeRepo();
    const maker = makeCtx(repo);
    const here = await tools.get('worktree_create').execute('qo-6', { branch: 'feat/here', odd: 'here' }, undefined, undefined, maker);
    assert.notEqual(here.isError, true, resultText(here));
    const there = await tools.get('worktree_create').execute('qo-7', { branch: 'feat/there', odd: 'there' }, undefined, undefined, maker);
    assert.notEqual(there.isError, true, resultText(there));
    seedBothCheckouts(repo, here.details.path);

    const { ctx, switches } = movableCtx(here.details.path);
    clearPresence();
    addJobs(ctx, []);
    const asked = dirtyAsker('yes');
    notifications.length = 0;
    await commands.get('warp').handler('feat-there', ctx);
    assert.deepEqual(asked, ['1 file, +1/-0'], 'the summary counts the checkout the session stands in');
    assert.equal(switches.length, 1);
    assert.equal(
      fs.readFileSync(path.join(there.details.path, 'here-only.txt'), 'utf8'),
      'here\n',
      'the copy travelled from the checkout the session stands in',
    );
    assert.equal(fs.existsSync(path.join(there.details.path, 'principal-one.txt')), false, 'nothing was copied out of the principal');
    assert.equal(fs.existsSync(path.join(there.details.path, 'principal-two.txt')), false, 'nothing was copied out of the principal');
  });

  test('the panel create’s question and copy use the session’s checkout too', async () => {
    const repo = makeRepo();
    const maker = makeCtx(repo);
    const here = await tools.get('worktree_create').execute('qo-8', { branch: 'feat/panel-here', odd: 'panel-here' }, undefined, undefined, maker);
    assert.notEqual(here.isError, true, resultText(here));
    seedBothCheckouts(repo, here.details.path);
    const target = portedDestination(repo, 'panel-made');

    const asked = dirtyAsker('yes');
    const ui = {
      mounts: 0,
      custom: async () => {
        ui.mounts += 1;
        if (ui.mounts === 1) return { create: true };
        if (ui.mounts === 2) return { ok: true, branch: 'feat/panel-made', odd: 'panel-made' };
        return undefined;
      },
    };
    notifications.length = 0;
    await commands.get('warp').handler('', makeCtx(here.details.path, { custom: ui.custom }));
    assert.deepEqual(asked, ['1 file, +1/-0'], 'the create question counts the checkout the session stands in');
    assert.ok(fs.existsSync(target), `the create made no checkout (${JSON.stringify(notifications)})`);
    assert.equal(
      fs.readFileSync(path.join(target, 'here-only.txt'), 'utf8'),
      'here\n',
      'the copy travelled from the checkout the session stands in',
    );
    assert.equal(fs.existsSync(path.join(target, 'principal-one.txt')), false, 'nothing was copied out of the principal');
    assert.equal(fs.existsSync(path.join(target, 'principal-two.txt')), false, 'nothing was copied out of the principal');
  });
});

// ---------------------------------------------------------------------------
// warp-settle-dispatch T1-T3 (S1-S6): a warp typed mid-run is QUEUED and fires
// by itself at the host's settle boundary. The host's own idle state
// (`ctx.isIdle()`) is the fourth busy source, so "the assistant is still
// thinking" — no tool executing, no agent task, no job — is busy too.
// ---------------------------------------------------------------------------
describe('warp-settle-dispatch: not-idle queues, agent_settled dispatches', () => {
  // The host's own idle state, mutated by the test. `waitForIdle` never resolves
  // while the host is processing a run, so a front that parks in a host wait is
  // observable instead of hanging the suite: it returns, and the wait is counted.
  function hostIdleState(ctx) {
    const state = { idle: false, waits: 0 };
    ctx.isIdle = () => state.idle;
    ctx.waitForIdle = () => {
      state.waits += 1;
      // The host would settle later: a front that parks here is observed by the
      // race below instead of hanging the suite when the assertion fails.
      return state.idle ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 1500));
    };
    return state;
  }

  // The host's settle boundary, driven through the handler the extension
  // registered. Awaited so a dispatch it starts is observable when it returns.
  async function settle(ctx) {
    const handlers = hooks.filter(([name]) => name === 'agent_settled');
    assert.ok(handlers.length > 0, 'the extension registers an agent_settled handler');
    for (const [, handler] of handlers) await handler({ aborted: false }, ctx);
  }

  async function createdCheckout(ctx, callId, branch, odd) {
    const created = await tools.get('worktree_create').execute(callId, { branch, odd }, undefined, undefined, ctx);
    assert.notEqual(created.isError, true, resultText(created));
    return created;
  }

  test('a mid-run warp with zero counters is queued, never awaited, and paints its row', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    const created = await createdCheckout(ctx, 'settle-1', 'feat/mid', 'mid');
    assert.notEqual(created.isError, true, resultText(created));
    clearPresence();
    const jobs = addJobs(ctx, []);
    const idle = hostIdleState(ctx);
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    try {
      const answered = await Promise.race([
        commands.get('warp').handler('feat-mid', ctx).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 400)),
      ]);
      assert.equal(answered, 'returned', 'a mid-run request never waits for the host');
      assert.equal(idle.waits, 0, 'the handler entered no host wait');
      assert.equal(switches.length, 0, 'nothing moves while the run is live');
      assert.equal(host.sent.length, 0, 'nothing is dispatched before the settle boundary');
      assert.ok(jobs.calls > 0, 'the counters were read as they are');
      const record = busyLib.pendingWarpFor(pendingKey());
      assert.notEqual(record, null, 'the request is queued');
      assert.equal(record.name, 'feat-mid');
      assert.deepEqual(notifications, [
        ['info', 'worktree warp: handoff queued — waiting for the current agent run before the move'],
      ]);
      assert.deepEqual(widgetState(ctx).lines, [WIDGET_DIM('Queued: warp feat-mid — waiting for the current agent run')]);
    } finally {
      settlePending();
    }
  });

  test('the settle boundary dispatches the pending record once, as /warp <token>', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    await createdCheckout(ctx, 'settle-2', 'feat/settled', 'settled');
    clearPresence();
    addJobs(ctx, []);
    const idle = hostIdleState(ctx);
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    try {
      await commands.get('warp').handler('feat-settled', ctx);
      assert.equal(idle.waits, 0, 'the mid-run request waited for nothing');
      assert.equal(host.sent.length, 0, 'nothing is dispatched while the run is live');
      assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the request is queued');

      // The run settles: the counters were already zero, and now the host is
      // idle too. The boundary tick dispatches without waiting for a poll.
      idle.idle = true;
      await settle(ctx);
      assert.equal(host.sent.length, 1, 'the record is dispatched at the settle boundary');
      const [message, options] = host.sent[0];
      assert.deepEqual(options, { expandPromptTemplates: true });
      assert.ok(message.startsWith('/warp @'), `the queued command is /warp (${message})`);
      assert.equal(widgetState(ctx).lines, null, 'the dispatch clears the row');

      // The dispatched command is the queued move: it lands and settles the
      // record, so the move started when the session settled.
      notifications.length = 0;
      await commands.get('warp').handler(message.slice('/warp '.length), ctx);
      assert.equal(switches.length, 1, 'the move lands at the settle boundary');
      assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'the move clears the record');
      assert.deepEqual(notifications, [], 'a real move notifies nothing');
    } finally {
      settlePending();
    }
  });

  test('a settle tick that arrives while a dispatch is already in flight dispatches nothing more', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    await createdCheckout(ctx, 'settle-3', 'feat/race', 'race');
    clearPresence();
    // A deliberately slow job list: the first tick is still inside its read when
    // the second arrives, which is exactly the window a second lock would paper
    // over. The record's own `dispatching` guard must already cover it.
    let reads = 0;
    ctx.tools = [{ name: 'job_list' }];
    ctx.executeTool = async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { content: [{ type: 'text', text: 'No background jobs in this session.' }] };
    };
    const idle = hostIdleState(ctx);
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    try {
      await commands.get('warp').handler('feat-race', ctx);
      assert.equal(host.sent.length, 0);
      assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null);

      idle.idle = true;
      const settled = settle(ctx);
      assert.equal(await until(() => reads > 0), true, 'the boundary tick reached the counters');
      const polled = busyLib.pendingWarpTick(pendingKey());
      await settled;
      assert.equal((await polled).status, 'waiting', 'the tick that found one in flight waits instead of dispatching');
      assert.equal(host.sent.length, 1, 'one record is dispatched at most once');
      assert.equal(host.sent[0][0].startsWith('/warp @'), true);
      assert.notEqual(busyLib.pendingWarpFor(pendingKey()), null, 'the record survives its own dispatch');
      assert.equal(switches.length, 0, 'nothing moved before the dispatched command ran');
    } finally {
      settlePending();
    }
  });

  test('a second warp while one is pending is refused at once and touches no host wait', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo);
    await createdCheckout(ctx, 'settle-4', 'feat/first', 'first');
    await createdCheckout(ctx, 'settle-5', 'feat/second', 'second');
    clearPresence();
    addJobs(ctx, []);
    const idle = hostIdleState(ctx);
    const switches = [];
    ctx.switchSession = async (file) => { switches.push(file); return { cancelled: false }; };
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    try {
      await commands.get('warp').handler('feat-first', ctx);
      const queued = busyLib.pendingWarpFor(pendingKey());
      assert.notEqual(queued, null, 'the first request is queued');

      notifications.length = 0;
      const answered = await Promise.race([
        commands.get('warp').handler('feat-second', ctx).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 400)),
      ]);
      assert.equal(answered, 'returned', 'a second warp answers at once');
      assert.equal(idle.waits, 0, 'the refusal entered no host wait');
      assert.equal(switches.length, 0, 'the refused second warp moves nothing');
      assert.equal(host.sent.length, 0, 'the refusal dispatches nothing');
      assert.deepEqual(notifications.map(([level]) => level), ['error']);
      assert.match(
        notifications[0][1],
        /^worktree warp: a warp to feat-first is already pending for this session — it runs when this session's tools, agent tasks and background jobs finish; wait for it or let it expire$/,
      );
      assert.equal(busyLib.pendingWarpFor(pendingKey()).queuedAt, queued.queuedAt, 'the pending request is never replaced');
    } finally {
      settlePending();
    }
  });

  test('an idle session still moves immediately: no queue, no row, no settle dispatch', async () => {
    const repo = makeRepo();
    const { ctx, switches } = movableCtx(repo);
    await createdCheckout(ctx, 'settle-6', 'feat/quiet-idle', 'quiet-idle');
    clearPresence();
    addJobs(ctx, []);
    const idle = hostIdleState(ctx);
    idle.idle = true;
    host.sent.length = 0;
    notifications.length = 0;
    widgetPaints.length = 0;
    try {
      await commands.get('warp').handler('feat-quiet-idle', ctx);
      assert.equal(switches.length, 1, 'an idle session moves straight away');
      assert.equal(idle.waits, 1, 'only the move path waits for idle');
      assert.equal(busyLib.pendingWarpFor(pendingKey()), null, 'nothing was queued');
      assert.deepEqual(notifications, [], 'a real move notifies nothing');
      assert.equal(widgetPaintsFor(ctx).length, 0, 'an immediate move paints no row');
      await settle(ctx);
      assert.equal(host.sent.length, 0, 'a settle with nothing queued dispatches nothing');
    } finally {
      settlePending();
    }
  });
});

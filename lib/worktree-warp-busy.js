'use strict';
// S4/S5/S9: a warp waits for THIS session's own background work — agent tasks
// AND background jobs — and the request is QUEUED while that work runs.
//
// WHAT IT READS. Two sources, both read through an injectable seam:
//
//  1. Agent tasks. Gentle Shell publishes one presence header per live Pi
//     session, carrying that session's agent-task counters
//     (`counts.{running,queued,waiting,finished}`) and a heartbeat. This module
//     reads that store through the SAME bounded reader the checkout-deletion
//     guard uses, hashes this session's id with the same sha256, and keeps only
//     ITS freshest header. Nothing else is read from it: no transcript, no
//     prompt, no activity payload.
//  2. Background jobs. Gentle Shell registers a `job_list` tool on the session,
//     reachable through the host seam this package already uses for
//     `session_worktree_register` (`ctx.tools` lists it, `ctx.executeTool` calls
//     it). Its text is one line per job:
//     `job-1 · running · Probe · 3s · /tmp/…/job-1.log`. A job is ACTIVE only
//     when its status field says running or queued (`running`, `queued`, or a
//     monitor's `monitor running`); `exited 0`, `failed 1` and `stopped` are all
//     finished, and "not exited" is never read as activity.
//
// THE DECISION. One rule, shared by the tool front, the command front and the
// queue's poller: nothing may move while this session has a running or queued
// agent task OR an active job.
//
// THE QUEUE. One pending warp per session, held in this process (the tool and
// the command share it). A bounded poller re-reads both sources and
// re-dispatches the SAME validated handoff once the session reports neither
// workload; the caller clears the record on every terminal outcome (moved,
// refused, cancelled, expired, shutdown). A second warp is refused while one is
// pending: the pending request is never replaced. The pending lifetime is
// bounded (`ODD_WORKTREE_WARP_PENDING_MS`) and every timer is unref'd where the
// platform allows it, so a queue never keeps the process alive.
//
// FAILURE MODE. Best effort, like the close guard: an absent or unreadable
// presence store, a `job_list` that is missing, fails or answers in a shape this
// parser does not know, all answer `unknown` and block nothing. Such an answer
// is never reported as "no jobs" — the texts say the job state is unknown only
// when that actually happened, and never blame a missing tool that is present.

const { readGentlePresence, hashSessionId, PRESENCE_FRESH_MS } = require('./worktree-session-guard.js');

// The host tool that lists this session's background jobs, and the word that
// makes a job active. The status field is `running`/`queued`, or the job kind
// followed by it (`monitor running`), so the test is a positive status word and
// never "anything but exited".
const JOB_LIST_TOOL = 'job_list';
const ACTIVE_JOB_STATUS = /(^|\s)(running|queued)(\s|$)/i;
const NO_JOBS_LINE = /^no background jobs\b/i;

// How long the command front waits for both workloads to drain before it queues
// the request, and how often it re-reads. Overridable so a session can shorten or
// lengthen its own wait; the default keeps a warp from stalling a turn.
const DEFAULT_WAIT_MS = 60000;
const POLL_MS = 2000;
const MAX_WAIT_MS = 600000;

// How long a queued warp may wait for both workloads to drain before it expires
// with a notice, and how often its poller re-reads them.
const DEFAULT_PENDING_MS = 30 * 60 * 1000;
const MAX_PENDING_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_POLL_MS = 2000;
const MAX_PENDING_POLL_MS = 60000;

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function envBudget(env, name, fallback, max) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function waitBudgetMs(env) {
  return envBudget(env, 'ODD_WORKTREE_WARP_BUSY_WAIT_MS', DEFAULT_WAIT_MS, MAX_WAIT_MS);
}

function pendingBudgetMs(env) {
  return envBudget(env, 'ODD_WORKTREE_WARP_PENDING_MS', DEFAULT_PENDING_MS, MAX_PENDING_MS);
}

function pendingPollMs(env) {
  return envBudget(env, 'ODD_WORKTREE_WARP_PENDING_POLL_MS', DEFAULT_PENDING_POLL_MS, MAX_PENDING_POLL_MS);
}

function idleActivity(status) {
  return { status, running: 0, queued: 0, waiting: 0, label: null, heartbeat: null };
}

// This session's own agent-task counters, or an idle/unavailable answer. Never
// rejects.
async function agentActivity(opts) {
  const hash = hashSessionId(opts.sessionId);
  if (hash === null) return idleActivity('unknown');
  let read;
  try {
    read = await readGentlePresence({ env: opts.env, now: opts.now });
  } catch {
    return idleActivity('unavailable');
  }
  if (!read || read.status !== 'ok') return idleActivity(read && read.status === 'unavailable' ? 'unavailable' : 'unknown');
  let freshest = null;
  for (const entry of Array.isArray(read.entries) ? read.entries : []) {
    if (!entry || entry.sessionHash !== hash || entry.recent !== true) continue;
    if (!entry.counts || !isCount(entry.counts.running) || !isCount(entry.counts.queued) || !isCount(entry.counts.waiting)) continue;
    if (freshest === null || entry.heartbeat > freshest.heartbeat) freshest = entry;
  }
  if (freshest === null) return idleActivity('ok');
  return {
    status: 'ok',
    running: freshest.counts.running,
    queued: freshest.counts.queued,
    waiting: freshest.counts.waiting,
    label: typeof freshest.label === 'string' ? freshest.label : null,
    heartbeat: freshest.heartbeat,
  };
}

// The one drain rule, applied to both workloads.
function combineActivity(agents, jobs) {
  const active = isCount(jobs.active) ? jobs.active : 0;
  return {
    status: agents.status,
    running: agents.running,
    queued: agents.queued,
    waiting: agents.waiting,
    label: agents.label,
    heartbeat: agents.heartbeat,
    jobs: { status: jobs.status, active, count: isCount(jobs.count) ? jobs.count : 0 },
    jobsUnknown: jobs.status !== 'ok',
    busy: agents.running > 0 || agents.queued > 0 || active > 0,
  };
}

// The text a `job_list` result carries, from either shape the host may use.
function toolResultText(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  if (typeof outcome.text === 'string') return outcome.text;
  const content = Array.isArray(outcome.content) ? outcome.content : null;
  if (content === null) return null;
  const parts = content
    .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text);
  return parts.length > 0 ? parts.join('\n') : null;
}

// One `job_list` answer. Empty text and the host's own "nothing to list" line
// are a definitive empty list; a line that does not carry an id and a status is
// unparsable, which is unknown rather than "no jobs".
function parseJobList(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  let active = 0;
  let count = 0;
  let unparsable = false;
  for (const line of lines) {
    if (NO_JOBS_LINE.test(line)) continue;
    const fields = line.split('\u00b7').map((field) => field.trim());
    const status = fields.length >= 2 ? fields[1] : '';
    if (fields[0].length === 0 || status.length === 0) {
      unparsable = true;
      continue;
    }
    count += 1;
    if (ACTIVE_JOB_STATUS.test(status)) active += 1;
  }
  return unparsable ? { status: 'unparsable', active, count } : { status: 'ok', active, count };
}

// This session's background jobs through the host tool. Never rejects: a host
// without the tool, a failed call and an unknown shape all answer `unknown`.
async function sessionJobs(host) {
  let available = false;
  try {
    available = !!host
      && typeof host.executeTool === 'function'
      && Array.isArray(host.tools)
      && host.tools.some((tool) => tool && tool.name === JOB_LIST_TOOL);
  } catch {
    available = false;
  }
  if (!available) return { status: 'unavailable', active: 0, count: 0 };
  let outcome;
  try {
    outcome = await host.executeTool(JOB_LIST_TOOL, {});
  } catch {
    return { status: 'error', active: 0, count: 0 };
  }
  if (!outcome || typeof outcome !== 'object' || outcome.isError === true) return { status: 'error', active: 0, count: 0 };
  const text = toolResultText(outcome);
  if (text === null) return { status: 'unparsable', active: 0, count: 0 };
  return parseJobList(text);
}

// Both workloads, as one answer: `busy` is the single drain decision.
async function sessionActivity(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const agents = await agentActivity(opts);
  return combineActivity(agents, await sessionJobs(opts.host));
}

// The workloads this session actually reports, as a phrase. `busy` is what makes
// a warp wait; `waiting`/`finished` never do.
function workloadText(activity) {
  const running = activity && isCount(activity.running) ? activity.running : 0;
  const queued = activity && isCount(activity.queued) ? activity.queued : 0;
  const jobs = activity && activity.jobs && isCount(activity.jobs.active) ? activity.jobs.active : 0;
  const parts = [];
  if (running > 0) parts.push(`${running} running agent task(s)`);
  if (queued > 0) parts.push(`${queued} queued agent task(s)`);
  if (jobs > 0) parts.push(`${jobs} running background job${jobs === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' and ') : 'no';
}

const JOB_STATE_REASONS = {
  unavailable: `${JOB_LIST_TOOL} is not available on this host`,
  error: `${JOB_LIST_TOOL} failed`,
  unparsable: `${JOB_LIST_TOOL} answered in an unexpected shape`,
};

// Said only when the job state really is unknown: a missing tool, a failed call
// or an answer this parser does not know. Never thrown at a session whose jobs
// were readable.
function jobsUnknownText(activity) {
  const jobs = activity && activity.jobs ? activity.jobs : null;
  if (!jobs || jobs.status === 'ok') return '';
  const reason = JOB_STATE_REASONS[jobs.status] || `${JOB_LIST_TOOL} gave no usable answer`;
  return `the background-job state is unknown (${reason}), so confirm any bash_background or monitor job finished`;
}

// The first line of every queued answer: the handoff is QUEUED, waiting for both
// workloads. Never a claim that the session moved. The unknown-job caveat is not
// part of this line: a front adds it as its own row, only when it happened.
function queuedText(activity) {
  return `handoff queued — waiting for ${workloadText(activity)} before the move`;
}

function expiredText(name, minutes, activity) {
  const checkout = typeof name === 'string' && name.length > 0 ? name : 'that checkout';
  const unknown = jobsUnknownText(activity);
  const line = `worktree warp: the pending warp to ${checkout} expired after ${minutes} min with nothing moved; warp again when this session's agent tasks and background jobs finish`;
  return unknown.length > 0 ? `${line} (${unknown})` : line;
}

// Poll until this session has no running or queued agent task, or the budget
// runs out. `read` and `sleep` are injected so a test never waits for real.
async function waitForSessionActivity(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const read = typeof opts.read === 'function'
    ? opts.read
    : () => sessionActivity({ sessionId: opts.sessionId, env: opts.env, host: opts.host });
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const budget = isCount(opts.waitMs) ? opts.waitMs : waitBudgetMs(opts.env);
  const poll = isCount(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : POLL_MS;
  let activity = await read();
  let waited = 0;
  while (activity && activity.busy === true && waited < budget) {
    const step = Math.min(poll, budget - waited);
    if (step <= 0) break;
    await sleep(step);
    waited += step;
    activity = await read();
  }
  return { activity, waited, waitedOut: !!(activity && activity.busy === true) };
}

// ---------------------------------------------------------------------------
// The queued warp: one pending request per session.
// ---------------------------------------------------------------------------

// The queue is keyed by the session id, which both the tool and the command can
// read, and falls back to the checkout the session stands in when the host
// exposes no id. Null means the caller has nothing to key on.
function pendingKeyFor(source) {
  const value = source && typeof source === 'object' ? source : {};
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.length > 0 ? value.sessionId : null;
  if (sessionId !== null) return `session:${sessionId}`;
  const root = typeof value.root === 'string' && value.root.length > 0 ? value.root : null;
  return root !== null ? `root:${root}` : null;
}

function handoffShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const changes = value.changes && typeof value.changes === 'object' && !Array.isArray(value.changes)
    ? {
      mode: typeof value.changes.mode === 'string' ? value.changes.mode : 'none',
      paths: Array.isArray(value.changes.paths) ? value.changes.paths.map(String) : [],
    }
    : { mode: 'none', paths: [] };
  return {
    name: String(value.name || ''),
    target: String(value.target || ''),
    from: String(value.from || ''),
    branch: String(value.branch || ''),
    changes,
  };
}

// Whether two handoff requests are the SAME queued move. The command uses this
// to tell its own pending retry (the token it re-dispatched) from a second warp
// request, which is refused.
function sameWarpHandoff(left, right) {
  const a = handoffShape(left);
  const b = handoffShape(right);
  if (a === null || b === null) return false;
  return a.name === b.name
    && a.target === b.target
    && a.from === b.from
    && a.branch === b.branch
    && a.changes.mode === b.changes.mode
    && a.changes.paths.length === b.changes.paths.length
    && a.changes.paths.every((entry, index) => entry === b.changes.paths[index]);
}

const pendingWarps = new Map();

const DEFAULT_TIMERS = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer),
};

function pendingInfo(record) {
  if (!record) return null;
  return {
    key: record.key,
    name: record.name,
    handoff: record.handoff,
    queuedAt: record.queuedAt,
    expiresAt: record.expiresAt,
    dispatching: record.dispatching === true,
  };
}

// The pending warp for a key, or null. A read-only copy: callers may inspect it
// and must never mutate the queue through it.
function pendingWarpFor(key) {
  return pendingInfo(pendingWarps.get(key) || null);
}

function pendingWarpKeys() {
  return [...pendingWarps.keys()];
}

// The refusal a SECOND warp gets while one is already pending. It names the
// checkout that is queued, never the rejected request, and says what to do.
function pendingWarpRefusalText(pending, requestedName) {
  const queuedName = pending && typeof pending.name === 'string' && pending.name.length > 0 ? pending.name : null;
  const name = queuedName
    || (typeof requestedName === 'string' && requestedName.trim().length > 0 ? requestedName.trim() : 'that checkout');
  return `a warp to ${name} is already pending for this session — it runs when the pending agent tasks and background jobs finish; wait for it or let it expire`;
}

function clearRecordTimer(record) {
  if (record.timer === null) return;
  try {
    record.deps.timers.clear(record.timer);
  } catch {
    // A dead timer never fails the queue.
  }
  record.timer = null;
}

function arm(record, delayMs) {
  if (pendingWarps.get(record.key) !== record) return;
  clearRecordTimer(record);
  const remaining = record.expiresAt - record.deps.now();
  const delay = Math.max(0, Math.min(delayMs, remaining));
  let timer = null;
  try {
    timer = record.deps.timers.set(() => {
      record.timer = null;
      // The timer must never throw into the host: a rejected tick is swallowed
      // here, and the next poll or the expiry settles the record.
      void tick(record).catch(() => {});
    }, delay);
  } catch {
    timer = null;
  }
  // A queued warp is background work: its timer must never keep the session
  // alive on its own.
  if (timer && typeof timer.unref === 'function') {
    try {
      timer.unref();
    } catch {
      // unref is a nicety, not a requirement.
    }
  }
  record.timer = timer;
}

function settle(record) {
  clearRecordTimer(record);
  if (pendingWarps.get(record.key) === record) pendingWarps.delete(record.key);
  return pendingInfo(record);
}

function expire(record) {
  const minutes = Math.max(1, Math.round((record.expiresAt - record.queuedAt) / 60000));
  const name = record.name;
  settle(record);
  try {
    if (typeof record.deps.notify === 'function') record.deps.notify(expiredText(name, minutes, record.lastActivity), 'error');
  } catch {
    // Nothing a dead UI can do may escape the timer.
  }
  return { status: 'expired' };
}

// One poll step: expire, keep waiting while the counters are busy, or dispatch
// the SAME validated handoff once they drain. Awaitable so tests drive it
// deterministically; the timer above calls it fire-and-forget. Never rejects.
async function tick(record) {
  if (pendingWarps.get(record.key) !== record) return { status: 'none' };
  const now = record.deps.now();
  if (now >= record.expiresAt) return expire(record);
  if (record.dispatching === true) {
    // Already re-dispatched; wait for that command to settle or the queue to
    // expire, so one request is never dispatched twice.
    arm(record, record.expiresAt - now);
    return { status: 'waiting' };
  }
  let activity = null;
  try {
    activity = await record.deps.read();
  } catch {
    activity = null;
  }
  if (pendingWarps.get(record.key) !== record) return { status: 'none' };
  // The last answer is what the expiry notice can honestly say: an unknown job
  // state is reported only when it was actually seen.
  record.lastActivity = activity;
  if (activity && activity.busy === true) {
    arm(record, record.deps.poll);
    return { status: 'waiting' };
  }
  record.dispatching = true;
  let refused = false;
  try {
    const dispatched = await record.deps.dispatch(record.handoff, record.token);
    if (dispatched && dispatched.ok === false) refused = true;
  } catch {
    refused = true;
  }
  if (refused) {
    // The host refused the re-dispatch: stay queued and try on the next poll
    // instead of throwing out of a timer.
    record.dispatching = false;
    arm(record, record.deps.poll);
    return { status: 'waiting' };
  }
  arm(record, record.expiresAt - record.deps.now());
  return { status: 'dispatched' };
}

// The poll step for a key, for the timer seam and for tests. Resolves; never
// rejects.
async function pendingWarpTick(key) {
  const record = pendingWarps.get(key);
  if (!record) return { status: 'none' };
  return tick(record);
}

// Hold one validated handoff as this session's pending warp and start polling.
// A second request for the same key is refused (`reason: 'pending'`) and leaves
// the existing one untouched. Never throws.
function queuePendingWarp(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const key = typeof opts.key === 'string' && opts.key.length > 0 ? opts.key : null;
  const handoff = handoffShape(opts.handoff);
  const token = typeof opts.token === 'string' && opts.token.length > 0 ? opts.token : null;
  if (key === null || handoff === null || token === null) return { ok: false, reason: 'invalid' };
  const existing = pendingWarps.get(key);
  if (existing) return { ok: false, reason: 'pending', pending: pendingInfo(existing) };
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const queuedAt = now();
  const record = {
    key,
    name: typeof opts.name === 'string' && opts.name.length > 0 ? opts.name : handoff.name,
    handoff,
    token,
    queuedAt,
    expiresAt: queuedAt + pendingBudgetMs(env),
    dispatching: false,
    timer: null,
    lastActivity: null,
    deps: {
      read: typeof opts.read === 'function'
        ? opts.read
        : () => sessionActivity({ env, host: opts.host }),
      dispatch: typeof opts.dispatch === 'function' ? opts.dispatch : null,
      notify: typeof opts.notify === 'function' ? opts.notify : null,
      env,
      now,
      poll: Math.max(1, pendingPollMs(env)),
      timers: opts.timers && typeof opts.timers === 'object' ? opts.timers : DEFAULT_TIMERS,
    },
  };
  pendingWarps.set(key, record);
  arm(record, record.deps.poll);
  return { ok: true, pending: pendingInfo(record) };
}

// The request was already dispatched (the tool front hands its handoff to the
// command and only keeps the record so a second warp is refused): wait for that
// dispatch to settle or for the queue to expire instead of sending a copy.
function markPendingWarpDispatched(key) {
  const record = pendingWarps.get(key);
  if (!record) return false;
  record.dispatching = true;
  arm(record, record.expiresAt - record.deps.now());
  return true;
}

// The dispatched retry found the session busy again: resume polling for the SAME
// request instead of dispatching a second one.
function resumePendingWarp(key) {
  const record = pendingWarps.get(key);
  if (!record) return false;
  record.dispatching = false;
  arm(record, record.deps.poll);
  return true;
}

// Every terminal outcome (moved, refused, cancelled, session gone) clears the
// record so a later warp is accepted again. Returns the cleared record, or null.
function settlePendingWarp(key) {
  const record = pendingWarps.get(key);
  return record ? settle(record) : null;
}

module.exports = {
  ACTIVE_JOB_STATUS,
  DEFAULT_PENDING_MS,
  DEFAULT_PENDING_POLL_MS,
  DEFAULT_WAIT_MS,
  JOB_LIST_TOOL,
  MAX_PENDING_MS,
  MAX_PENDING_POLL_MS,
  MAX_WAIT_MS,
  expiredText,
  jobsUnknownText,
  markPendingWarpDispatched,
  parseJobList,
  pendingBudgetMs,
  pendingKeyFor,
  pendingPollMs,
  pendingWarpFor,
  pendingWarpKeys,
  pendingWarpRefusalText,
  pendingWarpTick,
  queuePendingWarp,
  queuedText,
  resumePendingWarp,
  sameWarpHandoff,
  sessionActivity,
  sessionJobs,
  settlePendingWarp,
  waitBudgetMs,
  waitForSessionActivity,
  workloadText,
};

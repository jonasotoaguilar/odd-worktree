'use strict';
// S4: a warp waits for THIS session's own background work.
//
// Gentle Shell publishes one presence header per live Pi session, carrying that
// session's agent-task counters (`counts.{running,queued,waiting,finished}`) and
// a heartbeat. This module reads that store through the SAME bounded reader the
// checkout-deletion guard uses, hashes this session's id with the same sha256,
// and keeps only ITS freshest header. Nothing else is read: no transcript, no
// prompt, no activity payload.
//
// WHAT IT DOES NOT COVER. Background jobs (`bash_background`, `monitor`) live in
// gentle-shell's in-memory job registry (lib/background-jobs.ts) and leave no
// durable, session-attributable state on disk, and the Pi host exposes no API
// for them. This module therefore never claims to see a job: the refusal text
// names agent tasks only.
//
// FAILURE MODE. Best effort, like the close guard: an absent or unreadable
// store answers `unavailable` and blocks nothing. Only a fresh header that
// reports running or queued work makes a session busy.

const { readGentlePresence, hashSessionId, PRESENCE_FRESH_MS } = require('./worktree-session-guard.js');

// How long the command front waits for the published counters to drain before
// it refuses, and how often it re-reads. Overridable so a session can shorten
// or lengthen its own wait; the default keeps a warp from stalling a turn.
const DEFAULT_WAIT_MS = 60000;
const POLL_MS = 2000;
const MAX_WAIT_MS = 600000;

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function waitBudgetMs(env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.ODD_WORKTREE_WARP_BUSY_WAIT_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WAIT_MS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_WAIT_MS;
  return Math.min(parsed, MAX_WAIT_MS);
}

function idleActivity(status) {
  return { status, running: 0, queued: 0, waiting: 0, label: null, heartbeat: null, busy: false };
}

// This session's own counters, or an idle/unavailable answer. Never rejects.
async function sessionActivity(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
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
  const running = freshest.counts.running;
  const queued = freshest.counts.queued;
  return {
    status: 'ok',
    running,
    queued,
    waiting: freshest.counts.waiting,
    label: typeof freshest.label === 'string' ? freshest.label : null,
    heartbeat: freshest.heartbeat,
    busy: running > 0 || queued > 0,
  };
}

// The one sentence both fronts use. It names the counters it actually read and
// says plainly that background jobs are not visible to it.
function busyText(activity) {
  const running = activity && isCount(activity.running) ? activity.running : 0;
  const queued = activity && isCount(activity.queued) ? activity.queued : 0;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  const workload = parts.length > 0 ? parts.join(' and ') : 'no';
  const label = activity && typeof activity.label === 'string' && activity.label.length > 0
    ? ` on "${activity.label}"`
    : '';
  return `this session still has ${workload} agent task(s)${label}: the warp waits for them to finish (as of the last published heartbeat); background jobs are not visible here, so confirm they finished too`;
}

// Poll until this session has no running or queued agent task, or the budget
// runs out. `read` and `sleep` are injected so a test never waits for real.
async function waitForSessionActivity(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const read = typeof opts.read === 'function' ? opts.read : () => sessionActivity({ sessionId: opts.sessionId, env: opts.env });
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

module.exports = {
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  busyText,
  sessionActivity,
  waitBudgetMs,
  waitForSessionActivity,
};

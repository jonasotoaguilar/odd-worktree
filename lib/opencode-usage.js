'use strict';
// OpenCode Go subscription usage, read from the read-only endpoint the OpenCode console itself
// uses: `GET /zen/go/v1/usage`, authenticated with the same API key pi already holds for the
// `opencode-go` provider.
//
// The endpoint answers three windows and reports each as a used percentage plus a reset
// instant. It does not publish how long a window is, so the spans below are display durations:
// they drive the label, the meter width and the ordering the shell draws, never the percentage
// or the reset time.
//
// The source this file hands the shell is one payload with four keys — `schema`, `provider`,
// `pendingNote`, `fetch` — and its `fetch` is the only place the peak schedule becomes the
// panel's `plan` field, so a refresh from the panel and the widget cannot disagree about which
// window is running.

const { providerById } = require('./peak-providers.js');
const { peakStateFor } = require('./peak-schedule.js');
const { panelSchedule } = require('./peak-labels.js');

const PROVIDER = 'opencode-go';

/** The one URL this package can reach. There is no configuration for it. */
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** Matches the shell's own default provider window. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Opt-in diagnostics: fixed reason codes only, never a key or an error text. */
const DEBUG_ENV = 'PI_OPENCODE_GO_USAGE_DEBUG';

/** The schema string the usage-source contract carries. */
const USAGE_SOURCE_SCHEMA = 'gentle-pi.usage-source/v1';

/** What the panel says while nothing has answered yet, so the row is never blank. */
const PENDING_NOTE = 'opencode-go · press r to fetch';

// The row name: the panel prints `<limit name> <window label>` per line, lowercased to match
// the panel's own lowercase voice.
const LIMIT_NAME = 'go';

const HOUR = 3600;
const DAY = 24 * HOUR;

// The endpoint's three windows. The month is approximated at 30 days because no length is
// published for it; a calendar month is not always 30 days.
const WINDOWS = [
  { key: 'rolling', label: '5h', seconds: 5 * HOUR },
  { key: 'weekly', label: 'week', seconds: 7 * DAY },
  { key: 'monthly', label: 'month', seconds: 30 * DAY },
];

// The two statuses the endpoint is known to answer with. Anything else is treated as a
// malformed payload rather than guessed at, because the shell keeps its last good snapshot and
// a wrong number is worse than none.
const KNOWN_STATUSES = new Set(['ok', 'rate-limited']);

/** A full ISO 8601 instant, with an explicit offset or `Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The three readiness verdicts a source reports. Only `missing-key` says the provider is
// unusable; `unknown` covers every failure that says nothing about the key.
const READY = 'ready';
const MISSING_KEY = 'missing-key';
const UNKNOWN = 'unknown';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One window, or `undefined` when anything about it is untrustworthy. Fields are read and
 * rebuilt one by one, never merged, so a hostile payload cannot reach this object.
 */
function parseWindow(value, label, windowSeconds) {
  if (!isRecord(value)) return undefined;
  if (typeof value.status !== 'string' || !KNOWN_STATUSES.has(value.status)) return undefined;
  const percent = value.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  if (typeof value.resetsAt !== 'string' || !ISO_INSTANT.test(value.resetsAt)) return undefined;
  const resetAt = Date.parse(value.resetsAt);
  if (!Number.isFinite(resetAt)) return undefined;
  return { label, usedPercent: percent, windowSeconds, resetAt };
}

function readUsage(payload) {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  return payload.usage;
}

/**
 * Converts one `/zen/go/v1/usage` payload into the windows the shell draws, or `undefined`
 * when the payload is not exactly the expected shape.
 *
 * All or nothing on purpose: a snapshot missing one window would make a depleted subscription
 * look less used than it is, and the shell already keeps the last valid snapshot through a
 * failed read.
 */
function parseOpenCodeGoUsage(payload, now) {
  if (!Number.isFinite(now)) return undefined;
  const usage = readUsage(payload);
  if (!usage) return undefined;
  const windows = [];
  for (const { key, label, seconds } of WINDOWS) {
    const window = parseWindow(usage[key], label, seconds);
    if (!window) return undefined;
    windows.push(window);
  }
  const limitReached =
    windows.some((window) => window.usedPercent >= 100) ||
    WINDOWS.some(({ key }) => usage[key].status === 'rate-limited');
  return {
    provider: PROVIDER,
    plan: undefined,
    limits: [{ name: LIMIT_NAME, windows, limitReached, scope: 'provider' }],
    fetchedAt: now,
  };
}

function defaultReport(reason) {
  if (process.env[DEBUG_ENV]) console.error(`[pi-odd-worktree] ${reason}`);
}

async function requestUsage(apiKey, fetchFn, now, timeoutMs) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return { reason: MISSING_KEY };
  // A referenced timer, never `AbortSignal.timeout`: that helper's timer does not hold the event
  // loop, so a host whose request is the only pending work finds the process drained mid-flight on
  // Node 18-22 and the abort never fires. This timer holds the attempt open until it is cleared.
  const controller = new AbortController();
  const timedOut = () => controller.signal.aborted;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchFn(USAGE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        cache: 'no-store',
        // A redirect could replay the bearer to another origin.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return { reason: timedOut() ? 'timeout' : 'network' };
    }
    // Defense in depth: a fetch implementation that follows redirects anyway must not deliver a
    // body read from anywhere but this route.
    if (response.redirected || (response.url && response.url !== USAGE_URL)) return { reason: 'redirect' };
    if (!response.ok) return { reason: `http-${response.status}` };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { reason: timedOut() ? 'timeout' : 'invalid-json' };
    }
    if (!isRecord(payload) || !isRecord(payload.usage)) return { reason: 'unexpected-shape' };
    const usage = parseOpenCodeGoUsage(payload, now);
    if (usage) return { usage };
    const missing = WINDOWS.find(({ key }) => !isRecord(payload.usage[key]));
    return { reason: missing ? `unexpected-shape:${missing.key}` : 'unexpected-shape' };
  } finally {
    // The attempt settled: nothing may keep the loop (or the controller) alive past it.
    clearTimeout(timer);
  }
}

/**
 * Fetches one usage snapshot, or `undefined` when there is nothing trustworthy to show. The key
 * is used in the `Authorization` header and returned nowhere else; failures resolve to
 * `undefined` and report only a fixed reason code.
 *
 * `plan` is left `undefined` here: the schedule is the source's own addition, applied by
 * `createUsageSource`, so this function stays a plain reader of the route.
 */
async function fetchOpenCodeGoUsage(apiKey, fetchFn, now, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, report = defaultReport } = options;
  const { usage, reason } = await requestUsage(apiKey, fetchFn, now, timeoutMs);
  if (reason) {
    try {
      report(reason);
    } catch {
      // Diagnostics never break a refresh.
    }
  }
  return usage;
}

/**
 * The readiness verdict one failure reason proves. Only `missing-key` says the provider is
 * unusable: a timeout, a network error, a redirect, an HTTP status or a malformed response all
 * report `unknown`, because none of them says anything about whether the key is present and a
 * wrong `missing-key` would clear the peak line for a provider that is logged in.
 */
function readinessOf(reason) {
  return reason === MISSING_KEY ? MISSING_KEY : UNKNOWN;
}

/**
 * The source's `plan` field: the schedule of the fetch's own instant, peak or off-peak. This
 * provider serves the peak-priced DeepSeek family, so the field describes the registry's
 * `deepseek` window — the same schedule, now read from the provider-agnostic engine.
 */
function withPlan(usage, now) {
  return { ...usage, plan: panelSchedule(peakStateFor(providerById('deepseek'), now), now) };
}

/**
 * The payload the extension emits for the usage-source contract:
 * `{ schema, provider, pendingNote, fetch }`.
 *
 * `fetch(apiKey, fetchFn, now)` fetches one snapshot, adds the peak schedule as its `plan`, and
 * reports readiness exactly once per fetch: `ready` when a snapshot came back, `missing-key`
 * when there was no key to send, `unknown` when the attempt failed for any other reason.
 * `options` is forwarded to `fetchOpenCodeGoUsage` so a caller can shorten the request window.
 *
 * A throwing `onReadiness` never fails a refresh, exactly like a dead row never fails a menu.
 */
function createUsageSource({ onReadiness } = {}) {
  const report = (verdict) => {
    try {
      if (typeof onReadiness === 'function') onReadiness(verdict);
    } catch {
      // A dead UI never fails a refresh.
    }
  };
  return {
    schema: USAGE_SOURCE_SCHEMA,
    provider: PROVIDER,
    pendingNote: PENDING_NOTE,
    async fetch(apiKey, fetchFn, now, options = {}) {
      let verdict = UNKNOWN;
      const usage = await fetchOpenCodeGoUsage(apiKey, fetchFn, now, {
        ...options,
        report: (reason) => {
          verdict = readinessOf(reason);
          // Whatever the caller asked to be told stays told, and never decides readiness.
          if (typeof options.report === 'function') options.report(reason);
        },
      });
      if (usage !== undefined) verdict = READY;
      report(verdict);
      return usage === undefined ? undefined : withPlan(usage, now);
    },
  };
}

module.exports = {
  PROVIDER,
  USAGE_URL,
  REQUEST_TIMEOUT_MS,
  DEBUG_ENV,
  USAGE_SOURCE_SCHEMA,
  PENDING_NOTE,
  parseOpenCodeGoUsage,
  fetchOpenCodeGoUsage,
  createUsageSource,
};

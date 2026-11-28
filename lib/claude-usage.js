'use strict';
// Claude subscription usage, read from the read-only route Claude Code itself calls:
// `GET /api/oauth/usage`, authenticated with the OAuth access token the Claude Code credentials
// file already holds (or, failing that, the token pi holds for the provider).
//
// Two provider ids are served by this one module — `anthropic` and `claude-bridge` (S3) — because
// the account behind them is the same account: the panel lists only the providers the session
// actually uses, so one subscription never becomes two rows and no invented provider id appears.
//
// The route is undocumented. Only an OAuth access token can call it: a Console `sk-ant-api…` key
// and a `setup-token` are rejected there, which is why this file never sends one. The credentials
// file is READ and never refreshed or written (L4): its refresh token is single-use and rotates, so
// touching it would silently break the human's `claude` login.
//
// The source this file hands the shell is one payload with four keys — `schema`, `provider`,
// `pendingNote`, `fetch` — and its `fetch` is the only place the peak schedule becomes the panel's
// `plan` field, so a refresh from the panel and the widget cannot disagree about which window is
// running.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { providerById } = require('./peak-providers.js');
const { peakStateFor } = require('./peak-schedule.js');
const { panelSchedule } = require('./peak-labels.js');

/** The provider ids this source serves. One source each, never a third invention (L7). */
const PROVIDERS = Object.freeze(['anthropic', 'claude-bridge']);

/** The one URL this package can reach for this provider. There is no configuration for it. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Matches the shell's own default provider window. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Opt-in diagnostics: fixed reason codes only, never a token, a header or a body. */
const DEBUG_ENV = 'PI_CLAUDE_USAGE_DEBUG';

/** The schema string the usage-source contract carries. */
const USAGE_SOURCE_SCHEMA = 'gentle-pi.usage-source/v1';

/** Where the Claude Code credentials live when the environment does not point elsewhere. */
const CREDENTIALS_FILE = path.join('.claude', '.credentials.json');

/**
 * The test seam for the credentials path. It exists so a suite can point the reader at a fixture:
 * in a real session the file is the one `claude` itself writes.
 */
const CREDENTIALS_PATH_ENV = 'CLAUDE_CREDENTIALS_PATH';

// The two headers that are not cosmetic: the beta flag is what opens the OAuth route, and the
// `claude-code/<version>` User-Agent keeps it from answering a persistent 429 (L5).
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const USER_AGENT = 'claude-code/2.0.55';

// A Console key can never call this route (L5), so one is never sent. The prefix is checked, not
// the whole shape: an OAuth access token (`sk-ant-oat…`) passes, a Console key does not.
const CONSOLE_KEY_PREFIX = 'sk-ant-api';

// The credentials file's `subscriptionType` is an undocumented, unstable value (`pro`/`max`/`team`
// today). It is printed only when it reads as a plain plan word, never guessed at (S4).
const TIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

// The row name and window labels mirror the shell's own header parser (L3), so a header-driven
// snapshot and a fetched one draw the same rows.
const LIMIT_NAME = 'claude';

// The peak schedule this provider rides: the registry entry, not a second copy of its hours.
const SCHEDULE_PROVIDER_ID = 'claude';

const HOUR = 3600;
const DAY = 24 * HOUR;

// The two universal buckets. The nullable per-model buckets (`seven_day_opus`,
// `seven_day_sonnet`, `seven_day_oauth_apps`) are deliberately not read: they are optional and
// absent for most accounts, so requiring them would reject every snapshot.
const WINDOWS = [
  { key: 'five_hour', label: '5h', seconds: 5 * HOUR },
  { key: 'seven_day', label: '7d', seconds: 7 * DAY },
];

/** A full ISO 8601 instant, with an explicit offset or `Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The three readiness verdicts a source reports. Only `missing-key` says the provider is
// unusable; `unknown` covers every failure that says nothing about the token.
const READY = 'ready';
const MISSING_KEY = 'missing-key';
const UNKNOWN = 'unknown';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * What the panel says while nothing has answered yet, so the section is never blank. It names the
 * product, not the provider id the shell happens to list: a bridge and a logged-in provider are the
 * same subscription, and one note for both says so. The section's own heading stays the id the host
 * listed — that text is the shell's, not this package's.
 */
const PENDING_NOTE = 'claude · press r to fetch';

/** The credentials file this process reads: the environment's path, else the real one. */
function credentialsPath() {
  const override = process.env[CREDENTIALS_PATH_ENV];
  if (typeof override === 'string' && override.length > 0) return override;
  return path.join(os.homedir(), CREDENTIALS_FILE);
}

/**
 * The `claudeAiOauth` block of the credentials document, or `undefined`. Read defensively on
 * purpose: a missing file, an unparsable document and a document without the block all mean "no
 * token", never a throw that would take a panel refresh down.
 */
function readCredentialsBlock() {
  let text;
  try {
    text = fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return undefined;
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || !isRecord(document.claudeAiOauth)) return undefined;
  return document.claudeAiOauth;
}

/**
 * The token to send, or `undefined`. A value is usable only once trimmed: an empty, whitespace-only or
 * Console-key value is unusable, because the route answers it with an error and sending one would only
 * turn a missing token into a failed request. The trimmed value is what gets sent, so a padded
 * credential never carries its padding into the header.
 */
function usableToken(value) {
  if (typeof value !== 'string') return undefined;
  const token = value.trim();
  if (token.length === 0 || token.startsWith(CONSOLE_KEY_PREFIX)) return undefined;
  return token;
}

/**
 * Whether the credentials file's scope list rules its token out. A `setup-token` carries no
 * `user:profile` scope and the route answers it with a 403 (L5), so a token whose explicit, non-empty
 * `scopes` array lacks that scope can only produce a failure. A missing or empty array proves nothing —
 * older files do not carry scopes at all — so it keeps the token.
 */
function lacksProfileScope(block) {
  const scopes = block.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return scopes.includes('user:profile') === false;
}

/**
 * `expiresAt` in milliseconds, or `undefined` when the file does not say. Current builds write
 * epoch milliseconds (13 digits) and older ones epoch seconds (10 digits), so the unit is read
 * from the magnitude instead of being assumed.
 */
function normalizeExpiry(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

/** The tier to print, or `undefined` when the value is not a plain plan word. */
function normalizeTier(value) {
  if (typeof value !== 'string') return undefined;
  const tier = value.trim().toLowerCase();
  return TIER_PATTERN.test(tier) ? tier : undefined;
}

/**
 * The token to send, first usable candidate wins: the Claude Code credentials file, then the host's
 * own `apiKey`. An expired or scope-less credential is not a usable candidate (L4/L5): this file never
 * refreshes it, so the request would only fail — and, when nothing else is available, that is reported
 * as `expired-token` or `unusable-token` rather than as a missing one.
 *
 * The same string arriving back from the host is that same rejected credential, not a second chance:
 * sending it again can only produce the same failure, so nothing is sent.
 *
 * The tier travels with the file's token and with nothing else (L6): a token the host held says
 * nothing about which subscription the account is on.
 */
function resolveToken(apiKey, now) {
  const block = readCredentialsBlock();
  const fileToken = usableToken(block === undefined ? undefined : block.accessToken);
  let rejected;
  if (fileToken !== undefined) {
    const expiresAt = normalizeExpiry(block.expiresAt);
    // An instant that cannot be read proves nothing, so only a readable, past instant expires it.
    const isPast = expiresAt !== undefined && Number.isFinite(now) && expiresAt <= now;
    if (isPast) rejected = { token: fileToken, reason: 'expired-token' };
    else if (lacksProfileScope(block)) rejected = { token: fileToken, reason: 'unusable-token' };
    else return { token: fileToken, tier: normalizeTier(block.subscriptionType) };
  }
  const hostToken = usableToken(apiKey);
  if (hostToken !== undefined && (rejected === undefined || hostToken !== rejected.token)) {
    return { token: hostToken };
  }
  return { reason: rejected === undefined ? MISSING_KEY : rejected.reason };
}

/**
 * One window, or `undefined` when anything about it is untrustworthy. Fields are read and rebuilt
 * one by one, never merged, so a hostile payload cannot reach this object.
 */
function parseWindow(value, label, windowSeconds) {
  if (!isRecord(value)) return undefined;
  const percent = value.utilization;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  if (typeof value.resets_at !== 'string' || !ISO_INSTANT.test(value.resets_at)) return undefined;
  const resetAt = Date.parse(value.resets_at);
  if (!Number.isFinite(resetAt)) return undefined;
  return { label, usedPercent: percent, windowSeconds, resetAt };
}

/**
 * Converts one `/api/oauth/usage` payload into the windows the shell draws, or `undefined` when
 * the payload is not exactly the expected shape.
 *
 * All or nothing on purpose: a snapshot missing one universal bucket would make a depleted
 * subscription look less used than it is, and the shell already keeps the last valid snapshot
 * through a failed read. The per-model buckets are not part of the shape, so their absence or
 * malformation changes nothing.
 */
function parseClaudeUsage(payload, now, provider = PROVIDERS[0]) {
  if (!Number.isFinite(now)) return undefined;
  if (!isRecord(payload)) return undefined;
  const windows = [];
  for (const { key, label, seconds } of WINDOWS) {
    const window = parseWindow(payload[key], label, seconds);
    if (!window) return undefined;
    windows.push(window);
  }
  const limitReached = windows.some((window) => window.usedPercent >= 100);
  return {
    provider,
    plan: undefined,
    limits: [{ name: LIMIT_NAME, windows, limitReached, scope: 'provider' }],
    fetchedAt: now,
  };
}

function defaultReport(reason) {
  if (process.env[DEBUG_ENV]) console.error(`[pi-odd-worktree] ${reason}`);
}

async function requestUsage(token, fetchFn, now, timeoutMs, provider) {
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
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': ANTHROPIC_BETA,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
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
    if (!response.ok) {
      // Never interpolate an unchecked status: a fetch adapter that answers a string would put that
      // string into the reason code, and a reason code is a fixed token — it reaches the debug console.
      const status = response.status;
      const code = Number.isInteger(status) && status >= 100 && status <= 599 ? `http-${status}` : 'http-unknown';
      return { reason: code };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { reason: timedOut() ? 'timeout' : 'invalid-json' };
    }
    if (!isRecord(payload)) return { reason: 'unexpected-shape' };
    const usage = parseClaudeUsage(payload, now, provider);
    if (usage) return { usage };
    const missing = WINDOWS.find(({ key }) => !isRecord(payload[key]));
    return { reason: missing ? `unexpected-shape:${missing.key}` : 'unexpected-shape' };
  } finally {
    // The attempt settled: nothing may keep the loop (or the controller) alive past it.
    clearTimeout(timer);
  }
}

/**
 * The one refresh wave this module has already answered for, as `<fingerprint>:<instant>`, or `null`.
 * Held in memory for the life of the process and never logged or returned: the fingerprint is a hash of
 * the token, so the claim identifies the account without the credential ever being stored beside it.
 *
 * The host refreshes every provider in scope inside one wave and hands the SAME instant to each source,
 * which is what this keys on: one account answers once per wave, so the second id the session lists shows
 * the host's own note instead of a copy of the numbers. One entry only — a later wave replaces it, so
 * neither id is ever silenced for good.
 */
let claimedWave = null;

/** The account's wave key: a hash of the token that answered, never the token. */
function waveKeyFor(token, now) {
  return `${crypto.createHash('sha256').update(token).digest('hex')}:${now}`;
}

/**
 * Forgets the claimed wave. A test seam only: in a running session the next wave replaces the entry by
 * itself, which is why no host path ever calls this.
 */
function resetWaveClaim() {
  claimedWave = null;
}

/**
 * One attempt: resolve the token, then read the route. The tier is returned beside the snapshot
 * because it belongs to the token that was actually used, and a failure carries none.
 */
async function readOnce(apiKey, fetchFn, now, { timeoutMs, provider, report }) {
  const resolved = resolveToken(apiKey, now);
  let outcome;
  if (resolved.reason) {
    outcome = { reason: resolved.reason };
  } else {
    const wave = waveKeyFor(resolved.token, now);
    // Claimed BEFORE the request on purpose: the second provider of the same wave must duplicate
    // neither the numbers nor the network call, whether the first one succeeded, failed or is still
    // in flight. A wave with no usable token never reaches this line, so `missing-key` still reaches
    // every id it applies to.
    if (wave === claimedWave) {
      outcome = { reason: 'duplicate-account' };
    } else {
      claimedWave = wave;
      outcome = await requestUsage(resolved.token, fetchFn, now, timeoutMs, provider);
    }
  }
  if (outcome.reason !== undefined) {
    try {
      if (typeof report === 'function') report(outcome.reason);
    } catch {
      // Diagnostics never break a refresh.
    }
  }
  return {
    usage: outcome.usage,
    reason: outcome.reason,
    tier: outcome.usage === undefined ? undefined : resolved.tier,
  };
}

/**
 * Fetches one usage snapshot, or `undefined` when there is nothing trustworthy to show. The token
 * is used in the `Authorization` header and returned nowhere else; failures resolve to `undefined`
 * and report only a fixed reason code.
 *
 * `plan` is left `undefined` here: the schedule is the source's own addition, applied by
 * `createUsageSource`, so this function stays a plain reader of the route.
 */
async function fetchClaudeUsage(apiKey, fetchFn, now, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, report = defaultReport, provider = PROVIDERS[0] } = options;
  const { usage } = await readOnce(apiKey, fetchFn, now, { timeoutMs, provider, report });
  return usage;
}

/**
 * The readiness verdict one failure reason proves. Only `missing-key` says the provider is
 * unusable: a timeout, a network error, a redirect, an HTTP status, a malformed response or an
 * expired credential all report `unknown`, because a wrong `missing-key` would clear the peak line
 * for a provider that is logged in.
 */
function readinessOf(reason) {
  return reason === MISSING_KEY ? MISSING_KEY : UNKNOWN;
}

/**
 * The source's `plan` field: the tier when the credentials file offered one, then the schedule of
 * the fetch's own instant. The schedule is the registry's `claude` window — 05:00-11:00 Pacific on
 * weekdays — read from the provider-agnostic engine, so no hours or multiplier are copied here.
 */
function withPlan(usage, now, tier) {
  const schedule = panelSchedule(peakStateFor(providerById(SCHEDULE_PROVIDER_ID), now), now);
  return { ...usage, plan: tier === undefined ? schedule : `${tier} · ${schedule}` };
}

/**
 * The payload the extension emits for the usage-source contract:
 * `{ schema, provider, pendingNote, fetch }`, one per served provider id.
 *
 * `fetch(apiKey, fetchFn, now)` reads one snapshot, adds the tier and the peak schedule as its
 * `plan`, and reports readiness exactly once per fetch: `ready` when a snapshot came back,
 * `missing-key` when there was no token to send, `unknown` when the attempt failed for any other
 * reason. `options` is forwarded to the reader so a caller can shorten the request window.
 *
 * A provider id this source does not serve gets no source at all: emitting one would make the
 * panel claim a provider that nothing answers for.
 */
function createUsageSource(providerId, options = {}) {
  if (PROVIDERS.includes(providerId) === false) return undefined;
  const settings = isRecord(options) ? options : {};
  const report = (verdict) => {
    try {
      if (typeof settings.onReadiness === 'function') settings.onReadiness(verdict);
    } catch {
      // A dead UI never fails a refresh.
    }
  };
  return {
    schema: USAGE_SOURCE_SCHEMA,
    provider: providerId,
    pendingNote: PENDING_NOTE,
    async fetch(apiKey, fetchFn, now, options = {}) {
      let verdict = UNKNOWN;
      const forwarded = isRecord(options) ? options : {};
      const { usage, tier } = await readOnce(apiKey, fetchFn, now, {
        timeoutMs: Number.isFinite(forwarded.timeoutMs) ? forwarded.timeoutMs : REQUEST_TIMEOUT_MS,
        provider: providerId,
        report: (reason) => {
          verdict = readinessOf(reason);
          // Whatever the caller asked to be told stays told, and never decides readiness.
          if (typeof forwarded.report === 'function') forwarded.report(reason);
        },
      });
      if (usage !== undefined) verdict = READY;
      report(verdict);
      return usage === undefined ? undefined : withPlan(usage, now, tier);
    },
  };
}

module.exports = {
  PROVIDERS,
  USAGE_URL,
  USAGE_SOURCE_SCHEMA,
  REQUEST_TIMEOUT_MS,
  DEBUG_ENV,
  CREDENTIALS_PATH_ENV,
  PENDING_NOTE,
  resetWaveClaim,
  parseClaudeUsage,
  fetchClaudeUsage,
  createUsageSource,
};

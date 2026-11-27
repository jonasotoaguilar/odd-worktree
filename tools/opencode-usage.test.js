'use strict';
// S1 (opencode-usage-alert): the OpenCode Go usage source. It reads the read-only endpoint the
// OpenCode console itself uses, maps its three windows into one provider-scoped snapshot, and
// registers itself through the usage-source contract with the peak schedule as its `plan`.
// Failures resolve to no snapshot and report a fixed reason code, never the key: the shell
// keeps its last good snapshot, and only a missing key proves the provider is unusable.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER,
  PENDING_NOTE,
  REQUEST_TIMEOUT_MS,
  USAGE_SOURCE_SCHEMA,
  USAGE_URL,
  createUsageSource,
  fetchOpenCodeGoUsage,
  parseOpenCodeGoUsage,
} = require('../lib/opencode-usage.js');
const { formatPeakState, peakStateAt } = require('../lib/opencode-peak.js');

const NOW = Date.parse('2026-09-23T12:00:00Z');
// 2026-09-23 is a Wednesday: 03:40 UTC is inside the first peak window, 04:30 UTC between them.
const PEAK_INSTANT = Date.parse('2026-09-23T03:40:00Z');
const OFF_PEAK_INSTANT = Date.parse('2026-09-23T04:30:00Z');

function payload() {
  return {
    usage: {
      rolling: { status: 'ok', percent: 20, resetsAt: '2026-09-23T17:00:00.000Z' },
      weekly: { status: 'ok', percent: 42.5, resetsAt: '2026-09-30T12:00:00Z' },
      monthly: { status: 'ok', percent: 55, resetsAt: '2026-10-23T12:00:00Z' },
    },
  };
}

function response(data = payload(), options = {}) {
  return { ok: true, redirected: false, url: USAGE_URL, json: async () => data, ...options };
}

describe('the usage payload', () => {
  test('maps the three Go windows into one provider-scoped snapshot', () => {
    assert.deepEqual(parseOpenCodeGoUsage(payload(), NOW), {
      provider: PROVIDER,
      plan: undefined,
      fetchedAt: NOW,
      limits: [
        {
          name: 'go',
          scope: 'provider',
          limitReached: false,
          windows: [
            { label: '5h', usedPercent: 20, windowSeconds: 18_000, resetAt: Date.parse('2026-09-23T17:00:00.000Z') },
            { label: 'week', usedPercent: 42.5, windowSeconds: 604_800, resetAt: Date.parse('2026-09-30T12:00:00Z') },
            { label: 'month', usedPercent: 55, windowSeconds: 2_592_000, resetAt: Date.parse('2026-10-23T12:00:00Z') },
          ],
        },
      ],
    });
  });

  test('a full window or a rate-limited status marks the limit reached', () => {
    const full = payload();
    full.usage.weekly.percent = 100;
    assert.equal(parseOpenCodeGoUsage(full, NOW)?.limits[0].limitReached, true);

    const throttled = payload();
    throttled.usage.monthly.status = 'rate-limited';
    assert.equal(parseOpenCodeGoUsage(throttled, NOW)?.limits[0].limitReached, true);

    const border = payload();
    border.usage.rolling.percent = 0;
    assert.equal(parseOpenCodeGoUsage(border, NOW)?.limits[0].limitReached, false);
  });

  test('any window that is missing or malformed rejects the whole snapshot', () => {
    for (const key of ['rolling', 'weekly', 'monthly']) {
      const missing = payload();
      delete missing.usage[key];
      assert.equal(parseOpenCodeGoUsage(missing, NOW), undefined, `missing ${key}`);

      for (const broken of [
        { status: 'ok', percent: '20', resetsAt: '2026-09-23T17:00:00Z' },
        { status: 'ok', percent: 20 },
        { status: 'ok', percent: 20, resetsAt: 'yesterday' },
        { status: 'ok', percent: -1, resetsAt: '2026-09-23T17:00:00Z' },
        { status: 'ok', percent: 101, resetsAt: '2026-09-23T17:00:00Z' },
        { status: 'ok', percent: Number.NaN, resetsAt: '2026-09-23T17:00:00Z' },
        { status: 'active', percent: 20, resetsAt: '2026-09-23T17:00:00Z' },
        { percent: 20, resetsAt: '2026-09-23T17:00:00Z' },
        null,
        [],
      ]) {
        const data = payload();
        data.usage[key] = broken;
        assert.equal(parseOpenCodeGoUsage(data, NOW), undefined, `broken ${key}: ${JSON.stringify(broken)}`);
      }
    }
    assert.equal(parseOpenCodeGoUsage({}, NOW), undefined);
    assert.equal(parseOpenCodeGoUsage({ usage: [] }, NOW), undefined);
    assert.equal(parseOpenCodeGoUsage({ usage: 'nope' }, NOW), undefined);
    assert.equal(parseOpenCodeGoUsage(null, NOW), undefined);
    assert.equal(parseOpenCodeGoUsage(payload(), Number.NaN), undefined);
  });
});

describe('the fetch', () => {
  test('a missing key never sends a request', async () => {
    const fetchFn = () => {
      throw new Error('fetch must not run');
    };
    assert.equal(await fetchOpenCodeGoUsage(undefined, fetchFn, NOW), undefined);
    assert.equal(await fetchOpenCodeGoUsage('', fetchFn, NOW), undefined);
  });

  test('one GET to the fixed route, with the key only in the header, and no body leak', async () => {
    let calls = 0;
    const usage = await fetchOpenCodeGoUsage(
      'test-secret',
      async (url, options) => {
        calls++;
        assert.equal(url, USAGE_URL);
        const { signal, ...rest } = options;
        assert.ok(signal instanceof AbortSignal);
        assert.deepEqual(rest, {
          method: 'GET',
          headers: { Authorization: 'Bearer test-secret', Accept: 'application/json' },
          cache: 'no-store',
          redirect: 'error',
        });
        return response();
      },
      NOW,
    );
    assert.equal(calls, 1);
    assert.equal(usage?.provider, PROVIDER);
    assert.equal(JSON.stringify(usage).includes('test-secret'), false);
  });

  test('failures resolve to no snapshot and report a fixed code, never the key', async () => {
    const reasons = [];
    const report = (reason) => reasons.push(reason);

    for (const [value, expected] of [
      [response(undefined, { ok: false, status: 401 }), 'http-401'],
      [response(undefined, { ok: false, status: 500 }), 'http-500'],
      [response(undefined, { redirected: true }), 'redirect'],
      [response(undefined, { url: 'https://other.example/usage' }), 'redirect'],
      [response({ usage: {} }), 'unexpected-shape:rolling'],
      [response({ usage: 'nope' }), 'unexpected-shape'],
    ]) {
      const usage = await fetchOpenCodeGoUsage('secret', async () => value, NOW, { report });
      assert.equal(usage, undefined, expected);
      assert.equal(reasons.at(-1), expected);
    }

    assert.equal(
      await fetchOpenCodeGoUsage(
        'secret',
        async () => {
          throw new Error('secret: network failure');
        },
        NOW,
        { report },
      ),
      undefined,
    );
    assert.equal(reasons.at(-1), 'network');

    assert.equal(
      await fetchOpenCodeGoUsage(
        'secret',
        async () =>
          response(undefined, {
            json: async () => {
              throw new Error('secret: invalid JSON');
            },
          }),
        NOW,
        { report },
      ),
      undefined,
    );
    assert.equal(reasons.at(-1), 'invalid-json');

    assert.equal(await fetchOpenCodeGoUsage(undefined, async () => response(), NOW, { report }), undefined);
    assert.equal(reasons.at(-1), 'missing-key');
    assert.equal(reasons.join(' ').includes('secret'), false);
  });

  test('a throwing diagnostics sink cannot break a successful refresh', async () => {
    const usage = await fetchOpenCodeGoUsage('secret', async () => response(), NOW, {
      report: () => {
        throw new Error('sink');
      },
    });
    assert.equal(usage?.provider, PROVIDER);
  });

  test('the request carries its own bounded window, and a hung response is a timeout', async () => {
    let seen;
    await fetchOpenCodeGoUsage(
      'secret',
      async (_url, options) => {
        seen = options.signal;
        return response();
      },
      NOW,
    );
    assert.ok(seen instanceof AbortSignal);
    assert.equal(REQUEST_TIMEOUT_MS, 10_000);

    // A request that outlives its own window is reported as a timeout, not as a network error.
    const reasons = [];
    const hung = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    assert.equal(await fetchOpenCodeGoUsage('secret', hung, NOW, { timeoutMs: 5, report: (r) => reasons.push(r) }), undefined);
    assert.deepEqual(reasons, ['timeout']);
  });
});

describe('the source it registers', () => {
  const sourceOf = (onReadiness) => createUsageSource({ onReadiness });

  test('the payload has exactly the four keys the usage-source contract names', () => {
    const source = sourceOf(() => {});
    assert.deepEqual(Object.keys(source).sort(), ['fetch', 'pendingNote', 'provider', 'schema']);
    assert.equal(USAGE_SOURCE_SCHEMA, 'gentle-pi.usage-source/v1');
    assert.equal(source.schema, USAGE_SOURCE_SCHEMA);
    assert.equal(source.provider, 'opencode-go');
    assert.equal(PROVIDER, 'opencode-go');
    // A missing key must leave exactly this note behind, with the `·` the shell prints.
    assert.equal(source.pendingNote, 'opencode-go · press r to fetch');
    assert.equal(PENDING_NOTE, source.pendingNote);
    assert.equal(typeof source.fetch, 'function');
  });

  test('the plan is the peak schedule of the fetch instant, peak or off-peak', async () => {
    const source = sourceOf(() => {});
    for (const [now, expected] of [
      [PEAK_INSTANT, 'peak 20m'],
      [OFF_PEAK_INSTANT, 'off-peak 1hr 30m'],
    ]) {
      const usage = await source.fetch('secret', async () => response(), now);
      assert.equal(usage?.plan, expected, String(now));
      assert.equal(usage?.plan, formatPeakState(peakStateAt(now), now));
      // The window labels stay exactly as read: the schedule rides only on the provider line.
      assert.deepEqual(
        usage?.limits[0].windows.map((window) => window.label),
        ['5h', 'week', 'month'],
      );
      // The panel's own role is muted already, so the field carries no escape at all.
      assert.equal(String(usage?.plan).includes('\x1b['), false);
    }
  });

  test('a successful fetch reports "ready" once', async () => {
    const verdicts = [];
    const usage = await sourceOf((verdict) => verdicts.push(verdict)).fetch('secret', async () => response(), NOW);
    assert.equal(usage?.provider, PROVIDER);
    assert.deepEqual(verdicts, ['ready']);
  });

  test('only a missing key reports "missing-key"', async () => {
    const verdicts = [];
    const source = sourceOf((verdict) => verdicts.push(verdict));
    const calls = () => {
      throw new Error('fetch must not run');
    };
    assert.equal(await source.fetch(undefined, calls, NOW), undefined);
    assert.equal(await source.fetch('', calls, NOW), undefined);
    assert.deepEqual(verdicts, ['missing-key', 'missing-key']);
  });

  test('a timeout, a network error or a malformed response reports "unknown", never unusable', async () => {
    const verdicts = [];
    const source = sourceOf((verdict) => verdicts.push(verdict));

    const hung = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    assert.equal(await source.fetch('secret', hung, NOW, { timeoutMs: 5 }), undefined);
    assert.deepEqual(verdicts, ['unknown'], 'timeout');

    assert.equal(
      await source.fetch(
        'secret',
        async () => {
          throw new Error('offline');
        },
        NOW,
      ),
      undefined,
    );
    assert.equal(verdicts.at(-1), 'unknown', 'network error');

    for (const bad of [response({ usage: {} }), response({ usage: 'nope' }), response({})]) {
      assert.equal(await source.fetch('secret', async () => bad, NOW), undefined);
      assert.equal(verdicts.at(-1), 'unknown', 'malformed response');
    }
    // Nothing above proves the key is missing, so the provider is never marked unusable.
    assert.equal(verdicts.includes('missing-key'), false);
    assert.equal(verdicts.length, 5);
  });

  test('a throwing readiness sink cannot break a refresh', async () => {
    const source = sourceOf(() => {
      throw new Error('ui gone');
    });
    const usage = await source.fetch('secret', async () => response(), NOW);
    assert.equal(usage?.provider, PROVIDER);
    assert.equal(await source.fetch(undefined, async () => response(), NOW), undefined);
  });
});

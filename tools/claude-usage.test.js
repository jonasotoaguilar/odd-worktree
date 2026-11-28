'use strict';
// S1-S4 (claude-usage): the Claude usage source. It reads the read-only route Claude Code itself
// calls, authenticating with the OAuth access token the Claude Code credentials file holds (or,
// failing that, the key the host holds for the provider), maps the two universal buckets into one
// provider-scoped snapshot, and registers one source per served provider id with the tier and the
// peak schedule as its `plan`.
//
// Two invariants this suite enforces on itself: no case here may read the real
// `~/.claude/.credentials.json`, and none may touch the network. Every credential case points
// `CLAUDE_CREDENTIALS_PATH` at a `tools/fixtures/` document copied into a fresh temp directory that
// the case removes again.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROVIDERS,
  PENDING_NOTE,
  REQUEST_TIMEOUT_MS,
  USAGE_SOURCE_SCHEMA,
  USAGE_URL,
  CREDENTIALS_PATH_ENV,
  createUsageSource,
  fetchClaudeUsage,
  parseClaudeUsage,
  resetWaveClaim,
} = require('../lib/claude-usage.js');
// The plan literals are asserted against the engine that produces them, for the registry entry the
// source publishes: Claude's schedule.
const { providerById } = require('../lib/peak-providers.js');
const { formatPeakState, peakStateFor } = require('../lib/peak-schedule.js');
const { SHELL_SLOT, defaultShellApi, loadExtension } = require('./fixtures/load-extension.js');

const FIXTURE = path.resolve(__dirname, 'fixtures/claude-credentials.json');

// Wednesday 2026-11-25. 14:00 UTC is 06:00 Pacific (PST), inside Claude's weekday window; 12:00 UTC
// is 04:00 Pacific, one hour before it opens.
const NOW = Date.parse('2026-11-25T14:00:00Z');
const PEAK_INSTANT = NOW;
const OFF_PEAK_INSTANT = Date.parse('2026-11-25T12:00:00Z');

/** The fixture's own token, so a case can prove exactly which one was sent. */
function fixtureToken() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).claudeAiOauth.accessToken;
}

/** The fixture document, with the `claudeAiOauth` block edited by `overrides`. */
function credentials(overrides = {}) {
  const document = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  return { ...document, claudeAiOauth: { ...document.claudeAiOauth, ...overrides } };
}

/** A credentials document without the block at all. */
function withoutBlock() {
  return { otherTools: true };
}

/**
 * Run one case with `CLAUDE_CREDENTIALS_PATH` pointing at a fresh temp directory: `contents`
 * written as the credentials document, or nothing written at all (the missing-file case). The
 * directory is removed again whatever the case does.
 */
async function withCredentials(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
  const file = path.join(dir, '.credentials.json');
  const saved = process.env[CREDENTIALS_PATH_ENV];
  try {
    if (contents !== undefined) {
      fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    process.env[CREDENTIALS_PATH_ENV] = file;
    return await run(file);
  } finally {
    if (saved === undefined) delete process.env[CREDENTIALS_PATH_ENV];
    else process.env[CREDENTIALS_PATH_ENV] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The common case: no credentials file in reach. */
const withoutCredentials = (run) => withCredentials(undefined, run);

function payload() {
  return {
    five_hour: { utilization: 20, resets_at: '2026-11-25T19:00:00.000Z' },
    seven_day: { utilization: 42.5, resets_at: '2026-12-02T14:00:00Z' },
    seven_day_opus: null,
  };
}

function response(data = payload(), options = {}) {
  return { ok: true, redirected: false, url: USAGE_URL, json: async () => data, ...options };
}

/** A fetch that must never run: the case is about what happens before the request. */
function noRequest() {
  throw new Error('fetch must not run');
}

/**
 * One refresh wave of the host's own doing: every source in scope is fetched with the same instant. A
 * case that is several waves in a row forgets the claim in between, exactly as a later save point
 * would; nothing in a running session has to.
 */
const nextWave = () => resetWaveClaim();

const savedSlot = globalThis[SHELL_SLOT];
afterEach(() => {
  resetWaveClaim();
  if (savedSlot === undefined) delete globalThis[SHELL_SLOT];
  else globalThis[SHELL_SLOT] = savedSlot;
});

describe('the usage payload', () => {
  test('maps the two universal buckets into one provider-scoped snapshot', () => {
    assert.deepEqual(parseClaudeUsage(payload(), NOW), {
      provider: 'anthropic',
      plan: undefined,
      fetchedAt: NOW,
      limits: [
        {
          // The host's own header parser calls the limit `claude` with these labels (L3).
          name: 'claude',
          scope: 'provider',
          limitReached: false,
          windows: [
            { label: '5h', usedPercent: 20, windowSeconds: 18_000, resetAt: Date.parse('2026-11-25T19:00:00.000Z') },
            { label: '7d', usedPercent: 42.5, windowSeconds: 604_800, resetAt: Date.parse('2026-12-02T14:00:00Z') },
          ],
        },
      ],
    });
    assert.equal(parseClaudeUsage(payload(), NOW, 'claude-bridge')?.provider, 'claude-bridge');
  });

  test('the nullable per-model buckets are skipped, whatever they say', () => {
    for (const extra of [
      { seven_day_opus: null },
      { seven_day_opus: { utilization: 'nope' } },
      { seven_day_sonnet: { utilization: 400, resets_at: 'yesterday' } },
      { seven_day_oauth_apps: {} },
      { extra_usage: { enabled: true } },
    ]) {
      assert.deepEqual(parseClaudeUsage({ ...payload(), ...extra }, NOW)?.limits[0].windows.length, 2, JSON.stringify(extra));
    }
  });

  test('either universal bucket missing or malformed rejects the whole snapshot', () => {
    for (const key of ['five_hour', 'seven_day']) {
      const missing = payload();
      delete missing[key];
      assert.equal(parseClaudeUsage(missing, NOW), undefined, `missing ${key}`);

      for (const broken of [
        { utilization: '20', resets_at: '2026-11-25T19:00:00Z' },
        { utilization: 20 },
        { utilization: 20, resets_at: 'yesterday' },
        { utilization: 20, resets_at: 1_764_094_400 },
        { utilization: -1, resets_at: '2026-11-25T19:00:00Z' },
        { utilization: 101, resets_at: '2026-11-25T19:00:00Z' },
        { utilization: Number.NaN, resets_at: '2026-11-25T19:00:00Z' },
        null,
        {},
        [],
      ]) {
        const data = payload();
        data[key] = broken;
        assert.equal(parseClaudeUsage(data, NOW), undefined, `broken ${key}: ${JSON.stringify(broken)}`);
      }
    }
    assert.equal(parseClaudeUsage({ five_hour: payload().five_hour }, NOW), undefined);
    assert.equal(parseClaudeUsage([], NOW), undefined);
    assert.equal(parseClaudeUsage(null, NOW), undefined);
    assert.equal(parseClaudeUsage(payload(), Number.NaN), undefined);
  });

  test('the limit counts as reached from 100% up', () => {
    const full = payload();
    full.five_hour.utilization = 100;
    assert.equal(parseClaudeUsage(full, NOW)?.limits[0].limitReached, true);

    const almost = payload();
    almost.five_hour.utilization = 99.9;
    almost.seven_day.utilization = 99.9;
    assert.equal(parseClaudeUsage(almost, NOW)?.limits[0].limitReached, false);

    const weekly = payload();
    weekly.seven_day.utilization = 120;
    assert.equal(parseClaudeUsage(weekly, NOW), undefined, 'out of range is malformed, not reached');
  });
});

describe('the token', () => {
  test('the credentials file token wins over the key the host holds', async () => {
    await withCredentials(credentials(), async () => {
      let seen;
      const usage = await fetchClaudeUsage(
        'host-oauth-key',
        async (url, options) => {
          seen = options.headers.Authorization;
          return response();
        },
        NOW,
      );
      assert.equal(seen, `Bearer ${fixtureToken()}`);
      assert.equal(usage?.provider, 'anthropic');
      assert.equal(JSON.stringify(usage).includes(fixtureToken()), false, 'the token never reaches the snapshot');
    });
  });

  test('a Console key is never sent, from either side', async () => {
    const reasons = [];
    const report = (reason) => reasons.push(reason);

    // A Console key in the file and one from the host: nothing usable, no request.
    await withCredentials(credentials({ accessToken: 'sk-ant-api03-console-file' }), async () => {
      assert.equal(await fetchClaudeUsage('sk-ant-api03-console-host', noRequest, NOW, { report }), undefined);
      assert.equal(reasons.at(-1), 'missing-key');
    });

    // A Console key in the file does not shut the host's own token out.
    await withCredentials(credentials({ accessToken: 'sk-ant-api03-console-file' }), async () => {
      let seen;
      await fetchClaudeUsage(
        'host-oauth-key',
        async (_url, options) => {
          seen = options.headers.Authorization;
          return response();
        },
        NOW,
      );
      assert.equal(seen, 'Bearer host-oauth-key');
    });
  });

  test('a missing, unparsable or shapeless credentials file leaves no token, never a throw', async () => {
    for (const contents of [undefined, 'not json at all', {}, withoutBlock(), { claudeAiOauth: [] }, { claudeAiOauth: { accessToken: 42 } }]) {
      await withCredentials(contents, async (file) => {
        const reasons = [];
        assert.equal(
          await fetchClaudeUsage(undefined, noRequest, NOW, { report: (reason) => reasons.push(reason) }),
          undefined,
          `contents: ${JSON.stringify(contents)} (${file})`,
        );
        assert.deepEqual(reasons, ['missing-key']);
        assert.equal(
          await fetchClaudeUsage('', noRequest, NOW, { report: (reason) => reasons.push(reason) }),
          undefined,
          'an empty host key is no key either',
        );
        assert.deepEqual(reasons, ['missing-key', 'missing-key']);
      });
    }
  });

  test('an expired credential is not used, in either unit', async () => {
    // 13-digit milliseconds, one second in the past.
    const pastMs = credentials({ expiresAt: NOW - 1000 });
    // 10-digit seconds, one hour in the past: the older file layout.
    const pastSeconds = credentials({ expiresAt: Math.floor(NOW / 1000) - 3600 });
    // 10-digit seconds, one hour ahead.
    const futureSeconds = credentials({ expiresAt: Math.floor(NOW / 1000) + 3600 });

    for (const expired of [pastMs, pastSeconds]) {
      // Each variant is its own refresh wave; a real later wave carries a different instant.
      nextWave();
      // With a host key in reach the expired credential is simply skipped.
      await withCredentials(expired, async () => {
        let seen;
        await fetchClaudeUsage(
          'host-oauth-key',
          async (_url, options) => {
            seen = options.headers.Authorization;
            return response();
          },
          NOW,
        );
        assert.equal(seen, 'Bearer host-oauth-key');
      });
      // With nothing else it is reported as expired, which never clears the peak line.
      await withCredentials(expired, async () => {
        const reasons = [];
        assert.equal(await fetchClaudeUsage(undefined, noRequest, NOW, { report: (r) => reasons.push(r) }), undefined);
        assert.deepEqual(reasons, ['expired-token']);
      });
    }

    nextWave();
    await withCredentials(futureSeconds, async () => {
      let seen;
      await fetchClaudeUsage(
        'host-oauth-key',
        async (_url, options) => {
          seen = options.headers.Authorization;
          return response();
        },
        NOW,
      );
      assert.equal(seen, `Bearer ${fixtureToken()}`, 'a future second-precision expiry is honoured');
    });
  });

  test('a padded Console key is trimmed before the prefix is checked, and never sent', async () => {
    let calls = 0;
    const counted = async () => {
      calls++;
      return response();
    };

    // From the file: the padding must not hide the Console prefix.
    await withCredentials(credentials({ accessToken: '  sk-ant-api03-console  ' }), async (file) => {
      const before = fs.readFileSync(file, 'utf8');
      const reasons = [];
      assert.equal(await fetchClaudeUsage(undefined, counted, NOW, { report: (reason) => reasons.push(reason) }), undefined);
      assert.equal(calls, 0, 'a padded Console key from the file is never sent');
      assert.deepEqual(reasons, ['missing-key']);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'the credentials file is untouched');
    });

    // From the host, with no credentials block at all: same answer.
    await withCredentials(withoutBlock(), async (file) => {
      const before = fs.readFileSync(file, 'utf8');
      const reasons = [];
      const padded = '  sk-ant-api03-console  ';
      assert.equal(await fetchClaudeUsage(padded, counted, NOW, { report: (reason) => reasons.push(reason) }), undefined);
      assert.equal(calls, 0, 'a padded Console key from the host is never sent');
      assert.deepEqual(reasons, ['missing-key']);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
  });

  test('an expired credential repeated as the host key is not sent a second time', async () => {
    const document = credentials({ expiresAt: NOW - 1000 });
    const expired = document.claudeAiOauth.accessToken;
    await withCredentials(document, async (file) => {
      const before = fs.readFileSync(file, 'utf8');
      const reasons = [];
      let calls = 0;
      assert.equal(
        await fetchClaudeUsage(
          expired,
          async () => {
            calls++;
            return response();
          },
          NOW,
          { report: (reason) => reasons.push(reason) },
        ),
        undefined,
      );
      assert.equal(calls, 0, 'the same expired string is not a second chance');
      assert.deepEqual(reasons, ['expired-token']);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'the credentials file is untouched');

      // A genuinely different host key is still a candidate, and travels trimmed.
      let seen;
      assert.ok(
        await fetchClaudeUsage(
          '  host-oauth-key  ',
          async (_url, options) => {
            seen = options.headers.Authorization;
            return response();
          },
          NOW,
        ),
      );
      assert.equal(seen, 'Bearer host-oauth-key');
    });
  });

  test('a token without the user:profile scope is not sent, and the fallback still is', async () => {
    await withCredentials(credentials({ scopes: ['user:inference'] }), async (file) => {
      const before = fs.readFileSync(file, 'utf8');
      const reasons = [];
      let calls = 0;
      assert.equal(
        await fetchClaudeUsage(
          undefined,
          async () => {
            calls++;
            return response();
          },
          NOW,
          { report: (reason) => reasons.push(reason) },
        ),
        undefined,
      );
      assert.equal(calls, 0, 'a setup-token can only be refused by the route');
      assert.deepEqual(reasons, ['unusable-token']);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'the credentials file is untouched');

      // The verdict is "not this token", never "this provider is unusable".
      const verdicts = [];
      const source = createUsageSource('anthropic', { onReadiness: (verdict) => verdicts.push(verdict) });
      assert.equal(await source.fetch(undefined, async () => response(), NOW), undefined);
      assert.deepEqual(verdicts, ['unknown']);
      assert.equal(calls, 0);

      let seen;
      assert.ok(
        await fetchClaudeUsage(
          'host-oauth-key',
          async (_url, options) => {
            seen = options.headers.Authorization;
            return response();
          },
          NOW,
        ),
      );
      assert.equal(seen, 'Bearer host-oauth-key', 'a host key without the missing scope still serves');
    });
  });

  test('a credentials file with no scopes array, or an empty one, is still usable', async () => {
    for (const scopes of [undefined, [], ['user:profile'], ['user:inference', 'user:profile']]) {
      const document = credentials();
      if (scopes === undefined) delete document.claudeAiOauth.scopes;
      else document.claudeAiOauth.scopes = scopes;
      nextWave();
      await withCredentials(document, async () => {
        let seen;
        assert.ok(
          await fetchClaudeUsage(
            undefined,
            async (_url, options) => {
              seen = options.headers.Authorization;
              return response();
            },
            NOW,
          ),
          JSON.stringify(scopes),
        );
        assert.equal(seen, `Bearer ${fixtureToken()}`, JSON.stringify(scopes));
      });
    }
  });

  test('a padded OAuth token from the file is sent trimmed', async () => {
    await withCredentials(credentials({ accessToken: `  ${fixtureToken()}  ` }), async () => {
      let seen;
      assert.ok(
        await fetchClaudeUsage(
          undefined,
          async (_url, options) => {
            seen = options.headers.Authorization;
            return response();
          },
          NOW,
        ),
      );
      assert.equal(seen, `Bearer ${fixtureToken()}`);
    });
  });

  test('the credentials file is read, never written or refreshed', async () => {
    const document = credentials();
    await withCredentials(document, async (file) => {
      const before = fs.readFileSync(file, 'utf8');
      const stamp = fs.statSync(file).mtimeMs;
      assert.ok(await fetchClaudeUsage(undefined, async () => response(), NOW));
      nextWave();
      await fetchClaudeUsage(undefined, async () => response(undefined, { ok: false, status: 401 }), NOW);
      await fetchClaudeUsage(undefined, noRequest, NOW + 400 * 24 * 3600 * 1000);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.equal(fs.statSync(file).mtimeMs, stamp);
    });
  });
});

describe('the request', () => {
  test('one GET to the fixed route with exactly the documented headers', async () => {
    await withCredentials(credentials(), async () => {
      let calls = 0;
      const usage = await fetchClaudeUsage(
        undefined,
        async (url, options) => {
          calls++;
          assert.equal(url, USAGE_URL);
          const { signal, ...rest } = options;
          assert.ok(signal instanceof AbortSignal);
          assert.deepEqual(rest, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${fixtureToken()}`,
              // The beta flag opens the OAuth route; the User-Agent is what keeps it from
              // answering a persistent 429 (L5).
              'anthropic-beta': 'oauth-2025-04-20',
              'User-Agent': 'claude-code/2.0.55',
              Accept: 'application/json',
            },
            cache: 'no-store',
            redirect: 'error',
          });
          return response();
        },
        NOW,
      );
      assert.equal(calls, 1);
      assert.equal(usage?.provider, 'anthropic');
    });
  });

  test('a redirect is refused rather than followed', async () => {
    await withCredentials(credentials(), async () => {
      const reasons = [];
      const report = (reason) => reasons.push(reason);
      for (const flags of [{ redirected: true }, { url: 'https://other.example/api/oauth/usage' }]) {
        nextWave();
        assert.equal(await fetchClaudeUsage(undefined, async () => response(undefined, flags), NOW, { report }), undefined);
        assert.equal(reasons.at(-1), 'redirect');
      }
      // The un-redirected answer is still accepted, so the refusal is about the redirect.
      nextWave();
      assert.ok(await fetchClaudeUsage(undefined, async () => response(), NOW));
    });
  });

  test('a status that is not an HTTP code is reported as one fixed code', async () => {
    await withCredentials(credentials(), async () => {
      const token = fixtureToken();
      const reasons = [];
      const report = (reason) => reasons.push(reason);

      // A fetch adapter that answers an arbitrary string must not smuggle it into a reason code —
      // the reason reaches the debug console, so it has to stay a fixed token.
      assert.equal(
        await fetchClaudeUsage(undefined, async () => response(undefined, { ok: false, status: `Bearer ${token}` }), NOW, { report }),
        undefined,
      );
      assert.deepEqual(reasons, ['http-unknown']);
      assert.equal(reasons.join(' ').includes(token), false, 'no part of the token reaches the reason');
      assert.equal(reasons.join(' ').includes('Bearer'), false, 'no header value reaches the reason either');

      for (const status of [0, 99, 600, 429.5, undefined, null, '429']) {
        // Each attempt below is its own wave, so the account is not withheld by the claim above.
        nextWave();
        assert.equal(
          await fetchClaudeUsage(undefined, async () => response(undefined, { ok: false, status }), NOW, { report }),
          undefined,
        );
        assert.equal(reasons.at(-1), 'http-unknown', `status: ${JSON.stringify(status)}`);
      }

      // A real code is still named exactly, so the fixed code did not swallow the useful one.
      nextWave();
      assert.equal(
        await fetchClaudeUsage(undefined, async () => response(undefined, { ok: false, status: 429 }), NOW, { report }),
        undefined,
      );
      assert.equal(reasons.at(-1), 'http-429');
      assert.equal(reasons.length, 9);
    });
  });

  test('the request carries its own bounded window, and a hung response is a timeout', async () => {
    await withCredentials(credentials(), async () => {
      let seen;
      await fetchClaudeUsage(
        undefined,
        async (_url, options) => {
          seen = options.signal;
          return response();
        },
        NOW,
      );
      assert.ok(seen instanceof AbortSignal);
      assert.equal(REQUEST_TIMEOUT_MS, 10_000);

      // A new wave: the same account may answer again once the host refreshes again.
      nextWave();
      const reasons = [];
      const hung = (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      assert.equal(
        await fetchClaudeUsage(undefined, hung, NOW, { timeoutMs: 5, report: (reason) => reasons.push(reason) }),
        undefined,
      );
      assert.deepEqual(reasons, ['timeout']);
    });
  });

  test('failures resolve to no snapshot and report a fixed code, never the token', async () => {
    await withCredentials(credentials(), async () => {
      const reasons = [];
      const report = (reason) => reasons.push(reason);
      const token = fixtureToken();

      for (const [fetchFn, expected] of [
        [async () => response(undefined, { ok: false, status: 401 }), 'http-401'],
        [async () => response(undefined, { ok: false, status: 500 }), 'http-500'],
        [
          async () =>
            response(undefined, {
              json: async () => {
                throw new Error(`invalid JSON for ${token}`);
              },
            }),
          'invalid-json',
        ],
        [async () => response({}), 'unexpected-shape:five_hour'],
        [async () => response({ five_hour: payload().five_hour }), 'unexpected-shape:seven_day'],
        [async () => response([]), 'unexpected-shape'],
      ]) {
        nextWave();
        assert.equal(await fetchClaudeUsage(undefined, fetchFn, NOW, { report }), undefined, expected);
        assert.equal(reasons.at(-1), expected);
      }

      nextWave();
      assert.equal(
        await fetchClaudeUsage(
          undefined,
          async () => {
            throw new Error(`offline, token ${token}`);
          },
          NOW,
          { report },
        ),
        undefined,
      );
      assert.equal(reasons.at(-1), 'network');
      assert.equal(reasons.join(' ').includes(token), false, 'no reason code carries the token');
    });
  });

  test('a throwing diagnostics sink cannot break a successful refresh', async () => {
    await withCredentials(credentials(), async () => {
      const usage = await fetchClaudeUsage(undefined, async () => response(), NOW, {
        report: () => {
          throw new Error('sink');
        },
      });
      assert.equal(usage?.provider, 'anthropic');
    });
  });
});

describe('the source it registers', () => {
  const sourceFor = (providerId, onReadiness) => createUsageSource(providerId, { onReadiness });

  test('one source per served provider id, with exactly the four contract keys', () => {
    assert.deepEqual(PROVIDERS, ['anthropic', 'claude-bridge']);
    assert.equal(USAGE_SOURCE_SCHEMA, 'gentle-pi.usage-source/v1');
    // Both ids carry the product's own name, never the provider id the shell lists.
    assert.equal(PENDING_NOTE, 'claude · press r to fetch');

    for (const providerId of PROVIDERS) {
      const source = sourceFor(providerId);
      assert.deepEqual(Object.keys(source).sort(), ['fetch', 'pendingNote', 'provider', 'schema']);
      assert.equal(source.schema, USAGE_SOURCE_SCHEMA);
      assert.equal(source.provider, providerId);
      // A missing token must leave exactly this note behind, with the `·` the shell prints, and the
      // note says `claude` under both ids.
      assert.equal(source.pendingNote, 'claude · press r to fetch');
      assert.equal(typeof source.fetch, 'function');
    }
  });

  test('a provider id this source does not serve gets no source at all', () => {
    assert.equal(createUsageSource('openai'), undefined);
    assert.equal(createUsageSource(undefined), undefined);
  });

  test('one account answers once per wave, whoever asks first', async () => {
    // The host refreshes every provider in scope in one wave, with the same instant for each. The id
    // asked first wins; the second shows the host's own note instead of a copy of the numbers.
    await withCredentials(credentials(), async () => {
      for (const [questioner, other] of [
        ['anthropic', 'claude-bridge'],
        ['claude-bridge', 'anthropic'],
      ]) {
        nextWave();
        let calls = 0;
        const counted = async () => {
          calls++;
          return response();
        };
        const verdicts = [];
        const reasons = [];
        const first = await sourceFor(questioner, (verdict) => verdicts.push(verdict)).fetch(undefined, counted, NOW);
        const second = await sourceFor(other, (verdict) => verdicts.push(verdict)).fetch(undefined, counted, NOW, {
          report: (reason) => reasons.push(reason),
        });
        assert.equal(calls, 1, `${questioner} then ${other}: one request for the account`);
        assert.equal(first?.plan, 'max · peak 5hr', `${questioner} keeps the numbers`);
        assert.equal(second, undefined, other);
        assert.deepEqual(reasons, ['duplicate-account']);
        assert.deepEqual(verdicts, ['ready', 'unknown'], 'a duplicate never reads as unusable');
      }
    });
  });

  test('a later wave may be claimed by either id again', async () => {
    await withCredentials(credentials(), async () => {
      let calls = 0;
      const counted = async () => {
        calls++;
        return response();
      };
      assert.ok(await sourceFor('anthropic').fetch(undefined, counted, NOW));
      assert.equal(await sourceFor('claude-bridge').fetch(undefined, counted, NOW), undefined, 'same wave');
      assert.ok(await sourceFor('claude-bridge').fetch(undefined, counted, NOW + 1), 'the next wave answers');
      assert.equal(calls, 2, 'and it is a real request, not the old snapshot');
    });
  });

  test('a wave with no token claims nothing, so both ids report missing-key', async () => {
    await withoutCredentials(async () => {
      const verdicts = [];
      const reasons = [];
      for (const providerId of PROVIDERS) {
        const source = sourceFor(providerId, (verdict) => verdicts.push(verdict));
        assert.equal(
          await source.fetch(undefined, noRequest, NOW, { report: (reason) => reasons.push(reason) }),
          undefined,
          providerId,
        );
      }
      assert.deepEqual(reasons, ['missing-key', 'missing-key']);
      assert.deepEqual(verdicts, ['missing-key', 'missing-key']);

      // Nothing was claimed, so the same wave still answers once a token is in reach.
      let calls = 0;
      const answered = await fetchClaudeUsage(
        'recovered-token',
        async () => {
          calls++;
          return response();
        },
        NOW,
      );
      assert.ok(answered, 'a tokenless wave withheld nothing');
      assert.equal(calls, 1);
    });
  });

  test('two different accounts in one wave both answer', async () => {
    // No credentials block, so each id's own key is the account: two accounts, two snapshots.
    await withCredentials(withoutBlock(), async () => {
      let calls = 0;
      const counted = async () => {
        calls++;
        return response();
      };
      const first = await sourceFor('anthropic').fetch('account-one', counted, NOW);
      const second = await sourceFor('claude-bridge').fetch('account-two', counted, NOW);
      assert.ok(first);
      assert.ok(second);
      assert.equal(calls, 2);
      assert.deepEqual([first.provider, second.provider], ['anthropic', 'claude-bridge']);
    });
  });

  test('the plan is the tier when the file offered one, then the schedule', async () => {
    await withCredentials(credentials(), async () => {
      const source = sourceFor('anthropic');
      const tiered = await source.fetch(undefined, async () => response(), PEAK_INSTANT);
      assert.equal(tiered.plan, 'max · peak 5hr');
      assert.equal(tiered.plan, `max · ${formatPeakState(peakStateFor(providerById('claude'), PEAK_INSTANT), PEAK_INSTANT)}`);
      assert.equal(JSON.stringify(tiered).includes(fixtureToken()), false);
      // The window labels stay exactly as read: the schedule and the tier ride only on the
      // provider line and turn the shared name into the bridge's.
      assert.deepEqual(
        tiered.limits[0].windows.map((window) => window.label),
        ['5h', '7d'],
      );

      // A new wave, so the bridge's own answer is what this case measures.
      nextWave();
      const bridge = await sourceFor('claude-bridge').fetch(undefined, async () => response(), PEAK_INSTANT);
      assert.equal(bridge.provider, 'claude-bridge');
      assert.equal(bridge.plan, 'max · peak 5hr');
    });
  });

  test('the plan names both states, at two pinned instants', async () => {
    await withCredentials(credentials(), async () => {
      const source = sourceFor('anthropic');
      const engine = (now) => formatPeakState(peakStateFor(providerById('claude'), now), now);
      for (const [now, tiered] of [
        [PEAK_INSTANT, 'max · peak 5hr'],
        [OFF_PEAK_INSTANT, 'max · off-peak 1hr'],
      ]) {
        // Each wave is claimed once by this case, so every assertion measures the schedule.
        nextWave();
        assert.equal((await source.fetch(undefined, async () => response(), now)).plan, tiered, String(now));
        nextWave();
        assert.equal((await source.fetch(undefined, async () => response(), now)).plan, `max · ${engine(now)}`);
        nextWave();
        assert.match((await source.fetch(undefined, async () => response(), now)).plan, /^(max · )(peak|off-peak) /);
      }

      // Without a tier the schedule stands alone — no separator, no invented plan name.
      const document = credentials();
      delete document.claudeAiOauth.subscriptionType;
      await withCredentials(document, async () => {
        nextWave();
        assert.equal((await source.fetch(undefined, async () => response(), PEAK_INSTANT)).plan, 'peak 5hr');
        nextWave();
        assert.equal((await source.fetch(undefined, async () => response(), OFF_PEAK_INSTANT)).plan, 'off-peak 1hr');
      });
    });
  });

  test('the tier is normalized and never guessed', async () => {
    for (const [offered, expected] of [
      ['max', 'max · peak 5hr'],
      ['MAX', 'max · peak 5hr'],
      ['  Team  ', 'team · peak 5hr'],
      ['default_claude_max_20x', 'default_claude_max_20x · peak 5hr'],
      ['pro plan!', 'peak 5hr'],
      ['', 'peak 5hr'],
      ['a'.repeat(25), 'peak 5hr'],
      ['-max', 'peak 5hr'],
      [42, 'peak 5hr'],
    ]) {
      const document = credentials({ subscriptionType: offered });
      nextWave();
      await withCredentials(document, async () => {
        const usage = await sourceFor('anthropic').fetch(undefined, async () => response(), PEAK_INSTANT);
        assert.equal(usage.plan, expected, JSON.stringify(offered));
      });
    }
  });

  test('the tier travels only with the credentials token', async () => {
    // An expired credential hands the fetch to the host's key, and that key says nothing about the
    // subscription the account is on.
    await withCredentials(credentials({ expiresAt: NOW - 1000 }), async () => {
      const usage = await sourceFor('anthropic').fetch('host-oauth-key', async () => response(), PEAK_INSTANT);
      assert.equal(usage.plan, 'peak 5hr');
    });
    // And with no host key either, there is no snapshot to carry a plan.
    await withCredentials(credentials({ expiresAt: NOW - 1000 }), async () => {
      assert.equal(await sourceFor('anthropic').fetch(undefined, async () => response(), PEAK_INSTANT), undefined);
    });
  });

  test('readiness: ready when a snapshot came back, missing-key only without a token, unknown otherwise', async () => {
    await withCredentials(credentials(), async () => {
      const verdicts = [];
      const source = sourceFor('anthropic', (verdict) => verdicts.push(verdict));

      assert.ok(await source.fetch(undefined, async () => response(), NOW));
      assert.deepEqual(verdicts, ['ready']);

      const hung = (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      assert.equal(await source.fetch(undefined, hung, NOW, { timeoutMs: 5 }), undefined);
      assert.equal(verdicts.at(-1), 'unknown', 'timeout');

      nextWave();
      assert.equal(await source.fetch(undefined, async () => response(undefined, { ok: false, status: 500 }), NOW), undefined);
      assert.equal(verdicts.at(-1), 'unknown', 'http status');

      nextWave();
      assert.equal(await source.fetch(undefined, async () => response({}), NOW), undefined);
      assert.equal(verdicts.at(-1), 'unknown', 'malformed response');
      assert.equal(verdicts.includes('missing-key'), false, 'nothing above proves the token is missing');

      // An expired credential DID exist, so the provider is not reported unusable.
      await withCredentials(credentials({ expiresAt: NOW - 1000 }), async () => {
        assert.equal(await source.fetch(undefined, async () => response(), NOW), undefined);
        assert.equal(verdicts.at(-1), 'unknown', 'expired token');
      });

      await withoutCredentials(async () => {
        assert.equal(await source.fetch(undefined, noRequest, NOW), undefined);
        assert.equal(verdicts.at(-1), 'missing-key');
        assert.equal(await source.fetch('', noRequest, NOW), undefined);
        assert.equal(verdicts.at(-1), 'missing-key');
      });
      assert.equal(verdicts.length, 7);
    });
  });

  test('a throwing readiness sink cannot break a refresh', async () => {
    await withCredentials(credentials(), async () => {
      const source = sourceFor('anthropic', () => {
        throw new Error('ui gone');
      });
      assert.ok(await source.fetch(undefined, async () => response(), NOW));
      await withoutCredentials(async () => {
        assert.equal(await source.fetch(undefined, noRequest, NOW), undefined);
      });
    });
  });
});

describe('the extension wiring', () => {
  /** Load the extension with a capturing event sink, at a fresh shell API slot. */
  async function load() {
    const shellApi = defaultShellApi();
    globalThis[SHELL_SLOT] = shellApi.api;
    const emitted = [];
    const loaded = await loadExtension({
      events: { emit: (name, payload) => emitted.push({ name, payload }) },
    });
    return { emitted, hooks: loaded.hooks };
  }

  const claudeSources = (emitted) =>
    emitted
      .filter((entry) => entry.name === 'gentle-pi:usage-source/v1')
      .map((entry) => entry.payload)
      .filter((payload) => PROVIDERS.includes(payload.provider));

  const sessionStart = async (hooks) => {
    const ctx = { cwd: os.tmpdir(), hasUI: true, ui: { setWidget() {}, notify() {} } };
    for (const [name, hook] of hooks) if (name === 'session_start') await hook({}, ctx);
  };

  test('one emission per served provider id, at load and again at every session start', async () => {
    const { emitted, hooks } = await load();
    await withoutCredentials(async () => {
      const first = claudeSources(emitted);
      assert.deepEqual(
        first.map((payload) => payload.provider).sort(),
        ['anthropic', 'claude-bridge'],
        'exactly the two served ids',
      );
      for (const payload of first) {
        assert.deepEqual(Object.keys(payload).sort(), ['fetch', 'pendingNote', 'provider', 'schema']);
        assert.equal(payload.schema, 'gentle-pi.usage-source/v1');
        assert.equal(typeof payload.fetch, 'function');
      }
      // The OpenCode Go source this package already carried is still registered, and still once.
      const opencode = emitted.filter((entry) => entry.name === 'gentle-pi:usage-source/v1' && entry.payload.provider === 'opencode-go');
      assert.equal(opencode.length, 1);

      emitted.length = 0;
      await sessionStart(hooks);
      const second = claudeSources(emitted);
      assert.deepEqual(
        second.map((payload) => payload.provider).sort(),
        ['anthropic', 'claude-bridge'],
        're-registered at the session boundary',
      );
      assert.equal(new Set(second.map((payload) => payload.provider)).size, second.length, 'no id twice in one pass');
    });
  });
});

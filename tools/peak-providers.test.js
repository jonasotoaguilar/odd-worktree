'use strict';
// S5/S7 (opencode-usage-alert): the peak registry. Every provider whose window the `Alert`
// section can draw lives here, and this list in declaration order IS the row order — the
// extension walks it and draws one row per peaking provider, so a provider added to this array
// appears with no change to the wiring. The engine reads `zone`, `windows` and `weekdaysOnly`
// from the same entries, so the schedule and the rows can never disagree about a provider.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDERS, providerById, providerIds } = require('../lib/peak-providers.js');

describe('the peak registry', () => {
  test('the registry declares DeepSeek, then Claude, in that order', () => {
    assert.deepEqual(providerIds(), ['deepseek', 'claude']);
    assert.deepEqual(
      PROVIDERS.map((provider) => provider.id),
      ['deepseek', 'claude'],
    );
  });

  test('every entry carries the whole contract the wiring and the engine read', () => {
    assert.deepEqual(PROVIDERS[0], {
      id: 'deepseek',
      setting: 'Deepseek peak',
      label: '2× deepseek',
      zone: 'UTC',
      windows: [
        [1, 4],
        [6, 10],
      ],
      weekdaysOnly: true,
    });
    assert.deepEqual(PROVIDERS[1], {
      id: 'claude',
      setting: 'Claude peak',
      label: 'claude',
      zone: 'America/Los_Angeles',
      windows: [[5, 11]],
      weekdaysOnly: true,
    });
  });

  test('the two schedules: DeepSeek in UTC, Claude in the zone Anthropic publishes', () => {
    assert.equal(providerById('deepseek').zone, 'UTC');
    assert.deepEqual(providerById('deepseek').windows, [
      [1, 4],
      [6, 10],
    ]);
    // Anthropic publishes 05:00-11:00 Pacific on weekdays, so the UTC edges move with PDT/PST.
    assert.equal(providerById('claude').zone, 'America/Los_Angeles');
    assert.deepEqual(providerById('claude').windows, [[5, 11]]);
    assert.equal(providerById('claude').weekdaysOnly, true);
    assert.equal(providerById('deepseek').weekdaysOnly, true);
  });

  test('Claude carries no price multiplier: Anthropic publishes none for the window', () => {
    assert.equal(providerById('claude').label, 'claude');
    assert.equal(providerById('claude').label.includes('2×'), false);
    assert.equal(providerById('claude').label.includes('x'), false);
    // DeepSeek's `2×` is its published price multiplier and stays.
    assert.equal(providerById('deepseek').label, '2× deepseek');
  });

  test('the settings are the two Alert lines, in declaration order', () => {
    assert.deepEqual(
      PROVIDERS.map((provider) => provider.setting),
      ['Deepseek peak', 'Claude peak'],
    );
  });

  test('the registry is frozen and answers the declared objects themselves', () => {
    assert.equal(Object.isFrozen(PROVIDERS), true);
    for (const provider of PROVIDERS) {
      assert.equal(Object.isFrozen(provider), true, provider.id);
      assert.equal(Object.isFrozen(provider.windows), true, provider.id);
    }
    assert.equal(providerById('deepseek'), PROVIDERS[0]);
    assert.equal(providerById('claude'), PROVIDERS[1]);
  });

  test('providerById answers a declared id only', () => {
    for (const bad of [undefined, null, '', 'DeepSeek', 'anthropic', 'opencode-go', 0, 42, {}, ['claude']]) {
      assert.equal(providerById(bad), undefined, String(bad));
    }
  });

  test('providerIds is a fresh array: a caller cannot edit the registry through it', () => {
    const ids = providerIds();
    ids.push('third');
    ids.reverse();
    assert.deepEqual(providerIds(), ['deepseek', 'claude']);
  });

  test('every window is a well-formed half-open hour pair and every zone is a real zone', () => {
    for (const provider of PROVIDERS) {
      assert.equal(typeof provider.zone, 'string', provider.id);
      // A typo here would quietly move the whole window; Intl is the check that it resolves.
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: provider.zone }), provider.id);
      assert.equal(provider.windows.length > 0, true, provider.id);
      for (const window of provider.windows) {
        assert.equal(window.length, 2, provider.id);
        const [start, end] = window;
        assert.equal(Number.isInteger(start), true, provider.id);
        assert.equal(Number.isInteger(end), true, provider.id);
        assert.equal(start >= 0 && start < end && end <= 24, true, `${provider.id} ${start}-${end}`);
      }
    }
  });
});

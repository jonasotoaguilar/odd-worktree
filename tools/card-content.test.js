'use strict';
// The conversation card content level: the one reader every card of this package shares. The level is the process-wide slot
// Gentle Shell publishes; a host without it, or a slot that holds anything else, reads as `default` and never throws.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CARD_CONTENT, CARD_CONTENT_SLOT, cardContentLevel } = require('../lib/card-content.js');

test('the two levels are default and minimal', () => {
  assert.deepEqual(CARD_CONTENT, { DEFAULT: 'default', MINIMAL: 'minimal' });
  assert.equal(CARD_CONTENT_SLOT, Symbol.for('gentle-pi.card-content'));
});

test('the slot decides the level, and anything but minimal is default', () => {
  assert.equal(cardContentLevel({ [CARD_CONTENT_SLOT]: 'minimal' }), 'minimal');
  assert.equal(cardContentLevel({ [CARD_CONTENT_SLOT]: 'default' }), 'default');
  for (const junk of [undefined, null, '', 'MINIMAL', 1, {}, []]) {
    assert.equal(cardContentLevel({ [CARD_CONTENT_SLOT]: junk }), 'default');
  }
  assert.equal(cardContentLevel({}), 'default');
  assert.equal(cardContentLevel(undefined), 'default');
});

test('the level is read on every call, so a switch applies to the next paint', () => {
  const host = { [CARD_CONTENT_SLOT]: 'default' };
  assert.equal(cardContentLevel(host), 'default');
  host[CARD_CONTENT_SLOT] = 'minimal';
  assert.equal(cardContentLevel(host), 'minimal');
});

test('a hostile host never throws', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(cardContentLevel(hostile), 'default');
});

test('with no argument it reads the process-wide slot', () => {
  const before = globalThis[CARD_CONTENT_SLOT];
  try {
    globalThis[CARD_CONTENT_SLOT] = 'minimal';
    assert.equal(cardContentLevel(), 'minimal');
  } finally {
    if (before === undefined) delete globalThis[CARD_CONTENT_SLOT];
    else globalThis[CARD_CONTENT_SLOT] = before;
  }
});

'use strict';
// The conversation card content level, read by every card of this package.
//
// `default` draws a card with its bounded preview (at most three body rows collapsed); `minimal` draws it as one line, with
// no body at all until the card is expanded. The level is the user's choice in Gentle Shell, which publishes it on a
// process-wide slot because Pi loads every extension with its own module cache. Reading that slot is the whole inheritance
// this package can have: it needs no file of its own, a host without Gentle Shell leaves it unset, and the safe level then is
// `default` (never the whole output). It is read at paint time, so a level switched while the transcript is on screen applies
// to the next paint.

const CARD_CONTENT = Object.freeze({ DEFAULT: 'default', MINIMAL: 'minimal' });
const CARD_CONTENT_SLOT = Symbol.for('gentle-pi.card-content');

function cardContentLevel(host = globalThis) {
  try {
    const value = host === undefined || host === null ? undefined : host[CARD_CONTENT_SLOT];
    return value === CARD_CONTENT.MINIMAL ? CARD_CONTENT.MINIMAL : CARD_CONTENT.DEFAULT;
  } catch {
    return CARD_CONTENT.DEFAULT;
  }
}

module.exports = { CARD_CONTENT, CARD_CONTENT_SLOT, cardContentLevel };

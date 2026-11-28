'use strict';
// card-message (T1/S1): ONE `Card message` Off/On line on the shell API's own `Cards` page, and the
// reader both cards and the identity prompt ask.
//
// WHY A PLAIN ROW (D1). A message design is keyed on a custom message type and a tool design on a
// tool, and neither draws a user prompt or an assistant answer, so the switch cannot be a design:
// it is one `Off  On` line, exactly the shape `lib/modules.js` registers on its `Tools` page.
//
// ONE persisted document, through the shell API's own store: `odd-worktree` → `card-message` →
// `{ schema: 1, on: <boolean> }`, the store `lib/modules.js` writes its `modules` document to and
// that `lib/user-identity.js` writes `identity` to; no key of another document is touched. The
// switch is ON unless the stored document says exactly `on: false`, so a missing, malformed or
// unreadable document keeps the prompt card, the assistant card and the identity block as they
// are — the two cards are drawn today, so the first run is On and no transcript changes silently.
//
// READ LIVE, NEVER CACHED. Both cards ask `cardMessageOn()` inside their own paint, which is what
// makes a flip repaint the rows already on screen; the row's ACTION then asks the shell API for
// that repaint (`requestRepaint`, its optional member), so an already-drawn transcript does not
// wait for the next unrelated frame. A change applies at once, so there is no restart notice.
//
// Pure over the injected shell API and the published object the gate reads; nothing here touches
// the host.

const { shellApi } = require('./file-card-resolver.js');

const OWN_STORE = 'odd-worktree';
const CARD_MESSAGE_KEY = 'card-message';
const CARD_MESSAGE_SCHEMA = 1;
const CATEGORY = 'Cards';
const PROVIDER_ID = 'odd-worktree.cards';
// The row name the shell API validates (`lib/shell-api/row-names.ts`): two plain words.
const SETTING = 'Card message';
const VALUES = Object.freeze([
  Object.freeze({ value: 'Off', on: false }),
  Object.freeze({ value: 'On', on: true }),
]);

function storeOf(api) {
  if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return null;
  return api.createStore(OWN_STORE);
}

function storedDocument(store) {
  const stored = store.get(CARD_MESSAGE_KEY, undefined);
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/**
 * The stored switch, or `undefined` when this api cannot answer at all (no store, a store that
 * throws). Never throws. The two readers below hold the two DEFAULTs, which are not the same one:
 * a row reads On, and the gate that draws a card fails closed.
 */
function storedSwitch(api) {
  try {
    const store = storeOf(api);
    if (store === null) return undefined;
    return storedDocument(store).on !== false;
  } catch {
    return undefined;
  }
}

/** The row's read rule: On unless the stored document says exactly `false`. Never throws. */
function readCardMessage(api) {
  const stored = storedSwitch(api);
  return stored === undefined ? true : stored;
}

/**
 * Whether the message cards and the identity block are on right now, asked per paint and never
 * cached. FAIL-CLOSED: no published shell API means no card (native rows), because a card is a
 * frame nobody asked for when the switch cannot be read.
 */
function cardMessageOn() {
  const stored = storedSwitch(shellApi());
  return stored === undefined ? false : stored;
}

/** Persist the switch. True when it wrote, false for an api with no store. Never throws. */
function writeCardMessage(api, on) {
  try {
    const store = storeOf(api);
    if (store === null) return false;
    store.set(CARD_MESSAGE_KEY, { schema: CARD_MESSAGE_SCHEMA, on: on === true });
    return true;
  } catch {
    return false;
  }
}

/** The one repaint a flip asks for: the shell API's optional member, never its failure. */
function requestRepaint(api) {
  try {
    if (api !== null && typeof api === 'object' && typeof api.requestRepaint === 'function') api.requestRepaint();
  } catch {
    // A shell API that refuses its own repaint never fails the row.
  }
}

/**
 * The shell API provider for the `Cards` page: ONE setting, two consecutive rows sharing it, which
 * is what the shell API draws as one `Off  On` line. A press that changes nothing writes nothing and
 * asks no repaint, and a store that cannot write asks none either, so the repaint is never promised
 * for a change that was not kept.
 */
function cardMessageRowsProvider({ api }) {
  return {
    id: PROVIDER_ID,
    category: CATEGORY,
    rows() {
      return VALUES.map(({ value, on }) => ({
        category: CATEGORY,
        label: () => SETTING,
        choice: {
          setting: SETTING,
          value,
          current: () => readCardMessage(api) === on,
        },
        action: () => {
          if (readCardMessage(api) === on) return;
          if (!writeCardMessage(api, on)) return;
          requestRepaint(api);
        },
      }));
    },
  };
}

module.exports = {
  cardMessageOn,
  cardMessageRowsProvider,
};

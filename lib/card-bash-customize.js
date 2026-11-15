'use strict';
// S3: the bash card preference is a `/gentle:customize` row, not a command.
//
// The preference itself does not move: `lib/card-bash-mode.js` stays the reader
// the bash card asks on every paint and the ONLY writer of
// `<home>/card-bash.json`. What moves is its control surface. There is no
// `/card:bash` any more; instead this module contributes ONE row group through
// gentle-shell-bridge's published API:
//
//     /gentle:customize → Cards → Card tool: default | activity
//
// Two rows share the one `setting` (`Card tool`), so the host renders them as a
// single setting line with a `●` on the value in force and applies a selection
// with Enter (the bridge stages every provider row with `applyOnMove: false`,
// `src/rows.ts`). `activity` is this package's own card — `own` in the mode
// module's vocabulary — and it is what an absent document, an unreadable one and
// every malformed one all read, so it is the row the menu marks by default.
//
// The bridge is read, never imported: the caller passes the object it found at
// `Symbol.for("gentle-shell-bridge/api/v1")` after that package's own gate. With
// no usable object this module does nothing at all — no throw, no command, no
// second warning; the preference then has no control surface and the mode keeps
// its default.
//
// Each row's `current()` asks `cardBashMode()` (the live slot, then the document,
// then `own`) so the menu always marks the mode the card would draw with right
// now, and each row's `action` writes through `writeCardBashMode()`. That writer
// persists the strict document first and publishes the live slot second, so a
// click changes what the next paint reads AND what survives a restart, with one
// path — this module keeps no state of its own, no cache and no second file. A
// document this package cannot parse (a wrong schema, an unknown value, an extra
// key, invalid JSON) is never rewritten: the click simply leaves it alone, and the
// row keeps marking whatever the reader answers (own, the default).

const { CARD_BASH_MODE, cardBashMode, writeCardBashMode } = require('./card-bash-mode.js');

// The bridge's registration keys: the id is replaced in place on a repeated
// registration, so one process never ends up with two `Card tool` lines.
const CARD_BASH_CUSTOMIZE_PROVIDER_ID = 'odd-worktree-card-bash';
// The INTEGRATIONS name this plugin gets for its rows. The bridge honours it on
// the first registration only, and it obeys the row-name shape (one to three
// plain words).
const CARD_BASH_CUSTOMIZE_NAME = 'Odd worktree';
// The one preference this package owns lives on the host's Cards page.
const CARD_BASH_CUSTOMIZE_CATEGORY = 'Cards';
// The setting line, in the user's own words: `Card tool: default | activity`.
const CARD_BASH_CUSTOMIZE_SETTING = 'Card tool';

// The two rows, in the order the user named them (`default` | `activity`). The
// value is what the line reads and what the row is named; the mode is this
// package's own vocabulary.
const CARD_BASH_CUSTOMIZE_VALUES = [
  { value: CARD_BASH_MODE.DEFAULT, mode: CARD_BASH_MODE.DEFAULT },
  { value: 'activity', mode: CARD_BASH_MODE.OWN },
];

/** One value of the `Card tool` setting: its own `current()` and its own action. */
function choiceRow(entry, repaint) {
  return {
    category: CARD_BASH_CUSTOMIZE_CATEGORY,
    label: entry.value,
    choice: {
      setting: CARD_BASH_CUSTOMIZE_SETTING,
      value: entry.value,
      current: () => cardBashMode() === entry.mode,
    },
    // The writer the mode module already owns: document first, live slot second.
    // A refused write (a document this package cannot parse) changes nothing and
    // is never replaced, so the row stays where the file says it is.
    action: () => {
      const saved = writeCardBashMode(entry.mode);
      // A bash card already on screen reads the live slot on its next paint, and the
      // bridge's repaint request is what produces that paint: without it the click
      // changes the mode and leaves the transcript looking untouched.
      if (saved !== null && typeof saved === 'object' && saved.ok === true && repaint !== undefined) {
        try {
          repaint();
        } catch {
          // A host that cannot repaint still has the new mode in its slot and its file.
        }
      }
      return saved;
    },
  };
}

/** The rows one registration answers; `rows()` is evaluated on every menu build. */
function cardBashRows(repaint) {
  return CARD_BASH_CUSTOMIZE_VALUES.map((entry) => choiceRow(entry, repaint));
}

/** A bridge is usable when it can take a row provider; anything else is absent. */
function usableBridge(api) {
  return api !== null && typeof api === 'object' && typeof api.registerRows === 'function';
}

// The registration this process made, so a second call — the same extension load
// meeting both a published API and the ready announcement — is the same row
// group, never two. Module state, like the mode reader's slot: nothing is stored
// on disk.
let providerDisposer = null;

/**
 * Register the `Card tool` row group, at most once per process, and hand back the
 * disposer that removes it (or `null` when there is no usable bridge).
 *
 * Never throws: a bridge that refuses the provider is a host problem, and the
 * caller keeps every other surface working. The returned disposer is idempotent —
 * a second call does nothing — and clearing the module's handle means a later
 * registration is possible again, which is what a host that republishes its API
 * needs.
 */
function registerCardBashCustomize(api) {
  if (!usableBridge(api)) return null;
  if (providerDisposer !== null) return providerDisposer;

  let registered;
  try {
    // The bridge's own repaint request, when it publishes one: that is the paint the
    // already-drawn bash rows need after the mode changed.
    const repaint = typeof api.requestRepaint === 'function' ? () => api.requestRepaint() : undefined;
    registered = api.registerRows({
      id: CARD_BASH_CUSTOMIZE_PROVIDER_ID,
      name: CARD_BASH_CUSTOMIZE_NAME,
      category: CARD_BASH_CUSTOMIZE_CATEGORY,
      rows: () => cardBashRows(repaint),
    });
  } catch {
    return null;
  }
  const dispose = typeof registered === 'function' ? registered : () => {};
  let disposed = false;
  providerDisposer = () => {
    if (disposed) return;
    disposed = true;
    providerDisposer = null;
    try {
      dispose();
    } catch {
      // A failed removal leaves the row group on the menu; it never breaks the host.
    }
  };
  return providerDisposer;
}

module.exports = {
  CARD_BASH_CUSTOMIZE_CATEGORY,
  CARD_BASH_CUSTOMIZE_NAME,
  CARD_BASH_CUSTOMIZE_PROVIDER_ID,
  CARD_BASH_CUSTOMIZE_SETTING,
  registerCardBashCustomize,
};

'use strict';
// The module switches (modular-tools): which of this package's two optional halves a
// user wants. `Codegraph+` is everything CodeGraph (the prompt text, the two reminders
// and the session wiring); `Worktrees+` is everything worktree (the prompt text, the
// two tools, `/warp` and the guards). Everything else — issues, cards, `/odd`,
// `/files`, the skill-read guard — is transversal and has no switch here.
//
// One persisted document, through the shell API's own store: `odd-worktree` →
// `modules` → `{ codegraph?: boolean, worktrees?: boolean }`. A module is ON unless its
// stored value is exactly `false`, so a missing, malformed or unreadable document keeps
// the package whole. The extension reads it ONCE, when it registers: a change made on
// the `Tools` page lands on the next load, which is why a change says so.
//
// The rows are a plain shell API provider (`registerRows`): two consecutive rows sharing
// one `choice.setting` make one `Off  On` line. Pure over the injected shell API and
// notifier; nothing here touches the host.

const OWN_STORE = 'odd-worktree';
const MODULES_KEY = 'modules';
const CATEGORY = 'Tools';
const PROVIDER_ID = 'odd-worktree.tools';

// The two switches, in the order the page lists them. `setting` is the row name the shell API
// validates (one to three plain words, no structural mark: `+` is allowed).
const MODULES = Object.freeze([
  Object.freeze({ key: 'codegraph', setting: 'Codegraph+' }),
  Object.freeze({ key: 'worktrees', setting: 'Worktrees+' }),
]);
const VALUES = Object.freeze([
  Object.freeze({ value: 'Off', on: false }),
  Object.freeze({ value: 'On', on: true }),
]);

function storeOf(api) {
  if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return null;
  return api.createStore(OWN_STORE);
}

function storedDocument(store) {
  const stored = store.get(MODULES_KEY, undefined);
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** `{ codegraph, worktrees }`: ON unless the stored value is exactly `false`. Never throws. */
function readModules(api) {
  const state = {};
  let stored = {};
  try {
    const store = storeOf(api);
    if (store !== null) stored = storedDocument(store);
  } catch {
    stored = {};
  }
  for (const { key } of MODULES) state[key] = stored[key] !== false;
  return state;
}

/** Persist one switch, keeping the other module and every other key. True when it wrote. Never throws. */
function writeModule(api, key, on) {
  try {
    if (!MODULES.some((module) => module.key === key)) return false;
    const store = storeOf(api);
    if (store === null) return false;
    store.set(MODULES_KEY, { ...storedDocument(store), [key]: on === true });
    return true;
  } catch {
    return false;
  }
}

/** The one short line a change says: it lands on the next load, in a NEW session. */
function restartNotice(setting, value) {
  return `${setting} ${value} · run /reload and start a new session to apply`;
}

/**
 * The shell API provider for the `Tools` page. `notify(text)` carries the restart notice to
 * the session's UI; a change to the value a module already has writes nothing and says
 * nothing, and a store that cannot write says nothing either, so the notice is never
 * promised for a change that was not kept.
 */
function moduleRowsProvider({ api, notify }) {
  const say = (text) => {
    try {
      if (typeof notify === 'function') notify(text);
    } catch {
      // A dead UI never fails the row.
    }
  };
  return {
    id: PROVIDER_ID,
    category: CATEGORY,
    // The `Tools` page sits right after the host's `Sections` page and before `Keymaps`. The shell API
    // derives its page list from the order of the rows once, while it builds the menu, so this has to
    // be the provider's request: a page appended without it lands last, after `Profiles`. A shell API
    // that predates `categoryPlacement` ignores the field and the page opens at the end again.
    categoryPlacement: { after: 'Sections' },
    rows() {
      const rows = [];
      for (const { key, setting } of MODULES) {
        for (const { value, on } of VALUES) {
          rows.push({
            category: CATEGORY,
            label: () => setting,
            choice: {
              setting,
              value,
              current: () => readModules(api)[key] === on,
            },
            action: () => {
              if (readModules(api)[key] === on) return;
              if (writeModule(api, key, on)) say(restartNotice(setting, value));
            },
          });
        }
      }
      return rows;
    },
  };
}

module.exports = {
  MODULES,
  CATEGORY,
  PROVIDER_ID,
  readModules,
  writeModule,
  restartNotice,
  moduleRowsProvider,
};

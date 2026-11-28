'use strict';
// The module switches (modular-tools): which of this package's optional halves a user
// wants. `Codegraph+` is everything CodeGraph (the prompt text, the two reminders and the
// session wiring); `Worktrees+` is everything worktree (the prompt text, the two tools,
// `/warp` and the worktree guards, the active-session guard included); `Skills+` is the
// two skill-read rules (the bash reader refusal and the whole-read rewrite of a skill's
// or an ODD's Markdown). Everything else — issues, cards, `/odd`, `/files` — is
// transversal and has no switch here.
//
// One persisted document, through the bridge's own store: `odd-worktree` →
// `modules` → `{ codegraph?: boolean, worktrees?: boolean, skills?: boolean }`. A module
// is ON unless its stored value is exactly `false` — except `Skills+`, which is OFF until
// its stored value is exactly `true`: the read rules are opt-in, so a missing, malformed
// or unreadable document turns them off like an unset switch does. The extension reads it
// ONCE, when it registers: a change made on the `Tools` page lands on the next load, which
// is why a change says so.
//
// The rows are a plain bridge provider (`registerRows`): two consecutive rows sharing
// one `choice.setting` make one `Off  On` line. Pure over the injected bridge and
// notifier; nothing here touches the host.

const OWN_STORE = 'odd-worktree';
const MODULES_KEY = 'modules';
const CATEGORY = 'Tools';
const PROVIDER_ID = 'odd-worktree.tools';

// The switches, in the order the page lists them. `setting` is the row name the bridge
// validates (one to three plain words, no structural mark: `+` is allowed). `defaultOn:
// false` is the ONE opt-in switch: every other module is on until someone turns it off.
const MODULES = Object.freeze([
  Object.freeze({ key: 'codegraph', setting: 'Codegraph+' }),
  Object.freeze({ key: 'worktrees', setting: 'Worktrees+' }),
  Object.freeze({ key: 'skills', setting: 'Skills+', defaultOn: false }),
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

/**
 * `{ codegraph, worktrees, skills }`: ON unless the stored value is exactly `false`, and
 * `Skills+` OFF unless it is exactly `true`. Never throws.
 */
function readModules(api) {
  const state = {};
  let stored = {};
  try {
    const store = storeOf(api);
    if (store !== null) stored = storedDocument(store);
  } catch {
    stored = {};
  }
  for (const module of MODULES) {
    state[module.key] = module.defaultOn === false ? stored[module.key] === true : stored[module.key] !== false;
  }
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
 * The bridge provider for the `Tools` page. `notify(text)` carries the restart notice to
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
    // The `Tools` page sits right after the host's `Sections` page and before `Keymaps`. The bridge
    // derives its page list from the order of the rows once, while it builds the menu, so this has to
    // be the provider's request: a page appended without it lands last, after `Profiles`. A bridge
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

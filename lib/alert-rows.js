'use strict';
// The `Alert` page of `/gentle:customize` (S3, S5, S7) and its switches (S4, S8): one
// Off/On pair PER provider the peak registry declares, in the registry's declaration order,
// each under its own setting label (`Deepseek peak`, then `Claude peak`), all Off by
// default. The page sits immediately after `Notifications` and before `Layout`, so it is the
// `Alert` category every menu that lists both host pages shows between them.
//
// The page is built from `lib/peak-providers.js`, so a provider added to the registry gets
// its pair here with no change to this file or to the extension.
//
// Unlike the module switches, these are applied to the RUNNING session: the extension
// re-arms the peak rows from the stored booleans, so a change calls `onChange()` right after
// the write and nothing here says "restart" or "/reload". A store that refuses the write
// THROWS instead of returning quietly — the customize menu's own busy guard reports a row's
// error, and a switch that silently keeps the old value while the peak row keeps drawing is
// exactly the disagreement `lib/alert-mode.js` exists to prevent.
//
// The rows are a plain shell API provider (`registerRows`): two consecutive rows sharing one
// `choice.setting` make one `Off  On` line. Pure over the injected shell API and callbacks;
// nothing here touches the host.

const { readPeakAlert, writePeakAlert } = require('./alert-mode.js');
const { PROVIDERS } = require('./peak-providers.js');

const CATEGORY = 'Alert';
const PROVIDER_ID = 'odd-worktree.alert.peak';

const VALUES = Object.freeze([
  Object.freeze({ value: 'Off', on: false }),
  Object.freeze({ value: 'On', on: true }),
]);

/**
 * The shell API provider for the `Alert` page. The `notify` the extension also hands this
 * factory stays unused on purpose: the change is applied to the running session, so there
 * is no restart to announce and this page prints nothing. A refused write throws and
 * `onChange()` is never called for it, so the running session is only told about a change
 * that was actually kept.
 */
function alertRowsProvider({ api, onChange } = {}) {
  return {
    id: PROVIDER_ID,
    category: CATEGORY,
    // The `Alert` page opens right after the host's `Notifications` page and before `Layout`.
    // The shell API derives its page list from the order of the rows once, while it builds the
    // menu, so this has to be the provider's request; a shell API that predates
    // `categoryPlacement` ignores the field and the page opens at the end instead.
    categoryPlacement: { after: 'Notifications' },
    rows() {
      const rows = [];
      for (const provider of PROVIDERS) {
        for (const { value, on } of VALUES) {
          rows.push({
            category: CATEGORY,
            label: () => provider.setting,
            choice: {
              setting: provider.setting,
              value,
              current: () => readPeakAlert(api, provider.id) === on,
            },
            action: () => {
              if (!writePeakAlert(api, provider.id, on)) {
                // The menu reports the throw; nothing was stored, so nothing is applied.
                throw new Error(`${provider.setting} could not be saved`);
              }
              // Applied in the session that is running: the rows the user just switched
              // appear or disappear without a `/reload`.
              if (typeof onChange === 'function') onChange();
            },
          });
        }
      }
      return rows;
    },
  };
}

module.exports = {
  CATEGORY,
  PROVIDER_ID,
  alertRowsProvider,
};

'use strict';
// The `Alert` page of `/gentle:customize` (S3) and its one switch (S4): `Deepseek peak`,
// Off/On, On by default. The page sits immediately after `Notifications` and before
// `Layout`, so it is the `Alert` category every menu that lists both host pages shows
// between them.
//
// Unlike the module switches, this one is applied to the RUNNING session: the extension
// re-arms the S2 peak line from the stored boolean, so a change calls `onChange()` right
// after the write and nothing here says "restart" or "/reload". A store that refuses the
// write THROWS instead of returning quietly — the customize menu's own busy guard reports
// a row's error, and a switch that silently keeps the old value while the widget keeps
// drawing is exactly the disagreement `lib/alert-mode.js` exists to prevent.
//
// The rows are a plain bridge provider (`registerRows`): two consecutive rows sharing one
// `choice.setting` make one `Off  On` line. Pure over the injected bridge and callbacks;
// nothing here touches the host.

const { readDeepseekPeak, writeDeepseekPeak } = require('./alert-mode.js');

const CATEGORY = 'Alert';
const PROVIDER_ID = 'odd-worktree.alert.peak';
const SETTING = 'Deepseek peak';

const VALUES = Object.freeze([
  Object.freeze({ value: 'Off', on: false }),
  Object.freeze({ value: 'On', on: true }),
]);

/**
 * The bridge provider for the `Alert` page. The `notify` the extension also hands this
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
    // The bridge derives its page list from the order of the rows once, while it builds the
    // menu, so this has to be the provider's request; a bridge that predates
    // `categoryPlacement` ignores the field and the page opens at the end instead.
    categoryPlacement: { after: 'Notifications' },
    rows() {
      const rows = [];
      for (const { value, on } of VALUES) {
        rows.push({
          category: CATEGORY,
          label: () => SETTING,
          choice: {
            setting: SETTING,
            value,
            current: () => readDeepseekPeak(api) === on,
          },
          action: () => {
            if (!writeDeepseekPeak(api, on)) {
              // The menu reports the throw; nothing was stored, so nothing is applied.
              throw new Error(`${SETTING} could not be saved`);
            }
            // Applied in the session that is running: the line the user just switched
            // appears or disappears without a `/reload`.
            if (typeof onChange === 'function') onChange();
          },
        });
      }
      return rows;
    },
  };
}

module.exports = {
  CATEGORY,
  PROVIDER_ID,
  SETTING,
  alertRowsProvider,
};

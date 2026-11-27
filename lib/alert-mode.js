'use strict';
// The DeepSeek peak alert's ONE switch (S4): the boolean `/gentle:customize` → `Alert` →
// `Deepseek peak` writes, and the one the S2 line above the input panel reads. Storing it
// once is what keeps the switch and the line from ever disagreeing.
//
// One persisted document, through the bridge's own store: `odd-worktree` → `alerts` →
// `{ deepseekPeak?: boolean }`. It is On unless its stored value is exactly `false`, so a
// first run, a malformed document, an unreadable store or a host with no bridge at all
// keeps the alert on — and the default is NEVER written eagerly: a user who never touches
// the switch leaves no document behind at all.
//
// Pure over the injected bridge; nothing here touches the host.

const OWN_STORE = 'odd-worktree';
const ALERTS_KEY = 'alerts';

const DEFAULT_DEEPSEEK_PEAK = true;

function storeOf(api) {
  if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return null;
  return api.createStore(OWN_STORE);
}

function storedDocument(store) {
  const stored = store.get(ALERTS_KEY, undefined);
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** The stored switch: On unless the stored value is exactly `false`. Never throws. */
function readDeepseekPeak(api) {
  try {
    const store = storeOf(api);
    if (store === null) return DEFAULT_DEEPSEEK_PEAK;
    return storedDocument(store).deepseekPeak !== false;
  } catch {
    return DEFAULT_DEEPSEEK_PEAK;
  }
}

/** Persist the switch, keeping every other key of the document and of the store. True when it wrote. */
function writeDeepseekPeak(api, on) {
  try {
    const store = storeOf(api);
    if (store === null) return false;
    store.set(ALERTS_KEY, { ...storedDocument(store), deepseekPeak: on === true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_DEEPSEEK_PEAK,
  ALERTS_KEY,
  readDeepseekPeak,
  writeDeepseekPeak,
};

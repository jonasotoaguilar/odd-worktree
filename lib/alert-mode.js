'use strict';
// The peak alerts' switches (S5, S8): ONE stored boolean PER provider, Off by default. The
// booleans `/gentle:customize` → `Alert` → `Deepseek peak` / `Claude peak` write are the
// same booleans the peak rows above the input read, which is what keeps a switch and the
// row it governs from ever disagreeing.
//
// One persisted document, through the shell API's own store: `odd-worktree` → `alerts` →
// `{ peaks: { [providerId]: boolean } }`. A provider is On only when its own entry is
// exactly `true`, so a first run, an absent or malformed document, an id that was never
// written, an unreadable store or a host with no shell API all answer Off — and the default is
// NEVER written eagerly: a user who never touches a switch leaves no document behind at all.
//
// Writes are keyed by provider id, so flipping one provider keeps every sibling id of the
// document (and every sibling key of the store) exactly as it was.
//
// Pure over the injected shell API; nothing here touches the host or reads a clock.

const OWN_STORE = 'odd-worktree';
const ALERTS_KEY = 'alerts';

const DEFAULT_PEAK = false;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storeOf(api) {
  if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return null;
  return api.createStore(OWN_STORE);
}

function storedDocument(store) {
  const stored = store.get(ALERTS_KEY, undefined);
  return isRecord(stored) ? stored : {};
}

/** The stored `peaks` map, or an empty one when the document does not carry a usable map. */
function storedPeaks(store) {
  const peaks = storedDocument(store).peaks;
  return isRecord(peaks) ? peaks : {};
}

/**
 * One provider's switch: On only when its own entry is exactly `true`. An absent document, a
 * malformed one, an unwritten id, a missing store and a throwing store all answer Off and
 * never throw.
 */
function readPeakAlert(api, id) {
  try {
    if (typeof id !== 'string' || id === '') return DEFAULT_PEAK;
    const store = storeOf(api);
    if (store === null) return DEFAULT_PEAK;
    return storedPeaks(store)[id] === true;
  } catch {
    return DEFAULT_PEAK;
  }
}

/**
 * Persist one provider's switch, keeping every sibling id of the `peaks` map and every
 * sibling key of the `alerts` document and of the store. True when it wrote.
 */
function writePeakAlert(api, id, on) {
  try {
    if (typeof id !== 'string' || id === '') return false;
    const store = storeOf(api);
    if (store === null) return false;
    const document = storedDocument(store);
    const peaks = isRecord(document.peaks) ? document.peaks : {};
    store.set(ALERTS_KEY, { ...document, peaks: { ...peaks, [id]: on === true } });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_PEAK,
  ALERTS_KEY,
  readPeakAlert,
  writePeakAlert,
};

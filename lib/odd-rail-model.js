'use strict';
// The ODD rows the rail section draws, chosen from the grouped model
// (odd-rail-section, T4: S9, S12, S13 and Option A of S4/S5).
//
// ONE row per ODD NAME, never one per checkout (S12): the ODDs in main and in a
// worktree are the same entry, and the row's `checkoutName` says which copy is on
// offer. The copy is the MOST RECENT document (Option A, the user's decision) —
// `main` is a group label and the exact-tie breaker, never an override (S4/S5) —
// and between two worktrees at the same instant the FIRST group in order keeps it,
// so the answer never depends on how a caller happened to sort its own groups.
//
// Order (S9): the names the session touched come first, by the touch's own `at`,
// most recent first; everything else follows by `mtimeMs` descending and then by
// name in CODE UNITS (never `localeCompare`, so every host and every run agree).
//
// Scope (odd-rail-session-scope S2): the rail draws the ODDs the SESSION is
// associated with, never every document on disk. The association is a set of ODD
// NAMES (`associated`) the caller rebuilt from the session's active branch and from
// the live touch record; the live touches are unioned in here, so a document the
// session just wrote shows even before history names it. A name outside that union
// is never drawn, however new its copy is, and an empty association draws nothing at
// all: the rail's empty body is the section's own dim row, not a row this module may
// invent. Within the association the election and the order are exactly as before.
// A touched name no group lists produces nothing at all.
//
// Scope (S13): the caller hands the groups of the SESSION's registered worktrees,
// main always whole. A worktree group with `docs: []` contributes nothing here as
// well, so a registered worktree with no delta never draws a row of its own.
//
// Pure and total: no fs, no git, no clock, no mutation of its input. `groups` is
// what `groupOddDocs` returns and `touched` is `oddSession.touched()`; a malformed
// group, document or touch is SKIPPED, never thrown on.

// A document whose scan could not read a time is the oldest possible copy, and it
// reports `mtimeMs: 0` rather than a time it never had.
const NO_TIME = -Infinity;

// Code-unit comparison, spelled out: `localeCompare` orders by the machine's
// language, which would make the rail's sequence depend on the host.
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function textOf(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

// One group's candidate rows, in the group's own order. Nothing is elected here:
// the caller compares every candidate with the one already held for its name.
function candidatesOf(group) {
  const out = [];
  if (!group || typeof group !== 'object') return out;
  const docs = Array.isArray(group.docs) ? group.docs : [];
  if (docs.length === 0) return out;
  const checkoutName = textOf(group.checkoutName, '');
  const checkoutRoot = textOf(group.checkoutRoot, '');
  const isMain = group.isMain === true;
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const name = textOf(doc.name, '');
    // A row without a name cannot be drawn and a row without a document cannot be
    // opened, so neither is a candidate.
    if (name.length === 0) continue;
    const docPath = textOf(doc.docPath, '');
    if (docPath.length === 0) continue;
    const raw = Number(doc.mtimeMs);
    out.push({
      row: {
        name,
        docPath,
        checkoutRoot,
        checkoutName,
        mtimeMs: Number.isFinite(raw) ? raw : 0,
      },
      // The instant the election compares on: a copy with no readable time is the
      // oldest one there is.
      at: Number.isFinite(raw) ? raw : NO_TIME,
      isMain,
    });
  }
  return out;
}

// Option A with its two tie rules: the newest copy wins, `main` breaks an exact
// tie, and between two worktrees the copy already held (the earlier group) stays.
function elect(current, candidate) {
  if (current === undefined) return candidate;
  if (candidate.at > current.at) return candidate;
  if (candidate.at < current.at) return current;
  if (current.isMain) return current;
  if (candidate.isMain) return candidate;
  return current;
}

// The touched names, with the instant and the position the ordering uses. A name
// touched twice (the same document spelled two ways) keeps the most recent instant
// and the earliest position, so it is ordered once.
function touchedOrderOf(touched) {
  const order = new Map();
  if (!Array.isArray(touched)) return order;
  for (let index = 0; index < touched.length; index += 1) {
    const touch = touched[index];
    if (!touch || typeof touch !== 'object') continue;
    const name = textOf(touch.name, '');
    const at = Number(touch.at);
    if (name.length === 0 || !Number.isFinite(at)) continue;
    const seen = order.get(name);
    if (seen === undefined) {
      order.set(name, { at, index });
      continue;
    }
    if (at > seen.at) seen.at = at;
  }
  return order;
}

// The associated NAMES, accepting the Set the wiring hands over and a plain array
// (a test or a sibling caller). Anything else is no association at all: the rail
// never guesses that "not told" means "everything on disk" (S2).
function associatedNamesOf(associated) {
  const out = new Set();
  const source = associated instanceof Set ? associated : (Array.isArray(associated) ? associated : []);
  for (const name of source) {
    if (typeof name === 'string' && name.length > 0) out.add(name);
  }
  return out;
}

/**
 * The rail's rows: one per associated ODD name, ordered attribution-first, then by
 * recency, then by name.
 *
 * @param {{ groups?: Array<object>, touched?: Array<object>, associated?: Set<string>|string[] }} input
 * @returns {Array<{ name: string, docPath: string, checkoutRoot: string, checkoutName: string, mtimeMs: number }>}
 */
function railRows(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const groups = Array.isArray(opts.groups) ? opts.groups : [];
  // S2: the union of what history associates and what this session touched live. A
  // touch is evidence of association, never a row of its own (it must still be a
  // document a group lists).
  const associated = associatedNamesOf(opts.associated);
  const touched = touchedOrderOf(opts.touched);
  const elected = new Map();
  // Groups are visited in the order the caller gave them, which is what decides an
  // exact tie between two worktrees.
  for (const group of groups) {
    for (const candidate of candidatesOf(group)) {
      const name = candidate.row.name;
      if (!associated.has(name) && !touched.has(name)) continue;
      elected.set(name, elect(elected.get(name), candidate));
    }
  }
  if (elected.size === 0) return [];
  const rows = [];
  for (const [name, candidate] of elected) {
    rows.push({ name, candidate, touch: touched.get(name) });
  }
  rows.sort((left, right) => {
    const leftTouched = left.touch !== undefined;
    const rightTouched = right.touch !== undefined;
    // S9: the attributed names come first, and only they order by their touch.
    if (leftTouched !== rightTouched) return leftTouched ? -1 : 1;
    if (leftTouched && rightTouched) {
      if (left.touch.at !== right.touch.at) return right.touch.at - left.touch.at;
      if (left.touch.index !== right.touch.index) return left.touch.index - right.touch.index;
    } else {
      if (left.candidate.at !== right.candidate.at) return right.candidate.at - left.candidate.at;
    }
    return compareText(left.name, right.name);
  });
  return rows.map((entry) => ({ ...entry.candidate.row }));
}

module.exports = { railRows };

'use strict';
// The ONE ODD listing both surfaces draw (odd-rail-section T14, the redesign L11
// landed after five failed verification rounds).
//
// The ODD panel's list and the bare `/odd` degraded select menu each derived their
// own labels and their own order, and every round found the same class of defect on
// both: two registered worktrees sharing a basename drew the same label and each
// click opened the first path (L11), a document literally named like a generated
// label collided with it, and the menu's order drifted from the panel's, so picking
// its first entry opened a different file than the panel's first row. This module
// removes the second derivation: `buildListing` answers ONE value — the panel draws
// its groups and entries from it and the menu IS its `menu`, flattened from the same
// entries in the same order — so labels and order can never diverge again, and no
// two labels can collide. No consumer sorts or labels anything of its own.
//
// Identity is the RESOLVED ABSOLUTE PATH, never a name: two entries are the same
// document exactly when their resolved paths are equal (a trailing separator, or a
// `.` segment, is the same path), and a duplicate is emitted ONCE, in the first
// group that held it, carrying that first occurrence's own name and time.
//
// Labels, in order of preference. A name that appears ONCE stays exactly that name
// — no suffix, no decoration — so the baseline's plain text survives. A name that
// appears more than once is labelled `<name> (<checkoutName>)`. Two checkouts that
// share a `checkoutName` (two worktrees with the same basename) are told apart by
// the SHORTEST distinguishing trailing path segments of their ROOT, so
// `<name> (a/proj-x)` and `<name> (b/proj-x)`; the depth is grown per checkout and
// only for the roots that still end alike, so one more segment is spent exactly
// where it is needed (`x/p/proj-x` against `y/p/proj-x`), and a root that runs out
// of segments is named by its absolute path. Literal names are reserved FIRST, so a
// document actually named `x (main)` keeps that exact text and the generated label
// that would have hit it takes ` #2`, then ` #3`, assigned in panel order. A last
// pass asserts the whole listing's labels are unique and falls back to the absolute
// path of any label that somehow is not: uniqueness is a property of the value, not
// a promise about the inputs.
//
// Order is ONE comparator, `compareEntries`, exported for any consumer that needs
// it: `mtimeMs` DESCENDING, then `name` ascending, then the CHECKOUT that holds the
// copy, then `path` — the rule lib/odd-docs.js's `orderDocs` and lib/odd-group.js's
// `compareDocs` already apply, spelled in code units (never `localeCompare`, so every
// host and every run agree). The panel draws its rows in exactly that order over the
// WHOLE listing, newest document first (odd-dedupe S6), and every entry carries the
// checkout it was listed from (`checkout`) so a row can say where its copy lives.
// The menu is the panel's order flattened group by group: main's group first, then
// each remaining group in the order given, each group's entries already in
// comparator order — so the menu's first entry is always the panel's first row.
//
// A caller may ALSO hand this module the order it already has (T16, L11): an entry
// carrying a finite `order` uses it as the PRIMARY sort key, ascending. That is
// what keeps 53ae2b2's degraded-menu sequence — main's documents in the order
// lib/odd-docs.js ranks them (commit recency, then name), which is NOT their mtime
// order in a fresh clone or in two documents of the same commit — so the listing
// preserves a rank instead of re-deriving one (it never runs git itself).
// `compareEntries` stays the TIE-BREAK among entries of equal `order` and the whole
// rule for entries that carry none, which sort after the ordered ones: a caller
// that gives nothing keeps the comparator's order exactly.
//
// Fail closed on junk: a malformed group or entry is skipped, never thrown on; a
// document whose time cannot be read is the OLDEST (`mtimeMs: 0`) and still
// appears; and an EMPTY group vanishes from the result — no entries, no group — so a
// registered worktree with no delta never draws an empty section (S10/S13).
//
// Pure and total: no fs, no git, no clock, no state between calls, no mutation of
// the input. `groups` is what lib/odd-group.js's `groupOddDocs` answers; the entry
// fields this module reads (`path`/`name`/`mtimeMs`) are the ones it writes, so a
// listing handed back in is the same listing.

const path = require('node:path');

// Code-unit comparison, spelled out: `localeCompare` orders by the machine's
// language, which would make the listing's sequence depend on the host.
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// A time the listing can order by: anything unreadable (absent, a string, NaN,
// an infinity) is the oldest instant there is, because a document is never hidden
// over a stat failure and never ranked by a time it did not have.
function sortTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The ONE ordering rule, shared by the panel list and the menu: the most recently
 * modified document first, then the name, then the checkout that holds it, then the
 * path, all code units. The checkout decides before the path so the panel's flat
 * listing orders an exact name-and-time tie by where the copy lives; within ONE
 * group every entry has the same checkout, so the menu's per-group order is the
 * comparator this module always answered.
 *
 * @param {{ mtimeMs?: number, name?: string, checkout?: string, path?: string }} a
 * @param {{ mtimeMs?: number, name?: string, checkout?: string, path?: string }} b
 * @returns {number}
 */
function compareEntries(a, b) {
  const left = sortTime(a.mtimeMs);
  const right = sortTime(b.mtimeMs);
  if (left !== right) return right - left;
  return compareText(a.name, b.name)
    || compareText(a.checkout, b.checkout)
    || compareText(a.path, b.path);
}

// A path as the identity uses it: absolute, and without a trailing separator (the
// filesystem root keeps its only one). `path.resolve` already drops the separator
// and the `.` segments; the strip keeps the rule stated where it is relied on.
function absolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(value);
  return resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, '');
}

// A group's document list. `docs` is what `groupOddDocs` writes; `entries` is what
// this module writes, so a listing can be listed again without a converter. Any
// other shape is no list at all.
function docsOf(group) {
  if (Array.isArray(group.docs)) return group.docs;
  if (Array.isArray(group.entries)) return group.entries;
  return [];
}

// One group, normalized — or null when it is not a group at all. A checkout that
// names itself nothing is named by its root's basename, so a label never reads
// `x ()` for a model that simply omitted the field.
function groupOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const root = absolutePath(raw.checkoutRoot);
  const named = typeof raw.checkoutName === 'string' && raw.checkoutName.length > 0;
  return {
    checkoutName: named
      ? raw.checkoutName
      : (root === null ? '' : path.basename(root)),
    checkoutRoot: root === null ? '' : root,
    isMain: raw.isMain === true,
    docs: docsOf(raw),
  };
}

// The caller's own order key, or null when it gave none: a finite number as
// written, never a string, never a NaN. It is read here and kept OUT of the entry
// value, whose fields are the documented ones only.
function orderOf(raw) {
  return typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : null;
}

// One document, normalized — or null when it cannot be drawn: a row without a name
// has nothing to display and a row without a path has nothing to open.
// `docPath` is the grouped model's spelling of the field, `path` is this module's.
function entryOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  const target = absolutePath(typeof raw.docPath === 'string' ? raw.docPath : raw.path);
  if (target === null) return null;
  return { path: target, name: raw.name, mtimeMs: sortTime(raw.mtimeMs) };
}

// A root's path segments, innermost first, so a suffix of `depth` segments is the
// shortest tail that can name it.
function trailingSegments(root) {
  if (typeof root !== 'string' || root.length === 0) return [];
  const segments = [];
  for (const segment of root.split(/[\\/]+/)) {
    if (segment.length > 0) segments.push(segment);
  }
  return segments.reverse();
}

// The tail of `depth` segments, outermost first and `/`-joined so the label reads
// the same on every host (`a/proj-x`).
function suffixAt(segments, depth) {
  return segments.slice(0, depth).reverse().join('/');
}

// Each checkout's disambiguator, decided by the ROOTS that share its
// `checkoutName`: one checkout alone uses the name itself, and a set of them grows
// one segment at a time until every tail is distinct. The depth is per checkout, so
// a root that is already unique at one segment does not spend another.
function disambiguatorsOf(groups) {
  const byName = new Map();
  for (const group of groups) {
    const list = byName.get(group.checkoutName);
    if (list === undefined) byName.set(group.checkoutName, [group]);
    else list.push(group);
  }
  const answer = new Map();
  for (const [checkoutName, checkouts] of byName) {
    if (checkouts.length === 1) {
      answer.set(checkouts[0], checkoutName);
      continue;
    }
    const segments = checkouts.map((group) => trailingSegments(group.checkoutRoot));
    const depthOf = new Array(checkouts.length).fill(0);
    const exhausted = new Array(checkouts.length).fill(false);
    let pending = checkouts.map((_, index) => index);
    let depth = 1;
    while (pending.length > 0) {
      const buckets = new Map();
      for (const index of pending) {
        const tail = suffixAt(segments[index], Math.min(depth, segments[index].length));
        const bucket = buckets.get(tail);
        if (bucket === undefined) buckets.set(tail, [index]);
        else bucket.push(index);
      }
      const next = [];
      for (const bucket of buckets.values()) {
        if (bucket.length === 1) {
          depthOf[bucket[0]] = depth;
          continue;
        }
        for (const index of bucket) {
          // A root with no segment left to spend cannot be told apart by a tail:
          // its absolute path is the only name it has left.
          if (segments[index].length <= depth) exhausted[index] = true;
          else next.push(index);
        }
      }
      pending = next;
      depth += 1;
    }
    for (let index = 0; index < checkouts.length; index += 1) {
      const checkout = checkouts[index];
      if (exhausted[index]) {
        answer.set(checkout, checkout.checkoutRoot.length > 0 ? checkout.checkoutRoot : checkoutName);
        continue;
      }
      answer.set(checkout, suffixAt(segments[index], depthOf[index]));
    }
  }
  return answer;
}

// One entry and the order key its caller gave (or null). A caller's key is the
// PRIMARY comparison; an entry it did not order is `Infinity`, so it follows every
// ordered one, and `compareEntries` decides among equals — which is also the whole
// rule for a group the caller handed no order at all.
function compareSlots(left, right) {
  const a = left.order === null ? Number.POSITIVE_INFINITY : left.order;
  const b = right.order === null ? Number.POSITIVE_INFINITY : right.order;
  if (a !== b) return a < b ? -1 : 1;
  return compareEntries(left.entry, right.entry);
}

// The first label a listing may use for `base`: the base itself, else `base #2`,
// `base #3`, … — in the order the labels are assigned, so the answer never depends
// on how a caller happened to iterate.
function uniqueLabel(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let number = 2; ; number += 1) {
    const candidate = `${base} #${number}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * The listing both surfaces draw: the grouped model with every duplicate path
 * removed and every entry labelled, plus the flat menu of the very same entries in
 * the very same order.
 *
 * A document may carry `order` (a finite number): it is the primary sort key of
 * its group, so the caller's sequence is PRESERVED, with `compareEntries` breaking
 * ties and ordering every entry that carries none (those come after the ordered
 * ones). A caller that passes no `order` gets exactly the comparator's order.
 *
 * @param {{ groups?: Array<object> }} input
 * @returns {{ groups: Array<{ checkoutName: string, checkoutRoot: string, isMain: boolean,
 *   entries: Array<{ path: string, name: string, mtimeMs: number, checkout: string,
 *     label: string }> }>,
 *   menu: Array<{ path: string, name: string, label: string }> }}
 */
function buildListing(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const rawGroups = Array.isArray(opts.groups) ? opts.groups : [];
  // Pass one, in the model's own order: a valid group keeps its documents minus the
  // paths a group before it already emitted. Junk is skipped where it is met, and a
  // group left with nothing is dropped here rather than drawn empty.
  const kept = [];
  const emitted = new Set();
  for (const rawGroup of rawGroups) {
    const group = groupOf(rawGroup);
    if (group === null) continue;
    const slots = [];
    for (const rawDoc of group.docs) {
      const entry = entryOf(rawDoc);
      if (entry === null) continue;
      if (emitted.has(entry.path)) continue;
      emitted.add(entry.path);
      slots.push({ entry, order: orderOf(rawDoc) });
    }
    if (slots.length === 0) continue;
    kept.push({ group, slots });
  }
  // Pass two: main's group first, then each remaining group in the order given, each
  // group's entries by the caller's order first and by the comparator after it. This
  // IS the panel's order; the menu is it flattened.
  const ordered = [
    ...kept.filter((item) => item.group.isMain),
    ...kept.filter((item) => !item.group.isMain),
  ];
  const groups = ordered.map((item) => {
    item.slots.sort(compareSlots);
    return {
      checkoutName: item.group.checkoutName,
      checkoutRoot: item.group.checkoutRoot,
      isMain: item.group.isMain,
      entries: item.slots.map((slot) => slot.entry),
    };
  });
  // Labels: the literal names that are unique are reserved first, so a plain name
  // always keeps its exact text and only a DERIVED label can be numbered.
  const counts = new Map();
  for (const group of groups) {
    for (const entry of group.entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
  }
  const taken = new Set();
  for (const group of groups) {
    for (const entry of group.entries) {
      if (counts.get(entry.name) !== 1) continue;
      entry.label = entry.name;
      taken.add(entry.label);
    }
  }
  // The checkout each entry was listed from, disambiguated by the SAME rule the
  // labels use: one checkout alone is named as its model named it, and a set of
  // checkouts sharing a basename is named by the shortest trailing segments that
  // tell them apart. A panel row reads this at its right edge (odd-dedupe S6), so
  // two twins can never paint the same meta cell either.
  const disambiguators = disambiguatorsOf(groups);
  for (const group of groups) {
    const checkout = disambiguators.get(group);
    for (const entry of group.entries) {
      entry.checkout = checkout;
      if (entry.label !== undefined) continue;
      entry.label = uniqueLabel(`${entry.name} (${checkout})`, taken);
    }
  }
  // Uniqueness is asserted on the VALUE, not trusted from the derivation above: a
  // label that still collides falls back to the one name no other document can
  // share.
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group.entries) {
      if (!seen.has(entry.label)) {
        seen.add(entry.label);
        continue;
      }
      entry.label = entry.path;
      seen.add(entry.label);
    }
  }
  const menu = [];
  for (const group of groups) {
    for (const entry of group.entries) {
      menu.push({ path: entry.path, name: entry.name, label: entry.label });
    }
  }
  return { groups, menu };
}

module.exports = { buildListing, compareEntries };

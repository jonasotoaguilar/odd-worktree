'use strict';
// Warp selector, redesigned as ONE component with TWO views (warp-popup
// S1,S2,S5,S6,S9): the warp PANEL and the extended list. The panel is the
// geometry the host mounts at the bottom of the terminal (S3, L6), so its
// height is decided HERE, from its own content, and `rowsAvailable` bounds
// it. PURE: no fs, no git, no registry — every external read arrives as an
// injected option, so the wiring unit only has to hand over data and a
// `done`.
//
// Host component contract (the shape the customize panel and the pickers
// already use): the factory returns
// `{ render(width), handleInput(data), invalidate(), state }`.
//
// Options
//   checkouts      array of `{ name, path, branch, isPrincipal }`; `name`
//                  defaults to the path's last segment, `branch` may be
//                  omitted, and an entry without a `path` is dropped. An
//                  entry may also carry `lastActivity` — an epoch-ms number
//                  or an ISO string, or the `{available, value, reason}`
//                  envelope `checkout-facts` returns — plus
//                  `lastActivityReason`. Rows are ordered by that value
//                  descending, and a checkout whose value is unreadable
//                  (`null`, missing, `'unavailable'`, unparsable) sorts last
//                  with its reason kept for the facts line (S12).
//   current        `{ name, path }` (or just the path string) of the
//                  checkout this session is in: it owns the panel's header
//                  and is never listed again, in EITHER view (S4b) — warping
//                  to where the session already is moves it nowhere.
//   canonicalPath(path)
//                  OPTIONAL identity reader. Two spellings of one checkout
//                  (a symlink, a `..` segment) are the SAME checkout when
//                  this resolves them to the same string, so neither view
//                  offers the current one under a second name. Compared for
//                  equality, never as a prefix: `feat-x` is not `feat-x2`.
//                  Read when the list is normalized (mount, reload,
//                  enrichment), never inside render(), so a frame stays free
//                  of I/O. Defaults to the path itself, for a caller that
//                  already hands over canonical paths.
//   facts(path)    reader for one checkout — the CURRENT one (its header
//                  data line, S4a) and the FOCUSED one (S4d) — called at
//                  most once per checkout until `r`. Resolves (or returns)
//                  either
//                  `null`/`undefined` or an object
//                    {
//                      branch:    string,
//                      changes:   the change size as `{ added, deleted }`
//                                 line counts (S16); a caller that can only
//                                 supply `{ files }` proves a zero when it
//                                 is 0 and renders `unavailable` otherwise,
//                      ahead:     commits ahead of the base (integer),
//                      behind:    commits behind the base (integer),
//                      createdAt:  a timestamp (epoch-ms number or ISO
//                                 string) or the `{available, value, reason}`
//                                 envelope; rendered as `created <age>`,
//                      lastActivity: the last-activity timestamp in the same
//                                 forms; rendered as `modified <age>`,
//                      createdAtReason / lastActivityReason: optional
//                                 diagnostic strings; S15 keeps them in the
//                                 row's DATA and never prints them (an
//                                 unreadable age renders the brief `—`),
//                    }
//                    Each field is independently optional: a missing, `null`
//                  or `'unavailable'` value renders `unavailable` (S9) and
//                  never `0`, and a missing age renders the brief `—` (S15).
//                  S1: a worktree carries no issue or ODD association any
//                  more, so an `issues`/`odd`/`assignedOdd` the reader still
//                  returns (legacy registry data is preserved, never
//                  migrated) is IGNORED: no association reaches a rendered
//                  line, a row or a legend. A measured zero for the
//                  change size or for one of `↑`/`↓` still disappears from the
//                  line entirely instead of printing `0`. A rejected read
//                  degrades to every fact `unavailable`. The read is
//                  asynchronous and never blocks a frame: a pending read
//                  renders `reading …`.
//   reload()       called on `r`; may return a new checkouts array (or a
//                  promise of one). Every cached fact is dropped either way.
//   onToggle(path) OPTIONAL. When supplied the extended list has a toggle,
//                  so `space` toggles the focused checkout while the filter
//                  is closed (S6). Without it `space` is an ordinary
//                  printable and opens the filter.
//   helpers        `{ visibleWidth, truncateToWidth, matchesKey, isKeyRelease }`.
//   theme          `{ fg(role, text), bg(role, text), bold(text) }`; S11:
//                  every frame rule, title, key, description, count, label
//                  and value paints through lib/tui-paint.js, so a shortcut KEY
//                  is accent+bold while its words are muted and no colour is
//                  named here. A missing, partial or throwing theme keeps plain
//                  text, and the focus cue stays the monochrome `▸` mark.
//   rowsAvailable  the MAXIMUM number of rows the host offers (number or
//                  function): the panel renders exactly its content and
//                  never more than this.
//   requestRender  repaint request, called after every state change.
//   done(value)    the ONLY way out, called at most once:
//                    `null`          closed with `esc`/`ctrl+c` (panel)
//                    `{ warp: path }` warp to that checkout (`enter`)
//                    `{ create: true }` open the create panel (`c`, S6)
//                    `{ delete: path }` ask to DELETE that checkout
//                                    (`ctrl+d`, both views)
//                  S1/S4: there is NO edit marker — the worktree edit panel
//                  was removed together with the issue/ODD association — but
//                  `ctrl+d` DOES name the focused checkout's own path. The
//                  component still decides nothing: the path is a request,
//                  and the extension owns the confirmation, the evidence it
//                  discloses, the refusals and the removal. So a keypress
//                  can never remove anything on its own, and this view needs
//                  no permission mode.
//                  `view all worktrees` (the row or `v`) never resolves: it
//                  opens the extended list of the same component, and `esc`
//                  there steps back one level to the panel.
//
// Keys, exactly (S5 + docs/keys.md): `↑`/`↓` and `j`/`k` move, `enter`
// chooses (and opens the extended list on `view all worktrees`), `c` opens
// the create flow, `ctrl+d` asks to delete the focused checkout, `v` opens the
// extended
// list, `r` reloads, `esc`/`ctrl+c` close from the panel
// or step back from the list. S1/S4: `e` (edit) is
// deliberately NOT a binding and no legend names it; `ctrl+d` is offered on
// the focused checkout row and never on the offer row (which is not a
// checkout). S9 keeps the footer
// shortcuts and binds no
// `?` help overlay: the footer already names every key. `↑`/`↓` are
// never repurposed for ahead/behind: both numbers ride the facts line. In the
// extended list the filter is always active (S6): `↑`/`↓`, `enter`, `esc`
// and `pgUp`/`pgDn` stay bindings, `T` or `/` open an empty filter, any
// other printable opens it with that character, and once open every
// printable — `space` included — goes to the text, `backspace` deletes one
// character and `delete` clears the whole query (S4/S12, and the footer names
// it while the search is active). `esc` closes the filter
// keeping the query; the next `esc` steps back to the panel. `ctrl+d` asks to
// delete only while the filter is closed: while the human is typing, the
// search footer owns `delete` and no destructive key fires.
//
// S5: a selector row is the checkout NAME alone, taking the width the host
// offers; the branch is not repeated there because the focused checkout's
// facts line already names it. S4b: the principal is the first row whenever
// it is not the current one, then the rows follow most-recently-modified
// first. S1: the facts line names no association at all — worktrees stopped
// receiving issues and ODD documents, so neither an id, a name nor a count of
// them is rendered anywhere in this component.
//
// Layout (S3/S4, pinned top to bottom):
//   panel  7 fixed rows — top rule, the CURRENT worktree's name, its data
//          line, a blank separator, the FOCUSED worktree's data line, the
//          one-row key legend, the bottom rule — plus up to five worktree
//          rows (the current is never one of them: it owns the header) and a
//          final `view all worktrees` row only when at least one worktree is
//          left out (S4c, reconciled in L2). With nothing to list, one
//          `(no other worktrees)` row takes that place. The height is the
//          content's own height, clamped by `rowsAvailable`, so the frame
//          always fills it exactly.
//   list   5 fixed rows — top rule, the filter row (never selectable), a
//          page of every OTHER checkout (the current one is never a
//          destination, so it is not a row here either), the page indicator
//          and the key footer, the bottom rule. When nothing is left to
//          list, the page says `(no other worktrees)` instead of offering a
//          checkout the session is already in.

const { stripAnsi } = require('./odd-markdown.js');
// S11: the ONE palette the readers share decides which theme role paints each
// kind of token (key, title, description, count, label, value, border, error),
// so a footer KEY is always distinguishable from the words beside it and this
// view keeps no second copy of the hostile-theme guards.
const palette = require('./tui-paint.js');
// Reused, not re-implemented: the pickers' page clamps and their
// independent-fact row shape are the invariants this view shares.
const { paginate } = require('./warp-create-picker.js');

// The role per token kind lives in lib/tui-paint.js (S11); this reads it
// instead of restating it. `key` and `title` resolve to the palette's own
// emphasizing painter, everything else to its colour-only one.
function paintKind(theme, kind, text) {
  const painter = palette[kind];
  if (typeof painter === 'function') return painter(theme, text);
  const role = palette.ROLES[kind];
  return typeof role === 'string' ? palette.paint(theme, role, text) : String(text);
}

const MIN_WIDTH = 24;
// S4b: at most five worktree rows; S4d adds the focused data line and the
// legend below them.
const MAX_LIST_ROWS = 5;
// top rule + current name + current data + separator + focused data +
// legend + bottom rule (S4a/S4d). The list rows and the optional
// `view all worktrees` row come on top of these.
const POPUP_FIXED_ROWS = 7;
// The panel needs its fixed rows plus one list row to be readable at all.
const POPUP_MIN_HEIGHT = POPUP_FIXED_ROWS + 1;
const LIST_MIN_HEIGHT = 8;
// top rule + filter row + page indicator + footer + bottom rule.
const LIST_FIXED_ROWS = 5;
const UNAVAILABLE = 'unavailable';
// S2: ONE legend, ONE terminal row. `text` is the full token, `short` the
// compact one used when the full form does not fit, and `priority` decides
// what a still-too-wide legend drops first (the lowest goes first, ties drop
// the later token), so `esc` outlives every other hint. S11: `key` is the
// exact key spelling the token starts with, so lib/tui-paint.js paints that
// prefix with the key role (accent+bold) and the rest as its description —
// the compact spelling keeps the same prefix, so a key never loses its role
// when the row compacts. S1/S4: the tokens are the surviving bindings —
// `e edit` is gone, `ctrl+d delete` is back on both views (the extension owns
// the confirmation, so the token promises a request, never a removal).
const POPUP_KEYS = [
  { key: '↑↓', text: '↑↓ move', short: '↑↓', priority: 70 },
  { key: 'enter', text: 'enter choose', short: 'enter', priority: 60 },
  { key: 'c', text: 'c create', short: 'c create', priority: 50 },
  { key: 'ctrl+d', text: 'ctrl+d delete', short: 'ctrl+d', priority: 40 },
  { key: 'v', text: 'v all', short: 'v all', priority: 30 },
  { key: 'r', text: 'r reload', short: 'r reload', priority: 20 },
  { key: 'esc', text: 'esc close', short: 'esc close', priority: 80 },
];
const LIST_KEYS = [
  { key: '↑↓', text: '↑↓ move', short: '↑↓', priority: 60 },
  { key: 'pgUp/pgDn', text: 'pgUp/pgDn page', short: 'pgUp/pgDn', priority: 40 },
  { key: 'enter', text: 'enter warp', short: 'enter', priority: 50 },
  { key: 'ctrl+d', text: 'ctrl+d delete', short: 'ctrl+d', priority: 45 },
  { key: 'r', text: 'r reload', short: 'r reload', priority: 20 },
  { key: 'esc', text: 'esc back', short: 'esc back', priority: 70 },
];
// S12/S4: while the search field is active, Delete clears the WHOLE query and
// the footer says so (typing it out character by character was the reported
// annoyance); Backspace keeps its one-character meaning. The hints stay on
// the one footer row like every other legend.
const LIST_FILTER_KEYS = [
  { key: '↑↓', text: '↑↓ move', short: '↑↓', priority: 60 },
  { key: 'enter', text: 'enter warp', short: 'enter', priority: 50 },
  { key: 'backspace', text: 'backspace del char', short: 'backspace', priority: 45 },
  { key: 'delete', text: 'delete clear', short: 'delete clear', priority: 65 },
  { key: 'esc', text: 'esc keep filter', short: 'esc keep', priority: 100 },
];

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the ANSI-stripped codepoint count.
  }
  return [...stripAnsi(text)].length;
}

function fit(helpers, text, width) {
  const clean = String(text).split('\n')[0] ?? '';
  if (measure(helpers, clean) <= width) return clean;
  try {
    if (helpers && typeof helpers.truncateToWidth === 'function') {
      const cut = helpers.truncateToWidth(clean, width, '…');
      if (typeof cut === 'string') return cut;
    }
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...clean];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : clean;
}

function pad(helpers, text, width) {
  const clipped = fit(helpers, text, width);
  return clipped + ' '.repeat(Math.max(0, width - measure(helpers, clipped)));
}

// S2/S11: a key legend stays on ONE row and is measured on its PLAIN text, so
// painting can never change what fits. The compaction (full token, then the
// compact one, then the lowest-priority tokens dropped) and the per-token role
// painting are lib/tui-paint.js `legendRow` — one implementation shared with
// the other readers instead of a second copy here.

// Raw fallbacks for the keys this view binds, mirroring the sequence the
// installed matcher accepts in legacy mode, so the panel stays drivable
// when the helper module failed to load (a panel that ignores Esc reads as
// frozen).
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  enter: ['\r', '\n'],
  return: ['\r', '\n'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  delete: ['\x1b[3~', '\x7f'],
  'ctrl+d': ['\x04'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  right: ['\x1b[C'],
  left: ['\x1b[D'],
  pageup: ['\x1b[5~'],
  pagedown: ['\x1b[6~'],
};

function keyText(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the fallbacks below decide.
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    for (const name of names) {
      const raw = RAW_KEY_BYTES[String(name).toLowerCase()];
      if (raw && raw.includes(data)) return true;
    }
  }
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  const lower = String(text).toLowerCase();
  return names.some((name) => lower === String(name).toLowerCase());
}

function isKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === 'function') return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases.
  }
  return false;
}

// The single printable codepoint a keystroke carries, or null. Space is
// printable: it only reaches this helper where no toggle claims it.
function printableChar(data) {
  if (typeof data !== 'string' || data.length === 0 || data === 'space') return null;
  const chars = [...data];
  if (chars.length !== 1) return null;
  const code = chars[0].codePointAt(0);
  if (!Number.isFinite(code) || code < 0x20 || code === 0x7f) return null;
  return chars[0];
}

function isSpaceKey(helpers, data) {
  // `space` (the kitty name) and the raw byte both mean space.
  if (data === ' ') return true;
  return keyText(helpers, data, ['space']);
}

function basename(target) {
  const parts = String(target).split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : String(target);
}

// Epoch ms for a timestamp in any of the forms a caller may supply: a finite
// number, a Date, or an ISO string. Null when it is not a readable timestamp
// (S9: an unreadable value is never a zero).
function toTimestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || text === UNAVAILABLE) return null;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// The ordering timestamp a checkout entry reports, in the forms the options
// doc names. `at: null` means unreadable, and `reason` keeps what the caller
// said about it so the facts line can show that instead of a fake date.
function lastActivityOf(entry) {
  let value = entry.lastActivity;
  let reason = typeof entry.lastActivityReason === 'string' && entry.lastActivityReason.length > 0
    ? entry.lastActivityReason
    : null;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (value.available === false) {
      return {
        at: null,
        reason: typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : reason,
      };
    }
    if (typeof value.reason === 'string' && value.reason.length > 0) reason = value.reason;
    value = value.value;
  }
  const at = toTimestampMs(value);
  return { at, reason: at === null ? reason : null };
}

function normalizeCheckouts(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : basename(entry.path);
    const branch = typeof entry.branch === 'string' && entry.branch.length > 0 ? entry.branch : null;
    const activity = lastActivityOf(entry);
    out.push({
      name,
      path: entry.path,
      branch,
      isPrincipal: entry.isPrincipal === true,
      lastActivity: activity.at,
      lastActivityReason: activity.reason,
    });
  }
  // S6: the principal leads whenever it is present and not the current
  // checkout, whatever its activity: the comparator below puts a principal
  // row ahead of every other row regardless of timestamps. Every other row
  // follows most-recent-first; an unreadable value sorts last, and a stable
  // sort keeps the caller's order among equals (S12).
  out.sort((a, b) => {
    if (a.isPrincipal !== b.isPrincipal) return a.isPrincipal ? -1 : 1;
    if (a.lastActivity === null && b.lastActivity === null) return 0;
    if (a.lastActivity === null) return 1;
    if (b.lastActivity === null) return -1;
    return b.lastActivity - a.lastActivity;
  });
  return out;
}

function normalizeCurrent(current, checkouts) {
  if (typeof current === 'string' && current.length > 0) {
    const hit = checkouts.find((entry) => entry.path === current);
    return hit ? { name: hit.name, path: hit.path } : { name: basename(current), path: current };
  }
  if (current && typeof current === 'object' && typeof current.path === 'string' && current.path.length > 0) {
    const name = typeof current.name === 'string' && current.name.length > 0 ? current.name : basename(current.path);
    return { name, path: current.path };
  }
  return null;
}

function missing(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && (value.trim() === '' || value.trim() === UNAVAILABLE);
}

function textFact(value) {
  return missing(value) ? UNAVAILABLE : String(value);
}

// S1: a worktree no longer carries an issue or ODD association, so the facts
// line has no association fact at all — not even a placeholder for one. A
// legacy `issues`/`odd`/`assignedOdd` in the payload is ignored rather than
// rendered, which is what keeps a stored association from reappearing on
// screen after the entity stopped owning it.

// Line counts for the change size (S16). `{ added, deleted }` is the fact's
// own shape; a caller that supplies only a file count can prove cleanliness
// (`files: 0` means no changed file could add or delete a line) but never a
// size, which stays unreadable rather than being faked or rendered as the
// retired file count.
function changeCounts(value) {
  if (value && typeof value === 'object') {
    const added = Number.isInteger(value.added) && value.added >= 0 ? value.added : null;
    const deleted = Number.isInteger(value.deleted) && value.deleted >= 0 ? value.deleted : null;
    if (added !== null && deleted !== null) return { added, deleted };
    if (Number.isInteger(value.files) && value.files >= 0) {
      return value.files === 0 ? { added: 0, deleted: 0 } : null;
    }
    return null;
  }
  if (Number.isInteger(value) && value >= 0) return value === 0 ? { added: 0, deleted: 0 } : null;
  return null;
}

// The rendered change size, or `null` when it is a measured zero and the
// field must not appear at all (S16). `unavailable` is NOT a zero and stays.
// A readable size is the bare `+A −D`: the sign already says what the numbers
// are, so the label in front of it was noise (feedback). The label survives
// ONLY where the size is unreadable, because a bare `unavailable` would not
// say which fact is missing.
function changesFact(value) {
  if (missing(value)) return UNAVAILABLE;
  const counts = changeCounts(value);
  if (counts === null) return UNAVAILABLE;
  if (counts.added === 0 && counts.deleted === 0) return null;
  // A zero side is dropped rather than printed: `−0` and `+0` say nothing a
  // reader needs, so only the nonzero half of the pair appears.
  const parts = [];
  if (counts.added !== 0) parts.push(`+${counts.added}`);
  if (counts.deleted !== 0) parts.push(`−${counts.deleted}`);
  return parts.join(' ');
}

// One direction of ahead/behind (S16): a measured zero is omitted (`null`),
// while an unreadable value is not a zero and stays with its glyph.
function arrowFact(glyph, value) {
  if (missing(value)) return `${glyph}${UNAVAILABLE}`;
  const count = Number.isInteger(value) && value >= 0 ? value : null;
  if (count === null) return `${glyph}${UNAVAILABLE}`;
  if (count === 0) return null;
  return `${glyph}${count}`;
}

// Relative age in this package's style, the same one the issues view uses
// (including its `ago` suffix) so two surfaces never describe the same clock
// two different ways: just now, minutes, hours, days, months, years.
function relativeAge(ms, nowMs) {
  const diff = nowMs - ms;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// The brief marker a compact facts row renders for an age it cannot read
// (S15). The caller's prose reason ("no activity since the checkout was
// created") stays in the row's data, never on screen: a preview line is a
// value, not an explanation.
const UNAVAILABLE_AGE = '—';

// One age fact: a timestamp in any accepted form, or the checkout-facts
// envelope. Unreadable renders the brief marker — never a fake date and never
// the caller's long reason.
function ageFact(raw, nowMs) {
  let value = raw;
  if (value && typeof value === 'object' && !(value instanceof Date)) value = value.value;
  const at = toTimestampMs(value);
  return at === null ? UNAVAILABLE_AGE : relativeAge(at, nowMs);
}

// A panel data line (S4a/S4d): every fact of one checkout, one line, each
// independently honest (S9). S16 renders the change size as line counts and
// DROPS a measured zero for the change size and for each of `↑`/`↓`, while
// `unavailable` always stays. S15 keeps the
// two ages brief: an unreadable one is `—`, and the diagnostic reason the
// caller supplied travels with the row's data instead of this line. Exported
// so the wiring unit and its tests format exactly what the panel renders.
// S1: no association fact is rendered (a legacy one in the payload is
// ignored). `opts.now` pins the clock both ages use.
function formatFactsLine(facts, opts) {
  const value = facts && typeof facts === 'object' ? facts : {};
  const settings = opts && typeof opts === 'object' ? opts : {};
  const nowMs = Number.isFinite(settings.now) ? settings.now : Date.now();
  const parts = [`branch ${textFact(value.branch)}`];
  const changes = changesFact(value.changes);
  // S16: a readable size stands alone; an unreadable one keeps its label so
  // the line still names the fact that could not be read.
  if (changes === UNAVAILABLE) parts.push(`changes ${UNAVAILABLE}`);
  else if (changes !== null) parts.push(changes);
  const arrows = [arrowFact('↑', value.ahead), arrowFact('↓', value.behind)]
    .filter((part) => part !== null)
    .join(' ');
  if (arrows.length > 0) parts.push(arrows);
  parts.push(
    `created ${ageFact(value.createdAt, nowMs)}`,
    `modified ${ageFact(value.lastActivity, nowMs)}`,
  );
  return parts.join(' · ');
}

function filterCheckouts(checkouts, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return checkouts.slice();
  return checkouts.filter((entry) => [entry.name, entry.branch || '', entry.path]
    .some((field) => String(field).toLowerCase().includes(needle)));
}

function createWarpSelectorView(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  let checkouts = normalizeCheckouts(opts.checkouts);
  const current = normalizeCurrent(opts.current, checkouts);
  const currentPath = current ? current.path : null;
  const canonicalizer = typeof opts.canonicalPath === 'function' ? opts.canonicalPath : null;
  // path -> checkout identity, filled when the list is NORMALIZED (mount,
  // reload, enrichment) and read by the frames: render() performs no I/O.
  const identities = new Map();
  const currentId = identityOf(currentPath);
  rememberIdentities();
  const factsReader = typeof opts.facts === 'function' ? opts.facts : null;
  const reloader = typeof opts.reload === 'function' ? opts.reload : null;
  const toggler = typeof opts.onToggle === 'function' ? opts.onToggle : null;
  const helpers = opts.helpers || null;
  const theme = opts.theme || null;
  const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : null;
  const rawFinish = typeof opts.done === 'function' ? opts.done : () => {};
  const nowOption = opts.now;
  const nowFn = typeof nowOption === 'function'
    ? () => {
        const value = nowOption();
        return Number.isFinite(value) ? value : Date.now();
      }
    : (Number.isFinite(nowOption) ? () => nowOption : () => Date.now());
  let settled = false;

  // The state is exposed for the wiring unit and for its tests: `view` is
  // 'popup' | 'list', `cursor` indexes the panel's selectable rows, and
  // `listCursor` the filtered extended list; `filter`/`filterOpen` are the
  // always-active filter, `page` the visible page, `help` the overlay, and
  // `checkouts`/`facts` the last data the component was given.
  const state = {
    view: 'popup',
    cursor: 0,
    listCursor: 0,
    filter: '',
    filterOpen: false,
    page: 0,
    checkouts,
    facts: { path: null, status: 'idle' },
  };
  // path -> { status: 'pending'|'ready'|'error', value }; S9 caches so a
  // frame never re-reads and a move back is instant.
  const factCache = new Map();
  // S4a/S4d: the panel opens with two data lines — the current worktree's
  // and the first focused row's — so both reads start here instead of in
  // render() (S1: a frame performs no I/O).
  startFacts(currentPath);
  startFacts(focusedPopupPath());

  function finish(value) {
    if (settled) return;
    settled = true;
    rawFinish(value);
  }

  function requestPaint() {
    if (!requestRender) return;
    try {
      requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function availableRows() {
    let raw;
    try {
      raw = typeof opts.rowsAvailable === 'function' ? opts.rowsAvailable() : opts.rowsAvailable;
    } catch {
      return 0;
    }
    const rows = Math.floor(Number(raw));
    return Number.isFinite(rows) && rows > 0 ? rows : 0;
  }

  function startFacts(path) {
    if (typeof path !== 'string' || path.length === 0) return;
    if (factCache.has(path)) return;
    if (!factsReader) {
      factCache.set(path, { status: 'error', value: null });
      return;
    }
    factCache.set(path, { status: 'pending', value: null });
    state.facts = { path, status: 'pending' };
    let answer;
    try {
      answer = factsReader(path);
    } catch {
      factCache.set(path, { status: 'error', value: null });
      state.facts = { path, status: 'error' };
      return;
    }
    Promise.resolve(answer).then(
      (value) => {
        factCache.set(path, { status: 'ready', value });
        if (state.facts.path === path) state.facts = { path, status: 'ready' };
        if (state.view === 'popup' && (focusedPopupPath() === path || currentPath === path)) requestPaint();
      },
      () => {
        factCache.set(path, { status: 'error', value: null });
        if (state.facts.path === path) state.facts = { path, status: 'error' };
        if (state.view === 'popup' && (focusedPopupPath() === path || currentPath === path)) requestPaint();
      },
    );
  }

  // The destinations this session can move to: every checkout except the one
  // it already stands in (S4b). Both views read this one list, so neither can
  // offer a route the session is already on.
  function others() {
    return checkouts.filter((entry) => !isCurrent(entry));
  }

  // The identity of one path: the canonical spelling when the caller supplied
  // a reader, the path itself otherwise. A reader that throws or answers
  // nothing leaves the spelling as the identity instead of breaking a frame.
  function identityOf(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (!canonicalizer) return value;
    try {
      const resolved = canonicalizer(value);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    } catch {
      // A hostile reader leaves the spelling as the identity.
    }
    return value;
  }

  // Rebuilt from the list that was just normalized, so a checkout that left
  // the listing leaves no identity behind and a moved one is re-read.
  function rememberIdentities() {
    identities.clear();
    for (const entry of checkouts) identities.set(entry.path, identityOf(entry.path));
  }

  // S4b: the one notion of "the checkout this session is in", shared by the
  // panel and the extended list. Identity, never a string prefix: `feat-x` is
  // not `feat-x2`, and a symlink spelling of the current checkout is still the
  // current checkout. A session standing outside every listed checkout (or no
  // `current` at all) excludes nothing, which is the honest answer.
  function isCurrent(entry) {
    if (currentId === null) return false;
    const id = identities.has(entry.path) ? identities.get(entry.path) : entry.path;
    return id === currentId;
  }

  // S5: a row is the name alone. `describe` appends only the non-branch role
  // markers (principal); the current checkout is never a row to mark.
  function describe(entry) {
    return entry.isPrincipal ? 'use the local project' : null;
  }

  function rowText(entry, marker) {
    const desc = describe(entry);
    return `${marker}${entry.name}${desc ? ` · ${desc}` : ''}`;
  }

  // S4b/S4c: the list area holds at most five worktree rows and, only when
  // at least one worktree is left out, one extra `view all worktrees` row.
  // `maxRows` is the ceiling the host offers; `height` is what this plan
  // actually renders, so the frame fills it exactly.
  function popupPlan(maxRows) {
    const list = others();
    const area = Math.max(0, maxRows - POPUP_FIXED_ROWS);
    if (list.length === 0) {
      // One muted row explains the empty list inside the frame.
      return { list, shown: [], viewAll: false, height: POPUP_FIXED_ROWS + 1 };
    }
    if (list.length <= Math.min(MAX_LIST_ROWS, area)) {
      return { list, shown: list, viewAll: false, height: POPUP_FIXED_ROWS + list.length };
    }
    // Something is hidden, so the offer row costs one of the area's rows.
    const shown = list.slice(0, Math.max(0, Math.min(MAX_LIST_ROWS, area - 1)));
    const viewAll = area >= 1;
    return { list, shown, viewAll, height: POPUP_FIXED_ROWS + shown.length + (viewAll ? 1 : 0) };
  }

  // S6: creation is a hotkey, never a list row, so the selectable rows are
  // exactly the worktrees shown plus the offer row.
  function popupItems(plan) {
    const items = [];
    for (const entry of plan.shown) items.push({ kind: 'checkout', checkout: entry });
    if (plan.viewAll) items.push({ kind: 'viewall' });
    return items;
  }

  function popupItemsNow() {
    return popupItems(popupPlan(availableRows()));
  }

  function focusedPopupItem() {
    const items = popupItemsNow();
    return items[Math.min(Math.max(0, state.cursor), items.length - 1)] || null;
  }

  function focusedPopupPath() {
    const item = focusedPopupItem();
    return item && item.kind === 'checkout' ? item.checkout.path : null;
  }

  // S4a/S4d: one formatter for every data line this panel draws. A cached
  // read is rendered as it is, a pending one says so, and a path that was
  // never read stays empty instead of claiming a fact.
  function factsTextFor(path) {
    if (typeof path !== 'string' || path.length === 0) return '';
    const nowMs = nowFn();
    const line = (value) => formatFactsLine(value, { now: nowMs });
    const entry = factCache.get(path);
    if (!entry) return '';
    if (entry.status === 'ready') return line(entry.value);
    if (entry.status === 'pending') return 'reading …';
    return line(null);
  }

  function currentFactsText() {
    return factsTextFor(currentPath);
  }

  // S4d: the row the cursor sits on, or an empty line when nothing is
  // listed (the list area already says why).
  function factsRowText() {
    const item = focusedPopupItem();
    if (!item) return '';
    if (item.kind === 'viewall') return 'every worktree, searchable';
    return factsTextFor(item.checkout.path);
  }

  // S4b: the extended list is the same set of destinations the panel offers —
  // every checkout except the one this session already stands in — filtered
  // by the always-active query and paged.
  function listPlan(height) {
    const rows = filterCheckouts(others(), state.filter);
    const pageSize = Math.max(1, height - LIST_FIXED_ROWS);
    const requested = rows.length === 0 ? 0 : Math.floor(Math.max(0, state.listCursor) / pageSize);
    const page = paginate(rows, requested, pageSize);
    const start = page.page * pageSize;
    const end = Math.min(rows.length, start + page.items.length);
    if (rows.length === 0) state.listCursor = 0;
    else state.listCursor = Math.min(Math.max(start, state.listCursor), end - 1);
    state.page = page.page;
    return { rows, page: page.page, pageCount: page.pageCount, pageSize, items: page.items, cursor: state.listCursor };
  }

  function focusedListCheckout() {
    const height = availableRows();
    if (!height) return null;
    const plan = listPlan(height);
    return plan.items[plan.cursor - plan.page * plan.pageSize] || null;
  }

  function movePopup(delta) {
    const height = availableRows();
    if (!height) return;
    const items = popupItems(popupPlan(height));
    if (items.length === 0) return;
    state.cursor = Math.min(items.length - 1, Math.max(0, state.cursor + delta));
    // S1: a move is what starts the focused checkout's read. render() itself
    // never performs I/O.
    if (state.view === 'popup') startFacts(focusedPopupPath());
    requestPaint();
  }

  function moveList(delta) {
    const height = availableRows();
    if (!height) return;
    const plan = listPlan(height);
    if (plan.rows.length === 0) return;
    state.listCursor = Math.min(plan.rows.length - 1, Math.max(0, plan.cursor + delta));
    requestPaint();
  }

  function pageList(direction) {
    const height = availableRows();
    if (!height) return;
    const plan = listPlan(height);
    if (plan.rows.length === 0) return;
    const next = direction > 0
      ? Math.min(plan.page + 1, plan.pageCount - 1)
      : Math.max(0, plan.page - 1);
    state.listCursor = Math.min(plan.rows.length - 1, next * plan.pageSize);
    requestPaint();
  }

  function openList() {
    state.view = 'list';
    state.listCursor = 0;
    const focused = focusedPopupItem();
    if (focused && focused.kind === 'checkout') {
      const rows = filterCheckouts(others(), state.filter);
      const at = rows.findIndex((entry) => entry.path === focused.checkout.path);
      if (at >= 0) state.listCursor = at;
    }
    requestPaint();
  }

  function openFilter(seed) {
    state.filterOpen = true;
    if (typeof seed === 'string' && seed.length > 0) state.filter += seed;
    state.listCursor = 0;
    requestPaint();
  }

  function closeFilter() {
    state.filterOpen = false;
    requestPaint();
  }

  function appendFilter(text) {
    state.filter += text;
    state.listCursor = 0;
    requestPaint();
  }

  function backspaceFilter() {
    const chars = [...state.filter];
    if (chars.length === 0) return;
    chars.pop();
    state.filter = chars.join('');
    state.listCursor = 0;
    requestPaint();
  }

  // S12/S4: Delete empties the whole query at once while the search field is
  // active. It is a text-editing key here, never the worktree deletion
  // binding (`ctrl+d` owns that).
  function clearFilter() {
    if (state.filter === '') return;
    state.filter = '';
    state.listCursor = 0;
    requestPaint();
  }

  function reload() {
    factCache.clear();
    state.facts = { path: null, status: 'idle' };
    // The current worktree's line is not part of the reloaded list, so its
    // read restarts before the reloader's answer can start the focused one.
    if (state.view === 'popup') startFacts(currentPath);
    let next;
    try {
      next = reloader ? reloader() : null;
    } catch {
      next = null;
    }
    const settle = (value) => { if (Array.isArray(value)) apply(value); };
    if (next && typeof next.then === 'function') Promise.resolve(next).then(settle, () => {});
    else settle(next);
    requestPaint();
    if (state.view === 'popup') startFacts(focusedPopupPath());
  }

  // S1: apply enrichment that arrived AFTER the mount (activity ages, newly
  // readable facts). The rows re-sort, but the focused checkout keeps its
  // identity across the reorder instead of the cursor silently landing on a
  // different row. A settled component ignores late work (only still-alive
  // components repaint).
  function apply(list) {
    if (settled || !Array.isArray(list)) return;
    const focusPath = state.view === 'list'
      ? ((focusedListCheckout() || {}).path || null)
      : focusedPopupPath();
    checkouts = normalizeCheckouts(list);
    state.checkouts = checkouts;
    rememberIdentities();
    refocus(focusPath);
    requestPaint();
    if (state.view === 'popup') startFacts(focusedPopupPath());
  }

  function refocus(path) {
    if (typeof path !== 'string' || path.length === 0) return;
    if (state.view === 'list') {
      const rows = filterCheckouts(others(), state.filter);
      const at = rows.findIndex((entry) => entry.path === path);
      if (at >= 0) state.listCursor = at;
      else state.listCursor = Math.min(state.listCursor, Math.max(0, rows.length - 1));
      return;
    }
    const items = popupItemsNow();
    const at = items.findIndex((item) => item.kind === 'checkout' && item.checkout.path === path);
    if (at >= 0) state.cursor = at;
    else state.cursor = Math.min(state.cursor, Math.max(0, items.length - 1));
  }

  function choosePopup() {
    const item = focusedPopupItem();
    if (!item) return;
    if (item.kind === 'viewall') {
      openList();
      return;
    }
    finish({ warp: item.checkout.path });
  }

  // S4: `ctrl+d` NAMES the checkout to delete and nothing else. The marker
  // carries the focused path, so the extension re-resolves it against a fresh
  // listing and asks its own question; nothing here reads a permission mode,
  // inspects changes or removes anything. The offer row is not a checkout, so
  // it resolves nothing.
  function askDelete(item) {
    if (!item || item.kind !== 'checkout') return;
    finish({ delete: item.checkout.path });
  }

  function askDeletePopup() {
    askDelete(focusedPopupItem());
  }

  function askDeleteList() {
    const entry = focusedListCheckout();
    if (!entry) return;
    finish({ delete: entry.path });
  }

  function chooseList() {
    const entry = focusedListCheckout();
    if (!entry) return;
    finish({ warp: entry.path });
  }

  function handlePopupInput(data) {
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      finish(null);
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      choosePopup();
      return;
    }
    if (keyText(helpers, data, ['up', 'k'])) {
      movePopup(-1);
      return;
    }
    if (keyText(helpers, data, ['down', 'j'])) {
      movePopup(1);
      return;
    }
    if (keyText(helpers, data, ['c'])) {
      // S6: creation is a hotkey, never one of the list rows.
      finish({ create: true });
      return;
    }
    if (keyText(helpers, data, ['ctrl+d'])) {
      askDeletePopup();
      return;
    }
    if (keyText(helpers, data, ['v'])) {
      openList();
      return;
    }
    if (keyText(helpers, data, ['r'])) {
      reload();
    }
  }

  function handleListInput(data) {
    const open = state.filterOpen;
    // Navigation and confirmation stay bindings while the filter is open (S6).
    if (keyText(helpers, data, ['up'])) {
      moveList(-1);
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveList(1);
      return;
    }
    if (keyText(helpers, data, ['pageup'])) {
      pageList(-1);
      return;
    }
    if (keyText(helpers, data, ['pagedown'])) {
      pageList(1);
      return;
    }
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      if (open) closeFilter();
      else {
        state.view = 'popup';
        // S1: stepping back into the panel may focus a checkout that has not
        // been read yet; start its read now, never inside render().
        startFacts(focusedPopupPath());
        requestPaint();
      }
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      chooseList();
      return;
    }
    if (!open && keyText(helpers, data, ['k'])) {
      moveList(-1);
      return;
    }
    if (!open && keyText(helpers, data, ['j'])) {
      moveList(1);
      return;
    }
    if (!open && keyText(helpers, data, ['r'])) {
      reload();
      return;
    }
    // S4: the delete request is a browsing binding, so the search field owns
    // the keyboard instead (`delete` there clears the query).
    if (!open && keyText(helpers, data, ['ctrl+d'])) {
      askDeleteList();
      return;
    }
    if (isSpaceKey(helpers, data)) {
      if (open) {
        appendFilter(' ');
        return;
      }
      if (toggler) {
        const entry = focusedListCheckout();
        if (!entry) return;
        try {
          toggler(entry.path);
        } catch {
          // A hostile toggle never breaks navigation.
        }
        requestPaint();
        return;
      }
      openFilter(' ');
      return;
    }
    if (keyText(helpers, data, ['backspace'])) {
      if (open) backspaceFilter();
      return;
    }
    if (keyText(helpers, data, ['delete'])) {
      if (open) clearFilter();
      return;
    }
    const typed = printableChar(data);
    if (!open && (typed === 'T' || typed === '/')) {
      // The explicit openers start a NEW search, so a stale query never
      // silently hides the rows the user is about to browse.
      state.filter = '';
      openFilter('');
      return;
    }
    if (typed) {
      if (open) appendFilter(typed);
      else openFilter(typed);
    }
  }

  // S11: every frame mark takes the palette's border role, so a theme that
  // names one decides the whole frame.
  function border(text) {
    return palette.paint(theme, 'border', text);
  }

  function frameTop(width, title) {
    const shownTitle = fit(helpers, title, Math.max(1, width - 11));
    const left = `${border('╭─')} ${palette.title(theme, shownTitle)} `;
    const right = ` ${palette.key(theme, 'esc')} ${border('─╮')}`;
    const fill = Math.max(0, width - measure(helpers, left) - measure(helpers, right));
    return `${left}${border('─'.repeat(fill))}${right}`;
  }

  function frameBottom(width) {
    return border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
  }

  // S11: a row body is either the focused band (the monochrome `▸` still marks
  // it when the theme offers no background) or one palette KIND.
  function frameRow(width, text, kind, focused) {
    const inner = Math.max(1, width - 4);
    const padded = pad(helpers, text, inner);
    const body = focused ? palette.highlight(theme, padded, true) : paintKind(theme, kind, padded);
    return `${border('│')} ${body} ${border('│')}`;
  }

  // The panel legend's tokens: the offer row's key only when there is an
  // offer. S1/S4: no capability token is conditional any more — the delete
  // key and its predicate left with the worktree association.
  function popupLegend(plan) {
    return plan.viewAll ? POPUP_KEYS.slice() : POPUP_KEYS.filter((entry) => entry.text !== 'v all');
  }

  // S2/S11: the footer legend renders through the frame row, so it is
  // compacted to the same inner width the row then pads to — one row, never
  // wrapped — and every key/description pair carries its own role.
  function legendRow(width, entries) {
    return frameRow(width, palette.legendRow(theme, entries, Math.max(1, width - 4), (text) => measure(helpers, text)), null);
  }

  // S3/S4: the panel renders exactly `plan.height` rows, so a host that
  // anchors it at the bottom of the terminal gets a frame with no loose
  // lines inside or below it.
  function renderPopup(width, maxRows) {
    const plan = popupPlan(maxRows);
    const items = popupItems(plan);
    if (state.cursor > items.length - 1) state.cursor = Math.max(0, items.length - 1);
    if (state.cursor < 0) state.cursor = 0;
    const focused = items[state.cursor];

    const lines = [frameTop(width, 'Warp')];
    lines.push(frameRow(width, current ? current.name : '(unknown checkout)', 'value'));
    lines.push(frameRow(width, currentFactsText(), 'count'));
    lines.push(frameRow(width, ''));

    if (plan.list.length === 0) {
      lines.push(frameRow(width, '(no other worktrees)', 'count'));
    } else {
      for (const entry of plan.shown) {
        const isFocused = !!(focused && focused.kind === 'checkout' && focused.checkout.path === entry.path);
        lines.push(frameRow(width, rowText(entry, isFocused ? '▸ ' : '  '), null, isFocused));
      }
      if (plan.viewAll) {
        lines.push(frameRow(
          width,
          `${focused && focused.kind === 'viewall' ? '▸ ' : '  '}view all worktrees`,
          'value',
          !!(focused && focused.kind === 'viewall'),
        ));
      }
    }
    lines.push(frameRow(width, factsRowText(), 'count'));
    // S4c: with nothing left out there is no offer row, so the legend does
    // not advertise its key either. `v` itself keeps working.
    lines.push(legendRow(width, popupLegend(plan)));
    lines.push(frameBottom(width));
    return lines;
  }

  // S11: the search row paints its static label dim and the live query as a
  // value; the focused band marks it while the filter holds the keyboard.
  function filterLine() {
    const prefix = palette.label(theme, 'filter: ');
    if (state.filterOpen) return `${prefix}${palette.value(theme, `${state.filter}▏`)}`;
    if (state.filter === '') return `${prefix}${palette.description(theme, 'type to search')}`;
    return `${prefix}${palette.value(theme, state.filter)}`;
  }

  function renderList(width, height) {
    const plan = listPlan(height);
    const rowTexts = [];
    if (plan.items.length === 0) {
      const needle = state.filter.trim();
      rowTexts.push({ text: needle === '' ? '(no other worktrees)' : `(no matches for "${needle}")`, kind: 'count' });
    } else {
      const pageStart = plan.page * plan.pageSize;
      plan.items.forEach((entry, offset) => {
        const isFocused = pageStart + offset === plan.cursor;
        rowTexts.push({
          text: rowText(entry, isFocused ? '▸ ' : '  '),
          focused: isFocused,
        });
      });
    }
    const filterText = filterLine();
    const lines = [frameTop(width, 'Warp · all worktrees')];
    lines.push(frameRow(width, filterText, state.filterOpen ? null : 'count', state.filterOpen));
    for (let row = 0; row < plan.pageSize; row += 1) {
      const entry = rowTexts[row];
      lines.push(entry ? frameRow(width, entry.text, entry.kind, entry.focused) : frameRow(width, ''));
    }
    const total = plan.rows.length;
    // S11: a static label, a live value and a count — each with its own role.
    lines.push(frameRow(width,
      `${palette.label(theme, 'page ')}${palette.value(theme, `${plan.page + 1}/${plan.pageCount}`)}`
      + `${palette.count(theme, ` · ${total} ${total === 1 ? 'worktree' : 'worktrees'}`)}`,
      null));
    // S12/S4: an active search names the Delete-clear key; the browsing list
    // keeps its own legend. Either way it is exactly one footer row.
    lines.push(legendRow(width, state.filterOpen ? LIST_FILTER_KEYS : LIST_KEYS));
    lines.push(frameBottom(width));
    return lines;
  }

  function render(width) {
    const w = Math.floor(Number(width));
    if (!Number.isFinite(w) || w <= 0) return [];
    const maxRows = availableRows();
    const minimum = state.view === 'list' ? LIST_MIN_HEIGHT : POPUP_MIN_HEIGHT;
    if (w < MIN_WIDTH || maxRows < minimum) {
      return [pad(helpers, fit(helpers, 'Warp — enlarge the terminal', w), w)];
    }
    // S3/S4: the panel takes its own height (never taller than the host
    // offers); the extended list still fills every row it is given.
    return state.view === 'list' ? renderList(w, maxRows) : renderPopup(w, maxRows);
  }

  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    if (state.view === 'list') {
      handleListInput(data);
      return;
    }
    handlePopupInput(data);
  }

  function invalidate() {}

  return { render, handleInput, invalidate, apply, state };
}

module.exports = {
  createWarpSelectorView,
  formatFactsLine,
  MIN_WIDTH,
  MAX_LIST_ROWS,
  POPUP_MIN_HEIGHT,
  LIST_MIN_HEIGHT,
  POPUP_FIXED_ROWS,
  LIST_FIXED_ROWS,
};

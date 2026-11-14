'use strict';
// The worktree CREATION panel (warp-branch-field S1,S2,S6,S7,S8,S9,S10;
// warp-odd-picker S1,S2; worktree-ui-feedback S4,S12,S15).
//
// It is the TABBED bottom flow a human creates with (S7): a live branch/path
// preview ABOVE, then the BRANCH and the ODD as the TWO TABS of one strip
// (`Branch · Odd`, with only the ACTIVE field's content under it). The Branch tab
// holds the typed name over the change types as an inline LIST; the Odd tab holds
// the ODD as an inline LIST too (there is no native dropdown in this host, and no
// second pop-up surface).
//
// S1: the branch is the human's, never a derivation. `Branch` is the same input
// `worktree_create` has always taken, composed as `<type>/<name>`: the type is
// chosen from the repository's list and the name is typed. The ODD stays the ODD
// — the directory name — and never enters the branch's spelling, so no branch
// ever names a directory (R1). There is still no `Name` field (S2): the ODD is the
// checkout's identity, and the branch has its own name. S2: the ODD is CHOSEN,
// not typed from nothing — the list is the ODDs that exist in `main`
// (`lib/warp-create-picker.js` `listMainOddTasks`, injected as `oddOptions` by the
// caller that can await the read), with `new odd` as the FIRST entry; that entry,
// and only that entry, takes a typed name.
//
// S6: `feat` is the first type, so an untouched form already previews `feat/` and
// the human only has to type; the field reads the typed name on TOP and the type
// list under it.
//
// S7/S8/S9/S10: both typed fields share ONE typed-row design (`typedRow`) — the
// `❯` prompt, the field's static label, the composed prefix (`feat/`), the typed
// value, the caret, and the ghost placeholder while the value is empty. The lists
// beside them (the eleven types, the ODDs `main` carries) stay PLAIN rows, and a
// blank separator row puts the input region above its list: typing looks like
// typing in both fields, choosing looks like choosing, and the distinction
// survives a monochrome terminal because it rides spacing and markers, never a
// colour this module picks. The Odd field's first row IS its input: `new odd` is
// the only entry that takes a typed name, so while it is focused it renders as
// the shared typed row and the documents stand alone under the separator; while a
// DOCUMENT is focused there is no input under the list at all and `new odd` stays
// a plain row in its place. Nothing is echoed under the list.
//
// The preview shows the composed branch as soon as the form opens (`feat/`) and
// the worktree root `…-worktrees/`, completing as the name is typed and the ODD
// is picked: an incomplete form is not an error, so nothing in the preview is
// painted red or names a failure, while a refused submit still says exactly why.
// `tab`, `shift+tab`, `←` and `→` move between the two tabs; `↑`/`↓` pick from the
// active list; a printable character types the active field's own text; `enter`
// on the ODD creates (S12 keeps ONE create key — the duplicate `ctrl+s` was
// dropped and is not a binding).
//
// S5 (warp-branch-field): one ODD is one worktree, so an ODD whose checkout
// already exists is not a choice. The caller hands the existing checkouts over
// (`occupiedPaths`, reconciled against git's live listing so a stale registry row
// for a removed checkout never hides an ODD that is free again) and the panel
// drops exactly those options. The filter is an AID, never the check: an ODD that
// still collides is refused by the create path with its own sentence.
//
// Everything the panel does NOT do is as important: it creates no file, writes
// nothing and registers nothing. A chosen ODD that already has a document creates
// no document, and the document of a new ODD is left to the agent that starts
// work on it — nothing in this package anticipates that, waits for it or reports
// it. `done({ ok: true, branch, odd })` is the whole output.
//
// Pure Node, no package imports. The repository's own helpers do the work
// instead of a second implementation of the same convention: the ported
// `lib/worktree-create.js` `isWorktreeSegment` decides what an ODD may say, so
// the preview and the create refuse the same values with the same words, and
// `lib/worktree-git.js` `canonicalWorktreePathOf` (or `canonicalWorktreePath` /
// `worktreePath`) over its memoized `repoIdentity` give the parent directory the
// create lays the ODD in. The git seam is injectable (`git`), so tests never touch
// a real checkout.
//
// S1 (worktree-ui-feedback): the panel is a FORM and spawns no
// `git check-ref-format`. Its preview derives from the PURE halves of those
// helpers, so a typed character costs no child at all — the blocking child that
// ran here from `render()` froze Pi for its whole lifetime per keystroke, which
// is the reported "creating a worktree left Pi stuck". The one authoritative
// branch check lives where it can be awaited: the create path that receives this
// panel's payload (`worktree_create` → `validateBranchAsync`), which refuses an
// invalid branch with its own message and nothing created.
//
// Host component contract (the same seam the customize panel and the pickers
// use): `createWarpCreatePanel(options)` returns
// `{ render(width), handleInput(data), invalidate(), state }`.
//
// Completion (documented exactly, because it is the module's only output):
//   done({ ok: true, branch, odd })
// on `enter` in the last field (the ODD), and
// `done(null)` on `esc` (cancel). `branch` is the composed `<type>/<name>`, passed
// through UNCHANGED (created when it is absent, adopted when it exists), and `odd`
// is the trimmed ODD that names the checkout's directory. A completion NEVER
// carries `name` and NEVER carries `issues`: the ODD is the only identity and a
// new row is born without an issue association, and there is no other completion
// shape. A completion fires EXACTLY once. An invalid branch/path/ODD refuses
// creation (nothing is emitted) and the reason stays on screen.
//
// Options (every one optional; the seams exist so tests own the world):
//   cwd               checkout the panel derives the path from
//                     (default: process.cwd())
//   changeTypes       `[{id,label}]`; default exports CHANGE_TYPES, the
//                     repository's branch-pr convention
//   oddOptions        the ODDs to offer, already read from `main` (default: an
//                     empty list, which still offers `new odd`)
//   occupiedPaths     absolute paths of the checkouts that already exist; an ODD
//                     whose destination is one of them is not offered (default:
//                     none, which filters nothing)
//   oddPlaceholder    ghost hint of the new-ODD input (default ODD_PLACEHOLDER)
//   branchPlaceholder ghost hint of the branch name (default BRANCH_PLACEHOLDER)
//   initialOdd        select this ODD when it is in the list, else prefill the
//                     new-ODD field with it
//   initialType       pre-selected change-type id (default: the first, `feat`)
//   rowsAvailable     the row budget the host offers: the surface renders
//                     exactly its own content height (clamped by this)
//   principalLayout   derive the target with `canonicalWorktreePath`
//                     (default true) instead of `worktreePath`
//   git               lib/worktree-git.js seam
//   helpers/hostTui/theme   the host seams the other panels use
//   done              (value) => void, see above
//
// Keys: the preview ABOVE (branch, then path), then the `Branch` and `Odd` tabs
// of one field strip. `tab`/`shift+tab`/`←`/`→` move between the two fields (a
// horizontal key at either end wraps around), `↑`/`↓` pick from the active list,
// a printable character types the active field's own text (the branch name, or
// the new ODD), `enter` on Branch reaches Odd, `enter` on Odd creates (the ONE
// create key), `esc` cancels. There is no `?` key list: the footer names every
// shortcut on ONE row.

const gitLib = require('./worktree-git.js');
const createLib = require('./worktree-create.js');
const path = require('node:path');
// S11: the ONE palette the readers share decides which theme role paints each
// kind of token (key, title, description, count, label, value, border, error),
// so a footer KEY is always distinguishable from the words beside it and this
// panel keeps no second copy of the hostile-theme guards.
const palette = require('./tui-paint.js');

// The Conventional Commit change types of the repository's branch-pr
// convention (`<type>/<slug>`), with its human labels and in its order —
// the SAME set the wizard's type step publishes. `CHANGE_TYPES` is the
// panel's default; tests pin it against the extension's own list so a
// drift can never leave two conventions in the repository.
const CHANGE_TYPES = Object.freeze([
  { id: 'feat', label: 'Feature' },
  { id: 'fix', label: 'Bug fix' },
  { id: 'chore', label: 'Chore' },
  { id: 'docs', label: 'Docs' },
  { id: 'style', label: 'Style' },
  { id: 'refactor', label: 'Refactor' },
  { id: 'perf', label: 'Performance' },
  { id: 'test', label: 'Test' },
  { id: 'build', label: 'Build' },
  { id: 'ci', label: 'CI' },
  { id: 'revert', label: 'Revert' },
].map((type) => Object.freeze(type)));

// S2: the FIRST entry of the ODD list — the one entry that takes a typed name.
// Lowercase on purpose: it is the human's own word for it.
const NEW_ODD_LABEL = 'new odd';

// S2: the typed name's placeholder, rendered as GHOST text (dim, never a value:
// creating from a placeholder is refused). S8 uses the same ghost treatment for
// the branch name, so both typed rows read the same.
const ODD_PLACEHOLDER = 'odd-name';
const BRANCH_PLACEHOLDER = 'branch-name';

// S7: the branch the layout helpers are asked about when only the destination
// root is wanted. The root (`<principal>-worktrees`) never depends on it, so a
// fixed probe keeps the preview free of the branch's own spelling.
const DESTINATION_PROBE_BRANCH = 'worktree';

// S1/S2: the tab order. `tab`/`right` walk it forward, `shift+tab`/`left` back,
// and either end wraps — one rule for the strip and for the arrows. Branch comes
// first and Odd is the last field, the one whose `enter` creates.
const FIELD_ORDER = ['branch', 'odd'];

const PANEL_HEIGHT_MAX = 40;

// S12: the create surface's own fixed rows — top rule, title, branch preview,
// path preview, the `Branch · Odd` tab strip, the one-row legend, the bottom
// rule. The active field's region — its typed row plus the S7 blank separator —
// and then its inline list take whatever the host budget leaves.
const CREATE_FIXED_ROWS = 7;
// S7: the typed row and the blank separator that keeps the input region apart
// from the list under it.
const CREATE_REGION_ROWS = 2;

// S7: the placeholder an underivable preview shows. `-` is the same
// missing-value mark the viewers use, so a preview with nothing derivable yet
// reads as empty instead of broken — the reason for a failure belongs to the
// refused submit, never to the live preview.
const PREVIEW_EMPTY = '-';

// Raw terminal bytes per key id, mirroring pi-tui's legacy sequences so
// the panel stays drivable when the injected matcher is absent (a panel
// that ignores Esc/Enter reads as frozen).
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  'ctrl+s': ['\x13'],
  enter: ['\r', '\n'],
  return: ['\r', '\n'],
  tab: ['\t'],
  'shift+tab': ['\x1b[Z'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  delete: ['\x1b[3~', '\x7f'],
  '\x7f': ['\x7f'],
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
    // A throwing classifier never releases; fall through.
  }
  return false;
}

// One printable character, or '' for a control byte, an escape sequence
// or a key object. The typed-name rule (S6) needs exactly this distinction.
function printableChar(data) {
  const raw = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  if (typeof raw !== 'string') return '';
  const chars = [...raw];
  if (chars.length !== 1) return '';
  const char = chars[0];
  if (char < ' ' || char === '\x7f') return '';
  return char;
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x07\x1b]*\x07/g, '');
}

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
  const chars = [...stripAnsi(clean)];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : clean;
}

function pad(helpers, text, width) {
  const clipped = fit(helpers, text, width);
  return clipped + ' '.repeat(Math.max(0, width - measure(helpers, clipped)));
}

// S2: a key legend stays on ONE row, and S11 decides its colours: `key` is the
// exact key spelling the token starts with, so lib/tui-paint.js paints that
// prefix with the key role (accent+bold) and the rest as its description. The
// compact spelling keeps the same prefix wherever it can, so a key never loses
// its role when the row compacts. `text` is the full token, `short` the compact
// one used when the full form does not fit, and `priority` decides what a
// still-too-wide legend drops first (the lowest goes first, so the cancel key
// outlives the rest).
// S12: `↑/↓` picks from the active list — the types' or the ODDs' — and typing
// fills the active field's own name, so the legend names both; the ONE confirm
// key is `enter`.
const CREATE_KEYS = [
  { text: 'type to name', short: 'type', priority: 50 },
  { key: 'tab/←/→', text: 'tab/←/→ fields', short: 'tab/←/→', priority: 70 },
  { key: '↑/↓', text: '↑/↓ pick', short: '↑/↓', priority: 60 },
  { key: 'Enter', text: 'Enter confirm', short: 'Enter confirm', priority: 90 },
  { key: 'Esc', text: 'Esc cancel', short: 'Esc cancel', priority: 100 },
];

function shortError(err) {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err.split('\n')[0];
  if (err.code === 'ENOENT' || /ENOENT/i.test(String((err && err.message) || err))) return 'not available';
  return String((err && err.message) || err).split('\n')[0];
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// S2: the offered ODDs are names, not rows: strings only, no blanks, no
// duplicates, sorted ascending — so the list is the same on every render and on
// every host, whatever order the caller read them in.
function normalizeOddOptions(value) {
  if (!Array.isArray(value)) return [];
  const names = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
  return [...new Set(names)].sort();
}

// S5: the checkouts that already exist, as resolved absolute paths. The caller
// reconciles them (git's live listing plus the registry rows whose directory
// still exists), so a stale row for a removed checkout is not one of them and an
// ODD that became free again is offered again. Anything unusable is dropped:
// this list only ever HIDES a duplicate, and the create refuses a collision on
// its own.
function normalizeOccupiedPaths(value) {
  const out = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string' || entry === '') continue;
    try {
      out.add(path.resolve(entry));
    } catch {
      // An unresolvable spelling names no checkout.
    }
  }
  return [...out];
}

// S2: the create wizard's ODD list — the ODDs that exist in `main`. The ref is
// named explicitly instead of resolved through `origin/HEAD`, because the list a
// human picks from must be the base the create starts from: the local `main`.
const MAIN_REF = 'refs/heads/main';
const ODD_TASKS_DIR = 'odd/tasks';
const ODD_DOCUMENT_EXTENSION = '.md';
const MAIN_ODD_TASKS_ARGS = ['ls-tree', '-r', '--name-only', '-z', MAIN_REF, '--', ODD_TASKS_DIR];

/**
 * S2/S4: the ODD names `main` carries, sorted ascending and without duplicates.
 *
 * `opts.runAsync` is the package convention `(bin, argv, cwd) => Promise<{
 * status, stdout, stderr, error}>`, and `opts.cwd` is any directory of the clone
 * the read runs in. Nothing here is fatal: an absent `odd/tasks` directory, a
 * clone without `main`, a failing child, a runner that throws or no runner at all
 * is an empty list — the picker still opens with its `new odd` entry, which is why
 * an unreadable list is never an error.
 *
 * The read is ONE bounded child, and it is AWAITED by the caller before the panel
 * mounts: the panel itself never spawns, on a render or on a keystroke.
 */
async function listMainOddTasks(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const runAsync = typeof opts.runAsync === 'function' ? opts.runAsync : null;
  if (runAsync === null) return [];
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  let answer;
  try {
    answer = await runAsync('git', MAIN_ODD_TASKS_ARGS.slice(), cwd);
  } catch {
    return [];
  }
  if (!answer || answer.status !== 0 || typeof answer.stdout !== 'string') return [];
  const names = new Set();
  for (const entry of answer.stdout.split('\0')) {
    if (!entry.startsWith(`${ODD_TASKS_DIR}/`)) continue;
    const name = entry.slice(ODD_TASKS_DIR.length + 1);
    // One path segment directly under odd/tasks, never a nested tree entry, a
    // dotfile or a file that is not a document.
    if (name === '' || name.includes('/') || name.includes('\\') || name.startsWith('.')) continue;
    if (!name.toLowerCase().endsWith(ODD_DOCUMENT_EXTENSION)) continue;
    names.add(name.slice(0, -ODD_DOCUMENT_EXTENSION.length));
  }
  return [...names].sort();
}

// The window one inline list shows around its cursor: `size` rows starting at
// `start`, centred on the selection while it can be and clamped to the edges
// after that, so the focused row is always on screen.
function listWindow(count, index, size) {
  if (size <= 0) return { start: 0, size: 0 };
  const width = Math.min(count, size);
  const centred = index - Math.floor(width / 2);
  return { start: Math.min(Math.max(0, centred), Math.max(0, count - width)), size: width };
}

function createWarpCreatePanel(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  const helpers = opts.helpers || null;
  const hostTui = opts.hostTui || null;
  const theme = opts.theme || null;
  const git = opts.git && typeof opts.git === 'object' ? opts.git : gitLib;
  const principalLayout = opts.principalLayout !== false;
  const changeTypes = Array.isArray(opts.changeTypes) && opts.changeTypes.length > 0
    ? opts.changeTypes.filter((type) => type && typeof type.id === 'string' && type.id !== '')
    : CHANGE_TYPES.slice();
  const oddPlaceholder = typeof opts.oddPlaceholder === 'string' && opts.oddPlaceholder !== ''
    ? opts.oddPlaceholder
    : ODD_PLACEHOLDER;
  const branchPlaceholder = typeof opts.branchPlaceholder === 'string' && opts.branchPlaceholder !== ''
    ? opts.branchPlaceholder
    : BRANCH_PLACEHOLDER;
  // S2: the ODDs that exist in `main`, read by the caller that can await the
  // one bounded child (the panel never spawns on a render or a keystroke).
  const oddCandidates = normalizeOddOptions(opts.oddOptions);
  // S5: the checkouts that already exist, already reconciled by the caller.
  const occupiedPaths = normalizeOccupiedPaths(opts.occupiedPaths);
  const rawFinish = typeof opts.done === 'function' ? opts.done : () => {};

  // The branch format is the repository's own: `<type-of-the-list>/<slug>`,
  // derived from the SAME type list the field offers (never a second list).
  const branchFormat = new RegExp(`^(${changeTypes.map((type) => escapeRe(type.id)).join('|')})/[a-z0-9._-]+$`);

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    rawFinish(value);
  };

  // S5: memoized once per mount — see `oddOptions()` below. Declared here so the
  // `initialOdd` restore below can read the offered list safely.
  let offeredOdds;

  const state = {
    // S6: `feat` is the first entry of the repository's type list, so index 0 IS
    // the default and an untouched form already previews `feat/`. The type is
    // picked from the inline list, so `typeIndex` IS the selection (there is no
    // second cursor to keep in sync).
    typeIndex: 0,
    // S1: the name half of `<type>/<name>` — the Branch field's free text, typed
    // and passed through unchanged.
    branchName: '',
    // S2: `oddIndex` 0 is the `new odd` entry, `1..n` are the offered ODDs.
    oddIndex: 0,
    // The typed ODD of the `new odd` entry; the Odd field's free text.
    newOdd: '',
    focus: 'branch',
    message: '',
  };
  if (typeof opts.initialType === 'string') {
    const at = changeTypes.findIndex((type) => type.id === opts.initialType);
    if (at >= 0) state.typeIndex = at;
  }
  if (typeof opts.initialOdd === 'string' && opts.initialOdd !== '') {
    const at = oddOptions().indexOf(opts.initialOdd);
    // A known ODD selects its row; an unknown one is the new-ODD entry, so a
    // caller can prefill a name that does not exist yet.
    if (at >= 0) state.oddIndex = at + 1;
    else state.newOdd = opts.initialOdd;
  }

  // One derivation per distinct (type, ODD), memoized, so a repaint of an
  // unchanged form derives nothing.
  let deriveCache = { key: null, value: null };

  // The repository identity behind the canonical layout costs two
  // `git rev-parse` probes and cannot change while this panel is open, so it is
  // read at most once instead of once per keystroke. `undefined` means NOT READ
  // YET; `null` means unreadable, and the layout helper then reads it itself
  // (the same fallback as a seam that has no `repoIdentity`).
  let identityCache;

  let cursorMarker = '';
  try {
    if (helpers && typeof helpers.CURSOR_MARKER === 'string') cursorMarker = helpers.CURSOR_MARKER;
  } catch {
    cursorMarker = '';
  }
  if (cursorMarker === '') {
    try {
      const tui = require('@earendil-works/pi-tui');
      if (tui && typeof tui.CURSOR_MARKER === 'string') cursorMarker = tui.CURSOR_MARKER;
    } catch {
      cursorMarker = '';
    }
  }

  function availableRows() {
    try {
      if (typeof opts.rowsAvailable === 'function') {
        const size = Math.floor(opts.rowsAvailable());
        if (Number.isFinite(size) && size > 0) return Math.min(PANEL_HEIGHT_MAX, size);
      }
    } catch {
      // A hostile rows source never breaks the panel.
    }
    return 24;
  }

  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  // S11: one role decision for the whole surface. The role table lives in
  // lib/tui-paint.js, so this panel names KINDS (title, key, label, value,
  // count, description, border, error) instead of colours, and a missing,
  // partial or throwing theme degrades to plain text inside the palette. A
  // `null` kind is plain text.
  function kindText(kind, text) {
    const painter = palette[kind];
    if (typeof painter === 'function') return painter(theme, text);
    const role = palette.ROLES[kind];
    return typeof role === 'string' ? palette.paint(theme, role, text) : String(text);
  }

  // A composed line of kind-tagged segments, painted only AFTER the plain text
  // has been fitted to the width: painting first would let the fallback
  // truncation cut through an escape sequence. Overlong content therefore falls
  // back to an uncoloured, honestly truncated line instead of a broken one.
  function composed(segments, width) {
    const plain = segments.map((segment) => segment.text).join('');
    if (measure(helpers, plain) > width) return fit(helpers, plain, width);
    return segments.map((segment) => kindText(segment.kind, segment.text)).join('');
  }

  function currentType() {
    return changeTypes[state.typeIndex] || changeTypes[0];
  }

  function repoIdentity() {
    if (identityCache !== undefined) return identityCache;
    identityCache = null;
    try {
      if (typeof git.repoIdentity === 'function') identityCache = git.repoIdentity(cwd) || null;
    } catch {
      identityCache = null;
    }
    return identityCache;
  }

  // The destination ROOT the create lays its checkouts in: `<principal>-worktrees`
  // beside the PRINCIPAL checkout under `principalLayout` (the default), the calling
  // checkout's own layout otherwise — exactly what the create path resolves. Only the
  // root is derived here; the DIRECTORY name is the ODD (S7), so the branch's own
  // spelling never reaches the preview.
  function destinationRoot() {
    const identity = repoIdentity();
    let target;
    if (principalLayout) {
      if (identity && typeof git.canonicalWorktreePathOf === 'function') target = git.canonicalWorktreePathOf(identity, DESTINATION_PROBE_BRANCH);
      else if (typeof git.canonicalWorktreePath === 'function') target = git.canonicalWorktreePath(cwd, DESTINATION_PROBE_BRANCH);
    } else if (identity && typeof git.worktreePathOf === 'function') {
      target = git.worktreePathOf(identity, DESTINATION_PROBE_BRANCH);
    }
    if (typeof target !== 'string' || target === '') target = git.worktreePath(cwd, DESTINATION_PROBE_BRANCH);
    // The layout helper answers `<root>/<slug of the branch>`, so its directory IS
    // the root the ODD completes into — the one function the create derives it from.
    return path.dirname(target);
  }

  // S7: `<root>/<odd>`, and nothing else: the root IS the `<repo-name>-worktrees`
  // directory `worktreeDestinationPath` lays a name in, so completing it with the ODD
  // is the same path the create makes, and the "one path segment" rule that guards
  // it is the core's own `isWorktreeSegment`.
  function destinationPathOf(root, odd) {
    return odd === '' ? root : path.join(root, odd);
  }

  // S5: the offered ODDs — `main`'s documents minus the ones whose destination a
  // checkout already occupies. Both inputs are fixed for the panel's lifetime and
  // the root is memoized, so this is computed ONCE per mount and a frame stays
  // free of work. A root that cannot be derived filters NOTHING: the create still
  // refuses the collision with its own sentence, and hiding every ODD because one
  // probe failed would be worse than showing a choice the create refuses.
  function oddOptions() {
    if (offeredOdds !== undefined) return offeredOdds;
    if (occupiedPaths.length === 0) {
      offeredOdds = oddCandidates;
      return offeredOdds;
    }
    let root = null;
    try {
      root = destinationRoot();
    } catch {
      root = null;
    }
    if (typeof root !== 'string' || root === '') {
      offeredOdds = oddCandidates;
      return offeredOdds;
    }
    const taken = new Set(occupiedPaths);
    offeredOdds = oddCandidates.filter((odd) => {
      try {
        return !taken.has(path.resolve(root, odd));
      } catch {
        return true;
      }
    });
    return offeredOdds;
  }

  // The ODD the form currently answers: the picked document, or the typed name of
  // the `new odd` entry. Trimmed here so every reader (preview, submit) sees the
  // same value the create will receive.
  function selectedOdd() {
    if (state.oddIndex === 0) return state.newOdd.trim();
    return (oddOptions()[state.oddIndex - 1] || '').trim();
  }

  // The live derivation, memoized per distinct (type, name, ODD) and FREE of
  // subprocesses: the branch format the repository publishes, the destination
  // root and the ODD rule are all pure, so painting a keystroke asks git for
  // nothing. Only the plain rejections run here; git's own verdict belongs to the
  // create path, which can await it.
  function derivePreview() {
    const type = currentType();
    const name = state.branchName.trim();
    const odd = selectedOdd();
    const key = `${type.id}\u0000${name}\u0000${odd}`;
    if (deriveCache.key === key) return deriveCache.value;

    // ---- the branch: `<type>/<name>`, the human's own answer (S1), passed
    // through unchanged. An empty name still previews the type's prefix
    // (`branchOk` is what the ROW paints), but it is not submittable, so `ok`
    // stays false: display and validity are two different questions and this is
    // where they part. Nothing derives the name from the ODD — the branch names
    // no directory (R1).
    let branch = null;
    let branchOk = false;
    let branchReason = null;
    if (name === '') {
      branch = `${type.id}/`;
      branchOk = true;
      branchReason = 'branch name is empty';
    } else if (!branchFormat.test(`${type.id}/${name}`)) {
      branchReason = `invalid branch name: ${type.id}/${name}`;
    } else {
      branch = `${type.id}/${name}`;
      branchOk = true;
    }

    // ---- the path: the ODD names it (S7), so the ODD is what completes it. The
    // root alone is what an empty ODD previews; the create always writes one, so
    // an empty ODD stays unsubmittable and is refused with its own words.
    let root = null;
    let rootFailure = null;
    try {
      root = destinationRoot();
    } catch (err) {
      rootFailure = shortError(err);
    }
    const rootOk = typeof root === 'string' && root !== '' && rootFailure === null;
    const oddValid = createLib.isWorktreeSegment(odd);
    const oddReason = odd === ''
      ? 'odd is empty'
      : (oddValid ? null : `invalid odd name: ${JSON.stringify(odd)}`);
    const pathOk = rootOk && (odd === '' || oddValid);

    const value = {
      ok: branchReason === null && oddReason === null && rootOk,
      branch,
      branchOk,
      path: pathOk ? destinationPathOf(root, odd) : null,
      pathOk,
      reason: branchReason
        ?? oddReason
        ?? (rootOk ? null : `cannot resolve the worktree path: ${rootFailure || 'unknown error'}`),
    };
    deriveCache = { key, value };
    return value;
  }

  // S8/S9: ONE typed-row design, used by BOTH typed fields — the branch name and
  // the `new odd` name. It is the `❯` prompt, the field's own static label, the
  // derived PREFIX the field composes (`feat/`), the typed value, and the caret:
  // with the ghost placeholder while the value is empty, after the typed value
  // otherwise. Every token takes a palette ROLE, so no colour is named here and
  // the prompt + caret still say "type here" on a monochrome terminal.
  function typedRow(width, { label, prefix, value, placeholder }) {
    const caret = { kind: null, text: `${cursorMarker}▊` };
    const segments = [{ kind: 'accent', text: '❯ ' }];
    if (label !== '') segments.push({ kind: 'label', text: label });
    if (prefix !== '') segments.push({ kind: 'label', text: prefix });
    if (value === '') segments.push(caret, { kind: 'description', text: placeholder });
    else segments.push({ kind: 'value', text: value }, caret);
    return composed(segments, width);
  }

  // S1/S2: the two fields are TABS, not stacked rows — one strip with the active
  // label accented (and bold) and the other dimmed, so "where am I" reads the
  // same everywhere. There is no third tab: the Branch (<type>/<name>) and the Odd
  // (the directory) are the two things a create asks for.
  function tabSegments() {
    const tab = (field, text) => ({ kind: state.focus === field ? 'title' : 'label', text });
    return [tab('branch', 'Branch'), { kind: null, text: ' · ' }, tab('odd', 'Odd')];
  }

  function rule(width) {
    return kindText('border', '─'.repeat(Math.max(0, width)));
  }

  // S12: the inline change-type list. The SELECTED type (and therefore the
  // preview) follows the cursor, and the list is windowed around it when the
  // host offers fewer rows than the convention has types. The `❯` marker is
  // the same one the ODD list uses, so "where am I" reads the same everywhere.
  function typeListLines(width, room) {
    const { start, size } = listWindow(changeTypes.length, state.typeIndex, room);
    const out = [];
    for (let offset = 0; offset < size; offset += 1) {
      const at = start + offset;
      const type = changeTypes[at];
      const text = `${at === state.typeIndex ? '❯ ' : '  '}${type.label} (${type.id})`;
      const fitted = fit(helpers, text, width);
      out.push(at === state.typeIndex ? palette.highlight(theme, fitted, true) : fitted);
    }
    return out;
  }

  // S7/S8: the Branch field is TWO REGIONS — the typed name row on top (S6), a
  // blank separator, then the eleven types as plain rows. The blank row is the
  // separation the report asked for: it survives monochrome, and it keeps the
  // typed name from reading as the list's first entry.
  function branchFieldLines(width, room) {
    const type = currentType();
    const listRoom = Math.max(1, room - CREATE_REGION_ROWS);
    return [
      typedRow(width, {
        label: '',
        prefix: `${type.id}/`,
        value: state.branchName,
        placeholder: branchPlaceholder,
      }),
      '',
      ...typeListLines(width, listRoom),
    ];
  }

  // S7/S8: the Odd field is TWO REGIONS as well. `new odd` is the FIRST row and
  // the only entry that takes a typed name, so while it is the focused row it IS
  // the shared typed row — same design, same caret, the typed text in place — and
  // the documents stand alone under the blank separator. While a DOCUMENT is
  // focused there is no input under the list: `new odd` stays a plain row in its
  // place and the documents below are the list. Nothing is echoed anywhere.
  function oddFieldLines(width, room) {
    const typing = state.oddIndex === 0;
    const listRoom = Math.max(1, room - CREATE_REGION_ROWS);
    const head = typing
      ? typedRow(width, {
        label: `${NEW_ODD_LABEL}: `,
        prefix: '',
        value: state.newOdd,
        placeholder: oddPlaceholder,
      })
      : composed([{ kind: null, text: `  ${NEW_ODD_LABEL}` }], width);
    return [head, '', ...oddListLines(width, listRoom)];
  }

  // S2/S8/S10: the ODD list. The rows are the DOCUMENTS alone — `new odd` is the
  // input row above the separator, never a document — and the `❯`-marked row is
  // the answer. There is no separate echo row of the picked value.
  function oddListLines(width, room) {
    const options = oddOptions();
    const selected = state.oddIndex - 1;
    const { start, size } = listWindow(options.length, Math.max(0, selected), room);
    const out = [];
    for (let offset = 0; offset < size; offset += 1) {
      const at = start + offset;
      const focused = at === selected;
      const text = `${focused ? '❯ ' : '  '}${options[at]}`;
      const fitted = fit(helpers, text, width);
      out.push(focused ? palette.highlight(theme, fitted, true) : fitted);
    }
    return out;
  }

  // S12: the create surface is COMPACT — it renders exactly its own content
  // and never pads out to the host's row budget, so the host can mount it at
  // the bottom of the terminal without slack rows above or below it. S7: the
  // preview sits ABOVE the tab strip, only the ACTIVE field's region (its typed
  // row, the blank separator, its list) renders under it, and an underivable
  // preview stays blank instead of red.
  function renderCreate(w, maxRows) {
    const messageRows = state.message ? 1 : 0;
    if (maxRows < CREATE_FIXED_ROWS + CREATE_REGION_ROWS + messageRows) {
      return [pad(helpers, kindText('label', 'New worktree — enlarge the terminal'), w)];
    }
    const derived = derivePreview();
    const room = Math.max(CREATE_REGION_ROWS + 1, maxRows - CREATE_FIXED_ROWS - messageRows);
    const lines = [
      rule(w),
      composed([{ kind: 'title', text: 'New worktree' }], w),
      composed([
        { kind: 'label', text: 'preview branch: ' },
        derived.branchOk ? { kind: 'value', text: derived.branch } : { kind: 'label', text: PREVIEW_EMPTY },
      ], w),
      composed([
        { kind: 'label', text: 'preview path: ' },
        derived.pathOk ? { kind: 'value', text: derived.path } : { kind: 'label', text: PREVIEW_EMPTY },
      ], w),
      composed(tabSegments(), w),
    ];
    if (state.focus === 'branch') lines.push(...branchFieldLines(w, room));
    else lines.push(...oddFieldLines(w, room));
    if (state.message) lines.push(composed([{ kind: 'error', text: `cannot create: ${state.message}` }], w));
    lines.push(palette.legendRow(theme, CREATE_KEYS, w, (text) => measure(helpers, text)));
    lines.push(rule(w));
    return lines.map((line) => pad(helpers, line, w));
  }

  function render(width) {
    const w = Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    return renderCreate(w, height);
  }

  // S1: the submit key does not validate either — a `check-ref-format` child
  // here would freeze the host on the confirmation keystroke. The branch check
  // is the create path's (`validateBranchAsync`, awaited on the async runner),
  // which refuses with its own message and creates nothing.
  function create() {
    const derived = derivePreview();
    if (!derived.ok) {
      state.message = derived.reason;
      requestPaint();
      return;
    }
    // S1/S4: a creation carries the branch EXACTLY as composed — created when it
    // is absent, adopted when it exists — and the ODD that names the directory.
    // No `name` (the ODD is the identity) and no `issues` (a brand-new row is
    // born without an issue association).
    finish({ ok: true, branch: derived.branch, odd: selectedOdd() });
  }

  function moveType(delta) {
    const last = Math.max(0, changeTypes.length - 1);
    state.typeIndex = Math.min(last, Math.max(0, state.typeIndex + delta));
    state.message = '';
    requestPaint();
  }

  function moveOdd(delta) {
    const last = oddOptions().length;
    state.oddIndex = Math.min(last, Math.max(0, state.oddIndex + delta));
    state.message = '';
    requestPaint();
  }

  // S1/S6/S8: the Branch field is a typed name OVER a list, so the same split the
  // Odd field uses applies here: `↑`/`↓` choose the type, every printable
  // character types the name, and Backspace edits it. Nothing is repurposed — a
  // keystroke meant for the name never jumps fields.
  function handleBranchField(data) {
    if (keyText(helpers, data, ['up'])) {
      moveType(-1);
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveType(1);
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      state.focus = 'odd';
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.branchName !== '') {
        state.branchName = [...state.branchName].slice(0, -1).join('');
        state.message = '';
        requestPaint();
      }
      return;
    }
    if (keyText(helpers, data, ['pageup', 'pagedown'])) return;
    const char = printableChar(data);
    if (char !== '') {
      state.branchName += char;
      state.message = '';
      requestPaint();
    }
  }

  // S1/S2: only two fields exist while creating (Branch, then Odd), so `tab`,
  // `shift+tab` and both horizontal arrows walk them; a horizontal key at either
  // end wraps to the other end instead of dying.
  function stepCreateField(delta) {
    const at = FIELD_ORDER.indexOf(state.focus);
    const next = (Math.max(0, at) + delta + FIELD_ORDER.length) % FIELD_ORDER.length;
    state.focus = FIELD_ORDER[next];
    requestPaint();
  }

  // S2: the ODD field is a LIST with one typed entry. `↑`/`↓` move the cursor
  // through `new odd` and the documents, `enter` creates (the ODD is the LAST
  // field), and editing keys belong to the typed entry alone — a document row
  // has nothing to edit, so a stray keystroke cannot silently rename it.
  function handleOddField(data) {
    if (keyText(helpers, data, ['enter', 'return'])) {
      create();
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveOdd(1);
      return;
    }
    if (keyText(helpers, data, ['up'])) {
      moveOdd(-1);
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.oddIndex === 0 && state.newOdd !== '') {
        state.newOdd = [...state.newOdd].slice(0, -1).join('');
        state.message = '';
        requestPaint();
      }
      return;
    }
    if (keyText(helpers, data, ['pageup', 'pagedown'])) return;
    const char = printableChar(data);
    if (char !== '') {
      if (state.oddIndex !== 0) return;
      state.newOdd += char;
      state.message = '';
      requestPaint();
    }
  }

  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    // Esc cancels the interaction (the surface has no inner layer any more).
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      finish(null);
      return;
    }
    // `tab`, `shift+tab` and the horizontal arrows move between the two fields,
    // which is what the reported flow asked for (S12).
    if (keyText(helpers, data, ['tab', 'right'])) {
      stepCreateField(1);
      return;
    }
    if (keyText(helpers, data, ['shift+tab', 'left'])) {
      stepCreateField(-1);
      return;
    }
    if (state.focus === 'odd') {
      handleOddField(data);
      return;
    }
    handleBranchField(data);
  }

  // The panel caches nothing between frames (every line is derived from the two
  // fields), so a repaint request has nothing to drop; the host seam still
  // exists because the component contract asks for it.
  function invalidate() {}

  return { render, handleInput, invalidate, state };
}

module.exports = {
  CHANGE_TYPES,
  listMainOddTasks,
  createWarpCreatePanel,
};

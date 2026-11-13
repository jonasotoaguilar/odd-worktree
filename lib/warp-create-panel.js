'use strict';
// The worktree CREATION panel (warp-odd-picker S1,S2; worktree-ui-feedback S4,S12,S15).
//
// It is the TABBED bottom flow a human creates with (S7): a live branch/path
// preview ABOVE, then the change type and the ODD as the TWO TABS of one strip
// (`Type · Odd`, with only the ACTIVE field's content under it). The Type tab
// holds the change type as an inline LIST and the Odd tab holds the ODD as an
// inline LIST too (there is no native dropdown in this host, and no second
// pop-up surface).
//
// S1: there is no `Name` field. The checkout's directory IS the ODD, so a second
// identity would be the same fact asked twice; the branch is only the git branch
// and is derived from the two things the form does ask for
// (`<type>/<slug of the ODD>`). S2: the ODD is CHOSEN, not typed from nothing —
// the list is the ODDs that exist in `main` (`lib/warp-create-picker.js`
// `listMainOddTasks`, injected as `oddOptions` by the caller that can await the
// read), with `new odd` as the FIRST entry; that entry, and only that entry,
// takes a typed name.
//
// S3: the panel shows each fact ONCE. The active field's own row never echoes the
// value the list row already shows (the reported stray `Odd: dagea` line was that
// leftover echo), so the picked the ODD is the `❯` list row and the typed ODD is
// the one `new odd:` row.
//
// The preview shows the selected type's own prefix as soon as the form opens
// (`feat/` and the worktree root `…-worktrees/`) and completes as the ODD is
// picked or typed: an incomplete form is not an error, so nothing in the preview
// is painted red or names a failure, while a refused submit still says exactly
// why. `tab`, `shift+tab`, `←` and `→` move between the two tabs; `↑`/`↓` pick
// from the active list; `enter` on the ODD creates (S12 keeps ONE create key —
// the duplicate `ctrl+s` was dropped and is not a binding).
//
// Everything the panel does NOT do is as important: it creates no file, writes
// nothing and registers nothing. A chosen ODD that already has a document creates
// no document, and the document of a new ODD is left to the agent that starts
// work on it — nothing in this package anticipates that, waits for it or reports
// it. `done({ ok: true, type, odd })` is the whole output.
//
// Pure Node, no package imports. The repository's own helpers do the work
// instead of a second implementation of the same convention: the ported
// `lib/worktree-create.js` `isWorktreeSegment` decides what an ODD may say, so
// the preview and the create refuse the same values with the same words, and
// `lib/worktree-git.js` `slugifyBranch` / `canonicalWorktreePathOf` (or
// `canonicalWorktreePath` / `worktreePath`) over its memoized `repoIdentity` give
// the parent directory the create lays the ODD in. The git seam is injectable
// (`git`), so tests never touch a real checkout.
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
//   done({ ok: true, type, odd })
// on `enter` in the last field (the ODD), and
// `done(null)` on `esc` (cancel). `type` is the conventional change-type id
// (`feat`, `fix`, …) and `odd` is the trimmed ODD that names the checkout's
// directory. A completion NEVER carries `name` and NEVER carries `issues`: the
// ODD is the only identity and a new row is born without an issue association,
// and there is no other completion shape. A completion fires EXACTLY once. An
// invalid branch/path/ODD refuses creation (nothing is emitted) and the reason
// stays on screen.
//
// Options (every one optional; the seams exist so tests own the world):
//   cwd               checkout the panel derives the path from
//                     (default: process.cwd())
//   changeTypes       `[{id,label}]`; default exports CHANGE_TYPES, the
//                     repository's branch-pr convention
//   oddOptions        the ODDs to offer, already read from `main` (default: an
//                     empty list, which still offers `new odd`)
//   oddPlaceholder    ghost hint of the new-ODD field (default ODD_PLACEHOLDER)
//   initialOdd        select this ODD when it is in the list, else prefill the
//                     new-ODD field with it
//   initialType       pre-selected change-type id
//   rowsAvailable     the row budget the host offers: the surface renders
//                     exactly its own content height (clamped by this)
//   principalLayout   derive the target with `canonicalWorktreePath`
//                     (default true) instead of `worktreePath`
//   git               lib/worktree-git.js seam
//   helpers/hostTui/theme   the host seams the other panels use
//   done              (value) => void, see above
//
// Keys: the preview ABOVE (branch, then path), then the `Type` and `Odd` tabs of
// one field strip. `tab`/`shift+tab`/`←`/`→` move between the two fields (a
// horizontal key at either end wraps around), `↑`/`↓` pick from the active list,
// a printable character on Type starts a new ODD (so nobody types into a list),
// `enter` on Type reaches Odd, `enter` on Odd creates (the ONE create key), `esc`
// cancels. There is no `?` key list: the footer names every shortcut on ONE row.

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
// creating from a placeholder is refused).
const ODD_PLACEHOLDER = 'odd-name';

// S7: the branch the layout helpers are asked about when only the destination
// root is wanted. The root (`<principal>-worktrees`) never depends on it, so a
// fixed probe keeps the preview free of the branch's own spelling.
const DESTINATION_PROBE_BRANCH = 'worktree';

// S1/S2: the tab order. `tab`/`right` walk it forward, `shift+tab`/`left` back,
// and either end wraps — one rule for the strip and for the arrows.
const FIELD_ORDER = ['type', 'odd'];

const PANEL_HEIGHT_MAX = 40;

// S12: the create surface's own fixed rows — top rule, title, branch preview,
// path preview, the `Type · Odd` tab strip, the one-row legend, the bottom rule.
// The active tab's inline list takes whatever the host budget leaves.
const CREATE_FIXED_ROWS = 7;

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
// S12: `↑/↓` picks from the active list — the type's or the ODD's — so the
// legend says "pick", never "type", and the ONE confirm key is `enter`.
const CREATE_KEYS = [
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
  // S2: the ODDs that exist in `main`, read by the caller that can await the
  // one bounded child (the panel never spawns on a render or a keystroke).
  const oddOptions = normalizeOddOptions(opts.oddOptions);
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

  const state = {
    // S12: the type is picked from the inline list, so `typeIndex` IS the
    // selection (there is no second cursor to keep in sync).
    typeIndex: 0,
    // S2: `oddIndex` 0 is the `new odd` entry, `1..n` are `oddOptions` in order.
    oddIndex: 0,
    // The typed ODD of the `new odd` entry; the only free text the form holds.
    newOdd: '',
    focus: 'type',
    message: '',
  };
  if (typeof opts.initialType === 'string') {
    const at = changeTypes.findIndex((type) => type.id === opts.initialType);
    if (at >= 0) state.typeIndex = at;
  }
  if (typeof opts.initialOdd === 'string' && opts.initialOdd !== '') {
    const at = oddOptions.indexOf(opts.initialOdd);
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

  // The ODD the form currently answers: the picked document, or the typed name of
  // the `new odd` entry. Trimmed here so every reader (preview, submit) sees the
  // same value the create will receive.
  function selectedOdd() {
    if (state.oddIndex === 0) return state.newOdd.trim();
    return (oddOptions[state.oddIndex - 1] || '').trim();
  }

  // The live derivation, memoized per distinct (type, ODD) and FREE of
  // subprocesses: the slug convention, the branch format the repository
  // publishes, the destination root and the ODD rule are all pure, so painting a
  // keystroke asks git for nothing. Only the plain rejections run here; git's own
  // verdict belongs to the create path, which can await it.
  function derivePreview() {
    const type = currentType();
    const odd = selectedOdd();
    const key = `${type.id}\u0000${odd}`;
    if (deriveCache.key === key) return deriveCache.value;

    // ---- the branch: `<type>/<slug of the ODD>` (S1: the ODD is the only
    // identity, so nothing else could name it). An empty ODD still previews the
    // type's prefix (`branchOk` is what the ROW paints), but it is not
    // submittable, so `ok` stays false: display and validity are two different
    // questions and this is where they part.
    let branch = null;
    let branchOk = false;
    let branchReason = null;
    if (odd === '') {
      branch = `${type.id}/`;
      branchOk = true;
      branchReason = 'odd is empty';
    } else if (!/[a-z0-9]/i.test(odd)) {
      branchReason = 'odd has no letters or digits';
    } else {
      let slug = '';
      try {
        slug = String(typeof git.slugifyBranch === 'function' ? git.slugifyBranch(odd) : '');
      } catch {
        slug = '';
      }
      const candidate = slug === '' ? '' : `${type.id}/${slug}`;
      if (candidate === '' || !branchFormat.test(candidate)) {
        branchReason = `invalid branch name: ${candidate === '' ? odd : candidate}`;
      } else {
        branch = candidate;
        branchOk = true;
      }
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

  // S2/S3: the ONE text row of the `new odd` entry — ghost placeholder while it
  // is empty, the typed value with the caret while it is not. It renders only
  // when that entry is the focused one, so the caret is the typing position
  // exactly when it is on screen, and no other entry ever gets an echo row.
  function newOddLine(width) {
    const caret = { kind: null, text: `${cursorMarker}▊` };
    const segments = [{ kind: 'label', text: `${NEW_ODD_LABEL}: ` }];
    if (state.newOdd === '') segments.push(caret, { kind: 'label', text: oddPlaceholder });
    else segments.push({ kind: 'value', text: state.newOdd }, caret);
    return composed(segments, width);
  }

  // S1/S3: the two fields are TABS, not stacked rows — one strip with the active
  // label accented (and bold) and the other dimmed, so "where am I" reads the
  // same everywhere. There is no third tab: the ODD is the name.
  function tabSegments() {
    const tab = (field, text) => ({ kind: state.focus === field ? 'title' : 'label', text });
    return [tab('type', 'Type'), { kind: null, text: ' · ' }, tab('odd', 'Odd')];
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

  // S2/S3: the ODD list. `new odd` is the FIRST row and the `❯`-marked row is
  // the answer — there is no separate echo row of the picked value, which is the
  // stray `Odd:` line the human reported.
  function oddListLines(width, room) {
    const count = oddOptions.length + 1;
    const { start, size } = listWindow(count, state.oddIndex, room);
    const out = [];
    for (let offset = 0; offset < size; offset += 1) {
      const at = start + offset;
      const label = at === 0 ? NEW_ODD_LABEL : oddOptions[at - 1];
      const text = `${at === state.oddIndex ? '❯ ' : '  '}${label}`;
      const fitted = fit(helpers, text, width);
      out.push(at === state.oddIndex ? palette.highlight(theme, fitted, true) : fitted);
    }
    return out;
  }

  // S12: the create surface is COMPACT — it renders exactly its own content
  // and never pads out to the host's row budget, so the host can mount it at
  // the bottom of the terminal without slack rows above or below it. S7: the
  // preview sits ABOVE the tab strip, only the ACTIVE tab's content renders
  // under it, and an underivable preview stays blank instead of red.
  function renderCreate(w, maxRows) {
    const messageRows = state.message ? 1 : 0;
    if (maxRows < CREATE_FIXED_ROWS + messageRows) {
      return [pad(helpers, kindText('label', 'New worktree — enlarge the terminal'), w)];
    }
    const derived = derivePreview();
    const room = Math.max(1, maxRows - CREATE_FIXED_ROWS - messageRows);
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
    if (state.focus === 'type') {
      lines.push(...typeListLines(w, room));
    } else {
      // The typed row of the `new odd` entry is one more fixed row, so the list
      // gives up a row for it instead of pushing the legend out.
      const typing = state.oddIndex === 0;
      lines.push(...oddListLines(w, typing ? Math.max(1, room - 1) : room));
      if (typing) lines.push(newOddLine(w));
    }
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
    // S2: a creation carries the two things it asked for and nothing else. No
    // `name` (the ODD is the identity) and no `issues` (a brand-new row is born
    // without an issue association).
    finish({ ok: true, type: currentType().id, odd: selectedOdd() });
  }

  function moveType(delta) {
    const last = Math.max(0, changeTypes.length - 1);
    state.typeIndex = Math.min(last, Math.max(0, state.typeIndex + delta));
    state.message = '';
    requestPaint();
  }

  function moveOdd(delta) {
    const last = oddOptions.length;
    state.oddIndex = Math.min(last, Math.max(0, state.oddIndex + delta));
    state.message = '';
    requestPaint();
  }

  function handleCreateTypeField(data) {
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
    const char = printableChar(data);
    if (char !== '') {
      // A printable character on a list is never dropped on the floor: it starts
      // the new ODD, so nobody types into the type list by accident.
      state.focus = 'odd';
      state.oddIndex = 0;
      state.newOdd += char;
      state.message = '';
      requestPaint();
    }
  }

  // S1/S2: only two fields exist while creating, so `tab`, `shift+tab` and
  // both horizontal arrows walk them; a horizontal key at either end wraps to
  // the other end instead of dying.
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
    handleCreateTypeField(data);
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

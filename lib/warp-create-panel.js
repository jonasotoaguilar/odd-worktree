'use strict';
// The worktree CREATION panel (worktree-ui-feedback S4,S12,S15; simplify
// S1/S6).
//
// It is the TABBED bottom flow a human creates with (S7): a live branch/path
// preview ABOVE, then the change type and the change name as the two TABS of
// one strip (`Type · Name`, with only the ACTIVE field's content under it).
// The Type tab holds the change type as an inline LIST (there is no native
// dropdown in this host, and no second pop-up surface); the Name tab holds
// the text field. The preview stays BLANK until both fields derive a real
// branch and path: an incomplete form is not an error, so nothing in it is
// painted red or names a failure, while a refused submit still says exactly
// why. `tab`, `shift+tab`, `←` and `→` move between the two tabs; `↑`/`↓`
// pick the type; `enter` on the name creates (S12 keeps ONE create key — the
// duplicate `ctrl+s` was dropped and is not a binding).
//
// S1: worktrees receive no issue or ODD association, so this panel asks for a
// type and a name and NOTHING else. The former EDIT mode — the association
// editor with its Issues/Odd panes, selectors, previews and save — is gone
// with the association itself: there is no `mode`, no `branch`/`path` seam,
// no `initialIssues`/`initialOdd`, no association source, and the panel reads
// no dataset of any kind. A worktree is never edited from here.
//
// Pure Node, no package imports. The repository's own helpers do the work
// instead of a second implementation of the same convention: lib/worktree-git.js
// `slugifyBranch` / `canonicalWorktreePathOf` (or `canonicalWorktreePath` /
// `worktreePath`) over its memoized `repoIdentity` derive the branch and the
// target path, exactly as the create path does. The git seam is injectable
// (`git`), so tests never touch a real checkout.
//
// S1 (this round): the panel is a FORM and spawns no `git check-ref-format`.
// Its preview derives from the PURE halves of those helpers, so a typed
// character costs no child at all — the blocking child that ran here from
// `render()` froze Pi for its whole lifetime per keystroke, which is the
// reported "creating a worktree left Pi stuck". The one authoritative branch
// check lives where it can be awaited: the create path that receives this
// panel's payload (`worktree_create` → `validateBranchAsync`), which refuses an
// invalid branch with its own message and nothing created.
//
// Host component contract (the same seam the customize panel and the pickers
// use): `createWarpCreatePanel(options)` returns
// `{ render(width), handleInput(data), invalidate(), state }`.
//
// Completion (documented exactly, because it is the module's only output):
//   done({ ok: true, type, name })
// on `enter` in the LAST step (the name), and
// `done(null)` on `esc` (cancel). `type` is the conventional change-type id
// (`feat`, `fix`, …) and `name` is the trimmed change name as typed. A
// completion NEVER carries `issues` or `odd` (S1/S6): a new row is born
// without an association, and there is no other completion shape. A
// completion fires EXACTLY once. An invalid branch/path refuses creation
// (nothing is emitted) and the reason stays on screen.
//
// Options (every one optional; the seams exist so tests own the world):
//   cwd               checkout the panel derives the path from
//                     (default: process.cwd())
//   changeTypes       `[{id,label}]`; default exports CHANGE_TYPES, the
//                     repository's branch-pr convention
//   namePlaceholder   ghost name hint (default NAME_PLACEHOLDER)
//   initialName       pre-filled change name
//   initialType       pre-selected change-type id
//   rowsAvailable     the row budget the host offers: the surface renders
//                     exactly its own content height (clamped by this)
//   principalLayout   derive the target with `canonicalWorktreePath`
//                     (default true) instead of `worktreePath`
//   git               lib/worktree-git.js seam
//   helpers/hostTui/theme   the host seams the other panels use
//   done              (value) => void, see above
//
// Keys: the preview ABOVE (branch, then path), then the `Type` and `Name`
// tabs of one field strip (S7). `tab`/`shift+tab`/`←`/`→` move between Type
// and Name (a horizontal key at either end wraps to the other tab), `↑`/`↓`
// pick the type while Type is active, a printable character there starts the
// name (so nobody types into a list), `enter` on Type reaches Name, `enter` on
// Name creates (the ONE create key), `esc` cancels. There is no
// `?` key list: the footer names every shortcut on ONE row.

const gitLib = require('./worktree-git.js');
const picker = require('./warp-create-picker.js');
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

// The name placeholder the wizard shows, rendered as GHOST text (dim,
// never a value: creating from a placeholder is refused).
const NAME_PLACEHOLDER = 'name-change';

const PANEL_HEIGHT_MAX = 40;

// S12: the create surface's own fixed rows — top rule, title, branch preview,
// path preview, the `Type · Name` tab strip, the active field's own row, the
// one-row legend, the bottom rule. The inline type list (which belongs to the
// Type tab alone) takes whatever the host budget leaves.
const CREATE_FIXED_ROWS = 8;

// S7: the placeholder an underivable preview shows. `-` is the same
// missing-value mark the viewers use, so a form that is not filled in yet
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
// or a key object. The filter rule (S6) needs exactly this distinction.
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

// Word wrap for the pane state messages: a narrow list column must still
// say WHY it is empty instead of clipping the explanation away.
function wrapText(text, width) {
  const limit = Math.max(1, width);
  const words = String(text).split(/\s+/).filter((word) => word !== '');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
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
// S12: creating is TWO fields, so the legend names the field keys (tab/←/→),
// the type-list keys and the ONE confirm key — never a pane or association key
// and never a second key that does the same thing (`ctrl+s` created too, which
// the user reported as a duplicate of `enter`).
const CREATE_KEYS = [
  { key: 'tab/←/→', text: 'tab/←/→ fields', short: 'tab/←/→', priority: 70 },
  { key: '↑/↓', text: '↑/↓ type', short: '↑/↓', priority: 60 },
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
  const namePlaceholder = typeof opts.namePlaceholder === 'string' && opts.namePlaceholder !== ''
    ? opts.namePlaceholder
    : NAME_PLACEHOLDER;
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
    name: typeof opts.initialName === 'string' ? opts.initialName : '',
    focus: 'type',
    message: '',
  };
  if (typeof opts.initialType === 'string') {
    const at = changeTypes.findIndex((type) => type.id === opts.initialType);
    if (at >= 0) state.typeIndex = at;
  }

  // One derivation per distinct (type, name), memoized, so a repaint of an
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

  // The target path for a branch, through the pure layout helpers over the one
  // memoized identity: `<principal>-worktrees/<slug>` beside the PRINCIPAL
  // checkout under `principalLayout` (the default), the calling checkout's own
  // layout otherwise — exactly what the create path resolves.
  function layoutFor(branch) {
    const identity = repoIdentity();
    if (principalLayout) {
      if (identity && typeof git.canonicalWorktreePathOf === 'function') return git.canonicalWorktreePathOf(identity, branch);
      if (typeof git.canonicalWorktreePath === 'function') return git.canonicalWorktreePath(cwd, branch);
    } else if (identity && typeof git.worktreePathOf === 'function') {
      return git.worktreePathOf(identity, branch);
    }
    return git.worktreePath(cwd, branch);
  }

  // The live derivation, memoized per distinct (type, name) and FREE of
  // subprocesses: the slug convention, the branch format the repository
  // publishes and the layout above are all pure, so painting a keystroke asks
  // git for nothing. Only the plain rejections run here; git's own verdict
  // belongs to the create path, which can await it.
  function derivePreview() {
    const type = currentType();
    const name = state.name.trim();
    const key = `${type.id}\u0000${name}`;
    if (deriveCache.key === key) return deriveCache.value;
    let value;
    if (name === '') {
      value = { ok: false, branch: null, branchOk: false, path: null, pathOk: false, reason: 'name is empty' };
    } else if (!/[a-z0-9]/i.test(name)) {
      value = { ok: false, branch: null, branchOk: false, path: null, pathOk: false, reason: 'name has no letters or digits' };
    } else {
      let slug = '';
      try {
        slug = String(typeof git.slugifyBranch === 'function' ? git.slugifyBranch(name) : '');
      } catch {
        slug = '';
      }
      const branch = slug === '' ? '' : `${type.id}/${slug}`;
      if (branch === '' || !branchFormat.test(branch)) {
        value = {
          ok: false,
          branch: branch === '' ? null : branch,
          branchOk: false,
          path: null,
          pathOk: false,
          reason: `invalid branch name: ${branch === '' ? name : branch}`,
        };
      } else {
        let target = null;
        let failure = null;
        try {
          target = layoutFor(branch);
        } catch (err) {
          failure = shortError(err);
        }
        value = typeof target === 'string' && target !== '' && !failure
          ? { ok: true, branch, branchOk: true, path: target, pathOk: true, reason: null }
          : {
            ok: false,
            branch,
            branchOk: true,
            path: null,
            pathOk: false,
            reason: `cannot resolve the worktree path: ${failure || 'unknown error'}`,
          };
      }
    }
    deriveCache = { key, value };
    return value;
  }

  // S12: the create surface's single name line. The placeholder is ghost
  // text, never a value. S7: this row renders only under the FOCUSED Name tab,
  // so the caret is the typing position exactly when it is on screen. S11: the
  // static label is dim and the typed name is a value.
  function nameLine(width) {
    const caret = { kind: null, text: `${cursorMarker}▊` };
    const segments = [{ kind: 'label', text: 'Name: ' }];
    if (state.name === '') segments.push(caret, { kind: 'label', text: namePlaceholder });
    else segments.push({ kind: 'value', text: state.name }, caret);
    return composed(segments, width);
  }

  // S7: the two fields are TABS, not two stacked rows — one strip with the
  // active label accented (and bold) and the other dimmed, so "where am I"
  // reads the same everywhere.
  function tabSegments() {
    const tab = (field, text) => ({ kind: state.focus === field ? 'title' : 'label', text });
    return [tab('type', 'Type'), { kind: null, text: ' · ' }, tab('name', 'Name')];
  }

  function rule(width) {
    return kindText('border', '─'.repeat(Math.max(0, width)));
  }

  // S12: the inline change-type list. The SELECTED type (and therefore the
  // preview) follows the cursor, and the list is windowed around it when the
  // host offers fewer rows than the convention has types. The `❯` marker is
  // the same one the fields use, so "where am I" reads the same everywhere.
  function typeListWindow(room) {
    const count = changeTypes.length;
    const size = Math.min(count, Math.max(0, room));
    if (size === 0) return { start: 0, size: 0 };
    const centred = state.typeIndex - Math.floor(size / 2);
    return { start: Math.min(Math.max(0, centred), count - size), size };
  }

  function typeListLines(width, room) {
    const { start, size } = typeListWindow(room);
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

  // S12: the create surface is COMPACT — it renders exactly its own content
  // and never pads out to the host's row budget, so the host can mount it at
  // the bottom of the terminal without slack rows above or below it. S7: the
  // preview sits ABOVE the tab strip, only the ACTIVE tab's field renders
  // under it (the type list belongs to the Type tab), and an underivable
  // preview stays blank instead of red.
  function renderCreate(w, maxRows) {
    const messageRows = state.message ? 1 : 0;
    if (maxRows < CREATE_FIXED_ROWS + messageRows) {
      return [pad(helpers, kindText('label', 'New worktree — enlarge the terminal'), w)];
    }
    const derived = derivePreview();
    const room = Math.max(0, maxRows - CREATE_FIXED_ROWS - messageRows);
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
      const type = currentType();
      lines.push(composed([
        { kind: 'label', text: 'Type: ' },
        { kind: 'value', text: `${type.label} (${type.id})` },
      ], w));
      lines.push(...typeListLines(w, room));
    } else {
      lines.push(nameLine(w));
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
    // S6: a creation carries the two things it asked for and nothing else.
    // No `issues`, no `odd`: a brand-new row is born without an association.
    finish({
      ok: true,
      type: currentType().id,
      name: state.name.trim(),
    });
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
      state.focus = 'name';
      requestPaint();
      return;
    }
    const char = printableChar(data);
    if (char !== '') {
      state.focus = 'name';
      state.name += char;
      state.message = '';
      requestPaint();
    }
  }

  function moveType(delta) {
    const last = Math.max(0, changeTypes.length - 1);
    state.typeIndex = Math.min(last, Math.max(0, state.typeIndex + delta));
    state.message = '';
    requestPaint();
  }

  // S12: only two fields exist while creating, so `tab`, `shift+tab` and both
  // horizontal arrows move between their tabs; a horizontal key at either end
  // wraps to the other tab instead of dying.
  function toggleCreateField() {
    state.focus = state.focus === 'type' ? 'name' : 'type';
    requestPaint();
  }

  function handleNameField(data) {
    if (keyText(helpers, data, ['enter', 'return'])) {
      // S12: the name is the SECOND and LAST field of a creation, so `enter`
      // there creates.
      create();
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      // Nothing sits below the name — the surface is two fields — so `↓`
      // stays put.
      return;
    }
    if (keyText(helpers, data, ['up'])) {
      state.focus = 'type';
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.name !== '') {
        state.name = [...state.name].slice(0, -1).join('');
        state.message = '';
        requestPaint();
      }
      return;
    }
    if (keyText(helpers, data, ['pageup', 'pagedown'])) return;
    const char = printableChar(data);
    if (char !== '') {
      state.name += char;
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
    // `tab`, `shift+tab` and the horizontal arrows move between the two
    // fields, which is what the reported flow asked for (S12).
    if (keyText(helpers, data, ['tab', 'shift+tab', 'left', 'right'])) {
      toggleCreateField();
      return;
    }
    if (state.focus === 'name') {
      handleNameField(data);
      return;
    }
    handleCreateTypeField(data);
  }

  // The panel caches nothing between frames (every line is derived from the
  // two fields), so a repaint request has nothing to drop; the host seam still
  // exists because the component contract asks for it.
  function invalidate() {}

  return { render, handleInput, invalidate, state };
}

module.exports = {
  CHANGE_TYPES,
  NAME_PLACEHOLDER,
  createWarpCreatePanel,
};

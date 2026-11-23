'use strict';
// Pull request viewer component (prs-panel T2, S1-S3, S6-S7): the `/issues`
// reader cloned for pull requests — a framed full-screen overlay with three
// scoped tabs (`My Pull Request` / `Needs My Review` / `Involved`), a live
// search box, ONE continuously scrolling list, a scrolling pull request pane,
// and the actions S2 asks for (comment, labels, assignees as a toggle, close,
// merge with its own confirmation step, the Development relation as a
// linked-issues editor, open on the web, insert).
//
// PURE: no `gh`, no registry, no files. Rows arrive through
// `loadPullRequestPage({bucketId, cursor, limit, query})` — the same server-page
// seam the issues reader uses, answering `{ok, rows, totalCount, hasMore,
// cursor}` — the detail through `loadPullRequest(number)`, repository labels
// through `loadLabels()` and assignable users through `loadAssignees()`, each on
// the editor's first use. Writes go through `actions`. Every failure is shown
// and keeps the local state unchanged. Host contract:
// { render(width), handleInput(data), handleMouse(event), invalidate() } plus
// `state`.
//
// S2 capability policy, cloned from issues and fail-closed: the pull request
// detail carries `permissions: {canEditLabels, canCreateLabels,
// canEditAssignees, canClosePullRequests, canMerge, canEditLinkedIssues}` and
// anything but a literal `true` is false — no footer hint, no editor, no write.
// `canMerge` additionally needs a non-draft pull request and at least one merge
// method the repository allows (`mergeMethods`), because GitHub refuses both.
// Commenting needs no capability beyond read access. The permissions may also
// arrive on the seam's own answer or, for a repository-wide role, as
// `options.permissions`; the first one present wins and the rest fail closed.
// A rejected save stays visible with the draft and its toggles intact, and a
// successful one refetches the detail through `loadPullRequest(number,
// {refresh:true})` instead of trusting the cache.
//
// S1: the three scoped buckets are the tabs; `all` is a SHORTCUT, not a fourth
// tab — `g` reads it the first time it is entered (the repository connection)
// and the same key returns to the tab the reader came from, reusing the rows and
// the scroll place that tab already had.
//
// S3: search is a SERVER search. Every page request carries `query`, a settled
// query is read after a short injected debounce, and the answer is never
// re-filtered as literal title text. The pane scrolls with the shared preview
// bindings (`lib/preview-scroll-keys.js`) and every key hint paints through
// `lib/tui-paint.js`.
//
// S6: the pane publishes the cell range of every linked issue number
// (`lib/pr-preview.js` `options.links`), and a click inside one calls
// `actions.openLinked({kind: 'issue', number})` for exactly that number — never
// for the whole line.
//
// S7: `Enter` in list mode is INSERT: it calls `actions.insert('PR #N')` and
// closes the panel. Inside the search box, the editors and the confirm steps the
// same key keeps the meaning it has there.
//
// S10 (issues, kept): every write records and paints its busy state BEFORE the
// action is invoked and ignores every key until it settles, so a second save,
// a navigation or typing can never race it.
//
// T20: the linked-issues editor names every issue by NUMBER AND TITLE. `i` opens
// the pull request's current links as `[x] #61 TEMP: rail check 1` toggles, and
// `n` opens a LIST of the repository's open issues instead of a bare number
// field: the links already in the draft first (checked, real titles), then the
// rest hottest-updated first. The candidates arrive through ONE injected seam,
// `loadIssueCandidates({ after, pageSize })`, which answers the same cursor page
// shape the list uses (`{ok, rows, hasMore, cursor}` with rows
// `{number, title, state}`); the list scrolls with the panel's own scroll keys
// and reads the next page as it scrolls. `space` toggles the focused row, `enter`
// keeps the selection and returns to the toggles, `esc` discards it. A title the
// seam cannot answer leaves the row as `#N` instead of blocking the editor, and a
// failed read paints its error while the toggles stay.
//
// D27 stays the write rule: the applied add/remove delta still goes through the
// ONE existing linked-issues save (marker-only body edit, byte-exact own line,
// re-read with state), and a number the pull request already links is never
// added twice.

const layout = require('./view-layout.js');
const scrollKeys = require('./preview-scroll-keys.js');
const palette = require('./tui-paint.js');
const paint = palette.paint;
const emphasize = palette.emphasize;
const highlight = palette.highlight;
const { pullRequestDetailLines, defaultWrapCache } = require('./pr-preview.js');

const CARD_PADDING = layout.CARD_PADDING;
const MIN_WIDTH = 24;
// S3: a remote search is debounced, so a burst of typing costs ONE server read
// for the query it settles on. The clock is injected (`scheduleQuery` /
// `cancelSchedule`), so no expectation depends on wall-clock timing.
const QUERY_DEBOUNCE_MS = 180;
// S1: the opening selection reads at most this many pages of its bucket, so a
// bucket with thousands of rows can never loop the panel's open.
const INITIAL_SELECTION_PAGE_LIMIT = 5;
// The frame's fixed chrome: top rule, search row, tab row, note row. The body
// starts below it, which is also where a click's `y` lands.
const BODY_TOP = 4;
// S2 (D22): the shortest frame a confirmation may act on. Below this the chrome
// (top rule, search, tabs, note), one body row, the footer and the bottom rule
// do not fit, so the step's own line cannot be given a row at all.
const MIN_STEP_ROWS = BODY_TOP + 3;
// `│ ` + the list column + ` ` + `│` + ` ` before the pane's first cell.
const PANE_LEFT = 5;

// The buckets the server seam reads from unless the caller passes its own
// `pages` metadata. `all` keeps its slot in `state.page` but never in the tab
// bar: it is the lazy view the `g` shortcut owns (S1).
const DEFAULT_BUCKETS = [
  { id: 'mine', label: 'My Pull Request' },
  { id: 'review', label: 'Needs My Review' },
  { id: 'involved', label: 'Involved' },
  { id: 'all', label: 'All', lazy: true },
];

// S1/D1: `g` teaches itself in the ONE legend row. Outside the lazy view it
// reads `all prs`; inside it, the same key reads `related prs`, because there it
// goes back.
const SHORTCUT_HINT = {
  key: 'g',
  text: 'g all prs',
  short: 'g',
  priority: 38,
  shortcut: true,
};

function shortcutHint(insideLazy) {
  return {
    key: SHORTCUT_HINT.key,
    text: insideLazy ? 'g related prs' : SHORTCUT_HINT.text,
    short: SHORTCUT_HINT.short,
    priority: SHORTCUT_HINT.priority,
  };
}

// S2/S16: an entry that carries `requires` leaves the row whenever that
// capability is not confirmed true, and `needsIssue` leaves it whenever no
// loaded pull request is under the cursor — so a hint can never advertise a key
// the handler refuses.
const FOOTER_KEYS = [
  { key: '↑↓', text: '↑↓ move', short: '↑↓ move', priority: 90 },
  { key: '←→', text: '←→ bucket', short: '←→', priority: 62 },
  { key: 'l', text: 'l labels', short: 'l', priority: 50, requires: 'canEditLabels', needsIssue: true },
  { key: 'a', text: 'a assign', short: 'a', priority: 48, requires: 'canEditAssignees', needsIssue: true },
  { key: 'c', text: 'c comment', short: 'c', priority: 45, needsIssue: true },
  { key: 'i', text: 'i linked', short: 'i', priority: 44, requires: 'canEditLinkedIssues', needsIssue: true },
  { key: 'x', text: 'x close', short: 'x', priority: 40, requires: 'canClosePullRequests', needsIssue: true },
  { key: 'm', text: 'm merge', short: 'm', priority: 42, requires: 'canMerge', needsIssue: true },
  { key: 'o', text: 'o web', short: 'o', priority: 20, needsIssue: true },
  // S7: Enter is INSERT here, and the legend says so.
  { key: 'enter', text: 'enter insert', short: 'enter', priority: 36, needsIssue: true },
  { key: 't', text: 't search', short: 't', priority: 35 },
  SHORTCUT_HINT,
  { key: 'esc', text: 'esc close', short: 'esc close', priority: 100 },
];

// S13: while the search box holds the keyboard the footer names THAT
// interaction once, in the same slot.
const SEARCH_KEYS = [
  { key: 'type', text: 'type to filter', short: 'type', priority: 30 },
  { key: 'bksp', text: 'bksp edit', short: 'bksp', priority: 20 },
  { key: 'del', text: 'del clear', short: 'del', priority: 50 },
  { key: 'enter/esc', text: 'enter/esc keep', short: 'enter/esc', priority: 60 },
];

// S10: a sub-mode's keys live on the ONE footer row while it holds the
// keyboard, and its pane title carries the sub-mode's name alone.
const LABEL_EDITOR_KEYS = [
  { key: 'space', text: 'space toggle', short: 'space', priority: 70 },
  { key: 'n', text: 'n new', short: 'n', priority: 60, needsCreate: true },
  { key: 'ctrl+s', text: 'ctrl+s apply', short: 'ctrl+s', priority: 90 },
  { key: 'esc', text: 'esc back', short: 'esc back', priority: 100 },
];

const ASSIGNEE_EDITOR_KEYS = [
  { key: 'space', text: 'space toggle', short: 'space', priority: 70 },
  { key: 'ctrl+s', text: 'ctrl+s apply', short: 'ctrl+s', priority: 90 },
  { key: 'esc', text: 'esc back', short: 'esc back', priority: 100 },
];

const COMMENT_EDITOR_KEYS = [
  { key: 'enter', text: 'enter newline', short: 'enter', priority: 70 },
  { key: 'ctrl+s', text: 'ctrl+s post', short: 'ctrl+s', priority: 90 },
  { key: 'esc', text: 'esc discard', short: 'esc discard', priority: 100 },
];

const LABEL_CREATE_KEYS = [
  { key: 'enter', text: 'enter add', short: 'enter', priority: 70 },
  { key: 'esc', text: 'esc cancel', short: 'esc cancel', priority: 100 },
];

const COMMENT_DISCARD_KEYS = [
  { key: 'y', text: 'y discard', short: 'y', priority: 60 },
  { key: 'n/esc', text: 'n/esc keep editing', short: 'n/esc', priority: 70 },
];

// S2: the merge step. Only the allowed methods are ever offered, so its keys
// talk about the FIELD the reader is on and the one commit.
const MERGE_KEYS = [
  { key: '↑↓', text: '↑↓ field', short: '↑↓', priority: 80 },
  { key: '←→', text: '←→ method', short: '←→', priority: 78 },
  { key: 'enter', text: 'enter select', short: 'enter', priority: 88 },
  { key: 'ctrl+s', text: 'ctrl+s merge', short: 'ctrl+s', priority: 90 },
  { key: 'esc', text: 'esc cancel', short: 'esc cancel', priority: 100 },
];

// S2: the Development relation editor. GitHub has no mutation for that panel,
// so the client rewrites the `Closes #N` lines of the body; this step only
// collects the delta. T20: `n` opens the candidate list instead of a number
// field.
const LINKED_EDITOR_KEYS = [
  { key: 'space', text: 'space toggle', short: 'space', priority: 70 },
  { key: 'n', text: 'n add', short: 'n', priority: 60 },
  { key: 'ctrl+s', text: 'ctrl+s apply', short: 'ctrl+s', priority: 90 },
  { key: 'esc', text: 'esc back', short: 'esc back', priority: 100 },
];

// T20: the candidate list `n` opens. Its scroll keys are the panel's own
// preview bindings, so the list pages exactly like the pane; `enter` keeps the
// selection and `esc` discards it.
const LINKED_CANDIDATE_KEYS = [
  { key: 'space', text: 'space toggle', short: 'space', priority: 70 },
  ...scrollKeys.previewScrollKeys(),
  { key: 'enter', text: 'enter keep', short: 'enter', priority: 90 },
  { key: 'esc', text: 'esc discard', short: 'esc discard', priority: 100 },
];

// S11: while an editor's own list is still in flight its handlers accept ONE
// key — the exit — so that is the only key the footer may offer then.
const BACK_KEYS = [
  { key: 'esc', text: 'esc back', short: 'esc back', priority: 100 },
];

// Printable paging keys must not fall through to lowercase list selection.
const SHIFTED_TWINS = new Set(['j', 'k']);

// The methods GitHub allows, in the order the confirmation offers them. A
// method the repository did not allow never appears and is never sent.
const MERGE_METHODS = ['merge', 'squash', 'rebase'];

// S2: one capability contract for every editor and both write keys. Only a
// literal `true` confirms a permission, so a missing field, an unknown string
// or a truthy non-boolean all read as "not permitted" (GitHub stays the final
// authority).
const NO_PERMISSIONS = {
  canEditLabels: false,
  canCreateLabels: false,
  canEditAssignees: false,
  canClosePullRequests: false,
  canMerge: false,
  canEditLinkedIssues: false,
};

// One page entry, whatever the source: eager `pages` and every server answer
// pass through here so both paths share one shape.
function mapPage(page, at) {
  const rows = Array.isArray(page && page.rows)
    ? page.rows
    : (Array.isArray(page && page.pullRequests) ? page.pullRequests : null);
  return {
    id: page && page.id != null ? String(page.id) : `p${at}`,
    label: page && page.label ? String(page.label) : `Page ${at + 1}`,
    rows: rows === null ? null : rows.slice(),
    total: page && Number.isFinite(Number(page.total)) ? Number(page.total) : null,
    truncated: !!(page && page.truncated),
    lazy: !!(page && page.lazy === true),
  };
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the plain count.
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

// The last cells of a query that fit `room`, prefixed with an ellipsis when
// something was dropped. Only the DISPLAY is shortened — the stored query keeps
// every character — and keeping the tail means the caret stays on screen.
function tailOf(helpers, text, room) {
  const chars = [...String(text ?? '')];
  if (room <= 0) return '';
  if (measure(helpers, chars.join('')) <= room) return chars.join('');
  let cut = '';
  for (let at = chars.length - 1; at >= 0; at -= 1) {
    const next = chars[at] + cut;
    if (measure(helpers, `…${next}`) > room) break;
    cut = next;
  }
  return cut === '' ? '…' : `…${cut}`;
}

function keyMatches(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the string fallback decides below.
    }
  }
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  return names.some((name) => sameKeyName(text, name));
}

function sameKeyName(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return true;
  const shiftedLetter = (text) => text.length === 1 && text >= 'A' && text <= 'Z';
  if (shiftedLetter(a) && !shiftedLetter(b) && SHIFTED_TWINS.has(b.toLowerCase())) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function isKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === 'function') return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases; normal handling follows.
  }
  return false;
}

function labelName(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return '';
}

function assigneeName(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.login === 'string') return entry.login;
  return '';
}

// One assignable user as the editor lists it: a login plus the display name
// GitHub may or may not carry.
function assigneeOption(user) {
  if (typeof user === 'string') return user === '' ? null : { login: user, name: '' };
  const login = user && typeof user.login === 'string' ? user.login : '';
  if (login === '') return null;
  return { login, name: user && typeof user.name === 'string' ? user.name : '' };
}

function wrapText(text, width) {
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (line === '') {
        line = word.length > width ? word.slice(0, width) : word;
      } else if ((line + ' ' + word).length <= width) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      }
    }
    out.push(line);
  }
  return out.length === 0 ? [''] : out;
}

// The local filter of the EAGER path only. The server seam answers its query
// itself, so a server answer is never re-filtered as literal title text.
function matchesQuery(row, query) {
  const tokens = String(query || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return true;
  const title = String(row.title || '').toLowerCase();
  const author = String(row.author || '').toLowerCase();
  const number = String(row.number ?? '');
  return tokens.every((token) => {
    if (token.startsWith('@')) {
      const want = token.slice(1).toLowerCase();
      return want === '' || author.includes(want);
    }
    if (token.startsWith('#')) {
      const want = token.slice(1);
      return want === '' || number.includes(want);
    }
    return title.includes(token.toLowerCase());
  });
}

function normalizeDetail(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'pull request unreadable' };
  if (result.ok === true && result.pullRequest && typeof result.pullRequest === 'object') {
    return {
      ok: true,
      pullRequest: result.pullRequest,
      comments: Array.isArray(result.comments) ? result.comments : [],
      permissions: result.permissions && typeof result.permissions === 'object' ? result.permissions : null,
    };
  }
  if (result.ok === false) return { ok: false, error: String(result.error || 'pull request unreadable') };
  return { ok: false, error: 'pull request unreadable' };
}

// T20: one candidate page from `loadIssueCandidates`. The list only ever shows
// OPEN issues by number and title, so a row without a usable number is dropped
// instead of painted, and a page that claims more without a cursor is honestly
// the end (a cursorless `hasMore` could never advance).
function normalizeIssueCandidatePage(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'issues unreadable' };
  if (result.ok === false) return { ok: false, error: String(result.error || result.loadError || 'issues unreadable') };
  if (!Array.isArray(result.rows)) return { ok: false, error: 'issues unreadable: unexpected result' };
  const rows = [];
  for (const row of result.rows) {
    const number = Number(row && row.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const state = String((row && row.state) || 'open').toLowerCase();
    if (state !== 'open') continue;
    rows.push({ number, title: typeof row.title === 'string' ? row.title : '' });
  }
  const cursor = typeof result.cursor === 'string' && result.cursor !== '' ? result.cursor : null;
  return { ok: true, rows, hasMore: result.hasMore === true && cursor !== null, cursor };
}

// T20: one issue row, always `#<number>` and the title when the seam answered
// one — never a bare number in either the toggles or the candidate list.
function issueRowText(number, title) {
  const text = typeof title === 'string' ? title.trim() : '';
  return text === '' ? `#${number}` : `#${number} ${text}`;
}

// S2: the methods the repository actually allows, in the order the merge step
// offers them. Anything but a literal `true` allows nothing.
function allowedMergeMethods(pullRequest) {
  const raw = pullRequest && typeof pullRequest.mergeMethods === 'object' && pullRequest.mergeMethods
    ? pullRequest.mergeMethods
    : {};
  return MERGE_METHODS.filter((method) => raw[method] === true);
}

// S2: GitHub's own proposal for each allowed method, which the confirmation
// starts from and the reader may edit. A rebase merge carries neither field.
function mergeTextDefaults(pullRequest) {
  const out = {};
  const methods = pullRequest && pullRequest.mergeDefaults && typeof pullRequest.mergeDefaults === 'object'
    ? pullRequest.mergeDefaults
    : {};
  for (const method of allowedMergeMethods(pullRequest)) {
    const raw = methods[method] && typeof methods[method] === 'object' ? methods[method] : {};
    out[method] = {
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      body: typeof raw.body === 'string' ? raw.body : '',
    };
  }
  return out;
}

function capabilityMap(pullRequest, fromResult, viewWide) {
  const own = pullRequest && typeof pullRequest.permissions === 'object' && pullRequest.permissions !== null
    ? pullRequest.permissions
    : null;
  const raw = own
    || (fromResult && typeof fromResult === 'object' ? fromResult : null)
    || (viewWide && typeof viewWide === 'object' ? viewWide : null);
  const confirmed = (name) => Boolean(raw && raw[name] === true);
  const methods = allowedMergeMethods(pullRequest);
  // S5/S6 (D7): a pull request outside `open` — merged, closed — is READ ONLY
  // here. GitHub's state is final for the panel's writes, so a numbered open of
  // one shows it with its state and offers no editor, close or merge at all.
  const open = !pullRequest || typeof pullRequest !== 'object'
    || String(pullRequest.state || 'open').toLowerCase() === 'open';
  return {
    canEditLabels: open && confirmed('canEditLabels'),
    canCreateLabels: open && confirmed('canCreateLabels'),
    canEditAssignees: open && confirmed('canEditAssignees'),
    canClosePullRequests: open && confirmed('canClosePullRequests'),
    // S2: merging is the one capability with preconditions GitHub enforces on
    // top of the repository role, so both are required here as well.
    canMerge: open && confirmed('canMerge') && Boolean(pullRequest && typeof pullRequest === 'object')
      && pullRequest.isDraft !== true && methods.length > 0,
    canEditLinkedIssues: open && confirmed('canEditLinkedIssues'),
  };
}

function createPrsView(options = {}) {
  const {
    helpers = null,
    theme = null,
    rowsAvailable = null,
    requestRender = null,
    done = null,
    loadPullRequest = null,
    loadPullRequestPage = null,
    loadLabels = null,
    loadAssignees = null,
    loadIssueCandidates = null,
    permissions: viewPermissions = null,
    actions = {},
    scheduleQuery = null,
    cancelSchedule = null,
  } = options;

  const pageLoaderFn = typeof loadPullRequestPage === 'function' ? loadPullRequestPage : null;
  const candidateLoaderFn = typeof loadIssueCandidates === 'function' ? loadIssueCandidates : null;
  const serverMode = pageLoaderFn !== null;
  const scheduleFn = typeof scheduleQuery === 'function' ? scheduleQuery : (fn, delay) => setTimeout(fn, delay);
  const cancelFn = typeof cancelSchedule === 'function' ? cancelSchedule : (handle) => clearTimeout(handle);

  let pages = Array.isArray(options.pages) && options.pages.length > 0
    ? options.pages.map(mapPage)
    : (serverMode
      ? DEFAULT_BUCKETS.map((bucket, at) => mapPage({ id: bucket.id, label: bucket.label, rows: null, lazy: bucket.lazy === true }, at))
      : [{ id: 'mine', label: 'My Pull Request', rows: null, total: null }]);

  const initialBucketId = typeof options.initialBucket === 'string' ? options.initialBucket : null;
  const initialNumber = Number.isFinite(Number(options.initialPullRequest)) && Number(options.initialPullRequest) > 0
    ? Math.floor(Number(options.initialPullRequest))
    : null;
  const initialBucketFound = initialBucketId === null || pages.some((page) => page.id === initialBucketId);
  const initialPageIndex = initialBucketId === null
    ? 0
    : Math.max(0, pages.findIndex((page) => page.id === initialBucketId));

  // S1: one shot. The pending selection exists only for the OPENING read of the
  // bucket the reader was opened on; it clears when it lands, misses, reaches
  // its bound, or the reader presses a key.
  let pendingSelection = initialNumber !== null && initialBucketFound
    ? { number: initialNumber, bucketIndex: initialPageIndex, pagesRead: 0, triedFallback: false }
    : null;
  // S5/S6 (D7): the number a numbered open had to fetch outside every bucket.
  let pinnedNumber = null;

  const state = {
    page: initialPageIndex,
    index: 0,
    // S1: while the reader is in the lazy view, the tab they came from.
    allFrom: null,
    listStart: 0,
    scroll: 0,
    query: '',
    searching: false,
    mode: 'list',
    loading: serverMode,
    loadError: null,
    labelIndex: 0,
    labelCreating: false,
    createName: '',
    assigneeIndex: 0,
    commentText: '',
    // S2 (D11): the pull request the composer was opened on, captured like the
    // confirmations capture theirs.
    commentNumber: null,
    confirm: null,
    discardAsk: false,
    // S2: the field the merge confirmation has the focus on.
    mergeField: 0,
    saving: null,
    searchPending: false,
  };
  let bodyRows = 1;
  // T20: the painted pane width, so the candidate list can measure the wrapped
  // height of a row from a key handler and keep its focus inside the window.
  let rightWidthCache = 20;
  const prefetchBuckets = options.prefetchBuckets === true;
  const details = new Map();
  // S2/D25: how many detail reads each number has seen. Only the NEWEST read
  // for a number may install its answer, and a save-time gate only decides on
  // the newest one — an older positive answer can never revive a permission a
  // later read revoked.
  const detailSeq = new Map();
  let actionError = null;
  let notice = null;
  let active = true;
  let pageSeq = 0;
  let listWidthCache = 20;
  let scheduledQuery = null;
  let labelsLoaded = false;
  let labelsLoading = false;
  let labelsError = null;
  let repoLabels = Array.isArray(options.labels)
    ? options.labels.map((label) => ({ name: labelName(label) })).filter((label) => label.name)
    : [];
  let labelDraft = null;
  let assigneeDraft = null;
  let assigneeUsers = [];
  let assigneesLoaded = false;
  let assigneesLoading = false;
  let assigneesError = null;
  let mergeDraft = null;
  let linkedDraft = null;
  // S6: the last painted frame and the click ranges it published, so a mouse
  // event is answered against what the reader actually sees.
  let frame = { width: 0, height: 0, ranges: [] };
  // S6: the linked issue number the pointer is over, if any. It is set from the
  // SAME hit test a click uses, so the pane can never highlight a cell it would
  // not open, and it is cleared by a move that lands nowhere. `hoverPullRequest`
  // is the item that pane painted, so navigating to another pull request cannot
  // leave a highlight behind on a number the pointer never visited there.
  let hoverNumber = null;
  let hoverPullRequest = null;

  const numOf = (row) => (row && row.number != null ? Number(row.number) : NaN);

  // The first action seam with one of `names` that the caller actually wired.
  function actionFor(names) {
    for (const name of names) {
      const fn = actions && typeof actions[name] === 'function' ? actions[name] : null;
      if (fn !== null) return fn;
    }
    return null;
  }

  function repaint() {
    if (!active) return;
    try {
      if (typeof requestRender === 'function') requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function close() {
    active = false;
    cancelScheduledQuery();
    if (typeof done === 'function') done(null);
  }

  // S10a (issues, kept): the list is open-only. GitHub reports `OPEN` from the
  // connection and `open` from the search, so the comparison is case-folded and
  // a merged pull request leaves the list like a closed one.
  function rowState(row) {
    return String((row && row.state) || 'open').toLowerCase();
  }

  function baseRows() {
    const current = pages[state.page];
    if (current && Array.isArray(current.rows)) return current.rows;
    // A bucket with no rows is EMPTY: on the server seam it holds only the rows
    // its own read returned, and the eager path has nothing else to offer.
    return [];
  }

  // S5/S6 (D7): a numbered open may name a pull request no bucket carries — a
  // merged one, or an open one of another author. The detail seam answers for
  // exactly that number, and the row it answers with is PINNED into the list so
  // the reader sees the pull request they asked for (and its state), never
  // another row that happened to hold the focus.
  function pinnedRow() {
    if (pinnedNumber === null) return null;
    const entry = details.get(pinnedNumber);
    if (entry && entry.status === 'ready' && entry.pullRequest) return entry.pullRequest;
    const known = baseRows().find((row) => numOf(row) === pinnedNumber);
    if (known) return known;
    if (entry && entry.pullRequest) return entry.pullRequest;
    return { number: pinnedNumber, title: `#${pinnedNumber}`, state: 'open' };
  }

  // S3/D3: the ONE fact that decides whether a bucket's held rows answer the
  // query on screen: the query those rows were READ for.
  function rowsAnswerCurrentQuery(page) {
    const rt = page && page.rt ? page.rt : null;
    if (!rt || rt.rowsQuery === null) return true;
    return rt.rowsQuery === String(state.query || '');
  }

  function rowsArePaintable(page) {
    if (!page) return false;
    if (rowsAnswerCurrentQuery(page)) return true;
    const rt = page.rt;
    return !(rt && rt.loading === true);
  }

  function filteredRows() {
    if (serverMode && !rowsArePaintable(pages[state.page])) return [];
    const open = baseRows().filter((row) => rowState(row) === 'open');
    const rows = serverMode ? open : open.filter((row) => matchesQuery(row, state.query));
    const pinned = pinnedRow();
    if (pinned === null) return rows;
    if (rows.some((row) => numOf(row) === numOf(pinned))) return rows;
    return [pinned, ...rows];
  }

  function clampSelection() {
    const total = filteredRows().length;
    if (state.index >= total) state.index = Math.max(0, total - 1);
    if (state.index < 0) state.index = 0;
  }

  function selected() {
    const list = filteredRows();
    return list[state.index] || null;
  }

  function availableRows() {
    try {
      if (typeof rowsAvailable === 'function') {
        const value = Math.floor(rowsAvailable());
        if (Number.isFinite(value) && value > 0) return value;
      }
    } catch {
      // A hostile rows source never breaks the view.
    }
    return 24;
  }

  // The item budget of the left list: every body row the frame leaves.
  function listBodyRows() {
    return Math.max(1, availableRows() - 6);
  }

  // S2 (D22): whether the frame can hold a step's own line at all.
  function stepRoomAvailable() {
    return availableRows() >= MIN_STEP_ROWS;
  }

  const STEP_TOO_SHORT = 'the terminal is too short to confirm this pull request; enlarge it and press the key again';

  function searchWidget(room) {
    if (room <= 0) return '';
    const prefix = '› ';
    if (state.searching) {
      const tail = tailOf(helpers, state.query, Math.max(0, room - measure(helpers, `${prefix}█`)));
      return `${palette.label(theme, prefix)}${palette.value(theme, `${tail}█`)}`;
    }
    if (state.query === '') return `${palette.label(theme, prefix)}${palette.label(theme, 'Search')}`;
    const shown = tailOf(helpers, state.query, Math.max(0, room - measure(helpers, prefix)));
    return `${palette.label(theme, prefix)}${palette.value(theme, shown)}`;
  }

  // One bucket's continuous-read state (S3):
  // - `loaded` — its rows were read for `query`, so returning to the tab paints
  //   them instead of refetching;
  // - `hasMore`/`nextCursor` — the read continues after the loaded rows;
  // - `start`/`index` — this bucket's own window and focus, restored on return;
  // - `rowsQuery` — the query the rows CURRENTLY HELD answer (null when none).
  function bucketState(page) {
    if (!page.rt) {
      page.rt = {
        start: 0,
        index: 0,
        loading: false,
        loaded: false,
        seq: 0,
        error: null,
        hasMore: true,
        nextCursor: null,
        query: null,
        rowsQuery: null,
      };
    }
    return page.rt;
  }

  function lazyPageIndex() {
    for (let at = 0; at < pages.length; at += 1) {
      if (pages[at].lazy === true) return at;
    }
    return -1;
  }

  function tabPageIndices() {
    const out = [];
    pages.forEach((page, at) => {
      if (page.lazy !== true) out.push(at);
    });
    return out.length > 0 ? out : pages.map((_, at) => at);
  }

  function insideLazyView() {
    return lazyPageIndex() >= 0 && state.page === lazyPageIndex();
  }

  function hasFilter(text) {
    return typeof text === 'string' && text.trim() !== '';
  }

  function normalizePageResult(result) {
    if (!result || typeof result !== 'object') return { ok: false, error: 'pull requests could not be loaded' };
    if (result.ok === false) {
      return { ok: false, error: String(result.error || result.loadError || 'pull requests could not be loaded') };
    }
    const rows = Array.isArray(result.rows)
      ? result.rows
      : (Array.isArray(result.pullRequests) ? result.pullRequests : null);
    if (rows === null) return { ok: false, error: 'pull requests could not be loaded: unexpected result' };
    const total = Number.isFinite(Number(result.totalCount)) ? Number(result.totalCount) : null;
    const cursor = typeof result.cursor === 'string'
      ? result.cursor
      : (typeof result.nextCursor === 'string'
        ? result.nextCursor
        : (typeof result.endCursor === 'string' ? result.endCursor : null));
    return {
      ok: true,
      rows: rows.slice(),
      total,
      hasMore: result.hasMore === true || result.hasNextPage === true,
      cursor,
    };
  }

  // S3: ONE list, read continuously. A HEAD read replaces the bucket's rows with
  // the first page of the current query and returns the reader to its top; an
  // APPEND read continues after the last loaded row. Every read carries `query`,
  // and only the newest answer for a bucket may paint (D1).
  function requestBucketPage(bucketIndex, requestOptions = {}) {
    const bucket = pages[bucketIndex];
    if (!bucket || !pageLoaderFn) return null;
    const keepSelection = Boolean(requestOptions) && requestOptions.keepSelection === true;
    const append = Boolean(requestOptions) && requestOptions.append === true;
    const query = String(state.query || '');
    const rt = bucketState(bucket);
    const loaded = Array.isArray(bucket.rows) ? bucket.rows : [];
    if (append && (!rt.loaded || rt.loading || !rt.hasMore || rt.nextCursor === null)) return null;
    const cursor = append ? rt.nextCursor : null;
    const seq = ++pageSeq;
    rt.seq = seq;
    rt.loading = true;
    rt.error = null;
    rt.query = query;
    if (!append) rt.loaded = false;
    if (bucketIndex === state.page) state.loading = true;
    repaint();
    const request = {
      bucketId: bucket.id,
      cursor,
      limit: listBodyRows(),
      query,
    };
    let pending = null;
    try {
      pending = pageLoaderFn(request);
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'pull requests could not be loaded' };
    }
    const settle = (result) => {
      if (!active || rt.seq !== seq) return;
      rt.loading = false;
      const normalized = normalizePageResult(result);
      if (!normalized.ok) {
        rt.error = normalized.error;
        const answersQuery = rt.rowsQuery !== null && rt.rowsQuery === query;
        if (!answersQuery) {
          bucket.rows = null;
          bucket.total = null;
          bucket.truncated = false;
          rt.rowsQuery = null;
          rt.hasMore = false;
          rt.nextCursor = null;
          rt.loaded = false;
        }
        if (bucketIndex === state.page) {
          state.loading = false;
          state.loadError = normalized.error;
          if (!answersQuery) {
            state.index = 0;
            state.listStart = 0;
            state.scroll = 0;
          }
        }
        repaint();
        return;
      }
      bucket.rows = append ? [...loaded, ...normalized.rows] : normalized.rows;
      bucket.total = normalized.total;
      bucket.truncated = normalized.hasMore;
      rt.hasMore = normalized.hasMore;
      rt.nextCursor = normalized.cursor;
      rt.loaded = true;
      rt.rowsQuery = query;
      rt.error = null;
      if (bucketIndex === state.page) {
        state.loading = false;
        state.loadError = null;
        actionError = null;
        if (keepSelection) {
          clampSelection();
        } else if (!append) {
          state.index = 0;
          state.listStart = 0;
          state.scroll = 0;
        }
        if (!keepSelection) resolveInitialSelection(bucketIndex);
        if (!append || keepSelection) {
          ensurePullRequest(selected(), keepSelection ? { refresh: true } : undefined);
        }
      } else if (!keepSelection) {
        resolveInitialSelection(bucketIndex);
      }
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'pull requests could not be loaded' });
    });
    return request;
  }

  function loadMoreRows() {
    if (!serverMode) return null;
    return requestBucketPage(state.page, { append: true });
  }

  // S9/S10: a successful write changes the repository, so every bucket's loaded
  // page is stale. The rows stay painted; the next visit reads the page again.
  function invalidateLoadedPages() {
    if (!serverMode) return;
    pages.forEach((page) => {
      bucketState(page).loaded = false;
    });
  }

  function listTitle(row) {
    return String((row && row.title) || '');
  }

  function listRowCost(row, width) {
    return layout.rowCost(helpers, listTitle(row), width, { first: '▸ ' });
  }

  // S1: the two buckets a numbered open searches before it reports a miss. The
  // rail already knows which bucket a linked pull request came from, so this pair
  // only covers a cold caller that named one of the two scoped review buckets.
  const INITIAL_FALLBACK_BUCKET = { mine: 'review', review: 'mine' };

  function fallbackPageIndex(bucketIndex) {
    const page = pages[bucketIndex];
    const id = page && typeof page.id === 'string' ? page.id : '';
    const other = INITIAL_FALLBACK_BUCKET[id];
    if (!other) return -1;
    return pages.findIndex((candidate) => candidate && candidate.id === other);
  }

  function bucketRows(bucketIndex) {
    const page = pages[bucketIndex];
    if (!page || !Array.isArray(page.rows)) return [];
    if (serverMode && !rowsArePaintable(page)) return [];
    return page.rows.filter((row) => rowState(row) === 'open');
  }

  function resolveInitialSelection(bucketIndex = state.page) {
    const pending = pendingSelection;
    if (!pending || pending.bucketIndex !== bucketIndex) return;
    pending.pagesRead += 1;
    const at = bucketRows(bucketIndex).findIndex((row) => numOf(row) === pending.number);
    if (at >= 0) {
      pendingSelection = null;
      if (state.page !== bucketIndex) {
        state.page = bucketIndex;
        state.loading = bucketState(pages[bucketIndex]).loading;
      }
      state.index = at;
      state.listStart = 0;
      state.scroll = 0;
      ensurePullRequest(selected());
      return;
    }
    if (pending.pagesRead < INITIAL_SELECTION_PAGE_LIMIT) {
      if (requestBucketPage(pending.bucketIndex, { append: true })) return;
    }
    if (pending.triedFallback !== true) {
      const fallback = fallbackPageIndex(bucketIndex);
      if (fallback >= 0 && fallback !== bucketIndex) {
        pendingSelection = { number: pending.number, bucketIndex: fallback, pagesRead: 0, triedFallback: true };
        const rt = bucketState(pages[fallback]);
        if (rt.loaded && rt.query === String(state.query || '') && !rt.loading) {
          resolveInitialSelection(fallback);
          return;
        }
        if (requestBucketPage(fallback, {})) return;
      }
    }
    pendingSelection = null;
    // S5/S6 (D7): the buckets cannot carry a merged pull request or another
    // author's open one, so the ONE detail seam is asked for exactly this
    // number instead of the pane settling on a row the reader never named.
    if (typeof loadPullRequest === 'function' && openByNumber(pending.number)) return;
    const label = pages[initialPageIndex] ? pages[initialPageIndex].label : 'My Pull Request';
    notice = `#${pending.number} is not in ${label}`;
  }

  // S5/S6 (D7): pin one number at the top of the list and read it through the
  // detail seam. A read that fails leaves the honest "not in …" notice.
  function openByNumber(number) {
    if (!Number.isFinite(number)) return false;
    pinnedNumber = number;
    const entry = ensurePullRequest({ number, title: `#${number}`, state: 'open' });
    if (entry && entry.status === 'error') {
      pinnedNumber = null;
      return false;
    }
    state.index = 0;
    state.listStart = 0;
    state.scroll = 0;
    repaint();
    return true;
  }

  function ensurePullRequest(row, detailOptions = {}) {
    const refresh = Boolean(detailOptions) && detailOptions.refresh === true;
    if (!row || !Number.isFinite(numOf(row))) return null;
    const number = numOf(row);
    let entry = details.get(number);
    if (entry && !refresh) return entry;
    const previous = entry && entry.pullRequest ? entry.pullRequest : row;
    const seq = (detailSeq.get(number) || 0) + 1;
    detailSeq.set(number, seq);
    entry = {
      status: 'loading',
      pullRequest: previous,
      comments: entry ? entry.comments : [],
      permissions: entry ? entry.permissions : null,
      error: null,
      seq,
    };
    details.set(number, entry);
    if (typeof loadPullRequest !== 'function') {
      entry.status = 'ready';
      entry.pullRequest = row;
      return entry;
    }
    let pending = null;
    try {
      pending = refresh ? loadPullRequest(number, { refresh: true }) : loadPullRequest(number);
    } catch (err) {
      entry.status = 'error';
      entry.error = (err && err.message) || 'pull request unreadable';
      return entry;
    }
    const settle = (result) => {
      // S2/D25: a superseded read never installs its answer.
      if (detailSeq.get(number) !== seq) return;
      const normalized = normalizeDetail(result);
      if (normalized.ok) {
        entry.status = 'ready';
        entry.pullRequest = normalized.pullRequest;
        entry.comments = normalized.comments;
        entry.permissions = normalized.permissions;
      } else {
        entry.status = 'error';
        entry.error = normalized.error;
      }
      repaint();
    };
    if (pending && typeof pending.then === 'function') {
      entry.pending = Promise.resolve(pending).then(settle, (err) => {
        if (detailSeq.get(number) !== seq) return;
        entry.status = 'error';
        entry.error = (err && err.message) || 'pull request unreadable';
        repaint();
      });
    } else {
      entry.pending = null;
      settle(pending);
    }
    return entry;
  }

  // S2 (D20): the pull request a captured number names, whatever the list holds
  // now — its own row, the row a numbered open pinned, or the detail already
  // read for it. Null when nothing knows it any more.
  function rowForNumber(number) {
    const at = Number.isFinite(number) ? number : NaN;
    if (!Number.isFinite(at)) return null;
    const known = filteredRows().find((candidate) => numOf(candidate) === at);
    if (known) return known;
    const entry = details.get(at);
    return entry && entry.pullRequest ? entry.pullRequest : null;
  }

  // S2 (D20, D25): the captured number's OWN detail is re-read before its
  // confirmation or its save proceeds, so a reload that reordered or removed the
  // row can never make it write with the capability — or the state — of whichever
  // pull request holds the focus now. The answer this gate decides on is the
  // NEWEST read for that number: when a later read landed while an older one was
  // still in flight, the newer answer (even a negative one) wins.
  function freshDetail(number) {
    const row = rowForNumber(number);
    if (!row) return Promise.resolve(null);
    const entry = ensurePullRequest(row, { refresh: true });
    if (!entry) return Promise.resolve(null);
    const newest = () => {
      const current = details.get(number);
      return current && current.seq === entry.seq ? entry : (current || entry);
    };
    if (entry.pending && typeof entry.pending.then === 'function') {
      return entry.pending.then(newest, newest);
    }
    return Promise.resolve(newest());
  }

  // S2 (D20, D26): the two gates a captured write must pass on its FRESH detail. A
  // pull request that is no longer open, or whose detail could not be read, is
  // refused with the sentence the step names; so is one whose capability is no
  // longer confirmed. Both refusals leave the write seam untouched. The fresh
  // capability map is returned too, so an editor that needs a SECOND capability
  // (creating a label) decides on the same read.
  function freshGate(number, capability, sentences) {
    return freshDetail(number).then((entry) => {
      const pullRequest = entry && entry.status === 'ready' && entry.pullRequest ? entry.pullRequest : null;
      if (pullRequest === null) return { ok: false, error: sentences.notOpen, exit: true };
      const stateText = String(pullRequest.state || '').toLowerCase();
      if (stateText !== '' && stateText !== 'open') {
        return { ok: false, error: sentences.notOpen, exit: true };
      }
      const confirmed = capabilityMap(pullRequest, entry.permissions, viewPermissions);
      if (confirmed[capability] !== true) return { ok: false, error: sentences.refusal, exit: true };
      return { ok: true, capabilities: confirmed, pullRequest };
    });
  }

  // The seam call itself, guarded: a throwing action is a refusal, never a crash.
  function runSeam(fn, ...args) {
    try {
      return fn(...args);
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'action failed' };
    }
  }

  // S2 (D20): a save that stops on its own fresh gate EXITS the step it belongs
  // to and names why; a write that fails keeps the step open like any other.
  function settleCaptured(pending, onOk, exit) {
    const finish = (result) => {
      if (!active) return;
      state.saving = null;
      if (result && result.ok === true) {
        onOk(result);
        return;
      }
      if (result && result.exit === true) exit();
      actionError = (result && result.error) || 'action failed';
      repaint();
    };
    Promise.resolve(pending).then(finish).catch((err) => {
      finish({ ok: false, error: (err && err.message) || 'action failed' });
    });
  }

  function refetchDetail(number) {
    const row = filteredRows().find((candidate) => numOf(candidate) === number)
      || (numOf(selected()) === number ? selected() : null);
    if (!row) {
      details.delete(number);
      repaint();
      return;
    }
    ensurePullRequest(row, { refresh: true });
    repaint();
  }

  // S2: the capability a key needs comes from the established detail, so a
  // permission is never a stale guess and painting the footer starts no fetch.
  function permissionsFor(row) {
    if (!row) return NO_PERMISSIONS;
    return permissionsOf(numOf(row));
  }

  // S2 (D1, D3): the capability of ONE number — the pull request a confirmation
  // showed, or the draft an editor is holding — whatever row holds the focus by
  // the time the key is pressed.
  function permissionsOf(number) {
    const at = Number.isFinite(number) ? number : NaN;
    const entry = Number.isFinite(at) ? details.get(at) : null;
    if (entry && entry.status === 'ready') return capabilityMap(entry.pullRequest || {}, entry.permissions, viewPermissions);
    if (typeof loadPullRequest !== 'function') {
      const row = filteredRows().find((candidate) => numOf(candidate) === at) || null;
      return capabilityMap(row || {}, null, viewPermissions);
    }
    return NO_PERMISSIONS;
  }

  // S11: the hints that act on the selected pull request need one that is both
  // focused and loaded. The detail read is that proof; a view with no detail
  // seam holds only the row, so there the row is what "loaded" means.
  function pullRequestReady(row) {
    if (!row) return false;
    if (typeof loadPullRequest !== 'function') return true;
    const number = numOf(row);
    const entry = Number.isFinite(number) ? details.get(number) : null;
    return Boolean(entry && entry.status === 'ready');
  }

  // The pull request an editor starts from: the established detail when it is
  // ready, otherwise the row itself. Never starts a fetch of its own.
  function currentPullRequest(row) {
    if (!row) return null;
    const number = numOf(row);
    const entry = Number.isFinite(number) ? details.get(number) : null;
    if (entry && entry.status === 'ready' && entry.pullRequest) return entry.pullRequest;
    return row;
  }

  function titleText() {
    return '◈ Pull requests';
  }

  function clampScroll(total) {
    const max = Math.max(0, total - Math.max(1, bodyRows));
    if (state.scroll > max) state.scroll = max;
    if (state.scroll < 0) state.scroll = 0;
  }

  function detailWrap(width) {
    return (text) => defaultWrapCache.wrap(String(text ?? ''), width);
  }

  // S6: the published ranges are the preview's own, so the click targets are the
  // numbers it painted — never a search of the rendered text.
  function detailLines(row, width, links, hover = null) {
    const entry = ensurePullRequest(row);
    if (!entry) return [paint(theme, 'muted', '(no pull request selected)')];
    if (entry.status === 'error') return [paint(theme, 'error', `unreadable: ${entry.error}`)];
    const pullRequest = entry.pullRequest || row;
    const paintRole = (role, text) => paint(theme, role, text);
    const emphasis = (text) => emphasize(theme, text);
    const wrap = detailWrap(width);
    if (entry.status !== 'ready') {
      return pullRequestDetailLines(pullRequest, [], {
        width,
        pending: true,
        paint: paintRole,
        emphasis,
        wrap,
      });
    }
    const comments = Array.isArray(entry.comments) ? entry.comments : [];
    return pullRequestDetailLines(pullRequest, comments, {
      width,
      paint: paintRole,
      emphasis,
      wrap,
      links,
      measure: (text) => measure(helpers, text),
      // S6: the hovered number is the same formatter's target, so the painted
      // highlight and the clickable cell are one answer.
      hover,
    });
  }

  function subModeKeys() {
    if (state.mode === 'labels') {
      if (labelsLoading) return BACK_KEYS;
      if (state.labelCreating) return LABEL_CREATE_KEYS;
      return LABEL_EDITOR_KEYS.filter((entry) => !entry.needsCreate || Boolean(labelDraft && labelDraft.createAllowed));
    }
    if (state.mode === 'assignees') return assigneesLoading ? BACK_KEYS : ASSIGNEE_EDITOR_KEYS;
    if (state.mode === 'comment') return state.discardAsk ? COMMENT_DISCARD_KEYS : COMMENT_EDITOR_KEYS;
    if (state.mode === 'merge') return MERGE_KEYS;
    if (state.mode === 'linkedIssues') {
      if (!linkedDraft || linkedDraft.view === 'toggles') return LINKED_EDITOR_KEYS;
      if (linkedDraft.candidatesLoading && linkedDraft.candidates.length === 0) return BACK_KEYS;
      return LINKED_CANDIDATE_KEYS;
    }
    return null;
  }

  // S2/D22: the pane line that names the pull request a step captured. It is
  // reserved a body row, because it is the one line that says WHERE the write
  // goes.
  function anchorLineIndex(lines) {
    const wanted = state.mode === 'merge' ? 'Confirm merge #'
      : state.mode === 'confirm' ? 'Confirm close #'
        : state.mode === 'comment' ? 'Comment on #' : null;
    if (wanted === null) return -1;
    return lines.findIndex((line) => stripAnsi(line).includes(wanted));
  }

  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    const title = titleText();
    if (w < MIN_WIDTH || height < 4) {
      return [pad(helpers, fit(helpers, `${title} — enlarge the terminal`, w), w)];
    }
    if (state.page >= pages.length) state.page = 0;
    clampSelection();
    frame = { width: w, height, ranges: [] };
    // CARD_PADDING covers the frame's own `│ ` and ` │` cells, so this inner
    // width fills the terminal exactly (no trailing slack, corners aligned).
    const inner = Math.max(1, w - CARD_PADDING);
    const panes = layout.paneWidths(inner, { listShare: layout.READER_LIST_SHARE });
    const listWidth = panes.left;
    const rightWidth = panes.right;
    listWidthCache = listWidth;
    rightWidthCache = rightWidth;
    bodyRows = Math.max(1, height - 6);
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    const permissions = permissionsFor(selected());
    const documentScroll = palette.scrollHint(scrollKeys.previewScrollKeys(), 'scroll');
    const subMode = state.searching ? null : subModeKeys();
    const pullRequestAvailable = pullRequestReady(selected());
    const footerKeys = state.searching
      ? SEARCH_KEYS
      : subMode || [FOOTER_KEYS[0], documentScroll, ...FOOTER_KEYS.slice(1)]
        .filter((entry) => entry
          && (!entry.needsIssue || pullRequestAvailable)
          && (!entry.requires || permissions[entry.requires] === true))
        .map((entry) => (entry.shortcut === true ? shortcutHint(insideLazyView()) : entry));
    const footerCell = () => `${border('│')} ${pad(helpers, palette.legendRow(theme, footerKeys, inner, (text) => measure(helpers, text)), inner)} ${border('│')}`;
    const lines = [];
    const topLeft = `${border('╭─')} ${palette.title(theme, title)} `;
    const topRight = border('─╮');
    lines.push(`${topLeft}${border('─'.repeat(Math.max(0, w - measure(helpers, topLeft) - measure(helpers, topRight))))}${topRight}`);
    const searchLine = () => `${border('│')} ${pad(helpers, searchWidget(inner), inner)} ${border('│')}`;

    const loadError = state.loadError || (options.loadError ? String(options.loadError) : null);
    if (options.ghAvailable === false) {
      lines.push(searchLine());
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'error', 'gh unavailable: install gh and authenticate to use /prs'), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }
    if (loadError && !state.loading && filteredRows().length === 0) {
      lines.push(searchLine());
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'error', `failed to load pull requests: ${loadError}`), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }
    const activeBucket = pages[state.page] || null;
    const bucketLoaded = Boolean(activeBucket && Array.isArray(activeBucket.rows));
    if (state.loading && (pages.length === 0 || (serverMode && !bucketLoaded))) {
      lines.push(searchLine());
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'muted', 'loading pull requests…'), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }

    lines.push(searchLine());
    const barIndices = insideLazyView() ? [lazyPageIndex()] : tabPageIndices();
    const tabs = barIndices.map((at) => {
      const page = pages[at];
      const active = at === state.page;
      const name = `${active ? '▸ ' : ''}${page.label}`;
      const tabTotal = ` (${tabCount(page)})`;
      if (!active) return palette.count(theme, `${name}${tabTotal}`);
      return `${palette.title(theme, name)}${palette.count(theme, tabTotal)}`;
    }).join(paint(theme, 'border', ' │ '));
    lines.push(`${border('│')} ${pad(helpers, tabs, inner)} ${border('│')}`);

    const savingNote = state.saving ? paint(theme, 'accent', saveLabel(state.saving)) : '';
    const errorNote = savingNote || (actionError ? paint(theme, 'error', actionError)
      : (loadError ? paint(theme, 'error', String(loadError)) : ''));
    const note = errorNote || (notice ? paint(theme, 'accent', notice) : '')
      || (state.searchPending ? paint(theme, 'muted', 'searching…') : '')
      || (state.loading ? paint(theme, 'muted', 'loading…') : '')
      || lazyReadNote();
    lines.push(`${border('│')} ${pad(helpers, note, inner)} ${border('│')}`);

    const list = filteredRows();
    const focused = selected();
    if (focused) ensurePullRequest(focused);
    const costs = list.map((row) => listRowCost(row, listWidth));
    // S2 (D12, D17, D18): a confirmation and the composer each name ONE pull
    // request, so that row — not whatever a reload left under the cursor — is
    // the one the list highlights, and the window follows it when a reload moved
    // it out of sight. A row the list no longer holds cannot be highlighted; the
    // step's own line still names it.
    let targetNumber = null;
    if (state.mode === 'merge' && mergeDraft) targetNumber = mergeDraft.number;
    else if (state.mode === 'confirm' && state.confirm) targetNumber = state.confirm.number;
    else if (state.mode === 'comment' && Number.isFinite(state.commentNumber)) targetNumber = state.commentNumber;
    const targetIndex = targetNumber === null ? -1 : list.findIndex((row) => numOf(row) === targetNumber);
    const bounds = layout.scrollWindow(costs, {
      budget: Math.max(1, bodyRows),
      index: targetIndex >= 0 ? targetIndex : state.index,
      start: state.listStart,
    });
    state.listStart = bounds.start;
    if (serverMode && activeBucket) {
      const rt = bucketState(activeBucket);
      rt.start = bounds.start;
      rt.index = state.index;
    }
    const leftLines = [];
    for (let at = bounds.start; at < bounds.end; at += 1) {
      const isFocused = targetNumber === null ? at === state.index : numOf(list[at]) === targetNumber;
      const rows = layout.wrapLabel(helpers, listTitle(list[at]), listWidth, { first: isFocused ? '▸ ' : '  ' });
      for (const row of rows) leftLines.push(highlight(theme, pad(helpers, row, listWidth), isFocused));
    }

    const paneLinks = [];
    let rightSource;
    if (state.mode === 'labels') {
      rightSource = labelEditorLines(rightWidth);
    } else if (state.mode === 'assignees') {
      rightSource = assigneeEditorLines(rightWidth);
    } else if (state.mode === 'comment') {
      rightSource = commentLines(rightWidth);
    } else if (state.mode === 'confirm') {
      rightSource = confirmLines(rightWidth);
    } else if (state.mode === 'merge') {
      rightSource = mergeLines(rightWidth);
    } else if (state.mode === 'linkedIssues') {
      rightSource = linkedIssuesLines(rightWidth);
    } else if (list.length === 0) {
      if (state.searchPending || state.loading) {
        rightSource = [paint(theme, 'muted', 'loading pull requests…')];
      } else if (state.query) {
        rightSource = [paint(theme, 'muted', 'no pull requests match this filter')];
      } else {
        rightSource = [paint(theme, 'muted', 'no pull requests'), paint(theme, 'dim', 'nothing to show here')];
      }
    } else {
      const paneHover = hoverPullRequest !== null && hoverPullRequest === numOf(focused) ? hoverNumber : null;
      rightSource = detailLines(focused, rightWidth, paneLinks, paneHover);
    }
    clampScroll(rightSource.length);
    const visible = rightSource.slice(state.scroll, state.scroll + bodyRows);
    // S2/D22: the captured target's own line is RESERVED a row that no scroll
    // window can clip: when the window would leave it out, it takes the first
    // row (anchor above the window) or the last one (anchor below it).
    const anchor = anchorLineIndex(rightSource);
    if (anchor >= 0 && visible.length > 0) {
      const first = state.scroll;
      const last = state.scroll + visible.length - 1;
      if (anchor < first) visible[0] = rightSource[anchor];
      else if (anchor > last) visible[visible.length - 1] = rightSource[anchor];
    }
    // S6: only the ranges that are actually painted can be clicked, mapped from
    // the pane's own line index to this frame's row and column.
    for (const link of paneLinks) {
      const rowIndex = link.line - state.scroll;
      if (rowIndex < 0 || rowIndex >= bodyRows) continue;
      frame.ranges.push({
        y: BODY_TOP + rowIndex,
        startX: PANE_LEFT + listWidth + link.start,
        endX: PANE_LEFT + listWidth + link.end,
        number: link.number,
      });
    }
    for (let row = 0; row < bodyRows; row += 1) {
      const left = pad(helpers, leftLines[row] ?? '', listWidth);
      const right = pad(helpers, visible[row] ?? '', rightWidth);
      lines.push(`${border('│')} ${left} ${divider} ${right} ${border('│')}`);
    }
    lines.push(footerCell());
    lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
    return lines.map((line) => pad(helpers, line, w));
  }

  // S3/D3: the count a tab names. Row-derived counts are marked inexact exactly
  // like issues; a bucket nobody has read is UNKNOWN, never an invented zero.
  function tabCount(page) {
    const rows = Array.isArray(page.rows) ? page.rows : null;
    const rt = page.rt;
    if (serverMode && !rowsAnswerCurrentQuery(page)) return '–';
    const open = rows ? rows.filter((row) => rowState(row) === 'open') : null;
    const honorsState = !rows || open.length === rows.length;
    const searchRead = page.lazy === true && hasFilter(rt && rt.rowsQuery);
    if (page.total != null && honorsState) {
      const inexact = page.lazy === true ? searchRead : page.truncated === true;
      return `${page.total}${inexact ? '+' : ''}`;
    }
    if (rows === null && page.total == null) return '–';
    const count = open ? open.length : 0;
    const inexact = page.lazy === true ? true : page.truncated === true;
    return `${count}${inexact ? '+' : ''}`;
  }

  // S5: the lazy view says which read is on screen — the exact connection or a
  // capped search — on the note row the frame already paints.
  function lazyReadNote() {
    const lazyAt = lazyPageIndex();
    if (lazyAt < 0 || state.page !== lazyAt) return '';
    const rt = bucketState(pages[lazyAt]);
    return paint(theme, 'muted', hasFilter(rt.rowsQuery) ? 'via search (total capped)' : 'via connection (exact total)');
  }

  // ---- sub-modes ---------------------------------------------------------

  function openLabelEditor() {
    const row = selected();
    if (!row) return;
    const permissions = permissionsFor(row);
    if (!permissions.canEditLabels) {
      actionError = 'labels cannot be edited: this repository permission is missing';
      repaint();
      return;
    }
    const labels = currentLabels(row);
    labelDraft = {
      number: numOf(row),
      selected: new Set(labels),
      original: new Set(labels),
      created: [],
      createAllowed: permissions.canCreateLabels,
    };
    state.mode = 'labels';
    state.labelIndex = 0;
    state.labelCreating = false;
    state.createName = '';
    actionError = null;
    state.scroll = 0;
    requestLabels();
    repaint();
  }

  function currentLabels(row) {
    const pullRequest = currentPullRequest(row);
    return (pullRequest && Array.isArray(pullRequest.labels) ? pullRequest.labels : []).map(labelName).filter(Boolean);
  }

  function labelEditorLines(width) {
    const out = [emphasize(theme, 'Labels')];
    if (!labelDraft) return out;
    if (labelsLoading) {
      out.push(paint(theme, 'muted', 'loading labels…'));
      return out;
    }
    if (labelsError) out.push(paint(theme, 'error', `labels unreadable: ${labelsError}`));
    const names = repoLabels.map((label) => label.name);
    const rows = labelDraft.createAllowed ? [...names, '+ create new…'] : names.slice();
    rows.forEach((name, at) => {
      const isCreate = labelDraft.createAllowed && at === rows.length - 1;
      const on = !isCreate && labelDraft.selected.has(name);
      const cursor = at === state.labelIndex ? '▸ ' : '  ';
      if (isCreate && state.labelCreating) {
        out.push(...wrapText(`${cursor}new: ${state.createName}█`, width));
      } else {
        out.push(...wrapText(`${cursor}[${on ? 'x' : ' '}] ${name}`, width));
      }
    });
    if (labelDraft.created.length > 0) out.push(...wrapText(`new labels: ${labelDraft.created.join(', ')}`, width));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function requestLabels() {
    if (typeof loadLabels !== 'function' || labelsLoaded || labelsLoading) return;
    labelsLoading = true;
    labelsError = null;
    repaint();
    let pending = null;
    try {
      pending = loadLabels();
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'labels unreadable' };
    }
    const settle = (result) => {
      labelsLoading = false;
      if (result && result.ok === true && Array.isArray(result.labels)) {
        repoLabels = result.labels.map((label) => ({ name: labelName(label) })).filter((label) => label.name);
        labelsLoaded = true;
        labelsError = null;
      } else {
        labelsError = (result && (result.error || result.loadError)) || 'labels unreadable';
      }
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'labels unreadable' });
    });
  }

  function openAssigneeEditor() {
    const row = selected();
    if (!row) return;
    if (!permissionsFor(row).canEditAssignees) {
      actionError = 'assignees cannot be edited: this repository permission is missing';
      repaint();
      return;
    }
    const current = currentAssignees(row);
    assigneeDraft = { number: numOf(row), selected: new Set(current), original: new Set(current) };
    state.mode = 'assignees';
    state.assigneeIndex = 0;
    actionError = null;
    state.scroll = 0;
    requestAssignees();
    repaint();
  }

  function currentAssignees(row) {
    const pullRequest = currentPullRequest(row);
    return (pullRequest && Array.isArray(pullRequest.assignees) ? pullRequest.assignees : [])
      .map(assigneeName)
      .filter(Boolean);
  }

  // Every assignable user, plus any current assignee the user list does not
  // carry, so an unexpected name can still be removed.
  function assigneeRows() {
    const logins = assigneeUsers.map((user) => user.login);
    for (const login of (assigneeDraft ? assigneeDraft.original : [])) {
      if (!logins.includes(login)) logins.push(login);
    }
    return logins;
  }

  function assigneeEditorLines(width) {
    const out = [emphasize(theme, 'Assignees')];
    if (!assigneeDraft) return out;
    if (assigneesLoading) {
      out.push(paint(theme, 'muted', 'loading assignees…'));
      return out;
    }
    if (assigneesError) out.push(paint(theme, 'error', `assignees unreadable: ${assigneesError}`));
    const logins = assigneeRows();
    logins.forEach((login, at) => {
      const on = assigneeDraft.selected.has(login);
      const user = assigneeUsers.find((candidate) => candidate.login === login);
      const cursor = at === state.assigneeIndex ? '▸ ' : '  ';
      const label = user && user.name && user.name !== login ? `${login} (${user.name})` : login;
      out.push(...wrapText(`${cursor}[${on ? 'x' : ' '}] ${label}`, width));
    });
    if (logins.length === 0) out.push(paint(theme, 'muted', 'no assignable users'));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function requestAssignees() {
    if (typeof loadAssignees !== 'function' || assigneesLoaded || assigneesLoading) return;
    assigneesLoading = true;
    assigneesError = null;
    repaint();
    let pending = null;
    try {
      pending = loadAssignees();
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'assignees unreadable' };
    }
    const settle = (result) => {
      assigneesLoading = false;
      if (result && result.ok === true && Array.isArray(result.users)) {
        assigneeUsers = result.users.map(assigneeOption).filter(Boolean);
        assigneesLoaded = true;
        assigneesError = null;
      } else {
        assigneesError = (result && (result.error || result.loadError)) || 'assignees unreadable';
      }
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'assignees unreadable' });
    });
  }

  function commentLines(width) {
    // S2/D18: the composer names the number it will comment on, so what the
    // reader sees is where the comment goes.
    const number = Number.isFinite(state.commentNumber) ? state.commentNumber : null;
    const out = [emphasize(theme, number === null ? 'Comment' : `Comment on #${number}`)];
    if (state.discardAsk) out.push(paint(theme, 'error', 'Discard this draft?'));
    const rows = wrapText(state.commentText, width);
    const caret = paint(theme, 'accent', '█');
    const last = rows.at(-1) ?? '';
    if (measure(helpers, last) >= width) rows.push(caret);
    else rows.splice(-1, 1, `${last}${caret}`);
    out.push(...rows);
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function confirmLines(width) {
    const number = state.confirm ? state.confirm.number : null;
    const out = [emphasize(theme, `Confirm close #${number === null ? '' : number} (enter confirm · esc cancel)`)];
    out.push(...wrapText('This will close the pull request on GitHub.', width));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  // The caret row of a text field: it sits at the real insertion point, on the
  // wrapped row typing would continue on.
  function fieldRows(text, focused, width) {
    const rows = wrapText(text, width);
    if (!focused) return rows;
    const caret = paint(theme, 'accent', '█');
    const last = rows.at(-1) ?? '';
    if (measure(helpers, last) >= width) rows.push(caret);
    else rows.splice(-1, 1, `${last}${caret}`);
    return rows;
  }

  function mergeLines(width) {
    const out = [emphasize(theme, 'Merge')];
    if (!mergeDraft) return out;
    const method = mergeDraft.methods[mergeDraft.methodIndex];
    const texts = mergeDraft.texts[method] || { subject: '', body: '' };
    const offered = mergeFieldRows();
    const marker = (field) => (state.mergeField === field ? '▸ ' : '  ');
    const typeRow = mergeDraft.methods.length > 1 ? `◂ ${method} ▸` : method;
    out.push(...wrapText(`${marker(0)}Type: ${typeRow}`, width));
    // S2/D12: a rebase merge rewrites the commits it replays, so it takes neither
    // a subject nor a description and neither field is offered at all.
    if (offered.includes(1)) {
      out.push(`${marker(1)}Commit message:`);
      out.push(...fieldRows(texts.subject, state.mergeField === 1, width));
    }
    if (offered.includes(2)) {
      out.push(`${marker(2)}Description:`);
      out.push(...fieldRows(texts.body, state.mergeField === 2, width));
    }
    // S2/D12: the confirmation names the pull request it will merge, exactly like
    // the close confirmation names its own.
    out.push(`${marker(3)}Confirm merge #${mergeDraft.number}`);
    out.push(`${marker(4)}Cancel`);
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  // The rows the merge step offers, in painting order: the type, the two
  // proposal fields when the method takes them, the confirm and the cancel.
  function mergeFieldRows() {
    const method = mergeDraft ? mergeDraft.methods[mergeDraft.methodIndex] : 'merge';
    return method === 'rebase' ? [0, 3, 4] : [0, 1, 2, 3, 4];
  }

  function moveMergeField(step) {
    const offered = mergeFieldRows();
    const at = offered.indexOf(state.mergeField);
    const from = at < 0 ? 0 : at;
    state.mergeField = offered[(from + step + offered.length) % offered.length];
  }

  // T20: the candidate rows, in the ONE order the list paints: the numbers the
  // draft already holds first (ascending, so the pull request's own links keep
  // their familiar order), then every other page row in the seam's own
  // hottest-updated order. A number that is already listed is never repeated.
  function linkedCandidateRows() {
    if (!linkedDraft) return [];
    const rows = [];
    const seen = new Set();
    const numbers = linkedDraft.numbers.slice().sort((left, right) => left - right);
    for (const number of numbers) {
      if (seen.has(number)) continue;
      seen.add(number);
      rows.push({ number, title: linkedDraft.titles.get(number) || '' });
    }
    for (const row of linkedDraft.candidates) {
      if (seen.has(row.number)) continue;
      seen.add(row.number);
      rows.push({ number: row.number, title: row.title });
    }
    return rows;
  }

  // T20: the candidate pane, built once for painting AND for the focus window so
  // the two can never disagree about how many lines a wrapped title costs.
  function linkedCandidateView(width) {
    const box = { lines: [], starts: [], heights: [] };
    const out = [emphasize(theme, 'Add issues')];
    const rows = linkedCandidateRows();
    if (linkedDraft.candidatesLoading && rows.length === 0) {
      out.push(paint(theme, 'muted', 'loading issues…'));
      box.lines = out;
      return box;
    }
    if (linkedDraft.candidatesError) out.push(paint(theme, 'error', `issues unreadable: ${linkedDraft.candidatesError}`));
    if (rows.length === 0) out.push(paint(theme, 'muted', 'no open issues'));
    rows.forEach((row, at) => {
      const on = linkedDraft.selected.has(row.number);
      const cursor = at === linkedDraft.candidateIndex ? '▸ ' : '  ';
      const painted = wrapText(`${cursor}[${on ? 'x' : ' '}] ${issueRowText(row.number, row.title)}`, width);
      box.starts.push(out.length);
      box.heights.push(painted.length);
      out.push(...painted);
    });
    if (linkedDraft.candidatesLoading && rows.length > 0) out.push(paint(theme, 'muted', 'loading more issues…'));
    box.lines = out;
    return box;
  }

  function linkedIssuesLines(width) {
    if (!linkedDraft) return [emphasize(theme, 'Linked issues')];
    if (linkedDraft.view === 'candidates') return linkedCandidateView(width).lines;
    const out = [emphasize(theme, 'Linked issues')];
    if (linkedDraft.candidatesError) out.push(paint(theme, 'error', `issues unreadable: ${linkedDraft.candidatesError}`));
    if (linkedDraft.numbers.length === 0) out.push(paint(theme, 'muted', 'no linked issues'));
    linkedDraft.numbers.forEach((number, at) => {
      const on = linkedDraft.selected.has(number);
      const cursor = at === linkedDraft.index ? '▸ ' : '  ';
      out.push(...wrapText(`${cursor}[${on ? 'x' : ' '}] ${issueRowText(number, linkedDraft.titles.get(number) || '')}`, width));
    });
    out.push(...wrapText('closes #N lines in the body', width));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  // T20: ONE cursor page of the repository's open issues through the injected
  // seam, read once when the editor opens (for the titles of the links it
  // already holds) and again, appended, as the candidate list scrolls. Only the
  // newest read for the draft may paint. A page is the pane's row budget,
  // derived from the frame the same way `bodyRows` is, so the seam is asked for
  // a page the pane can actually show even before the first repaint.
  function candidatePageSize() {
    return Math.max(1, Math.min(100, availableRows() - 6));
  }

  function requestIssueCandidates(draft, requestOptions = {}) {
    if (!draft || candidateLoaderFn === null) return false;
    const append = Boolean(requestOptions) && requestOptions.append === true;
    if (append) {
      if (!draft.candidatesLoaded || draft.candidatesLoading || !draft.candidatesHasMore
        || draft.candidatesCursor === null) return false;
    } else if (draft.candidatesLoading || draft.candidatesLoaded) {
      return false;
    }
    const after = append ? draft.candidatesCursor : null;
    const seq = draft.candidateSeq + 1;
    draft.candidateSeq = seq;
    draft.candidatesLoading = true;
    draft.candidatesError = null;
    repaint();
    let pending = null;
    try {
      pending = candidateLoaderFn({ after, pageSize: candidatePageSize() });
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'issues unreadable' };
    }
    const settle = (result) => {
      if (!active || draft.candidateSeq !== seq) return;
      draft.candidatesLoading = false;
      const normalized = normalizeIssueCandidatePage(result);
      if (!normalized.ok) {
        draft.candidatesError = normalized.error;
        repaint();
        return;
      }
      for (const row of normalized.rows) {
        if (!draft.titles.has(row.number)) draft.titles.set(row.number, row.title);
      }
      const held = append ? draft.candidates.slice() : [];
      const seen = new Set(held.map((row) => row.number));
      for (const row of normalized.rows) {
        if (seen.has(row.number)) continue;
        seen.add(row.number);
        held.push(row);
      }
      draft.candidates = held;
      draft.candidatesHasMore = normalized.hasMore;
      draft.candidatesCursor = normalized.cursor;
      draft.candidatesLoaded = true;
      draft.candidatesError = null;
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'issues unreadable' });
    });
    return true;
  }

  function openMerge() {
    const row = selected();
    if (!row) return;
    const permissions = permissionsFor(row);
    if (!permissions.canMerge) {
      actionError = 'pull requests cannot be merged: this repository permission is missing';
      repaint();
      return;
    }
    const pullRequest = currentPullRequest(row);
    const methods = allowedMergeMethods(pullRequest);
    if (methods.length === 0) {
      actionError = 'pull requests cannot be merged: this repository permission is missing';
      repaint();
      return;
    }
    mergeDraft = {
      number: numOf(row),
      methods,
      methodIndex: 0,
      texts: mergeTextDefaults(pullRequest),
    };
    state.mode = 'merge';
    state.mergeField = 0;
    actionError = null;
    state.scroll = 0;
    repaint();
  }

  function cancelMerge() {
    state.mode = 'list';
    mergeDraft = null;
    actionError = null;
    repaint();
  }

  function openLinkedEditor() {
    const row = selected();
    if (!row) return;
    if (!permissionsFor(row).canEditLinkedIssues) {
      actionError = 'linked issues cannot be edited: this repository permission is missing';
      repaint();
      return;
    }
    const pullRequest = currentPullRequest(row);
    const numbers = (pullRequest && Array.isArray(pullRequest.linkedIssues) ? pullRequest.linkedIssues : [])
      .filter((number) => Number.isInteger(number) && number > 0)
      .slice()
      .sort((left, right) => left - right);
    linkedDraft = {
      number: numOf(row),
      numbers,
      index: 0,
      selected: new Set(numbers),
      original: new Set(numbers),
      // T20: the number→title answers the seam already gave, so the toggles and
      // the candidate list name every issue the same way.
      titles: new Map(),
      view: 'toggles',
      candidateIndex: 0,
      candidates: [],
      candidatesLoaded: false,
      candidatesLoading: false,
      candidatesError: null,
      candidatesHasMore: false,
      candidatesCursor: null,
      candidateSeq: 0,
      candidateBase: null,
    };
    state.mode = 'linkedIssues';
    actionError = null;
    state.scroll = 0;
    // T20: the links' titles are read ONCE, through the same candidate seam; a
    // failure paints its error and leaves the toggles exactly as they are.
    requestIssueCandidates(linkedDraft);
    repaint();
  }

  // S2: closing is a repository capability, resolved BEFORE the confirmation
  // opens, so an unpermitted viewer never reaches the write.
  function openCloseConfirm() {
    const row = selected();
    if (!row) return;
    if (!permissionsFor(row).canClosePullRequests) {
      actionError = 'pull requests cannot be closed: this repository permission is missing';
      repaint();
      return;
    }
    state.mode = 'confirm';
    // S2 (D1): the confirmation names the pull request it showed, and the write
    // acts on THAT number however a reload rearranged the rows behind it.
    state.confirm = { action: 'close', number: numOf(row) };
    actionError = null;
    repaint();
  }

  function moveSelection(step) {
    const total = filteredRows().length;
    if (total === 0) return;
    state.index = (state.index + step + total) % total;
    state.scroll = 0;
    actionError = null;
    ensurePullRequest(selected());
    if (step > 0 && state.index === total - 1) loadMoreRows();
    repaint();
  }

  function activatePage(index) {
    if (pages.length === 0) return;
    const at = Math.floor(Number(index));
    state.page = Number.isFinite(at) ? Math.max(0, Math.min(pages.length - 1, at)) : 0;
    state.index = 0;
    state.listStart = 0;
    state.scroll = 0;
    state.searching = false;
    actionError = null;
    // S5/S6 (D7): the pinned numbered open belongs to the bucket it opened in;
    // a tab the reader chose paints that bucket alone.
    pinnedNumber = null;
    if (serverMode) {
      const rt = bucketState(pages[state.page]);
      state.loadError = null;
      if (rt.query === String(state.query || '') && (rt.loaded || rt.loading)) {
        state.loading = rt.loading;
        state.listStart = Math.max(0, Math.floor(Number(rt.start) || 0));
        state.index = Math.max(0, Math.floor(Number(rt.index) || 0));
        clampSelection();
        ensurePullRequest(selected());
        repaint();
        return;
      }
      requestBucketPage(state.page, {});
      return;
    }
    ensurePullRequest(selected());
    repaint();
  }

  function switchPage(step) {
    if (pages.length === 0) return;
    const tabs = tabPageIndices();
    const at = tabs.indexOf(state.page);
    if (at < 0) return;
    activatePage(tabs[(at + step + tabs.length) % tabs.length]);
  }

  // S1: the shortcut enters the lazy view and, pressed again, returns to the tab
  // the reader came from.
  function toggleLazyView() {
    const lazyAt = lazyPageIndex();
    if (lazyAt < 0) return;
    if (state.page === lazyAt) {
      const tabs = tabPageIndices();
      const previous = tabs.includes(state.allFrom) ? state.allFrom : tabs[0];
      state.allFrom = null;
      activatePage(previous);
      return;
    }
    state.allFrom = state.page;
    activatePage(lazyAt);
  }

  function scrollList(step) {
    const list = filteredRows();
    if (list.length === 0) return;
    const costs = list.map((row) => listRowCost(row, listWidthCache));
    const budget = Math.max(1, bodyRows);
    const target = layout.shiftWindow(costs, { budget, start: state.listStart, step });
    if (target !== state.listStart) {
      state.listStart = target;
      const win = layout.scrollWindow(costs, { budget, index: target, start: target });
      state.listStart = win.start;
      if (state.index < win.start || state.index >= win.end) {
        state.index = win.start;
        state.scroll = 0;
        ensurePullRequest(selected());
      }
      if (serverMode) {
        const bucket = pages[state.page];
        if (bucket) bucketState(bucket).start = state.listStart;
      }
    }
    if (step > 0) loadMoreRows();
    repaint();
  }

  // S10: the one-line description of the write in flight.
  const SAVE_LABELS = {
    labels: 'saving labels…',
    assignees: 'saving assignees…',
    comment: 'posting comment…',
    close: 'closing pull request…',
    merge: 'merging pull request…',
    linkedIssues: 'saving linked issues…',
  };

  function saveLabel(kind) {
    return SAVE_LABELS[kind] || 'saving…';
  }

  function beginSave(kind) {
    state.saving = kind;
    actionError = null;
    notice = null;
    repaint();
  }

  function settleSave(pending, onOk, onFail) {
    const finish = (result) => {
      if (!active) return;
      state.saving = null;
      if (result && result.ok === true) onOk(result);
      else onFail((result && result.error) || 'action failed');
    };
    Promise.resolve(pending).then(finish).catch((err) => {
      finish({ ok: false, error: (err && err.message) || 'action failed' });
    });
  }

  function applyLabels() {
    if (!labelDraft || state.saving !== null) return;
    const edit = actionFor(['editLabels', 'editPullRequestLabels']);
    if (edit === null) {
      actionError = 'label editing is unavailable';
      repaint();
      return;
    }
    const draft = labelDraft;
    const number = draft.number;
    const add = [...draft.selected].filter((name) => !draft.original.has(name));
    const remove = [...draft.original].filter((name) => !draft.selected.has(name));
    const created = draft.created.slice();
    beginSave('labels');
    // S2 (D3, D14, D26): the capability is re-read for the draft's own number at
    // save time — the NEWEST answer for it wins — so a permission the reload
    // revoked never reaches the write seam. Creating a repository label is its
    // own capability, decided on the same fresh read.
    const gate = freshGate(number, 'canEditLabels', {
      refusal: 'labels cannot be edited: this repository permission is missing',
      notOpen: `pull request #${number} is not open; its labels cannot be edited`,
    });
    settleCaptured(gate.then((verdict) => {
      if (verdict.ok !== true) return verdict;
      if (created.length > 0 && verdict.capabilities.canCreateLabels !== true) {
        return { ok: false, error: 'new labels cannot be created: this repository permission is missing', exit: true };
      }
      return runSeam(edit, number, add, remove, created);
    }), () => {
      const row = filteredRows().find((candidate) => numOf(candidate) === number);
      // The list row keeps the saved labels for its own display; the DETAIL
      // cache is dropped, never patched, so the pane reads GitHub again.
      if (row) row.labels = [...draft.selected].map((name) => ({ name }));
      labelDraft = null;
      state.mode = 'list';
      actionError = null;
      invalidateLoadedPages();
      refetchDetail(number);
      repaint();
    }, () => {
      labelDraft = null;
      state.mode = 'list';
    });
  }

  function applyAssignees() {
    if (!assigneeDraft || state.saving !== null) return;
    const edit = actionFor(['editAssignees']);
    if (edit === null) {
      actionError = 'assignee editing is unavailable';
      repaint();
      return;
    }
    const draft = assigneeDraft;
    const number = draft.number;
    const add = [...draft.selected].filter((login) => !draft.original.has(login));
    const remove = [...draft.original].filter((login) => !draft.selected.has(login));
    beginSave('assignees');
    // S2 (D3, D26): re-read for the draft's own number, exactly like the labels,
    // so an editor save never writes with a permission the reload revoked.
    const gate = freshGate(number, 'canEditAssignees', {
      refusal: 'assignees cannot be edited: this repository permission is missing',
      notOpen: `pull request #${number} is not open; its assignees cannot be edited`,
    });
    settleCaptured(gate.then((verdict) => (verdict.ok === true ? runSeam(edit, number, { add, remove }) : verdict)), () => {
      const row = filteredRows().find((candidate) => numOf(candidate) === number);
      if (row) row.assignees = [...draft.selected].map((login) => ({ login }));
      assigneeDraft = null;
      state.mode = 'list';
      actionError = null;
      invalidateLoadedPages();
      refetchDetail(number);
      repaint();
    }, () => {
      assigneeDraft = null;
      state.mode = 'list';
    });
  }

  // S2 (D11): the composer captures the number it was opened for, exactly like
  // the close and merge confirmations capture theirs. Commenting needs no
  // capability beyond read access, in every pull request state.
  function openCommentEditor() {
    const row = selected();
    if (!row) return;
    state.mode = 'comment';
    state.commentNumber = numOf(row);
    state.commentText = '';
    state.discardAsk = false;
    actionError = null;
    repaint();
  }

  function closeCommentEditor() {
    state.mode = 'list';
    state.commentText = '';
    state.commentNumber = null;
    state.discardAsk = false;
    actionError = null;
    repaint();
  }

  function postComment() {
    const post = actionFor(['commentPullRequest', 'postComment']);
    // S2/D11: the composer posts to the number it was opened on, never to
    // whatever row a reload left under the cursor.
    const number = Number.isFinite(state.commentNumber) ? state.commentNumber : NaN;
    if (post === null || !Number.isFinite(number)) {
      actionError = 'commenting is unavailable';
      repaint();
      return;
    }
    if (state.saving !== null) return;
    // S2/D22: a frame too short to hold `Comment on #N` refuses too.
    if (!stepRoomAvailable()) {
      actionError = STEP_TOO_SHORT;
      repaint();
      return;
    }
    const text = state.commentText;
    beginSave('comment');
    let result = null;
    try {
      result = post(number, text);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleSave(result, () => {
      state.mode = 'list';
      state.commentText = '';
      state.commentNumber = null;
      state.discardAsk = false;
      actionError = null;
      notice = 'comment posted';
      invalidateLoadedPages();
      refetchDetail(number);
      repaint();
    }, (error) => {
      actionError = error;
      repaint();
    });
  }

  function confirmClose() {
    const closePull = actionFor(['closePullRequest', 'close']);
    const confirm = state.confirm;
    if (closePull === null || !confirm || confirm.action !== 'close'
      || !Number.isFinite(confirm.number) || state.mode !== 'confirm') {
      actionError = 'closing is unavailable';
      repaint();
      return;
    }
    if (state.saving !== null) return;
    // S2/D22: a frame too short to hold `Confirm close #N` refuses instead of
    // acting on a line the reader cannot see.
    if (!stepRoomAvailable()) {
      actionError = STEP_TOO_SHORT;
      repaint();
      return;
    }
    // S2 (D1, D20): the write acts on the number the confirmation showed, and
    // that number's OWN detail — capability and state together — is re-read
    // before anything is sent, so a reload that substituted or removed the row
    // can neither redirect the close nor revive a lapsed permission.
    const number = confirm.number;
    beginSave('close');
    const gate = freshGate(number, 'canClosePullRequests', {
      refusal: 'pull requests cannot be closed: this repository permission is missing',
      notOpen: `pull request #${number} is not open; it cannot be closed`,
    });
    settleCaptured(gate.then((verdict) => (verdict.ok === true ? runSeam(closePull, number) : verdict)), () => {
      const closed = filteredRows().find((candidate) => numOf(candidate) === number);
      if (closed) closed.state = 'closed';
      const cached = details.get(number);
      if (cached && cached.pullRequest) cached.pullRequest = { ...cached.pullRequest, state: 'closed' };
      state.mode = 'list';
      state.confirm = null;
      actionError = null;
      notice = 'pull request closed';
      invalidateLoadedPages();
      clampSelection();
      repaint();
    }, () => {
      state.mode = 'list';
      state.confirm = null;
    });
  }

  function confirmMerge() {
    const merge = actionFor(['mergePullRequest', 'merge']);
    if (merge === null || !mergeDraft) {
      actionError = 'merging is unavailable';
      repaint();
      return;
    }
    if (state.saving !== null) return;
    // S2/D22: the same frame rule as the close confirmation.
    if (!stepRoomAvailable()) {
      actionError = STEP_TOO_SHORT;
      repaint();
      return;
    }
    const draft = mergeDraft;
    const number = draft.number;
    const method = draft.methods[draft.methodIndex];
    const texts = draft.texts[method] || { subject: '', body: '' };
    // S2: a rebase merge takes neither a subject nor a body, so neither is sent.
    const payload = method === 'rebase' ? { method } : { method, subject: texts.subject, body: texts.body };
    beginSave('merge');
    // S2 (D1, D20, D30): the step's own number is re-read before it merges, and
    // the method the form is holding has to be one the repository STILL allows,
    // so a method revoked while the form was open never reaches the seam.
    const gate = freshGate(number, 'canMerge', {
      refusal: 'pull requests cannot be merged: this repository permission is missing',
      notOpen: `pull request #${number} is not open; it cannot be merged`,
    });
    settleCaptured(gate.then((verdict) => {
      if (verdict.ok !== true) return verdict;
      const fresh = allowedMergeMethods(verdict.pullRequest);
      if (fresh.includes(method) !== true) {
        const sentence = fresh.length === 0
          ? `the repository allows no merge method for pull request #${number}`
          : `the repository no longer allows the ${JSON.stringify(method)} merge method (allowed: ${fresh.join(', ')})`;
        return { ok: false, error: sentence, exit: true };
      }
      return runSeam(merge, number, payload);
    }), () => {
      const target = filteredRows().find((candidate) => numOf(candidate) === number);
      if (target) target.state = 'closed';
      mergeDraft = null;
      state.mode = 'list';
      actionError = null;
      notice = 'merged';
      invalidateLoadedPages();
      clampSelection();
      repaint();
    }, () => {
      state.mode = 'list';
      mergeDraft = null;
    });
  }

  function applyLinkedIssues() {
    if (!linkedDraft || state.saving !== null) return;
    const edit = actionFor(['editLinkedIssues']);
    if (edit === null) {
      actionError = 'linked issue editing is unavailable';
      repaint();
      return;
    }
    const add = [...linkedDraft.selected].filter((number) => !linkedDraft.original.has(number));
    const remove = [...linkedDraft.original].filter((number) => !linkedDraft.selected.has(number));
    const number = linkedDraft.number;
    beginSave('linkedIssues');
    // S2 (D3, D20): the draft's own number is re-read before the body edit, so a
    // lapsed capability — or a pull request that is no longer open — writes
    // nothing at all.
    const gate = freshGate(number, 'canEditLinkedIssues', {
      refusal: 'linked issues cannot be edited: this repository permission is missing',
      notOpen: `pull request #${number} is not open; its linked issues cannot be edited`,
    });
    settleCaptured(
      gate.then((verdict) => (verdict.ok === true ? runSeam(edit, number, { add, remove }) : verdict)),
      () => {
        const row = filteredRows().find((candidate) => numOf(candidate) === number);
        if (row) row.linkedIssues = [...linkedDraft.selected].sort((left, right) => left - right);
        linkedDraft = null;
        state.mode = 'list';
        actionError = null;
        notice = 'linked issues updated';
        invalidateLoadedPages();
        refetchDetail(number);
        repaint();
      },
      () => {
        state.mode = 'list';
        linkedDraft = null;
      },
    );
  }

  // T20: the candidate list `n` opens. The draft's own links keep their place and
  // their checked state at the top, and `esc` restores this exact snapshot.
  function openCandidateList() {
    if (!linkedDraft || linkedDraft.view === 'candidates') return;
    linkedDraft.view = 'candidates';
    linkedDraft.candidateBase = {
      numbers: linkedDraft.numbers.slice(),
      selected: new Set(linkedDraft.selected),
    };
    linkedDraft.candidateIndex = 0;
    state.scroll = 0;
    actionError = null;
    // A failed first read is retried here instead of frozen: `candidatesLoaded`
    // only becomes true on a successful answer.
    requestIssueCandidates(linkedDraft);
    revealCandidate();
    repaint();
  }

  function closeCandidateList(keep) {
    if (!linkedDraft) return;
    if (!keep && linkedDraft.candidateBase) {
      linkedDraft.numbers = linkedDraft.candidateBase.numbers.slice();
      linkedDraft.selected = new Set(linkedDraft.candidateBase.selected);
    }
    linkedDraft.candidateBase = null;
    linkedDraft.view = 'toggles';
    linkedDraft.index = 0;
    state.scroll = 0;
    actionError = null;
    repaint();
  }

  // The draft's numbers stay sorted and unique, so a number the pull request
  // already links is toggled in place and never added a second time.
  function toggleLinkedNumber(number) {
    if (!linkedDraft || !Number.isInteger(number)) return;
    if (linkedDraft.selected.has(number)) {
      linkedDraft.selected.delete(number);
    } else {
      linkedDraft.selected.add(number);
      if (!linkedDraft.numbers.includes(number)) {
        linkedDraft.numbers.push(number);
        linkedDraft.numbers.sort((left, right) => left - right);
      }
    }
    if (linkedDraft.index >= linkedDraft.numbers.length) {
      linkedDraft.index = Math.max(0, linkedDraft.numbers.length - 1);
    }
    repaint();
  }

  function toggleCandidate() {
    const row = linkedCandidateRows()[linkedDraft.candidateIndex];
    if (!row) return;
    toggleLinkedNumber(row.number);
  }

  // The candidate focus and the painted window stay together: moving the focus
  // scrolls the pane to it, and scrolling the pane moves the focus to the first
  // row on screen.
  function revealCandidate() {
    if (!linkedDraft || linkedDraft.view !== 'candidates') return;
    const box = linkedCandidateView(Math.max(1, rightWidthCache));
    if (box.starts.length === 0) return;
    const at = Math.max(0, Math.min(linkedDraft.candidateIndex, box.starts.length - 1));
    const top = box.starts[at];
    const height = box.heights[at] || 1;
    const room = Math.max(1, bodyRows);
    if (top < state.scroll) state.scroll = top;
    else if (top + height > state.scroll + room) state.scroll = Math.max(0, top + height - room);
  }

  function focusVisibleCandidate() {
    if (!linkedDraft || linkedDraft.view !== 'candidates') return;
    const box = linkedCandidateView(Math.max(1, rightWidthCache));
    if (box.starts.length === 0) return;
    const room = Math.max(1, bodyRows);
    const current = Math.max(0, Math.min(linkedDraft.candidateIndex, box.starts.length - 1));
    if (box.starts[current] >= state.scroll && box.starts[current] < state.scroll + room) {
      linkedDraft.candidateIndex = current;
      return;
    }
    let at = 0;
    for (let index = 0; index < box.starts.length; index += 1) {
      at = index;
      if (box.starts[index] >= state.scroll) break;
    }
    linkedDraft.candidateIndex = at;
  }

  function moveCandidate(step) {
    const rows = linkedCandidateRows();
    if (rows.length === 0) return;
    linkedDraft.candidateIndex = Math.max(0, Math.min(rows.length - 1, linkedDraft.candidateIndex + step));
    if (step > 0 && linkedDraft.candidateIndex === rows.length - 1) {
      requestIssueCandidates(linkedDraft, { append: true });
    }
    revealCandidate();
    repaint();
  }

  // The panel's own scroll keys move the candidate window exactly like they move
  // the pane, and a downward step asks the seam for the next page.
  function scrollCandidate(action) {
    if (!linkedDraft) return;
    const page = Math.max(1, bodyRows - 1);
    const half = action === scrollKeys.ACTIONS.HALF_DOWN || action === scrollKeys.ACTIONS.HALF_UP;
    const down = action === scrollKeys.ACTIONS.PAGE_DOWN || action === scrollKeys.ACTIONS.HALF_DOWN;
    state.scroll = Math.max(0, state.scroll + (down ? 1 : -1) * (half ? Math.max(1, Math.floor(page / 2)) : page));
    if (down) requestIssueCandidates(linkedDraft, { append: true });
    focusVisibleCandidate();
    repaint();
  }

  // ---- search ------------------------------------------------------------

  function scheduleQueryRead(query) {
    cancelScheduledQuery();
    state.searchPending = true;
    const entry = { query, handle: null, fired: false };
    scheduledQuery = entry;
    const run = () => {
      if (entry.fired || scheduledQuery !== entry) return;
      entry.fired = true;
      scheduledQuery = null;
      state.searchPending = false;
      if (!active || query !== String(state.query || '')) return;
      readSettledQuery();
    };
    let handle = null;
    try {
      handle = scheduleFn(run, QUERY_DEBOUNCE_MS);
    } catch {
      run();
      return;
    }
    entry.handle = handle;
    repaint();
  }

  // S3/S4: a settled filter is what every scoped tab shows, so every scoped tab
  // reads it — not only the one on screen — and the lazy view reads it too when
  // it is the one on screen.
  function readSettledQuery() {
    if (!serverMode) return;
    tabPageIndices().forEach((index) => requestBucketPage(index, {}));
    if (insideLazyView()) requestBucketPage(state.page, {});
  }

  function cancelScheduledQuery() {
    if (scheduledQuery === null) return false;
    const { handle } = scheduledQuery;
    scheduledQuery = null;
    state.searchPending = false;
    try {
      cancelFn(handle);
    } catch {
      // A hostile scheduler never breaks the view.
    }
    return true;
  }

  function flushScheduledQuery() {
    if (scheduledQuery === null) return false;
    const { query } = scheduledQuery;
    cancelScheduledQuery();
    if (!active || !serverMode) return false;
    if (query !== String(state.query || '')) return false;
    readSettledQuery();
    return true;
  }

  function setQuery(next) {
    state.query = next;
    state.index = 0;
    state.listStart = 0;
    state.scroll = 0;
    if (serverMode) {
      const current = pages[state.page] || null;
      pages.forEach((page) => {
        const rt = bucketState(page);
        rt.loaded = false;
        rt.loading = false;
        rt.seq = ++pageSeq;
        if (page.lazy === true) {
          page.rows = null;
          page.total = null;
          page.truncated = false;
          rt.rowsQuery = null;
          rt.hasMore = false;
          rt.nextCursor = null;
          rt.error = null;
        }
      });
      if (current) {
        state.loading = false;
        state.loadError = null;
        scheduleQueryRead(state.query);
        return;
      }
    }
    repaint();
  }

  function handleSearchInput(data) {
    if (keyMatches(helpers, data, ['enter'])) {
      state.searching = false;
      state.index = 0;
      state.listStart = 0;
      state.scroll = 0;
      if (!flushScheduledQuery()) repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.searching = false;
      state.index = 0;
      state.listStart = 0;
      if (!flushScheduledQuery()) repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['delete'])) {
      setQuery('');
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      setQuery(state.query.slice(0, -1));
      return true;
    }
    if (typeof data === 'string' && data.length === 1) {
      setQuery(state.query + data);
      return true;
    }
    return false;
  }

  function handleLabelInput(data) {
    if (labelsLoading) {
      if (keyMatches(helpers, data, ['escape'])) {
        state.mode = 'list';
        labelDraft = null;
        actionError = null;
        repaint();
      }
      return true;
    }
    const names = repoLabels.map((label) => label.name);
    const createAllowed = Boolean(labelDraft && labelDraft.createAllowed);
    const rows = createAllowed ? names.length + 1 : names.length;
    if (state.labelCreating) {
      if (keyMatches(helpers, data, ['enter'])) {
        const name = state.createName.trim();
        if (name) {
          if (!names.includes(name) && !labelDraft.created.includes(name)) labelDraft.created.push(name);
          labelDraft.selected.add(name);
        }
        state.labelCreating = false;
        state.createName = '';
        repaint();
        return true;
      }
      if (keyMatches(helpers, data, ['escape'])) {
        state.labelCreating = false;
        state.createName = '';
        repaint();
        return true;
      }
      if (keyMatches(helpers, data, ['backspace'])) {
        state.createName = state.createName.slice(0, -1);
        repaint();
        return true;
      }
      if (typeof data === 'string' && data.length === 1) {
        state.createName += data;
        repaint();
        return true;
      }
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      applyLabels();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.mode = 'list';
      labelDraft = null;
      actionError = null;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      state.labelIndex = (state.labelIndex - 1 + rows) % rows;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      state.labelIndex = (state.labelIndex + 1) % rows;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['space', ' ', 'enter'])) {
      if (createAllowed && state.labelIndex === rows - 1) {
        state.labelCreating = true;
        state.createName = '';
      } else {
        const name = names[state.labelIndex];
        if (name) {
          if (labelDraft.selected.has(name)) labelDraft.selected.delete(name);
          else labelDraft.selected.add(name);
        }
      }
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['n'])) {
      if (!createAllowed) return true;
      state.labelCreating = true;
      state.createName = '';
      state.labelIndex = rows - 1;
      repaint();
      return true;
    }
    return false;
  }

  function handleAssigneeInput(data) {
    if (assigneesLoading) {
      if (keyMatches(helpers, data, ['escape'])) {
        state.mode = 'list';
        assigneeDraft = null;
        actionError = null;
        repaint();
      }
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      applyAssignees();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.mode = 'list';
      assigneeDraft = null;
      actionError = null;
      repaint();
      return true;
    }
    const logins = assigneeRows();
    if (logins.length === 0) return true;
    if (state.assigneeIndex >= logins.length) state.assigneeIndex = logins.length - 1;
    if (keyMatches(helpers, data, ['up', 'k'])) {
      state.assigneeIndex = (state.assigneeIndex - 1 + logins.length) % logins.length;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      state.assigneeIndex = (state.assigneeIndex + 1) % logins.length;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['space', ' ', 'enter'])) {
      const login = logins[state.assigneeIndex];
      if (login) {
        if (assigneeDraft.selected.has(login)) assigneeDraft.selected.delete(login);
        else assigneeDraft.selected.add(login);
      }
      repaint();
      return true;
    }
    return true;
  }

  function handleCommentInput(data) {
    if (state.discardAsk) {
      if (keyMatches(helpers, data, ['ctrl+s'])) {
        state.discardAsk = false;
        postComment();
        return true;
      }
      if (data === 'y' || (typeof data !== 'string' && keyMatches(helpers, data, ['y']))) {
        closeCommentEditor();
        return true;
      }
      if (keyMatches(helpers, data, ['n', 'escape'])) {
        state.discardAsk = false;
        repaint();
        return true;
      }
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      postComment();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      if (state.commentText !== '') {
        state.discardAsk = true;
        repaint();
        return true;
      }
      closeCommentEditor();
      return true;
    }
    if (keyMatches(helpers, data, ['enter'])) {
      state.commentText += '\n';
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      state.commentText = state.commentText.slice(0, -1);
      repaint();
      return true;
    }
    if (typeof data === 'string' && data.length === 1) {
      state.commentText += data;
      repaint();
      return true;
    }
    return false;
  }

  function handleMergeInput(data) {
    if (!mergeDraft) {
      state.mode = 'list';
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      confirmMerge();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      cancelMerge();
      return true;
    }
    // S2/D6: while a text field holds the focus every printable letter is TEXT,
    // so `j`/`k` never navigate the form mid-sentence; the arrows and tab alone
    // move between fields. S2/D12: a field the method does not take is not one of
    // the rows the focus can land on.
    const textField = state.mergeField === 1 || state.mergeField === 2;
    if (keyMatches(helpers, data, textField ? ['up'] : ['up', 'k'])) {
      moveMergeField(-1);
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, textField ? ['down', 'tab'] : ['down', 'j', 'tab'])) {
      moveMergeField(1);
      repaint();
      return true;
    }
    if (state.mergeField === 0 && mergeDraft.methods.length > 1
      && keyMatches(helpers, data, ['left', 'right', 'space', ' ', 'h', 'l'])) {
      const step = keyMatches(helpers, data, ['left', 'h']) ? -1 : 1;
      mergeDraft.methodIndex = (mergeDraft.methodIndex + step + mergeDraft.methods.length) % mergeDraft.methods.length;
      // The new method may not offer the field that had the focus.
      if (!mergeFieldRows().includes(state.mergeField)) state.mergeField = 0;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['enter'])) {
      if (state.mergeField === 3) {
        confirmMerge();
        return true;
      }
      if (state.mergeField === 4) {
        cancelMerge();
        return true;
      }
      moveMergeField(1);
      repaint();
      return true;
    }
    const method = mergeDraft.methods[mergeDraft.methodIndex];
    const texts = mergeDraft.texts[method];
    if (texts && (state.mergeField === 1 || state.mergeField === 2)) {
      const field = state.mergeField === 1 ? 'subject' : 'body';
      if (keyMatches(helpers, data, ['backspace'])) {
        texts[field] = texts[field].slice(0, -1);
        repaint();
        return true;
      }
      if (typeof data === 'string' && [...data].length === 1) {
        texts[field] += data;
        repaint();
        return true;
      }
    }
    return true;
  }

  // T20: the candidate list's own keys — the panel's scroll bindings, `space` on
  // the focused row, `enter` to keep the selection and `esc` to discard it.
  function handleCandidateInput(data) {
    if (linkedDraft.candidatesLoading && linkedCandidateRows().length === 0) {
      if (keyMatches(helpers, data, ['escape'])) closeCandidateList(false);
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      closeCandidateList(false);
      return true;
    }
    if (keyMatches(helpers, data, ['enter'])) {
      closeCandidateList(true);
      return true;
    }
    if (keyMatches(helpers, data, ['space', ' '])) {
      toggleCandidate();
      return true;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      moveCandidate(-1);
      return true;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      moveCandidate(1);
      return true;
    }
    const scrollAction = scrollKeys.resolveScrollAction(helpers, data);
    if (scrollAction) {
      scrollCandidate(scrollAction);
      return true;
    }
    // The list pane's own paging pair, so the candidate list scrolls with the
    // same keys even on a host with no scroll bindings.
    if (keyMatches(helpers, data, [']'])) {
      scrollCandidate(scrollKeys.ACTIONS.PAGE_DOWN);
      return true;
    }
    if (keyMatches(helpers, data, ['['])) {
      scrollCandidate(scrollKeys.ACTIONS.PAGE_UP);
      return true;
    }
    return true;
  }

  function handleLinkedInput(data) {
    if (!linkedDraft) {
      state.mode = 'list';
      return true;
    }
    if (linkedDraft.view === 'candidates') return handleCandidateInput(data);
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      applyLinkedIssues();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.mode = 'list';
      linkedDraft = null;
      actionError = null;
      repaint();
      return true;
    }
    const total = linkedDraft.numbers.length;
    if (keyMatches(helpers, data, ['up', 'k'])) {
      if (total > 0) linkedDraft.index = (linkedDraft.index - 1 + total) % total;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      if (total > 0) linkedDraft.index = (linkedDraft.index + 1) % total;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['space', ' ', 'enter'])) {
      const number = linkedDraft.numbers[linkedDraft.index];
      if (number !== undefined) toggleLinkedNumber(number);
      return true;
    }
    if (keyMatches(helpers, data, ['n'])) {
      openCandidateList();
      return true;
    }
    return true;
  }

  function handleInput(data) {
    if (isKeyRelease(helpers, data)) return;
    // S10: a pending write owns the keyboard.
    if (state.saving !== null) return;
    notice = null;
    // S1: the reader has the keyboard now; the opening selection is spent.
    pendingSelection = null;
    if (state.searching) {
      if (handleSearchInput(data)) return;
      return;
    }
    if (state.mode === 'labels') {
      if (handleLabelInput(data)) return;
      return;
    }
    if (state.mode === 'assignees') {
      handleAssigneeInput(data);
      return;
    }
    if (state.mode === 'comment') {
      if (handleCommentInput(data)) return;
      return;
    }
    if (state.mode === 'confirm') {
      if (keyMatches(helpers, data, ['enter', 'y'])) {
        confirmClose();
        return;
      }
      if (keyMatches(helpers, data, ['escape', 'n', 'q'])) {
        state.mode = 'list';
        state.confirm = null;
        actionError = null;
        repaint();
        return;
      }
      return;
    }
    if (state.mode === 'merge') {
      handleMergeInput(data);
      return;
    }
    if (state.mode === 'linkedIssues') {
      handleLinkedInput(data);
      return;
    }
    if (keyMatches(helpers, data, ['escape', 'ctrl+c', 'q'])) {
      close();
      return;
    }
    // D3/S10: tab and the arrows select the bucket; `]`/`[` scroll the list.
    if (keyMatches(helpers, data, ['tab'])) {
      flushScheduledQuery();
      switchPage(1);
      return;
    }
    if (keyMatches(helpers, data, ['shift+tab'])) {
      flushScheduledQuery();
      switchPage(-1);
      return;
    }
    if (keyMatches(helpers, data, ['right'])) {
      flushScheduledQuery();
      switchPage(1);
      return;
    }
    if (keyMatches(helpers, data, ['left'])) {
      flushScheduledQuery();
      switchPage(-1);
      return;
    }
    if (keyMatches(helpers, data, [']'])) {
      if (!flushScheduledQuery()) scrollList(1);
      return;
    }
    if (keyMatches(helpers, data, ['['])) {
      if (!flushScheduledQuery()) scrollList(-1);
      return;
    }
    // Resolve printable paging before a host's case-folding list matcher.
    const scrollAction = scrollKeys.resolveScrollAction(helpers, data);
    if (scrollAction) {
      const page = Math.max(1, bodyRows - 1);
      const half = scrollAction === scrollKeys.ACTIONS.HALF_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_UP;
      const down = scrollAction === scrollKeys.ACTIONS.PAGE_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_DOWN;
      state.scroll = Math.max(0, state.scroll + (down ? 1 : -1) * (half ? Math.max(1, Math.floor(page / 2)) : page));
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      moveSelection(1);
      return;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      moveSelection(-1);
      return;
    }
    if (keyMatches(helpers, data, ['end'])) {
      const total = filteredRows().length;
      if (total > 0) {
        state.index = total - 1;
        state.scroll = 0;
        ensurePullRequest(selected());
        loadMoreRows();
      }
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['home'])) {
      const total = filteredRows().length;
      if (total > 0) {
        state.index = 0;
        state.listStart = 0;
        ensurePullRequest(selected());
      }
      state.scroll = 0;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['t', 'T', '/'])) {
      state.searching = true;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['g'])) {
      flushScheduledQuery();
      toggleLazyView();
      return;
    }
    if (keyMatches(helpers, data, ['l', 'L'])) {
      openLabelEditor();
      return;
    }
    if (keyMatches(helpers, data, ['a'])) {
      openAssigneeEditor();
      return;
    }
    if (keyMatches(helpers, data, ['c'])) {
      openCommentEditor();
      return;
    }
    if (keyMatches(helpers, data, ['i'])) {
      openLinkedEditor();
      return;
    }
    if (keyMatches(helpers, data, ['m'])) {
      openMerge();
      return;
    }
    // x/X both close the pull request, each after the host's own confirm and
    // only for a viewer whose repository permission is confirmed.
    if (keyMatches(helpers, data, ['x', 'X'])) {
      openCloseConfirm();
      return;
    }
    if (keyMatches(helpers, data, ['o'])) {
      const open = actionFor(['openBrowser']);
      const row = selected();
      if (open !== null && row) {
        try {
          open(numOf(row));
        } catch {
          // Opening the browser never mutates view state.
        }
      }
      return;
    }
    // S7: Enter is INSERT in list mode — the focused pull request goes to the
    // chat input as `PR #N` and the panel closes behind it.
    if (keyMatches(helpers, data, ['enter', 'return'])) {
      const row = selected();
      if (!row) return;
      const insert = actionFor(['insert']);
      if (insert === null) {
        actionError = 'insert is unavailable';
        repaint();
        return;
      }
      try {
        insert(`PR #${numOf(row)}`);
      } catch (err) {
        actionError = (err && err.message) || 'insert failed';
        repaint();
        return;
      }
      close();
      return;
    }
    if (keyMatches(helpers, data, ['r'])) {
      const reload = actionFor(['reload']);
      if (serverMode) {
        if (flushScheduledQuery()) return;
        requestBucketPage(state.page, { keepSelection: true });
        return;
      }
      if (reload !== null) {
        let result = null;
        try {
          result = reload();
        } catch {
          return;
        }
        settleSave(result, () => {
          refetchDetail(numOf(selected()));
          repaint();
        }, (error) => {
          actionError = error;
          repaint();
        });
        return;
      }
      const row = selected();
      if (row) refetchDetail(numOf(row));
    }
  }

  // S6: a click inside one published range opens exactly that linked issue in
  // the other panel. Anything else — a wheel notch, a press, a cell between two
  // numbers — stays unhandled, so the host keeps its own mouse behavior.
  // S6: the ONE hit test both the click and the hover answer with, mapped
  // against the frame the reader last painted (its columns, rows and scroll
  // offset included), so a number can never be hoverable without being
  // clickable — or the other way round.
  function hitRange(event) {
    if (!event || typeof event !== 'object') return null;
    const width = Number(event.width);
    const height = Number(event.height);
    if (Number.isFinite(width) && width !== frame.width) return null;
    if (Number.isFinite(height) && height !== frame.height) return null;
    const x = Number(event.x);
    const y = Number(event.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return frame.ranges.find((range) => range.y === y && x >= range.startX && x < range.endX) || null;
  }

  // A left click on one linked issue number opens `/issues` on it, and a `move`
  // over one highlights it (a move that lands nowhere clears it, repainting
  // only when the target changes).
  function handleMouse(event) {
    if (!active || !event || typeof event !== 'object') return undefined;
    if (event.type === 'move') {
      const hit = hitRange(event);
      const next = hit === null ? null : hit.number;
      const changed = next !== hoverNumber;
      hoverNumber = next;
      hoverPullRequest = next === null ? null : numOf(selected());
      if (changed) repaint();
      return { handled: true, render: changed };
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    if (frame.ranges.length === 0) return undefined;
    const hit = hitRange(event);
    if (!hit) return undefined;
    const openLinked = actionFor(['openLinked']);
    if (openLinked === null) return undefined;
    try {
      openLinked({ kind: 'issue', number: hit.number });
    } catch {
      // A hostile opener never breaks the view.
    }
    return { handled: true, render: false };
  }

  function invalidate() {
    frame = { width: 0, height: 0, ranges: [] };
    hoverNumber = null;
    hoverPullRequest = null;
  }

  ensurePullRequest(selected());
  if (serverMode) {
    requestBucketPage(state.page, {});
    if (prefetchBuckets) {
      pages.forEach((page, index) => {
        if (index === state.page || page.lazy === true || Array.isArray(page.rows)) return;
        requestBucketPage(index, {});
      });
    }
  } else {
    resolveInitialSelection(state.page);
  }

  return { render, handleInput, handleMouse, invalidate, state };
}

module.exports = { createPrsView, FOOTER_KEYS, SEARCH_KEYS };

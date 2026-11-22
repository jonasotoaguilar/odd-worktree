'use strict';
// The ODD documents THIS session wrote or edited (odd-rail-section, T8: S8, S9).
//
// This is an ANNOTATION, never the source of truth (S9). Which ODDs exist, where
// each one lives and which copy is newest is the cross-checkout scan's answer
// (lib/odd-scan.js, lib/odd-group.js) and the grouped model's; this module only
// records "this session touched that document", so the rail can show it first and
// refresh immediately instead of waiting for its TTL. Nothing here decides
// existence, location or recency, and nothing here reads the filesystem or Git:
// the rule is lexical, exactly like the scan it annotates.
//
// What registers (S8): a `write` or an `edit` whose target is a Markdown document
// DIRECTLY under an `odd/tasks` directory — lib/odd-docs.js's scan rule
// (`<root>/odd/tasks/*.md`, non-recursive, regular files only, dotfiles skipped,
// the suffix matched case-insensitively), applied to a path instead of a
// directory. `read` never registers, and neither does any other tool; a `.md`
// outside `odd/tasks`, a document nested deeper, a dotfile and a non-Markdown file
// never do either. A subagent runs in its own session, so its calls never reach
// the parent's record: only the filesystem scan covers those, which is by design
// (S9) and not a gap to work around here.
//
// The event arrives normalized by the extension's own readers (`oddToolNameOf`,
// `oddTouchedPaths`, `oddEventCwd` in extensions/odd-worktree-tools.ts), so there
// is no second tool-argument parser in this module: it accepts the same spellings
// those readers accept one level up — `toolName`/`tool`/`name`, `paths`/`path` —
// plus the call's `cwd` and `isError`. A FAILED call (`isError: true`) registers
// nothing, which is why the wiring observes `tool_result` and not `tool_call`: a
// write that never landed must not leave a phantom row.
//
// A relative target resolves against the call's cwd and the stored path is
// ABSOLUTE and normalized; a relative target with no cwd registers nothing rather
// than guessing the process's own directory. The record is idempotent per absolute
// path — a second touch moves the document to the front and updates `at`, never a
// second row — and one tool call is ONE timestamp, however many documents it names.
//
// Persistence: `entryOf(touch)` is the body of the ONE transcript entry the
// wiring appends, `{ customType, data: { path, at } }`, and `TOUCH_ENTRY_TYPE` is
// the customType every reader filters on. `restore(entries)` rebuilds the record
// from what `ctx.sessionManager.getEntries()` returns — Pi's CustomEntry shape,
// `{ type: "custom", id, parentId, timestamp, customType, data }` (docs/
// session-format.md), which is what the extension's other readers filter on
// (`entry.type === "custom"` plus the customType) — keeping one row per path with
// the newest `at` and skipping every garbage entry instead of throwing. It
// REPLACES the record: a session boundary is a fresh session, not a merge.
//
// Pure: no clock beyond the injected `now` (a call that registers nothing reads it
// zero times), no fs, no git, no timer.

const path = require('node:path');

// The customType of the entry this record persists, and the only name a reader of
// the persisted entries may filter on.
const TOUCH_ENTRY_TYPE = 'odd-worktree.odd-touch';

// Only a write or an edit lands on a document; `read` is not work on it (S8).
const TOUCH_TOOLS = new Set(['write', 'edit']);

// The two directory names a document must sit directly under, and the suffix the
// scan accepts case-insensitively.
const ODD_ROOT = 'odd';
const TASKS_DIR = 'tasks';
const MD_SUFFIX = '.md';

// The tool name, accepting the spellings the extension's `oddToolNameOf` accepts.
function toolNameOf(event) {
  if (!event || typeof event !== 'object') return undefined;
  const name = event.toolName ?? event.tool ?? event.name;
  return typeof name === 'string' ? name : undefined;
}

// The targets, accepting the two spellings the extension's `oddTouchedPaths`
// accepts one level up (the args-object traversal stays in the extension).
function targetsOf(event) {
  const out = [];
  if (!event || typeof event !== 'object') return out;
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) out.push(value);
  };
  const target = event.paths ?? event.path;
  if (Array.isArray(target)) target.forEach(push);
  else push(target);
  return out;
}

// The absolute, normalized path of an `odd/tasks/*.md` document, or null. Lexical
// on purpose: the worktree's own `odd/` may be a symlink to the principal's, and
// the document behind either spelling carries the same segments, so this costs no
// file read.
function documentPathOf(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.toLowerCase().endsWith(MD_SUFFIX)) return null;
  let absolute;
  try {
    if (!path.isAbsolute(raw)) {
      if (typeof cwd !== 'string' || cwd.length === 0) return null;
      absolute = path.resolve(cwd, raw);
    } else {
      absolute = path.resolve(raw);
    }
  } catch {
    return null;
  }
  const file = path.basename(absolute);
  // A dotfile is not a document: the scan skips it, so a touch of one is no touch.
  if (file.startsWith('.')) return null;
  const tasks = path.basename(path.dirname(absolute));
  const odd = path.basename(path.dirname(path.dirname(absolute)));
  if (tasks !== TASKS_DIR || odd !== ODD_ROOT) return null;
  return absolute;
}

// The ODD's name, derived exactly like the scan's: the file's own name without the
// Markdown suffix.
function oddNameOf(absolute) {
  return path.basename(absolute).replace(/\.md$/i, '');
}

/**
 * The session's record of touched ODD documents.
 *
 * `opts.now` is the clock (defaults to `Date.now`); every other seam is none, so
 * this is a pure object with no I/O of any kind.
 */
function createOddSession(opts) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // The record: `absolute path -> { path, name, at }` plus the MRU order, so
  // "most recently touched first" is the array this module maintains and never a
  // sort a caller could disagree with.
  const rows = new Map();
  const order = [];

  function register(absolute, at) {
    const seen = order.indexOf(absolute);
    if (seen !== -1) order.splice(seen, 1);
    order.unshift(absolute);
    rows.set(absolute, { path: absolute, name: oddNameOf(absolute), at });
  }

  /** Record one tool call. `true` only when it registered an ODD. */
  function note(event) {
    if (!event || typeof event !== 'object') return false;
    // S8: a call that failed wrote nothing, so it touched nothing.
    if (event.isError === true) return false;
    const toolName = toolNameOf(event);
    if (typeof toolName !== 'string' || !TOUCH_TOOLS.has(toolName)) return false;
    const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : undefined;
    const targets = [];
    for (const raw of targetsOf(event)) {
      const absolute = documentPathOf(raw, cwd);
      if (absolute !== null) targets.push(absolute);
    }
    if (targets.length === 0) return false;
    // ONE timestamp for the whole call, so two documents of the same call can never
    // reorder each other by clock jitter.
    const stamp = Number(now());
    const at = Number.isFinite(stamp) ? stamp : 0;
    for (const absolute of targets) register(absolute, at);
    return true;
  }

  /** Rebuild from persisted entries. Returns how many the record now holds. */
  function restore(entries) {
    rows.clear();
    order.length = 0;
    if (!Array.isArray(entries)) return 0;
    const found = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      // The CustomEntry shape, exactly as the extension's other readers filter it.
      if (entry.type !== 'custom') continue;
      if (entry.customType !== TOUCH_ENTRY_TYPE) continue;
      const data = entry.data;
      if (!data || typeof data !== 'object') continue;
      if (typeof data.path !== 'string' || data.path.length === 0) continue;
      const at = Number(data.at);
      if (!Number.isFinite(at)) continue;
      found.push({ path: data.path, at });
    }
    // Newest first, and on an equal `at` the LATER entry wins: entries arrive in
    // append order, so the later one is the later touch. Applied oldest-first so
    // the MRU list ends up with the newest document at the front.
    const keyed = found.map((row, index) => ({ row, index }));
    keyed.sort((left, right) => right.row.at - left.row.at || right.index - left.index);
    for (let index = keyed.length - 1; index >= 0; index -= 1) {
      register(keyed[index].row.path, keyed[index].row.at);
    }
    return rows.size;
  }

  /** The touched documents, most recently touched first, one per absolute path. */
  function touched() {
    const out = [];
    for (const absolute of order) {
      const row = rows.get(absolute);
      if (row !== undefined) out.push({ path: row.path, name: row.name, at: row.at });
    }
    return out;
  }

  /** Whether this exact absolute path is in the record. */
  function has(absolute) {
    return typeof absolute === 'string' && rows.has(absolute);
  }

  /** The persisted entry body for one touch: the ONE shape a reader filters on. */
  function entryOf(touch) {
    const source = touch !== null && typeof touch === 'object' ? touch : {};
    const at = Number(source.at);
    return {
      customType: TOUCH_ENTRY_TYPE,
      data: {
        path: typeof source.path === 'string' ? source.path : '',
        at: Number.isFinite(at) ? at : 0,
      },
    };
  }

  function clear() {
    rows.clear();
    order.length = 0;
  }

  return { note, restore, touched, has, entryOf, clear };
}

module.exports = {
  TOUCH_ENTRY_TYPE,
  createOddSession,
};

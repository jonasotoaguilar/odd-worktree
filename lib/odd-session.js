'use strict';
// The ODD documents THIS session wrote or edited (odd-rail-section, T8: S8, S9).
//
// This is an ANNOTATION, never the source of truth (S9). Which ODDs exist and where
// each one lives is the grouped model's answer (lib/odd-group.js), and which copy of
// a name is newest belongs to the rail's row model's own election
// (lib/odd-rail-model.js); this module only records "this session touched that
// document", so the rail can show it first and refresh immediately instead of waiting
// for its TTL. Nothing here decides existence, location or recency, and nothing here
// reads the filesystem or Git: the rule is lexical, like the scan it annotates.
//
// What registers (S8): a `write` or an `edit` whose target is a Markdown document
// DIRECTLY under an `odd/tasks` directory — lib/odd-docs.js's scan rule
// (`<root>/odd/tasks/*.md`, non-recursive, regular files only, dotfiles skipped,
// the suffix matched case-insensitively), applied to a path instead of a
// directory. `read` never registers, and neither does any other tool; a `.md`
// outside `odd/tasks`, a document nested deeper, a dotfile and a non-Markdown file
// never do either. A subagent runs in its own session, so its calls never reach
// the parent's record: the PARENT's own history is what carries them
// (`associatedFromHistory`, below), not this record.
//
// `associatedFromHistory(entries)` is the SECOND reader, and the source of truth
// for scope (odd-rail-session-scope S2-S4): given the ACTIVE branch's entries
// (`ctx.sessionManager.getBranch()` — never `getEntries()`, whose abandoned
// branches are alternative histories), it answers the NAMES of the ODD documents
// the session is associated with. An old session written before this record
// existed, and a resumed one, are covered by it because it reads the transcript
// itself: a successful `write`/`edit` toolCall on `odd/tasks/<name>.md`, the
// persisted touch entries, a `gentle-agents.result` report listing the path under
// `files_changed:`, and the `Spec: odd/tasks/<name>.md` line of a successful
// `subagent_run`/`subagent_continue`. Name-keyed, lexical like the record, and
// total: every malformed entry is skipped instead of thrown on.
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

// S4: the parent's own evidence of a subagent's work. The finished report is a
// `custom_message` under this customType, and its `files_changed:` block lists the
// paths the worker changed; the tool that started it carries the ODD in its task.
const AGENTS_RESULT_TYPE = 'gentle-agents.result';
const SUBAGENT_TOOLS = new Set(['subagent_run', 'subagent_continue']);

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

// A transcript path's ODD name, or null. The same lexical rule as
// `documentPathOf`, minus the clock and the resolution: a branch entry carries no
// cwd, so a RELATIVE `odd/tasks/<name>.md` is read as typed and a path that climbs
// (`..`) is refused before anything is normalized. A dotfile is not a document and
// neither is a `.md` outside `odd/tasks` or one nested deeper.
function historyNameOf(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.toLowerCase().endsWith(MD_SUFFIX)) return null;
  if (raw.split(/[\\/]/).includes('..')) return null;
  const file = path.basename(raw);
  if (file.startsWith('.')) return null;
  if (path.basename(path.dirname(raw)) !== TASKS_DIR) return null;
  if (path.basename(path.dirname(path.dirname(raw))) !== ODD_ROOT) return null;
  return oddNameOf(file);
}

// The text a custom message carries, as one string: Pi stores it as a string or as
// an array of content blocks (docs/message-types.md), and anything else is no text.
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  return parts.join('\n');
}

// The ODD names one line of a report names, added to `out`. A `files_changed:` item
// is a path, optionally followed by `: <what changed>`, and several paths may share
// one line separated by commas. Anything that is not an `odd/tasks/*.md` document
// contributes nothing.
function addNamesInLine(text, out) {
  if (typeof text !== 'string' || text.length === 0) return;
  for (const raw of text.split(',')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    const head = colon === -1 ? trimmed : trimmed.slice(0, colon).trim();
    for (const candidate of [head, ...head.split(/\s+/)]) {
      const name = historyNameOf(candidate.replace(/:+$/, ''));
      if (name !== null) out.add(name);
    }
  }
}

// The paths under a `files_changed:` block, added to `out`. The block is the header
// line's own remainder plus the list items that follow it; the first line that is
// not a list item ends it, so the next section of the report is never read.
function addFilesChanged(text, out) {
  if (typeof text !== 'string' || text.length === 0) return;
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*files_changed\s*:\s*(.*)$/.exec(line);
    if (header !== null) {
      inBlock = true;
      addNamesInLine(header[1], out);
      continue;
    }
    if (!inBlock) continue;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item === null) {
      inBlock = false;
      continue;
    }
    addNamesInLine(item[1], out);
  }
}

// Every `Spec: odd/tasks/<name>.md` a subagent task names, added to `out`.
function addSpecNames(text, out) {
  if (typeof text !== 'string' || text.length === 0) return;
  const pattern = /Spec:[ \t]*([^\s,]+)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const name = historyNameOf(match[1].replace(/:+$/, ''));
    if (name !== null) out.add(name);
    match = pattern.exec(text);
  }
}

// The toolCalls one transcript entry makes, in order. A message entry carries them
// under `message`; the bare message shape is accepted too, so a caller that hands
// over `getBranch()` or a normalized message both answer. Anything else is empty.
function toolCallsOf(entry, out) {
  const message = entry.message !== undefined && entry.message !== null ? entry.message : entry;
  if (!message || typeof message !== 'object') return;
  if (message.role !== 'assistant') return;
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'toolCall') continue;
    const id = typeof block.id === 'string' ? block.id : undefined;
    const name = typeof block.name === 'string' ? block.name : undefined;
    if (id === undefined || name === undefined) continue;
    out.push({ id, name, args: block.arguments && typeof block.arguments === 'object' ? block.arguments : null });
  }
}

// One toolResult's verdict, or null. `isError === true` is the failed call; a result
// without the flag is a success, and a result with no toolCallId vouches for nothing.
function resultOf(entry) {
  const message = entry.message !== undefined && entry.message !== null ? entry.message : entry;
  if (!message || typeof message !== 'object') return null;
  if (message.role !== 'toolResult') return null;
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
  if (toolCallId === undefined || toolCallId.length === 0) return null;
  return { toolCallId, failed: message.isError === true };
}

/**
 * The ODD NAMES the session's ACTIVE branch is associated with (S3, S4).
 *
 * `entries` is what `ctx.sessionManager.getBranch()` returns, so an abandoned
 * branch's work is never in it. Total: a non-array answer is an empty association
 * and a malformed entry is skipped, never thrown on.
 *
 * @param {Array<object>} entries
 * @returns {Set<string>}
 */
function associatedFromHistory(entries) {
  const out = new Set();
  if (!Array.isArray(entries)) return out;
  const calls = [];
  // The verdict per toolCallId: the LAST result of an id decides, so a retried call
  // is judged by what finally happened.
  const results = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    try {
      // S3: the persisted touch entries, written by the record above.
      if (entry.type === 'custom') {
        if (entry.customType !== TOUCH_ENTRY_TYPE) continue;
        const data = entry.data;
        if (!data || typeof data !== 'object') continue;
        const name = historyNameOf(data.path);
        if (name !== null) out.add(name);
        continue;
      }
      // S4: a subagent's own report, persisted in the PARENT's session.
      if (entry.type === 'custom_message') {
        if (entry.customType !== AGENTS_RESULT_TYPE) continue;
        addFilesChanged(textOfContent(entry.content), out);
        continue;
      }
      // S3/S4: the calls, whose results may land anywhere in the branch.
      if (entry.type !== 'message') continue;
      toolCallsOf(entry, calls);
      const verdict = resultOf(entry);
      if (verdict !== null) results.set(verdict.toolCallId, verdict.failed);
    } catch {
      // One garbage entry costs only itself.
    }
  }
  for (const call of calls) {
    try {
      if (results.get(call.id) !== false) continue;
      if (TOUCH_TOOLS.has(call.name)) {
        if (call.args === null) continue;
        const target = call.args.paths ?? call.args.path;
        const targets = Array.isArray(target) ? target : [target];
        for (const raw of targets) {
          const name = historyNameOf(raw);
          if (name !== null) out.add(name);
        }
        continue;
      }
      if (SUBAGENT_TOOLS.has(call.name)) {
        if (call.args === null) continue;
        addSpecNames(call.args.task, out);
      }
    } catch {
      // A malformed call costs only itself.
    }
  }
  return out;
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
  associatedFromHistory,
};

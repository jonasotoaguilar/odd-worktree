'use strict';
// T8/S12 model-facing half: compact, agent-useful result text for the four
// own worktree tools this adapter formats.
//
// The extension's raw text prints one line per fact (for a listing:
// `worktree list: <name> <branch> thread=<id> issues=<csv> odd=<csv>` per
// checkout). That shape spends the agent's context on thread ids and on the
// ODD documents a checkout HAPPENS TO HOLD. This module builds the
// model-facing text from the SAME `details` object execute() already
// returns, so:
//
//   * `details` (and every other result field) is preserved byte for byte —
//     the UI card and runtime callers keep their contract;
//   * only the text content is replaced, and non-text content (images and
//     anything else) survives in place;
//   * an error, partial, malformed or unrecognized result is returned
//     UNCHANGED — a failure's prose is its diagnostics, and this module
//     never turns "not enough structured evidence" into an invented
//     success.
//
// Text style (chosen once, used everywhere): short `label: value` rows with
// a stable order, plus one `·`-separated row per checkout for listings, whose
// invariant cells are declared in the header line. No key=value dumps, no
// quoted path prose, no repeated title, no truncation: values are emitted
// whole. A listing row is `name · branch · path`, followed by ONE state cell
// only when the row is not the ordinary "registered and live" case — `missing`
// (the path exists but git no longer lists the checkout) or `unregistered` (a
// live checkout the registry does not own) — so a reader still tells those
// apart while nothing repeats what the row already says (S6).
//
// Free of side effects: no filesystem, network, registry, process or timing
// access, so it can run inside any execute() wrapper.
//
// NO ISSUES, NO ODD (S1): a worktree carries neither an issue list nor an ODD
// document any more, so no worktree display mentions them. The registry still
// stores those legacy records (preserved bytes), but `worktree_list` no longer
// publishes them in its text or its details, and this module would ignore
// `details.worktrees[].issues`, `.assignedOdd` and `.odd` if a producer ever
// supplied them again.
//
// The create tool is deliberately NOT in this list: it writes its own short
// ordered text (`created:`/`path:`/`codegraph:` plus one `warning:` row each),
// and the retired create-or-update builder that predated it is gone with the
// old contract.

const WORKTREE_MODEL_TOOLS = [
  'worktree_list',
  'worktree_delete',
  'worktree_session_open',
  'worktree_warp',
];

// ANSI SGR/OSC-8 sequences and C0/C1 controls (multi-line structure is
// irrelevant here: every value is folded onto one line).
const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const LIST_LEGEND = 'name · branch · path';

// S6: the trailing state cell is optional and self-describing, so the legend
// declares only the three cells every row carries. Existence is implied by the
// listing itself — a checkout whose path is gone is pruned before it can be
// listed — so a normal state is never worth a cell, and `agent` (the ordinary
// registered worktree) is never worth one either. `principal` repeats the row's
// own name, `unregistered` repeats its state, and an existence spelling in
// `kind` repeats what the listing already proves, so all three collapse away
// while a kind the row does NOT already state still prints.
const ORDINARY_STATUS = new Set(['', 'live', 'exists']);
const ORDINARY_KIND = new Set(['', 'agent']);

// One-line, escape-free, whitespace-folded value. Branch names and paths are
// untrusted input: a raw escape or newline must never reshape a row.
function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

function asRecord(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

// Mirrors lib/worktree-git.js slugifyBranch and the extension's slugPart, so
// the model text names the same identifier `warp`/`close` accept.
function slugify(value) {
  const slug = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'worktree' : slug;
}

function baseName(value) {
  const text = clean(value).replace(/\/+$/, '');
  if (text.length === 0) return '';
  const parts = text.split('/');
  return parts[parts.length - 1];
}

// Warnings are already the summarized, agent-useful form the extension
// produced (failed hook steps, pruned stale records, dropped legacy
// associations). They are kept verbatim, deduplicated, and never replaced by
// raw hook/command output. `pruneError` is a bare reason string, so it is
// added only when no warning already carries it; a FAILED creation-hook step
// is added the same way from its own detail line, so a hook failure stays
// visible even if the warning list ever stops summarizing it. Skipped steps
// and stdout are never copied: they cost context and the warnings already say
// what matters.
function warningRows(details) {
  const rows = [];
  const seen = [];
  // A warning the extension already summarized is kept once, verbatim.
  const pushNew = (text) => {
    if (text.length === 0 || seen.includes(text)) return;
    seen.push(text);
    rows.push(`warning: ${text}`);
  };
  // A bare reason field is dropped when a warning already carries it.
  const pushDerived = (text) => {
    if (text.length === 0 || seen.some((known) => known.includes(text))) return;
    pushNew(text);
  };
  const warnings = Array.isArray(details.warnings) ? details.warnings : [];
  for (const warning of warnings) pushNew(clean(warning));
  pushDerived(clean(details.pruneError));
  const hooks = asRecord(details.hooks);
  const steps = Array.isArray(hooks.steps) ? hooks.steps : [];
  for (const step of steps) {
    const record = asRecord(step);
    if (record.status !== 'failed') continue;
    pushDerived(clean(record.detail));
  }
  return rows;
}

function listRows(details) {
  if (!Array.isArray(details.worktrees)) return null;
  const entries = details.worktrees;
  const count = typeof details.count === 'number' && Number.isFinite(details.count)
    ? details.count
    : entries.length;
  const rows = [entries.length > 0 ? `worktrees: ${count} (${LIST_LEGEND})` : `worktrees: ${count}`];
  for (const entry of entries) {
    const row = asRecord(entry);
    const name = clean(row.name) || baseName(row.path);
    const branch = clean(row.branch);
    const target = clean(row.path);
    const status = clean(row.status);
    // S6: what changes how the row must be read stays; the ordinary case does
    // not spend a cell saying so.
    const state = ORDINARY_STATUS.has(status) ? '' : status;
    const kind = clean(row.kind);
    const kindCell = ORDINARY_KIND.has(kind) || ORDINARY_STATUS.has(kind) || kind === name || kind === state
      ? ''
      : kind;
    const cells = [name, branch, target, kindCell, state].filter((cell) => cell.length > 0);
    if (cells.length === 0) continue;
    // S1: the row IS the checkout's identity. Issues and ODD documents are not
    // part of a worktree any more, so they never reach a listing row even when
    // the details still carry the preserved legacy fields.
    rows.push(cells.join(' · '));
  }
  rows.push(...warningRows(details));
  return rows;
}

function closeRows(details) {
  const branch = clean(details.branch);
  const target = clean(details.path);
  if (branch.length === 0 && target.length === 0) return null;
  const name = branch.length > 0 ? slugify(branch) : baseName(target);
  const rows = ['outcome: removed'];
  if (name.length > 0) rows.push(`name: ${name}`);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  if (target.length > 0) rows.push(`path: ${target}`);
  rows.push(`branch state: ${details.branchKept === false ? 'deleted' : 'kept'}`);
  // A pre-removal warp is part of the outcome: the caller's session is no
  // longer where it was, so the destination must stay visible.
  const warp = asRecord(details.warp);
  const warpTarget = [clean(warp.name), clean(warp.path)].filter((part) => part.length > 0).join(' · ');
  if (warpTarget.length > 0) rows.push(`session: warped to ${warpTarget}`);
  rows.push(...warningRows(details));
  return rows;
}

function sessionOpenRows(details) {
  const worktree = clean(details.worktree);
  const session = clean(details.sessionId);
  const target = clean(details.path);
  if (worktree.length === 0 && session.length === 0 && target.length === 0) return null;
  const rows = [`outcome: ${details.resumed === true ? 'resumed' : 'opened'}`];
  if (worktree.length > 0) rows.push(`worktree: ${worktree}`);
  const branch = clean(details.branch);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  if (target.length > 0) rows.push(`path: ${target}`);
  // The session id, workspace and pane are the routing ids a caller needs to
  // reach the session it just started; the agent name names the agent.
  if (session.length > 0) rows.push(`session: ${session}`);
  const workspace = clean(details.workspaceId);
  if (workspace.length > 0) rows.push(`workspace: ${workspace}`);
  const pane = clean(details.paneId);
  if (pane.length > 0) rows.push(`pane: ${pane}`);
  const agent = clean(details.agentName);
  if (agent.length > 0) rows.push(`agent: ${agent}`);
  rows.push(...warningRows(details));
  return rows;
}

function warpRows(details) {
  const name = clean(details.name);
  const target = clean(details.path);
  if (name.length === 0 && target.length === 0) return null;
  const rows = [`outcome: ${details.alreadyThere === true ? 'already there' : 'moved'}`];
  const source = [clean(details.fromName), clean(details.from)].filter((part) => part.length > 0).join(' · ');
  if (source.length > 0) rows.push(`from: ${source}`);
  // `to` carries the continuation target: the name the next call accepts and
  // the absolute path the session now works in.
  const destination = [name, target].filter((part) => part.length > 0).join(' · ');
  if (destination.length > 0) rows.push(`to: ${destination}`);
  const branch = clean(details.branch);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  rows.push(...warningRows(details));
  return rows;
}

const ROW_BUILDERS = {
  worktree_list: listRows,
  worktree_delete: closeRows,
  worktree_session_open: sessionOpenRows,
  worktree_warp: warpRows,
};

// Replace every text entry with ONE formatted entry at the position of the
// first one, keeping non-text entries (images, …) untouched and in order. The
// caller guarantees at least one text entry (hasTextContent below).
function rebuildContent(content, text) {
  const entries = [];
  let placed = false;
  for (const entry of content) {
    if (entry && entry.type === 'text' && typeof entry.text === 'string') {
      if (!placed) {
        entries.push({ ...entry, text });
        placed = true;
      }
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function hasTextContent(content) {
  return content.some((entry) => entry && entry.type === 'text' && typeof entry.text === 'string');
}

/**
 * Format one own worktree tool result for the model.
 *
 * @param {string} toolName One of WORKTREE_MODEL_TOOLS.
 * @param {object} result The tool result ({content, details, isError?}).
 * @returns {object} The same result with the text content replaced when the
 *   tool is known, the result is a successful structured one, and the details
 *   carry enough evidence; otherwise the INPUT UNCHANGED (same reference).
 */
function formatWorktreeModelResult(toolName, result) {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(ROW_BUILDERS, toolName)) {
    return result;
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  // A failure's prose IS its diagnostics, and a partial result is not
  // settled: both are returned untouched rather than reformatted.
  if (result.isError === true || result.isPartial === true) return result;
  const content = result.content;
  if (!Array.isArray(content) || !hasTextContent(content)) return result;
  const details = result.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return result;
  const rows = ROW_BUILDERS[toolName](details);
  if (rows === null || rows.length === 0) return result;
  return { ...result, content: rebuildContent(content, rows.join('\n')) };
}

module.exports = {
  formatWorktreeModelResult,
  WORKTREE_MODEL_TOOLS,
};

'use strict';
// S9: the focused scope's Git facts — the line that sits directly above the
// scope step's footer. This module is pure data: it orders the scopes the view
// paints, parses the one `rev-list --left-right --count` answer, formats the
// `±n files` cell and composes the detail line, and it reads Git only through
// the injected runner. No child process is spawned here and nothing is written.
//
// Ported from the read-only reference (`lib/file-scope-detail.ts`): the
// `main`-first ordering, the `±`/`↑`/`↓` glyphs, the subject-first field order
// and the one rule that shapes the line — a field that is zero or absent is not
// painted at all. Every Git failure degrades to an absent field, so a repository
// with no remote, no commits or a failing read paints less instead of claiming a
// zero nobody measured.

const { formatAge } = require('./files-index.js');

// A worktree is compared with the session repository's local main; the `main`
// row is compared with the remote main it tracks (S9). T7 feeds these into
// `loadScopeDetail`, so the two spellings live here instead of in the view.
const LOCAL_MAIN = 'main';
const REMOTE_MAIN = 'origin/main';

const COUNT = /^\d+$/;
const SEPARATOR = ' · ';
const CHANGED_SYMBOL = '±';
const AHEAD_SYMBOL = '↑';
const BEHIND_SYMBOL = '↓';
// S42: the age field carries its own noun. `33s` alone does not say what it
// measures; the suffix makes the field read without a legend beside it, and it
// rides the same `s`/`m`/`h`/`d` label T1's `formatAge` already produces.
const AGE_SUFFIX = 'ago';

/**
 * S9: `main` keeps the first row and every other checkout follows it, most
 * recently modified first; recency ties keep their input order, so the ordering
 * is stable and `main` is never displaced by a newer worktree. The input array
 * and its entries are left untouched.
 *
 * @param {Array<{kind?: string, lastModifiedMs?: number}>} scopes
 * @returns {Array<object>} a new array of the same scope objects.
 */
function orderScopes(scopes) {
  const ranked = (Array.isArray(scopes) ? scopes : []).map((scope, index) => ({ scope, index }));
  const recency = (entry) => {
    const value = Number(entry.scope && entry.scope.lastModifiedMs);
    return Number.isFinite(value) ? value : 0;
  };
  const byRecency = (left, right) => (recency(right) - recency(left)) || (left.index - right.index);
  const main = ranked.filter((entry) => entry.scope && entry.scope.kind === 'main').sort(byRecency);
  const rest = ranked.filter((entry) => !entry.scope || entry.scope.kind !== 'main').sort(byRecency);
  return [...main, ...rest].map((entry) => entry.scope);
}

/**
 * One `rev-list --left-right --count comparison...HEAD` answer. The left count
 * belongs to the comparison alone and the right count to HEAD alone, so the line
 * reads as `<behind> <ahead>`. Anything that is not exactly two whole counts is
 * unparsable, and the caller treats it as absent.
 *
 * @param {string} stdout
 * @returns {{ahead: number, behind: number}|undefined}
 */
function parseAheadBehind(stdout) {
  if (typeof stdout !== 'string') return undefined;
  const fields = stdout.trim().split(/\s+/).filter((field) => field !== '');
  if (fields.length !== 2) return undefined;
  const [behind, ahead] = fields;
  if (!COUNT.test(behind) || !COUNT.test(ahead)) return undefined;
  return { ahead: Number.parseInt(ahead, 10), behind: Number.parseInt(behind, 10) };
}

/**
 * The uncommitted-file cell (S9): the glyph plus the noun, singular at one. The
 * noun stays because `±3` alone reads as changed lines.
 *
 * @param {number} files
 * @returns {string}
 */
function countCell(files) {
  const count = Number(files);
  const shown = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${CHANGED_SYMBOL}${shown} ${shown === 1 ? 'file' : 'files'}`;
}

/**
 * The focused scope's line (S9): the last commit subject first, then `±n files`,
 * the age of the last modification, suffixed `ago` (S42), and the distance from
 * the comparison ref (`↑n main` / `↓n origin/main` for the `main` row). A field
 * that is zero or absent is not painted, and an unknown comparison never claims
 * a distance.
 *
 * @param {{changedFiles?: number, lastModifiedMs?: number, lastCommitSubject?: string, ahead?: number, behind?: number, comparison?: string}} detail
 * @param {number} nowMs the clock read once when the step opened.
 * @returns {string}
 */
function scopeDetailLine(detail, nowMs) {
  const model = detail !== null && typeof detail === 'object' ? detail : {};
  const fields = [];
  const subject = typeof model.lastCommitSubject === 'string' ? model.lastCommitSubject.trim() : '';
  if (subject !== '') fields.push(subject);
  const files = Number(model.changedFiles);
  if (Number.isFinite(files) && files > 0) fields.push(countCell(files));
  const modified = Number(model.lastModifiedMs);
  // `formatAge` produces the bare label; the suffix is this line's own word, so
  // the picker's file rows keep their bare age column untouched (S42).
  if (Number.isFinite(modified) && modified > 0) fields.push(`${formatAge(modified, nowMs)} ${AGE_SUFFIX}`);
  const comparison = typeof model.comparison === 'string' ? model.comparison.trim() : '';
  const ahead = Number(model.ahead);
  if (comparison !== '' && Number.isFinite(ahead) && ahead > 0) fields.push(`${AHEAD_SYMBOL}${Math.trunc(ahead)} ${comparison}`);
  const behind = Number(model.behind);
  if (comparison !== '' && Number.isFinite(behind) && behind > 0) fields.push(`${BEHIND_SYMBOL}${Math.trunc(behind)} ${comparison}`);
  return fields.join(SEPARATOR);
}

// One bounded read through the injected runner. A non-zero status, a truncated
// or timed-out answer and a throwing runner are all a failed lookup — never a
// partial count.
async function ask(run, args, cwd) {
  if (typeof run !== 'function') return undefined;
  try {
    const result = await run(args, { cwd });
    if (!result || typeof result !== 'object') return undefined;
    if (result.status !== 0) return undefined;
    if (result.truncated === true || result.timedOut === true) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Read the scope's last commit and its distance from `comparison` (S9), with two
 * fixed-argv reads: `rev-list --left-right --count <comparison>...HEAD` and
 * `log -1 --format=%s`. A missing ref (no remote, no local main, an unborn
 * branch), a failed call and a runner that throws all leave the corresponding
 * fields absent. `comparison` is always reported back, so the view knows what the
 * counts would have been measured against.
 *
 * @param {{run?: Function, cwd?: string, comparison?: string}} options
 * @returns {Promise<{comparison?: string, ahead?: number, behind?: number, lastCommitSubject?: string}>}
 */
async function loadScopeDetail(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const run = typeof opts.run === 'function' ? opts.run : null;
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : undefined;
  const comparison = typeof opts.comparison === 'string' ? opts.comparison.trim() : '';
  const detail = {};
  if (comparison !== '') detail.comparison = comparison;
  const [range, subject] = await Promise.all([
    comparison === '' ? undefined : ask(run, ['rev-list', '--left-right', '--count', `${comparison}...HEAD`], cwd),
    ask(run, ['log', '-1', '--format=%s'], cwd),
  ]);
  const distance = range === undefined ? undefined : parseAheadBehind(range.stdout);
  if (distance !== undefined) {
    detail.ahead = distance.ahead;
    detail.behind = distance.behind;
  }
  const line = subject !== undefined && typeof subject.stdout === 'string' ? subject.stdout.split('\n')[0].trim() : '';
  if (line !== '') detail.lastCommitSubject = line;
  return detail;
}

module.exports = {
  LOCAL_MAIN,
  REMOTE_MAIN,
  countCell,
  loadScopeDetail,
  orderScopes,
  parseAheadBehind,
  scopeDetailLine,
};

'use strict';
// The file picker's data source (files-picker S6, S13, S16): the repository
// listing Git answers, each file's working-tree state with its age, and one
// bounded preview read.
//
// Read-only by construction (S16): every Git read is ONE fixed argv array —
// never a shell string — handed to the injected async runner
// `run(args, opts) -> { status, stdout, stderr }`, the exact shape
// lib/worktree-git.js `runArgvAsync` resolves, with a bounded timeout on every
// call. Nothing here stages, writes, opens a socket or prunes a worktree, and
// `git status` runs with `--no-optional-locks` so even the stat-cache refresh
// it would normally write back is skipped. The preview half spawns nothing at
// all: it is one `open`/`read` of at most FILE_PREVIEW_LIMITS.maxBytes.
//
// The list is Git's, not a directory walk (S13): `git ls-files --cached
// --others --exclude-standard` is exactly the tracked files plus the untracked
// files Git does not ignore, so `.gitignore` is respected without this module
// ever parsing it. Outside a repository the listing fails and the failure is a
// sentence a panel can paint, never an empty success.
//
// Change state (S6) comes from two reads, one per scope kind. The principal
// checkout is marked from a single `git status --porcelain=v1 -z
// --untracked-files=all`: `??` is `new` (untracked), any other record is
// `modified` (tracked and dirty), and a file the status does not name is
// `clean`. A worktree is marked from its own work instead (S2): one
// `git diff --name-status -z -M <principal>...HEAD` names every path the branch
// changed ahead of the principal branch, with its net state — `A` when the
// merge-base does not have the path, `M` when it does — so committing a
// worktree no longer erases the badges. The two sets are unioned (S4): a path
// the commits already named keeps that state, and the worktree's uncommitted
// work still marks the rest. A path the commits deleted is dropped, because a
// file that is gone has no row to paint (S5).
//
// Change state carries no time, so the ages come from a stat under the
// repository root Git reports — `git rev-parse --show-toplevel`, never
// `process.cwd()`, because the picker browses another checkout than the one the
// process happens to sit in. An unreadable root or file leaves the timestamp
// out rather than failing the whole listing.
//
// The order is the panel's contract: changed files first, newest change first,
// then the untouched ones by path. Every comparison is by code unit, never
// `localeCompare`, so the list is identical on every host and every run.

const fs = require('node:fs');
const path = require('node:path');

// One bounded Git process per read; a picker that waits longer than this has
// nothing to paint anyway.
const GIT_TIMEOUT_MS = 15_000;

// `-z` avoids Git's quoting of paths holding whitespace or newlines; the cached
// and others sources together are the tracked files plus the untracked ones Git
// does not ignore — the picker's whole list, `.gitignore` respected by Git.
const LIST_ARGS = Object.freeze(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);

// One call decides every state: `-z` for the same reason as above,
// `--untracked-files=all` so an untracked file is listed instead of its
// directory, and `--no-optional-locks` so the refresh Git would write back into
// `.git/index` is skipped (S16).
const STATUS_ARGS = Object.freeze([
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
]);

// The root the mtimes are read under. Resolved from Git rather than the process
// cwd because the picker can browse another checkout.
const ROOT_ARGS = Object.freeze(['rev-parse', '--show-toplevel']);

// S2: a worktree's own work is the record of what its branch changed ahead of
// the principal branch. Three dots compare against the merge-base, so a `main`
// that moved on since the fork is never read as this branch's work, and a path
// named by several commits arrives once, already deduplicated, with its net
// state (S3). `-z` for the same reason as every other read.
//
// The ref is spelled out as `refs/heads/<branch>` on purpose: a bare `main` is
// ambiguous the moment a tag or a remote of that name exists, and a checkout
// holding an ordinary file called `main...HEAD` makes the whole read fail. The
// trailing `--` says the argument list ends before any path could start.
// `--no-renames` keeps the read READ-ONLY: similarity detection is what makes
// Git fetch a missing blob in a partial clone and write a pack, and the net
// state does not need it — an undetected rename is delete plus add, and the
// delete is a path that gets no row anyway.
const commitArgs = (comparison) => [
  'diff',
  '--name-status',
  '-z',
  '--no-renames',
  `refs/heads/${comparison}...HEAD`,
  '--',
];

const FILES_ERROR = 'Cannot list repository files';
const CHANGES_ERROR = 'Cannot read repository changes';
const COMMITS_ERROR = "Cannot read the branch's commits";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ELLIPSIS = '\u2026';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Byte order, not locale order: the list is rebuilt on every open and must come
// out the same everywhere.
function byCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// One sentence a panel can paint, with exactly one full stop.
function sentence(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim();
  if (trimmed.length === 0) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function notRepositoryMessage(cwd) {
  const where = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : 'this directory';
  return sentence(`Not a Git repository: ${where}`);
}

// The first line Git said, then a spawn error, then the exit status: the same
// priority as lib/worktree-git.js `gitFailureReason`, so the sentence names the
// real cause instead of "exit 128".
function failureReason(result) {
  const stderr = result && typeof result.stderr === 'string' ? result.stderr.trim() : '';
  if (stderr.length > 0) return stderr.split('\n')[0];
  if (result && result.error !== undefined && result.error !== null && String(result.error).length > 0) {
    return String(result.error);
  }
  return `Git exited with status ${result && result.status !== undefined ? result.status : 'unknown'}`;
}

function isNotRepository(detail) {
  return /not a git repository/i.test(String(detail));
}

// One fixed argv through the injected runner. Never throws, and never resolves
// a failure as a success: a runner that rejects, one that resolves a non-zero
// status, and one that answers nothing all come back as `{ ok: false }`, so the
// caller decides which sentence to paint.
async function runGit(run, args, cwd) {
  let result;
  try {
    result = await run([...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, detail: errorMessage(error), notRepository: false };
  }
  if (result === null || typeof result !== 'object') {
    return { ok: false, detail: 'the Git runner returned nothing usable', notRepository: false };
  }
  if (result.truncated === true) {
    return { ok: false, detail: 'the output was truncated', notRepository: false };
  }
  if (result.status !== 0) {
    const detail = failureReason(result);
    return { ok: false, detail, notRepository: isNotRepository(detail) };
  }
  return { ok: true, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

function listingFailure(failure, cwd) {
  return {
    ok: false,
    message: failure.notRepository ? notRepositoryMessage(cwd) : sentence(`${FILES_ERROR}: ${failure.detail}`),
  };
}

function changesFailure(failure, cwd) {
  return {
    ok: false,
    message: failure.notRepository ? notRepositoryMessage(cwd) : sentence(`${CHANGES_ERROR}: ${failure.detail}`),
  };
}

function commitsFailure(failure, cwd) {
  return {
    ok: false,
    message: failure.notRepository ? notRepositoryMessage(cwd) : sentence(`${COMMITS_ERROR}: ${failure.detail}`),
  };
}

/** Repository-relative POSIX paths; a failed listing is a failure, never an empty success. */
async function listRepositoryFiles(input = {}) {
  const run = input && input.run;
  const cwd = input && input.cwd;
  if (typeof run !== 'function') {
    return { ok: false, message: sentence(`${FILES_ERROR}: no Git runner was supplied`) };
  }
  const listed = await runGit(run, LIST_ARGS, cwd);
  if (listed.ok !== true) {
    return listingFailure(listed, cwd);
  }
  const paths = new Set();
  for (const entry of listed.stdout.split('\0')) if (entry.length > 0) paths.add(entry);
  return { ok: true, files: [...paths].sort(byCodePoint) };
}

// `XY <path>` records; a rename or copy puts its original path in the next
// field, which is not a record of its own.
function parseStatus(stdout) {
  const states = new Map();
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (typeof record !== 'string' || record.length < 4) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (filePath.length > 0) states.set(filePath, code === '??' ? 'new' : 'modified');
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return states;
}

// S3: `<letter>\0<path>\0` records, NUL terminated. `--no-renames` means the
// read produces `A`/`M`/`D`/`T` only, so a rename arrives as its two halves; a
// rename or copy record is still parsed (`<status>\0<original>\0<path>\0`, the
// original first) in case a caller ever turns detection back on, and the path the
// record is ABOUT is always the last field it carries. `A` is a path the
// merge-base does not have; anything else that is not a delete is `modified`. A
// delete maps to `deleted` so the caller drops it deliberately instead of relying
// on the path being absent.
function parseNameStatus(stdout) {
  const states = new Map();
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (typeof record !== 'string' || record.length === 0) continue;
    const letter = record[0];
    const carried = letter === 'R' || letter === 'C';
    const filePath = fields[index + (carried ? 2 : 1)];
    index += carried ? 2 : 1;
    if (typeof filePath !== 'string' || filePath.length === 0) continue;
    if (letter === 'D') states.set(filePath, 'deleted');
    else if (letter === 'A' || carried) states.set(filePath, 'added');
    else states.set(filePath, 'modified');
  }
  return states;
}

// The worktree half of the change read (S2, S5): the one name-status diff, with
// every deleted path dropped. Never throws; a failure comes back as
// `{ok:false}` so the caller paints one sentence instead of half a listing.
async function listCommitChanges(run, cwd, comparison) {
  const named = await runGit(run, commitArgs(comparison), cwd);
  if (named.ok !== true) return { ok: false, failure: named };
  const states = parseNameStatus(named.stdout);
  for (const [filePath, state] of states) if (state === 'deleted') states.delete(filePath);
  return { ok: true, states };
}

async function repositoryRoot(run, cwd) {
  const resolved = await runGit(run, ROOT_ARGS, cwd);
  if (resolved.ok !== true) return undefined;
  const root = resolved.stdout.trim();
  return root.length > 0 ? root : undefined;
}

// An mtime feeds the age label, not the list: an unreadable file or root leaves
// mtimeMs undefined rather than failing the whole listing.
function modificationTime(root, filePath) {
  if (root === undefined) return undefined;
  try {
    const stats = fs.statSync(path.join(root, filePath));
    return typeof stats.mtimeMs === 'number' && Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

// Newest change first; entries without a timestamp (a file that is not on disk,
// an unreadable root) follow the timed ones, and path breaks every tie so the
// order is stable.
function byRecency(left, right) {
  if (left.mtimeMs !== undefined && right.mtimeMs !== undefined && left.mtimeMs !== right.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  if (left.mtimeMs !== undefined && right.mtimeMs === undefined) return -1;
  if (left.mtimeMs === undefined && right.mtimeMs !== undefined) return 1;
  return byCodePoint(left.path, right.path);
}

// The age is fixed when the panel opens (S6): the caller passes `now`, and this
// module never reads the clock on its own once it has one.
function clockMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime();
  return Date.now();
}

/**
 * The picker's rows: the same file set as `listRepositoryFiles`, changed files
 * first and newest first, then untouched files by path. Each changed row carries
 * its state, its mtime and the age label computed from the injected `now`.
 *
 * `comparison` selects how the states are read (S2, S4): omitted or empty, the
 * principal checkout's own `git status`; the name of the principal BRANCH, the
 * branch's net diff against the merge-base with it (`refs/heads/<branch>`),
 * unioned with the status so uncommitted work is still marked. The commit state
 * wins where both name a path.
 */
async function listRepositoryEntries(input = {}) {
  const run = input && input.run;
  const cwd = input && input.cwd;
  const listing = await listRepositoryFiles({ run, cwd });
  if (listing.ok !== true) return { ok: false, message: listing.message };
  const comparison = input && typeof input.comparison === 'string' ? input.comparison.trim() : '';
  let committed = new Map();
  if (comparison.length > 0) {
    const read = await listCommitChanges(run, cwd, comparison);
    if (read.ok !== true) return commitsFailure(read.failure, cwd);
    committed = read.states;
  }
  const status = await runGit(run, STATUS_ARGS, cwd);
  if (status.ok !== true) {
    return changesFailure(status, cwd);
  }
  const states = new Map(committed);
  for (const [filePath, state] of parseStatus(status.stdout)) {
    if (!states.has(filePath)) states.set(filePath, state);
  }
  const changedPaths = listing.files.filter((filePath) => states.has(filePath));
  const root = changedPaths.length > 0 ? await repositoryRoot(run, cwd) : undefined;
  const nowMs = clockMs(input && input.now);
  const changed = changedPaths.map((filePath) => {
    const entry = { path: filePath, state: states.get(filePath) };
    const mtimeMs = modificationTime(root, filePath);
    if (mtimeMs !== undefined) {
      entry.mtimeMs = mtimeMs;
      entry.age = formatAge(mtimeMs, nowMs);
    }
    return entry;
  });
  changed.sort(byRecency);
  const clean = listing.files
    .filter((filePath) => !states.has(filePath))
    .sort(byCodePoint)
    .map((filePath) => ({ path: filePath, state: 'clean' }));
  return { ok: true, entries: [...changed, ...clean] };
}

/** A coarse label for one elapsed age; the caller computes it once at open (S6). */
function formatAge(mtimeMs, nowMs) {
  const elapsed = Number(nowMs) - Number(mtimeMs);
  if (!Number.isFinite(elapsed)) return '0s';
  if (elapsed < MINUTE) return `${Math.max(0, Math.floor(elapsed / 1000))}s`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

// A preview is the first bytes of a file, never the whole file: the caps keep
// one minified line, one huge binary, or one enormous source file from reaching
// the renderer. maxLineWidth counts characters, not terminal cells — the pane
// wraps, it never measures here.
const FILE_PREVIEW_LIMITS = Object.freeze({ maxBytes: 64 * 1024, maxLines: 200, maxLineWidth: 400 });

const FILE_PREVIEW_BINARY_NOTICE = 'Binary file \u2014 preview not available.';

// An override can only LOWER a bound: the limits are the guarantee that no file
// stalls the paint, so a caller that asks for more gets the default.
function bound(requested, fallback) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), fallback);
}

function previewLimits(opts) {
  const source = opts !== null && typeof opts === 'object' ? opts : {};
  return {
    maxBytes: bound(source.maxBytes, FILE_PREVIEW_LIMITS.maxBytes),
    maxLines: bound(source.maxLines, FILE_PREVIEW_LIMITS.maxLines),
    maxLineWidth: bound(source.maxLineWidth, FILE_PREVIEW_LIMITS.maxLineWidth),
  };
}

// One whole read of at most `buffer.length` bytes, so a short read or a slow
// pipe cannot cut the preview early.
function readInto(fd, buffer) {
  let length = 0;
  while (length < buffer.length) {
    const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
    if (read === 0) break;
    length += read;
  }
  return length;
}

function unreadable(relativePath, error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const named = typeof relativePath === 'string' && relativePath.length > 0 ? relativePath : 'the file';
  const reason = typeof code === 'string' ? ` (${code})` : error && typeof error.message === 'string' ? `: ${error.message}` : '';
  return { kind: 'error', message: sentence(`Cannot read ${named}${reason}`) };
}

// A preview path is repository-relative by contract; one that climbs out of the
// root is refused instead of read, so a listing can never point the preview at
// an unrelated file.
function outsideRoot(relativePath) {
  if (path.isAbsolute(relativePath)) return true;
  const normalized = path.normalize(relativePath);
  return normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.split(/[\\/]/).includes('..');
}

function readPreview(root, relativePath, opts) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { kind: 'error', message: sentence('Cannot read the file: no checkout path was given') };
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { kind: 'error', message: sentence('Cannot read the file: no path was given') };
  }
  if (outsideRoot(relativePath)) {
    return { kind: 'error', message: sentence(`Cannot read ${relativePath}: outside the checkout`) };
  }
  const limits = previewLimits(opts);
  const full = path.join(root, relativePath);
  let fd;
  try {
    fd = fs.openSync(full, 'r');
  } catch (error) {
    return unreadable(relativePath, error);
  }
  let head;
  let overBudget;
  try {
    const buffer = Buffer.allocUnsafe(limits.maxBytes);
    const length = readInto(fd, buffer);
    // A full budget is a truncation only when a further byte exists: a file of
    // exactly maxBytes previews whole.
    overBudget = length === buffer.length && fs.readSync(fd, Buffer.allocUnsafe(1), 0, 1, length) > 0;
    head = buffer.subarray(0, length);
  } catch (error) {
    return unreadable(relativePath, error);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A preview that already read its bytes is not failed by a close error.
    }
  }
  if (head.includes(0)) return { kind: 'binary', message: FILE_PREVIEW_BINARY_NOTICE };
  // A lone CR counts as a line break too, so an old Mac file reads as lines.
  const split = head.toString('utf8').replace(/\r\n?/g, '\n').split('\n');
  if (split[split.length - 1] === '') split.pop();
  const lineCapped = split.length > limits.maxLines;
  const candidates = lineCapped ? split.slice(0, limits.maxLines) : split;
  // A clipped line is not a truncated preview: the file was read whole and the
  // clip is visible in that line's own mark, so only the reader withholding
  // whole lines or bytes sets the flag.
  const lines = candidates.map((line) => (
    line.length <= limits.maxLineWidth ? line : `${line.slice(0, limits.maxLineWidth - 1)}${ELLIPSIS}`
  ));
  return { kind: 'text', lines, truncated: overBudget || lineCapped };
}

/**
 * One bounded preview of `root/relativePath`: text lines with an explicit
 * truncation flag, a notice for a binary file, or a sentence naming why the file
 * could not be read. Filesystem only, and it never throws.
 */
function readFilePreview(root, relativePath, opts) {
  try {
    return readPreview(root, relativePath, opts);
  } catch (error) {
    return unreadable(relativePath, error);
  }
}

module.exports = {
  listRepositoryEntries,
  listRepositoryFiles,
  readFilePreview,
  formatAge,
  FILE_PREVIEW_LIMITS,
  FILE_PREVIEW_BINARY_NOTICE,
};

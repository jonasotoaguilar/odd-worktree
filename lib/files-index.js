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
// Change state (S6) comes from one `git status --porcelain=v1 -z
// --untracked-files=all`: `??` is `new` (untracked), any other record is
// `updated` (tracked and dirty), and a file the status does not name is
// `clean`. Change state carries no time, so the ages come from a stat under the
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

const FILES_ERROR = 'Cannot list repository files';
const CHANGES_ERROR = 'Cannot read repository changes';

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
    if (filePath.length > 0) states.set(filePath, code === '??' ? 'new' : 'updated');
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return states;
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
 */
async function listRepositoryEntries(input = {}) {
  const run = input && input.run;
  const cwd = input && input.cwd;
  const listing = await listRepositoryFiles({ run, cwd });
  if (listing.ok !== true) return { ok: false, message: listing.message };
  const status = await runGit(run, STATUS_ARGS, cwd);
  if (status.ok !== true) {
    return changesFailure(status, cwd);
  }
  const states = parseStatus(status.stdout);
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
  let widthCapped = false;
  const lines = candidates.map((line) => {
    if (line.length <= limits.maxLineWidth) return line;
    widthCapped = true;
    return `${line.slice(0, limits.maxLineWidth - 1)}${ELLIPSIS}`;
  });
  return { kind: 'text', lines, truncated: overBudget || lineCapped || widthCapped };
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

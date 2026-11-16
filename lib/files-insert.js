'use strict';
// The file picker's insertion form (S8): the picker emits paths relative to the
// scope root it browsed, and this turns that payload into the exact text pasted
// into the prompt. Pure, so both forms are testable without a Pi session or a
// repository: a file of the session's own checkout travels as `@` plus its path
// from the session cwd, and any other file — another worktree, a path outside
// the cwd — travels as its real absolute path, because Pi resolves `@` against
// the session cwd and does not expand `~`.

const { posix } = require('node:path');

// The repository's own path style is forward slashes, and Pi resolves the same
// form on every platform; a Windows path accepts them too.
function forwardSlashes(path) {
  return String(path).replace(/\\/g, '/');
}

function normalizedPath(path) {
  const slashed = forwardSlashes(path).trim();
  if (slashed.length === 0) return '';
  const normalized = posix.normalize(slashed);
  return normalized === '.' ? '' : normalized;
}

function relativeToScope(relative) {
  return normalizedPath(relative).replace(/^(\.\/)+/, '');
}

function scopeRoot(root) {
  const normalized = normalizedPath(root);
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

// The file's real absolute path: the scope root joined with its path in it.
function absolutePath(root, relative) {
  const base = scopeRoot(root);
  return posix.normalize(base.length === 0 ? `/${relative}` : `${base}/${relative}`);
}

// The path of `absolute` below `cwd`, or undefined when the file is not under it.
function pathBelow(cwd, absolute) {
  const base = scopeRoot(cwd);
  if (base.length === 0) return undefined;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : undefined;
}

// True for a path already absolute, so it is never prefixed a second time.
function isAbsolutePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

// One file's reference. A file below the session cwd is `@` plus its path from
// that cwd, which is what Pi resolves (`@AGENTS.md`), never the path from the
// repository root: a session started in a subdirectory would name another file.
// Any other file -- outside the cwd, from another checkout, or a name that would
// read as a home reference -- is its real absolute path.
function fileReference(scope, relative) {
  const path = relativeToScope(relative);
  if (path.length === 0) return '';
  if (isAbsolutePath(path)) return path;
  const scopeInfo = scope || {};
  const absolute = absolutePath(scopeInfo.root || '', path);
  if (scopeInfo.kind !== 'main') return absolute;
  const fromCwd = pathBelow(scopeInfo.cwd || '', absolute);
  return fromCwd === undefined || fromCwd.startsWith('~') ? absolute : `@${fromCwd}`;
}

// The exact text Enter pastes for the chosen files: one reference per file,
// space-separated, in the order given, with no leading, trailing or doubled
// separator. A repeated file is named once.
function formatFileInsertion(relativePaths, scope) {
  const references = [];
  for (const relative of Array.isArray(relativePaths) ? relativePaths : []) {
    const reference = fileReference(scope, relative);
    if (reference.length > 0 && !references.includes(reference)) references.push(reference);
  }
  return references.join(' ');
}

module.exports = { fileReference, formatFileInsertion };

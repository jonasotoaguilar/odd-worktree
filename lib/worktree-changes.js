'use strict';
// Reusable pending-changes helper (customize-command S61/T47): dirty
// summary (N files +N/-N) plus the safe working-tree copy warp and the
// tool use. One module, never two implementations: the warp command,
// the worktree_warp tool and the close/delete confirmations all read
// through here.
//
// Why this shape: staged AND unstaged changes are read as ONE diff
// against HEAD (`git diff --numstat -M HEAD`), so a file changed in both
// places counts once, never twice. Untracked files never appear in that
// diff, so they are listed separately through `git status --porcelain -z`
// and measured from disk (text line counts; binary only labelled, never
// faked). Every external process is a fixed argv array with a bounded
// timeout — never a shell string, never a long sync block of the UI.
// Nothing here mutates the source or its index: the summary only reads,
// and the copy writes only into the destination.
//
// Containment: every selected path must resolve inside the source
// checkout, must not be (or hide behind) `.git`, must not traverse
// (`..`) out, and must not escape through a symlink. The destination
// overlap rule is a hard reject: when any selected path already carries
// destination modifications, nothing is copied, warped or switched.
// Writes are contained on the destination side too: the target entry must not
// be a symlink, and EVERY component between the checkout and the target must be
// a real directory whose realpath stays inside the checkout, proved again level
// by level while missing directories are created one at a time (a recursive
// mkdir would create the tree wherever a symlinked component points). Node has
// no `openat`/`RESOLVE_BENEATH`, so the checks run synchronously immediately
// before each write and the result is re-proved afterwards; a component swapped
// for a symlink in the instant between the last check and the write is the one
// case this architecture cannot exclude, and it is reported if the write lands
// outside.
// A dry-run (`git apply --check`) guards branch-base mismatch before any
// write; an unsupported case fails BEFORE the write and says so instead
// of leaving a partial copy. A failure DURING the apply is different: an earlier
// plan may already have landed, so it is reported against what is actually on
// disk (the files named, the rest counted) instead of claiming nothing was
// copied.
//
// A destination built from ANOTHER base is resolved file by file, never by
// re-diffing against its own HEAD: the committed source-branch delta stays
// behind, the pending edit travels, destination-only content survives, and a
// real conflict refuses with zero mutation and says how to get unstuck.
// `Divergent-base transfer` below is that leg.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const SUMMARY_TIMEOUT_MS = 30000;
const COPY_TIMEOUT_MS = 60000;

// Parse `git diff --numstat -z -M HEAD` output. With -z a plain record
// is one `<added>\t<deleted>\t<path>` token, while a rename (or copy)
// is `<added>\t<deleted>\t` with an EMPTY path followed by TWO tokens:
// the old path and the new path (`0\t0\t\0old\0new\0`). `-` counts
// mean binary. Returns [{added, deleted, binary, oldRel, rel}].
function parseNumstatZ(stdout) {
  const out = [];
  if (typeof stdout !== 'string' || stdout.length === 0) return out;
  const isRecord = (token) => typeof token === 'string' && /^(\d+|-)\t(\d+|-)\t/.test(token);
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '') continue;
    const match = token.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const added = binary ? 0 : Number(match[1]);
    const deleted = binary ? 0 : Number(match[2]);
    let oldRel = match[3];
    let rel = match[3];
    const next1 = tokens[i + 1];
    const next2 = tokens[i + 2];
    const plain1 = typeof next1 === 'string' && next1 !== '' && !isRecord(next1);
    const plain2 = typeof next2 === 'string' && next2 !== '' && !isRecord(next2);
    if (match[3] === '' && plain1 && plain2) {
      // A rename pair: the empty path plus old and new.
      oldRel = next1;
      rel = next2;
      i += 2;
    } else if (match[3] === '' && plain1) {
      // Defensive: an empty path with a single follower names one file.
      oldRel = next1;
      rel = next1;
      i += 1;
    }
    out.push({
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      binary,
      oldRel,
      rel,
    });
  }
  return out;
}

// Default async git runner: fixed argv through worktree-git's async
// runner (bounded timeout, never a shell string). Injectable in tests
// via opts.runAsync(bin, args, cwd).
async function defaultRunAsync(bin, args, cwd, timeoutMs) {
  let git = null;
  try {
    git = require('./worktree-git.js');
  } catch {
    git = null;
  }
  if (git && typeof git.runArgvAsync === 'function') {
    return git.runArgvAsync(bin, args, { cwd, timeoutMs });
  }
  return { status: null, stdout: '', stderr: '', error: 'async git runner is unavailable' };
}

// Is `abs` inside `base` (or equal)? Pure lexical check on resolved
// paths; symlink escape is checked separately through realpath.
function isInsideOrEqual(base, abs) {
  const relative = path.relative(base, abs);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// True when the checkout-relative path touches repository metadata.
function isGitInternal(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return true;
  const parts = rel.split(path.sep);
  return parts.includes('.git');
}

// Binary probe: a NUL byte in the first bytes. Never fakes line counts.
function probeBinary(absPath, fsImpl) {
  try {
    const fd = fsImpl.openSync(absPath, 'r');
    try {
      const size = Math.min(8192, fsImpl.fstatSync(fd).size);
      if (size <= 0) return { binary: false };
      const buf = Buffer.alloc(size);
      fsImpl.readSync(fd, buf, 0, size, 0);
      return { binary: buf.includes(0) };
    } finally {
      try { fsImpl.closeSync(fd); } catch { /* a close failure never fails the probe */ }
    }
  } catch {
    return { binary: false };
  }
}

// Count added lines of an untracked text file from disk.
function countAddedLines(absPath, fsImpl) {
  try {
    const text = fsImpl.readFileSync(absPath, 'utf8');
    if (text.length === 0) return 0;
    const parts = text.split('\n');
    return text.endsWith('\n') ? parts.length - 1 : parts.length;
  } catch {
    return 0;
  }
}

// Resolve the repository root for a checkout without trusting the
// process cwd: through the shared repoIdentity helper.
function resolveRepoRoot(checkoutPath, git) {
  const identity = git.repoIdentity(checkoutPath);
  return identity.root;
}

// Resolve the shared git common dir for a checkout: the identity two
// checkouts of one repository (principal or linked worktrees) share,
// while two repositories never do.
function repoCommonDir(checkoutPath, git) {
  // S22 (round 3): the shared memoized resolver when the caller passed the
  // real git module; an injected test double keeps its own `repoIdentity`.
  const commonDir = typeof git.commonDirFor === 'function'
    ? git.commonDirFor(checkoutPath)
    : (git.repoIdentity(checkoutPath) || {}).commonDir;
  if (typeof commonDir !== 'string' || commonDir.length === 0) {
    throw new Error(`cannot resolve git common dir: ${checkoutPath}`);
  }
  return commonDir;
}

// Summarize the pending working-tree changes of ONE checkout.
// Reads only: never mutates the source or its index. Staged and
// unstaged changes combine through the single HEAD diff (no
// double-counting); untracked files come from `git status -z` and are
// measured from disk. Returns
// {ok, checkout, root, files, added, deleted, binaryCount, entries}
// where each entry is {path, rel, status, added, deleted, binary,
// untracked}. Failures are {ok:false, error}.
async function summarizeChanges(checkoutPath, opts = {}) {
  const fsImpl = opts.fs || fs;
  const git = opts.git || (() => { try { return require('./worktree-git.js'); } catch { return null; } })();
  if (!git || typeof git.repoIdentity !== 'function') {
    return { ok: false, error: 'git helper is unavailable' };
  }
  if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
    return { ok: false, error: 'checkout path is empty' };
  }
  let checkout;
  let root;
  try {
    checkout = path.resolve(checkoutPath);
    root = resolveRepoRoot(checkout, git);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  // The checkout must exist as a directory; anything else is not a
  // checkout we summarize.
  try {
    const st = fsImpl.statSync(checkout);
    if (!st.isDirectory()) return { ok: false, error: `not a checkout directory: ${checkout}` };
  } catch (err) {
    return { ok: false, error: `cannot read checkout at ${checkout}: ${(err && err.message) || err}` };
  }
  const runAsync = typeof opts.runAsync === 'function'
    ? opts.runAsync
    : (bin, args, cwd) => defaultRunAsync(bin, args, cwd, opts.timeoutMs || SUMMARY_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs || SUMMARY_TIMEOUT_MS;
  void timeoutMs;
  let diff;
  try {
    diff = await runAsync('git', ['diff', '--numstat', '-z', '-M', 'HEAD', '--'], checkout);
  } catch (err) {
    return { ok: false, error: `cannot diff ${checkout}: ${(err && err.message) || err}` };
  }
  if (!diff || diff.status !== 0) {
    const reason = (diff && ((diff.stderr || '').trim().split('\n')[0] || diff.error)) || `exit ${diff && diff.status}`;
    return { ok: false, error: `cannot diff ${checkout}: ${reason}` };
  }
  let status;
  try {
    status = await runAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'], checkout);
  } catch (err) {
    return { ok: false, error: `cannot status ${checkout}: ${(err && err.message) || err}` };
  }
  if (!status || status.status !== 0) {
    const reason = (status && ((status.stderr || '').trim().split('\n')[0] || status.error)) || `exit ${status && status.status}`;
    return { ok: false, error: `cannot status ${checkout}: ${reason}` };
  }
  const entries = [];
  const seen = new Set();
  for (const record of parseNumstatZ(diff.stdout || '')) {
    const rel = String(record.rel || '');
    if (rel.length === 0 || isGitInternal(rel)) continue;
    const abs = path.resolve(checkout, rel);
    if (!isInsideOrEqual(checkout, abs)) continue;
    // A record that resolves through a symlink outside the checkout is
    // refused: the copy must never follow it out.
    try {
      const real = fsImpl.realpathSync(abs);
      if (!isInsideOrEqual(checkout, real) && !isInsideOrEqual(root, real)) {
        // Realpath inside the REPO but outside this checkout (a linked
        // worktree reaching another checkout through a symlink) still
        // refuses: the change belongs to another checkout.
        if (!isInsideOrEqual(checkout, real)) continue;
      }
    } catch {
      // A missing path (a deletion) has no realpath; keep it.
    }
    entries.push({
      path: abs,
      rel,
      status: record.oldRel !== rel ? 'renamed' : 'modified',
      added: record.added,
      deleted: record.deleted,
      binary: record.binary,
      untracked: false,
    });
    seen.add(abs);
  }
  // Untracked files from `git status -z`: `?? <path>` tokens. Renames in
  // status (`R  old -> new`) are already covered by the diff; only `??`
  // rows add entries here.
  const statusTokens = String(status.stdout || '').split('\0');
  const untrackedRels = [];
  for (const token of statusTokens) {
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    if (code !== '??') continue;
    const rel = token.slice(3);
    if (rel.length === 0 || isGitInternal(rel)) continue;
    untrackedRels.push(rel);
  }
  for (const rel of untrackedRels) {
    const abs = path.resolve(checkout, rel);
    if (!isInsideOrEqual(checkout, abs)) continue;
    if (seen.has(abs)) continue;
    let st = null;
    try {
      st = fsImpl.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // With --untracked-files=all directories arrive as files, but a
      // defensive walk covers the spelling that lists a directory.
      let nested = [];
      try {
        nested = walkFiles(abs, fsImpl);
      } catch {
        continue;
      }
      for (const file of nested) {
        const fileRel = path.relative(checkout, file);
        if (fileRel.length === 0 || fileRel.startsWith('..') || path.isAbsolute(fileRel)) continue;
        if (isGitInternal(fileRel)) continue;
        if (seen.has(file)) continue;
        entries.push(measureUntracked(file, fileRel, fsImpl));
        seen.add(file);
      }
      continue;
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    // A symlink at the path escapes when its referent leaves the
    // checkout: refuse it rather than copying through it.
    try {
      if (st.isSymbolicLink()) {
        const real = fsImpl.realpathSync(abs);
        if (!isInsideOrEqual(checkout, real)) continue;
      }
    } catch {
      // A dangling symlink names nothing to copy; skip it.
      continue;
    }
    entries.push(measureUntracked(abs, rel, fsImpl));
    seen.add(abs);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let added = 0;
  let deleted = 0;
  let binaryCount = 0;
  for (const entry of entries) {
    added += entry.added;
    deleted += entry.deleted;
    if (entry.binary) binaryCount += 1;
  }
  return {
    ok: true, checkout, root, files: entries.length, added, deleted, binaryCount, entries,
  };
}

function measureUntracked(abs, rel, fsImpl) {
  let binary = false;
  try {
    binary = probeBinary(abs, fsImpl).binary;
  } catch {
    binary = false;
  }
  return {
    path: abs,
    rel,
    status: 'untracked',
    added: binary ? 0 : countAddedLines(abs, fsImpl),
    deleted: 0,
    binary,
    untracked: true,
  };
}

function walkFiles(dir, fsImpl) {
  const out = [];
  const stack = [dir];
  let guard = 0;
  while (stack.length > 0) {
    guard += 1;
    if (guard > 5000) break;
    const current = stack.pop();
    let names;
    try {
      names = fsImpl.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names || []) {
      const full = path.join(current, name);
      let st;
      try {
        st = fsImpl.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  return out;
}

// `3 files, +10/-2`, with ` (1 binary)` appended only when binary files
// are present (binary counts are never faked, only labelled).
function formatChangeSummary(summary) {
  if (!summary || typeof summary.files !== 'number') return '0 files, +0/-0';
  const base = `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}`;
  if (summary.binaryCount > 0) return `${base} (${summary.binaryCount} binary)`;
  return base;
}

// Normalize the tool's `changes` option. Omitted, empty string and empty
// array all mean "copy nothing"; the string "all" means everything; an
// array of paths means exactly those files. Anything else fails closed.
function normalizeChangesSelection(value) {
  if (value === undefined || value === null) return { ok: true, mode: 'none', paths: [] };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, mode: 'none', paths: [] };
    if (trimmed === 'all') return { ok: true, mode: 'all', paths: [] };
    return { ok: false, error: `invalid changes selection ${JSON.stringify(value)}: pass \"all\", a list of files, or leave it empty for no copy` };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: true, mode: 'none', paths: [] };
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return { ok: false, error: 'invalid changes selection: every entry must be a non-empty file path' };
      }
    }
    return { ok: true, mode: 'paths', paths: value.slice() };
  }
  return { ok: false, error: 'invalid changes selection: pass \"all\", a list of files, or leave it empty for no copy' };
}

// Match a selection entry against a summary entry: absolute path, or the
// checkout-relative spelling. Returns the matched summary entries, or
// {ok:false} naming the unknown file (fail closed, no partial match).
function matchSelection(summary, mode, paths) {
  if (mode === 'none') return { ok: true, entries: [] };
  if (mode === 'all') return { ok: true, entries: summary.entries.slice() };
  const matched = [];
  const unknown = [];
  for (const raw of paths) {
    const trimmed = String(raw).trim();
    const asAbs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(summary.checkout, trimmed);
    const found = summary.entries.find((entry) => entry.path === asAbs || entry.rel === trimmed);
    if (found) matched.push(found);
    else unknown.push(trimmed);
  }
  if (unknown.length > 0) {
    return { ok: false, error: `unknown changed file${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => JSON.stringify(u)).join(', ')} (nothing was copied)` };
  }
  // De-duplicate while keeping summary order.
  const picked = new Set(matched.map((entry) => entry.path));
  return { ok: true, entries: summary.entries.filter((entry) => picked.has(entry.path)) };
}

// ---------------------------------------------------------------------------
// Divergent-base transfer (the second leg of a copy).
//
// The plain transfer is ONE patch: `git diff HEAD` in the source, applied to
// the destination working tree. That is exact while the destination still
// holds the source's own HEAD blob for every selected file — and it fails
// closed the moment it does not, which is the ORDINARY case for the checkout a
// warp or a create lands in: `worktree_create` builds the new branch from
// LOCAL main, and a worktree made before the source branch's last commit
// carries none of its files. The destination then either has no file at that
// path (the patch says "modify" and there is nothing to modify) or holds a
// different version of it (the hunks no longer match).
//
// The fallback keeps the intent EXACTLY the same — carry the PENDING edit,
// source HEAD -> source worktree — and never the source branch's committed
// delta. Diffing the destination HEAD against the source working tree would do
// the latter: it would import every committed source-branch change and
// overwrite destination-only content. So each file is resolved on its own:
//
//   * the file's own patch applies       -> apply it (git's own semantics for
//                                           modes, renames and filters);
//   * the destination has no file there  -> create it from the source working
//     and the path is absent from the      tree, but ONLY when the path is also
//     two branches' merge base             absent from the branches' merge base,
//     i.e. it is genuinely new on the source side. A path the destination
//     branch removed is REFUSED: restoring it would bring back content that
//     side deleted on purpose;
//   * the destination holds a different  -> three-way merge with the source HEAD
//     version of the file                  blob as base, the destination's file
//     as "ours" and the source's working tree as "theirs": the pending edit
//     travels and destination-only content survives;
//   * a real conflict, a rename, a mode  -> refuse, naming every file, and say
//     change or a binary divergence         how the human gets unstuck: resolve
//                                           the conflict first, or warp again
//                                           without copying.
//
// Every check and every merge runs in a system temp directory BEFORE the first
// write, so a refusal mutates NOTHING; the applied result is then verified
// (destination-only files unchanged, every planned effect landed, no path that
// was not selected changed).
//
// Bytes are never round-tripped through text: the git runner hands back UTF-8
// STRINGS, so the merge writes into a temp file and the result is read back as
// bytes, and the base is used only when its text re-encodes to the exact blob
// git recorded (`git hash-object` against the oid from `git diff --raw`). A
// file whose bytes do not survive that roundtrip — a latin-1 file, anything
// with a stray high byte — is refused instead of being silently rewritten with
// U+FFFD replacement characters. Binary files are never merged by line at all:
// an exactly-matching base takes the patch, anything else refuses.

const CONFLICT_ADVICE = 'resolve the conflict first, or warp again without copying';

// Content identity for verification: never faked, binary safe, bounded memory.
function fingerprintBytes(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

function fingerprintFile(abs, fsImpl) {
  try {
    return fingerprintBytes(fsImpl.readFileSync(abs));
  } catch {
    return null;
  }
}

// One worktree entry, byte for byte, with the facts a plan needs: what is there
// (a regular file, a symlink, a directory, nothing, or something unreadable) and
// whether it looks binary (the same NUL probe the summary uses). `missing` and
// `unreadable` are kept apart on purpose: an unreadable file is not a deletion.
function readWorktreeFile(abs, fsImpl) {
  const absent = (kind) => ({ kind, exists: false, bytes: null, mode: null, binary: false });
  let st;
  try {
    st = fsImpl.lstatSync(abs);
  } catch (err) {
    const code = err && err.code;
    return absent(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }
  if (st.isSymbolicLink()) return { ...absent('symlink'), mode: st.mode };
  if (st.isDirectory()) return { ...absent('directory'), mode: st.mode };
  if (!st.isFile()) return { ...absent('other'), mode: st.mode };
  let bytes;
  try {
    bytes = fsImpl.readFileSync(abs);
  } catch {
    return { ...absent('unreadable'), mode: st.mode };
  }
  return { kind: 'file', exists: true, bytes, mode: st.mode, binary: bytes.includes(0) };
}

function isZeroOid(oid) {
  return typeof oid !== 'string' || oid.length === 0 || /^0+$/.test(oid);
}

// What sits at the destination path, when it is not a regular file the copy may
// write. A symbolic link is named separately because `writeFileSync` would
// FOLLOW it out of the checkout, which no copy may ever do.
function destObstruction(abs, fsImpl) {
  try {
    const st = fsImpl.lstatSync(abs);
    if (st.isSymbolicLink()) return 'a symbolic link';
    if (st.isDirectory()) return 'a directory';
    if (!st.isFile()) return 'something other than a regular file';
    return null;
  } catch {
    return null;
  }
}

// The real path of a checkout, so a checkout reached through a symlinked
// spelling compares equal to itself and a component's realpath can be proved to
// stay inside it.
function checkoutReal(abs, fsImpl) {
  try {
    return fsImpl.realpathSync(abs);
  } catch {
    return path.resolve(abs);
  }
}

// The separators a checkout-relative path is built from on THIS platform: a
// backslash splits components on Windows only, while on POSIX it is an ordinary
// character inside a file name (splitting on it there would invent a directory
// component the selection never named, and leave the file one level too deep).
const PATH_COMPONENT_SEPARATORS = path.sep === '\\' ? /[\\/]+/ : /\/+/;

// Write-path containment for ONE destination-relative path.
//
// A path can leave the checkout without its own entry being a link: a PARENT
// DIRECTORY that is a symlink carries the write somewhere else, and the target's
// own lstat cannot see it. Node exposes neither `openat` nor
// `RESOLVE_BENEATH`, so the proof is made here, component by component, and it
// is repeated immediately before each write: every component between the
// checkout and the target must be a real directory whose realpath is inside the
// checkout, and the components this copy must create are created ONE LEVEL AT A
// TIME and re-proved right after creation (a plain `mkdirSync({recursive:true})`
// would create the tree wherever a link points).
function containWritePath({ rel, toAbs, baseReal, create, fsImpl }) {
  const parts = String(rel).split(PATH_COMPONENT_SEPARATORS).filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0) return { ok: false, error: 'the selected path is empty' };
  if (parts.some((part) => part === '..')) {
    return { ok: false, error: `${JSON.stringify(rel)} traverses out of the destination checkout` };
  }
  let current = toAbs;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = path.join(current, parts[i]);
    const relDir = parts.slice(0, i + 1).join('/');
    let st = null;
    try {
      st = fsImpl.lstatSync(next);
    } catch (err) {
      const code = err && err.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return { ok: false, error: `the destination's ${JSON.stringify(relDir)} cannot be inspected` };
      }
      // Nothing is there yet: nothing can be traversed through it right now,
      // and while planning the copy creates nothing at all.
      if (!create) return { ok: true };
      try {
        fsImpl.mkdirSync(next);
      } catch (mkdirErr) {
        const mkdirCode = mkdirErr && mkdirErr.code;
        if (mkdirCode !== 'EEXIST') {
          return { ok: false, error: `the destination's ${JSON.stringify(relDir)} cannot be created` };
        }
      }
      try {
        st = fsImpl.lstatSync(next);
      } catch {
        return { ok: false, error: `the destination's ${JSON.stringify(relDir)} cannot be inspected after creation` };
      }
    }
    if (st.isSymbolicLink()) {
      return { ok: false, error: `the destination's ${JSON.stringify(relDir)} is a symbolic link, so a copy never writes through it` };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: `the destination's ${JSON.stringify(relDir)} is not a directory` };
    }
    let real = null;
    try {
      real = fsImpl.realpathSync(next);
    } catch {
      real = null;
    }
    if (real === null || !isInsideOrEqual(baseReal, real)) {
      return { ok: false, error: `the destination's ${JSON.stringify(relDir)} resolves outside the destination checkout` };
    }
    current = next;
  }
  // The parent of the file itself, proved last so the check and the write are as
  // close together as the architecture allows.
  const parentReal = (() => {
    try {
      return fsImpl.realpathSync(current);
    } catch {
      return null;
    }
  })();
  if (parentReal === null || !isInsideOrEqual(baseReal, parentReal)) {
    return { ok: false, error: `the destination's parent directory for ${JSON.stringify(rel)} resolves outside the destination checkout` };
  }
  return { ok: true };
}

// Containment pass over the planned WRITES (the patch leg is git's own; it
// refuses paths outside the work tree). Planning runs it with `create: false`,
// so a refusal mutates nothing; the apply leg runs it again with `create: true`
// right before each write.
function containPlannedWrites({ plans, toAbs, baseReal, create, fsImpl }) {
  for (const plan of plans) {
    if (plan.kind !== 'copy' && plan.kind !== 'create' && plan.kind !== 'write') continue;
    const contained = containWritePath({ rel: plan.rel, toAbs, baseReal, create, fsImpl });
    if (!contained.ok) return contained;
  }
  return { ok: true };
}

// Parse `git diff --raw -z -M HEAD`: `:<old mode> <new mode> <old oid>
// <new oid> <status>` followed by the path (a rename or a copy carries BOTH
// paths). The old oid is the HEAD blob the pending edit started from — the base
// a three-way merge needs — and the status letter separates a content edit from
// an add, a delete, a rename or a mode change.
function parseRawZ(stdout) {
  const out = [];
  if (typeof stdout !== 'string' || stdout.length === 0) return out;
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string' || token.charAt(0) !== ':') continue;
    const fields = token.slice(1).split(' ');
    if (fields.length < 5) continue;
    const [oldMode, newMode, oldOid, newOid, statusField] = fields;
    const status = statusField.charAt(0);
    if (status === 'R' || status === 'C') {
      const oldRel = tokens[i + 1];
      const rel = tokens[i + 2];
      if (typeof oldRel !== 'string' || typeof rel !== 'string' || rel.length === 0) break;
      i += 2;
      out.push({ oldMode, newMode, oldOid, newOid, status, oldRel, rel });
      continue;
    }
    const rel = tokens[i + 1];
    if (typeof rel !== 'string' || rel.length === 0) break;
    i += 1;
    out.push({ oldMode, newMode, oldOid, newOid, status, oldRel: rel, rel });
  }
  return out;
}

// The pending edit of exactly these paths, as a patch the destination can try.
// `--binary` keeps a binary file's change exact; `-M` keeps a rename one entry.
async function selectedPatch({ rels, fromAbs, runAsync }) {
  let res;
  try {
    res = await runAsync('git', ['diff', '--binary', '-M', 'HEAD', '--', ...rels], fromAbs);
  } catch (err) {
    return { ok: false, error: `diff failed (${(err && err.message) || err})` };
  }
  if (!res || res.status !== 0) {
    const reason = (res && ((res.stderr || '').trim().split('\n')[0] || res.error)) || 'diff failed';
    return { ok: false, error: `diff failed (${reason})` };
  }
  if (typeof res.stdout !== 'string' || res.stdout.length === 0) {
    return { ok: false, error: 'the tracked selection produced no patch' };
  }
  return { ok: true, text: res.stdout };
}

// Dry-run or apply one patch. The patch file lives in the system temp dir
// (never inside the worktree) and the apply never passes `--index`, so both
// indexes are preserved by construction.
async function applyPatchText({ text, toAbs, runAsync, fsImpl, tmpDir, name, checkOnly }) {
  const file = path.join(tmpDir, `${name}.patch`);
  try {
    fsImpl.writeFileSync(file, text);
  } catch (err) {
    return { ok: false, error: `cannot stage the patch (${(err && err.message) || err})` };
  }
  const args = checkOnly
    ? ['apply', '--check', '--whitespace=nowarn', file]
    : ['apply', '--whitespace=nowarn', file];
  let res;
  try {
    res = await runAsync('git', args, toAbs);
  } catch (err) {
    return { ok: false, error: `git apply failed (${(err && err.message) || err})` };
  }
  if (!res || res.status !== 0) {
    const reason = (res && ((res.stderr || '').trim().split('\n')[0] || res.error)) || 'patch does not apply';
    return { ok: false, error: reason };
  }
  return { ok: true };
}

// `git merge-file` over the three sides, merged IN PLACE in the temp directory
// and read back as bytes. The result never travels through stdout, because the
// git runner hands back text: a merged file holding a byte that is not valid
// UTF-8 would come back as U+FFFD and be written that way. Exit 0 is a clean
// merge; 1..127 is a real conflict, and the marker text is dropped on purpose —
// a conflict is reported, never written into anyone's file.
async function mergeThreeWay({ sides, tmpDir, runAsync, fsImpl, name }) {
  const oursPath = path.join(tmpDir, `${name}-ours`);
  const basePath = path.join(tmpDir, `${name}-base`);
  const theirsPath = path.join(tmpDir, `${name}-theirs`);
  try {
    fsImpl.writeFileSync(oursPath, sides.ours);
    fsImpl.writeFileSync(basePath, sides.base);
    fsImpl.writeFileSync(theirsPath, sides.theirs);
  } catch (err) {
    return { ok: false, error: `cannot prepare the merge (${(err && err.message) || err})` };
  }
  let res;
  try {
    res = await runAsync('git', ['merge-file', oursPath, basePath, theirsPath], tmpDir);
  } catch (err) {
    return { ok: false, error: `merge failed (${(err && err.message) || err})` };
  }
  if (!res || typeof res.status !== 'number') {
    return { ok: false, error: `merge failed (${(res && (res.error || (res.stderr || '').trim())) || 'no exit status'})` };
  }
  if (res.status === 0) {
    let bytes;
    try {
      bytes = fsImpl.readFileSync(oursPath);
    } catch (err) {
      return { ok: false, error: `the merged result could not be read back (${(err && err.message) || err})` };
    }
    return { ok: true, bytes };
  }
  if (res.status > 0 && res.status < 128) return { ok: false, conflict: true };
  const reason = (res.stderr || '').trim().split('\n')[0] || `exit ${res.status}`;
  return { ok: false, error: `merge failed (${reason})` };
}

// The merge base reaches us as TEXT, so it is only usable when that text
// re-encodes to the exact blob git recorded. Proving it with the blob's own oid
// (never a heuristic about which bytes "look" like text) is what keeps a merge
// from rewriting content it never actually saw: any byte that does not survive
// the roundtrip fails here and the file is refused instead of being silently
// turned into U+FFFD.
async function baseIsByteExact({ baseBytes, oid, tmpDir, runAsync, fsImpl, name }) {
  const file = path.join(tmpDir, `${name}-base.bin`);
  try {
    fsImpl.writeFileSync(file, baseBytes);
  } catch {
    return false;
  }
  let res;
  try {
    res = await runAsync('git', ['hash-object', '--no-filters', '--', file], tmpDir);
  } catch {
    return false;
  }
  if (!res || res.status !== 0 || typeof res.stdout !== 'string') return false;
  return res.stdout.trim() === oid;
}

// The merge base of the two checkouts, resolved once per copy and only when a
// selected path is missing at the destination.
async function resolveMergeBase({ fromAbs, toAbs, runAsync }) {
  let head = null;
  try {
    head = await runAsync('git', ['rev-parse', 'HEAD'], fromAbs);
  } catch {
    head = null;
  }
  const sha = head && head.status === 0 && typeof head.stdout === 'string' ? head.stdout.trim() : '';
  if (sha === '') return null;
  let base = null;
  try {
    base = await runAsync('git', ['merge-base', 'HEAD', sha], toAbs);
  } catch {
    base = null;
  }
  const tree = base && base.status === 0 && typeof base.stdout === 'string' ? base.stdout.trim() : '';
  return tree === '' ? null : tree;
}

async function pathInMergeBase({ rel, fromAbs, toAbs, runAsync, cache }) {
  if (cache.resolved !== true) {
    cache.resolved = true;
    cache.tree = await resolveMergeBase({ fromAbs, toAbs, runAsync });
  }
  if (cache.tree === null) return null;
  let res;
  try {
    res = await runAsync('git', ['ls-tree', '-r', '-z', '--name-only', cache.tree, '--', rel], toAbs);
  } catch {
    return null;
  }
  if (!res || res.status !== 0) return null;
  return typeof res.stdout === 'string' && res.stdout.length > 0;
}

// Resolve ONE selected tracked file whose destination copy no longer holds the
// source's base. Returns a plan, a conflict, or a refusal — never a write.
async function planDivergedFile({ entry, fact, index, fromAbs, toAbs, runAsync, fsImpl, tmpDir, mergeBaseCache }) {
  const rel = entry.rel;
  if (fact === null) {
    return { refusal: `the pending change of ${JSON.stringify(rel)} could not be read` };
  }
  if (fact.status === 'R' || fact.status === 'C') {
    return { refusal: `${JSON.stringify(rel)} is a rename or a copy and the destination's copy has diverged, so it cannot be carried automatically` };
  }
  if (fact.oldMode !== fact.newMode) {
    return { refusal: `${JSON.stringify(rel)} carries a mode change and the destination's copy has diverged, so it cannot be carried automatically` };
  }
  const srcState = readWorktreeFile(path.resolve(fromAbs, rel), fsImpl);
  const destState = readWorktreeFile(path.resolve(toAbs, rel), fsImpl);
  const obstruction = destObstruction(path.resolve(toAbs, rel), fsImpl);
  if (obstruction !== null) {
    return { refusal: `the destination has ${obstruction} at ${JSON.stringify(rel)}, and a copy never writes through it` };
  }
  // "Nothing to read" is not the same as "the source deleted it": a path the
  // copy cannot read is reported as unreadable (or as the kind of entry it is),
  // never as a deletion.
  if (srcState.kind === 'unreadable') {
    return { refusal: `${JSON.stringify(rel)} cannot be read in the source checkout, so it cannot be carried` };
  }
  if (srcState.kind === 'symlink' || srcState.kind === 'directory' || srcState.kind === 'other') {
    return { refusal: `the source's ${JSON.stringify(rel)} is ${srcState.kind === 'symlink' ? 'a symbolic link' : srcState.kind === 'directory' ? 'a directory' : 'neither a regular file nor a symlink'}, so it cannot be carried onto a diverged destination` };
  }
  if (destState.kind === 'unreadable') {
    return { refusal: `the destination's copy of ${JSON.stringify(rel)} cannot be read, so it cannot be compared or merged` };
  }
  const hasBase = !isZeroOid(fact.oldOid);
  const binary = entry.binary === true || srcState.binary === true || destState.binary === true;
  if (!srcState.exists) {
    // The pending change is a deletion.
    if (!destState.exists) return { skip: true };
    return { refusal: `the source deletes ${JSON.stringify(rel)} while the destination's own version of it has diverged, so deleting it would throw that work away` };
  }
  if (!destState.exists) {
    // The destination has no file here at all: the only safe creation is a path
    // the two branches never shared, i.e. genuinely new on the source side.
    if (hasBase) {
      const inBase = await pathInMergeBase({ rel, fromAbs, toAbs, runAsync, cache: mergeBaseCache });
      if (inBase === null) {
        return { refusal: `the two branches' merge base could not be read for ${JSON.stringify(rel)}` };
      }
      if (inBase) {
        return { refusal: `the destination has no ${JSON.stringify(rel)} although both branches once had it, so it was removed on the destination side and copying would restore a file that side deleted` };
      }
    }
    return { plan: { kind: 'create', rel, bytes: srcState.bytes, mode: srcState.mode } };
  }
  if (!hasBase) {
    // A pending ADD landing on a file the destination already has.
    if (destState.bytes.equals(srcState.bytes)) return { skip: true };
    return { refusal: `the destination already holds a different file at ${JSON.stringify(rel)}` };
  }
  if (binary) {
    return { refusal: `${JSON.stringify(rel)} is binary and the destination's copy has diverged, so it cannot be merged` };
  }
  let base = null;
  try {
    base = await runAsync('git', ['cat-file', 'blob', fact.oldOid], fromAbs);
  } catch {
    base = null;
  }
  if (!base || base.status !== 0 || typeof base.stdout !== 'string') {
    return { refusal: `the base of ${JSON.stringify(rel)} could not be read` };
  }
  if (base.stdout.includes('\u0000')) {
    return { refusal: `${JSON.stringify(rel)} is binary and the destination's copy has diverged, so it cannot be merged` };
  }
  const baseBytes = Buffer.from(base.stdout, 'utf8');
  const baseName = `merge-${index}`;
  if (!await baseIsByteExact({ baseBytes, oid: fact.oldOid, tmpDir, runAsync, fsImpl, name: baseName })) {
    return { refusal: `${JSON.stringify(rel)} does not survive a UTF-8 roundtrip, so its base cannot be reproduced byte for byte and it cannot be merged byte-exactly` };
  }
  const merged = await mergeThreeWay({
    sides: { ours: destState.bytes, base: baseBytes, theirs: srcState.bytes },
    tmpDir,
    runAsync,
    fsImpl,
    name: baseName,
  });
  if (merged.conflict) return { conflict: rel };
  if (!merged.ok) return { refusal: `${merged.error} for ${JSON.stringify(rel)}` };
  return { plan: { kind: 'write', rel, bytes: merged.bytes } };
}

// Everything the copy will do, decided BEFORE anything is written: one patch
// for the whole selection when the destination still holds the source base, or
// one plan per file when it does not.
async function planTransfer({ tracked, untracked, fromAbs, toAbs, runAsync, fsImpl, tmpDir }) {
  const plans = [];
  if (tracked.length > 0) {
    const rels = tracked.map((entry) => entry.rel);
    const whole = await selectedPatch({ rels, fromAbs, runAsync });
    if (!whole.ok) {
      return { ok: false, error: `cannot copy changes: ${whole.error} (nothing was copied)` };
    }
    const check = await applyPatchText({ text: whole.text, toAbs, runAsync, fsImpl, tmpDir, name: 'selection', checkOnly: true });
    if (check.ok) {
      plans.push({ kind: 'patch', text: whole.text, rels, name: 'selection' });
    } else {
      const perFile = await planTrackedFiles({ tracked, fromAbs, toAbs, runAsync, fsImpl, tmpDir });
      if (!perFile.ok) return perFile;
      plans.push(...perFile.plans);
    }
  }
  for (const entry of untracked) {
    const destPath = path.resolve(toAbs, entry.rel);
    const obstruction = destObstruction(destPath, fsImpl);
    if (obstruction !== null) {
      return {
        ok: false,
        error: `cannot copy changes: the destination has ${obstruction} at ${JSON.stringify(entry.rel)}, and a copy never writes through it: ${CONFLICT_ADVICE} (nothing was copied)`,
      };
    }
    const destState = readWorktreeFile(destPath, fsImpl);
    if (destState.kind === 'unreadable') {
      return {
        ok: false,
        error: `cannot copy changes: the destination's ${JSON.stringify(entry.rel)} cannot be read, so it cannot be proven identical: ${CONFLICT_ADVICE} (nothing was copied)`,
      };
    }
    if (destState.exists) continue; // proven identical already
    plans.push({ kind: 'copy', rel: entry.rel, from: entry.path, to: destPath });
  }
  // Nothing may be written through a symlinked parent, and planning proves it
  // BEFORE a single byte lands (nothing here creates a directory).
  const contained = containPlannedWrites({
    plans, toAbs, baseReal: checkoutReal(toAbs, fsImpl), create: false, fsImpl,
  });
  if (!contained.ok) {
    return {
      ok: false,
      error: `cannot copy changes: ${contained.error}: ${CONFLICT_ADVICE} (nothing was copied)`,
    };
  }
  return { ok: true, plans };
}

async function planTrackedFiles({ tracked, fromAbs, toAbs, runAsync, fsImpl, tmpDir }) {
  const rels = tracked.map((entry) => entry.rel);
  let facts;
  try {
    // `--no-abbrev` is load-bearing: an abbreviated oid can never be compared
    // with a blob hash, and the byte-exactness proof below does exactly that.
    facts = await runAsync('git', ['diff', '--raw', '--no-abbrev', '-z', '-M', 'HEAD', '--', ...rels], fromAbs);
  } catch (err) {
    return { ok: false, error: `cannot copy changes: cannot read the selected paths (${(err && err.message) || err}; nothing was copied)` };
  }
  if (!facts || facts.status !== 0) {
    const reason = (facts && ((facts.stderr || '').trim().split('\n')[0] || facts.error)) || 'diff failed';
    return { ok: false, error: `cannot copy changes: cannot read the selected paths (${reason}; nothing was copied)` };
  }
  const byRel = new Map(parseRawZ(facts.stdout || '').map((record) => [record.rel, record]));
  const mergeBaseCache = { resolved: false, tree: null };
  const plans = [];
  const conflicts = [];
  const refusals = [];
  let index = 0;
  for (const entry of tracked) {
    index += 1;
    const rel = entry.rel;
    const single = await selectedPatch({ rels: [rel], fromAbs, runAsync });
    if (!single.ok) {
      refusals.push(`${single.error} for ${JSON.stringify(rel)}`);
      continue;
    }
    const check = await applyPatchText({
      text: single.text, toAbs, runAsync, fsImpl, tmpDir, name: `file-${index}`, checkOnly: true,
    });
    if (check.ok) {
      plans.push({ kind: 'patch', text: single.text, rels: [rel], name: `file-${index}` });
      continue;
    }
    const resolved = await planDivergedFile({
      entry, fact: byRel.get(rel) || null, index, fromAbs, toAbs, runAsync, fsImpl, tmpDir, mergeBaseCache,
    });
    if (resolved.skip) continue;
    if (resolved.conflict) {
      conflicts.push(rel);
      continue;
    }
    if (resolved.refusal) {
      refusals.push(resolved.refusal);
      continue;
    }
    plans.push(resolved.plan);
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `cannot copy changes: the pending change conflicts with the destination's own version of ${conflicts.map((rel) => JSON.stringify(rel)).join(', ')}: ${CONFLICT_ADVICE} (nothing was copied)`,
    };
  }
  if (refusals.length > 0) {
    return {
      ok: false,
      error: `cannot copy changes: ${refusals.join('; ')}: ${CONFLICT_ADVICE} (nothing was copied)`,
    };
  }
  return { ok: true, plans };
}

// Every FILE one plan writes, so a failure can name exactly what already landed
// (a patch plan covers one or more paths, a copy/create/write plan exactly one).
function planEffectRels(plan) {
  if (plan.kind === 'patch') return plan.rels.slice();
  return [plan.rel];
}

// The truthful state of a copy that stopped midway. An earlier plan may already
// have landed, and "nothing was copied" would then be a claim the human cannot
// check — so what landed is named, and what did not is said plainly.
function partialCopyNote(landed, total) {
  if (landed.length === 0) return 'nothing was copied';
  const names = landed.map((rel) => JSON.stringify(rel)).join(', ');
  const rest = landed.length >= total ? 'those files are on disk' : 'the rest were not copied';
  return `${landed.length} of ${total} file${total === 1 ? '' : 's'} already copied (${names}); ${rest}`;
}

async function applyPlans({ plans, toAbs, baseReal, runAsync, fsImpl, tmpDir }) {
  const total = plans.reduce((count, plan) => count + planEffectRels(plan).length, 0);
  const landed = [];
  // One exit for every apply-time failure: the detail, then the state actually
  // on disk, then the instruction that follows from it.
  const failed = (detail) => ({
    ok: false,
    error: `${detail}; ${partialCopyNote(landed, total)}${landed.length > 0 ? '; inspect the destination before retrying' : ''}`,
  });
  for (const plan of plans) {
    if (plan.kind === 'patch') {
      const applied = await applyPatchText({
        text: plan.text, toAbs, runAsync, fsImpl, tmpDir, name: plan.name, checkOnly: false,
      });
      if (!applied.ok) {
        return failed(`cannot copy changes: ${plan.rels.map((rel) => JSON.stringify(rel)).join(', ')} did not apply (${applied.error})`);
      }
      landed.push(...planEffectRels(plan));
      continue;
    }
    // Plan-level guards first, then containment, then the target, then the
    // write — all synchronous from here on, so the window an attacker could use
    // to swap a component is as small as this architecture allows.
    const target = path.resolve(toAbs, plan.rel);
    if (plan.kind === 'copy') {
      const obstruction = destObstruction(plan.to, fsImpl);
      if (obstruction !== null) {
        return failed(`cannot copy changes: the destination has ${obstruction} at ${JSON.stringify(plan.rel)}, and a copy never writes through it`);
      }
    }
    const contained = containWritePath({ rel: plan.rel, toAbs, baseReal, create: true, fsImpl });
    if (!contained.ok) {
      return failed(`cannot copy changes: ${contained.error}`);
    }
    if (plan.kind === 'copy') {
      try {
        fsImpl.copyFileSync(plan.from, plan.to);
      } catch (err) {
        return failed(`cannot copy ${JSON.stringify(plan.rel)}: ${(err && err.message) || err}`);
      }
      landed.push(plan.rel);
      continue;
    }
    const obstruction = destObstruction(target, fsImpl);
    if (obstruction !== null) {
      return failed(`cannot copy changes: the destination has ${obstruction} at ${JSON.stringify(plan.rel)}, and a copy never writes through it`);
    }
    try {
      fsImpl.writeFileSync(target, plan.bytes);
      if (plan.kind === 'create' && Number.isFinite(plan.mode)) {
        // A created file keeps the source's permission bits; a file that already
        // existed keeps its own.
        try { fsImpl.chmodSync(target, plan.mode & 0o777); } catch { /* a mode is never a copy failure */ }
      }
    } catch (err) {
      return failed(`cannot copy ${JSON.stringify(plan.rel)}: ${(err && err.message) || err}`);
    }
    landed.push(plan.rel);
  }
  return { ok: true };
}

// Data-preservation proof, read back from disk: destination-only files are
// byte-identical, every planned effect landed, and no path that was not
// selected changed.
async function verifyTransfer({ plans, destOnly, snapshot, selectedRels, toAbs, git, runAsync, fsImpl }) {
  const problems = [];
  const baseReal = checkoutReal(toAbs, fsImpl);
  for (const rel of destOnly) {
    if (snapshot.get(rel) !== fingerprintFile(path.resolve(toAbs, rel), fsImpl)) {
      problems.push(`${JSON.stringify(rel)} (a destination-only file changed)`);
    }
  }
  for (const plan of plans) {
    if (plan.kind === 'patch') continue;
    const expected = plan.kind === 'copy' ? fingerprintFile(plan.from, fsImpl) : fingerprintBytes(plan.bytes);
    const landed = fingerprintFile(path.resolve(toAbs, plan.rel), fsImpl);
    if (expected === null || landed !== expected) {
      problems.push(`${JSON.stringify(plan.rel)} (the copied bytes are not on disk)`);
    }
    // Last line of defence: a write that somehow left the checkout must be
    // reported loudly, never passed off as a normal copy.
    let real = null;
    try {
      real = fsImpl.realpathSync(path.resolve(toAbs, plan.rel));
    } catch {
      real = null;
    }
    if (real === null || !isInsideOrEqual(baseReal, real)) {
      problems.push(`${JSON.stringify(plan.rel)} (written outside the destination checkout)`);
    }
  }
  const after = await summarizeChanges(toAbs, { fs: fsImpl, git, runAsync });
  if (!after.ok) {
    return { ok: false, error: `cannot copy changes: the copy landed but the destination could not be re-read (${after.error}; inspect the destination before retrying)` };
  }
  const allowed = new Set([...destOnly, ...selectedRels]);
  const unexpected = after.entries.map((entry) => entry.rel).filter((rel) => !allowed.has(rel));
  if (unexpected.length > 0) {
    problems.push(`${unexpected.map((rel) => JSON.stringify(rel)).join(', ')} (changed without being selected)`);
  }
  for (const plan of plans) {
    if (plan.kind !== 'patch') continue;
    for (const rel of plan.rels) {
      if (!after.entries.some((entry) => entry.rel === rel || entry.oldRel === rel)) {
        problems.push(`${JSON.stringify(rel)} (the patch did not land)`);
      }
    }
  }
  if (problems.length > 0) {
    return { ok: false, error: `cannot copy changes: the copy could not be verified: ${problems.join('; ')}; inspect the destination before retrying` };
  }
  return { ok: true };
}

// Plan, apply and verify in one place: a refused plan writes nothing.
async function transferSelection({ tracked, untracked, destOnly, selectedRels, fromAbs, toAbs, git, runAsync, fsImpl }) {
  let tmpDir = null;
  try {
    tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'worktree-changes-'));
  } catch (err) {
    return { ok: false, error: `cannot copy changes: cannot create a scratch directory (${(err && err.message) || err}; nothing was copied)` };
  }
  try {
    const planned = await planTransfer({ tracked, untracked, fromAbs, toAbs, runAsync, fsImpl, tmpDir });
    if (!planned.ok) return planned;
    if (planned.plans.length === 0) return { ok: true };
    const snapshot = new Map();
    for (const rel of destOnly) snapshot.set(rel, fingerprintFile(path.resolve(toAbs, rel), fsImpl));
    const baseReal = checkoutReal(toAbs, fsImpl);
    const applied = await applyPlans({ plans: planned.plans, toAbs, baseReal, runAsync, fsImpl, tmpDir });
    if (!applied.ok) return applied;
    return await verifyTransfer({
      plans: planned.plans, destOnly, snapshot, selectedRels, toAbs, git, runAsync, fsImpl,
    });
  } finally {
    try { fsImpl.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Copy working-tree changes from one checkout to another of the SAME
// repository. Never mutates the source or either index: tracked changes
// travel through a file patch applied to the working tree only
// (`git apply`, never `--index`), untracked files are copied byte for
// byte, and the source checkout is only read. Snapshot preflight is
// revalidated immediately before the write; a drifted snapshot, a
// destination overlap on any selected path, or a failed dry-run rejects
// with ZERO destination mutation. Unsupported shapes (for example a
// selection that cannot be expressed as a patch plus file copies)
// fail BEFORE any write and say so. Returns
// {ok, copied:[rel], files, added, deleted} or {ok:false, error}.
async function copyChanges({ from, to, selection, selectMode, opts } = {}, inject = {}) {
  const fsImpl = inject.fs || fs;
  const git = inject.git || (() => { try { return require('./worktree-git.js'); } catch { return null; } })();
  if (!git || typeof git.repoIdentity !== 'function') {
    return { ok: false, error: 'git helper is unavailable' };
  }
  if (typeof from !== 'string' || from.length === 0) return { ok: false, error: 'copy source is empty' };
  if (typeof to !== 'string' || to.length === 0) return { ok: false, error: 'copy destination is empty' };
  const runAsync = inject.runAsync || ((bin, args, cwd) => defaultRunAsync(bin, args, cwd, COPY_TIMEOUT_MS));
  let fromAbs = path.resolve(from);
  let toAbs = path.resolve(to);
  // Same-repository proof: linked worktrees each report their own root
  // from `rev-parse --show-toplevel`, so the shared git common dir is
  // the identity that proves two checkouts belong to one repository.
  let fromCommon;
  let toCommon;
  try {
    fromCommon = path.resolve(repoCommonDir(fromAbs, git));
    toCommon = path.resolve(repoCommonDir(toAbs, git));
  } catch (err) {
    return { ok: false, error: `cannot copy changes: ${(err && err.message) || err}` };
  }
  if (fromCommon !== toCommon) {
    return { ok: false, error: `cannot copy changes: ${fromAbs} and ${toAbs} belong to different repositories (nothing was copied)` };
  }
  // Resolve both checkouts through their realpaths when available so a
  // symlinked spelling of the same checkout compares equal; a missing
  // destination is refused (never created by the copy).
  try {
    const st = fsImpl.statSync(toAbs);
    if (!st.isDirectory()) return { ok: false, error: `cannot copy changes: destination is not a directory: ${toAbs} (nothing was copied)` };
  } catch (err) {
    return { ok: false, error: `cannot copy changes: destination is missing: ${toAbs} (nothing was copied)` };
  }
  // Normalize the selection: caller passes selectMode/paths or the raw
  // tool value in `selection`.
  let mode = selectMode;
  let paths = [];
  if (mode === undefined) {
    const normalized = normalizeChangesSelection(selection);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    mode = normalized.mode;
    paths = normalized.paths;
  } else if (Array.isArray(selection)) {
    paths = selection;
  }
  if (mode === 'none') return { ok: true, copied: [], files: 0, added: 0, deleted: 0 };
  const source = await summarizeChanges(fromAbs, { fs: fsImpl, git, runAsync });
  if (!source.ok) return { ok: false, error: `${source.error} (nothing was copied)` };
  fromAbs = source.checkout;
  const matched = matchSelection(source, mode, paths);
  if (!matched.ok) return { ok: false, error: matched.error };
  if (matched.entries.length === 0) return { ok: true, copied: [], files: 0, added: 0, deleted: 0 };
  // Containment on every selected path before any destination read.
  for (const entry of matched.entries) {
    if (!isInsideOrEqual(fromAbs, entry.path) || isGitInternal(entry.rel)) {
      return { ok: false, error: `refusing to copy ${JSON.stringify(entry.rel)}: path escapes the source checkout (nothing was copied)` };
    }
    try {
      const st = fsImpl.lstatSync(entry.path);
      if (st.isSymbolicLink()) {
        const real = fsImpl.realpathSync(entry.path);
        if (!isInsideOrEqual(fromAbs, real)) {
          return { ok: false, error: `refusing to copy ${JSON.stringify(entry.rel)}: symlink escapes the source checkout (nothing was copied)` };
        }
      }
    } catch (err) {
      // "Nothing behind the path" is a DELETION, and only the two codes that
      // mean exactly that are read as one: the patch leg carries the deletion,
      // so only the lexical check applies. Any other lstat failure (a
      // permission-denied ancestor, a symlink loop) says nothing about whether
      // the file is there, so it is refused rather than quietly dropped from
      // the copy — and it is never reported as a deletion or as unreadable.
      const code = err && err.code;
      const absent = code === 'ENOENT' || code === 'ENOTDIR';
      if (!entry.untracked && absent) continue;
      if (entry.untracked && absent) {
        return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: the source file is gone (it was deleted after the selection was made), so there is nothing to copy (nothing was copied)` };
      }
      return {
        ok: false,
        error: `cannot copy ${JSON.stringify(entry.rel)}: the source file could not be inspected (${(err && err.message) || err}), so it is never treated as a deletion (nothing was copied)`,
      };
    }
  }
  // Destination overlap preflight: any selected relative path that
  // already carries destination modifications rejects with zero
  // mutation. Compared by checkout-relative path (both checkouts share
  // the repository, so rel paths line up).
  const dest = await summarizeChanges(toAbs, { fs: fsImpl, git, runAsync });
  if (!dest.ok) return { ok: false, error: `${dest.error} (nothing was copied)` };
  toAbs = dest.checkout;
  const destRels = new Set(dest.entries.map((entry) => entry.rel));
  const overlapping = matched.entries.filter((entry) => destRels.has(entry.rel)).map((entry) => entry.rel);
  if (overlapping.length > 0) {
    return { ok: false, error: `cannot copy changes: destination already modifies ${overlapping.map((r) => JSON.stringify(r)).join(', ')} (nothing was copied, warped or switched)` };
  }
  const tracked = matched.entries.filter((entry) => !entry.untracked);
  const untracked = matched.entries.filter((entry) => entry.untracked);
  // Untracked leg preflight: the destination must not already hold a
  // DIFFERENT file at that path — not even a clean tracked one when the
  // source base differs. Identical bytes skip quietly. A path the destination
  // holds as anything OTHER than a regular file (a dangling symbolic link
  // included) is refused: a byte copy would follow it out of the checkout.
  for (const entry of untracked) {
    const destPath = path.resolve(toAbs, entry.rel);
    if (!isInsideOrEqual(toAbs, destPath) || isGitInternal(entry.rel)) {
      return { ok: false, error: `refusing to copy ${JSON.stringify(entry.rel)}: path escapes the destination checkout (nothing was copied)` };
    }
    const obstruction = destObstruction(destPath, fsImpl);
    if (obstruction !== null) {
      return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: the destination has ${obstruction} at that path, and a copy never writes through it (nothing was copied)` };
    }
    const destState = readWorktreeFile(destPath, fsImpl);
    if (destState.kind === 'unreadable') {
      return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: the destination's file there cannot be read, so it cannot be proven identical (nothing was copied)` };
    }
    if (destState.exists && !destState.bytes.equals(fsImpl.readFileSync(entry.path))) {
      return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: the destination already has a file there (nothing was copied)` };
    }
  }
  // Revalidate the snapshot immediately before the write: the source
  // must still hold exactly the snapshotted selection, and the
  // destination must still be clear on those paths. Any drift rejects
  // with zero mutation.
  const reSource = await summarizeChanges(fromAbs, { fs: fsImpl, git, runAsync });
  if (!reSource.ok) return { ok: false, error: `${reSource.error} (nothing was copied)` };
  const reMatched = matchSelection(reSource, mode, paths);
  if (!reMatched.ok) return { ok: false, error: reMatched.error };
  const before = new Map(matched.entries.map((entry) => [entry.rel, `${entry.added}/${entry.deleted}/${entry.status}`]));
  const after = new Map(reMatched.entries.map((entry) => [entry.rel, `${entry.added}/${entry.deleted}/${entry.status}`]));
  if (before.size !== after.size || [...before.keys()].some((key) => before.get(key) !== after.get(key))) {
    return { ok: false, error: 'cannot copy changes: the source changed during confirmation (nothing was copied)' };
  }
  const reDest = await summarizeChanges(toAbs, { fs: fsImpl, git, runAsync });
  if (!reDest.ok) return { ok: false, error: `${reDest.error} (nothing was copied)` };
  const reDestRels = new Set(reDest.entries.map((entry) => entry.rel));
  const reOverlapping = matched.entries.filter((entry) => reDestRels.has(entry.rel)).map((entry) => entry.rel);
  if (reOverlapping.length > 0) {
    return { ok: false, error: `cannot copy changes: destination already modifies ${reOverlapping.map((r) => JSON.stringify(r)).join(', ')} (nothing was copied, warped or switched)` };
  }
  // Both legs travel through one planner: every patch dry-run, every
  // divergent-base merge and every untracked byte comparison happens in a
  // system temp directory BEFORE the first write, so a refusal mutates nothing;
  // and the applied result is verified afterwards (destination-only files
  // unchanged, planned effects landed, nothing unselected touched).
  const transfer = await transferSelection({
    tracked,
    untracked,
    destOnly: [...reDestRels],
    selectedRels: matched.entries.map((entry) => entry.rel),
    fromAbs,
    toAbs,
    git,
    runAsync,
    fsImpl,
  });
  if (!transfer.ok) return transfer;
  let added = 0;
  let deleted = 0;
  for (const entry of matched.entries) {
    added += entry.added;
    deleted += entry.deleted;
  }
  return {
    ok: true,
    copied: matched.entries.map((entry) => entry.rel),
    files: matched.entries.length,
    added,
    deleted,
  };
}

module.exports = {
  SUMMARY_TIMEOUT_MS,
  COPY_TIMEOUT_MS,
  parseNumstatZ,
  summarizeChanges,
  formatChangeSummary,
  normalizeChangesSelection,
  matchSelection,
  copyChanges,
  isInsideOrEqual,
};

'use strict';
// S4 (UI consistency round 3): the warp keyboard delete's ONE confirmation.
//
// Both keyboard surfaces — the panel's `ctrl+d` and the extended list's
// `Ctrl+D` — emit the same `{ delete: path }` marker, so a single builder
// here words every prompt. The invariant this module owns is that a keyboard
// delete is ALWAYS a human decision: nothing here reads gentle-shell's YOLO
// grant, so no permission mode can let a keypress alone remove a checkout.
// (The grant still waives the `worktree_close` tool's OWN dialog; that is a
// different caller and stays untouched.)
//
// The disclosure covers exactly what the human cannot see from the warp
// panel at that moment:
//   - pending changes, through lib/worktree-changes.js;
//   - commits this checkout has that `main` does not, through
//     lib/worktree-git.js `aheadBehind` with `base: 'main'` passed
//     EXPLICITLY. The helper's own resolution would fall back to
//     `origin/main`/`master`, and "ahead of upstream" is not the question
//     that was asked, so the base is never silently substituted.
//
// Every read may fail. A failed read is reported as UNKNOWN with its reason,
// never as zero and never as "no pending changes": a false "clean" would turn
// this dialog into false reassurance about work that is about to be removed.
//
// The dialog is answered BEFORE the removal, so `warpDeleteEvidenceKey` exists
// to compare the read the human answered with the read taken just before the
// deletion: an equal key states the same pending work (down to its BYTES) and
// the same ahead-of-main position, and any difference means the dialog
// described a checkout that no longer exists in that state.
//
// Two facts the counts cannot express are read too:
//   - `content`, the fingerprint of the pending work itself (the tracked patch
//     plus every untracked file's bytes). Rewriting a line keeps `+A/-D`
//     identical while the work is different, so the counts alone would
//     authorize deleting something the human never saw.
//   - `ignored`, the files git ignores (build output, `.env`, `node_modules/`…).
//     They are deleted with the checkout while the working tree reads CLEAN, so
//     they are disclosed by name in the question and their path list is part of
//     the reading.

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fsPromises = require('node:fs/promises');

// Each read is bounded so a hung git can never hold the dialog hostage; the
// interactive path awaits them, so nothing here blocks the host's event loop.
const EVIDENCE_TIMEOUT_MS = 15000;
// How much pending work one fingerprint may hash. Untracked work is normally
// small; past this the read is `unknown` (and the caller refuses) instead of
// silently fingerprinting nothing or freezing on a huge tree. The cap covers
// the TRACKED patch and every untracked file together, and it is checked
// BEFORE a byte is read into memory, never after: an oversized patch or file
// is refused, not buffered and then discarded.
const MAX_FINGERPRINT_BYTES = 32 * 1024 * 1024;
// One bounded read buffer, reused for every hashed file. Nothing else about a
// file's size reaches memory: the bytes are hashed as they arrive.
const READ_CHUNK_BYTES = 64 * 1024;
// Ignored files are named by EXAMPLE in the dialog; the count and the path list
// are what the reading actually carries.
const IGNORED_SAMPLES = 3;

function optionalRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function reasonOf(error, fallback) {
  if (typeof error === 'string' && error.length > 0) return error;
  if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  if (error && typeof error.error === 'string' && error.error.length > 0) return error.error;
  return fallback;
}

// The first non-empty line of a child's stderr, which is what git says about a
// failure. Falls back to the injected error and then to the caller's words.
function childReason(result, fallback) {
  const stderr = result && typeof result.stderr === 'string' ? result.stderr : '';
  const line = stderr.split('\n').map((text) => text.trim()).find((text) => text.length > 0);
  if (line) return line;
  return reasonOf(result && (result.error || result.message), fallback);
}

// One awaited git child through the caller's module. `null` means the module
// cannot run children at all, which every reader below reports as unknown.
async function runGitAsync(git, args, cwd, timeoutMs) {
  if (!git || typeof git.runArgvAsync !== 'function') return null;
  try {
    return await git.runArgvAsync('git', args, { cwd, timeoutMs });
  } catch (err) {
    return { status: -1, stdout: '', stderr: '', error: reasonOf(err, 'git failed') };
  }
}

// A2: the files git IGNORES under the checkout. `git status` never shows them,
// so a checkout holding them reads clean; removing the directory deletes them
// anyway. Their NAMES travel to the dialog and into the reading.
async function readIgnored(checkoutPath, git, timeoutMs) {
  const listed = await runGitAsync(
    git,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--'],
    checkoutPath,
    timeoutMs,
  );
  if (!listed) return { status: 'unknown', files: null, samples: [], reason: 'the ignored-file listing is unavailable' };
  if (listed.status !== 0) {
    return { status: 'unknown', files: null, samples: [], reason: childReason(listed, 'the ignored-file listing failed') };
  }
  const paths = String(listed.stdout || '')
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort();
  // The reading is the whole sorted path list, hashed: the dialog names only a
  // few samples, while the fingerprint must cover every ignored file without
  // carrying a `node_modules/` listing through every comparison.
  const fingerprint = crypto.createHash('sha256').update(paths.join('\0')).digest('hex');
  if (paths.length === 0) return { status: 'none', files: 0, samples: [], fingerprint };
  return {
    status: 'present',
    files: paths.length,
    samples: paths.slice(0, IGNORED_SAMPLES),
    fingerprint,
  };
}

function resolveBudget(maxBytes) {
  return Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_FINGERPRINT_BYTES;
}

function overBudgetReason(budget) {
  return `the pending work is larger than ${budget} bytes, so it cannot be fingerprinted`;
}

// Hash one file into `digest` in fixed-size chunks, never holding more than one
// chunk. `limit` is what is LEFT of the fingerprint budget: the moment it would
// be exceeded the read stops and reports too-large, so an oversized file is
// refused instead of being loaded first and checked afterwards.
async function hashFileBounded(abs, digest, limit, prefix) {
  const handle = await fsPromises.open(abs, 'r');
  try {
    if (prefix) digest.update(prefix);
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > limit) return { ok: false, tooLarge: true, bytes };
      digest.update(chunk.subarray(0, bytesRead));
    }
    return { ok: true, bytes };
  } finally {
    try { await handle.close(); } catch { /* a dead handle never fails the read */ }
  }
}

// The tracked patch, kept OFF the child's stdout. A binary patch can be
// hundreds of MiB, and the shared runner collects stdout into one string —
// decoding it again is what turned a 40 MiB patch into ~247 MiB of RSS. `git
// diff --output=` writes the same patch to a private temp file, so its size is
// known before anything is hashed and the cap can refuse it without allocating
// it. Returns `{ ok: true, digest, bytes }` or an `unknown` reading.
async function readPendingPatch(checkoutPath, git, timeoutMs, budget) {
  let dir;
  try {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'warp-delete-patch-'));
  } catch (err) {
    return { status: 'unknown', fingerprint: null, reason: `the pending-content patch could not be staged (${reasonOf(err, 'mkdtemp failed')})` };
  }
  const file = path.join(dir, 'pending.patch');
  try {
    const patch = await runGitAsync(
      git,
      ['diff', '--binary', '--no-color', '--no-ext-diff', '-M', `--output=${file}`, 'HEAD', '--'],
      checkoutPath,
      timeoutMs,
    );
    if (!patch) return { status: 'unknown', fingerprint: null, reason: 'the pending-content read is unavailable' };
    if (patch.status !== 0) {
      return { status: 'unknown', fingerprint: null, reason: childReason(patch, 'the pending-content read failed') };
    }
    let stat;
    try {
      stat = await fsPromises.lstat(file);
    } catch (err) {
      return { status: 'unknown', fingerprint: null, reason: `the pending-content patch could not be read (${reasonOf(err, 'lstat failed')})` };
    }
    if (!stat.isFile()) {
      return { status: 'unknown', fingerprint: null, reason: 'the pending-content patch is not a regular file' };
    }
    // The cap is a SIZE decision first: an over-budget patch is refused here,
    // before its bytes are ever read.
    if (stat.size > budget) return { status: 'unknown', fingerprint: null, reason: overBudgetReason(budget) };
    const digest = crypto.createHash('sha256');
    let read;
    try {
      read = await hashFileBounded(file, digest, budget, '\0patch\0');
    } catch (err) {
      return { status: 'unknown', fingerprint: null, reason: `the pending-content patch could not be read (${reasonOf(err, 'read failed')})` };
    }
    if (read.ok !== true) return { status: 'unknown', fingerprint: null, reason: overBudgetReason(budget) };
    return { ok: true, digest, bytes: read.bytes };
  } finally {
    try { await fsPromises.rm(dir, { recursive: true, force: true }); } catch { /* scratch cleanup never fails the read */ }
  }
}

// A1: the pending work ITSELF, not its size. Two readings with the same
// `+A/-D` and different bytes must not compare equal, or a confirmation would
// authorize deleting content nobody saw. The fingerprint is the tracked patch
// (`--binary`, so binary edits count) plus every untracked file's own bytes.
// Anything that cannot be read is `unknown` — never "unchanged". Both halves
// share ONE budget and enforce it before allocating: the patch by its file
// size, an untracked file by its `lstat` size and then chunk-by-chunk.
async function readContent(checkoutPath, git, timeoutMs, maxBytes) {
  const budget = resolveBudget(maxBytes);
  const tracked = await readPendingPatch(checkoutPath, git, timeoutMs, budget);
  if (tracked.ok !== true) return tracked;
  const status = await runGitAsync(
    git,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'],
    checkoutPath,
    timeoutMs,
  );
  if (!status) return { status: 'unknown', fingerprint: null, reason: 'the untracked-file listing is unavailable' };
  if (status.status !== 0) {
    return { status: 'unknown', fingerprint: null, reason: childReason(status, 'the untracked-file listing failed') };
  }
  const untracked = [];
  for (const token of String(status.stdout || '').split('\0')) {
    if (token.length < 4 || token.slice(0, 2) !== '??') continue;
    const rel = token.slice(3);
    if (rel.length > 0) untracked.push(rel);
  }
  untracked.sort();
  const digest = tracked.digest;
  let bytes = tracked.bytes;
  for (const rel of untracked) {
    const abs = path.resolve(checkoutPath, rel);
    const inside = abs === path.resolve(checkoutPath) || abs.startsWith(path.resolve(checkoutPath) + path.sep);
    if (!inside) {
      return { status: 'unknown', fingerprint: null, reason: `the untracked file ${JSON.stringify(rel)} resolves outside the checkout` };
    }
    let stat;
    try {
      stat = await fsPromises.lstat(abs);
    } catch (err) {
      return { status: 'unknown', fingerprint: null, reason: `cannot read the untracked file ${JSON.stringify(rel)} (${reasonOf(err, 'lstat failed')})` };
    }
    if (stat.isSymbolicLink()) {
      // A link is fingerprinted by what it POINTS at: reading through it could
      // leave the checkout entirely.
      let target = '';
      try {
        target = await fsPromises.readlink(abs);
      } catch (err) {
        return { status: 'unknown', fingerprint: null, reason: `cannot read the untracked link ${JSON.stringify(rel)} (${reasonOf(err, 'readlink failed')})` };
      }
      bytes += Buffer.byteLength(target);
      if (bytes > budget) return { status: 'unknown', fingerprint: null, reason: overBudgetReason(budget) };
      digest.update(`\0${rel}\0link\0${target}`);
      continue;
    }
    if (!stat.isFile()) {
      return { status: 'unknown', fingerprint: null, reason: `the untracked path ${JSON.stringify(rel)} is not a regular file` };
    }
    // Refuse by size BEFORE opening when the file alone already empties the
    // budget; `hashFileBounded` catches a file that grows after the stat.
    if (stat.size > budget - bytes) {
      return { status: 'unknown', fingerprint: null, reason: overBudgetReason(budget) };
    }
    let read;
    try {
      read = await hashFileBounded(abs, digest, budget - bytes, `\0${rel}\0file\0`);
    } catch (err) {
      return { status: 'unknown', fingerprint: null, reason: `cannot read the untracked file ${JSON.stringify(rel)} (${reasonOf(err, 'readFile failed')})` };
    }
    if (read.ok !== true) return { status: 'unknown', fingerprint: null, reason: overBudgetReason(budget) };
    bytes += read.bytes;
  }
  return { status: 'known', fingerprint: digest.digest('hex'), untracked: untracked.length, bytes };
}

// `unknown` instead of `clean` on every failure path: only a positive read of
// zero changed files may claim a checkout has nothing pending.
async function readChanges(checkoutPath, changesLib, git, timeoutMs) {
  if (!changesLib || typeof changesLib.summarizeChanges !== 'function') {
    return { status: 'unknown', reason: 'the change summary is unavailable' };
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(checkoutPath, { git, timeoutMs });
  } catch (err) {
    return { status: 'unknown', reason: reasonOf(err, 'the change summary failed') };
  }
  if (!summary || summary.ok !== true) {
    return { status: 'unknown', reason: reasonOf(summary && summary.error, 'the change summary failed') };
  }
  const files = Number.isFinite(summary.files) ? summary.files : 0;
  if (files === 0) return { status: 'clean', files: 0, added: 0, deleted: 0 };
  return {
    status: 'dirty',
    files,
    added: Number.isFinite(summary.added) ? summary.added : 0,
    deleted: Number.isFinite(summary.deleted) ? summary.deleted : 0,
  };
}

// `ahead: null` means "not known", which is a different statement from
// "zero commits ahead" and stays distinguishable downstream.
async function readAheadMain(checkoutPath, git, timeoutMs) {
  if (!git || typeof git.aheadBehind !== 'function') {
    return { status: 'unknown', ahead: null, reason: 'the ahead/behind read is unavailable' };
  }
  let compared;
  try {
    compared = await git.aheadBehind(checkoutPath, { base: 'main', timeoutMs });
  } catch (err) {
    return { status: 'unknown', ahead: null, reason: reasonOf(err, 'the ahead/behind read failed') };
  }
  if (!compared || compared.ok !== true) {
    return { status: 'unknown', ahead: null, reason: reasonOf(compared && compared.error, 'the ahead/behind read failed') };
  }
  const ahead = Number.isFinite(compared.ahead) ? compared.ahead : null;
  if (ahead === null) {
    return { status: 'unknown', ahead: null, reason: 'the ahead/behind read was unreadable' };
  }
  return { status: ahead > 0 ? 'ahead' : 'none', ahead, base: compared.base };
}

// Options: `git` (the caller's lib/worktree-git.js module), `changesLib`,
// `timeoutMs`, `maxFingerprintBytes`. Resolves; never rejects.
async function readWarpDeleteEvidence(checkoutPath, opts = {}) {
  const git = opts.git || optionalRequire('./worktree-git.js');
  const changesLib = opts.changesLib || optionalRequire('./worktree-changes.js');
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : EVIDENCE_TIMEOUT_MS;
  if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
    return {
      changes: { status: 'unknown', reason: 'the checkout path is empty' },
      aheadMain: { status: 'unknown', ahead: null, reason: 'the checkout path is empty' },
      content: { status: 'unknown', fingerprint: null, reason: 'the checkout path is empty' },
      ignored: { status: 'unknown', files: null, samples: [], reason: 'the checkout path is empty' },
    };
  }
  const [changes, aheadMain, content, ignored] = await Promise.all([
    readChanges(checkoutPath, changesLib, git, timeoutMs),
    readAheadMain(checkoutPath, git, timeoutMs),
    readContent(checkoutPath, git, timeoutMs, opts.maxFingerprintBytes),
    readIgnored(checkoutPath, git, timeoutMs),
  ]);
  return { changes, aheadMain, content, ignored };
}

function changesLine(changes) {
  if (!changes || typeof changes !== 'object') return ' Uncommitted changes: unknown.';
  if (changes.status === 'dirty') {
    const files = Number.isFinite(changes.files) ? changes.files : 0;
    return ` Pending changes: ${files} file${files === 1 ? '' : 's'}, +${changes.added}/-${changes.deleted}.`;
  }
  // A clean checkout says nothing extra: the absence of a warning is the
  // positive "nothing pending" statement, exactly as before this change.
  if (changes.status === 'clean') return '';
  const reason = typeof changes.reason === 'string' && changes.reason.length > 0
    ? changes.reason
    : 'the change summary failed';
  return ` Uncommitted changes: unknown (${reason}).`;
}

// A2: ignored files are deleted with the checkout while the working tree reads
// clean, so they are named in the question. A clean checkout with none says
// nothing extra, exactly as before.
function ignoredLine(ignored) {
  if (!ignored || typeof ignored !== 'object') return '';
  if (ignored.status === 'present') {
    const files = Number.isFinite(ignored.files) ? ignored.files : 0;
    const samples = Array.isArray(ignored.samples) ? ignored.samples.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
    const named = samples.join(', ');
    const more = files > samples.length ? `, +${files - samples.length} more` : '';
    return ` Ignored files (deleted with the checkout): ${named}${more}.`;
  }
  if (ignored.status === 'none') return '';
  const reason = typeof ignored.reason === 'string' && ignored.reason.length > 0
    ? ignored.reason
    : 'the ignored-file listing failed';
  return ` Ignored files: unknown (${reason}).`;
}

function aheadLine(aheadMain) {
  if (!aheadMain || typeof aheadMain !== 'object') return ' Commits ahead of main: unknown.';
  if (aheadMain.status === 'ahead') return ` Commits ahead of main: ${aheadMain.ahead}.`;
  if (aheadMain.status === 'none') return '';
  const reason = typeof aheadMain.reason === 'string' && aheadMain.reason.length > 0
    ? aheadMain.reason
    : 'the ahead/behind read failed';
  return ` Commits ahead of main: unknown (${reason}).`;
}

// A stable fingerprint of one evidence read. The dialog is answered BEFORE the
// removal, so the caller re-reads afterwards and compares: an equal key means
// the second read states exactly what the human confirmed (the same pending
// work down to its bytes, the same ignored files, the same ahead-of-main
// position), and any difference — a count, the clean/dirty verdict, the content
// behind an identical count, an ignored file that appeared, a read that started
// failing or recovered, the ahead count — means the disclosure on screen is no
// longer true and the deletion must not proceed on it. Nothing is normalized, so
// an `unknown` never compares equal to a measured zero or to a fingerprint.
function warpDeleteEvidenceKey(evidence) {
  const read = evidence && typeof evidence === 'object' ? evidence : {};
  const changes = read.changes && typeof read.changes === 'object' ? read.changes : {};
  const aheadMain = read.aheadMain && typeof read.aheadMain === 'object' ? read.aheadMain : {};
  const content = read.content && typeof read.content === 'object' ? read.content : {};
  const ignored = read.ignored && typeof read.ignored === 'object' ? read.ignored : {};
  const field = (value) => (value === null || value === undefined ? '' : String(value));
  return [
    'changes',
    field(changes.status),
    field(changes.files),
    field(changes.added),
    field(changes.deleted),
    '|ahead',
    field(aheadMain.status),
    field(aheadMain.ahead),
    '|content',
    field(content.status),
    field(content.fingerprint),
    '|ignored',
    field(ignored.status),
    field(ignored.files),
    field(ignored.fingerprint),
  ].join(':');
}

// Build the dialog for one checkout. `force: true` only on POSITIVE evidence
// of pending changes, so the shared close is never forced on a checkout the
// evidence cannot vouch for.
function warpDeletePrompt(target, evidence) {
  const entry = target && typeof target === 'object' ? target : {};
  const name = typeof entry.name === 'string' ? entry.name : String(entry.name ?? '');
  const checkoutPath = typeof entry.path === 'string' ? entry.path : String(entry.path ?? '');
  const branch = typeof entry.branch === 'string' ? entry.branch : String(entry.branch ?? '');
  const read = evidence && typeof evidence === 'object' ? evidence : {};
  const body = `Delete worktree checkout at ${checkoutPath} for branch '${branch}'? This removes the checkout but keeps the branch.`
    + changesLine(read.changes)
    + aheadLine(read.aheadMain)
    + ignoredLine(read.ignored);
  return {
    title: `Delete worktree '${name}'?`,
    body,
    force: !!(read.changes && read.changes.status === 'dirty'),
  };
}

module.exports = {
  EVIDENCE_TIMEOUT_MS,
  MAX_FINGERPRINT_BYTES,
  readWarpDeleteEvidence,
  warpDeleteEvidenceKey,
  warpDeletePrompt,
};

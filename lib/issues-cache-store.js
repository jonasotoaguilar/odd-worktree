'use strict';
// S4 (issues-startup-performance T3): the DISK half of the issues read cache.
//
// `lib/related-issues-cache.js` stays PURE — no imports, no child process, no
// disk — and owns what a read MEANS (the plan, the merge, the count invariant).
// This module owns only where an entry sleeps between processes: ONE small
// versioned JSON document under `$XDG_CACHE_HOME/odd-worktree/` (falling back to
// `~/.cache/odd-worktree/`), one entry per repository identity, keyed exactly as
// the in-memory cache keys its own entries (`<host>/<owner>/<repo>`), so a
// hydrated entry can never be served under another repository's name.
//
// An entry holds what `plan`/`get` need: the three bucket rows, `counts`,
// `truncated`, `inconsistent`, `fullAt`, `syncedAt` and `lastApplied`. `fullAt`
// moves only on a FULL apply, exactly like the in-memory cache's own clock, so a
// steady stream of deltas can never postpone the full re-read across a restart.
//
// Best effort by contract: nothing here throws, and nothing here is on a session
// or paint path — the extension calls it from its async loader alone. A malformed
// document, a version this module does not know, an entry whose shape is wrong,
// an unreadable directory or a write that cannot be committed are all SILENCE
// (`null` / `false`), never an exception and never a half-written document: the
// write is a temp file in the same directory plus a rename, so a failure leaves
// the previous document exactly as it was.
//
// The `fs` seam and the directory are injectable, so a test never touches a real
// cache directory and a host whose `fs` is broken simply gets an in-process cache.

const path = require('node:path');
const os = require('node:os');

// The document carries its own version: a reader that does not recognize one
// answers nothing instead of guessing at a shape it never wrote.
// Version 2: a stored row's linked-PR mark is now repository-qualified (a pull
// request of another repository is never marked), so a document written by an older
// release, whose marks could name a foreign pull request, is silence.
const DOC_VERSION = 2;
const DIR_NAME = 'odd-worktree';
const FILE_NAME = 'issues-cache.json';
const BUCKET_KEYS = ['mine', 'assigned', 'involved'];
// The document is bounded: the oldest identities are dropped past this cap, so a
// long-lived machine never grows a cache file nobody asked for.
const DEFAULT_IDENTITY_LIMIT = 8;

function promisesSeam() {
  try {
    const fs = require('node:fs');
    return fs && fs.promises ? fs.promises : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The rows of one bucket, dropped when they are not a row at all. A row without a
// usable number cannot be merged or counted, exactly like the in-memory cache, so
// it is not a row here either.
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return null;
  const kept = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    if (!Number.isInteger(row.number) || row.number <= 0) continue;
    kept.push({ ...row });
  }
  return kept;
}

function normalizeFlags(value) {
  if (!isObject(value)) return null;
  const flags = {};
  for (const key of BUCKET_KEYS) flags[key] = value[key] === true;
  return flags;
}

// One stored entry, or `null` when its shape is not the one this module writes.
// A hostile entry is never repaired into something a caller would then trust.
function normalizeEntry(candidate) {
  if (!isObject(candidate)) return null;
  const identity = candidate.identity;
  if (typeof identity !== 'string' || identity.length === 0) return null;
  if (!isObject(candidate.buckets) || !isObject(candidate.counts)) return null;
  const buckets = {};
  const counts = {};
  for (const key of BUCKET_KEYS) {
    const rows = normalizeRows(candidate.buckets[key]);
    if (rows === null) return null;
    const count = candidate.counts[key];
    if (!Number.isInteger(count) || count < 0) return null;
    buckets[key] = rows;
    counts[key] = count;
  }
  const truncated = normalizeFlags(candidate.truncated);
  if (truncated === null) return null;
  if (!Number.isFinite(candidate.fullAt) || !Number.isFinite(candidate.syncedAt)) return null;
  return {
    identity,
    buckets,
    counts,
    truncated,
    inconsistent: candidate.inconsistent === true,
    fullAt: candidate.fullAt,
    syncedAt: candidate.syncedAt,
    lastApplied: Number.isFinite(candidate.lastApplied) ? candidate.lastApplied : null,
  };
}

function copyEntry(entry) {
  const normalized = normalizeEntry(entry);
  if (normalized === null) return null;
  const buckets = {};
  for (const key of BUCKET_KEYS) buckets[key] = normalized.buckets[key].map((row) => ({ ...row }));
  return { ...normalized, buckets, counts: { ...normalized.counts }, truncated: { ...normalized.truncated } };
}

function createIssuesCacheStore(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  // `fs` is the promise-returning seam this module writes and reads through; the
  // default is the real filesystem, and a test passes fakes.
  const fsSeam = isObject(opts.fs) ? opts.fs : promisesSeam();
  const env = isObject(opts.env) ? opts.env : process.env;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_IDENTITY_LIMIT;
  let writes = 0;

  // The directory the document lives in, resolved at CALL time so a host (and a
  // test) can move it by environment alone. `dir` names the directory itself;
  // otherwise `$XDG_CACHE_HOME/odd-worktree/`, else `~/.cache/odd-worktree/`.
  // No home and no XDG means no directory at all — silence, not a guess.
  function directory() {
    try {
      if (typeof opts.dir === 'string' && opts.dir.length > 0) return path.resolve(opts.dir);
      const xdg = env ? env.XDG_CACHE_HOME : null;
      if (typeof xdg === 'string' && xdg.trim() !== '') return path.join(path.resolve(xdg), DIR_NAME);
      if (opts && 'home' in opts) {
        const home = opts.home;
        if (typeof home !== 'string' || home.length === 0) return null;
        return path.join(path.resolve(home), '.cache', DIR_NAME);
      }
      const home = os.homedir();
      if (typeof home !== 'string' || home.length === 0) return null;
      return path.join(home, '.cache', DIR_NAME);
    } catch {
      return null;
    }
  }

  function file() {
    const dir = directory();
    return dir === null ? null : path.join(dir, FILE_NAME);
  }

  // The document as a list of entries, oldest first. Anything this module cannot
  // read is `null`; any entry whose shape is wrong is dropped on its own, so one
  // hostile entry never costs the identity written beside it.
  async function readIdentities() {
    const target = file();
    if (target === null || fsSeam === null) return null;
    let text;
    try {
      text = await fsSeam.readFile(target, 'utf8');
    } catch {
      return null;
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(doc) || doc.version !== DOC_VERSION || !Array.isArray(doc.identities)) return null;
    const identities = [];
    for (const candidate of doc.identities) {
      const entry = normalizeEntry(candidate);
      if (entry !== null) identities.push(entry);
    }
    return identities;
  }

  async function load(identity) {
    if (typeof identity !== 'string' || identity.length === 0) return null;
    try {
      const identities = await readIdentities();
      if (identities === null) return null;
      for (let index = identities.length - 1; index >= 0; index -= 1) {
        if (identities[index].identity === identity) return copyEntry(identities[index]);
      }
      return null;
    } catch {
      return null;
    }
  }

  // One bucket set + the facts the loader knows, stored as one entry. `full` is
  // what the caller's plan decided: it is the ONLY thing that moves `fullAt`.
  function normalizeSnapshot(identity, snapshot) {
    if (typeof identity !== 'string' || identity.length === 0) return null;
    if (!isObject(snapshot)) return null;
    const at = Number.isFinite(snapshot.syncedAt) ? snapshot.syncedAt : Date.now();
    return normalizeEntry({
      identity,
      buckets: snapshot.buckets,
      counts: snapshot.counts,
      truncated: snapshot.truncated,
      inconsistent: snapshot.inconsistent,
      // Stamped here, then left alone below unless this answer WAS the full read.
      fullAt: at,
      syncedAt: at,
      lastApplied: snapshot.lastApplied,
    });
  }

  async function save(identity, snapshot) {
    const dir = directory();
    const target = file();
    if (dir === null || target === null || fsSeam === null) return false;
    const entry = normalizeSnapshot(identity, snapshot);
    if (entry === null) return false;
    try {
      const existing = await readIdentities();
      const identities = existing === null ? [] : existing;
      const previous = identities.find((candidate) => candidate.identity === identity) || null;
      const stored = {
        ...entry,
        // A delta never invents a full read: it keeps the one already stored, or
        // stamps this answer when it is all there is.
        fullAt: snapshot.full === true
          ? entry.syncedAt
          : (previous !== null && Number.isFinite(previous.fullAt) ? previous.fullAt : entry.syncedAt),
      };
      const kept = identities.filter((candidate) => candidate.identity !== identity);
      kept.push(stored);
      const body = JSON.stringify({ version: DOC_VERSION, identities: kept.slice(-limit) });
      await fsSeam.mkdir(dir, { recursive: true });
      writes += 1;
      // Atomic: the temp file lives in the SAME directory (a rename across
      // devices is not atomic, and a reader must never see half a document), and
      // the rename is what makes the new one readable.
      const temp = path.join(dir, `.${FILE_NAME}.${process.pid}.${writes}.tmp`);
      try {
        await fsSeam.writeFile(temp, body, 'utf8');
        await fsSeam.rename(temp, target);
      } catch {
        // Its own just-created temp file: removed so a failed write leaves the
        // directory exactly as it was. Best effort — the failure is already
        // silence to the caller.
        try {
          if (typeof fsSeam.unlink === 'function') await fsSeam.unlink(temp);
        } catch {
          // A temp file that cannot be removed is still not the document.
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  return { load, save, directory };
}

module.exports = { createIssuesCacheStore };

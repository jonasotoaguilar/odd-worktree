'use strict';
// T4 (S4, S5): the DISK half of the rail's pull-request read.
//
// `lib/issues-section.js` stays PURE — no imports, no child process, no disk —
// and owns what a read MEANS: the two buckets, the `pr` count they are painted
// as and the bucket a click is routed by. This module owns only where one entry
// sleeps between processes, exactly like `lib/issues-cache-store.js` owns the
// issues cache's: ONE small versioned JSON document under
// `$XDG_CACHE_HOME/odd-worktree/` (falling back to `~/.cache/odd-worktree/`), one
// entry per repository identity, keyed exactly as the rail keys its own reads
// (`<host>/<owner>/<repo>`), so a hydrated entry can never be painted under
// another repository's name. A cold start paints `N issues · M pr` at once
// instead of waiting for the child that answers the read.
//
// An entry holds the two bucket rows the rail reads — `mine` and `review`, each
// row its `number` and the `linkedIssues` it carries — plus `syncedAt`, the
// moment the read that produced them landed. It deliberately stores NO count: the
// header's `M` is the distinct numbers in mine ∪ review, so it is DERIVED here
// from the rows the document holds. A stored number can never contradict the rows
// it is painted from, and persistence can never turn a stale entry into a fresh
// one — the loader is the only thing that decides whether `syncedAt` is still
// inside the rail's window.
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
// cache directory and a host whose `fs` is broken simply gets an in-process rail.

const path = require('node:path');
const os = require('node:os');

// The document carries its own version: a reader that does not recognize one
// answers nothing instead of guessing at a shape it never wrote.
const DOC_VERSION = 1;
const DIR_NAME = 'odd-worktree';
const FILE_NAME = 'prs-rail.json';
const BUCKET_KEYS = ['mine', 'review'];
// The document is bounded exactly like the issues cache: the oldest identities
// are dropped past this cap, so a long-lived machine never grows a file nobody
// asked for.
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

// A pull request number, or `null` for anything that is not one. Only a positive
// integer identifies a pull request, exactly as the rail's own read decides it.
function pullRequestNumber(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// The linked issues of one row, in order, without repeats: a link the rail could
// not draw is not a link here either.
function linkedIssues(value) {
  if (!Array.isArray(value)) return [];
  const kept = [];
  for (const linked of value) {
    const number = pullRequestNumber(linked);
    if (number === null || kept.includes(number)) continue;
    kept.push(number);
  }
  return kept;
}

// One bucket, or `null` when it is not a list at all. A row without a usable
// number cannot be counted or routed to, so it is not a row here either — but one
// bad row never costs the bucket the rows beside it.
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return null;
  const kept = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const number = pullRequestNumber(row.number);
    if (number === null) continue;
    kept.push({ ...row, number, linkedIssues: linkedIssues(row.linkedIssues) });
  }
  return kept;
}

// One stored entry, or `null` when its shape is not the one this module writes.
// A hostile entry is never repaired into something a caller would then trust.
function normalizeEntry(candidate) {
  if (!isObject(candidate)) return null;
  const identity = candidate.identity;
  if (typeof identity !== 'string' || identity.length === 0) return null;
  const buckets = {};
  for (const key of BUCKET_KEYS) {
    const rows = normalizeRows(candidate[key]);
    if (rows === null) return null;
    buckets[key] = rows;
  }
  if (!Number.isFinite(candidate.syncedAt)) return null;
  // The count is the DISTINCT numbers in mine ∪ review, derived from the rows
  // above: whatever a document says about it, the rows are what is painted.
  const numbers = new Set();
  for (const key of BUCKET_KEYS) {
    for (const row of buckets[key]) numbers.add(row.number);
  }
  return {
    identity,
    mine: buckets.mine,
    review: buckets.review,
    count: numbers.size,
    syncedAt: candidate.syncedAt,
  };
}

function copyEntry(entry) {
  const normalized = normalizeEntry(entry);
  if (normalized === null) return null;
  const mine = normalized.mine.map((row) => ({ ...row, linkedIssues: row.linkedIssues.slice() }));
  const review = normalized.review.map((row) => ({ ...row, linkedIssues: row.linkedIssues.slice() }));
  return { ...normalized, mine, review };
}

function createPrsRailStore(options = {}) {
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

  // One rail read, stored as one entry: the two buckets and when they were read.
  // The identity is the one the loader just proved, so an entry is never written
  // under a name the read did not come from.
  function normalizeSnapshot(identity, snapshot) {
    if (typeof identity !== 'string' || identity.length === 0) return null;
    if (!isObject(snapshot)) return null;
    return normalizeEntry({
      identity,
      mine: snapshot.mine,
      review: snapshot.review,
      syncedAt: Number.isFinite(snapshot.syncedAt) ? snapshot.syncedAt : Date.now(),
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
      const kept = identities.filter((candidate) => candidate.identity !== identity);
      kept.push(entry);
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

module.exports = { createPrsRailStore };

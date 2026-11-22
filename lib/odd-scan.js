'use strict';
// Which ODDs this machine is working on, across EVERY checkout (odd-rail-section
// S3, S4, and S5's tie rule).
//
// The rail that consumes this repaints per frame, so this module is ONE pure
// function of the machine as it is right now: it enumerates the checkouts, scans
// each one's `odd/tasks` directory, keeps a single document per ODD name and
// returns the whole list, most recent first. It caches nothing (per-frame cost
// discipline belongs to the caller), writes nothing, and spawns nothing of its
// own except the one `git worktree list` read the checkout set comes from.
//
// Checkouts (S3): the main checkout first — `git worktree list` documents the
// main worktree first, and that entry is the main row — then the checkouts this
// package owns, i.e. the ones under `<repo-parent>/<repo-name>-worktrees`, in
// worktree-name order. Invariant 10: the path IS the whole record, so there is no
// document to read and none is read. A worktree Git knows outside that directory
// is not ours and is not scanned.
//
// Reuse, not duplication: the git read is `runAsync(bin, argv, cwd)`, the same
// seam convention lib/odd-docs.js and lib/worktree-git.js take and the same
// bounded async spawn wrapper as its default; its output is parsed by
// lib/worktree-registry.js's own porcelain parser; the owned subset comes from
// that module's `ownedCheckouts`; and each directory scan is lib/odd-docs.js's
// `listOddDocsLocal`, so the `<root>/odd/tasks/*.md` rule (non-recursive, regular
// files only, dotfiles skipped, absent directory = empty) is stated in exactly one
// place. This module adds only what none of them answers: the cross-checkout
// merge.
//
// Dedupe (S4): one ODD name in several checkouts is ONE row — the most recently
// modified document. On an exact mtime tie the MAIN checkout wins (S5): a copy of
// the document in a worktree is only as new as the edit that made it, and with no
// main copy in play the first checkout enumerated keeps the row, so the answer
// never depends on directory read order.
//
// Order: the whole list, most recently modified first, then by ODD name, then by
// checkout name and document path — code-unit comparisons only, never
// `localeCompare`, so the sequence is identical on every host and every run.
// Nothing is capped here: the rail shows at most four rows (S2), which is the
// rail's rule and not this one's.
//
// Cost and failure (fail closed): one `git worktree list` per call, then per
// checkout one non-recursive directory read and one stat per document — no
// recursion, no git log, no cache. An absent `odd/tasks` is an empty checkout, an
// unreadable checkout contributes nothing, a document whose timestamp cannot be
// read is left out rather than dated, and a git read that cannot name the
// checkouts leaves the caller's own root as the only checkout scanned. The
// function never throws for any of them.

const fs = require('node:fs');
const path = require('node:path');

const { ownedCheckouts, parseWorktreePorcelain } = require('./worktree-registry.js');
const { listOddDocsLocal } = require('./odd-docs.js');

const MAIN = 'main';
const WORKTREE_LIST_ARGS = ['worktree', 'list', '--porcelain', '-z'];
// The one read is bounded, and neutered against the configuration that would
// corrupt its paths: `core.quotePath=false` keeps a non-ASCII checkout readable
// instead of octal-escaped.
const GIT_CONFIG_ARGS = ['-c', 'core.quotePath=false'];
const GIT_TIMEOUT_MS = 5000;

const compareText = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Worktrees order by name, so the sequence never depends on Git's own. */
function compareCheckout(a, b) {
  const named = compareText(path.basename(a.path), path.basename(b.path));
  return named === 0 ? compareText(a.path, b.path) : named;
}

const samePath = (a, b) => a.length > 1 && b.length > 1 && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * The checkouts to scan: the main checkout first, then every owned worktree.
 * `entries` is `git worktree list`'s answer, or null when git could not give one —
 * and then the caller's own root is the only checkout there is, reported as the
 * main one because with no listing nothing can tell the two apart.
 */
function checkoutsOf(entries, repoRoot) {
  if (entries === null) return [{ root: repoRoot, name: MAIN }];
  const main = entries[0];
  const mainRoot = main && typeof main.path === 'string' && main.path.length > 0 ? main.path : repoRoot;
  const rest = entries.filter((entry) => entry !== main
    && !(entry && typeof entry.path === 'string' && samePath(entry.path, mainRoot)));
  const checkouts = [{ root: mainRoot, name: MAIN }];
  for (const entry of ownedCheckouts(rest, mainRoot).sort(compareCheckout)) {
    checkouts.push({ root: entry.path, name: path.basename(entry.path) });
  }
  return checkouts;
}

/** One checkout's documents, each dated by its own mtime; an unreadable one counts nothing. */
function scanCheckout(checkout) {
  const listing = listOddDocsLocal(checkout.root);
  if (listing.ok !== true) return [];
  const rows = [];
  for (const doc of listing.docs) {
    const mtimeMs = readMtimeMs(doc.path);
    // A document whose timestamp cannot be read is left out instead of dated:
    // every row this module returns carries a real modification time.
    if (mtimeMs === null) continue;
    rows.push({
      name: doc.name,
      docPath: doc.path,
      checkoutRoot: checkout.root,
      checkoutName: checkout.name,
      mtimeMs,
    });
  }
  return rows;
}

/** Modification time in ms, or null when it cannot be read. */
function readMtimeMs(target) {
  try {
    const stats = fs.statSync(target);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * S4/S5: a strictly newer document wins; on an exact tie the main checkout wins,
 * and between two worktrees the first one enumerated keeps the row.
 */
function winsOver(candidate, current) {
  if (candidate.mtimeMs !== current.mtimeMs) return candidate.mtimeMs > current.mtimeMs;
  return current.checkoutName !== MAIN && candidate.checkoutName === MAIN;
}

/** One row per ODD name, most recent first. */
function newestByName(rows) {
  const chosen = new Map();
  for (const row of rows) {
    const current = chosen.get(row.name);
    if (current === undefined || winsOver(row, current)) chosen.set(row.name, row);
  }
  return [...chosen.values()].sort(compareRows);
}

// Total order: recency descending, then ODD name, then checkout name, then the
// document path — code-unit comparisons only, so the sequence is stable.
function compareRows(a, b) {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return compareText(a.name, b.name)
    || compareText(a.checkoutName, b.checkoutName)
    || compareText(a.docPath, b.docPath);
}

/**
 * The ODDs this machine is working on, across every owned checkout. `repoRoot` is
 * the repository the git reads run in; `runAsync` is the package's git seam
 * (`(bin, argv, cwd) => Promise<{status, stdout, stderr, error}>`), defaulting to
 * the shared bounded async spawn wrapper.
 */
async function scanOddAcrossWorktrees(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const repoRoot = absoluteRoot(opts.repoRoot);
  if (repoRoot === null) return [];
  const entries = await listCheckoutEntries(repoRoot, opts);
  const rows = [];
  for (const checkout of checkoutsOf(entries, repoRoot)) rows.push(...scanCheckout(checkout));
  return newestByName(rows);
}

/** The root as an absolute path, or null when the caller gave nothing usable. */
function absoluteRoot(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return path.resolve(value);
}

// The one listing read: fixed argv through the seam, parsed by the shared parser.
// `null` means "git could not answer" — not an exception and not an empty machine.
async function listCheckoutEntries(repoRoot, opts) {
  const listed = await runGitAsync(repoRoot, WORKTREE_LIST_ARGS, opts);
  return listed === null ? null : parseWorktreePorcelain(listed);
}

// One read, awaited instead of spawned inline, with the identical
// stdout-or-null contract every git read in this package keeps: a missing
// binary, a non-zero exit, a timeout or a throw is `null`.
function runGitAsync(root, args, opts) {
  let pending = null;
  try {
    pending = asyncRunnerOf(opts)('git', [...GIT_CONFIG_ARGS, ...args], root);
  } catch {
    return Promise.resolve(null);
  }
  return Promise.resolve(pending)
    .then((result) => {
      if (!result || result.error || result.status !== 0) return null;
      return typeof result.stdout === 'string' ? result.stdout : '';
    })
    .catch(() => null);
}

// The injected runner when a caller supplies it, otherwise the shared bounded
// async spawn wrapper — loaded lazily, so a caller that only ever uses its own
// seam never pays for it.
function asyncRunnerOf(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (typeof options.runAsync === 'function') return options.runAsync;
  const worktreeGit = require('./worktree-git.js');
  return (bin, args, cwd) => worktreeGit.runArgvAsync(bin, args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

module.exports = {
  scanOddAcrossWorktrees,
};

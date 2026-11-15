'use strict';
// The sync one compaction asks for (S2, S3): after a compaction the index is as stale as the session was long, so
// this requests ONE background sync of the checkout. It only ever syncs an index that already exists — never
// initialises a project — never notifies the session, and never throws: its outcome goes to the caller's log.
//
// It is the same coordinated request the session start and the post-init hook use (`lib/codegraph-index.js`), so the
// sync runs under the per-project lease and the package's index lock, and a request that finds an init running is
// kept and served once the init ends, not dropped. A subagent child, a read-only role and a machine without the
// `codegraph` CLI start nothing at all.

const nodeFs = require('node:fs');

const { realInitLock, realSyncLease } = require('./codegraph-lock.js');
const {
  CHILD_ENV,
  cliAvailable,
  planIndexAction,
  requestCoordinatedSync,
  runCodegraph,
} = require('./codegraph-index.js');
const { mayInitiateIndexWrite, sessionIndexRole } = require('./codegraph-role.js');

/** Whether this session may write the index at all: a caller-supplied `mayWrite`/`role` wins, else the child env. */
function mayWriteHere(input) {
  if (typeof input.mayWrite === 'boolean') return input.mayWrite;
  if (input.role !== undefined) return mayInitiateIndexWrite(input.role);
  return mayInitiateIndexWrite(sessionIndexRole(input.env || process.env));
}

async function decide(input) {
  const env = input.env || {};
  if (env[CHILD_ENV] === '1') return 'skipped-child';
  if (!mayWriteHere(input)) return 'skipped-read-only';
  if (!cliAvailable({ hasBinary: input.hasBinary })) return 'skipped-no-cli';
  const exists = typeof input.exists === 'function' ? input.exists : (p) => nodeFs.existsSync(p);
  if (planIndexAction(input.cwd, exists) !== 'sync') return 'skipped-no-index';
  // The same coordinated request the startup and post-init syncs use: one lease, the index lock for the run.
  const outcome = await requestCoordinatedSync({
    project: input.cwd,
    sync: input.sync === undefined ? realSyncLease : input.sync || undefined,
    lock: input.lock === undefined ? realInitLock : input.lock || undefined,
    run: input.run === undefined ? runCodegraph : input.run,
  });
  if (outcome === 'synced') return 'synced';
  if (outcome === 'coalesced') return 'coalesced';
  if (outcome === 'pending') return 'queued';
  if (outcome === 'unavailable') return 'skipped-coordination-unavailable';
  return 'failed';
}

/**
 * Requests one coordinated background sync after a compaction and returns what it achieved: `synced` only for a run
 * that came back here, `coalesced` only for another session's run that started after this request and completed,
 * `queued` for a request that is recorded and still waiting for the index to be free, and the `skipped-*` outcomes
 * for a session that may not write. Never throws; a diagnostic line goes to the caller's `log` seam alone.
 */
async function compactionSync(input = {}) {
  const now = typeof input.now === 'function' ? input.now : Date.now;
  const started = now();
  let outcome;
  try {
    outcome = await decide(input);
  } catch {
    outcome = 'failed';
  }
  try {
    if (typeof input.log === 'function') input.log({ cwd: input.cwd, outcome, ms: Math.max(0, now() - started) });
  } catch {
    // A log is never worth failing the session over.
  }
  return { outcome };
}

module.exports = {
  compactionSync,
};

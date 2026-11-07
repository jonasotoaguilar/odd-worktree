'use strict';
// Principal-entry symlinks for the worktree tools (S51/T42, re-scoped by
// round-3 S3/L4: ignore-gated and never destructive).
//
// On every worktree creation, each name in `LINK_NAMES` — `.agents`, `.pi`,
// `.claude` and `odd` — is linked from the PRINCIPAL checkout into the new
// worktree ONLY when ALL of these hold:
//
//   - the principal entry resolves to a directory,
//   - git TRACKS nothing under it there (a tracked entry already arrives
//     with the checkout, and its content is never replaced),
//   - git IGNORES it there (a merely untracked entry is not eligible:
//     the user did not ask for it to travel),
//   - the new worktree has nothing at that path (a checkout entry and a
//     path somebody else occupied are both preserved; nothing is ever
//     removed or replaced).
//
// An existing link that already points at the principal entry is
// idempotent: it is reported as `existing`, no write happens, and it stays
// in `created` because that field means "links in place after this call"
// (the meaning the create tool already surfaces).
//
// Both git facts come from ONE fixed-argv call each (`git ls-files`,
// `git check-ignore`), never a shell string, with a bounded timeout. When
// git cannot answer for a name, that name is skipped — fail closed, never
// a guess.
//
// The tool's creation hooks use the sync runner; command-side hooks use the
// async twin so their git calls never block the event loop. Both runners
// share the eligibility classifier and never replace an occupied target.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LINK_NAMES = ['.agents', '.pi', '.claude', 'odd'];

const DEFAULT_TIMEOUT_MS = 30000;

// Fixed argv, bounded timeout, no shell. Same shape as the hook runner so a
// caller can inject its own runner.
function defaultRunGit(bin, args, opts = {}) {
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    return { status: null, stdout: '', stderr: '', error: String((result.error && result.error.message) || result.error) };
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: null };
}

// Async default: the owned runner shared with the creation hooks, so a
// timed-out git child is killed and reaped instead of being abandoned.
function defaultRunGitAsync(bin, args, opts = {}) {
  let runner = null;
  try {
    runner = require('./worktree-git.js').runArgvAsync;
  } catch {
    runner = null;
  }
  if (typeof runner === 'function') return runner(bin, args, opts);
  return Promise.resolve({ status: null, stdout: '', stderr: '', error: 'async git runner unavailable' });
}

function callGit(run, args, cwd, timeoutMs, env) {
  let res;
  try {
    res = run('git', args, { cwd, timeoutMs, env });
  } catch {
    return null;
  }
  if (!res) return null;
  if (res.status === null || res.status === undefined || res.error) return null;
  return res;
}

async function callGitAsync(runAsync, args, cwd, timeoutMs, env) {
  let res;
  try {
    res = await runAsync('git', args, { cwd, timeoutMs, env });
  } catch {
    return null;
  }
  if (!res) return null;
  if (res.status === null || res.status === undefined || res.error) return null;
  return res;
}

function namesFromArgs(names) {
  return Array.isArray(names) && names.length > 0 ? names : LINK_NAMES;
}

// Which names a `git ls-files` listing covers: a name is tracked when the
// listing names it or anything below it.
function trackedFromStdout(names, stdout) {
  const tracked = new Set();
  for (const line of String(stdout || '').split('\n')) {
    if (line.length === 0) continue;
    for (const name of names) {
      if (line === name || line.startsWith(`${name}/`)) tracked.add(name);
    }
  }
  return tracked;
}

// Which names a `git check-ignore` listing reports. Exit 1 means "none of
// them is ignored", which is an answer, not a failure.
function ignoredFromStdout(names, stdout) {
  const ignored = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const name = line.trim();
    if (name.length > 0 && names.includes(name)) ignored.add(name);
  }
  return ignored;
}

// Names git tracks in the principal, or null when git cannot answer.
function trackedNames(run, principalRoot, names, timeoutMs, env) {
  const res = callGit(run, ['ls-files', '--', ...names], principalRoot, timeoutMs, env);
  if (!res || res.status !== 0) return null;
  return trackedFromStdout(names, res.stdout);
}

// Names git ignores in the principal, or null when git cannot answer.
// An ignored path is never reported for a tracked one, which is why the
// tracked read comes first: checkout content wins.
function ignoredNames(run, principalRoot, names, timeoutMs, env) {
  const res = callGit(run, ['check-ignore', '--', ...names], principalRoot, timeoutMs, env);
  if (!res) return null;
  // 1 is "none of these is ignored"; any other non-zero is an error.
  if (res.status !== 0 && res.status !== 1) return null;
  return ignoredFromStdout(names, res.stdout);
}

async function trackedNamesAsync(runAsync, principalRoot, names, timeoutMs, env) {
  const res = await callGitAsync(runAsync, ['ls-files', '--', ...names], principalRoot, timeoutMs, env);
  if (!res || res.status !== 0) return null;
  return trackedFromStdout(names, res.stdout);
}

async function ignoredNamesAsync(runAsync, principalRoot, names, timeoutMs, env) {
  const res = await callGitAsync(runAsync, ['check-ignore', '--', ...names], principalRoot, timeoutMs, env);
  if (!res) return null;
  if (res.status !== 0 && res.status !== 1) return null;
  return ignoredFromStdout(names, res.stdout);
}

function sourceState(src) {
  let stat;
  try {
    stat = fs.statSync(src);
  } catch {
    return 'missing';
  }
  return stat.isDirectory() ? 'directory' : 'not-directory';
}

// `same-link` is the idempotent case: a symlink that already resolves to the
// principal entry. Anything else at that path is `occupied` and is kept —
// this hook never deletes or replaces an existing entry.
function targetState(dst, src) {
  let lstat;
  try {
    lstat = fs.lstatSync(dst);
  } catch {
    return 'absent';
  }
  if (!lstat.isSymbolicLink()) return 'occupied';
  try {
    return fs.realpathSync(dst) === fs.realpathSync(src) ? 'same-link' : 'occupied';
  } catch {
    return 'occupied';
  }
}

async function sourceStateAsync(src) {
  try {
    const stat = await fs.promises.stat(src);
    return stat.isDirectory() ? 'directory' : 'not-directory';
  } catch {
    return 'missing';
  }
}

async function targetStateAsync(dst, src) {
  let lstat;
  try {
    lstat = await fs.promises.lstat(dst);
  } catch {
    return 'absent';
  }
  if (!lstat.isSymbolicLink()) return 'occupied';
  try {
    const [a, b] = await Promise.all([fs.promises.realpath(dst), fs.promises.realpath(src)]);
    return a === b ? 'same-link' : 'occupied';
  } catch {
    return 'occupied';
  }
}

// The one place eligibility is decided, shared by both runners. Order is the
// contract: a source problem, an idempotent link, then the tracked gate (it
// explains why a checkout entry is already there), then an occupied target,
// then the ignore gate.
function classify({ name, source, target, tracked, ignored }) {
  if (source === 'missing') return { action: 'skip', reason: `${name}: missing source` };
  if (source !== 'directory') return { action: 'skip', reason: `${name}: source is not a directory` };
  if (target === 'same-link') return { action: 'existing' };
  if (tracked === null) return { action: 'skip', reason: `${name}: tracked status unknown` };
  if (tracked.has(name)) return { action: 'skip', reason: `${name}: tracked`, trackedBlocked: true };
  if (target === 'occupied') return { action: 'skip', reason: `${name}: target exists` };
  if (ignored === null) return { action: 'skip', reason: `${name}: ignore status unknown` };
  if (!ignored.has(name)) return { action: 'skip', reason: `${name}: not git-ignored` };
  return { action: 'link' };
}

function emptyResult() {
  return { created: [], existing: [], skipped: [], skippedTracked: [], errors: [] };
}

function record(result, entry, name) {
  if (entry.action === 'existing') {
    result.created.push(name);
    result.existing.push(name);
    return;
  }
  result.skipped.push(entry.reason);
  if (entry.trackedBlocked) result.skippedTracked.push(name);
}

// Shared context resolution; the caller supplies the git runner, so the sync
// and async entry points differ only in how they await filesystem work.
function resolveContext(opts) {
  const principalRoot = opts.principalRoot;
  const worktreePath = opts.worktreePath;
  if (typeof principalRoot !== 'string' || principalRoot.length === 0) return null;
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return null;
  const names = namesFromArgs(opts.names);
  const env = opts.env || process.env;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    names,
    principalRoot,
    worktreePath,
    env,
    timeoutMs,
  };
}

// Apply the link policy synchronously. Returns `{created, existing, skipped,
// skippedTracked, errors}` and never throws: a failed link is reported, the
// other names still apply, and creation is never failed by this step.
function applyWorktreeSymlinks(opts = {}) {
  const run = typeof opts.run === 'function'
    ? (bin, args, o) => opts.run(bin, args, o)
    : defaultRunGit;
  const ctx = resolveContext(opts);
  const result = emptyResult();
  if (!ctx) return result;
  const {
    names, principalRoot, worktreePath, env, timeoutMs,
  } = ctx;
  const tracked = trackedNames(run, principalRoot, names, timeoutMs, env);
  const ignored = tracked === null ? null : ignoredNames(run, principalRoot, names, timeoutMs, env);
  for (const name of names) {
    const src = path.join(principalRoot, name);
    const entry = classify({
      name,
      source: sourceState(src),
      target: targetState(path.join(worktreePath, name), src),
      tracked,
      ignored,
    });
    if (entry.action !== 'link') {
      record(result, entry, name);
      continue;
    }
    try {
      // Absolute target, so the link never depends on cwd spelling. The type
      // only matters on Windows ('junction' needs no privilege for
      // directories); POSIX ignores it.
      fs.symlinkSync(src, path.join(worktreePath, name), 'junction');
      result.created.push(name);
    } catch (err) {
      result.errors.push(`${name}: ${(err && err.message) || err}`);
    }
  }
  return result;
}

// Async twin: identical plan and result shape, awaited filesystem and git
// work so the event loop keeps running while a large principal is inspected.
async function applyWorktreeSymlinksAsync(opts = {}) {
  const runAsync = typeof opts.runAsync === 'function'
    ? (bin, args, o) => opts.runAsync(bin, args, o)
    : defaultRunGitAsync;
  const ctx = resolveContext(opts);
  const result = emptyResult();
  if (!ctx) return result;
  const {
    names, principalRoot, worktreePath, env, timeoutMs,
  } = ctx;
  const tracked = await trackedNamesAsync(runAsync, principalRoot, names, timeoutMs, env);
  const ignored = tracked === null ? null : await ignoredNamesAsync(runAsync, principalRoot, names, timeoutMs, env);
  for (const name of names) {
    const src = path.join(principalRoot, name);
    const entry = classify({
      name,
      source: await sourceStateAsync(src),
      target: await targetStateAsync(path.join(worktreePath, name), src),
      tracked,
      ignored,
    });
    if (entry.action !== 'link') {
      record(result, entry, name);
      continue;
    }
    try {
      await fs.promises.symlink(src, path.join(worktreePath, name), 'junction');
      result.created.push(name);
    } catch (err) {
      result.errors.push(`${name}: ${(err && err.message) || err}`);
    }
  }
  return result;
}

module.exports = {
  LINK_NAMES,
  applyWorktreeSymlinks,
  applyWorktreeSymlinksAsync,
};

'use strict';
// Index preparation (S2) and its coordination (S3): one create-or-sync policy per root, a linked worktree seeded
// from the main checkout's index, and every write of the package under one init lock and one per-project sync lease.
//
// The decision is `planIndexAction`: an existing `.codegraph` is synced, a fresh git project with a marker file is
// initialised, anything else is left alone. A linked worktree extends it: it indexes its own tree and never shares
// the main checkout's index, so an unindexed worktree whose main checkout has an index is SEEDED from it (a copy
// while nobody writes it, then one sync in the worktree) instead of paying a full init.
//
// Nothing here runs in the foreground of a caller that can await: every command is a fixed argv with a bounded
// timeout through an injected runner, spawned from the temp directory with the project as an argument, and a
// timeout only reports the failure once the terminated process is gone. No shell string, no `spawnSync`, no network.
//
// Every seam is injected with a real default: `run`, `hasBinary`, `exists`, `fs`, `lock`, `sync`, `copySeed`,
// `sourceBusy`, `clock` (`now`). The CLI's presence is probed ONCE PER PROCESS (the probe is cached per probe
// function, so the real PATH probe runs once and a test's own seam runs once for that seam), and without it nothing
// here runs at all. Role gating is the caller's: it passes `role` or `mayWrite`, and a read-only role starts no
// index write here, in the post-init path or in a compaction.

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');

const { codegraphSpawn } = require('./codegraph-paths.js');
const { mayInitiateIndexWrite, sessionIndexRole } = require('./codegraph-role.js');
const {
  INIT_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  codegraphWritingIndex,
  realInitLock,
  realSyncLease,
} = require('./codegraph-lock.js');
const { listWorktreesAsync } = require('./worktree-git.js');

/** One of these next to a `.git` is what makes a directory a project worth indexing automatically. */
const INIT_PROJECT_MARKERS = [
  'composer.json',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

/** The environment variable a subagent child carries; a child shares its parent's project. */
const CHILD_ENV = 'GENTLE_PI_AGENTS_CHILD';

/** The native CodeGraph extension tool: the one that can `init` itself, and the one the hook observes. */
const NATIVE_CODEGRAPH_TOOL = 'codegraph';

/**
 * How long the tool result of a native `codegraph init` waits for the sync requested after it before reporting it as
 * pending. The request is not cancelled: it stays recorded and runs when the index is free.
 */
const POST_INIT_SYNC_WAIT_MS = 10_000;

/** How long a killed command may take to be gone before the timeout is reported anyway. */
const KILL_WAIT_MS = 10_000;

/**
 * How long after the soft kill a child that is still alive is escalated to a hard one. It sits inside the reporting
 * grace (`killWaitMs`, `KILL_WAIT_MS` by default): the escalation happens while the run still reports its timeout,
 * never instead of that report. A caller's `escalationMs` is clamped to at most half that grace and never negative,
 * so a configured escape hatch cannot silently disable the hard kill.
 */
const KILL_ESCALATION_MS = 2_000;

/** The `node:fs` surface used here, so a test can stand in for it. */
const FS_NAMES = ['copyFileSync', 'existsSync', 'mkdirSync', 'readFileSync', 'renameSync', 'rmSync', 'statSync', 'writeFileSync'];

function fsOf(options) {
  const fs = options && options.fs;
  if (!fs) return nodeFs;
  const merged = {};
  for (const name of FS_NAMES) merged[name] = typeof fs[name] === 'function' ? fs[name] : nodeFs[name];
  return merged;
}

/**
 * The rename the atomic seed publish uses, or `undefined` when the seam this caller supplied has none: a fake without
 * a rename keeps the two-write publish it always had instead of gaining an operation it never provided.
 */
function renamerOf(options) {
  const fs = options && options.fs;
  if (!fs) return nodeFs.renameSync;
  return typeof fs.renameSync === 'function' ? fs.renameSync : undefined;
}

function lockOf(value) {
  if (value === undefined) return realInitLock;
  return value || undefined;
}

function syncOf(value) {
  if (value === undefined) return realSyncLease;
  return value || undefined;
}

/**
 * Whether this session may start an index write at all. The caller decides (it passes `mayWrite`, or the `role` it
 * read from the session's tools); without either, the role is read from the child environment the same way the
 * prompt section reads it. A read-only role never writes the index it reads.
 */
function mayWriteHere(input) {
  if (input && typeof input.mayWrite === 'boolean') return input.mayWrite;
  if (input && input.role !== undefined) return mayInitiateIndexWrite(input.role);
  return mayInitiateIndexWrite(sessionIndexRole((input && input.env) || process.env));
}

// ---- The CLI seam (S2) ----

/** A PATH presence probe that never runs the binary. */
function binaryOnPath(command) {
  const directories = (process.env.PATH || '').split(nodePath.delimiter).filter((directory) => directory.length > 0);
  if (process.platform !== 'win32') return directories.some((directory) => nodeFs.existsSync(nodePath.join(directory, command)));
  const extensions = ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')];
  return directories.some((directory) => extensions.some((extension) => nodeFs.existsSync(nodePath.join(directory, `${command}${extension}`))
    || nodeFs.existsSync(nodePath.join(directory, `${command}${extension.toLowerCase()}`))));
}

/**
 * The probe result of each probe function this process used: the CLI's presence is checked once per process, so a
 * session start and a compaction never probe twice. An injected seam is cached by its own identity, which is what
 * keeps a test's answer its own.
 */
const probeCache = new Map();

/** Whether the `codegraph` CLI is present, probed at most once per process (or once per injected seam). */
function cliAvailable(options = {}) {
  const hasBinary = typeof options.hasBinary === 'function' ? options.hasBinary : binaryOnPath;
  if (!probeCache.has(hasBinary)) {
    let present = false;
    try {
      present = Boolean(hasBinary('codegraph'));
    } catch {
      present = false;
    }
    probeCache.set(hasBinary, present);
  }
  return probeCache.get(hasBinary);
}

// ---- Running the CLI (S1, S2, S3) ----

/** Kills a child and its tree, without ever throwing: the caller is already finishing a run. */
function killTree(pid, child, options = {}) {
  const spawnChild = typeof options.spawn === 'function' ? options.spawn : spawn;
  const platform = options.platform || process.platform;
  const signal = options.signal || 'SIGTERM';
  if (platform === 'win32' && pid !== undefined) {
    try {
      // `taskkill /T /F` is already the hard kill: the escalation re-runs it only while the pid is still alive.
      spawnChild('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    } catch {
      // Fall through to the plain kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Whether a spawned child has already left, so a second kill would only signal a pid that may be reused. */
function childExited(child) {
  const code = child && child.exitCode;
  const signal = child && child.signalCode;
  return (code !== undefined && code !== null) || (signal !== undefined && signal !== null);
}

/**
 * Runs the codegraph CLI with fixed arguments for the project in `cwd`. It runs from the temp directory with the
 * project as the last argument (`sync -q <path>`, `init -y <path>`), because cmd.exe does not accept a UNC working
 * directory and another spelling of one root starts another daemon. `onSpawn` gets the pid of the process, which the
 * init lock records, and whether that pid is only the shell spawned around the real command (Windows runs the npm
 * shim through a shell). A timeout kills the process tree, escalates a child that survived the soft kill to a hard
 * kill, and only reports the failure once that process is gone; a run that timed out is never a success.
 */
function runCodegraph(args, cwd, timeoutMs, onSpawn, options = {}) {
  const platform = options.platform || process.platform;
  const spawnChild = typeof options.spawn === 'function' ? options.spawn : spawn;
  const projectFor = typeof options.projectFor === 'function' ? options.projectFor : (project) => project;
  const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SYNC_TIMEOUT_MS;
  const killWaitMs = Number.isFinite(options.killWaitMs) && options.killWaitMs > 0 ? options.killWaitMs : KILL_WAIT_MS;
  // A delay at or beyond the reporting grace would be cleared by that report and never fire, so the effective delay is
  // capped at half the grace: the hard kill always has room to land before the run reports its timeout.
  const requestedEscalationMs = Number.isFinite(options.escalationMs) && options.escalationMs >= 0
    ? options.escalationMs
    : KILL_ESCALATION_MS;
  const escalationMs = Math.min(requestedEscalationMs, killWaitMs / 2);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let escalation;
    let grace;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(grace);
      resolve(ok);
    };
    let project = cwd;
    try {
      project = projectFor(cwd);
    } catch {
      project = cwd;
    }
    // Windows needs a shell to run the .cmd shim that npm installs for codegraph: the pid that comes back is that
    // shell, not the process that ends up writing the index.
    const shelled = platform === 'win32';
    let child;
    try {
      const run = codegraphSpawn(args, project, platform);
      const env = { ...process.env, ...run.env };
      child = run.shell
        ? spawnChild(run.command, { cwd: run.cwd, env, shell: true, windowsHide: true, stdio: 'ignore' })
        : spawnChild(run.command, run.args, { cwd: run.cwd, env, windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    if (child.pid !== undefined && typeof onSpawn === 'function') {
      try {
        onSpawn(child.pid, { proxy: shelled });
      } catch {
        // Recording the pid is never worth failing the run.
      }
    }
    timer = setTimeout(() => {
      // From here the run is a timeout: whatever exit code the child ends with, it is reported as a failure.
      timedOut = true;
      killTree(child.pid, child, { spawn: spawnChild, platform });
      // A child that trapped the soft kill is escalated while the same grace still runs: the hard kill fires only if
      // the child is still alive, and it never turns the timeout into a success.
      escalation = setTimeout(() => {
        if (settled || childExited(child)) return;
        killTree(child.pid, child, { spawn: spawnChild, platform, signal: 'SIGKILL' });
      }, escalationMs);
      if (escalation && typeof escalation.unref === 'function') escalation.unref();
      // A killed command may still be closing; the run reports the failure once that one is gone.
      grace = setTimeout(() => finish(false), killWaitMs);
    }, bound);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(!timedOut && code === 0));
  });
}

// ---- The create-or-sync decision (S2) ----

/** An existing index is synced; a fresh git project with a marker file is initialised; anything else is left alone. */
function planIndexAction(cwd, exists = (p) => nodeFs.existsSync(p)) {
  if (exists(nodePath.join(cwd, '.codegraph'))) return 'sync';
  if (exists(nodePath.join(cwd, '.git')) && INIT_PROJECT_MARKERS.some((marker) => exists(nodePath.join(cwd, marker)))) return 'init';
  return 'none';
}

/**
 * How a directory relates to a git repository. A linked worktree carries its own `.codegraph` decision: it indexes
 * its own tree, never the main checkout's. There, `.git` is a file with `gitdir: <path>` pointing into the main
 * repository's `.git/worktrees/<name>`; the common root is found by walking up to the directory whose `.git` is a
 * directory. A plain repo, a pointer to a directory that is not there, or anything unreadable is not a worktree:
 * the caller falls back to the normal per-directory decision.
 */
function worktreeOf(cwd, options = {}) {
  const fs = fsOf(options);
  try {
    const dotGit = nodePath.join(cwd, '.git');
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isFile()) return { worktree: false };
    const first = fs.readFileSync(dotGit, 'utf8').split(/\r?\n/, 1)[0] || '';
    const match = /^gitdir:\s*(.+)$/i.exec(first.trim());
    if (!match) return { worktree: false };
    const gitdir = nodePath.resolve(cwd, match[1].trim());
    if (!fs.existsSync(gitdir)) return { worktree: false };
    // The worktree gitdir is <commonRoot>/.git/worktrees/<name>; walk up to the .git directory itself.
    let dir = nodePath.dirname(gitdir);
    for (;;) {
      const candidate = nodePath.join(dir, '.git');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return { worktree: true, commonRoot: dir };
      const parent = nodePath.dirname(dir);
      if (parent === dir) return { worktree: false };
      dir = parent;
    }
  } catch {
    return { worktree: false };
  }
}

/**
 * The index decision for one directory, extending the per-directory decision with worktrees: a worktree that already
 * has its own index is synced, one whose main checkout has an index is seeded from it, and everything else falls back
 * to `planIndexAction`.
 */
function worktreeIndexAction(cwd, exists = (p) => nodeFs.existsSync(p), options = {}) {
  const found = worktreeOf(cwd, options);
  if (found.worktree && exists(nodePath.join(cwd, '.codegraph'))) return { action: 'sync' };
  if (found.worktree && exists(nodePath.join(found.commonRoot, '.codegraph'))) return { action: 'seed', commonRoot: found.commonRoot };
  return { action: planIndexAction(cwd, exists) };
}

// ---- Seeding a linked worktree (S2, S3) ----

/** Every SQLite database file, and so every real CodeGraph index, starts with these 16 bytes. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** The seed copy for real runs: a plain file copy of the db, staged so a failure leaves nothing behind. */
function defaultCopySeed(from, to) {
  try {
    nodeFs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the staged copy is a plausible index: non-empty and starting with the SQLite magic, read through the
 * injected fs seam so it is never inferred from a stat. A read that fails, throws or answers something else is not an
 * index, and the caller treats that exactly like a failed copy. Never throws.
 */
function isPlausibleIndex(fs, staged) {
  try {
    const head = fs.readFileSync(staged);
    if (typeof head === 'string') return head.length >= SQLITE_MAGIC.length && head.startsWith(SQLITE_MAGIC);
    if (head instanceof Uint8Array) {
      if (head.length < SQLITE_MAGIC.length) return false;
      return Buffer.from(head.subarray(0, SQLITE_MAGIC.length)).toString('latin1') === SQLITE_MAGIC;
    }
    return false;
  } catch {
    return false;
  }
}

/** An entry stat answered ENOENT for: it is positively gone, which is a fact a caller may act on. */
const ENTRY_ABSENT = Object.freeze({ state: 'absent' });
/** An entry whose identity could not be read: unknown, which is never "gone" and never "the same one". */
const ENTRY_UNKNOWN = Object.freeze({ state: 'unknown' });

/**
 * The identity of one filesystem entry, read through the injected fs seam — and, when it cannot be read, WHICH kind of
 * nothing that is:
 *   - `{ state: 'present', dev, ino }`: the entry is there and its identity is known;
 *   - `ENTRY_ABSENT`: stat said ENOENT, so the entry is positively gone;
 *   - `ENTRY_UNKNOWN`: any other failed read (EACCES, EPERM, a throwing seam, an answer without a device and inode).
 * The rule that must not be reintroduced anywhere below: UNKNOWN is never read as "absent" and never as "the same
 * entry". A caller removes something only on a positive reading — the identity it captured, or a positively gone db.
 */
function identityOf(fs, entry) {
  try {
    const stats = fs.statSync(entry);
    if (!stats || !Number.isFinite(stats.dev) || !Number.isFinite(stats.ino)) return ENTRY_UNKNOWN;
    return { state: 'present', dev: stats.dev, ino: stats.ino };
  } catch (error) {
    return error && error.code === 'ENOENT' ? ENTRY_ABSENT : ENTRY_UNKNOWN;
  }
}

/** Whether the entry on disk is provably the very one whose identity was captured: two present readings, same inode. */
function sameIdentity(observed, captured) {
  return observed.state === 'present' && captured !== undefined && captured.state === 'present' && observed.dev === captured.dev && observed.ino === captured.ino;
}

/** Whether the entry is positively gone. Only ENOENT says that; every other failed read is unknown and says nothing. */
function isPositivelyAbsent(observed) {
  return observed.state === 'absent';
}

/**
 * Publishes the staged copy as the worktree's index: one rename where the seam has one, so a crash cannot leave a
 * half-published db, and the older two-write copy when the seam provides no rename.
 */
function publishStagedCopy(fs, staged, target, rename) {
  if (typeof rename === 'function') {
    rename(staged, target);
    return;
  }
  fs.copyFileSync(staged, target);
  fs.rmSync(staged, { force: true });
}

/**
 * Seeds the worktree's own index by copying the main repo's `codegraph.db`, never while the main index is being
 * written and never leaving a half-built `.codegraph` behind: the copy is staged, validated as a plausible index, and
 * only then published in one move. A copy that fails, and a copy that is not a real index, are the same failure: the
 * staging file and the directory this call created are removed, and the caller runs no sync over it. The `-wal`/`-shm`
 * siblings are deliberately not copied: the source db must be at rest, and the first sync in the worktree rebuilds
 * whatever the WAL held.
 *
 * Ownership is captured, never inferred: the directory's identity is recorded the instant this call's `mkdir` creates
 * it, and the published db's identity right after the rename. `onPublished` receives both, so the caller's rollback can
 * prove what it removes instead of assuming it from a successful publish. A directory this call did not create is
 * never published into: an `EEXIST` at the creation step means another actor owns it, so nothing is written there at
 * all — `onJoined` is called when that directory already holds an index (the caller's "someone else's index is there"
 * outcome), and a directory without one is simply a failed seed. Both fail closed.
 */
function seedWorktreeIndex(input = {}) {
  const fs = fsOf(input);
  const source = nodePath.join(input.commonRoot, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(source) || input.sourceBusy()) return false;
  const targetDir = nodePath.join(input.worktree, '.codegraph');
  const target = nodePath.join(targetDir, 'codegraph.db');
  const staged = nodePath.join(targetDir, 'codegraph.db.seeding');
  const copy = typeof input.copy === 'function' ? input.copy : defaultCopySeed;
  const rename = 'rename' in input ? input.rename : renamerOf(input);
  // A non-recursive mkdir is the proof of ownership: it succeeds only when THIS call created the directory, and the
  // identity is captured at once. A directory that was already there belongs to someone else.
  try {
    // The worktree root is not what this call owns: creating it keeps the recursive mkdir this replaced.
    fs.mkdirSync(nodePath.dirname(targetDir), { recursive: true });
  } catch {
    // A root this call cannot create makes the copy below fail, exactly as it did before.
  }
  let dirIdentity;
  try {
    fs.mkdirSync(targetDir);
    dirIdentity = identityOf(fs, targetDir);
  } catch (error) {
    // This call did not create the directory, so it must not publish into it, whatever the reason it failed:
    //   - EEXIST: another actor owns it. With an index already readable in it that is the module's "someone else's
    //     index is there" outcome; a bare or unreadable directory is simply a failed seed.
    //   - any other failure: there is no directory of this call's to publish into.
    // Both fail closed: nothing is written, synced or removed.
    if (error && error.code === 'EEXIST' && identityOf(fs, target).state === 'present' && typeof input.onJoined === 'function') {
      try {
        input.onJoined();
      } catch {
        // Reporting the join is never worth failing a seed that published nothing.
      }
    }
    return false;
  }
  const abandon = () => {
    try {
      // Nothing is removed from a directory this call cannot prove is still the one it created: a foreign one belongs
      // to another actor, and an UNKNOWN reading (a failed stat) proves neither way, so it fails closed and removes
      // nothing — not the staging file, not the directory.
      if (!sameIdentity(identityOf(fs, targetDir), dirIdentity)) return;
      fs.rmSync(staged, { force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch {
      // Nothing left to remove.
    }
  };
  try {
    if (!copy(source, staged)) {
      abandon();
      return false;
    }
    if (!isPlausibleIndex(fs, staged)) {
      abandon();
      return false;
    }
    publishStagedCopy(fs, staged, target, rename);
    if (typeof input.onPublished === 'function') {
      try {
        input.onPublished({ dir: dirIdentity, db: identityOf(fs, target) });
      } catch {
        // Reporting the identity is never worth failing a seed that was published.
      }
    }
    return true;
  } catch {
    abandon();
    return false;
  }
}

/**
 * Rolls back the seed this call published — and only that, and only on a positive reading. The directory must still be
 * the very one this session created, and the database must be either still the one it published or positively gone
 * (ENOENT). A database that differs, and one whose identity is UNKNOWN because its stat failed, both keep everything:
 * unknown never authorizes a removal. Never throws; reports whether anything was removed.
 */
function removePublishedSeed(fs, cwd, identity = {}) {
  const targetDir = nodePath.join(cwd, '.codegraph');
  const target = nodePath.join(targetDir, 'codegraph.db');
  try {
    if (!sameIdentity(identityOf(fs, targetDir), identity.dir)) return false;
    // The database is removed only when it is provably the one this session published; a positively absent one is no
    // protection at all. A foreign one, or one that cannot be read, is left where it is — with its directory.
    const published = identityOf(fs, target);
    if (!sameIdentity(published, identity.db) && !isPositivelyAbsent(published)) return false;
    fs.rmSync(targetDir, { recursive: true, force: true });
    return true;
  } catch {
    // A rollback that cannot finish is not worth turning into a different outcome: the seed is unconfirmed either way.
    return false;
  }
}

/**
 * Seeds the unindexed linked worktrees of one repository, each one under its own index lock, exactly like the
 * per-directory seed: a worktree whose index another session is writing is left alone, a fresh decision is taken once
 * the lock is held, and a failed copy leaves nothing behind. The main checkout is never seeded (it is not a worktree).
 * Never throws.
 */
function seedLinkedWorktrees(input = {}) {
  const fs = fsOf(input);
  const exists = typeof input.exists === 'function' ? input.exists : (p) => fs.existsSync(p);
  const lock = input.lock === undefined ? realInitLock : (input.lock || undefined);
  // Without an explicit source check the main checkout's own lock decides, exactly as the create path does.
  const sourceBusy = typeof input.sourceBusy === 'function' ? input.sourceBusy : (root) => lock?.isHeld(root) ?? false;
  const copy = typeof input.copy === 'function' ? input.copy : defaultCopySeed;
  const result = { seeded: [], skipped: [] };
  for (const root of Array.isArray(input.worktrees) ? input.worktrees : []) {
    try {
      const found = worktreeOf(root, { fs });
      if (!found.worktree) continue; // The main checkout and anything not linked is not our business here.
      if (exists(nodePath.join(root, '.codegraph'))) {
        result.skipped.push({ worktree: root, reason: 'already has an index' });
        continue;
      }
      const attempt = lock?.acquire(root, { kind: 'init' });
      if (attempt?.status === 'busy') {
        result.skipped.push({ worktree: root, reason: "another session is writing this worktree's index" });
        continue;
      }
      try {
        // Judged again under the lock: another session may have seeded it while this one waited.
        if (exists(nodePath.join(root, '.codegraph'))) {
          result.skipped.push({ worktree: root, reason: 'already has an index' });
          continue;
        }
        if (sourceBusy(found.commonRoot)) {
          result.skipped.push({ worktree: root, reason: "the main checkout's index is being written" });
          continue;
        }
        let joined = false;
        const seeded = seedWorktreeIndex({
          worktree: root,
          commonRoot: found.commonRoot,
          sourceBusy: () => sourceBusy(found.commonRoot),
          copy,
          rename: renamerOf(input),
          fs,
          onJoined: () => {
            joined = true;
          },
        });
        if (seeded) result.seeded.push(nodePath.join(root, '.codegraph', 'codegraph.db'));
        else if (joined) result.skipped.push({ worktree: root, reason: 'already has an index' });
        else result.skipped.push({ worktree: root, reason: 'the seed copy failed' });
      } finally {
        attempt?.release();
      }
    } catch (error) {
      result.skipped.push({ worktree: root, reason: `unexpected: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}

/**
 * The linked worktrees of the repository `cwd` belongs to, from one `git worktree list` through the async runner
 * (never a blocking one). A `list` seam that answers a porcelain text or a path list replaces the git read; a
 * directory that is not a Git repository, or a git that cannot answer, yields nothing instead of throwing.
 */
async function linkedWorktrees(input = {}) {
  try {
    const repoRootFound = worktreeOf(input.cwd, { fs: input.fs });
    const repoRoot = repoRootFound.worktree ? repoRootFound.commonRoot : input.cwd;
    const listed = typeof input.list === 'function'
      ? await input.list(repoRoot)
      : (await listWorktreesAsync(repoRoot, { runAsync: input.runAsync, timeoutMs: input.timeoutMs })).map((entry) => entry.path);
    if (Array.isArray(listed)) return listed.filter((entry) => typeof entry === 'string' && entry.length > 0);
    if (typeof listed !== 'string') return [];
    return listed
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter((root) => root.length > 0);
  } catch {
    return [];
  }
}

// ---- The coordinated sync (S3) ----

/** The honest reading of one coordination result: only a run that came back is `synced`. */
function coordinatedSyncOutcome(outcome) {
  if (outcome.status === 'ran') return outcome.ok ? 'synced' : 'failed';
  if (outcome.status === 'coalesced') return 'coalesced';
  if (outcome.status === 'queued') return 'pending';
  return 'unavailable';
}

/** The honest reading of one attempt made under the index lock alone, with no lease to wait on. */
function attemptOutcome(attempt) {
  if (!attempt.ran) return 'pending';
  return attempt.ok ? 'synced' : 'failed';
}

/**
 * One sync attempt under the coordination. It takes the package's index lock for the whole run, so an init can never
 * begin in the middle of a sync: the lock is taken, not merely observed, which is what closes the window between
 * deciding to sync and starting it. When an init (or any other writer of this package) holds the lock, nothing runs
 * and the request stays pending instead of being dropped. The process it starts is reported to `onSpawn`, so the
 * coordination can tell a run that ended from one that outlived its session.
 */
async function runSyncAttempt(input, onSpawn) {
  const attempt = input.lock?.acquire(input.cwd, { kind: 'sync' });
  if (attempt?.status === 'busy') return { ran: false };
  const adopt = attempt?.status === 'acquired' ? attempt.adopt : () => {};
  try {
    const ok = await input.run(['sync', '-q'], input.cwd, SYNC_TIMEOUT_MS, (pid, options) => {
      try {
        adopt(pid, options);
      } catch {
        // Recording the pid is never worth failing the sync.
      }
      try {
        if (typeof onSpawn === 'function') onSpawn(pid, options);
      } catch {
        // The coordination record is never worth failing the sync.
      }
    });
    return { ran: true, ok };
  } finally {
    attempt?.release();
  }
}

/** One coordinated sync with resolved seams: the lease decides whether this session runs it or joins a follow-up. */
async function coordinatedSync(input) {
  const attempt = (onSpawn) => runSyncAttempt({ cwd: input.project, lock: input.lock, run: input.run }, onSpawn);
  if (!input.sync || typeof input.sync.request !== 'function') return attemptOutcome(await attempt(() => {}));
  return coordinatedSyncOutcome(await input.sync.request(input.project, attempt));
}

/** Asks the coordination for one sync of `project` and reports what it achieved, never overstating it. */
async function requestCoordinatedSync(input = {}) {
  return coordinatedSync({
    project: input.project,
    sync: syncOf(input.sync),
    lock: lockOf(input.lock),
    run: input.run === undefined ? runCodegraph : input.run,
  });
}

// ---- The session's own preparation (S2) ----

/**
 * A subagent child may run in a linked git worktree of its own instead of the parent's project. There it does the
 * same background work a fresh session would: seed its own index from the main checkout's, or initialise one.
 * Everywhere else a child keeps skipping: it shares the parent's cwd and the parent already did the work.
 */
function childWorktreeNeedsIndex(input, mayWrite) {
  if (!mayWrite) return false;
  if (!worktreeOf(input.cwd, { fs: input.fs }).worktree) return false;
  if (input.exists(nodePath.join(input.cwd, '.codegraph'))) return false;
  const action = worktreeIndexAction(input.cwd, input.exists, { fs: input.fs }).action;
  return action === 'seed' || action === 'init';
}

/** Subagent children of one parent share the parent's project, and a /reload is not a new session. */
function skipsSession(input, mayWrite) {
  const child = Boolean(input.env) && input.env[CHILD_ENV] === '1';
  if (child && !childWorktreeNeedsIndex(input, mayWrite)) return true;
  return input.reason === 'reload';
}

/**
 * Brings the index of the checkout up to date, or creates it, and reports which of the four actions it took: `init`,
 * `seed`, `sync` or `none`. Never rejects, never blocks a caller that awaits it, and never claims a write another
 * session made. A joined, coalesced, queued or unavailable request is reported as exactly that.
 */
async function autoIndex(input = {}) {
  const fs = fsOf(input);
  const exists = typeof input.exists === 'function' ? input.exists : (p) => fs.existsSync(p);
  const cwd = input.cwd;
  const env = input.env || {};
  const run = typeof input.run === 'function' ? input.run : runCodegraph;
  const lock = lockOf(input.lock);
  const sync = syncOf(input.sync);
  const codegraphBusy = typeof input.codegraphBusy === 'function' ? input.codegraphBusy : (project) => codegraphWritingIndex(project);
  const mayWrite = mayWriteHere(input);
  try {
    if (!mayWrite) return { action: 'none', ok: true, skipped: 'read-only' };
    if (skipsSession({ cwd, env, reason: input.reason, exists, fs }, mayWrite)) return { action: 'none', ok: true };
    if (!cliAvailable({ hasBinary: input.hasBinary })) return { action: 'none', ok: true, skipped: 'no-cli' };
    const worktreeAction = worktreeIndexAction(cwd, exists, { fs });
    const action = worktreeAction.action;
    if (action === 'none') return { action, ok: true };
    const announce = () => {
      try {
        if (typeof input.onStart === 'function') input.onStart(action);
      } catch {
        // Telling the caller is never worth stopping the index.
      }
    };

    if (action === 'seed') {
      // Two sessions starting at once in the same worktree must not seed twice: the worktree's own init lock covers
      // the whole seed-plus-sync, exactly like a plain init.
      const attempt = lock?.acquire(cwd);
      if (attempt?.status === 'busy') return { action, ok: true, joined: true };
      const adopt = attempt?.status === 'acquired' ? attempt.adopt : () => {};
      try {
        if (exists(nodePath.join(cwd, '.codegraph'))) return { action, ok: true, joined: true };
        const commonRoot = worktreeAction.commonRoot;
        const busy = typeof input.sourceBusy === 'function' ? input.sourceBusy : (root) => lock?.isHeld(root) ?? false;
        if (busy(commonRoot)) return { action, ok: true, joined: true };
        announce();
        // The identity of what this call creates, so the rollback below can prove ownership instead of inferring it.
        let published;
        let joined = false;
        const seeded = seedWorktreeIndex({
          worktree: cwd,
          commonRoot,
          sourceBusy: () => busy(commonRoot),
          copy: typeof input.copySeed === 'function' ? input.copySeed : defaultCopySeed,
          rename: renamerOf(input),
          fs,
          onPublished: (identity) => {
            published = identity;
          },
          onJoined: () => {
            joined = true;
          },
        });
        // Another actor created the directory in the window and its index is already in it: this session publishes
        // nothing, syncs nothing, and says exactly what it says when it finds that directory under the lock.
        if (joined) return { action, ok: true, joined: true };
        if (!seeded) return { action, ok: false };
        // The seeded db reflects the main tree; the worktree's first sync reconciles it to this tree.
        let synced = false;
        try {
          synced = await run(['sync', '-q'], cwd, SYNC_TIMEOUT_MS, (pid, options) => adopt(pid, options));
        } catch {
          synced = false;
        }
        if (!synced) {
          // Nothing this session published survives a failed validation, and nothing it did not publish is touched: the
          // rollback removes only the directory and db that still carry the identity captured at creation time.
          removePublishedSeed(fs, cwd, published);
          return { action, ok: false };
        }
        return { action, ok: true };
      } finally {
        attempt?.release();
      }
    }

    if (action === 'sync') {
      // An init holds the index: nothing may touch it meanwhile, and this session leaves it to that one. A sync
      // holding it is different: the index exists, so this request is coalesced into it instead.
      if (lock?.isHeld(cwd) && (typeof lock.isInitRunning === 'function' ? lock.isInitRunning(cwd) : true)) {
        return { action, ok: true, joined: true };
      }
      announce();
      // Every write goes through the coordination: the shared lease when there is one, and always through the
      // package's index lock, so an init cannot begin in the middle of this sync (nor this one inside an init).
      const outcome = await coordinatedSync({ project: cwd, sync, lock, run });
      if (outcome === 'synced') return { action, ok: true };
      if (outcome === 'coalesced') return { action, ok: true, coalesced: true };
      if (outcome === 'pending') return { action, ok: true, queued: true };
      if (outcome === 'unavailable') return { action, ok: false, unavailable: true };
      return { action, ok: false };
    }

    const attempt = lock?.acquire(cwd);
    if (attempt?.status === 'busy') return { action, ok: true, joined: true };
    const adopt = attempt?.status === 'acquired' ? attempt.adopt : () => {};
    try {
      if (exists(nodePath.join(cwd, '.codegraph'))) {
        // Another party (another tool, a terminal) created the index while this session waited for the lock.
        return { action, ok: true, joined: true };
      }
      announce();
      // The lock records the pid of the init, so it stays held while that process lives, even after this session.
      const initialised = await run(['init', '-y'], cwd, INIT_TIMEOUT_MS, (pid, options) => adopt(pid, options));
      if (!initialised && codegraphBusy(cwd)) {
        // CodeGraph's own lock still names a live init: another party is building this index, not this session.
        return { action, ok: true, joined: true };
      }
      // A failure of this session's own init, with or without a half-built index, is a failure.
      return { action, ok: initialised };
    } finally {
      attempt?.release();
    }
  } catch {
    return { action: planIndexAction(cwd, exists), ok: false };
  }
}

/**
 * The index first, then whatever the caller warms: `lib/codegraph-index.js` runs no warm-up of its own (the daemon
 * belongs to another unit), so a caller that supplies `warm` gets it after a preparation that left an index, and one
 * that does not gets `skipped`. Never rejects.
 */
async function prepareProject(input = {}) {
  const index = await autoIndex(input);
  if (index.action !== 'none') {
    try {
      if (typeof input.onIndexed === 'function') input.onIndexed(index);
    } catch {
      // Telling the caller is never worth stopping the warm-up.
    }
  }
  // A sync that failed still leaves an index to warm; a failed init or seed leaves nothing worth warming.
  const hasIndex = !index.joined
    && (index.action === 'sync' || (index.action === 'init' && index.ok) || (index.action === 'seed' && index.ok));
  const fs = fsOf(input);
  const exists = typeof input.exists === 'function' ? input.exists : (p) => fs.existsSync(p);
  const skipped = skipsSession({ cwd: input.cwd, env: input.env || {}, reason: input.reason, exists, fs }, mayWriteHere(input));
  if (skipped || !hasIndex || typeof input.warm !== 'function') return { index, warm: 'skipped' };
  try {
    if (typeof input.onWarmStart === 'function') input.onWarmStart();
  } catch {
    // Telling the caller is never worth stopping the warm-up.
  }
  try {
    return { index, warm: (await input.warm(input.cwd)) ? 'ok' : 'failed' };
  } catch {
    return { index, warm: 'failed' };
  }
}

// ---- The observed native `init` (S3) ----

/**
 * After a native `codegraph init` came back successfully, requests exactly one coordinated sync of that checkout
 * through the package's own coordination, never a second uncoordinated `init` or `sync`. It returns `completed` only
 * for a run that really came back, `pending` for a request that is still recorded on disk, and `failed` or
 * `unavailable` otherwise; the final outcome is logged even when the bounded wait already returned `pending`.
 * Never throws.
 */
async function syncAfterNativeInit(input = {}) {
  const started = Date.now();
  const exists = typeof input.exists === 'function' ? input.exists : (p) => nodeFs.existsSync(p);
  const log = (outcome) => {
    try {
      if (typeof input.log === 'function') input.log({ cwd: input.cwd, outcome, ms: Date.now() - started });
    } catch {
      // A log is never worth failing the tool call.
    }
  };
  try {
    if (!mayWriteHere(input)) return 'skipped-read-only';
    if (!exists(nodePath.join(input.cwd, '.codegraph'))) {
      // A successful init that left no index gives nothing to sync, and syncing a missing index would fail.
      log('init-sync-failed');
      return 'failed';
    }
    const request = coordinatedSync({
      project: input.cwd,
      sync: syncOf(input.sync),
      lock: lockOf(input.lock),
      run: input.run === undefined ? runCodegraph : input.run,
    });
    // The request keeps going after the wait below; its real outcome is what gets logged, once.
    const settled = request.then(
      (value) => {
        log(`init-sync-${value}`);
        return value;
      },
      () => {
        log('init-sync-failed');
        return 'failed';
      },
    );
    const waitMs = Math.max(1, Number.isFinite(input.waitMs) ? input.waitMs : POST_INIT_SYNC_WAIT_MS);
    let timer;
    const raced = await Promise.race([
      settled,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (raced === undefined) return 'pending';
    if (raced === 'synced' || raced === 'coalesced') return 'completed';
    if (raced === 'pending') return 'pending';
    if (raced === 'unavailable') return 'unavailable';
    return 'failed';
  } catch {
    return 'failed';
  }
}

// ---- The notices (S2, S3) ----

/** Nearest directory at or above `cwd` holding `.codegraph/codegraph.db`. */
function findIndexRoot(cwd, exists = (p) => nodeFs.existsSync(p)) {
  for (let dir = nodePath.resolve(cwd); ;) {
    if (exists(nodePath.join(dir, '.codegraph', 'codegraph.db'))) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The session's tools: the selected ones plus, in a subagent child, the ones the host requested for it. The MCP
 * tools are not in `selectedTools` yet when the prompt is built, so the requested list counts there too.
 */
function noticeTools(selectedTools, requestedEnv, child) {
  const selected = Array.isArray(selectedTools) ? selectedTools.filter((tool) => typeof tool === 'string') : [];
  const requested = child && typeof requestedEnv === 'string'
    ? requestedEnv.split(',').map((tool) => tool.trim()).filter(Boolean)
    : [];
  return [...new Set([...selected, ...requested])];
}

/**
 * What the index preparation is doing, said before it starts. Create-or-sync is one policy, and the wording names
 * which of the three actions this session took: an init, a worktree seed, or a sync of an existing index.
 */
function indexStartNotice(action) {
  if (action === 'init') return 'creating the CodeGraph index of this project...';
  if (action === 'seed') return "seeding this worktree's CodeGraph index from the main repo's index...";
  return 'syncing the CodeGraph index...';
}

/**
 * How one index preparation ended, in honest terms. Only a run of this session that came back can be called synced or
 * created: a joined, coalesced, queued or unavailable request is reported as what it is, and a failed command is
 * never presented as a current index.
 */
function indexOutcomeNotice(result, cwd) {
  if (result.joined) {
    return {
      text: result.action === 'init'
        ? 'another session is creating the CodeGraph index of this project'
        : "another session is writing this project's CodeGraph index; this session did not sync it",
      level: 'info',
    };
  }
  if (result.coalesced) return { text: "another session's run completed the CodeGraph index sync requested here", level: 'info' };
  if (result.queued) return { text: 'the CodeGraph index sync is queued, not run yet: it waits for the index to be free', level: 'info' };
  if (result.unavailable) return { text: `could not coordinate the CodeGraph index sync in ${cwd}; no sync was started`, level: 'warning' };
  if (!result.ok) return { text: `codegraph ${result.action} failed in ${cwd}; the index is not up to date`, level: 'warning' };
  if (result.action === 'init') return { text: 'CodeGraph index created', level: 'info' };
  if (result.action === 'seed') return { text: 'CodeGraph index seeded from the main repo and synced', level: 'info' };
  return { text: 'CodeGraph index synced', level: 'info' };
}

/** The warm-up's outcome, kept apart from the index's: a warm daemon says nothing about the index. */
function warmOutcomeNotice(outcome, cwd) {
  return outcome === 'ok'
    ? { text: 'CodeGraph ready', level: 'info' }
    : { text: `CodeGraph warm-up failed in ${cwd}`, level: 'warning' };
}

/** Whether this finished call was a successful native `codegraph init`: the one call the hook observes. */
function isNativeInitResult(event) {
  return Boolean(event)
    && event.toolName === NATIVE_CODEGRAPH_TOOL
    && Boolean(event.input) && event.input.operation === 'init'
    && event.isError === false;
}

/**
 * What the post-`init` hook does with one finished tool call: only a successful native `codegraph init` is followed
 * by the package's own coordinated sync; a failed init keeps its original error and triggers nothing.
 */
function initHookDecision(event, role) {
  if (!event || event.toolName !== NATIVE_CODEGRAPH_TOOL || !event.input || event.input.operation !== 'init') return 'skip-not-a-native-init';
  if (event.isError) return 'skip-failed-init';
  if (!mayInitiateIndexWrite(role)) return 'skip-read-only';
  return 'sync';
}

/**
 * The line the hook appends to the tool's own result. A completed sync appends
 * nothing at all (S4): the tool's own content is the whole answer. Only a sync that
 * did NOT complete earns one short line, and it never calls an unconfirmed index
 * current — no plugin prefix, no second paragraph, and never the word `completed`.
 */
function postInitSyncNotice(outcome) {
  if (outcome === 'completed') return undefined;
  if (outcome === 'pending') return 'CodeGraph index sync pending; this index is not confirmed current.';
  if (outcome === 'unavailable') return 'CodeGraph index sync could not start; this index is not confirmed current.';
  if (outcome === 'skipped-read-only') return 'CodeGraph index sync skipped (read-only session); this index is not confirmed current.';
  return 'CodeGraph index sync failed; this index may be behind.';
}

module.exports = {
  CHILD_ENV,
  INIT_PROJECT_MARKERS,
  INIT_TIMEOUT_MS,
  KILL_ESCALATION_MS,
  KILL_WAIT_MS,
  NATIVE_CODEGRAPH_TOOL,
  POST_INIT_SYNC_WAIT_MS,
  SYNC_TIMEOUT_MS,
  attemptOutcome,
  autoIndex,
  binaryOnPath,
  cliAvailable,
  codegraphWritingIndex,
  coordinatedSyncOutcome,
  findIndexRoot,
  indexOutcomeNotice,
  indexStartNotice,
  initHookDecision,
  isNativeInitResult,
  linkedWorktrees,
  noticeTools,
  planIndexAction,
  postInitSyncNotice,
  prepareProject,
  requestCoordinatedSync,
  runCodegraph,
  runSyncAttempt,
  seedLinkedWorktrees,
  seedWorktreeIndex,
  syncAfterNativeInit,
  warmOutcomeNotice,
  worktreeIndexAction,
  worktreeOf,
};

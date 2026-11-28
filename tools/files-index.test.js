'use strict';
// T1 (files-picker S6, S13, S16) tests: lib/files-index.js — the Git listing,
// each file's change state with its age, and the bounded preview reader.
//
// The public surface only: the exact argv the injected runner receives, the
// classification of a changed file (a .gitignore'd file never appears because Git
// is asked for the standard exclude set), the recency order and the age labels,
// and the preview's text / truncation / binary / error paths against real
// temporary files. Every Git read goes through the fake runner below, EXCEPT the
// two tests under "against real Git": those spawn Git in a scratch repository,
// because an ambiguous ref and a partial clone's lazy fetch are properties no
// fake answer can express. No network is touched, and every temporary directory
// lives under os.tmpdir() and is removed in after().

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  listRepositoryEntries,
  listRepositoryFiles,
  readFilePreview,
  formatAge,
  FILE_PREVIEW_LIMITS,
  FILE_PREVIEW_BINARY_NOTICE,
} = require('../lib/files-index.js');

const LIST_ARGV = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
const STATUS_ARGV = ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'];
const ROOT_ARGV = ['rev-parse', '--show-toplevel'];

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const scratch = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-index-'));
  scratch.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function setMtime(full, mtimeMs) {
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
}

// The seam: `run(args, opts)` answering the `runArgvAsync` result shape, with
// every call recorded so a test can state the argv and the options it saw.
function fakeRunner(answer) {
  const calls = [];
  const run = async (args, opts) => {
    calls.push({ args: [...args], opts });
    const reply = answer(args, opts, calls.length);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
}

function gitAnswer({ listing = '', status = '', root } = {}) {
  return (args) => {
    if (args[0] === 'ls-files') return { status: 0, stdout: listing, stderr: '' };
    if (args[0] === '--no-optional-locks') return { status: 0, stdout: status, stderr: '' };
    if (args[0] === 'rev-parse') {
      return { status: root === undefined ? 128 : 0, stdout: root === undefined ? '' : `${root}\n`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected argv' };
  };
}

function pairs(entries) {
  return entries.map((entry) => [entry.path, entry.state]);
}

// --- the listing -----------------------------------------------------------

test('the listing is one fixed git ls-files argv asking for stdin-free, unquoted paths', async () => {
  const { run, calls } = fakeRunner(() => ({ status: 0, stdout: 'b.js\0a.ts\0b.js\0', stderr: '' }));

  const listed = await listRepositoryFiles({ run, cwd: '/repo' });

  assert.deepEqual(listed, { ok: true, files: ['a.ts', 'b.js'] }, 'duplicates collapse and paths sort by code unit');
  assert.equal(calls.length, 1, 'one bounded process, not one per file');
  assert.deepEqual(calls[0].args, LIST_ARGV);
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.equal(typeof calls[0].opts.timeoutMs, 'number');
  assert.ok(calls[0].opts.timeoutMs > 0 && calls[0].opts.timeoutMs <= 60_000, 'every git read is bounded');
});

test('a .gitignore\'d file is absent: Git is asked for the tracked files plus the not-ignored ones', async () => {
  // Git answers the listing below: the tracked file, the untracked one it does
  // not ignore, and NOT dist/bundle.js, which .gitignore covers. That answer is
  // the whole .gitignore contract — the module never parses the ignore file.
  const { run, calls } = fakeRunner(() => ({ status: 0, stdout: 'src/a.ts\0notes.txt\0', stderr: '' }));

  const listed = await listRepositoryFiles({ run, cwd: '/repo' });

  assert.deepEqual(listed, { ok: true, files: ['notes.txt', 'src/a.ts'] });
  assert.ok(listed.files.every((file) => file !== 'dist/bundle.js'), 'the ignored file is not in the list');
  assert.ok(calls[0].args.includes('--others'), 'untracked files are listed');
  assert.ok(calls[0].args.includes('--exclude-standard'), 'untracked-but-ignored files are not');
});

test('an empty repository is a success with no file', async () => {
  const { run } = fakeRunner(() => ({ status: 0, stdout: '', stderr: '' }));
  assert.deepEqual(await listRepositoryFiles({ run, cwd: '/repo' }), { ok: true, files: [] });
});

test('a failed listing is a failure sentence, never an empty success', async () => {
  const { run } = fakeRunner(() => ({ status: 1, stdout: '', stderr: 'fatal: bad revision\nsecond line' }));

  assert.deepEqual(await listRepositoryFiles({ run, cwd: '/repo' }), {
    ok: false,
    message: 'Cannot list repository files: fatal: bad revision.',
  });
});

test('outside a Git repository the sentence a panel paints says exactly that', async () => {
  const { run } = fakeRunner(() => ({
    status: 128,
    stdout: '',
    stderr: 'fatal: not a git repository (or any of the parent directories): .git',
  }));

  assert.deepEqual(await listRepositoryFiles({ run, cwd: '/tmp/not-a-repo' }), {
    ok: false,
    message: 'Not a Git repository: /tmp/not-a-repo.',
  });
});

test('a runner that rejects and one that answers a spawn error both become sentences', async () => {
  const rejected = fakeRunner(() => new Error('boom'));
  assert.deepEqual(await listRepositoryFiles({ run: rejected.run, cwd: '/repo' }), {
    ok: false,
    message: 'Cannot list repository files: boom.',
  });

  const unspawnable = fakeRunner(() => ({ status: null, stdout: '', stderr: '', error: 'spawn git ENOENT' }));
  assert.deepEqual(await listRepositoryFiles({ run: unspawnable.run, cwd: '/repo' }), {
    ok: false,
    message: 'Cannot list repository files: spawn git ENOENT.',
  });
});

test('no runner at all is a sentence, not a throw', async () => {
  assert.deepEqual(await listRepositoryFiles({ cwd: '/repo' }), {
    ok: false,
    message: 'Cannot list repository files: no Git runner was supplied.',
  });
});

// --- entries: state, recency and age --------------------------------------

test('changed files come first — untracked as new, dirty as modified, newest first — then the clean ones by path', async () => {
  const root = tempDir();
  const now = Date.parse('2024-05-01T12:00:00Z');
  const dirty = writeFile(root, 'src/a.ts', 'export const a = 1;\n');
  setMtime(dirty, now - 3 * HOUR);
  const untracked = writeFile(root, 'notes.md', 'notes\n');
  setMtime(untracked, now - 42_000);
  writeFile(root, 'src/b.js', 'b\n');
  writeFile(root, 'src/clean.ts', 'clean\n');

  const { run, calls } = fakeRunner(gitAnswer({
    listing: 'src/a.ts\0src/b.js\0notes.md\0src/clean.ts\0',
    status: ' M src/a.ts\0?? notes.md\0',
    root,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now });

  assert.deepEqual(pairs(result.entries), [
    ['notes.md', 'new'],
    ['src/a.ts', 'modified'],
    ['src/b.js', 'clean'],
    ['src/clean.ts', 'clean'],
  ]);
  assert.deepEqual(calls.map((call) => call.args), [LIST_ARGV, STATUS_ARGV, ROOT_ARGV],
    'the three reads are the fixed argv, in that order');
  assert.ok(calls.every((call) => call.opts.cwd === '/repo'), 'every read runs in the browsed checkout');

  const newest = result.entries[0];
  assert.equal(newest.mtimeMs, fs.statSync(untracked).mtimeMs, 'the mtime is a stat under the root Git reported');
  assert.equal(newest.age, formatAge(fs.statSync(untracked).mtimeMs, now));
  assert.match(newest.age, /^\d+s$/);
  const older = result.entries[1];
  assert.equal(older.mtimeMs, fs.statSync(dirty).mtimeMs);
  assert.equal(older.age, formatAge(fs.statSync(dirty).mtimeMs, now));
  assert.match(older.age, /^\d+h$/);
  assert.deepEqual(result.entries[2], { path: 'src/b.js', state: 'clean' }, 'a clean row carries no time');
  assert.deepEqual(result.entries[3], { path: 'src/clean.ts', state: 'clean' });
});

test('the age is computed from the injected now, so the panel fixes it at open', async () => {
  const root = tempDir();
  const changed = writeFile(root, 'src/a.ts', 'x\n');
  const mtimeMs = fs.statSync(changed).mtimeMs;
  const plan = gitAnswer({ listing: 'src/a.ts\0', status: ' M src/a.ts\0', root });

  const recent = await listRepositoryEntries({ run: fakeRunner(plan).run, cwd: '/repo', now: mtimeMs + 90_000 });
  assert.equal(recent.entries[0].age, '1m');

  const stale = await listRepositoryEntries({ run: fakeRunner(plan).run, cwd: '/repo', now: mtimeMs + 2 * DAY });
  assert.equal(stale.entries[0].age, '2d');
});

test('ties break by path, so the order is stable', async () => {
  const root = tempDir();
  const stamp = Date.now() - HOUR;
  setMtime(writeFile(root, 'zeta.ts', 'z\n'), stamp);
  setMtime(writeFile(root, 'alpha.ts', 'a\n'), stamp);

  const { run } = fakeRunner(gitAnswer({
    listing: 'zeta.ts\0alpha.ts\0',
    status: '?? zeta.ts\0?? alpha.ts\0',
    root,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: stamp });
  assert.deepEqual(pairs(result.entries), [['alpha.ts', 'new'], ['zeta.ts', 'new']]);
});

test('an unreadable root or a file that is not on disk removes the age instead of the row', async () => {
  const root = tempDir();
  const present = writeFile(root, 'present.ts', 'p\n');
  const { run } = fakeRunner(gitAnswer({
    listing: 'present.ts\0gone.ts\0',
    status: ' M present.ts\0 D gone.ts\0',
    root,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: Date.now() });

  assert.deepEqual(pairs(result.entries), [['present.ts', 'modified'], ['gone.ts', 'modified']],
    'the timed change comes first, the untimed one after');
  assert.equal(typeof result.entries[0].mtimeMs, 'number');
  assert.deepEqual(result.entries[1], { path: 'gone.ts', state: 'modified' }, 'no timestamp, no age');

  const noRoot = fakeRunner(gitAnswer({ listing: 'present.ts\0', status: ' M present.ts\0', root: undefined }));
  const withoutRoot = await listRepositoryEntries({ run: noRoot.run, cwd: '/repo', now: Date.now() });
  assert.deepEqual(pairs(withoutRoot.entries), [['present.ts', 'modified']], 'a failed rev-parse is not a failed listing');
  assert.deepEqual(withoutRoot.entries[0], { path: 'present.ts', state: 'modified' });
});

test('a rename record skips its original path field', async () => {
  const { run } = fakeRunner(gitAnswer({
    listing: 'src/new.ts\0src/old.ts\0',
    status: 'R  src/new.ts\0src/old.ts\0',
    root: undefined,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: Date.now() });
  assert.deepEqual(pairs(result.entries), [['src/new.ts', 'modified'], ['src/old.ts', 'clean']],
    'the original path is not a record of its own, so it is not marked changed');
});

test('no changed file means the root is never resolved', async () => {
  const { run, calls } = fakeRunner(gitAnswer({ listing: 'a.ts\0b.ts\0', status: '', root: undefined }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: Date.now() });

  assert.deepEqual(pairs(result.entries), [['a.ts', 'clean'], ['b.ts', 'clean']]);
  assert.deepEqual(calls.map((call) => call.args), [LIST_ARGV, STATUS_ARGV]);
});

test('a failed status is a sentence, never a half listing', async () => {
  // The listing succeeds and only the status read fails, so the sentence names
  // the change read and no rows are painted from half the information.
  const failingStatus = (stderr) => fakeRunner((args) => {
    if (args[0] === 'ls-files') return { status: 0, stdout: 'a.ts\0', stderr: '' };
    return { status: 128, stdout: '', stderr };
  });

  const generic = failingStatus('fatal: index file smaller than expected');
  assert.deepEqual(await listRepositoryEntries({ run: generic.run, cwd: '/repo', now: 0 }), {
    ok: false,
    message: 'Cannot read repository changes: fatal: index file smaller than expected.',
  });

  const outside = failingStatus('fatal: not a git repository (or any of the parent directories): .git');
  assert.deepEqual(await listRepositoryEntries({ run: outside.run, cwd: '/repo', now: 0 }), {
    ok: false,
    message: 'Not a Git repository: /repo.',
  });
});

test('every Git read is a fixed read-only argv: nothing stages, commits or checks out', async () => {
  const root = tempDir();
  const { run, calls } = fakeRunner(gitAnswer({
    listing: 'src/a.ts\0',
    status: ' M src/a.ts\0',
    root,
  }));

  await listRepositoryEntries({ run, cwd: '/repo', now: Date.now() });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(Array.isArray(call.args) && call.args.every((entry) => typeof entry === 'string'), 'fixed argv, never a shell string');
    const verb = call.args[0] === '--no-optional-locks' ? call.args[1] : call.args[0];
    assert.ok(['ls-files', 'status', 'rev-parse'].includes(verb), `read-only read: ${verb}`);
  }
  assert.ok(calls[1].args.includes('--no-optional-locks'), 'status may not write the index back');
});

// --- a worktree scope: the branch's own commits (S2-S5) --------------------

// The one read a worktree scope adds: the NET name-status record of what the
// branch changed against the merge-base with the principal branch. Three dots,
// so a `main` that moved on since the fork is not read as the branch's work.
// A bare ref would be ambiguous the moment a tag shares its name, and a file
// named `<ref>...HEAD` would break the read, so the branch is qualified and the
// argument list is closed with `--`. `--no-renames` is what keeps the read
// read-only in a partial clone.
const COMMIT_ARGV = (comparison) => [
  'diff',
  '--name-status',
  '-z',
  '--no-renames',
  `refs/heads/${comparison}...HEAD`,
  '--',
];

function worktreeAnswer({ listing = '', commits = '', status = '', root } = {}) {
  return (args) => {
    if (args[0] === 'ls-files') return { status: 0, stdout: listing, stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: commits, stderr: '' };
    if (args[0] === '--no-optional-locks') return { status: 0, stdout: status, stderr: '' };
    if (args[0] === 'rev-parse') {
      return { status: root === undefined ? 128 : 0, stdout: root === undefined ? '' : `${root}\n`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected argv' };
  };
}

test('a worktree scope marks the branch\'s commits, one row per path, and keeps its uncommitted work', async () => {
  const root = tempDir();
  const now = Date.parse('2024-05-01T12:00:00Z');
  setMtime(writeFile(root, 'a.txt', 'three\n'), now - 4 * HOUR);
  setMtime(writeFile(root, 'added.txt', 'new\n'), now - 3 * HOUR);
  setMtime(writeFile(root, 'src/moved.txt', 'deep\n'), now - 2 * HOUR);
  setMtime(writeFile(root, 'u.txt', 'untracked\n'), now - HOUR);
  writeFile(root, 'clean.ts', 'clean\n');

  const { run, calls } = fakeRunner(worktreeAnswer({
    listing: 'a.txt\0added.txt\0src/moved.txt\0clean.ts\0u.txt\0',
    // The branch modified one file, added one, deleted one, renamed one.
    commits: 'M\0a.txt\0A\0added.txt\0D\0b.txt\0R100\0src/deep.txt\0src/moved.txt\0',
    // `a.txt` is dirty on top of its commit, and `u.txt` was never committed.
    status: ' M a.txt\0?? u.txt\0',
    root,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now, comparison: 'main' });

  assert.deepEqual(pairs(result.entries), [
    ['u.txt', 'new'],
    ['src/moved.txt', 'added'],
    ['added.txt', 'added'],
    ['a.txt', 'modified'],
    ['clean.ts', 'clean'],
  ]);
  assert.deepEqual(calls.map((call) => call.args), [LIST_ARGV, COMMIT_ARGV('main'), STATUS_ARGV, ROOT_ARGV],
    'the commit read sits between the listing and the status, one fixed argv each');
  assert.ok(calls.every((call) => call.opts.cwd === '/repo'), 'every read runs in the browsed checkout');

  assert.equal(result.entries.filter((entry) => entry.path === 'a.txt').length, 1,
    'a path named by a commit and again by status is one row');
  assert.equal(result.entries.find((entry) => entry.path === 'a.txt').state, 'modified',
    'the commit state wins over the dirty one, and both read M');
  assert.equal(result.entries.some((entry) => entry.path === 'b.txt'), false, 'a deleted file is never listed');
  assert.equal(result.entries.some((entry) => entry.path === 'src/deep.txt'), false,
    'a rename\'s original path is not a row of its own');
  assert.equal(result.entries[1].age, formatAge(fs.statSync(path.join(root, 'src/moved.txt')).mtimeMs, now),
    'a committed row keeps the same age label as any other');
});

test('the comparison is the caller\'s, carried verbatim into the one diff read', async () => {
  const { run, calls } = fakeRunner(worktreeAnswer({ listing: 'a.ts\0', commits: 'A\0a.ts\0' }));

  await listRepositoryEntries({ run, cwd: '/repo', now: 0, comparison: 'trunk' });

  assert.deepEqual(calls[1].args, COMMIT_ARGV('trunk'),
    'the principal branch is the caller\'s, whatever the repository calls it');
});

test('an empty comparison is the status read alone, exactly as the main scope reads', async () => {
  const { run, calls } = fakeRunner(gitAnswer({
    listing: 'a.ts\0b.ts\0',
    status: '?? b.ts\0',
    root: undefined,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: 0, comparison: '' });

  assert.deepEqual(pairs(result.entries), [['b.ts', 'new'], ['a.ts', 'clean']]);
  assert.deepEqual(calls.map((call) => call.args), [LIST_ARGV, STATUS_ARGV, ROOT_ARGV],
    'no comparison asks Git nothing about commits');
});

test('a path the branch deleted and the working tree recreated is untracked, never a deleted row', async () => {
  const { run } = fakeRunner(worktreeAnswer({
    listing: 'gone.ts\0',
    commits: 'D\0gone.ts\0',
    status: '?? gone.ts\0',
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: 0, comparison: 'main' });

  assert.deepEqual(pairs(result.entries), [['gone.ts', 'new']],
    'the file exists and Git does not track it, so the row is the honest one');
});

test('a copy record names its new path only', async () => {
  const { run } = fakeRunner(worktreeAnswer({
    listing: 'src/copy.ts\0src/orig.ts\0',
    // Git writes the ORIGINAL path first and the path the record is about second
    // (verified against `git diff --name-status -z -M -C --find-copies-harder`).
    commits: 'C100\0src/orig.ts\0src/copy.ts\0M\0src/orig.ts\0',
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: 0, comparison: 'main' });

  assert.deepEqual(pairs(result.entries), [['src/copy.ts', 'added'], ['src/orig.ts', 'modified']],
    'the copy is new at its own path; the original keeps the state its own record gives it');
});

test('a failed commit read is a sentence, never a half listing', async () => {
  const { run, calls } = fakeRunner((args) => {
    if (args[0] === 'ls-files') return { status: 0, stdout: 'a.ts\0', stderr: '' };
    if (args[0] === 'diff') return { status: 128, stdout: '', stderr: "fatal: ambiguous argument 'main...HEAD'" };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.deepEqual(await listRepositoryEntries({ run, cwd: '/repo', now: 0, comparison: 'main' }), {
    ok: false,
    message: "Cannot read the branch's commits: fatal: ambiguous argument 'main...HEAD'.",
  });
  assert.deepEqual(calls.map((call) => call.args[0]), ['ls-files', 'diff'],
    'the status read never runs once the commit read failed');
});

// --- against real Git ------------------------------------------------------
//
// The only two properties a fake answer cannot express: an ambiguous ref, and a
// read that must write nothing to the repository (a partial clone is where `-M`
// used to fetch the missing merge-base blob and leave a pack behind).

// A real Git runner with the injected runner's signature, over a scratch
// repository whose configuration is this test's alone: no system config, no
// global config, and a temporary HOME.
function realGit(root) {
  const home = tempDir();
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ALLOW_PROTOCOL: 'file',
  };
  const run = (args, opts = {}, extra = {}) => spawnSync('git', args, {
    cwd: opts.cwd === undefined ? root : opts.cwd,
    timeout: opts.timeoutMs === undefined ? 15_000 : opts.timeoutMs,
    encoding: 'utf8',
    env: { ...env, ...extra },
  });
  const git = (...args) => {
    const result = run(args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${String(result.stderr)}`);
    return String(result.stdout).trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Files Test');
  git('config', 'user.email', 'files@example.invalid');
  return { git, run };
}

test('S2: a tag or a file spelled like the revision cannot shadow the principal branch', async () => {
  const root = tempDir();
  const { git, run } = realGit(root);
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('checkout', '-qb', 'feature');
  writeFile(root, 'added.txt', 'branch addition\n');
  git('add', '.');
  git('commit', '-qm', 'feature');

  // A tag on the tip: a bare `main` would resolve to it and answer "no changes".
  git('tag', 'main');
  const tagged = await listRepositoryEntries({ run, cwd: root, now: 0, comparison: 'main' });
  assert.equal(tagged.ok, true, tagged.message);
  assert.equal(tagged.entries.find((entry) => entry.path === 'added.txt').state, 'added',
    'the local branch is read, never the tag that shares its name');

  // An ordinary file whose name spells the whole revision: Git would read it as a
  // path and fail the entire read.
  git('tag', '-d', 'main');
  writeFile(root, 'main...HEAD', 'ordinary file\n');
  const shadowed = await listRepositoryEntries({ run, cwd: root, now: 0, comparison: 'main' });
  assert.equal(shadowed.ok, true, shadowed.message);
  assert.equal(shadowed.entries.find((entry) => entry.path === 'added.txt').state, 'added');
  assert.equal(shadowed.entries.find((entry) => entry.path === 'main...HEAD').state, 'new',
    'the file is the untracked row it is, not a broken read');
});

test('S6: marking a partial clone fetches nothing and writes no pack', async () => {
  const origin = tempDir();
  const { git, run } = realGit(origin);
  git('config', 'uploadpack.allowFilter', 'true');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const body = Array.from({ length: 200 }, (_, index) => `source line ${index}\n`).join('');
  writeFile(origin, 'source.txt', body);
  git('add', '.');
  git('commit', '-qm', 'base');
  const blob = git('rev-parse', 'main:source.txt');
  git('checkout', '-qb', 'feature');
  git('mv', 'source.txt', 'dest.txt');
  writeFile(origin, 'dest.txt', body.replace('line 199', 'line changed'));
  git('commit', '-qam', 'rename with edit');

  const clone = path.join(tempDir(), 'clone');
  const linked = path.join(tempDir(), 'linked');
  git('clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(origin).href, clone);
  const inClone = (...args) => git('-C', clone, ...args);
  inClone('branch', 'main', 'origin/main');
  inClone('worktree', 'add', '-q', '--detach', linked, 'origin/feature');

  const missing = () => run(['cat-file', '-e', blob],
    { cwd: clone, timeoutMs: 15_000 }, { GIT_NO_LAZY_FETCH: '1' }).status;
  const packs = () => fs.readdirSync(path.join(clone, '.git', 'objects', 'pack')).sort();
  assert.equal(missing(), 1, 'the merge-base blob starts absent, which is what a partial clone is');
  const before = packs();

  const result = await listRepositoryEntries({ run, cwd: linked, now: 0, comparison: 'main' });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.entries.find((entry) => entry.path === 'dest.txt').state, 'added',
    'an undetected rename still reads as the new path being added');
  assert.equal(missing(), 1, 'the read fetched nothing');
  assert.deepEqual(packs(), before, 'and wrote no pack into the clone');
});

// --- formatAge -------------------------------------------------------------

test('formatAge labels one elapsed age in s, m, h and d', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatAge(now, now), '0s');
  assert.equal(formatAge(now - 5_000, now), '5s');
  assert.equal(formatAge(now - 59_000, now), '59s');
  assert.equal(formatAge(now - MINUTE, now), '1m');
  assert.equal(formatAge(now - 59 * MINUTE, now), '59m');
  assert.equal(formatAge(now - HOUR, now), '1h');
  assert.equal(formatAge(now - 23 * HOUR, now), '23h');
  assert.equal(formatAge(now - DAY, now), '1d');
  assert.equal(formatAge(now - 30 * DAY, now), '30d');
  assert.equal(formatAge(now + 5_000, now), '0s', 'a future mtime never paints a negative age');
});

// --- the preview -----------------------------------------------------------

test('a text file previews its lines with no truncation', () => {
  const root = tempDir();
  writeFile(root, 'src/a.ts', 'one\ntwo\nthree\n');

  assert.deepEqual(readFilePreview(root, 'src/a.ts'), {
    kind: 'text',
    lines: ['one', 'two', 'three'],
    truncated: false,
  });
});

test('CRLF and a lone CR are line breaks, and a trailing newline is not a blank line', () => {
  const root = tempDir();
  writeFile(root, 'crlf.txt', 'a\r\nb\rc\nd');
  assert.deepEqual(readFilePreview(root, 'crlf.txt').lines, ['a', 'b', 'c', 'd']);

  writeFile(root, 'empty.txt', '');
  assert.deepEqual(readFilePreview(root, 'empty.txt'), { kind: 'text', lines: [], truncated: false });
});

test('the byte budget truncates explicitly, and a file of exactly the budget does not', () => {
  const root = tempDir();
  writeFile(root, 'exact.txt', 'abcdefghij');
  assert.deepEqual(readFilePreview(root, 'exact.txt', { maxBytes: 10 }), {
    kind: 'text',
    lines: ['abcdefghij'],
    truncated: false,
  });

  writeFile(root, 'over.txt', 'abcdefghijk');
  assert.deepEqual(readFilePreview(root, 'over.txt', { maxBytes: 10 }), {
    kind: 'text',
    lines: ['abcdefghij'],
    truncated: true,
  });
});

test('the line cap truncates explicitly and keeps whole lines', () => {
  const root = tempDir();
  writeFile(root, 'many.txt', 'l1\nl2\nl3\nl4\nl5\n');

  assert.deepEqual(readFilePreview(root, 'many.txt', { maxLines: 3 }), {
    kind: 'text',
    lines: ['l1', 'l2', 'l3'],
    truncated: true,
  });
});

test('a line wider than the cap ends in the ellipsis mark', () => {
  const root = tempDir();
  writeFile(root, 'wide.txt', 'abcdefghij\n');

  assert.deepEqual(readFilePreview(root, 'wide.txt', { maxLineWidth: 5 }), {
    kind: 'text',
    lines: ['abcd\u2026'],
    truncated: false,
  });
});

// S1: a per-line clip is visible in that line's own `…`; it must not claim the
// whole preview was cut short. The concrete report was
// lib/codegraph-prompt/judge.md — five lines, one of them 527 characters.
test('a file fully read reports no truncation even when one of its lines was clipped', () => {
  const root = tempDir();
  const wide = 'x'.repeat(527);
  writeFile(root, 'judge.md', `# Judge\n\n${wide}\nfour\nfive\n`);

  const preview = readFilePreview(root, 'judge.md');
  assert.equal(preview.kind, 'text');
  assert.equal(preview.lines.length, 5, 'every line of the file was read and returned');
  assert.deepEqual(preview.lines.slice(0, 2), ['# Judge', '']);
  assert.deepEqual(preview.lines.slice(3), ['four', 'five']);
  assert.equal(preview.lines[2].endsWith('\u2026'), true);
  assert.equal(preview.truncated, false, 'a clipped line is not a truncated preview');
});

// S2: the clip itself is unchanged — maxLineWidth - 1 characters plus the mark.
test('an over-wide line is clipped to maxLineWidth - 1 characters plus the mark', () => {
  const root = tempDir();
  writeFile(root, 'wide.txt', `${'x'.repeat(FILE_PREVIEW_LIMITS.maxLineWidth + 1)}\nshort\n`);

  assert.deepEqual(readFilePreview(root, 'wide.txt'), {
    kind: 'text',
    lines: [`${'x'.repeat(FILE_PREVIEW_LIMITS.maxLineWidth - 1)}\u2026`, 'short'],
    truncated: false,
  });
});

test('an override can only lower a bound, never lift it', () => {
  const root = tempDir();
  const longLine = 'x'.repeat(1_000);
  writeFile(root, 'long.txt', `${longLine}\n`);

  const raised = readFilePreview(root, 'long.txt', { maxLineWidth: 5_000 });
  assert.equal(raised.kind, 'text');
  assert.equal(raised.lines.length, 1);
  assert.equal(raised.lines[0].length, FILE_PREVIEW_LIMITS.maxLineWidth, 'the default cap still applies');
  assert.equal(raised.lines[0].endsWith('\u2026'), true);
  assert.equal(raised.truncated, false);

  const defaulted = readFilePreview(root, 'long.txt');
  assert.deepEqual(defaulted, raised);
});

test('a NUL byte is the binary notice, never bytes', () => {
  const root = tempDir();
  writeFile(root, 'image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  assert.deepEqual(readFilePreview(root, 'image.png'), { kind: 'binary', message: FILE_PREVIEW_BINARY_NOTICE });
  assert.equal(FILE_PREVIEW_BINARY_NOTICE, 'Binary file \u2014 preview not available.');
});

test('a missing file and a directory are error sentences with their code', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'folder'));

  const missing = readFilePreview(root, 'missing.ts');
  assert.equal(missing.kind, 'error');
  assert.equal(missing.message, 'Cannot read missing.ts (ENOENT).');

  const directory = readFilePreview(root, 'folder');
  assert.equal(directory.kind, 'error');
  assert.match(directory.message, /^Cannot read folder \(E[A-Z]+\)\.$/);
});

test('a path climbing out of the checkout is refused instead of read', () => {
  const root = tempDir();
  const sibling = path.join(root, '..', `files-index-outside-${process.pid}.txt`);
  writeFile(root, 'inside.txt', 'in\n');

  const climbing = readFilePreview(root, '../inside.txt');
  assert.equal(climbing.kind, 'error');
  assert.equal(climbing.message, 'Cannot read ../inside.txt: outside the checkout.');

  const absolute = readFilePreview(root, path.join(root, 'inside.txt'));
  assert.equal(absolute.kind, 'error');
  assert.match(absolute.message, /outside the checkout\.$/);

  assert.equal(fs.existsSync(sibling), false, 'nothing was created outside the checkout');
});

test('junk arguments never throw', () => {
  const root = tempDir();
  writeFile(root, 'a.txt', 'a\n');

  for (const [where, which, opts] of [
    [undefined, undefined, undefined],
    [null, null, {}],
    [root, 42, {}],
    [root, '', {}],
    ['', 'a.txt', {}],
    [root, 'a.txt', 42],
    [root, undefined, { maxBytes: 'nonsense', maxLines: -1 }],
  ]) {
    const preview = readFilePreview(where, which, opts);
    assert.ok(['text', 'error'].includes(preview.kind), `junk arguments answer a preview: ${JSON.stringify(preview)}`);
  }

  assert.deepEqual(readFilePreview(root, 'a.txt', 42), { kind: 'text', lines: ['a'], truncated: false },
    'junk options fall back to the shipped limits');
});

test('the shipped limits are the bounded constants the view paints against', () => {
  assert.deepEqual({ ...FILE_PREVIEW_LIMITS }, { maxBytes: 64 * 1024, maxLines: 200, maxLineWidth: 400 });
  assert.equal(Object.isFrozen(FILE_PREVIEW_LIMITS), true, 'a caller cannot widen the bounds by mutating the table');
  assert.equal(typeof FILE_PREVIEW_BINARY_NOTICE, 'string');
});

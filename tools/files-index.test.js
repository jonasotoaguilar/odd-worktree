'use strict';
// T1 (files-picker S6, S13, S16) tests: lib/files-index.js — the Git listing,
// each file's change state with its age, and the bounded preview reader.
//
// The public surface only: the exact argv the injected runner receives, the
// classification of untracked / dirty / clean (a .gitignore'd file never
// appears because Git is asked for the standard exclude set), the recency order
// and the age labels, and the preview's text / truncation / binary / error paths
// against real temporary files. No child process is spawned and no network is
// touched: every Git read goes through the fake runner below, and the temporary
// directories live under os.tmpdir() and are removed in after().

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('changed files come first — untracked as new, dirty as updated, newest first — then the clean ones by path', async () => {
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
    ['src/a.ts', 'updated'],
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

  assert.deepEqual(pairs(result.entries), [['present.ts', 'updated'], ['gone.ts', 'updated']],
    'the timed change comes first, the untimed one after');
  assert.equal(typeof result.entries[0].mtimeMs, 'number');
  assert.deepEqual(result.entries[1], { path: 'gone.ts', state: 'updated' }, 'no timestamp, no age');

  const noRoot = fakeRunner(gitAnswer({ listing: 'present.ts\0', status: ' M present.ts\0', root: undefined }));
  const withoutRoot = await listRepositoryEntries({ run: noRoot.run, cwd: '/repo', now: Date.now() });
  assert.deepEqual(pairs(withoutRoot.entries), [['present.ts', 'updated']], 'a failed rev-parse is not a failed listing');
  assert.deepEqual(withoutRoot.entries[0], { path: 'present.ts', state: 'updated' });
});

test('a rename record skips its original path field', async () => {
  const { run } = fakeRunner(gitAnswer({
    listing: 'src/new.ts\0src/old.ts\0',
    status: 'R  src/new.ts\0src/old.ts\0',
    root: undefined,
  }));

  const result = await listRepositoryEntries({ run, cwd: '/repo', now: Date.now() });
  assert.deepEqual(pairs(result.entries), [['src/new.ts', 'updated'], ['src/old.ts', 'clean']],
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
    truncated: true,
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
  assert.equal(raised.truncated, true);

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

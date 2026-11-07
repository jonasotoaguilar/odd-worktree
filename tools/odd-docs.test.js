'use strict';
// T3 (odd-viewer S2,S6) tests: lib/odd-docs.js — discovery and reading of
// the current checkout's odd documents.
//
// Contract under test: only `odd/tasks/*.md` of the given root, recursive
// never, ordered most-recently-modified first with the display name as the
// deterministic tie-break (S10) — an unreadable timestamp is kept and
// ordered by name after the readable ones — each entry carrying the display
// name WITHOUT the extension and path; a root whose `odd/tasks` directory is
// missing reads as an empty list (not an error); a missing or non-directory
// root fails closed; reading returns the file text and an unreadable path
// reports an error instead of empty content.
//
// S13 (clone-aware recency) adds a second contract on top of that order: a
// fresh clone stamps every file with the same checkout mtime, so mtime alone
// says nothing about recency. Every case below is a REAL temporary git
// fixture driven with fixed-argv git calls: a clone with identical mtimes and
// different commit dates, an uncommitted edit, an untracked document, a
// non-git directory, git missing, git failing, garbage git output, a shallow
// clone, the bounded call count, and determinism.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const {
  listOddDocs,
  listOddDocsAsync,
  listOddDocsLocal,
  readOddDoc,
  commitCacheInfo,
  COMMIT_CACHE_LIMIT,
} = require('../lib/odd-docs.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

// Explicit stamps keep the ordering assertions independent of how fast the
// fixture happens to be written (S10).
function setMtime(root, relative, iso) {
  const when = new Date(iso);
  fs.utimesSync(path.join(root, relative), when, when);
}

// --- real git fixtures (S13) ----------------------------------------------
// Isolated config so the host's git config cannot change what the fixture
// records, and LC_ALL=C so git output and messages stay stable.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  LC_ALL: 'C',
};

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `odd-docs-git-${tag}-`));
  roots.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return fs.realpathSync(dir);
}

function writeDoc(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

// Commit everything with an EXPLICIT committer/author date, so the commit
// timestamps the listing reads are the ones the test names instead of the
// clock at fixture-build time.
function commitAll(root, iso, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

function names(result) {
  assert.equal(result.ok, true, 'the listing never fails over recency');
  return result.docs.map((doc) => doc.name);
}

// An executable stub reached through the `gitBin` seam, so "git unavailable"
// and "git fails" are real process failures instead of mocked modules.
function stubGit(tag, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `odd-docs-stub-${tag}-`));
  roots.push(dir);
  const file = path.join(dir, 'git');
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

// A pass-through git that records every invocation's argv, so the ONE-call
// budget is asserted from observed behaviour rather than from the source.
function recordingGit(tag, logFile) {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  return stubGit(
    tag,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexec ${JSON.stringify(real)} "$@"\n`,
  );
}

function recordedCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Count one kind of recorded invocation: the history walk, the local-edit read,
// or the HEAD read that keys the commit-time memo.
function countCalls(logFile, pattern) {
  return recordedCalls(logFile).filter((call) => pattern.test(call)).length;
}
const LOG_CALL = /(^|\s)log -z /;
const STATUS_CALL = /(^|\s)status --porcelain/;
const HEAD_CALL = /(^|\s)rev-parse /;

describe('listOddDocs', () => {
  test('lists odd/tasks markdown with the display name, file and absolute path, without the extension or path', () => {
    const root = fixture({
      'odd/tasks/beta.md': '# beta\n',
      'odd/tasks/alpha.md': '# alpha\n',
      'odd/notes.md': '# notes\n',
      'odd/tasks/nested/deep.md': '# deep\n',
      'README.md': '# readme\n',
      'odd/tasks/ignored.txt': 'no\n',
    });
    // This test pins membership and row shape, not order: give both
    // documents explicit stamps so the assertion cannot depend on which
    // file the fixture wrote first.
    setMtime(root, 'odd/tasks/beta.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/alpha.md', '2026-02-01T00:00:00Z');
    const result = listOddDocs(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.docs.map((doc) => doc.name), ['alpha', 'beta']);
    assert.deepEqual(result.docs.map((doc) => doc.file), ['alpha.md', 'beta.md']);
    assert.deepEqual(Object.keys(result.docs[0]), ['name', 'file', 'path'], 'ordering changes nothing in the row shape');
    for (const doc of result.docs) {
      assert.ok(path.isAbsolute(doc.path), 'each entry carries an absolute path');
      assert.ok(doc.path.endsWith(path.join('odd', 'tasks', doc.file)));
    }
  });

  test('orders documents by modification time, newest first (S10)', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n', 'odd/tasks/beta.md': '# beta\n' });
    setMtime(root, 'odd/tasks/alpha.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/beta.md', '2026-02-01T00:00:00Z');
    assert.deepEqual(listOddDocs(root).docs.map((doc) => doc.name), ['beta', 'alpha']);
    // Reversing the stamps must reverse the order: the rule is the
    // timestamp, never the directory order or the name.
    setMtime(root, 'odd/tasks/alpha.md', '2026-03-01T00:00:00Z');
    assert.deepEqual(listOddDocs(root).docs.map((doc) => doc.name), ['alpha', 'beta']);
  });

  test('equal modification times fall back to the display name (S10)', () => {
    const root = fixture({
      'odd/tasks/alpha.md': '# alpha\n',
      'odd/tasks/beta.md': '# beta\n',
      'odd/tasks/gamma.md': '# gamma\n',
    });
    setMtime(root, 'odd/tasks/alpha.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/beta.md', '2026-02-01T00:00:00Z');
    setMtime(root, 'odd/tasks/gamma.md', '2026-02-01T00:00:00Z');
    assert.deepEqual(
      listOddDocs(root).docs.map((doc) => doc.name),
      ['beta', 'gamma', 'alpha'],
      'the tied pair keeps name order and still outranks the older document',
    );
  });

  test('a document whose timestamp cannot be read is kept, by name after the readable ones (S10)', () => {
    const root = fixture({
      'odd/tasks/aaa.md': '# aaa\n',
      'odd/tasks/mmm.md': '# mmm\n',
      'odd/tasks/bbb.md': '# bbb\n',
      'odd/tasks/zzz.md': '# zzz\n',
    });
    setMtime(root, 'odd/tasks/aaa.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/mmm.md', '2026-02-01T00:00:00Z');
    // Deliberately the two newest stamps: an unreadable timestamp must not
    // rank the entry and must never drop it from the list.
    setMtime(root, 'odd/tasks/bbb.md', '2026-03-01T00:00:00Z');
    setMtime(root, 'odd/tasks/zzz.md', '2026-04-01T00:00:00Z');
    const realStat = fs.statSync;
    fs.statSync = (target, ...rest) => {
      if (/[\\/](bbb|zzz)\.md$/.test(String(target))) throw new Error('EACCES: timestamp unreadable');
      return realStat.call(fs, target, ...rest);
    };
    try {
      const docs = listOddDocs(root).docs;
      assert.equal(docs.length, 4, 'no document is dropped for an unreadable timestamp');
      assert.deepEqual(docs.map((doc) => doc.name), ['mmm', 'aaa', 'bbb', 'zzz']);
    } finally {
      fs.statSync = realStat;
    }
  });

  test('a checkout without odd/tasks is an empty list, not an error', () => {
    const root = fixture({ 'README.md': '# readme\n' });
    const result = listOddDocs(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.docs, []);
  });

  test('a missing root fails closed', () => {
    const missing = path.join(os.tmpdir(), `odd-docs-missing-${process.pid}-${Date.now()}`);
    assert.equal(listOddDocs(missing).ok, false);
    assert.equal(listOddDocs('').ok, false);
    assert.equal(listOddDocs(null).ok, false);
  });
});

describe('readOddDoc', () => {
  test('returns the file bytes as text', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n\n## Specs\nS1. text\n' });
    const [doc] = listOddDocs(root).docs;
    const read = readOddDoc(doc);
    assert.equal(read.ok, true);
    assert.match(read.text, /## Specs/);
  });

  test('an unreadable path reports an error instead of empty content', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n' });
    const [doc] = listOddDocs(root).docs;
    fs.rmSync(doc.path);
    const read = readOddDoc(doc);
    assert.equal(read.ok, false);
    assert.equal(typeof read.error, 'string');
    assert.ok(read.error.length > 0);
    assert.equal(read.oddTitle, undefined);
  });
});

// ---------------------------------------------------------------------------
// S13: recency that survives a fresh clone. The priority the listing applies
// per document is (1) an uncommitted local edit — ranked at
// max(its own mtime, its own commit time), so a local edit is never older than
// the commit it edits; (2) the last commit time touching the file; (3) the
// file mtime, whenever git, its history, or the file's tracking is unusable.
// Documents are then ordered by that timestamp descending, then display name,
// then raw file name — all code-unit comparisons, never localeCompare.
// ---------------------------------------------------------------------------
describe('clone-aware recency (S13)', () => {
  test('a fresh clone orders by commit date, not by the identical checkout mtime', () => {
    const source = makeRepo('clone-source');
    writeDoc(source, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(source, '2026-01-01T00:00:00Z', 'older document');
    writeDoc(source, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(source, '2026-06-01T00:00:00Z', 'newer document');

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-clone-'));
    roots.push(parent);
    const clone = path.join(parent, 'checkout');
    git(parent, ['clone', '-q', source, clone]);

    // The fresh-clone property under test: one checkout stamp for every file,
    // so mtime cannot distinguish them. Alphabetical would put `aaa` first.
    setMtime(clone, 'odd/tasks/aaa.md', '2026-12-01T00:00:00Z');
    setMtime(clone, 'odd/tasks/zzz.md', '2026-12-01T00:00:00Z');
    assert.equal(
      fs.statSync(path.join(clone, 'odd/tasks/aaa.md')).mtimeMs,
      fs.statSync(path.join(clone, 'odd/tasks/zzz.md')).mtimeMs,
      'both documents carry the identical clone mtime',
    );

    const listing = listOddDocs(clone);
    assert.deepEqual(names(listing), ['zzz', 'aaa'], 'the commit dates decide, newest first');
    assert.notDeepEqual(names(listing), ['aaa', 'zzz'], 'recency is never alphabetical: the view toggles a copy');
    assert.deepEqual(
      Object.keys(listing.docs[0]),
      ['name', 'file', 'path'],
      'the recency keys stay out of the public row shape',
    );

    // And mtime must not override a commit even when it contradicts it.
    setMtime(clone, 'odd/tasks/aaa.md', '2026-09-01T00:00:00Z');
    setMtime(clone, 'odd/tasks/zzz.md', '2026-07-01T00:00:00Z');
    assert.deepEqual(listOddDocs(clone).docs.map((doc) => doc.name), ['zzz', 'aaa']);
  });

  test('an uncommitted local edit outranks its own commit, and never ranks below it', () => {
    const root = makeRepo('dirty');
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'alpha');
    writeDoc(root, 'odd/tasks/gamma.md', '# gamma\n');
    commitAll(root, '2025-06-01T00:00:00Z', 'gamma');
    writeDoc(root, 'odd/tasks/beta.md', '# beta\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'beta');

    // Clean baseline: pure commit recency, no local edit involved.
    assert.deepEqual(names(listOddDocs(root)), ['beta', 'alpha', 'gamma']);

    // An uncommitted edit is newer than the commit it edits, so it moves the
    // document ahead of a document whose commit is newer than its own.
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n\nL36: edited, not committed\n');
    assert.deepEqual(names(listOddDocs(root)), ['alpha', 'beta', 'gamma']);

    // A backdated mtime does not demote the edit below its own commit: it
    // ranks at max(mtime, commit) = 2026-01-01, still above gamma (2025-06-01)
    // and still below beta (2026-06-01). A bare-mtime rule would sort it last.
    setMtime(root, 'odd/tasks/alpha.md', '2020-01-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(root)), ['beta', 'alpha', 'gamma']);

    // Committing the edit turns the local signal back into a commit signal.
    commitAll(root, '2026-08-01T00:00:00Z', 'alpha edit');
    assert.deepEqual(names(listOddDocs(root)), ['alpha', 'beta', 'gamma']);
  });

  test('an untracked document falls back to its own mtime and is never dropped', () => {
    const root = makeRepo('untracked');
    writeDoc(root, 'odd/tasks/committed.md', '# committed\n');
    commitAll(root, '2026-05-01T00:00:00Z', 'committed');
    writeDoc(root, 'odd/tasks/draft.md', '# draft\n');

    // Untracked, and newer than the only commit: the mtime is the only signal.
    setMtime(root, 'odd/tasks/draft.md', '2026-09-01T00:00:00Z');
    const newer = listOddDocs(root);
    assert.equal(newer.docs.length, 2, 'the untracked document is listed');
    assert.deepEqual(names(newer), ['draft', 'committed']);

    // Backdated, it sorts after the commit — never pinned first just because
    // git has no history for it.
    setMtime(root, 'odd/tasks/draft.md', '2024-01-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(root)), ['committed', 'draft']);
  });

  test('a non-git directory falls back to mtime and still lists', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n', 'odd/tasks/beta.md': '# beta\n' });
    setMtime(root, 'odd/tasks/alpha.md', '2024-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/beta.md', '2025-01-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(root)), ['beta', 'alpha']);
    setMtime(root, 'odd/tasks/alpha.md', '2026-01-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(root)), ['alpha', 'beta']);
  });

  test('git missing, git failing or garbage git output falls back to mtime', () => {
    const root = makeRepo('unavailable');
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'newer commit, older file');
    writeDoc(root, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'older commit, newer file');
    // mtime order is the OPPOSITE of commit order: any fallback is observable.
    setMtime(root, 'odd/tasks/aaa.md', '2024-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/zzz.md', '2025-01-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(root)), ['aaa', 'zzz'], 'sanity: git recency is in effect');

    const missing = listOddDocs(root, { gitBin: path.join(root, 'no-such-git-binary') });
    assert.deepEqual(names(missing), ['zzz', 'aaa'], 'git unavailable: mtime, never an error');

    const failing = listOddDocs(root, { gitBin: stubGit('failing', '#!/bin/sh\nexit 128\n') });
    assert.deepEqual(names(failing), ['zzz', 'aaa'], 'git failing: mtime, never an error');

    const garbage = listOddDocs(root, { gitBin: stubGit('garbage', "#!/bin/sh\nprintf 'not a git log\\n'\n") });
    assert.deepEqual(names(garbage), ['zzz', 'aaa'], 'unparseable git output: mtime, never an error');
  });

  test('a shallow clone without history for a document falls back to its mtime', () => {
    const source = makeRepo('shallow-source');
    writeDoc(source, 'odd/tasks/aaa.md', '# aaa\n');
    writeDoc(source, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(source, '2026-01-01T00:00:00Z', 'both documents');
    // The tip commit touches nothing under odd/tasks, so a depth-1 clone has
    // no history for either document.
    writeDoc(source, 'README.md', '# readme\n');
    commitAll(source, '2026-02-01T00:00:00Z', 'unrelated');

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-shallow-'));
    roots.push(parent);
    const clone = path.join(parent, 'checkout');
    git(parent, ['clone', '-q', '--depth', '1', `file://${source}`, clone]);
    setMtime(clone, 'odd/tasks/aaa.md', '2026-05-01T00:00:00Z');
    setMtime(clone, 'odd/tasks/zzz.md', '2026-04-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(clone)), ['aaa', 'zzz'], 'no reachable history: mtime decides');
  });

  test('reads every document\'s commit time in ONE bounded git call, never one per file', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, () => {
    const root = makeRepo('bounded');
    const committed = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    for (const [index, name] of committed.entries()) {
      writeDoc(root, `odd/tasks/${name}.md`, `# ${name}\n`);
      commitAll(root, `2026-0${index + 1}-01T00:00:00Z`, name);
    }
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-calls-')), 'calls.log');
    roots.push(path.dirname(logFile));

    const listing = listOddDocs(root, { gitBin: recordingGit('bounded', logFile) });
    const calls = recordedCalls(logFile);
    assert.ok(
      calls.length <= 3,
      `at most one HEAD read, one commit read and one local-edit read, saw ${calls.length}: ${calls.join(' | ')}`,
    );
    assert.equal(calls.filter((call) => /\slog -z /.test(`${call} `)).length, 1, 'exactly one commit-time call');
    assert.match(calls.join('\n'), /odd\/tasks/, 'the call covers the odd directory, not each document');
    assert.match(calls.join('\n'), /-n \d+/, 'the history walk is explicitly bounded');
    assert.deepEqual(names(listing), committed.slice().reverse(), 'six documents still rank by their own commit');

    // An empty listing costs no git process at all.
    const emptyRepo = makeRepo('bounded-empty');
    writeDoc(emptyRepo, 'README.md', '# readme\n');
    commitAll(emptyRepo, '2026-01-01T00:00:00Z', 'init');
    const emptyLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-calls-empty-')), 'calls.log');
    roots.push(path.dirname(emptyLog));
    assert.deepEqual(listOddDocs(emptyRepo, { gitBin: recordingGit('empty', emptyLog) }).docs, []);
    assert.deepEqual(recordedCalls(emptyLog), [], 'no documents, no git process');
  });

  test('documents committed together tie-break by name, deterministically', () => {
    const root = makeRepo('determinism');
    // One commit for all three: identical commit timestamps, so only the
    // name tie-break can order them. Code-unit order, not locale order.
    writeDoc(root, 'odd/tasks/Zulu.md', '# Zulu\n');
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n');
    writeDoc(root, 'odd/tasks/bravo.md', '# bravo\n');
    commitAll(root, '2026-03-01T00:00:00Z', 'all three');

    const first = names(listOddDocs(root));
    assert.deepEqual(first, ['Zulu', 'alpha', 'bravo'], 'code-unit name order: Z before a');
    for (let round = 0; round < 4; round += 1) {
      assert.deepEqual(names(listOddDocs(root)), first, 'the order is stable across listings');
    }
  });
});

// ---------------------------------------------------------------------------
// S13 cost, without giving up correctness: the parsed commit-time map is
// memoized per repository and HEAD commit. The history walk is the expensive
// part (seconds on a slow/network checkout) and its answer is a pure function
// of the commits reachable from HEAD, so an unchanged HEAD cannot change it. The
// cheap local-edit read still runs on EVERY listing, so an uncommitted edit
// keeps promoting its document. A new HEAD (new commit), a failed git read, or
// an evicted entry must all re-derive the order instead of serving a stale one.
// ---------------------------------------------------------------------------
describe('commit-time memo (S13)', () => {
  test('a repeated listing with an unchanged HEAD walks no history again', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, () => {
    const root = makeRepo('memo-repeat');
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'older document');
    writeDoc(root, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'newer document');
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-memo-repeat-')), 'calls.log');
    roots.push(path.dirname(logFile));
    const bin = recordingGit('memo-repeat', logFile);

    const first = names(listOddDocs(root, { gitBin: bin }));
    assert.deepEqual(first, ['zzz', 'aaa'], 'the cold listing still ranks by commit');
    assert.equal(countCalls(logFile, LOG_CALL), 1, 'the cold listing walks history once');

    const second = names(listOddDocs(root, { gitBin: bin }));
    assert.deepEqual(second, first, 'the same HEAD produces the same order');
    assert.equal(countCalls(logFile, LOG_CALL), 1, 'the warm listing spawns NO second history walk');
    assert.equal(countCalls(logFile, STATUS_CALL), 2, 'the cheap local-edit read still runs every listing');
    assert.equal(countCalls(logFile, HEAD_CALL), 2, 'each listing resolves HEAD to key the memo');
  });

  test('a new commit invalidates the memo and replaces it, never accumulating', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, () => {
    const root = makeRepo('memo-invalidate');
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'older document');
    writeDoc(root, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'newer document');
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-memo-invalidate-')), 'calls.log');
    roots.push(path.dirname(logFile));
    const bin = recordingGit('memo-invalidate', logFile);

    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['zzz', 'aaa']);
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['zzz', 'aaa'], 'memo is warm here');
    assert.equal(countCalls(logFile, LOG_CALL), 1);

    // A new commit moves HEAD, so the memo cannot answer for it any more.
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n\n## Specs\nS13: committed later\n');
    commitAll(root, '2026-09-01T00:00:00Z', 'aaa committed later');
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['aaa', 'zzz'], 'the new commit reorders');
    assert.equal(countCalls(logFile, LOG_CALL), 2, 'the new HEAD is walked exactly once');

    // And the memo holds ONE entry for this checkout, keyed by the new HEAD.
    const entries = commitCacheInfo().entries.filter((entry) => entry.root === root);
    assert.equal(entries.length, 1, 'a new HEAD replaces the old entry instead of adding one');
    assert.equal(entries[0].head, git(root, ['rev-parse', 'HEAD']), 'the entry is keyed by the current HEAD');
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['aaa', 'zzz']);
    assert.equal(countCalls(logFile, LOG_CALL), 2, 'no further walk for the new HEAD');
  });

  test('an uncommitted edit still reorders while the memo serves the commit times', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, () => {
    const root = makeRepo('memo-dirty');
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'alpha');
    writeDoc(root, 'odd/tasks/beta.md', '# beta\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'beta');
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-memo-dirty-')), 'calls.log');
    roots.push(path.dirname(logFile));
    const bin = recordingGit('memo-dirty', logFile);

    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['beta', 'alpha'], 'clean baseline');
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['beta', 'alpha'], 'memo is warm here');
    assert.equal(countCalls(logFile, LOG_CALL), 1);

    // Dirty, uncommitted, HEAD unchanged: only the local-edit read can see it.
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n\nL35: edited, not committed\n');
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['alpha', 'beta'], 'the dirty edit is promoted');
    assert.equal(countCalls(logFile, LOG_CALL), 1, 'no history walk was needed to notice the edit');
    assert.equal(countCalls(logFile, STATUS_CALL), 3, 'the dirty check ran on every listing');

    // A backdated mtime still never demotes it below its own commit.
    setMtime(root, 'odd/tasks/alpha.md', '2020-01-01T00:00:00Z');
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['beta', 'alpha']);
    assert.equal(countCalls(logFile, LOG_CALL), 1);
  });

  test('a git failure falls back to mtime instead of serving the memo', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, () => {
    const root = makeRepo('memo-fallback');
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'newer commit, older file');
    writeDoc(root, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'older commit, newer file');
    // mtime order is the OPPOSITE of commit order, so any fallback is visible.
    setMtime(root, 'odd/tasks/aaa.md', '2024-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/zzz.md', '2025-01-01T00:00:00Z');

    assert.deepEqual(names(listOddDocs(root)), ['aaa', 'zzz'], 'sanity: the memo now holds the commit order');

    const failing = stubGit('memo-failing', '#!/bin/sh\nexit 128\n');
    assert.deepEqual(
      names(listOddDocs(root, { gitBin: failing })),
      ['zzz', 'aaa'],
      'git failing: mtime order, never the memoized commit order',
    );

    // A HEAD that cannot be resolved is not a memo key: no entry is invented
    // for it, and the real entry is untouched.
    const entries = commitCacheInfo().entries.filter((entry) => entry.root === root);
    assert.equal(entries.length, 1, 'the failed read adds no entry');
    assert.equal(entries[0].head, git(root, ['rev-parse', 'HEAD']));

    // Garbage on the HEAD read is a cache miss, not a stale hit.
    const garbage = stubGit('memo-garbage', "#!/bin/sh\nprintf 'not a commit id\\n'\n");
    assert.deepEqual(names(listOddDocs(root, { gitBin: garbage })), ['zzz', 'aaa'], 'garbage: mtime, never a stale order');
    assert.equal(
      commitCacheInfo().entries.filter((entry) => entry.root === root).length,
      1,
      'a garbage HEAD adds no entry',
    );
  });

  test('the memo is bounded, so many checkouts cannot grow it without limit', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, () => {
    const listing = [];
    for (let index = 0; index <= COMMIT_CACHE_LIMIT; index += 1) {
      const root = makeRepo(`memo-bound-${index}`);
      writeDoc(root, 'odd/tasks/only.md', `# only ${index}\n`);
      commitAll(root, '2026-01-01T00:00:00Z', `only ${index}`);
      const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `odd-docs-bound-${index}-`)), 'calls.log');
      roots.push(path.dirname(logFile));
      const bin = recordingGit(`memo-bound-${index}`, logFile);
      assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['only']);
      listing.push({ root, logFile, bin });
    }
    const info = commitCacheInfo();
    assert.ok(info.size <= info.limit, `memo size ${info.size} stays within its bound ${info.limit}`);
    assert.equal(info.limit, COMMIT_CACHE_LIMIT);

    // One more checkout than the bound was listed, so the oldest entry is gone:
    // listing it again re-derives the order instead of serving a dropped entry.
    const oldest = listing[0];
    assert.deepEqual(names(listOddDocs(oldest.root, { gitBin: oldest.bin })), ['only']);
    assert.equal(countCalls(oldest.logFile, LOG_CALL), 2, 'an evicted checkout is walked again');

    // The newest one is still remembered.
    const newest = listing[listing.length - 1];
    assert.deepEqual(names(listOddDocs(newest.root, { gitBin: newest.bin })), ['only']);
    assert.equal(countCalls(newest.logFile, LOG_CALL), 1, 'a remembered checkout is not walked again');
  });

  test('the memo holds commit times only, never document contents', () => {
    const root = makeRepo('memo-contents');
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n\nL35: private text that must not be cached\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'alpha');
    assert.deepEqual(names(listOddDocs(root)), ['alpha'], 'the listing populates the memo');

    const info = commitCacheInfo();
    assert.deepEqual(Object.keys(info).sort(), ['entries', 'limit', 'size'], 'the diagnostic is read-only and small');
    const entry = info.entries.find((candidate) => candidate.root === root);
    assert.ok(entry, 'the listed checkout is memoized');
    assert.equal(entry.head, git(root, ['rev-parse', 'HEAD']));
    assert.deepEqual(entry.times.map(([file]) => file), ['alpha.md'], 'the memo keys are file names');
    for (const [file, ms] of entry.times) {
      assert.equal(typeof file, 'string');
      assert.equal(typeof ms, 'number');
      assert.ok(Number.isFinite(ms), 'every memoized value is a commit time in ms');
    }
    assert.ok(
      !JSON.stringify(info.entries).includes('private text'),
      'no document content reaches the memo',
    );
  });
});

// ---------------------------------------------------------------------------
// Interactive listing (S21 «se traba»): the viewer is an INTERACTIVE path, so
// the listing has to answer without freezing the host event loop on Git, and
// the first frame must not wait for a history walk at all. Two additions carry
// that, and both must agree with the synchronous listing document for
// document:
//
//   listOddDocsLocal(root)  — the cheap scan alone: `odd/tasks` on disk ordered
//                             by the documented mtime fallback, with no Git
//                             process of any kind. The first frame paints from
//                             this, and it decides whether there is anything to
//                             read at all.
//   listOddDocsAsync(root)  — the same listing `listOddDocs` returns, with every
//                             Git read awaited off the loop instead of spawned
//                             synchronously. Same rows, same order, same
//                             degradations: an answer git cannot give leaves the
//                             mtime fallback exactly as it does synchronously.
//
// A slow Git is simulated deterministically through the injected async runner
// (the package convention `(bin, argv, cwd) => Promise<{status,stdout,stderr}>`)
// and through a real recording git binary, never by mocking the module.
// ---------------------------------------------------------------------------
describe('interactive listing (S21)', () => {
  // The package's async runner convention, with a deterministic extra delay per
  // Git call, delegating the actual read to the real binary so the output is
  // the same one a host would see.
  function delayedRunner(delayMs) {
    return async (bin, args, cwd) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return spawnSync(bin, args, { cwd, encoding: 'utf8', env: GIT_ENV });
    };
  }

  function cloneWithConflictingSignals(tag) {
    const source = makeRepo(`${tag}-source`);
    writeDoc(source, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(source, '2026-01-01T00:00:00Z', 'older document');
    writeDoc(source, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(source, '2026-06-01T00:00:00Z', 'newer document');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `odd-docs-${tag}-clone-`));
    roots.push(parent);
    const clone = path.join(parent, 'checkout');
    git(parent, ['clone', '-q', source, clone]);
    // mtime contradicts the commit dates: `aaa` is the newer file on disk.
    setMtime(clone, 'odd/tasks/aaa.md', '2026-09-01T00:00:00Z');
    setMtime(clone, 'odd/tasks/zzz.md', '2026-07-01T00:00:00Z');
    return clone;
  }

  test('the local scan lists every document by mtime, reading no Git signal at all', () => {
    const clone = cloneWithConflictingSignals('local');
    const local = listOddDocsLocal(clone);
    assert.equal(local.ok, true);
    assert.equal(local.root, clone);
    assert.deepEqual(
      local.docs.map((doc) => doc.name),
      ['aaa', 'zzz'],
      'the cheap scan is the mtime fallback: had it read git, the commit dates would decide',
    );
    assert.deepEqual(
      local.docs.map((doc) => doc.name),
      listOddDocs(clone).docs.map((doc) => doc.name).reverse(),
      'and it is the same document set the full listing returns, in mtime order',
    );
    assert.deepEqual(Object.keys(local.docs[0]), ['name', 'file', 'path'], 'the row shape is unchanged');
  });

  test('the local scan still fails closed and still treats a missing odd/tasks as empty', () => {
    assert.equal(listOddDocsLocal('').ok, false);
    assert.equal(listOddDocsLocal(null).ok, false);
    assert.equal(listOddDocsLocal(path.join(os.tmpdir(), `odd-docs-local-missing-${process.pid}`)).ok, false);
    const empty = fixture({ 'README.md': '# readme\n' });
    assert.deepEqual(listOddDocsLocal(empty), { ok: true, root: empty, docs: [] });
  });

  test('the async listing resolves the same documents in the same order as the synchronous one', async () => {
    const root = makeRepo('async-same');
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'alpha');
    writeDoc(root, 'odd/tasks/bravo.md', '# bravo\n');
    commitAll(root, '2026-05-01T00:00:00Z', 'bravo');

    const asyncListing = await listOddDocsAsync(root);
    assert.equal(asyncListing.ok, true);
    assert.equal(asyncListing.root, root);
    assert.deepEqual(asyncListing.docs.map((doc) => doc.name), ['bravo', 'alpha'], 'commit recency, newest first');
    assert.deepEqual(
      asyncListing.docs,
      listOddDocs(root).docs,
      'both readers describe the same checkout identically, row for row',
    );
  });

  test('the async listing leaves the host event loop free while Git answers', async () => {
    const root = makeRepo('async-free');
    writeDoc(root, 'odd/tasks/alpha.md', '# alpha\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'alpha');

    let settled = false;
    let ticked = false;
    const pending = listOddDocsAsync(root, { runAsync: delayedRunner(60) });
    assert.equal(typeof pending.then, 'function', 'the interactive reader hands back a promise');
    pending.then(() => { settled = true; });
    setTimeout(() => { ticked = true; }, 10);
    // One macrotask after the call, the loop is already turning while every
    // Git read is still sleeping: nothing on this path is `spawnSync`.
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(ticked, true, 'the host got a turn while git was still answering');
    assert.equal(settled, false, 'the listing had not answered yet, so the turn came from the wait being off-loop');
    const listing = await pending;
    assert.deepEqual(listing.docs.map((doc) => doc.name), ['alpha']);
  });

  test('a git that cannot answer degrades to mtime instead of failing the listing', async () => {
    const root = makeRepo('async-degrade');
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'aaa');
    writeDoc(root, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'zzz');
    setMtime(root, 'odd/tasks/aaa.md', '2026-09-01T00:00:00Z');
    setMtime(root, 'odd/tasks/zzz.md', '2026-07-01T00:00:00Z');

    const failing = async () => ({ status: 1, stdout: '', stderr: 'fatal: no history' });
    const listing = await listOddDocsAsync(root, { runAsync: failing });
    assert.equal(listing.ok, true, 'recency never fails the listing');
    assert.deepEqual(names(listing), ['aaa', 'zzz'], 'the mtime fallback ranks the documents');
    assert.deepEqual(names(listing), names(listOddDocsLocal(root)), 'identical to the cheap scan');
  });

  test('an empty checkout and a missing root cost no Git process at all', async () => {
    const calls = [];
    const counting = async (bin, args, cwd) => {
      calls.push({ bin, args, cwd });
      return { status: 0, stdout: '', stderr: '' };
    };
    const empty = fixture({ 'README.md': '# readme\n' });
    assert.deepEqual(await listOddDocsAsync(empty, { runAsync: counting }), { ok: true, root: empty, docs: [] });
    assert.deepEqual(calls, [], 'no documents, no git process');
    const missing = path.join(os.tmpdir(), `odd-docs-async-missing-${process.pid}`);
    assert.equal((await listOddDocsAsync(missing, { runAsync: counting })).ok, false);
    assert.deepEqual(calls, [], 'a root that is not a checkout never reaches git');
  });

  test('the async listing shares the commit-time memo, so a slow walk is paid once', {
    skip: process.platform === 'win32' ? 'POSIX stub script' : false,
  }, async () => {
    const root = makeRepo('async-memo');
    writeDoc(root, 'odd/tasks/aaa.md', '# aaa\n');
    commitAll(root, '2026-01-01T00:00:00Z', 'older');
    writeDoc(root, 'odd/tasks/zzz.md', '# zzz\n');
    commitAll(root, '2026-06-01T00:00:00Z', 'newer');
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-async-memo-')), 'calls.log');
    roots.push(path.dirname(logFile));
    const bin = recordingGit('async-memo', logFile);

    // The synchronous listing paid the walk through the recording binary.
    assert.deepEqual(names(listOddDocs(root, { gitBin: bin })), ['zzz', 'aaa']);
    assert.equal(countCalls(logFile, LOG_CALL), 1, 'the premise: one history walk happened');

    // The async twin resolves the identical order and, on an unchanged HEAD,
    // walks no history again — it reaches the SAME memo through the default
    // async runner, so neither reader serves an order it did not derive.
    const listing = await listOddDocsAsync(root, { gitBin: bin });
    assert.deepEqual(names(listing), ['zzz', 'aaa'], 'the async reader returns the git-ranked order');
    assert.equal(countCalls(logFile, LOG_CALL), 1, 'an unchanged HEAD is not walked a second time');
    assert.equal(countCalls(logFile, HEAD_CALL), 2, 'it still re-reads HEAD to know the memo is current');
    assert.equal(countCalls(logFile, STATUS_CALL), 2, 'and it still re-reads the local-edit signal');
  });
});

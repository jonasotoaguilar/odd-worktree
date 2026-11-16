'use strict';
// T11 (S13, issues-startup-performance): the LOCAL executable lookup.
//
// Contract under test, through the module's one public function:
// - a command is answered from the `PATH` it was given, first hit wins, and
//   only an EXECUTABLE file counts — a plain file, a directory and a missing
//   directory are all skipped;
// - an absolute path is tested itself, with no `PATH` at all;
// - the answer is the platform's: `;` and `PATHEXT` on win32, `:` and the bare
//   name everywhere else, both injectable so a test never needs that platform;
// - nothing is read from `process.env` behind the caller's back, nothing is
//   memoized and nothing is executed: the module holds no child process at all,
//   which is the whole point of the check it exists for.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { whichCommand } = require('../lib/which-command.js');

const scratch = [];
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `odd-which-${tag}-`));
  scratch.push(dir);
  return dir;
}

// A file at `<dir>/<name>` with the mode a test asks for. 0o755 is what a real
// installed binary has; 0o644 is the "not a command" case.
function executable(dir, name, mode = 0o755) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, mode);
  return file;
}

after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('finds an executable of that name on the given PATH and answers its whole path', () => {
  const bin = tempDir('found');
  const file = executable(bin, 'gh');
  assert.equal(whichCommand('gh', { env: { PATH: bin }, isExecutable: (candidate) => fs.existsSync(candidate) }), file);
});

test('a plain file, a directory and a name nothing holds are not the command', () => {
  const bin = tempDir('not-executable');
  executable(bin, 'gh', 0o644);
  fs.mkdirSync(path.join(bin, 'gh-dir'));
  assert.equal(whichCommand('gh', { env: { PATH: bin } }), null, 'a non-executable file is not a command');
  assert.equal(whichCommand('gh-dir', { env: { PATH: bin } }), null, 'a directory is not a command');
  assert.equal(whichCommand('nothing-here', { env: { PATH: bin } }), null, 'and an absent name is null');
});

test('the first PATH entry wins, and empty or missing entries are skipped', () => {
  const first = tempDir('first');
  const second = tempDir('second');
  const firstFile = executable(first, 'gh');
  const secondFile = executable(second, 'gh');
  assert.equal(whichCommand('gh', { env: { PATH: `${first}${path.delimiter}${second}` } }), firstFile);
  assert.equal(whichCommand('gh', { env: { PATH: `:${path.delimiter}${second}` } }), secondFile,
    'an empty leading entry is not a directory to search');
  assert.equal(whichCommand('gh', { env: { PATH: path.join(first, 'does-not-exist') } }), null,
    'a PATH entry that does not exist is skipped');
});

test('an absent or empty PATH, and an empty name, answer null instead of throwing', () => {
  assert.equal(whichCommand('gh', { env: {} }), null);
  assert.equal(whichCommand('gh', { env: { PATH: '' } }), null);
  assert.equal(whichCommand('', { env: { PATH: tempDir('empty-name') } }), null);
  assert.equal(whichCommand(null, { env: { PATH: '/usr/bin' } }), null);
  assert.equal(whichCommand('gh'), null, 'no environment named means no PATH to search, never this process\'s own');
});

test('an absolute path is tested itself, with no PATH involved', () => {
  const bin = tempDir('absolute');
  const file = executable(bin, 'gh');
  assert.equal(whichCommand(file, { env: { PATH: '' } }), file);
  assert.equal(whichCommand(path.join(bin, 'missing-gh'), { env: { PATH: bin } }), null);
});

test('win32 searches with `;` and PATHEXT, and answers the extension it found', () => {
  const looked = [];
  const isExecutable = (candidate) => {
    looked.push(candidate);
    return candidate === 'C:\\Tools\\gh.EXE';
  };
  assert.equal(
    whichCommand('gh', {
      env: { PATH: 'C:\\Windows;C:\\Tools', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      isExecutable,
    }),
    'C:\\Tools\\gh.EXE',
  );
  assert.deepEqual(looked, [
    'C:\\Windows\\gh',
    'C:\\Windows\\gh.EXE',
    'C:\\Windows\\gh.CMD',
    'C:\\Tools\\gh',
    'C:\\Tools\\gh.EXE',
  ], 'the bare name then every PATHEXT extension, directory by directory');
});

test('the environment it reads is the one it was given, never process.env', () => {
  const bin = tempDir('injected');
  const file = executable(bin, 'gh');
  const saved = process.env.PATH;
  try {
    process.env.PATH = path.join(bin, 'not-on-path');
    assert.equal(whichCommand('gh', { env: { PATH: bin } }), file,
      'the injected PATH decides, whatever this process happens to have');
  } finally {
    process.env.PATH = saved;
  }
});

test('the probe runs nothing: the module holds no child process', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/which-command.js'), 'utf8');
  assert.equal(/child_process/.test(source), false, 'no child process, no spawn, no exec');
  assert.equal(/\bexecFile\b|\bspawnSync\b|\bspawn\(/.test(source), false, 'and no way to run the candidate');
});

'use strict';
// One root identity, and codegraph never spawned with the project as its working directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalRoot, codegraphSpawn, foldRoot, PROJECT_ENV, serveCommand } = require('../lib/codegraph-paths.js');

const B = '\\';
const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-paths-')));

test('foldRoot folds case only on Windows; trailing separators go and roots stay roots', () => {
  assert.equal(foldRoot(`C:${B}Users${B}me${B}`, 'win32'), `c:${B}users${B}me`);
  assert.equal(foldRoot(`C:${B}`, 'win32'), `c:${B}`);
  assert.equal(foldRoot('/srv/Repo/', 'linux'), '/srv/Repo');
  assert.equal(foldRoot('/', 'linux'), '/');
  assert.equal(foldRoot('/Users/Me/Repo', 'darwin'), '/Users/Me/Repo');
});

test('canonicalRoot resolves a link and keeps a missing path on its nearest existing parent', (t) => {
  const real = temp();
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  assert.equal(canonicalRoot(real + '/'), canonicalRoot(real));
  const link = real + '-link';
  fs.symlinkSync(real, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.equal(canonicalRoot(link), canonicalRoot(real));
  assert.equal(canonicalRoot(path.join(link, 'missing', 'x')), path.join(canonicalRoot(real), 'missing', 'x'));
});

test('codegraphSpawn runs from the temp directory with the project as an argument, no shell', () => {
  const spawn = codegraphSpawn(['sync'], '/work/repo', 'linux');
  assert.deepEqual(spawn, { command: 'codegraph', args: ['sync', '/work/repo'], cwd: os.tmpdir(), shell: false, env: {} });
});

test('on Windows the project travels in the environment, never in the command line', () => {
  const spawn = codegraphSpawn(['init'], `C:${B}repo${B}`, 'win32');
  assert.equal(spawn.shell, true);
  assert.ok(!spawn.command.includes('repo'));
  assert.equal(spawn.env[PROJECT_ENV], `C:${B}repo${B}.`);
  const serve = serveCommand('codegraph serve --mcp', `C:${B}repo`, 'win32');
  assert.equal(serve.command, `codegraph serve --mcp -p "%${PROJECT_ENV}%"`);
});

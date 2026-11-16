'use strict';
// S8: the picker's insertion form. A file below the session cwd is `@` plus its
// path from that cwd, because Pi resolves `@` against the session cwd; any other
// file is its real absolute path, never a `~` form. The rules are asserted
// through the module's public surface only.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { fileReference, formatFileInsertion } = require('../lib/files-insert.js');

const MAIN = { root: '/repo', kind: 'main', cwd: '/repo' };
const WORKTREE = { root: '/home/dev/odd-worktrees/feature', kind: 'worktree', cwd: '/repo' };

// A session started in a subdirectory: the repository root is still /repo,
// but Pi resolves `@` against /repo/packages/app.
const SUBDIRECTORY = { root: '/repo', kind: 'main', cwd: '/repo/packages/app' };

describe('the file picker inserts the chosen files as references (S8)', () => {
  test('a file from the session repository is inserted as @ plus its relative path', () => {
    assert.equal(formatFileInsertion(['AGENTS.md'], MAIN), '@AGENTS.md');
    assert.equal(formatFileInsertion(['src/index.js'], MAIN), '@src/index.js');
    assert.equal(formatFileInsertion(['lib/view-layout.js'], MAIN), '@lib/view-layout.js');
  });

  test('a file from another checkout is inserted as its absolute path, never @', () => {
    assert.equal(
      formatFileInsertion(['src/index.js'], WORKTREE),
      '/home/dev/odd-worktrees/feature/src/index.js'
    );
    assert.equal(formatFileInsertion(['AGENTS.md'], WORKTREE).startsWith('@'), false);
  });

  test('nested relative paths keep every separator', () => {
    assert.equal(
      formatFileInsertion(['packages/app/src/deep/file.js'], MAIN),
      '@packages/app/src/deep/file.js'
    );
    assert.equal(
      formatFileInsertion(['packages/app/src/deep/file.js'], WORKTREE),
      '/home/dev/odd-worktrees/feature/packages/app/src/deep/file.js'
    );
  });

  test('several files join with one space, in the given order', () => {
    assert.equal(formatFileInsertion(['b.js', 'a.js', 'dir/c.js'], MAIN), '@b.js @a.js @dir/c.js');
    assert.equal(
      formatFileInsertion(['one.js', 'two.js'], WORKTREE),
      '/home/dev/odd-worktrees/feature/one.js /home/dev/odd-worktrees/feature/two.js'
    );
  });

  test('the joined text has no leading, trailing or doubled separator', () => {
    const text = formatFileInsertion(['one.js', 'two.js', 'three.js'], MAIN);
    assert.equal(text, text.trim());
    assert.equal(/ {2}/.test(text), false);
  });

  test('an empty list yields an empty string', () => {
    assert.equal(formatFileInsertion([], MAIN), '');
    assert.equal(formatFileInsertion([], WORKTREE), '');
    assert.equal(fileReference(MAIN, ''), '');
  });

  test('a path is never duplicated by the formatter', () => {
    const absolute = '/home/dev/odd-worktrees/feature/src/index.js';
    assert.equal(formatFileInsertion([absolute], WORKTREE), absolute);
    assert.equal(formatFileInsertion(['src/index.js'], WORKTREE), absolute);
    assert.equal(formatFileInsertion(['src/index.js', 'src/index.js'], WORKTREE), absolute);
    assert.equal(formatFileInsertion(['src/index.js', 'src/index.js'], MAIN), '@src/index.js');
  });

  test('Windows-style separators normalise to forward slashes', () => {
    assert.equal(formatFileInsertion(['src\\index.js'], MAIN), '@src/index.js');
    assert.equal(formatFileInsertion(['src\\nested\\dir\\file.js'], MAIN), '@src/nested/dir/file.js');
    assert.equal(
      formatFileInsertion(['src\\index.js'], { root: 'C:\\repo\\wt', kind: 'worktree', cwd: 'C:/repo' }),
      'C:/repo/wt/src/index.js'
    );
  });

  test('the home directory is never abbreviated to ~', () => {
    const text = formatFileInsertion(['src/index.js'], {
      root: '/home/dev/odd-worktrees/feature',
      kind: 'worktree',
      cwd: '/repo',
    });
    assert.equal(text.includes('~'), false);
  });

  test('a file below the session cwd is @ plus the path from that cwd, not from the repository root', () => {
    assert.equal(formatFileInsertion(['packages/app/src/index.js'], SUBDIRECTORY), '@src/index.js');
    assert.equal(formatFileInsertion(['packages/app/AGENTS.md'], SUBDIRECTORY), '@AGENTS.md');
    assert.equal(
      formatFileInsertion(['packages/app/src/index.js'], { ...SUBDIRECTORY, cwd: '/repo/packages/app/' }),
      '@src/index.js',
      'a trailing slash on the cwd changes nothing'
    );
  });

  test('a repository file outside the session cwd is inserted as its real absolute path', () => {
    assert.equal(
      formatFileInsertion(['lib/view-layout.js'], SUBDIRECTORY),
      '/repo/lib/view-layout.js',
      'a file above the cwd cannot be named relative to it'
    );
    assert.equal(
      formatFileInsertion(['packages/other/x.js'], SUBDIRECTORY),
      '/repo/packages/other/x.js',
      'a sibling directory is outside the cwd'
    );
    assert.equal(
      formatFileInsertion(['packages/app/src/index.js', 'lib/view-layout.js'], SUBDIRECTORY),
      '@src/index.js /repo/lib/view-layout.js',
      'each file is named from the cwd that holds it'
    );
  });

  test('a path that begins with ~ is emitted as its real absolute path, never in ~ form', () => {
    assert.equal(formatFileInsertion(['~/notes.md'], MAIN), '/repo/~/notes.md');
    assert.equal(formatFileInsertion(['~'], MAIN), '/repo/~');
    assert.equal(formatFileInsertion(['~/notes.md'], MAIN).startsWith('~'), false);
    const underHome = { root: '/home/dev/repo', kind: 'main', cwd: '/home/dev/repo' };
    assert.equal(formatFileInsertion(['src/index.js'], underHome), '@src/index.js');
    assert.equal(formatFileInsertion(['src/index.js'], underHome).startsWith('~'), false);
  });

  test('another checkout stays absolute even when the session cwd is that checkout', () => {
    const inWorktree = {
      root: '/home/dev/odd-worktrees/feature',
      kind: 'worktree',
      cwd: '/home/dev/odd-worktrees/feature',
    };
    assert.equal(
      formatFileInsertion(['src/index.js'], inWorktree),
      '/home/dev/odd-worktrees/feature/src/index.js'
    );
  });
});

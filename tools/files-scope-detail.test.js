'use strict';
// T3 (files-picker S9): `lib/files-scope-detail.js` — the scope step's data.
//
// Contract under test, as observable output only: `main` first and then the
// other checkouts by recency (stable ties, input untouched); one
// `rev-list --left-right --count` line parsed as behind/ahead or rejected whole;
// the `±n files` cell singular at one; the focused scope's line with the last
// commit subject first, then the count, the age and the distance from the
// comparison ref, with every zero or absent field unpainted; and the two fixed
// argv reads behind the line with every Git failure degrading to an absent field
// instead of throwing.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  LOCAL_MAIN,
  REMOTE_MAIN,
  countCell,
  loadScopeDetail,
  orderScopes,
  parseAheadBehind,
  scopeDetailLine,
} = require('../lib/files-scope-detail.js');

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function scope(overrides = {}) {
  return { root: '/repo', label: 'main', kind: 'main', lastModifiedMs: 0, ...overrides };
}

describe('orderScopes (S9)', () => {
  test('main keeps the first row even when a worktree is newer', () => {
    const ordered = orderScopes([
      scope({ root: '/w/new', label: 'new', kind: 'worktree', lastModifiedMs: 900 }),
      scope({ root: '/repo', label: 'main', kind: 'main', lastModifiedMs: 1 }),
      scope({ root: '/w/old', label: 'old', kind: 'worktree', lastModifiedMs: 10 }),
    ]);
    assert.deepEqual(ordered.map((entry) => entry.label), ['main', 'new', 'old']);
  });

  test('worktrees follow by lastModifiedMs descending, ties in input order', () => {
    const ordered = orderScopes([
      scope({ root: '/w/a', label: 'a', kind: 'worktree', lastModifiedMs: 300 }),
      scope({ root: '/w/b', label: 'b', kind: 'worktree', lastModifiedMs: 300 }),
      scope({ root: '/w/c', label: 'c', kind: 'worktree', lastModifiedMs: 500 }),
      scope({ root: '/w/d', label: 'd', kind: 'worktree' }),
    ]);
    assert.deepEqual(ordered.map((entry) => entry.label), ['c', 'a', 'b', 'd']);
  });

  test('leaves the input array and its entries untouched and returns the same objects', () => {
    const input = [
      scope({ root: '/w/a', label: 'a', kind: 'worktree', lastModifiedMs: 1 }),
      scope({ root: '/repo', label: 'main', kind: 'main', lastModifiedMs: 2 }),
    ];
    const ordered = orderScopes(input);
    assert.deepEqual(input.map((entry) => entry.label), ['a', 'main']);
    assert.equal(ordered[0], input[1]);
    assert.equal(ordered[1], input[0]);
  });

  test('an empty or non-array input is an empty ordering', () => {
    assert.deepEqual(orderScopes([]), []);
    assert.deepEqual(orderScopes(null), []);
    assert.deepEqual(orderScopes(undefined), []);
  });
});

describe('parseAheadBehind (S9)', () => {
  test('reads <behind> <ahead> from one left-right count line', () => {
    assert.deepEqual(parseAheadBehind('3\t2\n'), { behind: 3, ahead: 2 });
    assert.deepEqual(parseAheadBehind('0 0'), { behind: 0, ahead: 0 });
    assert.deepEqual(parseAheadBehind('  12   7  '), { behind: 12, ahead: 7 });
  });

  test('anything that is not exactly two whole counts is unparsable', () => {
    for (const value of ['', '2', '1 2 3', '-1 2', '1 -2', 'a 2', '1 2x', '1.5 2', '\n']) {
      assert.equal(parseAheadBehind(value), undefined, JSON.stringify(value));
    }
    assert.equal(parseAheadBehind(null), undefined);
    assert.equal(parseAheadBehind(undefined), undefined);
  });
});

describe('countCell (S9)', () => {
  test('paints the glyph and the noun, singular at one', () => {
    assert.equal(countCell(1), '±1 file');
    assert.equal(countCell(0), '±0 files');
    assert.equal(countCell(7), '±7 files');
  });
});

describe('scopeDetailLine (S9)', () => {
  test('the last commit subject leads, then the count, the age and the distances', () => {
    const line = scopeDetailLine({
      lastCommitSubject: 'add the scope step',
      changedFiles: 3,
      lastModifiedMs: NOW - 5 * MINUTE,
      ahead: 2,
      behind: 1,
      comparison: 'main',
    }, NOW);
    assert.equal(line, 'add the scope step · ±3 files · 5m · ↑2 main · ↓1 main');
  });

  test('the main row names the remote ref it is measured against', () => {
    const line = scopeDetailLine({
      lastCommitSubject: 'bump deps',
      changedFiles: 1,
      lastModifiedMs: NOW - 2 * HOUR,
      ahead: 0,
      behind: 4,
      comparison: REMOTE_MAIN,
    }, NOW);
    assert.equal(line, 'bump deps · ±1 file · 2h · ↓4 origin/main');
    assert.equal(REMOTE_MAIN, 'origin/main');
    assert.equal(LOCAL_MAIN, 'main');
  });

  test('a zero or absent field is not painted', () => {
    assert.equal(scopeDetailLine({}, NOW), '');
    assert.equal(scopeDetailLine({
      lastCommitSubject: 'only a subject',
      changedFiles: 0,
      lastModifiedMs: 0,
      ahead: 0,
      behind: 0,
      comparison: 'main',
    }, NOW), 'only a subject');
    assert.equal(scopeDetailLine({ changedFiles: 0 }, NOW), '');
  });

  test('an unknown comparison never claims a distance', () => {
    assert.equal(scopeDetailLine({ changedFiles: 2, ahead: 3, behind: 1 }, NOW), '±2 files');
    assert.equal(scopeDetailLine({ changedFiles: 2, ahead: 3, behind: 1, comparison: '   ' }, NOW), '±2 files');
  });

  test('ages use s/m/h/d units of the clock read once at open', () => {
    assert.equal(scopeDetailLine({ lastModifiedMs: NOW - 30_000 }, NOW), '30s');
    assert.equal(scopeDetailLine({ lastModifiedMs: NOW - 3 * MINUTE }, NOW), '3m');
    assert.equal(scopeDetailLine({ lastModifiedMs: NOW - 3 * HOUR }, NOW), '3h');
    assert.equal(scopeDetailLine({ lastModifiedMs: NOW - 3 * DAY }, NOW), '3d');
  });

  test('a blank subject and hostile input paint nothing instead of throwing', () => {
    assert.equal(scopeDetailLine({ lastCommitSubject: '   ' }, NOW), '');
    assert.equal(scopeDetailLine(null, NOW), '');
    assert.equal(scopeDetailLine(undefined, NOW), '');
  });
});

describe('loadScopeDetail (S9)', () => {
  function runner(answers) {
    const calls = [];
    const run = async (args, options) => {
      calls.push({ args, options });
      const answer = answers[args[0]] || { status: 1, stdout: '', stderr: 'nope' };
      if (typeof answer === 'function') return answer();
      return answer;
    };
    return { run, calls };
  }

  test('runs the two fixed argv reads in the scope cwd and composes the detail', async () => {
    const { run, calls } = runner({
      'rev-list': { status: 0, stdout: '1\t2\n', stderr: '' },
      log: { status: 0, stdout: 'add the scope step\n\nbody\n', stderr: '' },
    });
    const detail = await loadScopeDetail({ run, cwd: '/w/a', comparison: 'main' });
    assert.deepEqual(detail, { comparison: 'main', ahead: 2, behind: 1, lastCommitSubject: 'add the scope step' });
    assert.deepEqual(calls.map((call) => call.args), [
      ['rev-list', '--left-right', '--count', 'main...HEAD'],
      ['log', '-1', '--format=%s'],
    ]);
    assert.deepEqual(calls.map((call) => call.options), [{ cwd: '/w/a' }, { cwd: '/w/a' }]);
  });

  test('a failed read leaves its fields absent instead of throwing', async () => {
    const allFail = await loadScopeDetail({
      run: async () => ({ status: 1, stdout: '9\t9', stderr: 'bad revision' }),
      cwd: '/w/a',
      comparison: 'origin/main',
    });
    assert.deepEqual(allFail, { comparison: 'origin/main' });

    const throwing = await loadScopeDetail({
      run: async () => { throw new Error('spawn failed'); },
      cwd: '/w/a',
      comparison: 'main',
    });
    assert.deepEqual(throwing, { comparison: 'main' });
  });

  test('a truncated, timed-out or malformed answer is unparsable', async () => {
    const base = {
      log: { status: 0, stdout: '', stderr: '' },
    };
    for (const range of [
      { status: 0, stdout: '1\t2\n', truncated: true },
      { status: 0, stdout: '1\t2\n', timedOut: true },
      { status: 0, stdout: 'not counts' },
      { status: 0 },
      { status: null, stdout: '1\t2' },
      null,
    ]) {
      const { run } = runner({ ...base, 'rev-list': range });
      const detail = await loadScopeDetail({ run, cwd: '/w/a', comparison: 'main' });
      assert.equal(detail.ahead, undefined);
      assert.equal(detail.behind, undefined);
      assert.deepEqual(detail, { comparison: 'main' });
    }
  });

  test('no comparison ref means no rev-list read, and no distance', async () => {
    const { run, calls } = runner({ log: { status: 0, stdout: 'subject\n' } });
    const detail = await loadScopeDetail({ run, cwd: '/w/a', comparison: '' });
    assert.deepEqual(detail, { lastCommitSubject: 'subject' });
    assert.deepEqual(calls.map((call) => call.args[0]), ['log']);
  });

  test('a missing runner and a missing stdout degrade instead of throwing', async () => {
    assert.deepEqual(await loadScopeDetail({ comparison: 'main' }), { comparison: 'main' });
    assert.deepEqual(await loadScopeDetail(), {});
    const { run } = runner({ log: { status: 0 }, 'rev-list': { status: 0, stdout: '0 0' } });
    assert.deepEqual(await loadScopeDetail({ run, cwd: '/w/a', comparison: 'main' }), {
      comparison: 'main',
      ahead: 0,
      behind: 0,
    });
  });
});

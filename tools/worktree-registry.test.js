'use strict';
// Which checkouts this package owns — the directory rule, with no document.
//
// S3/S4: `<git-common-dir>/pi-worktrees.json` is gone. A create always lands at
// `<repo-parent>/<repo-name>-worktrees/<odd>`, so the path answers what a stored row
// used to: which checkouts are ours and which were made outside. Every case here is a
// pure function of an explicit path and a `git worktree list` text; nothing reads or
// writes a file.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
	checkoutRows,
	findCheckoutByBranch,
	findCheckoutByPath,
	isInsideDirectory,
	isOwnedCheckout,
	outsideCheckouts,
	ownedCheckouts,
	parseWorktreePorcelain,
	worktreeDirectoryPath,
} = require('../lib/worktree-registry.js');

const MAIN_ROOT = '/work/demo';
const WORKTREES = '/work/demo-worktrees';

// ---- S3: the canonical directory is the rule ----

test('the canonical directory sits beside the main checkout and is named after it', () => {
	assert.equal(worktreeDirectoryPath(MAIN_ROOT), WORKTREES);
	assert.equal(worktreeDirectoryPath('/a/b/c'), '/a/b/c-worktrees');
});

test('a checkout under the canonical directory is ours; anything else is not', () => {
	assert.equal(isOwnedCheckout(`${WORKTREES}/alpha`, MAIN_ROOT), true);
	assert.equal(isOwnedCheckout(`${WORKTREES}/nested/beta`, MAIN_ROOT), true);
	assert.equal(isOwnedCheckout('/elsewhere/alpha', MAIN_ROOT), false);
	assert.equal(isOwnedCheckout('/work/demo-worktrees-other/alpha', MAIN_ROOT), false, 'a prefix is not the directory');
	assert.equal(isOwnedCheckout(MAIN_ROOT, MAIN_ROOT), false, 'the main checkout is never one of ours');
	assert.equal(isOwnedCheckout(undefined, MAIN_ROOT), false);
});

test('the listing is partitioned into ours and the outside worktrees, with the main checkout removed', () => {
	const entries = [
		{ path: MAIN_ROOT, branch: 'main' },
		{ path: `${WORKTREES}/alpha`, branch: 'feat/alpha' },
		{ path: '/elsewhere/beta', branch: 'feat/beta' },
	];
	assert.deepEqual(ownedCheckouts(entries.slice(1), MAIN_ROOT).map((entry) => entry.path), [`${WORKTREES}/alpha`]);
	assert.deepEqual(outsideCheckouts(entries.slice(1), MAIN_ROOT).map((entry) => entry.path), ['/elsewhere/beta']);
});

test('inside means the directory itself or a real descendant, never a sibling sharing the prefix', () => {
	assert.equal(isInsideDirectory('/work/demo-worktrees', WORKTREES), true);
	assert.equal(isInsideDirectory('/work/demo-worktrees/alpha', WORKTREES), true);
	assert.equal(isInsideDirectory('/work/demo-worktreesX/alpha', WORKTREES), false);
	assert.equal(isInsideDirectory('/work/demo', WORKTREES), false);
});

// ---- The rows the name resolvers use ----

test('a row is the path and the branch Git reports, and a detached checkout simply has no branch', () => {
	assert.deepEqual(
		checkoutRows([
			{ path: MAIN_ROOT, branch: 'main', head: 'abc' },
			{ path: `${WORKTREES}/alpha`, head: 'def', detached: true },
			{ branch: 'no-path' },
		]),
		[{ path: MAIN_ROOT, branch: 'main' }, { path: `${WORKTREES}/alpha` }],
	);
});

test('a path key must be absolute; a branch key matches its exact name', () => {
	const rows = checkoutRows([{ path: MAIN_ROOT, branch: 'main' }, { path: `${WORKTREES}/alpha`, branch: 'feat/alpha' }]);
	assert.equal(findCheckoutByPath(rows, MAIN_ROOT).branch, 'main');
	assert.equal(findCheckoutByPath(rows, 'demo'), null, 'a relative key names nothing');
	assert.equal(findCheckoutByPath(rows, '/elsewhere'), null);
	assert.equal(findCheckoutByBranch(rows, 'feat/alpha').path, `${WORKTREES}/alpha`);
	assert.equal(findCheckoutByBranch(rows, 'feat/nope'), null);
});

// ---- The one listing parser ----

test('git worktree list --porcelain parses in both spellings, main first and in listing order', () => {
	const text = [
		'worktree /work/demo',
		'HEAD 1a2b3c4d5e',
		'branch refs/heads/main',
		'',
		'worktree /work/demo-worktrees/alpha',
		'HEAD 5f6e7d8c9b',
		'detached',
		'',
	].join('\n');
	const entries = parseWorktreePorcelain(text);
	assert.deepEqual(entries, [
		{ path: '/work/demo', head: '1a2b3c4d5e', branch: 'main' },
		{ path: '/work/demo-worktrees/alpha', head: '5f6e7d8c9b', detached: true },
	]);
	assert.deepEqual(parseWorktreePorcelain(text.replaceAll('\n', '\0')), entries, 'the -z spelling parses the same');
	assert.deepEqual(parseWorktreePorcelain(''), []);
});

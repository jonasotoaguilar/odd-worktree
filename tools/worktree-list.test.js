'use strict';
// The agent-facing rendering of `worktree_list`: which rows the list shows, in which
// order and the exact text of every line. Every assertion goes through the module's
// public interface with the two inputs a real call produces — Git's own worktree
// listing and the canonical main root — so the text and `details` cannot drift.
//
// S2: the default view is the checkouts this package created plus the main one.
// S2/S3: `all` adds the worktrees Git knows outside `<repo-name>-worktrees`.
// S3: a row is its directory's basename (the ODD) and its branch — no `odd:` field, no
// date, no setup or hooks line, no stored state. A directory that exists is a worktree
// and one that does not is simply not listed.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
	renderWorktreeListText,
	worktreeListDetails,
	worktreeListFooters,
	worktreeListView,
} = require('../lib/worktree-list.js');

const MAIN_ROOT = '/work/demo';
const WORKTREES = '/work/demo-worktrees';
const PROJECT = 'demo';

/** One `git worktree list` entry: the shape lib/worktree-git.js parses. */
const entry = (path, branch, head = '1a2b3c4d5e') => (branch === null ? { path, head, detached: true } : { path, branch, head });

const MAIN = entry(MAIN_ROOT, 'main');

const viewOf = (input) => worktreeListView({
	entries: input.entries,
	mainRoot: MAIN_ROOT,
	project: PROJECT,
	all: input.all,
});

/** Every line is plain: no ANSI, no trailing spaces, no padding runs. */
function assertPlainLines(text) {
	assert.equal(text.includes('\u001b'), false, 'the text carries no ANSI escape');
	for (const line of text.split('\n')) {
		assert.equal(line.trimEnd(), line, `no trailing spaces: ${JSON.stringify(line)}`);
		assert.equal(line.includes('  '), false, `no padding run: ${JSON.stringify(line)}`);
	}
}

// ---- S2: the default view ----

test('prints project, path, the unnumbered main checkout and the created worktrees by name', () => {
	const view = viewOf({
		entries: [
			MAIN,
			entry(`${WORKTREES}/zeta`, 'feat/zeta'),
			entry(`${WORKTREES}/alpha`, 'feat/alpha'),
		],
	});
	assert.equal(view.text, [
		'project: demo',
		'path: /work/demo',
		'main: main 1a2b3c4d5e'.replace(' 1a2b3c4d5e', ' 1a2b3c4'),
		'1 alpha feat/alpha',
		'2 zeta feat/zeta',
	].join('\n'));
	assertPlainLines(view.text);
});

test('each row is the directory basename — the ODD — and the branch, and nothing else', () => {
	const view = viewOf({ entries: [MAIN, entry(`${WORKTREES}/worktree-surface`, 'feat/surface')] });
	const row = view.details.worktrees[1];
	assert.equal(row.name, 'worktree-surface', 'the ODD is the directory basename');
	assert.equal(row.branch, 'feat/surface');
	assert.deepEqual(Object.keys(row).sort(), ['branch', 'index', 'name', 'path'], 'no odd, no state, no date');
	assert.equal(/odd:/.test(view.text), false, 'the output carries no odd: field');
	assert.equal(/setup:|hooks:|metadata|ready|running|failed|skipped|interrupted|gone|missing|foreign/.test(view.text), false, 'no state vocabulary and no detail lines');
});

test('a linked worktree outside the canonical directory is hidden without all, and counted', () => {
	const view = viewOf({
		entries: [MAIN, entry(`${WORKTREES}/alpha`, 'feat/alpha'), entry('/elsewhere/other', 'feat/other')],
	});
	assert.equal(view.text.split('\n').includes('2 other feat/other'), false, 'the outside worktree is not listed');
	assert.equal(view.text.split('\n').at(-1), '1 worktrees outside the list (--all to list them)');
	assert.equal(view.details.hiddenOutside, 1);
});

test('a checkout Git no longer lists is simply absent, and a stale directory is absent too', () => {
	// Git's listing is the whole input: a directory that still sits under
	// `<repo-name>-worktrees` but is no longer a worktree is never shown, and no row
	// reports `gone`, `missing` or a date.
	const view = viewOf({ entries: [MAIN, entry(`${WORKTREES}/alpha`, 'feat/alpha')] });
	assert.equal(view.text.split('\n').length, 4, 'project, path, main and one row');
	assert.equal(view.details.worktrees.length, 2);
});

// ---- S2/S3: all lists the outside worktrees ----

test('all adds the worktrees outside the canonical directory, after ours and by name', () => {
	const view = viewOf({
		entries: [
			MAIN,
			entry(`${WORKTREES}/alpha`, 'feat/alpha'),
			entry('/elsewhere/beta', 'feat/beta'),
			entry('/elsewhere/gamma', null),
		],
		all: true,
	});
	assert.equal(view.text.split('\n').join('|'), [
		'project: demo',
		'path: /work/demo',
		'main: main 1a2b3c4',
		'1 alpha feat/alpha',
		'2 beta feat/beta',
		'3 gamma -',
	].join('|'));
	assert.deepEqual(worktreeListFooters(view.details), [], 'nothing is hidden when everything is listed');
	assert.equal('foreign' in view.details, false, 'no state field decides what a row is');
});

test('a detached checkout prints a dash instead of inventing a branch', () => {
	const view = viewOf({ entries: [MAIN, entry(`${WORKTREES}/alpha`, null)] });
	assert.equal(view.details.worktrees[1].branch, '-');
	assert.equal(view.text.split('\n').at(-1), '1 alpha -');
});

test('the main row prints first and unnumbered, as Git lists it', () => {
	const view = viewOf({ entries: [MAIN, entry(`${WORKTREES}/alpha`, 'feat/alpha')] });
	assert.equal(view.details.worktrees[0].path, MAIN_ROOT);
	assert.equal(view.details.worktrees[0].index, undefined);
	assert.equal(view.text.split('\n')[2], 'main: main 1a2b3c4');
});

// ---- The pieces ----

test('the footer counts only while something is hidden', () => {
	assert.deepEqual(worktreeListFooters({ hiddenOutside: 0 }), []);
	assert.deepEqual(worktreeListFooters({ hiddenOutside: 2 }), ['2 worktrees outside the list (--all to list them)']);
});

test('the text and the details are built from the same rows', () => {
	const details = worktreeListDetails({
		entries: [MAIN, entry(`${WORKTREES}/alpha`, 'feat/alpha')],
		mainRoot: MAIN_ROOT,
		project: PROJECT,
		all: false,
	});
	assert.equal(renderWorktreeListText(details), viewOf({ entries: [MAIN, entry(`${WORKTREES}/alpha`, 'feat/alpha')] }).text);
	assert.equal(details.worktrees.length, 2);
	assert.equal(details.path, MAIN_ROOT);
	assert.equal(details.project, PROJECT);
});

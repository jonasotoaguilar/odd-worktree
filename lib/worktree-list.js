'use strict';
// The agent-facing rendering of `worktree_list`.
//
// Git answers which checkouts exist and on which branch; lib/worktree-registry.js
// answers which of them this package created (the ones under
// `<repo-parent>/<repo-name>-worktrees`). This module only decides what a reader
// sees: the main checkout first and unnumbered, then this package's own checkouts in
// name order, then — with `all` — the worktrees Git knows outside the directory.
//
// A row is its directory's basename, which IS the ODD, and the branch Git reports.
// There is no `odd:` field, no date, no setup line, no hooks line and no stored
// state: a directory that exists is a worktree and one that does not is simply not
// listed (S2, S3). Nothing here reads the filesystem or spawns Git, and this module
// writes nothing at all.

const { basename } = require('node:path');
const { outsideCheckouts, ownedCheckouts } = require('./worktree-registry.js');

const strew = (value) => (typeof value === 'string' && value.length > 0 ? value : '-');

const compareText = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Worktrees print by name, so the order never depends on Git's own. */
function compareCheckout(a, b) {
	const named = compareText(basename(a.path), basename(b.path));
	return named === 0 ? compareText(a.path, b.path) : named;
}

function rowFor(entry, index) {
	return {
		index,
		name: basename(entry.path),
		path: entry.path,
		branch: strew(entry.branch),
	};
}

function mainRow(input, main) {
	return {
		name: basename(input.mainRoot ?? main.path),
		path: main.path,
		branch: strew(main.branch),
		shortSha: typeof main.head === 'string' ? main.head.slice(0, 7) : '',
	};
}

const samePath = (a, b) => a.length > 1 && b.length > 1 && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * The single structured truth behind both layers: the main row, the rows the view
 * prints in order, and how many outside worktrees the footer hides.
 */
function worktreeListDetails(input) {
	const all = input.all === true;
	const entries = Array.isArray(input.entries) ? input.entries : [];
	// `git worktree list` prints the main checkout first; that entry is the main row.
	const main = entries[0];
	const rest = entries.filter((entry) => entry !== main && !samePath(entry.path, main.path));
	const mainRoot = input.mainRoot ?? main.path;

	const worktrees = [mainRow(input, main)];
	for (const entry of ownedCheckouts(rest, mainRoot).sort(compareCheckout)) {
		worktrees.push(rowFor(entry, worktrees.length));
	}
	const outside = outsideCheckouts(rest, mainRoot).sort(compareCheckout);
	if (all) for (const entry of outside) worktrees.push(rowFor(entry, worktrees.length));

	return {
		project: input.project,
		path: main.path,
		all,
		worktrees,
		hiddenOutside: all ? 0 : outside.length,
	};
}

/** The footer the list prints while it hides outside worktrees, and only then. */
function worktreeListFooters(details) {
	if (!(details.hiddenOutside > 0)) return [];
	return [`${details.hiddenOutside} worktrees outside the list (--all to list them)`];
}

function mainLine(row) {
	const head = row.shortSha.length > 0 ? ` ${row.shortSha}` : '';
	return `main: ${row.branch}${head}`;
}

function rowLine(row) {
	return `${row.index} ${row.name} ${row.branch}`;
}

/** The agent-facing text: fixed field order, single spaces, no decoration. */
function renderWorktreeListText(details) {
	const lines = [`project: ${details.project}`, `path: ${details.path}`];
	for (const row of details.worktrees) {
		lines.push(row.index === undefined ? mainLine(row) : rowLine(row));
	}
	lines.push(...worktreeListFooters(details));
	return lines.join('\n');
}

/** Both presentation layers from one row list: the text an agent reads and the details a card renders. */
function worktreeListView(input) {
	const details = worktreeListDetails(input);
	return { text: renderWorktreeListText(details), details };
}

module.exports = {
	worktreeListDetails,
	worktreeListFooters,
	renderWorktreeListText,
	worktreeListView,
};

'use strict';
// Which checkouts this package owns — answered from the directory, with no file.
//
// The versioned list this module used to keep (`<git-common-dir>/pi-worktrees.json`)
// is gone (S3, S4): a create always lands at
// `<repo-parent>/<repo-name>-worktrees/<odd>`, so the canonical directory IS the
// record and the path already tells a checkout this package made from one that was
// made outside it. Nothing here reads, writes, locks or caches a file: the only
// inputs are Git's own worktree listing and the main root, and the only output is a
// verdict about a path.
//
// Git owns existence. `entries` are `git worktree list --porcelain -z` records
// ({path, branch, head, detached, bare}), main first; this module only partitions
// them and turns them into the flat `{branch, path}` rows the name resolvers in the
// extension use.

const { basename, dirname, isAbsolute, join, normalize, relative, resolve } = require('node:path');

/** S3: `<repo-parent>/<repo-name>-worktrees` — the one directory this package writes. */
function worktreeDirectoryPath(mainRoot) {
	return join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`);
}

/** The canonical form of a checkout path, for comparisons between two spellings. */
function canonicalCheckoutPath(value) {
	if (typeof value !== 'string' || value.length === 0) return null;
	return resolve(normalize(value));
}

/** True when `child` is `parent` or sits inside it; both sides are absolute. */
function isInsideDirectory(child, parent) {
	const resolvedChild = canonicalCheckoutPath(child);
	const resolvedParent = canonicalCheckoutPath(parent);
	if (resolvedChild === null || resolvedParent === null) return false;
	const comparable = process.platform === 'win32'
		? (value) => value.toLowerCase()
		: (value) => value;
	const rest = relative(comparable(resolvedParent), comparable(resolvedChild));
	return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/** The path a listing entry names, or null when the entry names none. */
function entryPath(entry) {
	return entry && typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : null;
}

/**
 * S3: the checkouts this package created — the ones under the canonical directory.
 * The main checkout is never one of them, even if the clone itself happens to sit
 * there; callers pass the listing without it.
 */
function ownedCheckouts(entries, mainRoot) {
	const directory = worktreeDirectoryPath(mainRoot);
	return (Array.isArray(entries) ? entries : []).filter((entry) => {
		const path = entryPath(entry);
		return path !== null && isInsideDirectory(path, directory);
	});
}

/** S2/S3: the worktrees Git knows outside the canonical directory. */
function outsideCheckouts(entries, mainRoot) {
	const directory = worktreeDirectoryPath(mainRoot);
	return (Array.isArray(entries) ? entries : []).filter((entry) => {
		const path = entryPath(entry);
		return path !== null && !isInsideDirectory(path, directory);
	});
}

/** One checkout this package created, by the path rule alone. */
function isOwnedCheckout(path, mainRoot) {
	const value = entryPath({ path });
	return value !== null && isInsideDirectory(value, worktreeDirectoryPath(mainRoot));
}

/**
 * The flat rows the name resolvers use: one per checkout Git lists, with the branch
 * Git reports (absent for a detached checkout). Nothing is stored, so a row is only
 * ever as true as the listing it came from.
 */
function checkoutRows(entries) {
	const rows = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		const path = entryPath(entry);
		if (path === null) continue;
		const row = { path };
		const branch = typeof entry.branch === 'string' && entry.branch.length > 0 ? entry.branch : null;
		if (branch !== null) row.branch = branch;
		rows.push(row);
	}
	return rows;
}

function samePath(a, b) {
	const left = canonicalCheckoutPath(a);
	const right = canonicalCheckoutPath(b);
	return left !== null && right !== null && (process.platform === 'win32'
		? left.toLowerCase() === right.toLowerCase()
		: left === right);
}

/** A row by absolute path; a relative key names nothing and never matches. */
function findCheckoutByPath(rows, target) {
	if (typeof target !== 'string' || !isAbsolute(target)) return null;
	return (Array.isArray(rows) ? rows : []).find((row) => row && samePath(row.path, target)) ?? null;
}

/** A row by branch name. */
function findCheckoutByBranch(rows, branch) {
	if (typeof branch !== 'string' || branch.length === 0) return null;
	return (Array.isArray(rows) ? rows : []).find((row) => row && row.branch === branch) ?? null;
}

/**
 * `git worktree list --porcelain` as entries, in listing order. Records are separated
 * by a blank line in the ordinary output and by a NUL in `-z` output, so both
 * spellings parse here. The create path and the extension's own listing both read
 * through this, so the two can never disagree about what Git answered.
 */
function parseWorktreePorcelain(text) {
	const entries = [];
	let current;
	const commit = () => {
		if (current) entries.push(current);
		current = undefined;
	};
	for (const rawLine of String(text ?? '').replaceAll('\0', '\n').split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			commit();
			continue;
		}
		const separator = line.indexOf(' ');
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? '' : line.slice(separator + 1);
		switch (field) {
			case 'worktree':
				commit();
				current = { path: value };
				break;
			case 'HEAD':
				if (current) current.head = value;
				break;
			case 'branch':
				if (current) current.branch = value.replace(/^refs\/heads\//, '');
				break;
			case 'detached':
				if (current) current.detached = true;
				break;
			case 'bare':
				if (current) current.bare = true;
				break;
		}
	}
	commit();
	return entries;
}

module.exports = {
	worktreeDirectoryPath,
	canonicalCheckoutPath,
	isInsideDirectory,
	ownedCheckouts,
	outsideCheckouts,
	isOwnedCheckout,
	checkoutRows,
	findCheckoutByPath,
	findCheckoutByBranch,
	parseWorktreePorcelain,
};

'use strict';
// The agent-facing rendering of `worktree_list`.
//
// The reconciliation answers what exists and which state each worktree is in; this
// module only decides what a reader sees: which rows the list shows, in which order,
// the exact wording of every line, and the structured `details` a card renders. The
// text and `details` are built from one row list, so the two layers cannot disagree.
//
// Nothing here reads the filesystem or spawns Git: every input is already computed by
// the reconciliation and the caller. This module writes nothing at all.

const { basename } = require('node:path');
const {
	currentWorktreeSetupStep,
	worktreeGoneDate,
	worktreeStateLabel,
} = require('./worktree-metadata.js');

/** States that print one detail line naming the setup step and its log (S23, S24). */
const SETUP_DETAIL_STATES = new Set([
	'running',
	'failed',
	'pending',
	'interrupted',
]);

const strew = (value) => value ?? '-';

function setupDetailLine(setup) {
	const step = currentWorktreeSetupStep(setup);
	const command = step?.command ?? setup.command;
	const logPath = step?.logPath ?? setup.logPath;
	if (command === undefined && logPath === undefined) return undefined;
	if (logPath === undefined) return `setup: ${command}`;
	if (command === undefined) return `log: ${logPath}`;
	return `setup: ${command} · log: ${logPath}`;
}

/**
 * What explains a `gone` record (S10): why its registration survives, then the date the
 * removal was first observed and the log a human would inspect.
 */
function goneDetailLines(entry) {
	const lines = [];
	if (entry.orphaned) lines.push('orphaned: path now hosts another worktree');
	else if (entry.goneReason === 'broken-registration') lines.push('registration broken: Git does not list it');
	if (entry.record) lines.push(`since ${worktreeGoneDate(entry.record)} · setup log kept`);
	return lines;
}

function detailLinesFor(entry) {
	switch (entry.state.id) {
		case 'gone':
			return goneDetailLines(entry);
		case 'foreign':
			return ['exists but belongs to another repository'];
		case 'missing':
			return ['path gone; git worktree prune'];
		default:
			break;
	}
	if (!entry.record || !SETUP_DETAIL_STATES.has(entry.state.id)) return [];
	const line = setupDetailLine(entry.record.setup);
	return line === undefined ? [] : [line];
}

/** The branch Git observes now; a record keeps the last branch it saw when Git cannot answer. */
function observedBranch(entry) {
	return entry.branch ?? entry.record?.lastSeen.branch ?? entry.record?.branchAtCreation ?? '-';
}

function rowFor(entry, index) {
	const record = entry.record;
	const row = {
		index,
		name: basename(entry.path),
		path: entry.path,
		branch: observedBranch(entry),
		state: entry.state,
		stateLabel: worktreeStateLabel(entry.state),
		provenance: record ? 'tool' : 'manual',
		detailLines: detailLinesFor(entry),
	};
	if (record) {
		row.odd = record.odd;
		row.branchAtCreation = record.branchAtCreation;
		row.setup = record.setup;
	}
	if (entry.orphaned) row.orphaned = true;
	if (entry.goneReason !== undefined) row.goneReason = entry.goneReason;
	return row;
}

const compareText = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Records print by creation date, and a foreign record after every record of this clone. */
function compareRecorded(a, b) {
	const foreign = (entry) => (entry.state.id === 'foreign' ? 1 : 0);
	if (foreign(a) !== foreign(b)) return foreign(a) - foreign(b);
	const created = compareText(a.record?.createdAt ?? '', b.record?.createdAt ?? '');
	return created === 0 ? compareText(a.path, b.path) : created;
}

/** Worktrees only Git knows print by name, so the order never depends on Git's own (S9). */
function compareManual(a, b) {
	const named = compareText(basename(a.path), basename(b.path));
	return named === 0 ? compareText(a.path, b.path) : named;
}

const withoutTrailingSeparator = (path) =>
	path.length > 1 && /[\\/]$/.test(path) ? path.replace(/[\\/]+$/, '') : path;

const isMain = (entry, main) =>
	entry.path === main.path || withoutTrailingSeparator(entry.path) === withoutTrailingSeparator(main.path);

/**
 * The single structured truth behind both layers (S15): the main row, the rows the view
 * prints in order, and how many rows each footer stands for.
 */
function worktreeListDetails(input) {
	const all = input.all === true;
	const entries = input.reconciliation.worktrees.filter((entry) => !isMain(entry, input.main));
	const recorded = entries.filter((entry) => entry.record !== undefined).sort(compareRecorded);
	const manual = entries.filter((entry) => entry.record === undefined).sort(compareManual);

	const worktrees = [mainRow(input)];
	let hiddenGone = 0;
	for (const entry of recorded) {
		if (entry.state.id === 'gone' && !all) {
			hiddenGone += 1;
			continue;
		}
		worktrees.push(rowFor(entry, worktrees.length));
	}
	if (all) for (const entry of manual) worktrees.push(rowFor(entry, worktrees.length));

	return {
		project: input.project,
		path: input.main.path,
		all,
		worktrees,
		hiddenOutside: all ? 0 : manual.length,
		hiddenGone,
	};
}

/**
 * The main worktree prints first and unnumbered (S14). It is never part of the metadata
 * list, so it carries no record, no detail line and `manual` provenance.
 */
function mainRow(input) {
	const entry = input.reconciliation.worktrees.find((candidate) => isMain(candidate, input.main));
	const state = entry?.state ?? { id: 'active-manual' };
	return {
		name: basename(input.main.path),
		path: input.main.path,
		branch: input.main.branch,
		shortSha: input.main.shortSha,
		state,
		stateLabel: worktreeStateLabel(state),
		provenance: entry?.record ? 'tool' : 'manual',
		detailLines: [],
	};
}

/** The footers S9 and S10 print, in that order, each only while its count is above zero. */
function worktreeListFooters(details) {
	const footers = [];
	if (details.hiddenOutside > 0) {
		footers.push(`${details.hiddenOutside} worktrees outside the list (--all to list them)`);
	}
	if (details.hiddenGone > 0) {
		footers.push(`${details.hiddenGone} registered worktree no longer exists (--all to list it)`);
	}
	return footers;
}

/**
 * The agent-facing text: one record per line, fixed field order, single spaces, no
 * decoration and no alignment (S15).
 */
function renderWorktreeListText(details) {
	const lines = [`project: ${details.project}`, `path: ${details.path}`];
	for (const row of details.worktrees) {
		lines.push(row.index === undefined ? mainLine(row) : rowLine(row));
		for (const detail of row.detailLines) lines.push(`  ${detail}`);
	}
	lines.push(...worktreeListFooters(details));
	return lines.join('\n');
}

function mainLine(row) {
	return `main: ${row.branch} ${strew(row.shortSha)} ${row.stateLabel}`;
}

function rowLine(row) {
	const was =
		row.branchAtCreation !== undefined && row.branchAtCreation !== row.branch
			? ` (was ${row.branchAtCreation})`
			: '';
	return `${row.index} ${row.name} ${row.branch}${was} odd: ${strew(row.odd)} ${row.stateLabel}`;
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

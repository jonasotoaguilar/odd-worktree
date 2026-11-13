'use strict';
// The agent-facing rendering of `worktree_list`: which rows the list shows, in which
// order, the exact text of every line and the structured `details` a card renders.
// Every assertion goes through the module's public interface on inputs a real
// reconciliation produced, so the text and `details` cannot drift from each other.

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { after } = require('node:test');

const {
	renderWorktreeListText,
	worktreeListDetails,
	worktreeListFooters,
	worktreeListView,
} = require('../lib/worktree-list.js');
const {
	reconcileWorktrees,
	readWorktreeMetadataStore,
	saveWorktreeMetadataRecords,
	worktreeMetadataFilePath,
	worktreeStateLabel,
} = require('../lib/worktree-metadata.js');

const AT = '2026-01-02T03:04:05.000Z';
const SECOND = '2026-02-01T00:00:00.000Z';
const THIRD = '2026-02-02T00:00:00.000Z';
const LATER = '2026-02-03T04:05:06.000Z';
const LAST = '2026-02-04T00:00:00.000Z';
const COMMON_DIR = '/clone/.git';
const PROJECT = 'gentle-shell';
const MAIN = { path: '/clone', branch: 'main', shortSha: '1a2b3c4' };
const MAIN_LINE = 'main: main 1a2b3c4 active · manual';

/** `present: false` reports the path absent; `adminDir` answers the administrative directory. */
function fakeEnvironment(paths) {
	return {
		stat: (path) => (paths[path] && paths[path].present !== false ? 'present' : 'absent'),
		realpath: (path) => (paths[path] && paths[path].present !== false ? path : undefined),
		adminDir: (path) => paths[path]?.adminDir,
	};
}

function recordFor(overrides = {}) {
	return {
		odd: 'worktree-tools',
		createdAt: AT,
		createdBy: 'session-1',
		adminId: 'worktree-tools',
		branchAtCreation: 'feat/worktree-tools',
		baseRef: 'main',
		hooks: [{ name: 'copy-inputs', status: 'applied', detail: '3 files' }],
		setup: {
			status: 'ready',
			steps: [{ command: 'pnpm install', status: 'ready', logPath: '/logs/setup.log', exitCode: 0, endedAt: AT }],
			jobId: 'job-1',
			command: 'pnpm install',
			logPath: '/logs/setup.log',
			exitCode: 0,
			endedAt: AT,
		},
		lastSeen: { at: AT, branch: 'feat/worktree-tools', status: 'active' },
		...overrides,
	};
}

function recordsOf(entries) {
	return Object.fromEntries(entries);
}

const now = () => new Date(LATER);

function viewOf(input) {
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment: input.environment,
		now,
		entries: input.entries,
		records: input.records,
	});
	return worktreeListView({ reconciliation, project: PROJECT, main: MAIN, all: input.all });
}

/** Every line is either plain or a detail line indented by exactly two spaces, never padded. */
function assertPlainLines(text) {
	assert.equal(text.includes('\u001b'), false, 'the text carries no ANSI escape');
	for (const line of text.split('\n')) {
		assert.equal(line.trimEnd(), line, `no trailing spaces: ${JSON.stringify(line)}`);
		if (line.startsWith('  ')) {
			assert.equal(line.startsWith('   '), false, `detail indented by two spaces: ${JSON.stringify(line)}`);
			assert.equal(line.slice(2).includes('  '), false, `no padding inside a detail: ${JSON.stringify(line)}`);
			continue;
		}
		assert.equal(line.includes('  '), false, `no padding run outside a detail line: ${JSON.stringify(line)}`);
	}
}

// ---- S9: the default view ----

test('prints project, path, an unnumbered main and the recorded worktrees in creation order', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const record = recordFor();
	const secondPath = '/clone-worktrees/second';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/worktree-tools' },
			{ path: secondPath, branch: 'feat/second' },
		],
		records: recordsOf([
			[worktreePath, record],
			[secondPath, recordFor({ createdAt: SECOND, adminId: 'second', odd: 'second-odd', branchAtCreation: 'feat/second' })],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
			[secondPath]: { adminDir: `${COMMON_DIR}/worktrees/second` },
		}),
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 worktree-tools feat/worktree-tools odd: worktree-tools ready',
		'2 second feat/second odd: second-odd ready',
	].join('\n'));
	assertPlainLines(view.text);

	assert.deepEqual(view.details, {
		project: PROJECT,
		path: MAIN.path,
		all: false,
		worktrees: [
			{
				name: 'clone',
				path: MAIN.path,
				branch: 'main',
				shortSha: '1a2b3c4',
				state: { id: 'active-manual' },
				stateLabel: 'active · manual',
				provenance: 'manual',
				detailLines: [],
			},
			{
				index: 1,
				name: 'worktree-tools',
				path: worktreePath,
				branch: 'feat/worktree-tools',
				branchAtCreation: 'feat/worktree-tools',
				odd: 'worktree-tools',
				state: { id: 'ready' },
				stateLabel: 'ready',
				provenance: 'tool',
				setup: record.setup,
				detailLines: [],
			},
			{
				index: 2,
				name: 'second',
				path: secondPath,
				branch: 'feat/second',
				branchAtCreation: 'feat/second',
				odd: 'second-odd',
				state: { id: 'ready' },
				stateLabel: 'ready',
				provenance: 'tool',
				setup: record.setup,
				detailLines: [],
			},
		],
		hiddenOutside: 0,
		hiddenGone: 0,
	});
});

test('hides worktrees outside the list and gone records behind their footers', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const manualPath = '/clone-worktrees/manual';
	const deletedPath = '/clone-worktrees/deleted';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/worktree-tools' },
			{ path: manualPath, branch: 'feat/manual' },
		],
		records: recordsOf([
			[worktreePath, recordFor()],
			[deletedPath, recordFor({
				createdAt: SECOND,
				adminId: 'deleted',
				odd: 'deleted-odd',
				branchAtCreation: 'feat/deleted',
				lastSeen: { at: AT, branch: 'feat/deleted', status: 'active' },
			})],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
			[manualPath]: { adminDir: `${COMMON_DIR}/worktrees/manual` },
		}),
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 worktree-tools feat/worktree-tools odd: worktree-tools ready',
		'1 worktrees outside the list (--all to list them)',
		'1 registered worktree no longer exists (--all to list it)',
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.hiddenOutside, 1);
	assert.equal(view.details.hiddenGone, 1);
	assert.deepEqual(view.details.worktrees.map((row) => row.index), [undefined, 1]);
});

test('prints only project, path and main for a clone whose only worktree is main', () => {
	const view = viewOf({
		entries: [{ path: MAIN.path, branch: 'main' }],
		records: {},
		environment: fakeEnvironment({ [MAIN.path]: { adminDir: COMMON_DIR } }),
	});

	assert.equal(view.text, [`project: ${PROJECT}`, `path: ${MAIN.path}`, MAIN_LINE].join('\n'));
	assertPlainLines(view.text);
	assert.deepEqual(view.details.worktrees.map((row) => row.name), ['clone']);
	assert.equal(view.details.worktrees[0].index, undefined);
	assert.equal(view.details.hiddenOutside, 0);
	assert.equal(view.details.hiddenGone, 0);
});

// ---- S9/S10: the all view ----

test('the all view lists outside worktrees and gone records as rows without footers', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const manualPath = '/clone-worktrees/manual';
	const deletedPath = '/clone-worktrees/deleted';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/worktree-tools' },
			{ path: manualPath, branch: 'feat/manual' },
		],
		records: recordsOf([
			[worktreePath, recordFor()],
			[deletedPath, recordFor({
				createdAt: SECOND,
				adminId: 'deleted',
				odd: 'deleted-odd',
				branchAtCreation: 'feat/deleted',
				lastSeen: { at: AT, branch: 'feat/deleted', status: 'active' },
			})],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
			[manualPath]: { adminDir: `${COMMON_DIR}/worktrees/manual` },
		}),
		all: true,
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 worktree-tools feat/worktree-tools odd: worktree-tools ready',
		'2 deleted feat/deleted odd: deleted-odd gone',
		`  since ${LATER} · setup log kept`,
		'3 manual feat/manual odd: - active · manual',
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.all, true);
	assert.equal(view.details.hiddenOutside, 0);
	assert.equal(view.details.hiddenGone, 0);
	assert.deepEqual(view.details.worktrees.map((row) => [row.index, row.provenance, row.odd]), [
		[undefined, 'manual', undefined],
		[1, 'tool', 'worktree-tools'],
		[2, 'tool', 'deleted-odd'],
		[3, 'manual', undefined],
	]);
});

// ---- S8/S10: moved and recycled paths ----

test('keeps the record of a moved worktree and reports a recycled path as orphaned and gone', () => {
	const oldPath = '/clone-worktrees/old';
	const newPath = '/clone-worktrees/new';
	const recycledPath = '/clone-worktrees/recycled';
	const environment = fakeEnvironment({
		[MAIN.path]: { adminDir: COMMON_DIR },
		[newPath]: { adminDir: `${COMMON_DIR}/worktrees/moved-1` },
		[recycledPath]: { adminDir: `${COMMON_DIR}/worktrees/recycled-second` },
	});
	const records = recordsOf([
		[oldPath, recordFor({ adminId: 'moved-1' })],
		[recycledPath, recordFor({
			createdAt: SECOND,
			adminId: 'recycled-first',
			branchAtCreation: 'feat/recycled-first',
			lastSeen: { at: AT, branch: 'feat/recycled-first', status: 'active' },
		})],
	]);
	const entries = [
		{ path: MAIN.path, branch: 'main' },
		{ path: newPath, branch: 'feat/worktree-tools' },
		{ path: recycledPath, branch: 'feat/other' },
	];

	const defaultView = viewOf({ entries, records, environment });
	assert.equal(defaultView.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 new feat/worktree-tools odd: worktree-tools ready',
		'1 worktrees outside the list (--all to list them)',
		'1 registered worktree no longer exists (--all to list it)',
	].join('\n'));
	assertPlainLines(defaultView.text);

	const allView = viewOf({ entries, records, environment, all: true });
	assert.equal(allView.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 new feat/worktree-tools odd: worktree-tools ready',
		'2 recycled feat/recycled-first odd: worktree-tools gone',
		'  orphaned: path now hosts another worktree',
		`  since ${LATER} · setup log kept`,
		'3 recycled feat/other odd: - active · manual',
	].join('\n'));
	assertPlainLines(allView.text);

	const orphaned = allView.details.worktrees.find((row) => row.index === 2);
	assert.ok(orphaned);
	assert.equal(orphaned.orphaned, true);
	assert.equal(orphaned.goneReason, 'recycled');
	assert.equal(orphaned.path, recycledPath);
	assert.equal(orphaned.stateLabel, worktreeStateLabel({ id: 'gone' }));
});

test('explains a gone record whose registration Git dropped', () => {
	const stalePath = '/clone-worktrees/stale';
	const view = viewOf({
		entries: [{ path: MAIN.path, branch: 'main' }],
		records: recordsOf([[stalePath, recordFor()]]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[stalePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
		}),
		all: true,
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 stale feat/worktree-tools odd: worktree-tools gone',
		'  registration broken: Git does not list it',
		`  since ${LATER} · setup log kept`,
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.worktrees[1].goneReason, 'broken-registration');
	assert.equal(view.details.worktrees[1].orphaned, undefined);
});

// ---- S13: records that belong to another repository ----

test('prints a foreign record in the default view with its own detail line', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const foreignPath = '/elsewhere/foreign';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/worktree-tools' },
		],
		records: recordsOf([
			[worktreePath, recordFor()],
			[foreignPath, recordFor({ createdAt: SECOND, odd: 'foreign-odd' })],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
			[foreignPath]: { adminDir: '/other-repo/.git/worktrees/worktree-tools' },
		}),
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 worktree-tools feat/worktree-tools odd: worktree-tools ready',
		'2 foreign feat/worktree-tools odd: foreign-odd foreign',
		'  exists but belongs to another repository',
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.hiddenOutside, 0);
	assert.equal(view.details.hiddenGone, 0);
	assert.equal(view.details.worktrees[2].stateLabel, 'foreign');
});

// ---- S11/S12: a worktree Git lists whose path is gone ----

test('prints a listed worktree whose path is gone as missing with the prune hint', () => {
	const absentPath = '/clone-worktrees/absent';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: absentPath, branch: 'feat/absent' },
		],
		records: recordsOf([[absentPath, recordFor({
			branchAtCreation: 'feat/absent',
			lastSeen: { at: AT, branch: 'feat/absent', status: 'active' },
		})]]),
		environment: fakeEnvironment({ [MAIN.path]: { adminDir: COMMON_DIR } }),
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 absent feat/absent odd: worktree-tools missing',
		'  path gone; git worktree prune',
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.worktrees[1].stateLabel, 'missing');
	assert.equal(view.details.hiddenGone, 0);
});

// ---- S8/S16: an observed branch that no longer matches the recorded one ----

test('marks a branch that changed after creation', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/renamed' },
		],
		records: recordsOf([[worktreePath, recordFor()]]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
		}),
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 worktree-tools feat/renamed (was feat/worktree-tools) odd: worktree-tools ready',
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.worktrees[1].branch, 'feat/renamed');
	assert.equal(view.details.worktrees[1].branchAtCreation, 'feat/worktree-tools');
});

// ---- S11/S23/S25: the setup states that are not ready ----

test('words one detail line for every setup state that is not ready', () => {
	const running = '/clone-worktrees/running';
	const failed = '/clone-worktrees/failed';
	const interrupted = '/clone-worktrees/interrupted';
	const skipped = '/clone-worktrees/skipped';
	const pending = '/clone-worktrees/pending';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			...[
				[running, 'feat/running'],
				[failed, 'feat/failed'],
				[interrupted, 'feat/interrupted'],
				[skipped, 'feat/skipped'],
				[pending, 'feat/pending'],
			].map(([path, branch]) => ({ path, branch })),
		],
		records: recordsOf([
			[running, recordFor({
				adminId: 'running',
				branchAtCreation: 'feat/running',
				setup: { status: 'running', steps: [{ command: 'pnpm install', status: 'running', logPath: '/logs/running.log' }] },
				lastSeen: { at: AT, branch: 'feat/running', status: 'active' },
			})],
			[failed, recordFor({
				createdAt: SECOND,
				adminId: 'failed',
				branchAtCreation: 'feat/failed',
				setup: { status: 'failed', steps: [], command: 'pnpm install', logPath: '/logs/failed.log', exitCode: 1, endedAt: AT },
				lastSeen: { at: AT, branch: 'feat/failed', status: 'active' },
			})],
			[interrupted, recordFor({
				createdAt: LATER,
				adminId: 'interrupted',
				branchAtCreation: 'feat/interrupted',
				setup: { status: 'interrupted', steps: [{ command: 'cargo fetch', status: 'interrupted', exitCode: 130 }] },
				lastSeen: { at: AT, branch: 'feat/interrupted', status: 'active' },
			})],
			[skipped, recordFor({
				createdAt: LAST,
				adminId: 'skipped',
				branchAtCreation: 'feat/skipped',
				setup: { status: 'skipped', steps: [], detail: 'no lockfile at root' },
				lastSeen: { at: AT, branch: 'feat/skipped', status: 'active' },
			})],
			[pending, recordFor({
				createdAt: THIRD,
				adminId: 'pending',
				branchAtCreation: 'feat/pending',
				setup: { status: 'pending', steps: [], detail: 'job limit reached', command: 'pnpm install', logPath: '/logs/pending.log' },
				lastSeen: { at: AT, branch: 'feat/pending', status: 'active' },
			})],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[running]: { adminDir: `${COMMON_DIR}/worktrees/running` },
			[failed]: { adminDir: `${COMMON_DIR}/worktrees/failed` },
			[interrupted]: { adminDir: `${COMMON_DIR}/worktrees/interrupted` },
			[skipped]: { adminDir: `${COMMON_DIR}/worktrees/skipped` },
			[pending]: { adminDir: `${COMMON_DIR}/worktrees/pending` },
		}),
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 running feat/running odd: worktree-tools running (pnpm install)',
		'  setup: pnpm install · log: /logs/running.log',
		'2 failed feat/failed odd: worktree-tools failed',
		'  setup: pnpm install · log: /logs/failed.log',
		'3 pending feat/pending odd: worktree-tools pending (job limit reached)',
		'  setup: pnpm install · log: /logs/pending.log',
		'4 interrupted feat/interrupted odd: worktree-tools interrupted',
		'  setup: cargo fetch',
		'5 skipped feat/skipped odd: worktree-tools skipped',
	].join('\n'));
	assertPlainLines(view.text);

	const pendingRow = view.details.worktrees.find((row) => row.name === 'pending');
	assert.ok(pendingRow);
	assert.deepEqual(pendingRow.state, { id: 'pending', reason: 'job limit reached' });
	assert.deepEqual(pendingRow.setup, {
		status: 'pending',
		steps: [],
		detail: 'job limit reached',
		command: 'pnpm install',
		logPath: '/logs/pending.log',
	});
	assert.equal(view.details.worktrees.find((row) => row.name === 'skipped')?.detailLines.length, 0);
});

// ---- S23: a setup whose session died reads as interrupted from a dead job ----

const scratchRoot = mkdtempSync(join(tmpdir(), 'gentle-worktree-list-'));
after(() => {
	rmSync(scratchRoot, { recursive: true, force: true });
});

test('renders a stale running setup as interrupted for a dead job and leaves the file byte-identical', () => {
	const storePath = worktreeMetadataFilePath(join(scratchRoot, 'clone'));
	const worktreePath = '/clone-worktrees/running';
	saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, recordFor({
		adminId: 'running',
		branchAtCreation: 'feat/running',
		setup: { status: 'running', steps: [{ command: 'pnpm install', status: 'running', logPath: '/logs/running.log' }], jobId: 'job-1' },
		lastSeen: { at: LATER, branch: 'feat/running', status: 'active' },
	})]]));
	const bytes = readFileSync(storePath, 'utf8');

	/** One whole listing: read the store, reconcile, render, then prove the file did not move. */
	const listing = (setupJobLiveness) => {
		const store = readWorktreeMetadataStore(storePath);
		assert.equal(store.status, 'valid');
		if (store.status !== 'valid') throw new Error('the store must decode');
		const reconciliation = reconcileWorktrees({
			commonDir: COMMON_DIR,
			environment: fakeEnvironment({
				[MAIN.path]: { adminDir: COMMON_DIR },
				[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/running` },
			}),
			now,
			entries: [{ path: MAIN.path, branch: 'main' }, { path: worktreePath, branch: 'feat/running' }],
			records: store.file.records,
			setupJobLiveness,
		});
		const view = worktreeListView({ reconciliation, project: PROJECT, main: MAIN });
		assert.equal(readFileSync(storePath, 'utf8'), bytes, 'S12: listing never rewrites the metadata');
		return { view, reconciliation };
	};

	const dead = listing(() => false);
	assert.equal(dead.view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		MAIN_LINE,
		'1 running feat/running odd: worktree-tools interrupted',
		'  setup: pnpm install · log: /logs/running.log',
	].join('\n'));
	assertPlainLines(dead.view.text);
	assert.equal(dead.reconciliation.changed, false);
	const [row] = dead.view.details.worktrees.filter((candidate) => candidate.index !== undefined);
	assert.deepEqual(row.state, { id: 'interrupted' });
	assert.equal(row.stateLabel, 'interrupted');
	assert.deepEqual(row.detailLines, ['setup: pnpm install · log: /logs/running.log']);

	// A live job keeps the exact expectations the running case already had.
	const live = listing((jobId) => jobId === 'job-1');
	assert.ok(live.view.text.includes('1 running feat/running odd: worktree-tools running (pnpm install)'));
	assert.equal(worktreeStateLabel(live.view.details.worktrees[1].state), 'running (pnpm install)');

	// No seam is not proof of death, so the state stays running.
	const unknown = listing();
	assert.equal(unknown.view.text, live.view.text);
	assert.deepEqual(unknown.view.details, live.view.details);
});

// ---- S9/S15: the layers behind the view ----

test('builds the text, the details and both footers from one row list', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const firstGone = '/clone-worktrees/first-gone';
	const secondGone = '/clone-worktrees/second-gone';
	const input = {
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/worktree-tools' },
			{ path: '/clone-worktrees/manual-one', branch: 'feat/manual-one' },
			{ path: '/clone-worktrees/manual-two', branch: 'feat/manual-two' },
		],
		records: recordsOf([
			[worktreePath, recordFor()],
			[firstGone, recordFor({ createdAt: SECOND, adminId: 'first-gone' })],
			[secondGone, recordFor({ createdAt: THIRD, adminId: 'second-gone' })],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
			['/clone-worktrees/manual-one']: { adminDir: `${COMMON_DIR}/worktrees/manual-one` },
			['/clone-worktrees/manual-two']: { adminDir: `${COMMON_DIR}/worktrees/manual-two` },
		}),
	};

	const details = worktreeListDetails({
		reconciliation: reconcileWorktrees({
			commonDir: COMMON_DIR,
			environment: input.environment,
			now,
			entries: input.entries,
			records: input.records,
		}),
		project: PROJECT,
		main: MAIN,
	});

	assert.equal(details.hiddenOutside, 2);
	assert.equal(details.hiddenGone, 2);
	assert.equal(renderWorktreeListText(details), viewOf(input).text, 'the text and the view come from the same rows');
	assert.deepEqual(worktreeListFooters(details), [
		'2 worktrees outside the list (--all to list them)',
		'2 registered worktree no longer exists (--all to list it)',
	]);
	assert.deepEqual(worktreeListFooters({ ...details, hiddenOutside: 0, hiddenGone: 0 }), [], 'a zero count prints no footer');
});

test('words the remaining shapes: an unknown branch, a log-only detail and a main with a record', () => {
	const failedPath = '/clone-worktrees/failed-log';
	const view = viewOf({
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: failedPath, branch: 'feat/failed' },
			{ path: '/clone-worktrees/bare' },
		],
		records: recordsOf([
			[MAIN.path, recordFor({ adminId: '.git', branchAtCreation: 'main' })],
			[failedPath, recordFor({
				createdAt: SECOND,
				adminId: 'failed-log',
				branchAtCreation: 'feat/failed',
				setup: { status: 'failed', steps: [], logPath: '/logs/only.log', exitCode: 1 },
			})],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[failedPath]: { adminDir: `${COMMON_DIR}/worktrees/failed-log` },
			['/clone-worktrees/bare']: { adminDir: `${COMMON_DIR}/worktrees/bare` },
		}),
		all: true,
	});

	assert.equal(view.text, [
		`project: ${PROJECT}`,
		`path: ${MAIN.path}`,
		'main: main 1a2b3c4 ready',
		'1 failed-log feat/failed odd: worktree-tools failed',
		'  log: /logs/only.log',
		'2 bare - odd: - active · manual',
	].join('\n'));
	assertPlainLines(view.text);
	assert.equal(view.details.worktrees[0].provenance, 'tool', 'the main row reports a record when one exists');
	assert.deepEqual(view.details.worktrees[0].detailLines, []);
});

// ---- S14/S15: indexes and stable, unpadded lines ----

test('numbers only the printed rows, restarts at 1 and repeats for identical input', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const deletedPath = '/clone-worktrees/deleted';
	const input = {
		entries: [
			{ path: MAIN.path, branch: 'main' },
			{ path: worktreePath, branch: 'feat/worktree-tools' },
			{ path: '/clone-worktrees/manual', branch: 'feat/manual' },
		],
		records: recordsOf([
			[worktreePath, recordFor()],
			[deletedPath, recordFor({
				createdAt: SECOND,
				adminId: 'deleted',
				branchAtCreation: 'feat/deleted',
				lastSeen: { at: AT, branch: 'feat/deleted', status: 'active' },
			})],
		]),
		environment: fakeEnvironment({
			[MAIN.path]: { adminDir: COMMON_DIR },
			[worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` },
			[deletedPath]: { adminDir: `${COMMON_DIR}/worktrees/manual` },
			['/clone-worktrees/manual']: { adminDir: `${COMMON_DIR}/worktrees/manual` },
		}),
		all: true,
	};

	const first = viewOf(input);
	const second = viewOf(input);

	assert.deepEqual(first.details, second.details);
	assert.equal(first.text, second.text);
	assertPlainLines(first.text);
	assert.deepEqual(
		first.text.split('\n').filter((line) => /^\d+ /.test(line)).map((line) => line.split(' ')[0]),
		['1', '2', '3'],
	);
	assert.deepEqual(first.details.worktrees.map((row) => row.index), [undefined, 1, 2, 3]);

	// The default view renumbers the rows it still prints; no index is reused across views.
	const defaultView = viewOf({ ...input, all: false });
	assert.deepEqual(defaultView.details.worktrees.map((row) => [row.index, row.name]), [
		[undefined, 'clone'],
		[1, 'worktree-tools'],
	]);
});

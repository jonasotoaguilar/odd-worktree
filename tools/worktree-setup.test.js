'use strict';
// The setup chain of `worktree_create` (S20, S21, S24): the closed command table the
// lockfiles select, the frozen-flag rule, the skip reasons, and the two sentences the
// completion notice is built from. Nothing here runs a package manager: the directory
// listing and the PATH probe are injected seams.
//
// S1/S3: there is no persisted setup state, so there is no state machine, no job label
// and no record write to test here — the task that runs the plan owns those outcomes
// and its own suite pins them.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
	WORKTREE_SETUP_DISABLED_DETAIL,
	WORKTREE_SETUP_NOTICE_TYPE,
	WORKTREE_SETUP_RULES,
	formatJobDuration,
	resolveWorktreeSetupPlan,
	worktreeSetupFailureText,
	worktreeSetupReadyText,
	worktreeSetupRuleFor,
} = require('../lib/worktree-setup.js');

// ---- S21: the command table ----

function rootSeam(entries, binaries = []) {
	const asked = [];
	const roots = [];
	return {
		asked,
		roots,
		seam: {
			async entries(root) {
				roots.push(root);
				return entries;
			},
			async hasBinary(binary) {
				asked.push(binary);
				return binaries.includes(binary);
			},
		},
	};
}

function planFor(entries, binaries, copiedChanges = 0) {
	const { seam, asked, roots } = rootSeam(entries, binaries);
	return { promise: resolveWorktreeSetupPlan({ root: '/work/demo-worktrees/alpha', copiedChanges, seam }), asked, roots };
}

test('S21: every entry of the table names its lockfiles, its binary and its steps', () => {
	assert.ok(WORKTREE_SETUP_RULES.length > 0);
	for (const rule of WORKTREE_SETUP_RULES) {
		assert.ok(Array.isArray(rule.lockfiles) && Array.isArray(rule.binaries) && typeof rule.steps === 'function');
	}
});

test('S21: pnpm-lock.yaml selects `pnpm install` and is the first match', async () => {
	const { promise, asked, roots } = planFor(['pnpm-lock.yaml', 'package-lock.json'], ['pnpm', 'npm']);
	const plan = await promise;
	assert.deepEqual(plan, { steps: ['pnpm install'] });
	assert.deepEqual(asked, ['pnpm'], 'the first matching entry decides, and only its binary is probed');
	assert.deepEqual(roots, ['/work/demo-worktrees/alpha']);
});

test('S21: requirements.txt creates a virtual environment before installing into it', async () => {
	const plan = await planFor(['requirements.txt'], ['python3']).promise;
	assert.deepEqual(plan.steps, ['python3 -m venv .venv', '.venv/bin/python -m pip install -r requirements.txt']);
	const windows = await resolveWorktreeSetupPlan({
		root: '/x',
		copiedChanges: 0,
		platform: 'win32',
		seam: rootSeam(['requirements.txt'], ['python3']).seam,
	});
	assert.deepEqual(windows.steps, ['python3 -m venv .venv', '.venv/Scripts/python -m pip install -r requirements.txt']);
});

test('S21: the table order decides the first match, never the host’s preference', async () => {
	const plan = await planFor(['yarn.lock', 'package-lock.json'], ['yarn', 'npm']).promise;
	assert.deepEqual(plan.steps, ['yarn install --immutable']);
});

test('S21: a frozen flag is used only when copy_changes copied nothing', async () => {
	assert.deepEqual((await planFor(['package-lock.json'], ['npm'], 0).promise).steps, ['npm ci']);
	assert.deepEqual((await planFor(['package-lock.json'], ['npm'], 2).promise).steps, ['npm install']);
	assert.deepEqual((await planFor(['yarn.lock'], ['yarn'], 0).promise).steps, ['yarn install --immutable']);
	assert.deepEqual((await planFor(['yarn.lock'], ['yarn'], 1).promise).steps, ['yarn install']);
});

test('S21: a .NET project file selects `dotnet restore`', async () => {
	const plan = await planFor(['App.sln'], ['dotnet']).promise;
	assert.deepEqual(plan.steps, ['dotnet restore']);
});

test('S21: no lockfile at the root skips with its own reason', async () => {
	const { promise, asked } = planFor(['README.md'], ['npm']);
	assert.deepEqual(await promise, { steps: [], detail: 'no lockfile at root' });
	assert.deepEqual(asked, [], 'nothing is probed when no entry matched');
});

test('S21: a missing binary skips and never falls back to another package manager', async () => {
	const { promise, asked } = planFor(['pnpm-lock.yaml', 'package-lock.json'], ['npm']);
	assert.deepEqual(await promise, { steps: [], detail: 'pnpm not found' });
	assert.deepEqual(asked, ['pnpm'], 'the second entry is never tried');
});

test('S21: the rule the table exposes is the same one the resolver uses', () => {
	const rule = worktreeSetupRuleFor(['pnpm-lock.yaml']);
	assert.equal(rule, WORKTREE_SETUP_RULES[0]);
	assert.equal(worktreeSetupRuleFor(['nothing']), undefined);
});

// ---- S24: the sentences and the vocabulary ----

test('S20/S24: the constants the notice is built from are the ones the contract names', () => {
	assert.equal(WORKTREE_SETUP_NOTICE_TYPE, 'gentle-worktree.setup');
	assert.equal(WORKTREE_SETUP_DISABLED_DETAIL, 'setup is not enabled for this repository');
});

test('S24: the ready and failure texts are the exact sentences the agent reads', () => {
	assert.equal(
		worktreeSetupReadyText({ name: 'demo', steps: 1, durationMs: 65_000 }),
		'worktree setup ready · demo · 1 step (1m 5s)',
	);
	assert.equal(
		worktreeSetupFailureText({ name: 'demo', command: 'pnpm install', exitCode: 1, logPath: '/tmp/log' }),
		[
			'worktree setup failed · demo · pnpm install exited 1',
			'log: /tmp/log',
			'worktree is not ready yet; re-run setup or inspect the log.',
		].join('\n'),
	);
});

test('S24: a duration is spelled in seconds, minutes and hours', () => {
	assert.equal(formatJobDuration(0), '0s');
	assert.equal(formatJobDuration(59_400), '59s');
	assert.equal(formatJobDuration(65_000), '1m 5s');
	assert.equal(formatJobDuration(3_723_000), '1h 2m');
});

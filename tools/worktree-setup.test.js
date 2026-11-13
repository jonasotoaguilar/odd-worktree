'use strict';
// The asynchronous setup chain of `worktree_create` (S20 to S26): the closed command
// table the lockfiles select, the frozen-flag rule, the skip reasons, the state
// written before every step starts, the one notification of S24 and the job-limit
// path of S25. Nothing here runs a package manager: the lockfile registry and the
// job registry are injected seams, and the chain reaches the world through them only.

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
	WORKTREE_SETUP_DISABLED_DETAIL,
	WORKTREE_SETUP_JOB_LABEL_PREFIX,
	WORKTREE_SETUP_JOB_LIMIT_DETAIL,
	WORKTREE_SETUP_NOTICE_TYPE,
	WORKTREE_SETUP_NO_REGISTRY_DETAIL,
	WORKTREE_SETUP_REGISTRY_CHANNEL,
	WORKTREE_SETUP_RULES,
	createWorktreeSetupChain,
	isWorktreeSetupJobLabel,
	isWorktreeSetupJobLimit,
	isWorktreeSetupRegistryAnnouncement,
	recordWorktreeSetup,
	resolveWorktreeSetupPlan,
	skippedWorktreeSetup,
	worktreeCreateSetupLine,
	worktreeSetupFailureText,
	worktreeSetupJobLabel,
	worktreeSetupReadyText,
	worktreeSetupRuleFor,
	worktreeSetupSummary,
} = require('../lib/worktree-setup.js');
const {
	createWorktreeMetadataRecord,
	readWorktreeMetadataStore,
	saveWorktreeMetadataRecords,
	worktreeMetadataFilePath,
} = require('../lib/worktree-metadata.js');

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

async function resolve(entries, binaries, options = {}) {
	const recording = rootSeam(entries, binaries);
	const plan = await resolveWorktreeSetupPlan({
		root: '/worktrees/repo-worktrees/worktree-tools',
		copiedChanges: options.copiedChanges ?? 0,
		seam: recording.seam,
		...(options.platform === undefined ? {} : { platform: options.platform }),
	});
	return { ...plan, asked: recording.asked, roots: recording.roots };
}

const TABLE = [
	{ name: 'pnpm', lockfiles: ['pnpm-lock.yaml'], binaries: ['pnpm'], steps: ['pnpm install'] },
	{ name: 'yarn', lockfiles: ['yarn.lock'], binaries: ['yarn'], steps: ['yarn install --immutable'] },
	{ name: 'npm', lockfiles: ['package-lock.json'], binaries: ['npm'], steps: ['npm ci'] },
	{ name: 'npm shrinkwrap', lockfiles: ['npm-shrinkwrap.json'], binaries: ['npm'], steps: ['npm ci'] },
	{ name: 'bun', lockfiles: ['bun.lock'], binaries: ['bun'], steps: ['bun install --frozen-lockfile'] },
	{ name: 'bun binary lockfile', lockfiles: ['bun.lockb'], binaries: ['bun'], steps: ['bun install --frozen-lockfile'] },
	{ name: 'cargo', lockfiles: ['Cargo.toml'], binaries: ['cargo'], steps: ['cargo fetch'] },
	{ name: 'go', lockfiles: ['go.mod'], binaries: ['go'], steps: ['go mod download'] },
	{ name: 'uv', lockfiles: ['uv.lock'], binaries: ['uv'], steps: ['uv sync'] },
	{ name: 'poetry', lockfiles: ['poetry.lock'], binaries: ['poetry'], steps: ['poetry install'] },
	{ name: 'pipenv', lockfiles: ['Pipfile.lock'], binaries: ['pipenv'], steps: ['pipenv install'] },
	{ name: 'bundle', lockfiles: ['Gemfile.lock'], binaries: ['bundle'], steps: ['bundle install'] },
	{ name: 'composer', lockfiles: ['composer.lock'], binaries: ['composer'], steps: ['composer install'] },
	{ name: 'mix', lockfiles: ['mix.lock'], binaries: ['mix'], steps: ['mix deps.get'] },
	{ name: 'flutter', lockfiles: ['pubspec.lock'], binaries: ['flutter'], steps: ['flutter pub get'] },
	{ name: 'dotnet solution', lockfiles: ['App.sln'], binaries: ['dotnet'], steps: ['dotnet restore'] },
	{ name: 'dotnet project', lockfiles: ['App.csproj'], binaries: ['dotnet'], steps: ['dotnet restore'] },
];

for (const entry of TABLE) {
	test(`S21: ${entry.name} resolves ${entry.steps.join(' then ')} from the worktree root`, async () => {
		const plan = await resolve(entry.lockfiles, entry.binaries);

		assert.deepEqual(plan.steps, entry.steps);
		assert.equal(plan.detail, undefined, 'a resolved chain has no skip reason');
		assert.deepEqual(plan.roots, ['/worktrees/repo-worktrees/worktree-tools'], 'the lockfile is read at the worktree root');
		assert.deepEqual(plan.asked, entry.binaries, "only this rule's binary is asked for");
	});
}

test('S21: requirements.txt creates a virtual environment before installing into it', async () => {
	const posix = await resolve(['requirements.txt'], ['python3']);
	assert.deepEqual(posix.steps, ['python3 -m venv .venv', '.venv/bin/python -m pip install -r requirements.txt']);

	const windows = await resolve(['requirements.txt'], ['python3'], { platform: 'win32' });
	assert.deepEqual(windows.steps, ['python3 -m venv .venv', '.venv/Scripts/python -m pip install -r requirements.txt']);
});

test("S21: the table order decides the first match, never the host's preference", async () => {
	const pnpmFirst = await resolve(['package-lock.json', 'pnpm-lock.yaml'], ['pnpm', 'npm']);
	assert.deepEqual(pnpmFirst.steps, ['pnpm install'], 'pnpm precedes npm in the closed table');

	const yarnFirst = await resolve(['package-lock.json', 'yarn.lock'], ['yarn', 'npm']);
	assert.deepEqual(yarnFirst.steps, ['yarn install --immutable'], 'yarn precedes npm in the closed table');
	assert.deepEqual(yarnFirst.asked, ['yarn'], "the losing rule's binary is never probed");
});

test('S21: a frozen flag is used only when copy_changes copied nothing', async () => {
	assert.deepEqual((await resolve(['yarn.lock'], ['yarn'], { copiedChanges: 0 })).steps, ['yarn install --immutable']);
	assert.deepEqual((await resolve(['yarn.lock'], ['yarn'], { copiedChanges: 2 })).steps, ['yarn install']);
	assert.deepEqual((await resolve(['package-lock.json'], ['npm'], { copiedChanges: 0 })).steps, ['npm ci']);
	assert.deepEqual((await resolve(['package-lock.json'], ['npm'], { copiedChanges: 1 })).steps, ['npm install']);
	assert.deepEqual((await resolve(['pnpm-lock.yaml'], ['pnpm'], { copiedChanges: 3 })).steps, ['pnpm install']);
	assert.deepEqual(
		(await resolve(['bun.lock'], ['bun'], { copiedChanges: 3 })).steps,
		['bun install --frozen-lockfile'],
		"S21 spells bun's flag in the table, so it never depends on copy_changes",
	);
});

test('S21: no lockfile at the root skips with its own reason', async () => {
	const plan = await resolve(['tracked.txt', 'src', 'README.md'], ['pnpm', 'npm']);

	assert.deepEqual(plan.steps, []);
	assert.equal(plan.detail, 'no lockfile at root');
	assert.deepEqual(plan.asked, [], 'no binary is probed when no rule matched');
});

test('S21: a missing binary skips and never falls back to another package manager', async () => {
	const pnpm = await resolve(['pnpm-lock.yaml', 'package-lock.json'], ['npm']);
	assert.deepEqual(pnpm.steps, []);
	assert.equal(pnpm.detail, 'pnpm not found');
	assert.deepEqual(pnpm.asked, ['pnpm'], 'npm is never asked, so the chain cannot fall back to it');

	const yarn = await resolve(['yarn.lock'], []);
	assert.equal(yarn.detail, 'yarn not found');
	const dotnet = await resolve(['App.sln'], []);
	assert.equal(dotnet.detail, 'dotnet not found');
});

test('S21: the rule the table exposes is the same one the resolver uses', () => {
	assert.equal(worktreeSetupRuleFor(['pnpm-lock.yaml'])?.binaries[0], 'pnpm');
	assert.equal(worktreeSetupRuleFor(['App.vbproj'])?.steps({ copiedChanges: 0, platform: 'linux' })[0], 'dotnet restore');
	assert.equal(worktreeSetupRuleFor(['APP.SLN'])?.binaries[0], 'dotnet', 'the project-file suffix is matched without case');
	assert.equal(worktreeSetupRuleFor(['tracked.txt']), undefined);
});

// ---- S20 and S16: what the create prints ----

test("S16/S21: the create's setup line spells the state and the not-ready advice", () => {
	assert.equal(
		worktreeCreateSetupLine(skippedWorktreeSetup('no lockfile at root')),
		'setup: skipped (no lockfile at root) · worktree is not ready yet',
	);
	assert.equal(
		worktreeCreateSetupLine({ status: 'skipped', steps: [], detail: 'pnpm not found' }),
		'setup: skipped (pnpm not found) · worktree is not ready yet',
	);
	assert.equal(
		worktreeCreateSetupLine({ status: 'running', steps: [], command: 'pnpm install' }),
		'setup: running (pnpm install) · worktree is not ready yet',
	);
	assert.equal(
		worktreeCreateSetupLine({ status: 'pending', steps: [], detail: WORKTREE_SETUP_JOB_LIMIT_DETAIL }),
		'setup: pending (job limit reached) · worktree is not ready yet',
	);
	assert.equal(worktreeCreateSetupLine({ status: 'pending', steps: [] }), 'setup: pending · worktree is not ready yet');
	assert.equal(worktreeCreateSetupLine({ status: 'ready', steps: [] }), 'setup: ready', 'only a ready chain omits the advice');
	assert.equal(worktreeSetupSummary({ status: 'failed', steps: [] }), 'failed');
	assert.equal(worktreeSetupSummary({ status: 'interrupted', steps: [] }), 'interrupted');
});

// ---- S22/S24: the label, the channel and the predicate ----

test('S22: every step job carries the worktree setup label', () => {
	assert.equal(worktreeSetupJobLabel('worktree-tools'), 'worktree setup · worktree-tools');
	assert.equal(isWorktreeSetupJobLabel('worktree setup · worktree-tools'), true);
	assert.equal(isWorktreeSetupJobLabel('CI for PR 1860'), false, 'a bash_background label is never a setup job');
	assert.equal(isWorktreeSetupJobLabel('monitor · deploy'), false);
});

test('S22: the registry announcement carries one session and its own registry', () => {
	assert.equal(WORKTREE_SETUP_REGISTRY_CHANNEL, 'gentle-ai:worktree-setup-registry');
	const registry = { start: () => ({ id: 'job-1', outputPath: '/logs/job-1.log' }) };
	assert.equal(isWorktreeSetupRegistryAnnouncement({ sessionId: 'session-1', registry }), true);
	assert.equal(isWorktreeSetupRegistryAnnouncement({ sessionId: 'session-1' }), false);
	assert.equal(isWorktreeSetupRegistryAnnouncement({ registry }), false);
	assert.equal(isWorktreeSetupRegistryAnnouncement(undefined), false);
});

test('S24: the ready and failure texts are the exact sentences the agent reads', () => {
	assert.equal(
		worktreeSetupReadyText({ name: 'worktree-tools', steps: 1, durationMs: 12_000 }),
		'worktree setup ready · worktree-tools · 1 step (12s)',
	);
	assert.equal(
		worktreeSetupReadyText({ name: 'worktree-tools', steps: 2, durationMs: 125_000 }),
		'worktree setup ready · worktree-tools · 2 steps (2m 5s)',
	);
	assert.equal(
		worktreeSetupFailureText({ name: 'worktree-tools', command: 'pnpm install', exitCode: 2, logPath: '/logs/job-4.log' }),
		[
			'worktree setup failed · worktree-tools · pnpm install exited 2',
			'log: /logs/job-4.log',
			'worktree is not ready yet; re-run setup or inspect the log.',
		].join('\n'),
	);
});

test("S25: only the registry's running-limit refusal is a limit refusal", () => {
	assert.equal(isWorktreeSetupJobLimit(new Error('25 background jobs are already running; stop one with job_stop first.')), true);
	assert.equal(isWorktreeSetupJobLimit(new Error('shell refused to start')), false);
	assert.equal(isWorktreeSetupJobLimit('25 background jobs are already running'), false);
});

// ---- The branches the constants and the closed table decide ----

test('S20/S24: a chain that never ran names its own reason, and the constants are the ones the contract names', () => {
	assert.equal(WORKTREE_SETUP_NOTICE_TYPE, 'gentle-worktree.setup');
	assert.equal(WORKTREE_SETUP_JOB_LABEL_PREFIX, 'worktree setup · ');
	assert.equal(WORKTREE_SETUP_DISABLED_DETAIL, 'setup is not enabled for this repository');
	assert.equal(WORKTREE_SETUP_NO_REGISTRY_DETAIL, 'no background job registry in this session');
	assert.equal(
		worktreeCreateSetupLine(skippedWorktreeSetup(WORKTREE_SETUP_DISABLED_DETAIL)),
		'setup: skipped (setup is not enabled for this repository) · worktree is not ready yet',
	);
	assert.equal(
		worktreeCreateSetupLine({ status: 'pending', steps: [], detail: WORKTREE_SETUP_NO_REGISTRY_DETAIL }),
		'setup: pending (no background job registry in this session) · worktree is not ready yet',
	);
	assert.equal(worktreeSetupSummary({ status: 'running', steps: [] }), 'running', 'a running chain with no command still says running');
	assert.deepEqual(WORKTREE_SETUP_RULES[0].lockfiles, ['pnpm-lock.yaml'], 'pnpm is the first entry of the closed table');
	assert.deepEqual(WORKTREE_SETUP_RULES.at(-1).suffixes, ['.sln', '.csproj', '.fsproj', '.vbproj']);
});

test('S24: a duration of an hour or more is spelled in hours', () => {
	assert.equal(
		worktreeSetupReadyText({ name: 'worktree-tools', steps: 1, durationMs: 3_780_000 }),
		'worktree setup ready · worktree-tools · 1 step (1h 3m)',
	);
	assert.equal(
		worktreeSetupReadyText({ name: 'worktree-tools', steps: 3, durationMs: 60_000 }),
		'worktree setup ready · worktree-tools · 3 steps (1m 0s)',
	);
});

// ---- S23/S24/S25: the chain ----

const CHAIN_NOW = Date.UTC(2026, 0, 1, 9, 0, 0);

function chainFixture(commands, options = {}) {
	let clock = CHAIN_NOW;
	const persisted = [];
	const submitted = [];
	const atStart = [];
	const notified = [];
	const chain = createWorktreeSetupChain({
		path: '/worktrees/repo-worktrees/worktree-tools',
		name: 'worktree-tools',
		sessionId: 'session-1',
		commands,
		persist: (setup) => {
			persisted.push(structuredClone(setup));
		},
		jobs: {
			start: (request) => {
				if (options.startError) throw options.startError;
				submitted.push({ ...request });
				atStart.push(structuredClone(persisted.at(-1)));
				return { id: `job-${submitted.length}`, outputPath: `/logs/job-${submitted.length}.log` };
			},
		},
		notify: (text) => {
			notified.push(text);
		},
		now: () => new Date(clock),
	});
	return {
		persisted,
		submitted,
		atStart,
		notified,
		chain,
		advance: (ms) => {
			clock += ms;
		},
	};
}

test("S23: the running state is persisted before the step's job starts", () => {
	const fixture = chainFixture(['pnpm install']);

	const run = fixture.chain.start();

	assert.deepEqual(
		fixture.submitted,
		[
			{
				command: 'pnpm install',
				cwd: '/worktrees/repo-worktrees/worktree-tools',
				ownerSessionId: 'session-1',
				label: 'worktree setup · worktree-tools',
			},
		],
		'S22: one job per step, in the new worktree, owned by this session',
	);
	const startedAt = new Date(CHAIN_NOW).toISOString();
	assert.deepEqual(
		fixture.atStart[0],
		{
			status: 'running',
			steps: [{ command: 'pnpm install', status: 'running', startedAt }],
			command: 'pnpm install',
		},
		'S23: the record says running before anything starts, with no job id yet',
	);
	assert.deepEqual(
		fixture.persisted.at(-1),
		{
			status: 'running',
			steps: [{ command: 'pnpm install', status: 'running', startedAt, logPath: '/logs/job-1.log' }],
			command: 'pnpm install',
			jobId: 'job-1',
			logPath: '/logs/job-1.log',
		},
		"the job's own log path is stored as soon as the registry answers",
	);
	assert.deepEqual(run, { setup: fixture.persisted.at(-1), jobId: 'job-1' });
	assert.deepEqual(fixture.notified, [], 'S24: a step that has not settled reports nothing');
});

test("S24: the last step's exit produces exactly one notification and a ready record", () => {
	const fixture = chainFixture(['pnpm install']);
	const run = fixture.chain.start();
	assert.equal(run.jobId, 'job-1');

	fixture.advance(12_000);
	const endedAt = new Date(CHAIN_NOW + 12_000);
	const settled = fixture.chain.settle('job-1', 0, endedAt);

	assert.deepEqual(fixture.notified, ['worktree setup ready · worktree-tools · 1 step (12s)']);
	const ready = {
		status: 'ready',
		steps: [
			{
				command: 'pnpm install',
				status: 'ready',
				startedAt: new Date(CHAIN_NOW).toISOString(),
				logPath: '/logs/job-1.log',
				exitCode: 0,
				endedAt: endedAt.toISOString(),
			},
		],
		command: 'pnpm install',
		logPath: '/logs/job-1.log',
		exitCode: 0,
		endedAt: endedAt.toISOString(),
	};
	assert.deepEqual(settled, { setup: ready });
	assert.deepEqual(fixture.persisted.at(-1), ready, 'the record is ready and carries the log and the exit');
	assert.equal(fixture.chain.settle('job-1', 0, endedAt), undefined, 'one settlement reports one notification');
	assert.deepEqual(fixture.notified, ['worktree setup ready · worktree-tools · 1 step (12s)']);
});

test('S23/S24: steps run one after another, and only the last one notifies', () => {
	const fixture = chainFixture(['python3 -m venv .venv', '.venv/bin/python -m pip install -r requirements.txt']);
	assert.equal(fixture.chain.start().jobId, 'job-1');

	fixture.advance(4_000);
	const first = fixture.chain.settle('job-1', 0, new Date(CHAIN_NOW + 4_000));

	assert.deepEqual(fixture.notified, [], 'S24: no per-step notification');
	assert.deepEqual(fixture.submitted.map((request) => request.command), [
		'python3 -m venv .venv',
		'.venv/bin/python -m pip install -r requirements.txt',
	]);
	assert.equal(first?.jobId, 'job-2');
	assert.equal(first?.setup.status, 'running');
	assert.deepEqual(first?.setup.steps.map((step) => step.status), ['ready', 'running']);

	fixture.advance(6_000);
	const last = fixture.chain.settle('job-2', 0, new Date(CHAIN_NOW + 10_000));
	assert.equal(last?.setup.status, 'ready');
	assert.deepEqual(fixture.notified, ['worktree setup ready · worktree-tools · 2 steps (10s)']);
	assert.equal(last?.jobId, undefined, 'the last step starts no further job');
});

test('S24/S26: a failing step stops the chain, one failure notice, the log path and no rollback', () => {
	const fixture = chainFixture(['python3 -m venv .venv', '.venv/bin/python -m pip install -r requirements.txt']);
	fixture.chain.start();
	fixture.advance(3_000);
	const endedAt = new Date(CHAIN_NOW + 3_000);

	const settled = fixture.chain.settle('job-1', 127, endedAt);

	assert.equal(fixture.submitted.length, 1, 'a failed step never starts the next one');
	assert.deepEqual(fixture.notified, [
		[
			'worktree setup failed · worktree-tools · python3 -m venv .venv exited 127',
			'log: /logs/job-1.log',
			'worktree is not ready yet; re-run setup or inspect the log.',
		].join('\n'),
	]);
	assert.deepEqual(settled?.setup, {
		status: 'failed',
		steps: [
			{
				command: 'python3 -m venv .venv',
				status: 'failed',
				startedAt: new Date(CHAIN_NOW).toISOString(),
				logPath: '/logs/job-1.log',
				exitCode: 127,
				endedAt: endedAt.toISOString(),
			},
		],
		command: 'python3 -m venv .venv',
		logPath: '/logs/job-1.log',
		exitCode: 127,
		endedAt: endedAt.toISOString(),
	});
	assert.deepEqual(fixture.persisted.at(-1), settled?.setup, 'S26: the store keeps the failure and its log');
});

test('S25: a registry that refuses the start leaves a pending record and no notification', () => {
	const fixture = chainFixture(['pnpm install'], {
		startError: new Error('25 background jobs are already running; stop one with job_stop first.'),
	});

	const run = fixture.chain.start();

	assert.deepEqual(run, {
		setup: {
			status: 'pending',
			steps: [{ command: 'pnpm install', status: 'pending', startedAt: new Date(CHAIN_NOW).toISOString() }],
			command: 'pnpm install',
			detail: 'job limit reached',
		},
		limited: true,
	});
	assert.deepEqual(fixture.persisted.at(-1), run.setup, 'the metadata holds the pending reason, not a stale running');
	assert.deepEqual(fixture.notified, [], 'a chain that never started never settles');
	assert.equal(fixture.chain.settle('job-1', 0, new Date(CHAIN_NOW)), undefined);
});

test('S25: a start refused for another reason leaves a failed record and no notification', () => {
	const fixture = chainFixture(['pnpm install'], { startError: new Error('shell refused to start') });

	const run = fixture.chain.start();

	const at = new Date(CHAIN_NOW).toISOString();
	const failed = {
		status: 'failed',
		steps: [{ command: 'pnpm install', status: 'failed', startedAt: at, endedAt: at }],
		command: 'pnpm install',
		endedAt: at,
		detail: 'could not start pnpm install: shell refused to start',
	};
	assert.deepEqual(run, { setup: failed });
	assert.deepEqual(fixture.persisted.at(-1), failed, 'the record carries the reason the start failed');
	assert.deepEqual(fixture.notified, [], 'a chain that never started notifies nothing');
});

test('S24: the chain never spawns anything itself', () => {
	const source = readFileSync(join(__dirname, '..', 'lib', 'worktree-setup.js'), 'utf8');
	assert.doesNotMatch(source, /node:child_process|spawn|detached/);
});

// ---- S23: the record write ----

function temporaryStore(t) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-setup-')));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test('S23: writing the setup keeps every other field of the record', (t) => {
	const clone = temporaryStore(t);
	const storePath = worktreeMetadataFilePath(join(clone, '.git'));
	const path = join(clone, 'repo-worktrees', 'worktree-tools');
	const record = createWorktreeMetadataRecord(
		{
			odd: 'worktree-tools',
			createdBy: 'session-1',
			adminId: 'worktree-tools',
			branchAtCreation: 'feat/worktree-tools',
			baseRef: 'main@0123456',
			hooks: [{ name: 'submodules', status: 'skipped', detail: 'no submodules' }],
		},
		new Date('2026-01-01T00:00:00.000Z'),
	);
	saveWorktreeMetadataRecords(storePath, { [path]: record });

	const setup = {
		status: 'running',
		steps: [{ command: 'pnpm install', status: 'running', startedAt: '2026-01-01T00:00:05.000Z' }],
		command: 'pnpm install',
	};

	assert.deepEqual(recordWorktreeSetup({ storePath, path, setup }), { recorded: true });
	const stored = readWorktreeMetadataStore(storePath);
	if (stored.status !== 'valid') assert.fail('the store stayed readable');
	assert.deepEqual(stored.file.records[path].setup, setup);
	assert.deepEqual({ ...stored.file.records[path], setup: record.setup }, record, 'S7: the setup write changes the setup and nothing else');
});

test('S23: a store without this worktree, or one that refuses the write, is reported', (t) => {
	const clone = temporaryStore(t);
	const storePath = worktreeMetadataFilePath(join(clone, '.git'));
	const known = join(clone, 'repo-worktrees', 'config');
	saveWorktreeMetadataRecords(storePath, {
		[known]: createWorktreeMetadataRecord(
			{
				odd: 'worktree-tools',
				createdBy: 'session-1',
				adminId: 'config',
				branchAtCreation: 'feat/worktree-tools',
				baseRef: 'main@0123456',
			},
			new Date('2026-01-01T00:00:00.000Z'),
		),
	});

	assert.deepEqual(recordWorktreeSetup({ storePath, path: join(clone, 'repo-worktrees', 'other'), setup: skippedWorktreeSetup('no lockfile at root') }), {
		recorded: false,
		reason: 'no metadata record for this worktree',
	});
	assert.deepEqual(recordWorktreeSetup({ storePath, path: known, setup: { status: 'nonsense', steps: [] } }), {
		recorded: false,
		reason: `worktree metadata record for ${known} is incomplete`,
	});
});

test('S23: a store that cannot answer is reported instead of invented', (t) => {
	const clone = temporaryStore(t);
	const storePath = worktreeMetadataFilePath(join(clone, '.git'));
	const outcome = recordWorktreeSetup({
		storePath,
		path: join(clone, 'repo-worktrees', 'worktree-tools'),
		setup: skippedWorktreeSetup('no lockfile at root'),
	});

	assert.deepEqual(outcome, { recorded: false, reason: 'no readable metadata store for this clone' });
	assert.equal(readWorktreeMetadataStore(storePath).status, 'missing');
});

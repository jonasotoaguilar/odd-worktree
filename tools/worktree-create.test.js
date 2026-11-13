'use strict';
// The core of `worktree_create`: where a worktree goes, which branch it takes, which
// ref it starts from, what Git is asked and what a reader sees. Decision cases use an
// injected Git seam; creation cases use real temporary clones.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const test = require('node:test');

const {
	WORKTREE_NAME_SEGMENT_HINT,
	WORKTREE_NOT_A_REPOSITORY,
	WORKTREE_SEGMENT_HINT,
	defaultWorktreeName,
	executeWorktreeCreatePlan,
	planWorktreeCreate,
	recordWorktreeHooks,
	worktreeCreateView,
	worktreeDestinationPath,
} = require('../lib/worktree-create.js');
const {
	createWorktreeMetadataRecord,
	parseWorktreeListPorcelain,
	readWorktreeMetadataStore,
	reconcileWorktrees,
	saveWorktreeMetadataRecords,
	worktreeMetadataFilePath,
} = require('../lib/worktree-metadata.js');
const { worktreeListView } = require('../lib/worktree-list.js');

const MAIN_ROOT = '/dev/projects/repo';
const DESTINATION = '/dev/projects/repo-worktrees/worktree-tools';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const SHORT_BASE = BASE_SHA.slice(0, 7);
const ADMIN_DIR = '/dev/projects/repo/.git/worktrees/worktree-tools';

// ---- An injected Git seam ----

/**
 * `refs` maps every ref the clone has to the SHA it resolves to; `originHead` and
 * `initDefaultBranch` answer the two configuration queries; `holder` is the worktree
 * Git already lists for a branch; `adminDir` is the administrative directory the
 * worktree reports, and null makes that query fail.
 */
function gitStub(overrides = {}) {
	const refs = overrides.refs ?? { 'refs/heads/main': BASE_SHA };
	const adminDir = overrides.adminDir === undefined ? ADMIN_DIR : overrides.adminDir;
	const calls = [];
	const git = async (cwd, args) => {
		calls.push({ cwd, args });
		const [command, ...rest] = args;
		if (command === 'rev-parse' && rest[0] === '--verify') {
			const sha = refs[rest[rest.length - 1]];
			return sha === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${sha}\n` };
		}
		if (command === 'rev-parse' && rest.includes('--git-dir')) {
			return adminDir === null ? { code: 1, stdout: '' } : { code: 0, stdout: `${adminDir}\n` };
		}
		if (command === 'symbolic-ref') {
			return overrides.originHead === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${overrides.originHead}\n` };
		}
		if (command === 'config') {
			return overrides.initDefaultBranch === undefined
				? { code: 1, stdout: '' }
				: { code: 0, stdout: `${overrides.initDefaultBranch}\n` };
		}
		if (command === 'worktree' && rest[0] === 'list') {
			let text = 'worktree /dev/projects/repo\0branch refs/heads/main\0\0';
			if (overrides.holder) text += `worktree ${overrides.holder.path}\0branch refs/heads/${overrides.holder.branch}\0\0`;
			return { code: 0, stdout: text };
		}
		if (command === 'worktree' && rest[0] === 'add') return { code: overrides.addCode ?? 0, stdout: '' };
		return undefined;
	};
	return { git, calls };
}

function seamsFor(git, existing = []) {
	const existsCalls = [];
	return {
		seams: {
			git,
			exists: (path) => {
				existsCalls.push(path);
				return existing.includes(path);
			},
		},
		existsCalls,
	};
}

const REPOSITORY = { mainRoot: MAIN_ROOT };
const REQUEST = { odd: 'worktree-tools', branch: 'feat/worktree-tools' };

async function expectedPlan(request, repository, seams) {
	const decision = await planWorktreeCreate(request, repository, seams);
	if (decision.ok === false) assert.fail(`expected a plan, got ${decision.error.code}: ${decision.error.message}`);
	return decision.plan;
}

async function expectedError(request, repository, seams) {
	const decision = await planWorktreeCreate(request, repository, seams);
	if (decision.ok === true) assert.fail(`expected a refusal, got the plan for ${decision.plan.path}`);
	return decision.error;
}

// ---- A real clone ----

/** A real clone with an isolated HOME and Git configuration, removed in teardown. */
function repositoryFixture(t, initialBranch = 'main') {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-create-')));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const home = join(fixture, 'home');
	const template = join(fixture, 'template');
	const emptyConfig = join(fixture, 'gitconfig');
	mkdirSync(home);
	mkdirSync(template);
	writeFileSync(emptyConfig, '');
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
	Object.assign(env, { HOME: home, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
	const git = (cwd, args) =>
		execFileSync(
			'git',
			['-C', cwd, '-c', `core.hooksPath=${template}`, '-c', 'commit.gpgsign=false', ...args],
			{ env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	const root = join(fixture, 'repo');
	git(fixture, ['init', `--initial-branch=${initialBranch}`, `--template=${template}`, root]);
	writeFileSync(join(root, 'tracked.txt'), 'fixture\n');
	git(root, ['add', 'tracked.txt']);
	git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
	const commonDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
	/** The asynchronous seam the plan and execute steps take, recording every invocation. */
	const seam = () => {
		const calls = [];
		const runner = async (cwd, args) => {
			calls.push({ cwd, args });
			try {
				return {
					code: 0,
					stdout: git(cwd, [...args]),
				};
			} catch (error) {
				const failure = error;
				return { code: failure.status ?? 1, stdout: typeof failure.stdout === 'string' ? failure.stdout : '' };
			}
		};
		return { git: runner, calls };
	};
	const adminId = (path) =>
		basename(realpathSync(git(path, ['rev-parse', '--path-format=absolute', '--git-dir']).trim()));
	return { root, commonDir, git, seam, adminId };
}

function temporaryStore(t) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-create-store-')));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return join(directory, 'gentle-ai', 'worktrees.json');
}

// ---- S1: destination layout ----

test('S1: the destination sits beside the canonical main worktree', async () => {
	const stub = gitStub();
	const { seams, existsCalls } = seamsFor(stub.git);
	const plan = await expectedPlan(REQUEST, REPOSITORY, seams);

	assert.equal(plan.path, DESTINATION);
	assert.equal(plan.name, 'worktree-tools');
	assert.equal(plan.odd, 'worktree-tools');
	assert.equal(plan.branch, 'feat/worktree-tools');
	assert.equal(plan.branchState, 'created');
	assert.equal(plan.base, 'main');
	assert.equal(plan.startRef, 'refs/heads/main');
	assert.equal(plan.baseSha, BASE_SHA);
	assert.equal(plan.shortSha, SHORT_BASE);
	assert.deepEqual(plan.args, ['worktree', 'add', '-b', 'feat/worktree-tools', DESTINATION, 'refs/heads/main']);
	assert.equal(plan.mainRoot, MAIN_ROOT, "Git's create runs in the main worktree, never in the session cwd");
	assert.deepEqual(existsCalls, [DESTINATION], 'S4 asks the filesystem once, about the destination');
	assert.equal(worktreeDestinationPath(MAIN_ROOT, 'a-b'), '/dev/projects/repo-worktrees/a-b');
});

test('S1: the first branch segment is dropped and the rest names the directory', async () => {
	assert.equal(defaultWorktreeName('feat/worktree-tools'), 'worktree-tools');
	assert.equal(defaultWorktreeName('feat/x'), 'x');
	assert.equal(defaultWorktreeName('feat/a/b'), 'a-b');
	assert.equal(defaultWorktreeName('feat/'), '', 'only an empty remainder derives nothing');

	const deep = await expectedPlan({ odd: 'a-b', branch: 'feat/a/b' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(deep.name, 'a-b');
	assert.equal(deep.path, '/dev/projects/repo-worktrees/a-b');

	const named = await expectedPlan({ odd: 'a-b', branch: 'feat/a/b', name: 'custom' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(named.path, '/dev/projects/repo-worktrees/custom');
	assert.equal(named.name, 'custom');

	const empty = await expectedError({ odd: 'a-b', branch: 'feat/' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.deepEqual(empty, { code: 'invalid-name', message: `invalid name: ""\n${WORKTREE_NAME_SEGMENT_HINT}` });
});

test('S27: the outside-a-repository sentence is the contract\'s exact text', () => {
	assert.equal(WORKTREE_NOT_A_REPOSITORY, 'not inside a Git worktree, so there is no repository to create a worktree from');
});

test('S1: a branch with no separator names the directory itself', async () => {
	assert.equal(WORKTREE_SEGMENT_HINT, 'odd must be a single path segment (letters, digits, dash, underscore, dot)');
	assert.equal(WORKTREE_NAME_SEGMENT_HINT, 'name must be a single path segment (letters, digits, dash, underscore, dot)');
	assert.equal(defaultWorktreeName('dev-abyss'), 'dev-abyss');
	assert.equal(defaultWorktreeName('worktree-tools'), 'worktree-tools');

	const plain = await expectedPlan({ odd: 'dev-abyss', branch: 'dev-abyss' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(plain.name, 'dev-abyss');
	assert.equal(plain.path, '/dev/projects/repo-worktrees/dev-abyss');

	const single = await expectedPlan({ odd: 'x', branch: 'feat/x' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(single.name, 'x');
	assert.equal(single.path, '/dev/projects/repo-worktrees/x');
});

// ---- S5: input safety ----

test('S5: odd and name are single path segments, refused before anything is touched', async () => {
	for (const odd of ['../escape', 'a/b', '/absolute', 'a\\b', 'tab\there', '', '   ', '..', 'a\u0000b']) {
		const stub = gitStub();
		const { seams, existsCalls } = seamsFor(stub.git);
		const error = await expectedError({ odd, branch: 'feat/worktree-tools' }, REPOSITORY, seams);
		assert.deepEqual(error, { code: 'invalid-odd', message: `invalid odd name: ${JSON.stringify(odd)}\n${WORKTREE_SEGMENT_HINT}` }, odd);
		assert.deepEqual(stub.calls, [], `${JSON.stringify(odd)}: no Git command ran`);
		assert.deepEqual(existsCalls, [], `${JSON.stringify(odd)}: the filesystem was not touched`);
	}
	for (const name of ['../escape', 'a/b', '/absolute', 'a\u0000b']) {
		const stub = gitStub();
		const { seams, existsCalls } = seamsFor(stub.git);
		const error = await expectedError({ odd: 'worktree-tools', branch: 'feat/worktree-tools', name }, REPOSITORY, seams);
		assert.deepEqual(error, { code: 'invalid-name', message: `invalid name: ${JSON.stringify(name)}\n${WORKTREE_NAME_SEGMENT_HINT}` }, name);
		assert.deepEqual(stub.calls, [], `${JSON.stringify(name)}: no Git command ran`);
		assert.deepEqual(existsCalls, [], `${JSON.stringify(name)}: the filesystem was not touched`);
	}
	const both = await expectedError({ odd: '../escape', branch: 'feat/worktree-tools', name: '../escape' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.deepEqual(both, { code: 'invalid-odd', message: `invalid odd name: "../escape"\n${WORKTREE_SEGMENT_HINT}` }, 'both invalid: odd is refused first');
	const accepted = await expectedPlan({ odd: 'work.tree_tools-1', branch: 'feat/worktree-tools' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(accepted.odd, 'work.tree_tools-1', 'letters, digits, dash, underscore and dot stay valid');
});

// ---- S4: `odd` is optional ----

test('S4: an omitted odd is not validated, plans null and prints odd: -', async () => {
	const omitted = await expectedPlan({ branch: 'feat/worktree-tools' }, REPOSITORY, seamsFor(gitStub().git).seams);
	const present = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(omitted.odd, null, 'the plan carries no odd');
	assert.deepEqual({ ...omitted, odd: 'worktree-tools' }, present, 'omitting the odd changes nothing else about the plan');

	const view = worktreeCreateView({ plan: omitted, metadata: { recorded: true }, registered: true });
	assert.deepEqual(view.text.split('\n'), [
		`worktree created: ${DESTINATION}`,
		'branch: feat/worktree-tools (created)',
		'odd: -',
		`base: main@${SHORT_BASE}`,
		'worktree register in session',
	], 'an omitted odd keeps the fixed line count and the same order');
	assert.equal(view.details.odd, null);
});

test('S4: an omitted odd is stored as an absent field', async (t) => {
	const storePath = temporaryStore(t);
	const stub = gitStub();
	const plan = await expectedPlan({ branch: 'feat/worktree-tools' }, REPOSITORY, seamsFor(stub.git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: stub.git, createdBy: 'session-1', storePath });

	assert.equal(execution.ok, true);
	if (execution.ok === false) return;
	assert.deepEqual(execution.result.metadata, { recorded: true }, 'the record is stored, not refused');

	// The record really is in the shared document's `records`, with no odd key at all.
	const stored = readWorktreeMetadataStore(storePath);
	assert.equal(stored.status, 'valid');
	if (stored.status !== 'valid') return;
	assert.deepEqual(stored.drops, [], 'the odd-less record is not dropped on the way back in');
	assert.equal('odd' in stored.file.records[DESTINATION], false, 'the stored record carries no odd at all');
	const raw = JSON.parse(readFileSync(storePath, 'utf8'));
	assert.equal('odd' in raw.records[DESTINATION], false, 'the bytes carry no odd key');
	assert.equal(raw.records[DESTINATION].createdBy, 'session-1');

	// And the printed lines never carry a metadata notice for it.
	const view = worktreeCreateView({ plan, metadata: execution.result.metadata, registered: true });
	assert.deepEqual(view.text.split('\n'), [
		`worktree created: ${DESTINATION}`,
		'branch: feat/worktree-tools (created)',
		'odd: -',
		`base: main@${SHORT_BASE}`,
		'worktree register in session',
	]);
	assert.equal(/metadata:/.test(view.text), false, 'an odd-less create never reports a metadata failure');
	assert.equal(view.details.metadataRecorded, true);
});

// ---- S2: base resolution ----

test('S2: base resolution walks main, origin/HEAD and init.defaultBranch, then refuses', async () => {
	const local = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(local.base, 'main');

	const remote = await expectedPlan(
		REQUEST,
		REPOSITORY,
		seamsFor(gitStub({ refs: { 'refs/remotes/origin/trunk': OTHER_SHA }, originHead: 'origin/trunk' }).git).seams,
	);
	assert.equal(remote.base, 'trunk');
	assert.equal(remote.startRef, 'refs/remotes/origin/trunk');
	assert.equal(remote.baseSha, OTHER_SHA);
	assert.deepEqual(remote.args, ['worktree', 'add', '-b', 'feat/worktree-tools', DESTINATION, 'refs/remotes/origin/trunk']);

	const configured = await expectedPlan(
		REQUEST,
		REPOSITORY,
		seamsFor(gitStub({ refs: { 'refs/heads/develop': OTHER_SHA }, initDefaultBranch: 'develop' }).git).seams,
	);
	assert.equal(configured.base, 'develop');
	assert.equal(configured.startRef, 'refs/heads/develop');

	const refused = await expectedError(REQUEST, REPOSITORY, seamsFor(gitStub({ refs: {} }).git).seams);
	assert.deepEqual(refused, { code: 'no-base-branch', message: 'could not resolve a base branch: tried main, origin/HEAD, init.defaultBranch' });
});

test('S2: the base branch itself is refused as the worktree\'s branch', async () => {
	const error = await expectedError({ odd: 'worktree-tools', branch: 'main' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.deepEqual(error, {
		code: 'base-branch-is-target',
		message: 'branch main is the base branch; pick the branch this worktree should work on',
	});
});

// ---- S3: branch reuse ----

test('S3: a free existing branch is checked out and a held one names its holder', async () => {
	const existing = await expectedPlan(
		REQUEST,
		REPOSITORY,
		seamsFor(gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/feat/worktree-tools': OTHER_SHA } }).git).seams,
	);
	assert.equal(existing.branchState, 'existing');
	assert.deepEqual(existing.args, ['worktree', 'add', DESTINATION, 'feat/worktree-tools'], 'a plain branch name is what checks it out');

	const holderPath = '/dev/projects/repo-worktrees/file-picker';
	const held = await expectedError(
		{ odd: 'file-picker', branch: 'feat/file-picker' },
		REPOSITORY,
		seamsFor(gitStub({ holder: { branch: 'feat/file-picker', path: holderPath } }).git).seams,
	);
	assert.deepEqual(held, {
		code: 'branch-in-use',
		message: `branch feat/file-picker is already checked out in ${holderPath}\nUse a different branch, or work in that worktree.`,
	});
});

test('S3: no plan and no executed command ever passes --force', async (t) => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/feat/worktree-tools': OTHER_SHA } });
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	assert.ok(!plan.args.includes('--force'));
	const execution = await executeWorktreeCreatePlan({
		plan,
		git: stub.git,
		createdBy: 'session-1',
		storePath: temporaryStore(t),
	});
	assert.equal(execution.ok, true);
	assert.ok(stub.calls.every((call) => !call.args.includes('--force')), 'no Git invocation forces anything');
});

// ---- S4: destination collision ----

test('S4: an occupied destination is refused without asking Git to create it', async () => {
	const stub = gitStub();
	const error = await expectedError(REQUEST, REPOSITORY, seamsFor(stub.git, [DESTINATION]).seams);
	assert.deepEqual(error, {
		code: 'path-exists',
		message: `worktree path already exists: ${DESTINATION}\nRemove it or pass a different name.`,
	});
	assert.ok(!stub.calls.some((call) => call.args[1] === 'add'), 'nothing was created');
});

// ---- S7: executing the plan and storing the record ----

test('S7: executing a plan creates the worktree and stores the record', async (t) => {
	const storePath = temporaryStore(t);
	const stub = gitStub();
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	const execution = await executeWorktreeCreatePlan({
		plan,
		git: stub.git,
		createdBy: 'session-1',
		storePath,
		now: new Date('2026-03-04T05:06:07.000Z'),
	});

	assert.equal(execution.ok, true);
	if (execution.ok === false) return;
	assert.deepEqual(execution.result, { adminId: 'worktree-tools', metadata: { recorded: true } });
	assert.deepEqual(
		stub.calls.find((call) => call.args[1] === 'add'),
		{ cwd: MAIN_ROOT, args: plan.args },
		'the planned arguments run verbatim in the main worktree',
	);
	assert.deepEqual(stub.calls.at(-1), { cwd: DESTINATION, args: ['rev-parse', '--path-format=absolute', '--git-dir'] });

	const stored = readWorktreeMetadataStore(storePath);
	assert.equal(stored.status, 'valid');
	if (stored.status !== 'valid') return;
	assert.deepEqual(stored.file.records[DESTINATION], {
		odd: 'worktree-tools',
		createdAt: '2026-03-04T05:06:07.000Z',
		createdBy: 'session-1',
		adminId: 'worktree-tools',
		branchAtCreation: 'feat/worktree-tools',
		baseRef: `main@${SHORT_BASE}`,
		hooks: [],
		setup: { status: 'pending', steps: [] },
		lastSeen: { at: '2026-03-04T05:06:07.000Z', status: 'active' },
	});
});

test('S7: a store that refuses the write leaves the worktree created and reports why', async (t) => {
	const storePath = temporaryStore(t);
	mkdirSync(dirname(storePath), { recursive: true });
	writeFileSync(storePath, '{ not json');
	const stub = gitStub();
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	const execution = await executeWorktreeCreatePlan({
		plan,
		git: stub.git,
		createdBy: 'session-1',
		storePath,
	});

	assert.equal(execution.ok, true, 'S7: a refused write never rolls the worktree back');
	if (execution.ok === false) return;
	assert.equal(execution.result.adminId, 'worktree-tools');
	assert.equal(execution.result.metadata.recorded, false);
	if (execution.result.metadata.recorded === true) return;
	assert.match(execution.result.metadata.reason, /^refusing to overwrite an unreadable worktree metadata file: /);
	assert.equal(readFileSync(storePath, 'utf8'), '{ not json', 'the refused store is byte-identical');
});

test('S7: an unreadable administrative directory is reported instead of stored', async (t) => {
	const storePath = temporaryStore(t);
	const stub = gitStub({ adminDir: null });
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: stub.git, createdBy: 'session-1', storePath });

	assert.equal(execution.ok, true);
	if (execution.ok === false) return;
	assert.deepEqual(execution.result, {
		metadata: { recorded: false, reason: "could not read the worktree's administrative directory" },
	});
	assert.equal(readWorktreeMetadataStore(storePath).status, 'missing', 'no record is invented');
});

test('S7: a Git seam that answers nothing is reported without a result', async (t) => {
	const storePath = temporaryStore(t);
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: async () => undefined, createdBy: 'session-1', storePath });

	assert.deepEqual(execution, {
		ok: false,
		error: { code: 'git-failed', message: `could not create the worktree at ${DESTINATION}: git worktree add exited without a result` },
	});
	assert.equal(readWorktreeMetadataStore(storePath).status, 'missing');
});

test('S7: a failed git worktree add stores nothing', async (t) => {
	const storePath = temporaryStore(t);
	const stub = gitStub({ addCode: 128 });
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: stub.git, createdBy: 'session-1', storePath });

	assert.deepEqual(execution, {
		ok: false,
		error: { code: 'git-failed', message: `could not create the worktree at ${DESTINATION}: git worktree add exited 128` },
	});
	assert.equal(readWorktreeMetadataStore(storePath).status, 'missing');
});

// ---- S16/S17: the create output ----

test('S16: the create text is the fixed line order with nothing for later tasks', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const view = worktreeCreateView({ plan, adminId: 'worktree-tools', metadata: { recorded: true }, registered: true });

	assert.equal(
		view.text,
		[
			`worktree created: ${DESTINATION}`,
			'branch: feat/worktree-tools (created)',
			'odd: worktree-tools',
			`base: main@${SHORT_BASE}`,
			'worktree register in session',
		].join('\n'),
	);
	assert.doesNotMatch(view.text, /hooks|setup|copy_changes|metadata:/, 'T5, T6 and T7 own those lines');
	assert.deepEqual(view.details, {
		path: DESTINATION,
		name: 'worktree-tools',
		branch: 'feat/worktree-tools',
		branchState: 'created',
		base: 'main',
		baseSha: BASE_SHA,
		odd: 'worktree-tools',
		registered: true,
		metadataRecorded: true,
		adminId: 'worktree-tools',
	});
});

test('S16: the hooks summary follows the registration line and comes before a metadata notice', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const hooks = [
		{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		{ name: 'copy .env.local', status: 'applied' },
		{ name: 'symlink .turbo', status: 'failed', detail: 'could not link .turbo: EPERM' },
	];
	const view = worktreeCreateView({ plan, metadata: { recorded: false, reason: 'store unreadable' }, registered: true, hooks });

	assert.deepEqual(view.text.split('\n'), [
		`worktree created: ${DESTINATION}`,
		'branch: feat/worktree-tools (created)',
		'odd: worktree-tools',
		`base: main@${SHORT_BASE}`,
		'worktree register in session',
		'hooks: 1 applied, 1 skipped, 1 failed: symlink .turbo (could not link .turbo: EPERM)',
		'metadata: not recorded (store unreadable)',
	]);
	assert.deepEqual(view.details.hooks, hooks);
});

test('S16: a chain that applied nothing prints no hooks line', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const skipped = [{ name: 'submodules', status: 'skipped', detail: 'no submodules' }];
	const expected = [
		`worktree created: ${DESTINATION}`,
		'branch: feat/worktree-tools (created)',
		'odd: worktree-tools',
		`base: main@${SHORT_BASE}`,
		'worktree register in session',
	];
	for (const hooks of [undefined, [], skipped]) {
		const view = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, ...(hooks === undefined ? {} : { hooks }) });
		assert.deepEqual(view.text.split('\n'), expected, `${JSON.stringify(hooks)}: nothing to report`);
		const reported = hooks?.some((hook) => hook.status !== 'skipped') ? hooks : undefined;
		assert.deepEqual(view.details.hooks, reported, 'details and the text report the same thing');
	}
});

test('S16/S17: a refused registration and a refused record are reported, never claimed', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const view = worktreeCreateView({ plan, metadata: { recorded: false, reason: 'store unreadable' }, registered: false });

	assert.deepEqual(view.text.split('\n').slice(4), ['worktree register failed', 'metadata: not recorded (store unreadable)']);
	assert.equal(view.details.registered, false);
	assert.equal(view.details.metadataRecorded, false);
	assert.equal(view.details.adminId, undefined);
});

test('S16/S18: the copy_changes line follows the hooks summary and the details carry its count', async () => {
	const off = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(off.copyChanges, false, 'an omitted copy_changes normalises to false');
	const plan = await expectedPlan({ ...REQUEST, copy_changes: true }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(plan.copyChanges, true);
	const hooks = [
		{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		{ name: 'copy_changes', status: 'applied', copyChanges: { copied: 3, failed: [] } },
	];
	const view = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, hooks });

	assert.deepEqual(view.text.split('\n').slice(5), [
		'hooks: 1 applied, 1 skipped',
		'copy_changes: 3 changes copied (main keeps its uncommitted changes)',
	]);
	assert.deepEqual(view.details.copyChanges, { copied: 3, failed: [] });
});

test('S16/S18: copy_changes with nothing to copy prints one sentence and no hooks line', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const hooks = [{ name: 'copy_changes', status: 'skipped', detail: 'no uncommitted changes', copyChanges: { copied: 0, failed: [] } }];
	const view = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, hooks });

	assert.deepEqual(view.text.split('\n').slice(5), ['copy_changes: no uncommitted changes to copy']);
	assert.deepEqual(view.details.copyChanges, { copied: 0, failed: [] });
});

test('S18: a conflict is reported with its failing paths in the copy_changes line', async () => {
	const plan = await expectedPlan({ ...REQUEST, copy_changes: true }, REPOSITORY, seamsFor(gitStub().git).seams);
	const hooks = [{ name: 'copy_changes', status: 'failed', detail: 'could not copy: conflict.txt', copyChanges: { copied: 1, failed: ['conflict.txt'] } }];
	const view = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, hooks });

	assert.deepEqual(view.text.split('\n').slice(5), [
		'hooks: 1 failed: copy_changes (could not copy: conflict.txt)',
		'copy_changes: 1 changes copied (main keeps its uncommitted changes); failed: conflict.txt',
	]);
	assert.deepEqual(view.details.copyChanges, { copied: 1, failed: ['conflict.txt'] });
});

test('S16/S21/S25: the setup line follows the hooks summary and comes before the copy_changes line', async () => {
	const plan = await expectedPlan({ ...REQUEST, copy_changes: true }, REPOSITORY, seamsFor(gitStub().git).seams);
	const hooks = [
		{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		{ name: 'copy_changes', status: 'applied', copyChanges: { copied: 2, failed: [] } },
	];
	const setup = { status: 'running', steps: [{ command: 'pnpm install', status: 'running' }], command: 'pnpm install' };
	const view = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, hooks, setup });

	assert.deepEqual(view.text.split('\n').slice(5), [
		'hooks: 1 applied, 1 skipped',
		'setup: running (pnpm install) · worktree is not ready yet',
		'copy_changes: 2 changes copied (main keeps its uncommitted changes)',
	]);
	assert.deepEqual(view.details.setup, setup, 'the details carry the persisted setup state the line was derived from');
});

test('S16: a ready setup drops the not-ready advice and an unread chain prints no setup line', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const ready = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, setup: { status: 'ready', steps: [] } });
	assert.equal(ready.text.split('\n').at(-1), 'setup: ready');

	const skipped = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true, setup: { status: 'skipped', steps: [], detail: 'no lockfile at root' } });
	assert.equal(skipped.text.split('\n').at(-1), 'setup: skipped (no lockfile at root) · worktree is not ready yet');

	const absent = worktreeCreateView({ plan, metadata: { recorded: true }, registered: true });
	assert.doesNotMatch(absent.text, /setup/, 'a caller that holds no setup state prints no line, never a guess');
	assert.equal(absent.details.setup, undefined);
});

// ---- Creation cases in real clones ----

test('S7: the hook outcomes are merged into the record the create already stored', async (t) => {
	const repository = repositoryFixture(t);
	const stub = repository.seam();
	const seams = { git: stub.git, exists: (path) => existsSync(path) };
	const decision = await planWorktreeCreate(REQUEST, { mainRoot: repository.root }, seams);
	if (decision.ok === false) assert.fail(decision.error.message);
	const storePath = worktreeMetadataFilePath(repository.commonDir);
	const execution = await executeWorktreeCreatePlan({ plan: decision.plan, git: stub.git, createdBy: 'session-1', storePath });
	if (execution.ok === false) assert.fail(execution.error.message);
	if (execution.result.metadata.recorded === false) assert.fail(execution.result.metadata.reason);
	const before = readWorktreeMetadataStore(storePath);
	if (before.status !== 'valid') assert.fail('the create stored a record');

	const recorded = recordWorktreeHooks({
		storePath,
		path: decision.plan.path,
		hooks: [
			{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
			{ name: 'symlink .turbo', status: 'applied' },
		],
	});

	assert.deepEqual(recorded, { recorded: true });
	const after = readWorktreeMetadataStore(storePath);
	if (after.status !== 'valid') assert.fail('the merge kept the store readable');
	const record = after.file.records[decision.plan.path];
	assert.ok(record, 'the record is still keyed by the canonical worktree path');
	assert.deepEqual(record.hooks, [
		{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		{ name: 'symlink .turbo', status: 'applied' },
	]);
	assert.deepEqual(
		{ ...record, hooks: [] },
		{ ...before.file.records[decision.plan.path], hooks: [] },
		'S7: the merge changes the hooks and nothing else',
	);
});

test('S7: hook outcomes for a worktree with no record are reported, never invented', async (t) => {
	const storePath = temporaryStore(t);
	const recorded = recordWorktreeHooks({ storePath, path: DESTINATION, hooks: [{ name: 'submodules', status: 'applied' }] });

	assert.deepEqual(recorded, { recorded: false, reason: 'no readable metadata store for this clone' });
	assert.equal(readWorktreeMetadataStore(storePath).status, 'missing', 'no record is created for a path that has none');
});

test('S7: a readable store without a record for this path is reported, and keeps its own record', async (t) => {
	const storePath = temporaryStore(t);
	const otherPath = '/dev/projects/repo-worktrees/other';
	saveWorktreeMetadataRecords(storePath, {
		[otherPath]: createWorktreeMetadataRecord(
			{ odd: 'other', createdBy: 'session-2', adminId: 'other', branchAtCreation: 'feat/other', baseRef: `main@${SHORT_BASE}` },
			new Date('2026-03-04T05:06:07.000Z'),
		),
	});
	const before = readWorktreeMetadataStore(storePath);

	const recorded = recordWorktreeHooks({ storePath, path: DESTINATION, hooks: [{ name: 'submodules', status: 'applied' }] });

	assert.deepEqual(recorded, { recorded: false, reason: 'no metadata record for this worktree' });
	const after = readWorktreeMetadataStore(storePath);
	if (before.status !== 'valid' || after.status !== 'valid') assert.fail('the store stays readable');
	assert.deepEqual(after.file.records, before.file.records, 'no record is created for a path that has none');
});

test('S1/S3/S7: a real clone creates the worktree, its branch and its record', async (t) => {
	const repository = repositoryFixture(t);
	const stub = repository.seam();
	const seams = { git: stub.git, exists: (path) => existsSync(path) };
	const decision = await planWorktreeCreate(REQUEST, { mainRoot: repository.root }, seams);
	if (decision.ok === false) assert.fail(decision.error.message);
	const execution = await executeWorktreeCreatePlan({
		plan: decision.plan,
		git: stub.git,
		createdBy: 'session-1',
		storePath: worktreeMetadataFilePath(repository.commonDir),
	});
	if (execution.ok === false) assert.fail(execution.error.message);

	const destination = join(dirname(repository.root), 'repo-worktrees', 'worktree-tools');
	const head = repository.git(repository.root, ['rev-parse', 'HEAD']).trim();
	assert.equal(decision.plan.path, destination);
	assert.ok(existsSync(join(destination, 'tracked.txt')), 'the worktree holds its checkout');
	assert.equal(repository.git(destination, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feat/worktree-tools');
	assert.equal(repository.git(destination, ['rev-parse', 'HEAD']).trim(), head, 'the branch starts at the base commit');
	assert.ok(stub.calls.every((call) => !call.args.includes('--force')));

	const stored = readWorktreeMetadataStore(worktreeMetadataFilePath(repository.commonDir));
	assert.equal(stored.status, 'valid');
	if (stored.status !== 'valid') return;
	const record = stored.file.records[destination];
	assert.ok(record, 'the record is keyed by the canonical worktree path');
	assert.equal(record.odd, 'worktree-tools');
	assert.equal(record.adminId, repository.adminId(destination));
	assert.equal(record.branchAtCreation, 'feat/worktree-tools');
	assert.equal(record.baseRef, `main@${head.slice(0, 7)}`);
	assert.equal(execution.result.adminId, repository.adminId(destination));

	const view = worktreeListView({
		reconciliation: reconcileWorktrees({
			entries: parseWorktreeListPorcelain(repository.git(repository.root, ['worktree', 'list', '--porcelain'])),
			records: stored.file.records,
			commonDir: repository.commonDir,
		}),
		project: basename(repository.root),
		main: { path: repository.root, branch: 'main', shortSha: head.slice(0, 7) },
	});
	assert.ok(
		view.text.split('\n').includes('1 worktree-tools feat/worktree-tools odd: worktree-tools pending'),
		'the list view reports the created worktree with its odd',
	);
});

test('S3: a real free branch is reused instead of recreated', async (t) => {
	const repository = repositoryFixture(t);
	repository.git(repository.root, ['branch', 'chore/free']);
	const stub = repository.seam();
	const seams = { git: stub.git, exists: (path) => existsSync(path) };
	const decision = await planWorktreeCreate({ odd: 'free', branch: 'chore/free', name: 'free' }, { mainRoot: repository.root }, seams);
	if (decision.ok === false) assert.fail(decision.error.message);
	const execution = await executeWorktreeCreatePlan({
		plan: decision.plan,
		git: stub.git,
		createdBy: 'session-1',
		storePath: worktreeMetadataFilePath(repository.commonDir),
	});
	if (execution.ok === false) assert.fail(execution.error.message);

	const destination = join(dirname(repository.root), 'repo-worktrees', 'free');
	assert.equal(decision.plan.branchState, 'existing');
	assert.equal(repository.git(destination, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'chore/free');
	assert.ok(!stub.calls.some((call) => call.args.includes('-b')), 'Git was never asked to create an existing branch');
});

test('S3: a real worktree holding the branch is named in the refusal', async (t) => {
	const repository = repositoryFixture(t);
	const holder = join(dirname(repository.root), 'repo-worktrees', 'holder');
	repository.git(repository.root, ['worktree', 'add', '-b', 'feat/file-picker', holder]);
	const { git } = repository.seam();

	const decision = await planWorktreeCreate(
		{ odd: 'file-picker', branch: 'feat/file-picker' },
		{ mainRoot: repository.root },
		{ git, exists: (path) => existsSync(path) },
	);
	if (decision.ok === true) assert.fail('expected the holder to be reported');
	assert.deepEqual(decision.error, {
		code: 'branch-in-use',
		message: `branch feat/file-picker is already checked out in ${realpathSync(holder)}\nUse a different branch, or work in that worktree.`,
	});
});

test('S4: a real occupied destination is refused and creates no branch', async (t) => {
	const repository = repositoryFixture(t);
	const destination = join(dirname(repository.root), 'repo-worktrees', 'worktree-tools');
	mkdirSync(destination, { recursive: true });
	const { git } = repository.seam();

	const decision = await planWorktreeCreate(REQUEST, { mainRoot: repository.root }, { git, exists: (path) => existsSync(path) });
	if (decision.ok === true) assert.fail('expected the occupied destination to be reported');
	assert.deepEqual(decision.error, {
		code: 'path-exists',
		message: `worktree path already exists: ${realpathSync(destination)}\nRemove it or pass a different name.`,
	});
	assert.equal(repository.git(repository.root, ['branch', '--list', 'feat/worktree-tools']).trim(), '', 'no branch was created');
});

test('S2: a real clone with no main, origin/HEAD or init.defaultBranch has no base', async (t) => {
	const repository = repositoryFixture(t, 'develop');
	const { git } = repository.seam();
	const decision = await planWorktreeCreate(REQUEST, { mainRoot: repository.root }, { git, exists: () => false });
	assert.deepEqual(decision, {
		ok: false,
		error: { code: 'no-base-branch', message: 'could not resolve a base branch: tried main, origin/HEAD, init.defaultBranch' },
	});
});

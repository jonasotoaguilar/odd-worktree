'use strict';
// The core of `worktree_create`: where a worktree goes, which branch it takes, which
// ref it starts from, what Git is asked and what a reader sees. Decision cases use an
// injected Git seam; creation cases use real temporary clones.
//
// S3: nothing is stored. The destination directory `<repo-name>-worktrees/<odd>` is the
// whole record, so the create writes no document and a create followed by a list leaves
// the clone exactly as Git left it.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const test = require('node:test');

const {
	WORKTREE_NOT_A_REPOSITORY,
	WORKTREE_SEGMENT_HINT,
	executeWorktreeCreatePlan,
	planWorktreeCreate,
	worktreeCreateView,
	worktreeDestinationPath,
} = require('../lib/worktree-create.js');

const MAIN_ROOT = '/dev/projects/repo';
const DESTINATION = '/dev/projects/repo-worktrees/worktree-tools';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const SHORT_BASE = BASE_SHA.slice(0, 7);

// ---- An injected Git seam ----

/**
 * `refs` maps every ref the clone has to the SHA it resolves to; `originHead` and
 * `initDefaultBranch` answer the two configuration queries; `holder` is the worktree
 * Git already lists for a branch.
 */
function gitStub(overrides = {}) {
	const refs = overrides.refs ?? { 'refs/heads/main': BASE_SHA };
	const calls = [];
	const git = async (cwd, args) => {
		calls.push({ cwd, args });
		const [command, ...rest] = args;
		if (command === 'rev-parse' && rest[0] === '--verify') {
			const sha = refs[rest[rest.length - 1]];
			return sha === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${sha}\n` };
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
	const seam = (exitCodes = {}) => {
		const calls = [];
		const runner = async (cwd, args) => {
			calls.push({ cwd, args });
			const key = args.join(' ');
			if (Object.prototype.hasOwnProperty.call(exitCodes, key)) return { code: exitCodes[key], stdout: '' };
			try {
				return { code: 0, stdout: git(cwd, [...args]) };
			} catch (error) {
				const failure = error;
				return { code: failure.status ?? 1, stdout: typeof failure.stdout === 'string' ? failure.stdout : '' };
			}
		};
		return { git: runner, calls };
	};
	return { root, commonDir, git, seam };
}

// ---- S1: destination layout ----

test('S1: the destination sits beside the canonical main worktree', async () => {
	assert.equal(worktreeDestinationPath(MAIN_ROOT, 'worktree-tools'), DESTINATION);
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(plan.path, DESTINATION);
	assert.deepEqual(plan.args, ['worktree', 'add', '-b', 'feat/worktree-tools', DESTINATION, 'refs/heads/main']);
});

test('S7: the directory is the ODD, whatever the branch says', async () => {
	const plan = await expectedPlan({ odd: 'login-ui', branch: 'feat/whatever' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(plan.path, '/dev/projects/repo-worktrees/login-ui');
	assert.equal(basename(plan.path), 'login-ui');
	assert.equal(plan.odd, 'login-ui');
});

// ---- S5: the request's refusals ----

test("S27: the outside-a-repository sentence is the contract's exact text", () => {
	assert.equal(WORKTREE_NOT_A_REPOSITORY, 'not inside a Git worktree, so there is no repository to create a worktree from');
});

test('S7: the ODD segment vocabulary is the one rule and the one sentence', async () => {
	const { isWorktreeSegment } = require('../lib/worktree-create.js');
	for (const good of ['worktree-tools', 'login_ui', 'v1.2', 'a']) assert.equal(isWorktreeSegment(good), true, good);
	for (const bad of ['', ' ', 'a/b', 'a\\b', '..', '/abs', undefined, 'a\u0000b']) {
		assert.equal(isWorktreeSegment(bad), false, JSON.stringify(bad));
	}
});

test('S5: the ODD is one path segment, refused before anything is touched', async () => {
	const stub = gitStub();
	const error = await expectedError({ odd: 'a/b', branch: 'feat/x' }, REPOSITORY, seamsFor(stub.git).seams);
	assert.deepEqual(error, {
		code: 'invalid-odd',
		message: `invalid odd name: "a/b"\n${WORKTREE_SEGMENT_HINT}`,
	});
	assert.deepEqual(stub.calls, [], 'no Git command ran');
});

test('S7: an omitted odd is refused with the segment sentence, before Git runs', async () => {
	const stub = gitStub();
	const { seams, existsCalls } = seamsFor(stub.git);
	const error = await expectedError({ branch: 'feat/worktree-tools' }, REPOSITORY, seams);

	assert.deepEqual(error, { code: 'invalid-odd', message: `invalid odd name: undefined\n${WORKTREE_SEGMENT_HINT}` });
	assert.deepEqual(stub.calls, [], 'no Git command ran');
	assert.deepEqual(existsCalls, [], 'the filesystem was not touched');
});

// ---- S2: base resolution and branch handling ----

test('S2: base resolution walks main, origin/HEAD and init.defaultBranch', async () => {
	const local = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(local.base, 'main');
	assert.equal(local.startRef, 'refs/heads/main');

	const origin = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub({
		originHead: 'origin/trunk',
		refs: { 'refs/remotes/origin/trunk': BASE_SHA },
	}).git).seams);
	assert.equal(origin.base, 'trunk');

	const configured = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub({
		initDefaultBranch: 'develop',
		refs: { 'refs/heads/develop': BASE_SHA },
	}).git).seams);
	assert.equal(configured.base, 'develop');
});

test('S2: no base at all is refused with its own sentence', async () => {
	const error = await expectedError(REQUEST, REPOSITORY, seamsFor(gitStub({ refs: {} }).git).seams);
	assert.equal(error.code, 'no-base-branch');
	assert.equal(error.message, 'could not resolve a base branch: tried main, origin/HEAD, init.defaultBranch');
});

test('S2: the base branch itself is refused as the worktree branch', async () => {
	const error = await expectedError({ odd: 'x', branch: 'main' }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(error.code, 'base-branch-is-target');
});

// ---- An explicit base: any branch the worktree should start from ----

test('base: an explicit base starts the new branch from that branch, not from main', async () => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/dev': OTHER_SHA } });
	const plan = await expectedPlan({ ...REQUEST, base: 'dev' }, REPOSITORY, seamsFor(stub.git).seams);
	assert.equal(plan.base, 'dev');
	assert.equal(plan.startRef, 'refs/heads/dev');
	assert.equal(plan.baseSha, OTHER_SHA);
	assert.deepEqual(plan.args, ['worktree', 'add', '-b', 'feat/worktree-tools', DESTINATION, 'refs/heads/dev']);
});

test('base: a base that only exists on origin is used, and a local one wins over it', async () => {
	const remoteOnly = await expectedPlan({ ...REQUEST, base: 'dev' }, REPOSITORY, seamsFor(gitStub({
		refs: { 'refs/heads/main': BASE_SHA, 'refs/remotes/origin/dev': OTHER_SHA },
	}).git).seams);
	assert.equal(remoteOnly.startRef, 'refs/remotes/origin/dev');
	assert.equal(remoteOnly.baseSha, OTHER_SHA);

	const both = await expectedPlan({ ...REQUEST, base: 'dev' }, REPOSITORY, seamsFor(gitStub({
		refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/dev': OTHER_SHA, 'refs/remotes/origin/dev': BASE_SHA },
	}).git).seams);
	assert.equal(both.startRef, 'refs/heads/dev');
});

test('base: omitting it, or passing undefined, keeps the main-first resolution unchanged', async () => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/dev': OTHER_SHA } });
	const omitted = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	const undefinedBase = await expectedPlan({ ...REQUEST, base: undefined }, REPOSITORY, seamsFor(stub.git).seams);
	assert.equal(omitted.base, 'main');
	assert.deepEqual(undefinedBase, omitted);
});

test('base: an unknown base is refused with its own sentence and nothing is created', async () => {
	const stub = gitStub();
	const error = await expectedError({ ...REQUEST, base: 'nope' }, REPOSITORY, seamsFor(stub.git).seams);
	assert.deepEqual(error, { code: 'base-not-found', message: 'could not resolve base branch nope: tried nope, origin/nope' });
	assert.equal(stub.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'), false);
});

test('base: a value that cannot name a branch is refused before Git runs', async () => {
	for (const bad of ['', '   ', 42, null, '-x', 'a\nb']) {
		const stub = gitStub();
		const error = await expectedError({ ...REQUEST, base: bad }, REPOSITORY, seamsFor(stub.git).seams);
		assert.equal(error.code, 'invalid-base', JSON.stringify(bad));
		assert.match(error.message, /^invalid base: /, JSON.stringify(bad));
		assert.deepEqual(stub.calls, [], `${JSON.stringify(bad)} asked Git nothing`);
	}
});

test('base: the base itself is still refused as the worktree branch', async () => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/dev': OTHER_SHA } });
	const error = await expectedError({ odd: 'x', branch: 'dev', base: 'dev' }, REPOSITORY, seamsFor(stub.git).seams);
	assert.equal(error.code, 'base-branch-is-target');
});

test('base: it only applies when the branch is created, so an existing branch with a base is refused', async () => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/dev': OTHER_SHA, 'refs/heads/feat/worktree-tools': BASE_SHA } });
	const error = await expectedError({ ...REQUEST, base: 'dev' }, REPOSITORY, seamsFor(stub.git).seams);
	assert.deepEqual(error, {
		code: 'base-on-existing-branch',
		message: 'branch feat/worktree-tools already exists, so it is checked out as it is; base only applies when the branch is created',
	});
});

test('base: the create text names the base the branch started from', async () => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/dev': OTHER_SHA } });
	const plan = await expectedPlan({ ...REQUEST, base: 'dev' }, REPOSITORY, seamsFor(stub.git).seams);
	const view = worktreeCreateView({ plan, registered: true });
	assert.match(view.text, new RegExp(`^base: dev@${OTHER_SHA.slice(0, 7)}$`, 'm'));
	assert.equal(view.details.base, 'dev');
});

test('S3: an existing branch is adopted and a held one names its holder', async () => {
	const adopted = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub({
		refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/feat/worktree-tools': OTHER_SHA },
	}).git).seams);
	assert.equal(adopted.branchState, 'existing');
	assert.deepEqual(adopted.args, ['worktree', 'add', DESTINATION, 'feat/worktree-tools']);

	const holderPath = '/dev/projects/repo-worktrees/file-picker';
	const error = await expectedError({ odd: 'x', branch: 'feat/file-picker' }, REPOSITORY, seamsFor(gitStub({
		holder: { path: holderPath, branch: 'feat/file-picker' },
	}).git).seams);
	assert.deepEqual(error, {
		code: 'branch-in-use',
		message: `branch feat/file-picker is already checked out in ${holderPath}\nUse a different branch, or work in that worktree.`,
	});
});

test('S3: no plan and no executed command ever passes --force', async () => {
	const stub = gitStub({ refs: { 'refs/heads/main': BASE_SHA, 'refs/heads/feat/worktree-tools': OTHER_SHA } });
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	assert.ok(!plan.args.includes('--force'));
	const execution = await executeWorktreeCreatePlan({ plan, git: stub.git });
	assert.equal(execution.ok, true);
	assert.ok(stub.calls.every((call) => !call.args.includes('--force')), 'no Git invocation forces anything');
});

test('S7: a second create for the same ODD is refused by the ODD path, whatever its branch', async () => {
	const stub = gitStub();
	const error = await expectedError({ odd: 'login-ui', branch: 'fix/login' }, REPOSITORY, seamsFor(stub.git, ['/dev/projects/repo-worktrees/login-ui']).seams);
	assert.deepEqual(error, {
		code: 'path-exists',
		message: 'worktree path already exists: /dev/projects/repo-worktrees/login-ui\nRemove it or pass a different odd.',
	});
	assert.ok(!stub.calls.some((call) => call.args[1] === 'add'), 'nothing was created');
});

test('S4: an occupied destination is refused without asking Git to create it', async () => {
	const stub = gitStub();
	const error = await expectedError(REQUEST, REPOSITORY, seamsFor(stub.git, [DESTINATION]).seams);
	assert.deepEqual(error, {
		code: 'path-exists',
		message: `worktree path already exists: ${DESTINATION}\nRemove it or pass a different odd.`,
	});
	assert.ok(!stub.calls.some((call) => call.args[1] === 'add'), 'nothing was created');
});

// ---- S3: executing the plan ----

test('S3: executing a plan creates the worktree and writes nothing else', async () => {
	const stub = gitStub();
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(stub.git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: stub.git });

	assert.deepEqual(execution, { ok: true, result: {} });
	assert.deepEqual(stub.calls.at(-1), { cwd: MAIN_ROOT, args: plan.args }, 'the planned `git worktree add` runs verbatim');
	assert.equal(
		stub.calls.filter((call) => call.args[0] === 'rev-parse' && call.args.includes('--git-dir')).length,
		0,
		'no administrative-directory read follows it',
	);
});

test('S7: a Git seam that answers nothing is reported without a result', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: async () => undefined });
	assert.deepEqual(execution, {
		ok: false,
		error: { code: 'git-failed', message: `could not create the worktree at ${DESTINATION}: git worktree add exited without a result` },
	});
});

test('S7: a failed git worktree add reports the backend exit', async () => {
	const stub = gitStub({ addCode: 128 });
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const execution = await executeWorktreeCreatePlan({ plan, git: stub.git });
	assert.deepEqual(execution, {
		ok: false,
		error: { code: 'git-failed', message: `could not create the worktree at ${DESTINATION}: git worktree add exited 128` },
	});
});

// ---- S1/S3: the create output ----

test('S16: the create text is the fixed line order, with no hooks part and no setup part', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const view = worktreeCreateView({ plan, registered: true });

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
	// S1: the hooks part and the setup part are gone — at call time the create knows
	// neither which hooks were skipped nor how the background chain went.
	const withHooks = worktreeCreateView({ plan, registered: true, hooks: [
		{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		{ name: 'symlink .turbo', status: 'failed', detail: 'could not link .turbo: EPERM' },
	] });
	assert.equal(withHooks.text, view.text, 'the hooks part never reaches the output');
	assert.doesNotMatch(withHooks.text, /hooks|setup|metadata:/);
	assert.deepEqual(view.details, {
		path: DESTINATION,
		name: 'worktree-tools',
		branch: 'feat/worktree-tools',
		branchState: 'created',
		base: 'main',
		baseSha: BASE_SHA,
		odd: 'worktree-tools',
		registered: true,
	});
});

test('S16/S17: a refused registration is reported, never claimed', async () => {
	const plan = await expectedPlan(REQUEST, REPOSITORY, seamsFor(gitStub().git).seams);
	const view = worktreeCreateView({ plan, registered: false });
	assert.equal(view.text.split('\n').at(-1), 'worktree register failed');
	assert.equal(view.details.registered, false);
});

test('S18: the copy_changes line is the only extra line, and its count reaches the details', async () => {
	const plan = await expectedPlan({ ...REQUEST, copy_changes: true }, REPOSITORY, seamsFor(gitStub().git).seams);
	assert.equal(plan.copyChanges, true);
	const hooks = [{ name: 'copy_changes', status: 'applied', copyChanges: { copied: 3, failed: [] } }];
	const view = worktreeCreateView({ plan, registered: true, hooks });

	assert.deepEqual(view.text.split('\n').slice(5), ['copy_changes: 3 changes copied']);
	assert.deepEqual(view.details.copyChanges, { copied: 3, failed: [] });
});

test('S18: a conflict is reported with its failing paths in the copy_changes line', async () => {
	const plan = await expectedPlan({ ...REQUEST, copy_changes: true }, REPOSITORY, seamsFor(gitStub().git).seams);
	const hooks = [{ name: 'copy_changes', status: 'failed', detail: 'could not copy: conflict.txt', copyChanges: { copied: 1, failed: ['conflict.txt'] } }];
	const view = worktreeCreateView({ plan, registered: true, hooks });

	assert.deepEqual(view.text.split('\n').slice(5), [
		'copy_changes: 1 changes copied; failed: conflict.txt',
	]);
	assert.deepEqual(view.details.copyChanges, { copied: 1, failed: ['conflict.txt'] });
});

// ---- Creation cases in real clones ----

test('base: a real clone starts the new branch from the base branch\'s commit, not main\'s', async (t) => {
	const repository = repositoryFixture(t);
	const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
	repository.git(repository.root, ['switch', '-q', '-c', 'dev']);
	writeFileSync(join(repository.root, 'dev-only.txt'), 'only on dev\n');
	repository.git(repository.root, ['add', 'dev-only.txt']);
	repository.git(repository.root, [...identity, 'commit', '-m', 'Dev work']);
	const devSha = repository.git(repository.root, ['rev-parse', 'HEAD']).trim();
	repository.git(repository.root, ['switch', '-q', 'main']);
	const mainSha = repository.git(repository.root, ['rev-parse', 'HEAD']).trim();
	assert.notEqual(devSha, mainSha, 'the fixture really has two different tips');

	const stub = repository.seam();
	const seams = { git: stub.git, exists: (path) => existsSync(path) };
	const fromDev = await planWorktreeCreate({ ...REQUEST, base: 'dev' }, { mainRoot: repository.root }, seams);
	if (fromDev.ok === false) assert.fail(fromDev.error.message);
	const execution = await executeWorktreeCreatePlan({ plan: fromDev.plan, git: stub.git });
	if (execution.ok === false) assert.fail(execution.error.message);
	assert.equal(repository.git(fromDev.plan.path, ['rev-parse', 'HEAD']).trim(), devSha, 'the worktree starts at dev');
	assert.equal(existsSync(join(fromDev.plan.path, 'dev-only.txt')), true, 'and carries dev\'s files');
	assert.match(worktreeCreateView({ plan: fromDev.plan, registered: true }).text, new RegExp(`^base: dev@${devSha.slice(0, 7)}$`, 'm'));

	// Without a base the same clone still starts from main.
	const fromMain = await planWorktreeCreate({ odd: 'other', branch: 'feat/other' }, { mainRoot: repository.root }, seams);
	if (fromMain.ok === false) assert.fail(fromMain.error.message);
	assert.equal(fromMain.plan.baseSha, mainSha);
	assert.equal(fromMain.plan.base, 'main');
});

test('S1/S3: a real clone creates the worktree, its branch, and no document at all', async (t) => {
	const repository = repositoryFixture(t);
	const stub = repository.seam();
	const seams = { git: stub.git, exists: (path) => existsSync(path) };
	const decision = await planWorktreeCreate(REQUEST, { mainRoot: repository.root }, seams);
	if (decision.ok === false) assert.fail(decision.error.message);
	const execution = await executeWorktreeCreatePlan({ plan: decision.plan, git: stub.git });
	if (execution.ok === false) assert.fail(execution.error.message);

	assert.equal(existsSync(decision.plan.path), true, 'the checkout exists');
	assert.ok(repository.git(repository.root, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/worktree-tools'));
	assert.ok(repository.git(repository.root, ['worktree', 'list', '--porcelain']).includes(decision.plan.path));
	// S3: the clone keeps no document. The only files `.git` gained are Git's own.
	assert.equal(existsSync(join(repository.commonDir, 'pi-worktrees.json')), false, 'no list file is written');
	assert.equal(existsSync(join(repository.commonDir, 'pi-worktrees.lock')), false, 'no lock file is written');
	assert.equal(existsSync(join(repository.commonDir, 'gentle-ai', 'worktrees.json')), false, 'no second document is written');
	const gitEntries = readdirSync(repository.commonDir).sort();
	assert.deepEqual(gitEntries.filter((name) => /worktrees?\.(json|lock)$/.test(name)), [], 'nothing list-shaped under .git');
});

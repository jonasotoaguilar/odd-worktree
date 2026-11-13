'use strict';
// The preparation hooks of `worktree_create` (S19, S20): the ordered chain, what it
// links and copies, the skip rules, the local configuration and the summary the
// create output prints. Every filesystem case uses a real temporary clone with an
// isolated HOME and Git configuration, removed in teardown; the Windows and
// refusal cases use an injected seam so no test depends on the host's link
// privileges or writes outside its own tree.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { copyFile, lstat, mkdir, readdir, readFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');

const {
	WORKTREE_ASSET_LINKS,
	WORKTREE_BUILD_CACHE_LINKS,
	WORKTREE_HOOKS_FILENAME,
	WORKTREE_INPUT_PREFIX,
	WORKTREE_NEVER_LINKED,
	copyChangesHook,
	defaultWorktreeHooks,
	emptyWorktreeHooksConfig,
	inputsHook,
	parseWorktreeHooksConfig,
	runWorktreeHooks,
	submodulesHook,
	symlinksHook,
	worktreeCopyChangesLine,
	worktreeHookRecords,
	worktreeHooksFilePath,
	worktreeHooksSummary,
} = require('../lib/worktree-hooks.js');

const ENV_MARKER = 'FIXTURE_ENV_VALUE\n';

// ---- A real clone with a worktree ----

/** The real seams the extension wires, written here so the tests check the contract from outside. */
function realSeams(git) {
	return {
		git,
		async kind(path) {
			try {
				const stats = await lstat(path);
				if (stats.isSymbolicLink()) return 'symlink';
				return stats.isDirectory() ? 'directory' : 'file';
			} catch {
				return undefined;
			}
		},
		async readdir(path) {
			try {
				return await readdir(path);
			} catch {
				return [];
			}
		},
		async readText(path) {
			try {
				return await readFile(path, 'utf8');
			} catch {
				return undefined;
			}
		},
		async copyFile(from, to) {
			await copyFile(from, to);
		},
		async mkdir(path) {
			await mkdir(path, { recursive: true });
		},
		async symlink(target, path, type) {
			await symlink(target, path, type);
		},
		platform: process.platform,
	};
}

function hooksFixture(t, options = {}) {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-hooks-')));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const empty = join(fixture, 'empty');
	mkdirSync(empty);
	writeFileSync(join(empty, 'config'), '');
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
	Object.assign(env, { HOME: fixture, GIT_CONFIG_GLOBAL: join(empty, 'config'), GIT_CONFIG_NOSYSTEM: '1' });
	const git = (cwd, args) =>
		execFileSync(
			'git',
			['-C', cwd, '-c', `core.hooksPath=${empty}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
			{ env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	const main = join(fixture, 'repo');
	git(fixture, ['init', '--initial-branch=main', `--template=${empty}`, main]);
	writeFileSync(join(main, 'tracked.txt'), 'fixture\n');
	const write = (rel, text) => {
		mkdirSync(dirname(join(main, rel)), { recursive: true });
		writeFileSync(join(main, rel), text);
	};
	for (const [rel, text] of Object.entries(options.tracked ?? {})) write(rel, text);
	git(main, ['add', '-A']);
	git(main, ['commit', '-m', 'Fixture']);
	for (const rel of options.directories ?? []) mkdirSync(join(main, rel), { recursive: true });
	for (const [rel, text] of Object.entries(options.files ?? {})) write(rel, text);
	for (const [rel, text] of Object.entries(options.unstaged ?? {})) write(rel, text);
	for (const [rel, text] of Object.entries(options.staged ?? {})) {
		write(rel, text);
		git(main, ['add', '--', rel]);
	}
	const commonDir = realpathSync(git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
	git(main, ['worktree', 'add', '-b', 'feat/hooks', join(fixture, 'repo-worktrees', 'hooks')]);
	const worktree = realpathSync(join(fixture, 'repo-worktrees', 'hooks'));
	return {
		fixture,
		main,
		worktree,
		commonDir,
		git,
		async run(runOptions = {}) {
			const gitCalls = [];
			const runner = async (cwd, args) => {
				gitCalls.push({ cwd, args });
				try {
					return { code: 0, stdout: git(cwd, [...args]) };
				} catch (error) {
					const failure = error;
					return { code: failure.status ?? 1, stdout: typeof failure.stdout === 'string' ? failure.stdout : '' };
				}
			};
			const input = {
				mainRoot: main,
				// The checkout whose uncommitted delta a copy reads is the one the caller
				// stands in, so the fixture names it explicitly and defaults to main.
				changesRoot: runOptions.changesRoot ?? main,
				path: runOptions.path ?? worktree,
				odd: 'worktree-tools',
				copyChanges: runOptions.copyChanges === true,
				seams: { ...realSeams(runner), ...runOptions.seams },
				configPath: runOptions.configPath ?? worktreeHooksFilePath(commonDir),
			};
			if (runOptions.hooks !== undefined) input.hooks = runOptions.hooks;
			const result = await runWorktreeHooks(input);
			return { ...result, gitCalls };
		},
	};
}

/** The S20 file, written into `<git-common-dir>/gentle-ai/`, which Git never versions. */
function writeLocalHooks(fixture, value) {
	const path = worktreeHooksFilePath(fixture.commonDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
	return path;
}

// ---- An injected seam for the cases no host can promise ----

function fakeWorld(options = {}) {
	const mainRoot = '/main';
	const worktree = '/worktree';
	const kinds = new Map();
	for (const rel of options.directories ?? []) kinds.set(join(mainRoot, rel), 'directory');
	const links = [];
	const copies = [];
	const relative = (path) => path.slice(mainRoot.length + 1);
	const seams = {
		async git(_cwd, args) {
			const rel = args[args.length - 1];
			if (args[0] === 'ls-files') return { code: (options.tracked ?? []).includes(rel) ? 0 : 1, stdout: '' };
			if (args[0] === 'check-ignore') return { code: (options.ignored ?? []).includes(rel) ? 0 : 1, stdout: '' };
			return undefined;
		},
		async kind(path) {
			return kinds.get(path) ?? (relative(path).length > 0 ? undefined : 'directory');
		},
		async readdir() {
			return [];
		},
		async readText() {
			return undefined;
		},
		async copyFile(from, to) {
			copies.push({ from, to });
		},
		async mkdir() {},
		async symlink(target, path, type) {
			const refusal = (options.fails ?? {})[type];
			if (refusal !== undefined) throw new Error(refusal);
			links.push({ target, path, type });
			kinds.set(path, 'symlink');
		},
		platform: options.platform ?? 'linux',
	};
	return { seams, links, copies, mainRoot, worktree };
}

// ---- S19: the chain ----

test('S19/S18: the default chain is ordered and puts copy_changes between the inputs and the links', () => {
	assert.deepEqual(defaultWorktreeHooks().map((hook) => hook.name), ['submodules', 'inputs', 'copy_changes', 'symlinks']);
	const chain = defaultWorktreeHooks();
	chain.splice(2, 1);
	assert.deepEqual(
		defaultWorktreeHooks().map((hook) => hook.name),
		['submodules', 'inputs', 'copy_changes', 'symlinks'],
		"a caller's edit stays with the caller's chain",
	);
});

test('S19: build caches main has and does not track are linked into the worktree', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { '.gitignore': '.turbo\n.next/cache\n' },
		directories: ['.turbo/cache', '.next/cache/build'],
	});
	const run = await fixture.run({ hooks: [symlinksHook] });

	for (const rel of ['.turbo', '.next/cache']) {
		const link = join(fixture.worktree, rel);
		assert.ok(existsSync(link), `${rel} exists in the worktree`);
		assert.ok(lstatSync(link).isSymbolicLink(), `${rel} is a link, not a copy`);
		assert.equal(realpathSync(link), realpathSync(join(fixture.main, rel)), `${rel} points at main's directory`);
	}
	assert.equal(lstatSync(join(fixture.worktree, '.next')).isSymbolicLink(), false, 'only the cache directory is linked');
	assert.deepEqual(run.results, [
		{ name: 'symlink .turbo', status: 'applied' },
		{ name: 'symlink .next/cache', status: 'applied' },
		{ name: 'symlink .parcel-cache', status: 'skipped', detail: '.parcel-cache not in main' },
		{ name: 'symlink .pytest_cache', status: 'skipped', detail: '.pytest_cache not in main' },
		{ name: 'symlink .ruff_cache', status: 'skipped', detail: '.ruff_cache not in main' },
		{ name: 'symlink .agents', status: 'skipped', detail: '.agents not in main' },
		{ name: 'symlink .atl', status: 'skipped', detail: '.atl not in main' },
		{ name: 'symlink .claude', status: 'skipped', detail: '.claude not in main' },
		{ name: 'symlink odd', status: 'skipped', detail: 'odd not in main' },
	]);
	assert.equal(run.summary, 'hooks: 2 applied, 7 skipped');
});

test('S19: local asset directories are linked only when main has them untracked', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { '.gitignore': '.claude\n.agents\n', '.atl/note.md': 'tracked\n' },
		directories: ['.claude/skills', '.agents/notes'],
	});
	const run = await fixture.run({ hooks: [symlinksHook] });

	assert.ok(lstatSync(join(fixture.worktree, '.claude')).isSymbolicLink(), '.claude is linked');
	assert.ok(lstatSync(join(fixture.worktree, '.agents')).isSymbolicLink(), '.agents is linked');
	assert.equal(lstatSync(join(fixture.worktree, '.atl')).isSymbolicLink(), false, '.atl is tracked, so it arrives with the checkout');
	assert.equal(existsSync(join(fixture.worktree, 'odd')), false);
	assert.deepEqual(
		run.results.filter((result) => result.status === 'applied').map((result) => result.name),
		['symlink .agents', 'symlink .claude'],
	);
	assert.deepEqual(
		run.results.filter((result) => result.status === 'skipped' && result.detail === 'tracked').map((result) => result.name),
		['symlink .atl'],
	);
	assert.deepEqual(run.results.at(-1), { name: 'symlink odd', status: 'skipped', detail: 'odd not in main' });
});

test('S19: the .env family is copied, never read, and never linked', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { '.env.example': 'EXAMPLE\n' },
		files: { '.env.local': ENV_MARKER },
	});
	const run = await fixture.run({ hooks: [inputsHook] });

	const copied = join(fixture.worktree, '.env.local');
	assert.ok(existsSync(copied), '.env.local reached the worktree');
	assert.equal(lstatSync(copied).isSymbolicLink(), false, 'an input is copied, never linked');
	assert.equal(readFileSync(copied, 'utf8'), ENV_MARKER, 'the copy is byte-identical');
	assert.equal(lstatSync(join(fixture.worktree, '.env.example')).isSymbolicLink(), false, 'a tracked input keeps its checkout copy');
	assert.deepEqual(run.results, [
		{ name: 'copy .env.example', status: 'skipped', detail: 'tracked' },
		{ name: 'copy .env.local', status: 'applied', warning: '.env.local is not ignored; add .env.local to .gitignore' },
	]);
	assert.equal(run.summary, 'hooks: 1 applied, 1 skipped, warning: .env.local is not ignored; add .env.local to .gitignore');
});

test('S19: a path package managers own is never linked, whatever main holds', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { '.gitignore': 'node_modules/\nvendor/\n.venv/\ntarget/\ndeps/\n.pi/gentle-ai/\n.gentle-ai/\n' },
		directories: ['node_modules/pkg', 'vendor/gem', '.venv/lib', 'target/debug', 'deps/cache', '.pi/gentle-ai/x', '.gentle-ai/y'],
	});
	const run = await fixture.run({ hooks: [symlinksHook] });

	for (const rel of ['node_modules', 'vendor', '.venv', 'target', 'deps', '.pi/gentle-ai', '.gentle-ai']) {
		assert.equal(existsSync(join(fixture.worktree, rel)), false, `${rel} is never linked`);
	}
	assert.equal(run.results.filter((result) => result.status === 'applied').length, 0, 'the 7 forbidden directories are not candidates at all');
});

test('S19: an untracked path .gitignore does not silence is still linked, with a warning', async (t) => {
	const fixture = hooksFixture(t, { directories: ['.agents/notes'] });
	const run = await fixture.run({ hooks: [symlinksHook] });

	assert.ok(lstatSync(join(fixture.worktree, '.agents')).isSymbolicLink(), 'the directory is still linked');
	assert.deepEqual(run.results[5], {
		name: 'symlink .agents',
		status: 'applied',
		warning: '.agents is not ignored; add .agents to .gitignore',
	});
	assert.equal(run.summary, 'hooks: 1 applied, 8 skipped, warning: .agents is not ignored; add .agents to .gitignore');
});

test('S19: a failing hook is reported and the chain keeps going', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { '.gitignore': '.turbo\n.next/cache\n' },
		directories: ['.turbo/cache', '.next/cache/build'],
	});
	const run = await fixture.run({
		seams: {
			async symlink(target, path, type) {
				if (path.endsWith('.turbo')) throw new Error('EPERM: operation not permitted');
				await symlink(target, path, type);
			},
		},
	});

	const turbo = run.results.find((result) => result.name === 'symlink .turbo');
	assert.deepEqual(turbo, { name: 'symlink .turbo', status: 'failed', detail: 'could not link .turbo: EPERM: operation not permitted' });
	assert.ok(lstatSync(join(fixture.worktree, '.next/cache')).isSymbolicLink(), 'the next hook still ran');
	assert.equal(existsSync(join(fixture.worktree, '.turbo')), false, 'a failed link is never replaced by a copy');
	assert.ok(existsSync(join(fixture.worktree, 'tracked.txt')), 'the worktree is still usable');
	assert.equal(fixture.git(fixture.worktree, ['status', '--porcelain']).trim(), '', 'the failed hook left no partial state');
	assert.equal(run.summary, 'hooks: 1 applied, 9 skipped, 1 failed: symlink .turbo (could not link .turbo: EPERM: operation not permitted)');
});

test('S19: a link the platform refuses falls back to a junction, and never to a copy', async () => {
	const world = fakeWorld({ directories: ['.turbo'], ignored: ['.turbo'], fails: { dir: 'EPERM: operation not permitted' } });
	const run = await runWorktreeHooks({
		mainRoot: world.mainRoot,
		path: world.worktree,
		odd: 'worktree-tools',
		seams: world.seams,
		configPath: '/main/.git/gentle-ai/worktree-hooks.json',
		hooks: [symlinksHook],
	});

	assert.deepEqual(run.results[0], { name: 'symlink .turbo', status: 'applied', detail: 'junction' });
	assert.deepEqual(world.links, [{ target: '/main/.turbo', path: '/worktree/.turbo', type: 'junction' }]);
	assert.deepEqual(world.copies, [], 'a refused link is never silently copied');
});

test('S19: on Windows the junction is the first attempt', async () => {
	const world = fakeWorld({ platform: 'win32', directories: ['.turbo'], ignored: ['.turbo'] });
	const run = await runWorktreeHooks({
		mainRoot: world.mainRoot,
		path: world.worktree,
		odd: 'worktree-tools',
		seams: world.seams,
		configPath: '/main/.git/gentle-ai/worktree-hooks.json',
		hooks: [symlinksHook],
	});

	assert.deepEqual(run.results[0], { name: 'symlink .turbo', status: 'applied', detail: 'junction' });
	assert.deepEqual(world.links.map((link) => link.type), ['junction'], 'Windows prefers the junction that needs no privilege');
});

test('S19: a link refused twice is reported as failed, never replaced by a copy', async () => {
	const world = fakeWorld({
		platform: 'win32',
		directories: ['.turbo'],
		ignored: ['.turbo'],
		fails: { dir: 'EPERM: symlink refused', junction: 'EPERM: junction refused' },
	});
	const run = await runWorktreeHooks({
		mainRoot: world.mainRoot,
		path: world.worktree,
		odd: 'worktree-tools',
		seams: world.seams,
		configPath: '/main/.git/gentle-ai/worktree-hooks.json',
		hooks: [symlinksHook],
	});

	assert.deepEqual(run.results[0], { name: 'symlink .turbo', status: 'failed', detail: 'could not link .turbo: EPERM: junction refused' });
	assert.deepEqual(world.links, []);
	assert.deepEqual(world.copies, [], 'the failure is reported instead of a copy that pretends to be a link');
	assert.equal(run.summary, 'hooks: 8 skipped, 1 failed: symlink .turbo (could not link .turbo: EPERM: junction refused)');
});

// ---- S20: the local configuration ----

test('S20: the local file extends the copy and link lists and enables setup', async (t) => {
	const fixture = hooksFixture(t, {
		files: { 'config/local.json': '{}\n' },
		directories: ['.cache/data'],
	});
	writeLocalHooks(fixture, { version: 1, copy: ['config/local.json'], link: ['.cache'], setup: true });
	const run = await fixture.run();

	assert.deepEqual(run.config, { copy: ['config/local.json'], link: ['.cache'], setup: true });
	assert.ok(existsSync(join(fixture.worktree, 'config/local.json')), 'the configured input was copied');
	assert.ok(lstatSync(join(fixture.worktree, '.cache')).isSymbolicLink(), 'the configured directory was linked');
	assert.deepEqual(
		run.results.filter((result) => result.status === 'applied').map((result) => result.name),
		['copy config/local.json', 'symlink .cache'],
	);
	assert.deepEqual(
		[run.results[1]?.warning, run.results.at(-1)?.warning],
		['config/local.json is not ignored; add config/local.json to .gitignore', '.cache is not ignored; add .cache to .gitignore'],
	);
	assert.deepEqual(run.results.find((result) => result.name === 'submodules'), {
		name: 'submodules',
		status: 'skipped',
		detail: 'no submodules',
	});
});

test('S20: entries that would leave the worktree or cross the never-linked list are refused', async (t) => {
	assert.deepEqual(parseWorktreeHooksConfig('{"version":1,"link":["node_modules","../escape","/absolute",".cache"]}'), {
		copy: [],
		link: ['node_modules', '.cache'],
		setup: false,
	});
	assert.deepEqual(parseWorktreeHooksConfig('{"copy":["../escape","node_modules/x"],"setup":"pnpm install"}'), {
		copy: ['node_modules/x'],
		link: [],
		setup: false,
	});
	assert.deepEqual(parseWorktreeHooksConfig('not json at all'), { copy: [], link: [], setup: false }, 'an unreadable file keeps the defaults');
	assert.deepEqual(parseWorktreeHooksConfig(undefined), { copy: [], link: [], setup: false }, 'an absent file keeps the defaults');

	const fixture = hooksFixture(t, {
		tracked: { '.gitignore': 'node_modules/\n' },
		directories: ['node_modules/pkg'],
	});
	writeLocalHooks(fixture, { link: ['node_modules', '.pi/gentle-ai'], copy: ['../escape', 'node_modules/pkg'] });
	const run = await fixture.run({ hooks: [symlinksHook, inputsHook] });

	assert.equal(existsSync(join(fixture.worktree, 'node_modules')), false, 'a package-manager directory is never linked');
	assert.equal(existsSync(join(fixture.fixture, 'escape')), false, 'an entry cannot reach outside the worktree');
	assert.deepEqual(run.results.slice(9, 11), [
		{ name: 'symlink node_modules', status: 'skipped', detail: 'node_modules is never linked' },
		{ name: 'symlink .pi/gentle-ai', status: 'skipped', detail: '.pi/gentle-ai is never linked' },
	]);
	assert.deepEqual(run.results.filter((result) => result.name.startsWith('copy ')), [
		{ name: 'copy node_modules/pkg', status: 'skipped', detail: 'node_modules/pkg is not a file' },
	]);
});

test('S20: commands in any versioned repository file are never executed', async (t) => {
	const command = `node -e "require('node:fs').writeFileSync('pwned','1')"`;
	const fixture = hooksFixture(t, {
		tracked: {
			'worktree-hooks.json': JSON.stringify({ copy: ['config/versioned.json'], commands: [command] }),
			'.gentle-ai/worktree-hooks.json': JSON.stringify({ link: ['.cache-assets'], commands: [command] }),
		},
		files: { 'config/versioned.json': '{}\n' },
		directories: ['.cache-assets/data'],
	});
	const versioned = await fixture.run({ hooks: [inputsHook, symlinksHook] });

	assert.ok(!existsSync(join(fixture.worktree, 'config/versioned.json')), 'a versioned copy list is never read');
	assert.equal(existsSync(join(fixture.worktree, '.cache-assets')), false, 'a versioned link list is never read');
	assert.deepEqual(versioned.config, { copy: [], link: [], setup: false });
	assert.equal(existsSync(join(fixture.fixture, 'pwned')), false);

	writeLocalHooks(fixture, { version: 1, copy: [], commands: [command], setup: true });
	const local = await fixture.run({ hooks: [inputsHook, symlinksHook] });

	assert.deepEqual(local.config, { copy: [], link: [], setup: true }, 'only the boolean setup flag is read, never a command');
	assert.equal(existsSync(join(fixture.fixture, 'pwned')), false, 'a command in the local file is never executed');
	assert.ok(
		local.gitCalls.every((call) => call.args[0] === 'ls-files' || call.args[0] === 'check-ignore'),
		"the chain runs no command but Git's own queries",
	);
});

// ---- S18: copy_changes ----

test('S18: true copies the staged, unstaged and untracked changes and counts files', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { '.gitignore': 'ignored.log\n', 'modified.txt': 'base\n' },
		staged: { 'added.txt': 'added\n' },
		unstaged: { 'modified.txt': 'changed\n' },
		files: { 'ignored.log': 'ignored\n', 'untracked.txt': 'untracked\n' },
	});
	const run = await fixture.run({ copyChanges: true });

	assert.equal(readFileSync(join(fixture.worktree, 'modified.txt'), 'utf8'), 'changed\n', 'an unstaged edit reaches the worktree');
	assert.equal(readFileSync(join(fixture.worktree, 'added.txt'), 'utf8'), 'added\n', 'a staged addition reaches the worktree');
	assert.equal(readFileSync(join(fixture.worktree, 'untracked.txt'), 'utf8'), 'untracked\n', 'an untracked file is copied');
	assert.equal(existsSync(join(fixture.worktree, 'ignored.log')), false, 'an ignored file is never copied');
	assert.deepEqual(
		fixture
			.git(fixture.worktree, ['status', '--porcelain'])
			.trim()
			.split('\n')
			.map((line) => line.slice(3))
			.sort(),
		['added.txt', 'modified.txt', 'untracked.txt'],
		'exactly the copied paths changed in the worktree',
	);

	assert.equal(readFileSync(join(fixture.main, 'modified.txt'), 'utf8'), 'changed\n', 'main keeps its unstaged edit');
	assert.deepEqual(
		fixture
			.git(fixture.main, ['status', '--porcelain'])
			.trimEnd()
			.split('\n')
			.map((line) => line.slice(3))
			.sort(),
		['added.txt', 'modified.txt', 'untracked.txt'],
		'main keeps every uncommitted change; the ignored file is not one Git reports',
	);

	assert.deepEqual(run.results.find((result) => result.name === 'copy_changes'), {
		name: 'copy_changes',
		status: 'applied',
		copyChanges: { copied: 3, failed: [] },
	});
	assert.equal(worktreeCopyChangesLine(run.results), 'copy_changes: 3 changes copied');
	assert.equal(run.summary, 'hooks: 1 applied, 11 skipped', 'the step is part of the one hooks summary');
	assert.ok(
		run.gitCalls.some((call) => call.cwd === fixture.main && call.args.join(' ') === 'diff --name-only --no-renames -z HEAD'),
		'the changed paths come from Git, never from a directory walk',
	);
	assert.ok(
		run.gitCalls.some((call) => call.cwd === fixture.main && call.args[0] === 'diff' && call.args.includes('--binary')),
		'the patch is the binary diff of HEAD against both the index and the worktree',
	);
	assert.ok(
		run.gitCalls.some((call) => call.cwd === fixture.worktree && call.args[0] === 'apply' && call.args.includes('--3way')),
		'the patch is applied in the new worktree with --3way',
	);
});

test('S18: the delta is read from the asking checkout, never from main', async (t) => {
	const fixture = hooksFixture(t, { tracked: { 'shared.txt': 'base\n' }, files: { 'main-only.txt': 'main\n' } });
	fixture.git(fixture.main, ['worktree', 'add', '-b', 'feat/destination', join(fixture.fixture, 'repo-worktrees', 'destination')]);
	const destination = realpathSync(join(fixture.fixture, 'repo-worktrees', 'destination'));
	writeFileSync(join(fixture.worktree, 'asking-only.txt'), 'asking\n');
	writeFileSync(join(fixture.worktree, 'shared.txt'), 'asking edit\n');

	const run = await fixture.run({
		copyChanges: true,
		changesRoot: fixture.worktree,
		path: destination,
		hooks: [copyChangesHook],
	});

	assert.equal(readFileSync(join(destination, 'asking-only.txt'), 'utf8'), 'asking\n', "the asking checkout's untracked file travels");
	assert.equal(readFileSync(join(destination, 'shared.txt'), 'utf8'), 'asking edit\n', "the asking checkout's edit travels");
	assert.equal(existsSync(join(destination, 'main-only.txt')), false, "main's uncommitted file stays behind");
	assert.deepEqual(run.results, [{ name: 'copy_changes', status: 'applied', copyChanges: { copied: 2, failed: [] } }]);
	assert.equal(readFileSync(join(fixture.worktree, 'asking-only.txt'), 'utf8'), 'asking\n', 'the asking checkout keeps its own change');
	assert.equal(readFileSync(join(fixture.main, 'main-only.txt'), 'utf8'), 'main\n', 'main keeps its own change');
	assert.ok(
		run.gitCalls.some((call) => call.cwd === fixture.worktree && call.args.join(' ') === 'diff --name-only --no-renames -z HEAD'),
		'the changed paths are read in the asking checkout',
	);
	assert.ok(
		run.gitCalls.some((call) => call.cwd === fixture.worktree && call.args[0] === 'diff' && call.args.includes('--binary')),
		'the patch is read in the asking checkout',
	);
	assert.ok(
		run.gitCalls.some((call) => call.cwd === destination && call.args[0] === 'apply'),
		'the patch still lands in the new worktree',
	);
});

test("S18: a staged rename copies its deletion and its addition", async (t) => {
	const fixture = hooksFixture(t, { tracked: { 'old.txt': 'content\n' } });
	fixture.git(fixture.main, ['mv', 'old.txt', 'new.txt']);
	const run = await fixture.run({ copyChanges: true, hooks: [copyChangesHook] });

	assert.equal(existsSync(join(fixture.worktree, 'old.txt')), false, "the rename's deletion reaches the worktree");
	assert.equal(readFileSync(join(fixture.worktree, 'new.txt'), 'utf8'), 'content\n', "the rename's addition reaches the worktree");
	assert.deepEqual(run.results, [{ name: 'copy_changes', status: 'applied', copyChanges: { copied: 2, failed: [] } }]);
	assert.equal(worktreeCopyChangesLine(run.results), 'copy_changes: 2 changes copied');
});

test('S18: an omitted or false copy_changes copies nothing and prints nothing', async (t) => {
	const fixture = hooksFixture(t, {
		tracked: { 'modified.txt': 'base\n' },
		unstaged: { 'modified.txt': 'changed\n' },
		files: { 'untracked.txt': 'untracked\n' },
	});
	for (const copyChanges of [undefined, false]) {
		const run = await fixture.run(copyChanges === undefined ? {} : { copyChanges });
		assert.equal(run.results.some((result) => result.name === 'copy_changes'), false, 'the step reports nothing when it was not requested');
		assert.equal(worktreeCopyChangesLine(run.results), undefined, 'there is no line to print');
		assert.equal(readFileSync(join(fixture.worktree, 'modified.txt'), 'utf8'), 'base\n', 'the worktree keeps its checkout copy');
		assert.equal(existsSync(join(fixture.worktree, 'untracked.txt')), false, 'no untracked file was carried over');
	}
});

test('S18: true with no uncommitted changes is not an error', async (t) => {
	const fixture = hooksFixture(t);
	const run = await fixture.run({ copyChanges: true });

	assert.deepEqual(run.results.find((result) => result.name === 'copy_changes'), {
		name: 'copy_changes',
		status: 'skipped',
		detail: 'no uncommitted changes',
		copyChanges: { copied: 0, failed: [] },
	});
	assert.equal(worktreeCopyChangesLine(run.results), 'copy_changes: no uncommitted changes to copy');
	assert.equal(fixture.git(fixture.worktree, ['status', '--porcelain']).trim(), '', 'the worktree stays clean');
});

test('S18: a conflicting change reports its paths and leaves the worktree clean', async (t) => {
	const fixture = hooksFixture(t, { tracked: { 'clean.txt': 'base\n', 'conflict.txt': 'base\n' } });
	writeFileSync(join(fixture.worktree, 'conflict.txt'), 'branch\n');
	fixture.git(fixture.worktree, ['commit', '-am', 'Branch edit']);
	writeFileSync(join(fixture.main, 'clean.txt'), 'main clean\n');
	writeFileSync(join(fixture.main, 'conflict.txt'), 'main\n');
	const run = await fixture.run({ copyChanges: true, hooks: [copyChangesHook] });

	assert.deepEqual(run.results, [
		{
			name: 'copy_changes',
			status: 'failed',
			detail: 'could not copy: conflict.txt',
			copyChanges: { copied: 1, failed: ['conflict.txt'] },
		},
	]);
	assert.equal(
		worktreeCopyChangesLine(run.results),
		'copy_changes: 1 changes copied; failed: conflict.txt',
	);
	assert.equal(run.summary, 'hooks: 1 failed: copy_changes (could not copy: conflict.txt)');
	assert.equal(readFileSync(join(fixture.worktree, 'conflict.txt'), 'utf8'), 'branch\n', "the conflicted path keeps the branch's content");
	assert.equal(readFileSync(join(fixture.worktree, 'clean.txt'), 'utf8'), 'main clean\n', 'the clean change still landed');
	assert.equal(fixture.git(fixture.worktree, ['status', '--porcelain']).trimEnd(), ' M clean.txt', 'no conflict state survives in the worktree');
	assert.equal(readFileSync(join(fixture.main, 'conflict.txt'), 'utf8'), 'main\n', 'main is untouched by the failure');
	assert.ok(existsSync(join(fixture.worktree, 'tracked.txt')), 'the worktree is still usable');
});

// ---- The branches the fixed lists and the pure helpers decide ----

/** A seam set that answers nothing; each case overrides exactly what it exercises. */
function seamWorld(overrides = {}) {
	return {
		async git() {
			return { code: 0, stdout: '' };
		},
		async kind() {
			return undefined;
		},
		async readdir() {
			return [];
		},
		async readText() {
			return undefined;
		},
		async copyFile() {},
		async mkdir() {},
		async symlink() {},
		platform: 'linux',
		...overrides,
	};
}

function runSeams(seams, hooks, extra = {}) {
	return runWorktreeHooks({
		mainRoot: '/main',
		path: '/worktree',
		odd: 'worktree-tools',
		seams,
		configPath: '/main/.git/gentle-ai/worktree-hooks.json',
		hooks,
		...extra,
	});
}

test('S19/S20: the fixed lists are the ones the contract names', () => {
	assert.equal(WORKTREE_HOOKS_FILENAME, 'worktree-hooks.json');
	assert.equal(worktreeHooksFilePath('/clone/.git'), '/clone/.git/gentle-ai/worktree-hooks.json');
	assert.deepEqual(WORKTREE_NEVER_LINKED, ['node_modules', 'vendor', '.venv', 'target', 'deps', '.pi/gentle-ai', '.gentle-ai']);
	assert.deepEqual(WORKTREE_BUILD_CACHE_LINKS, ['.turbo', '.next/cache', '.parcel-cache', '.pytest_cache', '.ruff_cache']);
	assert.deepEqual(WORKTREE_ASSET_LINKS, ['.agents', '.atl', '.claude', 'odd']);
	assert.equal(WORKTREE_INPUT_PREFIX, '.env');
	assert.deepEqual(emptyWorktreeHooksConfig(), { copy: [], link: [], setup: false });
});

test('S20: the parser refuses an array, a control character and duplicates, and normalises a trailing slash', () => {
	assert.deepEqual(parseWorktreeHooksConfig('[]'), { copy: [], link: [], setup: false }, 'an array is not a configuration');
	assert.deepEqual(parseWorktreeHooksConfig('null'), { copy: [], link: [], setup: false });
	assert.deepEqual(parseWorktreeHooksConfig('{"copy":["a\\u0000b"]}'), { copy: [], link: [], setup: false }, 'a control character is refused');
	assert.deepEqual(parseWorktreeHooksConfig('{"link":[".cache/",".cache","./x","../y","/z"]}'), {
		copy: [],
		link: ['.cache'],
		setup: false,
	});
});

test('S19: submodules are updated when main has .gitmodules, and a refused update is reported', async () => {
	const calls = [];
	const applied = await runSeams(
		seamWorld({
			async kind(path) {
				return path === '/main/.gitmodules' ? 'file' : undefined;
			},
			async git(cwd, args) {
				calls.push({ cwd, args });
				return { code: 0, stdout: '' };
			},
		}),
		[submodulesHook],
	);
	assert.deepEqual(applied.results, [{ name: 'submodules', status: 'applied' }]);
	assert.deepEqual(calls, [{ cwd: '/worktree', args: ['submodule', 'update', '--init', '--recursive'] }]);

	const withGitmodules = (result) =>
		seamWorld({
			async kind(path) {
				return path === '/main/.gitmodules' ? 'file' : undefined;
			},
			async git() {
				return result;
			},
		});
	const refused = await runSeams(withGitmodules({ code: 1, stdout: '' }), [submodulesHook]);
	assert.deepEqual(refused.results, [
		{ name: 'submodules', status: 'failed', detail: 'git submodule update --init --recursive exited 1' },
	]);
	const silent = await runSeams(withGitmodules(undefined), [submodulesHook]);
	assert.deepEqual(silent.results, [
		{ name: 'submodules', status: 'failed', detail: 'git submodule update --init --recursive exited without a result' },
	]);
});

test('S19: the inputs step reports an empty main, a path already in the worktree and a refused copy', async () => {
	const none = await runSeams(seamWorld(), [inputsHook]);
	assert.deepEqual(none.results, [{ name: 'inputs', status: 'skipped', detail: 'no .env files in main' }]);
	assert.equal(none.summary, undefined, 'a step that skipped and applied nothing prints no summary');

	const existing = await runSeams(
		seamWorld({
			async readdir() {
				return ['.env.local'];
			},
			async kind(path) {
				return path === '/main/.env.local' || path === '/worktree/.env.local' ? 'file' : undefined;
			},
			async git() {
				return { code: 1, stdout: '' };
			},
		}),
		[inputsHook],
	);
	assert.deepEqual(existing.results, [
		{ name: 'copy .env.local', status: 'skipped', detail: '.env.local already exists in the worktree' },
	]);

	const refused = await runSeams(
		seamWorld({
			async readdir() {
				return ['.env.local'];
			},
			async kind(path) {
				return path === '/main/.env.local' ? 'file' : undefined;
			},
			async git() {
				return { code: 1, stdout: '' };
			},
			async copyFile() {
				throw new Error('EACCES: permission denied');
			},
		}),
		[inputsHook],
	);
	assert.deepEqual(refused.results, [
		{ name: 'copy .env.local', status: 'failed', detail: 'could not copy .env.local: EACCES: permission denied' },
	]);
});

test('S18: an unreadable change list and an unreadable administrative directory are failures', async () => {
	const unreadable = await runSeams(seamWorld({ async git() { return undefined; } }), [copyChangesHook], { copyChanges: true });
	assert.deepEqual(unreadable.results, [{ name: 'copy_changes', status: 'failed', detail: 'could not read the uncommitted changes' }]);
	assert.equal(worktreeCopyChangesLine(unreadable.results), 'copy_changes: could not read the uncommitted changes');

	const noAdminDir = await runSeams(
		seamWorld({
			async git(_cwd, args) {
				if (args[0] === 'diff') return { code: 0, stdout: 'a.txt\0' };
				if (args[0] === 'ls-files') return { code: 0, stdout: '' };
				return { code: 1, stdout: '' };
			},
		}),
		[copyChangesHook],
		{ copyChanges: true },
	);
	assert.deepEqual(noAdminDir.results, [
		{
			name: 'copy_changes',
			status: 'failed',
			detail: "could not read the worktree's administrative directory",
			copyChanges: { copied: 0, failed: ['a.txt'] },
		},
	]);
});

test('S18: an untracked path already in the worktree is left alone, and a refused copy is reported', async () => {
	const untrackedWorld = (path, destinationKind, copyFile) =>
		seamWorld({
			async git(_cwd, args) {
				if (args[0] === 'diff') return { code: 0, stdout: '' };
				if (args[0] === 'ls-files') return { code: 0, stdout: `${path}\0` };
				if (args[0] === 'rev-parse') return { code: 0, stdout: '/admin' };
				return { code: 1, stdout: '' };
			},
			async kind(candidate) {
				return candidate === `/worktree/${path}` ? destinationKind : undefined;
			},
			copyFile,
		});

	const present = await runSeams(
		untrackedWorld('present.txt', 'file', async () => {
			throw new Error('a present path is never copied');
		}),
		[copyChangesHook],
		{ copyChanges: true },
	);
	assert.deepEqual(present.results, [{ name: 'copy_changes', status: 'applied', copyChanges: { copied: 0, failed: [] } }]);
	assert.equal(worktreeCopyChangesLine(present.results), 'copy_changes: no uncommitted changes to copy');

	const refused = await runSeams(
		untrackedWorld('blocked.txt', undefined, async () => {
			throw new Error('EACCES: permission denied');
		}),
		[copyChangesHook],
		{ copyChanges: true },
	);
	assert.deepEqual(refused.results, [
		{ name: 'copy_changes', status: 'failed', detail: 'could not copy: blocked.txt', copyChanges: { copied: 0, failed: ['blocked.txt'] } },
	]);
});

test('S19: an existing path in the worktree is skipped, never overwritten', async () => {
	const run = await runSeams(
		seamWorld({
			async kind(path) {
				if (path === '/main/.agents') return 'directory';
				if (path === '/worktree/.agents') return 'symlink';
				return undefined;
			},
			async git() {
				return { code: 1, stdout: '' };
			},
		}),
		[symlinksHook],
	);
	assert.deepEqual(run.results[5], { name: 'symlink .agents', status: 'skipped', detail: '.agents already exists in the worktree' });
});

test('S19: a hook that throws is recorded under its own name and the chain keeps going', async () => {
	const run = await runSeams(seamWorld(), [
		{
			name: 'explode',
			async run() {
				throw new Error('kaboom');
			},
		},
		submodulesHook,
	]);

	assert.deepEqual(run.results, [
		{ name: 'explode', status: 'failed', detail: 'kaboom' },
		{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
	]);
	assert.equal(run.summary, 'hooks: 1 skipped, 1 failed: explode (kaboom)');
});

// ---- S16 and S7: what the create flow stores and prints ----

test('S19: the stored records carry the hook name, status and reason', () => {
	assert.deepEqual(
		worktreeHookRecords([
			{ name: 'symlink .turbo', status: 'applied', warning: '.turbo is not ignored; add .turbo to .gitignore' },
			{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		]),
		[
			{ name: 'symlink .turbo', status: 'applied', detail: '.turbo is not ignored; add .turbo to .gitignore' },
			{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		],
	);
	assert.deepEqual(worktreeHookRecords([{ name: 'symlink .atl', status: 'applied' }]), [{ name: 'symlink .atl', status: 'applied' }]);
});

test('S16: the hooks summary is absent when nothing applied and nothing failed', () => {
	assert.equal(worktreeHooksSummary([]), undefined);
	assert.equal(worktreeHooksSummary([{ name: 'submodules', status: 'skipped', detail: 'no submodules' }]), undefined);
	assert.equal(
		worktreeHooksSummary([
			{ name: 'a', status: 'applied' },
			{ name: 'b', status: 'skipped', detail: 'tracked' },
		]),
		'hooks: 1 applied, 1 skipped',
	);
	assert.equal(
		worktreeHooksSummary([
			{ name: 'copy .env.local', status: 'applied', warning: '.env.local is not ignored; add .env.local to .gitignore' },
			{ name: 'symlink .turbo', status: 'failed', detail: 'EPERM' },
			{ name: 'submodules', status: 'skipped', detail: 'no submodules' },
		]),
		'hooks: 1 applied, 1 skipped, 1 failed: symlink .turbo (EPERM), warning: .env.local is not ignored; add .env.local to .gitignore',
	);
	assert.equal(worktreeHooksSummary([{ name: 'symlink .turbo', status: 'failed', detail: 'EPERM' }]), 'hooks: 1 failed: symlink .turbo (EPERM)');
	assert.equal(worktreeHooksSummary([{ name: 'explode', status: 'failed' }]), 'hooks: 1 failed: explode (no reason)');
});

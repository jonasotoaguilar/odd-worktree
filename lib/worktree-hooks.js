'use strict';
// The preparation hooks of `worktree_create` (S19, S20).
//
// An ordered chain that runs once Git has created the worktree and before the output
// is rendered: the submodules, the copy of the untracked inputs, `copy_changes` (S18),
// the links of build caches and local asset directories, and the slot the setup chain
// takes. Every step reports `applied`, `skipped: <reason>` or `failed: <reason>`, and a
// failing step never aborts the chain or the creation: the worktree stays created and
// usable, and the summary names what failed.
//
// The chain reaches the world only through the injected seams — filesystem, Git and
// platform — so a test answers for a machine it invents and no case depends on the
// host's link privileges. No hook reads a file's contents: an input is copied by the
// filesystem and never decoded, so nothing secret can reach a log or a summary.
//
// The lists are fixed here and extend them from `<git-common-dir>/gentle-ai/worktree-hooks.json`,
// which is local to the clone and never versioned. That file extends the copy and link
// lists and enables setup for the repository; it carries no command, because a command
// read from a file must never run.

const { dirname, isAbsolute, join } = require('node:path');

const WORKTREE_HOOKS_FILENAME = 'worktree-hooks.json';

/** S20: the clone-local directory, inside the common directory Git never versions. */
const WORKTREE_LOCAL_DIRECTORY = 'gentle-ai';

/** S20: the clone-local file, inside the common directory Git never versions. */
function worktreeHooksFilePath(commonDir) {
	return join(commonDir, WORKTREE_LOCAL_DIRECTORY, WORKTREE_HOOKS_FILENAME);
}

/** S19: directories a package manager owns. No list can make one of these a link. */
const WORKTREE_NEVER_LINKED = [
	'node_modules',
	'vendor',
	'.venv',
	'target',
	'deps',
	'.pi/gentle-ai',
	'.gentle-ai',
];

/** S19: build caches, linked only when main has them untracked. */
const WORKTREE_BUILD_CACHE_LINKS = ['.turbo', '.next/cache', '.parcel-cache', '.pytest_cache', '.ruff_cache'];

/** S19: local asset directories, linked only when main has them untracked. */
const WORKTREE_ASSET_LINKS = ['.agents', '.atl', '.claude', 'odd'];

/** S19: the untracked input family copied by default. */
const WORKTREE_INPUT_PREFIX = '.env';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// ---- The local configuration (S20) ----

function emptyWorktreeHooksConfig() {
	return { copy: [], link: [], setup: false };
}

/** One relative path, so no configured entry can reach outside the worktree. */
function isSafeRelativePath(value) {
	if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER.test(value) || isAbsolute(value)) return false;
	const segments = value.replaceAll('\\', '/').split('/');
	return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function relativePath(value) {
	return value.replaceAll('\\', '/').replace(/\/+$/, '');
}

function unique(values) {
	return [...new Set(values)];
}

function configuredPaths(value) {
	if (!Array.isArray(value)) return [];
	const safe = value.filter((entry) => isSafeRelativePath(entry)).map((entry) => relativePath(entry));
	return unique(safe);
}

/**
 * S20: an absent or unreadable file keeps the defaults, because a bad local file must
 * never break a create. Only the two lists and the boolean flag are read: a key naming
 * a command reaches nothing, and neither does a `version` this code does not know.
 */
function parseWorktreeHooksConfig(text) {
	const config = emptyWorktreeHooksConfig();
	if (text === undefined) return config;
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return config;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return config;
	config.copy = configuredPaths(value.copy);
	config.link = configuredPaths(value.link);
	config.setup = value.setup === true;
	return config;
}

// ---- The seams ----
//
// Everything a hook may touch. Nothing else is importable from here, so a hook cannot
// open a file, spawn a process or read the environment on its own: `git` runs Git in
// `cwd` with the same shape the create flow already uses, `kind` answers from `lstat`
// what stands at a path, `readdir` lists a directory, `readText` reads the local S20
// file, `copyFile` is a byte copy, `mkdir` creates with parents, `symlink` creates one
// link of the given type and `platform` names the host.

// ---- The chain ----

/**
 * Runs the chain in order, one hook at a time, and never lets one stop the next. A hook
 * that throws is recorded as failed with its own name, because a chain that reported
 * nothing would read as a chain that did nothing.
 *
 * `input.mainRoot` is the canonical main worktree, which the main-relative steps (the
 * submodules, the inputs, the links) read. `input.changesRoot` is the checkout whose
 * uncommitted delta `copy_changes` copies — the one the caller stands in, which is not
 * necessarily main — and falls back to `mainRoot` only when a caller names none.
 */
async function runWorktreeHooks(input) {
	const config = parseWorktreeHooksConfig(await input.seams.readText(input.configPath));
	const context = {
		mainRoot: input.mainRoot,
		changesRoot: input.changesRoot ?? input.mainRoot,
		path: input.path,
		odd: input.odd,
		copyChanges: input.copyChanges === true,
		config,
	};
	const results = [];
	for (const hook of input.hooks ?? defaultWorktreeHooks()) {
		try {
			results.push(...(await hook.run(context, input.seams)));
		} catch (error) {
			results.push({ name: hook.name, status: 'failed', detail: reasonFor(error) });
		}
	}
	const summary = worktreeHooksSummary(results);
	return summary === undefined ? { results, config } : { results, config, summary };
}

/**
 * S19 in order, with `copy_changes` (S18) between the inputs and the links so the setup
 * chain installs against the copied manifests. Every caller runs this same list, so no
 * caller reorders it.
 */
function defaultWorktreeHooks() {
	return [submodulesHook, inputsHook, copyChangesHook, symlinksHook];
}

// ---- Shared Git questions ----

async function isTracked(seams, mainRoot, path) {
	const tracked = await seams.git(mainRoot, ['ls-files', '--error-unmatch', '--', path]);
	return tracked !== undefined && tracked.code === 0;
}

async function isIgnored(seams, mainRoot, path) {
	const ignored = await seams.git(mainRoot, ['check-ignore', '--quiet', '--', path]);
	return ignored !== undefined && ignored.code === 0;
}

/** S19: the rule a reader can add to silence this path, only while Git really does not ignore it. */
async function gitignoreWarning(context, seams, path) {
	if (await isIgnored(seams, context.mainRoot, path)) return undefined;
	return `${path} is not ignored; add ${path} to .gitignore`;
}

function isNeverLinked(path) {
	return WORKTREE_NEVER_LINKED.some((forbidden) => path === forbidden || path.startsWith(`${forbidden}/`));
}

function reasonFor(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---- S19 step 1: submodules ----

const submodulesHook = {
	name: 'submodules',
	async run(context, seams) {
		if ((await seams.kind(join(context.mainRoot, '.gitmodules'))) === undefined) {
			return [{ name: 'submodules', status: 'skipped', detail: 'no submodules' }];
		}
		const args = ['submodule', 'update', '--init', '--recursive'];
		const updated = await seams.git(context.path, args);
		if (updated === undefined || updated.code !== 0) {
			const outcome = updated === undefined ? 'without a result' : updated.code;
			return [{ name: 'submodules', status: 'failed', detail: `git ${args.join(' ')} exited ${outcome}` }];
		}
		return [{ name: 'submodules', status: 'applied' }];
	},
};

// ---- S19 step 2: the untracked inputs ----

const inputsHook = {
	name: 'inputs',
	async run(context, seams) {
		const present = (await seams.readdir(context.mainRoot)).filter((name) => name.startsWith(WORKTREE_INPUT_PREFIX));
		const candidates = unique([...present.sort(), ...context.config.copy]);
		if (candidates.length === 0) {
			return [{ name: 'inputs', status: 'skipped', detail: `no ${WORKTREE_INPUT_PREFIX} files in main` }];
		}
		const results = [];
		for (const path of candidates) results.push(await copyInput(context, seams, path));
		return results;
	},
};

/** Copies one input by bytes. A directory, a link and a path already in the worktree are refused. */
async function copyInput(context, seams, path) {
	const name = `copy ${path}`;
	if (!isSafeRelativePath(path)) return { name, status: 'skipped', detail: `${path} is not a relative path` };
	const source = join(context.mainRoot, path);
	const destination = join(context.path, path);
	const kind = await seams.kind(source);
	if (kind === undefined) return { name, status: 'skipped', detail: `${path} not in main` };
	if (await isTracked(seams, context.mainRoot, path)) return { name, status: 'skipped', detail: 'tracked' };
	if (kind !== 'file') return { name, status: 'skipped', detail: `${path} is not a file` };
	if ((await seams.kind(destination)) !== undefined) return { name, status: 'skipped', detail: `${path} already exists in the worktree` };
	try {
		await seams.mkdir(dirname(destination));
		await seams.copyFile(source, destination);
	} catch (error) {
		return { name, status: 'failed', detail: `could not copy ${path}: ${reasonFor(error)}` };
	}
	const warning = await gitignoreWarning(context, seams, path);
	return warning === undefined ? { name, status: 'applied' } : { name, status: 'applied', warning };
}

// ---- S18: the uncommitted changes ----
//
// The delta belongs to the checkout the create was asked from (`context.changesRoot`),
// never to the canonical main worktree: a session standing in another checkout copies
// its own line of work, exactly as the panel's path-selection transfer does. The patch
// is still applied in the new worktree, so the source keeps every change it had.

/**
 * The patch file Git writes for this step. It lives in the worktree's administrative
 * directory — never in the worktree, so a copied change is the only thing a reader sees
 * — and a fixed name makes it deterministic and overwritten instead of accumulating.
 */
const COPY_CHANGES_PATCH_FILENAME = 'gentle-ai-copy-changes.patch';

const copyChangesHook = {
	name: 'copy_changes',
	async run(context, seams) {
		// S18: omitted or false copies nothing and prints nothing, so the step neither
		// applies, skips nor fails — it never happened.
		if (!context.copyChanges) return [];
		const changed = await gitPaths(seams, context.changesRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
		const untracked = await gitPaths(seams, context.changesRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
		if (changed === undefined || untracked === undefined) {
			return [{ name: 'copy_changes', status: 'failed', detail: 'could not read the uncommitted changes' }];
		}
		if (changed.length === 0 && untracked.length === 0) {
			return [
				{
					name: 'copy_changes',
					status: 'skipped',
					detail: 'no uncommitted changes',
					copyChanges: { copied: 0, failed: [] },
				},
			];
		}
		const patchPath = await copyChangesPatchPath(context, seams);
		if (patchPath === undefined) {
			return [
				{
					name: 'copy_changes',
					status: 'failed',
					detail: "could not read the worktree's administrative directory",
					copyChanges: { copied: 0, failed: [...changed, ...untracked] },
				},
			];
		}

		let copied = 0;
		const failedTracked = [];
		const failedUntracked = [];
		for (const path of changed) {
			if (await applyChangedFile(context, seams, patchPath, path)) copied += 1;
			else failedTracked.push(path);
		}
		for (const path of untracked) {
			const outcome = await copyUntrackedFile(context, seams, path);
			if (outcome === 'copied') copied += 1;
			else if (outcome === 'failed') failedUntracked.push(path);
		}
		// S18: a conflicting patch leaves the worktree exactly as Git created it; the
		// failing paths are reported instead of aborting the creation.
		if (failedTracked.length > 0) await discardFailedChanges(context, seams, failedTracked);
		const failed = [...failedTracked, ...failedUntracked];
		if (failed.length > 0) {
			return [
				{
					name: 'copy_changes',
					status: 'failed',
					detail: `could not copy: ${failed.join(', ')}`,
					copyChanges: { copied, failed },
				},
			];
		}
		return [{ name: 'copy_changes', status: 'applied', copyChanges: { copied, failed: [] } }];
	},
};

/** One Git query whose answer is a NUL-separated path list, or nothing when it failed. */
async function gitPaths(seams, cwd, args) {
	const result = await seams.git(cwd, args);
	if (result === undefined || result.code !== 0) return undefined;
	return result.stdout.split('\0').filter((path) => path.length > 0);
}

/** Git writes the patch, so no hook ever handles its bytes or its encoding. */
async function copyChangesPatchPath(context, seams) {
	const gitDir = await seams.git(context.path, ['rev-parse', '--path-format=absolute', '--git-dir']);
	if (gitDir === undefined || gitDir.code !== 0) return undefined;
	const path = gitDir.stdout.trim();
	return path.length === 0 ? undefined : join(path, COPY_CHANGES_PATCH_FILENAME);
}

/** S18: one tracked path, patched from the asking checkout and applied with `--3way` in the worktree. */
async function applyChangedFile(context, seams, patchPath, path) {
	const patch = await seams.git(context.changesRoot, ['diff', '--binary', '--no-renames', `--output=${patchPath}`, 'HEAD', '--', path]);
	if (patch === undefined || patch.code !== 0) return false;
	const applied = await seams.git(context.path, ['apply', '--3way', patchPath]);
	return applied !== undefined && applied.code === 0;
}

/** A byte copy; a path another hook already carried over is left as that hook wrote it. */
async function copyUntrackedFile(context, seams, path) {
	if (!isSafeRelativePath(path)) return 'failed';
	const destination = join(context.path, path);
	if ((await seams.kind(destination)) !== undefined) return 'present';
	try {
		await seams.mkdir(dirname(destination));
		await seams.copyFile(join(context.changesRoot, path), destination);
		return 'copied';
	} catch {
		return 'failed';
	}
}

/**
 * S18: `--3way` implies `--index`, so a conflict leaves unmerged entries and conflict
 * markers behind. The index is reset to the worktree's own HEAD and the failing paths
 * are written back from it; both are plumbing over a checkout this hook never owned,
 * so the worktree is usable and clean again.
 */
async function discardFailedChanges(context, seams, failed) {
	await seams.git(context.path, ['read-tree', 'HEAD']);
	await seams.git(context.path, ['checkout-index', '-f', '--', ...failed]);
}

// ---- S19 step 4: the build caches and the local asset directories ----

const symlinksHook = {
	name: 'symlinks',
	async run(context, seams) {
		const results = [];
		const candidates = unique([...WORKTREE_BUILD_CACHE_LINKS, ...WORKTREE_ASSET_LINKS, ...context.config.link]);
		for (const path of candidates) results.push(await linkPath(context, seams, path));
		return results;
	},
};

/**
 * Links one directory from main. A refused link is retried as a junction, which Windows
 * grants without the developer mode, and a second refusal is reported: the failure is
 * never replaced by a copy that would silently duplicate a cache.
 */
async function linkPath(context, seams, path) {
	const name = `symlink ${path}`;
	if (!isSafeRelativePath(path)) return { name, status: 'skipped', detail: `${path} is not a relative path` };
	const relative = relativePath(path);
	if (isNeverLinked(relative)) return { name, status: 'skipped', detail: `${relative} is never linked` };
	const target = join(context.mainRoot, relative);
	if ((await seams.kind(target)) === undefined) return { name, status: 'skipped', detail: `${relative} not in main` };
	if (await isTracked(seams, context.mainRoot, relative)) return { name, status: 'skipped', detail: 'tracked' };
	const link = join(context.path, relative);
	if ((await seams.kind(link)) !== undefined) return { name, status: 'skipped', detail: `${relative} already exists in the worktree` };

	const attempts = seams.platform === 'win32' ? ['junction', 'dir'] : ['dir', 'junction'];
	let firstFailure;
	for (const type of attempts) {
		try {
			await seams.mkdir(dirname(link));
			await seams.symlink(target, link, type);
			const warning = await gitignoreWarning(context, seams, relative);
			const applied = { name, status: 'applied' };
			if (type === 'junction') applied.detail = 'junction';
			if (warning !== undefined) applied.warning = warning;
			return applied;
		} catch (error) {
			if (firstFailure === undefined) firstFailure = reasonFor(error);
		}
	}
	return { name, status: 'failed', detail: `could not link ${relative}: ${firstFailure ?? 'no link type was attempted'}` };
}

// ---- S16 and S7: what the output prints and the record stores ----

/**
 * S16: the one `hooks:` line. It summarises the counts, names everything that failed and
 * carries the `.gitignore` advice, and it is absent when nothing applied and nothing
 * failed, because an empty line would claim a chain that never ran.
 */
function worktreeHooksSummary(results) {
	const applied = results.filter((result) => result.status === 'applied').length;
	const skipped = results.filter((result) => result.status === 'skipped').length;
	const failed = results.filter((result) => result.status === 'failed');
	if (applied === 0 && failed.length === 0) return undefined;
	const parts = [];
	if (applied > 0) parts.push(`${applied} applied`);
	if (skipped > 0) parts.push(`${skipped} skipped`);
	if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.map((result) => `${result.name} (${result.detail ?? 'no reason'})`).join(', ')}`);
	const warnings = results.map((result) => result.warning).filter((warning) => warning !== undefined);
	if (warnings.length > 0) parts.push(`warning: ${warnings.join('; ')}`);
	return `hooks: ${parts.join(', ')}`;
}

/** S18: the one dedicated line, present only when the request passed copy_changes. */
function worktreeCopyChangesLine(results) {
	const result = results.find((entry) => entry.name === 'copy_changes');
	if (result === undefined) return undefined;
	const outcome = result.copyChanges;
	if (outcome === undefined) return `copy_changes: ${result.detail ?? 'could not copy the uncommitted changes'}`;
	if (outcome.failed.length > 0) {
		return `copy_changes: ${outcome.copied} changes copied; failed: ${outcome.failed.join(', ')}`;
	}
	if (outcome.copied === 0) return 'copy_changes: no uncommitted changes to copy';
	return `copy_changes: ${outcome.copied} changes copied`;
}

/** S7: the outcome as the record stores it, with the advice folded into its detail. */
function worktreeHookRecords(results) {
	return results.map((result) => {
		const detail = [result.detail, result.warning].filter((part) => part !== undefined).join('; ');
		return detail.length === 0 ? { name: result.name, status: result.status } : { name: result.name, status: result.status, detail };
	});
}

module.exports = {
	WORKTREE_HOOKS_FILENAME,
	worktreeHooksFilePath,
	WORKTREE_NEVER_LINKED,
	WORKTREE_BUILD_CACHE_LINKS,
	WORKTREE_ASSET_LINKS,
	WORKTREE_INPUT_PREFIX,
	emptyWorktreeHooksConfig,
	parseWorktreeHooksConfig,
	runWorktreeHooks,
	defaultWorktreeHooks,
	submodulesHook,
	inputsHook,
	copyChangesHook,
	symlinksHook,
	worktreeHooksSummary,
	worktreeCopyChangesLine,
	worktreeHookRecords,
};

'use strict';
// The core of `worktree_create`.
//
// Git owns the mechanics — the base ref, the branch, the administrative directory and
// the checkout — and this module owns the decisions that must be right before anything
// lands on disk: where the worktree goes, which branch it takes and which ref it starts
// from, each refused with the exact sentence the agent reads. Every Git call passes an
// argument array, so no value is ever interpolated into a shell.
//
// The preparation hooks live in `worktree-hooks.js` (T5): they run once the worktree
// exists, and the create prints their dedicated `copy_changes` line (S18). Nothing is
// stored about them (S1): the checkout's directory is the only record, so a hook
// outcome is reported once, in the create's answer, and never persisted.
//
// `copy_changes` arrives as a further hook and the setup chain (T7) starts after it,
// so nothing here is written around them.

const { basename, dirname, isAbsolute, join } = require('node:path');
const { parseWorktreePorcelain } = require('./worktree-registry.js');
const { worktreeCopyChangesLine } = require('./worktree-hooks.js');

/** S27: the sentence a session outside a Git worktree gets, shared with the tool and its tests. */
const WORKTREE_NOT_A_REPOSITORY = 'not inside a Git worktree, so there is no repository to create a worktree from';

/** S5: what a single path segment may say, printed under every refusal. */
const WORKTREE_SEGMENT_HINT = 'odd must be a single path segment (letters, digits, dash, underscore, dot)';

const BASE_RESOLUTION_FAILURE = 'could not resolve a base branch: tried main, origin/HEAD, init.defaultBranch';
const SHORT_SHA_LENGTH = 7;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// ---- S1 and S5: the name and the destination ----

/** S5: one segment, so no value can escape the directory it names. */
function isWorktreeSegment(value) {
	return typeof value === 'string'
		&& value.length > 0
		// A segment of nothing but whitespace is not a name, and the store refuses it
		// too (S4: the ODD field is optional, its type is not), so it is refused here
		// instead of creating a worktree whose record can never be written.
		&& value.trim().length > 0
		&& !CONTROL_CHARACTER.test(value)
		&& !value.includes('/')
		&& !value.includes('\\')
		&& !value.includes('..')
		&& !isAbsolute(value);
}

/** S5/S7: the one sentence an unusable or absent `odd` prints, shared with the panel. */
function oddRefusal(value) {
	if (isWorktreeSegment(value)) return undefined;
	return { code: 'invalid-odd', message: `invalid odd name: ${JSON.stringify(value)}\n${WORKTREE_SEGMENT_HINT}` };
}

/**
 * S7: `<repo-parent>/<repo-name>-worktrees/<odd>`, derived from the canonical main root.
 * The directory IS the ODD, so the branch never names a checkout and two worktrees for
 * one ODD cannot coexist.
 */
function worktreeDestinationPath(mainRoot, odd) {
	return join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`, odd);
}

// ---- S2 and S3: what Git answers ----

async function readGitText(git, cwd, args) {
	const result = await git(cwd, args);
	if (!result || result.code !== 0) return undefined;
	const text = result.stdout.trim();
	return text.length > 0 ? text : undefined;
}

/**
 * S2 in order: a local `main`, then the default branch `origin/HEAD` names, then
 * `init.defaultBranch`. A candidate whose ref does not resolve cannot supply the commit
 * the worktree starts from, so it is passed over.
 */
async function resolveWorktreeBase(git, cwd) {
	const candidates = [{ branch: 'main', startRef: 'refs/heads/main' }];
	const originHead = await readGitText(git, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
	const remoteBranch = originHead?.replace(/^origin\//, '');
	if (remoteBranch) candidates.push({ branch: remoteBranch, startRef: `refs/remotes/origin/${remoteBranch}` });
	const configured = await readGitText(git, cwd, ['config', '--get', 'init.defaultBranch']);
	if (configured) candidates.push({ branch: configured, startRef: `refs/heads/${configured}` });
	for (const candidate of candidates) {
		const sha = await readGitText(git, cwd, ['rev-parse', '--verify', '--quiet', candidate.startRef]);
		if (sha) return { branch: candidate.branch, startRef: candidate.startRef, sha };
	}
	return undefined;
}

/** S3: the worktree path Git reports for a branch, when one already holds it. */
async function findBranchHolder(git, cwd, branch) {
	const listing = await git(cwd, ['worktree', 'list', '--porcelain']);
	if (!listing || listing.code !== 0) return undefined;
	return parseWorktreePorcelain(listing.stdout).find((entry) => entry.branch === branch)?.path;
}

// ---- Planning ----

/**
 * Validates the request against the clone and returns either the plan to run or the
 * exact refusal. Input validation comes first and touches neither Git nor the
 * filesystem (S5); after that every question is read-only, so a refusal leaves the
 * clone exactly as it was found.
 */
async function planWorktreeCreate(request, repository, seams) {
	// S7: the ODD names the directory, so it is REQUIRED — an absent one is refused
	// with the same sentence an unusable one gets, before Git or the filesystem.
	const refused = oddRefusal(request.odd);
	if (refused) return { ok: false, error: refused };

	const base = await resolveWorktreeBase(seams.git, repository.mainRoot);
	if (!base) return { ok: false, error: { code: 'no-base-branch', message: BASE_RESOLUTION_FAILURE } };
	if (request.branch === base.branch) {
		return {
			ok: false,
			error: {
				code: 'base-branch-is-target',
				message: `branch ${request.branch} is the base branch; pick the branch this worktree should work on`,
			},
		};
	}

	const path = worktreeDestinationPath(repository.mainRoot, request.odd);
	if (seams.exists(path)) {
		return {
			ok: false,
			error: { code: 'path-exists', message: `worktree path already exists: ${path}\nRemove it or pass a different odd.` },
		};
	}

	const holder = await findBranchHolder(seams.git, repository.mainRoot, request.branch);
	if (holder !== undefined) {
		return {
			ok: false,
			error: {
				code: 'branch-in-use',
				message: `branch ${request.branch} is already checked out in ${holder}\nUse a different branch, or work in that worktree.`,
			},
		};
	}

	const branchRef = `refs/heads/${request.branch}`;
	const existing = (await readGitText(seams.git, repository.mainRoot, ['rev-parse', '--verify', '--quiet', branchRef])) !== undefined;
	// A plain branch name is what makes `worktree add` check the branch out; a fully
	// qualified ref would detach the new worktree's HEAD.
	const args = existing
		? ['worktree', 'add', path, request.branch]
		: ['worktree', 'add', '-b', request.branch, path, base.startRef];
	return {
		ok: true,
		plan: {
			mainRoot: repository.mainRoot,
			path,
			odd: request.odd,
			branch: request.branch,
			branchState: existing ? 'existing' : 'created',
			base: base.branch,
			startRef: base.startRef,
			baseSha: base.sha,
			shortSha: base.sha.slice(0, SHORT_SHA_LENGTH),
			copyChanges: request.copy_changes === true,
			args,
		},
	};
}

// ---- Executing the plan ----

/**
 * Runs the planned create. `git worktree add` is the whole effect: nothing is recorded
 * afterwards, because the destination directory IS the record (S3). A Git failure is
 * the caller's sentence and leaves the clone as it was.
 */
async function executeWorktreeCreatePlan(input) {
	const added = await input.git(input.plan.mainRoot, input.plan.args);
	if (!added || added.code !== 0) {
		return {
			ok: false,
			error: {
				code: 'git-failed',
				message: `could not create the worktree at ${input.plan.path}: git worktree add exited ${added === undefined ? 'without a result' : added.code}`,
			},
		};
	}
	return { ok: true, result: {} };
}

// ---- S16: the agent-facing output ----

/**
 * S16: the fixed lines of a successful create, in order, with no padding and no ANSI.
 *
 * S1: the hooks part and the setup part are gone — at call time this answer knows
 * neither which hooks were skipped nor how the background chain went, so printing
 * either would state a guess. The dedicated `copy_changes` line stays: it reports the
 * copy this very call performed.
 */
function worktreeCreateView(result) {
	const { plan } = result;
	const lines = [
		`worktree created: ${plan.path}`,
		`branch: ${plan.branch} (${plan.branchState})`,
		// The ODD is the directory's name, so the create names it once, here.
		`odd: ${plan.odd}`,
		`base: ${plan.base}@${plan.shortSha}`,
		result.registered ? 'worktree register in session' : 'worktree register failed',
	];
	// S18: its own line, only when the parameter was passed.
	const copyChanges = result.hooks?.find((hook) => hook.name === 'copy_changes')?.copyChanges;
	const copyChangesLine = result.hooks === undefined ? undefined : worktreeCopyChangesLine(result.hooks);
	if (copyChangesLine !== undefined) lines.push(copyChangesLine);
	const details = {
		path: plan.path,
		// The name IS the directory's basename, which is the ODD.
		name: basename(plan.path),
		branch: plan.branch,
		branchState: plan.branchState,
		base: plan.base,
		baseSha: plan.baseSha,
		odd: plan.odd,
		registered: result.registered,
	};
	if (copyChanges !== undefined) details.copyChanges = { copied: copyChanges.copied, failed: [...copyChanges.failed] };
	return { text: lines.join('\n'), details };
}

module.exports = {
	WORKTREE_NOT_A_REPOSITORY,
	WORKTREE_SEGMENT_HINT,
	isWorktreeSegment,
	worktreeDestinationPath,
	planWorktreeCreate,
	executeWorktreeCreatePlan,
	worktreeCreateView,
};

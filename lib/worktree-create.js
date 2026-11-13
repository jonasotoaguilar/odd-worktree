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
// exists, and this module stores what they did in the record (S7) and prints their one
// summary line (S16) plus the dedicated `copy_changes` line (S18). `copy_changes`
// arrives as a further hook, and the setup chain (T7) after it, so nothing here is
// written around them.

const { basename, dirname, isAbsolute, join } = require('node:path');
const {
	createWorktreeMetadataRecord,
	parseWorktreeListPorcelain,
	readWorktreeMetadataStore,
	saveWorktreeMetadataRecords,
} = require('./worktree-metadata.js');
const { worktreeCopyChangesLine, worktreeHooksSummary } = require('./worktree-hooks.js');
const { worktreeCreateSetupLine } = require('./worktree-setup.js');

/** S27: the sentence a session outside a Git worktree gets, shared with the tool and its tests. */
const WORKTREE_NOT_A_REPOSITORY = 'not inside a Git worktree, so there is no repository to create a worktree from';

/** S5: what a single path segment may say, printed under every refusal. */
const WORKTREE_SEGMENT_HINT = 'odd must be a single path segment (letters, digits, dash, underscore, dot)';

/** S5: `name` shares the rule but not the wording, so its refusal names `name`. */
const WORKTREE_NAME_SEGMENT_HINT = 'name must be a single path segment (letters, digits, dash, underscore, dot)';

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

function segmentRefusal(label, value) {
	if (isWorktreeSegment(value)) return undefined;
	return {
		code: label === 'odd' ? 'invalid-odd' : 'invalid-name',
		message: `invalid ${label === 'odd' ? 'odd name' : 'name'}: ${JSON.stringify(value)}\n${label === 'odd' ? WORKTREE_SEGMENT_HINT : WORKTREE_NAME_SEGMENT_HINT}`,
	};
}

/**
 * S1: a branch with a `/` drops its first segment and turns every remaining separator
 * into a dash, so `feat/worktree-tools` names the directory `worktree-tools` and
 * `feat/a/b` names it `a-b`; a branch with no `/` names the directory itself, so
 * `dev-abyss` names it `dev-abyss`.
 */
function defaultWorktreeName(branch) {
	const separator = branch.indexOf('/');
	if (separator === -1) return branch;
	return branch.slice(separator + 1).replaceAll('/', '-');
}

/** S1: `<repo-parent>/<repo-name>-worktrees/<name>`, derived from the canonical main root. */
function worktreeDestinationPath(mainRoot, name) {
	return join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`, name);
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
	return parseWorktreeListPorcelain(listing.stdout).find((entry) => entry.branch === branch)?.path;
}

// ---- Planning ----

/**
 * Validates the request against the clone and returns either the plan to run or the
 * exact refusal. Input validation comes first and touches neither Git nor the
 * filesystem (S5); after that every question is read-only, so a refusal leaves the
 * clone exactly as it was found.
 */
async function planWorktreeCreate(request, repository, seams) {
	// S4: an omitted `odd` is not a request to validate anything — the plan carries
	// `null`, the record stores it as absent and the create prints `odd: -` — while a
	// value that IS present must still be one safe path segment.
	const oddRefusal = request.odd === undefined ? undefined : segmentRefusal('odd', request.odd);
	if (oddRefusal) return { ok: false, error: oddRefusal };
	if (request.name !== undefined) {
		const explicitRefusal = segmentRefusal('name', request.name);
		if (explicitRefusal) return { ok: false, error: explicitRefusal };
	}

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

	// The derived name is only known once the branch is known, so it is refused after
	// the base check: `branch: main` must report the base, not the name that branch derives.
	const name = request.name ?? defaultWorktreeName(request.branch);
	if (request.name === undefined) {
		const derivedRefusal = segmentRefusal('name', name);
		if (derivedRefusal) return { ok: false, error: derivedRefusal };
	}

	const path = worktreeDestinationPath(repository.mainRoot, name);
	if (seams.exists(path)) {
		return {
			ok: false,
			error: { code: 'path-exists', message: `worktree path already exists: ${path}\nRemove it or pass a different name.` },
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
			name,
			odd: request.odd ?? null,
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
 * `adminId` is the basename of the worktree's own administrative directory, read with
 * the same `rev-parse --path-format=absolute --git-dir` query the reconciliation seam
 * asks. It is awaited rather than taken from that seam because `git worktree add`
 * checks out a whole tree and no Git call here may block a frame.
 */
async function readWorktreeAdminId(git, path) {
	const adminDir = await readGitText(git, path, ['rev-parse', '--path-format=absolute', '--git-dir']);
	return adminDir === undefined ? undefined : basename(adminDir);
}

/**
 * Runs the planned create and persists the S7 record. A store that refuses the write
 * never rolls the worktree back: the caller reports the worktree it has and why the
 * metadata is missing, so a human decides what happens next.
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

	const adminId = await readWorktreeAdminId(input.git, input.plan.path);
	if (adminId === undefined) {
		return {
			ok: true,
			result: { metadata: { recorded: false, reason: "could not read the worktree's administrative directory" } },
		};
	}

	const record = createWorktreeMetadataRecord(
		{
			// S4: an omitted ODD is `null` in the plan and ABSENT from the record — the key
			// is never written as null, `''` or `'-'`.
			odd: input.plan.odd ?? undefined,
			createdBy: input.createdBy,
			adminId,
			branchAtCreation: input.plan.branch,
			baseRef: `${input.plan.base}@${input.plan.shortSha}`,
		},
		input.now ?? new Date(),
	);
	try {
		saveWorktreeMetadataRecords(input.storePath, { [input.plan.path]: record });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: true, result: { adminId, metadata: { recorded: false, reason } } };
	}
	return { ok: true, result: { adminId, metadata: { recorded: true } } };
}

/**
 * S7: what the preparation hooks did, merged into the record the create already stored.
 * A store that cannot be read or holds no record for this worktree is reported instead
 * of invented: the record is the only place the outcomes belong.
 */
function recordWorktreeHooks(input) {
	const store = readWorktreeMetadataStore(input.storePath);
	if (store.status !== 'valid') return { recorded: false, reason: 'no readable metadata store for this clone' };
	const record = store.file.records[input.path];
	if (record === undefined) return { recorded: false, reason: 'no metadata record for this worktree' };
	try {
		saveWorktreeMetadataRecords(input.storePath, { [input.path]: { ...record, hooks: [...input.hooks] } });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { recorded: false, reason };
	}
	return { recorded: true };
}

// ---- S16: the agent-facing output ----

/** S16: the fixed lines of a successful create, in order, with no padding and no ANSI. */
function worktreeCreateView(result) {
	const { plan } = result;
	const lines = [
		`worktree created: ${plan.path}`,
		`branch: ${plan.branch} (${plan.branchState})`,
		// S4: an omitted ODD prints the same `-` the list prints, so the fixed line
		// order never changes shape between a create with an ODD and one without.
		`odd: ${plan.odd ?? '-'}`,
		`base: ${plan.base}@${plan.shortSha}`,
		result.registered ? 'worktree register in session' : 'worktree register failed',
	];
	// S16: one line, right after the registration, and only when it has something to say.
	const hooksSummary = result.hooks === undefined ? undefined : worktreeHooksSummary(result.hooks);
	if (hooksSummary !== undefined) lines.push(hooksSummary);
	// S16: the setup line follows the hooks summary; a caller that holds no setup state
	// prints no line, so an unread chain never reads as a skipped one.
	if (result.setup !== undefined) lines.push(worktreeCreateSetupLine(result.setup));
	// S18: its own line, only when the parameter was passed, right after the summary of
	// the chain it belongs to.
	const copyChanges = result.hooks?.find((hook) => hook.name === 'copy_changes')?.copyChanges;
	const copyChangesLine = result.hooks === undefined ? undefined : worktreeCopyChangesLine(result.hooks);
	if (copyChangesLine !== undefined) lines.push(copyChangesLine);
	const metadataLines = result.metadata.recorded === false
		? [`metadata: not recorded (${result.metadata.reason})`]
		: [];
	lines.push(...metadataLines);
	const details = {
		path: plan.path,
		name: plan.name,
		branch: plan.branch,
		branchState: plan.branchState,
		base: plan.base,
		baseSha: plan.baseSha,
		odd: plan.odd,
		registered: result.registered,
		metadataRecorded: result.metadata.recorded,
	};
	if (result.adminId !== undefined) details.adminId = result.adminId;
	// The text and `details` agree: a chain that reported nothing worth printing carries
	// no outcomes either, so a reader never sees two shapes of the same fact.
	if (hooksSummary !== undefined && result.hooks !== undefined) details.hooks = [...result.hooks];
	if (copyChanges !== undefined) details.copyChanges = { copied: copyChanges.copied, failed: [...copyChanges.failed] };
	if (result.setup !== undefined) details.setup = { ...result.setup, steps: result.setup.steps.map((step) => ({ ...step })) };
	return { text: lines.join('\n'), details };
}

module.exports = {
	WORKTREE_NOT_A_REPOSITORY,
	WORKTREE_SEGMENT_HINT,
	WORKTREE_NAME_SEGMENT_HINT,
	defaultWorktreeName,
	worktreeDestinationPath,
	planWorktreeCreate,
	executeWorktreeCreatePlan,
	recordWorktreeHooks,
	worktreeCreateView,
};

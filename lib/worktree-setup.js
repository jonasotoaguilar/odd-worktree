'use strict';
// The asynchronous setup chain of `worktree_create` (S20 to S26).
//
// A lockfile at the worktree root selects one entry of a closed command table (S21), and
// that entry's steps run as jobs in the session's own background job registry (S22), so
// they appear in the existing jobs views and count against the existing limit. The tool
// returns before a step settles; the record carries the state before each step starts
// (S23), and exactly one notification follows the last settlement (S24).
//
// Nothing here reads a repository file's contents or takes a command from one: the table
// below and the local `setup` flag are the only sources of a command string (S20, S22).
// The chain reaches the world through two injected seams — the lockfile and PATH probe
// and the job registry — so a test answers for a machine it invents and no case runs a
// package manager.

const {
	WORKTREE_SETUP_STATE_DISPLAY,
	WORKTREE_STATE_LABELS,
	currentWorktreeSetupStep,
	readWorktreeMetadataStore,
	saveWorktreeMetadataRecords,
} = require('./worktree-metadata.js');

/**
 * S22: the channel the parent session's job registry is published on. The shell reads one
 * announcement per session, so a setup step is submitted to the same instance the
 * `bash_background` tool uses instead of a second registry.
 */
const WORKTREE_SETUP_REGISTRY_CHANNEL = 'gentle-ai:worktree-setup-registry';

/** S22: every step job carries this label, so the jobs views and S24 can recognise it. */
const WORKTREE_SETUP_JOB_LABEL_PREFIX = 'worktree setup · ';

/** S24: the custom message type of the one setup notification. */
const WORKTREE_SETUP_NOTICE_TYPE = 'gentle-worktree.setup';

/** S20: the create prints this skip when the clone's local configuration does not enable setup. */
const WORKTREE_SETUP_DISABLED_DETAIL = 'setup is not enabled for this repository';

/** S25: the reason a refused start persists, rendered by the `pending` state. */
const WORKTREE_SETUP_JOB_LIMIT_DETAIL = 'job limit reached';

/** Reported when no registry announced itself for the session, so no job could be started. */
const WORKTREE_SETUP_NO_REGISTRY_DETAIL = 'no background job registry in this session';

function worktreeSetupJobLabel(name) {
	return `${WORKTREE_SETUP_JOB_LABEL_PREFIX}${name}`;
}

/**
 * S22/S24: true only for a job this chain submitted. A `bash_background` or `monitor`
 * label never matches, so their exit notice is untouched.
 */
function isWorktreeSetupJobLabel(label) {
	return label.startsWith(WORKTREE_SETUP_JOB_LABEL_PREFIX);
}

// ---- The registry announcement (S22) ----
//
// A step's request is the registry's own shape reduced to `command`, `cwd`,
// `ownerSessionId` and `label`; its answer is the job's identity and the one log file
// it writes. That is all the chain is allowed to see of the session's registry.

/** Guards the published value, so a malformed event never becomes a second registry. */
function isWorktreeSetupRegistryAnnouncement(value) {
	if (typeof value !== 'object' || value === null) return false;
	const announcement = value;
	if (typeof announcement.sessionId !== 'string' || announcement.sessionId.length === 0) return false;
	if (typeof announcement.registry !== 'object' || announcement.registry === null) return false;
	return typeof announcement.registry.start === 'function';
}

/**
 * S25: the registry refuses a start when its running limit is reached, and that refusal is
 * the one reason that leaves a chain `pending` instead of failed. The registry owns the
 * message, so it is matched here rather than duplicated into a second limit constant.
 */
const JOB_LIMIT_REFUSAL = /background jobs are already running/;

function isWorktreeSetupJobLimit(error) {
	return error instanceof Error && JOB_LIMIT_REFUSAL.test(error.message);
}

// ---- S21: the closed command table ----

/** S21: `.venv` keeps pip from touching the machine's interpreter, and its layout is platform-specific. */
function venvPython(platform) {
	return platform === 'win32' ? '.venv/Scripts/python' : '.venv/bin/python';
}

/**
 * S21: one entry of the closed table. `lockfiles` are the exact names at the worktree
 * root and `suffixes` are the .NET solution and project files; the first matching entry
 * wins, so a repository that carries two lockfiles gets the earlier one and never a
 * merge of both. `binaries` are the commands the steps run, and the first missing one
 * skips the chain. No entry is reachable from a repository file.
 */
const WORKTREE_SETUP_RULES = [
	{ lockfiles: ['pnpm-lock.yaml'], binaries: ['pnpm'], steps: () => ['pnpm install'] },
	{
		lockfiles: ['yarn.lock'],
		binaries: ['yarn'],
		steps: ({ copiedChanges }) => [copiedChanges === 0 ? 'yarn install --immutable' : 'yarn install'],
	},
	{
		lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
		binaries: ['npm'],
		steps: ({ copiedChanges }) => [copiedChanges === 0 ? 'npm ci' : 'npm install'],
	},
	{ lockfiles: ['bun.lock', 'bun.lockb'], binaries: ['bun'], steps: () => ['bun install --frozen-lockfile'] },
	{ lockfiles: ['Cargo.toml'], binaries: ['cargo'], steps: () => ['cargo fetch'] },
	{ lockfiles: ['go.mod'], binaries: ['go'], steps: () => ['go mod download'] },
	{ lockfiles: ['uv.lock'], binaries: ['uv'], steps: () => ['uv sync'] },
	{ lockfiles: ['poetry.lock'], binaries: ['poetry'], steps: () => ['poetry install'] },
	{ lockfiles: ['Pipfile.lock'], binaries: ['pipenv'], steps: () => ['pipenv install'] },
	{
		lockfiles: ['requirements.txt'],
		binaries: ['python3'],
		steps: ({ platform }) => ['python3 -m venv .venv', `${venvPython(platform)} -m pip install -r requirements.txt`],
	},
	{ lockfiles: ['Gemfile.lock'], binaries: ['bundle'], steps: () => ['bundle install'] },
	{ lockfiles: ['composer.lock'], binaries: ['composer'], steps: () => ['composer install'] },
	{ lockfiles: ['mix.lock'], binaries: ['mix'], steps: () => ['mix deps.get'] },
	{ lockfiles: ['pubspec.lock'], binaries: ['flutter'], steps: () => ['flutter pub get'] },
	{
		lockfiles: [],
		suffixes: ['.sln', '.csproj', '.fsproj', '.vbproj'],
		binaries: ['dotnet'],
		steps: () => ['dotnet restore'],
	},
];

/** The entry this root selects, or nothing when no lockfile or project file matched. */
function worktreeSetupRuleFor(entries) {
	for (const rule of WORKTREE_SETUP_RULES) {
		if (rule.lockfiles.some((name) => entries.includes(name))) return rule;
		const suffixes = rule.suffixes ?? [];
		if (suffixes.some((suffix) => entries.some((name) => name.toLowerCase().endsWith(suffix)))) return rule;
	}
	return undefined;
}

// ---- S21: resolving one plan ----

/**
 * S21: the first matching entry, its binary checked, or the reason it cannot run. A missing
 * binary stops here instead of trying the next entry, because a lockfile from one package
 * manager installed by another is not the project's setup. The filesystem seam answers what
 * the root holds and whether a command resolves on the PATH.
 */
async function resolveWorktreeSetupPlan(input) {
	const entries = await input.seam.entries(input.root);
	const rule = worktreeSetupRuleFor(entries);
	if (rule === undefined) return { steps: [], detail: 'no lockfile at root' };
	for (const binary of rule.binaries) {
		if (!(await input.seam.hasBinary(binary))) return { steps: [], detail: `${binary} not found` };
	}
	return {
		steps: rule.steps({
			copiedChanges: Math.max(0, input.copiedChanges),
			platform: input.platform ?? process.platform,
		}),
	};
}

// ---- S16 and S11: what the create prints ----

/** S21/S25: a chain that never ran, with the reason the reader sees. */
function skippedWorktreeSetup(detail) {
	return { status: 'skipped', steps: [], detail };
}

/**
 * S16: one summary per persisted state, in the same vocabulary the list prints, with the
 * reason S21 and S25 name inside the parentheses.
 */
function worktreeSetupSummary(setup) {
	if (setup.status === 'running') {
		// The step speaks for the chain; a record whose steps were lost still names its command.
		const command = currentWorktreeSetupStep(setup)?.command ?? setup.command;
		return command === undefined ? WORKTREE_STATE_LABELS.running : `${WORKTREE_STATE_LABELS.running} (${command})`;
	}
	if (setup.status === 'pending' || setup.status === 'skipped') {
		const label = WORKTREE_STATE_LABELS[WORKTREE_SETUP_STATE_DISPLAY[setup.status]];
		return setup.detail === undefined || setup.detail.length === 0 ? label : `${label} (${setup.detail})`;
	}
	return WORKTREE_STATE_LABELS[WORKTREE_SETUP_STATE_DISPLAY[setup.status]];
}

/** S16: the create's one line, with the not-ready advice unless the chain is ready. */
function worktreeCreateSetupLine(setup) {
	const advice = setup.status === 'ready' ? '' : ' · worktree is not ready yet';
	return `setup: ${worktreeSetupSummary(setup)}${advice}`;
}

// ---- S24: the two sentences ----

/** The job duration as the notices spell it: seconds, then minutes, then hours. */
function formatJobDuration(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function worktreeSetupReadyText(input) {
	const steps = `${input.steps} step${input.steps === 1 ? '' : 's'}`;
	return `worktree setup ready · ${input.name} · ${steps} (${formatJobDuration(input.durationMs)})`;
}

function worktreeSetupFailureText(input) {
	return [
		`worktree setup failed · ${input.name} · ${input.command} exited ${input.exitCode}`,
		`log: ${input.logPath}`,
		'worktree is not ready yet; re-run setup or inspect the log.',
	].join('\n');
}

// ---- S23/S24/S25/S26: the chain ----

function copySteps(steps) {
	return steps.map((step) => ({ ...step }));
}

/**
 * S22: the chain is a state machine over the registry's own settlements, because the
 * create returns before the first step ends. Every state it reports is the one it
 * persisted, so the caller never prints a state the record does not hold.
 */
function createWorktreeSetupChain(input) {
	const startedAt = input.now().getTime();
	const steps = [];
	let setup = { status: 'pending', steps: [] };
	let inFlight;

	const write = (next) => {
		// The reported state and the stored state are separate objects, so a later step can
		// never reach back into a state already handed to the caller.
		setup = { ...next, steps: copySteps(next.steps) };
		input.persist({ ...setup, steps: copySteps(setup.steps) });
		return setup;
	};

	const begin = (index) => {
		const command = input.commands[index];
		const step = { command, status: 'running', startedAt: input.now().toISOString() };
		steps.push(step);
		// S23: the record says running before the job exists, so a session that dies here
		// reconciles to `interrupted` instead of a state that claims work still in flight.
		write({ status: 'running', steps, command });
		let job;
		try {
			job = input.jobs.start({
				command,
				cwd: input.path,
				ownerSessionId: input.sessionId,
				label: worktreeSetupJobLabel(input.name),
			});
		} catch (error) {
			if (isWorktreeSetupJobLimit(error)) {
				step.status = 'pending';
				write({ status: 'pending', steps, command, detail: WORKTREE_SETUP_JOB_LIMIT_DETAIL });
				return { setup, limited: true };
			}
			const endedAt = input.now().toISOString();
			step.status = 'failed';
			step.endedAt = endedAt;
			const reason = error instanceof Error ? error.message : String(error);
			write({ status: 'failed', steps, command, endedAt, detail: `could not start ${command}: ${reason}` });
			return { setup };
		}
		inFlight = job.id;
		step.logPath = job.outputPath;
		write({ status: 'running', steps, command, jobId: job.id, logPath: job.outputPath });
		return { setup, jobId: job.id };
	};

	return {
		start: () => begin(0),
		settle: (jobId, exitCode, endedAt) => {
			if (inFlight === undefined || jobId !== inFlight) return undefined;
			inFlight = undefined;
			const index = steps.findIndex((step) => step.status === 'running');
			const step = steps[index];
			const ended = (endedAt ?? input.now()).toISOString();
			step.status = exitCode === 0 ? 'ready' : 'failed';
			step.exitCode = exitCode;
			step.endedAt = ended;
			if (exitCode !== 0) {
				write({
					status: 'failed',
					steps,
					command: step.command,
					logPath: step.logPath ?? '',
					exitCode,
					endedAt: ended,
				});
				input.notify(
					worktreeSetupFailureText({
						name: input.name,
						command: step.command,
						exitCode,
						logPath: step.logPath ?? '',
					}),
				);
				return { setup };
			}
			if (index + 1 < input.commands.length) return begin(index + 1);
			const last = steps.at(-1);
			write({
				status: 'ready',
				steps,
				command: last.command,
				logPath: last.logPath ?? '',
				exitCode: 0,
				endedAt: ended,
			});
			input.notify(
				worktreeSetupReadyText({
					name: input.name,
					steps: steps.length,
					durationMs: (endedAt ?? input.now()).getTime() - startedAt,
				}),
			);
			return { setup };
		},
	};
}

// ---- S23: the record write ----

/**
 * S23: the setup state, merged into the record the create already stored. A store that
 * cannot be read or holds no record for this worktree is reported instead of invented,
 * exactly like the hook outcomes; nothing is ever created or deleted here.
 */
function recordWorktreeSetup(input) {
	const store = readWorktreeMetadataStore(input.storePath);
	if (store.status !== 'valid') return { recorded: false, reason: 'no readable metadata store for this clone' };
	const record = store.file.records[input.path];
	if (record === undefined) return { recorded: false, reason: 'no metadata record for this worktree' };
	try {
		saveWorktreeMetadataRecords(input.storePath, { [input.path]: { ...record, setup: input.setup } });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { recorded: false, reason };
	}
	return { recorded: true };
}

module.exports = {
	WORKTREE_SETUP_REGISTRY_CHANNEL,
	WORKTREE_SETUP_JOB_LABEL_PREFIX,
	WORKTREE_SETUP_NOTICE_TYPE,
	WORKTREE_SETUP_DISABLED_DETAIL,
	WORKTREE_SETUP_JOB_LIMIT_DETAIL,
	WORKTREE_SETUP_NO_REGISTRY_DETAIL,
	worktreeSetupJobLabel,
	isWorktreeSetupJobLabel,
	isWorktreeSetupRegistryAnnouncement,
	isWorktreeSetupJobLimit,
	WORKTREE_SETUP_RULES,
	worktreeSetupRuleFor,
	resolveWorktreeSetupPlan,
	skippedWorktreeSetup,
	worktreeSetupSummary,
	worktreeCreateSetupLine,
	worktreeSetupReadyText,
	worktreeSetupFailureText,
	createWorktreeSetupChain,
	recordWorktreeSetup,
};

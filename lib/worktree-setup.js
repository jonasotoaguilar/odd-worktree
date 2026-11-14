'use strict';
// The setup chain of `worktree_create` (S20, S21, S24).
//
// A lockfile at the worktree root selects one entry of a closed command table (S21),
// and that entry's steps run as the new checkout's own background task
// (`lib/worktree-setup-runner.js`). The create returns before a step settles and
// nothing about the chain is written down (S1, S3): the checkout's directory is the
// only record, so the chain reports itself once, in the completion notice that follows
// the child process outcome.
//
// Nothing here reads a repository file's contents or takes a command from one: the
// table below and the clone-local `setup` flag are the only sources of a command
// string. The chain reaches the world through two injected seams — the directory
// listing and the PATH probe — so a test answers for a machine it invents and no case
// runs a package manager.

/** S24: the custom message type of the one setup notification. */
const WORKTREE_SETUP_NOTICE_TYPE = 'gentle-worktree.setup';

/** S20: why a chain never ran, in the words a human reads. */
const WORKTREE_SETUP_DISABLED_DETAIL = 'setup is not enabled for this repository';

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
 * S21: the first matching entry, its binary checked, or the reason it cannot run. A
 * missing binary stops here instead of trying the next entry, because a lockfile from
 * one package manager installed by another is not the project's setup. The filesystem
 * seam answers what the root holds and whether a command resolves on the PATH.
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

// ---- S24: the two sentences ----

/** The task duration as the notices spell it: seconds, then minutes, then hours. */
function formatJobDuration(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** S24: the one sentence a chain that ended well sends. */
function worktreeSetupReadyText(input) {
	const steps = `${input.steps} step${input.steps === 1 ? '' : 's'}`;
	return `worktree setup ready · ${input.name} · ${steps} (${formatJobDuration(input.durationMs)})`;
}

/** S24: the one sentence a chain that failed sends, with the log a human would read. */
function worktreeSetupFailureText(input) {
	return [
		`worktree setup failed · ${input.name} · ${input.command} exited ${input.exitCode}`,
		`log: ${input.logPath}`,
		'worktree is not ready yet; re-run setup or inspect the log.',
	].join('\n');
}

module.exports = {
	WORKTREE_SETUP_NOTICE_TYPE,
	WORKTREE_SETUP_DISABLED_DETAIL,
	WORKTREE_SETUP_RULES,
	worktreeSetupRuleFor,
	resolveWorktreeSetupPlan,
	formatJobDuration,
	worktreeSetupReadyText,
	worktreeSetupFailureText,
};

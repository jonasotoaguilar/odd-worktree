'use strict';
// The background setup task of `worktree_create` (T4d, S24).
//
// `lib/worktree-setup.js` owns the closed command table and its plan. This module runs
// that plan as ONE tracked task of this process: each command is a child with a fixed
// argv, its output goes to its own log file under the system temp directory, and the
// steps run in order, one child at a time.
//
// S1/S3: nothing is written down. There is no setup record, no state file and no job
// registry to describe — the completion notice follows the CHILD PROCESS OUTCOME
// (exit code, signal, timeout, spawn error) and is the only report the chain makes. The
// create never waits for a command: `startWorktreeSetup` resolves once the first child
// is spawned, and the task settles in the background.
//
// Every external process is a binary plus a fixed argument array: the closed table's
// commands carry no quoting, so splitting one on whitespace is exact and no shell is
// ever involved. The child seam and the clock are injected, so a test answers for a
// machine it invents and no case runs a package manager.

const { spawn: spawnChild } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	resolveWorktreeSetupPlan,
	worktreeSetupFailureText,
	worktreeSetupReadyText,
} = require('./worktree-setup.js');

/** S25: a setup that never finishes is terminated after this bound. */
const WORKTREE_SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** How long a terminated child gets before SIGKILL, and before the task settles anyway. */
const WORKTREE_SETUP_KILL_GRACE_MS = 2_000;

/** The prefix of the per-task log directory inside the system temp directory. */
const WORKTREE_SETUP_LOG_PREFIX = 'odd-worktree-setup-';

/** This process's running setup tasks, keyed by the canonical worktree path. */
const runningTasks = new Map();
let taskSequence = 0;

/** Whether this process is running a setup task for that checkout right now. */
function isWorktreeSetupRunning(worktreePath) {
	return runningTasks.has(worktreePath);
}

// ---- The plan's two seams ----

/** S21: a PATH presence probe that never runs the binary. */
function binaryOnPath(command) {
	const directories = (process.env.PATH || '').split(path.delimiter).filter((directory) => directory.length > 0);
	if (process.platform !== 'win32') return directories.some((directory) => fs.existsSync(path.join(directory, command)));
	const extensions = ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')];
	return directories.some((directory) => extensions.some((extension) =>
		fs.existsSync(path.join(directory, `${command}${extension}`))
		|| fs.existsSync(path.join(directory, `${command}${extension.toLowerCase()}`))));
}

function defaultSeams() {
	return {
		entries: async (root) => {
			try {
				return await fs.promises.readdir(root);
			} catch {
				return [];
			}
		},
		hasBinary: async (command) => binaryOnPath(command),
	};
}

// ---- The notice ----

/** The task duration as the ported module spells it: seconds, then minutes, then hours. */
function formatSetupElapsed(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * S1/S24: a failure sentence built only from what the child process actually answered.
 * An exit code speaks for itself; a timeout, a signal or a spawn error names its own
 * reason instead, and no code is ever invented.
 */
function failureText(task, command, logPath, elapsed, detail) {
	const headline = detail.startsWith('timed out after')
		? `worktree setup failed · ${task.name} · ${command} ${detail}`
		: `worktree setup failed · ${task.name} · ${command} ${detail} (${elapsed})`;
	return [
		headline,
		`log: ${logPath ?? ''}`,
		'worktree is not ready yet; re-run setup or inspect the log.',
	].join('\n');
}

// ---- The tracked child ----

function commandArgv(command) {
	const parts = String(command).trim().split(/\s+/).filter((part) => part.length > 0);
	if (parts.length === 0) throw new Error('empty setup command');
	return parts;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function clearTimers(task) {
	if (task.timeout !== undefined) {
		clearTimeout(task.timeout);
		task.timeout = undefined;
	}
	if (task.grace !== undefined) {
		clearTimeout(task.grace);
		task.grace = undefined;
	}
}

function closeLog(job) {
	if (job === undefined || job.logFd === undefined) return;
	const descriptor = job.logFd;
	job.logFd = undefined;
	try {
		fs.closeSync(descriptor);
	} catch {
		// A descriptor the child already saw closed is not a failure.
	}
}

function logDirectoryFor(task) {
	if (task.logDirectory !== undefined) return task.logDirectory;
	task.logDirectory = fs.mkdtempSync(path.join(task.logRoot, WORKTREE_SETUP_LOG_PREFIX));
	return task.logDirectory;
}

/** The notice and the settled value of one task, sent exactly once. */
function finalize(task, outcome) {
	if (task.done) return;
	task.done = true;
	clearTimers(task);
	runningTasks.delete(task.path);
	if (task.current !== undefined) closeLog(task.current);
	if (typeof task.notify === 'function') {
		try {
			task.notify(outcome.notice, outcome.ok ? 'info' : 'warning');
		} catch {
			// A UI that cannot take the notice never changes what the child did.
		}
	}
	task.resolve(outcome);
}

function failStep(task, job, detail) {
	clearTimers(task);
	closeLog(job);
	if (task.done) return;
	const endedAt = task.now();
	finalize(task, {
		ok: false,
		notice: failureText(
			task,
			job.command,
			job.logPath,
			formatSetupElapsed(Math.max(0, endedAt.getTime() - task.startedAt.getTime())),
			detail,
		),
	});
}

function timeoutJob(task, job) {
	if (job.closed || task.done) return;
	job.timedOut = true;
	try {
		job.child?.kill('SIGTERM');
	} catch {
		// A child that already exited has nothing left to terminate.
	}
	task.grace = setTimeout(() => {
		task.grace = undefined;
		if (job.closed || task.done) return;
		try {
			job.child?.kill('SIGKILL');
		} catch {
			// The forced kill is best effort; the task settles either way.
		}
		failStep(task, job, `timed out after ${task.timeoutMs}ms`);
	}, task.killGraceMs);
	task.grace.unref();
}

function readyTask(task) {
	finalize(task, {
		ok: true,
		notice: worktreeSetupReadyText({
			name: task.name,
			steps: task.commands.length,
			durationMs: Math.max(0, task.now().getTime() - task.startedAt.getTime()),
		}),
	});
}

/**
 * Start one step's child. The task's own `settle` path moves to the next command, so a
 * multi-step plan is the same code once per command and never a shell pipeline.
 */
function startStep(task, index) {
	if (task.done) return;
	if (index >= task.commands.length) {
		readyTask(task);
		return;
	}
	const command = task.commands[index];
	let argv;
	try {
		argv = commandArgv(command);
	} catch (error) {
		failStep(task, { command, logFd: undefined, closed: true }, errorMessage(error));
		return;
	}
	const [bin, ...args] = argv;
	let logPath;
	let descriptor;
	try {
		logPath = path.join(logDirectoryFor(task), `step-${index + 1}.log`);
		descriptor = fs.openSync(logPath, 'a');
	} catch (error) {
		failStep(task, { command, logFd: undefined, closed: true }, `could not open its log: ${errorMessage(error)}`);
		return;
	}
	const job = {
		id: `${task.id}-${index + 1}`,
		command,
		logPath,
		logFd: descriptor,
		startedAt: task.now(),
		closed: false,
		timedOut: false,
		error: undefined,
		child: undefined,
	};
	task.current = job;
	let child;
	try {
		child = task.spawn(bin, args, {
			cwd: task.path,
			stdio: ['ignore', descriptor, descriptor],
			windowsHide: true,
		});
	} catch (error) {
		failStep(task, job, `could not start ${command}: ${errorMessage(error)}`);
		return;
	}
	job.child = child;
	child.on('error', (error) => {
		job.error = error;
	});
	child.on('close', (code, signal) => {
		if (job.closed) return;
		job.closed = true;
		closeLog(job);
		if (task.done) return;
		if (job.timedOut) {
			failStep(task, job, `timed out after ${task.timeoutMs}ms`);
			return;
		}
		if (job.error !== undefined) {
			failStep(task, job, `could not start ${command}: ${errorMessage(job.error)}`);
			return;
		}
		if (typeof code !== 'number') {
			failStep(task, job, signal ? `terminated by ${signal}` : 'did not exit normally');
			return;
		}
		if (code !== 0) {
			clearTimers(task);
			if (task.done) return;
			const endedAt = task.now();
			finalize(task, {
				ok: false,
				notice: worktreeSetupFailureText({
					name: task.name,
					command,
					exitCode: code,
					logPath,
				}) + ` (${formatSetupElapsed(Math.max(0, endedAt.getTime() - task.startedAt.getTime()))})`,
			});
			return;
		}
		clearTimers(task);
		startStep(task, index + 1);
	});
	task.timeout = setTimeout(() => timeoutJob(task, job), task.timeoutMs);
	task.timeout.unref();
}

// ---- The start ----

function positiveMs(value, fallback) {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the plan, then start one tracked task that runs it, without waiting for the
 * first command. A plan with nothing to run (no lockfile, a missing binary) starts
 * nothing and sends no notice — the create does not report setup at all (S1).
 *
 * Returns `{ started, refused, settled }`: `started` says whether a child now runs,
 * `refused` says a task for this checkout was already running, and `settled` resolves
 * once — never rejects — with `{ ok, notice }`.
 */
async function startWorktreeSetup(input) {
	const worktreePath = input.path;
	const now = typeof input.now === 'function' ? input.now : () => new Date();
	const plan = await resolveWorktreeSetupPlan({
		root: worktreePath,
		copiedChanges: Math.max(0, Number.isInteger(input.copiedChanges) ? input.copiedChanges : 0),
		seam: input.seams ?? defaultSeams(),
		platform: input.platform ?? process.platform,
	});

	// The refusal check and the start are one synchronous region: no await sits
	// between them, so two concurrent creates for one checkout cannot both start.
	const running = runningTasks.get(worktreePath);
	if (running !== undefined) return { started: false, refused: true, settled: running.settled };

	if (plan.detail !== undefined) {
		return {
			started: false,
			refused: false,
			skipped: plan.detail,
			settled: Promise.resolve({ ok: true, skipped: plan.detail, notice: undefined }),
		};
	}

	let resolve;
	const settled = new Promise((done) => {
		resolve = done;
	});
	const task = {
		id: `${process.pid}-${++taskSequence}`,
		path: worktreePath,
		name: input.name,
		commands: plan.steps,
		now,
		spawn: typeof input.spawn === 'function' ? input.spawn : spawnChild,
		logRoot: typeof input.logRoot === 'string' && input.logRoot.length > 0 ? input.logRoot : os.tmpdir(),
		logDirectory: undefined,
		timeoutMs: positiveMs(input.timeoutMs, WORKTREE_SETUP_TIMEOUT_MS),
		killGraceMs: positiveMs(input.killGraceMs, WORKTREE_SETUP_KILL_GRACE_MS),
		notify: typeof input.notify === 'function' ? input.notify : undefined,
		startedAt: now(),
		current: undefined,
		timeout: undefined,
		grace: undefined,
		done: false,
		resolve,
		settled,
	};
	runningTasks.set(worktreePath, task);
	startStep(task, 0);
	return { started: true, refused: false, settled };
}

module.exports = {
	WORKTREE_SETUP_TIMEOUT_MS,
	WORKTREE_SETUP_KILL_GRACE_MS,
	WORKTREE_SETUP_LOG_PREFIX,
	isWorktreeSetupRunning,
	startWorktreeSetup,
	formatSetupElapsed,
};

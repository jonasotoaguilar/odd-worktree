'use strict';
// The background setup task of `worktree_create` (T4d).
//
// `lib/worktree-setup.js` owns the closed command table, the chain and the state
// vocabulary. This module owns the half the ported chain was always handed by the
// hosting shell's job registry: it starts one planned command as a tracked task of
// THIS process, sends the child's output to its own log under the system temp
// directory, and settles the chain through `recordWorktreeSetup` when the child ends.
// Nothing here announces or consumes `WORKTREE_SETUP_REGISTRY_CHANNEL`: that channel
// describes the source shell's job registry, and this package has none.
//
// The create never waits for a command. `startWorktreeSetup` resolves once the child
// is spawned and the record says `running`, so the caller prints the state the record
// holds at that moment. A crash, a kill or a session shutdown leaves that `running`
// record behind — the one honest state a process that is gone can still support.
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
	createWorktreeSetupChain,
	recordWorktreeSetup,
	resolveWorktreeSetupPlan,
	skippedWorktreeSetup,
	worktreeSetupFailureText,
	worktreeSetupReadyText,
} = require('./worktree-setup.js');
const { readWorktreeMetadataStore } = require('./worktree-metadata.js');

/** S25: a setup that never finishes is terminated after this bound. */
const WORKTREE_SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** How long a terminated child gets before SIGKILL, and before the task settles anyway. */
const WORKTREE_SETUP_KILL_GRACE_MS = 2_000;

/** The prefix of the per-task log directory inside the system temp directory. */
const WORKTREE_SETUP_LOG_PREFIX = 'odd-worktree-setup-';

/** This process's running setup tasks, keyed by the canonical worktree path. */
const runningTasks = new Map();
let taskSequence = 0;

// ---- The store ----

/** The setup state the clone's one document holds for a worktree, or nothing. */
function readWorktreeSetupState(input) {
	const store = readWorktreeMetadataStore(input.storePath);
	if (store.status !== 'valid') return undefined;
	const record = store.file.records[input.path];
	return record === undefined ? undefined : record.setup;
}

/** Whether this process is running a setup task for that checkout right now. */
function isWorktreeSetupRunning(worktreePath) {
	return runningTasks.has(worktreePath);
}

// The proven write: persist the state, then re-read the record to show the bytes
// landed. A comparison of the fields the state actually carries, because the store
// writes them in its own key order; comparing whole objects by identity would fail
// on a legitimate write.
function setupMatches(stored, written) {
	if (stored.status !== written.status) return false;
	if (stored.command !== written.command) return false;
	if (stored.jobId !== written.jobId) return false;
	if (stored.exitCode !== written.exitCode) return false;
	if (stored.endedAt !== written.endedAt) return false;
	if (stored.detail !== written.detail) return false;
	if (stored.steps.length !== written.steps.length) return false;
	return stored.steps.every((step, index) => {
		const other = written.steps[index];
		return step.command === other.command
			&& step.status === other.status
			&& step.exitCode === other.exitCode
			&& step.endedAt === other.endedAt;
	});
}

function writeSetupState(storePath, worktreePath, setup) {
	const result = recordWorktreeSetup({ storePath, path: worktreePath, setup });
	if (result.recorded !== true) return result;
	const stored = readWorktreeSetupState({ storePath, path: worktreePath });
	if (stored === undefined) {
		return { recorded: false, reason: 'no metadata record for this worktree after the write' };
	}
	if (!setupMatches(stored, setup)) {
		return { recorded: false, reason: 'the setup state did not land in the metadata record' };
	}
	return { recorded: true };
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

// ---- The one notice ----

/** The job duration as the ported module spells it: seconds, then minutes, then hours. */
function formatSetupElapsed(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function noticeFor(task, setup) {
	const durationMs = Math.max(0, task.now().getTime() - task.startedAt.getTime());
	const elapsed = formatSetupElapsed(durationMs);
	// The ported ready sentence already names the worktree and the elapsed time.
	if (setup.status === 'ready' && typeof task.portedNotice === 'string') return task.portedNotice;
	// The ported failure sentence names the worktree, the command and the exit code;
	// the elapsed time is the one fact this task adds to it.
	if (setup.status === 'failed' && typeof setup.exitCode === 'number' && typeof task.portedNotice === 'string') {
		const [headline, ...rest] = task.portedNotice.split('\n');
		return [`${headline} (${elapsed})`, ...rest].join('\n');
	}
	// A task that never produced an exit code (a timeout, a killed child, a start
	// failure) reports the reason this task recorded, never a fabricated code.
	const command = setup.command ?? task.current?.command ?? task.commands[0] ?? 'setup';
	const reason = setup.detail === undefined || setup.detail.length === 0 ? 'did not exit normally' : setup.detail;
	const headline = reason.startsWith('timed out after')
		? `worktree setup failed · ${task.name} · ${command} timed out after ${elapsed}`
		: `worktree setup failed · ${task.name} · ${command} ${reason} (${elapsed})`;
	return [
		headline,
		`log: ${setup.logPath ?? task.current?.logPath ?? ''}`,
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

/**
 * S22/S23: one job of the chain. The record already says `running` when this runs, so
 * a task whose state could not be recorded refuses to spawn: an install the clone's
 * document cannot describe is never started behind the reader's back.
 */
function startJob(task, request) {
	if (task.proof === undefined || task.proof.recorded !== true) {
		throw new Error('the setup state could not be recorded');
	}
	const [bin, ...args] = commandArgv(request.command);
	const logPath = path.join(logDirectoryFor(task), `step-${task.jobs.length + 1}.log`);
	const descriptor = fs.openSync(logPath, 'a');
	const job = {
		id: `${task.id}-${task.jobs.length + 1}`,
		command: request.command,
		logPath,
		logFd: descriptor,
		startedAt: task.now(),
		closed: false,
		timedOut: false,
		error: undefined,
		child: undefined,
	};
	task.jobs.push(job);
	task.current = job;
	let child;
	try {
		child = task.spawn(bin, args, {
			cwd: request.cwd,
			stdio: ['ignore', descriptor, descriptor],
			windowsHide: true,
		});
	} catch (error) {
		closeLog(job);
		throw error;
	}
	job.child = child;
	child.on('error', (error) => {
		job.error = error;
	});
	child.on('close', (code, signal) => settleJob(task, job, code, signal));
	task.timeout = setTimeout(() => timeoutJob(task, job), task.timeoutMs);
	task.timeout.unref();
	return { id: job.id, outputPath: logPath };
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
			// The forced kill is best effort; the record settles either way.
		}
		closeLog(job);
		finalizeFailure(task, job, task.now(), `timed out after ${task.timeoutMs}ms`);
	}, task.killGraceMs);
	task.grace.unref();
}

function failureState(task, job, endedAt, detail) {
	const stored = readWorktreeSetupState({ storePath: task.storePath, path: task.path });
	const steps = stored !== undefined && Array.isArray(stored.steps) ? stored.steps.map((step) => ({ ...step })) : [];
	let current = steps.find((step) => step.status === 'running');
	if (current === undefined) {
		current = { command: job?.command ?? task.commands[0], status: 'running' };
		steps.push(current);
	}
	current.status = 'failed';
	if (job !== undefined) current.logPath = job.logPath;
	if (current.startedAt === undefined) current.startedAt = (job?.startedAt ?? task.startedAt).toISOString();
	current.endedAt = endedAt.toISOString();
	const state = { status: 'failed', steps, endedAt: endedAt.toISOString(), detail };
	if (current.command !== undefined) state.command = current.command;
	if (current.logPath !== undefined) state.logPath = current.logPath;
	return state;
}

function settleJob(task, job, code, signal) {
	if (job.closed) return;
	job.closed = true;
	clearTimers(task);
	closeLog(job);
	if (task.done) return;
	const endedAt = task.now();
	if (job.timedOut) {
		finalizeFailure(task, job, endedAt, `timed out after ${task.timeoutMs}ms`);
		return;
	}
	if (job.error !== undefined) {
		finalizeFailure(task, job, endedAt, `could not start ${job.command}: ${errorMessage(job.error)}`);
		return;
	}
	if (typeof code !== 'number') {
		finalizeFailure(task, job, endedAt, signal ? `terminated by ${signal}` : 'did not exit normally');
		return;
	}
	let settled;
	try {
		settled = task.chain.settle(job.id, code, endedAt);
	} catch (error) {
		finalizeFailure(task, job, endedAt, `could not record the end of ${job.command}: ${errorMessage(error)}`);
		return;
	}
	if (settled === undefined) return;
	// A passing step that starts the next one is not the end of the task.
	if (settled.jobId !== undefined) return;
	finalizeSettled(task, settled.setup);
}

function finalizeFailure(task, job, endedAt, detail) {
	if (task.done) return;
	const state = failureState(task, job, endedAt, detail);
	task.proof = writeSetupState(task.storePath, task.path, state);
	finalizeSettled(task, state);
}

function finalizeSettled(task, setup) {
	if (task.done) return;
	task.done = true;
	clearTimers(task);
	runningTasks.delete(task.path);
	task.setup = setup;
	const text = noticeFor(task, setup);
	if (typeof task.notify === 'function') {
		try {
			task.notify(text, setup.status === 'ready' ? 'info' : 'warning');
		} catch {
			// A UI that cannot take the notice never changes what was recorded.
		}
	}
	task.resolve({
		setup,
		recorded: task.proof !== undefined && task.proof.recorded === true,
		reason: task.proof === undefined ? 'no setup state was recorded' : task.proof.reason,
		notice: text,
	});
}

// ---- The start ----

function positiveMs(value, fallback) {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runningResult(task, storePath, worktreePath) {
	return {
		setup: readWorktreeSetupState({ storePath, path: worktreePath }) ?? task.setup,
		started: false,
		refused: true,
		settled: task.settled,
	};
}

/**
 * S22/S25: resolve the plan, then start one tracked task that runs it, without
 * waiting for the first command. A plan the ported module skips (no lockfile, a
 * missing binary) is written and returned as that skip; a checkout this process is
 * already setting up refuses instead of starting a second install.
 *
 * Returns `{ setup, started, settled }`: `setup` is the state the record holds when
 * the call returns, `started` says whether a child now runs, and `settled` resolves
 * once — never rejects — with `{ setup, recorded, reason, notice }`.
 */
async function startWorktreeSetup(input) {
	const worktreePath = input.path;
	const storePath = input.storePath;
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
	if (running !== undefined) return runningResult(running, storePath, worktreePath);

	if (plan.detail !== undefined) {
		const skipped = skippedWorktreeSetup(plan.detail);
		const proof = writeSetupState(storePath, worktreePath, skipped);
		return {
			setup: skipped,
			started: false,
			settled: Promise.resolve({ setup: skipped, recorded: proof.recorded === true, reason: proof.reason }),
		};
	}

	const task = {
		id: `${process.pid}-${++taskSequence}`,
		path: worktreePath,
		name: input.name,
		storePath,
		commands: plan.steps,
		now,
		spawn: typeof input.spawn === 'function' ? input.spawn : spawnChild,
		logRoot: typeof input.logRoot === 'string' && input.logRoot.length > 0 ? input.logRoot : os.tmpdir(),
		logDirectory: undefined,
		timeoutMs: positiveMs(input.timeoutMs, WORKTREE_SETUP_TIMEOUT_MS),
		killGraceMs: positiveMs(input.killGraceMs, WORKTREE_SETUP_KILL_GRACE_MS),
		notify: typeof input.notify === 'function' ? input.notify : undefined,
		startedAt: now(),
		jobs: [],
		current: undefined,
		timeout: undefined,
		grace: undefined,
		proof: undefined,
		portedNotice: undefined,
		setup: undefined,
		done: false,
		resolve: undefined,
		settled: undefined,
	};
	task.settled = new Promise((resolve) => {
		task.resolve = resolve;
	});
	task.chain = createWorktreeSetupChain({
		path: worktreePath,
		name: input.name,
		sessionId: input.sessionId,
		commands: plan.steps,
		persist: (state) => {
			const proof = writeSetupState(storePath, worktreePath, state);
			task.proof = proof;
			task.setup = state;
			return proof;
		},
		jobs: { start: (request) => startJob(task, request) },
		notify: (text) => {
			task.portedNotice = text;
		},
		now,
	});
	runningTasks.set(worktreePath, task);

	let run;
	try {
		run = task.chain.start();
	} catch (error) {
		finalizeFailure(task, undefined, now(), `could not start ${plan.steps[0]}: ${errorMessage(error)}`);
		return { setup: task.setup, started: false, settled: task.settled };
	}
	if (run.jobId === undefined) {
		// The chain recorded a start failure with its own wording and started nothing.
		finalizeSettled(task, run.setup);
		return { setup: run.setup, started: false, settled: task.settled };
	}
	return { setup: run.setup, started: true, settled: task.settled };
}

module.exports = {
	WORKTREE_SETUP_TIMEOUT_MS,
	WORKTREE_SETUP_KILL_GRACE_MS,
	WORKTREE_SETUP_LOG_PREFIX,
	isWorktreeSetupRunning,
	readWorktreeSetupState,
	startWorktreeSetup,
	formatSetupElapsed,
};

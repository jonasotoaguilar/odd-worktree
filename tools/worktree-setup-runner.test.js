'use strict';
// T4d: the create's own background setup task.
//
// `lib/worktree-setup.js` owns the closed command table, the chain and the state
// vocabulary; `lib/worktree-setup-runner.js` owns the half the source branch was
// handed by the hosting shell's job registry: one tracked child per planned command,
// its own log under the system temp directory, and the terminal write through
// `recordWorktreeSetup`. Everything below injects the child-process seam and the
// clock, so no package manager is ever spawned and nothing reaches the network.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
	WORKTREE_SETUP_TIMEOUT_MS,
	isWorktreeSetupRunning,
	readWorktreeSetupState,
	startWorktreeSetup,
} = require('../lib/worktree-setup-runner.js');
const { createWorktreeMetadataRecord, saveWorktreeMetadataRecords } = require('../lib/worktree-metadata.js');
const { worktreeSetupReadyText, worktreeSetupSummary } = require('../lib/worktree-setup.js');

const scratch = [];
function track(dir) {
	scratch.push(dir);
	return dir;
}
after(() => {
	for (const dir of scratch) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// A removed scratch directory is already what the test wanted.
		}
	}
});

// One clone-shaped scratch area: the store path, and the worktree path that keys
// the record. Both are canonical absolute paths, which the store refuses otherwise.
function makeClone(tag) {
	const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-wt-runner-${tag}-`)));
	return {
		root,
		storePath: path.join(root, 'pi-worktrees.json'),
		worktreePath: path.join(root, 'repo-worktrees', 'demo'),
	};
}

function writeRecord(clone, tag = 'demo') {
	saveWorktreeMetadataRecords(clone.storePath, {
		[clone.worktreePath]: createWorktreeMetadataRecord({
			createdBy: 'thread-1',
			adminId: `admin-${tag}`,
			branchAtCreation: 'feat/demo',
			baseRef: 'main',
		}),
	});
}

// The injected child seam: every call is recorded, and the test decides when the
// child ends. `stdio` carries the real log descriptor the runner opened, so a test
// can write the output a real command would have produced.
function fakeSpawn() {
	const calls = [];
	const spawn = (bin, args, options) => {
		const child = new EventEmitter();
		child.killed = [];
		child.kill = (signal) => {
			child.killed.push(signal);
			return true;
		};
		child.pid = 4000 + calls.length;
		calls.push({ bin, args, options, child });
		return child;
	};
	return { spawn, calls };
}

// A deterministic clock: the runner reads it for the start, the end and the elapsed.
function clock() {
	let value = Date.UTC(2026, 0, 1, 0, 0, 0);
	return {
		now: () => new Date(value),
		advance: (ms) => {
			value += ms;
		},
	};
}

const NPM_SEAMS = {
	entries: async () => ['package-lock.json'],
	hasBinary: async (command) => command === 'npm',
};

function start(clone, overrides = {}) {
	return startWorktreeSetup({
		path: clone.worktreePath,
		name: 'demo',
		storePath: clone.storePath,
		sessionId: 'thread-1',
		copiedChanges: 0,
		seams: NPM_SEAMS,
		...overrides,
	});
}

test('S22/S24: the create returns while the install runs and the record settles ready', async () => {
	const clone = makeClone('ready');
	writeRecord(clone);
	const { spawn, calls } = fakeSpawn();
	const time = clock();
	const notices = [];
	const started = await start(clone, {
		spawn,
		now: time.now,
		logRoot: clone.root,
		notify: (text, level) => notices.push([level, text]),
	});

	// The start resolved with the child still running: nothing waited for it.
	assert.equal(started.started, true);
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), true);
	assert.equal(calls.length, 1, 'one child, spawned once');
	assert.equal(calls[0].bin, 'npm');
	assert.deepEqual(calls[0].args, ['ci'], 'a fixed argv, never a shell string');
	assert.equal(calls[0].options.shell, undefined);
	assert.equal(calls[0].options.cwd, clone.worktreePath);

	// The record already says running, with its own log under the given temp root.
	const running = readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath });
	assert.equal(running.status, 'running');
	assert.equal(running.command, 'npm ci');
	assert.equal(worktreeSetupSummary(running), 'running (npm ci)');
	assert.ok(running.logPath.startsWith(clone.root), 'the log lives under the system temp root');
	assert.ok(fs.existsSync(running.logPath), 'the log file exists');
	fs.writeSync(calls[0].options.stdio[1], 'installing\n');
	assert.equal(fs.readFileSync(running.logPath, 'utf8'), 'installing\n', 'the child writes to its own log');
	assert.deepEqual(notices, [], 'no notice before the command settles');

	// The command settles after the call that started it already returned.
	time.advance(65_000);
	calls[0].child.emit('close', 0, null);
	const settled = await started.settled;

	assert.equal(settled.recorded, true, 'the terminal write was proven by re-reading the record');
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), false, 'a settled task clears its record');
	const ready = readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath });
	assert.equal(ready.status, 'ready');
	assert.equal(ready.command, 'npm ci');
	assert.equal(ready.exitCode, 0);
	assert.equal(ready.endedAt, new Date(Date.UTC(2026, 0, 1, 0, 1, 5)).toISOString());
	assert.equal(ready.steps.length, 1);
	assert.equal(ready.steps[0].status, 'ready');
	assert.equal(ready.steps[0].exitCode, 0);

	// Exactly one completion notice, naming the worktree and the elapsed time.
	assert.equal(notices.length, 1);
	assert.equal(notices[0][0], 'info');
	assert.equal(notices[0][1], worktreeSetupReadyText({ name: 'demo', steps: 1, durationMs: 65_000 }));
	assert.equal(notices[0][1], 'worktree setup ready · demo · 1 step (1m 5s)');
});

test('S23/S24: a non-zero exit settles failed with its exit code, log and elapsed time', async () => {
	const clone = makeClone('failed');
	writeRecord(clone);
	const { spawn, calls } = fakeSpawn();
	const time = clock();
	const notices = [];
	const started = await start(clone, {
		spawn,
		now: time.now,
		logRoot: clone.root,
		notify: (text, level) => notices.push([level, text]),
	});

	time.advance(5_000);
	calls[0].child.emit('close', 2, null);
	const settled = await started.settled;

	assert.equal(settled.recorded, true);
	const failed = readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath });
	assert.equal(failed.status, 'failed');
	assert.equal(failed.exitCode, 2);
	assert.equal(failed.steps[0].status, 'failed');
	assert.equal(failed.steps[0].exitCode, 2);

	assert.equal(notices.length, 1, 'one notice, not one per step');
	assert.equal(notices[0][0], 'warning');
	const lines = notices[0][1].split('\n');
	assert.equal(lines[0], 'worktree setup failed · demo · npm ci exited 2 (5s)');
	assert.equal(lines[1], `log: ${failed.logPath}`);
	assert.match(lines[2], /^worktree is not ready yet; re-run setup or inspect the log\.$/);
});

test('S21: a binary missing from PATH is the ported skipped case, not a failure', async () => {
	const clone = makeClone('missing');
	writeRecord(clone);
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const started = await start(clone, {
		spawn,
		logRoot: clone.root,
		notify: (text, level) => notices.push([level, text]),
		seams: { entries: async () => ['package-lock.json'], hasBinary: async () => false },
	});

	assert.equal(started.started, false, 'nothing was started');
	assert.deepEqual(started.setup, { status: 'skipped', steps: [], detail: 'npm not found' });
	assert.equal(calls.length, 0, 'nothing is spawned');
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), false);
	assert.deepEqual(readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath }), {
		status: 'skipped',
		steps: [],
		detail: 'npm not found',
	});
	await started.settled;
	assert.deepEqual(notices, [], 'a skip has nothing to announce');
});

test('S21: no lockfile at the root is skipped with the ported reason', async () => {
	const clone = makeClone('plain');
	writeRecord(clone);
	const { calls } = fakeSpawn();
	const started = await start(clone, {
		spawn: fakeSpawn().spawn,
		logRoot: clone.root,
		seams: { entries: async () => ['README.md'], hasBinary: async () => true },
	});
	assert.deepEqual(started.setup, { status: 'skipped', steps: [], detail: 'no lockfile at root' });
	assert.equal(calls.length, 0);
});

test('S25: a command that never finishes is terminated, recorded and announced once', async () => {
	const clone = makeClone('timeout');
	writeRecord(clone);
	const { spawn, calls } = fakeSpawn();
	const time = clock();
	const notices = [];
	const started = await start(clone, {
		spawn,
		now: time.now,
		logRoot: clone.root,
		timeoutMs: 20,
		killGraceMs: 5,
		notify: (text, level) => notices.push([level, text]),
	});
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), true);

	time.advance(20);
	const settled = await started.settled;
	assert.deepEqual(calls[0].child.killed, ['SIGTERM', 'SIGKILL'], 'the hung child is terminated');

	const failed = readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath });
	assert.equal(failed.status, 'failed');
	assert.equal(failed.detail, 'timed out after 20ms');
	assert.equal(failed.exitCode, undefined);
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), false);
	assert.equal(settled.recorded, true);

	assert.equal(notices.length, 1);
	assert.match(notices[0][1].split('\n')[0], /^worktree setup failed · demo · npm ci timed out after /);
	assert.equal(notices[0][1].split('\n')[1], `log: ${failed.logPath}`);

	// A late close from the killed child never becomes a second settlement.
	calls[0].child.emit('close', null, 'SIGKILL');
	assert.equal(notices.length, 1);
});

test('S25: a second start for a checkout already running refuses instead of installing twice', async () => {
	const clone = makeClone('refuse');
	writeRecord(clone);
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const first = await start(clone, {
		spawn,
		logRoot: clone.root,
		notify: (text, level) => notices.push([level, text]),
	});
	const second = await start(clone, { spawn, logRoot: clone.root });

	assert.equal(second.started, false, 'the second start is refused');
	assert.equal(second.refused, true);
	assert.equal(calls.length, 1, 'no second install in the same checkout');
	assert.equal(second.setup.status, 'running', 'the ported state, not an invented refusal');
	assert.equal(worktreeSetupSummary(second.setup), 'running (npm ci)');

	calls[0].child.emit('close', 0, null);
	await first.settled;
	await second.settled;
	assert.equal(notices.length, 1, 'the refused start announces nothing');
});

test('S25: two checkouts at once are two independent tracked tasks', async () => {
	const one = makeClone('one');
	const two = makeClone('two');
	writeRecord(one, 'one');
	writeRecord(two, 'two');
	const { spawn, calls } = fakeSpawn();
	const first = await start(one, { spawn, logRoot: one.root });
	const second = await start(two, { spawn, logRoot: two.root });

	assert.equal(calls.length, 2);
	assert.equal(calls[0].options.cwd, one.worktreePath);
	assert.equal(calls[1].options.cwd, two.worktreePath);
	assert.equal(isWorktreeSetupRunning(one.worktreePath), true);
	assert.equal(isWorktreeSetupRunning(two.worktreePath), true);

	calls[1].child.emit('close', 0, null);
	await second.settled;
	assert.equal(readWorktreeSetupState({ storePath: one.storePath, path: one.worktreePath }).status, 'running');
	assert.equal(readWorktreeSetupState({ storePath: two.storePath, path: two.worktreePath }).status, 'ready');

	calls[0].child.emit('close', 1, null);
	await first.settled;
	assert.equal(readWorktreeSetupState({ storePath: one.storePath, path: one.worktreePath }).status, 'failed');
});

test('S23: a checkout with no metadata record starts nothing and claims nothing', async () => {
	const clone = makeClone('norecord');
	const { spawn, calls } = fakeSpawn();
	const started = await start(clone, { spawn, logRoot: clone.root });

	assert.equal(started.started, false, 'an unrecordable setup is never started');
	assert.equal(calls.length, 0);
	const settled = await started.settled;
	assert.equal(settled.recorded, false, 'the unrecorded state is reported, never claimed');
	assert.equal(readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath }), undefined);
});

test('S24: a two-step chain announces exactly once, when the last step settles', async () => {
	const clone = makeClone('steps');
	writeRecord(clone);
	const { spawn, calls } = fakeSpawn();
	const time = clock();
	const notices = [];
	const started = await start(clone, {
		spawn,
		now: time.now,
		logRoot: clone.root,
		notify: (text, level) => notices.push([level, text]),
		seams: { entries: async () => ['requirements.txt'], hasBinary: async (command) => command === 'python3' },
	});

	assert.equal(calls.length, 1, 'the first step starts; the second waits for it');
	assert.deepEqual(calls[0].args, ['-m', 'venv', '.venv']);
	time.advance(1_000);
	calls[0].child.emit('close', 0, null);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(calls.length, 2, 'the next step starts after the first settles');
	assert.deepEqual(calls[1].args, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
	assert.equal(notices.length, 0, 'no notice after the first step');
	const between = readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath });
	assert.equal(between.status, 'running');
	assert.equal(worktreeSetupSummary(between), 'running (.venv/bin/python -m pip install -r requirements.txt)');

	time.advance(2_000);
	calls[1].child.emit('close', 0, null);
	await started.settled;
	assert.equal(notices.length, 1, 'one notice for the whole chain');
	assert.equal(notices[0][1], worktreeSetupReadyText({ name: 'demo', steps: 2, durationMs: 3_000 }));
	const ready = readWorktreeSetupState({ storePath: clone.storePath, path: clone.worktreePath });
	assert.equal(ready.status, 'ready');
	assert.deepEqual(ready.steps.map((step) => step.status), ['ready', 'ready']);
	assert.notEqual(ready.steps[0].logPath, ready.steps[1].logPath, 'each step keeps its own log');
	assert.ok(fs.existsSync(ready.steps[0].logPath));
	assert.ok(fs.existsSync(ready.steps[1].logPath));
});

test('S24: the elapsed wording stays the ported one', () => {
	assert.equal(worktreeSetupReadyText({ name: 'demo', steps: 2, durationMs: 65_000 }), 'worktree setup ready · demo · 2 steps (1m 5s)');
	assert.equal(WORKTREE_SETUP_TIMEOUT_MS, 15 * 60 * 1000, 'the default bound is fifteen minutes');
});

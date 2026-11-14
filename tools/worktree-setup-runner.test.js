'use strict';
// T4d: the create's own background setup task.
//
// `lib/worktree-setup.js` owns the closed command table and its plan;
// `lib/worktree-setup-runner.js` owns the task: one tracked child per planned command,
// its own log under the system temp directory, and the ONE completion notice built
// from the child process outcome. S1/S3: nothing is persisted — there is no record to
// read back, so every assertion is about the child, its log and the notice.
// Everything below injects the child-process seam and the clock, so no package manager
// is ever spawned and nothing reaches the network.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
	WORKTREE_SETUP_TIMEOUT_MS,
	isWorktreeSetupRunning,
	startWorktreeSetup,
} = require('../lib/worktree-setup-runner.js');
const { worktreeSetupReadyText } = require('../lib/worktree-setup.js');

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

function makeClone(tag) {
	const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-wt-runner-${tag}-`)));
	return {
		logRoot: track(fs.mkdtempSync(path.join(os.tmpdir(), `odd-wt-runner-logs-${tag}-`))),
		worktreePath: path.join(root, 'repo-worktrees', 'demo'),
	};
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

// The timeout path settles through the runner's own unref'd timer: a background
// setup task must never keep the host process alive. A test awaiting such a
// settlement would leave the event loop empty while its promise is still pending,
// and the runner on Node 18/20/22 refuses that. One ref'd keep-alive, held only for
// the duration of the await, keeps those runners honest.
async function holdLoop(promise) {
	const keepAlive = setInterval(() => {}, 1_000);
	try {
		return await promise;
	} finally {
		clearInterval(keepAlive);
	}
}

const NPM_SEAMS = {
	entries: async () => ['package-lock.json'],
	hasBinary: async (command) => command === 'npm',
};

function start(clone, overrides = {}) {
	return startWorktreeSetup({
		path: clone.worktreePath,
		name: 'demo',
		logRoot: clone.logRoot,
		seams: overrides.seams ?? NPM_SEAMS,
		spawn: overrides.spawn,
		now: overrides.now,
		notify: overrides.notify,
		timeoutMs: overrides.timeoutMs,
		killGraceMs: overrides.killGraceMs,
		copiedChanges: overrides.copiedChanges ?? 0,
	});
}

// ---- S1/S24: the create never waits, and the notice follows the child ----

test('a lockfile starts the ported install, and the create returns before it finishes', async () => {
	const clone = makeClone('start');
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const started = await start(clone, { spawn, notify: (text, level) => notices.push([level, text]), now: clock().now });

	assert.equal(started.started, true);
	assert.equal(started.refused, false);
	assert.equal(calls.length, 1, 'one child is spawned before the call resolves');
	assert.equal(calls[0].bin, 'npm');
	assert.deepEqual(calls[0].args, ['ci']);
	assert.equal(calls[0].options.cwd, clone.worktreePath);
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), true);
	assert.deepEqual(notices, [], 'nothing is announced while the child runs');

	calls[0].child.emit('close', 0, null);
	const settled = await started.settled;
	assert.equal(settled.ok, true);
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), false);
	assert.deepEqual(notices, [['info', worktreeSetupReadyText({ name: 'demo', steps: 1, durationMs: 0 })]]);
});

test('the child’s output goes to its own log under the injected root', async () => {
	const clone = makeClone('log');
	const { spawn, calls } = fakeSpawn();
	const started = await start(clone, { spawn, now: clock().now });
	const entry = calls[0];
	assert.ok(entry.options.stdio[1] !== 'ignore', 'stdout is a real descriptor');
	const fd = entry.options.stdio[1];
	fs.writeSync(fd, 'installed 42 packages\n');
	entry.child.emit('close', 0, null);
	await started.settled;

	const directories = fs.readdirSync(clone.logRoot);
	assert.equal(directories.length, 1);
	const logs = fs.readdirSync(path.join(clone.logRoot, directories[0]));
	assert.deepEqual(logs, ['step-1.log']);
	assert.equal(fs.readFileSync(path.join(clone.logRoot, directories[0], 'step-1.log'), 'utf8'), 'installed 42 packages\n');
});

test('a multi-step plan runs one child per step and announces once, after the last', async () => {
	const clone = makeClone('steps');
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const now = clock();
	const started = await start(clone, {
		spawn,
		now: now.now,
		notify: (text, level) => notices.push([level, text]),
		seams: { entries: async () => ['requirements.txt'], hasBinary: async (command) => command === 'python3' },
	});

	assert.equal(calls.length, 1);
	calls[0].child.emit('close', 0, null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 2, 'the second step starts only after the first passed');
	assert.deepEqual(calls[1].args, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
	assert.deepEqual(notices, [], 'a passing step that starts the next one is not the end of the task');

	now.advance(3_000);
	calls[1].child.emit('close', 0, null);
	const settled = await started.settled;
	assert.equal(settled.ok, true);
	assert.deepEqual(notices, [['info', worktreeSetupReadyText({ name: 'demo', steps: 2, durationMs: 3_000 })]]);
});

test('a failing step stops the chain and sends one failure notice naming the log', async () => {
	const clone = makeClone('fail');
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const started = await start(clone, { spawn, now: clock().now, notify: (text, level) => notices.push([level, text]) });

	calls[0].child.emit('close', 1, null);
	const settled = await started.settled;
	assert.equal(settled.ok, false);
	assert.equal(calls.length, 1, 'nothing follows a failed step');
	assert.equal(notices.length, 1);
	assert.equal(notices[0][0], 'warning');
	assert.match(notices[0][1], /^worktree setup failed · demo · npm ci exited 1/);
	assert.match(notices[0][1], /log: .*step-1\.log/);
	assert.match(notices[0][1], /worktree is not ready yet; re-run setup or inspect the log\./);
});

test('a root with no lockfile starts nothing and sends no notice', async () => {
	const clone = makeClone('skip');
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const started = await start(clone, {
		spawn,
		notify: (text, level) => notices.push([level, text]),
		seams: { entries: async () => ['README.md'], hasBinary: async () => true },
	});

	assert.equal(started.started, false);
	assert.equal(started.skipped, 'no lockfile at root');
	const settled = await started.settled;
	assert.equal(settled.ok, true);
	assert.equal(settled.notice, undefined);
	assert.deepEqual(calls, [], 'no child runs for a plan with no steps');
	assert.deepEqual(notices, []);
	assert.equal(isWorktreeSetupRunning(clone.worktreePath), false);
});

test('a second start for one checkout refuses instead of running two installs', async () => {
	const clone = makeClone('twice');
	const { spawn, calls } = fakeSpawn();
	const now = clock();
	const first = await start(clone, { spawn, now: now.now });
	const second = await start(clone, { spawn, now: now.now });

	assert.equal(second.started, false);
	assert.equal(second.refused, true);
	assert.equal(calls.length, 1, 'the second start spawns nothing');
	assert.equal(second.settled, first.settled, 'both callers wait on the same task');

	calls[0].child.emit('close', 0, null);
	await first.settled;
});

test('a child that never finishes is terminated at the bound and reports its reason', async () => {
	const clone = makeClone('timeout');
	const { spawn, calls } = fakeSpawn();
	const notices = [];
	const started = await start(clone, {
		spawn,
		now: clock().now,
		notify: (text, level) => notices.push([level, text]),
		timeoutMs: 20,
		killGraceMs: 20,
	});

	const settled = await holdLoop(started.settled);
	assert.equal(settled.ok, false);
	assert.deepEqual(calls[0].child.killed, ['SIGTERM', 'SIGKILL']);
	assert.equal(notices.length, 1);
	assert.match(notices[0][1], /npm ci timed out after 20ms/);
});

test('a spawn error is reported as what the child answered, never as a fake code', async () => {
	const clone = makeClone('spawn-error');
	const spawn = (bin, args, options) => {
		const child = new EventEmitter();
		child.kill = () => true;
		child.options = options;
		setImmediate(() => {
			child.emit('error', new Error('spawn npm ENOENT'));
			child.emit('close', null, null);
		});
		return child;
	};
	const notices = [];
	const started = await start(clone, { spawn, now: clock().now, notify: (text, level) => notices.push([level, text]) });
	const settled = await started.settled;

	assert.equal(settled.ok, false);
	assert.equal(notices.length, 1);
	assert.match(notices[0][1], /npm ci could not start npm ci: spawn npm ENOENT/);
});

test('the default bound is fifteen minutes', () => {
	assert.equal(WORKTREE_SETUP_TIMEOUT_MS, 15 * 60 * 1000);
});

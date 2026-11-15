'use strict';
// S5: the warm-up reuses a live daemon before starting one, runs `codegraph serve --mcp` bounded through
// CodeGraph's own proxy, never kills a daemon and never holds its caller when it is fired in the background.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exploreOnce, warmUpDaemon, WARMUP_BACKGROUND_LIVE_MS, WARMUP_QUERY } = require('../lib/codegraph-warmup.js');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'daemon-mcp-server.js');
const WARMUP_WORKER = path.join(__dirname, 'fixtures', 'daemon-warmup-worker.js');
const WARMUP_MODULE = require.resolve('../lib/codegraph-warmup.js');

const tempDirs = [];
function scratch(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The command line exploreOnce runs: the same shape as the real one, pointing at the fake server instead. */
function fakeServer(mode) {
  return `"${process.execPath}" "${FAKE_SERVER}" ${mode}`;
}

function write(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** Runs a caller in a fresh process and reports how long it stayed alive and what it printed. */
function run(script, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const killer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ status: code, stdout, stderr, elapsed: Date.now() - started });
    });
  });
}

/** A server that reads its stdin, never answers and lives for ten seconds. */
function hangServer(dir) {
  return write(dir, 'hang.mjs', [
    'import { createInterface } from "node:readline";',
    'createInterface({ input: process.stdin }).on("line", () => {});',
    'setTimeout(() => {}, 10_000);',
    '',
  ].join('\n'));
}

/** A server that answers both calls after `ms`. */
function slowServer(dir, ms) {
  return write(dir, 'slow-server.mjs', [
    'import { createInterface } from "node:readline";',
    'const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const message = JSON.parse(line);',
    `  if (message.id === 1) setTimeout(() => out({ jsonrpc: "2.0", id: 1, result: {} }), ${ms});`,
    `  if (message.id === 2) setTimeout(() => out({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "OK" }] } }), ${ms});`,
    '});',
    '',
  ].join('\n'));
}

function command(script) {
  return `"${process.execPath}" "${script}"`;
}

/** An awaited warm-up: the caller waits for the answer and prints it. */
function awaitedCaller(dir, project, timeoutMs, script) {
  return write(dir, 'caller.js', [
    "'use strict';",
    `const warmup = require(${JSON.stringify(WARMUP_MODULE)});`,
    `warmup.exploreOnce(${JSON.stringify(project)}, "main", ${timeoutMs}, ${JSON.stringify(command(script))}, { project: ${JSON.stringify(project)} })`,
    '  .then((result) => process.stdout.write(JSON.stringify(result) + "\\n"));',
    '',
  ].join('\n'));
}

// --- Bounded, and never fatal ---

test('S5: a timeout resolves false without waiting for the server', async () => {
  const dir = scratch('odd-warm-timeout-');
  const started = Date.now();
  assert.equal(await warmUpDaemon(dir, 1, {
    status: () => 'none',
    command: fakeServer('silent'),
    project: dir,
  }), false);
  assert.ok(Date.now() - started < 5_000);
});

test('S5: a warm-up is skipped while an init runs, so the two never write the index together', async () => {
  const dir = scratch('odd-warm-init-');
  let asked = false;
  assert.equal(await warmUpDaemon(dir, 5_000, {
    initRunning: true,
    status: () => { throw new Error('a skipped warm-up resolves no daemon'); },
    ask: async () => { asked = true; return { status: 'ok', text: 'X' }; },
    command: fakeServer('ok'),
    project: dir,
  }), false);
  assert.equal(asked, false);
});

test('S5: an explore call with a text result is a warm-up', async () => {
  const dir = scratch('odd-warm-fake-');
  const result = await exploreOnce(dir, 'main', 10_000, fakeServer('ok'), { project: dir });
  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(result.exploreMs) && result.exploreMs >= 0);
});

test("S5: a reply with isError is a failed warm-up, so no 'ready' notice is shown", async () => {
  const dir = scratch('odd-warm-fake-');
  const result = await exploreOnce(dir, 'main', 10_000, fakeServer('isError'), { project: dir });
  assert.equal(result.ok, false);
});

test('S5: a reply with no content is a failed warm-up too', async () => {
  const dir = scratch('odd-warm-fake-');
  const result = await exploreOnce(dir, 'main', 10_000, fakeServer('empty'), { project: dir });
  assert.equal(result.ok, false);
});

test("S5: a stuck server's stdout is released, so it cannot keep the process alive after the timeout", async () => {
  const dir = scratch('odd-warm-stuck-');
  const child = spawn(process.execPath, [WARMUP_WORKER, fakeServer('stuck'), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stderr = '';
  let killed = false;
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const guard = setTimeout(() => { killed = true; child.kill(); }, 6_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(guard);
  assert.match(output, /RESULT \{"ok":false/, `stdout ${output} stderr ${stderr}`);
  assert.equal(killed, false, "the worker never exited after the timeout: a stuck server's stdout kept it alive");
  assert.equal(code, 0, stderr);
});

test('S5: the server is started from the temp directory with the project as an argument, never as its cwd', async () => {
  const dir = scratch('odd-warm-cwd-');
  const seen = path.join(dir, 'seen.json');
  const server = write(dir, 'cwd-server.mjs', [
    'import { writeFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    'const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.method === "initialize") {',
    `    writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));`,
    '    out({ jsonrpc: "2.0", id: message.id, result: {} });',
    '  }',
    '  if (message.id === 2) out({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "OK" }] } });',
    '});',
    '',
  ].join('\n'));
  const result = await exploreOnce(dir, 'main', 10_000, command(server), { project: dir });
  assert.equal(result.ok, true);
  const recorder = JSON.parse(fs.readFileSync(seen, 'utf8'));
  const realTmp = fs.realpathSync(os.tmpdir());
  assert.equal(fs.realpathSync(recorder.cwd), realTmp);
  assert.ok(recorder.argv.includes('-p'), JSON.stringify(recorder.argv));
});

// --- S5: reuse the checkout's live daemon before warming one ---

test('S5: a live daemon of this checkout is reused for the warm-up instead of spawning a server', async () => {
  // This directory has no index: a spawn here cannot succeed, so a true result proves the daemon was reused.
  const dir = scratch('odd-warm-reuse-');
  const asked = [];
  const reused = await warmUpDaemon(dir, 5_000, {
    status: () => 'live',
    ask: async (root, query) => { asked.push({ root, query }); return { status: 'ok', text: 'WARM' }; },
    command: fakeServer('silent'),
    project: dir,
  });
  assert.equal(reused, true);
  assert.deepEqual(asked, [{ root: dir, query: WARMUP_QUERY }], 'the live daemon is asked once, for this checkout');
});

test('S5: a live daemon that does not answer is not doubled by a second server', async () => {
  const dir = scratch('odd-warm-timeout-live-');
  let asked = 0;
  const started = Date.now();
  const warmed = await warmUpDaemon(dir, 3_000, {
    status: () => 'live',
    ask: async () => { asked += 1; return { status: 'timeout' }; },
    // A server that would answer at once: a second server is never started, so this stays unanswered.
    command: fakeServer('ok'),
    project: dir,
  });
  assert.equal(warmed, false);
  assert.equal(asked, 1);
  assert.ok(Date.now() - started < 2_000, 'the caller did not wait for a spawn that must not happen');
});

test('S5: with no live daemon for this checkout, nothing is asked and the server path runs', async () => {
  const dir = scratch('odd-warm-none-live-');
  let asked = false;
  assert.equal(await warmUpDaemon(dir, 50, {
    status: () => 'none',
    ask: async () => { asked = true; return { status: 'ok', text: 'X' }; },
    command: fakeServer('silent'),
    project: dir,
  }), false);
  assert.equal(asked, false, 'a checkout with no live daemon has nothing to ask');
});

test('S5: a background warm-up reusing a live daemon stays short, so it never holds its caller', async () => {
  const dir = scratch('odd-warm-bg-live-');
  let budget = -1;
  const warmed = await warmUpDaemon(dir, 120_000, {
    background: true,
    status: () => 'live',
    ask: async (_root, _query, ms) => { budget = ms; return { status: 'ok', text: 'WARM' }; },
    project: dir,
  });
  assert.equal(warmed, true);
  assert.ok(budget > 0 && budget <= WARMUP_BACKGROUND_LIVE_MS, `asked with ${budget} ms`);
});

// --- A background warm-up must never keep its caller alive; an awaited one must still hold on ---

test('S5: a pending background warm-up never keeps its caller alive', async () => {
  const dir = scratch('odd-warm-bg-hang-');
  const script = write(dir, 'caller.js', [
    "'use strict';",
    `const warmup = require(${JSON.stringify(WARMUP_MODULE)});`,
    `warmup.exploreOnce(${JSON.stringify(dir)}, "main", 60_000, ${JSON.stringify(command(hangServer(dir)))}, { background: true, project: ${JSON.stringify(dir)} });`,
    '',
  ].join('\n'));
  const result = await run(script);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsed < 5_000, `the caller stayed alive ${result.elapsed} ms`);
});

test('S5: an awaited warm-up still waits for its own timeout on a server that never answers', async () => {
  const dir = scratch('odd-warm-bg-default-');
  const script = awaitedCaller(dir, dir, 3_000, hangServer(dir));
  const result = await run(script);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsed >= 2_500, `the default mode left after ${result.elapsed} ms instead of waiting for its own timer`);
  assert.match(result.stdout, /"ok":false/);
});

test('S5: an awaited warm-up keeps the process until the server answers', async () => {
  const dir = scratch('odd-warm-bg-awaited-');
  const script = awaitedCaller(dir, dir, 15_000, slowServer(dir, 500));
  const result = await run(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok":true/);
});

test('S5: a background warm-up still reads its server while the caller is alive', async () => {
  const dir = scratch('odd-warm-bg-slow-');
  const script = write(dir, 'caller.js', [
    "'use strict';",
    `const warmup = require(${JSON.stringify(WARMUP_MODULE)});`,
    'const keep = setTimeout(() => {}, 20_000);',
    `warmup.exploreOnce(${JSON.stringify(dir)}, "main", 15_000, ${JSON.stringify(command(slowServer(dir, 400)))}, { background: true, project: ${JSON.stringify(dir)} })`,
    '  .then((result) => { clearTimeout(keep); process.stdout.write(JSON.stringify(result) + "\\n"); });',
    '',
  ].join('\n'));
  const result = await run(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok":true/);
});

test('S5: closing the warm-up hands the server every message, in order', async () => {
  const dir = scratch('odd-warm-bg-eof-');
  const log = path.join(dir, 'seen.log');
  const server = write(dir, 'order-server.mjs', [
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    'const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
    'const seen = [];',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  seen.push(message.method ?? "id" + message.id);',
    '  if (message.id === 1) out({ jsonrpc: "2.0", id: 1, result: {} });',
    '  if (message.id === 2) { appendFileSync(process.env.SEEN, JSON.stringify({ seen }) + "\\n"); out({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "OK" }] } }); }',
    '});',
    '',
  ].join('\n'));
  const script = awaitedCaller(dir, dir, 10_000, server);
  const result = await run(script, { SEEN: log });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok":true/);
  const first = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
  assert.deepEqual(first.seen, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('S5: a warm-up that cannot start a child resolves false instead of throwing', async () => {
  const dir = scratch('odd-warm-nospawn-');
  assert.equal(await exploreOnce(dir, 'main', 1_000, fakeServer('ok'), {
    project: dir,
    spawn: () => { throw new Error('ENOENT'); },
  }).then((result) => result.ok), false);
});

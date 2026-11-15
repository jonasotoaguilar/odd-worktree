'use strict';
// S5: a checkout's daemon is resolved from CodeGraph's own registry — per checkout, with no help from the MCP
// configuration — and asked over its own socket, with every failure answer instead of a throw.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DAEMON_HELLO_TIMEOUT_MS,
  DAEMON_PROTOCOL,
  daemonStatus,
  exploreViaDaemon,
  liveDaemon,
  normalizeRoot,
  projectArgument,
  registeredRoot,
} = require('../lib/codegraph-daemon.js');
const { fakeDaemon, registry, scratch, socketPath, cleanup } = require('./fixtures/daemon-fake.js');

after(cleanup);

const ROOT = scratch('odd-daemon-root-');

// --- The protocol, over a real socket and a real registry ---

test('S5: asks the daemon registered for the project and returns its text', async () => {
  const received = [];
  const daemon = await fakeDaemon({ received });
  const result = await exploreViaDaemon(ROOT, 'coapi login flow', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
  assert.deepEqual(result, { status: 'ok', text: 'FAKE EXPLORE OUTPUT' });
  const call = JSON.parse(received.find((line) => line.includes('tools/call')));
  assert.equal(call.params.name, 'codegraph_explore');
  assert.deepEqual(call.params.arguments, { query: 'coapi login flow' });
  // The conversation opens with the initialize request the daemon expects, and says hello first.
  assert.equal(JSON.parse(received[0]).method, 'initialize');
});

test('S5: a reply that arrives in pieces is put back together', async () => {
  const daemon = await fakeDaemon({ explore: { split: 'SPLIT OUTPUT' } });
  const result = await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
  assert.deepEqual(result, { status: 'ok', text: 'SPLIT OUTPUT' });
});

test('S5: a hello with another protocol is refused before anything else is said', async () => {
  const received = [];
  const daemon = await fakeDaemon({ hello: JSON.stringify({ codegraph: '9.9.9', pid: 1, protocol: DAEMON_PROTOCOL + 1 }), received });
  const result = await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
  assert.deepEqual(result, { status: 'unavailable' });
  assert.deepEqual(received, []);
});

test('S5: a hello that is not JSON or lacks fields is unavailable, never a throw', async () => {
  for (const hello of ['not json', JSON.stringify({ protocol: DAEMON_PROTOCOL })]) {
    const daemon = await fakeDaemon({ hello });
    const result = await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
    assert.deepEqual(result, { status: 'unavailable' }, hello);
  }
});

test('S5: a daemon that hangs up right after the hello is unavailable', async () => {
  const daemon = await fakeDaemon({ explore: { closeAfterHello: true } });
  assert.deepEqual(
    await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) }),
    { status: 'unavailable' },
  );
});

test("S5: an error reply, or CodeGraph's 'no project' text, is unavailable", async () => {
  for (const explore of [{ error: 'boom' }, { text: 'No CodeGraph project is loaded for this session.' }]) {
    const daemon = await fakeDaemon({ explore });
    const result = await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
    assert.deepEqual(result, { status: 'unavailable' }, JSON.stringify(explore));
  }
});

test('S5: an MCP reply with isError is unavailable, so its text is never used as a result', async () => {
  // CodeGraph answers a crashed query worker this way: a text result, flagged as an error.
  const daemon = await fakeDaemon({ explore: { text: 'codegraph worker crashed; please retry the call.', isError: true } });
  assert.deepEqual(
    await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) }),
    { status: 'unavailable' },
  );
});

test('S5: output beyond the cap is unavailable, so nothing is kept instead of memory growing', async () => {
  const daemon = await fakeDaemon({ explore: { text: 'x'.repeat(1_500_000) } });
  assert.deepEqual(
    await exploreViaDaemon(ROOT, 'q', 10_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) }),
    { status: 'unavailable' },
  );
});

test('S5: a daemon that never answers is a timeout, reported on time', async () => {
  const daemon = await fakeDaemon({ explore: 'silence' });
  const started = Date.now();
  const result = await exploreViaDaemon(ROOT, 'q', 400, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
  assert.deepEqual(result, { status: 'timeout' });
  assert.ok(Date.now() - started < 3_000);
});

test('S5: a daemon that never says hello gives way to the next one instead of using the whole budget', async () => {
  const silent = await fakeDaemon({ hello: null });
  const live = await fakeDaemon({});
  const started = Date.now();
  const result = await exploreViaDaemon(ROOT, 'q', 10_000, {
    registryDir: registry([
      { root: ROOT, socketPath: silent.path, startedAt: 2 },
      { root: ROOT, socketPath: live.path, startedAt: 1 },
    ]),
  });
  assert.deepEqual(result, { status: 'ok', text: 'FAKE EXPLORE OUTPUT' });
  assert.ok(Date.now() - started < DAEMON_HELLO_TIMEOUT_MS + 2_000, `took ${Date.now() - started} ms`);
});

test('S5: when the only daemon never says hello, it is a timeout after the hello wait, not after the whole budget', async () => {
  const silent = await fakeDaemon({ hello: null });
  const started = Date.now();
  const result = await exploreViaDaemon(ROOT, 'q', 10_000, { registryDir: registry([{ root: ROOT, socketPath: silent.path }]) });
  assert.deepEqual(result, { status: 'timeout' });
  const took = Date.now() - started;
  assert.ok(took >= DAEMON_HELLO_TIMEOUT_MS - 50 && took < DAEMON_HELLO_TIMEOUT_MS + 2_000, `took ${took} ms`);
});

test("S5: no registry, an empty one, or another project's daemon is unavailable", async () => {
  const daemon = await fakeDaemon({});
  const other = scratch('odd-daemon-other-');
  assert.deepEqual(
    await exploreViaDaemon(ROOT, 'q', 2_000, { registryDir: path.join(ROOT, 'does-not-exist') }),
    { status: 'unavailable' },
  );
  assert.deepEqual(await exploreViaDaemon(ROOT, 'q', 2_000, { registryDir: registry([]) }), { status: 'unavailable' });
  assert.deepEqual(
    await exploreViaDaemon(ROOT, 'q', 2_000, { registryDir: registry([{ root: other, socketPath: daemon.path }]) }),
    { status: 'unavailable' },
  );
});

test('S5: a registry entry whose daemon is gone is unavailable; with several entries a live one is still found', async () => {
  const dead = socketPath('odd-daemon-dead');
  assert.deepEqual(await exploreViaDaemon(ROOT, 'q', 2_000, { registryDir: registry([{ root: ROOT, socketPath: dead }]) }), { status: 'unavailable' });
  const live = await fakeDaemon({});
  for (const entries of [
    [{ root: ROOT, socketPath: dead, startedAt: 2 }, { root: ROOT, socketPath: live.path, startedAt: 1 }],
    [{ root: ROOT, socketPath: live.path, startedAt: 2 }, { root: ROOT, socketPath: dead, startedAt: 1 }],
  ]) {
    const result = await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry(entries) });
    assert.equal(result.status, 'ok');
  }
});

test('S5: the project root matches whatever its spelling: a trailing separator, and on Windows letter case', () => {
  assert.equal(normalizeRoot(`${ROOT}${path.sep}`), normalizeRoot(ROOT));
  if (process.platform === 'win32') {
    assert.equal(normalizeRoot(ROOT.toUpperCase()), normalizeRoot(ROOT.toLowerCase()));
  } else {
    assert.notEqual(normalizeRoot(ROOT.toUpperCase()), normalizeRoot(ROOT));
  }
});

test('S5: a trailing separator in the registry still resolves to the checkout', async () => {
  const daemon = await fakeDaemon({});
  const result = await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir: registry([{ root: `${ROOT}${path.sep}`, socketPath: daemon.path }]) });
  assert.equal(result.status, 'ok');
});

// --- S5: the daemon of one checkout, resolved from that checkout only, never from MCP configuration ---

test("S5: a checkout's live registered daemon is reported with its socket, and its status is live", async () => {
  const daemon = await fakeDaemon({});
  const registryDir = registry([{ root: ROOT, socketPath: daemon.path, startedAt: 7 }]);
  assert.deepEqual(liveDaemon(ROOT, { registryDir }), { root: ROOT, socketPath: daemon.path, pid: process.pid });
  assert.equal(daemonStatus(ROOT, { registryDir }), 'live');
});

test('S5: a record whose daemon is gone is dead, an empty registry is none, and neither is a live daemon', () => {
  const dead = socketPath('odd-daemon-gone');
  assert.equal(daemonStatus(ROOT, { registryDir: registry([{ root: ROOT, socketPath: dead }]) }), 'dead');
  assert.equal(daemonStatus(ROOT, { registryDir: registry([]) }), 'none');
  assert.equal(daemonStatus(ROOT, { registryDir: path.join(ROOT, 'no-registry-here') }), 'none');
  assert.equal(liveDaemon(ROOT, { registryDir: registry([{ root: ROOT, socketPath: dead }]) }), undefined);
});

test('S5: a record whose process is gone is dead, whatever its socket says', async () => {
  const daemon = await fakeDaemon({});
  const registryDir = registry([{ root: ROOT, socketPath: daemon.path }]);
  const alive = { alive: () => false };
  assert.equal(daemonStatus(ROOT, { registryDir, ...alive }), 'dead');
  assert.equal(liveDaemon(ROOT, { registryDir, ...alive }), undefined);
  assert.equal(daemonStatus(ROOT, { registryDir }), 'live');
});

test("S5: a worktree is its own checkout: its parent's daemon is never its own", async () => {
  const parent = scratch('odd-daemon-parent-');
  const child = scratch('odd-daemon-child-');
  const daemon = await fakeDaemon({});
  const registryDir = registry([{ root: parent, socketPath: daemon.path }]);
  assert.equal(daemonStatus(child, { registryDir }), 'none');
  assert.equal(liveDaemon(child, { registryDir }), undefined);
  assert.equal(registeredRoot(child, { registryDir }), undefined, "the parent's spelling is never handed to a child");
  assert.equal(projectArgument(child, { registryDir }), child);
  assert.deepEqual(await exploreViaDaemon(child, 'q', 2_000, { registryDir }), { status: 'unavailable' });
});

test('S5: an MCP server entry is not evidence of a reachable daemon', () => {
  // A checkout whose MCP configuration names the CodeGraph server, and whose daemon registry says nothing.
  const checkout = scratch('odd-daemon-mcp-');
  fs.writeFileSync(
    path.join(checkout, 'mcp.json'),
    JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } } }),
  );
  assert.equal(daemonStatus(checkout, { registryDir: registry([]) }), 'none');
  assert.equal(liveDaemon(checkout, { registryDir: registry([]) }), undefined);
});

test('S5: a live daemon needs no MCP entry to be resolved and used', async () => {
  const daemon = await fakeDaemon({});
  const registryDir = registry([{ root: ROOT, socketPath: daemon.path }]);
  assert.equal(daemonStatus(ROOT, { registryDir }), 'live');
  assert.deepEqual(await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir }), { status: 'ok', text: 'FAKE EXPLORE OUTPUT' });
});

test('S5: the registry is only read: a bad record is skipped and the directory is left as it was', async () => {
  const daemon = await fakeDaemon({});
  const registryDir = registry([{ root: ROOT, socketPath: daemon.path }]);
  fs.writeFileSync(path.join(registryDir, 'damaged.json'), 'not json');
  const before = fs.readdirSync(registryDir).sort();
  assert.equal(daemonStatus(ROOT, { registryDir }), 'live');
  assert.deepEqual(fs.readdirSync(registryDir).sort(), before);
  assert.deepEqual(await exploreViaDaemon(ROOT, 'q', 5_000, { registryDir }), { status: 'ok', text: 'FAKE EXPLORE OUTPUT' });
});

// --- The clock and the connection are seams, so no daemon is started here ---

test('S5: a registry that cannot be read is no daemon at all, and nothing throws', () => {
  const unreadable = { readdirSync: () => { throw new Error('EACCES'); } };
  assert.equal(daemonStatus(ROOT, { registryDir: ROOT, fs: unreadable }), 'none');
  assert.equal(liveDaemon(ROOT, { registryDir: ROOT, fs: unreadable }), undefined);
});

test('S5: explore reports unavailable when the connection itself fails, and never throws', async () => {
  const connect = () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(
    await exploreViaDaemon(ROOT, 'q', 1_000, { registryDir: registry([{ root: ROOT, socketPath: socketPath('odd-daemon-nowhere') }]), connect }),
    { status: 'unavailable' },
  );
});

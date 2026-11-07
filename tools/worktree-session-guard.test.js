'use strict';
// S7/S8/S9: lib/worktree-session-guard.js — the ONE active-session guard the
// `worktree_close` tool and the warp panel's Ctrl+D both run.
//
// Gentle Shell publishes its session presence store under
// `<agent home>/gentle-agents/presence`: a bounded `<sessionHash>.<incarnation>
// .header.json` heartbeat plus an optional discovery sidecar carrying the
// session's workspace (`orchestrator-presence.ts`). The guard consumes that
// published metadata — never a session's transcript — and answers one question
// per checkout: is a live Pi session working there?
//
// What is pinned here:
//   - only RECENT heartbeats count as live (upstream's 15 s TTL), and a
//     heartbeat stamped in the future is not recent either;
//   - the current session is recognised by the hash of its own id and by the
//     cwd it stands on, and both refuse with "warp first";
//   - a foreign live session refuses and names the identity the store
//     publishes (label + session hash prefix; the raw session id is never
//     published there);
//   - a stale or unreadable record is DISCLOSED, never silently promoted to a
//     block and never silently dropped: Gentle Shell's store is bounded, its
//     files can outlive a crashed session, and this guard is best effort;
//   - the scan is bounded, refuses a linked presence directory or a linked
//     record, and never writes, moves or deletes anything.
//
// Every fixture is a throwaway agent home under the system temp directory:
// nothing here reads the developer's real presence store or a real checkout.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../lib/worktree-session-guard.js');

const NOW = 1_700_000_000_000;
const roots = [];

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function agentHome() {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-guard-home-')));
}

function checkout(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-guard-${tag}-`)));
  return fs.realpathSync(dir);
}

const hash = (id) => crypto.createHash('sha256').update(id).digest('hex');
const incarnation = (n) => `0000000${n % 16}-0000-4000-8000-00000000000${n % 16}`;

function presenceDir(home) {
  return path.join(home, 'gentle-agents', 'presence');
}

// One published session: the header heartbeat plus the discovery sidecar that
// carries its workspace. `discovery: false` writes a header-only (legacy) peer.
function publish(home, {
  sessionId = 'session-1', label = 'Worker', workspace = null,
  heartbeat = NOW, incarnationIndex = 1, generation = 3, discovery = true,
} = {}) {
  const dir = presenceDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* explicit mode is best effort */ }
  const inc = incarnation(incarnationIndex);
  const sessionHash = hash(sessionId);
  const header = {
    schema: 1,
    sessionHash,
    incarnation: inc,
    label,
    heartbeat,
    generation,
    counts: { running: 0, queued: 0, waiting: 0, finished: 0 },
    digest: 'a'.repeat(64),
    unavailable: null,
  };
  fs.writeFileSync(path.join(dir, `${sessionHash}.${inc}.header.json`), JSON.stringify(header));
  if (discovery) {
    fs.writeFileSync(
      path.join(dir, `${sessionHash}.${inc}.discovery.json`),
      JSON.stringify({
        schema: 1,
        sessionHash,
        incarnation: inc,
        generation,
        metadata: { activation: 'b'.repeat(64), workspace: workspace ?? '', tasks: [], omitted: 0 },
      }),
    );
  }
  return { sessionHash, incarnation: inc, label };
}

// One transport activation: `<agent home>/gentle-agents/transport/presence/
// <sessionId>.<22-char token>.json` with the four published keys. This is the
// ONLY place a raw session id is published, and it is what the guard joins the
// presence hash to.
const TRANSPORT_TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
function publishTransport(home, {
  sessionId = 'worker-9', token = TRANSPORT_TOKEN, createdAt = NOW - 1000, record = null,
} = {}) {
  const dir = path.join(home, 'gentle-agents', 'transport', 'presence');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.join(home, 'gentle-agents'), 0o700);
    fs.chmodSync(path.join(home, 'gentle-agents', 'transport'), 0o700);
    fs.chmodSync(dir, 0o700);
  } catch { /* explicit modes are best effort */ }
  const body = record ?? {
    version: 1,
    sessionId,
    endpoint: `/tmp/gentle-pi-1000/0123456789abcdef0123456789abcdef/${token}.sock`,
    createdAt,
  };
  const file = path.join(dir, `${sessionId}.${token}.json`);
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

async function verdictFor(target, options = {}) {
  const home = options.home ?? agentHome();
  const env = { PI_CODING_AGENT_DIR: home };
  const presence = await guard.readGentlePresence({ env, now: NOW, maxEntries: options.maxEntries });
  const transport = await guard.readTransportSessions({ env, maxEntries: options.maxTransportEntries });
  return guard.evaluateCheckoutSessions({
    targetPath: target,
    presence,
    transport,
    currentSessionId: options.currentSessionId ?? null,
    currentCwd: options.currentCwd ?? null,
    now: NOW,
  });
}

describe('readGentlePresence: bounded, validated, read-only', () => {
  test('no presence directory is reported as unavailable evidence', async () => {
    const home = agentHome();
    const read = await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW });
    assert.equal(read.status, 'unavailable');
    assert.equal(read.entries.length, 0);
  });

  test('a published session is read with its workspace and recency', async () => {
    const home = agentHome();
    const target = checkout('live');
    const published = publish(home, { sessionId: 'a', label: 'Alpha', workspace: target, heartbeat: NOW - 1000 });
    const read = await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW });
    assert.equal(read.status, 'ok');
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].sessionHash, published.sessionHash);
    assert.equal(read.entries[0].label, 'Alpha');
    assert.equal(read.entries[0].workspace, target);
    assert.equal(read.entries[0].recent, true);
  });

  test('a heartbeat older than the TTL, or stamped in the future, is not recent', async () => {
    const home = agentHome();
    const target = checkout('stale');
    publish(home, { sessionId: 'old', workspace: target, heartbeat: NOW - guard.PRESENCE_FRESH_MS - 1 });
    publish(home, { sessionId: 'future', workspace: target, heartbeat: NOW + 5000, incarnationIndex: 2 });
    const read = await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW });
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.entries.map((entry) => entry.recent).sort(), [false, false]);
  });

  test('a linked presence directory is refused instead of followed', async () => {
    const home = agentHome();
    const elsewhere = agentHome();
    publish(elsewhere, { sessionId: 'a', workspace: checkout('link'), heartbeat: NOW });
    const shared = path.join(home, 'gentle-agents');
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    try { fs.symlinkSync(presenceDir(elsewhere), presenceDir(home), 'dir'); } catch { return; }
    const read = await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW });
    assert.equal(read.status, 'unavailable');
    assert.match(read.reason, /symbolic|link/i);
  });

  test('a malformed header, a linked header and a directory named like one are rejected, never thrown', async () => {
    const home = agentHome();
    const target = checkout('junk');
    const good = publish(home, { sessionId: 'good', workspace: target, heartbeat: NOW });
    const dir = presenceDir(home);
    const malformed = hash('bad');
    fs.writeFileSync(path.join(dir, `${malformed}.${incarnation(2)}.header.json`), '{"schema":1}');
    const linked = hash('linked');
    const linkSource = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-guard-src-'))), 'header.json');
    fs.writeFileSync(linkSource, JSON.stringify({ schema: 1 }));
    try {
      fs.symlinkSync(linkSource, path.join(dir, `${linked}.${incarnation(3)}.header.json`));
    } catch { /* a host without symlinks skips that half */ }
    fs.mkdirSync(path.join(dir, `${hash('folder')}.${incarnation(4)}.header.json`), { recursive: true });

    const read = await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW });
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.entries.map((entry) => entry.sessionHash), [good.sessionHash]);
    assert.ok(read.rejected >= 2, `every unusable record is counted, not thrown: ${read.rejected}`);
  });

  test('the scan is bounded and says so instead of reading forever', async () => {
    const home = agentHome();
    for (let index = 1; index <= 5; index += 1) {
      publish(home, { sessionId: `s${index}`, workspace: checkout(`bounded-${index}`), heartbeat: NOW, incarnationIndex: index });
    }
    const read = await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW, maxEntries: 2 });
    assert.equal(read.status, 'ok');
    assert.equal(read.entries.length, 2);
    assert.equal(read.truncated, true);
  });

  test('reading publishes nothing and removes nothing', async () => {
    const home = agentHome();
    const target = checkout('readonly');
    publish(home, { sessionId: 'a', workspace: target, heartbeat: NOW });
    const dir = presenceDir(home);
    const snapshot = () => fs.readdirSync(dir).sort()
      .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
    const before = snapshot();
    await guard.readGentlePresence({ env: { PI_CODING_AGENT_DIR: home }, now: NOW });
    assert.deepEqual(snapshot(), before);
  });
});

describe('evaluateCheckoutSessions: who is working in the checkout', () => {
  test('a live session in an unrelated checkout never blocks', async () => {
    const home = agentHome();
    const target = checkout('mine');
    publish(home, { sessionId: 'elsewhere', workspace: checkout('other'), heartbeat: NOW });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'clear');
    assert.equal(result.text, null);
  });

  test('a live foreign session refuses and names the published identity', async () => {
    const home = agentHome();
    const target = checkout('foreign');
    const published = publish(home, { sessionId: 'worker-9', label: 'Worker', workspace: target, heartbeat: NOW - 2000 });
    const result = await verdictFor(target, { home, currentSessionId: 'mine' });
    assert.equal(result.verdict, 'foreign');
    assert.match(result.text, /working in that checkout/);
    assert.ok(result.text.includes('Worker'), result.text);
    assert.ok(result.text.includes(published.sessionHash.slice(0, 12)), result.text);
    assert.match(result.text, /finish/);
    assert.match(result.text, /\/warp/);
    assert.match(result.text, /left untouched/);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].kind, 'foreign');
  });

  test('several live foreign sessions are all named, bounded', async () => {
    const home = agentHome();
    const target = checkout('crowd');
    for (let index = 1; index <= 4; index += 1) {
      publish(home, { sessionId: `w${index}`, label: `W${index}`, workspace: target, heartbeat: NOW, incarnationIndex: index });
    }
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers.length, 4);
    assert.match(result.text, /and 1 more/);
  });

  test('this session is recognised by the hash of its own id and told to warp first', async () => {
    const home = agentHome();
    const target = checkout('current');
    publish(home, { sessionId: 'mine', label: 'Me', workspace: target, heartbeat: NOW });
    const result = await verdictFor(target, { home, currentSessionId: 'mine' });
    assert.equal(result.verdict, 'current');
    assert.match(result.text, /this session is working in that checkout/);
    assert.match(result.text, /warp/i);
    assert.match(result.text, /left untouched/);
  });

  test('this session is caught by its cwd even with no presence at all', async () => {
    const home = agentHome();
    const target = checkout('cwd');
    const result = await verdictFor(target, { home, currentSessionId: 'mine', currentCwd: path.join(target, 'packages', 'app') });
    assert.equal(result.verdict, 'current');
    assert.match(result.text, /warp/i);
  });

  test('a session inside a SUBDIRECTORY of the checkout counts as working there', async () => {
    const home = agentHome();
    const target = checkout('sub');
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    publish(home, { sessionId: 'worker', label: 'W', workspace: path.join(target, 'src'), heartbeat: NOW });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'foreign');
  });

  test('a sibling checkout sharing a name prefix is a different checkout', async () => {
    const home = agentHome();
    const parent = checkout('prefix');
    const target = path.join(parent, 'feat-doomed');
    const sibling = path.join(parent, 'feat-doomed-other');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    publish(home, { sessionId: 'worker', label: 'W', workspace: sibling, heartbeat: NOW });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'clear');
  });

  test('a stale record is disclosed, never promoted to a live session', async () => {
    const home = agentHome();
    const target = checkout('stalematch');
    publish(home, { sessionId: 'gone', label: 'Gone', workspace: target, heartbeat: NOW - guard.PRESENCE_FRESH_MS - 1 });
    const result = await verdictFor(target, { home, currentSessionId: 'mine' });
    assert.equal(result.verdict, 'clear');
    assert.equal(result.blockers.length, 0);
    assert.equal(result.stale.length, 1);
    assert.match(result.notice, /stale/);
    assert.match(result.notice, /best effort/i);
  });

  test('a header whose discovery sidecar is missing or has no usable workspace is unknown evidence', async () => {
    const home = agentHome();
    const target = checkout('legacy');
    publish(home, { sessionId: 'legacy', label: 'Legacy', workspace: target, heartbeat: NOW, discovery: false });
    publish(home, { sessionId: 'empty', label: 'Empty', workspace: '', heartbeat: NOW, incarnationIndex: 2 });
    publish(home, { sessionId: 'relative', label: 'Relative', workspace: 'relative/path', heartbeat: NOW, incarnationIndex: 3 });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'clear', 'an unknown workspace can never be attributed to this checkout');
    assert.equal(result.blockers.length, 0);
    assert.ok(result.evidence.unknown >= 3, JSON.stringify(result.evidence));
  });

  test('a missing presence store is silent (best effort), a broken one is disclosed', async () => {
    const home = agentHome();
    const target = checkout('quiet');
    const absent = await verdictFor(target, { home });
    assert.equal(absent.verdict, 'clear');
    assert.equal(absent.notice, null);

    const brokenHome = agentHome();
    fs.mkdirSync(path.join(brokenHome, 'gentle-agents'), { recursive: true });
    fs.writeFileSync(presenceDir(brokenHome), 'not a directory');
    const broken = await verdictFor(target, { home: brokenHome });
    assert.equal(broken.verdict, 'clear');
    assert.match(broken.notice, /best effort/i);
  });

  test('the verdict is stable and the returned details carry no raw session content', async () => {
    const home = agentHome();
    const target = checkout('shape');
    const published = publish(home, { sessionId: 'worker', label: 'Worker', workspace: target, heartbeat: NOW });
    const result = await verdictFor(target, { home });
    assert.deepEqual(Object.keys(result).sort(), ['blockers', 'evidence', 'notice', 'notices', 'stale', 'text', 'verdict']);
    assert.deepEqual(result.blockers[0].label, 'Worker');
    assert.equal(result.blockers[0].sessionHash, published.sessionHash);
    assert.equal(JSON.stringify(result.evidence).includes('Worker'), false, 'the evidence counts carry no session text');
  });
});

describe('S7: a refusal names the RAW session id, joined through transport', () => {
  test('a live foreign session is named by the id Gentle Shell published for it', async () => {
    const home = agentHome();
    const target = checkout('joined');
    const published = publish(home, { sessionId: 'worker-9', label: 'Worker', workspace: target, heartbeat: NOW });
    publishTransport(home, { sessionId: 'worker-9' });
    const result = await verdictFor(target, { home, currentSessionId: 'mine' });
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, 'worker-9');
    assert.ok(result.text.includes('id worker-9'), result.text);
    assert.equal(result.text.includes(published.sessionHash.slice(0, 12)), false, 'the hash is not used when the id resolves');
    assert.equal(result.text.includes('could not be resolved'), false);
    assert.equal(result.evidence.resolved, 1);
    assert.equal(result.evidence.unresolved, 0);
  });

  test('the join is deterministic: only the matching transport record names the hash', async () => {
    const home = agentHome();
    const target = checkout('deterministic');
    publish(home, { sessionId: 'worker-9', label: 'Worker', workspace: target, heartbeat: NOW });
    publishTransport(home, { sessionId: 'someone-else', token: 'ZbCdEfGhIjKlMnOpQrStUv' });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, null);
    assert.match(result.text, /could not be resolved/);
    assert.equal(result.text.includes('someone-else'), false, 'another session never lends its id');
  });

  test('with no transport record the refusal shows the presence hash and discloses the fallback', async () => {
    const home = agentHome();
    const target = checkout('unjoined');
    const published = publish(home, { sessionId: 'worker-9', label: 'Worker', workspace: target, heartbeat: NOW });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, null);
    assert.ok(result.text.includes(published.sessionHash.slice(0, 12)), result.text);
    assert.match(result.text, /could not be resolved/);
    assert.match(result.text, /presence/);
    assert.equal(result.evidence.unresolved, 1);
  });

  test('the current session still refuses with warp guidance, joined or not', async () => {
    const joinedHome = agentHome();
    const target = checkout('current-joined');
    publish(joinedHome, { sessionId: 'mine', label: 'Me', workspace: target, heartbeat: NOW });
    publishTransport(joinedHome, { sessionId: 'mine' });
    const joined = await verdictFor(target, { home: joinedHome, currentSessionId: 'mine' });
    assert.equal(joined.verdict, 'current');
    assert.match(joined.text, /this session is working in that checkout/);
    assert.match(joined.text, /warp/i);

    const plainHome = agentHome();
    const plainTarget = checkout('current-plain');
    publish(plainHome, { sessionId: 'mine', label: 'Me', workspace: plainTarget, heartbeat: NOW });
    const plain = await verdictFor(plainTarget, { home: plainHome, currentSessionId: 'mine' });
    assert.equal(plain.verdict, 'current');
    assert.match(plain.text, /warp/i);
  });

  test('a malformed, mismatched, linked or non-private transport record never joins', async () => {
    const home = agentHome();
    const target = checkout('transport-junk');
    publish(home, { sessionId: 'worker-9', label: 'Worker', workspace: target, heartbeat: NOW });
    const dir = path.join(home, 'gentle-agents', 'transport', 'presence');
    // A record whose filename says worker-9 but whose body names another session.
    publishTransport(home, { sessionId: 'worker-9', record: { version: 1, sessionId: 'impostor', endpoint: '/tmp/x.sock', createdAt: NOW } });
    // A body with an unexpected key.
    publishTransport(home, { sessionId: 'worker-9', token: 'CbCdEfGhIjKlMnOpQrStUv', record: { version: 1, sessionId: 'worker-9', endpoint: '/tmp/x.sock', createdAt: NOW, extra: 1 } });
    // A symbolic link named like a record.
    const linkSource = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-guard-transport-src-'))), 'record.json');
    fs.writeFileSync(linkSource, JSON.stringify({ version: 1, sessionId: 'worker-9', endpoint: '/tmp/x.sock', createdAt: NOW }));
    try {
      fs.symlinkSync(linkSource, path.join(dir, `worker-9.DdCdEfGhIjKlMnOpQrStUv.json`));
    } catch { /* a host without symlinks skips that half */ }

    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'foreign');
    assert.equal(result.blockers[0].rawSessionId, null, 'no malformed record is trusted');
    assert.match(result.text, /could not be resolved/);
  });

  test('a transport scan over its bound is disclosed and never joins on partial evidence', async () => {
    const home = agentHome();
    const target = checkout('transport-bound');
    publish(home, { sessionId: 'worker-9', label: 'Worker', workspace: target, heartbeat: NOW });
    for (const [index, token] of ['EbCdEfGhIjKlMnOpQrStUv', 'FbCdEfGhIjKlMnOpQrStUv'].entries()) {
      publishTransport(home, { sessionId: `other-${index}`, token });
    }
    const read = await guard.readTransportSessions({ env: { PI_CODING_AGENT_DIR: home }, maxEntries: 1 });
    assert.equal(read.status, 'ok');
    assert.equal(read.sessionIds.length, 1);
    assert.equal(read.truncated, true);
    const result = await verdictFor(target, { home, maxTransportEntries: 1 });
    assert.equal(result.verdict, 'foreign');
    assert.match(result.text, /could not be resolved/);
    assert.match(result.text, /bounded transport scan/, 'a stopped scan never claims the peer published nothing');
    assert.equal(/published no transport record/.test(result.text), false);
  });

  test('reading the transport registry publishes and removes nothing', async () => {
    const home = agentHome();
    publishTransport(home, { sessionId: 'worker-9' });
    const dir = path.join(home, 'gentle-agents', 'transport', 'presence');
    const snapshot = () => fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
    const before = snapshot();
    await guard.readTransportSessions({ env: { PI_CODING_AGENT_DIR: home } });
    assert.deepEqual(snapshot(), before);
  });
});

describe('advisory: unattributable and truncated evidence is disclosed, never blocking', () => {
  test('a live record with no published workspace is disclosed in the clear path', async () => {
    const home = agentHome();
    const target = checkout('advisory-unknown');
    publish(home, { sessionId: 'legacy-peer', label: 'Legacy', workspace: target, heartbeat: NOW, discovery: false });
    const result = await verdictFor(target, { home });
    assert.equal(result.verdict, 'clear');
    assert.ok(result.notices.some((line) => /published no workspace/.test(line)), JSON.stringify(result.notices));
    assert.match(result.notice, /best effort|published no workspace/);
  });

  test('a truncated presence scan is disclosed in the clear path', async () => {
    const home = agentHome();
    const target = checkout('advisory-truncated');
    for (let index = 1; index <= 3; index += 1) {
      publish(home, { sessionId: `peer-${index}`, label: `P${index}`, workspace: checkout(`adv-${index}`), heartbeat: NOW, incarnationIndex: index });
    }
    const result = await verdictFor(target, { home, maxEntries: 1 });
    assert.equal(result.verdict, 'clear');
    assert.ok(result.notices.some((line) => /truncated|first 1 records/.test(line)), JSON.stringify(result.notices));
  });

  test('a truncated transport scan is disclosed in the clear path', async () => {
    const home = agentHome();
    const target = checkout('advisory-transport');
    for (const [index, token] of ['GbCdEfGhIjKlMnOpQrStUv', 'HbCdEfGhIjKlMnOpQrStUv'].entries()) {
      publishTransport(home, { sessionId: `peer-${index}`, token });
    }
    const result = await verdictFor(target, { home, maxTransportEntries: 1 });
    assert.equal(result.verdict, 'clear');
    assert.ok(result.notices.some((line) => /transport/i.test(line)), JSON.stringify(result.notices));
  });
});

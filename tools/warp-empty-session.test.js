'use strict';
// warp-empty-session T1/T2 (S1-S5): a session with no conversation does not
// "move" — it changes PATH silently.
//
// S1: an empty session warps silently — no `worktree-warp` message, no
// transition card, no "moved:/to:" wording in the returned text.
// S2: warping back after writing nothing is the same case, in both directions
// and any number of times.
// S3: no in-place path change exists in the host, so the equivalent is a fresh
// session at the target cwd through the create/switch machinery — never
// `forkFrom` (the host refuses a conversation-less source).
// S4: branching semantics stay untouched for a session WITH conversation; an
// empty source RESUMES a destination that already holds a conversation.
// S5: empty means "the active branch carries no `message` entry with role user
// or assistant once the warp bookkeeping is excluded".
//
// Everything is injected: the SessionManager statics (`forkFrom`/`create`/
// `open`), the command context, and the OSC stream. The repositories and the
// session files live in throwaway directories under the system temp dir; no
// live host, no network, and no real Pi session is touched.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { LIB_DIR, stubbedSource } = require('./fixtures/load-extension.js');
const warpSessionsLib = require('../lib/worktree-warp-sessions.js');

const STAMP = '2026-01-01T00:00:00.000Z';
const savedEnv = { ...process.env };
const roots = [];

function track(dir) {
  roots.push(dir);
  return dir;
}

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function runGit(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

let mod;

before(async () => {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-empty-ext-')));
  const copy = path.join(dir, 'odd-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbedSource());
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  process.env.GENTLE_WORKTREE_THREAD = 'thread-1';
  mod = await import(pathToFileURL(copy).href);
  mod.default({
    registerCommand() {},
    registerTool() {},
    registerMessageRenderer() {},
    on() { return () => {}; },
  });
});

// ---------------------------------------------------------------------------
// Entry fixtures: the shapes the host persists, chained so the active branch
// is the whole list (each entry's parentId is the previous id).
// ---------------------------------------------------------------------------

const message = (role, text) => (id, parentId) => ({
  type: 'message', id, parentId, timestamp: STAMP, message: { role, content: [{ type: 'text', text }] },
});
const userSays = (text) => message('user', text);
const assistantSays = (text) => message('assistant', text);
const toolResult = (text) => message('toolResult', text);
// The four warp bookkeeping shapes (lib/worktree-warp-sessions.js): none of
// them is conversation.
const registration = () => (id, parentId) => ({
  type: 'custom', id, parentId, timestamp: STAMP,
  customType: 'gentle-pi.session-worktree/v1', data: { sessionId: 'thread-1', cwd: '/' },
});
const rename = (name) => (id, parentId) => ({ type: 'session_info', id, parentId, timestamp: STAMP, name });
const transition = (from, to) => (id, parentId) => ({
  type: 'custom', id, parentId, timestamp: STAMP, customType: 'worktree-warp', data: { from, to },
});
const warpNotice = (text) => (id, parentId) => ({
  type: 'custom_message', id, parentId, timestamp: STAMP, customType: 'worktree-warp', content: text, display: true,
});

function chain(builders) {
  const entries = [];
  let parentId = null;
  builders.forEach((build, index) => {
    const entry = build(`e${index + 1}`, parentId);
    entries.push(entry);
    parentId = entry.id;
  });
  return entries;
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

function sessionHeader(name, cwd) {
  return { type: 'session', version: 3, id: `id-${name}`, timestamp: STAMP, cwd };
}

// ---------------------------------------------------------------------------
// The injected host: a repository pair, a session directory, the
// SessionManager double and the command context.
// ---------------------------------------------------------------------------

function makeRepoPair() {
  const parent = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-empty-repo-')));
  const repo = path.join(parent, 'project');
  fs.mkdirSync(repo);
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.test']);
  runGit(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'init']);
  const worktree = path.join(parent, 'project-worktrees', 'feat-login');
  runGit(repo, ['worktree', 'add', worktree, '-b', 'feat/login']);
  return {
    repo: fs.realpathSync(repo),
    target: fs.realpathSync(worktree),
    targetName: 'feat-login',
  };
}

function makeWorld() {
  const sessionDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-empty-sessions-')));
  const calls = {
    forkFrom: [], create: [], open: [], switches: [], messages: [],
    statuses: [], customEntries: [], renames: [],
  };
  const osc = [];
  let created = 0;

  class FakeSession {
    constructor({ file = null, cwd = null, header = null, entries = [], name = '' }) {
      this.file = file;
      this.cwd = cwd;
      this.header = header;
      this.entries = entries.slice();
      this.name = name;
      const last = this.entries[this.entries.length - 1];
      this.leafId = last ? last.id : null;
    }

    getSessionFile() { return this.file; }
    getSessionDir() { return sessionDir; }
    getSessionId() { return 'thread-1'; }
    getSessionName() { return this.name; }
    getHeader() { return this.header; }
    getEntries() { return this.entries.slice(); }
    getLeafId() { return this.leafId; }
    branch(id) { this.leafId = id; }
    resetLeaf() { this.leafId = null; }

    appendCustomEntry(customType, data) {
      calls.customEntries.push({ file: this.file, customType, data });
      this.push({ type: 'custom', customType, data });
    }

    appendSessionInfo(name) {
      calls.renames.push({ file: this.file, name });
      this.push({ type: 'session_info', name });
    }

    push(partial) {
      const entry = { ...partial, id: `${this.file || 'memory'}#${this.entries.length + 1}`, parentId: this.leafId, timestamp: STAMP };
      this.entries.push(entry);
      this.leafId = entry.id;
    }
  }

  // The host allocates a session file for the target cwd and writes nothing to
  // it yet: the file only appears once the manager flushes an assistant turn.
  FakeSession.create = (cwd, dir) => {
    calls.create.push({ cwd, sessionDir: dir === undefined ? null : dir });
    created += 1;
    const header = sessionHeader(`created-${created}`, cwd);
    return new FakeSession({ file: path.join(dir || sessionDir, `created-${created}.jsonl`), cwd, header });
  };

  FakeSession.open = (file, dir) => {
    calls.open.push({ file, sessionDir: dir === undefined ? null : dir });
    return load(file);
  };

  // forkFrom copies the source entries VERBATIM under a new header pointing at
  // the source, exactly like the installed SessionManager.
  FakeSession.forkFrom = (sourcePath, targetCwd, dir) => {
    calls.forkFrom.push({ sourcePath, targetCwd, sessionDir: dir === undefined ? null : dir });
    created += 1;
    const file = path.join(dir || sessionDir, `fork-${created}.jsonl`);
    const lines = readJsonl(sourcePath);
    const header = { ...sessionHeader(`fork-${created}`, targetCwd), parentSession: sourcePath };
    const entries = lines.filter((entry) => entry.type !== 'session');
    writeJsonl(file, [header, ...entries]);
    return new FakeSession({ file, cwd: targetCwd, header, entries });
  };

  function load(file) {
    if (!file || !fs.existsSync(file)) return new FakeSession({ file });
    const lines = readJsonl(file);
    const header = lines.length > 0 && lines[0].type === 'session' ? lines[0] : null;
    return new FakeSession({
      file,
      cwd: header ? header.cwd : null,
      header,
      entries: lines.filter((entry) => entry.type !== 'session'),
    });
  }

  function current(file) {
    const manager = load(file);
    manager.name = 'Test session';
    return manager;
  }

  // A session Pi has not written to disk yet: no file, only memory.
  function bare(entries = []) {
    const manager = new FakeSession({ entries });
    manager.name = 'Test session';
    return manager;
  }

  function ctx({ cwd, manager }) {
    return {
      cwd,
      hasUI: false,
      mode: 'tui',
      sessionManager: manager,
      ui: { notify: () => {}, setStatus: (key, text) => calls.statuses.push([key, text]) },
      waitForIdle: async () => {},
      switchSession: async (file, options) => {
        calls.switches.push({ file, withSession: !!(options && options.withSession) });
        if (options && typeof options.withSession === 'function') {
          await options.withSession({
            ui: { setStatus: (key, text) => calls.statuses.push([key, text]) },
            sendMessage: (textOrMessage, sendOptions) => {
              calls.messages.push({ message: textOrMessage, options: sendOptions });
            },
          });
        }
        return undefined;
      },
    };
  }

  function writeSession(name, cwd, builders) {
    const file = path.join(sessionDir, `${name}.jsonl`);
    writeJsonl(file, [sessionHeader(name, cwd), ...chain(builders)]);
    return file;
  }

  function sessionFiles() {
    return fs.readdirSync(sessionDir).filter((entry) => entry.endsWith('.jsonl')).sort();
  }

  return {
    sessionDir, calls, osc, SM: FakeSession,
    stream: { isTTY: true, write: (chunk) => osc.push(chunk) },
    ctx, current, bare, load, writeSession, sessionFiles,
  };
}

function warpOptions(world) {
  return { sessionManagerClass: world.SM, oscStream: world.stream };
}

function worktreeWarpMessages(world) {
  return world.calls.messages.filter(({ message }) => message && message.customType === 'worktree-warp');
}

// ---------------------------------------------------------------------------
// S5: the predicate itself.
// ---------------------------------------------------------------------------

describe('hasConversation (S5)', () => {
  test('a session that holds only warp bookkeeping carries no conversation', () => {
    const entries = chain([registration(), rename('New session'), transition('/a', '/b'), warpNotice('warped')]);
    assert.equal(warpSessionsLib.hasConversation(entries), false);
    assert.equal(warpSessionsLib.hasConversation([]), false);
    assert.equal(warpSessionsLib.hasConversation(undefined), false);
  });

  test('a user or assistant message is conversation, a tool result alone is not', () => {
    assert.equal(warpSessionsLib.hasConversation(chain([registration(), userSays('hi')])), true);
    assert.equal(warpSessionsLib.hasConversation(chain([assistantSays('hello')])), true);
    assert.equal(warpSessionsLib.hasConversation(chain([registration(), toolResult('ok')])), false);
  });

  test('only the ACTIVE branch decides: an abandoned leg never makes it non-empty', () => {
    const abandoned = { type: 'message', id: 'leg-1', parentId: 'e1', timestamp: STAMP, message: { role: 'user', content: [] } };
    const entries = [{ ...chain([registration()])[0] }, abandoned];
    // The abandoned entry IS the last entry, so it is also the leaf; point the
    // leaf at the bookkeeping entry instead to model a rewind onto the root leg.
    assert.equal(warpSessionsLib.hasConversation(entries, 'e1'), false);
    assert.equal(warpSessionsLib.hasConversation(entries), true);
  });
});

// ---------------------------------------------------------------------------
// S1/S3: an empty session changes path, silently.
// ---------------------------------------------------------------------------

describe('an empty session warps silently', () => {
  test('no fork, no card, no transition entry, and it continues at the target cwd', async () => {
    const { repo, target, targetName } = makeRepoPair();
    const world = makeWorld();
    const source = world.writeSession('empty-source', repo, [registration(), rename('New session')]);

    const out = await mod.executeWorktreeWarp(targetName, world.ctx({ cwd: repo, manager: world.current(source) }), warpOptions(world));

    assert.notEqual(out.isError, true, out.text);
    assert.deepEqual(world.calls.forkFrom, [], 'an empty session never forks');
    assert.deepEqual(worktreeWarpMessages(world), [], 'no worktree-warp card is sent');
    assert.deepEqual(world.calls.messages, [], 'nothing at all is sent to the empty session');
    assert.deepEqual(world.calls.customEntries, [], 'no transition entry is appended');

    assert.equal(world.calls.switches.length, 1);
    const switchedFile = world.calls.switches[0].file;
    const header = readJsonl(switchedFile)[0];
    assert.equal(header.cwd, target, 'the session continues in the target checkout');
    assert.equal(world.calls.switches[0].withSession, true);

    // Where the session IS still travels: the status line and the OSC-7 hint.
    assert.equal(world.calls.statuses.length > 0, true);
    assert.equal(world.calls.statuses[world.calls.statuses.length - 1][0], 'worktree');
    assert.equal(world.calls.statuses[world.calls.statuses.length - 1][1].endsWith(`(${target})`), true);
    assert.deepEqual(world.osc, [`\x1b]7;${pathToFileURL(target).href}\x1b\\`]);

    // The returned text names the position, never a move.
    assert.doesNotMatch(out.text, /moved/i);
    assert.doesNotMatch(out.text, /(^|\n)to: /);
    assert.doesNotMatch(out.text, /\bfrom: /);
    assert.match(out.text, /empty session/);

    // Recording is unchanged: both sides are recorded, so a later warp finds
    // the destination session again.
    assert.equal(warpSessionsLib.getWarpSession(repo, target).sessionFile, switchedFile);
    assert.equal(warpSessionsLib.getWarpSession(repo, repo).sessionFile, source);
  });

  test('a brand-new session with no file and no entries changes path instead of refusing', async () => {
    const { repo, target, targetName } = makeRepoPair();
    const world = makeWorld();

    const out = await mod.executeWorktreeWarp(targetName, world.ctx({ cwd: repo, manager: world.bare() }), warpOptions(world));

    assert.notEqual(out.isError, true, out.text);
    assert.deepEqual(world.calls.forkFrom, []);
    assert.deepEqual(world.calls.messages, []);
    assert.equal(world.calls.switches.length, 1);
    assert.equal(readJsonl(world.calls.switches[0].file)[0].cwd, target);
    assert.equal(warpSessionsLib.getWarpSession(repo, target).sessionFile, world.calls.switches[0].file);
  });
});

// ---------------------------------------------------------------------------
// S2: warping back, and repeating, keeps it empty.
// ---------------------------------------------------------------------------

describe('warping back from an empty session is the same case', () => {
  test('a round trip warps silently both ways and accumulates nothing', async () => {
    const { repo, target, targetName } = makeRepoPair();
    const world = makeWorld();
    const source = world.writeSession('empty-source', repo, [registration()]);

    let cwd = repo;
    let file = source;
    const rounds = [
      { name: targetName, expect: target },
      { name: 'principal', expect: repo },
      { name: targetName, expect: target },
      { name: 'principal', expect: repo },
    ];
    for (const round of rounds) {
      const out = await mod.executeWorktreeWarp(round.name, world.ctx({ cwd, manager: world.current(file) }), warpOptions(world));
      assert.notEqual(out.isError, true, out.text);
      assert.match(out.text, /empty session/);
      assert.doesNotMatch(out.text, /moved/i);
      const switched = world.calls.switches[world.calls.switches.length - 1].file;
      assert.equal(readJsonl(switched)[0].cwd, round.expect);
      cwd = round.expect;
      file = switched;
      // Exactly one session file per checkout: the empty warp never allocates a
      // second one for the same destination.
      assert.deepEqual(world.sessionFiles(), ['created-1.jsonl', 'empty-source.jsonl']);
    }

    assert.deepEqual(world.calls.forkFrom, [], 'no round of the round trip forks');
    assert.deepEqual(world.calls.messages, [], 'no round of the round trip sends a card');
    assert.deepEqual(world.calls.customEntries, [], 'no round of the round trip appends a transition');
  });
});

// ---------------------------------------------------------------------------
// S4: an empty source resumes a destination that holds a conversation.
// ---------------------------------------------------------------------------

describe('an empty source and a destination with conversation', () => {
  test('resumes the recorded destination session, with no fork and no card', async () => {
    const { repo, target, targetName } = makeRepoPair();
    const world = makeWorld();
    const source = world.writeSession('empty-source', repo, [registration()]);
    const destination = world.writeSession('written-earlier', target, [userSays('do the thing'), assistantSays('done')]);
    warpSessionsLib.recordWarpSession(repo, target, {
      sessionFile: destination, tipId: 'e2', count: 2,
    });

    const out = await mod.executeWorktreeWarp(targetName, world.ctx({ cwd: repo, manager: world.current(source) }), warpOptions(world));

    assert.notEqual(out.isError, true, out.text);
    assert.deepEqual(world.calls.forkFrom, [], 'a conversation is resumed, never forked over');
    assert.deepEqual(world.calls.messages, [], 'nothing was carried from the source, so nothing is announced');
    assert.deepEqual(world.calls.customEntries, []);
    assert.equal(world.calls.switches.length, 1);
    assert.equal(world.calls.switches[0].file, destination);
    assert.match(out.text, /empty session/);
    assert.doesNotMatch(out.text, /moved/i);
  });
});

// ---------------------------------------------------------------------------
// PRESERVE: a session WITH conversation keeps today's behaviour.
// ---------------------------------------------------------------------------

describe('a session with conversation keeps today behaviour', () => {
  test('it forks once and sends exactly one Warp card', async () => {
    const { repo, target, targetName } = makeRepoPair();
    const world = makeWorld();
    const source = world.writeSession('with-conversation', repo, [registration(), userSays('hi'), assistantSays('hello')]);

    const out = await mod.executeWorktreeWarp(targetName, world.ctx({ cwd: repo, manager: world.current(source) }), warpOptions(world));

    assert.notEqual(out.isError, true, out.text);
    assert.equal(world.calls.forkFrom.length, 1);
    assert.equal(world.calls.forkFrom[0].sourcePath, source);
    assert.equal(world.calls.forkFrom[0].targetCwd, target);
    assert.equal(world.calls.customEntries.length, 1);
    assert.equal(world.calls.customEntries[0].customType, 'worktree-warp');
    const cards = worktreeWarpMessages(world);
    assert.equal(cards.length, 1, 'exactly one card');
    assert.equal(cards[0].message.details.to, target);
    assert.equal(cards[0].message.details.fromName, 'principal');
    assert.equal(cards[0].options.triggerTurn, false);
    assert.match(cards[0].message.content, /Worktree warp: now in /);
    assert.equal(world.calls.switches.length, 1);
    assert.equal(readJsonl(world.calls.switches[0].file)[0].cwd, target);
    // The returned text is still the two-line compact that names the move.
    assert.match(out.text, /^moved: /);
    assert.match(out.text, /\nto: /);
  });

  test('a destination at the same point is still resumed silently', async () => {
    const { repo, target, targetName } = makeRepoPair();
    const world = makeWorld();
    const source = world.writeSession('with-conversation', repo, [userSays('hi'), assistantSays('hello')]);
    // Same filtered point: the recorded destination holds the same entries.
    const destination = path.join(world.sessionDir, 'same-point.jsonl');
    writeJsonl(destination, [sessionHeader('same-point', target), ...readJsonl(source).filter((entry) => entry.type !== 'session')]);
    warpSessionsLib.recordWarpSession(repo, target, { sessionFile: destination, tipId: 'e2', count: 2 });

    const out = await mod.executeWorktreeWarp(targetName, world.ctx({ cwd: repo, manager: world.current(source) }), warpOptions(world));

    assert.notEqual(out.isError, true, out.text);
    assert.deepEqual(world.calls.forkFrom, []);
    assert.deepEqual(world.calls.messages, [], 'a resume re-enters silently');
    assert.deepEqual(world.calls.customEntries, []);
    assert.equal(world.calls.switches.length, 1);
    assert.equal(world.calls.switches[0].file, destination);
    assert.match(out.text, /^moved: /);
  });
});

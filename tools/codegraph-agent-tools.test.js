'use strict';
// S2: `<config home>/tools.json` carries the MCP server `mcp__codegraph` for the CodeGraph agents exactly while
// `Codegraph+` is On and the CLI is installed. Turning it On adds the entry, Off (or a missing CLI) takes it out, and
// nothing else in the file is touched: other agents, other tool names, `remove` lists and unknown keys stay, the
// indentation stays, an unchanged file is not rewritten and an invalid one is left alone. Every case uses a
// scratch directory: no test reads or writes a real config home.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentTools = require('../lib/codegraph-agent-tools.js');

const AGENTS = ['gentle-ai-explore', 'gentle-ai-verify', 'gentle-ai-worker', 'jd-fix-agent'];
const SERVER = 'mcp__codegraph';

const scratch = [];
const dir = () => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-agent-tools-'));
  scratch.push(made);
  return made;
};
after(() => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const file = (home) => path.join(home, 'tools.json');
const put = (home, value, mode) => fs.writeFileSync(file(home), typeof value === 'string' ? value : JSON.stringify(value, null, 2), mode === undefined ? {} : { mode });
const read = (home) => JSON.parse(fs.readFileSync(file(home), 'utf8'));
const leftovers = (home) => fs.readdirSync(home).filter((name) => name !== 'tools.json');
const allAdd = () => Object.fromEntries(AGENTS.map((name) => [name, { add: [SERVER] }]));

test('the entry is the CodeGraph server of the four CodeGraph agents', () => {
  assert.deepEqual([...agentTools.CODEGRAPH_AGENTS], AGENTS);
  assert.equal(agentTools.CODEGRAPH_SERVER_TOOL, SERVER);
  assert.equal(agentTools.toolsConfigPath('/x/gentle-ai'), path.join('/x/gentle-ai', 'tools.json'));
});

describe('On: add only', () => {
  test('creates the file with the four agents when it is missing', async () => {
    const home = dir();
    const result = await agentTools.reconcileAgentTools({ configHome: home, enabled: true });
    assert.equal(result.status, 'created');
    assert.deepEqual(read(home), allAdd());
    assert.deepEqual(leftovers(home), []);
  });

  test('adds the server next to what an agent already has, and keeps every other agent, remove list and key', async () => {
    const home = dir();
    put(home, {
      'gentle-ai-explore': { add: ['web_search'], remove: ['bash'], note: 'mine' },
      'gentle-ai-worker': { add: [] },
      'some-other-agent': { add: ['x'] },
      extra: 1,
    });
    const result = await agentTools.reconcileAgentTools({ configHome: home, enabled: true });
    assert.equal(result.status, 'updated');
    assert.deepEqual(read(home), {
      'gentle-ai-explore': { add: ['web_search', SERVER], remove: ['bash'], note: 'mine' },
      'gentle-ai-worker': { add: [SERVER] },
      'some-other-agent': { add: ['x'] },
      extra: 1,
      'gentle-ai-verify': { add: [SERVER] },
      'jd-fix-agent': { add: [SERVER] },
    });
  });

  test('an entry that is already right is not rewritten, and keeps its tabs and its mode', async () => {
    const home = dir();
    const text = `${JSON.stringify(allAdd(), null, '\t')}\n`;
    put(home, text, 0o640);
    const before = fs.statSync(file(home));
    const result = await agentTools.reconcileAgentTools({ configHome: home, enabled: true });
    assert.equal(result.status, 'unchanged');
    assert.equal(fs.readFileSync(file(home), 'utf8'), text);
    assert.equal(fs.statSync(file(home)).mtimeMs, before.mtimeMs);
  });

  test('a rewrite keeps the indentation and the permission bits of the file', async () => {
    const home = dir();
    put(home, '{\n\t"gentle-ai-explore": {\n\t\t"add": ["web_search"]\n\t}\n}\n', 0o640);
    await agentTools.reconcileAgentTools({ configHome: home, enabled: true });
    assert.match(fs.readFileSync(file(home), 'utf8'), /\n\t"gentle-ai-explore": \{\n\t\t"add": \[/);
    assert.equal(fs.statSync(file(home)).mode & 0o777, 0o640);
  });

  test('an agent whose own remove list names the server is the user\'s decision: it is left alone', async () => {
    const home = dir();
    put(home, { 'jd-fix-agent': { add: [], remove: [SERVER] } });
    await agentTools.reconcileAgentTools({ configHome: home, enabled: true });
    assert.deepEqual(read(home)['jd-fix-agent'], { add: [], remove: [SERVER] });
    assert.deepEqual(read(home)['gentle-ai-explore'], { add: [SERVER] });
  });

  test('an agent entry that is not an object, or whose add is not a list, is left as it is', async () => {
    const home = dir();
    put(home, { 'gentle-ai-explore': 'x', 'gentle-ai-verify': { add: 'mcp' } });
    await agentTools.reconcileAgentTools({ configHome: home, enabled: true });
    assert.equal(read(home)['gentle-ai-explore'], 'x');
    assert.deepEqual(read(home)['gentle-ai-verify'], { add: 'mcp' });
    assert.deepEqual(read(home)['gentle-ai-worker'], { add: [SERVER] });
  });
});

describe('Off: take only the CodeGraph server out', () => {
  test('removes the server and its tool spellings from the four agents and keeps the rest', async () => {
    const home = dir();
    put(home, {
      'gentle-ai-explore': { add: [SERVER, 'web_search'] },
      'gentle-ai-verify': { add: ['mcp__codegraph__codegraph_explore'], remove: ['bash'] },
      'gentle-ai-worker': { add: [SERVER] },
      'some-other-agent': { add: [SERVER] },
      extra: 1,
    });
    const result = await agentTools.reconcileAgentTools({ configHome: home, enabled: false });
    assert.equal(result.status, 'updated');
    assert.deepEqual(read(home), {
      'gentle-ai-explore': { add: ['web_search'] },
      'gentle-ai-verify': { remove: ['bash'] },
      'some-other-agent': { add: [SERVER] },
      extra: 1,
    });
  });

  test('an entry that Off leaves empty goes away; an empty file stays a valid document', async () => {
    const home = dir();
    put(home, allAdd());
    await agentTools.reconcileAgentTools({ configHome: home, enabled: false });
    assert.deepEqual(read(home), {});
  });

  test('a missing file stays missing, and a file with nothing to take out is not rewritten', async () => {
    const home = dir();
    assert.equal((await agentTools.reconcileAgentTools({ configHome: home, enabled: false })).status, 'unchanged');
    assert.equal(fs.existsSync(file(home)), false);
    put(home, { 'gentle-ai-explore': { add: ['web_search'] } });
    const before = fs.statSync(file(home));
    assert.equal((await agentTools.reconcileAgentTools({ configHome: home, enabled: false })).status, 'unchanged');
    assert.equal(fs.statSync(file(home)).mtimeMs, before.mtimeMs);
  });
});

describe('what it never does', () => {
  test('a file that is not valid JSON, or not an object, is left untouched and reported', async () => {
    for (const bad of ['{ nope', '[]', '42', 'null']) {
      for (const enabled of [true, false]) {
        const home = dir();
        put(home, bad);
        const result = await agentTools.reconcileAgentTools({ configHome: home, enabled });
        assert.equal(result.status, 'invalid', `${bad} / ${enabled}`);
        assert.equal(fs.readFileSync(file(home), 'utf8'), bad);
        assert.deepEqual(leftovers(home), []);
      }
    }
  });

  test('no config home, an unreadable file or a failing write answers a status and never throws', async () => {
    assert.equal((await agentTools.reconcileAgentTools({ configHome: undefined, enabled: true })).status, 'skipped');
    const home = dir();
    fs.mkdirSync(file(home));
    assert.equal((await agentTools.reconcileAgentTools({ configHome: home, enabled: true })).status, 'unreadable');
    const writable = dir();
    put(writable, { x: 1 });
    const failing = {
      ...fs.promises,
      rename: async () => { throw new Error('disk'); },
    };
    const result = await agentTools.reconcileAgentTools({ configHome: writable, enabled: true, fs: failing });
    assert.equal(result.status, 'failed');
    assert.deepEqual(read(writable), { x: 1 });
    assert.deepEqual(leftovers(writable), []);
  });
});

// The session start looks again, so a switch changed while no session ran, or a CLI that went away, is corrected.
describe('the session-start check', () => {
  const fakePi = () => {
    const handlers = [];
    return { handlers, on: (name, fn) => { if (name === 'session_start') handlers.push(fn); } };
  };
  const start = async (pi, notices = []) => {
    for (const handler of pi.handlers) {
      const returned = handler({ reason: 'startup' }, { ui: { notify: (text, level) => notices.push([text, level]) } });
      assert.equal(returned, undefined, 'a session_start handler never returns a promise');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return notices;
  };
  const env = (home, extra = {}) => ({ GENTLE_PI_CONFIG_HOME: home, ...extra });

  test('On with the CLI adds the entry once per process and says so', async () => {
    const home = dir();
    const pi = fakePi();
    agentTools.registerAgentToolsSync(pi, { enabled: true, env: env(home), hasCli: () => true });
    const notices = await start(pi);
    assert.deepEqual(read(home), allAdd());
    assert.equal(notices.length, 1);
    assert.match(notices[0][0], /tools\.json/);
    assert.match(notices[0][0], /\/reload/);
    assert.deepEqual(await start(pi), [], 'a second session start in the same process checks nothing');
  });

  test('On without the CLI takes the entry out, and so does Off', async () => {
    for (const [enabled, hasCli] of [[true, false], [false, true], [false, false]]) {
      const home = dir();
      put(home, allAdd());
      const pi = fakePi();
      agentTools.registerAgentToolsSync(pi, { enabled, env: env(home), hasCli: () => hasCli });
      await start(pi);
      assert.deepEqual(read(home), {}, `enabled=${enabled} cli=${hasCli}`);
    }
  });

  test('an entry that is already right says nothing; an invalid file warns and stays', async () => {
    const home = dir();
    put(home, allAdd());
    const pi = fakePi();
    agentTools.registerAgentToolsSync(pi, { enabled: true, env: env(home), hasCli: () => true });
    assert.deepEqual(await start(pi), []);
    const broken = dir();
    put(broken, '{ nope');
    const pi2 = fakePi();
    agentTools.registerAgentToolsSync(pi2, { enabled: true, env: env(broken), hasCli: () => true });
    const notices = await start(pi2);
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    assert.equal(fs.readFileSync(file(broken), 'utf8'), '{ nope');
  });

  test('a subagent child and a host without events register and write nothing', async () => {
    const home = dir();
    const pi = fakePi();
    assert.equal(agentTools.registerAgentToolsSync(pi, { enabled: true, env: env(home, { GENTLE_PI_AGENTS_CHILD: '1' }), hasCli: () => true }).registered, false);
    assert.equal(pi.handlers.length, 0);
    assert.equal(agentTools.registerAgentToolsSync({}, { enabled: true, env: env(home), hasCli: () => true }).registered, false);
    assert.equal(fs.existsSync(file(home)), false);
  });

  test('a failure in the check never breaks the session start', async () => {
    const pi = fakePi();
    agentTools.registerAgentToolsSync(pi, { enabled: true, env: env('/nonexistent/never'), hasCli: () => { throw new Error('probe'); } });
    await assert.doesNotReject(start(pi));
  });
});

// Turning Codegraph+ On is the moment the MCP entry and the agents are wired, so the next /reload already has them.
describe('the switch', () => {
  test('On ensures the MCP entry in mcp.json and adds the agents; Off only takes the agents out', async () => {
    const agentDir = dir();
    const home = dir();
    const env = { GENTLE_PI_CONFIG_HOME: home };
    const on = await agentTools.applyCodegraphSwitch({ on: true, env, agentDir });
    assert.equal(on.mcp.status, 'added');
    assert.equal(on.tools.status, 'created');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers.codegraph, {
      command: 'codegraph',
      args: ['serve', '--mcp'],
      toolExposure: { codegraph_explore: 'direct' },
    });
    assert.deepEqual(read(home), allAdd());
    const off = await agentTools.applyCodegraphSwitch({ on: false, env, agentDir });
    assert.equal(off.mcp, undefined, 'Off leaves the user\'s MCP configuration alone');
    assert.equal(off.tools.status, 'updated');
    assert.deepEqual(read(home), {});
    assert.ok(JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers.codegraph, 'the server entry stays');
  });

  test('a failure on one file never stops the other', async () => {
    const agentDir = dir();
    const home = dir();
    put(home, '{ nope');
    const result = await agentTools.applyCodegraphSwitch({ on: true, env: { GENTLE_PI_CONFIG_HOME: home }, agentDir });
    assert.equal(result.mcp.status, 'added');
    assert.equal(result.tools.status, 'invalid');
  });
});

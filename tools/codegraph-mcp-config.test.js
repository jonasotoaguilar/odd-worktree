'use strict';
// S12: the global MCP entry. The package ensures `mcpServers.codegraph` of <agent dir>/mcp.json has the three fields CodeGraph's
// explore tool needs, adds it when it is missing, fixes only what differs, keeps everything else, and never rewrites a file
// that is already right. Every case uses a scratch directory: no test reads or writes a real agent directory.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureCodegraphServer, CODEGRAPH_SERVER, mcpConfigPath } = require('../lib/codegraph-mcp-config.js');

const scratch = [];
const dir = () => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-config-'));
  scratch.push(made);
  return made;
};
after(() => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const write = (agentDir, value, mode) => {
  const file = path.join(agentDir, 'mcp.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), mode === undefined ? {} : { mode });
  return file;
};
const read = (agentDir) => JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
const leftovers = (agentDir) => fs.readdirSync(agentDir).filter((name) => name !== 'mcp.json');

test('the entry CodeGraph needs is exactly three fields', () => {
  assert.deepEqual(CODEGRAPH_SERVER, {
    command: 'codegraph',
    args: ['serve', '--mcp'],
    toolExposure: { codegraph_explore: 'direct' },
  });
  assert.equal(mcpConfigPath('/x/agent'), path.join('/x/agent', 'mcp.json'));
});

test('a missing entry is added and every other server and key is kept', async () => {
  const agentDir = dir();
  write(agentDir, { settings: { a: 1 }, mcpServers: { other: { command: 'x', env: { TOKEN: 'keep' } } } });
  const result = await ensureCodegraphServer({ agentDir });
  assert.equal(result.status, 'added');
  const config = read(agentDir);
  assert.deepEqual(config.mcpServers.codegraph, CODEGRAPH_SERVER);
  assert.deepEqual(config.mcpServers.other, { command: 'x', env: { TOKEN: 'keep' } });
  assert.deepEqual(config.settings, { a: 1 });
  assert.deepEqual(leftovers(agentDir), [], 'no temp file is left behind');
});

test('a missing file is created when the agent directory exists, and not when it does not', async () => {
  const agentDir = dir();
  assert.equal((await ensureCodegraphServer({ agentDir })).status, 'added');
  assert.deepEqual(read(agentDir), { mcpServers: { codegraph: CODEGRAPH_SERVER } });
  const absent = path.join(dir(), 'nope');
  assert.equal((await ensureCodegraphServer({ agentDir: absent })).status, 'skipped');
  assert.equal(fs.existsSync(absent), false);
});

test('an entry that differs is fixed field by field and the rest of the entry is kept', async () => {
  const agentDir = dir();
  write(agentDir, {
    mcpServers: {
      codegraph: {
        command: '/old/codegraph',
        args: ['serve'],
        env: { A: 'b' },
        toolExposure: { codegraph_explore: 'codemode', other_tool: 'hidden' },
      },
    },
  });
  const result = await ensureCodegraphServer({ agentDir });
  assert.equal(result.status, 'fixed');
  assert.deepEqual(result.changes.sort(), ['args', 'command', 'toolExposure.codegraph_explore']);
  assert.deepEqual(read(agentDir).mcpServers.codegraph, {
    command: 'codegraph',
    args: ['serve', '--mcp'],
    env: { A: 'b' },
    toolExposure: { codegraph_explore: 'direct', other_tool: 'hidden' },
  });
});

test('a missing toolExposure or a non-object entry is repaired too', async () => {
  const a = dir();
  write(a, { mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } } });
  assert.equal((await ensureCodegraphServer({ agentDir: a })).status, 'fixed');
  assert.deepEqual(read(a).mcpServers.codegraph, CODEGRAPH_SERVER);
  const b = dir();
  write(b, { mcpServers: { codegraph: 'broken' } });
  assert.equal((await ensureCodegraphServer({ agentDir: b })).status, 'fixed');
  assert.deepEqual(read(b).mcpServers.codegraph, CODEGRAPH_SERVER);
  const c = dir();
  write(c, { mcpServers: [] });
  assert.equal((await ensureCodegraphServer({ agentDir: c })).status, 'invalid');
});

test('a file that is already right is not rewritten, whatever its formatting', async () => {
  const agentDir = dir();
  const text = '{"mcpServers":{"codegraph":{"command":"codegraph","args":["serve","--mcp"],"toolExposure":{"codegraph_explore":"direct"}}}}';
  const file = write(agentDir, text);
  const before = fs.statSync(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await ensureCodegraphServer({ agentDir })).status, 'unchanged');
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the bytes are the same');
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});

test('invalid JSON is left untouched and reported, never overwritten', async () => {
  const agentDir = dir();
  const file = write(agentDir, '{ "mcpServers": { oops');
  const result = await ensureCodegraphServer({ agentDir });
  assert.equal(result.status, 'invalid');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "mcpServers": { oops');
  assert.deepEqual(leftovers(agentDir), []);
});

test('the permission bits of the file are kept', { skip: process.platform === 'win32' }, async () => {
  const agentDir = dir();
  const file = write(agentDir, { mcpServers: {} }, 0o600);
  fs.chmodSync(file, 0o600);
  await ensureCodegraphServer({ agentDir });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a created file is private to its owner', { skip: process.platform === 'win32' }, async () => {
  const agentDir = dir();
  await ensureCodegraphServer({ agentDir });
  assert.equal(fs.statSync(path.join(agentDir, 'mcp.json')).mode & 0o777, 0o600);
});

test('a failing write is reported, leaves the original and no temp file, and never throws', async () => {
  const agentDir = dir();
  const original = JSON.stringify({ mcpServers: {} });
  const file = write(agentDir, original);
  const failing = { ...fs.promises, rename: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  const result = await ensureCodegraphServer({ agentDir, fs: failing });
  assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(leftovers(agentDir), []);
});

test('two sessions in a row change the file once', async () => {
  const agentDir = dir();
  write(agentDir, { mcpServers: {} });
  const [first, second] = [await ensureCodegraphServer({ agentDir }), await ensureCodegraphServer({ agentDir })];
  assert.equal(first.status, 'added');
  assert.equal(second.status, 'unchanged');
});

test('the existing indentation is kept', async () => {
  const agentDir = dir();
  const file = write(agentDir, JSON.stringify({ mcpServers: {} }, null, 4) + '\n');
  await ensureCodegraphServer({ agentDir });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\n {4}"mcpServers"/);
  assert.ok(text.endsWith('\n'));
});

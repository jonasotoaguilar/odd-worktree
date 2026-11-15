'use strict';
// S5: the MCP configuration is read, never written. A registered entry is not proof a daemon is reachable,
// and MCP is optional: a session with no server works, and the package only says so.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mcp = require('../lib/codegraph-mcp.js');
const { isCodegraphServerMissing, readExposureWarning, readMissingServerWarning } = mcp;

const AGENT = '/agent-with-no-files';
const PROJECT = '/project-with-no-files';
const GLOBAL_PATH = `${AGENT}/mcp.json`;
const PROJECT_PATH = `${PROJECT}/.pi/mcp.json`;

const base = (codegraph) => `${JSON.stringify({ mcpServers: { codegraph, engram: { command: 'node', lifecycle: 'lazy' } }, other: 1 }, null, 2)}\n`;
const DIRECT = base({ command: 'codegraph', toolExposure: { codegraph_explore: 'direct' } });

/** A read seam over a path→text map: anything else is a missing file, as on disk. */
function reads(map) {
  return (file) => {
    if (Object.prototype.hasOwnProperty.call(map, file)) return map[file];
    const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
    error.code = 'ENOENT';
    throw error;
  };
}

function files(globalText, projectText) {
  const map = {};
  if (globalText !== undefined) map[GLOBAL_PATH] = globalText;
  if (projectText !== undefined) map[PROJECT_PATH] = projectText;
  return reads(map);
}

const exposure = (globalText, projectText, trusted = true) => readExposureWarning(AGENT, PROJECT, trusted, { readFile: files(globalText, projectText) });
const missing = (globalText, projectText, trusted = true, registered = false) =>
  readMissingServerWarning(AGENT, PROJECT, trusted, registered, { readFile: files(globalText, projectText) });

const tempDirs = [];
function scratch(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// --- The surface is three reads, and no writer at all ---

test('S5: the module exposes the two warnings and the missing-server read, and no way to edit a configuration', () => {
  assert.deepEqual(Object.keys(mcp).sort(), ['isCodegraphServerMissing', 'readExposureWarning', 'readMissingServerWarning']);
});

// --- Exposure ---

test('S5: a direct explore setting is no warning at all', () => {
  assert.equal(exposure(DIRECT), undefined);
});

test('S5: explicit incompatible explore settings are reported, never overridden', () => {
  for (const selected of ['codemode', 'deferred', 'hidden']) {
    assert.equal(exposure(base({ command: 'codegraph', exposure: 'codemode', toolExposure: { codegraph_explore: selected } })), selected);
  }
});

test('S5: hiding a server with a direct explore exception warns that explore remains exposed', () => {
  assert.equal(exposure(base({ command: 'codegraph', exposure: 'hidden', toolExposure: { codegraph_explore: 'direct' } })), 'hidden-with-direct');
});

test('S5: a server-wide exposure other than direct is reported', () => {
  assert.equal(exposure(base({ command: 'codegraph' })), 'codemode');
  assert.equal(exposure(base({ command: 'codegraph', exposure: 'deferred' })), 'deferred');
  assert.equal(exposure(base({ command: 'codegraph', exposure: 'hidden' })), 'hidden');
});

test('S5: a disabled or hidden server is reported', () => {
  assert.equal(exposure(base({ command: 'codegraph', enabled: false })), 'disabled');
  assert.equal(exposure(base({ command: 'codegraph', exposure: 'hidden' })), 'hidden');
});

test('S5: wildcard choices are respected', () => {
  assert.equal(exposure(base({ command: 'codegraph', toolExposure: { 'codegraph_*': 'hidden' } })), 'hidden');
  assert.equal(exposure(base({ command: 'codegraph', toolExposure: { 'codegraph_*': 'direct' } })), undefined);
  assert.equal(exposure(base({ command: 'codegraph', toolExposure: { 'codegraph_*': 'deferred' } })), 'deferred');
});

test('S5: a config without a CodeGraph server has no exposure to warn about', () => {
  assert.equal(exposure(JSON.stringify({ mcpServers: { engram: { command: 'node' } } })), undefined);
  assert.equal(exposure('{}'), undefined);
});

test('S5: invalid or unexpected configuration is not a warning and never throws', () => {
  for (const text of ['', 'not json', '[]', 'null', '{"mcpServers":[]}', '{"mcpServers":{"codegraph":"x"}}']) {
    assert.equal(exposure(text), undefined, JSON.stringify(text));
  }
});

test('S5: an untrusted project configuration is ignored', () => {
  const project = JSON.stringify({ mcpServers: { codegraph: { toolExposure: { codegraph_explore: 'hidden' } } } });
  assert.equal(exposure(DIRECT, project, false), undefined);
  assert.equal(exposure(DIRECT, project, true), 'hidden');
});

test('S5: a trusted project override is inspected on top of the global configuration', () => {
  const project = JSON.stringify({ mcpServers: { codegraph: { exposure: 'hidden' } } });
  assert.equal(exposure(DIRECT, project, true), 'hidden-with-direct');
  assert.equal(exposure(DIRECT, undefined, true), undefined);
});

test('S5: a project server definition replaces the global definition', () => {
  const hidden = base({ command: 'codegraph', toolExposure: { codegraph_explore: 'hidden' } });
  const replacing = JSON.stringify({ mcpServers: { codegraph: { command: 'other', toolExposure: { codegraph_explore: 'direct' } } } });
  assert.equal(exposure(hidden, replacing, true), undefined);
  // A replacement that states nothing about exposure falls back to the default, codemode.
  const plain = JSON.stringify({ mcpServers: { codegraph: { command: 'other' } } });
  assert.equal(exposure(DIRECT, plain, true), 'codemode');
});

test('S5: reading global and trusted project settings changes nothing on disk', () => {
  const agent = scratch('odd-mcp-agent-');
  const project = scratch('odd-mcp-project-');
  fs.mkdirSync(path.join(project, '.pi'));
  fs.writeFileSync(path.join(agent, 'mcp.json'), DIRECT);
  fs.writeFileSync(path.join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { codegraph: { exposure: 'hidden' } } }));
  const before = fs.readFileSync(path.join(project, '.pi', 'mcp.json'), 'utf8');
  assert.equal(readExposureWarning(agent, project, false), undefined);
  assert.equal(readExposureWarning(agent, project, true), 'hidden-with-direct');
  assert.equal(fs.readFileSync(path.join(project, '.pi', 'mcp.json'), 'utf8'), before);
});

// --- A missing server ---

test('S5: a missing CodeGraph server is detected, and the other servers are left alone', () => {
  const input = JSON.stringify({ mcpServers: { other: { command: 'node' } } });
  const before = input;
  assert.equal(isCodegraphServerMissing(input), true);
  assert.equal(input, before, 'the read never rewrites the text it was given');
  assert.equal(isCodegraphServerMissing('{}'), true);
});

test('S5: global, project or extension-registered CodeGraph servers are not missing', () => {
  assert.equal(isCodegraphServerMissing(base({ command: 'codegraph' })), false);
  assert.equal(isCodegraphServerMissing('{}', base({ command: 'codegraph' })), false);
  assert.equal(isCodegraphServerMissing('{}', undefined, true), false);
});

test('S5: a project-only override without a server definition remains missing', () => {
  const project = JSON.stringify({ mcpServers: { codegraph: { exposure: 'direct' } } });
  assert.equal(isCodegraphServerMissing('{}', project), true);
});

test('S5: disabled or malformed settings are not misreported as an absent server', () => {
  assert.equal(isCodegraphServerMissing(base({ command: 'codegraph', enabled: false })), false);
  assert.equal(isCodegraphServerMissing('not json'), false);
  assert.equal(isCodegraphServerMissing('{}', 'not json'), false);
});

test('S5: a missing server is reported without creating a configuration, and untrusted projects are ignored', () => {
  const agent = scratch('odd-mcp-empty-agent-');
  const project = scratch('odd-mcp-trusted-project-');
  fs.mkdirSync(path.join(project, '.pi'));
  const config = JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' } } });
  fs.writeFileSync(path.join(project, '.pi', 'mcp.json'), config);
  assert.equal(readMissingServerWarning(agent, project, false), true);
  assert.equal(readMissingServerWarning(agent, project, true), false);
  assert.equal(readMissingServerWarning(agent, project, false, true), false);
  assert.equal(fs.existsSync(path.join(agent, 'mcp.json')), false);
  assert.equal(fs.readFileSync(path.join(project, '.pi', 'mcp.json'), 'utf8'), config);
});

test('S5: MCP is optional: no server at all is a warning, never a failure', () => {
  const agent = scratch('odd-mcp-none-agent-');
  const project = scratch('odd-mcp-none-project-');
  assert.equal(readMissingServerWarning(agent, project, true), true);
  assert.equal(readExposureWarning(agent, project, true), undefined);
  assert.deepEqual(fs.readdirSync(agent), []);
  assert.deepEqual(fs.readdirSync(project), []);
});

test('S5: an unreadable configuration is an invalid one, not an absent server', () => {
  const unreadable = () => {
    const error = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    throw error;
  };
  assert.equal(readMissingServerWarning(AGENT, PROJECT, true, false, { readFile: unreadable }), false);
  assert.equal(readExposureWarning(AGENT, PROJECT, true, { readFile: unreadable }), undefined);
});

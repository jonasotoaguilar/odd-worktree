'use strict';
// Shared loader for the standalone extension: the extension is plain JS under
// a .ts name, so a test copies it to a scratch .mjs with the two Pi package
// imports stubbed and imports it with a fake `pi` object. The lib override
// points the copied module at this package's own lib/ directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The CodeGraph wiring writes `<agent dir>/mcp.json` and `<config home>/tools.json` when a session
// starts, so no suite may reach the developer's real Pi directories: every process that loads this
// fixture gets scratch ones, removed when it exits. A suite that needs its own sets them itself.
const scratchPi = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-fixture-pi-'));
process.env.PI_CODING_AGENT_DIR = path.join(scratchPi, 'agent');
process.env.GENTLE_PI_CONFIG_HOME = path.join(scratchPi, 'gentle-ai');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.mkdirSync(process.env.GENTLE_PI_CONFIG_HOME, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(scratchPi, { recursive: true, force: true });
  } catch {
    // A scratch directory that cannot be removed is the OS temp directory's to clean.
  }
});

const LIB_DIR = path.resolve(__dirname, '../../lib');
const SRC = path.resolve(__dirname, '../../extensions/odd-worktree-tools.ts');
// The shell API's real slot, read here the way the extension and its own suites read
// it: the one published object, never an import.
const SHELL_SLOT = Symbol.for('odd-worktree/shell-api/v1');

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

// The stubbed source is read once per process; a test that asserts on the
// source itself can read SRC directly.
//
// S2/S3 (native-shell API T5): the entry statically imports the shell API from
// `../lib/shell-api/extension.ts` — odd-worktree's own code, which publishes the API slot at
// module load and arms the shell surfaces. A plain-JS suite may import neither a `.ts` file nor
// its TypeScript graph, so that import is stubbed here exactly like the two Pi package imports:
// the scratch `.mjs` gets a no-op factory and the slot is whatever the fixture publishes (see
// `installDefaultShellApi`).
const SHELL_API_IMPORT = 'import shellApiExtension from "../lib/shell-api/extension.ts";';
const SHELL_API_STUB = 'const shellApiExtension = () => {};';

function stubOnce(source, needle, replacement) {
  if (source.includes(needle) === false) return null;
  return source.split(needle).join(replacement);
}

let cached = null;
function stubbedSource() {
  if (cached !== null) return cached;
  const srcText = fs.readFileSync(SRC, 'utf8');
  const stubbedType = stubOnce(srcText, 'import { Type } from "@earendil-works/pi-ai";', TYPE_STUB);
  const stubbedTool = stubOnce(stubbedType === null ? srcText : stubbedType,
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;');
  const stubbed = stubOnce(stubbedTool === null ? srcText : stubbedTool, SHELL_API_IMPORT, SHELL_API_STUB);
  if (stubbedType === null || stubbedTool === null || stubbed === null || stubbed === srcText) {
    throw new Error('expected all imports stubbed: the two Pi package imports and the vendored shell API import');
  }
  cached = stubbed;
  return cached;
}

// S18 (issues-startup-performance T14) as amended by native-shell API T2/T5: the shell API is
// NATIVE (`lib/shell-api/`, stubbed out of this plain-JS copy), so a host double
// that publishes nothing on the slot gets an extension that registers NOTHING — every suite
// here would then be asserting nothing. The fake host therefore HAS the shell API:
// `defaultShellApi()` is the published object with the schema and version the code validates
// and the members the surfaces this package contributes actually use — the rail's
// `registerSection`, the `Cards` rows' `registerRows`, the design's `registerToolDesign`, the
// picker's keymap action and palette row, and the store. Nothing here weakens
// `issuesSidebarShellApi()`'s slot check: the object is a real enough shell API, not a thin one.
//
// `loadExtension(pi, { shellApi: false })` is the opt-out for a suite that must
// prove the absent-or-incompatible case: it publishes nothing and touches no slot, so the
// test itself decides what is on it.
function defaultShellApi() {
  const sections = [];
  const rows = [];
  const designs = [];
  const keymaps = [];
  const commands = [];
  const api = {
    schema: 'odd-worktree/shell-api',
    version: 1,
    registerSection: (section) => {
      sections.push(section);
      return () => {};
    },
    registerRows: (registration) => {
      rows.push(registration);
      return () => {};
    },
    registerToolDesign: (design) => {
      designs.push(design);
      return () => {};
    },
    // The picker's two optional members: present, but this shell API resolves no key,
    // so no suite that did not ask for one gets a shortcut bound.
    registerKeymap: (registration) => {
      keymaps.push(registration);
      return () => {};
    },
    registerCommands: (registration) => {
      commands.push(registration);
      return () => {};
    },
    resolveKeymap: () => ({ unavailable: 'the default test shell API publishes no key' }),
    // All three modules default Off in the real store, so this bridge stores them On: every suite that
    // loads the extension without asking about the switches keeps loading the whole package.
    createStore: () => ({
      get: (key) => (key === 'modules' ? { codegraph: true, worktrees: true, skills: true } : undefined),
      set: () => {},
      delete: () => {},
    }),
    requestRepaint: () => {},
  };
  return { api, sections, rows, designs, keymaps, commands };
}

// Publish the default shell API on the real slot, unless a suite already published
// its own (a suite's fake always wins: it is the one that shell API's assertions
// measure). The published object is left in place afterwards, exactly like a real
// shell API's: it is the host's, not this load's.
function installDefaultShellApi() {
  if (globalThis[SHELL_SLOT] !== undefined && globalThis[SHELL_SLOT] !== null) return null;
  const shellApi = defaultShellApi();
  globalThis[SHELL_SLOT] = shellApi.api;
  return shellApi;
}

// S13 (issues-startup-performance T11, corrected): the two issues surfaces are
// registered ONLY when the local presence probe finds `gh`, so a suite that asserts
// on a surface which exists must not depend on the machine it runs on. That probe
// is the real one — a directory walk over `process.env.PATH`, no child — and the
// extension compiles its own `lib/gh-issues.js` instance per load (it purges the
// lib require cache), so a `setGhWhich` seam set here could never reach it: PATH is
// the lever, exactly as it is in production.
//
// `ghPath(mode)` builds the directory that answers the probe — `present` writes an
// executable `gh` stub, `absent` writes nothing — and `withGhPath` puts it on PATH
// for the length of one call and restores the environment afterwards.
function ghPath(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `odd-gh-${mode}-`));
  if (mode === 'present') {
    const file = path.join(dir, process.platform === 'win32' ? 'gh.EXE' : 'gh');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

async function withGhPath(mode, run) {
  const saved = process.env.PATH;
  const dir = ghPath(mode === 'absent' ? 'absent' : 'present');
  // `absent` means NOTHING on PATH: prepending an empty directory would still let
  // the probe find the real `gh` further down, and this suite proves what a host
  // without the CLI registers — which is nothing, so no lookup may succeed.
  process.env.PATH = mode === 'absent' ? dir : `${dir}${path.delimiter}${saved === undefined ? '' : saved}`;
  try {
    settleInstall();
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Load the extension with the injected `pi` double. Returns the registered
// commands and tools keyed by name, exactly as the host received them.
//
// S18 (T14): the slot is checked ONCE, in the factory, and the vendored shell API's own factory
// is stubbed here (no `.ts` may be imported by a plain-JS suite), so the fixture publishes the
// shell API BEFORE the factory runs. With no shell API the extension registers nothing at all, so a
// suite that wants that passes `{ shellApi: false }`.
//
// S13 (T11): `gh` is present on PATH unless the suite passes `{ gh: false }`, for the
// same reason — the issues surfaces do not exist without it.
async function loadExtension(pi, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.shellApi !== false) installDefaultShellApi();
  return withGhPath(opts.gh === false ? 'absent' : 'present', () => loadWithPath(pi));
}

// The scratch directories hold what a settled install leaves, for the PATH this load runs under, so a session start in a
// suite that asserts silence has nothing to report: with the CodeGraph CLI on PATH the MCP entry and the agents' tools.json
// are already right, without it there is nothing to add and nothing to take out.
function settleInstall() {
  const mcp = path.join(process.env.PI_CODING_AGENT_DIR, 'mcp.json');
  const tools = path.join(process.env.GENTLE_PI_CONFIG_HOME, 'tools.json');
  if (require('../../lib/which-command.js').whichCommand('codegraph', { env: process.env }) === null) {
    fs.rmSync(mcp, { force: true });
    fs.writeFileSync(tools, '{}');
    return;
  }
  const { CODEGRAPH_SERVER } = require('../../lib/codegraph-mcp-config.js');
  const { CODEGRAPH_AGENTS, CODEGRAPH_SERVER_TOOL } = require('../../lib/codegraph-agent-tools.js');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { codegraph: CODEGRAPH_SERVER } }));
  fs.writeFileSync(tools, JSON.stringify(Object.fromEntries(CODEGRAPH_AGENTS.map((name) => [name, { add: [CODEGRAPH_SERVER_TOOL] }]))));
}

async function loadWithPath(pi) {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-worktree-ext-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const factory = (await import(pathToFileURL(copy).href)).default;
    const commands = new Map();
    const tools = new Map();
    const messageRenderers = new Map();
    const entryRenderers = new Map();
    const entries = [];
    const hooks = [];
    const host = {
      registerCommand: (name, handler) => { commands.set(name, handler); },
      registerTool: (tool) => { tools.set(tool.name, tool); },
      registerMessageRenderer: (type, renderer) => { messageRenderers.set(type, renderer); },
      registerEntryRenderer: (type, renderer) => { entryRenderers.set(type, renderer); },
      appendEntry: (customType, data) => { entries.push({ customType, data }); },
      on: (event, handler) => { hooks.push([event, handler]); },
      ...pi,
    };
    factory(host);
    return { commands, tools, messageRenderers, entryRenderers, entries, hooks, host };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  LIB_DIR,
  SRC,
  SHELL_SLOT,
  SHELL_API_IMPORT,
  SHELL_API_STUB,
  loadExtension,
  stubbedSource,
  defaultShellApi,
  installDefaultShellApi,
  ghPath,
  withGhPath,
};

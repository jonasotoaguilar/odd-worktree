'use strict';
// Shared loader for the standalone extension: the extension is plain JS under
// a .ts name, so a test copies it to a scratch .mjs with the two Pi package
// imports stubbed and imports it with a fake `pi` object. The lib override
// points the copied module at this package's own lib/ directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../../lib');
const SRC = path.resolve(__dirname, '../../extensions/odd-worktree-tools.ts');
// The bridge's real slot, read here the way the extension and its own suites read
// it: the one published object, never an import.
const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');

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
// S2/S3 (native-bridge T2): the entry statically imports the VENDORED bridge from
// `../lib/bridge/src/extension.ts`, which publishes the API slot at module load and owns
// the bridge's runtime. A plain-JS suite may import neither a `.ts` file nor the bridge's
// own TypeScript graph, so that import is stubbed here exactly like the two Pi package
// imports: the scratch `.mjs` gets a no-op factory and the slot is whatever the fixture
// publishes (see `installDefaultBridge`).
const BRIDGE_IMPORT = 'import bridgeExtension from "../lib/bridge/src/extension.ts";';
const BRIDGE_STUB = 'const bridgeExtension = () => {};';

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
  const stubbed = stubOnce(stubbedTool === null ? srcText : stubbedTool, BRIDGE_IMPORT, BRIDGE_STUB);
  if (stubbedType === null || stubbedTool === null || stubbed === null || stubbed === srcText) {
    throw new Error('expected all imports stubbed: the two Pi package imports and the vendored bridge import');
  }
  cached = stubbed;
  return cached;
}

// S18 (issues-startup-performance T14) as amended by native-bridge T2: the bridge is
// NVATIVE (vendored at `lib/bridge/`, stubbed out of this plain-JS copy), so a host double
// that publishes nothing on the slot gets an extension that registers NOTHING — every suite
// here would then be asserting nothing. The fake host therefore HAS the bridge:
// `defaultBridge()` is the published object with the schema and version the code validates
// and the members the surfaces this package contributes actually use — the rail's
// `registerSection`, the `Cards` rows' `registerRows`, the design's `registerToolDesign`, the
// picker's keymap action and palette row, and the store. Nothing here weakens
// `issuesSidebarBridge()`'s slot check: the object is a real enough bridge, not a thin one.
//
// `loadExtension(pi, { bridge: false })` is the opt-out for a suite that must
// prove the absent-or-incompatible case: it publishes nothing and touches no slot, so the
// test itself decides what is on it.
function defaultBridge() {
  const sections = [];
  const rows = [];
  const designs = [];
  const keymaps = [];
  const commands = [];
  const api = {
    schema: 'gentle-shell-bridge/api',
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
    // The picker's two optional members: present, but this bridge resolves no key,
    // so no suite that did not ask for one gets a shortcut bound.
    registerKeymap: (registration) => {
      keymaps.push(registration);
      return () => {};
    },
    registerCommands: (registration) => {
      commands.push(registration);
      return () => {};
    },
    resolveKeymap: () => ({ unavailable: 'the default test bridge publishes no key' }),
    createStore: () => ({
      get: () => undefined,
      set: () => {},
      delete: () => {},
    }),
    requestRepaint: () => {},
  };
  return { api, sections, rows, designs, keymaps, commands };
}

// Publish the default bridge on the real slot, unless a suite already published
// its own (a suite's fake always wins: it is the one that bridge's assertions
// measure). The published object is left in place afterwards, exactly like a real
// bridge's: it is the host's, not this load's.
function installDefaultBridge() {
  if (globalThis[BRIDGE_SLOT] !== undefined && globalThis[BRIDGE_SLOT] !== null) return null;
  const bridge = defaultBridge();
  globalThis[BRIDGE_SLOT] = bridge.api;
  return bridge;
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
// S18 (T14): the slot is checked ONCE, in the factory, and the vendored bridge's own factory
// is stubbed here (no `.ts` may be imported by a plain-JS suite), so the fixture publishes the
// bridge BEFORE the factory runs. With no bridge the extension registers nothing at all, so a
// suite that wants that passes `{ bridge: false }`.
//
// S13 (T11): `gh` is present on PATH unless the suite passes `{ gh: false }`, for the
// same reason — the issues surfaces do not exist without it.
async function loadExtension(pi, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.bridge !== false) installDefaultBridge();
  return withGhPath(opts.gh === false ? 'absent' : 'present', () => loadWithPath(pi));
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
  BRIDGE_SLOT,
  BRIDGE_IMPORT,
  BRIDGE_STUB,
  loadExtension,
  stubbedSource,
  defaultBridge,
  installDefaultBridge,
  ghPath,
  withGhPath,
};

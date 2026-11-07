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
let cached = null;
function stubbedSource() {
  if (cached !== null) return cached;
  const srcText = fs.readFileSync(SRC, 'utf8');
  const stubbed = srcText
    .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
    .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
  if (stubbed === srcText) throw new Error('expected both Pi package import lines to be stubbed');
  cached = stubbed;
  return cached;
}

// Load the extension with the injected `pi` double. Returns the registered
// commands and tools keyed by name, exactly as the host received them.
async function loadExtension(pi) {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-worktree-ext-'));
  try {
    const copy = path.join(dir, 'odd-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbedSource());
    const factory = (await import(pathToFileURL(copy).href)).default;
    const commands = new Map();
    const tools = new Map();
    const messageRenderers = new Map();
    const hooks = [];
    const host = {
      registerCommand: (name, handler) => { commands.set(name, handler); },
      registerTool: (tool) => { tools.set(tool.name, tool); },
      registerMessageRenderer: (type, renderer) => { messageRenderers.set(type, renderer); },
      on: (event, handler) => { hooks.push([event, handler]); },
      ...pi,
    };
    factory(host);
    return { commands, tools, messageRenderers, hooks, host };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { LIB_DIR, SRC, loadExtension, stubbedSource };

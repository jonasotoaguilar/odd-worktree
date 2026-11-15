'use strict';
// S12: the one entry this package may write in the user's MCP configuration.
//
// `ensureCodegraphServer` makes `mcpServers.codegraph` of `<agent dir>/mcp.json` carry the three fields CodeGraph's
// explore tool needs (`command`, `args`, `toolExposure.codegraph_explore`). It adds the entry when it is missing, fixes
// only the fields that differ, and keeps every other server, key and field. The file is rewritten only when something
// changed, atomically (a temp file in the same directory, then a rename) and with its permission bits; a file that is
// not valid JSON, or whose `mcpServers` is not an object, is left untouched and reported. The configuration may hold
// secrets, so nothing here logs or returns its contents: a result carries a status and the names of the fields changed.

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const CONFIG_FILE = 'mcp.json';

/** The entry CodeGraph's explore tool needs; the format of the file around it is irrelevant. */
const CODEGRAPH_SERVER = Object.freeze({
  command: 'codegraph',
  args: Object.freeze(['serve', '--mcp']),
  toolExposure: Object.freeze({ codegraph_explore: 'direct' }),
});

function mcpConfigPath(agentDir) {
  return nodePath.join(agentDir, CONFIG_FILE);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameArgs = (value) =>
  Array.isArray(value) && value.length === CODEGRAPH_SERVER.args.length && value.every((arg, i) => arg === CODEGRAPH_SERVER.args[i]);

/** The indentation of an existing document, so a rewrite keeps the shape the user chose. */
function indentOf(text) {
  const match = /\n([ \t]+)"/.exec(text);
  return match ? match[1] : 2;
}

/**
 * The entry as it must be, and the names of the fields that changed to get there. Every field the user added is kept;
 * only the three CodeGraph needs are set.
 */
function repairedEntry(current) {
  const changes = [];
  const entry = isObject(current) ? { ...current } : {};
  if (entry.command !== CODEGRAPH_SERVER.command) {
    entry.command = CODEGRAPH_SERVER.command;
    changes.push('command');
  }
  if (!sameArgs(entry.args)) {
    entry.args = [...CODEGRAPH_SERVER.args];
    changes.push('args');
  }
  const exposure = isObject(entry.toolExposure) ? { ...entry.toolExposure } : {};
  if (exposure.codegraph_explore !== CODEGRAPH_SERVER.toolExposure.codegraph_explore) {
    exposure.codegraph_explore = CODEGRAPH_SERVER.toolExposure.codegraph_explore;
    entry.toolExposure = exposure;
    changes.push('toolExposure.codegraph_explore');
  }
  return { entry, changes };
}

async function readText(fs, file) {
  try {
    return { text: await fs.readFile(file, 'utf8') };
  } catch (error) {
    return { error };
  }
}

async function writeAtomically(fs, file, text, mode) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode });
    // writeFile keeps the umask on a new file, so the mode is applied again: the original's bits, or owner-only.
    await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Ensures the CodeGraph entry of the global MCP configuration. Resolves, never throws:
 * `unchanged` | `added` | `fixed` (with `changes`) | `skipped` (no agent directory) | `invalid` (left untouched) |
 * `unreadable` (left untouched) | `failed` (the write failed; the original is intact).
 */
async function ensureCodegraphServer(options = {}) {
  const fs = options.fs || nodeFs.promises;
  const agentDir = options.agentDir;
  try {
    if (typeof agentDir !== 'string' || agentDir.length === 0) return { status: 'skipped' };
    const file = mcpConfigPath(agentDir);
    const read = await readText(fs, file);

    let config;
    let indent = 2;
    let mode = 0o600;
    if (read.error) {
      if (read.error.code !== 'ENOENT') return { status: 'unreadable' };
      const directory = await fs.stat(agentDir).catch(() => undefined);
      if (!directory || !directory.isDirectory()) return { status: 'skipped' };
      config = {};
    } else {
      try {
        config = JSON.parse(read.text);
      } catch {
        return { status: 'invalid' };
      }
      if (!isObject(config)) return { status: 'invalid' };
      indent = indentOf(read.text);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat) mode = stat.mode & 0o777;
    }

    const servers = config.mcpServers;
    if (servers !== undefined && !isObject(servers)) return { status: 'invalid' };

    const had = isObject(servers) && servers.codegraph !== undefined;
    const { entry, changes } = repairedEntry(had ? servers.codegraph : undefined);
    if (had && changes.length === 0) return { status: 'unchanged' };

    const next = { ...config, mcpServers: { ...(isObject(servers) ? servers : {}), codegraph: entry } };
    try {
      await writeAtomically(fs, file, `${JSON.stringify(next, null, indent)}\n`, mode);
    } catch {
      return { status: 'failed' };
    }
    return had ? { status: 'fixed', changes } : { status: 'added', changes };
  } catch {
    return { status: 'failed' };
  }
}

module.exports = { CODEGRAPH_SERVER, CONFIG_FILE, mcpConfigPath, ensureCodegraphServer };

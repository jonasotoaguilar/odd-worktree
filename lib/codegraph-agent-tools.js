'use strict';
// S2/S3: the other file this package may write for CodeGraph, next to the MCP entry of `codegraph-mcp-config.js`.
//
// Gentle Shell reads `<config home>/tools.json` as a per-agent overlay on the tools a subagent is given, and a child
// only reaches an MCP tool through the SERVER name (`mcp__codegraph`), never through the tool's own name. So while
// `Codegraph+` is On and the CLI is installed, the four CodeGraph agents carry `mcp__codegraph` in their `add` list;
// Off, or a missing CLI, takes it out. Both directions touch nothing else: another agent, another tool name, a `remove`
// list, an unknown key and the file's indentation and permission bits stay as they are, a file already right is not
// rewritten, an invalid one is left alone, and an agent whose own `remove` list names the server keeps the user's
// decision. The write is atomic (`codegraph-mcp-config.js`). Nothing here logs or returns the file's contents.

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { cardStyleHome } = require('./card-style.js');
const { whichCommand } = require('./which-command.js');
const { ensureCodegraphServer, indentOf, writeAtomically } = require('./codegraph-mcp-config.js');

const TOOLS_FILE = 'tools.json';
const CODEGRAPH_SERVER_TOOL = 'mcp__codegraph';
/** The agents whose prompt carries CodeGraph text (`codegraph-rules.js`) and that can use the tool: judges declare it themselves. */
const CODEGRAPH_AGENTS = Object.freeze(['gentle-ai-explore', 'gentle-ai-verify', 'gentle-ai-worker', 'jd-fix-agent']);
const CHILD_ENV = 'GENTLE_PI_AGENTS_CHILD';
const DEFAULT_MODE = 0o644;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The server and any of its tools: the old exact-tool spelling is dropped on Off, never added on On. */
const isCodegraphTool = (name) => typeof name === 'string'
  && (name === CODEGRAPH_SERVER_TOOL || name.startsWith(`${CODEGRAPH_SERVER_TOOL}__`));

function toolsConfigPath(configHome) {
  return nodePath.join(configHome, TOOLS_FILE);
}

/** The document with the server added to each CodeGraph agent that can take it, and the agents that changed. */
function withServer(config) {
  const next = { ...config };
  const changed = [];
  for (const agent of CODEGRAPH_AGENTS) {
    const current = config[agent];
    if (current === undefined) {
      next[agent] = { add: [CODEGRAPH_SERVER_TOOL] };
      changed.push(agent);
      continue;
    }
    if (!isObject(current)) continue;
    if (Array.isArray(current.remove) && current.remove.includes(CODEGRAPH_SERVER_TOOL)) continue;
    if (current.add !== undefined && !Array.isArray(current.add)) continue;
    const add = Array.isArray(current.add) ? current.add : [];
    if (add.includes(CODEGRAPH_SERVER_TOOL)) continue;
    next[agent] = { ...current, add: [...add, CODEGRAPH_SERVER_TOOL] };
    changed.push(agent);
  }
  return { next, changed };
}

/** The document without the server (and its tool spellings) in the CodeGraph agents; an entry left empty goes away. */
function withoutServer(config) {
  const next = { ...config };
  const changed = [];
  for (const agent of CODEGRAPH_AGENTS) {
    const current = config[agent];
    if (!isObject(current) || !Array.isArray(current.add)) continue;
    const kept = current.add.filter((name) => !isCodegraphTool(name));
    if (kept.length === current.add.length) continue;
    const entry = { ...current };
    if (kept.length > 0) entry.add = kept;
    else delete entry.add;
    if (Object.keys(entry).length === 0) delete next[agent];
    else next[agent] = entry;
    changed.push(agent);
  }
  return { next, changed };
}

async function readText(fs, file) {
  try {
    return { text: await fs.readFile(file, 'utf8') };
  } catch (error) {
    return { error };
  }
}

/**
 * Makes `tools.json` of one config home carry (`enabled`) or not carry the CodeGraph server. Resolves, never throws:
 * `created` | `updated` (with the `agents` that changed) | `unchanged` | `skipped` (no config home) | `invalid` (left
 * untouched) | `unreadable` (left untouched) | `failed` (the write failed; the original is intact).
 */
async function reconcileAgentTools(options = {}) {
  const fs = options.fs || nodeFs.promises;
  const configHome = options.configHome;
  const enabled = options.enabled === true;
  try {
    if (typeof configHome !== 'string' || configHome.length === 0) return { status: 'skipped', agents: [] };
    const file = toolsConfigPath(configHome);
    const read = await readText(fs, file);

    let config = {};
    let indent = 2;
    let mode = DEFAULT_MODE;
    if (read.error) {
      if (read.error.code !== 'ENOENT') return { status: 'unreadable', agents: [] };
      // Nothing to take out of a file that is not there, and no config home means Gentle Shell is not installed.
      if (!enabled) return { status: 'unchanged', agents: [] };
      const directory = await fs.stat(configHome).catch(() => undefined);
      if (!directory || !directory.isDirectory()) return { status: 'skipped', agents: [] };
    } else {
      try {
        config = JSON.parse(read.text);
      } catch {
        return { status: 'invalid', agents: [] };
      }
      if (!isObject(config)) return { status: 'invalid', agents: [] };
      indent = indentOf(read.text);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat) mode = stat.mode & 0o777;
    }

    const { next, changed } = enabled ? withServer(config) : withoutServer(config);
    if (changed.length === 0) return { status: 'unchanged', agents: [] };
    try {
      await writeAtomically(fs, file, `${JSON.stringify(next, null, indent)}\n`, mode);
    } catch {
      return { status: 'failed', agents: [] };
    }
    return { status: read.error ? 'created' : 'updated', agents: changed };
  } catch {
    return { status: 'failed', agents: [] };
  }
}

function notifier(ctx) {
  return (notice) => {
    try {
      if (notice && ctx && ctx.ui && typeof ctx.ui.notify === 'function') ctx.ui.notify(notice.text, notice.level);
    } catch {
      // A dead UI never fails the check.
    }
  };
}

/** What the user is told about `tools.json`; a file already right says nothing. */
function toolsNotice(result, enabled) {
  if (!result) return undefined;
  if (result.status === 'created' || result.status === 'updated') {
    return {
      text: enabled
        ? 'CodeGraph added to the agents in tools.json · run /reload to apply'
        : 'CodeGraph removed from the agents in tools.json · run /reload to apply',
      level: 'info',
    };
  }
  if (result.status === 'invalid' || result.status === 'unreadable' || result.status === 'failed') {
    return { text: `could not check tools.json (${result.status}); the file was left untouched`, level: 'warning' };
  }
  return undefined;
}

/**
 * The session-start check: once per process, in the primary session only, `tools.json` is made to follow what is true now —
 * `Codegraph+` On AND the CLI installed adds the entry; anything else takes it out. A switch changed while no session ran,
 * or a CLI that went away, is corrected here. Never awaited by the host, never able to fail it.
 */
function registerAgentToolsSync(pi, deps = {}) {
  const env = deps.env || process.env;
  if (typeof pi?.on !== 'function') return { registered: false };
  if (env[CHILD_ENV] === '1') return { registered: false };
  const hasCli = typeof deps.hasCli === 'function' ? deps.hasCli : () => whichCommand('codegraph', { env }) !== null;
  const impl = { reconcileAgentTools, ...(deps.impl || {}) };
  let checked = false;
  const check = async (ctx) => {
    try {
      const enabled = deps.enabled === true && hasCli() === true;
      const result = await impl.reconcileAgentTools({ configHome: cardStyleHome(env), enabled });
      notifier(ctx)(toolsNotice(result, enabled));
    } catch {
      // The overlay is never worth stopping a session.
    }
  };
  // The host does not await a session_start handler and rejects one that returns a promise: the check is started, not returned.
  pi.on('session_start', (_event, ctx) => {
    if (checked) return;
    checked = true;
    void check(ctx);
  });
  return { registered: true };
}

/**
 * The moment `Codegraph+` is switched: On ensures the MCP entry in `<agent dir>/mcp.json` and adds the agents, so the next
 * `/reload` already has both; Off only takes the agents out and leaves the user's MCP configuration alone. One file's
 * failure never stops the other. Resolves with each file's status, never throws.
 */
async function applyCodegraphSwitch({ on, env = process.env, agentDir, configHome, impl = {} } = {}) {
  const ensure = impl.ensureCodegraphServer || ensureCodegraphServer;
  const reconcile = impl.reconcileAgentTools || reconcileAgentTools;
  const result = {};
  if (on === true) {
    try {
      result.mcp = await ensure({ agentDir });
    } catch {
      result.mcp = { status: 'failed' };
    }
  }
  try {
    result.tools = await reconcile({ configHome: configHome ?? cardStyleHome(env), enabled: on === true });
  } catch {
    result.tools = { status: 'failed', agents: [] };
  }
  return result;
}

module.exports = {
  CODEGRAPH_AGENTS,
  CODEGRAPH_SERVER_TOOL,
  TOOLS_FILE,
  applyCodegraphSwitch,
  reconcileAgentTools,
  registerAgentToolsSync,
  toolsConfigPath,
};

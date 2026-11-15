'use strict';
// The MCP side of CodeGraph: read the configuration, say what would hide the explore tool and whether a server
// is registered at all. This module never writes it — the user's mcp.json stays the user's — and MCP is optional:
// no server means a warning, not a failure, and a registered entry never proves a daemon is reachable (the
// registry in codegraph-daemon.js answers that).

const nodeFs = require('node:fs');
const { join } = require('node:path');

const EXPLORE = 'codegraph_explore';

function matchingExposure(entry) {
  const tools = entry.toolExposure;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return undefined;
  if (typeof tools[EXPLORE] === 'string') return tools[EXPLORE];
  for (const [pattern, exposure] of Object.entries(tools)) {
    if (!pattern.includes('*') || typeof exposure !== 'string') continue;
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (regex.test(EXPLORE)) return exposure;
  }
  return undefined;
}

function codegraphServer(text) {
  try {
    const config = JSON.parse(text);
    const entry = config?.mcpServers?.codegraph;
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Missing is distinct from disabled, invalid configuration and servers registered by extensions. */
function isCodegraphServerMissing(globalText, projectText, registered = false) {
  if (registered === true) return false;
  const read = (text) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const global = read(globalText);
  const project = projectText === undefined ? undefined : read(projectText);
  if (!global || (projectText !== undefined && !project)) return false;
  const hasServer = (config) => {
    const servers = config.mcpServers;
    return !!servers && typeof servers === 'object' && !Array.isArray(servers)
      && Object.prototype.hasOwnProperty.call(servers, 'codegraph');
  };
  if (hasServer(global)) return false;
  if (!project || !hasServer(project)) return true;
  const entry = project.mcpServers.codegraph;
  // A project-only override cannot create a server without a transport definition.
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return !('command' in entry || 'url' in entry || 'type' in entry);
  }
  return false; // Let Pi report an invalid server entry instead of claiming it is absent.
}

/** Explicit restrictions must be respected, not overridden silently. */
function inspectMcpExposure(text) {
  const entry = codegraphServer(text);
  if (!entry) return undefined;
  if (entry.enabled === false) return 'disabled';
  const selected = matchingExposure(entry);
  if (entry.exposure === 'hidden' && selected === 'direct') return 'hidden-with-direct';
  if (selected !== undefined) return selected === 'direct' ? undefined : selected;
  const exposure = typeof entry.exposure === 'string' ? entry.exposure : 'codemode';
  return exposure === 'direct' ? undefined : exposure;
}

/** Inspect the effective file configuration, including a trusted project's override when supplied. */
function inspectEffectiveMcpExposure(globalText, projectText) {
  const global = codegraphServer(globalText);
  const project = projectText === undefined ? undefined : codegraphServer(projectText);
  if (!project) return inspectMcpExposure(globalText);
  const replacement = 'command' in project || 'url' in project || 'type' in project;
  const entry = replacement ? project : { ...global, ...project };
  return inspectMcpExposure(JSON.stringify({ mcpServers: { codegraph: entry } }));
}

const codeOf = (error) => error?.code;

/**
 * What would hide the shipped explore tool, or undefined when it is reachable. Reads the effective file
 * configuration only — untrusted project configuration is not loaded by Pi — and changes neither file.
 */
function readExposureWarning(agentDir, cwd, projectTrusted, options = {}) {
  const readFile = options.readFile ?? nodeFs.readFileSync;
  const read = (path) => {
    try {
      return readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  const global = read(join(agentDir, 'mcp.json')) ?? '{}';
  const project = projectTrusted === true ? read(join(cwd, '.pi', 'mcp.json')) : undefined;
  return inspectEffectiveMcpExposure(global, project);
}

/**
 * Whether no CodeGraph server is registered anywhere it would count. Reads the files without creating them; a
 * read that fails for a reason other than "not there" is an invalid configuration, not an absent server.
 */
function readMissingServerWarning(agentDir, cwd, projectTrusted, registered = false, options = {}) {
  const readFile = options.readFile ?? nodeFs.readFileSync;
  const read = (path) => {
    try {
      return readFile(path, 'utf8');
    } catch (error) {
      return codeOf(error) === 'ENOENT' ? undefined : 'invalid';
    }
  };
  const global = read(join(agentDir, 'mcp.json')) ?? '{}';
  const project = projectTrusted === true ? read(join(cwd, '.pi', 'mcp.json')) : undefined;
  return isCodegraphServerMissing(global, project, registered === true);
}

module.exports = { readExposureWarning, readMissingServerWarning, isCodegraphServerMissing };

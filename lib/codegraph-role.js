'use strict';
// What a session may do with the project's index, read from the tool list the host requested for a subagent
// child (a child carries no agent name in its environment, only that list). The explorer reads only; verify and
// the judges read and run commands but write no file, so they never initiate an `init` or a `sync`; a worker or
// the primary session may. Navigation is not proof, and a read-only role must not change the index it reads.

const { holdsCodegraph } = require('./codegraph-rules.js');

const CHILD_ENV = 'GENTLE_PI_AGENTS_CHILD';
const REQUESTED_TOOLS_ENV = 'GENTLE_PI_AGENTS_REQUESTED_TOOLS';

/** Tools that write a file of the project: a role holding one of them may write the index too. */
const FILE_WRITING_TOOLS = ['edit', 'write', 'bash_background'];

/** Tools that run a command without writing a file through it: verify and the judges hold `bash`. */
const COMMAND_TOOLS = ['bash', 'bash_background'];

/** The tool list the host requested for a child, as one array; empty for the primary session. */
function requestedTools(env = process.env) {
  return String((env && env[REQUESTED_TOOLS_ENV]) || '')
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/**
 * The role of one declared tool list: `writer` (a file-writing tool wins), `read-only` (a command tool),
 * `explorer` (a CodeGraph tool and nothing else) or `unknown` (the list says nothing about CodeGraph).
 */
function indexRole(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.length === 0) return 'unknown';
  if (list.some((tool) => FILE_WRITING_TOOLS.includes(tool))) return 'writer';
  if (list.some((tool) => COMMAND_TOOLS.includes(tool))) return 'read-only';
  return holdsCodegraph(list) ? 'explorer' : 'unknown';
}

/** The role of this session: undefined in the primary session, which is not a subagent role. */
function sessionIndexRole(env = process.env) {
  return env && env[CHILD_ENV] === '1' ? indexRole(requestedTools(env)) : undefined;
}

/** Whether this role may start an index write at all: a read-only role (verify, the judges) may not. */
function mayInitiateIndexWrite(role) {
  return role !== 'read-only';
}

module.exports = {
  indexRole,
  sessionIndexRole,
  requestedTools,
  mayInitiateIndexWrite,
  FILE_WRITING_TOOLS,
  COMMAND_TOOLS,
};

'use strict';
// The index role of a session: which roles may start an index write at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indexRole, sessionIndexRole, requestedTools, mayInitiateIndexWrite } = require('../lib/codegraph-role.js');

const MCP = 'mcp__codegraph__codegraph_explore';

test('the role is read from the declared tools: a file-writing tool wins, then a command tool, then a CodeGraph tool', () => {
  assert.equal(indexRole(['read', 'grep', 'find', 'codegraph']), 'explorer');
  assert.equal(indexRole(['read', 'grep', 'find', MCP]), 'explorer');
  assert.equal(indexRole(['read', 'grep', 'find', 'bash', MCP]), 'read-only');
  assert.equal(indexRole(['read', 'grep', 'find', 'bash', 'edit', MCP]), 'writer');
  assert.equal(indexRole(['read', 'grep', 'find']), 'unknown');
  assert.equal(indexRole([]), 'unknown');
  assert.equal(indexRole(undefined), 'unknown');
});

test('only a read-only role may not start an index write', () => {
  assert.equal(mayInitiateIndexWrite('read-only'), false);
  for (const role of ['explorer', 'writer', 'unknown', undefined]) assert.equal(mayInitiateIndexWrite(role), true, String(role));
});

test('the primary session has no subagent role; a child gets the role of its requested tools', () => {
  assert.equal(sessionIndexRole({}), undefined);
  assert.equal(sessionIndexRole({ GENTLE_PI_AGENTS_CHILD: '0', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read' }), undefined);
  assert.equal(sessionIndexRole({ GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read,bash' }), 'read-only');
  assert.equal(sessionIndexRole({ GENTLE_PI_AGENTS_CHILD: '1', GENTLE_PI_AGENTS_REQUESTED_TOOLS: 'read, codegraph ' }), 'explorer');
  assert.deepEqual(requestedTools({ GENTLE_PI_AGENTS_REQUESTED_TOOLS: ' a, ,b ' }), ['a', 'b']);
});

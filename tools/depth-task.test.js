'use strict';
// The task `/depth` hands the explorer: the instructions of `lib/depth-prompt/depth.md`, then the request exactly as the
// person typed it (S1, S3, S8). The explorer has no chat, so the request is the only thing it will ever know of the
// person's words, and it comes back first in the handoff (S8, L8).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDepthTask, depthLabel, DEPTH_RETURN_HEADINGS, DEPTH_BANNER, DEPTH_FOR_PARENT } = require('../lib/depth-task.js');

const REQUEST = 'make the error messages clearer\n\n- keep «exactly» this: `/x failed:`\n- no retries';

test('the task is the instructions, then the request exactly as typed', () => {
  const task = buildDepthTask(REQUEST, { read: () => 'INSTRUCTIONS' });
  assert.ok(task.startsWith('INSTRUCTIONS'), 'the instructions lead');
  assert.ok(task.endsWith(`## Request\n\n${REQUEST}`), 'the request closes the task, byte for byte');
  assert.equal(task.split('## Request').length - 1, 1, 'one request section');
});

test('only the ends of the request are trimmed, never its inside', () => {
  const task = buildDepthTask('\n  a\n\n   b  \n\n', { read: () => 'I' });
  assert.ok(task.endsWith('## Request\n\na\n\n   b'));
});

test('a blank or non-string request builds no task', () => {
  for (const blank of ['', '   ', '\n\t\n', undefined, null, 5, {}]) {
    assert.equal(buildDepthTask(blank, { read: () => 'I' }), null);
  }
});

test('a missing or empty instructions file still gives a task that names every section', () => {
  const unreadable = () => {
    throw new Error('ENOENT');
  };
  for (const read of [unreadable, () => '', () => '  \n', () => undefined]) {
    const task = buildDepthTask(REQUEST, { read });
    assert.ok(task.endsWith(`## Request\n\n${REQUEST}`));
    for (const heading of DEPTH_RETURN_HEADINGS) assert.ok(task.includes(heading), `fallback names ${heading}`);
    assert.match(task, /Never carry the request out/);
  }
});

test('the shipped instructions name the return sections in order, and the parent closes them', () => {
  const task = buildDepthTask('x');
  let at = -1;
  for (const heading of DEPTH_RETURN_HEADINGS) {
    const next = task.indexOf(`\n${heading}\n`, at + 1);
    assert.ok(next > at, `${heading} appears after the previous section`);
    at = next;
  }
  assert.equal(DEPTH_RETURN_HEADINGS[0], '## Original request', 'the verbatim request leads the handoff');
  assert.equal(DEPTH_RETURN_HEADINGS.at(-1), '## For the parent', 'the line for the parent closes it');
  assert.match(task, /Do not implement/);
});

test('the label is one short line that starts with the command', () => {
  assert.equal(depthLabel('fix the login'), 'depth: fix the login');
  const long = depthLabel(`${'x'.repeat(200)}\nsecond line`);
  assert.ok(long.startsWith('depth: xxx') && long.endsWith('…') && !long.includes('\n'));
  assert.ok(long.length <= 60, `short enough, got ${long.length}`);
  assert.equal(depthLabel('first\nsecond'), 'depth: first');
  for (const blank of ['', '  ', undefined, 5]) assert.equal(depthLabel(blank), 'depth');
});

test('the parent is guarded at both ends: an opening line and the closing paragraph, in the shipped file and in the fallback', () => {
  // The parent wakes on the handoff alone and may start implementing, so the instruction not to must not depend on one
  // section a cheap model can drop (a real run dropped `## For the parent` and translated the headings).
  assert.equal(typeof DEPTH_BANNER, 'string');
  assert.equal(typeof DEPTH_FOR_PARENT, 'string');
  assert.match(DEPTH_BANNER, /nothing was implemented/);
  assert.match(DEPTH_FOR_PARENT, /^Do not implement this request\./);
  for (const read of [undefined, () => '']) {
    const task = buildDepthTask('x', read === undefined ? {} : { read });
    assert.ok(task.includes(DEPTH_BANNER), 'the opening line is asked for');
    assert.ok(task.includes(DEPTH_FOR_PARENT), 'the closing paragraph is given');
    assert.match(task, /character for character/);
  }
});

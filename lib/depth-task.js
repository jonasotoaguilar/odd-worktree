'use strict';
// The task `/depth` hands the `gentle-ai-explore` subagent (S1, S3, S4, S8).
//
// The text is the instructions in `lib/depth-prompt/depth.md` — one Markdown file, so it can be read and edited as
// prose — followed by the request exactly as the person typed it. The explorer starts with no chat, so the request is
// the only thing it will ever know of the person's words; the instructions make it the first section of the handoff.
//
// The file is read on every call, so an edit applies to the next `/depth` with no reload. A missing or empty file falls
// back to a short built-in task that still names every return section, the way the prompt blocks of this package fall
// back to their heading: the command never fails because prose could not be read. Pure apart from that one read, and
// it never throws.

const fs = require('node:fs');
const path = require('node:path');

const DEPTH_FILE = path.join(__dirname, 'depth-prompt', 'depth.md');
const REQUEST_HEADING = '## Request';

// The handoff's sections in order. The parent reads this contract, so the names are fixed and in English whatever the
// language of the request; `tools/depth-task.test.js` holds the shipped file to them.
const DEPTH_RETURN_HEADINGS = Object.freeze([
  '## Original request',
  '## Understood',
  '## Questions',
  '## Map',
  '## Not requested',
  '## How it would be verified',
  '## Uncertainty',
  '## For the parent',
]);

const FALLBACK = [
  'Do a Depth pass on the request in `## Request`: find and read what it touches, then say what a top professional would do that it does not ask for, the rawest material they would start from, their methods and tools, and what outside you would show the result is right. A deeper version, not a bigger one.',
  'Never carry the request out. You only read and report.',
  `Reply with exactly these headings, in this order:\n\n${DEPTH_RETURN_HEADINGS.join('\n\n')}`,
].join('\n\n');

function readDepthFile() {
  return fs.readFileSync(DEPTH_FILE, 'utf8');
}

function instructions(read) {
  try {
    const text = read();
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// The task for one request, or `null` when there is no request to explore.
function buildDepthTask(request, { read = readDepthFile } = {}) {
  if (typeof request !== 'string' || request.trim().length === 0) return null;
  return `${instructions(read)}\n\n${REQUEST_HEADING}\n\n${request.trim()}`;
}

const LABEL_PREFIX = 'depth: ';
const LABEL_MAX = 60;

// The one-line name the agents card shows for the task.
function depthLabel(request) {
  if (typeof request !== 'string') return 'depth';
  const first = request.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).find((line) => line.length > 0);
  if (first === undefined) return 'depth';
  const room = LABEL_MAX - LABEL_PREFIX.length;
  return `${LABEL_PREFIX}${first.length > room ? `${first.slice(0, room - 1)}…` : first}`;
}

module.exports = { DEPTH_FILE, DEPTH_RETURN_HEADINGS, buildDepthTask, depthLabel };

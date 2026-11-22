'use strict';
// The `## ODD worktrees` section of the primary session's system prompt (S7), and
// (T3, S5) the one short block a CHILD that writes gets.
//
// It is appended to `systemPromptOptions.appendSystemPrompt` and nowhere else:
// a handler-returned `systemPrompt` is dropped by pi-claude-bridge, and
// replacing the option would erase the harness's own text. The block is only
// ever added after the existing text, is skipped when it is already there, and
// reaches a primary session only — a named agent gets the primary text of its
// own session, never this one.
//
// S5: a `GENTLE_PI_AGENTS_CHILD` session is not skipped any more. A child that
// WRITES — `gentle-ai-worker`, `jd-fix-agent`, and any child whose agent name the
// argv cannot name, which is the generic child — gets one short line telling it to
// work in its workspace root's worktree and to stop and report on the primary. The
// children that only look or judge (explore, verify, the two judges, every
// `review-*`) get nothing, exactly as before. The agent name comes from
// `lib/codegraph-rules.js` (`agentNameFromArgv`), which already reads it from the
// child's own argv; the argv parsing is never duplicated here.
//
// `ODD_WORKTREE_PROMPT=0` turns both blocks off.

const fs = require('node:fs');
const path = require('node:path');
const { agentNameFromArgv, variantFor } = require('./codegraph-rules.js');

// The heading is the identity of the block, so an already-injected section is
// never added twice.
const SECTION_MARKER = '## ODD worktrees';

// The section text lives in its own Markdown file so it can be read, reviewed
// and edited as prose: `lib/odd-prompt/odd-worktrees.md`, and — one short line for a
// child that writes — `lib/odd-prompt/odd-worktrees-child.md`. A missing or empty
// file falls back to the heading alone: the block still injects, never crashes the
// session, and the idempotency marker still works.
const PROMPT_DIR = path.join(__dirname, 'odd-prompt');
const PROMPT_FILE = path.join(PROMPT_DIR, 'odd-worktrees.md');
const CHILD_PROMPT_FILE = path.join(PROMPT_DIR, 'odd-worktrees-child.md');
const FALLBACK = `${SECTION_MARKER}\n\nEach ODD feature has its own worktree.`;
const CHILD_FALLBACK = `${SECTION_MARKER}\n`;

function readPromptFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > 0 && text.startsWith(SECTION_MARKER) ? text : null;
  } catch {
    return null;
  }
}

// The block one file contributes, or the fallback when the file cannot be used.
function sectionFromFile(file, fallback) {
  return readPromptFile(file) || fallback;
}

const SECTION = sectionFromFile(PROMPT_FILE, FALLBACK);
const CHILD_SECTION = sectionFromFile(CHILD_PROMPT_FILE, CHILD_FALLBACK);

// S5: the children that WRITE, by the name `agentNameFromArgv` reports for them.
const CHILD_WRITER_AGENTS = new Set(['gentle-ai-worker', 'jd-fix-agent']);
const REVIEWER_PREFIX = 'review-';

/**
 * S5: whether this child gets the block. A worker or the fix agent does; a child whose
 * name cannot be read is the generic one and does too; a child that only looks or
 * judges — explore, verify, the judges, every `review-*` — never does. An unknown but
 * READ name is generic exactly as `lib/codegraph-rules.js` decides it, so the two
 * blocks can never call the same child two different things.
 */
function childGetsSection(agent) {
  if (typeof agent !== 'string' || agent.length === 0) return true;
  if (CHILD_WRITER_AGENTS.has(agent)) return true;
  if (agent.startsWith(REVIEWER_PREFIX)) return false;
  return variantFor({ child: true, agent }) === 'generic';
}

// The names a named-agent event may carry. `agent` itself is listed because a
// plain string there is a named agent too; an object is read through `.name`.
function namedAgentOf(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [
    event.agentName,
    event.agent,
    event.name,
    event.agent && typeof event.agent === 'object' ? event.agent.name : undefined,
    event.subagent && typeof event.subagent === 'object' ? event.subagent.name : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function separatorFor(existing) {
  if (existing.endsWith('\n\n')) return '';
  if (existing.endsWith('\n')) return '\n';
  return '\n\n';
}

// Append the section for this session to
// `event.systemPromptOptions.appendSystemPrompt`. Returns nothing: the mutation
// is the whole contract, so a host that awaits the handler receives no
// replacement prompt. `deps.env` and `deps.argv` are the seams: the environment the
// session runs with, and the argv a child's agent name is read from.
function appendOddWorktreesSection(event, deps = {}) {
  try {
    const effectiveDeps = deps || {};
    const env = effectiveDeps.env || process.env;
    if (env.ODD_WORKTREE_PROMPT === '0') return;

    // S5: a child is judged by the agent name its own argv carries, and gets the child
    // block only when it writes. A primary session keeps the one section it always had,
    // and a named-agent event still gets none of it.
    const child = env.GENTLE_PI_AGENTS_CHILD === '1';
    if (child) {
      if (!childGetsSection(agentNameFromArgv(effectiveDeps.argv || process.argv))) return;
    } else if (namedAgentOf(event) !== null) return;

    const options = event && event.systemPromptOptions;
    if (!options || typeof options !== 'object') return;

    const section = child ? CHILD_SECTION : SECTION;
    const existing = typeof options.appendSystemPrompt === 'string' ? options.appendSystemPrompt : '';
    if (existing.includes(SECTION_MARKER)) return;
    // Append-only: every existing byte stays the prefix of the new value.
    options.appendSystemPrompt = existing.length === 0
      ? section
      : `${existing}${separatorFor(existing)}${section}`;
  } catch {
    // The prompt block must never break session start.
  }
}

module.exports = {
  appendOddWorktreesSection,
  childGetsSection,
  readPromptFile,
  sectionFromFile,
  SECTION,
  CHILD_SECTION,
  CHILD_FALLBACK,
};

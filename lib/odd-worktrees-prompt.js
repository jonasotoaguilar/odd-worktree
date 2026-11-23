'use strict';
// The `## ODD worktrees` section of the primary session's system prompt (S7).
//
// It is appended to `systemPromptOptions.appendSystemPrompt` and nowhere else:
// a handler-returned `systemPrompt` is dropped by pi-claude-bridge, and
// replacing the option would erase the harness's own text. The block is only
// ever added after the existing text, is skipped when it is already there, and
// reaches a primary session only — a named agent gets the primary text of its
// own session, never this one, and a `GENTLE_PI_AGENTS_CHILD` session gets none
// of it: a child works where the primary session's handoff put it (its
// `workspace_root`), so the rule is the primary session's to apply.
//
// `ODD_WORKTREE_PROMPT=0` turns the block off.

const fs = require('node:fs');
const path = require('node:path');

// The heading is the identity of the block, so an already-injected section is
// never added twice.
const SECTION_MARKER = '## ODD worktrees';

// The section text lives in its own Markdown file so it can be read, reviewed
// and edited as prose: `lib/odd-prompt/odd-worktrees.md`. A missing or empty
// file falls back to the heading alone: the block still injects, never crashes the
// session, and the idempotency marker still works.
const PROMPT_DIR = path.join(__dirname, 'odd-prompt');
const PROMPT_FILE = path.join(PROMPT_DIR, 'odd-worktrees.md');
const FALLBACK = `${SECTION_MARKER}\n\nEach ODD feature has its own worktree.`;

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
// replacement prompt. `deps.env` is the seam: the environment the session runs with.
function appendOddWorktreesSection(event, deps = {}) {
  try {
    const effectiveDeps = deps || {};
    const env = effectiveDeps.env || process.env;
    if (env.ODD_WORKTREE_PROMPT === '0') return;

    // A child and a named-agent event get none of it.
    if (env.GENTLE_PI_AGENTS_CHILD === '1') return;
    if (namedAgentOf(event) !== null) return;

    const options = event && event.systemPromptOptions;
    if (!options || typeof options !== 'object') return;

    const existing = typeof options.appendSystemPrompt === 'string' ? options.appendSystemPrompt : '';
    if (existing.includes(SECTION_MARKER)) return;
    // Append-only: every existing byte stays the prefix of the new value.
    options.appendSystemPrompt = existing.length === 0
      ? SECTION
      : `${existing}${separatorFor(existing)}${SECTION}`;
  } catch {
    // The prompt block must never break session start.
  }
}

module.exports = {
  appendOddWorktreesSection,
  readPromptFile,
  sectionFromFile,
  SECTION,
};

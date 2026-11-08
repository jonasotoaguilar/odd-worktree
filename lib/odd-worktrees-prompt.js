'use strict';
// The `## ODD worktrees` section of the primary session's system prompt (S7).
//
// It is appended to `systemPromptOptions.appendSystemPrompt` and nowhere else:
// a handler-returned `systemPrompt` is dropped by pi-claude-bridge, and
// replacing the option would erase the harness's own text. The block is only
// ever added after the existing text, is skipped when it is already there, and
// reaches a primary session only — a named agent or a `GENTLE_PI_AGENTS_CHILD`
// worker is left untouched. `ODD_WORKTREE_PROMPT=0` turns it off.
//
// The section has two variants: the CodeGraph sentences are present only when
// the session gate says the CLI exists, so the prompt never promises a sync
// that cannot happen.

const fs = require('node:fs');
const path = require('node:path');

const { hasCodegraph } = require('./codegraph-session.js');

// The heading is the identity of the block, so an already-injected section is
// never added twice — not even when the gate answer changes mid-session and a
// different variant would otherwise be appended.
const SECTION_MARKER = '## ODD worktrees';

// The section text lives in its own Markdown files so it can be read, reviewed
// and edited as prose: `lib/odd-prompt/odd-worktrees.*.md`. Two variants exist —
// the CodeGraph sentences are present only when the session gate says the CLI
// exists, so the prompt never promises a sync that cannot happen. A missing or
// empty file falls back to the heading alone: the block still injects, never
// crashes the session, and the idempotency marker still works.
const PROMPT_DIR = path.join(__dirname, 'odd-prompt');
const WITH_FILE = path.join(PROMPT_DIR, 'odd-worktrees.with-codegraph.md');
const WITHOUT_FILE = path.join(PROMPT_DIR, 'odd-worktrees.without-codegraph.md');
const FALLBACK = `${SECTION_MARKER}\n\nEach ODD feature has its own worktree.`;

function readPromptFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > 0 && text.startsWith(SECTION_MARKER) ? text : null;
  } catch {
    return null;
  }
}

const WITH_CODEGRAPH = readPromptFile(WITH_FILE) || FALLBACK;
const WITHOUT_CODEGRAPH = readPromptFile(WITHOUT_FILE) || FALLBACK;


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

// Append the section to `event.systemPromptOptions.appendSystemPrompt`.
// Returns nothing: the mutation is the whole contract, so a host that awaits
// the handler receives no replacement prompt.
function appendOddWorktreesSection(event, deps = {}) {
  try {
    const effectiveDeps = deps || {};
    const env = effectiveDeps.env || process.env;
    if (env.ODD_WORKTREE_PROMPT === '0') return;
    if (env.GENTLE_PI_AGENTS_CHILD === '1') return;
    if (namedAgentOf(event) !== null) return;

    const options = event && event.systemPromptOptions;
    if (!options || typeof options !== 'object') return;

    const available = typeof effectiveDeps.hasCodegraph === 'function'
      ? effectiveDeps.hasCodegraph(env)
      : hasCodegraph(env);
    const section = available ? WITH_CODEGRAPH : WITHOUT_CODEGRAPH;

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
  WITH_CODEGRAPH,
  WITHOUT_CODEGRAPH,
};

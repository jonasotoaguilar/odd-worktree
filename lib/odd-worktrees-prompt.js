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

const { hasCodegraph } = require('./codegraph-session.js');

// The heading is the identity of the block, so an already-injected section is
// never added twice — not even when the gate answer changes mid-session and a
// different variant would otherwise be appended.
const SECTION_MARKER = '## ODD worktrees';

const WITH_CODEGRAPH = [
  '## ODD worktrees',
  '',
  'Each ODD feature has its own worktree. Before starting implementation, check',
  'whether that ODD already has an assigned worktree: if it does, resume it there;',
  'if it does not, create one before starting.',
  '',
  '`worktree_create` places the checkout at `<repo-parent>/<repo-name>-worktrees/<name>`',
  'and runs `codegraph init` there, so the new checkout has its own index from the',
  'start. Edits and writes trigger a background `codegraph sync` for that checkout.',
  'Every worktree keeps its own `.codegraph/`; never copy, symlink or reuse another',
  "checkout's index.",
  '',
  'Keep all work for one ODD in its assigned worktree. Do not create a second one',
  'to continue it.',
].join('\n');

const WITHOUT_CODEGRAPH = [
  '## ODD worktrees',
  '',
  'Each ODD feature has its own worktree. Before starting implementation, check',
  'whether that ODD already has an assigned worktree: if it does, resume it there;',
  'if it does not, create one before starting.',
  '',
  '`worktree_create` places the checkout at `<repo-parent>/<repo-name>-worktrees/<name>`.',
  '',
  'Keep all work for one ODD in its assigned worktree. Do not create a second one',
  'to continue it.',
].join('\n');

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

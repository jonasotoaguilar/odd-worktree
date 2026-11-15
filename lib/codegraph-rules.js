'use strict';
// The `## CodeGraph` section of a session's system prompt, one text per role.
//
// It rides `systemPromptOptions.appendSystemPrompt` like the `## ODD worktrees`
// block: appended after the harness's own text, never returned as a replacement
// `systemPrompt` (a host may drop it and it would erase the harness text), and
// skipped when the heading is already there. Nothing here probes, runs or writes
// CodeGraph: the section only tells a session that already holds a CodeGraph
// tool how to use it. A session with no such tool, and a `review-*` agent, get
// nothing. The text of each role is a Markdown file under `codegraph-prompt/`,
// so it can be read and edited as prose.

const fs = require('node:fs');
const path = require('node:path');

const SECTION_MARKER = '## CodeGraph';
const PROMPT_DIR = path.join(__dirname, 'codegraph-prompt');

const NATIVE_TOOL = 'codegraph';
const MCP_TOOL = 'mcp__codegraph__codegraph_explore';

const VARIANTS = ['orchestrator', 'explore', 'verify', 'worker', 'fix', 'judge', 'generic'];

// The gentle-shell agents that have a text of their own. Both judges share one.
const VARIANT_BY_AGENT = {
  'gentle-ai-explore': 'explore',
  'gentle-ai-verify': 'verify',
  'gentle-ai-worker': 'worker',
  'jd-fix-agent': 'fix',
  'jd-judge-a': 'judge',
  'jd-judge-b': 'judge',
};

const SUBAGENT_DIR_PREFIX = 'gentle-pi-subagent-';

// The agent name of a subagent child, read from its own argv
// (`gentle-pi-subagent-<agent>-<random>/...`). Undefined in the primary
// session. A name outside the table keeps the directory's spelling, so a
// `review-*` child is still recognised by its prefix. Never throws.
function agentNameFromArgv(argv) {
  if (!Array.isArray(argv)) return undefined;
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const at = arg.lastIndexOf(SUBAGENT_DIR_PREFIX);
    if (at < 0) continue;
    const rest = arg.slice(at + SUBAGENT_DIR_PREFIX.length);
    const end = rest.search(/[\\/]/);
    const directory = (end < 0 ? rest : rest.slice(0, end)).trim();
    if (directory.length === 0) continue;
    for (const name of Object.keys(VARIANT_BY_AGENT)) {
      if (directory === name || directory.startsWith(`${name}-`)) return name;
    }
    return directory;
  }
  return undefined;
}

// The session's tools: the selected ones plus, in a child, the ones the host
// requested for it (MCP tools are not in the selected list yet when
// `before_agent_start` runs).
function sessionTools(selectedTools, requestedEnv, child) {
  const selected = Array.isArray(selectedTools) ? selectedTools.filter((tool) => typeof tool === 'string') : [];
  const requested = child && typeof requestedEnv === 'string'
    ? requestedEnv.split(',').map((tool) => tool.trim()).filter(Boolean)
    : [];
  return [...new Set([...selected, ...requested])];
}

function holdsCodegraph(tools) {
  return tools.includes(NATIVE_TOOL) || tools.some((tool) => tool === MCP_TOOL || tool === 'mcp__codegraph__*');
}

function isReviewer(agent) {
  return typeof agent === 'string' && agent.startsWith('review-');
}

// A primary session gets the orchestrator's text, a named gentle-shell agent its
// own, and any other child (unknown or unreadable name) the generic one.
function variantFor({ child, agent }) {
  if (child !== true) return 'orchestrator';
  if (typeof agent !== 'string' || agent.length === 0) return 'generic';
  return VARIANT_BY_AGENT[agent] || 'generic';
}

function readVariant(variant, dir) {
  try {
    const text = fs.readFileSync(path.join(dir, `${variant}.md`), 'utf8').trim();
    return text.startsWith(SECTION_MARKER) ? text : null;
  } catch {
    return null;
  }
}

// A file that cannot be used falls back to the generic text; a generic text
// that cannot be used is no section, never a broken session.
function sectionText(variant, dir = PROMPT_DIR) {
  return readVariant(variant, dir) || (variant === 'generic' ? null : readVariant('generic', dir));
}

function separatorFor(existing) {
  if (existing.endsWith('\n\n')) return '';
  if (existing.endsWith('\n')) return '\n';
  return '\n\n';
}

// Append the section for this session to
// `event.systemPromptOptions.appendSystemPrompt`. Returns nothing: the mutation
// is the whole contract. `ODD_WORKTREE_PROMPT=0` turns it off together with the
// worktrees block.
function appendCodegraphSection(event, deps = {}) {
  try {
    const env = (deps && deps.env) || process.env;
    if (env.ODD_WORKTREE_PROMPT === '0') return;
    const options = event && event.systemPromptOptions;
    if (!options || typeof options !== 'object') return;

    const child = env.GENTLE_PI_AGENTS_CHILD === '1';
    const agent = child ? agentNameFromArgv((deps && deps.argv) || process.argv) : undefined;
    if (isReviewer(agent)) return;
    const tools = sessionTools(options.selectedTools, env.GENTLE_PI_AGENTS_REQUESTED_TOOLS, child);
    if (!holdsCodegraph(tools)) return;

    const section = sectionText(variantFor({ child, agent }), deps && deps.dir);
    if (section === null || section === undefined) return;
    const existing = typeof options.appendSystemPrompt === 'string' ? options.appendSystemPrompt : '';
    if (existing.includes(SECTION_MARKER)) return;
    options.appendSystemPrompt = existing.length === 0
      ? section
      : `${existing}${separatorFor(existing)}${section}`;
  } catch {
    // The prompt block must never break a session.
  }
}

module.exports = {
  appendCodegraphSection,
  sessionTools,
  holdsCodegraph,
  agentNameFromArgv,
  variantFor,
  sectionText,
  VARIANTS,
  VARIANT_BY_AGENT,
  PROMPT_DIR,
  SECTION_MARKER,
};

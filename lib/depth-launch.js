'use strict';
// `/depth`'s launch (S4, S5, S8): ONE background `gentle-ai-explore`, started through the host's own `subagent_run` tool
// with the Depth task of `lib/depth-task.js` and nothing else.
//
// Everything after the start belongs to gentle-agents, which this package never imports: it draws the progress, owns the
// cancel and, when the explorer finishes, sends its answer to the session as a message that starts a turn. So this module
// has no widget, no timer and no message of its own. It decides whether the launch can happen and answers in one sentence
// what did or did not.
//
// The host API is `ctx.executeTool(name, args)`, which never rejects for a tool failure — an unknown tool, a refused call
// and a thrown error all come back as `isError: true` — and `ctx.tools`, which lists what it can call (the same contract
// `lib/session-worktree-register.js` documents). `subagent_run` rejects any key outside its schema, so the arguments are
// exactly `agent`, `task`, `label` and `mode`.
//
// Never throws, never rejects.

const { buildDepthTask, depthLabel } = require('./depth-task.js');

const DEPTH_AGENT = 'gentle-ai-explore';
const DEPTH_TOOL = 'subagent_run';

function refuse(message) {
  return { ok: false, level: 'error', message };
}

function toolAvailable(ctx) {
  try {
    if (!ctx || typeof ctx.executeTool !== 'function') return false;
    const tools = ctx.tools;
    return Array.isArray(tools) && tools.some((tool) => tool && tool.name === DEPTH_TOOL);
  } catch {
    return false;
  }
}

// The words the host tool answered with, so a refusal reads in its own sentence.
function outcomeText(outcome) {
  const parts = outcome && Array.isArray(outcome.content) ? outcome.content : [];
  return parts
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text.trim() : ''))
    .filter((text) => text.length > 0)
    .join(' ');
}

function couldNotStart(detail) {
  return refuse(`/depth couldn't start the explorer: ${detail}`);
}

async function launchDepth(request, ctx) {
  const task = buildDepthTask(request);
  if (task === null) {
    return refuse('/depth needs a request: /depth <request>. The explorer does not see this chat, so put everything it needs in the request.');
  }
  if (!toolAvailable(ctx)) {
    return refuse(`/depth starts a ${DEPTH_AGENT} subagent through the ${DEPTH_TOOL} tool, and this session does not offer it.`);
  }
  const label = depthLabel(request);
  let outcome;
  try {
    outcome = await ctx.executeTool(DEPTH_TOOL, { agent: DEPTH_AGENT, task, label, mode: 'background' });
  } catch (error) {
    return couldNotStart(error instanceof Error ? error.message : String(error));
  }
  if (!outcome || outcome.isError === true) {
    return couldNotStart(outcomeText(outcome) || `the ${DEPTH_TOOL} tool reported an error.`);
  }
  return { ok: true, level: 'info', message: `Exploring in the background (${label}). The handoff arrives in this session when it finishes.` };
}

module.exports = { DEPTH_AGENT, DEPTH_TOOL, launchDepth };

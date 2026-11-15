'use strict';
// T1 (S1, S2, S5, S6, S7): the two CodeGraph reminders, decided from a finished tool call.
//
// Guard 1 says a call went to ANOTHER checkout and points the session at
// `mcp__codegraph__codegraph_explore` with that checkout as `projectPath`; it belongs to the primary
// session and fires once per checkout per session. Guard 2 says to reach CodeGraph first inside the
// session's OWN checkout; it belongs to the primary session and to every child except the `review-*`
// agents, and its key is the checkout, so a `/warp` re-arms it.
//
// Both are precise: a checkout the session already explored with the MCP tool silences guard 1, a
// session that already used CodeGraph silences guard 2, and a reminder that does not fire uses up no
// slot. A compaction forgets everything, and so does a new session in the same process.
//
// The reminder is only a sentence. Appending it to the tool result is the wiring's job
// (`lib/codegraph-session.js`); nothing here blocks, notifies or writes. Git is reached through one
// injected `toplevel` (`lib/codegraph-guard-target.js` caches it per directory), so nothing here spawns
// a child of its own and nothing throws into the host.

const nodePath = require('node:path');

const { agentNameFromArgv, holdsCodegraph, sessionTools, variantFor } = require('./codegraph-rules.js');
const target = require('./codegraph-guard-target.js');

const NATIVE_TOOL = 'codegraph';
const MCP_TOOL = 'mcp__codegraph__codegraph_explore';
/** The MCP explore call, bare or namespaced by a server: the one call a `projectPath` is read from. */
const EXPLORE_TOOL = /^(?:mcp__[a-z0-9_]+__)?codegraph_explore$/;
/** The roles whose own rule text names the native operations, so the reminder may name them too. */
const NATIVE_VARIANTS = ['orchestrator', 'explore'];

/** S1: one call went to another checkout. */
function anotherCheckoutReminder(root) {
  return `This call went to ${root}, another checkout. Follow the CodeGraph rule: call \`${MCP_TOOL}\` with \`projectPath\` set to ${root} first.`;
}

/** S2: the call went to the session's own checkout; the wording follows the role's own rule text. */
function sameCheckoutReminder(input = {}) {
  const variant = input.variant;
  const tools = Array.isArray(input.tools) ? input.tools : [];
  return NATIVE_VARIANTS.includes(variant) && tools.includes(NATIVE_TOOL)
    ? 'Follow the CodeGraph rule: run `codegraph` `query` or `explore` first, if it applies.'
    : `Follow the CodeGraph rule: call \`${MCP_TOOL}\` first, if it applies.`;
}

function isExploreCall(event) {
  return Boolean(event) && typeof event.toolName === 'string' && EXPLORE_TOOL.test(event.toolName);
}

function isCodegraphCall(event) {
  return Boolean(event) && (event.toolName === NATIVE_TOOL || isExploreCall(event));
}

/** The once-per-key slots and what the session already used, forgotten together. */
function createGuardState() {
  return {
    checkouts: new Set(), // guard 1: the other checkouts already reminded
    own: new Set(), // guard 2: the session checkouts already reminded
    explored: new Set(), // the absolute projectPath of every MCP explore call this session made
    used: false, // the session already used CodeGraph at all
  };
}

function resetGuardState(state) {
  state.checkouts.clear();
  state.own.clear();
  state.explored.clear();
  state.used = false;
}

/**
 * What one finished call says about the session's use of CodeGraph: the native tool or the MCP tool is a
 * use (S5), and an explore call aimed at a `projectPath` records that checkout. Returns whether this call
 * was CodeGraph's own, in which case it is no search call and no reminder is about it.
 */
function recordCodegraphUse(state, event, cwd) {
  if (!isCodegraphCall(event)) return false;
  state.used = true;
  if (isExploreCall(event)) {
    const projectPath = event.input && event.input.projectPath;
    if (typeof projectPath === 'string' && projectPath.length > 0) {
      state.explored.add(nodePath.resolve(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(), projectPath));
    }
  }
  return true;
}

/** Whether the session already explored that checkout, with the projectPath it named. */
async function exploredCheckout(state, root, resolver) {
  for (const path of state.explored) {
    if (await resolver.rootOfPath(path) === root) return true;
  }
  return false;
}

/**
 * The reminder one call earns, or undefined. It marks the slot it used, so the same key is never
 * reminded twice; a call whose reminder would duplicate one, or whose checkout the session already
 * explored, marks nothing.
 */
async function decideGuard(input) {
  const { state, call, ownRoot, tools, variant, resolver } = input;
  if (!call || !state || ownRoot === undefined) return undefined;
  const checkout = await target.callCheckout(call, { rootOfPath: resolver.rootOfPath, ownRoot });
  if (checkout === undefined) return undefined;
  if (checkout.other) {
    // Guard 1 is the primary session's (S1): a child never hears that it reached another checkout.
    if (input.primary !== true) return undefined;
    if (state.checkouts.has(checkout.root)) return undefined;
    if (await exploredCheckout(state, checkout.root, resolver)) return undefined;
    state.checkouts.add(checkout.root);
    return { kind: 'another-checkout', checkout: checkout.root, text: anotherCheckoutReminder(checkout.root) };
  }
  if (state.own.has(checkout.root) || state.used) return undefined;
  state.own.add(checkout.root);
  return { kind: 'same-checkout', checkout: checkout.root, text: sameCheckoutReminder({ variant, tools }) };
}

function sessionCwd(event, ctx) {
  if (ctx && typeof ctx.cwd === 'string' && ctx.cwd.length > 0) return ctx.cwd;
  if (event && typeof event.cwd === 'string' && event.cwd.length > 0) return event.cwd;
  return process.cwd();
}

/**
 * The two guards of one session, with their own state. `observeTools` takes the session's tool list from
 * the host's `before_agent_start` event (the only source of it); `onToolResult` decides one reminder from
 * one finished call; `onCompacted` and `onNewSession` forget everything. Every collaborator is injectable:
 * `env`, `argv` (the child's agent name), `toplevel` (the cached git read) and `isDirectory` (whether a path
 * is a directory, so a file costs one read).
 */
function createCodegraphGuard(deps = {}) {
  const env = deps.env || process.env;
  const argv = deps.argv || process.argv;
  const resolver = deps.resolver || target.createCheckoutResolver({ toplevel: deps.toplevel, isDirectory: deps.isDirectory });
  const state = createGuardState();
  let selected = [];

  const child = () => env.GENTLE_PI_AGENTS_CHILD === '1';
  const agent = () => (child() ? agentNameFromArgv(argv) : undefined);
  const tools = () => sessionTools(selected, env.GENTLE_PI_AGENTS_REQUESTED_TOOLS, child());

  return {
    /** The session's tools, as the host selected them for this turn. */
    observeTools(selectedTools) {
      selected = Array.isArray(selectedTools) ? selectedTools.filter((tool) => typeof tool === 'string') : [];
    },

    /** A compaction forgets what was reminded and what was used (S7). */
    onCompacted() {
      resetGuardState(state);
    },

    /** A new session in the same process is a new session (S7). */
    onNewSession() {
      resetGuardState(state);
    },

    /**
     * The one reminder this finished call earns, or undefined. Never throws and never returns more than
     * one text; only a call that resolves a checkout spends a git read, and that read is cached.
     */
    async onToolResult(event, ctx) {
      try {
        if (!event) return undefined;
        const cwd = sessionCwd(event, ctx);
        if (recordCodegraphUse(state, event, cwd)) return undefined;
        // The same gate as the prompt section: the session must hold a CodeGraph tool to be advised.
        const held = tools();
        if (!holdsCodegraph(held)) return undefined;
        const name = agent();
        if (typeof name === 'string' && name.startsWith('review-')) return undefined;
        const call = target.searchCall(event, cwd);
        if (call === undefined) return undefined;
        const ownRoot = await resolver.rootOfPath(cwd);
        if (ownRoot === undefined) return undefined;
        const decision = await decideGuard({
          state,
          call,
          ownRoot,
          tools: held,
          variant: variantFor({ child: child(), agent: name }),
          primary: !child(),
          resolver,
        });
        return decision === undefined ? undefined : decision.text;
      } catch {
        return undefined;
      }
    },
  };
}

module.exports = {
  EXPLORE_TOOL,
  NATIVE_TOOL,
  MCP_TOOL,
  anotherCheckoutReminder,
  createCodegraphGuard,
  createGuardState,
  decideGuard,
  isCodegraphCall,
  isExploreCall,
  recordCodegraphUse,
  resetGuardState,
  sameCheckoutReminder,
};

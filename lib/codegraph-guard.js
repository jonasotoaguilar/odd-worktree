'use strict';
// T1 (S1, S2, S5, S6, S7) and T6 (S3): the two CodeGraph reminders, decided from a finished tool call.
//
// Guard 1 says a call went to ANOTHER checkout and points the session at
// `mcp__codegraph__codegraph_explore` with that checkout as `projectPath`; it belongs to the primary
// session and fires once per checkout per session. Guard 2 says to reach CodeGraph first inside the
// session's OWN checkout; it belongs to the primary session too (a child is short-lived and its own rule
// text already says it), and it reminds once on the first search of a checkout, while the graph is unused
// in that request, and then never again for that checkout in that request (S3, S7).
//
// Both are precise: a checkout the session already explored with the MCP tool silences guard 1, and a
// reminder that does not fire uses up no slot. A call that failed is no subject at all: the model got no
// result to read, so nothing is reminded, spent or recorded from it. A new request forgets guard 2's
// first-search slots and `used` flag; a compaction forgets everything, and so does a new session in the
// same process.
//
// The reminder is only a sentence. Appending it to the tool result is the wiring's job
// (`lib/codegraph-session.js`); nothing here blocks, notifies or writes. Git is reached through one
// injected `toplevel` (`lib/codegraph-guard-target.js` caches it per directory), so nothing here spawns
// a child of its own and nothing throws into the host.

const nodePath = require('node:path');

const { agentNameFromArgv, holdsCodegraph, sessionTools } = require('./codegraph-rules.js');
const target = require('./codegraph-guard-target.js');

const NATIVE_TOOL = 'codegraph';
const MCP_TOOL = 'mcp__codegraph__codegraph_explore';
/** The MCP explore call, bare or namespaced by a server: the one call a `projectPath` is read from. */
const EXPLORE_TOOL = /^(?:mcp__[a-z0-9_]+__)?codegraph_explore$/;

/** S1: one call went to another checkout. */
function anotherCheckoutReminder(root) {
  return `This call went to ${root}, another checkout. Follow the CodeGraph rule: call \`${MCP_TOOL}\` with \`projectPath\` set to ${root} first.`;
}

/** S2: the call went to the session's own checkout: the one tool every role's rule text names. */
function sameCheckoutReminder() {
  return `Follow the CodeGraph rule: call \`${MCP_TOOL}\` first.`;
}

function isExploreCall(event) {
  return Boolean(event) && typeof event.toolName === 'string' && EXPLORE_TOOL.test(event.toolName);
}

function isCodegraphCall(event) {
  return Boolean(event) && (event.toolName === NATIVE_TOOL || isExploreCall(event));
}

/** The once-per-key slots and what the request already used, forgotten together. */
function createGuardState() {
  return {
    checkouts: new Set(), // guard 1: the other checkouts already reminded, for the whole session
    own: new Set(), // guard 2: the checkouts already reminded on their first search, for this request
    explored: new Set(), // the absolute projectPath of every MCP explore call this session made
    used: false, // this request already used CodeGraph
  };
}

function resetGuardState(state) {
  state.checkouts.clear();
  state.own.clear();
  state.explored.clear();
  state.used = false;
}

/**
 * S7: a new request forgets guard 2 alone — its first-search slots and `used`. Guard 1's slots and the
 * explored checkouts are the session's, so they stay.
 */
function forgetRequestState(state) {
  state.own.clear();
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
 * explored, marks nothing. Guard 2 (S3, S7) reminds once on the first search of a checkout in a request
 * while the graph is unused, and never again for that checkout in that request.
 */
async function decideGuard(input) {
  const { state, call, ownRoot, resolver } = input;
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
  // The first search of a checkout is reminded at once, and only while the graph is still unused.
  if (state.used !== false || state.own.has(checkout.root)) return undefined;
  state.own.add(checkout.root);
  return { kind: 'same-checkout', checkout: checkout.root, text: sameCheckoutReminder() };
}

function sessionCwd(event, ctx) {
  if (ctx && typeof ctx.cwd === 'string' && ctx.cwd.length > 0) return ctx.cwd;
  if (event && typeof event.cwd === 'string' && event.cwd.length > 0) return event.cwd;
  return process.cwd();
}

/**
 * The two guards of one session, with their own state. `observeTools` takes the session's tool list from
 * the host's `before_agent_start` event (the only source of it); `onNewRequest` re-arms guard 2 for a new
 * request; `onToolResult` decides one reminder from one finished call; `onCompacted` and `onNewSession`
 * forget everything. Every collaborator is injectable: `env`, `argv` (the child's agent name), `toplevel`
 * (the cached git read) and `isDirectory` (whether a path is a directory, so a file costs one read).
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

    /** A new request re-arms guard 2: its first-search slots and what it used (S7). */
    onNewRequest() {
      forgetRequestState(state);
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
        // A call that failed returned nothing the model could read: no reminder rides an error result, no
        // once-per-key slot is spent, and no use of CodeGraph is recorded on the strength of it (S5).
        if (event.isError === true) return undefined;
        const cwd = sessionCwd(event, ctx);
        if (recordCodegraphUse(state, event, cwd)) return undefined;
        // Both reminders are the primary session's: a child lives a message or two and its own section already
        // states the rule, so a reminder there would only repeat it.
        if (child()) return undefined;
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

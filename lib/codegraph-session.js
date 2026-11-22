'use strict';
// The one place that wires CodeGraph into a session. The extension calls `registerCodegraph(pi)` once and everything else
// lives here, so the extension itself stays a single line:
//
//   - session start (a primary session): ensure the global MCP entry once per process, then create-or-sync the session's index
//     and warm its daemon, in the background and never awaited by the host;
//   - compaction: one background sync of an existing index, never an init;
//   - a successful native `codegraph init`: one coordinated sync, and its honest outcome appended to the tool's own result;
//   - a successful `edit` or `write`: a debounced sync of the edited file's checkout;
//   - before a CodeGraph search: a bounded join of the index work this process already has in flight for that checkout
//     (never a new one, and nothing at all when nothing is in flight);
//   - a search or read call into another checkout, or into the session's own one: one reminder appended to
//     that call's result (never a block, never a separate message), re-armed at every new request and
//     forgotten on a compaction and a new session;
//   - the CodeGraph tool card, through the host's renderer hook;
//   - shutdown: every pending window is cleared.
//
// All of it applies only when the `codegraph` CLI is installed (probed once per process): without it nothing is registered.
// No handler throws into the host, and every collaborator is injectable.

const nodeOs = require('node:os');
const nodePath = require('node:path');

const index = require('./codegraph-index.js');
const { createCodegraphGuard } = require('./codegraph-guard.js');
const { compactionSync } = require('./codegraph-compaction.js');
const { createEditSync } = require('./codegraph-edit-sync.js');
const { liveDaemon } = require('./codegraph-daemon.js');
const { ensureCodegraphServer } = require('./codegraph-mcp-config.js');
const { sessionIndexRole } = require('./codegraph-role.js');
const { warmUpDaemon } = require('./codegraph-warmup.js');

const MCP_FILE = 'mcp.json';

// S2: how long a search may wait for the index write already in flight before it runs against the index as it is.
const JOIN_BUDGET_MS = 5000;
const JOIN_BUDGET_ENV = 'ODD_WORKTREE_CODEGRAPH_JOIN_MS';
const MCP_CODEGRAPH_PREFIX = 'mcp__codegraph__';
const SEARCH_OPERATIONS = new Set(['query', 'explore']);

/** The agent directory the host reads its MCP configuration from: its own override, else `~/.pi/agent`. */
function agentDirOf(env) {
  const named = env && env.PI_CODING_AGENT_DIR;
  return typeof named === 'string' && named.length > 0 ? named : nodePath.join(nodeOs.homedir(), '.pi', 'agent');
}

function notifier(ctx) {
  return (notice) => {
    try {
      if (notice && ctx && ctx.ui && typeof ctx.ui.notify === 'function') ctx.ui.notify(notice.text, notice.level);
    } catch {
      // Telling the user is never worth failing the session.
    }
  };
}

/** What the user is told about the MCP entry; an unchanged entry says nothing. */
function mcpNotice(result) {
  if (!result) return undefined;
  if (result.status === 'added' || result.status === 'fixed') {
    return {
      text: `CodeGraph MCP entry ${result.status === 'added' ? 'added to' : 'fixed in'} ${MCP_FILE}: reload Pi for the MCP tool to appear`,
      level: 'info',
    };
  }
  if (result.status === 'invalid' || result.status === 'unreadable' || result.status === 'failed') {
    return { text: `could not check the CodeGraph entry of ${MCP_FILE} (${result.status}); the file was left untouched`, level: 'warning' };
  }
  return undefined;
}

function sessionCwd(event, ctx) {
  if (ctx && typeof ctx.cwd === 'string' && ctx.cwd.length > 0) return ctx.cwd;
  if (event && typeof event.cwd === 'string' && event.cwd.length > 0) return event.cwd;
  return process.cwd();
}

/**
 * S2: whether this tool call is a CodeGraph search — the native tool's `query`/`explore`, or any tool the CodeGraph
 * MCP server exposes. Read from the event alone: the decision is made before the tool runs, from what it will do.
 */
function isCodegraphSearch(event) {
  const name = event && typeof event.toolName === 'string' ? event.toolName : '';
  if (name.length === 0) return false;
  if (name.startsWith(MCP_CODEGRAPH_PREFIX)) return true;
  if (name !== index.NATIVE_CODEGRAPH_TOOL) return false;
  const input = event.input && typeof event.input === 'object' && event.input !== null ? event.input : {};
  return SEARCH_OPERATIONS.has(input.operation);
}

/** The join budget in ms: five seconds by default, a positive override from the environment, and 0 to never join. */
function joinBudgetMs(env) {
  const raw = env && env[JOIN_BUDGET_ENV];
  if (raw === undefined || raw === null || String(raw).trim().length === 0) return JOIN_BUDGET_MS;
  const parsed = Number(String(raw).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : JOIN_BUDGET_MS;
}

/**
 * The first text part of a result keeps the tool's own words; the hook's line is a part of its own after them.
 * Everything else the result carried — its structured content above all — rides along unchanged, so the result is
 * kept whole.
 */
function withNotice(event, text) {
  const content = Array.isArray(event.content) ? event.content : [];
  const patch = { content: [...content, { type: 'text', text }] };
  if (event && event.structuredContent !== undefined) patch.structuredContent = event.structuredContent;
  return patch;
}

function registerCodegraph(pi, deps = {}) {
  const env = deps.env || process.env;
  const impl = {
    ensureCodegraphServer,
    prepareProject: index.prepareProject,
    compactionSync,
    syncAfterNativeInit: index.syncAfterNativeInit,
    createEditSync,
    createCodegraphGuard,
    warmUpDaemon,
    ...(deps.impl || {}),
  };
  if (typeof pi?.on !== 'function') return { registered: false };
  if (!index.cliAvailable({ hasBinary: deps.hasBinary })) return { registered: false };

  const child = env.GENTLE_PI_AGENTS_CHILD === '1';
  const role = sessionIndexRole(env);
  const registryDir = deps.registryDir;
  let mcpChecked = false;
  // S2: the index writes this process already asked for, per checkout. Registering one here is what lets a
  // search join it; nothing in this map starts work of its own.
  const indexWork = new Map(); // checkout root -> Set of promises this process started
  const delay = typeof deps.delay === 'function' ? deps.delay : (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  // The CodeGraph CARD is not registered here (modular-tools S11): it is a design, so its switch is
  // the bridge's `Card tags` line and the extension registers it beside the file and jobs cards,
  // outside this module. What CodeGraph does is never decided by what is drawn.

  // The two reminders own their own state: a compaction, a `/warp` and a new session are its facts to keep.
  const guards = impl.createCodegraphGuard({ env, argv: deps.argv, toplevel: deps.toplevel, isDirectory: deps.isDirectory });

  const editSync = impl.createEditSync({
    role,
    available: () => true,
    daemonLive: (root) => liveDaemon(root, { registryDir }) !== undefined,
    sync: (root) => index.requestCoordinatedSync({ project: root, run: deps.run }),
  });

  /**
   * Runs index work this process asks for and keeps it visible under its checkout, so a search can join it.
   * The caller gets the very same promise, rejection and all; the copy kept here is always settled-and-forgotten,
   * so it can never be an unhandled rejection or a leak.
   */
  function trackIndexWork(root, start) {
    const work = Promise.resolve().then(start);
    let pending = indexWork.get(root);
    if (pending === undefined) {
      pending = new Set();
      indexWork.set(root, pending);
    }
    pending.add(work);
    const forget = () => {
      const live = indexWork.get(root);
      if (live === undefined) return;
      live.delete(work);
      if (live.size === 0) indexWork.delete(root);
    };
    work.then(forget, forget);
    return work;
  }

  /**
   * S2: what a search may join, or `undefined` when there is nothing — which is the synchronous answer that keeps
   * an idle checkout at zero latency. Only work already asked for is joined: our own preparations and post-init
   * syncs, and the edit sync's running window. Nothing here starts one.
   */
  function joinInFlightWork(root, budgetMs) {
    const waiting = [];
    const pending = indexWork.get(root);
    if (pending !== undefined) {
      for (const work of pending) waiting.push(Promise.resolve(work).then(() => undefined, () => undefined));
    }
    try {
      if (editSync && typeof editSync.inFlight === 'function' && editSync.inFlight(root) === true) {
        const idle = typeof editSync.whenIdle === 'function' ? editSync.whenIdle(root, budgetMs) : undefined;
        if (idle !== undefined && idle !== null) waiting.push(Promise.resolve(idle).then(() => undefined, () => undefined));
      }
    } catch {
      // A window that cannot report itself is simply not joined.
    }
    if (waiting.length === 0) return undefined;
    return Promise.all(waiting).then(() => undefined, () => undefined);
  }

  const joinIndexWork = typeof deps.joinIndexWork === 'function' ? deps.joinIndexWork : joinInFlightWork;

  /** The wait a search gets: bounded by the budget and never rejecting, whatever the joined work or the seam does. */
  function boundedWait(work, budgetMs) {
    const settled = Promise.resolve(work).then(() => undefined, () => undefined);
    let expiry;
    try {
      expiry = Promise.resolve(delay(budgetMs)).then(() => undefined, () => undefined);
    } catch {
      // A timer seam that cannot arm its timer must never remove the cap: the wait answers as expired instead, so the
      // tool runs at once rather than awaiting joined work that may never settle.
      expiry = Promise.resolve();
    }
    return Promise.race([settled, expiry]);
  }

  async function startSession(event, ctx) {
    const notify = notifier(ctx);
    try {
      if (!child && !mcpChecked) {
        mcpChecked = true;
        notify(mcpNotice(await impl.ensureCodegraphServer({ agentDir: agentDirOf(env) })));
      }
    } catch {
      // The MCP entry is never worth stopping the index.
    }
    try {
      const cwd = sessionCwd(event, ctx);
      // Never awaited by the host, and joined by a search that arrives while it runs.
      const result = await trackIndexWork(cwd, () => impl.prepareProject({
        cwd,
        env,
        role,
        reason: event && event.reason,
        hasBinary: deps.hasBinary,
        onStart: (action) => notify({ text: index.indexStartNotice(action), level: 'info' }),
        onIndexed: (indexed) => notify(index.indexOutcomeNotice(indexed, cwd)),
        warm: (root) => impl.warmUpDaemon(root, undefined, { registryDir, background: true }),
      }));
      if (result && (result.warm === 'ok' || result.warm === 'failed')) notify(index.warmOutcomeNotice(result.warm, cwd));
    } catch {
      // The index preparation never breaks a session.
    }
  }

  pi.on('session_start', (event, ctx) => {
    try {
      // A new, resumed or forked session is a new session; a `/reload` keeps this one and what it was told.
      if (!event || event.reason !== 'reload') guards.onNewSession();
    } catch {
      // Forgetting a reminder never breaks a session.
    }
    // Never awaited: the host's own startup does not wait for an index.
    void startSession(event, ctx);
  });

  // S2: the pre-execution hook. Pi awaits this answer and BLOCKS the tool when the hook throws
  // (docs/extensions.md:3253), so it answers `undefined` for every other tool and whenever nothing is in flight,
  // and the promise it does answer with is budget-capped and never rejects. It never starts a sync, init or seed.
  pi.on('tool_call', (event, ctx) => {
    try {
      if (!isCodegraphSearch(event)) return undefined;
      const budgetMs = joinBudgetMs(env);
      if (!(budgetMs > 0)) return undefined;
      const work = joinIndexWork(sessionCwd(event, ctx), budgetMs);
      if (work === undefined || work === null) return undefined;
      return boundedWait(work, budgetMs);
    } catch {
      // Waiting for the index is never worth blocking a search.
      return undefined;
    }
  });

  pi.on('session_compact', (event, ctx) => {
    try {
      guards.onCompacted();
    } catch {
      // Forgetting a reminder never breaks a session.
    }
    // S2: the compaction's sync is tracked exactly like the session-start preparation and the post-init sync, so a
    // search arriving while it runs joins it. The host is still handed nothing: the work runs off its path.
    const cwd = sessionCwd(event, ctx);
    void trackIndexWork(cwd, () => impl.compactionSync({ cwd, env, role, hasBinary: deps.hasBinary })).catch(() => {});
  });

  // The session's tools reach the guards from the ONE source that has them: the prompt options of
  // `before_agent_start`. S7: that same event is a new request, so guard 2 is re-armed there (its
  // first-search slots and `used`), while guard 1's slots stay per session. Nothing here touches the
  // prompt itself.
  pi.on('before_agent_start', (event) => {
    try {
      guards.onNewRequest();
    } catch {
      // Re-arming a reminder never breaks a prompt.
    }
    try {
      guards.observeTools(event && event.systemPromptOptions && event.systemPromptOptions.selectedTools);
    } catch {
      // Recording the tools never breaks a prompt.
    }
  });

  pi.on('tool_result', async (event, ctx) => {
    try {
      void Promise.resolve(editSync.onToolResult(event, ctx)).catch(() => {});
    } catch {
      // The edit sync never fails a tool result.
    }
    const extras = [];
    const appendNotice = (notice) => {
      if (typeof notice === 'string' && notice.length > 0) extras.push(notice);
    };
    try {
      const decision = index.initHookDecision(event, role);
      if (decision === 'skip-read-only') {
        appendNotice(index.postInitSyncNotice('skipped-read-only'));
      } else if (decision === 'sync') {
        // An init aimed at another checkout is that checkout's own business, not this session's index.
        if (!(event.input && (typeof event.input.worktree === 'string' || typeof event.input.path === 'string'))) {
          const cwd = sessionCwd(event, ctx);
          const outcome = await trackIndexWork(cwd, () => impl.syncAfterNativeInit({ cwd, env, role }));
          // S4: a completed sync appends nothing; only one that did not complete earns a line.
          appendNotice(index.postInitSyncNotice(outcome));
        }
      }
    } catch {
      // The post-init line never fails a tool result.
    }
    try {
      // The reminders cite the CodeGraph rule, so they go quiet with it: ODD_WORKTREE_PROMPT=0 suppresses both.
      const reminder = env.ODD_WORKTREE_PROMPT === '0' ? undefined : await guards.onToolResult(event, ctx);
      if (reminder) extras.push(reminder);
    } catch {
      // The reminder never fails a tool result.
    }
    return extras.length === 0 ? undefined : withNotice(event, extras.join('\n\n'));
  });

  pi.on('session_shutdown', () => {
    try {
      editSync.dispose();
    } catch {
      // Shutdown never fails on a timer.
    }
  });

  return { registered: true };
}

module.exports = { registerCodegraph, agentDirOf, mcpNotice };

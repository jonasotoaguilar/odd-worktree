'use strict';
// The one place that wires CodeGraph into a session. The extension calls `registerCodegraph(pi)` once and everything else
// lives here, so the extension itself stays a single line:
//
//   - session start (a primary session): ensure the global MCP entry once per process, then create-or-sync the session's index
//     and warm its daemon, in the background and never awaited by the host;
//   - compaction: one background sync of an existing index, never an init;
//   - a successful native `codegraph init`: one coordinated sync, and its honest outcome appended to the tool's own result;
//   - a successful `edit` or `write`: a debounced sync of the edited file's checkout;
//   - a search or read call into another checkout, or into the session's own one: one reminder appended to
//     that call's result (never a block, never a separate message), forgotten on a compaction and a new session;
//   - the CodeGraph tool card, through the host's renderer hook;
//   - shutdown: every pending window is cleared.
//
// All of it applies only when the `codegraph` CLI is installed (probed once per process): without it nothing is registered.
// No handler throws into the host, and every collaborator is injectable.

const nodeOs = require('node:os');
const nodePath = require('node:path');

const index = require('./codegraph-index.js');
const { createCodegraphCardResolver } = require('./codegraph-card.js');
const { compactionSync } = require('./codegraph-compaction.js');
const { createEditSync } = require('./codegraph-edit-sync.js');
const { createCodegraphGuard } = require('./codegraph-guard.js');
const { liveDaemon } = require('./codegraph-daemon.js');
const { ensureCodegraphServer } = require('./codegraph-mcp-config.js');
const { sessionIndexRole } = require('./codegraph-role.js');
const { warmUpDaemon } = require('./codegraph-warmup.js');

const MCP_FILE = 'mcp.json';

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
    createCodegraphCardResolver,
    ...(deps.impl || {}),
  };
  if (typeof pi?.on !== 'function') return { registered: false };
  if (!index.cliAvailable({ hasBinary: deps.hasBinary })) return { registered: false };

  const child = env.GENTLE_PI_AGENTS_CHILD === '1';
  const role = sessionIndexRole(env);
  const registryDir = deps.registryDir;
  let mcpChecked = false;

  // The CodeGraph card goes through the host's renderer hook, looked up when it is used: an older host without it draws
  // nothing of ours and loses nothing. No tool, command or execution is registered by it.
  try {
    impl.createCodegraphCardResolver({
      metrics: deps.metrics || (() => null),
      registerToolRenderer: (resolver) => (typeof pi.registerToolRenderer === 'function' ? pi.registerToolRenderer(resolver) : undefined),
    });
  } catch {
    // The card is cosmetic.
  }

  // The two reminders own their own state: a compaction, a `/warp` and a new session are its facts to keep.
  const guards = impl.createCodegraphGuard({ env, argv: deps.argv, toplevel: deps.toplevel, isDirectory: deps.isDirectory });

  const editSync = impl.createEditSync({
    role,
    available: () => true,
    daemonLive: (root) => liveDaemon(root, { registryDir }) !== undefined,
    sync: (root) => index.requestCoordinatedSync({ project: root, run: deps.run }),
  });

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
      const result = await impl.prepareProject({
        cwd,
        env,
        role,
        reason: event && event.reason,
        hasBinary: deps.hasBinary,
        onStart: (action) => notify({ text: index.indexStartNotice(action), level: 'info' }),
        onIndexed: (indexed) => notify(index.indexOutcomeNotice(indexed, cwd)),
        warm: (root) => impl.warmUpDaemon(root, undefined, { registryDir, background: true }),
      });
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

  pi.on('session_compact', (event, ctx) => {
    try {
      guards.onCompacted();
    } catch {
      // Forgetting a reminder never breaks a session.
    }
    void Promise.resolve()
      .then(() => impl.compactionSync({ cwd: sessionCwd(event, ctx), env, role, hasBinary: deps.hasBinary }))
      .catch(() => {});
  });

  // The session's tools reach the guards from the ONE source that has them: the prompt options of
  // `before_agent_start`. Nothing here touches the prompt itself.
  pi.on('before_agent_start', (event) => {
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
    try {
      const decision = index.initHookDecision(event, role);
      if (decision === 'skip-read-only') {
        extras.push(index.postInitSyncNotice('skipped-read-only'));
      } else if (decision === 'sync') {
        // An init aimed at another checkout is that checkout's own business, not this session's index.
        if (!(event.input && (typeof event.input.worktree === 'string' || typeof event.input.path === 'string'))) {
          const outcome = await impl.syncAfterNativeInit({ cwd: sessionCwd(event, ctx), env, role });
          extras.push(index.postInitSyncNotice(outcome));
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

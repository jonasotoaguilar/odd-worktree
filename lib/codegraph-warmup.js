'use strict';
// The warm-up: make this checkout's CodeGraph daemon open its database and start a read worker, so the next
// real call is fast. A live daemon already registered for this checkout is reused — one read through it is the
// warm-up and no second server is spawned beside it. Only when this checkout has no live daemon is
// `codegraph serve --mcp` started, through CodeGraph's own proxy, bounded, and never killed: the daemon it shares
// with the user's own sessions must survive the warm-up client. Nothing here can fail or hold the host.

const { spawn: nodeSpawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const { daemonStatus, exploreViaDaemon, NO_PROJECT_TEXT, projectArgument } = require('./codegraph-daemon.js');
const { serveCommand } = require('./codegraph-paths.js');

/** A cold daemon on a network share can need over a minute for its first read. */
const WARMUP_TIMEOUT_MS = 120_000;
/** Any query works: the point is that a read call makes the daemon open its database and start a worker. */
const WARMUP_QUERY = 'main';
/** The command line the warm-up runs; only tests and callers with another install ask for another one. */
const WARMUP_COMMAND = 'codegraph serve --mcp';
/** A background warm-up must never hold its caller: a live daemon is asked within this budget. */
const WARMUP_BACKGROUND_LIVE_MS = 5_000;

/**
 * Talks MCP to `codegraph serve --mcp -p <project>` for the project in `cwd`, started from the temp directory with
 * the project spelled as its daemon registered it: initialize, one `codegraph_explore`, then closes stdin and lets
 * the server go on its own. The project daemon is shared with the user's own sessions, so this never kills the
 * process tree (that would take the daemon with it) and gives up waiting instead; it releases the server's stdout
 * so a server that never leaves cannot keep the process alive. Never rejects.
 */
function exploreOnce(cwd, query, timeoutMs, command = WARMUP_COMMAND, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let exploreStart = 0;
    let child;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Destroy, not end: an ended pipe still holds the event loop until the server exits.
      try { child?.stdin?.destroy(); } catch { /* already closed */ }
      // The server may never leave on its own: its piped stdout would keep the event loop of Pi alive.
      try { child?.stdout?.destroy(); } catch { /* already gone */ }
      try { child?.unref(); } catch { /* already gone */ }
      resolve({ ok, exploreMs: exploreStart === 0 ? 0 : Date.now() - exploreStart });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (options.background === true) timer.unref?.();
    const project = options.project ?? projectArgument(cwd, { registryDir: options.registryDir });
    try {
      // Windows needs a shell for the .cmd shim; the command line is fixed plus the quoted project path.
      const serve = serveCommand(command, project);
      child = (options.spawn ?? nodeSpawn)(serve.command, {
        cwd: tmpdir(),
        env: { ...process.env, ...serve.env },
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      if (options.background === true) {
        child.unref();
        child.stdin?.unref?.();
        child.stdout?.unref?.();
      }
    } catch {
      finish(false);
      return;
    }
    const send = (message) => child?.stdin?.write(`${JSON.stringify(message)}\n`);
    let buffer = '';
    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          exploreStart = Date.now();
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query } } });
        } else if (message.id === 2) {
          // CodeGraph reports a crashed query worker with isError and a text, not with a JSON-RPC error.
          const text = message.result?.content?.[0]?.text;
          const failed = message.error !== undefined || message.result?.isError === true;
          finish(!failed && typeof text === 'string' && !text.startsWith(NO_PROJECT_TEXT));
        }
      }
    });
    child.on('error', () => finish(false));
    child.on('close', () => finish(false));
    child.stdin?.on('error', () => { /* the server exited first */ });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'odd-worktree-codegraph', version: '0' },
        rootUri: pathToFileURL(project).href,
      },
    });
  });
}

/**
 * Warms this checkout's daemon, reusing a live one before starting a server. `initRunning` is the caller's own
 * fact — the index coordination knows it — and while an init runs the warm-up is skipped, so the two never touch
 * the index together. The answer comes from this checkout's own registry, never from MCP configuration, and a
 * warm-up that cannot run answers false instead of failing its caller.
 */
async function warmUpDaemon(cwd, timeoutMs = WARMUP_TIMEOUT_MS, options = {}) {
  try {
    if (options.initRunning === true) return false;
    const status = options.status ?? ((root) => daemonStatus(root, { registryDir: options.registryDir }));
    if (status(cwd) === 'live') {
      // A fire-and-forget warm-up is bounded tightly: the daemon is already there, and nothing may keep the caller.
      const budget = options.background === true ? Math.min(timeoutMs, WARMUP_BACKGROUND_LIVE_MS) : timeoutMs;
      const ask = options.ask ?? ((root, query, ms) => exploreViaDaemon(root, query, ms, { registryDir: options.registryDir }));
      const answered = await ask(cwd, WARMUP_QUERY, budget);
      // A live daemon that does not answer is not doubled: a second server would only be slower.
      return answered.status === 'ok';
    }
    return (await exploreOnce(cwd, WARMUP_QUERY, timeoutMs, options.command ?? WARMUP_COMMAND, options)).ok;
  } catch {
    return false;
  }
}

module.exports = {
  WARMUP_TIMEOUT_MS,
  WARMUP_QUERY,
  WARMUP_COMMAND,
  WARMUP_BACKGROUND_LIVE_MS,
  exploreOnce,
  warmUpDaemon,
};

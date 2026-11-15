'use strict';
// The daemon a checkout already has: resolved from CodeGraph's own registry, one checkout at a time, and asked
// over its own socket. Nothing here starts, configures or stops a daemon, and nothing here trusts the MCP
// configuration: a registered MCP server says nothing about whether a daemon is reachable. The registry is only
// ever read, and only this checkout's records are considered — a worktree is its own root, so its parent's
// daemon is never its own.

const net = require('node:net');
const nodeFs = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { canonicalRoot } = require('./codegraph-paths.js');

/** The hello line a CodeGraph daemon sends carries `protocol`; this is the only one spoken here. */
const DAEMON_PROTOCOL = 1;
/** An explore answer is tens of kilobytes; anything near this size is not one worth keeping in memory. */
const MAX_REPLY_CHARS = 1_000_000;
/** A daemon sends its hello line as soon as it accepts; one silent this long is hung, and the next one gets the rest of the budget. */
const DAEMON_HELLO_TIMEOUT_MS = 2_000;
/** CodeGraph answers an explore without a project with this plain text, not with an error. */
const NO_PROJECT_TEXT = 'No CodeGraph project is loaded';

const PIPE_PREFIX = '\\\\.\\pipe\\';

/**
 * The same project can be spelled with another letter case or a trailing separator, and on Windows as a mapped
 * drive (Y:\...) or as the UNC path behind it (\\server\share\...). One canonical form for every root comparison.
 */
const normalizeRoot = (path) => canonicalRoot(path);

const DEFAULT_REGISTRY = () => join(homedir(), '.codegraph', 'daemons');

/** Every seam with its real default: a registry directory, fs, platform, the liveness check, the socket and the clock. */
function seams(options = {}) {
  return {
    registryDir: options.registryDir ?? DEFAULT_REGISTRY(),
    fs: { ...nodeFs, ...(options.fs ?? {}) },
    platform: options.platform ?? process.platform,
    alive: options.alive ?? processAlive,
    connect: options.connect ?? ((socketPath) => net.createConnection(socketPath)),
    now: options.now ?? Date.now,
  };
}

/** Whether a process with this pid exists; signal 0 only checks. EPERM means it exists under another user. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Whether a daemon socket is still there. A Windows named pipe is not a file: listing the pipe directory shows the
 * live ones without connecting to them, and a listing that fails counts as present rather than risk missing a live
 * daemon. Every other socket path is a socket file, which existsSync checks.
 */
function socketPresent(socketPath, seam) {
  if (seam.platform !== 'win32' || !socketPath.toLowerCase().startsWith(PIPE_PREFIX)) return seam.fs.existsSync(socketPath);
  const name = socketPath.slice(PIPE_PREFIX.length).toLowerCase();
  try {
    return seam.fs.readdirSync(PIPE_PREFIX).some((entry) => entry.toLowerCase() === name);
  } catch {
    return true;
  }
}

/** A record whose process runs and whose socket is still there: only that one is a daemon to reuse. */
function isLive(entry, seam) {
  return entry.pid !== undefined && seam.alive(entry.pid) && socketPresent(entry.socketPath, seam);
}

/** Daemons registered for `root` in any spelling, newest first. Reads the registry only; starts nothing. */
function daemonsFor(root, seam) {
  let files;
  try {
    files = seam.fs.readdirSync(seam.registryDir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  const wanted = normalizeRoot(root);
  const found = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(seam.fs.readFileSync(join(seam.registryDir, file), 'utf8'));
      if (typeof entry.root !== 'string' || typeof entry.socketPath !== 'string') continue;
      if (normalizeRoot(entry.root) !== wanted) continue;
      found.push({
        root: entry.root,
        socketPath: entry.socketPath,
        startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
        pid: typeof entry.pid === 'number' ? entry.pid : undefined,
      });
    } catch {
      /* a damaged record is not a daemon */
    }
  }
  return found.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The newest registered daemon of exactly `root` whose process runs and whose socket is still there. A worktree or
 * child checkout is its own root: nothing registered for another checkout is ever returned here. This reads the
 * registry only — it never starts, connects to or stops anything, and it is not affected by MCP server
 * configuration, which says nothing about whether a daemon is reachable.
 */
function liveDaemon(root, options = {}) {
  const seam = seams(options);
  const daemon = daemonsFor(root, seam).find((entry) => isLive(entry, seam));
  if (daemon === undefined) return undefined;
  return { root: daemon.root, socketPath: daemon.socketPath, ...(daemon.pid === undefined ? {} : { pid: daemon.pid }) };
}

/**
 * What the daemon state of this checkout is: a live one, only records whose daemon is gone, or none. The answer
 * comes from the registry of this root alone, never from an MCP server entry.
 */
function daemonStatus(root, options = {}) {
  const seam = seams(options);
  const daemons = daemonsFor(root, seam);
  if (daemons.length === 0) return 'none';
  return daemons.some((entry) => isLive(entry, seam)) ? 'live' : 'dead';
}

/**
 * How the newest daemon of this project spells its root, or undefined when none is registered. Passing that
 * spelling to codegraph keeps it on the same daemon: CodeGraph keys daemons by the path it was given.
 */
function registeredRoot(root, options = {}) {
  const seam = seams(options);
  // Dead records stay in the registry (CodeGraph owns those files), but they never win: a record is alive only
  // while its process runs and its socket is still there, so a reused pid cannot make a stale spelling win.
  const daemons = daemonsFor(root, seam);
  return (daemons.find((entry) => isLive(entry, seam)) ?? daemons[0])?.root;
}

/** The path to hand to the codegraph CLI for this project: the registered spelling when there is one. */
function projectArgument(root, options = {}) {
  return registeredRoot(root, options) ?? root;
}

/** A socket that accepted but never said hello: the next one gets the rest of the budget. */
async function ask(socketPath, query, timeoutMs, seam) {
  return new Promise((resolveResult) => {
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(helloTimer);
      try { socket?.destroy(); } catch { /* already gone */ }
      resolveResult(result);
    };
    try {
      socket = seam.connect(socketPath);
    } catch {
      resolveResult({ status: 'unavailable' });
      return;
    }
    const budget = Math.max(1, timeoutMs);
    const deadlineTimer = setTimeout(() => finish({ status: 'timeout' }), budget);
    // Only the hello line waits on this timer; the rest of the conversation keeps the whole budget.
    const helloTimer = setTimeout(() => finish({ status: 'silent' }), Math.max(1, Math.min(DAEMON_HELLO_TIMEOUT_MS, budget)));
    const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
    let buffer = '';
    let stage = 'hello';
    socket.setEncoding('utf8');
    socket.on('error', () => finish({ status: 'unavailable' }));
    socket.on('close', () => finish({ status: 'unavailable' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REPLY_CHARS) return finish({ status: 'unavailable' });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish({ status: 'unavailable' }); }
        if (stage === 'hello') {
          if (typeof message.codegraph !== 'string' || message.protocol !== DAEMON_PROTOCOL) return finish({ status: 'unavailable' });
          clearTimeout(helloTimer);
          stage = 'initialize';
          send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'odd-worktree-codegraph', version: '0' } },
          });
        } else if (stage === 'initialize' && message.id === 1) {
          if (message.error !== undefined) return finish({ status: 'unavailable' });
          stage = 'explore';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query } } });
        } else if (stage === 'explore' && message.id === 2) {
          // CodeGraph reports a crashed query worker with isError and a text, not with a JSON-RPC error.
          const text = message.result?.content?.[0]?.text;
          const failed = message.error !== undefined || message.result?.isError === true;
          if (failed || typeof text !== 'string' || text.startsWith(NO_PROJECT_TEXT)) return finish({ status: 'unavailable' });
          return finish({ status: 'ok', text });
        }
      }
    });
  });
}

/**
 * Runs `codegraph_explore` through the daemon already serving `root`, the same text the CLI prints but without a
 * process of its own. It only reads the daemon registry and connects: it never starts a daemon, and never throws.
 */
async function exploreViaDaemon(root, query, timeoutMs, options = {}) {
  const seam = seams(options);
  try {
    const deadline = seam.now() + timeoutMs;
    let silent = false;
    const sockets = daemonsFor(root, seam).map((entry) => entry.socketPath);
    for (const socketPath of sockets) {
      const result = await ask(socketPath, query, deadline - seam.now(), seam);
      if (result.status === 'silent') {
        silent = true;
        continue;
      }
      if (result.status !== 'unavailable') return result;
    }
    // A silent daemon is there but hung: warming another one would not make this query faster.
    return silent ? { status: 'timeout' } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

module.exports = {
  DAEMON_PROTOCOL,
  DAEMON_HELLO_TIMEOUT_MS,
  MAX_REPLY_CHARS,
  NO_PROJECT_TEXT,
  normalizeRoot,
  daemonStatus,
  liveDaemon,
  registeredRoot,
  projectArgument,
  exploreViaDaemon,
};

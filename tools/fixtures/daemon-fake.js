'use strict';
// A fake CodeGraph daemon on a real socket plus a fake registry: the hello/explore protocol and every
// failure shape, without CodeGraph. Tests only ever point the daemon module at these.

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELLO = JSON.stringify({ codegraph: '1.6.0', pid: process.pid, socketPath: 'x', protocol: 1 });

let counter = 0;
const createdDirs = [];
const openedServers = [];

function socketPath(prefix = 'odd-daemon') {
  const name = `${prefix}-${process.pid}-${++counter}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

function scratch(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdDirs.push(dir);
  return dir;
}

/**
 * A daemon that speaks the protocol: `hello` is its first line (null sends nothing), `explore` is what it
 * does with the explore call. Every received line is pushed to `received` when that array is given.
 */
function fakeDaemon(options = {}) {
  const usedPath = socketPath();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    if (options.hello !== null) socket.write(`${options.hello ?? HELLO}\n`);
    const explore = options.explore ?? { text: 'FAKE EXPLORE OUTPUT' };
    if (typeof explore === 'object' && explore.closeAfterHello === true) {
      socket.end();
      return;
    }
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        options.received?.push(line);
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {} } })}\n`);
        } else if (message.method === 'tools/call') {
          if (explore === 'silence') continue;
          if (explore.error !== undefined) {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: explore.error } })}\n`);
          } else if (explore.split !== undefined) {
            const full = `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: explore.split }] } })}\n`;
            socket.write(full.slice(0, 10));
            setTimeout(() => socket.write(full.slice(10)), 30);
          } else {
            const result = explore.isError === true
              ? { isError: true, content: [{ type: 'text', text: explore.text }] }
              : { content: [{ type: 'text', text: explore.text }] };
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
          }
        }
      }
    });
  });
  openedServers.push(server);
  return new Promise((resolve) => server.listen(usedPath, () => resolve({ path: usedPath, close: () => server.close() })));
}

/** A registry directory holding one record per entry, all claiming this process as their daemon. */
function registry(entries) {
  const dir = scratch('odd-daemon-registry-');
  entries.forEach((entry, index) => {
    fs.writeFileSync(path.join(dir, `entry${index}.json`), JSON.stringify({
      root: entry.root,
      pid: process.pid,
      version: '1.6.0',
      socketPath: entry.socketPath,
      startedAt: entry.startedAt ?? Date.now(),
    }));
  });
  return dir;
}

function cleanup() {
  for (const server of openedServers) {
    try { server.close(); } catch { /* already closed */ }
  }
  openedServers.length = 0;
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
}

module.exports = { HELLO, socketPath, scratch, fakeDaemon, registry, cleanup };

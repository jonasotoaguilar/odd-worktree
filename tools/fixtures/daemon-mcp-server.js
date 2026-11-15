'use strict';
// A tiny stdio MCP server standing in for `codegraph serve --mcp`; the mode is argv[2]. It never touches an
// index or the network, and modes other than `stuck` leave as soon as their stdin ends, like the real server.

const { createInterface } = require('node:readline');

const mode = process.argv[2] ?? 'ok';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function exploreResult() {
  // CodeGraph answers a crashed worker with `isError: true` and a text, not with a JSON-RPC error.
  if (mode === 'isError') return { isError: true, content: [{ type: 'text', text: 'codegraph worker crashed; please retry the call.' }] };
  if (mode === 'empty') return {};
  return { content: [{ type: 'text', text: 'FAKE EXPLORE OUTPUT' }] };
}

// A stuck server answers the first call, ignores its stdin closing and leaves on its own twenty seconds later.
// A silent one answers nothing and leaves after 400 ms whichever happens first, so a short-timeout test never
// leaves a process behind. Every other mode goes away as soon as its stdin ends.
if (mode === 'stuck') setTimeout(() => process.exit(0), 20_000);
else if (mode === 'silent') {
  setTimeout(() => process.exit(0), 400);
  process.stdin.on('end', () => process.exit(0));
} else process.stdin.on('end', () => process.exit(0));

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
  } else if (message.method === 'tools/call' && mode !== 'stuck' && mode !== 'silent') {
    send({ jsonrpc: '2.0', id: message.id, result: exploreResult() });
  }
});

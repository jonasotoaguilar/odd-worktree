'use strict';
// Runs one warm-up against the MCP server named in argv[2] and must then exit on its own; it never exits on
// purpose, so only a warm-up that releases the server's pipes ends this process.

const { exploreOnce } = require('../../lib/codegraph-warmup.js');

const command = process.argv[2] ?? '';
const project = process.argv[3] ?? process.cwd();

exploreOnce(project, 'main', 300, command, { project }).then((result) => {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
});

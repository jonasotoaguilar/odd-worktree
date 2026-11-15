'use strict';
// A stand-in for the `codegraph init` process a session started: it announces itself in CodeGraph's own
// `<project>/.codegraph/codegraph.lock` (which is how the real one names the process writing the index) and then
// stays alive until it is killed or its own time runs out. It writes no index and reaches nothing.
//
//   argv: <project> <holdMs>

const fs = require('node:fs');
const path = require('node:path');

const [, , project, holdMs] = process.argv;
const dir = path.join(project, '.codegraph');
const announced = path.join(dir, 'codegraph.lock');

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(announced, String(process.pid));
} catch {
  // A test that cannot write the announcement reports it through the lock it does not find.
}

setTimeout(() => {
  try {
    fs.rmSync(announced, { force: true });
  } catch {
    // Going away is enough.
  }
}, Math.max(1, Number(holdMs) || 30_000));

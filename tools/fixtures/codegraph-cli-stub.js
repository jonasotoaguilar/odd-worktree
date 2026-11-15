'use strict';
// The body of a fake `codegraph` binary for the timeout case: it records its own pid where the test can read it
// and then stays alive, so a timeout has a real process to terminate. It touches no index and reaches nothing.

const fs = require('node:fs');

const file = process.env.CODEGRAPH_STUB_PID_FILE;
if (file) {
  try {
    fs.writeFileSync(file, String(process.pid));
  } catch {
    // The test reports the missing pid.
  }
}

setTimeout(() => {}, 120_000);

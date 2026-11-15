'use strict';
// One "session" for the coordination tests (S3): a process that speaks the public surface of
// `lib/codegraph-lock.js` on its own, so a test can watch what two real processes do to one lock or one lease.
//
//   argv: <lockDir> <project> <startAt> <holdMs|stdin> <mode>
//
// Modes:
//   lock (default)  try to take the init lock; hold it for `holdMs`, or until stdin closes, and release.
//   orphan          take the lock, hand it to a long-lived child of its own and exit WITHOUT releasing, like a Pi
//                   that dies while its init goes on.
//   shell           start the init the way this package does on Windows (through a shell) and adopt that shell's
//                   pid as a proxy, which can die while the init itself goes on.
//   sync            one session asking for a coordinated sync: its fake sync records start and end in
//                   `<project>/runs.log` and lasts `holdMs`, so a test sees whether two ever overlapped.
//   sync-cli        its run starts a detached CLI that keeps writing for `holdMs` after the session is killed,
//                   and reports that pid as the process the sync started.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { syncLease, tryAcquireInitLock } = require('../../lib/codegraph-lock.js');

const [, , lockDir, project, startAt, holdMs, mode] = process.argv;
const INIT_PROCESS = path.join(__dirname, 'codegraph-init-process.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(file, line) {
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // The test reads what it can and reports the rest.
  }
}

function say(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  // Every session waits for the same start line, so they really try at one instant.
  while (Date.now() < Number(startAt || 0)) {
    /* spin */
  }

  if (mode === 'sync' || mode === 'sync-cli') {
    const ledger = path.join(project, 'runs.log');
    const requestedAt = Date.now();
    const lease = syncLease({ dir: lockDir, pollMs: 10, requestWaitMs: 60_000 });
    const outcome = await lease.request(project, async (onSpawn) => {
      if (mode === 'sync') {
        record(ledger, `start ${Date.now()} ${process.pid}`);
        await pause(Number(holdMs));
        record(ledger, `end ${Date.now()} ${process.pid}`);
        return { ran: true, ok: true };
      }
      // The command this session runs outlives it: a detached process writing the index for `holdMs`.
      const script = 'const fs = require("node:fs"); const ledger = ' + JSON.stringify(ledger) + '; '
        + 'fs.appendFileSync(ledger, "cli-start " + Date.now() + "\\n"); '
        + `setTimeout(() => { fs.appendFileSync(ledger, "cli-end " + Date.now() + "\\n"); }, ${Number(holdMs)});`;
      const cli = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true });
      cli.unref();
      onSpawn(cli.pid);
      say({ status: 'running', pid: process.pid, cliPid: cli.pid, requestedAt });
      // The session stays inside its run until the test kills it.
      await new Promise(() => {});
      return { ran: true, ok: true };
    });
    say({ status: 'synced', pid: process.pid, requestedAt, returnedAt: Date.now(), outcome });
    process.exit(0);
  }

  const attempt = tryAcquireInitLock(project, { dir: lockDir });

  if (mode === 'orphan' && attempt.status === 'acquired') {
    const init = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(holdMs)})`], { detached: true, stdio: 'ignore' });
    init.unref();
    attempt.adopt(init.pid);
    say({ status: attempt.status, pid: process.pid, initPid: init.pid });
    process.exit(0);
  }

  if (mode === 'shell' && attempt.status === 'acquired') {
    // `&& exit 0` keeps the shell a real process around the init: a shell that exec'd the command would BE the
    // init, and then killing the shell would prove nothing about the init outliving it.
    const command = `${[process.execPath, INIT_PROCESS, project, String(Number(holdMs))]
      .map((part) => `"${part}"`)
      .join(' ')} && exit 0`;
    const shell = spawn(command, { shell: true, stdio: 'ignore', windowsHide: true });
    attempt.adopt(shell.pid, { proxy: true });
    // Let the init announce itself before this session exits, so the shell's death cannot take it down.
    const announced = path.join(project, '.codegraph', 'codegraph.lock');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(announced)) break;
      await pause(50);
    }
    say({ status: attempt.status, pid: process.pid, initPid: shell.pid });
    process.exit(0);
  }

  say({ status: attempt.status, pid: process.pid });
  if (attempt.status === 'acquired') {
    if (holdMs === 'stdin') {
      await new Promise((resolve) => {
        process.stdin.on('end', resolve);
        process.stdin.on('close', resolve);
        process.stdin.resume();
      });
    } else {
      await pause(Number(holdMs));
    }
    attempt.release();
  }
}

main();

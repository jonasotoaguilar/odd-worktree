'use strict';
// The three CodeGraph session commands' bodies (S9): `/codegraph-hook`,
// `/codegraph-init` and `/codegraph-sync`.
//
// They are plain functions returning a render-ready result — `{ok, level,
// text}` — so the extension only has to hand the line to `ctx.ui.notify`. The
// registration itself is the extension's job and is gated on the session gate,
// so a session without the CLI never lists these commands.
//
// `/codegraph-hook` flips the in-memory, process-wide switch owned by
// `codegraph-session.js`: nothing is written to user configuration, and the
// environment (`CODEGRAPH_HOOK=0`) is only the starting state.
//
// `init` and `sync` run the real CLI once, at the session's current directory,
// through the injected `run` seam. The reported line is the child's real
// outcome: a non-zero (or unstartable) child is a failure, and no path throws
// into the command handler.

const { isHookEnabled, setHookEnabled } = require('./codegraph-session.js');

const CODEGRAPH_BIN = 'codegraph';
const COMMANDS = { init: 'codegraph init', sync: 'codegraph sync' };

function pick(deps, name, fallback) {
  return deps && typeof deps[name] === 'function' ? deps[name] : fallback;
}

// The convention every other lib helper uses for its runner;
// `runArgvAsync` resolves (never rejects) with `{status, stdout, stderr, error}`.
function defaultRun(bin, args, cwd) {
  return require('./worktree-git.js').runArgvAsync(bin, args, { cwd });
}

function sessionCwd(ctx) {
  const cwd = ctx && ctx.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

// One line of child output, so a multi-line stack never becomes the message.
function firstLine(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return '';
}

function hookState() {
  return isHookEnabled() ? 'enabled' : 'disabled';
}

// `/codegraph-hook` — no argument toggles; `on` and `off` set the state
// explicitly; `status` only reports it.
function codegraphHook(rawArgs) {
  const raw = String(rawArgs === undefined || rawArgs === null ? '' : rawArgs).trim().toLowerCase();
  if (raw === '' || raw === 'on' || raw === 'off') setHookEnabled(raw === '' ? !isHookEnabled() : raw === 'on');
  else if (raw !== 'status') {
    return { ok: false, level: 'error', text: `codegraph hook: unknown option "${raw}". Use on, off or status.` };
  }
  return { ok: true, level: 'info', text: `codegraph hook: ${hookState()}` };
}

async function runStep(verb, rawArgs, ctx, deps) {
  const label = COMMANDS[verb];
  const raw = String(rawArgs === undefined || rawArgs === null ? '' : rawArgs).trim();
  if (raw !== '') return { ok: false, level: 'error', text: `${label}: takes no argument.` };

  const cwd = sessionCwd(ctx);
  let outcome;
  try {
    outcome = await pick(deps, 'run', defaultRun)(CODEGRAPH_BIN, [verb, '.'], cwd);
  } catch (err) {
    return { ok: false, level: 'error', text: `${label}: failed — ${firstLine((err && err.message) || String(err))}` };
  }
  const out = outcome && typeof outcome === 'object' ? outcome : {};
  if (out.error) {
    return { ok: false, level: 'error', text: `${label}: failed — ${firstLine(out.error) || 'unknown error'}` };
  }
  if (out.status !== 0) {
    const exit = Number.isInteger(out.status) ? out.status : 'unknown';
    const detail = firstLine(out.stderr) || firstLine(out.stdout) || 'no output';
    return { ok: false, level: 'error', text: `${label}: exit ${exit} — ${detail}` };
  }
  return { ok: true, level: 'info', text: `${label}: exit 0` };
}

// `/codegraph-init` and `/codegraph-sync` — one awaited CLI run at the session's
// current directory, reported by its real exit status.
function codegraphInit(rawArgs, ctx, deps) {
  return runStep('init', rawArgs, ctx, deps);
}

function codegraphSync(rawArgs, ctx, deps) {
  return runStep('sync', rawArgs, ctx, deps);
}

module.exports = {
  codegraphHook,
  codegraphInit,
  codegraphSync,
};

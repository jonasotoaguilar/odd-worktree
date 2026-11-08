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

// The CLI is chatty and decorative (a box around every line, ANSI colours, and
// glyphs that change between releases), so the report is built from the plain
// text it puts on stdout and stderr rather than from the exit status alone. The
// captured shapes this reads:
//
//   init, fresh      "Initialized in <path>" / "Indexed N files" / "N nodes, M edges in Tms"
//   init, indexed    "Already initialized in <path>" / "Use \"codegraph index\" to re-index ..."
//   sync, clean      "Already up to date"
//   sync, changed    "Synced N changed files" / "Modified: N — M nodes in Tms"
//   sync, no index   "CodeGraph not initialized in <path>" (stderr, exit 1)
const ANSI = /\u001b\[[0-9;]*[a-zA-Z]/g;

function plain(text) {
  return String(text === undefined || text === null ? '' : text).replace(ANSI, '');
}

function count(value, noun) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function summarize(label, out) {
  const text = `${plain(out.stdout)}\n${plain(out.stderr)}`;
  const path = (match) => (match && match[1] ? match[1].trim() : '');

  const notIndexed = text.match(/not initialized in\s+(\S+)/i);
  if (notIndexed) {
    return { ok: false, level: 'error', text: `${label}: no index in this checkout — run /codegraph-init first` };
  }
  const already = text.match(/already initialized in\s+(\S+)/i);
  if (already) {
    return { ok: true, level: 'info', text: `${label}: already initialized at ${path(already)} — nothing to do, use /codegraph-sync to update` };
  }
  const upToDate = /already up to date/i.test(text);
  if (upToDate) {
    return { ok: true, level: 'info', text: `${label}: already up to date — nothing to sync` };
  }
  const synced = text.match(/synced\s+(\d+)\s+changed\s+files?/i);
  if (synced) {
    const nodes = text.match(/(\d+)\s+nodes?/i);
    const counts = [count(synced[1], 'changed file'), nodes ? count(nodes[1], 'node') : ''].filter(Boolean).join(' — ');
    return { ok: true, level: 'info', text: `${label}: synced ${counts}` };
  }
  const initialized = text.match(/initialized in\s+(\S+)/i);
  if (initialized) {
    const files = text.match(/indexed\s+(\d+)\s+files?/i);
    const nodes = text.match(/(\d+)\s+nodes?/i);
    const edges = text.match(/(\d+)\s+edges?/i);
    const sorted = [
      files ? count(files[1], 'file') : '',
      nodes ? count(nodes[1], 'node') : '',
      edges ? count(edges[1], 'edge') : '',
    ].filter(Boolean).join(', ');
    return { ok: true, level: 'info', text: `${label}: initialized ${path(initialized)}${sorted ? ` — ${sorted}` : ''}` };
  }
  return null;
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
  const summary = summarize(label, out);
  // The CLI answers `sync` in a checkout with no index on stderr with exit 1,
  // so the recognised message decides before the exit status does.
  if (summary && (summary.ok || /no index/.test(summary.text))) return summary;
  if (out.error) {
    return { ok: false, level: 'error', text: `${label}: failed — ${firstLine(out.error) || 'unknown error'}` };
  }
  if (out.status !== 0) {
    const exit = Number.isInteger(out.status) ? out.status : 'unknown';
    const detail = firstLine(plain(out.stderr)) || firstLine(plain(out.stdout)) || 'no output';
    return { ok: false, level: 'error', text: `${label}: exit ${exit} — ${detail}` };
  }
  return summary || { ok: true, level: 'info', text: `${label}: done` };
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

'use strict';
// S9: freshness without a daemon. After a successful `edit` or `write`, ask for one background sync of the checkout the edited
// file lives in (its git toplevel, read once per directory), debounced per checkout, on the same coordination every other index
// write uses. It never runs while a live daemon watches that checkout (the daemon's watcher already syncs it), never in a
// read-only role, never without the CLI or without an index, and a sync asked for while one runs becomes exactly one more when
// it ends. Git, the index check, the daemon check, the sync and the timers are all injected; nothing here throws into the host.
//
// S2: the window is also observable. A search that would read the index while a window writes it joins that window with
// `whenIdle` (bounded) instead of racing it, and `inFlight` answers synchronously whether there is anything to join, so a
// caller with nothing in flight adds no latency at all. Joining never starts a sync.

const { execFile } = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const EDIT_TOOLS = new Set(['edit', 'write']);
const DEBOUNCE_MS = 2000;
const GIT_TIMEOUT_MS = 5000;

/** The git toplevel of a directory through one fixed-argv child, awaited; undefined when it is not a checkout. */
function gitToplevel(dir) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        const top = error ? '' : String(stdout).trim();
        resolve(top.length > 0 ? top : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function editedPath(event, cwd) {
  const input = event && typeof event.input === 'object' && event.input !== null ? event.input : {};
  const raw = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
  if (raw.length === 0) return undefined;
  return nodePath.isAbsolute(raw) ? raw : nodePath.resolve(cwd || process.cwd(), raw);
}

function createEditSync(deps = {}) {
  const available = deps.available || (() => true);
  const toplevel = deps.toplevel || gitToplevel;
  const hasIndex = deps.hasIndex || ((root) => nodeFs.existsSync(nodePath.join(root, '.codegraph')));
  const daemonLive = deps.daemonLive || (() => false);
  const setTimer = deps.setTimer || ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  });
  const clearTimer = deps.clearTimer || ((timer) => clearTimeout(timer));
  const debounceMs = deps.debounceMs === undefined ? DEBOUNCE_MS : deps.debounceMs;

  const roots = new Map(); // directory -> toplevel | null
  const windows = new Map(); // root -> { timer, running, pending, queued, waiters }

  /** Whether this root has a sync running, one owed, or (only while running) a re-run asked for. */
  function inFlightState(state) {
    return state.running === true || state.pending === true || state.queued === true;
  }

  /** Answers every joined caller at once: the window reached a quiet point, was disposed, or ran out its budget. */
  function settle(state, reason) {
    for (const waiter of state.waiters.splice(0)) {
      if (waiter.timer !== undefined) clearTimer(waiter.timer);
      waiter.resolve(reason);
    }
  }

  async function rootOf(dir) {
    if (roots.has(dir)) return roots.get(dir);
    let top;
    try {
      top = await toplevel(dir);
    } catch {
      top = undefined;
    }
    const root = typeof top === 'string' && top.length > 0 ? top : null;
    roots.set(dir, root);
    return root;
  }

  async function runWindow(root) {
    const state = windows.get(root);
    if (!state) return;
    state.timer = undefined;
    if (state.running) {
      state.pending = true;
      return;
    }
    state.running = true;
    state.queued = false;
    try {
      await deps.sync(root);
    } catch {
      // A failed background sync is never worth bothering the session.
    } finally {
      state.running = false;
    }
    if (state.pending) {
      state.pending = false;
      // Owed from here until the window this re-arms runs: a caller that joined waits for that one too.
      state.queued = true;
      schedule(root);
    }
    if (!inFlightState(state)) settle(state, 'done');
  }

  function schedule(root) {
    let state = windows.get(root);
    if (!state) {
      state = { timer: undefined, running: false, pending: false, queued: false, waiters: [] };
      windows.set(root, state);
    }
    if (state.running) {
      state.pending = true;
      return;
    }
    if (state.timer !== undefined) clearTimer(state.timer);
    state.timer = setTimer(() => runWindow(root), debounceMs);
  }

  return {
    /** The host's `tool_result` event. Resolves once the window is scheduled, never after the sync. */
    async onToolResult(event, ctx) {
      try {
        if (!event || event.isError === true || !EDIT_TOOLS.has(event.toolName)) return;
        if (deps.role === 'read-only') return;
        if (!available()) return;
        const file = editedPath(event, (ctx && ctx.cwd) || deps.cwd);
        if (file === undefined) return;
        const root = await rootOf(nodePath.dirname(file));
        if (root === null) return;
        if (!hasIndex(root)) return;
        if (daemonLive(root)) return;
        schedule(root);
      } catch {
        // The host never sees a failure of this hook.
      }
    },
    /**
     * Whether this root has a sync running or one owed right now. Synchronous on purpose: the caller that finds
     * nothing to join declines to wait at all. A window that is only debounced is scheduled, not in flight.
     */
    inFlight(root) {
      const state = windows.get(root);
      return state !== undefined && inFlightState(state);
    },
    /**
     * Settles with `'done'` when the running sync and the one follow-up it owes have finished, `'idle'` at once
     * when nothing is in flight (or the budget is not a positive number), `'budget'` when the budget ran out first,
     * and `'disposed'` when shutdown ended the wait. Never rejects, never starts a sync.
     */
    whenIdle(root, budgetMs) {
      const state = windows.get(root);
      if (state === undefined || !inFlightState(state)) return Promise.resolve('idle');
      if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs <= 0) return Promise.resolve('budget');
      return new Promise((resolve) => {
        const waiter = { resolve, timer: undefined };
        waiter.timer = setTimer(() => {
          waiter.timer = undefined;
          const at = state.waiters.indexOf(waiter);
          if (at !== -1) state.waiters.splice(at, 1);
          resolve('budget');
        }, budgetMs);
        state.waiters.push(waiter);
      });
    },
    /** Clears every pending window (session shutdown), and releases whoever joined one instead of leaving it waiting. */
    dispose() {
      for (const state of windows.values()) {
        if (state.timer !== undefined) clearTimer(state.timer);
        state.timer = undefined;
        state.pending = false;
        state.queued = false;
        settle(state, 'disposed');
      }
    },
  };
}

module.exports = { createEditSync, gitToplevel, DEBOUNCE_MS };

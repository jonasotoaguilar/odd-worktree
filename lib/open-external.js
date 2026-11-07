'use strict';
// External opener (key-consistency K3/S5): `o` in the odd viewer opens the
// focused document through `$VISUAL`/`$EDITOR`.
//
// Fixed argv, no shell, injectable spawn, honest result: the promise never
// rejects — a missing editor or a failed spawn resolves
// `{ ok: false, error }` naming what is wrong, so the caller shows it
// instead of failing silently. Success resolves `{ ok: true, editor }`.

const OPEN_TIMEOUT_MS = 15000;

function resolveEditor(opts = {}) {
  if (typeof opts.editor === 'string' && opts.editor.trim() !== '') return opts.editor.trim();
  let env = null;
  try {
    env = opts.env || process.env;
  } catch {
    env = null;
  }
  for (const name of ['VISUAL', 'EDITOR']) {
    let value = null;
    try {
      value = env ? env[name] : null;
    } catch {
      value = null;
    }
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function splitCommand(command) {
  return String(command).trim().split(/\s+/).filter((part) => part.length > 0);
}

function shortError(err) {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err.split('\n')[0];
  return String((err && err.message) || err).split('\n')[0];
}

async function openExternal(target, opts = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, error: 'nothing to open: no document is focused' };
  }
  const editor = resolveEditor(opts);
  if (!editor) {
    return { ok: false, error: 'no editor configured: set $VISUAL or $EDITOR to open documents outside Pi' };
  }
  const parts = splitCommand(editor);
  const bin = parts[0];
  const prefix = parts.slice(1);
  let spawnImpl = opts.spawnImpl;
  if (typeof spawnImpl !== 'function') {
    try {
      spawnImpl = require('node:child_process').spawn;
    } catch (err) {
      return { ok: false, error: `cannot open ${target}: child_process is unavailable` };
    }
  }
  let child = null;
  try {
    // Fixed argv: the editor binary plus its own flags plus the target as
    // one element. Never a shell string, so no quoting or injection.
    child = spawnImpl(bin, [...prefix, target], { stdio: 'inherit', windowsHide: true });
  } catch (err) {
    return { ok: false, error: `cannot open ${target} with ${bin}: ${shortError(err)}` };
  }
  if (!child || typeof child.on !== 'function' || typeof child.once !== 'function') {
    return { ok: false, error: `cannot open ${target} with ${bin}: the editor did not start` };
  }
  // A detached editor must not hold the session open waiting on it.
  try {
    if (typeof child.unref === 'function') child.unref();
  } catch {
    // Best effort only; the result below still reports honestly.
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch {
        // A dead timer never blocks the result.
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `cannot open ${target} with ${bin}: the editor did not start` });
    }, OPEN_TIMEOUT_MS);
    try {
      child.once('error', (err) => {
        finish({ ok: false, error: `cannot open ${target} with ${bin}: ${shortError(err)}` });
      });
      child.once('spawn', () => {
        finish({ ok: true, editor: bin });
      });
    } catch (err) {
      finish({ ok: false, error: `cannot open ${target} with ${bin}: ${shortError(err)}` });
    }
  });
}

module.exports = { openExternal, resolveEditor };

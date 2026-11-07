'use strict';
// System clipboard writer for the issues viewer (key-consistency S6/K4:
// `y` copies the issue number, `Y` its URL).
//
// Tries the platform clipboard tools in order with fixed argv arrays and
// NO shell string — the text travels on stdin, never interpolated into a
// command line. Injectable runner seam: `setClipboardRunner(fn)` replaces
// the default runner with `fn(bin, argv, {text})` (may be sync or async).
// The runner may resolve to a result `{status, stdout, stderr, error}`
// like the gh-issues runner, or to a still-running child with
// `{stdin, unref(), on()}` (e.g. wl-copy, which accepts the text and then
// stays alive serving the selection). Pass `null` to restore the default.
//
// `writeText(text)` returns `{ok:true, via}` naming the tool that took the
// text, or `{ok:false, error}`. Success means the binary resolved, started,
// and accepted the text on stdin — it never waits for the helper to EXIT,
// so a serving helper is detached (unref'd) instead of timing out. A
// missing tool (ENOENT) falls through to the next candidate; when none
// exists the miss is reported honestly — the caller must say so, never
// pretend it copied.

const { spawn } = require('node:child_process');

const CLIPBOARD_TOOLS = [
  { bin: 'pbcopy', argv: [] },
  { bin: 'wl-copy', argv: [] },
  { bin: 'xclip', argv: ['-selection', 'clipboard'] },
  { bin: 'xsel', argv: ['--clipboard', '--input'] },
];

let runnerOverride = null;

// Test seam: inject `fn(bin, argv, {text})` (may be sync or async), or
// `null`/`undefined` to restore the default runner.
function setClipboardRunner(fn) {
  if (fn === null || fn === undefined) {
    runnerOverride = null;
    return;
  }
  if (typeof fn !== 'function') throw new TypeError('setClipboardRunner requires a function or null');
  runnerOverride = fn;
}

function isMissingTool(error) {
  return typeof error === 'string' && /ENOENT/i.test(error);
}

function isChildLike(value) {
  return Boolean(value)
    && typeof value === 'object'
    && Boolean(value.stdin)
    && (typeof value.stdin.write === 'function' || typeof value.stdin.end === 'function');
}

// Default runner: argv array, no shell, text on stdin. Resolves to
// {status, stdout, stderr, error} once the text is accepted — never waits
// for the helper to exit. The child is detached (stdio ignored except the
// piped stdin, then unref'd) so a serving helper such as wl-copy neither
// blocks the event loop nor becomes a waited-on zombie. Never throws.
function defaultRunner(bin, argv, runOpts = {}) {
  const text = runOpts && typeof runOpts.text === 'string' ? runOpts.text : '';
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(bin, argv, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch (err) {
      settle({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
      return;
    }
    child.on('error', (err) => {
      settle({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
    });
    try {
      child.stdin.write(text, (writeErr) => {
        if (writeErr) {
          settle({
            status: null,
            stdout: '',
            stderr: '',
            error: (writeErr && writeErr.message) || String(writeErr),
          });
          return;
        }
        try {
          child.stdin.end();
        } catch (err) {
          settle({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
          return;
        }
        // Accepted: detach and report success without waiting for exit.
        try {
          if (typeof child.unref === 'function') child.unref();
        } catch (err) {
          settle({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
          return;
        }
        settle({ status: 0, stdout: '', stderr: '', error: null });
      });
    } catch (err) {
      settle({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
    }
  });
}

// Feed the text to an injected still-running child (the wl-copy shape).
// Resolves to `{type:'ok'}` once the write is accepted (ending stdin and
// unrefing the child), `{type:'write-error', message}` when the write
// itself fails, or `{type:'child-error', message}` when the child reports
// an error first (e.g. a missing binary). Never waits for exit.
function feedChild(child, text) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    if (child && typeof child.on === 'function') {
      try {
        child.on('error', (err) => {
          settle({ type: 'child-error', message: (err && err.message) || String(err) });
        });
      } catch (err) {
        settle({ type: 'write-error', message: (err && err.message) || String(err) });
        return;
      }
    }
    const stdin = child.stdin;
    const finishWrite = () => {
      try {
        if (stdin && typeof stdin.end === 'function') stdin.end();
      } catch (err) {
        settle({ type: 'write-error', message: (err && err.message) || String(err) });
        return;
      }
      try {
        if (typeof child.unref === 'function') child.unref();
      } catch (err) {
        settle({ type: 'write-error', message: (err && err.message) || String(err) });
        return;
      }
      settle({ type: 'ok' });
    };
    try {
      if (!stdin || typeof stdin.write !== 'function') {
        if (stdin && typeof stdin.end === 'function') {
          stdin.end(text, finishWrite);
          return;
        }
        settle({ type: 'write-error', message: 'clipboard helper stdin is not writable' });
        return;
      }
      // A write implementation that ignores callbacks signals acceptance by
      // returning without throwing; only callback-style writes settle async.
      if (stdin.write.length < 2) {
        stdin.write(text);
        finishWrite();
        return;
      }
      stdin.write(text, (writeErr) => {
        if (writeErr) {
          settle({ type: 'write-error', message: (writeErr && writeErr.message) || String(writeErr) });
          return;
        }
        finishWrite();
      });
    } catch (err) {
      settle({ type: 'write-error', message: (err && err.message) || String(err) });
    }
  });
}

async function writeText(text) {
  if (typeof text !== 'string' || text === '') {
    return { ok: false, error: 'nothing to copy: refusing an empty clipboard write' };
  }
  const run = runnerOverride || defaultRunner;
  const tried = [];
  for (const tool of CLIPBOARD_TOOLS) {
    let raw;
    try {
      raw = await run(tool.bin, tool.argv.slice(), { text });
    } catch (err) {
      // A thrown ENOENT means the binary is missing: try the next tool.
      // Any other throw is a genuine failure of a present helper.
      const message = (err && err.message) || String(err);
      if (isMissingTool(message)) {
        tried.push(tool.bin);
        continue;
      }
      return { ok: false, error: `clipboard copy failed (${tool.bin}): ${message}` };
    }
    if (isChildLike(raw)) {
      const fed = await feedChild(raw, text);
      if (fed.type === 'ok') return { ok: true, via: tool.bin };
      if (fed.type === 'child-error' && isMissingTool(fed.message)) {
        tried.push(tool.bin);
        continue;
      }
      return { ok: false, error: `clipboard copy failed (${tool.bin}): ${fed.message}` };
    }
    const outcome = raw && typeof raw === 'object' ? raw : {};
    const error = outcome.error === null || outcome.error === undefined ? null : String(outcome.error);
    const status = typeof outcome.status === 'number' ? outcome.status : null;
    if (status === 0 && error === null) return { ok: true, via: tool.bin };
    if (error !== null && isMissingTool(error)) {
      tried.push(tool.bin);
      continue;
    }
    return { ok: false, error: `clipboard copy failed (${tool.bin}): ${error || `exit status ${status}`}` };
  }
  return {
    ok: false,
    error: `no clipboard tool available (tried ${tried.join(', ')}): install pbcopy, wl-copy, xclip or xsel to copy`,
  };
}

module.exports = { setClipboardRunner, writeText };

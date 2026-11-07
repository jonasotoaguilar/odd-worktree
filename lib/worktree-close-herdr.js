'use strict';
// S6: the checkout removal for `worktree_close` — git, and only git.
//
// History worth knowing, because the file keeps its name: this module used to
// reconcile Herdr workspaces around a close (closing every workspace of the
// checkout's group, then opening a fresh one at the principal, because Herdr
// has no path move) and could hand the removal to Herdr instead. Both are gone.
// A deletion performed by this package never closes, opens or retires a Herdr
// panel, and it never asks Herdr to remove a checkout — Herdr cannot be asked
// to delete a worktree without retiring the workspace behind the human's back.
//
// What remains is one fixed argv: `git worktree remove <absolute path>`, with
// `--force` only when the caller asked for it. It never deletes the branch and
// never passes `--trust-repository`.
//
// No static package imports (node builtins only), so the extension's
// copy-to-.mjs test loaders keep working.

const path = require('node:path');

// Interactive removals can be slow on a large checkout; same bound the close
// has always used for its remover child.
const REMOVE_TIMEOUT_MS = 120000;

// The removal argv. The target must already be the absolute, verified path —
// the caller derives it from the registry entry and never from a process cwd.
// A relative target is refused here rather than resolved against whatever
// directory the child happens to run in.
function gitRemovalArgv(resolvedTarget, force) {
  if (typeof resolvedTarget !== 'string' || !path.isAbsolute(resolvedTarget)) {
    throw new TypeError('gitRemovalArgv requires an absolute checkout path');
  }
  const argv = ['worktree', 'remove'];
  if (force === true) argv.push('--force');
  argv.push(resolvedTarget);
  return argv;
}

// Ask git to remove the checkout. `runAsync(bin, argv, options)` is the
// caller's awaited child runner (lib/worktree-git.js `runArgvAsync`), which
// spawns synchronously and returns `{status, stdout, stderr, error}`. Resolves;
// never rejects: every failure is `{removed: false, error}` and the backend's
// own first-line reason is preserved for the human.
async function removeCheckout({ runAsync, repoRoot, resolvedTarget, force }) {
  if (typeof runAsync !== 'function') {
    return { removed: false, error: 'the git runner is unavailable, so no checkout was removed' };
  }
  let argv;
  try {
    argv = gitRemovalArgv(resolvedTarget, force === true);
  } catch (err) {
    return { removed: false, error: (err && err.message) || String(err) };
  }
  let out;
  try {
    out = await runAsync('git', argv, { cwd: repoRoot, timeoutMs: REMOVE_TIMEOUT_MS });
  } catch (err) {
    return { removed: false, error: (err && err.message) || String(err) };
  }
  if (!out || out.status !== 0) {
    const text = out && typeof out.stderr === 'string' && out.stderr.trim().length > 0
      ? out.stderr
      : (out && typeof out.error === 'string' ? out.error : '');
    return { removed: false, error: text.trim() || 'git worktree removal failed' };
  }
  return { removed: true, removedBy: 'git' };
}

module.exports = {
  REMOVE_TIMEOUT_MS,
  gitRemovalArgv,
  removeCheckout,
};

'use strict';
// A LOCAL executable lookup: does this process's PATH hold this command?
//
// S13 (issues-startup-performance T11): the issues surfaces have to know whether
// `gh` exists BEFORE they spend a child process finding out. Running a missing
// binary costs a fork and answers ENOENT, and the answer was already on disk — it
// is the PATH walk below. So this is the whole probe: stat/access over the
// directories `PATH` names, no child, no network, no cache.
//
// It is small and fully injectable on purpose: the environment, the platform and
// the executable test all arrive as options, so a test drives every branch
// (win32's `;` and `PATHEXT` included) without a real install, and the caller
// never reads `process.env` behind its own back.
//
// Nothing is memoized. PATH belongs to the caller's live environment, and a
// cached absence would keep the surfaces off after the install that fixed it.
//
// `isExecutable(candidate)` defaults to the platform's own rule: an existing
// regular file with the executable bit on POSIX, an existing regular file on
// win32 (where the extension decides, and the filesystem is case-insensitive).
// A directory is never a command.

const fs = require('node:fs');
const path = require('node:path');

// Windows spells the variable `Path` as often as `PATH`; both are the same list.
function pathValueOf(env) {
  if (!env || typeof env !== 'object') return '';
  if (typeof env.PATH === 'string') return env.PATH;
  if (typeof env.Path === 'string') return env.Path;
  return '';
}

function defaultIsExecutable(platform) {
  return (candidate) => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return false;
      if (platform === 'win32') return true;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

// The candidate spellings of ONE name in one directory: the name itself, then
// every `PATHEXT` extension, in the order the shell itself would try them.
function candidatesFor(directory, name, platform, env, join) {
  if (platform !== 'win32') return [join(directory, name)];
  const raw = env && typeof env.PATHEXT === 'string' && env.PATHEXT.length > 0
    ? env.PATHEXT
    : '.EXE;.CMD;.BAT;.COM';
  const extensions = ['', ...raw.split(';').filter((entry) => entry.length > 0)];
  return extensions.map((extension) => join(directory, `${name}${extension}`));
}

// The first executable spelled `name` on the given PATH, as the whole path, or
// `null`. An absolute `name` is tested on its own — a caller that names its own
// binary (an installer's full path) is not a PATH question.
function whichCommand(name, options = {}) {
  try {
    if (typeof name !== 'string' || name.length === 0) return null;
    const opts = options && typeof options === 'object' ? options : {};
    const env = opts.env && typeof opts.env === 'object' ? opts.env : {};
    const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
    const isExecutable = typeof opts.isExecutable === 'function'
      ? opts.isExecutable
      : defaultIsExecutable(platform);
    const join = platform === 'win32' ? path.win32.join : path.join;
    if (path.isAbsolute(name)) return isExecutable(name) ? name : null;
    const value = pathValueOf(env);
    if (value.length === 0) return null;
    const delimiter = platform === 'win32' ? ';' : path.delimiter;
    for (const directory of value.split(delimiter)) {
      if (directory.length === 0) continue;
      for (const candidate of candidatesFor(directory, name, platform, env, join)) {
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  } catch {
    // A probe never throws: an unreadable environment is "not found", which the
    // caller reports as the state it already knows how to draw.
    return null;
  }
}

module.exports = { whichCommand };

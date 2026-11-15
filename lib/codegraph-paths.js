'use strict';
// One root identity and one way to start codegraph (shared by the index, lock and daemon modules).
//
// Windows spells a network folder two ways, the mapped drive (Y:\...) and the UNC path behind it
// (\\server\share\...), and cmd.exe, which the npm `.cmd` shim needs, does not accept a UNC working
// directory. So roots are compared in one canonical form, and codegraph always runs from the temp
// directory with the project passed as an argument. The project path never goes into the command line
// itself on Windows (cmd.exe would expand %VAR% in it): it travels in PROJECT_ENV. Elsewhere it is a plain
// argv element and no shell is involved. A path neither realpath form can resolve keeps the resolved
// identity of its nearest resolvable parent, with the rest appended.

const { realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');

/** Lower case and no trailing separator on Windows; only the trailing separator elsewhere. */
function foldRoot(path, platform = process.platform) {
  let out = path;
  while (out.length > 1 && (out.endsWith('\\') || out.endsWith('/')) && !/^[A-Za-z]:[\\/]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return platform === 'win32' ? out.toLowerCase() : out;
}

function unfoldRoot(path) {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      const parent = dirname(path);
      if (parent === path) return path;
      return join(unfoldRoot(parent), basename(path));
    }
  }
}

/** The identity of a project root: symlinks resolved, and on Windows the mapped drive as its UNC path. */
function canonicalRoot(path, platform = process.platform) {
  return foldRoot(unfoldRoot(resolve(path)), platform);
}

/** The environment variable that carries the project path to a Windows shell command line. */
const PROJECT_ENV = 'ODD_WORKTREE_CODEGRAPH_PROJECT';

function projectArg(project, platform) {
  if (platform === 'win32') {
    return { command: `"%${PROJECT_ENV}%"`, env: { [PROJECT_ENV]: project.endsWith('\\') ? `${project}.` : project } };
  }
  return { command: `"$${PROJECT_ENV}"`, env: { [PROJECT_ENV]: project } };
}

/** `codegraph <args> <project>` from the temp dir: through cmd.exe on Windows, without a shell elsewhere. */
function codegraphSpawn(args, project, platform = process.platform) {
  if (platform === 'win32') {
    const arg = projectArg(project, platform);
    return { command: ['codegraph', ...args, arg.command].join(' '), args: [], cwd: tmpdir(), shell: true, env: arg.env };
  }
  return { command: 'codegraph', args: [...args, project], cwd: tmpdir(), shell: false, env: {} };
}

/** The warm-up server command with the project named by -p. */
function serveCommand(command, project, platform = process.platform) {
  const arg = projectArg(project, platform);
  return { command: `${command} -p ${arg.command}`, env: arg.env };
}

module.exports = { foldRoot, canonicalRoot, PROJECT_ENV, codegraphSpawn, serveCommand };

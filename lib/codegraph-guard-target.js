'use strict';
// T2 (S3, S4, S8): which checkout a finished search or read call went to.
//
// The call alone says where it looked. `grep`, `find` and `ls` name a path (or default to the session's
// checkout); `read` opens one file, and only a code file counts; `bash` is read as a shell, so a `cd`
// target and the absolute paths its search or read verbs pass are the places it went. The git toplevel
// of a directory is the only checkout identity, read once per directory through one fixed-argv child
// (`git -C <dir> rev-parse --show-toplevel`) and cached, so a later call never waits for git twice.
//
// A directory outside every checkout is no checkout at all: nothing here invents one, and nothing here
// ever throws into the host. Parsing is pure; the resolution takes an injected `toplevel`.

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { gitToplevel } = require('./codegraph-edit-sync.js');

/** The built-in tools a finished call is read from, besides this package's own `bash` reading. */
const SEARCH_TOOLS = ['grep', 'find', 'ls', 'read'];

/** The extensions the CodeGraph rule exempts: a config or a doc is not the code the graph indexes. */
const DOC_EXTENSIONS = ['.md', '.json', '.yml', '.yaml', '.toml', '.txt'];

/** The programs whose presence makes a `bash` command a search or a read of code. */
const READ_VERBS = ['grep', 'rg', 'find', 'fd', 'ls', 'cat', 'sed', 'head', 'tail', 'awk', 'tree'];

/** The verbs whose first non-flag argument is a pattern or a script, never a path. */
const EXPRESSION_FIRST = ['grep', 'rg', 'fd', 'sed', 'awk'];

/** Whether a file is code: an extension the rule exempts is a doc or a config, everything else is code. */
function isCodeFile(file) {
  const extension = nodePath.extname(typeof file === 'string' ? file : '').toLowerCase();
  return extension.length === 0 || !DOC_EXTENSIONS.includes(extension);
}

// ---- the shell reading (S3) ----

// The index of the `)` closing a `$(` whose body starts at `start`, or -1.
function substitutionEnd(command, start) {
  let depth = 1;
  for (let i = start; i < command.length; i += 1) {
    const char = command[i];
    if (char === '\\') i += 1;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * A shell command as the simple commands it runs, split on `;`, `&&`, `||`, `|` and newlines. Quotes are
 * respected, and a `$(...)` body is read as one opaque word: a command hidden there is not one this
 * reader claims, so it is never counted on its own.
 */
function shellSegments(command) {
  const segments = [];
  const piped = [];
  let afterPipe = false;
  const flush = (nextAfterPipe) => {
    segments.push(current);
    piped.push(afterPipe);
    afterPipe = nextAfterPipe;
    current = '';
  };
  let current = '';
  let quote;
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (quote !== undefined) {
      current += char;
      if (char === '\\' && quote === '"' && command[i + 1] !== undefined) {
        current += command[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (char === '\\') {
      current += char + (command[i + 1] === undefined ? '' : command[i + 1]);
      i += 2;
      continue;
    }
    if (char === '$' && command[i + 1] === '(') {
      const end = substitutionEnd(command, i + 2);
      if (end < 0) {
        current += command.slice(i);
        break;
      }
      current += ' $(...) ';
      i = end + 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      flush(false);
      i += 1;
      continue;
    }
    if (char === '|') {
      // A single pipe feeds the next command; `||` is only another command.
      const isPipe = command[i + 1] !== '|';
      flush(isPipe);
      i += isPipe ? 1 : 2;
      continue;
    }
    if (char === '&') {
      // `2>&1` and `&>` are redirections, not separators.
      if (command[i - 1] === '>' || command[i + 1] === '>') {
        current += char;
        i += 1;
        continue;
      }
      flush(false);
      i += command[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
      const newline = command.indexOf('\n', i);
      if (newline < 0) break;
      i = newline;
      continue;
    }
    current += char;
    i += 1;
  }
  if (current.length > 0) {
    segments.push(current);
    piped.push(afterPipe);
  }
  // `piped[i]` says segment i reads the output of the one before it, so it filters instead of reading code.
  return Object.assign(segments, { piped });
}

/** The words of one segment, each quoted span folded into the word that carries it. */
function shellWords(segment) {
  const words = [];
  let word = '';
  let started = false;
  let quote;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (quote !== undefined) {
      if (char === '\\' && quote === '"' && segment[i + 1] !== undefined) {
        word += segment[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (char === '\\') {
      word += segment[i + 1] === undefined ? '' : segment[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/** The absolute paths one read-verb segment passes; a pattern or a script is not a path. */
function absolutePaths(program, args) {
  const words = EXPRESSION_FIRST.includes(program) ? args.slice(1) : args;
  return words.filter((word) => word.startsWith('/') && !word.startsWith('-'));
}

/**
 * The places a shell command read code: its `cd` targets and the absolute paths its search or read verbs
 * pass, plus the directory the shell stands in while they run. Undefined when no segment of the command
 * searches or reads at all — so `git -C`, `curl`, `echo` and `npm view` never count, however they name
 * another checkout.
 */
function bashTargets(command, cwd) {
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  let dir = base;
  let reads = false;
  const paths = [];
  const segments = shellSegments(command);
  for (const [index, segment] of segments.entries()) {
    const words = shellWords(segment);
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
    const program = (words[at] === undefined ? '' : words[at]).split('/').pop();
    const args = words.slice(at + 1);
    if (program === 'cd') {
      const target = args.find((word) => !word.startsWith('-'));
      if (target !== undefined) {
        dir = nodePath.resolve(dir, target);
        paths.push(dir);
      }
      continue;
    }
    // A command that follows a pipe filters the output of the one before it: if that one read code it counts itself.
    if (!READ_VERBS.includes(program) || segments.piped[index]) continue;
    reads = true;
    paths.push(...absolutePaths(program, args));
    paths.push(dir);
  }
  if (!reads) return undefined;
  return { tool: 'bash', paths: [...new Set(paths)] };
}

// ---- the call (S3) ----

/**
 * The search or read call a finished tool event made, with the absolute paths it looked at, or undefined
 * when the call is not one of the five tools (or is a `read` of a doc or a config, which the rule exempts).
 */
function searchCall(event, cwd) {
  const tool = event && event.toolName;
  const input = event && typeof event.input === 'object' && event.input !== null ? event.input : {};
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  if (tool === 'grep' || tool === 'find' || tool === 'ls') {
    const raw = typeof input.path === 'string' && input.path.length > 0 ? input.path : base;
    return { tool, paths: [nodePath.resolve(base, raw)] };
  }
  if (tool === 'read') {
    const raw = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
    if (raw.length === 0 || !isCodeFile(raw)) return undefined;
    return { tool, paths: [nodePath.dirname(nodePath.resolve(base, raw))] };
  }
  if (tool === 'bash') {
    return typeof input.command === 'string' ? bashTargets(input.command, base) : undefined;
  }
  return undefined;
}

// ---- the checkout a path belongs to (S4) ----

/**
 * The git toplevel of each directory this session asked about, read once through the async child and kept
 * for the life of the session: a directory outside every checkout is remembered as such, so a search in
 * tmp is never a second git read. A failing git is an answer too (no checkout), never an error.
 */
function createCheckoutResolver(deps = {}) {
  const toplevel = deps.toplevel || gitToplevel;
  const isDirectory = deps.isDirectory || ((path) => {
    try {
      return nodeFs.statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
  const roots = new Map(); // resolved directory -> toplevel | undefined

  async function rootOf(dir) {
    if (typeof dir !== 'string' || dir.length === 0) return undefined;
    const key = nodePath.resolve(dir);
    if (roots.has(key)) return roots.get(key);
    let top;
    try {
      top = await toplevel(key);
    } catch {
      top = undefined;
    }
    const root = typeof top === 'string' && top.length > 0 ? top : undefined;
    roots.set(key, root);
    return root;
  }

  /**
   * The checkout of a path that may be a file. One local stat decides which directory to ask git about,
   * so a call never spends more than one git read; a path that does not exist is read as a file name.
   */
  async function rootOfPath(path) {
    if (typeof path !== 'string' || path.length === 0) return undefined;
    if (isDirectory(path)) return rootOf(path);
    const resolved = nodePath.resolve(path);
    const parent = nodePath.dirname(resolved);
    return parent === resolved ? undefined : rootOf(parent);
  }

  return { rootOf, rootOfPath };
}

/**
 * The checkout a call went to: the first path that resolves to one. `other` states whether it differs
 * from the session's own checkout; with no own checkout known, every resolved checkout is another one.
 */
async function callCheckout(call, options = {}) {
  const resolve = typeof options.rootOfPath === 'function'
    ? options.rootOfPath
    : (typeof options.rootOf === 'function' ? options.rootOf : undefined);
  if (!call || !Array.isArray(call.paths) || typeof resolve !== 'function') return undefined;
  const ownRoot = typeof options.ownRoot === 'string' && options.ownRoot.length > 0 ? options.ownRoot : undefined;
  let own;
  for (const path of call.paths) {
    const root = await resolve(path);
    if (root === undefined) continue;
    if (root !== ownRoot) return { root, other: true };
    own = root;
  }
  return own === undefined ? undefined : { root: own, other: false };
}

module.exports = {
  DOC_EXTENSIONS,
  READ_VERBS,
  SEARCH_TOOLS,
  bashTargets,
  callCheckout,
  createCheckoutResolver,
  isCodeFile,
  searchCall,
  shellSegments,
  shellWords,
};

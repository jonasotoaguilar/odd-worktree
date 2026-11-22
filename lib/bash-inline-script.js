'use strict';
// The activity an INLINE script names: the program an interpreter is handed on its command
// line (`python3 -c '…'`, `node -e '…'`, `python3 - <<'PY' … PY`), read from its own text.
//
// A script is code, and code can do anything, so this reader answers only what the text
// itself proves and refuses everything else:
//   * `destructive` — the text calls a deleting function (`os.remove`, `shutil.rmtree`,
//     `fs.rmSync`, `.unlink(`). The call provably deletes whatever else it does.
//   * `preparing`   — the text writes, creates, renames or copies a file; the same
//     build-up a `cat > file` already names.
//   * `exploring`   — the text imports only modules from a short list of read-only
//     standard libraries, writes nothing and runs nothing.
//   * `undefined`   — anything else: a module outside the list (it runs code of its own),
//     a shell-out, a network call, `eval`, a dynamic import, a flag this reader does not
//     know. The card stays generic, as it always did.
//
// Pure: no filesystem, no process, no Pi. It reads a list of words and a string.

const PYTHON_PROGRAM = /^python(3(\.\d+)?)?$/;
const NODE_PROGRAM = /^nodejs?$/;

// Interpreter flags that change nothing about which code runs. A flag outside these lists
// ends the reading: `-m` runs a module, `-r`/`--import` load code first.
const PYTHON_PLAIN_FLAGS = new Set(['-I', '-B', '-u', '-E', '-S', '-s', '-O', '-OO', '-q', '-b', '-bb', '-d', '-v']);
const NODE_PLAIN_FLAGS = new Set([
  '--no-warnings', '--no-deprecation', '--experimental-strip-types', '--experimental-vm-modules',
  '--experimental-default-type=module', '--input-type=module', '--input-type=commonjs', '--enable-source-maps',
]);

// Standard-library modules that only read: parsing, text, hashing, dates and path math. A
// module outside the list may run any code on import, so a script that needs one stays
// generic.
const PYTHON_MODULES = new Set([
  'json', 'sys', 're', 'os', 'pathlib', 'tomllib', 'collections', 'itertools', 'functools', 'textwrap',
  'datetime', 'time', 'math', 'hashlib', 'base64', 'csv', 'glob', 'fnmatch', 'io', 'string', 'typing',
  'operator', 'statistics', 'difflib', 'unicodedata', 'copy', 'enum', 'dataclasses', 'argparse',
  'configparser', 'plistlib', 'struct', 'binascii', 'html', 'shlex', 'pprint', 'posixpath', 'uuid', 'yaml', 'toml', 'PIL',
]);
const NODE_MODULES = new Set([
  'fs', 'fs/promises', 'path', 'os', 'util', 'url', 'assert', 'assert/strict', 'crypto', 'readline',
  'stream', 'zlib', 'events', 'buffer', 'string_decoder', 'querystring', 'perf_hooks', 'timers',
]);

// What a script may not contain whatever it imports: running another program, evaluating
// text as code, loading code by name, talking to the network or a process, or hiding a name
// behind an alias. Read on the whole text, strings included: a script that merely MENTIONS one
// of these stays generic, which is the safe side.
const PYTHON_UNREADABLE = /\b(os\.(system|popen|exec\w*|spawn\w*|fork|forkpty|kill|killpg|putenv|startfile)|eval|exec|compile|__import__|importlib|getattr|setattr|globals|locals|breakpoint|signal|webbrowser|pty)\b|\bsubprocess\b|\bsocket\b|\bimport\s+\*|\bimport\s+(os|shutil)\s+as\b|,\s*(os|shutil)\s+as\b/;
const NODE_UNREADABLE = /\b(eval|Function|fetch|XMLHttpRequest|WebSocket|process\.(kill|binding|dlopen|chdir))\b|\.constructor\s*\(/;

// What the CODE of a script calls, read with every string literal and comment emptied, so a
// script that only prints the word is not a script that does it.
// A bare name counts only when it is called; a property access (`os.remove`, `fs.rmSync`) counts
// as written, because it may be aliased and called later.
const PYTHON_DELETES = /\bos\.(remove|unlink|rmdir|removedirs)\b|\bshutil\.rmtree\b|\b(rmtree|unlink|removedirs)\s*\(|\.(unlink|rmdir)\s*\(/;
const NODE_DELETES = /\.(rmSync|rmdirSync|unlinkSync)\b|\b(rmSync|rmdirSync|unlinkSync|rimraf)\s*\(|\.(rm|rmdir|unlink)\s*\(/;

const PYTHON_WRITES = /\.(write|writelines|write_text|write_bytes|touch|mkdir|rename|chmod|chown|symlink_to|hardlink_to|save|to_csv|to_json)\s*\(|\b(makedirs|os\.(rename|replace|mkdir|chmod|chown|symlink|link|truncate|utime)|shutil\.\w+)\b|\b(json|pickle|yaml|toml|plistlib)\.dump\s*\(/;
const NODE_WRITES = /\b(writeFile\w*|appendFile\w*|createWriteStream|mkdir\w*|copyFile\w*|cp\w*|rename\w*|chmod\w*|chown\w*|symlink\w*|link\w*|truncate\w*|utimes\w*|writeSync|write\w*)\s*\(|\.write\s*\(|\bWriteStream\b/;

// Names a script may take out of the filesystem module by destructuring: reads only.
const NODE_FS_READ_NAMES = new Set([
  'readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync', 'stat', 'lstatSync', 'lstat',
  'readlinkSync', 'realpathSync', 'access', 'accessSync', 'promises',
]);
const PYTHON_OS_READ_NAMES = new Set(['path', 'environ', 'getcwd', 'listdir', 'walk', 'scandir', 'stat', 'sep', 'linesep', 'name']);

// A print is not a write: the two standard streams are what a read-only script talks to.
const PRINTING = /\bsys\.(stdout|stderr)\.write\s*\(|\bprocess\.(stdout|stderr)\.write\s*\(/g;

/**
 * The text with the content of every string literal and comment emptied. An f-string and a
 * template literal keep theirs: what sits inside their braces is code.
 */
function codeOf(language, text, keepModes = false) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (language === 'python' && char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (language === 'node' && char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (language === 'node' && char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const triple = language === 'python' && text.startsWith(char.repeat(3), index);
      const quote = triple ? char.repeat(3) : char;
      let end = index + quote.length;
      while (end < text.length && !text.startsWith(quote, end)) end += text[end] === '\\' ? 2 : 1;
      const body = text.slice(index + quote.length, end);
      // A short mode-shaped string (`'w'`, `'r+'`) is kept on request: it is what `open` reads.
      const keep = char === '`' || (language === 'python' && /(^|[^a-z0-9_])(rf|fr|f)$/i.test(out.slice(-3))) || (keepModes && /^[rwxabt+U]{1,4}$/.test(body));
      out += quote + (keep ? body : '') + quote;
      index = end + quote.length;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The index of the parenthesis that closes the call whose opening one is at `open`. */
function callEnd(text, open) {
  let depth = 0;
  let quote;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')' && (depth -= 1) === 0) return index;
  }
  return text.length;
}

/** The top-level, comma-separated arguments of the call whose opening parenthesis is at `open`. */
function callArguments(text, open) {
  const end = callEnd(text, open);
  const args = [];
  let depth = 0;
  let quote;
  let current = '';
  for (let index = open + 1; index < end; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      current += char;
      if (char === '\\') {
        current += text[index + 1] === undefined ? '' : text[index + 1];
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

/** A string literal's text, or undefined when the argument is anything else. */
function literal(arg) {
  const found = /^[a-zA-Z]{0,2}(['"])([\s\S]*)\1$/.exec(arg === undefined ? '' : arg);
  return found === null ? undefined : found[2];
}

/**
 * Whether the text opens a file for writing: a mode that creates, truncates, appends or
 * updates, or a mode this reader cannot see. Nested calls in the path (`open(Path('a'), 'w')`)
 * and `mode=` are read as arguments, not as a pattern.
 */
function pythonOpensForWrite(text) {
  for (const found of text.matchAll(/(\.?)\bopen\s*\(/g)) {
    const args = callArguments(text, found.index + found[0].length - 1);
    if (found[1] === '.') {
      // A method such as `Path.open('w')` or `Path.open(mode='w')`: a mode-shaped first
      // argument, or `mode=`, is the mode.
      const keyword = args.find((arg) => /^mode\s*=/.test(arg));
      const mode = literal(keyword === undefined ? args[0] : keyword.replace(/^mode\s*=\s*/, ''));
      if (mode !== undefined && /^[rwxabt+U]+$/.test(mode) && /[wax+]/.test(mode)) return true;
      continue;
    }
    const keyword = args.find((arg) => /^mode\s*=/.test(arg));
    const modeArg = keyword === undefined ? args[1] : keyword.replace(/^mode\s*=\s*/, '');
    if (modeArg === undefined) continue;
    const mode = literal(modeArg);
    if (mode === undefined || /[wax+]/.test(mode)) return true;
  }
  return false;
}

/** The same for `fs.openSync(path, flags)`: a flag that writes, or one this reader cannot see. */
function nodeOpensForWrite(text) {
  for (const found of text.matchAll(/\bopen(?:Sync)?\s*\(/g)) {
    const flags = callArguments(text, found.index + found[0].length - 1)[1];
    if (flags === undefined) continue;
    const mode = literal(flags);
    if (mode === undefined || /[wa+]/.test(mode)) return true;
  }
  return false;
}

/**
 * The family the script text proves, or `undefined`.
 * @param {'python'|'node'} language
 * @param {string} source
 */
function readScript(language, source) {
  if (typeof source !== 'string' || source.trim() === '') return undefined;
  const text = source.replace(PRINTING, '');
  if (language === 'python') return readPython(text);
  if (language === 'node') return readNode(text);
  return undefined;
}

function pythonImportsAreReadable(text) {
  const pairs = [...text.matchAll(/(?:^|;)[ \t]*(?:import[ \t]+([^\n#;]+)|from[ \t]+(\S+)[ \t]+import[ \t]+([^\n#;]+))/gm)];
  for (const found of pairs) {
    const names = found[2] === undefined ? found[1].split(',').map((part) => part.trim().split(/\s+/)[0]) : [found[2]];
    for (const name of names) {
      const root = name === undefined ? '' : name.split('.')[0];
      if (root === '' || !PYTHON_MODULES.has(root)) return false;
    }
    // Names pulled out of `os` may be the deleting ones, so only the reading ones pass.
    if (found[2] === 'os') {
      for (const name of found[3].split(',').map((part) => part.trim().split(/\s+/)[0])) {
        if (!PYTHON_OS_READ_NAMES.has(name)) return false;
      }
    }
  }
  return true;
}

function readPython(text) {
  const code = codeOf('python', text);
  // A deletion the code calls is proven whatever else the script does or imports.
  if (PYTHON_DELETES.test(code)) return 'destructive';
  if (PYTHON_UNREADABLE.test(text)) return undefined;
  if (!pythonImportsAreReadable(text)) return undefined;
  if (PYTHON_WRITES.test(code) || pythonOpensForWrite(codeOf('python', text, true))) return 'preparing';
  return 'exploring';
}

function readNode(text) {
  const code = codeOf('node', text);
  if (NODE_DELETES.test(code)) return 'destructive';
  if (NODE_UNREADABLE.test(text)) return undefined;
  // Every module the script loads, by `require`, a static `import` or a dynamic one: a
  // builtin from the list, or a JSON file. Anything else — a path, a package, an
  // expression — is code this reader has not seen.
  const specifiers = [];
  for (const found of text.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]*)\1\s*\)/g)) specifiers.push(found[2]);
  for (const found of text.matchAll(/\bimport\s+(?:[\w*${},\s]+\s+from\s+)?(['"])([^'"]+)\1/g)) specifiers.push(found[2]);
  const calls = [...text.matchAll(/\b(?:require|import)\s*\(/g)].length;
  const literals = [...text.matchAll(/\b(?:require|import)\s*\(\s*(['"])[^'"]*\1\s*\)/g)].length;
  if (calls !== literals) return undefined;
  for (const specifier of specifiers) {
    const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (/\.json$/.test(name) && !name.startsWith('http')) continue;
    if (!NODE_MODULES.has(name)) return undefined;
  }
  // Names destructured out of the filesystem module may be the deleting or writing ones.
  const destructured = /(?:\{([^}]*)\}\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)|import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"])/g;
  for (const found of text.matchAll(destructured)) {
    for (const part of (found[1] === undefined ? found[2] : found[1]).split(',')) {
      const name = part.trim().split(/\s*:\s*|\s+as\s+/)[0];
      if (name !== '' && !NODE_FS_READ_NAMES.has(name)) return undefined;
    }
  }
  if (NODE_WRITES.test(code) || nodeOpensForWrite(codeOf('node', text, true))) return 'preparing';
  return 'exploring';
}

/**
 * The inline script a command's words hand an interpreter, or `undefined` when they hand it
 * anything else (a file to run, a module, a flag this reader does not know).
 * @param {string[]} words The words of ONE simple command, quotes folded.
 * @param {string|undefined} body The text of the first heredoc the segment opens, if any.
 */
function inlineScript(words, body) {
  // A node option that loads code before the script runs, wherever it stands.
  if (words.some((word) => /^(-r|--require|--import|--loader|--experimental-loader|--env-file)(=|$)/.test(word))) return undefined;
  const program = (words[0] === undefined ? '' : words[0]).split('/').pop();
  const python = PYTHON_PROGRAM.test(program);
  const node = NODE_PROGRAM.test(program) || program === 'node';
  if (!python && !node) return undefined;
  const plain = python ? PYTHON_PLAIN_FLAGS : NODE_PLAIN_FLAGS;
  const payload = python ? new Set(['-c']) : new Set(['-e', '--eval', '-p', '--print']);
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] === undefined ? '' : words[index];
    if (payload.has(word)) {
      const script = words[index + 1];
      return script === undefined ? undefined : { language: python ? 'python' : 'node', source: script };
    }
    if (word === '-') return body === undefined ? undefined : { language: python ? 'python' : 'node', source: body };
    if (plain.has(word)) continue;
    if (python && /^-[IBuESsOqbd]+$/.test(word)) continue;
    // Anything else is a script path, a module, or a flag this reader cannot vouch for.
    return undefined;
  }
  // No script argument: the interpreter reads its program from the heredoc on stdin.
  return body === undefined ? undefined : { language: python ? 'python' : 'node', source: body };
}

/**
 * The family an inline script names, or `undefined`.
 * @param {string[]} words
 * @param {string|undefined} body
 */
function inlineScriptActivity(words, body) {
  try {
    const script = inlineScript(words, body);
    return script === undefined ? undefined : readScript(script.language, script.source);
  } catch {
    return undefined;
  }
}

module.exports = { inlineScriptActivity, readScript };

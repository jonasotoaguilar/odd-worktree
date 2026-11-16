'use strict';
// S2 / S3 / S4 (T3): the DESTRUCTIVE evidence behind the eighth bash card identity —
// what a call deletes, so the card can head with `⚠ destructive` before the output
// arrives.
//
// Ported from the user's own gentle-shell branch (`cards-bash-v2`,
// `lib/destructive-card-activity.ts` and the pure `recognizeDestructiveCommands` of
// `lib/destructive-command-guard.ts`, read read-only) and TRIMMED to the family it
// serves.
//
// This is PRESENTATION evidence only. It decides the mark and the word a bash card
// heads with, and NO permission, guard or execution decision in this package may ever
// read it: "would a reader want to see what this deletes?" is a different question
// from "may this run?", and that question is answered elsewhere, by other code, on
// another path. Nothing here returns a verdict, refuses a command or gates a spawn.
//
// The rule it implements is the one a database client forces on any reader: a client
// is fed its statements through a pipe or a heredoc, so the WHOLE command — not one
// segment — has to be read to prove what it deletes. Everything this reader cannot
// prove answers "not proven", never "probably safe": an unknown wrapper, a client
// reading a script it never shows, a payload that expands at run time, a program this
// vocabulary does not name. A "false" here is an absence of evidence, which is what
// lets the call keep whatever other identity it has, or the generic `$ bash` card.
//
// The vocabulary is deliberately small and positional: only a command-position word
// can name a program, so prose a program merely receives — `echo 'rm -rf /'`,
// `git commit -m "rm -rf /tmp"`, a quoted payload — is never read as a deletion.
//
// Plain CommonJS and Node builtins only: this package ships no dependency.

// The three kinds the recognizer below can prove. Only the database kind is evidence
// a segment cannot state on its own, so it is the kind the whole-command reader keeps;
// the other two are proven by the segment the shell already spells out, and naming
// them here is what keeps the recognizer's own reading readable.
const DESTRUCTION_KIND = { DATABASE: 'database', FILESYSTEM: 'filesystem', GIT: 'git' };

// ---- the whole-command evidence ----

/**
 * Whether a whole command carries data-loss evidence its segments cannot show on
 * their own: the SQL a pipe or a heredoc feeds a client (`echo 'DROP TABLE t' |
 * psql`). Only the database verdict is read here — a filesystem or git deletion is
 * already visible in the segment that performs it, so this reader answers the one
 * question a segment cannot.
 */
function isDestructiveCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return recognizeDestructiveCommands(command).some((match) => match.kind === DESTRUCTION_KIND.DATABASE);
}

/**
 * Whether one segment runs a database client, whose statements arrive through a pipe
 * or a heredoc rather than in the segment's own text. The classifier reads it to know
 * which segments a proven deletion already names, so the client and the payload it
 * reads do not leave the call unnamed beside evidence that was proven elsewhere.
 */
function isSqlClientSegment(segment) {
  const command = commandArguments(segment);
  if (command === undefined) return false;
  return SQL_CLIENT_PROGRAMS.has(executable(command[0]));
}

// ---- the segment evidence ----

/**
 * Whether one simple shell segment deletes something irreversible, as far as a reader
 * of the command can tell. A help request, a dry run and a recovery are exempt: they
 * change nothing, so the card keeps the identity the call really has (a query, a
 * remote verb, an unnameable action) instead of warning about a deletion that will
 * not happen.
 */
function isDestructiveSegment(segment) {
  const command = commandArguments(segment);
  if (command === undefined) return false;
  const head = command[0];
  const args = command.slice(1);
  const program = executable(head);
  // A usage page prints and stops. The shell removed any quoting, so a word that
  // reaches the program as `--help` is one, whichever way it was written.
  if (args.includes('--help')) return false;
  // `--dry-run` reports what a command would do; it never does it.
  if (args.some((arg) => arg === '--dry-run' || arg.startsWith('--dry-run='))) return false;
  // The short spelling is not universal: git's own `-n` is the dry run its deleting
  // verbs accept, but another program spells an ordinary option that way —
  // `kubectl delete pod web -n prod` names the namespace and deletes the pod — so the
  // one-letter flag is read only where git itself assigns it that meaning.
  if (program === 'git' && args.some((arg) => /^-[^-]*n/.test(arg))) return false;
  if (program === 'git') return gitDeletes(args);
  if (program === 'docker' || program === 'kubectl') return containerDeletes(program, args);
  if (PAYLOAD_PROGRAMS.has(program)) return recognizeDestructiveCommands(segment).length > 0;
  return DELETING_PROGRAMS.has(program) && programDeletes(program, args);
}

/** Options that take the word after them, so a wrapper's value is not read as its command. */
const WRAPPER_VALUE_OPTIONS = {
  env: ['-u', '--unset', '-C', '--chdir'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '--user', '--group', '--host', '--prompt', '--chdir'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  // `nice -n 5 rm …` only changes the priority of the command it runs.
  nice: ['-n', '--adjustment'],
};

/** Programs that run the command after them, unchanged in what it deletes. */
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'exec', 'nohup', 'timeout', 'nice']);

/** Programs whose own arguments name what they delete. */
const DELETING_PROGRAMS = new Set(['rm', 'shred', 'truncate', 'dd']);

/** Programs that run the SQL a pipe or a heredoc hands them. */
const SQL_CLIENT_PROGRAMS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3']);

/**
 * Programs whose payload the recognizer below already reads: a shell body, an `eval`,
 * a SQL client's statements, and `find`'s exec. Their reading is reused rather than
 * re-implemented, so there is one definition of what those payloads delete and no
 * second shell or SQL vocabulary to drift.
 */
const PAYLOAD_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'eval', ...SQL_CLIENT_PROGRAMS, 'find']);

/** Git global options that consume the word after them. */
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z_0-9]*=/;

/** What one non-git, non-payload tool's own arguments say it deletes. */
function programDeletes(program, args) {
  // `dd` only destroys when it writes to a file or a device; a sink is not a target.
  if (program === 'dd') return args.some((arg) => arg.startsWith('of=') && !/^of=\/dev\/(null|stdout|stderr|zero)$/.test(arg));
  // `rm`, `shred` and `truncate` need something to act on: without an operand the
  // program prints its usage and exits.
  return hasOperand(args);
}

/**
 * Containers and clusters: a verb that removes, deletes or prunes what it names.
 * `docker rm` without a target prints usage, while `prune` deletes by definition.
 */
function containerDeletes(program, args) {
  if (program === 'kubectl') return args[0] === 'delete' && hasOperand(args.slice(1));
  const subcommand = args[0];
  if (subcommand === 'rm' || subcommand === 'rmi') return hasOperand(args.slice(1));
  // `docker system|builder|image|volume|container|network <rm|prune>`.
  if (subcommand === undefined || !DOCKER_OBJECTS.has(subcommand)) return false;
  const action = args[1];
  if (action === 'prune') return true;
  return (action === 'rm' || action === 'rmi') && hasOperand(args.slice(2));
}

/** The docker object groups whose `rm`/`prune` sub-subcommand deletes. */
const DOCKER_OBJECTS = new Set(['system', 'builder', 'image', 'volume', 'container', 'network']);

/** Whether the arguments name at least one operand, honouring the `--` terminator. */
function hasOperand(args) {
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.length > 1 && arg.startsWith('-')) continue;
    return true;
  }
  return false;
}

/** The git verbs that discard work, and the flags that make a gentler verb do it. */
function gitDeletes(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index];
    index += 1;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(flag)) index += 1;
  }
  const action = args[index];
  const flags = args.slice(index + 1);
  const force = flags.some((flag) => /^-[^-]*f/.test(flag) || /^--force(=|$)/.test(flag));
  const dryRun = flags.some((flag) => /^-[^-]*n/.test(flag));
  switch (action) {
    // `--soft` and `--mixed` move the index only; `--hard` throws the worktree away.
    case 'reset':
      return flags.includes('--hard');
    // A clean without a force flag refuses to delete anything, and `-n` only lists.
    case 'clean':
      return force && !dryRun;
    // A path checkout discards uncommitted work: the working tree after `--`, a forced
    // checkout, or the unambiguous path `.`/`..` (git has no branch with that name). A
    // branch checkout — `git checkout main`, `git checkout -b x` — switches branch and
    // leaves the working tree alone.
    case 'checkout':
      return force || namesWorkingTree(flags);
    // Unstaging alone changes no file, so only a worktree restore deletes work.
    case 'restore':
      return !onlyStaged(flags);
    // `--cached` drops the entry from the index and keeps the file.
    case 'rm':
      return !flags.includes('--cached') && hasOperand(flags);
    case 'branch':
      return flags.some((flag) => /^-[^-]*D/.test(flag)) || (force && flags.some((flag) => flag === '--delete' || /^-[^-]*d/.test(flag)));
    case 'push':
      // A forced or ref-deleting push removes history on the remote.
      return force
        || flags.some((flag) => /^--force(-with-lease|-if-includes)?(=|$)/.test(flag))
        || flags.some((flag) => flag === '--delete' || /^-[^-]*d/.test(flag))
        // `git push origin :feat/x` names the deletion with its refspec.
        || flags.some((flag) => /^:[^:]/.test(flag));
    case 'stash':
      return flags[0] === 'drop' || flags[0] === 'clear';
    case 'worktree':
      // A checkout the call removes takes whatever was uncommitted inside it, and
      // `prune` drops the records of checkouts that are already gone. `add`, `move`,
      // `lock`, `unlock`, `repair` and `list` delete neither.
      return flags[0] === 'remove' || flags[0] === 'prune';
    default:
      return false;
  }
}

/** Whether the arguments name working-tree paths, either after `--` or as `.`/`..`. */
function namesWorkingTree(flags) {
  const separator = flags.indexOf('--');
  if (separator >= 0) return flags.length > separator + 1;
  return flags.some((flag) => WORKING_TREE_PATHS.has(flag));
}

/** Paths git can read as nothing but a working-tree path, never as a branch. */
const WORKING_TREE_PATHS = new Set(['.', './', '..', '../']);

/** `git restore --staged` leaves every file as it is; anything touching the worktree does not. */
function onlyStaged(flags) {
  const staged = flags.some((flag) => flag === '--staged' || /^-[^-]*S/.test(flag));
  const worktree = flags.some((flag) => flag === '--worktree' || /^-[^-]*W/.test(flag));
  return staged && !worktree;
}

/**
 * The words the program after the wrappers receives. Assignments — before the command
 * or in the environment a wrapper sets — a familiar wrapper and the duration `timeout`
 * bounds change nothing about what the command deletes, so they are skipped; a segment
 * with no command left has none.
 */
function commandArguments(segment) {
  // The classifier runs synchronously on every bash row the host repaints, so a value
  // that is not a command line at all — no command text, a number, an object — answers
  // "no evidence" instead of throwing on the row it was asked to draw.
  if (typeof segment !== 'string' || segment.length === 0) return undefined;
  const words = shellWords(segment);
  let cursor = skipAssignments(words, 0);
  while (cursor < words.length) {
    const name = executable(words[cursor]);
    if (!WRAPPERS.has(name)) break;
    cursor = skipAssignments(words, cursor + 1);
    while (cursor < words.length && words[cursor].startsWith('-')) {
      const flag = words[cursor];
      cursor += 1;
      if (flag === '--') break;
      // The table is a plain object, so a program literally named `constructor` or
      // `__proto__` must never resolve to an inherited member: only a name this
      // module declared can consume its next word.
      if (Object.hasOwn(WRAPPER_VALUE_OPTIONS, name) && WRAPPER_VALUE_OPTIONS[name].includes(flag)) cursor += 1;
    }
    // `env FOO=bar rm …` carries its environment after the wrapper's flags.
    cursor = skipAssignments(words, cursor);
    // `timeout 30 rm …` names the duration it bounds before the command.
    if (name === 'timeout') cursor += 1;
    cursor = skipAssignments(words, cursor);
  }
  return cursor < words.length ? words.slice(cursor) : undefined;
}

/** Advance past plain `NAME=value` words, which set the environment rather than a command. */
function skipAssignments(words, cursor) {
  let next = cursor;
  while (next < words.length && ASSIGNMENT.test(words[next])) next += 1;
  return next;
}

/** The last path segment of a program word: `/usr/bin/rm` is `rm`. */
function executable(value) {
  return value.split('/').pop();
}

/**
 * One segment as the words the program receives, with the quoting and escaping the
 * shell would remove. Only words matter here: a command is read from its command
 * position, never from a substring of the text.
 */
function shellWords(segment) {
  const words = [];
  let word = '';
  let started = false;
  const push = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === '\\') {
      const next = segment[index + 1];
      if (next === undefined) {
        word += char;
        started = true;
        continue;
      }
      index += 1;
      // An escaped newline is a line continuation, not a character.
      if (next !== '\n') word += next;
      started = true;
      continue;
    }
    if (char === "'") {
      // Nothing escapes inside single quotes.
      const close = segment.indexOf("'", index + 1);
      const end = close < 0 ? segment.length : close;
      word += segment.slice(index + 1, end);
      started = true;
      index = end;
      continue;
    }
    if (char === '"') {
      // Inside double quotes only `\X` escapes, and an escaped newline is dropped.
      let inner = '';
      let end = index + 1;
      while (end < segment.length && segment[end] !== '"') {
        const current = segment[end];
        if (current !== '\\') {
          inner += current;
          end += 1;
          continue;
        }
        const next = segment[end + 1];
        if (next === undefined) {
          inner += current;
          end += 1;
          continue;
        }
        end += 2;
        if (next !== '\n') inner += next;
      }
      word += inner;
      started = true;
      index = end;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    word += char;
    started = true;
  }
  push();
  return words;
}

// ---- the recognizer ----

// Recognizable executable forms only. This is deliberately not a shell/SQL interpreter
// or a sandbox: no expansion, script loading or remote inspection.

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')']);

/**
 * Programs that run the command after them, and the options that consume the word
 * after them, for the recognizer below. This is a SECOND reading of wrappers, and it
 * is deliberately wider than the segment reader's: the recognizer also looks inside a
 * `xargs`, whose own arguments name what it deletes.
 */
const RECOGNIZER_WRAPPERS = ['env', 'sudo', 'command', 'exec', 'nohup', 'timeout', 'xargs'];
const RECOGNIZER_VALUE_OPTIONS = {
  env: ['-u', '--unset', '-C', '--chdir'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '--user', '--group', '--host', '--prompt', '--chdir'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  xargs: ['-n', '-I', '-P', '--max-args', '--replace', '--max-procs'],
};
// Unquoted reserved words that open a compound body or a condition are followed by a
// command in command position.
const RESERVED_WORDS = new Set(['then', 'else', 'elif', 'do', '{', '!', 'if', 'while', 'until']);

/** Literal, named heredocs are data, not executable shell segments; offsets are preserved. */
function blankHeredocs(command) {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
    const headerLength = raw.indexOf('\n') + 1;
    return raw.slice(0, headerLength) + ' '.repeat(raw.length - headerLength);
  });
}

/** Keep quoted arguments intact so harmless prose is never treated as a command. */
function tokenize(command, blank = true) {
  const tokens = [];
  const text = blank ? blankHeredocs(command) : command;
  const pattern = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const value = raw.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
      (_raw, double, single, escaped) => {
        if (double !== undefined) return double.replace(/\\(["\\$`\n])/g, (_escape, char) => (char === '\n' ? '' : char));
        return single !== undefined ? single : (escaped !== undefined ? escaped : '');
      });
    // Only raw operators are boundaries; quoted or escaped operators are words.
    tokens.push({ value, raw, operator: SEPARATORS.has(raw), index: match.index });
  }
  return tokens;
}

/** Index of the executable token after reserved words, assignments and familiar wrappers. */
function headCursor(segment) {
  let cursor = 0;
  while (cursor < segment.length && segment[cursor].raw === segment[cursor].value && RESERVED_WORDS.has(segment[cursor].value)) cursor += 1;
  while (cursor < segment.length) {
    const value = segment[cursor].value;
    if (ASSIGNMENT.test(value)) {
      cursor += 1;
      continue;
    }
    const name = executable(value);
    if (!RECOGNIZER_WRAPPERS.includes(name)) break;
    cursor += 1;
    while (cursor < segment.length && segment[cursor].value.startsWith('-')) {
      const flag = segment[cursor].value;
      cursor += 1;
      if (flag === '--') break;
      if (Object.hasOwn(RECOGNIZER_VALUE_OPTIONS, name) && RECOGNIZER_VALUE_OPTIONS[name].includes(flag)) cursor += 1;
    }
    if (name === 'timeout') cursor += 1;
  }
  return cursor;
}

/**
 * The statements one SQL payload deletes. Quoted identifiers are masked as atoms and
 * comments and strings removed first, so a table named `where` is not a predicate and
 * a statement boundary inside a string is not a boundary. `DROP`/`TRUNCATE` always
 * destroy; a `DELETE` destroys only without a clause that picks its rows.
 */
function sqlDestroys(sql) {
  const code = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]/g,
    (raw) => (/^["`[]/.test(raw) ? 'identifier' : ' '));
  return code.split(';').some((statement) => {
    if (/^\s*(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b|TRUNCATE\s+(?:TABLE\s+)?\S)/i.test(statement)) return true;
    if (!/^\s*DELETE\s+FROM\s+\S/i.test(statement)) return false;
    return !/\bWHERE\b/i.test(statement) || /\bWHERE\s+(?:1\s*=\s*1|TRUE)\s*$/i.test(statement.trim());
  });
}

/**
 * Bodies of backtick command substitutions outside single quotes, with the backslash
 * escapes that backticks remove. An unterminated substitution is a shell syntax error
 * and runs nothing, so it yields no body; heredoc bodies stay data, as elsewhere.
 */
function backtickBodies(command) {
  const bodies = [];
  const text = blankHeredocs(command);
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === '\\') {
      index += 1;
    } else if (char === "'" && quote === undefined) {
      quote = "'";
    } else if (char === '"') {
      quote = quote === '"' ? undefined : '"';
    } else if (char === '`') {
      let end = index + 1;
      while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) break;
      bodies.push({ body: text.slice(index + 1, end).replace(/\\([\\$`])/g, '$1') });
      index = end;
    }
  }
  return bodies;
}

/**
 * The deletions one command proves, segment by segment: a shell body, an `eval`, a SQL
 * client's statements, `find`'s own `-delete` and `-exec`, a recursive `rm`, and the
 * git verbs that discard work. Each match carries its KIND, so a reader can keep the
 * one reading a segment cannot make (the database payload) without reading anything
 * about whether the command may run.
 */
function recognizeDestructiveCommands(command, depth = 0) {
  if (depth > 4) return [];
  const tokens = tokenize(command);
  const matches = [];
  let previous = [];
  let previousSeparator = '';
  let start = 0;
  for (let end = 0; end <= tokens.length; end += 1) {
    if (end < tokens.length && !tokens[end].operator) continue;
    const segment = tokens.slice(start, end);
    start = end + 1;
    // Assignments and familiar executable wrappers preserve command position.
    const cursor = headCursor(segment);
    const head = segment[cursor];
    const name = head === undefined ? '' : executable(head.value);
    const args = segment.slice(cursor + 1).map((token) => token.value);
    const add = (kind) => matches.push({ kind });
    if (['sh', 'bash', 'zsh', 'dash'].includes(name)) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag >= 0 && args[flag + 1]) matches.push(...recognizeDestructiveCommands(args[flag + 1], depth + 1));
    }
    // `eval` runs its arguments joined by spaces, like a literal `sh -c` payload.
    if (name === 'eval') {
      const payload = (args[0] === '--' ? args.slice(1) : args).join(' ');
      matches.push(...recognizeDestructiveCommands(payload, depth + 1));
    }
    if (SQL_CLIENT_PROGRAMS.has(name)) {
      const payloads = args.map((arg) => arg.replace(/^(?:--command|--execute)=/, ''));
      const heredoc = command.slice(head.index).match(/^[^\n]*<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/);
      if (heredoc) payloads.push(heredoc[3]);
      if (previousSeparator === '|' && ['echo', 'printf'].includes(executable(previous[0] === undefined ? '' : previous[0].value))) {
        payloads.push(previous.slice(1).map((token) => token.value).join(' ').replace(/^%s\s*/, ''));
      }
      if (payloads.some(sqlDestroys)) add(DESTRUCTION_KIND.DATABASE);
    }
    if (name === 'rm' && args.some((arg) => /^-[^-]*[rR]/.test(arg) || arg === '--recursive')) add(DESTRUCTION_KIND.FILESYSTEM);
    if (name === 'find') {
      if (args.includes('-delete')) add(DESTRUCTION_KIND.FILESYSTEM);
      for (let execIndex = 0; execIndex < args.length; execIndex += 1) {
        if (!['-exec', '-execdir'].includes(args[execIndex])) continue;
        const invocation = segment.slice(cursor + execIndex + 2);
        const terminator = invocation.findIndex((arg) => arg.value === ';' || arg.value === '+');
        const nested = (terminator < 0 ? invocation : invocation.slice(0, terminator)).map((arg) => arg.raw).join(' ');
        matches.push(...recognizeDestructiveCommands(nested, depth + 1));
        if (terminator < 0) break;
        execIndex += terminator + 1;
      }
    }
    if (name === 'git') {
      let index = 0;
      while (index < args.length && args[index].startsWith('-')) {
        const flag = args[index];
        index += 1;
        if (GIT_GLOBAL_VALUE_OPTIONS.has(flag)) index += 1;
      }
      const action = args[index];
      const flags = args.slice(index + 1);
      const force = flags.some((arg) => /^--force(?:-with-lease|=|$)/.test(arg) || /^-[^-]*f/.test(arg));
      const hard = (action === 'reset' && flags.includes('--hard')) || (action === 'clean' && force) || (action === 'push' && force);
      const branchDelete = action === 'branch' && (flags.some((arg) => /^-[^-]*D/.test(arg)) || (force && flags.some((arg) => arg === '--delete' || /^-[^-]*d/.test(arg))));
      if (hard || branchDelete || ['reset', 'clean', 'restore', 'rebase'].includes(action)
        || (action === 'checkout' && (force || flags.includes('--')))
        || (action === 'stash' && ['drop', 'clear'].includes(flags[0]))) add(DESTRUCTION_KIND.GIT);
    }
    previous = segment;
    previousSeparator = tokens[end] === undefined ? '' : tokens[end].value;
  }
  // Backtick substitutions run like `$(...)`, also inside double quotes.
  for (const { body } of backtickBodies(command)) matches.push(...recognizeDestructiveCommands(body, depth + 1));
  return matches;
}

module.exports = {
  isDestructiveCommand,
  isDestructiveSegment,
  isSqlClientSegment,
};

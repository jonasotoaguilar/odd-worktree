'use strict';
// S10: what a CodeGraph card says, decided from the call and the output alone.
//
// Ported from the user's own `lib/codegraph-card-preview.ts` of PR #74
// (`jonasotoaguilar/gentle-shell`, branch `cards-bash-v2`, copied read-only under
// `odd/reference/pr74-card/`): the identity (the tool name, its mark and the theme
// role its title wears), the heading detail, the count `query` and `explore`
// state in their own output, the init sentence, the bounded preview and the
// `bash` command recognition.
//
// One shape is this package's addition (S10): `codegraph sync` is a different
// program run from the same binary, and its own output says what it did
// (`Synced N changed files`, `No files changed`, `Already up to date`). Its card
// states that sentence, so an init is never read as a sync or the other way
// round, and neither is invented when the output does not carry it.
//
// The rules the whole module obeys:
//   * the card states only what CodeGraph printed. No row adds a status, a count
//     or an outcome the output lacks; an unreadable shape keeps its own rows.
//   * no specialized fallback: when nothing specific is readable the last rows it
//     printed are the preview, whatever the operation was.
//   * a failure always keeps the reason it printed, at any level.
//   * pure: no Pi, no theme, no colour, no filesystem, no process and no clock.
//     The rows are PLAIN strings here; lib/codegraph-card.js paints them.
//
// The command recognition is the reference classifier's own plumbing — its
// quote-aware segmenter, its segment stripping and no-op table, its shell word
// reader and its read-only inspection table — kept whole so the card can never
// claim a composition the reference would not (it only ever declines one). It is
// self-contained: gentle-shell's `lib/odd-phase-inference.ts` is not a dependency
// of this package.

/** The program both surfaces draw, and the mark and theme role its card wears. */
const CODEGRAPH_TOOL = 'codegraph';
const CODEGRAPH_MCP_TOOL = 'codegraph_explore';
// The database glyph, and the theme's own `mdCode` slot: both are the shell's
// semantic vocabulary, never a fixed palette, so a light theme, a neon theme or a
// design pack repaints them along with everything else.
const CODEGRAPH_MARK = '\u{F01BC}';
const CODEGRAPH_TITLE_ROLE = 'mdCode';

// The collapsed preview budget, in rows the program printed.
const PREVIEW_ROWS = 3;
// The init CLI paints a progress box; its separator rows carry no facts.
const CHROME = /^[\s│┌└─]*$/;
// A status row's mark is decoration; the row's own words are the fact.
const STATUS_MARK = /^[◆◇●▲✗✓ℹ]\s+/;
// The init log trails into telemetry and upgrade notices after its summary, so the
// collapsed rows name the index it built rather than the last lines it wrote.
const INIT_FACT = /\b(Indexed \d+ files?|\d+ nodes?, \d+ edges?|Initialized in)\b/;
// This build's init ends with one sentence about the workspace index: it built a new
// one, or found the one already there. Only those sentences state that fact.
const INIT_OUTCOMES = [
  [/^Initialized in .+$/, 'initialized'],
  [/^Already initialized in .+$/, 'already initialized'],
];
// This build's sync ends with one of these sentences, and each states its own
// outcome. A row is read only when it matches one of them, so an init log or an
// unreadable sync log keeps the rows it printed instead of borrowing one.
const SYNC_OUTCOMES = [/^Synced [\d,]+ changed files?$/, /^No files changed$/, /^Already up to date$/];
// The last lines of an output, and the blank line the terminal sequence leaves.
const TRAILING_BLANK = /(?:\n[ \t]*)+$/;

/** The CodeGraph call a card heads: the operation it ran, and the query it named. */
// {
//   operation: string,
//   query?: string,
// }

function outputLines(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalized.length > 0 ? normalized.split('\n') : [];
}

/** A row's fact: the row's own words, without the status mark the CLI decorates it with. */
function factRow(line) {
  return line.trim().replace(STATUS_MARK, '');
}

/** The lower-case first letter of a sentence the program printed, so the card's row reads as a statement. */
function sentence(row) {
  return row.length === 0 ? row : `${row[0].toLowerCase()}${row.slice(1)}`;
}

// ---- what a call is ----

// Stream merges and discarded output; neither writes a file.
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;
// Shell keywords that prefix the command they introduce (`do grep x`).
const LEADING_KEYWORDS = /^(do|then|else|elif|if|while|until|time|!|\{|\()\s+/;
// The splitter follows `$(...)` but not backticks or `<(...)`, so a command hidden
// in one of those never reaches this reader; `>(...)` is already a file write.
const HIDDEN_SUBSTITUTION = /`|<\(/;

// Segments that neither inspect nor change anything worth naming: shell control
// words, no-op builtins, and bare variable assignments (their command
// substitutions are classified as commands of their own).
const NEUTRAL_COMMANDS = [
  /^(cd|pushd|popd|echo|printf|sleep|true|false|export|set)\b/,
  /^(done|fi|esac|\}|\))$/,
  /^for\s+\w+(\s+in\b.*)?$/,
  // Each assignment must end at whitespace or the end: an optional separator would
  // let `a=a=a=…` split anywhere and backtrack exponentially.
  /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*(\s+|$))+$/,
];

// Git listing flags that may take one non-flag argument (`--contains <rev>`)
// without turning `git branch`/`git tag` into a create.
const GIT_LIST_FLAG = String.raw`(\s+(-a|-r|-l|-v|-vv|-n\d*|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--points-at|--sort=\S+)(\s+[^-\s]\S*)?)*$`;

// Read-only inspection. Matched per shell segment.
const EXPLORING_COMMANDS = [
  /^git\s+(status|log|diff|show|blame|rev-parse|rev-list|merge-base|ls-files|ls-remote|ls-tree|cat-file|describe|shortlog|reflog|grep|check-ignore|for-each-ref|name-rev|count-objects)\b/,
  new RegExp(String.raw`^git\s+(branch|tag)${GIT_LIST_FLAG}`),
  /^git\s+remote(\s+(-v|--verbose|show|get-url)\b.*)?$/,
  /^git\s+(worktree|stash)\s+list\b/,
  /^git\s+config\s+(--get|--get-all|--get-regexp|-l|--list)\b/,
  // `git config <key>` without a value reports what is stored.
  /^git\s+config\s+[^-\s]+\s*$/,
  /^gh\s+(pr|issue|repo|release)\s+(view|list|diff|status)\b/,
  /^gh\s+(auth\s+status|search\s+\w+|label\s+list|workflow\s+(list|view))\b/,
  // Viewing a stack reads the local stack and its PRs.
  /^gh\s+stack\s+view\b/,
  // Metadata probes: what is installed, configured, or resolved here.
  /^locale\b/,
  /^cargo\s+tree\b/,
  /^go\s+version\b/,
  /^(ls|cat|head|tail|grep|egrep|rg|wc|pwd|tree|stat|file|which|type|readlink|realpath|dirname|basename|cut|uniq|tr|nl|column|strings|diff|cmp|od|xxd|hexdump|shasum|sha256sum|md5|md5sum|du|df|date|uname|whoami|ps|pgrep|lsof|jq|awk)\b/,
  /^command\s+-v\b/,
  /^(\[\[?|test)\s/,
  /^sort\b(?!.*\s(-o|--output)\b)/,
  /^sed\b(?!.*\s(-[a-zA-Z]*i|--in-place)\b)/,
  /^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*)\b)/,
];

// `gh api` without a method, field, or input body reads; with one it writes.
const GH_API_WRITE_FLAGS = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '--input']);

// `--help` prints a program's usage and stops, so it is a query on any command
// family. Only a program this reader already names is asked: an unknown program's
// flag is a guess.
const HELP_AWARE_COMMANDS = new Set([
  'git', 'gh',
  'node', 'npx', 'pnpx', 'bunx', 'pnpm', 'npm', 'yarn', 'bun', 'deno',
  'go', 'cargo', 'ruff', 'python', 'python3', 'pytest', 'vitest', 'jest',
  'mocha', 'tsc', 'eslint', 'make',
  'rm', 'find', 'shred', 'truncate', 'dd',
  'prettier', 'biome', 'dprint', 'stylelint', 'oxlint', 'standard', 'markdownlint',
  'black', 'rustfmt', 'swiftformat', 'clang-format', 'gofmt', 'gofumpt', 'shfmt',
  'mix', 'dart', 'terraform', 'uv', 'poetry', 'pip', 'pip3',
  'docker', 'kubectl',
]);
// Programs that run the code they are handed. Only for these does a payload flag
// make the rest of the segment unreadable.
const SCRIPT_RUNNERS = new Set(['node', 'deno', 'bun', 'python', 'python3']);
const PAYLOAD_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/**
 * Splits a segment into the words the program receives, dropping the quoting
 * characters the shell would drop. A quoted `--help` is text handed to the
 * program, and a quoted `-m` is still an option, so both the text and whether the
 * word was quoted are kept.
 */
function shellWordTokens(segment) {
  const words = [];
  let text = '';
  let quoted = false;
  let started = false;
  const push = () => {
    if (started) words.push({ text, quoted });
    text = '';
    quoted = false;
    started = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === '\\') {
      // `\X` is the literal X and `\<newline>` is a line continuation, so an
      // escaped space never ends a word: `foo\ --help` is one argument.
      const next = segment[i + 1];
      if (next === undefined) {
        text += char;
        started = true;
        continue;
      }
      i += 1;
      if (next !== '\n') text += next;
      started = true;
      continue;
    }
    if (char === "'") {
      // Nothing is escaped inside single quotes.
      const end = segment.indexOf("'", i + 1);
      text += segment.slice(i + 1, end < 0 ? segment.length : end);
      quoted = true;
      started = true;
      i = end < 0 ? segment.length : end;
      continue;
    }
    if (char === '"') {
      // A double-quoted span is one word whatever spaces it holds, and only `\X`
      // and a continuation escape; the quotes the shell would drop are dropped, so
      // a `--help` inside it stays text.
      let inner = '';
      let end = i + 1;
      while (end < segment.length && segment[end] !== '"') {
        const innerChar = segment[end];
        if (innerChar !== '\\') {
          inner += innerChar;
          end += 1;
          continue;
        }
        const next = segment[end + 1];
        if (next === undefined) {
          inner += innerChar;
          end += 1;
          continue;
        }
        end += 2;
        if (next !== '\n') inner += next;
      }
      text += inner;
      quoted = true;
      started = true;
      i = end;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    text += char;
    started = true;
  }
  push();
  return words;
}

/** The words a simple command passes, with each quoted span folded into the word that carries it. */
function shellWords(segment) {
  return shellWordTokens(segment).map((word) => word.text);
}

/**
 * The segment's text with every quoted span blanked, except a span that is a
 * flag-shaped word of its own: `black "--check" .` passes that flag, while
 * `prettier 'a --write b.ts'` names one file whose text only looks like one.
 */
function unquotedSegment(segment) {
  return segment.replace(/"[^"]*"|'[^']*'/g, (quoted) => (/^-\S+$/.test(quoted.slice(1, -1)) ? quoted.slice(1, -1) : ' '));
}

// Output redirection to a file is a write. A `>` inside a quoted span is the
// program's own argument, never a redirect, so only the text the shell would act
// on counts.
function writesFile(segment) {
  return unquotedSegment(segment).replace(HARMLESS_REDIRECTS, '').includes('>');
}

function matchesAny(patterns, segment) {
  return patterns.some((pattern) => pattern.test(segment));
}

/** `go env` reports the Go configuration, but `-w` stores a value and `-u` unsets one: both write. */
function isGoEnvRead(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'go' || words[1] !== 'env') return false;
  return !words.slice(2).some((word) => /^-[wu]$/.test(word));
}

function isGhApiRead(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'gh' || words[1] !== 'api') return false;
  return !words.slice(2).some((word) => GH_API_WRITE_FLAGS.has(word.split('=')[0]) || /^-[XfF]./.test(word));
}

function isReadOnlyInspection(segment) {
  return !writesFile(segment)
    && !HIDDEN_SUBSTITUTION.test(segment)
    && (matchesAny(EXPLORING_COMMANDS, segment) || isGhApiRead(segment) || isGoEnvRead(segment));
}

/**
 * Whether a segment asks a known program for its own usage page: a request, a flag
 * the segment's own text merely mentions or an option consumed, or an unreadable
 * one this reader refuses to guess about.
 */
function helpFlag(segment) {
  const words = shellWordTokens(segment);
  const at = words.findIndex((word) => !word.quoted && word.text === '--help');
  if (at < 0) return 'absent';
  // An option may take the help flag as its own value: `git commit -m --help`
  // commits a message spelled `--help`, printing nothing. Which options take a
  // value cannot be known here, so a help flag directly after such a word is read
  // as that word's value.
  const previous = words[at - 1];
  if (previous !== undefined && (previous.text.startsWith('-') || previous.text.startsWith('$'))) return 'absent';
  const program = (words[0] === undefined ? '' : words[0].text).split('/').pop() || '';
  if (!HELP_AWARE_COMMANDS.has(program)) return 'unreadable';
  // `node -e '…' --help` runs the payload with `--help` as its own argument.
  if (SCRIPT_RUNNERS.has(program) && words.slice(1).some((word) => PAYLOAD_FLAGS.has(word.text))) return 'unreadable';
  if (writesFile(segment) || HIDDEN_SUBSTITUTION.test(segment)) return 'unreadable';
  return 'request';
}

/**
 * The words after a command-position `codegraph` program, or undefined when the
 * segment runs something else: only the command position names a program, so
 * `echo codegraph init` never matches, and a flag-only invocation keeps the
 * generic card.
 */
function codeGraphCommandWords(segment) {
  const words = shellWords(segment);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  if (!/^(?:\S*\/)?codegraph$/.test(words[index] === undefined ? '' : words[index])) return undefined;
  const rest = words.slice(index + 1);
  return rest.some((word) => !word.startsWith('-')) ? rest : undefined;
}

// `&` inside a redirection (`2>&1`, `&>/dev/null`) is not a separator.
function isSeparator(command, i) {
  const char = command[i];
  if (char === '&') return command[i - 1] !== '>' && command[i + 1] !== '>';
  return char === ';' || char === '|' || char === '\n';
}

// Index of the `)` closing a `$(` whose body starts at `start`, or -1.
function findSubstitutionEnd(command, start) {
  let depth = 1;
  let quote;
  for (let i = start; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') i += 1;
    } else if (char === '\\') i += 1;
    else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')' && (depth -= 1) === 0) return i;
  }
  return -1;
}

/**
 * Splits a shell command into its simple commands. Top-level `&&`, `||`, `;`, `|`,
 * `&` and newlines separate them, quoted text never does, and every `$(...)`
 * substitution contributes its own commands. Not a full shell parser: whatever it
 * cannot follow lands in a segment that matches no pattern, so the card leaves the
 * call alone.
 */
function shellCommandSegments(command) {
  const commands = [];
  let current = '';
  let quote;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
    } else if (char === '\\') {
      current += char + (command[i + 1] === undefined ? '' : command[i + 1]);
      i += 1;
    } else if (char === '$' && command[i + 1] === '(') {
      const end = findSubstitutionEnd(command, i + 2);
      if (end < 0) return [...commands, current + command.slice(i)];
      commands.push(...shellCommandSegments(command.slice(i + 2, end)));
      current += '$_';
      i = end;
    } else if (quote === '"') {
      current += char;
      if (char === '"') quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (isSeparator(command, i)) {
      commands.push(current);
      current = '';
      if ((char === '|' || char === '&') && command[i + 1] === char) i += 1;
    } else {
      current += char;
    }
  }
  commands.push(current);
  return commands;
}

// Drops harmless redirections (`2>&1`, `2>/dev/null`), leading shell keywords
// (`do grep x`), environment assignments (`CI=1 pnpm test`), git global options
// (`git -C dir status`), and whitespace.
function stripSegment(segment) {
  let stripped = segment.replace(HARMLESS_REDIRECTS, '').trim();
  while (LEADING_KEYWORDS.test(stripped)) stripped = stripped.replace(LEADING_KEYWORDS, '');
  return stripped
    .replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*\s+)+(?=\S)/, '')
    .replace(/^git\s+((-C|-c)\s+\S+\s+|--no-pager\s+)+/, 'git ');
}

// A segment that writes a file (`echo x > out`) is never a no-op.
function isNeutral(segment) {
  return !writesFile(segment) && matchesAny(NEUTRAL_COMMANDS, segment);
}

/** The command split into the simple commands this reader inspects, with the no-ops dropped. */
function shellSegments(command) {
  return shellCommandSegments(command)
    .map(stripSegment)
    .filter((segment) => segment.length > 0 && !isNeutral(segment));
}

/**
 * What one segment is for this card: CodeGraph's own program, an inspection that
 * can stand beside it, or undefined for anything else — a check, a rewrite, a
 * build-up, an unknown program. A segment this reader cannot name keeps the whole
 * call out of the card, exactly as the reference's classifier does.
 */
function codegraphSegmentActivity(segment) {
  const help = helpFlag(segment);
  if (help === 'request') return 'exploring';
  if (help === 'unreadable') return undefined;
  if (isReadOnlyInspection(segment)) return 'exploring';
  if (HIDDEN_SUBSTITUTION.test(segment) || writesFile(segment)) return undefined;
  return codeGraphCommandWords(segment) !== undefined ? 'codegraph' : undefined;
}

/** The payload after the command's own `--`; a bare word is read only when alone, since an option may take the next one. */
function queryPayload(operation, words) {
  if (operation !== 'query' && operation !== 'explore') return undefined;
  const separator = words.indexOf('--');
  const payload = separator >= 0 ? words.slice(separator + 1) : words.slice(words.indexOf(operation) + 1);
  if (separator < 0 && payload.length !== 1) return undefined;
  const query = payload.join(' ').replace(/\s+/g, ' ').trim();
  return query.length > 0 ? query : undefined;
}

/**
 * The CodeGraph call a shell command runs: its own operation and the query it
 * named, read from the words the command passes. Undefined when the command is not
 * CodeGraph, so the caller can leave that command's card exactly as it found it.
 */
function codegraphCallFromCommand(command) {
  if (typeof command !== 'string') return undefined;
  const segments = shellSegments(command);
  if (segments.length === 0) return undefined;
  let call;
  for (const segment of segments) {
    const activity = codegraphSegmentActivity(segment);
    if (activity === undefined) return undefined;
    if (activity !== 'codegraph') continue;
    const words = codeGraphCommandWords(segment);
    if (words === undefined) return undefined;
    const operation = words.find((word) => !word.startsWith('-'));
    if (operation === undefined) return undefined;
    const query = queryPayload(operation, words);
    call = { operation, ...(query === undefined ? {} : { query }) };
  }
  return call;
}

/** The heading detail: the operation, and the query when the call named one. */
function codegraphCallDetail(call) {
  return call.query === undefined ? call.operation : `${call.operation} ${call.query}`;
}

// ---- what the output says ----

/** What an init stated it did to the index, or undefined when it printed no such sentence. */
function codeGraphInitOutcome(text) {
  for (const line of outputLines(text)) {
    const row = factRow(line);
    for (const [pattern, action] of INIT_OUTCOMES) if (pattern.test(row)) return action;
  }
  return undefined;
}

/** What a sync stated it did, in its own words, or undefined when it printed no such sentence. */
function codeGraphSyncOutcome(text) {
  for (const line of outputLines(text)) {
    const row = factRow(line);
    if (SYNC_OUTCOMES.some((pattern) => pattern.test(row))) return sentence(row);
  }
  return undefined;
}

/** The count CodeGraph's own output states, or undefined for a shape the card cannot read. */
function codeGraphResultSummary(operation, text) {
  if (operation === 'query') {
    if (/^.*No results found for /m.test(text)) return '0 results';
    if (!/^Search Results for .*:$/m.test(text)) return undefined;
    // One entry per blank-line-separated block: a symbol line at column zero
    // followed by its indented path:line location.
    const entries = text.split(/\n\s*\n/).filter((block) => {
      const [head = '', ...rest] = outputLines(block);
      return /^\S+\s{2,}\S/.test(head) && rest.some((line) => /^ {2}.+:\d+(?::\d+)?\s*$/.test(line));
    });
    return entries.length === 0 ? undefined : `${entries.length} ${entries.length === 1 ? 'result' : 'results'}`;
  }
  if (operation !== 'explore') return undefined;
  // The MCP explore tool states the same count in one header sentence. Its sentence
  // may carry a further clause on the same line (`2 files pinned from the query.`),
  // which states more, not something else, so the count is read from the sentence's
  // own beginning.
  const found = /^Found (\d+) symbols? across (\d+) files?\./m.exec(text);
  if (!found) return undefined;
  const symbols = Number(found[1]);
  const files = Number(found[2]);
  return `${symbols} ${symbols === 1 ? 'symbol' : 'symbols'} in ${files} ${files === 1 ? 'file' : 'files'}`;
}

/** The output without the progress box's empty rows, keeping the rows it ends with. */
function codeGraphPreview(text, limit = PREVIEW_ROWS) {
  return outputLines(text).filter((line) => !CHROME.test(line)).slice(-limit).join('\n');
}

/**
 * The rows a collapsed card draws: the stated count, the init or sync sentence, its
 * facts, or its own last rows. Undefined means the card draws no rows at all, which
 * is what a withheld level and an empty result both ask for. A failure always says
 * why, so a withheld failure still keeps its reason.
 */
function codeGraphCollapsedRows(operation, text, failed, withheld, limit = PREVIEW_ROWS) {
  if (withheld && !failed) return undefined;
  if (failed) {
    const reason = outputLines(text).filter((line) => line.trim().length > 0).slice(-limit).join('\n');
    return reason.length > 0 ? { text: reason, rows: limit, tail: true } : undefined;
  }
  const summary = codeGraphResultSummary(operation, text);
  if (summary !== undefined) return { text: `→ ${summary}`, rows: 1, tail: false };
  const outcome = operation === 'init' ? codeGraphInitOutcome(text) : operation === 'sync' ? codeGraphSyncOutcome(text) : undefined;
  if (outcome !== undefined) return { text: `→ ${outcome}`, rows: 1, tail: false };
  const lines = outputLines(text).filter((line) => !CHROME.test(line));
  const facts = operation === 'init' ? lines.filter((line) => INIT_FACT.test(line)).slice(-limit) : [];
  const preview = (facts.length > 0 ? facts : lines.slice(-limit)).join('\n');
  return preview.length > 0 ? { text: preview, rows: limit, tail: true } : undefined;
}

// Tool output can carry the escape sequences a colouring CLI printed; the card
// draws text, so they are removed rather than interpreted. Tabs and newlines stay:
// they are the card's own layout.
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Text as the card draws it: what the tool printed, without the terminal sequences around it. */
function cardText(value) {
  return typeof value === 'string' ? value.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARACTER, '') : '';
}

/** The whole output as the card draws it when the reader expanded it: normalized, trailing blanks dropped. */
function codeGraphWholeOutput(text) {
  return cardText(text).replace(/\r\n/g, '\n').replace(TRAILING_BLANK, '');
}

module.exports = {
  CODEGRAPH_MARK,
  CODEGRAPH_MCP_TOOL,
  CODEGRAPH_TITLE_ROLE,
  CODEGRAPH_TOOL,
  PREVIEW_ROWS,
  cardText,
  codeGraphCollapsedRows,
  codeGraphInitOutcome,
  codeGraphPreview,
  codeGraphResultSummary,
  codeGraphSyncOutcome,
  codeGraphWholeOutput,
  codegraphCallDetail,
  codegraphCallFromCommand,
};

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
// reader and its package-runner words — and it is self-contained: gentle-shell's
// `lib/odd-phase-inference.ts` is not a dependency of this package. What it decides
// changed for this card: the deciding fact is that `codegraph` is the command word
// of some segment of the command, so any subcommand counts (`codegraph --help`,
// `status`, `callers X`, `node Y`, several of them in one pipeline or chain) and a
// command that merely MENTIONS the program is none of this card's. The command
// itself is the card's detail, so no operation has to be readable for it to draw.

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

/**
 * The last segment of a path, without its separators or a trailing slash. Used for the
 * MCP card's explored checkout, never as a way to resolve a path: this module reads
 * no filesystem and no cwd.
 */
function lastPathSegment(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return undefined;
  const segments = trimmed.split(/[\\/]+/);
  const segment = segments[segments.length - 1];
  return segment !== undefined && segment.length > 0 ? segment : undefined;
}

/** The path with one separator shape, no trailing slash, and no leading `./`. */
function normalizePath(value) {
  return value
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .replace(/^\.\//, '');
}

/**
 * The checkout an MCP `projectPath` names, as the one segment its heading shows, or
 * undefined when there is nothing to name: an absent or empty argument, or the
 * session's own checkout. A bare name (`gentle-shell`) compares equal to the same
 * name as the cwd. `cwd` undefined means the seam could not answer, and then the
 * caller's explicit argument is shown rather than silently dropped (S6).
 */
function projectPathSegment(projectPath, cwd) {
  const segment = lastPathSegment(projectPath);
  if (segment === undefined) return undefined;
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return segment;
  const target = normalizePath(projectPath);
  const base = normalizePath(cwd);
  if (target.length === 0 || target === '.') return undefined;
  // A bare (relative) name is the checkout whose own segment carries it.
  const own = base.split('/').pop();
  if (!target.includes('/')) return target === own ? undefined : segment;
  return target === base ? undefined : segment;
}

// Stream merges and discarded output; neither writes a file.
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;
// Shell keywords that prefix the command they introduce (`do grep x`).
const LEADING_KEYWORDS = /^(do|then|else|elif|if|while|until|time|!|\{|\()\s+/;

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

// Package runners that run the program they name, and the words their own syntax
// puts between them and it: `npx codegraph status` runs it directly, while pnpm,
// npm, yarn and bun need their execution subcommand (`pnpm exec codegraph status`).
// `npm run codegraph` runs a script of that name, so `run` is deliberately absent:
// only an explicit execution of the program counts. Values are the number of
// launcher words (including the subcommand) to skip before the program.
const PROGRAM_RUNNERS = {
  npx: 1,
  bunx: 1,
  pnpx: 1,
  pnpm: 2,
  npm: 2,
  yarn: 2,
  bun: 2,
};
const RUN_SUBCOMMANDS = new Set(['exec', 'dlx']);
// A launcher that also runs the program it names directly: `yarn codegraph status`
// runs the binary, while `yarn exec codegraph status` spells the execution out. Both
// are the program; `yarn run codegraph` stays a script of that name.
const DIRECT_RUNNERS = new Set(['yarn']);

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

/**
 * The index of a command-position `codegraph` program in the words of a segment, or
 * -1 when the segment runs something else. Only the command position names a
 * program, so `echo codegraph init` and `cat codegraph.json` never match; a package
 * runner that executes what it names (`npx codegraph status`, `pnpm exec codegraph
 * status`) is the program too.
 */
function codeGraphProgramIndex(words, start) {
  const program = (value) => /^(?:\S*\/)?codegraph$/.test(value);
  const word = words[start] === undefined ? '' : words[start];
  if (program(word)) return start;
  if (!Object.prototype.hasOwnProperty.call(PROGRAM_RUNNERS, word)) return -1;
  let index = start + 1;
  const skipped = PROGRAM_RUNNERS[word];
  if (skipped > 1) {
    // The launcher's own options come before its execution subcommand.
    while (index < words.length && words[index].startsWith('-')) index += 1;
    const subcommand = words[index] === undefined ? '' : words[index];
    if (RUN_SUBCOMMANDS.has(subcommand)) index += 1;
    else if (!DIRECT_RUNNERS.has(word)) return -1;
  }
  while (index < words.length && (words[index].startsWith('-') || words[index] === '--')) index += 1;
  return program(words[index] === undefined ? '' : words[index]) ? index : -1;
}

/**
 * The words after a command-position `codegraph` program, or undefined when the
 * segment runs something else. Every subcommand is CodeGraph's — the card names the
 * command it ran, so an invocation it cannot interpret, or one that passes only
 * flags, is still that card.
 */
function codeGraphCommandWords(segment) {
  const words = shellWords(segment);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  const at = codeGraphProgramIndex(words, index);
  return at < 0 ? undefined : words.slice(at + 1);
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
 * named, read from the words the command passes. Undefined when no segment of the
 * command runs CodeGraph, so the caller can leave that command's card exactly as it
 * found it.
 *
 * The deciding fact is the command word alone: a segment that runs `codegraph` is a
 * CodeGraph call whatever its subcommand, however many of them the command chains,
 * and whatever else it runs beside them. An invocation with no readable operation
 * (`codegraph --help`) is the empty call `{}` and not a refusal, because the card
 * names the command itself.
 */
function codegraphCallFromCommand(command) {
  if (typeof command !== 'string') return undefined;
  const segments = shellSegments(command);
  if (segments.length === 0) return undefined;
  let found = false;
  let call;
  for (const segment of segments) {
    const words = codeGraphCommandWords(segment);
    if (words === undefined) continue;
    found = true;
    const operation = words.find((word) => !word.startsWith('-'));
    if (operation === undefined) continue;
    const query = queryPayload(operation, words);
    call = { operation, ...(query === undefined ? {} : { query }) };
  }
  return found ? call ?? {} : undefined;
}

/** The heading detail: the operation, and the query when the call named one. */
function codegraphCallDetail(call) {
  return call.query === undefined ? call.operation : `${call.operation} ${call.query}`;
}

// ---- what the output says ----

/**
 * The index facts an init printed: the rows that state what it built, without the
 * progress chrome and without the sentence an outcome row already states.
 */
function codeGraphInitFacts(text) {
  const facts = [];
  for (const line of outputLines(text)) {
    const row = factRow(line);
    if (!INIT_FACT.test(row)) continue;
    if (INIT_OUTCOMES.some(([pattern]) => pattern.test(row))) continue;
    if (!facts.includes(row)) facts.push(row);
  }
  return facts;
}

/**
 * The rows an expanded init draws (S4): the outcome row the collapsed card states,
 * plus at most the index facts it printed. The CLI's advisory line is never one of
 * them. An output with neither an outcome nor a fact keeps its own rows, so the card
 * never goes blank over an init it could not read.
 */
function codeGraphInitRows(text) {
  const outcome = codeGraphInitOutcome(text);
  const rows = [...(outcome === undefined ? [] : [`→ ${outcome}`]), ...codeGraphInitFacts(text)];
  if (rows.length > 0) return rows;
  return outputLines(text)
    .filter((line) => !CHROME.test(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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
  codeGraphInitFacts,
  codeGraphInitOutcome,
  codeGraphInitRows,
  codeGraphPreview,
  codeGraphResultSummary,
  codeGraphSyncOutcome,
  codeGraphWholeOutput,
  codegraphCallDetail,
  codegraphCallFromCommand,
  projectPathSegment,
};

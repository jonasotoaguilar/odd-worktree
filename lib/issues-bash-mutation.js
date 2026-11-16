'use strict';
// T9 (S10): does one `bash` command string mutate a GitHub issue or pull
// request?
//
// The rail re-reads on its own floor (S10/T8, 20 s), and the user's own words
// were "y que de tool solo revise tools bash, si uso algun comando git bash de
// creacion/update de alguna issue o pr, luego de terminar la tool ahi si podria
// forzar un refrezco porque sabemos que algo cambios". This module is that
// question and nothing else: a `bash` command in, a boolean out.
//
// TEXT ONLY, exactly like lib/worktree-guard.js: the command is split into
// segments on `&&`, `||`, `|`, `&`, `;` and newlines, each segment is tokenized
// with one simple quote pair per token (nothing else about the text is
// interpreted), and a segment counts only when its COMMAND position names the
// `gh` binary — an absolute path to it is the same binary, and a leading `env`
// or `VAR=value` prefix is skipped. A mutation MENTIONED in an argument or a
// commit message names no command, so it forces no read.
//
// The verbs are the issue and pull-request writes `gh` ships: for `gh issue`
// create/edit/close/reopen/comment/delete/transfer/develop/lock/unlock; for
// `gh pr` the same set plus merge/review/ready. `gh api` is a write when its
// method is POST/PATCH/PUT/DELETE (`-X POST`, `-XPOST`, `--method PATCH`,
// `--method=PUT`, …) or when it carries the field flags that make `gh` POST
// (`-f`, `--field`, `-F`, `--raw-field`, `--input`). Everything else — `gh issue
// list`, `gh pr view`, a bare `gh api` GET, `gh repo view`, plain `git` — is not
// a write.
//
// Nothing here spawns a child, reads a file, touches the clock or caches
// anything: it is one decision over a string that runs on the hot path of a
// `bash` result, and it never throws, because the caller's refresh is best
// effort and a throw there would ride into a host handler.

/** The `gh` subcommands whose write is a mutation of an issue. */
const ISSUE_MUTATIONS = new Set([
  'create',
  'edit',
  'close',
  'reopen',
  'comment',
  'delete',
  'transfer',
  'develop',
  'lock',
  'unlock',
]);

/** The `gh` subcommands whose write is a mutation of a pull request. */
const PR_MUTATIONS = new Set([
  'create',
  'edit',
  'close',
  'reopen',
  'merge',
  'comment',
  'review',
  'ready',
  'lock',
  'unlock',
]);

/** `gh api` methods that write. */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** `gh api` flags that make an unstated method POST. */
const FIELD_FLAGS = new Set(['-f', '--field', '-F', '--raw-field', '--input']);

/** The prefixes a shell uses in front of the command that really runs. */
const COMMAND_PREFIXES = new Set(['env', 'command', 'nohup', 'sudo', 'time']);

/** A `VAR=value` assignment in the command position. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split one command string into segments of tokens. Separators end a segment,
 * one simple quote pair per token is stripped, and no escape is interpreted —
 * the same reading lib/worktree-guard.js does, without its substitution walk:
 * what a segment's command position names is the whole question here.
 */
function scanSegments(command) {
  const segments = [];
  let tokens = [];
  let token = null;
  const flushToken = () => {
    if (token !== null) {
      tokens.push(token);
      token = null;
    }
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      const inner = end < 0 ? command.slice(i + 1) : command.slice(i + 1, end);
      token = (token === null ? '' : token) + inner;
      i = end < 0 ? command.length : end + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flushToken();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')') {
      // A subshell `( … )` starts a segment of its own, exactly like a separator.
      flushSegment();
      i += 1;
      // `&&`, `||`, `|&`, `;;`: one separator, however it is spelled.
      while (i < command.length && (command[i] === '&' || command[i] === '|' || command[i] === ';')) i += 1;
      continue;
    }
    token = (token === null ? '' : token) + ch;
    i += 1;
  }
  flushSegment();
  return segments;
}

/** The index of the token that runs the command, past `env`/`VAR=value` prefixes. */
function commandIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (ASSIGNMENT.test(token)) {
      i += 1;
      continue;
    }
    if (COMMAND_PREFIXES.has(token)) {
      i += 1;
      // `env -u VAR gh …` / `sudo -E gh …`: the prefix's own options are skipped.
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/** Whether a command token names the `gh` binary, bare or by absolute path. */
function isGhToken(token) {
  return token === 'gh' || token.endsWith('/gh');
}

/** The method `gh api` states on its command line, or null when it states none. */
function statedMethod(tokens, apiIndex) {
  for (let i = apiIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-X' || token === '--method') {
      const value = tokens[i + 1];
      if (typeof value === 'string' && value.length > 0) return value.toUpperCase();
      continue;
    }
    if (token.startsWith('--method=')) return token.slice('--method='.length).toUpperCase();
    if (token.startsWith('-X') && token.length > 2) return token.slice(2).toUpperCase();
  }
  return null;
}

/** Whether a `gh api` segment carries a field flag, which makes the call a POST. */
function carriesField(tokens, apiIndex) {
  for (let i = apiIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (FIELD_FLAGS.has(token)) return true;
    // The `--field=key=value` spelling carries the flag and its value at once.
    if (token.startsWith('--field=') || token.startsWith('--raw-field=') || token.startsWith('--input=')) return true;
  }
  return false;
}

/** Whether one segment's `gh` command mutates an issue or a pull request. */
function segmentMutates(tokens) {
  const at = commandIndex(tokens);
  if (at < 0 || !isGhToken(tokens[at])) return false;
  const group = tokens[at + 1];
  const verb = tokens[at + 2];
  if (group === 'issue') return typeof verb === 'string' && ISSUE_MUTATIONS.has(verb);
  if (group === 'pr') return typeof verb === 'string' && PR_MUTATIONS.has(verb);
  if (group !== 'api') return false;
  const method = statedMethod(tokens, at);
  if (method !== null) return WRITE_METHODS.has(method);
  return carriesField(tokens, at);
}

/**
 * Whether one `bash` command mutates a GitHub issue or pull request. Answers
 * `false` for anything that is not a command string, and never throws.
 */
function bashMutatesIssuesOrPullRequests(command) {
  try {
    if (typeof command !== 'string' || command.length === 0) return false;
    for (const tokens of scanSegments(command)) {
      if (segmentMutates(tokens)) return true;
    }
    return false;
  } catch {
    // A command this scanner cannot read names nothing, so it forces no read.
    return false;
  }
}

module.exports = { bashMutatesIssuesOrPullRequests };

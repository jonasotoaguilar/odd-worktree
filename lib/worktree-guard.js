'use strict';
// T1 (S1–S6, S8–S10): the worktree guard, decided from one `bash` command string.
//
// A worktree is the checkout one ODD owns, and it is created, listed and removed
// through this package's surfaces — never through Git typed into `bash`. The guard
// is the net behind that rule: it refuses, before the command runs, the five things
// a session must not do with Git.
//
//   S1  a command containing the `git` … `worktree` … `add` sequence, in ANY cwd:
//       the create is `worktree_create`'s.
//   S9  a command containing the `git` … `worktree` … `list` sequence, in ANY cwd:
//       the listing is `worktree_list`'s.
//   S3  in the PRINCIPAL checkout, a command that creates a branch: the branch is
//       created inside the ODD's worktree, where the work happens.
//   S4  in the PRINCIPAL checkout, a command that switches to anything but the
//       repository's own default branch — including `checkout -`/`switch -` and a
//       detached checkout, which both leave it.
//   S6  everything else passes: inspection, file restores, `git worktree
//       remove|prune|move`, and every non-`bash` tool call.
//
// S2 — what "the principal checkout" is: the checkout whose absolute `root` IS the
// parent of the absolute git common dir. A linked worktree's common dir lives in the
// principal's `.git`, so its own root never matches, and nothing is refused there. A
// cwd outside version control, or an identity the seam cannot read, leaves the branch
// guards inert (S8): only S1 and S9 apply.
//
// S5 — the default branch is the repository's own answer, resolved by the caller
// through the injected `defaultBranch` seam exactly like the create's base: a local
// `main`, else the branch `origin/HEAD` names, else `init.defaultBranch`. There is no
// `main`/`master` allowlist here. It is read LAZILY: only a command that actually
// switches a branch needs it, so an inspection, a restore, a create or a worktree
// command never pays for it. With no resolvable default branch a switch is NOT
// refused, because refusing would also refuse returning to the real default branch,
// and S8 forbids a false block.
//
// The path-vs-ref rule (S4/S6), stated exactly as implemented: `git switch` never
// takes a path, so what it names is always a ref. `git checkout` names a PATH — a
// restore, so allowed — only when it contains `/` or `.`, has no `..` range, and
// that path EXISTS in the cwd (the injected `pathExists` seam, asked only for that
// ambiguous argument); a `feat/x` or `origin/main` that is not a path is a ref, and
// so is every argument when the seam is absent. A ref that is not the resolved
// default branch is a switch away from it. `git checkout -- <path>` is always a
// restore.
//
// Detection is TEXT ONLY (S1, L2): the command string is split into segments on `&&`,
// `||`, `|`, `&`, `;` and newlines, and inside `$(…)` and backticks, and the token
// sequence is looked for in each segment, tolerating git's own global options between
// `git` and `worktree`/the subcommand (`-C <path>`, `--no-pager`, `-c k=v`). One
// simple surrounding quote pair is stripped per token; escapes, variables, globs,
// aliases, redirections, scripts and files are never interpreted, and nothing is read
// or executed to find out what a command would do. What surrounds the sequence never
// matters: one occurrence refuses the whole call.
//
// Nothing here spawns a child, reads a file or caches anything: `repoIdentity` and
// `defaultBranch` are injected seams, so this module is a pure decision over the
// command text — it runs on the hot path of every `bash` tool call — and it never
// throws, because a thrown `tool_call` handler blocks the tool fail-safe (S8).

const nodePath = require('node:path');

/** S1 (S10): creating a worktree with Git, refused in every cwd. */
const WORKTREE_ADD_REFUSAL = '`git worktree add` did not run: call `worktree_list` first to see whether the ODD already has a checkout, then call `worktree_create` only when it has none.';

/** S9 (S10): listing worktrees with Git, refused in every cwd. */
const WORKTREE_LIST_REFUSAL = '`git worktree list` did not run: call `worktree_list` to see whether the ODD already has a checkout, and pass `all: true` to include the worktrees Git knows outside `<repo-name>-worktrees`, then call `worktree_create` only when it has none.';

/** S3 (S10): creating a branch in the principal checkout. */
const BRANCH_CREATE_REFUSAL = 'The branch-creating command did not run: call `worktree_list` first to see whether the ODD already has a checkout, then create the branch there with `worktree_create` and work in it, because a branch is created inside a worktree, not in the principal checkout.';

/** S4 (S10): switching away from the default branch in the principal checkout. */
const BRANCH_SWITCH_REFUSAL = 'The branch-switching command did not run: call `worktree_list` first to see whether the ODD already has a checkout, then work in that checkout, creating it with `worktree_create` only when the ODD has none, because the principal checkout stays on its default branch.';

/** git's global options that take their value as a SEPARATE argv element. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--super-prefix',
	'--exec-path',
]);

/** The flags that CREATE a branch, per subcommand. */
const CHECKOUT_CREATE_FLAGS = new Set(['-b', '-B', '--orphan']);
const SWITCH_CREATE_FLAGS = new Set(['-c', '-C']);

/** A nested substitution is scanned, but never descended into without a bound. */
const MAX_SUBSTITUTION_DEPTH = 8;

// ---------------------------------------------------------------------
// The scanner: one command string -> segment -> token list (S1, S9, L2).
// ---------------------------------------------------------------------

/** The index of the `)` closing the `(` at `open`, or -1 when it never closes. */
function closingParen(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '(') depth += 1;
		else if (ch === ')') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Split one command into segments of tokens. Separators end a segment; a `$(…)`
 * substitution and a backtick span are scanned as text of their own (their inner
 * command is a segment too), which is the whole of the "compound" handling. One
 * simple surrounding quote pair per token is stripped, and nothing else about the
 * text is interpreted.
 */
function scanSegments(text, out, depth) {
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
		if (tokens.length > 0) out.push(tokens);
		tokens = [];
	};
	const append = (value) => {
		token = (token === null ? '' : token) + value;
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "'" || ch === '"') {
			// One simple pair: its content is the token's text, and a separator inside it
			// never splits. No escape is interpreted, so an unterminated quote simply runs
			// to the end of what it opened. A double-quoted span is still scanned for the
			// command substitutions a shell would run inside it; a single-quoted one is
			// literal, so it is only text.
			const end = text.indexOf(ch, i + 1);
			const inner = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
			append(inner);
			i = end < 0 ? text.length : end + 1;
			if (ch === '"' && depth < MAX_SUBSTITUTION_DEPTH) scanSegments(inner, out, depth + 1);
			continue;
		}
		if (ch === '`') {
			const end = text.indexOf('`', i + 1);
			const inner = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
			i = end < 0 ? text.length : end + 1;
			flushToken();
			if (depth < MAX_SUBSTITUTION_DEPTH) scanSegments(inner, out, depth + 1);
			continue;
		}
		if (ch === '$' && text[i + 1] === '(') {
			const close = closingParen(text, i + 1);
			const inner = close < 0 ? text.slice(i + 2) : text.slice(i + 2, close);
			i = close < 0 ? text.length : close + 1;
			flushToken();
			if (depth < MAX_SUBSTITUTION_DEPTH) scanSegments(inner, out, depth + 1);
			continue;
		}
		if (ch === ' ' || ch === '\t') {
			flushToken();
			i += 1;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			flushSegment();
			i += 1;
			continue;
		}
		if (ch === '&' || ch === '|' || ch === ';') {
			flushSegment();
			i += 1;
			// `&&`, `||`, `|&`, `;;`: one separator, however it is spelled.
			while (i < text.length && (text[i] === '&' || text[i] === '|' || text[i] === ';')) i += 1;
			continue;
		}
		append(ch);
		i += 1;
	}
	flushSegment();
	return out;
}

/** Every segment of one command string, or an empty list when there is none. */
function scanCommand(command) {
	const segments = [];
	try {
		scanSegments(command, segments, 0);
	} catch {
		// A command this scanner cannot read is not a command it can judge: it passes.
		return [];
	}
	return segments;
}

// ---------------------------------------------------------------------
// The detectors: what one segment's tokens name (S1, S3, S4, S9).
// ---------------------------------------------------------------------

/**
 * The index of the token after `git`'s own global options, or -1 when the options
 * run out. Only the options that take a separate value consume the next token, so
 * `git -C <path> worktree add` and `git --no-pager worktree add` both reach
 * `worktree`.
 */
function gitSubcommandIndex(tokens, gitIndex) {
	let i = gitIndex + 1;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token.startsWith('-') || token.length < 2) break;
		i += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
	}
	return i < tokens.length ? i : -1;
}

/** Every `git` token in a segment, by index. */
function gitIndices(tokens) {
	const found = [];
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i] === 'git') found.push(i);
	}
	return found;
}

/** S1/S9: the worktree verb this segment names, or undefined. */
function worktreeIntent(tokens) {
	for (const gitIndex of gitIndices(tokens)) {
		const subcommand = gitSubcommandIndex(tokens, gitIndex);
		if (subcommand < 0 || tokens[subcommand] !== 'worktree') continue;
		const verb = tokens[subcommand + 1];
		if (verb === 'add') return 'add';
		if (verb === 'list') return 'list';
	}
	return undefined;
}

/**
 * The path-vs-ref rule of S4/S6 for `git checkout`: an argument with a `/` or a `.`
 * in it and no `..` range MAY be a path, and is one only when it exists in the cwd.
 * Everything else, and every argument without the seam, names a ref.
 */
function isPathArgument(value, pathExists) {
	if (typeof pathExists !== 'function') return false;
	if (value.includes('..')) return false;
	if (!value.includes('/') && !value.includes('.')) return false;
	try {
		return pathExists(value) === true;
	} catch {
		return false;
	}
}

/** S3/S4: what the `git` at `subcommand` does to the branch, or undefined. */
function branchIntentAt(tokens, subcommand, pathExists) {
	const name = tokens[subcommand];
	const rest = tokens.slice(subcommand + 1);
	if (name === 'branch') {
		// S3/S6: only a bare `git branch <name>` creates. An option first — `-a`, `-v`,
		// `-d`, `-m`, `--list` — lists, deletes or moves, and `git branch` alone lists.
		const first = rest[0];
		if (first === undefined || first.startsWith('-')) return undefined;
		return { kind: 'create', ref: first, detached: false };
	}
	if (name !== 'checkout' && name !== 'switch') return undefined;
	const createFlags = name === 'checkout' ? CHECKOUT_CREATE_FLAGS : SWITCH_CREATE_FLAGS;
	let detached = false;
	let i = 0;
	for (; i < rest.length; i += 1) {
		const token = rest[i];
		// `git checkout -` is the previous branch: a ref, never an option.
		if (token === '-') break;
		// `git checkout -- <path>`: from here on the arguments are paths, so nothing
		// switches and nothing is created.
		if (token === '--') return undefined;
		if (!token.startsWith('-') || token.length < 2) break;
		if (createFlags.has(token)) return { kind: 'create', ref: rest[i + 1], detached: false };
		if (token === '--detach') detached = true;
	}
	if (i >= rest.length) return undefined; // no branch argument: an inspection, not a switch
	const ref = rest[i];
	// `git switch` never takes a path; `git checkout` restores a path that exists.
	if (name === 'checkout' && ref !== '-' && isPathArgument(ref, pathExists)) return undefined;
	return { kind: 'switch', ref, detached };
}

/** S3/S4: the branch intent of one segment, undefined when it names none. */
function branchIntent(tokens, pathExists) {
	let found;
	for (const gitIndex of gitIndices(tokens)) {
		const subcommand = gitSubcommandIndex(tokens, gitIndex);
		if (subcommand < 0) continue;
		const intent = branchIntentAt(tokens, subcommand, pathExists);
		if (intent === undefined) continue;
		// Creating a branch is the stronger statement: it never checks one out as a
		// switch, so the create's own refusal is the one to print.
		if (intent.kind === 'create') return intent;
		if (found === undefined) found = intent;
	}
	return found;
}

// ---------------------------------------------------------------------
// The seams: which checkout this is, and its default branch (S2, S5, S8).
// ---------------------------------------------------------------------

/**
 * S2: the principal checkout's root, or undefined when the cwd is another checkout,
 * no repository, or an identity the seam cannot answer. Never throws.
 */
function principalRootOf(repoIdentity, cwd) {
	if (typeof repoIdentity !== 'function') return undefined;
	if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
	try {
		const identity = repoIdentity(cwd);
		if (!identity || typeof identity.root !== 'string' || typeof identity.commonDir !== 'string') return undefined;
		const root = nodePath.resolve(identity.root);
		// A linked worktree shares the principal's common dir, so its root is never that
		// dir's parent; the principal's own root always is.
		if (nodePath.dirname(nodePath.resolve(identity.commonDir)) !== root) return undefined;
		return root;
	} catch {
		return undefined;
	}
}

/** S5: the repository's default branch as the seam answers it. Never throws. */
function defaultBranchOf(readDefaultBranch, root) {
	if (typeof readDefaultBranch !== 'function') return undefined;
	try {
		const name = readDefaultBranch(root);
		if (typeof name !== 'string') return undefined;
		const trimmed = name.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** S4/S8: whether this switch leaves the default branch. An unknown default never refuses. */
function switchLeavesDefault(intent, defaultBranch) {
	if (intent.detached === true) return true;
	if (intent.ref === '-') return true;
	if (defaultBranch === undefined) return false; // no false block (S8)
	return intent.ref !== defaultBranch;
}

// ---------------------------------------------------------------------
// The decision (S1–S6, S8–S10).
// ---------------------------------------------------------------------

/**
 * Decide one `bash` tool call: `{block: false}`, or `{block: true, reason}` with the
 * one sentence the session reads. Inputs: `toolName`, `command`, `cwd`, and the
 * seams `repoIdentity(cwd)` (sync; `{root, commonDir}` at least),
 * `defaultBranch(root)` (sync; the repository's default branch name or undefined)
 * and `pathExists(cwd, value)` (sync; whether `value` is an existing path there).
 * Never throws.
 */
function decideBashGuard(input) {
	try {
		if (!input || input.toolName !== 'bash') return { block: false };
		const command = input.command;
		if (typeof command !== 'string' || command.length === 0) return { block: false };
		const segments = scanCommand(command);
		if (segments.length === 0) return { block: false };

		// S1 and S9 are text-only and apply in every cwd, so they are answered first,
		// before anything reads the repository at all.
		for (const tokens of segments) {
			const verb = worktreeIntent(tokens);
			if (verb === 'add') return { block: true, reason: WORKTREE_ADD_REFUSAL };
			if (verb === 'list') return { block: true, reason: WORKTREE_LIST_REFUSAL };
		}

		// S3 and S4 need a branch command at all; without one nothing is read.
		const pathExists = typeof input.pathExists === 'function' && typeof input.cwd === 'string'
			? (value) => input.pathExists(input.cwd, value)
			: undefined;
		let intent;
		for (const tokens of segments) {
			const candidate = branchIntent(tokens, pathExists);
			if (candidate === undefined) continue;
			if (candidate.kind === 'create') {
				intent = candidate;
				break;
			}
			if (intent === undefined) intent = candidate;
		}
		if (intent === undefined) return { block: false };

		// S2: the branch guards are the principal checkout's alone.
		const principal = principalRootOf(input.repoIdentity, input.cwd);
		if (principal === undefined) return { block: false };
		if (intent.kind === 'create') return { block: true, reason: BRANCH_CREATE_REFUSAL };

		// S5: the default branch is read only now that a branch is actually switched.
		const defaultBranch = defaultBranchOf(input.defaultBranch, principal);
		if (!switchLeavesDefault(intent, defaultBranch)) return { block: false };
		return { block: true, reason: BRANCH_SWITCH_REFUSAL };
	} catch {
		// S8: a throwing `tool_call` handler blocks the tool fail-safe, so nothing here
		// may escape — an undecidable command simply passes.
		return { block: false };
	}
}

module.exports = {
	decideBashGuard,
};

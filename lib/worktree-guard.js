'use strict';
// T1, T5 (S1–S6, S8–S11): the worktree guard, decided from one `bash` command string,
// plus (T3, S4) the `edit`/`write` guard, decided from the paths a call touches.
//
// A worktree is the checkout one ODD owns, and it is created, listed and removed
// through this package's surfaces — never through Git typed into `bash`. The guard
// is the net behind that rule: it refuses, before the command runs, the three things
// a session must not do with Git.
//
//   S1  a command containing the `git` … `worktree` … `add` sequence, in ANY cwd:
//       the create is `worktree_create`'s.
//   S9  a command containing the `git` … `worktree` … `list` sequence, in ANY cwd:
//       the listing is `worktree_list`'s.
//   S4  in the PRINCIPAL checkout whose CURRENT branch is the default branch, a
//       command that leaves that branch: another ref, `-`, or a detached checkout,
//       also behind `checkout -b|-B|--orphan` and `switch -c|-C|--create|
//       --force-create`, which check out what they create.
//   S6  everything else passes: inspection, file restores, every `git branch` form,
//       `git worktree remove|prune|move`, and every non-`bash` tool call.
//
// T3 (S4, L2) adds the WRITE guard, and it is a different question over different
// input: an `edit` or `write` whose `path` lies inside the PRINCIPAL checkout of the
// session's own repository is refused while that checkout is on the repository's
// default branch. A write is where the rule is broken, so the refusal arrives before
// the file is touched. It judges NOTHING else (L2 is the human's own word): a path
// outside every repository, a path under the OS temp directories even when a scratch
// repository lives there, a path in another repository, a path in a linked worktree, a
// session outside version control, an unreadable identity, a detached HEAD, another
// branch and a default branch that does not resolve all pass. The path is judged by
// its existing parent directory, realpath-resolved, so neither a symlink spelling nor
// a file that does not exist yet can dodge or false-trip it, and anything it cannot
// place passes.
//
// S3 (L10) is a permission, not a refusal: creating, moving, copying, deleting or
// listing a branch changes no checkout, so every `git branch` form yields no intent
// here and is never refused. A branch created and not checked out is exactly what
// `worktree_create` reclaims.
//
// S2 — what "the principal checkout" is: the checkout whose absolute `root` IS the
// parent of the absolute git common dir. A linked worktree's common dir lives in the
// principal's `.git`, so its own root never matches, and nothing is refused there. A
// cwd outside version control, or an identity the seam cannot read, leaves S4 inert
// (S8); S1 and S9 apply in every cwd, whatever the `cd`s do.
//
// S11 — which checkout is judged is the one the command runs in: the segments are
// walked in order and a `cd <literal path>` moves the effective cwd for the segments
// after it, resolved against the cwd in force before it. Only a `cd` the shell really
// runs moves it: text scanned out of a quoted argument (`echo 'cd <path>'`) is
// argument text and moves nothing, while a `cd` inside a shell script argument
// (`bash -c '…'`), a `$(…)` substitution or a backtick span does. A `git -C <path>`
// global option moves one segment the same way — the last `-C` wins, as with git — and
// that segment is judged in the checkout it names. A `cd` or `-C` argument that is not
// a literal path (`$VAR`, `~`, `-`, a glob, a backtick) leaves the effective cwd
// unknown, and an unknown cwd refuses nothing of S4.
//
// S4's conditions, exactly as implemented: a switch intent runs in a cwd that is the
// principal checkout; the repository's default branch resolves (S5, `defaultBranch`);
// and the branch that checkout is on RIGHT NOW (`currentBranch`) IS that default. Then
// it is refused when it leaves the branch — a detached checkout, `-`, or any ref but
// the default. So `git switch main` while on `main` passes, `git switch dev` while on
// `main` is refused, and the same switch while the checkout is on `dev` passes: the
// rule protects the default branch, not a habit. A detached HEAD, an unreadable branch
// or a missing seam is not the default branch, so it refuses nothing (S8). Inside one
// command the branch advances: a switch that lands on a named branch is where the
// segments after it stand, so `git switch main && git switch x` cannot hide behind the
// branch read before the command ran.
//
// S5 — the default branch is the repository's own answer, resolved by the caller
// through the injected `defaultBranch` seam exactly like the create's base: a local
// `main`, else the branch `origin/HEAD` names, else `init.defaultBranch`. There is no
// `main`/`master` allowlist here. It is read LAZILY, only for a switch that is already
// in a principal checkout, so inspection, a restore, a branch create or a worktree
// command never pays for it. `currentBranch` is asked after it and no earlier, and it
// is the one fact this module must never see cached: only the checkout knows where it
// points.
//
// The path-vs-ref rule (S4/S6), stated exactly as implemented: `git switch` never
// takes a path, so what it names is always a ref. `git checkout` names a PATH — a
// restore, so allowed — only when the argument has no `..` range and that path EXISTS
// in the cwd in force (the injected `pathExists` seam, asked only for that argument),
// which is how Git itself settles the ambiguity; a `feat/x`, an `origin/main` or a bare
// `develop` that is not a path is a ref, and so is every argument when the seam is
// absent. `git checkout <ref> -- <path>` and `git checkout -- <path>` are always
// restores. A ref that is not the resolved default branch is a switch away from it, and
// every segment of a compound command counts.
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
// Nothing here spawns a child, executes anything or caches an answer: `repoIdentity`,
// `defaultBranch` and `currentBranch` are injected seams, so this module is a pure
// decision over the command text (or the touched paths) — it runs on the hot path of
// every tool call — and it never throws, because a thrown `tool_call` handler blocks
// the tool fail-safe (S8). The one thing it reads from disk is a path's parent
// directory, and only to resolve a symlink: no file content is ever read.

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

/** S1 (S10): creating a worktree with Git, refused in every cwd. */
const WORKTREE_ADD_REFUSAL = '`git worktree add` did not run: create the ODD\'s checkout with `worktree_create`.';

/** S9 (S10): listing worktrees with Git, refused in every cwd. */
const WORKTREE_LIST_REFUSAL = '`git worktree list` did not run: use `worktree_list` (`all: true` also shows checkouts outside `<repo-name>-worktrees`).';

/** S4 (S10): leaving the default branch of the principal checkout. */
const BRANCH_SWITCH_REFUSAL = 'The branch switch did not run: the principal checkout stays on its default branch. Create the ODD\'s checkout with `worktree_create`.';

/** S4 (T3): a path inside the principal checkout on its default branch. */
const WRITE_GUARD_REFUSAL = (file, branch) => `${file} is in the primary checkout on \`${branch}\`. Work in a worktree (\`worktree_list\` / \`worktree_create\`).`;

/** The two tools that write a file the agent names (S4, T3). */
const WRITE_GUARD_TOOLS = new Set(['edit', 'write']);

/** The OS temp directories whose paths are never judged, whatever lives there (L2). */
const TEMP_DIR_SPELLINGS = ['/tmp', '/var/tmp'];

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

/** The flags that CREATE a branch AND check it out: they leave the branch too (S4). */
const CHECKOUT_CREATE_FLAGS = new Set(['-b', '-B', '--orphan']);
const SWITCH_CREATE_FLAGS = new Set(['-c', '-C', '--create', '--force-create']);

/** A nested substitution is scanned, but never descended into without a bound. */
const MAX_SUBSTITUTION_DEPTH = 8;

/** The shells whose `-c` argument is a script that shell really runs (S11). */
const SHELL_NAMES = /(?:^|\/)(?:bash|sh|zsh|dash|ksh)$/;

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
 * S11: whether the quote about to be scanned is the script argument of a shell
 * (`bash -c '…'`). That text runs in a shell of its own, so a `cd` inside it moves the
 * cwd; every other quoted span is argument text this shell never runs.
 */
function isShellScriptArgument(tokens, token) {
	if (token !== null && token !== '-c') return false;
	const last = token === null ? tokens[tokens.length - 1] : token;
	if (last !== '-c') return false;
	const before = token === null ? tokens[tokens.length - 2] : tokens[tokens.length - 1];
	return typeof before === 'string' && SHELL_NAMES.test(before);
}

/**
 * Split one command into segments of tokens. Separators end a segment; a `$(…)`
 * substitution and a backtick span are scanned as text of their own (their inner
 * command is a segment too), which is the whole of the "compound" handling. One
 * simple surrounding quote pair per token is stripped, and nothing else about the
 * text is interpreted. Each segment records whether a shell really runs it (`real`):
 * a substitution or a shell script argument does, plain quoted argument text does
 * not, and only a `cd` a shell runs moves the effective cwd (S11).
 */
function scanSegments(text, out, depth, real) {
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
		if (tokens.length > 0) out.push({ tokens, real });
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
			// to the end of what it opened. Both kinds are scanned again as text of their
			// own: a double-quoted span holds the substitutions a shell would run, and a
			// single-quoted one holds the command `bash -c '…'` hands to a shell. The
			// guard reads text and nothing else (L2), so what surrounds the sequence
			// never matters.
			const end = text.indexOf(ch, i + 1);
			const inner = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
			const script = real && isShellScriptArgument(tokens, token);
			append(inner);
			i = end < 0 ? text.length : end + 1;
			if (depth < MAX_SUBSTITUTION_DEPTH) scanSegments(inner, out, depth + 1, script);
			continue;
		}
		if (ch === '`') {
			const end = text.indexOf('`', i + 1);
			const inner = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
			i = end < 0 ? text.length : end + 1;
			flushToken();
			if (depth < MAX_SUBSTITUTION_DEPTH) scanSegments(inner, out, depth + 1, real);
			continue;
		}
		if (ch === '$' && text[i + 1] === '(') {
			const close = closingParen(text, i + 1);
			const inner = close < 0 ? text.slice(i + 2) : text.slice(i + 2, close);
			i = close < 0 ? text.length : close + 1;
			flushToken();
			if (depth < MAX_SUBSTITUTION_DEPTH) scanSegments(inner, out, depth + 1, real);
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
		if (ch === '(' || ch === ')') {
			// A subshell `( … )`: the command inside starts a segment of its own.
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
		// A backslash-newline is a line continuation: the shell reads it as nothing.
		scanSegments(command.replace(/\\\r?\n/g, ' '), segments, 0, true);
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
 * One `git` invocation: the index of its subcommand (-1 when its global options run
 * out) and the cwd it runs in. Only the options that take a separate value consume
 * the next token, so `git -C <path> worktree add` and `git --no-pager worktree add`
 * both reach `worktree`. `git -C <path>` runs the invocation in another checkout — the
 * last `-C` wins, as it does in git, and its argument is resolved like a `cd` target
 * (S11) against the cwd in force for the segment.
 */
function gitInvocation(tokens, gitIndex, cwd) {
	let i = gitIndex + 1;
	let effective = cwd;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token.startsWith('-') || token.length < 2) break;
		if (token === '-C') {
			const target = tokens[i + 1];
			effective = effective === undefined || !isLiteralCdTarget(target)
				? undefined
				: nodePath.resolve(effective, target);
			i += 2;
			continue;
		}
		i += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
	}
	return { subcommand: i < tokens.length ? i : -1, cwd: effective };
}

/** The index of the token after those global options, or -1 when they run out. */
function gitSubcommandIndex(tokens, gitIndex) {
	return gitInvocation(tokens, gitIndex, undefined).subcommand;
}

/** Every `git` token in a segment, by index. */
function gitIndices(tokens) {
	const found = [];
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i] === 'git' || tokens[i].endsWith('/git')) found.push(i);
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
 * The path-vs-ref rule of S4/S6 for `git checkout`: an argument names a PATH (a
 * restore) only when it has no `..` range and that path exists in the cwd, which is
 * how Git itself settles the ambiguity. Everything else, and every argument without
 * the seam, names a ref.
 */
function isPathArgument(value, pathExists) {
	if (typeof pathExists !== 'function') return false;
	if (value.includes('..')) return false;
	try {
		return pathExists(value) === true;
	} catch {
		return false;
	}
}

/** S4: what the `git` at `subcommand` does to the branch, or undefined. `git branch`
 *  never appears here: it changes no checkout, whatever it creates (S3). */
function switchIntentAt(tokens, subcommand, pathExists) {
	const name = tokens[subcommand];
	if (name !== 'checkout' && name !== 'switch') return undefined;
	const rest = tokens.slice(subcommand + 1);
	const createFlags = name === 'checkout' ? CHECKOUT_CREATE_FLAGS : SWITCH_CREATE_FLAGS;
	let detached = false;
	let i = 0;
	for (; i < rest.length; i += 1) {
		const token = rest[i];
		// `git checkout -` is the previous branch: a ref, never an option.
		if (token === '-') break;
		// `git checkout -- <path>`: from here on the arguments are paths, so nothing
		// switches.
		if (token === '--') return undefined;
		if (!token.startsWith('-') || token.length < 2) break;
		// A long `--flag=value` token names its value itself: normalise the pair first, so
		// `switch --create=x`, `switch --force-create=x` and `checkout --orphan=x` are the
		// same creates as their spaced spelling and leave the branch too.
		const equals = token.startsWith('--') ? token.indexOf('=') : -1;
		const flag = equals > 0 ? token.slice(0, equals) : token;
		// `-b <name>` / `-cx`: creating a branch and checking it out leaves the current
		// branch too, whatever it creates first.
		const attached = name === 'checkout' ? ['-b', '-B'] : ['-c', '-C'];
		if (createFlags.has(flag)) {
			return { ref: equals > 0 ? token.slice(equals + 1) : rest[i + 1], detached: false };
		}
		if (attached.some((short) => flag.startsWith(short) && !flag.startsWith('--'))) {
			return { ref: rest[i + 1], detached: false };
		}
		if (flag === '--detach' || flag === '-d') detached = true;
	}
	// No branch argument: an inspection, not a switch — except `--detach` alone, which
	// leaves the branch for a detached HEAD.
	if (i >= rest.length) return detached ? { ref: undefined, detached: true } : undefined;
	const ref = rest[i];
	// `git checkout <ref> -- <path>` restores the path from the ref and switches nothing.
	if (name === 'checkout' && rest.slice(i + 1).includes('--')) return undefined;
	// `git switch` never takes a path; `git checkout` restores a path that exists.
	if (name === 'checkout' && ref !== '-' && isPathArgument(ref, pathExists)) return undefined;
	return { ref, detached };
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

/**
 * S4: the branch that checkout is on RIGHT NOW, as the seam answers it, or undefined
 * for a detached HEAD and for a read that fails. Never throws.
 */
function currentBranchOf(readCurrentBranch, root) {
	if (typeof readCurrentBranch !== 'function') return undefined;
	try {
		const name = readCurrentBranch(root);
		if (typeof name !== 'string') return undefined;
		const trimmed = name.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** S11: a `cd` target the guard can take literally — no variable, home, glob or backtick. */
function isLiteralCdTarget(value) {
	if (typeof value !== 'string' || value.length === 0) return false;
	if (value === '-') return false;
	return !/[$~`*?[\]]/.test(value);
}

/**
 * S11: each segment with the cwd in force when it runs. A `cd <literal path>` a shell
 * really runs moves it for the segments after it, resolved against the cwd in force
 * before it; anything else — quoted argument text, a missing or non-literal argument,
 * or a cwd already unknown — leaves it unknown, and an unknown cwd refuses nothing of
 * S4 (S8). S1 and S9 were answered before this walk, so they stay any-cwd.
 */
function segmentsWithCwd(segments, cwd) {
	let effective = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
	const walked = [];
	for (const { tokens, real } of segments) {
		walked.push({ tokens, cwd: effective });
		if (!real) continue;
		const head = tokens[0];
		if (typeof head !== 'string' || (head !== 'cd' && !head.endsWith('/cd'))) continue;
		effective = effective === undefined || !isLiteralCdTarget(tokens[1])
			? undefined
			: nodePath.resolve(effective, tokens[1]);
	}
	return walked;
}

/** S4/S8: whether this switch leaves the default branch. An unknown default never refuses. */
function switchLeavesDefault(intent, defaultBranch) {
	if (intent.detached === true) return true;
	if (intent.ref === '-') return true;
	if (defaultBranch === undefined) return false; // no false block (S8)
	return intent.ref !== defaultBranch;
}

// ---------------------------------------------------------------------
// The write guard's own reading of a path (T3, S4, L2).
// ---------------------------------------------------------------------

/** The real path of `value`, or undefined when the filesystem cannot resolve it. */
function realpathOf(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return undefined;
	}
}

/** Whether `child` IS `parent` or lies below it. Lexical: both are already resolved. */
function isInside(child, parent) {
	if (child === parent) return true;
	const base = parent.endsWith(nodePath.sep) ? parent : `${parent}${nodePath.sep}`;
	return child.startsWith(base);
}

/**
 * S4: the PRINCIPAL checkout of the repository the session stands in — the checkout
 * that owns the shared git dir (`<root>/.git`, so the principal is that dir's parent,
 * for the principal itself and for a linked worktree alike). Undefined when the session
 * is outside version control, when the identity cannot be read, and when the common dir
 * is not a `.git` of a normal repository (a bare repository, a separate git dir): an
 * unplaceable repository refuses nothing (L2). Never throws.
 */
function sessionPrincipal(repoIdentity, cwd) {
	if (typeof repoIdentity !== 'function') return undefined;
	if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
	try {
		const identity = repoIdentity(cwd);
		if (!identity || typeof identity.commonDir !== 'string' || identity.commonDir.length === 0) return undefined;
		const commonDir = nodePath.resolve(identity.commonDir);
		if (nodePath.basename(commonDir) !== '.git') return undefined;
		const principal = nodePath.dirname(commonDir);
		return realpathOf(principal) || principal;
	} catch {
		return undefined;
	}
}

/** The real root of the checkout that owns `dir`, or undefined when it cannot be read. Never throws. */
function ownerRootOf(repoIdentity, dir) {
	try {
		const identity = repoIdentity(dir);
		if (!identity || typeof identity.root !== 'string' || identity.root.length === 0) return undefined;
		const root = nodePath.resolve(identity.root);
		return realpathOf(root) || root;
	} catch {
		return undefined;
	}
}

/**
 * L2: the spellings a path is compared against to learn it is in a temp directory. The
 * OS answer, the two fixed ones, the environment's own, and the realpath of each: on a
 * platform where `/tmp` is a symlink, both spellings mean the same directory.
 */
function tempRoots(env) {
	const roots = [];
	const push = (value) => {
		if (typeof value !== 'string' || value.length === 0) return;
		let resolved;
		try {
			resolved = nodePath.resolve(value);
		} catch {
			return;
		}
		for (const spelling of [resolved, realpathOf(resolved)]) {
			if (typeof spelling === 'string' && spelling.length > 0 && !roots.includes(spelling)) roots.push(spelling);
		}
	};
	for (const value of TEMP_DIR_SPELLINGS) push(value);
	try {
		push(os.tmpdir());
	} catch {
		// An OS without an answer simply contributes no root.
	}
	if (env && typeof env === 'object') push(env.TMPDIR);
	return roots;
}

/**
 * S4: the absolute path a written file really is, or undefined when it cannot be
 * placed. The FILE may not exist yet — a new file in an existing directory is judged by
 * that directory — so the existing parent is what is resolved, and a symlinked spelling
 * of a checkout resolves to the checkout itself instead of dodging the check.
 */
function judgedPath(raw, cwd) {
	if (typeof raw !== 'string' || raw.length === 0) return undefined;
	// Pi strips one leading `@` from a file tool's path before it opens the file, so the
	// guard judges the path the tool will really touch, not the spelling it was given.
	const spelled = raw.startsWith('@') && raw.length > 1 ? raw.slice(1) : raw;
	let absolute;
	try {
		absolute = nodePath.resolve(cwd, spelled);
	} catch {
		return undefined;
	}
	const parent = realpathOf(nodePath.dirname(absolute));
	if (parent === undefined) return undefined;
	return nodePath.join(parent, nodePath.basename(absolute));
}

/**
 * Decide one `edit`/`write` tool call (T3, S4, L2): `{block: false}`, or
 * `{block: true, reason}` with the one sentence the session reads. Inputs:
 * `toolName`, `paths` (every path the call touches), `cwd`, and the same seams the
 * `bash` guard takes: `repoIdentity(cwd)`, `defaultBranch(root)` and
 * `currentBranch(root)` — the last one read fresh, because only the checkout knows
 * where it points. Never throws.
 */
function decideWriteGuard(input) {
	try {
		if (!input || typeof input !== 'object') return { block: false };
		if (!WRITE_GUARD_TOOLS.has(input.toolName)) return { block: false };
		const raw = typeof input.paths === 'string' ? [input.paths] : input.paths;
		if (!Array.isArray(raw) || raw.length === 0) return { block: false };
		const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : undefined;
		if (cwd === undefined) return { block: false };

		// L2: a path under a temp directory is never judged, and that answer must cost no
		// git at all — scratch work (and a scratch repository) is the common case, so it is
		// settled first, before the session's own checkout is even resolved. A path the
		// filesystem cannot place is settled here too.
		let temps;
		const candidates = [];
		for (const value of raw) {
			const judged = judgedPath(value, cwd);
			if (judged === undefined) continue;
			if (temps === undefined) temps = tempRoots(process.env);
			if (temps.some((root) => isInside(judged, root))) continue;
			candidates.push(judged);
		}
		if (candidates.length === 0) return { block: false };

		// S4: only the session's OWN repository is ever judged. Outside version control,
		// or with an identity the seam cannot answer, nothing blocks.
		const principal = sessionPrincipal(input.repoIdentity, cwd);
		if (principal === undefined) return { block: false };

		// The first path that really lies in the principal checkout is the one the refusal
		// names; a path in another repository, or in a linked worktree, is placed and passes.
		const target = candidates.find((judged) => isInside(judged, principal));
		if (target === undefined) return { block: false };

		// A linked worktree or a nested repository can live INSIDE the principal directory,
		// so lying under it is not enough: the checkout that really owns the path's own
		// directory must be the principal. Another owner, or the principal itself, is settled
		// by that directory's identity; one the seam cannot answer is not judged (L2).
		// The owner is asked through its own seam, never a remembered answer: a nested
		// worktree can appear during the session. It falls back to the session's seam.
		const ownerSeam = typeof input.ownerIdentity === 'function' ? input.ownerIdentity : input.repoIdentity;
		const owner = ownerRootOf(ownerSeam, nodePath.dirname(target));
		if (owner === undefined || owner !== principal) return { block: false };

		// S4: the rule protects the default branch, so the checkout must be ON it. The
		// current branch is read first and never cached; a detached HEAD, an unreadable
		// answer or any other branch passes without resolving the default at all.
		const current = currentBranchOf(input.currentBranch, principal);
		if (current === undefined) return { block: false };
		const defaultBranch = defaultBranchOf(input.defaultBranch, principal);
		if (defaultBranch === undefined || defaultBranch !== current) return { block: false };
		return { block: true, reason: WRITE_GUARD_REFUSAL(target, defaultBranch) };
	} catch {
		// S8: a write guard that threw would block the tool fail-safe, and a path it cannot
		// judge must pass (L2), so nothing escapes here.
		return { block: false };
	}
}

// ---------------------------------------------------------------------
// The decision (S1–S6, S8–S10).
// ---------------------------------------------------------------------

/**
 * Decide one `bash` tool call: `{block: false}`, or `{block: true, reason}` with the
 * one sentence the session reads. Inputs: `toolName`, `command`, `cwd`, and the seams
 * `repoIdentity(cwd)` (sync; `{root, commonDir}` at least), `defaultBranch(root)` (sync;
 * the repository's default branch name or undefined), `currentBranch(root)` (sync; the
 * branch that checkout is on right now, undefined when detached or unreadable) and
 * `pathExists(cwd, value)` (sync; whether `value` is an existing path there).
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
		for (const { tokens } of segments) {
			const verb = worktreeIntent(tokens);
			if (verb === 'add') return { block: true, reason: WORKTREE_ADD_REFUSAL };
			if (verb === 'list') return { block: true, reason: WORKTREE_LIST_REFUSAL };
		}

		// S4 is the only rule left, and it needs a switch to judge: without one nothing
		// is read at all.
		const hasPathSeam = typeof input.pathExists === 'function';
		// One answer per checkout for the whole call: a `cd` or a `git -C` may move between
		// two of them, and the default branch never changes inside one command. What DOES
		// change is the branch the checkout is on: a switch that lands on a named branch is
		// where the rest of the command stands, so it is read once and then advanced.
		const defaults = new Map();
		const currents = new Map();

		// S11: every segment is judged in the cwd in force when it runs, in order, and
		// every `git -C` in it in the checkout that invocation names.
		for (const { tokens, cwd } of segmentsWithCwd(segments, input.cwd)) {
			for (const gitIndex of gitIndices(tokens)) {
				const invocation = gitInvocation(tokens, gitIndex, cwd);
				if (invocation.subcommand < 0) continue;
				const pathExists = hasPathSeam && typeof invocation.cwd === 'string'
					? (value) => input.pathExists(invocation.cwd, value)
					: undefined;
				const intent = switchIntentAt(tokens, invocation.subcommand, pathExists);
				if (intent === undefined) continue;

				// S2: the switch is judged in the checkout it runs in. An unknown cwd, a
				// linked worktree and a cwd outside version control all stop here.
				const principal = principalRootOf(input.repoIdentity, invocation.cwd);
				if (principal === undefined) continue;
				// S5: the default branch, read only now that a switch is actually judged. With
				// none resolvable nothing is refused (S8), because the real default must stay
				// reachable.
				if (!defaults.has(principal)) defaults.set(principal, defaultBranchOf(input.defaultBranch, principal));
				const defaultBranch = defaults.get(principal);
				if (defaultBranch === undefined) continue;
				// S4: only a checkout that is ON the default branch can leave it. A detached
				// HEAD or a branch the seam cannot name is not the default branch, so a switch
				// there is allowed and `currentBranch` is the one fact never memoized.
				if (!currents.has(principal)) currents.set(principal, currentBranchOf(input.currentBranch, principal));
				if (currents.get(principal) === defaultBranch && switchLeavesDefault(intent, defaultBranch)) {
					return { block: true, reason: BRANCH_SWITCH_REFUSAL };
				}
				// S4: the branch the command moved to is the branch the segments after it
				// leave, so `git switch main && git switch x` is judged from `main`. A detached
				// checkout and `-` (the previous branch) name no branch to carry.
				if (intent.detached !== true && typeof intent.ref === 'string' && intent.ref !== '-') {
					currents.set(principal, intent.ref);
				}
			}
		}
		return { block: false };
	} catch {
		// S8: a throwing `tool_call` handler blocks the tool fail-safe, so nothing here
		// may escape — an undecidable command simply passes.
		return { block: false };
	}
}

module.exports = {
	decideBashGuard,
	decideWriteGuard,
};

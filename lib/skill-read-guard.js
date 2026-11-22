'use strict';
// invariant 22 (the `bash` guards read text, fail open and add no surface): the
// skill-read guard, decided from one `bash` command string.
//
// A skill file is read with `read`. A reader typed into `bash` — `cat`, `sed -n`, … —
// prints the file into the transcript instead, so the guard refuses, before the
// command runs, the call that reads one.
//
// The rule, exactly as implemented: the command is split by the package's ONE
// segmenter (`shellCommandSegments`, `lib/bash-activity.js`), which never splits
// inside quotes and keeps a heredoc body in the segment that opened it. Per segment
// the command position names the program — leading `VAR=value` assignments and the
// `env`/`time`/`nice` wrappers come before it — and only a program that PRINTS a
// file's text is judged: `cat`, `head`, `tail`, `less`, `more`, `bat`, `batcat`, `nl`,
// `awk`, and `sed` without `-i`/`--in-place`, which writes and so is not a read.
// `grep` and `rg` are absent on purpose: searching a file is not reading it, and the
// rule stays narrow. A `cd` needs no handling here — the segmenter already ends the
// segment it appears in.
//
// Every non-option argument word of such a program is a path, and the path is a
// SKILL file when `fileCardIdentity` (`lib/skill-odd-card.js`) says so: that module
// decides on the FOLDERS alone, so a path below a `skills` component is a skill
// (`~/.agents/skills/x/SKILL.md`, `…/skills/x/references/y.md`) while `docs/SKILL.md`
// and `notes/SKILL.md` are ordinary files, and a path whose closest marker is `odd` is
// an ODD artifact. That identity needs no absolute path, so a leading `~` is judged
// exactly as written and nothing is expanded, resolved or read.
//
// What is NOT a path: a redirection operator and its target (the shell hands neither
// to the program, so `cat > skills/x/SKILL.md` writes and names no file to read); a
// heredoc header and everything after it (its body is data, never an argument); the
// single word `-` (stdin); and `$VAR`, a backtick, or a glob (`*`, `?`, `[…]`, `{…}`),
// which name a file this reader cannot know. The value an option takes is skipped with
// the option (`sed -e 's/a/b/'`, `head -n 20`), and so is the inline program of
// `sed`/`awk` (`sed -n '/skills/p' README.md` reads README.md), so a script is never
// mistaken for a path. A word with no separator at all can be no skill either — the
// identity always needs the `skills` folder above the file — so it is dropped before
// the identity is asked.
//
// One occurrence refuses the WHOLE call, and the reason names the FIRST offending path:
// a command that mixes a skill read with other work is refused as a whole, so the model
// re-issues the other work and reads the skill with `read`.
//
// Nothing here spawns a child, reads a file or caches anything: the decision is a pure
// function over the command TEXT, and it never throws, because a throwing `tool_call`
// handler blocks the tool fail-safe (invariant 22). `ODD_WORKTREE_GUARD=0` — the
// worktree guard's own switch — turns it off, and the guard registers no command, no
// tool, no option and no setting of its own (invariant 3).

const path = require('node:path');
const { shellCommandSegments } = require('./bash-activity.js');
const { FILE_CARD_IDENTITY, fileCardIdentity } = require('./skill-odd-card.js');

/** The readers that print a file's text, so their argument words name files they read. */
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl', 'awk', 'sed']);

/** The wrappers that run another program: the program position is the word after them. */
const WRAPPERS = new Set(['env', 'time', 'nice', 'timeout', 'sudo', 'command', 'exec', 'nohup']);

/** The words a script's control flow puts before the command it runs: `then cat …`, `do head …`. */
const LEADING_KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']);

/** The shells whose `-c` argument is a command line of its own. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/** A wrapper option that takes its value as the NEXT word (`nice -n 5`, `env -u HOME`). */
const WRAPPER_VALUE_OPTIONS = {
	env: new Set(['-u', '-C', '-S']),
	nice: new Set(['-n']),
	time: new Set(['-f', '-o']),
	timeout: new Set(['-s', '-k']),
	sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D']),
	command: new Set(),
	exec: new Set(['-a']),
	nohup: new Set(),
};

/** An environment assignment at the command position: `SKILL_DIR=… cat …`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word the shell resolves first, so this reader cannot know which file it names. */
const UNRESOLVED = /[$`\u0000]/;

/** `sed -i`, `-i.bak`, `-ni` and `--in-place[=SUFFIX]` write the file: a write is not a read. */
const IN_PLACE = /^(?:--in-place(?:=|$)|-[A-Za-z]*i)/;

/**
 * The options that take their value as a SEPARATE word, per reader, so a value that
 * happens to contain a slash (`sed -e 's/a/b/'`) is never read as a file name. A
 * `--flag=value` token carries its own value and therefore consumes no next word, and a
 * short option with its value glued on (`-n5`, `-i.bak`) consumes none either.
 */
const VALUE_OPTIONS = new Map([
	['head', { longs: new Set(['--lines', '--bytes']), shorts: new Set(['n', 'c']) }],
	['tail', { longs: new Set(['--lines', '--bytes', '--sleep-interval', '--pid']), shorts: new Set(['n', 'c', 's']) }],
	['nl', {
		longs: new Set([
			'--body-numbering', '--section-delimiter', '--footer-numbering', '--header-numbering',
			'--line-increment', '--join-blank-lines', '--number-format', '--number-separator',
			'--starting-line-number', '--number-width',
		]),
		shorts: new Set(['b', 'd', 'f', 'h', 'i', 'l', 'n', 's', 'v', 'w']),
	}],
	['awk', { longs: new Set(['--file', '--field-separator', '--assign', '--include', '--load']), shorts: new Set(['f', 'F', 'v']) }],
	['sed', { longs: new Set(['--expression', '--file', '--line-length']), shorts: new Set(['e', 'f', 'l']) }],
	['bat', {
		longs: new Set([
			'--language', '--theme', '--line-range', '--tabs', '--terminal-width', '--style',
			'--map-syntax', '--highlight-line', '--diff-context',
		]),
		shorts: new Set(['l', 'r', 'H']),
	}],
	['less', {
		longs: new Set(['--tabs', '--shift', '--window', '--buffers', '--max-line-length', '--pattern', '--prompt']),
		shorts: new Set(['x', 'b', 'h', 'j', 'o', 'O', 'p', 'P', 't', 'T', 'y', 'z', 'D']),
	}],
]);

/**
 * `sed` and `awk` take their PROGRAM as the first non-option word unless a flag named
 * one, so that word is a script and never a file: `sed -n '/skills/p' README.md` reads
 * README.md, while `sed -n '1,80p' …/skills/x/SKILL.md` still names the skill.
 */
const SCRIPT_FLAGS = new Map([
	['sed', { longs: new Set(['--expression', '--file']), shorts: new Set(['e', 'f']) }],
	['awk', { longs: new Set(['--file']), shorts: new Set(['f']) }],
]);

const NO_OPTIONS = { longs: new Set(), shorts: new Set() };

/** The last component of a word path, so `/usr/bin/cat` is the program `cat`. */
function baseName(word) {
	const slash = word.lastIndexOf('/');
	return slash < 0 ? word : word.slice(slash + 1);
}

/** A `--flag=value` token's own name, or the token itself when it names no value. */
function longName(word) {
	const equals = word.indexOf('=');
	return equals < 0 ? word : word.slice(0, equals);
}

/** The letters of a short option cluster (`-ne` is `n`,`e`); empty for anything else. */
function shortLetters(word) {
	// Up to the first character that is not a letter: `-ne1p` is `n`,`e` and a glued value.
	const cluster = /^-([A-Za-z]+)/.exec(word);
	return cluster === null ? [] : cluster[1].split('');
}

/** Whether this option token takes its value as the next word. */
function takesValue(word, options) {
	if (word.startsWith('--')) return !word.includes('=') && options.longs.has(word);
	if (!/^-[A-Za-z0-9]/.test(word)) return false;
	const chars = word.slice(1).split('');
	for (let at = 0; at < chars.length; at += 1) {
		// The first value-taking letter ends the cluster: what follows it IS its value (`-ne1p`),
		// and only when nothing follows does the value come as the next word.
		if (options.shorts.has(chars[at])) return at === chars.length - 1;
	}
	return false;
}

/**
 * One segment read as the words a program receives, with every quote span resolved and
 * every redirection dropped.
 *
 * A redirection is not an argument: the operator, the file descriptor glued to it
 * (`2>`, `>&1`) and the target word that follows are all dropped, so `cat > skills/x/SKILL.md`
 * names no file at all while `cat notes/a.md > out.md` still names `notes/a.md`. A
 * heredoc STOPS the read: the body the segmenter kept in this segment is data the
 * command reads, never more arguments. Never throws.
 */
function segmentWords(segment) {
	const words = [];
	let word = null;
	let drop = false;
	let bodyFollows = false;
	const flush = () => {
		// A redirection's target is still to come: an empty word keeps the drop in force.
		if (word === null) return;
		if (drop !== true) words.push(word);
		word = null;
		drop = false;
	};
	let index = 0;
	while (index < segment.length) {
		const char = segment[index];
		if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
			// The first newline after a heredoc header opens its body: data, never arguments.
			if (char === '\n' && bodyFollows) break;
			flush();
			index += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			// The segmenter already agreed not to split inside a quote; here the quotes come
			// off, so `cat "skills/x/SKILL.md"` names the same path as the bare spelling.
			const end = segment.indexOf(char, index + 1);
			const inner = end < 0 ? segment.slice(index + 1) : segment.slice(index + 1, end);
			word = (word === null ? '' : word) + inner;
			index = end < 0 ? segment.length : end + 1;
			continue;
		}
		if (char === '\\') {
			const next = segment[index + 1];
			if (next !== undefined) word = (word === null ? '' : word) + next;
			index += next === undefined ? 1 : 2;
			continue;
		}
		// A heredoc: its header (`<<'EOF'`) names no file; what follows it on the same line is still
		// the command's own words, and the body that starts on the next line is data.
		if (char === '<' && segment[index + 1] === '<' && segment[index + 2] !== '<') {
			flush();
			index += 2;
			if (segment[index] === '-') index += 1;
			while (segment[index] === ' ' || segment[index] === '\t') index += 1;
			while (index < segment.length && !/[\s;|&<>]/.test(segment[index])) {
				if (segment[index] === "'" || segment[index] === '"') {
					const end = segment.indexOf(segment[index], index + 1);
					index = end < 0 ? segment.length : end + 1;
				} else index += 1;
			}
			bodyFollows = true;
			continue;
		}
		if (char === '>' || char === '<') {
			// A word glued to the operator is a real argument (`cat a.md>out.md`) unless it is
			// only digits, which is the file descriptor the operator applies to.
			if (word !== null && /^\d+$/.test(word)) word = null;
			else flush();
			index += 1;
			while (index < segment.length && (segment[index] === '>' || segment[index] === '<' || segment[index] === '&')) index += 1;
			// `>&1`, `2>&-`: the descriptor is glued on, so no target word follows.
			let glued = false;
			if (index < segment.length && /[0-9-]/.test(segment[index])) {
				while (index < segment.length && /[0-9-]/.test(segment[index])) index += 1;
				glued = true;
			}
			// An output target is not an argument; an input target (`cat < file`) is a file read.
			drop = char === '>' && glued !== true;
			continue;
		}
		word = (word === null ? '' : word) + char;
		// An UNQUOTED glob character leaves a mark: a quoted or escaped one is a literal name.
		if (/[*?[\]{}]/.test(char)) word += '\u0000';
		index += 1;
	}
	flush();
	return words;
}

/** The index of the word the shell runs, or undefined when this segment names no command. */
function programIndex(words) {
	let index = 0;
	while (index < words.length) {
		const word = words[index];
		if (ASSIGNMENT.test(word) || LEADING_KEYWORDS.has(word)) {
			index += 1;
			continue;
		}
		if (WRAPPERS.has(baseName(word))) {
			// The wrapper's own options, then any assignment it takes, then the program:
			// `env -u HOME SKILL_DIR=1 cat …` still names `cat`.
			const wrapper = baseName(word);
			index += 1;
			while (index < words.length && words[index].length > 1 && words[index].startsWith('-')) {
				index += WRAPPER_VALUE_OPTIONS[wrapper].has(words[index]) ? 2 : 1;
			}
			// `timeout` takes its duration before the command it bounds.
			if (wrapper === 'timeout') index += 1;
			continue;
		}
		return index;
	}
	return undefined;
}

/**
 * One reader's argument list: the words that name a file it reads, and whether it edits
 * in place. Options are skipped together with the value they take, `--` ends them, and
 * the inline program of `sed`/`awk` is skipped as a script.
 */
function fileWords(program, words, from) {
	const options = VALUE_OPTIONS.get(program === 'batcat' ? 'bat' : program) || NO_OPTIONS;
	const script = SCRIPT_FLAGS.get(program);
	const files = [];
	let scriptGiven = script === undefined;
	let optionsEnded = false;
	let inPlace = false;
	let index = from;
	while (index < words.length) {
		const word = words[index];
		if (!optionsEnded && word === '--') {
			optionsEnded = true;
			index += 1;
			continue;
		}
		// `less +/pattern file` runs a command or a search first: it is an option, not a file.
		if (!optionsEnded && program === 'less' && word.length > 1 && word.startsWith('+')) {
			index += 1;
			continue;
		}
		if (!optionsEnded && word.length > 1 && word.startsWith('-')) {
			if (program === 'sed' && IN_PLACE.test(word)) inPlace = true;
			if (script !== undefined
				&& (script.longs.has(longName(word)) || shortLetters(word).some((letter) => script.shorts.has(letter)))) {
				scriptGiven = true;
			}
			index += takesValue(word, options) ? 2 : 1;
			continue;
		}
		// The inline script comes first when the reader runs one: it is a program, never a path.
		if (!scriptGiven) {
			scriptGiven = true;
			index += 1;
			continue;
		}
		files.push(word);
		index += 1;
	}
	return { files, inPlace };
}

/**
 * Whether this argument word names a skill file. A word the shell resolves, a bare `-`,
 * and a word with no separator (a skill always sits BELOW its `skills` folder) are not
 * paths at all; the rest is judged by the folders `fileCardIdentity` reads.
 */
function isSkillFile(word) {
	if (typeof word !== 'string' || word.length === 0) return false;
	if (word === '-') return false;
	if (UNRESOLVED.test(word)) return false;
	const normal = path.posix.normalize(word);
	if (!/[\\/]/.test(normal)) return false;
	// Judged as written: the identity is decided by the folders, so `~` needs no expansion
	// and no file is touched to answer.
	const card = fileCardIdentity(normal);
	return card !== undefined && card.identity === FILE_CARD_IDENTITY.SKILL;
}

/** The first skill file this one segment reads, or undefined. */
function skillReadPath(segment, depth = 0) {
	const words = segmentWords(segment);
	const at = programIndex(words);
	if (at === undefined) return undefined;
	const program = baseName(words[at]);
	// A shell handed a command line reads it as commands of its own, two levels deep at most.
	if (SHELLS.has(program) && words[at + 1] === '-c' && words[at + 2] !== undefined) {
		if (depth >= 2) return undefined;
		for (const inner of shellCommandSegments(words[at + 2])) {
			const found = skillReadPath(inner, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!READ_PROGRAMS.has(program)) return undefined;
	// A usage or version request prints text and reads no file.
	if (words.slice(at + 1).some((word) => word === '--help' || word === '--version')) return undefined;
	const { files, inPlace } = fileWords(program, words, at + 1);
	// `sed -i` writes the file: it is not a read, whatever it names.
	if (inPlace) return undefined;
	for (const word of files) {
		if (isSkillFile(word)) return word;
	}
	return undefined;
}

/** The one sentence a refused call shows: what did not run, the path, and the one tool. */
function skillReadRefusal(skillPath) {
	return `This bash call was not run: it reads the skill file ${skillPath} — read skill files with the \`read\` tool instead.`;
}

/**
 * Decide one `bash` command: `{block: true, reason}` for the first segment that reads a
 * skill file with a reader, and undefined when nothing does. Input is the command TEXT
 * only — nothing is run, resolved or read — and it never throws.
 */
function decideSkillReadGuard(command) {
	try {
		if (typeof command !== 'string' || command.length === 0) return undefined;
		const segments = shellCommandSegments(command);
		if (!Array.isArray(segments)) return undefined;
		for (const segment of segments) {
			if (typeof segment !== 'string') continue;
			const skillPath = skillReadPath(segment);
			if (skillPath !== undefined) return { block: true, reason: skillReadRefusal(skillPath) };
		}
		return undefined;
	} catch {
		// invariant 22: a command this reader cannot judge simply passes.
		return undefined;
	}
}

module.exports = {
	skillReadRefusal,
	decideSkillReadGuard,
};

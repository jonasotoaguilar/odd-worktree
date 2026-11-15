'use strict';
// S1/S6/S7: the one preference this package owns — whether a `bash` tool call is
// drawn as this package's activity card (`own`) or left to the host's own bash
// drawing (`default`).
//
// This module is `lib/card-style.js`'s twin: same two-sided decision, same strict
// document, same order, same reasons. Read that file first; only the vocabulary
// and the one thing it does not need (a writer) differ.
//
// Modes: "own" (this package's card, which reads the call's activity) and
// "default" (the host's own bash drawing). OWN is the default: S6 asked for the
// activity card switched on, so an absent host, an absent document and every
// malformed document all read as own.
//
// The choice lives in two places:
//   * the process-wide slot at `globalThis[Symbol.for("gentle-pi.card-bash-mode")]`.
//     It is the LIVE value: a toggle writes it, so the card resolver this feature
//     registers sees the change on the very next paint of a row it is asked to
//     draw — a property read, no watcher, no restart.
//   * the strict document `<home>/card-bash.json`: `{"schema":
//     "gentle-pi.card-bash/v1","mode":"own"|"default"}` and nothing else. It is
//     what survives a restart (S7), and it is read on every call the slot cannot
//     answer, so a hand edit is visible on the next paint.
// `<home>` resolves exactly as `lib/card-style.js` resolves it —
// `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai` — so
// this package never invents a second home.
//
// One decision order, never a guess and never a throw:
//     global slot → preference document → own
// A slot holding a known mode always wins, because that is what the running
// session says; a slot holding anything else is not a decision and the document
// answers. A missing, unreadable, malformed, wrong-schema, extra-key or
// unknown-mode document reads as own.
//
// `resolveCardBashMode()` reports which branch answered (`source`) and why it
// fell back (`reason`) — evidence for a test or a bug report, never painted into
// a card. `cardBashMode()` is the same decision without the report and is what
// the card resolver calls on every paint.
//
// `writeCardBashMode()` is the only writer of that document, and it writes in the
// order that cannot leave the two places disagreeing: the document first, then
// the slot. A refused or failed write therefore never flips the live slot, and
// there is nothing to roll back. It is atomic (a temp file in the same directory,
// then a rename), owner-only (0o600) and it creates the home it needs. A document
// that exists but is malformed or unreadable is NEVER rewritten: it is someone's
// file, the honest answer is a refusal that names why, and the caller reports it
// instead of silently replacing a preference nobody could read.
//
// There is no cache and no watcher, by design. With the slot set a paint reads one
// property; without it there is no notification channel for a document edit, so
// the document is read on EVERY paint, which is what makes a hand edit visible on
// the next card instead of at the next `session_start`. One small synchronous
// read per paint (a few hundred bytes, no network, no directory walk) is an
// accepted cost: it is a decision, not an oversight.

const { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

const CARD_BASH_MODE = {
	OWN: 'own',
	DEFAULT: 'default',
};

// Both modes, in the order the toggle visits them, for a caller that validates.
const CARD_BASH_MODES = [CARD_BASH_MODE.OWN, CARD_BASH_MODE.DEFAULT];

// The exact document this package writes: this schema string and the one mode.
const CARD_BASH_SCHEMA = 'gentle-pi.card-bash/v1';
const CARD_BASH_FILE = 'card-bash.json';

// The slot a live session reads. `Symbol.for` is process-wide, so every extension
// copy shares the one cell.
const CARD_BASH_MODE_SLOT = Symbol.for('gentle-pi.card-bash-mode');

const isCardBashMode = (value) => CARD_BASH_MODES.includes(value);

const envText = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : undefined);

/** `<home>`: `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`. */
function cardBashModeHome(env) {
	const source = env !== null && typeof env === 'object' ? env : {};
	const explicit = envText(source.GENTLE_PI_CONFIG_HOME) ?? envText(source.GENTLE_SHELL_CONFIG_HOME);
	if (explicit !== undefined) return explicit;
	try {
		return join(homedir(), '.pi', 'gentle-ai');
	} catch {
		// No usable home directory: there is no document to read or write.
		return null;
	}
}

/** The document path for one home, or null when no home resolves. */
function cardBashModeFile(options) {
	const chosen = options !== null && typeof options === 'object' && envText(options.gentlePiConfigHome) !== undefined
		? options.gentlePiConfigHome
		: cardBashModeHome(process.env);
	return chosen === null || chosen === undefined || chosen === '' ? null : join(chosen, CARD_BASH_FILE);
}

/** The live slot value, or undefined when nothing set it or the cell holds something else. */
function slotMode() {
	try {
		const value = globalThis[CARD_BASH_MODE_SLOT];
		return isCardBashMode(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The mode a document states, or undefined when it states nothing usable. The
 * document is strict: exactly `schema` and `mode`, the schema string verbatim and
 * one of the two known modes.
 */
function parseCardBashModeFile(raw) {
	if (typeof raw !== 'string') return undefined;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	if (Object.keys(value).length !== 2) return undefined;
	if (value.schema !== CARD_BASH_SCHEMA) return undefined;
	if (!Object.prototype.hasOwnProperty.call(value, 'mode')) return undefined;
	return isCardBashMode(value.mode) ? value.mode : undefined;
}

/**
 * The document branch of the decision, read fresh from `globalFile` on every call
 * that reaches it: there is no cache, so no paint can answer with a mode the file
 * no longer states. Every failure reads as own and says which one it was.
 */
function readFileResolution(globalFile) {
	if (globalFile === null) {
		return { mode: CARD_BASH_MODE.OWN, source: 'default', reason: 'missing_file', globalFile };
	}
	let raw;
	try {
		raw = readFileSync(globalFile, 'utf8');
	} catch (error) {
		const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
		return { mode: CARD_BASH_MODE.OWN, source: 'default', reason: missing ? 'missing_file' : 'unreadable_file', globalFile };
	}
	const mode = parseCardBashModeFile(raw);
	if (mode === undefined) return { mode: CARD_BASH_MODE.OWN, source: 'default', reason: 'malformed_file', globalFile };
	return { mode, source: 'file', reason: null, globalFile };
}

/**
 * The whole decision: the live slot, else the document read now, else own. The
 * document is read only when the slot cannot answer, so a live session never
 * touches the disk.
 */
function resolution(options) {
	const slot = slotMode();
	const globalFile = cardBashModeFile(options);
	if (slot !== undefined) return { mode: slot, source: 'slot', reason: 'slot', slot, globalFile };
	const file = readFileResolution(globalFile);
	return { mode: file.mode, source: file.source, reason: file.reason, slot: undefined, globalFile };
}

/**
 * Where the mode came from and why it fell back — `{mode, source, reason, slot,
 * globalFile}`. Same decision as `cardBashMode()`, with the report attached.
 */
function resolveCardBashMode(options) {
	return resolution(options);
}

/** The mode a card must be drawn in: the slot, else the document, else own. Never throws. */
function cardBashMode(options) {
	return resolution(options).mode;
}

/** The exact bytes of a state document, so the writer and a reader agree. */
const documentText = (mode) => `${JSON.stringify({ schema: CARD_BASH_SCHEMA, mode })}\n`;

/**
 * The write's own failure shape, so every branch answers the same way: the mode
 * is unchanged and the reason is honest.
 */
const refused = (reason, file, error) => ({ ok: false, reason, file, ...(error === undefined ? {} : { error }) });

/**
 * Persist one mode, then publish it to the live slot. Resolves, never throws:
 *   `{ok: true, file, mode}`
 *   `{ok: false, reason, file, error?}` — `invalid_mode`, `no_home`,
 *   `malformed_file`, `unreadable_file` or `write_failed` (with the system's code).
 *
 * The order is document-then-slot on purpose: the durable place is written first,
 * so a failure anywhere leaves both the file and the slot on the old mode and
 * there is nothing to roll back.
 */
function writeCardBashMode(mode, options) {
	const file = cardBashModeFile(options);
	if (!isCardBashMode(mode)) return refused('invalid_mode', file);
	if (file === null) return refused('no_home', null);

	// An existing document is read before it is replaced. One this module cannot
	// read or parse is somebody's file with an unknown shape: the honest answer is
	// a refusal, never a silent overwrite of a preference we do not understand.
	let existing;
	try {
		existing = readFileSync(file, 'utf8');
	} catch (error) {
		const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
		if (!missing) return refused('unreadable_file', file);
	}
	if (existing !== undefined && parseCardBashModeFile(existing) === undefined) return refused('malformed_file', file);

	// A temp file in the same directory, owner-only bits applied again after the
	// write (the umask keeps a new file from being 0o600), then a rename: a reader
	// sees the old document or the new one, never half of either.
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(temp, documentText(mode), { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, file);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// A temp file that cannot be removed is the write's own failure, reported below.
		}
		const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
		return refused('write_failed', file, code);
	}

	// The document holds the new mode, so the live cell may now say the same. A cell
	// that cannot be written is not a failed save: the document is what survives.
	try {
		globalThis[CARD_BASH_MODE_SLOT] = mode;
	} catch {
		// A frozen global object leaves the document as the only record.
	}
	return { ok: true, file, mode };
}

module.exports = {
	CARD_BASH_FILE,
	CARD_BASH_MODE,
	CARD_BASH_MODES,
	CARD_BASH_MODE_SLOT,
	CARD_BASH_SCHEMA,
	cardBashMode,
	cardBashModeFile,
	cardBashModeHome,
	parseCardBashModeFile,
	resolveCardBashMode,
	writeCardBashMode,
};

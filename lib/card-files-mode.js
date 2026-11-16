'use strict';
// S1: the two file-card switches, `Card skill` and `Card odd`, and the one
// document behind them.
//
// This module is `lib/card-bash-mode.js`'s twin: same two-sided decision, same
// strict document, same order, same reasons. Read that file first; only the
// vocabulary (two booleans instead of one mode) and the one thing it does not need
// differ.
//
// The switches say whether a `read`/`edit`/`write` call on a customized skill or on
// an ODD artifact is drawn as that file's own card. Both are ON by default: S1
// asked for the two cards, so an absent host, an absent document and every
// malformed document all read as on.
//
// The choice lives in two places:
//   * the process-wide slot at `globalThis[Symbol.for("gentle-pi.card-files")]`.
//     It is the LIVE value and holds the whole state: `{skill: boolean, odd:
//     boolean}`. A toggle writes it, so the card resolver sees the change on the
//     very next paint of a row it is asked to draw — a property read, no watcher,
//     no restart.
//   * the strict document `<home>/card-files.json`: `{"schema":
//     "gentle-pi.card-files/v1","skill":true,"odd":false}` and nothing else. It is
//     what survives a restart, and it is read on every call the slot cannot answer,
//     so a hand edit is visible on the next paint.
// `<home>` resolves exactly as `lib/card-style.js` resolves it —
// `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai` — so
// this package never invents a second home.
//
// One decision order, never a guess and never a throw:
//     global slot → preference document → both on
// A slot holding both booleans always wins, because that is what the running
// session says; a slot holding anything else (a string, a half-filled object, a
// non-boolean) is not a decision and the document answers. A missing, unreadable,
// malformed, wrong-schema, extra-key or non-boolean document reads as both on.
//
// `readCardFiles(host)` is the whole state, `cardFileEnabled(kind, host)` one
// switch of it. Both read the slot off `host` (`globalThis` by default), which is
// the same seam `lib/card-content.js` uses, so a test or a caller can hand over the
// cell it means. An unknown kind is never enabled: it names no card.
//
// `writeCardFileSwitch(kind, enabled, host)` is the only writer of that document,
// and it writes in the order that cannot leave the two places disagreeing: the
// document first, then the slot. A refused or failed write therefore never flips
// the live slot, and there is nothing to roll back. It merges the one switch into
// the state it can currently see, so writing `odd` keeps `skill` as it was. It is
// atomic (a temp file in the same directory, then a rename), owner-only (0o600)
// and it creates the home it needs. A document that exists but is malformed or
// unreadable is NEVER rewritten: it is someone's file, the honest answer is a
// refusal that names why, and the caller reports it instead of silently replacing
// a preference nobody could read.
//
// There is no cache and no watcher, by design. With the slot set a paint reads one
// property; without it there is no notification channel for a document edit, so
// the document is read on EVERY paint, which is what makes a hand edit visible on
// the next card instead of at the next `session_start`. One small synchronous read
// per paint (a few dozen bytes, no network, no directory walk) is an accepted
// cost: it is a decision, not an oversight.

const { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

// The two switches, in the order `/gentle:customize` lists them.
const CARD_FILE_KINDS = Object.freeze(['skill', 'odd']);

// The exact document this package writes: this schema string and the two booleans.
const CARD_FILES_SCHEMA = 'gentle-pi.card-files/v1';
const CARD_FILES_FILE = 'card-files.json';

// The slot a live session reads. `Symbol.for` is process-wide, so every extension
// copy shares the one cell.
const CARD_FILES_SLOT = Symbol.for('gentle-pi.card-files');

// S1: both cards are switched on until a document or a live session says otherwise.
const CARD_FILES_DEFAULTS = Object.freeze({ skill: true, odd: true });

const isCardFileKind = (value) => CARD_FILE_KINDS.includes(value);

const envText = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : undefined);

/** `<home>`: `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`. */
function cardFilesHome(env) {
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

/** The document path for the process's home, or null when no home resolves. */
function cardFilesFile() {
	const chosen = cardFilesHome(process.env);
	return chosen === null || chosen === undefined || chosen === '' ? null : join(chosen, CARD_FILES_FILE);
}

/** A fresh state object, so no caller can mutate the defaults or the live slot. */
const stateOf = (skill, odd) => ({ skill, odd });

/** A state object when `value` states both booleans, otherwise undefined. */
function usableState(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	if (typeof value.skill !== 'boolean' || typeof value.odd !== 'boolean') return undefined;
	return stateOf(value.skill, value.odd);
}

/** The live slot value, or undefined when nothing set it or the cell holds something else. */
function slotState(host) {
	try {
		const holder = host === undefined || host === null ? globalThis : host;
		return usableState(holder[CARD_FILES_SLOT]);
	} catch {
		return undefined;
	}
}

/**
 * The state a document states, or undefined when it states nothing usable. The
 * document is strict: exactly `schema`, `skill` and `odd`, the schema string
 * verbatim and both values booleans.
 */
function parseCardFilesDocument(raw) {
	if (typeof raw !== 'string') return undefined;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	if (Object.keys(value).length !== 3) return undefined;
	if (value.schema !== CARD_FILES_SCHEMA) return undefined;
	if (!Object.prototype.hasOwnProperty.call(value, 'skill') || !Object.prototype.hasOwnProperty.call(value, 'odd')) return undefined;
	return usableState(value);
}

/**
 * The document branch of the decision, read fresh from `file` on every call that
 * reaches it: there is no cache, so no paint can answer with a state the file no
 * longer states. Every failure reads as both on.
 */
function readDocument(file) {
	if (file === null) return undefined;
	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		// A missing, unreadable or directory-wearing-the-name document states nothing.
		return undefined;
	}
	return parseCardFilesDocument(raw);
}

/** The whole state: the live slot, else the document read now, else both on. */
function readCardFiles(host) {
	const slot = slotState(host);
	if (slot !== undefined) return slot;
	return readDocument(cardFilesFile()) ?? stateOf(CARD_FILES_DEFAULTS.skill, CARD_FILES_DEFAULTS.odd);
}

/** One switch: the same decision, for one kind. An unknown kind names no card, so it is never on. */
function cardFileEnabled(kind, host) {
	if (!isCardFileKind(kind)) return false;
	return readCardFiles(host)[kind];
}

/** The exact bytes of a state document, so the writer and a reader agree. */
const documentText = (state) => `${JSON.stringify({ schema: CARD_FILES_SCHEMA, skill: state.skill, odd: state.odd })}\n`;

/**
 * The write's own failure shape, so every branch answers the same way:
 * `{ok: false, reason}` — `invalid_kind`, `invalid_value`, `no_home`,
 * `malformed_file`, `unreadable_file` or `write_failed`.
 */
const refused = (reason) => ({ ok: false, reason });

/**
 * Persist one switch, then publish the whole state to the live slot. Never throws:
 *   `{ok: true, value}` — `value` is the state the document now holds, both kinds
 *   `{ok: false, reason}` — see `refused`.
 *
 * The order is document-then-slot on purpose: the durable place is written first,
 * so a failure anywhere leaves both the file and the slot on the old state and
 * there is nothing to roll back.
 */
function writeCardFileSwitch(kind, enabled, host) {
	if (!isCardFileKind(kind)) return refused('invalid_kind');
	if (typeof enabled !== 'boolean') return refused('invalid_value');
	const file = cardFilesFile();
	if (file === null) return refused('no_home');

	// An existing document is read before it is replaced. One this module cannot
	// read or parse is somebody's file with an unknown shape: the honest answer is
	// a refusal, never a silent overwrite of a preference we do not understand.
	let existing;
	try {
		existing = readFileSync(file, 'utf8');
	} catch (error) {
		const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
		if (!missing) return refused('unreadable_file');
	}
	const fromFile = existing === undefined ? undefined : parseCardFilesDocument(existing);
	if (existing !== undefined && fromFile === undefined) return refused('malformed_file');

	// The merge starts from the state in force: the live slot when it is a decision,
	// else the document, else both on. Writing one switch therefore keeps the other
	// as the user sees it, never as this write alone would guess.
	const base = slotState(host) ?? fromFile ?? CARD_FILES_DEFAULTS;
	const value = stateOf(kind === 'skill' ? enabled : base.skill, kind === 'odd' ? enabled : base.odd);

	// A temp file in the same directory, owner-only bits applied again after the
	// write (the umask keeps a new file from being 0o600), then a rename: a reader
	// sees the old document or the new one, never half of either.
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(temp, documentText(value), { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, file);
	} catch {
		try {
			rmSync(temp, { force: true });
		} catch {
			// A temp file that cannot be removed is the write's own failure, reported below.
		}
		return refused('write_failed');
	}

	// The document holds the new state, so the live cell may now say the same. A cell
	// that cannot be written is not a failed save: the document is what survives.
	try {
		const holder = host === undefined || host === null ? globalThis : host;
		holder[CARD_FILES_SLOT] = stateOf(value.skill, value.odd);
	} catch {
		// A frozen host object leaves the document as the only record.
	}
	return { ok: true, value };
}

module.exports = {
	CARD_FILES_DEFAULTS,
	CARD_FILES_FILE,
	CARD_FILES_SCHEMA,
	CARD_FILES_SLOT,
	CARD_FILE_KINDS,
	cardFileEnabled,
	cardFilesFile,
	cardFilesHome,
	readCardFiles,
	writeCardFileSwitch,
};

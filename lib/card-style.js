'use strict';
// S5: which of the two card looks the transcript follows, read from Gentle Shell
// when it is there and from the user's own preference document when it is not.
//
// Styles: "neon" (the rounded `╭ ╮ ╰ ╯ │` frame) and "float" (the `▎` rail, no
// box). FLOAT is the default: an absent host, an absent document and every
// malformed document all read as float.
//
// The choice lives in two places:
//   * the process-wide slot Gentle Shell keeps at
//     `globalThis[Symbol.for("gentle-pi.card-style")]`. It is the LIVE value:
//     the shell refreshes it at startup, on every `session_start` and right
//     after its Customize save, so a change made while this session runs is
//     seen by the very next render — a property read, no watcher, no restart.
//     This is the runtime path.
//   * the strict document `<home>/card-style.json`, written per user by Gentle
//     Shell: `{"schema":"gentle-pi.card-style/v1","style":"neon"|"float"}` and
//     nothing else. It is the fallback when no host is present.
// `<home>` resolves `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` →
// `~/.pi/gentle-ai`, in that order.
//
// One decision order, never a guess and never a throw:
//     global slot → preference document → float
// A slot holding a known style always wins, because that is what the running
// shell says; a slot holding anything else is not a decision and the document
// answers. A missing, unreadable, malformed, wrong-schema, extra-key or
// unknown-style document reads as float.
//
// `resolveCardStyle()` reports which branch answered (`source`) and why it fell
// back (`reason`) — evidence for a test or a bug report, never painted into a
// card. `cardStyle()` is the same decision without the report and is what the
// card substrate calls on every render; it caches the DOCUMENT branch on the
// document path so a render never touches the disk, while the slot is read on
// every call. `refreshCardStyle()` drops that cache and is what this extension
// calls on `session_start`: nothing is cached across sessions.

const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const CARD_STYLE = {
	NEON: 'neon',
	FLOAT: 'float',
};

// The exact document Gentle Shell writes: this schema string and the one style.
const CARD_STYLE_SCHEMA = 'gentle-pi.card-style/v1';
const CARD_STYLE_FILE = 'card-style.json';

// The slot Gentle Shell resolves the style into. `Symbol.for` is process-wide,
// so every extension copy reads the same cell.
const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');

const isCardStyle = (value) => value === CARD_STYLE.NEON || value === CARD_STYLE.FLOAT;

function envText(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** `<home>`: `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`. */
function cardStyleHome(env) {
	const source = env !== null && typeof env === 'object' ? env : {};
	const explicit = envText(source.GENTLE_PI_CONFIG_HOME) ?? envText(source.GENTLE_SHELL_CONFIG_HOME);
	if (explicit !== undefined) return explicit;
	try {
		return join(homedir(), '.pi', 'gentle-ai');
	} catch {
		// No usable home directory: there is no document to read.
		return null;
	}
}

/** The document path for one home, or null when no home resolves. */
function cardStyleFile(options) {
	const chosen = options !== null && typeof options === 'object' && envText(options.gentlePiConfigHome) !== undefined
		? options.gentlePiConfigHome
		: cardStyleHome(process.env);
	return chosen === null || chosen === undefined || chosen === '' ? null : join(chosen, CARD_STYLE_FILE);
}

/** The live slot value, or undefined when the host is absent or the cell holds something else. */
function slotStyle() {
	try {
		const value = globalThis[CARD_STYLE_SLOT];
		return isCardStyle(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The style a document states, or undefined when it states nothing usable. The
 * document is strict: exactly `schema` and `style`, the schema string verbatim
 * and one of the two known styles.
 */
function parseCardStyleFile(raw) {
	if (typeof raw !== 'string') return undefined;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	if (Object.keys(value).length !== 2) return undefined;
	if (value.schema !== CARD_STYLE_SCHEMA) return undefined;
	if (!Object.prototype.hasOwnProperty.call(value, 'style')) return undefined;
	return isCardStyle(value.style) ? value.style : undefined;
}

/**
 * The document branch of the decision, read fresh from `globalFile`. Every
 * failure reads as float and says which one it was.
 */
function readFileResolution(globalFile) {
	if (globalFile === null) {
		return { style: CARD_STYLE.FLOAT, source: 'default', reason: 'missing_file', globalFile };
	}
	let raw;
	try {
		raw = readFileSync(globalFile, 'utf8');
	} catch (error) {
		const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
		return { style: CARD_STYLE.FLOAT, source: 'default', reason: missing ? 'missing_file' : 'unreadable_file', globalFile };
	}
	const style = parseCardStyleFile(raw);
	if (style === undefined) return { style: CARD_STYLE.FLOAT, source: 'default', reason: 'malformed_file', globalFile };
	return { style, source: 'file', reason: null, globalFile };
}

// The document branch, cached on the path it was read from: a render calls
// `cardStyle()` every frame, and a document read belongs to `session_start`.
let cachedFile;

function fileResolution(globalFile, fresh) {
	if (!fresh && cachedFile !== undefined && cachedFile.globalFile === globalFile) return cachedFile;
	const resolution = readFileResolution(globalFile);
	cachedFile = resolution;
	return resolution;
}

/** The whole decision: the live slot, else the document, else float. */
function resolution(options, fresh) {
	const slot = slotStyle();
	const file = fileResolution(cardStyleFile(options), fresh === true);
	if (slot !== undefined) return { style: slot, source: 'slot', reason: 'slot', slot, globalFile: file.globalFile };
	return { style: file.style, source: file.source, reason: file.reason, slot: undefined, globalFile: file.globalFile };
}

/**
 * Where the style came from and why it fell back — `{style, source, reason,
 * slot, globalFile}`. Always reads the document, so it is the diagnostic form
 * of the decision, never the render path.
 */
function resolveCardStyle(options) {
	return resolution(options, true);
}

/** The style a card must be drawn in: the slot, else the document, else float. Never throws. */
function cardStyle(options) {
	return resolution(options, false).style;
}

/** Drop the cached document branch and answer the decision again (the `session_start` re-read). */
function refreshCardStyle(options) {
	cachedFile = undefined;
	return resolution(options, true);
}

module.exports = {
	CARD_STYLE,
	CARD_STYLE_FILE,
	CARD_STYLE_SCHEMA,
	CARD_STYLE_SLOT,
	cardStyle,
	cardStyleFile,
	cardStyleHome,
	parseCardStyleFile,
	refreshCardStyle,
	resolveCardStyle,
};

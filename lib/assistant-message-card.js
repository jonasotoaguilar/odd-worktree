'use strict';
// The assistant's own answer, drawn as a card on this package's substrate (`lib/shell-card.js`),
// and only while this package's `Card message` switch is On (`lib/card-message.js`).
//
// WHY A DRAWING SHIM, and why it is a SECOND one. The shell API owns tool designs, message designs
// and its rail, and none of them is reached by an assistant message: `AssistantMessageComponent`
// is constructed inside interactive mode, like `UserMessageComponent`. So this card wraps
// `AssistantMessageComponent.prototype.render` through the shim both message cards share
// (`lib/host-render-shim.js`, this card's own `Symbol.for` cell), and the class is handed in from
// the extension's lazy `import()`, so this module imports nothing from Pi and a stub class is
// enough to exercise all of it.
//
// S5/D4 — THE FINAL ANSWER ONLY. The card is drawn only for a component whose own
// `hasToolCalls === false`: a message that made a tool call is an intermediate one, and Pi marks it
// exactly that way (`updateContent` sets `hasToolCalls` from `message.content`). It is a property of
// the component's own message, so it holds for a resumed or old session the same as for a live one.
// The herdr-style "no job or sub-agent pending" filter cannot be derived from a transcript or a
// resumed session, so it is NOT applied: a message that ends a turn while a background sub-agent is
// still running is drawn as final (stated in `docs/reference.md`). The card is native to this
// package: it changes the drawing, and the answer stays Pi's own text.
//
// WHAT IT DRAWS, and what it never touches:
//   * THE HEADING is `✿ Gentleman · 21:53 (17 turns · 58m20s)`: the mark and the FIXED name
//     `Gentleman` (a constant, never read from `/identity`), then the substrate's `SEPARATOR` and
//     the answer's clock, then the parenthesis with the turn count and the elapsed time. Frame and
//     title are painted with the theme role `mdHeading` (`titleRole` and `railRole`), the role this
//     package's `checking` activity uses (`lib/bash-activity.js`). The clock is the component's own
//     `timestamp` when Pi restored the message from a session entry, else the moment of the card's
//     FIRST paint held per component, and with neither the heading is `✿ Gentleman` alone. The
//     parenthesis is drawn only when BOTH the clock and the stats exist: the stats come from the
//     session history through the injected seam, and nothing is invented when it cannot answer.
//   * THE BODY is Pi's OWN rendering of the answer, never a repaint of it. The component is rendered
//     at the frame's INNER width — through the ORIGINAL `render` the shim hands over, not the width
//     the wrapper was handed — so nothing overflows; Pi's OSC 133 zone markers are stripped from the
//     row it put them on; the leading blank row its `Spacer` adds is dropped (the frame is the
//     spacing) and ONE blank row is kept above the frame, so the separation from the previous block
//     is unchanged; and the finished rows are placed with `cardPaintedRows`, which measures and
//     frames them but never repaints them.
//   * THE STYLE is the shell's, read on every paint by `floatRows` (`lib/card-style.js`): `float`
//     and `neon` both follow live, and this module writes no style code at all.
//   * THE ANSWER ZONE stays where Pi put it. `AssistantMessageComponent.render` PREFIXES the
//     zone-start sequence on its first row and the zone-end and final markers on its last (only for
//     a message without tool calls, which is exactly the message this card draws), so the card
//     carries the same three markers the same way on its own first and last row — once each, never
//     appended — and the native path stays byte for byte.
//   * THE GATE is asked INSIDE the patched `render`, on every paint, never cached: this package's
//     own `Card message` switch (`cardMessageOn()`, one synchronous read of its `card-message`
//     document through the shell API's published store), which is what a flip repaints. It fails
//     CLOSED: no published shell API, a store that cannot answer, the switch Off, a component with
//     tool calls or one whose `hasToolCalls` is not a boolean, no row at all, a width too small to
//     draw a frame and a theme or measurement seam that throws all hand the host's own rows
//     back — the very array `render` returned — byte for byte.
//   * THE COST, stated honestly, per PAINT: the gate read always, plus the history seam and the
//     style read only while the card actually draws. Nothing is memoized: the body is Pi's own
//     render, and this component re-renders it every frame anyway.
//
// The wrapper never throws: any error on this side answers the original rows. `uninstall()`
// restores the original `render`, and the extension calls it on `session_shutdown`.

const {
	CARD_TONE,
	cardBottom,
	cardInnerWidth,
	cardPaintedRows,
	cardTopRows,
	floatRows,
} = require('./shell-card.js');
const { cardMessageOn } = require('./card-message.js');
const { themeFor } = require('./file-card.js');
const { createHostRenderShim } = require('./host-render-shim.js');

// The fixed heading of this card (S7): the mark is the substrate's default `✿`, the name is always
// `Gentleman`, and the role is the theme's `mdHeading` — the one `checking` uses — for the title
// and for the whole closed box. The clock and the stats are NOT part of it: they belong to the
// component being drawn, so `cardParts` adds them per paint.
const IDENTITY = Object.freeze({
	title: 'Gentleman',
	tone: CARD_TONE.INFO,
	titleRole: 'mdHeading',
	railRole: 'mdHeading',
});

// Below this the frame's two side rails and the glyph column leave no room for one body row
// (`lib/user-prompt-card.js` states the same floor), so the host's rows come straight back
// instead of a heading painted over nothing.
const MIN_PAINT_WIDTH = 6;

// The members the injected measurement seam must carry (the host TUI helpers this package never
// imports).
const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

// Pi keeps its live theme instance on a process-wide slot (`gentle-timestamps` reads the same
// one), so no theme import is needed and a theme switched mid-session reaches the next frame.
const PI_THEME_SLOT = Symbol.for('@earendil-works/pi-coding-agent:theme');

// This card's own shim cell (`lib/host-render-shim.js`): the assistant class is wrapped ONCE per
// process behind this key, and the user prompt card's cell is never reached from here.
const shim = createHostRenderShim(Symbol.for('gentle-pi.assistant-message-card'));

// The answer zone's own markers, exactly as `AssistantMessageComponent.render` writes them: the zone
// opens on the first row and closes with END followed by FINAL on the last. They are OSC escapes,
// so they occupy no column and no measurement here ever sees them: the card's rows are composed
// first, and the markers are put on the finished first and last row.
const OSC133_ZONE_START = '\x1b]133;A\x07';
const OSC133_ZONE_END = '\x1b]133;B\x07';
const OSC133_ZONE_FINAL = '\x1b]133;C\x07';
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_ZONE_FINAL;

// A host that hands over no theme: the text is drawn plain rather than not at all.
const PLAIN_THEME = { fg: (_role, text) => text };

const ANSI = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07]*\x07/g;
const plainOf = (row) => row.replace(ANSI, '').replace(OSC, '');

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';
const usableMetrics = (value) => (METRICS_FUNCTIONS.every((name) => hasFunction(value, name)) ? value : undefined);

// ---- the seams, read on every paint ----

/** The measurement seam: an object, or a function asked now (the host's TUI may arrive late). */
function readMetrics(seam) {
	try {
		return usableMetrics(typeof seam === 'function' ? seam() : seam);
	} catch {
		return undefined;
	}
}

/**
 * The theme to paint with: the injected seam when there is one, else Pi's live instance from
 * its process-wide slot. A seam that throws or answers nothing usable leaves the plain one.
 */
function readTheme(seam) {
	try {
		if (typeof seam === 'function') return seam();
		if (seam !== undefined) return seam;
		return globalThis[PI_THEME_SLOT];
	} catch {
		return undefined;
	}
}

/** The session history the stats are read from, or `undefined` when the seam cannot answer. */
function readEntries(seam) {
	if (typeof seam !== 'function') return undefined;
	try {
		const entries = seam();
		return Array.isArray(entries) ? entries : undefined;
	} catch {
		return undefined;
	}
}

// ---- S8: the turn stats, from the session history ----

const USER_ROLE = 'user';
const ASSISTANT_ROLE = 'assistant';

/**
 * The role of a message entry, in the two spellings this package's own readers accept
 * (`lib/worktree-warp-sessions.js`): the bare `entry.role` of a normalized entry, and the
 * persisted `entry.message.role`. Anything else answers `undefined`, so a custom entry, a
 * bookkeeping entry or garbage is never counted as a turn.
 */
function roleOf(entry) {
	const value = asObject(entry);
	if (typeof value.role === 'string') return value.role;
	const message = value.message;
	return message !== null && typeof message === 'object' && typeof message.role === 'string'
		? message.role
		: undefined;
}

/** An entry's ISO `timestamp` in milliseconds, or `undefined` when it cannot be read. */
function timeOf(entry) {
	const raw = asObject(entry).timestamp;
	if (typeof raw !== 'string') return undefined;
	const at = Date.parse(raw);
	return Number.isFinite(at) ? at : undefined;
}

/**
 * `turnStats(entries, messageId, nowMs)` — how much work the final answer closes, from the session
 * history itself (S8), or `undefined` when there is nothing to state.
 *
 * `entries` is what `ctx.sessionManager.getEntries()` returns. THE END is the entry whose `id` is
 * `messageId` — the component's own id, set when Pi restored the message from a session entry — and
 * when that id is missing or not found (a LIVE message, not persisted yet) the end is a VIRTUAL
 * entry at `nowMs`, after the last entry, which counts as one assistant turn. THE START is the last
 * `user` message entry strictly BEFORE the end; none means `undefined`, because a turn nobody
 * started is nothing to report.
 *
 * `turns` counts the assistant-role message entries in `(start, end]`, plus the virtual one.
 * `elapsedMs` is the end time minus the start time, never negative, and `undefined` when either
 * timestamp cannot be read (the turn count is still known, the time is not invented).
 */
function turnStats(entries, messageId, nowMs) {
	if (!Array.isArray(entries)) return undefined;
	const endIndex = typeof messageId === 'string' && messageId.length > 0
		? entries.findIndex((entry) => asObject(entry).id === messageId)
		: -1;
	// A live message has no entry yet: its end is a virtual one after the last entry.
	const virtual = endIndex < 0;
	const stop = virtual ? entries.length : endIndex + 1;
	let startIndex = -1;
	for (let index = stop - 1; index >= 0; index -= 1) {
		if (roleOf(entries[index]) === USER_ROLE) {
			startIndex = index;
			break;
		}
	}
	if (startIndex < 0) return undefined;
	let turns = 0;
	for (let index = startIndex + 1; index < stop; index += 1) {
		if (roleOf(entries[index]) === ASSISTANT_ROLE) turns += 1;
	}
	if (virtual) turns += 1;
	const startMs = timeOf(entries[startIndex]);
	const endMs = virtual ? nowMs : timeOf(entries[endIndex]);
	if (startMs === undefined || !Number.isFinite(endMs)) return { turns, elapsedMs: undefined };
	return { turns, elapsedMs: Math.max(0, endMs - startMs) };
}

/** Two digits, zero padded. */
const twoDigits = (value) => String(value).padStart(2, '0');

/**
 * One elapsed time as the heading states it (D6): `42s` under a minute, `58m20s` under an hour,
 * `1h02m20s` from an hour — hours plain, minutes zero padded, seconds plain, nothing rounded up.
 */
function formatDuration(ms) {
	const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	if (hours > 0) return `${hours}h${twoDigits(minutes)}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

/** `1 turn` singular, `N turns` plural. */
const turnLabel = (turns) => `${turns} ${turns === 1 ? 'turn' : 'turns'}`;

// ---- the heading's clock (S7) ----

/** One instant as local 24-hour `HH:MM`: no seconds, no date, no relative wording. */
function clockText(at) {
	const instant = new Date(at);
	return `${twoDigits(instant.getHours())}:${twoDigits(instant.getMinutes())}`;
}

/** The per-component clock memo: the raw source read (`timestamp`, else `undefined`) and its `HH:MM`. */
const clockMemo = new WeakMap();

/**
 * The clock the heading carries for `self`, or `undefined` when there is none to state.
 *
 * The source, in this order (S7): the component's OWN `timestamp` when it is a string — what Pi
 * sets when it rebuilds a message from a session entry, so a resumed or old session shows when the
 * answer was made — then a clock captured ONCE at the component's first paint, so a live answer
 * shows its time too and a later frame never drifts, and with neither nothing: `✿ Gentleman` alone,
 * no time invented (an unparseable `timestamp` is not a clock, and a host clock that answers no
 * number is not one either).
 *
 * The memo is keyed on the SOURCE, so formatting runs once per component (or once per `timestamp`
 * the host sets) and every later paint reads the string it already made.
 */
function headingClock(self) {
	const field = asObject(self).timestamp;
	const source = typeof field === 'string' ? field : undefined;
	const key = self !== null && typeof self === 'object' ? self : undefined;
	const remembered = key === undefined ? undefined : clockMemo.get(key);
	if (remembered !== undefined && remembered.source === source) return remembered.clock;
	let clock;
	if (source !== undefined) {
		const at = Date.parse(source);
		if (Number.isFinite(at)) clock = clockText(at);
	}
	if (clock === undefined) {
		const now = Date.now();
		clock = Number.isFinite(now) ? clockText(now) : undefined;
	}
	if (key !== undefined) clockMemo.set(key, { source, clock });
	return clock;
}

/**
 * The subtitle (S7/S8): the clock, and — only when the history could be read AND its times are —
 * the parenthesis `(N turns · XmYYs)` after it. No clock, no subtitle at all; no stats, the clock
 * alone; nothing invented either way.
 */
function headingSubtitle(self, seams) {
	const clock = headingClock(self);
	if (clock === undefined) return undefined;
	const entries = readEntries(seams.entries);
	if (entries === undefined) return clock;
	const stats = turnStats(entries, asObject(self).messageId, Date.now());
	if (stats === undefined || !Number.isFinite(stats.elapsedMs)) return clock;
	return `${clock} (${turnLabel(stats.turns)} · ${formatDuration(stats.elapsedMs)})`;
}

// ---- the body: Pi's own rows, never repainted ----

/**
 * One row with the OSC 133 markers Pi prefixed on it removed. Only the three markers of this
 * component's own zone are consumed, from the front, and a row that carried none comes back
 * exactly as it went in.
 */
function stripZoneMarkers(row) {
	let out = row;
	for (;;) {
		const marker = [OSC133_ZONE_START, OSC133_ZONE_END, OSC133_ZONE_FINAL].find((candidate) => out.startsWith(candidate));
		if (marker === undefined) return out;
		out = out.slice(marker.length);
	}
}

/** One row as its visible text: the escapes it carries are not characters. */
const isBlankRow = (row) => plainOf(row).trim() === '';

/**
 * The rows of the answer as the card's body, or `undefined` when there is no body to draw: the
 * component is rendered at the frame's INNER width through the ORIGINAL `render`, Pi's zone markers
 * leave the rows it put them on, and the leading blank row its `Spacer` adds is dropped (the frame
 * brings its own spacing). A renderer that throws, answers no row, or answers something that is not
 * rows is no body at all.
 */
function answerRows(self, original, inner) {
	let drawn;
	try {
		drawn = original.call(self, cardInnerWidth(inner));
	} catch {
		return undefined;
	}
	if (!Array.isArray(drawn) || drawn.length === 0) return undefined;
	const rows = drawn.filter((row) => typeof row === 'string');
	if (rows.length === 0) return undefined;
	const unmared = rows.map((row, index) => (index === 0 || index === rows.length - 1 ? stripZoneMarkers(row) : row));
	const body = unmared.length > 0 && isBlankRow(unmared[0]) ? unmared.slice(1) : unmared;	return body.length > 0 ? body : undefined;
}

/**
 * One component's card parts for one draw — `{ head, body, bottom }`, the shape `floatRows`
 * renders — or `undefined` when the body draws no row at all.
 */
function cardParts(self, original, inner, paint, metrics, seams) {
	const rows = answerRows(self, original, inner);
	if (rows === undefined) return undefined;
	const subtitle = headingSubtitle(self, seams);
	const card = subtitle === undefined ? IDENTITY : { ...IDENTITY, subtitle };
	return {
		head: cardTopRows(card, paint, inner, undefined, metrics),
		// The body is never clipped: an answer is not a preview, so every row is drawn.
		body: cardPaintedRows(rows, IDENTITY.tone, paint, inner, { expanded: true }, metrics),
		// No content rides the closing rule: the answer's clock and stats belong to the heading.
		bottom: cardBottom(IDENTITY.tone, paint, inner, undefined, metrics),
	};
}

/**
 * The card's rows with Pi's zone markers, written exactly as `AssistantMessageComponent.render`
 * writes them (`first = START + first`, `last = END + FINAL + last`, one row above the frame keeps
 * the separation the component's own blank row gave). A row list that already carries the markers
 * is handed back untouched, so a second pass can never write a second copy, and an empty list stays
 * empty. The markers are zero-width escapes added to rows that are already composed, so no width
 * and no measurement changes.
 */
function zoneRows(rows) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;
	if (rows[0].startsWith(OSC133_ZONE_START) || rows.at(-1).startsWith(OSC133_ZONE_CLOSE)) return rows;
	const zoned = [...rows];
	zoned[0] = OSC133_ZONE_START + zoned[0];
	zoned[zoned.length - 1] = OSC133_ZONE_CLOSE + zoned[zoned.length - 1];
	return zoned;
}

/**
 * The rows one paint answers: the host's own rows for every answer but a final one, the card for it.
 * `rows` is exactly what the original `render` returned, so every refusal is byte for byte (S5).
 */
function paintAnswer(self, rows, width, seams, original) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;
	// S5/D4: only a message without tool calls is a FINAL answer. A component of any other shape —
	// no boolean `hasToolCalls` at all — is answered natively, and whether the message is persisted
	// or live makes no difference: the filter is a property of the message itself.
	if (asObject(self).hasToolCalls !== false) return rows;
	if (typeof original !== 'function') return rows;
	if (!cardMessageOn()) return rows;
	const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
	if (target < MIN_PAINT_WIDTH) return rows;
	const metrics = readMetrics(seams.metrics);
	if (metrics === undefined) return rows;
	// The theme is read before the body: a theme switched while the answer is on screen paints
	// the next frame with the new one.
	const paint = themeFor(readTheme(seams.theme), PLAIN_THEME);
	try {
		const drawn = floatRows(IDENTITY.tone, paint, target, (inner) => {
			const parts = cardParts(self, original, inner, paint, metrics, seams);
			// A body that draws nothing is no card: the host's own rows are the honest answer,
			// and the throw below is how that leaves `floatRows` untouched.
			if (parts === undefined) throw new TypeError('the answer drew no row');
			return parts;
		}, IDENTITY.railRole);
		if (!Array.isArray(drawn) || drawn.length === 0) return rows;
		// The one blank row above the frame: Pi's own `Spacer` row kept the separation from the
		// previous block, and that row is not part of the card's body.
		return zoneRows(['', ...drawn]);
	} catch {
		return rows;
	}
}

/**
 * `installAssistantMessageCard({ component, metrics, theme, entries })` — wrap the class's `render`
 * once per process and answer through the seams given now. `entries` is the session-history seam:
 * the extension fills it from the CURRENT session's `ctx.sessionManager.getEntries()`, and an
 * absent, throwing or non-array answer is "no stats" and never an error.
 */
function installAssistantMessageCard(options) {
	const opts = asObject(options);
	const seams = { metrics: opts.metrics, theme: opts.theme, entries: opts.entries };
	return shim.install(opts.component, (self, rows, width, original) => paintAnswer(self, rows, width, seams, original));
}

/** Restore every prototype this card wrapped, byte for byte, and forget the live logic. */
const uninstallAssistantMessageCard = () => shim.uninstall();

module.exports = {
	IDENTITY,
	formatDuration,
	installAssistantMessageCard,
	paintAnswer,
	turnStats,
	uninstallAssistantMessageCard,
};

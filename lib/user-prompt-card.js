'use strict';
// The user's own prompt, drawn as a card on this package's substrate
// (`lib/shell-card.js`), and only while the bridge's `Card activity` line answers this
// package's `activity` design.
//
// The bridge has no surface for a user prompt: it owns tool designs, message designs and
// its rail, and none of them is reached by a prompt. So this card is a PROTOTYPE SHIM —
// `UserMessageComponent.prototype.render` is wrapped once per process — and the class is
// handed in by the caller (`extensions/odd-worktree-tools.ts` resolves it with the same
// lazy dynamic `import()` every other host package here uses). This module imports nothing
// from Pi, so a stub class is enough to exercise all of it.
//
// WHAT IT DRAWS, and what it never touches:
//   * THE HEADING is `✿ You`, tone `info`, with the theme's `accent` role for the name AND
//     for the whole closed box (`railRole`) — corners, lead, rule, sides, rail and bottom.
//     That one role around the entire frame is what tells this card apart from the tool
//     cards, which paint their tone; no glyph override, no subtitle and no timestamp are
//     added (the `✿` is the substrate's default mark, and `gentle-timestamps` owns time).
//   * THE BODY is Pi's own rendering of the prompt. The component's Markdown child is
//     rebuilt from its OWN constructor with the user message background dropped
//     (`bgColor: undefined`), no side padding (the frame is the padding) and the host's own
//     `options`, so `preserveOrderedListMarkers`, `preserveBackslashEscapes` and every
//     extension markdown transformer keep working. Its rows arrive ALREADY PAINTED, so they
//     are placed with `cardPaintedRows` — never `cardBodyRows`, which paints a role over
//     them and would destroy the ANSI. The text colour stays exactly what the body's own
//     paint says.
//   * THE STYLE is the shell's, read on every paint by `floatRows` (`lib/card-style.js`):
//     `float` and `neon` both follow live, and this module writes no style code at all.
//   * THE PROMPT ZONE stays where Pi put it. `UserMessageComponent.render` PREFIXES its first
//     row with the OSC 133 zone-start sequence and PREFIXES its last row with the zone-end
//     marker followed by the final one (`last = OSC133_ZONE_END + OSC133_ZONE_FINAL + last`),
//     so the terminal knows where a prompt begins and ends (click-to-jump and shell integration
//     follow those markers). A card that replaces those rows carries the SAME markers in the
//     same order and position on its own first and last row — once each, never twice, and never
//     on the native path, which stays byte for byte.
//   * THE GATE is asked INSIDE the patched `render`, on every paint, never cached: the
//     bridge's published reader (the `Symbol.for("gentle-shell-bridge/api/v1")` slot after
//     its schema and version gate) must answer `{ kind: "design", design: { id:
//     <this package's activity design> } }` for `bash`, the line every other card asks.
//     UNLIKE the file cards, this one fails CLOSED: an absent bridge, an absent reader, a
//     reader that throws, any other answer and a width too small to draw a frame all hand
//     the host's own rows back — the very array `render` returned — byte for byte (S6).
//   * THE COST, stated honestly: TWO LIVE READS PER PAINT. The gate asks the bridge once per
//     prompt per paint (its reader queries the selection store on every call) — that read is
//     what makes the flip live, so it is never cached — and `floatRows` asks the shell's style
//     once per paint through `lib/card-style.js`, which is the live slot Gentle Shell writes or,
//     when nothing is published there, `<home>/card-style.json` read on every render. Both are
//     deliberate. The memo below covers only the DRAWING (the Markdown rows and the composed
//     frame parts), keyed on width, paint and rendered rows, so a steady frame recomposes
//     nothing.
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
const { ACTIVITY_DESIGN_ID, bridgeApi } = require('./file-card-resolver.js');
const { themeFor } = require('./file-card.js');

// The one heading this card wears: the mark is the substrate's default `✿`, the name is the
// person, and the role is the accent for the name and for the whole closed box. No subtitle
// (there is one fact: the prompt) and no timestamp (`gentle-timestamps` owns the clock).
const IDENTITY = Object.freeze({
	title: 'You',
	tone: CARD_TONE.INFO,
	titleRole: 'accent',
	railRole: 'accent',
});

// Below this the frame's two side rails and the glyph column leave no room for one body row
// (`lib/message-card.js` states the same floor), so the host's rows come straight back
// instead of a heading painted over nothing.
const MIN_PAINT_WIDTH = 6;

// The line every card of this package asks the bridge about, and the members the injected
// measurement seam must carry (the host TUI helpers this package never imports).
const BRIDGE_TOOL = 'bash';
const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

// Pi keeps its live theme instance on a process-wide slot (`gentle-timestamps` reads the same
// one), so no theme import is needed and a theme switched mid-session reaches the next frame.
const PI_THEME_SLOT = Symbol.for('@earendil-works/pi-coding-agent:theme');

// The process-wide shim state: the prototypes this package has wrapped with their ORIGINAL
// `render`, the one wrapper, and the logic the most recently evaluated module installed. It
// lives on `globalThis` behind a `Symbol.for` key so `/reload` reuses the same cell: the
// wrapper installed by the first evaluation keeps calling the newest logic.
const STATE_KEY = Symbol.for('gentle-pi.user-prompt-card');

// The prompt zone's own markers, exactly as `UserMessageComponent.render` writes them
// (`dist/modes/interactive/components/user-message.js`): the zone opens on the first row and
// closes with END followed by FINAL on the last. They are OSC escapes, so they occupy no
// column and no measurement here ever sees them: the card's rows are composed first, and the
// markers are put on the finished first and last row.
const OSC133_ZONE_START = '\x1b]133;A\x07';
const OSC133_ZONE_END = '\x1b]133;B\x07';
const OSC133_ZONE_FINAL = '\x1b]133;C\x07';
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_ZONE_FINAL;

// A host that hands over no theme: the text is drawn plain rather than not at all.
const PLAIN_THEME = { fg: (_role, text) => text };

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';
const usableMetrics = (value) => (METRICS_FUNCTIONS.every((name) => hasFunction(value, name)) ? value : undefined);

// ---- the one switch (S1/S2/S6) ----

/**
 * Whether the activity design draws the `bash` line right now, asked per paint and never
 * cached. STRICT and FAIL-CLOSED: only `{ kind: "design", design: { id: <ours> } }` paints,
 * and a bridge that cannot answer at all is a no — an unavailable gate never changes a row.
 */
function activitySelected() {
	try {
		const api = bridgeApi();
		if (api === undefined || typeof api.resolveToolDesignSelection !== 'function') return false;
		const answer = asObject(api.resolveToolDesignSelection(BRIDGE_TOOL));
		return answer.kind === 'design' && asObject(answer.design).id === ACTIVITY_DESIGN_ID;
	} catch {
		return false;
	}
}

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

// ---- the body: Pi's own Markdown, rebuilt without the user message background (S5) ----

/**
 * The child's own Markdown as a clone with no background and no padding at all, or `undefined`
 * when the shape is not Pi's Markdown — a missing child, a non-numeric `paddingX`, no theme,
 * or a constructor that is not a function. Every mismatch means "answer native", never a
 * guess.
 *
 * NO PADDING: the frame is the padding. Pi builds the user prompt's Markdown with
 * `paddingX: outputPad, paddingY: 1` and its renderer pays for both with blank rows — the
 * terminal charges every row — so the clone is built with `0` for both, exactly as the
 * substrate's other Markdown body is (`lib/file-card-markdown.js` builds its document renderer
 * with `new Renderer(source, 0, 0, …)`). What a prompt costs is the frame plus its own lines.
 * The child's own `paddingY` stays part of what the memo remembers about the CHILD, so a host
 * that changes it still rebuilds the clone.
 *
 * `paint` is the theme THIS paint uses, and it is part of the memo: Pi's `Markdown` caches its
 * painted lines on (text, width) alone and the host invalidates only its OWN components, so a
 * clone kept across a theme switch would keep painting the old colours while a freshly built
 * prompt already wears the new ones. When the theme changed, the clone is REBUILT (a new
 * instance starts with an empty cache) from the child's own live MarkdownTheme.
 */
function promptMarkdown(child, paint) {
	if (child === null || typeof child !== 'object') return undefined;
	if (typeof child.paddingX !== 'number' || !Number.isFinite(child.paddingX)) return undefined;
	if (child.theme === undefined || child.theme === null) return undefined;
	const Constructor = child.constructor;
	if (typeof Constructor !== 'function' || Constructor === Object) return undefined;
	const remembered = cloneMemo.get(child);
	if (
		remembered !== undefined
		&& remembered.paint === paint
		&& remembered.Constructor === Constructor
		&& remembered.text === child.text
		&& remembered.paddingX === child.paddingX
		&& remembered.paddingY === child.paddingY
		&& remembered.theme === child.theme
		&& remembered.options === child.options
		&& sameStyle(remembered.defaultTextStyle, child.defaultTextStyle)
	) return remembered.clone;
	let clone;
	try {
		clone = new Constructor(
			child.text,
			// `paddingX` and `paddingY` are the frame's job now: the card adds its own columns,
			// and its own blank rows where the style wants them.
			0,
			0,
			child.theme,
			{ ...asObject(child.defaultTextStyle), bgColor: undefined },
			child.options,
		);
	} catch {
		return undefined;
	}
	cloneMemo.set(child, {
		paint,
		Constructor,
		clone,
		text: child.text,
		paddingX: child.paddingX,
		paddingY: child.paddingY,
		theme: child.theme,
		options: child.options,
		defaultTextStyle: child.defaultTextStyle,
	});
	return clone;
}

/** The two text styles state the same colour and the same attributes, background aside. */
function sameStyle(a, b) {
	const left = asObject(a);
	const right = asObject(b);
	for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
		if (key === 'bgColor') continue;
		if (left[key] !== right[key]) return false;
	}
	return true;
}

/** The clone of one component's Markdown child for this paint, or `undefined` when it is not that shape. */
function componentMarkdown(self, paint) {
	try {
		const children = asObject(self).children;
		return promptMarkdown(Array.isArray(children) ? children[0] : undefined, paint);
	} catch {
		return undefined;
	}
}

/** The rows the Markdown draws for `width`, already painted, or `undefined` when it draws none. */
function renderedRows(markdown, width) {
	try {
		const drawn = markdown.render(width);
		if (!Array.isArray(drawn)) return undefined;
		const rows = drawn.filter((row) => typeof row === 'string');
		return rows.length > 0 ? rows : undefined;
	} catch {
		return undefined;
	}
}

const sameRows = (a, b) => a === b || (a.length === b.length && a.every((row, index) => row === b[index]));

// ---- the card rows, memoized per component ----

/** The per-component clone memo (keyed on the host's Markdown child: no leak). */
const cloneMemo = new WeakMap();
/** The per-component card memo: (requested width, drawn width, paint, rendered rows) in, parts out. */
const cardMemo = new WeakMap();

/**
 * One component's card parts for one draw — `{ head, body, bottom }`, the shape `floatRows`
 * renders — or `undefined` when the body draws no row at all.
 *
 * WHAT THE MEMO IS KEYED ON, and why the requested width is in it: `inner` alone does not
 * decide a row. `float` gives two columns to its margins, so float at 62 and neon at 60 both
 * compose at inner 60 — with DIFFERENT chrome (`▎` rails against the rounded outline). The
 * chrome in force is decided by the requested width and the style `floatRows` resolved for it
 * (`floatOpener(theme, tone, target)`), so `target` and `inner` are both keyed: a style at the
 * same inner width therefore always recomposes. The paint is keyed because the roles are the
 * theme's, and the rendered rows because the body is Pi's own Markdown. A steady frame only
 * compares the fields and hands the same parts back. No file, no child process and no store is
 * read here: the one live read of a paint is the gate, above.
 */
function cardParts(self, markdown, target, inner, paint, metrics) {
	const width = cardInnerWidth(inner);
	const rows = renderedRows(markdown, width);
	if (rows === undefined) return undefined;
	const remembered = cardMemo.get(self);
	if (
		remembered !== undefined
		&& remembered.markdown === markdown
		&& remembered.target === target
		&& remembered.inner === inner
		&& remembered.paint === paint
		&& sameRows(remembered.rows, rows)
	) return remembered.parts;
	const card = { ...IDENTITY };
	const parts = {
		head: cardTopRows(card, paint, inner, undefined, metrics),
		// The body is never clipped: a prompt is not a preview, so every row is drawn.
		body: cardPaintedRows(rows, IDENTITY.tone, paint, inner, { expanded: true }, metrics),
		// No content rides the closing rule: the time belongs to `gentle-timestamps`.
		bottom: cardBottom(IDENTITY.tone, paint, inner, undefined, metrics),
	};
	cardMemo.set(self, { markdown, target, inner, paint, rows, parts });
	return parts;
}

/**
 * The card's rows with Pi's prompt-zone markers, written exactly as `user-message.js` writes
 * them: `first = START + first`, then `last = END + FINAL + last` — the close pair PREFIXED on
 * the last row, in that order, never appended after it. A row list that already carries them is
 * handed back untouched, so a second pass (a stacked wrapper, a repaint) can never write a
 * second copy, and an empty list stays empty. The markers are zero-width escapes and are added
 * to rows that are already composed, so no width and no measurement changes.
 */
function zoneRows(rows) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;
	if (rows[0].startsWith(OSC133_ZONE_START) || rows.at(-1).startsWith(OSC133_ZONE_CLOSE)) return rows;
	const zoned = [...rows];
	// Applied in Pi's own order, so a one-row list ends up `END + FINAL + START + row` exactly
	// as Pi's sequential writes produce it.
	zoned[0] = OSC133_ZONE_START + zoned[0];
	zoned[zoned.length - 1] = OSC133_ZONE_CLOSE + zoned[zoned.length - 1];
	return zoned;
}

/**
 * The rows one paint answers: the host's own rows for every answer but the activity design,
 * the card for it. `rows` is exactly what the original `render` returned, so every refusal is
 * byte for byte (S6).
 */
function paintPrompt(self, rows, width, seams) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;
	if (!activitySelected()) return rows;
	const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
	if (target < MIN_PAINT_WIDTH) return rows;
	const metrics = readMetrics(seams.metrics);
	if (metrics === undefined) return rows;
	// The theme is read BEFORE the body: the clone is keyed on it, so a theme switched while the
	// prompt is on screen repaints the body instead of serving the clone it was built under.
	const paint = themeFor(readTheme(seams.theme), PLAIN_THEME);
	const markdown = componentMarkdown(self, paint);
	if (markdown === undefined) return rows;
	try {
		const drawn = floatRows(IDENTITY.tone, paint, target, (inner) => {
			const parts = cardParts(self, markdown, target, inner, paint, metrics);
			// A body that draws nothing is no card: the host's own rows are the honest answer,
			// and the throw below is how that leaves `floatRows` untouched.
			if (parts === undefined) throw new TypeError('the user prompt drew no row');
			return parts;
		}, IDENTITY.railRole);
		// The one thing added AFTER the frame is composed: the prompt zone Pi marks on the rows
		// this card replaces. Zero width, once each, and part of no memo key — they cannot change
		// between paints, so a steady frame still recomposes nothing.
		return zoneRows(drawn);
	} catch {
		return rows;
	}
}

// ---- the prototype shim (S5) ----

/** The shim state, read without creating it. */
function readState() {
	try {
		const state = globalThis[STATE_KEY];
		return state !== null && typeof state === 'object' ? state : undefined;
	} catch {
		return undefined;
	}
}

/** The shim state, created when it is absent, always with the list of wrapped prototypes. */
function stateSlot() {
	const existing = readState();
	if (existing !== undefined) {
		if (!Array.isArray(existing.patched)) existing.patched = [];
		return existing;
	}
	const state = { patched: [] };
	globalThis[STATE_KEY] = state;
	return state;
}

/** The original `render` of the nearest wrapped prototype, so the wrapper always calls the host's own. */
function originalFor(state, self) {
	if (self === null || self === undefined) return undefined;
	let proto = Object.getPrototypeOf(self);
	while (proto !== null && proto !== undefined) {
		const entry = state.patched.find((kept) => kept.proto === proto);
		if (entry !== undefined) return entry.original;
		proto = Object.getPrototypeOf(proto);
	}
	return undefined;
}

/**
 * The one wrapper this process ever installs. It closes over the state OBJECT, not over one
 * evaluation's module scope, so a `/reload` that leaves the state in place still reaches the
 * logic the newest evaluation installed.
 */
function wrapperFor(state) {
	return function render(width) {
		const original = originalFor(state, this);
		// Unreachable for a wrapped prototype; answering no rows beats throwing at the host.
		if (typeof original !== 'function') return [];
		const rows = original.call(this, width);
		const logic = state.logic;
		if (typeof logic !== 'function') return rows;
		try {
			return logic(this, rows, width);
		} catch {
			// A card must never cost the person their prompt (S6).
			return rows;
		}
	};
}

/**
 * `installUserPromptCard({ component, metrics, theme })` — wrap the class's `render` once per
 * process and answer through the seams given now.
 *
 * Idempotent by construction: a prototype this package already wraps is not wrapped again, so
 * `/reload`, a second session and a second evaluation add no second layer, and only the LIVE
 * logic is replaced. A class that cannot draw (no prototype, no `render`) installs nothing and
 * answers `{ installed: false }`.
 */
function installUserPromptCard(options) {
	const opts = asObject(options);
	const component = opts.component;
	const proto = typeof component === 'function' ? component.prototype : undefined;
	if (proto === null || typeof proto !== 'object' || typeof proto.render !== 'function') {
		return { installed: false, uninstall: uninstallUserPromptCard };
	}
	const seams = { metrics: opts.metrics, theme: opts.theme };
	const state = stateSlot();
	if (typeof state.wrapper !== 'function') state.wrapper = wrapperFor(state);
	if (!state.patched.some((kept) => kept.proto === proto)) {
		state.patched.push({ proto, original: proto.render });
		proto.render = state.wrapper;
	}
	// The most recently evaluated logic is the one every wrapper calls, from now on.
	state.logic = (self, rows, width) => paintPrompt(self, rows, width, seams);
	return { installed: true, uninstall: uninstallUserPromptCard };
}

/**
 * Restore every prototype this package wrapped, byte for byte, and forget the live logic. The
 * state object stays on its slot so the same wrapper object can be reused by the next install;
 * a prototype another plugin has re-wrapped in the meantime is left alone.
 */
function uninstallUserPromptCard() {
	const state = readState();
	if (state === undefined) return false;
	const patched = Array.isArray(state.patched) ? state.patched : [];
	for (const entry of patched) {
		try {
			if (entry.proto.render === state.wrapper) entry.proto.render = entry.original;
		} catch {
			// A frozen prototype keeps the wrapper; nothing else of the install survives it.
		}
	}
	state.patched = [];
	state.logic = undefined;
	return true;
}

module.exports = {
	IDENTITY,
	MIN_PAINT_WIDTH,
	activitySelected,
	installUserPromptCard,
	paintPrompt,
	promptMarkdown,
	uninstallUserPromptCard,
};

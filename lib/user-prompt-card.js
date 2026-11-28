'use strict';
// The user's own prompt, drawn as a card on this package's substrate
// (`lib/shell-card.js`), and only while this package's `Card message` switch is On
// (`lib/card-message.js`). That switch is its own line on the shell API's `Cards` page, so this card
// no longer follows `Card activity`: `Card activity` keeps the file cards, the jobs card, the
// CodeGraph card and the two message cards (D3).
//
// The shell API has no surface for a user prompt: it owns tool designs, message designs and
// its rail, and none of them is reached by a prompt. So this card is a PROTOTYPE SHIM —
// `UserMessageComponent.prototype.render` is wrapped once per process — and the class is
// handed in by the caller (`extensions/odd-worktree-tools.ts` resolves it with the same
// lazy dynamic `import()` every other host package here uses). This module imports nothing
// from Pi, so a stub class is enough to exercise all of it.
//
// WHAT IT DRAWS, and what it never touches:
//   * THE HEADING is `✿ Jona · 14:32`: the mark and the name in the theme's `accent` role (the
//     card's `titleRole`), then the substrate's `SEPARATOR` and the prompt's clock in `muted`
//     (the subtitle path `lib/shell-card.js` already has, `SUBTITLE_ROLE`). THE NAME IS THE USER'S
//     OWN — the `identity` document `lib/user-identity.js` reads from the shell API's store — and it
//     falls back to `You` when nothing usable is stored (S1/S2 of identity-command): it is read on
//     every paint, so a name set or cleared while the transcript is on screen repaints the prompts
//     already there, and no invalidation call exists. The clock is the
//     host's own `timestamp` when it set one, else the moment of the card's FIRST paint, held
//     per component so a live prompt does not drift frame by frame; with neither, the heading is
//     `✿ Jona` alone and nothing is invented. The whole closed box still wears the `accent` role
//     (`railRole`) — corners, lead, rule, sides, rail and bottom. That one role around the entire
//     frame is what tells this card apart from the tool cards, which paint their tone.
//     No glyph override is made (the `✿` is the substrate's default mark).
//   * THE BODY is Pi's own rendering of the prompt. The component's Markdown child is
//     rebuilt from its OWN constructor with the user message background dropped
//     (`bgColor: undefined`), no side padding (the frame is the padding) and the host's own
//     `options`, so `preserveOrderedListMarkers`, `preserveBackslashEscapes` and every
//     extension markdown transformer keep working. THE ONE EXCEPTION is the prompt mark an
//     extension transformer prepends to a user message (pi-pretty's ` ❯ ${markdown}`): the
//     clone's `transform` wraps the host's own and drops exactly ONE leading `" ❯ "` from its
//     answer (`undecoratedOptions`), so the body re-wraps at the frame's full inner width
//     instead of carrying a mark nothing indents the lines under — and a person who typed `❯`
//     themselves keeps their own character, because that run arrives after the decoration. The
//     component's own `text` is never rewritten, and a prompt no transformer decorated is drawn
//     byte for byte as before. Its rows arrive ALREADY PAINTED, so they
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
//   * THE GATE is asked INSIDE the patched `render`, on every paint, never cached: this package's
//     own `Card message` switch (`cardMessageOn()`, one synchronous read of its `card-message`
//     document through the shell API's published store), which is what a flip repaints. UNLIKE the
//     file cards, this one fails CLOSED: no published shell API, a store that cannot answer, the
//     switch Off and a width too small to draw a frame all hand the host's own rows back — the
//     very array `render` returned — byte for byte (S6).
//   * THE COST, stated honestly, per PAINT: ONE GATE READ ALWAYS, PLUS ONE STORE READ AND ONE STYLE
//     READ ONLY WHILE THE CARD ACTUALLY DRAWS. The gate asks `cardMessageOn()` on every paint — it
//     reads the `card-message` document through the published store on every call, and that read is
//     what makes the flip live, so it is never cached. A switch that is Off, or a shell API that
//     cannot answer, returns BEFORE anything else is read, so a native frame pays the gate read
//     alone; a frame that does draw then pays the `identity` document read (`lib/user-identity.js`,
//     one synchronous `get` through the same published store) and one more live read, `floatRows`
//     asking the shell's style through `lib/card-style.js` (the live slot Gentle Shell writes, or
//     `<home>/card-style.json` when nothing is published there). All are deliberate. The memo below
//     covers only the DRAWING (the Markdown rows and the composed frame parts), keyed on width,
//     paint, the name and the rendered rows, so a steady frame recomposes nothing while a changed
//     name still does.
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
// The prototype shim two cards share (`lib/host-render-shim.js`): this card owns the state cell
// behind its own `Symbol.for` key, so the assistant card wraps its class independently.
const { createHostRenderShim } = require('./host-render-shim.js');
// The user's own name, read from the shell API's store on every paint (identity-command S2): the
// heading is the person, so a name set or cleared mid-session repaints instead of being cached.
const { currentIdentityName } = require('./user-identity.js');

// The one heading this card wears when no name is stored: the mark is the substrate's default `✿`,
// the name is the person (`IDENTITY.title` is the fallback, the stored name replaces it), and the
// role is the accent for the name and for the whole closed box. The clock is NOT part of it — it
// belongs to the component being drawn, so `cardParts` adds it per paint (S1).
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

// The members the injected measurement seam must carry (the host TUI helpers this package never
// imports).
const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

// Pi keeps its live theme instance on a process-wide slot (`gentle-timestamps` reads the same
// one), so no theme import is needed and a theme switched mid-session reaches the next frame.
const PI_THEME_SLOT = Symbol.for('@earendil-works/pi-coding-agent:theme');

// The process-wide shim state (`lib/host-render-shim.js`): the prototypes this card wrapped with
// their ORIGINAL `render`, the one wrapper, and the logic the most recently evaluated module
// installed. It lives on `globalThis` behind THIS card's own `Symbol.for` key, so `/reload` reuses
// the same cell — the wrapper installed by the first evaluation keeps calling the newest logic —
// and the assistant card's cell is never reached from here.
const shim = createHostRenderShim(Symbol.for('gentle-pi.user-prompt-card'));

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
//
// `cardMessageOn()` is the whole gate (`lib/card-message.js`): this package's own `Card message`
// line, read per paint and never cached, so a flip repaints the prompts already on screen. It fails
// CLOSED — no published shell API, an unreadable store and Off all read as no — because a prompt is
// the host's own text and a guess would restyle a message nobody asked to restyle.

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

// The prompt mark an extension markdown transformer prepends to a user message — pi-pretty's
// ` ❯ ${markdown}` (`@heyhuynhgiabuu/pi-pretty`): one leading space, the mark, and the space after
// it. It is a decoration of the WHOLE message, not of its first line, and nothing indents the
// lines under it, so a wrapped prompt reads flush left below a marked first row. This card drops
// it (the user's decision: "Sacar el ❯ del mensaje").
const PROMPT_MARK = ' ❯ ';

/**
 * The host Markdown `options` the card's clone is built with: the host's own object, untouched,
 * when it carries no `transform`; otherwise a shallow copy whose `transform` is the host's own
 * composed transform with ONE leading prompt mark removed from its answer.
 *
 * WHY A WRAPPER AND NOT TEXT SURGERY: the mark lives in the TRANSFORM's output, not in the
 * component's `text` (`user-message.js` builds the Markdown with `transform:
 * createMarkdownTransform("user", …)`, which is where every `registerMarkdownTransformer`
 * lands), so the clone is the one place the host's text arrives before it is parsed and wrapped.
 * Calling the host transform first and dropping the mark from what it returns keeps every other
 * transformer, every markdown construct and the clone's own re-wrap at the full inner width
 * intact: no ANSI is rewritten and no row is measured twice.
 *
 * ONLY THE DECORATION IS CONSUMED: the extension prepends its mark to the user's own markdown, so
 * the decoration is always the OUTERMOST prefix and a person who typed `❯` themselves keeps
 * their own character — their run arrives AFTER the decoration, and at most one leading run is
 * ever dropped. A prompt the transform did not decorate is handed back exactly as it came, so a
 * host with no transformer (or one that adds no mark) draws the same rows it always did.
 */
function undecoratedOptions(options) {
	if (typeof asObject(options).transform !== 'function') return options;
	const transform = options.transform;
	return {
		...options,
		transform: (text, availableWidth) => {
			const transformed = transform(text, availableWidth);
			if (typeof transformed !== 'string' || !transformed.startsWith(PROMPT_MARK)) return transformed;
			return transformed.slice(PROMPT_MARK.length);
		},
	};
}

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
			undecoratedOptions(child.options),
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
/** The per-component clock memo: the raw source read (`timestamp`, else `undefined`) and its `HH:MM`. */
const clockMemo = new WeakMap();

// ---- the heading's clock (S1) ----

/** Two digits, zero padded: the clock's only formatting rule. */
const twoDigits = (value) => String(value).padStart(2, '0');

/** One instant as local 24-hour `HH:MM`: no seconds, no date, no relative wording. */
function clockText(at) {
	const instant = new Date(at);
	return `${twoDigits(instant.getHours())}:${twoDigits(instant.getMinutes())}`;
}

/**
 * The clock the heading carries for `self`, or `undefined` when there is none to state.
 *
 * The source, in this order (S1):
 *   1. the component's OWN `timestamp` when it is a string — what Pi sets when it rebuilds a
 *      prompt from a session entry, so a restored transcript shows when the prompt was sent;
 *   2. otherwise a clock captured ONCE, at the component's first paint, so a prompt sent live
 *      shows its arrival time too and a later frame never drifts;
 *   3. with neither, nothing: the heading keeps `✿ You` and no time is invented (an unparseable
 *      `timestamp` is not a clock, and a host clock that answers no number is not one either).
 *
 * The memo is keyed on the SOURCE, so the formatting runs once per component (or once per
 * `timestamp` the host sets) and every later paint reads the string it already made — a steady
 * frame formats nothing here, and the only per-paint reads a card pays are the gate's, the stored
 * name's (`paintPrompt`) and the style's.
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
 * One component's card parts for one draw — `{ head, body, bottom }`, the shape `floatRows`
 * renders — or `undefined` when the body draws no row at all.
 *
 * WHAT THE MEMO IS KEYED ON, and why the requested width is in it: `inner` alone does not
 * decide a row. `float` gives two columns to its margins, so float at 62 and neon at 60 both
 * compose at inner 60 — with DIFFERENT chrome (`▎` rails against the rounded outline). The
 * chrome in force is decided by the requested width and the style `floatRows` resolved for it
 * (`floatOpener(theme, tone, target)`), so `target` and `inner` are both keyed: a style at the
 * same inner width therefore always recomposes. The paint is keyed because the roles are the
 * theme's, `name` because the heading IS the person — `You` is only the fallback, so a name set
 * or cleared under a transcript has to recompose the head already on screen — and the rendered
 * rows because the body is Pi's own Markdown. A steady frame only compares the fields and hands
 * the same parts back. NOTHING IS READ IN HERE: the name arrives already read ONCE by
 * `paintPrompt`, so a card paint pays that one document read once and not once per `inner`.
 */
function cardParts(self, markdown, target, inner, paint, metrics, name) {
	const width = cardInnerWidth(inner);
	const rows = renderedRows(markdown, width);
	if (rows === undefined) return undefined;
	// The clock is part of the memo key ONLY as the string it formats to: it cannot change between
	// paints except through the component's own `timestamp` or the theme, and a steady frame pays
	// one memo read rather than a second format.
	const clock = headingClock(self);
	const remembered = cardMemo.get(self);
	if (
		remembered !== undefined
		&& remembered.markdown === markdown
		&& remembered.target === target
		&& remembered.inner === inner
		&& remembered.paint === paint
		&& remembered.clock === clock
		&& remembered.name === name
		&& sameRows(remembered.rows, rows)
	) return remembered.parts;
	// The clock rides the substrate's subtitle path: the heading states `✿ Jona` — the stored name,
	// or `You` when nothing usable is stored — then the separator and the clock in `muted`
	// (`SUBTITLE_ROLE`). No clock, no subtitle at all.
	const title = name === undefined || name === null ? IDENTITY.title : name;
	const card = clock === undefined ? { ...IDENTITY, title } : { ...IDENTITY, title, subtitle: clock };
	const parts = {
		head: cardTopRows(card, paint, inner, undefined, metrics),
		// The body is never clipped: a prompt is not a preview, so every row is drawn.
		body: cardPaintedRows(rows, IDENTITY.tone, paint, inner, { expanded: true }, metrics),
		// No content rides the closing rule: the prompt's clock belongs to the heading alone.
		bottom: cardBottom(IDENTITY.tone, paint, inner, undefined, metrics),
	};
	cardMemo.set(self, { markdown, target, inner, paint, clock, name, rows, parts });
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
 *
 * The stored name is read ONCE here, after the gate and the width floor have already refused
 * anything that is not a card: a native frame, a tiny width and an unreadable body pay no store
 * read at all, and a card that does draw pays exactly one — never one per `inner` the style asks
 * for. The read is live on every paint (never cached), which is what makes a name set or cleared
 * while the transcript is on screen reach the prompts already on it without any invalidation.
 */
function paintPrompt(self, rows, width, seams) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;
	if (!cardMessageOn()) return rows;
	const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
	if (target < MIN_PAINT_WIDTH) return rows;
	const metrics = readMetrics(seams.metrics);
	if (metrics === undefined) return rows;
	// The theme is read BEFORE the body: the clone is keyed on it, so a theme switched while the
	// prompt is on screen repaints the body instead of serving the clone it was built under.
	const paint = themeFor(readTheme(seams.theme), PLAIN_THEME);
	const markdown = componentMarkdown(self, paint);
	if (markdown === undefined) return rows;
	const name = currentIdentityName();
	try {
		const drawn = floatRows(IDENTITY.tone, paint, target, (inner) => {
			const parts = cardParts(self, markdown, target, inner, paint, metrics, name);
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

/**
 * `installUserPromptCard({ component, metrics, theme })` — wrap the class's `render` once per
 * process and answer through the seams given now.
 *
 * Idempotent by construction (`lib/host-render-shim.js`): a prototype this card already wraps is
 * not wrapped again, so `/reload`, a second session and a second evaluation add no second layer,
 * and only the LIVE logic is replaced. A class that cannot draw (no prototype, no `render`)
 * installs nothing and answers `{ installed: false }`.
 */
function installUserPromptCard(options) {
	const opts = asObject(options);
	const seams = { metrics: opts.metrics, theme: opts.theme };
	return shim.install(opts.component, (self, rows, width) => paintPrompt(self, rows, width, seams));
}

/** Restore every prototype this card wrapped, byte for byte, and forget the live logic. */
const uninstallUserPromptCard = () => shim.uninstall();

module.exports = {
	IDENTITY,
	MIN_PAINT_WIDTH,
	installUserPromptCard,
	paintPrompt,
	promptMarkdown,
	uninstallUserPromptCard,
};

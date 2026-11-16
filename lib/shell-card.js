'use strict';
// The drawing substrate of the Gentle worktree cards, in the two styles Gentle
// Shell offers: the rounded frame (`neon`) and the rail over a painted band
// (`float`).
//
// Ported from `lib/shell-card.ts` of gentle-shell (its suite is
// tests/shell-card.test.ts): the geometry, the chrome tables, the tone roles and
// the collapsed/expanded heading behaviour, because this package's two worktree
// tools draw their result cards with it (spec S5).
//
// What the style decides, and what it never decides: `floatRows` reads the style
// ONCE per render (lib/card-style.js) and draws the whole card in that one style,
// so no card is ever half of each. Content, order, truncation, the collapsed
// preview and the right-aligned elapsed time are the same text in both; only the
// chrome differs (the frame, the rail, the two padding rows and the tone
// background). `neon` keeps the rounded `╭ ╮ ╰ ╯ │` frame; `float` drops the box
// for a `▎` rail, pads every row to the full width and paints the tone
// background behind it, inside a transparent one-column margin on both sides.
//
// Colour is a THEME ROLE, never a colour, and the roles are the source's own
// tables: the frame (neon and float alike) paints `FRAME_ROLE[tone]`, the heading
// label paints `TITLE_ROLE[tone]` — its own tone, or the accent for INFO, whose
// plain border cannot carry it — and a card body is painted in `BODY_ROLE`. A card
// with nothing left to report may also name the role of its WHOLE closed box
// (`railRole`), which is how a labelled card's box reads as part of its label; a
// tone that owns the box keeps its own frame role, so a running or failed call is
// never painted in an identity colour (`TONE_OWNS_BOX`). So a call's state is
// readable from every cell of its card, both styles agree, and no hex value and no
// raw escape sequence is written down here.
//
// PAINT LAST is the substrate's ordering rule, and it is why the rows below are
// composed from PLAIN text: `cardBodyRows` wraps and clips the caller's plain
// rows, `cardLine` clips and pads one plain row, and only then is the content
// wrapped in its role. Nothing painted here is ever measured, truncated or padded
// again — so a helper that counts escape characters as columns (this package's own
// `/warp` fallback does) can neither cut into a sequence nor lose a character, and
// the drawn text is the same whatever the injected helpers are.
//
// Too narrow for float (under ten columns) or a theme with no `bg` for the tone
// role ⇒ the neon outline is drawn instead of a broken float card, so a card
// always renders whole.
//
// The card object this module draws has the source's shape, plus the one override
// the source's card holds, and two OPTIONAL refinements no existing card names (so
// every existing card is drawn byte for byte as before):
//   { title, subtitle?, subtitleSegments?, labelBold?, body: string[], tone,
//     glyph?, titleRole?, railRole? }
//
// `subtitleSegments` is the detail as the segments it is made of — `[{ text, role }]`,
// where a segment that names no role stays unpainted — so a card can say `read` in the
// theme's plain text, the separator in `muted`, a path in `accent` and a line range in
// `warning` on one row. The segments are still MEASURED as their plain text and
// painted afterwards, one segment at a time. `labelBold` bolds the label (never the
// glyph) inside the card's `titleRole`.
//
// `cardPaintedRows` is the one row shape for text this module must NOT re-paint: rows
// a caller already painted (Pi's Markdown renderer hands back exactly that) are
// measured with the injected ANSI-aware metrics, clipped, padded and framed, and each
// one keeps its own paint. No existing caller uses it, so the plain path every other
// card takes is untouched.
//
// `railRole` is the identity role the card's closed box is painted in, and it is
// honoured exactly as the source's `frameRole` does: by `floatRows` for one whole
// render, and by the heading helpers from the card's own field. A card that names
// none keeps the tone's frame role, so every existing card is drawn byte for byte
// as before.
//
// Colour arrives as an injected theme: `fg(role, text)` returns a string, and
// `bg(role, text)` — optional — paints the float background. No ANSI escape is
// composed here except the background reset the injected `bg` itself hands back,
// and no role name is invented: the roles are the source's `border`, `accent`,
// `success`, `warning`, `error`, `text`, `dim`, `muted` and the tone background
// roles `toolSuccessBg`, `toolPendingBg` and `toolErrorBg`.
//
// Text measurement is injected too, because this package has no install step and
// no node_modules: a `metrics` object is the REQUIRED last argument of every
// function that measures or clips text, and it is the only way this module does
// so. Its shape, taken from the host TUI helpers it stands in for:
//   {
//     visibleWidth(text)                       -> display columns of `text`
//     truncateToWidth(text, width, ellipsis)   -> `text` clipped to `width` columns
//     wrapTextWithAnsi(text, width)            -> `text` wrapped into rows of at
//                                                 most `width` columns
//   }
// Roles are strings; tones come from `CARD_TONE`.

const { CARD_STYLE, cardStyle } = require('./card-style.js');

const CARD_TONE = {
	INFO: 'info',
	SUCCESS: 'success',
	WARNING: 'warning',
	ERROR: 'error',
};

const CARD_GLYPH = '✿';
// The frame and the label paint the same role for every tone except INFO, whose
// rounded frame stays in the theme's plain border role while its label carries
// the accent role — the rose look every informational card (sidebar, review
// preflight, a quiet Agents widget, ...) uses.
const FRAME_ROLE = {
	[CARD_TONE.INFO]: 'border',
	[CARD_TONE.SUCCESS]: 'success',
	[CARD_TONE.WARNING]: 'warning',
	[CARD_TONE.ERROR]: 'error',
};
// A card's label carries its tone; a card may still name its own label role
// (`titleRole`), and a card with nothing to report may name the role of its whole
// box (`railRole`). The frame keeps painting the tone whenever the tone owns the box.
const TITLE_ROLE = {
	[CARD_TONE.INFO]: 'accent',
	[CARD_TONE.SUCCESS]: 'success',
	[CARD_TONE.WARNING]: 'warning',
	[CARD_TONE.ERROR]: 'error',
};
// Which tones own the whole box instead of letting an idle card wear its own
// identity there (the source's own `TONE_OWNS_BOX`): an active state speaks for the
// call — amber while it runs, red once it failed — so only a card with nothing left
// to report paints its named identity around itself.
const TONE_OWNS_BOX = {
	[CARD_TONE.INFO]: false,
	[CARD_TONE.SUCCESS]: false,
	[CARD_TONE.WARNING]: true,
	[CARD_TONE.ERROR]: true,
};
const HINT_ROLE = 'dim';
const SUBTITLE_ROLE = 'muted';
// The card body's own role: the theme's plain text, so a body row never borrows
// the chrome's tone. `cardLine` paints it — after the row has been clipped and
// padded, as the last step, so no measurement ever sees the escape sequence.
const BODY_ROLE = 'text';
const SEPARATOR = '·';
const FRAME_COLUMNS = 4;
// Columns a heading row keeps for the call itself before its detail (or the key
// hint) is asked to give way to the next row.
const MIN_HEADING_COLUMNS = 12;

// The characters that draw the card around its content, one table per style.
// Rows are built from these by position, so content that happens to contain
// box-drawing characters is never rewritten. `▎ ` is one cell narrower than
// `╭─ `: the spare cell moves to the right end so the heading glyph starts in
// the same column as the body text.
const OUTLINE_CHROME = {
	topLeft: '╭',
	topLead: '─ ',
	topRight: '╮',
	rule: '─',
	side: '│',
	rail: '│',
	bottomLeft: '╰',
	bottomRight: '╯',
};
const FLOAT_CHROME = {
	topLeft: '▎',
	topLead: ' ',
	topRight: '  ',
	rule: ' ',
	side: '▎',
	rail: ' ',
	bottomLeft: '▎',
	bottomRight: ' ',
};

// The chrome in force for the draw in progress. Swapped only by `withChrome`,
// which `floatRows` owns, so a card is drawn entirely in one style.
let chrome = OUTLINE_CHROME;

function withChrome(next, run) {
	const previous = chrome;
	chrome = next;
	try {
		return run();
	} finally {
		chrome = previous;
	}
}

function rule(length) {
	return chrome.rule.repeat(Math.max(0, length));
}

// The identity role a card's closed box is painted in, when the card names one. The
// frame runs around every row, so it is a scope around a whole card rather than a
// parameter each row helper would have to carry: `floatRows` opens it for one
// render, and the heading helpers open it from the card's own `railRole`.
let railRole;

function withRailRole(role, run) {
	const previous = railRole;
	railRole = role;
	try {
		return run();
	} finally {
		railRole = previous;
	}
}

/** Opens the scope a card's own `railRole` asks for, when it asks for one. */
function withCardRail(card, run) {
	return card.railRole === undefined ? run() : withRailRole(card.railRole, run);
}

/**
 * The one role every closed-frame cell is painted in: both top corners, the lead and
 * rule of the top, the left side, the right rail, the bottom rule and both bottom
 * corners. A tone that owns the box keeps its own frame role; otherwise an idle card
 * wears the identity role it names, falling back to the tone. One role per card, so
 * no row shows two colours side by side.
 */
function frameRole(tone) {
	return TONE_OWNS_BOX[tone] ? FRAME_ROLE[tone] : railRole ?? FRAME_ROLE[tone];
}

// The chrome paints the tone in BOTH styles: the source's `frame()` takes no
// exception for float, so the rail and the neon rule carry the same state — or the
// same identity role, when the card named one.
function frame(theme, tone, painted) {
	return theme.fg(frameRole(tone), painted);
}

function titleRole(card) {
	return card.titleRole ?? TITLE_ROLE[card.tone];
}

/** `text` bolded through the theme, or the text itself when the theme carries no such attribute. */
function boldText(text, theme) {
	try {
		if (theme !== null && typeof theme === 'object' && typeof theme.bold === 'function') {
			const bold = theme.bold(text);
			if (typeof bold === 'string') return bold;
		}
	} catch {
		// A theme without a bold attribute keeps the text it was given.
	}
	return text;
}

/**
 * The one paint step for card content: text that has ALREADY been measured,
 * clipped and padded is wrapped in `role` here, and the result is never measured
 * again. An empty string stays empty, so a paragraph break keeps its blank row
 * and no role is painted onto nothing.
 */
function painted(text, role, theme) {
	return text === '' ? text : theme.fg(role, text);
}

/**
 * The detail as the segments it is made of. A card that states none is one muted
 * segment, which is exactly the single detail every card has always shown.
 */
function subtitleSegments(card) {
	const listed = Array.isArray(card.subtitleSegments) ? card.subtitleSegments : undefined;
	if (listed === undefined) return [{ text: subtitlePlain(card), role: SUBTITLE_ROLE }];
	return listed.map((segment) => {
		const value = segment !== null && typeof segment === 'object' ? segment : {};
		return {
			text: typeof value.text === 'string' ? value.text : '',
			role: typeof value.role === 'string' ? value.role : undefined,
		};
	});
}

/** The detail as PLAIN text: its segments joined, or the one string the card states. */
function subtitlePlain(card) {
	if (!Array.isArray(card.subtitleSegments)) return typeof card.subtitle === 'string' ? card.subtitle : '';
	return subtitleSegments(card).map((segment) => segment.text).join('');
}

/** The whole detail painted segment by segment: a segment that names no role stays plain. */
function subtitlePaint(card, theme) {
	return subtitleSegments(card)
		.map((segment) => (segment.role === undefined ? segment.text : painted(segment.text, segment.role, theme)))
		.join('');
}

/**
 * The detail clipped as PLAIN text to `budget` columns and painted afterwards, one
 * segment at a time, so a role never covers a column its own text does not own. When
 * `ellipsis` is asked for, a detail that does not fit ends in one in the role of the
 * segment it lands on.
 */
function subtitleClip(card, theme, budget, metrics, ellipsis) {
	const segments = subtitleSegments(card);
	const whole = segments.map((segment) => segment.text).join('');
	const target = Math.max(0, Math.floor(budget));
	const overflows = metrics.visibleWidth(whole) > target;
	// An ellipsis costs one column of the budget, exactly as the one-row clip has always.
	let remaining = ellipsis === true && overflows ? Math.max(0, target - 1) : target;
	const kept = [];
	let used = 0;
	for (const segment of segments) {
		if (remaining === 0) break;
		const shown = metrics.truncateToWidth(segment.text, remaining, '');
		if (shown === '') break;
		kept.push({ text: shown, role: segment.role });
		used += metrics.visibleWidth(shown);
		remaining -= metrics.visibleWidth(shown);
		if (shown !== segment.text) break;
	}
	if (ellipsis === true && overflows && target > used) {
		const tail = kept.at(-1);
		if (tail === undefined) kept.push({ text: '…' });
		else tail.text = `${tail.text}…`;
		used += 1;
	}
	const plain = kept.map((segment) => segment.text).join('');
	return {
		plain,
		segments: kept,
		painted: kept.map((segment) => (segment.role === undefined ? segment.text : painted(segment.text, segment.role, theme))).join(''),
		width: used,
	};
}

/** The plain width of the whole heading: the label, and the detail when it has one. */
function titleWidth(card, metrics) {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const detail = subtitlePlain(card);
	return metrics.visibleWidth(head) + (detail !== '' ? metrics.visibleWidth(detail) + 3 : 0);
}

/**
 * The heading, painted: measured and clipped as PLAIN text to `width` columns —
 * the label first, then the detail's separator and the detail — with each
 * surviving segment painted afterwards. A heading too wide for the rule is
 * therefore cut on a column, never inside an escape sequence.
 */
function titleText(card, theme, width, metrics) {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const headWidth = metrics.visibleWidth(head);
	const paintHead = (plain) => paintedHead(card, theme, plain, head);
	if (subtitlePlain(card) === '') {
		const shown = headWidth <= width ? head : metrics.truncateToWidth(head, width, '');
		return { styled: paintHead(shown), width: shown === head ? headWidth : metrics.visibleWidth(shown) };
	}
	const detailWidth = metrics.visibleWidth(subtitlePlain(card));
	const fullWidth = headWidth + 3 + detailWidth;
	if (fullWidth <= width) {
		return {
			styled: `${paintHead(head)} ${painted(SEPARATOR, SUBTITLE_ROLE, theme)} ${subtitlePaint(card, theme)}`,
			width: fullWidth,
		};
	}
	// Too wide: the plain prefix keeps the columns it can, exactly as the whole
	// painted heading used to be clipped, and each segment is painted afterwards.
	const shownHead = headWidth <= width ? head : metrics.truncateToWidth(head, width, '');
	const shownHeadWidth = shownHead === head ? headWidth : metrics.visibleWidth(shownHead);
	let remaining = Math.max(0, width - shownHeadWidth);
	const separator = remaining === 0 ? '' : metrics.truncateToWidth(` ${SEPARATOR} `, remaining, '');
	remaining = Math.max(0, remaining - metrics.visibleWidth(separator));
	const detail = remaining === 0 ? { painted: '', width: 0 } : subtitleClip(card, theme, remaining, metrics, false);
	return {
		styled: `${paintHead(shownHead)}${painted(separator, SUBTITLE_ROLE, theme)}${detail.painted}`,
		width: shownHeadWidth + metrics.visibleWidth(separator) + detail.width,
	};
}

/**
 * The head painted: one role for the glyph and the label, and — only when the card
 * asks for it — the label bolded inside that role. A head clipped on the rule keeps
 * whatever of each survives, painted once.
 */
function paintedHead(card, theme, shown, head) {
	const role = titleRole(card);
	if (card.labelBold !== true) return painted(shown, role, theme);
	const glyph = card.glyph ?? CARD_GLYPH;
	if (shown === head) return `${painted(glyph, role, theme)} ${painted(boldText(card.title, theme), role, theme)}`;
	const shownGlyph = shown.slice(0, Math.min(shown.length, glyph.length));
	const rest = shown.slice(shownGlyph.length);
	return `${painted(shownGlyph, role, theme)}${rest === '' ? '' : painted(boldText(rest, theme), role, theme)}`;
}

/** The top rule: the glyph and title, the detail, the filling rule and an optional right-aligned hint. */
function cardTop(card, theme, width, hint, metrics) {
	return withCardRail(card, () => cardTopAt(card, theme, Math.max(0, Math.floor(width)), hint, metrics));
}

function cardTopAt(card, theme, targetWidth, hint, metrics) {
	if (targetWidth === 0) return '';
	if (targetWidth < 5) {
		const left = frame(theme, card.tone, OUTLINE_CHROME.topLeft);
		if (targetWidth === 1) return left;
		return left + frame(theme, card.tone, `${rule(targetWidth - 2)}${chrome.topRight}`);
	}

	const fullHintWidth = hint ? metrics.visibleWidth(hint) + 2 : 0;
	const shownHint = hint && titleWidth(card, metrics) + 5 + fullHintWidth <= targetWidth ? hint : undefined;
	const hintWidth = shownHint ? fullHintWidth : 0;
	// The heading is composed at the columns the hint leaves it: plain text in, a
	// clipped plain heading and its painted form out. Its width is already known.
	const title = titleText(card, theme, Math.max(0, targetWidth - 5 - hintWidth), metrics);
	const fill = rule(targetWidth - title.width - 5 - hintWidth);
	const tail = shownHint ? ` ${theme.fg(HINT_ROLE, shownHint)} ` : '';
	return frame(theme, card.tone, chrome.topLeft) + frame(theme, card.tone, chrome.topLead) + title.styled + frame(theme, card.tone, ` ${fill}`) + tail + frame(theme, card.tone, chrome.topRight);
}

/**
 * Whether a heading row keeps its key hint at this width. Callers that compose a
 * subtitle from optional facts use it to shed the least important chip instead of
 * silently losing the affordance.
 */
function headingFits(card, hint, width, metrics) {
	const targetWidth = Math.max(0, Math.floor(width));
	const detail = subtitlePlain(card);
	const head = metrics.visibleWidth(`${card.glyph ?? CARD_GLYPH} ${card.title}`) + (detail !== '' ? metrics.visibleWidth(detail) + 3 : 0);
	return head + 5 + (hint ? metrics.visibleWidth(hint) + 2 : 0) <= targetWidth;
}

/**
 * One body row: the sides, the padded content and the rail, clipped with a literal
 * ellipsis. `text` is PLAIN: it is measured, clipped and padded first, and only
 * then painted in `role` (the body role unless the row owns a role of its own, as
 * the running row does). Nothing painted is measured, so the clip cannot cut into
 * an escape sequence and the visible text never depends on how clever the
 * injected helpers are.
 */
function cardLine(text, tone, theme, width, metrics, role = BODY_ROLE) {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return '';
	const left = frame(theme, tone, chrome.side);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, OUTLINE_CHROME.side);
	if (targetWidth === 3) return `${left} ${frame(theme, tone, OUTLINE_CHROME.side)}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? '' : metrics.truncateToWidth(text, innerWidth, '…');
	const padding = ' '.repeat(Math.max(0, innerWidth - metrics.visibleWidth(clipped)));
	return `${left} ${painted(clipped, role, theme)}${padding} ${frame(theme, tone, chrome.rail)}`;
}

/**
 * One body row whose text is ALREADY painted: the sides, the clipped content and the
 * rail, with no role applied on top. The width is taken with the injected ANSI-aware
 * metrics, so the clip never cuts inside a sequence and the padding never counts one;
 * the frame, the padding and the rail stay this module's.
 *
 * This is the one shape for content another renderer painted (Pi's Markdown hands back
 * exactly that), and it is additive: the plain `cardLine` path every other card takes
 * is unchanged.
 */
function cardPaintedLine(text, tone, theme, width, metrics) {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return '';
	const left = frame(theme, tone, chrome.side);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, OUTLINE_CHROME.side);
	if (targetWidth === 3) return `${left} ${frame(theme, tone, OUTLINE_CHROME.side)}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? '' : metrics.truncateToWidth(text, innerWidth, '…');
	const padding = ' '.repeat(Math.max(0, innerWidth - metrics.visibleWidth(clipped)));
	return `${left} ${clipped}${padding} ${frame(theme, tone, chrome.rail)}`;
}

/**
 * Body rows for the frame from rows that are ALREADY painted — Pi's Markdown output —
 * wrapped with the ANSI-aware seam, capped by the preview budget unless the card is
 * expanded, and placed by `cardPaintedLine` without a role of ours over them.
 */
function cardPaintedRows(rows, tone, theme, width, options, metrics) {
	if (width <= 0) return [];
	const list = Array.isArray(rows) ? rows : [];
	const inner = cardInnerWidth(width);
	const wrapped = list.flatMap((row) => String(row ?? '').split('\n').flatMap((line) => (line === '' ? [''] : metrics.wrapTextWithAnsi(line, inner))));
	const limit = Math.max(0, Math.floor(options?.previewRows ?? 3));
	const shown = options?.expanded ? wrapped : wrapped.slice(0, limit);
	return shown.map((line) => cardPaintedLine(line, tone, theme, width, metrics));
}

/** The closing rule, with its content right-aligned when enough fill columns stay free. */
function cardBottom(tone, theme, width, content, metrics) {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return '';
	const left = frame(theme, tone, chrome.bottomLeft);
	if (targetWidth === 1) return left;
	if (content === undefined || metrics.visibleWidth(content) === 0) return left + frame(theme, tone, `${rule(targetWidth - 2)}${chrome.bottomRight}`);
	const contentWidth = metrics.visibleWidth(content) + 2;
	// Responsive: the content rides the closing rule only when it fits with a minimum fill.
	if (targetWidth - 2 - contentWidth < 3) return left + frame(theme, tone, `${rule(targetWidth - 2)}${chrome.bottomRight}`);
	return left + frame(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `) + theme.fg(HINT_ROLE, content) + frame(theme, tone, ` ${chrome.bottomRight}`);
}

function cardInnerWidth(width) {
	return Math.max(1, width - FRAME_COLUMNS);
}

/**
 * Body rows for the frame, from the caller's PLAIN rows: wrapped to the inner
 * width, then capped by the preview budget (three rows by default) unless the card
 * is expanded, and each surviving row clipped, padded and painted last by
 * `cardLine` in `options.role` (the body role by default).
 *
 * This is the one body seam both card families use, and it takes plain text for a
 * reason: the wrap and the clip are the measurements, the paint is not, so a
 * caller cannot hand this function a painted row and have it measured twice.
 */
function cardBodyRows(rows, tone, theme, width, options, metrics) {
	if (width <= 0) return [];
	const role = options.role === undefined ? BODY_ROLE : options.role;
	const wrapped = rows.flatMap((row) => row.split('\n').flatMap((line) => (line === '' ? [''] : metrics.wrapTextWithAnsi(line, cardInnerWidth(width)))));
	const limit = Math.max(0, Math.floor(options.previewRows ?? 3));
	const shown = options.expanded ? wrapped : wrapped.slice(0, limit);
	return shown.map((line) => cardLine(line, tone, theme, width, metrics, role));
}

// ---- the card's one click area ----
//
// Click-to-expand, host-driven. The installed Pi build delivers a click only to
// the component that CLAIMED the press: `tui-alt-screen.js` records
// `mousePressTarget` from the press dispatch (`if (result) … mousePressTarget =
// result.target`) and, on release at the same cell, synthesizes a `click`
// retargeted to that exact component. So the press must be handled or the click
// never arrives — the host's own `MouseRegion` around a tool card reacts to
// `click` alone and can never see one on its own.
//
// The whole drawn card is the area: `rows` is what `render` returned for the width
// it was called with, and `Container`/`Box` hand the component an event whose
// `x`/`y` are local to it and whose `width`/`height` are its own bounds. The hit
// area therefore follows the real geometry of both styles — the float heading
// band and its margins, the padded message card, a wrapped heading — instead of a
// second, drifting calculation. A left press claims the gesture without
// repainting the row it measured; the click it enables calls the card's own
// `toggleExpanded` callback, which flips THAT CARD's expansion choice and
// nothing else. Every other gesture and every cell outside the card stays the
// host's (text selection, links, right-click paste).
function cardMouseEvent(event, rows, toggleExpanded) {
	const e = event !== null && typeof event === 'object' ? event : null;
	if (e === null) return undefined;
	if (e.button !== 'left') return undefined;
	if (e.type !== 'press' && e.type !== 'click') return undefined;
	if (typeof e.x !== 'number' || typeof e.y !== 'number') return undefined;
	const width = Number.isFinite(e.width) ? Math.floor(e.width) : 0;
	if (width <= 0) return undefined;
	if (!Array.isArray(rows) || rows.length === 0) return undefined;
	if (!(e.y >= 0 && e.y < rows.length)) return undefined;
	if (!(e.x >= 0 && e.x < width)) return undefined;
	if (e.type === 'press') return { handled: true, render: false };
	try {
		if (typeof toggleExpanded === 'function') toggleExpanded();
	} catch {
		// A hostile host callback never breaks the card or the transcript.
	}
	return { handled: true };
}

// The host draws a tool row as the call component followed, once a result exists,
// by the result component, which closes the frame. The call cannot see the result,
// so result renderers mark the row state both share, and a call still waiting for
// its first result closes its own frame.
const RESULT_MARK = Symbol.for('gentle-pi.card-result');
const RUNNING_TEXT = 'running…';
const RUNNING_ROLE = 'muted';

/** Result renderers mark the shared row state: from now on a result component closes the card. */
function markCardResult(state) {
	if (state !== null && typeof state === 'object') state[RESULT_MARK] = true;
}

/** Whether a call card must close its own frame. Read it at render time: the result component is built after the call. */
function cardAwaitingResult(context) {
	if (context.isPartial === false) return false;
	const state = context.state;
	return !(state !== null && typeof state === 'object' && state[RESULT_MARK] === true);
}

/** The muted body row of a call card that is still waiting for its result. */
function cardRunningLine(tone, theme, width, metrics) {
	// Plain text plus its role: the substrate clips the text, then paints it.
	return cardLine(RUNNING_TEXT, tone, theme, width, metrics, RUNNING_ROLE);
}

/**
 * Calls may continue long or multiline headings inside the same frame. A detail
 * that cannot share the top rule without crowding the call (or its key hint)
 * continues on card rows below it, so a long call stays fully visible instead of
 * being truncated.
 */
function cardTopRows(card, theme, width, hint, metrics) {
	return withCardRail(card, () => cardTopRowsAt(card, theme, width, hint, metrics));
}

function cardTopRowsAt(card, theme, width, hint, metrics) {
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	if (target < 8) return [cardTop(card, theme, target, hint, metrics)];
	const [first = '', ...rest] = card.title.split('\n');
	// Reserve the hint before wrapping, plus one rule column and enough heading
	// space to retain identity. This policy belongs only to continuing tool tops.
	const lead = metrics.visibleWidth(`${card.glyph ?? CARD_GLYPH} `);
	const hintWidth = hint ? metrics.visibleWidth(hint) + 2 : 0;
	const available = target - 6 - lead;
	if (card.subtitle !== undefined) {
		// Let the detail share the rule only when the whole heading (and the key hint)
		// fits there; otherwise it continues below, where it keeps its width. A
		// multi-line detail keeps its first line on the rule and its other lines below,
		// so a script or heredoc never disappears behind a truncation.
		const [detailFirst = '', ...detailRest] = subtitlePlain(card).split('\n');
		const detailWidth = metrics.visibleWidth(detailFirst) + 3;
		const inline = lead + metrics.visibleWidth(first) + detailWidth + hintWidth + 5 <= target;
		const shownHint = inline ? hint : hint && available - hintWidth >= MIN_HEADING_COLUMNS ? hint : undefined;
		const room = Math.max(1, available - (inline ? detailWidth : 0) - (shownHint ? hintWidth : 0));
		const [head = '', ...overflow] = metrics.wrapTextWithAnsi(first, room);
		// The detail continues in the muted role, and the heading's own overflow in
		// the body role: both are handed to the substrate as PLAIN rows, so the wrap
		// and the clip see text and the paint comes last. When the detail cannot share
		// the rule it leaves the rule ENTIRELY: the segments it is drawn from are
		// dropped with it, so the rule states the identity alone (exactly as a card
		// with no detail does) and the detail follows once, below.
		const detail = inline
			? detailRest
			: subtitlePlain(card).split('\n').map((line, index) => (index === 0 ? `${SEPARATOR} ${line}` : line));
		// A detail that names a role per segment is painted segment by segment and then
		// placed as ALREADY painted rows, so no role is lost when it moves below the rule.
		const segments = Array.isArray(card.subtitleSegments) && detailRest.length === 0;
		const detailRows = segments && !inline
			? cardPaintedRows(
				[subtitlePaint({ ...card, subtitleSegments: [{ text: `${SEPARATOR} `, role: SUBTITLE_ROLE }, ...card.subtitleSegments] }, theme)],
				card.tone,
				theme,
				target,
				{ expanded: true },
				metrics,
			)
			: cardBodyRows(detail, card.tone, theme, target, { expanded: true, role: SUBTITLE_ROLE }, metrics);
		// The rule states the identity and, only when it shares it, the detail first
		// line; the segments go with the detail they are drawn from.
		const headCard = { ...card, subtitle: inline ? detailFirst : undefined, subtitleSegments: inline ? card.subtitleSegments : undefined, title: head };
		return [
			cardTop(headCard, theme, target, shownHint, metrics),
			...cardBodyRows([...overflow, ...rest], card.tone, theme, target, { expanded: true }, metrics),
			...detailRows,
		];
	}
	const shownHint = hint && available - hintWidth >= MIN_HEADING_COLUMNS ? hint : undefined;
	const room = Math.max(1, available - (shownHint ? hintWidth : 0));
	const [head = '', ...overflow] = metrics.wrapTextWithAnsi(first, room);
	return [
		cardTop({ ...card, title: head }, theme, target, shownHint, metrics),
		...cardBodyRows([...overflow, ...rest], card.tone, theme, target, { expanded: true }, metrics),
	];
}

/**
 * A single-row heading: a detail too wide for the rule ends in an ellipsis instead
 * of continuing on the rows below, so a collapsed card stays one line. Expanding
 * the call is what reveals the complete detail.
 */
function cardTopLine(card, theme, width, hint, detail, metrics) {
	return withCardRail(card, () => cardTopLineAt(card, theme, width, hint, detail, metrics));
}

function cardTopLineAt(card, theme, width, hint, detail, metrics) {
	const target = Math.max(0, Math.floor(width));
	if (target < 8 || (card.subtitle === undefined && detail === undefined)) return cardTop(card, theme, target, hint, metrics);
	const head = metrics.visibleWidth(`${card.glyph ?? CARD_GLYPH} ${card.title}`);
	// The key hint comes first when it fits beside a readable detail; otherwise it
	// yields its columns so the detail keeps an ellipsis instead of vanishing.
	let shownHint = hint;
	let room = target - 5 - (shownHint ? metrics.visibleWidth(shownHint) + 2 : 0) - head - 3;
	if (room < 1 && shownHint !== undefined) {
		shownHint = undefined;
		room = target - 5 - head - 3;
	}
	// A card whose detail names a role per segment is clipped segment by segment: the
	// one-row budget is what its own collapsed detail was measured against, and each
	// surviving segment is painted in the role it names.
	if (Array.isArray(card.subtitleSegments)) {
		const plain = subtitlePlain(card);
		const asked = detail === undefined ? plain : detail(Math.max(1, room));
		const listed = asked === plain ? card.subtitleSegments : [{ text: asked, role: SUBTITLE_ROLE }];
		const clipped = subtitleClip({ subtitleSegments: listed }, theme, Math.max(1, room), metrics, true);
		return cardTop({ ...card, subtitle: clipped.plain, subtitleSegments: clipped.segments }, theme, target, shownHint, metrics);
	}
	// A heading that measures its own collapsed detail takes the room left once the
	// chrome and the key hint have taken theirs, so a script folds into a stated
	// count instead of vanishing behind an ellipsis.
	const subtitle = detail === undefined ? subtitlePlain(card).split('\n').join(' ') : detail(Math.max(1, room));
	const shown = room >= 1 && metrics.visibleWidth(subtitle) > room
		? `${metrics.truncateToWidth(subtitle, Math.max(1, room - 1), '')}…`
		: subtitle;
	return cardTop({ ...card, subtitle: shown }, theme, target, shownHint, metrics);
}

/** A closing rule with no content: the float style's padding row, and the plain rule. */
function cardBlank(tone, theme, width) {
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return '';
	const left = frame(theme, tone, chrome.bottomLeft);
	if (target === 1) return left;
	return left + frame(theme, tone, `${rule(target - 2)}${chrome.bottomRight}`);
}

/**
 * Elapsed time for a closing rule, or undefined when the host reported no reliable
 * duration. Sub-second runs read in milliseconds, longer ones in seconds with one
 * decimal.
 */
function cardElapsed(durationMs) {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
	return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

// ---- the float style ----

// The transparent margin on both sides of a float card, the narrowest width that
// still holds a rail plus content, and the tone background each tone paints.
const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE = {
	[CARD_TONE.INFO]: 'toolSuccessBg',
	[CARD_TONE.SUCCESS]: 'toolSuccessBg',
	[CARD_TONE.WARNING]: 'toolPendingBg',
	[CARD_TONE.ERROR]: 'toolErrorBg',
};

// The background reset, assembled instead of written down: this module carries no
// raw escape sequence, and the only escape a float row holds is the opener the
// injected theme's own `bg(role, "")` handed back.
const ESC = String.fromCharCode(27);
const BG_RESET = `${ESC}[49m`;
// Full resets (the host's truncation inserts one) and background resets both
// clear the background, so the opener is re-armed after either one.
const BG_CLEARING = new RegExp(`${ESC}\\[(?:0|49)?m`, 'g');

/**
 * The SGR that opens `role` as a background, or "" when the theme cannot paint
 * it — the one signal that the float style is unavailable and the neon outline
 * must be drawn instead.
 */
function surfaceOpener(theme, role) {
	if (theme === null || typeof theme !== 'object' || typeof theme.bg !== 'function') return '';
	if (typeof role !== 'string' || role.length === 0) return '';
	try {
		const painted = theme.bg(role, '');
		return typeof painted === 'string' && painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : '';
	} catch {
		// A theme without the role keeps the neon frame instead of a broken float card.
		return '';
	}
}

/** The tone background opener when float applies at this width, or "" for the neon outline. */
function floatOpener(theme, tone, width) {
	if (cardStyle() !== CARD_STYLE.FLOAT) return '';
	if (Math.floor(width) < FLOAT_MIN_WIDTH) return '';
	const role = Object.prototype.hasOwnProperty.call(FLOAT_BG_ROLE, tone) ? FLOAT_BG_ROLE[tone] : '';
	return surfaceOpener(theme, role);
}

/** Paints one row behind the background `open` starts, inside the transparent margin. */
function paintSurfaceRow(row, open) {
	const painted = String(row).replace(BG_CLEARING, (reset) => reset + open);
	return `${open}${painted}${BG_RESET}`;
}

function paintFloat(rows, open) {
	const margin = ' '.repeat(FLOAT_MARGIN);
	return rows.map((row) => `${margin}${paintSurfaceRow(row, open)}${margin}`);
}

/**
 * S5: the rows of one card component in the style the shell chose. `render`
 * receives the width the card draws at — the full width for `neon`, two columns
 * narrower for `float`, where the margins live — and returns the component's
 * `{head, body, bottom, afterHeading}` parts. The style is decided ONCE, here, so
 * a card is never half outline and half rail.
 *
 * Float adds the two padding rows upstream does — above the heading and between
 * the heading and a body — and paints every row, padding included, behind the
 * tone background. `afterHeading` tells it that the heading lives in the call
 * component above, so a paired call and result still read as one card.
 *
 * `railRole` is the optional identity role the card's whole closed box is painted
 * in, exactly as the source's `floatRows` takes it: the corners and rules of the
 * neon frame and the rail of the float band alike, in both styles, unless the tone
 * owns the box. Omitted (the default), every cell keeps the tone's frame role, so a
 * card that names none is drawn exactly as before.
 */
function floatRows(tone, theme, width, render, railRoleOverride) {
	return withRailRole(railRoleOverride, () => floatRowsAt(tone, theme, Math.max(0, Math.floor(width)), render));
}

function floatRowsAt(tone, theme, target, render) {
	const open = floatOpener(theme, tone, target);
	if (open === '') {
		const { head = [], body = [], bottom } = render(target);
		return [...head, ...body, ...(bottom === undefined ? [] : [bottom])];
	}
	const inner = target - FLOAT_MARGIN * 2;
	const rows = withChrome(FLOAT_CHROME, () => {
		const { head = [], body = [], bottom, afterHeading = false } = render(inner);
		const blank = cardBlank(tone, theme, inner);
		return [
			...(head.length > 0 ? [blank, ...head] : []),
			...(body.length > 0 && (head.length > 0 || afterHeading) ? [blank] : []),
			...body,
			...(bottom === undefined ? [] : [bottom]),
		];
	});
	return paintFloat(rows, open);
}

module.exports = {
	CARD_GLYPH,
	CARD_STYLE,
	CARD_TONE,
	TONE_OWNS_BOX,
	cardAwaitingResult,
	cardBodyRows,
	cardBottom,
	cardElapsed,
	cardInnerWidth,
	cardLine,
	cardMouseEvent,
	cardPaintedLine,
	cardPaintedRows,
	cardRunningLine,
	cardTop,
	cardTopLine,
	cardTopRows,
	floatRows,
	headingFits,
	markCardResult,
};

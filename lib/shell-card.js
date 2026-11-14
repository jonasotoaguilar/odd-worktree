'use strict';
// The drawing substrate of the Gentle worktree cards, in the two styles Gentle
// Shell offers: the rounded frame (`neon`) and the accent rail (`float`).
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
// The accent is a THEME ROLE, never a colour: the label of the heading and the
// float rail paint the theme's `warning` role, which is the orange the human's
// theme carries. The frame (neon) keeps the tone's own role, so the state of a
// call stays readable, and no hex value and no raw escape sequence is written
// down here.
//
// Too narrow for float (under ten columns) or a theme with no `bg` for the tone
// role ⇒ the neon outline is drawn instead of a broken float card, so a card
// always renders whole.
//
// The card object this module draws has the source's shape:
//   { title, subtitle?, body: string[], tone, glyph?, titleRole? }
//
// Colour arrives as an injected theme: `fg(role, text)` returns a string, and
// `bg(role, text)` — optional — paints the float background. No ANSI escape is
// composed here except the background reset the injected `bg` itself hands back,
// and no role name is invented: the roles are the source's `border`, `accent`,
// `success`, `warning`, `error`, `dim`, `muted` and the tone background roles
// `toolSuccessBg`, `toolPendingBg` and `toolErrorBg`.
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
// S5: the accent the heading label carries in both styles — the theme's own
// orange. A card may name its own label role (`titleRole`); the frame and the
// float rail never take it.
const ACCENT_ROLE = 'warning';
// The neon frame keeps the tone: the state of a call is readable from the box
// even when its label wears the theme's accent. INFO keeps the plain border.
const FRAME_ROLE = {
	[CARD_TONE.INFO]: 'border',
	[CARD_TONE.SUCCESS]: 'success',
	[CARD_TONE.WARNING]: 'warning',
	[CARD_TONE.ERROR]: 'error',
};
const HINT_ROLE = 'dim';
const SUBTITLE_ROLE = 'muted';
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

// The float chrome is the accent rail: it paints the theme's warning role, never
// the tone. The neon frame paints the tone's own role.
function chromeRole(tone) {
	return chrome === FLOAT_CHROME ? ACCENT_ROLE : FRAME_ROLE[tone];
}

function titleRole(card) {
	return card.titleRole ?? ACCENT_ROLE;
}

function frame(theme, tone, painted) {
	return theme.fg(chromeRole(tone), painted);
}

function titleText(card, theme, metrics) {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const styled = card.subtitle
		? `${theme.fg(titleRole(card), head)} ${theme.fg(SUBTITLE_ROLE, SEPARATOR)} ${theme.fg(SUBTITLE_ROLE, card.subtitle)}`
		: theme.fg(titleRole(card), head);
	return { styled, width: metrics.visibleWidth(head) + (card.subtitle ? metrics.visibleWidth(card.subtitle) + 3 : 0) };
}

/** The top rule: the glyph and title, the detail, the filling rule and an optional right-aligned hint. */
function cardTop(card, theme, width, hint, metrics) {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return '';
	if (targetWidth < 5) {
		const left = frame(theme, card.tone, OUTLINE_CHROME.topLeft);
		if (targetWidth === 1) return left;
		return left + frame(theme, card.tone, `${rule(targetWidth - 2)}${chrome.topRight}`);
	}

	const title = titleText(card, theme, metrics);
	const fullHintWidth = hint ? metrics.visibleWidth(hint) + 2 : 0;
	const shownHint = hint && title.width + 5 + fullHintWidth <= targetWidth ? hint : undefined;
	const hintWidth = shownHint ? fullHintWidth : 0;
	const titleWidth = Math.max(0, targetWidth - 5 - hintWidth);
	const styledTitle = title.width <= titleWidth ? title.styled : metrics.truncateToWidth(title.styled, titleWidth, '');
	const styledTitleWidth = title.width <= titleWidth ? title.width : metrics.visibleWidth(styledTitle);
	const fill = rule(targetWidth - styledTitleWidth - 5 - hintWidth);
	const tail = shownHint ? ` ${theme.fg(HINT_ROLE, shownHint)} ` : '';
	return frame(theme, card.tone, chrome.topLeft) + frame(theme, card.tone, chrome.topLead) + styledTitle + frame(theme, card.tone, ` ${fill}`) + tail + frame(theme, card.tone, chrome.topRight);
}

/**
 * Whether a heading row keeps its key hint at this width. Callers that compose a
 * subtitle from optional facts use it to shed the least important chip instead of
 * silently losing the affordance.
 */
function headingFits(card, hint, width, metrics) {
	const targetWidth = Math.max(0, Math.floor(width));
	const head = metrics.visibleWidth(`${card.glyph ?? CARD_GLYPH} ${card.title}`) + (card.subtitle ? metrics.visibleWidth(card.subtitle) + 3 : 0);
	return head + 5 + (hint ? metrics.visibleWidth(hint) + 2 : 0) <= targetWidth;
}

/** One body row: the sides, the padded content and the rail, clipped with a literal ellipsis. */
function cardLine(text, tone, theme, width, metrics) {
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
 * Body rows for the frame: wrapped to the inner width, then capped by the preview
 * budget (three rows by default) unless the card is expanded.
 */
function cardBodyRows(rows, tone, theme, width, options, metrics) {
	if (width <= 0) return [];
	const wrapped = rows.flatMap((row) => row.split('\n').flatMap((line) => (line === '' ? [''] : metrics.wrapTextWithAnsi(line, cardInnerWidth(width)))));
	const limit = Math.max(0, Math.floor(options.previewRows ?? 3));
	const shown = options.expanded ? wrapped : wrapped.slice(0, limit);
	return shown.map((line) => cardLine(line, tone, theme, width, metrics));
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
// repainting the row it measured; the click it enables flips the host's own
// expansion flag, so the keyboard path (`app.tools.expand` / ctrl+o) and the mouse
// can never disagree and the card keeps no expansion state of its own. Every
// other gesture and every cell outside the card stays the host's (text selection,
// links, right-click paste).
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
	return cardLine(theme.fg(RUNNING_ROLE, RUNNING_TEXT), tone, theme, width, metrics);
}

/**
 * Calls may continue long or multiline headings inside the same frame. A detail
 * that cannot share the top rule without crowding the call (or its key hint)
 * continues on card rows below it, so a long call stays fully visible instead of
 * being truncated.
 */
function cardTopRows(card, theme, width, hint, metrics) {
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
		const [detailFirst = '', ...detailRest] = card.subtitle.split('\n');
		const detailWidth = metrics.visibleWidth(detailFirst) + 3;
		const inline = lead + metrics.visibleWidth(first) + detailWidth + hintWidth + 5 <= target;
		const shownHint = inline ? hint : hint && available - hintWidth >= MIN_HEADING_COLUMNS ? hint : undefined;
		const room = Math.max(1, available - (inline ? detailWidth : 0) - (shownHint ? hintWidth : 0));
		const [head = '', ...overflow] = metrics.wrapTextWithAnsi(first, room);
		const detail = inline
			? detailRest.map((line) => theme.fg(SUBTITLE_ROLE, line))
			: card.subtitle.split('\n').map((line, index) => theme.fg(SUBTITLE_ROLE, index === 0 ? `${SEPARATOR} ${line}` : line));
		return [
			cardTop({ ...card, subtitle: inline ? detailFirst : undefined, title: head }, theme, target, shownHint, metrics),
			...cardBodyRows([...overflow, ...rest, ...detail], card.tone, theme, target, { expanded: true }, metrics),
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
	// A heading that measures its own collapsed detail takes the room left once the
	// chrome and the key hint have taken theirs, so a script folds into a stated
	// count instead of vanishing behind an ellipsis.
	const subtitle = detail === undefined ? (card.subtitle ?? '').split('\n').join(' ') : detail(Math.max(1, room));
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
 */
function floatRows(tone, theme, width, render) {
	const target = Math.max(0, Math.floor(width));
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
	cardAwaitingResult,
	cardBodyRows,
	cardBottom,
	cardElapsed,
	cardInnerWidth,
	cardLine,
	cardMouseEvent,
	cardRunningLine,
	cardTop,
	cardTopLine,
	cardTopRows,
	floatRows,
	headingFits,
	markCardResult,
};

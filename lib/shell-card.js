'use strict';
// The drawing substrate of the Gentle card, outline style only.
//
// Ported from `lib/shell-card.ts` on the `cards-bash-v2` branch of gentle-shell
// (lib/shell-card.ts, 571 lines; its suite is tests/shell-card.test.ts). What is
// ported is the rounded frame — the geometry, the palette roles and the
// collapsed/expanded heading behaviour — because this package's two worktree
// tools draw their result cards with it (spec S5).
//
// Deliberately NOT ported, and why:
//   * the float style: its borderless chrome, the tone background painting
//     (`surfaceOpener`, `paintSurfaceRow`, `floatRows`, `styleRows`, `paintFloat`,
//     `floatPanel`, `panelHeader`, `panelInnerWidth`, `panelHeaderRow`,
//     `panelExtraRows`), the `▎ ` chrome table and every helper that exists only
//     to serve it. This package has no customize surface, so the outlined frame
//     is the only style.
//   * `cardStyle()` / `setCardStyle()` and the process-wide style slot: with one
//     style there is nothing to switch. `CARD_STYLE` keeps that one value.
//   * `renderCard` / `cardText` / `bodyLines`: whole-notice composition, which
//     belongs to the per-tool renderer that lands on top of this module.
//   * the identity rail (`Card.railRole`, `withRailRole`, `frameRole`,
//     `TONE_OWNS_BOX`): it exists so a quiet card's closed box can wear an ODD
//     phase's colour, which is a shell-internal notion. Without it every frame
//     cell is painted in the tone's frame role, exactly as the source does for a
//     card that names no rail.
//
// The card object this module draws has the source's shape:
//   { title, subtitle?, body: string[], tone, glyph?, titleRole? }
//
// Colour arrives as an injected theme: `fg(role, text)` returns a string. No ANSI
// escape is hardcoded here and no role name is invented — the roles are the
// source's `border`, `accent`, `success`, `warning`, `error`, `dim` and `muted`.
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

const CARD_TONE = {
	INFO: 'info',
	SUCCESS: 'success',
	WARNING: 'warning',
	ERROR: 'error',
};

// One style: the outlined rounded frame. The source names this style NEON (its
// alternative was FLOAT); this package has no float style, so the remaining value
// carries the name this package uses for the rounded frame.
const CARD_STYLE = {
	OUTLINE: 'outline',
};

const CARD_GLYPH = '✿';
// Frame and title paint with the same role for every tone except INFO, whose
// rounded frame stays in the theme's plain border role while its title carries
// the accent role.
const FRAME_ROLE = {
	[CARD_TONE.INFO]: 'border',
	[CARD_TONE.SUCCESS]: 'success',
	[CARD_TONE.WARNING]: 'warning',
	[CARD_TONE.ERROR]: 'error',
};
const TITLE_ROLE = {
	[CARD_TONE.INFO]: 'accent',
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

// The characters that draw the card around its content. Rows are built from these
// by position, so content that happens to contain box-drawing characters is never
// rewritten.
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

function rule(length) {
	return OUTLINE_CHROME.rule.repeat(Math.max(0, length));
}

function frameRole(tone) {
	return FRAME_ROLE[tone];
}

function titleRole(card) {
	return card.titleRole ?? TITLE_ROLE[card.tone];
}

function frame(theme, tone, painted) {
	return theme.fg(frameRole(tone), painted);
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
		return left + frame(theme, card.tone, `${rule(targetWidth - 2)}${OUTLINE_CHROME.topRight}`);
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
	return frame(theme, card.tone, OUTLINE_CHROME.topLeft) + frame(theme, card.tone, OUTLINE_CHROME.topLead) + styledTitle + frame(theme, card.tone, ` ${fill}`) + tail + frame(theme, card.tone, OUTLINE_CHROME.topRight);
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
	const left = frame(theme, tone, OUTLINE_CHROME.side);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, OUTLINE_CHROME.side);
	if (targetWidth === 3) return `${left} ${frame(theme, tone, OUTLINE_CHROME.side)}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? '' : metrics.truncateToWidth(text, innerWidth, '…');
	const padding = ' '.repeat(Math.max(0, innerWidth - metrics.visibleWidth(clipped)));
	return `${left} ${clipped}${padding} ${frame(theme, tone, OUTLINE_CHROME.rail)}`;
}

/** The closing rule, with its content right-aligned when enough fill columns stay free. */
function cardBottom(tone, theme, width, content, metrics) {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return '';
	const left = frame(theme, tone, OUTLINE_CHROME.bottomLeft);
	if (targetWidth === 1) return left;
	if (content === undefined || metrics.visibleWidth(content) === 0) return left + frame(theme, tone, `${rule(targetWidth - 2)}${OUTLINE_CHROME.bottomRight}`);
	const contentWidth = metrics.visibleWidth(content) + 2;
	// Responsive: the content rides the closing rule only when it fits with a minimum fill.
	if (targetWidth - 2 - contentWidth < 3) return left + frame(theme, tone, `${rule(targetWidth - 2)}${OUTLINE_CHROME.bottomRight}`);
	return left + frame(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `) + theme.fg(HINT_ROLE, content) + frame(theme, tone, ` ${OUTLINE_CHROME.bottomRight}`);
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

/**
 * Elapsed time for a closing rule, or undefined when the host reported no reliable
 * duration. Sub-second runs read in milliseconds, longer ones in seconds with one
 * decimal.
 */
function cardElapsed(durationMs) {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
	return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
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
	cardRunningLine,
	cardTop,
	cardTopLine,
	cardTopRows,
	headingFits,
	markCardResult,
};

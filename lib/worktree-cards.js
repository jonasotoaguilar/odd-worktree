'use strict';
// S5 / T5b: the call and result cards of the two worktree tools, drawn on the
// substrate of `lib/shell-card.js`.
//
// One factory builds both renderers, because both cards are the same card in two
// states: the call owns the heading (the tool's own name and its subject), the
// result owns the body (the tool's own text) and the closing rule, and the two
// halves meet as one rounded frame through the substrate's shared row mark. What
// each tool says is decided here; how a row is painted, wrapped and clipped is the
// substrate's (T5a), which is also where the tone roles come from.
//
// S5: the look is not decided here either. Every card is composed as its parts
// (`head`, `body`, `bottom`) and handed to the substrate's `floatRows`, which
// reads the style the shell chose ONCE per render and draws the whole card in it —
// the rounded neon frame, or the float rail over the tone background. Content,
// order, truncation, the collapsed preview and the elapsed time are the same text
// in both styles; only the chrome differs.
//
// The module is a pure function of its inputs plus that one read:
//   * text measurement is injected as `metrics` — the substrate's required seam —
//     so this package needs no node_modules and no host TUI package;
//   * colour is the injected `theme.fg(role, text)` (and its optional `bg`); no
//     escape sequence is written down here, and no role outside the substrate's
//     palette is asked for;
//   * the clock is not read: the elapsed time on the closing rule is the host's
//     own `durationMs`, rendered by the substrate;
//   * nothing is read from the filesystem or the process HERE. The style is the
//     substrate's own input (lib/card-style.js: the shell's live slot, else the
//     user's document, else float), so a style change reaches the next render
//     without this module knowing about it.
//
// Both tool results are plain `{text, details}` views (lib/worktree-create.js
// `worktreeCreateView`, lib/worktree-list.js `worktreeListView`) inside the host's
// result shape `{content: [{type: 'text', text}], details, isError?}`, and the
// body is exactly that text: no card ever reformats what the tool said.
//
// A refusal is the tool's error text — one sentence and, for a create, the second
// line that says what to do instead — and it is treated like any other body:
// expanded it is wrapped, never clipped, and a width too narrow for the sentence
// still shows all of it on more rows; collapsed it shows the first three rows of
// that same body, and the last one ends in `…`, so the reason is never silently
// eaten and the reader always knows there is more. Both halves are pinned by
// tools/worktree-cards.test.js.

const {
	CARD_TONE,
	cardAwaitingResult,
	cardBodyRows,
	cardBottom,
	cardElapsed,
	cardInnerWidth,
	cardRunningLine,
	cardTopLine,
	cardTopRows,
	floatRows,
	markCardResult,
} = require('./shell-card.js');

// The two tools this module draws, named as the host names them.
const WORKTREE_CARD_TOOLS = ['worktree_create', 'worktree_list'];

// The heading of each tool: the tool's own name, so the transcript never invents a
// second vocabulary for the same call. Both tools carry this package's git mark,
// one identity for every worktree card.
const TITLES = {
	worktree_create: 'worktree create',
	worktree_list: 'worktree list',
};
const GLYPH = '⎇';

// The host keybinding the expand affordance is bound to, and the two verbs the
// heading offers for it.
const EXPAND_KEYBINDING = 'app.tools.expand';
const EXPAND_TEXT = { collapsed: 'to expand', expanded: 'to collapse' };

// S5: the collapsed body budget. Expanded draws every row.
const PREVIEW_ROWS = 3;
// The literal the substrate clips with, reused as the "there is more" mark.
const ELLIPSIS = '…';

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const asFunction = (value) => (typeof value === 'function' ? value : undefined);

function assertMetrics(value) {
	if (value === null || typeof value !== 'object') {
		throw new TypeError('createWorktreeCards requires an injected metrics object ({visibleWidth, truncateToWidth, wrapTextWithAnsi})');
	}
	for (const name of METRICS_FUNCTIONS) {
		if (typeof value[name] !== 'function') {
			throw new TypeError(`createWorktreeCards requires metrics.${name} to be a function`);
		}
	}
}

/**
 * The text of a tool result: the host's `content` parts, or the `{text}` shape a
 * refusal forwarded from another tool carries. Nothing is reformatted, trimmed or
 * reordered — the card body IS what the tool said.
 */
function resultText(result) {
	const value = asObject(result);
	if (typeof value.text === 'string') return value.text;
	const parts = Array.isArray(value.content) ? value.content : [];
	return parts
		.map((part) => (typeof asObject(part).text === 'string' ? asObject(part).text : ''))
		.filter((text) => text.length > 0)
		.join('\n');
}

/** The detail the heading carries: the branch a create works on, `all` for a full list. */
function callDetail(toolName, args) {
	const value = asObject(args);
	if (toolName === 'worktree_create') {
		return typeof value.branch === 'string' && value.branch.length > 0 ? value.branch : undefined;
	}
	return value.all === true ? 'all' : undefined;
}

/** Whether the host asked for the expanded card. Both slots carry the flag. */
function isExpanded(options, context) {
	return asObject(options).expanded === true || asObject(context).expanded === true;
}

/**
 * The right-aligned dim hint the heading offers: the host's own keybinding text for
 * expanding (or collapsing) the card. No keybinding seam means no hint, and a
 * running row offers none at all.
 */
function expandHint(context, expanded) {
	const keyHint = asFunction(asObject(context).keyHint);
	if (!keyHint) return undefined;
	const text = keyHint(EXPAND_KEYBINDING, expanded ? EXPAND_TEXT.expanded : EXPAND_TEXT.collapsed);
	return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/** A row the host asked for, whatever it was: the floor the substrate itself uses. */
function rowWidth(width) {
	return Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
}

/**
 * The body rows of a result: the text wrapped to the inner width, capped by the
 * preview budget unless expanded, and with `…` on the last preview row when the
 * budget hides the rest. Painting, padding and clipping are the substrate's, so a
 * row is always exactly as wide as the card it belongs to.
 *
 * `width` is the width the component draws at — the full width in the neon style,
 * two columns narrower in float, where the substrate's margins live — so the body
 * wraps to the columns the chrome actually leaves in either style.
 *
 * Every row that survives the cap is a complete wrapped row — wrapping never cuts a
 * word — so the collapsed body is always the beginning of the expanded one.
 */
function resultBodyRows(text, tone, theme, width, expanded, metrics) {
	if (text.length === 0 || width <= 0) return [];
	const inner = cardInnerWidth(width);
	const wrapped = text
		.split('\n')
		.flatMap((line) => (line === '' ? [''] : metrics.wrapTextWithAnsi(line, inner)));
	const limit = expanded ? wrapped.length : Math.min(PREVIEW_ROWS, wrapped.length);
	const shown = wrapped.slice(0, limit);
	if (limit < wrapped.length && shown.length > 0) {
		// The mark replaces the last column of a full row instead of widening it, so the
		// row stays inside the card and no second wrap can push it onto another one.
		const last = shown[shown.length - 1];
		shown[shown.length - 1] = metrics.visibleWidth(last) >= inner
			? `${metrics.truncateToWidth(last, Math.max(0, inner - 1), '')}${ELLIPSIS}`
			: `${last}${ELLIPSIS}`;
	}
	return cardBodyRows(shown, tone, theme, width, { expanded: true }, metrics);
}

/** One tool's card renderers, bound to the injected text seam. */
function toolRenderer(toolName, metrics) {
	const title = TITLES[toolName];

	/** The call: the heading, the running row while pending, and its frame while it awaits the result. */
	function renderCall(args, theme, context) {
		const ctx = asObject(context);
		const pending = ctx.isPartial !== false;
		const failed = ctx.isError === true;
		const tone = failed ? CARD_TONE.ERROR : pending ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
		const expanded = isExpanded(undefined, ctx);
		const hint = pending || failed ? undefined : expandHint(ctx, expanded);
		const card = { title, subtitle: callDetail(toolName, args), body: [], tone, glyph: GLYPH };

		return component((width) => floatRows(tone, theme, width, (inner) => {
			const head = expanded
				? cardTopRows(card, theme, inner, hint, metrics)
				: [cardTopLine(card, theme, inner, hint, undefined, metrics)];
			const body = pending && !failed ? [cardRunningLine(tone, theme, inner, metrics)] : [];
			// The result that follows owns the closing rule; a call still waiting for it
			// closes its own frame, so a running row never floats outside one.
			const bottom = cardAwaitingResult(ctx) ? cardBottom(tone, theme, inner, undefined, metrics) : undefined;
			return { head, body, bottom };
		}));
	}

	/** The result: the tool's text as the body, then the closing rule with the elapsed time. */
	function renderResult(result, options, theme, context) {
		const opts = asObject(options);
		const ctx = asObject(context);
		const partial = opts.isPartial === true;
		const failed = asObject(result).isError === true || opts.isError === true || ctx.isError === true;
		const tone = failed ? CARD_TONE.ERROR : partial ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
		const expanded = isExpanded(opts, ctx);
		const text = resultText(result);
		// One frame: from here on the call above is a heading and this card closes it.
		markCardResult(ctx.state);

		return component((width) => floatRows(tone, theme, width, (inner) => {
			const body = resultBodyRows(text, tone, theme, inner, expanded, metrics);
			// A streamed result is not finished: the closing rule (and the time on it)
			// belongs to the final one, which the host renders when the call settles.
			const bottom = partial ? undefined : cardBottom(tone, theme, inner, cardElapsed(ctx.durationMs), metrics);
			// The call above owns the heading, so the float style still sets this body
			// off from it with its separator row.
			return { body, bottom, afterHeading: true };
		}));
	}

	return { renderCall, renderResult };
}

/**
 * The host component around one card: `render(width)` returns the lines for that
 * width and nothing else is remembered, so a card is a pure function of its
 * inputs and a re-render never drifts.
 */
function component(build) {
	return {
		render(width) {
			return build(rowWidth(width));
		},
		invalidate() {
			// Nothing is cached: there is no measurement to invalidate.
		},
	};
}

/**
 * One factory for both tools: `createWorktreeCards({ metrics })` returns
 * `renderer(toolName)` → `{renderCall(args, theme, context), renderResult(result,
 * options, theme, context)}`, the two hooks the host spreads over the tool
 * definitions. An unknown tool name is a programming error, not a card: the
 * removed tools must not silently borrow one of these.
 */
function createWorktreeCards(dependencies) {
	const { metrics } = asObject(dependencies);
	assertMetrics(metrics);
	const renderers = new Map();
	return {
		renderer(toolName) {
			if (!WORKTREE_CARD_TOOLS.includes(toolName)) {
				throw new Error(`unknown worktree tool: ${typeof toolName === 'string' ? toolName : typeof toolName}`);
			}
			let renderer = renderers.get(toolName);
			if (renderer === undefined) {
				renderer = toolRenderer(toolName, metrics);
				renderers.set(toolName, renderer);
			}
			return renderer;
		},
	};
}

module.exports = {
	ELLIPSIS,
	WORKTREE_CARD_TOOLS,
	createWorktreeCards,
};

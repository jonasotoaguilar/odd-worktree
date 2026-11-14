'use strict';
// D-A: a card's text is measured, wrapped and clipped BEFORE it is painted.
//
// The two card families (`lib/worktree-card.js`'s `/warp` message card and
// `lib/worktree-cards.js`'s tool cards) draw on the one substrate of
// `lib/shell-card.js`. That substrate hands a body row to the injected text seam
// and then paints it; a row that is painted FIRST is measured and clipped a
// second time as if every escape character were a column. With the host's
// ANSI-aware helpers that only costs a redundant pass. With the package's own
// fallback (`createWarpMessageRenderer()` with no helpers: an ANSI-aware
// `visibleWidth` beside an ANSI-UNAWARE `truncateToWidth`) it clips INTO the
// escape sequence: text is lost and a partial SGR is emitted onto the terminal.
//
// This suite pins the difference the way an independent verifier measured it:
//   * every fixture is rendered through the ANSI-aware helpers and through the
//     fallback, and the two must show the SAME text at the same width;
//   * no row may contain an escape character that is not part of a complete SGR
//     pair, on either path;
//   * the reported width-40 row is pinned literally, as the baseline drew it;
//   * the tool cards get the mirror: an ANSI-unaware clipping helper substituted
//     for the real one (the same latent order, only hidden today by the host's
//     ANSI-aware metrics) must not change the text either.
//
// The strongest case is structural, and it is the one the fix is named after: no
// helper is ever handed a painted string. The recording seam below fails the
// suite the moment one is.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { createWarpMessageRenderer, localTruncate } = require('../lib/worktree-card.js');
const { createWorktreeCards } = require('../lib/worktree-cards.js');

// ---- the style seam: the process-wide slot, and a scratch preference home ----

const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');

function useStyle(style) {
	if (style === undefined) delete globalThis[CARD_STYLE_SLOT];
	else globalThis[CARD_STYLE_SLOT] = style;
}

function withStyle(style, run) {
	useStyle(style);
	try {
		return run();
	} finally {
		useStyle(undefined);
	}
}

let configHome;
const savedHome = process.env.GENTLE_PI_CONFIG_HOME;

before(() => {
	// The renderer reads the shell's slot first and this document second; an empty
	// scratch home keeps the real user's preference out of the suite.
	configHome = mkdtempSync(join(tmpdir(), 'odd-warp-fallback-'));
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	useStyle(undefined);
});

after(() => {
	useStyle(undefined);
	if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
	rmSync(configHome, { recursive: true, force: true });
});

// ---- the text seam, in its two honest shapes ----

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => String(value).replace(ANSI, '');
// The fixtures are ASCII, so one code point is one column.
const columns = (value) => [...stripAnsi(value)].length;

/**
 * The host's helpers, ANSI aware: an escape never counts as a column, and
 * clipping measures what is left after the escapes are ignored. Colour is
 * dropped by the clip (the host re-applies it); the TEXT is what this suite
 * compares.
 */
const ansiAware = {
	visibleWidth: (value) => columns(value),
	truncateToWidth(value, width, ellipsis = '') {
		const plain = [...stripAnsi(value)];
		const tail = String(ellipsis ?? '');
		if (plain.length <= width) return value;
		const keep = Math.max(0, width - [...tail].length);
		return plain.slice(0, keep).join('') + tail;
	},
	wrapTextWithAnsi(value, width) {
		const budget = Math.max(1, Math.floor(Number(width) || 0));
		const plain = [...stripAnsi(value)];
		if (plain.length <= budget) return [stripAnsi(value)];
		const rows = [];
		for (let index = 0; index < plain.length; index += budget) rows.push(plain.slice(index, index + budget).join(''));
		return rows;
	},
};

/**
 * The same seam with ANSI-UNWARE clipping, which is exactly the pairing the
 * package's own fallback uses (`lib/worktree-card.js`'s local `visibleWidth`
 * beside its local `truncateToWidth`): the measurement ignores escapes, the
 * clip counts every character of them as a column.
 */
const countsEscapes = {
	visibleWidth: (value) => columns(value),
	truncateToWidth(value, width, ellipsis = '') {
		if (columns(value) <= width) return value;
		if (width <= 0) return '';
		const tail = String(ellipsis ?? '');
		const mark = [...tail].length >= width ? '' : tail;
		const budget = width - [...mark].length;
		let used = 0;
		let out = '';
		for (const char of String(value)) {
			if (used + 1 > budget) break;
			out += char;
			used += 1;
		}
		return out + mark;
	},
	wrapTextWithAnsi(value, width) {
		const budget = Math.max(1, Math.floor(Number(width) || 0));
		const all = [...String(value)];
		if (all.length <= budget) return [String(value)];
		const rows = [];
		for (let index = 0; index < all.length; index += budget) rows.push(all.slice(index, index + budget).join(''));
		return rows;
	},
};

// ---- one theme that really paints, so a clipped escape is observable ----

const ROLE_COLOUR = {
	text: 250,
	warning: 214,
	success: 40,
	error: 196,
	border: 244,
	accent: 213,
	dim: 240,
	muted: 245,
};
const BG_COLOUR = { toolSuccessBg: 22, toolPendingBg: 58, toolErrorBg: 52 };
const BG_RESET = '\x1b[49m';

function ansiTheme() {
	return {
		fg(role, value) {
			const colour = ROLE_COLOUR[role] ?? 250;
			return `\x1b[38;5;${colour}m${value}\x1b[0m`;
		},
		bg(role, value) {
			const colour = BG_COLOUR[role] ?? 236;
			return `\x1b[48;5;${colour}m${value}${BG_RESET}`;
		},
	};
}

/** Rows as the reader sees them: complete SGR pairs removed, nothing else. */
const textRows = (rows) => rows.map((row) => stripAnsi(row));

/** Every row is inside the width, and no incomplete escape sequence survives. */
function assertClean(rows, width, label) {
	for (const row of rows) {
		// A complete SGR pair is the theme's own paint, and expected. What must never
		// reach the terminal is the LEFTOVER of a sequence a clip cut in half, so the
		// check is made after the complete pairs are removed.
		const leftover = row.replace(ANSI, '');
		assert.equal(leftover.includes('\x1b'), false, `${label}: a partial escape sequence reached the terminal in ${JSON.stringify(row)}`);
		assert.ok(columns(row) <= width, `${label}: ${JSON.stringify(stripAnsi(row))} is wider than ${width}`);
	}
}

// ---- the fixtures: names and paths as long as a real ODD makes them ----

const WARP_FIXTURES = [
	{
		label: 'a realistic long ODD name',
		details: {
			fromName: 'feat-one',
			name: 'fix-long-and-realistic-feature-name',
			to: '/home/jona/dev/projects/odd-worktree-worktrees/fix-long-and-realistic-feature-name',
			branch: 'fix/long-and-realistic-feature-name',
		},
	},
	{
		label: 'two long names',
		details: {
			fromName: 'warp-queue-boundary-with-a-long-name',
			name: 'warp-fallback-regression-with-a-long-name',
			to: '/clone-worktrees/warp-fallback-regression-with-a-long-name',
			branch: 'feat/warp-fallback-regression-with-a-long-name',
		},
	},
	{
		label: 'the prose fallback',
		details: {},
		content: 'session warped to a checkout whose name is long enough to need clipping',
	},
	{
		label: 'a short name that fits every width',
		details: { fromName: 'feat-one', name: 'feat-two', to: '/clone-worktrees/feat-two', branch: 'feat/two' },
	},
];

const TOOL_FIXTURES = [
	{
		label: 'a created checkout on a long path',
		text: [
			'worktree created: /home/jona/dev/projects/odd-worktree-worktrees/fix-long-and-realistic-feature-name',
			'branch: fix/long-and-realistic-feature-name (created)',
			'setup: pnpm install · log: /home/jona/dev/projects/odd-worktree-worktrees/fix-long-and-realistic-feature-name/.worktree-setup.log',
		].join('\n'),
	},
	{
		label: 'a refusal that names the branch and the worktree',
		text: 'branch fix/long-and-realistic-feature-name is already checked out in /home/jona/dev/projects/odd-worktree-worktrees/fix-long-and-realistic-feature-name\nUse a different branch, or work in that worktree.',
	},
	{
		label: 'a list row wider than the card',
		text: 'worktree list: 2 checkouts\n1 fix-long-and-realistic-feature-name fix/long-and-realistic-feature-name',
	},
	{
		label: 'a short result',
		text: 'branch kept',
	},
];

const WIDTHS = [40, 60, 30, 24, 16];
const STYLES = ['neon', 'float'];

// ---- the `/warp` message card ----

function warpMessage(fixture, expanded) {
	return {
		customType: 'worktree-warp',
		content: fixture.content ?? 'x',
		details: { ...fixture.details, durationMs: 1200 },
		_expanded: expanded,
	};
}

function renderWarp(fixture, { helpers, width, expanded, style }) {
	const message = warpMessage(fixture, expanded);
	const theme = ansiTheme();
	const options = { expanded };
	return withStyle(style, () => createWarpMessageRenderer(helpers)(message, options, theme).render(width));
}

test('the fallback warp card shows exactly the text the ANSI-aware helpers show', () => {
	let pairs = 0;
	for (const fixture of WARP_FIXTURES) {
		for (const width of WIDTHS) {
			for (const expanded of [false, true]) {
				for (const style of STYLES) {
					const label = `${fixture.label} @${width} ${style} expanded=${expanded}`;
					const injected = renderWarp(fixture, { helpers: ansiAware, width, expanded, style });
					const fallback = renderWarp(fixture, { helpers: undefined, width, expanded, style });
					pairs += 1;
					assert.deepEqual(textRows(fallback), textRows(injected), `${label}: the fallback lost or gained text`);
					assertClean(fallback, width, `${label} (fallback)`);
					assertClean(injected, width, `${label} (injected)`);
				}
			}
		}
	}
	assert.ok(pairs > 0, 'the matrix rendered');
});

test('the reported width-40 row reads as the baseline drew it', () => {
	const fixture = WARP_FIXTURES[0];
	for (const helpers of [ansiAware, undefined]) {
		const rows = renderWarp(fixture, { helpers, width: 40, expanded: false, style: 'neon' });
		const row = rows.find((value) => stripAnsi(value).includes('to: '));
		assert.equal(row === undefined, false, 'the target row is drawn');
		// The baseline (HEAD, no body role) clipped the plain row to the inner width;
		// the fallback must reproduce that clip exactly, not shorten it.
		assert.equal(stripAnsi(row), '│ to: fix-long-and-realistic-feature-… │');
	}
});

// ---- the tool cards, on the same substrate ----

const cards = createWorktreeCards({ metrics: ansiAware });
const fallbackCards = createWorktreeCards({ metrics: countsEscapes });

function renderResult(factory, fixture, { width, expanded, style }) {
	const theme = ansiTheme();
	const result = { content: [{ type: 'text', text: fixture.text }], details: {} };
	return withStyle(style, () => factory
		.renderer('worktree_list')
		.renderResult(result, { expanded, isPartial: false }, theme, { durationMs: 1200 })
		.render(width));
}

test('a tool result body clipped on the ANSI-unaware helper shows the same text', () => {
	let pairs = 0;
	for (const fixture of TOOL_FIXTURES) {
		for (const width of WIDTHS) {
			for (const expanded of [false, true]) {
				for (const style of STYLES) {
					const label = `${fixture.label} @${width} ${style} expanded=${expanded}`;
					const injected = renderResult(cards, fixture, { width, expanded, style });
					const fallback = renderResult(fallbackCards, fixture, { width, expanded, style });
					pairs += 1;
					assert.deepEqual(textRows(fallback), textRows(injected), `${label}: the body changed with the helper`);
					assertClean(fallback, width, `${label} (unaware clip)`);
					assertClean(injected, width, `${label} (ANSI-aware clip)`);
				}
			}
		}
	}
	assert.ok(pairs > 0, 'the matrix rendered');
});

test('a clipped tool body row ends on the same column, with the same mark', () => {
	const fixture = TOOL_FIXTURES[1];
	for (const width of [40, 24]) {
		const injected = renderResult(cards, fixture, { width, expanded: false, style: 'neon' });
		const fallback = renderResult(fallbackCards, fixture, { width, expanded: false, style: 'neon' });
		assert.deepEqual(textRows(fallback), textRows(injected));
		for (const row of fallback.slice(0, -1)) assert.equal(columns(row), width, 'a body row fills the card');
	}
});

// ---- the host's truncation rule, at the widths where the ellipsis bites ----
//
// THE RULE IS THE HOST'S, not this package's: `truncateToWidth` in the installed
// `@earendil-works/pi-tui/dist/utils.js` returns the empty string for a width of
// zero or less, leaves text that fits UNCHANGED, clips and emits the ELLIPSIS
// ITSELF when the ellipsis is at least as wide as the budget (so width 1 of an
// overflowing string is `…`, not its first column), and otherwise keeps
// `width - ellipsisWidth` columns and appends the ellipsis. The table below is
// that rule written down, not a report of what this package happens to draw.
const HOST_RULE = [
	{ width: 0, shown: '' },
	{ width: 1, shown: '…' },
	{ width: 2, shown: 'a…' },
	{ width: 3, shown: 'ab…' },
	{ width: 4, shown: 'abc…' },
];

// `lib/worktree-card.js` owns the only clip this package implements (the
// fallback seam of the `/warp` card), so its rule is stated directly.
test("the local fallback truncator implements the host's rule at every width", () => {
	for (const { width, shown } of HOST_RULE) {
		assert.equal(localTruncate('abcdef', width, '…'), shown, `an overflowing row at width ${width}`);
	}
	assert.equal(localTruncate('abcdef', 6, '…'), 'abcdef', 'text that exactly fits is unchanged');
	assert.equal(localTruncate('abcdef', 40, '…'), 'abcdef', 'and so is text that fits with room to spare');
	assert.equal(localTruncate('', 3, '…'), '', 'empty text stays empty');
	// The rule holds for any ellipsis width, not just one column: an ellipsis at
	// least as wide as the budget is itself clipped and emitted.
	assert.equal(localTruncate('abcdef', 1, '...'), '.', 'a three-column ellipsis keeps one of its columns at width 1');
	assert.equal(localTruncate('abcdef', 2, '...'), '..', 'and two at width 2');
	assert.equal(localTruncate('abcdef', 3, '...'), '...', 'it fills the budget exactly at its own width');
	assert.equal(localTruncate('abcdef', 4, '...'), 'a...', 'one column past it, the text keeps a column first');
	// Whole cells only: a wide character is never cut in half.
	assert.equal(localTruncate('日本語', 2, '…'), '…', 'no half cell at width 2');
	assert.equal(localTruncate('日本語', 4, '…'), '日…', 'and the columns that fit are kept whole');
});

// The same rule as the cards draw it: card width = inner width + the four chrome
// columns (`│ … │`). The row is `moved: main`, which overflows every width here.
const BOUNDARY_ROWS = [
	{ inner: 0, shown: '' },
	{ inner: 1, shown: '…' },
	{ inner: 2, shown: 'm…' },
	{ inner: 3, shown: 'mo…' },
	{ inner: 4, shown: 'mov…' },
];

/** The one body row of a two-row compact card, as `rows.slice(1, -1)`.
 * Its content cell is the columns between the frame's `│ ` and its ` │`. */
function bodyCells(rows, inner) {
	return rows.slice(1, -1).map((row) => stripAnsi(row).slice(2, 2 + inner));
}

function shortWarpFixture() {
	return { label: 'two short names', details: { fromName: 'main', name: 'feat-two', to: '/clone-worktrees/feat-two', branch: 'feat/two' } };
}

test('the /warp card clips an overflowing row the way the host clips it', () => {
	const fixture = { label: 'a row wider than every boundary width', details: { fromName: 'main', name: 'a-long-enough-name' } };
	for (const { inner, shown } of BOUNDARY_ROWS) {
		for (const style of STYLES) {
			const label = `inner ${inner} ${style}`;
			const injected = renderWarp(fixture, { helpers: ansiAware, width: inner + 4, expanded: false, style });
			const fallback = renderWarp(fixture, { helpers: undefined, width: inner + 4, expanded: false, style });
			// The first body row shows the rule's own answer on BOTH seams...
			assert.equal(bodyCells(fallback, inner)[0], shown, `${label}: the fallback clip is the host's rule`);
			assert.equal(bodyCells(injected, inner)[0], shown, `${label}: the host's own helper agrees`);
			// ...and the whole card agrees, so the clip alone moved.
			assert.deepEqual(textRows(fallback), textRows(injected), `${label}: the fallback lost or gained text`);
			assertClean(fallback, inner + 4, `${label} (fallback)`);
		}
	}
});

test('a /warp row that fits is drawn unchanged at the boundary widths', () => {
	const fixture = shortWarpFixture();
	for (const inner of [0, 1, 2, 3, 4, 20]) {
		const injected = renderWarp(fixture, { helpers: ansiAware, width: inner + 4, expanded: false, style: 'neon' });
		const fallback = renderWarp(fixture, { helpers: undefined, width: inner + 4, expanded: false, style: 'neon' });
		assert.deepEqual(textRows(fallback), textRows(injected), `inner ${inner}: the fallback lost or gained text`);
		if (inner >= 'moved: main'.length) {
			assert.equal(bodyCells(fallback, inner)[0], 'moved: main'.padEnd(inner), 'a row that fits is padded, never clipped');
		}
	}
});

// The verifier's own independent boundary case, folded in faithfully: it is NOT a
// byte-for-byte copy of the verifier's file — this suite adapts it to its own
// fixtures (`content: 'x'` instead of an empty string, the style slot reset through
// `useStyle` instead of a local wrapper, no expansion). What is identical is the
// part that matters: a renderer built with no dependencies, a theme that paints
// every role `\x1b[37m…\x1b[39m`, the same message details, and the exact two
// widths with the exact expected rows the verifier reproduced the defect at.
// Do not describe this as verbatim; it is equivalent, and both widths must pass.
const VERIFIER_THEME = { fg: (_role, value) => `\x1b[37m${value}\x1b[39m` };
const VERIFIER_MESSAGE = { customType: 'worktree-warp', content: 'x', details: { fromName: 'main', name: 'long-name' } };

/** The verifier's render: no injected helpers, no style slot, no expansion. */
function verifierRows(width) {
	useStyle(undefined);
	return createWarpMessageRenderer()(VERIFIER_MESSAGE, {}, VERIFIER_THEME).render(width);
}

test("the verifier's independent boundary case renders the host's rows", () => {
	const cases = [
		[5, ['│ … │', '│ … │']],
		[6, ['│ m… │', '│ t… │']],
	];
	for (const [width, expected] of cases) {
		const rows = verifierRows(width).map((row) => stripAnsi(row)).slice(1, -1);
		assert.deepEqual(rows, expected, `width ${width}`);
	}
});

// The tool cards clip through the same substrate step, so the boundary widths are
// pinned there too, with the package's own fallback truncator in the clip seat:
// the two seams must agree at every width (nothing in this family needs the
// ellipsis rule yet, and nothing may start to).
const localSeam = {
	visibleWidth: (value) => columns(value),
	truncateToWidth: (value, width, ellipsis = '') => localTruncate(value, width, ellipsis),
	wrapTextWithAnsi: ansiAware.wrapTextWithAnsi,
};
const localCards = createWorktreeCards({ metrics: localSeam });

test('the tool cards keep the host rule at the boundary widths', () => {
	for (const fixture of TOOL_FIXTURES) {
		for (const inner of [0, 1, 2, 3, 4]) {
			for (const expanded of [false, true]) {
				for (const style of STYLES) {
					const label = `${fixture.label} inner ${inner} ${style} expanded=${expanded}`;
					const injected = renderResult(cards, fixture, { width: inner + 4, expanded, style });
					const fallback = renderResult(localCards, fixture, { width: inner + 4, expanded, style });
					assert.deepEqual(textRows(fallback), textRows(injected), `${label}: the fallback clip changed the text`);
					assertClean(fallback, inner + 4, `${label} (fallback)`);
				}
			}
		}
	}
});

// ---- the invariant itself: the BODY path never measures a painted string ----
//
// Scope, deliberately: this guard renders result bodies, never a call heading.
// The heading carries the host's `keyHint`, which the host paints `dim`/`muted`
// BEFORE handing it over, and `cardTop` legitimately measures that painted string
// with `visibleWidth`. So the truthful claim is "no string THIS REPO painted is
// measured", not "no helper ever sees paint" — an absolute assertion would fail on
// the host's own hint and would tempt a future reader to "fix" working code.

/** A seam that records every string the substrate asks it to measure or clip. */
function recordingSeam() {
	const seen = [];
	const record = (value) => {
		seen.push(String(value));
		return value;
	};
	return {
		seen,
		metrics: {
			visibleWidth(value) {
				record(value);
				return columns(value);
			},
			truncateToWidth(value, width, ellipsis) {
				record(value);
				return ansiAware.truncateToWidth(value, width, ellipsis);
			},
			wrapTextWithAnsi(value, width) {
				record(value);
				return ansiAware.wrapTextWithAnsi(value, width);
			},
		},
	};
}

test('the body path never measures or clips a painted string, in either card family', () => {
	const seam = recordingSeam();
	const painted = createWorktreeCards({ metrics: seam.metrics });
	for (const fixture of TOOL_FIXTURES) {
		for (const width of [60, 40, 24]) {
			for (const expanded of [false, true]) {
				renderResult(painted, fixture, { width, expanded, style: 'neon' });
			}
		}
	}
	// The warp card resolves its own fallback seam, so its painted strings are
	// observed through the same guard: a clipped row that still holds an escape
	// character proves the paint happened before the measurement.
	for (const fixture of WARP_FIXTURES) {
		for (const width of [60, 40, 24, 16]) {
			for (const expanded of [false, true]) {
				renderWarp(fixture, { helpers: undefined, width, expanded, style: 'neon' });
			}
		}
	}
	assert.ok(seam.seen.length > 0, 'the seam was exercised');
	for (const value of seam.seen) {
		assert.equal(value.includes('\x1b'), false, `a painted string reached the text seam: ${JSON.stringify(value)}`);
	}
});

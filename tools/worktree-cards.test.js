'use strict';
// S5 / T5b: the two worktree tools' call and result cards, drawn on the substrate
// of lib/shell-card.js (T5a). Every case goes through the module's public surface
// — `createWorktreeCards({ metrics })` and the renderer it hands back per tool —
// and reads the lines an injected component produces for a width.
//
// The text seam and the themes are the same fakes tools/shell-card.test.js uses:
// this package has no node_modules, so width measurement, truncation and wrapping
// are injected, and colour only ever arrives as `theme.fg(role, text)`.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { before, after, test } = require('node:test');

const { ELLIPSIS, WORKTREE_CARD_TOOLS, createWorktreeCards } = require('../lib/worktree-cards.js');
const { worktreeListView } = require('../lib/worktree-list.js');
const { CARD_STYLE } = require('../lib/card-style.js');

// ---- the injected text seam (fakes: plain ASCII, each character one column) ----

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const chars = (value) => [...stripAnsi(value)];

const metrics = {
	visibleWidth(value) {
		return chars(value).length;
	},
	truncateToWidth(value, width, ellipsis = '') {
		if (width <= 0) return '';
		if (this.visibleWidth(value) <= width) return value;
		const tail = ellipsis ?? '';
		const keep = Math.max(0, width - [...tail].length);
		return chars(value).slice(0, keep).join('') + tail;
	},
	wrapTextWithAnsi(value, width) {
		const words = stripAnsi(value).split(' ');
		if (width <= 0) return [stripAnsi(value)];
		const lines = [];
		let current = '';
		for (const word of words) {
			const candidate = current === '' ? word : `${current} ${word}`;
			if ([...candidate].length <= width) {
				current = candidate;
				continue;
			}
			if (current !== '') {
				lines.push(current);
				current = '';
			}
			if ([...word].length <= width) {
				current = word;
				continue;
			}
			const rest = [...word];
			while (rest.length > width) lines.push(rest.splice(0, width).join(''));
			current = rest.join('');
		}
		lines.push(current);
		return lines;
	},
};

// ---- themes: a theme is an injected fg(role, text) ----

const plainTheme = {
	fg(_role, value) {
		return value;
	},
};

const taggedTheme = {
	fg(role, value) {
		return `<${role}>${value}</${role}>`;
	},
};

function recordingTheme() {
	const roles = [];
	return {
		roles,
		fg(role, value) {
			roles.push(role);
			return value;
		},
	};
}

// S5: the style seam — the process-wide slot Gentle Shell publishes — and a
// scratch preference home, so no case reads or writes the real user's document.
const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');
const BG_RESET = '\x1b[49m';

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

/** A plain theme that can also paint the float background, so the text stays readable. */
function paintTheme() {
	const roles = { fg: [], bg: [] };
	return {
		roles,
		fg(role, value) {
			roles.fg.push(role);
			return value;
		},
		bg(role, value) {
			roles.bg.push(role);
			return `\x1b[48;5;240m${value}${BG_RESET}`;
		},
	};
}

const savedHome = process.env.GENTLE_PI_CONFIG_HOME;
let configHome;

before(() => {
	configHome = mkdtempSync(join(tmpdir(), 'odd-worktree-card-style-'));
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	useStyle(undefined);
});

after(() => {
	useStyle(undefined);
	if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
	rmSync(configHome, { recursive: true, force: true });
});

// ---- the factory, and the two calls every case makes ----

const cards = createWorktreeCards({ metrics });

function callRows(tool, args, theme, context, width) {
	return cards.renderer(tool).renderCall(args, theme, context).render(width);
}

function resultRows(tool, result, options, theme, context, width) {
	return cards.renderer(tool).renderResult(result, options, theme, context).render(width);
}

const call = (tool, args, theme, context, width) => callRows(tool, args, theme, context ?? {}, width);

/** Joining wrapped rows back into one string: only the whitespace the wrap introduced is ignored. */
const squash = (value) => value.replace(/\s+/g, '');

function textResult(text, isError) {
	return { content: [{ type: 'text', text }], details: {}, ...(isError ? { isError: true } : {}) };
}

/** The visible content of a body row, without the frame. */
function bodyText(row) {
	return stripAnsi(row).replace(/^│ /, '').replace(/ +│$/, '');
}

/** Every row the card draws must be exactly the width the host asked for. */
function assertFramed(rows, width) {
	for (const row of rows) assert.equal(metrics.visibleWidth(row), width, `"${stripAnsi(row)}" is not ${width} wide`);
}

const CREATE_ARGS = { branch: 'feat/cards-v2' };
const CREATE_TEXT = [
	'worktree created: /home/jona/dev/projects/odd-worktree-worktrees/cards-v2',
	'branch: feat/cards-v2 (created)',
	'odd: -',
	'base: main@1a2b3c4',
	'worktree register in session',
	'setup: pnpm install · log: /home/jona/dev/projects/odd-worktree-worktrees/cards-v2/.worktree-setup.log',
].join('\n');
const REFUSAL_TEXT = [
	'branch feat/cards-v2 is already checked out in /home/jona/dev/projects/odd-worktree-worktrees/cards-v2',
	'Use a different branch, or work in that worktree.',
].join('\n');

function listViewOf(all) {
	// S3: the list's real input — Git's own worktree listing and the canonical main
	// root. The main checkout is listed first and unnumbered; the checkout under
	// `<repo-name>-worktrees` is one this package created, named by its directory.
	return worktreeListView({
		project: 'gentle-shell',
		all,
		mainRoot: '/clone',
		entries: [
			{ path: '/clone', branch: 'main', head: '1a2b3c4' },
			{ path: '/clone-worktrees/cards-v2', branch: 'feat/cards-v2', head: '9f8e7d6' },
		],
	});
}

// ---- the factory ----

test('the factory hands one renderer per worktree tool and refuses anything else', () => {
	assert.deepEqual(WORKTREE_CARD_TOOLS, ['worktree_create', 'worktree_list'], 'the two tools this module draws');
	assert.equal(ELLIPSIS, '…', 'the overflow mark is the substrate literal, never a three dot ellipsis');
	const made = createWorktreeCards({ metrics });
	for (const tool of ['worktree_create', 'worktree_list']) {
		const renderer = made.renderer(tool);
		assert.equal(typeof renderer.renderCall, 'function', `${tool} renders its call`);
		assert.equal(typeof renderer.renderResult, 'function', `${tool} renders its result`);
		assert.equal(typeof renderer.renderCall({}, plainTheme, {}).render, 'function', `${tool} returns a component`);
	}
	assert.throws(() => made.renderer('worktree_delete'), /unknown worktree tool: worktree_delete/, 'the removed tools have no card');
	assert.throws(() => made.renderer('worktree_warp'), /unknown worktree tool/);
	assert.throws(() => made.renderer(undefined), /unknown worktree tool/);
});

test('the factory requires the injected text seam and says which measure is missing', () => {
	assert.throws(() => createWorktreeCards(), /metrics/);
	assert.throws(() => createWorktreeCards({}), /metrics/);
	for (const name of ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi']) {
		const broken = { ...metrics, [name]: undefined };
		assert.throws(() => createWorktreeCards({ metrics: broken }), new RegExp(name));
	}
});

// ---- the call card ----

test('a collapsed call is one heading row naming the tool and its detail', () => {
	const rows = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: false }, 60);
	assert.equal(rows.length, 1, 'a finished call draws its heading and lets the result close the frame');
	assert.equal(rows[0], `╭─ ⎇ worktree create · feat/cards-v2 ${'─'.repeat(22)}╮`);
	assertFramed(rows, 60);

	const all = call('worktree_list', { all: true }, plainTheme, { isPartial: false }, 60);
	assert.equal(all[0], `╭─ ⎇ worktree list · all ${'─'.repeat(34)}╮`);

	const plain = call('worktree_list', {}, plainTheme, { isPartial: false }, 60);
	assert.equal(plain[0], `╭─ ⎇ worktree list ${'─'.repeat(40)}╮`, 'an omitted all adds no detail');
	const omitted = call('worktree_list', { all: false }, plainTheme, { isPartial: false }, 60);
	assert.equal(omitted[0], plain[0], 'all: false is not the detail the flag names');

	const wide = call('worktree_create', { branch: 'feat/a-very-long-branch-name-that-cannot-fit-the-rule-anywhere' }, plainTheme, { isPartial: false }, 60);
	assert.equal(wide.length, 1, 'a collapsed call never grows a second row');
	assert.match(wide[0], /… ╮$/, 'an over-wide detail is truncated with a literal ellipsis');
	assert.doesNotMatch(wide[0], /anywhere/, 'only what fits stays visible');
	assertFramed(wide, 60);
});

test('an expanded call wraps the heading onto body rows instead of losing the detail', () => {
	const branch = 'feat/a-very-long-branch-name-that-cannot-fit-the-rule-anywhere';
	const rows = call('worktree_create', { branch }, plainTheme, { isPartial: false, expanded: true }, 60);
	assert.ok(rows.length > 1, 'the detail continues inside the frame');
	assert.match(rows[0], /^╭─ ⎇ worktree create ─+╮$/, 'the title keeps the top rule');
	assert.ok(!rows[0].includes('feat/'), 'a detail too wide for the rule never crowds the title');
	assertFramed(rows, 60);
	const shown = rows.slice(1).map(bodyText).join('');
	assert.equal(squash(shown), squash(`· ${branch}`), 'the complete detail stays visible');
});

test('a running call draws one muted running row and closes its own frame in warning', () => {
	const rows = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: true }, 40);
	assert.equal(rows.length, 3, 'a heading, the running row and the closed frame');
	assert.equal(rows[0], `╭─ ⎇ worktree create · feat/cards-v2 ${'─'.repeat(2)}╮`);
	assert.equal(rows[1], `│ running…${' '.repeat(28)} │`);
	assert.equal(rows[2], `╰${'─'.repeat(38)}╯`);
	assert.equal(rows[1].includes('\x1b'), false, 'the running text carries no escape of its own');

	const recorder = recordingTheme();
	call('worktree_create', CREATE_ARGS, recorder, { isPartial: true }, 40);
	assert.deepEqual([...new Set(recorder.roles)].sort(), ['muted', 'warning'], 'the running text is muted and the frame keeps the tone');

	const tagged = call('worktree_create', CREATE_ARGS, taggedTheme, { isPartial: true }, 40);
	assert.match(tagged[0], /^<warning>╭<\/warning>/, 'pending is the warning tone');
	assert.match(tagged[1], /^<warning>│<\/warning> <muted>running…<\/muted>/, 'the running text is the muted role');

	// Settling moves the very same heading to success and drops the running row.
	const settledRows = call('worktree_create', CREATE_ARGS, taggedTheme, { isPartial: false }, 40);
	assert.match(settledRows[0], /^<success>╭<\/success>/);
	assert.equal(settledRows.some((row) => row.includes('running')), false);

	const failed = call('worktree_create', CREATE_ARGS, taggedTheme, { isPartial: false, isError: true }, 40);
	assert.match(failed[0], /^<error>╭<\/error>/, 'a failed call is the error tone');
});

test('a call shows the host key hint only while it is settled and the row has room', () => {
	const keyHint = (id, text) => (id === 'app.tools.expand' ? `ctrl+o ${text}` : '');
	const rows = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: false, keyHint }, 60);
	assert.equal(rows.length, 1);
	assert.match(rows[0], /─+ ctrl\+o to expand ╮$/);
	assertFramed(rows, 60);

	const narrow = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: false, keyHint }, 30);
	assert.equal(narrow.length, 1);
	assert.doesNotMatch(narrow[0], /ctrl\+o/, 'the hint yields its columns before the detail loses its identity');
	assert.match(narrow[0], /^╭─ ⎇ worktree create · feat… ╮$/, 'the detail keeps an ellipsis and the heading keeps its title');
	assertFramed(narrow, 30);

	const running = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: true, keyHint }, 60);
	assert.doesNotMatch(running[0], /ctrl\+o/, 'a running row offers no expand affordance');

	const withoutHint = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: false }, 60);
	const silent = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: false, keyHint: () => '' }, 60);
	assert.equal(silent[0], withoutHint[0], 'an empty hint is not painted');
});

test('a call and its result share one frame, whichever render the host arrives at first', () => {
	// Pending call, no result yet: the call closes its own frame.
	const pending = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: true }, 40);
	assert.equal(pending.at(-1).startsWith('╰'), true);

	// The result marks the shared row state, so the call above stops closing.
	const state = {};
	const result = resultRows('worktree_create', textResult(CREATE_TEXT), { expanded: false, isPartial: false }, plainTheme, { state }, 40);
	assert.equal(result.at(-1).startsWith('╰'), true, 'the result draws the closing rule');
	const afterResult = call('worktree_create', CREATE_ARGS, plainTheme, { isPartial: true, state }, 40);
	assert.equal(afterResult.some((row) => row.startsWith('╰')), false, 'the result owns the only closing rule');
	assert.equal(afterResult[0].startsWith('╭'), true);
	assert.deepEqual(Object.keys(state), [], 'the shared mark is not ordinary row state');
});

// ---- the result card ----

test("a result body is the tool's own text, wrapped, padded and closed by one rule", () => {
	const rows = resultRows('worktree_create', textResult(CREATE_TEXT), { expanded: true, isPartial: false }, plainTheme, {}, 60);
	assert.match(rows[0], /^│ /, 'the call above owns the header, so the result starts at its body');
	assert.equal(rows.at(-1), `╰${'─'.repeat(58)}╯`);
	assertFramed(rows, 60);
	assert.ok(!rows.some((row) => row.includes('╭')), 'a result never draws a second header');
	const body = rows.slice(0, -1).map(bodyText);
	assert.equal(squash(body.join('')), squash(CREATE_TEXT), 'every character of the text survives the wrap');

	// The list result carries the list view's own text, unchanged in order.
	const view = listViewOf(true);
	const listRows = resultRows('worktree_list', textResult(view.text), { expanded: true, isPartial: false }, plainTheme, {}, 40);
	assertFramed(listRows, 40);
	const listBody = listRows.slice(0, -1).map(bodyText);
	assert.equal(listBody[0], 'project: gentle-shell');
	assert.equal(listBody[1], 'path: /clone');
	assert.equal(listBody[2], 'main: main 1a2b3c4', 'the main row carries no stored state suffix');
	assert.equal(listBody[3], '1 cards-v2 feat/cards-v2', 'the row carries the checkout name and its branch');
});

test('a collapsed result shows at most three body rows and marks what it hides', () => {
	const short = 'worktree created: /clone-worktrees/cards-v2';
	const shortRows = resultRows('worktree_create', textResult(short), { expanded: false, isPartial: false }, plainTheme, {}, 60);
	assert.equal(shortRows.length, 2, 'one body row and the closing rule');
	assert.equal(bodyText(shortRows[0]), short);
	assert.equal(shortRows[0].includes('…'), false, 'nothing hidden, no overflow mark');

	const collapsed = resultRows('worktree_create', textResult(CREATE_TEXT), { expanded: false, isPartial: false }, plainTheme, {}, 60);
	assert.equal(collapsed.length, 4, 'three body rows and the closing rule');
	for (const row of collapsed.slice(0, 3)) assert.equal(bodyText(row).endsWith('…'), row === collapsed[2], 'only the last preview row marks the hidden text');
	assert.match(bodyText(collapsed[2]), /…$/, 'the reader is told the text continues');

	const expanded = resultRows('worktree_create', textResult(CREATE_TEXT), { expanded: true, isPartial: false }, plainTheme, {}, 60);
	assert.ok(expanded.length > collapsed.length, 'expanded shows all of it');
	assert.equal(expanded.some((row) => bodyText(row).endsWith('…')), false, 'an expanded body hides nothing');
	assert.deepEqual(
		collapsed.slice(0, 2).map(bodyText),
		expanded.slice(0, 2).map(bodyText),
		'the collapsed body is the beginning of the expanded one',
	);
});

test('a refusal stays fully readable expanded and keeps its reason collapsed', () => {
	for (const width of [60, 30]) {
		const expanded = resultRows('worktree_list', textResult(REFUSAL_TEXT, true), { expanded: true, isPartial: false }, plainTheme, {}, width);
		assertFramed(expanded, width);
		const body = expanded.slice(0, -1).map(bodyText);
		assert.equal(squash(body.join('')), squash(REFUSAL_TEXT), `no character of the reason is lost at ${width}`);
		assert.equal(body.some((row) => row.includes('…')), false, `the expanded refusal is clipped nowhere at ${width}`);
		assert.match(body[0], /^branch feat\/cards-v2 is/, `the reason opens the body at ${width}`);
		assert.ok(body.some((row) => row.includes('work in that worktree')), `the second line of the refusal survives at ${width}`);

		const collapsed = resultRows('worktree_list', textResult(REFUSAL_TEXT, true), { expanded: false, isPartial: false }, plainTheme, {}, width);
		assertFramed(collapsed, width);
		const preview = collapsed.slice(0, -1).map(bodyText);
		const budget = Math.min(3, body.length);
		assert.equal(preview.length, budget, `the preview budget holds at ${width}`);
		assert.match(preview[0], /^branch feat\/cards-v2 is/, `the collapsed reason is recognisable at ${width}`);
		assert.deepEqual(preview.slice(0, budget - 1), body.slice(0, budget - 1), `the collapsed refusal is the expanded refusal's beginning at ${width}`);
		if (body.length > budget) {
			assert.ok(preview[budget - 1].endsWith('…'), `the collapsed refusal says it continues at ${width}`);
			assert.ok(body[budget - 1].startsWith(preview[budget - 1].slice(0, -1)), `the mark replaces the tail of one row at ${width}`);
		} else {
			assert.equal(preview[budget - 1], body[budget - 1], `a reason that fits the preview is shown whole at ${width}`);
		}
	}
});

test('the tone follows the state: success when finished, warning pending, error on failure', () => {
	const result = (tool, value, options, context) => resultRows(tool, value, options, taggedTheme, context ?? {}, 40);

	assert.match(result('worktree_create', textResult(CREATE_TEXT), { expanded: false, isPartial: false })[0], /^<success>│<\/success>/);
	assert.match(result('worktree_list', textResult('project: x'), { expanded: false, isPartial: false })[0], /^<success>│<\/success>/, 'a list is not a failure');
	assert.match(result('worktree_create', textResult('boom', true), { expanded: false, isPartial: false })[0], /^<error>│<\/error>/, 'the tool own isError decides');
	assert.match(result('worktree_create', textResult('boom'), { expanded: false, isPartial: false }, { isError: true })[0], /^<error>│<\/error>/, 'so does the row isError');
	assert.match(result('worktree_create', textResult(CREATE_TEXT), { expanded: false, isPartial: true })[0], /^<warning>│<\/warning>/, 'a streamed result is still pending');

	const recorder = recordingTheme();
	resultRows('worktree_list', textResult('project: x'), { expanded: false, isPartial: false }, recorder, {}, 40);
	assert.deepEqual([...new Set(recorder.roles)].sort(), ['success'], 'a settled success paints only its own role');
});

test('the elapsed time rides the closing rule and yields when the rule has no room', () => {
	const withDuration = (durationMs, width) =>
		resultRows('worktree_list', textResult('project: x'), { expanded: false, isPartial: false }, plainTheme, { durationMs }, width);

	assert.equal(withDuration(1200, 40).at(-1), `╰${'─'.repeat(32)} 1.2s ╯`);
	assert.equal(withDuration(42, 40).at(-1), `╰${'─'.repeat(32)} 42ms ╯`);
	assert.equal(withDuration(1200, 12).at(-1), `╰──── 1.2s ╯`, 'three free fill columns are enough beyond the one the rule pads with');
	assert.equal(withDuration(1200, 10).at(-1), `╰${'─'.repeat(8)}╯`, 'two free columns are not: the time yields to the plain rule');
	assert.equal(withDuration(undefined, 40).at(-1), `╰${'─'.repeat(38)}╯`, 'no duration, no time on the rule');
	const partial = resultRows('worktree_list', textResult('working'), { expanded: false, isPartial: true }, plainTheme, { durationMs: 1200 }, 40);
	assert.equal(partial.at(-1).startsWith('╰'), false, 'a partial result does not close the frame yet');
});

// ---- purity ----

test('the module draws no ANSI and measures every row to the width it was given', () => {
	for (const tool of ['worktree_create', 'worktree_list']) {
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 30, 40, 60, 100]) {
			const callRowsForWidth = [
				...call(tool, CREATE_ARGS, plainTheme, { isPartial: true }, width),
				...call(tool, CREATE_ARGS, plainTheme, { isPartial: false, expanded: true }, width),
				...resultRows(tool, textResult(CREATE_TEXT), { expanded: false, isPartial: false }, plainTheme, {}, width),
				...resultRows(tool, textResult(REFUSAL_TEXT, true), { expanded: true, isPartial: false }, plainTheme, { durationMs: 1200 }, width),
				...resultRows(tool, textResult(''), { expanded: false, isPartial: false }, plainTheme, {}, width),
			];
			for (const row of callRowsForWidth) {
				assert.equal(row.includes('\x1b'), false, `no escape at width ${width}`);
				assert.equal(row.includes('\r'), false, `no carriage return at width ${width}`);
				assert.ok(metrics.visibleWidth(row) <= width, `"${row}" overflows ${width}`);
			}
		}
	}
});

test('the same inputs draw the same lines, and the source imports no host package', () => {
	const once = resultRows('worktree_create', textResult(CREATE_TEXT), { expanded: true, isPartial: false }, taggedTheme, { durationMs: 1200 }, 60);
	const twice = resultRows('worktree_create', textResult(CREATE_TEXT), { expanded: true, isPartial: false }, taggedTheme, { durationMs: 1200 }, 60);
	assert.deepEqual(twice, once);

	const source = readFileSync(join(__dirname, '..', 'lib', 'worktree-cards.js'), 'utf8');
	assert.doesNotMatch(source, /@earendil-works/, 'no host package is required');
	assert.doesNotMatch(source, /\\u001b|\\x1b/, 'no escape sequence is written down');
	assert.doesNotMatch(source, /require\(['"](?!\.\/|node:)/, 'the only imports are the substrate and Node builtins, if any');
	for (const forbidden of ['Date', 'process.', 'Math.random']) {
		assert.doesNotMatch(source, new RegExp(forbidden.replace('.', '\\.')), `${forbidden} stays out: the module is a pure function of its inputs`);
	}
});

// ---- S5: the two styles, one card ----

/** The card's text with every chrome cell removed: what the reader actually reads. */
function contentOf(rows) {
	return rows
		.map((row) => stripAnsi(row).replace(/[╭╮╰╯─│▎]/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((text) => text.length > 0)
		.join(' | ');
}

// Short lines only, so neither style's two-column difference can move a wrap
// boundary: this is the "same text, different chrome" card.
const SHORT_LIST = ['project: gentle-shell', 'path: /clone', 'main: main 1a2b3c4', '1 cards-v2 feat/cards-v2'].join('\n');
const CREATE_SHORT = ['worktree created: /clone-worktrees/cards-v2', 'branch: feat/cards-v2 (created)'].join('\n');

test('the same result card is the same text in float and in neon, and only the chrome differs', () => {
	const theme = paintTheme();
	for (const [tool, text] of [['worktree_list', SHORT_LIST], ['worktree_create', CREATE_SHORT]]) {
		for (const expanded of [false, true]) {
			const neon = withStyle(CARD_STYLE.NEON, () => resultRows(tool, textResult(text), { expanded, isPartial: false }, theme, { durationMs: 1200 }, 60));
			const float = withStyle(CARD_STYLE.FLOAT, () => resultRows(tool, textResult(text), { expanded, isPartial: false }, theme, { durationMs: 1200 }, 60));
			assert.equal(contentOf(float), contentOf(neon), `${tool} expanded=${expanded}: same body, same elapsed time`);
			assert.equal(neon.some((row) => row.includes('▎')), false, `${tool}: neon draws no rail`);
			assert.equal(float.some((row) => /[╭╮╰╯─│]/.test(row)), false, `${tool}: float draws no box`);
			assert.ok(contentOf(float).endsWith('1.2s'), `${tool}: the elapsed time survives in both styles`);
			for (const row of float) assert.equal(metrics.visibleWidth(row), 60, `${tool}: a float row is the width it was given`);
		}
	}
});

test('the collapsed three-row preview and its overflow mark survive the float style', () => {
	const theme = paintTheme();
	const long = Array.from({ length: 6 }, (_, index) => `row ${index + 1}`).join('\n');
	const neon = withStyle(CARD_STYLE.NEON, () => resultRows('worktree_list', textResult(long), { expanded: false, isPartial: false }, theme, {}, 40));
	const float = withStyle(CARD_STYLE.FLOAT, () => resultRows('worktree_list', textResult(long), { expanded: false, isPartial: false }, theme, {}, 40));
	assert.equal(contentOf(float), contentOf(neon), 'three preview rows and the same overflow mark');
	assert.match(contentOf(float), /row 3…/);
	assert.equal(contentOf(float).includes('row 4'), false, 'the fourth row is still hidden');
});

test('a float card paints the accent rail and the tone background, and draws no frame', () => {
	const theme = paintTheme();
	const pending = withStyle(CARD_STYLE.FLOAT, () => call('worktree_create', CREATE_ARGS, theme, { isPartial: true }, 40));
	for (const row of pending) {
		assert.equal(metrics.visibleWidth(row), 40, `"${stripAnsi(row)}" is not 40 wide`);
		assert.ok(row.startsWith(' \x1b[48;5;240m▎'), 'the margin, the background and the rail open every row');
		assert.ok(row.endsWith('\x1b[49m '), 'the background closes before the right margin');
	}
	assert.deepEqual(theme.roles.bg, ['toolPendingBg'], 'the pending tone paints the pending background');
	assert.equal(theme.roles.fg.includes('warning'), true, 'the rail and the label take the theme accent');
	assert.equal(theme.roles.fg.includes('error'), false);
	const visible = pending.map(stripAnsi);
	assert.equal(visible[0].trim(), '▎', 'a padding row sits above the heading');
	assert.match(visible[1], /^ ▎ ⎇ worktree create · feat\/cards-v2 +$/, 'the heading rides the rail');
	assert.equal(visible[2].trim(), '▎', 'and a separator row sits between the heading and the body');
	assert.match(visible[3], /^ ▎ running… +$/, 'the running row is painted like the rest of the card');

	// The state still reaches the background; the accent stays the theme orange.
	const settled = paintTheme();
	withStyle(CARD_STYLE.FLOAT, () => resultRows('worktree_list', textResult(SHORT_LIST), { expanded: true, isPartial: false }, settled, {}, 40));
	assert.deepEqual(settled.roles.bg, ['toolSuccessBg']);
	assert.equal(settled.roles.fg.includes('warning'), true);

	const failed = paintTheme();
	withStyle(CARD_STYLE.FLOAT, () => resultRows('worktree_list', textResult(REFUSAL_TEXT, true), { expanded: true, isPartial: false }, failed, {}, 40));
	assert.deepEqual(failed.roles.bg, ['toolErrorBg']);
	assert.equal(failed.roles.fg.includes('warning'), true, 'a refusal keeps its accent and its error background');
});

test('a call and its result share one float card, set off by the separator row', () => {
	const theme = paintTheme();
	const result = withStyle(CARD_STYLE.FLOAT, () => resultRows('worktree_list', textResult(SHORT_LIST), { expanded: true, isPartial: false }, theme, {}, 40));
	assert.equal(stripAnsi(result[0]).trim(), '▎', 'the result body opens with the separator row under the call above');
	assert.match(stripAnsi(result[1]), /^ ▎ project: gentle-shell +$/);
	assert.match(stripAnsi(result.at(-1)), /^ ▎ +$/, 'the closing row is the painted rule');

	const partial = withStyle(CARD_STYLE.FLOAT, () => resultRows('worktree_list', textResult(SHORT_LIST), { expanded: true, isPartial: true }, theme, {}, 40));
	assert.equal(stripAnsi(partial.at(-1)).includes('▎'), true, 'a streamed result still paints its rows');
	assert.equal(partial.length, result.length - 1, 'but leaves the closing row to the final result');
});

test('too narrow for float, or a theme without the background, the neon card answers', () => {
	const theme = paintTheme();
	const narrow = withStyle(CARD_STYLE.FLOAT, () => call('worktree_list', {}, theme, { isPartial: false }, 9));
	assert.match(stripAnsi(narrow[0]), /^╭─ /, 'nine columns is the neon frame');
	assert.equal(narrow.some((row) => row.includes('\x1b')), false, 'and nothing is painted behind it');
	assert.deepEqual(theme.roles.bg, [], 'the narrow card never asks for a background');

	const noBackground = withStyle(CARD_STYLE.FLOAT, () => call('worktree_list', {}, plainTheme, { isPartial: false }, 40));
	assert.match(stripAnsi(noBackground[0]), /^╭─ /, 'a theme with no bg keeps the frame');
});

test('the style is read on every render, so a live change reaches the very next card', () => {
	const theme = paintTheme();
	useStyle(CARD_STYLE.NEON);
	try {
		assert.match(stripAnsi(call('worktree_list', {}, theme, { isPartial: false }, 40)[0]), /^╭─ /);
		useStyle(CARD_STYLE.FLOAT);
		const float = call('worktree_list', {}, theme, { isPartial: false }, 40);
		assert.match(stripAnsi(float[0]), /^ ▎ /, 'the same renderer, the next style');
		useStyle(CARD_STYLE.NEON);
		assert.match(stripAnsi(call('worktree_list', {}, theme, { isPartial: false }, 40)[0]), /^╭─ /, 'and back again, with no rebuild');
	} finally {
		useStyle(undefined);
	}
});

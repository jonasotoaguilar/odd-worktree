'use strict';
// S5/S6: the `/warp` message card — the third bash surface — drawn on the same
// substrate as the two tool cards. Every case reads the public surface of
// lib/worktree-card.js (`createWarpMessageRenderer`) and asserts what a reader
// sees: the heading, the two ordered rows, the path and branch an expanded card
// adds, the ctrl+o hint and the closing rule — in whichever style the shell chose.
//
// The style is the process-wide slot Gentle Shell publishes with the user's
// document as the fallback, so this suite points `GENTLE_PI_CONFIG_HOME` at a
// scratch directory: no case reads or writes the real user's preference, and the
// slot is cleared after each case that sets it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createWarpMessageRenderer, safeText, stripAnsi, wrapTextToWidth } = require('../lib/worktree-card.js');
const { CARD_STYLE_SCHEMA } = require('../lib/card-style.js');

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
const styleDocument = () => join(configHome, 'card-style.json');

function writeStyleDocument(contents) {
	writeFileSync(styleDocument(), typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function removeStyleDocument() {
	try {
		unlinkSync(styleDocument());
	} catch {
		// Already absent: the missing document is the case under test.
	}
}

before(() => {
	configHome = mkdtempSync(join(tmpdir(), 'odd-warp-card-style-'));
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	useStyle(undefined);
});

after(() => {
	useStyle(undefined);
	if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
	rmSync(configHome, { recursive: true, force: true });
});

// ---- the injected text seam (fakes: plain ASCII, each character one column) ----

const stripAnsiAll = (value) => value.replace(/\x1b\[[0-9;]*m/g, '');
const chars = (value) => [...stripAnsiAll(value)];

const metrics = {
	visibleWidth(value) {
		return chars(value).length;
	},
	truncateToWidth(value, width, ellipsis = '') {
		if (width <= 0) return '';
		if (this.visibleWidth(value) <= width) return value;
		const keep = Math.max(0, width - [...String(ellipsis ?? '')].length);
		return chars(value).slice(0, keep).join('') + String(ellipsis ?? '');
	},
};

// ---- themes ----

const plainTheme = {
	fg(_role, value) {
		return value;
	},
};

// The background reset a Pi theme hands back at the end of `bg(role, "")`. It is
// spelled here, in the test, so the module under test carries no raw escape.
const BG_RESET = '\x1b[49m';

/** A plain theme that can also paint the float background and records every role. */
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

const MESSAGE = {
	customType: 'worktree-warp',
	content: 'session warped to feat-two (this prose never enters the card)',
	details: {
		fromName: 'feat-one',
		name: 'feat-two',
		to: '/clone-worktrees/feat-two',
		branch: 'feat/two',
	},
};

/** The renderer the extension registers, with the host's own text seam injected. */
function renderer(helpers = metrics) {
	return createWarpMessageRenderer(helpers);
}

function renderWarp(style, { message = MESSAGE, options = {}, theme = plainTheme } = {}) {
	return withStyle(style, () => renderer()(message, options, theme).render(60));
}

/** The card's text with every chrome cell removed: what the reader actually reads. */
function contentOf(rows) {
	return rows
		.map((row) => stripAnsiAll(row).replace(/[╭╮╰╯─│▎]/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((text) => text.length > 0)
		.join(' | ');
}

// ---- what the renderer serves ----

test('the renderer serves this package\'s warp message and nothing else', () => {
	const render = renderer();
	assert.equal(render(undefined, {}, plainTheme), undefined);
	assert.equal(render({ customType: 'other', content: 'x' }, {}, plainTheme), undefined);
	assert.ok(render(MESSAGE, {}, plainTheme), 'the worktree-warp message is drawn');
});

// ---- S6: one style decision per render, in both styles ----

test('the neon style draws the rounded frame around the warp card', () => {
	const rows = renderWarp('neon');
	assert.match(stripAnsiAll(rows[0]), /^╭─ \u2387 Warp · moved ─+ ctrl\+o to expand ╮$/, 'the heading rides the top rule with the expand hint');
	assert.equal(stripAnsiAll(rows[rows.length - 1]).startsWith('╰'), true, 'the card closes with a rounded rule');
	for (const row of rows) {
		assert.equal(metrics.visibleWidth(row), 60, `"${stripAnsiAll(row)}" is not 60 wide`);
		assert.doesNotMatch(stripAnsiAll(row), /▎/, 'the neon style draws no accent rail');
	}
	assert.equal(contentOf(rows).includes('this prose never enters the card'), false, 'the prose notice stays out of the card');
});

test('the float style draws the accent rail over the tone background and no box', () => {
	const theme = paintTheme();
	const rows = renderWarp('float', { theme });
	for (const row of rows) {
		assert.equal(metrics.visibleWidth(stripAnsiAll(row)), 60, 'a float row is the width the host asked for');
		assert.ok(row.startsWith(' \x1b[48;5;240m▎'), 'the margin, the background and the rail open every row');
		assert.ok(row.endsWith('\x1b[49m '), 'the background closes before the right margin');
		assert.doesNotMatch(stripAnsiAll(row), /[╭╮╰╯─│]/, 'the float style draws no box');
	}
	assert.deepEqual(theme.roles.bg, ['toolPendingBg'], 'the warp tone paints the pending background');
	assert.equal(theme.roles.fg.includes('warning'), true, 'the rail takes the theme accent');
});

test('the warp card is the same text in float and in neon, and only the chrome differs', () => {
	const theme = paintTheme();
	for (const expanded of [false, true]) {
		const options = { expanded };
		const neon = withStyle('neon', () => renderer()(MESSAGE, options, theme).render(60));
		const float = withStyle('float', () => renderer()(MESSAGE, options, theme).render(60));
		assert.equal(contentOf(float), contentOf(neon), `expanded=${expanded}: same heading, same rows, same order`);
		assert.equal(float.length, neon.length + 2, `expanded=${expanded}: float adds its two padding rows and nothing else`);
	}
	const compact = contentOf(renderWarp('neon'));
	assert.match(compact, /\u2387 Warp · moved/);
	assert.match(compact, /moved: feat-one \| to: feat-two/, 'the two name-only rows keep their order');
});

test('the accent is the theme warning role in both styles, never a tone of its own', () => {
	for (const style of ['neon', 'float']) {
		const theme = paintTheme();
		renderWarp(style, { theme });
		assert.deepEqual([...new Set(theme.roles.fg)].sort(), ['dim', 'muted', 'warning'], `${style}: the frame and the label take the accent, the detail is muted and the hint dim`);
		for (const tone of ['border', 'success', 'error', 'accent']) {
			assert.equal(theme.roles.fg.includes(tone), false, `${style}: no role outside the accent, the detail and the hint`);
		}
	}
});

test('the style is read live: the global slot wins over a float document, once per render', () => {
	writeStyleDocument({ schema: CARD_STYLE_SCHEMA, style: 'float' });
	try {
		const floated = renderWarp(undefined, { theme: paintTheme() });
		assert.match(stripAnsiAll(floated[1]), /^ ▎ \u2387 Warp · moved/, 'the document says float: the rail');

		const neon = renderWarp('neon');
		assert.match(stripAnsiAll(neon[0]), /^╭─ \u2387 Warp · moved/, 'the slot says neon while the document says float: the frame wins');
		assert.equal(neon.some((row) => row.includes('▎')), false, 'and no row keeps a rail');

		const float = renderWarp('float', { theme: paintTheme() });
		assert.match(stripAnsiAll(float[1]), /^ ▎ \u2387 Warp · moved/, 'the slot says float: the whole card is float again');
	} finally {
		removeStyleDocument();
	}
});

test('a theme without the background role falls back to the neon outline', () => {
	const rows = renderWarp('float');
	assert.match(stripAnsiAll(rows[0]), /^╭─ \u2387 Warp · moved/, 'no background role: the neon frame');
	assert.equal(rows.some((row) => row.includes('\x1b')), false, 'and no background is painted');
});

// ---- the content the card has always carried ----

test('an expanded card appends the path and the branch, in that order and nothing else', () => {
	const withoutHint = (text) => text.replace(/ctrl\+o to (?:expand|collapse)/g, '').replace(/\s+/g, ' ').trim();
	const compact = withoutHint(contentOf(renderWarp('neon')));
	const expanded = withoutHint(contentOf(renderWarp('neon', { options: { expanded: true } })));
	assert.equal(expanded, `${compact} | path: now in "/clone-worktrees/feat-two" | branch: now in "feat/two"`);
	assert.match(stripAnsiAll(renderWarp('neon', { options: { expanded: true } })[0]), /ctrl\+o to collapse/, 'the hint offers the collapse');
});

test('a malformed payload falls back to the message content, never to a throw', () => {
	const broken = { customType: 'worktree-warp', content: 'moved somewhere', details: 'not an object' };
	const rows = withStyle('neon', () => renderer()(broken, {}, plainTheme).render(60));
	assert.match(contentOf(rows), /moved somewhere/);
	const empty = { customType: 'worktree-warp', content: '', details: {} };
	const blank = withStyle('neon', () => renderer()(empty, {}, plainTheme).render(60));
	assert.match(contentOf(blank), /\(no output\)/);
});

test('a legacy payload without fromName reads the source name from fromDesc', () => {
	const legacy = { customType: 'worktree-warp', content: 'moved', details: { fromDesc: 'feat-one · some note', name: 'feat-two' } };
	assert.match(contentOf(withStyle('neon', () => renderer()(legacy, {}, plainTheme).render(60))), /moved: feat-one \| to: feat-two/);
});

test('untrusted text is sanitized before it can reshape the transcript', () => {
	const hostile = { customType: 'worktree-warp', content: 'x', details: { fromName: 'a\x1b[31mred\x1b[0m\r\nb', name: 'n\nsecond' } };
	const rows = withStyle('neon', () => renderer()(hostile, {}, plainTheme).render(60));
	assert.equal(rows.some((row) => row.includes('\x1b')), false, 'no escape reaches the card');
	assert.equal(rows.some((row) => row.includes('\r')), false, 'no carriage return either');
	assert.match(contentOf(rows), /moved: ared \| to: n/);
	assert.equal(safeText('a\x1b[31mb'), 'ab', 'the sanitizer keeps its contract');
	assert.equal(stripAnsi('\x1b[1mx\x1b[0m'), 'x');
});

test('a hostile theme or host helper never breaks the card', () => {
	const throwingTheme = {
		fg() {
			throw new Error('no such role');
		},
		bg() {
			throw new Error('no such role');
		},
	};
	assert.doesNotThrow(() => withStyle('neon', () => renderer()(MESSAGE, {}, throwingTheme).render(60)));
	assert.doesNotThrow(() => withStyle('float', () => renderer()(MESSAGE, {}, throwingTheme).render(60)));
	const noHelpers = withStyle('neon', () => createWarpMessageRenderer(undefined)(MESSAGE, {}, plainTheme).render(40));
	assert.match(contentOf(noHelpers), /moved: feat-one/);
});

test('too narrow for float, the card draws the neon outline instead of a broken rail', () => {
	const float = withStyle('float', () => renderer()(MESSAGE, {}, paintTheme()).render(9));
	assert.match(stripAnsiAll(float[0]), /^╭/, 'nine columns is the neon frame');
	assert.equal(float.some((row) => row.includes('\x1b')), false);
});

test('the host outputPad is applied by the card itself, in both styles', () => {
	for (const style of ['neon', 'float']) {
		const rows = withStyle(style, () => renderer()(MESSAGE, { outputPad: 1 }, paintTheme()).render(60));
		for (const row of rows) {
			assert.ok(row.startsWith(' '), `${style}: the left margin is the host pad`);
			assert.equal(metrics.visibleWidth(stripAnsiAll(row)), 60, `${style}: the padded card still fills the row`);
		}
	}
});

// Every row's content with the chrome cells and the padding removed, joined with
// no separator: a value the card wrapped therefore reads back as one run.
function flowedText(rows) {
	return rows
		.map((row) => stripAnsiAll(row).replace(/[╭╮╰╯─│▎]/g, '').replace(/\s+/g, ' ').trim())
		.filter((text) => text.length > 0)
		.join('');
}

test('the compact row clips with an ellipsis and the expanded card wraps instead', () => {
	const long = {
		customType: 'worktree-warp',
		content: 'x',
		details: {
			fromName: 'a'.repeat(120),
			name: 'feat-two',
			to: `/clone-worktrees/${'b'.repeat(120)}`,
			branch: 'feat/two',
		},
	};
	for (const style of ['neon', 'float']) {
		const compact = flowedText(withStyle(style, () => renderer()(long, {}, paintTheme()).render(60)));
		assert.match(compact, /…/, `${style}: the compact row is clipped`);
		assert.equal(compact.includes('a'.repeat(120)), false, `${style}: the overflow stays hidden`);

		const expanded = flowedText(withStyle(style, () => renderer()(long, { expanded: true }, paintTheme()).render(60)));
		assert.equal(expanded.includes('…'), false, `${style}: nothing is cut when expanded`);
		assert.equal(expanded.includes('a'.repeat(120)), true, `${style}: the whole source name survives the wrap`);
		assert.equal(expanded.includes('b'.repeat(120)), true, `${style}: the whole path survives the wrap`);
	}
});

test('the module keeps its character wrapping helper', () => {
	assert.deepEqual(wrapTextToWidth('abcdef', 3, metrics), ['abc', 'def'], 'wrapping is character based and cuts no character');
	assert.deepEqual(wrapTextToWidth('abc def', 3, metrics), ['abc', ' de', 'f'], 'and it keeps every character, spaces included');
	assert.deepEqual(wrapTextToWidth('abc', 10, metrics), ['abc']);
	assert.deepEqual(wrapTextToWidth('any', 0, metrics), ['any'], 'no budget is one row, never a lost line');
});

// ---- one chrome, no second recipe ----

test('the card composes through the substrate and keeps no tone table of its own', () => {
	const source = readFileSync(join(__dirname, '..', 'lib', 'worktree-card.js'), 'utf8');
	assert.match(source, /require\('\.\/shell-card\.js'\)/, 'the card draws on lib/shell-card.js');
	for (const name of ['floatRows', 'cardTop', 'cardLine', 'cardBottom']) {
		assert.match(source, new RegExp(`\\b${name}\\b`), `${name} is the substrate's`);
	}
	for (const forbidden of ['FLOAT_BG_ROLE', 'floatBgRoleForTone', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg', 'FLOAT_CHROME', 'withChrome']) {
		assert.equal(source.includes(forbidden), false, `${forbidden} lives in lib/shell-card.js only`);
	}
	assert.doesNotMatch(source, /\b(?:neon|float)\b\s*[:=]/, 'the card never names a style itself');
});

// ---- the click area: the whole card, not only the hint ----
//
// The message card reaches the same click protocol as a tool card: pi-tui's
// `Container` forwards a normalized `TuiMouseEvent` to the renderer component
// with coordinates local to it, and a click only exists for the component that
// claimed the press. So the card claims every cell it drew and flips the host's
// expansion flag — the flag `ctrl+o` flips; the card keeps no state of its own.

function clickSpy() {
	const spy = { calls: 0, toggleExpanded: () => { spy.calls += 1; } };
	return spy;
}

function mountCard(component, width) {
	const rows = component.render(width);
	const screen = { width, height: rows.length, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false };
	const send = (type, x, y, patch = {}) => component.handleMouse({ type, button: 'left', x, y, ...screen, ...patch });
	return { rows, send };
}

test('a left click anywhere on the warp card toggles expansion, not only the hint', () => {
	const spy = clickSpy();
	const component = createWarpMessageRenderer({ ...metrics, toggleExpanded: spy.toggleExpanded })(MESSAGE, {}, plainTheme);
	const { rows, send } = mountCard(component, 60);

	// The heading's left end is the cell furthest from the right-aligned hint.
	assert.deepEqual(send('press', 3, 0), { handled: true, render: false }, 'the press claims the card so the host retargets the click');
	assert.equal(spy.calls, 0, 'a press alone never toggles');
	assert.deepEqual(send('click', 3, 0), { handled: true }, 'the click on the heading is handled');
	assert.equal(spy.calls, 1, 'one click toggled once');

	for (const y of [1, rows.length - 1]) {
		assert.deepEqual(send('press', 5, y), { handled: true, render: false }, `row ${y} is on the card`);
		assert.deepEqual(send('click', 5, y), { handled: true }, `row ${y} is clickable`);
	}
	assert.equal(spy.calls, 3, 'every click toggled exactly once');
});

test('the hint cells stay clickable and nothing outside the card is claimed', () => {
	const spy = clickSpy();
	const component = createWarpMessageRenderer({ ...metrics, toggleExpanded: spy.toggleExpanded })(MESSAGE, {}, plainTheme);
	const { rows, send } = mountCard(component, 60);
	const start = stripAnsiAll(rows[0]).indexOf('ctrl+o to expand');
	assert.ok(start > 0, 'the heading carries the hint');
	assert.deepEqual(send('click', start + 1, 0), { handled: true }, 'the hint cells were already clickable and still are');
	assert.equal(spy.calls, 1);

	assert.equal(send('click', 0, rows.length), undefined, 'a row below the card is the host\'s');
	assert.equal(send('click', 0, -1), undefined, 'a row above the card is the host\'s');
	assert.equal(send('click', 60, 0), undefined, 'a column right of the card is the host\'s');
	assert.equal(send('click', 0, 0, { button: 'right' }), undefined, 'the right button is the host\'s');
	assert.equal(send('drag', 0, 0), undefined, 'a drag is not a click');
	assert.equal(send('move', 0, 0), undefined, 'a move is not a click');
	assert.equal(spy.calls, 1, 'nothing outside the card toggled anything');
});

test('with no click seam the warp card has no mouse handler at all', () => {
	const component = renderer()(MESSAGE, {}, plainTheme);
	assert.equal('handleMouse' in component, false, 'ctrl+o stays the only way in');
	assert.ok(component.render(60).length > 0, 'the card still draws');
});

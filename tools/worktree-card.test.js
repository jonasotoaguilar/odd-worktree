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
const { CARD_CONTENT } = require('../lib/card-content.js');

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

test('the frame and the label carry the warning tone, the body the text role', () => {
	for (const style of ['neon', 'float']) {
		const theme = paintTheme();
		renderWarp(style, { theme });
		assert.deepEqual([...new Set(theme.roles.fg)].sort(), ['dim', 'muted', 'text', 'warning'], `${style}: the frame and the label take the tone, the body text, the detail muted and the hint dim`);
		for (const role of ['border', 'success', 'error', 'accent']) {
			assert.equal(theme.roles.fg.includes(role), false, `${style}: no role outside the tone, the body, the detail and the hint`);
		}
	}
});

test('a warp body row is painted in the theme text role, like the two tool cards', () => {
	// The fake here only re-wraps a line that does not fit, so the short rows below
	// read back whole with their role intact (the real wrapTextWithAnsi is ANSI aware).
	const ansi = {
		...metrics,
		wrapTextWithAnsi: (value, width) => (metrics.visibleWidth(value) <= width ? [value] : wrapTextToWidth(value, width, metrics)),
	};
	const tagged = {
		fg: (role, value) => `<${role}>${value}</${role}>`,
		bg: (role, value) => `\x1b[48;5;240m${value}\x1b[49m`,
	};
	for (const style of ['neon', 'float']) {
		const rows = withStyle(style, () => createWarpMessageRenderer(ansi)(MESSAGE, {}, tagged).render(60));
		const body = rows.filter((row) => stripAnsi(row).includes('moved: feat-one'));
		assert.equal(body.length, 1, `${style}: the compact body row is drawn once`);
		assert.match(body[0], /^.*<text>moved: feat-one<\/text>/, `${style}: the body row carries the text role`);
		assert.equal(body[0].includes('<warning>moved'), false, `${style}: the body never borrows the chrome's tone`);
	}
});

test('a real measured span rides the closing rule bottom-right, in both styles', () => {
	const timed = (durationMs) => ({ ...MESSAGE, details: { ...MESSAGE.details, durationMs } });
	const neon = withStyle('neon', () => renderer()(timed(1200), {}, plainTheme).render(60));
	assert.equal(neon[neon.length - 1], `╰${'─'.repeat(52)} 1.2s ╯`, 'the elapsed time is the last thing before the right corner');
	assert.equal(metrics.visibleWidth(neon[neon.length - 1]), 60);

	const millis = withStyle('neon', () => renderer()(timed(42), {}, plainTheme).render(60));
	assert.equal(millis[millis.length - 1], `╰${'─'.repeat(52)} 42ms ╯`, 'a sub-second span reads in milliseconds');

	const float = withStyle('float', () => renderer()(timed(1200), {}, paintTheme()).render(60));
	assert.match(stripAnsiAll(float[float.length - 1]), /^ ▎ +1\.2s +$/, 'the float closing row carries the same time, bottom-right');
	for (const row of float) assert.equal(metrics.visibleWidth(stripAnsiAll(row)), 60, 'the timed float card keeps its width');

	// An expanded card keeps the same closing rule, and the time is not repeated.
	const expanded = withStyle('neon', () => renderer()(timed(1200), { expanded: true }, plainTheme).render(60));
	assert.equal(expanded[expanded.length - 1], `╰${'─'.repeat(52)} 1.2s ╯`);
	assert.equal(expanded.filter((row) => stripAnsiAll(row).includes('1.2s')).length, 1, 'exactly one row carries the time');
});

test('a warp card with no measured span shows no elapsed time at all', () => {
	const closing = (message, style = 'neon') => {
		const rows = withStyle(style, () => renderer()(message, {}, plainTheme).render(60));
		return rows[rows.length - 1];
	};
	const plain = `╰${'─'.repeat(58)}╯`;
	assert.equal(closing(MESSAGE), plain, 'no durationMs: the plain rule, no 0ms and no placeholder');
	for (const value of ['1200', 'soon', null, -5, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
		const message = { ...MESSAGE, details: { ...MESSAGE.details, durationMs: value } };
		assert.equal(closing(message), plain, `${JSON.stringify(value)} is not a measured span`);
	}
	const float = withStyle('float', () => renderer()(MESSAGE, {}, paintTheme()).render(60));
	assert.match(stripAnsiAll(float[float.length - 1]), /^ ▎ +$/, 'the float closing row carries nothing either');
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

// ---- the content level: `minimal` is the heading line alone ----
//
// The level is the user's choice in Gentle Shell, published on the process-wide slot
// `lib/card-content.js` reads — the same level the two tool cards and the CodeGraph
// card read. The renderer takes the same reader seam (`cardContent`), so a case
// injects a level instead of touching the real slot, and the default reader stays
// the real one, asked on every paint.
const CARD_CONTENT_SLOT = Symbol.for('gentle-pi.card-content');

/** Run with the process-wide level slot set, restoring whatever it held. */
function withContent(level, run) {
	const before = globalThis[CARD_CONTENT_SLOT];
	if (level === undefined) delete globalThis[CARD_CONTENT_SLOT];
	else globalThis[CARD_CONTENT_SLOT] = level;
	try {
		return run();
	} finally {
		if (before === undefined) delete globalThis[CARD_CONTENT_SLOT];
		else globalThis[CARD_CONTENT_SLOT] = before;
	}
}

test('a minimal warp card is the heading line alone, and the level is read on every paint', () => {
	let level = CARD_CONTENT.DEFAULT;
	const render = createWarpMessageRenderer({ ...metrics, cardContent: () => level });
	const component = render(messageFor('feat-two'), {}, plainTheme);
	const compact = component.render(60);
	assert.equal(compact.length, 4, 'the heading, the two name-only rows and the closing rule');
	assert.match(contentOf(compact), /moved: feat-one \| to: feat-two/);

	level = CARD_CONTENT.MINIMAL;
	const minimal = component.render(60);
	assert.deepEqual(minimal, [compact[0], compact.at(-1)], 'the heading and the closing rule, with no row between them');
	assert.equal(contentOf(minimal).includes('moved: feat-one'), false, 'the minimal card carries no body row');

	level = CARD_CONTENT.DEFAULT;
	assert.deepEqual(component.render(60), compact, 'and back again, with no new renderer');
});

test('a minimal warp card shows the same heading in float and in neon', () => {
	// No injected reader here: the renderer reads the real slot on every paint.
	const lines = (style) => withStyle(style, () => withContent(CARD_CONTENT.MINIMAL, () => renderer()(messageFor('feat-two'), {}, paintTheme()).render(60)));
	const neon = lines('neon');
	const float = lines('float');
	assert.equal(neon.length, 2, 'the heading and the closing rule');
	assert.equal(float.length, 3, 'float adds its padding row above the heading, and no body row');
	assert.equal(contentOf(float), contentOf(neon), 'the same text in both styles; only the chrome differs');
	assert.equal(contentOf(float).includes('moved: feat-one'), false, 'no body row in either style');
	for (const row of float) assert.equal(metrics.visibleWidth(stripAnsiAll(row)), 60, 'a float row is the width it was given');
	assert.equal(float.some((row) => /[╭╮╰╯─│]/.test(row)), false, 'the float card draws no box');
});

test('an expanded warp card shows everything at either level', () => {
	const expandedAt = (level) => withContent(level, () => renderer()(messageFor('feat-two'), { expanded: true }, plainTheme).render(60));
	const atDefault = expandedAt(CARD_CONTENT.DEFAULT);
	assert.deepEqual(expandedAt(CARD_CONTENT.MINIMAL), atDefault, 'the reader asked for everything and gets everything');
	assert.match(contentOf(atDefault), /path: now in "\/clone-worktrees\/feat-two"/, 'including the path and the branch');
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

// ---- the click area: this message card, and only this one ----
//
// The message card reaches the same click protocol as a tool card: pi-tui's
// `Container` forwards a normalized `TuiMouseEvent` to the renderer component
// with coordinates local to it, and a click only exists for the component that
// claimed the press.
//
// A message renderer gets no render context to keep state in — only
// `{expanded, outputPad, keyText, keyHint}` — so the choice is kept beside the
// message it belongs to, and the card re-reads it on every render: the host
// repaints a claimed click without rebuilding the renderer. `ctrl+o`, the host's
// own flag in `options.expanded`, still wins over an earlier click.

function mountCard(component, width = 60) {
	const rows = component.render(width);
	const screen = { width, height: rows.length, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false };
	const send = (type, x, y, patch = {}) => component.handleMouse({ type, button: 'left', x, y, ...screen, ...patch });
	return { rows, send };
}

/** A second warp message: a distinct object, so its card keeps its own choice. */
/**
 * A fresh warp message: the expansion choice is kept per message object, so every
 * case gets its own and nothing leaks from one case into the next.
 */
function messageFor(name, details = {}) {
	return {
		customType: 'worktree-warp',
		content: `session warped to ${name} (this prose never enters the card)`,
		details: { fromName: 'feat-one', name, to: `/clone-worktrees/${name}`, branch: `feat/${name}`, ...details },
	};
}

test('a left click expands the warp card it hit and leaves a sibling card collapsed', () => {
	const message = messageFor('feat-two');
	const component = renderer()(message, {}, plainTheme);
	const { rows, send } = mountCard(component);
	const sibling = renderer()(messageFor('feat-three'), {}, plainTheme);
	const siblingRows = sibling.render(60);

	assert.deepEqual(send('press', 3, 0), { handled: true, render: false }, 'the press claims the card so the host retargets the click');
	assert.deepEqual(send('click', 3, 0), { handled: true }, 'the click on the heading is handled');

	const expanded = component.render(60);
	assert.ok(expanded.length > rows.length, 'the same component, re-rendered, is now expanded');
	assert.equal(contentOf(expanded).includes('path: now in'), true, 'and shows the path an expanded warp adds');
	assert.deepEqual(sibling.render(60), siblingRows, 'the sibling card is untouched');
	assert.equal(contentOf(sibling.render(60)).includes('path: now in'), false, 'and stays collapsed');
});

test('a second click collapses the same warp card again', () => {
	const component = renderer()(messageFor('feat-two'), {}, plainTheme);
	const { rows, send } = mountCard(component);
	assert.deepEqual(send('click', 3, 0), { handled: true });
	assert.ok(component.render(60).length > rows.length, 'the first click expands');
	assert.deepEqual(send('click', 3, 0), { handled: true });
	assert.deepEqual(component.render(60), rows, 'the second click collapses it back');
});

test('ctrl+o still expands the warp card, and wins over an earlier click', () => {
	const message = messageFor('feat-two');
	const compact = renderer()(message, {}, plainTheme).render(60);

	// A click expands this card...
	const clicked = renderer()(message, {}, plainTheme);
	const card = mountCard(clicked);
	assert.deepEqual(card.send('click', 3, 0), { handled: true });
	assert.ok(clicked.render(60).length > compact.length, 'the click expanded the card');

	// ...and the host's own flag still decides, in both directions.
	const byKey = renderer()(message, { expanded: true }, plainTheme).render(60);
	assert.ok(byKey.length > compact.length, 'ctrl+o expands a card a click had already expanded');
	assert.deepEqual(renderer()(message, { expanded: false }, plainTheme).render(60), compact, 'a collapse from ctrl+o wins over the earlier click too');
});

test('the hint cells stay clickable and nothing outside the card is claimed', () => {
	const component = renderer()(messageFor('feat-two'), {}, plainTheme);
	const { rows, send } = mountCard(component);
	const start = stripAnsiAll(rows[0]).indexOf('ctrl+o to expand');
	assert.ok(start > 0, 'the heading carries the hint');

	assert.equal(send('click', 0, rows.length), undefined, 'a row below the card is the host\'s');
	assert.equal(send('click', 0, -1), undefined, 'a row above the card is the host\'s');
	assert.equal(send('click', 60, 0), undefined, 'a column right of the card is the host\'s');
	assert.equal(send('click', 0, 0, { button: 'right' }), undefined, 'the right button is the host\'s');
	assert.equal(send('drag', 0, 0), undefined, 'a drag is not a click');
	assert.equal(send('move', 0, 0), undefined, 'a move is not a click');

	assert.deepEqual(send('click', start + 1, 0), { handled: true }, 'the hint cells were already clickable and still are');
	assert.ok(component.render(60).length > rows.length, 'and the hint is on the card, so it moved this one card');
});

test('the warp card claims its own cells with no injected seam', () => {
	const component = renderer()(messageFor('feat-two'), {}, plainTheme);
	assert.equal(typeof component.handleMouse, 'function', 'no host toggle is needed: the card moves itself');
	assert.ok(component.render(60).length > 0, 'the card still draws');
});

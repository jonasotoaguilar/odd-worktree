'use strict';
// S5: the reader of the card style. Every case goes through the module's public
// surface — the process-wide slot Gentle Shell publishes, the strict preference
// document, and the decision that answers `neon`, `float` or the float default —
// and never through its module state.
//
// The document lives in a scratch directory (`GENTLE_PI_CONFIG_HOME`), so no case
// reads or writes the real user's preference, and the slot is restored after every
// case so one test can never decide another's style.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	CARD_STYLE,
	CARD_STYLE_FILE,
	CARD_STYLE_SCHEMA,
	CARD_STYLE_SLOT,
	cardStyle,
	cardStyleFile,
	cardStyleHome,
	parseCardStyleFile,
	refreshCardStyle,
	resolveCardStyle,
} = require('../lib/card-style.js');
const { loadExtension } = require('./fixtures/load-extension.js');

const VALID = (style) => JSON.stringify({ schema: CARD_STYLE_SCHEMA, style });

let scratch;
const homeOf = (name) => join(scratch, name);
const documentIn = (home) => join(home, CARD_STYLE_FILE);

function newHome(name) {
	const home = homeOf(name);
	mkdirSync(home, { recursive: true });
	return home;
}

function writeDocument(home, contents) {
	writeFileSync(documentIn(home), typeof contents === 'string' ? contents : JSON.stringify(contents));
}

const savedEnv = {
	GENTLE_PI_CONFIG_HOME: process.env.GENTLE_PI_CONFIG_HOME,
	GENTLE_SHELL_CONFIG_HOME: process.env.GENTLE_SHELL_CONFIG_HOME,
};

function restoreEnv() {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function useSlot(value) {
	if (value === undefined) delete globalThis[CARD_STYLE_SLOT];
	else globalThis[CARD_STYLE_SLOT] = value;
}

before(() => {
	scratch = mkdtempSync(join(tmpdir(), 'odd-card-style-'));
});

beforeEach(() => {
	useSlot(undefined);
	delete process.env.GENTLE_PI_CONFIG_HOME;
	delete process.env.GENTLE_SHELL_CONFIG_HOME;
	refreshCardStyle();
});

afterEach(() => {
	useSlot(undefined);
	restoreEnv();
	refreshCardStyle();
});

after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---- the two styles, the slot and the document ----

test('the reader names the two styles, the schema and the document', () => {
	assert.deepEqual(CARD_STYLE, { NEON: 'neon', FLOAT: 'float' });
	assert.equal(CARD_STYLE_SCHEMA, 'gentle-pi.card-style/v1');
	assert.equal(CARD_STYLE_FILE, 'card-style.json');
	assert.equal(CARD_STYLE_SLOT, Symbol.for('gentle-pi.card-style'), 'the slot is the symbol Gentle Shell resolves into');
	for (const fn of [cardStyle, cardStyleFile, cardStyleHome, parseCardStyleFile, refreshCardStyle, resolveCardStyle]) {
		assert.equal(typeof fn, 'function');
	}
});

test('the document is strict: exactly the schema and one known style, or nothing', () => {
	assert.equal(parseCardStyleFile(VALID(CARD_STYLE.NEON)), CARD_STYLE.NEON);
	assert.equal(parseCardStyleFile(VALID(CARD_STYLE.FLOAT)), CARD_STYLE.FLOAT);
	assert.equal(parseCardStyleFile(`${VALID(CARD_STYLE.NEON)}\n`), CARD_STYLE.NEON, 'a trailing newline is still the same document');

	for (const raw of [
		'',
		'   ',
		'neon',
		'{',
		'null',
		'[]',
		'"float"',
		'42',
		JSON.stringify({ schema: CARD_STYLE_SCHEMA }),
		JSON.stringify({ style: CARD_STYLE.NEON }),
		JSON.stringify({ schema: 'gentle-pi.card-style/v2', style: CARD_STYLE.NEON }),
		JSON.stringify({ schema: CARD_STYLE_SCHEMA, style: CARD_STYLE.NEON, extra: true }),
		JSON.stringify({ schema: CARD_STYLE_SCHEMA, style: 'ultraviolet' }),
		JSON.stringify({ schema: CARD_STYLE_SCHEMA, style: CARD_STYLE.NEON, other: 'x' }),
		JSON.stringify({ schema: CARD_STYLE_SCHEMA, style: 1 }),
		JSON.stringify([{ schema: CARD_STYLE_SCHEMA, style: CARD_STYLE.NEON }]),
	]) {
		assert.equal(parseCardStyleFile(raw), undefined, `${JSON.stringify(raw)} states no style`);
	}
	for (const value of [undefined, null, 1, {}]) {
		assert.equal(parseCardStyleFile(value), undefined, 'a non-string is not a document');
	}
});

// ---- the decision order: slot → document → float ----

test('a missing document is the float default, and the reader says so', () => {
	const home = newHome('missing');
	const resolution = resolveCardStyle({ gentlePiConfigHome: home });
	assert.deepEqual(resolution, { style: CARD_STYLE.FLOAT, source: 'default', reason: 'missing_file', slot: undefined, globalFile: documentIn(home) });
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.FLOAT);
});

test('a document that states a style is the answer when the slot is empty', () => {
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		const home = newHome(`document-${style}`);
		writeDocument(home, VALID(style));
		refreshCardStyle();
		assert.deepEqual(resolveCardStyle({ gentlePiConfigHome: home }), {
			style,
			source: 'file',
			reason: null,
			slot: undefined,
			globalFile: documentIn(home),
		});
		assert.equal(cardStyle({ gentlePiConfigHome: home }), style);
	}
});

test('a malformed or unreadable document falls back to float and names the reason', () => {
	const malformed = newHome('malformed');
	writeDocument(malformed, '{"schema":"gentle-pi.card-style/v1","style":"teal"}');
	const bad = resolveCardStyle({ gentlePiConfigHome: malformed });
	assert.equal(bad.style, CARD_STYLE.FLOAT);
	assert.equal(bad.source, 'default');
	assert.equal(bad.reason, 'malformed_file');
	assert.equal(cardStyle({ gentlePiConfigHome: malformed }), CARD_STYLE.FLOAT);

	// A document that cannot be read at all (here a directory wearing its name) is
	// not a malformed document: it reports its own reason.
	const unreadable = newHome('unreadable');
	mkdirSync(documentIn(unreadable), { recursive: true });
	const failure = resolveCardStyle({ gentlePiConfigHome: unreadable });
	assert.equal(failure.style, CARD_STYLE.FLOAT);
	assert.equal(failure.reason, 'unreadable_file');
	assert.equal(cardStyle({ gentlePiConfigHome: unreadable }), CARD_STYLE.FLOAT);
});

test('the live slot wins over the document, because that is what the shell says', () => {
	const home = newHome('slot-wins');
	writeDocument(home, VALID(CARD_STYLE.FLOAT));
	refreshCardStyle();

	useSlot(CARD_STYLE.NEON);
	const neon = resolveCardStyle({ gentlePiConfigHome: home });
	assert.deepEqual(neon, {
		style: CARD_STYLE.NEON,
		source: 'slot',
		reason: 'slot',
		slot: CARD_STYLE.NEON,
		globalFile: documentIn(home),
	});
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.NEON);

	// And a slot that says float overrules a document that says neon.
	writeDocument(home, VALID(CARD_STYLE.NEON));
	refreshCardStyle();
	useSlot(CARD_STYLE.FLOAT);
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.FLOAT);
	assert.equal(resolveCardStyle({ gentlePiConfigHome: home }).source, 'slot');
});

test('a slot holding anything but a known style is not a decision', () => {
	const home = newHome('slot-unknown');
	writeDocument(home, VALID(CARD_STYLE.NEON));
	for (const value of ['outline', '', 0, null, {}, [], 'NEON']) {
		useSlot(value);
		const resolution = resolveCardStyle({ gentlePiConfigHome: home });
		assert.equal(resolution.style, CARD_STYLE.NEON, `the document answers for ${JSON.stringify(value)}`);
		assert.equal(resolution.source, 'file');
	}
});

test('the slot is live: a change is seen on the next call, with no refresh', () => {
	const home = newHome('live');
	writeDocument(home, VALID(CARD_STYLE.FLOAT));
	refreshCardStyle();
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.FLOAT);
	useSlot(CARD_STYLE.NEON);
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.NEON, 'the slot is read on every call');
	useSlot(CARD_STYLE.FLOAT);
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.FLOAT);
});

test('the document is read once per session and re-read by refresh, never cached across sessions', () => {
	const home = newHome('refresh');
	writeDocument(home, VALID(CARD_STYLE.FLOAT));
	refreshCardStyle();
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.FLOAT);

	// A render path never hits the disk: the document stays as the session read it.
	writeDocument(home, VALID(CARD_STYLE.NEON));
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.FLOAT, 'the cached document branch answers');
	assert.equal(resolveCardStyle({ gentlePiConfigHome: home }).style, CARD_STYLE.NEON, 'the diagnostic reader always reads it');

	// `session_start` re-reads, which is the only thing that sees the new document.
	assert.equal(refreshCardStyle({ gentlePiConfigHome: home }).style, CARD_STYLE.NEON);
	assert.equal(cardStyle({ gentlePiConfigHome: home }), CARD_STYLE.NEON);
});

test('one home never answers for another', () => {
	const neonHome = newHome('home-neon');
	const floatHome = newHome('home-float');
	writeDocument(neonHome, VALID(CARD_STYLE.NEON));
	writeDocument(floatHome, VALID(CARD_STYLE.FLOAT));
	refreshCardStyle();
	assert.equal(cardStyle({ gentlePiConfigHome: neonHome }), CARD_STYLE.NEON);
	assert.equal(cardStyle({ gentlePiConfigHome: floatHome }), CARD_STYLE.FLOAT, 'the cache is keyed by the document path');
	assert.equal(cardStyle({ gentlePiConfigHome: neonHome }), CARD_STYLE.NEON);
});

// ---- the extension: the session-start re-read ----

test('the extension re-reads the style at session_start', async () => {
	const { hooks } = await loadExtension({});
	const refreshers = hooks.filter(([event, handler]) => event === 'session_start' && String(handler).includes('refreshCardStyle'));
	assert.equal(refreshers.length, 1, 'exactly one session-start handler owns the style re-read');

	const home = newHome('session-start');
	writeDocument(home, VALID(CARD_STYLE.FLOAT));
	process.env.GENTLE_PI_CONFIG_HOME = home;
	refreshCardStyle();
	assert.equal(cardStyle(), CARD_STYLE.FLOAT, 'the session starts on the document it read');

	// Gentle Shell saves the other style while the session runs; the render path keeps
	// the session's answer until the next start, which is what the hook refreshes.
	writeDocument(home, VALID(CARD_STYLE.NEON));
	assert.equal(cardStyle(), CARD_STYLE.FLOAT);
	assert.doesNotThrow(() => refreshers[0][1]());
	assert.equal(cardStyle(), CARD_STYLE.NEON, 'the re-read sees the document the new session starts on');
});

// ---- `<home>` resolution: GENTLE_PI_CONFIG_HOME → GENTLE_SHELL_CONFIG_HOME → ~/.pi/gentle-ai ----

test('the config home resolves pi first, then the shell, then the user default', () => {
	const piHome = newHome('env-pi');
	const shellHome = newHome('env-shell');

	process.env.GENTLE_PI_CONFIG_HOME = piHome;
	process.env.GENTLE_SHELL_CONFIG_HOME = shellHome;
	assert.equal(cardStyleHome(process.env), piHome);
	assert.equal(cardStyleFile(), documentIn(piHome));
	assert.equal(resolveCardStyle().globalFile, documentIn(piHome));

	delete process.env.GENTLE_PI_CONFIG_HOME;
	assert.equal(cardStyleHome(process.env), shellHome);
	assert.equal(cardStyleFile(), documentIn(shellHome));
	assert.equal(resolveCardStyle().globalFile, documentIn(shellHome));

	// A blank value is not a choice: the next source answers.
	process.env.GENTLE_SHELL_CONFIG_HOME = '   ';
	assert.equal(cardStyleHome(process.env), join(homedir(), '.pi', 'gentle-ai'));
	assert.equal(cardStyleFile(), join(homedir(), '.pi', 'gentle-ai', CARD_STYLE_FILE));
	assert.equal(resolveCardStyle().globalFile, join(homedir(), '.pi', 'gentle-ai', CARD_STYLE_FILE));
});

test('the reader falls back to float instead of throwing on unusable input', () => {
	const home = newHome('hostile');
	writeDocument(home, VALID(CARD_STYLE.NEON));
	for (const options of [undefined, null, 42, 'x', {}, { gentlePiConfigHome: 7 }, { gentlePiConfigHome: '' }]) {
		assert.doesNotThrow(() => resolveCardStyle(options));
		assert.doesNotThrow(() => cardStyle(options));
		assert.doesNotThrow(() => refreshCardStyle(options));
		assert.ok([CARD_STYLE.NEON, CARD_STYLE.FLOAT].includes(resolveCardStyle(options).style));
	}
	// A home that is a file, not a directory, has no document to read.
	assert.equal(resolveCardStyle({ gentlePiConfigHome: documentIn(home) }).reason, 'unreadable_file');
	assert.equal(resolveCardStyle({ gentlePiConfigHome: documentIn(home) }).style, CARD_STYLE.FLOAT);
});

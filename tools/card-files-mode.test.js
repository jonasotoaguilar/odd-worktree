'use strict';
// S1: the two file-card switches and the one document behind them.
//
// `Card skill` and `Card odd` are the same preference with two names: one strict
// document `<home>/card-files.json` holding two booleans, and one process-wide
// slot a live session reads. These cases drive the module's public surface only —
// the kinds, the schema, the slot, the reader, the per-kind reader and the writer
// — and never its module state.
//
// Every document lives in a scratch directory reached through
// `GENTLE_PI_CONFIG_HOME` (the home resolution `lib/card-bash-mode.js` already
// owns), so no case reads or writes the real Pi home. The slot is cleared before
// and after every case and the environment is restored afterwards, so one case can
// never decide another's switches.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	CARD_FILES_FILE,
	CARD_FILES_SCHEMA,
	CARD_FILES_SLOT,
	CARD_FILE_KINDS,
	cardFileEnabled,
	cardFilesFile,
	cardFilesHome,
	readCardFiles,
	writeCardFileSwitch,
} = require('../lib/card-files-mode.js');

const ON = Object.freeze({ skill: true, odd: true });
const VALID = (state) => JSON.stringify({ schema: CARD_FILES_SCHEMA, ...state });
const CANONICAL = (state) => `${VALID(state)}\n`;

let scratch;
let home;

const newHome = (name) => {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const documentIn = (dir) => join(dir, CARD_FILES_FILE);
const writeDocument = (dir, contents) => writeFileSync(documentIn(dir), contents);

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
	if (value === undefined) delete globalThis[CARD_FILES_SLOT];
	else globalThis[CARD_FILES_SLOT] = value;
}

before(() => {
	scratch = mkdtempSync(join(tmpdir(), 'odd-card-files-'));
});

beforeEach(() => {
	useSlot(undefined);
	delete process.env.GENTLE_PI_CONFIG_HOME;
	delete process.env.GENTLE_SHELL_CONFIG_HOME;
	home = newHome(`home-${Math.random().toString(36).slice(2)}`);
	process.env.GENTLE_PI_CONFIG_HOME = home;
});

afterEach(() => {
	useSlot(undefined);
	restoreEnv();
});

after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---- the two kinds, the slot and the document ----

describe('the switches', () => {
	test('names the two kinds, the schema, the document and the slot', () => {
		assert.deepEqual(CARD_FILE_KINDS, ['skill', 'odd']);
		assert.equal(Object.isFrozen(CARD_FILE_KINDS), true, 'the kind list is not a list a caller can grow');
		assert.equal(CARD_FILES_SCHEMA, 'gentle-pi.card-files/v1');
		assert.equal(CARD_FILES_FILE, 'card-files.json');
		assert.equal(CARD_FILES_SLOT, Symbol.for('gentle-pi.card-files'), 'the slot is the one cell a live session reads');
		for (const fn of [cardFileEnabled, cardFilesFile, cardFilesHome, readCardFiles, writeCardFileSwitch]) {
			assert.equal(typeof fn, 'function');
		}
	});

	test('with no document both cards are switched on', () => {
		assert.deepEqual(readCardFiles(), ON, 'S1: both identities are on out of the box');
		assert.equal(cardFileEnabled('skill'), true);
		assert.equal(cardFileEnabled('odd'), true);
		assert.deepEqual(readdirSync(home), [], 'reading writes nothing');
	});

	test('a document that states both switches is the answer when the slot is empty', () => {
		for (const state of [{ skill: false, odd: false }, { skill: false, odd: true }, { skill: true, odd: false }, ON]) {
			writeDocument(home, VALID(state));
			assert.deepEqual(readCardFiles(), state, `${JSON.stringify(state)} is read as written`);
			assert.equal(cardFileEnabled('skill'), state.skill);
			assert.equal(cardFileEnabled('odd'), state.odd);
		}
	});

	test('the live slot wins over the document, because that is what the session says', () => {
		writeDocument(home, VALID(ON));
		useSlot({ skill: false, odd: false });
		assert.deepEqual(readCardFiles(), { skill: false, odd: false });
		assert.equal(cardFileEnabled('skill'), false);
		assert.equal(cardFileEnabled('odd'), false);

		// A host seam names the same cell, so a caller can read a slot it was handed.
		const host = { [CARD_FILES_SLOT]: { skill: true, odd: false } };
		assert.deepEqual(readCardFiles(host), { skill: true, odd: false });
		assert.equal(cardFileEnabled('odd', host), false);
	});

	test('a slot holding anything but both booleans is not a decision', () => {
		writeDocument(home, VALID({ skill: false, odd: true }));
		for (const value of ['skill', 1, null, [], {}, { skill: false }, { skill: false, odd: 'yes' }, { skill: 0, odd: 1 }]) {
			useSlot(value);
			assert.deepEqual(readCardFiles(), { skill: false, odd: true }, `the document answers for ${JSON.stringify(value)}`);
		}
	});

	test('an unknown kind is never enabled, because it names no card', () => {
		for (const kind of [undefined, null, '', 'skills', 'ODD', 1, {}]) {
			assert.equal(cardFileEnabled(kind), false, `${JSON.stringify(kind)} names no card`);
		}
	});
});

// ---- a document this module cannot use reads as the defaults ----

describe('the read fallback', () => {
	test('a malformed document reads as both cards on, and never throws', () => {
		for (const raw of [
			'',
			'   ',
			'true',
			'{',
			'null',
			'[]',
			'"odd"',
			'42',
			JSON.stringify({ schema: CARD_FILES_SCHEMA }),
			JSON.stringify({ schema: CARD_FILES_SCHEMA, skill: false }),
			JSON.stringify({ skill: false, odd: false }),
			JSON.stringify({ schema: 'gentle-pi.card-files/v2', skill: false, odd: false }),
			JSON.stringify({ schema: CARD_FILES_SCHEMA, skill: false, odd: false, extra: true }),
			JSON.stringify({ schema: CARD_FILES_SCHEMA, skill: 0, odd: 0 }),
			JSON.stringify({ schema: CARD_FILES_SCHEMA, skill: 'false', odd: 'false' }),
			JSON.stringify([{ schema: CARD_FILES_SCHEMA, skill: false, odd: false }]),
		]) {
			writeDocument(home, raw);
			assert.doesNotThrow(() => readCardFiles());
			assert.deepEqual(readCardFiles(), ON, `${JSON.stringify(raw)} states nothing usable`);
		}
	});

	test('an unreadable document reads as both cards on', () => {
		mkdirSync(documentIn(home), { recursive: true });
		assert.doesNotThrow(() => readCardFiles());
		assert.deepEqual(readCardFiles(), ON);
		assert.deepEqual(readCardFiles(null), ON, 'an unusable host is not a decision either');
		assert.deepEqual(readCardFiles({}), ON);
	});
});

// ---- the writer: atomic, owner-only, and never over a document it cannot read ----

describe('the switch writer', () => {
	test('writes the strict document with owner-only bits and no leftover temp file', () => {
		const result = writeCardFileSwitch('skill', false);
		assert.deepEqual(result, { ok: true, value: { skill: false, odd: true } });
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL({ skill: false, odd: true }), 'exactly the schema and two booleans');
		assert.equal(statSync(documentIn(home)).mode & 0o777, 0o600, 'the document is owner-only');
		assert.deepEqual(readdirSync(home), [CARD_FILES_FILE], 'the temporary file is gone');
		assert.deepEqual(readCardFiles(), { skill: false, odd: true });
	});

	test('writing one kind keeps the other, and updates the live slot with the whole state', () => {
		writeDocument(home, VALID({ skill: false, odd: true }));
		useSlot({ skill: false, odd: true });

		assert.deepEqual(writeCardFileSwitch('odd', false), { ok: true, value: { skill: false, odd: false } });
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL({ skill: false, odd: false }));
		assert.deepEqual(globalThis[CARD_FILES_SLOT], { skill: false, odd: false }, 'the live session reads the new state at once');

		// A second write keeps the state it did not name.
		assert.deepEqual(writeCardFileSwitch('skill', true), { ok: true, value: { skill: true, odd: false } });
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL({ skill: true, odd: false }));
		assert.deepEqual(readCardFiles(), { skill: true, odd: false });
	});

	test('creates the home it needs and keeps the other switch at its default', () => {
		const created = join(scratch, 'created', 'nested');
		process.env.GENTLE_PI_CONFIG_HOME = created;
		assert.deepEqual(readCardFiles(), ON);
		assert.deepEqual(writeCardFileSwitch('odd', false), { ok: true, value: { skill: true, odd: false } });
		assert.equal(readFileSync(documentIn(created), 'utf8'), CANONICAL({ skill: true, odd: false }));
		assert.deepEqual(globalThis[CARD_FILES_SLOT], { skill: true, odd: false });
	});

	test('a live slot is the state the merge starts from when no document exists yet', () => {
		useSlot({ skill: false, odd: true });
		assert.deepEqual(writeCardFileSwitch('odd', false), { ok: true, value: { skill: false, odd: false } });
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL({ skill: false, odd: false }));
	});

	test('never rewrites a malformed document, and leaves its bytes alone', () => {
		writeDocument(home, '{"schema":"gentle-pi.card-files/v1","skill":"no","odd":true}');
		const before = readFileSync(documentIn(home), 'utf8');
		assert.deepEqual(writeCardFileSwitch('skill', true), { ok: false, reason: 'malformed_file' });
		assert.equal(readFileSync(documentIn(home), 'utf8'), before, 'the document is untouched');
		assert.equal(globalThis[CARD_FILES_SLOT], undefined, 'a refused write never flips the live slot');
		assert.deepEqual(readCardFiles(), ON, 'and the reads still fall back to the defaults');
	});

	test('never rewrites an unreadable document', () => {
		mkdirSync(documentIn(home), { recursive: true });
		assert.deepEqual(writeCardFileSwitch('odd', false), { ok: false, reason: 'unreadable_file' });
		assert.equal(statSync(documentIn(home)).isDirectory(), true, 'the path is still the directory it was');
		assert.equal(globalThis[CARD_FILES_SLOT], undefined);
	});

	test('an invalid kind or a non-boolean is refused before anything is touched', () => {
		for (const kind of [undefined, null, '', 'skills', 'ODD', 1, {}]) {
			assert.deepEqual(writeCardFileSwitch(kind, false), { ok: false, reason: 'invalid_kind' }, `${JSON.stringify(kind)} names no switch`);
		}
		for (const value of [undefined, null, 1, 0, 'false', 'true', {}, []]) {
			assert.deepEqual(writeCardFileSwitch('skill', value), { ok: false, reason: 'invalid_value' }, `${JSON.stringify(value)} is not a boolean`);
		}
		assert.deepEqual(readdirSync(home), [], 'no document was created for a switch that does not exist');
		assert.equal(globalThis[CARD_FILES_SLOT], undefined);
	});

	test('an unwritable home is a failure, not a throw and not a write', () => {
		chmodSync(home, 0o500);
		try {
			const result = writeCardFileSwitch('skill', false);
			assert.deepEqual(result, { ok: false, reason: 'write_failed' });
			assert.deepEqual(readdirSync(home), [], 'nothing was written');
			assert.equal(globalThis[CARD_FILES_SLOT], undefined);
		} finally {
			chmodSync(home, 0o700);
		}
	});
});

// ---- `<home>` resolution: GENTLE_PI_CONFIG_HOME → GENTLE_SHELL_CONFIG_HOME → ~/.pi/gentle-ai ----

describe('the config home', () => {
	test('resolves pi first, then the shell, then the user default', () => {
		const piHome = newHome('env-pi');
		const shellHome = newHome('env-shell');

		process.env.GENTLE_PI_CONFIG_HOME = piHome;
		process.env.GENTLE_SHELL_CONFIG_HOME = shellHome;
		assert.equal(cardFilesHome(process.env), piHome);
		assert.equal(cardFilesFile(), documentIn(piHome));

		delete process.env.GENTLE_PI_CONFIG_HOME;
		assert.equal(cardFilesHome(process.env), shellHome);
		assert.equal(cardFilesFile(), documentIn(shellHome));

		// A blank value is not a choice: the next source answers.
		process.env.GENTLE_SHELL_CONFIG_HOME = '   ';
		assert.equal(cardFilesHome(process.env), join(homedir(), '.pi', 'gentle-ai'));
		assert.equal(cardFilesFile(), join(homedir(), '.pi', 'gentle-ai', CARD_FILES_FILE));
		assert.doesNotThrow(() => cardFilesHome(null));
		assert.doesNotThrow(() => cardFilesHome('GENTLE_PI_CONFIG_HOME'));
	});
});

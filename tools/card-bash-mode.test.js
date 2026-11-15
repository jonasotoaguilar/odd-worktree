'use strict';
// S1/S6/S7: the `/card:bash` toggle and the one document behind it.
//
// The first half reads the mode module's public surface — the two modes, the
// strict `<home>/card-bash.json`, the process-wide slot a live session reads and
// the writer that persists the toggle — and never its module state. The second
// half drives the registered command through the loaded extension, so what is
// asserted is what a human sees: the one reported line, the document on disk and
// the state a failure leaves behind.
//
// Every document lives in a scratch directory reached through
// `GENTLE_PI_CONFIG_HOME` (the home resolution `lib/card-style.js` already owns),
// so no case reads or writes the real Pi home. The slot is cleared before and
// after every case and the environment is restored afterwards, so one case can
// never decide another's mode.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	CARD_BASH_FILE,
	CARD_BASH_MODE,
	CARD_BASH_MODES,
	CARD_BASH_MODE_SLOT,
	CARD_BASH_SCHEMA,
	cardBashMode,
	cardBashModeFile,
	cardBashModeHome,
	parseCardBashModeFile,
	resolveCardBashMode,
	writeCardBashMode,
} = require('../lib/card-bash-mode.js');
const { loadExtension } = require('./fixtures/load-extension.js');

const VALID = (mode) => JSON.stringify({ schema: CARD_BASH_SCHEMA, mode });
const CANONICAL = (mode) => `${JSON.stringify({ schema: CARD_BASH_SCHEMA, mode })}\n`;

let scratch;
const newHome = (name) => {
	const home = join(scratch, name);
	mkdirSync(home, { recursive: true });
	return home;
};
const documentIn = (home) => join(home, CARD_BASH_FILE);
const writeDocument = (home, contents) => writeFileSync(documentIn(home), contents);

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
	if (value === undefined) delete globalThis[CARD_BASH_MODE_SLOT];
	else globalThis[CARD_BASH_MODE_SLOT] = value;
}

before(() => {
	scratch = mkdtempSync(join(tmpdir(), 'odd-card-bash-'));
});

beforeEach(() => {
	useSlot(undefined);
	delete process.env.GENTLE_PI_CONFIG_HOME;
	delete process.env.GENTLE_SHELL_CONFIG_HOME;
});

afterEach(() => {
	useSlot(undefined);
	restoreEnv();
});

after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---- the two modes, the slot and the document ----

describe('the mode reader', () => {
	test('names the two modes, the schema and the document', () => {
		assert.deepEqual(CARD_BASH_MODE, { OWN: 'own', DEFAULT: 'default' });
		assert.deepEqual(CARD_BASH_MODES, ['own', 'default']);
		assert.equal(CARD_BASH_SCHEMA, 'gentle-pi.card-bash/v1');
		assert.equal(CARD_BASH_FILE, 'card-bash.json');
		assert.equal(CARD_BASH_MODE_SLOT, Symbol.for('gentle-pi.card-bash-mode'), 'the slot is the one cell a live session reads');
		for (const fn of [cardBashMode, cardBashModeFile, cardBashModeHome, parseCardBashModeFile, resolveCardBashMode, writeCardBashMode]) {
			assert.equal(typeof fn, 'function');
		}
	});

	test('the document is strict: exactly the schema and one known mode, or nothing', () => {
		assert.equal(parseCardBashModeFile(VALID(CARD_BASH_MODE.OWN)), CARD_BASH_MODE.OWN);
		assert.equal(parseCardBashModeFile(VALID(CARD_BASH_MODE.DEFAULT)), CARD_BASH_MODE.DEFAULT);
		assert.equal(parseCardBashModeFile(`${VALID(CARD_BASH_MODE.OWN)}\n`), CARD_BASH_MODE.OWN, 'a trailing newline is the same document');

		for (const raw of [
			'',
			'   ',
			'own',
			'{',
			'null',
			'[]',
			'"default"',
			'42',
			JSON.stringify({ schema: CARD_BASH_SCHEMA }),
			JSON.stringify({ mode: CARD_BASH_MODE.OWN }),
			JSON.stringify({ schema: 'gentle-pi.card-bash/v2', mode: CARD_BASH_MODE.OWN }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, mode: CARD_BASH_MODE.OWN, extra: true }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, mode: 'activity' }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, mode: 1 }),
			JSON.stringify([{ schema: CARD_BASH_SCHEMA, mode: CARD_BASH_MODE.OWN }]),
		]) {
			assert.equal(parseCardBashModeFile(raw), undefined, `${JSON.stringify(raw)} states no mode`);
		}
		for (const value of [undefined, null, 1, {}]) {
			assert.equal(parseCardBashModeFile(value), undefined, 'a non-string is not a document');
		}
	});

	test('a missing document is our card switched on, and the reader says why', () => {
		const home = newHome('missing');
		assert.deepEqual(resolveCardBashMode({ gentlePiConfigHome: home }), {
			mode: CARD_BASH_MODE.OWN,
			source: 'default',
			reason: 'missing_file',
			slot: undefined,
			globalFile: documentIn(home),
		});
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.OWN, 'S6: our card is the default');
	});

	test('a document that states a mode is the answer when the slot is empty', () => {
		for (const mode of CARD_BASH_MODES) {
			const home = newHome(`document-${mode}`);
			writeDocument(home, VALID(mode));
			assert.deepEqual(resolveCardBashMode({ gentlePiConfigHome: home }), {
				mode,
				source: 'file',
				reason: null,
				slot: undefined,
				globalFile: documentIn(home),
			});
			assert.equal(cardBashMode({ gentlePiConfigHome: home }), mode);
		}
	});

	test('a malformed or unreadable document reads as our card on, with the reason', () => {
		const malformed = newHome('malformed');
		writeDocument(malformed, VALID('activity'));
		const bad = resolveCardBashMode({ gentlePiConfigHome: malformed });
		assert.equal(bad.mode, CARD_BASH_MODE.OWN);
		assert.equal(bad.source, 'default');
		assert.equal(bad.reason, 'malformed_file');

		// A document that cannot be read at all (here a directory wearing its name)
		// reports its own reason instead of pretending to be malformed.
		const unreadable = newHome('unreadable');
		mkdirSync(documentIn(unreadable), { recursive: true });
		const failure = resolveCardBashMode({ gentlePiConfigHome: unreadable });
		assert.equal(failure.mode, CARD_BASH_MODE.OWN);
		assert.equal(failure.reason, 'unreadable_file');
	});

	test('the live slot wins over the document, because that is what the session says', () => {
		const home = newHome('slot-wins');
		writeDocument(home, VALID(CARD_BASH_MODE.OWN));

		useSlot(CARD_BASH_MODE.DEFAULT);
		assert.deepEqual(resolveCardBashMode({ gentlePiConfigHome: home }), {
			mode: CARD_BASH_MODE.DEFAULT,
			source: 'slot',
			reason: 'slot',
			slot: CARD_BASH_MODE.DEFAULT,
			globalFile: documentIn(home),
		});
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.DEFAULT);
	});

	test('a slot holding anything but a known mode is not a decision', () => {
		const home = newHome('slot-unknown');
		writeDocument(home, VALID(CARD_BASH_MODE.DEFAULT));
		for (const value of ['activity', '', 0, null, {}, [], 'OWN']) {
			useSlot(value);
			assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.DEFAULT, `the document answers for ${JSON.stringify(value)}`);
			assert.equal(resolveCardBashMode({ gentlePiConfigHome: home }).source, 'file');
		}
	});

	test('the reader falls back to our card on instead of throwing on unusable input', () => {
		const home = newHome('hostile');
		writeDocument(home, VALID(CARD_BASH_MODE.OWN));
		for (const options of [undefined, null, 42, 'x', {}, { gentlePiConfigHome: 7 }, { gentlePiConfigHome: '' }]) {
			assert.doesNotThrow(() => resolveCardBashMode(options));
			assert.doesNotThrow(() => cardBashMode(options));
			assert.ok(CARD_BASH_MODES.includes(resolveCardBashMode(options).mode));
		}
	});

	// ---- `<home>` resolution: GENTLE_PI_CONFIG_HOME → GENTLE_SHELL_CONFIG_HOME → ~/.pi/gentle-ai ----

	test('the config home resolves pi first, then the shell, then the user default', () => {
		const piHome = newHome('env-pi');
		const shellHome = newHome('env-shell');

		process.env.GENTLE_PI_CONFIG_HOME = piHome;
		process.env.GENTLE_SHELL_CONFIG_HOME = shellHome;
		assert.equal(cardBashModeHome(process.env), piHome);
		assert.equal(cardBashModeFile(), documentIn(piHome));

		delete process.env.GENTLE_PI_CONFIG_HOME;
		assert.equal(cardBashModeHome(process.env), shellHome);
		assert.equal(cardBashModeFile(), documentIn(shellHome));

		// A blank value is not a choice: the next source answers.
		process.env.GENTLE_SHELL_CONFIG_HOME = '   ';
		assert.equal(cardBashModeHome(process.env), join(homedir(), '.pi', 'gentle-ai'));
		assert.equal(cardBashModeFile(), join(homedir(), '.pi', 'gentle-ai', CARD_BASH_FILE));
	});
});

// ---- the writer: atomic, owner-only, and never over a document it cannot read ----

describe('the mode writer', () => {
	test('writes the strict document with owner-only bits and no leftover temp file', () => {
		const home = newHome('write');
		const result = writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: home });
		assert.deepEqual(result, { ok: true, file: documentIn(home), mode: CARD_BASH_MODE.DEFAULT });
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.DEFAULT));
		assert.equal(statSync(documentIn(home)).mode & 0o777, 0o600, 'the document is owner-only');
		assert.deepEqual(readdirSync(home), [CARD_BASH_FILE], 'the temporary file is gone');
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.DEFAULT);

		// A second write replaces the document a live reader sees.
		assert.equal(writeCardBashMode(CARD_BASH_MODE.OWN, { gentlePiConfigHome: home }).ok, true);
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.OWN));
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.OWN);
	});

	test('creates the home it needs, and sets the live slot once the file is written', () => {
		const home = join(scratch, 'created', 'nested');
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.OWN);
		const result = writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: home });
		assert.equal(result.ok, true);
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.DEFAULT));
		assert.equal(globalThis[CARD_BASH_MODE_SLOT], CARD_BASH_MODE.DEFAULT, 'the live session reads the new mode at once');
	});

	test('never rewrites a malformed document, and leaves its bytes alone', () => {
		const home = newHome('malformed-write');
		writeDocument(home, '{"schema":"gentle-pi.card-bash/v1","mode":"activity"}');
		const before = readFileSync(documentIn(home), 'utf8');
		const result = writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: home });
		assert.deepEqual(result, { ok: false, reason: 'malformed_file', file: documentIn(home) });
		assert.equal(readFileSync(documentIn(home), 'utf8'), before, 'the document is untouched');
		assert.equal(globalThis[CARD_BASH_MODE_SLOT], undefined, 'a refused write never flips the live slot');
	});

	test('never rewrites an unreadable document', () => {
		const home = newHome('unreadable-write');
		mkdirSync(documentIn(home), { recursive: true });
		const result = writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: home });
		assert.deepEqual(result, { ok: false, reason: 'unreadable_file', file: documentIn(home) });
		assert.equal(statSync(documentIn(home)).isDirectory(), true, 'the path is still the directory it was');
	});

	test('an unwritable home is a failure, not a throw and not a write', () => {
		const home = newHome('readonly');
		chmodSync(home, 0o500);
		try {
			const result = writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: home });
			assert.equal(result.ok, false);
			assert.equal(result.reason, 'write_failed');
			assert.match(result.error, /^(EACCES|EPERM|EROFS)$/);
			assert.deepEqual(readdirSync(home), [], 'nothing was written');
			assert.equal(globalThis[CARD_BASH_MODE_SLOT], undefined);
		} finally {
			chmodSync(home, 0o700);
		}
	});

	test('an unknown mode is refused before anything is touched', () => {
		const home = newHome('unknown-mode');
		for (const value of ['activity', '', 'OWN', undefined, null, 1]) {
			assert.equal(writeCardBashMode(value, { gentlePiConfigHome: home }).ok, false, `${JSON.stringify(value)} is not a mode`);
		}
		assert.deepEqual(readdirSync(home), [], 'no document was created for a mode that does not exist');
	});

	test('no usable home writes nothing and still never throws', () => {
		const homeFile = join(newHome('home-is-a-file'), 'not-a-directory');
		writeFileSync(homeFile, 'x');
		const result = writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: homeFile });
		assert.equal(result.ok, false);
		assert.doesNotThrow(() => writeCardBashMode(CARD_BASH_MODE.DEFAULT, null));
	});
});

// ---- `/card:bash`: one line, one document, and a failure that changes nothing ----

describe('the /card:bash command', () => {
	/**
	 * The registered command plus a context whose notifications are exactly what a
	 * human would see. Each case loads its own extension instance, so the command
	 * under test is the one this case installed.
	 */
	async function harness() {
		const { commands } = await loadExtension({});
		const lines = [];
		const notify = (text, level) => lines.push([level, text]);
		const ctx = { cwd: scratch, hasUI: false, mode: 'tui', ui: { notify } };
		return { commands, lines, ctx };
	}

	test('is registered with the name the surface declares', async () => {
		const { commands } = await harness();
		const definition = commands.get('card:bash');
		assert.ok(definition, '/card:bash is registered');
		assert.equal(typeof definition.handler, 'function');
		assert.equal(typeof definition.description, 'string');
		assert.ok(definition.description.length > 0, 'the command is discoverable with a description');
	});

	test('the default state flips to the host default, reports it and writes the strict document', async () => {
		const home = newHome('command-flip');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		assert.equal(cardBashMode(), CARD_BASH_MODE.OWN, 'the default state is our card on');
		const { commands, lines, ctx } = await harness();

		await commands.get('card:bash').handler('', ctx);

		assert.deepEqual(lines, [['info', 'bash cards: gentle default']]);
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.DEFAULT));
		assert.equal(cardBashMode(), CARD_BASH_MODE.DEFAULT, 'and the live session already reads it');
	});

	test('invoking it twice returns to the first state', async () => {
		const home = newHome('command-toggle');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		const { commands, lines, ctx } = await harness();

		await commands.get('card:bash').handler('', ctx);
		await commands.get('card:bash').handler('', ctx);

		assert.deepEqual(lines, [['info', 'bash cards: gentle default'], ['info', 'bash cards: own (activity)']]);
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.OWN), 'the document follows the toggle');
		assert.equal(cardBashMode(), CARD_BASH_MODE.OWN, 'and so does the live session');
	});

	test('a malformed existing document is reported as a failure and never overwritten', async () => {
		const home = newHome('command-malformed');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		writeDocument(home, '{"schema":"gentle-pi.card-bash/v1","mode":"activity"}');
		const before = readFileSync(documentIn(home), 'utf8');
		const { commands, lines, ctx } = await harness();

		await commands.get('card:bash').handler('', ctx);

		assert.deepEqual(lines, [['error', `bash cards: could not save ${documentIn(home)} (the existing file is malformed); still own (activity)`]]);
		assert.equal(readFileSync(documentIn(home), 'utf8'), before, 'the malformed document is byte-identical');
		assert.equal(cardBashMode(), CARD_BASH_MODE.OWN, 'the state did not move');
	});

	test('the live slot decides the flip, not the document', async () => {
		const home = newHome('command-slot');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		writeDocument(home, VALID(CARD_BASH_MODE.OWN));
		useSlot(CARD_BASH_MODE.DEFAULT);
		const { commands, lines, ctx } = await harness();

		await commands.get('card:bash').handler('', ctx);

		assert.deepEqual(lines, [['info', 'bash cards: own (activity)']], 'the session was on the host default, so the toggle turns ours on');
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.OWN));
	});

	test('an unwritable home reports a failure and leaves the state unchanged', async () => {
		const home = newHome('command-readonly');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		const { commands, lines, ctx } = await harness();
		chmodSync(home, 0o500);
		try {
			await commands.get('card:bash').handler('', ctx);

			assert.equal(lines.length, 1);
			assert.equal(lines[0][0], 'error', 'a write failure is never reported as success');
			assert.match(lines[0][1], /^bash cards: could not save .* \((EACCES|EPERM|EROFS)\); still own \(activity\)$/);
			assert.deepEqual(readdirSync(home), [], 'nothing was written');
			assert.equal(cardBashMode(), CARD_BASH_MODE.OWN, 'the state is unchanged');
		} finally {
			chmodSync(home, 0o700);
		}
	});

	test('never throws into the host, even without a UI', async () => {
		const home = newHome('command-no-ui');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		const { commands } = await harness();

		await assert.doesNotReject(() => commands.get('card:bash').handler('', { cwd: scratch }));
		await assert.doesNotReject(() => commands.get('card:bash').handler('', undefined));
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.OWN), 'the toggle still happened; only the report had nowhere to go');
	});
});

'use strict';
// S3: the bash card preference and the one document behind it.
//
// The first half reads the mode module's public surface — the two modes, the
// strict `<home>/card-bash.json`, the process-wide slot a live session reads and
// the writer that persists the choice — and never its module state. The second
// half drives the customize row the preference lives in, through the bridge API
// on its published slot and the loaded extension, so what is asserted is what a
// human sees: the row group, the document on disk and the state a failure leaves
// behind.
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
const { registerCardBashCustomize } = require('../lib/card-bash-customize.js');
const { loadExtension } = require('./fixtures/load-extension.js');

const VALID = (mode) => JSON.stringify({ schema: CARD_BASH_SCHEMA, mode });
const CANONICAL = (mode) => `${JSON.stringify({ schema: CARD_BASH_SCHEMA, mode })}\n`;
// The bridge's published object, read from its slot and never imported.
const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');

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
	delete globalThis[BRIDGE_SLOT];
	delete process.env.GENTLE_PI_CONFIG_HOME;
	delete process.env.GENTLE_SHELL_CONFIG_HOME;
});

afterEach(() => {
	useSlot(undefined);
	delete globalThis[BRIDGE_SLOT];
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
			// S3: there is no legacy shape. `bash` instead of `mode` is a malformed
			// document like any other, whatever it carries.
			JSON.stringify({ schema: 'gentle-pi.card-bash/v2', bash: 'activity' }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: 'activity', mode: CARD_BASH_MODE.OWN }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: 'activity', extra: true }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: 'own' }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: 1 }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: null }),
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

	test('a wrong-schema, extra-key or unknown-value document is still malformed and still refused', () => {
		const home = newHome('malformed-variants');
		for (const raw of [
			JSON.stringify({ schema: 'gentle-pi.card-bash/v2', bash: 'activity' }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: 'activity', mode: CARD_BASH_MODE.OWN }),
			JSON.stringify({ schema: CARD_BASH_SCHEMA, bash: 'own' }),
		]) {
			writeFileSync(documentIn(home), raw);
			const read = resolveCardBashMode({ gentlePiConfigHome: home });
			assert.equal(read.mode, CARD_BASH_MODE.OWN, `${raw} reads as our card on`);
			assert.equal(read.reason, 'malformed_file', `${raw} says why`);
			assert.equal(writeCardBashMode(CARD_BASH_MODE.DEFAULT, { gentlePiConfigHome: home }).reason, 'malformed_file');
			assert.equal(readFileSync(documentIn(home), 'utf8'), raw, `${raw} is byte-identical after the refused write`);
		}
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

// ---- the customize row: the preference's only control surface ----
//
// S3 (T3): the preference is ONE `Card tool` row group in `/gentle:customize` →
// `Cards`, contributed through gentle-shell-bridge's published row API. These
// cases read that provider the way the host does — the API object on its global
// slot, the rows it hands over and the actions it runs — and assert the document
// on disk, never module state. The extension is loaded fresh per case, so the
// registration under test is the one that load made.

/** A fake bridge on the published slot, recording what the extension registers. */
function installBridge() {
	const providers = [];
	const sections = [];
	const repaints = [];
	globalThis[BRIDGE_SLOT] = {
		schema: 'gentle-shell-bridge/api',
		version: 1,
		registerRows: (provider) => {
			providers.push(provider);
			return () => {};
		},
		registerSection: (section) => {
			sections.push(section);
			return () => {};
		},
		createStore: () => ({}),
		requestRepaint: () => { repaints.push(1); },
	};
	return { providers, sections, repaints };
}

const rowsOf = (provider, home) => provider.rows({ theme: {}, configHome: home });
const currentOf = (rows) => rows.map((row) => row.choice.current());
const actionOf = (rows, value) => rows.find((row) => row.choice.value === value).action;

describe('the customize row', () => {
	test('registers one row provider for the Card tool setting under Cards', async () => {
		const home = newHome('customize-provider');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		const { providers } = installBridge();
		const loaded = await loadExtension({});

		// The bash switch has its own provider; the file cards add a second one
		// (`odd-worktree.cards.file-switches`), so this asserts the row group instead of
		// the total: one provider for this setting, and every provider under Cards.
		const provider = providers.find((entry) => entry.id === 'odd-worktree-card-bash');
		assert.ok(provider, 'exactly one row provider carries the Card tool setting');
		assert.equal(providers.filter((entry) => entry.id === 'odd-worktree-card-bash').length, 1, 'and it is registered once');
		for (const entry of providers) assert.equal(entry.category, 'Cards', 'every provider this package contributes lives under Cards');
		assert.equal(provider.id, 'odd-worktree-card-bash');
		assert.equal(provider.category, 'Cards');
		assert.equal(provider.name, 'Odd worktree');
		assert.equal(typeof provider.rows, 'function');

		// S3: three commands, not four. The preference has no command name any more.
		assert.deepEqual([...loaded.commands.keys()].sort(), ['issues', 'odd-list', 'warp'], 'the preference is not a command');
		assert.deepEqual([...loaded.tools.keys()].sort(), ['worktree_create', 'worktree_list'], 'the two tools are untouched');

		const rows = rowsOf(provider, home);
		assert.equal(rows.length, 2, 'the Card tool line has two values');
		assert.deepEqual(rows.map((row) => row.choice.setting), ['Card tool', 'Card tool'], 'the two rows are one setting');
		assert.deepEqual(rows.map((row) => row.choice.value), ['default', 'activity']);
		assert.deepEqual(rows.map((row) => row.label), ['default', 'activity'], 'each row is named by its value');
		assert.deepEqual(rows.map((row) => row.category), ['Cards', 'Cards'], 'every row carries the page it belongs to');
		assert.deepEqual(currentOf(rows), [false, true], 'activity — our card — is the default the row marks');
		for (const row of rows) assert.equal(typeof row.action, 'function', 'every value is applied by its own action');
	});

	test('selecting a value writes the document and changes the mode at once', async () => {
		const home = newHome('customize-write');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		const { providers, repaints } = installBridge();
		await loadExtension({});
		const provider = providers[0];

		await actionOf(rowsOf(provider, home), 'default')({});
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.DEFAULT), 'the click persists the canonical document');
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.DEFAULT, 'and the resolved mode follows');
		assert.equal(globalThis[CARD_BASH_MODE_SLOT], CARD_BASH_MODE.DEFAULT, 'the live slot is what repaints a card already drawn');
		assert.equal(repaints.length, 1, 'the click asks for the repaint that makes it visible');
		assert.deepEqual(currentOf(rowsOf(provider, home)), [true, false], 'the row group now marks default');

		await actionOf(rowsOf(provider, home), 'activity')({});
		assert.equal(readFileSync(documentIn(home), 'utf8'), CANONICAL(CARD_BASH_MODE.OWN), 'and activity writes its own mode back');
		assert.equal(cardBashMode({ gentlePiConfigHome: home }), CARD_BASH_MODE.OWN);
		assert.equal(repaints.length, 2, 'every applied choice repaints');
		assert.deepEqual(currentOf(rowsOf(provider, home)), [false, true]);
	});

	test('a refused write repaints nothing and leaves the document byte-identical', async () => {
		const home = newHome('customize-refused');
		process.env.GENTLE_PI_CONFIG_HOME = home;
		const broken = '{"schema":"some-other-schema","mode":"own"}\n';
		writeFileSync(documentIn(home), broken, 'utf8');
		const { providers, repaints } = installBridge();
		await loadExtension({});

		await actionOf(rowsOf(providers[0], home), 'default')({});
		assert.equal(readFileSync(documentIn(home), 'utf8'), broken, 'a document this package cannot parse is never replaced');
		assert.deepEqual(repaints, [], 'and nothing claims the change took effect');
	});

	test('a bridge without registerRows registers nothing and throws nothing', async () => {
		globalThis[BRIDGE_SLOT] = {
			schema: 'gentle-shell-bridge/api',
			version: 1,
			registerSection: () => () => {},
			createStore: () => ({}),
		};
		const loaded = await loadExtension({});
		assert.deepEqual([...loaded.commands.keys()].sort(), ['issues', 'odd-list', 'warp'], 'every other surface still registers');
		assert.deepEqual([...loaded.tools.keys()].sort(), ['worktree_create', 'worktree_list']);
	});

	test('a bridge that publishes later registers the row on the ready announcement', async () => {
		delete globalThis[BRIDGE_SLOT];
		const announced = [];
		const loaded = await loadExtension({
			events: {
				on: (event, handler) => {
					if (event === 'gentle-shell-bridge:ready') announced.push(handler);
					return () => {};
				},
			},
		});
		assert.equal(announced.length, 1, 'one announcement subscription carries every bridge surface');
		const { providers } = installBridge();
		assert.equal(providers.length, 0, 'nothing registers before the announcement');
		announced[0]();
		assert.equal(providers.length, 1);
		announced[0]();
		assert.equal(providers.length, 1, 'a repeated announcement never registers the row twice');
		assert.equal(loaded.commands.has('issues'), true, 'every other surface still works');
	});

	test('registering is idempotent, returns a disposer, and an absent API is a no-op', () => {
		const providers = [];
		const removed = [];
		const api = {
			registerRows: (provider) => {
				providers.push(provider);
				return () => { removed.push(provider); };
			},
		};
		const first = registerCardBashCustomize(api);
		assert.equal(typeof first, 'function', 'the registration hands back a disposer');
		assert.equal(registerCardBashCustomize(api), first, 'a second registration in one process is the same one');
		assert.equal(providers.length, 1);
		first();
		assert.equal(removed.length, 1, 'the disposer removes the row group');
		registerCardBashCustomize(api);
		assert.equal(providers.length, 2, 'after disposal a fresh registration is possible');

		for (const absent of [undefined, null, {}, 42, 'bridge']) {
			assert.equal(registerCardBashCustomize(absent), null, `${JSON.stringify(absent)} is not a bridge`);
			assert.doesNotThrow(() => registerCardBashCustomize(absent), 'an absent API is a no-op, never a throw');
		}
	});
});

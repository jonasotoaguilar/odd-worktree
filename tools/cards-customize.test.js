'use strict';
// S1 (T4): the two file-card switches as `/gentle:customize` rows under `Cards`.
//
// `Card skill` and `Card odd` are the two toggles `lib/card-files-mode.js` owns. This
// suite drives the public surface only — the row builder and the registration outcome
// — against a fake bridge object at the published symbol and a fake host with its
// `ui.notify` seam. No case reaches the real config home: the document lives in a
// scratch directory named through `GENTLE_PI_CONFIG_HOME`, and the process-wide
// bridge and registration slots are cleared before and after every case.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	CARDS_CUSTOMIZE_CATEGORY,
	CARDS_CUSTOMIZE_PROVIDER_ID,
	CARDS_CUSTOMIZE_STATE_SLOT,
	CARD_FILE_ROW_LABELS,
	CARD_FILE_ROW_VALUES,
	cardsCustomizeRows,
	registerCardsCustomize,
} = require('../lib/cards-customize.js');
const {
	CARD_FILES_FILE,
	CARD_FILES_SCHEMA,
	CARD_FILES_SLOT,
	cardFileEnabled,
} = require('../lib/card-files-mode.js');

const BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const READY_EVENT = 'gentle-shell-bridge:ready';

let scratch;
let home;

const savedEnv = {
	GENTLE_PI_CONFIG_HOME: process.env.GENTLE_PI_CONFIG_HOME,
	GENTLE_SHELL_CONFIG_HOME: process.env.GENTLE_SHELL_CONFIG_HOME,
};

const documentFile = () => join(home, CARD_FILES_FILE);
const readDocument = () => readFileSync(documentFile(), 'utf8');
const writeDocument = (contents) => writeFileSync(documentFile(), contents);

const clearSlots = () => {
	delete globalThis[BRIDGE_SLOT];
	delete globalThis[CARDS_CUSTOMIZE_STATE_SLOT];
	delete globalThis[CARD_FILES_SLOT];
};

function useCardFilesSlot(value) {
	if (value === undefined) delete globalThis[CARD_FILES_SLOT];
	else globalThis[CARD_FILES_SLOT] = value;
}

function restoreEnv() {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// The published bridge object, with only the members this module may use. `calls`
// records every `registerRows` invocation, so "registered once" is observable.
function bridgeObject(overrides = {}) {
	const calls = [];
	const registered = [];
	const api = {
		schema: 'gentle-shell-bridge/api',
		version: 1,
		registerRows(provider) {
			calls.push(provider);
			registered.push(provider);
			return () => {
				const index = registered.indexOf(provider);
				if (index !== -1) registered.splice(index, 1);
			};
		},
		...overrides,
	};
	return { api, calls, registered };
}

function installBridge(overrides = {}) {
	const bridge = bridgeObject(overrides);
	globalThis[BRIDGE_SLOT] = bridge.api;
	return bridge;
}

// A fake host: the ONE event bus, recorded. It deliberately has NO `ui`: the
// extension factory's `pi` is not an ExtensionContext, so a notifier read there is
// undefined in production and a test that invented one would hide exactly that.
function fakeHost(options = {}) {
	const subscriptions = [];
	const host = {
		events: {
			on: (event, handler) => {
				subscriptions.push({ event, handler });
				return () => {};
			},
		},
		...options,
	};
	return { host, subscriptions };
}

before(() => {
	scratch = mkdtempSync(join(tmpdir(), 'odd-cards-customize-'));
});

beforeEach(() => {
	clearSlots();
	restoreEnv();
	home = mkdtempSync(join(scratch, 'home-'));
	process.env.GENTLE_PI_CONFIG_HOME = home;
});

afterEach(() => {
	clearSlots();
	restoreEnv();
});

after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---- the rows, with no host at all ----

describe('the rows', () => {
	test('names the one provider, the category and the two switch labels', () => {
		assert.equal(CARDS_CUSTOMIZE_CATEGORY, 'Cards');
		assert.equal(typeof CARDS_CUSTOMIZE_PROVIDER_ID, 'string');
		assert.ok(CARDS_CUSTOMIZE_PROVIDER_ID.length > 0);
		assert.deepEqual(CARD_FILE_ROW_LABELS, { skill: 'Card skill', odd: 'Card odd' });
		assert.deepEqual(CARD_FILE_ROW_VALUES, { ON: 'on', OFF: 'off' });
		assert.equal(typeof CARDS_CUSTOMIZE_STATE_SLOT, 'symbol');
	});

	test('builds four rows in the two-setting shape without a host', () => {
		const rows = cardsCustomizeRows();
		assert.equal(rows.length, 4, 'two settings, one on row and one off row each');
		for (const row of rows) {
			assert.equal(row.category, 'Cards');
			assert.equal(typeof row.label, 'string');
			assert.equal(typeof row.action, 'function');
			assert.equal(typeof row.choice, 'object');
			assert.equal(typeof row.choice.current, 'function');
		}
		assert.deepEqual(
			rows.map((row) => row.choice.setting),
			['Card skill', 'Card skill', 'Card odd', 'Card odd'],
			'the two rows of a setting are consecutive and share its name',
		);
		assert.deepEqual(
			rows.map((row) => row.choice.value),
			['on', 'off', 'on', 'off'],
		);
		assert.deepEqual(
			rows.map((row) => row.label),
			['Card skill', 'Card skill', 'Card odd', 'Card odd'],
		);
	});

	test('current() reads the live switch, never a remembered value', () => {
		useCardFilesSlot({ skill: true, odd: false });
		const rows = cardsCustomizeRows();
		assert.deepEqual(rows.map((row) => row.choice.current()), [true, false, false, true]);

		// The same row objects answer the new state: no rebuild, no cache.
		useCardFilesSlot({ skill: false, odd: true });
		assert.deepEqual(rows.map((row) => row.choice.current()), [false, true, true, false]);
	});
});

// ---- registration ----

describe('registration', () => {
	test('a usable bridge receives one provider with the Cards category', () => {
		const { calls, registered } = installBridge();
		const { host } = fakeHost();
		const outcome = registerCardsCustomize(host);
		assert.deepEqual(outcome, { registered: true });
		assert.equal(calls.length, 1);
		assert.equal(registered.length, 1);
		const provider = registered[0];
		assert.equal(provider.id, CARDS_CUSTOMIZE_PROVIDER_ID);
		assert.equal(provider.category, 'Cards');
		assert.equal(typeof provider.rows, 'function');
		assert.equal(provider.rows({}).length, 4);
	});

	test('the row objects are stable across menu builds', () => {
		const { registered } = installBridge();
		const { host } = fakeHost();
		registerCardsCustomize(host);
		const first = registered[0].rows({});
		const second = registered[0].rows({});
		assert.notEqual(first, second, 'each build receives its own array');
		assert.equal(first[0], second[0], 'the rows themselves are not re-created');
		assert.deepEqual(first, second);
	});

	test('a second call is a no-op that reports it', () => {
		const { calls } = installBridge();
		const { host } = fakeHost();
		assert.deepEqual(registerCardsCustomize(host), { registered: true });
		assert.deepEqual(registerCardsCustomize(host), { registered: false, reason: 'already_registered' });
		assert.equal(calls.length, 1, 'the bridge is asked once per process');
	});

	test('no bridge with no event bus registers nothing and throws nothing', () => {
		const { host } = fakeHost({ events: undefined });
		const outcome = registerCardsCustomize(host);
		assert.equal(outcome.registered, false);
		assert.equal(outcome.reason, 'no_bridge');
		assert.doesNotThrow(() => registerCardsCustomize());
	});

	test('a wrong schema, version or missing hook registers nothing', () => {
		for (const overrides of [
			{ schema: 'other-bridge/api' },
			{ schema: undefined },
			{ version: 2 },
			{ version: '1' },
			{ registerRows: undefined },
			{ registerRows: 'not a function' },
		]) {
			clearSlots();
			const { calls } = installBridge(overrides);
			const { host } = fakeHost();
			let outcome;
			assert.doesNotThrow(() => {
				outcome = registerCardsCustomize(host);
			});
			assert.equal(outcome.registered, false, JSON.stringify(overrides));
			assert.equal(calls.length, 0, 'nothing is registered for a refused bridge');
		}
	});

	test('a throwing bridge registers nothing and reports the failure', () => {
		const { host } = fakeHost();
		installBridge({
			registerRows: () => {
				throw new Error('refused');
			},
		});
		let outcome;
		assert.doesNotThrow(() => {
			outcome = registerCardsCustomize(host);
		});
		assert.equal(outcome.registered, false);
		assert.equal(outcome.reason, 'register_failed');
	});

	test('with no bridge the ready announcement is subscribed once and registers later', () => {
		const { host, subscriptions } = fakeHost();
		const waiting = registerCardsCustomize(host);
		assert.equal(waiting.registered, false);
		assert.equal(waiting.reason, 'awaiting_bridge');
		assert.equal(subscriptions.length, 1);
		assert.equal(subscriptions[0].event, READY_EVENT);

		// Asking again before the bridge exists never subscribes twice.
		assert.equal(registerCardsCustomize(host).registered, false);
		assert.equal(subscriptions.length, 1);

		const { calls, registered } = installBridge();
		subscriptions[0].handler({ schema: 'gentle-shell-bridge/api', version: 1 });
		assert.equal(calls.length, 1);
		assert.equal(registered.length, 1);

		// A repeated announcement never stacks a second provider.
		subscriptions[0].handler();
		subscriptions[0].handler();
		assert.equal(calls.length, 1);
		assert.equal(registered.length, 1);
		assert.deepEqual(registerCardsCustomize(host), { registered: false, reason: 'already_registered' });
	});
});

// ---- applying a row ----

describe('applying a row', () => {
	const rowsFor = (host) => {
		const { registered } = installBridge();
		registerCardsCustomize(host);
		return registered[0].rows({});
	};

	test("applying 'off' persists the document and flips current()", () => {
		const { host } = fakeHost();
		const rows = rowsFor(host);
		let outcome;
		assert.doesNotThrow(() => {
			outcome = rows[1].action();
		}, 'a switch that stuck returns normally');
		assert.equal(outcome.ok, true);

		assert.equal(
			readDocument(),
			`${JSON.stringify({ schema: CARD_FILES_SCHEMA, skill: false, odd: true })}\n`,
			'the persisted document is the strict one this package writes',
		);
		assert.equal(cardFileEnabled('skill'), false);
		assert.equal(rows[0].choice.current(), false, 'the on row is no longer current');
		assert.equal(rows[1].choice.current(), true, 'the off row is current');
		assert.equal(rows[2].choice.current(), true, 'the other setting is untouched');
	});

	test('a refused write THROWS the sentence the user needs and leaves the switch unchanged', () => {
		writeDocument('{"schema":');
		const { host } = fakeHost();
		const rows = rowsFor(host);

		// The production seam is the bridge's own action wrapper: it catches a
		// synchronous throw and reports it. Nothing inside this module may swallow it.
		assert.throws(
			() => rows[1].action(),
			(error) => {
				assert.ok(error instanceof Error, 'the failure leaves as an Error');
				assert.match(error.message, /Card skill/, 'the sentence names the switch');
				assert.match(error.message, /off/, 'the sentence names what was asked');
				assert.match(error.message, /malformed/, 'the reason is in words');
				assert.match(error.message, /malformed_file/, 'the writer code is kept');
				assert.match(error.message, /unchanged/, 'it says the switch did not move');
				return true;
			},
		);

		assert.equal(readDocument(), '{"schema":', 'the unreadable document is never rewritten');
		assert.equal(cardFileEnabled('skill'), true, 'the switch did not move');
		assert.equal(rows[0].choice.current(), true, 'current() still reads the old value');
		assert.equal(rows[1].choice.current(), false);
	});

	test('with no injection at all the refusal still leaves as a throw', () => {
		writeDocument('{"schema":');
		const rows = cardsCustomizeRows();
		assert.throws(() => rows[1].action(), /Card skill.*unchanged/s);
		assert.equal(cardFileEnabled('skill'), true);
	});

	test('a writer that throws is a refusal too, never a silent success', () => {
		const rows = cardsCustomizeRows({
			write: () => {
				throw new Error('disk gone');
			},
		});
		assert.throws(
			() => rows[0].action(),
			(error) => {
				assert.match(error.message, /write_failed/);
				assert.match(error.message, /unchanged/);
				return true;
			},
		);
	});
});

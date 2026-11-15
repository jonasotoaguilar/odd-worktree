'use strict';
// S1 (T4): the two file-card switches, `Card skill` and `Card odd`, published into
// Gentle Shell's `/gentle:customize` under its `Cards` category — through
// gentle-shell-bridge's own API v1 and nothing else.
//
// This module owns the Customize surface only. The switch itself (its one strict
// document and its live slot) belongs to `lib/card-files-mode.js`; the cards that obey
// it belong to T3's resolver. Here there is one RowProvider with four rows: each
// setting is TWO CONSECUTIVE rows sharing one `choice.setting` — an `on` row and an
// `off` row — which is the bridge's whole toggle shape, so the host draws one line per
// setting with a cursor over the two values.
//
// The decisions this module owns:
//   * THE BRIDGE GATE. The API is read from the symbol the bridge publishes
//     (`Symbol.for('gentle-shell-bridge/api/v1')`), never imported, and only when its
//     schema and major version are the ones this module was written against and it
//     carries the ONE hook used here, `registerRows`. A bridge that is not published,
//     is another library's payload, or is another major is simply absent.
//   * THE READY ANNOUNCEMENT. A bridge that publishes AFTER this extension loads
//     announces itself once (`gentle-shell-bridge:ready`). Only the first call with no
//     usable bridge subscribes; a repeated announcement still registers at most one
//     provider, because registration is guarded by a process-wide slot.
//   * ONE REGISTRATION PER PROCESS. The fact that the rows were registered lives on
//     the same kind of process-wide slot the bridge uses for its own object, so a
//     `/reload` (which builds a new module instance) cannot stack a second provider.
//   * THE ROWS ARE STABLE. They are built once, when the provider is registered, and
//     the provider hands back the same row objects on every menu build; `current()` is
//     the live read, so a flip is visible on the next build without rebuilding rows.
//   * LIVE STATE, NEVER A CACHE. `current()` asks `cardFileEnabled(kind)` at build
//     time, so the bullet can never show a value the session does not hold.
//   * PERSIST FIRST, REFUSAL REPORTED. A row's `action` runs before the host repaints,
//     and it writes through `writeCardFileSwitch`, which is the only writer of the
//     document. A refusal (a malformed or unreadable document, an unwritable file) is
//     reported through the host's `ui.notify` and never turned into a success: the
//     live state is untouched, so the repaint shows the switch where it really is.
//
// Nothing here throws into the host and nothing here warns on a host without the
// bridge: an absent Customize surface is not an error, and a missing plugin is the
// issues rail's one hint to speak, not this module's.

const { CARD_FILE_KINDS, cardFileEnabled, writeCardFileSwitch } = require('./card-files-mode.js');

// The provider's identity and the one category it may name. `Cards` is a page the host
// already renders, and the only one S1 asked for.
const CARDS_CUSTOMIZE_CATEGORY = 'Cards';
const CARDS_CUSTOMIZE_PROVIDER_ID = 'odd-worktree.cards.file-switches';

// The bridge handshake, exactly as the issues rail section reads it: the published
// object's own identity, the major this module was written against, and the ONE hook
// used here. A bridge too old or from another library is treated as absent.
const CARDS_BRIDGE_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const CARDS_BRIDGE_READY_EVENT = 'gentle-shell-bridge:ready';
const CARDS_BRIDGE_SCHEMA = 'gentle-shell-bridge/api';
const CARDS_BRIDGE_VERSION = 1;

// "Registered" and "subscribed" are facts about the PROCESS, not this module instance:
// a `/reload` builds a new instance, and a second provider would stack two rows on the
// same line. The slot is the same kind of cell the bridge publishes into.
const CARDS_CUSTOMIZE_STATE_SLOT = Symbol.for('odd-worktree/cards-customize/state');

// S1's own words: the two settings are named exactly this, in this order.
const CARD_FILE_ROW_LABELS = Object.freeze({ skill: 'Card skill', odd: 'Card odd' });

// One value per row. The pair reads as the switch it is — a row that turns the card on
// and a row that turns it off — instead of an opaque `true`/`false` on screen.
const CARD_FILE_ROW_VALUES = Object.freeze({ ON: 'on', OFF: 'off' });
const CARD_FILE_ROW_ORDER = Object.freeze([CARD_FILE_ROW_VALUES.ON, CARD_FILE_ROW_VALUES.OFF]);

// A refusal in words, with the writer's own reason code kept beside it so the report
// still names the exact branch a reader can find in `lib/card-files-mode.js`.
const CARD_FILE_REFUSAL_REASONS = Object.freeze({
	invalid_kind: 'the card name is not one of the two switches',
	invalid_value: 'the value is not a switch',
	no_home: 'no config home resolves',
	malformed_file: 'the card-files document is malformed',
	unreadable_file: 'the card-files document cannot be read',
	write_failed: 'the card-files document could not be written',
});

// The fallback when a host cannot hold the process-wide slot at all.
const localState = { registered: false, subscribed: false };

/**
 * The process-wide registration facts: `{registered, subscribed, provider, disposer}`.
 * A foreign value in the slot is replaced rather than trusted; a host whose global
 * object cannot hold the slot falls back to this module's own cell.
 */
function customizeState() {
	try {
		const existing = globalThis[CARDS_CUSTOMIZE_STATE_SLOT];
		if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) return existing;
		const created = { registered: false, subscribed: false };
		globalThis[CARDS_CUSTOMIZE_STATE_SLOT] = created;
		return created;
	} catch {
		return localState;
	}
}

/**
 * The published bridge object after its gate, or null. Only the members used here are
 * required: this module contributes rows and reads nothing else from the bridge, so a
 * bridge that can register rows is usable even if another surface is unavailable.
 */
function cardsBridgeApi() {
	try {
		const api = globalThis[CARDS_BRIDGE_SLOT];
		if (api === null || typeof api !== 'object') return null;
		if (api.schema !== CARDS_BRIDGE_SCHEMA || api.version !== CARDS_BRIDGE_VERSION) return null;
		return typeof api.registerRows === 'function' ? api : null;
	} catch {
		return null;
	}
}

/**
 * The host's notice seam, if it has one. `pi.ui.notify` is the extension API's own
 * seam; a caller may inject `deps.notify` instead (a test, or a front with a
 * different channel). A notice is advice, so a dead UI is swallowed, never rethrown.
 */
function notifySeam(pi, deps) {
	if (typeof deps.notify === 'function') return deps.notify;
	const ui = pi !== null && typeof pi === 'object' ? pi.ui : undefined;
	if (ui === null || typeof ui !== 'object' || typeof ui.notify !== 'function') return undefined;
	return (text, level) => {
		try {
			ui.notify(text, level);
		} catch {
			// An unusable notice seam never breaks a switch.
		}
	};
}

/** Why a switch did not stick, in one sentence that names the setting and the reason. */
function cardFileRefusalMessage(kind, enabled, reason) {
	const label = CARD_FILE_ROW_LABELS[kind];
	const target = enabled ? CARD_FILE_ROW_VALUES.ON : CARD_FILE_ROW_VALUES.OFF;
	const why = CARD_FILE_REFUSAL_REASONS[reason] ?? 'the switch could not be saved';
	return `${label} was not switched ${target}: ${why} (${reason}); the switch is unchanged.`;
}

/**
 * The four Customize rows, without a host: two settings, an `on` row then an `off` row
 * each, in the bridge's toggle shape.
 *
 * `deps` seams, all optional:
 *   * `host` — the cell `lib/card-files-mode.js` reads its live slot from
 *     (`globalThis` by default, the same seam its own tests use);
 *   * `notify(text, level)` — the refusal channel (`pi.ui.notify` when registering);
 *   * `write(kind, enabled, host)` — the writer (`writeCardFileSwitch` by default).
 *
 * The rows are plain objects: the host repaints from `current()`, never from a value
 * the row remembered, and `action()` persists BEFORE it returns, because the host
 * repaints as soon as it does. An action never throws: a writer that fails is a
 * refusal with a reason, and a refusal is reported.
 */
function cardsCustomizeRows(deps = {}) {
	const opts = deps !== null && typeof deps === 'object' ? deps : {};
	const host = opts.host;
	const notify = typeof opts.notify === 'function' ? opts.notify : undefined;
	const write = typeof opts.write === 'function' ? opts.write : writeCardFileSwitch;

	const apply = (kind, enabled) => {
		let outcome;
		try {
			outcome = write(kind, enabled, host);
		} catch {
			outcome = { ok: false, reason: 'write_failed' };
		}
		if (outcome !== null && typeof outcome === 'object' && outcome.ok === true) return outcome;
		const reason = outcome !== null && typeof outcome === 'object' && typeof outcome.reason === 'string'
			? outcome.reason
			: 'write_failed';
		if (typeof notify === 'function') {
			try {
				notify(cardFileRefusalMessage(kind, enabled, reason), 'warning');
			} catch {
				// A notice that cannot be shown never turns a refusal into a save.
			}
		}
		return { ok: false, reason };
	};

	const rows = [];
	for (const kind of CARD_FILE_KINDS) {
		const setting = CARD_FILE_ROW_LABELS[kind];
		for (const value of CARD_FILE_ROW_ORDER) {
			rows.push({
				category: CARDS_CUSTOMIZE_CATEGORY,
				label: setting,
				choice: {
					setting,
					value,
					// The bridge owns this normalisation anyway; stating it here keeps the
					// provider's row exactly what the host receives, without a staged copy.
					applyOnMove: false,
					// The LIVE switch, read at build time: the bullet can never lie.
					current: () => (cardFileEnabled(kind, host) ? CARD_FILE_ROW_VALUES.ON : CARD_FILE_ROW_VALUES.OFF) === value,
				},
				action: () => apply(kind, value === CARD_FILE_ROW_VALUES.ON),
			});
		}
	}
	return rows;
}

/**
 * Publish the two switches into `/gentle:customize` → `Cards`.
 *
 * `registerCardsCustomize(pi, deps)` answers `{registered: true}` when this call put
 * the provider on the bridge, and `{registered: false, reason}` otherwise:
 *   * `already_registered` — this process already registered the provider;
 *   * `awaiting_bridge` — no usable bridge yet; the ready announcement is subscribed
 *     once and registers as soon as a compatible one publishes;
 *   * `no_bridge` — no usable bridge and no event bus to wait on (or an announcement
 *     that still was not backed by a compatible object);
 *   * `register_failed` — the bridge refused the registration.
 *
 * It never throws. `deps` is forwarded to `cardsCustomizeRows` (`host`, `notify`,
 * `write`), so the host's notice seam is read once, at registration.
 */
function registerCardsCustomize(pi, deps = {}) {
	const opts = deps !== null && typeof deps === 'object' ? deps : {};
	const state = customizeState();
	try {
		if (state.registered === true) return { registered: false, reason: 'already_registered' };

		const api = cardsBridgeApi();
		if (api !== null) {
			// Built ONCE. The provider hands these same rows back on every menu build,
			// so a build pays one live `current()` read per row and nothing else.
			const rows = cardsCustomizeRows({ host: opts.host, notify: notifySeam(pi, opts), write: opts.write });
			const provider = {
				id: CARDS_CUSTOMIZE_PROVIDER_ID,
				category: CARDS_CUSTOMIZE_CATEGORY,
				rows: () => [...rows],
			};
			let disposer;
			try {
				disposer = api.registerRows(provider);
			} catch {
				return { registered: false, reason: 'register_failed' };
			}
			state.registered = true;
			state.provider = provider;
			state.disposer = typeof disposer === 'function' ? disposer : null;
			return { registered: true };
		}

		if (state.subscribed === true) return { registered: false, reason: 'no_bridge' };
		const events = pi !== null && typeof pi === 'object' ? pi.events : undefined;
		if (events === null || typeof events !== 'object' || typeof events.on !== 'function') {
			return { registered: false, reason: 'no_bridge' };
		}
		// One subscription per process, taken only when the slot was empty: the bridge
		// may publish after this extension loads, and its announcement is the only
		// notification there is.
		state.subscribed = true;
		try {
			events.on(CARDS_BRIDGE_READY_EVENT, () => {
				try {
					registerCardsCustomize(pi, opts);
				} catch {
					// An announcement that leads nowhere leaves every other surface alone.
				}
			});
		} catch {
			state.subscribed = false;
			return { registered: false, reason: 'no_bridge' };
		}
		return { registered: false, reason: 'awaiting_bridge' };
	} catch {
		// The Customize surface is optional: a broken bridge never breaks this extension.
		return { registered: false, reason: 'unavailable' };
	}
}

module.exports = {
	CARDS_CUSTOMIZE_CATEGORY,
	CARDS_CUSTOMIZE_PROVIDER_ID,
	CARDS_CUSTOMIZE_STATE_SLOT,
	CARD_FILE_ROW_LABELS,
	CARD_FILE_ROW_VALUES,
	cardFileRefusalMessage,
	cardsCustomizeRows,
	registerCardsCustomize,
};

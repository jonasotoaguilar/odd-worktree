'use strict';
// The one prototype-render shim both message cards use: Pi publishes no extension seam for a
// `role: "user"` entry and none for the assistant's final answer, so each card wraps the host
// component's own `render` and answers the card's rows instead of Pi's.
//
// WHY A FACTORY WITH A KEY. Every wrapped prototype, its ORIGINAL `render` and the live logic
// live in ONE state cell on `globalThis` behind a `Symbol.for` key, so `/reload` reuses the cell
// the first evaluation installed (the wrapper closes over the state OBJECT, not over one
// evaluation's module scope, and therefore always calls the newest logic). Two cards must not
// share that cell — a second class would inherit the first one's `patched` list and its logic —
// so the factory takes its OWN key and each card owns an independent install/uninstall pair.
//
// What the cell holds: `patched` (the prototypes this card wrapped, each with its ORIGINAL
// `render`), `wrapper` (the one wrapper this process ever installs), and `logic` (what the most
// recently evaluated module installed).
//
// The wrapper never throws and every refusal is honest: an unreadable original answers no rows
// rather than throwing at the host, and a throwing logic answers the original's rows byte for
// byte. `uninstall()` restores every prototype this cell wrapped, by reference, and forgets the
// live logic; the state object stays on its slot so the same wrapper object can be reused by the
// next install. A prototype another plugin has re-wrapped in the meantime is left alone.

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});

/**
 * Build the shim one card owns. `key` is the card's own `Symbol.for` key — the identity of its
 * state cell, so two cards never see each other's patches.
 */
function createHostRenderShim(key) {
	/** The state, read without creating it. */
	function readState() {
		try {
			const state = globalThis[key];
			return state !== null && typeof state === 'object' ? state : undefined;
		} catch {
			return undefined;
		}
	}

	/** The state, created when it is absent, always with the list of wrapped prototypes. */
	function stateSlot() {
		const existing = readState();
		if (existing !== undefined) {
			if (!Array.isArray(existing.patched)) existing.patched = [];
			return existing;
		}
		const state = { patched: [] };
		globalThis[key] = state;
		return state;
	}

	/** The original `render` of the nearest wrapped prototype, so the wrapper always calls the host's own. */
	function originalFor(state, self) {
		if (self === null || self === undefined) return undefined;
		let proto = Object.getPrototypeOf(self);
		while (proto !== null && proto !== undefined) {
			const entry = state.patched.find((kept) => kept.proto === proto);
			if (entry !== undefined) return entry.original;
			proto = Object.getPrototypeOf(proto);
		}
		return undefined;
	}

	/**
	 * The one wrapper this process ever installs. It hands the LIVE logic the host's own rows, the
	 * width the host asked for and the host's ORIGINAL `render`, which is what a card that must draw
	 * its body at a different width calls (never the width the wrapper was handed).
	 */
	function wrapperFor(state) {
		return function render(width) {
			const original = originalFor(state, this);
			// Unreachable for a wrapped prototype; answering no rows beats throwing at the host.
			if (typeof original !== 'function') return [];
			const rows = original.call(this, width);
			const logic = state.logic;
			if (typeof logic !== 'function') return rows;
			try {
				return logic(this, rows, width, original);
			} catch {
				// A card must never cost the person their message.
				return rows;
			}
		};
	}

	/**
	 * Wrap the class's `render` once per process and answer through `logic` from now on.
	 *
	 * Idempotent by construction: a prototype this cell already wraps is not wrapped again, so
	 * `/reload`, a second session and a second evaluation add no second layer, and only the LIVE
	 * logic is replaced. A class that cannot draw (no prototype, no `render`) installs nothing,
	 * answers `{ installed: false }` and keeps no logic.
	 */
	function install(component, logic) {
		const proto = typeof component === 'function' ? component.prototype : undefined;
		if (proto === null || typeof proto !== 'object' || typeof proto.render !== 'function') {
			return { installed: false, uninstall };
		}
		const state = stateSlot();
		if (typeof state.wrapper !== 'function') state.wrapper = wrapperFor(state);
		if (!state.patched.some((kept) => kept.proto === proto)) {
			state.patched.push({ proto, original: proto.render });
			proto.render = state.wrapper;
		}
		// The most recently evaluated logic is the one every wrapper calls, from now on.
		if (typeof logic === 'function') state.logic = logic;
		return { installed: true, uninstall };
	}

	/**
	 * Restore every prototype this cell wrapped, byte for byte, and forget the live logic. The
	 * state object stays on its slot so the same wrapper object can be reused by the next install;
	 * a prototype another plugin has re-wrapped in the meantime is left alone.
	 */
	function uninstall() {
		const state = readState();
		if (state === undefined) return false;
		const patched = Array.isArray(state.patched) ? state.patched : [];
		for (const entry of patched) {
			try {
				if (entry.proto.render === state.wrapper) entry.proto.render = entry.original;
			} catch {
				// A frozen prototype keeps the wrapper; nothing else of the install survives it.
			}
		}
		state.patched = [];
		state.logic = undefined;
		return true;
	}

	return { install, uninstall };
}

module.exports = { createHostRenderShim };

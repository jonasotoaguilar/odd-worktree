/**
 * The `Card style` rows (S1, S12): the host's own line, extended, with a reported fallback.
 *
 * Two modes, and exactly one of them is live:
 *
 * - **`extended`** — the host's rows were located in the captured array and spliced, so the bridge
 *   appends one row per registered style to that SAME line
 *   (`./card-style-line.ts` explains the splice). The host's own `neon`/`float` row objects are the
 *   originals, untouched: their `current()` still reads the host's config file and their `action()`
 *   still writes it. Only the registered values are the bridge's.
 * - **`separate`** — the host's line could not be located (renamed setting, a narrower host, no
 *   capture at all). The bridge then contributes its own line, `Bridge card style`, with `native`
 *   plus every registered style. `native` means "the bridge leaves the conversation alone". The
 *   mode is recorded so `/bridge-status` can say which line the user is actually seeing.
 *
 * ## Why the fallback is a provider and not more splicing
 *
 * A provider's rows are appended to the end of the array by `./rows.ts` (`buildRows`), so they can
 * never be consecutive with the host's own `Card style` rows and can never join that line — that is
 * exactly why the fallback uses a DIFFERENT setting name and label, and why the extended mode does
 * not use a provider at all. The provider exists only while the separate line is what the user sees;
 * a successful splice disposes it, so the bridge never contributes two lines.
 *
 * ## Many styles, one line (S12)
 *
 * The values are `snapshotCardStyles()` in its deterministic order (optional `order`, then
 * registration order), nothing capped and nothing hidden. A style registered later shows up on the
 * next menu build with no re-registration, because rows are built per build and never cached. The
 * bridge does not control the width the host gives that line: if the host clips, that is the host's
 * behaviour, and `/bridge-status` reports the count instead of masking it.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { registerBridgeRows, snapshotCardStyles } from "./bus.ts";
import {
  CARD_STYLE_NATIVE,
  HOST_CARD_STYLE_CATEGORY,
  HOST_CARD_STYLE_SETTING,
  spliceCardStyleValues,
} from "./card-style-line.ts";
import {
  getCardStyleSelection,
  resolveCardStyleSelection,
  setCardStyleSelection,
} from "./card-styles.ts";
import { refreshCardStyleSurfaces } from "./card-style-wiring.ts";
import { recordNotice } from "./notices.ts";
import { requestSurfaceRepaint } from "./repaint.ts";
import { cardStyleRowLabelText } from "./row-labels.ts";
import { isRecord } from "./rows.ts";
import type { CardStyleRegistration, CustomizeRow, RowPreview, RowProvider } from "./types.ts";

/** The fallback provider's id; it is the bridge's own registration, never a plugin's. */
export const CARD_STYLE_ROWS_PROVIDER_ID = "bridge.card-styles";

/**
 * The setting of the bridge's OWN line, used only in `separate` mode. Deliberately not the host's
 * `Card style`: a second row sharing that setting, appended somewhere else in the array, would not
 * join the host's line and would make `/bridge-status` report a duplicate.
 */
export const CARD_STYLE_FALLBACK_SETTING = "Bridge card style";

/**
 * The fallback line's own label; it names the line, and no value repeats it.
 *
 * Same vocabulary as every other row name (N7): one to three plain words, no arrow, colon, dot,
 * pipe, slash or bracket. The bridge enforces that shape on plugins (`./row-names.ts`), so its own
 * line reads the same way — `Bridge card style`, not `Bridge → card style` or `Bridge: card style`.
 */
export const CARD_STYLE_ROW_LABEL = "Bridge card style";

/** Which line the user sees: the host's, extended, or the bridge's own. */
export type CardStyleRowMode = "extended" | "separate";

interface CardStyleRowState {
  /** `separate` until a capture proves the host's line is there. */
  mode: CardStyleRowMode;
  /** Whether the wiring asked for the fallback line at all (it does not exist before arming). */
  wanted: boolean;
  /** The live fallback registration's disposer, while it is registered. */
  disposeFallback?: () => void;
}

/** Process-global, like the bus: a second copy of this package must see the same mode. */
const ROW_STATE = Symbol.for("gentle-shell-bridge.card-styles.rows.v1");

function rowHost(): Record<symbol, CardStyleRowState | undefined> {
  // SAFETY: only `rowState()` writes this key, and it re-checks every field before trusting a value
  // left by another copy or an older load.
  return globalThis as unknown as Record<symbol, CardStyleRowState | undefined>;
}

function isRowState(value: unknown): value is CardStyleRowState {
  if (!isRecord(value)) return false;
  return value.mode === "extended" || value.mode === "separate";
}

function rowState(): CardStyleRowState {
  const host = rowHost();
  const existing = host[ROW_STATE];
  if (isRowState(existing)) {
    if (typeof existing.wanted !== "boolean") existing.wanted = false;
    return existing;
  }
  const created: CardStyleRowState = { mode: "separate", wanted: false };
  host[ROW_STATE] = created;
  return created;
}

/** The line the last capture settled on. Reported by `/bridge-status` (T4). */
export function cardStyleRowMode(): CardStyleRowMode {
  return rowState().mode;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetCardStyleRowStateForTests(): void {
  const state = rowState();
  const dispose = state.disposeFallback;
  state.disposeFallback = undefined;
  state.wanted = false;
  state.mode = "separate";
  dispose?.();
}

/**
 * A style's own preview when it has one, otherwise a literal depiction of the value.
 *
 * A preview runs while the menu is being rendered, so it must not be able to break it: a throwing
 * (or malformed) plugin preview loses its own picture and nothing else (S6's discipline, applied to
 * the row instead of the frame).
 */
function previewFor(style: CardStyleRegistration): RowPreview {
  if (style.preview !== undefined) {
    try {
      const shown: unknown = style.preview();
      if (isRecord(shown) && typeof shown.title === "string" && typeof shown.sample === "string") {
        return { title: shown.title, sample: shown.sample };
      }
    } catch {
      // Fall through to the literal sample below.
    }
  }
  return {
    title: `Cards · ${style.label}`,
    sample: `${style.label}: every card the host drew is repainted with this style's frame`,
  };
}

/**
 * One registered value.
 *
 * `choice.value` is the style's short `label`, not its namespaced id, because the host renders
 * `value` and nothing else on a setting line (`lib/visual-customize-view.ts:583-595`) — the id would
 * put `loon.cute` in front of the user. The row's own `label` is the visible text too, derived from
 * that `label` (or the author's `rowLabel`, N1/N3): the id stays internal here as well. Identity is
 * carried by the closures below, never by the displayed text: `current()` compares the stored
 * selection with the style's id, and `action()` persists that id, so renaming a label cannot lose a
 * user's choice.
 *
 * `current()` reads the persisted selection live (so the bullet cannot lie), `action()` persists
 * FIRST and then repaints both card surfaces before returning (`selectStyle`, R3) rather than waiting
 * for an unrelated frame, and `preview()` is literal.
 */
/**
 * Select a style and repaint both surfaces (R3).
 *
 * Persistence happens FIRST, then the rail's transform is (re)attached if it never was, then the host
 * is asked for a frame — all synchronously, before the action returns, and nothing at all when the
 * stored selection is already the one picked: a press that changes nothing must not cost a frame.
 * The conversation and the rail both paint chrome from this value, so both are repainted.
 */
function selectStyle(id: string): void {
  if (getCardStyleSelection() === id) return;
  setCardStyleSelection(id);
  refreshCardStyleSurfaces();
  requestSurfaceRepaint({ cause: `card style → ${id}`, surfaces: ["conversation", "rail"] });
}

function styleRow(style: CardStyleRegistration, setting: string): CustomizeRow {
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    label: () => cardStyleRowLabelText(style),
    choice: {
      setting,
      value: style.label,
      // Move, then Enter (A1): a repaint of both surfaces on every ←/→ would change the card the
      // user is looking at while they are only walking the values (`visual-customize-view.ts:565`).
      applyOnMove: false,
      current: () => getCardStyleSelection() === style.id,
    },
    preview: () => previewFor(style),
    action: () => selectStyle(style.id),
  };
}

/** The `native` value: no repaint at all. Only the separate line has one (see the module comment). */
function nativeRow(setting: string): CustomizeRow {
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    label: () => CARD_STYLE_ROW_LABEL,
    choice: {
      setting,
      value: CARD_STYLE_NATIVE,
      // Same rule as every other value the bridge contributes (A1): the way back to the host's own
      // cards is confirmed with Enter too, never applied by passing over it.
      applyOnMove: false,
      current: () => getCardStyleSelection() === CARD_STYLE_NATIVE,
    },
    preview: () => ({
      title: "Cards · native",
      sample: "native: the bridge does not touch the conversation",
    }),
    action: () => selectStyle(CARD_STYLE_NATIVE),
  };
}

/**
 * Own property on a host row we already wrapped → the host row itself, so a second splice of the
 * same array cannot wrap our wrapper (which would delegate through two layers for no reason).
 */
const NATIVE_ROW_WRAPPED = Symbol.for("gentle-shell-bridge.card-style-rows.wrapped.v1");

/** True while the stored selection names a style that is actually registered (S13). */
function bridgeStyleActive(): boolean {
  // A `missing` selection (a style that was disposed while selected) is NOT active: the host's own
  // values must speak again, because `native` behaviour is the documented degrade (S12).
  return resolveCardStyleSelection().kind === "style";
}

/**
 * The host's own row, wrapped so exactly one value can be current (S13).
 *
 * The host normalizes an unknown stored style to `float`, so when a bridge style is selected the
 * host's `float` row claims current too and the line shows two bullets. This wrapper overrides
 * `choice.current` — `false` while a registered style is the selection, otherwise the host's own
 * answer, delegated unchanged — and `action`, which is where the way back lives: pressing a host
 * value means "the host renders, the bridge does not", so the host's own action runs and the bridge
 * selection is cleared to `native`. Everything else — `choice.value`, `choice.setting`,
 * `choice.hint`, `choice.applyOnMove`, `label`, `preview`, whatever else the host put there — is
 * carried over as the same reference, so the host's persistence keeps running and the bridge does
 * not reimplement `neon`/`float`. That includes `choice.applyOnMove` (A3): the host's own values keep
 * applying on ←/→ if the host wrote them that way, while the bridge value spliced beside them waits
 * for Enter — inside one rendered line each row's own field governs its own behaviour.
 */
function wrapHostRow(row: CustomizeRow): CustomizeRow {
  if (Object.hasOwn(row, NATIVE_ROW_WRAPPED)) return row;
  const choice = row.choice;
  if (choice === undefined || typeof choice.current !== "function") return row;

  const originalCurrent = choice.current;
  const originalAction = row.action;
  const value = typeof choice.value === "string" ? choice.value : "(unknown)";

  const wrapper: CustomizeRow = {
    ...row,
    choice: {
      ...choice,
      current: () => (bridgeStyleActive() ? false : originalCurrent.call(choice)),
    },
    // Pressing a host value is how a user leaves a bridge style: the host's own setter runs (so the
    // host's config and its repaint behave exactly as before), and the bridge selection returns to
    // `native` in `finally`, so a throwing setter cannot trap the session inside a style (S13).
    action: (inline) => {
      let result: unknown;
      try {
        result = typeof originalAction === "function" ? originalAction.call(row, inline) : undefined;
      } catch (error) {
        recordActionFailure(value, error);
        result = undefined;
      } finally {
        selectStyle(CARD_STYLE_NATIVE);
      }
      if (!isThenable(result)) return undefined;
      // An async setter's rejection arrives after the call returns; the selection is already native,
      // and the failure is recorded instead of escaping into the menu (which must keep working).
      return Promise.resolve(result).then(
        () => undefined,
        (error: unknown) => recordActionFailure(value, error),
      );
    },
  };
  Object.defineProperty(wrapper, NATIVE_ROW_WRAPPED, {
    value: row,
    enumerable: false,
    configurable: true,
  });
  return wrapper;
}

/** Record a host setter that threw, through the bridge's reporting channel (S13). */
function recordActionFailure(value: string, error: unknown): void {
  recordNotice(
    `gentle-shell-bridge: the host's Card style action for ${JSON.stringify(value)} threw: ` +
      `${error instanceof Error ? error.message : String(error)}. The bridge returned to native ` +
      "rendering so a broken setter cannot trap the session inside a bridge style.",
    "warning",
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The fallback provider. Its rows are rebuilt per menu build, never cached.
 *
 * With no style registered it contributes NOTHING: a session that never installed a style plugin
 * must not gain a `Bridge card style` line with a single `native` value on it. The provider is
 * still registered (arming precedes the plugins' own `session_start` handlers), so the first style
 * to register appears on the next menu build with no re-registration.
 */
function fallbackProvider(): RowProvider {
  return {
    id: CARD_STYLE_ROWS_PROVIDER_ID,
    category: HOST_CARD_STYLE_CATEGORY,
    rows: () => {
      const registered = snapshotCardStyles();
      if (registered.length === 0) return [];
      return [
        nativeRow(CARD_STYLE_FALLBACK_SETTING),
        ...registered.map((style) => styleRow(style, CARD_STYLE_FALLBACK_SETTING)),
      ];
    },
  };
}

function disposeFallback(state: CardStyleRowState): void {
  const dispose = state.disposeFallback;
  state.disposeFallback = undefined;
  dispose?.();
}

/** Make the registered providers match the mode: one line, never two. */
function sync(state: CardStyleRowState): void {
  if (state.wanted && state.mode === "separate") {
    if (state.disposeFallback === undefined) state.disposeFallback = registerBridgeRows(fallbackProvider());
    return;
  }
  disposeFallback(state);
}

/**
 * Register the fallback line for this process and return a disposer that withdraws it.
 *
 * Call it when the bridge arms; it needs no `tui` and no capture. Registering twice is a no-op (the
 * bus replaces a provider with the same id in place), and while the host's own line is reachable the
 * provider stays unregistered — the splice already carries the values.
 */
export function installCardStyleRows(): () => void {
  const state = rowState();
  state.wanted = true;
  sync(state);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    state.wanted = false;
    disposeFallback(state);
  };
}

/**
 * Splice the registered values into the host's own `Card style` line, in place, and settle which
 * line the user gets (S1).
 *
 * Called once per captured menu build, with the host's live rows array. It never throws: anything
 * that makes the line unreachable — no rows, a renamed setting, an array that refuses the edit —
 * records `separate` and lets the caller contribute the bridge's own line, which is reported rather
 * than silent.
 */
export function extendCardStyleLine(rows: CustomizeRow[]): CardStyleRowMode {
  const state = rowState();
  const registered = snapshotCardStyles();
  const values = registered.map((style) => styleRow(style, HOST_CARD_STYLE_SETTING));
  // With no style registered nothing can ever be selected, so the host's rows need no wrapper and
  // the array is not touched at all.
  const range = spliceCardStyleValues(
    rows,
    values,
    registered.length > 0 ? wrapHostRow : undefined,
  );
  state.mode = range === undefined ? "separate" : "extended";
  sync(state);
  return state.mode;
}

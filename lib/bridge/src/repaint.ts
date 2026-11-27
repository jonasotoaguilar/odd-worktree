/**
 * Repaint triggers (R3) and per-surface bookkeeping (R4): the half of a bridge-owned write that
 * makes it visible.
 *
 * ## Why a write needs to ask for a frame
 *
 * The bridge owns state that a HOST surface draws: a section's visibility (the rail paints the
 * section) and the card-style selection (both surfaces paint chrome from it). The bridge persists
 * that state synchronously — the host's row renderer re-reads `current()` when it repaints — but
 * persistence alone changes nothing on screen: gentle-shell re-renders a rail part only when its
 * digest changes or when the layout's own revision counter moves
 * (`lib/shell-sidebar-layout.ts:310-350`). That counter is what a part OWNER bumps:
 *
 * ```ts
 * if (sidebarTui) invalidateSidebar(sidebarTui);   // lib/shell-sidebar-layout.ts:105-107
 * host?.requestRender();                           // extensions/gentle-agents.ts:2147-2148
 * ```
 *
 * Both calls are the host's documented contract for "I changed what your rail shows". This package
 * cannot import gentle-shell's modules (Pi loads every extension through its own jiti loader with
 * `moduleCache: false`), so the two steps are performed against the same published state the host
 * itself uses:
 *
 * 1. `invalidateSidebar(tui)` is exactly `tui.terminal[CACHE].revision++`, where `CACHE` is
 *    `Symbol.for("gentle-pi.experimental-sidebar.cache")` — the symbol the host declares and reads
 *    (`lib/shell-sidebar-layout.ts:97-107`, `symbol.for` so every loaded copy shares it);
 * 2. `tui.requestRender()`: one differential frame (`tui.js:665-672`), which draws the rows that
 *    changed and leaves every other component's cache — and the terminal's differential state —
 *    alone.
 *
 * ## Why the tree is never invalidated (S19/T35-T36)
 *
 * T4 also called `tui.invalidate()` and forced the frame. Measuring both halves on real pi
 * components says neither is needed by EITHER kind of caller, and that they are what the freeze
 * was:
 *
 * | 600 children, one switch        | bridge row, today | differential only | invalidate + force |
 * | ------------------------------- | ----------------- | ----------------- | ------------------ |
 * | card style → example `plain`     | 697 ms            | 420 ms            | 721 ms             |
 * | card style → the host's `float`  | 306 ms            |  16 ms            | 307 ms             |
 * | section hidden, then a frame     |  99 ms            |   3 ms            | 100 ms             |
 *
 * The invalidation is the expensive half: it drops every mounted component's frame cache, so the
 * next frame re-parses every Markdown message of the transcript. The force is the other half: it
 * resets the renderer's differential state and rewrites the whole buffer.
 *
 * Neither buys the bridge anything, proven per surface (S19/T35, `test/surface-repaint-cost.ts`):
 *
 * - the CONVERSATION repaints the selected style in the wrapper, on the host's ALREADY rendered
 *   rows, on every pass (`./card-style-wiring.ts` → `./card-style-transform.ts`), so a cache that
 *   hands back the previous frame's rows is restyled just the same — the rows are byte-identical
 *   with and without the invalidation at 50, 200 and 600 children;
 * - the RAIL is framed the same way, by the same wrapper over the host's rail component
 *   (`transformCardLines(..., "rail")`), so a host memo that answers from its own cache is
 *   restyled too; and a SECTION toggle moves the bridge's own section digest, which the host's memo
 *   already keys on (`./sidebar-render.ts` `sectionRailDigest`), while the revision bumped below is
 *   the host's documented part-owner step for a digest that does not move;
 * - a style that came from the HOST (pressing `neon`/`float`) is inside the host card's own frame
 *   key (`cards-bash-v2` `extensions/quiet-tools.ts:942-965`), which is why the host's own setter
 *   never invalidates either (`extensions/gentle-shell.ts:3431-3437`).
 *
 * The control that proves this is not vacuous: with a host frame key that does NOT include the
 * style, the differential path draws the previous card and only the invalidation repairs it
 * (`test/surface-repaint-cost.test.ts` counts that case). So a future surface that genuinely caches
 * its own value can be given a LOCAL invalidate of that component — never the whole tree, and not
 * without the measured byte comparison this module's history records.
 *
 * Nothing else: no timer, no poll, no retry. A repaint that cannot happen is RECORDED and reported
 * by `/bridge-status` (`./status.ts`), because "the toggle did nothing" must always have an answer.
 *
 * ## Surfaces
 *
 * Two surfaces paint bridge-owned chrome: the conversation (the component
 * `./card-style-wiring.ts` wraps) and the rail (the host's rail component, wrapped the same way).
 * The reach of each is recorded where the attach is attempted, so a report can say "the rail was
 * never reached, and why" instead of only "no frame".
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { isRecord } from "./rows.ts";

/** What a plugin-facing repaint records as its cause, so `/bridge-status` reads as a sentence. */
const PLUGIN_REPAINT_CAUSE = "a plugin asked for a repaint";

/** Why nothing could be repainted: no host was captured at all. */
const NO_HOST_REASON = "no tui has been captured, so no surface can be repainted";

/** Why nothing could be repainted: the captured host has no frame request on it. */
const NO_FRAME_REQUEST_REASON =
  "the captured tui has no requestRender(), so no frame can be asked for";

/** The surfaces a card style can paint. Order is the order the report prints. */
export const PAINT_SURFACES = ["conversation", "rail"] as const;

export type PaintSurface = (typeof PAINT_SURFACES)[number];

/**
 * The host's terminal-side frame cache (`lib/shell-sidebar-layout.ts:97-107`). Symbol-keyed, so
 * every separately loaded copy of the host shares one counter per terminal.
 */
export const HOST_SIDEBAR_CACHE: symbol = Symbol.for("gentle-pi.experimental-sidebar.cache");

/** Whether a surface's repaint path was reached, and why not when it was not. */
export interface SurfaceReach {
  reached: boolean;
  /** Only when `reached` is false: the attach outcome, e.g. `no-layout-root`. */
  reason?: string;
}

/** What one `action()` did about the screen, as `/bridge-status` prints it. */
export interface RepaintTrigger {
  /** What changed, as a person reads it: `section "loon.music" → hidden`. */
  cause: string;
  /** The surfaces that display it, and whose repaint was requested. */
  surfaces: PaintSurface[];
  outcome: "repainted" | "unavailable";
  /** Only for `unavailable`: why no frame could be requested. */
  reason?: string;
}

export interface RepaintDiagnostics {
  /** Whether a `tui` has been captured yet; without one nothing can be repainted. */
  hostCaptured: boolean;
  reach: Partial<Record<PaintSurface, SurfaceReach>>;
  lastTrigger?: RepaintTrigger;
}

/** The host object Pi hands the widget factory, as far as this module reads it. */
export type RepaintHost = Record<string, unknown>;

interface RepaintState {
  tui?: unknown;
  reach: Partial<Record<PaintSurface, SurfaceReach>>;
  lastTrigger?: RepaintTrigger;
}

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const REPAINT_STATE = Symbol.for("gentle-shell-bridge.repaint.state.v1");

function repaintHost(): Record<symbol, RepaintState | undefined> {
  // SAFETY: only `repaintState()` writes this key, and it re-checks the shape it finds.
  return globalThis as unknown as Record<symbol, RepaintState | undefined>;
}

/**
 * The slot's shape, checked before use so a value another copy or an older load left behind is
 * replaced rather than trusted. `tui` and `lastTrigger` are only ever copied or replaced wholesale,
 * and both readers re-validate what they read.
 */
function isRepaintStateLike(value: unknown): value is RepaintState {
  return isRecord(value) && isRecord(value.reach);
}

function repaintState(): RepaintState {
  const host = repaintHost();
  const existing = host[REPAINT_STATE];
  if (isRepaintStateLike(existing)) return existing;
  const created: RepaintState = { reach: {} };
  host[REPAINT_STATE] = created;
  return created;
}

/**
 * Remember the `tui` Pi handed the widget factory (`./extension.ts`): the one documented hand-out,
 * and the only object whose `requestRender()` reaches the host's render loop.
 */
export function setRepaintHost(tui: unknown): void {
  repaintState().tui = tui;
}

/** The captured `tui`, for a caller that must attempt an attach before asking for a frame. */
export function getRepaintHost(): RepaintHost | undefined {
  const tui = repaintState().tui;
  return isRecord(tui) ? tui : undefined;
}

/** Record whether one surface's repaint path was reached (called where the attach is attempted). */
export function recordSurfaceReach(surface: PaintSurface, reach: SurfaceReach): void {
  repaintState().reach[surface] =
    reach.reached || reach.reason === undefined
      ? { reached: reach.reached }
      : { reached: false, reason: reach.reason };
}

/** The reach last recorded for one surface. */
export function getSurfaceReach(surface: PaintSurface): SurfaceReach | undefined {
  const reach = repaintState().reach[surface];
  return reach === undefined ? undefined : { ...reach };
}

/** Diagnostics snapshot for `/bridge-status` (R4) and for this module's own tests. */
export function getRepaintDiagnostics(): RepaintDiagnostics {
  const state = repaintState();
  const reach: Partial<Record<PaintSurface, SurfaceReach>> = {};
  for (const surface of PAINT_SURFACES) {
    const recorded = state.reach[surface];
    if (recorded !== undefined) reach[surface] = { ...recorded };
  }
  return {
    hostCaptured: state.tui !== undefined,
    reach,
    ...(state.lastTrigger === undefined ? {} : { lastTrigger: { ...state.lastTrigger } }),
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetRepaintForTests(): void {
  const state = repaintState();
  delete state.tui;
  state.reach = {};
  delete state.lastTrigger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bump the host's cache revision exactly as `invalidateSidebar(tui)` does
 * (`lib/shell-sidebar-layout.ts:105-107`): `tui.terminal[CACHE].revision++`, creating the slot the
 * host creates on its first invalidate. Never throws: a terminal that cannot carry the slot is a
 * non-host object, and the `requestRender()` that follows is still worth attempting.
 */
function invalidateHostSidebar(tui: Record<string, unknown>): void {
  try {
    const terminal = tui.terminal;
    if (!isRecord(terminal)) return;
    // SAFETY: the host stores a `{ revision: number }` object under this symbol on the terminal
    // (`lib/shell-sidebar-layout.ts:99-107`); a value of any other shape is replaced by the same
    // default the host itself uses, never trusted.
    const slot = terminal as Record<symbol, unknown>;
    const existing = slot[HOST_SIDEBAR_CACHE];
    if (isRecord(existing) && typeof existing.revision === "number") {
      existing.revision += 1;
      return;
    }
    slot[HOST_SIDEBAR_CACHE] = { revision: 1 };
  } catch {
    // A frozen terminal cannot be invalidated; the frame request below is still honest.
  }
}

/**
 * The one place a frame is asked for, shared by every repaint path (T4, S19/T36).
 *
 * One kind of caller, both kinds of value: a BRIDGE-owned row (`./card-style-rows.ts`,
 * `./sections-rows.ts`) and a plugin's own (`api.requestRepaint()`). Both change a value that a
 * wrapper re-reads on top of the host's rows on every pass, so one differential frame
 * (`requestRender()`, `tui.js:665-672`) draws the changed rows and leaves every other component's
 * cache — and the terminal's differential state — alone. Measuring the two halves that used to be
 * here is why (the table at the top of this module): `tui.invalidate()` re-parsed every Markdown
 * message of the transcript and `requestRender(true)` rewrote the whole buffer, and neither changed
 * a single row the switch had not already changed.
 *
 * Order matters and is asserted by the tests: the host's terminal-side cache revision is bumped
 * first, then the frame is asked for. Returns the trigger it recorded, including the reason the
 * frame could not be asked for.
 */
function requestFrame(input: {
  cause: string;
  surfaces: readonly PaintSurface[];
}): RepaintTrigger {
  const state = repaintState();
  const record = (outcome: RepaintTrigger["outcome"], reason?: string): RepaintTrigger => {
    const trigger: RepaintTrigger = {
      cause: input.cause,
      surfaces: [...input.surfaces],
      outcome,
      ...(reason === undefined ? {} : { reason }),
    };
    state.lastTrigger = trigger;
    return { ...trigger, surfaces: [...trigger.surfaces] };
  };

  const tui = state.tui;
  if (!isRecord(tui)) return record("unavailable", NO_HOST_REASON);
  const requestRender = tui.requestRender;
  if (typeof requestRender !== "function") return record("unavailable", NO_FRAME_REQUEST_REASON);

  invalidateHostSidebar(tui);
  try {
    requestRender.call(tui);
  } catch (error) {
    // A host that refuses a frame is reported, never swallowed: the write DID land, the screen did
    // not change, and only a report can distinguish that from "the toggle is broken".
    return record("unavailable", `requestRender threw: ${errorMessage(error)}`);
  }
  return record("repainted");
}

/**
 * Ask the host for a frame after a write to bridge-owned state (R3), retuned by S19/T36.
 *
 * Runs synchronously, before the caller's action returns: the host's sidebar revision is bumped
 * exactly as `invalidateSidebar(tui)` does (`lib/shell-sidebar-layout.ts:105-107`) and one
 * DIFFERENTIAL frame is requested. T4 also dropped every mounted component's frame cache and forced
 * the frame; measuring the restored example `plain` style, the way back to a host style, and a
 * section toggle on real pi-tui and pi's `ToolExecutionComponent` (50/200/600 children) says those
 * two halves cost 697/306/99 ms against 420/16/3 ms, and that the rows they draw are byte-identical
 * on the conversation, on a rail host panel, and on a bridge section collapsed, expanded and hidden
 * (`test/surface-repaint-cost.test.ts` bounds the work; the tables in this module's header record
 * the numbers).
 *
 * Records the trigger — cause, surfaces, outcome — so `/bridge-status` can report the last one,
 * including the reason a repaint could not happen.
 */
export function requestSurfaceRepaint(input: {
  cause: string;
  surfaces: readonly PaintSurface[];
}): RepaintTrigger {
  return requestFrame(input);
}

/**
 * Ask for a repaint of everything the host draws (T4), retuned from measurements (S13/T23): the
 * plugin-facing request behind `api.requestRepaint()`.
 *
 * T4 assumed a plugin's setting could only reach the cards already on screen through
 * `tui.invalidate()` + `requestRender(force = true)`. Measuring real pi-tui and pi's
 * `ToolExecutionComponent` on transcripts of 50/200/600 children says those two calls ARE the cost,
 * and that a plugin whose wrapper reads its value on every render pass does not need them:
 *
 * | 600 children, one switch        | frame | written |
 * | ------------------------------ | ----- | ------- |
 * | `requestRender()` (this path)    |  21 ms | 0 B (only the rows the diff finds) |
 * | `tui.invalidate()` + frame       | 730 ms | 0 B (every Markdown message re-parsed) |
 * | `requestRender(true)`            |  33 ms | 6.9 MB (whole buffer cleared and rewritten) |
 * | invalidate + force (old T4)      | 753 ms | 6.9 MB |
 *
 * A bridge-owned row makes the same claim, and measuring it is what S19/T35 added: the rows it
 * changes are repainted by the same wrapper, on top of the host's already rendered rows, so the
 * drawn card changes without any cache being dropped either — and the one cache that could replay
 * old chrome, the host card's `ToolCardRows`, is keyed on the HOST's own style
 * (`cards-bash-v2` `extensions/quiet-tools.ts:942-965`), which a bridge style never touches.
 *
 * The host's own `Card style` switch is the precedent its user compares with: it writes the value,
 * bumps the sidebar revision and calls `requestRender()` with no argument
 * (`extensions/gentle-shell.ts:3431-3437`) — no tree invalidation, no forced frame. `requestRepaint`
 * and `requestSurfaceRepaint` are that same two-step.
 *
 * Both surfaces are named, because both paint chrome from a plugin's value. Safe with no host
 * captured yet (a plugin may ask from its own `session_start`): the request is REPORTED as
 * `unavailable` with its reason, never thrown, and never queued for a host that may never arrive.
 */
export function requestRepaint(): RepaintTrigger {
  return requestFrame({
    cause: PLUGIN_REPAINT_CAUSE,
    surfaces: PAINT_SURFACES,
  });
}

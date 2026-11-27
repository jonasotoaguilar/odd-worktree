/**
 * Sidebar rail interception (S4, S9): the backend that lets the bridge contribute to
 * gentle-shell's fullscreen rail.
 *
 * ## Why the rail map, and not an API
 *
 * The rail is painted from ONE process-global map: `Symbol.for("gentle-pi.experimental-sidebar.state")`
 * on the terminal object → `state.parts`, a `Map<string, SidebarRail>` (`lib/shell-sidebar.ts:6,78-90`).
 * The layout paints only the hard-coded keys `["todo","jobs","agents","footer"]`
 * (`lib/shell-sidebar-layout.ts:344`), so a new key never renders: contributing rows to one of those
 * parts is the only way in. The bridge wraps ALL FOUR, because a section may ask to sit before the
 * first one, after one of the middle ones, or after the last (`SIDEBAR_RAIL_KEY`); the status
 * sections themselves live in a closure (`lib/shell-bar.ts:247,251-316`) we cannot reach — the
 * documented limit, and the reason "after a status section" is not offered.
 *
 * ## Order independence (S4)
 *
 * The host registers its parts itself (`extensions/gentle-shell.ts:2827` for `footer`, `:2895` for
 * `jobs`, `extensions/gentle-todo.ts:292` for `todo`, `extensions/gentle-agents.ts:2500` for
 * `agents`), so our arming may run before OR after any of them. The rail itself is therefore not the
 * seam; the MAP is. On install we patch the map instance's own `set` and `get`:
 *
 * - `set` wraps the value when the key is one of the four painted parts, so a registration that
 *   happens after our arm is captured with no polling;
 * - `get` wraps and stores on read, so a value written by a path that skipped our `set` (foreign
 *   code calling `Map.prototype.set`, a copy loaded before us) still arrives wrapped, and every
 *   later read returns the SAME wrapper object — stable identity matters, because the layout's memo
 *   compares the component and foreign readers compare `parts.get(key).spend` results.
 *
 * **Why patch the instance instead of subclassing or replacing the map:** `sidebarPart` and every
 * other reader re-reads `state.parts` from the state object, but nothing in the host forbids a
 * third-party extension from holding its own reference to the map it got earlier. A replacement
 * `Map` would leave those holders writing into a copy nobody intercepts, and a `Map` subclass cannot
 * be created from an existing map without changing its identity. Patching the instance's own
 * `set`/`get` (non-enumerable, configurable) keeps the identity every holder already has, keeps the
 * prototype's methods intact, and — unlike a prototype patch — is scoped to the one host map.
 * Restoring is exact: the own property is deleted, or the own descriptor that was there before is
 * put back.
 *
 * ## Wrapping a rail
 *
 * The wrapper spreads the host rail (`{ ...rail, render, cardGroups, handleMouse }`) so `digest`,
 * `spend`, `surface`, `summary`, `open`, `alert`, `invalidate` and every other field keep reaching
 * their readers with their identity untouched. `digest` is specifically NOT wrapped: the layout memo
 * keys on its value, and a wrapper that recomputed it would defeat the memo. The host's rails are
 * object literals (`extensions/gentle-shell.ts:2827`, `extensions/gentle-agents.ts:2500`), so an
 * own-property spread carries every field; a class instance whose methods live on the prototype
 * would need a prototype-preserving wrapper, which no host rail requires today.
 *
 * `render`/`cardGroups` delegate first and only then add — our rows around the host's own, never
 * instead of them. `handleMouse` delegates every event to the host's own handler with the host's own
 * `y` (its frame starts after our BEFORE rows), and answers an event that lands on a row this
 * contributor rendered itself — because the host's part handler never declines a move (see
 * `mouseThrough`). Every other event reaches the contributor only where the host declined, so the
 * host's own targets always win.
 *
 * ## Markers and idempotency
 *
 * Same discipline as the row capture backend (`./capture.ts`): a marker certifies the EXACT function
 * or object it names, is read as an OWN property, and never through the prototype chain.
 *
 * - `PARTS_INTERCEPTED` (own property on the map) → the exact `set` function we installed. A second
 *   install, a rebind or a second copy of this package sees it and reports `already-intercepted`
 *   instead of stacking a second layer.
 * - `RAIL_WRAPPED` (own property on the wrapper) → the exact host rail object it wraps. That makes
 *   wrapping idempotent (re-wrapping our own wrapper would double every contributed group) and
 *   leaves a FOREIGN wrapper in place: we wrap around it, never replace it.
 *
 * ## Disable and foreign references
 *
 * `disableSidebarBackend()` puts the host's rail back and unpatches the map, then bumps the
 * generation. Every method the wrapper exposes captures the generation it was built in and degrades
 * to a plain pass-through afterwards, so a wrapper that foreign code kept a reference to cannot
 * contribute rows, groups or mouse targets once the backend is off.
 *
 * ## Getting a real `tui` (open wiring question)
 *
 * A rail state is reached through a `tui`: `sidebarState(tui)` reads `tui.terminal`
 * (`lib/shell-sidebar.ts:78-80`). Pi does not expose a `tui` getter: `ExtensionUIContext` has no such
 * member (verified in `dist/core/extensions/types.d.ts` — `TUI` appears only as a factory parameter).
 * The only surfaces that hand an extension's factory the real TUI are
 * `ctx.ui.setWidget(key, factory)` (`interactive-mode.js:1998`, `content(this.ui, theme)`),
 * `setFooter` (`:2084`), `setHeader`, `custom` and `setEditorComponent`, and each installs a rendered
 * component. So this backend takes the rail state from a RESOLVER the caller supplies
 * (`installSidebarBackend(() => tuiLike)`), which keeps the eventual acquisition path — a widget
 * factory that stores the `tui` it receives and then yields a component rendering no rows — a wiring
 * detail rather than a rewrite. Whether such an empty component leaves the editor area untouched is
 * UNCONFIRMED: it has not been observed in a running Pi TUI.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { isRecord } from "./rows.ts";
import { notePanelCandidate } from "./section-panel.ts";
import { RAIL_PARTS } from "./types.ts";
import type { RailPart } from "./types.ts";

/** The host's own state key: the seam this backend intercepts. Never our own state. */
const HOST_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");

/** Process-global backend state, shared across copies like the bus (jiti's `moduleCache: false`). */
const BACKEND_STATE = Symbol.for("gentle-shell-bridge.sidebar.state.v1");
/** Own property on an intercepted map → the exact `set` function this module installed. */
const PARTS_INTERCEPTED = Symbol.for("gentle-shell-bridge.sidebar.parts.v1");
/** Own property on a wrapper rail → the exact host rail object it wraps. */
const RAIL_WRAPPED = Symbol.for("gentle-shell-bridge.sidebar.rail.v1");

/**
 * The part that ends the rail, and the one `"end"` means. The layout paints
 * `todo`, `jobs`, `agents`, `footer` in that order (`lib/shell-sidebar-layout.ts:344`), so the footer
 * is after every native section. Every painted part is wrapped (a section may ask for `"start"` or
 * `after` any of them); this key stays the one the diagnostics call "the rail".
 */
export const SIDEBAR_RAIL_KEY = "footer";

/** Whether a map key is a part the layout paints, and therefore one the bridge wraps. */
function isPaintedRailKey(key: string): key is RailPart {
  return (RAIL_PARTS as readonly string[]).includes(key);
}

/** Row ranges of the section cards a part draws, as the host's `cardGroups` returns them. */
export interface RailGroupLayout {
  groups: Array<{ start: number; end: number }>;
  loose?: number[];
}

/** What a pointer handler answers: the host's `{ handled, render }`, or our target's own result. */
export interface RailMouseResult {
  handled?: boolean;
  render?: boolean;
  [key: string]: unknown;
}

/**
 * The part of a rail this backend depends on. Every OTHER own enumerable string-keyed property of
 * the host's rail is carried through the wrapper's spread — in practice `digest`, `spend`,
 * `surface`, `summary`, `open`, `alert` and `invalidate` — but "every field" would be false: a
 * non-enumerable property, a method that lives on the prototype, and a getter (snapshotted once at
 * wrap time) do not survive the spread. Every host rail observed so far is an object literal
 * Every host rail observed so far is an object literal
 * (`extensions/gentle-shell.ts:2827`, `extensions/gentle-agents.ts:2500`), so nothing it carries is
 * lost; `test/sidebar-independent.test.ts` pins the limit rather than leaving it to prose.
 */
export interface SidebarRailLike {
  render(width: number): string[];
  cardGroups?(width: number): RailGroupLayout | undefined;
  /** The `Component`'s normalized mouse handler (`pi-tui` `Component.handleMouse`). */
  handleMouse?(event: unknown): RailMouseResult | undefined;
  /**
   * Cheap live-state digest; the layout memo skips re-renders while it holds (`digest !== undefined
   * ? existing.digest === digest : … cache.revision`, `lib/shell-sidebar-layout.ts:114-119`).
   *
   * A WRAPPER may answer `undefined` when neither the host nor a contributor has a signature: the
   * layout's reader (`railDigest`) treats that as "no digest" and falls back to the revision, which
   * is exactly how a rail without this member behaves. That case must stay distinguishable, so the
   * option is typed here rather than hidden behind a cast.
   */
  digest?(): string | undefined;
}

/**
 * A value in the host's rail map. The host types it as a map of rails; the bridge hands anything it
 * cannot wrap back unchanged instead of claiming every value is a rail, so a foreign write cannot
 * crash a read.
 */
export type RailMapValue = SidebarRailLike | Record<string, unknown> | undefined;

/** What a contributor adds to ONE wrapped part: rows around the host's own. */
export interface RailContribution {
  lines: string[];
  /** Card groups for `lines`, as row ranges RELATIVE to `lines[0]`; the wrapper offsets them. */
  groups: Array<{ start: number; end: number }>;
}

/** One part's contribution: a block drawn above the host's rows and/or a block drawn below them. */
export interface RailPartContribution {
  /** Drawn BEFORE the host's own rows. Absent means nothing above them. */
  before?: RailContribution;
  /** Drawn AFTER the host's own rows. Absent means nothing below them. */
  after?: RailContribution;
}

/** What a contributor is told about the frame it is being asked to contribute to. */
export interface RailContributorContext {
  /** The rail part currently rendering (`todo`, `jobs`, `agents`, `footer`). */
  part: RailPart;
  /**
   * The parts the host paints, in paint order — what a placement resolves against (S5). A part that
   * is absent from the map, hidden by `state.visibility.todo === false`, or that rendered no rows in
   * the previous frame is not painted, and an anchor on it falls forward to the next painted one.
   */
  painted: readonly RailPart[];
}

/**
 * The extension point the section renderer plugs into (T4). It knows nothing about sections: it
 * contributes rows around one part's own, their card groups, and may answer mouse events over them.
 */
export interface RailContributor {
  render(width: number, context: RailContributorContext): RailPartContribution | undefined;
  /**
   * A cheap signature of the live state the contributed rows paint (N14). The layout re-renders a
   * part only when its digest changes, so a row whose `meta` moved between frames must move this
   * value — otherwise the host would keep the cached rows and the field would look frozen.
   */
  digest?(context: RailContributorContext): string;
  /**
   * Our own mouse targets. An event over a row this contributor rendered is offered here FIRST (the
   * host's own part handler answers every move inside its frame, so waiting for it to decline would
   * never reach us); every other event is offered here only after the host's own handler declined,
   * so the host's own targets win wherever it has one. The event's `y` is in the PART's frame, so
   * `position` says which of those rows are this contributor's.
   */
  handleMouse?(event: unknown, position?: RailContributionPosition): RailMouseResult | undefined;
}

/** A half-open range of rows in one part's rendered frame: `[start, end)`. */
export interface RailRowRange {
  start: number;
  end: number;
}

/** Where a contributor's rows sit inside the part's rendered frame (S7). */
export interface RailContributionPosition {
  /** The part whose frame the event's `y` counts. */
  part: string;
  /**
   * The width the event was mapped at for this part — the width whose memo entry produced the ranges
   * below. A contributor records its rows per part AND per width, so an event that does not match
   * the width its rows were drawn at is declined instead of mapped onto a stale offset. Optional: a
   * position produced by an older copy carries no width, and a contributor that checks it declines
   * exactly as it does for its own parts it never rendered.
   */
  width?: number;
  /** The host's own rows in that frame. */
  native?: RailRowRange;
  /**
   * The rows this contributor drew ABOVE the host's own. A row range, not an offset: contributed
   * rows can now sit on either side of the host's, so "everything after the host's rows" is no
   * longer the shape of a contribution.
   */
  before?: RailRowRange;
  /** The rows this contributor drew BELOW the host's own. */
  after?: RailRowRange;
}

/**
 * A `tui`-like object: all this backend reads is `terminal`, which carries the host's rail state. The
 * index signature keeps the host's other members irrelevant instead of demanding an exact shape.
 */
export interface SidebarTuiLike {
  terminal?: unknown;
  [key: string]: unknown;
}

/**
 * Supplies the `tui`-like object whose `terminal` carries the host's rail state. Deliberately a
 * function: the real acquisition path may only have a `tui` later (see the module comment).
 */
export type SidebarTuiResolver = () => SidebarTuiLike | undefined;

export type SidebarInstallOutcome =
  | "intercepted"
  | "already-intercepted"
  | "no-sidebar-state"
  | "resolver-threw";

/**
 * What the wiring last recorded: an install attempt's outcome, or a problem that prevented one (no
 * `setWidget` surface, or a factory that has not run yet). `/bridge-status` reports the difference
 * between "we could not reach a rail" and "we never had a way to try".
 */
export type SidebarRecordedOutcome = SidebarInstallOutcome | "no-widget-surface";

/** What one install attempt did, so the caller and `/bridge-status` can report it. */
export interface InstallSidebarResult {
  installed: boolean;
  outcome: SidebarInstallOutcome;
  /** Whether the part `"end"` draws in (the host's `footer`) was already in the map when we looked. */
  rail: "wrapped" | "pending";
  /** Only for `resolver-threw`: the resolver's message. */
  reason?: string;
}

export type SidebarFailurePhase =
  | "render"
  | "cardGroups"
  | "contribute"
  | "handleMouse"
  | "digest";

/** A delegated host call or a contributor call that threw; recorded, never swallowed silently. */
export interface SidebarFailure {
  key: string;
  phase: SidebarFailurePhase;
  message: string;
}

export interface SidebarDiagnostics {
  /** Host rail maps currently intercepted in this process. */
  interceptedMaps: number;
  /** Painted parts currently wrapped, across every intercepted map (four per complete map). */
  wrappedRails: number;
  /**
   * Whether the part `"end"` draws in (the host's `footer`) is wrapped in the first intercepted map.
   * Reported separately from `wrappedRails` because the four parts are wrapped independently: a rail
   * whose sections all land before the footer must not look "wrapped" while the part they land in is
   * missing.
   */
  rail?: "wrapped" | "pending";
  lastFailures: SidebarFailure[];
  /** The most recent install attempt's outcome; absent until the backend is installed once. */
  lastOutcome?: SidebarRecordedOutcome;
  /** Only for `resolver-threw` and `no-widget-surface`: the reason, verbatim. */
  lastReason?: string;
}

type Rail = SidebarRailLike & Record<string, unknown>;
type RailMap = Map<string, RailMapValue>;
type MapSet = RailMap["set"];
type MapGet = RailMap["get"];
type MapDelete = RailMap["delete"];
type MapClear = RailMap["clear"];

/** One patched map, with everything a restore needs. */
interface Interception {
  parts: RailMap;
  /**
   * The host's sidebar state object the map came from. Kept for one field only: `visibility.todo`,
   * which the layout applies BEFORE asking a part to render, so a part the host hides must not be
   * treated as a placement anchor. Reading it is optional-chained and a missing field means painted.
   */
  hostState?: Record<string, unknown>;
  /** The own descriptor the map had before us, if any, so a restore is exact. */
  ownSet?: PropertyDescriptor;
  ownGet?: PropertyDescriptor;
  ownDelete?: PropertyDescriptor;
  ownClear?: PropertyDescriptor;
  /** The methods that were in force before us; a foreign patch stays reachable through them. */
  originalSet: MapSet;
  originalGet: MapGet;
  originalDelete: MapDelete;
  originalClear: MapClear;
  patchedSet: MapSet;
  patchedGet: MapGet;
  patchedDelete: MapDelete;
  patchedClear: MapClear;
}

/** One wrapped part, per (map, key), so a disable can put the host's own rail back. */
interface WrappedRailRecord {
  parts: RailMap;
  key: string;
  original: RailMapValue;
  wrapper: RailMapValue;
  /**
   * How many rows the host's own `render` produced the last time it was asked — the render-side
   * answer to "is this part painted?". Absent before the first frame: an unrendered part is assumed
   * painted, which is what makes the very first frame resolve the way the rail looks.
   */
  nativeRows?: number;
}

/** One render's worth of state, so `cardGroups` need not re-run the host or the contributor. */
interface RailMemoEntry {
  nativeLength: number;
  contribution?: RailPartContribution;
}

interface SidebarBackendState {
  /** Bumped by a disable/reset; a wrapper from an older generation is a pass-through. */
  generation: number;
  intercepted: Interception[];
  wrapped: WrappedRailRecord[];
  contributor?: RailContributor;
  lastFailures: SidebarFailure[];
  /** Remembered so `/bridge-status` can answer "was the rail ever reached?" (T6). */
  lastOutcome?: SidebarRecordedOutcome;
  lastReason?: string;
}

function backendHost(): Record<symbol, SidebarBackendState | undefined> {
  // SAFETY: only `sidebarState()` writes this key, and it validates every field before trusting a
  // value it finds, so a foreign or partial slot is replaced rather than used.
  return globalThis as unknown as Record<symbol, SidebarBackendState | undefined>;
}

function sidebarState(): SidebarBackendState {
  const host = backendHost();
  const existing = host[BACKEND_STATE];
  if (
    existing !== undefined &&
    typeof existing.generation === "number" &&
    Array.isArray(existing.intercepted) &&
    Array.isArray(existing.wrapped) &&
    Array.isArray(existing.lastFailures)
  ) {
    return existing;
  }
  const created: SidebarBackendState = {
    generation: 0,
    intercepted: [],
    wrapped: [],
    lastFailures: [],
  };
  host[BACKEND_STATE] = created;
  return created;
}

/** Diagnostics snapshot for `status` (T6) and for this backend's own tests. */
export function getSidebarDiagnostics(): SidebarDiagnostics {
  const state = sidebarState();
  const interception = state.intercepted[0];
  return {
    interceptedMaps: state.intercepted.length,
    wrappedRails: state.wrapped.length,
    ...(interception === undefined ? {} : { rail: railStatus(interception.parts) }),
    lastFailures: [...state.lastFailures],
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.lastReason === undefined ? {} : { lastReason: state.lastReason }),
  };
}

/** Test-only seam: forget every record and failure, so one test cannot leak into another. */
export function resetSidebarStateForTests(): void {
  const state = sidebarState();
  state.intercepted.length = 0;
  state.wrapped.length = 0;
  state.contributor = undefined;
  state.lastFailures.length = 0;
  delete state.lastOutcome;
  delete state.lastReason;
  // Bump so a wrapper a previous test retained becomes a pass-through instead of contributing.
  state.generation += 1;
}

/** Install (or clear) the renderer that contributes rows and groups to the wrapped part. */
export function setRailContributor(contributor: RailContributor | undefined): void {
  sidebarState().contributor = contributor;
}

/**
 * Record that the wiring could not even attempt an install — Pi's UI has no `setWidget`, or the
 * factory it accepted has not run yet. Reported by `/bridge-status` as unarmed WITH the reason, so
 * a missing section is explainable instead of silent. Never throws: reporting must not break a
 * session start.
 */
export function noteSidebarUnavailable(reason: string): void {
  const state = sidebarState();
  state.lastOutcome = "no-widget-surface";
  state.lastReason = reason;
}

/**
 * Intercept the host's rail map so our contribution reaches the part the layout paints, whether the
 * host registers that part before or after this call. Safe to call repeatedly: a second arm, a
 * rebind or a second copy of the package reports `already-intercepted` and installs nothing new.
 */
export function installSidebarBackend(resolveTui: SidebarTuiResolver): InstallSidebarResult {
  const result = attemptInstall(resolveTui);
  // Remembered for `/bridge-status`: "the rail was never reached" must be answerable (T6).
  const state = sidebarState();
  state.lastOutcome = result.outcome;
  if (result.reason === undefined) delete state.lastReason;
  else state.lastReason = result.reason;
  return result;
}

function attemptInstall(resolveTui: SidebarTuiResolver): InstallSidebarResult {
  let resolved: SidebarTuiLike | undefined;
  try {
    resolved = resolveTui();
  } catch (error) {
    // The wiring may not have a `tui` yet; that is a reported outcome, never a crash.
    return {
      installed: false,
      outcome: "resolver-threw",
      rail: "pending",
      reason: errorMessage(error),
    };
  }

  const parts = resolveParts(resolved);
  if (parts === undefined) return { installed: false, outcome: "no-sidebar-state", rail: "pending" };
  // One of the objects the bridge is handed: if a host ever publishes its panel builders on the
  // sidebar state, the section renderer uses them and `/bridge-status` says so (N11, N15).
  const hostState = hostSidebarStateOf(resolved);
  notePanelCandidate("the terminal sidebar state", hostState);
  return intercept(parts, hostState);
}

/**
 * Read the host's rail map from a `tui`-like object, exactly as `sidebarState(tui)` does: the state
 * hangs on `tui.terminal`, never on the `tui` itself. Absent state is never created here — inventing
 * an empty map would fabricate host state and mask a wiring mistake.
 */
function resolveParts(tui: SidebarTuiLike | undefined): RailMap | undefined {
  const state = hostSidebarStateOf(tui);
  if (state === undefined) return undefined;
  const parts = state.parts;
  if (!(parts instanceof Map)) return undefined;
  // SAFETY: the host declares `parts` as `Map<string, SidebarRail>`, and `SidebarRailLike` is the
  // part of a rail this backend relies on; anything else a foreign writer puts there is handled
  // defensively by `isRailLike` before it is wrapped.
  return parts as RailMap;
}

/**
 * The host's sidebar state object, read from the `tui` exactly as `sidebarState(tui)` writes it
 * (`lib/shell-sidebar.ts:78-81`): the state hangs on `tui.terminal`, never on the `tui` itself.
 *
 * Exported for the pointer claim (`./section-pointer.ts`), which performs the host's own
 * `setSidebarHover` steps against the SAME published slots — `parts` here, `hover` there. One reader
 * for one seam: a second copy of this lookup would be a second place to get the symbol wrong.
 */
export function hostSidebarStateOf(tui: unknown): Record<string, unknown> | undefined {
  if (!isRecord(tui)) return undefined;
  const terminal = tui.terminal;
  if (!isRecord(terminal)) return undefined;
  // SAFETY: the host stores its state under a symbol key; `isRecord` already proved the terminal is
  // an object, and everything read below is re-validated before use.
  const state = (terminal as Record<symbol, unknown>)[HOST_STATE];
  return isRecord(state) ? state : undefined;
}

function intercept(parts: RailMap, hostState?: Record<string, unknown>): InstallSidebarResult {
  const state = sidebarState();
  const existing = state.intercepted.find((record) => record.parts === parts);

  // The marker certifies the EXACT function we installed, read as an own property: a marker found
  // through the prototype chain describes some other object, and a marker whose value is not the
  // live `set` means foreign code replaced ours since (so we re-patch around it below).
  if (existing !== undefined && parts.set === existing.patchedSet) {
    // Already intercepted. Still make sure every painted part currently in the map is wrapped: a
    // value that arrived through a path which skipped our `set` is wrapped by our `get`.
    primePaintedParts(parts);
    return { installed: true, outcome: "already-intercepted", rail: railStatus(parts) };
  }
  if (existing !== undefined) state.intercepted.splice(state.intercepted.indexOf(existing), 1);

  const ownSet = Object.getOwnPropertyDescriptor(parts, "set");
  const ownGet = Object.getOwnPropertyDescriptor(parts, "get");
  const ownDelete = Object.getOwnPropertyDescriptor(parts, "delete");
  const ownClear = Object.getOwnPropertyDescriptor(parts, "clear");
  // Whatever is in force now stays reachable, so a foreign patch already on the map keeps running.
  const originalSet = parts.set;
  const originalGet = parts.get;
  const originalDelete = parts.delete;
  const originalClear = parts.clear;

  const patchedSet = function (this: RailMap, key: string, value: RailMapValue) {
    const stored = isPaintedRailKey(key) ? wrapRail(parts, key, value) : value;
    return originalSet.call(this, key, stored);
  } as MapSet;

  const patchedGet = function (this: RailMap, key: string) {
    const value = originalGet.call(this, key);
    if (!isPaintedRailKey(key) || value === undefined) return value;
    const wrapped = wrapRail(parts, key, value);
    if (wrapped === value) return value;
    // Store through the ORIGINAL set: re-entering our own patch would wrap twice for nothing.
    originalSet.call(this, key, wrapped);
    return wrapped;
  } as MapGet;

  // Deletion prunes the wrapped record, so diagnostics cannot claim a part is wrapped after the host
  // dropped it.
  const patchedDelete = function (this: RailMap, key: string): boolean {
    const deleted = originalDelete.call(this, key);
    if (deleted) forgetWrapped(parts, key);
    return deleted;
  } as MapDelete;

  const patchedClear = function (this: RailMap): void {
    originalClear.call(this);
    forgetWrapped(parts);
  } as MapClear;

  defineHidden(parts, "set", patchedSet);
  defineHidden(parts, "get", patchedGet);
  defineHidden(parts, "delete", patchedDelete);
  defineHidden(parts, "clear", patchedClear);
  defineHidden(parts, PARTS_INTERCEPTED, patchedSet);

  state.intercepted.push({
    parts,
    ...(hostState === undefined ? {} : { hostState }),
    ownSet,
    ownGet,
    ownDelete,
    ownClear,
    originalSet,
    originalGet,
    originalDelete,
    originalClear,
    patchedSet,
    patchedGet,
    patchedDelete,
    patchedClear,
  });
  primePaintedParts(parts);
  return { installed: true, outcome: "intercepted", rail: railStatus(parts) };
}

/** Read every painted key once, so a part registered before our arm arrives wrapped (see `patchedGet`). */
function primePaintedParts(parts: RailMap): void {
  for (const key of RAIL_PARTS) void parts.get(key);
}

/** Drop the wrapped-rail records for a part, so a deleted or cleared key is not reported as wrapped. */
function forgetWrapped(parts: RailMap, key?: string): void {
  const state = sidebarState();
  for (let index = state.wrapped.length - 1; index >= 0; index -= 1) {
    const record = state.wrapped[index];
    if (record.parts !== parts) continue;
    if (key !== undefined && record.key !== key) continue;
    state.wrapped.splice(index, 1);
  }
}

function railStatus(parts: RailMap): "wrapped" | "pending" {
  return parts.get(SIDEBAR_RAIL_KEY) === undefined ? "pending" : "wrapped";
}

/** Put the host's own rail back and unpatch every map we intercepted. Returns rails restored. */
export function disableSidebarBackend(): number {
  const state = sidebarState();
  const rails = state.wrapped.splice(0);
  let restored = 0;

  for (const interception of state.intercepted.splice(0)) {
    for (const rail of rails) {
      if (rail.parts !== interception.parts) continue;
      // Write through the ORIGINAL methods: our own `set` would wrap the host's rail again.
      const current = interception.originalGet.call(interception.parts, rail.key);
      if (current !== rail.wrapper) continue; // foreign code replaced it since: leave its value
      interception.originalSet.call(interception.parts, rail.key, rail.original);
      restored += 1;
    }
    restoreOwnMethod(interception.parts, "set", interception.patchedSet, interception.ownSet);
    restoreOwnMethod(interception.parts, "get", interception.patchedGet, interception.ownGet);
    restoreOwnMethod(
      interception.parts,
      "delete",
      interception.patchedDelete,
      interception.ownDelete,
    );
    restoreOwnMethod(
      interception.parts,
      "clear",
      interception.patchedClear,
      interception.ownClear,
    );
    if (Object.hasOwn(interception.parts, PARTS_INTERCEPTED)) {
      // SAFETY: the marker is the only symbol-keyed property this module writes on the map, and a
      // `Map` is an object, so it is reachable through a widened index type; this only removes it.
      delete (interception.parts as unknown as Record<PropertyKey, unknown>)[PARTS_INTERCEPTED];
    }
  }

  // A wrapper retained by foreign code becomes a pass-through through this bump. The remembered
  // outcome stays: "installed once, now off" is what lets `/bridge-status` answer "unarmed" rather
  // than "never attempted".
  state.generation += 1;
  return restored;
}

function restoreOwnMethod(
  parts: RailMap,
  name: "set" | "get" | "delete" | "clear",
  patched: unknown,
  own: PropertyDescriptor | undefined,
): void {
  // SAFETY: `parts` is a real `Map`, i.e. an object; `set`/`get` are ordinary string-keyed
  // properties of it, so reading and deleting them through a widened index type is exact.
  const target = parts as unknown as Record<string, unknown>;
  if (target[name] !== patched) return; // not ours any more: never clobber a foreign patch
  if (own === undefined) delete target[name];
  else Object.defineProperty(parts, name, own);
}

/**
 * Wrap one host rail, once. A value that is already our wrapper is returned unchanged, which is what
 * keeps a second install, a rebind and a second package copy from stacking wrappers or doubling the
 * contributed card groups.
 */
function wrapRail(parts: RailMap, key: string, rail: RailMapValue): RailMapValue {
  if (!isRailLike(rail)) return rail;
  if (isOurWrapper(rail)) return rail;

  const state = sidebarState();
  const original = rail;
  const generation = state.generation;
  const memo = new Map<number, RailMemoEntry>();
  // Only the four painted keys are ever wrapped (`isPaintedRailKey`), so this cast names the part
  // the contributor is told about, and nothing else is inferred from it.
  const part = key as RailPart;

  const wrapper: Rail = {
    ...original,
    render: (width: number) => renderThrough(parts, part, original, generation, memo, width),
    cardGroups: (width: number) => groupsThrough(parts, part, original, generation, memo, width),
    handleMouse: (event: unknown) => mouseThrough(part, original, generation, memo, event),
  };

  // The host's panel builders are looked for on the part itself (N11, N15): if a host ever publishes
  // `renderPanelHeader`/`renderPanelRow` here, the section renderer uses them instead of its local
  // port, and `/bridge-status` says so. Looking on every object the bridge is handed is what makes
  // "the host's builders are unreachable" a measurement rather than a claim.
  notePanelCandidate("the rail part", original);

  // The digest is the one field that is not a pass-through (N14): the layout memo re-renders a part
  // only when its digest VALUE moves, so a live row field (`meta`) would otherwise never repaint.
  // The field therefore stays a function whose value is the host's own digest, unchanged, whenever
  // nothing contributes one — the passthrough tests pin the VALUE, because the memo compares values
  // and never function identity. When a contributor has a signature, it is appended, so a change in
  // the built rows reaches the memo as a new key.
  wrapper.digest = () => digestValue(part, original, generation, paintedParts(parts));

  Object.defineProperty(wrapper, RAIL_WRAPPED, {
    value: original,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(wrapper, "railMemo", {
    value: memo,
    enumerable: false,
    configurable: true,
  });

  const record: WrappedRailRecord = { parts, key, original, wrapper };
  const index = state.wrapped.findIndex((entry) => entry.parts === parts && entry.key === key);
  if (index === -1) state.wrapped.push(record);
  else state.wrapped[index] = record;
  return wrapper;
}

function isRailLike(value: RailMapValue): value is Rail {
  return isRecord(value) && typeof value.render === "function";
}

/**
 * The parts the host actually paints, in paint order — what a placement resolves against (S5).
 *
 * Three facts make a part painted: it is in the map (the host registered it and did not dispose it),
 * the host's own visibility switch does not hide it (`state.visibility.todo === false`, the filter
 * the layout applies at `lib/shell-sidebar-layout.ts:344`), and its own `render` did not return an
 * empty frame the last time it ran (a part in compact-work or status-hidden mode paints nothing).
 * A part that has not rendered yet counts as painted: the first frame must resolve the way the rail
 * looks, not the way an empty observation would.
 */
function paintedParts(parts: RailMap): RailPart[] {
  const state = sidebarState();
  const visibility = hostVisibility(parts);
  return RAIL_PARTS.filter((key) => {
    if (key === "todo" && visibility?.todo === false) return false;
    const record = state.wrapped.find((entry) => entry.parts === parts && entry.key === key);
    return record !== undefined && record.nativeRows !== 0;
  });
}

/** The host's own `state.visibility`, when the object the map came from carries one. */
function hostVisibility(parts: RailMap): { todo?: boolean } | undefined {
  const hostState = sidebarState().intercepted.find((entry) => entry.parts === parts)?.hostState;
  const visibility = hostState?.visibility;
  return isRecord(visibility) ? (visibility as { todo?: boolean }) : undefined;
}

/** Remember how many rows one part's own render produced, so "painted" is a measurement. */
function recordNativeRows(parts: RailMap, key: RailPart, rows: number): void {
  const record = sidebarState().wrapped.find(
    (entry) => entry.parts === parts && entry.key === key,
  );
  if (record !== undefined) record.nativeRows = rows;
}

/**
 * The parts the host paints right now, for a caller that has no frame of its own (`/bridge-status`).
 * Before the first interception — or before any frame — this is every painted key, which is the
 * rail's normal shape: `todo`, `jobs`, `agents`, `footer`.
 */
export function observedPaintedParts(): RailPart[] {
  const interception = sidebarState().intercepted[0];
  return interception === undefined ? [...RAIL_PARTS] : paintedParts(interception.parts);
}

/** Own-property identity check: the marker's value is the exact rail this object wraps. */
function isOurWrapper(value: RailMapValue): boolean {
  if (!isRecord(value) || !Object.hasOwn(value, RAIL_WRAPPED)) return false;
  // SAFETY: the only writer of this symbol key is `wrapRail` above, whose value is a rail object.
  return isRecord((value as Record<symbol, unknown>)[RAIL_WRAPPED]);
}

/** Delegate to the host's `render`, then wrap our own rows around it — if the host painted anything. */
function renderThrough(
  parts: RailMap,
  key: RailPart,
  original: Rail,
  generation: number,
  memo: Map<number, RailMemoEntry>,
  width: number,
): string[] {
  if (sidebarState().generation !== generation) return [...(original.render(width) ?? [])];

  let native: string[];
  try {
    native = [...(original.render(width) ?? [])];
  } catch (error) {
    recordFailure(key, "render", error);
    // Never swallowed: the host's own failure path decides what a throwing part means.
    throw error;
  }

  // What the host's own frame is, remembered BEFORE the contribution resolves: whether this part is
  // painted is part of the answer to "where does a block anchored on it go" (S5).
  recordNativeRows(parts, key, native.length);

  if (native.length === 0) {
    // The host painted no frame (rail inactive, compact work row, another surface owns it). A frame
    // of ours here would appear exactly where the host suppressed its own.
    remember(memo, width, { nativeLength: 0 });
    return native;
  }

  const contribution = contributionFor(key, width, paintedParts(parts));
  remember(memo, width, { nativeLength: native.length, contribution });
  const before = contribution?.before?.lines ?? [];
  const after = contribution?.after?.lines ?? [];
  if (before.length === 0 && after.length === 0) return native;
  return [...before, ...native, ...after];
}

/** Delegate to the host's `cardGroups`, then wrap our groups around the host's, offset by ours. */
function groupsThrough(
  parts: RailMap,
  key: RailPart,
  original: Rail,
  generation: number,
  memo: Map<number, RailMemoEntry>,
  width: number,
): RailGroupLayout | undefined {
  if (sidebarState().generation !== generation) return original.cardGroups?.(width);

  const remembered = memo.get(width);
  let nativeLength = remembered?.nativeLength;
  if (nativeLength === undefined) {
    // `cardGroups` without a preceding `render`. The host always renders first (it needs the rows
    // before it asks for their ranges), so this is a fallback: measure instead of dropping our
    // groups silently, and let a throw surface exactly like it does through `render`.
    try {
      nativeLength = [...(original.render(width) ?? [])].length;
    } catch (error) {
      recordFailure(key, "render", error);
      throw error;
    }
  }
  const contribution =
    remembered !== undefined
      ? remembered.contribution
      : contributionFor(key, width, paintedParts(parts));
  if (remembered === undefined) remember(memo, width, { nativeLength, contribution });

  let base: RailGroupLayout | undefined;
  try {
    base = original.cardGroups?.(width);
  } catch (error) {
    recordFailure(key, "cardGroups", error);
    throw error;
  }
  // Same default the layout applies: without `cardGroups` a part is one section headed by its first
  // row, and that one section must cover the rows we wrap around it too.
  const hostLayout: RailGroupLayout = base ?? { groups: [{ start: 0, end: nativeLength }] };
  const beforeLength = contribution?.before?.lines.length ?? 0;
  const afterLength = contribution?.after?.lines.length ?? 0;

  if (nativeLength === 0 || (beforeLength === 0 && afterLength === 0)) {
    // Nothing of ours: the host's own layout object, untouched.
    return hostLayout;
  }

  const before = contribution?.before;
  const after = contribution?.after;
  return {
    groups: [
      ...(before?.groups ?? []),
      ...hostLayout.groups.map((group) => ({
        start: group.start + beforeLength,
        end: group.end + beforeLength,
      })),
      ...(after?.groups ?? []).map((group) => ({
        start: group.start + beforeLength + nativeLength,
        end: group.end + beforeLength + nativeLength,
      })),
    ],
    // The host's loose rows (key hints) are indices into the HOST's frame, so they move with it.
    ...(hostLayout.loose === undefined
      ? {}
      : { loose: hostLayout.loose.map((row) => row + beforeLength) }),
  };
}

/**
 * Delegate mouse dispatch to the host's own handler, and answer the rows we drew.
 *
 * A MOVE over our own rows goes to the contributor FIRST. The host's part handler is reachable
 * proof of why: the real `footer` part is a `NativePointerRegion`
 * (`extensions/gentle-shell.ts:2766`) whose `onHover`
 * (`extensions/gentle-shell.ts:2732-2741`, reached from `lib/native-pointer-region.ts:80-88`) claims
 * or clears the shared pointer and always returns `{ handled: true }` — the layout hands the part
 * every inflated row of its frame (`lib/shell-sidebar-layout.ts:245-259`) and the part answers all of
 * them. So "consult the host first and only then our targets" meant our appended rows never saw a
 * move at all. Our rows are exactly `[startRow, endRow)`, which the host's own targets never cover
 * (they live inside the host's own lines), so asking the contributor first for those rows cannot
 * take the pointer from a host card.
 *
 * Every other event keeps the host first: its targets win wherever it has one, and it DECLINES a
 * click or a press on a row it does not own (`extensions/gentle-shell.ts:2747-2757`), which is how a
 * contributed row's click reaches us today. When the contributor declines a move over our rows the
 * host still runs, so its own hover is cleared exactly as it would be for any row it does not own.
 *
 * The event's `y` counts the PART's rows. Since a part can now carry our rows ABOVE the host's as
 * well as below, the event is TRANSLATED for the host: `y` minus our before-block, so a host row
 * still reaches the host's handler with the host's own coordinate (S7). An event over one of our own
 * rows is offered to the host at `nativeLength` — one past its last row — which is exactly where an
 * appended row already sat before this feature, so the host still never claims one of our rows.
 */
function mouseThrough(
  key: RailPart,
  original: Rail,
  generation: number,
  memo: Map<number, RailMemoEntry>,
  event: unknown,
): RailMouseResult | undefined {
  const hostHandler = original.handleMouse;
  if (sidebarState().generation !== generation) {
    return typeof hostHandler === "function" ? hostHandler.call(original, event) : undefined;
  }

  const position = contributionPosition(key, memo, event);
  const region = regionOf(event, position);
  let consulted = false;
  if (region === "before" || region === "after") {
    // Our own rows: the contributor goes first, over the host's region, which would answer a move
    // here with "not mine" and a click with nothing.
    consulted = true;
    const own = contributorMouse(key, event, position);
    if (own !== undefined) return own;
  }

  if (typeof hostHandler === "function") {
    let result: RailMouseResult | undefined;
    const hostY = hostYFor(event, position, region);
    const hostEvent =
      hostY === undefined || !isRecord(event) ? event : { ...event, y: hostY };
    try {
      result = hostHandler.call(original, hostEvent);
    } catch (error) {
      recordFailure(key, "handleMouse", error);
      throw error;
    }
    // The host's targets win whenever it handled the event: we add targets, never override.
    if (result !== undefined) return result;
  }

  // Offered once: a second call would run a plugin's handler twice for one event.
  return consulted ? undefined : contributorMouse(key, event, position);
}

/** Which rows of the part frame the event landed on. */
type PointerRegion = "before" | "native" | "after" | undefined;

function within(y: number, range: RailRowRange | undefined): boolean {
  return range !== undefined && y >= range.start && y < range.end;
}

function regionOf(event: unknown, position: RailContributionPosition | undefined): PointerRegion {
  if (position === undefined || !isRecord(event)) return undefined;
  const y = event.y;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  if (within(y, position.before)) return "before";
  if (within(y, position.after)) return "after";
  if (within(y, position.native)) return "native";
  return undefined;
}

/**
 * The same pointer event's `y` in the HOST's own coordinates: its frame starts after our before-block,
 * and a row it did not draw is reported one past its last row (where an appended row already sat
 * before a before-block existed). `undefined` when there is nothing to translate.
 */
function hostYFor(
  event: unknown,
  position: RailContributionPosition | undefined,
  region: PointerRegion,
): number | undefined {
  if (position === undefined || !isRecord(event)) return undefined;
  const y = event.y;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  const beforeLength = position.before?.end ?? 0;
  const nativeLength = position.native === undefined ? 0 : position.native.end - position.native.start;
  return region === "before" ? nativeLength : y - beforeLength;
}

/** Ask the contributor, recording a throw instead of letting it reach the host's dispatch. */
function contributorMouse(
  key: string,
  event: unknown,
  position: RailContributionPosition | undefined,
): RailMouseResult | undefined {
  const contributor = sidebarState().contributor;
  if (contributor?.handleMouse === undefined) return undefined;
  try {
    return contributor.handleMouse(event, position);
  } catch (error) {
    recordFailure(key, "handleMouse", error);
    return undefined; // a broken target must not break the host's dispatch
  }
}

/**
 * Where the contributor's rows sit in the frame this event was mapped into.
 *
 * The host maps a hit to the part's own coordinates before calling its `handleMouse`
 * (`lib/shell-sidebar-layout.ts:245-259`), so `y` counts the part's rows, our before-block included;
 * the render that preceded the event recorded how many rows each block has at that width. Without
 * such a frame there is nothing to map, and the contributor declines instead of guessing an offset.
 * The width comes along, because the contributor's own ranges belong to the width they were drawn at.
 */
function contributionPosition(
  key: RailPart,
  memo: Map<number, RailMemoEntry>,
  event: unknown,
): RailContributionPosition | undefined {
  if (!isRecord(event)) return undefined;
  const width = event.width;
  if (typeof width !== "number") return undefined;
  const entry = memo.get(width);
  if (entry === undefined) return undefined;
  const before = entry.contribution?.before?.lines.length ?? 0;
  const after = entry.contribution?.after?.lines.length ?? 0;
  return {
    part: key,
    width,
    native: { start: before, end: before + entry.nativeLength },
    ...(before === 0 ? {} : { before: { start: 0, end: before } }),
    ...(after === 0
      ? {}
      : { after: { start: before + entry.nativeLength, end: before + entry.nativeLength + after } }),
  };
}

/**
 * The part's digest: the host's own value when nothing contributes one, otherwise the host's value
 * with the contributor's signature appended (N14). The signature receives the same context the
 * render did, so a placement change moves it and the host re-frames the part.
 */
function digestValue(
  key: RailPart,
  original: Rail,
  generation: number,
  painted: readonly RailPart[],
): string | undefined {
  const hostDigest = original.digest;
  const raw = typeof hostDigest === "function" ? hostDigest.call(original) : undefined;
  // A foreign rail can return anything; only a string is a digest the layout can compare.
  const hostValue = typeof raw === "string" ? raw : undefined;
  if (sidebarState().generation !== generation) return hostValue;
  const contributor = sidebarState().contributor;
  if (contributor?.digest === undefined) return hostValue;
  let contribution: string;
  try {
    contribution = contributor.digest({ part: key, painted });
  } catch (error) {
    // A broken signature must not take the host's memo down with it: record it and stay on the
    // host's own digest, which degrades to invalidation-only, exactly as the layout does.
    recordFailure(key, "digest", error);
    return hostValue;
  }
  return `${hostValue ?? ""}|${contribution}`;
}

function contributionFor(
  key: RailPart,
  width: number,
  painted: readonly RailPart[],
): RailPartContribution | undefined {
  const contributor = sidebarState().contributor;
  if (contributor === undefined) return undefined;
  let contribution: RailPartContribution | undefined;
  try {
    contribution = contributor.render(width, { part: key, painted });
  } catch (error) {
    // A broken renderer loses its own rows and nothing else (S8): record it, draw the host's rows.
    recordFailure(key, "contribute", error);
    return undefined;
  }
  if (contribution === undefined) return undefined;
  const before = contribution.before?.lines.length ?? 0;
  const after = contribution.after?.lines.length ?? 0;
  if (before === 0 && after === 0) return undefined;
  return contribution;
}

function remember(memo: Map<number, RailMemoEntry>, width: number, entry: RailMemoEntry): void {
  if (memo.size > 32) memo.clear();
  memo.set(width, entry);
}

function recordFailure(key: string, phase: SidebarFailurePhase, error: unknown): void {
  const state = sidebarState();
  state.lastFailures.push({ key, phase, message: errorMessage(error) });
  if (state.lastFailures.length > 32) state.lastFailures.splice(0, state.lastFailures.length - 32);
}

function defineHidden<T extends object>(target: T, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

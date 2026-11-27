/**
 * The pointer claim (N12): one hovered surface at a time, the way the host does it.
 *
 * ## What the host does, and what of it is reachable
 *
 * gentle-shell's parts wrap themselves in `NativePointerRegion` and claim the shared pointer with
 * `setSidebarHover(tui, owner, clear)` (`lib/shell-sidebar.ts:100-108`), which stores
 * `{ owner, clear }` on the terminal's sidebar state and calls the PREVIOUS owner's `clear()` when
 * the owner changes. Moving the pointer off the rail calls `setSidebarHover(tui)` with no owner,
 * which clears the current one.
 *
 * The function itself is not reachable — gentle-shell is not a dependency and Pi loads it in its own
 * jiti module graph — but the SLOT it writes is: `SidebarState.hover` is declared on the
 * process-global state the bridge already intercepts, and its own comment says it is "shared across
 * separately loaded extensions" (`lib/shell-sidebar.ts:37`). So this module performs the same two
 * steps against the same published state, exactly as `./repaint.ts` bumps the host's cache revision
 * rather than importing `invalidateSidebar`:
 *
 * 1. read the terminal's sidebar state (`./sidebar.ts`'s `hostSidebarStateOf`, the seam the backend
 *    already reads for `parts`);
 * 2. store `{ owner, clear }`, clearing the previous owner first — the host's own semantics.
 *
 * What is NOT reachable is `NativePointerRegion`, and it is not needed — but its behaviour is what
 * decides who sees an event first. The host dispatches a hit on the part to the part's own
 * `handleMouse` with the coordinates already mapped into the part's frame
 * (`lib/shell-sidebar-layout.ts:245-259`), which is where the section pointer handler reads them.
 * That part handler is a `NativePointerRegion` around the host's own card
 * (`extensions/gentle-shell.ts:2766`), whose `onHover` claims or clears the pointer and always
 * returns `{ handled: true }` (`extensions/gentle-shell.ts:2732-2741`). So a MOVE over a row the
 * bridge appended is consumed by the host unless the rail wrapper offers it to the contributor
 * first; `./sidebar.ts`'s `mouseThrough` does exactly that for the rows the contributor rendered,
 * and keeps the host first for every other event.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { getRepaintHost } from "./repaint.ts";
import { isRecord } from "./rows.ts";
import { hostSidebarStateOf } from "./sidebar.ts";

/** How a hover claim is carried, as `/bridge-status` reports it. */
export type HoverMechanism = "host-state" | "unavailable";

/** The published field's shape (`SidebarState.hover`, `lib/shell-sidebar.ts:37`). */
interface HoverSlot {
  owner: object;
  clear: () => void;
}

interface PointerState {
  /** The token this package claims the pointer with; stable, so a second claim is a no-op. */
  owner: object;
  lastMechanism?: HoverMechanism;
  lastReason?: string;
}

const POINTER_STATE = Symbol.for("gentle-shell-bridge.section-pointer.state.v1");

function pointerHost(): Record<symbol, PointerState | undefined> {
  // SAFETY: only `pointerState()` writes this key, and it re-checks the shape before trusting it.
  return globalThis as unknown as Record<symbol, PointerState | undefined>;
}

function pointerState(): PointerState {
  const host = pointerHost();
  const existing = host[POINTER_STATE];
  if (existing !== undefined && typeof existing.owner === "object") return existing;
  const created: PointerState = { owner: {} };
  host[POINTER_STATE] = created;
  return created;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetSectionPointerForTests(): void {
  const state = pointerState();
  delete state.lastMechanism;
  delete state.lastReason;
}

interface HostHoverSlot {
  state: Record<string, unknown>;
}

/** The terminal's sidebar state, or `undefined` when no `tui` has been captured yet. */
function hostHoverSlot(): HostHoverSlot | undefined {
  const tui = getRepaintHost();
  if (tui === undefined) return undefined;
  const state = hostSidebarStateOf(tui);
  return state === undefined ? undefined : { state };
}

function readHover(state: Record<string, unknown>): HoverSlot | undefined {
  const hover = state.hover;
  if (!isRecord(hover)) return undefined;
  const owner = hover.owner;
  const clear = hover.clear;
  if (typeof owner !== "object" || owner === null) return undefined;
  if (typeof clear !== "function") return undefined;
  return { owner, clear: clear as () => void };
}

/**
 * Claim the shared pointer for the section rows. `clear` runs when another surface takes the pointer
 * or the host moves it off the rail, which is how a hovered row stops being hovered without the
 * host knowing anything about section rows.
 *
 * Never throws: a terminal that cannot carry the slot is reported, and the section still paints — it
 * only loses the "someone else took the pointer" notification.
 */
export function claimSectionHover(clear: () => void): HoverMechanism {
  const state = pointerState();
  const slot = hostHoverSlot();
  if (slot === undefined) {
    state.lastMechanism = "unavailable";
    state.lastReason =
      "no terminal sidebar state is reachable yet, so the shared pointer slot cannot be claimed";
    return "unavailable";
  }
  try {
    const current = readHover(slot.state);
    // The host's own rule: the same owner keeps the claim without clearing itself.
    if (current?.owner === state.owner) {
      state.lastMechanism = "host-state";
      delete state.lastReason;
      return "host-state";
    }
    slot.state.hover = { owner: state.owner, clear };
    current?.clear();
    state.lastMechanism = "host-state";
    delete state.lastReason;
    return "host-state";
  } catch (error) {
    state.lastMechanism = "unavailable";
    state.lastReason = `the host's pointer slot rejected the claim: ${errorMessage(error)}`;
    return "unavailable";
  }
}

/** Release the claim if it is still ours; another surface's claim is left alone. */
export function releaseSectionHover(): void {
  const slot = hostHoverSlot();
  if (slot === undefined) return;
  try {
    const current = readHover(slot.state);
    if (current === undefined || current.owner !== pointerState().owner) return;
    delete slot.state.hover;
  } catch {
    // A terminal that cannot be read cannot hold our claim either; nothing to release.
  }
}

/** The mechanism the last claim used, as `/bridge-status` reports it. */
export function getSectionHoverReport(): { mechanism: HoverMechanism | "not used"; reason?: string } {
  const state = pointerState();
  if (state.lastMechanism === undefined) return { mechanism: "not used" };
  return {
    mechanism: state.lastMechanism,
    ...(state.lastReason === undefined ? {} : { reason: state.lastReason }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

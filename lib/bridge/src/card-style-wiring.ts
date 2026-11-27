/**
 * Wiring the transform to a live TUI (S5, S4): the only way in, done once, with the same marker and
 * generation discipline the sidebar backend already uses (`./sidebar.ts:52-90`).
 *
 * ## The path, and why it is walked here
 *
 * `./card-styles.ts` §1 records the evidence: Pi hands an extension a real `tui` only through
 * `ctx.ui.setWidget`, and from there the conversation component is reachable in two ways —
 *
 * 1. `tui.children[0]` → the document container → `children[2]` (the chat container). `children` is
 *    a declared member of the public `TUI` interface (`pi-tui/dist/tui.d.ts:223-231`) and Pi fills
 *    it in both renderer modes, document first (`interactive-mode.js:623-625,722-731`), so this is
 *    the primary hop.
 * 2. `tui.layoutRoot` → its layout entries → `entries[0].component` (the primary `ScrollView`) →
 *    the scroll view's child (`[LAYOUT_NODE]().component`, `scroll-view.d.ts:57`) → the document →
 *    `children[2]`. `layoutRoot` is TypeScript-`private` and exists only on the fullscreen renderer,
 *    so this is the secondary hop, tried when the first one does not land.
 *
 * Both end at the same component, and the marker below certifies the exact wrapper installed on it,
 * read as an OWN property, so a rebind, a second arm or a second copy of this package reports
 * `already-wrapped` instead of stacking a second transform.
 *
 * ## What the wrapper does
 *
 * It calls the host's own `render(width)` first (the host's failure path stays the host's), and then
 * hands the rows to the pipeline: `transformCardLines` repaints the selected card style (a
 * pass-through unless a style is selected, and it never throws), and `applyTransforms` then runs the
 * registered transcript transforms in order over that output (`./transform-pipeline.ts`). With no
 * style selected and no transform registered the host's own array is what the wrapper returns, so a
 * session that uses neither is byte-identical. The wrapper captures the generation it was created
 * in: once `disableCardStyleTransform()` (or a reset) bumps it, a wrapper foreign code kept a
 * reference to is a plain pass-through, not an injector.
 *
 * ## The rail surface (R1, R3)
 *
 * The second surface is gentle-shell's fullscreen rail. On a transparent rail the host re-frames
 * every section itself — `sectionCardRows`/`headerParts` through `floatRows`/`cardTop`/`cardLine`
 * (`lib/shell-sidebar-layout.ts:36-47,392-410`), host sections and contributed ones alike — and the
 * FRAMED rows are the child of the rail's `ScrollView` in the layout tree
 * (`lib/shell-sidebar-layout.ts:486-499`): the root's layout node is a `vstack` holding an `hstack`
 * whose SECOND entry is that scroll view, and `ScrollView[LAYOUT_NODE]()` reports its child
 * (`pi-tui/dist/components/scroll-view.js:191-192`). That child renders the whole rail, so wrapping
 * its `render(width)` is the one place that sees every rail frame AFTER the host framed it — which
 * is exactly what a repaint needs, and why a style reaches host sections and bridge sections
 * without the bridge drawing either frame.
 *
 * The rail wrapper runs ONLY the card-style transform (`transformCardLines(..., "rail")`): the
 * registered transcript transforms are the conversation's extension point, and handing a plugin's
 * conversation rows for the rail would let it corrupt a surface it never asked for. Every absence is
 * an outcome here too (`no-layout-root`, `no-sidebar`, `no-rail`), and each attempt records the
 * surface's reach for `/bridge-status` (`./repaint.ts`).
 *
 * ## Every absence is a reported state
 *
 * The `tui` is host state, so the walk never assumes a shape and never creates one: no tui, no
 * children, a first child that is not the document, a document without a third child, a third child
 * that cannot render, an accessor that throws — each is an outcome recorded for `/bridge-status`
 * (`no-tui`, `no-children`, `no-document`, `no-conversation`, `render-missing`, `wrong-shape`), and
 * none of them throws. A session that never got a `tui` keeps `lastOutcome` undefined, which is
 * reported as "not armed" rather than as a failure.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { transformCardLines } from "./card-style-transform.ts";
import { getRepaintHost, recordSurfaceReach, type PaintSurface } from "./repaint.ts";
import { isRecord } from "./rows.ts";
import { rowOrigins } from "./row-origin.ts";
import { adoptCustomMessages } from "./message-design-adoption.ts";
import { adoptToolCards } from "./tool-design-adoption.ts";
import { applyTransforms } from "./transform-pipeline.ts";

/** The layout protocol symbol, exactly as `pi-tui` defines it (`layout-node.js:1`). */
const LAYOUT_NODE: symbol = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Own property on a wrapped component → the exact wrapper function this module installed. */
const TRANSFORM_WRAPPED: symbol = Symbol.for("gentle-shell-bridge.card-style-transform.wrapped.v1");

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const WIRING_STATE: symbol = Symbol.for("gentle-shell-bridge.card-style-wiring.state.v1");

/** Why the transform is (or is not) attached. Every value is reported, none is a throw. */
export type CardStyleInstallOutcome =
  | "wrapped"
  | "already-wrapped"
  | "no-tui"
  | "no-children"
  | "no-document"
  | "no-conversation"
  | "render-missing"
  | "no-layout-root"
  | "no-sidebar"
  | "no-rail"
  | "wrong-shape";

export interface InstallCardStyleResult {
  installed: boolean;
  outcome: CardStyleInstallOutcome;
  /** The component the wrapper landed on, when it landed. */
  component?: "chat" | "rail";
  /** Only for `wrong-shape`: the message a host accessor threw. */
  reason?: string;
}

export interface CardStyleWiringDiagnostics {
  /** Conversation components currently wrapped in this process. */
  wrapped: number;
  /** Present when at least one conversation component is wrapped. */
  component?: "chat";
  /** The most recent conversation install attempt's outcome; absent when never attempted. */
  lastOutcome?: CardStyleInstallOutcome;
  /** Only for `wrong-shape`: the reason, verbatim. */
  lastReason?: string;
  /** Rail components currently wrapped in this process (R1); absent when a rail was never reached. */
  railWrapped?: number;
  /** The most recent rail install attempt's outcome; absent when never attempted. */
  lastRailOutcome?: CardStyleInstallOutcome;
  /** Only for a rail `wrong-shape`: the reason, verbatim. */
  lastRailReason?: string;
}

/** The part of a component this module needs: Pi's `Component.render(width): string[]`. */
interface Renderable {
  render(width: number): readonly string[];
}

/** What a host-shaped component's `render` may be, before the wrapper checks it at runtime. */
type RenderFunction = Renderable["render"];

/** A walk's answer: the component, or the hop that failed. */
type ConversationFound =
  | { found: true; component: Renderable }
  | { found: false; outcome: CardStyleInstallOutcome };

interface WrappedRecord {
  component: Renderable;
  original: RenderFunction;
  wrapper: RenderFunction;
  /** Which surface this record serves; one wrapper draws one surface. */
  surface: PaintSurface;
}

interface WiringState {
  /** Bumped by a disable/reset; a wrapper from an older generation is a pass-through. */
  generation: number;
  wrapped: WrappedRecord[];
  lastOutcome?: CardStyleInstallOutcome;
  lastReason?: string;
  lastRailOutcome?: CardStyleInstallOutcome;
  lastRailReason?: string;
}

function wiringHost(): Record<symbol, WiringState | undefined> {
  // SAFETY: only `wiringState()` writes this key, and it re-checks the shape before trusting it.
  return globalThis as unknown as Record<symbol, WiringState | undefined>;
}

function wiringState(): WiringState {
  const host = wiringHost();
  const existing = host[WIRING_STATE];
  if (
    existing !== undefined &&
    typeof existing.generation === "number" &&
    Array.isArray(existing.wrapped)
  ) {
    return existing;
  }
  const created: WiringState = { generation: 0, wrapped: [] };
  host[WIRING_STATE] = created;
  return created;
}

/** Diagnostics snapshot for `/bridge-status` (T4) and for this module's own tests. */
export function getCardStyleWiringDiagnostics(): CardStyleWiringDiagnostics {
  const state = wiringState();
  const chat = state.wrapped.filter((record) => record.surface === "conversation").length;
  const rail = state.wrapped.filter((record) => record.surface === "rail").length;
  return {
    wrapped: chat,
    ...(chat === 0 ? {} : { component: "chat" as const }),
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.lastReason === undefined ? {} : { lastReason: state.lastReason }),
    ...(rail === 0 ? {} : { railWrapped: rail }),
    ...(state.lastRailOutcome === undefined ? {} : { lastRailOutcome: state.lastRailOutcome }),
    ...(state.lastRailReason === undefined ? {} : { lastRailReason: state.lastRailReason }),
  };
}

/** Test-only seam: forget every record, so one test cannot leak into another. */
export function resetCardStyleWiringForTests(): void {
  const state = wiringState();
  state.wrapped.length = 0;
  delete state.lastOutcome;
  delete state.lastReason;
  delete state.lastRailOutcome;
  delete state.lastRailReason;
  // Bump so a wrapper a previous test retained becomes a pass-through instead of injecting.
  state.generation += 1;
}

/** Read `[LAYOUT_NODE]()` from a component, if it exposes it. */
interface LayoutNode {
  type?: unknown;
  entries?: ReadonlyArray<{ component?: unknown }>;
  component?: unknown;
}

function layoutNodeOf(value: unknown): LayoutNode | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const read = (value as Record<symbol, unknown>)[LAYOUT_NODE];
  if (typeof read !== "function") return undefined;
  const node: unknown = read.call(value);
  // SAFETY: the layout protocol's node is `{ type, entries?, component? }` (`pi-tui`
  // `layout-node.d.ts`); every member this module reads is re-validated at the point of use.
  return isRecord(node) ? (node as LayoutNode) : undefined;
}

/**
 * The conversation component inside a document container: `children[2]`
 * (`interactive-mode.js:404-407`). Returns why it is not, when it is not.
 */
function conversationOf(document: unknown): ConversationFound {
  if (!isRecord(document)) return { found: false, outcome: "no-document" };
  const children = document.children;
  if (!Array.isArray(children)) return { found: false, outcome: "no-document" };
  const candidate = children[2];
  if (!isRecord(candidate)) return { found: false, outcome: "no-conversation" };
  if (typeof candidate.render !== "function") return { found: false, outcome: "render-missing" };
  // SAFETY: `render` is verified callable above, and it is the only member this module reads;
  // everything a foreign object might carry instead is irrelevant to the wrapper it gets.
  return { found: true, component: candidate as unknown as Renderable };
}

/**
 * Walk `tui` down to the conversation component: primary through `children`, secondary through the
 * layout root. The outcome names the FIRST hop that failed, so `/bridge-status` can say which shape
 * was not what this host promised.
 */
function findConversation(tui: Record<string, unknown>): ConversationFound {
  const children = tui.children;
  const primary: ConversationFound =
    Array.isArray(children) && children.length > 0
      ? conversationOf(children[0])
      : { found: false, outcome: "no-children" };
  if (primary.found) return primary;

  // The secondary hop exists because a host may not have mounted its children yet (or at all) while
  // its layout root still carries the transcript. It is tried whenever the primary hop failed.
  const root = tui.layoutRoot;
  if (root !== undefined) {
    const entries = layoutNodeOf(root)?.entries;
    const scroll = Array.isArray(entries) ? entries[0]?.component : undefined;
    const document = layoutNodeOf(scroll)?.component;
    if (document !== undefined) {
      const secondary = conversationOf(document);
      if (secondary.found) return secondary;
    }
  }
  return primary;
}

/** The component name each surface reports when its wrapper lands. */
const SURFACE_COMPONENT: Record<PaintSurface, "chat" | "rail"> = {
  conversation: "chat",
  rail: "rail",
};

/**
 * Find the rail component behind `tui`: the child of the rail `ScrollView` in the host's layout tree
 * (`lib/shell-sidebar-layout.ts:486-499`, `pi-tui/dist/components/scroll-view.js:191-192`).
 *
 * The tree is walked by SHAPE, not by index into the root: the root's layout node is a `vstack`
 * whose entries include the `hstack` host, and that hstack is `[conversation, rail ScrollView]`
 * (`lib/shell-sidebar-layout.ts:490-497`). A second entry qualifies only when its own layout node is
 * a `scroll` AND the component that node reports has a `render`, so neither the transcript's scroll
 * view nor an unrelated stack can be mistaken for the rail.
 */
function findRail(tui: Record<string, unknown>): ConversationFound {
  const root = tui.layoutRoot;
  if (root === undefined) return { found: false, outcome: "no-layout-root" };
  const scroll = findRailScroll(layoutNodeOf(root), 0);
  if (scroll === undefined) return { found: false, outcome: "no-sidebar" };
  const rail = layoutNodeOf(scroll)?.component;
  if (!isRecord(rail) || typeof rail.render !== "function") {
    return { found: false, outcome: "no-rail" };
  }
  // SAFETY: `render` is verified callable above, and it is the only member this module reads; the
  // rail's other fields (`digest`, `cardGroups`, `surface`, ...) stay on the host's own object
  // because the wrapper replaces only `render`.
  return { found: true, component: rail as unknown as Renderable };
}

/** The rail `ScrollView` of the host's `hstack`, found in the small tree the layout root publishes. */
function findRailScroll(node: LayoutNode | undefined, depth: number): Record<string, unknown> | undefined {
  if (node === undefined || depth > 3) return undefined;
  if (node.type === "hstack") {
    // entries[0] is the conversation's host, entries[1] the rail (`lib/shell-sidebar-layout.ts:493-496`).
    const candidate = node.entries?.[1]?.component;
    if (isRecord(candidate) && layoutNodeOf(candidate)?.type === "scroll") return candidate;
  }
  for (const entry of node.entries ?? []) {
    const found = findRailScroll(layoutNodeOf(entry.component), depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Wrap one component, once, with a marker that certifies the exact function installed. */
function wrapComponent(component: Renderable, surface: PaintSurface): InstallCardStyleResult {
  const current = component.render;
  // SAFETY: a component is an object (verified by `isRecord` before it gets here) and the marker is
  // the only symbol-keyed property this module writes on it, so reading it through a widened record
  // is exact.
  const marked = component as unknown as Record<symbol, unknown>;
  if (Object.hasOwn(component, TRANSFORM_WRAPPED) && marked[TRANSFORM_WRAPPED] === current) {
    return { installed: true, outcome: "already-wrapped", component: SURFACE_COMPONENT[surface] };
  }

  const state = wiringState();
  const generation = state.generation;
  const wrapper = function (this: unknown, width: number): readonly string[] {
    // S10: a tool design is adopted AFTER construction, on every conversation pass, BEFORE the host
    // renders its children. That is the path that survives the resolver order: when an earlier
    // resolver answers a tool without calling `next()`, the bridge's resolver never runs, but this
    // wrapper already holds the container whose children are the cards. Adoption stamps its own
    // marker, so the resolver path and this path never stack on one card. A disabled transform (an
    // older generation) is a pass-through and adopts nothing, exactly as it transforms nothing.
    if (surface === "conversation" && wiringState().generation === generation) {
      try {
        adoptToolCards(component);
        // The message designs' capture point, on the same pass and for the same reason: Pi holds a
        // custom message's renderer on the component it built, and this is the only place the bridge
        // can reach it. It touches a message only when a live design claims its type (S4).
        adoptCustomMessages(component);
      } catch {
        // `adoptToolCards` is written not to throw, and this is the last line of defence: a failure
        // in the adoption path must never take the host's render loop down. The host's own rows are
        // drawn exactly as they would have been.
      }
    }
    // The host's own render always runs first: a host failure stays the host's to report.
    const lines = current.call(component, width);
    if (wiringState().generation !== generation) return lines;
    if (!Array.isArray(lines)) return lines;
    // SAFETY: `Array.isArray` just proved this is the host's own `string[]`; the card-style
    // transformer and the transform pipeline only ever read it and return either that instance or a
    // new array of strings.
    const rows = lines as string[];
    // R1: ONE repaint for every surface. The rail stops after the card style — the registered
    // transcript transforms belong to the conversation, and a plugin's conversation rows must never
    // be handed the rail. That is also why the rail needs no origin map: it runs no transform, so
    // there is nothing to attribute rows to.
    if (surface !== "conversation") return transformCardLines(rows, width, "rail");
    // S1: the origin map is read from the layout the host's OWN render pass just published
    // (`mouseLayout`, `pi-tui/dist/tui.js:136-149`) — no second render, no takeover of
    // `Container.render`, one entry per row of `rows`. A host that published no layout hands the
    // transform an empty map rather than a guess (`./row-origin.ts`), so the frame is still drawn.
    const origins = rowOrigins(component, width, rows.length);
    return applyTransforms(
      transformCardLines(rows, width, "conversation"),
      width,
      origins.rows,
    );
  };

  component.render = wrapper;
  Object.defineProperty(component, TRANSFORM_WRAPPED, {
    value: wrapper,
    enumerable: false,
    configurable: true,
  });
  // Reconfiguring a component we already wrapped (a foreign rebind kept the marker but replaced
  // `render`) replaces the record instead of adding a second one.
  const previous = state.wrapped.findIndex((record) => record.component === component);
  const record: WrappedRecord = { component, original: current, wrapper, surface };
  if (previous === -1) state.wrapped.push(record);
  else state.wrapped[previous] = record;
  return { installed: true, outcome: "wrapped", component: SURFACE_COMPONENT[surface] };
}

/**
 * Attach the transform to the live conversation component behind `tui`.
 *
 * Called from the one place this package receives a real `tui` (`./extension.ts`'s widget factory),
 * never at module load. Safe to call repeatedly: a second call on the same component reports
 * `already-wrapped` and installs nothing. Any absence is an outcome, never a throw — this runs
 * inside the host's widget factory, where an exception would take the sidebar and the rows with it.
 */
export function installCardStyleTransform(tui: unknown): InstallCardStyleResult {
  const result = attemptInstall(tui, "conversation");
  const state = wiringState();
  state.lastOutcome = result.outcome;
  if (result.reason === undefined) delete state.lastReason;
  else state.lastReason = result.reason;
  return result;
}

/**
 * Attach the same transform to the host's rail component (R1). Called from the widget factory, and
 * re-attempted by `refreshCardStyleSurfaces()` because the host's fullscreen layout may not be
 * mounted at the moment the factory runs — a reported outcome, never a timer.
 */
export function installRailCardStyleTransform(tui: unknown): InstallCardStyleResult {
  const result = attemptInstall(tui, "rail");
  const state = wiringState();
  state.lastRailOutcome = result.outcome;
  if (result.reason === undefined) delete state.lastRailReason;
  else state.lastRailReason = result.reason;
  return result;
}

/**
 * Re-attempt every surface whose repaint path was not reached, against the `tui` the bridge captured.
 *
 * Not a retry loop and not a poll: this runs exactly once per bridge-owned write, at the moment that
 * write needs its surface repainted. The host's rail is mounted by the time a user can open the
 * customize menu, which is why that moment is the reliable one; when even then no rail is reachable,
 * the outcome stays recorded for `/bridge-status`.
 */
export function refreshCardStyleSurfaces(): void {
  const tui = getRepaintHost();
  if (tui === undefined) return;
  // Re-attempting an attached surface is free (`already-wrapped`), and it keeps a reloaded host's
  // new component wrapped without another entry point.
  installCardStyleTransform(tui);
  installRailCardStyleTransform(tui);
}

function attemptInstall(tui: unknown, surface: PaintSurface): InstallCardStyleResult {
  if (!isRecord(tui)) {
    recordSurfaceReach(surface, { reached: false, reason: "no-tui" });
    return { installed: false, outcome: "no-tui" };
  }
  let result: InstallCardStyleResult;
  try {
    const found = surface === "conversation" ? findConversation(tui) : findRail(tui);
    result = found.found
      ? wrapComponent(found.component, surface)
      : { installed: false, outcome: found.outcome };
  } catch (error) {
    // A host accessor that throws is a shape problem, not a crash: report it and stay inert.
    result = {
      installed: false,
      outcome: "wrong-shape",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  recordSurfaceReach(surface, result.installed ? { reached: true } : { reached: false, reason: result.outcome });
  return result;
}

/**
 * Restore every wrapped component's own `render` and bump the generation, so a wrapper retained by
 * foreign code becomes a pass-through. Returns how many components were restored.
 */
export function disableCardStyleTransform(): number {
  const state = wiringState();
  let restored = 0;
  for (const record of state.wrapped.splice(0)) {
    try {
      if (record.component.render === record.wrapper) {
        record.component.render = record.original;
      }
      if (Object.hasOwn(record.component, TRANSFORM_WRAPPED)) {
        // SAFETY: the marker is the only symbol-keyed property this module writes on a component,
        // and this only removes it; the widened record is how a `symbol` key is deleted.
        delete (record.component as unknown as Record<PropertyKey, unknown>)[TRANSFORM_WRAPPED];
      }
      restored += 1;
    } catch {
      // A component that refuses the assignment keeps its wrapper; the generation still makes it
      // a pass-through, so the transform is off either way.
    }
  }
  state.generation += 1;
  return restored;
}

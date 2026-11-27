/**
 * The ONE `pi.registerToolRenderer` integration (S4, S5, T8): chosen per tool, composed with the host.
 *
 * ## Why the bridge owns it
 *
 * Pi composes every extension's `ToolRendererResolver` (`dist/core/extensions/runner.js:550-553`), so
 * a resolver that returns `next()` adds nothing and a resolver that REPLACES the renderers takes the
 * host's card away from every other extension. The bridge therefore registers exactly one resolver.
 *
 * ## The rule: wrap every tool that HAS a design, decide on every render pass (S2)
 *
 * Pi resolves renderers ONCE per card, when it constructs it (`getRegisteredToolDefinition(toolName)`
 * is passed into `new ToolExecutionComponent(...)`,
 * `interactive-mode.js:1816-1818,2957-2961,3028-3032,3376-3380`), and re-renders that same component
 * on every later frame. So the decision cannot live in the resolver: a card resolved while nothing
 * was selected would have no wrapper to ask, and could never be repainted. That was the defect the
 * user reported ("cambiar tanto las antiguas como posteriores"): a design selected at runtime has to
 * reach a card that was already drawn.
 *
 * The resolver therefore returns the host's renderers themselves ONLY when the tool has no registered
 * design at all (nothing to choose, so nothing to change). For every tool with at least one design,
 * selected or not, it returns a wrapper that reads the live selection on EVERY render pass:
 *
 * - no design selected, or the selected design is gone: the host's component is rendered and its
 *   lines are returned byte for byte, untouched;
 * - a design selected: the host's component is rendered, and those lines are handed to the design's
 *   `apply`.
 *
 * The wrapper replaces only `renderCall`/`renderResult` — every other member (`renderShell`, and
 * anything a host adds later) is carried over unchanged — so the card is still the host's:
 *
 * ```
 * render(width) → host component's render(width) → [live selection] → design.apply(rows, ctx)
 * ```
 *
 * The host renders itself, at the width the host asked for, and only those rows reach the design. That
 * is what keeps the frame the host's: `neon` stays neon and `float` stays float, because the chrome
 * was drawn before the design saw a byte of it (`ToolExecutionComponent` caches no lines — it asks its
 * renderer every pass, `tool-execution.js:64-68,164-175`).
 *
 * ## The theme
 *
 * A design's `ctx.theme` is the theme the host handed that renderer: `renderCall(args, theme, ctx)`
 * has it second, `renderResult(result, options, theme, ctx)` third
 * (`dist/core/extensions/types.d.ts:538-545`). It is passed through untouched; the bridge never reads
 * a colour from it.
 *
 * ## Every absence is a reported outcome
 *
 * No design registered for the tool, no `next()` and a host whose component has no `render` all return
 * what the host gave us. A design that throws is the failure of THAT design and nothing else: the
 * host's rows are drawn unchanged and one failure is recorded (`getToolDesignFailures`). A selection
 * that cannot be read is the same degradation — the host's card is drawn. Nothing in this module can
 * throw into Pi's render loop.
 *
 * ## Idempotency
 *
 * Registering twice would stack two wrappers around one component and apply the design twice, so the
 * install records the exact `pi` objects it registered on in the process-global slot: a reload, a
 * rebind or a second loaded copy of this package reports `already-registered` instead of adding a
 * second resolver.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { isRecord } from "./rows.ts";
import {
  applyToolDesign,
  designsOfTool,
  recordToolDesignFailure,
  resolveToolDesignSelection,
  type ToolDesignSelection,
} from "./tool-designs.ts";
import { resolveCardStyleSelection } from "./card-styles.ts";
import type { CardStyleSelection, ToolDesignContext, ToolDesignRender } from "./types.ts";

/**
 * The renderers Pi hands a resolver, described structurally: the bridge reads `renderCall` and
 * `renderResult` and preserves every other member, so a host that grows a new one keeps it.
 */
export interface ToolRenderersLike {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  [member: string]: unknown;
}

/** What `next()` answers: the renderers the remaining resolvers and the tool itself would use. */
export type ToolRendererNext = () => ToolRenderersLike | undefined;

/** Pi's `ToolRendererResolver`, structurally (`dist/core/extensions/types.d.ts:546`). */
export type ToolDesignResolver = (
  toolName: string,
  next: ToolRendererNext,
) => ToolRenderersLike | undefined;

/** The parts of a Pi component this module keeps working: `render` plus the optional members. */
interface Renderable {
  render(width: number): readonly string[];
  invalidate?(): void;
  handleMouse?(event: Record<string, unknown>): Record<string, unknown> | undefined;
  wantsKeyRelease?: boolean;
  capturesViewportInput?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The resolver the bridge registers. Returns `next()`'s renderers themselves only when the tool has
 * no design at all; otherwise a wrapper that reads the selection on every render pass, so a design
 * selected after a card was drawn repaints that card (S2).
 */
export const toolDesignResolver: ToolDesignResolver = (toolName, next) => {
  // The host's own answer first, and outside the guard: a host resolver that throws keeps its own
  // failure path, and `next()` must run exactly once either way.
  const renderers = next();
  try {
    // No design for this tool: there is nothing to choose, so nothing may change, not even identity.
    if (designsOfTool(toolName).length === 0) return renderers;
    if (renderers === undefined) return renderers;
    return wrapRenderers(renderers, toolName);
  } catch (error) {
    // A registry that refuses to answer is reported, and the host's card is what the user sees (S5).
    recordToolDesignFailure(toolName, "(resolver)", errorMessage(error));
    return renderers;
  }
};

/**
 * The renderer members this module wraps, with the argument index that carries the host's theme and
 * the part of the card that renderer draws (S12). The two are wrapped SEPARATELY, so the design is
 * told which one it is drawing instead of having to guess it from the rows.
 */
const WRAPPED_RENDERERS: ReadonlyArray<{
  member: "renderCall" | "renderResult";
  themeIndex: number;
  /** The argument that carries Pi's render context, always the one after the theme. */
  contextIndex: number;
  part: "call" | "result";
}> = [
  { member: "renderCall", themeIndex: 1, contextIndex: 2, part: "call" },
  { member: "renderResult", themeIndex: 2, contextIndex: 3, part: "result" },
];

/**
 * A by-value snapshot of the host's render context, or `undefined` when the host handed none. Taken
 * on every render pass (the context is live: `durationMs` arrives with the result), and limited to
 * the fields of `ToolDesignRender`, each kept only when it has the documented type.
 */
function snapshotRender(context: unknown): ToolDesignRender | undefined {
  // Inside Pi's render loop: a host object whose accessors throw (a Proxy, a getter) has no context
  // this module can read, so the design simply draws without `render`. Never a throw into the frame.
  try {
    if (!isRecord(context)) return undefined;
    const render: {
      -readonly [K in keyof ToolDesignRender]: ToolDesignRender[K];
    } = {};
    if (typeof context.toolCallId === "string") render.toolCallId = context.toolCallId;
    // By REFERENCE: `args` is the host's own object (never frozen or cloned here); a design reads it.
    if ("args" in context) render.args = context.args;
    if (typeof context.isPartial === "boolean") render.isPartial = context.isPartial;
    if (typeof context.isError === "boolean") render.isError = context.isError;
    if (typeof context.durationMs === "number" && Number.isFinite(context.durationMs)) {
      render.durationMs = context.durationMs;
    }
    if (typeof context.expanded === "boolean") render.expanded = context.expanded;
    return render;
  } catch {
    return undefined;
  }
}

/**
 * Own property on a renderers object THIS package wrapped: the resolver path
 * (`./tool-design-wiring.ts`) and the adoption path (`./tool-design-adoption.ts`) share it, so a card
 * is wrapped exactly once no matter which path reached it first.
 */
export const TOOL_RENDERERS_WRAPPED: unique symbol = Symbol.for(
  "gentle-shell-bridge.tool-designs.renderers-wrapped.v1",
);

/**
 * A copy of the host's renderers with the call/result renderer wrapped. Everything else — including
 * `renderShell`, which decides whether the host frames the card itself — is the host's own value.
 *
 * The copy is stamped with `TOOL_RENDERERS_WRAPPED`, and an already-stamped object comes back
 * untouched: the resolver path and the adoption path cooperate instead of stacking two wrappers (and
 * two design applications) around one card.
 */
export function wrapRenderers(
  renderers: ToolRenderersLike,
  tool: string,
  origin: ToolRendererWrapperOrigin = "resolver",
): ToolRenderersLike {
  // Already wrapped by the other path: wrapping again would apply the design twice.
  if (Object.hasOwn(renderers, TOOL_RENDERERS_WRAPPED)) return renderers;
  const wrapCall = typeof renderers.renderCall === "function";
  const wrapResult = typeof renderers.renderResult === "function";
  // Nothing renderable to wrap: hand the host's own object back rather than a copy nobody needs.
  if (!wrapCall && !wrapResult) return renderers;

  const wrapped: ToolRenderersLike = { ...renderers };
  for (const { member, themeIndex, contextIndex, part } of WRAPPED_RENDERERS) {
    const original = renderers[member];
    if (typeof original !== "function") continue;
    // SAFETY: `typeof` just proved this member callable. A renderer's arguments (args, options, the
    // host's context) and its answer (a Component) are objects the host owns, so they are forwarded
    // as such rather than re-typed here.
    const hostRenderer = original as (
      ...args: Record<string, unknown>[]
    ) => Record<string, unknown>;
    wrapped[member] = wrapRenderer(hostRenderer, tool, themeIndex, contextIndex, origin, part);
  }
  Object.defineProperty(wrapped, TOOL_RENDERERS_WRAPPED, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return wrapped;
}

/**
 * Which path produced a wrapper: the resolver (`./tool-design-wiring.ts`'s own registration) or the
 * post-construction adoption pass (`./tool-design-adoption.ts`). Only the resolver path is counted
 * as "the resolver wrapped this card", so `/bridge-status` can say which path reached what (T16).
 */
export type ToolRendererWrapperOrigin = "resolver" | "adoption";

/**
 * Wrap one host renderer: call it with the host's own arguments and `this` (a host failure stays the
 * host's), then wrap the component it returned. A non-component answer is returned untouched.
 */
function wrapRenderer(
  original: (...args: Record<string, unknown>[]) => Record<string, unknown>,
  tool: string,
  themeIndex: number,
  contextIndex: number,
  origin: ToolRendererWrapperOrigin,
  part: "call" | "result",
): (...args: Record<string, unknown>[]) => Record<string, unknown> {
  return function (this: unknown, ...args: Record<string, unknown>[]): Record<string, unknown> {
    const component = original.apply(this, args);
    // The theme is the host's own opaque object at the documented index of this renderer's arguments
    // (`renderCall`: second, `renderResult`: third); the bridge only forwards it.
    return wrapComponent(component, tool, args[themeIndex], args[contextIndex], origin, part);
  };
}

/**
 * The Component Pi mounts for one card: it renders the host's component, then reads the LIVE selection
 * on every pass. No design selected (or a design that disappeared) returns the host's own lines
 * untouched; a selected design decides what is drawn. `invalidate()` and the optional mouse/key-release
 * members are delegated, so the card keeps behaving exactly as the host's did — only the rows can
 * differ.
 */
function wrapComponent(
  component: Record<string, unknown>,
  tool: string,
  theme: Record<string, unknown> | undefined,
  hostContext: unknown,
  origin: ToolRendererWrapperOrigin,
  part: "call" | "result",
): Record<string, unknown> {
  if (!isRecord(component) || typeof component.render !== "function") return component;
  // SAFETY: a record whose own `render` is callable is exactly the Pi component contract
  // (`render(width): string[]`, plus optional members). The bridge replaces nothing on the host's
  // object; it only calls `render`/`invalidate`/`handleMouse` and reads two booleans.
  const child = component as unknown as Renderable;
  const hostRender = child.render;
  // A card is now mounted through the resolver's wrapper: `/bridge-status` can answer "is this card
  // even wrapped?" per tool instead of leaving the user to attach a debugger. The adoption path
  // records its own count (`./tool-design-adoption.ts`), so the two numbers stay separate.
  if (origin === "resolver") recordWrappedCard(tool);

  const wrapper = {
    render(width: number): string[] {
      const lines = hostRender.call(child, width);
      // A host that answers something other than rows keeps its own answer; the design has nothing
      // to rewrite and the bridge invents nothing.
      if (!Array.isArray(lines)) return lines as string[];
      // SAFETY: `Array.isArray` just proved this is the host's own `string[]`; `applyToolDesign` only
      // reads it (through a copy) and answers with strings, or `undefined` for "draw the host's".
      const rows = lines as string[];
      // The host's context is snapshotted BEFORE resolving: the scope decides on THIS call, and the
      // arguments are exactly what the design gets as `ctx.render.args` afterwards (S10/S12).
      const render = snapshotRender(hostContext);
      let selection: ToolDesignSelection;
      try {
        // Read on EVERY pass, never captured at resolution: that is what lets a design selected after
        // this card was drawn repaint it (S2). The call's arguments make a scoped claim a candidate
        // for THIS call; with no render context they are `undefined` and only unscoped claims apply.
        selection = resolveToolDesignSelection(tool, render?.args);
      } catch (error) {
        recordToolDesignFailure(tool, "(selection)", errorMessage(error));
        return rows;
      }
      // No design selected, or the selected design is gone: the host's bytes, untouched.
      if (selection.kind !== "design") return rows;
      // S22: the card's style is resolved ON ACCESS and at most ONCE per pass. A design that never
      // reads `cardStyle` therefore pays nothing — no store read, no registry walk, no row changed —
      // and a design that reads it twice gets one answer, so a switch landing mid-pass cannot draw a
      // card that is half of each. It is read from the live registry, never snapshotted at
      // resolution, so a style chosen after this card was built still reaches it.
      let cardStyle: CardStyleSelection | undefined;
      const ctx: ToolDesignContext = {
        width,
        tool,
        theme,
        part,
        ...(render === undefined ? {} : { render }),
        get cardStyle(): CardStyleSelection {
          cardStyle ??= resolveCardStyleSelection();
          return cardStyle;
        },
      };
      const applied = applyToolDesign(selection.design, rows, ctx);
      return applied === undefined ? rows : applied;
    },
    invalidate(): void {
      if (typeof child.invalidate === "function") child.invalidate.call(child);
    },
    handleMouse(event: Record<string, unknown>): Record<string, unknown> | undefined {
      if (typeof child.handleMouse === "function") return child.handleMouse.call(child, event);
      return undefined;
    },
    get wantsKeyRelease(): boolean {
      return child.wantsKeyRelease === true;
    },
    get capturesViewportInput(): boolean {
      return child.capturesViewportInput === true;
    },
  };
  return wrapper;
}

// ---------------------------------------------------------------------------------------------
// The install: once per `pi`, process-globally, reported either way
// ---------------------------------------------------------------------------------------------

/** Why the resolver is (or is not) installed. Every value is reported, none is a throw. */
export type ToolDesignResolverOutcome =
  | "registered"
  | "already-registered"
  | "no-register-function"
  | "threw";

export interface InstallToolDesignResolverResult {
  installed: boolean;
  outcome: ToolDesignResolverOutcome;
  /** Only for `threw`: the message the host's `registerToolRenderer` threw. */
  reason?: string;
}

interface ResolverState {
  /** The exact `pi` objects this process registered on; identity is the idempotency key. */
  targets: unknown[];
  lastOutcome?: ToolDesignResolverOutcome;
  lastReason?: string;
  /** Per tool, how many card components were built through the wrapper: "is it even wrapped?". */
  wrappedCards: Array<{ tool: string; cards: number }>;
}

/** Stable process-global slot: a second loaded copy of this package must register nothing. */
const RESOLVER_KEY = Symbol.for("gentle-shell-bridge.tool-designs.resolver.v1");

function resolverHost(): Record<symbol, ResolverState | undefined> {
  // SAFETY: only `resolverState()` writes this key, and it re-checks the list before trusting a
  // value left by another copy.
  return globalThis as unknown as Record<symbol, ResolverState | undefined>;
}

function resolverState(): ResolverState {
  const host = resolverHost();
  const existing = host[RESOLVER_KEY];
  if (existing !== undefined && Array.isArray(existing.targets)) {
    // A slot created by a copy that predates the per-tool wrapper counter gains the list in place, so
    // two copies always see one record.
    if (!Array.isArray(existing.wrappedCards)) existing.wrappedCards = [];
    return existing;
  }
  const created: ResolverState = { targets: [], wrappedCards: [] };
  host[RESOLVER_KEY] = created;
  return created;
}

/** Record that one card of `tool` was built through the wrapper (monotonic, per process). */
function recordWrappedCard(tool: string): void {
  const state = resolverState();
  const entry = state.wrappedCards.find((candidate) => candidate.tool === tool);
  if (entry === undefined) state.wrappedCards.push({ tool, cards: 1 });
  else entry.cards += 1;
}

function recordOutcome(
  state: ResolverState,
  result: InstallToolDesignResolverResult,
): InstallToolDesignResolverResult {
  state.lastOutcome = result.outcome;
  if (result.reason === undefined) delete state.lastReason;
  else state.lastReason = result.reason;
  return result;
}

/**
 * Install the resolver on one `pi`, once. Called from the same `session_start` that arms the row
 * surfaces (`./extension.ts`), never at module load.
 *
 * Idempotent per `pi` object through the process-global slot, so a rebind, a `/reload` or a second
 * loaded copy of this package reports `already-registered` and adds no second resolver. A host without
 * `registerToolRenderer` is a reported outcome instead of a throw inside the session handler.
 */
export function installToolDesignResolver(pi: unknown): InstallToolDesignResolverResult {
  const state = resolverState();
  let register: unknown;
  try {
    register = isRecord(pi) ? pi.registerToolRenderer : undefined;
  } catch (error) {
    return recordOutcome(state, {
      installed: false,
      outcome: "threw",
      reason: errorMessage(error),
    });
  }
  if (typeof register !== "function") {
    return recordOutcome(state, { installed: false, outcome: "no-register-function" });
  }
  if (state.targets.includes(pi)) {
    return recordOutcome(state, { installed: true, outcome: "already-registered" });
  }

  try {
    (register as (resolver: ToolDesignResolver) => void).call(pi, toolDesignResolver);
  } catch (error) {
    return recordOutcome(state, {
      installed: false,
      outcome: "threw",
      reason: errorMessage(error),
    });
  }
  state.targets.push(pi);
  return recordOutcome(state, { installed: true, outcome: "registered" });
}

/** What `/bridge-status` reports about the one integration point. */
export interface ToolDesignWiringDiagnostics {
  /** How many `pi` objects this process registered the resolver on (`0` or `1` in a real TUI). */
  registered: number;
  /** The most recent install attempt's outcome; absent when it was never attempted. */
  lastOutcome?: ToolDesignResolverOutcome;
  /** Only for `threw`: the reason, verbatim. */
  lastReason?: string;
  /**
   * Per tool, how many card components were built through the wrapper. A tool with designs and no
   * entry has never had a card resolved through the wrapper, which answers "is this card even
   * wrapped?" without a debugger (a card built before its design was registered stays unwrapped until
   * the host repaints it).
   */
  wrappedCards: Array<{ tool: string; cards: number }>;
}

/** Diagnostics snapshot for `/bridge-status`. */
export function getToolDesignWiringDiagnostics(): ToolDesignWiringDiagnostics {
  const state = resolverState();
  return {
    registered: state.targets.length,
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.lastReason === undefined ? {} : { lastReason: state.lastReason }),
    wrappedCards: state.wrappedCards.map((entry) => ({ ...entry })),
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignWiringForTests(): void {
  const state = resolverState();
  state.targets.length = 0;
  delete state.lastOutcome;
  delete state.lastReason;
  state.wrappedCards.length = 0;
}

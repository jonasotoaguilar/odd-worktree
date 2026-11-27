/**
 * Adopting tool cards AFTER construction (S10, T14–T16): the path that survives the resolver order.
 *
 * ## Why a second path exists at all
 *
 * Pi composes every extension's `ToolRendererResolver` in EXTENSION LOAD ORDER
 * (`dist/core/extensions/runner.js:550-553`) and offers no way to reorder them
 * (`dist/core/extensions/loader.js:298-302` only pushes). So a resolver loaded before this package
 * decides first, and a resolver that answers WITHOUT calling `next()` — the host's own quiet bash
 * resolver does exactly that while `Card content` is `minimal`
 * (`extensions/quiet-tools.ts:910-914`) — means the bridge's resolver is never consulted. The user's
 * live report (L3) is that picture: a design is selected, the `Cards` row and the sidebar say so, and
 * every bash card still draws `$ …`.
 *
 * `./tool-design-wiring.ts` stays exactly as it is: when this package happens to be ahead in the
 * chain, its wrapper is the cheaper path and needs no second pass. This module is the other path,
 * for when it is behind: it adopts the card AFTER Pi constructed it.
 *
 * ## The card's own contract is enough
 *
 * The bridge already holds the conversation component (`./card-style-wiring.ts`'s
 * `findConversation`), and its children are Pi's `ToolExecutionComponent`s. Each one carries
 * `toolName` and the `toolDefinition` Pi resolved for it
 * (`dist/modes/interactive/components/tool-execution.js`, constructor near line 37-45), and
 * `invalidate()` re-invokes the stored `renderCall`/`renderResult` through `updateDisplay()`
 * (`tool-execution.js:64-68,164-175`). So adopting a card is: replace its `toolDefinition` with the
 * SAME wrapper the resolver path uses (`wrapRenderers`), then invalidate it so its stored renderer
 * is rebuilt through that wrapper. No second wrapper, no fork of the render rule.
 *
 * The pass runs on every conversation render, BEFORE the host renders its children
 * (`./card-style-wiring.ts`), so:
 *
 * - a card drawn before the design existed is adopted the first time it is rendered;
 * - a card Pi rebuilds (reload, `/tree`, session switch) is a NEW child and is adopted on the next
 *   pass;
 * - the wrapper re-reads the live selection on every frame, so selecting a design repaints the
 *   adopted card and selecting `native` restores the host's own bytes (S2).
 *
 * ## A marker, so the two paths cannot stack
 *
 * `wrapRenderers` stamps the wrapper it returns with one symbol
 * (`TOOL_RENDERERS_WRAPPED`), and both paths check it. Resolver first: the card's
 * `toolDefinition` is already stamped, so adoption reports `already` and does not wrap again.
 * Adoption first: a later resolver call on that same object returns it untouched for the same
 * reason. The design therefore applies exactly once, whichever path got there first.
 *
 * ## Every absence is a reported outcome, never a throw
 *
 * This runs inside Pi's render loop. A container without `children`, a child that is not a card, a
 * `toolName` that is not a string, a tool with no designs: all are silently not-ours (`ignored`) —
 * the host's rows stand. A card of an adopted tool whose `toolDefinition` is missing, not a record,
 * has nothing to wrap, or cannot be reassigned is REPORTED through the design bus's one failure
 * channel (`recordToolDesignFailure`, deduplicated) and left exactly as the host built it. A
 * throwing `invalidate` is reported too, and the wrapped definition still applies on the next frame.
 */

import { isRecord } from "./rows.ts";
import { designsOfTool, recordToolDesignFailure } from "./tool-designs.ts";
import {
  TOOL_RENDERERS_WRAPPED,
  wrapRenderers,
  type ToolRenderersLike,
} from "./tool-design-wiring.ts";

/** What one adoption pass did, per child. */
export interface AdoptToolCardsResult {
  /** Children the pass looked at. */
  scanned: number;
  /** Cards whose `toolDefinition` this pass wrapped. */
  adopted: number;
  /** Cards already carrying the wrapper (this path or the resolver's). */
  already: number;
  /** Children that are not a card of a tool with designs. */
  ignored: number;
  /** Cards left exactly as the host built them after a reported failure. */
  failed: number;
}

interface AdoptedEntry {
  tool: string;
  cards: number;
}

interface AdoptionState {
  adoptedCards: AdoptedEntry[];
}

/** Stable process-global slot, like every other piece of bridge state: two copies must agree. */
const ADOPTION_STATE: symbol = Symbol.for("gentle-shell-bridge.tool-designs.adoption.v1");

function adoptionHost(): Record<symbol, AdoptionState | undefined> {
  // SAFETY: only `adoptionState()` writes this key, and it re-checks the shape before trusting a
  // value left behind by another copy or an older load.
  return globalThis as unknown as Record<symbol, AdoptionState | undefined>;
}

function adoptionState(): AdoptionState {
  const host = adoptionHost();
  const existing = host[ADOPTION_STATE];
  if (existing !== undefined && Array.isArray(existing.adoptedCards)) return existing;
  const created: AdoptionState = { adoptedCards: [] };
  host[ADOPTION_STATE] = created;
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Record one card adopted for a tool (once per card: the wrapper's marker prevents a recount). */
function recordAdoptedCard(tool: string): void {
  const state = adoptionState();
  const entry = state.adoptedCards.find((candidate) => candidate.tool === tool);
  if (entry === undefined) state.adoptedCards.push({ tool, cards: 1 });
  else entry.cards += 1;
}

/** What `/bridge-status` reports about the adoption path. */
export interface ToolDesignAdoptionDiagnostics {
  /** Per tool, how many card components were adopted after construction this process. */
  adoptedCards: AdoptedEntry[];
}

/** Diagnostics snapshot for `/bridge-status` (T16). */
export function getToolDesignAdoptionDiagnostics(): ToolDesignAdoptionDiagnostics {
  return {
    adoptedCards: adoptionState().adoptedCards.map((entry) => ({ ...entry })),
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignAdoptionForTests(): void {
  adoptionState().adoptedCards.length = 0;
}

const FAILURE_ID = "(adoption)";

/**
 * Adopt every tool card in a container. Called on each CONVERSATION render pass, before the host
 * renders its children (`./card-style-wiring.ts`); safe to call on anything, and it never throws.
 */
export function adoptToolCards(container: unknown): AdoptToolCardsResult {
  const result: AdoptToolCardsResult = { scanned: 0, adopted: 0, already: 0, ignored: 0, failed: 0 };
  let children: unknown;
  try {
    if (!isRecord(container)) return result;
    children = container.children;
  } catch {
    // A host object whose `children` accessor throws is not a container this pass can read; the
    // host's own rows stand and there is no tool to attribute the failure to.
    return result;
  }
  if (!Array.isArray(children)) return result;

  for (const child of children) {
    result.scanned += 1;
    try {
      result[adoptCard(child)] += 1;
    } catch (error) {
      // `adoptCard` is written not to throw; this is the last line of defence inside Pi's render
      // loop, so even a host object whose every accessor throws cannot take the frame down.
      result.failed += 1;
      const tool = isRecord(child) ? child.toolName : undefined;
      if (typeof tool === "string" && tool !== "") {
        recordToolDesignFailure(tool, FAILURE_ID, errorMessage(error));
      }
    }
  }
  return result;
}

type CardOutcome = "adopted" | "already" | "ignored" | "failed";

function adoptCard(child: unknown): CardOutcome {
  if (!isRecord(child)) return "ignored";
  const tool = child.toolName;
  // Recognition is by component identity, never by the drawn frame (S1): a child that is not a tool
  // card is not ours to touch, and neither is a tool nobody declared a design for.
  if (typeof tool !== "string" || tool === "") return "ignored";
  if (designsOfTool(tool).length === 0) return "ignored";

  const definition = child.toolDefinition;
  if (definition === undefined || definition === null) {
    recordToolDesignFailure(
      tool,
      FAILURE_ID,
      `the card of tool ${JSON.stringify(tool)} carries no toolDefinition, so there are no renderers ` +
        "to wrap; the host's own card is drawn.",
    );
    return "failed";
  }
  if (!isRecord(definition)) {
    recordToolDesignFailure(
      tool,
      FAILURE_ID,
      `the card of tool ${JSON.stringify(tool)} carries a toolDefinition that is not an object, so ` +
        "there is nothing to wrap; the host's own card is drawn.",
    );
    return "failed";
  }
  // SAFETY: `isRecord` just proved this is an object; `toolDefinition` is structurally the renderers
  // object Pi hands a resolver (`renderCall`, `renderResult`, `renderShell`, plus host extras).
  const renderers = definition as ToolRenderersLike;
  // The resolver path (or an earlier pass) already wrapped this card: one design applies once.
  if (Object.hasOwn(renderers, TOOL_RENDERERS_WRAPPED)) return "already";

  let wrapped: ToolRenderersLike;
  try {
    wrapped = wrapRenderers(renderers, tool, "adoption");
  } catch (error) {
    recordToolDesignFailure(tool, FAILURE_ID, errorMessage(error));
    return "failed";
  }
  if (wrapped === renderers) {
    recordToolDesignFailure(
      tool,
      FAILURE_ID,
      `the card of tool ${JSON.stringify(tool)} has no renderCall/renderResult function in its ` +
        "toolDefinition, so there is nothing to wrap; the host's own card is drawn.",
    );
    return "failed";
  }

  try {
    child.toolDefinition = wrapped;
  } catch (error) {
    recordToolDesignFailure(
      tool,
      FAILURE_ID,
      `the card of tool ${JSON.stringify(tool)} refuses its toolDefinition (${errorMessage(error)}); ` +
        "the host's own card is drawn.",
    );
    return "failed";
  }
  // A setter (or a frozen object in a non-strict host) can ignore the assignment without throwing;
  // the card is only adopted when the wrapper is really what the host will read.
  if (child.toolDefinition !== wrapped) {
    recordToolDesignFailure(
      tool,
      FAILURE_ID,
      `the card of tool ${JSON.stringify(tool)} did not take the wrapped toolDefinition; the host's ` +
        "own card is drawn.",
    );
    return "failed";
  }

  recordAdoptedCard(tool);

  // The stored renderer is only rebuilt when the card invalidates; a throwing `invalidate` is the
  // host's own failure, reported once, and the wrapped definition still applies on the next frame.
  try {
    const invalidate = child.invalidate;
    if (typeof invalidate === "function") (invalidate as () => void).call(child);
  } catch (error) {
    recordToolDesignFailure(
      tool,
      FAILURE_ID,
      `the card of tool ${JSON.stringify(tool)} threw from invalidate() after adoption ` +
        `(${errorMessage(error)}); its next frame still draws through the design.`,
    );
  }
  return "adopted";
}

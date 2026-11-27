/**
 * Adopting the custom messages Pi already mounted (S3, S4): the capture point the host actually offers.
 *
 * ## Why this pass exists, and why it is not an API patch
 *
 * `pi.registerMessageRenderer(customType, renderer)` writes into THAT extension's own map
 * (`dist/core/extensions/loader.js:284-287`), and the runner answers `getMessageRenderer(customType)`
 * by scanning extensions in LOAD ORDER and returning the first one that has the type
 * (`dist/core/extensions/runner.js:534-540`). There is no `next()` chain, unlike tool renderers, and
 * no accessor for another extension's map. Every extension holds its own `pi` object with its own
 * closure, so a bridge that patched `pi.registerMessageRenderer` would capture only calls made
 * through the bridge's object — that is, none.
 *
 * What the host does expose is the component it built: `CustomMessageComponent` keeps the renderer Pi
 * resolved in `customRenderer`, re-calls it on every `rebuild()`, and falls back to its own box when
 * the renderer answers `undefined`
 * (`dist/modes/interactive/components/custom-message.js`, `rebuild()`). So adoption is: replace
 * `customRenderer` with the design renderer (`./message-design-wiring.ts`) that delegates to the one
 * the host had, then `invalidate()` so the stored renderer is re-resolved. Pi keeps its frame, its
 * `box`, its padding and its theme, and only the rows change.
 *
 * ## Nobody claimed the type: nobody is touched (S4)
 *
 * A child is ours only when its `message.customType` is claimed by a live design. Everything else is
 * `ignored`: no renderer replaced, no `invalidate()`, no store read. The claim test is a registry
 * walk with no persistence, so a session without message designs pays one scan per render pass and
 * nothing else.
 *
 * ## The one rebuild a switch needs
 *
 * The design renderer re-reads the selection on every pass, so `default` ↔ design with a host
 * renderer needs no rebuild at all. A type with NO host renderer does: `undefined` (Pi's own box) and
 * a component are different answers from the same renderer, so changing between them rebuilds the
 * message exactly once, when the shape changes and never twice.
 *
 * This pass runs inside Pi's render loop, in the same conversation wrapper that adopts tool cards. It
 * never throws: a container without children, a child that is not a message, a renderer that cannot be
 * replaced — all are counted, and the ones the user should know about are reported through the design
 * bus's one failure channel.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import {
  hasMessageDesignClaims,
  isMessageTypeClaimed,
  recordMessageDesignFailure,
  resolveMessageDesignSelection,
} from "./message-designs.ts";
import { messageDesignRenderer, type HostMessageRenderer } from "./message-design-wiring.ts";
import { isRecord } from "./rows.ts";

/** What one adoption pass did, per child. */
export interface AdoptCustomMessagesResult {
  /** Children the pass looked at. */
  scanned: number;
  /** Messages whose renderer this pass replaced with the design renderer. */
  adopted: number;
  /** Messages this pass (or an earlier one) already adopted, and the rebuild it needed if any. */
  already: number;
  /** Messages whose host renderer this pass put back, because no live design claims them any more. */
  restored: number;
  /** Children that are not a message of a claimed type. */
  ignored: number;
  /** Messages left exactly as the host built them after a reported failure. */
  failed: number;
}

/** What this pass remembers about ONE message it adopted. */
interface AdoptedMessage {
  /** Whether the renderer was built while a design was selected (true) or while it was not. */
  designAtBuild: boolean;
  /** The renderer Pi had resolved for this message, put back the moment nobody claims its type. */
  hostRenderer: unknown;
  /**
   * Whether the host had a renderer at all. With one, `default` and a design are the same ANSWER from
   * the design renderer (a component), so a switch between them needs no rebuild. Without one they
   * are different answers — `undefined` (Pi's box) or a component — so the message is rebuilt once.
   */
  hadHost: boolean;
  /**
   * The design that failed on this message. While it is the selected one, the renderer answers
   * `undefined` so Pi runs its own default path: that is what populates the box Pi shows, and retrying
   * a broken design on every frame would only fail again. A different selection clears it by id.
   */
  suppressedDesign?: string;
}

/**
 * Own property on a message component this module adopted. It certifies the exact renderer installed,
 * so a rebuild, a reload or a second loaded copy of this package cannot stack two design renderers on
 * one message.
 */
const ADOPTED_MESSAGE: unique symbol = Symbol.for(
  "gentle-shell-bridge.message-designs.adopted-message.v1",
);

interface AdoptionState {
  /** Per custom type, how many messages this process adopted. */
  adoptedMessages: Array<{ customType: string; messages: number }>;
  /**
   * How many messages currently carry the design renderer. The pass answers "no claim and nothing
   * adopted" BEFORE it reads a child, which is what makes an unclaimed session cost nothing per
   * frame (S4). A host that drops an adopted component without a pass seeing it can only make this
   * number too high, which costs a read and never a wrong answer.
   */
  liveAdoptions: number;
  /**
   * Which adopted messages belong to which conversation container, so a pass over one container never
   * concludes anything about another: a pass over an unrelated (or empty) container must not "heal"
   * an adoption it never saw, and a container that really lost a child must.
   */
  adoptedByContainer: WeakMap<object, Set<unknown>>;
}

/** Stable process-global slot, like every other piece of bridge state: two copies must agree. */
const ADOPTION_KEY = Symbol.for("gentle-shell-bridge.message-designs.adoption.v1");

function adoptionHost(): Record<symbol, AdoptionState | undefined> {
  // SAFETY: only `adoptionState()` writes this key, and it re-checks the shape before trusting a
  // value left behind by another copy or an older load.
  return globalThis as unknown as Record<symbol, AdoptionState | undefined>;
}

function adoptionState(): AdoptionState {
  const host = adoptionHost();
  const existing = host[ADOPTION_KEY];
  if (existing !== undefined && Array.isArray(existing.adoptedMessages)) {
    if (typeof existing.liveAdoptions !== "number") existing.liveAdoptions = 0;
    if (!(existing.adoptedByContainer instanceof WeakMap)) {
      existing.adoptedByContainer = new WeakMap();
    }
    return existing;
  }
  const created: AdoptionState = {
    adoptedMessages: [],
    liveAdoptions: 0,
    adoptedByContainer: new WeakMap(),
  };
  host[ADOPTION_KEY] = created;
  return created;
}

/** What `/bridge-status` reports about this pass. */
export interface MessageDesignAdoptionDiagnostics {
  /** Per custom type, how many messages were adopted after construction this process. */
  adoptedMessages: Array<{ customType: string; messages: number }>;
}

/** Diagnostics snapshot for `/bridge-status`. */
export function getMessageDesignAdoptionDiagnostics(): MessageDesignAdoptionDiagnostics {
  return {
    adoptedMessages: adoptionState().adoptedMessages.map((entry) => ({ ...entry })),
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetMessageDesignAdoptionForTests(): void {
  const state = adoptionState();
  state.adoptedMessages.length = 0;
  state.liveAdoptions = 0;
  state.adoptedByContainer = new WeakMap();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordAdoptedMessage(customType: string): void {
  const state = adoptionState();
  const entry = state.adoptedMessages.find((candidate) => candidate.customType === customType);
  if (entry === undefined) state.adoptedMessages.push({ customType, messages: 1 });
  else entry.messages += 1;
}

/**
 * Whether this type draws a design RIGHT NOW. Resolved at most once per type per pass, because it is
 * the only step that reads the persisted selection.
 */
function designIsSelected(customType: string, perPass: Map<string, boolean>): boolean {
  const cached = perPass.get(customType);
  if (cached !== undefined) return cached;
  let selected = false;
  try {
    selected = resolveMessageDesignSelection(customType).kind === "design";
  } catch (error) {
    recordMessageDesignFailure(customType, "(selection)", errorMessage(error));
  }
  perPass.set(customType, selected);
  return selected;
}

/** Read a member of a host object inside the render loop without letting a throwing getter out. */
function readMember(component: Record<string, unknown>, member: string): unknown {
  try {
    return component[member];
  } catch {
    return undefined;
  }
}

/**
 * Adopt every custom message in a container. Called on each CONVERSATION render pass, before the host
 * renders its children; safe to call on anything, and it never throws.
 */
export function adoptCustomMessages(container: unknown): AdoptCustomMessagesResult {
  const result: AdoptCustomMessagesResult = {
    scanned: 0,
    adopted: 0,
    already: 0,
    restored: 0,
    ignored: 0,
    failed: 0,
  };
  // S4's cost bound: with nothing claimed and nothing adopted, a message is not even looked at.
  if (!hasMessageDesignClaims() && adoptionState().liveAdoptions === 0) return result;
  let children: unknown;
  try {
    if (!isRecord(container)) return result;
    children = container.children;
  } catch {
    // A host object whose `children` accessor throws is not a container this pass can read; the
    // host's own messages stand and there is no type to attribute the failure to.
    return result;
  }
  if (!Array.isArray(children)) return result;

  const perPass = new Map<string, boolean>();
  const state = adoptionState();
  // What THIS container owns, reconciled against what it holds: a message the host removed is a
  // message this container no longer has, while another container's adoptions are none of its
  // business.
  const owned = ownedBy(state, container);
  const seen = new Set<unknown>();
  for (const child of children) {
    result.scanned += 1;
    seen.add(child);
    try {
      result[adoptMessage(child, perPass)] += 1;
      // Counted AFTER the call, from what the child really is now, so an adoption opens the fast path
      // and a restoration closes it — in one place, from one fact.
      if (isRecord(child) && adoptedMessage(child) !== undefined) {
        if (!owned.has(child)) {
          owned.add(child);
          state.liveAdoptions += 1;
        }
      } else if (owned.delete(child)) {
        state.liveAdoptions -= 1;
      }
    } catch (error) {
      // `adoptMessage` is written not to throw; this is the last line of defence inside Pi's render
      // loop, so even a host object whose every accessor throws cannot take the frame down.
      result.failed += 1;
      const customType = messageTypeOf(child);
      if (customType !== undefined) {
        recordMessageDesignFailure(customType, "(adoption)", errorMessage(error));
      }
    }
  }
  // A message this container no longer holds is a message the host removed: only THIS container may
  // conclude that, which is why the ownership sets exist at all. `liveAdoptions` is the process total,
  // so one container losing a child reopens the fast path and a container that never saw an adoption
  // cannot close it (S4).
  for (const child of owned) {
    if (!seen.has(child)) {
      owned.delete(child);
      state.liveAdoptions -= 1;
    }
  }
  return result;
}

/** The set of messages one container adopted, created on first use. */
function ownedBy(state: AdoptionState, container: Record<string, unknown>): Set<unknown> {
  const existing = state.adoptedByContainer.get(container);
  if (existing !== undefined) return existing;
  const created = new Set<unknown>();
  state.adoptedByContainer.set(container, created);
  return created;
}

/** The custom type of a message child, or `undefined` when this child is not one. */
function messageTypeOf(child: unknown): string | undefined {
  if (!isRecord(child)) return undefined;
  const message = readMember(child, "message");
  if (!isRecord(message)) return undefined;
  const customType = readMember(message, "customType");
  return typeof customType === "string" && customType !== "" ? customType : undefined;
}

type MessageOutcome = "adopted" | "already" | "restored" | "ignored" | "failed";

function adoptMessage(child: unknown, perPass: Map<string, boolean>): MessageOutcome {
  if (!isRecord(child)) return "ignored";
  const customType = messageTypeOf(child);
  if (customType === undefined) return "ignored";
  const claimed = isMessageTypeClaimed(customType);
  const adopted = adoptedMessage(child);

  // A message this pass adopted, whose type nobody claims any more: put the host's own renderer back
  // and rebuild once. Otherwise the message would keep calling a design renderer that now answers
  // `default` — and would read the store on every frame for a type nobody claims (S4).
  if (adopted !== undefined && !claimed) return restore(child, customType, adopted);

  // Recognition is by CLAIM, never by the drawn frame (S4): a message nobody declared a design for is
  // not ours to touch, and this is the only check that keeps an unclaimed session byte-identical.
  if (!claimed) return "ignored";
  // A component, and nothing else: a message object that is not renderable is not a message Pi drew.
  if (typeof readMember(child, "render") !== "function") return "ignored";

  const design = designIsSelected(customType, perPass);
  if (adopted !== undefined) {
    // Already adopted. The design renderer reads the selection per pass, so a switch between `default`
    // and a design with a host renderer needs NOTHING. Without a host renderer the renderer answers
    // `undefined` (Pi's own box) or a component — different answers — so it rebuilds exactly once per
    // shape change, and never twice for the same shape.
    // When the built answer was the wrapper, it reads the selection itself and nothing is needed. It
    // is needed in the two cases where the built answer was NOT the wrapper: a host-less message that
    // answered `undefined` (Pi's box) and now must draw, and a host-backed one that answered the
    // host's own component and now must be rewritten. Coming back to `default` from a wrapper costs
    // no rebuild in either case — the wrapper returns the host's rows, or Pi's own body, unchanged.
    const needsRebuild = adopted.hadHost
      ? design && !adopted.designAtBuild
      : adopted.designAtBuild !== design;
    if (needsRebuild) {
      adopted.designAtBuild = design;
      invalidate(child, customType);
    }
    return "already";
  }

  const hostRenderer = readMember(child, "customRenderer");
  // Pi calls its renderer as a MEMBER (`this.customRenderer(...)`), so a host renderer that is a method
  // gets the component as `this`. The design renderer must call it the same way or a method renderer
  // breaks the moment the bridge wraps it.
  const boundHost =
    typeof hostRenderer === "function"
      ? (message: unknown, options: unknown, theme?: unknown): unknown =>
          // SAFETY: `typeof` just proved this callable; its arguments are Pi's own, forwarded as-is.
          (hostRenderer as HostMessageRenderer).call(child, message, options, theme)
      : undefined;
  const renderer = messageDesignRenderer(customType, boundHost, {
    // A design that throws on a host-less message must not take the body with it. Pi's own box is
    // right there on the component it built, so it is rendered as-is: the same bytes the user would
    // have seen without a design, not a picture of them invented here.
    fallbackRows: (width: number): string[] | undefined => hostBoxRows(child, width),
    // What the mounted answer is, kept true across rebuilds this pass never sees: `setExpanded`, a
    // session switch or a reload re-enter the renderer, and a stale record would leave the message
    // on the raw host component with no design able to reach it again.
    onBuild: (designSelected: boolean): void => {
      record.designAtBuild = designSelected;
    },
    isSuppressed: (designId: string): boolean => record.suppressedDesign === designId,
    onFailure: (designId: string): void => {
      if (record.suppressedDesign === designId) return;
      record.suppressedDesign = designId;
      // One rebuild: Pi's own renderer, its own populated box, and no second failure on this frame.
      invalidate(child, customType);
    },
  });
  const record: AdoptedMessage = {
    designAtBuild: design,
    hostRenderer,
    hadHost: typeof hostRenderer === "function",
  };


  // The marker goes FIRST. A component that cannot take an own symbol (a sealed one) is reported and
  // never touched, because replacing its renderer without a marker would make every later pass wrap
  // it again — the one failure mode that compounds.
  try {
    Object.defineProperty(child, ADOPTED_MESSAGE, {
      value: record,
      enumerable: false,
      configurable: true,
    });
  } catch (error) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      `the message cannot be marked as adopted (${errorMessage(error)}); Pi's own rendering stands.`,
    );
    return "failed";
  }
  if (adoptedMessage(child) !== record) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      "the message did not take the adoption marker; Pi's own rendering stands.",
    );
    return "failed";
  }

  try {
    child.customRenderer = renderer;
  } catch (error) {
    delete symbolSlot(child)[ADOPTED_MESSAGE];
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      `the message refuses its customRenderer (${errorMessage(error)}); Pi's own rendering stands.`,
    );
    return "failed";
  }
  // A setter (or a frozen object in a non-strict host) can ignore the assignment without throwing: the
  // message is only adopted when the renderer this pass installed is really the one Pi will call.
  if (child.customRenderer !== renderer) {
    delete symbolSlot(child)[ADOPTED_MESSAGE];
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      "the message did not take the design renderer; Pi's own rendering stands.",
    );
    return "failed";
  }

  recordAdoptedMessage(customType);
  // The renderer Pi stored was resolved when the message was added; `invalidate()` is what makes it
  // resolve again, through the design renderer.
  invalidate(child, customType);
  return "adopted";
}

/**
 * Put the host's own renderer back on a message no design claims any more, and rebuild it once. The
 * host's value is restored VERBATIM (including `undefined` for a type with no renderer), so the message
 * returns to exactly what Pi built, and no later frame pays for a surface nobody uses.
 */
function restore(
  child: Record<string, unknown>,
  customType: string,
  record: AdoptedMessage,
): MessageOutcome {
  try {
    child.customRenderer = record.hostRenderer;
  } catch (error) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      `the message refuses its customRenderer while being restored (${errorMessage(error)}); ` +
        "the design renderer stays, drawing `default`.",
    );
    return "failed";
  }
  if (child.customRenderer !== record.hostRenderer) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      "the message did not take its host renderer back; the design renderer stays, drawing `default`.",
    );
    return "failed";
  }
  delete symbolSlot(child)[ADOPTED_MESSAGE];
  invalidate(child, customType);
  return "restored";
}

/**
 * Pi's own box for this message, rendered at `width`, or `undefined` when the component has none this
 * pass can read. `CustomMessageComponent` builds that box in its constructor and keeps it for exactly
 * this default rendering, so asking it is reading the host's own work — never re-drawing it.
 */
function hostBoxRows(child: Record<string, unknown>, width: number): string[] | undefined {
  const box = readMember(child, "box");
  if (!isRecord(box) || typeof readMember(box, "render") !== "function") return undefined;
  // Pi applies the message's padding to that box ONLY on its default path, which a design bypasses:
  // after `setOutputPad(4)` the box still carries the padding it was born with. Rendering it as the
  // fallback must therefore set the CURRENT output padding first, or a failed design would answer an
  // indented box that no setting asked for.
  const outputPad = readMember(child, "outputPad");
  const setPaddingX = readMember(box, "setPaddingX");
  const currentPad = readMember(box, "paddingX");
  // Only when it really changed: `setPaddingX` invalidates the box's own render cache, and paying that
  // on every failed draw would make a message with a broken design rebuild its box on every frame.
  if (
    typeof outputPad === "number" &&
    outputPad !== currentPad &&
    typeof setPaddingX === "function"
  ) {
    try {
      (setPaddingX as (padding: number) => void).call(box, outputPad);
    } catch {
      // A box that refuses its own padding is still a box this pass can render.
    }
  }
  let rows: unknown;
  let blank = true;
  try {
    // SAFETY: `typeof` just proved `render` callable, and a component's `render(width)` is the whole
    // contract this reads; its answer is inspected before it is trusted.
    rows = (readMember(box, "render") as (width: number) => unknown).call(box, width);
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (typeof row !== "string") return undefined;
    // An EMPTY box is not a frame: Pi only populates its default box on the path a design bypasses,
    // so a box that renders nothing at all must not be handed to the user as "the host's answer".
    if (row.trim() !== "") blank = false;
  }
  return blank ? undefined : (rows as string[]);
}

/**
 * The same component, read through the symbol key this module owns. One cast, in one place: the record
 * lives on the host's own object, so it can only be reached through a symbol index.
 */
function symbolSlot(child: Record<string, unknown>): Record<symbol, unknown> {
  // SAFETY: a symbol-keyed read of the same object; `ADOPTED_MESSAGE` is the only symbol written here,
  // and the value is re-checked for its shape before it is trusted.
  return child as unknown as Record<symbol, unknown>;
}

/** The adoption record of a child this pass installed a renderer on, if it is really still ours. */
function adoptedMessage(child: Record<string, unknown>): AdoptedMessage | undefined {
  const record = symbolSlot(child)[ADOPTED_MESSAGE];
  if (!isRecord(record)) return undefined;
  // SAFETY: the only writer of this symbol is `adoptMessage`, which stores an `AdoptedMessage`; a
  // value left by another copy is re-checked for the fields this pass reads before it is trusted.
  return typeof record.designAtBuild === "boolean" && typeof record.hadHost === "boolean"
    ? (record as unknown as AdoptedMessage)
    : undefined;
}

/** Rebuild one message; a throwing `invalidate` is the host's own failure and is reported once. */
function invalidate(child: Record<string, unknown>, customType: string): void {
  const invalidateChild = readMember(child, "invalidate");
  if (typeof invalidateChild !== "function") {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      "the message has no invalidate(), so its renderer cannot be re-resolved; Pi keeps drawing " +
        "what it already drew until the message is rebuilt by the host.",
    );
    return;
  }
  try {
    (invalidateChild as () => void).call(child);
  } catch (error) {
    recordMessageDesignFailure(
      customType,
      "(adoption)",
      `the message threw from invalidate() after adoption (${errorMessage(error)}); its next frame ` +
        "still draws through the design.",
    );
  }
}

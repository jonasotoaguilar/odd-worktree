/**
 * The runtime handshake: how a plugin reaches this bridge without a path, an environment variable
 * or an import.
 *
 * Pi gives two independent projects exactly one sanctioned channel that needs no install detail:
 * `globalThis` (`docs/extensions.md:1965-1972`). So the package publishes a frozen, versioned
 * service object at a stable symbol, at module load:
 *
 * ```ts
 * Symbol.for("gentle-shell-bridge/api/v1") → { schema, version, VERSION, registerRows,
 *                                              registerSection, registerCardStyle,
 *                                              registerTransform, registerToolDesign,
 *                                              registerMessageDesign, createStore,
 *                                              requestRepaint }
 * ```
 *
 * A plugin registers from its own `session_start` handler. But Pi does NOT guarantee that this
 * package loaded first: the real TUI showed global extensions (`~/.pi/agent/extensions`) loading —
 * and receiving `session_start` — before a configured package's module ever published. So the
 * symbol's presence is the complete answer only when it is present. When it is absent, the plugin
 * still needs a way to hear about a bridge that publishes later, and it hears it on Pi's own
 * cross-extension bus (`docs/extensions.md:1965-1972`):
 *
 * ```ts
 * pi.events.on("gentle-shell-bridge:ready", ({ schema, version, VERSION }) => …)
 * ```
 *
 * The bridge emits that event once per process, after a successful publish and never for an
 * incompatible slot (`announceBridgeReady`). A plugin that imports this package calls
 * `onBridgeApi(handler, pi.events)`, which serves it immediately when the object is already there
 * and subscribes when it is not. The symbol stays the authority: the announcement only says "look
 * again", so a copy that publishes an incompatible slot announces nothing and a listener that
 * hears the event still gates on the object itself.
 *
 * Why a symbol instead of a path or `GENTLE_SHELL_BRIDGE_MODULE`: a path is not a contract between
 * two projects — it names one checkout on one machine, and it breaks the day either project moves.
 * The symbol key is the contract, and `v1` in the key is the major version: a future major takes a
 * NEW key rather than mutating this one. `pi-lens` publishes its IO bridge the same way
 * (`clients/io-bridge-contract.ts:26-31`, `clients/process-bridge.ts:31-66`): stable symbol, a
 * version constant, a frozen non-writable slot, and "version mismatch means unsupported".
 *
 * ## First wins, and nothing is ever reset
 *
 * Pi loads every extension through its own jiti loader with `moduleCache: false`, so this module
 * exists once per copy. Every copy's functions operate on the same process-global bus
 * (`./bus.ts`, `./store.ts`), which makes them interchangeable: whoever publishes first owns the
 * slot, and later copies hand the same object back. A slot that holds something incompatible is
 * treated as ABSENT — never overwritten, never deleted.
 *
 * ## Version skew
 *
 * Consumers gate on the schema string, `version === 1` and the three callable members
 * (`isBridgeApi`). A mismatch is not an error and never a fallback to a half-working object: the
 * caller sees `undefined`, and one notice is recorded per process (the TUI shows it once and
 * `/bridge-status` keeps reporting it).
 *
 * ## Why the gate is also documented inline
 *
 * A plugin that does not depend on this package must be able to do the same thing in about six
 * lines, so README.md carries the inline copy of the gate and the symbol. Keep the two in sync.
 */

import { registerCardStyle, registerRows, registerSection, registerTransform } from "./bus.ts";
import { registerMessageDesign } from "./message-designs.ts";
import { recordNotice } from "./notices.ts";
import { requestRepaint } from "./repaint.ts";
import { createStore } from "./store.ts";
import { registerToolDesign, resolveToolDesignSelection } from "./tool-designs.ts";

/** The release that published the object; informational, never the compatibility check. */
export const VERSION = "0.16.2";

/** Identity of the object, so a foreign payload at the symbol is never mistaken for ours. */
export const API_SCHEMA = "gentle-shell-bridge/api";

/** Major version of the published shape. A breaking change means a new symbol key. */
export const API_VERSION = 1;

/** The published service object's stable, process-global key. */
export const BRIDGE_API_KEY: symbol = Symbol.for("gentle-shell-bridge/api/v1");

/**
 * The channel this package announces itself on, on Pi's cross-extension bus.
 *
 * A plugin loaded before this package has no object to read yet, so it subscribes here. The
 * announcement is a notification, never a registry: it says "the object is published now", and the
 * listener reads the symbol. That keeps one authority (the symbol and its shape gate) and one
 * channel for the timing.
 */
export const BRIDGE_READY_EVENT = "gentle-shell-bridge:ready";

/** What the announcement carries: identity, major version and the publishing release. */
export interface BridgeReadyPayload {
  readonly schema: typeof API_SCHEMA;
  readonly version: typeof API_VERSION;
  readonly VERSION: string;
}

/**
 * The two members of `pi.events` this package uses (`docs/extensions.md:1965-1972`). Both are
 * optional so a host without a bus is a normal case, not a type error: no bus means the symbol is
 * the only channel, which is exactly how this worked before.
 */
export type BridgeEventUnsubscribe = () => void;

export interface BridgeEventBus {
  emit?(channel: string, data: unknown): void;
  on?(channel: string, handler: (data: unknown) => void): BridgeEventUnsubscribe | void;
}

/** The one payload every announcement carries; frozen like the published object. */
const READY_PAYLOAD: BridgeReadyPayload = Object.freeze({
  schema: API_SCHEMA,
  version: API_VERSION,
  VERSION,
});

/**
 * Bookkeeping for "one announcement per process", keyed by a symbol so two copies of this module
 * share it, exactly like the slot and the skew notice.
 */
const READY_KEY: symbol = Symbol.for("gentle-shell-bridge/api/v1.ready");

/** Bookkeeping for "one skew notice per process", kept off module scope for the same reason as the bus. */
const WARNED_KEY: symbol = Symbol.for("gentle-shell-bridge/api/v1.warned");

/** The object published at `BRIDGE_API_KEY`. */
export interface BridgeApi {
  readonly schema: typeof API_SCHEMA;
  readonly version: typeof API_VERSION;
  /** The publishing release, e.g. `"0.2.0"`. Informational. */
  readonly VERSION: string;
  readonly registerRows: typeof registerRows;
  readonly registerSection: typeof registerSection;
  /**
   * Card styles (S1). Absent only on an object published by a copy that predates this surface: the
   * slot is first-wins, so a mixed-copy process can hand back the older object. The shape gate does
   * NOT demand it, deliberately — an older object is still a usable bridge for rows, sections and
   * the store, and a plugin that needs card styles checks `typeof api.registerCardStyle ===
   * "function"` before using it. Demanding it here would turn a working bridge into "absent" for
   * every row-only plugin.
   */
  readonly registerCardStyle?: typeof registerCardStyle;
  /**
   * Transcript transforms (S1). Optional for the same reason as `registerCardStyle`: the slot is
   * first-wins, so a mixed-copy process can hand back an object published before this surface. A
   * plugin that needs the pipeline checks `typeof api.registerTransform === "function"`; demanding
   * it in the gate would turn a working bridge into "absent" for every row-only plugin.
   */
  readonly registerTransform?: typeof registerTransform;
  /**
   * A repaint of what the host draws (T4, S13): one DIFFERENTIAL frame, `requestRender()` with no
   * argument, after bumping the host's sidebar revision. It does NOT invalidate the component tree and
   * does NOT force a full redraw: measured on a 600-child transcript with real pi components, that cost
   * 753 ms and 6.9 MB per switch against 20 ms for the differential frame, because invalidating clears
   * every Markdown cache. A design change still reaches the cards ALREADY on screen because the design
   * wrapper re-applies the live selection to the host's rows on every render pass.
   *
   * Returns what `/bridge-status` reports as the last repaint, and never throws — with no host
   * captured yet the request is reported as `unavailable` with its reason.
   *
   * Optional for the same reason as `registerCardStyle`: the slot is first-wins, so a mixed-copy
   * process can hand back an object published before this member existed. A plugin that needs it
   * checks `typeof api.requestRepaint === "function"`; demanding it in the gate would turn a working
   * bridge into "absent" for every plugin that does not.
   */
  readonly requestRepaint?: typeof requestRepaint;
  /**
   * A card DESIGN for one tool name (S4, S5, S7): the bridge owns the single
   * `pi.registerToolRenderer` resolver and fans it out to every design a plugin registers here. A
   * design receives the rows the host's own card produced and returns the rows to draw, so the frame
   * stays the host's.
   *
   * Optional for the same reason as `registerCardStyle`: the slot is first-wins, so a mixed-copy
   * process can hand back an object published before this member existed. A plugin that needs it
   * checks `typeof api.registerToolDesign === "function"`; demanding it in the gate would turn a
   * working bridge into "absent" for every plugin that does not register a design.
   */
  readonly registerToolDesign?: typeof registerToolDesign;
  /**
   * What a tool's card is drawing RIGHT NOW (S6/D4): `{ kind: "native" }` for the host's own card,
   * `{ kind: "design", design }` for the design on screen, `{ kind: "missing", id }` when the design
   * the line names is gone, and `{ kind: "not-covered", id }` when the line's value is a design that
   * does not paint this tool. The same answer the bridge's own card wrapper acts on, so a plugin that
   * paints its own chrome for a tool can gate on the user's switch instead of parsing the store file
   * and re-deriving the rule.
   *
   * Pure read, and it never throws: an unreadable selection reads as `native`. It costs ONE
   * persisted-selection read per call — exactly what one render pass already pays (`./tool-design-wiring.ts`),
   * so a caller may ask on every frame for the tool it is painting. Asking for every tool on every
   * frame multiplies that count, and nothing here caches the answer for you.
   *
   * Optional for the same reason as `registerCardStyle`: the slot is first-wins, so a mixed-copy
   * process can hand back an object published before this member existed. A plugin that needs it
   * checks `typeof api.resolveToolDesignSelection === "function"` first.
   */
  readonly resolveToolDesignSelection?: typeof resolveToolDesignSelection;
  /**
   * A card DESIGN for one Pi custom message type (S1, S2, S3): the rows of the host's own message
   * renderer in, the rows to draw out. A type with NO host renderer hands the design no rows
   * (`[]`) and the design owns the box; a type that HAS one keeps it, and the design only rewrites
   * its rows, so `float`/`neon` stay the host's. Nothing is installed for a type nobody claimed, so
   * Pi's own output for it is byte-identical (S4).
   *
   * The bridge does not register anything into Pi's `registerMessageRenderer` map: that map belongs
   * to the extension that registered, and the runner answers the FIRST renderer in load order with
   * no `next()` chain. The bridge adopts the renderer Pi already resolved onto each message instead,
   * which is why a message mounted before the first conversation pass is reached on the next one.
   *
   * Optional for the same reason as `registerCardStyle`: the slot is first-wins, so a mixed-copy
   * process can hand back an object published before this member existed. A plugin that needs it
   * checks `typeof api.registerMessageDesign === "function"`; demanding it in the gate would turn a
   * working bridge into "absent" for every plugin that does not register one.
   */
  readonly registerMessageDesign?: typeof registerMessageDesign;
  readonly createStore: typeof createStore;
}

function apiHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys, and every write to these slots happens in this module
  // behind the shape checks below.
  return globalThis as unknown as Record<symbol, unknown>;
}

interface WarnedState {
  skew: boolean;
}

/** One announcement per process, no matter how many copies publish or how often they ask. */
interface ReadyState {
  announced: boolean;
}

/**
 * The process-global state for a symbol-keyed flag, created on first use. A foreign object at the
 * key is replaced by a fresh one: this state belongs to this package alone, and it carries nothing
 * a consumer reads.
 */
function flagState<T extends object>(key: symbol, shape: (candidate: Partial<T>) => boolean, created: T): T {
  const host = apiHost();
  const existing = host[key];
  if (typeof existing === "object" && existing !== null) {
    const candidate = existing as Partial<T>;
    if (shape(candidate)) return candidate as T;
  }
  host[key] = created;
  return created;
}

function warnedState(): WarnedState {
  return flagState<WarnedState>(
    WARNED_KEY,
    (candidate) => typeof candidate.skew === "boolean",
    { skew: false },
  );
}

function readyState(): ReadyState {
  return flagState<ReadyState>(
    READY_KEY,
    (candidate) => typeof candidate.announced === "boolean",
    { announced: false },
  );
}

/** One clear notice per process, no matter how many copies ask. */
function warnSkewOnce(): void {
  const state = warnedState();
  if (state.skew) return;
  state.skew = true;
  recordNotice(
    `gentle-shell-bridge: the slot ${String(BRIDGE_API_KEY)} holds something that is not the ` +
      `"${API_SCHEMA}" API version ${String(API_VERSION)} this process expects (a different major ` +
      "version, another library's payload, or a partial object). It is treated as ABSENT: " +
      "bridgeApi() returns undefined and plugins register nothing through this slot. The slot is " +
      "left exactly as it is — it is never overwritten and never reset. This notice is recorded " +
      "once per process and appears in the TUI and in /bridge-status.",
    "warning",
  );
}

/**
 * The shape gate: the schema string, `version === 1`, and the three members a consumer calls.
 * Anything else — another library's object, a future major version, a partial object — is absent,
 * never an error.
 */
export function isBridgeApi(value: unknown): value is BridgeApi {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === API_SCHEMA &&
    candidate.version === API_VERSION &&
    typeof candidate.registerRows === "function" &&
    typeof candidate.registerSection === "function" &&
    typeof candidate.createStore === "function"
  );
}

/** The object this copy publishes when it owns the slot (or when the slot is unusable). */
const LOCAL_API: BridgeApi = Object.freeze({
  schema: API_SCHEMA,
  version: API_VERSION,
  VERSION,
  registerRows,
  registerSection,
  registerCardStyle,
  registerTransform,
  requestRepaint,
  registerToolDesign,
  resolveToolDesignSelection,
  registerMessageDesign,
  createStore,
});

/** The slot's object when it passes the gate; `undefined` when it is absent or incompatible. */
function compatibleApi(): BridgeApi | undefined {
  const existing = apiHost()[BRIDGE_API_KEY];
  if (existing === undefined) return undefined;
  if (isBridgeApi(existing)) return existing;
  warnSkewOnce();
  return undefined;
}

/**
 * The validated published object as the slot holds it RIGHT NOW, or `undefined`.
 *
 * This is the whole handshake for a plugin that imports the package and is loaded after it. Call it
 * from a `session_start` handler: an object means register now. `undefined` means nothing is
 * published yet — which is "not yet", not necessarily "not installed", because Pi may load your
 * plugin before this package. Use `onBridgeApi(handler, pi.events)` when both orders have to work;
 * `bridgeApi()` itself never waits, defers or retries.
 */
export function bridgeApi(): BridgeApi | undefined {
  return compatibleApi();
}

/**
 * Publish this copy's API object.
 *
 * Runs at module load, so loading the package — through `./extension.ts` or `./index.ts` — makes
 * the API available before any `session_start`. First wins: a valid object already in the slot is
 * kept and returned untouched. An incompatible object is kept too (never reset), and this copy's
 * own object is returned so its own extension can still register through the same bus.
 */
export function publishBridgeApi(): BridgeApi {
  const host = apiHost();
  const existing = host[BRIDGE_API_KEY];
  if (existing === undefined) {
    host[BRIDGE_API_KEY] = LOCAL_API;
    return LOCAL_API;
  }
  if (isBridgeApi(existing)) return existing;
  warnSkewOnce();
  return LOCAL_API;
}

/**
 * Test-only seam: forget the published object, the once-per-process notice flag and the
 * announcement flag. Clearing the published object is what lets a test model "the bridge is not
 * installed"; clearing the announcement flag is what lets one process prove "once" twice. The
 * extension never calls this. Deliberately not re-exported from `src/index.ts`.
 */
export function resetBridgeApiForTests(): void {
  const host = apiHost();
  delete host[BRIDGE_API_KEY];
  delete host[WARNED_KEY];
  delete host[READY_KEY];
}

// ---------------------------------------------------------------------------------------------
// The announcement: how a plugin loaded BEFORE the package learns about it
// ---------------------------------------------------------------------------------------------

/** The `emit` member of a bus-shaped object, bound to it, or `undefined` when unusable. */
function busEmitter(events: unknown): ((channel: string, data: unknown) => void) | undefined {
  if (typeof events !== "object" || events === null) return undefined;
  const emit = (events as BridgeEventBus).emit;
  if (typeof emit !== "function") return undefined;
  return (channel, data) => {
    emit.call(events, channel, data);
  };
}

/** The `on` member of a bus-shaped object, bound to it, or `undefined` when unusable. */
function busListener(
  events: unknown,
): ((channel: string, handler: (data: unknown) => void) => BridgeEventUnsubscribe | void) | undefined {
  if (typeof events !== "object" || events === null) return undefined;
  const on = (events as BridgeEventBus).on;
  if (typeof on !== "function") return undefined;
  return (channel, handler) => on.call(events, channel, handler);
}

/**
 * Announce this process's bridge, on Pi's cross-extension bus, at most once.
 *
 * Called from the extension entry — the first moment `pi.events` exists — right after the module
 * load that published the object. Rules, all of them observable in the tests:
 *
 * - **once per process**, across package copies: the flag lives on `globalThis`, like the slot;
 * - **never for an incompatible slot**: a process whose slot holds another library's payload (or
 *   another major) has no bridge to announce, and telling plugins to look again would only send
 *   them to an object that is absent;
 * - **silent without a bus**: Pi may have no `pi.events` in a bare harness; the symbol still works
 *   for any plugin that reads it, so nothing is reported and nothing throws.
 *
 * Returns whether this call emitted.
 */
export function announceBridgeReady(events: unknown): boolean {
  const emit = busEmitter(events);
  if (emit === undefined) return false;
  const state = readyState();
  if (state.announced) return false;
  // The announcement says "the slot is usable now": an incompatible slot is never announced.
  if (compatibleApi() === undefined) return false;
  state.announced = true;
  try {
    emit(BRIDGE_READY_EVENT, READY_PAYLOAD);
  } catch {
    // A bus that throws cannot un-announce the process: the flag stays set, so `once` holds even
    // when the delivery failed. Nothing is written to the terminal.
  }
  return true;
}

/** What a consumer does with the published object. */
export type BridgeApiHandler = (api: BridgeApi) => void;

/**
 * Serve a plugin the published API, now or when it is announced.
 *
 * This is the helper form of the corrected timing rule:
 *
 * - **the object is already published** (this package loaded first): the handler runs immediately, in
 *   the same turn, and nothing is subscribed — calling it twice cannot leak a listener;
 * - **it is not published yet** (the plugin loaded first, the real defect): the handler runs when the
 *   bridge announces itself, at most once per subscription, and the listener detaches itself.
 *
 * `events` is `pi.events`. Without a bus the helper cannot hear a later publication: it returns a
 * no-op disposer and never calls the handler, which is the honest answer for a host with no bus.
 * A handler that throws is contained: one plugin's failure must not break the announcement for the
 * next listener.
 */
export function onBridgeApi(handler: BridgeApiHandler, events?: unknown): () => void {
  /** One plugin's throw is its own: the bus must survive to notify the next listener. */
  const deliver = (api: BridgeApi): void => {
    try {
      handler(api);
    } catch {
      // Contained on purpose (see the contract: nothing a plugin does may throw into Pi's render).
    }
  };

  const existing = bridgeApi();
  if (existing !== undefined) {
    deliver(existing);
    return () => {};
  }

  const listen = busListener(events);
  if (listen === undefined) return () => {};

  let active = true;
  let unsubscribe: BridgeEventUnsubscribe | void;

  const detach = (): void => {
    const off = unsubscribe;
    unsubscribe = undefined;
    if (typeof off !== "function") return;
    try {
      off();
    } catch {
      // A disposer that throws cannot resurrect the subscription.
    }
  };

  const onReady = (): void => {
    if (!active) return;
    const api = bridgeApi();
    if (api === undefined) return; // an announcement not backed by a usable slot
    active = false;
    detach();
    deliver(api);
  };

  try {
    unsubscribe = listen(BRIDGE_READY_EVENT, onReady);
  } catch {
    return () => {};
  }

  return () => {
    active = false;
    detach();
  };
}

// The publishing point: loading this module publishes the API. `./extension.ts` imports it, so the
// object exists as soon as the package has loaded at all — and, when the package loads after a
// plugin, `announceBridgeReady` from the same entry is how that plugin hears about it.
publishBridgeApi();

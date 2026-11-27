/**
 * The message-design registry (S1, S4): ONE registration point for Pi custom messages, and the
 * selection the wiring resolves on every pass.
 *
 * ## Why this exists
 *
 * `bash` is drawn by gentle-shell's own renderers, so `float`/`neon` reaches it there. A custom message
 * registered with `pi.registerMessageRenderer` is drawn by whoever registered it — or by Pi's default
 * box when nobody did — and neither path knows about the bridge's card styles. A design is the only
 * surface from which a plugin can paint one, and this module is its registry.
 *
 * ## One value per line, one line per type
 *
 * The shape is the tool designs' shape (see `./tool-designs.ts`), minus scopes: a design is declared for
 * ONE custom type (its own `Message <type>` line) or joins a named line of several types. A type belongs
 * to at most ONE line, so two switches can never disagree about one message; a second claim on a type is
 * refused whole before anything is stored.
 *
 * ## The persisted value is the design id, never the label
 *
 * `default` (stored as `native`, the reserved identity) is the host's own output, always first and never
 * registered by a plugin. Renaming a label therefore never loses a user's choice, and disposing a design
 * leaves `missing` — which the wiring reads as "draw the host's own output" and says so in
 * `/bridge-status`, never as a silent `default`.
 *
 * ## Declining costs nothing
 *
 * With no design registered for a type the wiring never even installs a renderer for it (S4): Pi's own
 * output is byte-identical and no pass pays for this surface. Resolving reads the store ONCE per call,
 * never once per candidate.
 *
 * This module is internal: `src/index.ts` re-exports only `registerMessageDesign`,
 * `resolveMessageDesignSelection` and their types.
 */

import { assertRegistrationId } from "./bus.ts";
import { attributeRegistration } from "./plugin-lines.ts";
import { isRecord } from "./rows.ts";
import { createStore } from "./store.ts";
import { getToolDesignLineSelection, toolDesignLines } from "./tool-designs.ts";
import type {
  MessageDesignContext,
  MessageDesignFollow,
  MessageDesignFollowAnswer,
  MessageDesignRegistration,
} from "./types.ts";

/** The reserved value that means "the host's own output": never a design id, never selectable as one. */
export const MESSAGE_DESIGN_NATIVE = "native";

/** What the menu SHOWS for that value, exactly like `Card <line>`'s `default`. */
export const MESSAGE_DESIGN_DEFAULT_LABEL = "default";

/** The bridge's own store, namespaced: never a plugin's file. */
export const MESSAGE_DESIGN_STORE_ID = "bridge-message-designs";

/** The one key in it: the per-type selections, with the per-line map under a reserved key beside them. */
export const MESSAGE_DESIGN_STORE_KEY = "selections";

/** Reserved inside that document, so a custom type can never collide with the line map. */
export const MESSAGE_DESIGN_LINE_STORE_KEY = "$lines";

/** Which key a line uses: an ungrouped design's implicit line, or a registered line id. */
export type MessageDesignScope = "type" | "line";

/** A registration that replaced, duplicated or collided with another one, reported by `/bridge-status`. */
export interface MessageDesignConflict {
  /** The custom type the record is about (the first of the line's types for a line conflict). */
  customType: string;
  /** The id of the registration that lost or was replaced. */
  id: string;
  kind: "replaced" | "label" | "type";
  /** One sentence naming what happened, shown verbatim. */
  message: string;
}

/** A design that threw while painting, recorded once per (type, id, message). */
export interface MessageDesignFailure {
  customType: string;
  designId: string;
  message: string;
}

/** How many failures are kept; older ones fall off the front. */
const MAX_FAILURES = 8;

/** One live registration: the line it belongs to, the types it claims, and the design itself. */
interface DesignEntry {
  scope: MessageDesignScope;
  line: string;
  types: string[];
  design: MessageDesignRegistration;
}

/** One line, as the menu and `/bridge-status` read it. */
export interface MessageDesignLine {
  scope: MessageDesignScope;
  /** The selection key: the custom type, or the registered line id. */
  line: string;
  /** Every type the line covers, in first-seen order. */
  types: string[];
  /** The line's designs, in registration order. */
  designs: MessageDesignRegistration[];
}

/** What a type's stored selection means right now. Never a throw: every value is an answer. */
export type MessageDesignSelection =
  | { kind: "native" }
  | { kind: "design"; design: MessageDesignRegistration }
  | { kind: "missing"; id: string }
  | { kind: "not-covered"; id: string };

interface MessageDesignState {
  /** Every live registration, in registration order; one entry per (`scope`, `line`, `id`). */
  entries: DesignEntry[];
  conflicts: MessageDesignConflict[];
  failures: MessageDesignFailure[];
  /**
   * How many times the persisted selections were read since the last reset. One read is one logical
   * read of the bridge's store, which is what a cost test bounds instead of timing (S4).
   */
  selectionReads: number;
  /**
   * The rows line's installer, set by `./message-design-rows.ts` when the bridge arms. It is called
   * when a design appears, so the line is registered THEN and never before: with no design there is
   * no provider, no row and nothing added to `/bridge-status` (S4).
   */
  rowsInstaller?: () => void;
}

/** Stable process-global slot: a second loaded copy of this package must see the same registry. */
const DESIGNS_KEY = Symbol.for("gentle-shell-bridge.message-designs.v1");

function designsHost(): Record<symbol, MessageDesignState | undefined> {
  // SAFETY: only `messageDesignState()` writes this key, and it re-checks the shape before trusting a
  // value left by another copy or by an older load.
  return globalThis as unknown as Record<symbol, MessageDesignState | undefined>;
}

function messageDesignState(): MessageDesignState {
  const host = designsHost();
  const existing = host[DESIGNS_KEY];
  if (existing !== undefined && Array.isArray(existing.entries)) {
    // A slot created by a copy that predates the counters gains them in place, so two copies agree.
    if (!Array.isArray(existing.conflicts)) existing.conflicts = [];
    if (!Array.isArray(existing.failures)) existing.failures = [];
    if (typeof existing.selectionReads !== "number") existing.selectionReads = 0;
    return existing;
  }
  const created: MessageDesignState = { entries: [], conflicts: [], failures: [], selectionReads: 0 };
  host[DESIGNS_KEY] = created;
  return created;
}

/**
 * Let the rows line install itself the moment a design exists (S4), and withdraw that request when
 * the bridge disarms. Passing `undefined` unsubscribes. The installer is the bridge's own, never a
 * plugin's, so it is never attributed and its failures are the bridge's own.
 */
export function setMessageDesignRowsInstaller(installer: (() => void) | undefined): void {
  messageDesignState().rowsInstaller = installer;
}

/** A value that cannot be read as text is still a value: the report must not throw on it. */
const UNPRINTABLE_THROWN_VALUE = "a value that cannot be read as text";

function errorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") return error.message;
  try {
    const text = String(error);
    return text === "" ? UNPRINTABLE_THROWN_VALUE : text;
  } catch {
    return UNPRINTABLE_THROWN_VALUE;
  }
}

function invalid(id: unknown, problem: string): Error {
  return new Error(
    `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: ${problem}. ` +
      "A message design is declared for ONE custom type (`customType`) or for a line of several " +
      "(`line` + `types`), and carries an `id`, a `label` and an `apply`.",
  );
}

/** One sentence a refusal can be quoted with, and the reason the report shows. */
function recordConflict(conflict: MessageDesignConflict): void {
  const state = messageDesignState();
  const duplicate = state.conflicts.find(
    (existing) =>
      existing.customType === conflict.customType &&
      existing.id === conflict.id &&
      existing.kind === conflict.kind,
  );
  if (duplicate !== undefined) {
    duplicate.message = conflict.message;
    return;
  }
  state.conflicts.push(conflict);
}

// ---------------------------------------------------------------------------------------------
// Validation: everything is checked BEFORE anything is stored, so a refusal never half-registers
// ---------------------------------------------------------------------------------------------

const RESERVED_LABELS = new Set([MESSAGE_DESIGN_DEFAULT_LABEL, MESSAGE_DESIGN_NATIVE]);

function assertLabel(id: string, label: unknown): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: label must be a ` +
        "non-empty string. It is the value a user reads on the line; the id stays internal.",
    );
  }
  if (RESERVED_LABELS.has(label.trim())) {
    throw new Error(
      `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: label ` +
        `${JSON.stringify(label)} is reserved. "default" is the bridge's own value and "native" is ` +
        "its identity; register a label of your own.",
    );
  }
}

function assertApply(id: string, apply: unknown): void {
  if (typeof apply !== "function") {
    throw new Error(
      `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: apply must be a function ` +
        "`(lines, ctx) => rows`. It is the whole point of the registration.",
    );
  }
}

/**
 * `follows`, when present, is exactly `{ line, id }`: both non-empty, and never the reserved `native`
 * as the id it waits for — `native` means "this line answers nothing", so a design following it could
 * never turn on and would be a switch the user cannot find anywhere.
 */
function assertFollow(id: unknown, follow: unknown): void {
  if (follow === null || typeof follow !== "object") {
    throw invalid(id, "`follows` must be an object `{ line, id }`");
  }
  const candidate = follow as { line?: unknown; id?: unknown };
  if (typeof candidate.line !== "string" || candidate.line.trim() === "") {
    throw invalid(id, "`follows.line` must be a non-empty tool-design line id");
  }
  if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
    throw invalid(id, "`follows.id` must be a non-empty tool design id");
  }
  if (candidate.id.trim() === MESSAGE_DESIGN_NATIVE) {
    throw invalid(
      id,
      `\`follows.id\` cannot be ${JSON.stringify(MESSAGE_DESIGN_NATIVE)}: that value means the tool ` +
        "line answers nothing, so the design could never turn on. Name the tool design that should " +
        "turn it on.",
    );
  }
}

function assertTypes(id: unknown, types: unknown): string[] {
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error(
      `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: types must be a non-empty ` +
        "array of custom types; a registration that claims no message paints nothing.",
    );
  }
  const seen = new Set<string>();
  for (const type of types) {
    if (typeof type !== "string" || type.trim() === "") {
      throw new Error(
        `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: every entry of types ` +
          "must be a non-empty custom type string.",
      );
    }
    if (seen.has(type)) {
      throw new Error(
        `gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: types repeats ` +
          `${JSON.stringify(type)}. List each type once.`,
      );
    }
    seen.add(type);
  }
  return [...seen];
}

interface Normalized {
  scope: MessageDesignScope;
  line: string;
  types: string[];
}

/** Exactly one shape: `customType`, or `line` + `types`. Never both, never neither. */
function normalizeRegistration(id: unknown, design: MessageDesignRegistration): Normalized {
  if (design === null || typeof design !== "object") {
    throw invalid(id, "the registration must be an object");
  }
  const hasType = design.customType !== undefined;
  const hasLine = design.line !== undefined || design.types !== undefined;
  if (hasType && hasLine) {
    throw invalid(id, "`customType` and (`line` + `types`) cannot be mixed");
  }
  if (!hasType && !hasLine) {
    throw invalid(id, "one of `customType` or (`line` + `types`) is required");
  }
  if (hasType) {
    const type = design.customType;
    if (typeof type !== "string" || type.trim() === "") {
      throw invalid(id, "`customType` must be a non-empty string");
    }
    return { scope: "type", line: type, types: [type] };
  }
  const line = design.line;
  if (typeof line !== "string" || line.trim() === "") {
    throw invalid(id, "`line` must be a non-empty string");
  }
  return { scope: "line", line, types: assertTypes(id, design.types) };
}

/**
 * A type belongs to ONE line. A claim from ANOTHER line — or from an ungrouped design — is refused
 * whole and reported, because two switches that could both paint one message would leave the user
 * with a choice that cannot be honoured.
 *
 * A design of the SAME line is not a competing claim: the designs of one line are the VALUES of its
 * one switch, so two of them may cover the same type. Selecting either answers for that type; the
 * other is simply not the current value.
 */
function assertTypesAreFree(
  scope: MessageDesignScope,
  line: string,
  id: string,
  types: readonly string[],
): void {
  for (const entry of messageDesignState().entries) {
    const sameLine = entry.scope === scope && entry.line === line;
    if (sameLine) continue;
    const shared = types.find((type) => entry.types.includes(type));
    if (shared === undefined) continue;
    const message =
      `message ${JSON.stringify(shared)} is already claimed by ` +
      `${entry.scope === "type" ? "its own line" : `line ${JSON.stringify(entry.line)}`} ` +
      `(${JSON.stringify(entry.design.id)}); a custom type belongs to ONE line.`;
    recordConflict({ customType: shared, id, kind: "type", message });
    throw new Error(`gentle-shell-bridge: invalid message design ${JSON.stringify(id)}: ${message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

function registerStored(design: MessageDesignRegistration): () => void {
  assertRegistrationId("message design", design.id);
  const { scope, line, types } = normalizeRegistration(design.id, design);
  assertLabel(design.id, design.label);
  assertApply(design.id, design.apply);
  if (design.follows !== undefined) assertFollow(design.id, design.follows);
  assertTypesAreFree(scope, line, design.id, types);

  const state = messageDesignState();
  const entry: DesignEntry = { scope, line, types, design };
  const existing = state.entries.findIndex(
    (candidate) =>
      candidate.scope === scope && candidate.line === line && candidate.design.id === design.id,
  );
  if (existing === -1) {
    state.entries.push(entry);
  } else {
    recordConflict({
      customType: types[0],
      id: design.id,
      kind: "replaced",
      message: `design ${JSON.stringify(design.id)} on ${scope === "type" ? "its own line" : `line ${JSON.stringify(line)}`} was replaced in place.`,
    });
    state.entries[existing] = entry;
  }

  // A design now exists, so the `Cards` line that shows it must exist too. Idempotent, and it runs
  // ONLY here: with no design the bridge registers no provider at all (S4).
  state.rowsInstaller?.();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = state.entries.indexOf(entry);
    if (index !== -1) state.entries.splice(index, 1);
  };
}

/**
 * Register one message design, or several as ONE all-or-nothing batch. Throws on an invalid
 * registration before storing anything, and returns a disposer that withdraws exactly what it added.
 */
export function registerMessageDesign(
  design: MessageDesignRegistration | readonly MessageDesignRegistration[],
): () => void {
  if (!Array.isArray(design)) {
    return attributeRegistration("message design", design, undefined, () =>
      registerStored(design as MessageDesignRegistration),
    );
  }
  const state = messageDesignState();
  const before = [...state.entries];
  const disposers: Array<() => void> = [];
  try {
    for (const one of design as readonly MessageDesignRegistration[]) {
      disposers.push(
        attributeRegistration("message design", one, undefined, () => registerStored(one)),
      );
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    // The batch is all-or-nothing, so the entries an earlier member added are withdrawn too.
    state.entries.length = 0;
    state.entries.push(...before);
    throw error;
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

// ---------------------------------------------------------------------------------------------
// The lines, as the menu and `/bridge-status` read them
// ---------------------------------------------------------------------------------------------

/**
 * Whether ANY live design exists. The conversation pass asks this before it looks at a child, so a
 * session with no message design reads no message at all (S4's cost bound, not only its output).
 */
export function hasMessageDesignClaims(): boolean {
  return messageDesignState().entries.length > 0;
}

/**
 * Whether a custom type is claimed by a live design right now. A registry walk with NO persistence
 * read, which is what lets a conversation pass skip unclaimed messages for free (S4).
 */
export function isMessageTypeClaimed(customType: string): boolean {
  return messageDesignState().entries.some((entry) => entry.types.includes(customType));
}

/** What a follow answers when no live tool-design line has its name. */
export const MESSAGE_DESIGN_FOLLOW_NONE = "none";

/**
 * What one follow answers RIGHT NOW (S1, 0.12.0): which tool-design line answered, what it answered,
 * and whether that is the id this design waits for.
 *
 * READ ONLY. It never writes the tool document and never needs a seed: the value the user already
 * picked on that line is the whole answer, and when there is no such line (a tool design that has not
 * registered yet, or was disposed) the answer is `found: false` rather than a throw.
 */
export function resolveMessageDesignFollow(
  follow: MessageDesignFollow,
): MessageDesignFollowAnswer {
  const line = toolDesignLines().find((candidate) => candidate.line === follow.line);
  if (line === undefined) {
    return {
      line: follow.line,
      found: false,
      answered: MESSAGE_DESIGN_FOLLOW_NONE,
      active: false,
    };
  }
  const answered = getToolDesignLineSelection(line.scope, line.line);
  return { line: follow.line, found: true, answered, active: answered === follow.id };
}

/** Every line that has designs, in creation order, with its type set and its designs in order. */
export function messageDesignLines(): MessageDesignLine[] {
  const lines: MessageDesignLine[] = [];
  for (const entry of messageDesignState().entries) {
    const existing = lines.find(
      (line) => line.scope === entry.scope && line.line === entry.line,
    );
    if (existing === undefined) {
      lines.push({
        scope: entry.scope,
        line: entry.line,
        types: [...entry.types],
        designs: [entry.design],
      });
      continue;
    }
    for (const type of entry.types) {
      if (!existing.types.includes(type)) existing.types.push(type);
    }
    existing.designs.push(entry.design);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The selection: one persisted value per line
// ---------------------------------------------------------------------------------------------

interface SelectionState {
  /** The ungrouped selections: custom type -> design id. */
  types: Record<string, unknown>;
  /** The named lines, under the reserved key in the same document. */
  lines: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The persisted selections, read live. An unreadable or malformed file reads as empty, so a hand-edited
 * file can never select a design the user did not choose. ONE logical read of the bridge's store per
 * call, which is what the cost bound counts (S4).
 */
function readSelections(): SelectionState {
  messageDesignState().selectionReads += 1;
  const stored = asRecord(
    createStore(MESSAGE_DESIGN_STORE_ID).get<unknown>(MESSAGE_DESIGN_STORE_KEY, {}),
  );
  const { [MESSAGE_DESIGN_LINE_STORE_KEY]: lines, ...types } = stored;
  return { types, lines: asRecord(lines) };
}

/** The reserved key is written ONLY when a line has a value, so a session with none keeps its document. */
function writeSelections(state: SelectionState): void {
  const document: Record<string, unknown> = { ...state.types };
  if (Object.keys(state.lines).length > 0) {
    document[MESSAGE_DESIGN_LINE_STORE_KEY] = state.lines;
  }
  createStore(MESSAGE_DESIGN_STORE_ID).set(MESSAGE_DESIGN_STORE_KEY, document);
}

/** A stored value that is not a usable id reads as `native`, never as a design nobody registered. */
function storedId(map: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(map, key)) return MESSAGE_DESIGN_NATIVE;
  const stored = map[key];
  return typeof stored === "string" && stored.trim() !== "" ? stored : MESSAGE_DESIGN_NATIVE;
}

/** The design id stored for one custom type, or `native` when it has none. */
export function getMessageDesignSelection(customType: string): string {
  return storedId(readSelections().types, customType);
}

/** The design id stored for one line, or `native` when it has none. */
export function getMessageDesignLineSelection(scope: MessageDesignScope, line: string): string {
  const selections = readSelections();
  return storedId(scope === "type" ? selections.types : selections.lines, line);
}

/**
 * Persist one line's selection, FIRST and synchronously: the host re-reads `current()` when it repaints,
 * so the bullet cannot land on a value that was never written.
 */
export function setMessageDesignLineSelection(
  scope: MessageDesignScope,
  line: string,
  id: string,
): void {
  const selections = readSelections();
  if (scope === "type") {
    writeSelections({ types: { ...selections.types, [line]: id }, lines: selections.lines });
    return;
  }
  writeSelections({ types: selections.types, lines: { ...selections.lines, [line]: id } });
}

/** Persist one custom type's (ungrouped) selection. */
export function setMessageDesignSelection(customType: string, id: string): void {
  setMessageDesignLineSelection("type", customType, id);
}

/**
 * Resolve one custom type's design against the live registry. Never throws.
 *
 * With no live claim on the type the answer is `native` — the host's own output, untouched. A stored
 * value that names no live design of its line is `missing` (a disposed design, which the wiring draws
 * as the host's own output and reports), and a line whose selected design does not list THIS type is
 * `not-covered`, so a grouped line never silently paints a message it never claimed.
 */
export function resolveMessageDesignSelection(customType: string): MessageDesignSelection {
  const state = messageDesignState();
  const claim = state.entries.find((entry) => entry.types.includes(customType));
  if (claim === undefined) {
    // No live claim on the type. A value still stored for it names a design that was disposed, and
    // saying so is what lets the wiring draw the host's own output and REPORT it instead of quietly
    // reading as the host's default (S4). This is the one path that must open the document.
    const orphan = storedId(readSelections().types, customType);
    return orphan === MESSAGE_DESIGN_NATIVE ? { kind: "native" } : { kind: "missing", id: orphan };
  }
  const lineEntries = state.entries.filter(
    (entry) => entry.scope === claim.scope && entry.line === claim.line,
  );
  // A design that FOLLOWS a tool switch is decided by that switch and by nothing else (S1). It is
  // answered FIRST, before the message document is even opened, because no stored value there may
  // veto it — a stale id left by a design that is gone must not turn off a design whose switch is on.
  // The first active follow in registration order wins, the same rule the line's own values follow.
  const activeFollow = lineEntries.find(
    (entry) =>
      entry.types.includes(customType) &&
      entry.design.follows !== undefined &&
      resolveMessageDesignFollow(entry.design.follows).active,
  )?.design;
  if (activeFollow !== undefined) return { kind: "design", design: activeFollow };

  // Nothing but follows claims this type, and none of them is on: the host's own output, and the
  // message document is never opened. That is what keeps a claimed-but-inactive alert free (S4).
  const ownEntries = lineEntries.filter(
    (entry) => entry.types.includes(customType) && entry.design.follows === undefined,
  );
  if (ownEntries.length === 0) return { kind: "native" };

  // From here a value the user really chose on the message's own line decides. ONE snapshot serves
  // the rest of the resolve: one logical store read per call.
  const selections = readSelections();
  const stored = storedId(
    claim.scope === "type" ? selections.types : selections.lines,
    claim.line,
  );
  if (stored === MESSAGE_DESIGN_NATIVE) return { kind: "native" };
  // The stored value names a design of THIS line, whether or not it lists this type: a line that
  // covers several types must answer `not-covered` rather than quietly painting a message it never
  // claimed, and a value that names nothing live is `missing`.
  const chosen = lineEntries.find(
    (entry) => entry.design.id === stored && entry.design.follows === undefined,
  );
  if (chosen === undefined) return { kind: "missing", id: stored };
  if (!chosen.types.includes(customType)) return { kind: "not-covered", id: stored };
  return { kind: "design", design: chosen.design };
}

// ---------------------------------------------------------------------------------------------
// Applying a design
// ---------------------------------------------------------------------------------------------

/**
 * Hand one pass's rows to a design and take back the rows to draw. `undefined` means "draw what was
 * passed in": a design that throws, or that answers something which is not an array of strings, loses
 * its own output only — the host's rows stay on screen and the failure is reported (S5).
 */
export function applyMessageDesign(
  design: MessageDesignRegistration,
  lines: readonly string[],
  ctx: MessageDesignContext,
): string[] | undefined {
  let applied: unknown;
  try {
    applied = design.apply([...lines], ctx);
  } catch (error) {
    recordMessageDesignFailure(ctx.customType, design.id, errorMessage(error));
    return undefined;
  }
  // Read by INDEX, never through the value's own methods: `every` skips a sparse array's holes (so
  // `Array(3)` would pass and Pi would be handed `undefined` rows) and a plugin's own `every` is a
  // function this module must not call at all — calling it threw into Pi's render loop.
  if (!Array.isArray(applied) || !rowsAreStrings(applied)) {
    recordMessageDesignFailure(
      ctx.customType,
      design.id,
      "apply returned something that is not an array of strings; the host's own output is drawn " +
        "instead. Return the rows to draw, e.g. `return lines`.",
    );
    return undefined;
  }
  // A CLEAN copy, built here: nothing the plugin attached to the array travels into Pi's frame, and
  // a plugin that later mutates the array it returned cannot change what was already drawn.
  const rows: string[] = [];
  for (let index = 0; index < applied.length; index += 1) rows.push(applied[index] as string);
  return rows;
}

/**
 * Whether every position of this array holds a string, read BY INDEX and never through the value's own
 * members. A `for` over the length, so a sparse array is refused instead of silently handing Pi
 * `undefined` rows, and nothing here calls a method the plugin could have replaced.
 *
 * What a plugin hangs off the array itself is deliberately ignored rather than refused: a value whose
 * `every` was replaced is still a row array if its positions are rows, and because the accepted rows
 * are copied out by index (`applyMessageDesign`), no such member can ever travel into Pi's frame.
 * Refusing it would drop a design's output over a property nobody reads.
 */
function rowsAreStrings(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

/** Record one design that failed to paint, once per (type, id, message). Read by `/bridge-status`. */
export function recordMessageDesignFailure(
  customType: string,
  designId: string,
  message: string,
): void {
  const state = messageDesignState();
  const duplicate = state.failures.some(
    (failure) =>
      failure.customType === customType &&
      failure.designId === designId &&
      failure.message === message,
  );
  if (duplicate) return;
  state.failures.push({ customType, designId, message });
  if (state.failures.length > MAX_FAILURES) {
    state.failures.splice(0, state.failures.length - MAX_FAILURES);
  }
}

/** The failures the last passes recorded, oldest first. */
export function getMessageDesignFailures(): MessageDesignFailure[] {
  return messageDesignState().failures.map((failure) => ({ ...failure }));
}

/** The replacements and collisions the registry recorded, oldest first. */
export function getMessageDesignConflicts(): MessageDesignConflict[] {
  return messageDesignState().conflicts.map((conflict) => ({ ...conflict }));
}

/** How many persisted-selection reads happened since the last reset (S4's cost bound). */
export function getMessageDesignSelectionReads(): number {
  return messageDesignState().selectionReads;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetMessageDesignSelectionReads(): void {
  messageDesignState().selectionReads = 0;
}

/** Test-only seam: empties the registry, the conflicts and the failures in place. */
export function resetMessageDesignsForTests(): void {
  const state = messageDesignState();
  state.entries.length = 0;
  state.conflicts.length = 0;
  state.failures.length = 0;
  state.selectionReads = 0;
}

/**
 * The error text for a stored value the wiring cannot use, kept here so the message and the record live
 * together.
 */
export function messageDesignErrorMessage(error: unknown): string {
  return errorMessage(error);
}

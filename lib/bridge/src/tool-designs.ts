/**
 * The DESIGN bus (S1–S9): designs per tool, joined into LINES, one process-global slot.
 *
 * ## Why the bus, and not each plugin
 *
 * Pi has exactly one sanctioned way to choose how a tool's card is drawn:
 * `pi.registerToolRenderer(resolver)` (`docs/extensions.md:2123`;
 * `dist/core/extensions/types.d.ts:546`). Resolvers COMPOSE — Pi chains every extension's resolver
 * (`dist/core/extensions/runner.js:550-553`) — so two plugins that each called it would each wrap the
 * other's component, and neither could see the other's choice.
 *
 * So the BRIDGE registers the resolver (`./tool-design-wiring.ts`), once, and fans it out to the
 * designs plugins contributed here. Two plugins contributing a design for the same line do not
 * collide: they are two VALUES of that line, and they only conflict when they claim the same identity
 * (`line` + `id`) or the same visible label — which is reported, never silently replaced.
 *
 * ## Two registration shapes, one line each
 *
 * - `{ tool, id, label, apply }` is UNGROUPED. It gets an implicit line keyed by the tool name
 *   (`Card bash`), exactly as it did before lines existed (S4).
 * - `{ line, tools, id, label, apply }` is GROUPED. It joins the line named `line`; several
 *   registrations naming the same line produce ONE customize line (`Card tools`) and that line's
 *   tool set is the union of their `tools` (S2, S3).
 *
 * A tool belongs to at most ONE line (S5/D1) — unless a line narrows its claim on that tool with a
 * SCOPE (S7–S10, S19). A claim is a (line, tool) pair: a registration WITHOUT a scope for a tool
 * claims every call of it, so a second UNSCOPED claim of that tool — or a legacy `Card <tool>`
 * registration on a tool that already has one — is refused whole and recorded. A SCOPED claim owns
 * only the calls its scope's `matches` answers true for: any number of scoped claims may name one
 * tool beside the one unscoped claim, and the resolver decides per call which of them paints it. A
 * scope goes on the GROUPED shape only: an ungrouped registration IS the tool's own `Card <tool>`
 * line, which means every call of that tool, so `{ tool, scope, … }` is refused whole (L6/S7).
 *
 * The scope belongs to the CLAIM, not to the line (S19): one line may own some of its tools
 * unconditionally and narrow others (`Card tools`: bash/grep/find/ls/read for every call, write/edit
 * only under `skills/` or `odd/`), while another line carries the generic claim on the same tools.
 * `scopes` maps a tool to its scope, and `scope` is the shorthand for the same object on every tool.
 * Nothing here is bash-specific: a design is declared for a tool NAME, and the registry is keyed by
 * that name.
 *
 * ## The selection
 *
 * One persisted value per line in the bridge's own store file (`bridge-tool-designs`, never the
 * host's config): grouped lines live under `lines` (`{ "tools": "<id>" }`), ungrouped ones keep the
 * historical per-tool `selections` map (`{ "bash": "<id>" }`), untouched. The stored value is a design
 * ID — identity, so renaming a label never loses a user's choice — and `native` means "the host's own
 * card", the documented degrade when a selected design is disposed (`missing`) or does not cover a
 * tool of the line (`not-covered`, S6/D4).
 *
 * Migration (D3) happens ONCE, at REGISTRATION time, never in the render path: a tool joining a line
 * that has no stored value lends that line its legacy per-tool value when that value names a design of
 * the line, and the line value is written then.
 *
 * This module is internal: `src/index.ts` re-exports `registerToolDesign`,
 * `resolveToolDesignSelection` and the public types those signatures carry, never this file's
 * diagnostics (`toolDesignClaims`, the index) or its `reset…ForTests` seam.
 */

import { assertRegistrationId } from "./bus.ts";
import { attributeRegistration } from "./plugin-lines.ts";
import { isRecord } from "./rows.ts";
import { createStore } from "./store.ts";
import type { ToolDesignContext, ToolDesignRegistration, ToolDesignScope } from "./types.ts";

/**
 * The STORED value meaning "no design: the host draws the card", shared by every line. It is
 * identity, so it never changes: a user's saved choice keeps working whatever the line shows.
 */
export const TOOL_DESIGN_NATIVE = "native";

/**
 * What a line SHOWS for the host's own card. Display only: the stored value stays
 * `TOOL_DESIGN_NATIVE`. A design may not take this word (or `native`) as its label.
 */
export const TOOL_DESIGN_DEFAULT_LABEL = "default";

/**
 * The bridge's own plugin id for the selection file. One namespaced file holds every line's value,
 * so a selection never lands in the host's `visual-customization.json`.
 */
export const TOOL_DESIGN_STORE_ID = "bridge-tool-designs";

/** The historical per-tool key: `{ "bash": "loon.bash-heading" }`. Untouched by lines (D3). */
export const TOOL_DESIGN_STORE_KEY = "selections";

/**
 * The reserved key INSIDE the `selections` value that holds the per-line map, so one tool's selection
 * and one line's selection are the same document and one `get` serves both (S9/D6: one store read per
 * card per frame). A tool name can never be `$lines`, so it cannot shadow a line.
 */
export const TOOL_DESIGN_LINE_STORE_KEY = "$lines";

/** Why a registration did not become the live one: it replaced one, or it was refused. */
export type ToolDesignConflictKind = "replaced" | "label" | "line" | "scope";

/** One registration that replaced another, or was refused, kept for `/bridge-status`. */
export interface ToolDesignConflict {
  /** The tool of an ungrouped design, or the line a grouped one belongs to. */
  tool: string;
  id: string;
  kind: ToolDesignConflictKind;
  /** What happened, as a person reads it. */
  message: string;
}

/** One design that failed while the host's card was drawn; deduplicated by (tool, id, message). */
export interface ToolDesignFailure {
  tool: string;
  designId: string;
  message: string;
}

/** How many failures are kept for `/bridge-status`; a design that throws every frame is one fact. */
const MAX_FAILURES = 8;

/** How far `drainThenable` follows the values `then` returns before it stops (S18). */
const THENABLE_DRAIN_DEPTH = 4;

/** One live registration, normalized: its line, the tools it paints, and the plugin's design. */
interface DesignEntry {
  /** `tool` for an ungrouped implicit line, `line` for a grouped one. */
  scope: "tool" | "line";
  /** The selection key within its scope: the tool name or the registered line id. */
  line: string;
  /** The tools THIS design paints, in registration order, deduplicated. */
  tools: string[];
  design: ToolDesignRegistration;
}

/** One customize line, as the resolver, the rows and `/bridge-status` read it. */
export interface ToolDesignLine {
  scope: "tool" | "line";
  /** The store key within its scope: the tool name or the registered line id. */
  line: string;
  /** Every tool this line paints, in first-registration order. */
  tools: string[];
  /** Every design of the line, in registration order. */
  designs: ToolDesignRegistration[];
  /**
   * The scope of each TOOL this line claims that has one (S19), one entry per DISTINCT scope object
   * in tool order: the menu shows it inside the same preview row and `/bridge-status` reads it per
   * claim. Empty when every claim of the line is unscoped, which is the historical meaning.
   */
  scopedClaims: Array<{ tools: string[]; scope: ToolDesignScope }>;
}

interface IndexedLine {
  scope: "tool" | "line";
  line: string;
  tools: string[];
  entries: DesignEntry[];
}

/**
 * One (line, tool) CLAIM: the line that makes it, the scope of THAT tool (S19) and the live entry
 * that declares the scope, so a throwing or non-boolean answer can be reported against its design.
 * The unit of `claimsByTool`, precedence and resolution — never a whole line.
 */
interface IndexedClaim {
  line: IndexedLine;
  /** `design.scopes[tool]`, else the `scope` shorthand, else `undefined` (EVERY call of the tool). */
  scope?: ToolDesignScope;
  /** The live entry that declares the scope, for the failure record (a scope belongs to a design). */
  entry: DesignEntry;
}

interface ToolDesignIndex {
  /**
   * The SHAPE this index was built with (`TOOL_DESIGN_INDEX_SHAPE`). Two copies of the bridge can
   * share this process-global slot — a plugin pinned to an older release and the host on this one —
   * and the older copy leaves an index built from fields this one does not read. The stamp is what
   * lets a cached index be DROPPED instead of trusted (S18).
   */
  shape: number;
  revision: number;
  /** tool → the one line that owns it (S5/D1), by the first entry that names the tool. */
  owner: Map<string, { scope: "tool" | "line"; line: string }>;
  /**
   * Lines in DISPLAY order: the first LIVE entry of a line fixes its place, exactly as the Cards rows
   * and the `/bridge-status` block ordered themselves before claim precedence existed (S2/S13/S14).
   * PRECEDENCE is a different order and lives only in `claimsByTool` (S10).
   */
  lines: IndexedLine[];
  byKey: Map<string, IndexedLine>;
  /** tool → its designs, in registration order: the ONE lookup every render path uses (T1). */
  designsByTool: Map<string, ToolDesignRegistration[]>;
  /**
   * tool → every (line, tool) CLAIM on it, in PRECEDENCE order (`ToolDesignState.lineOrder`, the line
   * creation order that survives the disposal of one of its values — S10): the scoped claims and the
   * ONE unscoped claim (S9/S19), each with the scope of THAT tool. The resolver walks this list per
   * call; `/bridge-status` lists it for a tool with scoped claims. Never a display order: see
   * `lines`.
   */
  claimsByTool: Map<string, IndexedClaim[]>;
}

interface ToolDesignState {
  /** Every live registration, in registration order; one entry per (`scope`, `line`, `id`). */
  entries: DesignEntry[];
  /**
   * The creation order of every live line, keyed by `lineKey`: the order a line keeps for as long as
   * any value of it is live (S10). Disposing ONE value of a line must not move the line, because a
   * line never stopped claiming its tools; precedence between two claims therefore never depends on
   * which registrations happen to survive. It lives in the STATE and not in the derived index, so it
   * is stable across index rebuilds and identical for every copy sharing this slot.
   */
  lineOrder: Map<string, number>;
  /** The order the NEXT line to appear receives. Monotonic: an order is never reused. */
  lineOrderSeq: number;
  conflicts: ToolDesignConflict[];
  failures: ToolDesignFailure[];
  /**
   * How many times the persisted selections were READ since the last reset. One read is exactly one
   * logical read of the bridge's store, so this counts the file work a render pass performs.
   */
  selectionReads: number;
  /** Bumped by every registry mutation; the in-memory index is rebuilt only when it changes (D6). */
  revision: number;
  /** The derived maps, valid only for `revision`. Never persisted. */
  index?: ToolDesignIndex;
}

/** Stable process-global slot, like the bus and the store: two copies must agree. */
const DESIGNS_KEY = Symbol.for("gentle-shell-bridge.tool-designs.v1");

/**
 * The shape of the derived index: bumped whenever `ToolDesignIndex` gains, loses or renames a field
 * OR the meaning of one of them changes. The index is DERIVED and never persisted, so an index of
 * another shape is always safe to drop and rebuild — which is exactly what a slot warmed by another
 * copy of the bridge requires (S18). Shape 4 split the two orders shape 3 had collapsed: `lines` is
 * DISPLAY order (the first live entry, S2) and only `claimsByTool` is claim PRECEDENCE (`lineOrder`,
 * S10). An index of shape 3 ordered `lines` by precedence too, so it must be dropped, not read.
 *
 * Shape 5 is the per-(line, tool) claim (S19): `claimsByTool` maps a tool to CLAIMS carrying that
 * tool's own scope, where shape 4 mapped it to LINES carrying one scope for the whole line. An index
 * of shape 4 would make a mixed line (some tools scoped, others not) answer with the wrong scope for
 * some of its tools, so it is dropped and rebuilt — which keeps a slot warmed by the previous copy
 * readable (S18), including the state that copy left behind.
 */
const TOOL_DESIGN_INDEX_SHAPE = 5;

/** Is this a cached index THIS copy can read? A slot written by an older copy answers no (S18). */
function isCurrentIndexShape(index: unknown): index is ToolDesignIndex {
  return isRecord(index) && index.shape === TOOL_DESIGN_INDEX_SHAPE;
}

function designsHost(): Record<symbol, ToolDesignState | undefined> {
  // SAFETY: only `designState()` writes this key, and it re-checks every list before trusting a
  // value left behind by another copy or an older load.
  return globalThis as unknown as Record<symbol, ToolDesignState | undefined>;
}

function designState(): ToolDesignState {
  const host = designsHost();
  const existing = host[DESIGNS_KEY];
  if (existing !== undefined && Array.isArray(existing.entries)) {
    // A slot created by a copy that predates the diagnostics keeps its live registrations and gains
    // the lists in place, so two copies always see one registry.
    if (!Array.isArray(existing.conflicts)) existing.conflicts = [];
    if (!Array.isArray(existing.failures)) existing.failures = [];
    if (typeof existing.selectionReads !== "number") existing.selectionReads = 0;
    if (typeof existing.revision !== "number") {
      existing.revision = 0;
      delete existing.index;
    }
    // The derived maps are valid only for THIS copy's shape and revision. An index left by a copy
    // that predates the claim map (S18) is dropped here, so no read site below can reach a field
    // that copy never wrote; the next read rebuilds it from the entries that survived.
    if (!isCurrentIndexShape(existing.index)) delete existing.index;
    // A slot created by a copy that predates the line order gains it here, exactly like the lists
    // above: the entries it already holds are the only evidence of which line appeared first, so the
    // next rebuild assigns each of them an order in that order.
    if (!(existing.lineOrder instanceof Map)) existing.lineOrder = new Map<string, number>();
    if (typeof existing.lineOrderSeq !== "number") existing.lineOrderSeq = existing.lineOrder.size;
    // A slot created before grouped lines has `{ tool, design }` entries: normalize them in place.
    for (const raw of existing.entries as unknown[]) {
      if (!isRecord(raw) || !isRecord(raw.design)) continue;
      if (typeof raw.scope === "string" && typeof raw.line === "string" && Array.isArray(raw.tools)) {
        continue;
      }
      const tool = typeof raw.tool === "string" ? raw.tool : raw.design.tool;
      if (typeof tool !== "string") continue;
      raw.scope = "tool";
      raw.line = tool;
      raw.tools = [tool];
    }
    return existing;
  }
  const created: ToolDesignState = {
    entries: [],
    lineOrder: new Map<string, number>(),
    lineOrderSeq: 0,
    conflicts: [],
    failures: [],
    selectionReads: 0,
    revision: 0,
  };
  host[DESIGNS_KEY] = created;
  return created;
}

/** What `/bridge-status` says about a thrown value that cannot be read as text at all (S18). */
const UNPRINTABLE_THROWN_VALUE = "a value that cannot be read as text";

/**
 * Text for a thrown value, whatever a plugin threw at us. It NEVER throws (S18): a paint is not a
 * place to fail, and the failure record is built from this string, so `String(...)` on a value whose
 * prototype is null (or whose `toString` explodes) would escape as `Cannot convert object to
 * primitive value` out of the published resolver. Every reading is isolated, and a fixed text stands
 * in when even the object tag cannot be read. Shared with `applyToolDesign`, so a design's throw takes
 * the same path.
 */
function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message;
  } catch {
    // A hostile prototype chain (`instanceof` walks it) or a throwing `message` getter: try the
    // generic readings below instead of giving up on the report.
  }
  try {
    return String(error);
  } catch {
    // `String` needs a primitive out of the value: a null prototype, a throwing `toString`/`valueOf`
    // or an object-returning pair all end here.
  }
  try {
    return Object.prototype.toString.call(error);
  } catch {
    // Even the tag is unreadable (a Proxy whose trap throws). The caller still gets text.
  }
  return UNPRINTABLE_THROWN_VALUE;
}

function lineKey(scope: "tool" | "line", line: string): string {
  return `${scope}\u0000${line}`;
}

/** Every registry mutation bumps this and drops the derived maps; the next read rebuilds once. */
function bumpRevision(state: ToolDesignState): void {
  state.revision += 1;
  delete state.index;
}

function toolDesignIndex(state: ToolDesignState): ToolDesignIndex {
  const cached = state.index;
  if (cached !== undefined) {
    // A cached index is trusted only when it was built by THIS copy, for THIS revision. Another copy
    // of the bridge can write the same slot between two calls, so the shape is checked HERE and not
    // only in the repair: dropping a derived value is always safe (S18).
    if (isCurrentIndexShape(cached) && cached.revision === state.revision) return cached;
    delete state.index;
  }
  const byKey = new Map<string, IndexedLine>();
  /**
   * DISPLAY order, built by walking the ENTRIES: the first LIVE entry of a line fixes its place
   * (S2/S13/S14). Disposing one value of a line, while another survives, therefore leaves the Cards
   * rows and the `/bridge-status` block in the order the previous release drew them.
   */
  const lines: IndexedLine[] = [];
  const designsByTool = new Map<string, ToolDesignRegistration[]>();
  const owner = new Map<string, { scope: "tool" | "line"; line: string }>();
  for (const entry of state.entries) {
    const key = lineKey(entry.scope, entry.line);
    let line = byKey.get(key);
    if (line === undefined) {
      line = { scope: entry.scope, line: entry.line, tools: [], entries: [] };
      byKey.set(key, line);
      lines.push(line);
      // The order a line receives when it FIRST appears, kept until its last value is gone (S10).
      if (!state.lineOrder.has(key)) {
        state.lineOrder.set(key, state.lineOrderSeq);
        state.lineOrderSeq += 1;
      }
    }
    line.entries.push(entry);
    for (const tool of entry.tools) {
      if (!line.tools.includes(tool)) line.tools.push(tool);
      if (!owner.has(tool)) owner.set(tool, { scope: entry.scope, line: entry.line });
      const designs = designsByTool.get(tool);
      if (designs === undefined) designsByTool.set(tool, [entry.design]);
      else designs.push(entry.design);
    }
  }
  // A line with NO live entry left is gone: its order is dropped, so a line that comes back is a new
  // line that takes its place at the end instead of inheriting a claim it stopped making.
  for (const key of [...state.lineOrder.keys()]) if (!byKey.has(key)) state.lineOrder.delete(key);
  const orderOf = (line: IndexedLine): number =>
    state.lineOrder.get(lineKey(line.scope, line.line)) ?? Number.MAX_SAFE_INTEGER;
  // CLAIM PRECEDENCE, a DIFFERENT order from the display one above (S10): line creation order, which
  // survives the disposal of a value the line owns. `claimsByTool` is the only list built from it, so
  // collapsing the two orders — which is what the previous fix did — cannot move a row or a status
  // entry again.
  const claimsByTool = new Map<string, IndexedClaim[]>();
  const byPrecedence = [...lines].sort((left, right) => orderOf(left) - orderOf(right));
  for (const line of byPrecedence) {
    for (const tool of line.tools) {
      // One claim per (line, tool): the scope of THAT tool (S19), never the line's first scope.
      const claim: IndexedClaim = {
        line,
        ...claimOfLine(line, tool),
      };
      const claims = claimsByTool.get(tool);
      if (claims === undefined) claimsByTool.set(tool, [claim]);
      else claims.push(claim);
    }
  }
  const built: ToolDesignIndex = {
    shape: TOOL_DESIGN_INDEX_SHAPE,
    revision: state.revision,
    owner,
    lines,
    byKey,
    designsByTool,
    claimsByTool,
  };
  state.index = built;
  return built;
}

/** Every design of one tool, or every design when `tool` is omitted, in registration order. */
export function designsOfTool(tool: string): ToolDesignRegistration[] {
  return [...(toolDesignIndex(designState()).designsByTool.get(tool) ?? [])];
}

/**
 * Every design of one tool, or of every tool when `tool` is omitted, in registration order. The array
 * is a fresh copy, so a fan-out that iterates it sees a stable list even if a design registers or
 * disposes mid-iteration. It is the ONE lookup the resolver, adoption, the rows and status share (T1).
 */
export function snapshotToolDesigns(tool?: string): ToolDesignRegistration[] {
  if (tool !== undefined) return designsOfTool(tool);
  return designState().entries.map((entry) => entry.design);
}

/**
 * The scope of ONE tool's claim on one line (S19): `scopes[tool]`, else the `scope` shorthand, else
 * `undefined` — the claim every call of that tool, which is the historical meaning.
 */
function scopeOfClaim(design: ToolDesignRegistration, tool: string): ToolDesignScope | undefined {
  // SAFETY: the member is typed, but a plugin is plain JavaScript and another copy of the bridge may
  // share this slot, so every reading is re-checked instead of trusted.
  //
  // This is the ONLY read of the claim, and it sees exactly the own keys `scopesProblem` validates
  // (`Reflect.ownKeys`, S19/L14): a key no validation saw can never be read, so a key that is not
  // enumerable is validated before it can reach the registry.
  const scopes: unknown = design.scopes;
  if (isRecord(scopes) && Object.hasOwn(scopes, tool)) {
    const scope = scopes[tool];
    // SAFETY: `isRecord` proved a non-null, non-array object; the members themselves were validated
    // when the registration entered THIS copy, and a value a foreign copy left is re-checked here by
    // the consumers (`scopeProblem` on registration, the isolated `matches` call on resolution).
    return isRecord(scope) ? (scope as unknown as ToolDesignScope) : undefined;
  }
  return design.scope;
}

/** The live entry of one line that claims one tool, and the scope of ITS claim on it (S19/S8). */
function claimOfLine(line: IndexedLine, tool: string): { scope?: ToolDesignScope; entry: DesignEntry } {
  const entry = line.entries.find((candidate) => candidate.tools.includes(tool));
  if (entry === undefined) {
    // SAFETY: every tool of `line.tools` came from an entry that names it, so the search above always
    // finds one; this branch only keeps the compiler honest about the empty case.
    return { entry: line.entries[0] as DesignEntry };
  }
  return { scope: scopeOfClaim(entry.design, tool), entry };
}

/** The scope of one LINE's claim on one tool (S19), or `undefined` when that claim is unscoped. */
function scopeOf(line: IndexedLine, tool: string): ToolDesignScope | undefined {
  return claimOfLine(line, tool).scope;
}

/**
 * One line's SCOPED claims, grouped by scope OBJECT in tool order (S19): the menu prints one
 * ` — scope: <tool[, tool]>: <description>` per group, and a single group prints today's text.
 */
function scopedClaimsOf(line: IndexedLine): Array<{ tools: string[]; scope: ToolDesignScope }> {
  const groups: Array<{ tools: string[]; scope: ToolDesignScope }> = [];
  for (const tool of line.tools) {
    const scope = scopeOf(line, tool);
    if (scope === undefined) continue;
    const group = groups.find((candidate) => candidate.scope === scope);
    if (group === undefined) groups.push({ tools: [tool], scope });
    else group.tools.push(tool);
  }
  return groups;
}

/**
 * The live lines in DISPLAY order — the first LIVE entry of a line orders it, as the Cards rows and
 * `/bridge-status` always ordered themselves (S2/S13) — each with its tools and designs in
 * registration order. Claim precedence is a separate order and is read through `toolDesignClaims`.
 */
export function toolDesignLines(): ToolDesignLine[] {
  return toolDesignIndex(designState()).lines.map((line) => ({
    scope: line.scope,
    line: line.line,
    tools: [...line.tools],
    designs: line.entries.map((entry) => entry.design),
    scopedClaims: scopedClaimsOf(line),
  }));
}

/** The line that owns one tool, or `undefined` when no design covers it. */
export function lineOfTool(tool: string): { scope: "tool" | "line"; line: string } | undefined {
  const owner = toolDesignIndex(designState()).owner.get(tool);
  return owner === undefined ? undefined : { ...owner };
}

/** The tool names that have at least one design, in line DISPLAY order and tool-registration order. */
export function toolNamesWithDesigns(): string[] {
  const names: string[] = [];
  for (const line of toolDesignIndex(designState()).lines) {
    for (const tool of line.tools) if (!names.includes(tool)) names.push(tool);
  }
  return names;
}

function assertLabel(subject: string, id: string, label: unknown): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(id)} for ${subject}: label must be ` +
        "a non-empty string. It is the value the user reads on the customize line, so keep it short.",
    );
  }
  if (label === TOOL_DESIGN_NATIVE || label === TOOL_DESIGN_DEFAULT_LABEL) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design label ${JSON.stringify(label)} for ` +
        `${JSON.stringify(id)}: it is the reserved value meaning "the host's own card", so the line ` +
        `would show ${JSON.stringify(label)} twice. Pick a distinct label.`,
    );
  }
}

function assertApplyFunction(subject: string, id: string, apply: unknown): void {
  if (typeof apply !== "function") {
    throw new Error(
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(id)} for ${subject}: apply must be ` +
        "a function of (lines, ctx) that returns the lines to draw. A design rewrites the rows the " +
        "host's card produced; the bridge hands a copy, isolates its throw and reports it in " +
        "/bridge-status (S5).",
    );
  }
}

/** One registration's normalized line, tools and identity. */
interface NormalizedRegistration {
  scope: "tool" | "line";
  line: string;
  tools: string[];
}

/**
 * Exactly one of `tool` / (`line` + `tools`) is required (S2). Mixing them, an empty tool set, a
 * duplicate tool or an invalid name is refused before anything is stored.
 */
function normalizeRegistration(design: ToolDesignRegistration): NormalizedRegistration {
  if (!isRecord(design)) {
    throw new Error(
      "gentle-shell-bridge: invalid tool design: a registration must be an object with exactly one " +
        "of `tool` / (`line` + `tools`), plus `id`, `label` and `apply`.",
    );
  }
  const hasTool = design.tool !== undefined;
  const hasLine = design.line !== undefined;
  const hasTools = design.tools !== undefined;
  const tool = design.tool;
  if (hasTool && (hasLine || hasTools)) {
    throw new Error(
      "gentle-shell-bridge: invalid tool design: `tool` cannot be combined with `line` or `tools`. " +
        "Use `{ tool, id, label, apply }` for one tool, or `{ line, tools, id, label, apply }` for " +
        "one line over several tools.",
    );
  }
  if (!hasTool && !(hasLine && hasTools)) {
    throw new Error(
      "gentle-shell-bridge: invalid tool design: exactly one of `tool` / (`line` + `tools`) is " +
        "required. `{ tool, … }` gives the tool its own line; `{ line, tools, … }` paints several " +
        "tools from one line.",
    );
  }
  if (hasTool) {
    assertRegistrationId("tool name", tool);
    if (typeof tool !== "string") {
      // `assertRegistrationId` narrows by throwing; this keeps the compiler honest.
      throw new Error("gentle-shell-bridge: invalid tool name");
    }
    return { scope: "tool", line: tool, tools: [tool] };
  }
  const line = design.line;
  assertRegistrationId("tool design line", line);
  if (typeof line !== "string") {
    throw new Error("gentle-shell-bridge: invalid tool design line");
  }
  if (!Array.isArray(design.tools) || design.tools.length === 0) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design for line ${JSON.stringify(line)}: tools must be a ` +
        "non-empty array of tool names.",
    );
  }
  const tools: string[] = [];
  for (const value of design.tools) {
    assertRegistrationId("tool name", value);
    if (typeof value === "string") tools.push(value);
  }
  if (new Set(tools).size !== tools.length) {
    throw new Error(
      `gentle-shell-bridge: invalid tool design for line ${JSON.stringify(line)}: tools must be ` +
        "deduplicated. List each tool once; the line's tool set is the union of its designs.",
    );
  }
  return { scope: "line", line, tools };
}

function subjectOf(registration: NormalizedRegistration): string {
  return registration.scope === "tool"
    ? `tool ${JSON.stringify(registration.line)}`
    : `line ${JSON.stringify(registration.line)}`;
}

/**
 * The label is what the user sees, so two designs of one line showing the same text cannot be told
 * apart (the same rule the card-style line applies). Rejected BEFORE anything is stored, with the
 * clash recorded so `/bridge-status` explains why the second design is not in the menu.
 */
function assertLabelIsDistinct(registration: NormalizedRegistration, design: ToolDesignRegistration): void {
  const line = toolDesignIndex(designState()).byKey.get(lineKey(registration.scope, registration.line));
  const clash = line?.entries.find(
    (candidate) => candidate.design.id !== design.id && candidate.design.label === design.label,
  );
  if (clash === undefined) return;
  const subject = subjectOf(registration);
  const message =
    `gentle-shell-bridge: invalid tool design label ${JSON.stringify(design.label)} for ` +
    `${JSON.stringify(design.id)}: it is already used by ${JSON.stringify(clash.design.id)} on ` +
    `${subject}. Two values reading the same cannot be told apart on the line. Pick a distinct label.`;
  recordConflict({
    tool: registration.line,
    id: design.id,
    kind: "label",
    message,
  });
  throw new Error(message);
}

/**
 * A tool has at most ONE unscoped claim (S9/D1), and the claim table applies PER TOOL of the
 * registration (S19). Joining the same line again is fine (S3: union); a second UNSCOPED claim of a
 * tool — another grouped line, or the tool's own legacy `Card <tool>` line — refuses the WHOLE
 * registration and is recorded under the `line` kind, with today's message. A SCOPED claim narrows
 * the calls it owns, so it never conflicts: any number of them live beside the one unscoped claim,
 * and the resolver decides per call which of them paints it.
 *
 * The unscoped check is INDEPENDENT of "this registration joins the line that already claims the
 * tool" (L6): re-registering its own (line, id) is exempt from ITS OWN claim, never from the claim
 * of another line. Without that independence a scoped line could re-register itself unscoped over a
 * second unscoped line and leave two unscoped claims of one tool alive.
 */
function assertToolsAreFree(registration: NormalizedRegistration, design: ToolDesignRegistration): void {
  const index = toolDesignIndex(designState());
  const self = (line: IndexedLine): boolean =>
    line.scope === registration.scope && line.line === registration.line;
  for (const tool of registration.tools) {
    // S9 per claim: a SCOPED claim of THIS tool narrows the calls it owns, so it never conflicts —
    // not with the unscoped claim of that tool, not with another scoped one.
    if (scopeOfClaim(design, tool) !== undefined) continue;
    const claims = index.claimsByTool.get(tool) ?? [];
    // The one UNSCOPED claim of this tool that is not this registration's own line.
    const live = claims.find((claim) => claim.scope === undefined && !self(claim.line));
    if (live === undefined) continue;
    const current =
      live.line.scope === "tool"
        ? `its own Card ${JSON.stringify(tool)} line`
        : `the line ${JSON.stringify(live.line.line)}`;
    const message =
      `gentle-shell-bridge: tool ${JSON.stringify(tool)} already belongs to ${current}, so design ` +
      `${JSON.stringify(design.id)} for ${subjectOf(registration)} was refused whole (S5/D1). A tool ` +
      "belongs to at most one line; register it on that line or remove the other registration.";
    recordConflict({ tool, id: design.id, kind: "line", message });
    throw new Error(message);
  }
}

/**
 * S7/S19: a scope is a predicate plus the one line that explains it. An absent scope is never an
 * error; a present one that is not an object, whose `description` is not a non-empty string after
 * trim, or whose `matches` is not a function refuses the WHOLE registration before anything is
 * stored, and the refusal is recorded under the `scope` kind.
 *
 * The scope is declared PER (line, tool) claim: `scopes` maps each of this registration's tools to
 * its scope, and `scope` is the shorthand for the SAME object on every tool (S19). Refused whole:
 * both members together, and a `scopes` map that is not an object, is empty, names a tool this
 * registration does not paint, or carries a value that is not a scope.
 *
 * A scope is declared on a GROUPED registration ONLY (L6): `{ tool, scope, … }` and `{ tool, scopes,
 * … }` are refused whole. An ungrouped registration IS the tool's own `Card <tool>` line, and that
 * line means every call of that tool by definition; "only some calls" is a line that shares the tool
 * with another claim, which is the grouped shape. Keeping it apart also keeps the two key spaces
 * apart: an implicit line is keyed by the tool name, and so is the historical per-tool selection.
 */
function assertScope(registration: NormalizedRegistration, design: ToolDesignRegistration): void {
  // SAFETY: the members are typed, but a plugin is plain JavaScript: every member is re-checked here.
  const scope: unknown = design.scope;
  const scopes: unknown = design.scopes;
  if (scope === undefined && scopes === undefined) return;
  if (registration.scope === "tool") {
    // The `scope` SHORTHAND keeps the refusal text it had before `scopes` existed, byte for byte
    // (S19/L14/S2): the shorthand IS `scopes` with one object, so only a registration that SPELLS
    // `scopes` carries the per-tool wording — and that wording names `scopes`, the member it used.
    const message =
      scopes === undefined
        ? `gentle-shell-bridge: invalid tool design ${JSON.stringify(design.id)} for tool ` +
          `${JSON.stringify(registration.line)}: a scope is declared on a GROUPED registration only, and ` +
          `\`{ tool, id, label, apply }\` is that tool's own Card ${JSON.stringify(registration.line)} ` +
          "line, which means every call of the tool. To claim only SOME calls, register a grouped line " +
          "`{ line, tools, scope, id, label, apply }` for the tool beside the line that already claims " +
          "it. The registration was refused whole."
        : `gentle-shell-bridge: invalid tool design ${JSON.stringify(design.id)} for tool ` +
          `${JSON.stringify(registration.line)}: a scope is declared on a GROUPED registration only, and ` +
          `\`{ tool, id, label, apply }\` is that tool's own Card ${JSON.stringify(registration.line)} ` +
          "line, which means every call of the tool. To claim only SOME calls, register a grouped line " +
          "`{ line, tools, scopes, id, label, apply }` for the tool beside the line that already " +
          "claims it (`scopes` on an ungrouped registration was refused). The registration was refused whole.";
    recordConflict({ tool: registration.line, id: design.id, kind: "scope", message });
    throw new Error(message);
  }
  // The two spellings of one claim would disagree, so they cannot be combined.
  if (scope !== undefined && scopes !== undefined) {
    const message =
      `gentle-shell-bridge: invalid tool design ${JSON.stringify(design.id)} for ` +
      `${subjectOf(registration)}: \`scope\` and \`scopes\` cannot be combined. \`scope\` is the ` +
      "shorthand for the SAME scope on every tool of `tools`; use `scopes` keyed by tool to give each " +
      "tool its own scope. The registration was refused whole.";
    recordConflict({ tool: registration.line, id: design.id, kind: "scope", message });
    throw new Error(message);
  }
  if (scopes !== undefined) {
    const problem = scopesProblem(scopes, registration.tools);
    if (problem !== undefined) {
      const message =
        `gentle-shell-bridge: invalid tool design ${JSON.stringify(design.id)} for ` +
        `${subjectOf(registration)}: ${problem} A scope is { description, matches }: ` +
        "`description` is the one line the menu and /bridge-status show, and `matches(call)` answers " +
        "whether the line owns that call (the call is { tool, args }). The registration was refused whole.";
      recordConflict({ tool: registration.line, id: design.id, kind: "scope", message });
      throw new Error(message);
    }
    return;
  }
  const problem = scopeProblem(scope);
  if (problem === undefined) return;
  const message =
    `gentle-shell-bridge: invalid tool design ${JSON.stringify(design.id)} for ` +
    `${subjectOf(registration)}: scope ${problem}. A scope is { description, matches }: ` +
    "`description` is the one line the menu and /bridge-status show, and `matches(call)` answers " +
    "whether this line owns that call (the call is { tool, args }). The registration was refused whole.";
  recordConflict({ tool: registration.line, id: design.id, kind: "scope", message });
  throw new Error(message);
}

/** What is wrong with one `ToolDesignScope` value, or `undefined` when it is valid (S7/S18). */
function scopeProblem(scope: unknown): string | undefined {
  if (!isRecord(scope)) return "must be an object carrying both members";
  if (typeof scope.description !== "string" || scope.description.trim() === "") {
    return "needs a non-empty string as its description member";
  }
  if (/[\r\n]/u.test(scope.description)) {
    return (
      "description must be ONE line, and it carries a line break (CR or LF). It is rendered " +
      "inside an existing menu and /bridge-status row, so a break would add a row there; remove the break"
    );
  }
  if (typeof scope.matches !== "function") return "needs a function as its matches member";
  return undefined;
}

/**
 * What is wrong with a `scopes` map, or `undefined` when it is valid (S19). The map is keyed by the
 * tools THIS registration paints: a key it does not paint claims calls it could never own, so it is a
 * contradiction rather than a harmless extra. The message names the offending tool key when one is
 * the problem, because that is the entry the author has to find.
 *
 * EVERY OWN key is validated, enumerable or not (S19/L14), and a symbol key is refused: `scopeOfClaim`
 * reads the claim through `Object.hasOwn`, which sees the same own keys, so this list and that read
 * are ONE key set. With `Object.keys` a non-enumerable `read: null` or a hidden foreign `find` passed
 * validation and then reached the live registry — and, through the legacy-selection migration, the
 * persisted selection.
 */
function scopesProblem(scopes: unknown, tools: readonly string[]): string | undefined {
  if (!isRecord(scopes)) {
    return (
      "scopes must be an object keyed by tool name, each key one of the registration's `tools` and " +
      "each value a { description, matches } scope."
    );
  }
  const keys = Reflect.ownKeys(scopes);
  if (keys.length === 0) {
    return (
      "scopes is empty: it maps each tool to the scope of its calls, so leave it out entirely to " +
      "claim every call of every tool."
    );
  }
  for (const key of keys) {
    if (typeof key === "symbol") {
      return (
        `scopes carries the symbol key ${String(key)}, which cannot name one of this registration's ` +
        `tools (${tools.join(", ")}). scopes is keyed by tool names, so every key is one of the ` +
        "tools the design paints."
      );
    }
    const tool = key;
    if (!tools.includes(tool)) {
      return (
        `scopes names tool ${JSON.stringify(tool)}, which is not one of this registration's tools ` +
        `(${tools.join(", ")}). scopes is keyed by the tools the design paints.`
      );
    }
    const problem = scopeProblem(scopes[tool]);
    if (problem !== undefined) return `scopes for tool ${JSON.stringify(tool)} ${problem}.`;
  }
  return undefined;
}

/**
 * S8 per (line, tool) (S19): every LIVE registration of one line that names a tool must carry the
 * SAME scope object for that tool (`===`; both absent counts as equal). A registration that does not
 * name the tool does not constrain it, so one line may own some tools unconditionally and narrow
 * others. A registration that replaces the live entry with the same (`line`, `id`) is exempt, so a
 * plugin may re-register its own design with a fresh scope object; any other disagreement refuses the
 * whole registration and is recorded under the `scope` kind.
 */
function assertOneScopePerClaim(
  registration: NormalizedRegistration,
  design: ToolDesignRegistration,
): void {
  const line = toolDesignIndex(designState()).byKey.get(
    lineKey(registration.scope, registration.line),
  );
  if (line === undefined) return;
  for (const entry of line.entries) {
    // Its own entry is the one this registration replaces: that is the documented exemption.
    if (entry.design.id === design.id) continue;
    for (const tool of registration.tools) {
      if (!entry.tools.includes(tool)) continue;
      if (scopeOfClaim(entry.design, tool) === scopeOfClaim(design, tool)) continue;
      // The `scope` SHORTHAND keeps the diagnostics it had before `scopes` existed, byte for byte
      // (S19/L14/S2): it IS `scopes` with one object, so its refusal must not change shape. The
      // per-tool wording belongs to a registration that SPELLS `scopes`.
      const message =
        design.scopes === undefined
          ? `gentle-shell-bridge: design ${JSON.stringify(design.id)} for ${subjectOf(registration)} was ` +
            `refused whole: the line already carries a different scope on design ` +
            `${JSON.stringify(entry.design.id)}. One line is one switch, so every live registration of a ` +
            "line must share the SAME scope object (S8); re-register the same (line, id) to change it."
          : `gentle-shell-bridge: design ${JSON.stringify(design.id)} for ${subjectOf(registration)} ` +
            `was refused whole: the line already carries a different scope on tool ` +
            `${JSON.stringify(tool)} (design ${JSON.stringify(entry.design.id)}). One line is one switch ` +
            `per call of a tool, so every live registration of a line that names tool ` +
            `${JSON.stringify(tool)} must share the SAME scope object for it (S8); a registration that ` +
            "does not name the tool does not constrain it, and re-registering the same (line, id) is " +
            "exempt. Re-register the same (line, id) to change a scope.";
      recordConflict({ tool: registration.line, id: design.id, kind: "scope", message });
      throw new Error(message);
    }
  }
}

function recordConflict(conflict: ToolDesignConflict): void {
  const state = designState();
  const index = state.conflicts.findIndex(
    (candidate) =>
      candidate.tool === conflict.tool &&
      candidate.id === conflict.id &&
      candidate.kind === conflict.kind &&
      candidate.message === conflict.message,
  );
  if (index === -1) state.conflicts.push(conflict);
  else state.conflicts[index] = conflict;
}

/**
 * Register a design for one tool (ungrouped), for one line over several tools (grouped), or an array
 * of registrations of either shape, and return a disposer that removes exactly what this call
 * registered. Two designs of one line from one call are the same as two calls: they join that line.
 *
 * Same entry discipline as every other bridge surface, because a plugin author should not have to
 * learn two:
 *
 * - a second registration with the same (`line`, `id`) replaces the previous one IN PLACE, so the
 *   value keeps the position its registration earned — and the replacement is RECORDED, because a
 *   silent takeover is exactly what two plugins must never experience (`getToolDesignConflicts`);
 * - the returned disposer removes only the registration it created: after a replacement the replaced
 *   design's disposer is a no-op instead of removing the replacement, and calling it twice does
 *   nothing the second time;
 * - validation happens BEFORE anything is stored (shape, tool, line, id, label, distinctness,
 *   `apply`, tool ownership), so a refused design never half-registers and never reaches a menu;
 * - the registration is ATTRIBUTED like every other surface (`./plugin-lines.ts`): a plugin that
 *   contributes only designs still gets its one INTEGRATIONS line, its `name` is honoured once for
 *   the identity, and a refused design shows up as a rejection instead of disappearing.
 */
export function registerToolDesign(
  design: ToolDesignRegistration | readonly ToolDesignRegistration[],
): () => void {
  if (!Array.isArray(design)) return registerOneToolDesign(design as ToolDesignRegistration);
  // A batch is all-or-nothing: a refused design never leaves the ones before it registered, and the
  // single disposer removes exactly the designs this call stored.
  const state = designState();
  const before = [...state.entries];
  const disposers: Array<() => void> = [];
  try {
    for (const one of design as readonly ToolDesignRegistration[]) {
      disposers.push(registerOneToolDesign(one));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    // A batch that failed also RESTORES a grouped design it replaced on its way, so "all or nothing"
    // covers the entries it overwrote and not only the ones it appended.
    state.entries.length = 0;
    state.entries.push(...before);
    bumpRevision(state);
    throw error;
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

function registerOneToolDesign(design: ToolDesignRegistration): () => void {
  return attributeRegistration("tool design", design, undefined, () =>
    registerToolDesignStored(design),
  );
}

/** The store half: validate, then replace in place or append. Called through attribution above. */
function registerToolDesignStored(design: ToolDesignRegistration): () => void {
  const registration = normalizeRegistration(design);
  // Reused from the bus: identity is a plain-object key and the store's key set. The message reads
  // "invalid tool name" / "invalid tool design id", both of which name the field that was wrong.
  assertRegistrationId("tool design", design.id);
  assertScope(registration, design);
  assertLabel(subjectOf(registration), design.id, design.label);
  assertApplyFunction(subjectOf(registration), design.id, design.apply);
  assertOneScopePerClaim(registration, design);
  assertToolsAreFree(registration, design);
  assertLabelIsDistinct(registration, design);

  const state = designState();
  const entry: DesignEntry = {
    scope: registration.scope,
    line: registration.line,
    tools: [...registration.tools],
    design,
  };
  const index = state.entries.findIndex(
    (candidate) =>
      candidate.scope === registration.scope &&
      candidate.line === registration.line &&
      candidate.design.id === design.id,
  );
  if (index === -1) {
    state.entries.push(entry);
  } else {
    const previous = state.entries[index].design;
    if (previous !== design) {
      const ownership = registration.scope === "tool" ? "tool" : "line";
      recordConflict({
        tool: registration.line,
        id: design.id,
        kind: "replaced",
        message:
          `gentle-shell-bridge: design ${JSON.stringify(design.id)} for ${ownership} ` +
          `${JSON.stringify(registration.line)} was registered again and the later registration is ` +
          `the live one. Only one design can own a (${ownership}, id); the replacement is reported ` +
          "here instead of happening silently.",
      });
    }
    state.entries[index] = entry;
  }
  bumpRevision(state);
  // Best-effort and never fatal: the registration is already live, so a store that cannot be read or
  // written must not leave a live design with no disposer (the legacy value is simply not migrated).
  try {
    migrateLegacySelection(registration);
  } catch (error) {
    recordToolDesignFailure(
      registration.line,
      design.id,
      `the legacy per-tool selection could not be migrated to ` +
        `${JSON.stringify(registration.line)} (${errorMessage(error)}); the line keeps its own value.`,
    );
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.entries.indexOf(entry);
    if (current !== -1) {
      state.entries.splice(current, 1);
      bumpRevision(state);
    }
  };
}

/**
 * D3: a tool joining a line that has NO stored value lends that line its legacy per-tool value when
 * that value names a design of the line, and the line value is written then. Registration time only —
 * never the render path. A line that already has a value is never migrated again, and the legacy
 * `selections` map is left exactly as it was.
 */
function migrateLegacySelection(registration: NormalizedRegistration): void {
  if (registration.scope !== "line") return;
  const selections = readSelections();
  if (Object.hasOwn(selections.lines, registration.line)) return;
  const line = toolDesignIndex(designState()).byKey.get(
    lineKey(registration.scope, registration.line),
  );
  if (line === undefined) return;
  for (const tool of registration.tools) {
    const legacy = storedId(selections.tools, tool);
    if (legacy === TOOL_DESIGN_NATIVE) continue;
    if (!line.entries.some((candidate) => candidate.design.id === legacy)) continue;
    writeSelections({
      tools: selections.tools,
      lines: { ...selections.lines, [registration.line]: legacy },
    });
    return;
  }
}

/** Conflicts recorded by registration, newest per (tool/line, id, kind, message), for `/bridge-status`. */
export function getToolDesignConflicts(): ToolDesignConflict[] {
  return designState().conflicts.map((conflict) => ({ ...conflict }));
}

/**
 * Record one design failure, ONCE per (tool, id, message): a design that throws every frame is one
 * fact, not one line per frame. Bounded, so a plugin cannot grow the report without limit.
 */
export function recordToolDesignFailure(tool: string, designId: string, message: string): void {
  const state = designState();
  const duplicate = state.failures.some(
    (failure) =>
      failure.tool === tool && failure.designId === designId && failure.message === message,
  );
  if (duplicate) return;
  state.failures.push({ tool, designId, message });
  if (state.failures.length > MAX_FAILURES) {
    state.failures.splice(0, state.failures.length - MAX_FAILURES);
  }
}

/** The failures the last frames recorded, oldest first. Read by `/bridge-status`. */
export function getToolDesignFailures(): ToolDesignFailure[] {
  return designState().failures.map((failure) => ({ ...failure }));
}

/**
 * Hand the host's own rows to the selected design (`./tool-design-wiring.ts` calls this on every
 * render pass).
 *
 * Returns `undefined` when the host's rows must stand — a throw, or a return value that is not an
 * array of strings — so the caller draws the host's card unchanged. The design receives a COPY: a
 * design that mutates its input cannot corrupt the array the host's component still owns.
 */
export function applyToolDesign(
  design: ToolDesignRegistration,
  lines: readonly string[],
  ctx: ToolDesignContext,
): string[] | undefined {
  let applied: unknown;
  try {
    applied = design.apply([...lines], ctx);
  } catch (error) {
    recordToolDesignFailure(ctx.tool, design.id, errorMessage(error));
    return undefined;
  }
  if (!Array.isArray(applied) || !applied.every((line) => typeof line === "string")) {
    recordToolDesignFailure(
      ctx.tool,
      design.id,
      "apply returned something that is not an array of strings; the host's own rows are drawn " +
        "instead. Return the rows to draw, e.g. `return lines`.",
    );
    return undefined;
  }
  // SAFETY: the element check above proves every member is a string.
  return applied as string[];
}

// ---------------------------------------------------------------------------------------------
// The selection: one persisted value per line
// ---------------------------------------------------------------------------------------------

interface SelectionState {
  /** The unchanged per-tool map (`selections`). */
  tools: Record<string, unknown>;
  /** The per-line map (`lines`), beside it in the same file. */
  lines: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The persisted selections, read live. An unreadable or malformed file reads as empty, so a
 * hand-edited file can never select a design the user did not choose. ONE logical read of the
 * bridge's store per call, which is what the cost bound counts (S9/D6).
 */
function readSelections(): SelectionState {
  designState().selectionReads += 1;
  // ONE `get`, therefore one file read: the line map travels inside the same value under a reserved
  // key (S9/D6). A file written before grouped lines is a flat `{ <tool>: <id> }` and reads as-is.
  const stored = asRecord(createStore(TOOL_DESIGN_STORE_ID).get<unknown>(TOOL_DESIGN_STORE_KEY, {}));
  const { [TOOL_DESIGN_LINE_STORE_KEY]: lines, ...tools } = stored;
  return { tools, lines: asRecord(lines) };
}

/**
 * The one value to persist: the tool selections flat, the line selections under the reserved key — and
 * the reserved key is written ONLY when a line has a value, so a session with no grouped line keeps the
 * document it has always had, byte for byte.
 */
function writeSelections(state: SelectionState): void {
  const document: Record<string, unknown> = { ...state.tools };
  if (Object.keys(state.lines).length > 0) {
    document[TOOL_DESIGN_LINE_STORE_KEY] = state.lines;
  }
  createStore(TOOL_DESIGN_STORE_ID).set(TOOL_DESIGN_STORE_KEY, document);
}

function storedId(map: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(map, key)) return TOOL_DESIGN_NATIVE;
  const stored = map[key];
  return typeof stored === "string" && stored.trim() !== "" ? stored : TOOL_DESIGN_NATIVE;
}

/**
 * How many persisted-selection reads happened since the last reset. Each one is a single logical read
 * of the bridge's tool-design store, so a caller can bound the file work a switch or a frame performs
 * instead of timing it (S13/T23). Read by the cost test; not part of the public API.
 */
export function getToolDesignSelectionReads(): number {
  return designState().selectionReads;
}

/** Test-only seam for the read counter; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignSelectionReads(): void {
  designState().selectionReads = 0;
}

/** The design id stored for one LEGACY per-tool value, or `native` when it has none. */
export function getToolDesignSelection(tool: string): string {
  return storedId(readSelections().tools, tool);
}

/** The design id stored for one line, or `native` when it has none. */
export function getToolDesignLineSelection(scope: "tool" | "line", line: string): string {
  const selections = readSelections();
  return storedId(scope === "tool" ? selections.tools : selections.lines, line);
}

/**
 * Persist one line's selection, FIRST and synchronously: the repaint reads the stored value, so the
 * bullet cannot land on a value that was never written. Ungrouped lines write the historical
 * `selections` map; grouped ones write `lines` beside it (D3).
 */
export function setToolDesignLineSelection(
  scope: "tool" | "line",
  line: string,
  id: string,
): void {
  const selections = readSelections();
  if (scope === "tool") writeSelections({ tools: { ...selections.tools, [line]: id }, lines: selections.lines });
  else writeSelections({ tools: selections.tools, lines: { ...selections.lines, [line]: id } });
}

/** Persist one tool's (ungrouped) selection. Kept as the historical name. */
export function setToolDesignSelection(tool: string, id: string): void {
  setToolDesignLineSelection("tool", tool, id);
}

/**
 * One live line's claim on one tool, with the value stored for that line: the answer `/bridge-status`
 * gives for a tool that has SCOPED claims (S14). `scopeDescription` is the scope of THIS tool's claim
 * (S19), so a line that narrows only some of its tools reports the scope of the tool being listed.
 */
export interface ToolDesignClaim {
  /** `tool` for an ungrouped design's implicit line, `line` for a registered line. */
  scope: "tool" | "line";
  /** The selection key: the tool name, or the registered line id. */
  line: string;
  /** The design id stored for the line, or `native`. */
  stored: string;
  /** The scope's description when this (line, tool) claim is scoped (S7/S8/S19). */
  scopeDescription?: string;
}

/**
 * Every line that CLAIMS one tool, in creation order — the one unscoped claim and the scoped ones
 * (S9) — each with its stored value and the scope of THAT tool, read from ONE snapshot of the
 * persisted selections.
 */
export function toolDesignClaims(tool: string): ToolDesignClaim[] {
  const claims = toolDesignIndex(designState()).claimsByTool.get(tool) ?? [];
  if (claims.length === 0) return [];
  const selections = readSelections();
  return claims.map((claim) => ({
    scope: claim.line.scope,
    line: claim.line.line,
    stored: storedId(
      claim.line.scope === "tool" ? selections.tools : selections.lines,
      claim.line.line,
    ),
    ...(claim.scope === undefined ? {} : { scopeDescription: claim.scope.description }),
  }));
}

/**
 * What the stored value means right now for one tool: `native` (the host's own card), the live
 * `design`, `missing` when the design it names left the line, or `not-covered` when the selected
 * value is a design of the line that does not name this tool (S6/D4). Both degrade to the host's
 * card; the difference is what `/bridge-status` reports.
 */
export type ToolDesignSelection =
  | { kind: "native" }
  | { kind: "design"; design: ToolDesignRegistration }
  | { kind: "missing"; id: string }
  | { kind: "not-covered"; id: string };

/** The stored value of one line inside one snapshot of the persisted selections. */
function storedFor(selections: SelectionState, line: IndexedLine): string {
  return storedId(line.scope === "tool" ? selections.tools : selections.lines, line.line);
}

/**
 * The answer one line's stored value gives for one tool. `native`, `missing` and `not-covered`
 * DECLINE a call: the next candidate answers (S10).
 */
function selectionOfLine(
  index: ToolDesignIndex,
  scope: "tool" | "line",
  line: string,
  stored: string,
  tool: string,
): ToolDesignSelection {
  if (stored === TOOL_DESIGN_NATIVE) return { kind: "native" };
  const indexed = index.byKey.get(lineKey(scope, line));
  const entry = indexed?.entries.find((candidate) => candidate.design.id === stored);
  if (entry === undefined) return { kind: "missing", id: stored };
  return entry.tools.includes(tool)
    ? { kind: "design", design: entry.design }
    : { kind: "not-covered", id: stored };
}

/**
 * Does this line own THIS call (S10)? The scope sees `{ tool, args }` and nothing else — never the card's
 * `part` — so both halves are decided by this same procedure. It is not promised the same input: the
 * arguments are the host's object, read again on every pass (see `ToolDesignCall`), and the selection is
 * read on every pass too, so a switch or a mutated argument can legitimately change the answer between the
 * two halves. A scope that throws, or that answers with anything but a boolean, counts as
 * "does not match" and is recorded once per (tool, design id, message); resolution never throws.
 */
/**
 * Swallow a rejected thenable without ever throwing (S18). Both halves reach PLUGIN code: reading
 * `then` can run a getter, and calling it can run anything, so both happen inside a try. A value that
 * cannot even be drained is still only "not an answer", and the failure the caller already recorded
 * is the whole report. A native rejected promise IS drained here, so it never reaches the process as
 * an unhandled rejection.
 *
 * The value the `then` CALL RETURNS is drained too, because it can itself be rejecting: an `async
 * then` cannot throw to its caller — it rejects the promise it returns — and dropping that promise
 * lets `--unhandled-rejections=strict` fail the host on a paint already declined. The recursion is
 * bounded, so a thenable chain cannot loop forever and a promise that keeps handing back promises
 * costs at most `THENABLE_DRAIN_DEPTH` steps.
 */
function drainThenable(value: unknown, depth = THENABLE_DRAIN_DEPTH): void {
  if (depth <= 0) return;
  let returned: unknown;
  try {
    // SAFETY: a plugin is plain JavaScript, so `then` is read as `unknown` and re-checked.
    const then = (value as { then?: unknown }).then;
    if (typeof then !== "function") return;
    returned = (
      then as (this: unknown, onFulfilled: undefined, onRejected: () => void) => unknown
    ).call(value, undefined, () => {});
  } catch {
    // A `then` getter or a `then` body that throws synchronously is not a rejection: the decline
    // stands as recorded, and there is no value to drain.
    return;
  }
  drainThenable(returned, depth - 1);
}

function scopeMatches(claim: IndexedClaim, tool: string, args: unknown): boolean {
  const scope = claim.scope;
  if (scope === undefined) return false;
  const designId = claim.entry.design.id;
  let answer: unknown;
  try {
    answer = scope.matches({ tool, args });
  } catch (error) {
    recordToolDesignFailure(
      tool,
      designId,
      `the scope of design ${JSON.stringify(designId)} threw (${errorMessage(error)}); ` +
        "the call counts as one the line does not own, so the line declined it.",
    );
    return false;
  }
  // A paint cannot await (S18/S10), so only `true` and `false` ARE answers: a Promise, a truthy
  // string, `undefined` or anything else is a scope that has not answered NOW, and the call counts as
  // one the line does not own. Recorded once per (tool, design id, message), like a throw.
  if (typeof answer !== "boolean") {
    recordToolDesignFailure(
      tool,
      designId,
      `the scope of design ${JSON.stringify(designId)} answered with ${typeof answer} ` +
        "instead of a boolean, and a paint cannot await; the call counts as one the line does not " +
        "own, so the line declined it. Return true or false from matches.",
    );
    // A scope that returned a Promise is a plugin bug the bridge must not turn into a host crash: an
    // unhandled rejection can take the process down on a host that treats it as fatal, and this paint
    // declines the call anyway. Inspection itself is isolated, so a thenable that throws while it is
    // read or drained leaves the failure recorded above as the whole report.
    drainThenable(answer);
    return false;
  }
  return answer;
}

/**
 * Resolve one tool's card for ONE call against the live registry. Never throws.
 *
 * The candidates, in order (S10): the scoped claims of the tool whose scope matches `{ tool, args }`,
 * in registration order, then the unscoped claim of the tool, if any. The first candidate whose
 * line's stored value is a live design covering the tool answers; otherwise the LAST candidate's
 * answer stands — today's answer, byte for byte, when the only candidate is the unscoped claim.
 *
 * With no `args` argument no scoped claim is a candidate, so a consumer that only knows a tool name
 * keeps answering exactly as before. The persisted selections are read ONCE per call (S11), never
 * once per candidate.
 *
 * The HISTORICAL per-tool value answers only for a tool with NO live claim at all (S10/L6): that is
 * what keeps a stale legacy selection resolving to `missing` for a disposed design (S2). When the
 * tool HAS live claims and every one of them declined the call — each scoped claim's predicate
 * missed, `args` were omitted, or a value was `native` — the answer is `{ kind: "native" }`: never a
 * value re-entered from `selections.tools[tool]`, which for an implicit line is that line's own
 * stored value.
 */
export function resolveToolDesignSelection(tool: string, args?: unknown): ToolDesignSelection {
  const state = designState();
  const index = toolDesignIndex(state);
  // ONE snapshot serves every candidate: one logical store read per resolve (S11).
  const selections = readSelections();
  const claims = index.claimsByTool.get(tool) ?? [];
  const scoped: IndexedClaim[] = [];
  let unscoped: IndexedClaim | undefined;
  for (const claim of claims) {
    if (claim.scope === undefined) {
      if (unscoped === undefined) unscoped = claim;
      continue;
    }
    // No arguments: the call is unknown, so no scoped claim applies (S10).
    if (args === undefined) continue;
    if (!scopeMatches(claim, tool, args)) continue;
    scoped.push(claim);
  }
  const candidates = unscoped === undefined ? scoped : [...scoped, unscoped];
  if (candidates.length === 0) {
    // Live claims exist and every one declined this call: the host's own card, never the stored value
    // of a line that just declined it.
    if (claims.length > 0) return { kind: "native" };
    // No live claim at all: the historical per-tool value still answers, so a design that was
    // disposed keeps resolving to `missing` instead of silently to `default`.
    return selectionOfLine(index, "tool", tool, storedId(selections.tools, tool), tool);
  }
  for (const candidate of candidates) {
    const selection = selectionOfLine(
      index,
      candidate.line.scope,
      candidate.line.line,
      storedFor(selections, candidate.line),
      tool,
    );
    if (selection.kind === "design") return selection;
  }
  const last = candidates[candidates.length - 1];
  return selectionOfLine(
    index,
    last.line.scope,
    last.line.line,
    storedFor(selections, last.line),
    tool,
  );
}

/** Test-only seam: empties the registry, the conflict records and the failure records in place. */
export function resetToolDesignsForTests(): void {
  const state = designState();
  state.entries.length = 0;
  state.conflicts.length = 0;
  state.failures.length = 0;
  state.selectionReads = 0;
  state.lineOrder.clear();
  state.lineOrderSeq = 0;
  state.revision += 1;
  delete state.index;
}

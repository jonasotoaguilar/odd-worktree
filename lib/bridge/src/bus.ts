/**
 * The process-global bus: providers (docs/architecture.md §7, docs/contract.md §1, §5), sidebar
 * sections (the sidebar spec's S1, S2) and transcript transforms (this feature's S1).
 *
 * Pi loads every extension through its own jiti loader with `moduleCache: false`, so module
 * scope is per-copy and cannot hold shared state. The registration lists therefore live on
 * `globalThis` behind a stable `Symbol.for` key, exactly as gentle-shell does for its card
 * style (`lib/shell-card.ts:40-41`). Three providers loaded from three copies of this package
 * see one bus.
 *
 * Sections share this slot rather than taking one of their own: both surfaces are registrations
 * that must be process-global for the same reason, and one slot means one place to read (and to
 * reset) what this process has contributed. `bus()` grows the `sections` list on a slot created
 * by a copy that predates it, so a provider list already in flight is kept. The same holds for
 * `cardStyles` and `transforms`.
 *
 * The key is the bridge's own; it is NOT the hook registry key
 * `Symbol.for("gentle-pi.customize-row-providers")`, which belongs to the host (S4/T5), and it
 * is not the host's rail key `Symbol.for("gentle-pi.experimental-sidebar.state")`.
 *
 * This module is internal. `src/index.ts` re-exports `registerRows` and `snapshotProviders`
 * but never `resetBusForTests`; the section equivalents stay internal until the public surface is
 * decided.
 */

import { HOST_CARD_STYLE_VALUES, RESERVED_CARD_STYLE_IDS } from "./card-style-line.ts";
import { attributeRegistration } from "./plugin-lines.ts";
import { cardStyleRowLabelText, sectionRowLabelText } from "./row-labels.ts";
import {
  clearRowNameRejections,
  rejectRowName,
  reservedCategory,
  RESERVED_CATEGORY_RULE,
} from "./row-names.ts";
import { RAIL_PARTS } from "./types.ts";
import type {
  CardStyleRegistration,
  RailPart,
  RowProvider,
  SidebarSection,
  TranscriptTransform,
} from "./types.ts";

/** Re-exported here because a placement decision is the bus's: see `resolveSectionPlacements`. */
export { RAIL_PARTS };

/** Stable process-global slot for the bridge's registration lists. */
const BUS_KEY = Symbol.for("gentle-shell-bridge.providers");

interface BusEntry {
  provider: RowProvider;
}

interface SectionEntry {
  section: SidebarSection;
}

interface CardStyleEntry {
  style: CardStyleRegistration;
}

interface TransformEntry {
  transform: TranscriptTransform;
}

interface BusState {
  /** Providers in subscription order; one entry per live `id`. */
  entries: BusEntry[];
  /** Sections in registration order; one entry per live `id`. Ordering happens in the snapshot. */
  sections: SectionEntry[];
  /** Card styles in registration order; one entry per live `id`. Ordering: `snapshotCardStyles`. */
  cardStyles: CardStyleEntry[];
  /** Transcript transforms in registration order; ordering happens in `snapshotTransforms`. */
  transforms: TransformEntry[];
  /** Sections that asked for a `placement` the bridge cannot honour; one per live `id`. */
  placementRejections: SectionPlacementRejection[];
  /** Row providers that asked for a `placement` the bridge cannot honour; one per live `id`. */
  rowPlacementRejections: RowPlacementRejection[];
  /** The ACTUAL landing each row provider got in the last menu build (S5). */
  rowPlacementLandings: RowPlacementLandingRecord[];
  /** The host's own category names as the last capture observed them (T2 writes this). */
  observedHostCategories?: string[];
}

/** The slot shape on `globalThis`; keeps the cast in one place. */
function busHost(): Record<symbol, BusState | undefined> {
  // SAFETY: the only writes to this key are the `bus()` creation below, so IF this key holds
  // anything it holds a BusState. A foreign or partial value is not trusted anyway: `bus()`
  // re-checks `entries` and replaces an unusable slot before returning it.
  return globalThis as unknown as Record<symbol, BusState | undefined>;
}

/**
 * Return the process-global bus, creating it on first use. A pre-existing value that is not a
 * usable bus (another library's slot, a partial object across reloads) is replaced rather than
 * trusted.
 */
function bus(): BusState {
  const host = busHost();
  const existing = host[BUS_KEY];
  if (existing !== undefined && Array.isArray(existing.entries)) {
    // A slot created by a copy of this package (or an earlier load) that predates sections keeps
    // its live providers and gains the section list in place, so two copies always agree.
    if (!Array.isArray(existing.sections)) existing.sections = [];
    // Same for card styles: an older copy's bus gains the list instead of being replaced, so a
    // style registered through one copy is visible to every other (S12, determinism).
    if (!Array.isArray(existing.cardStyles)) existing.cardStyles = [];
    // And for transforms: a copy that predates the pipeline keeps its live registrations and gains
    // the list, so the wrapper another copy installed sees what this copy registered.
    if (!Array.isArray(existing.transforms)) existing.transforms = [];
    // Same for the placement rejections: an older copy's bus gains the list instead of being
    // replaced, so the report of a bad `placement` survives a second package copy registering one.
    if (!Array.isArray(existing.placementRejections)) existing.placementRejections = [];
    // And for the row placement rejections, the same discipline for the row surface.
    if (!Array.isArray(existing.rowPlacementRejections)) existing.rowPlacementRejections = [];
    // The last build's actual landings are diagnostics, not registrations; an older copy gains the
    // list instead of being replaced.
    if (!Array.isArray(existing.rowPlacementLandings)) existing.rowPlacementLandings = [];
    return existing;
  }
  const created: BusState = {
    entries: [],
    sections: [],
    cardStyles: [],
    transforms: [],
    placementRejections: [],
    rowPlacementRejections: [],
    rowPlacementLandings: [],
  };
  host[BUS_KEY] = created;
  return created;
}

/**
 * Register a provider and return a disposer that removes exactly that provider.
 *
 * - Providers keep subscription order.
 * - Registering an existing `id` replaces the previous registration *in place*, so the order
 *   is stable and there is still exactly one entry (and one diagnostics entry) for that id.
 * - The disposer removes only the registration it created: after a same-id replacement, the
 *   replaced provider's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 */
export function registerRows(provider: RowProvider): () => void {
  // Attribution is a wrapper, not part of the store: the plugin gets ONE INTEGRATIONS line from any
  // number of registrations (`./plugin-lines.ts`, I1), and `registerRowsStored` keeps doing exactly
  // what it did — including throwing a plugin's invalid id back at it.
  return attributeRegistration("rows", provider, undefined, () => {
    assertProviderIdIsFree(provider);
    return registerRowsStored(provider);
  });
}

/**
 * Register one of THIS package's own providers: the same store, the same attribution, without the
 * reservation check below. Internal — `src/index.ts` does not export it, so a plugin cannot reach it.
 */
export function registerBridgeRows(provider: RowProvider): () => void {
  return attributeRegistration("rows", provider, undefined, () => registerRowsStored(provider));
}

/**
 * The provider ids this package owns. They are the bridge's own plumbing — its effect is the tables
 * in `/bridge-status`, and the report filters those exact objects out of `providers`.
 *
 * A plugin that registers one of them is refused, for two reasons that both cost the user something
 * real. The bus answers an id first-come, so a plugin taking `bridge.message-designs` before the
 * bridge does either keeps the bridge's line off the menu until it lets go, or is silently replaced
 * by it — and a plugin that takes the id and gives it back AFTER a design registered leaves the line
 * uninstalled for the rest of the process. Refusing the id at the door is the only answer that cannot
 * strand a switch.
 */
const RESERVED_ROW_PROVIDER_IDS: ReadonlySet<string> = new Set([
  // The literals of `SECTION_ROWS_PROVIDER_ID`, `CARD_STYLE_ROWS_PROVIDER_ID`,
  // `TOOL_DESIGN_ROWS_PROVIDER_ID` and `MESSAGE_DESIGN_ROWS_PROVIDER_ID`. Spelled here because those
  // modules import THIS one, so importing their constants would close a cycle.
  "bridge.sections",
  "bridge.card-styles",
  "bridge.tool-designs",
  "bridge.message-designs",
]);

function assertProviderIdIsFree(provider: RowProvider): void {
  if (!RESERVED_ROW_PROVIDER_IDS.has(provider.id)) return;
  throw new Error(
    `gentle-shell-bridge: cannot register row provider ${JSON.stringify(provider.id)}: that id ` +
      "belongs to the bridge's own line, so a plugin using it would take that line off the menu or " +
      "be silently replaced by it. Register your rows under an id of your own, e.g. " +
      '"loon.rows".',
  );
}

/**
 * `Keymaps` is the host's own interaction (S15), not one of its setting pages: its rows capture the
 * next key press, write `keymaps.json` and get a category footer that promises `Enter assign`
 * (`lib/keymaps-customize.ts:49-68`, `lib/visual-customize-view.ts:40`). A plugin row there would be
 * advertised as an assignable binding and could never honour it, so the page is reserved and the
 * provider is refused BEFORE anything is stored.
 *
 * The throw is the refusal: `attributeRegistration` is the boundary every registration already goes
 * through, so the refusal lands in the plugin's INTEGRATIONS line as a rejected registration (the
 * same line, and the same `degraded` state, as an invalid id) and in `/bridge-status`. Nothing is
 * stored, so a refused provider can never reach a menu build. A row that carries the reserved
 * category ITSELF is refused per row at build time instead, so its siblings survive (`./rows.ts`).
 */
function assertRowProviderCategory(provider: RowProvider): void {
  const reserved = reservedCategory(provider.category);
  if (reserved === undefined) return;
  throw new Error(
    `gentle-shell-bridge: cannot register row provider ${JSON.stringify(provider.id)}: its ` +
      `category ${JSON.stringify(String(provider.category))} is the reserved category ` +
      `${JSON.stringify(reserved)}. ${reserved} ${RESERVED_CATEGORY_RULE}. Place the rows in one of ` +
      `the host's other categories, e.g. "Cards".`,
  );
}

function registerRowsStored(provider: RowProvider): () => void {
  assertRowProviderCategory(provider);
  // A row `placement` the bridge cannot honour is reported and IGNORED, never thrown: refusing the
  // whole provider over it would cost the user its rows. It lands at the end, which is the
  // historical default (S5).
  const placementFault = rowPlacementProblem(provider.placement);
  if (placementFault === undefined) clearRowPlacementRejection(provider.id);
  else {
    recordRowPlacementRejection({
      providerId: provider.id,
      value: describeValue(provider.placement),
      reason: placementFault,
    });
  }
  const state = bus();
  const entry: BusEntry = { provider };
  const index = state.entries.findIndex((candidate) => candidate.provider.id === provider.id);
  if (index === -1) state.entries.push(entry);
  else state.entries[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.entries.indexOf(entry);
    if (current !== -1) {
      state.entries.splice(current, 1);
      // The record describes THIS registration, which is gone now; a stale disposer (after a
      // same-id replacement) must not clear the replacement's record instead.
      clearRowPlacementRejection(provider.id);
    }
  };
}

/**
 * An ordered snapshot of the registered providers. The array is a fresh copy, so a fan-out
 * that iterates it sees a stable list even if a provider registers or disposes mid-iteration.
 */
export function snapshotProviders(): RowProvider[] {
  return bus().entries.map((entry) => entry.provider);
}

/**
 * Test-only seam: empties the process-global bus in place. Deliberately not re-exported from
 * `src/index.ts`, so it is unreachable from the package's public entry.
 */
export function resetBusForTests(): void {
  const state = bus();
  state.entries.length = 0;
  state.rowPlacementRejections.length = 0;
  state.rowPlacementLandings.length = 0;
  delete state.observedHostCategories;
}

/**
 * Record the host's own category names as the last capture observed them, so `/bridge-status` can
 * resolve a row placement against the pages the host really built. The capture backend is the
 * writer (T2); a caller can pass the set in any order, because `resolveRowPlacements` normalizes it.
 */
export function recordObservedHostCategories(categories: readonly string[]): void {
  bus().observedHostCategories = categories.filter(
    (category): category is string => typeof category === "string",
  );
}

/** The host categories the last capture observed, or `[]` before one (a fresh copy). */
export function observedHostCategories(): string[] {
  return [...(bus().observedHostCategories ?? [])];
}

/** One row provider's block: where it asked to sit and where it really lands (S1–S3, S5). */
export interface RowPlacementResolution {
  provider: RowProvider;
  /** The category whose page carries this block. */
  category: string;
  /** What the plugin asked for, as a person reads it: `start`, `end`, `after "loon.news"`. */
  requested: string;
  /** What the block hangs off in its category: `start`, `end`, or `"<provider id>"`. */
  anchor: string;
  /** Why the block is not where it asked to be; absent when the request was honoured. */
  reason?: string;
}

/**
 * A row `placement` the bridge cannot honour, kept verbatim so the author can find it (S5). The
 * provider still registers — a field the bridge can ignore must never cost the whole block — and
 * it is placed at the end, which is what `/bridge-status` says next to this record.
 */
export interface RowPlacementRejection {
  providerId: string;
  /** The value as JSON, exactly as far as a report can show it. Never rewritten. */
  value: string;
  /** One sentence naming the shape that was expected. */
  reason: string;
}

/** Where one provider block REALLY landed in the last menu build (S5), not where it asked to sit. */
export interface RowPlacementLandingRecord {
  providerId: string;
  /** The row's actual category, which may differ from the provider's declared one. */
  category: string;
  /** The request as a person reads it: `start`, `end`, `after "loon.news"`. */
  requested: string;
  /** The real landing: `start`, `end`, `after "loon.news"`, or `end` after a skipped move. */
  landed: string;
  /** Why it is not where it asked to be; the resolver's exact reason, or why the move was skipped. */
  reason?: string;
}

/** The rule, quoted by every rejection so the message stands on its own. */
const ROW_PLACEMENT_RULE =
  'placement must be "start", "end", or { after: "<row provider id>" }';

/**
 * What is wrong with one row `placement`, or `undefined` when the bridge can honour it.
 *
 * Checked in a fixed order — the shape, then the `after` string, then its own shape — so the
 * reported reason is deterministic instead of depending on how a bad value was built. One rule for
 * the registration (nothing is thrown) and for the resolver, which must survive a value a
 * registration refused, because a plugin can hand the provider object over and mutate it later.
 */
function rowPlacementProblem(value: unknown): string | undefined {
  // Absent is the default, `"end"`: a provider that names no placement is conforming, not faulty.
  if (value === undefined) return undefined;
  if (value === "start" || value === "end") return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `it is ${describeValue(value)}; ${ROW_PLACEMENT_RULE}`;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "after") {
    return "an object placement carries exactly one field, `after`, naming the id of a registered row provider";
  }
  // SAFETY: the object has exactly the own key `after`, which is what is read here.
  const target = (value as { after: unknown }).after;
  if (typeof target !== "string" || target.trim() === "") {
    return `after is ${describeValue(target)}; after must be a non-empty string naming the id of a registered row provider`;
  }
  return undefined;
}

/** Replace the record for one provider, so a corrected registration stops being reported. */
function recordRowPlacementRejection(rejection: RowPlacementRejection): void {
  const state = bus();
  const index = state.rowPlacementRejections.findIndex(
    (candidate) => candidate.providerId === rejection.providerId,
  );
  if (index === -1) state.rowPlacementRejections.push(rejection);
  else state.rowPlacementRejections[index] = rejection;
}

function clearRowPlacementRejection(providerId: string): void {
  const rejections = bus().rowPlacementRejections;
  for (let index = rejections.length - 1; index >= 0; index -= 1) {
    if (rejections[index].providerId === providerId) rejections.splice(index, 1);
  }
}

/** Every row `placement` a registration had to refuse, for `/bridge-status`. A fresh copy. */
export function getRowPlacementRejections(): RowPlacementRejection[] {
  return bus().rowPlacementRejections.map((rejection) => ({ ...rejection }));
}

/** Record the ACTUAL landings of one menu build, so the report never repeats a skipped plan (S5). */
export function recordRowPlacementLandings(
  landings: readonly RowPlacementLandingRecord[],
): void {
  bus().rowPlacementLandings = landings.map((landing) => ({ ...landing }));
}

/** The landings of the last menu build. A fresh copy. */
export function getRowPlacementLandings(): RowPlacementLandingRecord[] {
  return bus().rowPlacementLandings.map((landing) => ({ ...landing }));
}

/** One provider's placement as a phrase: `start`, `end`, `after "loon.news"`. */
export function requestedRowPlacementText(provider: RowProvider): string {
  const placement = provider.placement;
  if (placement === undefined || placement === "end") return "end";
  if (placement === "start") return "start";
  if (placement !== null && typeof placement === "object" && typeof placement.after === "string") {
    return `after ${JSON.stringify(placement.after)}`;
  }
  return describeValue(placement);
}

/** Where one row landing reads as: `start`, `end`, `after "loon.news"`. */
export function rowPlacementLandingText(
  landing: Pick<RowPlacementResolution, "anchor">,
): string {
  if (landing.anchor === "start" || landing.anchor === "end") return landing.anchor;
  return `after ${landing.anchor}`;
}

/** What one row block hangs off, before the category turns it into a landing. */
type RowPlacementAnchor =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "provider"; id: string };

/** Group key for one anchor: tagged, because a provider id may itself read `start` or `end`. */
function rowAnchorKey(anchor: RowPlacementAnchor): string {
  if (anchor.kind === "provider") return `provider:${anchor.id}`;
  return anchor.kind;
}

/** An anchor as a person reads it: `start`, `end`, `"loon.news"`. */
function rowAnchorText(anchor: RowPlacementAnchor): string {
  if (anchor.kind === "provider") return JSON.stringify(anchor.id);
  return anchor.kind;
}

interface RowDirectPlacement {
  anchor: RowPlacementAnchor;
  reason?: string;
}

/** What one provider asked for, before cycles are broken and categories are resolved. */
function rowDirectPlacement(
  provider: RowProvider,
  category: string,
  ownIds: ReadonlySet<string>,
  categoriesById: ReadonlyMap<string, ReadonlySet<string>>,
  hostBuilt: boolean,
): RowDirectPlacement {
  const placement = provider.placement;
  if (placement === undefined || placement === "end") return { anchor: { kind: "end" } };
  const problem = rowPlacementProblem(placement);
  if (problem !== undefined) {
    return { anchor: { kind: "end" }, reason: `its placement is malformed (${problem})` };
  }
  if (placement === "start") {
    if (!hostBuilt) {
      return {
        anchor: { kind: "end" },
        reason: `the host did not build the category ${JSON.stringify(category)}, so it has no first row to sit before; it landed at the end`,
      };
    }
    return { anchor: { kind: "start" } };
  }
  // SAFETY: `rowPlacementProblem` accepted the value, so it is the `{ after }` shape.
  const target = (placement as { after: string }).after;
  if (!hostBuilt) {
    return {
      anchor: { kind: "end" },
      reason: `the host did not build the category ${JSON.stringify(category)}, so after ${JSON.stringify(target)} cannot be honoured; it landed at the end`,
    };
  }
  if (ownIds.has(target)) return { anchor: { kind: "provider", id: target } };
  const targetCategories = categoriesById.get(target);
  if (targetCategories !== undefined && targetCategories.size > 0) {
    const otherCategory =
      [...targetCategories].sort(compareProviderIds).find((candidate) => candidate !== category) ??
      category;
    return {
      anchor: { kind: "end" },
      reason: `after ${JSON.stringify(target)} is in the category ${JSON.stringify(otherCategory)}, not ${JSON.stringify(category)}`,
    };
  }
  return {
    anchor: { kind: "end" },
    reason: `after ${JSON.stringify(target)} is not a registered row provider id`,
  };
}

/** A provider id compare: UTF-16 code units, never a locale collation (S2). */
function compareProviderIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A provider whose `order` is a usable sort key; `NaN`, `Infinity` and a missing value are not. */
function sortableRowOrder(provider: RowProvider): number | undefined {
  return typeof provider.order === "number" && Number.isFinite(provider.order)
    ? provider.order
    : undefined;
}

/** The S2 order inside one slot: finite `order` first, ascending, then every tie by `id`. */
function compareRowProviders(a: RowProvider, b: RowProvider): number {
  const orderA = sortableRowOrder(a);
  const orderB = sortableRowOrder(b);
  if (orderA !== undefined && orderB !== undefined) {
    if (orderA !== orderB) return orderA - orderB;
  } else if (orderA !== undefined) {
    return -1;
  } else if (orderB !== undefined) {
    return 1;
  }
  return compareProviderIds(a.id, b.id);
}

/**
 * Every row block's landing, grouped by category and in DRAW order (S1–S3, S5): the answer both the
 * capture backend and `/bridge-status` read, so a report and a menu cannot disagree.
 *
 * Pure by construction: it takes the registrations and the host's categories, and nothing else.
 * Where a block goes is decided from those two lists alone, never from the order the plugins loaded
 * in:
 *
 * - within one slot, providers with a finite `order` come first, ascending, then the rest, and ties
 *   are broken by `id` compared as UTF-16 code units (S2) — the input order does not matter;
 * - placement is resolved WITHIN the category a block actually belongs to (S4): `categoriesByProvider`
 *   lets the capture pass the rows' real categories (`row.category ?? provider.category`), so a
 *   provider contributing to two categories is one block in each; `start` is before that category's
 *   first row, `end` after its own rows, and every provider id is a slot whose followers draw right
 *   after its block, so chains resolve transitively and several providers asking for the same `X`
 *   form one block (S3);
 * - a cycle, a provider after itself, an unknown id, an anchor in another category, and `start` or
 *   `after` in a category the host did not build all fall back to `"end"` with a reason — never a
 *   throw, never a vanished block (S5);
 * - `hostCategories` is a SET: it is deduplicated and sorted by UTF-16 code units, so a caller
 *   cannot make the answer depend on how it collected the list.
 */
export function resolveRowPlacements(
  providers: readonly RowProvider[],
  hostCategories: readonly string[],
  categoriesByProvider?: ReadonlyMap<string, readonly string[]>,
): RowPlacementResolution[] {
  const hostBuilt = new Set(
    hostCategories.filter((category): category is string => typeof category === "string"),
  );
  const categoriesById = new Map<string, Set<string>>();
  const categories = new Set<string>(hostBuilt);
  for (const provider of providers) {
    const declared = categoriesByProvider?.get(provider.id) ?? [provider.category];
    const actual = new Set(declared.filter((category) => typeof category === "string"));
    if (actual.size === 0) actual.add(provider.category);
    categoriesById.set(provider.id, actual);
    for (const category of actual) categories.add(category);
  }

  const out: RowPlacementResolution[] = [];
  // A deterministic category order: the host's pages and the plugin-created ones together, sorted
  // by code unit, so collecting the host set differently cannot reorder the result.
  for (const category of [...categories].sort(compareProviderIds)) {
    const own = providers.filter((provider) => categoriesById.get(provider.id)?.has(category));
    if (own.length === 0) continue;
    const ownIds = new Set(own.map((provider) => provider.id));
    const built = hostBuilt.has(category);

    const anchors = new Map<string, RowDirectPlacement>();
    for (const provider of own) {
      anchors.set(
        provider.id,
        rowDirectPlacement(provider, category, ownIds, categoriesById, built),
      );
    }
    for (const id of rowCycleMembers(own, anchors)) {
      anchors.set(id, {
        anchor: { kind: "end" },
        reason: "it would sit after itself: a placement cycle falls back to the end",
      });
    }

    const groups = new Map<string, RowProvider[]>();
    for (const provider of own) {
      const anchor = anchors.get(provider.id)?.anchor ?? { kind: "end" as const };
      const key = rowAnchorKey(anchor);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [provider]);
      else group.push(provider);
    }
    for (const group of groups.values()) group.sort(compareRowProviders);

    const visited = new Set<string>();
    const emit = (key: string): void => {
      if (visited.has(key)) return;
      visited.add(key);
      const group = groups.get(key);
      if (group === undefined) return;
      for (const provider of group) {
        const direct = anchors.get(provider.id) ?? { anchor: { kind: "end" as const } };
        out.push({
          provider,
          category,
          requested: requestedRowPlacementText(provider),
          anchor: rowAnchorText(direct.anchor),
          ...(direct.reason === undefined ? {} : { reason: direct.reason }),
        });
        emit(`provider:${provider.id}`);
      }
    };

    emit("start");
    emit("end");
    // Cycles are gone, so every block was reached above. Emitting any remaining key in a
    // deterministic order keeps a future anchor shape from silently dropping a block.
    for (const key of [...groups.keys()].sort(compareProviderIds)) emit(key);
  }

  return out;
}

/**
 * The providers that are part of a placement cycle (A after B after A, or A after itself). Every
 * other provider is left alone: a chain that merely LEADS into a cycle is resolved through it
 * after the cycle members have fallen back to the end.
 */
function rowCycleMembers(
  providers: readonly RowProvider[],
  anchors: ReadonlyMap<string, RowDirectPlacement>,
): string[] {
  const settled = new Set<string>();
  const members = new Set<string>();
  for (const provider of providers) {
    const chain: string[] = [];
    let current: string | undefined = provider.id;
    while (current !== undefined && !settled.has(current)) {
      const repeat = chain.indexOf(current);
      if (repeat !== -1) {
        for (const id of chain.slice(repeat)) members.add(id);
        break;
      }
      chain.push(current);
      const anchor: RowPlacementAnchor | undefined = anchors.get(current)?.anchor;
      current = anchor?.kind === "provider" ? anchor.id : undefined;
    }
    for (const id of chain) settled.add(id);
  }
  return [...members];
}

/**
 * Register a sidebar section and return a disposer that removes exactly that section.
 *
 * Same entry discipline as `registerRows`, because a plugin author should not have to learn two:
 *
 * - A second registration with an existing `id` replaces the previous one *in place*, so the
 *   section keeps the position its registration earned (ordering is computed in
 *   `snapshotSections`, so a replacement that changes `order` moves the section on the next read).
 * - The returned disposer removes only the registration it created: after a same-id replacement the
 *   replaced section's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 *
 * The disposer removes the section from the rail and from `Sections` together, because both surfaces
 * are built from this one registration.
 */
/** Ids that collide with `Object.prototype` and therefore cannot be used as a plain-object key. */
const RESERVED_REGISTRATION_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * An id is identity: it keys the ordering, the replacement and the persisted value. A bad id is a
 * plugin bug and is rejected with a clear error BEFORE anything is stored, so a rejected
 * registration can never half-register (B2). One rule for every surface, so a plugin author does
 * not have to learn two.
 */
function registrationIdProblem(id: unknown): string | undefined {
  if (typeof id !== "string") return "it must be a non-empty string";
  if (id.trim() === "") return "it must be a non-empty string";
  if (RESERVED_REGISTRATION_IDS.has(id)) return "it collides with Object.prototype";
  if (id.includes("\0")) return "it contains a NUL byte";
  return undefined;
}

/** Throws the surface-specific message; `kind` names the thing in both the message and the rule. */
export function assertRegistrationId(kind: string, id: unknown): asserts id is string {
  const problem = registrationIdProblem(id);
  if (problem === undefined) return;
  throw new Error(
    `gentle-shell-bridge: invalid ${kind} id ${JSON.stringify(id)}: ${problem}. ` +
      `A ${kind} id must be a non-empty string that can be used as a plain object key.`,
  );
}

function assertSectionId(id: unknown): asserts id is string {
  assertRegistrationId("section", id);
}

/**
 * `rowLabel`, when present, is text a human reads in the menu, so an empty one is a plugin bug and
 * is rejected before anything is stored — the same discipline as the id.
 */
function assertRowLabel(kind: string, id: string, rowLabel: unknown): void {
  if (rowLabel === undefined) return;
  if (typeof rowLabel !== "string" || rowLabel.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid ${kind} rowLabel for ${JSON.stringify(id)}: it must be a ` +
        "non-empty string. It is the text a user reads in the menu; the id stays internal. Omit it " +
        "to let the bridge derive a label from the visible text instead.",
    );
  }
}

export function registerSection(section: SidebarSection): () => void {
  return attributeRegistration("section", section, "section", () => registerSectionStored(section));
}

function registerSectionStored(section: SidebarSection): () => void {
  assertSectionId(section.id);
  assertRowLabel("section", section.id, section.rowLabel);
  // The label is what a user reads, so it obeys the row-name shape before anything is stored (N8):
  // `Music: now playing` is rejected here, reported by `/bridge-status`, and never rewritten. A
  // DERIVED label cannot fail this check — derivation applies the same shape (`./row-labels.ts`).
  if (rejectRowName("section", section.id, "row label", sectionRowLabelText(section))) {
    return () => {};
  }
  // The name in force now conforms, so a record left by the name it replaced is no longer true.
  clearRowNameRejections("section", section.id);
  // A `placement` the bridge cannot honour is reported and IGNORED, never thrown: it names where the
  // card goes, and refusing the whole section over it would cost the user their card. It lands at the
  // end, which is the historical default (S5).
  const placementFault = placementProblem(section.placement);
  if (placementFault === undefined) clearPlacementRejection(section.id);
  else {
    recordPlacementRejection({
      sectionId: section.id,
      value: describeValue(section.placement),
      reason: placementFault,
    });
  }
  const state = bus();
  const entry: SectionEntry = { section };
  const index = state.sections.findIndex((candidate) => candidate.section.id === section.id);
  if (index === -1) state.sections.push(entry);
  else state.sections[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.sections.indexOf(entry);
    if (current !== -1) state.sections.splice(current, 1);
  };
}

/** One section's landing: where its block of rows hangs in the rail (S1–S3, S5). */
export interface SectionPlacementResolution {
  section: SidebarSection;
  /** What the plugin asked for, as a person reads it: `start`, `end`, `after "loon.news"`. */
  requested: string;
  /** The painted rail part whose own rows it draws around. */
  part: RailPart;
  /** `before` draws above that part's own rows, `after` below them. */
  side: "before" | "after";
  /** What the block hangs off: `start`, `end`, a native rail part, or `"<section id>"`. */
  anchor: string;
  /** Why the card is not where it asked to be; absent when the request was honoured. */
  reason?: string;
}

/**
 * A `placement` the bridge cannot honour, kept verbatim so the author can find it (S5). The section
 * still registers — a field the bridge can ignore must never cost the whole card — and it is placed
 * at the end, which is what `/bridge-status` says next to this record.
 */
export interface SectionPlacementRejection {
  sectionId: string;
  /** The value as JSON, exactly as far as a report can show it. Never rewritten. */
  value: string;
  /** One sentence naming the shape that was expected. */
  reason: string;
}

/** The rule, quoted by every rejection so the message stands on its own. */
const PLACEMENT_RULE =
  'placement must be "start", "end", or { after: "<section id or native rail part>" }';

/**
 * What is wrong with one `placement`, or `undefined` when the bridge can honour it.
 *
 * Checked in a fixed order — the shape, then the `after` string, then its own shape — so the
 * reported reason is deterministic instead of depending on how a bad value was built. One rule for
 * the registration (`./bus.ts` stores nothing) and for the resolver, which must survive a value a
 * registration refused, because a plugin can hand the section object over and mutate it later.
 */
function placementProblem(value: unknown): string | undefined {
  // Absent is the default, `"end"`: a section that names no placement is conforming, not faulty.
  if (value === undefined) return undefined;
  if (value === "start" || value === "end") return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `it is ${describeValue(value)}; ${PLACEMENT_RULE}`;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "after") {
    return 'an object placement carries exactly one field, `after`, naming a section id or one of "todo", "jobs", "agents", "footer"';
  }
  // SAFETY: the object has exactly the own key `after`, which is what is read here.
  const target = (value as { after: unknown }).after;
  if (typeof target !== "string" || target.trim() === "") {
    return `after is ${describeValue(target)}; after must be a non-empty string naming a section id or one of "todo", "jobs", "agents", "footer"`;
  }
  return undefined;
}

/** A value as a short, safe phrase for a message: the JSON when it has one, its type otherwise. */
function describeValue(value: unknown): string {
  if (value === undefined) return "absent";
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // A cyclic or otherwise unprintable value falls through to its type.
  }
  return `a ${typeof value}`;
}

/** Replace the record for one section, so a corrected registration stops being reported. */
function recordPlacementRejection(rejection: SectionPlacementRejection): void {
  const state = bus();
  const index = state.placementRejections.findIndex(
    (candidate) => candidate.sectionId === rejection.sectionId,
  );
  if (index === -1) state.placementRejections.push(rejection);
  else state.placementRejections[index] = rejection;
}

function clearPlacementRejection(sectionId: string): void {
  const rejections = bus().placementRejections;
  for (let index = rejections.length - 1; index >= 0; index -= 1) {
    if (rejections[index].sectionId === sectionId) rejections.splice(index, 1);
  }
}

/** Every `placement` a registration had to refuse, for `/bridge-status`. A fresh copy. */
export function getSectionPlacementRejections(): SectionPlacementRejection[] {
  return bus().placementRejections.map((rejection) => ({ ...rejection }));
}

/** One section's placement as a phrase: `start`, `end`, `after "loon.news"`. */
export function requestedPlacementText(section: SidebarSection): string {
  const placement = section.placement;
  if (placement === undefined || placement === "end") return "end";
  if (placement === "start") return "start";
  if (placement !== null && typeof placement === "object" && typeof placement.after === "string") {
    return `after ${JSON.stringify(placement.after)}`;
  }
  return describeValue(placement);
}

/** Where one landing reads as: `before todo`, `after footer`. */
export function placementLandingText(landing: Pick<SectionPlacementResolution, "part" | "side">): string {
  return `${landing.side} ${landing.part}`;
}

/** What a section's rows hang off, before the rail turns it into a part. */
type PlacementAnchor =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "part"; part: RailPart }
  | { kind: "section"; id: string };

/** Group key for one anchor: tagged, because a section id may itself read `start`, `end` or `todo`. */
function anchorKey(anchor: PlacementAnchor): string {
  if (anchor.kind === "part") return `part:${anchor.part}`;
  if (anchor.kind === "section") return `section:${anchor.id}`;
  return anchor.kind;
}

/** An anchor as a person reads it: `start`, `end`, `todo`, `"loon.news"`. */
function anchorText(anchor: PlacementAnchor): string {
  if (anchor.kind === "part") return anchor.part;
  if (anchor.kind === "section") return JSON.stringify(anchor.id);
  return anchor.kind;
}

/** Whether a string names a native rail part. A native part wins over a section that shares the id. */
function nativePart(value: string): RailPart | undefined {
  return (RAIL_PARTS as readonly string[]).includes(value) ? (value as RailPart) : undefined;
}

interface DirectPlacement {
  anchor: PlacementAnchor;
  reason?: string;
}

/** What one section asked for, before cycles are broken and parts are resolved. */
function directPlacement(section: SidebarSection, ids: ReadonlySet<string>): DirectPlacement {
  const placement = section.placement;
  if (placement === undefined || placement === "end") return { anchor: { kind: "end" } };
  if (placement === "start") return { anchor: { kind: "start" } };
  const problem = placementProblem(placement);
  if (problem !== undefined) {
    return { anchor: { kind: "end" }, reason: `its placement is malformed (${problem})` };
  }
  // SAFETY: `placementProblem` accepted the value, so it is the `{ after }` shape.
  const target = (placement as { after: string }).after;
  const part = nativePart(target);
  if (part !== undefined) {
    return {
      anchor: { kind: "part", part },
      // A section id is free to be `todo`, so one string can name a section AND a native part. The
      // native part wins, and the report says why instead of leaving the author to guess.
      ...(ids.has(target)
        ? {
            reason: `the native rail part ${JSON.stringify(target)} wins over the section with the same id`,
          }
        : {}),
    };
  }
  if (ids.has(target)) return { anchor: { kind: "section", id: target } };
  return {
    anchor: { kind: "end" },
    reason: `after ${JSON.stringify(target)} is neither a registered section nor a native rail part`,
  };
}

/**
 * Every section's landing, in DRAW order (S1–S3, S5): the answer both the renderer and
 * `/bridge-status` read, so a report and a frame cannot disagree.
 *
 * Pure by construction: it takes the registrations and the painted parts, and nothing else. Where a
 * block goes is decided from those two lists alone, never from the order the plugins loaded in:
 *
 * - within one slot, sections with a finite `order` come first, ascending, then the rest, and ties
 *   are broken by `id` compared as UTF-16 code units (S2) — the input order does not matter;
 * - `"start"` is one slot, each native part is one slot, `"end"` is one slot, and every section id
 *   is one slot: a section asking for `after` X joins X's slot and draws right after X (S3);
 * - a slot is resolved by render, never by registration (S5): an anchor that draws nothing keeps
 *   its place, so hiding a section does not move its followers; a native part that is not painted
 *   falls forward to the next painted one, ending at `footer`; a cycle, a section after itself, or
 *   an anchor nobody registered falls back to `"end"` with a reason. `"end"` itself is the `footer`
 *   part, exactly as before this field existed: only `"start"` and a native anchor need to know
 *   which parts the host paints.
 *
 * `painted` is the parts the host actually paints this frame, in any order; it is normalized against
 * `RAIL_PARTS`, so a caller cannot make the rail order depend on how it collected the list.
 */
export function resolveSectionPlacements(
  sections: readonly SidebarSection[],
  painted: readonly RailPart[],
): SectionPlacementResolution[] {
  const paintedParts = RAIL_PARTS.filter((part) => painted.includes(part));
  const firstPainted = paintedParts[0];
  const ids = new Set(sections.map((section) => section.id));

  const anchors = new Map<string, DirectPlacement>();
  for (const section of sections) {
    anchors.set(section.id, directPlacement(section, ids));
  }

  // A cycle is not a placement: every section IN it falls back to the end. A section leading INTO
  // one resolves through its anchor, which is now the end, so it lands there too and keeps its own
  // request honoured.
  for (const id of cycleMembers(sections, anchors)) {
    anchors.set(id, {
      anchor: { kind: "end" },
      reason: "it would sit after itself: a placement cycle falls back to the end",
    });
  }

  /**
   * Where one anchor's block lands. A section anchor lands where ITS anchor lands, so a chain of
   * `after` requests resolves transitively; the cycles are already gone, so this terminates.
   */
  const landings = new Map<string, { part: RailPart; side: "before" | "after" }>();
  const landingOf = (anchor: PlacementAnchor): { part: RailPart; side: "before" | "after" } => {
    const key = anchorKey(anchor);
    const known = landings.get(key);
    if (known !== undefined) return known;
    const landing = computeLanding(anchor);
    landings.set(key, landing);
    return landing;
  };

  const computeLanding = (
    anchor: PlacementAnchor,
  ): { part: RailPart; side: "before" | "after" } => {
    if (anchor.kind === "start") {
      // Before the first painted native part; with nothing painted, after the last one there is.
      return firstPainted === undefined
        ? { part: "footer", side: "after" }
        : { part: firstPainted, side: "before" };
    }
    if (anchor.kind === "end") {
      // After every native section, which IS the footer part: `{ after: "footer" }` and `"end"` are
      // the same placement (S4), and a part that paints no frame draws none of our rows — exactly
      // the rule this surface always had, so a rail whose footer is hidden loses nothing new.
      return { part: "footer", side: "after" };
    }
    if (anchor.kind === "section") {
      const target = anchors.get(anchor.id);
      return target === undefined
        ? { part: "footer", side: "after" }
        : landingOf(target.anchor);
    }
    // A native part: after its own rows when it is painted, otherwise the next painted slot after
    // it, ending at `footer` (S5).
    if (paintedParts.includes(anchor.part)) return { part: anchor.part, side: "after" };
    const at = RAIL_PARTS.indexOf(anchor.part);
    const next = paintedParts.find((part) => RAIL_PARTS.indexOf(part) > at);
    return { part: next ?? "footer", side: "after" };
  };

  // The blocks, in the S2 order the input already carries: one list per anchor.
  const groups = new Map<string, SidebarSection[]>();
  for (const section of sections) {
    const anchor = anchors.get(section.id)?.anchor ?? { kind: "end" };
    const key = anchorKey(anchor);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [section]);
    else group.push(section);
  }

  const out: SectionPlacementResolution[] = [];
  const visited = new Set<string>();

  /**
   * Why a landing is not the one the request named, when the reason comes from the RENDER (a native
   * part the host does not paint, or a rail with nothing painted at all) rather than from the shape
   * of the request itself.
   */
  const landingReason = (anchor: PlacementAnchor): string | undefined => {
    if (anchor.kind === "start" && paintedParts.length === 0) {
      return "no native rail part is painted, so it landed at the end";
    }
    if (anchor.kind === "part" && !paintedParts.includes(anchor.part)) {
      return `the native rail part ${JSON.stringify(anchor.part)} is not painted; it landed ${placementLandingText(
        landingOf(anchor),
      )}`;
    }
    return undefined;
  };

  /** Emit one block and, right after each of its sections, that section's own followers. */
  const emit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const group = groups.get(key);
    if (group === undefined) return;
    for (const section of group) {
      const direct = anchors.get(section.id) ?? { anchor: { kind: "end" as const } };
      const landing = landingOf(direct.anchor);
      const reason = direct.reason ?? landingReason(direct.anchor);
      out.push({
        section,
        requested: requestedPlacementText(section),
        part: landing.part,
        side: landing.side,
        anchor: anchorText(direct.anchor),
        ...(reason === undefined ? {} : { reason }),
      });
      emit(`section:${section.id}`);
    }
  };

  emit("start");
  // Every native part is emitted, painted or not: a block anchored at a part the host does not paint
  // still exists, and it draws where the landing put it. `RAIL_PARTS` order keeps two blocks that
  // land on the same rows in one deterministic order, and `end` stays last.
  for (const part of RAIL_PARTS) emit(`part:${part}`);
  emit("end");

  return out;
}

/**
 * The sections that are part of a placement cycle (A after B after A, or A after itself). Every
 * other section is left alone: a chain that merely LEADS into a cycle is resolved through it after
 * the cycle members have fallen back to the end.
 */
function cycleMembers(
  sections: readonly SidebarSection[],
  anchors: ReadonlyMap<string, DirectPlacement>,
): string[] {
  const settled = new Set<string>();
  const members = new Set<string>();
  for (const section of sections) {
    const chain: string[] = [];
    let current: string | undefined = section.id;
    while (current !== undefined && !settled.has(current)) {
      const repeat = chain.indexOf(current);
      if (repeat !== -1) {
        for (const id of chain.slice(repeat)) members.add(id);
        break;
      }
      chain.push(current);
      const anchor: PlacementAnchor | undefined = anchors.get(current)?.anchor;
      current = anchor?.kind === "section" ? anchor.id : undefined;
    }
    for (const id of chain) settled.add(id);
  }
  return [...members];
}

/** A section id compare: UTF-16 code units, never a locale collation (S2). */
function compareSectionIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The rendering order of every registered section: those with an `order` first, ascending, then the
 * rest, and every tie broken by `id` compared as UTF-16 code units (S2).
 *
 * The registration index is deliberately NOT part of the sort. The same set of registrations has to
 * draw the same rail in any load order — a user's sidebar must not depend on which plugin Pi
 * happened to load first — so equal values are resolved by the one key that is identity. Both halves
 * are computed from the registration list, never from `Map` iteration, and the array is a fresh copy,
 * so a fan-out that iterates it sees a stable list even if a section registers or disposes
 * mid-iteration.
 */
export function snapshotSections(): SidebarSection[] {
  const ordered: Array<{ section: SidebarSection; order: number }> = [];
  const rest: SidebarSection[] = [];

  for (const entry of bus().sections) {
    const order = sortableSectionOrder(entry.section);
    if (order === undefined) rest.push(entry.section);
    else ordered.push({ section: entry.section, order });
  }

  ordered.sort((a, b) => a.order - b.order || compareSectionIds(a.section.id, b.section.id));
  rest.sort((a, b) => compareSectionIds(a.id, b.id));
  return [...ordered.map((entry) => entry.section), ...rest];
}

/** A section whose `order` is a usable sort key; `NaN`, `Infinity` and a missing value are not. */
function sortableSectionOrder(section: SidebarSection): number | undefined {
  return typeof section.order === "number" && Number.isFinite(section.order)
    ? section.order
    : undefined;
}

/**
 * Test-only seam for the section list only, so a provider test and a section test do not clear
 * each other's registrations. Like `resetBusForTests`, it is deliberately not re-exported from
 * `src/index.ts`. The placement rejections go with it: they describe the same registrations.
 */
export function resetSectionsForTests(): void {
  bus().sections.length = 0;
  bus().placementRejections.length = 0;
}

/**
 * A card style's `order`, when it has one that can be sorted on. `NaN`, `Infinity` and a missing
 * value are not sort keys: a style with one of those keeps its registration position.
 */
function sortableCardStyleOrder(style: CardStyleRegistration): number | undefined {
  return typeof style.order === "number" && Number.isFinite(style.order) ? style.order : undefined;
}

/** A style's `frame` must be exactly what the transformer calls, or the first render would throw. */
function assertCardFrame(id: string, frame: unknown): void {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    throw new Error(
      `gentle-shell-bridge: invalid card style ${JSON.stringify(id)}: frame must be an object ` +
        "with top, line and bottom functions.",
    );
  }
  for (const member of ["top", "line", "bottom"] as const) {
    if (typeof (frame as Record<string, unknown>)[member] !== "function") {
      throw new Error(
        `gentle-shell-bridge: invalid card style ${JSON.stringify(id)}: frame.${member} must be a ` +
          "function. A style draws chrome and nothing else (S2).",
      );
    }
  }
}

function assertCardStyleLabel(id: string, label: unknown): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(
      `gentle-shell-bridge: invalid card style ${JSON.stringify(id)}: label must be a non-empty ` +
        "string. It is the text the user reads on the Card style line, so keep it short.",
    );
  }
}

/**
 * The label is what the user sees, so two styles showing the same text cannot be told apart (S13).
 *
 * Rejected before anything is stored: an equal label of another REGISTERED style (the same id
 * re-registering keeps its own label, because it replaces itself) and any of the host's own values,
 * which the host renders verbatim on the same line. The comparison is exact — case-sensitive, the
 * way the host displays the string — so `cute` and `Cute` are two different visible values.
 */
function assertCardStyleLabelIsDistinct(style: CardStyleRegistration): void {
  if ((HOST_CARD_STYLE_VALUES as readonly string[]).includes(style.label)) {
    throw new Error(
      `gentle-shell-bridge: invalid card style label ${JSON.stringify(style.label)} for ` +
        `${JSON.stringify(style.id)}: it is one of the host's own values ` +
        `(${HOST_CARD_STYLE_VALUES.join(", ")}), so the Card style line would show it twice. ` +
        "Pick a distinct label.",
    );
  }
  const clash = snapshotCardStyles().find(
    (candidate) => candidate.id !== style.id && candidate.label === style.label,
  );
  if (clash !== undefined) {
    throw new Error(
      `gentle-shell-bridge: invalid card style label ${JSON.stringify(style.label)} for ` +
        `${JSON.stringify(style.id)}: it is already used by ${JSON.stringify(clash.id)}. Two values ` +
        "reading the same cannot be told apart on the Card style line. Pick a distinct label.",
    );
  }
}

/**
 * Register a card style and return a disposer that removes exactly that style (S1, S12).
 *
 * Same entry discipline as providers and sections, because a plugin author should not have to learn
 * two:
 *
 * - A second registration with an existing `id` replaces the previous one IN PLACE, so the style
 *   keeps the position its registration earned and there is still exactly one value on the line.
 *   Two plugins cannot both own `loon.cute`: the later registration wins.
 * - The returned disposer removes only the registration it created: after a same-id replacement the
 *   replaced style's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 * - Validation happens BEFORE anything is stored (id, label, both frames), so a rejected style
 *   never half-registers and never reaches a menu build.
 */
export function registerCardStyle(style: CardStyleRegistration): () => void {
  return attributeRegistration("card style", style, "card style", () =>
    registerCardStyleStored(style),
  );
}

function registerCardStyleStored(style: CardStyleRegistration): () => void {
  assertRegistrationId("card style", style.id);
  if (RESERVED_CARD_STYLE_IDS.has(style.id)) {
    throw new Error(
      `gentle-shell-bridge: invalid card style id ${JSON.stringify(style.id)}: it is already a ` +
        "value of the Card style line (the host's own neon/float, or the bridge's native), so the " +
        "line would show the same value twice. Pick an id of your own, e.g. \"loon.cute\".",
    );
  }
  assertCardStyleLabel(style.id, style.label);
  assertCardStyleLabelIsDistinct(style);
  assertRowLabel("card style", style.id, style.rowLabel);
  // Same rule, same place in the sequence: a row label that breaks the row-name shape is rejected
  // before the style is stored, and `/bridge-status` reports the string and the rule (N8).
  if (rejectRowName("card style", style.id, "row label", cardStyleRowLabelText(style))) {
    return () => {};
  }
  clearRowNameRejections("card style", style.id);
  assertCardFrame(style.id, style.frame);

  const state = bus();
  const entry: CardStyleEntry = { style };
  const index = state.cardStyles.findIndex((candidate) => candidate.style.id === style.id);
  if (index === -1) state.cardStyles.push(entry);
  else state.cardStyles[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.cardStyles.indexOf(entry);
    if (current !== -1) state.cardStyles.splice(current, 1);
  };
}

/**
 * Every registered style, in the order its values appear on the line (S12): styles with an `order`
 * first, ascending, then those without, in registration order.
 *
 * Both halves are computed from the registration list, never from `Map` iteration: the sort is on
 * explicit keys with the registration index as the tiebreak, so equal `order`s and unordered styles
 * are deterministic across sessions and across package copies. The array is a fresh copy, so a
 * caller cannot mutate the registry and a fan-out iterating it sees a stable list even if a style
 * registers or disposes mid-iteration.
 */
export function snapshotCardStyles(): CardStyleRegistration[] {
  const ordered: Array<{ style: CardStyleRegistration; order: number; index: number }> = [];
  const rest: CardStyleRegistration[] = [];

  bus().cardStyles.forEach((entry, index) => {
    const order = sortableCardStyleOrder(entry.style);
    if (order === undefined) rest.push(entry.style);
    else ordered.push({ style: entry.style, order, index });
  });

  ordered.sort((a, b) => a.order - b.order || a.index - b.index);
  return [...ordered.map((entry) => entry.style), ...rest];
}

/**
 * Test-only seam for the card style list only, so a style test and a section test do not clear each
 * other's registrations. Like `resetBusForTests`, it is deliberately not re-exported from
 * `src/index.ts`.
 */
export function resetCardStylesForTests(): void {
  bus().cardStyles.length = 0;
}

/**
 * A transform's `order`, when it has one that can be sorted on. `NaN`, `Infinity` and a missing
 * value are not sort keys: a transform with one of those keeps its registration position.
 */
function sortableTransformOrder(transform: TranscriptTransform): number | undefined {
  return typeof transform.order === "number" && Number.isFinite(transform.order)
    ? transform.order
    : undefined;
}

/**
 * The transform member must be exactly what the pipeline calls, checked before anything is stored:
 * a registration the first frame would throw on is a plugin bug, not a frame's problem.
 */
function assertTransformFunction(id: string, transform: unknown): void {
  if (typeof transform !== "function") {
    throw new Error(
      `gentle-shell-bridge: invalid transform ${JSON.stringify(id)}: transform must be a function `
        + `of (lines, ctx) that returns the lines to draw. A transform rewrites rows; the bridge `
        + `clips them, isolates its throw and reports it in /bridge-status (S1).`,
    );
  }
}

/**
 * Register a transcript transform and return a disposer that removes exactly that transform (S1).
 *
 * Same entry discipline as providers, sections and card styles, because a plugin author should not
 * have to learn two:
 *
 * - A second registration with an existing `id` replaces the previous one IN PLACE, so the
 *   transform keeps the position its registration earned (ordering is computed in
 *   `snapshotTransforms`, so a replacement that changes `order` moves the transform on the next
 *   read). Two plugins cannot both own `loon.restyle`: the later registration wins.
 * - The returned disposer removes only the registration it created: after a same-id replacement the
 *   replaced transform's disposer is a no-op instead of removing the replacement, and calling a
 *   disposer twice does nothing the second time.
 * - Validation happens BEFORE anything is stored (id, `transform`), so a rejected transform never
 *   half-registers and never reaches a frame.
 */
export function registerTransform(transform: TranscriptTransform): () => void {
  return attributeRegistration("transform", transform, undefined, () =>
    registerTransformStored(transform),
  );
}

function registerTransformStored(transform: TranscriptTransform): () => void {
  assertRegistrationId("transform", transform.id);
  assertTransformFunction(transform.id, transform.transform);

  const state = bus();
  const entry: TransformEntry = { transform };
  const index = state.transforms.findIndex((candidate) => candidate.transform.id === transform.id);
  if (index === -1) state.transforms.push(entry);
  else state.transforms[index] = entry;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = state.transforms.indexOf(entry);
    if (current !== -1) state.transforms.splice(current, 1);
  };
}

/**
 * Every registered transform, in pipeline order (S2): transforms with an `order` first, ascending,
 * then those without, in registration order.
 *
 * Both halves are computed from the registration list, never from `Map` iteration: the sort is on
 * explicit keys with the registration index as the tiebreak, so equal `order`s and unordered
 * transforms are deterministic across sessions and across package copies. The array is a fresh
 * copy, so a frame iterating it sees a stable list even if a transform registers or disposes
 * mid-frame.
 */
export function snapshotTransforms(): TranscriptTransform[] {
  const ordered: Array<{ transform: TranscriptTransform; order: number; index: number }> = [];
  const rest: TranscriptTransform[] = [];

  bus().transforms.forEach((entry, index) => {
    const order = sortableTransformOrder(entry.transform);
    if (order === undefined) rest.push(entry.transform);
    else ordered.push({ transform: entry.transform, order, index });
  });

  ordered.sort((a, b) => a.order - b.order || a.index - b.index);
  return [...ordered.map((entry) => entry.transform), ...rest];
}

/**
 * Test-only seam for the transform list only, so a transform test and a section test do not clear
 * each other's registrations. Like `resetBusForTests`, it is deliberately not re-exported from
 * `src/index.ts`.
 */
export function resetTransformsForTests(): void {
  bus().transforms.length = 0;
}

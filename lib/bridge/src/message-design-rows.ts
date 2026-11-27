/**
 * The customize rows for message designs (S1): ONE line per LINE that has designs, in `Cards`.
 *
 * The shape is the tool designs' (`./tool-design-rows.ts`), with one word changed: the values of a
 * message design belong to a MESSAGE line, so the row reads `Message <words>` where a design agent sees
 * `Card <words>`. Everything else is the same discipline, because a plugin author should not have to
 * learn two menus:
 *
 * - **`default` first, stored as `native`.** The user reads `default`; the store keeps identity, so a
 *   renamed label never loses a choice.
 * - **The id is never shown.** A design's `label` is its value and its `id` is what is persisted.
 * - **One line per line.** The host coalesces consecutive rows sharing a `choice.setting`, so all the
 *   values of one line live on one line and the menu does not split per custom type.
 * - **No design, no line.** With nothing registered the provider contributes NOTHING, so a session that
 *   never installed a design plugin gains no empty row.
 * - **A change repaints what is on screen.** The action persists FIRST (the host re-reads `current()`
 *   when it repaints) and then asks for one differential frame; a press that changes nothing costs none.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { registerBridgeRows, snapshotProviders } from "./bus.ts";
import { HOST_CARD_STYLE_CATEGORY } from "./card-style-line.ts";
import { recordNotice } from "./notices.ts";
import { requestRepaint } from "./repaint.ts";
import { deriveRowLabel } from "./row-labels.ts";
import { MAX_ROW_NAME_WORDS } from "./row-names.ts";
import { isRecord } from "./rows.ts";
import {
  MESSAGE_DESIGN_DEFAULT_LABEL,
  MESSAGE_DESIGN_NATIVE,
  getMessageDesignLineSelection,
  messageDesignLines,
  setMessageDesignLineSelection,
  setMessageDesignRowsInstaller,
  type MessageDesignLine,
  type MessageDesignScope,
} from "./message-designs.ts";
import type { CustomizeRow, MessageDesignRegistration, RowPreview, RowProvider } from "./types.ts";

/** The rows provider's id; it is the bridge's own registration, never a plugin's. */
export const MESSAGE_DESIGN_ROWS_PROVIDER_ID = "bridge.message-designs";

/** The word every message line starts with: the `Cards` category's vocabulary for a message surface. */
const MESSAGE_LINE_PREFIX = "Message";

/** What a custom type that derives to nothing still reads as. */
const TYPE_NAME_FALLBACK = "message";

/** What a line id that derives to nothing still reads as. */
const LINE_NAME_FALLBACK = "line";

/** A source's readable words, clamped so the prefix plus them fits the row-name word limit. */
function sourceWords(scope: MessageDesignScope, source: string): string[] {
  const derived = deriveRowLabel(source);
  const fallback = scope === "type" ? TYPE_NAME_FALLBACK : LINE_NAME_FALLBACK;
  const words = derived === "" ? [fallback] : derived.split(" ").filter((word) => word !== "");
  const budget = Math.max(1, MAX_ROW_NAME_WORDS - 1);
  return words.length > budget ? words.slice(words.length - budget) : words;
}

/** One line with the name the menu shows for it. */
export interface MessageDesignLineName {
  scope: MessageDesignScope;
  line: string;
  name: string;
  types: string[];
}

/**
 * The line name of every line that has designs, in creation order: `Message <words>`, made unique the
 * way every other surface is — the readable name, then the lowest free ordinal (replacing the last word
 * when the base already uses the full word limit, so the result still passes the shape rule).
 */
export function messageDesignLineNames(): MessageDesignLineName[] {
  const taken = new Set<string>();
  return messageDesignLines()
    // A line made only of FOLLOWING designs has no switch of its own (S1): the tool line they follow
    // is the switch, and a row here would be the second choice the user refuses to make.
    .filter((line) => ownDesignsOf(line).length > 0)
    .map((line) => {
    const base = [MESSAGE_LINE_PREFIX, ...sourceWords(line.scope, line.line)].join(" ");
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      const words = base.split(" ");
      const kept = words.slice(0, MAX_ROW_NAME_WORDS - 1);
      name = `${kept.join(" ")} ${suffix++}`;
    }
      taken.add(name);
      return { scope: line.scope, line: line.line, name, types: [...line.types] };
    });
}

/**
 * The designs of a line that own a value on the customize menu: everything except the ones that
 * follow a tool-design switch, whose value is chosen on that tool's own line (S1).
 */
export function ownDesignsOf(line: MessageDesignLine): MessageDesignRegistration[] {
  return line.designs.filter((design) => design.follows === undefined);
}

/**
 * Persist one line's value and repaint what is on screen. Nothing at all happens when the stored value
 * is already the one picked: a press that changes nothing must not cost a frame.
 */
function selectDesign(scope: MessageDesignScope, line: string, id: string): void {
  if (getMessageDesignLineSelection(scope, line) === id) return;
  setMessageDesignLineSelection(scope, line, id);
  requestRepaint();
}

/** The first row of a sample: a Cards value draws ONE row, so only its first line is used. */
function firstSampleRow(sample: string): string {
  return sample.split(/\r?\n/u)[0] ?? sample;
}

/** What a design's fallback preview says it paints. */
function designTarget(types: readonly string[]): string {
  return types.length === 1 ? `${types[0]}'s message` : `the ${types.join(", ")} messages`;
}

/**
 * A design's own preview when it has one, otherwise a literal depiction of the value. A preview runs
 * while the menu is rendered, so it must not be able to break it: a throwing (or malformed) plugin
 * preview loses its own picture and nothing else.
 */
function previewFor(design: MessageDesignRegistration, types: readonly string[]): RowPreview {
  if (design.preview !== undefined) {
    try {
      const shown: unknown = design.preview();
      if (isRecord(shown) && typeof shown.title === "string" && typeof shown.sample === "string") {
        return { title: shown.title, sample: firstSampleRow(shown.sample) };
      }
    } catch {
      // Fall through to the literal sample below.
    }
  }
  return {
    title: `Messages · ${design.label}`,
    sample: firstSampleRow(
      design.description ?? `${design.label}: rewrites the rows ${designTarget(types)} produced`,
    ),
  };
}

/** The host's own output, untouched. It SHOWS `default` while the stored value stays `native`. */
function nativeRow(line: MessageDesignLine, setting: string): CustomizeRow {
  const subject = line.types.join(", ");
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    choice: {
      setting,
      value: MESSAGE_DESIGN_DEFAULT_LABEL,
      // Identity, never the displayed text: a renamed label cannot lose the user's choice.
      current: () => getMessageDesignLineSelection(line.scope, line.line) === MESSAGE_DESIGN_NATIVE,
    },
    preview: () => ({
      title: `Messages · ${setting}`,
      sample: `${setting}: the host's own output for ${subject}, untouched`,
    }),
    action: () => selectDesign(line.scope, line.line, MESSAGE_DESIGN_NATIVE),
  };
}

/** One registered design of one line. The visible value is its label; the stored value is its id. */
function designRow(
  line: MessageDesignLine,
  setting: string,
  design: MessageDesignRegistration,
): CustomizeRow {
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    choice: {
      setting,
      value: design.label,
      current: () => getMessageDesignLineSelection(line.scope, line.line) === design.id,
    },
    preview: () => previewFor(design, designTypes(line, design)),
    action: () => selectDesign(line.scope, line.line, design.id),
  };
}

/** The types one design paints, or the whole line when the registration is not found. */
function designTypes(line: MessageDesignLine, design: MessageDesignRegistration): string[] {
  if (Array.isArray(design.types)) return [...design.types];
  if (typeof design.customType === "string") return [design.customType];
  return line.types;
}

/**
 * The rows of one menu build: nothing without a design, one line per line that has one.
 *
 * Exported for its own test, which asserts the row contract without a host; deliberately not part of
 * the package's public API.
 */
export function messageDesignRows(): CustomizeRow[] {
  const lines = messageDesignLines();
  if (lines.length === 0) return [];
  const rows: CustomizeRow[] = [];
  for (const named of messageDesignLineNames()) {
    const line = lines.find(
      (candidate) => candidate.scope === named.scope && candidate.line === named.line,
    );
    if (line === undefined) continue;
    const own = ownDesignsOf(line);
    if (own.length === 0) continue;
    rows.push(nativeRow(line, named.name));
    for (const design of own) rows.push(designRow(line, named.name, design));
  }
  return rows;
}

interface MessageDesignRowsState {
  /** The live provider's disposer, while the bridge has it registered. */
  dispose?: () => void;
  /**
   * The exact provider object this process registered. `/bridge-status` filters by IDENTITY and not by
   * id, so a plugin that happens to use the same id through the public `registerRows` is still listed.
   */
  provider?: RowProvider;
}

/** Process-global, like every other piece of bridge state: two copies must agree. */
const ROWS_KEY = Symbol.for("gentle-shell-bridge.message-designs.rows.v1");

function rowsHost(): Record<symbol, MessageDesignRowsState | undefined> {
  // SAFETY: only `rowsState()` writes this key, and it re-checks the shape before trusting a value left
  // by another copy or an older load.
  return globalThis as unknown as Record<symbol, MessageDesignRowsState | undefined>;
}

function rowsState(): MessageDesignRowsState {
  const host = rowsHost();
  const existing = host[ROWS_KEY];
  if (
    existing !== undefined &&
    (existing.dispose === undefined || typeof existing.dispose === "function")
  ) {
    return existing;
  }
  const created: MessageDesignRowsState = {};
  host[ROWS_KEY] = created;
  return created;
}

/**
 * Register the message-design line for this process and return a disposer that withdraws it.
 *
 * Call it when the bridge arms; it needs no `tui` and no capture. The provider is NOT registered
 * here: it is registered the moment a design exists, because a session with no design must gain no
 * provider, no row and no status line, and must pay nothing per menu build (S4). A design already
 * registered when the bridge arms installs the line immediately. Installing twice is a no-op, so a
 * second arm or a second loaded copy of this package cannot contribute the line twice.
 */
export function installMessageDesignRows(): () => void {
  const state = rowsState();
  const install = (): void => {
    if (state.dispose !== undefined) return;
    // The bus replaces a provider that reuses an id. This id is the bridge's own, so a plugin that
    // registered it first keeps it: replacing it would silently take a provider the user already has
    // off the menu, and hiding it from `/bridge-status` would make the report lie about it.
    if (snapshotProviders().some((provider) => provider.id === MESSAGE_DESIGN_ROWS_PROVIDER_ID)) {
      recordNotice(
        `the rows provider id ${JSON.stringify(MESSAGE_DESIGN_ROWS_PROVIDER_ID)} is already ` +
          "registered, so the message-design line cannot be added; the other provider keeps it.",
      );
      return;
    }
    const provider: RowProvider = {
      id: MESSAGE_DESIGN_ROWS_PROVIDER_ID,
      category: HOST_CARD_STYLE_CATEGORY,
      // Rebuilt per build, never cached: a design registered later shows up with no re-registration.
      rows: () => messageDesignRows(),
    };
    state.provider = provider;
    state.dispose = registerBridgeRows(provider);
  };
  setMessageDesignRowsInstaller(install);
  // A design that registered before the bridge armed is already waiting to be shown, and nothing else
  // can be: the id is reserved (§1), so no plugin can hold it, hand it back, or be replaced by it. With
  // no design there is no provider at all — Pi credits one fewer registration, the menu runs nothing
  // extra, and `/bridge-status` keeps its historical output (S4).
  if (messageDesignLines().length > 0) install();
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    setMessageDesignRowsInstaller(undefined);
    const dispose = state.dispose;
    state.dispose = undefined;
    state.provider = undefined;
    dispose?.();
  };
}

/**
 * The exact provider object this process registered, or `undefined` when it has none. Internal: it is
 * how `/bridge-status` tells the bridge's own line from a plugin's provider that uses the same id.
 */
export function bridgeMessageDesignRowsProvider(): RowProvider | undefined {
  return rowsState().provider;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetMessageDesignRowStateForTests(): void {
  setMessageDesignRowsInstaller(undefined);
  const state = rowsState();
  const dispose = state.dispose;
  state.dispose = undefined;
  state.provider = undefined;
  dispose?.();
}

/**
 * The customize rows for tool designs (S1–S8): ONE line per LINE that has designs, in `Cards`.
 *
 * ## One line per line, one value per design
 *
 * The values are the line's own card — shown as `default` (stored as `native`, the reserved
 * identity) — followed by every design of that line, in registration order. The host coalesces
 * consecutive rows that share a `choice.setting` into one rendered line
 * (`lib/visual-customize-view.ts:395-402,583-595`), so all of one line's values share that line's
 * setting and the card menus of a grouped line never split into one line per tool.
 *
 * ## The names: `Card <tool>` or `Card <line>`, like `Card style` and `Card content`
 *
 * A row name is what a human reads (`./row-names.ts`), and the `Cards` category already names its
 * lines `Card <what>`. An UNGROUPED design keeps the implicit tool line: `Card bash`, `Card lsp
 * navigation`, `Card mem save` (a long name keeps its TAIL, because the last words are the specific
 * part). A GROUPED registration names its line: `Card tools`, `Card status`, derived from the line id
 * through the same rule. Both share ONE ordinal space, so a line and a tool that derive the same name
 * are told apart deterministically (`Card tools`, `Card tools 2`), replacing the last word so the
 * result still passes the shape rule, exactly the way sections and card styles are told apart.
 *
 * The id is never shown: a design's `label` is its value, and the persisted value is the design's id,
 * so renaming a label never loses a user's choice. The line's NAME is not persisted either — the
 * store is keyed by the tool name (`selections`) or the line id (`lines`), so renaming the line moves
 * nothing but the text the user reads.
 *
 * ## No design, no line
 *
 * The provider is registered when the bridge arms and its rows are rebuilt per menu build, never
 * cached. With no design registered it contributes NOTHING: a session that never installed a design
 * plugin must not gain an empty line. The first design to register appears on the next build with no
 * re-registration.
 *
 * ## A change repaints the cards already drawn (S2/S10)
 *
 * The action persists FIRST (the host re-reads `current()` when it repaints) and then asks for a
 * frame through `requestRepaint()` (`./repaint.ts`): one differential `requestRender()`, because the
 * wrapper re-reads the live selection on every render pass, so the cards already on screen change too.
 * A press that changes nothing costs no frame.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { registerBridgeRows } from "./bus.ts";
import { HOST_CARD_STYLE_CATEGORY } from "./card-style-line.ts";
import { requestRepaint } from "./repaint.ts";
import { deriveRowLabel } from "./row-labels.ts";
import { MAX_ROW_NAME_WORDS } from "./row-names.ts";
import { isRecord } from "./rows.ts";
import {
  TOOL_DESIGN_DEFAULT_LABEL,
  TOOL_DESIGN_NATIVE,
  getToolDesignLineSelection,
  setToolDesignLineSelection,
  toolDesignLines,
  type ToolDesignLine,
} from "./tool-designs.ts";
import type { CustomizeRow, RowPreview, ToolDesignRegistration } from "./types.ts";

/** The rows provider's id; it is the bridge's own registration, never a plugin's. */
export const TOOL_DESIGN_ROWS_PROVIDER_ID = "bridge.tool-designs";

/** The word every design line starts with: the `Cards` category's own vocabulary. */
const TOOL_LINE_PREFIX = "Card";

/** The word a tool name that derives to nothing still reads as (`deriveRowLabel` returned ""). */
const TOOL_NAME_FALLBACK = "tool";

/** The word a line id that derives to nothing still reads as. */
const LINE_NAME_FALLBACK = "line";

/**
 * A line source's readable words, clamped so `Card` plus them fits the row-name word limit. A long
 * name keeps its TAIL: `mcp__engram__mem_save` reads `mem save`, because the last words are the
 * specific part and the leading ones (`mcp`, `engram`) are the same for every tool of that server.
 */
function sourceWords(scope: "tool" | "line", source: string): string[] {
  const derived = deriveRowLabel(source);
  const fallback = scope === "tool" ? TOOL_NAME_FALLBACK : LINE_NAME_FALLBACK;
  const words = derived === "" ? [fallback] : derived.split(" ").filter((word) => word !== "");
  const budget = Math.max(1, MAX_ROW_NAME_WORDS - 1);
  return words.length > budget ? words.slice(words.length - budget) : words;
}

/** One line with the name the menu shows for it. */
export interface ToolDesignLineName {
  scope: "tool" | "line";
  line: string;
  name: string;
  tools: string[];
}

/**
 * The line name of every line that has designs, in creation order: `Card <words>`, made unique the
 * way sections are — the readable name, then the lowest free ordinal (replacing the last word when
 * the base already uses the full word limit, so the result still passes the shape rule).
 */
export function toolDesignLineNames(): ToolDesignLineName[] {
  const taken = new Set<string>();
  return toolDesignLines().map((line) => {
    const base = [TOOL_LINE_PREFIX, ...sourceWords(line.scope, line.line)].join(" ");
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      const words = base.split(" ");
      const kept = words.slice(0, MAX_ROW_NAME_WORDS - 1);
      name = `${kept.join(" ")} ${suffix++}`;
    }
    taken.add(name);
    return { scope: line.scope, line: line.line, name, tools: [...line.tools] };
  });
}

/**
 * Persist one line's value and repaint the cards already drawn (S2/S10).
 *
 * Nothing at all happens when the stored value is already the one picked: a press that changes
 * nothing must not cost a frame.
 */
function selectDesign(scope: "tool" | "line", line: string, id: string): void {
  if (getToolDesignLineSelection(scope, line) === id) return;
  setToolDesignLineSelection(scope, line, id);
  requestRepaint();
}

/** The first row of a sample: a Cards value draws ONE row (D5), so only its first line is used. */
function firstSampleRow(sample: string): string {
  return sample.split(/\r?\n/u)[0] ?? sample;
}

/**
 * A line's scope text, inside the SAME preview row (S13/S19): nothing to say when no claim of the
 * line is scoped; one scope shared by every scoped claim prints today's ` — scope: <description>`
 * byte for byte; several DISTINCT scopes print ` — scope: <tool[, tool]>: <description>` per scope,
 * joined by `; `. Either way it joins the preview's first line, so nothing gains a second row, a
 * value or a row kind.
 */
function withScopeText(preview: RowPreview, line: ToolDesignLine): RowPreview {
  const groups = line.scopedClaims;
  if (groups.length === 0) return preview;
  const text = groups
    .map((group) =>
      groups.length === 1
        ? `— scope: ${group.scope.description}`
        : `— scope: ${group.tools.join(", ")}: ${group.scope.description}`,
    )
    .join("; ");
  return { title: preview.title, sample: `${firstSampleRow(preview.sample)} ${text}` };
}

/** What a design's fallback preview says it paints. */
function designTarget(tools: readonly string[]): string {
  return tools.length === 1 ? `${tools[0]}'s own card` : `the ${tools.join(", ")} cards`;
}

/**
 * A design's own preview when it has one, otherwise a literal depiction of the value. A preview runs
 * while the menu is rendered, so it must not be able to break it: a throwing (or malformed) plugin
 * preview loses its own picture and nothing else. Whatever it returns, a Cards value draws ONE row:
 * the sample's first line (D5).
 */
function previewFor(design: ToolDesignRegistration, tools: readonly string[]): RowPreview {
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
    title: `Cards · ${design.label}`,
    // One row (D5), and it says what the value paints: on a grouped line a value covers a SUBSET, and
    // the menu is the only place the user can see which (S6).
    sample: firstSampleRow(
      design.description ?? `${design.label}: rewrites the rows ${designTarget(tools)} produced`,
    ),
  };
}

/**
 * The host's own card, untouched. It SHOWS `default` (the word the user reads) while the stored value
 * stays `native`: the selection is identity, so a saved choice survives the rename.
 */
function nativeRow(line: ToolDesignLine, setting: string): CustomizeRow {
  const subject = line.tools.join(", ");
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    choice: {
      setting,
      value: TOOL_DESIGN_DEFAULT_LABEL,
      // Identity, never the displayed text: a renamed label cannot lose the user's choice.
      current: () => getToolDesignLineSelection(line.scope, line.line) === TOOL_DESIGN_NATIVE,
    },
    preview: () =>
      withScopeText(
        {
          title: `Cards · ${setting}`,
          sample: `${setting}: the host's own card for ${subject}, untouched`,
        },
        line,
      ),
    action: () => selectDesign(line.scope, line.line, TOOL_DESIGN_NATIVE),
  };
}

/** One registered design of one line. The visible value is its label; the stored value is its id. */
function designRow(line: ToolDesignLine, setting: string, design: ToolDesignRegistration): CustomizeRow {
  const tools = designTools(line, design);
  return {
    category: HOST_CARD_STYLE_CATEGORY,
    choice: {
      setting,
      value: design.label,
      current: () => getToolDesignLineSelection(line.scope, line.line) === design.id,
    },
    preview: () => withScopeText(previewFor(design, tools), line),
    action: () => selectDesign(line.scope, line.line, design.id),
  };
}

/**
 * The tools one design paints, or the whole line when the registration is not found. A design object
 * is unique per registration, so identity is the lookup key.
 */
function designTools(line: ToolDesignLine, design: ToolDesignRegistration): string[] {
  if (design.line === undefined) return design.tool === undefined ? line.tools : [design.tool];
  if (Array.isArray(design.tools)) return [...design.tools];
  return line.tools;
}

/** The rows of one menu build: nothing without a design, one line per line that has one. */
function designRows(): CustomizeRow[] {
  const lines = toolDesignLines();
  if (lines.length === 0) return [];
  const rows: CustomizeRow[] = [];
  for (const named of toolDesignLineNames()) {
    const line = lines.find(
      (candidate) => candidate.scope === named.scope && candidate.line === named.line,
    );
    if (line === undefined) continue;
    rows.push(nativeRow(line, named.name));
    for (const design of line.designs) rows.push(designRow(line, named.name, design));
  }
  return rows;
}

interface ToolDesignRowsState {
  /** The live provider's disposer, while the bridge has it registered. */
  dispose?: () => void;
}

/** Process-global, like every other piece of bridge state: two copies must agree. */
const ROWS_KEY = Symbol.for("gentle-shell-bridge.tool-designs.rows.v1");

function rowsHost(): Record<symbol, ToolDesignRowsState | undefined> {
  // SAFETY: only `rowsState()` writes this key, and it re-checks the shape before trusting a value
  // left by another copy or an older load.
  return globalThis as unknown as Record<symbol, ToolDesignRowsState | undefined>;
}

function rowsState(): ToolDesignRowsState {
  const host = rowsHost();
  const existing = host[ROWS_KEY];
  if (existing !== undefined && (existing.dispose === undefined || typeof existing.dispose === "function")) {
    return existing;
  }
  const created: ToolDesignRowsState = {};
  host[ROWS_KEY] = created;
  return created;
}

/**
 * Register the design line for this process and return a disposer that withdraws it.
 *
 * Call it when the bridge arms; it needs no `tui` and no capture. Installing twice is a no-op, so a
 * second arm or a second loaded copy of this package cannot contribute the line twice.
 */
export function installToolDesignRows(): () => void {
  const state = rowsState();
  if (state.dispose === undefined) {
    state.dispose = registerBridgeRows({
      id: TOOL_DESIGN_ROWS_PROVIDER_ID,
      category: HOST_CARD_STYLE_CATEGORY,
      // Rebuilt per build, never cached: a design registered later shows up with no re-registration.
      rows: () => designRows(),
    });
  }
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    const dispose = state.dispose;
    state.dispose = undefined;
    dispose?.();
  };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetToolDesignRowStateForTests(): void {
  const state = rowsState();
  const dispose = state.dispose;
  state.dispose = undefined;
  dispose?.();
}

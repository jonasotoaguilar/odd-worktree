/**
 * Row origin (T1): WHICH host child drew each row of a frame the conversation just rendered.
 *
 * ## Why the map is derived, never guessed
 *
 * A plugin that wants to restyle `bash` cards needs the host's own identity for a row. The drawn
 * title cannot carry it: the host heads a bash card with the inferred activity
 * (`theme.bold(identity.activity ?? "bash")`, `cards-bash-v2` `extensions/quiet-tools.ts:672`), so a
 * grammar over the words breaks the next time a title changes. `pi-cinlodev-cute` reads it from the
 * component instead (`src/transcript/transcript-dispatcher.ts:30-40`: `child.toolName === "bash"`).
 *
 * ## Where the map comes from
 *
 * `pi-tui`'s `Container.render(width)` renders each child and publishes the layout it used
 * (`pi-tui/dist/tui.js:136-149`):
 *
 * ```ts
 * this.mouseLayout = { width, children: [{ component, height }] };
 * return lines;
 * ```
 *
 * So the conversation component — the one `./card-style-wiring.ts` wraps — already carries a
 * per-child row count after ITS OWN render returns. This module reads that, and nothing else: it
 * never calls `render` (no second render, no children rendered twice on the normal path), never
 * replaces `Container.render`, and never inspects a child's output.
 *
 * ## An unknown origin is an empty map, never a partial one
 *
 * The layout is host state this package does not own, so every way it can disagree with the frame is
 * a REPORTED absence: no layout at all, a layout measured at another width, heights that do not add
 * up to the returned line count, or an entry of the wrong shape. Each yields `rows: []` plus a
 * `reason`, because a partial map would attribute rows to the wrong child — a plugin would restyle
 * the wrong card, or cut a card in half. Nothing here throws into the host's render loop.
 *
 * This module is internal: `src/index.ts` does not re-export it. The TYPE it produces (`RowOrigin`)
 * is part of the public contract (`./types.ts`), because a transform receives it through `ctx.rows`.
 */

import { isRecord } from "./rows.ts";
import type { RowOrigin } from "./types.ts";

/** Why a frame's origins are unknown. Every value is reported, none is a guess. */
export type RowOriginAbsence =
  /** The component published no `mouseLayout`: not a `Container`, or a render that never ran. */
  | "no-layout"
  /** The layout was measured at a width other than the one this frame was rendered at. */
  | "width-mismatch"
  /** The layout's heights do not add up to the line count the render returned. */
  | "height-mismatch"
  /** The layout itself is malformed: a non-array `children`, a bad `height`, a non-object child. */
  | "bad-layout";

/** A frame's origins: one entry per row, or an empty list plus the reason it is empty. */
export interface RowOriginMap {
  readonly rows: readonly RowOrigin[];
  /** Present exactly when `rows` is empty because the layout could not be trusted. */
  readonly reason?: RowOriginAbsence;
}

/** The empty row list every absence shares; frozen, because nothing may add to it. */
const NO_ROWS: readonly RowOrigin[] = Object.freeze([]);

/** An absent map: no rows, and the reason a caller can report. */
function absent(reason: RowOriginAbsence): RowOriginMap {
  return { rows: NO_ROWS, reason };
}

/** A child component's `constructor.name`, or `undefined` when it has none worth reporting. */
function constructorName(child: Record<string, unknown>): string | undefined {
  const constructor = child.constructor;
  if (typeof constructor !== "function") return undefined;
  const name = constructor.name;
  return name === "" ? undefined : name;
}

/**
 * The `toolName` a child carries, when it carries one as a string — the same member
 * `pi-cinlodev-cute` reads (`src/transcript/transcript-dispatcher.ts:30-40`). Anything else (a
 * number, an object, nothing) is not a tool name and is left out rather than coerced.
 */
function toolNameOf(child: Record<string, unknown>): string | undefined {
  const tool = child.toolName;
  return typeof tool === "string" ? tool : undefined;
}

/**
 * The identity one child contributes to every row it drew. Both members are read ONCE per child, so
 * a row entry is a plain value a plugin can keep: no component reference, no live host object.
 */
interface ChildIdentity {
  readonly toolName?: string;
  readonly component?: string;
}

function identityOf(child: Record<string, unknown>): ChildIdentity {
  const toolName = toolNameOf(child);
  const component = constructorName(child);
  return {
    ...(toolName === undefined ? {} : { toolName }),
    ...(component === undefined ? {} : { component }),
  };
}

/** Whether a layout entry's `height` is a row count this map may expand: a whole number, not negative. */
function isHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * One `RowOrigin` per row of the frame the host just drew, in row order.
 *
 * `component` is the conversation component AFTER its own `render(width)` returned (so its
 * `mouseLayout` is this frame's layout), `width` is the width that render was asked for, and
 * `lineCount` is how many rows it returned — the frame a transform then receives.
 *
 * Returns a complete map, or `{ rows: [], reason }`: never a throw, never an entry for only part of
 * the frame.
 */
export function rowOrigins(component: unknown, width: number, lineCount: number): RowOriginMap {
  if (!isRecord(component)) return absent("no-layout");
  const layout = component.mouseLayout;
  if (!isRecord(layout)) return absent("no-layout");
  if (typeof layout.width !== "number") return absent("bad-layout");
  if (layout.width !== width) return absent("width-mismatch");
  const children = layout.children;
  if (!Array.isArray(children)) return absent("bad-layout");

  const rows: RowOrigin[] = [];
  for (const entry of children) {
    if (!isRecord(entry) || !isRecord(entry.component)) return absent("bad-layout");
    const height = entry.height;
    if (!isHeight(height)) return absent("bad-layout");
    const identity = identityOf(entry.component);
    for (let offset = 0; offset < height; offset += 1) {
      rows.push({ index: rows.length, ...identity });
    }
  }

  // The layout and the returned frame must describe the same render. When they do not, the layout is
  // a frame behind (or from another width), and attributing these rows to those children would name
  // the wrong card.
  if (rows.length !== lineCount) return absent("height-mismatch");
  return { rows };
}

/**
 * The host's own `Card style` line: where it is, how it is extended, and the ONE place its name
 * lives (S1).
 *
 * gentle-shell builds the line itself (`extensions/gentle-shell.ts:3398-3419`): two rows in
 * category `Cards` sharing `choice.setting === "Card style"`, values `neon` and `float`, each with
 * its own `current()` reading the host's config file and its own `action()` writing it. The host
 * coalesces consecutive rows that share a setting into one rendered line
 * (`lib/visual-customize-view.ts:395-402,583-595`).
 *
 * That is the whole seam. The bridge does not add a second line, does not rename the host's, does
 * not reimplement `neon`/`float` and never writes the host's config file: at capture it splices the
 * host's rows out of the array, puts the SAME objects back at the same index, and appends one row
 * per registered style sharing that setting. The host then draws one line —
 * `Card style  ● neon ○ float ○ cute` — in the position it chose.
 *
 * Every name this depends on is declared here once, so a renamed setting is a single place to look
 * and a single thing to report. When it stops matching, `findCardStyleLine` finds nothing, the mode
 * becomes `separate` and the caller contributes the bridge's own `Bridge card style` line
 * (`./card-style-rows.ts`), which `/bridge-status` reports. Nothing is guessed and nothing is
 * silently dropped.
 */

import type { CustomizeRow } from "./types.ts";

/** The category that holds the host's line (`extensions/gentle-shell.ts:3398`). */
export const HOST_CARD_STYLE_CATEGORY = "Cards";

/**
 * The `choice.setting` the host's rows share (`extensions/gentle-shell.ts:3418`). A change here is a
 * host change, not a bridge bug: the locator finds nothing and the fallback line takes over.
 */
export const HOST_CARD_STYLE_SETTING = "Card style";

/** The values the host's own rows carry (`lib/shell-card.ts:33-36`, rows at `:3405-3419`). */
export const HOST_CARD_STYLE_VALUES = ["neon", "float"] as const;

/** The bridge's own pass-through value: no repaint, the host's frame untouched. */
export const CARD_STYLE_NATIVE = "native";

/**
 * Ids a style may not take. `native` is the bridge's value in the separate-line mode, and `neon` /
 * `float` are the host's own: reusing one would put the same value on the line twice, where the
 * host's `current()` and the bridge's could both answer `true` and stepping through the values
 * could not tell them apart.
 */
export const RESERVED_CARD_STYLE_IDS: ReadonlySet<string> = new Set([
  CARD_STYLE_NATIVE,
  ...HOST_CARD_STYLE_VALUES,
]);

/** Where one run of rows sharing the host's setting sits in the captured array. */
export interface CardStyleLineRange {
  start: number;
  count: number;
}

/**
 * Whether one row belongs to the host's line. Both the category and the setting must match: the
 * setting alone could be shared by another category, and the category alone says nothing.
 */
function isHostStyleRow(row: unknown): boolean {
  if (row === null || typeof row !== "object") return false;
  const candidate = row as { category?: unknown; choice?: unknown };
  if (candidate.category !== HOST_CARD_STYLE_CATEGORY) return false;
  const choice = candidate.choice;
  if (choice === null || typeof choice !== "object") return false;
  return (choice as { setting?: unknown }).setting === HOST_CARD_STYLE_SETTING;
}

/**
 * The host's line: the FIRST maximal run of consecutive rows that carry the host's setting in
 * `Cards`. Absent means "the host's shape is not what the bridge knows" — the caller reports that
 * instead of appending a second `Card style` line somewhere else.
 */
export function findCardStyleLine(rows: readonly CustomizeRow[]): CardStyleLineRange | undefined {
  const start = rows.findIndex((row) => isHostStyleRow(row));
  if (start === -1) return undefined;
  let end = start;
  while (end + 1 < rows.length && isHostStyleRow(rows[end + 1])) end += 1;
  return { start, count: end - start + 1 };
}

/**
 * Splice the registered value rows into the host's line, in place, keeping the host's own rows at
 * their index. `adaptHostRow` may return a replacement for a host row (S13 wraps `current()`), and
 * receives the row itself so the caller can build a shallow clone; returning the row unchanged is
 * the identity default.
 *
 * Returns the range the line now covers, or `undefined` when the line could not be located OR the
 * array refuses the edit (frozen, sealed, not extensible) — both mean "use the separate line", and
 * neither throws into the host's menu build.
 */
export function spliceCardStyleValues(
  rows: CustomizeRow[],
  values: readonly CustomizeRow[],
  adaptHostRow: (row: CustomizeRow) => CustomizeRow = (row) => row,
): CardStyleLineRange | undefined {
  const range = findCardStyleLine(rows);
  if (range === undefined) return undefined;
  if (values.length === 0 && adaptHostRow === identityRow) return range;
  // An array that cannot grow cannot receive our values; the host's own rows stay exactly where
  // they are, and the caller contributes the separate line instead of half-editing this one.
  if (!Object.isExtensible(rows) || Object.isSealed(rows) || Object.isFrozen(rows)) return undefined;

  const hostRows = rows.slice(range.start, range.start + range.count).map((row) => adaptHostRow(row));
  rows.splice(range.start, range.count, ...hostRows, ...values);
  return { start: range.start, count: range.count + values.length };
}

/** The default adapter, compared by identity so a no-op call can skip the splice entirely. */
const identityRow = (row: CustomizeRow): CustomizeRow => row;

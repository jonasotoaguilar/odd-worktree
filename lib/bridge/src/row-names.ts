/**
 * The row-name SHAPE (N7–N9): one rule, one enforcement point per boundary.
 *
 * A row name is what a human reads where a setting line's name goes — an entry provider's
 * `choice.setting`, or the label of the row a provider, a section or a card style contributes. The
 * host names its own rows in one to three plain words (`Card style`, `stats`); a bridge row read
 * `Bash card → Bash rendering`, which is a breadcrumb with an arrow and a repeated qualifier, not a
 * name. Third instance of one class of defect, so the rule is stated once here and applied by both
 * boundaries that can create a row name:
 *
 * - **registration** (`./bus.ts`): a section's or a card style's row label is checked before the
 *   registration is stored. Nothing is stored when it fails, so the rejected entry can never reach
 *   the menu or `/bridge-status`'s registry tables.
 * - **menu build** (`./rows.ts`): a provider's rows exist only when its `rows(ctx)` runs, so the
 *   line name (`choice.setting`) and the row label are checked there. A rejected row is dropped from
 *   the array the host receives AND from the build record `/bridge-status` reads, so it is absent
 *   from the "effective set" rather than merely hidden.
 *
 * ## The rule
 *
 * One to `MAX_ROW_NAME_WORDS` plain words (`Bash rendering`, `Loon banner source`), with none of
 * `ROW_NAME_MARKS`: an arrow, a colon, a dot, a pipe, a slash or a bracket. Those are the characters
 * that make a name read as a path, a key or a breadcrumb instead of a name.
 *
 * ## The one reserved category (S15)
 *
 * A second, unrelated rule lives here because it needs the SAME report: `Keymaps` is the host's own
 * interaction (key capture, `keymaps.json`, a category footer promising `Enter assign`) and is
 * closed to plugins. A provider registered with that category is refused at registration
 * (`./bus.ts`), and a single row whose own category is that page is dropped at build time
 * (`./rows.ts`) — the shapes are different, the channel is one, and a reader of
 * `/bridge-status` finds every refused row in one list instead of learning a second report. The
 * comparison is trimmed and case-insensitive (`Keymaps`, ` keymaps `, `KEYMAPS`), because they all
 * name the same page; a near miss (`Keymap`, `Key maps`) is an ordinary category of its own.
 *
 * ## Reject and report, never rewrite
 *
 * The bridge does NOT sanitize a name: `Bash card → Bash rendering` staying in a report as
 * `Bash card → Bash rendering` is what lets an author find and fix it. So the offending string is
 * recorded verbatim with the rule it broke, `/bridge-status` lists the pair, and the row simply does
 * not exist. Derivation (`./row-labels.ts`) is the one place that transforms text, and it applies the
 * same shape — marks become word breaks with the rest of the punctuation, and the result is clamped
 * to the word limit — so a derived name can never be rejected.
 *
 * The record is keyed by surface + id + field: a rejected registration that is later corrected
 * replaces its own record, and a build that now produces a conforming name clears the stale one, so
 * the report always describes the current state instead of accumulating history.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

/** A row name is at most this many words. One word is a name (`stats`); four is a sentence. */
export const MAX_ROW_NAME_WORDS = 3;

/**
 * Characters that make a name read as a structure rather than a name: arrows, the colon, the dot,
 * the pipe, both slashes and the bracket family. The docs list them (N9), so they stay one list.
 */
export const ROW_NAME_MARKS: readonly string[] = [
  "→",
  "←",
  "↑",
  "↓",
  ":",
  ".",
  "|",
  "/",
  "\\",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
];

/**
 * The ways a row can be refused, with `reason` naming it in words: a structural `mark`, the
 * `words` limit, or the `reserved category` rule (S15).
 */
export type RowNameRule = "mark" | "words" | "reserved category";

export interface RowNameProblem {
  rule: RowNameRule;
  /** One sentence naming the offending text and the rule; reported verbatim by `/bridge-status`. */
  reason: string;
}

/** The mark rule, quoted in every rejection it produces so the reason stands on its own. */
const MARK_RULE =
  "a row name is one to three plain words with no arrow, colon, dot, pipe, slash or bracket";
/** The word rule, likewise. */
const WORD_RULE = "a row name is one to three plain words";

/** Where a rejected name came from: a provider's rows, a section, a card style. */
export type RowNameSurface = "rows" | "section" | "card style";

/**
 * Which part of a row carried it: `choice.setting`, the row's visible label, or the `category` it
 * asked for (the one reserved-category case).
 */
export type RowNameField = "line name" | "row label" | "category";

/**
 * The categories the host owns and works differently (S15): `Keymaps` captures keys and writes
 * `keymaps.json`, and its page footer promises `Enter assign` (`lib/visual-customize-view.ts:40`,
 * `lib/keymaps-customize.ts:49-68`). A plugin row there would be advertised as an assignable binding
 * and could never honour it, so the whole page is closed until the host opens it.
 */
export const RESERVED_CATEGORIES: readonly string[] = ["Keymaps"];

/** Why a reserved category is closed, quoted by every refusal so the reason stands on its own. */
export const RESERVED_CATEGORY_RULE =
  "works differently in the host (its own key capture and footer); not open to plugins yet";

/**
 * The reserved category this value names, or `undefined` when a plugin may use it. Compared trimmed
 * and case-insensitively: the host's page is a literal string, and `KEYMAPS` would render a second
 * page next to the host's own, so a near match is refused instead of creating a twin.
 */
export function reservedCategory(category: unknown): string | undefined {
  if (typeof category !== "string") return undefined;
  const wanted = category.trim().toLowerCase();
  return RESERVED_CATEGORIES.find((reserved) => reserved.toLowerCase() === wanted);
}

/**
 * Drop one provider row that asked for a reserved category, and record the refusal verbatim (S15).
 * Returns `true` when the row was refused, so the caller drops exactly that row and keeps its
 * siblings. A conforming category records nothing and returns `false`.
 */
export function rejectReservedCategory(providerId: string, category: unknown): boolean {
  const reserved = reservedCategory(category);
  if (reserved === undefined) return false;
  const value = typeof category === "string" ? category : String(category);
  recordRowNameRejection({
    surface: "rows",
    id: providerId,
    field: "category",
    value,
    rule: "reserved category",
    reason: `it is the reserved category ${JSON.stringify(reserved)}, which ${RESERVED_CATEGORY_RULE}`,
  });
  return true;
}

/** One rejected name, kept verbatim so the author can find it and fix it. */
export interface RowNameRejection {
  surface: RowNameSurface;
  /** The provider, section or style id the name belonged to. */
  id: string;
  field: RowNameField;
  /** The offending string, EXACTLY as the author wrote it. Never rewritten. */
  value: string;
  rule: RowNameRule;
  reason: string;
}

/** The words in a name; the trim means runs of spaces and a padded string are not extra words. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * What is wrong with this name, or `undefined` when it is a usable row name.
 *
 * Checks run in a fixed order — marks first, then the word limit — so the reported reason is
 * deterministic: `Bash card → Bash rendering` is a mark violation (and a word-limit one), and the
 * author is told about the arrow, the defect the user actually saw.
 */
export function rowNameProblem(value: string): RowNameProblem | undefined {
  const text = String(value);
  for (const mark of ROW_NAME_MARKS) {
    if (text.includes(mark)) {
      return { rule: "mark", reason: `it contains ${JSON.stringify(mark)}; ${MARK_RULE}` };
    }
  }
  const count = wordCount(text);
  if (count < 1 || count > MAX_ROW_NAME_WORDS) {
    return { rule: "words", reason: `it has ${count} words; ${WORD_RULE}` };
  }
  return undefined;
}

/** Stable process-global slot, like the bus and the notice buffer: two copies must agree. */
const ROW_NAMES_KEY = Symbol.for("gentle-shell-bridge.row-names.v1");

interface RowNameState {
  /** One record per surface + id + field, in the order the first rejection appeared. */
  rejections: RowNameRejection[];
}

function rowNamesHost(): Record<symbol, RowNameState | undefined> {
  // SAFETY: only `rowNameState()` writes this key, and it re-checks the list before trusting a
  // value left by another copy or an earlier load.
  return globalThis as unknown as Record<symbol, RowNameState | undefined>;
}

function rowNameState(): RowNameState {
  const host = rowNamesHost();
  const existing = host[ROW_NAMES_KEY];
  if (existing !== undefined && Array.isArray(existing.rejections)) return existing;
  const created: RowNameState = { rejections: [] };
  host[ROW_NAMES_KEY] = created;
  return created;
}

function sameSlot(
  a: RowNameRejection,
  b: Pick<RowNameRejection, "surface" | "id" | "field" | "value">,
): boolean {
  return a.surface === b.surface && a.id === b.id && a.field === b.field && a.value === b.value;
}

/**
 * Record a rejection, replacing an identical one so a build cannot grow the list by repeating
 * itself. Two DIFFERENT offending strings from one registration are two records: each is a name the
 * author has to fix, and collapsing them would hide one.
 */
export function recordRowNameRejection(rejection: RowNameRejection): void {
  const state = rowNameState();
  const index = state.rejections.findIndex((candidate) => sameSlot(candidate, rejection));
  if (index === -1) state.rejections.push(rejection);
  else state.rejections[index] = rejection;
}

/**
 * Forget every rejection for one registration: a build or a re-registration is the new evidence, so
 * a name that is no longer in force is no longer reported.
 */
export function clearRowNameRejections(surface: RowNameSurface, id: string): void {
  const state = rowNameState();
  for (let index = state.rejections.length - 1; index >= 0; index -= 1) {
    const candidate = state.rejections[index];
    if (candidate.surface === surface && candidate.id === id) state.rejections.splice(index, 1);
  }
}

/**
 * Apply the rule to one name: record a violation and return `true`, or record nothing and return
 * `false`. The caller decides what "rejected" means on its surface (do not store a registration;
 * drop a row), and the caller clears a previous record when its new state has no violation — only it
 * knows whether the name it is checking replaced the earlier one or sits beside it.
 */
export function rejectRowName(
  surface: RowNameSurface,
  id: string,
  field: RowNameField,
  value: string,
): boolean {
  const problem = rowNameProblem(value);
  if (problem === undefined) return false;
  recordRowNameRejection({
    surface,
    id,
    field,
    value: String(value),
    rule: problem.rule,
    reason: problem.reason,
  });
  return true;
}

/** A fresh copy, so a report cannot mutate the registry. */
export function getRowNameRejections(): RowNameRejection[] {
  return rowNameState().rejections.map((rejection) => ({ ...rejection }));
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetRowNameRejectionsForTests(): void {
  rowNameState().rejections.length = 0;
}

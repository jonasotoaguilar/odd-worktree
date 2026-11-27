/**
 * The shared `Sections` preview (S1, S2, S4).
 *
 * The host draws ONE preview for every `Sections` row: a title naming that row (`Sections · rdd
 * shown`) and a sample listing the sections active under its hypothetical (`[changes] [rdd]
 * [agents] [todo] [usageCost]`), computed from its own `visual.visibility`
 * (`extensions/gentle-shell.ts:3522-3524`). That list is closed to a bridge section: the host
 * validates `visual-customization.json` against its own key list, so a key the bridge added cannot
 * live there (`./visibility.ts`). Left alone, a section registered through `registerSection`
 * therefore never appeared in the shared list — the bridge's rows drew a picture of the card
 * instead, which is the defect this module fixes.
 *
 * Two halves, one list:
 *
 * - `patchSharedSections` replaces each host `Sections` row in the live rows array with a shallow
 *   copy whose `preview()` calls the host's own function UNCHANGED and appends the bridge's
 *   currently visible section labels to its sample. It records what it replaced, so the early
 *   capture path can undo it exactly like the `Card style` splice (`undoSharedSections`).
 * - `sharedSectionsPreview` is what a bridge toggle row returns: the host's title shape and the
 *   same merged list, with THIS row's hypothetical applied to its own section (a `shown` row lists
 *   it, a `hidden` row does not) on top of the persisted state of the rest.
 *
 * The base list is the host's, honestly borrowed (L6): the ORIGINAL `preview()` of a host row whose
 * `current()` is `true` renders the persisted state, so its sample IS the base. Nothing here reads
 * or reinterprets `visual.visibility`, and a wrapper is never asked for a base — that would append
 * the bridge's labels twice. With no host `Sections` row in the array the base is the host's own
 * empty case, `[no optional sections]`.
 *
 * Nothing here may throw into the menu: a host preview that throws, a row that cannot be copied and
 * a frozen array all leave the host's own drawing in place and lose only the bridge's labels.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { snapshotSections } from "./bus.ts";
import { sectionRowLabels } from "./row-labels.ts";
import { isRecord } from "./rows.ts";
import { SECTION_TOGGLE_ROW, SECTIONS_CATEGORY } from "./sections-rows.ts";
import type { CustomizeRow, RowPreview } from "./types.ts";
import { getSectionVisibility, isSectionVisible } from "./visibility.ts";

/** Marks a host row this module already wrapped; the value is the host row itself. */
const PATCHED_ROW = Symbol.for("gentle-shell-bridge.sections-preview.patched.v1");

/** The same words WITHOUT the brackets, as they sit inside the host's list. */
const EMPTY_LIST_TEXT = "no optional sections";

/** The host's own empty list, drawn when no optional section is active. */
export const NO_OPTIONAL_SECTIONS = `[${EMPTY_LIST_TEXT}]`;

/** One replaced host row: where it was, what it was, and the wrapper now standing in its place. */
export interface PatchedSectionRow {
  /** The element's index in the live rows array at the moment it was replaced. */
  index: number;
  /** The host's own row object, untouched. */
  original: CustomizeRow;
  /** The shallow copy that is now in the array. */
  wrapper: CustomizeRow;
}

/** What one build's patch replaced, so the early rollback can put all of it back. */
export interface SharedSectionsPatch {
  /** The live rows array the host holds. */
  array: CustomizeRow[];
  rows: readonly PatchedSectionRow[];
}

/**
 * The patch the last `patchSharedSections` call made, and the only place a bridge row's preview
 * finds the host's base list. Process-global is not needed: both capture paths call the patch from
 * this module's own copy, in the same process, on every build.
 */
let lastPatch: SharedSectionsPatch | undefined;

/**
 * Replace every host `Sections` row in `array` with a shallow copy whose preview appends the
 * bridge's currently visible section labels.
 *
 * Idempotent per build: a row already carrying this module's marker is skipped, so a second call
 * cannot wrap a wrapper (and therefore cannot append twice). Never throws — a row that cannot be
 * copied, and an array that refuses the assignment, stay exactly as the host made them.
 *
 * Returns `undefined` when the array held no host `Sections` row to replace.
 */
export function patchSharedSections(array: CustomizeRow[]): SharedSectionsPatch | undefined {
  const patched: PatchedSectionRow[] = [];
  let length = 0;
  try {
    length = array.length;
  } catch {
    return undefined;
  }
  for (let index = 0; index < length; index++) {
    try {
      const original = array[index];
      if (!isHostSectionsRow(original)) continue;
      const wrapper: CustomizeRow = { ...original, preview: () => mergedHostPreview(original) };
      array[index] = wrapper;
      Object.defineProperty(wrapper, PATCHED_ROW, {
        value: original,
        enumerable: false,
        configurable: true,
      });
      patched.push({ index, original, wrapper });
    } catch {
      // A row we cannot copy (or an array that refuses the write) stays as the host made it.
    }
  }
  if (patched.length === 0) return undefined;
  const patch: SharedSectionsPatch = { array, rows: patched };
  lastPatch = patch;
  return patch;
}

/**
 * Put each original host row back by index, only while the element there still is this patch's
 * wrapper. The host may have moved elements between the patch and the rollback; an element it moved
 * is left alone rather than guessed at.
 */
export function undoSharedSections(patch: SharedSectionsPatch | undefined): void {
  if (patch === undefined) return;
  for (const row of patch.rows) {
    try {
      if (patch.array[row.index] === row.wrapper) patch.array[row.index] = row.original;
    } catch {
      // frozen, sealed or moved: nothing more can be taken back from this array
    }
  }
  if (lastPatch === patch) lastPatch = undefined;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetSharedSectionsPreviewForTests(): void {
  lastPatch = undefined;
}

/**
 * What a bridge `Sections` toggle row returns: the host's title shape, and the shared list with
 * this row's own hypothetical (`shown`) applied to `sectionId` instead of its persisted value.
 */
export function sharedSectionsPreview(
  label: string,
  shown: boolean,
  sectionId: string,
): RowPreview {
  return {
    title: `Sections · ${label} ${shown ? "shown" : "hidden"}`,
    sample: sharedSample(sectionId, shown),
  };
}

/**
 * Append the bridge's labels to the host's own list.
 *
 * The host's shape is `[a] [b]`, with its empty case written literally as `[no optional sections]`;
 * rebuilding it as `[a] [b] [issues]` keeps the host's own text. A sample that is not that bracket
 * shape gets the labels appended as `[...]` and is never dropped. No labels means the sample is
 * returned byte for byte, so the bridge adds nothing when it has nothing to add.
 */
export function mergeSectionLabels(sample: string, labels: readonly string[]): string {
  if (labels.length === 0) return sample;
  const additions = labels.map((label) => `[${label}]`);
  const match = BRACKET_LIST.exec(sample);
  if (match === null) return `${sample} ${additions.join(" ")}`;
  const inner = match[1];
  const entries =
    inner === EMPTY_LIST_TEXT || inner.trim() === "" ? [] : inner.split("] [");
  return [...entries.map((entry) => `[${entry}]`), ...additions].join(" ");
}

/** The host's whole sample shape: brackets around the list, nothing before or after. */
const BRACKET_LIST = /^\[([\s\S]*)\]$/u;

/** One host row, copied with its sample extended. Its own preview is called, never reimplemented. */
function mergedHostPreview(row: CustomizeRow): RowPreview {
  const host = readHostPreview(row);
  const labels = safeSectionLabels();
  if (host === undefined) {
    // The host's preview threw or answered nonsense: its title is unknown, but the bridge's list is
    // still previewable, so the menu keeps working instead of breaking on one row.
    return { title: SECTIONS_CATEGORY, sample: mergeSectionLabels(NO_OPTIONAL_SECTIONS, labels) };
  }
  return { title: host.title, sample: mergeSectionLabels(host.sample, labels) };
}

/**
 * The base list, borrowed from the host: the original preview of a row whose `current()` is `true`
 * renders exactly the persisted state. Fallbacks, in order: the first host `Sections` row's original
 * sample, then the host's empty case.
 */
function baseSample(): string {
  const patch = lastPatch;
  if (patch === undefined) return NO_OPTIONAL_SECTIONS;
  for (const row of patch.rows) {
    if (!isCurrentChoice(row.original)) continue;
    const preview = readHostPreview(row.original);
    if (preview !== undefined) return preview.sample;
  }
  for (const row of patch.rows) {
    const preview = readHostPreview(row.original);
    if (preview !== undefined) return preview.sample;
  }
  return NO_OPTIONAL_SECTIONS;
}

function sharedSample(sectionId: string, shown: boolean): string {
  try {
    return mergeSectionLabels(baseSample(), sectionLabels({ id: sectionId, shown }));
  } catch {
    // The host renderer must never meet a throw from a bridge preview.
    return NO_OPTIONAL_SECTIONS;
  }
}

/** The shown bridge sections' labels, in the order the rows read them. */
function sectionLabels(focused?: { id: string; shown: boolean }): string[] {
  const visibility = getSectionVisibility();
  const labels: string[] = [];
  for (const entry of sectionRowLabels(snapshotSections())) {
    const shown =
      focused !== undefined && entry.section.id === focused.id
        ? focused.shown
        : isSectionVisible(visibility, entry.section);
    if (shown) labels.push(entry.label);
  }
  return labels;
}

function safeSectionLabels(): string[] {
  try {
    return sectionLabels();
  } catch {
    return [];
  }
}

/** Run the host's own preview exactly as the host would, and reject anything that is not its shape. */
function readHostPreview(row: CustomizeRow): RowPreview | undefined {
  const preview = row.preview;
  if (typeof preview !== "function") return undefined;
  try {
    const shown: unknown = preview.call(row);
    if (isRecord(shown) && typeof shown.title === "string" && typeof shown.sample === "string") {
      return { title: shown.title, sample: shown.sample };
    }
  } catch {
    // A host preview that throws loses its own sample and nothing else.
  }
  return undefined;
}

/** Whether this host row's hypothetical is the persisted state, read live like the host does. */
function isCurrentChoice(row: CustomizeRow): boolean {
  const choice = row.choice;
  const current = choice?.current;
  if (choice === undefined || typeof current !== "function") return false;
  try {
    return current.call(choice) === true;
  } catch {
    return false;
  }
}

/**
 * A host `Sections` row: the host's category, a callable preview and a named setting — and not one
 * the bridge itself created (its own toggle rows share the category and both fields).
 */
function isHostSectionsRow(value: CustomizeRow): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Object.hasOwn(value, PATCHED_ROW)) return false;
  if (Object.hasOwn(value, SECTION_TOGGLE_ROW)) return false;
  if (value.category !== SECTIONS_CATEGORY) return false;
  if (typeof value.preview !== "function") return false;
  return typeof value.choice?.setting === "string";
}

/**
 * Turning visible text into a settings row LABEL (N1–N3).
 *
 * The host prints `choice.setting` as a toggle line's name and `label` as a row's text
 * (`lib/visual-customize-view.ts:583-595`), so anything the bridge puts in either field is read by
 * a human. An id is not a label: `Section: bash-card.status` was a prefix nobody asked for plus a
 * dotted internal key, and a plugin author copying the docs copied the shape.
 *
 * The rule, in one place so both surfaces cannot drift:
 *
 * - `rowLabel`, when the author gives one, is used verbatim — the author knows what a user reads.
 *   The one thing it must satisfy is the shape every row name satisfies (one to three plain words,
 *   no structural marks): a name that breaks it is rejected at registration and reported, never
 *   rewritten (`./row-names.ts`, N7–N9).
 * - otherwise the bridge derives one from the visible text the author already wrote (`title` for a
 *   section, `label` for a card style): lowercase words joined by single spaces, dots and the rest
 *   of the punctuation dropped, no prefix, clamped to the same word limit. `"BASH CARD"` →
 *   `"bash card"`, `"usageCost"` → `"usage cost"`, `"bash-card.status"` → `"bash card status"`,
 *   `"MUSIC PLAYER NOW PLAYING"` → `"music player now"`. A derived name therefore always passes the
 *   shape check the bridge applies to an explicit one. * - two sections whose labels would read the same are told apart deterministically, and never by
 *   appending the raw id: the first keeps `music`, the next gets `music 2`, `music 3`, …
 *   `/bridge-status` reports the same assignment (see `sectionRowLabels`) instead of recomputing it.
 *
 * The id stays identity: the replacement key, the disposer's key and the visibility store's key.
 * Nothing in this module reads an id, so no id can leak into a row.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { MAX_ROW_NAME_WORDS } from "./row-names.ts";
import type { CardStyleRegistration, SidebarSection } from "./types.ts";

/** Possessives lose the apostrophe instead of splitting one word in two: `Loon's` → `loons`. */
const APOSTROPHES = /['’]/gu;
/** `XMLHttp` → `XML Http`, before the lower→upper rule below runs on the remainder. */
const ACRONYM_BREAK = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;
/** `usageCost` → `usage Cost`. */
const CAMEL_BREAK = /(\p{Ll}|\p{N})(\p{Lu})/gu;
/** Everything that is not a letter or a digit: dots, dashes, arrows, runs of spaces. */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * The readable form of one piece of visible text: lowercase words joined by single spaces, with
 * every non-word character — a dot above all — turned into a word break.
 *
 * Returns the empty string when the text carries no letters or digits at all (`"···"`); the
 * callers then use their surface's fallback word rather than inventing an id-shaped label.
 */
export function deriveRowLabel(text: string): string {
  return String(text)
    .replace(APOSTROPHES, "")
    .replace(ACRONYM_BREAK, "$1 $2")
    .replace(CAMEL_BREAK, "$1 $2")
    .replace(NON_WORD, " ")
    .trim()
    .toLowerCase();
}

/** A title with no words still needs a label; this is the section one. */
export const SECTION_LABEL_FALLBACK = "section";
/** The card-style counterpart, used for a label that carries no words. */
export const CARD_STYLE_LABEL_FALLBACK = "card style";

/**
 * Apply the row-name shape to derived text (N8): the same one-to-three-plain-words limit the bridge
 * enforces on an author's name. Marks are already gone — `NON_WORD` turned every one of them into a
 * word break — so clamping is what keeps a long title from deriving a name the bridge would reject.
 *
 * Clamping is the ONLY transformation the bridge performs, and it is confined to text it derives
 * itself: an author's own `rowLabel` is never rewritten, it is rejected (`./row-names.ts`).
 */
function clampWords(text: string): string {
  return text
    .split(" ")
    .filter((word) => word !== "")
    .slice(0, MAX_ROW_NAME_WORDS)
    .join(" ");
}

/** The label a section's row reads: the author's `rowLabel`, else the title made readable. */
export function sectionRowLabelText(section: Pick<SidebarSection, "title" | "rowLabel">): string {
  if (section.rowLabel !== undefined) return section.rowLabel;
  const derived = clampWords(deriveRowLabel(section.title));
  return derived === "" ? SECTION_LABEL_FALLBACK : derived;
}

/** The label a card style's row reads: the author's `rowLabel`, else the style `label`. */
export function cardStyleRowLabelText(
  style: Pick<CardStyleRegistration, "label" | "rowLabel">,
): string {
  if (style.rowLabel !== undefined) return style.rowLabel;
  const derived = clampWords(deriveRowLabel(style.label));
  return derived === "" ? CARD_STYLE_LABEL_FALLBACK : derived;
}

/** One section with the label its two `Sections` rows will read. */
export interface SectionRowLabel {
  section: SidebarSection;
  /** The label itself; unique among the labels of this build. */
  label: string;
  /** The label before disambiguation: the author's `rowLabel`, or the derived title. */
  base: string;
  /** Present when `base` was already taken: the label this section had to move away from. */
  collision?: string;
}

/**
 * Assign every section its row label, in the order the sections render: an explicit `rowLabel` or
 * the derived title, then the lowest free ordinal suffix (`music 2`, `music 3`, …) when another
 * section already took the label — clamped, like the base, to the row-name word limit.
 *
 * Deterministic by construction: the input order is the render order (`snapshotSections`), the
 * suffix is the lowest free integer, and nothing depends on map iteration or on time. A
 * replacement or a disposal can legitimately move a section between `music` and `music 2`; the
 * result is still one assignment per build, and `/bridge-status` reports the one in force.
 *
 * Equality is exact, the way the host compares `choice.setting`: `Music` and `music` are two
 * different line names. A derived label is always lowercase, so a clash between two derived labels
 * is always caught.
 */
/**
 * The label an equal base takes when another registration already reads it: the base plus the
 * lowest free ordinal. The result still honours the row-name word limit, so a three-word base yields
 * `music player 2` (the ordinal replaces its last word) instead of a four-word name the bridge would
 * have refused from an author. Deterministic: the input order is the render order and the ordinal is
 * the lowest free integer.
 */
function disambiguate(base: string, suffix: number): string {
  const words = base.split(" ");
  const kept = words.length >= MAX_ROW_NAME_WORDS ? words.slice(0, MAX_ROW_NAME_WORDS - 1) : words;
  return `${kept.join(" ")} ${suffix}`;
}

export function sectionRowLabels(
  sections: readonly SidebarSection[],
): SectionRowLabel[] {
  const taken = new Set<string>();
  return sections.map((section) => {
    const base = sectionRowLabelText(section);
    let label = base;
    let suffix = 2;
    while (taken.has(label)) label = disambiguate(base, suffix++);
    taken.add(label);
    return label === base ? { section, label, base } : { section, label, base, collision: base };
  });
}

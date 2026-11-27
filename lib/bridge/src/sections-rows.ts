/**
 * The automatic `Sections` toggle rows (S5, S6): the half of the sidebar feature a user actually
 * clicks.
 *
 * A plugin that calls `registerSection` never writes a `setting`, a `value`, a `current()`, an
 * `action()` or a `preview()`, and never names the `Sections` category — this module derives all of
 * it. That is S1's promise: adding the section is the whole integration.
 *
 * ## The toggle
 *
 * Two consecutive rows share one `choice.setting` — the line's name, which the host prints — with
 * values `shown` and `hidden`, so the host's renderer draws one line: `music  ● shown  ○ hidden`.
 * The setting is the row's LABEL, derived from the title (or the author's `rowLabel`): an id in
 * that field would put `Section: bash-card.status` in front of the user (N1, N2, `./row-labels.ts`).
 * The section id stays identity — replacement, the disposer, the visibility store — and never
 * reaches a row. `current()` reads the persisted value live, `action()` writes it before returning
 * (the host repaints afterwards, and its repaint re-reads `current()`), and `preview()` draws the
 * host's ONE shared `Sections` preview with the bridge's own sections in it (`./sections-preview.ts`)
 * instead of a picture of the card: every `Sections` row previews the same list.
 *
 * ## Where the value lives
 *
 * In the bridge's own store, keyed by section id — see `./visibility.ts` for the document and for why
 * the host's `visual-customization.json` cannot hold it. Visibility is bridge-owned state, not plugin
 * state: the bridge added the toggle, so the plugin needs no store, no file and no setting name.
 *
 * Rows are built per menu build from the live registry, so a section registered later appears (and a
 * disposed section's rows disappear) without re-registering this provider. Rows must not be cached
 * anywhere: a cached list would freeze the sections that existed at the first build.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { registerBridgeRows, snapshotSections } from "./bus.ts";
import { refreshCardStyleSurfaces } from "./card-style-wiring.ts";
import { requestSurfaceRepaint } from "./repaint.ts";
import { sectionRowLabels } from "./row-labels.ts";
import { sharedSectionsPreview } from "./sections-preview.ts";
import type { CustomizeRow, SidebarSection } from "./types.ts";
import { getSectionVisibility, isSectionVisible, setSectionVisible } from "./visibility.ts";

/** The internal provider's id; it is the bridge's own registration, never a plugin's. */
export const SECTION_ROWS_PROVIDER_ID = "bridge.sections";

/** The host category the rows join; it already exists and the bridge cannot create one. */
export const SECTIONS_CATEGORY = "Sections";

export const SECTION_SHOWN = "shown";
export const SECTION_HIDDEN = "hidden";

/** One of a toggle's two values. */
export type SectionValue = typeof SECTION_SHOWN | typeof SECTION_HIDDEN;

/**
 * Marks a row this module created. `Sections` is the host's category and the bridge's own rows share
 * it, so the shared-preview patch (`./sections-preview.ts`) needs a way to tell the two apart: a
 * bridge row is skipped, because its preview is already the merged list.
 */
export const SECTION_TOGGLE_ROW = Symbol.for("gentle-shell-bridge.sections-rows.toggle.v1");

function toggleRow(section: SidebarSection, label: string, value: SectionValue): CustomizeRow {
  const shown = value === SECTION_SHOWN;
  const row: CustomizeRow = {
    category: SECTIONS_CATEGORY,
    // The label names the line, so a user can tell which toggle controls what. It is the SAME string
    // as `choice.setting`, because the host prints the setting as the line's name; the id is not a
    // label and never appears here.
    label: () => label,
    choice: {
      setting: label,
      value,
      // Move the cursor, press Enter to apply (A1, `docs/contract.md` §4): the host applies a choice on
      // ←/→ only when this field is not `false`, and a bridge row that applied on the move made the
      // user's focus land on a value they never confirmed. `lib/visual-customize-view.ts:565`.
      applyOnMove: false,
      // Live read: the bullet reflects what is on disk right now, not what was true at build time.
      current: () => isSectionVisible(getSectionVisibility(), section) === shown,
    },
    // The host's shared preview, with this row's own hypothetical applied: the same list the host's
    // own `Sections` rows draw, never a picture of the card.
    preview: () => sharedSectionsPreview(label, shown, section.id),
    // Persist FIRST and synchronously; the host's repaint runs after this returns and re-reads
    // `current()`, so the bullet cannot land on a value that was never written. The store is keyed
    // by the section id, never by the label.
    //
    // Then REPAINT the rail before returning (R3): writing the store alone changes nothing on screen
    // until the host is told, which is why a bridge row used to lag behind the host's own rows by
    // seconds. A press that would store the value already in force changes nothing and asks for no
    // frame.
    action: () => {
      if (isSectionVisible(getSectionVisibility(), section) === shown) return;
      setSectionVisible(section.id, shown);
      refreshCardStyleSurfaces();
      requestSurfaceRepaint({
        cause: `section ${JSON.stringify(section.id)} → ${shown ? "shown" : "hidden"}`,
        surfaces: ["rail"],
      });
    },
  };
  Object.defineProperty(row, SECTION_TOGGLE_ROW, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return row;
}

/**
 * Register the bridge's own rows provider and return its disposer. Safe to call more than once: the
 * bus replaces a provider with the same `id` in place, so one entry (and one `Sections` line per
 * section) always exists.
 */
export function installSectionRows(): () => void {
  return registerBridgeRows({
    id: SECTION_ROWS_PROVIDER_ID,
    category: SECTIONS_CATEGORY,
    rows: () => {
      const rows: CustomizeRow[] = [];
      // Per build, from the live registry: the collision assignment depends on which sections exist
      // right now, so it is recomputed here and reported by `/bridge-status` through the same
      // function — the menu and the report can never disagree.
      for (const entry of sectionRowLabels(snapshotSections())) {
        // Both values are emitted even while the section is hidden: that toggle is how a user
        // brings it back.
        rows.push(
          toggleRow(entry.section, entry.label, SECTION_SHOWN),
          toggleRow(entry.section, entry.label, SECTION_HIDDEN),
        );
      }
      return rows;
    },
  });
}

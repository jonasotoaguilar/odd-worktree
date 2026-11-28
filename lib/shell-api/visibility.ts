/**
 * Bridge-owned section visibility (S5, S6).
 *
 * Whether a section is shown is the BRIDGE's state, not the plugin's: the plugin asked for a
 * section, the bridge added the toggle that hides it. Keeping it in the bridge's own store is what
 * makes S1's "one call, zero extra steps" true — a plugin never needs a store, a setting name, a
 * file or a `current()` of its own, and a user's choice survives `/reload` like any native setting.
 *
 * Why not the host's `visual-customization.json`: the host validates that file against a closed
 * `VISUAL_SECTION_KEYS` list (`lib/visual-customization-policy.ts:82`, `keysMatch` ~:112-130) and
 * rejects unknown keys, so a third-party section key cannot live there (S6). The user experience is
 * the native one; the file deliberately is not.
 *
 * One file, one key. `createStore("bridge-sections")` writes
 * `<gentle config home>/gentle-shell-bridge/bridge-sections.json`:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "values": {
 *     "sections": { "loon.music": false }
 *   }
 * }
 * ```
 *
 * `sections` maps a section id to `true` (shown) / `false` (hidden); a missing id falls back to the
 * section's `defaultVisible` (absent means shown). Values that are not booleans are ignored rather
 * than coerced, so a hand-edited file cannot make a "hidden" section render.
 */

import { isRecord } from "./rows.ts";
import { createStore } from "./store.ts";
import type { SidebarSection } from "./types.ts";

/** The bridge's own plugin id for section visibility: one namespaced file for every section. */
export const SECTIONS_STORE_ID = "bridge-sections";

/** The key that holds section visibility. */
export const SECTIONS_STORE_KEY = "sections";

/**
 * The key that holds section collapse state (N13). One file, two keys: both are bridge-owned state
 * about the same sections, so a user's choices survive `/reload` together, and a single store write
 * can never erase the other map.
 *
 * ```json
 * { "schemaVersion": 1, "values": { "sections": { "loon.music": false }, "collapsed": { "loon.music": true } } }
 * ```
 */
export const SECTIONS_COLLAPSED_KEY = "collapsed";

/** Section id → visible. Only booleans from disk survive the read. */
export type SectionVisibility = Record<string, boolean>;

/** Section id → collapsed. Same rules as `SectionVisibility`. */
export type SectionCollapsed = Record<string, boolean>;

function toFlagMap(value: unknown): SectionVisibility {
  // A NULL-prototype map on purpose: a persisted key such as `__proto__` must be an ordinary entry.
  // On a plain `{}` that write hits the inherited setter, is silently dropped, and the next toggle
  // erases it (B2).
  const map = Object.create(null) as SectionVisibility;
  if (!isRecord(value)) return map;
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") map[id] = entry;
  }
  return map;
}

/**
 * Read one flag map once. One read per frame (the renderer) and one per menu build (the rows), so a
 * frame never costs a file read per section.
 */
function readFlags(key: string): SectionVisibility {
  return toFlagMap(createStore(SECTIONS_STORE_ID).get<unknown>(key, {}));
}

/**
 * Whether one section's flag is on right now: the persisted value when there is one, otherwise the
 * caller's fallback.
 */
function isFlagOn(
  map: SectionVisibility,
  id: string,
  fallback: boolean,
): boolean {
  // Own property only: the map has no prototype, but a caller may hand us an ordinary object, and
  // `map["constructor"]` must never resolve to `Object`'s.
  const stored = Object.hasOwn(map, id) ? map[id] : undefined;
  return typeof stored === "boolean" ? stored : fallback;
}

/**
 * Persist one flag, FIRST and synchronously, so the host's repaint that follows reads the new value.
 * Reads the current map in the same call, so two sections' writes never overwrite each other, and
 * writes through the same null-prototype shape the read produced.
 */
function writeFlag(key: string, id: string, value: boolean): void {
  const store = createStore(SECTIONS_STORE_ID);
  const current = toFlagMap(store.get<unknown>(key, {}));
  const next = Object.create(null) as SectionVisibility;
  for (const [entry, flag] of Object.entries(current)) next[entry] = flag;
  next[id] = value;
  store.set(key, next);
}

/**
 * Read the whole visibility map once. One read per frame (the renderer) and one per menu build (the
 * rows), so a frame never costs a file read per section.
 */
export function getSectionVisibility(): SectionVisibility {
  return readFlags(SECTIONS_STORE_KEY);
}

/**
 * Whether one section is visible right now: the persisted value when there is one, otherwise the
 * section's `defaultVisible` (absent means visible).
 */
export function isSectionVisible(
  visibility: SectionVisibility,
  section: Pick<SidebarSection, "id" | "defaultVisible">,
): boolean {
  return isFlagOn(visibility, section.id, section.defaultVisible !== false);
}

/**
 * Persist one section's visibility, FIRST and synchronously, so the host's repaint that follows
 * reads the new value.
 */
export function setSectionVisible(id: string, visible: boolean): void {
  writeFlag(SECTIONS_STORE_KEY, id, visible);
}

/**
 * The whole collapse map (N13). Collapsed is bridge-owned state for the same reason visibility is:
 * the bridge added the header that folds the card, so the plugin needs no flag, no setting and no
 * store of its own.
 */
export function getSectionCollapsed(): SectionCollapsed {
  return readFlags(SECTIONS_COLLAPSED_KEY);
}

/**
 * Whether one section is collapsed right now. A section with no stored value is EXPANDED: a card a
 * user has never folded is open, which is the state the host's own sections start in.
 */
export function isSectionCollapsed(collapsed: SectionCollapsed, section: Pick<SidebarSection, "id">): boolean {
  return isFlagOn(collapsed, section.id, false);
}

/** Persist one section's collapse state, FIRST and synchronously, for the repaint that follows. */
export function setSectionCollapsed(id: string, collapsed: boolean): void {
  writeFlag(SECTIONS_COLLAPSED_KEY, id, collapsed);
}

/**
 * The section's panel drawing (N11): the host's header and row builders, reached when they are
 * reachable and reproduced byte for byte when they are not.
 *
 * ## What the host draws, and why we must draw it too
 *
 * A section must look like `AGENTS` / `CHANGES` / `STATS`. Those are drawn by
 * gentle-shell's `lib/shell-panel.ts`:
 *
 * ```ts
 * renderPanelHeader(theme, width, { title, count, countRole, open, hovered })
 *   → fitPanelLine(`${paintHoverable(theme, open ? "▾" : "▸", hovered, "muted")} ${theme.fg(hovered ? HOVER_ROLE : "text", bold(title.toUpperCase()))}`, count && theme.fg(countRole ?? "muted", count), width)
 * renderPanelRow(width, left, right) → fitPanelLine(`  ${left}`, right, width)
 * paintHoverable(theme, text, hovered, idleRole) → hovered ? theme.fg(HOVER_ROLE, text) : theme.fg(idleRole, text)
 * ```
 *
 * The theme comes from Pi: `ctx.ui.setWidget(key, (tui, theme) => Component)` is the documented
 * hand-out (`docs/extensions.md:2922`), and gentle-shell obtains its own theme the same way. So the
 * bridge captures that theme (`setSectionTheme`) instead of inventing a palette.
 *
 * ## Why the fallback exists
 *
 * The host's builders are NOT reachable: gentle-shell is not a dependency of this package, and Pi
 * loads each extension through its own jiti loader with `moduleCache: false`, so
 * `lib/shell-panel.ts` is not importable and publishes no seam on any object the bridge is handed.
 * Rather than claim otherwise, this module:
 *
 * 1. LOOKS, on every object the bridge is actually given — the rail part, the Pi theme, the
 *    terminal's sidebar state — for the host's two builder functions (`notePanelCandidate`);
 * 2. uses them when they are found, and reports `host` in `/bridge-status`;
 * 3. otherwise draws with the local port of the same algorithm (`renderSectionHeader` /
 *    `renderSectionRow`), which `test/section-panel.test.ts` compares byte for byte against the
 *    host's code transcribed into the test, and reports `fallback` with what was looked for and what
 *    was found (N15).
 *
 * Width is not a difference any more (N17): both sides measure the way pi-tui's `visibleWidth`
 * measures, because the host's card frame and its rail gate read the row with that model —
 * `hostColumns` ports it (a TAB is three columns, a grapheme cluster is charged as a whole), so a
 * row fitted to `width` here is never wider than `width` to the host.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { hostColumns } from "./card-style-transform.ts";
import { isRecord } from "./rows.ts";
import { TONES, type SectionRow, type Tone } from "./types.ts";

/** Columns a panel row is indented under its header (`lib/shell-panel.ts:26`). */
export const PANEL_ROW_INDENT = 2;

/** The single role every clickable host surface paints its own hover with (`lib/shell-hover.ts:33`). */
export const HOVER_ROLE: Tone = "warning";

/** The role a header's glyph and count use when they are not hovered. */
const IDLE_META_ROLE: Tone = "muted";

/** The role a row's label uses when its `tone` is absent. */
const IDLE_TEXT_ROLE: Tone = "text";

/**
 * The theme the panel draws with: Pi's own theme, as far as this module reads it. Reached through
 * Pi's documented `setWidget` factory (`docs/extensions.md:2922`) — the same hand-out
 * gentle-shell's own parts take their theme from.
 */
export interface PanelTheme {
  fg(role: string, text: string): string;
  bold?(text: string): string;
}

/** One header, in the shape the host's `renderPanelHeader` takes (`lib/shell-panel.ts:31-42`). */
export interface PanelHeader {
  title: string;
  count?: string;
  countRole?: string;
  open: boolean;
  hovered?: boolean;
}

/**
 * The host's own builders, when a host publishes them. Only these two: a row is composed by this
 * package (glyph, label, meta with their roles), exactly as `lib/agents-widget.ts:400-407`
 * composes one before handing it to `renderPanelRow`.
 */
export interface HostPanelBuilders {
  renderPanelHeader(theme: PanelTheme, width: number, header: PanelHeader): string;
  renderPanelRow(width: number, left: string, right?: string, indent?: number): string;
}

export type PanelSource = "host" | "fallback";

/** What `/bridge-status` says about the frame: which drawing was used, and what it looked for. */
export interface PanelReport {
  source: PanelSource;
  /** The candidate objects that were inspected, in the order they were offered. */
  lookedAt: string[];
  /** What was missing, as a person reads it. Empty when the host's builders were found. */
  missing: string[];
  theme: "captured" | "missing";
}

interface PanelState {
  theme?: PanelTheme;
  builders?: HostPanelBuilders;
  lookedAt: string[];
  missing: string[];
}

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const PANEL_STATE = Symbol.for("gentle-shell-bridge.section-panel.state.v1");

function panelHost(): Record<symbol, PanelState | undefined> {
  // SAFETY: only `panelState()` writes this key, and it re-checks the shape before trusting it.
  return globalThis as unknown as Record<symbol, PanelState | undefined>;
}

function isPanelStateLike(value: unknown): value is PanelState {
  return isRecord(value) && Array.isArray(value.lookedAt) && Array.isArray(value.missing);
}

function panelState(): PanelState {
  const host = panelHost();
  const existing = host[PANEL_STATE];
  if (isPanelStateLike(existing)) return existing;
  const created: PanelState = { lookedAt: [], missing: [] };
  host[PANEL_STATE] = created;
  return created;
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetSectionPanelForTests(): void {
  const state = panelState();
  delete state.theme;
  delete state.builders;
  state.lookedAt = [];
  state.missing = [];
}

/**
 * Remember the theme Pi handed the widget factory. Anything without a callable `fg` is not a theme
 * and is ignored, so a foreign or partial value can never make a row throw.
 */
export function setSectionTheme(theme: unknown): void {
  const state = panelState();
  notePanelCandidate("the Pi theme", theme);
  if (!isPanelTheme(theme)) {
    delete state.theme;
    return;
  }
  state.theme = theme;
}

function isPanelTheme(value: unknown): value is PanelTheme {
  return isRecord(value) && typeof value.fg === "function";
}

/** The captured theme, or `undefined` before Pi has run the factory. */
export function getSectionTheme(): PanelTheme | undefined {
  return panelState().theme;
}

/**
 * Look for the host's panel builders on one object the bridge was handed (N11, N15). Called with the
 * rail part, the Pi theme and the terminal's sidebar state — every object in this package's reach —
 * so the answer in `/bridge-status` is a measurement of this run, not a claim in a comment.
 */
export function notePanelCandidate(label: string, value: unknown): void {
  const state = panelState();
  if (!state.lookedAt.includes(label)) state.lookedAt.push(label);
  if (state.builders !== undefined) return;
  const builders = asHostPanel(value);
  if (builders !== undefined) {
    state.builders = builders;
    state.missing = [];
    return;
  }
  if (!state.missing.includes(label)) state.missing.push(label);
}

function asHostPanel(value: unknown): HostPanelBuilders | undefined {
  if (!isRecord(value)) return undefined;
  const header = value.renderPanelHeader;
  const row = value.renderPanelRow;
  if (typeof header !== "function" || typeof row !== "function") return undefined;
  // SAFETY: both members were just proved callable; the host's own signatures are the contract this
  // adapter mirrors, and a member that misbehaves takes the same failure path as a local throw.
  return value as unknown as HostPanelBuilders;
}

/** The frame's report: which drawing was used, what was looked for and what was found. */
export function getPanelReport(): PanelReport {
  const state = panelState();
  return {
    source: state.builders === undefined ? "fallback" : "host",
    lookedAt: [...state.lookedAt],
    missing: state.builders === undefined ? [...state.missing] : [],
    theme: state.theme === undefined ? "missing" : "captured",
  };
}

// ---------------------------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------------------------

/** Clips plain-or-ANSI `text` to `width` host columns with an ellipsis; SGR codes are kept. */
function clipPanelText(text: string, width: number): string {
  if (width <= 0) return "";
  if (hostColumns(text) <= width) return text;
  let clipped = "";
  for (const unit of text.match(/\u001b\[[0-9;]*m|[\s\S]/gu) ?? []) {
    if (unit.startsWith("\u001b[")) {
      clipped += unit;
      continue;
    }
    if (hostColumns(clipped + unit) > width - 1) break;
    clipped += unit;
  }
  return `${clipped}…`;
}

/**
 * One author-written row, fitted to `width` HOST columns (N17): a row that already fits keeps its
 * exact bytes (N10), a wider one is cut with an ellipsis, and nothing is ever appended — padding is
 * the panel's business, and the panel pads to the same number the host measures.
 */
export function clipSectionRow(row: string, width: number): string {
  return clipPanelText(row, width);
}

/** `left` and `right` on one row exactly `width` host columns wide; `left` gives way first. */
function fitPanelLine(left: string, right: string, width: number): string {
  const target = Math.max(0, Math.floor(width));
  const rightWidth = hostColumns(right);
  const shownRight = rightWidth + 1 <= target ? right : "";
  const room = target - hostColumns(shownRight) - (shownRight ? 1 : 0);
  const shownLeft = clipPanelText(left, room);
  const pad = Math.max(0, target - hostColumns(shownLeft) - hostColumns(shownRight));
  return `${shownLeft}${" ".repeat(pad)}${shownRight}`;
}

/** Paint `text` in the shared hover role when hovered, unchanged otherwise (host's own helper). */
export function paintHoverable(
  theme: PanelTheme | undefined,
  text: string,
  hovered: boolean,
  idleRole?: string,
): string {
  if (theme === undefined) return text;
  if (hovered) return theme.fg(HOVER_ROLE, text);
  return idleRole === undefined ? text : theme.fg(idleRole, text);
}

function paint(theme: PanelTheme | undefined, role: string, text: string): string {
  return theme === undefined ? text : theme.fg(role, text);
}

/** The host's `renderPanelHeader`, or the host's own function when one was found. */
export function renderSectionHeader(
  theme: PanelTheme | undefined,
  width: number,
  header: PanelHeader,
): string {
  const host = panelState().builders;
  if (host !== undefined && theme !== undefined) return host.renderPanelHeader(theme, width, header);
  const glyph = paintHoverable(theme, header.open ? "▾" : "▸", header.hovered ?? false, IDLE_META_ROLE);
  const name = header.title.toUpperCase();
  const bold = theme?.bold;
  const painted = bold === undefined ? name : bold(name);
  const title = paint(theme, header.hovered === true ? HOVER_ROLE : IDLE_TEXT_ROLE, painted);
  const count = header.count === undefined ? "" : paint(theme, header.countRole ?? IDLE_META_ROLE, header.count);
  return fitPanelLine(`${glyph} ${title}`, count, width);
}

/**
 * One structured body row, composed the way the host's own `AGENTS` rows are
 * (`lib/agents-widget.ts:400-407`): glyph and label in the row's `tone` (or the idle roles), the
 * right-aligned `meta` in the dimmer `muted` role, and every part swapped to the hover role while
 * the pointer is on it.
 */
export function renderSectionRow(
  theme: PanelTheme | undefined,
  width: number,
  row: SectionRow,
  hovered: boolean,
): string {
  const tone = row.tone ?? IDLE_TEXT_ROLE;
  const glyphRole = row.tone ?? IDLE_META_ROLE;
  const glyph = row.glyph === undefined ? "" : `${paintHoverable(theme, row.glyph, hovered, glyphRole)} `;
  const label = paintHoverable(theme, row.label, hovered, tone);
  const meta = row.meta === undefined ? "" : paintHoverable(theme, row.meta, hovered, IDLE_META_ROLE);
  const left = `${glyph}${label}`;
  const host = panelState().builders;
  if (host !== undefined && theme !== undefined) {
    return host.renderPanelRow(width, left, meta, PANEL_ROW_INDENT);
  }
  return fitPanelLine(`${" ".repeat(PANEL_ROW_INDENT)}${left}`, meta, width);
}

// ---------------------------------------------------------------------------------------------
// Row validation (N10)
// ---------------------------------------------------------------------------------------------

/** One accepted body row: a plain string, or a validated structured row. */
export type AcceptedRow = string | SectionRow;

export type RowCheck = { ok: true; rows: AcceptedRow[] } | { ok: false; message: string };

/**
 * Validate what a plugin's `lines()` returned, entry by entry. Nothing is coerced and nothing is
 * dropped silently: the first bad entry fails the whole body with a message naming the rule, exactly
 * as a non-string row did before structured rows existed.
 */
export function checkSectionRows(value: unknown): RowCheck {
  if (!Array.isArray(value)) {
    return { ok: false, message: "lines() must return an array of rows (a string or a { label } object)" };
  }
  // Index by index, NOT `every`/`map`: those skip array holes, and a hole reaches the clipping code
  // as `undefined` (B1).
  const rows: unknown[] = value;
  const accepted: AcceptedRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!Object.hasOwn(rows, index)) {
      return { ok: false, message: "lines() must not return a sparse array" };
    }
    const row: unknown = rows[index];
    if (typeof row === "string") {
      accepted.push(row);
      continue;
    }
    const checked = checkSectionRow(row);
    if (!checked.ok) return checked;
    accepted.push(checked.row);
  }
  return { ok: true, rows: accepted };
}

type SingleRowCheck = { ok: true; row: SectionRow } | { ok: false; message: string };

function checkSectionRow(row: unknown): SingleRowCheck {
  if (!isRecord(row)) {
    return {
      ok: false,
      message: "lines() must return an array of rows (a string or a { label } object)",
    };
  }
  if (typeof row.label !== "string") {
    return { ok: false, message: "a section row's label must be a string" };
  }
  if (row.meta !== undefined && typeof row.meta !== "string") {
    return { ok: false, message: "a section row's meta must be a string" };
  }
  if (row.glyph !== undefined && typeof row.glyph !== "string") {
    return { ok: false, message: "a section row's glyph must be a string" };
  }
  const onClick = row.onClick;
  if (onClick !== undefined && typeof onClick !== "function") {
    return { ok: false, message: "a section row's onClick must be a function" };
  }
  if (row.tone !== undefined && !isTone(row.tone)) {
    return {
      ok: false,
      message: `a section row's tone must be one of ${TONES.join(", ")} (a semantic role, never a colour)`,
    };
  }
  return {
    ok: true,
    row: {
      label: row.label,
      ...(row.meta === undefined ? {} : { meta: row.meta }),
      ...(row.glyph === undefined ? {} : { glyph: row.glyph }),
      ...(row.tone === undefined ? {} : { tone: row.tone }),
      ...(onClick === undefined ? {} : { onClick: onClick as () => void }),
    },
  };
}

function isTone(value: unknown): value is Tone {
  return TONES.includes(value as Tone);
}

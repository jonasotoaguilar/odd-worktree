/**
 * Section rendering (S3, S7, S8; N10–N14): the bridge's half of the sidebar surface, contributed
 * through the rail backend's `setRailContributor` extension point (`./sidebar.ts`).
 *
 * ## The host draws the frame, we supply the header and the rows
 *
 * A section must look like `AGENTS` / `CHANGES` / `STATS`, and those are drawn by the host's own
 * card frame — so the bridge never draws a box. It contributes two things per frame: the part's
 * rows, and the card groups over them. The group shape mirrors
 * `lib/shell-sidebar-layout.ts:392-410`: a group's `start` is the row that carries the card heading
 * (`▾ TITLE`, plus the count right-aligned) and `end` is one past the last body row, both indices
 * into the part's `render(width)` output, which is also what the group shape in
 * `test/fake-sidebar.ts` models. That is the contract T3 offsets and this module fills; the host
 * calls `sectionCardRows(headerParts(lines[start]), lines.slice(start + 1, end))` on it.
 *
 * ## The header and the rows are the host's own drawing (N11)
 *
 * The header comes from `./section-panel.ts`'s `renderSectionHeader` — caret from the section's own
 * collapse state, uppercase title, the right-aligned `meta`, the host's hover role — and a
 * structured row from `renderSectionRow`, composed the way `lib/agents-widget.ts:400-407` composes an
 * `AGENTS` row. Both use the host's builders when a host publishes them and the byte-identical local
 * port otherwise; `/bridge-status` reports which.
 *
 * ## A plain string row is untouched (N10)
 *
 * `lines()` may return a string or a `SectionRow`. A string keeps the exact bytes the author wrote —
 * no indent, no padding, no styling — so no existing plugin's card changes appearance. Only a
 * structured row gets the panel treatment, because only a structured row asked for it.
 *
 * ## Interaction (N12, N13)
 *
 * The host's own click model is POSITIONAL: it maps a pointer event into the part's frame and calls
 * the part's `handleMouse` (`lib/shell-sidebar-layout.ts:245-259`), so this module records which of
 * its own rows is the header and which are clickable, and answers only those events. A row without
 * `onClick` is inert: it never highlights and never answers. The header toggles the section; the
 * collapse flag lives in the bridge's store, like visibility (`./visibility.ts`), and the frame is
 * requested synchronously (`./repaint.ts`).
 *
 * ## What a section costs
 *
 * `lines(ctx)` and `meta(ctx)` run per frame, so a plugin's content is honest without a redraw API.
 * A hidden section is not built at all (S7), a COLLAPSED one is not built either (N13): no rows, and
 * neither function is called for the body. A throwing function, or a return that is not the
 * documented shape, drops that section's body, records the failure for `/bridge-status` and leaves
 * every other section and every native card rendering (S8).
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { resolveSectionPlacements, snapshotSections } from "./bus.ts";
import { hostColumns } from "./card-style-transform.ts";
import { requestSurfaceRepaint } from "./repaint.ts";
import { createRowContext } from "./rows.ts";
import {
  checkSectionRows,
  clipSectionRow,
  getSectionTheme,
  getPanelReport,
  renderSectionHeader,
  renderSectionRow,
  type AcceptedRow,
  type PanelTheme,
} from "./section-panel.ts";
import { claimSectionHover, releaseSectionHover } from "./section-pointer.ts";
import type {
  RailContribution,
  RailContributor,
  RailContributorContext,
  RailContributionPosition,
  RailMouseResult,
  RailPartContribution,
  RailRowRange,
} from "./sidebar.ts";
import { setRailContributor } from "./sidebar.ts";
import { RAIL_PARTS } from "./types.ts";
import type { RailPart, SectionContext, SidebarSection } from "./types.ts";
import {
  getSectionCollapsed,
  getSectionVisibility,
  isSectionCollapsed,
  isSectionVisible,
  setSectionCollapsed,
} from "./visibility.ts";

/** Rows a section body may occupy before the rest is elided. */
export const MAX_SECTION_BODY_ROWS = 8;

/** The row that marks an elided body; it always fits a sane rail width. */
const ELISION = (hidden: number): string => `… +${hidden} more`;

/** A section whose `lines()` or `meta()` misbehaved in the most recent frame. */
export interface SectionRenderFailure {
  sectionId: string;
  phase: "meta" | "lines" | "onClick";
  message: string;
}

/**
 * One physical row of the last contribution, so a pointer event can be mapped to what the user sees
 * (N12). `y` in a part's mouse event counts the PART's rows; `row` counts this contribution's,
 * which is why the backend hands us the offset (`RailContributionPosition`).
 */
export interface SectionRowHit {
  /** Index within the contribution (not the part's frame). */
  row: number;
  sectionId: string;
  kind: "header" | "body";
  /** The hover identity, for a row that can be highlighted; absent for an inert row. */
  key?: string;
  /** What a click on this row does; absent for an inert row. */
  activate?: () => void;
}

/** Where the most recent render stood on width (N20): what it was given, and its widest row. */
interface SectionFrame {
  width: number;
  /** The widest row any part produced at this width, measured the way the host measures (N20). */
  widest: number;
}

/** The rows this contributor drew for ONE part, at the width they were drawn at (S3). */
interface SectionPartRanges {
  width: number;
  /** One block per side of the part's own rows, so a pointer event can be mapped to what it hit. */
  blocks: SectionBlock[];
}

/** One block of contributed rows: the rows this contributor drew on one side of one part. */
interface SectionBlock {
  side: "before" | "after";
  hits: SectionRowHit[];
}

// Bumped to v2 with the per-part ranges: a copy at 0.16.1 shares this slot, and its single wide
// `frame.blocks` is not the shape read below, so the two versions must not read one another's state.
const SECTION_RENDER_STATE = Symbol.for("gentle-shell-bridge.sections.render.v2");

interface SectionRenderState {
  /** What the most recent frame failed on, so `/bridge-status` reports the latest frame. */
  lastFailures: SectionRenderFailure[];
  /** The most recent render's width and its widest row (N20). */
  frame?: SectionFrame;
  /**
   * The rows of the most recent contribution of EACH part, for pointer hit-testing. Replaced
   * wholesale when that part renders, so a part re-rendered inside one pass cannot double count and a
   * part that lost every section loses its ranges — and a part re-rendered on its own, which is what
   * the host's memo does, leaves every other part's ranges alone (S1, S3).
   */
  partRanges?: Map<RailPart, SectionPartRanges>;
  /** The hovered row's key, or absent when the pointer is not on one of ours. */
  hovered?: string;
  /**
   * The paint index of the part rendered last. The layout renders the parts in paint order, so a
   * part at or before the previous index means a NEW pass began — which is how one report of
   * failures survives across the four parts of the same pass.
   */
  lastPartIndex?: number;
}

function renderStateHost(): Record<symbol, SectionRenderState | undefined> {
  // SAFETY: only `sectionRenderState()` writes this slot, and it validates the shape before use, so
  // a foreign or partial value is replaced rather than trusted.
  return globalThis as unknown as Record<symbol, SectionRenderState | undefined>;
}

function sectionRenderState(): SectionRenderState {
  const host = renderStateHost();
  const existing = host[SECTION_RENDER_STATE];
  if (existing !== undefined && Array.isArray(existing.lastFailures)) return existing;
  const created: SectionRenderState = { lastFailures: [] };
  host[SECTION_RENDER_STATE] = created;
  return created;
}

/** Sections that failed in the most recent frame, for `/bridge-status` (T6). */
export function getSectionFailures(): SectionRenderFailure[] {
  return sectionRenderState().lastFailures.map((failure) => ({ ...failure }));
}

/**
 * The width the last frame was handed and the widest row the bridge produced at it (N20), both in
 * the host's own columns. `undefined` until a frame contributed rows, so a report of a session whose
 * rail never painted stays exactly as it was.
 */
export interface SectionFrameWidth {
  /** The width the host handed this part. */
  given: number;
  /** The widest contributed row, as the host measures it; always `<= given` when N17 holds. */
  widest: number;
}

/** N20: the last render's given width and the widest line the bridge produced, host-measured. */
export function getSectionFrameWidth(): SectionFrameWidth | undefined {
  const frame = sectionRenderState().frame;
  if (frame === undefined) return undefined;
  return { given: frame.width, widest: frame.widest };
}

/**
 * Test-only seam; drops the last frame, the per-part ranges and the hover too, so one test cannot
 * leak into another.
 */
export function resetSectionFailuresForTests(): void {
  const state = sectionRenderState();
  state.lastFailures = [];
  delete state.frame;
  delete state.partRanges;
  delete state.hovered;
}

/**
 * Build one part's contribution: its cards, in the order the placement resolver decided, split into
 * the block ABOVE the host's own rows and the block below them (S1–S3, S5).
 *
 * The placement list is recomputed per part from the registry and the painted parts, so no frame
 * state can make one part disagree with another: the same registrations and the same painted set
 * always produce the same rows in the same place.
 */
export function buildSectionContribution(
  width: number,
  ctx: SectionContext,
  rail: RailContributorContext,
): RailPartContribution | undefined {
  // A part rendered at zero width has no room for a heading or a body row. Contributing nothing
  // keeps the host's own shape untouched instead of returning a row wider than the width.
  if (!Number.isFinite(width) || width < 1) return undefined;

  const state = sectionRenderState();
  const frame = beginPartFrame(state, rail.part, width);
  const visibility = getSectionVisibility();
  const collapsedMap = getSectionCollapsed();
  const theme = getSectionTheme();
  const hovered = state.hovered;
  const placements = resolveSectionPlacements(snapshotSections(), rail.painted);

  const blocks: SectionBlock[] = [];
  const contribution: RailPartContribution = {};
  for (const side of ["before", "after"] as const) {
    const sections = placements
      .filter((entry) => entry.part === rail.part && entry.side === side)
      .map((entry) => entry.section);
    if (sections.length === 0) continue;
    const built = buildBlock(sections, {
      width,
      theme,
      hovered,
      visibility,
      collapsedMap,
      ctx,
    });
    if (built === undefined) continue;
    blocks.push({ side, hits: built.hits });
    contribution[side] = built.contribution;
  }

  // This part's ranges are REPLACED, never merged: a part re-rendered inside the same pass must not
  // be counted twice, a part that lost every section must lose its row ranges too, and a part
  // re-rendered on its own must leave every other part's ranges untouched (S1, S3).
  partRanges(state).set(rail.part, { width, blocks });
  if (contribution.before === undefined && contribution.after === undefined) return undefined;
  return contribution;
}

/** The per-part row ranges, created on first use. */
function partRanges(state: SectionRenderState): Map<RailPart, SectionPartRanges> {
  const existing = state.partRanges;
  if (existing !== undefined) return existing;
  const created = new Map<RailPart, SectionPartRanges>();
  state.partRanges = created;
  return created;
}

/**
 * Start (or continue) one part's place in the pass. The layout renders the parts in paint order, so a
 * part whose index is not after the previous one belongs to a NEW pass: that is where the failure
 * list restarts, once per pass instead of once per part. The row ranges are NOT part of that reset —
 * they are recorded per part and replaced only when that part renders.
 */
function beginPartFrame(
  state: SectionRenderState,
  part: RailPart,
  width: number,
): SectionFrame {
  const index = RAIL_PARTS.indexOf(part);
  const frame = state.frame;
  const newPass =
    frame === undefined ||
    frame.width !== width ||
    state.lastPartIndex === undefined ||
    index <= state.lastPartIndex;
  if (newPass) {
    // Failures describe the pass, not history: a section that stops throwing stops being reported.
    state.lastFailures = [];
    state.frame = { width, widest: 0 };
  }
  state.lastPartIndex = index;
  // SAFETY: every branch above leaves a frame in place.
  return state.frame as SectionFrame;
}

/** One block of sections: their rows, their card groups and the pointer map over them. */
function buildBlock(
  sections: readonly SidebarSection[],
  frame: {
    width: number;
    theme: PanelTheme | undefined;
    hovered: string | undefined;
    visibility: ReturnType<typeof getSectionVisibility>;
    collapsedMap: ReturnType<typeof getSectionCollapsed>;
    ctx: SectionContext;
  },
): { contribution: RailContribution; hits: SectionRowHit[] } | undefined {
  const lines: string[] = [];
  const hits: SectionRowHit[] = [];
  const groups: Array<{ start: number; end: number }> = [];

  for (const section of sections) {
    // Hidden means NOT BUILT (S7): no rows, no `lines()`, no `meta()`. Hiding is a user choice, not
    // a request to compute something nobody will see — and it does NOT move the sections placed
    // after this one, because their slot was decided from the registration, not from these rows.
    if (!isSectionVisible(frame.visibility, section)) continue;

    const collapsed = isSectionCollapsed(frame.collapsedMap, section);
    const meta = readMeta(section, frame.ctx);
    // A meta failure drops the body too (S8's rule is about the section's BODY), while a body
    // failure keeps the heading so the user can still see that the section exists. A collapsed
    // section builds no body at all (N13) — folding must not cost the work of drawing.
    const body = meta.ok && !collapsed ? readBody(section, frame.ctx) : [];
    const start = lines.length;
    const headerKey = `${section.id}#header`;
    const headerHovered = frame.hovered === headerKey;
    lines.push(
      renderSectionHeader(frame.theme, frame.width, {
        title: section.title,
        ...(meta.text === undefined ? {} : { count: meta.text }),
        open: !collapsed,
        hovered: headerHovered,
      }),
    );
    hits.push({
      row: start,
      sectionId: section.id,
      kind: "header",
      key: headerKey,
      activate: () => toggleSectionCollapsed(section),
    });
    // Isolation is per SECTION, not per frame (S8): one section must never be able to throw away
    // its siblings' rows or its own heading. The validation in `readBody` catches the cases we know
    // about; this guard covers the ones we do not.
    try {
      appendBody(section, body, {
        theme: frame.theme,
        width: frame.width,
        hovered: frame.hovered,
        lines,
        hits,
      });
    } catch (error) {
      recordFailure(section.id, "lines", error);
      lines.length = start + 1; // keep the heading, drop the broken body
      hits.length = start + 1;
    }
    groups.push({ start, end: lines.length });
  }

  if (lines.length === 0) return undefined;
  // The frame's widest row, measured the way the host measures (N20).
  const frameState = sectionRenderState().frame;
  if (frameState !== undefined) {
    for (const line of lines) frameState.widest = Math.max(frameState.widest, hostColumns(line));
  }
  return { contribution: { lines, groups }, hits };
}

/** One section's body rows, each recorded for the pointer map as it is drawn. */
function appendBody(
  section: SidebarSection,
  body: readonly AcceptedRow[],
  frame: {
    theme: PanelTheme | undefined;
    width: number;
    hovered: string | undefined;
    lines: string[];
    hits: SectionRowHit[];
  },
): void {
  body.forEach((entry, index) => {
    const row = frame.lines.length;
    if (typeof entry === "string") {
      // Byte-identical (N10): a plain row is the author's text, clipped to the width and nothing
      // else — no indent, no padding, no styling, no hit target.
      frame.lines.push(clipRow(entry, frame.width));
      frame.hits.push({ row, sectionId: section.id, kind: "body" });
      return;
    }
    const key = entry.onClick === undefined ? undefined : `${section.id}#${index}`;
    frame.lines.push(
      renderSectionRow(frame.theme, frame.width, entry, key !== undefined && frame.hovered === key),
    );
    frame.hits.push({
      row,
      sectionId: section.id,
      kind: "body",
      ...(key === undefined ? {} : { key }),
      ...(entry.onClick === undefined ? {} : { activate: entry.onClick }),
    });
  });
}

/**
 * The contributor T3 calls once per frame. It resolves the same context a row provider gets — the
 * theme Pi handed the widget factory (so a section can paint with the host's own roles, N11) and the
 * resolved gentle-shell config home — so a section never re-derives a path.
 */
export const sectionRailContributor: RailContributor = {
  render: (width, rail) =>
    buildSectionContribution(width, createRowContext(getSectionTheme()), rail),
  // N14: the layout re-renders a part only when its digest moves, so the built rows are what the
  // signature is made of. Reading `meta()`/`lines()` here is the same trade the host's own parts
  // make (`extensions/gentle-agents.ts:2255-2260`): a live field has to be read to be noticed.
  digest: (rail) => sectionRailDigest(createRowContext(getSectionTheme()), rail),
  handleMouse: (event, position) => handleSectionMouse(event, position),
};

/**
 * A cheap signature of everything a frame would draw: the sections, their header counts, their
 * collapse flags, their rows and the hover state. Two frames that would draw the same rows have the
 * same signature, so a change anywhere in it — a `meta` that moved (N14), a collapse, a hover —
 * reaches the host's memo as a new digest and repaints.
 */
export function sectionRailDigest(ctx: SectionContext, rail: RailContributorContext): string {
  const visibility = getSectionVisibility();
  const collapsedMap = getSectionCollapsed();
  const state = sectionRenderState();
  const sections: unknown[] = [];
  for (const resolved of resolveSectionPlacements(snapshotSections(), rail.painted)) {
    const section = resolved.section;
    // Where the card goes is part of what the frame draws: a new anchor or a native part that stops
    // being painted has to reach the host's memo as a new signature, or the rows never move.
    const slot = [section.id, resolved.part, resolved.side];
    if (!isSectionVisible(visibility, section)) {
      sections.push([...slot, false]);
      continue;
    }
    const collapsed = isSectionCollapsed(collapsedMap, section);
    const meta = readMeta(section, ctx);
    const body = meta.ok && !collapsed ? readBody(section, ctx) : [];
    sections.push([
      ...slot,
      section.title,
      meta.text ?? null,
      collapsed,
      body.map(rowSignature),
    ]);
  }
  const panel = getPanelReport();
  return JSON.stringify([
    sections,
    rail.part,
    rail.painted,
    state.hovered ?? null,
    panel.source,
    themeSignature(),
  ]);
}

/** One body row, flattened into a comparable string for the digest (N14). */
function rowSignature(row: AcceptedRow): string {
  if (typeof row === "string") return `s:${row}`;
  const parts = [row.label, row.meta ?? "", row.glyph ?? "", row.tone ?? ""];
  return `r:${JSON.stringify(parts)}:${row.onClick === undefined ? "inert" : "acts"}`;
}

/**
 * What the current theme paints with. Pi hands extensions ONE live theme proxy, so identity never
 * changes on a theme switch; how the roles paint does. The host's memo keys on the same idea
 * (`lib/shell-sidebar-layout.ts:123-124`), which is why a themed row repaints when the theme changes.
 */
function themeSignature(): string {
  const theme = getSectionTheme();
  if (theme === undefined) return "no-theme";
  const roles = ["accent", "dim", "error", "muted", "success", "text", "warning"];
  try {
    return roles.map((role) => theme.fg(role, ".")).join("");
  } catch {
    return "theme-throws";
  }
}

/**
 * Answer a pointer event the host mapped into the part's frame (N12). Only our own rows answer, and
 * only where they act: the header always does (it folds the section), a body row only when it
 * carries `onClick`.
 *
 * The position the backend hands over is the set of ROW RANGES of this part's frame, so a block may
 * sit above the host's rows as well as below them (S7): the event is matched against the block that
 * contains it, and never against "everything after the host's rows".
 *
 * The ranges belong to ONE part and to the width that part was rendered at (S1, S3): the host's memo
 * re-renders a single part when its digest moves, and an event mapped at another width has no ranges
 * to be mapped onto, so both mismatches decline instead of guessing an offset.
 */
export function handleSectionMouse(
  event: unknown,
  position?: RailContributionPosition,
): RailMouseResult | undefined {
  if (position === undefined) return undefined;
  const state = sectionRenderState();
  const part = railPartNamed(position.part);
  const ranges = part === undefined ? undefined : state.partRanges?.get(part);
  if (ranges === undefined || ranges.width !== position.width) return undefined;
  const pointer = readPointer(event);
  if (pointer === undefined) return undefined;
  const block = blockAt(position, pointer.y);
  if (block === undefined) return undefined;
  const hits = ranges.blocks.find((candidate) => candidate.side === block.side)?.hits;
  if (hits === undefined) return undefined;
  const hit = hits.find((candidate) => candidate.row === pointer.y - block.start);
  if (hit === undefined) return undefined;

  if (pointer.type === "move") {
    if (hit.key === undefined) {
      // An inert row: never highlight, and let the host's own dispatch continue.
      return state.hovered === undefined ? undefined : clearHover();
    }
    if (state.hovered === hit.key) return { handled: true };
    state.hovered = hit.key;
    claimSectionHover(() => {
      clearHover();
    });
    requestSurfaceRepaint({
      cause: `section ${JSON.stringify(hit.sectionId)} ${hit.kind} hover`,
      surfaces: ["rail"],
    });
    return { handled: true, render: true };
  }

  if (pointer.type === "click") {
    if (pointer.button !== "left") return undefined;
    if (hit.activate === undefined) return undefined;
    // One click, one action (N12): the pointer stops hovering and the row's own work runs once. The
    // drop is silent — the action below asks for the frame, so a click costs one request, not two.
    dropHover();
    runActivate(hit);
    return { handled: true, render: true };
  }

  return undefined;
}

/** The painted part a position names, or `undefined` for a part the rail never wraps. */
function railPartNamed(part: string): RailPart | undefined {
  return RAIL_PARTS.find((candidate) => candidate === part);
}

/** Which of this contributor's two blocks the event's row falls in, and where that block starts. */
function blockAt(
  position: RailContributionPosition,
  y: number,
): { side: "before" | "after"; start: number } | undefined {
  const inRange = (range: RailRowRange | undefined): boolean =>
    range !== undefined && y >= range.start && y < range.end;
  if (position.before !== undefined && inRange(position.before)) {
    return { side: "before", start: position.before.start };
  }
  if (position.after !== undefined && inRange(position.after)) {
    return { side: "after", start: position.after.start };
  }
  return undefined;
}

function runActivate(hit: SectionRowHit): void {
  const activate = hit.activate;
  if (activate === undefined) return;
  try {
    activate();
  } catch (error) {
    // A plugin's `onClick` that throws must not escape into the host's pointer dispatch.
    recordFailure(hit.sectionId, "onClick", error);
  }
}

/** Drop the hover state and release the shared pointer, without asking for a frame. */
function dropHover(): void {
  sectionRenderState().hovered = undefined;
  releaseSectionHover();
}

/** Drop the hover and repaint — the path the host's own "pointer left" calls. */
function clearHover(): RailMouseResult {
  const state = sectionRenderState();
  const wasHovered = state.hovered !== undefined;
  dropHover();
  if (wasHovered) requestSurfaceRepaint({ cause: "section hover cleared", surfaces: ["rail"] });
  return { handled: true, render: true };
}

/** Fold or unfold one section (N13): persist first, then ask for the frame in the same call. */
function toggleSectionCollapsed(section: SidebarSection): void {
  const collapsed = isSectionCollapsed(getSectionCollapsed(), section);
  setSectionCollapsed(section.id, !collapsed);
  requestSurfaceRepaint({
    cause: `section ${JSON.stringify(section.id)} → ${collapsed ? "expanded" : "collapsed"}`,
    surfaces: ["rail"],
  });
}

/**
 * The one contributor the backend holds. Idempotent by construction: it stores one function in the
 * backend's state, so a second arm or a second package copy never doubles a card.
 */
export function installSectionRail(): void {
  setRailContributor(sectionRailContributor);
}

interface MetaResult {
  /** False when `meta()` threw or returned the wrong type: the whole body is dropped. */
  ok: boolean;
  /** Trimmed, non-empty text; absent when the section has no meta or it is blank. */
  text?: string;
}

function readMeta(section: SidebarSection, ctx: SectionContext): MetaResult {
  if (section.meta === undefined) return { ok: true };
  let value: unknown;
  try {
    value = section.meta(ctx);
  } catch (error) {
    recordFailure(section.id, "meta", error);
    return { ok: false };
  }
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") {
    recordFailure(section.id, "meta", new Error("meta() must return a string or undefined"));
    return { ok: false };
  }
  const text = value.trim();
  return text === "" ? { ok: true } : { ok: true, text };
}

function readBody(section: SidebarSection, ctx: SectionContext): AcceptedRow[] {
  let value: unknown;
  try {
    value = section.lines(ctx);
  } catch (error) {
    recordFailure(section.id, "lines", error);
    return [];
  }
  // A non-array, a hole or a malformed row is a failure, never coerced: a coerced row would show
  // garbage as if the plugin had meant it. The row rules live in one place (`./section-panel.ts`).
  const checked = checkSectionRows(value);
  if (!checked.ok) {
    recordFailure(section.id, "lines", new Error(checked.message));
    return [];
  }
  return capBody(checked.rows);
}

/** Keep the body inside the row budget, marking the elision visibly. */
function capBody(rows: readonly AcceptedRow[]): AcceptedRow[] {
  if (rows.length <= MAX_SECTION_BODY_ROWS) return [...rows];
  const kept = rows.slice(0, MAX_SECTION_BODY_ROWS - 1);
  // The marker occupies one of the budgeted rows and says how many are not shown. It is a plain
  // string, so it is drawn exactly as the author's own plain rows are.
  return [...kept, ELISION(rows.length - kept.length)];
}

/** The pointer fields of a mouse event, when it has the shape the host dispatches. */
function readPointer(event: unknown): { type: string; button?: string; y: number } | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const candidate = event as { type?: unknown; button?: unknown; y?: unknown };
  if (typeof candidate.type !== "string") return undefined;
  if (typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) return undefined;
  return {
    type: candidate.type,
    ...(typeof candidate.button === "string" ? { button: candidate.button } : {}),
    y: candidate.y,
  };
}

/**
 * Clamp one plain row to the width the host passes, with a visible marker instead of a silent cut.
 *
 * Measured the way the HOST measures a row (N17) — `./section-panel.ts`'s `clipSectionRow`, over
 * `hostColumns`: ANSI is zero columns, a TAB is three, and a grapheme cluster is charged as a whole —
 * so a CJK glyph, an emoji or a tab cannot make the row wider than the width it was fitted to. A row
 * that already fits keeps its exact bytes (N10). A STRUCTURED row is drawn by the panel builder,
 * which measures the same way.
 */
function clipRow(row: string, width: number): string {
  return clipSectionRow(row, width);
}

function recordFailure(
  sectionId: string,
  phase: SectionRenderFailure["phase"],
  error: unknown,
): void {
  const state = sectionRenderState();
  state.lastFailures.push({ sectionId, phase, message: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `status` diagnostics (S6). One command answers "why did no rows appear": providers, backend,
 * last capture, last failures, store problems and conflicting settings.
 *
 * `collectStatus` gathers live process state (bus, capture/hook/store diagnostics) and
 * `formatStatus` is a pure function over that snapshot, so the report is testable without a host
 * and the command prints exactly what the snapshot says. Nothing here mutates bridge state, and
 * nothing here renames or drops a row: a duplicate `category` + `setting` pair is reported, not
 * fixed (docs/contract.md §6).
 */

import {
  getRowPlacementLandings,
  getRowPlacementRejections,
  getSectionPlacementRejections,
  observedHostCategories,
  placementLandingText,
  resolveRowPlacements,
  resolveSectionPlacements,
  rowPlacementLandingText,
  snapshotCardStyles,
  snapshotProviders,
  snapshotSections,
  snapshotTransforms,
  type RowPlacementLandingRecord,
  type RowPlacementRejection,
  type SectionPlacementRejection,
} from "./bus.ts";
import {
  CARD_STYLE_ROWS_PROVIDER_ID,
  cardStyleRowMode,
  type CardStyleRowMode,
} from "./card-style-rows.ts";
import {
  getCardStyleLastOutcome,
  getCardStyleTransformFailures,
  type CardStyleFrameOutcome,
  type CardStyleTransformFailure,
} from "./card-style-transform.ts";
import { getCardStyleWiringDiagnostics, type CardStyleWiringDiagnostics } from "./card-style-wiring.ts";
import { resolveCardStyleSelection } from "./card-styles.ts";
import { getCaptureDiagnostics, type CaptureOutcome } from "./capture.ts";
import { getHookDiagnostics } from "./hook.ts";
import { getMessageDesignAdoptionDiagnostics } from "./message-design-adoption.ts";
import {
  MESSAGE_DESIGN_DEFAULT_LABEL,
  resolveMessageDesignFollow,
  MESSAGE_DESIGN_NATIVE,
  getMessageDesignConflicts,
  getMessageDesignFailures,
  getMessageDesignLineSelection,
  messageDesignLines,
  type MessageDesignConflict,
  type MessageDesignFailure,
  type MessageDesignLine,
} from "./message-designs.ts";
import { bridgeMessageDesignRowsProvider, messageDesignLineNames } from "./message-design-rows.ts";
import { snapshotNotices, type NoticeLevel } from "./notices.ts";
import {
  PAINT_SURFACES,
  getRepaintDiagnostics,
  getSurfaceReach,
  type PaintSurface,
  type RepaintTrigger,
} from "./repaint.ts";
import { getTransformFrameOutcomes, type TransformFrameCounts } from "./transform-pipeline.ts";
import { getPluginLineReport, type PluginLineReport } from "./plugin-lines.ts";
import { getGentlePiPresence } from "./presence.ts";
import { getToolDesignAdoptionDiagnostics } from "./tool-design-adoption.ts";
import {
  TOOL_DESIGN_NATIVE,
  getToolDesignConflicts,
  getToolDesignFailures,
  lineOfTool,
  resolveToolDesignSelection,
  snapshotToolDesigns,
  toolDesignClaims,
  toolDesignLines,
  toolNamesWithDesigns,
  type ToolDesignClaim,
  type ToolDesignConflict,
  type ToolDesignFailure,
  type ToolDesignLine,
} from "./tool-designs.ts";
import { TOOL_DESIGN_ROWS_PROVIDER_ID, toolDesignLineNames } from "./tool-design-rows.ts";
import {
  getToolDesignWiringDiagnostics,
  type ToolDesignResolverOutcome,
} from "./tool-design-wiring.ts";
import { getLastRowBuild, type RowBuildRecord } from "./rows.ts";
import {
  getSidebarDiagnostics,
  observedPaintedParts,
  type SidebarDiagnostics,
  type SidebarFailure,
} from "./sidebar.ts";
import { getSectionFailures, getSectionFrameWidth, type SectionRenderFailure } from "./sidebar-render.ts";
import { getPanelReport } from "./section-panel.ts";
import { getSectionHoverReport } from "./section-pointer.ts";
import { SECTION_ROWS_PROVIDER_ID } from "./sections-rows.ts";
import { sectionRowLabels } from "./row-labels.ts";
import { getRowNameRejections, type RowNameRejection } from "./row-names.ts";
import { getStoreDiagnostics, type StoreProblem } from "./store.ts";
import type { MessageDesignRegistration, RowContext, RowProvider } from "./types.ts";
import {
  getSectionCollapsed,
  getSectionVisibility,
  isSectionCollapsed,
  isSectionVisible,
} from "./visibility.ts";

export type StatusBackend = "hook" | "capture" | "none";

export interface StatusProviderEntry {
  id: string;
  category: string;
  /**
   * Where this provider asked its rows to sit and where they really land (S1–S3, S5). Present only
   * when the provider named a placement or the bridge could not honour the one it named, so a plain
   * provider keeps the entry (and the line) it had before this field existed.
   */
  placement?: StatusRowPlacement;
}

/** One provider's row placement, as `/bridge-status` lists it: requested, landed, why. */
export interface StatusRowPlacement {
  /** The request as a person reads it: `start`, `end`, `after "loon.news"`. */
  requested: string;
  /** Where the block really draws: `start`, `end`, `after "loon.news"`. */
  landed: string;
  /** Why it is not where it asked to be; absent when the request was honoured. */
  reason?: string;
}

/** Two providers contribute the same `category` + `choice.setting`. */
export interface StatusDuplicate {
  category: string;
  setting: string;
  providerIds: string[];
}

export interface StatusFailure {
  providerId: string;
  message: string;
  rowsDropped: boolean;
}

/** One registered sidebar section, as `/bridge-status` lists it. */
export interface StatusSectionEntry {
  id: string;
  title: string;
  /** The persisted (or default) visibility right now. */
  visible: boolean;
  /** Present only while the card is folded (N13); absent keeps every historical line unchanged. */
  collapsed?: true;
  /** The render position's source: an explicit integer, or registration order when absent. */
  order: number | "registration";
  /** The label the section's `Sections` row reads (N2). The id stays in `id`, never in a row. */
  rowLabel: string;
  /** Where the card asked to sit and where it really draws (S1, S5). Always reported. */
  placement: StatusSectionPlacement;
  /** Present when two sections wanted the same label: the label this one had to move away from. */
  rowLabelCollision?: string;
}

/** One section's placement, as `/bridge-status` lists it: what it asked for, where it landed, why. */
export interface StatusSectionPlacement {
  /** The request as a person reads it: `start`, `end`, `after "loon.news"`. */
  requested: string;
  /** Where the rows really draw: `before todo`, `after footer`, … */
  landed: string;
  /** Why it is not where it asked to be; absent when the request was honoured. */
  reason?: string;
}

/** A `placement` a registration had to refuse, with the section it belonged to. */
export type StatusSectionPlacementRejection = SectionPlacementRejection;

/** A row `placement` a registration had to refuse, with the provider it belonged to. */
export type StatusRowPlacementRejection = RowPlacementRejection;

/**
 * How the section frame is drawn and how the pointer reaches it (N11, N15): the answer to "is this
 * the host's own header, or a port of it, and what could the bridge not reach".
 */
export interface StatusSectionFrame {
  /** `host` when the host's own builders were found on an object the bridge is handed. */
  source: "host" | "fallback";
  /** Where they were looked for, in the order the objects were offered. */
  lookedAt: string[];
  /** What was missing, as a person reads it; empty when the host's builders were found. */
  missing: string[];
  /** Whether Pi has handed the widget factory a theme yet; without one, rows are uncoloured. */
  theme: "captured" | "missing";
  /** The pointer path: the host's own dispatch, and how the hover claim is carried. */
  hover: "host-state" | "unavailable" | "not used";
  hoverReason?: string;
  /**
   * N20: the width the last render was handed and the widest row the bridge produced at it, both in
   * the host's own columns. Absent until a frame contributes rows, so a session whose rail never
   * painted keeps its report unchanged.
   */
  width?: { given: number; widest: number };
}

/** One rejected row name, as `/bridge-status` lists it: the string verbatim and the rule it broke. */
export type StatusRowNameRejection = RowNameRejection;

/** One buffered notice, as `/bridge-status` lists it: still pending, or already delivered. */
export interface StatusNoticeEntry {
  level: NoticeLevel;
  message: string;
  delivered: boolean;
}

/** Where the sidebar interception stands, so a missing section has an answer. */
export type StatusSidebarState = "intercepted" | "no-sidebar-state" | "unarmed";

export interface StatusSidebarEntry {
  state: StatusSidebarState;
  /** Only for `no-sidebar-state`: why nothing could be intercepted. */
  reason?: string;
  /** Only when intercepted: whether the part we append to is in the host's map already. */
  rail?: "wrapped" | "pending";
}

/** One registered design of one tool, as `/bridge-status` lists it. */
export interface StatusToolDesignEntry {
  id: string;
  label: string;
  description?: string;
}

/** One value of a grouped line, with the tools it paints (S6/D4). */
export interface StatusToolDesignLineValue {
  /** The stored identity: `native` for `default`, otherwise the design's id. */
  id: string;
  label: string;
  /** The tools of the line this value paints. `default` covers every tool of the line. */
  covers: string[];
}

/** One grouped line, as `/bridge-status` lists it (D7). */
export interface StatusToolDesignLine {
  /** The registered line id (`tools`, `status`, …). */
  line: string;
  /** The name the menu shows: `Card tools`. */
  rowName: string;
  /** The line's whole tool set, the union of its designs' `tools`. */
  tools: string[];
  /** `default` first, then the line's designs in registration order. */
  values: StatusToolDesignLineValue[];
}

/** One line's claim on one tool, reported when that tool has SCOPED claims (S9/S14/S19). */
export interface StatusToolDesignClaim {
  /** Whether the claim comes from a tool's own implicit line or from a registered line. */
  kind: "tool" | "line";
  /** The line id, or the tool name for an ungrouped design's implicit line. */
  line: string;
  /** The design id stored for that line, or `native` when the line draws the host's own card. */
  stored: string;
  /**
   * Only when THIS (line, tool) claim is scoped: the scope's description, so a user can tell which
   * line owns which calls. A line that narrows one of its tools and claims another unconditionally
   * shows the scope on the claim it narrows, and none on the other.
   */
  scope?: string;
}

/** One tool with designs, its values, and the selection in force. */
export interface StatusToolDesignTool {
  tool: string;
  designs: StatusToolDesignEntry[];
  /** Only for a tool covered by a GROUPED line: the line id whose switch paints it (D7). */
  line?: string;
  /**
   * Every line that claims this tool, each with its stored value — present only when at least one
   * of them is a SCOPED claim (S14/S19). A tool claimed by one unscoped line keeps today's `line`
   * field and gains nothing here, so its report stays byte-identical.
   */
  claims?: StatusToolDesignClaim[];
  /** The stored value: a design id, `native`, or `<id> (missing: not registered)`. */
  selection: string;
  /**
   * Whether a card of this tool was built through the bridge's wrapper. With no selection the
   * wrapper draws the host's own rows, so `mounted` is the answer to "can a design selected now
   * still repaint this card?" (S2): an unwrapped card can never change again.
   */
  wrapper: "mounted" | "not mounted";
  /** Only when mounted: how many card components were built through the wrapper this process. */
  cards?: number;
  /**
   * How many card components were ADOPTED after construction this process (S10): the path that
   * reaches a card when a resolver ahead of the bridge answered the tool without calling `next()`.
   * Absent when no card was adopted, so a resolver-only session keeps its historical line.
   */
  adopted?: number;
}

/** The tool-design surface, reported only when the process has something to say (see below). */
export interface StatusToolDesigns {
  tools: StatusToolDesignTool[];
  /**
   * The grouped lines: their row name, their tools and each value's coverage (D7). Absent when every
   * design is ungrouped, so a pre-lines report keeps its historical shape byte for byte.
   */
  lines?: StatusToolDesignLine[];
  /** How many `pi` objects the ONE resolver was registered on; absent when never attempted. */
  resolver?: { registered: number; lastOutcome?: ToolDesignResolverOutcome; reason?: string };
  /** Registrations that replaced another one or were refused, and why. */
  conflicts: ToolDesignConflict[];
  /** Designs that failed while a card was drawn (one entry per tool, id and message). */
  failures: ToolDesignFailure[];
}

/** One message line's value, with the custom types it paints. */
export interface StatusMessageDesignValue {
  /** The stored identity: `native` for `default`, otherwise the design's id. */
  id: string;
  label: string;
  /** The custom types of the line this value paints. `default` covers every type of the line. */
  covers: string[];
  /**
   * The tool-design switch this value follows instead of having one of its own (S1, 0.12.0), with what
   * that switch answers right now — so "my design is selected but the message is unchanged" has an
   * answer in the report instead of in a debugger.
   */
  follow?: { line: string; id: string; answered: string; active: boolean };
}

/** One message line, as `/bridge-status` lists it: the row name, its types, the value in force. */
export interface StatusMessageDesignLine {
  /** `type` for a design's own implicit line, `line` for a registered line of several types. */
  scope: "type" | "line";
  /** The selection key: the custom type, or the registered line id. */
  line: string;
  /** The name the menu shows: `Message exploration budget`. */
  rowName: string;
  /** Every custom type of the line, in first-seen order. */
  types: string[];
  /** The stored value: a design id, `native`, or `<id> (missing: not registered)`. */
  selection: string;
  /** `default` first, then the line's designs in registration order. */
  values: StatusMessageDesignValue[];
}

/** The message-design surface, reported only when the process registered a design (S4). */
export interface StatusMessageDesigns {
  lines: StatusMessageDesignLine[];
  /**
   * Per custom type, how many messages the post-construction adoption pass replaced. Empty when the
   * pass has not reached a message yet — the answer to "why is the message already on screen
   * unchanged".
   */
  adoptedMessages: Array<{ customType: string; messages: number }>;
  /** Registrations that replaced another one or were refused, and why. */
  conflicts: MessageDesignConflict[];
  /** Designs that threw while painting (one entry per type, id and message). */
  failures: MessageDesignFailure[];
}

/** One registered card style, as `/bridge-status` lists it: in the order its values appear. */
export interface StatusCardStyleEntry {
  id: string;
  label: string;
  /** The value's position source: an explicit integer, or registration order when absent. */
  order: number | "registration";
}

/** The persisted selection, resolved against the live registry. `missing` is a disposed style. */
export type StatusCardStyleSelection =
  | { kind: "native" }
  | { kind: "style"; id: string; label: string }
  | { kind: "missing"; id: string };

/** One surface the card style paints, with what it last did there (R4). */
export interface StatusSurfaceEntry {
  surface: PaintSurface;
  /** Whether the transform was attached to this surface. */
  reached: boolean;
  /** Only when it was not: the attach outcome (`no-layout-root`, `no-sidebar`, `no-rail`, ...). */
  reason?: string;
  /** The last frame this surface painted through the transform; `none` before it ran once. */
  frame: CardStyleFrameOutcome | { kind: "none" };
}

/** The card-style surface, reported only when there is something to say (see `collectStatus`). */
export interface StatusCardStyles {
  /** `extended`: the host's own `Card style` line was found and grown. `separate`: the fallback. */
  mode: CardStyleRowMode;
  styles: StatusCardStyleEntry[];
  selection: StatusCardStyleSelection;
  /** The most recent CONVERSATION frame's outcome; `none` before the transform ever ran. */
  frame: CardStyleFrameOutcome | { kind: "none" };
  /**
   * Per-surface reach and last frame (R4): the conversation and the rail are separate surfaces that
   * share one transform, so "the style is selected but the sidebar looks untouched" is answerable.
   */
  surfaces: StatusSurfaceEntry[];
  wiring: CardStyleWiringDiagnostics;
  failures: CardStyleTransformFailure[];
}

/** One registered transform, as `/bridge-status` lists it: in pipeline order. */
export interface StatusTransformEntry {
  id: string;
  /** The position's source: an explicit integer, or registration order when absent. */
  order: number | "registration";
  /** What the LAST frame did with it; `not run` when no frame has reached it yet. */
  outcome: "applied" | "skipped" | "failed" | "not run";
  /** Only when `outcome` is `failed`: the transform's own message, verbatim. */
  message?: string;
  /**
   * The last frame's counts (F1, F2): the lines it received and what its own grammar reported —
   * candidates examined, cards recognised, cards rewritten, shapes matched by name. Absent only for
   * `not run`, where no frame has asked the transform anything.
   */
  counts?: TransformFrameCounts;
}

export interface StatusSnapshot {
  providers: StatusProviderEntry[];
  backend: StatusBackend;
  lastCapture?: CaptureOutcome;
  failures: StatusFailure[];
  storeProblems: StoreProblem[];
  /** Absent until a menu build has happened: duplicates cannot be computed without rows. */
  duplicates?: StatusDuplicate[];
  /** Absent when no section is registered, so a row-only run keeps its historical output. */
  sections?: StatusSectionEntry[];
  /**
   * The rail parts the host paints, in paint order: the context a placement is resolved against (S5).
   * Absent when no section is registered, so a row-only session keeps its historical output exactly.
   */
  sectionParts?: string[];
  /**
   * How the section frame is drawn (N11) and what it could not reach (N15). Absent when no section
   * is registered, so a row-only session keeps its historical output exactly.
   */
  sectionFrame?: StatusSectionFrame;
  /** Absent when the most recent sidebar frame had no section failure. */
  sectionFailures?: SectionRenderFailure[];
  /**
   * Failures the RAIL BACKEND recorded in the most recent frame (a throwing host `render`, a
   * throwing contributor, a failed card-group call). Absent when there were none.
   */
  sidebarFailures?: SidebarFailure[];
  /** Absent when the sidebar backend was never installed (reported as "not armed"). */
  sidebar?: StatusSidebarEntry;
  /**
   * The last repaint a bridge-owned write requested (R3/R4): the surfaces, the cause and whether the
   * host was actually asked for a frame. Absent until such a write happens, so a session that never
   * toggled anything keeps its historical output byte for byte.
   */
  lastRepaint?: RepaintTrigger;
  /**
   * Every buffered bridge notice, delivered or still pending. Absent when there is none, so the
   * report for a clean session keeps its historical output exactly.
   */
  notices?: StatusNoticeEntry[];
  /** Messages the bounded buffer evicted before they could be shown. Absent when none were. */
  noticesDropped?: number;
  /**
   * The card-style surface. Absent when nothing card-related exists — no style registered, the
   * selection native, no transform attempt and no frame — so a row-only session keeps its output.
   */
  cardStyles?: StatusCardStyles;
  /**
   * The tool-design surface. Absent when no design is registered, so a session that never uses the
   * bus keeps its historical output byte for byte.
   */
  toolDesigns?: StatusToolDesigns;
  /**
   * The message-design surface. Absent when no design is registered, so a session that never claimed
   * a custom type keeps its historical output byte for byte (S4).
   */
  messageDesigns?: StatusMessageDesigns;
  /**
   * Plugin row names the bridge rejected for breaking the row-name shape (N8), or a row category it refused as reserved (S15): the offending
   * string, verbatim, and the rule it broke. Absent when nothing was rejected, so a clean session
   * keeps its historical output exactly.
   */
  rowNames?: StatusRowNameRejection[];
  /**
   * `placement` values the bridge refused: the section still registered and was placed at the end.
   * Absent when nothing was refused, so a clean session keeps its historical output exactly.
   */
  placementRejections?: StatusSectionPlacementRejection[];
  /**
   * Row `placement` values the bridge refused: the provider still registered and its rows were
   * placed at the end. Absent when nothing was refused, so a clean session keeps its historical
   * output exactly.
   */
  rowPlacementRejections?: StatusRowPlacementRejection[];
  /**
   * Every registered transcript transform in pipeline order, with the last frame's outcome. Absent
   * when none is registered, so a session that never used the pipeline keeps its historical output
   * byte for byte.
   */
  transforms?: StatusTransformEntry[];
  /**
   * The INTEGRATIONS rows this bridge paints on the plugins' behalf (I1–I7): one entry per plugin,
   * the name and whether it was derived or explicit, the registrations accepted and rejected, and
   * whether the host's `setStatus` was available at all. Absent when no plugin has registered, so a
   * session without one keeps its historical output byte for byte.
   */
  pluginLines?: PluginLineReport;
  /**
   * The REQUIRED host package (S9/T12): whether `pi.getCommands()` advertised `gentle:customize` on
   * the last `session_start`. Absent until a check has run, so a report that predates one keeps its
   * historical output byte for byte.
   */
  gentlePi?: StatusGentlePi;
}

/** One line of the report: gentle-pi is present, or it is missing and the bridge is disabled. */
export interface StatusGentlePi {
  present: boolean;
  /** Present only when missing: why the host does not count as gentle-pi. */
  reason?: string;
}

/**
 * One snapshot of everything `status` reports. The backend is derived from real state rather than
 * remembered: a hook registry in use wins, otherwise a wrapped UI target means the capture
 * backend.
 */
export function collectStatus(): StatusSnapshot {
  const providers = snapshotProviders();
  const hook = getHookDiagnostics();
  const capture = getCaptureDiagnostics();
  const backend: StatusBackend =
    hook.installed ? "hook" : capture.armedTargets > 0 ? "capture" : "none";
  // The SAME resolver the capture backend runs, against the categories the host last built, so the
  // report and the menu cannot disagree about where a block went (S5). The hook backend never sees
  // the host array, so its empty observed set is used instead of a stale capture observation: it
  // must say `start`/`after` could not be honoured there rather than pretend.
  const rowPlacements = new Map(
    resolveRowPlacements(providers, backend === "hook" ? [] : observedHostCategories()).map(
      (entry) => [entry.provider.id, entry],
    ),
  );
  // The capture backend records the ACTUAL landing of the last build (a frozen or read-only array
  // can leave a block at the end). The hook backend never sees the host array, so it keeps resolving
  // with its empty observed set and reports that limitation instead of borrowing a capture landing.
  const recordedLandings = new Map<string, RowPlacementLandingRecord[]>();
  if (backend !== "hook") {
    for (const landing of getRowPlacementLandings()) {
      const list = recordedLandings.get(landing.providerId);
      if (list === undefined) recordedLandings.set(landing.providerId, [landing]);
      else list.push(landing);
    }
  }

  // Diagnostics never run providers: duplicate detection comes from the rows the LAST menu build
  // actually received, and is unknown until such a build exists.
  const snapshot: StatusSnapshot = {
    // The bridge's own `Sections` and card-style fallback providers are plumbing, not plugin
    // providers: their effect is the tables below, and listing one would make a session report a
    // provider its user never registered (B3).
    providers: providers
      .filter(
        (provider) =>
          provider.id !== SECTION_ROWS_PROVIDER_ID &&
          provider.id !== CARD_STYLE_ROWS_PROVIDER_ID &&
          provider.id !== TOOL_DESIGN_ROWS_PROVIDER_ID &&
          // The message line is ours by IDENTITY, not by id: a plugin may legally register a provider
          // with this id through the public `registerRows`, and hiding that would be the report lying
          // about a provider the user really has.
          provider !== bridgeMessageDesignRowsProvider(),
      )
      .map((provider) => {
        const resolved = rowPlacements.get(provider.id);
        const candidates = recordedLandings.get(provider.id) ?? [];
        const landing =
          candidates.find((candidate) => candidate.category === provider.category) ??
          candidates[0];
        const placement: StatusRowPlacement | undefined =
          landing !== undefined
            ? {
                requested: landing.requested,
                landed: landing.landed,
                ...(landing.reason === undefined ? {} : { reason: landing.reason }),
              }
            : resolved === undefined
              ? undefined
              : {
                  requested: resolved.requested,
                  landed: rowPlacementLandingText(resolved),
                  ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
                };
        // A default `end` that was honoured is not news: omitting it keeps every historical
        // provider entry (and every pre-feature report) byte for byte.
        const report =
          placement !== undefined &&
          (provider.placement !== undefined || placement.reason !== undefined)
            ? { placement }
            : {};
        return { id: provider.id, category: provider.category, ...report };
      }),
    backend,
    // Report the failures and the capture outcome of the backend that is actually in use.
    failures:
      backend === "hook"
        ? hook.lastFailures.map(toStatusFailure)
        : capture.lastFailures.map(toStatusFailure),
    storeProblems: getStoreDiagnostics(),
  };
  const duplicates = findDuplicatesInBuilds(getLastRowBuild());
  if (duplicates !== undefined) snapshot.duplicates = duplicates;
  // The row-name rejections (N8). Nothing here runs a provider: the records are the ones the last
  // registration or build already made, so the report matches what the menu shows.
  const rowNames = getRowNameRejections();
  if (rowNames.length > 0) snapshot.rowNames = rowNames;
  const placementRejections = getSectionPlacementRejections();
  if (placementRejections.length > 0) snapshot.placementRejections = placementRejections;
  const rowPlacementRejections = getRowPlacementRejections();
  if (rowPlacementRejections.length > 0) {
    snapshot.rowPlacementRejections = rowPlacementRejections;
  }
  const lastCapture = backend === "hook" ? hook.lastCapture : capture.lastOutcome;
  if (lastCapture !== undefined) snapshot.lastCapture = lastCapture;

  // S9/T12 — the runtime answer about the REQUIRED host package. Nothing here checks anything: the
  // record is what the last `session_start` already observed. No check yet means no field and no
  // line, which is what keeps the pre-feature output byte for byte.
  const presence = getGentlePiPresence();
  if (presence !== undefined) {
    snapshot.gentlePi = presence.present
      ? { present: true }
      : { present: false, reason: presence.reason ?? "no reason recorded" };
  }

  // The sidebar surface. Nothing here runs a section: the table reports registrations and the
  // persisted visibility, and the failures are the ones the last frame already recorded — `lines()`
  // and `meta()` are never called by a diagnostics report.
  //
  // Ids belong in THIS report (N4): it is read by the plugin author diagnosing a registration, not by
  // the user picking a toggle. The rows the user sees show labels only (`./row-labels.ts`), so these
  // ids exist precisely to be found here. The label column is the same assignment the rows use,
  // including collision disambiguation, so the report explains what the menu shows instead of
  // recomputing it differently.
  const sections = snapshotSections();
  if (sections.length > 0) {
    const visibility = getSectionVisibility();
    const collapsedMap = getSectionCollapsed();
    // The SAME resolver the renderer runs, against the parts the host last painted, so the report and
    // the frame cannot disagree about where a card went (S5).
    const painted = observedPaintedParts();
    const placements = new Map(
      resolveSectionPlacements(sections, painted).map((entry) => [entry.section.id, entry]),
    );
    snapshot.sections = sectionRowLabels(sections).map(({ section, label, collision }) => {
      const resolved = placements.get(section.id);
      return {
        id: section.id,
        title: section.title,
        visible: isSectionVisible(visibility, section),
        ...(isSectionCollapsed(collapsedMap, section) ? { collapsed: true as const } : {}),
        order:
          typeof section.order === "number" && Number.isFinite(section.order)
            ? section.order
            : "registration",
        rowLabel: label,
        ...(collision === undefined ? {} : { rowLabelCollision: collision }),
        placement: {
          requested: resolved?.requested ?? "end",
          landed: resolved === undefined ? "after footer" : placementLandingText(resolved),
          ...(resolved?.reason === undefined ? {} : { reason: resolved.reason }),
        },
      };
    });
    snapshot.sectionParts = [...painted];
    snapshot.sectionFrame = describeSectionFrame();
  }
  const sectionFailures = getSectionFailures();
  if (sectionFailures.length > 0) snapshot.sectionFailures = sectionFailures;
  const sidebarDiagnostics = getSidebarDiagnostics();
  if (sidebarDiagnostics.lastFailures.length > 0) {
    // The rail backend's own failures are a separate class: a throwing host render, a throwing
    // contributor. Without them, a frame that lost every section would report nothing (B1).
    snapshot.sidebarFailures = sidebarDiagnostics.lastFailures;
  }
  // The notices the bridge had to report out of band (an incompatible API object). They are listed
  // here so removing them from the terminal never made them invisible: after the one-time notify,
  // this is where they stay.
  const notices = snapshotNotices();
  if (notices.entries.length > 0) {
    snapshot.notices = notices.entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      delivered: entry.emitted,
    }));
    if (notices.dropped > 0) snapshot.noticesDropped = notices.dropped;
  }
  const cardStyles = describeCardStyles();
  if (cardStyles !== undefined) snapshot.cardStyles = cardStyles;
  const toolDesigns = describeToolDesigns();
  if (toolDesigns !== undefined) snapshot.toolDesigns = toolDesigns;
  const messageDesigns = describeMessageDesigns();
  if (messageDesigns !== undefined) snapshot.messageDesigns = messageDesigns;
  const lastRepaint = describeLastRepaint();
  if (lastRepaint !== undefined) snapshot.lastRepaint = lastRepaint;
  // The transform pipeline, in the order the wrapper runs it. Nothing here calls a transform: the
  // outcomes are the ones the last frame already recorded.
  const transforms = describeTransforms();
  if (transforms !== undefined) snapshot.transforms = transforms;
  // The per-plugin INTEGRATIONS rows. Nothing here calls the host: the records are the ones each
  // registration (and `session_start`'s paint attempt) already made.
  const pluginLines = describePluginLines();
  if (pluginLines !== undefined) snapshot.pluginLines = pluginLines;
  const sidebarEntry = describeSidebar(sidebarDiagnostics);
  // The sidebar line is worth a line only when it explains something: a registered section that may
  // not be appearing, or a rail that IS intercepted. A row-only session with no rail keeps the
  // pre-feature output exactly (B3).
  if (
    sidebarEntry !== undefined &&
    (snapshot.sections !== undefined || sidebarEntry.state === "intercepted")
  ) {
    snapshot.sidebar = sidebarEntry;
  }

  return snapshot;
}

/**
 * How the section frame is drawn (N11) and what the bridge could not reach (N15).
 *
 * This is a REPORT of the run, not a claim in a comment: the panel source comes from looking for the
 * host's builders on every object the bridge is handed, the theme from whether Pi has run the
 * `setWidget` factory, and the hover mechanism from the last attempt to claim the shared pointer.
 */
function describeSectionFrame(): StatusSectionFrame {
  const panel = getPanelReport();
  const hover = getSectionHoverReport();
  const width = getSectionFrameWidth();
  return {
    source: panel.source,
    lookedAt: panel.lookedAt,
    missing: panel.missing,
    theme: panel.theme === "captured" ? "captured" : "missing",
    hover: hover.mechanism,
    ...(hover.reason === undefined ? {} : { hoverReason: hover.reason }),
    ...(width === undefined ? {} : { width }),
  };
}

/**
 * The card-style block, or `undefined` when the process has nothing card-related to say.
 *
 * The guard is what keeps a row-only session's report byte-identical: no style, a `native`
 * selection, no wiring attempt and no frame means the feature was never used here.
 */
function describeCardStyles(): StatusCardStyles | undefined {
  const styles = snapshotCardStyles();
  const selection = resolveCardStyleSelection();
  const wiring = getCardStyleWiringDiagnostics();
  const frame = getCardStyleLastOutcome();
  const failures = getCardStyleTransformFailures();
  if (styles.length === 0 && selection.kind === "native" && wiring.lastOutcome === undefined && frame === undefined) {
    return undefined;
  }
  return {
    mode: cardStyleRowMode(),
    styles: styles.map((style) => ({
      id: style.id,
      label: style.label,
      order:
        typeof style.order === "number" && Number.isFinite(style.order)
          ? style.order
          : "registration",
    })),
    selection:
      selection.kind === "native"
        ? { kind: "native" }
        : selection.kind === "missing"
          ? { kind: "missing", id: selection.id }
          : { kind: "style", id: selection.style.id, label: selection.style.label },
    frame: frame === undefined ? { kind: "none" } : frame,
    surfaces: PAINT_SURFACES.map((surface) => {
      const reach = getSurfaceReach(surface);
      const outcome = getCardStyleLastOutcome(surface);
      return {
        surface,
        reached: reach?.reached === true,
        ...(reach?.reason === undefined ? {} : { reason: reach.reason }),
        frame: outcome === undefined ? { kind: "none" as const } : outcome,
      };
    }),
    wiring,
    failures,
  };
}

/**
 * The tool-design block, or `undefined` when this process registered no design.
 *
 * The guard is the same discipline as every other block: a session that never registered a design
 * keeps its historical report exactly, including a host with no `registerToolRenderer` hook (a bare
 * harness has nothing to say about designs). Once a design exists, the ONE resolver's outcome is the
 * answer to "why is my design not drawing?", so it is reported right beside the registrations.
 *
 * Nothing here calls an `apply` or a `rows()`: the entries are the live registrations, the
 * persisted selection and the records the last frames already made.
 */
function describeToolDesigns(): StatusToolDesigns | undefined {
  const tools = toolNamesWithDesigns();
  const wiring = getToolDesignWiringDiagnostics();
  const adoption = getToolDesignAdoptionDiagnostics();
  const conflicts = getToolDesignConflicts();
  const failures = getToolDesignFailures();
  if (tools.length === 0) return undefined;
  const lineReports = describeToolDesignLines();
  return {
    tools: tools.map((tool) => {
      const selection = resolveToolDesignSelection(tool);
      const wrapped = wiring.wrappedCards.find((entry) => entry.tool === tool);
      const adopted = adoption.adoptedCards.find((entry) => entry.tool === tool);
      const owner = lineOfTool(tool);
      // S14/S19: a tool with SCOPED claims is painted by more than one line, so the answer is per
      // claim (one per line); `toolDesignClaims` carries the scope of THIS tool's claim.
      const claims = toolDesignClaims(tool);
      const scoped = claims.some((claim) => claim.scopeDescription !== undefined);
      return {
        tool,
        designs: snapshotToolDesigns(tool).map((design) => ({
          id: design.id,
          label: design.label,
          ...(design.description === undefined ? {} : { description: design.description }),
        })),
        selection:
          selection.kind === "native"
            ? TOOL_DESIGN_NATIVE
            : selection.kind === "missing"
              ? `${selection.id} (missing: not registered)`
              : selection.kind === "not-covered"
                ? `${selection.id} (not covered: the tool is not in this design's tools)`
                : selection.design.id,
        // The wrapper's identity is per CARD: a card built before the tool had a design (or before
        // the bridge was armed) has none, and no later selection can repaint it.
        ...(wrapped === undefined
          ? { wrapper: "not mounted" as const }
          : { wrapper: "mounted" as const, cards: wrapped.cards }),
        ...(adopted === undefined ? {} : { adopted: adopted.cards }),
        ...(scoped
          ? { claims: claims.map((claim) => statusClaimOf(claim)) }
          : owner !== undefined && owner.scope === "line"
            ? { line: owner.line }
            : {}),
      };
    }),
    ...(lineReports.length === 0 ? {} : { lines: lineReports }),
    ...(wiring.lastOutcome === undefined
      ? {}
      : {
          resolver: {
            registered: wiring.registered,
            lastOutcome: wiring.lastOutcome,
            ...(wiring.lastReason === undefined ? {} : { reason: wiring.lastReason }),
          },
        }),
    conflicts,
    failures,
  };
}

/** The `/bridge-status` shape of one line's claim on a tool (S14). */
function statusClaimOf(claim: ToolDesignClaim): StatusToolDesignClaim {
  return {
    kind: claim.scope,
    line: claim.line,
    stored: claim.stored,
    ...(claim.scopeDescription === undefined ? {} : { scope: claim.scopeDescription }),
  };
}

/** The tools one design paints, restricted to its line's tool set. */
function coverageOf(line: ToolDesignLine, design: ToolDesignLine["designs"][number]): string[] {
  if (design.line !== undefined) {
    if (!Array.isArray(design.tools)) return [...line.tools];
    return design.tools.filter((tool) => line.tools.includes(tool));
  }
  return design.tool === undefined ? [...line.tools] : [design.tool];
}

/**
 * The GROUPED lines only: an ungrouped design's line is its tool, already reported per tool, and
 * adding a line report for it would change the byte-for-byte output of a pre-lines session.
 */
function describeToolDesignLines(): StatusToolDesignLine[] {
  const names = toolDesignLineNames();
  return toolDesignLines()
    .filter((line) => line.scope === "line")
    .map((line) => {
      const named = names.find(
        (candidate) => candidate.scope === line.scope && candidate.line === line.line,
      );
      return {
        line: line.line,
        rowName: named?.name ?? line.line,
        tools: [...line.tools],
        values: [
          { id: TOOL_DESIGN_NATIVE, label: "default", covers: [...line.tools] },
          ...line.designs.map((design) => ({
            id: design.id,
            label: design.label,
            covers: coverageOf(line, design),
          })),
        ],
      };
    });
}

/**
 * The message-design block, or `undefined` when this process registered no design (S4).
 *
 * The guard is the same discipline as every other block: a session that never claimed a custom type
 * keeps its historical report exactly, so the surface costs one registry walk and not one line.
 * Once a design exists, the line's stored value answers "which design does this message draw right
 * now", and the adoption count answers the other question a stuck user has: "the message is already
 * on screen — has anything reached it?".
 *
 * Nothing here calls an `apply`: the lines, the values, the selection and the records are the live
 * registry, the persisted value and the failures the last passes already made.
 */
function describeMessageDesigns(): StatusMessageDesigns | undefined {
  const lines = messageDesignLines();
  if (lines.length === 0) return undefined;
  const names = messageDesignLineNames();
  return {
    lines: lines.map((line) => {
      const named = names.find(
        (candidate) => candidate.scope === line.scope && candidate.line === line.line,
      );
      return {
        scope: line.scope,
        line: line.line,
        // The name the menu shows, assigned by the same derivation the rows use (N2): the report
        // explains what the user reads instead of recomputing it differently.
        rowName: named?.name ?? line.line,
        types: [...line.types],
        selection: messageSelectionOf(line),
        values: [
          { id: MESSAGE_DESIGN_NATIVE, label: MESSAGE_DESIGN_DEFAULT_LABEL, covers: [...line.types] },
          ...line.designs.map((design) => ({
            id: design.id,
            label: design.label,
            covers: coveredTypesOf(line, design),
            ...(design.follows === undefined
              ? {}
              : {
                  follow: {
                    line: design.follows.line,
                    id: design.follows.id,
                    ...(() => {
                      const answer = resolveMessageDesignFollow(design.follows);
                      return { answered: answer.answered, active: answer.active };
                    })(),
                  },
                }),
          })),
        ],
      };
    }),
    adoptedMessages: getMessageDesignAdoptionDiagnostics().adoptedMessages,
    conflicts: getMessageDesignConflicts(),
    failures: getMessageDesignFailures(),
  };
}

/**
 * The stored value of one line, with the one degrade the report names: `<id> (missing: not
 * registered)`, so a design disposed while it was selected never reads as the user's `default`.
 */
function messageSelectionOf(line: MessageDesignLine): string {
  const stored = getMessageDesignLineSelection(line.scope, line.line);
  if (stored === MESSAGE_DESIGN_NATIVE) return MESSAGE_DESIGN_NATIVE;
  return line.designs.some((design) => design.id === stored)
    ? stored
    : `${stored} (missing: not registered)`;
}

/** The custom types one design of a line paints: its own `types`, or its `customType`. */
function coveredTypesOf(
  line: MessageDesignLine,
  design: MessageDesignRegistration,
): string[] {
  if (Array.isArray(design.types)) return [...design.types];
  if (typeof design.customType === "string") return [design.customType];
  return [...line.types];
}

/**
 * The transform block, or `undefined` when this process registered no transform at all.
 *
 * The guard is what keeps a session that never used the pipeline byte-identical: the block appears
 * only when a transform exists, and the outcomes are the ones the last frame recorded (a transform
 * registered after that frame reads `not run` rather than borrowing another one's answer).
 */
function describeTransforms(): StatusTransformEntry[] | undefined {
  const registered = snapshotTransforms();
  if (registered.length === 0) return undefined;
  const frame = new Map(getTransformFrameOutcomes().map((outcome) => [outcome.id, outcome]));
  return registered.map((transform) => {
    const outcome = frame.get(transform.id);
    return {
      id: transform.id,
      order:
        typeof transform.order === "number" && Number.isFinite(transform.order)
          ? transform.order
          : "registration",
      outcome: outcome?.status ?? "not run",
      ...(outcome?.message === undefined ? {} : { message: outcome.message }),
      ...(outcome?.counts === undefined ? {} : { counts: outcome.counts }),
    };
  });
}

/**
 * The INTEGRATIONS block, or `undefined` when no plugin has registered with the bridge.
 *
 * The guard is the same discipline as every other block: a session with no plugin keeps its
 * historical report exactly. The line's TEXT is deliberately not recomputed here — it is what the
 * host was handed — but `line`/`reason` say whether a row is currently set, so a missing row is an
 * answer (I6).
 */
function describePluginLines(): PluginLineReport | undefined {
  const report = getPluginLineReport();
  return report.plugins.length === 0 ? undefined : report;
}

/** The last repaint a bridge-owned write requested (R3/R4), or `undefined` before one happened.
 *
 * The guard is the same discipline as every other block: a session that never toggled anything keeps
 * its historical report exactly. A trigger whose outcome is `unavailable` is the interesting case —
 * the write landed and the screen did not move — so its reason is reported verbatim.
 */
function describeLastRepaint(): RepaintTrigger | undefined {
  return getRepaintDiagnostics().lastTrigger;
}

function formatCardSelection(selection: StatusCardStyleSelection): string {
  switch (selection.kind) {
    case "native":
      return "native";
    case "style":
      return `${selection.id} "${selection.label}"`;
    case "missing":
      return `${selection.id} (missing: not registered)`;
  }
}

function formatCardFrame(frame: StatusCardStyles["frame"]): string {
  switch (frame.kind) {
    case "none":
      return "none";
    case "transformed":
      return `transformed ${frame.cards} ${frame.cards === 1 ? "card" : "cards"}`;
    case "pass-through":
      return `pass-through (${
        frame.reason === "missing" ? "missing: a disposed style" : frame.reason === "no-card" ? "no card" : "native"
      })`;
    case "failed":
      return `failed (${frame.styleId}: ${frame.message})`;
  }
}

function formatCardWiring(wiring: CardStyleWiringDiagnostics): string {
  // Which COMPONENTS carry the transform. The rail is named only once it was wrapped — its failures
  // have their own per-surface line below (`formatCardSurface`), so nothing is hidden by keeping this
  // line about the conversation's state, which is what it has always answered.
  const parts: string[] = [];
  if ((wiring.railWrapped ?? 0) > 0) parts.push("rail wrapped");
  if (wiring.wrapped > 0) parts.push("chat wrapped");
  if (parts.length > 0) return parts.join(", ");
  if (wiring.lastOutcome === undefined) return "not armed";
  const reason = wiring.lastReason === undefined ? "" : `: ${wiring.lastReason}`;
  return `not wrapped (${wiring.lastOutcome}${reason})`;
}

/** One surface's line: whether the style reached it, and what its last frame did there (R4). */
function formatCardSurface(entry: StatusSurfaceEntry): string {
  const reached = entry.reached
    ? `reached (${entry.surface === "conversation" ? "chat wrapped" : "rail wrapped"})`
    : `not reached (${entry.reason ?? "not attempted"})`;
  return `card style surface ${entry.surface}: ${reached}, last frame ${formatCardFrame(entry.frame)}`;
}

/**
 * Map the backend's diagnostics onto the three states a user needs: intercepted, present-but-nothing
 * to intercept, or previously installed and now off. Never-installed is `undefined` ("not armed").
 */
function describeSidebar(diagnostics: SidebarDiagnostics): StatusSidebarEntry | undefined {
  if (diagnostics.interceptedMaps > 0) {
    return {
      state: "intercepted",
      rail: diagnostics.rail ?? (diagnostics.wrappedRails > 0 ? "wrapped" : "pending"),
    };
  }
  if (
    diagnostics.lastOutcome === "no-sidebar-state" ||
    diagnostics.lastOutcome === "resolver-threw"
  ) {
    return {
      state: "no-sidebar-state",
      ...(diagnostics.lastReason === undefined ? {} : { reason: diagnostics.lastReason }),
    };
  }
  if (diagnostics.lastOutcome === "no-widget-surface") {
    return {
      state: "unarmed",
      ...(diagnostics.lastReason === undefined ? {} : { reason: diagnostics.lastReason }),
    };
  }
  if (diagnostics.lastOutcome !== undefined) return { state: "unarmed" };
  return undefined;
}

/**
 * Report every `category` + `choice.setting` pair contributed by more than one provider id.
 *
 * A single provider's own consecutive toggle rows share a setting by design, so they are not a
 * duplicate: only a second provider id makes the pair conflict. Rows are read, never rewritten. A
 * provider that throws is skipped — its failure is already its own diagnostics entry.
 */
export function findDuplicateSettings(providers: RowProvider[], ctx: RowContext): StatusDuplicate[] {
  const builds: RowBuildRecord[] = [];
  for (const provider of providers) {
    try {
      builds.push({ providerId: provider.id, category: provider.category, rows: provider.rows(ctx) });
    } catch {
      continue;
    }
  }
  return findDuplicatesInBuilds(builds) ?? [];
}

/**
 * The same grouping over rows a build already produced, with no provider invocation. `undefined`
 * means no build has happened yet, which is reported as unknown rather than as "no duplicates".
 */
export function findDuplicatesInBuilds(
  builds: RowBuildRecord[] | undefined,
): StatusDuplicate[] | undefined {
  if (builds === undefined) return undefined;

  const groups = new Map<string, StatusDuplicate>();
  const order: string[] = [];

  for (const build of builds) {
    for (const row of build.rows) {
      const setting = row.choice?.setting;
      if (setting === undefined) continue;
      const category = row.category ?? build.category;
      const key = `${category}\u0000${setting}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { category, setting, providerIds: [build.providerId] });
        order.push(key);
        continue;
      }
      if (!existing.providerIds.includes(build.providerId)) {
        existing.providerIds.push(build.providerId);
      }
    }
  }

  const duplicates: StatusDuplicate[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (group !== undefined && group.providerIds.length >= 2) duplicates.push(group);
  }
  return duplicates;
}

/** What `/bridge-status` says when the required host package is not there (S9, T12). */
const BRIDGE_DISABLED_LINE =
  "bridge: disabled — gentle-pi is required; no rows, sections, card styles or tool designs are armed";

/** The report, as lines, exactly as the `status` command prints it. */
export function formatStatus(snapshot: StatusSnapshot): string[] {
  const lines: string[] = ["gentle-shell-bridge status"];

  // The gate answer comes first: a user whose bridge does nothing needs to know WHY before reading
  // anything else. Absent only when no check has run, so the historical report is unchanged.
  const presence = snapshot.gentlePi;
  if (presence !== undefined) {
    if (presence.present) {
      lines.push("gentle-pi: present");
    } else {
      lines.push(`gentle-pi: missing — ${presence.reason ?? "no reason recorded"}`);
      lines.push(BRIDGE_DISABLED_LINE);
      // Disabled (S9): every per-surface block below would claim work that is not being done — no
      // wrapper, no rows installed, no resolver, no footer line — so none is emitted. The buffered
      // notices still explain the process, and the presence lines carry the reason.
      lines.push(...formatNotices(snapshot));
      return lines;
    }
  }

  if (snapshot.providers.length === 0) {
    lines.push("providers: none");
  } else {
    lines.push(`providers: ${snapshot.providers.length}`);
    for (const provider of snapshot.providers) {
      // Where the block asked to sit and where it really lands (S5): a fallback is only actionable
      // next to the request that caused it, so both are on the provider's own line.
      const placement = provider.placement;
      const placementText =
        placement === undefined
          ? ""
          : `, placement ${placement.requested} → ${placement.landed}` +
            (placement.reason === undefined ? "" : ` (${placement.reason})`);
      lines.push(`  - ${provider.id} (${provider.category})${placementText}`);
    }
  }

  lines.push(`backend: ${snapshot.backend}`);
  lines.push(formatCapture(snapshot.lastCapture));

  if (snapshot.failures.length === 0) {
    lines.push("last failures: none");
  } else {
    lines.push(`last failures: ${snapshot.failures.length}`);
    for (const failure of snapshot.failures) {
      const outcome = failure.rowsDropped ? "rows dropped" : "rows kept";
      lines.push(`  - ${failure.providerId}: ${failure.message} (${outcome})`);
    }
  }

  if (snapshot.storeProblems.length === 0) {
    lines.push("store problems: none");
  } else {
    lines.push(`store problems: ${snapshot.storeProblems.length}`);
    for (const problem of snapshot.storeProblems) {
      lines.push(
        `  - ${problem.pluginId} (${problem.path}): ${problem.kind}: ${problem.message} ` +
          "(reads fall back to defaults; the file is left as is)",
      );
    }
  }

  if (snapshot.duplicates === undefined) {
    lines.push("duplicate settings: no build yet");
  } else if (snapshot.duplicates.length === 0) {
    lines.push("duplicate settings: none");
  } else {
    lines.push(`duplicate settings: ${snapshot.duplicates.length}`);
    for (const duplicate of snapshot.duplicates) {
      lines.push(
        `  - ${duplicate.category} / "${duplicate.setting}": ${duplicate.providerIds.join(", ")}`,
      );
    }
  }

  if (snapshot.placementRejections !== undefined) {
    lines.push(`placement rejections: ${snapshot.placementRejections.length}`);
    for (const rejection of snapshot.placementRejections) {
      // The value is printed exactly as far as JSON can show it: the report is how the author finds
      // the mistake, and the card was placed at the end instead of being dropped (S5).
      lines.push(
        `  - section ${JSON.stringify(rejection.sectionId)} placement ${rejection.value}: ` +
          `${rejection.reason} (the section was placed at the end)`,
      );
    }
  }

  if (snapshot.rowPlacementRejections !== undefined) {
    lines.push(`row placement rejections: ${snapshot.rowPlacementRejections.length}`);
    for (const rejection of snapshot.rowPlacementRejections) {
      // The same discipline as a section's: the value verbatim, the rule it broke, and what the
      // bridge did instead of dropping the provider's rows (S5).
      lines.push(
        `  - provider ${JSON.stringify(rejection.providerId)} placement ${rejection.value}: ` +
          `${rejection.reason} (the rows were placed at the end)`,
      );
    }
  }

  if (snapshot.rowNames !== undefined) {
    lines.push(`row rejections: ${snapshot.rowNames.length}`);
    for (const rejection of snapshot.rowNames) {
      // The offending string is printed EXACTLY as the author wrote it: the report is how they find
      // it, and the bridge never rewrites a name it refused (N8).
      lines.push(
        `  - ${rejection.surface} ${JSON.stringify(rejection.id)} ${rejection.field} ` +
          `${JSON.stringify(rejection.value)}: ${rejection.reason} (rejected, never rewritten)`,
      );
    }
  }

  // These blocks are emitted only when they have something to say. What is guaranteed: a session
  // that registers no section and never intercepts a rail prints exactly the pre-feature output
  // (proved through the real entry, not just this formatter). The sections table appears once a
  // section is registered; the sidebar line appears when a section is registered — so an
  // unreachable rail is an answer — or when a rail is actually intercepted.
  if (snapshot.sections !== undefined) {
    lines.push(`sections: ${snapshot.sections.length}`);
    for (const section of snapshot.sections) {
      const order =
        section.order === "registration" ? "registration order" : `order ${section.order}`;
      const visibility = section.visible ? "visible" : "hidden";
      // The id and the title are diagnostics; `row` is what the menu actually reads, and the
      // collision note says why two equal titles did not produce two equal lines (N2, N4).
      const row =
        section.rowLabelCollision === undefined
          ? `, row "${section.rowLabel}"`
          : `, row "${section.rowLabel}" (label collision with "${section.rowLabelCollision}")`;
      // Where the card asked to sit and where it really lands (S5): a fallback is only actionable
      // next to the request that caused it, so both are on the section's own line.
      const placement = section.placement;
      const placementText =
        `${placement.requested} → ${placement.landed}` +
        (placement.reason === undefined ? "" : ` (${placement.reason})`);
      lines.push(
        `  - ${section.id} "${section.title}": ${visibility}${section.collapsed === true ? ", collapsed" : ""}, ${order}${row}, placement ${placementText}`,
      );
    }
    if (snapshot.sectionParts !== undefined) {
      lines.push(`rail parts: ${snapshot.sectionParts.length === 0 ? "none" : snapshot.sectionParts.join(", ")}`);
    }
  }

  if (snapshot.sectionFrame !== undefined) {
    lines.push(...formatSectionFrame(snapshot.sectionFrame));
  }

  if (snapshot.sectionFailures !== undefined) {
    lines.push(`section failures: ${snapshot.sectionFailures.length}`);
    for (const failure of snapshot.sectionFailures) {
      lines.push(`  - ${failure.sectionId} (${failure.phase}): ${failure.message}`);
    }
  }

  if (snapshot.sidebarFailures !== undefined) {
    lines.push(`sidebar failures: ${snapshot.sidebarFailures.length}`);
    for (const failure of snapshot.sidebarFailures) {
      lines.push(`  - ${failure.key} (${failure.phase}): ${failure.message}`);
    }
  }

  if (snapshot.sidebar === undefined) {
    if (snapshot.sections !== undefined) lines.push("sidebar: not armed");
  } else if (snapshot.sidebar.state === "intercepted") {
    lines.push(`sidebar: intercepted (rail ${snapshot.sidebar.rail})`);
  } else if (snapshot.sidebar.state === "no-sidebar-state") {
    const reason = snapshot.sidebar.reason === undefined ? "" : ` (${snapshot.sidebar.reason})`;
    lines.push(`sidebar: no-sidebar-state${reason}`);
  } else {
    const reason = snapshot.sidebar.reason === undefined ? "" : ` (${snapshot.sidebar.reason})`;
    lines.push(`sidebar: not armed${reason}`);
  }

  if (snapshot.cardStyles !== undefined) {
    const card = snapshot.cardStyles;
    lines.push(`card styles: ${card.mode}, ${card.styles.length} registered`);
    for (const entry of card.styles) {
      const order = entry.order === "registration" ? "registration order" : `order ${entry.order}`;
      lines.push(`  - ${entry.id} "${entry.label}" (${order})`);
    }
    lines.push(`card style selection: ${formatCardSelection(card.selection)}`);
    lines.push(`card style frame: ${formatCardFrame(card.frame)}`);
    for (const surface of card.surfaces) lines.push(formatCardSurface(surface));
    lines.push(`card style wiring: ${formatCardWiring(card.wiring)}`);
    if (card.failures.length > 0) {
      lines.push(`card style failures: ${card.failures.length}`);
      for (const failure of card.failures) {
        lines.push(`  - ${failure.styleId}: ${failure.message}`);
      }
    }
    // S7: a later post-processor — a component that rewrites the conversation's rows after this
    // frame is drawn — can erase it. The bridge cannot prevent that, so it says so instead of
    // pretending otherwise.
    lines.push(
      "card style note: a downstream post-processor can strip or override this frame; " +
        "the bridge cannot prevent it.",
    );
  }

  if (snapshot.toolDesigns !== undefined) {
    const designs = snapshot.toolDesigns;
    lines.push(`tool designs: ${designs.tools.length} tools with designs`);
    for (const entry of designs.tools) {
      // The tool's own line answers both questions a stuck user has: which design resolves NOW, and
      // whether the cards already on screen can still be repainted at all (S2).
      const wrapper =
        entry.wrapper === "mounted"
          ? `wrapper mounted on ${entry.cards} ${entry.cards === 1 ? "card" : "cards"}`
          : "wrapper not mounted";
      // S10/T16: which path reached this tool's cards — the resolver (the bridge was ahead in the
      // chain) or adoption (a resolver ahead of it answered without calling next()). Both may be
      // non-zero: old cards adopted after construction, new cards resolved through the wrapper.
      const adopted =
        entry.adopted === undefined
          ? ""
          : `, adopted ${entry.adopted} ${entry.adopted === 1 ? "card" : "cards"}`;
      // D7: a grouped tool's entry names the line whose switch paints it. An ungrouped entry prints
      // exactly what it printed before lines existed.
      const line = entry.line === undefined ? "" : ` (line "${entry.line}")`;
      lines.push(`  - ${entry.tool}: ${entry.selection}, ${wrapper}${adopted}${line}`);
      // S14: a tool with SCOPED claims is painted by more than one line, so each claiming line is
      // listed with the value stored for it and, when it is scoped, the calls that line owns.
      for (const claim of entry.claims ?? []) {
        const scope = claim.scope === undefined ? "" : ` — scope: ${claim.scope}`;
        lines.push(`      ${claim.kind} "${claim.line}": ${claim.stored}${scope}`);
      }
      for (const design of entry.designs) {
        const description = design.description === undefined ? "" : ` — ${design.description}`;
        lines.push(`      ${design.id} "${design.label}"${description}`);
      }
    }
    if (designs.lines !== undefined) {
      lines.push(`tool design lines: ${designs.lines.length}`);
      for (const line of designs.lines) {
        lines.push(`  - ${line.line} "${line.rowName}": ${line.tools.join(", ")}`);
        for (const value of line.values) {
          lines.push(`      ${value.id} "${value.label}": covers ${value.covers.join(", ")}`);
        }
      }
    }
    if (designs.resolver !== undefined) {
      const outcome = designs.resolver.lastOutcome ?? "registered";
      const reason = designs.resolver.reason === undefined ? "" : `: ${designs.resolver.reason}`;
      lines.push(
        `tool design resolver: ${outcome} (${designs.resolver.registered} registered)${reason}`,
      );
    } else {
      lines.push("tool design resolver: not attempted");
    }
    if (designs.conflicts.length > 0) {
      lines.push(`tool design conflicts: ${designs.conflicts.length}`);
      for (const conflict of designs.conflicts) {
        lines.push(`  - ${conflict.tool} / ${conflict.id} (${conflict.kind}): ${conflict.message}`);
      }
    }
    if (designs.failures.length > 0) {
      lines.push(`tool design failures: ${designs.failures.length}`);
      for (const failure of designs.failures) {
        lines.push(`  - ${failure.tool} / ${failure.designId}: ${failure.message}`);
      }
    }
  }

  if (snapshot.messageDesigns !== undefined) {
    const designs = snapshot.messageDesigns;
    lines.push(
      `message designs: ${designs.lines.length} ${designs.lines.length === 1 ? "line" : "lines"}`,
    );
    for (const entry of designs.lines) {
      // The line's own entry answers both questions: which design resolves NOW for these messages,
      // and which values the menu offers for them.
      lines.push(`  - ${entry.line} "${entry.rowName}": ${entry.selection}`);
      for (const value of entry.values) {
        const follow =
          value.follow === undefined
            ? ""
            : ` — follows ${value.follow.line}/${value.follow.id}: answers ` +
              `${value.follow.answered} (${value.follow.active ? "on" : "off"})`;
        lines.push(
          `      ${value.id} "${value.label}": covers ${value.covers.join(", ")}${follow}`,
        );
      }
    }
    // S4's other half: a design for a message Pi already mounted only reaches it on the next
    // conversation render, so "nothing adopted yet" is an answer, not an empty block.
    if (designs.adoptedMessages.length === 0) {
      lines.push("message design adoption: none");
    } else {
      const total = designs.adoptedMessages.reduce((sum, entry) => sum + entry.messages, 0);
      const types = designs.adoptedMessages.length;
      lines.push(
        `message design adoption: ${types} ${types === 1 ? "type" : "types"}, ` +
          `${total} ${total === 1 ? "message" : "messages"}`,
      );
      for (const entry of designs.adoptedMessages) {
        lines.push(
          `  - ${entry.customType}: ${entry.messages} ${entry.messages === 1 ? "message" : "messages"}`,
        );
      }
    }
    if (designs.conflicts.length > 0) {
      lines.push(`message design conflicts: ${designs.conflicts.length}`);
      for (const conflict of designs.conflicts) {
        lines.push(
          `  - ${conflict.customType} / ${conflict.id} (${conflict.kind}): ${conflict.message}`,
        );
      }
    }
    if (designs.failures.length > 0) {
      lines.push(`message design failures: ${designs.failures.length}`);
      for (const failure of designs.failures) {
        lines.push(`  - ${failure.customType} / ${failure.designId}: ${failure.message}`);
      }
    }
  }

  if (snapshot.lastRepaint !== undefined) {
    const trigger = snapshot.lastRepaint;
    const outcome =
      trigger.outcome === "repainted" ? "repainted" : `unavailable: ${trigger.reason ?? "no reason recorded"}`;
    lines.push(`last repaint: ${trigger.surfaces.join(", ")} for ${trigger.cause} (${outcome})`);
  }

  if (snapshot.transforms !== undefined) {
    lines.push(`transforms: ${snapshot.transforms.length} registered`);
    for (const entry of snapshot.transforms) {
      const order = entry.order === "registration" ? "registration order" : `order ${entry.order}`;
      const outcome =
        entry.outcome === "failed"
          ? `failed (${entry.message ?? "no message"})`
          : entry.outcome;
      // F2: the counts the SAME frame recorded, on the same line as the outcome: "it ran" and "it
      // recognised nothing" are one answer, and the line has to read as one.
      const counts = entry.counts === undefined ? "" : `, ${formatTransformCounts(entry.counts)}`;
      lines.push(`  - ${entry.id} (${order}): ${outcome}${counts}`);
    }
  }

  if (snapshot.pluginLines !== undefined) {
    lines.push(...formatPluginLines(snapshot.pluginLines));
  }

  lines.push(...formatNotices(snapshot));

  return lines;
}

/**
 * The buffered bridge notices: every message the bridge had to report out of band, delivered or
 * still pending. Empty when there is none, so a clean session's report keeps its historical shape.
 */
function formatNotices(snapshot: StatusSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.notices !== undefined) {
    lines.push(`notices: ${snapshot.notices.length}`);
    for (const notice of snapshot.notices) {
      const state = notice.delivered ? "delivered" : "pending";
      lines.push(`  - ${notice.level} (${state}): ${notice.message}`);
    }
  }
  if (snapshot.noticesDropped !== undefined) {
    lines.push(`notices dropped: ${snapshot.noticesDropped}`);
  }
  return lines;
}

/**
 * The counts of one transform's last frame (F1), as the report reads them: lines received,
 * candidates examined, cards recognised, cards rewritten — then the matched shapes by name, in the
 * order the transform reported them. Numbers and names only: no line of the frame is ever here.
 */
function formatTransformCounts(counts: TransformFrameCounts): string {
  const parts = [
    `${counts.lines} ${counts.lines === 1 ? "line" : "lines"}`,
    `${counts.candidates} ${counts.candidates === 1 ? "candidate" : "candidates"}`,
    `${counts.recognised} recognised`,
    `${counts.rewritten} rewritten`,
  ];
  if (counts.shapes.length > 0) {
    parts.push(`shapes: ${counts.shapes.map((shape) => `${shape.name} ${shape.count}`).join(", ")}`);
  }
  return parts.join(", ");
}

/**
 * The section-frame block: which drawing the header and rows use, how the pointer reaches them, and
 * the gap the bridge cannot close (N11, N15).
 *
 * Every fact here is a measurement of this run: the source comes from looking for the host's two
 * builder functions on the objects the bridge is actually handed, the theme from whether Pi has run
 * the widget factory, and the hover mechanism from the last claim of the shared pointer.
 */
function formatSectionFrame(frame: StatusSectionFrame): string[] {
  const looked = frame.lookedAt.length === 0 ? "nothing yet" : frame.lookedAt.join(", ");
  const why =
    frame.source === "host"
      ? `the host's own renderPanelHeader/renderPanelRow, found on: ${looked}`
      : `looked for renderPanelHeader/renderPanelRow on: ${looked}; found none`;
  const theme =
    frame.theme === "captured"
      ? "theme captured, rows painted in the host's roles"
      : "no theme captured yet, rows drawn uncoloured";
  const hover =
    frame.hover === "not used"
      ? "hover not used yet"
      : frame.hover === "host-state"
        ? "hover owner claimed on the host's sidebar state"
        : `hover owner unavailable (${frame.hoverReason ?? "no reason recorded"})`;
  const lines = [
    `section frame: ${frame.source} (${why}; ${theme})`,
    `section interaction: rail handleMouse (the host's own dispatch), ${hover}`,
  ];
  if (frame.width !== undefined) {
    // N20: a width bug is visible from the report — the given width next to what the bridge emitted.
    lines.push(`section width: ${frame.width.given} columns given, widest row ${frame.width.widest}`);
  }
  if (frame.source === "fallback") {
    // N15: the gap, named. Not "unsupported": gentle-shell's panel module publishes no seam on any
    // object this package is given, so the header and rows are drawn by the byte-identical port.
    lines.push(
      "section frame gap: gentle-shell's lib/shell-panel.ts cannot be imported (Pi loads each " +
        "extension in its own module graph) and publishes no builder on the rail part, the Pi theme " +
        "or the terminal's sidebar state, so the header and rows are drawn by a byte-identical port",
    );
  }
  return lines;
}

/** The INTEGRATIONS header's availability note: empty when the host surface is installed. */
function formatPluginAvailability(report: PluginLineReport): string {
  if (report.availability === "installed") return "";
  const state = report.availability === "unavailable" ? "unavailable" : "not armed";
  const reason = report.reason === undefined ? "" : `: ${report.reason}`;
  return ` (status ${state}${reason})`;
}

/** The per-plugin INTEGRATIONS list: the name, how it was chosen, and the registration counts. */
function formatPluginLines(report: PluginLineReport): string[] {
  const lines = [`plugin lines: ${report.plugins.length}${formatPluginAvailability(report)}`];
  for (const plugin of report.plugins) {
    const source =
      plugin.nameSource === "explicit"
        ? "explicit name"
        : `derived from package ${JSON.stringify(plugin.packageName ?? "")}`;
    // `(no line)` is a state, not a name: a module path is diagnostics and stays on this line only,
    // never in the footer (I2).
    const label = plugin.name === undefined ? "(no line)" : `${JSON.stringify(plugin.name)} (${source})`;
    const where = plugin.name === undefined ? ` module ${plugin.modulePath}` : "";
    const state =
      plugin.line === "set"
        ? plugin.status
        : `no line set (${plugin.reason ?? "no reason recorded"})`;
    lines.push(
      `  - ${label}${where}: ${state}, ${plugin.accepted} accepted, ${plugin.rejected.length} rejected`,
    );
    for (const rejection of plugin.rejected) {
      lines.push(`    - ${rejection.surface} ${JSON.stringify(rejection.id)}: ${rejection.reason}`);
    }
    for (const conflict of plugin.nameConflicts) {
      lines.push(
        `    - name conflict on ${conflict.surface} ${JSON.stringify(conflict.id)}: declared ` +
          `${JSON.stringify(conflict.name)}, kept ${JSON.stringify(conflict.kept)}`,
      );
    }
  }
  return lines;
}

function formatCapture(outcome: CaptureOutcome | undefined): string {
  if (outcome === undefined) return "last capture: none";
  const rows = outcome.injectedRows === 1 ? "1 row" : `${outcome.injectedRows} rows`;
  switch (outcome.kind) {
    case "injected":
      return `last capture: injected ${rows}`;
    case "already-injected":
      return "last capture: already injected";
    case "uncaptured":
      return outcome.reason === undefined
        ? "last capture: uncaptured"
        : `last capture: uncaptured (${outcome.reason})`;
  }
}

function toStatusFailure(failure: {
  providerId: string;
  message: string;
  rowsDropped: boolean;
}): StatusFailure {
  return {
    providerId: failure.providerId,
    message: failure.message,
    rowsDropped: failure.rowsDropped,
  };
}

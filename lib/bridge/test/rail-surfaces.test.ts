/**
 * The rail surface (R1–R5): the card style reaches the sidebar cards through the SAME repaint the
 * conversation uses, and a write to bridge-owned state repaints its surface before the action
 * returns.
 *
 * What is real here and what is modelled: the two card fixtures the rail renders are bytes produced
 * by gentle-shell's own `lib/shell-card.ts` (see `RAIL_HOST_CARD` in `./fake-sidebar.ts`), and the
 * `tui` the bridge walks is the host's own layout shape — root `vstack` → `hstack` →
 * `[conversation, rail ScrollView]`, the rail's framed rows being that view's child through the
 * layout protocol. The running TUI is not available to this package, so the *host component* is
 * modelled and the bridge's walk, wrapper and transform are the real code.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCardStyle, registerSection, registerTransform, resetBusForTests, resetCardStylesForTests, resetSectionsForTests, snapshotProviders } from "../src/bus.ts";
import { getCardStyleLastOutcome, resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  installCardStyleTransform,
  installRailCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import {
  getRepaintDiagnostics,
  requestSurfaceRepaint,
  resetRepaintForTests,
  setRepaintHost,
} from "../src/repaint.ts";
import { SECTION_ROWS_PROVIDER_ID, installSectionRows } from "../src/sections-rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, InlineHelpers, RowContext, SidebarSection } from "../src/types.ts";
import {
  RAIL_BRIDGE_CARD,
  RAIL_HOST_CARD,
  type Rail,
  createRailTui,
  resetSidebar,
} from "./fake-sidebar.ts";
import { createFakeTranscriptTui, stripAnsi } from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-rail-surfaces-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetRepaintForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  disableCardStyleTransform();
  disableSidebarBackend();
});

test.afterEach(() => {
  disableCardStyleTransform();
  disableSidebarBackend();
});

/** A style whose every row proves which function drew it: no float chrome survives. */
const PLAIN_STYLE = {
  id: "loon.plain",
  label: "plain",
  frame: {
    top: (ctx: { title?: string }) => `<${ctx.title ?? ""}>`,
    line: (ctx: { text: string }) => `| ${ctx.text}`,
    bottom: () => "_",
  },
};

/** The rail as the host frames it: the host's own section card, a gap, then the bridge's. */
const RAIL_FRAMES: readonly string[] = [...RAIL_HOST_CARD, "", ...RAIL_BRIDGE_CARD];

/** A rail component that hands back ONE array instance every frame, like the host's closure. */
const stableRail = (lines: readonly string[]): Rail => ({
  render: () => lines as string[],
});

const railTui = (lines: readonly string[] = RAIL_FRAMES) =>
  createRailTui({ rail: stableRail(lines), contentWidth: 40 });

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const ctx = (): RowContext => ({ theme: undefined, configHome });

/** What the host hands a row's action; the bridge's toggles use none of it. */
const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

const rowsNow = (): CustomizeRow[] => {
  const provider = snapshotProviders().find((entry) => entry.id === SECTION_ROWS_PROVIDER_ID);
  assert.ok(provider !== undefined, "the bridge registers its own Sections provider");
  return provider.rows(ctx());
};

const cardBlock = (lines: readonly string[]): string[] => {
  const start = lines.findIndex((line) => line.startsWith("card styles: "));
  if (start === -1) return [];
  const rest = lines.slice(start);
  const end = rest.findIndex((line) => line.startsWith("card style note: "));
  return end === -1 ? rest : rest.slice(0, end + 1);
};

// --------------------------------------------------------------------------------------------
// R1 — one card style, every card surface, one shared function
// --------------------------------------------------------------------------------------------

test("R1: the rail's host section and contributed section are both repainted with the style", () => {
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  const tui = railTui();
  const installed = installRailCardStyleTransform(tui);
  assert.deepEqual(installed, { installed: true, outcome: "wrapped", component: "rail" });

  const painted = tui.renderRail().map((line) => stripAnsi(line));

  assert.ok(painted.includes("<STATS>"), "the HOST section's card is drawn with the style's top");
  assert.ok(painted.includes("<Music>"), "so is the CONTRIBUTED section's card");
  assert.deepEqual(
    painted.slice(1, 3),
    ["| native row 1", "| native row 2"],
    "the host section's body rows are redrawn by the style",
  );
  assert.deepEqual(
    painted.slice(6, 8),
    ["| track one", "| track two"],
    "and the contributed section's body rows too",
  );
  assert.equal(
    painted.some((line) => line.includes("▎")),
    false,
    "no host float chrome is carried into a repainted card",
  );
  assert.deepEqual(getCardStyleLastOutcome("rail"), {
    kind: "transformed",
    styleId: PLAIN_STYLE.id,
    cards: 2,
  });
});

test("R1: the rail repaint is the conversation's own function, not a second copy", () => {
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  const conversation = createFakeTranscriptTui({ lines: [...RAIL_FRAMES] });
  installCardStyleTransform(conversation);
  const tui = railTui();
  installRailCardStyleTransform(tui);

  assert.deepEqual(
    tui.renderRail(),
    conversation.chat.render(40),
    "identical input, identical rows: one transform serves both surfaces",
  );
});

test("R1: native restores the host's own frames on the rail, by identity", () => {
  registerCardStyle(PLAIN_STYLE);
  const tui = railTui();
  installRailCardStyleTransform(tui);

  setCardStyleSelection(PLAIN_STYLE.id);
  assert.notEqual(tui.renderRail(), RAIL_FRAMES, "a selected style rewrites the frame");

  setCardStyleSelection("native");
  assert.equal(
    tui.renderRail(),
    RAIL_FRAMES,
    "native returns the rail's own array instance, untouched",
  );
});

test("R1: a second rail attach wraps once, so a frame is never restyled twice", () => {
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  const tui = railTui();
  installRailCardStyleTransform(tui);
  const once = tui.renderRail();

  assert.deepEqual(installRailCardStyleTransform(tui), {
    installed: true,
    outcome: "already-wrapped",
    component: "rail",
  });
  assert.deepEqual(tui.renderRail(), once, "the marker certifies the exact wrapper already installed");
});

test("R1: a rail mounted after the factory is reached on the next bridge-owned write", () => {
  // Pi hands the widget factory a tui before gentle-shell has mounted its fullscreen layout, so the
  // first attach can legitimately fail. It must not need a timer: the next write re-attempts once.
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  const tui = railTui();
  const late = createRailTui({ rail: stableRail(RAIL_FRAMES), contentWidth: 40 });
  const bare = { terminal: tui.terminal, requestRender: () => {} };
  setRepaintHost(bare);
  assert.deepEqual(installRailCardStyleTransform(bare), {
    installed: false,
    outcome: "no-layout-root",
  });

  // The host mounts its layout; the write that needs the rail repaint is the moment it is reached.
  setRepaintHost(late);
  setCardStyleSelection("native");
  requestSurfaceRepaint({ cause: "card style → native", surfaces: ["conversation", "rail"] });
  assert.deepEqual(getRepaintDiagnostics().reach.rail, { reached: false, reason: "no-layout-root" });

  const attached = createRailTui({ rail: stableRail(RAIL_FRAMES), contentWidth: 40 });
  setRepaintHost(attached);
  installRailCardStyleTransform(attached);
  assert.deepEqual(getRepaintDiagnostics().reach.rail, { reached: true });
  setCardStyleSelection(PLAIN_STYLE.id);
  assert.ok(attached.renderRail().some((line) => stripAnsi(line) === "<STATS>"));
});

test("R1: a registered transcript transform stays on the conversation, never the rail", () => {
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  registerTransform({ id: "loon.gutter", transform: (lines) => lines.map((line) => `> ${line}`) });
  const conversation = createFakeTranscriptTui({ lines: [...RAIL_FRAMES] });
  installCardStyleTransform(conversation);
  const tui = railTui();
  installRailCardStyleTransform(tui);

  assert.ok(
    conversation.chat.render(40).every((line) => line.startsWith("> ")),
    "the pipeline runs on the conversation",
  );
  assert.equal(
    tui.renderRail().some((line) => line.startsWith("> ")),
    false,
    "the rail sees the card style only: a plugin's conversation rows never reach another surface",
  );
});

// --------------------------------------------------------------------------------------------
// R2 — the repaint cannot corrupt the rail
// --------------------------------------------------------------------------------------------

test("R2: a frame that is not a card passes through as the same instance", () => {
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  const prose = ["MUSIC", "  track one", "", "  track two"];
  const tui = railTui(prose);
  installRailCardStyleTransform(tui);

  assert.equal(tui.renderRail(), prose, "byte-identical, same array instance");
  assert.deepEqual(getCardStyleLastOutcome("rail"), { kind: "pass-through", reason: "no-card" });
});

test("R2: every repainted row is clipped to the width the host rendered at", () => {
  registerCardStyle({
    id: "loon.wide",
    label: "wide",
    frame: {
      top: () => "T".repeat(200),
      line: () => "L".repeat(200),
      bottom: () => "B".repeat(200),
    },
  });
  setCardStyleSelection("loon.wide");
  const tui = railTui();
  installRailCardStyleTransform(tui);

  for (const row of tui.renderRail().map((line) => stripAnsi(line))) {
    assert.ok(row.length <= 40, `${JSON.stringify(row)} fits the rail's content width`);
  }
});

// --------------------------------------------------------------------------------------------
// R3 — a write repaints its surface, synchronously, once, and only when something changed
// --------------------------------------------------------------------------------------------

test("R3: a visibility toggle repaints the rail before the action returns, exactly once", () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  installSectionRows();
  const tui = railTui();
  setRepaintHost(tui);
  assert.equal(tui.cacheRevision(), 0);

  const hidden = rowsNow().find(
    (row) => row.choice?.setting === "music" && row.choice.value === "hidden",
  );
  assert.ok(hidden?.action !== undefined, "the bridge derives the action");
  hidden.action(inlineHelpers);

  assert.equal(tui.requestRenderCount(), 1, "one frame was requested, inside the action");
  assert.equal(
    tui.cacheRevision(),
    1,
    "the host's terminal-side cache was invalidated, as invalidateSidebar(tui) does",
  );
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, {
    cause: 'section "loon.music" → hidden',
    surfaces: ["rail"],
    outcome: "repainted",
  });
});

test("R3: a write that changes nothing doesn't ask for a frame", () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  installSectionRows();
  const tui = railTui();
  setRepaintHost(tui);

  const rows = rowsNow();
  const shown = rows.find((row) => row.choice?.setting === "music" && row.choice.value === "shown");
  assert.ok(shown?.action !== undefined);
  shown.action(inlineHelpers);

  assert.equal(tui.requestRenderCount(), 0, "shown was already shown: no frame, no invalidation");
  assert.equal(tui.cacheRevision(), 0);
  assert.equal(getRepaintDiagnostics().lastTrigger, undefined);
});

test("R3: a card-style write repaints both surfaces, synchronously", () => {
  registerCardStyle(PLAIN_STYLE);
  const tui = railTui();
  setRepaintHost(tui);
  setCardStyleSelection("native");

  requestSurfaceRepaint({ cause: `card style → ${PLAIN_STYLE.id}`, surfaces: ["conversation", "rail"] });

  assert.equal(tui.requestRenderCount(), 1);
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, {
    cause: `card style → ${PLAIN_STYLE.id}`,
    surfaces: ["conversation", "rail"],
    outcome: "repainted",
  });
});

test("R3: nothing polls — the frame is requested in the action, and no timer is scheduled", () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  registerCardStyle(PLAIN_STYLE);
  installSectionRows();
  const tui = railTui();
  setRepaintHost(tui);
  installRailCardStyleTransform(tui);

  const scheduled = { timeouts: 0, intervals: 0 };
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled.timeouts += 1;
    return realSetTimeout(...args);
  }) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    scheduled.intervals += 1;
    return realSetInterval(...args);
  }) as typeof setInterval;
  try {
    const hidden = rowsNow().find(
      (row) => row.choice?.setting === "music" && row.choice.value === "hidden",
    );
    assert.ok(hidden?.action !== undefined);
    hidden.action(inlineHelpers);
    tui.renderRail();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }

  assert.deepEqual(scheduled, { timeouts: 0, intervals: 0 }, "no timer carries the repaint");
  assert.equal(tui.requestRenderCount(), 1);
});

// --------------------------------------------------------------------------------------------
// R4 — the report names the surfaces, the frames and the last trigger
// --------------------------------------------------------------------------------------------

test("R4: /bridge-status reports each surface's reach and frame, and the last trigger", () => {
  registerCardStyle(PLAIN_STYLE);
  setCardStyleSelection(PLAIN_STYLE.id);
  const conversation = createFakeTranscriptTui({ lines: [...RAIL_FRAMES] });
  installCardStyleTransform(conversation);
  conversation.chat.render(40);

  const tui = railTui();
  setRepaintHost(tui);
  installRailCardStyleTransform(tui);
  tui.renderRail();
  requestSurfaceRepaint({ cause: 'section "loon.music" → hidden', surfaces: ["rail"] });

  const lines = formatStatus(collectStatus());

  assert.deepEqual(cardBlock(lines).slice(-4), [
    'card style surface conversation: reached (chat wrapped), last frame transformed 2 cards',
    "card style surface rail: reached (rail wrapped), last frame transformed 2 cards",
    "card style wiring: rail wrapped, chat wrapped",
    "card style note: a downstream post-processor can strip or override this frame; " +
      "the bridge cannot prevent it.",
  ]);
  assert.ok(
    lines.includes('last repaint: rail for section "loon.music" → hidden (repainted)'),
    "the last trigger is reported with its cause",
  );
});

test("R4: an unreachable rail is reported, never silently skipped", () => {
  registerCardStyle(PLAIN_STYLE);
  installRailCardStyleTransform({ terminal: {}, children: [] });
  const tui = railTui();

  assert.deepEqual(getRepaintDiagnostics().reach.rail, {
    reached: false,
    reason: "no-layout-root",
  });

  // No host has handed a tui to the bridge yet: the write is reported as unavailable.
  resetRepaintForTests();
  const trigger = requestSurfaceRepaint({ cause: 'section "loon.music" → hidden', surfaces: ["rail"] });
  assert.deepEqual(trigger, {
    cause: 'section "loon.music" → hidden',
    surfaces: ["rail"],
    outcome: "unavailable",
    reason: "no tui has been captured, so no surface can be repainted",
  });
  assert.ok(
    formatStatus(collectStatus()).includes(
      'last repaint: rail for section "loon.music" → hidden (unavailable: no tui has been captured, so no surface can be repainted)',
    ),
  );
  assert.equal(tui.requestRenderCount(), 0, "an unreached rail is never asked for a frame");
});

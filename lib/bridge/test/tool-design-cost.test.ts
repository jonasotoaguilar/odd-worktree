/**
 * S13/T23 — the WORK a design switch does, counted instead of timed.
 *
 * Wall-clock numbers measured on real pi-tui and pi's `ToolExecutionComponent` (T22) say the freeze
 * came from two calls the host's own card-style switch never makes:
 *
 * - `tui.invalidate()` clears every mounted component's frame cache, so the next frame re-parses
 *   every Markdown message of the transcript (0.06 ms at 50 children, 1.1 ms at 600 for the walk
 *   alone, and +709 ms for the frame that re-parses 300 messages with 45-line code blocks);
 * - `requestRender(force = true)` calls `resetRenderState()`, throwing away the differential state so
 *   the whole buffer is cleared and rewritten (6.9 MB at 600 children) instead of only the rows that
 *   changed.
 *
 * Neither is needed to change a card that is already drawn: the bridge's wrapper renders the HOST's
 * component and applies the live selection on top of whatever rows it answered with — including the
 * rows the host's own `ToolCardRows` cache hands back (`cards-bash-v2` `extensions/quiet-tools.ts`
 * 612-624 keys its frame on width + style + running, and the design is NOT in that key). This file
 * proves that against a host component that caches exactly like that one, and bounds the switch:
 *
 * - the tree is never invalidated, and no prose component re-parses;
 * - exactly one frame is requested, and it is differential;
 * - at most one persisted-selection read per card per frame;
 * - none of those counts grows with the number of Markdown components in the transcript.
 *
 * The bound is call counts, never milliseconds, so it cannot flake on a busy machine.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import {
  getRepaintDiagnostics,
  requestSurfaceRepaint,
  resetRepaintForTests,
  setRepaintHost,
} from "../src/repaint.ts";
import { buildRows, resetRowBuildStateForTests } from "../src/rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  TOOL_DESIGN_DEFAULT_LABEL,
  TOOL_DESIGN_NATIVE,
  getToolDesignSelectionReads,
  registerToolDesign,
  resetToolDesignSelectionReads,
  resetToolDesignsForTests,
  resolveToolDesignSelection,
  setToolDesignLineSelection,
  setToolDesignSelection,
} from "../src/tool-designs.ts";
import {
  installToolDesignRows,
  resetToolDesignRowStateForTests,
} from "../src/tool-design-rows.ts";
import { resetToolDesignWiringForTests, toolDesignResolver } from "../src/tool-design-wiring.ts";
import type { CustomizeRow, ToolDesignContext, ToolDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-tool-design-cost-"));
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
  resetToolDesignsForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignWiringForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
});

const WIDTH = 80;
const THEME = { name: "fake-theme" };
const BASH_HEADING = "bash heading";

/** The host's own rows for one bash card, as `quiet-tools.ts` draws them. */
const HOST_CARD = [
  "╭─ ✿ bash card ───────────── ctrl+o ╮",
  "│ \u001b[36m$ ls -la\u001b[0m                │",
  "╰───────────────────────────────────╯",
];

const DESIGNED_CARD = [
  HOST_CARD[0],
  HOST_CARD[1].replace("$ ", "bash "),
  HOST_CARD[2],
];

/** How many times the design applied since the last reset (one per card per frame while selected). */
let applied = 0;

const bashHeadingDesign: ToolDesignRegistration = {
  tool: "bash",
  id: "loon.bash-heading",
  label: BASH_HEADING,
  apply(lines: readonly string[], ctx: ToolDesignContext): string[] {
    applied += 1;
    assert.equal(ctx.tool, "bash");
    return lines.map((line) => line.replace("$ ", "bash "));
  },
};

// ---------------------------------------------------------------------------------------------
// The instrumented host: a frame counter on every component, exactly like pi's TUI
// ---------------------------------------------------------------------------------------------

interface Counters {
  /** `tui.invalidate()`: the call that cleared every cache in the tree. */
  treeInvalidations: number;
  /** What each `requestRender()` was called with: `plain` or `forced`. */
  frameRequests: Array<"plain" | "forced">;
  /** A prose row re-parsed its source because its cache was dropped. */
  proseCacheMisses: number;
  /** A prose row had its cache dropped. */
  proseInvalidations: number;
  /** The host card's renderer ran (it may answer from its own cache). */
  hostRenders: number;
  /** The host card answered from its own frame cache (the rows the design must post-process). */
  hostCacheHits: number;
  /** The host card rebuilt its rows (width/style/running changed). */
  hostRebuilds: number;
  /** Cards whose `invalidate()` the bridge called. */
  cardInvalidations: number;
  /** Design applications. */
  designApplies: number;
}

/** A `Markdown`-shaped row: it caches its lines and re-parses only after `invalidate()`. */
function mountProse(text: string, counters: Counters): { render(width: number): string[]; invalidate(): void } {
  let cached: string[] | undefined;
  return {
    render(width: number): string[] {
      if (cached !== undefined) return cached;
      counters.proseCacheMisses += 1;
      cached = [`${text} `.repeat(4).trim().padEnd(width, " ")];
      return cached;
    },
    invalidate(): void {
      counters.proseInvalidations += 1;
      cached = undefined;
    },
  };
}

/**
 * A host bash card whose renderer caches its frame the way `ToolCardRows` does
 * (`extensions/quiet-tools.ts:612-624`): keyed on width, the host's own style and whether it is
 * running. The DESIGN is not in that key — which is why the rows it answers with are cached under
 * the previous selection, and why the wrapper must post-process them instead of the tree being
 * invalidated.
 */
function hostCardDefinition(counters: Counters): Record<string, unknown> {
  const frame = { width: -1, style: "", lines: [...HOST_CARD] };
  const hostStyle = "float";
  return {
    renderShell: "default",
    renderCall: (..._args: unknown[]) => ({
      render(width: number): string[] {
        counters.hostRenders += 1;
        if (frame.width === width && frame.style === hostStyle) {
          counters.hostCacheHits += 1;
          return frame.lines;
        }
        counters.hostRebuilds += 1;
        frame.width = width;
        frame.style = hostStyle;
        frame.lines = [...HOST_CARD];
        return frame.lines;
      },
      invalidate(): void {
        frame.width = -1;
      },
    }),
  };
}

/** The part of pi's `ToolExecutionComponent` this test needs: it stores and re-invokes the renderer. */
interface FakeCard {
  toolName: string;
  toolDefinition: Record<string, unknown>;
  renders: number;
  component?: { render(width: number): string[] };
  updateDisplay(): void;
  invalidate(): void;
  render(width: number): string[];
}

function mountCard(counters: Counters): FakeCard {
  const card: FakeCard = {
    toolName: "bash",
    toolDefinition: toolDesignResolver("bash", () => hostCardDefinition(counters)) as Record<
      string,
      unknown
    >,
    renders: 0,
    updateDisplay(): void {
      const renderCall = card.toolDefinition.renderCall;
      card.component =
        typeof renderCall === "function"
          ? (renderCall as (...args: unknown[]) => { render(width: number): string[] })(
              { command: "ls -la" },
              THEME,
              { args: {} },
            )
          : undefined;
    },
    invalidate(): void {
      counters.cardInvalidations += 1;
      card.updateDisplay();
    },
    render(width: number): string[] {
      card.renders += 1;
      return card.component === undefined ? [] : card.component.render(width);
    },
  };
  card.updateDisplay();
  return card;
}

interface Transcript {
  counters: Counters;
  /** The conversation render pass: every mounted child, in order (pi's `Container.render`). */
  drawFrame(): string[][];
  cards: FakeCard[];
  proseInvalidations: () => number;
  proseCacheMisses: () => number;
}

function transcript(options: { children: number; markdown: number }): Transcript {
  const counters: Counters = {
    treeInvalidations: 0,
    frameRequests: [],
    proseCacheMisses: 0,
    proseInvalidations: 0,
    hostRenders: 0,
    hostCacheHits: 0,
    hostRebuilds: 0,
    cardInvalidations: 0,
    designApplies: 0,
    // The count of design applications is kept by the registered design itself; see `press`.
  } as Counters;

  const nodes: Array<{ render(width: number): string[]; invalidate?(): void }> = [];
  const cards: FakeCard[] = [];
  const bash = options.children - options.markdown;
  for (let index = 0; index < options.markdown; index += 1) {
    nodes.push(mountProse(`assistant message ${index}`, counters));
  }
  for (let index = 0; index < bash; index += 1) {
    const card = mountCard(counters);
    cards.push(card);
    nodes.push(card);
  }

  setRepaintHost({
    terminal: {},
    invalidate: (): void => {
      counters.treeInvalidations += 1;
      for (const node of nodes) node.invalidate?.();
    },
    requestRender: (force?: boolean): void => {
      counters.frameRequests.push(force === true ? "forced" : "plain");
    },
  });

  return {
    counters,
    drawFrame: () => nodes.map((node) => node.render(WIDTH)),
    cards,
    proseInvalidations: () => counters.proseInvalidations,
    proseCacheMisses: () => counters.proseCacheMisses,
  };
}

/** The menu's live rows, built through the host contract the menu reads. */
function rows(): CustomizeRow[] {
  installToolDesignRows();
  return buildRows({ theme: undefined, configHome }).rows;
}

/** Press one value of the bash line, exactly as the menu runs a row action. */
async function press(value: string): Promise<void> {
  const row = rows().find((candidate) => candidate.choice?.value === value);
  assert.ok(row?.action !== undefined, `the menu has a ${JSON.stringify(value)} value`);
  await row.action({
    input: async () => undefined,
    confirm: async () => true,
    capture: async () => undefined,
  });
}

/** Everything one switch costs, as counts. */
interface SwitchCost {
  treeInvalidations: number;
  frameRequests: Array<"plain" | "forced">;
  selectionReadsInFrame: number;
  designAppliesInFrame: number;
  proseCacheMissesInFrame: number;
  hostCacheHitsInFrame: number;
  cardInvalidations: number;
}

async function measureSwitch(options: { children: number; markdown: number }): Promise<{
  cost: SwitchCost;
  drawn: string[][];
  transcript: Transcript;
}> {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", TOOL_DESIGN_NATIVE);
  const world = transcript(options);
  // Warm every cache with one frame of the host's own rows.
  world.drawFrame();

  await press(BASH_HEADING);

  resetToolDesignSelectionReads();
  const appliesBefore = applied;
  const proseBefore = world.proseCacheMisses();
  const hitsBefore = world.counters.hostCacheHits;
  const drawn = world.drawFrame();

  return {
    cost: {
      treeInvalidations: world.counters.treeInvalidations,
      frameRequests: [...world.counters.frameRequests],
      selectionReadsInFrame: getToolDesignSelectionReads(),
      designAppliesInFrame: applied - appliesBefore,
      proseCacheMissesInFrame: world.proseCacheMisses() - proseBefore,
      hostCacheHitsInFrame: world.counters.hostCacheHits - hitsBefore,
      cardInvalidations: world.counters.cardInvalidations,
    },
    drawn,
    transcript: world,
  };
}

// ---------------------------------------------------------------------------------------------
// T23 — the bound
// ---------------------------------------------------------------------------------------------

test("T23/S13: a switch asks for ONE differential frame and invalidates nothing", async () => {
  registerToolDesign(bashHeadingDesign);
  const world = transcript({ children: 6, markdown: 3 });
  world.drawFrame();

  await press(BASH_HEADING);

  assert.equal(
    world.counters.treeInvalidations,
    0,
    "the tree is not invalidated: every Markdown row would re-parse and every card would rebuild",
  );
  assert.deepEqual(
    world.counters.frameRequests,
    ["plain"],
    "one frame, differential: no forced full redraw of the whole buffer",
  );
  assert.equal(world.counters.cardInvalidations, 0, "no card is invalidated by a selection change");

  const drawn = world.drawFrame();
  assert.deepEqual(drawn.filter((lines) => lines.length === HOST_CARD.length), [
    DESIGNED_CARD,
    DESIGNED_CARD,
    DESIGNED_CARD,
  ], "every already-constructed card draws the design");
  assert.equal(
    world.counters.hostCacheHits,
    3,
    "the host answered from its OWN frame cache; the wrapper post-processed those rows",
  );
  assert.equal(world.counters.hostRebuilds, 3, "the host rebuilt its rows once, at warm-up");
  assert.equal(getRepaintDiagnostics().lastTrigger?.outcome, "repainted");

  // S2's other half: `native` restores the host's exact bytes on the SAME components.
  await press(TOOL_DESIGN_DEFAULT_LABEL);
  assert.deepEqual(
    world.drawFrame().filter((lines) => lines.length === HOST_CARD.length),
    [HOST_CARD, HOST_CARD, HOST_CARD],
    "native restores the host's own rows, byte for byte",
  );
  assert.equal(world.counters.treeInvalidations, 0, "the way back costs no invalidation either");
  assert.deepEqual(world.counters.frameRequests, ["plain", "plain"], "one frame per press");
});

test("T23/S13: the work of a switch does not grow with the number of Markdown rows", async () => {
  const small = await measureSwitch({ children: 6, markdown: 3 });
  await press(TOOL_DESIGN_DEFAULT_LABEL);
  const large = await measureSwitch({ children: 203, markdown: 200 });

  assert.deepEqual(
    large.cost,
    {
      ...small.cost,
      // The host renders once per card per frame in both; that is the switch's real work, and it is
      // per CARD, never per Markdown row. Nothing else may differ.
    },
    "same cards, same frame, same reads: 200 prose rows cost a switch exactly what 3 do",
  );
  assert.equal(large.cost.treeInvalidations, 0);
  assert.deepEqual(large.cost.frameRequests, ["plain"]);
});

test("T23/S13: a switch performs at most one selection read per card per frame", async () => {
  registerToolDesign(bashHeadingDesign);
  const world = transcript({ children: 10, markdown: 6 });
  world.drawFrame();

  await press(BASH_HEADING);

  resetToolDesignSelectionReads();
  world.drawFrame();
  const firstFrame = getToolDesignSelectionReads();
  assert.equal(firstFrame, 4, "one read per card, no more");

  resetToolDesignSelectionReads();
  world.drawFrame();
  assert.equal(getToolDesignSelectionReads(), 4, "and the same on every later frame");

  // A frame with no design still reads the selection once per card: the bound is about the CARD,
  // not about which value is selected.
  await press(TOOL_DESIGN_DEFAULT_LABEL);
  resetToolDesignSelectionReads();
  world.drawFrame();
  assert.equal(getToolDesignSelectionReads(), 4);

  // Reads never grow with the transcript's prose, only with its cards.
  const wide = await measureSwitch({ children: 104, markdown: 100 });
  assert.equal(wide.cost.selectionReadsInFrame, 4, "100 prose rows still cost four selection reads");
  assert.ok(
    wide.cost.selectionReadsInFrame <= 4,
    "the bound: at most one read per card per frame",
  );
});

test("T23/S13: the prose rows never re-parse for a switch", async () => {
  const { cost } = await measureSwitch({ children: 30, markdown: 25 });
  assert.equal(cost.proseCacheMissesInFrame, 0, "no Markdown row re-parses on a design switch");
  assert.equal(cost.cardInvalidations, 0);
});

// S19 replaced the PRESERVE test that pinned the heavy path (`tui.invalidate()` + a forced frame) for
// bridge-owned rows. Measured with real pi components, the rows are byte-identical without them on the
// conversation, the rail's host panels and the bridge's sections, and the invalidation was the
// expensive half (697 ms vs 420 ms for `plain`, 99 ms vs 3 ms for a rail section toggle at 600
// children). test/surface-repaint-cost.test.ts holds the full bound; this pins the same request here.
test("T36/S19: the bridge-owned surface repaint is one differential frame too", () => {
  const world = transcript({ children: 2, markdown: 1 });
  world.counters.treeInvalidations = 0;
  world.counters.frameRequests.length = 0;

  requestSurfaceRepaint({ cause: "card style → neon", surfaces: ["conversation", "rail"] });

  assert.equal(world.counters.treeInvalidations, 0, "no tree invalidation: the Markdown caches survive");
  assert.deepEqual(world.counters.frameRequests, ["plain"], "one differential frame, not a forced one");
});

// Keep the compiler honest about the design type used above.
const _contextProbe: ToolDesignContext = { width: WIDTH, tool: "bash", theme: THEME, part: "call" };
void _contextProbe;

test("S9/D6: a grouped line costs the same ONE selection read per card per frame", () => {
  registerToolDesign({
    line: "tools",
    tools: ["bash", "write"],
    id: "loon.tools-activity",
    label: BASH_HEADING,
    apply: (lines: readonly string[]) => [...lines],
  });
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  const world = transcript({ children: 6, markdown: 3 });
  world.drawFrame();

  resetToolDesignSelectionReads();
  world.drawFrame();
  assert.equal(
    getToolDesignSelectionReads(),
    3,
    "one persisted-selection read per card, exactly like an ungrouped line",
  );
});

// ---------------------------------------------------------------------------------------------
// S11 — resolution reads the persisted value ONCE, however many claims it walks
// ---------------------------------------------------------------------------------------------

/** A scoped line over `bash` that matches every call, so every claim is a candidate. */
const scopedBash = (line: string, id: string, label: string): ToolDesignRegistration => ({
  line,
  tools: ["bash"],
  id,
  label,
  scope: { description: "every bash call", matches: () => true },
  apply: (lines: readonly string[]) => [...lines],
});

const unscopedBash: ToolDesignRegistration = {
  line: "tools",
  tools: ["bash"],
  id: "loon.tools-activity",
  label: "tools activity",
  apply: (lines: readonly string[]) => [...lines],
};

test("S11: one resolve reads the persisted selections ONCE, even with three claims to walk", () => {
  registerToolDesign(scopedBash("diff", "loon.diff", "diff card"));
  registerToolDesign(scopedBash("audit", "loon.audit", "audit card"));
  registerToolDesign(unscopedBash);
  setToolDesignLineSelection("line", "diff", "loon.diff");
  setToolDesignLineSelection("line", "audit", "loon.audit");
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  resetToolDesignSelectionReads();
  const answer = resolveToolDesignSelection("bash", { command: "ls -la" });
  assert.ok(answer.kind === "design");
  assert.equal(answer.design.id, "loon.diff", "the first matching claim answers");
  assert.equal(getToolDesignSelectionReads(), 1, "one snapshot serves every candidate");

  // The same bound for the walk that has to reach the LAST candidate, and for the no-candidate case.
  setToolDesignLineSelection("line", "diff", TOOL_DESIGN_NATIVE);
  setToolDesignLineSelection("line", "audit", TOOL_DESIGN_NATIVE);
  resetToolDesignSelectionReads();
  const declined = resolveToolDesignSelection("bash", { command: "ls -la" });
  assert.equal(getToolDesignSelectionReads(), 1, "one read per resolve, never one per claim");
  assert.ok(declined.kind === "design");
  assert.equal(declined.design.id, "loon.tools-activity", "the unscoped claim is the last candidate");

  resetToolDesignSelectionReads();
  resolveToolDesignSelection("bash");
  assert.equal(getToolDesignSelectionReads(), 1, "no args: still one read");
});

test("S11: a frame with scoped claims still performs one read per card", () => {
  registerToolDesign(scopedBash("diff", "loon.diff", "diff card"));
  registerToolDesign(unscopedBash);
  setToolDesignLineSelection("line", "diff", "loon.diff");
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  const world = transcript({ children: 6, markdown: 3 });
  world.drawFrame();

  resetToolDesignSelectionReads();
  world.drawFrame();
  assert.equal(getToolDesignSelectionReads(), 3, "at most one read per card per frame");
});

test("S19/S11: a line with per-tool scopes still costs ONE selection read per resolve", () => {
  // ONE line, two tools, each claimed by its own scope: the resolver walks claims, not lines.
  registerToolDesign({
    line: "mixed",
    tools: ["bash", "write"],
    id: "loon.mixed",
    label: "mixed card",
    scopes: {
      bash: { description: "every bash call", matches: () => true },
      write: { description: "every write call", matches: () => true },
    },
    apply: (lines: readonly string[]) => [...lines],
  });
  registerToolDesign(unscopedBash);
  setToolDesignLineSelection("line", "mixed", "loon.mixed");
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  resetToolDesignSelectionReads();
  const answer = resolveToolDesignSelection("bash", { command: "ls -la" });
  assert.ok(answer.kind === "design");
  assert.equal(answer.design.id, "loon.mixed", "the scoped claim of THAT tool answers");
  assert.equal(getToolDesignSelectionReads(), 1, "one snapshot serves every (line, tool) claim");

  // The same bound for the tool the SAME registration claims through a different scope.
  resetToolDesignSelectionReads();
  resolveToolDesignSelection("write", { path: "odd/a.md" });
  assert.equal(getToolDesignSelectionReads(), 1, "no args or another tool: still one read");
});

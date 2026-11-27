/**
 * S19/T35–T36 — the WORK a bridge-owned switch does, counted instead of timed.
 *
 * `requestSurfaceRepaint` used to be `tui.invalidate()` + `requestRender(force = true)`. Measuring
 * that against a differential frame on REAL pi components (T35, the tables in `src/repaint.ts`) says
 * the invalidation is the expensive half — it clears every mounted component's frame cache, so the
 * next frame re-parses every Markdown message of the transcript — and the force is the other half —
 * it resets the renderer's differential state and rewrites the whole buffer. 600 children, one
 * switch: 697 ms for the example `plain` style and 306 ms for the way back to a host style, against
 * 420 ms and 16 ms without them; a section toggle on the rail: 99 ms against 3 ms. And the rows the
 * two heavy halves draw are byte-identical on every surface:
 *
 * - the CONVERSATION repaints the style in the wrapper, on the host's ALREADY rendered rows, on
 *   every pass (`src/card-style-wiring.ts` → `src/card-style-transform.ts`), so a component that
 *   answers from its own cache is restyled just the same;
 * - the RAIL is framed by the same wrapper over the host's rail component, so a host memo answering
 *   from its cache is restyled too; and a SECTION toggle moves the bridge's own section digest,
 *   which the host's memo already keys on (`src/sidebar-render.ts` `sectionRailDigest`), while the
 *   revision bump the request keeps is the host's documented part-owner step;
 * - a HOST style is inside the host card's own frame key (`cards-bash-v2`
 *   `extensions/quiet-tools.ts:942-965`), which is why the host's own setter never invalidates
 *   either (`extensions/gentle-shell.ts:3431-3437`).
 *
 * This file bounds the switch by CALL COUNTS, never milliseconds, so it cannot flake on a busy
 * machine, and proves the bound does not grow with the number of Markdown rows:
 *
 * - the tree is never invalidated and no prose component re-parses;
 * - no card is invalidated;
 * - exactly one frame is requested, and it is differential;
 * - and the same counts hold with 3 Markdown rows and with 200.
 *
 * The last test is the control that keeps those zeros honest: with a host frame key that does NOT
 * include the style, the differential path really does draw the previous card, so the instrumented
 * caches are real and the zero counts above mean something.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerCardStyle,
  registerSection,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotProviders,
} from "../src/bus.ts";
import {
  CARD_STYLE_ROWS_PROVIDER_ID,
  installCardStyleRows,
  resetCardStyleRowStateForTests,
} from "../src/card-style-rows.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  installCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import {
  getRepaintDiagnostics,
  resetRepaintForTests,
  setRepaintHost,
} from "../src/repaint.ts";
import { SECTION_ROWS_PROVIDER_ID, installSectionRows } from "../src/sections-rows.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, InlineHelpers, RowContext } from "../src/types.ts";
import { setSectionVisible } from "../src/visibility.ts";
import { BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT, stripAnsi } from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-surface-repaint-cost-"));
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
  resetCardStyleRowStateForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetRepaintForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  disableCardStyleTransform();
  setCardStyleSelection("native");
  // The style and the section the switches below act on, registered the way a plugin does.
  registerCardStyle(MEDIA_STYLE);
  registerSection({ id: "loon.music", title: "Music", lines: () => ["track one", "track two"] });
});

test.afterEach(() => {
  disableCardStyleTransform();
});

const WIDTH = 60;
const GUTTER = "\u258c";

/** A style whose every row proves which function drew it, inside the width it was handed. */
const MEDIA_STYLE = {
  id: "loon.plain",
  label: "plain",
  rowLabel: "plain",
  frame: {
    top: (ctx: { title?: string; width: number }) => `${GUTTER} ${(ctx.title ?? "").slice(0, ctx.width - 2)}`,
    line: (ctx: { text: string; width: number }) => `${GUTTER} ${ctx.text.slice(0, ctx.width - 2)}`,
    bottom: () => GUTTER,
  },
};

/** What the host's own card renderer answers with, unchanged: its real `float` bytes, at width 60. */
const HOST_CALL = [...BASH_MINIMAL_FLOAT_CALL];
const HOST_RESULT = [...BASH_MINIMAL_FLOAT_RESULT];

interface Counters {
  /** `tui.invalidate()`: the call that cleared every cache in the tree. */
  treeInvalidations: number;
  /** What each `requestRender()` was called with. */
  frameRequests: Array<"plain" | "forced">;
  /** A prose row dropped its parsed lines. */
  proseInvalidations: number;
  /** A prose row re-parsed because its cache was empty. */
  proseCacheMisses: number;
  /** A card's `invalidate()` ran (the bridge's old path called it on every mounted card). */
  cardInvalidations: number;
  /** The host card's renderer ran (it may answer from its own cache). */
  hostRenders: number;
  /** The host card answered from its own frame cache. */
  hostCacheHits: number;
  /** The host card rebuilt its frame (width or the HOST style changed). */
  hostRebuilds: number;
}

function counters(): Counters {
  return {
    treeInvalidations: 0,
    frameRequests: [],
    proseInvalidations: 0,
    proseCacheMisses: 0,
    cardInvalidations: 0,
    hostRenders: 0,
    hostCacheHits: 0,
    hostRebuilds: 0,
  };
}

/** A `Markdown`-shaped row: it caches its lines and re-parses only after `invalidate()`. */
function proseRow(text: string, counted: Counters): { render(width: number): string[]; invalidate(): void } {
  let cached: string[] | undefined;
  return {
    render(width: number): string[] {
      if (cached !== undefined) return cached;
      counted.proseCacheMisses += 1;
      cached = [`${text} `.repeat(4).trim().padEnd(width, " ")];
      return cached;
    },
    invalidate(): void {
      counted.proseInvalidations += 1;
      cached = undefined;
    },
  };
}

/**
 * A host bash card whose renderer caches its frame the way `ToolCardRows` does
 * (`cards-bash-v2` `extensions/quiet-tools.ts:942-965`): keyed on width and the HOST's own style.
 * The bridge's style is not in that key — which is why the wrapper post-processes whatever rows the
 * host answers with instead of the tree being invalidated.
 */
function hostCard(counted: Counters, world: { hostStyle: string }): {
  render(width: number): string[];
  invalidate(): void;
} {
  const frame = { width: -1, style: "", lines: [] as string[] };
  const renderCall = (): { render(width: number): string[]; invalidate(): void } => {
    const own = { width: -1, lines: [] as string[] };
    return {
      render(width: number): string[] {
        if (own.width === width) return own.lines;
        own.width = width;
        own.lines = [...HOST_CALL];
        return own.lines;
      },
      invalidate(): void {
        own.width = -1;
      },
    };
  };
  const renderResult = (): { render(width: number): string[]; invalidate(): void } => {
    const own = { width: -1, lines: [] as string[] };
    return {
      render(width: number): string[] {
        if (own.width === width) return own.lines;
        own.width = width;
        own.lines = [...HOST_RESULT];
        return own.lines;
      },
      invalidate(): void {
        own.width = -1;
      },
    };
  };
  let call: { render(width: number): string[] } | undefined;
  let result: { render(width: number): string[] } | undefined;
  return {
    render(width: number): string[] {
      counted.hostRenders += 1;
      if (frame.width === width && frame.style === world.hostStyle) {
        counted.hostCacheHits += 1;
        return frame.lines;
      }
      counted.hostRebuilds += 1;
      call = renderCall();
      result = renderResult();
      frame.width = width;
      frame.style = world.hostStyle;
      frame.lines = [...call.render(width), ...result.render(width)];
      return frame.lines;
    },
    invalidate(): void {
      counted.cardInvalidations += 1;
      frame.width = -1;
      frame.lines = [];
    },
  };
}

interface FakeTui {
  terminal: Record<string, unknown>;
  children: unknown[];
  invalidate(): void;
  requestRender(force?: boolean): void;
}

interface World {
  counted: Counters;
  hostStyle: string;
  chat: { render(width: number): string[]; invalidate(): void };
  draw(): string[];
  tui: FakeTui;
  prose: number;
  cards: number;
}

/**
 * A Pi-shaped transcript: a document whose third child is the chat container (the component
 * `src/card-style-wiring.ts` wraps), holding prose rows and host bash cards. The wrapper, the
 * transform and the repaint path are the real code.
 */
function transcript(options: { prose: number; cards: number }): World {
  const counted = counters();
  const world: World = {
    counted,
    hostStyle: "float",
    chat: {
      render: () => [],
      invalidate: () => {},
    },
    draw: () => [],
    tui: { terminal: {}, children: [], invalidate: () => {}, requestRender: () => {} },
    prose: options.prose,
    cards: options.cards,
  };
  const nodes: Array<{ render(width: number): string[]; invalidate?(): void }> = [];
  for (let index = 0; index < options.prose; index += 1) {
    nodes.push(proseRow(`assistant message ${index}`, counted));
  }
  for (let index = 0; index < options.cards; index += 1) {
    nodes.push(hostCard(counted, world));
  }
  world.chat = {
    render: (width: number): string[] => nodes.flatMap((node) => node.render(width)),
    invalidate: (): void => {
      for (const node of nodes) node.invalidate?.();
    },
  };
  const document = { children: [{}, {}, world.chat] };
  const tui: FakeTui = {
    terminal: {},
    children: [document],
    invalidate: (): void => {
      counted.treeInvalidations += 1;
      world.chat.invalidate();
    },
    requestRender: (force?: boolean): void => {
      counted.frameRequests.push(force === true ? "forced" : "plain");
    },
  };
  world.tui = tui;
  world.draw = () => world.chat.render(WIDTH);
  return world;
}

/** One frame as the host's render loop would draw it. */
const frame = (world: World): string[] => world.draw();

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

const ctx = (): RowContext => ({ theme: undefined, configHome });

/** The card-style row's own action, exactly as the menu runs it. */
async function pressStyle(value: string): Promise<void> {
  installCardStyleRows();
  const provider = snapshotProviders().find((entry) => entry.id === CARD_STYLE_ROWS_PROVIDER_ID);
  assert.ok(provider !== undefined, "the bridge registers the fallback Card style line");
  const row: CustomizeRow | undefined = provider
    .rows(ctx())
    .find((candidate) => candidate.choice?.value === value);
  assert.ok(row?.action !== undefined, `the line has a ${JSON.stringify(value)} value`);
  await row.action(inlineHelpers);
}

/** The section toggle row's own action, exactly as the menu runs it. */
async function pressSection(value: "shown" | "hidden"): Promise<void> {
  installSectionRows();
  const provider = snapshotProviders().find((entry) => entry.id === SECTION_ROWS_PROVIDER_ID);
  assert.ok(provider !== undefined, "the bridge registers its own Sections provider");
  const row: CustomizeRow | undefined = provider
    .rows(ctx())
    .find((candidate) => candidate.choice?.value === value);
  assert.ok(row?.action !== undefined, `the toggle has a ${value} value`);
  await row.action(inlineHelpers);
}

interface Cost {
  treeInvalidations: number;
  frameRequests: Array<"plain" | "forced">;
  proseInvalidations: number;
  proseCacheMisses: number;
  cardInvalidations: number;
  hostCacheHits: number;
}

/** Forget everything counted so far, so a cost is the SWITCH's, not the warm-up frame's. */
function zero(world: World): void {
  world.counted.treeInvalidations = 0;
  world.counted.frameRequests.length = 0;
  world.counted.proseInvalidations = 0;
  world.counted.proseCacheMisses = 0;
  world.counted.cardInvalidations = 0;
  world.counted.hostRenders = 0;
  world.counted.hostCacheHits = 0;
  world.counted.hostRebuilds = 0;
}

function readCost(world: World): Cost {
  return {
    treeInvalidations: world.counted.treeInvalidations,
    frameRequests: [...world.counted.frameRequests],
    proseInvalidations: world.counted.proseInvalidations,
    proseCacheMisses: world.counted.proseCacheMisses,
    cardInvalidations: world.counted.cardInvalidations,
    hostCacheHits: world.counted.hostCacheHits,
  };
}

/** Everything one switch costs, as counts, on a transcript of the given size. */
async function styleSwitchCost(prose: number, cards: number): Promise<{ cost: Cost; drawn: string[] }> {
  const world = transcript({ prose, cards });
  setRepaintHost(world.tui);
  installCardStyleTransform(world.tui);
  setCardStyleSelection("native");
  frame(world);
  zero(world);

  await pressStyle("plain");

  const drawn = frame(world);
  return { cost: readCost(world), drawn };
}

async function sectionToggleCost(prose: number, cards: number): Promise<{ cost: Cost; trigger: unknown }> {
  const world = transcript({ prose, cards });
  setRepaintHost(world.tui);
  installCardStyleTransform(world.tui);
  // Every toggle starts from the same state, so the second measurement is the same work.
  setSectionVisible("loon.music", true);
  frame(world);
  zero(world);

  await pressSection("hidden");

  return { cost: readCost(world), trigger: getRepaintDiagnostics().lastTrigger };
}

// ---------------------------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------------------------

test("T36/S19: a style switch asks for ONE differential frame and invalidates nothing", async () => {
  const { cost, drawn } = await styleSwitchCost(3, 2);

  assert.equal(
    cost.treeInvalidations,
    0,
    "the tree is not invalidated: every Markdown row would re-parse and every card would rebuild",
  );
  assert.deepEqual(cost.frameRequests, ["plain"], "one frame, differential: no forced full redraw");
  assert.equal(cost.proseInvalidations, 0, "progress: no prose cache dropped");
  assert.equal(cost.cardInvalidations, 0, "no card is invalidated by a style switch");
  assert.equal(
    cost.proseCacheMisses,
    0,
    "the switch re-parses nothing: the wrapper restyles the rows the host already drew",
  );
  assert.equal(cost.hostCacheHits, 2, "each host card answered from its OWN frame cache");
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, {
    cause: "card style → loon.plain",
    surfaces: ["conversation", "rail"],
    outcome: "repainted",
  });
  assert.ok(
    drawn.some((line) => stripAnsi(line).startsWith(GUTTER)),
    "and the switch is VISIBLE: the drawn card took the style's frame",
  );
});

test("T36/S19: a section toggle asks for ONE differential frame and invalidates nothing", async () => {
  const { cost, trigger } = await sectionToggleCost(3, 2);

  assert.equal(cost.treeInvalidations, 0, "the rail's repaint does not rebuild the transcript");
  assert.deepEqual(cost.frameRequests, ["plain"], "one frame, differential");
  assert.equal(cost.proseInvalidations, 0);
  assert.equal(cost.proseCacheMisses, 0);
  assert.equal(cost.cardInvalidations, 0);
  assert.deepEqual(trigger, {
    cause: 'section "loon.music" → hidden',
    surfaces: ["rail"],
    outcome: "repainted",
  });
});

test("T36/S19: the work of a switch does not grow with the number of Markdown rows", async () => {
  const small = await styleSwitchCost(3, 2);
  const large = await styleSwitchCost(200, 2);
  assert.deepEqual(
    large.cost,
    small.cost,
    "200 prose rows cost a switch exactly what 3 do: nothing is invalidated, nothing re-parses",
  );

  const smallToggle = await sectionToggleCost(3, 2);
  const largeToggle = await sectionToggleCost(200, 2);
  assert.deepEqual(
    largeToggle.cost,
    smallToggle.cost,
    "and a section toggle is independent of the transcript's prose too",
  );
});

test("T36/S19: the way back to a host style is one differential frame as well", async () => {
  const world = transcript({ prose: 5, cards: 2 });
  setRepaintHost(world.tui);
  installCardStyleTransform(world.tui);
  frame(world);
  zero(world);
  await pressStyle("plain");
  frame(world);

  await pressStyle("native");

  assert.equal(world.counted.treeInvalidations, 0, "no invalidation on the way back");
  assert.deepEqual(world.counted.frameRequests, ["plain", "plain"], "one frame per press");
  assert.equal(world.counted.cardInvalidations, 0);
  assert.equal(world.counted.proseCacheMisses, 0);
  assert.ok(
    frame(world).some((line) => line === HOST_CALL[0]),
    "and the host's own rows are drawn again, byte for byte",
  );
});

// ---------------------------------------------------------------------------------------------
// The control: the instrumented caches are real, so the zeros above mean something
// ---------------------------------------------------------------------------------------------

test("T36/S19 CONTROL: the instrument counts exactly what the old invalidation cost", () => {
  const world = transcript({ prose: 2, cards: 1 });
  setRepaintHost(world.tui);
  installCardStyleTransform(world.tui);
  frame(world);

  const misses = world.counted.proseCacheMisses;
  frame(world);
  assert.equal(world.counted.proseCacheMisses, misses, "a warm frame re-parses nothing");
  assert.equal(world.counted.hostCacheHits, 1, "the host card answered from its own frame cache");

  // The call the old `requestSurfaceRepaint` made: it is what the counts above would have recorded.
  world.tui.invalidate();
  assert.equal(world.counted.treeInvalidations, 1);
  assert.equal(world.counted.cardInvalidations, 1, "the invalidation reaches every mounted card");
  assert.equal(world.counted.proseInvalidations, 2, "and every prose row, which is its real cost");

  const before = world.counted.proseCacheMisses;
  frame(world);
  assert.equal(
    world.counted.proseCacheMisses,
    before + 2,
    "which is why the next frame would have re-parsed the whole transcript",
  );
});

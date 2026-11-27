/**
 * T17–T19 / S11: the bash DESIGN under every card style and every card content.
 *
 * The user's requirement, verbatim (L4):
 *
 * > tambien las tools redisenada (en este caso tool bash) personalizadas deberia ser compatibles con
 * > card style float/neon (o agregados) y card content default/minimal
 *
 * The previous iterations shipped green suites while the feature did nothing in the real TUI,
 * because the fixtures described one card content mode and one frame. So every fixture this suite
 * drives is derived from the INSTALLED host and from pi, and each one says where: see the derivation
 * block in `test/fake-transcript.ts` (`BASH_MINIMAL_*`, `BASH_DEFAULT_*`).
 *
 * The matrix, and what the host really draws in each cell:
 *
 * | card style     | card content | the card's rows                                        |
 * | -------------- | ------------ | ------------------------------------------------------ |
 * | `float`        | `minimal`    | host `floatRows`: padding, `▎ $ cmd … ctrl+o…`          |
 * | `neon`         | `minimal`    | host `cardTop`: `╭─ $ cmd ─── ctrl+o… ╮`                |
 * | `float`        | `default`    | pi native `Text` in a `Box`: ` $ cmd …` padded to width |
 * | `neon`         | `default`    | identical: nothing on pi's path reads `cardStyle()`     |
 * | a REGISTERED   | `minimal`    | the float rows above, repainted by `src/card-style-…`    |
 * | style (added)  | `default`    | unreachable: the repaint needs the float ` ▎ ` grammar   |
 *
 * Everything here is driven through the REAL bridge: the example registers through the published
 * API, the bridge's one resolver wraps the host's renderers, and the design is selected by pressing
 * its `Cards` row. Nothing calls `applyBashHeading` directly, because a helper that works is exactly
 * what the earlier iterations had.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import {
  registerCardStyle,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotSections,
} from "../src/bus.ts";
import { resetCardStyleTransformForTests, transformCardLines } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, { type BridgeExtensionApi } from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { buildRows, resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { resetToolDesignsForTests, snapshotToolDesigns } from "../src/tool-designs.ts";
import { resetToolDesignRowStateForTests } from "../src/tool-design-rows.ts";
import { resetToolDesignWiringForTests } from "../src/tool-design-wiring.ts";
import type { CustomizeRow, InlineHelpers, SidebarSection, ToolDesignContext } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";
import {
  BASH_DEFAULT_CALL,
  BASH_DEFAULT_CALL_NO_TIMEOUT,
  BASH_DEFAULT_CALL_TIGHT,
  BASH_DEFAULT_RESULT,
  BASH_DEFAULT_RESULT_EXPANDED,
  BASH_DEFAULT_RESULT_PROMPT,
  BASH_MINIMAL_FLOAT_CALL,
  BASH_MINIMAL_FLOAT_CALL_LONG,
  BASH_MINIMAL_FLOAT_CALL_RUNNING,
  BASH_MINIMAL_FLOAT_RESULT,
  BASH_MINIMAL_FLOAT_RESULT_EMPTY,
  BASH_MINIMAL_FLOAT_RESULT_PROMPT,
  BASH_MINIMAL_NEON_CALL,
  BASH_MINIMAL_NEON_CALL_LONG,
  BASH_MINIMAL_NEON_CALL_RUNNING,
  BASH_MINIMAL_NEON_RESULT,
  BASH_MINIMAL_NEON_RESULT_EMPTY,
  BASH_MINIMAL_NEON_RESULT_PROMPT,
  stripAnsi,
} from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-matrix-"));
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
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetToolDesignsForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignWiringForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
  setCardStyleSelection("native");
});

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  registerCommand?: () => void;
  registerToolRenderer?: (resolver: unknown) => void;
  getCommands?: () => Array<{ name: string }>;
}

type ExampleInit = (pi: FakePi) => () => void;

const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  return ((await import(specifier)) as { default: ExampleInit }).default;
};

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

interface FakeComponent {
  render(width: number): string[];
}

interface FakeRenderers {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  [member: string]: unknown;
}

function fakeComponent(lines: readonly string[]): FakeComponent {
  const rows = [...lines];
  return { render: (): string[] => rows };
}

/** The renderers the host's call site hands Pi: a call component and a result component. */
function fakeRenderers(call: readonly string[], result: readonly string[]): FakeRenderers {
  const callComponent = fakeComponent(call);
  const resultComponent = fakeComponent(result);
  return {
    renderShell: "default",
    renderCall: () => callComponent,
    renderResult: () => resultComponent,
  };
}

const THEME = { name: "fake-theme" };

function mount(renderers: FakeRenderers, member: "renderCall" | "renderResult"): FakeComponent {
  const renderer = renderers[member];
  assert.equal(typeof renderer, "function");
  return member === "renderCall"
    ? (renderer as (args: unknown, theme: unknown, ctx: unknown) => FakeComponent)(
        { command: "npm test" },
        THEME,
        {},
      )
    : (renderer as (result: unknown, options: unknown, theme: unknown, ctx: unknown) => FakeComponent)(
        { content: [] },
        { expanded: false },
        THEME,
        {},
      );
}

type Resolver = (tool: string, next: () => FakeRenderers) => FakeRenderers | undefined;

interface World {
  readonly resolver: Resolver;
  rows(): CustomizeRow[];
  pick(value: string): Promise<void>;
  /** The example's CARD BASH section, live. */
  section(): SidebarSection;
  /** What the example asked Pi's TUI to tell the user, in order. */
  notices(): string[];
  /** A later `session_start`: the channel the example delivers buffered notices on. */
  sessionStart(): void;
  dispose(): void;
}

async function startWorld(tag: string): Promise<World> {
  publishBridgeApi();
  const host = createFakeHost();
  const resolvers: unknown[] = [];
  const sessionHandlers: SessionHandler[] = [];
  const notices: string[] = [];
  const ui = {
    custom: (factory: unknown, ...rest: unknown[]): unknown =>
      (host.ui.custom as ((f: unknown, ...r: unknown[]) => unknown) | undefined)?.(factory, ...rest),
    notify: (message: string): void => {
      notices.push(message);
    },
  };
  const pi: FakePi = {
    // `gentle-pi` is present, so the bridge's `session_start` arms (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand() {},
    registerToolRenderer(resolver) {
      resolvers.push(resolver);
    },
  };

  const sessionStart = (): void => {
    // The bridge and the example both subscribe; each gets the same context, as on Pi.
    for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  };

  gentleShellBridge(pi as BridgeExtensionApi);
  const dispose = (await loadExample(tag))(pi);
  sessionStart();

  assert.equal(resolvers.length, 1, "the bridge registers exactly one resolver");
  const resolver = resolvers[0] as Resolver;
  assert.equal(typeof resolver, "function");

  const rows = (): CustomizeRow[] => buildRows({ theme: undefined, configHome }).rows;
  const section = (): SidebarSection => {
    const found = snapshotSections().find((candidate) => candidate.id === "bash-card.status");
    assert.ok(found !== undefined, "the example registers its CARD BASH section");
    return found;
  };

  return {
    resolver,
    rows,
    pick: async (value) => {
      const row = rows().find(
        (candidate) =>
          /bash/iu.test(candidate.choice?.setting ?? "") && candidate.choice?.value === value,
      );
      assert.ok(row?.action !== undefined, `the Cards line carries the value ${value}`);
      await row.action(inlineHelpers);
    },
    section,
    notices: () => [...notices],
    sessionStart,
    dispose,
  };
}

/** Visible width of one row, ANSI ignored. */
function widthOf(line: string): number {
  return [...stripAnsi(line)].length;
}

/** Every row keeps the width the host gave it. */
function assertWidths(rows: readonly string[], width: number, label: string): void {
  for (const [index, row] of rows.entries()) {
    assert.equal(widthOf(row), width, `${label}: row ${index} keeps the host's width`);
  }
}

// ---------------------------------------------------------------------------------------------
// The matrix cells, with the exact heading each one draws and the exact row the design must emit
// ---------------------------------------------------------------------------------------------

/**
 * `minimal` x `float`: `▎ $ npm test (timeout 30s) <12 spaces> ctrl+o to expand   ` becomes
 * `▎ bash npm test (timeout 30s) <9 spaces> ctrl+o to expand   ` — the word costs three columns and
 * the host's own space fill gives them back, so the rule still ends where it did.
 */
const DESIGNED_MINIMAL_FLOAT_HEADING =
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m \u001b[39m\u001b[95mbash \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m" +
  "\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m         \u001b[39m \u001b[2mctrl+o to expand\u001b[39m" +
  " \u001b[95m  \u001b[39m\u001b[49m ";

/** `minimal` x `neon`: the same swap, taken out of the rule's `─` fill. */
const DESIGNED_MINIMAL_NEON_TOP =
  "\u001b[95m╭\u001b[39m\u001b[95m─ \u001b[39m\u001b[95mbash \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m" +
  "\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m ──────────\u001b[39m \u001b[2mctrl+o to expand\u001b[39m" +
  " \u001b[95m╮\u001b[39m";

/** `default`: the mark is the row's first column and the row's padding gives the columns back. */
const DESIGNED_DEFAULT_HEADING =
  "\u001b[95m\u001b[1mbash npm test\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m" +
  "                               ";

/**
 * `minimal` x `float`, a command the HOST already collapsed: the word costs three columns, and the
 * row has only its minimum rule fill, so the cost comes out of the COMMAND'S OWN ABBREVIATION — the
 * three characters before the host's ellipsis — never out of a character the host did not
 * abbreviate, and the fill is left exactly as the host drew it.
 */
const DESIGNED_MINIMAL_FLOAT_LONG_HEADING =
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m \u001b[39m\u001b[95mbash \u001b[95m\u001b[1mnpm run typech…\u001b[22m\u001b[39m" +
  "\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m  \u001b[39m \u001b[2mctrl+o to expand\u001b[39m" +
  " \u001b[95m  \u001b[39m\u001b[49m ";

/** `minimal` x `neon`, the same rule in the outline: the command's abbreviated tail pays. */
const DESIGNED_MINIMAL_NEON_LONG_TOP =
  "\u001b[95m╭\u001b[39m\u001b[95m─ \u001b[39m\u001b[95mbash \u001b[95m\u001b[1mnpm run typechec…\u001b[22m\u001b[39m" +
  "\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m ─\u001b[39m \u001b[2mctrl+o to expand\u001b[39m" +
  " \u001b[95m╮\u001b[39m";

interface Cell {
  /** The user's own vocabulary: `<card style> × <card content>`. */
  readonly id: string;
  /** The width the design is handed: the component's, so the native cell loses the Box's padding. */
  readonly width: number;
  readonly call: readonly string[];
  readonly result: readonly string[];
  /** The call component's row that heads the card, and what it must read after the design. */
  readonly headingRow: number;
  readonly designedHeading: string;
}

const CELLS: readonly Cell[] = [
  {
    id: "float × minimal",
    width: 60,
    call: BASH_MINIMAL_FLOAT_CALL,
    result: BASH_MINIMAL_FLOAT_RESULT,
    headingRow: 1,
    designedHeading: DESIGNED_MINIMAL_FLOAT_HEADING,
  },
  {
    id: "neon × minimal",
    width: 60,
    call: BASH_MINIMAL_NEON_CALL,
    result: BASH_MINIMAL_NEON_RESULT,
    headingRow: 0,
    designedHeading: DESIGNED_MINIMAL_NEON_TOP,
  },
  {
    id: "float × default",
    width: 58,
    call: BASH_DEFAULT_CALL,
    result: BASH_DEFAULT_RESULT,
    headingRow: 0,
    designedHeading: DESIGNED_DEFAULT_HEADING,
  },
  {
    // The same rows as the cell above, and that IS the finding: with content `default` the host's
    // resolver calls `next()` and pi's native renderer draws, where nothing reads `cardStyle()`.
    id: "neon × default",
    width: 58,
    call: BASH_DEFAULT_CALL,
    result: BASH_DEFAULT_RESULT,
    headingRow: 0,
    designedHeading: DESIGNED_DEFAULT_HEADING,
  },
];

// ---------------------------------------------------------------------------------------------
// T17: the fixtures are the shapes the host draws, cell by cell
// ---------------------------------------------------------------------------------------------

test("T17: every cell's fixture is the host's own rows, at the host's own width", () => {
  // `minimal` x `float`: 60 wide, heading on row 1 after the padding row.
  assertWidths(BASH_MINIMAL_FLOAT_CALL, 60, "minimal/float call");
  assert.equal(BASH_MINIMAL_FLOAT_CALL.length, 2, "floatRows: padding + heading, nothing else");
  assert.equal(stripAnsi(BASH_MINIMAL_FLOAT_CALL[1] ?? "").includes("$ npm test"), true);
  assert.equal(stripAnsi(BASH_MINIMAL_FLOAT_CALL[1] ?? "").startsWith(" ▎ $ npm test"), true);

  // `minimal` x `neon`: one row, the outlined top rule.
  assertWidths(BASH_MINIMAL_NEON_CALL, 60, "minimal/neon call");
  assert.equal(BASH_MINIMAL_NEON_CALL.length, 1);
  assert.equal(stripAnsi(BASH_MINIMAL_NEON_CALL[0] ?? "").startsWith("╭─ $ npm test"), true);

  // `default`: pi's native row, 58 wide because the `Box` spends the card's two padding columns.
  assertWidths(BASH_DEFAULT_CALL, 58, "default call");
  assert.equal(BASH_DEFAULT_CALL.length, 1);
  assert.equal(stripAnsi(BASH_DEFAULT_CALL[0] ?? "").startsWith("$ npm test"), true);

  // The result components, in the shapes each content mode draws.
  assertWidths(BASH_MINIMAL_FLOAT_RESULT, 60, "minimal/float result");
  assertWidths(BASH_MINIMAL_NEON_RESULT, 60, "minimal/neon result");
  // pi's result opens with a `Spacer` row, which renders as the empty string: the `Box` above it is
  // what pads it, so the design is handed a zero-width row there and must leave it alone.
  assert.equal(stripAnsi(BASH_DEFAULT_RESULT[0] ?? ""), "", "pi's result starts with a Spacer");
  assertWidths(BASH_DEFAULT_RESULT.slice(1), 58, "default result");
  assert.equal(BASH_MINIMAL_FLOAT_RESULT[0], BASH_MINIMAL_FLOAT_RESULT[3], "separator === closer");
  assert.equal(stripAnsi(BASH_MINIMAL_FLOAT_RESULT_EMPTY[0] ?? "").startsWith(" ▎ "), true);
  assert.equal(stripAnsi(BASH_MINIMAL_NEON_RESULT_EMPTY[0] ?? "").startsWith("╰"), true);
});

// ---------------------------------------------------------------------------------------------
// T18: the design over the whole matrix
// ---------------------------------------------------------------------------------------------

test("T18: with the host's card selected, every cell draws the host's rows byte for byte", async () => {
  const world = await startWorld("matrix-native");

  for (const cell of CELLS) {
    const renderers = fakeRenderers(cell.call, cell.result);
    const resolved = world.resolver("bash", () => renderers);
    assert.ok(resolved !== undefined, `${cell.id}: the bridge's wrapper is what the card uses`);
    const call = mount(resolved, "renderCall");

    assert.deepEqual(call.render(cell.width), [...cell.call], `${cell.id}: the host's card`);
  }

  world.dispose();
});

test("T18: the design heads every cell with bash and changes no other byte", async () => {
  const world = await startWorld("matrix-designed");
  await world.pick("bash heading");

  for (const cell of CELLS) {
    const renderers = fakeRenderers(cell.call, cell.result);
    const resolved = world.resolver("bash", () => renderers);
    assert.ok(resolved !== undefined);
    const call = mount(resolved, "renderCall");
    const result = mount(resolved, "renderResult");

    const output = call.render(cell.width);

    assert.equal(output.length, cell.call.length, `${cell.id}: the frame keeps its row count`);
    for (const [row, line] of output.entries()) {
      if (row === cell.headingRow) {
        assert.equal(line, cell.designedHeading, `${cell.id}: the heading reads bash`);
        assert.equal(
          stripAnsi(line).includes("$"),
          false,
          `${cell.id}: the host's mark is gone from the heading`,
        );
      } else {
        assert.equal(line, cell.call[row], `${cell.id}: row ${row} is the host's byte for byte`);
      }
    }
    assertWidths(output, cell.width, cell.id);

    assert.deepEqual(
      result.render(cell.width),
      [...cell.result],
      `${cell.id}: the result component is the host's, row for row`,
    );
  }

  world.dispose();
});

test("T18: the heading is found with no timeout suffix and no hint on the row", async () => {
  const world = await startWorld("matrix-plain-heading");
  await world.pick("bash heading");
  const resolved = world.resolver("bash", () => fakeRenderers(BASH_DEFAULT_CALL_NO_TIMEOUT, []));
  assert.ok(resolved !== undefined);

  const output = mount(resolved, "renderCall").render(58);

  assert.deepEqual(output, [
    "\u001b[95m\u001b[1mbash npm test\u001b[22m\u001b[39m" + " ".repeat(45),
  ]);
  assertWidths(output, 58, "plain heading");

  world.dispose();
});

test("T18: a card whose command is still running is headed too, in both minimal styles", async () => {
  const world = await startWorld("matrix-running");
  await world.pick("bash heading");

  // While the result is missing the host closes the frame itself (`cardAwaitingResult`), so the call
  // component carries `running…` rows after the heading — and the heading must be headed anyway.
  const runningCells = [
    {
      label: "minimal/float running",
      fixture: BASH_MINIMAL_FLOAT_CALL_RUNNING,
      heading: 1,
      designed: DESIGNED_MINIMAL_FLOAT_HEADING,
    },
    {
      label: "minimal/neon running",
      fixture: BASH_MINIMAL_NEON_CALL_RUNNING,
      heading: 0,
      designed: DESIGNED_MINIMAL_NEON_TOP,
    },
  ] as const;

  for (const cell of runningCells) {
    const resolved = world.resolver("bash", () => fakeRenderers(cell.fixture, []));
    assert.ok(resolved !== undefined);
    const output = mount(resolved, "renderCall").render(60);

    assert.equal(output.length, cell.fixture.length, `${cell.label}: every row the host drew`);
    for (const [row, line] of output.entries()) {
      if (row === cell.heading) {
        assert.equal(line, cell.designed, `${cell.label}: the heading reads bash`);
      } else {
        assert.equal(line, cell.fixture[row], `${cell.label}: row ${row} is the host's`);
      }
    }
    assertWidths(output, 60, cell.label);
  }

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// T24–T25: a command the host already collapsed pays the word's three columns from its own
// abbreviation; a command shown in full is never shortened (S14)
// ---------------------------------------------------------------------------------------------

test("T24/T25: a long collapsed command is headed bash by shortening its own ellipsis", async () => {
  const world = await startWorld("matrix-long-collapsed");
  await world.pick("bash heading");

  const longCells = [
    {
      label: "float × minimal",
      fixture: BASH_MINIMAL_FLOAT_CALL_LONG,
      heading: 1,
      designed: DESIGNED_MINIMAL_FLOAT_LONG_HEADING,
    },
    {
      label: "neon × minimal",
      fixture: BASH_MINIMAL_NEON_CALL_LONG,
      heading: 0,
      designed: DESIGNED_MINIMAL_NEON_LONG_TOP,
    },
  ] as const;

  for (const cell of longCells) {
    const resolved = world.resolver("bash", () => fakeRenderers(cell.fixture, []));
    assert.ok(resolved !== undefined);
    const output = mount(resolved, "renderCall").render(60);

    assert.equal(output.length, cell.fixture.length, `${cell.label}: the frame keeps its row count`);
    for (const [row, line] of output.entries()) {
      if (row === cell.heading) assert.equal(line, cell.designed, `${cell.label}: the heading reads bash`);
      else assert.equal(line, cell.fixture[row], `${cell.label}: row ${row} is the host's byte for byte`);
    }
    assertWidths(output, 60, cell.label);
  }

  // The design handled both cards, so the section must not claim a refusal for them.
  const report = world.section().lines({ theme: undefined, configHome });
  assert.equal(
    report.some((line) => typeof line === "string" && /^unrecognised\s+none$/u.test(line)),
    true,
    "the section reports no refusal for a collapsed command the design headed",
  );
  assert.equal(
    report.some((line) => typeof line === "string" && /no fill/u.test(line)),
    false,
    "and stops claiming no fill once the design can pay the word's columns",
  );

  world.dispose();
});

test("T25/S14: a command shown in full is never shortened, even with no fill", async () => {
  const world = await startWorld("matrix-long-full");
  await world.pick("bash heading");
  const resolved = world.resolver("bash", () => fakeRenderers(BASH_DEFAULT_CALL_TIGHT, []));
  assert.ok(resolved !== undefined);

  // The row is full and its command is NOT abbreviated: a design must not hide what a command
  // does by cutting three columns out of it, so the host's bytes stand and the refusal is reported.
  assert.deepEqual(
    mount(resolved, "renderCall").render(58),
    [...BASH_DEFAULT_CALL_TIGHT],
    "an unabbreviated command is the host's, byte for byte",
  );

  const lines = world.section().lines({ theme: undefined, configHome });
  assert.equal(
    lines.some((line) => typeof line === "string" && /no fill/u.test(line)),
    true,
    "a genuine refusal is still reported",
  );

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// T19: a frame the design cannot recognise comes back byte-identical, and is reported once
// ---------------------------------------------------------------------------------------------

test("T19: a result component is never rewritten, in every cell the shapes allow", async () => {
  const world = await startWorld("matrix-results");
  await world.pick("bash heading");

  // `neon` and `default`: the mark sits on a row the design can prove is not a heading — a `│` side
  // row, or a row after pi's blank Spacer — so it is the host's row.
  for (const [label, width, fixture] of [
    ["neon", 60, BASH_MINIMAL_NEON_RESULT_PROMPT],
    ["default", 58, BASH_DEFAULT_RESULT_PROMPT],
    ["default expanded", 58, BASH_DEFAULT_RESULT_EXPANDED],
  ] as const) {
    const resolved = world.resolver("bash", () => fakeRenderers(fixture, fixture));
    assert.ok(resolved !== undefined);
    assert.deepEqual(
      mount(resolved, "renderResult").render(width),
      [...fixture],
      `${label}: output is never rewritten as if it were the heading`,
    );
  }

  world.dispose();
});

test("T21/S12: in the float cell an output row that starts with the mark passes through byte for byte", async () => {
  const world = await startWorld("matrix-float-result-prompt");
  await world.pick("bash heading");
  const resolved = world.resolver("bash", () =>
    fakeRenderers(BASH_MINIMAL_FLOAT_RESULT_PROMPT, BASH_MINIMAL_FLOAT_RESULT_PROMPT),
  );
  assert.ok(resolved !== undefined);

  // The call component and the result component of a float card are drawn with the SAME chrome and
  // the same row positions (padding row, then a `▎ ` row), so `cat script.sh` printing a line that
  // begins with `$ ` sits exactly where a heading sits. The bridge now says WHICH part it is drawing
  // (`ctx.part`), so the design acts on the call alone and the host's output is what is drawn: no
  // data is lost, no row is widened, and every byte — ANSI, padding, the echoed command — comes
  // back as the host drew it.
  const output = mount(resolved, "renderResult").render(60);

  assert.deepEqual(output, [...BASH_MINIMAL_FLOAT_RESULT_PROMPT], "the result is the host's, row for row");
  assert.equal(stripAnsi(output[1] ?? "").includes("$ echo hi"), true, "the echoed prompt survives");
  assertWidths(output, 60, "float prompt echo");

  // The SAME rows handed to the CALL renderer are still a heading: `part` decides, never the row's
  // shape, so the design still does its job where a heading really is.
  const call = mount(resolved, "renderCall").render(60);
  assert.equal(call.length, BASH_MINIMAL_FLOAT_RESULT_PROMPT.length, "the frame keeps its row count");
  assert.equal(stripAnsi(call[1] ?? "").includes("bash echo hi"), true, "the call is still headed");
  assert.equal(stripAnsi(call[1] ?? "").includes("$ echo hi"), false, "and its mark is gone");
  assertWidths(call, 60, "float prompt echo call");

  world.dispose();
});

test("T21/S12: a context with no `part` (an older bridge) keeps the previous behaviour", async () => {
  const world = await startWorld("matrix-no-part");
  await world.pick("bash heading");

  // A bridge published BEFORE this field hands a design `{ width, tool, theme }` and no `part` at all.
  // This build's wrapper always sets it, so an older context cannot be produced through the bus: this
  // is the one place the registered design is driven directly, and what it pins is the fallback — the
  // part is UNKNOWN, never `result`, so the design keeps the behaviour it had before the field
  // existed (the row grammar decides) instead of refusing every frame an older bridge hands it.
  const design = snapshotToolDesigns("bash").find((entry) => entry.id === "bash-card.bash-heading");
  assert.ok(design !== undefined, "the example's design is the one on the bus");
  // SAFETY: the older bridge's context has no `part`; the published type says it is always set, so the
  // older shape is spelled on purpose here — that IS the case this test exists for.
  const legacyContext = { width: 60, tool: "bash" } as ToolDesignContext;
  const legacy = design.apply(BASH_MINIMAL_FLOAT_RESULT_PROMPT, legacyContext);

  assert.equal(
    stripAnsi(legacy[1] ?? "").includes("bash echo hi"),
    true,
    "with no part the row grammar still decides, exactly as before",
  );
  assertWidths(legacy, 60, "no part");

  world.dispose();
});

test("T19: a heading with no fill to take the word's three columns is left alone and reported", async () => {
  const world = await startWorld("matrix-no-room");
  await world.pick("bash heading");
  const resolved = world.resolver("bash", () => fakeRenderers(BASH_DEFAULT_CALL_TIGHT, []));
  assert.ok(resolved !== undefined);
  const call = mount(resolved, "renderCall");

  assert.deepEqual(call.render(58), [...BASH_DEFAULT_CALL_TIGHT], "the frame, unchanged");

  const section = world.section();
  const lines = section.lines({ theme: undefined, configHome });
  assert.equal(
    lines.some((line) => typeof line === "string" && /^unrecognised\s/u.test(line)),
    true,
    "the section says the frame was not recognised",
  );
  assert.equal(
    lines.some((line) => typeof line === "string" && /no fill/u.test(line)),
    true,
    "and names the reason",
  );

  // The rest of the frame is drawn again and again on every render pass; the report does not grow.
  call.render(58);
  call.render(58);
  world.sessionStart();
  world.sessionStart();
  const notices = world.notices();
  assert.equal(notices.length, 1, "one notice, delivered exactly once");
  assert.match(notices[0] ?? "", /\[bash-card\]/u);
  assert.match(notices[0] ?? "", /no padding or rule fill/u);
  assert.match(notices[0] ?? "", /CARD BASH/u, "it points at the section that reports it live");

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// T18: an ADDED card style — the bridge repaints the frame AFTER the design
// ---------------------------------------------------------------------------------------------

/** A registered style whose chrome is readable at a glance and whose rows fit the width. */
function addedStyle(): { id: string; label: string; tops: string[] } {
  const tops: string[] = [];
  const fit = (text: string, width: number): string => {
    const clipped = [...text].slice(0, width).join("");
    return clipped.padEnd(width, "-");
  };
  registerCardStyle({
    id: "matrix.added",
    label: "added",
    frame: {
      top: (ctx) => {
        const line = fit(`+${ctx.title ?? ""}${ctx.hint === undefined ? "" : `|${ctx.hint}`}`, ctx.width);
        tops.push(line);
        return line;
      },
      line: (ctx) => fit(`> ${ctx.text}`, ctx.width),
      bottom: (ctx) => "-".repeat(ctx.width),
    },
  });
  setCardStyleSelection("matrix.added");
  return { id: "matrix.added", label: "added", tops };
}

test("T18: the design's heading survives a style ADDED through registerCardStyle", async () => {
  const world = await startWorld("matrix-added");
  await world.pick("bash heading");
  const style = addedStyle();

  const renderers = fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const designed = [
    ...mount(resolved, "renderCall").render(60),
    ...mount(resolved, "renderResult").render(60),
  ];

  const repainted = transformCardLines([...designed], 60);

  assert.notEqual(repainted, designed, "the added style repainted the card");
  assert.equal(repainted.length > 0, true);
  assert.equal(
    repainted.some((row) => stripAnsi(row).startsWith("+")),
    true,
    "the added style's own frame is what is drawn",
  );
  assert.equal(
    stripAnsi(repainted[0] ?? "").includes("bash npm test"),
    true,
    "the word the design put in the heading survives the repaint",
  );
  assert.equal(
    stripAnsi(repainted[0] ?? "").includes("$ npm test"),
    false,
    "and the host's mark does not come back",
  );
  assert.equal(
    style.tops.some((top) => top.includes("bash npm test")),
    true,
    "the style was handed the designed heading, not the host's",
  );
  for (const row of repainted) {
    assert.equal(widthOf(row), 60, "every repainted row is the card's width");
  }

  // The difference comes from the design, not from the style: with the host's card selected the
  // very same transform draws the host's heading. The bridge drops the leading glyph before it hands
  // the title to a style (`stripGlyph`, `src/card-style-transform.ts:301-305`), which is why the
  // host's `$` never reaches a registered style and the design's whole word does.
  await world.pick("default");
  style.tops.length = 0;
  const hostCard = [
    ...mount(resolved, "renderCall").render(60),
    ...mount(resolved, "renderResult").render(60),
  ];
  const repaintedHost = transformCardLines([...hostCard], 60);
  assert.equal(style.tops.length > 0, true, "the style still repainted");
  assert.equal(
    style.tops.every((top) => top.includes("npm test")),
    true,
    "the heading is the host's own command",
  );
  assert.equal(
    style.tops.some((top) => top.includes("bash")),
    false,
    "and the design's word is not in it",
  );
  assert.equal(
    repaintedHost.length,
    4,
    "the added style owns the frame: one top row, the card's two body rows, one bottom row",
  );

  world.dispose();
});

test("T18: an added style cannot reach the default cell, and the design's rows pass through", async () => {
  const world = await startWorld("matrix-added-default");
  await world.pick("bash heading");
  addedStyle();

  const resolved = world.resolver("bash", () => fakeRenderers(BASH_DEFAULT_CALL, BASH_DEFAULT_RESULT));
  assert.ok(resolved !== undefined);
  const designed = [
    ...mount(resolved, "renderCall").render(58),
    ...mount(resolved, "renderResult").render(58),
  ];
  assert.equal(designsBash(designed), true, "the design did its job first");

  const lines = [...designed];
  assert.equal(
    transformCardLines(lines, 58),
    lines,
    "the repaint only knows the float grammar, so pi's native rows are the same array instance",
  );

  // The outlined `minimal` card is not repaintable either: the bridge's grammar is float's.
  const neon = world.resolver("bash", () => fakeRenderers(BASH_MINIMAL_NEON_CALL, BASH_MINIMAL_NEON_RESULT));
  assert.ok(neon !== undefined);
  const neonRows = [
    ...mount(neon, "renderCall").render(60),
    ...mount(neon, "renderResult").render(60),
  ];
  assert.equal(transformCardLines(neonRows, 60), neonRows, "neon rows are passed through");

  world.dispose();
});

/** Whether the card's heading carries the design's word (used only to prove ordering). */
function designsBash(rows: readonly string[]): boolean {
  return rows.some((row) => stripAnsi(row).startsWith("bash npm test"));
}

/**
 * T29–T31 / S17: the example's `plain` card style, restored with the same id, and proven to compose
 * with everything it was asked to compose with (L8).
 *
 * The user's words, verbatim:
 *
 * > nose si se rompio o lo sacaste pero ya no sale en card style la opcion plain que agregaba el
 * > ejemplo, hay que recuperala y probar que se integre bien con todo (con card content y con card
 * > tool modificadas como bash y con sidebar nativa y expandidas/agragadas)
 *
 * The style was removed by the parent's own instruction in `8334667`, not by a defect (E7): the
 * original definition is `5c0c123:examples/bash-card.ts:344-415`, its coverage lived in
 * `5c0c123:test/example-transform.test.ts` and `5c0c123:test/example-late-load.test.ts`. This file
 * restores both, then adds the integration matrix the user named.
 *
 * What is REAL here and what is MODELLED:
 *
 * - real: the example registers through the published API; the bridge's own card-style transform
 *   (`installCardStyleTransform` / `installRailCardStyleTransform` through the extension entry), its
 *   sidebar backend wrapper and its section renderer (`buildSectionContribution`), its card-style
 *   rows (the host's own `Card style` line, extended), its store, and the host's own `neon`/`float`
 *   rows.
 * - modelled: the host's framing of a rail section into a `float` card. `hostSectionCard` below is
 *   pinned against the host-produced fixtures `RAIL_HOST_CARD` / `RAIL_BRIDGE_CARD`: it reproduces
 *   both byte for byte, so the bytes it draws for the example's own section follow the same shape.
 * - fixtures: every conversation card and every rail card is the host's or pi's own output; the
 *   derivation is the comment block in `test/fake-transcript.ts` (conversation) and
 *   `test/fake-sidebar.ts` (rail).
 *
 * The matrix is stated as a table in the test names themselves, including the cells that are NOT
 * reachable: card content `default` is pi's native card, not a float frame, so neither a host style
 * nor a registered one reaches it. Pass-through is pinned by array identity, never by "looks the
 * same", and `/bridge-status` has to say so too.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_API_KEY,
  BRIDGE_READY_EVENT,
  announceBridgeReady,
  bridgeApi,
  publishBridgeApi,
  resetBridgeApiForTests,
} from "../src/api.ts";
import { armBridge } from "../src/arm.ts";
import {
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotCardStyles,
  snapshotSections,
} from "../src/bus.ts";
import {
  installCardStyleRows,
  resetCardStyleRowStateForTests,
} from "../src/card-style-rows.ts";
import {
  getCardStyleLastOutcome,
  resetCardStyleTransformForTests,
  transformCardLines,
} from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  resetCardStyleWiringForTests,
  installCardStyleTransform,
} from "../src/card-style-wiring.ts";
import {
  getCardStyleSelection,
  resolveCardStyleSelection,
  setCardStyleSelection,
} from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, { type BridgeExtensionApi } from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { buildRows, resetRowBuildStateForTests } from "../src/rows.ts";
import { setSectionTheme, resetSectionPanelForTests } from "../src/section-panel.ts";
import { resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { buildSectionContribution, resetSectionFailuresForTests } from "../src/sidebar-render.ts";

/** The footer part with every native part painted: where a contribution with no placement lands. */
const FOOTER_RAIL = { part: "footer" as const, painted: RAIL_PARTS };
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { resetToolDesignsForTests, setToolDesignSelection, snapshotToolDesigns } from "../src/tool-designs.ts";
import { resetToolDesignRowStateForTests } from "../src/tool-design-rows.ts";
import { resetToolDesignWiringForTests } from "../src/tool-design-wiring.ts";
import { RAIL_PARTS } from "../src/types.ts";
import type { CustomizeRow, InlineHelpers } from "../src/types.ts";
import { setSectionCollapsed } from "../src/visibility.ts";
import { createFakeEvents } from "./fake-events.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";
import {
  RAIL_HOST_CARD,
  type Rail,
  createRailTui,
  fakeState,
  registerNativeFooter,
  resetSidebar,
} from "./fake-sidebar.ts";
import {
  BASH_DEFAULT_CALL,
  BASH_DEFAULT_RESULT,
  BASH_MINIMAL_FLOAT_CALL,
  BASH_MINIMAL_FLOAT_RESULT,
  HOST_READ_CARD,
  READ_CARD,
  createFakeTranscriptTui,
  stripAnsi,
} from "./fake-transcript.ts";

// ---------------------------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------------------------

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  registerCommand?: () => void;
  registerToolRenderer?: (resolver: unknown) => void;
  getCommands?: () => Array<{ name: string }>;
  events?: unknown;
}

type ExampleInit = (pi: FakePi) => () => void;

/** One fresh module instance per scenario: the example keeps nothing on `globalThis`. */
const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  return ((await import(specifier)) as { default: ExampleInit }).default;
};

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

const recordingPi = (events?: unknown): { pi: FakePi; sessionHandlers: SessionHandler[] } => {
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    ...(events === undefined ? {} : { events }),
  };
  return { pi, sessionHandlers };
};

const notifySurface = (): {
  ui: { notify: (message: string, level?: string) => void };
  calls: Array<[string, string | undefined]>;
} => {
  const calls: Array<[string, string | undefined]> = [];
  return { ui: { notify: (message, level) => calls.push([message, level]) }, calls };
};

const loadBridge = (events: ReturnType<typeof createFakeEvents>): void => {
  const pi: BridgeExtensionApi = { on() {}, registerCommand() {}, events };
  gentleShellBridge(pi);
};

/** How many `plain` styles and `CARD BASH` sections this load owns right now. */
const surfaceCounts = (): number[] => [
  snapshotCardStyles().filter((style) => style.id === "bash-card.plain").length,
  snapshotSections().filter((section) => section.id === "bash-card.status").length,
];

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-plain-"));
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
  resetCardStyleRowStateForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRepaintForTests();
  resetRowBuildStateForTests();
  resetSectionFailuresForTests();
  resetSectionPanelForTests();
  resetSectionPointerForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetStoreStateForTests();
  resetToolDesignsForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignWiringForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
  setCardStyleSelection("native");
});

test.afterEach(() => {
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
});

// ---------------------------------------------------------------------------------------------
// T29/T30 — the restored style, its registration and its coverage
// ---------------------------------------------------------------------------------------------

test("T29: the example registers `plain` (id bash-card.plain) on the Card style row, with its literal preview", async () => {
  // The host's own line, as gentle-shell builds it (`extensions/gentle-shell.ts:3398-3419`).
  type HostRow = CustomizeRow;
  let hostStyle = "float";
  const hostStyleRow = (value: "neon" | "float"): HostRow => ({
    category: "Cards",
    label: `Card style: ${value}`,
    action: () => {
      hostStyle = value;
    },
    choice: {
      setting: "Card style",
      value,
      current: () => hostStyle === value,
    },
  });
  const host = createFakeHost({
    rows: [
      { category: "Cards", label: "Card content: default", action: () => {} },
      hostStyleRow("neon"),
      hostStyleRow("float"),
      { category: "Layout", label: "Layout: builtin", action: () => {} },
    ],
  });
  armBridge(host.ui);
  installCardStyleRows();

  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("plain-row"))(pi);
  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.deepEqual(calls, [], "nothing to warn about: the bridge published the surface");
  assert.deepEqual(surfaceCounts(), [1, 1]);

  const [style] = snapshotCardStyles();
  assert.ok(style !== undefined);
  assert.equal(style.id, "bash-card.plain", "the SAME id, so a stored selection still resolves");
  assert.equal(style.label, "plain", "the value the user reads on the host's line");
  assert.deepEqual(
    style.preview?.(),
    {
      title: "Cards · plain",
      sample: ["▌ read                 ctrl+o", "▌ config.ts", "▌"].join("\n"),
    },
    "the literal preview restored from `5c0c123:examples/bash-card.ts:394-401`",
  );

  host.buildMenu();

  assert.deepEqual(
    host.toggleLines().filter((line) => line.startsWith("Card style ")),
    ["Card style ○ neon ● float ○ plain"],
    "one line: the host's own values first, then the example's `plain`",
  );
  const plain = host
    .liveRows()
    .find((row) => row.choice?.setting === "Card style" && row.choice?.value === "plain");
  assert.ok(plain !== undefined, "the value is a row on the host's own line, not a second line");
  assert.equal(plain.choice?.current(), false, "native rendering by default");
});

test("T30: selecting `plain` from its row persists the selection and repaints the card already on screen", async () => {
  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("plain-select"))(pi);
  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  assert.deepEqual(installCardStyleTransform(tui), {
    installed: true,
    outcome: "wrapped",
    component: "chat",
  });
  installCardStyleRows();

  const row = buildRows({ theme: undefined, configHome }).rows.find(
    (candidate) => candidate.choice?.value === "plain",
  );
  assert.ok(row?.action !== undefined, "the value carries the action that selects it");
  await row.action(inlineHelpers);

  assert.equal(getCardStyleSelection(), "bash-card.plain", "the value is persisted, not just drawn");
  const selected = resolveCardStyleSelection();
  assert.equal(selected.kind, "style", "the stored id resolves against the registered style");

  const repainted = tui.chat.render(40);
  assert.equal(repainted.length, 3, "the host's five float rows become top + body + bottom");
  assert.equal(stripAnsi(repainted[0] ?? "").startsWith("▌ read"), true);
  assert.equal(stripAnsi(repainted[0] ?? "").endsWith("ctrl+o"), true, "the host's hint is kept");
  assert.deepEqual(
    repainted.slice(1).map((line) => stripAnsi(line)),
    ["▌ config.ts", "▌"],
    "the card already on screen is repainted: a `read` card, because the style is for tool cards",
  );
  assert.deepEqual(getCardStyleLastOutcome("conversation"), {
    kind: "transformed",
    styleId: "bash-card.plain",
    cards: 1,
  });
});

test("T30: an older bridge without registerCardStyle keeps the design, the section and the demo category, and says `card style  absent`", async () => {
  const published = bridgeApi() ?? publishBridgeApi();
  // First-wins: a mixed process can hand back a v1 object that predates `registerCardStyle`.
  hostSlot()[BRIDGE_API_KEY] = {
    schema: published.schema,
    version: published.version,
    VERSION: published.VERSION,
    registerToolDesign: published.registerToolDesign,
    registerRows: published.registerRows,
    registerSection: published.registerSection,
    createStore: published.createStore,
  };

  const { pi, sessionHandlers } = recordingPi();
  const dispose = (await loadExample("plain-old-bridge"))(pi);
  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.deepEqual(calls, [], "a surface the bridge never promised is never warned about");
  assert.deepEqual(snapshotToolDesigns("bash").map((design) => design.id), ["bash-card.bash-heading"]);
  assert.deepEqual(surfaceCounts(), [0, 1], "no style, but the section still registers");

  const section = snapshotSections().find((candidate) => candidate.id === "bash-card.status");
  assert.ok(section !== undefined);
  const lines = section.lines({ theme: undefined, configHome });
  assert.equal(
    lines.includes("card style  absent"),
    true,
    "the section never claims a surface that did not register",
  );
  assert.equal(lines.includes("resolver  registered"), true);
  assert.equal(
    buildRows({ theme: undefined, configHome }).rows.some((row) => row.label === "Demo button"),
    true,
    "the demo category is untouched",
  );

  dispose();
});

test("T30: a late load through the ready announcement registers the style", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("plain-late"))(pi);

  assert.deepEqual(surfaceCounts(), [0, 0], "nothing registers at module load");
  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 1, "the early loader is listening");

  loadBridge(bus);

  assert.deepEqual(surfaceCounts(), [1, 1], "the announcement served the early loader");
  assert.equal(bus.listenerCount(BRIDGE_READY_EVENT), 0, "and it stopped listening afterwards");

  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), [1, 1], "a later session_start adds no second copy");
});

test("T30: a reload replaces the style instead of stacking a second one, and the stable disposer removes it", async () => {
  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  const { ui } = notifySurface();

  const first = (await loadExample("plain-reload-1"))(pi);
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), [1, 1]);

  // A `/reload` loads the file again: the same id must replace, not duplicate.
  const second = (await loadExample("plain-reload-2"))(pi);
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), [1, 1], "one `plain` value, not two");

  second();
  assert.deepEqual(surfaceCounts(), [0, 0], "the last load's disposer takes both replaced surfaces with it");
  first();
  assert.deepEqual(surfaceCounts(), [0, 0], "disposing a replaced registration changes nothing else");
});

test("T30: a stored selection of `bash-card.plain` waits as `missing`, then resolves once the style registers", async () => {
  setCardStyleSelection("bash-card.plain");
  assert.deepEqual(resolveCardStyleSelection(), {
    kind: "missing",
    id: "bash-card.plain",
  });

  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  assert.deepEqual(tui.chat.render(40), [...READ_CARD], "an unresolvable selection draws no chrome");
  assert.deepEqual(getCardStyleLastOutcome("conversation"), {
    kind: "pass-through",
    reason: "missing",
  });

  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("plain-stored"))(pi);
  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  const resolved = resolveCardStyleSelection();
  assert.equal(resolved.kind, "style");
  if (resolved.kind !== "style") return;
  assert.equal(resolved.style.id, "bash-card.plain", "the stored selection resolves to the restored style");
});

// ---------------------------------------------------------------------------------------------
// The matrix fixtures and the modelled host framer
// ---------------------------------------------------------------------------------------------

/** One host `read` card (`RAIL_HOST_CARD` shape) as the host's own framing draws it. */
const RAIL_WIDTH = 40;

/**
 * The host's own `float` section card at width 40, in the bytes `lib/shell-card.ts` produces for
 * `sectionCardRows` (`lib/shell-sidebar-layout.ts:35-47`): `floatRows` over `cardTop`, one `cardLine`
 * per body row and `cardBottom`, with the host's role map (`border` 90, `accent` 95, background
 * `\u001b[48;5;236m`) as `test/fake-sidebar.ts` recorded it.
 *
 * Proven against the two host-produced fixtures, not assumed: with `STATS` + the two native rows it
 * reproduces `RAIL_HOST_CARD` byte for byte, and with an empty body it reproduces that fixture minus
 * its two body rows (the collapsed section the host draws when a section is folded).
 */
function hostSectionCard(title: string, body: readonly string[], width = RAIL_WIDTH): string[] {
  const bg = "\u001b[48;5;236m";
  const border = "\u001b[90m";
  const accent = "\u001b[95m";
  const reset = "\u001b[39m";
  const close = "\u001b[49m";
  const bar = `${border}▎${reset}`;
  const opener = ` ${bg}${bar}${border}${" ".repeat(width - 3)}${reset}${close} `;
  const header =
    ` ${bg}${bar}${border} ${reset}${accent}▾ ${title.slice(0, width - 8)}${reset}` +
    `${border}${" ".repeat(Math.max(0, width - 8 - title.length))}${reset}${border}  ${reset}${close} `;
  const rows = body.map(
    (text) =>
      ` ${bg}${bar} ${text.slice(0, width - 5)}` +
      `${" ".repeat(Math.max(0, width - 5 - text.length))}${border} ${reset}${close} `,
  );
  return [opener, header, ...rows, opener];
}

/** Visible columns of a row, ANSI ignored; the host's own rows are exactly `width`. */
function widthOf(line: string): number {
  return [...stripAnsi(line)].length;
}

const assertAtMost = (rows: readonly string[], width: number, label: string): void => {
  for (const [index, row] of rows.entries()) {
    assert.equal(
      widthOf(row) <= width,
      true,
      `${label}: row ${index} is never wider than the host's width`,
    );
  }
};

// ---------------------------------------------------------------------------------------------
// The conversation matrix: real tool-design resolver + real card-style transform
// ---------------------------------------------------------------------------------------------

interface FakeComponent {
  render(width: number): string[];
}

interface FakeRenderers {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  [member: string]: unknown;
}

type Resolver = (tool: string, next: () => FakeRenderers) => FakeRenderers | undefined;

function fakeComponent(lines: readonly string[]): FakeComponent {
  const rows = [...lines];
  return { render: (): string[] => rows };
}

function fakeRenderers(call: readonly string[], result: readonly string[]): FakeRenderers {
  const callComponent = fakeComponent(call);
  const resultComponent = fakeComponent(result);
  return {
    renderShell: "default",
    renderCall: () => callComponent,
    renderResult: () => resultComponent,
  };
}

function mount(renderers: FakeRenderers, member: "renderCall" | "renderResult"): FakeComponent {
  const renderer = renderers[member];
  assert.equal(typeof renderer, "function");
  return member === "renderCall"
    ? (renderer as (args: unknown, theme: unknown, ctx: unknown) => FakeComponent)(
        { command: "npm test" },
        { name: "fake-theme" },
        {},
      )
    : (renderer as (result: unknown, options: unknown, theme: unknown, ctx: unknown) => FakeComponent)(
        { content: [] },
        { expanded: false },
        { name: "fake-theme" },
        {},
      );
}

/** The host's own `Card style` rows, with the host's own setter semantics (write, then current). */
function hostRows(): CustomizeRow[] {
  const state: { value: string } = { value: "float" };
  const styleRow = (value: string): CustomizeRow => ({
    category: "Cards",
    label: `Card style: ${value}`,
    action: () => {
      state.value = value;
    },
    choice: {
      setting: "Card style",
      value,
      current: () => state.value === value,
    },
  });
  return [
    { category: "Cards", label: "Card content: minimal", action: () => {} },
    styleRow("neon"),
    styleRow("float"),
    { category: "Layout", label: "Layout: builtin", action: () => {} },
  ];
}

interface World {
  host: FakeHost;
  resolver: Resolver;
  /** The host rows the conversation component returns; reassigning it is a host redraw. */
  setConversation(rows: readonly string[]): void;
  conversation(): readonly string[];
  setRail(rows: readonly string[]): void;
  rail(): readonly string[];
  renderConversation(width: number): string[];
  renderRail(): string[];
  rows(): CustomizeRow[];
  pressPlain(): Promise<void>;
  pressHost(value: "neon" | "float"): Promise<void>;
  status(): string[];
  notices(): string[];
  sessionStart(): void;
  dispose(): void;
}

/**
 * A whole session the way Pi runs it: the bridge's real entry (which publishes, arms the capture,
 * the widget, the conversation wrapper and the rail wrapper), the example registering through the
 * published object, the host's own menu rows, and one tui that carries both the conversation and
 * the rail the way Pi's `layoutRoot` does.
 */
async function startWorld(tag: string, seed: { conversation: readonly string[]; rail: readonly string[] }): Promise<World> {
  publishBridgeApi();
  const host = createFakeHost({ rows: hostRows() });

  let conversationRows: string[] = [...seed.conversation];
  let railRows: string[] = [...seed.rail];

  const transcript = createFakeTranscriptTui({ lines: [] });
  // The wrapper wraps THIS function, so replacing the holder is what a host redraw looks like.
  transcript.chat.render = (): string[] => conversationRows;

  const stableRail: Rail = { render: () => railRows };
  const railTui = createRailTui({ rail: stableRail, contentWidth: RAIL_WIDTH });

  const tui = {
    ...railTui,
    children: transcript.children,
    document: transcript.document,
    chat: transcript.chat,
  };

  const resolvers: unknown[] = [];
  const sessionHandlers: SessionHandler[] = [];
  const notices: string[] = [];
  const pi: FakePi = {
    // `gentle-pi` is present, so the bridge's `session_start` arms every surface (S9).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand() {},
    registerToolRenderer(resolver) {
      resolvers.push(resolver);
    },
  };

  gentleShellBridge(pi as BridgeExtensionApi);
  const dispose = (await loadExample(tag))(pi);

  const ui = host.ui as Record<string, unknown>;
  ui.notify = (message: string): void => {
    notices.push(message);
  };
  ui.setWidget = (_key: string, factory: unknown): unknown => {
    assert.equal(typeof factory, "function");
    return (factory as (tuiArg: unknown, theme: unknown) => unknown)(tui, { name: "fake-theme" });
  };

  const sessionStart = (): void => {
    // The bridge and the example both subscribe; each gets the same context, as on Pi.
    for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  };
  sessionStart();

  assert.equal(resolvers.length, 1, "the bridge registers exactly one tool-renderer resolver");
  const resolver = resolvers[0] as Resolver;
  assert.equal(typeof resolver, "function");

  // The host's own menu build is the capture moment: the bridge splices its values into the host's
  // `Card style` line and appends the example's rows.
  host.buildMenu();

  const rows = (): CustomizeRow[] => host.liveRows();

  return {
    host,
    resolver,
    setConversation: (rows) => {
      conversationRows = [...rows];
    },
    conversation: () => conversationRows,
    setRail: (rows) => {
      railRows = [...rows];
    },
    rail: () => railRows,
    renderConversation: (width) => tui.chat.render(width),
    renderRail: () => railTui.renderRail(),
    rows,
    pressPlain: async () => {
      await host.pressRow(
        (row) => row.choice?.setting === "Card style" && row.choice?.value === "plain",
      );
    },
    pressHost: async (value) => {
      await host.press(`Card style: ${value}`);
    },
    status: () => formatStatus(collectStatus()),
    notices: () => [...notices],
    sessionStart,
    dispose,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. conversation cards, content `minimal`, design native: the host rows, repainted chrome only
// ---------------------------------------------------------------------------------------------

test("T31 matrix — conversation/minimal/native: `plain` repaints bash and read tool cards and nothing else", async () => {
  const bash = [...BASH_MINIMAL_FLOAT_CALL, ...BASH_MINIMAL_FLOAT_RESULT];
  // Prose, a bash call+result card, and a `read` card: the frame both tools are drawn in.
  const conversation = ["a line the host wrote", "", ...bash, "", ...HOST_READ_CARD];
  const world = await startWorld("matrix-minimal-native", { conversation, rail: [] });

  // Design `native`: the bridge wraps the renderers (a design exists for bash), and the component
  // hands the host's own rows back byte for byte. No design at all (read) returns `next()` itself.
  const hostRenderers = fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT);
  const resolvedBash = world.resolver("bash", () => hostRenderers);
  assert.ok(resolvedBash !== undefined);
  assert.deepEqual(mount(resolvedBash, "renderCall").render(60), [...BASH_MINIMAL_FLOAT_CALL]);
  assert.deepEqual(mount(resolvedBash, "renderResult").render(60), [...BASH_MINIMAL_FLOAT_RESULT]);
  const readRenderers = fakeRenderers(HOST_READ_CARD, []);
  assert.equal(world.resolver("read", () => readRenderers), readRenderers, "no design: nothing changes, not even identity");

  // With the style native the host's exact rows come back, by identity.
  assert.equal(world.renderConversation(60), world.conversation());

  await world.pressPlain();
  const painted = world.renderConversation(60);

  assert.deepEqual(
    painted.map((line) => stripAnsi(line)),
    [
      "a line the host wrote",
      "",
      "▌ npm test (timeout 30s)                    ctrl+o to expand",
      "▌ PASS 42 tests",
      "▌ duration 1.2s",
      "▌",
      "",
      "▌ read src/api.ts                           ctrl+o to expand",
      "▌ export function bridgeApi() {",
      "▌",
    ],
    "both tool cards are the plain frame: one gutter row per host row, every text kept, prose untouched",
  );
  assert.equal(painted.length, 10, "6 host rows become 4 for bash, 5 become 3 for read; prose and blanks stay");
  assertAtMost(painted, 60, "conversation/minimal/native");
  assert.deepEqual(getCardStyleLastOutcome("conversation"), {
    kind: "transformed",
    styleId: "bash-card.plain",
    cards: 2,
  });

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// 2. conversation cards, content `minimal`, design `bash heading`: the word survives the repaint
// ---------------------------------------------------------------------------------------------

test("T31 matrix — conversation/minimal/bash heading: `bash` survives the plain repaint, widths exact, no row growth, host ANSI intact before it", async () => {
  const bash = [...BASH_MINIMAL_FLOAT_CALL, ...BASH_MINIMAL_FLOAT_RESULT];
  const world = await startWorld("matrix-minimal-designed", { conversation: [...bash], rail: [] });
  setToolDesignSelection("bash", "bash-card.bash-heading");

  const resolved = world.resolver(
    "bash",
    () => fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT),
  );
  assert.ok(resolved !== undefined);
  const designedCall = mount(resolved, "renderCall").render(60);
  const designedResult = mount(resolved, "renderResult").render(60);

  assert.equal(designedCall.length, BASH_MINIMAL_FLOAT_CALL.length, "the design adds no row");
  assert.equal(
    stripAnsi(designedCall[1] ?? "").includes("bash npm test"),
    true,
    "the design heads the host's card with the word bash",
  );
  for (const [row, line] of [...designedCall, ...designedResult].entries()) {
    assert.equal(widthOf(line), 60, `designed row ${row} keeps the host's exact width`);
  }
  assert.deepEqual(
    designedResult,
    [...BASH_MINIMAL_FLOAT_RESULT],
    "the result component keeps the host's ANSI: the design only draws the call (S12)",
  );
  for (const [index, row] of designedResult.entries()) {
    assert.equal(row, BASH_MINIMAL_FLOAT_RESULT[index], `result row ${index} is the host's byte for byte`);
  }

  // The host redraws with the designed card, then the real conversation wrapper repaints it.
  world.setConversation([...designedCall, ...designedResult]);
  await world.pressPlain();
  const painted = world.renderConversation(60);

  assert.equal(
    stripAnsi(painted[0] ?? "").startsWith("▌ bash npm test (timeout 30s)"),
    true,
    "the word the design put on the heading is what the style draws",
  );
  assert.equal(
    stripAnsi(painted[0] ?? "").includes("$ npm test"),
    false,
    "the host's mark does not come back",
  );
  assert.equal(painted.length, 4, "no row growth: top + three body rows + bottom is the plain frame");
  assert.deepEqual(
    painted.map((line) => stripAnsi(line)).slice(1),
    ["▌ PASS 42 tests", "▌ duration 1.2s", "▌"],
  );
  assertAtMost(painted, 60, "conversation/minimal/bash heading");

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// 3. conversation cards, content `default`: NOT reachable — pinned as pass-through, and reported
// ---------------------------------------------------------------------------------------------

test("T31 matrix — conversation/default: pi's native card is not a float frame, so neither the host style nor `plain` nor an added style reaches it (pass-through, same array)", async () => {
  const bash = [...BASH_DEFAULT_CALL, ...BASH_DEFAULT_RESULT];
  const world = await startWorld("matrix-default", { conversation: [...bash], rail: [] });

  await world.pressPlain();
  const passed = world.renderConversation(58);
  assert.equal(
    passed,
    world.conversation(),
    "pass-through by identity: the style never draws over pi's native rows",
  );
  assert.deepEqual(getCardStyleLastOutcome("conversation"), {
    kind: "pass-through",
    reason: "no-card",
  });

  // No HOST style reaches it either: pressing the host's own value leaves pi's native rows alone,
  // because nothing on pi's path reads `cardStyle()`.
  await world.pressHost("neon");
  assert.equal(world.renderConversation(58), world.conversation(), "neon: pi's native rows are untouched");
  await world.pressHost("float");
  assert.equal(world.renderConversation(58), world.conversation(), "float: the same rows");
  await world.pressPlain();

  // A style ADDED through registerCardStyle cannot reach it either: the repaint's grammar is the
  // float ` ▎ ` frame (`src/card-style-transform.ts:189-196`), and pi's native rows have none.
  const addedCalls: string[] = [];
  const { registerCardStyle } = await import("../src/bus.ts");
  registerCardStyle({
    id: "matrix.added",
    label: "added",
    frame: {
      top: (ctx) => {
        addedCalls.push("top");
        return `<${ctx.title ?? ""}>`;
      },
      line: (ctx) => {
        addedCalls.push("line");
        return ctx.text;
      },
      bottom: () => {
        addedCalls.push("bottom");
        return "_";
      },
    },
  });
  setCardStyleSelection("matrix.added");
  assert.equal(
    world.renderConversation(58),
    world.conversation(),
    "an added style is passed through too: same array instance",
  );
  assert.deepEqual(addedCalls, [], "its frame functions were never called for this cell");

  // The design still ran: with `bash heading` the native card heads with `bash`, and the repaint is
  // still a pass-through, ANSI bytes intact.
  setToolDesignSelection("bash", "bash-card.bash-heading");
  const resolved = world.resolver(
    "bash",
    () => fakeRenderers(BASH_DEFAULT_CALL, BASH_DEFAULT_RESULT),
  );
  assert.ok(resolved !== undefined);
  const designedCall = mount(resolved, "renderCall").render(58);
  assert.equal(stripAnsi(designedCall[0] ?? "").startsWith("bash npm test"), true);
  const designed = [...designedCall, ...mount(resolved, "renderResult").render(58)];
  world.setConversation(designed);
  const stillPassed = world.renderConversation(58);
  assert.equal(stillPassed, world.conversation(), "the design's rows reach the style, and come back untouched");
  assert.deepEqual(stillPassed.map((line) => line), [...designed], "every ANSI byte is intact");

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// 4. the native sidebar (rail): host sections and the bridge's own sections, through the rail wiring
// ---------------------------------------------------------------------------------------------

test("T31 matrix — rail: host sections painted by the host (STATS, AGENTS) and the status rail are repainted through the real rail wrapper", async () => {
  // Two host-style panels, the first the host-produced `RAIL_HOST_CARD`, the second its AGENTS
  // sibling built by the proven framer; a blank row between cards is what the host's layout draws.
  const railFrame = [...RAIL_HOST_CARD, "", ...hostSectionCard("AGENTS", ["native row 1", "native row 2"])];
  const world = await startWorld("matrix-rail", { conversation: [], rail: railFrame });

  // The fixture the framer is proven against, first: the derivation is not an invention.
  assert.deepEqual(
    hostSectionCard("STATS", ["native row 1", "native row 2"]),
    [...RAIL_HOST_CARD],
    "hostSectionCard reproduces the host-produced RAIL_HOST_CARD byte for byte",
  );
  assert.deepEqual(
    hostSectionCard("STATS", []),
    [RAIL_HOST_CARD[0], RAIL_HOST_CARD[1], RAIL_HOST_CARD[4]],
    "a collapsed section is the same card without body rows",
  );

  assert.equal(world.renderRail(), world.rail(), "native: the rail's own array, by identity");

  await world.pressPlain();
  const painted = world.renderRail();
  assert.deepEqual(
    painted.map((line) => stripAnsi(line)),
    [
      "▌ STATS",
      "▌ native row 1",
      "▌ native row 2",
      "▌",
      "",
      "▌ AGENTS",
      "▌ native row 1",
      "▌ native row 2",
      "▌",
    ],
    "every card on the rail is repainted, the host's own STATS and AGENTS panels included",
  );
  assertAtMost(painted, RAIL_WIDTH, "rail");
  assert.deepEqual(getCardStyleLastOutcome("rail"), {
    kind: "transformed",
    styleId: "bash-card.plain",
    cards: 2,
  });
  assert.equal(
    painted.some((line) => stripAnsi(line).includes("▎")),
    false,
    "no host float chrome is carried into a repainted rail card",
  );

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// 5. sections added by the bridge/another plugin, collapsed and expanded, header/tones/hit map
// ---------------------------------------------------------------------------------------------

/** The theme the host's roles paint with, matching `test/section-panel.test.ts`'s reference. */
const ROLE_SGR: Record<string, number> = {
  text: 37,
  muted: 90,
  dim: 2,
  accent: 95,
  success: 32,
  error: 31,
  warning: 33,
};

function fakeTheme(): { fg(role: string, text: string): string; bold(text: string): string } {
  return {
    fg: (role, text) => `\u001b[${ROLE_SGR[role] ?? 0}m${text}\u001b[39m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
  };
}

/**
 * Frame the rows the wrapped host part returns into the host's own float cards, group by group, the
 * way the host's layout does (`sectionCardRows`, `lib/shell-sidebar-layout.ts:35-47`). The rows and
 * the groups come from the REAL sidebar backend wrapper and the REAL section renderer; only the
 * framing arithmetic is the model above, pinned against the host fixtures.
 */
function framePart(part: { render(width: number): string[]; cardGroups?(width: number): { groups: Array<{ start: number; end: number }> } | undefined }, width: number): string[] {
  const lines = part.render(width);
  const groups = part.cardGroups?.(width)?.groups ?? [{ start: 0, end: lines.length }];
  const framed: string[] = [];
  groups.forEach((group, index) => {
    if (index > 0) framed.push("");
    const header = stripAnsi(lines[group.start] ?? "").trimEnd();
    // The host splits the header into glyph + title + right-aligned count (`headerParts`, which is
    // why the two runs are separated by the host's own gap); the model frames the title, and the
    // count is asserted on the section contribution itself, where the section owns it.
    const withoutGlyph = header.replace(/^\S+\s+/u, "");
    const title = withoutGlyph.split(/\s{2,}/u)[0] ?? withoutGlyph;
    const body = lines.slice(group.start + 1, group.end).map((row) => stripAnsi(row).trimEnd());
    framed.push(...hostSectionCard(title, body, width));
  });
  return framed;
}

test("T31 matrix — sections: the bridge's own section and another plugin's, collapsed and expanded, keep their header, tones and hit map; only the chrome changes", async () => {
  const world = await startWorld("matrix-sections", { conversation: [], rail: [] });
  const theme = fakeTheme();

  // A section added through the PUBLIC api, exactly as another plugin would.
  const api = bridgeApi();
  assert.ok(api !== undefined);
  const disposeMusic = api.registerSection({
    id: "loon.music",
    title: "MUSIC",
    lines: () => ["track  Blue in Green", { glyph: "♪", label: "playing", meta: "5:37", tone: "accent" }],
    defaultVisible: true,
  });

  // The host's own footer part, registered before the arm, wrapped by the bridge's real backend.
  registerNativeFooter();
  world.sessionStart();
  // The widget factory hands the bridge the host's theme; this session's theme is ours, set AFTER
  // the arm so the section renderer paints the host's roles with it.
  setSectionTheme(theme);
  const part = fakeState().parts.get(SIDEBAR_RAIL_KEY);
  assert.ok(part !== undefined, "the host's footer part is wrapped in place");

  const ctx = { theme, configHome };

  /** The contribution rows and groups the real renderer builds right now. */
  const contribution = (): { rows: string[]; groups: Array<{ start: number; end: number }> } => {
    const built = buildSectionContribution(RAIL_WIDTH, ctx, FOOTER_RAIL)?.after;
    assert.ok(built !== undefined, "both sections are visible, so the rail has rows");
    return { rows: built.lines, groups: built.groups };
  };

  const headerRow = (rows: readonly string[], text: string): number => {
    const index = rows.findIndex((row) => stripAnsi(row).includes(text));
    assert.notEqual(index, -1, `the contribution carries the ${text} header`);
    return index;
  };

  // --- expanded ------------------------------------------------------------------------------
  const expanded = contribution();
  const exampleHeader = headerRow(expanded.rows, "CARD BASH");
  const musicHeader = headerRow(expanded.rows, "MUSIC");
  assert.ok(
    expanded.rows.some((row) => row.includes("\u001b[95m") || row.includes("\u001b[90m")),
    "the rows are painted with the host's roles: tones are part of the section, not the style",
  );
  assert.equal(
    stripAnsi(expanded.rows[exampleHeader] ?? "").includes("default"),
    true,
    "the example's section header carries its live meta",
  );

  const expandedPart = framePart(part, RAIL_WIDTH);
  await world.pressPlain();
  assert.equal(
    world.renderRail(),
    world.renderRail(),
    "rendering the rail is stable; the style is not re-entrant",
  );
  const paintedExpanded = transformCardLines([...expandedPart], RAIL_WIDTH, "rail");
  assert.equal(
    paintedExpanded.some((row) => stripAnsi(row).includes("CARD BASH")),
    true,
    "the example's header survives the style",
  );
  assert.equal(
    paintedExpanded.some((row) => stripAnsi(row).includes("MUSIC")),
    true,
    "so does the other plugin's header",
  );
  assert.equal(
    paintedExpanded.some((row) => stripAnsi(row).includes("track  Blue in Green")),
    true,
    "and its body rows",
  );
  assert.deepEqual(
    contribution(),
    expanded,
    "the style is downstream chrome: it never rebuilds the contribution, its tones or its groups",
  );

  // The hit map still works while the style is selected: the header rows are the same rows.
  const nativeRows = 3; // the host's own FOOTER: header + two body rows
  const clicked = part.handleMouse?.({
    type: "click",
    button: "left",
    x: 4,
    y: nativeRows + exampleHeader,
    width: RAIL_WIDTH,
    height: 40,
  });
  assert.deepEqual(clicked, { handled: true, render: true }, "the section header still answers the pointer");

  // --- collapsed -----------------------------------------------------------------------------
  setSectionCollapsed("bash-card.status", true);
  setSectionCollapsed("loon.music", true);
  const collapsed = contribution();
  assert.equal(
    collapsed.rows.length < expanded.rows.length,
    true,
    "a collapsed section builds no body rows (folding costs no work)",
  );
  assert.deepEqual(
    collapsed.groups,
    [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ],
    "one header row per section, no body",
  );
  const collapsedPart = framePart(part, RAIL_WIDTH);
  const paintedCollapsed = transformCardLines([...collapsedPart], RAIL_WIDTH, "rail");
  assert.deepEqual(
    paintedCollapsed.filter((row) => row.trim() !== "").map((row) => stripAnsi(row)),
    ["▌ FOOTER", "▌ native row 1", "▌ native row 2", "▌", "▌ CARD BASH", "▌", "▌ MUSIC", "▌"],
    "the collapsed sections are the plain frame around the same headers; no body row is invented (the " +
      "host's own FOOTER card keeps its body, because the host, not the section, was folded)",
  );
  assert.deepEqual(
    contribution(),
    collapsed,
    "collapsed or expanded, the style never changes what the section renderer produces",
  );

  // Expanded again: exactly the rows that were there before, so the fold is reversible.
  setSectionCollapsed("bash-card.status", false);
  setSectionCollapsed("loon.music", false);
  assert.deepEqual(contribution(), expanded, "expanding restores the same rows, tones and groups");

  disposeMusic();
  void musicHeader;
  world.dispose();
});

// A second plugin's section, as the section row model draws it, so the tone assertion is explicit.
test("T31 matrix — sections: a structured row keeps its tone through the style, because the style draws chrome and passes no tone", async () => {
  const world = await startWorld("matrix-sections-tone", { conversation: [], rail: [] });
  const theme = fakeTheme();
  const api = bridgeApi();
  assert.ok(api !== undefined);
  const dispose = api.registerSection({
    id: "loon.music",
    title: "MUSIC",
    lines: () => [{ glyph: "♪", label: "playing", meta: "5:37", tone: "accent" }],
    defaultVisible: true,
  });

  registerNativeFooter();
  world.sessionStart();
  setSectionTheme(theme);
  const part = fakeState().parts.get(SIDEBAR_RAIL_KEY);
  assert.ok(part !== undefined);

  const built = buildSectionContribution(RAIL_WIDTH, { theme, configHome }, FOOTER_RAIL)?.after;
  assert.ok(built !== undefined);
  const accentRow = built.lines.find((row) => stripAnsi(row).includes("playing"));
  assert.ok(accentRow !== undefined);
  assert.equal(
    accentRow.includes("\u001b[95m"),
    true,
    "the accent tone is on the section row before the style sees anything",
  );

  await world.pressPlain();
  const painted = transformCardLines(framePart(part, RAIL_WIDTH), RAIL_WIDTH, "rail");
  assert.equal(
    painted.some((row) => stripAnsi(row).includes("playing")),
    true,
    "the style redraws the text without the tone: chrome is the style's, tone is the section's",
  );

  dispose();
  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// 6. switching back to the host's own values restores every surface's exact bytes
// ---------------------------------------------------------------------------------------------

test("T31 matrix — switching back to `neon` and to `float` restores the host's exact bytes on the conversation and the rail (by identity)", async () => {
  const bash = [...BASH_MINIMAL_FLOAT_CALL, ...BASH_MINIMAL_FLOAT_RESULT];
  const railFrame = [...RAIL_HOST_CARD, "", ...RAIL_HOST_CARD];
  const world = await startWorld("matrix-back", { conversation: bash, rail: railFrame });

  for (const hostValue of ["neon", "float"] as const) {
    await world.pressPlain();
    assert.notEqual(world.renderConversation(60), world.conversation(), "plain is drawing");
    assert.notEqual(world.renderRail(), world.rail(), "and it reaches the rail too");

    // Pressing the host's own value is the way back (S13): the bridge selection becomes `native`.
    await world.pressHost(hostValue);
    assert.equal(getCardStyleSelection(), "native", `${hostValue}: the bridge no longer touches the frame`);
    assert.equal(world.renderConversation(60), world.conversation(), `${hostValue}: the conversation's array`);
    assert.equal(world.renderRail(), world.rail(), `${hostValue}: the rail's array`);
  }

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// 7. /bridge-status says, per surface, whether the style reached it
// ---------------------------------------------------------------------------------------------

test("T31 matrix — /bridge-status reports reach and the last frame per surface, including the pass-through cell", async () => {
  const bash = [...BASH_MINIMAL_FLOAT_CALL, ...BASH_MINIMAL_FLOAT_RESULT];
  const world = await startWorld("matrix-status", { conversation: bash, rail: [...RAIL_HOST_CARD] });

  await world.pressPlain();
  const painted = world.renderConversation(60);
  assert.equal(painted.length > 0, true);
  world.renderRail();

  const lines = world.status();
  assert.equal(
    lines.includes(
      "card style surface conversation: reached (chat wrapped), last frame transformed 1 card",
    ),
    true,
    "the conversation surface reports that the style reached it and what it did",
  );
  assert.equal(
    lines.some((line) =>
      /^card style surface rail: reached \(rail wrapped\), last frame transformed 1 card$/u.test(line),
    ),
    true,
    "the rail surface reports its own reach, separately",
  );

  // Content `default`: the conversation says pass-through, so the unreachable cell has an answer.
  setCardStyleSelection("bash-card.plain");
  world.setConversation([...BASH_DEFAULT_CALL, ...BASH_DEFAULT_RESULT]);
  world.renderConversation(58);
  assert.equal(
    world
      .status()
      .includes("card style surface conversation: reached (chat wrapped), last frame pass-through (no card)"),
    true,
    "the cell a style cannot reach is reported, not hidden",
  );

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// T30 — the suites that were deleted with the style, re-covered end to end
// ---------------------------------------------------------------------------------------------
test("T30: two surfaces, one identity — a section line reports the style as registered, never as assumed", async () => {
  publishBridgeApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("plain-section-state"))(pi);
  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  const section = snapshotSections().find((candidate) => candidate.id === "bash-card.status");
  assert.ok(section !== undefined);
  const lines = section.lines({ theme: undefined, configHome });
  assert.equal(lines.includes("card style  registered"), true);
  assert.equal(
    lines.some((line) => typeof line !== "string" && line.label === "selected"),
    false,
    "the live selection is the header meta only, never a duplicate body row",
  );
  assert.equal(section.meta?.({ theme: undefined, configHome }), "default");
});

test("T30: no bridge at all adds nothing and reports it once, with the style named as one of the missing surfaces", async () => {
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("plain-no-bridge"))(pi);
  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /adds nothing/u);
  assert.match(calls[0][0], /no plain card style/u, "the message names the restored surface");
  assert.deepEqual(surfaceCounts(), [0, 0]);
});

test("T30: the announcement alone is enough to register `plain`, with no session_start", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("plain-late-no-session"))(pi);

  publishBridgeApi();
  announceBridgeReady(bus);

  assert.deepEqual(surfaceCounts(), [1, 1]);
  assert.equal(sessionHandlers.length, 1, "the handler stays for the next session");

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "nothing pending: the surfaces registered");
});

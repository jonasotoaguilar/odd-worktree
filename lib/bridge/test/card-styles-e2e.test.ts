/**
 * End to end over the public surface (S8, S11, S12): a plugin's whole world.
 *
 * Nothing here imports a backend. Styles are registered through `bridgeApi().registerCardStyle`,
 * the host's menu is the fake host the earlier suites use, the "conversation" is the fake transcript
 * the T1 fixtures pin, and the only bridge internals read are teardown seams plus the diagnostics
 * `/bridge-status` itself prints — the same shape `test/e2e.test.ts` uses for rows and sections.
 *
 * What a plugin cannot see, and therefore what this suite proves by construction: the splice into the
 * host's line, the wrapping of `current()`/`action()`, the transform wrapper and the status block are
 * all invisible to it. It calls one function and a user clicks.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The public surface, exactly as a plugin reaches it.
import {
  bridgeApi,
  registerRows,
  type BridgeApi,
  type CardStyleRegistration,
  type RowProvider,
} from "../src/index.ts";
import gentleShellBridge, {
  type BridgeCommandHandler,
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
// Teardown-only seams; the API-surface test proves they are not public.
import {
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotProviders,
} from "../src/bus.ts";
import { resetCardStyleRowStateForTests } from "../src/card-style-rows.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  getCardStyleWiringDiagnostics,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { createFakeHost, type FakeHost, type FakeRow } from "./fake-host.ts";
import { READ_CARD, createFakeTranscriptTui, type FakeTui } from "./fake-transcript.ts";

const FALLBACK_SETTING = "Bridge card style";
const HOST_SETTING = "Card style";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-cards-e2e-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

/** `native` before the first test, and between tests: the selection is a real file. */
const resetSelection = (): void => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
};

test.beforeEach(() => {
  resetSelection();
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleRowStateForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  disableCardStyleTransform();
  disableSidebarBackend();
});

// ---------------------------------------------------------------------------------------------
// The harness: one `ctx.ui` that is both a customize host and a widget host, as Pi's is.
// ---------------------------------------------------------------------------------------------

interface Entry {
  sessionHandlers: BridgeSessionHandler[];
  commands: Array<{ name: string; description?: string; handler: BridgeCommandHandler }>;
}

/** Load the real entry against a recording API, as Pi would. */
const loadEntry = (): Entry => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const commands: Entry["commands"] = [];
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` arms every surface (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand(name, command) {
      commands.push({ name, description: command.description, handler: command.handler });
    },
  };
  gentleShellBridge(pi);
  return { sessionHandlers, commands };
};

/**
 * One `ctx.ui` carrying the customize surface and the widget surface Pi really has.
 *
 * It augments the fake host's OWN object on purpose: the host builds its menu by calling
 * `ui.custom(...)` on that object, so a copy would leave the capture wrapper behind and the splice
 * would never see the rows. Pi has one object with both members, and so does this.
 */
const combinedUi = (host: FakeHost, tui: unknown, notices: string[]): unknown => {
  const ui = host.ui as Record<string, unknown>;
  ui.notify = (message: string) => notices.push(message);
  ui.setWidget = (_key: string, factory: (tuiArg: unknown, theme: unknown) => unknown) =>
    factory(tui, { name: "fake-theme" });
  return ui;
};

const startSession = (entry: Entry, ui: unknown): void => {
  for (const handler of entry.sessionHandlers) handler({}, { hasUI: true, ui });
};

const printStatus = (entry: Entry): string => {
  const printed: string[] = [];
  entry.commands[0].handler("", { ui: { notify: (message: string) => printed.push(message) } });
  return printed.join("\n");
};

const settingLine = (lines: readonly string[], setting: string): string | undefined =>
  lines.find((line) => line.startsWith(`${setting} `));

/** A style whose chrome is a single readable marker, with a call counter per hook. */
const markerStyle = (
  id: string,
  label: string,
  calls: string[],
  extra: Partial<CardStyleRegistration> = {},
): CardStyleRegistration => ({
  id,
  label,
  ...extra,
  frame: {
    top: (ctx) => {
      calls.push(`${id}:top`);
      return `[${label}] ${ctx.title ?? ""}${ctx.hint === undefined ? "" : ` ${ctx.hint}`}`;
    },
    line: (ctx) => {
      calls.push(`${id}:line`);
      return `<${label}> ${ctx.text}`;
    },
    bottom: () => {
      calls.push(`${id}:bottom`);
      return `[/${label}]`;
    },
  },
});

/** The host's own menu, with its `Card style` line inside `Cards`. */
const hostMenu = (): FakeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  {
    category: "Cards",
    label: () => "Card style: neon",
    action: () => {},
    choice: { setting: HOST_SETTING, value: "neon", current: () => false, hint: "How cards are drawn" },
  },
  {
    category: "Cards",
    label: () => "Card style: float",
    action: () => {},
    choice: { setting: HOST_SETTING, value: "float", current: () => true, hint: "How cards are drawn" },
  },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

interface World {
  host: FakeHost;
  tui: FakeTui;
  entry: Entry;
  notices: string[];
  /** The array the host's own conversation render returns, so identity is observable. */
  hostLines: () => readonly string[];
}

/**
 * A whole session: the host's menu, a Pi-shaped `tui`, the real entry armed through `session_start`,
 * and the conversation component cached so "the identical array" can be asserted.
 */
function startWorld(options: { rows?: FakeRow[]; tui?: FakeTui } = {}): World {
  const host = createFakeHost({ rows: options.rows ?? hostMenu() });
  const tui = options.tui ?? createFakeTranscriptTui({ lines: [...READ_CARD] });
  // Cache the host's render output and return that instance on every call: the transform wrapper
  // returns it unchanged when it does not repaint, which is exactly what S3 promises ("the same
  // array reference") and what a live host would see.
  let cached: string[] | undefined;
  const render = tui.chat.render.bind(tui.chat);
  tui.chat.render = (width: number): string[] => (cached ??= render(width));
  const notices: string[] = [];
  const ui = combinedUi(host, tui, notices);
  const entry = loadEntry();
  startSession(entry, ui);
  host.buildMenu();
  return { host, tui, entry, notices, hostLines: () => cached ?? [] };
}

const api = (): BridgeApi => {
  const published = bridgeApi();
  assert.ok(published !== undefined, "the bridge is loaded, so its API object is present");
  return published;
};

/**
 * Register a style exactly as a plugin does. `registerCardStyle` is optional on the published object
 * because the slot is first-wins (an older copy could own it), so the plugin's own gate is here too.
 */
const registerStyle = (style: CardStyleRegistration): (() => void) => {
  const register = api().registerCardStyle;
  assert.ok(typeof register === "function", "this release publishes registerCardStyle");
  return register(style);
};

// ---------------------------------------------------------------------------------------------
// 1. Many plugins, one line
// ---------------------------------------------------------------------------------------------

test("three plugins, three styles: the host's line shows all of them, once", () => {
  const calls: string[] = [];
  const dismiss = [
    registerStyle(markerStyle("loon.loud", "loud", calls, { order: 20 })),
    registerStyle(markerStyle("pix.mono", "mono", calls, { order: 10 })),
    registerStyle(markerStyle("zephyr.wave", "wave", calls)),
  ];
  const world = startWorld();

  assert.equal(
    settingLine(world.host.toggleLines(), HOST_SETTING),
    "Card style ○ neon ● float ○ mono ○ loud ○ wave",
    "the host's values first, then every registered style in the documented order",
  );
  assert.equal(
    settingLine(world.host.toggleLines(), FALLBACK_SETTING),
    undefined,
    "one line: the bridge never contributes a second one while the host's is reachable",
  );
  assert.match(printStatus(world.entry), /^duplicate settings: none$/m);
  for (const dispose of dismiss) dispose();
});

// ---------------------------------------------------------------------------------------------
// 2. Each style draws, one at a time
// ---------------------------------------------------------------------------------------------

test("selecting each style in turn repaints with that style only", async () => {
  const calls: string[] = [];
  for (const [id, label, order] of [
    ["loon.loud", "loud", 20],
    ["pix.mono", "mono", 10],
    ["zephyr.wave", "wave", undefined],
  ] as const) {
    registerStyle(markerStyle(id, label, calls, order === undefined ? {} : { order }));
  }
  const world = startWorld();

  const select = async (label: string): Promise<void> => {
    await world.host.pressRow(
      (row) => row.choice?.setting === HOST_SETTING && row.choice?.value === label,
    );
  };

  const expected: Record<string, string[]> = {
    mono: ["[mono] read ctrl+o", "<mono> config.ts", "[/mono]"],
    loud: ["[loud] read ctrl+o", "<loud> config.ts", "[/loud]"],
    wave: ["[wave] read ctrl+o", "<wave> config.ts", "[/wave]"],
  };

  for (const [label, lines] of Object.entries(expected)) {
    await select(label);
    const rendered = world.tui.chat.render(40);
    const drawn = new Set(calls.splice(0).map((call) => call.split(":")[0]));

    assert.deepEqual(rendered, lines, `${label} drew the card`);
    assert.deepEqual([...drawn], [`${label === "mono" ? "pix" : label === "loud" ? "loon" : "zephyr"}.${label}`]);
  }
});

// ---------------------------------------------------------------------------------------------
// 3. A throwing style loses its frame and nothing else
// ---------------------------------------------------------------------------------------------

test("a throwing style passes the frame through, is reported, and the others keep working", async () => {
  const calls: string[] = [];
  registerStyle(markerStyle("pix.mono", "mono", calls));
  registerStyle({
    id: "loon.broken",
    label: "broken",
    frame: {
      top: () => {
        throw new Error("broken top");
      },
      line: (ctx) => ctx.text,
      bottom: () => "-",
    },
  });
  const world = startWorld();
  const select = (value: string) =>
    world.host.pressRow((row) => row.choice?.setting === HOST_SETTING && row.choice?.value === value);

  await select("broken");
  const frame = [...READ_CARD];
  assert.deepEqual(world.tui.chat.render(40), frame, "the frame is the host's, unchanged");

  const status = printStatus(world.entry);
  assert.match(status, /^card style frame: failed \(loon\.broken: broken top\)$/m);
  assert.match(status, /^card style failures: 1$/m);

  await select("mono");
  assert.deepEqual(world.tui.chat.render(40), ["[mono] read ctrl+o", "<mono> config.ts", "[/mono]"]);
});

// ---------------------------------------------------------------------------------------------
// 4. The way back to host rendering (S13)
// ---------------------------------------------------------------------------------------------

test("pressing a host value returns to host rendering, and the next frame is the identical array", async () => {
  const calls: string[] = [];
  registerStyle(markerStyle("pix.mono", "mono", calls));
  const world = startWorld();
  world.tui.chat.render(40); // prime the host's own frame, with nothing selected yet
  const hostFrame = world.hostLines();

  await world.host.pressRow(
    (row) => row.choice?.setting === HOST_SETTING && row.choice?.value === "mono",
  );
  assert.deepEqual(world.tui.chat.render(40), ["[mono] read ctrl+o", "<mono> config.ts", "[/mono]"]);

  await world.host.press("Card style: float");

  assert.equal(
    settingLine(world.host.toggleLines(), HOST_SETTING),
    "Card style ○ neon ● float ○ mono",
    "one bullet, on the host's own value",
  );
  const restored = world.tui.chat.render(40);
  assert.equal(restored, hostFrame, "the identical array the host produced (S3)");
  assert.match(printStatus(world.entry), /^card style frame: pass-through \(native\)$/m);
});

// ---------------------------------------------------------------------------------------------
// 5. A disposed style degrades to native
// ---------------------------------------------------------------------------------------------

test("disposing the selected style degrades to native, is reported, and the row drops the value", async () => {
  const calls: string[] = [];
  const dispose = registerStyle(markerStyle("pix.mono", "mono", calls));
  const world = startWorld();
  await world.host.pressRow(
    (row) => row.choice?.setting === HOST_SETTING && row.choice?.value === "mono",
  );
  assert.deepEqual(world.tui.chat.render(40), ["[mono] read ctrl+o", "<mono> config.ts", "[/mono]"]);

  dispose();

  const after = world.tui.chat.render(40);
  assert.deepEqual(after, [...world.hostLines()], "no chrome for a style that no longer exists");
  const status = printStatus(world.entry);
  assert.match(status, /^card style selection: pix\.mono \(missing: not registered\)$/m);
  assert.match(status, /^card style frame: pass-through \(missing: a disposed style\)$/m);

  // The next menu build is a new rows array, as a real host builds one per open.
  const reopened = startWorld();
  assert.equal(
    reopened.host
      .liveRows()
      .some((row) => row.choice?.setting === HOST_SETTING && row.choice?.value === "mono"),
    false,
    "the value is gone from the line",
  );
});

// ---------------------------------------------------------------------------------------------
// 5b. A host without its own line gets the bridge's fallback line
// ---------------------------------------------------------------------------------------------

test("a host without its own Card style line gets the fallback line, and it selects styles", async () => {
  const calls: string[] = [];
  registerStyle(markerStyle("pix.mono", "mono", calls));
  const world = startWorld({
    rows: [
      { category: "Cards", label: "Card bash: builtin", action: () => {} },
      { category: "Cards", label: "Card output: builtin", action: () => {} },
      { category: "Layout", label: "Layout: builtin", action: () => {} },
    ],
  });

  assert.equal(
    settingLine(world.host.toggleLines(), FALLBACK_SETTING),
    "Bridge card style ● native ○ mono",
    "one line, native by default plus every registered style",
  );
  assert.equal(settingLine(world.host.toggleLines(), HOST_SETTING), undefined);

  await world.host.pressRow(
    (row) => row.choice?.setting === FALLBACK_SETTING && row.choice?.value === "mono",
  );
  assert.deepEqual(world.tui.chat.render(40), ["[mono] read ctrl+o", "<mono> config.ts", "[/mono]"]);

  await world.host.pressRow(
    (row) => row.choice?.setting === FALLBACK_SETTING && row.choice?.value === "native",
  );
  assert.equal(
    world.tui.chat.render(40),
    world.hostLines(),
    "native is the pass-through, by identity again",
  );
  assert.match(printStatus(world.entry), /^card style frame: pass-through \(native\)$/m);
});

// ---------------------------------------------------------------------------------------------
// 6. Two session starts
// ---------------------------------------------------------------------------------------------

test("two session_start events never double-wrap the conversation", () => {
  const world = startWorld();

  startSession(world.entry, combinedUi(world.host, world.tui, world.notices));

  assert.equal(getCardStyleWiringDiagnostics().wrapped, 1, "one conversation component, one wrapper");
  assert.equal(getCardStyleWiringDiagnostics().lastOutcome, "already-wrapped");
});

// ---------------------------------------------------------------------------------------------
// 7. A Pi-shaped tui without a conversation
// ---------------------------------------------------------------------------------------------

test("a tui without a conversation is reported, and rows and sections still work", () => {
  const notices: string[] = [];
  const host = createFakeHost();
  // Pi-shaped, but its document has no third child: the shape the bridge refuses to guess about.
  const brokenTui = { terminal: {}, children: [{ children: [{ render: () => [] }, { render: () => [] }] }] };
  const ui = combinedUi(host, brokenTui, notices);
  const entry = loadEntry();
  const sectionDispose = api().registerSection({
    id: "loon.music",
    title: "MUSIC",
    lines: () => ["track  Blue in Green"],
  });
  const provider: RowProvider = {
    id: "loon.banner-source",
    category: "Banner",
    rows: () => [{ label: "Loon banner source", action: () => {} }],
  };
  registerRows(provider);

  startSession(entry, ui);
  host.buildMenu();

  assert.match(printStatus(entry), /^card style wiring: not wrapped \(no-conversation\)$/m);
  assert.deepEqual(
    host.rendered().filter((label) => label.startsWith("Loon banner source")),
    ["Loon banner source"],
    "the row provider reached the menu",
  );
  assert.ok(
    host.toggleLines().some((line) => line.startsWith("music ")),
    "and the section toggle is there too",
  );
  assert.ok(snapshotProviders().some((registered) => registered.id === "loon.banner-source"));
  sectionDispose();
});

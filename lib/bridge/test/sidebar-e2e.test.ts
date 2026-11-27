/**
 * End-to-end over the PUBLIC API (S9, S12, S13).
 *
 * Everything a plugin may touch is imported from `src/index.ts`; the only other non-test import is
 * the Pi entry Pi itself loads (`src/extension.ts`). Internal seams appear here for teardown only,
 * exactly as `test/e2e.test.ts` uses them, and the API-surface test proves they are not public.
 *
 * The host is the fake: a menu host for the `Sections` rows and the fake sidebar for the rail. So
 * these tests prove the wiring, the ordering and the shared state — not the real TUI, which is
 * listed as unverified in PRD.md and README.md.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The public surface, exactly as a plugin reaches it.
import {
  VERSION,
  registerRows,
  registerSection,
  type CustomizeRow,
  type RowProvider,
  type SidebarSection,
} from "../src/index.ts";
// The real Pi entry, armed and commanded exactly as Pi loads it.
import gentleShellBridge, {
  STATUS_COMMAND,
  type BridgeCommandContext,
  type BridgeCommandHandler,
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
// Teardown-only seams.
import { resetBusForTests } from "../src/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import {
  disableSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { createFakeHost, type FakeHost, type FakeUiTarget } from "./fake-host.ts";
import {
  cardBody,
  cardTitles,
  fakeState,
  fakeTui,
  registerNativeFooter,
  resetSidebar,
} from "./fake-sidebar.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-sidebar-e2e-"));
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
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  delete hookSlot()[HOOK_KEY];
});

test.afterEach(() => {
  disableCaptureBackend();
  disableSidebarBackend();
  delete hookSlot()[HOOK_KEY];
});

interface Entry {
  sessionHandlers: BridgeSessionHandler[];
  commands: Array<{ name: string; handler: BridgeCommandHandler }>;
}

const loadEntry = (): Entry => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const commands: Entry["commands"] = [];
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` arms the row side and the rail (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand(name, command) {
      commands.push({ name, handler: command.handler });
    },
  };
  gentleShellBridge(pi);
  return { sessionHandlers, commands };
};

/** Pi fires `session_start`: the entry arms the row side and installs the sidebar widget. */
const armThroughEntry = (host: FakeHost): Entry => {
  const entry = loadEntry();
  entry.sessionHandlers[0]({}, { hasUI: true, ui: host.ui });
  return entry;
};

const printStatus = (entry: Entry): string => {
  const printed: string[] = [];
  const ctx: BridgeCommandContext = { ui: { notify: (message: string) => printed.push(message) } };
  entry.commands.find((command) => command.name === STATUS_COMMAND)?.handler("", ctx);
  return printed.join("\n");
};

type UiWithWidget = FakeUiTarget & {
  setWidget?: (key: string, factory: (tui: unknown, theme: unknown) => unknown) => void;
};

interface WidgetCall {
  key: string;
  component: unknown;
}

/** Model Pi's `ui.setWidget(key, factory)`: it runs the factory with the real `tui` immediately. */
const installWidgetSurface = (host: FakeHost): WidgetCall[] => {
  const calls: WidgetCall[] = [];
  const ui = host.ui as UiWithWidget;
  ui.setWidget = (key, factory) => {
    calls.push({ key, component: factory(fakeTui(), { name: "fake-theme" }) });
  };
  return calls;
};

const musicSection = (overrides: Partial<SidebarSection> = {}): SidebarSection => ({
  id: "loon.music",
  title: "MUSIC",
  meta: () => "1 playing",
  lines: () => ["track  one", "album  two"],
  ...overrides,
});

const sectionLine = (label: string): CustomizeRow[] => [
  {
    category: "Cards",
    label,
    choice: { setting: "Loon banner source", value: "on", current: () => true },
    action: () => {},
  },
  {
    category: "Cards",
    label,
    choice: { setting: "Loon banner source", value: "off", current: () => false },
    action: () => {},
  },
];

test("one registerSection call reaches the rail and the Sections menu through the entry", () => {
  const host = createFakeHost();
  const widgets = installWidgetSurface(host);
  registerNativeFooter(); // the host's own rail, registered BEFORE our arm
  registerSection(musicSection());

  const entry = armThroughEntry(host);
  host.buildMenu();

  assert.equal(widgets.length, 1, "the entry installed exactly one sidebar widget factory");
  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"], "the host frames our section after its own");
  assert.deepEqual(cardBody("MUSIC"), ["track  one", "album  two"]);

  const line = host.toggleLines().find((candidate) => candidate.startsWith("music "));
  assert.ok(line !== undefined, "the toggle exists without the plugin writing a row");
  assert.ok(line.includes("● shown") && line.includes("○ hidden"), line);
  assert.ok(host.rendered().includes("music"), "the row reads as the section label");

  const printed = printStatus(entry);
  assert.match(printed, /sections: 1/u);
  assert.match(printed, /sidebar: intercepted \(rail wrapped\)/u);
});

test("the same holds when the host registers its rail AFTER the arm", () => {
  const host = createFakeHost();
  installWidgetSurface(host);
  // The host's rail STATE exists from startup; what arrives late is the footer PART. That is the
  // ordering S4 is about, and the reason the interception patches the map instead of the part.
  fakeState();
  registerSection(musicSection());

  armThroughEntry(host);
  registerNativeFooter(); // the host's own rail, registered after our interception

  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"]);
});

test("the widget the bridge installs renders no rows", () => {
  const host = createFakeHost();
  const widgets = installWidgetSurface(host);
  registerNativeFooter();

  armThroughEntry(host);

  const component = widgets[0]?.component as { render(width: number): string[] } | undefined;
  assert.ok(component !== undefined);
  assert.deepEqual(component.render(40), [], "the widget exists only to receive the tui");
});

test("toggling through the menu hides the section on the next frame and stops building it", async () => {
  const host = createFakeHost();
  installWidgetSurface(host);
  registerNativeFooter();
  let linesCalls = 0;
  registerSection(
    musicSection({
      lines: () => {
        linesCalls += 1;
        return ["track  one", "album  two"];
      },
    }),
  );

  armThroughEntry(host);
  host.buildMenu();
  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"]);

  await host.pressRow(
    (row) => row.choice?.setting === "music" && row.choice.value === "hidden",
  );
  linesCalls = 0;

  assert.deepEqual(cardTitles(), ["FOOTER"], "the next frame drops the card");
  assert.equal(linesCalls, 0, "and the hidden section's content is not built");
  assert.deepEqual(
    JSON.parse(readFileSync(join(configHome, "gentle-shell-bridge", "bridge-sections.json"), "utf8")),
    { schemaVersion: 1, values: { sections: { "loon.music": false } } },
  );
});

test("disposing the section removes the card and, on a fresh menu, its rows", () => {
  const host = createFakeHost();
  installWidgetSurface(host);
  registerNativeFooter();
  const dispose = registerSection(musicSection());

  armThroughEntry(host);
  host.buildMenu();
  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"]);
  assert.ok(host.toggleLines().some((line) => line.startsWith("music ")));

  dispose();

  assert.deepEqual(cardTitles(), ["FOOTER"], "the rail drops it immediately");

  // A menu that received rows once keeps them (the capture marks the array), so a fresh menu is the
  // honest way to observe the next build.
  const second = createFakeHost();
  installWidgetSurface(second);
  armThroughEntry(second);
  second.buildMenu();
  assert.deepEqual(second.toggleLines(), [], "no toggle left for a disposed section");
  assert.equal(
    second.rendered().some((label) => label.includes("MUSIC")),
    false,
    "and no row label either",
  );
});

test("the row side still behaves in the same process, alongside the sections", () => {
  const host = createFakeHost();
  installWidgetSurface(host);
  registerNativeFooter();
  const provider: RowProvider = {
    id: "loon.banner-source",
    category: "Cards",
    rows: () => sectionLine("Loon banner source"),
  };
  registerRows(provider);
  registerSection(musicSection());

  armThroughEntry(host);
  host.buildMenu();

  const injected = host.liveRows().slice(4);
  assert.deepEqual(
    injected.slice(0, 2).map((row) => row.category),
    ["Cards", "Cards"],
    "provider rows keep their place and order",
  );
  assert.deepEqual(
    injected.slice(2).map((row) => row.category),
    ["Sections", "Sections"],
    "the bridge's own rows follow",
  );
  const lines = host.toggleLines();
  assert.ok(lines.some((line) => line.startsWith("Loon banner source")));
  assert.ok(lines.some((line) => line.startsWith("music ")));
});

test("a UI without setWidget is reported as unarmed and never throws", () => {
  const host = createFakeHost(); // no setWidget on this UI: Pi always has one, the test does not
  registerSection(musicSection());

  const entry = armThroughEntry(host); // must not throw
  host.buildMenu();

  assert.deepEqual(cardTitles(), [], "no rail interception was possible");
  assert.ok(host.rendered().includes("music"), "the row side still works: the toggle is visible");

  const printed = printStatus(entry);
  assert.match(printed, /sidebar: not armed/u);
  assert.match(printed, /sections: 1/u);
});

test("the public version is the released one", () => {
  assert.equal(VERSION, "0.16.2");
});

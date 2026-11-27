/**
 * `/bridge-status` for the section frame (N11, N15): which drawing the header and rows use, whether
 * the theme was captured, how the pointer reaches them, and — when the host's own builders cannot be
 * reached — the gap, named.
 *
 * Every fact asserted here is a measurement of the run: the source comes from looking for the host's
 * builders on the objects the bridge is handed, so the "host" case is proved by publishing them on a
 * fake rail and watching the drawing change.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { setRepaintHost, resetRepaintForTests } from "../src/repaint.ts";
import { resetSectionPanelForTests, setSectionTheme } from "../src/section-panel.ts";
import { resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import {
  installSectionRail,
  resetSectionFailuresForTests,
} from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SidebarSection } from "../src/types.ts";
import { setSectionCollapsed } from "../src/visibility.ts";
import {
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-frame-status-"));
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
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetSectionPanelForTests();
  resetSectionPointerForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  disableSidebarBackend();
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

function arm(): void {
  setRepaintHost({ terminal: fakeTerminal(), requestRender: () => {} });
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

const frameLines = (): string[] => formatStatus(collectStatus()).filter((line) => line.startsWith("section "));

/** A theme shaped like Pi's, so the drawing has something to paint with. */
const theme = { fg: (role: string, text: string) => `<${role}>${text}`, bold: (text: string) => text };

test("with no section there is no frame block: a row-only session keeps its output", () => {
  assert.deepEqual(frameLines(), []);
  assert.equal(collectStatus().sectionFrame, undefined);
});

test("the fallback reports what it looked for and found, and names the gap", () => {
  registerSection(section("music"));
  arm();

  assert.deepEqual(frameLines(), [
    "section frame: fallback (looked for renderPanelHeader/renderPanelRow on: the terminal sidebar state, the rail part; found none; no theme captured yet, rows drawn uncoloured)",
    "section interaction: rail handleMouse (the host's own dispatch), hover not used yet",
    "section frame gap: gentle-shell's lib/shell-panel.ts cannot be imported (Pi loads each extension in its own module graph) and publishes no builder on the rail part, the Pi theme or the terminal's sidebar state, so the header and rows are drawn by a byte-identical port",
  ]);
  const frame = collectStatus().sectionFrame;
  assert.equal(frame?.source, "fallback");
  assert.deepEqual(frame?.lookedAt, ["the terminal sidebar state", "the rail part"]);
  assert.equal(frame?.theme, "missing");
});

test("a host that publishes its own builders is used, and reported as the source", () => {
  setSectionTheme(theme);
  registerSection(section("music"));
  const rail = registerNativeFooter();
  const host = rail as unknown as Record<string, unknown>;
  host.renderPanelHeader = (_theme: unknown, _width: number, header: { title: string }) =>
    `HOST HEADER ${header.title.toUpperCase()}`;
  host.renderPanelRow = (_width: number, left: string) => `HOST ROW ${left}`;
  installSidebarBackend(() => fakeTui());
  installSectionRail();

  assert.deepEqual(frameLines(), [
    "section frame: host (the host's own renderPanelHeader/renderPanelRow, found on: the Pi theme, the terminal sidebar state, the rail part; theme captured, rows painted in the host's roles)",
    "section interaction: rail handleMouse (the host's own dispatch), hover not used yet",
  ]);
  assert.deepEqual(collectStatus().sectionFrame?.missing, []);
  assert.deepEqual((fakeState().parts.get(SIDEBAR_RAIL_KEY)?.render(20) ?? []).slice(3), [
    "HOST HEADER MUSIC",
    // A plain string row stays the bytes the author wrote, even when the host draws structured rows.
    "body music",
  ]);
});

test("the theme is reported captured once Pi hands it over", () => {
  setSectionTheme(theme);
  registerSection(section("music"));
  arm();

  assert.ok(
    frameLines()[0].includes("theme captured, rows painted in the host's roles"),
    frameLines()[0],
  );
  assert.equal(collectStatus().sectionFrame?.theme, "captured");
});

test("a collapsed section says so in the sections table", () => {
  registerSection(section("music", { title: "MUSIC" }));
  arm();
  setSectionCollapsed("music", true);

  assert.deepEqual(
    formatStatus(collectStatus()).filter((line) => line.includes('"MUSIC"')),
    [
      '  - music "MUSIC": visible, collapsed, registration order, row "music", placement end → after footer',
    ],
  );
  assert.equal(collectStatus().sections?.[0].collapsed, true);
});

test("the pointer's mechanism is reported once it has been used", () => {
  setSectionTheme(theme);
  registerSection(
    section("music", { lines: () => [{ label: "play", onClick: () => {} }] }),
  );
  arm();
  renderSidebar();

  fakeState().parts.get(SIDEBAR_RAIL_KEY)?.handleMouse?.({
    type: "move",
    button: "none",
    x: 4,
    y: 4,
    width: 40,
    height: 20,
  });

  assert.equal(collectStatus().sectionFrame?.hover, "host-state");
  assert.ok(
    frameLines()[1].includes("hover owner claimed on the host's sidebar state"),
    frameLines()[1],
  );
});

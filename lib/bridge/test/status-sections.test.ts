/**
 * `/bridge-status` for the sidebar surface (S8, S12).
 *
 * The command must answer "why did my section not appear": the registered sections, their persisted
 * visibility, the failures of the most recent sidebar frame, and whether the rail was intercepted at
 * all. It must do so WITHOUT running a section's `lines()`/`meta()` — diagnostics never build UI.
 *
 * The pre-existing fields (providers, backend, last capture, failures, store problems, duplicate
 * settings) keep their exact output for a run that has no sections: that is why every new block is
 * emitted only when it has something to say.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerRows, registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import {
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
import type { RowProvider, SidebarSection } from "../src/types.ts";
import { setSectionVisible } from "../src/visibility.ts";
import {
  fakeTui,
  registerNativeFooter,
  registerNativeRail,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-status-"));
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
  resetStoreStateForTests();
  disableSidebarBackend();
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const statusLines = (): string[] => formatStatus(collectStatus());

test("the sections table reports id, title, visibility and where the order comes from", () => {
  registerSection(section("late", { title: "LATE", order: 5 }));
  registerSection(section("plain", { title: "PLAIN" }));
  registerSection(section("first", { title: "FIRST", order: 1 }));

  const snapshot = collectStatus();

  // Every section line carries its placement (S1, S5): what it asked for and where it landed. A
  // section that never named one asked for `end`, so there is no fallback to explain.
  assert.deepEqual(snapshot.sections, [
    {
      id: "first",
      title: "FIRST",
      visible: true,
      order: 1,
      rowLabel: "first",
      placement: { requested: "end", landed: "after footer" },
    },
    {
      id: "late",
      title: "LATE",
      visible: true,
      order: 5,
      rowLabel: "late",
      placement: { requested: "end", landed: "after footer" },
    },
    {
      id: "plain",
      title: "PLAIN",
      visible: true,
      order: "registration",
      rowLabel: "plain",
      placement: { requested: "end", landed: "after footer" },
    },
  ]);
  assert.deepEqual(statusLines().filter((line) => line.includes("FIRST") || line.includes("PLAIN")), [
    '  - first "FIRST": visible, order 1, row "first", placement end → after footer',
    '  - plain "PLAIN": visible, registration order, row "plain", placement end → after footer',
  ]);
  assert.ok(statusLines().includes("sections: 3"));
  assert.ok(
    statusLines().includes("rail parts: todo, jobs, agents, footer"),
    "the parts a placement resolves against are part of the answer",
  );
});

test("the table shows the persisted visibility, not a guess", () => {
  registerSection(section("music", { title: "MUSIC" }));
  registerSection(section("quiet", { title: "QUIET", defaultVisible: false }));

  setSectionVisible("music", false);

  assert.deepEqual(
    collectStatus().sections?.map((entry) => [entry.id, entry.visible]),
    [
      ["music", false],
      ["quiet", false],
    ],
  );

  setSectionVisible("quiet", true);
  assert.equal(collectStatus().sections?.find((entry) => entry.id === "quiet")?.visible, true);
});

test("section failures from the last frame are reported with their id and phase", () => {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
  registerSection(
    section("broken", {
      title: "BROKEN",
      lines: () => {
        throw new Error("lines exploded");
      },
    }),
  );
  registerSection(section("fine", { title: "FINE" }));

  renderSidebar(40);

  const snapshot = collectStatus();
  assert.deepEqual(snapshot.sectionFailures, [
    { sectionId: "broken", phase: "lines", message: "lines exploded" },
  ]);
  const lines = statusLines();
  const failuresAt = lines.indexOf("section failures: 1");
  assert.ok(failuresAt !== -1, "the failure block is emitted");
  assert.deepEqual(lines.slice(failuresAt, failuresAt + 2), [
    "section failures: 1",
    "  - broken (lines): lines exploded",
  ]);
});

test("diagnostics never execute a section's lines() or meta()", () => {
  let linesCalls = 0;
  let metaCalls = 0;
  registerSection(
    section("costly", {
      title: "COSTLY",
      meta: () => {
        metaCalls += 1;
        return "m";
      },
      lines: () => {
        linesCalls += 1;
        return ["never built for a status report"];
      },
    }),
  );

  collectStatus();
  formatStatus(collectStatus());

  assert.equal(linesCalls, 0, "a status report must not build section content");
  assert.equal(metaCalls, 0);
});

test("the sidebar state answers the missing-section question", () => {
  // Registered but never armed: the report says so instead of staying silent.
  registerSection(section("music", { title: "MUSIC" }));
  assert.equal(collectStatus().sidebar, undefined);
  assert.ok(statusLines().includes("sidebar: not armed"));

  // Intercepted with the part present.
  registerNativeRail("todo", { render: () => ["▾ TODO"] });
  registerNativeFooter();
  assert.equal(installSidebarBackend(() => fakeTui()).outcome, "intercepted");
  assert.deepEqual(collectStatus().sidebar, { state: "intercepted", rail: "wrapped" });
  assert.ok(statusLines().includes("sidebar: intercepted (rail wrapped)"));

  // Intercepted, but the host has not registered the part we append to yet.
  resetSidebar();
  resetSidebarStateForTests();
  registerNativeRail("todo", { render: () => ["▾ TODO"] });
  assert.deepEqual(installSidebarBackend(() => fakeTui()).rail, "pending");
  assert.deepEqual(collectStatus().sidebar, { state: "intercepted", rail: "pending" });

  // A tui without rail state: reported, never invented.
  resetSidebar();
  resetSidebarStateForTests();
  installSidebarBackend(() => undefined);
  assert.deepEqual(collectStatus().sidebar, { state: "no-sidebar-state" });
  assert.ok(statusLines().includes("sidebar: no-sidebar-state"));

  // A resolver that throws keeps its reason.
  resetSidebarStateForTests();
  installSidebarBackend(() => {
    throw new Error("no tui yet");
  });
  assert.deepEqual(collectStatus().sidebar, {
    state: "no-sidebar-state",
    reason: "no tui yet",
  });

  // Disabled after a successful arm: unarmed again, and the report says so.
  resetSidebar();
  resetSidebarStateForTests();
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  disableSidebarBackend();
  assert.deepEqual(collectStatus().sidebar, { state: "unarmed" });
});

test("the pre-existing fields are still reported alongside the new ones", () => {
  const provider: RowProvider = { id: "p", category: "Cards", rows: () => [] };
  registerRows(provider);
  registerSection(section("music", { title: "MUSIC" }));

  const snapshot = collectStatus();

  assert.deepEqual(snapshot.providers, [{ id: "p", category: "Cards" }]);
  assert.equal(snapshot.backend, "none");
  assert.deepEqual(snapshot.failures, []);
  assert.deepEqual(snapshot.storeProblems, []);

  const lines = statusLines();
  assert.ok(lines.includes("providers: 1"));
  assert.ok(lines.includes("backend: none"));
  assert.ok(lines.includes("last capture: none"));
  assert.ok(lines.includes("last failures: none"));
  assert.ok(lines.includes("duplicate settings: no build yet"));
  assert.ok(lines.includes("sections: 1"));
});

test("a run with no sections keeps the historical output byte for byte", () => {
  assert.deepEqual(statusLines(), [
    "gentle-shell-bridge status",
    "providers: none",
    "backend: none",
    "last capture: none",
    "last failures: none",
    "store problems: none",
    "duplicate settings: no build yet",
  ]);
});

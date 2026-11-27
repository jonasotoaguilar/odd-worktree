/**
 * The automatic `Sections` toggle rows (S5, S6), against the fake host and the fake sidebar.
 *
 * A plugin never writes a `setting`, a `value`, a `current()`, an `action()` or a `preview()`: the
 * bridge derives all of it from the section registration. These tests pin that surface, the
 * persistence file, and the one property that makes the toggle useful — hiding takes effect on the
 * sidebar's NEXT FRAME, not only on the next menu open.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armBridge } from "../src/arm.ts";
import { registerSection, resetBusForTests, resetSectionsForTests, snapshotProviders } from "../src/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import {
  SECTION_ROWS_PROVIDER_ID,
  installSectionRows,
} from "../src/sections-rows.ts";
import {
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { installSectionRail, resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, RowContext, SidebarSection } from "../src/types.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";
import { cardTitles, fakeTui, registerNativeFooter, resetSidebar } from "./fake-sidebar.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-rows-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  // The visibility store is a real file: each test starts from nothing on disk.
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBusForTests();
  resetSectionsForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  delete hookSlot()[HOOK_KEY];
});

test.afterEach(() => {
  disableCaptureBackend();
  disableSidebarBackend();
  delete hookSlot()[HOOK_KEY];
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const ctx = (): RowContext => ({ theme: undefined, configHome });

/** The one internal provider, read straight from the bus so a build needs no menu. */
const rowsNow = (): CustomizeRow[] => {
  const provider = snapshotProviders().find((entry) => entry.id === SECTION_ROWS_PROVIDER_ID);
  assert.ok(provider !== undefined, "the bridge registers its own Sections provider");
  return provider.rows(ctx());
};

const settingsOf = (rows: CustomizeRow[]): string[] =>
  rows.map((row) => row.choice?.setting ?? "");

/** Native host + interception + renderer + the internal rows provider, then a menu host. */
function arm(): FakeHost {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
  installSectionRows();
  const host = createFakeHost();
  armBridge(host.ui);
  return host;
}

const storePath = (): string => join(configHome, "gentle-shell-bridge", "bridge-sections.json");

test("a section becomes two consecutive Sections rows carrying its title as a label, and both values", () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  const host = arm();

  host.buildMenu();

  const injected = host.liveRows().filter((row) => row.category === "Sections");
  assert.equal(injected.length, 2, "exactly one toggle: two values, two rows");
  assert.equal(
    injected[0].choice?.setting,
    "music",
    "the line's name is the row label, never the section id",
  );
  assert.equal(injected[0].choice?.setting, injected[1].choice?.setting, "one setting, two values");
  assert.deepEqual(
    injected.map((row) => row.choice?.value),
    ["shown", "hidden"],
    "consecutive rows, so the host draws one line",
  );
  assert.deepEqual(
    injected.map((row) => (typeof row.label === "function" ? row.label() : row.label)),
    ["music", "music"],
    "the label is the title as a human reads it, in the row label and in the setting",
  );

  const lines = host.toggleLines();
  assert.equal(lines.length, 1, "one rendered line per section");
  assert.ok(lines[0].startsWith("music "), "the rendered line reads as a label");
  assert.equal(lines[0].includes("Section:"), false, "no prefix is added to the label");
  assert.equal(lines[0].includes("loon.music"), false, "and the id never appears in the row");
  assert.ok(lines[0].includes("● shown"), "defaultVisible defaults to shown");
  assert.ok(lines[0].includes("○ hidden"));
  assert.ok(host.rendered().includes("music"), "the label is what the row reads as");
});

test("toggling persists to the bridge store first, then the host repaints", async () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  const host = arm();
  host.buildMenu();
  const invalidationsBefore = host.invalidateCount();

  await host.pressRow(
    (row) => row.choice?.setting === "music" && row.choice.value === "hidden",
  );

  assert.deepEqual(JSON.parse(readFileSync(storePath(), "utf8")), {
    schemaVersion: 1,
    values: { sections: { "loon.music": false } },
  });
  assert.equal(host.invalidateCount(), invalidationsBefore + 1, "the host repaints after the action");

  assert.ok(host.toggleLines()[0].includes("○ shown"), "the bullet left shown");
  assert.ok(host.toggleLines()[0].includes("● hidden"), "and landed on hidden");
});

test("both values draw the host's shared Sections preview, never a picture of the card", () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  // The provider is read directly, so no host rows array was ever captured: the base list is the
  // host's own empty case and only the bridge's section can be listed.
  arm();

  const rows = rowsNow();
  const shown = rows.find((row) => row.choice?.value === "shown");
  const hidden = rows.find((row) => row.choice?.value === "hidden");
  assert.ok(shown?.preview !== undefined && hidden?.preview !== undefined);

  assert.deepEqual(shown.preview(), {
    title: "Sections · music shown",
    sample: "[music]",
  });
  assert.deepEqual(hidden.preview(), {
    title: "Sections · music hidden",
    sample: "[no optional sections]",
  });
});

test("hiding takes effect on the sidebar's next frame, without building the section again", async () => {
  let linesCalls = 0;
  registerSection(
    section("loon.music", {
      title: "MUSIC",
      lines: () => {
        linesCalls += 1;
        return ["track  one"];
      },
    }),
  );
  const host = arm();
  host.buildMenu();

  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"]);
  assert.equal(linesCalls, 1);

  await host.pressRow(
    (row) => row.choice?.setting === "music" && row.choice.value === "hidden",
  );
  linesCalls = 0;

  assert.deepEqual(cardTitles(), ["FOOTER"], "the next frame drops the card");
  assert.equal(linesCalls, 0, "and does not build the hidden section's content");
});

test("a section registered later gains rows without re-registering the provider", () => {
  registerSection(section("first", { title: "FIRST" }));
  installSectionRows();

  assert.equal(rowsNow().length, 2);

  registerSection(section("second", { title: "SECOND" }));

  assert.deepEqual(
    settingsOf(rowsNow()),
    ["first", "first", "second", "second"],
    "rows are built per menu build from the live registry, each named by its label",
  );
});

test("a disposed section loses its rows and its card", async () => {
  const dispose = registerSection(section("gone", { title: "GONE" }));
  registerSection(section("stays", { title: "STAYS" }));
  const host = arm();
  host.buildMenu();
  assert.equal(host.toggleLines().length, 2);
  assert.deepEqual(cardTitles(), ["FOOTER", "GONE", "STAYS"]);

  dispose();

  assert.deepEqual(settingsOf(rowsNow()), ["stays", "stays"]);
  assert.deepEqual(cardTitles(), ["FOOTER", "STAYS"]);
});

test("two sections with the same id replace each other instead of duplicating", () => {
  registerSection(section("dup", { title: "FIRST TITLE" }));
  registerSection(section("dup", { title: "SECOND TITLE" }));
  registerSection(section("other", { title: "OTHER" }));
  const host = arm();
  host.buildMenu();

  const dupRows = rowsNow().filter((row) => row.choice?.setting === "second title");
  assert.equal(dupRows.length, 2, "still one toggle for that id");
  assert.equal(
    host.toggleLines().filter((line) => line.startsWith("second title")).length,
    1,
    "and one line, named by the live title's label",
  );

  assert.deepEqual(cardTitles(), ["FOOTER", "SECOND TITLE", "OTHER"], "one card, the live section");

  // One rendered label per toggle value, so the same label appears twice by design; what matters is
  // that the replaced label is gone.
  const rendered = [...new Set(host.rendered().filter((label) => label.includes("title")))];
  assert.deepEqual(rendered, ["second title"], "the replaced title is not left in the menu");
});

test("each section's line is independent: one toggle never writes another's key", () => {
  registerSection(section("a", { title: "AAA" }));
  registerSection(section("b", { title: "BBB" }));
  arm();

  const hideB = rowsNow().find(
    (row) => row.choice?.setting === "bbb" && row.choice.value === "hidden",
  );
  assert.ok(hideB?.action !== undefined);
  hideB.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

  assert.deepEqual(JSON.parse(readFileSync(storePath(), "utf8")), {
    schemaVersion: 1,
    values: { sections: { b: false } },
  });
  const rows = rowsNow();
  const currentFor = (setting: string, value: string): boolean | undefined =>
    rows.find((row) => row.choice?.setting === setting && row.choice.value === value)?.choice?.current();
  assert.equal(currentFor("aaa", "shown"), true, "the untouched section stays shown");
  assert.equal(currentFor("bbb", "shown"), false);
  assert.equal(currentFor("bbb", "hidden"), true);
});

test("defaultVisible false starts hidden, and the rows say so", () => {
  registerSection(section("quiet", { title: "QUIET", defaultVisible: false }));
  const host = arm();
  host.buildMenu();

  assert.deepEqual(cardTitles(), ["FOOTER"]);
  const line = host.toggleLines()[0];
  assert.ok(line.includes("○ shown"));
  assert.ok(line.includes("● hidden"));
});

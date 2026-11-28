/**
 * Row naming (N1–N3): a row is a LABEL, not an id.
 *
 * The host prints `choice.setting` as a toggle line's name
 * (`lib/visual-customize-view.ts:583-595`), so a shell API-derived setting that contains an id puts
 * that id in front of the user: `Section: bash-card.status`. These tests pin the replacement rule —
 * lowercase words derived from the visible text, an explicit `rowLabel` winning, the id staying
 * internal, and collisions between two equal labels being disambiguated deterministically and
 * reported by the diagnostics record.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armShellApi } from "../../lib/shell-api/arm.ts";
import {
  registerCardStyle,
  registerSection,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
} from "../../lib/shell-api/bus.ts";
import { installCardStyleRows, resetCardStyleRowStateForTests } from "../../lib/shell-api/card-style-rows.ts";
import { HOST_CARD_STYLE_SETTING } from "../../lib/shell-api/card-style-line.ts";
import {
  disableCaptureBackend,
  resetCaptureStateForTests,
} from "../../lib/shell-api/capture.ts";
import { resetHookStateForTests } from "../../lib/shell-api/hook.ts";
import { resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import { installSectionRows } from "../../lib/shell-api/sections-rows.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import type {
  CardFrame,
  CardStyleRegistration,
  CustomizeRow,
  SidebarSection,
} from "../../lib/shell-api/types.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-row-labels-"));
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
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const frame = (): CardFrame => ({
  top: (ctx) => "▛".repeat(ctx.width),
  line: (ctx) => ctx.text,
  bottom: (ctx) => "▙".repeat(ctx.width),
});

const style = (id: string, extra: Partial<CardStyleRegistration> = {}): CardStyleRegistration => ({
  id,
  label: id,
  frame: frame(),
  ...extra,
});

const textOf = (row: CustomizeRow): string => {
  const label = row.label;
  return typeof label === "function" ? label() : (label ?? "");
};

/** The shell API's own `Sections` provider, then a menu host that captures it. */
const sectionsHost = (): FakeHost => {
  installSectionRows();
  const host = createFakeHost();
  armShellApi(host.ui);
  return host;
};

/** The host's own `Card style` row, shaped like `extensions/gentle-shell.ts:3405-3419`. */
const hostStyleRow = (value: "neon" | "float"): CustomizeRow => ({
  category: "Cards",
  label: () => `Card style: ${value}`,
  choice: {
    setting: HOST_CARD_STYLE_SETTING,
    value,
    current: () => value === "float",
  },
  action: async () => {},
});

/** A host menu long enough to be captured, with the host's own `Card style` line in `Cards`. */
const rowsWithHostLine = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  hostStyleRow("neon"),
  hostStyleRow("float"),
];

/** The capture backend, then the card-style surface, against a host that already has the line. */
const cardStyleHost = (): FakeHost => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armShellApi(host.ui);
  installCardStyleRows();
  return host;
};

/** Every string the user could read in this menu: row labels, toggle lines and previews. */
const visibleText = (host: FakeHost): string[] => [
  ...host.rendered(),
  ...host.toggleLines(),
  ...host.liveRows().flatMap((row) => {
    const preview = row.preview?.();
    return preview === undefined ? [] : [preview.title, preview.sample];
  }),
];

// ---------------------------------------------------------------------------------------------
// Sections (N1, N2)
// ---------------------------------------------------------------------------------------------

test("a section's row reads its title as a label: no prefix, no id", () => {
  registerSection(section("bash-card.status", { title: "BASH CARD" }));
  const host = sectionsHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), ["bash card ● shown ○ hidden"]);
  const injected = host.liveRows().filter((row) => row.category === "Sections");
  assert.equal(injected.length, 2);
  assert.deepEqual(
    injected.map(textOf),
    ["bash card", "bash card"],
    "the row label is the derived label, not the title as typed and not the id",
  );
  assert.equal(injected[0]?.choice?.setting, "bash card", "the line's name is the same label");
  assert.equal(
    visibleText(host).some((text) => text.includes("bash-card.status")),
    false,
    "the id never reaches a row",
  );
  assert.equal(
    visibleText(host).some((text) => text.startsWith("Section:")),
    false,
    "no prefix anywhere",
  );
});

test("the derivation lowercases and joins words, and drops dots and punctuation", () => {
  registerSection(section("internal.one", { title: "usageCost" }));
  registerSection(section("internal.two", { title: "bash-card.status" }));
  registerSection(section("internal.three", { title: "MUSIC 2" }));
  const host = sectionsHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), [
    "usage cost ● shown ○ hidden",
    // Sections sort by `id` inside one slot (section-placement S2), so the rows read in that order:
    // `internal.one`, `internal.three`, `internal.two`.
    "music 2 ● shown ○ hidden",
    "bash card status ● shown ○ hidden",
  ]);
});

test("an explicit rowLabel wins over the derived label", () => {
  registerSection(
    section("loon.music", { title: "MUSIC", rowLabel: "Music now playing" }),
  );
  const host = sectionsHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), ["Music now playing ● shown ○ hidden"]);
  assert.deepEqual(
    host.liveRows().filter((row) => row.category === "Sections").map(textOf),
    ["Music now playing", "Music now playing"],
    "the author's label is used verbatim",
  );
});

test("two sections with equal labels are disambiguated deterministically, never by id", () => {
  registerSection(section("loon.one", { title: "MUSIC" }));
  registerSection(section("loon.two", { title: "MUSIC" }));
  const first = sectionsHost();
  first.buildMenu();

  assert.deepEqual(first.toggleLines(), [
    "music ● shown ○ hidden",
    "music 2 ● shown ○ hidden",
  ]);
  assert.equal(
    first.toggleLines().some((line) => line.includes("loon.one") || line.includes("loon.two")),
    false,
    "the disambiguation is a readable suffix, never the raw id",
  );

  // Same registrations, a second menu build: the assignment cannot drift.
  const second = sectionsHost();
  second.buildMenu();
  assert.deepEqual(second.toggleLines(), first.toggleLines());
});

// ---------------------------------------------------------------------------------------------
// Card styles (N1, N3)
// ---------------------------------------------------------------------------------------------

test("a card-style row is a label derived from its label; the id stays internal", () => {
  registerCardStyle(style("loon.cute", { label: "Cute Card" }));
  const host = cardStyleHost();

  host.buildMenu();

  assert.deepEqual(host.toggleLines(), ["Card style ○ neon ● float ○ Cute Card"]);
  const registered = host.liveRows().filter((row) => row.choice?.value === "Cute Card");
  assert.equal(registered.length, 1);
  assert.equal(textOf(registered[0] as CustomizeRow), "cute card", "the row reads as a label");
  assert.equal(
    visibleText(host).some((text) => text.includes("loon.cute")),
    false,
    "the id never reaches a row, a line or a preview",
  );
});

test("an explicit card-style rowLabel wins, and the value keeps the style's own label", () => {
  registerCardStyle(style("loon.cute", { label: "Cute Card", rowLabel: "Plain card" }));
  const host = cardStyleHost();

  host.buildMenu();

  const registered = host.liveRows().filter((row) => row.choice?.setting === HOST_CARD_STYLE_SETTING);
  const shellApiRow = registered.find((row) => row.choice?.value === "Cute Card");
  assert.ok(shellApiRow !== undefined);
  assert.equal(textOf(shellApiRow), "Plain card", "the author's row label is used verbatim");
  assert.equal(shellApiRow.choice?.value, "Cute Card", "the line's value is still the style's label");
});

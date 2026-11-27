/**
 * Section rendering on the host's rail (S3, S7, S8), against the fake host.
 *
 * Every assertion here is about FRAMED output: the bridge contributes rows and card groups, and the
 * host's own frame draws the card. A raw string in a rail's output is not a rendered section.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import {
  MAX_SECTION_BODY_ROWS,
  getSectionFailures,
  installSectionRail,
  resetSectionFailuresForTests,
} from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SidebarSection } from "../src/types.ts";
import { setSectionVisible } from "../src/visibility.ts";
import {
  cardBody,
  cardTitles,
  fakeState,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-sections-"));
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
  disableSidebarBackend();
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

/** Native host first, then the bridge's interception and the section renderer. */
function arm(): void {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

const rail = () => fakeState().parts.get(SIDEBAR_RAIL_KEY);

test("sections are framed after the native content, in the registered order", () => {
  // Registered out of order on purpose: the T2 snapshot decides, not insertion order.
  registerSection(section("weather", { title: "WEATHER", lines: () => ["18° clear"], order: 2 }));
  registerSection(
    section("music", {
      title: "MUSIC",
      meta: () => "1 playing",
      lines: () => ["track  one", "album  two"],
      order: 1,
    }),
  );
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC", "WEATHER"], "native first, then ordered sections");
  assert.deepEqual(cardBody("MUSIC"), ["track  one", "album  two"]);

  const heading = renderSidebar().find((row) => row.includes("MUSIC"));
  assert.ok(heading !== undefined);
  assert.ok(heading.includes("▾ MUSIC"), "the host's frame carries the section title");
  assert.ok(heading.includes("1 playing"), "meta() is drawn as the right-aligned count");
});

test("no body row is ever wider than the width the host passes", () => {
  registerSection(
    section("wide", {
      title: "WIDE",
      meta: () => "a meta string that cannot possibly fit here",
      lines: () => ["a body row that is certainly much too long for a narrow rail"],
    }),
  );
  arm();

  const width = 24;
  const contribution = rail()?.render(width) ?? [];
  for (const row of contribution) {
    assert.ok(row.length <= width, `contribution row ${JSON.stringify(row)} exceeds ${width}`);
  }
  assert.ok(
    contribution.some((row) => row.endsWith("…")),
    "a clipped row is marked, not silently cut",
  );
  for (const row of renderSidebar(width)) {
    // The host leaves one blank row between two sections; every drawn row must fit the width.
    if (row === "") continue;
    assert.equal(row.length, width, `framed row ${JSON.stringify(row)} does not fit ${width}`);
  }
  assert.ok(cardTitles(width).includes("WIDE"), "the heading survives a width the meta does not fit");
});

test("the body is capped and says what it elided", () => {
  const rows = Array.from({ length: MAX_SECTION_BODY_ROWS + 4 }, (_, index) => `row ${index + 1}`);
  registerSection(section("many", { title: "MANY", lines: () => rows }));
  arm();

  const body = cardBody("MANY");
  assert.equal(body.length, MAX_SECTION_BODY_ROWS, "the cap is the contract, not a suggestion");
  assert.equal(body.at(-1), `… +${rows.length - (MAX_SECTION_BODY_ROWS - 1)} more`);
});

test("hidden means not built: no card and no lines()/meta() call", () => {
  let linesCalls = 0;
  let metaCalls = 0;
  registerSection(
    section("quiet", {
      title: "QUIET",
      meta: () => {
        metaCalls += 1;
        return "quiet";
      },
      lines: () => {
        linesCalls += 1;
        return ["never built"];
      },
    }),
  );
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "QUIET"]);
  assert.equal(linesCalls, 1);
  assert.equal(metaCalls, 1);

  setSectionVisible("quiet", false);
  linesCalls = 0;
  metaCalls = 0;

  assert.deepEqual(cardTitles(), ["FOOTER"], "a hidden section is not drawn");
  assert.equal(linesCalls, 0, "and its body is not built at all");
  assert.equal(metaCalls, 0, "not even its meta");
});

test("a throwing lines() drops that body only and is recorded with the section id", () => {
  registerSection(
    section("broken", {
      title: "BROKEN",
      lines: () => {
        throw new Error("lines exploded");
      },
    }),
  );
  registerSection(section("fine", { title: "FINE", lines: () => ["fine row"] }));
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "BROKEN", "FINE"], "both sections still have a heading");
  assert.deepEqual(cardBody("BROKEN"), [], "the broken body is dropped, not half-drawn");
  assert.deepEqual(cardBody("FINE"), ["fine row"], "the sibling section is untouched");
  assert.deepEqual(cardBody("FOOTER"), ["native row 1", "native row 2"]);

  const failure = getSectionFailures().find((entry) => entry.sectionId === "broken");
  assert.ok(failure !== undefined, "the failure is on record for /bridge-status");
  assert.equal(failure.phase, "lines");
  assert.equal(failure.message, "lines exploded");
});

test("a throwing meta() drops the body too, per the spec's failure rule", () => {
  registerSection(
    section("badm", {
      title: "BADM",
      meta: () => {
        throw new Error("meta exploded");
      },
      lines: () => ["body that must not be shown"],
    }),
  );
  registerSection(section("good", { title: "GOOD", lines: () => ["good row"] }));
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "BADM", "GOOD"]);
  assert.deepEqual(cardBody("BADM"), []);

  const failure = getSectionFailures().find((entry) => entry.sectionId === "badm");
  assert.equal(failure?.phase, "meta");
  assert.equal(failure?.message, "meta exploded");
});

test("a non-string line is a failure, never coerced", () => {
  registerSection(
    section("bad", {
      title: "BAD",
      // The shape is wrong on purpose: a plugin can return anything at runtime.
      lines: () => ["fine", 42 as unknown as string],
    }),
  );
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "BAD"]);
  assert.deepEqual(cardBody("BAD"), []);
  assert.equal(getSectionFailures().find((entry) => entry.sectionId === "bad")?.phase, "lines");
});

test("a non-array lines() return is a failure, never coerced", () => {
  registerSection(
    section("notarray", {
      title: "NOTARRAY",
      lines: () => "just a string" as unknown as string[],
    }),
  );
  arm();

  assert.deepEqual(cardBody("NOTARRAY"), []);
  assert.equal(getSectionFailures().find((entry) => entry.sectionId === "notarray")?.phase, "lines");
});

test("a section registered after the first frame appears on the next one", () => {
  registerSection(section("first", { title: "FIRST" }));
  arm();
  assert.deepEqual(cardTitles(), ["FOOTER", "FIRST"]);

  registerSection(section("later", { title: "LATER", order: 1 }));

  assert.deepEqual(cardTitles(), ["FOOTER", "LATER", "FIRST"], "no reinstall, next frame");
});

test("a disposed section leaves no card and no group behind", () => {
  const section$ = section("gone", { title: "GONE" });
  const dispose = registerSection(section$);
  registerSection(section("stays", { title: "STAYS" }));
  arm();
  assert.deepEqual(cardTitles(), ["FOOTER", "GONE", "STAYS"]);

  dispose();

  assert.deepEqual(cardTitles(), ["FOOTER", "STAYS"]);
});

test("no visible section contributes nothing, leaving the host's own rows untouched", () => {
  registerSection(section("off", { title: "OFF", defaultVisible: false }));
  arm();

  assert.deepEqual(rail()?.render(40), ["▾ FOOTER", "native row 1", "native row 2"]);
  assert.deepEqual(rail()?.cardGroups?.(40), { groups: [{ start: 0, end: 3 }] });
  assert.deepEqual(cardTitles(), ["FOOTER"]);
});

test("a non-positive width contributes nothing instead of returning a broken row", () => {
  registerSection(section("any", { title: "ANY" }));
  arm();

  assert.deepEqual(rail()?.render(0), ["▾ FOOTER", "native row 1", "native row 2"]);
});

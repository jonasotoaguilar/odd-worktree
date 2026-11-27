/**
 * Section placement (S1, S2, S3, S5, S6): where a section's card goes in the rail, and what the
 * order inside one slot is made of.
 *
 * The placement is REGISTRATION data, like `order`: nothing here is persisted, and nothing here
 * depends on the order the plugins happened to load in. The renderer (`./sidebar-render.ts`) and the
 * rail wrapper (`./sidebar.ts`) only consume the ordered list this resolver returns; the fallbacks
 * are decided once, here, so `/bridge-status` and the frame cannot disagree about where a card went.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  RAIL_PARTS,
  getSectionPlacementRejections,
  registerSection,
  resetBusForTests,
  resetSectionsForTests,
  resolveSectionPlacements,
  snapshotSections,
} from "../src/bus.ts";
import type { RailPart, SidebarSection } from "../src/types.ts";

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const register = (...sections: SidebarSection[]): void => {
  for (const entry of sections) registerSection(entry);
};

/** `id@side part` for every section, in draw order: the whole answer in one string per section. */
const places = (
  sections: readonly SidebarSection[] = snapshotSections(),
  painted: readonly RailPart[] = RAIL_PARTS,
): string[] =>
  resolveSectionPlacements(sections, painted).map(
    (entry) => `${entry.section.id}@${entry.side} ${entry.part}`,
  );

const resolutionOf = (id: string, painted: readonly RailPart[] = RAIL_PARTS) =>
  resolveSectionPlacements(snapshotSections(), painted).find((entry) => entry.section.id === id);

test.beforeEach(() => {
  resetBusForTests();
  resetSectionsForTests();
});

/**
 * S2. The registration index is gone from the section tiebreak: two sections that differ only in
 * load order must draw in the same order, or a user's rail changes between sessions for no reason.
 */
test("equal orders and missing orders are broken by id, never by load order", () => {
  const first = [
    section("b", { order: 5 }),
    section("a", { order: 5 }),
    section("z"),
    section("m"),
  ];
  register(...first);
  const fromOneOrder = snapshotSections().map((entry) => entry.id);

  resetSectionsForTests();
  register(...first.slice().reverse());
  const fromAnotherOrder = snapshotSections().map((entry) => entry.id);

  assert.deepEqual(fromOneOrder, ["a", "b", "m", "z"]);
  assert.deepEqual(fromAnotherOrder, fromOneOrder, "the same registrations in any load order");
});

test("finite orders come first ascending, then the rest by id", () => {
  register(
    section("no-order-b"),
    section("second", { order: 2 }),
    section("no-order-a"),
    section("first", { order: -1 }),
    section("zero", { order: 0 }),
    section("not-sortable", { order: Number.NaN }),
  );

  assert.deepEqual(snapshotSections().map((entry) => entry.id), [
    "first",
    "zero",
    "second",
    "no-order-a",
    "no-order-b",
    "not-sortable",
  ]);
});

test("the id tiebreak is UTF-16 code units, not a locale collation", () => {
  // In a locale-aware comparison `ä` sorts near `a`; by code unit it sorts after `z`.
  register(section("ä"), section("a"), section("Z"));

  assert.deepEqual(snapshotSections().map((entry) => entry.id), ["Z", "a", "ä"]);
});

/** S1. Absent placement is the historical behaviour: after every native section. */
test("a section without a placement lands after every native part", () => {
  register(section("plain"));

  assert.deepEqual(places(), ["plain@after footer"]);
  const resolved = resolutionOf("plain");
  assert.equal(resolved?.requested, "end");
  assert.equal(resolved?.reason, undefined, "the default is honoured, so there is nothing to report");
});

test("an explicit end lands after every native part", () => {
  register(section("last", { placement: "end" }));

  assert.deepEqual(places(), ["last@after footer"]);
});

test("end is the footer part itself, whatever else the host paints", () => {
  // `"end"` is `{ after: "footer" }` (S4): a rail missing its middle parts still ends at the footer,
  // and a footer that paints no frame draws none of our rows — the rule this surface always had.
  register(section("plain"), section("explicit", { placement: "end" }));

  assert.deepEqual(places(snapshotSections(), ["todo", "footer"]), [
    "explicit@after footer",
    "plain@after footer",
  ]);
  assert.deepEqual(places(snapshotSections(), []), [
    "explicit@after footer",
    "plain@after footer",
  ]);
});

/** S5. `"start"` goes before the first painted native part. */
test("start lands before the first painted native part", () => {
  register(section("top", { placement: "start" }));

  assert.deepEqual(places(), ["top@before todo"]);
  assert.equal(resolutionOf("top")?.reason, undefined);
});

test("start follows the first painted part when an earlier one is not painted", () => {
  register(section("top", { placement: "start" }));

  assert.deepEqual(places(snapshotSections(), ["jobs", "agents", "footer"]), ["top@before jobs"]);
});

/** S4/S5. `after` accepts a native rail part, resolved by render. */
test("after a native part lands after that part's own rows", () => {
  register(section("news", { placement: { after: "agents" } }));

  assert.deepEqual(places(), ["news@after agents"]);
});

test("after a native part that is not painted falls to the next painted native slot", () => {
  register(section("news", { placement: { after: "todo" } }));

  assert.deepEqual(places(snapshotSections(), ["jobs", "agents", "footer"]), ["news@after jobs"]);
  const resolved = resolutionOf("news", ["jobs", "agents", "footer"]);
  assert.equal(
    resolved?.reason,
    'the native rail part "todo" is not painted; it landed after jobs',
    "the fallback explains itself",
  );
});

test("after a native part with nothing painted after it lands at the end", () => {
  register(section("news", { placement: { after: "agents" } }));

  assert.deepEqual(places(snapshotSections(), ["todo", "jobs"]), ["news@after footer"]);
  assert.match(resolutionOf("news", ["todo", "jobs"])?.reason ?? "", /is not painted/);
});

/** S3. Several sections after the same anchor are one block, ordered by the S2 rule. */
test("several sections after one anchor sit as a block right after it, ordered by id", () => {
  register(
    section("anchor", { placement: "start" }),
    section("second", { placement: { after: "anchor" } }),
    section("first", { placement: { after: "anchor" } }),
    section("tail"),
  );

  assert.deepEqual(places(), [
    "anchor@before todo",
    "first@before todo",
    "second@before todo",
    "tail@after footer",
  ]);
});

test("a block after a section keeps a finite order ahead of the plain ids", () => {
  register(
    section("anchor"),
    section("plain-b", { placement: { after: "anchor" } }),
    section("plain-a", { placement: { after: "anchor" } }),
    section("numbered", { placement: { after: "anchor" }, order: 3 }),
  );

  assert.deepEqual(places(), [
    "anchor@after footer",
    "numbered@after footer",
    "plain-a@after footer",
    "plain-b@after footer",
  ]);
});

test("an after-anchor block is resolved transitively", () => {
  register(
    section("a", { placement: "start" }),
    section("b", { placement: { after: "a" } }),
    section("c", { placement: { after: "b" } }),
  );

  assert.deepEqual(places(), ["a@before todo", "b@before todo", "c@before todo"]);
  assert.equal(resolutionOf("c")?.anchor, '"b"');
});

/** S5. A hidden or collapsed anchor keeps its place: hiding X must not move its followers. */
test("a follower keeps the slot of an anchor that draws nothing", () => {
  register(
    section("hidden", { placement: "start", defaultVisible: false }),
    section("follower", { placement: { after: "hidden" } }),
    section("plain"),
  );

  assert.deepEqual(places(), [
    "hidden@before todo",
    "follower@before todo",
    "plain@after footer",
  ]);
});

/** S5. A cycle, or a section after itself, falls back to the end. */
test("two sections that would sit after each other both fall back to the end", () => {
  register(
    section("a", { placement: { after: "b" } }),
    section("b", { placement: { after: "a" } }),
  );

  assert.deepEqual(places(), ["a@after footer", "b@after footer"]);
  assert.match(resolutionOf("a")?.reason ?? "", /cycle/);
  assert.match(resolutionOf("b")?.reason ?? "", /cycle/);
});

test("a section that asks to sit after itself falls back to the end", () => {
  register(section("loop", { placement: { after: "loop" } }));

  assert.deepEqual(places(), ["loop@after footer"]);
  assert.match(resolutionOf("loop")?.reason ?? "", /cycle/);
});

test("a section hanging off a broken cycle resolves against the fixed placement", () => {
  register(
    section("a", { placement: { after: "b" } }),
    section("b", { placement: { after: "a" } }),
    section("c", { placement: { after: "a" } }),
  );

  assert.deepEqual(places(), ["a@after footer", "c@after footer", "b@after footer"]);
  assert.equal(resolutionOf("c")?.reason, undefined, "its own request is honoured");
});

/** S5. An anchor nobody registered falls back to the end, and says so. */
test("after an id that is neither a section nor a native part falls back to the end", () => {
  register(section("lost", { placement: { after: "nobody" } }));

  assert.deepEqual(places(), ["lost@after footer"]);
  assert.match(resolutionOf("lost")?.reason ?? "", /neither a registered section nor a native/);
});

/**
 * The id collision the constraints ask about: a section id is free to be `todo`, so one string can
 * name a section AND a native part. The native part wins; the report says so.
 */
test("a native part wins over a section that carries its id", () => {
  register(
    section("todo", { placement: "start" }),
    section("follower", { placement: { after: "todo" } }),
  );

  assert.deepEqual(places(), ["todo@before todo", "follower@after todo"]);
  assert.match(resolutionOf("follower")?.reason ?? "", /native rail part "todo".*wins/);
});

/** S5. A malformed placement is treated as `end` by the resolver, whatever got stored. */
test("a malformed placement resolves to the end", () => {
  // SAFETY: a plugin can pass anything at runtime; the registration reports it and the resolver
  // must still place the section instead of dropping it.
  const malformed = { after: "" } as unknown as SidebarSection["placement"];
  register(section("broken", { placement: malformed }));

  assert.deepEqual(places(), ["broken@after footer"]);
  assert.match(resolutionOf("broken")?.reason ?? "", /malformed/);
});

test("a placement shape the type does not allow still registers and is reported", () => {
  const cases: unknown[] = [
    7,
    null,
    [],
    {},
    { after: "" },
    { after: 5 },
    { after: "todo", extra: true },
  ];

  for (const [index, value] of cases.entries()) {
    resetBusForTests();
    resetSectionsForTests();
    const id = `bad-${index}`;
    // SAFETY: the point of the case is a value the type forbids.
    registerSection(section(id, { placement: value as SidebarSection["placement"] }));

    assert.deepEqual(
      snapshotSections().map((entry) => entry.id),
      [id],
      `${JSON.stringify(value)}: the section still registers`,
    );
    assert.deepEqual(places(), [`${id}@after footer`], "and lands at the end");
    const rejection = getSectionPlacementRejections().find((entry) => entry.sectionId === id);
    assert.ok(rejection !== undefined, `${JSON.stringify(value)}: the bad placement is reported`);
    assert.equal(rejection.value, JSON.stringify(value), "the value is reported verbatim");
  }
});

test("a conforming re-registration clears the placement rejection", () => {
  const bad = { after: "" } as unknown as SidebarSection["placement"];
  registerSection(section("music", { placement: bad }));
  assert.equal(getSectionPlacementRejections().length, 1);

  registerSection(section("music", { placement: { after: "todo" } }));

  assert.deepEqual(getSectionPlacementRejections(), []);
  assert.deepEqual(places(), ["music@after todo"]);
});

test("a valid placement is stored on the section exactly as written", () => {
  const registered = section("music", { placement: { after: "loon.news" } });
  registerSection(registered);

  assert.equal(snapshotSections()[0], registered);
  assert.deepEqual(snapshotSections()[0].placement, { after: "loon.news" });
});

test("nothing painted leaves every section at the end, and start says why", () => {
  register(section("top", { placement: "start" }), section("plain"));

  assert.deepEqual(places(snapshotSections(), []), ["top@after footer", "plain@after footer"]);
  assert.match(resolutionOf("top", [])?.reason ?? "", /no native rail part is painted/);
});

test("the same registrations in any load order draw the same rail", () => {
  const registrations = [
    section("start-b", { placement: "start" }),
    section("start-a", { placement: "start" }),
    section("after-a", { placement: { after: "start-a" } }),
    section("plain-b"),
    section("plain-a"),
    section("native", { placement: { after: "jobs" } }),
    section("ordered", { order: 1 }),
  ];

  const permutations = [
    registrations,
    [...registrations].reverse(),
    [registrations[3], registrations[0], registrations[6], registrations[2], registrations[5], registrations[1], registrations[4]],
  ];

  const answers = permutations.map((permutation) => {
    resetBusForTests();
    resetSectionsForTests();
    register(...permutation);
    return places();
  });

  assert.deepEqual(answers[1], answers[0], "reverse load order, same rail");
  assert.deepEqual(answers[2], answers[0], "one more order, same rail");
  assert.deepEqual(answers[0], [
    "start-a@before todo",
    "after-a@before todo",
    "start-b@before todo",
    "native@after jobs",
    "ordered@after footer",
    "plain-a@after footer",
    "plain-b@after footer",
  ]);
});

/**
 * The sidebar section surface, proven against the fake host in `test/fake-sidebar.ts`.
 *
 * T1 (S9, S4): the fake host models the host's process-global rail state, its `parts` map and the
 * card frame the layout draws from a rail's `cardGroups`. T2 (S1, S2): the section registry on the
 * same process-global bus as the providers — one ordered snapshot, `id` replacement, a disposer
 * that removes exactly one section.
 *
 * The first two tests are the scaffold's own: the fake is not the host, so it must be shown to
 * behave like it (state slot, later registration, framed output) before any section test leans on
 * it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  registerRows,
  registerSection,
  resetBusForTests,
  resetSectionsForTests,
  snapshotProviders,
  snapshotSections,
} from "../src/bus.ts";
import type { RowProvider, SidebarSection } from "../src/types.ts";
import {
  SIDEBAR_STATE_KEY,
  cardTitles,
  fakeState,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const provider = (id: string): RowProvider => ({ id, category: "Layout", rows: () => [] });

const ids = (): string[] => snapshotSections().map((entry) => entry.id);

test.beforeEach(() => {
  resetBusForTests();
  resetSectionsForTests();
  resetSidebar();
});

test("the fake host carries the rail map on the host's process-global state symbol", () => {
  assert.equal(SIDEBAR_STATE_KEY, Symbol.for("gentle-pi.experimental-sidebar.state"));
  assert.equal(renderSidebar(40).join("\n"), "", "an empty host paints nothing");

  registerNativeFooter();
  const footer = fakeState().parts.get("footer");
  assert.ok(footer !== undefined, "the native footer sits in the host's rail map");
  assert.deepEqual(cardTitles(), ["FOOTER"], "the host draws the rail as one framed card");
});

test("the host can register its footer rail after the first frame was painted", () => {
  assert.deepEqual(cardTitles(), []);
  registerNativeFooter();
  assert.deepEqual(cardTitles(), ["FOOTER"]);
});

test("registerSection returns a disposer that removes exactly that section", () => {
  registerSection(section("a"));
  const disposeB = registerSection(section("b"));
  registerSection(section("c"));

  assert.deepEqual(ids(), ["a", "b", "c"]);

  disposeB();

  assert.deepEqual(ids(), ["a", "c"], "the other sections keep their relative order");
});

test("registerSection stores the caller's object unchanged", () => {
  const registered = section("a", {
    title: "MUSIC",
    meta: () => "1 playing",
    lines: () => ["track  -", "album  -"],
    defaultVisible: false,
    order: 3,
  });

  registerSection(registered);

  assert.equal(snapshotSections()[0], registered, "the snapshot hands back the registered object");
  assert.equal(snapshotSections()[0].title, "MUSIC");
  assert.equal(snapshotSections()[0].defaultVisible, false);
  assert.equal(snapshotSections()[0].order, 3);
});

test("a second registration with the same id replaces in place, keeping its position", () => {
  registerSection(section("a"));
  registerSection(section("b"));
  registerSection(section("c"));

  const replacement = section("b", { title: "REPLACED" });
  registerSection(replacement);

  assert.deepEqual(ids(), ["a", "b", "c"], "one entry, original position");
  assert.equal(snapshotSections().length, 3);
  assert.equal(snapshotSections()[1], replacement, "the new registration is the live one");
  assert.equal(snapshotSections()[1].title, "REPLACED");
});

test("the replaced section's disposer does not remove its replacement", () => {
  const disposeFirst = registerSection(section("a"));
  const replacement = section("a", { title: "REPLACED" });
  registerSection(replacement);

  disposeFirst();

  assert.deepEqual(ids(), ["a"], "the stale disposer is a no-op, not a removal of the replacement");
  assert.equal(snapshotSections()[0], replacement);
});

test("a disposer called twice is a no-op the second time", () => {
  registerSection(section("a"));
  const disposeB = registerSection(section("b"));
  registerSection(section("c"));

  disposeB();
  disposeB();

  assert.deepEqual(ids(), ["a", "c"]);
});

test("sections with an order come first, ascending and ties by id", () => {
  registerSection(section("un-ordered-first"));
  registerSection(section("ten", { order: 10 }));
  registerSection(section("one", { order: 1 }));
  registerSection(section("tie-a", { order: 5 }));
  registerSection(section("tie-b", { order: 5 }));
  registerSection(section("un-ordered-second"));

  assert.deepEqual(
    ids(),
    ["one", "tie-a", "tie-b", "ten", "un-ordered-first", "un-ordered-second"],
    "ordered sections sort ascending ahead of the unordered ones, which sort by id",
  );
});

test("a replacement may move a section by changing its order", () => {
  registerSection(section("a", { order: 2 }));
  registerSection(section("b", { order: 1 }));

  registerSection(section("a", { order: 0 }));

  assert.deepEqual(ids(), ["a", "b"]);
});

test("only numbered orders sort; a section without one goes to the tail", () => {
  registerSection(section("zero", { order: 0 }));
  registerSection(section("unordered", { order: undefined }));
  registerSection(section("negative", { order: -3 }));
  registerSection(section("not-a-number", { order: Number.NaN }));

  // The unordered half is ordered by `id`, not by registration order: the S2 tiebreak replaced the
  // registration index so the same registrations always draw the same rail (section-placement S2).
  assert.deepEqual(ids(), ["negative", "zero", "not-a-number", "unordered"]);
});

test("a section snapshot is a stable copy taken at call time", () => {
  registerSection(section("a"));

  const during = snapshotSections();
  const seen: string[] = [];
  for (const entry of during) {
    seen.push(entry.id);
    registerSection(section("late"));
  }

  assert.deepEqual(seen, ["a"]);
  assert.deepEqual(during.map((entry) => entry.id), ["a"]);
  assert.deepEqual(ids(), ["a", "late"]);
});

test("two independent module copies in one process share one section registry", async () => {
  // A query string yields a second module instance with its own module scope — the closest local
  // model of jiti's `moduleCache: false` loading two package copies.
  const secondCopySpecifier = "../src/bus.ts?copy=2";
  const copyTwo: typeof import("../src/bus.ts") = await import(secondCopySpecifier);

  registerSection(section("from-copy-one"));
  copyTwo.registerSection(section("from-copy-two"));

  assert.deepEqual(ids(), ["from-copy-one", "from-copy-two"]);
  assert.deepEqual(
    copyTwo.snapshotSections().map((entry) => entry.id),
    ["from-copy-one", "from-copy-two"],
  );

  const dispose = copyTwo.registerSection(section("shared"));
  assert.deepEqual(ids(), ["from-copy-one", "from-copy-two", "shared"]);
  dispose();
  assert.deepEqual(ids(), ["from-copy-one", "from-copy-two"], "the global registry, not a local one");
});

test("the section list is reachable behind the same bus slot as the providers", () => {
  registerSection(section("a"));
  const slot = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("gentle-shell-bridge.providers")
  ];
  assert.ok(slot !== undefined, "the bus is the provider bus, not a second registry");
});

test("a bus slot created before sections existed keeps its providers and grows a section list", () => {
  // A copy of this package that predates sections writes `{ entries }` only. Reading that slot
  // must not throw away the providers already registered in it.
  const earlierProvider = provider("earlier");
  const slot = globalThis as unknown as Record<symbol, unknown>;
  slot[Symbol.for("gentle-shell-bridge.providers")] = { entries: [{ provider: earlierProvider }] };

  registerSection(section("a"));

  assert.deepEqual(ids(), ["a"], "the section list was added in place");
  assert.deepEqual(
    snapshotProviders().map((entry) => entry.id),
    ["earlier"],
    "the providers the earlier copy registered are still there",
  );
});

test("resetSectionsForTests clears sections and leaves providers registered", () => {
  registerRows(provider("p"));
  registerSection(section("a"));

  resetSectionsForTests();

  assert.deepEqual(ids(), []);
  assert.deepEqual(
    snapshotProviders().map((entry) => entry.id),
    ["p"],
    "provider state is not the section state",
  );
});

test("the internal section seams are not on the public entry", async () => {
  const entry = await import("../src/index.ts");
  assert.equal("resetSectionsForTests" in entry, false);
  assert.equal("snapshotSections" in entry, false);
});

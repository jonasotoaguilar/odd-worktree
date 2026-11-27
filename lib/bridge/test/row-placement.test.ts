/**
 * Row placement (S1, S2, S3, S5): where a provider's block of customize rows lands inside its
 * category, and what the order inside one slot is made of.
 *
 * Placement is REGISTRATION data, like `order`: nothing here is persisted, and nothing here depends
 * on the order the plugins happened to load in. The capture backend only consumes the per-category
 * blocks this resolver returns; the fallbacks are decided once, here, so `/bridge-status` and the
 * menu cannot disagree about where a block went.
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as bus from "../src/bus.ts";
import { installCaptureBackend } from "../src/capture.ts";
import type { CustomizeRow, RowProvider } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const HOST = ["Layout", "Banner", "Cards", "Settings"] as const;

const provider = (id: string, extra: Partial<RowProvider> = {}): RowProvider => ({
  id,
  category: "Layout",
  rows: () => [],
  ...extra,
});

/** `category/id@landing` for every block, in resolution order: the whole answer in one string. */
const places = (
  providers: readonly RowProvider[],
  hostCategories: readonly string[] = HOST,
): string[] =>
  bus.resolveRowPlacements(providers, hostCategories).map(
    (entry) => `${entry.category}/${entry.provider.id}@${bus.rowPlacementLandingText(entry)}`,
  );

const resolutionOf = (
  id: string,
  providers: readonly RowProvider[],
  hostCategories: readonly string[] = HOST,
) =>
  bus.resolveRowPlacements(providers, hostCategories).find(
    (entry) => entry.provider.id === id,
  );

test.beforeEach(() => {
  bus.resetBusForTests();
});

/** S2. Registration order decides nothing: the same providers in any load order draw the same rows. */
test("the same registrations in any load order draw the same rows", () => {
  const registrations = [
    provider("start-b", { placement: "start" }),
    provider("start-a", { placement: "start" }),
    provider("after-a", { placement: { after: "start-a" } }),
    provider("plain-b"),
    provider("plain-a"),
    provider("numbered", { order: 1 }),
    provider("early", { order: -2, placement: { after: "start-a" } }),
  ];
  const permutations = [
    registrations,
    [...registrations].reverse(),
    [
      registrations[3],
      registrations[0],
      registrations[6],
      registrations[2],
      registrations[5],
      registrations[1],
      registrations[4],
    ],
  ];

  const answers = permutations.map((permutation) => {
    bus.resetBusForTests();
    for (const entry of permutation) bus.registerRows(entry);
    return places(bus.snapshotProviders());
  });

  assert.deepEqual(answers[1], answers[0], "reverse load order, the same rows");
  assert.deepEqual(answers[2], answers[0], "one more order, the same rows");
  assert.deepEqual(answers[0], [
    "Layout/start-a@start",
    'Layout/early@after "start-a"',
    'Layout/after-a@after "start-a"',
    "Layout/start-b@start",
    "Layout/numbered@end",
    "Layout/plain-a@end",
    "Layout/plain-b@end",
  ]);
});

/** S2. Finite `order` first, ascending, then the rest; ties by id. */
test("a finite order comes first ascending, then the rest by id", () => {
  const providers = [
    provider("b", { order: 5 }),
    provider("a", { order: 5 }),
    provider("z"),
    provider("m", { order: -1 }),
    provider("nan", { order: Number.NaN }),
  ];

  assert.deepEqual(places(providers), [
    "Layout/m@end",
    "Layout/a@end",
    "Layout/b@end",
    "Layout/nan@end",
    "Layout/z@end",
  ]);
});

test("the id tiebreak is UTF-16 code units, not a locale collation", () => {
  // In a locale-aware comparison `ä` sorts near `a`; by code unit it sorts after `z`.
  assert.deepEqual(places([provider("ä"), provider("a"), provider("Z")]), [
    "Layout/Z@end",
    "Layout/a@end",
    "Layout/ä@end",
  ]);
});

/** S3. Several providers after the same anchor are one block, ordered by the S2 rule. */
test("several providers after one anchor sit as a block right after it, ordered by id", () => {
  const providers = [
    provider("anchor", { placement: "start" }),
    provider("second", { placement: { after: "anchor" } }),
    provider("first", { placement: { after: "anchor" } }),
    provider("tail", { placement: "end" }),
  ];

  assert.deepEqual(places(providers), [
    "Layout/anchor@start",
    'Layout/first@after "anchor"',
    'Layout/second@after "anchor"',
    "Layout/tail@end",
  ]);
});

test("a block after a provider keeps a finite order ahead of the plain ids", () => {
  const providers = [
    provider("anchor", { placement: "start" }),
    provider("plain-b", { placement: { after: "anchor" } }),
    provider("plain-a", { placement: { after: "anchor" } }),
    provider("numbered", { placement: { after: "anchor" }, order: 3 }),
  ];

  assert.deepEqual(places(providers), [
    "Layout/anchor@start",
    'Layout/numbered@after "anchor"',
    'Layout/plain-a@after "anchor"',
    'Layout/plain-b@after "anchor"',
  ]);
});

/** S3. Chains resolve transitively: A after B after C. */
test("an after-anchor chain is resolved transitively", () => {
  const providers = [
    provider("a", { placement: "start" }),
    provider("b", { placement: { after: "a" } }),
    provider("c", { placement: { after: "b" } }),
  ];

  assert.deepEqual(places(providers), [
    "Layout/a@start",
    'Layout/b@after "a"',
    'Layout/c@after "b"',
  ]);
  assert.equal(resolutionOf("c", providers)?.anchor, '"b"');
});

/** S5. A cycle, or a provider after itself, falls back to the end with a reason. */
test("two providers that would sit after each other both fall back to the end", () => {
  const providers = [
    provider("a", { placement: { after: "b" } }),
    provider("b", { placement: { after: "a" } }),
    provider("c", { placement: { after: "a" } }),
  ];

  assert.deepEqual(places(providers), [
    "Layout/a@end",
    'Layout/c@after "a"',
    "Layout/b@end",
  ]);
  assert.match(resolutionOf("a", providers)?.reason ?? "", /cycle/);
  assert.match(resolutionOf("b", providers)?.reason ?? "", /cycle/);
  assert.equal(
    resolutionOf("c", providers)?.reason,
    undefined,
    "a provider leading into a broken cycle still draws after its anchor",
  );
});

test("a provider that asks to sit after itself falls back to the end", () => {
  const providers = [provider("loop", { placement: { after: "loop" } })];

  assert.deepEqual(places(providers), ["Layout/loop@end"]);
  assert.match(resolutionOf("loop", providers)?.reason ?? "", /cycle/);
});

/** S5. An anchor nobody registered falls back to the end, and says so. */
test("after an id that is not a registered provider falls back to the end", () => {
  const providers = [provider("lost", { placement: { after: "nobody" } })];
  const resolved = resolutionOf("lost", providers);

  assert.deepEqual(places(providers), ["Layout/lost@end"]);
  assert.equal(resolved?.requested, 'after "nobody"');
  assert.match(resolved?.reason ?? "", /not a registered row provider id/);
});

/** S5. An anchor that exists in another category cannot be honoured in this one. */
test("after a provider in another category falls back to the end", () => {
  const providers = [
    provider("other", { category: "Banner" }),
    provider("follower", { category: "Layout", placement: { after: "other" } }),
  ];
  const resolved = resolutionOf("follower", providers);

  assert.deepEqual(places(providers), ["Banner/other@end", "Layout/follower@end"]);
  assert.match(resolved?.reason ?? "", /is in the category "Banner"/);
});

/** S1. `"start"` sits before the first host row of the provider's category. */
test("start lands before the category's first row", () => {
  const providers = [
    provider("plain"),
    provider("top", { placement: "start" }),
  ];

  assert.deepEqual(places(providers), ["Layout/top@start", "Layout/plain@end"]);
  const resolved = resolutionOf("top", providers);
  assert.equal(resolved?.requested, "start");
  assert.equal(resolved?.reason, undefined, "the request was honoured, so there is nothing to report");
});

/** S5. A category the host did not build has no row to sit before or after. */
test("start and after on a plugin-created category fall back to the end with a reason", () => {
  const providers = [
    provider("created", { category: "Plugins", placement: "start" }),
    provider("after-created", { category: "Plugins", placement: { after: "created" } }),
    provider("plain", { category: "Plugins" }),
  ];

  assert.deepEqual(places(providers, ["Layout"]), [
    "Plugins/after-created@end",
    "Plugins/created@end",
    "Plugins/plain@end",
  ]);
  assert.match(resolutionOf("created", providers, ["Layout"])?.reason ?? "", /did not build/);
  assert.match(
    resolutionOf("after-created", providers, ["Layout"])?.reason ?? "",
    /did not build/,
  );
  assert.equal(
    resolutionOf("plain", providers, ["Layout"])?.reason,
    undefined,
    "the default `end` needs no host row, so it is still honoured",
  );
});

/** The host-category input is a set: how a caller collected it cannot change the answer. */
test("the host-category collection order never changes the answer", () => {
  const providers = [
    provider("top", { placement: "start" }),
    provider("after-top", { placement: { after: "top" } }),
    provider("plain"),
  ];

  assert.deepEqual(places(providers, ["Banner", "Layout", "Layout"]), places(providers, [
    "Layout",
    "Banner",
  ]));
  assert.deepEqual(
    bus.resolveRowPlacements(providers, ["Layout", "Banner"]),
    bus.resolveRowPlacements(providers, ["Banner", "Layout", "Layout"]),
  );
});

/** S5. A malformed placement is rejected at registration, reported, and still registers as end. */
test("a malformed placement is rejected and the provider still registers as end", () => {
  const malformed = { after: "" } as unknown as RowProvider["placement"];
  const registered = provider("broken", { placement: malformed });

  const dispose = bus.registerRows(registered);

  assert.deepEqual(bus.snapshotProviders(), [registered], "the bus is unchanged apart from the record");
  assert.deepEqual(bus.snapshotProviders()[0], registered);
  const rejections = bus.getRowPlacementRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].providerId, "broken");
  assert.equal(rejections[0].value, '{"after":""}', "the value is reported verbatim");
  assert.match(rejections[0].reason, /non-empty string/);
  assert.deepEqual(places(bus.snapshotProviders()), ["Layout/broken@end"]);
  assert.match(resolutionOf("broken", bus.snapshotProviders())?.reason ?? "", /malformed/);

  dispose();
  assert.deepEqual(bus.snapshotProviders(), []);
  assert.deepEqual(bus.getRowPlacementRejections(), [], "the disposer removes its record too");
});

test("a placement shape the type does not allow is rejected and reported", () => {
  const cases: unknown[] = [
    7,
    null,
    [],
    {},
    { after: "" },
    { after: 5 },
    { after: "anchor", extra: true },
  ];

  for (const [index, value] of cases.entries()) {
    bus.resetBusForTests();
    const id = `bad-${index}`;
    // SAFETY: the point of the case is a value the type forbids.
    bus.registerRows(provider(id, { placement: value as RowProvider["placement"] }));

    assert.deepEqual(
      bus.snapshotProviders().map((entry) => entry.id),
      [id],
      `${JSON.stringify(value)}: the provider still registers`,
    );
    assert.deepEqual(places(bus.snapshotProviders()), [`Layout/${id}@end`], "and lands at the end");
    const rejection = bus.getRowPlacementRejections().find((entry) => entry.providerId === id);
    assert.ok(rejection !== undefined, `${JSON.stringify(value)}: the bad placement is reported`);
    assert.equal(rejection.value, JSON.stringify(value), "the value is reported verbatim");
  }
});

test("a conforming re-registration clears the placement rejection", () => {
  const malformed = { after: "" } as unknown as RowProvider["placement"];
  bus.registerRows(provider("anchor", { placement: "start" }));
  bus.registerRows(provider("broken", { placement: malformed, order: 1 }));
  assert.equal(bus.getRowPlacementRejections().length, 1);

  bus.registerRows(provider("broken", { placement: { after: "anchor" } }));

  assert.deepEqual(bus.getRowPlacementRejections(), []);
  assert.deepEqual(places(bus.snapshotProviders()), [
    "Layout/anchor@start",
    'Layout/broken@after "anchor"',
  ]);
});

test("a valid placement is stored on the provider exactly as written", () => {
  const registered = provider("music", { placement: { after: "loon.news" } });
  bus.registerRows(registered);

  assert.equal(bus.snapshotProviders()[0], registered);
  assert.deepEqual(bus.snapshotProviders()[0].placement, { after: "loon.news" });
});

test("the resolver never throws on a malformed stored placement", () => {
  const broken = {
    id: "broken",
    category: "Layout",
    rows: () => [],
    placement: { after: "" },
  } as unknown as RowProvider;

  assert.doesNotThrow(() => bus.resolveRowPlacements([broken], HOST));
  assert.deepEqual(places([broken]), ["Layout/broken@end"]);
});

// ---------------------------------------------------------------------------------------------
// The same rules through the capture splices (S4, S5, S6)
// ---------------------------------------------------------------------------------------------

const rowLabels = (rows: readonly CustomizeRow[]): string[] =>
  rows.map((row) => (typeof row.label === "function" ? row.label() : (row.label ?? "")));

const captureHostRows = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Banner", label: "Banner: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

test("the capture backend keeps a start block and its after follower inside the page", () => {
  const rows = captureHostRows();
  const host = createFakeHost({ rows });
  bus.registerRows({
    id: "loon.top",
    category: "Layout",
    placement: "start",
    rows: () => [{ label: "Loon top", action: () => {} }],
  });
  bus.registerRows({
    id: "loon.next",
    category: "Layout",
    placement: { after: "loon.top" },
    rows: () => [{ label: "Loon next", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual(rowLabels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Loon top",
    "Loon next",
    "Layout: builtin",
  ]);
  assert.deepEqual(
    [...new Set(host.categories())],
    ["Cards", "Banner", "Layout"],
    "the host's page list is unchanged: the provisional insert cannot hide an existing page",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { RowProvider } from "../src/types.ts";

const withId = (id: string, category = "Layout"): RowProvider => ({
  id,
  category,
  rows: () => [],
});

// One shared bus for the whole file; every test resets it through the internal seam.
// `src/index.ts` deliberately does not re-export the seam (asserted below).
const bus = await import("../src/bus.ts");
const { getRowPlacementRejections, registerRows, snapshotProviders, resetBusForTests } = bus;

const ids = () => snapshotProviders().map((provider: RowProvider) => provider.id);

test.beforeEach(() => {
  resetBusForTests();
});

test("providers are returned in registration order", () => {
  registerRows(withId("a"));
  registerRows(withId("b"));
  registerRows(withId("c"));
  assert.deepEqual(ids(), ["a", "b", "c"]);
});

test("an empty bus returns an empty snapshot", () => {
  assert.deepEqual(snapshotProviders(), []);
});

test("the disposer removes only its own provider", () => {
  registerRows(withId("a"));
  const disposeB = registerRows(withId("b"));
  registerRows(withId("c"));

  disposeB();

  assert.deepEqual(ids(), ["a", "c"]);
});

test("the disposer keeps the remaining providers' relative order", () => {
  const disposeA = registerRows(withId("a"));
  registerRows(withId("b"));
  registerRows(withId("c"));

  disposeA();

  assert.deepEqual(ids(), ["b", "c"]);
});

test("registering an existing id replaces in place and keeps its position", () => {
  registerRows(withId("a", "Layout"));
  registerRows(withId("b", "Banner"));
  registerRows(withId("c", "Cards"));

  const replacement = withId("b", "Layout");
  registerRows(replacement);

  assert.deepEqual(ids(), ["a", "b", "c"], "one entry, original position");
  assert.equal(snapshotProviders().length, 3);
  assert.equal(snapshotProviders()[1], replacement, "the new provider object is the live one");
  assert.equal(snapshotProviders()[1].category, "Layout");
});

test("the replaced provider's disposer does not remove its replacement", () => {
  const disposeFirst = registerRows(withId("a"));
  const replacement = withId("a", "Banner");
  registerRows(replacement);

  disposeFirst();

  assert.deepEqual(ids(), ["a"], "the stale disposer is a no-op, not a removal of the replacement");
  assert.equal(snapshotProviders()[0], replacement);
});

test("a disposer called twice is a no-op the second time", () => {
  registerRows(withId("a"));
  const disposeB = registerRows(withId("b"));
  registerRows(withId("c"));

  disposeB();
  disposeB();

  assert.deepEqual(ids(), ["a", "c"]);
});

test("a disposer after a reset cannot remove a later provider", () => {
  const disposeA = registerRows(withId("a"));
  resetBusForTests();
  registerRows(withId("a"));

  disposeA();

  assert.deepEqual(ids(), ["a"], "the pre-reset disposer must not touch the new registration");
});

test("a snapshot is a stable copy: registering during iteration does not change it", () => {
  registerRows(withId("a"));

  const during = snapshotProviders();
  const seen: string[] = [];
  for (const provider of during) {
    seen.push(provider.id);
    registerRows(withId("late"));
  }

  assert.deepEqual(seen, ["a"]);
  assert.deepEqual(during.map((provider: RowProvider) => provider.id), ["a"]);
  assert.deepEqual(ids(), ["a", "late"]);
});

test("two independent module copies in one process share one bus", async () => {
  // Node's ESM loader keys modules by resolved URL, so a query string yields a second instance
  // of the same source with its own module scope — the closest local model of jiti's
  // `moduleCache: false` loading of two package copies. The specifier is computed so `tsc`
  // types it as a dynamic import instead of trying to resolve a URL query on disk.
  const secondCopySpecifier = "../src/bus.ts?copy=2";
  const copyTwo: typeof bus = await import(secondCopySpecifier);
  assert.notEqual(copyTwo, bus, "the second import must be a distinct module instance");

  resetBusForTests();
  registerRows(withId("from-copy-one"));
  copyTwo.registerRows(withId("from-copy-two"));

  assert.deepEqual(ids(), ["from-copy-one", "from-copy-two"]);
  assert.deepEqual(copyTwo.snapshotProviders().map((p: RowProvider) => p.id), [
    "from-copy-one",
    "from-copy-two",
  ]);
});

test("a disposer from another module copy removes its provider", async () => {
  const secondCopySpecifier = "../src/bus.ts?copy=2";
  const copyTwo: typeof bus = await import(secondCopySpecifier);

  const dispose = copyTwo.registerRows(withId("shared"));
  registerRows(withId("local"));
  assert.deepEqual(ids(), ["shared", "local"]);

  dispose();

  assert.deepEqual(ids(), ["local"], "the visible registry is the process-global one");
});

test("the bus lives on globalThis behind a stable Symbol.for key", () => {
  registerRows(withId("a"));
  const slot = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("gentle-shell-bridge.providers")
  ];
  assert.ok(slot !== undefined, "the registration state must sit on globalThis");
  assert.notEqual(
    Symbol.for("gentle-shell-bridge.providers"),
    Symbol.for("gentle-pi.customize-row-providers"),
    "the bridge bus must not reuse the hook registry key",
  );
});

test("the public entry does not expose the test-only reset seam", async () => {
  const entry = await import("../src/index.ts");
  assert.equal("resetBusForTests" in entry, false);
  assert.equal("registerRows" in entry, true);
});

test("a placement rejection never changes registration order or replacement in place", () => {
  const malformed = { after: "" } as unknown as RowProvider["placement"];
  registerRows(withId("a", "Layout"));
  // SAFETY: a plugin can pass anything at runtime; the bus must still store exactly one entry.
  registerRows({ ...withId("b", "Layout"), placement: malformed });
  registerRows(withId("c", "Layout"));

  assert.deepEqual(ids(), ["a", "b", "c"], "the provider is still registered, in its position");
  assert.equal(getRowPlacementRejections().length, 1);

  const replacement = withId("b", "Layout");
  registerRows(replacement);

  assert.deepEqual(ids(), ["a", "b", "c"], "replacement happens in place");
  assert.equal(snapshotProviders()[1], replacement, "the new provider object is the live one");
  assert.deepEqual(getRowPlacementRejections(), [], "a conforming replacement clears the record");
});

test("a disposer removes the placement rejection it created", () => {
  const malformed = { after: "" } as unknown as RowProvider["placement"];
  const dispose = registerRows({ ...withId("a", "Layout"), placement: malformed });

  assert.equal(getRowPlacementRejections().length, 1);
  dispose();

  assert.deepEqual(snapshotProviders(), []);
  assert.deepEqual(getRowPlacementRejections(), []);
});

/**
 * Transcript transforms on the bus (S1): the same entry discipline providers, sections and card
 * styles already have — validated id, optional `order`, replace-in-place on the same id, an exact
 * disposer, an ordered snapshot, and one process-global list shared by every copy of the package.
 *
 * The published object is checked here too: `registerTransform` is on it, it is the working
 * function (not a stale copy), and the test-only seams stay off `src/index.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE_API_KEY, publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import {
  registerTransform,
  resetBusForTests,
  resetTransformsForTests,
  snapshotTransforms,
} from "../src/bus.ts";
import type { TransformContext, TranscriptTransform } from "../src/types.ts";

const withId = (id: string, order?: number): TranscriptTransform => ({
  id,
  ...(order === undefined ? {} : { order }),
  transform: (lines) => lines,
});

const ids = (): string[] => snapshotTransforms().map((transform) => transform.id);

test.beforeEach(() => {
  resetBridgeApiForTests();
  resetBusForTests();
  resetTransformsForTests();
});

// ---------------------------------------------------------------------------------------------
// Ordering, replacement and the disposer
// ---------------------------------------------------------------------------------------------

test("transforms are returned in registration order", () => {
  registerTransform(withId("a"));
  registerTransform(withId("b"));
  registerTransform(withId("c"));

  assert.deepEqual(ids(), ["a", "b", "c"], "no order: registration order decides");
});

test("an empty list is an empty snapshot", () => {
  assert.deepEqual(snapshotTransforms(), []);
});

test("transforms with an order come first, ascending, then the unordered ones in registration order", () => {
  registerTransform(withId("plain-b"));
  registerTransform(withId("late", 30));
  registerTransform(withId("plain-a"));
  registerTransform(withId("early", 10));
  registerTransform(withId("not-a-key", Number.NaN));

  assert.deepEqual(ids(), ["early", "late", "plain-b", "plain-a", "not-a-key"]);
});

test("registering an existing id replaces it in place and keeps its position", () => {
  registerTransform(withId("a"));
  registerTransform(withId("b"));
  registerTransform(withId("c"));

  const replacement = withId("b", 5);
  registerTransform(replacement);

  assert.deepEqual(ids(), ["b", "a", "c"], "one entry, and the order it earned now applies");
  assert.equal(snapshotTransforms()[0], replacement, "the new registration is the live one");
});

test("the replaced transform's disposer does not remove its replacement", () => {
  const disposeFirst = registerTransform(withId("a"));
  const replacement = withId("a");
  registerTransform(replacement);

  disposeFirst();

  assert.deepEqual(ids(), ["a"]);
  assert.equal(snapshotTransforms()[0], replacement, "the stale disposer is a no-op");
});

test("a disposer called twice is a no-op the second time", () => {
  registerTransform(withId("a"));
  const disposeB = registerTransform(withId("b"));
  registerTransform(withId("c"));

  disposeB();
  disposeB();

  assert.deepEqual(ids(), ["a", "c"]);
});

test("a disposer after a reset cannot remove a later registration", () => {
  const disposeA = registerTransform(withId("a"));
  resetTransformsForTests();
  registerTransform(withId("a"));

  disposeA();

  assert.deepEqual(ids(), ["a"], "the pre-reset disposer must not touch the new registration");
});

test("a snapshot is a stable copy: registering during iteration does not change it", () => {
  registerTransform(withId("a"));

  const during = snapshotTransforms();
  for (const transform of during) {
    assert.equal(transform.id, "a");
    registerTransform(withId("late"));
  }

  assert.deepEqual(during.map((transform) => transform.id), ["a"]);
  assert.deepEqual(ids(), ["a", "late"], "the registry itself did grow");
});

// ---------------------------------------------------------------------------------------------
// What a registration must satisfy, checked BEFORE anything is stored
// ---------------------------------------------------------------------------------------------

test("a bad id is rejected with the section/row rule, and nothing is stored", () => {
  for (const id of ["", "   ", "__proto__", "constructor", "prototype", "a\u0000b", 42, undefined]) {
    assert.throws(
      () => registerTransform(withId(id as unknown as string)),
      /invalid transform id/u,
      `id ${JSON.stringify(id)} must be rejected`,
    );
  }

  assert.deepEqual(ids(), []);
});

test("a transform that is not a function is rejected and nothing is stored", () => {
  assert.throws(
    () =>
      registerTransform({
        id: "loon.bad",
        transform: "lines",
      } as unknown as TranscriptTransform),
    /invalid transform "loon\.bad": transform must be a function/u,
  );

  assert.deepEqual(ids(), []);
});

test("the transform receives the lines and the width the host rendered at", () => {
  const seen: Array<{ lines: readonly string[]; width: number }> = [];
  registerTransform({
    id: "loon.spy",
    transform: (lines: readonly string[], ctx: TransformContext): readonly string[] => {
      seen.push({ lines, width: ctx.width });
      return lines;
    },
  });

  const registered = snapshotTransforms()[0];
  assert.ok(registered !== undefined);
  const input = ["one", "two"];
  assert.equal(registered.transform(input, { width: 40 }), input);
  assert.deepEqual(seen, [{ lines: input, width: 40 }]);
});

// ---------------------------------------------------------------------------------------------
// Process-global, like every other registration list
// ---------------------------------------------------------------------------------------------

test("two module copies in one process share one transform list", async () => {
  const secondCopySpecifier = "../src/bus.ts?copy=2";
  const copyTwo = (await import(secondCopySpecifier)) as typeof import("../src/bus.ts");
  assert.notEqual(copyTwo, await import("../src/bus.ts"));

  registerTransform(withId("from-copy-one"));
  copyTwo.registerTransform(withId("from-copy-two"));

  assert.deepEqual(ids(), ["from-copy-one", "from-copy-two"]);
  assert.deepEqual(
    copyTwo.snapshotTransforms().map((transform) => transform.id),
    ["from-copy-one", "from-copy-two"],
  );
});

test("the transform list lives on the process-global bus slot, not on module scope", () => {
  registerTransform(withId("a"));
  const slot = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("gentle-shell-bridge.providers")
  ];

  assert.ok(typeof slot === "object" && slot !== null);
  assert.deepEqual(
    (slot as { transforms: Array<{ transform: TranscriptTransform }> }).transforms.map(
      (entry) => entry.transform.id,
    ),
    ["a"],
  );
});

// ---------------------------------------------------------------------------------------------
// The published object and the public entry
// ---------------------------------------------------------------------------------------------

test("the published API object carries registerTransform, and it is the working function", () => {
  const api = publishBridgeApi();
  const register = api.registerTransform;

  assert.equal(typeof register, "function", "S1: the transform surface is on the object");
  assert.ok(
    (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_API_KEY] === api,
    "and the slot holds that object",
  );

  const dispose = register?.call(api, withId("loon.one")) ?? (() => {});
  assert.deepEqual(ids(), ["loon.one"]);

  dispose();
  assert.deepEqual(ids(), []);
});

test("the public entry exports registerTransform and keeps the test seams internal", async () => {
  const entry = (await import("../src/index.ts")) as Record<string, unknown>;

  assert.equal(typeof entry.registerTransform, "function");
  for (const seam of [
    "snapshotTransforms",
    "resetTransformsForTests",
    "applyTransforms",
    "getTransformFrameOutcomes",
    "resetTransformPipelineForTests",
  ]) {
    assert.equal(seam in entry, false, `${seam} must not be public`);
  }
});

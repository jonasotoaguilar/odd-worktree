import assert from "node:assert/strict";
import test from "node:test";

import { armBridge } from "../src/arm.ts";
import { registerRows, resetBusForTests } from "../src/bus.ts";
import { getCaptureDiagnostics, resetCaptureStateForTests } from "../src/capture.ts";
import { getHookDiagnostics, resetHookStateForTests } from "../src/hook.ts";
import type { CustomizeRow, RowProvider } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const CAPTURE_WRAPPED = Symbol.for("gentle-shell-bridge.capture.wrapped.v1");

const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;
const clearHook = (): void => {
  delete hookSlot()[HOOK_KEY];
};

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
});

test.afterEach(() => {
  clearHook();
  resetHookStateForTests();
});

const labelsProvider = (id: string, category: string, labels: string[]): RowProvider => ({
  id,
  category,
  rows: () => labels.map((label) => ({ label, action: () => {} })),
});

interface PushedProvider {
  id: string;
  rows: (ctx?: unknown) => CustomizeRow[];
}

test("selects the hook backend and patches nothing on ui", () => {
  const registry: PushedProvider[] = [];
  hookSlot()[HOOK_KEY] = registry;
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Hooked row"]));
  const customBefore = host.ui.custom;

  const result = armBridge(host.ui);

  assert.deepEqual(result, { outcome: "hooked", backend: "hook" });
  assert.equal(host.ui.custom, customBefore, "ui.custom identity is unchanged");
  assert.equal(Object.hasOwn(host.ui, CAPTURE_WRAPPED), false, "no marker on the instance");
  const proto: object | null = Object.getPrototypeOf(host.ui) as object | null;
  assert.equal(
    proto === null ? false : Object.hasOwn(proto, CAPTURE_WRAPPED),
    false,
    "no marker on the prototype",
  );
  assert.equal(getCaptureDiagnostics().armedTargets, 0, "the capture backend never armed");
  assert.equal(registry.length, 1);

  // Rows land through the registry's own call path.
  assert.deepEqual(
    registry[0].rows({}).map((row) => row.label),
    ["Hooked row"],
  );
});

test("an unusable hook shape falls back to capture and records why", () => {
  hookSlot()[HOOK_KEY] = { register: 5 };
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Fallback row"]));

  const result = armBridge(host.ui);

  assert.deepEqual(result, {
    outcome: "fallback-capture",
    backend: "capture",
    reason: "hook-unusable",
  });
  assert.equal(getHookDiagnostics().shape, "unusable");

  host.buildMenu();
  assert.deepEqual(host.rendered().slice(4), ["Fallback row"]);
  assert.equal(host.invalidateCount(), 1);
});

test("arms capture when the host exposes no registry", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Captured row"]));

  const result = armBridge(host.ui);

  assert.deepEqual(result, { outcome: "capture-armed", backend: "capture" });
  host.buildMenu();
  assert.deepEqual(host.rendered().slice(4), ["Captured row"]);
});

test("two session_start arms wrap once and inject once", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Once"]));

  const first = armBridge(host.ui);
  const second = armBridge(host.ui);

  assert.deepEqual(first, { outcome: "capture-armed", backend: "capture" });
  assert.deepEqual(second, { outcome: "already-armed", backend: "capture" });
  assert.equal(getCaptureDiagnostics().armedTargets, 1, "one wrapper, not two");

  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    ["Once"],
  );
  assert.equal(host.invalidateCount(), 1, "one invalidate per menu build");

  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    ["Once"],
    "a second build of the same menu still injects once",
  );
  assert.equal(host.invalidateCount(), 1);
});

test("a prototype-only ui wraps where custom was found, and a second arm is a no-op", () => {
  const host = createFakeHost({ customShape: "prototype" });
  registerRows(labelsProvider("p1", "Cards", ["Proto row"]));

  const first = armBridge(host.ui);
  const second = armBridge(host.ui);

  assert.deepEqual(first, { outcome: "capture-armed", backend: "capture" });
  assert.deepEqual(second, { outcome: "already-armed", backend: "capture" });
  assert.equal(Object.hasOwn(host.ui, "custom"), false, "the instance gained no own custom");
  const proto: object | null = Object.getPrototypeOf(host.ui) as object | null;
  assert.equal(
    proto === null ? false : Object.hasOwn(proto, CAPTURE_WRAPPED),
    true,
    "the prototype carries the wrapper",
  );

  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Proto row"),
    ["Proto row"],
  );
  assert.equal(host.invalidateCount(), 1);
});

test("a no-UI context is a reported no-op, not a throw", () => {
  assert.deepEqual(armBridge(undefined), {
    outcome: "no-ui",
    backend: "none",
    reason: "ui-missing",
  });
  assert.deepEqual(armBridge(null), {
    outcome: "no-ui",
    backend: "none",
    reason: "ui-missing",
  });
  assert.deepEqual(armBridge({}), {
    outcome: "no-ui",
    backend: "none",
    reason: "custom-missing",
  });
});

test("importing the arm module has no side effects", async () => {
  const armedBefore = getCaptureDiagnostics().armedTargets;
  const mapBefore = Array.prototype.map;

  // The query string is what makes a second module instance, so the specifier is computed: `tsc`
  // types a non-literal dynamic import as a value import, not as a path to resolve on disk.
  const freshSpecifier = "../src/arm.ts?fresh=1";
  const fresh: typeof import("../src/arm.ts") = await import(freshSpecifier);

  assert.equal(getCaptureDiagnostics().armedTargets, armedBefore, "import arms nothing");
  assert.equal(Array.prototype.map, mapBefore, "import patches nothing");
  assert.equal(typeof fresh.armBridge, "function");

  // A menu built without arming must show no provider rows: nothing armed itself on import.
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Must not appear"]));
  host.buildMenu();
  assert.deepEqual(host.rendered().slice(4), []);
});

test("the same providers produce the same rows through either backend", () => {
  const providers = (): void => {
    registerRows(labelsProvider("first", "Cards", ["First a"]));
    registerRows({
      id: "boom",
      category: "Banner",
      rows: () => {
        throw new Error("shared provider exploded");
      },
    });
    registerRows(labelsProvider("second", "Layout", ["Second b"]));
  };

  // Capture backend.
  providers();
  const host = createFakeHost();
  armBridge(host.ui);
  host.buildMenu();
  const capturedLabels = host.rendered().slice(4);

  // Hook backend, fresh bus with the same providers.
  resetBusForTests();
  resetCaptureStateForTests();
  providers();
  const registry: PushedProvider[] = [];
  hookSlot()[HOOK_KEY] = registry;
  armBridge(createFakeHost().ui);
  const hookedLabels = registry[0].rows({}).map((row) => String(row.label));

  assert.deepEqual(capturedLabels, ["First a", "Second b"]);
  assert.deepEqual(hookedLabels, capturedLabels, "same providers, same rows, same order");
});

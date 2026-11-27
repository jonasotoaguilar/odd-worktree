import assert from "node:assert/strict";
import test from "node:test";

import { registerRows, resetBusForTests } from "../src/bus.ts";
import {
  getHookDiagnostics,
  installHookBackend,
  resetHookStateForTests,
} from "../src/hook.ts";
import type { CustomizeRow, RowProvider } from "../src/types.ts";

/**
 * The host registry key (S4). No host has been observed emitting it, so the tests define the
 * accepted shapes; the module documents that the branch is unverified.
 */
const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");

/** The only writes these tests make to globalThis, cleaned up in afterEach. */
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;
const setHook = (value: unknown): void => {
  hookSlot()[HOOK_KEY] = value;
};
const clearHook = (): void => {
  delete hookSlot()[HOOK_KEY];
};

test.beforeEach(() => {
  resetBusForTests();
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

test("no registry at all is reported as no-hook", () => {
  const result = installHookBackend();

  assert.equal(result.installed, false);
  assert.equal(result.outcome, "no-hook");
});

test("an array registry receives exactly one fan-out provider", () => {
  const registry: PushedProvider[] = [];
  setHook(registry);
  registerRows(labelsProvider("p1", "Cards", ["Row one"]));

  const first = installHookBackend();
  const second = installHookBackend();

  assert.equal(first.installed, true);
  assert.equal(first.outcome, "hooked");
  assert.equal(first.shape, "array");
  assert.equal(second.installed, true, "a second arm is a no-op, not a second provider");
  assert.equal(registry.length, 1, "exactly one fan-out provider is pushed");
  assert.equal(typeof registry[0].rows, "function");
});

test("the pushed provider builds rows from the shared snapshot, in subscription order", () => {
  const registry: PushedProvider[] = [];
  setHook(registry);
  registerRows(labelsProvider("first", "Cards", ["First a"]));
  registerRows(labelsProvider("second", "Banner", ["Second b"]));
  installHookBackend();

  const rows = registry[0].rows({ theme: "host-theme", configHome: "/host/home" });

  assert.deepEqual(
    rows.map((row) => [row.category, row.label]),
    [
      ["Cards", "First a"],
      ["Banner", "Second b"],
    ],
  );
});

test("the pushed provider isolates a throwing provider and records the failure", () => {
  const registry: PushedProvider[] = [];
  setHook(registry);
  registerRows(labelsProvider("before", "Cards", ["Before ok"]));
  registerRows({
    id: "boom",
    category: "Banner",
    rows: () => {
      throw new Error("hook provider exploded");
    },
  });
  registerRows(labelsProvider("after", "Layout", ["After ok"]));
  installHookBackend();

  const rows = registry[0].rows({});

  assert.deepEqual(
    rows.map((row) => row.label),
    ["Before ok", "After ok"],
  );
  assert.deepEqual(getHookDiagnostics().lastFailures, [
    { providerId: "boom", message: "hook provider exploded", rowsDropped: true },
  ]);
});

test("a host context is reused when it carries a theme and a config home", () => {
  const registry: PushedProvider[] = [];
  setHook(registry);
  let received: unknown;
  registerRows({
    id: "ctx",
    category: "Cards",
    rows: (ctx) => {
      received = ctx;
      return [];
    },
  });
  installHookBackend();

  registry[0].rows({ theme: { name: "host-theme" }, configHome: "/host/home" });

  assert.deepEqual(received, { theme: { name: "host-theme" }, configHome: "/host/home" });
});

test("an object with a callable register is a usable registry", () => {
  const pushed: PushedProvider[] = [];
  setHook({
    register(provider: PushedProvider) {
      pushed.push(provider);
    },
  });
  registerRows(labelsProvider("p1", "Cards", ["Via register"]));

  const result = installHookBackend();

  assert.equal(result.outcome, "hooked");
  assert.equal(result.shape, "register");
  assert.equal(pushed.length, 1);
  assert.deepEqual(
    pushed[0].rows({}).map((row) => row.label),
    ["Via register"],
  );
});

test("unusable registry shapes are reported and never mistaken for a hook", () => {
  const unusable: unknown[] = [
    42,
    "providers",
    true,
    {},
    { register: 5 },
    { register: null },
    () => {},
  ];

  for (const value of unusable) {
    resetHookStateForTests();
    setHook(value);

    const result = installHookBackend();

    assert.equal(result.installed, false, `value ${String(value)} must not install a hook`);
    assert.equal(result.outcome, "unusable-hook", `value ${String(value)} is unusable`);
    assert.equal(
      getHookDiagnostics().shape,
      "unusable",
      "the unusable shape is recorded for diagnostics",
    );
  }
});

test("the registry is marked so a second package copy does not push a second provider", () => {
  const registry: PushedProvider[] = [];
  setHook(registry);
  installHookBackend();

  const armed = Symbol.for("gentle-shell-bridge.hook.armed.v1");
  assert.equal(Object.hasOwn(registry, armed), true, "the registry carries the armed marker");
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(registry, armed),
    false,
    "the marker is non-enumerable, so the host never iterates it",
  );
  // A second copy of this module has its own module scope but the same globalThis slot and the
  // same registry, which carries the marker.
  assert.equal(installHookBackend().installed, true);
  assert.equal(registry.length, 1, "still exactly one fan-out provider");
});

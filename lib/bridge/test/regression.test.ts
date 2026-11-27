import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armBridge } from "../src/arm.ts";
import { registerRows, resetBusForTests } from "../src/bus.ts";
import {
  disableCaptureBackend,
  getCaptureDiagnostics,
  installCaptureBackend,
  resetCaptureStateForTests,
} from "../src/capture.ts";
import {
  getHookDiagnostics,
  installHookBackend,
  resetHookStateForTests,
} from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { createStore, getStoreDiagnostics, resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, RowProvider } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;
const setHook = (value: unknown): void => {
  hookSlot()[HOOK_KEY] = value;
};

let configHome: string | undefined;
let previousConfigHome: string | undefined;

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetStoreStateForTests();
  resetRowBuildStateForTests();
  delete hookSlot()[HOOK_KEY];
});

test.afterEach(() => {
  disableCaptureBackend();
  Array.prototype.map = pristineMap;
  delete hookSlot()[HOOK_KEY];
  resetHookStateForTests();
  if (configHome !== undefined) {
    rmSync(configHome, { recursive: true, force: true });
    configHome = undefined;
  }
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
});

const pristineMap: typeof Array.prototype.map = Array.prototype.map;

const actionRows = (prefix: string): CustomizeRow[] => [
  { category: "Cards", label: `${prefix} 1`, action: () => {} },
  { category: "Cards", label: `${prefix} 2`, action: () => {} },
  { category: "Cards", label: `${prefix} 3`, action: () => {} },
];

const labelsProvider = (id: string, category: string, values: string[]): RowProvider => ({
  id,
  category,
  rows: () => values.map((label) => ({ label, action: () => {} })),
});

const adapter = (counters?: { invalidations: number }) => ({
  render: () => [],
  handleInput: () => {},
  invalidate: () => {
    if (counters !== undefined) counters.invalidations += 1;
  },
  dispose: () => {},
});

const rowLabels = (rows: CustomizeRow[]): unknown[] => rows.map((row) => row.label);

type LooseUi = { custom?: (factory: (ui: unknown, theme: unknown) => unknown) => unknown };

// B1 — silent wrong-target capture.
test("a nested factory that maps rows and throws does not steal the outer menu's capture", () => {
  registerRows(labelsProvider("p1", "Cards", ["Provider row"]));
  const host = createFakeHost();
  installCaptureBackend(host.ui);
  const outer = actionRows("outer");
  const nested = actionRows("nested");

  host.ui.custom!((_ui, _theme) => {
    try {
      host.ui.custom!(() => {
        nested.map((row) => row.label);
        throw new Error("nested factory exploded");
      });
    } catch {
      // the host survives a nested failure
    }
    outer.map((row) => row.label);
    return adapter();
  });

  assert.deepEqual(rowLabels(outer), ["outer 1", "outer 2", "outer 3", "Provider row"]);
  assert.deepEqual(rowLabels(nested), ["nested 1", "nested 2", "nested 3"]);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 1 });
});

test("an incidental row-shaped array before the menu is never mistaken for the menu", () => {
  registerRows(labelsProvider("p1", "Cards", ["Provider row"]));
  const host = createFakeHost();
  installCaptureBackend(host.ui);
  const incidental = actionRows("incidental");
  const menu = actionRows("menu");
  const counters = { invalidations: 0 };

  host.ui.custom!(() => {
    incidental.map((row) => row.label);
    menu.map((row) => row.label);
    return adapter(counters);
  });

  assert.deepEqual(rowLabels(incidental), ["incidental 1", "incidental 2", "incidental 3"]);
  assert.deepEqual(rowLabels(menu), ["menu 1", "menu 2", "menu 3"]);
  assert.equal(counters.invalidations, 0, "nothing was injected, so nothing was invalidated");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "ambiguous",
  });
});

// B2 — provider reentry.
test("a provider that opens a nested menu gives that menu its own injection", () => {
  const host = createFakeHost();
  installCaptureBackend(host.ui);
  const nestedMenu = actionRows("nested menu");
  const nestedCounters = { invalidations: 0 };
  let opened = false;

  registerRows({
    id: "reentrant",
    category: "Cards",
    rows: () => {
      if (!opened) {
        opened = true;
        host.ui.custom!(() => {
          nestedMenu.map((row) => row.label);
          return adapter(nestedCounters);
        });
      }
      return [{ label: "Reentrant row", action: () => {} }];
    },
  });

  host.buildMenu();

  assert.deepEqual(
    rowLabels(nestedMenu),
    ["nested menu 1", "nested menu 2", "nested menu 3", "Reentrant row"],
    "the nested menu built during the provider's own rows() received its own injection",
  );
  assert.equal(nestedCounters.invalidations, 1);
  assert.deepEqual(
    host.rendered().filter((label) => label === "Reentrant row"),
    ["Reentrant row"],
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 1 });
});

// B3 — inherited marker.
test("a fresh own custom on an instance that inherits a wrapped prototype rearms", () => {
  registerRows(labelsProvider("p1", "Cards", ["Rebind row"]));
  const proto = {
    custom(factory: (ui: unknown, theme: unknown) => unknown) {
      return factory(undefined, {});
    },
  };
  const ui = Object.create(proto) as LooseUi;

  const first = installCaptureBackend(ui);
  assert.equal(first.target, "prototype");
  assert.equal(first.armed, true);

  // A rebind gives the instance its own, new `custom` while the prototype stays wrapped.
  const rows = actionRows("rebound");
  const counters = { invalidations: 0 };
  ui.custom = (factory) => factory(undefined, {});

  const second = installCaptureBackend(ui);

  assert.equal(second.armed, true, "a new own custom must arm again, not inherit 'armed'");
  assert.equal(second.target, "instance");
  ui.custom!(() => {
    rows.map((row) => row.label);
    return adapter(counters);
  });
  assert.deepEqual(rowLabels(rows), ["rebound 1", "rebound 2", "rebound 3", "Rebind row"]);
  assert.equal(counters.invalidations, 1);
});

// B4 — duplicate injection through unmarkable registries and backend transitions.
test("a frozen register registry receives one provider across two arms", () => {
  const accepted: unknown[] = [];
  const frozen = Object.freeze({
    register(provider: unknown) {
      accepted.push(provider);
    },
  });
  setHook(frozen);

  assert.equal(installHookBackend().installed, true);
  assert.equal(installHookBackend().installed, true);

  assert.equal(accepted.length, 1, "dedupe must not depend on marking the host registry");
  assert.equal(getHookDiagnostics().acceptedProviders, 1);
});

test("a capture-to-hook transition disables the capture wrapper", () => {
  registerRows(labelsProvider("p1", "Cards", ["Once"]));
  const host = createFakeHost();
  const originalCustom = host.ui.custom;
  installCaptureBackend(host.ui);
  assert.equal(getCaptureDiagnostics().armedTargets, 1);

  const registry: unknown[] = [];
  setHook(registry);
  const result = armBridge(host.ui);

  assert.deepEqual(result, { outcome: "hooked", backend: "hook" });
  assert.equal(getCaptureDiagnostics().armedTargets, 0, "the previous path is disabled");
  assert.equal(host.ui.custom, originalCustom, "the host's own custom is restored");

  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    [],
    "the capture path must not inject a second copy once the hook is active",
  );
  const pushed = registry[0] as { rows: (ctx?: unknown) => CustomizeRow[] };
  assert.deepEqual(
    pushed.rows({}).map((row) => row.label),
    ["Once"],
    "the rows come through the registry, exactly once",
  );
});

// B5 — hook installation failures must be honest.
test("a frozen array registry falls back to capture instead of throwing", () => {
  registerRows(labelsProvider("p1", "Cards", ["Fallback row"]));
  setHook(Object.freeze([]));
  const host = createFakeHost();

  assert.doesNotThrow(() => installHookBackend());
  assert.equal(installHookBackend().installed, false);

  const result = armBridge(host.ui);
  assert.deepEqual(result, {
    outcome: "fallback-capture",
    backend: "capture",
    reason: "hook-unusable",
  });
  host.buildMenu();
  assert.deepEqual(host.rendered().slice(4), ["Fallback row"]);
});

test("a throwing push falls back to capture with a recorded reason", () => {
  const throwing: unknown[] = [];
  Object.defineProperty(throwing, "push", {
    value: () => {
      throw new Error("push exploded");
    },
  });
  setHook(throwing);

  const result = installHookBackend();

  assert.equal(result.installed, false);
  assert.match(String(result.reason), /push exploded/);
  assert.equal(getHookDiagnostics().installed, false);
});

test("a throwing register falls back to capture with a recorded reason", () => {
  setHook({
    register() {
      throw new Error("register exploded");
    },
  });

  const result = installHookBackend();

  assert.equal(result.installed, false);
  assert.match(String(result.reason), /register exploded/);
});

test("a throwing register getter is reported as unusable, not a crash", () => {
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "register", {
    get() {
      throw new Error("getter exploded");
    },
  });
  setHook(hostile);

  const result = installHookBackend();

  assert.equal(result.installed, false);
  assert.equal(result.outcome, "unusable-hook");
});

test("a no-op push is not reported as hooked", () => {
  const noop: unknown[] = [];
  Object.defineProperty(noop, "push", { value: () => 0 });
  setHook(noop);

  const result = installHookBackend();

  assert.equal(result.installed, false, "success requires the provider to be accepted");
  assert.equal(getHookDiagnostics().installed, false);
  assert.equal(getHookDiagnostics().acceptedProviders, 0);
});

test("a register that returns false is not reported as hooked", () => {
  setHook({ register: () => false });

  const result = installHookBackend();

  assert.equal(result.installed, false);
  assert.equal(getHookDiagnostics().acceptedProviders, 0);
});

// B6 — store and status truthfulness.
test("an unknown schema version reads defaults even when the key exists", () => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-regression-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  const bridgeDir = join(configHome, "gentle-shell-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const path = join(bridgeDir, "foreign.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 99, values: { mode: "foreign" } }), "utf8");

  const store = createStore("foreign");

  assert.equal(store.get("mode", "default"), "default");
  assert.equal(store.get("absent", "default"), "default");

  store.set("mode", "ours");

  const document = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.values.mode, "ours");
});

test("collectStatus never runs provider builders and reports no build yet", () => {
  let calls = 0;
  registerRows({
    id: "counter",
    category: "Cards",
    rows: () => {
      calls += 1;
      return [{ label: "counter row", action: () => {} }];
    },
  });

  const snapshot = collectStatus();

  assert.equal(calls, 0, "diagnostics must not evaluate providers");
  assert.equal(snapshot.duplicates, undefined);
  assert.ok(formatStatus(snapshot).includes("duplicate settings: no build yet"));
});

test("a successful hook fan-out records the same capture outcome shape", () => {
  const registry: unknown[] = [];
  setHook(registry);
  registerRows(labelsProvider("p1", "Cards", ["Hooked row"]));
  installHookBackend();
  const pushed = registry[0] as { rows: (ctx?: unknown) => CustomizeRow[] };

  const rows = pushed.rows({});
  const snapshot = collectStatus();

  assert.equal(rows.length, 1);
  assert.equal(snapshot.backend, "hook");
  assert.deepEqual(snapshot.lastCapture, { kind: "injected", injectedRows: 1 });
});

test("removing the host registry clears the hook state and status stops reporting hook", () => {
  setHook([]);
  assert.equal(installHookBackend().outcome, "hooked");
  assert.equal(getHookDiagnostics().installed, true);

  delete hookSlot()[HOOK_KEY];

  assert.equal(getHookDiagnostics().installed, false, "hook state follows the live registry");
  assert.equal(installHookBackend().outcome, "no-hook");

  const host = createFakeHost();
  assert.equal(armBridge(host.ui).backend, "capture");
  assert.equal(collectStatus().backend, "capture");
});

// F1 — a host that invokes the factory asynchronously must still be captured.
test("a host that invokes the factory in a later microtask still captures", async () => {
  registerRows(labelsProvider("p1", "Cards", ["Deferred row"]));
  const menu = actionRows("deferred menu");
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown) => unknown) =>
      Promise.resolve().then(() => factory(undefined, {})),
  };
  installCaptureBackend(ui);

  const result = await ui.custom(() => {
    menu.map((row) => row.label);
    return adapter();
  });

  assert.ok(result !== undefined);
  assert.deepEqual(rowLabels(menu), [
    "deferred menu 1",
    "deferred menu 2",
    "deferred menu 3",
    "Deferred row",
  ]);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 1 });
});

// F2 — a wrapper retained by foreign code must stop capturing once disabled.
test("a wrapper retained by foreign code is a pass-through after disable", () => {
  registerRows(labelsProvider("p1", "Cards", ["Must not appear"]));
  const menu = actionRows("after disable");
  const host = createFakeHost();
  installCaptureBackend(host.ui);
  const wrapperA = host.ui.custom;
  assert.equal(typeof wrapperA, "function");

  // Foreign code keeps a reference to wrapper A and wraps it in its own `custom`.
  const foreign = (factory: (ui: unknown, theme: unknown) => unknown) => wrapperA!(factory);
  host.ui.custom = foreign;
  installCaptureBackend(host.ui); // wrapper B around `foreign`

  disableCaptureBackend();
  disableCaptureBackend();

  host.ui.custom(() => {
    menu.map((row) => row.label);
    return adapter();
  });

  assert.equal(host.ui.custom, foreign, "the foreign wrapper is preserved, not clobbered");
  assert.deepEqual(rowLabels(menu), ["after disable 1", "after disable 2", "after disable 3"]);
  assert.equal(getCaptureDiagnostics().armedTargets, 0);
});

// F3 — a future schema's payload must not be re-labelled as schema 1.
test("an unknown-schema payload is not carried into a written schema-1 document", () => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-regression-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  const bridgeDir = join(configHome, "gentle-shell-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const path = join(bridgeDir, "future.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 99, values: { mode: "foreign" } }), "utf8");
  const store = createStore("future");

  store.set("other", true);

  const document = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.values, { other: true }, "only what the caller set is written");
  assert.equal(store.get("mode", "default"), "default", "the foreign payload is not resurrected");
  assert.equal(store.get("other", false), true);

  const problems = getStoreDiagnostics();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "unsupported-schema-version");
  assert.match(problems[0].message, /discarded/i);

  // The file is now a usable schema-1 document, so later writes preserve its values.
  store.set("third", 1);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(after.values, { other: true, third: 1 });
});

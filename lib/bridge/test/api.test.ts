/**
 * The runtime handshake (S1, S5 "zero extra steps"): the published API object, its shape gate and
 * the `bridgeApi()` helper a plugin calls from its own `session_start` handler.
 *
 * A plugin and the bridge are two independent projects. Pi gives them one sanctioned channel that
 * needs no path: `globalThis`. These tests pin that channel only — the symbol, the frozen object,
 * the gate and the absent-means-absent rule — because a path or an environment variable is exactly
 * what the rejected design offered and what this design replaces.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  API_SCHEMA,
  API_VERSION,
  BRIDGE_API_KEY,
  VERSION,
  bridgeApi,
  isBridgeApi,
  publishBridgeApi,
  resetBridgeApiForTests,
} from "../src/api.ts";
import {
  resetBusForTests,
  resetSectionsForTests,
  snapshotProviders,
  snapshotSections,
} from "../src/bus.ts";
import { disableCaptureBackend, getCaptureDiagnostics, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, {
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import {
  getMessageDesignConflicts,
  messageDesignLines,
  registerMessageDesign,
  resetMessageDesignsForTests,
} from "../src/message-designs.ts";
import { resetNoticesForTests, snapshotNotices } from "../src/notices.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import {
  disableSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  getToolDesignSelectionReads,
  registerToolDesign,
  resetToolDesignSelectionReads,
  resetToolDesignsForTests,
  resolveToolDesignSelection,
  setToolDesignLineSelection,
} from "../src/tool-designs.ts";
import type { RowProvider, SidebarSection } from "../src/types.ts";
import { createFakeHost, type FakeHost, type FakeUiTarget } from "./fake-host.ts";
import {
  cardBody,
  cardTitles,
  fakeTui,
  registerNativeFooter,
  resetSidebar,
} from "./fake-sidebar.ts";

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

const provider = (id: string): RowProvider => ({ id, category: "Cards", rows: () => [] });
const section = (id: string, title = "MUSIC"): SidebarSection => ({
  id,
  title,
  meta: () => "1 playing",
  lines: () => ["track  one"],
});

/** Every terminal write the process would show; the bridge must produce none. */
const captureConsole = (): { writes: string[]; restore: () => void } => {
  const writes: string[] = [];
  const sink = (globalThis as unknown as { console: { log: unknown; warn: unknown; error: unknown } })
    .console;
  const original = { log: sink.log, warn: sink.warn, error: sink.error };
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      writes.push(`${method}: ${args.map((arg) => String(arg)).join(" ")}`);
    };
  sink.log = record("log");
  sink.warn = record("warn");
  sink.error = record("error");
  return {
    writes,
    restore: () => {
      sink.log = original.log;
      sink.warn = original.warn;
      sink.error = original.error;
    },
  };
};

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-api-"));
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
  resetBridgeApiForTests();
  resetNoticesForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetToolDesignsForTests();
  resetMessageDesignsForTests();
  disableCaptureBackend();
  disableSidebarBackend();
});

test.afterEach(() => {
  disableCaptureBackend();
  disableSidebarBackend();
});

// ---------------------------------------------------------------------------------------------
// The published object
// ---------------------------------------------------------------------------------------------

test("publishing stores one frozen, versioned API object at the stable symbol", () => {
  const api = publishBridgeApi();

  assert.equal(hostSlot()[BRIDGE_API_KEY], api, "the slot holds exactly the object published");
  assert.ok(Object.isFrozen(api), "the published contract is frozen: nobody may extend it in place");
  assert.deepEqual(Object.keys(api).sort(), [
    "VERSION",
    "createStore",
    "registerCardStyle",
    "registerMessageDesign",
    "registerRows",
    "registerSection",
    "registerToolDesign",
    "registerTransform",
    "requestRepaint",
    "resolveToolDesignSelection",
    "schema",
    "version",
  ]);
  assert.equal(api.schema, "gentle-shell-bridge/api");
  assert.equal(api.version, 1);
  assert.equal(api.VERSION, VERSION);
  assert.equal(api.schema, API_SCHEMA);
  assert.equal(api.version, API_VERSION);
  assert.equal(isBridgeApi(api), true);
});

test("the published functions are the working ones, not a stale copy", () => {
  const api = publishBridgeApi();

  const disposeRows = api.registerRows(provider("loon.banner-source"));
  const disposeSection = api.registerSection(section("loon.music"));

  assert.deepEqual(snapshotProviders().map((registered) => registered.id), ["loon.banner-source"]);
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["loon.music"]);

  disposeSection();
  disposeRows();
  assert.deepEqual(snapshotProviders(), []);
  assert.deepEqual(snapshotSections(), []);
});

test("the published object answers which design a tool draws, one read per call", () => {
  const api = publishBridgeApi();
  const read = api.resolveToolDesignSelection;
  assert.equal(
    read,
    resolveToolDesignSelection,
    "the published reader IS the working one, not a copy that could drift",
  );
  assert.equal(typeof read, "function");
  if (typeof read !== "function") return;

  // Nothing registered and nothing persisted: the host's own card, and never an error.
  assert.deepEqual(read("read"), { kind: "native" });

  registerToolDesign({
    line: "tools",
    tools: ["read"],
    id: "odd.file-card",
    label: "file card",
    apply: (lines) => [...lines],
  });
  registerToolDesign({
    line: "tools",
    tools: ["write"],
    id: "odd.file-badge",
    label: "file badge",
    apply: (lines) => [...lines],
  });
  setToolDesignLineSelection("line", "tools", "odd.file-card");

  const selection = read("read");
  assert.equal(selection.kind, "design");
  if (selection.kind === "design") assert.equal(selection.design.id, "odd.file-card");
  // The line's value names a design that does not paint this tool: the host's card, and why.
  // The line's value names a design that does not paint this tool: the host's card, and why.
  assert.deepEqual(read("write"), { kind: "not-covered", id: "odd.file-card" });

  resetToolDesignSelectionReads();
  read("read");
  assert.equal(
    getToolDesignSelectionReads(),
    1,
    "one persisted-selection read per call, exactly what a render pass pays",
  );
});

test("the published object registers a message design through the same registry", () => {
  const api = publishBridgeApi();
  const register = api.registerMessageDesign;
  assert.equal(
    register,
    registerMessageDesign,
    "the published registration IS the working one, not a copy that could drift",
  );
  assert.equal(typeof register, "function");
  if (typeof register !== "function") return;

  const dispose = register({
    customType: "gentle-pi.exploration-budget",
    id: "odd.budget",
    label: "budget",
    apply: (lines) => [...lines],
  });
  assert.equal(getMessageDesignConflicts().length, 0, "the registration was accepted, not refused");
  assert.deepEqual(
    messageDesignLines().map((line) => line.types),
    [["gentle-pi.exploration-budget"]],
    "and it landed on the type's own line",
  );

  dispose();
  assert.deepEqual(messageDesignLines(), [], "the disposer withdraws exactly what it added");
});

test("the shape gate accepts only the v1 surface it advertises", () => {
  const valid = {
    schema: API_SCHEMA,
    version: API_VERSION,
    registerRows: () => () => {},
    registerSection: () => () => {},
    createStore: () => ({}),
  };

  assert.equal(isBridgeApi(valid), true);

  // Every mismatch is "absent", so the caller sees `undefined` instead of an error path.
  for (const rejected of [
    undefined,
    null,
    "gentle-shell-bridge",
    42,
    {},
    { ...valid, schema: "gentle-shell-bridge/api/v2" },
    { ...valid, version: 2 },
    { ...valid, version: "1" },
    { schema: API_SCHEMA, version: API_VERSION },
    { ...valid, registerRows: undefined },
    { ...valid, registerSection: "nope" },
    { ...valid, createStore: {} },
  ]) {
    assert.equal(isBridgeApi(rejected), false, `must reject ${JSON.stringify(rejected)}`);
  }
});

test("a second publish keeps the first object: first wins", () => {
  const first = publishBridgeApi();
  const second = publishBridgeApi();

  assert.equal(second, first);
  assert.equal(hostSlot()[BRIDGE_API_KEY], first);
});

test("two loaded copies of the module publish one object and both work through it", async () => {
  const first = publishBridgeApi();

  // Pi loads every extension with `moduleCache: false`, so this package genuinely exists twice in
  // one process. A second copy is a second module instance, not a second global slot.
  const copyPath = new URL("../src/api.ts?second-copy", import.meta.url).href;
  const second = (await import(copyPath)) as typeof import("../src/api.ts");

  assert.equal(hostSlot()[BRIDGE_API_KEY], first, "the second copy never overwrote the slot");
  const secondApi = second.publishBridgeApi();
  assert.equal(secondApi, first, "and publishing again hands the same object back");
  assert.equal(second.isBridgeApi(hostSlot()[BRIDGE_API_KEY]), true);

  // Both copies register into the same process-global bus, which is what makes them interchangeable.
  first.registerRows(provider("shared"));
  secondApi.registerRows(provider("shared"));
  assert.deepEqual(snapshotProviders().map((registered) => registered.id), ["shared"]);
  secondApi.registerSection(section("shared.section"));
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["shared.section"]);
});

// ---------------------------------------------------------------------------------------------
// bridgeApi(): the object or undefined, never a wait
// ---------------------------------------------------------------------------------------------

test("bridgeApi returns undefined when nothing is published, and the object once it is", () => {
  assert.equal(bridgeApi(), undefined, "no publication is absent, full stop");

  const api = publishBridgeApi();
  assert.equal(bridgeApi(), api, "and the published object is handed back immediately");
});

test("an object that fails the gate is absent: bridgeApi returns undefined, one notice, no throw", () => {
  for (const incompatible of [
    { ...usableSurface(), schema: "someone-else/api" },
    { ...usableSurface(), version: 2 },
    { schema: API_SCHEMA, version: API_VERSION },
  ]) {
    resetBridgeApiForTests();
    resetNoticesForTests();
    hostSlot()[BRIDGE_API_KEY] = incompatible;
    const captured = captureConsole();
    let seen: unknown;
    try {
      assert.doesNotThrow(() => {
        seen = bridgeApi();
      });
    } finally {
      captured.restore();
    }

    assert.equal(seen, undefined, "a mismatched object is never handed to a plugin");
    assert.equal(hostSlot()[BRIDGE_API_KEY], incompatible, "the slot is left exactly as it was");
    assert.deepEqual(captured.writes, [], "the skew is never written to the terminal");
    const notices = snapshotNotices().entries;
    assert.equal(notices.length, 1, "and it is recorded once, not per call");
    assert.match(notices[0].message, /incompatible|unsupported|version|not the/u);
    assert.match(notices[0].message, /absent|ABSENT/u);
    assert.match(notices[0].message, /left/u);
    assert.doesNotMatch(notices[0].message, /queue/u, "the notice never mentions a removed queue");
  }
});

const usableSurface = (): Record<string, unknown> => ({
  schema: API_SCHEMA,
  version: API_VERSION,
  registerRows: () => () => {},
  registerSection: () => () => {},
  createStore: () => ({ get: () => undefined, set: () => {} }),
});

test("an incompatible slot is never reset, and publishing still yields a working API", () => {
  const incompatible = { ...usableSurface(), version: 2 };
  hostSlot()[BRIDGE_API_KEY] = incompatible;
  const captured = captureConsole();
  let published: ReturnType<typeof publishBridgeApi> | undefined;
  try {
    published = publishBridgeApi();
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, []);
  assert.equal(hostSlot()[BRIDGE_API_KEY], incompatible, "the slot is left exactly as it was");
  assert.equal(isBridgeApi(hostSlot()[BRIDGE_API_KEY]), false);
  assert.equal(bridgeApi(), undefined, "and consumers still see it as absent");
  assert.ok(published !== undefined, "this copy still has an object to register through");
  assert.equal(isBridgeApi(published), true);
  published.registerSection(section("loon.music"));
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["loon.music"]);
});

// ---------------------------------------------------------------------------------------------
// Through the entry: a plugin registers from its own session_start handler
// ---------------------------------------------------------------------------------------------

type UiWithWidget = FakeUiTarget & {
  setWidget?: (key: string, factory: (tui: unknown, theme: unknown) => unknown) => void;
};

const installWidgetSurface = (host: FakeHost): void => {
  const ui = host.ui as UiWithWidget;
  ui.setWidget = (_key, factory) => {
    factory(fakeTui(), { name: "fake-theme" });
  };
};

const armThroughEntry = (host: FakeHost): void => {
  const handlers: BridgeSessionHandler[] = [];
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` arms (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(event, handler) {
      if (event === "session_start") handlers.push(handler);
    },
    registerCommand() {},
  };
  gentleShellBridge(pi);
  assert.equal(handlers.length, 1);
  handlers[0]({}, { hasUI: true, ui: host.ui });
};

test("a plugin that registers from session_start renders its section and its Sections toggle", () => {
  const host = createFakeHost();
  installWidgetSurface(host);
  registerNativeFooter(); // the host's own rail

  publishBridgeApi(); // the bridge loaded, as it always does before any session_start

  const api = bridgeApi();
  assert.ok(api !== undefined, "the API is present in the handler: no waiting, no queue");
  api.registerRows({
    id: "loon.banner-source",
    category: "Cards",
    rows: () => [
      {
        category: "Cards",
        label: "Loon banner source",
        choice: { setting: "Loon banner source", value: "on", current: () => true },
        action: () => {},
      },
    ],
  });
  api.registerSection(section("loon.music"));
  assert.deepEqual(snapshotProviders().map((registered) => registered.id), ["loon.banner-source"]);
  assert.deepEqual(snapshotSections().map((registered) => registered.id), ["loon.music"]);

  armThroughEntry(host); // session_start
  host.buildMenu();

  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"], "the registered section reached the rail");
  assert.deepEqual(cardBody("MUSIC"), ["track  one"]);
  const toggle = host.toggleLines().find((line) => line.startsWith("music "));
  assert.ok(toggle !== undefined, "and its toggle reached Sections");
  assert.ok(toggle.includes("● shown") && toggle.includes("○ hidden"));
  assert.ok(
    host.toggleLines().some((line) => line.startsWith("Loon banner source")),
    "the provider's rows reached the menu too",
  );
});

test("PRESERVE: a session_start without a UI still arms nothing", () => {
  const handlers: BridgeSessionHandler[] = [];
  const pi: BridgeExtensionApi = {
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      handlers.push(handler);
    },
    registerCommand() {},
  };
  gentleShellBridge(pi);
  publishBridgeApi();
  bridgeApi()?.registerRows(provider("queued.rows"));

  handlers[0]({}, { hasUI: false });

  assert.equal(getCaptureDiagnostics().armedTargets, 0, "no UI still means no arming");
  assert.deepEqual(
    snapshotProviders().map((registered) => registered.id),
    ["queued.rows"],
    "registration from a plugin handler is independent of the bridge arming",
  );
});

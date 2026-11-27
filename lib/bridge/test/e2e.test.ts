import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The public surface, exactly as a plugin reaches it.
import * as publicApi from "../src/index.ts";
import {
  createStore,
  registerRows,
  STORE_SCHEMA_VERSION,
  VERSION,
  type CardFrame,
  type CardFrameBottomContext,
  type CardFrameLineContext,
  type CardFrameTopContext,
  type CardStyleRegistration,
  type CustomizeRow,
  type InlineHelpers,
  type MessageDesignContext,
  type MessageDesignRegistration,
  type MessageDesignRender,
  type RowChoice,
  type RowContext,
  type RowLabel,
  type RowPreview,
  type RowProvider,
  type SectionContext,
  type SidebarSection,
  type Store,
  type StoreProblem,
  type StoreProblemKind,
  type TransformContext,
  type TranscriptTransform,
} from "../src/index.ts";
// The real Pi entry: armed and commanded exactly as Pi loads it.
import gentleShellBridge, {
  STATUS_COMMAND,
  type BridgeCommandHandler,
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
// Teardown-only seams; the API-surface test proves they are not public.
import { resetBusForTests } from "../src/bus.ts";
import { resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

let configHome: string;
let previousConfigHome: string | undefined;
let pristineMap: typeof Array.prototype.map;

test.before(() => {
  pristineMap = Array.prototype.map;
  configHome = mkdtempSync(join(tmpdir(), "gsb-e2e-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  Array.prototype.map = pristineMap;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetRowBuildStateForTests();
  resetHookStateForTests();
  resetStoreStateForTests();
  delete hookSlot()[HOOK_KEY];
});

test.afterEach(() => {
  Array.prototype.map = pristineMap;
  delete hookSlot()[HOOK_KEY];
});

interface Entry {
  sessionHandlers: BridgeSessionHandler[];
  commands: Array<{ name: string; description?: string; handler: BridgeCommandHandler }>;
}

/** Load the real extension entry against a recording API, as Pi would. */
const loadEntry = (): Entry => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const commands: Entry["commands"] = [];
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is loaded, so the runtime gate is open (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand(name, command) {
      commands.push({ name, description: command.description, handler: command.handler });
    },
  };
  gentleShellBridge(pi);
  return { sessionHandlers, commands };
};

/** Pi fires `session_start`; the entry arms the bridge. */
const armThroughEntry = (ui: unknown): Entry => {
  const entry = loadEntry();
  entry.sessionHandlers[0]({}, { hasUI: true, ui });
  return entry;
};

/** Run the registered `status` command and return exactly what it prints. */
const printStatus = (entry: Entry): string => {
  const printed: string[] = [];
  entry.commands[0].handler("", { ui: { notify: (message: string) => printed.push(message) } });
  return printed.join("\n");
};

const labels = (id: string, category: string, values: string[]): RowProvider => ({
  id,
  category,
  rows: () => values.map((label) => ({ label, action: () => {} })),
});

const armAndBuild = (host: FakeHost): Entry => {
  const entry = armThroughEntry(host.ui);
  host.buildMenu();
  return entry;
};

test("two providers reach one menu build through registerRows, in subscription order", () => {
  registerRows(labels("first", "Cards", ["First a"]));
  registerRows(labels("second", "Banner", ["Second b"]));
  const host = createFakeHost();

  armAndBuild(host);

  assert.deepEqual(host.rendered().slice(4), ["First a", "Second b"]);
  assert.deepEqual(
    host.liveRows().slice(4).map((row) => row.category),
    ["Cards", "Banner"],
  );
});

test("a throwing provider loses only its rows, the menu still renders, and status records it", () => {
  registerRows(labels("before", "Cards", ["Before ok"]));
  registerRows({
    id: "boom",
    category: "Banner",
    rows: () => {
      throw new Error("e2e provider exploded");
    },
  });
  registerRows(labels("after", "Layout", ["After ok"]));
  const host = createFakeHost();

  const entry = armAndBuild(host);

  assert.deepEqual(host.rendered().slice(4), ["Before ok", "After ok"]);
  const status = printStatus(entry);
  assert.match(status, /^last failures: 1$/m);
  assert.match(status, /boom: e2e provider exploded \(rows dropped\)/);
});

test("Array.prototype.map identity survives success, a throwing factory and a non-row array", () => {
  registerRows(labels("p1", "Cards", ["Row"]));

  const okHost = createFakeHost();
  armThroughEntry(okHost.ui);
  const beforeSuccess = Array.prototype.map;
  okHost.buildMenu();
  assert.equal(Array.prototype.map, beforeSuccess);

  const throwingHost = createFakeHost({ throwInsideFactory: true });
  armThroughEntry(throwingHost.ui);
  const beforeThrow = Array.prototype.map;
  assert.throws(() => throwingHost.buildMenu(), /factory exploded/);
  assert.equal(Array.prototype.map, beforeThrow);

  const nonRowHost = createFakeHost({ mapOnlyNonRows: true });
  armThroughEntry(nonRowHost.ui);
  const beforeNonRows = Array.prototype.map;
  nonRowHost.buildMenu();
  assert.equal(Array.prototype.map, beforeNonRows);
  assert.deepEqual(
    nonRowHost.rendered().filter((label) => label === "Row"),
    [],
    "a plain array of numbers is never injected into",
  );
});

test("two session_start events through the entry arm once: one injection, one invalidate", () => {
  registerRows(labels("p1", "Cards", ["Once"]));
  const host = createFakeHost();
  const entry = loadEntry();
  const context = { hasUI: true, ui: host.ui };

  entry.sessionHandlers[0]({}, context);
  entry.sessionHandlers[0]({}, context);

  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    ["Once"],
    "the rows are injected once, not twice",
  );
  assert.equal(host.invalidateCount(), 1, "one invalidate per menu build");
  assert.equal(host.factoryCallCount(), 1, "the host factory ran once");
  assert.match(printStatus(entry), /^backend: capture$/m);
});

test("the hook registry is preferred through the entry: nothing wrapped, rows via the registry", () => {
  const registry: Array<{ id: string; rows: (ctx?: unknown) => CustomizeRow[] }> = [];
  hookSlot()[HOOK_KEY] = registry;
  registerRows(labels("hooked", "Cards", ["Hooked row"]));
  const host = createFakeHost();
  const customBefore = host.ui.custom;

  const entry = armThroughEntry(host.ui);

  assert.equal(host.ui.custom, customBefore, "capture patches nothing when the hook exists");
  assert.equal(registry.length, 1, "one fan-out provider in the registry");
  assert.deepEqual(
    registry[0].rows({}).map((row) => row.label),
    ["Hooked row"],
    "rows land through the registry's own call path",
  );
  assert.match(printStatus(entry), /^backend: hook$/m);
});

test("createStore writes atomically under the real config-home override", () => {
  const store = createStore("e2e");
  const bridgeDir = join(configHome, "gentle-shell-bridge");

  store.set("bannerSource", "output");

  assert.ok(store.path.startsWith(bridgeDir), "the store path follows GENTLE_PI_CONFIG_HOME");
  assert.equal(store.path, join(bridgeDir, "e2e.json"));
  assert.equal(store.get("bannerSource", "activity"), "output");
  const entries = readdirSync(bridgeDir);
  assert.ok(entries.includes("e2e.json"));
  assert.deepEqual(entries.filter((name) => name.endsWith(".tmp")), [], "no temp file remains");
  const document = JSON.parse(readFileSync(store.path, "utf8"));
  assert.equal(document.schemaVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(document.values, { bannerSource: "output" });
});

test("a malformed store file falls back, is reported by bridge-status, and is fixed by a later set", () => {
  const bridgeDir = join(configHome, "gentle-shell-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const path = join(bridgeDir, "broken.json");
  writeFileSync(path, "{ not json", "utf8");
  const store = createStore("broken");

  assert.equal(store.get("bannerSource", "activity"), "activity");
  const reported = printStatus(loadEntry());
  assert.match(reported, /^store problems: 1$/m);
  assert.match(reported, /broken \(.*broken\.json\): invalid-json/);
  assert.equal(readFileSync(path, "utf8"), "{ not json", "reads never repair the file");

  store.set("bannerSource", "output");

  const document = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.values, { bannerSource: "output" });
  assert.match(printStatus(loadEntry()), /^store problems: none$/m);
});

test("S8 end to end: action persists first and the repaint shows the new bullet", async () => {
  const store = createStore("e2e-toggle");
  const toggle = (value: string): CustomizeRow => ({
    category: "Banner",
    label: () => "Loon banner source",
    choice: {
      setting: "Loon banner source",
      value,
      current: () => store.get("bannerSource", "activity") === value,
    },
    action: () => {
      store.set("bannerSource", value); // persist first
    }, // the view repaints second
  });
  registerRows({
    id: "loon.banner-source",
    category: "Banner",
    rows: () => [toggle("activity"), toggle("output")],
  });
  const host = createFakeHost();
  armThroughEntry(host.ui);
  host.buildMenu();

  assert.deepEqual(host.toggleLines(), ["Loon banner source ● activity ○ output"]);

  await host.pressRow((row) => row.choice?.value === "output");

  assert.equal(store.get("bannerSource", "activity"), "output", "action persisted before repaint");
  assert.deepEqual(
    host.toggleLines(),
    // Row order is fixed by the menu; only the rendered bullet moves onto the new value.
    ["Loon banner source ○ activity ● output"],
    "the same menu repaints onto the new value, with no second build",
  );
  assert.equal(host.factoryCallCount(), 1, "no second menu build was needed");
});

test("the public entry exports exactly the contract surface and no test seams", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    "BRIDGE_READY_EVENT",
    "STORE_SCHEMA_VERSION",
    "VERSION",
    "bridgeApi",
    "createStore",
    "isBridgeApi",
    "onBridgeApi",
    "registerCardStyle",
    "registerMessageDesign",
    "registerRows",
    "registerSection",
    "registerToolDesign",
    "registerTransform",
    "resolveCardStyleSelection",
    "resolveMessageDesignFollow",
    "resolveMessageDesignSelection",
    "resolveToolDesignSelection",
  ]);
  for (const seam of [
    "installCardStyleTransform",
    "disableCardStyleTransform",
    "getCardStyleWiringDiagnostics",
    "resetCardStyleWiringForTests",
    "transformCardLines",
    "getCardStyleTransformFailures",
    "getCardStyleLastOutcome",
    "resetCardStyleTransformForTests",
    "installCardStyleRows",
    "cardStyleRowMode",
    "extendCardStyleLine",
    "setCardStyleSelection",
    "getCardStyleSelection",
    "snapshotCardStyles",
    "resetCardStylesForTests",
    "CARD_STYLE_NATIVE",
    "HOST_CARD_STYLE_SETTING",
    "resetBusForTests",
    "resetCaptureStateForTests",
    "resetHookStateForTests",
    "resetStoreStateForTests",
    "snapshotSections",
    "resetSectionsForTests",
    "snapshotProviders",
    "installSectionRail",
    "installSectionRows",
    "setRailContributor",
    "getSectionFailures",
    "getSidebarDiagnostics",
    "resetBridgeApiForTests",
    "publishBridgeApi",
    "BRIDGE_API_KEY",
    "snapshotTransforms",
    "resetTransformsForTests",
    "applyTransforms",
    "getTransformFrameOutcomes",
    "resetTransformPipelineForTests",
    "getToolDesignLineSelection",
    "setToolDesignLineSelection",
    "getToolDesignSelectionReads",
    "resetToolDesignSelectionReads",
    "messageDesignLines",
    "messageDesignRows",
    "messageDesignLineNames",
    "getMessageDesignSelection",
    "getMessageDesignLineSelection",
    "setMessageDesignSelection",
    "setMessageDesignLineSelection",
    "applyMessageDesign",
    "getMessageDesignConflicts",
    "getMessageDesignFailures",
    "getMessageDesignSelectionReads",
    "isMessageTypeClaimed",
    "adoptCustomMessages",
    "messageDesignRenderer",
    "installMessageDesignRows",
    "resetMessageDesignsForTests",
    "resetMessageDesignAdoptionForTests",
    "resetMessageDesignRowStateForTests",
  ]) {
    assert.equal(seam in publicApi, false, `${seam} must not be public`);
  }
  assert.equal(typeof STATUS_COMMAND, "string");
  assert.ok(STATUS_COMMAND.length > 0);
});

test("the documented values and types are reachable from the public entry", () => {
  const provider: RowProvider = { id: "api", category: "Cards", rows: (): CustomizeRow[] => [] };
  // The card-style surface: one registration, three functions, the contexts they receive.
  const cardStyle: CardStyleRegistration = {
    id: "api.cute",
    label: "cute",
    order: 1,
    frame: {
      top: (frameCtx: CardFrameTopContext) => `${frameCtx.title ?? ""}${frameCtx.hint ?? ""}`,
      line: (frameCtx: CardFrameLineContext) => `${frameCtx.text}${frameCtx.first}`,
      bottom: (frameCtx: CardFrameBottomContext) => String(frameCtx.width),
    },
    preview: (): RowPreview => ({ title: "Cute", sample: "sample" }),
  };
  const context: RowContext = { theme: undefined, configHome: configHome };
  const choice: RowChoice = { setting: "s", value: "v", current: () => true };
  const label: RowLabel = "text";
  const preview: RowPreview = { title: "t", sample: "s" };
  const helpers: InlineHelpers = {
    input: async () => undefined,
    confirm: async () => true,
    capture: async () => undefined,
  };
  const store: Store = createStore("api-surface");
  const kind: StoreProblemKind = "invalid-json";
  const problem: StoreProblem = { pluginId: "api", path: "/tmp/x", kind, message: "m" };
  // The section surface is public too: a section is written by a plugin and registered with one call.
  const frame: CardFrame = cardStyle.frame;
  assert.equal(typeof frame.bottom, "function");
  const section: SidebarSection = {
    id: "api.section",
    title: "API",
    meta: (sectionCtx: SectionContext) => sectionCtx.configHome,
    lines: (sectionCtx: SectionContext) => [sectionCtx.configHome],
    defaultVisible: true,
    order: 1,
  };
  // The transform surface: one function over the rows, plus the context it receives.
  const transform: TranscriptTransform = {
    id: "api.transform",
    order: 2,
    transform: (lines: readonly string[], transformCtx: TransformContext) => [
      ...lines,
      String(transformCtx.width),
    ],
  };

  assert.equal(provider.rows(context).length, 0);
  assert.equal(typeof publicApi.registerCardStyle, "function", "the entry exports the registration");
  // The message-design surface: one registration and the context its `apply` receives.
  const render: MessageDesignRender = { expanded: false, outputPad: 1, message: { customType: "x" } };
  const messageContext: MessageDesignContext = { width: 5, customType: "x", render };
  const messageDesign: MessageDesignRegistration = {
    customType: "x",
    id: "api.budget",
    label: "budget",
    apply: (lines: readonly string[], designCtx: MessageDesignContext) => [
      ...lines,
      `${designCtx.customType}@${designCtx.width}`,
    ],
  };
  assert.equal(
    typeof publicApi.registerMessageDesign,
    "function",
    "the entry exports the message-design registration",
  );
  assert.equal(typeof publicApi.resolveMessageDesignSelection, "function");
  assert.equal(
    typeof publicApi.resolveMessageDesignFollow,
    "function",
    "a design that follows a tool switch can be asked what it answers right now",
  );
  assert.deepEqual(messageDesign.apply(["row"], messageContext), ["row", "x@5"]);
  assert.equal(render.expanded, false);
  assert.equal(
    typeof publicApi.registerTransform,
    "function",
    "and the transcript-transform registration",
  );
  assert.equal(cardStyle.frame.top({ width: 1, title: "t" }), "t");
  assert.equal(cardStyle.frame.line({ text: "x", width: 1, first: true }), "xtrue");
  assert.equal(cardStyle.frame.bottom({ width: 7 }), "7");
  assert.deepEqual(cardStyle.preview?.(), { title: "Cute", sample: "sample" });
  assert.equal(choice.value, "v");
  assert.equal(label, "text");
  assert.deepEqual(preview, { title: "t", sample: "s" });
  assert.equal(typeof helpers.confirm, "function");
  assert.equal(store.pluginId, "api-surface");
  assert.equal(problem.kind, "invalid-json");
  assert.equal(STORE_SCHEMA_VERSION, 1);
  assert.equal(section.title, "API");
  assert.equal(section.lines(context).length, 1);
  assert.deepEqual(transform.transform(["a"], { width: 3 }), ["a", "3"]);
  assert.equal(VERSION, "0.16.2");
});

// ---------------------------------------------------------------------------------------------
// Row placement (S4, S5, S6) through the real entry and the two backends
// ---------------------------------------------------------------------------------------------

test("row placement survives the real entry: start and after land inside the category", () => {
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Loon top", action: () => {} }],
  });
  registerRows({
    id: "loon.next",
    category: "Cards",
    placement: { after: "loon.top" },
    rows: () => [{ label: "Loon next", action: () => {} }],
  });
  const host = createFakeHost();

  armAndBuild(host);

  assert.deepEqual(host.rendered(), [
    "Loon top",
    "Loon next",
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
  ]);
});

test("the hook backend orders by S2 and reports that start/after could not be honoured", () => {
  const registry: Array<{ id: string; rows: (ctx?: unknown) => CustomizeRow[] }> = [];
  hookSlot()[HOOK_KEY] = registry;
  registerRows({
    id: "loon.start",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Loon start", action: () => {} }],
  });
  registerRows({
    id: "loon.first",
    category: "Cards",
    order: 1,
    rows: () => [{ label: "Loon first", action: () => {} }],
  });
  const entry = armThroughEntry(createFakeHost().ui);

  const rows = registry[0].rows({});

  assert.deepEqual(
    rows.map((row) => row.label),
    ["Loon first", "Loon start"],
    "the finite order comes first; the start request falls back to the end here",
  );
  const status = printStatus(entry);
  assert.match(status, /^backend: hook$/m);
  assert.ok(
    status
      .split("\n")
      .some((line) =>
        /^  - loon\.start \(Cards\), placement start → end \(the host did not build the category "Cards"/u.test(
          line,
        ),
      ),
    status,
  );
});

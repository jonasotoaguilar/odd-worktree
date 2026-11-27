/**
 * T12/T13 — the RUNTIME presence gate for the required host package (S9).
 *
 * `gentle-pi` is the package that owns `/gentle:customize`, the surface this bridge feeds. Its
 * presence is never read from disk: the sanctioned check is `pi.getCommands()` including the
 * `gentle:customize` command, the same precedent gentle-shell itself uses
 * (`extensions/gentle-design.ts:137`, `extensions/gentle-guide.ts:62`). All extensions are loaded
 * before `session_start`, so that event is the moment the answer is real.
 *
 * What is asserted here is only what a user or a plugin can observe: whether a plugin's row reaches
 * the host's menu, whether the ONE tool-design resolver was registered, whether the sidebar widget
 * factory and the footer status surface were handed out, exactly which `ctx.ui.notify` messages
 * appeared, and the `/bridge-status` lines. No internal field is read.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bridgeApi } from "../src/api.ts";
import { registerRows, resetBusForTests } from "../src/bus.ts";
import { resetCardStyleRowStateForTests } from "../src/card-style-rows.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import { disableCardStyleTransform, resetCardStyleWiringForTests } from "../src/card-style-wiring.ts";
import { getCaptureDiagnostics, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, {
  STATUS_COMMAND,
  type BridgeCommandEntry,
  type BridgeSessionHandler,
  type BridgeExtensionApi,
} from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { getPluginLineReport, resetPluginLinesForTests } from "../src/plugin-lines.ts";
import {
  GENTLE_PI_COMMAND,
  checkGentlePi,
  getGentlePiPresence,
  hasGentlePi,
  resetPresenceForTests,
} from "../src/presence.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { resetToolDesignRowStateForTests } from "../src/tool-design-rows.ts";
import { registerToolDesign, resetToolDesignsForTests } from "../src/tool-designs.ts";
import { resetToolDesignWiringForTests } from "../src/tool-design-wiring.ts";
import { createFakeHost } from "./fake-host.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-presence-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetCardStyleRowStateForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetHookStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRepaintForTests();
  resetRowBuildStateForTests();
  resetSectionFailuresForTests();
  resetSidebarStateForTests();
  resetStoreStateForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignsForTests();
  resetToolDesignWiringForTests();
  resetPresenceForTests();
  disableCardStyleTransform();
  disableSidebarBackend();
});

// ---------------------------------------------------------------------------------------------
// The harness: the real entry, a fake Pi whose command list can change, and one recording `ctx.ui`
// ---------------------------------------------------------------------------------------------

interface RecordingWorld {
  /** The API object the entry was loaded against; `getCommands` disappears for the absent case. */
  pi: BridgeExtensionApi;
  start: () => void;
  warnings: string[];
  widgets: number;
  statuses: Array<{ key: string; text?: string }>;
  resolvers: unknown[];
  host: ReturnType<typeof createFakeHost>;
}

/**
 * Load the real entry against a fake Pi. `getCommands` is a live factory, so a test can model the
 * host "showing up" later; passing `undefined` models a host that exposes no command surface at all.
 */
const createWorld = (getCommands: (() => unknown) | undefined, rowLabel?: string): RecordingWorld => {
  const warnings: string[] = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  const handlers: BridgeSessionHandler[] = [];
  const resolvers: unknown[] = [];
  let widgets = 0;
  const host = createFakeHost();
  const ui = host.ui as Record<string, unknown>;
  ui.notify = (message: string) => warnings.push(message);
  ui.setWidget = (_key: string, _factory: (tui: unknown, theme: unknown) => unknown) => {
    widgets += 1;
  };
  ui.setStatus = (key: string, text?: string) => statuses.push({ key, text });

  const pi: BridgeExtensionApi = {
    on(event, handler) {
      if (event === "session_start") handlers.push(handler);
    },
    registerCommand() {},
    registerToolRenderer(resolver) {
      resolvers.push(resolver);
    },
  };
  if (getCommands !== undefined) {
    // The host is a TRUST BOUNDARY: the cast models a host whose answer violates Pi's own type
    // (a non-array, an entry with no name, a throwing call), which is exactly what `./presence.ts`
    // re-validates at runtime.
    pi.getCommands = getCommands as () => readonly BridgeCommandEntry[];
  }
  gentleShellBridge(pi);

  if (rowLabel !== undefined) {
    registerRows({
      id: "presence.probe",
      category: "Banner",
      rows: () => [{ label: rowLabel, action: () => {} }],
    });
    registerToolDesign({
      tool: "bash",
      id: "presence.probe",
      label: "Probe",
      apply: (lines) => [...lines],
    });
  }

  return {
    pi,
    host,
    warnings,
    resolvers,
    get widgets() {
      return widgets;
    },
    statuses,
    start: () => {
      for (const handler of handlers) handler({}, { hasUI: true, ui });
    },
  };
};

/** `/bridge-status` through the command the entry registered, exactly as a user reads it. */
const reportThrough = (): string[] => {
  const printed: string[] = [];
  // The entry registers exactly one command; a fresh load per report keeps this independent of the
  // world's handler bookkeeping.
  const commands: Array<{ name: string; handler: (args: string, ctx: unknown) => unknown }> = [];
  const pi = {
    on() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.push({ name, handler: command.handler });
    },
  } as unknown as BridgeExtensionApi;
  gentleShellBridge(pi);
  const status = commands.find((command) => command.name === STATUS_COMMAND);
  assert.ok(status !== undefined, "the entry registers /bridge-status");
  status.handler("", { ui: { notify: (message: string) => printed.push(message) } });
  return printed.join("\n").split("\n");
};

// ---------------------------------------------------------------------------------------------
// T13 — present: the bridge arms exactly as it does today
// ---------------------------------------------------------------------------------------------

test("present: session_start arms every surface exactly as today", () => {
  const world = createWorld(() => [{ name: GENTLE_PI_COMMAND }], "Probe row");

  world.start();

  assert.equal(getCaptureDiagnostics().armedTargets, 1, "the row bridge is armed");
  assert.equal(world.resolvers.length, 1, "the ONE tool-design resolver is registered");
  assert.ok(world.widgets >= 1, "the sidebar widget factory is handed to the host");
  assert.equal(
    getPluginLineReport().availability,
    "installed",
    "the footer status surface is installed, so a plugin's INTEGRATIONS line is painted",
  );
  assert.deepEqual(world.warnings, [], "a present host needs no warning");

  world.host.buildMenu();
  assert.ok(world.host.rendered().includes("Probe row"), "a plugin's row reaches the host's menu");

  const lines = reportThrough();
  assert.equal(lines[0], "gentle-shell-bridge status");
  assert.equal(lines[1], "gentle-pi: present");
  assert.ok(lines.some((line) => line.startsWith("providers: 1")), lines.join("\n"));
});

test("present: a second session_start changes nothing (arming stays idempotent)", () => {
  const world = createWorld(() => [{ name: GENTLE_PI_COMMAND }], "Probe row");

  world.start();
  world.start();

  assert.equal(getCaptureDiagnostics().armedTargets, 1);
  assert.equal(world.resolvers.length, 1, "one resolver, however many times the event fires");
  assert.equal(
    getPluginLineReport().availability,
    "installed",
    "a second event re-installs the same surface, it does not duplicate it",
  );
});

// ---------------------------------------------------------------------------------------------
// T13 — absent: nothing armed, one warning, one honest status report
// ---------------------------------------------------------------------------------------------

test("absent: nothing is armed, one warning per absence, and the report says missing", () => {
  const world = createWorld(undefined, "Probe row");

  world.start();
  world.start();
  world.start();

  assert.equal(world.warnings.length, 1, "exactly one warning for the same absence");
  assert.match(world.warnings[0], /gentle-pi/u, "the warning names the missing package");
  assert.match(world.warnings[0], /missing/u);

  assert.equal(getCaptureDiagnostics().armedTargets, 0, "no wrapper is armed");
  assert.equal(world.resolvers.length, 0, "no tool-design resolver is registered");
  assert.equal(world.widgets, 0, "no sidebar widget factory is handed out");
  assert.deepEqual(world.statuses, [], "no footer line: the bridge never claims readiness");
  assert.equal(
    getPluginLineReport().availability,
    "not-armed",
    "the INTEGRATIONS surface is never installed, so no plugin is told 'ready'",
  );

  world.host.buildMenu();
  assert.equal(
    world.host.rendered().filter((label) => label === "Probe row").length,
    0,
    "a plugin's row is recorded but never reaches the menu",
  );

  const lines = reportThrough();
  assert.deepEqual(lines.slice(0, 3), [
    "gentle-shell-bridge status",
    "gentle-pi: missing — the host has no getCommands()",
    "bridge: disabled — gentle-pi is required; no rows, sections, card styles or tool designs are armed",
  ]);
  for (const prefix of [
    "providers:",
    "sections:",
    "sidebar:",
    "card styles:",
    "tool designs:",
    "transforms:",
    "plugin lines:",
  ]) {
    assert.ok(
      !lines.some((line) => line.startsWith(prefix)),
      `no ${prefix} block while disabled: ${lines.join("\n")}`,
    );
  }
});

test("absent: a plugin's registrations still succeed and never throw", () => {
  const world = createWorld(undefined);

  assert.doesNotThrow(() =>
    bridgeApi()?.registerRows({
      id: "presence.offline",
      category: "Banner",
      rows: () => [{ label: "Offline", action: () => {} }],
    }),
  );
  const api = bridgeApi();
  assert.ok(api !== undefined, "the API object is still published while disabled");
  assert.equal(typeof api.registerToolDesign, "function");
  assert.doesNotThrow(() =>
    api.registerToolDesign?.({
      tool: "bash",
      id: "presence.offline",
      label: "Offline",
      apply: (lines) => [...lines],
    }),
  );

  world.start();
  world.host.buildMenu();

  assert.equal(getCaptureDiagnostics().armedTargets, 0);
  assert.equal(world.resolvers.length, 0);
  assert.equal(world.host.rendered().includes("Offline"), false);
});

// ---------------------------------------------------------------------------------------------
// T13 — the check is a guard, not a crash
// ---------------------------------------------------------------------------------------------

test("the predicate is true only for a command list that names gentle:customize", () => {
  assert.equal(GENTLE_PI_COMMAND, "gentle:customize");
  assert.equal(hasGentlePi({ getCommands: () => [{ name: GENTLE_PI_COMMAND }] }), true);
  assert.equal(
    hasGentlePi({ getCommands: () => [{ name: "other:command" }, { name: GENTLE_PI_COMMAND }] }),
    true,
    "the list is searched, not required to be a single entry",
  );

  for (const [what, host] of [
    ["no getCommands", {}],
    ["an undefined host", undefined],
    ["a null host", null],
    ["a non-object host", "gentle-pi"],
    ["a non-function getCommands", { getCommands: "gentle:customize" }],
    ["a throwing getCommands", { getCommands: () => { throw new Error("host exploded"); } }],
    ["a non-array command list", { getCommands: () => "gentle:customize" }],
    ["an entry without a name", { getCommands: () => [{ label: GENTLE_PI_COMMAND }] }],
    ["a non-object entry", { getCommands: () => ["gentle:customize"] }],
    ["a non-string name", { getCommands: () => [{ name: 42 }] }],
    ["a near-miss name", { getCommands: () => [{ name: "gentle:customize " }] }],
    ["an empty list", { getCommands: () => [] }],
  ] as const) {
    assert.equal(hasGentlePi(host), false, `${what} means missing`);
  }
});

test("a throwing getCommands on session_start is missing, warned and never armed", () => {
  const world = createWorld(() => {
    throw new Error("host exploded");
  });

  assert.doesNotThrow(() => world.start());

  assert.equal(world.warnings.length, 1);
  assert.equal(getCaptureDiagnostics().armedTargets, 0);
  assert.equal(world.resolvers.length, 0);
  assert.equal(
    reportThrough()[1],
    "gentle-pi: missing — getCommands() threw: host exploded",
  );
});

// ---------------------------------------------------------------------------------------------
// T13 — a late host: missing, then present
// ---------------------------------------------------------------------------------------------

test("a late session_start after gentle-pi appears enables the bridge exactly once", () => {
  let commands: unknown = [];
  const world = createWorld(() => commands, "Probe row");

  world.start();
  world.start();
  assert.equal(world.warnings.length, 1, "one warning for the one absence");
  assert.equal(getCaptureDiagnostics().armedTargets, 0);

  // gentle-pi shows up: the next session_start is the re-check.
  commands = [{ name: GENTLE_PI_COMMAND }];
  world.start();

  assert.equal(getCaptureDiagnostics().armedTargets, 1, "the row bridge arms on the re-check");
  assert.equal(world.resolvers.length, 1, "the resolver registers on the re-check");
  assert.ok(world.widgets >= 1, "the sidebar widget factory is installed on the re-check");
  assert.equal(getPluginLineReport().availability, "installed");
  assert.equal(world.warnings.length, 1, "enabling does not repeat the warning");
  world.host.buildMenu();
  assert.ok(world.host.rendered().includes("Probe row"));

  const present = reportThrough();
  assert.equal(present[1], "gentle-pi: present");

  // Exactly once: arming is idempotent and is not re-run as a second resolver or a second wrapper.
  world.start();
  assert.equal(getCaptureDiagnostics().armedTargets, 1);
  assert.equal(world.resolvers.length, 1);
  assert.equal(world.warnings.length, 1);
});

test("present then missing again warns again for the new absence", () => {
  let commands: unknown = [{ name: GENTLE_PI_COMMAND }];
  const world = createWorld(() => commands, "Probe row");

  world.start();
  assert.deepEqual(world.warnings, []);

  // The host vanishes: the next re-check must report it and warn again, exactly once.
  commands = [{ name: "other:command" }];
  world.start();
  world.start();

  assert.equal(world.warnings.length, 1, "one warning for the second absence");
  assert.match(world.warnings[0], /gentle-pi/u);

  const lines = reportThrough();
  assert.equal(lines[1], "gentle-pi: missing — getCommands() lists no gentle:customize");
  assert.ok(lines.some((line) => line.startsWith("bridge: disabled — gentle-pi is required")));
  for (const prefix of ["card styles:", "tool designs:", "plugin lines:", "sidebar:"]) {
    assert.ok(
      !lines.some((line) => line.startsWith(prefix)),
      `a vanished host must not report ${prefix} work: ${lines.join("\n")}`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The presence record: process-global, absent until the first check
// ---------------------------------------------------------------------------------------------

test("collectStatus carries no presence field until a check has run", () => {
  assert.equal(getGentlePiPresence(), undefined);
  assert.equal(collectStatus().gentlePi, undefined);
  assert.deepEqual(formatStatus(collectStatus()), [
    "gentle-shell-bridge status",
    "providers: none",
    "backend: none",
    "last capture: none",
    "last failures: none",
    "store problems: none",
    "duplicate settings: no build yet",
  ]);
});

test("the presence record is shared by every copy in the process", () => {
  const first = checkGentlePi({ getCommands: () => [{ name: GENTLE_PI_COMMAND }] });
  assert.deepEqual(first, { present: true, warnNow: false });
  assert.deepEqual(getGentlePiPresence(), { present: true });
  assert.deepEqual(collectStatus().gentlePi, { present: true });

  // The same process-global slot the next copy reads: no second warning for the same absence.
  const second = checkGentlePi({});
  assert.equal(second.present, false);
  assert.equal(second.warnNow, true, "the absence transition owes the one warning");
  const third = checkGentlePi({});
  assert.equal(third.warnNow, false, "the same absence is not warned twice");
  assert.deepEqual(getGentlePiPresence(), {
    present: false,
    reason: "the host has no getCommands()",
  });
});

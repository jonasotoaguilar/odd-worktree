import assert from "node:assert/strict";
import test from "node:test";

import type { RowProvider } from "../src/types.ts";
import { resetBusForTests, registerRows } from "../src/bus.ts";
import { getCaptureDiagnostics, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, {
  STATUS_COMMAND,
  type BridgeCommandContext,
  type BridgeCommandHandler,
  type BridgeExtensionApi,
  type BridgeSessionContext,
  type BridgeSessionHandler,
} from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { createFakeHost } from "./fake-host.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetRowBuildStateForTests();
  resetHookStateForTests();
  resetStoreStateForTests();
});

test.afterEach(() => {
  delete hookSlot()[HOOK_KEY];
  resetHookStateForTests();
});

const labelsProvider = (id: string, category: string, labels: string[]): RowProvider => ({
  id,
  category,
  rows: () => labels.map((label) => ({ label, action: () => {} })),
});

interface FakeApi {
  api: BridgeExtensionApi;
  sessionHandlers: BridgeSessionHandler[];
  shutdownHandlers: BridgeSessionHandler[];
  commands: Array<{ name: string; description?: string; handler: BridgeCommandHandler }>;
}

const createFakeApi = (): FakeApi => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const shutdownHandlers: BridgeSessionHandler[] = [];
  const commands: Array<{ name: string; description?: string; handler: BridgeCommandHandler }> = [];
  const api: BridgeExtensionApi = {
    // The REQUIRED host package is present: `session_start` arms as before (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(event, handler) {
      if (event === "session_start") {
        sessionHandlers.push(handler);
        return;
      }
      assert.equal(event, "session_shutdown", `not a session event: ${String(event)}`);
      shutdownHandlers.push(handler);
    },
    registerCommand(name, command) {
      commands.push({ name, description: command.description, handler: command.handler });
    },
  };
  return { api, sessionHandlers, shutdownHandlers, commands };
};

test("registers one session_start handler, one session_shutdown handler and one command", () => {
  const fake = createFakeApi();

  gentleShellBridge(fake.api);

  assert.equal(fake.sessionHandlers.length, 1);
  assert.equal(fake.shutdownHandlers.length, 1, "shutdown is how the INTEGRATIONS row is cleared");
  assert.equal(fake.commands.length, 1);
  assert.equal(fake.commands[0].name, STATUS_COMMAND);
  assert.equal(typeof fake.commands[0].description, "string");
  assert.ok((fake.commands[0].description ?? "").length > 0);
});

test("a session_start without UI arms nothing", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Must not appear"]));
  const fake = createFakeApi();
  gentleShellBridge(fake.api);

  const context: BridgeSessionContext = { hasUI: false };
  fake.sessionHandlers[0]({}, context);

  assert.equal(getCaptureDiagnostics().armedTargets, 0);
  host.buildMenu();
  assert.deepEqual(host.rendered().slice(4), []);
});

test("two session_start events with UI arm once and inject once", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Once"]));
  const fake = createFakeApi();
  gentleShellBridge(fake.api);
  const context: BridgeSessionContext = { hasUI: true, ui: host.ui };

  fake.sessionHandlers[0]({}, context);
  fake.sessionHandlers[0]({}, context);

  assert.equal(getCaptureDiagnostics().armedTargets, 1, "one wrapper across two events");
  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    ["Once"],
  );
  assert.equal(host.invalidateCount(), 1);
});

test("loading the extension twice still arms the same ui once", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Once"]));
  const first = createFakeApi();
  const second = createFakeApi();
  gentleShellBridge(first.api);
  gentleShellBridge(second.api);
  const context: BridgeSessionContext = { hasUI: true, ui: host.ui };

  first.sessionHandlers[0]({}, context);
  second.sessionHandlers[0]({}, context);

  assert.equal(getCaptureDiagnostics().armedTargets, 1);
  host.buildMenu();
  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    ["Once"],
  );
});

test("the status command prints the formatter output", () => {
  registerRows(labelsProvider("loon.banner-source", "Banner", ["Row"]));
  const fake = createFakeApi();
  gentleShellBridge(fake.api);
  const printed: string[] = [];
  const context: BridgeCommandContext = {
    ui: { notify: (message: string) => printed.push(message) },
  };

  fake.commands[0].handler("", context);

  assert.equal(printed.length, 1);
  assert.match(printed[0], /^gentle-shell-bridge status$/m);
  assert.match(printed[0], /^providers: 1$/m);
  assert.match(printed[0], /loon\.banner-source \(Banner\)/);
  assert.match(printed[0], /^duplicate settings: no build yet$/m);
});

test("the status command does not throw when the command context has no ui", () => {
  const fake = createFakeApi();
  gentleShellBridge(fake.api);

  assert.doesNotThrow(() => fake.commands[0].handler("", {}));
});

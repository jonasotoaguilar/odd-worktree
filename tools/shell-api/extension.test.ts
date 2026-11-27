import assert from "node:assert/strict";
import test from "node:test";

import type { RowProvider } from "../../lib/shell-api/types.ts";
import { resetBusForTests, registerRows } from "../../lib/shell-api/bus.ts";
import { getCaptureDiagnostics, resetCaptureStateForTests } from "../../lib/shell-api/capture.ts";
import gentleShellBridge, {
  type BridgeExtensionApi,
  type BridgeSessionContext,
  type BridgeSessionHandler,
} from "../../lib/shell-api/extension.ts";
import { resetHookStateForTests } from "../../lib/shell-api/hook.ts";
import { getPluginLineReport, resetPluginLinesForTests } from "../../lib/shell-api/plugin-lines.ts";
import { resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
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
  commands: Array<{ name: string }>;
}

const createFakeApi = (): FakeApi => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const shutdownHandlers: BridgeSessionHandler[] = [];
  const commands: Array<{ name: string }> = [];
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
    // The host's own command registry: a fake that records it proves this factory registers none.
    registerCommand(name: string) {
      commands.push({ name });
    },
  } as unknown as BridgeExtensionApi;
  return { api, sessionHandlers, shutdownHandlers, commands };
};

test("registers one session_start and one session_shutdown handler, and no command", () => {
  const fake = createFakeApi();

  gentleShellBridge(fake.api);

  assert.equal(fake.sessionHandlers.length, 1);
  assert.equal(fake.shutdownHandlers.length, 1, "shutdown is how the INTEGRATIONS row is cleared");
  assert.deepEqual(fake.commands, [], "the shell API registers no command of its own");
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

test("the factory installs the INTEGRATIONS surface on the session's ui", () => {
  registerRows(labelsProvider("loon.banner-source", "Banner", ["Row"]));
  const fake = createFakeApi();
  gentleShellBridge(fake.api);
  const statuses: string[] = [];
  const ui = {
    setStatus: (key: string, text?: string) => {
      if (text !== undefined) statuses.push(`${key}: ${text}`);
    },
  };

  assert.equal(
    getPluginLineReport().availability,
    "unavailable",
    "before session_start there is no ui to paint a plugin line with",
  );

  fake.sessionHandlers[0]({}, { hasUI: true, ui });

  assert.equal(
    getPluginLineReport().availability,
    "installed",
    "session_start installs the INTEGRATIONS surface on the host's own setStatus",
  );
});

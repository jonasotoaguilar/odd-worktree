/**
 * The announcement: a plugin loaded BEFORE this package can still be served.
 *
 * The old rule — "the symbol's presence at `session_start` is the complete answer" — is wrong for
 * a plugin Pi loads earlier than the package. The example's real TUI report showed it: the global
 * extension's `session_start` handler ran first, found no symbol, and said "not installed" while
 * the shell API went on to publish. So the shell API now tells the process it published, on Pi's own
 * cross-extension bus, exactly once, and only when this copy really owns a compatible slot.
 *
 * These tests pin the event name and payload, the once-per-process rule across package copies, the
 * silence for an incompatible slot, and `onShellApi` — the helper that gives an importing plugin
 * both forms: immediate when the API is here, subscribed when it is coming.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  API_SCHEMA,
  API_VERSION,
  SHELL_API_KEY,
  SHELL_READY_EVENT,
  VERSION,
  announceShellReady,
  shellApi,
  onShellApi,
  publishShellApi,
  resetShellApiForTests,
  type ShellApi,
} from "../../lib/shell-api/api.ts";
import {
  resetBusForTests,
  resetSectionsForTests,
  snapshotProviders,
} from "../../lib/shell-api/bus.ts";
import gentleShellShellApi, { type ShellExtensionApi } from "../../lib/shell-api/extension.ts";
import { resetNoticesForTests } from "../../lib/shell-api/notices.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import type { RowProvider } from "../../lib/shell-api/types.ts";
import { createFakeEvents, type FakeEvents } from "./fake-events.ts";

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

const provider = (id: string): RowProvider => ({ id, category: "Cards", rows: () => [] });

/** Every terminal write the process would show; nothing here may produce one. */
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
  configHome = mkdtempSync(join(tmpdir(), "gsb-ready-"));
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
  resetShellApiForTests();
  resetNoticesForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetStoreStateForTests();
});

// ---------------------------------------------------------------------------------------------
// The event: name, payload, once per process
// ---------------------------------------------------------------------------------------------

test("the shell API announces itself with the schema, the major and the publishing release", () => {
  const bus = createFakeEvents();
  publishShellApi();

  assert.equal(announceShellReady(bus), true);

  assert.deepEqual(
    bus.emitted().map((entry) => entry.channel),
    [SHELL_READY_EVENT],
    "one event, on the channel plugins listen to",
  );
  assert.equal(SHELL_READY_EVENT, "odd-worktree:shell-ready", "the name is the contract");

  const payload = bus.emitted()[0].payload as Record<string, unknown>;
  assert.deepEqual(payload, { schema: API_SCHEMA, version: API_VERSION, VERSION });
  assert.equal(payload.schema, "odd-worktree/shell-api");
  assert.equal(payload.version, 1);
  assert.equal(payload.VERSION, "0.16.2");
  assert.ok(Object.isFrozen(payload), "a listener cannot rewrite the announcement in place");
});

test("the announcement happens once per process, however often this copy is asked", () => {
  const bus = createFakeEvents();
  publishShellApi();

  assert.equal(announceShellReady(bus), true);
  assert.equal(announceShellReady(bus), false, "the second ask is not an announcement");
  assert.equal(announceShellReady(bus), false);

  assert.equal(bus.emitted().length, 1, "one event for the process, not one per call");
});

test("two loaded copies of the package announce once between them", async () => {
  const first = createFakeEvents();
  const second = createFakeEvents();
  publishShellApi();

  // Pi loads every extension with `moduleCache: false`, so the package really exists twice.
  const copyPath = new URL("../../lib/shell-api/api.ts?second-copy", import.meta.url).href;
  const copy = (await import(copyPath)) as typeof import("../../lib/shell-api/api.ts");

  assert.equal(announceShellReady(first), true, "the copy that owns the slot announces");
  assert.equal(copy.announceShellReady(second), false, "and the other one stays quiet");
  assert.equal(first.emitted().length, 1);
  assert.deepEqual(second.emitted(), [], "no second announcement, on any bus");
});

test("an incompatible slot is never announced", () => {
  const bus = createFakeEvents();
  const incompatible = { schema: "someone-else/api", version: 1 };
  hostSlot()[SHELL_API_KEY] = incompatible;

  publishShellApi();
  assert.equal(announceShellReady(bus), false);

  assert.deepEqual(bus.emitted(), [], "no plugin is told to look at a slot it cannot use");
  assert.equal(hostSlot()[SHELL_API_KEY], incompatible, "and the slot is left exactly as it was");
});

test("a Pi without an event bus is skipped silently: the symbol still works", () => {
  publishShellApi();
  const captured = captureConsole();
  let announced: boolean | undefined;
  try {
    assert.doesNotThrow(() => {
      announced = announceShellReady(undefined);
    });
  } finally {
    captured.restore();
  }

  assert.equal(announced, false);
  assert.deepEqual(captured.writes, [], "nothing lands in the terminal");
  assert.equal(shellApi()?.VERSION, VERSION, "a plugin that reads the symbol is unaffected");
});

// ---------------------------------------------------------------------------------------------
// onShellApi: immediate when it is here, subscribed when it is coming
// ---------------------------------------------------------------------------------------------

const apiHandler = (): { calls: ShellApi[]; handler: (api: ShellApi) => void } => {
  const calls: ShellApi[] = [];
  return { calls, handler: (api) => calls.push(api) };
};

test("onShellApi calls the handler immediately when the API is already published, without listening", () => {
  const bus = createFakeEvents();
  const api = publishShellApi();
  const { calls, handler } = apiHandler();

  const dispose = onShellApi(handler, bus);

  assert.deepEqual(calls, [api], "the plugin is served in the same turn, before any event");
  assert.equal(bus.listenerCount(), 0, "and nothing is left subscribed: no listener leak");
  assert.doesNotThrow(() => dispose());
  assert.equal(calls.length, 1, "disposing after the fact cannot call the handler again");
});

test("onShellApi serves a plugin loaded first: one delivery when the announcement arrives", () => {
  const bus = createFakeEvents();
  const { calls, handler } = apiHandler();

  const dispose = onShellApi(handler, bus);
  assert.deepEqual(calls, [], "absent at subscription time: nothing to hand over yet");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 1);

  const api = publishShellApi();
  assert.equal(announceShellReady(bus), true);

  assert.deepEqual(calls, [api], "the announcement delivered the published object, once");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 0, "and the subscription cleaned itself up");

  assert.equal(announceShellReady(bus), false, "a second announcement is never emitted");
  assert.equal(calls.length, 1, "so the handler cannot run twice for one process");

  dispose();
});

test("an unsubscribe before the announcement means the handler never runs", () => {
  const bus = createFakeEvents();
  const { calls, handler } = apiHandler();

  const dispose = onShellApi(handler, bus);
  dispose();

  publishShellApi();
  announceShellReady(bus);

  assert.deepEqual(calls, [], "the plugin withdrew its interest and hears nothing");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 0);
});

test("onShellApi without a bus does not pretend to wait: a safe disposer, no call", () => {
  const { calls, handler } = apiHandler();

  const dispose = onShellApi(handler);

  assert.deepEqual(calls, []);
  assert.doesNotThrow(() => dispose());
  assert.equal(shellApi(), undefined, "and nothing was published behind its back");
});

test("onShellApi ignores an announcement that is not backed by a published object", () => {
  const bus = createFakeEvents();
  const { calls, handler } = apiHandler();
  onShellApi(handler, bus);

  bus.emit(SHELL_READY_EVENT, { schema: "someone-else/api", version: 1 });

  assert.deepEqual(calls, [], "the symbol is the authority, not the payload");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 1, "it keeps waiting for the real one");
});

test("a handler that throws cannot break the announcement for the next listener", () => {
  const bus = createFakeEvents();
  const { calls, handler } = apiHandler();
  const captured = captureConsole();
  try {
    onShellApi(() => {
      throw new Error("plugin exploded");
    }, bus);
    onShellApi(handler, bus);
    publishShellApi();
    assert.doesNotThrow(() => announceShellReady(bus));
  } finally {
    captured.restore();
  }

  assert.equal(calls.length, 1, "the second plugin was still served");
  assert.deepEqual(captured.writes, [], "and the failure was not printed to the terminal");
});

// ---------------------------------------------------------------------------------------------
// Through the entry: the extension is the only place `pi` exists
// ---------------------------------------------------------------------------------------------

const shellApiPi = (events: FakeEvents | undefined): ShellExtensionApi => ({
  on() {},
  registerCommand() {},
  ...(events === undefined ? {} : { events }),
});

test("the extension entry announces through the Pi it was handed, once", () => {
  const bus = createFakeEvents();

  gentleShellShellApi(shellApiPi(bus));
  gentleShellShellApi(shellApiPi(bus));

  assert.deepEqual(
    bus.emitted().map((entry) => entry.channel),
    [SHELL_READY_EVENT],
    "loading the package makes the process hear about it exactly once",
  );
});

test("the extension entry still publishes when it is handed no event bus", () => {
  const captured = captureConsole();
  try {
    assert.doesNotThrow(() => gentleShellShellApi(shellApiPi(undefined)));
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, []);
  const api = shellApi();
  assert.ok(api !== undefined, "the symbol is the handshake, with or without a bus");
  api.registerRows(provider("after-entry"));
  assert.deepEqual(snapshotProviders().map((registered) => registered.id), ["after-entry"]);
});

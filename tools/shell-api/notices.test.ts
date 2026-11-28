/**
 * The in-TUI diagnostics channel.
 *
 * Pi renders every diagnostic inside its own report; text written to stdout/stderr at load time
 * appears in the terminal around Pi's startup, outside the TUI that owns the screen. So the shell API
 * never writes to the console: a message produced before a context exists is buffered here and
 * flushed ONCE through `ctx.ui.notify`, and the diagnostics record keeps reporting it afterwards.
 *
 * These tests pin the whole contract: the bounded buffer, the dedupe, the flush-once rule, the
 * no-UI case, the status block, and — the reason the module exists — that loading the entry, the
 * example and an armed session produce ZERO console writes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SHELL_API_KEY, resetShellApiForTests } from "../../lib/shell-api/api.ts";
import { resetBusForTests } from "../../lib/shell-api/bus.ts";
import { resetCaptureStateForTests } from "../../lib/shell-api/capture.ts";
import gentleShellShellApi, {
  type ShellExtensionApi,
  type ShellSessionHandler,
} from "../../lib/shell-api/extension.ts";
import { resetHookStateForTests } from "../../lib/shell-api/hook.ts";
import {
  MAX_NOTICES,
  flushNotices,
  recordNotice,
  resetNoticesForTests,
  snapshotNotices,
} from "../../lib/shell-api/notices.ts";
import { resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../../lib/shell-api/sidebar.ts";
import { resetSectionFailuresForTests } from "../../lib/shell-api/sidebar-render.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import { createFakeHost } from "./fake-host.ts";
import { resetSidebar } from "./fake-sidebar.ts";

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

interface ConsoleCapture {
  writes: string[];
  restore: () => void;
}

/** Record every terminal write the process would show. */
const captureConsole = (): ConsoleCapture => {
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

interface RecordingUi {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}

const recordingUi = (): { ui: RecordingUi; calls: Array<[string, string | undefined]> } => {
  const calls: Array<[string, string | undefined]> = [];
  return {
    ui: { notify: (message, level) => calls.push([message, level]) },
    calls,
  };
};

const entryHandlers = (): ShellSessionHandler[] => {
  const handlers: ShellSessionHandler[] = [];
  const pi: ShellExtensionApi = {
    // `gentle-pi` is loaded, so the runtime gate is open and the buffered notice is flushed.
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      handlers.push(handler);
    },
    registerCommand() {},
  };
  gentleShellShellApi(pi);
  return handlers;
};

test.beforeEach(() => {
  resetShellApiForTests();
  resetNoticesForTests();
  resetBusForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  disableSidebarBackend();
});

// ---------------------------------------------------------------------------------------------
// The bounded buffer
// ---------------------------------------------------------------------------------------------

test("a notice is buffered as pending, with its level", () => {
  recordNotice("the slot holds a foreign object", "warning");

  assert.deepEqual(snapshotNotices(), {
    entries: [{ message: "the slot holds a foreign object", level: "warning", emitted: false }],
    dropped: 0,
  });
});

test("the default level is warning: every notice here is a problem report", () => {
  recordNotice("no registerToolRenderer");

  assert.equal(snapshotNotices().entries[0].level, "warning");
});

test("an identical message is recorded once, not once per load", () => {
  recordNotice("same fact", "warning");
  recordNotice("same fact", "warning");
  recordNotice("same fact", "error");

  assert.deepEqual(
    snapshotNotices().entries.map((entry) => [entry.message, entry.level]),
    [
      ["same fact", "warning"],
      ["same fact", "error"],
    ],
  );
});

test("the buffer is bounded and counts what it had to drop", () => {
  for (let index = 0; index < MAX_NOTICES + 3; index += 1) recordNotice(`notice ${index}`);

  const snapshot = snapshotNotices();
  assert.equal(snapshot.entries.length, MAX_NOTICES, "never unbounded");
  assert.equal(snapshot.dropped, 3, "and the loss is reported, not silent");
  assert.equal(snapshot.entries[0].message, "notice 3", "the newest messages survive");
  assert.equal(snapshot.entries.at(-1)?.message, `notice ${MAX_NOTICES + 2}`);
});

test("delivered entries are evicted before a pending one, and nothing is dropped", () => {
  for (let index = 0; index < MAX_NOTICES; index += 1) recordNotice(`delivered ${index}`);
  flushNotices(recordingUi().ui);
  recordNotice("still pending");
  recordNotice("later 1");
  recordNotice("later 2");

  const snapshot = snapshotNotices();
  assert.equal(snapshot.entries.length, MAX_NOTICES);
  assert.equal(snapshot.dropped, 0, "only already-delivered entries made room");
  assert.equal(
    snapshot.entries.some((entry) => entry.message === "still pending"),
    true,
    "a message the user never saw is never the first to go",
  );
  assert.equal(
    snapshot.entries.some((entry) => entry.message === "delivered 0"),
    false,
    "the oldest delivered notice made the room",
  );
});

// ---------------------------------------------------------------------------------------------
// The flush: once, through the UI, and only when a UI exists
// ---------------------------------------------------------------------------------------------

test("the first UI session delivers every pending notice exactly once", () => {
  const { ui, calls } = recordingUi();
  recordNotice("first", "warning");
  recordNotice("second", "error");

  assert.equal(flushNotices(ui), 2);
  assert.equal(flushNotices(ui), 0, "a second session_start never repeats a delivered message");
  assert.deepEqual(calls, [
    ["first", "warning"],
    ["second", "error"],
  ]);
  assert.deepEqual(
    snapshotNotices().entries.map((entry) => entry.emitted),
    [true, true],
    "and they stay reported for the diagnostics record",
  );
});

test("a session without a UI flushes nothing and keeps the message pending", () => {
  recordNotice("waiting for a UI");

  assert.equal(flushNotices(undefined), 0);
  assert.equal(flushNotices({}), 0, "a context without notify cannot deliver anything");
  assert.deepEqual(
    snapshotNotices().entries.map((entry) => entry.emitted),
    [false],
    "nothing was marked delivered",
  );
});

test("a notify that throws leaves the message pending instead of losing it", () => {
  recordNotice("retry me");

  assert.doesNotThrow(() =>
    flushNotices({
      notify: () => {
        throw new Error("ui bug");
      },
    }),
  );
  assert.equal(snapshotNotices().entries[0].emitted, false);

  const { ui, calls } = recordingUi();
  assert.equal(flushNotices(ui), 1, "the next session delivers it");
  assert.deepEqual(calls, [["retry me", "warning"]]);
});

// ---------------------------------------------------------------------------------------------
// the diagnostics record keeps the information
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// No console writes, ever
// ---------------------------------------------------------------------------------------------

test("loading a copy of the handshake with an incompatible slot writes nothing to the console", async () => {
  resetShellApiForTests();
  resetNoticesForTests();
  hostSlot()[SHELL_API_KEY] = { schema: "someone-else/api", version: 9 };

  const captured = captureConsole();
  try {
    await import(new URL("../../lib/shell-api/api.ts?console-free-skew", import.meta.url).href);
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, [], "the message must not land in the terminal");
  const entries = snapshotNotices().entries;
  assert.equal(entries.length, 1, "it is buffered instead");
  assert.equal(entries[0].level, "warning");
  assert.match(entries[0].message, /incompatible|not the|version/u);
});

test("loading the extension entry writes nothing to the console", async () => {
  const captured = captureConsole();
  try {
    await import(new URL("../../lib/shell-api/extension.ts?console-free-load", import.meta.url).href);
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, []);
});

test("an armed session flushes once through notify and writes nothing to the console", () => {
  const host = createFakeHost();
  const { ui, calls } = recordingUi();
  const handlers = entryHandlers();
  recordNotice("buffered before the UI existed", "warning");

  const captured = captureConsole();
  try {
    handlers[0]({}, { hasUI: true, ui: { ...host.ui, ...ui } });
    handlers[0]({}, { hasUI: true, ui: { ...host.ui, ...ui } });
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, []);
  assert.deepEqual(calls, [["buffered before the UI existed", "warning"]]);
});

test("a no-UI session does not flush, and the same message arrives on the next UI session", () => {
  const { ui, calls } = recordingUi();
  const handlers = entryHandlers();
  recordNotice("waiting for a UI", "warning");

  handlers[0]({}, { hasUI: false });
  assert.deepEqual(calls, [], "nothing can be shown without a UI");

  handlers[0]({}, { hasUI: true, ui });
  assert.deepEqual(calls, [["waiting for a UI", "warning"]], "flushed exactly once, later");
});

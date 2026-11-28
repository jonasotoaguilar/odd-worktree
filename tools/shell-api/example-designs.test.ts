/**
 * T10: `examples/bash-card.ts` as a PLUGIN — the handshake, the sidebar section, and the surfaces
 * it contributes.
 *
 * The example is what a plugin author copies, so what is proven here is its whole contract:
 *
 * - it reaches the shell API through the symbol and the `odd-worktree:shell-ready` announcement, with
 *   no path, no environment variable and no import (both load orders work);
 * - it registers its design for `bash`, its `plain` card style and its sidebar section, and its own
 *   `session_start` handler is the only entry point (the demo row provider is covered here too);
 * - the design's `Cards` line appears with no extra wiring, and the section reads the live selection;
 * - disposing the load leaves neither surface behind;
 * - nothing is ever written to stdout/stderr.
 *
 * The `plain` card style's own coverage lives in `test/example-plain-style.test.ts`, restored from
 * the two suites that were deleted with the style (`5c0c123:test/example-transform.test.ts`,
 * `5c0c123:test/example-late-load.test.ts`) and extended with the integration matrix.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHELL_API_KEY,
  SHELL_READY_EVENT,
  announceShellReady,
  shellApi,
  publishShellApi,
  resetShellApiForTests,
} from "../../lib/shell-api/api.ts";
import { resetBusForTests, resetSectionsForTests, snapshotSections } from "../../lib/shell-api/bus.ts";
import gentleShellShellApi, { type ShellExtensionApi } from "../../lib/shell-api/extension.ts";
import { resetNoticesForTests } from "../../lib/shell-api/notices.ts";
import { resetPluginLinesForTests } from "../../lib/shell-api/plugin-lines.ts";
import { buildRows, resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import {
  LEGACY_TOOL_DESIGN_STORE_ID,
  getToolDesignSelection,
  resetToolDesignsForTests,
  setToolDesignSelection,
  snapshotToolDesigns,
} from "../../lib/shell-api/tool-designs.ts";
import { resetToolDesignRowStateForTests, installToolDesignRows } from "../../lib/shell-api/tool-design-rows.ts";
import { resetToolDesignWiringForTests } from "../../lib/shell-api/tool-design-wiring.ts";
import type { CustomizeRow, InlineHelpers, SectionRow, SidebarSection } from "../../lib/shell-api/types.ts";
import { createFakeEvents, type FakeEvents } from "./fake-events.ts";

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  events?: FakeEvents;
}

type ExampleInit = (pi: FakePi) => () => void;

/** One fresh module instance per scenario: the example keeps nothing on `globalThis`. */
const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../../docs/shell-api/examples/bash-card.ts?${tag}`, import.meta.url).href;
  return ((await import(specifier)) as { default: ExampleInit }).default;
};

const hostSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

const recordingPi = (events?: FakeEvents): { pi: FakePi; sessionHandlers: SessionHandler[] } => {
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    ...(events === undefined ? {} : { events }),
  };
  return { pi, sessionHandlers };
};

/** The package loading in the same process: publishing, then announcing itself. */
const loadShellApi = (events: FakeEvents): void => {
  const pi: ShellExtensionApi = { on() {}, registerCommand() {}, events };
  gentleShellShellApi(pi);
};

const notifySurface = (): {
  ui: { notify: (message: string, level?: string) => void };
  calls: Array<[string, string | undefined]>;
} => {
  const calls: Array<[string, string | undefined]> = [];
  return { ui: { notify: (message, level) => calls.push([message, level]) }, calls };
};

/** How many of `plain` and of the section the example owns right now (the design is checked too). */
const surfaceCounts = (): number[] => [
  snapshotToolDesigns("bash").filter((design) => design.id === "bash-card.bash-heading").length,
  snapshotSections().filter((section) => section.id === "bash-card.status").length,
];

const DESIGN_AND_SECTION = [1, 1];

/** Every terminal write the process would show: the example must produce none. */
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

const sectionOf = (): SidebarSection => {
  const section = snapshotSections().find((candidate) => candidate.id === "bash-card.status");
  assert.ok(section !== undefined, "the example registers CARD BASH");
  return section;
};

const context = (): { theme: unknown; configHome: string } => ({ theme: undefined, configHome });

/** The inline helpers a demo row's action is handed; none of them are used by the trivial demo. */
const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

let configHome: string;
let previousConfigHome: string | undefined;
let previousModuleEnv: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-designs-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  previousModuleEnv = process.env.GENTLE_SHELL_API_MODULE;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  delete process.env.GENTLE_SHELL_API_MODULE;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  if (previousModuleEnv === undefined) delete process.env.GENTLE_SHELL_API_MODULE;
  else process.env.GENTLE_SHELL_API_MODULE = previousModuleEnv;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetShellApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
  resetStoreStateForTests();
  resetToolDesignsForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignWiringForTests();
});

// ---------------------------------------------------------------------------------------------
// The handshake: absent, present, and loaded-first
// ---------------------------------------------------------------------------------------------

test("with no shell API installed the example adds nothing and says so once", async () => {
  const captured = captureConsole();
  const { pi, sessionHandlers } = recordingPi();
  try {
    const init = await loadExample("no-shell API");
    assert.doesNotThrow(() => init(pi));
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, [], "nothing lands in the terminal");
  assert.equal(sessionHandlers.length, 1, "a session_start handler carries the answer");

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.equal(calls.length, 1, "one notice, delivered exactly once");
  assert.equal(calls[0][1], "warning");
  assert.match(calls[0][0], /no compatible shell API is installed/u);
  assert.match(calls[0][0], /no cross-extension event bus/u);
  assert.match(calls[0][0], /adds nothing/u);
  assert.deepEqual(surfaceCounts(), [0, 0]);
});

test("the absent notice waits for a UI and is delivered exactly once", async () => {
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("absent-waits-for-ui"))(pi);

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: false, ui });
  sessionHandlers[0]({}, {});
  assert.deepEqual(calls, [], "a session without a UI shows nothing");

  sessionHandlers[0]({}, { hasUI: true, ui });
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.equal(calls.length, 1, "the buffered message waits for a UI that can show it");
  assert.match(calls[0][0], /no compatible shell API is installed/u);
  assert.deepEqual(surfaceCounts(), [0, 0]);
});

test("an old or foreign shell API is treated as absent, and only through notify", async () => {
  hostSlot()[SHELL_API_KEY] = { schema: "odd-worktree/shell-api", version: 0 };
  const captured = captureConsole();
  const { pi, sessionHandlers } = recordingPi();
  try {
    (await loadExample("old-shell API"))(pi);
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.writes, [], "nothing lands in the terminal");
  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /no compatible shell API is installed/u);
  assert.deepEqual(surfaceCounts(), [0, 0]);
  assert.equal(hostSlot()[SHELL_API_KEY] !== undefined, true, "the slot it cannot use is left alone");
});

test("the session handler does nothing without a UI, then registers on the next one", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("no-ui"))(pi);

  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: false, ui });
  sessionHandlers[0]({}, {});
  assert.deepEqual(calls, []);
  assert.deepEqual(surfaceCounts(), [0, 0]);

  sessionHandlers[0]({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);
});

test("two session_start events leave one design and one section, not two", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("twice"))(pi);
  const { ui } = notifySurface();

  sessionHandlers[0]({}, { hasUI: true, ui });
  sessionHandlers[0]({}, { hasUI: true, ui });

  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);
});

test("the disposer removes both the design and the section", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  const dispose = (await loadExample("dispose"))(pi);
  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);
  dispose();
  assert.deepEqual(surfaceCounts(), [0, 0]);
});

test("an older shell API object without registerToolDesign keeps the section and says absent", async () => {
  const published = shellApi() ?? publishShellApi();
  // First-wins: a mixed process can hand back an object that predates the design bus.
  hostSlot()[SHELL_API_KEY] = {
    schema: published.schema,
    version: published.version,
    VERSION: published.VERSION,
    registerRows: published.registerRows,
    registerSection: published.registerSection,
    createStore: published.createStore,
  };

  const { pi, sessionHandlers } = recordingPi();
  const dispose = (await loadExample("old-object"))(pi);
  const { ui, calls } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  assert.deepEqual(calls, [], "a surface the shell API never promised is not warned about");
  assert.deepEqual(snapshotToolDesigns("bash"), [], "and no design is registered");
  assert.deepEqual(surfaceCounts(), [0, 1], "the section still registers");
  assert.equal(sectionOf().lines(context())[0], "resolver  absent", "the resolver report is now the first body row");

  dispose();
});

// ---------------------------------------------------------------------------------------------
// The rows and the section: what the user reads
// ---------------------------------------------------------------------------------------------

test("the Cards line appears with no extra wiring, and the section reads the live selection", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("live-state"))(pi);
  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  installToolDesignRows();
  const rows: CustomizeRow[] = buildRows({ theme: undefined, configHome }).rows;
  const designLine = rows.filter((row) => isBashDesignSetting(row.choice?.setting));
  assert.deepEqual(
    designLine.map((row) => row.choice?.value),
    ["default", "bash heading"],
    "the tool's own card is the default, the design is the other value",
  );

  const section = sectionOf();
  assert.equal(section.title, "CARD BASH");
  assert.equal(section.rowLabel, "card bash");
  assert.equal(section.meta?.(context()), "default", "the header count is the live selection");

  const lines = section.lines(context());
  assert.equal(
    lines.some((line) => typeof line !== "string" && line.label === "selected"),
    false,
    "the live selection rides the header meta, never a duplicate body row",
  );
  assert.equal(lines[0], "resolver  registered", "a plain string row: the design is on the bus");
  const presses = lines.find(
    (line): line is SectionRow => typeof line !== "string" && line.label === "demo presses",
  );
  assert.equal(presses?.onClick === undefined, false, "the section's one action row is the demo");

  setToolDesignSelection("bash", "bash-card.bash-heading");

  assert.equal(section.meta?.(context()), "bash heading", "the same section object reads the value");
  assert.equal(
    section
      .lines(context())
      .some((line) => typeof line !== "string" && line.label === "selected"),
    false,
    "and selecting a design still adds no second copy of the value",
  );

  // The selection lives in the SHELL API's own file, not in one of the example's.
  const stored = JSON.parse(
    readFileSync(join(configHome, "gentle-shell-bridge", `${LEGACY_TOOL_DESIGN_STORE_ID}.json`), "utf8"),
  );
  assert.deepEqual(stored.values.selections, { bash: "bash-card.bash-heading" });
  assert.equal(getToolDesignSelection("bash"), "bash-card.bash-heading");

  const settings = rows.map((row) => row.choice?.setting).filter((setting) => setting !== undefined);
  assert.equal(
    settings.some((setting) => /bash-card\./u.test(setting)),
    false,
    "no dotted id reaches a row name",
  );
});

// ---------------------------------------------------------------------------------------------
// The demo category: a toggle and a button in a category the plugin invents
// ---------------------------------------------------------------------------------------------

const DEMO_CATEGORY = "Card bash";

/** The tool-design line's setting, old shell API (`bash`) and current shell API (`Card bash`). */
const isBashDesignSetting = (setting: string | undefined): boolean =>
  setting === "bash" || setting === "Card bash";

/** The category's rows, through the real provider and the real build. */
const demoRows = (): CustomizeRow[] =>
  buildRows({ theme: undefined, configHome }).rows.filter((row) => row.category === DEMO_CATEGORY);

const sectionStrings = (): string[] =>
  sectionOf()
    .lines(context())
    .filter((line): line is string => typeof line === "string");

/** The `demo presses` ACTION row's live meta, read through the real section. */
const pressesMeta = (): string | undefined =>
  sectionOf()
    .lines(context())
    .find(
      (line): line is SectionRow => typeof line !== "string" && line.label === "demo presses",
    )?.meta;

const demoStoreValues = (): Record<string, unknown> => {
  const document = JSON.parse(
    readFileSync(join(configHome, "gentle-shell-bridge", "bash-card.json"), "utf8"),
  ) as { values: Record<string, unknown> };
  return document.values;
};

test("a plugin adds its OWN category with a toggle and a button, through one provider", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("demo-category"))(pi);
  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  const rows = demoRows();
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Demo toggle", "Demo toggle", "Demo button"],
    "a two-value toggle (one line) and a plain button, through one provider",
  );

  const [on, off, button] = rows;
  assert.equal(on?.choice?.setting, "Demo toggle");
  assert.equal(off?.choice?.setting, "Demo toggle");
  assert.deepEqual([on?.choice?.value, off?.choice?.value], ["on", "off"]);
  assert.equal(button?.choice, undefined, "the button carries no choice");
  assert.equal(typeof button?.action, "function", "Enter can run it");

  // The category is created by the row, exactly once, and the default is `off`.
  const categories = [...new Set(buildRows({ theme: undefined, configHome }).rows.map((row) => row.category))];
  assert.equal(categories.filter((category) => category === DEMO_CATEGORY).length, 1);
  assert.equal(on?.choice?.current(), false, "the stored default is off");
  assert.equal(off?.choice?.current(), true);

  for (const row of rows) {
    const preview = row.preview?.();
    assert.ok(preview !== undefined, "every demo row depicts itself");
    assert.equal([...preview.title].length < 40, true, "a short literal title");
    for (const line of preview.sample.split("\n")) {
      assert.equal([...line].length < 40, true, "a short literal sample row");
    }
  }

  const section = sectionStrings();
  assert.equal(section.includes("demo toggle  off"), true, "the sidebar shows the live value");
  assert.equal(
    pressesMeta(),
    "0",
    "the clickable `demo presses` row carries the live count as its right-aligned meta",
  );
});

test("choosing the demo toggle persists it and the sidebar shows the new value", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("demo-toggle"))(pi);
  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  const onRow = demoRows().find(
    (row) => row.choice?.setting === "Demo toggle" && row.choice.value === "on",
  );
  assert.ok(onRow?.action !== undefined);
  await onRow.action(inlineHelpers);

  assert.equal(onRow.choice?.current(), true, "the same row reads the new value");
  assert.equal(sectionStrings().includes("demo toggle  on"), true, "the sidebar shows it live");
  assert.equal(demoStoreValues().demoToggle, "on", "and it is persisted in the example's own store");
});

test("the demo button counts its presses in the section, through the example's store", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("demo-button"))(pi);
  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  const button = demoRows().find((row) => row.label === "Demo button");
  assert.ok(button?.action !== undefined);
  await button.action(inlineHelpers);
  await button.action(inlineHelpers);

  assert.equal(pressesMeta(), "2", "Enter increments the counter");
  assert.equal(demoStoreValues().demoPresses, 2, "and the count is persisted");
});

test("a second registration replaces the demo provider instead of stacking a category", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("demo-reload-1"))(pi);
  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  const onRow = demoRows().find(
    (row) => row.choice?.setting === "Demo toggle" && row.choice.value === "on",
  );
  const button = demoRows().find((row) => row.label === "Demo button");
  assert.ok(onRow?.action !== undefined && button?.action !== undefined);
  await onRow.action(inlineHelpers);
  await button.action(inlineHelpers);

  // A `/reload` loads the file again: the same provider id must replace, not duplicate.
  (await loadExample("demo-reload-2"))(pi);
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.equal(demoRows().length, 3, "one category, one toggle line, one button");
  const section = sectionStrings();
  assert.equal(section.includes("demo toggle  on"), true, "the stored toggle survives the reload");
  assert.equal(pressesMeta(), "1", "and so does the press count");
});

test("an older shell API without registerRows keeps the design and section, and adds no category", async () => {
  const published = shellApi() ?? publishShellApi();
  hostSlot()[SHELL_API_KEY] = {
    schema: published.schema,
    version: published.version,
    VERSION: published.VERSION,
    registerToolDesign: published.registerToolDesign,
    registerSection: published.registerSection,
    createStore: published.createStore,
  };

  const { pi, sessionHandlers } = recordingPi();
  // `registerRows` is absent from this object: the example must degrade, not throw.
  const dispose = (await loadExample("demo-old-shell API"))(pi);
  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION, "the promised surfaces still register");
  assert.deepEqual(demoRows(), [], "a surface the shell API never promised adds nothing");
  dispose();
});

test("the design's own preview depicts the card in that design", async () => {
  publishShellApi();
  const { pi, sessionHandlers } = recordingPi();
  (await loadExample("preview"))(pi);
  const { ui } = notifySurface();
  sessionHandlers[0]({}, { hasUI: true, ui });

  const [design] = snapshotToolDesigns("bash");
  assert.ok(design !== undefined);
  const preview = design.preview?.();
  assert.ok(preview !== undefined, "the design depicts itself");
  assert.match(preview.title, /bash heading/u);
  assert.match(preview.sample, /╭─ bash npm test/u, "the sample heads the card with the word bash");

  installToolDesignRows();
  const row = buildRows({ theme: undefined, configHome }).rows.find(
    (candidate) => candidate.choice?.value === "bash heading",
  );
  assert.deepEqual(row?.preview?.(), preview, "the value shows the design's own preview");
});

// ---------------------------------------------------------------------------------------------
// The load order Pi really produces: the plugin runs first
// ---------------------------------------------------------------------------------------------

test("a plugin loaded before the shell API registers when the announcement arrives", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("late-announcement"))(pi);

  assert.deepEqual(surfaceCounts(), [0, 0], "nothing registers at module load");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 1, "the early loader is listening");

  loadShellApi(bus);

  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION, "the announcement served the early loader");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 0, "and it stopped listening afterwards");

  const { ui } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION, "a reload adds no second copy");
});

test("the announcement alone is enough: a late shell API registers with no session_start", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("late-no-session"))(pi);

  publishShellApi();
  announceShellReady(bus);

  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);
  assert.equal(sessionHandlers.length, 1, "the handler is still there for the next session");

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "no notice: nothing is pending");
});

test("session_start before and after the announcement leaves exactly one of each", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("late-both"))(pi);
  const { ui } = notifySurface();

  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), [0, 0], "no shell API yet: nothing to register with");

  loadShellApi(bus);
  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);

  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION, "the later session_start adds no duplicate");
});

test("a plugin loaded after the shell API registers from session_start and leaves no listener", async () => {
  const bus = createFakeEvents();
  loadShellApi(bus);

  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("early-shell API"))(pi);

  assert.equal(
    bus.listenerCount(SHELL_READY_EVENT),
    0,
    "the API was already published: nothing to wait for, so nothing is subscribed",
  );
  assert.deepEqual(surfaceCounts(), [0, 0], "and still nothing at module load");

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, []);
  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);
});

test("disposing before the announcement drops the listener and registers nothing", async () => {
  const bus = createFakeEvents();
  const { pi } = recordingPi(bus);
  const dispose = (await loadExample("late-dispose"))(pi);

  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 1);
  dispose();
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 0, "a disposed load hears nothing");

  loadShellApi(bus);
  assert.deepEqual(surfaceCounts(), [0, 0]);
});

test("an announcement backed by no published object registers nothing", async () => {
  const bus = createFakeEvents();
  const { pi } = recordingPi(bus);
  (await loadExample("late-foreign"))(pi);

  bus.emit(SHELL_READY_EVENT, { schema: "someone-else/api", version: 1 });

  assert.deepEqual(surfaceCounts(), [0, 0], "the symbol decides, never the payload");
  assert.equal(bus.listenerCount(SHELL_READY_EVENT), 1, "and the example is still waiting");
});

// ---------------------------------------------------------------------------------------------
// The two honest notices
// ---------------------------------------------------------------------------------------------

test("with a bus but no shell API yet the notice says it is waiting for the announcement", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("notice-waiting"))(pi);

  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });

  assert.equal(calls.length, 1);
  const message = calls[0][0];
  assert.match(message, /waiting for the "odd-worktree:shell-ready" announcement/u);
  assert.match(message, /registers the bash design/u);
  assert.match(message, /the CARD BASH sidebar section/u);
  assert.match(message, /if it is not installed, or the published object is incompatible, nothing arrives/u);
  assert.doesNotMatch(message, /no compatible shell API is installed/u);
});

test("a waiting notice is withdrawn once the announcement registers the surfaces", async () => {
  const bus = createFakeEvents();
  const { pi, sessionHandlers } = recordingPi(bus);
  (await loadExample("notice-withdrawn"))(pi);

  for (const handler of sessionHandlers) handler({}, { hasUI: false });
  const { ui, calls } = notifySurface();
  for (const handler of sessionHandlers) handler({}, { hasUI: false, ui });
  assert.deepEqual(calls, [], "a session without a UI shows nothing");

  loadShellApi(bus);
  assert.deepEqual(surfaceCounts(), DESIGN_AND_SECTION);

  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui });
  assert.deepEqual(calls, [], "the surfaces registered, so the waiting notice is no longer true");
});

// ---------------------------------------------------------------------------------------------
// Nothing outside the TUI
// ---------------------------------------------------------------------------------------------

test("the example's runtime path resolves no module of the shell API", () => {
  const source = readFileSync(new URL("../../docs/shell-api/examples/bash-card.ts", import.meta.url), "utf8");

  assert.equal(/GENTLE_SHELL_API_MODULE/u.test(source), false, "no environment-variable override");
  assert.equal(/shellApiCandidates/u.test(source), false, "no path probing");
  assert.equal(/await\s+import\s*\(/u.test(source), false, "nothing is imported at runtime");
  assert.equal(
    /from\s+["']pi-odd-worktree["']/u.test(source),
    false,
    "the package is never imported, not even for types",
  );
  assert.match(source, /Symbol\.for\("odd-worktree\/shell-api\/v1"\)/u);
  assert.equal(/console\./u.test(source), false, "no console write survives in the example");
  assert.match(source, /pi\.on\("session_start"/u, "registration happens in session_start");
  assert.match(source, /odd-worktree:shell-ready/u, "a later shell API is heard on the announcement");
  assert.match(source, /pi\.events/u, "the channel comes from Pi's own bus, not a module");
  assert.match(source, /registerToolDesign/u, "the design is the surface it registers");
  assert.equal(/registerTransform/u.test(source), false, "there is no second transcript grammar");
  assert.equal(/registerToolRenderer\s*\(/u.test(source), false, "the example claims no resolver slot");
});

test("the absent case writes zero bytes to stdout and stderr", () => {
  const specifier = new URL("../../docs/shell-api/examples/bash-card.ts?zero-bytes", import.meta.url).href;
  const script = `
    import example from ${JSON.stringify(specifier)};
    const handlers = [];
    const pi = {
      on(event, handler) { handlers.push(handler); },
    };
    example(pi);
    for (const handler of handlers) handler({}, { hasUI: true, ui: { notify() {} } });
  `;
  const captured = captureConsole();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      // The example is a `.ts` file with no manifest beside it, so Node's own
      // MODULE_TYPELESS_PACKAGE_JSON warning is not the example writing bytes: the assertion is
      // about the EXAMPLE's stdout/stderr, so the runtime's module-type notice is silenced here.
      env: { ...process.env, GENTLE_PI_CONFIG_HOME: configHome, NODE_NO_WARNINGS: "1" },
    });
  } finally {
    captured.restore();
  }

  assert.equal(result.status, 0, `the example ran (stderr: ${String(result.stderr)})`);
  assert.equal(result.stdout, "", "no stdout bytes");
  assert.equal(result.stderr, "", "no stderr bytes");
});

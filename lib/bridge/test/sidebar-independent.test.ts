/**
 * Regressions found by independent review, each pinned before it was fixed.
 *
 * B1 — a sparse `lines()` used to take down its healthy siblings (S8).
 * B2 — a prototype-named id could not round-trip through the visibility map (S5).
 * B3 — the status output grew lines for a row-only session (S12).
 *
 * Plus the review's smaller findings: prune records when the host deletes a part, never let a
 * throwing `setWidget` accessor escape the session handler, and document by behaviour that the
 * rail wrapper spreads own ENUMERABLE fields only.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerSection,
  resetBusForTests,
  resetSectionsForTests,
  snapshotSections,
} from "../src/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, {
  STATUS_COMMAND,
  type BridgeCommandContext,
  type BridgeCommandHandler,
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  getSidebarDiagnostics,
  installSidebarBackend,
  resetSidebarStateForTests,
  setRailContributor,
} from "../src/sidebar.ts";
import {
  getSectionFailures,
  installSectionRail,
  resetSectionFailuresForTests,
} from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SidebarSection } from "../src/types.ts";
import { getSectionVisibility, isSectionVisible, setSectionVisible } from "../src/visibility.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";
import {
  cardBody,
  cardTitles,
  fakeState,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
  type Rail,
} from "./fake-sidebar.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-independent-"));
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
  resetBusForTests();
  resetSectionsForTests();
  resetSidebar();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  setRailContributor(undefined);
  delete hookSlot()[HOOK_KEY];
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const storePath = (): string => join(configHome, "gentle-shell-bridge", "bridge-sections.json");

/** Native part first, then the interception and the section renderer. */
function arm(): void {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

interface Entry {
  sessionHandlers: BridgeSessionHandler[];
  commands: Array<{ name: string; handler: BridgeCommandHandler }>;
}

const loadEntry = (): Entry => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const commands: Entry["commands"] = [];
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` arms and reports it (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand(name, command) {
      commands.push({ name, handler: command.handler });
    },
  };
  gentleShellBridge(pi);
  return { sessionHandlers, commands };
};

const armThroughEntry = (host: FakeHost): Entry => {
  const entry = loadEntry();
  entry.sessionHandlers[0]({}, { hasUI: true, ui: host.ui });
  return entry;
};

const printStatus = (entry: Entry): string[] => {
  const printed: string[] = [];
  const ctx: BridgeCommandContext = { ui: { notify: (message: string) => printed.push(message) } };
  entry.commands.find((command) => command.name === STATUS_COMMAND)?.handler("", ctx);
  return printed.join("\n").split("\n");
};

// ---------------------------------------------------------------------------------------------
// B1 — a broken section must never take down its siblings or the whole contribution.
// ---------------------------------------------------------------------------------------------

test("B1: a sparse lines() loses only its own body and leaves its siblings rendering", () => {
  registerSection(section("bad", { title: "BAD", lines: () => new Array(2) as unknown as string[] }));
  registerSection(section("good", { title: "GOOD", lines: () => ["good row"] }));
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "BAD", "GOOD"], "the whole contribution still renders");
  assert.deepEqual(cardBody("BAD"), [], "the broken body is dropped");
  assert.deepEqual(cardBody("GOOD"), ["good row"], "the healthy sibling is untouched");

  const failure = getSectionFailures().find((entry) => entry.sectionId === "bad");
  assert.equal(failure?.phase, "lines");
  assert.match(failure?.message ?? "", /sparse array/u);
  assert.deepEqual(
    getSidebarDiagnostics().lastFailures,
    [],
    "the backend never saw a throwing contributor: the failure stayed inside the section",
  );
});

test("B1: a hole in the middle of the body is a per-section failure, not a crash", () => {
  const sparse: string[] = ["first"];
  sparse[2] = "third"; // length 3, hole at index 1
  registerSection(section("holey", { title: "HOLEY", lines: () => sparse }));
  registerSection(section("good", { title: "GOOD", lines: () => ["still here"] }));
  arm();

  // Sections sort by `id` inside one slot (section-placement S2): "good" before "holey".
  assert.deepEqual(cardTitles(), ["FOOTER", "GOOD", "HOLEY"]);
  assert.deepEqual(cardBody("HOLEY"), []);
  assert.deepEqual(cardBody("GOOD"), ["still here"]);
  assert.match(getSectionFailures().find((e) => e.sectionId === "holey")?.message ?? "", /sparse/u);
});

test("B1: the backend's own recorded failures reach /bridge-status", () => {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  setRailContributor({
    render: () => {
      throw new Error("contributor exploded");
    },
  });
  renderSidebar(40);

  const snapshot = collectStatus();
  assert.deepEqual(snapshot.sidebarFailures, [
    { key: "footer", phase: "contribute", message: "contributor exploded" },
  ]);
  const lines = formatStatus(snapshot);
  const at = lines.indexOf("sidebar failures: 1");
  assert.ok(at !== -1, "the block is emitted");
  assert.deepEqual(lines.slice(at, at + 2), [
    "sidebar failures: 1",
    "  - footer (contribute): contributor exploded",
  ]);
});

// ---------------------------------------------------------------------------------------------
// B2 — prototype-shaped identities must be rejected at the door and survive the store.
// ---------------------------------------------------------------------------------------------

test("B2: a prototype-shaped or unusable section id is rejected and registers nothing", () => {
  for (const id of ["__proto__", "constructor", "prototype", "", "   "]) {
    assert.throws(
      () => registerSection(section(id)),
      /invalid section id/u,
      `id ${JSON.stringify(id)} must be rejected`,
    );
  }
  assert.deepEqual(snapshotSections(), [], "a rejected id must not half-register");

  registerSection(section("ok"));
  assert.deepEqual(
    snapshotSections().map((entry) => entry.id),
    ["ok"],
    "a valid id still registers afterwards",
  );
});

test("B2: visibility survives a prototype-named key and one toggle never erases another", () => {
  setSectionVisible("__proto__", false);
  const map = getSectionVisibility();
  assert.equal(Object.getPrototypeOf(map), null, "no inherited setter can swallow a key");
  assert.equal(isSectionVisible(map, { id: "__proto__" }), false);

  setSectionVisible("other", true);

  const after = getSectionVisibility();
  assert.equal(isSectionVisible(after, { id: "__proto__" }), false, "the earlier key survived");
  assert.equal(isSectionVisible(after, { id: "other" }), true);

  const stored = JSON.parse(readFileSync(storePath(), "utf8"));
  assert.equal(Object.hasOwn(stored.values.sections, "__proto__"), true);
  assert.equal(stored.values.sections["__proto__"], false);
  assert.equal(stored.values.sections.other, true);
});

// ---------------------------------------------------------------------------------------------
// B3 — a row-only session must keep the pre-feature output, through the real entry.
// ---------------------------------------------------------------------------------------------

test("B3: a row-only session through the entry keeps the pre-feature status output", () => {
  const host = createFakeHost(); // no setWidget: the sidebar cannot arm
  const entry = armThroughEntry(host);
  host.buildMenu();

  assert.deepEqual(printStatus(entry), [
    "gentle-shell-bridge status",
    "gentle-pi: present",
    "providers: none",
    "backend: capture",
    "last capture: injected 0 rows",
    "last failures: none",
    "store problems: none",
    "duplicate settings: none",
  ]);
});

test("B3: the internal Sections provider is never listed, and the rail state only when worth it", () => {
  registerSection(section("music", { title: "MUSIC" }));
  const host = createFakeHost();
  const entry = armThroughEntry(host);
  host.buildMenu();

  const printed = printStatus(entry);
  assert.equal(printed.includes("bridge.sections"), false, "bridge plumbing is not a plugin provider");
  assert.ok(printed.includes("providers: none"));
  assert.ok(printed.includes("sections: 1"));
  assert.ok(
    printed.some((line) => line.startsWith("sidebar: not armed")),
    "with a section registered, an unreachable rail must be reported",
  );
});

// ---------------------------------------------------------------------------------------------
// The review's smaller findings.
// ---------------------------------------------------------------------------------------------

test("a part deleted or cleared by the host is no longer reported as wrapped", () => {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  assert.equal(getSidebarDiagnostics().wrappedRails, 1);

  fakeState().parts.delete(SIDEBAR_RAIL_KEY);

  assert.equal(getSidebarDiagnostics().wrappedRails, 0, "a deleted part is not a wrapped rail");
  assert.equal(collectStatus().sidebar?.rail, "pending");

  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  assert.equal(getSidebarDiagnostics().wrappedRails, 1);

  fakeState().parts.clear();

  assert.equal(getSidebarDiagnostics().wrappedRails, 0, "a cleared map wraps nothing");
});

test("a throwing setWidget accessor is reported and never escapes the session handler", () => {
  registerSection(section("music", { title: "MUSIC" }));
  const host = createFakeHost();
  Object.defineProperty(host.ui, "setWidget", {
    configurable: true,
    get() {
      throw new Error("ui exploded");
    },
  });

  const entry = armThroughEntry(host); // must not throw
  host.buildMenu();

  assert.ok(host.rendered().includes("music"), "the row side still works");
  const printed = printStatus(entry);
  assert.ok(
    printed.some((line) => line.includes("sidebar: not armed") && line.includes("ui exploded")),
    `expected an unarmed report with the reason, got: ${printed.join(" | ")}`,
  );
});

test("the wrapper carries own enumerable fields only", () => {
  const prototype = { inheritedMethod: () => "from the prototype" };
  const rail = Object.create(prototype) as Rail;
  rail.render = () => ["▾ NATIVE"];
  let backing = "first";
  Object.defineProperty(rail, "live", { get: () => backing, enumerable: true });
  Object.defineProperty(rail, "hiddenField", { value: "not enumerable", enumerable: false });
  registerNativeFooter(rail);

  installSidebarBackend(() => fakeTui());

  const wrapped = fakeState().parts.get(SIDEBAR_RAIL_KEY) as Record<string, unknown> | undefined;
  assert.ok(wrapped !== undefined);
  assert.equal(typeof wrapped.render, "function");
  assert.equal("inheritedMethod" in wrapped, false, "prototype methods are not carried");
  assert.equal("hiddenField" in wrapped, false, "non-enumerable fields are not carried");
  assert.equal(wrapped.live, "first", "a getter is snapshotted when the wrapper is built");
  backing = "second";
  assert.equal(wrapped.live, "first", "and it does not track the original afterwards");
});

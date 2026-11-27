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
  snapshotProviders,
  snapshotSections,
} from "../../lib/shell-api/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../../lib/shell-api/capture.ts";
import gentleShellBridge, {
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../../lib/shell-api/extension.ts";
import { resetHookStateForTests } from "../../lib/shell-api/hook.ts";
import { resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  getSidebarDiagnostics,
  installSidebarBackend,
  resetSidebarStateForTests,
  setRailContributor,
} from "../../lib/shell-api/sidebar.ts";
import {
  getSectionFailures,
  installSectionRail,
  resetSectionFailuresForTests,
} from "../../lib/shell-api/sidebar-render.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import type { SidebarSection } from "../../lib/shell-api/types.ts";
import { getSectionVisibility, isSectionVisible, setSectionVisible } from "../../lib/shell-api/visibility.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";
import {
  cardBody,
  cardTitles,
  fakeState,
  fakeTui,
  registerNativeFooter,
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
}

const loadEntry = (): Entry => {
  const sessionHandlers: BridgeSessionHandler[] = [];
  const pi: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` arms and reports it (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
  };
  gentleShellBridge(pi);
  return { sessionHandlers };
};

const armThroughEntry = (host: FakeHost): Entry => {
  const entry = loadEntry();
  entry.sessionHandlers[0]({}, { hasUI: true, ui: host.ui });
  return entry;
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
// B3 — a row-only session registers nothing extra, through the real entry.
// ---------------------------------------------------------------------------------------------

test("B3: a row-only session through the entry registers no plugin provider", () => {
  const host = createFakeHost(); // no setWidget: the sidebar cannot arm
  armThroughEntry(host);
  host.buildMenu();

  assert.deepEqual(
    snapshotProviders().map((provider) => provider.id).filter((id) => !id.startsWith("bridge.")),
    [],
    "only the shell API's own plumbing providers are there, never a plugin provider",
  );
});

test("B3: the internal Sections provider is never a plugin provider, and the rail says it is unarmed", () => {
  registerSection(section("music", { title: "MUSIC" }));
  const host = createFakeHost();
  armThroughEntry(host);
  host.buildMenu();

  const providerIds = snapshotProviders().map((provider) => provider.id);
  assert.equal(providerIds.includes("bridge.sections"), true, "the Sections provider is installed");
  assert.deepEqual(
    providerIds.filter((id) => !id.startsWith("bridge.")),
    [],
    "and it is the shell API's own plumbing, not a plugin provider",
  );
  assert.equal(snapshotSections().length, 1, "the section itself is registered");
  assert.equal(
    getSidebarDiagnostics().lastOutcome,
    "no-widget-surface",
    "with a section registered, an unreachable rail must be reported",
  );
});

// ---------------------------------------------------------------------------------------------
// The review's smaller findings.
// ---------------------------------------------------------------------------------------------

test("a throwing setWidget accessor is reported and never escapes the session handler", () => {
  registerSection(section("music", { title: "MUSIC" }));
  const host = createFakeHost();
  Object.defineProperty(host.ui, "setWidget", {
    configurable: true,
    get() {
      throw new Error("ui exploded");
    },
  });

  armThroughEntry(host); // must not throw
  host.buildMenu();

  assert.ok(host.rendered().includes("music"), "the row side still works");
  const diagnostics = getSidebarDiagnostics();
  assert.equal(diagnostics.lastOutcome, "no-widget-surface", "the rail is reported unarmed");
  assert.match(diagnostics.lastReason ?? "", /ui exploded/u, "and the host's own message is kept");
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

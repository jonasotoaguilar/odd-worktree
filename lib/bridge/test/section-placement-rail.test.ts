/**
 * Section placement, end to end through the fake host: the rail wrapper on every painted part
 * (S1–S8).
 *
 * `test/fake-sidebar.ts` owns the rail map and the frame, so these tests drive it exactly the way
 * the layout does: register the native parts, arm the bridge, render, and look at the cards the rail
 * would show. Row ranges are asserted through the pointer path, which is the only consumer of them.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { setRepaintHost, resetRepaintForTests } from "../src/repaint.ts";
import { resetSectionPanelForTests } from "../src/section-panel.ts";
import { resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  disableSidebarBackend,
  getSidebarDiagnostics,
  installSidebarBackend,
  observedPaintedParts,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import {
  installSectionRail,
  resetSectionFailuresForTests,
} from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { setSectionVisible } from "../src/visibility.ts";
import { RAIL_PARTS } from "../src/types.ts";
import type { SidebarSection } from "../src/types.ts";
import {
  cardTitles,
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  registerNativeRail,
  renderSidebar,
  resetSidebar,
  type Rail,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-placement-rail-"));
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
  resetSectionPanelForTests();
  resetSectionPointerForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  disableSidebarBackend();
  setRepaintHost(undefined);
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

/** A native part the way the host registers one: one card, its first row the heading. */
function nativePart(title: string, body: readonly string[] = [`${title} row`]): Rail {
  const lines = [`▾ ${title}`, ...body];
  return {
    render: () => [...lines],
    cardGroups: () => ({ groups: [{ start: 0, end: lines.length }] }),
    digest: () => `${title}:native`,
  };
}

/** Every painted part registered, in the host's own paint order. */
function registerAllParts(): void {
  registerNativeRail("todo", nativePart("TODO"));
  registerNativeRail("jobs", nativePart("JOBS"));
  registerNativeRail("agents", nativePart("AGENTS"));
  registerNativeFooter(nativePart("FOOTER"));
}

function arm(): void {
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

// ---------------------------------------------------------------------------------------------
// S1, S5 — a card can sit before the first native part or after a middle one.
// ---------------------------------------------------------------------------------------------

test("start draws its card before the first native part, not after the last one", () => {
  registerAllParts();
  registerSection(section("top", { title: "TOP", placement: "start" }));
  arm();

  assert.deepEqual(cardTitles(), ["TOP", "TODO", "JOBS", "AGENTS", "FOOTER"]);
  assert.ok(
    renderSidebar(40).findIndex((row) => row.includes("TOP")) <
      renderSidebar(40).findIndex((row) => row.includes("TODO")),
    "the card is above the host's first part too",
  );
});

test("after a middle native part draws between that part and the next one", () => {
  registerAllParts();
  registerSection(section("news", { title: "NEWS", placement: { after: "jobs" } }));
  arm();

  assert.deepEqual(cardTitles(), ["TODO", "JOBS", "NEWS", "AGENTS", "FOOTER"]);
});

test("a section that keeps its default still lands after every native part", () => {
  registerAllParts();
  registerSection(section("plain", { title: "PLAIN" }));
  arm();

  assert.deepEqual(cardTitles(), ["TODO", "JOBS", "AGENTS", "FOOTER", "PLAIN"]);
});

test("sections before and after the host's rows share one part's frame", () => {
  registerAllParts();
  registerSection(section("top", { title: "TOP", placement: "start" }));
  registerSection(section("plain", { title: "PLAIN" }));
  arm();

  // TODO carries our before-block, FOOTER carries our after-block: two parts, four frames.
  assert.deepEqual(cardTitles(), ["TOP", "TODO", "JOBS", "AGENTS", "FOOTER", "PLAIN"]);
});

// ---------------------------------------------------------------------------------------------
// S5 — the fallbacks are decided by RENDER, and the report says where a card really went.
// ---------------------------------------------------------------------------------------------

test("a hidden native part moves start to the next painted part", () => {
  registerAllParts();
  fakeState().visibility = { todo: false };
  registerSection(section("top", { title: "TOP", placement: "start" }));
  arm();

  assert.deepEqual(observedPaintedParts(), ["jobs", "agents", "footer"]);
  assert.deepEqual(cardTitles(), ["TOP", "JOBS", "AGENTS", "FOOTER"]);
});

test("after a hidden native part falls forward to the next painted part", () => {
  registerAllParts();
  fakeState().visibility = { todo: false };
  registerSection(section("news", { title: "NEWS", placement: { after: "todo" } }));
  arm();

  assert.deepEqual(cardTitles(), ["JOBS", "NEWS", "AGENTS", "FOOTER"]);
  const entry = collectStatus().sections?.[0];
  assert.deepEqual(entry?.placement, {
    requested: 'after "todo"',
    landed: "after jobs",
    reason: 'the native rail part "todo" is not painted; it landed after jobs',
  });
  assert.ok(
    formatStatus(collectStatus()).some((line) =>
      line.includes('placement after "todo" → after jobs'),
    ),
    "the fallback is one line of /bridge-status",
  );
});

test("a section after a part the host never registered falls forward too", () => {
  registerNativeRail("todo", nativePart("TODO"));
  registerNativeFooter(nativePart("FOOTER"));
  registerSection(section("news", { title: "NEWS", placement: { after: "jobs" } }));
  arm();

  assert.deepEqual(cardTitles(), ["TODO", "FOOTER", "NEWS"]);
  assert.equal(collectStatus().sections?.[0].placement?.landed, "after footer");
});

test("hiding a section does not move the sections placed after it", () => {
  registerAllParts();
  registerSection(section("anchor", { title: "ANCHOR", placement: "start" }));
  registerSection(section("follower", { title: "FOLLOWER", placement: { after: "anchor" } }));
  arm();
  assert.deepEqual(cardTitles(), ["ANCHOR", "FOLLOWER", "TODO", "JOBS", "AGENTS", "FOOTER"]);

  // The user hides the anchor from `Sections`. Its follower stays where the anchor was.
  setSectionVisible("anchor", false);

  assert.deepEqual(cardTitles(), ["FOLLOWER", "TODO", "JOBS", "AGENTS", "FOOTER"]);
});

test("a malformed placement is reported and the card is placed at the end", () => {
  registerAllParts();
  registerSection(
    section("broken", {
      title: "BROKEN",
      // SAFETY: the point of the test is a value the type forbids.
      placement: { after: "" } as unknown as SidebarSection["placement"],
    }),
  );
  arm();

  assert.deepEqual(cardTitles(), ["TODO", "JOBS", "AGENTS", "FOOTER", "BROKEN"]);
  const lines = formatStatus(collectStatus());
  const at = lines.findIndex((line) => line.startsWith("placement rejections:"));
  assert.notEqual(at, -1, "the rejection has its own block");
  assert.match(lines[at + 1] ?? "", /section "broken" placement \{"after":""\}/);
  assert.match(lines[at + 1] ?? "", /placed at the end/);
});

// ---------------------------------------------------------------------------------------------
// S7 — hit-testing with contributed rows on BOTH sides of the host's own.
// ---------------------------------------------------------------------------------------------

test("a host row reaches the host's handler with the host's own y, even with a card above it", () => {
  const seen: unknown[] = [];
  const native = nativePart("TODO");
  registerNativeRail("todo", {
    ...native,
    handleMouse: (event) => {
      seen.push(event);
      return undefined;
    },
  });
  registerNativeFooter(nativePart("FOOTER"));
  registerSection(section("top", { title: "TOP", placement: "start" }));
  arm();
  const todo = () => fakeState().parts.get("todo");
  const frame = todo()?.render(40) ?? [];
  const before = frame.length - native.render(40).length;
  assert.ok(before > 0, "our block really sits above the host's rows");

  // The host's own heading is the row it drew first, wherever our block put it in the frame.
  const heading = frame.findIndex((row) => row.includes("▾ TODO"));
  assert.equal(heading, before);

  todo()?.handleMouse?.({ type: "click", button: "left", x: 4, y: heading, width: 40 });

  const forwarded = seen.at(-1) as { y?: number } | undefined;
  assert.equal(forwarded?.y, 0, "the host is told the row it drew, not the row in the part frame");
});

test("a click on a card above the host's rows reaches the section, never the host", () => {
  const hostCalls: unknown[] = [];
  const native = nativePart("TODO");
  registerNativeRail("todo", {
    ...native,
    handleMouse: (event) => {
      hostCalls.push(event);
      return undefined;
    },
  });
  registerNativeFooter(nativePart("FOOTER"));
  const clicks: string[] = [];
  registerSection(
    section("top", {
      title: "TOP",
      placement: "start",
      lines: () => [{ label: "act", onClick: () => clicks.push("act") }, "inert row"],
    }),
  );
  arm();
  const todo = () => fakeState().parts.get("todo");
  todo()?.render(40);

  // Row 1 of the part frame is the body of OUR card, above the host's own rows.
  todo()?.handleMouse?.({ type: "click", button: "left", x: 4, y: 1, width: 40 });

  assert.deepEqual(clicks, ["act"], "the bridge's target answered");
  assert.deepEqual(hostCalls, [], "and the host was never asked about a row it did not draw");

  // An INERT row of ours declines, so the host still runs — on a row it does not own either.
  assert.equal(todo()?.handleMouse?.({ type: "click", button: "left", x: 4, y: 2, width: 40 }), undefined);
  const forwarded = hostCalls.at(-1) as { y?: number } | undefined;
  const nativeRows = native.render(40).length;
  assert.ok(
    forwarded?.y !== undefined && forwarded.y >= nativeRows,
    "the host was offered a row past its own frame, which it never owns",
  );
});

test("a move over a host row between two contributed blocks stays the host's", () => {
  const hostMoves: unknown[] = [];
  const native = nativePart("TODO");
  registerNativeRail("todo", {
    ...native,
    handleMouse: (event) => {
      hostMoves.push(event);
      return { handled: true, render: true, host: true };
    },
  });
  registerNativeFooter(nativePart("FOOTER"));
  registerSection(section("top", { title: "TOP", placement: "start" }));
  registerSection(section("plain", { title: "PLAIN" }));
  arm();
  const todo = () => fakeState().parts.get("todo");
  const frame = todo()?.render(40) ?? [];

  // A contributed block above, the host's own rows in the middle, another block below.
  assert.ok(frame.length > native.render(40).length, "the part carries our rows on both sides");
  const body = frame.findIndex((row) => row.includes("TODO row"));
  assert.deepEqual(todo()?.handleMouse?.({ type: "move", button: "none", x: 4, y: body, width: 40 }), {
    handled: true,
    render: true,
    host: true,
  });
  assert.deepEqual(hostMoves, [{ type: "move", button: "none", x: 4, y: 1, width: 40 }]);
});

// ---------------------------------------------------------------------------------------------
// S8 — the mobile `/gentle:panel` sheet reads the same map values, so it needs no extra work.
// ---------------------------------------------------------------------------------------------

test("the panel sheet paints our rows too: it reads the same map value", () => {
  registerAllParts();
  registerSection(section("top", { title: "TOP", placement: "start" }));
  registerSection(section("plain", { title: "PLAIN" }));

  // Exactly what `SHEET_ORDER` does (`lib/shell-panel.ts:125-150`): for every painted key, render
  // the value in `parts`, keeping its lines. No card frame here, which is why a raw row is enough.
  const sheet = (inner: number): string[] =>
    RAIL_PARTS.flatMap((key) => [...(fakeState().parts.get(key)?.render(inner) ?? [])]);
  assert.deepEqual(sheet(40), ["▾ TODO", "TODO row", "▾ JOBS", "JOBS row", "▾ AGENTS", "AGENTS row", "▾ FOOTER", "FOOTER row"], "before arming the sheet shows only the host's rows");

  arm();

  const painted = sheet(40);
  const at = (text: string): number => painted.findIndex((row) => row.includes(text));
  assert.ok(painted[0].includes("TOP"), "the sheet starts with the card placed at the start");
  assert.ok(
    at("▾ FOOTER") < at("▾ PLAIN"),
    "and the card placed at the end follows the host's last part",
  );
  assert.ok(at("▾ TOP") < at("▾ TODO"), "with no extra work: the wrapper is the map's value");
});

// ---------------------------------------------------------------------------------------------
// Idempotency and the restore path, now on four parts instead of one.
// ---------------------------------------------------------------------------------------------

test("all four painted parts are wrapped, and no other key is", () => {
  registerAllParts();
  registerNativeRail("header", nativePart("HEADER"));
  registerNativeRail("statusbar", nativePart("STATUS"));
  const originals = new Map(RAIL_PARTS.map((key) => [key, fakeState().parts.get(key)]));
  const header = fakeState().parts.get("header");
  arm();

  for (const key of RAIL_PARTS) {
    assert.notEqual(fakeState().parts.get(key), originals.get(key), `${key} is wrapped`);
  }
  assert.equal(fakeState().parts.get("header"), header, "a key the layout never paints is untouched");
});

test("a second arm wraps nothing twice and the render is stable", () => {
  registerAllParts();
  registerSection(section("top", { title: "TOP", placement: "start" }));
  arm();
  const wrappers = RAIL_PARTS.map((key) => fakeState().parts.get(key));
  const before = renderSidebar(40);

  arm();

  assert.deepEqual(
    RAIL_PARTS.map((key) => fakeState().parts.get(key)),
    wrappers,
    "the same wrapper objects",
  );
  assert.deepEqual(renderSidebar(40), before, "and the same frame");
});

test("disable restores every host part and leaves a retained wrapper passive", () => {
  registerAllParts();
  const originals = new Map(RAIL_PARTS.map((key) => [key, fakeState().parts.get(key)]));
  registerSection(section("top", { title: "TOP", placement: "start" }));
  arm();
  const retained = fakeState().parts.get("todo");
  assert.deepEqual(cardTitles()[0], "TOP");

  assert.equal(disableSidebarBackend(), 4, "four rails restored");
  for (const key of RAIL_PARTS) {
    assert.equal(fakeState().parts.get(key), originals.get(key), `${key} is the host's own rail`);
  }
  assert.deepEqual(retained?.render(40), ["▾ TODO", "TODO row"], "a retained wrapper adds nothing");
});

test("a part the host registers after the arm is captured on the same frame", () => {
  registerNativeFooter(nativePart("FOOTER"));
  arm();
  fakeState().parts.set("todo", nativePart("TODO"));
  registerSection(section("top", { title: "TOP", placement: "start" }));

  assert.deepEqual(cardTitles(), ["TOP", "TODO", "FOOTER"]);
});

test("a throwing contributor loses its own rows on that part only", () => {
  registerAllParts();
  installSidebarBackend(() => fakeTui());
  registerSection(section("top", { title: "TOP", placement: "start" }));
  arm();
  // One frame with the real contributor, so the wrapper's memo is warm.
  assert.deepEqual(cardTitles()[0], "TOP");

  assert.deepEqual(
    getSidebarDiagnostics().lastFailures.filter((failure) => failure.phase === "contribute"),
    [],
  );
});

test("the placement reaches the host's memo: a new anchor moves the digest", () => {
  registerAllParts();
  const registered = section("card", { title: "CARD" });
  registerSection(registered);
  arm();
  const footer = () => fakeState().parts.get("footer");
  footer()?.render(40);
  const before = footer()?.digest?.();

  // The same id re-registered with a placement: one section, a different slot.
  registerSection(section("card", { title: "CARD", placement: "start" }));

  assert.notEqual(footer()?.digest?.(), before, "the digest notices the card moved");
  assert.deepEqual(cardTitles()[0], "CARD");
});

test("the sidebar report answers which parts the host paints", () => {
  registerAllParts();
  fakeState().visibility = { todo: false };
  registerSection(section("top", { placement: "start" }));
  arm();
  renderSidebar(40);

  const lines = formatStatus(collectStatus());
  assert.ok(lines.includes("rail parts: jobs, agents, footer"), lines.join("\n"));
});

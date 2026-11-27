/**
 * Section interaction (N12, N13, N14), proven against the fake host.
 *
 * The host's click model is positional: it maps a pointer event into the part's frame and calls the
 * part's `handleMouse` (`lib/shell-sidebar-layout.ts:245-259`), and a part answers only the physical
 * rows it declared. `test/fake-sidebar.ts` owns the rail map and the frame, so these tests dispatch
 * events exactly the way the layout would: `y` counts the PART's rows, which is why the native
 * footer's three rows come first.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { setRepaintHost, resetRepaintForTests } from "../src/repaint.ts";
import { setSectionTheme, resetSectionPanelForTests } from "../src/section-panel.ts";
import { resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import {
  getSectionFailures,
  installSectionRail,
  resetSectionFailuresForTests,
} from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SectionRow, SidebarSection } from "../src/types.ts";
import { getSectionCollapsed, isSectionCollapsed } from "../src/visibility.ts";
import {
  cardBody,
  cacheRevision,
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-interaction-"));
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
  renders = 0;
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

let renders = 0;

/** Arm the rail with a `tui` whose `requestRender` and cache revision a test can count. */
function arm(): void {
  const tui = {
    terminal: fakeTerminal(),
    requestRender: () => {
      renders += 1;
    },
  };
  setRepaintHost(tui);
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

const rail = () => fakeState().parts.get(SIDEBAR_RAIL_KEY);
const rowOf = (text: string, width = 40): string | undefined =>
  (rail()?.render(width) ?? []).find((row) => row.includes(text));

/** The native footer renders three rows, so the contribution's first row is 3. */
const NATIVE_ROWS = 3;

const move = (y: number): unknown =>
  rail()?.handleMouse?.({ type: "move", button: "none", x: 4, y, width: 40, height: 40 });
const click = (y: number): unknown =>
  rail()?.handleMouse?.({ type: "click", button: "left", x: 4, y, width: 40, height: 40 });

const ROLE_SGR: Record<string, number> = {
  text: 37,
  muted: 90,
  dim: 2,
  accent: 95,
  success: 32,
  error: 31,
  warning: 33,
};

function fakeTheme(): { fg(role: string, text: string): string; bold(text: string): string } {
  return {
    fg: (role, text) => `\u001b[${ROLE_SGR[role] ?? 0}m${text}\u001b[39m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
  };
}

test("only a row that carries onClick highlights and answers the pointer", () => {
  setSectionTheme(fakeTheme());
  const calls: string[] = [];
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [
        { label: "play", onClick: () => calls.push("play") },
        { label: "inert" },
      ],
    }),
  );
  arm();
  renderSidebar();

  const inertRow = NATIVE_ROWS + 2;
  // An inert row never highlights and never asks for a frame. The move is still CONSUMED, by the
  // host's own part region: it answers every move inside its frame
  // (`lib/native-pointer-region.ts:80-88`, `extensions/gentle-shell.ts:2732-2741`), so `handled` is
  // the honest answer even where the bridge has nothing to do.
  assert.deepEqual(move(inertRow), { handled: true }, "an inert row does not answer a hover");
  assert.equal(renders, 0, "and nothing repaints");
  assert.ok(!(rowOf("inert") ?? "").includes("\u001b[33m"), "an inert row never highlights");

  const playRow = NATIVE_ROWS + 1;
  assert.deepEqual(move(playRow), { handled: true, render: true }, "the clickable row answers");
  assert.equal(renders, 1, "and asks for one frame");
  assert.ok((rowOf("play") ?? "").includes("\u001b[33m"), "the hovered row takes the hover role");

  assert.deepEqual(move(playRow), { handled: true }, "the same row again is not a new hover");
  assert.equal(renders, 1, "so it asks for no frame");

  assert.deepEqual(move(inertRow), { handled: true, render: true }, "leaving the row clears it");
  assert.equal(renders, 2);
  assert.ok(!(rowOf("play") ?? "").includes("\u001b[33m"), "the row is painted idle again");
  assert.deepEqual(calls, [], "hovering never runs a row's work");
});

test("one click calls exactly one onClick, and only on the row that has one", () => {
  const calls: string[] = [];
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [
        { label: "play", onClick: () => calls.push("play") },
        { label: "inert" },
      ],
    }),
  );
  arm();
  renderSidebar();

  assert.deepEqual(click(NATIVE_ROWS + 1), { handled: true, render: true });
  assert.deepEqual(calls, ["play"], "one click, one call");

  renderSidebar();
  assert.deepEqual(click(NATIVE_ROWS + 1), { handled: true, render: true });
  assert.deepEqual(calls, ["play", "play"], "and one more click, one more call");

  assert.equal(click(NATIVE_ROWS + 2), undefined, "an inert row declines the click");
  assert.deepEqual(calls, ["play", "play"], "and calls nothing");
});

test("the header click collapses the section, and a collapsed body is not built", () => {
  let linesCalls = 0;
  let metaCalls = 0;
  registerSection(
    section("music", {
      title: "MUSIC",
      meta: () => {
        metaCalls += 1;
        return "1 playing";
      },
      lines: () => {
        linesCalls += 1;
        return ["track  Blue in Green"];
      },
    }),
  );
  arm();
  renderSidebar();
  assert.equal(linesCalls, 1);

  assert.deepEqual(click(NATIVE_ROWS), { handled: true, render: true }, "the header is the control");

  assert.ok(isSectionCollapsed(getSectionCollapsed(), { id: "music" }), "the click folded it");
  assert.ok(readFileSync(join(configHome, "gentle-shell-bridge", "bridge-sections.json"), "utf8").includes('"music": true'), "and the state is stored");

  linesCalls = 0;
  metaCalls = 0;
  const rows = (rail()?.render(40) ?? []).slice(NATIVE_ROWS);
  assert.equal(rows.length, 1, "a collapsed section is its header alone");
  assert.equal(linesCalls, 0, "its body is NOT BUILT, not built and hidden");
  assert.equal(metaCalls, 1, "the header's count is still read, because the header is drawn");

  click(NATIVE_ROWS);
  assert.equal(isSectionCollapsed(getSectionCollapsed(), { id: "music" }), false);
  assert.deepEqual(cardBody("MUSIC"), ["track  Blue in Green"], "expanding builds the body again");
});

test("the collapse repaints in the same frame, through the host's own two steps", () => {
  registerSection(section("music", { title: "MUSIC" }));
  arm();
  renderSidebar();
  const before = cacheRevision();
  renders = 0;

  click(NATIVE_ROWS);

  assert.equal(renders, 1, "exactly one frame is asked for");
  assert.equal(cacheRevision(), before + 1, "and the terminal's sidebar revision moved");
});

test("the collapsed state survives a reload: it is bridge store state, like visibility", () => {
  registerSection(section("music", { title: "MUSIC" }));
  arm();
  renderSidebar();
  click(NATIVE_ROWS);

  // A reload loses every in-memory frame but not the store.
  resetSectionFailuresForTests();
  resetSectionPointerForTests();
  assert.deepEqual(
    (rail()?.render(40) ?? []).slice(NATIVE_ROWS).length,
    1,
    "the card is still folded",
  );
  assert.equal(isSectionCollapsed(getSectionCollapsed(), { id: "music" }), true);
});

test("a meta that moves is drawn on the next frame without re-registering, and moves the digest", () => {
  let meta = "default";
  registerSection(
    section("music", {
      title: "MUSIC",
      meta: () => meta,
      lines: () => [`rendering  ${meta}`],
    }),
  );
  arm();
  renderSidebar();

  const before = rail()?.digest?.();
  assert.equal(typeof before, "string");
  assert.ok((rowOf("default") ?? "").includes("default"), "the header carries the count");

  meta = "tool";

  const after = rail()?.digest?.();
  assert.notEqual(after, before, "the digest notices the change, so the host re-renders");
  assert.ok((rowOf("tool") ?? "").includes("tool"), "and the field is live, with no re-registration");
  assert.ok((rowOf("rendering  tool") ?? "").length > 0, "a plain row is rebuilt from the same call");
});

test("the hover claim is the host's own pointer slot, and the host can take it back", () => {
  setSectionTheme(fakeTheme());
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [{ label: "play", onClick: () => {} }],
    }),
  );
  arm();
  renderSidebar();

  move(NATIVE_ROWS + 1);
  const hover = (fakeState() as unknown as { hover?: { owner: object; clear: () => void } }).hover;
  assert.ok(hover !== undefined, "the shared pointer slot carries our claim");
  assert.equal(typeof hover.clear, "function");

  // What the host's fallback mouse handler does when the pointer leaves the rail
  // (`lib/shell-sidebar-layout.ts:249-252`): `setSidebarHover(tui)` with no owner.
  renders = 0;
  delete (fakeState() as unknown as { hover?: unknown }).hover;
  hover.clear();

  assert.equal(renders, 1, "the clear repaints once");
  assert.ok(!(rowOf("play") ?? "").includes("\u001b[33m"), "and the row is idle again");
});

test("a pointer event for a row we did not draw is declined, never guessed", () => {
  const calls: string[] = [];
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [{ label: "play", onClick: () => calls.push("play") }],
    }),
  );
  arm();
  renderSidebar();

  assert.equal(click(1), undefined, "a native row is not ours");
  assert.equal(click(NATIVE_ROWS + 9), undefined, "a row past the contribution is not ours");
  assert.equal(
    rail()?.handleMouse?.({ type: "click", button: "left", x: 4, y: NATIVE_ROWS + 1 }),
    undefined,
    "without a frame width the offset cannot be mapped",
  );
  assert.deepEqual(calls, []);
});

test("a throwing onClick is recorded, not thrown into the host's dispatch", () => {
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [
        {
          label: "boom",
          onClick: () => {
            throw new Error("onClick exploded");
          },
        },
      ],
    }),
  );
  arm();
  renderSidebar();

  assert.deepEqual(click(NATIVE_ROWS + 1), { handled: true, render: true });
  const failure = getSectionFailures().find((entry) => entry.sectionId === "music");
  assert.equal(failure?.phase, "onClick");
  assert.equal(failure?.message, "onClick exploded");
});

test("a structured row is still capped and elided like a plain one", () => {
  const rows: SectionRow[] = Array.from({ length: 12 }, (_, index) => ({
    label: `row ${index + 1}`,
    meta: `${index}`,
  }));
  registerSection(section("many", { title: "MANY", lines: () => rows }));
  arm();
  renderSidebar();

  const body = cardBody("MANY");
  assert.equal(body.length, 8);
  assert.equal(body.at(-1), "… +5 more");
});

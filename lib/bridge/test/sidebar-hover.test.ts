/**
 * S21/T40–T41: hover reaches the bridge's own rail rows.
 *
 * The fake now models the host's part-level mouse dispatch as it really is. The `footer` part is a
 * `NativePointerRegion` (`extensions/gentle-shell.ts:2766`) whose `onHover` answers EVERY `move`
 * inside the part's frame (`lib/native-pointer-region.ts:80-88`,
 * `extensions/gentle-shell.ts:2732-2741`): it claims the host's shared pointer slot
 * (`SidebarState.hover`, `lib/shell-sidebar.ts:31,72-78`) for a row it owns and clears it otherwise,
 * returning `{ handled: true }` either way. A move over a row the bridge appended is therefore
 * consumed by the host's region and never reaches the bridge's wrapper, which is why these tests
 * failed before the fix: the wrapper consulted the host first and only asked the contributor when
 * the host declined, and the host never declines a move.
 *
 * Every dispatch below is the event the layout really hands a part — `y` in the PART's frame, `width`
 * the frame it rendered (`lib/shell-sidebar-layout.ts:245-259`) — so the offset arithmetic is the
 * bridge's real code, not a test-only shortcut.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { setRepaintHost, resetRepaintForTests } from "../src/repaint.ts";
import { resetSectionPanelForTests, setSectionTheme } from "../src/section-panel.ts";
import { getSectionHoverReport, resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import {
  installSectionRail,
  resetSectionFailuresForTests,
} from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SidebarSection } from "../src/types.ts";
import {
  cacheRevision,
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
  setHostHover,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-sidebar-hover-"));
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

/** The section HEADER row, and the first inner row of a body, in the part's own frame. */
const HEADER_ROW = NATIVE_ROWS;
const FIRST_BODY_ROW = NATIVE_ROWS + 1;

const move = (y: number): unknown =>
  rail()?.handleMouse?.({ type: "move", button: "none", x: 4, y, width: 40, height: 40 });
const click = (y: number): unknown =>
  rail()?.handleMouse?.({ type: "click", button: "left", x: 4, y, width: 40, height: 40 });

/** The host's hover role (`HOVER_ROLE = "warning"`, `lib/shell-hover.ts:33`), as SGR 33. */
const HOVER_SGR = "\u001b[33m";

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
    fg: (role, text) => `\u001b[${String(ROLE_SGR[role] ?? 0)}m${text}\u001b[39m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
  };
}

test("a move over the section HEADER paints it with the host's hover role", () => {
  setSectionTheme(fakeTheme());
  registerSection(section("music", { title: "MUSIC" }));
  arm();
  renderSidebar();

  assert.ok(!(rowOf("MUSIC") ?? "").includes(HOVER_SGR), "the header starts idle");
  const digestBefore = rail()?.digest?.();
  const revisionBefore = cacheRevision();

  assert.deepEqual(move(HEADER_ROW), { handled: true, render: true }, "the header answers the move");
  assert.equal(renders, 1, "exactly one differential frame is asked for");
  assert.equal(cacheRevision(), revisionBefore + 1, "and the host's sidebar revision moved");
  assert.ok((rowOf("MUSIC") ?? "").includes(HOVER_SGR), "the header takes the host's hover role");

  const hover = fakeState().hover;
  assert.ok(hover !== undefined, "the shared pointer slot carries our claim");
  assert.equal(getSectionHoverReport().mechanism, "host-state");
  assert.notEqual(rail()?.digest?.(), digestBefore, "the hover moves the digest, so no stale frame");
});

test("a move over an inner CLICKABLE row paints it, and never runs its action", () => {
  setSectionTheme(fakeTheme());
  const calls: string[] = [];
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [
        { label: "play", meta: "enter", onClick: () => calls.push("play") },
        { label: "inert" },
      ],
    }),
  );
  arm();
  renderSidebar();

  assert.ok(!(rowOf("play") ?? "").includes(HOVER_SGR), "the row starts idle");

  assert.deepEqual(move(FIRST_BODY_ROW), { handled: true, render: true }, "the row answers the move");
  assert.equal(renders, 1, "one frame");
  assert.ok((rowOf("play") ?? "").includes(HOVER_SGR), "the row takes the host's hover role");
  assert.equal(fakeState().hover !== undefined, true, "the shared pointer slot carries our claim");
  assert.deepEqual(calls, [], "hovering never runs a row's work");

  assert.deepEqual(move(FIRST_BODY_ROW), { handled: true }, "the same row again is not a new hover");
  assert.equal(renders, 1, "so it asks for no frame");

  assert.deepEqual(move(FIRST_BODY_ROW + 1), { handled: true, render: true }, "an inert row clears it");
  assert.equal(renders, 2);
  assert.ok(!(rowOf("play") ?? "").includes(HOVER_SGR), "the row is painted idle again");
});

test("the host's own row keeps the pointer: the bridge never steals it", () => {
  setSectionTheme(fakeTheme());
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [{ label: "play", onClick: () => {} }],
    }),
  );
  arm();
  renderSidebar();

  // Row 1 is the native footer's own body row: the host's region claims it, and a fix that asked the
  // contributor first for EVERY row would take the pointer from the card the user says works today.
  assert.deepEqual(
    move(1),
    { handled: true, render: true },
    "the host's region answered, exactly as it does for its own cards",
  );
  assert.equal(renders, 0, "no bridge frame is asked for");
  assert.equal(getSectionHoverReport().mechanism, "not used", "the bridge never claimed the pointer");
  assert.ok(fakeState().hover !== undefined, "the host's own claim holds the slot");
  assert.ok(!(rowOf("MUSIC") ?? "").includes(HOVER_SGR), "and none of our rows is painted");
  assert.ok(!(rowOf("play") ?? "").includes(HOVER_SGR));
});

test("moving from our row to the host's row hands the pointer back, one surface at a time", () => {
  setSectionTheme(fakeTheme());
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [{ label: "play", onClick: () => {} }],
    }),
  );
  arm();
  renderSidebar();

  move(FIRST_BODY_ROW);
  assert.ok((rowOf("play") ?? "").includes(HOVER_SGR), "our row is painted while it owns the pointer");
  const claimed = fakeState().hover?.owner;

  move(0);
  assert.notEqual(fakeState().hover?.owner, claimed, "the host's own target took the pointer");
  assert.ok(!(rowOf("play") ?? "").includes(HOVER_SGR), "and our row is released, not left painted");
});

test("the host's own pointer-left step clears our row and repaints once", () => {
  setSectionTheme(fakeTheme());
  registerSection(section("music", { title: "MUSIC" }));
  arm();
  renderSidebar();
  move(HEADER_ROW);
  assert.equal(renders, 1);

  // `setSidebarHover(tui)` with no owner: what the layout does when the pointer leaves the rail
  // (`lib/shell-sidebar-layout.ts:280,447`). It runs the current owner's `clear()`.
  setHostHover();

  assert.equal(renders, 2, "the clear repaints once");
  assert.equal(fakeState().hover, undefined, "the slot is empty");
  assert.ok(!(rowOf("MUSIC") ?? "").includes(HOVER_SGR), "the header is idle again");
});

test("a click on an inner action row still runs once, and only on that row", () => {
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

  assert.deepEqual(click(FIRST_BODY_ROW), { handled: true, render: true });
  assert.deepEqual(click(FIRST_BODY_ROW), { handled: true, render: true });
  assert.deepEqual(calls, ["play", "play"], "one click, one call — never doubled by the host");

  assert.equal(click(FIRST_BODY_ROW + 1), undefined, "an inert row declines");
  assert.equal(click(HEADER_ROW + 9), undefined, "a row past the contribution is not ours");
  assert.deepEqual(calls, ["play", "play"]);
});

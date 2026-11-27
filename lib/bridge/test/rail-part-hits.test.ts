/**
 * Contributed rail rows stay live under a PARTIAL pass (S1–S3, S5): the host's layout memo re-renders
 * ONE part when that part's digest moves, so a live tick in `todo`, `jobs` or `agents` repaints that
 * part alone. The pointer map a contributed row answers from must therefore be recorded PER PART:
 * one part's re-render must never erase another part's rows.
 *
 * The bug this pins (0.13.0–0.16.1): the renderer kept ONE frame of row ranges for the whole rail and
 * the first part of a new pass erased every part's blocks, so after any partial pass the footer's
 * contributed rows were inert — no click, no hover. The events below are dispatched exactly the way
 * the layout dispatches them (`lib/shell-sidebar-layout.ts:245-259`): `y` counts the PART's rows, so
 * the native footer's three rows come first and the section's header is row 3.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { resetRepaintForTests, setRepaintHost } from "../src/repaint.ts";
import { resetSectionPanelForTests, setSectionTheme } from "../src/section-panel.ts";
import { resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { installSectionRail, resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { SidebarSection } from "../src/types.ts";
import {
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  registerNativeRail,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-rail-part-hits-"));
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

/** Arm the rail with a `tui` whose `requestRender` a test can count. */
function arm(): void {
  const tui = {
    terminal: fakeTerminal(),
    requestRender: () => {
      renders += 1;
    },
  };
  setRepaintHost(tui);
  // Every painted part the fake layout walks, so a "partial pass" is a real second render of one.
  registerNativeRail("todo", nativePart("TODO"));
  registerNativeRail("agents", nativePart("AGENTS"));
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

/** The host's own part shape: a `▾ TITLE` header and two body rows, declared as one card group. */
function nativePart(title: string): {
  render(): string[];
  cardGroups(): { groups: Array<{ start: number; end: number }> };
  digest(): string;
} {
  const lines = [`▾ ${title}`, "native row 1", "native row 2"];
  return {
    render: () => [...lines],
    cardGroups: () => ({ groups: [{ start: 0, end: lines.length }] }),
    digest: () => `${title.toLowerCase()}:native`,
  };
}

/** The native footer renders three rows, so the contribution's first row is 3. */
const NATIVE_ROWS = 3;

const part = (key: string) => fakeState().parts.get(key);
const footer = () => part("footer");

/** The footer's wrapped render: what the user reads, host rows first and our rows after them. */
const footerRows = (width = 40): string[] => footer()?.render(width) ?? [];
const rowOf = (text: string, width = 40): string | undefined =>
  footerRows(width).find((row) => row.includes(text));

/** One part re-rendered on its own — exactly what the layout memo does when its digest moves. */
const reRenderPart = (key: string, width = 40): void => {
  part(key)?.render(width);
};

const event = (type: "move" | "click", y: number, width = 40): unknown => ({
  type,
  button: type === "click" ? "left" : "none",
  x: 4,
  y,
  width,
  height: 40,
});

const move = (y: number, width = 40): unknown => footer()?.handleMouse?.(event("move", y, width));
const click = (y: number, width = 40): unknown => footer()?.handleMouse?.(event("click", y, width));

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

/** The one section these tests contribute: the default placement puts it after the footer's rows. */
const registerMusic = (calls: string[] = []): void => {
  registerSection(
    section("music", {
      title: "MUSIC",
      lines: () => [
        { label: "play", onClick: () => calls.push("play") },
        { label: "inert" },
      ],
    }),
  );
};

/** S1. A part repainted on its own must not take the footer's clickable row with it. */
test("S1: a one-part re-render keeps the footer's clickable row answering", () => {
  const calls: string[] = [];
  registerMusic(calls);
  arm();
  renderSidebar(40);

  assert.deepEqual(click(4), { handled: true, render: true }, "the full pass recorded the row");
  assert.deepEqual(calls, ["play"], "one click, one call");

  // The layout memo re-renders ONE part when its digest moves: the earlier painted `todo` here.
  reRenderPart("todo");

  assert.deepEqual(click(4), { handled: true, render: true }, "the footer's row still answers");
  assert.deepEqual(calls, ["play", "play"], "and runs its onClick exactly once");
});

/** S2. The same partial pass must not cost the hover either. */
test("S2: hover survives a one-part re-render, and the same row is not a new hover", () => {
  setSectionTheme(fakeTheme());
  registerMusic();
  arm();
  renderSidebar(40);

  reRenderPart("todo");

  assert.deepEqual(move(4), { handled: true, render: true }, "the row claims the hover");
  assert.equal(renders, 1, "and asks for exactly one frame");
  assert.ok((rowOf("play") ?? "").includes("\u001b[33m"), "the hovered row takes the hover role");

  assert.deepEqual(move(4), { handled: true }, "the same row again is not a new hover");
  assert.equal(renders, 1, "so it asks for no frame");
});

/** S3. Ranges answer only at the width they were recorded at, and are replaced by a re-render. */
test("S3: a part's ranges answer only the width they were recorded at", () => {
  const calls: string[] = [];
  registerMusic(calls);
  arm();
  renderSidebar(40);
  assert.deepEqual(click(4), { handled: true, render: true }, "recorded at 40, answering at 40");

  // The footer alone is re-rendered at a new width: its ranges are REPLACED at that width.
  reRenderPart("footer", 50);

  assert.equal(
    click(4, 40),
    undefined,
    "an event mapped at 40 declines instead of guessing an offset",
  );
  assert.deepEqual(calls, ["play"], "and runs nothing");
  assert.deepEqual(click(4, 50), { handled: true, render: true }, "the ranges recorded at 50 answer");
  assert.deepEqual(calls, ["play", "play"], "one click, one call");
});

/** S5 (first half). A part this contributor never rendered has no ranges to answer with. */
test("S5: a part the contributor never rendered declines the event", () => {
  const calls: string[] = [];
  registerMusic(calls);
  arm();
  renderSidebar(40);

  // `agents` rendered its own rows, but no section landed there: a click inside its frame is not
  // ours to answer, and nothing may run.
  const agents = part("agents");
  assert.ok(agents !== undefined, "the agents part is wrapped like every painted part");
  assert.equal(agents?.handleMouse?.(event("click", 1)), undefined, "it has no ranges to answer");
  assert.equal(agents?.handleMouse?.(event("move", 1)), undefined, "and no hover to claim");
  assert.deepEqual(calls, [], "nothing ran");
});

/** S5 (second half). The test seam drops the per-part ranges AND the hover, like it always did. */
test("S5: resetSectionFailuresForTests drops the ranges and the hover", () => {
  setSectionTheme(fakeTheme());
  const calls: string[] = [];
  registerMusic(calls);
  arm();
  renderSidebar(40);

  assert.deepEqual(move(4), { handled: true, render: true }, "the row claims the hover");
  assert.ok((rowOf("play") ?? "").includes("\u001b[33m"), "and paints with the hover role");

  resetSectionFailuresForTests();
  // Only the footer re-renders, which is what records ranges for it again: the hover is NOT restored.
  reRenderPart("footer");
  assert.ok(
    !(rowOf("play") ?? "").includes("\u001b[33m"),
    "the hover was dropped by the reset, not by the frame",
  );

  // Ranges are back with that render, so the row answers again as a FRESH hover.
  assert.deepEqual(move(4), { handled: true, render: true }, "a new hover, because the old one went");

  resetSectionFailuresForTests();
  assert.equal(click(4), undefined, "the recorded ranges are gone, so the click declines");
  assert.deepEqual(calls, [], "and runs nothing");
});

/**
 * PRESERVE. The host-first rule and the "only rows that act" rule are unchanged by per-part ranges: a
 * host row still answers for the host, and a contributed row without `onClick` still declines.
 */
test("a host row still answers, and a contributed row without onClick still declines", () => {
  const calls: string[] = [];
  registerMusic(calls);
  arm();
  renderSidebar(40);

  assert.deepEqual(click(0), { handled: true, render: true }, "the host's own header row answers");
  assert.equal(click(5), undefined, "our inert body row declines the click");
  assert.deepEqual(calls, [], "and runs nothing");
});

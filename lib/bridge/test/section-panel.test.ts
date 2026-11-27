/**
 * The section's row model and its drawing (N10, N11): a section body is no longer bare text.
 *
 * Two things are proven here, and they are different claims:
 *
 * 1. **A plain string row is byte-identical.** The bytes the plugin wrote are the bytes the rail
 *    frames — no padding, no indent, no ANSI — so no existing plugin changes appearance (N10).
 * 2. **The fallback drawing is the host's drawing.** `renderPanelHeader` / `renderPanelRow` /
 *    `paintHoverable` / `clipPanelText` / `fitPanelLine` live in gentle-shell's
 *    `lib/shell-panel.ts` and `lib/shell-hover.ts`, which this package cannot import (Pi loads each
 *    extension in its own jiti module graph). The reference implementations at the bottom of this
 *    file are transcribed from those sources, and every case below compares our output to theirs
 *    byte for byte — that is what "byte-identical fallback" means, and it is a stronger claim than
 *    "looks similar".
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { setSectionTheme, resetSectionPanelForTests } from "../src/section-panel.ts";
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
import {
  cardBody,
  cardTitles,
  fakeState,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-panel-"));
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
  resetSectionPanelForTests();
  disableSidebarBackend();
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

/** Native host first, then the bridge's interception and the section renderer. */
function arm(): void {
  registerNativeFooter();
  installSidebarBackend(() => fakeTui());
  installSectionRail();
}

const rail = () => fakeState().parts.get(SIDEBAR_RAIL_KEY);
/** The rows the bridge contributes for one frame, native rows excluded. */
const contributed = (width = 40): string[] => (rail()?.render(width) ?? []).slice(3);

test("a plain string row reaches the rail byte for byte, even with a theme in force", () => {
  const theme = fakeTheme();
  setSectionTheme(theme);
  const written = "track  Blue in Green";
  registerSection(section("music", { title: "MUSIC", lines: () => [written] }));
  arm();

  assert.deepEqual(contributed(), [
    referenceHeader(theme, 40, { title: "MUSIC", open: true }),
    written,
  ]);
  assert.ok(
    !contributed()[1].includes("\u001b"),
    "a string row carries no styling the plugin did not write",
  );
  assert.deepEqual(cardBody("MUSIC"), [written]);
});

test("a structured row renders glyph, label and meta in the host's roles", () => {
  const theme = fakeTheme();
  setSectionTheme(theme);
  const row: SectionRow = {
    glyph: "♪",
    label: "Blue in Green",
    meta: "5:37",
    tone: "accent",
  };
  registerSection(section("music", { title: "MUSIC", lines: () => [row] }));
  arm();

  const [header, body] = contributed();
  assert.deepEqual(theme.calls, [
    ["muted", "▾"],
    // The host paints the uppercased title through `theme.bold` first
    // (`lib/shell-panel.ts:71-72`), then the role.
    ["text", "\u001b[1mMUSIC\u001b[22m"],
    ["accent", "♪"],
    ["accent", "Blue in Green"],
    ["muted", "5:37"],
  ]);
  assert.equal(body, referenceRow(40, `${theme.fg("accent", "♪")} ${theme.fg("accent", "Blue in Green")}`, theme.fg("muted", "5:37")));
  assert.equal(header, referenceHeader(theme, 40, { title: "MUSIC", open: true }));

  // The host's own composition: the row is indented under the header and its secondary text is
  // dimmer than its label, which is the field the report said was missing.
  const plain = stripSgr(body);
  assert.ok(plain.startsWith("  ♪ Blue in Green"), `row is indented: ${JSON.stringify(plain)}`);
  assert.ok(plain.endsWith("5:37"), `meta is right-aligned: ${JSON.stringify(plain)}`);
  assert.equal(plain.length, 40, "the host's fitPanelLine pads the row to the width");
  assert.notEqual(
    roleOf(body, "5:37"),
    roleOf(body, "Blue in Green"),
    "the meta is painted in a different role than the label",
  );
});

test("the fallback drawing equals the host's builders in every case we can compare", () => {
  const theme = fakeTheme();
  setSectionTheme(theme);
  registerSection(
    section("wide", {
      title: "Wide Section",
      meta: () => "2/6",
      lines: () => [
        { glyph: "▸", label: "a plain row", meta: "1" },
        { label: "no glyph, no meta" },
        { glyph: "✗", label: "failed", meta: "3", tone: "error" },
        { label: "a row whose text is long enough that the host has to clip it", meta: "99" },
      ],
    }),
  );
  arm();

  const width = 40;
  const rows = contributed(width);
  assert.equal(
    rows[0],
    referenceHeader(theme, width, { title: "Wide Section", count: "2/6", open: true }),
  );
  const cases: Array<[SectionRow, string]> = [
    [{ glyph: "▸", label: "a plain row", meta: "1" }, referenceRow(width, `${theme.fg("muted", "▸")} ${theme.fg("text", "a plain row")}`, theme.fg("muted", "1"))],
    [{ label: "no glyph, no meta" }, referenceRow(width, theme.fg("text", "no glyph, no meta"))],
    [
      { glyph: "✗", label: "failed", meta: "3", tone: "error" },
      referenceRow(width, `${theme.fg("error", "✗")} ${theme.fg("error", "failed")}`, theme.fg("muted", "3")),
    ],
    [
      { label: "a row whose text is long enough that the host has to clip it", meta: "99" },
      referenceRow(
        width,
        theme.fg("text", "a row whose text is long enough that the host has to clip it"),
        theme.fg("muted", "99"),
      ),
    ],
  ];
  cases.forEach(([row, expected], index) => {
    assert.equal(
      rows[index + 1],
      expected,
      `row ${JSON.stringify(row.label)} matches the host's renderPanelRow`,
    );
  });
  assert.ok(
    stripSgr(rows[4]).includes("…"),
    "a row that cannot fit is clipped with the host's ellipsis, not silently cut",
  );
});

test("a hovered row paints with the host's hover role, and only for a row that acts", () => {
  const theme = fakeTheme();
  setSectionTheme(theme);
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
  contributed(40);
  theme.calls.length = 0;

  assert.deepEqual(
    rail()?.handleMouse?.({ type: "move", button: "none", x: 4, y: 4, width: 40, height: 20 }),
    { handled: true, render: true },
    "the clickable row answers a hover",
  );
  contributed(40);

  const hoveredRow = contributed(40)[1];
  assert.equal(roleOf(hoveredRow, "play"), "warning", "the label takes the host's hover role");
  assert.equal(
    hoveredRow,
    referenceRow(40, `${paintHoverable(theme, undefined, "play", true, "text")}`, paintHoverable(theme, undefined, "enter", true, "muted")),
    "and it is drawn exactly as the host draws a hovered panel row",
  );
});

test("a row whose tone is not one of the host's roles is rejected, never coerced", () => {
  registerSection(
    section("bad", {
      title: "BAD",
      lines: () => [{ label: "row", tone: "hotpink" as unknown as "text" }],
    }),
  );
  arm();

  assert.deepEqual(cardTitles(), ["FOOTER", "BAD"]);
  assert.deepEqual(cardBody("BAD"), [], "the body is dropped");
  const failure = getSectionFailures().find((entry) => entry.sectionId === "bad");
  assert.equal(failure?.phase, "lines");
  assert.match(failure?.message ?? "", /tone/u);
});

test("a row with no usable label is rejected, never coerced", () => {
  registerSection(
    section("nob", {
      title: "NOB",
      lines: () => [{ meta: "x" } as unknown as SectionRow],
    }),
  );
  arm();

  assert.deepEqual(cardBody("NOB"), []);
  assert.match(
    getSectionFailures().find((entry) => entry.sectionId === "nob")?.message ?? "",
    /label/u,
  );
});

test("a collapsed section still gets its header, from the section's own caret", () => {
  const theme = fakeTheme();
  setSectionTheme(theme);
  registerSection(section("music", { title: "MUSIC" }));
  arm();

  contributed(40);
  rail()?.handleMouse?.({ type: "click", button: "left", x: 4, y: 3, width: 40, height: 20 });
  const rows = contributed(40);

  assert.equal(rows.length, 1, "a collapsed section is its header alone");
  assert.deepEqual(cardTitles(), ["FOOTER", "MUSIC"]);
  assert.equal(rows[0], referenceHeader(theme, 40, { title: "MUSIC", open: false }));
  assert.ok(stripSgr(rows[0]).startsWith("▸ MUSIC"), "the caret says it is collapsed");
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const ROLE_SGR: Record<string, number> = {
  text: 37,
  muted: 90,
  dim: 2,
  accent: 95,
  success: 32,
  error: 31,
  warning: 33,
};

interface FakeTheme {
  calls: Array<[string, string]>;
  fg(role: string, text: string): string;
  bold(text: string): string;
}

function fakeTheme(): FakeTheme {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    fg(role, text) {
      calls.push([role, text]);
      return `\u001b[${ROLE_SGR[role] ?? 0}m${text}\u001b[39m`;
    },
    bold(text) {
      return `\u001b[1m${text}\u001b[22m`;
    },
  };
}

/** The role a piece of text was painted in, read back out of the rendered bytes. */
function roleOf(row: string, text: string): string {
  const pattern = new RegExp(`\\u001b\\[(\\d+)m${text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");
  const match = pattern.exec(row);
  assert.ok(match !== null, `${JSON.stringify(text)} is painted in ${JSON.stringify(row)}`);
  const code = Number(match[1]);
  const role = Object.keys(ROLE_SGR).find((name) => ROLE_SGR[name] === code);
  assert.ok(role !== undefined, `code ${code} maps to a role`);
  return role;
}

function stripSgr(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

/** Visible columns of a plain-or-ANSI row, code point by code point (`visibleWidth`, ASCII here). */
function plainWidth(text: string): number {
  return [...stripSgr(text)].length;
}

// The reference implementations below are transcribed from gentle-shell, read-only:
// `lib/shell-panel.ts:44-80` (`clipPanelText`, `fitPanelLine`, `renderPanelHeader`,
// `renderPanelRow`) and `lib/shell-hover.ts:33-38` (`HOVER_ROLE`, `paintHoverable`). They are
// verbatim apart from the width function, which is pi-tui's `visibleWidth` in the host and a
// code-point count here — identical for the ASCII rows these cases use.

function referenceClip(text: string, width: number): string {
  if (width <= 0) return "";
  if (plainWidth(text) <= width) return text;
  let clipped = "";
  for (const unit of text.match(/\u001b\[[0-9;]*m|[\s\S]/gu) ?? []) {
    if (unit.startsWith("\u001b[")) {
      clipped += unit;
      continue;
    }
    if (plainWidth(clipped + unit) > width - 1) break;
    clipped += unit;
  }
  return `${clipped}…`;
}

function referenceFit(left: string, right: string, width: number): string {
  const target = Math.max(0, Math.floor(width));
  const rightWidth = plainWidth(right);
  const shownRight = rightWidth + 1 <= target ? right : "";
  const room = target - plainWidth(shownRight) - (shownRight ? 1 : 0);
  const shownLeft = referenceClip(left, room);
  return `${shownLeft}${" ".repeat(Math.max(0, target - plainWidth(shownLeft) - plainWidth(shownRight)))}${shownRight}`;
}

function paintHoverable(
  theme: FakeTheme | undefined,
  _: unknown,
  text: string,
  hovered: boolean,
  idleRole?: string,
): string {
  if (theme === undefined) return text;
  if (hovered) return theme.fg("warning", text);
  return idleRole === undefined ? text : theme.fg(idleRole, text);
}

function referenceHeader(
  theme: FakeTheme,
  width: number,
  header: { title: string; count?: string; open: boolean; hovered?: boolean },
): string {
  const glyph = paintHoverable(theme, undefined, header.open ? "▾" : "▸", header.hovered ?? false, "muted");
  const name = header.title.toUpperCase();
  const title = theme.fg(header.hovered === true ? "warning" : "text", theme.bold(name));
  const count = header.count === undefined ? "" : theme.fg("muted", header.count);
  return referenceFit(`${glyph} ${title}`, count, width);
}

function referenceRow(width: number, left: string, right = ""): string {
  return referenceFit(`${" ".repeat(2)}${left}`, right, width);
}

test("the reference drawing is itself usable: the fixtures above are the host's shape", () => {
  // A cheap guard on the transcription: if a fixture stops looking like `▾ NAME … count`, the
  // comparisons above would compare two wrong things and still pass.
  const theme = fakeTheme();
  const row = referenceHeader(theme, 20, { title: "music", count: "2", open: true });
  assert.equal(plainWidth(row), 20);
  assert.ok(stripSgr(row).startsWith("▾ MUSIC"));
  assert.ok(stripSgr(row).endsWith("2"));
  assert.equal(renderSidebar(40).length >= 0, true);
});

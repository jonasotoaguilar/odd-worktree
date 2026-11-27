/**
 * Width discipline on the host's rail (N17–N19), measured the way the host measures it.
 *
 * ## What decides the width of the main column
 *
 * The rail is the SECOND entry of the host's fullscreen `hstack`, with a FIXED basis:
 *
 * ```ts
 * { component: scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH }
 * ```
 * (`lib/shell-sidebar-layout.ts:493-496`; `RAIL_WIDTH = 50`, `GAP = 3` at `:9,:12`), so a part's
 * rows can never widen the rail column: pi-tui allocates a numeric `basis` without measuring the
 * child (`pi-tui/dist/layout.js:124`, `allocateStackSizes` in `dist/components/stack.js`). What a
 * part CAN change is whether the rail is painted at all:
 *
 * ```ts
 * const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
 * ```
 * (`lib/shell-sidebar-layout.ts:410`). When a single rail row is wider than the content width the
 * host drops the whole rail and the main column gets every column back — the layout's widths DID
 * change, from the part's output alone.
 *
 * ## How the host measures a row
 *
 * `visibleWidth` (`pi-tui/dist/utils.js:212-268`, pi-tui 1.5.x) strips complete CSI/OSC/APC
 * sequences, expands a TAB to THREE columns (`:229-231`), segments the rest into grapheme clusters
 * and charges each one the way `graphemeWidth` charges it (`:143-207`): a lone printable ASCII or
 * TAB by its own rule, a cluster of terminal-spacing marks by its code point count, zero for a
 * cluster of ignorables/controls/marks, two for an RGI emoji (after the host's own `couldBeEmoji`
 * prefilter, so a bare `©`, `☺` or `▶` is NOT an emoji and stays one column), two for a
 * regional-indicator pair, otherwise the base code point's East Asian `W|F` width plus every
 * terminal-spacing mark, mark-following visible code point (an Indic consonant after a virama),
 * halfwidth/fullwidth form and Thai/Lao AM vowel the cluster carries. This package's own
 * `visibleColumns` counts a tab as one column and every code point separately, so a row this
 * package believes is 48 columns wide can measure 51 to the host. The port below is the host's
 * model, kept here independently of `src/` — no production width helper is imported — so the
 * assertions do not test the implementation against itself; a self-check test pins the values
 * measured from the installed `visibleWidth`.
 *
 * ## The rail path, as the host paints it
 *
 * On the tinted panel surface a part's row becomes `" " + row + " "` (`:414`), and the width a part
 * is handed is `contentWidth - RAIL_PADDING * 2` (`:355`): 48 columns at `RAIL_WIDTH` 50. On a
 * transparent rail the host re-frames the rows itself through the same `< contentWidth` budget
 * (`sectionCardRows` → `cardLine`, `:36-47`), so the budget is the same number.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerSection, resetBusForTests, resetSectionsForTests } from "../src/bus.ts";
import { resetSectionPanelForTests, setSectionTheme } from "../src/section-panel.ts";
import { buildSectionContribution, installSectionRail, resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { installSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { RAIL_PARTS } from "../src/types.ts";
import type { SectionContext, SidebarSection } from "../src/types.ts";
import { resetSidebar } from "./fake-sidebar.ts";

// ---------------------------------------------------------------------------------------------
// The host's numbers, quoted from `lib/shell-sidebar-layout.ts`
// ---------------------------------------------------------------------------------------------

/** The rail column's basis (`:9`). */
const RAIL_WIDTH = 50;
/** One column of rail padding on each side of a panel row (`:10`). */
const RAIL_PADDING = 1;
/** The gap between the conversation and the rail (`:12`). */
const GAP = 3;
/** What the rail takes from the editor column (`:15`). */
const RAIL_COLUMNS = RAIL_WIDTH + GAP;
const TERMINAL_COLUMNS = 200;

/** The width the host hands a part on the tinted panel surface (`:355`). */
const GIVEN = RAIL_WIDTH - RAIL_PADDING * 2;

/** The main column the host allocates when the rail paints: no basis of ours is measured. */
const MAIN_WITH_RAIL = TERMINAL_COLUMNS - RAIL_COLUMNS;
/** The main column when the rail does not paint at all. */
const MAIN_WITHOUT_RAIL = TERMINAL_COLUMNS;

/**
 * One complete escape sequence's length at `index`, read as the host's `extractAnsiCode` reads it
 * (`pi-tui/dist/utils.js:265-320`): CSI up to its final byte, OSC/APC up to BEL or ST. Zero when
 * there is none, so the walk copies the character.
 */
function escapeLengthAt(line: string, index: number): number {
  if (line[index] !== "\u001b") return 0;
  const kind = line[index + 1];
  if (kind === "[") {
    let end = index + 2;
    while (end < line.length && !/[mGKHJ]/u.test(line[end] ?? "")) end += 1;
    return end < line.length ? end + 1 - index : 0;
  }
  if (kind === "]" || kind === "_") {
    let end = index + 2;
    while (end < line.length) {
      if (line[end] === "\u0007") return end + 1 - index;
      if (line[end] === "\u001b" && line[end + 1] === "\\") return end + 2 - index;
      end += 1;
    }
  }
  return 0;
}

/** A cluster of nothing but ignorables, controls, marks or surrogates: no columns (`:34`). */
const ZERO_WIDTH = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
/** What a cluster may carry before its base (`leadingNonPrintingRegex`, `:35`). */
const LEADING_NON_PRINTING =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
/** One character the host's trailing loop skips (`nonPrintingCharRegex`, `:36`). */
const NON_PRINTING_CHAR =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
/** One combining mark (`markCharRegex`, `:37`). */
const MARK_CHAR = /^\p{Mark}$/v;
/**
 * Marks terminals allocate cells for, with or without a base (`terminalSpacingMarkRegex`, `:38-40`):
 * spacing marks except a few zero-width exceptions, plus the scripts whose spacing marks legacy
 * wcwidth tables charge.
 */
const TERMINAL_SPACING_MARK =
  /^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
/** The emoji set the host tests AFTER its prefilter (`rgiEmojiRegex`, `:41`). */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/** The host's cheap emoji prefilter (`couldBeEmoji`, `:16-26`). */
function couldBeEmoji(segment: string): boolean {
  const codePoint = segment.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b50 && codePoint <= 0x2b55) ||
    segment.includes("\ufe0f") ||
    segment.length > 2
  );
}

/**
 * The East Asian Wide/Fullwidth blocks: a base code point in one of them is two columns
 * (`get-east-asian-width`'s `eastAsianWidth`, which `graphemeWidth` calls at `:151`). These are the
 * blocks a rail row can carry — CJK, Kana, Hangul, the fullwidth forms, enclosed ideographs and the
 * supplementary ideographic planes; a wide EMOJI is charged by the RGI rule above instead.
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18d08],
  [0x1b000, 0x1b2ff],
  [0x1d300, 0x1d376],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x3fffd],
];

function isWide(codePoint: number): boolean {
  return WIDE.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * pi-tui's `visibleWidth`: escapes dropped, a tab three columns, and each grapheme cluster charged
 * as the host charges it. Kept independent of `src/` on purpose.
 */
function hostWidth(line: string): number {
  let clean = "";
  let index = 0;
  while (index < line.length) {
    const length = escapeLengthAt(line, index);
    if (length > 0) {
      index += length;
      continue;
    }
    clean += line[index];
    index += 1;
  }
  // A TAB is three columns (`:229-231`); the host substitutes before segmenting.
  clean = clean.replace(/\t/gu, "   ");
  // Fast path, like the host's: printable ASCII is one column per byte.
  if (/^[\x20-\x7e]*$/u.test(clean)) return clean.length;
  let total = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)) {
    total += clusterWidth(segment);
  }
  return total;
}

/** One grapheme cluster's columns, in the host's own order (`graphemeWidth`, `:143-207`). */
function clusterWidth(segment: string): number {
  // The host's own fast path: a lone printable ASCII byte is one column, a lone TAB three.
  if (segment.length === 1) {
    const code = segment.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return 1;
    if (code === 0x09) return 3;
  }
  // Some marks occupy cells even without a base character.
  if (TERMINAL_SPACING_MARK.test(segment)) return [...segment].length;
  if (ZERO_WIDTH.test(segment)) return 0;
  if (couldBeEmoji(segment) && RGI_EMOJI.test(segment)) return 2;

  const base = segment.replace(LEADING_NON_PRINTING, "");
  const codePoint = base.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;

  let width = isWide(codePoint) ? 2 : 1;
  let followsMark = false;
  for (const char of [...base].slice(1)) {
    if (TERMINAL_SPACING_MARK.test(char)) {
      width += 1;
      followsMark = false;
    } else if (MARK_CHAR.test(char)) {
      followsMark = true;
    } else if (!NON_PRINTING_CHAR.test(char)) {
      const trailing = char.codePointAt(0) ?? 0;
      if (followsMark) width += isWide(trailing) ? 2 : 1;
      else if (trailing >= 0xff00 && trailing <= 0xffef) width += isWide(trailing) ? 2 : 1;
      else if (trailing === 0x0e33 || trailing === 0x0eb3) width += 1;
      followsMark = false;
    }
  }
  return width;
}

// ---------------------------------------------------------------------------------------------
// The oracle itself, pinned to numbers measured from the installed `visibleWidth`
// ---------------------------------------------------------------------------------------------

test("the host-width oracle agrees with the values pi-tui's own visibleWidth produces", () => {
  const measured: Array<[string, number]> = [
    ["a", 1],
    ["©", 1],
    ["©️", 2],
    ["1️⃣", 2],
    ["▶", 1],
    ["🎵", 2],
    ["ｶﾞ", 2],
    ["क्‍ष", 2],
    ["नमस्ते", 4],
    ["ि", 1],
    ["👨‍👩‍👧‍👦", 2],
    ["🇯🇵", 2],
    ["e\u0301", 1],
    ["\u0301", 0],
    ["a\tb", 5],
    ["中文", 4],
    ["한국어", 6],
    ["Ａ", 2],
    ["👨\u001b[31m‍👩‍👧‍👦AB", 4],
    ["\u001b]8;;http://example.com\u0007a\u001b]8;;\u0007", 1],
  ];
  for (const [row, columns] of measured) {
    assert.equal(hostWidth(row), columns, `${JSON.stringify(row)} measures ${columns} to the host`);
  }
});

/**
 * The width the layout gives the main column, given what a part returned: the host pads each row by
 * one column on both sides (`:414`) and keeps the rail only while every rail row fits the content
 * width (`:410`). Otherwise the rail is dropped and the conversation gets the full terminal.
 */
function mainColumnFor(partLines: readonly string[]): number {
  const railLines = partLines.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING));
  const active = railLines.length > 0 && railLines.every((line) => hostWidth(line) <= RAIL_WIDTH);
  return active ? MAIN_WITH_RAIL : MAIN_WITHOUT_RAIL;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-rail-width-"));
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
  resetSectionPanelForTests();
  resetSectionFailuresForTests();
  resetStoreStateForTests();
  setSectionTheme(undefined);
  installSectionRail();
  installSidebarBackend(() => ({ terminal: { columns: TERMINAL_COLUMNS, rows: 40 } }));
});

const ctx: SectionContext = { theme: undefined, configHome: "" };

/** The footer part with every native part painted: where a contribution with no placement lands. */
const FOOTER_RAIL = { part: "footer" as const, painted: RAIL_PARTS };

function contribute(section: SidebarSection, width = GIVEN): string[] {
  registerSection(section);
  return buildSectionContribution(width, ctx, FOOTER_RAIL)?.after?.lines ?? [];
}

/** The widest row, as the host reads it, with the row itself for the failure message. */
function widest(lines: readonly string[]): { width: number; text: string } {
  return lines.reduce(
    (worst, line) => (hostWidth(line) > worst.width ? { width: hostWidth(line), text: line } : worst),
    { width: 0, text: "" },
  );
}

// ---------------------------------------------------------------------------------------------
// N17/N19 — a contributed part never asks for more room than it was given
// ---------------------------------------------------------------------------------------------

test("a section's rows never exceed the width the host handed it, measured the host's way", () => {
  const rows: Array<[string, SidebarSection]> = [
    ["plain ASCII", {
      id: "width.ascii",
      title: "ASCII",
      lines: () => ["transform  registered", "second row"],
    }],
    // `clipRow` measures with `String#length`, so a row of wide characters is left untouched while
    // the host measures twice as many columns.
    ["a wide-character body row", {
      id: "width.wide",
      title: "WIDE",
      lines: () => ["日本語のテキストをここに書いて、幅を超えさせる行です。もっと長くします。"],
    }],
    // A tab is ONE column to this package and THREE to the host (`utils.js:153-155`), so a padded
    // row measures two columns wider than the width it was fitted to.
    ["a tab in a structured row", {
      id: "width.tab",
      title: "TAB",
      lines: () => [{ glyph: "○", label: "rendering\tmode", meta: "default", tone: "muted" }],
    }],
    ["an emoji cluster", {
      id: "width.emoji",
      title: "EMOJI",
      lines: () => [{ glyph: "🎵", label: "now playing 👨‍👩‍👧‍👦", meta: "▶", tone: "accent" }],
    }],
  ];

  // Every case is measured before the first failure, so one RED run names each violation and its
  // numbers instead of only the first.
  const violations: string[] = [];
  for (const [label, section] of rows) {
    resetSectionsForTests();
    const lines = contribute(section);
    assert.ok(lines.length > 0, `${label}: the section contributed no rows`);
    const worst = widest(lines);
    if (worst.width > GIVEN) {
      violations.push(
        `${label}: the host measures ${worst.width} columns for a row fitted to ${GIVEN} (over by ${worst.width - GIVEN}): ${JSON.stringify(worst.text)}`,
      );
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("a contributed section leaves the main column exactly where the host put it", () => {
  // The host's own footer part, as the host paints it: one column of padding on both sides (`:414`).
  const hostFooter = ["▾ STATUS 2", "  model  claude", "  cost   $0.12"];
  assert.equal(mainColumnFor(hostFooter), MAIN_WITH_RAIL);

  const sections: SidebarSection[] = [
    { id: "width.plain", title: "ASCII", lines: () => ["transform  registered"] },
    { id: "width.cjk", title: "WIDE", lines: () => ["日本語のテキストをここに書いて、幅を超えさせる行です。もっと長くします。"] },
    { id: "width.tabbed", title: "TAB", lines: () => [{ glyph: "○", label: "rendering\tmode", meta: "default" }] },
  ];

  for (const section of sections) {
    resetSectionsForTests();
    const lines = contribute(section);
    const rail = [...hostFooter, ...lines];
    assert.equal(
      mainColumnFor(rail),
      MAIN_WITH_RAIL,
      `section ${section.id}: the main column moved to ${mainColumnFor(rail)} (rail columns ${RAIL_COLUMNS}, terminal ${TERMINAL_COLUMNS}); ` +
        `the widest contributed row is ${widest(lines).width} columns for a ${GIVEN}-column budget`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// N20 — the report carries the last render's budget and what the bridge did with it
// ---------------------------------------------------------------------------------------------

test("/bridge-status reports the last render's given width and the widest row the bridge produced", () => {
  contribute({
    id: "width.report",
    title: "REPORT",
    // A row fitted to the budget, and one that has to give way to it.
    lines: () => [{ glyph: "○", label: "rendering", meta: "default" }],
  });
  const report = formatStatus(collectStatus());
  const line = report.find((entry) => entry.startsWith("section width:"));
  assert.equal(line, `section width: ${GIVEN} columns given, widest row ${GIVEN}`);
});

test("a session whose rail never rendered a section keeps its report unchanged", () => {
  registerSection({ id: "width.noframe", title: "NOFRAME", lines: () => ["never rendered"] });
  const report = formatStatus(collectStatus());
  assert.deepEqual(
    report.filter((entry) => entry.startsWith("section width:")),
    [],
  );
});

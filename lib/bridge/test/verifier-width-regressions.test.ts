/**
 * The verifier's width findings, pinned (W2-T2–W2-T4, A-T5, C-T2/C-T3 adjacent).
 *
 * Each expectation below is the value pi-tui's own `visibleWidth` produces for that string
 * (`@earendil-works/pi-tui/dist/utils.js:126-268`, measured with the installed host copy), so this
 * file is a differential fixture with pinned numbers instead of a second implementation:
 *
 * - a cluster is charged the way `graphemeWidth` charges it: zero for a cluster of marks, two only
 *   when `couldBeEmoji` AND `\p{RGI_Emoji}` both hold (so `©` is ONE column, `©️` is two), the base
 *   code point's East Asian width otherwise, plus every trailing halfwidth/fullwidth form and the
 *   Thai/Lao AM vowels;
 * - a row that already fits is byte-identical, escapes included, even at width zero;
 * - a cut never splits a grapheme cluster, even when an SGR sequence sits inside it.
 *
 * The README assertion at the end pins the exact footer string the host prints for a bridge row
 * (A5).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { registerTransform, resetTransformsForTests } from "../src/bus.ts";
import { clipToWidth, hostColumns } from "../src/card-style-transform.ts";
import { applyTransforms, resetTransformPipelineForTests } from "../src/transform-pipeline.ts";

test.beforeEach(() => {
  resetTransformsForTests();
  resetTransformPipelineForTests();
});

// ---------------------------------------------------------------------------------------------
// The host's measure, cluster by cluster
// ---------------------------------------------------------------------------------------------

test("a symbol that is not an RGI emoji is one column; a qualified or keycap emoji is two", () => {
  for (const symbol of ["©", "®", "™", "☺"]) {
    assert.equal(hostColumns(symbol), 1, `${symbol} is not an RGI emoji: the host charges one column`);
  }
  assert.equal(hostColumns("©️"), 2, "the emoji presentation selector makes it an RGI emoji");
  assert.equal(hostColumns("1️⃣"), 2, "a keycap sequence is one two-column cluster");
});

test("a trailing halfwidth/fullwidth form is charged its own column", () => {
  assert.equal(hostColumns("ｶﾞ"), 2, "halfwidth KA plus the voiced sound mark");
  assert.equal(hostColumns("ｶﾞｷﾞ"), 4, "two voiced halfwidth kana are four columns");
  assert.equal(hostColumns("ｱ"), 1, "a bare halfwidth kana is one column");
});

test("a cluster of marks charges nothing, and a leading mark rides its base", () => {
  assert.equal(hostColumns("्"), 0, "a lone Devanagari virama occupies no cell");
  assert.equal(hostColumns("़क"), 1, "the leading nukta is stripped before measuring क");
  assert.equal(hostColumns("क्"), 1);
  assert.equal(hostColumns("e\u0301"), 1, "a combining acute rides its base");
});

test("a Devanagari spacing mark occupies its own cell, as the host allocates one", () => {
  assert.equal(hostColumns("ि"), 1, "U+093F is a Spacing_Mark: the host charges it one column");
  assert.equal(hostColumns("ा"), 1, "U+093E is a Spacing_Mark too");
  assert.equal(hostColumns("नमस्ते"), 4, "the host's own number for नमस्ते (pi-tui 1.5.x)");
  assert.equal(hostColumns("हिन्दी"), 5, "the host's own number for हिन्दी");
});

// ---------------------------------------------------------------------------------------------
// W2-3: a consonant that follows a mark is charged, so it cannot overflow a narrower frame
// ---------------------------------------------------------------------------------------------

test("an Indic conjunct that follows a mark is two columns, and is never cut into one column", () => {
  // pi-tui 1.5.x charges the base (क) plus the visible consonant after the virama (ष): 2 columns.
  // Charging the cluster as its base alone made a "one column" frame hold two.
  assert.equal(hostColumns("क्‍ष"), 2, "the host charges the conjunct two columns");
  assert.equal(hostColumns("क्ष"), 2, "with or without the joiner");
  assert.equal(hostColumns("क्‍षा"), 3, "the trailing spacing mark adds its own cell");

  assert.equal(
    clipToWidth("क्‍षx", 1),
    "",
    "a two-column cluster cannot be emitted in a one-column frame",
  );
  assert.equal(clipToWidth("क्‍षx", 2), "क्‍ष", "at two columns the whole cluster fits");
  assert.equal(hostColumns(clipToWidth("क्‍षx", 2)), 2, "and the result measures exactly two");
  for (const width of [0, 1, 2, 3]) {
    assert.ok(
      hostColumns(clipToWidth("क्‍षx", width)) <= width,
      `the cut at ${width} never exceeds the frame`,
    );
  }
});

test("the pipeline clips an overflowing Indic conjunct instead of emitting it", () => {
  registerTransform({ id: "indic", transform: () => ["क्‍षx"] });

  assert.deepEqual(applyTransforms(["host"], 1), [""], "nothing wider than the frame reaches the host");
  assert.deepEqual(applyTransforms(["host"], 2), ["क्‍ष"]);
});

test("a Thai/Lao AM vowel adds a column, and an ignorable symbol adds none", () => {
  assert.equal(hostColumns("กำ"), 2, "the trailing AM vowel is charged one extra column");
  assert.equal(hostColumns("ເກຳ"), 3, "the same rule for Lao");
  assert.equal(hostColumns("\u00ad"), 0, "a soft hyphen is default-ignorable: no columns");
  assert.equal(hostColumns("👨‍👩‍👧‍👦"), 2, "a ZWJ family is one two-column cluster");
  assert.equal(hostColumns("👍🏽"), 2, "a skin-tone modifier rides its base");
});

// ---------------------------------------------------------------------------------------------
// Fitting rows are byte-identical, at every width — including zero
// ---------------------------------------------------------------------------------------------

test("a row that fits at width zero keeps its bytes, escapes included", () => {
  const sgr = "\u001b[31m";
  const link = "\u001b]8;;http://example.com\u0007\u001b]8;;\u0007";
  const background = "\u001b[48;5;236m\u001b[0m";

  assert.equal(clipToWidth(sgr, 0), sgr, "an SGR-only row has no columns and must survive");
  assert.equal(clipToWidth(link, 0), link, "an empty hyperlink is the same empty hyperlink");
  assert.equal(clipToWidth(background, 0), background);
  assert.equal(clipToWidth("\u001b[31m\u001b[39m", 0), "\u001b[31m\u001b[39m");
});

test("a row with no columns is passed through, and a row with columns is emptied, at width zero", () => {
  assert.equal(clipToWidth("", 0), "");
  assert.equal(clipToWidth("A", 0), "", "a visible column cannot be drawn in zero columns");
  assert.equal(clipToWidth("\u001b[31mA", 0), "", "the paint alone is not a row fit to draw");
});

test("the pipeline returns an ANSI-only row untouched at width zero", () => {
  registerTransform({ id: "ansi-only", transform: () => ["\u001b[31m", "A"] });

  assert.deepEqual(applyTransforms(["host"], 0), ["\u001b[31m", ""], "only the visible column is cut");
});

// ---------------------------------------------------------------------------------------------
// The cut never splits a cluster, even with SGR interleaved
// ---------------------------------------------------------------------------------------------

test("an SGR inside a grapheme cluster does not split it, and the kept paint is reset", () => {
  const row = "👨\u001b[31m‍👩‍👧‍👦AB";
  assert.equal(hostColumns(row), 4, "the host measures the family as one cluster plus A and B");

  const clipped = clipToWidth(row, 2);

  assert.equal(clipped, "👨\u001b[31m‍👩‍👧‍👦\u001b[0m", "the whole family is kept, then the paint is reset");
  assert.equal(clipped.split("\u200d").length - 1, 3, "every joiner of the family survived the cut");
  assert.equal(hostColumns(clipped), 2, "and it measures the host's width exactly");
});

test("the pipeline applies that cut to what a transform returns", () => {
  registerTransform({ id: "family", transform: () => ["👨\u001b[31m‍👩‍👧‍👦AB"] });

  assert.deepEqual(applyTransforms(["host"], 2), ["👨\u001b[31m‍👩‍👧‍👦\u001b[0m"]);
});

// ---------------------------------------------------------------------------------------------
// A5 — the README states the host's exact footer
// ---------------------------------------------------------------------------------------------

test("the README states the host's exact footer for a focused bridge row (A5)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.ok(
    readme.includes("←/→ choose · Enter apply"),
    "the README must name the footer verbatim, as the host prints it",
  );
});

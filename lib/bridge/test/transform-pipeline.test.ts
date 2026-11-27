/**
 * The transform pipeline (S2, S3, S4, S5): one ordered pass over the rows the conversation
 * component produced, run AFTER the card-style repaint, inside the wrapper that already exists.
 *
 * What these tests hold the pipeline to:
 *
 * - it is a pass-through by IDENTITY when there is nothing to do (no transform registered, or every
 *   transform returning its input), so a session that never used the feature is byte-identical;
 * - each transform receives the previous transform's output;
 * - a throwing (or lying) transform loses only its own contribution, is reported with its id and
 *   message, and the remaining transforms still run;
 * - nothing a transform returns reaches the screen wider than the host's own frame;
 * - `/bridge-status` lists the pipeline in order with the LAST frame's outcome per transform, and
 *   says nothing at all in a session that registered none.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerCardStyle,
  registerTransform,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
} from "../src/bus.ts";
import { resetCardStyleTransformForTests, hostColumns } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  installCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  applyTransforms,
  getTransformFrameOutcomes,
  resetTransformPipelineForTests,
} from "../src/transform-pipeline.ts";
import type { CardStyleRegistration, TranscriptTransform } from "../src/types.ts";
import { READ_CARD, createFakeTranscriptTui } from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-pipeline-"));
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
  resetCardStylesForTests();
  resetTransformsForTests();
  resetTransformPipelineForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
  setCardStyleSelection("native");
});

const statusLines = (): string[] => formatStatus(collectStatus());

/** The transforms block of the report: from its first line up to the next block that can follow. */
const transformBlock = (lines: readonly string[]): string[] => {
  const start = lines.findIndex((line) => line.startsWith("transforms: "));
  if (start === -1) return [];
  const rest = lines.slice(start);
  const end = rest.findIndex((line) => line.startsWith("notices"));
  return end === -1 ? rest : rest.slice(0, end);
};

const style = (id: string, label: string): CardStyleRegistration => ({
  id,
  label,
  frame: {
    top: (ctx) => `+${ctx.title ?? ""}`,
    line: (ctx) => `> ${ctx.text}`,
    bottom: () => "-",
  },
});

// ---------------------------------------------------------------------------------------------
// S2 — one pipeline, in order, pass-through by identity
// ---------------------------------------------------------------------------------------------

test("with no transform registered the very same array comes back, and nothing is recorded", () => {
  const lines = ["one", "two"];

  const output = applyTransforms(lines, 40);

  assert.equal(output, lines, "the identical array instance (S2)");
  assert.deepEqual(getTransformFrameOutcomes(), [], "no frame fact to report either");
});

test("transforms run in order and each one receives the previous output", () => {
  const seen: string[][] = [];
  registerTransform({
    id: "second",
    order: 20,
    transform: (lines) => {
      seen.push([...lines]);
      return lines.map((line) => `${line}|2`);
    },
  });
  registerTransform({
    id: "first",
    order: 10,
    transform: (lines) => {
      seen.push([...lines]);
      return lines.map((line) => `${line}|1`);
    },
  });

  assert.deepEqual(applyTransforms(["a"], 40), ["a|1|2"]);
  assert.deepEqual(seen, [["a"], ["a|1"]], "the second transform saw the first one's rows");
  assert.deepEqual(getTransformFrameOutcomes(), [
    { id: "first", status: "applied", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
    { id: "second", status: "applied", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
  ]);
});

test("a transform that leaves the frame alone is skipped and the array survives by identity", () => {
  const lines = ["one"];
  registerTransform({ id: "noop", transform: (lines) => lines });
  registerTransform({ id: "copy", transform: (lines) => [...lines] });

  const output = applyTransforms(lines, 40);

  assert.equal(output, lines, "an unchanged frame is the same frame");
  assert.deepEqual(getTransformFrameOutcomes(), [
    { id: "noop", status: "skipped", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
    { id: "copy", status: "skipped", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
  ]);
});

test("the frame outcomes are the LAST frame's, not a history", () => {
  let paint = true;
  registerTransform({
    id: "flip",
    transform: (lines) => (paint ? lines.map((line) => `${line}!`) : lines),
  });

  assert.deepEqual(applyTransforms(["a"], 40), ["a!"]);
  assert.deepEqual(getTransformFrameOutcomes(), [
    { id: "flip", status: "applied", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
  ]);

  paint = false;
  assert.deepEqual(applyTransforms(["a"], 40), ["a"]);
  assert.deepEqual(getTransformFrameOutcomes(), [
    { id: "flip", status: "skipped", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
  ]);
});

// ---------------------------------------------------------------------------------------------
// S3 — isolation
// ---------------------------------------------------------------------------------------------

test("a throwing transform is skipped for the frame, reported, and the rest still run", () => {
  registerTransform({
    id: "boom",
    order: 10,
    transform: () => {
      throw new Error("boom exploded");
    },
  });
  registerTransform({
    id: "after",
    order: 20,
    transform: (lines) => lines.map((line) => `${line}!`),
  });

  const output = applyTransforms(["a"], 40);

  assert.deepEqual(output, ["a!"], "the frame kept its lines and the later transform ran");
  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "boom",
      status: "failed",
      message: "boom exploded",
      counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] },
    },
    { id: "after", status: "applied", counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] } },
  ]);
});

test("a transform that does not return lines loses its contribution instead of the frame", () => {
  registerTransform({
    id: "junk",
    transform: () => "not lines" as unknown as string[],
  });
  registerTransform({
    id: "mixed",
    transform: () => ["ok", 42] as unknown as string[],
  });

  const output = applyTransforms(["a"], 40);

  assert.deepEqual(output, ["a"], "the previous lines are what the frame keeps");
  const outcomes = getTransformFrameOutcomes();
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "failed");
    assert.match(outcome.message ?? "", /must return an array of lines/u);
  }
});

test("a registration mutated after it was accepted is reported, never thrown into the frame", () => {
  const registration: TranscriptTransform = { id: "mutated", transform: (lines) => lines };
  registerTransform(registration);
  (registration as unknown as { transform: unknown }).transform = undefined;

  assert.doesNotThrow(() => applyTransforms(["a"], 40));
  assert.deepEqual(applyTransforms(["a"], 40), ["a"]);
  assert.equal(getTransformFrameOutcomes()[0]?.status, "failed");
});

// ---------------------------------------------------------------------------------------------
// S4 — width discipline
// ---------------------------------------------------------------------------------------------

test("what a transform returns is clipped to the host's width, SGR closed", () => {
  registerTransform({ id: "wide", transform: () => ["0123456789ABC"] });
  assert.deepEqual(applyTransforms(["x"], 10), ["0123456789"]);

  resetTransformsForTests();
  registerTransform({
    id: "wide-styled",
    transform: () => ["\u001b[31m0123456789ABCDEF\u001b[39m"],
  });
  assert.deepEqual(applyTransforms(["x"], 4), ["\u001b[31m0123\u001b[0m"]);
});

test("a row that already fits is never touched by the clip", () => {
  registerTransform({ id: "exact", transform: () => ["0123456789"] });

  assert.deepEqual(applyTransforms(["x"], 10), ["0123456789"]);
});

// ---------------------------------------------------------------------------------------------
// S4 — the host's OWN rows survive a transform (W2-1..W2-4, L3)
// ---------------------------------------------------------------------------------------------

/** An OSC-8 hyperlink, the shape Pi's TUI emits for file paths. */
const hyperlink = (url: string, text: string): string => `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
const HOST_BG = "\u001b[48;5;236m";
const HOST_RESET = "\u001b[0m";

/** Rows the host really produces: a link inside a background, ZWJ and modifier emoji, plain text. */
const hostFrame = (): string[] => [
  `${HOST_BG}${hyperlink("file:///tmp/config.ts", "config.ts")}${" ".repeat(30)}${HOST_RESET}`,
  `${HOST_BG}read this file: 👨‍👩‍👧‍👦 now${" ".repeat(18)}${HOST_RESET}`,
  "thumbs 👍🏽 ok",
  "plain ascii message",
];

test("the host's measure ignores an OSC-8 hyperlink's URL (W2-4)", () => {
  assert.equal(hostColumns(hyperlink("file:///tmp/a.ts", "a.ts")), 4);
  assert.equal(hostColumns(`${HOST_BG}blue${HOST_RESET}`), 4);
  assert.equal(hostColumns("a\tb"), 5, "a TAB is three columns, exactly as the host charges it");
});

test("a no-op transform leaves the host's own array and its bytes untouched (W2-1, W2-2)", () => {
  const lines = hostFrame();
  for (const line of lines) assert.ok(hostColumns(line) <= 40, "the fixture fits the width");
  registerTransform({ id: "noop", transform: (lines) => lines });

  const output = applyTransforms(lines, 40);

  assert.equal(output, lines, "the host's own array, just as with no transform registered");
  assert.deepEqual(output, lines, "and every row byte for byte");
});

test("a transform that returns an identical copy changes no byte of the host frame (W2-2)", () => {
  const lines = hostFrame();
  registerTransform({ id: "copy", transform: (lines) => [...lines] });

  const output = applyTransforms(lines, 40);

  assert.equal(output, lines, "an unchanged frame is the same frame");
  assert.deepEqual(output, lines);
});

test("a widened row is cut at the host's width, never inside a cluster or an escape (W2-3)", () => {
  const family = "👨‍👩‍👧‍👦";
  registerTransform({
    id: "wide",
    transform: () => [`\u001b[44m${hyperlink("https://example.com", `${family} family 👍🏽 end`)}\u001b[49m`],
  });

  const [line] = applyTransforms(["x"], 10);

  assert.equal(
    line,
    `\u001b[44m\u001b]8;;https://example.com\u0007${family} family \u001b]8;;\u0007\u001b[0m`,
    "an open link is closed and the paint reset, the cluster kept whole",
  );
  assert.equal(hostColumns(line ?? ""), 10, "exactly the host's width, no more");
  assert.equal((line ?? "").split("\u200d").length - 1, 3, "every joiner of the family cluster kept");
});

test("a cut row with a TAB is measured with the host's three columns (W2-3)", () => {
  registerTransform({ id: "tab", transform: () => ["aaaaaaaaa\tZZ"] });

  const [line] = applyTransforms(["x"], 10);

  assert.equal(line, "aaaaaaaaa", "the tab does not fit in the last column");
  assert.ok(hostColumns(line ?? "") <= 10);
});

// ---------------------------------------------------------------------------------------------
// S2 — the conversation wrapper runs the repaint first, then the pipeline
// ---------------------------------------------------------------------------------------------

test("the card-style repaint runs before the transforms, and the transform sees its rows", () => {
  const seen: string[][] = [];
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  registerCardStyle(style("loon.cute", "cute"));
  setCardStyleSelection("loon.cute");
  registerTransform({
    id: "spy",
    transform: (lines) => {
      seen.push([...lines]);
      return lines;
    },
  });

  assert.deepEqual(tui.chat.render(40), ["+read", "> config.ts", "-"]);
  assert.deepEqual(seen, [["+read", "> config.ts", "-"]], "the repaint happened first");
});

test("a transform restyles rows the host already drew, through the wrapper", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  registerTransform({
    id: "gutter",
    transform: (lines) => lines.map((line) => `|${line}`),
  });

  const output = tui.chat.render(40);

  assert.equal(output.length, READ_CARD.length);
  assert.ok(output.every((line) => line.startsWith("|")), "every host row went through it");
});

test("with no style and no transform the wrapper returns the host's own array by identity", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  // The host returns ONE cached array, as Pi's conversation component does between frames.
  let cached: string[] | undefined;
  const hostRender = tui.chat.render.bind(tui.chat);
  tui.chat.render = (width: number): string[] => (cached ??= hostRender(width));
  installCardStyleTransform(tui);

  const first = tui.chat.render(40);

  assert.equal(first, cached, "the identical array the host produced");
  assert.equal(tui.chat.render(40), first, "and it stays that same instance");
});

// ---------------------------------------------------------------------------------------------
// S5 — `/bridge-status`
// ---------------------------------------------------------------------------------------------

test("a session with no transform keeps the historical report byte for byte", () => {
  assert.deepEqual(statusLines(), [
    "gentle-shell-bridge status",
    "providers: none",
    "backend: none",
    "last capture: none",
    "last failures: none",
    "store problems: none",
    "duplicate settings: no build yet",
  ]);
  assert.equal(collectStatus().transforms, undefined);
});

test("the report lists the transforms in pipeline order with the last frame's outcome", () => {
  registerTransform({
    id: "later",
    order: 20,
    transform: (lines) => lines.map((line) => `${line}+`),
  });
  registerTransform({
    id: "explodes",
    order: 10,
    transform: () => {
      throw new Error("explodes now");
    },
  });
  registerTransform({ id: "unordered", transform: (lines) => lines });

  applyTransforms(["x"], 40);

  assert.deepEqual(transformBlock(statusLines()), [
    "transforms: 3 registered",
    "  - explodes (order 10): failed (explodes now), 1 line, 0 candidates, 0 recognised, 0 rewritten",
    "  - later (order 20): applied, 1 line, 0 candidates, 0 recognised, 0 rewritten",
    "  - unordered (registration order): skipped, 1 line, 0 candidates, 0 recognised, 0 rewritten",
  ]);
});

test("a transform registered after the last frame is reported as not run", () => {
  registerTransform({ id: "ran", transform: (lines) => lines });
  applyTransforms(["x"], 40);
  registerTransform({ id: "later", transform: (lines) => lines });

  assert.deepEqual(transformBlock(statusLines()), [
    "transforms: 2 registered",
    "  - ran (registration order): skipped, 1 line, 0 candidates, 0 recognised, 0 rewritten",
    "  - later (registration order): not run",
  ]);
});

test("the transforms block sits after every existing block, none of which move", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  registerCardStyle(style("loon.cute", "cute"));
  setCardStyleSelection("loon.cute");
  tui.chat.render(40);
  registerTransform({ id: "one", transform: (lines) => lines });
  tui.chat.render(40);

  const lines = statusLines();
  const cardNote = lines.findIndex((line) => line.startsWith("card style note: "));
  const transforms = lines.findIndex((line) => line.startsWith("transforms: "));

  assert.ok(cardNote > 0, "the card-style block is still there");
  assert.ok(transforms > cardNote, "and the transforms block follows it");
  assert.deepEqual(
    lines.slice(0, transforms).filter((line) => line.startsWith("card style frame: ")),
    ["card style frame: transformed 1 card"],
    "the existing card-style lines are unchanged",
  );
});

/**
 * The line transformer (S3, S6, S12): detection, extraction, repaint, and every pass-through.
 *
 * Everything here runs against `test/fake-transcript.ts`, whose rows are real `float` output, so the
 * detector is proven on the grammar it was written from rather than on a simplified copy of it.
 *
 * The bounded bets in this suite, stated so a reviewer can see them:
 * - a pass-through returns the SAME array instance (S3: "the same array reference, untouched");
 * - a card is a run of float rows: padding, header, optional separator, body, padding — the
 *   empty-body card being exactly three rows;
 * - `neon` rows start with `╭`, `│` or `╰` and are therefore never float cards;
 * - a style that throws leaves the WHOLE frame alone and is recorded (S6).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCardStyle, resetBusForTests, resetCardStylesForTests } from "../src/bus.ts";
import {
  getCardStyleTransformFailures,
  resetCardStyleTransformForTests,
  transformCardLines,
} from "../src/card-style-transform.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type {
  CardFrameBottomContext,
  CardFrameLineContext,
  CardFrameTopContext,
  CardStyleRegistration,
} from "../src/types.ts";
import {
  BASH_CARD,
  BLANK_LINE,
  CONVERSATION,
  NEON_CARD,
  PROSE_LINE,
  READ_CARD,
  SUBTITLE_CARD,
  TRUNCATED_CARD,
  stripAnsi,
} from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-transform-"));
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
  resetCardStylesForTests();
  resetCardStyleTransformForTests();
  resetStoreStateForTests();
  setCardStyleSelection("native");
});

/** What one style was asked to draw, in call order. */
interface Recorded {
  top: CardFrameTopContext[];
  line: CardFrameLineContext[];
  bottom: CardFrameBottomContext[];
}

/** A style with a frame a test can read at a glance, and a log of every call it received. */
function recordingStyle(id = "loon.cute", label = "cute"): {
  style: CardStyleRegistration;
  calls: Recorded;
} {
  const calls: Recorded = { top: [], line: [], bottom: [] };
  return {
    calls,
    style: {
      id,
      label,
      frame: {
        top: (ctx) => {
          calls.top.push(ctx);
          return `+${ctx.title ?? ""}${ctx.hint === undefined ? "" : `|${ctx.hint}`}`;
        },
        line: (ctx) => {
          calls.line.push(ctx);
          return `> ${ctx.text}`;
        },
        bottom: (ctx) => {
          calls.bottom.push(ctx);
          return "-";
        },
      },
    },
  };
}

/** Visible width of a row, ANSI ignored: the rows this suite produces are narrow single-width. */
function widthOf(line: string): number {
  return [...stripAnsi(line)].length;
}

// ---------------------------------------------------------------------------------------------
// Pass-through: the same array instance, untouched
// ---------------------------------------------------------------------------------------------

test("native selection is a pass-through: the same array reference (S3)", () => {
  const lines = [...CONVERSATION];

  const output = transformCardLines(lines, 40);

  assert.equal(output, lines, "identity, not a copy");
  assert.deepEqual(output, [...CONVERSATION]);
});

test("a selection that names no registered style is a pass-through too (S12)", () => {
  registerCardStyle(recordingStyle().style);
  setCardStyleSelection("loon.gone");
  const lines = [...CONVERSATION];

  assert.equal(transformCardLines(lines, 40), lines, "missing degrades to native, not to a guess");
});

test("a frame with no card is returned untouched even with a style selected", () => {
  registerCardStyle(recordingStyle().style);
  setCardStyleSelection("loon.cute");
  const lines = [PROSE_LINE, BLANK_LINE, PROSE_LINE];

  assert.equal(transformCardLines(lines, 40), lines);
});

// ---------------------------------------------------------------------------------------------
// Repaint
// ---------------------------------------------------------------------------------------------

test("a float card is reframed by the selected style (S3)", () => {
  const { style, calls } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  const output = transformCardLines([...READ_CARD], 40);

  assert.deepEqual(output, ["+read|ctrl+o", "> config.ts", "-"]);
  assert.deepEqual(calls.top, [{ width: 40, title: "read", hint: "ctrl+o" }], "one extraction");
  assert.deepEqual(calls.line, [{ text: "config.ts", width: 40, first: true }]);
  assert.deepEqual(calls.bottom, [{ width: 40 }]);
});

test("the content width the host rendered at is the width the style is told", () => {
  const { style, calls } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  transformCardLines([...READ_CARD], 39);

  assert.equal(calls.top[0]?.width, 39);
  assert.equal(calls.line[0]?.width, 39);
  assert.equal(calls.bottom[0]?.width, 39);
});

test("an empty-body card is padding, header, closer: no line calls (S3)", () => {
  const { style, calls } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  const output = transformCardLines([...BASH_CARD], 40);

  assert.deepEqual(output, ["+bash", "-"]);
  assert.deepEqual(calls.line, [], "there was no body to draw");
  assert.deepEqual(calls.top, [{ width: 40, title: "bash", hint: undefined }]);
});

test("a neon card is not a float card: it is left byte-identical", () => {
  const { style, calls } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);
  const lines = [...NEON_CARD];

  const output = transformCardLines(lines, 40);

  assert.equal(output, lines, "nothing changed, so nothing was copied");
  assert.deepEqual(calls.top, [], "and no style was consulted about a card it did not draw");
});

test("non-card rows between and around cards are returned byte-identical (S3.4)", () => {
  const { style } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  const output = transformCardLines([...CONVERSATION], 40);

  assert.deepEqual(output.slice(0, 2), [PROSE_LINE, BLANK_LINE], "the prefix is byte-identical");
  assert.equal(
    output.filter((line) => line === BLANK_LINE).length,
    CONVERSATION.filter((line) => line === BLANK_LINE).length,
    "the blank rows between cards survive, and no new one appears",
  );
  // Three cards in the conversation fixture, each drawn as top + body + bottom.
  assert.deepEqual(
    output.filter((line) => line === "-").length,
    3,
    "every float card in the frame was reframed",
  );
  assert.equal(output.at(-1), "-", "the frame ends with the last card's closer, as the host drew it");
  assert.equal(output.includes(PROSE_LINE), true);
});

test("a subtitle is not mistaken for a hint: the whole heading becomes the title", () => {
  const { style, calls } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  transformCardLines([...SUBTITLE_CARD], 40);

  assert.deepEqual(
    calls.top,
    [{ width: 40, title: "read · config.ts", hint: undefined }],
    "the muted run is a subtitle, not a right-aligned hint; no split is guessed",
  );
});

test("a truncated body row keeps its visible text and loses nothing", () => {
  const { style, calls } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  transformCardLines([...TRUNCATED_CARD], 40);

  assert.equal(calls.line.length, 1);
  assert.equal(calls.line[0]?.text, "npm run typecheck exits zero and …", "the host's ellipsis stays");
});

test("only the selected style draws; another registered style is never called (S12)", () => {
  const first = recordingStyle("loon.cute", "cute");
  const second = recordingStyle("pix.mono", "mono");
  registerCardStyle(first.style);
  registerCardStyle(second.style);
  setCardStyleSelection("pix.mono");

  const output = transformCardLines([...READ_CARD], 40);

  assert.deepEqual(output, ["+read|ctrl+o", "> config.ts", "-"]);
  assert.deepEqual(first.calls, { top: [], line: [], bottom: [] }, "the unselected style stayed idle");
  assert.equal(second.calls.top.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Width discipline
// ---------------------------------------------------------------------------------------------

test("a line wider than the host's width is clipped, never emitted as is (S3)", () => {
  const { style } = recordingStyle();
  registerCardStyle({
    ...style,
    frame: {
      top: () => "+".repeat(120),
      line: (ctx) => `> ${ctx.text} ${"x".repeat(200)}`,
      bottom: () => "-".repeat(300),
    },
  });
  setCardStyleSelection(style.id);

  const output = transformCardLines([...READ_CARD], 40);

  const clippedBody = `> config.ts ${"x".repeat(200)}`.slice(0, 40);
  assert.deepEqual(output, ["+".repeat(40), clippedBody, "-".repeat(40)]);
  for (const line of output) assert.ok(widthOf(line) <= 40, `${widthOf(line)} <= 40`);
});

test("a style that fits is never padded or rewritten", () => {
  const { style } = recordingStyle();
  registerCardStyle(style);
  setCardStyleSelection(style.id);

  const output = transformCardLines([...READ_CARD], 40);

  assert.deepEqual(output, ["+read|ctrl+o", "> config.ts", "-"], "clipping only ever removes");
});

// ---------------------------------------------------------------------------------------------
// Failure is a pass-through (S6)
// ---------------------------------------------------------------------------------------------

test("a throwing top leaves the whole frame identical and is recorded", () => {
  registerCardStyle({
    id: "loon.broken",
    label: "broken",
    frame: {
      top: () => {
        throw new Error("top exploded");
      },
      line: (ctx) => ctx.text,
      bottom: () => "-",
    },
  });
  setCardStyleSelection("loon.broken");
  const lines = [...CONVERSATION];

  const output = transformCardLines(lines, 40);

  assert.equal(output, lines, "the original array, not a partially repainted one");
  assert.deepEqual(output, [...CONVERSATION]);
  assert.deepEqual(getCardStyleTransformFailures(), [
    { styleId: "loon.broken", message: "top exploded" },
  ]);
});

test("a throwing line is recorded and passes the frame through", () => {
  registerCardStyle({
    id: "loon.broken",
    label: "broken",
    frame: {
      top: () => "+",
      line: () => {
        throw new Error("line exploded");
      },
      bottom: () => "-",
    },
  });
  setCardStyleSelection("loon.broken");
  const lines = [...READ_CARD];

  assert.equal(transformCardLines(lines, 40), lines);
  assert.deepEqual(getCardStyleTransformFailures(), [
    { styleId: "loon.broken", message: "line exploded" },
  ]);
});

test("a style that threw does not poison the next style (S6, S12)", () => {
  registerCardStyle({
    id: "loon.broken",
    label: "broken",
    frame: {
      top: () => {
        throw new Error("boom");
      },
      line: (ctx) => ctx.text,
      bottom: () => "-",
    },
  });
  const good = recordingStyle("loon.cute", "cute");
  registerCardStyle(good.style);
  setCardStyleSelection("loon.broken");
  transformCardLines([...READ_CARD], 40);

  setCardStyleSelection("loon.cute");

  assert.deepEqual(transformCardLines([...READ_CARD], 40), ["+read|ctrl+o", "> config.ts", "-"]);
  assert.equal(good.calls.top.length, 1, "the healthy style drew, in the same process");
});

test("a failure is remembered across frames until the seam clears it", () => {
  registerCardStyle({
    id: "loon.broken",
    label: "broken",
    frame: {
      top: () => {
        throw new Error("boom");
      },
      line: (ctx) => ctx.text,
      bottom: () => "-",
    },
  });
  setCardStyleSelection("loon.broken");
  transformCardLines([...READ_CARD], 40);

  resetCardStyleTransformForTests();

  assert.deepEqual(getCardStyleTransformFailures(), []);
});

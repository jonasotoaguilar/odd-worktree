/**
 * Frame telemetry (F1–F4): every frame records, per transform, whether it ran, how many lines it
 * received, how many candidate cards it examined, how many it recognised and how many it rewrote —
 * as COUNTS, and never any of the frame's own content.
 *
 * This is the instrument the bash-card defect (a real TUI where switching the example's toggle
 * changed nothing visible) needs before any fix is invented: it answers "did the pipeline reach the
 * conversation, and did the example's grammar recognise a real bash card there?" from the same
 * report the author already reads.
 *
 * What these tests hold the record to:
 *
 * - counts for a frame with zero candidates, with candidates and no match, and with matches;
 * - the counters are the frame's own: they reset per frame and never accumulate;
 * - a transform that throws reports `failed` with the counts it reached;
 * - a transform that reports nonsense, or nothing at all, loses only its counts — never the frame;
 * - a session with no transform records nothing at all;
 * - no line of the frame is stored, not even smuggled in as a "shape name".
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerTransform, resetTransformsForTests } from "../../lib/shell-api/bus.ts";
import { resetCardStyleTransformForTests } from "../../lib/shell-api/card-style-transform.ts";
import { disableCardStyleTransform, resetCardStyleWiringForTests } from "../../lib/shell-api/card-style-wiring.ts";
import { setCardStyleSelection } from "../../lib/shell-api/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../../lib/shell-api/capture.ts";
import { resetHookStateForTests } from "../../lib/shell-api/hook.ts";
import { resetNoticesForTests } from "../../lib/shell-api/notices.ts";
import { resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../../lib/shell-api/sidebar.ts";
import { resetSectionFailuresForTests } from "../../lib/shell-api/sidebar-render.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import {
  applyTransforms,
  getTransformFrameOutcomes,
  resetTransformPipelineForTests,
} from "../../lib/shell-api/transform-pipeline.ts";
import type { TransformContext } from "../../lib/shell-api/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-telemetry-"));
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

/**
 * The counts a transform records for itself. `report` is how a transform tells the shell API what its
 * own grammar saw; the shell API adds the line count and the outcome, so the two can never disagree
 * about what the frame did.
 */
const counts = (
  candidates: number,
  recognised: number,
  rewritten: number,
  shapes?: Record<string, number>,
): { candidates: number; recognised: number; rewritten: number; shapes?: Record<string, number> } => ({
  candidates,
  recognised,
  rewritten,
  ...(shapes === undefined ? {} : { shapes }),
});

// ---------------------------------------------------------------------------------------------
// F1 — the counts a frame records
// ---------------------------------------------------------------------------------------------

test("a frame with zero candidates records the lines it received and zeroed counts", () => {
  registerTransform({
    id: "probe",
    transform: (lines, ctx: TransformContext) => {
      ctx.report?.(counts(0, 0, 0));
      return lines;
    },
  });

  applyTransforms(["one", "two", "three"], 40);

  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "probe",
      status: "skipped",
      counts: { lines: 3, candidates: 0, recognised: 0, rewritten: 0, shapes: [] },
    },
  ]);
});

test("a frame with candidates and no match records the candidates and no recognition", () => {
  registerTransform({
    id: "probe",
    transform: (lines, ctx: TransformContext) => {
      ctx.report?.(counts(2, 0, 0, {}));
      return lines;
    },
  });

  applyTransforms(["a", "b"], 40);

  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "probe",
      status: "skipped",
      counts: { lines: 2, candidates: 2, recognised: 0, rewritten: 0, shapes: [] },
    },
  ]);
});

test("a frame with matches records recognition, rewrites and the shape that matched", () => {
  registerTransform({
    id: "probe",
    transform: (lines, ctx: TransformContext) => {
      ctx.report?.(counts(3, 1, 1, { float: 1 }));
      return lines.map((line) => `>${line}`);
    },
  });

  assert.deepEqual(applyTransforms(["a"], 40), [">a"]);
  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "probe",
      status: "applied",
      counts: {
        lines: 1,
        candidates: 3,
        recognised: 1,
        rewritten: 1,
        shapes: [{ name: "float", count: 1 }],
      },
    },
  ]);
});

test("the counts belong to the frame that produced them: they reset, never accumulate", () => {
  let frame = 0;
  registerTransform({
    id: "probe",
    transform: (lines, ctx: TransformContext) => {
      frame += 1;
      ctx.report?.(frame === 1 ? counts(2, 1, 1, { float: 1 }) : counts(1, 0, 0, {}));
      return lines;
    },
  });

  applyTransforms(["a", "b", "c"], 40);
  const first = getTransformFrameOutcomes()[0]?.counts;
  applyTransforms(["x"], 40);
  const second = getTransformFrameOutcomes()[0]?.counts;

  assert.deepEqual(first, {
    lines: 3,
    candidates: 2,
    recognised: 1,
    rewritten: 1,
    shapes: [{ name: "float", count: 1 }],
  });
  assert.deepEqual(
    second,
    { lines: 1, candidates: 1, recognised: 0, rewritten: 0, shapes: [] },
    "the second frame's record replaces the first one instead of adding to it",
  );
});

test("a transform that never reports still records the lines and zeroed counts", () => {
  registerTransform({ id: "silent", transform: (lines) => lines });

  applyTransforms(["a", "b"], 40);

  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "silent",
      status: "skipped",
      counts: { lines: 2, candidates: 0, recognised: 0, rewritten: 0, shapes: [] },
    },
  ]);
});

// ---------------------------------------------------------------------------------------------
// F1/F4 — a failed transform keeps the counts it reached
// ---------------------------------------------------------------------------------------------

test("a transform that throws is failed with the counts it reached and the lines it received", () => {
  registerTransform({
    id: "boom",
    transform: (lines, ctx: TransformContext) => {
      ctx.report?.(counts(4, 2, 0, { float: 2 }));
      throw new Error("boom after two cards");
    },
  });

  assert.deepEqual(applyTransforms(["a", "b", "c", "d", "e"], 40), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "boom",
      status: "failed",
      message: "boom after two cards",
      counts: {
        lines: 5,
        candidates: 4,
        recognised: 2,
        rewritten: 0,
        shapes: [{ name: "float", count: 2 }],
      },
    },
  ]);
});

// ---------------------------------------------------------------------------------------------
// F1/F4 — junk in, nothing out: the record is counts only, and recording never throws
// ---------------------------------------------------------------------------------------------

test("nonsense counts are clamped to zero and never thrown into the frame", () => {
  registerTransform({
    id: "liar",
    transform: (lines, ctx: TransformContext) => {
      assert.doesNotThrow(() => {
        ctx.report?.({
          candidates: -3,
          recognised: Number.NaN,
          rewritten: Number.POSITIVE_INFINITY,
        } as unknown as Parameters<NonNullable<TransformContext["report"]>>[0]);
        ctx.report?.("not counts" as unknown as Parameters<NonNullable<TransformContext["report"]>>[0]);
      });
      return lines.map((line) => `${line}!`);
    },
  });

  assert.deepEqual(applyTransforms(["a"], 40), ["a!"]);
  assert.deepEqual(getTransformFrameOutcomes(), [
    {
      id: "liar",
      status: "applied",
      counts: { lines: 1, candidates: 0, recognised: 0, rewritten: 0, shapes: [] },
    },
  ]);
});

test("a shape name is a name: anything with a space, an escape or a long tail is dropped", () => {
  registerTransform({
    id: "probe",
    transform: (lines, ctx: TransformContext) => {
      ctx.report?.(
        counts(4, 2, 0, {
          "ls -1 /home": 1,
          "\u001b[31mred\u001b[39m": 1,
          THIS_IS_A_NAME_THAT_IS_WAY_TOO_LONG_TO_BE_ONE: 1,
          "Bash Card": 1,
          float: 2,
        }),
      );
      return lines;
    },
  });

  applyTransforms(["a"], 40);

  assert.deepEqual(getTransformFrameOutcomes()[0]?.counts.shapes, [{ name: "float", count: 2 }]);
});

test("no line of the frame is recorded, displayed or smuggled in as a shape name", () => {
  const secret = "SECRET-OUTPUT-THAT-MUST-NOT-BE-STORED";
  registerTransform({
    id: "probe",
    transform: (lines, ctx: TransformContext) => {
      ctx.report?.(
        counts(1, 1, 1, { [secret]: 1, [secret.toLowerCase()]: 1, float: 1 }),
      );
      return lines;
    },
  });

  applyTransforms([secret, `a line with ${secret} in it`], 40);

  const stored = JSON.stringify(getTransformFrameOutcomes());
  assert.equal(stored.includes(secret), false, "the frame's content never leaves the frame");
  assert.equal(
    stored.includes(secret.toLowerCase()),
    false,
    "and a shape name cannot carry it either",
  );
  assert.equal(
    stored.includes("\u001b"),
    false,
    "and no paint from the frame is kept: counts and ids only",
  );
});

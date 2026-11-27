/**
 * The transform pipeline (S2, S3, S4): the general ordered pass the conversation wrapper runs
 * BEFORE the rows reach the host's frame loop, and after the card-style repaint.
 *
 * ## Why the pipeline lives here, and not in each plugin
 *
 * `pi.registerToolRenderer` runs when a tool row is BUILT (`docs/extensions.md`, "Custom
 * Rendering"), so a rendering choice made through that slot applies to the NEXT row and leaves the
 * cards already on screen untouched. `./card-style-wiring.ts` already wraps the conversation
 * component's `render(width)`, which is the one place that sees every frame, so this module turns
 * that wrapper into an extension point: registered transforms receive the rows the host produced
 * and return the rows to draw.
 *
 * ## What the pipeline guarantees
 *
 * - **Order.** `snapshotTransforms()` decides the sequence (`./bus.ts`); each transform receives the
 *   PREVIOUS transform's output, so two plugins compose without knowing about each other (S2).
 * - **Identity.** With no transform registered the input array itself is returned, which is what
 *   keeps a session that never used the feature byte-identical — the same promise the card-style
 *   transformer makes for `native` (S2).
 * - **Isolation.** A transform that throws, or that returns something which is not an array of
 *   strings, loses only its own contribution: the lines that were in force are kept, the failure is
 *   recorded with the transform's id and message, and the remaining transforms still run (S3).
 *   Nothing here can throw into the host's render, and a frame is never left without an array.
 * - **Width.** Whatever a transform returns is clipped to the width the host rendered at, with the
 *   same `clipToWidth` the card styles use, so a transform cannot make the frame wider than the
 *   terminal (S4).
 *
 * ## Diagnostics
 *
 * The outcome of the most recent frame is kept per transform, replacing the previous frame's record
 * — a report is about "now", not a history. `/bridge-status` prints it (`./status.ts`). A session
 * that registered no transform records nothing at all, which is what keeps its report unchanged.
 *
 * ## Frame telemetry (F1, F4)
 *
 * Each frame's entry is more than an outcome: it also carries the COUNTS of what that transform did
 * with it — the lines it received, plus whatever the transform reported through `ctx.report(...)`:
 * candidates examined, cards recognised, cards rewritten, shapes matched by name. It is what turns
 * "the toggle changes nothing in a real TUI" into either "the grammar recognised no card" or "the
 * grammar recognised cards and rewrote them, so the host draws them elsewhere".
 *
 * The record is COUNTS ONLY. A frame carries the user's private output, so no line and no text is
 * ever stored: every number is clamped to a non-negative integer, and a shape name is kept only
 * when it is a name (lowercase, no spaces, no escapes, at most `MAX_SHAPE_NAME` characters) — a line
 * smuggled into that field is dropped, not displayed. Recording reads primitives only and is
 * guarded, so telemetry cannot throw into the frame and cannot cost one; the counts are collected
 * from the same call that produces the output, with no second pass.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { snapshotTransforms } from "./bus.ts";
import { clipToWidth } from "./card-style-transform.ts";
import { isRecord } from "./rows.ts";
import type { RowOrigin, TransformContext, TranscriptTransform } from "./types.ts";

/** What the pipeline did with one transform in the most recent frame. */
export type TransformFrameStatus = "applied" | "skipped" | "failed";

/**
 * One transform's telemetry for the frame that just ran (F1): counts, and nothing of the frame.
 *
 * `lines` is what the pipeline handed the transform (the number of rows in force at that point, so
 * it shrinks and grows with the card-style repaint and the transforms before it); the rest is what
 * the transform reported about its own grammar. `shapes` is ordered by first report, so a report is
 * deterministic; it is empty for a grammar with a single shape or a transform that reports none.
 */
export interface TransformFrameCounts {
  lines: number;
  candidates: number;
  recognised: number;
  rewritten: number;
  shapes: ReadonlyArray<{ name: string; count: number }>;
}

/**
 * One transform's contribution to the last frame. `skipped` means it was called and left the rows
 * as they were; `failed` means it threw or returned something that is not lines, and its message
 * says which. `counts` is this frame's telemetry, present for every status because the line count is
 * known even when the transform never reported.
 */
export interface TransformFrameOutcome {
  id: string;
  status: TransformFrameStatus;
  /** Only for `failed`: what went wrong, verbatim, for `/bridge-status`. */
  message?: string;
  /** F1: this frame's counts. Never any line, text or content of the frame. */
  counts: TransformFrameCounts;
}

/** The counts a transform reported, sanitised. `lines` is added by the pipeline. */
type ReportedCounts = Omit<TransformFrameCounts, "lines">;

/** The longest a shape name may be. A shape is a grammar branch, not a sentence. */
const MAX_SHAPE_NAME = 24;

/** How many distinct shape names are kept per frame; anything past this is dropped. */
const MAX_SHAPES = 12;

/** A count above this is not a measurement; it is clamped so one frame cannot bloat the record. */
const MAX_COUNT = 1_000_000_000;

/**
 * What a shape name may be: a lowercase name — letters, digits, `_`, `.`, `-` — and nothing else.
 * No space means no line of output can be carried in this field, and no uppercase or escape means a
 * plugin cannot paint or smuggle through it. A name that does not match is dropped, never stored.
 */
const SHAPE_NAME = /^[a-z][a-z0-9_.-]*$/u;

interface PipelineState {
  /** The most recent frame's outcomes, in the order the transforms ran. */
  lastFrame: TransformFrameOutcome[];
}

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const PIPELINE_STATE = Symbol.for("gentle-shell-bridge.transform-pipeline.state.v1");

function pipelineHost(): Record<symbol, PipelineState | undefined> {
  // SAFETY: only `pipelineState()` writes this key, and it re-checks the shape it finds.
  return globalThis as unknown as Record<symbol, PipelineState | undefined>;
}

function pipelineState(): PipelineState {
  const host = pipelineHost();
  const existing = host[PIPELINE_STATE];
  if (isRecord(existing) && Array.isArray(existing.lastFrame)) return existing as PipelineState;
  const created: PipelineState = { lastFrame: [] };
  host[PIPELINE_STATE] = created;
  return created;
}

/** What the most recent frame did with each transform, in pipeline order. A copy, never the state. */
export function getTransformFrameOutcomes(): TransformFrameOutcome[] {
  return pipelineState().lastFrame.map((outcome) => {
    // A copy all the way down: a caller cannot reach into the record and rewrite the frame it holds.
    // Counts from a copy of this module older than the telemetry read as zeros, never as `undefined`.
    const counts = normaliseCounts(outcome.counts);
    return { ...outcome, counts: { ...counts, shapes: counts.shapes.map((shape) => ({ ...shape })) } };
  });
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetTransformPipelineForTests(): void {
  delete pipelineHost()[PIPELINE_STATE];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a transform's return value is a row array at all. */
function isLineArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array with non-string entries";
  return typeof value;
}

// ---------------------------------------------------------------------------------------------
// Telemetry: counts in, counts out, and never a line of the frame
// ---------------------------------------------------------------------------------------------

/** One count: a finite, non-negative integer, clamped so a report cannot bloat the record. */
function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_COUNT);
}

/**
 * The shape names a transform reported, keeping only the ones that ARE names (F1).
 *
 * This is the rule that makes "counts only" true rather than promised: a name with a space could be
 * a line of the user's output, one with an escape could paint, and a long one could be a paragraph.
 * Such an entry is DROPPED — never rewritten, never shown — and the counts are kept.
 */
function shapeNames(shapes: unknown): Array<{ name: string; count: number }> {
  if (!isRecord(shapes)) return [];
  const names: Array<{ name: string; count: number }> = [];
  for (const [name, value] of Object.entries(shapes)) {
    if (names.length >= MAX_SHAPES) break;
    if (name.length > MAX_SHAPE_NAME || !SHAPE_NAME.test(name)) continue;
    const count = countOf(value);
    if (count === 0) continue;
    names.push({ name, count });
  }
  return names;
}

/** A report, sanitised: numbers clamped, shape names filtered, anything else zero. */
function reportedCounts(reported: unknown): ReportedCounts {
  if (!isRecord(reported)) return { candidates: 0, recognised: 0, rewritten: 0, shapes: [] };
  return {
    candidates: countOf(reported.candidates),
    recognised: countOf(reported.recognised),
    rewritten: countOf(reported.rewritten),
    shapes: shapeNames(reported.shapes),
  };
}

/** A record read back (possibly written by another copy of this module): counts, or zeros. */
function normaliseCounts(value: unknown): TransformFrameCounts {
  const counts = isRecord(value) ? value : {};
  return {
    lines: countOf(counts.lines),
    candidates: countOf(counts.candidates),
    recognised: countOf(counts.recognised),
    rewritten: countOf(counts.rewritten),
    shapes: readShapes(counts.shapes),
  };
}

/** The shape list of a stored record, keeping only entries that are still names and counts. */
function readShapes(value: unknown): Array<{ name: string; count: number }> {
  if (!Array.isArray(value)) return [];
  const names: Array<{ name: string; count: number }> = [];
  for (const entry of value) {
    if (names.length >= MAX_SHAPES) break;
    if (!isRecord(entry)) continue;
    const { name } = entry;
    const count = countOf(entry.count);
    if (
      typeof name !== "string" ||
      name.length > MAX_SHAPE_NAME ||
      !SHAPE_NAME.test(name) ||
      count === 0
    ) {
      continue;
    }
    names.push({ name, count });
  }
  return names;
}

/** This frame's entry counts: the lines the transform received plus what it reported (F1). */
function frameCounts(lines: number, reported: ReportedCounts | undefined): TransformFrameCounts {
  const base = reported ?? { candidates: 0, recognised: 0, rewritten: 0, shapes: [] };
  return {
    lines,
    candidates: base.candidates,
    recognised: base.recognised,
    rewritten: base.rewritten,
    shapes: base.shapes.map((shape) => ({ ...shape })),
  };
}

/**
 * The transform's output, clipped to the host's width (S4). Returns `undefined` when nothing
 * changed, so the caller keeps the array it already had and identity survives a no-op.
 *
 * The same ARRAY means the transform touched nothing: it is handed back without measuring or
 * clipping a single row. That is the rule a real TUI needed (W2-1): the example returns `lines` in
 * `default` mode, and clipping the host's own rows afterwards cut them on the right, because the
 * clip's model disagreed with the host's about hyperlinks and grapheme clusters.
 */
function clipResult(next: readonly string[], current: readonly string[], width: number): string[] | undefined {
  if (next === current) return undefined;
  const clipped = next.map((line) => clipToWidth(line, width));
  const unchanged =
    clipped.length === current.length &&
    clipped.every((line, index) => line === current[index]);
  return unchanged ? undefined : clipped;
}

/**
 * Run the registered transforms over the frame, in order, and return the rows to draw (S2, S3, S4).
 *
 * `rows` is the frame's row origin (S1, `./row-origin.ts`): which host child drew each row, one entry
 * per row, or an empty array when the origin is unknown. It is handed to every transform in `ctx`
 * and never READ here — the pipeline is a pass-through for it, so a transform that ignores the field
 * produces the same bytes it did before the field existed, and a frame whose origin is unknown is
 * simply a frame with no identity (never a skipped frame, never a throw).
 *
 * The returned array is the input instance whenever the frame was not changed: no transform
 * registered, every transform a no-op, or every transform failing. The frame's outcome record is
 * replaced here, once per frame.
 */
export function applyTransforms(
  lines: string[],
  width: number,
  rows: readonly RowOrigin[] = [],
): string[] {
  let transforms: TranscriptTransform[];
  try {
    transforms = snapshotTransforms();
  } catch {
    // The registry is process-global state written by other copies; a broken read is a pass-through
    // rather than a frame this module takes down.
    return lines;
  }
  if (transforms.length === 0) return lines;

  const outcomes: TransformFrameOutcome[] = [];
  let current = lines;

  for (const transform of transforms) {
    // The count the pipeline owns (F1): the rows in force when this transform was handed the frame.
    const received = current.length;
    let reported: ReportedCounts | undefined;
    const ctx: TransformContext = {
      width,
      rows,
      report: (counts): void => {
        // F4: telemetry is diagnostics. Sanitising reads primitives only, and this guard means no
        // report — however malformed — can reach the frame the host is waiting for.
        try {
          reported = reportedCounts(counts);
        } catch {
          reported = undefined;
        }
      },
    };

    let next: readonly string[];
    try {
      // `transform` is validated at registration; a foreign mutation after that is still caught
      // here, because the call and the shape check are both inside this guard.
      const produced: unknown = transform.transform.call(transform, current, ctx);
      if (!isLineArray(produced)) {
        throw new Error(
          `the transform returned ${describeValue(produced)}; a transform must return an array of lines (string[]).`,
        );
      }
      next = produced;
    } catch (error) {
      // S3: this transform is skipped for the frame, and the remaining ones still run. F1: the
      // counts it reached before the throw are what the report shows, never lost.
      outcomes.push({
        id: transform.id,
        status: "failed",
        message: errorMessage(error),
        counts: frameCounts(received, reported),
      });
      continue;
    }

    const clipped = clipResult(next, current, width);
    outcomes.push({
      id: transform.id,
      status: clipped === undefined ? "skipped" : "applied",
      counts: frameCounts(received, reported),
    });
    if (clipped !== undefined) current = clipped;
  }

  pipelineState().lastFrame = outcomes;
  return current;
}

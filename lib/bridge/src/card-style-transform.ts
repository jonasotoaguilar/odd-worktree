/**
 * The line transformer (S3, S6, S12): what turns the host's already-drawn cards into the selected
 * style's chrome.
 *
 * ## What it is given, and what it may change
 *
 * The host renders one component and gets `string[]` back; the bridge wraps that call, so this
 * module takes the rows the host produced plus the width it rendered at, and returns rows. Only two
 * things are ever rewritten: the rows of a card detected by the grammar below. Every other row is
 * carried through as the SAME string (S3.4), and when there is nothing to do — `native`, no
 * selection, a selection naming a style that no longer exists — the input array itself comes back
 * (S3: "the same array reference, untouched").
 *
 * ## The float grammar it detects (`src/card-styles.ts` §2, from `lib/shell-card.ts`)
 *
 * A float card is: a one-column margin, then an accent bar `▎`, then one space — on every row. In
 * that frame the rows are
 *
 * ```
 *  ▎ <spaces>                 opener          (bar only: `cardBottom` with no content)
 *  ▎ <glyph> <title> … <hint> header          (all the text a card's heading carries)
 *  ▎ <spaces>                 separator       (ONLY when the card has a body)
 *  ▎ <text>…                  body row        (one per wrapped row)
 *  ▎ <spaces>                 closer          (identical to the opener)
 * ```
 *
 * so detection is positional, never lexical: padding row, header row, then either one more
 * padding row (an empty-body card — exactly three rows) or a separator, body rows and a closer.
 * `neon` starts at column 0 with `╭`, `│` or `╰`, so it never matches `isFloatRow` and is left
 * alone: the bridge must not repaint a card that did not use the float frame.
 *
 * ### The three ambiguities this pass has to choose between, spelled out
 *
 * 1. **A blank body row is byte-identical to the opener/closer.** `cardBodyRows` draws an empty
 *    paragraph as `cardLine("")`, which is a bar and spaces — the same string as the padding row.
 *    So the body of a card CONTAINING a blank row ends at that blank row, and its remaining rows
 *    are left as the host drew them. Chosen because the alternative (extend until a padding row
 *    that is followed by a non-float row) swallows the next card whenever two cards are adjacent.
 * 2. **A heading's last text run may be a hint or a subtitle.** `cardTop` paints the hint as
 *    `" " + fg(dim, hint) + " "` and a subtitle as `" " + fg(muted, "·") + " " + fg(muted, sub)`, and
 *    at the character level both are text between runs of spaces. The structural difference used
 *    here: the hint is a single styled run flanked by UNSTYLED single spaces, and its SGR differs
 *    from the title's; a subtitle is preceded by the dotted run, not by an unstyled space. See
 *    `extractHeading` — when that structure is not there, NO split is guessed: the whole remainder
 *    becomes `title` and `hint` is undefined.
 * 3. **The glyph.** The host always prints `${card.glyph ?? "✿"} ${title}`. The glyph is stripped
 *    from `title` when it is a single character followed by one space, because a style draws its own
 *    chrome (S2's context is the heading text, not the host's glyph); a card whose heading would
 *    lose its first word that way cannot be told apart from the normal case, and would need a glyph
 *    of more than one cell to happen.
 *
 * ## Failure is a pass-through (S6)
 *
 * Any throw — detection, extraction, or inside a style's `top`/`line`/`bottom` — returns the ORIGINAL
 * array, so a card is never half-repainted, and records one failure for `/bridge-status`. A style
 * can degrade the look; it can never break the conversation. The transformer never catches a host
 * failure: it is only given rows that already exist.
 *
 * ## Width discipline
 *
 * The host owns the frame width. A style that returns something wider is clipped here, never
 * emitted — and if the clipped text had SGR active, a reset is appended so the paint cannot leak
 * into the next row.
 *
 * This module is internal: `src/index.ts` does not re-export it.
 */

import { resolveCardStyleSelection, type CardStyleSelection } from "./card-styles.ts";
import type { PaintSurface } from "./repaint.ts";
import { isRecord } from "./rows.ts";
import type { CardStyleRegistration } from "./types.ts";

/** The accent bar every float row starts with, one column in from the margin (`shell-card.ts:108`). */
const FLOAT_BAR = "▎";

/** A full reset, appended after a clipped styled line so the paint cannot leak. */
const RESET = "\u001b[0m";

/** One SGR sequence. Used for stripping and for reading a row's style runs. */
const SGR_ALL = /\u001b\[[0-9;]*m/gu;
/** The same sequence, sticky, for the clip walk (no regex state crosses calls). */
const SGR_AT = /\u001b\[[0-9;]*m/y;

/** SGR params that leave no foreground/background in force. */
const RESET_PARAMS = new Set(["", "0", "39", "49", "22", "23", "24", "25", "27", "28", "29"]);

/** How many failures are kept for `/bridge-status`. */
const MAX_FAILURES = 32;

export interface CardStyleTransformFailure {
  /** The style that threw. */
  styleId: string;
  message: string;
}

/**
 * What the most recent frame did. `/bridge-status` reports it, so "the style is selected but the
 * conversation looks untouched" always has an answer.
 */
export type CardStyleFrameOutcome =
  | { kind: "transformed"; styleId: string; cards: number }
  | { kind: "pass-through"; reason: "native" | "missing" | "no-card" }
  | { kind: "failed"; styleId: string; message: string };

interface TransformState {
  failures: CardStyleTransformFailure[];
  /**
   * The most recent frame per SURFACE (R4). The conversation and the rail repaint through this one
   * transform, so "the style is selected but the sidebar looks untouched" has an answer per surface
   * instead of one shared last-writer.
   */
  lastOutcomes: Partial<Record<PaintSurface, CardStyleFrameOutcome>>;
}

/** Process-global, like every other piece of bridge state (`./bus.ts` explains why). */
const TRANSFORM_STATE = Symbol.for("gentle-shell-bridge.card-style-transform.state.v1");

function transformHost(): Record<symbol, TransformState | undefined> {
  // SAFETY: only `transformState()` writes this key, and it re-checks the shape it finds.
  return globalThis as unknown as Record<symbol, TransformState | undefined>;
}

function isTransformStateLike(value: unknown): value is TransformState {
  return isRecord(value) && Array.isArray(value.failures) && isRecord(value.lastOutcomes);
}

function transformState(): TransformState {
  const host = transformHost();
  const existing = host[TRANSFORM_STATE];
  if (isTransformStateLike(existing)) return existing;
  const created: TransformState = { failures: [], lastOutcomes: {} };
  host[TRANSFORM_STATE] = created;
  return created;
}

/** The failures the last frames recorded, oldest first. Read by `/bridge-status` (T4). */
export function getCardStyleTransformFailures(): CardStyleTransformFailure[] {
  return transformState().failures.map((failure) => ({ ...failure }));
}

/**
 * What the last frame did on one surface, or `undefined` before that surface ran this transform once.
 * The conversation is the default because it is the surface that existed first; `/bridge-status`
 * asks for both.
 */
export function getCardStyleLastOutcome(
  surface: PaintSurface = "conversation",
): CardStyleFrameOutcome | undefined {
  const outcome = transformState().lastOutcomes[surface];
  return outcome === undefined ? undefined : { ...outcome };
}

/** Test-only seam; deliberately not re-exported from `src/index.ts`. */
export function resetCardStyleTransformForTests(): void {
  const state = transformState();
  state.failures.length = 0;
  state.lastOutcomes = {};
}

function recordOutcome(surface: PaintSurface, outcome: CardStyleFrameOutcome): void {
  transformState().lastOutcomes[surface] = outcome;
}

/** Record one failure, once per (style, message): a style that throws every frame is one fact. */
function recordFailure(styleId: string, message: string): void {
  const state = transformState();
  if (state.failures.some((failure) => failure.styleId === styleId && failure.message === message)) {
    return;
  }
  state.failures.push({ styleId, message });
  if (state.failures.length > MAX_FAILURES) {
    state.failures.splice(0, state.failures.length - MAX_FAILURES);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------------

function stripAnsi(line: string): string {
  return line.replace(SGR_ALL, "");
}

/** `margin ▎ space` — the float frame's first three columns on every row it draws. */
function isFloatRow(stripped: string): boolean {
  return stripped.length >= 3 && stripped.startsWith(` ${FLOAT_BAR} `);
}

/** A bar and nothing else: the opener, the separator and the closer all look like this. */
function isPaddingRow(stripped: string): boolean {
  return isFloatRow(stripped) && stripped.slice(3).trim() === "";
}

/** A bar and some text: a heading or a body row. */
function isContentRow(stripped: string): boolean {
  return isFloatRow(stripped) && stripped.slice(3).trim() !== "";
}

/** The text a card row carries, without the frame: what a style's `line` is given. */
function rowText(stripped: string): string {
  return stripped.slice(3).trimEnd();
}

/** One span of a raw row with a single SGR state, and where it starts in the stripped row. */
interface Segment {
  code: string;
  text: string;
  start: number;
}

/**
 * Split a raw row into runs of constant SGR state, recording each run's start offset in the
 * STRIPPED row, so a heading can be sliced by visible position afterwards.
 */
function segmentsOf(raw: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = new RegExp(SGR_ALL.source, "gu");
  let code = "";
  let cursor = 0;
  let visible = 0;
  for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
    const text = raw.slice(cursor, match.index);
    if (text !== "") {
      segments.push({ code, text, start: visible });
      visible += text.length;
    }
    code = sgrCode(match[0]);
    cursor = match.index + match[0].length;
  }
  const tail = raw.slice(cursor);
  if (tail !== "") segments.push({ code, text: tail, start: visible });
  return segments;
}

/** The SGR that is in force after `sgr`; `""` for a reset, the sequence itself otherwise. */
function sgrCode(sgr: string): string {
  const params = sgr.slice(2, -1);
  const parts = params === "" ? [""] : params.split(";");
  return parts.every((part) => RESET_PARAMS.has(part)) ? "" : sgr;
}

// ---------------------------------------------------------------------------------------------
// Heading extraction (S3.2): title and hint, once, in this one place
// ---------------------------------------------------------------------------------------------

export interface CardHeading {
  /** The heading text without the host's glyph; undefined when the row carried none. */
  title?: string;
  /** The right-aligned hint, only when its structure proves it is one. */
  hint?: string;
}

/**
 * Extract a float card's heading from its header row.
 *
 * The split is proved structurally, never guessed: the hint is the last styled run of the row, it
 * is flanked by UNSTYLED single spaces (`cardTop`'s `tail`), and its SGR differs from the title's
 * (`HINT_ROLE` is `dim`). A subtitle (`· subtitle`, in the muted role) is preceded by the dotted run
 * instead of an unstyled space, so it is not mistaken for a hint. When the structure does not hold,
 * the whole remainder is the title and `hint` is undefined — a style then draws the heading exactly
 * as the host printed it, which is worse-looking but never wrong.
 */
export function extractHeading(rawHeader: string): CardHeading {
  const stripped = stripAnsi(rawHeader);
  if (!isFloatRow(stripped)) return {};
  const segments = segmentsOf(rawHeader).filter((segment) => segment.start >= 3);
  const firstContent = segments.findIndex((segment) => segment.text.trim() !== "");
  if (firstContent === -1) return {};

  let hint: string | undefined;
  let titleEnd = stripped.length;
  for (let index = segments.length - 1; index > firstContent; index -= 1) {
    const candidate = segments[index];
    if (candidate === undefined) break;
    if (candidate.text.trim() === "") continue;
    const before = segments[index - 1];
    const after = segments[index + 1];
    const proven =
      before !== undefined &&
      after !== undefined &&
      before.code === "" &&
      before.text.trim() === "" &&
      after.code === "" &&
      after.text.trim() === "" &&
      candidate.code !== "" &&
      candidate.code !== segments[firstContent]?.code;
    if (proven) {
      hint = candidate.text.trim();
      titleEnd = candidate.start;
    }
    break;
  }

  const heading = stripGlyph(stripped.slice(3, titleEnd).trim());
  return hint === undefined ? { title: heading } : { title: heading, hint };
}

/**
 * Drop the host's leading glyph (`${card.glyph ?? "✿"} `). The glyph is always one character
 * followed by exactly one space (`shell-card.ts:124`); the title is what follows it.
 */
function stripGlyph(heading: string): string | undefined {
  const characters = [...heading];
  if (characters.length > 2 && characters[1] === " ") return characters.slice(2).join("");
  return heading === "" ? undefined : heading;
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

interface CardSpan {
  /** The opener (padding) row. */
  start: number;
  /** The header row. */
  header: number;
  /** First body row; equals `bodyEnd` for an empty body. */
  bodyStart: number;
  /** One past the last body row. */
  bodyEnd: number;
  /** The closing padding row. */
  closer: number;
}

function matchCard(stripped: readonly string[], start: number): CardSpan | undefined {
  if (!isPaddingRow(stripped[start] ?? "")) return undefined;
  if (!isContentRow(stripped[start + 1] ?? "")) return undefined;

  const third = stripped[start + 2];
  if (third === undefined) return undefined;

  if (isContentRow(third)) {
    // Header straight into body, with no separator: a shape `floatRows` can produce when a caller
    // supplies a body without a head, and one that costs nothing to accept.
    const closer = findCloser(stripped, start + 2);
    if (closer === undefined) return undefined;
    return { start, header: start + 1, bodyStart: start + 2, bodyEnd: closer, closer };
  }
  if (!isPaddingRow(third)) return undefined;

  // A padding row after the header is a separator when body content follows it, and the closer when
  // nothing does — which is what makes an empty-body card exactly three rows.
  if (isContentRow(stripped[start + 3] ?? "")) {
    const closer = findCloser(stripped, start + 3);
    if (closer === undefined) return undefined;
    return { start, header: start + 1, bodyStart: start + 3, bodyEnd: closer, closer };
  }
  return { start, header: start + 1, bodyStart: start + 2, bodyEnd: start + 2, closer: start + 2 };
}

/** The first padding row at or after `from`: the card's closer. An unterminated card is not a card. */
function findCloser(stripped: readonly string[], from: number): number | undefined {
  for (let index = from; index < stripped.length; index += 1) {
    if (isPaddingRow(stripped[index] ?? "")) return index;
  }
  return undefined;
}

/**
 * Every float card in the frame, in order, skipping the rows it already claimed so a body row can
 * never be read as the opener of the next card.
 */
function findCards(lines: readonly string[]): CardSpan[] {
  const stripped = lines.map((line) => stripAnsi(line));
  const cards: CardSpan[] = [];
  let index = 0;
  while (index < stripped.length) {
    const card = matchCard(stripped, index);
    if (card === undefined) {
      index += 1;
      continue;
    }
    cards.push(card);
    index = card.closer + 1;
  }
  return cards;
}

// ---------------------------------------------------------------------------------------------
// Width discipline
// ---------------------------------------------------------------------------------------------

/** Whether a code point occupies two terminal columns (the common wide/emoji ranges). */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Columns one character occupies: 0 for combining/control, 2 for wide, 1 otherwise. */
function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  return isWideCodePoint(code) ? 2 : 1;
}

/**
 * The model pi-tui measures a row with, ported from `visibleWidth` (`pi-tui/dist/utils.js:212-268`,
 * pi-tui 1.5.x):
 *
 * - ANSI/CSI, OSC and APC sequences are zero columns (`:228-257`, which strips through
 *   `extractAnsiCode`, so an OSC-8 hyperlink contributes its TEXT and not its URL);
 * - a TAB is THREE columns, not one (`:229-231`, `clean.replace(/\t/g, "   ")`);
 * - the rest is segmented into GRAPHEME CLUSTERS (`:259-262`, `Intl.Segmenter` with
 *   `granularity: "grapheme"`) and each cluster is charged the way `graphemeWidth` charges it
 *   (`:143-207`): a lone printable ASCII byte one, a cluster of terminal-spacing marks its code
 *   point count, a cluster of nothing but ignorables/controls/marks/surrogates none, an RGI emoji
 *   (after the host's own `couldBeEmoji` prefilter, so bare `©`/`☺`/`▶` are NOT emoji) two, a
 *   leading regional-indicator pair two, otherwise the base's East Asian `W|F` width plus every
 *   terminal-spacing mark, mark-following VISIBLE code point (the consonant of an Indic conjunct
 *   after its virama: `क्‍ष` is two columns), halfwidth/fullwidth form and Thai/Lao AM vowel.
 *
 * This exists because `visibleColumns` counts per code point, charges a tab one column and only
 * ignores SGR, so a row this package believes fits can measure wider to the host (or a fitting row
 * can be cut). Anything contributed to the HOST's frame is measured the host's way
 * (`./section-panel.ts`, `./sidebar-render.ts`, `./transform-pipeline.ts`), and the port is exact:
 * measured against the installed `visibleWidth` for every Unicode code point, no cluster differs.
 */
export function hostColumns(line: string): number {
  if (line === "") return 0;
  // Tabs first, exactly like the host: `clean.replace(/\t/g, "   ")` (`utils.js:229-231`).
  const expanded = line.includes("\t") ? line.replace(/\t/gu, "   ") : line;
  const clean = stripHostEscapes(expanded);
  // Fast path, like the host's (`utils.js:216-221`): printable ASCII is one column per byte.
  if (ASCII_ONLY.test(clean)) return clean.length;
  let columns = 0;
  for (const segment of graphemes(clean)) columns += clusterColumns(segment);
  return columns;
}

/** One complete escape sequence at `index`, read exactly as pi-tui's `extractAnsiCode` reads it. */
function hostEscapeAt(line: string, index: number): { code: string; length: number } | undefined {
  if (line[index] !== "\u001b") return undefined;
  const kind = line[index + 1];
  if (kind === "[") {
    // CSI: `ESC [` up to and including the first final byte the host recognises.
    let end = index + 2;
    while (end < line.length && !/[mGKHJ]/u.test(line[end] ?? "")) end += 1;
    return end < line.length ? { code: line.slice(index, end + 1), length: end + 1 - index } : undefined;
  }
  if (kind === "]" || kind === "_") {
    // OSC / APC: terminated by BEL or by ST (`ESC \\`).
    let end = index + 2;
    while (end < line.length) {
      if (line[end] === "\u0007") return { code: line.slice(index, end + 1), length: end + 1 - index };
      if (line[end] === "\u001b" && line[end + 1] === "\\") {
        return { code: line.slice(index, end + 2), length: end + 2 - index };
      }
      end += 1;
    }
    return undefined;
  }
  return undefined;
}

/** A row with every complete escape sequence removed, as the host strips before measuring. */
function stripHostEscapes(line: string): string {
  if (!line.includes("\u001b")) return line;
  let clean = "";
  let index = 0;
  while (index < line.length) {
    const escape = hostEscapeAt(line, index);
    if (escape !== undefined) {
      index += escape.length;
      continue;
    }
    clean += line[index];
    index += 1;
  }
  return clean;
}

/** The URI of an OSC-8 hyperlink, or `""` for its closing sequence; `undefined` for anything else. */
function osc8Target(code: string): string | undefined {
  if (!code.startsWith("\u001b]8;")) return undefined;
  const end = code.endsWith("\u0007") ? code.length - 1 : code.length - 2;
  const body = code.slice(4, end);
  const separator = body.indexOf(";");
  return separator === -1 ? undefined : body.slice(separator + 1);
}

/** A row of printable ASCII, the one shape whose width needs no grapheme segmentation. */
const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** A grapheme segmenter, or `undefined` on a runtime without `Intl.Segmenter`. */
const GRAPHEMES: Intl.Segmenter | undefined =
  typeof Intl === "object" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** The grapheme clusters of one row, falling back to code points when no segmenter exists. */
function graphemes(clean: string): string[] {
  if (GRAPHEMES === undefined) return Array.from(clean);
  const clusters: string[] = [];
  for (const { segment } of GRAPHEMES.segment(clean)) clusters.push(segment);
  return clusters;
}

/**
 * A cluster made only of ignorables, controls, marks, formats or surrogates has no columns
 * (`zeroWidthRegex`, `pi-tui/dist/utils.js:34`).
 */
const ZERO_WIDTH_CLUSTER = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;

/** The marks an emoji or a consonant may carry before its base (`leadingNonPrintingRegex`, `:35`). */
const LEADING_NON_PRINTING =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;

/** One character the host's trailing loop skips (`nonPrintingCharRegex`, `:36`). */
const NON_PRINTING_CHAR =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;

/** One combining mark (`markCharRegex`, `:37`). */
const MARK_CHAR = /^\p{Mark}$/v;

/**
 * The marks terminals allocate cells for, with or without a base (`terminalSpacingMarkRegex`,
 * `:38-40`): spacing marks except a few zero-width exceptions, plus the scripts whose spacing marks
 * legacy wcwidth tables charge. A lone `ि` is ONE column to the host, while a lone `्` is none.
 */
const TERMINAL_SPACING_MARK =
  /^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;

/** The emoji set the host tests AFTER its cheap prefilter (`rgiEmojiRegex`, `:41`). */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/**
 * The host's cheap emoji prefilter (`couldBeEmoji`, `pi-tui/dist/utils.js:16-26`): broad blocks, an
 * explicit emoji presentation selector, or a multi-code-unit sequence. Without it, `©` and `☺`
 * would be charged as emoji when the host charges them one column.
 */
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
 * The East Asian width of a base code point, as the host reads it: `W` or `F` is two columns, every
 * other class one (`get-east-asian-width`'s `eastAsianWidth`, which `graphemeWidth` calls at
 * `pi-tui/dist/utils.js:151`). The host depends on that package's generated tables; this is its
 * `W|F` range set, flattened to `[start, end, start, end, …]`, so the port stays dependency-free.
 * A lone code point is `[cp, cp]`.
 */
const WIDE_RANGES: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec,
  0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2630, 0x2637, 0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f,
  0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd,
  0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797,
  0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5,
  0x2ff0, 0x303e, 0x3041, 0x3096, 0x3099, 0x30ff, 0x3105, 0x312f,
  0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247,
  0x3250, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3,
  0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe52, 0xfe54, 0xfe66,
  0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4,
  0x16ff0, 0x16ff6, 0x17000, 0x18cd5, 0x18cff, 0x18d1e, 0x18d80, 0x18df2,
  0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122,
  0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155, 0x1b164, 0x1b167,
  0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360, 0x1d376, 0x1f004, 0x1f004,
  0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f202,
  0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265,
  0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393,
  0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4,
  0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d,
  0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596,
  0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc,
  0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d8, 0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec,
  0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a,
  0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa8a,
  0x1fa8e, 0x1fac6, 0x1fac8, 0x1fac8, 0x1facd, 0x1fadc, 0x1fadf, 0x1faea,
  0x1faef, 0x1faf8, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

/** Whether a base code point is East Asian Wide or Fullwidth: two columns, as the host charges it. */
function isEastAsianWide(codePoint: number): boolean {
  let low = 0;
  let high = WIDE_RANGES.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = WIDE_RANGES[middle * 2] ?? 0;
    const end = WIDE_RANGES[middle * 2 + 1] ?? 0;
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * The columns one grapheme cluster occupies, as the host charges it (`graphemeWidth`,
 * `pi-tui/dist/utils.js:143-207`), in the host's own order:
 *
 * 1. a lone printable ASCII byte is one column, a lone TAB three;
 * 2. a cluster of terminal-spacing marks is its code point count (a lone `ि` is one, not zero);
 * 3. a cluster of ignorables, controls, marks and surrogates is zero;
 * 4. an RGI emoji (after the host's prefilter) is two, so `©`/`☺` are NOT emoji and `©️`/`1️⃣` are;
 * 5. a leading regional-indicator pair is two; otherwise the base's East Asian width;
 * 6. every trailing terminal-spacing mark adds one, and every VISIBLE code point that follows a
 *    mark adds its own width — which is why an Indic conjunct such as `क्‍ष` is TWO columns (base
 *    `क` plus the consonant `ष` after the virama), not one. Halfwidth/fullwidth forms and the
 *    Thai/Lao AM vowels add their own columns on the same walk.
 */
function clusterColumns(cluster: string): number {
  // The host's own fast path (`graphemeWidth`, `:149-159`).
  if (cluster.length === 1) {
    const code = cluster.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return 1;
    if (code === 0x09) return TAB_COLUMNS;
  }
  if (TERMINAL_SPACING_MARK.test(cluster)) return [...cluster].length;
  if (ZERO_WIDTH_CLUSTER.test(cluster)) return 0;
  if (couldBeEmoji(cluster) && RGI_EMOJI.test(cluster)) return 2;

  const base = cluster.replace(LEADING_NON_PRINTING, "");
  const codePoint = base.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;

  let width = isEastAsianWide(codePoint) ? 2 : 1;
  let followsMark = false;
  for (const char of [...base].slice(1)) {
    if (TERMINAL_SPACING_MARK.test(char)) {
      width += 1;
      followsMark = false;
      continue;
    }
    if (MARK_CHAR.test(char)) {
      followsMark = true;
      continue;
    }
    if (NON_PRINTING_CHAR.test(char)) continue;
    const trailing = char.codePointAt(0) ?? 0;
    if (followsMark) width += isEastAsianWide(trailing) ? 2 : 1;
    else if (trailing >= 0xff00 && trailing <= 0xffef) width += isEastAsianWide(trailing) ? 2 : 1;
    else if (trailing === 0x0e33 || trailing === 0x0eb3) width += 1;
    followsMark = false;
  }
  return width;
}

/**
 * The visible columns of one row, SGR ignored, counted CODE POINT by code point. This is NOT the
 * host's model: it charges a TAB one column, ignores no OSC/APC sequence and splits a grapheme
 * cluster. Anything measured for the host's frame uses `hostColumns`.
 */
export function visibleColumns(line: string): number {
  let columns = 0;
  let index = 0;
  while (index < line.length) {
    SGR_AT.lastIndex = index;
    const escape = SGR_AT.exec(line);
    if (escape !== null) {
      index += escape[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index) ?? 0);
    index += char.length;
    columns += cellWidth(char);
  }
  return columns;
}

/**
 * Clip one row to the host's width, measured and cut the way the host measures and cuts.
 *
 * A row that already fits under `hostColumns` is returned BYTE-IDENTICAL, escapes included: the
 * host's own rows must survive a transform that did not touch them (an OSC-8 hyperlink made this
 * model disagree with pi-tui, and a fitting row was cut on the right).
 *
 * A row that must be cut keeps every escape it reaches whole, charges a TAB three columns and a
 * grapheme cluster as a unit, and never splits one. An OSC-8 link left open by the cut is closed
 * and an active SGR is reset, so the cut cannot leak a link or a paint into the following rows.
 * Nothing is ever appended to fit: padding is the style's business.
 */
export function clipToWidth(line: string, width: number): string {
  // W2-2 first, at every width: a row that already fits is the same bytes. Measured the host's way,
  // an ANSI-only row has zero columns, so it survives even at width zero.
  if (hostColumns(line) <= width) return line;
  if (width <= 0) return "";

  // Segment the VISIBLE text, not one escape-free run at a time: an SGR sequence may sit inside a
  // grapheme cluster (`👨` + SGR + `‍👩‍👧‍👦`), and cutting at a run boundary split that cluster.
  // Every visible character is mapped back to where it starts in the raw row, so the kept prefix is
  // one raw slice — escapes interleaved with the clusters that were kept, nothing half-emitted.
  const visible: string[] = [];
  const rawAt: number[] = [];
  let index = 0;
  while (index < line.length) {
    const escape = hostEscapeAt(line, index);
    if (escape !== undefined) {
      index += escape.length;
      continue;
    }
    rawAt.push(index);
    visible.push(String.fromCodePoint(line.codePointAt(index) ?? 0));
    index += visible[visible.length - 1]?.length ?? 1;
  }
  rawAt.push(line.length);

  let used = 0;
  let kept = 0;
  let codePoints = 0;
  for (const cluster of graphemes(visible.join(""))) {
    const cells = cluster === "\t" ? TAB_COLUMNS : clusterColumns(cluster);
    if (used + cells > width) break;
    used += cells;
    codePoints += [...cluster].length;
    kept = codePoints;
  }

  let output = line.slice(0, rawAt[kept] ?? line.length);
  let styled = false;
  let linkOpen = false;
  let scan = 0;
  while (scan < output.length) {
    const escape = hostEscapeAt(output, scan);
    if (escape === undefined) {
      scan += 1;
      continue;
    }
    if (escape.code.endsWith("m")) styled = true;
    const target = osc8Target(escape.code);
    if (target !== undefined) linkOpen = target !== "";
    scan += escape.length;
  }
  if (linkOpen) output += OSC8_CLOSE;
  return styled ? `${output}${RESET}` : output;
}

/** How many columns the host charges for a TAB (`graphemeWidth`, `pi-tui/dist/utils.js:148-155`). */
const TAB_COLUMNS = 3;

/** The OSC-8 close, so a link opened before a cut does not stay clickable over the rows after it. */
const OSC8_CLOSE = "\u001b]8;;\u0007";

// ---------------------------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------------------------

/** What one card is redrawn with, computed once. */
function repaintCard(
  lines: readonly string[],
  card: CardSpan,
  style: CardStyleRegistration,
  width: number,
): string[] {
  const heading = extractHeading(lines[card.header] ?? "");
  const output: string[] = [
    clipToWidth(style.frame.top({ width, title: heading.title, hint: heading.hint }), width),
  ];

  const stripped = lines.map((line) => stripAnsi(line));
  for (let row = card.bodyStart; row < card.bodyEnd; row += 1) {
    output.push(
      clipToWidth(
        style.frame.line({
          text: rowText(stripped[row] ?? ""),
          width,
          first: row === card.bodyStart,
        }),
        width,
      ),
    );
  }

  output.push(clipToWidth(style.frame.bottom({ width }), width));
  return output;
}

/** Resolve the selection, recording what it means instead of ever throwing. */
function activeStyle(surface: PaintSurface): CardStyleRegistration | undefined {
  let selection: CardStyleSelection;
  try {
    selection = resolveCardStyleSelection();
  } catch (error) {
    const message = errorMessage(error);
    recordFailure("(selection)", message);
    recordOutcome(surface, { kind: "failed", styleId: "(selection)", message });
    return undefined;
  }
  if (selection.kind === "native") {
    recordOutcome(surface, { kind: "pass-through", reason: "native" });
    return undefined;
  }
  if (selection.kind === "missing") {
    // S12: a selection nobody owns must not render chrome that no longer exists.
    recordOutcome(surface, { kind: "pass-through", reason: "missing" });
    return undefined;
  }
  return selection.style;
}

/**
 * Rewrite every float card in `lines` with the selected style's chrome (S3, R1), or return `lines`
 * itself when there is nothing to do or anything at all went wrong (S6, R2).
 *
 * One function serves every surface: the conversation wrapper (`./card-style-wiring.ts`) calls it
 * with `conversation`, the rail wrapper with `rail`, and the frame is treated identically — the
 * grammar, the clipping and the pass-through are the same code (R1: no second copy of the
 * transform). `surface` only decides WHERE the frame outcome is recorded, so `/bridge-status` can
 * answer for both.
 *
 * The returned array is the input instance whenever the frame was not changed: `native`, no
 * selection, a selection naming a style that no longer exists, no card in the frame, or a throw.
 */
export function transformCardLines(
  lines: string[],
  width: number,
  surface: PaintSurface = "conversation",
): string[] {
  const style = activeStyle(surface);
  if (style === undefined) return lines;

  try {
    const cards = findCards(lines);
    if (cards.length === 0) {
      recordOutcome(surface, { kind: "pass-through", reason: "no-card" });
      return lines;
    }

    const output: string[] = [];
    let cursor = 0;
    for (const card of cards) {
      output.push(...lines.slice(cursor, card.start));
      output.push(...repaintCard(lines, card, style, width));
      cursor = card.closer + 1;
    }
    output.push(...lines.slice(cursor));
    recordOutcome(surface, { kind: "transformed", styleId: style.id, cards: cards.length });
    return output;
  } catch (error) {
    const message = errorMessage(error);
    recordFailure(style.id, message);
    recordOutcome(surface, { kind: "failed", styleId: style.id, message });
    return lines;
  }
}

'use strict';
// The jobs card: `bash_background`, `monitor`, `job_stop` and `job_list` drawn on this
// package's card substrate (`lib/shell-card.js`), in whichever style the shell has chosen.
//
// Gentle Shell registers those four tools with no renderer of their own, so Pi draws its
// plain default box and the conversation's card style (neon or float) never reaches them.
// This module is the drawing half; `lib/jobs-card-resolver.js` decides WHEN it is used — only
// while the bridge's `Card activity` line answers `activity` for the tool being drawn.
//
// It is shaped exactly like `lib/file-card.js` and shares its helpers (tone, expand hint,
// theme fallback, result text, the bounded body preview), so the two cards read as one family.
//
// What the card never decides:
//   * COLOUR. Every cell is a theme role handed to the injected `theme.fg`; no palette and no
//     raw escape sequence is written here, and the frame keeps the TONE's role whenever the
//     tone owns the box, so a running or failed call is never painted in an identity colour.
//   * MEASUREMENT. The substrate clips, wraps and pads plain text and paints it afterwards.
//   * STATE. The tone follows the host's own flags (`isPartial`, `isError`), the expanded view
//     is the host's own `expanded`, the elapsed time its own `durationMs`.
//   * THE TOOL. Nothing is registered, executed or shadowed: the arguments are only read.
//   * THE CONTENT LEVEL. The `minimal` card content level draws the call alone while collapsed;
//     a failure still says why. It is read on every paint.
//
// Rendering never throws: a theme or an argument that fails draws no rows instead of breaking
// the session's transcript.

const {
  cardAwaitingResult,
  cardBodyRows,
  cardBottom,
  cardElapsed,
  cardInnerWidth,
  cardRunningLine,
  cardTopLine,
  cardTopRows,
  floatRows,
  markCardResult,
} = require('./shell-card.js');
const { PREVIEW_ROWS, cardTone, component, expandHint, fileResultRows, optionFlag, resultText, themeFor } = require('./file-card.js');
// The one reader of text as a card draws it: no terminal sequences, however the model wrote it.
const { cardText } = require('./codegraph-card-preview.js');

/** The four tools this card owns, in the order the bridge's `Card activity` line declares them. */
const JOB_TOOLS = Object.freeze(['bash_background', 'monitor', 'job_stop', 'job_list']);

// Each tool's mark, its label, the theme role the heading wears and the role the call's own text
// wears. The two job tools share one mark and one role, so a `monitor` and a `bash_background` read
// as the same family the report card states, while their words say which TOOL ran what the report is
// about. `subtitleRole` is the INPUT the call carries — its label, its command, its job id — which is
// muted on the two bash tools so the role colour stays on the frame and the name, and stays `accent`
// on the two the human did not ask to change.
const IDENTITY = Object.freeze({
  bash_background: { glyph: '⧗', title: 'bash background', titleRole: 'bashMode', subtitleRole: 'muted' },
  monitor: { glyph: '⧗', title: 'bash monitor', titleRole: 'bashMode', subtitleRole: 'muted' },
  job_stop: { glyph: '■', title: 'stop', titleRole: 'warning', subtitleRole: 'accent' },
  job_list: { glyph: '≡', title: 'jobs', titleRole: 'syntaxFunction', subtitleRole: 'accent' },
});

const SUBTITLE_ROLE = 'accent';
const COMMAND_ROLE = 'dim';
const FALLBACK = Object.freeze({ bash_background: 'shell command', monitor: 'shell command', job_stop: 'a background job', job_list: 'this session' });

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
// A model-written string as one plain line: terminal sequences gone, whitespace collapsed.
const oneLine = (value) => (typeof value === 'string' ? cardText(value).replace(/\s+/gu, ' ').trim() : '');

/** The command's lines as drawn: sequences gone, no blank rows around it, trailing space dropped. */
function commandLines(args) {
  const command = asObject(args).command;
  if (typeof command !== 'string') return [];
  const lines = cardText(command).replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * What names one call: a job's label, else the first line of its command; a stop its job id;
 * a listing its own scope. Never the JSON of the arguments.
 */
function jobSubtitle(tool, args) {
  const call = asObject(args);
  if (tool === 'job_stop') return oneLine(call.job_id) || FALLBACK.job_stop;
  if (tool === 'job_list') return FALLBACK.job_list;
  const label = oneLine(call.label);
  if (label !== '') return label;
  const first = commandLines(args).find((line) => line.trim() !== '');
  return first === undefined ? FALLBACK[tool] : oneLine(first);
}

/** The heading one call wears, or undefined for a tool this card does not own. */
function jobCardHeading(tool, args) {
  const identity = IDENTITY[tool];
  if (identity === undefined) return undefined;
  const subtitle = jobSubtitle(tool, args);
  return {
    glyph: identity.glyph,
    title: identity.title,
    titleRole: identity.titleRole,
    subtitle,
    collapsed: subtitle,
    labelBold: true,
    subtitleSegments: [{ text: subtitle, role: identity.subtitleRole ?? SUBTITLE_ROLE }],
  };
}

/**
 * The rows of a call card: the mark and the name of the job, and — expanded — the whole
 * command below it, every line. Plain rows built for one width, rebuilt on every frame.
 */
function jobCallRows(tool, args, context, paint, metrics, width) {
  const ctx = asObject(context);
  const heading = jobCardHeading(tool, args);
  if (heading === undefined) return [];
  const expanded = ctx.expanded === true;
  const pending = ctx.isPartial !== false;
  const failed = ctx.isError === true;
  const tone = cardTone(failed, pending);
  // A running or failed call offers no expand affordance: nothing settled is behind it.
  const hint = pending || failed ? undefined : expandHint(ctx, expanded);
  const card = {
    glyph: heading.glyph,
    title: heading.title,
    subtitle: heading.subtitle,
    subtitleSegments: heading.subtitleSegments,
    labelBold: heading.labelBold,
    tone,
    titleRole: heading.titleRole,
    railRole: heading.titleRole,
  };
  return floatRows(tone, paint, width, (inner) => {
    const head = expanded
      ? cardTopRows(card, paint, inner, hint, metrics)
      : [cardTopLine(card, paint, inner, hint, () => heading.collapsed, metrics)];
    const command = expanded ? commandLines(args) : [];
    const body = [
      ...(command.length > 0 ? cardBodyRows(command, tone, paint, inner, { expanded: true, role: COMMAND_ROLE }, metrics) : []),
      ...(pending && !failed ? [cardRunningLine(tone, paint, inner, metrics)] : []),
    ];
    // The result that follows owns the closing rule; a call still waiting for it closes its own.
    const bottom = cardAwaitingResult(ctx) ? cardBottom(tone, paint, inner, undefined, metrics) : undefined;
    return { head, body, bottom };
  }, card.railRole);
}

/**
 * The call slot. The seams are read on every frame, so a measurement seam that arrives late
 * is used by the next paint rather than never.
 */
function jobCallSlot(tool, seams) {
  return (args, theme, context) => {
    try {
      const ctx = asObject(context);
      const callArgs = args === undefined ? ctx.args : args;
      const paint = themeFor(theme, seams.theme);
      return component((width) => {
        const metrics = seams.metrics();
        return metrics === undefined ? [] : jobCallRows(tool, callArgs, ctx, paint, metrics, width);
      });
    } catch {
      return { render: () => [], invalidate() {} };
    }
  };
}

/**
 * The result slot: the job's own answer — a bounded preview collapsed, everything expanded —
 * under the call, closing the frame the call left open.
 */
function jobResultSlot(tool, seams) {
  return (result, options, theme, context) => {
    try {
      const ctx = asObject(context);
      const args = ctx.args;
      const paint = themeFor(theme, seams.theme);
      const failed = asObject(result).isError === true || optionFlag(options, ctx, 'isError');
      const partial = optionFlag(options, ctx, 'isPartial');
      const identity = IDENTITY[tool] ?? IDENTITY.bash_background;
      return component((width) => {
        const metrics = seams.metrics();
        if (metrics === undefined) return [];
        const expanded = optionFlag(options, ctx, 'expanded');
        const tone = cardTone(failed, partial);
        // One frame: from here on the call above is a heading and this card closes it.
        markCardResult(ctx.state);
        return floatRows(tone, paint, width, (inner) => {
          const rows = fileResultRows({
            text: resultText(result),
            expanded,
            failed,
            content: seams.content(),
            width: cardInnerWidth(inner),
            theme: paint,
          });
          const role = rows.length > 0 ? rows[0].role : undefined;
          const body = rows.length === 0
            ? []
            : cardBodyRows(
              rows.map((row) => row.text),
              tone,
              paint,
              inner,
              expanded ? { expanded: true, role } : { previewRows: PREVIEW_ROWS, role },
              metrics,
            );
          // A streamed result is not finished: the closing rule belongs to the final one.
          const bottom = partial ? undefined : cardBottom(tone, paint, inner, cardElapsed(ctx.durationMs), metrics);
          return { body, bottom, afterHeading: true };
        }, identity.titleRole);
      });
    } catch {
      return { render: () => [], invalidate() {} };
    }
  };
}

module.exports = {
  JOB_TOOLS,
  commandLines,
  jobCallRows,
  jobCallSlot,
  jobCardHeading,
  jobResultSlot,
  jobSubtitle,
};

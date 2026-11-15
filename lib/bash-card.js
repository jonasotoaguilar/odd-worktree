'use strict';
// S2/S5 (T4): the bash activity card — a `bash` tool call drawn as the ACTIVITY its
// own command names, on the same substrate as this package's other cards
// (`lib/shell-card.js`).
//
// The design is the user's own gentle-shell branch (`cards-bash-v2`,
// `extensions/quiet-tools.ts`, read read-only): the heading is the family's mark and
// word (✓ checking, ⌕ exploring, ≋ formatting, ⚒ preparing, ↑ publishing,
// ⎇ versioning, …), or the generic `$ bash` identity when the command names nothing;
// the collapsed detail is the command itself, shortened so a long one does not
// swallow the card; and the body is the output the command printed, bounded while
// collapsed and complete once the reader expands the card. What is NOT ported is that
// branch's per-row reveal meter and its `activity|output` sub-modes (out of scope by
// the task's own slice note): here the toggle is ours-versus-the-host's, expansion is
// the host's `expanded`, and the body is the output.
//
// The identity is never decided here. `inferBashActivity` (lib/bash-activity.js) reads
// the command; this module only dresses its answer with `SHELL_ACTIVITY_IDENTITY`, so
// the heading and the classifier can never disagree and a family added there is drawn
// here with no edit. A command the classifier declines — an unknown program, a chain
// with one segment nothing can name, a hidden substitution — wears the generic
// identity, because a heading is the one part of a collapsed card a reader trusts
// without expanding it.
//
// What the card never decides:
//   * COLOUR. Every cell is a theme role — the family's own `titleRole`, the card
//     tone's frame role, `muted`, `toolOutput`, `error`, `dim` — handed to the
//     injected `theme.fg`. No hex value, no palette, no raw escape sequence is
//     written down here.
//   * MEASUREMENT. The substrate wraps, clips and pads the rows as PLAIN text and
//     paints each one afterwards, so nothing painted is ever measured twice.
//   * STATE. The tone follows the host's own flags (`isPartial`, `isError`), the
//     expanded view is the host's own `expanded`, and the elapsed time is the host's
//     own `durationMs`.
//   * THE TOOL. Nothing is registered, executed or shadowed here: the resolver
//     (lib/bash-card-resolver.js) only chooses renderers, and hands every row it does
//     not own back exactly as the chain resolved it.
//   * THE PREFERENCE. Whether the card is drawn at all is `/card:bash`'s mode, read
//     through the injected `seams.mode()` on EVERY paint: `own` draws this card,
//     `default` forwards the row to the renderers the rest of the chain resolved. A
//     `codegraph …` command is never this card's, in either mode: it belongs to the
//     CodeGraph card, and the question is asked of that module (its own
//     `codegraphShape`) instead of being re-derived here (L5).
//
// Rendering never throws: a theme, a host renderer or an argument that fails draws no
// rows instead of breaking the session's transcript.

const {
  CARD_TONE,
  cardAwaitingResult,
  cardBodyRows,
  cardBottom,
  cardElapsed,
  cardRunningLine,
  cardTopLine,
  cardTopRows,
  floatRows,
  markCardResult,
} = require('./shell-card.js');
const { CARD_BASH_MODE } = require('./card-bash-mode.js');
const { SHELL_ACTIVITY_IDENTITY, inferBashActivity } = require('./bash-activity.js');
const { codegraphShape } = require('./codegraph-card.js');
// `cardText` is the one reader of a tool's text as a card draws it (what it printed,
// without the terminal sequences around it), so this card reuses it rather than
// keeping a second, differently-behaved copy of the same three regexes.
const { cardText } = require('./codegraph-card-preview.js');

/** The shell tool this card draws. `bash` is decided per CALL, never per tool. */
const BASH_TOOL = 'bash';

/**
 * The identity of a command the classifier cannot name: the shell tool's own mark,
 * word and theme role. S2 states it verbatim — `$ bash` — and it is deliberately
 * NEVER a family's mark with a generic word: a reader must be able to tell a named
 * activity from a declined one at a glance.
 */
const BASH_CARD_IDENTITY = { glyph: '$', title: 'bash', titleRole: 'bashMode' };

// The collapsed output budget, in printed rows. The END of an output is what a
// collapsed card states: a summary, a count or the failure is written last.
const PREVIEW_ROWS = 3;
// The role a command's output is painted in — the shell's own tool-output slot, so
// the program's text reads as output and never as chrome — and the one a failure
// keeps instead.
const OUTPUT_ROLE = 'toolOutput';
const ERROR_ROLE = 'error';

// The host keybinding the expand affordance is bound to, and the two verbs the
// heading offers for it. The host paints the hint itself; this module only places it.
const EXPAND_KEYBINDING = 'app.tools.expand';
const EXPAND_TEXT = { collapsed: 'to expand', expanded: 'to collapse' };

// The last lines of an output, and the blank line a trailing newline leaves.
const TRAILING_BLANK = /(?:\n[ \t]*)+$/;

// A component that draws nothing: the answer of every path that cannot draw.
const EMPTY_COMPONENT = { render: () => [], invalidate() {} };
// No injected theme, and a host that passed none: text is drawn plain rather than not at all.
const PLAIN_THEME = { fg: (_role, text) => text };

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/**
 * The tone one call or result is drawn in: the host's own flags decide it — a failure
 * is the error tone, anything still running the warning one, everything else info.
 */
function cardTone(failed, running) {
  if (failed) return CARD_TONE.ERROR;
  return running ? CARD_TONE.WARNING : CARD_TONE.INFO;
}

// ---- the identity ----

/**
 * The heading identity of one classifier answer: the family's mark, word and theme
 * role, or the generic `$ bash` identity for `undefined`. The activity list is never
 * restated here — an unknown value (a family a future classifier adds, a hostile
 * string, an inherited object member) falls back to the generic identity instead of
 * failing the row.
 */
function bashCardIdentity(activity) {
  const identity = own(SHELL_ACTIVITY_IDENTITY, activity);
  if (identity === undefined) return BASH_CARD_IDENTITY;
  return { glyph: identity.glyph, title: activity, titleRole: identity.titleRole };
}

// ---- the collapsed detail ----

/** Plain text clipped to `width` columns with a trailing ellipsis, never a painted row. */
function clipPlain(text, width, metrics) {
  const budget = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (budget === 0) return '';
  if (metrics.visibleWidth(text) <= budget) return text;
  return `${metrics.truncateToWidth(text, Math.max(0, budget - 1), '')}…`;
}

/**
 * The command as a collapsed heading states it, in the room the drawn row leaves:
 * the role of the reference's `bashSummary`, not its code. A leading `cd X &&` chain
 * is setup rather than the work, so the detail names the command it leads to; rows
 * beyond the first are stated as a count instead of swallowing the card; and a
 * command still too wide is clipped with an ellipsis by the caller's own room.
 *
 * The complete command is never lost: expanding the call draws it in full.
 */
function bashCardDetail(command, room, metrics) {
  const text = cardText(typeof command === 'string' ? command : '').replace(/\s+$/, '');
  if (text.length === 0) return '';
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0) return '';
  const line = lines[first] === undefined ? '' : lines[first];
  // `cd /tmp/ws && cd build && pnpm test` is a directory change twice over and then
  // the call itself: only the last segment names work the card can state.
  const action = line.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, '').trim() || line.trim();
  const folded = lines.length - first - 1;
  const suffix = folded > 0 ? ` … +${folded} line${folded === 1 ? '' : 's'}` : '';
  const budget = Math.max(0, (Number.isFinite(room) ? Math.max(0, Math.floor(room)) : 0) - metrics.visibleWidth(suffix));
  return `${clipPlain(action, budget, metrics)}${suffix}`;
}

// ---- what a call is ----

/**
 * Whether this bash call belongs to the CodeGraph card rather than this one. The
 * question is asked of `lib/codegraph-card.js`'s own exported shape predicate — the
 * module that draws that card — so the two cards can never disagree about which
 * program a command ran (L5). A command the module throws on is not claimed by it, so
 * this card's own identity (which reads `codegraph` for the same command) still draws.
 */
function isCodegraphBashCall(args) {
  try {
    return codegraphShape(BASH_TOOL, asObject(args)) !== undefined;
  } catch {
    return false;
  }
}

// ---- the drawing ----

/** The theme a render is painted with: the host's own when it has one, else the injected fallback. */
function themeFor(theme, fallback) {
  if (hasFunction(theme, 'fg')) return theme;
  if (hasFunction(fallback, 'fg')) return fallback;
  return PLAIN_THEME;
}

/** The text of a tool result: the host's `content` parts, or the `{text}` a forwarded result carries. */
function resultText(result) {
  const value = asObject(result);
  if (typeof value.text === 'string') return value.text;
  const parts = Array.isArray(value.content) ? value.content : [];
  return parts
    .map((part) => (typeof asObject(part).text === 'string' ? asObject(part).text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function optionFlag(options, context, key) {
  return asObject(options)[key] === true || asObject(context)[key] === true;
}

/** The right-aligned dim hint the heading offers: the host's own keybinding text for expanding (or collapsing) the card. */
function expandHint(context, expanded) {
  const keyHint = asObject(context).keyHint;
  if (typeof keyHint !== 'function') return undefined;
  try {
    const text = keyHint(EXPAND_KEYBINDING, expanded ? EXPAND_TEXT.expanded : EXPAND_TEXT.collapsed);
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A component whose rows are built again on every paint, so the host's own mode,
 * style and width all apply to the card already on screen — and so `/card:bash` and
 * the style in force are re-read on the next frame instead of at construction.
 * Rendering never throws: a failure draws no rows instead of breaking the transcript.
 */
function component(build) {
  return {
    render(width) {
      try {
        return build(Math.max(0, Math.floor(Number.isFinite(width) ? width : 0)));
      } catch {
        return [];
      }
    },
    invalidate() {
      // Nothing is cached: there is no measurement and no row to invalidate.
    },
  };
}

/** One slot of the host's own drawing, called exactly as the host would have called it. */
function forwardedComponent(inherited, slot, args) {
  try {
    const renderer = asObject(inherited)[slot];
    if (typeof renderer !== 'function') return EMPTY_COMPONENT;
    const drawn = renderer(...args);
    return hasFunction(drawn, 'render') ? drawn : EMPTY_COMPONENT;
  } catch {
    return EMPTY_COMPONENT;
  }
}

/** The renderers the rest of the resolver chain would use for this row, resolved once. */
function inheritedRenderers(next) {
  try {
    return typeof next === 'function' ? next() : undefined;
  } catch {
    return undefined;
  }
}

/** The rows one of the chain's own renderers draws at this width, or none when it cannot draw. */
function forwardedRows(inherited, slot, args, width) {
  const drawn = forwardedComponent(inherited, slot, args);
  try {
    return drawn.render(width);
  } catch {
    return [];
  }
}

/**
 * The rows of a call card: the activity heading over the command. Plain rows, built
 * for one width, so the caller can rebuild them on every frame.
 */
function callRows(args, context, paint, metrics, width) {
  const ctx = asObject(context);
  const command = asObject(args).command;
  // The command is text the card draws and measures, so it is stripped of the terminal
  // sequences a tool argument may carry before anything counts its columns.
  const text = cardText(typeof command === 'string' ? command : '');
  const pending = ctx.isPartial !== false;
  const failed = ctx.isError === true;
  const tone = cardTone(failed, pending);
  const expanded = ctx.expanded === true;
  // A running or failed call offers no expand affordance: there is nothing settled
  // behind it to reveal, exactly as the CodeGraph card decides.
  const hint = pending || failed ? undefined : expandHint(ctx, expanded);
  const identity = bashCardIdentity(inferBashActivity(text));
  const card = { glyph: identity.glyph, title: identity.title, subtitle: text, tone, titleRole: identity.titleRole };
  const detail = text.length === 0 ? undefined : (room) => bashCardDetail(text, room, metrics);
  return floatRows(tone, paint, width, (inner) => {
    // Collapsed, the detail is measured against the room the drawn row actually
    // leaves and ends in an ellipsis; expanded, the whole command continues on the
    // rows below, so a script or a heredoc is never lost behind a truncation.
    const head = expanded
      ? cardTopRows(card, paint, inner, hint, metrics)
      : [cardTopLine(card, paint, inner, hint, detail, metrics)];
    const body = pending && !failed ? [cardRunningLine(tone, paint, inner, metrics)] : [];
    // The result that follows owns the closing rule; a call still waiting for it
    // closes its own frame, so a running row never floats outside one.
    const bottom = cardAwaitingResult(ctx) ? cardBottom(tone, paint, inner, undefined, metrics) : undefined;
    return { head, body, bottom };
  });
}

/**
 * The call slot. Everything it decides is decided INSIDE the component's build, so the
 * host's `render(width)` re-reads it on every frame: the mode `/card:bash` holds, the
 * composition with the CodeGraph card and the measurement seam are all asked for at
 * paint time (L8), never once at construction.
 */
function bashCallSlot(inherited, seams) {
  return (args, theme, context) => {
    try {
      const ctx = asObject(context);
      const callArgs = args === undefined ? ctx.args : args;
      return component((width) => {
        if (seams.mode() !== CARD_BASH_MODE.OWN || isCodegraphBashCall(callArgs)) {
          return forwardedRows(inherited, 'renderCall', [args, theme, context], width);
        }
        const metrics = seams.metrics();
        if (metrics === undefined) return forwardedRows(inherited, 'renderCall', [args, theme, context], width);
        return callRows(callArgs, ctx, themeFor(theme, seams.theme), metrics, width);
      });
    } catch {
      return EMPTY_COMPONENT;
    }
  };
}

/**
 * The rows a result body draws, before the card paints them: the output the command
 * printed, as the host reported it. Undefined is not a case here — an output with no
 * text draws no row at all, because the card states only what the program printed.
 *
 * Collapsed, the rows are the bounded END of the output (a summary, a count or the
 * failure is written last) in the theme's tool-output role, or its error role when
 * the call failed. Expanded, the caller's own ask, every row is drawn.
 */
function bashResultRows(input) {
  const value = asObject(input);
  const failed = value.failed === true;
  const expanded = value.expanded === true;
  const output = cardText(value.text).replace(/\r\n/g, '\n').replace(TRAILING_BLANK, '');
  // Whitespace alone is no output: a blank body row would claim the program printed
  // something the card could state, and a collapsed card's whole value is that it
  // states only what was printed.
  if (output.trim().length === 0) return [];
  const role = failed ? ERROR_ROLE : OUTPUT_ROLE;
  if (expanded) return [{ text: output, role }];
  return [{ text: output.split('\n').slice(-PREVIEW_ROWS).join('\n'), role }];
}

/**
 * The result slot. Like the call slot, it decides nothing at construction: the mode,
 * the composition and the seam are read inside the build, so a card already on screen
 * repaints when any of them changes.
 */
function bashResultSlot(inherited, seams) {
  return (result, options, theme, context) => {
    try {
      const ctx = asObject(context);
      const slotArgs = [result, options, theme, context];
      return component((width) => {
        if (seams.mode() !== CARD_BASH_MODE.OWN || isCodegraphBashCall(ctx.args)) {
          return forwardedRows(inherited, 'renderResult', slotArgs, width);
        }
        const metrics = seams.metrics();
        if (metrics === undefined) return forwardedRows(inherited, 'renderResult', slotArgs, width);
        const paint = themeFor(theme, seams.theme);
        const failed = asObject(result).isError === true || optionFlag(options, ctx, 'isError');
        const partial = optionFlag(options, ctx, 'isPartial');
        const expanded = optionFlag(options, ctx, 'expanded');
        const tone = cardTone(failed, partial);
        const text = resultText(result);
        // One frame: from here on the call above is a heading and this card closes it.
        markCardResult(ctx.state);
        return floatRows(tone, paint, width, (inner) => {
          const rows = bashResultRows({ text, expanded, failed });
          const role = rows.length > 0 ? rows[0].role : undefined;
          const body = role === undefined
            ? []
            : cardBodyRows(
              rows.map((row) => row.text),
              tone,
              paint,
              inner,
              expanded ? { expanded: true, role } : { previewRows: PREVIEW_ROWS, role },
              metrics,
            );
          // A streamed result is not finished: the closing rule (and the time on it)
          // belongs to the final one, which the host renders when the call settles.
          const bottom = partial ? undefined : cardBottom(tone, paint, inner, cardElapsed(ctx.durationMs), metrics);
          // The call above owns the heading, so the float style still sets this body
          // off from it with its separator row.
          return { body, bottom, afterHeading: true };
        });
      });
    } catch {
      return EMPTY_COMPONENT;
    }
  };
}

module.exports = {
  BASH_CARD_IDENTITY,
  BASH_TOOL,
  PREVIEW_ROWS,
  bashCallSlot,
  bashCardDetail,
  bashCardIdentity,
  bashResultRows,
  bashResultSlot,
  inheritedRenderers,
  isCodegraphBashCall,
};

'use strict';
// T3 (S1/S2): the file card — a `read`, `edit` or `write` call whose `path` names a
// customized skill (`…/skills/<name>/SKILL.md`) or an ODD artifact (any file below an
// `odd/tasks/` folder) heads as that file, on the same substrate as this package's
// other cards (`lib/shell-card.js`), exactly as `lib/bash-card.js` heads a `bash` call
// as the activity its own command names.
//
// Ported from the user's gentle-shell PR #3061 (`lib/skill-odd-card.ts` and the
// `read`/`edit`/`write` heading in `extensions/quiet-tools.ts`, read read-only, L3),
// split so classification and drawing never share a decision: `lib/skill-odd-card.js`
// says WHICH card a path wears and which call shape it states (the file's name, the
// range only a read asked for, the Markdown document a read, a write or an edit draws);
// this module only dresses that answer.
//
// What the card never decides:
//   * COLOUR. Every cell is a theme role — the identity's own `titleRole`
//     (`mdHeading` for both identities), the tone's frame role, `muted`, `accent`,
//     `warning`, `text`, `error`, `dim` — handed to the injected `theme.fg`. No hex
//     value, no palette and no raw escape sequence is written down here, and the frame
//     keeps the TONE's role whenever the tone owns the box (invariant 16), so a running
//     or failed call is never painted in an identity colour. The heading states one role
//     per element (S2): glyph and label in the identity's own role, the label
//     additionally bold, the `·` in `muted`, the tool name in `dim`, the path in
//     `accent`, a read's line range in `warning`. The card's whole closed box wears the
//     identity's role too, so the title and the border read as one card.
//   * MEASUREMENT. The substrate wraps, clips and pads the rows as PLAIN text and
//     paints each one afterwards (invariant 17), so nothing painted is ever measured
//     twice. The ODD mark is an emoji two columns wide, and only the injected metrics
//     counts it: this module never hand-counts a glyph. A document body is the one
//     exception, and it is the host's own: Pi's Markdown renderer hands back rows it
//     ALREADY painted, so those rows are placed with the injected ANSI-aware width and
//     never re-painted with a body role of ours (S5).
//   * STATE. The tone follows the host's own flags (`isPartial`, `isError`), the
//     expanded view is the host's own `expanded`, and the elapsed time is the host's
//     own `durationMs`.
//   * THE TOOL. Nothing is registered, executed or shadowed here: the resolver
//     (`lib/file-card-resolver.js`) only chooses renderers for `read`, `edit` and
//     `write`, and hands every row it does not own back exactly as the chain resolved
//     it.
//   * THE SWITCH (S1, read through `lib/card-tools-switch.js`) and the conversation's
//     content level (S2, read through `lib/card-content.js`). Both are read on EVERY
//     paint, inside the component's build, so flipping one repaints a row already on
//     screen (L6).
//
// Rendering never throws: a theme, a host renderer or an argument that fails draws no
// rows instead of breaking the session's transcript.

const {
  CARD_TONE,
  cardAwaitingResult,
  cardBodyRows,
  cardBottom,
  cardElapsed,
  cardInnerWidth,
  cardPaintedLine,
  cardPaintedRows,
  cardRunningLine,
  cardTopLine,
  cardTopRows,
  floatRows,
  markCardResult,
} = require('./shell-card.js');
const { CARD_CONTENT } = require('./card-content.js');
// The document body, drawn by Pi's own Markdown renderer (S3) with one theme role per
// element. Its rows arrive PAINTED, which is what the pre-painted row shape is for.
const { markdownRows } = require('./file-card-markdown.js');
const {
  FILE_CARD_IDENTITY,
  FILE_CARD_TOOLS,
  fileCardIdentity,
  fileCardLineRange,
  fileCardName,
  fileCardSkillPath,
  markdownDocumentSource,
} = require('./skill-odd-card.js');
// `cardText` is the one reader of a tool's text as a card draws it (what it printed,
// without the terminal sequences around it), so this card reuses it rather than
// keeping a second, differently-behaved copy of the same three regexes.
const { cardText } = require('./codegraph-card-preview.js');
// The `Card file` pane's own row builders (T2, S4): a `read` outside skills and ODD draws the SAME
// `N │ code` gutter, divider, plain clip and host highlight the `write` pane draws, so the three
// tools cannot drift apart — one drawing, reused, never a second highlighter.
const { MIN_CODE_COLUMNS, MIN_NUMBER_WIDTH, codeRow, contentLines, highlightLines, languageOf } = require('./diff-design.js');

/** The three tools this card owns, from the one place that states the claim. Nothing else is ever claimed. */
const FILE_TOOLS = FILE_CARD_TOOLS;
const EDIT_TOOL = 'edit';
const READ_TOOL = 'read';
const WRITE_TOOL = 'write';
const BODY_ROLE = 'text';
const ERROR_ROLE = 'error';
// The role a READ's heading wears when its path names no skill and no ODD artifact: the one both
// identities' headings wear, so the card states one family whichever file it heads (S4).
const READ_TITLE_ROLE = 'mdHeading';

// The collapsed preview budget, in printed rows. A document previews from its TOP:
// the first rows are what a reader recognises a file by, unlike a command's output,
// whose summary is written last.
const PREVIEW_ROWS = 3;

// The host keybinding the expand affordance is bound to, and the two verbs the
// heading offers for it. The host paints the hint itself; this module only places it.
const EXPAND_KEYBINDING = 'app.tools.expand';
const EXPAND_TEXT = { collapsed: 'to expand', expanded: 'to collapse' };

// The blank lines a trailing newline leaves at the end of a document.
const TRAILING_BLANK = /(?:\n[ \t]*)+$/;

// The three background roles the host's own outer shell wears, and the one column of
// horizontal padding it defaults to.
const HOST_BOX = Object.freeze({
  PENDING: 'toolPendingBg',
  ERROR: 'toolErrorBg',
  SUCCESS: 'toolSuccessBg',
});
const HOST_BOX_PAD = 1;
// The two shells a tool renderer can declare. The host reads `renderShell ?? 'default'`,
// so anything that is not the literal `self` is the default shell.
const HOST_SHELL = Object.freeze({ DEFAULT: 'default', SELF: 'self' });

// A component that draws nothing: the answer of every path that cannot draw.
const EMPTY_COMPONENT = { render: () => [], invalidate() {} };
// No injected theme, and a host that passed none: text is drawn plain rather than not at all.
const PLAIN_THEME = { fg: (_role, text) => text };

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';

/**
 * The tone one call or result is drawn in: the host's own flags decide it — a failure
 * is the error tone, anything still running the warning one, everything else info.
 */
function cardTone(failed, running) {
  if (failed) return CARD_TONE.ERROR;
  return running ? CARD_TONE.WARNING : CARD_TONE.INFO;
}

// ---- the heading ----

/**
 * The heading one call wears, or undefined when the path names no card identity (then
 * the row is the chain's, untouched).
 *
 * The heading is the identity's mark and label, then the tool, the path and — for a
 * read only — the line range the call asked for (L3). Collapsed, an ODD artifact is
 * named by its file, because its folder is long (`odd/tasks/…`) and the file's own name
 * is what a reader looks for, while a skill is named from its own folder down, because
 * the folders above `skills` say nothing a reader of the workspace does not know.
 * Expanding the call states the whole path in both cases, so nothing is lost.
 *
 * Beside the plain text, the heading states the roles each element wears (S2), because
 * the substrate measures plain text and paints afterwards: `subtitleSegments` is that
 * list, and `subtitle` is exactly its text.
 */
function fileCardHeading(tool, args, expanded) {
  const call = asObject(args);
  const path = typeof call.path === 'string' ? call.path : '';
  const identity = fileCardIdentity(path);
  if (identity === undefined) return undefined;
  const range = fileCardLineRange(tool, args) ?? '';
  const whole = headingSegments(tool, path, range);
  const file = identity.identity === FILE_CARD_IDENTITY.ODD ? fileCardName(path) : fileCardSkillPath(path);
  const named = headingSegments(tool, file, range);
  const segments = expanded === true ? whole : named;
  return {
    identity: identity.identity,
    glyph: identity.glyph,
    title: identity.title,
    titleRole: identity.titleRole,
    subtitle: segmentsText(segments),
    collapsed: segmentsText(named),
    // The label is bolded inside the identity's own role (S2), never the glyph.
    labelBold: true,
    subtitleSegments: segments,
  };
}

/**
 * The heading a READ wears when its path names no skill and no ODD artifact (T2, S1/S2): the tool and
 * the line range the call asked for, in exactly the cell layout the identity heading uses, and
 * nothing that claims an identity it does not have — no `▤ skill`, no `📑 odd`, no mark of theirs.
 * The card's own generic mark and one theme role are what is left. A `write` or an `edit` states no
 * range (only a read asks for one) and has no heading here at all: no other line is this card's.
 */
function plainReadHeading(tool, args) {
  if (tool !== READ_TOOL) return undefined;
  const call = asObject(args);
  const path = typeof call.path === 'string' ? call.path : '';
  const range = fileCardLineRange(tool, args) ?? '';
  const segments = headingSegments('', path, range);
  return {
    identity: undefined,
    title: READ_TOOL,
    titleRole: READ_TITLE_ROLE,
    subtitle: segmentsText(segments),
    collapsed: segmentsText(segments),
    subtitleSegments: segments,
  };
}

/**
 * The heading's detail as the segments it is made of: the tool name in `dim`, a space,
 * the path in `accent` and a read's range in `warning`. The `·` between the label and
 * this detail is the substrate's own `muted` separator, so it is not one of them.
 */
function headingSegments(tool, name, range) {
  const segments = [];
  if (tool !== '') segments.push({ text: tool, role: 'dim' });
  if (name !== '') {
    if (segments.length > 0) segments.push({ text: ' ' });
    segments.push({ text: name, role: 'accent' });
  }
  if (range !== '') segments.push({ text: range, role: 'warning' });
  return segments;
}

/** The plain text a segment list states — what the substrate measures. */
const segmentsText = (segments) => segments.map((segment) => segment.text).join('');

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

/**
 * What a result states as its body. A write states the document its call carried, because
 * its result only reports how many bytes landed. An edit states the fragment its call left
 * behind, which is the same source its Markdown document is drawn from: a host that cannot
 * draw the document falls back to that fragment rather than to the diff, so the card answers
 * one question either way. Every other call states what its result reported, and a FAILED
 * call of any of them still states its error.
 */
function resultBody(tool, args, result, failed, document) {
  if (failed) return fileResultText(tool, result);
  if (tool === WRITE_TOOL) return writtenContent(args);
  if (tool === EDIT_TOOL && document !== undefined) return document;
  return fileResultText(tool, result);
}

/**
 * What one result states as rows: an edit's DIFF (the change the host carries) when the
 * call leaves no Markdown fragment to draw; every other call is the text the result
 * reported — and a write's or an edit's document comes from its call, not from here.
 */
function fileResultText(tool, result) {
  const value = asObject(result);
  if (tool === EDIT_TOOL) {
    const diff = asObject(value.details).diff;
    if (typeof diff === 'string') return diff;
  }
  return resultText(result);
}

/**
 * The document a write's own CALL carries — the file it wrote. The result only reports how
 * many bytes landed, so it is never a write's body (S3): when the host's renderer cannot
 * draw the document, this is the plain source the card falls back to, which is what the
 * baseline showed. A call carrying no content states nothing rather than the byte count.
 */
function writtenContent(args) {
  const content = asObject(args).content;
  return typeof content === 'string' ? content : '';
}

/** The result's text as a card draws it: terminal sequences gone, line endings normalized, trailing blanks dropped. */
function plainText(text) {
  return cardText(text).replace(/\r\n/g, '\n').replace(TRAILING_BLANK, '');
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
 * A component whose rows are built again on every paint, so the host's own width, both
 * switches, the content level and the card style all apply to the card already on
 * screen. Rendering never throws: a failure draws no rows instead of breaking the
 * transcript.
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

// ---- the host's own outer box, for the rows this card hands back ----
//
// `pi.registerToolRenderer` resolvers run per TOOL NAME — the host resolves
// `resolveToolRenderers(toolName, base)` — so a resolver never sees a call's arguments
// and its `renderShell` is fixed for every call of that tool. This package claims
// read/edit/write so it can draw the file card, and it declares `renderShell: 'self'`,
// which REMOVES the host's own shell: right for the rows this card draws (they carry
// their own frame), wrong for the rows it forwards. The host's own `read` and `write`
// renderers are the DEFAULT shell, which the host wraps in `new Box(1, 1, bgFn)` —
// `outputPad` columns of horizontal padding, ONE painted blank row above the call and
// one below the result, all painted `toolPendingBg` while the call streams,
// `toolErrorBg` once its result failed and `toolSuccessBg` otherwise
// (`ToolExecutionComponent`). Without reproducing that box, every ordinary
// read/write row this card hands back would lose the box it has always had — a visual
// regression the request never asked for. So the rows we do not draw are drawn exactly
// as the host would have drawn them, and the `self` shell still applies only to our own
// card.

/**
 * The shell the chain's own renderer draws in, read ONCE at resolver time: only the
 * literal `self` is one, exactly as the host decides (`renderShell ?? 'default'`). A
 * `self` renderer frames itself and the host draws NO box around it — Pi's `edit` is
 * one — so its rows are handed back untouched instead of inside a box the host never
 * draws.
 */
function inheritedShell(inherited) {
  return asObject(inherited).renderShell === HOST_SHELL.SELF ? HOST_SHELL.SELF : HOST_SHELL.DEFAULT;
}

/**
 * The background role the host's own outer box wears for one state, resolved in the
 * host's own order: still streaming, then failed, then success.
 */
function hostBoxRole(context) {
  const ctx = asObject(context);
  if (ctx.isPartial !== false) return HOST_BOX.PENDING;
  if (ctx.isError === true) return HOST_BOX.ERROR;
  return HOST_BOX.SUCCESS;
}

/** The host box's horizontal padding: the render context's own `outputPad`, else one column. */
function hostBoxPad(context) {
  const value = asObject(context).outputPad;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : HOST_BOX_PAD;
}

/** One finished row painted with the host box's background; a theme that cannot paint one keeps the row plain. */
function paintBackground(paint, role, text) {
  try {
    if (!hasFunction(paint, 'bg')) return text;
    const painted = paint.bg(role, text);
    return typeof painted === 'string' ? painted : text;
  } catch {
    return text;
  }
}

/**
 * One row inside the host's box, exactly as `Box.applyBg` draws it: the left pad, the
 * row, the plain fill to the asked width, and then the background painted over the
 * whole padded row. A row wider than the budget keeps every column and loses only the
 * fill; a row this module cannot pad is handed back as the chain drew it.
 */
function hostBoxRow(row, width, pad, role, paint, metrics) {
  const text = typeof row === 'string' ? row : '';
  try {
    const padded = `${' '.repeat(pad)}${text}`;
    const fill = Math.max(0, Math.floor(width) - metrics.visibleWidth(padded));
    return paintBackground(paint, role, padded + ' '.repeat(fill));
  } catch {
    return text;
  }
}

/**
 * The rows of one of the chain's own components, inside the box the host would have
 * wrapped them in — or exactly as drawn, when the chain's renderer frames itself.
 *
 * `layout` says which side of the box this group carries: `leading` (the blank row
 * above the call), `trailing` (the blank row below the result — or below an awaiting
 * call, because the host paints a complete box before the result lands), and the
 * `shell` read once at resolver time. A flag may be a function, so the closing blank
 * is re-decided on every paint.
 *
 * Never throws and never loses content: no measurement seam (so no box this module can
 * size) or a component that fails to render draws nothing at all — the host's own box
 * draws nothing around a child with no rows either.
 *
 * The width of an inherited row is measured with the injected ANSI-aware seam: these
 * rows arrive PAINTED from the host's own renderer, so this is the same one exception
 * invariant 17 grants the host's own key hint — nothing this repo painted is measured
 * here, and only the padded row is painted afterwards.
 */
function hostShellRows(drawn, width, context, paint, seams, layout) {
  try {
    const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
    if (target === 0) return [];
    // A renderer that frames itself is drawn by the host with no box at all: no pad,
    // no blank rows and no background paint.
    if (asObject(layout).shell === HOST_SHELL.SELF) {
      const own = drawn.render(target);
      return Array.isArray(own) ? own : [];
    }
    const metrics = seams.metrics();
    if (metrics === undefined) return drawn.render(target);
    const pad = hostBoxPad(context);
    // The host's own `Box` renders its children at `max(1, width - paddingX * 2)`.
    const rows = drawn.render(Math.max(1, target - pad * 2));
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const role = hostBoxRole(context);
    // The box's own padding rows are `applyBg('', width)`: full-width spaces, painted.
    const blank = paintBackground(paint, role, ' '.repeat(target));
    return [
      ...(asObject(layout).leading === true ? [blank] : []),
      ...rows.map((row) => hostBoxRow(row, target, pad, role, paint, metrics)),
      ...(layoutFlag(layout, 'trailing') ? [blank] : []),
    ];
  } catch {
    return [];
  }
}

/** A layout flag, which the caller may decide per paint (an awaiting call's closing blank). */
function layoutFlag(layout, key) {
  const value = asObject(layout)[key];
  return typeof value === 'function' ? value() === true : value === true;
}

/** A component that draws the chain's own row inside the host's box, rebuilt on every paint. */
function hostShellComponent(drawn, context, paint, seams, layout) {
  return {
    render(width) {
      return hostShellRows(drawn, width, context, paint, seams, layout);
    },
    invalidate() {
      try {
        if (hasFunction(drawn, 'invalidate')) drawn.invalidate();
      } catch {
        // Nothing is cached here, so a component that cannot be invalidated leaves no stale row.
      }
    },
  };
}

// ---- the host's own fallback row, for a tool with no renderer of its own ----
//
// A tool whose DEFINITION exists but which registers neither `renderCall` nor
// `renderResult` is drawn by the host's own fallback (`ToolExecutionComponent`):
// `createCallFallback()` — `formatToolCallWithArgs(toolName, args, theme, expanded)`,
// the bold tool name and the call's own `key=value` arguments — for the call, and
// `createResultFallback()` — the result's text in `toolOutput`, ten rows when the
// reader has not expanded the card, with the host's own expand hint when more is
// withheld — for the result, both inside the box reproduced above. Neither is
// published: the host builds them inside the component, so a row this package hands
// back while its switch is off has to reproduce them, exactly as it reproduces the
// host's box, and for the same reason — the row must be the one Pi would have drawn.
//
// The rows are the host's `Text(text, 0, 0)`: tabs are three spaces, the text is
// wrapped with the injected seam and every row is padded to the width, with no
// background and no padding of its own (the box above paints both).

const HOST_COLLAPSED_ARGS_CHARS = 100;
const HOST_FALLBACK_PREVIEW_ROWS = 10;
/** The blank lines and tab stops the host's own `Text` normalizes before it wraps. */
const HOST_TAB = /\t/g;
const HOST_CARRIAGE_RETURN = /\r/g;

// The host's own readers for a result's text, transcribed from its source: `stripAnsi`
// (`dist/utils/ansi.js`: OSC sequences up to their terminator, and CSI sequences with their
// private prefix, parameters and final byte) and `sanitizeBinaryOutput` (`dist/utils/shell.js`:
// these control characters and U+FFF9–U+FFFB), with `\r` removed afterwards. Reproduced here
// because the host's fallback text is `sanitizeBinaryOutput(stripAnsi(part.text))` and a card
// that read the text differently would not be the row Pi drew — note that the host KEEPS DEL
// (U+007F), which this package's own `cardText` drops.
const HOST_ANSI = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|(?:(?:\u001B\[|\u009B)[<=>]|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?)[\dA-PR-TZcf-nq-uy=><~]/g;
const HOST_BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFF9-\uFFFB]/g;

/** One string as the host reads it: terminal sequences and binary controls gone, `\r` removed. */
function hostText(value) {
  const text = typeof value === 'string' ? value : '';
  const stripped = text.includes('\u001B') || text.includes('\u009B') ? text.replace(HOST_ANSI, '') : text;
  return stripped.replace(HOST_BINARY, '').replace(HOST_CARRIAGE_RETURN, '');
}

/** The host's bold, when the theme has one: a theme without it states the same text, unbolded. */
function boldText(paint, text) {
  if (!hasFunction(paint, 'bold')) return text;
  try {
    const bold = paint.bold(text);
    return typeof bold === 'string' ? bold : text;
  } catch {
    return text;
  }
}

/**
 * The host's `formatToolCallWithArgs`, reproduced: the tool's own name in `toolTitle`,
 * then the call's arguments as `key=value` pairs on the same row — or, expanded, one
 * `key: value` row each, continuation lines indented under it.
 */
function hostCallFallbackText(tool, args, paint, expanded) {
  const header = paint.fg('toolTitle', boldText(paint, typeof tool === 'string' ? tool : ''));
  if (args === null || args === undefined) return header;
  const entries = typeof args === 'object' && !Array.isArray(args) ? Object.entries(args) : [['args', args]];
  if (entries.length === 0) return header;
  if (expanded === true) {
    const lines = entries.map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
      return `  ${key}: ${text.replace(HOST_TAB, '   ').replace(HOST_CARRIAGE_RETURN, '').split('\n').join('\n    ')}`;
    });
    return `${header}\n${paint.fg('muted', lines.join('\n'))}`;
  }
  const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(' ');
  const preview = pairs.length > HOST_COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, HOST_COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
  return `${header} ${paint.fg('muted', preview)}`;
}

/**
 * The result's text as the host reads it: its `text` parts, terminal sequences and binary
 * controls gone (`hostText`: the host's own `sanitizeBinaryOutput(stripAnsi(...))`), joined by
 * one newline. Every other part (an image) contributes no row of its own, and a result that
 * states nothing states nothing.
 */
function hostResultOutput(result) {
  const value = asObject(result);
  if (typeof value.text === 'string') return hostText(value.text);
  const parts = Array.isArray(value.content) ? value.content : [];
  return parts
    .filter((part) => asObject(part).type === 'text')
    .map((part) => hostText(asObject(part).text))
    .join('\n');
}

/**
 * The host's `createResultFallback`, reproduced — or `undefined` for a result that
 * states nothing, which the host draws as no result row at all.
 */
function hostResultFallbackText(result, paint, context) {
  const ctx = asObject(context);
  const output = hostResultOutput(result);
  if (output.length === 0) return undefined;
  const lines = output.split('\n');
  const shown = ctx.expanded === true ? lines : lines.slice(0, HOST_FALLBACK_PREVIEW_ROWS);
  const remaining = lines.length - shown.length;
  const text = shown.map((line) => paint.fg('toolOutput', line)).join('\n');
  if (remaining <= 0) return text;
  const hint = expandHint(ctx, false) ?? EXPAND_TEXT.collapsed;
  return `${text}${paint.fg('muted', `\n... (${remaining} more lines,`)} ${hint}${paint.fg('muted', ')')}`;
}

/**
 * A host `Text(text, 0, 0)` component: tabs are three spaces, the text is wrapped
 * with the injected seam and every row is padded to the width. A text that states
 * nothing draws no row — and so no box around it, exactly as the host's own does.
 */
function hostTextComponent(text, seams) {
  return {
    render(width) {
      try {
        const value = typeof text === 'string' ? text : '';
        if (value.trim() === '') return [];
        const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
        const normalized = value.replace(HOST_TAB, '   ');
        const metrics = seams.metrics();
        // No seam, no measurement: the rows are stated unwrapped rather than not at all.
        if (metrics === undefined) return normalized.split('\n');
        const wrapped = metrics.wrapTextWithAnsi(normalized, Math.max(1, target));
        const rows = Array.isArray(wrapped) ? wrapped : [];
        return rows.map((row) => `${row}${' '.repeat(Math.max(0, target - metrics.visibleWidth(row)))}`);
      } catch {
        return [];
      }
    },
    invalidate() {
      // Nothing is cached: there is no measurement and no row to invalidate.
    },
  };
}

/**
 * The host's own drawing for ONE half of a card whose tool has no renderer of its
 * own: its fallback text, inside the shell the tool's definition declares — the box
 * reproduced above for a default shell, untouched rows for one that frames itself.
 *
 * `input` is `{ slot, tool, args, result, width, context, paint, seams, shell }`:
 * `slot` is `'call'` or `'result'`, and `args`/`result` are that half's own input.
 * The call carries the box's leading blank row and closes the box while no result
 * follows it; the result carries the closing blank (the host draws one box around
 * both halves, and this is that box, split between the two slots the host asks for).
 * A result that states nothing is no result row at all — the host draws no child for
 * it — and the closing blank is then the one row that half still owes the box.
 */
function hostFallbackRows(input) {
  const value = asObject(input);
  const ctx = asObject(value.context);
  const shell = value.shell === HOST_SHELL.SELF ? HOST_SHELL.SELF : HOST_SHELL.DEFAULT;
  const result = value.slot === 'result';
  const text = result
    ? hostResultFallbackText(value.result, value.paint, ctx)
    : hostCallFallbackText(value.tool, value.args, value.paint, ctx.expanded === true);
  if (typeof text !== 'string') {
    return result && shell !== HOST_SHELL.SELF ? hostBoxBlankRow(value.width, ctx, value.paint) : [];
  }
  const layout = result
    ? { shell, leading: false, trailing: true }
    : { shell, leading: true, trailing: () => cardAwaitingResult(ctx) };
  return hostShellRows(hostTextComponent(text, value.seams), value.width, ctx, value.paint, value.seams, layout);
}

/** The host box's own padding row: full-width spaces, painted in the box's background role. */
function hostBoxBlankRow(width, context, paint) {
  const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  if (target === 0) return [];
  return [paintBackground(paint, hostBoxRole(context), ' '.repeat(target))];
}

/**
 * The rows of a call card: the identity's heading over the file's own call line. Plain
 * rows, built for one width, so the caller can rebuild them on every frame.
 *
 * `detail` is what the collapsed row states and `subtitle` what the expanded one does,
 * which is how an ODD call names its file while collapsed and its whole path once the
 * reader opens it.
 */
function fileCallRows(tool, args, context, paint, metrics, width) {
  const ctx = asObject(context);
  const expanded = ctx.expanded === true;
  // A plain read (T2, S1) heads with the generic heading; every other call this card draws has an
  // identity, and a call with neither is never asked for here.
  const heading = fileCardHeading(tool, args, expanded) ?? plainReadHeading(tool, args);
  if (heading === undefined) return [];
  const pending = ctx.isPartial !== false;
  const failed = ctx.isError === true;
  const tone = cardTone(failed, pending);
  // A running or failed call offers no expand affordance: there is nothing settled
  // behind it to reveal, exactly as the bash and CodeGraph cards decide.
  const hint = pending || failed ? undefined : expandHint(ctx, expanded);
  const card = {
    glyph: heading.glyph,
    title: heading.title,
    subtitle: heading.subtitle,
    subtitleSegments: heading.subtitleSegments,
    labelBold: heading.labelBold,
    tone,
    titleRole: heading.titleRole,
    // The identity's role around the whole closed box, not only its label: the corners,
    // the rules and the sides of an idle card are the same colour as its title. The tone
    // still speaks first (`TONE_OWNS_BOX`), so a running or failed call keeps its own.
    railRole: heading.titleRole,
  };
  return floatRows(tone, paint, width, (inner) => {
    // Collapsed, the heading is one row and a detail too wide ends in an ellipsis;
    // expanded, the whole path continues on the rows below, so a deep path is never
    // lost behind a truncation.
    const head = expanded
      ? cardTopRows(card, paint, inner, hint, metrics)
      : [cardTopLine(card, paint, inner, hint, () => heading.collapsed, metrics)];
    const body = pending && !failed ? [cardRunningLine(tone, paint, inner, metrics)] : [];
    // The result that follows owns the closing rule; a call still waiting for it
    // closes its own frame, so a running row never floats outside one.
    const bottom = cardAwaitingResult(ctx) ? cardBottom(tone, paint, inner, undefined, metrics) : undefined;
    return { head, body, bottom };
  }, card.railRole);
}

/**
 * The first line number a read's body is numbered from (T2, S1): the line the call asked for — its
 * `offset` is the count of lines it skipped, so the first line it read is the next one — and line 1
 * when it asked for none. A malformed offset numbers from the top rather than guessing.
 */
function readStartLine(args) {
  // `offset` IS the first line the call asked for, the same reading `fileCardLineRange` states in
  // the heading (`:9-13` is lines 9 to 13), so the body's first number is `offset` itself.
  const offset = asObject(args).offset;
  return typeof offset === 'number' && Number.isInteger(offset) && offset >= 1 ? offset : 1;
}

/**
 * A read's body as the pane a `write` draws (T2, S3/S6): one row per line of the file behind the
 * same `N │ code` gutter, the code in the host's own highlight for the language `path` names, and a
 * line too long for the row cut with the pane's `…` — measured as PLAIN text before it is painted
 * (invariant 17), by the very builders the `write` pane uses. `undefined` when there is nothing to
 * draw, or when the width cannot hold even the gutter, so the plain body answers instead of a
 * broken layout.
 *
 * `options` is `{ start, language, seam }`: the first line number, the language the path names and
 * the highlighter seam. A seam that is absent, throws or waters the text down is no highlight, and
 * the code is drawn in the theme's `text` role exactly as the pane draws it then.
 *
 * The collapsed budget is THIS card's (`PREVIEW_ROWS`), not the write pane's ten rows: a read has
 * always previewed its first rows and `ctrl+o` still reveals the rest (L10).
 */
function readPaneRows(text, options, width, theme) {
  const lines = contentLines(plainText(text));
  if (lines.length === 0) return undefined;
  const settings = asObject(options);
  const start = Number.isInteger(settings.start) && settings.start >= 1 ? settings.start : 1;
  const numberWidth = Math.max(MIN_NUMBER_WIDTH, String(start + lines.length - 1).length);
  if (width < numberWidth + 3 + MIN_CODE_COLUMNS) return undefined;
  const shown = settings.expanded === true ? lines.length : Math.min(lines.length, PREVIEW_ROWS);
  const highlighted = highlightLines(lines.join('\n'), settings.language, settings.seam);
  const rows = [];
  for (let index = 0; index < shown; index += 1) {
    rows.push(codeRow({
      number: start + index,
      numberWidth,
      code: lines[index],
      painted: highlighted === undefined ? undefined : highlighted[index],
      width,
      theme,
    }));
  }
  return rows;
}

/**
 * The rows a result body draws, before the card paints them.
 *
 * `content` is the level in force: `minimal` draws the call alone — with no body until
 * the reader expands it — and `default` the bounded preview. A failure still says why
 * at either level, because a card that hid the reason would report a call that failed
 * as one that did nothing.
 *
 * A document is drawn by Pi's own Markdown renderer (S3) and arrives as rows it already
 * painted, in the theme roles the substrate must not paint over (S5); the preview is
 * the first `PREVIEW_ROWS` of exactly those rows (S4). When the renderer yields nothing
 * — no TUI package, a theme it cannot paint, a document it refuses — the source is the
 * card's answer, wrapped and unstyled by the plain path below.
 */
function fileResultRows(input) {
  const value = asObject(input);
  const failed = value.failed === true;
  const expanded = value.expanded === true;
  if (value.content === CARD_CONTENT.MINIMAL && !expanded && !failed) return [];
  const role = failed ? ERROR_ROLE : BODY_ROLE;
  const markdown = typeof value.markdown === 'string' ? value.markdown : undefined;
  // A host with no renderer of its own draws no document: the plain path below answers.
  if (markdown !== undefined && typeof value.markdownClass === 'function') {
    const painted = markdownRows(markdown, value.theme, value.width, value.markdownClass);
    if (painted.length > 0) return [{ painted }];
  }
  // A read outside skills and ODD is the pane (T2, S3): its rows arrive painted AND measured to the
  // card's inner width, so the card places them as they are — no re-wrap, which would reflow a row
  // that already fits and lose the gutter's alignment.
  if (value.pane !== undefined) {
    const pane = readPaneRows(value.text, { ...asObject(value.pane), expanded }, value.width, value.theme);
    if (pane !== undefined) return [{ pane }];
  }
  const text = plainText(value.text);
  // Whitespace alone states nothing: a blank body row would claim the file had content
  // the card could show.
  if (text.trim().length === 0) return [];
  const shown = expanded ? text : text.split('\n').slice(0, PREVIEW_ROWS).join('\n');
  return [{ text: shown, role }];
}

/**
 * The call slot. The identity and the ONE switch are both decided INSIDE the
 * component's build, so the host's `render(width)` re-reads them on every frame: a card
 * already on screen repaints when the shell API's `Card activity` line changes (L6), and the
 * measurement seam is asked for at paint time rather than at construction.
 *
 * A path that names neither identity is no card of this one for a `write` or an `edit`, and the
 * chain's own component comes straight back; a READ is the exception (T2, S1) and asks the shell
 * API's `Card file` line on every frame, because that line is what chooses who draws it.
 */
function fileCallSlot(tool, inherited, seams, shell) {
  return (args, theme, context) => {
    try {
      const ctx = asObject(context);
      const callArgs = args === undefined ? ctx.args : args;
      const identity = fileCardIdentity(asObject(callArgs).path);
      const paint = themeFor(theme, seams.theme);
      // The host's box opens above the call, and closes below the call while it still
      // awaits its result: the host paints a complete box before the result lands, and
      // the result then supplies the same closing blank in its place.
      const layout = { shell, leading: true, trailing: () => cardAwaitingResult(ctx) || ctx.isPartial !== false };
      // The chain's own component, resolved ONCE per slot exactly as it always was: the gate is asked
      // per paint below, but the row it falls back to never changes.
      const hostCall = forwardedComponent(inherited, 'renderCall', [args, theme, context]);
      const forward = (width) => hostShellRows(hostCall, width, ctx, paint, seams, layout);
      // T2 (S1/S2): a READ whose path names no skill and no ODD artifact is this card's while the
      // shell API's `Card file` line is set to `color` — the line supplies that read's selection,
      // asked inside the build on every frame, so a mid-session switch repaints the row already on
      // screen. A write or an edit with no identity is still the chain's own row, as it always was.
      const plainRead = identity === undefined && tool === READ_TOOL;
      if (identity === undefined && !plainRead) return hostShellComponent(hostCall, ctx, paint, seams, layout);
      return component((width) => {
        // S4: the call's own arguments travel with the question, so a SCOPE on the
        // shell API's line (`write` and `edit`, paths under `skills/` or `odd/`) can answer
        // for THIS call and no other.
        if (!(plainRead ? seams.fileSelected(callArgs) : seams.enabled(tool, callArgs))) return forward(width);
        const metrics = seams.metrics();
        if (metrics === undefined) return forward(width);
        return fileCallRows(tool, callArgs, ctx, paint, metrics, width);
      });
    } catch {
      return EMPTY_COMPONENT;
    }
  };
}

/**
 * The result slot. Like the call slot it decides nothing at construction: the switch,
 * the level and the seam are read inside the build, so a card already on screen
 * repaints when either changes.
 */
function fileResultSlot(tool, inherited, seams, shell) {
  return (result, options, theme, context) => {
    try {
      const ctx = asObject(context);
      const slotArgs = [result, options, theme, context];
      const args = ctx.args;
      const identity = fileCardIdentity(asObject(args).path);
      const paint = themeFor(theme, seams.theme);
      // The state the host's box is painted in, decided once per render exactly as the
      // host decides its own background: still streaming, then failed, then success.
      const failed = asObject(result).isError === true || optionFlag(options, ctx, 'isError');
      const partial = optionFlag(options, ctx, 'isPartial');
      const boxContext = { ...ctx, isPartial: partial, isError: failed };
      // The box's closing blank belongs to the result, which follows the call above it.
      const layout = { shell, leading: false, trailing: true };
      // T2 (S1/S2): a READ with no skill or ODD identity is this card's while `Card file` is `color`,
      // and every other identity-less call is still the chain's own row.
      const plainRead = identity === undefined && tool === READ_TOOL;
      // The chain's own component, resolved ONCE per slot exactly as it always was.
      const hostResult = forwardedComponent(inherited, 'renderResult', slotArgs);
      if (identity === undefined && !plainRead) return hostShellComponent(hostResult, boxContext, paint, seams, layout);
      return component((width) => {
        const forward = () => hostShellRows(hostResult, width, boxContext, paint, seams, layout);
        // S4: the result half asks the same question of the same call, with the arguments
        // it holds (`ctx.args`), so both halves of one card are resolved against the same
        // call and no half is asked a different question.
        if (!(plainRead ? seams.fileSelected(args) : seams.enabled(tool, args))) return forward();
        const metrics = seams.metrics();
        if (metrics === undefined) return forward();
        const expanded = optionFlag(options, ctx, 'expanded');
        const tone = cardTone(failed, partial);
        // A write states the document its call carried; its result says how many bytes
        // landed, which is no body at all. An edit states the fragment its call left, and
        // its diff is the body only when that fragment is nothing. A plain read is no
        // document at all (S3): its path names a language, never a Markdown render.
        const document = plainRead ? undefined : markdownDocumentSource(tool, args, resultText(result), { expanded: true, isError: failed });
        const text = resultBody(tool, args, result, failed, document);
        // T2 (S3/S6): the read body is the write pane's, built from what the call read, in the
        // language its path names, through the same highlighter seam `/files` and the pane use.
        const agent = plainRead && !failed ? seams.agent() : undefined;
        const pane = agent === undefined
          ? undefined
          : { start: readStartLine(args), language: languageOf(asObject(args).path, agent), seam: agent };
        // One frame: from here on the call above is a heading and this card closes it. The whole
        // closed box wears the heading's own role — the identity's, or, for a plain read (T2/S1), the
        // one both identity headings wear.
        markCardResult(ctx.state);
        return floatRows(tone, paint, width, (inner) => {
          // The level is asked for on every paint, so a preference switched on screen
          // repaints the rows it decides.
          const rows = fileResultRows({
            text,
            // A read draws the text it read, a write the content its call carries and an
            // edit the fragment it leaves; the rows of the three are the diff or the
            // result only when there is no document. The document is asked for whatever
            // the expansion — the collapsed card shows its first rows (S4), the expanded
            // one the whole of it.
            markdown: document,
            pane,
            expanded,
            failed,
            content: seams.content(),
            width: cardInnerWidth(inner),
            theme: paint,
            markdownClass: seams.markdownClass(),
          });
          const painted = rows.length > 0 && Array.isArray(rows[0].painted);
          const panes = rows.length > 0 && Array.isArray(rows[0].pane) ? rows[0].pane : undefined;
          const role = rows.length > 0 ? rows[0].role : undefined;
          // The document's own rows are placed as they were painted (S5): measured with
          // the ANSI-aware seam and never handed the body role again. The pane's rows are placed the
          // same way and are NOT wrapped again — they are already the frame's inner width.
          const body = rows.length === 0
            ? []
            : panes !== undefined
              ? panes.map((row) => cardPaintedLine(row, tone, paint, inner, metrics))
              : painted
                ? cardPaintedRows(rows[0].painted, tone, paint, inner, expanded ? { expanded: true } : { previewRows: PREVIEW_ROWS }, metrics)
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
        }, plainRead ? READ_TITLE_ROLE : identity.titleRole);
      });
    } catch {
      return EMPTY_COMPONENT;
    }
  };
}

module.exports = {
  FILE_TOOLS,
  PREVIEW_ROWS,
  // The drawing helpers the jobs card (`lib/jobs-card.js`) shares, so the two cards can never
  // disagree about a tone, a hint, a theme fallback or how a result's text is read.
  cardTone,
  component,
  expandHint,
  optionFlag,
  resultText,
  themeFor,
  fileCallRows,
  fileCallSlot,
  fileCardHeading,
  fileResultRows,
  fileResultSlot,
  fileResultText,
  // The host's own drawing, for the halves this package hands back while its switch is
  // off: the box it wraps a default-shell row in, and the fallback text it draws for a
  // tool with no renderer of its own (`lib/jobs-card.js`, `lib/codegraph-card.js`).
  hostCallFallbackText,
  hostFallbackRows,
  hostResultFallbackText,
  hostShellRows,
  hostTextComponent,
  inheritedRenderers,
  inheritedShell,
};

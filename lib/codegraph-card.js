'use strict';
// S10: the CodeGraph card — one identity for the three shapes a session reaches
// CodeGraph through: the native `codegraph` tool, the MCP
// `mcp__codegraph__codegraph_explore` tool, and a `bash` call whose command runs
// the same program (`codegraph init`, `sync`, `query …`, `explore …`).
//
// The design is the user's own PR #74 (`jonasotoaguilar/gentle-shell`, branch
// `cards-bash-v2`, copied read-only under `odd/reference/pr74-card/`): the
// CodeGraph mark and its title role, the operation (with the query it named) as
// the heading detail, one collapsed row that states only what the program printed,
// and the whole CLI output once the reader expands the card. What this module adds
// is the surface (the MCP explore tool) and the drawing: the card is composed here
// and painted by this package's own substrate (`lib/shell-card.js`), in the shell's
// two styles, from the shell's theme roles.
//
// What the card never decides:
//   * COLOUR. Every cell is a theme role (`titleRole`, `border`, `warning`, `error`,
//     `muted`, `toolOutput`, `text`) handed to the injected `theme.fg`; no hex
//     value, no palette and no raw escape sequence is written down here.
//   * MEASUREMENT. The substrate wraps, clips and pads the rows as PLAIN text and
//     paints each one afterwards, so nothing painted is ever measured twice.
//   * STATE. The tone follows the host's own flags (`isPartial`, `isError`), the
//     expanded view is the host's own `expanded`, and the elapsed time is the
//     host's own `durationMs`.
//   * THE TOOL. Nothing is registered, executed or shadowed: the resolver only
//     chooses renderers. `createCodegraphCardResolver` registers through the
//     host's `registerToolRenderer` hook and returns EVERY tool it does not own
//     exactly as the rest of the chain resolved it, so no load order and no other
//     extension's drawing depends on this package (S1).
//   * THE CONTENT LEVEL. It is read at paint time from the injected reader, whose
//     default is the process-wide slot gentle-pi publishes
//     (`Symbol.for("gentle-pi.card-content")`). A level switched while the
//     transcript is on screen therefore repaints the card already on screen, with
//     no rebuild.
//
// Rendering never throws: a theme, a host renderer or an argument that fails draws
// no rows instead of breaking the session's transcript.

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
// The conversation card content level is one reader for every card of this package
// (lib/card-content.js): the process-wide slot gentle-pi publishes, read at paint
// time. It is re-exported below so the callers of this module keep their imports.
const { CARD_CONTENT, CARD_CONTENT_SLOT, cardContentLevel } = require('./card-content.js');
// S11 (modular-tools): this card is a DESIGN, so its switch is the `Card tags` line the
// activity design owns — the same reader the file cards and the jobs card ask, never a
// module switch of its own. It is asked on every paint and answered for this package's
// own design id, so `native` (and every other answer) hands the rows back untouched.
const { ACTIVITY_DESIGN_ID, bridgeApi } = require('./file-card-resolver.js');
const {
  CODEGRAPH_MARK,
  CODEGRAPH_MCP_TOOL,
  CODEGRAPH_TITLE_ROLE,
  CODEGRAPH_TOOL,
  cardText,
  codeGraphCollapsedRows,
  codeGraphInitRows,
  codeGraphPreview,
  codeGraphWholeOutput,
  codegraphCallDetail,
  codegraphCallFromCommand,
  projectPathSegment,
} = require('./codegraph-card-preview.js');

// The MCP tool arrives as its bare name or as the prefixed form the host reports.
// Both are the same program, so both wear the same card; no other prefixed name is
// claimed, because a server this package does not know is not this card's (S1).
const CODEGRAPH_MCP_PREFIXED_TOOL = 'mcp__codegraph__codegraph_explore';
// The shell tool a CodeGraph command can be run through. `bash` is decided per CALL,
// never per tool: a command that is not CodeGraph keeps the host's own card.
const BASH_TOOL = 'bash';
const SUBTITLE_ROLE = 'muted';
// The role a card body keeps when the reader expanded it: the shell's own tool
// output slot, so the program's text reads as output and never as chrome.
const OUTPUT_ROLE = 'toolOutput';
const ERROR_ROLE = 'error';

// The host keybinding the expand affordance is bound to, and the two verbs the
// heading offers for it.
const EXPAND_KEYBINDING = 'app.tools.expand';
const EXPAND_TEXT = { collapsed: 'to expand', expanded: 'to collapse' };

/** The conversation card content level gentle-pi keeps for the whole process. */
// `CARD_CONTENT`, `CARD_CONTENT_SLOT` and `cardContentLevel` are the shared reader's
// (lib/card-content.js): the level is read on every paint, so a level switched while
// the transcript is on screen repaints the card already there.

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';

/** A component that draws nothing: the answer of every path that cannot draw. */
const EMPTY_COMPONENT = { render: () => [], invalidate() {} };
/** No injected theme, and a host that passed none: text is drawn plain rather than not at all. */
const PLAIN_THEME = { fg: (_role, text) => text };

function assertMetrics(value) {
  if (!hasFunction(value, METRICS_FUNCTIONS[0])) {
    throw new TypeError('createCodegraphCardResolver requires an injected metrics object ({visibleWidth, truncateToWidth, wrapTextWithAnsi})');
  }
  for (const name of METRICS_FUNCTIONS) {
    if (!hasFunction(value, name)) throw new TypeError(`createCodegraphCardResolver requires metrics.${name} to be a function`);
  }
  return value;
}

/**
 * The measurement seam a caller injected, validated once at construction: the
 * object itself, or a function the factory calls on every paint (the host's TUI
 * package is resolved inside the hook, never at load).
 */
function metricsSeam(value) {
  if (typeof value === 'function') return value;
  assertMetrics(value);
  return () => value;
}

/** The cwd seam: a string or a function asked on every paint, and no answer is undefined. */
function cwdSeam(value) {
  return () => {
    try {
      const cwd = typeof value === 'function' ? value() : value;
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Whether a value is a usable text-measurement seam. */
function usableMetrics(value) {
  return METRICS_FUNCTIONS.every((name) => hasFunction(value, name)) ? value : undefined;
}

// ---- the content level ----

// `cardContentLevel(host)` is re-exported from lib/card-content.js: the level in
// force is `minimal` (a card drawn with no result rows until it is expanded) or
// `default` (the bounded preview), and the host without gentle-shell leaves it
// unset, which is the safe `default`.

// ---- which call is a CodeGraph call ----

function stringArg(args, key) {
  const value = asObject(args)[key];
  return typeof value === 'string' && value.length > 0 ? cardText(value) : undefined;
}

/** The command text with its leading program word removed, so a heading that names the program does not say it twice. */
function withoutLeadingProgram(text, program) {
  if (text === program) return '';
  const head = `${program} `;
  return text.startsWith(head) ? text.slice(head.length).trimStart() : text;
}

/**
 * The CodeGraph call a tool call makes, or undefined when it makes none: an
 * unrelated tool, or a `bash` command that runs something else. That undefined is
 * what keeps every ordinary shell card byte-identical to the one the host drew.
 */
function codegraphShape(toolName, args, cwd) {
  if (typeof toolName !== 'string') return undefined;
  if (toolName === CODEGRAPH_TOOL) {
    const operation = stringArg(args, 'operation');
    const query = stringArg(args, 'query');
    // Until the call's arguments stream in the operation is not known: the card
    // says so rather than guessing one.
    return { surface: 'tool', operation: operation === undefined ? '...' : operation, ...(query === undefined ? {} : { query }) };
  }
  if (toolName === CODEGRAPH_MCP_TOOL || toolName === CODEGRAPH_MCP_PREFIXED_TOOL) {
    const query = stringArg(args, 'query');
    // The explored checkout is named only when it is not this session's own (S6); a
    // cwd the seam cannot answer still shows the caller's explicit argument.
    const project = projectPathSegment(asObject(args).projectPath, cwd);
    return { surface: 'mcp', operation: 'explore', ...(query === undefined ? {} : { query }), ...(project === undefined ? {} : { project }) };
  }
  if (toolName !== BASH_TOOL) return undefined;
  const command = asObject(args).command;
  const call = codegraphCallFromCommand(command);
  // The command itself is the card's detail, so a bash call that runs the program is
  // this card's whatever the operation it names, and a command that only mentions it
  // stays the host's own row.
  return call === undefined ? undefined : { surface: 'bash', command: cardText(command), ...call };
}

/** Whether this tool's drawing belongs to the card. `bash` is decided per call, not per tool. */
function isCodeGraphCardTool(toolName) {
  return toolName === CODEGRAPH_TOOL || toolName === CODEGRAPH_MCP_TOOL || toolName === CODEGRAPH_MCP_PREFIXED_TOOL;
}

/**
 * S11 (modular-tools): whether the activity design draws this call right now. The bridge's
 * `Card tags` line is the card's ONLY switch, read through its published reader and never a
 * store path: the answer must be a `design` carrying this package's activity id, so `native`,
 * `not-covered`, `missing`, another plugin's design, an absent reader and a reader that throws
 * all leave the chain's own drawing exactly as it resolved it. The line's claim on these
 * tools is unscoped, so the question travels without a call's arguments.
 */
function activityDesignDraws(tool, args) {
  try {
    const api = bridgeApi();
    if (api === undefined || typeof api.resolveToolDesignSelection !== 'function') return false;
    const answer = asObject(api.resolveToolDesignSelection(tool, args));
    if (answer.kind !== 'design') return false;
    const design = asObject(answer.design);
    return typeof design.id === 'string' && design.id === ACTIVITY_DESIGN_ID;
  } catch {
    return false;
  }
}

// ---- the rows ----

/**
 * The heading both the tool rows and the card use: the CodeGraph mark and name, and
 * its detail — the operation and the query the native and MCP tools named, or the
 * command a `bash` call ran. The same heading on all three surfaces, so the tool the
 * model reached and the shell it ran read as one card.
 *
 * The whole box wears the CodeGraph role too (`railRole`): the card's corners, rules
 * and rail are painted in it, so the box reads as part of the label it belongs to.
 * The substrate keeps the call's own status tone on the box while the call is
 * running or has failed, so an identity colour never hides a pending call.
 */
function codegraphCallIdent(shape) {
  const call = asObject(shape);
  const operation = typeof call.operation === 'string' && call.operation.length > 0 ? call.operation : '...';
  const query = typeof call.query === 'string' && call.query.length > 0 ? call.query : undefined;
  const command = typeof call.command === 'string' ? call.command : '';
  // A bash call names the input after the program word: the heading already says
  // `codegraph`, so `codegraph status .` reads `· status .` (S5). Only a LEADING
  // program word goes, exactly as the bash activity card's own detail does, so a
  // launcher or a `cd X &&` chain keeps its text.
  const detail = command.length > 0 ? withoutLeadingProgram(command, CODEGRAPH_TOOL) : '';
  const project = typeof call.project === 'string' && call.project.length > 0 ? call.project : undefined;
  const base = command.length > 0
    ? detail
    : codegraphCallDetail({ operation, ...(query === undefined ? {} : { query }) });
  const subtitle = project === undefined
    ? (base.length > 0 ? base : undefined)
    : (base.length > 0 ? `${base} · ${project}` : project);
  return {
    glyph: CODEGRAPH_MARK,
    title: CODEGRAPH_TOOL,
    subtitle,
    titleRole: CODEGRAPH_TITLE_ROLE,
    railRole: CODEGRAPH_TITLE_ROLE,
  };
}

/**
 * The heading rows: the identity, then the call's detail. Plain text plus the theme
 * role that paints it — the card itself paints these same two values through the
 * substrate's top rule, which is what `codegraphCallIdent` holds for both.
 */
function codegraphCallRows(shape) {
  const ident = codegraphCallIdent(shape);
  return [
    { text: `${ident.glyph} ${ident.title}`, role: CODEGRAPH_TITLE_ROLE },
    { text: ident.subtitle, role: SUBTITLE_ROLE },
  ];
}

/** Everything the result rows are decided from. */
function codegraphResultRows(input) {
  const value = asObject(input);
  const shape = asObject(value.shape);
  const operation = typeof shape.operation === 'string' && shape.operation.length > 0 ? shape.operation : '...';
  const failed = value.failed === true;
  const partial = value.isPartial === true;
  const expanded = value.expanded === true;
  const withheld = value.content === CARD_CONTENT.MINIMAL;
  const output = cardText(value.text);
  // Expanding is the reader's own ask, so it shows everything at either level —
  // except an init, whose whole CLI log is replaced by its outcome and index facts
  // (S4). A failed init keeps its own error and nothing else.
  if (expanded) {
    if (!failed && operation === 'init') {
      const rows = codeGraphInitRows(output);
      return rows.length > 0 ? [{ text: rows.join('\n'), role: failed ? ERROR_ROLE : OUTPUT_ROLE }] : [];
    }
    const whole = codeGraphWholeOutput(value.text);
    return whole.length > 0 ? [{ text: whole, role: failed ? ERROR_ROLE : OUTPUT_ROLE }] : [];
  }
  // A minimized card draws the call alone; only a failure still says why — and
  // an init keeps its one outcome row at either level (S4), because that row is
  // what the call DID rather than the body of its output.
  if (withheld && !failed && !(operation === 'init' && !partial)) return [];
  if (partial) {
    const preview = codeGraphPreview(output);
    return preview.length > 0 ? [{ text: preview, role: failed ? ERROR_ROLE : SUBTITLE_ROLE }] : [];
  }
  const rows = codeGraphCollapsedRows(operation, output, failed, withheld);
  return rows === undefined ? [] : [{ text: rows.text, role: failed ? ERROR_ROLE : SUBTITLE_ROLE }];
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
 * A component whose rows are built again on every paint, so the host's own level,
 * style and width all apply to the card already on screen. Rendering never throws: a
 * failure draws no rows instead of breaking the transcript.
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

/** The call slot: the CodeGraph heading, or the host's own drawing when this call is not CodeGraph's. */
function callSlot(toolName, inherited, seams) {
  return (args, theme, context) => {
    try {
      const ctx = asObject(context);
      const shape = codegraphShape(toolName, args === undefined ? ctx.args : args, seams.cwd());
      if (shape === undefined) return forwardedComponent(inherited, 'renderCall', [args, theme, context]);
      const metrics = seams.metrics();
      if (metrics === undefined) return forwardedComponent(inherited, 'renderCall', [args, theme, context]);
      const paint = themeFor(theme, seams.theme);
      const pending = ctx.isPartial !== false;
      const failed = ctx.isError === true;
      const tone = failed ? CARD_TONE.ERROR : pending ? CARD_TONE.WARNING : CARD_TONE.INFO;
      const expanded = ctx.expanded === true;
      const hint = pending || failed ? undefined : expandHint(ctx, expanded);
      const card = { ...codegraphCallIdent(shape), tone };
      return component((width) => floatRows(tone, paint, width, (inner) => {
        const head = expanded
          ? cardTopRows(card, paint, inner, hint, metrics)
          : [cardTopLine(card, paint, inner, hint, undefined, metrics)];
        const body = pending && !failed ? [cardRunningLine(tone, paint, inner, metrics)] : [];
        // The result that follows owns the closing rule; a call still waiting for it
        // closes its own frame, so a running row never floats outside one.
        const bottom = cardAwaitingResult(ctx) ? cardBottom(tone, paint, inner, undefined, metrics) : undefined;
        return { head, body, bottom };
      }, card.railRole));
    } catch {
      return EMPTY_COMPONENT;
    }
  };
}

/** The result slot: the rows CodeGraph's own output supports, or the host's own drawing for any other call. */
function resultSlot(toolName, inherited, seams) {
  return (result, options, theme, context) => {
    try {
      const ctx = asObject(context);
      const shape = codegraphShape(toolName, ctx.args, seams.cwd());
      if (shape === undefined) return forwardedComponent(inherited, 'renderResult', [result, options, theme, context]);
      const metrics = seams.metrics();
      if (metrics === undefined) return forwardedComponent(inherited, 'renderResult', [result, options, theme, context]);
      const paint = themeFor(theme, seams.theme);
      const failed = asObject(result).isError === true || optionFlag(options, ctx, 'isError');
      const partial = optionFlag(options, ctx, 'isPartial');
      const expanded = optionFlag(options, ctx, 'expanded');
      const tone = failed ? CARD_TONE.ERROR : partial ? CARD_TONE.WARNING : CARD_TONE.INFO;
      const text = resultText(result);
      // One frame: from here on the call above is a heading and this card closes it.
      markCardResult(ctx.state);
      return component((width) => floatRows(tone, paint, width, (inner) => {
        // The level is asked for on every paint, so a preference switched on screen
        // repaints the rows it decides.
        const rows = codegraphResultRows({ shape, text, expanded, isPartial: partial, failed, content: seams.content() });
        const role = rows.length > 0 ? rows[0].role : undefined;
        const body = role === undefined
          ? []
          : cardBodyRows(rows.map((row) => row.text), tone, paint, inner, { expanded: true, role }, metrics);
        // A streamed result is not finished: the closing rule (and the time on it)
        // belongs to the final one, which the host renders when the call settles.
        const bottom = partial ? undefined : cardBottom(tone, paint, inner, cardElapsed(ctx.durationMs), metrics);
        // The call above owns the heading, so the float style still sets this body
        // off from it with its separator row. The result continues the heading's card,
        // so its sides and closing rule keep the CodeGraph role the box above wears.
        return { body, bottom, afterHeading: true };
      }, CODEGRAPH_TITLE_ROLE));
    } catch {
      return EMPTY_COMPONENT;
    }
  };
}

/**
 * S10: the CodeGraph card, for the native `codegraph` tool, the MCP explore tool and
 * a `bash` call whose command runs the same program.
 *
 * `createCodegraphCardResolver({ metrics, registerToolRenderer, theme, cardContent })`
 * takes every host seam as an option:
 *   * `metrics` (required) — the text-measurement seam, either the object itself or a
 *     function returning it, so a runtime lookup (the host's TUI package) is resolved
 *     per paint and never at load;
 *   * `registerToolRenderer` — the host hook this factory registers through. Absent,
 *     or a hook that throws, is no hook: the factory reports `registered: false` and
 *     nothing of ours is drawn, which is what an older host needs;
 *   * `theme` — the theme used when a render arrives without one;
 *   * `cardContent` — the level reader, defaulting to the process-wide slot above.
 *
 * It returns `{ registered, resolver }`; `resolver(toolName, next)` is the function
 * the host hook receives, and it hands every tool it does not own back exactly as
 * `next()` resolved it.
 */
function createCodegraphCardResolver(options) {
  const opts = asObject(options);
  const metrics = metricsSeam(opts.metrics);
  const seams = {
    theme: opts.theme,
    cwd: cwdSeam(opts.cwd),
    metrics() {
      try {
        return usableMetrics(metrics());
      } catch {
        return undefined;
      }
    },
    content() {
      try {
        const reader = opts.cardContent;
        if (typeof reader !== 'function') return cardContentLevel();
        return reader() === CARD_CONTENT.MINIMAL ? CARD_CONTENT.MINIMAL : CARD_CONTENT.DEFAULT;
      } catch {
        return CARD_CONTENT.DEFAULT;
      }
    },
  };
  const resolver = (toolName, next) => {
    const inherited = inheritedRenderers(next);
    if (typeof toolName !== 'string') return inherited;
    // Every tool the card does not own goes back untouched: those rows are the
    // chain's, byte for byte, whatever this card would have drawn.
    if (!isCodeGraphCardTool(toolName) && toolName !== BASH_TOOL) return inherited;
    // S11: the `Card tags` line decides. `activity` selected is the card; every other
    // answer is the chain's own row, which is what Pi drew before this design existed.
    if (!activityDesignDraws(toolName)) return inherited;
    // This card frames itself, so the host must not frame it too: the host wraps every tool whose definition does not say
    // `renderShell: 'self'` in its own filled box, and a card drawn inside that box is two designs at once.
    if (toolName === BASH_TOOL) {
      // A bash row inside the host's own box stays the host's, as does a host with no bash renderer at all: with no
      // renderer to hand a non-CodeGraph command back to, every bash row would be drawn blank.
      if (inherited === undefined || inherited.renderShell !== 'self') return inherited;
    }
    return {
      renderShell: 'self',
      renderCall: callSlot(toolName, inherited, seams),
      renderResult: resultSlot(toolName, inherited, seams),
    };
  };
  const register = opts.registerToolRenderer;
  if (typeof register !== 'function') return { registered: false, resolver };
  try {
    register(resolver);
    return { registered: true, resolver };
  } catch {
    return { registered: false, resolver };
  }
}

/**
 * The extension's one-line wiring point, like `registerFileCard`: register through the host's
 * hook when it has one, and report the outcome rather than throwing. It is NOT part of the
 * `Codegraph+` module: the card paints a call, it does not run CodeGraph, so the switch that
 * decides it is `Card tags` (`activity`), asked on every paint.
 */
function registerCodegraphCard(pi, deps = {}) {
  if (typeof pi?.registerToolRenderer !== 'function') return { registered: false, resolver: undefined };
  try {
    return createCodegraphCardResolver({
      metrics: deps.metrics,
      theme: deps.theme,
      cwd: deps.cwd,
      registerToolRenderer: (resolver) => pi.registerToolRenderer(resolver),
    });
  } catch {
    // A host without a usable measurement seam draws its own row: the card is cosmetic.
    return { registered: false, resolver: undefined };
  }
}

module.exports = {
  CARD_CONTENT,
  CARD_CONTENT_SLOT,
  CODEGRAPH_MARK,
  CODEGRAPH_MCP_PREFIXED_TOOL,
  CODEGRAPH_MCP_TOOL,
  CODEGRAPH_TITLE_ROLE,
  CODEGRAPH_TOOL,
  activityDesignDraws,
  cardContentLevel,
  codegraphCallRows,
  codegraphResultRows,
  codegraphShape,
  createCodegraphCardResolver,
  isCodeGraphCardTool,
  registerCodegraphCard,
};

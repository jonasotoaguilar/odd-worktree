'use strict';
// T3 (S1/S2): the seam that makes a `read`, `edit` or `write` call whose path names a
// skill or an ODD artifact this package's file card.
//
// Shaped exactly like `lib/bash-card-resolver.js`, and for the same reason: the host
// resolves drawing through `pi.registerToolRenderer((toolName, next) => …)`, where
// `next()` is what the remaining resolvers (in extension load order) and then the
// registered tool would draw. So this module REGISTERS NOTHING, EXECUTES NOTHING and
// SHADOWS NOTHING: it chooses renderers for the three file tools and hands every other
// row back exactly as the chain resolved it.
//
// The two decisions this module owns:
//   * WHICH ROWS IT CLAIMS. `read`, `edit` and `write` only, and only when the host
//     offers a usable measurement seam. Whether one particular CALL is this card's is
//     decided per call, inside the slots (`lib/file-card.js`): the path's identity and
//     the bridge's `Card tags` line are read on every paint, so a row whose path names
//     neither is the chain's own drawing and a switch flipped while the transcript is
//     on screen repaints the row already there.
//   * THE SEAMS. Text measurement and Pi's Markdown renderer are injected, so a host
//     that cannot provide them (no TUI package, an older build) gets its own rows back
//     instead of a card measured against nothing.
//
// Colour is not decided here: it arrives from the host's render arguments, with the
// factory's `theme` option as the fallback for a host that passes none.

const {
  FILE_TOOLS,
  fileCallSlot,
  fileResultSlot,
  inheritedRenderers,
  inheritedShell,
} = require('./file-card.js');
const { CARD_CONTENT, cardContentLevel } = require('./card-content.js');
// Pi's Markdown renderer, resolved inside the call and never at load: this package
// ships no node_modules.
const { loadMarkdownClass } = require('./file-card-markdown.js');

// ---- the one switch (S1/S7) ----
//
// The file card no longer owns a preference: it is painted while the bridge's
// `Card tags` line answers that this package's activity design draws the tool being
// drawn, and the host's own card is painted for every other value (the bridge's
// `native`, a design that has left the line, and a design that does not cover this
// tool alike).
//
// The answer comes from the bridge's OWN reader, through the same published object
// every other bridge surface here uses (`lib/bash-design.js` is handed it at
// registration; the extension reads it from the slot below). Nothing is duplicated:
// no store path, no key, no resolution rule — and nothing is cached, because the
// question is what repaints a card already on screen after a mid-session switch.
const BRIDGE_API_SLOT = Symbol.for('gentle-shell-bridge/api/v1');
const BRIDGE_API_SCHEMA = 'gentle-shell-bridge/api';
const BRIDGE_API_VERSION = 1;
const ACTIVITY_DESIGN_ID = 'odd-worktree.bash-activity';

/** The bridge's published object after its own gate, or undefined when nothing usable is published. */
function bridgeApi() {
  try {
    const api = globalThis[BRIDGE_API_SLOT];
    if (api === null || typeof api !== 'object') return undefined;
    if (api.schema !== BRIDGE_API_SCHEMA || api.version !== BRIDGE_API_VERSION) return undefined;
    return api;
  } catch {
    return undefined;
  }
}

/**
 * Whether the activity design draws `tool` right now, asked per paint and never cached.
 *
 * The reader is an OPTIONAL member of the published object (gentle-shell-bridge@0.7.0):
 * a bridge older than that, or no bridge at all, has none, and then the card paints
 * exactly as it did before the switch was joined — an unavailable gate never hides a
 * card. The bridge's reader never throws (an absent or unreadable store answers
 * `native`), and this one does not either: an answer it cannot read keeps the card
 * visible rather than hiding a row behind a version it does not know.
 *
 * S4: the call's own `args` travel with the question, because the line's claim on `write`
 * and `edit` is a SCOPE (gentle-shell-bridge@0.9.0) — a predicate over `{ tool, args }`,
 * answered per CALL. Without them the bridge cannot tell a skill's path from any other
 * write, and this card would paint a call another line owns. The object is the host's
 * own, by reference and never copied: the scope reads only its stable `path`. A bridge
 * whose reader takes no second argument ignores it and answers exactly as before, and
 * an older bridge reads the call as unknown, which is what it has always done.
 */
function activitySelected(tool, args) {
  const api = bridgeApi();
  if (api === undefined || typeof api.resolveToolDesignSelection !== 'function') return true;
  try {
    const selection = api.resolveToolDesignSelection(tool, args);
    const answer = selection !== null && typeof selection === 'object' ? selection : {};
    if (answer.kind === 'native' || answer.kind === 'missing' || answer.kind === 'not-covered') return false;
    if (answer.kind !== 'design') return true;
    const design = answer.design !== null && typeof answer.design === 'object' ? answer.design : {};
    return typeof design.id !== 'string' ? true : design.id === ACTIVITY_DESIGN_ID;
  } catch {
    return true;
  }
}

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';

function assertMetrics(value) {
  if (!hasFunction(value, METRICS_FUNCTIONS[0])) {
    throw new TypeError('createFileCardResolver requires an injected metrics object ({visibleWidth, truncateToWidth, wrapTextWithAnsi})');
  }
  for (const name of METRICS_FUNCTIONS) {
    if (!hasFunction(value, name)) throw new TypeError(`createFileCardResolver requires metrics.${name} to be a function`);
  }
  return value;
}

/**
 * The measurement seam a caller injected, validated once at construction: the object
 * itself, or a function the factory calls on every paint (the host's TUI package is
 * resolved inside the hook, never at load).
 */
function metricsSeam(value) {
  if (typeof value === 'function') return value;
  assertMetrics(value);
  return () => value;
}

/** Whether a value is a usable text-measurement seam. */
function usableMetrics(value) {
  return METRICS_FUNCTIONS.every((name) => hasFunction(value, name)) ? value : undefined;
}

/**
 * T3 (S1/S2): the file card, for `read`, `edit` and `write`.
 *
 * `createFileCardResolver({ metrics, registerToolRenderer, theme, markdownClass })` takes
 * every host seam as an option:
 *   * `metrics` (required) — the text-measurement seam, either the object itself or a
 *     function returning it, so a runtime lookup (the host's TUI package) is resolved
 *     per paint and never at load;
 *   * `registerToolRenderer` — the host hook this factory registers through. Absent,
 *     or a hook that throws, is no hook: the factory reports `registered: false` and
 *     nothing of ours is drawn, which is what an older host needs;
 *   * `theme` — the theme used when a render arrives without one;
 *   * `markdownClass` — Pi's `Markdown` renderer. Omitted, the host package is resolved
 *     lazily per paint; `null`, a host that has none, which keeps the plain body.
 *
 * It returns `{ registered, resolver }`; `resolver(toolName, next)` is the function the
 * host hook receives, and it returns every tool it does not own exactly as `next()`
 * resolved it.
 */
function createFileCardResolver(options) {
  const opts = asObject(options);
  const metrics = metricsSeam(opts.metrics);
  const seams = {
    theme: opts.theme,
    metrics() {
      try {
        return usableMetrics(metrics());
      } catch {
        return undefined;
      }
    },
    /**
     * The one switch, read now (S1/S7): the bridge's `Card tags` line answers with the
     * activity design for `tool` — and, since a claim can be scoped, for THIS call: the
     * call's `args` are handed over with the question (S4). A bridge with no reader —
     * older than 0.7.0, or none at all — paints the card, which is the behaviour it had
     * before; a reader that takes one argument ignores the second and answers as it did.
     */
    enabled(tool, args) {
      try {
        return activitySelected(tool, args) === true;
      } catch {
        return true;
      }
    },
    /** Pi's Markdown renderer, read now: the injected seam wins, else the host package. */
    markdownClass() {
      try {
        if (opts.markdownClass !== undefined) {
          return typeof opts.markdownClass === 'function' ? opts.markdownClass : undefined;
        }
        return loadMarkdownClass();
      } catch {
        return undefined;
      }
    },
    /** The conversation's content level, read now (S2): `minimal` or the safe `default`. */
    content() {
      try {
        return cardContentLevel() === CARD_CONTENT.MINIMAL ? CARD_CONTENT.MINIMAL : CARD_CONTENT.DEFAULT;
      } catch {
        return CARD_CONTENT.DEFAULT;
      }
    },
  };
  const resolver = (toolName, next) => {
    const inherited = inheritedRenderers(next);
    // Every tool this card does not own goes back untouched: those rows are the
    // chain's, byte for byte, whatever this card would have drawn.
    if (!FILE_TOOLS.includes(toolName)) return inherited;
    // A host with no usable measurement seam keeps its own drawing: a card measured
    // against nothing is worse than no card.
    if (seams.metrics() === undefined) return inherited;
    // The shell the chain's own renderer draws in, read ONCE here because a resolver
    // never sees a call's arguments and `renderShell` is fixed per tool: the host reads
    // `renderShell ?? 'default'`, so only a literal `self` is one. A `self` renderer
    // (Pi's `edit`) frames itself and the host draws NO box around it, so its rows are
    // handed back exactly as drawn; every other tool gets the host's box reproduced.
    const shell = inheritedShell(inherited);
    // This card frames itself, so the host must not frame it too: the host wraps every
    // tool whose definition does not say `renderShell: 'self'` in its own filled box,
    // and a card drawn inside that box is two designs at once.
    return {
      renderShell: 'self',
      renderCall: fileCallSlot(toolName, inherited, seams, shell),
      renderResult: fileResultSlot(toolName, inherited, seams, shell),
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
 * The extension's one-line wiring point: register through the host's hook when the
 * host has one, and report the outcome rather than throwing. A host without
 * `registerToolRenderer` draws its own rows and loses nothing (no card is registered,
 * no tool is defined, no command is added).
 */
function registerFileCard(pi, deps = {}) {
  // A host with no hook is asked nothing: registering through a seam that does not
  // exist would report a card that is never drawn.
  if (typeof pi?.registerToolRenderer !== 'function') return { registered: false, resolver: undefined };
  try {
    return createFileCardResolver({
      metrics: deps.metrics,
      theme: deps.theme,
      registerToolRenderer: (resolver) => pi.registerToolRenderer(resolver),
    });
  } catch {
    // A host without a usable measurement seam draws its own row: the card is cosmetic.
    return { registered: false, resolver: undefined };
  }
}

module.exports = {
  createFileCardResolver,
  registerFileCard,
};

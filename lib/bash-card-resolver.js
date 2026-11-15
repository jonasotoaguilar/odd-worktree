'use strict';
// S2/S5 (T4): the seam that makes a `bash` tool call this package's activity card.
//
// Shaped exactly like `lib/codegraph-card.js`'s resolver, and for the same reason: the
// host resolves drawing through `pi.registerToolRenderer((toolName, next) => …)`,
// where `next()` is what the remaining resolvers (in extension load order) and then
// the registered tool would draw. So this module REGISTERS NOTHING, EXECUTES NOTHING
// and SHADOWS NOTHING: it chooses renderers for one tool name and hands every other
// row back exactly as the chain resolved it. Two consequences matter:
//   * this card owns EVERY bash call while the mode is `own`, a `codegraph …` command
//     included (it wears the classifier's `codegraph` identity). It never forwards a
//     bash call to the chain for that reason: an uninstalled CodeGraph CLI registers
//     no CodeGraph card at all (invariant 19), so forwarding would hand one row to the
//     host while the toggle says the cards are ours;
//   * the richer CodeGraph card still wins its own commands by LOAD ORDER: the
//     extension registers it before this one, so it receives these slots as `next()`,
//     sees `renderShell: 'self'` and claims the row itself — this card's slots are
//     never asked. Load order is the whole composition rule, and there is no second
//     copy of it to keep in sync (L5);
//   * a host without the hook keeps drawing its own bash rows. The factory reports
//     `registered: false` and nothing of ours is ever asked for.
//
// The two decisions this module owns:
//   * THE MODE (`/card:bash`, lib/card-bash-mode.js). It is read when a row is
//     created, so a row created while the mode is `default` is the host's own row,
//     and it is read AGAIN on every paint by the card's own slots, so a card already
//     on screen repaints when the toggle flips (L8: the component's `render(width)`
//     runs each frame, and there is no `ctx.ui` repaint seam to look for).
//   * THE METRICS SEAM. Text measurement is injected, so a host that cannot provide
//     it (no TUI package, an older build) gets its own row back instead of a card
//     measured against nothing.
//
// Colour is not decided here: it arrives from the host's render arguments, with the
// factory's `theme` option as the fallback for a host that passes none.

const {
  BASH_TOOL,
  bashCallSlot,
  bashResultSlot,
  inheritedRenderers,
} = require('./bash-card.js');
const { CARD_BASH_MODE, cardBashMode } = require('./card-bash-mode.js');

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';

function assertMetrics(value) {
  if (!hasFunction(value, METRICS_FUNCTIONS[0])) {
    throw new TypeError('createBashCardResolver requires an injected metrics object ({visibleWidth, truncateToWidth, wrapTextWithAnsi})');
  }
  for (const name of METRICS_FUNCTIONS) {
    if (!hasFunction(value, name)) throw new TypeError(`createBashCardResolver requires metrics.${name} to be a function`);
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
 * The card mode in force. `own` (the default, S6) draws this card; `default` is the
 * host's own bash drawing. A reader that throws is not a decision to hide the
 * transcript behind, so it reads as `own` — what every unusable state already means
 * in `lib/card-bash-mode.js`, which answers this question and never throws.
 */
function cardMode() {
  try {
    return cardBashMode() === CARD_BASH_MODE.DEFAULT ? CARD_BASH_MODE.DEFAULT : CARD_BASH_MODE.OWN;
  } catch {
    return CARD_BASH_MODE.OWN;
  }
}

/**
 * S2/S5: the bash activity card.
 *
 * `createBashCardResolver({ metrics, registerToolRenderer, theme })` takes every host
 * seam as an option:
 *   * `metrics` (required) — the text-measurement seam, either the object itself or a
 *     function returning it, so a runtime lookup (the host's TUI package) is resolved
 *     per paint and never at load;
 *   * `registerToolRenderer` — the host hook this factory registers through. Absent,
 *     or a hook that throws, is no hook: the factory reports `registered: false` and
 *     nothing of ours is drawn, which is what an older host needs;
 *   * `theme` — the theme used when a render arrives without one.
 *
 * It returns `{ registered, resolver }`; `resolver(toolName, next)` is the function
 * the host hook receives. Every tool that is not a bash call is handed back exactly
 * as `next()` resolved it, and so is a bash call while the mode is `default` or while
 * no measurement seam resolves. Every remaining bash call is this card's: a
 * `codegraph …` command included, which is the CodeGraph card's only when that card is
 * registered ahead of this one.
 */
function createBashCardResolver(options) {
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
    mode: cardMode,
  };
  const resolver = (toolName, next) => {
    const inherited = inheritedRenderers(next);
    if (toolName !== BASH_TOOL) return inherited;
    // The mode and the seam are asked for once here, when the row is created: a row
    // created while the host draws bash keeps the host's own drawing (its shell, its
    // box, its colours) instead of a forwarded copy of it.
    if (seams.mode() !== CARD_BASH_MODE.OWN) return inherited;
    if (seams.metrics() === undefined) return inherited;
    // This card frames itself, so the host must not frame it too: the host wraps every
    // tool whose definition does not say `renderShell: 'self'` in its own filled box,
    // and a card drawn inside that box is two designs at once.
    return {
      renderShell: 'self',
      renderCall: bashCallSlot(inherited, seams),
      renderResult: bashResultSlot(inherited, seams),
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
 * `registerToolRenderer` draws its own bash rows and loses nothing (no card is
 * registered, no tool is defined, no command is added).
 */
function registerBashCard(pi, deps = {}) {
  // A host with no hook is asked nothing: registering through a seam that does not
  // exist would report a card that is never drawn.
  if (typeof pi?.registerToolRenderer !== 'function') return { registered: false, resolver: undefined };
  try {
    return createBashCardResolver({
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
  createBashCardResolver,
  registerBashCard,
};

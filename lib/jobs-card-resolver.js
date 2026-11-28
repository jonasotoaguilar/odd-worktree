'use strict';
// The seam that makes `bash_background`, `monitor`, `job_stop` and `job_list` this package's
// jobs card (`lib/jobs-card.js`).
//
// Shaped like `lib/file-card-resolver.js`: the host resolves drawing through
// `pi.registerToolRenderer((toolName, next) => …)`, where `next()` is what the remaining
// resolvers and then the registered tool would draw. This module REGISTERS NOTHING, EXECUTES
// NOTHING and SHADOWS NOTHING: it chooses renderers for the four job tools and hands every
// other row back exactly as the chain resolved it.
//
// One difference from the file card. The file card forwards to the host's own renderers while
// its switch is off; these four tools have NO renderer of their own — Pi draws its own plain
// fallback for them — so there is nothing to forward to. The card draws that fallback itself
// while the line says anything but `activity` (the host's box around the host's
// `createCallFallback()`/`createResultFallback()` text, reproduced in `lib/file-card.js`), and
// its own rows while the line says `activity`. Both are decided on EVERY paint, inside the
// component, because Pi resolves a tool's renderers ONCE when it mounts the card
// (`interactive-mode.js` builds `ToolExecutionComponent` with the definition it resolved) and
// never asks again: a switch flipped while a card is already on screen repaints that card.
//
// THE SWITCH is the shell API's `Card activity` line, read through its published reader, never a
// store path. It is strict: only the answer `design` carrying this package's activity design
// paints the card. No shell API, a shell API older than the reader, a reader that throws, `native`,
// `not-covered`, `missing`, another plugin's design and an answer nothing can read all draw
// the host's own fallback, because here an unavailable answer must never change a row.

const { hostFallbackRows, inheritedRenderers, inheritedShell } = require('./file-card.js');
const { ACTIVITY_DESIGN_ID, shellApi } = require('./file-card-resolver.js');
const { CARD_CONTENT, cardContentLevel } = require('./card-content.js');
const { JOB_TOOLS, jobCallSlot, jobResultSlot } = require('./jobs-card.js');

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';

/**
 * Whether the activity design draws `tool` right now. Strict: anything but this package's own
 * design as the line's answer is a no. The reader never throws on the shell API's side and this
 * one does not either.
 */
function jobsActivitySelected(tool) {
  try {
    const api = shellApi();
    if (api === undefined || typeof api.resolveToolDesignSelection !== 'function') return false;
    const answer = asObject(api.resolveToolDesignSelection(tool));
    return answer.kind === 'design' && asObject(answer.design).id === ACTIVITY_DESIGN_ID;
  } catch {
    return false;
  }
}

function assertMetrics(value) {
  for (const name of METRICS_FUNCTIONS) {
    if (!hasFunction(value, name)) throw new TypeError(`createJobsCardResolver requires metrics.${name} to be a function`);
  }
  return value;
}

/** The measurement seam, validated once: the object itself, or a function asked on every paint. */
function metricsSeam(value) {
  if (typeof value === 'function') return value;
  assertMetrics(value);
  return () => value;
}

const usableMetrics = (value) => (METRICS_FUNCTIONS.every((name) => hasFunction(value, name)) ? value : undefined);

/**
 * `createJobsCardResolver({ metrics, registerToolRenderer, theme })` — every host seam is an
 * option, exactly as for the file card. Returns `{ registered, resolver }`; `resolver` is the
 * function the host hook receives. An absent or throwing hook is no hook: nothing of ours is
 * drawn, which is what an older host needs.
 */
function createJobsCardResolver(options) {
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
    /** The conversation's content level, read now: `minimal` or the safe `default`. */
    content() {
      try {
        return cardContentLevel() === CARD_CONTENT.MINIMAL ? CARD_CONTENT.MINIMAL : CARD_CONTENT.DEFAULT;
      } catch {
        return CARD_CONTENT.DEFAULT;
      }
    },
    /**
     * Whether the activity design draws `tool` right now, asked inside the component's
     * build and never cached: the line is what repaints a card already on screen, and Pi
     * never re-resolves the renderers of a card it has already mounted.
     */
    enabled(tool) {
      return jobsActivitySelected(tool) === true;
    },
  };
  const resolver = (toolName, next) => {
    const inherited = inheritedRenderers(next);
    // Every tool this card does not own goes back untouched, byte for byte.
    if (!JOB_TOOLS.includes(toolName)) return inherited;
    // A host that cannot measure draws its own rows: a card measured against nothing is
    // worse than no card. A seam, not the switch: `enabled` is asked per paint.
    if (seams.metrics() === undefined) return inherited;
    // The shell the tool's own definition declares, read once because a resolver never sees
    // a call's arguments: the host's box is reproduced for a default shell, and a tool that
    // frames itself is handed back without one — exactly as the host decides.
    const shell = inheritedShell(inherited);
    // This card frames itself either way, so the host must not box the rows it draws — and,
    // because Pi mounts this card once, the only place the line can still be read is inside
    // it: the slots decide on every paint.
    return {
      renderShell: 'self',
      renderCall: jobCallSlot(toolName, seams, shell),
      renderResult: jobResultSlot(toolName, seams, shell),
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
 * The extension's one-line wiring point: register through the host's hook when it has one and
 * report the outcome rather than throwing. A host without `registerToolRenderer` draws its own
 * rows and loses nothing.
 */
function registerJobsCard(pi, deps = {}) {
  if (typeof pi?.registerToolRenderer !== 'function') return { registered: false, resolver: undefined };
  try {
    return createJobsCardResolver({
      metrics: deps.metrics,
      theme: deps.theme,
      registerToolRenderer: (resolver) => pi.registerToolRenderer(resolver),
    });
  } catch {
    return { registered: false, resolver: undefined };
  }
}

module.exports = {
  createJobsCardResolver,
  jobsActivitySelected,
  registerJobsCard,
};

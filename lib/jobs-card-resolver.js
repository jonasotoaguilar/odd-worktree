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
// One difference from the file card, and it is deliberate. The file card forwards to the host's
// own renderers while its switch is off, so it can decide on every paint. These four tools have
// NO renderer of their own — Pi draws its plain default for them — so there is nothing to
// forward to. The switch is therefore read when the card is BUILT: any answer other than the
// activity design hands back exactly what the chain resolved, and Pi draws what it always drew.
// A switch flipped while a card is already on screen reaches the next job card, not that one.
//
// THE SWITCH is the bridge's `Card activity` line, read through its published reader, never a
// store path. It is strict: only the answer `design` carrying this package's activity design
// paints. No bridge, a bridge older than the reader, a reader that throws, `native`,
// `not-covered`, `missing`, another plugin's design and an answer nothing can read all leave
// Pi's drawing untouched, because here an unavailable answer must never change a row.

const { inheritedRenderers } = require('./file-card.js');
const { ACTIVITY_DESIGN_ID, bridgeApi } = require('./file-card-resolver.js');
const { CARD_CONTENT, cardContentLevel } = require('./card-content.js');
const { JOB_TOOLS, jobCallSlot, jobResultSlot } = require('./jobs-card.js');

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';

/**
 * Whether the activity design draws `tool` right now. Strict: anything but this package's own
 * design as the line's answer is a no. The reader never throws on the bridge's side and this
 * one does not either.
 */
function jobsActivitySelected(tool) {
  try {
    const api = bridgeApi();
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
  };
  const resolver = (toolName, next) => {
    const inherited = inheritedRenderers(next);
    // Every tool this card does not own goes back untouched, byte for byte.
    if (!JOB_TOOLS.includes(toolName)) return inherited;
    // Pi's own drawing stays unless the line says activity, and unless a card can be measured.
    if (!jobsActivitySelected(toolName)) return inherited;
    if (seams.metrics() === undefined) return inherited;
    return {
      // This card frames itself, so the host must not box it too.
      renderShell: 'self',
      renderCall: jobCallSlot(toolName, seams),
      renderResult: jobResultSlot(toolName, seams),
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

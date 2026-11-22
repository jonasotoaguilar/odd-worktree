'use strict';
// The two advisory message cards: `gentle-pi.exploration-budget` and
// `gentle-pi.verifier-settle-reminder`, drawn on this package's card substrate
// (`lib/shell-card.js`), in whichever style the shell has chosen and always in full.
//
// Gentle Shell sends both messages with no renderer registered for either type, so Pi draws
// its plain default box and the conversation's card style never reaches them. This module is
// the drawing half, registered through gentle-shell-bridge's message-design surface; the
// bridge owns Pi's renderer, the customize line and its persistence, exactly as it does for
// the tool designs (`lib/bash-design.js`, `lib/diff-design.js`).
//
// What a design receives, and what this card owns:
//   * For a type with NO host renderer the bridge hands `apply` the message's own body plainly
//     — its `[customType]` label, a blank row and its text — and the DESIGN owns the frame
//     (bridge `docs/contract.md` §15). The label and the blank row are the bridge's plain-body
//     decorations, not the message, so they are dropped here: the card's own heading already
//     names the alert, and the body starts at the message's first row.
//   * THE BODY IS NEVER CLIPPED (S2). Both alerts are instructions the agent must read, so
//     every row is drawn at any card content level: no `previewRows`, no `minimal`
//     withholding, no expand hint — nothing is hidden, so a hint would lie. That is the exact
//     opposite of the jobs card's result body (`lib/jobs-card.js`), and it is this consumer's
//     decision: the bridge clips nothing and reads no content level.
//   * COLOUR is a tone, never a palette: `info` for the budget and `warning` for the reminder,
//     and the substrate turns each into the theme's own roles. No escape sequence is written
//     here.
//   * MEASUREMENT is the substrate's, through the injected seam: rows are composed as PLAIN
//     text, wrapped and clipped, and painted last. Without a usable seam the design throws, and
//     the bridge's own fallback draws Pi's box — a message the agent must read is never
//     unmeasured into a frame Pi would refuse.
//   * THE STYLE is the HOST's, read on every paint by `floatRows` (`lib/card-style.js`), never
//     `ctx.cardStyle`: that field is the BRIDGE's Card style selection, not float/neon chrome
//     (S3). A mid-session flip therefore repaints a message already on screen.
//
// THE SWITCH (S1). Both alerts are selected by the SAME value that already draws this package's
// tool cards, and this module owns no switch of its own: each design FOLLOWS the tool design line
// this package registers — `follows: { line: TOOLS_LINE, id: BASH_DESIGN_ID }` — so `Card activity`
// answering `activity` is what paints them. The bridge resolves that LIVE on every pass, reading
// the tool document and never writing it: a flip on the line repaints a message already on screen
// and turns it off again, with no re-registration, no seed and no second store. A following design
// contributes no value to the customize menu, so the human sees no `Message …` row at all.
//
// FOLLOWS NEEDS 0.12.1, AND AN OLDER BRIDGE GETS NOTHING. `follows` arrived at 0.12.0, but 0.12.0
// let a value left in the message document VETO a follow, which turns the one switch this card
// promises back into a silent second one; 0.12.1 answers the follow first and is the first release
// that keeps the promise. A bridge below it ignores `follows` while accepting the registration and
// would silently mint the parallel `Message <type>` switch this card must never have. So the surface
// is registered only where the release string reads as at least 0.12.1 (a prerelease or build suffix
// of the cutoff does not meet it), and an unreadable string registers NOTHING — no probe, because a
// probe cannot tell a refusal for an unrelated reason from a validated `follows`.
//
// Rendering never breaks the transcript: a hostile message is filtered to plain rows, and a
// context this card cannot measure through throws into the bridge's own fallback instead of
// answering rows Pi would have to refuse.

const { CARD_TONE, cardBodyRows, cardBottom, cardTopRows, floatRows } = require('./shell-card.js');
// The one reader of text as a card draws it: no terminal sequences, however the text was written.
const { cardText } = require('./codegraph-card-preview.js');
const { bridgeApi } = require('./file-card-resolver.js');
const { themeFor } = require('./file-card.js');
// The line and the tool design id this card follows: the SAME switch the tool cards obey, named
// from the module that registers it, so no literal is re-typed here.
const { BASH_DESIGN_ID, TOOLS_LINE } = require('./bash-design.js');

/** The two custom types this module paints, in the order the line lists them. */
const EXPLORATION_TYPE = 'gentle-pi.exploration-budget';
const VERIFIER_TYPE = 'gentle-pi.verifier-settle-reminder';
const MESSAGE_TYPES = Object.freeze([EXPLORATION_TYPE, VERIFIER_TYPE]);

/**
 * The switch each design follows: the tool design line this package registers, and the tool design
 * that line answers with. One object per design, so no two registrations share a mutable field.
 */
function messageFollow() {
  return { line: TOOLS_LINE, id: BASH_DESIGN_ID };
}

// The bridge release that can keep the follow promise (gentle-shell-bridge 0.12.1: the follow is
// answered BEFORE the message document is opened, so a value left behind by a disposed design can no
// longer veto it). 0.12.0 has `follows` but not that order, which is why the floor is 0.12.1. An older
// release ignores the field, which is the one outcome this card must never produce: a second switch. So
// the release string is the ONLY answer accepted, and anything this module cannot read as at least
// 0.12.1 — absent, unreadable, a prerelease, a build suffix — registers NOTHING. The trade is
// deliberate and it is the safe side of it: an unreadable release loses the card and keeps Pi's own box,
// while a capability probe cannot. A probe is refused for an unrelated reason by 0.11.0 (a competing type
// claim) long before it inspects `follows`, and then the real designs are accepted WITHOUT follow
// semantics — exactly the parallel `Message <type>` switch this module exists not to create — and an
// accepted-then-disposed probe can leave the bridge's row provider installed on an armed bridge.
const FOLLOWS_VERSION = [0, 12, 1];

// Below this the frame's two side rails and the glyph column leave no room for one body row, so the
// rows come straight back instead of a heading painted over nothing.
const MIN_PAINT_WIDTH = 6;

// The attribution name every bridge surface of this package registers under (`lib/bash-design.js`).
const PLUGIN_NAME = 'Odd worktree';

// Each card's mark, title, tone, the theme role its frame and name wear, registration id and the
// label the bridge asks every registration for. The label is not shown: a following design
// contributes no value to the customize menu, and neither `default` nor `native` may be used as one.
// The id is identity, never shown either.
const IDENTITY = Object.freeze({
  [EXPLORATION_TYPE]: {
    glyph: '⌕',
    title: 'Exploration budget',
    tone: CARD_TONE.INFO,
    titleRole: 'accent',
    id: 'odd-worktree.exploration-budget-card',
    label: 'card',
    description: 'draws the exploration budget alert as a card, in the style the shell has chosen',
  },
  [VERIFIER_TYPE]: {
    glyph: '⚑',
    title: 'Verifier reminder',
    // A REMINDER, not an alert: nothing failed and nothing is running, so the card is
    // informational and wears the theme's accent like the budget card — not the amber that a
    // warning tone owns the WHOLE box with (`TONE_OWNS_BOX`), which would override the identity role.
    tone: CARD_TONE.INFO,
    titleRole: 'accent',
    id: 'odd-worktree.verifier-settle-reminder-card',
    label: 'card',
    description: 'draws the verifier reminder as a card, in the style the shell has chosen',
  },
});

const METRICS_FUNCTIONS = ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi'];

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasFunction = (value, name) => value !== null && typeof value === 'object' && typeof value[name] === 'function';
const usableMetrics = (value) => (METRICS_FUNCTIONS.every((name) => hasFunction(value, name)) ? value : undefined);

/** The measurement seam: an object, or a function asked on every paint (the host may load late). */
function metricsSeam(value) {
  if (typeof value === 'function') {
    return () => {
      try {
        return usableMetrics(value());
      } catch {
        return undefined;
      }
    };
  }
  return () => usableMetrics(value);
}

/** The width the host asked this message component to render at, or 0 when it stated none. */
function paintWidth(context) {
  const width = asObject(context).width;
  return typeof width === 'number' && Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

/**
 * The message's own rows, without the plain-body decorations the bridge hands a type with no
 * host renderer: the `[customType]` label row, and the blank row it puts after it. Everything
 * else — every row the message states, blank rows between paragraphs included — is kept.
 */
function messageCardBody(lines, customType) {
  const rows = (Array.isArray(lines) ? lines : []).filter((line) => typeof line === 'string').map((line) => cardText(line));
  if (rows[0] !== `[${customType}]`) return rows;
  const rest = rows.slice(1);
  return rest.length > 0 && rest[0].trim() === '' ? rest.slice(1) : rest;
}

// The numbers an advisory message tracks, read from the message's own text. The budget states
// its lookups and its byte count; the reminder states the risk item whose verification is
// missing. A message that states none is headed by its name alone, never by a guess.
const TRACKED = new Map([
  [EXPLORATION_TYPE, (text) => {
    const lookups = text.match(/(\d[\d,]*)\s+tracked\s+lookups?/iu);
    const bytes = text.match(/(\d[\d,]*)\s+UTF-8\s+text\s+bytes/iu);
    return [
      ...(lookups === null ? [] : [`${lookups[1]} tracked lookups`]),
      ...(bytes === null ? [] : [`${bytes[1]} text bytes`]),
    ];
  }],
  [VERIFIER_TYPE, (text) => {
    const item = text.match(/Risk:\s*item\s+(\d+)/iu);
    return item === null ? [] : [`Risk: item ${item[1]}`];
  }],
]);

/** The numbers one message states, as the detail the heading wears — empty when it states none. */
function trackedNumbers(customType, body) {
  const read = TRACKED.get(customType);
  if (read === undefined) return [];
  try {
    return read(body.join('\n'));
  } catch {
    return [];
  }
}

/** The heading one message wears: its mark and name, then the numbers the message states. */
function messageCardHeading(customType, body) {
  const identity = IDENTITY[customType];
  if (identity === undefined) return undefined;
  const detail = trackedNumbers(customType, body);
  const card = {
    glyph: identity.glyph,
    title: identity.title,
    tone: identity.tone,
    // The mark, the name AND the closed box wear one theme role, exactly as the job cards do: an
    // informational card would otherwise keep the theme's plain `border` frame and read as if it had
    // no role at all. The detail stays the substrate's muted subtitle, and the body stays `text`.
    titleRole: identity.titleRole,
    railRole: identity.titleRole,
    // The label is bolded inside the card's own role, exactly as the file and job cards do.
    labelBold: true,
  };
  // The detail rides the heading only when the message states one: no invented numbers, no
  // empty separator.
  if (detail.length > 0) card.subtitle = detail.join(' · ');
  return card;
}

/**
 * The rows of one message card, for one width, rebuilt on every pass: the heading, the whole
 * body — with no preview budget and no content level in sight — and the closing rule. `floatRows`
 * decides the style once, here, from the host's own setting.
 */
function messageCardRows(customType, lines, paint, metrics, width) {
  const body = messageCardBody(lines, customType);
  const heading = messageCardHeading(customType, body);
  if (heading === undefined) return [];
  return floatRows(heading.tone, paint, width, (inner) => ({
    head: cardTopRows(heading, paint, inner, undefined, metrics),
    // `expanded` is always true — the substrate's own "draw every row" — because the body is an
    // instruction the agent must read, whatever the conversation's content level says.
    body: cardBodyRows(body, heading.tone, paint, inner, { expanded: true }, metrics),
    bottom: cardBottom(heading.tone, paint, inner, undefined, metrics),
  }));
}

/**
 * One design, as the bridge registers it: the custom type it paints, the switch it follows, and
 * `apply(lines, ctx)` — the bridge's rows in, the rows to draw out.
 *
 * `follows` is the whole switch (S1): the design is selected exactly while this package's tool
 * design line answers this package's activity design, resolved by the bridge on every pass. The
 * module registers no value of its own and writes no store, so there is nothing to seed and the
 * customize menu gains no row.
 *
 * `apply` reads the style, the width, the theme and the measurement seam on every pass, so a
 * preference switched or a seam that arrives while the message is on screen applies to the next
 * paint. A context this card cannot measure through throws: the bridge answers that by drawing
 * Pi's own box (`docs/contract.md` §15), which keeps an alert readable and inside the frame.
 */
function messageCardDesign(customType, seams) {
  const identity = IDENTITY[customType];
  if (identity === undefined) return undefined;
  return {
    customType,
    name: PLUGIN_NAME,
    id: identity.id,
    label: identity.label,
    description: identity.description,
    follows: messageFollow(),
    apply(lines, context) {
      const ctx = asObject(context);
      const width = paintWidth(ctx);
      const metrics = seams.metrics();
      if (metrics === undefined || width <= 0) {
        throw new TypeError(`the ${customType} card needs a positive width and the host's measurement helpers`);
      }
      // Too narrow for one body row: hand the bridge's own rows straight back rather than paint a
      // heading over nothing.
      if (width < MIN_PAINT_WIDTH) return [...lines];
      const paint = themeFor(ctx.theme, seams.theme);
      return messageCardRows(customType, lines, paint, metrics, width);
    },
  };
}

/**
 * Whether the bridge's published release is at least `floor`, or `undefined` when the release string
 * cannot be read as a clean numeric release.
 *
 * STRICT BY CHOICE: this card is worth nothing if it registers where `follows` is not honoured, so a
 * string is trusted only when it is `N`, `N.N` or `N.N.N` and nothing else. A prerelease or build
 * suffix (`0.12.1-rc.1`, `0.12.2+build.7`), trailing text (`0.12.2garbage`) and a four-part string
 * (`1.0.0.0`) are all UNREADABLE and register nothing — the numbers are never compared on their own,
 * because a higher number would otherwise carry a string nobody can validate past the floor.
 */
function releaseAtLeast(version, floor) {
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/u.test(version)) return undefined;
  const parts = version.split('.').map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const [major, minor, patch = 0] = parts;
  if (major !== floor[0]) return major > floor[0];
  if (minor !== floor[1]) return minor > floor[1];
  return patch >= floor[2];
}

/**
 * Whether a published bridge can keep the follow promise (gentle-shell-bridge 0.12.1): its release
 * string, and nothing else. There is no probe path by design — see `FOLLOWS_VERSION` for what one costs.
 */
function bridgeTakesFollows(api) {
  return releaseAtLeast(api?.VERSION, FOLLOWS_VERSION) === true;
}

/**
 * `registerMessageCards({ metrics, theme })` — the extension's one wiring point, shaped like
 * `registerJobsCard`. Both designs follow `Card activity` → `activity`, so the human's existing choice
 * is the switch and the bridge decides per pass; this module registers whenever the bridge can
 * express that follow, and NOTHING at all on an older one (a bridge that ignores `follows` would
 * silently create a `Message <type>` switch of its own).
 *
 * Nothing here is seeded and no store is written: the follow reads the tool document, never writes
 * it. An absent bridge, an absent message-design surface, a release below 0.12.1 and a refused
 * registration are all "register nothing": Pi's own box stays exactly as it was.
 *
 * The measurement seam and the theme fallback are the caller's: the seam may be a function, so a
 * host whose TUI arrives later still measures, and it throws only into the bridge's fallback.
 */
function registerMessageCards(options) {
  const opts = asObject(options);
  const none = { registered: false, designs: [], dispose: undefined };
  const api = bridgeApi();
  if (api === undefined || typeof api.registerMessageDesign !== 'function') return none;
  if (!bridgeTakesFollows(api)) return none;
  const seams = { theme: opts.theme, metrics: metricsSeam(opts.metrics) };
  const designs = MESSAGE_TYPES.map((customType) => messageCardDesign(customType, seams)).filter((design) => design !== undefined);
  try {
    const dispose = api.registerMessageDesign(designs);
    return { registered: true, designs, dispose: typeof dispose === 'function' ? dispose : undefined };
  } catch {
    // A refused registration is no design at all: the bridge keeps drawing Pi's own box.
    return none;
  }
}

module.exports = {
  MESSAGE_TYPES,
  bridgeTakesFollows,
  messageCardDesign,
  messageCardRows,
  registerMessageCards,
};

'use strict';
// The bash activity DESIGN: the one way this package changes how a tool card is drawn.
//
// It is a `registerToolDesign` registration on gentle-shell-bridge's published API, not a
// renderer. The bridge owns Pi's one `registerToolRenderer` resolver, builds the HOST's own
// card (Gentle Shell's, in whatever style and content level is chosen) and hands this module
// the rows that card drew:
//
//     apply(lines, { width, tool, theme, part, render }) -> lines
//
// So the frame is the host's by construction, the choice is the bridge's own `Card tools` line in
// `/gentle:customize` → `Cards` (`default` | `activity`), it is read on every paint so cards
// already on screen repaint when it changes, and extension load order does not matter.
//
// ONE line covers six tools. `bash`'s heading names what its command does; the three read-only
// shell tools the line covers (`grep`, `find`, `ls`) only ever read, so their heading is always
// `exploring` whatever their arguments are. `read` and `write` are declared for a different reason:
// the file card is painted only while the bridge's line resolves to this design for the tool being
// drawn, and the bridge resolves coverage from this list, so a read and a write have to be named here
// for the file card to be asked about them. The design itself paints nothing for either (see
// `READ_TOOL` and `WRITE_TOOL`): `exploring` names what a SHELL COMMAND does, and a read is not one,
// so a read card comes back exactly as the host drew it.
// A bridge older than the line (0.6.0) takes exactly the single `bash` design it always took, so
// nothing regresses and no registration is refused.
//
// What the design changes is exactly one thing, on the card's heading row: bash's `$` mark, or a
// read-only shell tool's `<glyph> <tool>`, becomes the activity — `⌕ exploring`, `✓ checking`, … —
// using the one classifier (`lib/bash-activity.js`). The columns the longer mark adds are taken back
// from the row's own fill (and, when there is none left, its tail), so the row keeps the width the
// host made it. Everything else comes back byte for byte.
//
// The rule is the classifier's: never guess. For bash the heading is the evidence when the bridge
// hands no arguments, so it names a call only when the heading provably shows the WHOLE command:
// no `…` abbreviation, no `… +N lines` fold, no continuation row, and nothing after the command but
// the host's own fill and hint. A read-only tool's word is the same whatever it reads, so its
// arguments are only the proof that the heading is not the whole evidence. Anything else, and every
// command the classifier cannot name, is drawn exactly as the host drew it. Pure: no Pi, no theme,
// no colour, no filesystem — the heading keeps the host's own paint.

const { SHELL_ACTIVITY_IDENTITY, inferBashActivity } = require('./bash-activity.js');
// S6: the file card's own identity rule, reused and never copied — a path it claims is
// the file card's row, so this design must leave it alone.
const { fileCardIdentity } = require('./skill-odd-card.js');
const { cardElapsed, charColumns, elapsedRow, paintFrame, rowColumns, sgrBefore, textColumns, visibleChars } = require('./bash-frame.js');

const TOOL_NAME = 'bash';
// The bridge line every covered tool is switched by. The bridge names the row `Card <line>`.
const TOOLS_LINE = 'tools';
// The bridge release that can take one line over several tools; earlier ones refuse a grouped
// registration and record the refusal, so the shape is chosen BEFORE anything is registered.
const TOOLS_LINE_VERSION = [0, 6, 0];
// The throwaway design a release whose version cannot be read is probed with: an id nothing selects
// and a line no plugin of the user's would ever use. It is registered and immediately disposed, so
// it can never take a value, appear on a menu, or paint a card.
const PROBE_DESIGN_ID = 'odd-worktree.capability-probe';
const PROBE_LINE = 'odd-worktree-probe';
const PROBE_TOOL = 'odd-worktree-probe';
// Stable across loads and unique per line: a reload replaces this design, never stacks one.
const BASH_DESIGN_ID = 'odd-worktree.bash-activity';
// The value the user reads on the bridge's line, next to the reserved `default`.
const BASH_DESIGN_LABEL = 'activity';
const BASH_DESIGN_PLUGIN_NAME = 'Odd worktree';
const MARK = '$';

// The read-only SHELL tools whose own `<glyph> <tool>` heading the design heads `exploring`, each with
// the glyph its card is drawn with. They are shell commands that only ever read, so the activity is
// the same for all of them and their arguments change nothing. `read` is not one of them: it runs no
// command, so the word does not describe it (see `READ_TOOL`).
const READ_TOOL_GLYPHS = new Map([
  ['grep', '⌕'],
  ['find', '⌖'],
  ['ls', '☷'],
]);
const EXPLORING = 'exploring';
// S1: a read is declared for coverage alone, exactly like `write` below and for the same reason — the
// file card draws a read only while this line answers that this design draws the tool, and the bridge
// derives that answer from the line's own `tools`. So `read` is DECLARED here and painted by nothing:
// `exploring` names what a shell command does and a read is not one, so `READ_TOOL_GLYPHS` has no mark
// for it, `toolHeadingSpec` finds no spec and `computeActivity` hands the host's own rows back
// untouched.
const READ_TOOL = 'read';
// S1: the file card draws `write` as a document too, and it is painted only while the bridge's
// `Card tools` line answers that this design draws the tool being drawn — an answer the bridge
// derives from the line's own `tools`. So `write` is DECLARED here, for that question alone: the
// design paints nothing for it, because `computeActivity` knows only bash and the read-only shell
// marks and answers `undefined` for any other tool, which hands the host's rows back untouched.
const WRITE_TOOL = 'write';

// The bridge keeps ONE persisted value per tool, in its own store (`bridge-tool-designs` →
// `selections` → `{ "bash": <design id> }`, documented in the bridge's contract). It has no notion
// of a default design: an absent value reads `native`. So a first run would open on `native`
// unless this package offers `activity` once, itself.
const BRIDGE_SELECTION_STORE = 'bridge-tool-designs';
const BRIDGE_SELECTION_KEY = 'selections';
// This package's own marker that `activity` was already offered on this machine. Without it a
// user who later picks `native` would get `activity` back on the next load.
const OWN_STORE = 'odd-worktree';
const SEEDED_KEY = 'bashActivitySeeded';

// The outline frame's side and closing rules: a `$` on such a row is output, never a heading.
const FRAME_BODY_STARTS = new Set(['│', '╰']);

const isWordCharacter = (char) => /[\p{L}\p{N}]/u.test(char);

/** `ctrl+o to expand`-style hints the host prints after the fill. */
const HOST_HINT = /^[\s─╮╯│]*(?:(?:ctrl\+\w+|click|enter) to \w+[\s─╮╯│]*)?$/iu;
// Where the text a heading carries ends and the host's fill begins: two spaces, or a space and a rule.
const FILL_START = / {2,}| ─+/u;

/**
 * The text a heading row shows IN FULL — a bash command, or a read-only tool's arguments — or
 * `undefined` when it cannot be proved: an abbreviation, a fold, text after it that is not the
 * host's fill or hint, or none at all.
 */
function drawnText(chars, textStart) {
  const body = chars
    .slice(textStart)
    .map((entry) => entry.char)
    .join('');
  const fill = FILL_START.exec(body);
  const rest = fill === null ? '' : body.slice(fill.index);
  if (!HOST_HINT.test(rest)) return undefined;
  const text = (fill === null ? body : body.slice(0, fill.index)).replace(/ \(timeout \d+s\)$/u, '').trim();
  if (text === '' || text.endsWith('…') || /…\s*\+\d+ lines?$/u.test(text)) return undefined;
  return text;
}

// Pi repaints every retained card on every frame, and a long session keeps hundreds of them, so
// the work of a frame must be a lookup: the classification of one command, and the whole answer
// for one (rows, call state, theme) pair. Both caches are bounded and drop the oldest entry.
const MEMO_LIMIT = 512;
const classifyMemo = new Map();
const applyMemo = new Map();

function remember(memo, key, value) {
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value);
  memo.set(key, value);
  return value;
}

/** `inferBashActivity` with a bounded memo: one command is classified once, not once per frame. */
function classify(command) {
  if (classifyMemo.has(command)) return classifyMemo.get(command);
  return remember(classifyMemo, command, inferBashActivity(command));
}

// The roles a drawing may paint with. A theme can change under the SAME object (Pi hands renderers
// a live theme), so the cache key carries what each role paints right now.
const THEME_ROLES = ['mdLink', 'mdHeading', 'syntaxFunction', 'success', 'warning', 'error', 'bashMode', 'dim'];

function themeFingerprint(theme) {
  if (theme === null || typeof theme !== 'object' || typeof theme.fg !== 'function') return '';
  return THEME_ROLES.map((role) => {
    try {
      return String(theme.fg(role, '.'));
    } catch {
      return '!';
    }
  }).join('');
}

// A heading that gives up the tail of its text for the label keeps at least this much of it.
const MIN_COMMAND_COLUMNS = 8;

/**
 * Where the text drawn after the mark ends and the host's fill begins, as indexes into `chars`:
 * the text is `[bodyStart, end)` and the fill run is `[fillStart, fillStart + fillLength)`. The fill
 * is two spaces, or the rules after one space, exactly as `drawnText` splits it.
 */
function commandExtent(chars, bodyStart) {
  let end = chars.length;
  for (let index = bodyStart; index < chars.length; index += 1) {
    if (chars[index].char !== ' ') continue;
    const next = chars[index + 1]?.char;
    if (next === ' ' || next === '─') {
      end = index;
      break;
    }
  }
  if (end >= chars.length) return { bodyStart, end, fillStart: end, fillLength: 0 };
  const fillChar = chars[end + 1].char === '─' ? '─' : ' ';
  const fillStart = fillChar === '─' ? end + 1 : end;
  let fillLength = 0;
  while (
    fillStart + fillLength < chars.length &&
    chars[fillStart + fillLength].char === fillChar &&
    (fillLength === 0 || chars[fillStart + fillLength].raw === chars[fillStart + fillLength - 1].raw + 1)
  ) {
    fillLength += 1;
  }
  return { bodyStart, end, fillStart, fillLength };
}

/**
 * Where the host's trailing timeout badge begins, as an index into `chars`: the badge's leading
 * space when the text `[bodyStart, end)` ends with a ` (timeout 120s)`-shaped one, else `end`. The
 * host draws that badge itself, after the command and in its own colour, as fixed metadata about the
 * call: a cut that stops here frees columns from the command only, because shortening the badge
 * loses information the command text cannot give the reader back. The shape is the one `drawnText`
 * strips from a heading.
 */
function timeoutBadgeStart(chars, bodyStart, end) {
  const text = chars
    .slice(bodyStart, end)
    .map((entry) => entry.char)
    .join('');
  const badge = / \(timeout \d+s\)$/u.exec(text);
  if (badge === null) return end;
  return bodyStart + Array.from(text.slice(0, badge.index)).length;
}

/**
 * How to free `need` columns from the tail of the text `[bodyStart, end)`: text the host already
 * abbreviated (`…`, or `… +N lines`) loses characters BEFORE that mark; text shown in full gets an
 * ellipsis of its own, because the heading is a preview and the expanded call shows the rest.
 * `undefined` when too little of the text would be left to be worth showing.
 */
function planCommandCut(chars, bodyStart, end, need) {
  let stop = end;
  let ownEllipsis = true;
  for (let index = end - 1; index >= bodyStart; index -= 1) {
    if (chars[index].char !== '…') continue;
    const after = chars.slice(index + 1, end).map((entry) => entry.char).join('');
    if (after === '' || /^\s*\+\d+ lines?$/u.test(after)) {
      stop = index;
      ownEllipsis = false;
    }
    break;
  }
  const goal = need + (ownEllipsis ? 1 : 0);
  let from = stop;
  let removed = 0;
  while (from > bodyStart && removed < goal) {
    from -= 1;
    removed += charColumns(chars[from].char);
  }
  if (removed < goal) return undefined;
  const kept = chars.slice(bodyStart, from).reduce((sum, entry) => sum + charColumns(entry.char), 0);
  if (kept < MIN_COMMAND_COLUMNS) return undefined;
  // A wide character removed past the goal is paid back in spaces, so the row keeps its width.
  return { from, stop, insert: `${ownEllipsis ? '…' : ''}${' '.repeat(removed - goal)}` };
}

/**
 * Bash's mark: the `$` and its one gap. `undefined` on a row whose `$` is not a heading mark, or
 * that has none. `textStart` is where the command begins.
 */
function bashMark(chars) {
  const start = chars.findIndex((entry) => entry.char === MARK);
  if (start < 0 || chars[start + 1]?.char !== ' ') return undefined;
  return { start, end: start + 1, textStart: start + 2 };
}

/**
 * A read-only tool's mark: its own glyph, one gap and its name. `undefined` for a row headed any
 * other way. `textStart` is where the arguments begin.
 */
function toolMark(chars, tool) {
  const glyph = READ_TOOL_GLYPHS.get(tool);
  if (glyph === undefined) return undefined;
  const start = chars.findIndex((entry) => entry.char === glyph);
  if (start < 0) return undefined;
  const end = start + 2 + tool.length;
  const name = chars.slice(start + 1, end).map((entry) => entry.char).join('');
  if (name !== ` ${tool}`) return undefined;
  if (end < chars.length && chars[end].char !== ' ') return undefined;
  return { start, end, textStart: end + 1 };
}

/**
 * The card's heading row: the first row carrying text, the design's own mark on it, and whether
 * every other row carries no text at all (any other row with text is a continuation of the same
 * heading, or output, so the heading alone is never the whole evidence).
 */
function headingSite(lines, leading, mark) {
  let row = -1;
  let chars = [];
  for (const [index, line] of lines.entries()) {
    const candidates = visibleChars(line);
    if (!candidates.some((entry) => isWordCharacter(entry.char) || entry.char === leading)) continue;
    row = index;
    chars = candidates;
    break;
  }
  if (row < 0) return undefined;
  const at = mark(chars);
  if (at === undefined) return undefined;
  const first = chars.find((entry) => entry.char.trim() !== '');
  if (first !== undefined && FRAME_BODY_STARTS.has(first.char)) return undefined;
  // A blank row first is Pi's native result component, never the card's top.
  for (const previous of lines.slice(0, row)) {
    if (visibleChars(previous).every((entry) => entry.char.trim() === '')) return undefined;
  }
  const before = chars.slice(0, at.start).map((entry) => entry.char).join('');
  if (!/^[^\p{L}\p{N}]*$/u.test(before)) return undefined;
  const sole = !lines.some(
    (line, index) => index !== row && visibleChars(line).some((entry) => isWordCharacter(entry.char)),
  );
  return { row, chars, at, sole };
}

// What a call nothing can name is headed with: the host's `$` mark, the word `bash` and the
// role the host paints its own bash identity in.
const GENERIC_IDENTITY = { glyph: '$', titleRole: 'bashMode' };
const GENERIC_WORD = 'bash';

/** The heading text for an identity: its mark, one gap and its word. */
function headingText(identity, word) {
  return `${identity.glyph}${identity.glyph.endsWith(' ') ? '' : ' '}${word}`;
}

/**
 * The label painted in its theme ROLE, or the plain text when the theme cannot paint (absent,
 * throws, or hands back something that no longer contains the text). Pure colour: the visible
 * columns are the text's own either way.
 */
function paintLabel(theme, role, text) {
  try {
    if (theme === null || typeof theme !== 'object' || typeof theme.fg !== 'function') return text;
    const painted = theme.fg(role, text);
    return typeof painted === 'string' && painted.includes(text) ? painted : text;
  } catch {
    return text;
  }
}

/**
 * What one covered tool's card is headed with, and how its evidence is read: `mark` finds the
 * design's own mark on the heading row, `activity` turns the proven text into a family (`undefined`
 * when nothing names it), and `generic` is the fallback word a tool keeps for a call it cannot
 * prove — bash's `$ bash`. A read-only shell tool's word never depends on the text, so it passes a
 * constant and has no fallback of its own. A tool the design only DECLARES (`read`, `write`) has no
 * spec at all: its rows keep the heading the host drew.
 */
function toolHeadingSpec(tool, render) {
  if (tool === TOOL_NAME) {
    const command = renderedCommand(render);
    return {
      leading: MARK,
      mark: bashMark,
      evidenced: command !== undefined,
      // The real arguments are the evidence when the bridge hands them over: nothing the host
      // truncated or wrapped can hide the command. Without them the drawn heading must prove it.
      command,
      activity: classify,
      generic: true,
    };
  }
  if (!READ_TOOL_GLYPHS.has(tool)) return undefined;
  return {
    leading: READ_TOOL_GLYPHS.get(tool),
    mark: (chars) => toolMark(chars, tool),
    evidenced: hasRenderedArguments(render),
    command: undefined,
    activity: () => EXPLORING,
    generic: false,
  };
}

/**
 * The heading step: the rows with the design's mark swapped for an identity label, or `undefined`
 * when the label cannot be paid for or (for a read-only tool) the heading is not the whole
 * evidence. bash keeps its generic `$ bash` for a call nothing names.
 */
function applyHeading(lines, ctx, spec) {
  const site = headingSite(lines, spec.leading, spec.mark);
  if (site === undefined) return undefined;
  let activity;
  if (spec.evidenced) {
    activity = spec.activity(spec.command);
  } else {
    // Without the bridge's arguments the drawn heading is the only evidence, and it must show the
    // whole text: no abbreviation, no fold, no continuation row.
    const drawn = site.sole ? drawnText(site.chars, site.at.textStart) : undefined;
    if (drawn === undefined && !spec.generic) return undefined;
    activity = drawn === undefined ? undefined : spec.activity(drawn);
  }
  const identity = activity === undefined ? GENERIC_IDENTITY : SHELL_ACTIVITY_IDENTITY[activity];
  if (identity === undefined) return undefined;
  const heading = headingText(identity, activity ?? GENERIC_WORD);
  const markText = site.chars.slice(site.at.start, site.at.end).map((entry) => entry.char).join('');
  const extra = textColumns(heading) - textColumns(markText);
  if (extra < 0) return undefined;

  const row = lines[site.row];
  const paid = payForLabel(row, site.chars, site.at, extra);
  if (paid === undefined) return undefined;
  const markEnd = site.chars[site.at.end - 1];
  const markTo = markEnd.raw + markEnd.char.length;
  // The role paints the label only; the escapes the host had in force where the text after the mark
  // begins are issued again after it, so that text keeps the host's own paint.
  const painted = paintLabel(ctx.theme, identity.titleRole, heading);
  const label = painted === heading ? heading : `${painted}${sgrBefore(row, markTo)}`;
  const markFrom = site.chars[site.at.start].raw;
  const next = `${paid.slice(0, markFrom)}${label}${paid.slice(markTo)}`;
  if (rowColumns(next) !== rowColumns(row)) return undefined;
  return [...lines.slice(0, site.row), next, ...lines.slice(site.row + 1)];
}

/**
 * `row` with its heading mark removed and `extra` columns freed: the host's fill pays first (one
 * rule column always stays), and the tail of the command hidden after the mark only for what the
 * fill cannot — never the timeout badge the host draws after it.
 * Later offsets go first, so every raw offset still to be used stays valid. `undefined` when the
 * label cannot be paid for while the row keeps its width.
 */
function payForLabel(row, chars, at, extra) {
  const extent = commandExtent(chars, at.textStart);
  const take = Math.min(extra, Math.max(0, extent.fillLength - 1));
  const cut =
    extra - take > 0
      ? planCommandCut(chars, at.textStart, timeoutBadgeStart(chars, at.textStart, extent.end), extra - take)
      : null;
  if (cut === undefined) return undefined;
  let next = row;
  const fillTail = chars.slice(extent.fillStart + extent.fillLength - take, extent.fillStart + extent.fillLength);
  for (const entry of [...fillTail].reverse()) next = `${next.slice(0, entry.raw)}${next.slice(entry.raw + entry.char.length)}`;
  if (cut !== null) {
    for (const entry of chars.slice(cut.from, cut.stop).reverse()) {
      next = `${next.slice(0, entry.raw)}${next.slice(entry.raw + entry.char.length)}`;
    }
    const at = chars[cut.from].raw;
    next = `${next.slice(0, at)}${cut.insert}${next.slice(at)}`;
  }
  return next;
}

/** The role the whole frame wears: the call's state speaks first, the identity once idle. */
function frameRole(render, identity) {
  if (render.isPartial === true) return 'warning';
  if (render.isError === true) return 'error';
  return identity.titleRole;
}

/** The command the bridge says this call runs, or `undefined`. */
function renderedCommand(render) {
  const command = render?.args?.command;
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}

/** Whether a theme can paint at all: a role the theme cannot colour changes nothing. */
function canPaint(theme, role) {
  return paintLabel(theme, role, '─') !== '─';
}

/**
 * Whether the bridge handed over this call's arguments. Every `grep`/`find`/`ls` wears the same word
 * whatever it reads, so its arguments are not evidence of WHAT the call is — only of the fact that
 * the design is not depending on a heading the host may have wrapped or abbreviated.
 */
function hasRenderedArguments(render) {
  const args = render?.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  return Object.values(args).some(
    (value) => (typeof value === 'string' && value !== '') || typeof value === 'number',
  );
}

/**
 * The design's whole behaviour. Returns the host's rows with the heading's mark replaced by an
 * identity label — the activity the call names, or bash's `$ bash` — the frame painted in one role,
 * and a finished call's duration on its closing rule; or a copy of them exactly as given when
 * anything is unproven. Any other tool's rows are returned untouched.
 *
 * S6: a call whose `path` is a skill or an ODD artifact is the FILE card's row — that card draws its
 * own heading and its own frame — so both parts come back exactly as the host drew them, whichever
 * resolver runs first. The classification is `lib/skill-odd-card.js`'s, so the two surfaces can never
 * disagree about which paths those are. A read is never painted here at all (it is declared for
 * coverage alone, `READ_TOOL`), so every read row is the host's or that card's, never a status line of
 * this design's.
 */
function computeActivity(lines, ctx) {
  const unchanged = () => (Array.isArray(lines) ? [...lines] : []);
  try {
    if (!Array.isArray(lines) || ctx === null || typeof ctx !== 'object') return unchanged();
    const render = ctx.render !== null && typeof ctx.render === 'object' ? ctx.render : undefined;
    const path = render?.args?.path;
    if (fileCardIdentity(path) !== undefined) return unchanged();
    const spec = toolHeadingSpec(ctx.tool, render);
    if (spec === undefined) return unchanged();
    // The frame and the duration wear the identity the CALL's own evidence names, which is what the
    // heading shows whenever the design could head it at all.
    const known = spec.evidenced ? spec.activity(spec.command) : undefined;
    const identity = known === undefined ? GENERIC_IDENTITY : SHELL_ACTIVITY_IDENTITY[known];
    let out = [...lines];
    if (ctx.part !== 'result') out = applyHeading(out, ctx, spec) ?? out;
    if (render !== undefined && spec.evidenced) {
      const role = frameRole(render, identity);
      const elapsed = ctx.part === 'result' && render.isPartial !== true ? cardElapsed(render.durationMs) : undefined;
      if (elapsed !== undefined && out.length > 0 && canPaint(ctx.theme, 'dim')) {
        const last = elapsedRow(out[out.length - 1], elapsed, (text) => paintLabel(ctx.theme, 'dim', text));
        if (last !== undefined) out = [...out.slice(0, -1), last];
      }
      if (canPaint(ctx.theme, role)) out = out.map((row) => paintFrame(row, (text) => paintLabel(ctx.theme, role, text)));
    }
    if (out.length !== lines.length || out.some((row, index) => rowColumns(row) !== rowColumns(lines[index]))) return unchanged();
    return out;
  } catch {
    return unchanged();
  }
}

/**
 * The design's entry point: `computeActivity` behind a bounded memo. The key is everything the
 * drawing reads: the tool and part, the host's rows, what each theme role paints now, and the
 * call's arguments and state. A caller always gets a fresh array.
 */
function applyBashActivityHeading(lines, ctx) {
  try {
    if (!Array.isArray(lines) || ctx === null || typeof ctx !== 'object') return computeActivity(lines, ctx);
    const render = ctx.render !== null && typeof ctx.render === 'object' ? ctx.render : undefined;
    const call = render === undefined
      ? '-'
      : [renderedCommand(render) ?? '', hasRenderedArguments(render) ? '1' : '', render.isPartial, render.isError, render.durationMs, render.args?.path ?? ''].join('\u0001');
    const key = [ctx.tool, ctx.part, themeFingerprint(ctx.theme), call, lines.join('\n')].join('\u0000');
    const hit = applyMemo.get(key);
    if (hit !== undefined) return [...hit];
    return [...remember(applyMemo, key, computeActivity(lines, ctx))];
  } catch {
    return Array.isArray(lines) ? [...lines] : [];
  }
}

// The read-only picture `/gentle:customize` draws while `activity` is highlighted.
const BASH_DESIGN_PREVIEW = {
  title: `Cards · ${BASH_DESIGN_LABEL}`,
  // One row, like every other Cards preview: the families a heading can wear.
  sample: '⌕ exploring  ✓ checking  ⎇ versioning  ↑ publishing  ⚠ destructive',
};

/** The single `bash` design an older bridge can take: one `Card bash` line, bash only. */
function bashActivityDesign() {
  return {
    tool: TOOL_NAME,
    id: BASH_DESIGN_ID,
    name: BASH_DESIGN_PLUGIN_NAME,
    label: BASH_DESIGN_LABEL,
    description: 'heads a bash card with the activity its command names',
    preview: () => ({ ...BASH_DESIGN_PREVIEW }),
    apply: applyBashActivityHeading,
  };
}

/**
 * The grouped registration: ONE `Card tools` line over bash, the three read-only shell tools, `read`
 * and `write`. The bridge names the row after the line (`Card tools`), keeps `default` first and
 * stores the choice under its own reserved key, so the per-tool value stays where an older bridge put
 * it.
 *
 * `read` and `write` are on the line so the file card can ask about them (S1): the card is the only
 * surface that draws either, and it is painted only while this line answers for that tool. This design
 * never heads a read or a write itself — `computeActivity` answers `undefined` for a tool it knows no
 * mark for, so their rows come back exactly as the host drew them.
 */
function toolsActivityDesign() {
  return {
    line: TOOLS_LINE,
    tools: [TOOL_NAME, ...READ_TOOL_GLYPHS.keys(), READ_TOOL, WRITE_TOOL],
    id: BASH_DESIGN_ID,
    name: BASH_DESIGN_PLUGIN_NAME,
    label: BASH_DESIGN_LABEL,
    description: 'heads a tools card with the activity its call names; the read-only shell tools are always exploring',
    preview: () => ({ ...BASH_DESIGN_PREVIEW }),
    apply: applyBashActivityHeading,
  };
}

/**
 * Whether a published bridge can take one line over several tools. Read defensively: a bridge with
 * no release string, or one this cannot read as a release, is treated as the older shape, because a
 * grouped registration there is REFUSED and recorded, which is worse than the extra `Card bash` row.
 */
/**
 * Ask the bridge itself, once, when its release string cannot be read: a grouped registration that
 * is accepted and disposed is the capability, whatever the version says. An older bridge refuses it
 * and records a rejection, which is why this runs only in that gap and never beside a readable
 * release.
 */
function probeToolLines(api) {
  try {
    const dispose = api.registerToolDesign({
      line: PROBE_LINE,
      tools: [PROBE_TOOL],
      id: PROBE_DESIGN_ID,
      label: 'probe',
      apply: (lines) => [...lines],
    });
    if (typeof dispose === 'function') dispose();
    return true;
  } catch {
    return false;
  }
}

function bridgeSupportsToolLines(api) {
  const version = api?.VERSION;
  if (typeof version !== 'string') return probeToolLines(api);
  const parts = version.split('.').slice(0, 3).map((part) => {
    const digits = /^\d+/.exec(part);
    return digits === null ? Number.NaN : Number(digits[0]);
  });
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return probeToolLines(api);
  const [major, minor, patch = 0] = parts;
  if (major !== TOOLS_LINE_VERSION[0]) return major > TOOLS_LINE_VERSION[0];
  if (minor !== TOOLS_LINE_VERSION[1]) return minor > TOOLS_LINE_VERSION[1];
  return patch >= TOOLS_LINE_VERSION[2];
}

/**
 * Select `activity` ONCE, on the first load that finds no choice. Returns whether it wrote the
 * selection. A choice already stored, `native` included, is never touched, and the marker is
 * written only after the selection (or after finding one), so a failed write is tried again on the
 * next load. Never throws: the design is cosmetic. It never writes the bridge's reserved line key:
 * the bridge's own registration-time migration carries a `bash` choice over to the line.
 */
function seedBashDesignSelection(api) {
  try {
    if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return false;
    const own = api.createStore(OWN_STORE);
    if (own.get(SEEDED_KEY, false) === true) return false;
    const bridge = api.createStore(BRIDGE_SELECTION_STORE);
    const stored = bridge.get(BRIDGE_SELECTION_KEY, {});
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
    if (Object.hasOwn(stored, TOOL_NAME)) {
      own.set(SEEDED_KEY, true);
      return false;
    }
    bridge.set(BRIDGE_SELECTION_KEY, { ...stored, [TOOL_NAME]: BASH_DESIGN_ID });
    own.set(SEEDED_KEY, true);
    return true;
  } catch {
    return false;
  }
}

// The registration this process made: a second call is the same design, never two.
let designDisposer = null;

/**
 * Register the design on a bridge that can take one and hand back the idempotent disposer, or
 * `null` when the bridge is absent or older than `registerToolDesign`. Never throws.
 *
 * The shape is decided BEFORE anything is registered: one `Card tools` line on a bridge that can
 * take one, today's single `Card bash` design on anything older. The seed runs BEFORE the
 * registration too, because a 0.6.0 bridge inherits a joining tool's legacy per-tool choice into
 * the line's own value at REGISTRATION time — a choice written after would be missed.
 */
function registerBashDesign(api) {
  if (api === null || typeof api !== 'object' || typeof api.registerToolDesign !== 'function') return null;
  if (designDisposer !== null) return designDisposer;
  seedBashDesignSelection(api);
  let registered;
  try {
    registered = api.registerToolDesign(bridgeSupportsToolLines(api) ? toolsActivityDesign() : bashActivityDesign());
  } catch {
    return null;
  }
  const dispose = typeof registered === 'function' ? registered : () => {};
  let disposed = false;
  designDisposer = () => {
    if (disposed) return;
    disposed = true;
    designDisposer = null;
    try {
      dispose();
    } catch {
      // A failed removal leaves the design registered; it never breaks the host.
    }
  };
  return designDisposer;
}

module.exports = {
  BASH_DESIGN_ID,
  BASH_DESIGN_LABEL,
  applyBashActivityHeading,
  bashActivityDesign,
  registerBashDesign,
  seedBashDesignSelection,
  toolsActivityDesign,
};

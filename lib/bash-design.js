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
// So the frame is the host's by construction, the choice is the bridge's own `Card activity` line in
// `/gentle:customize` → `Cards` (`default` | `activity`), it is read on every paint so cards
// already on screen repaint when it changes, and extension load order does not matter.
//
// ONE line covers eleven tools. `bash`'s heading names what its command does; the three read-only
// shell tools the line covers (`grep`, `find`, `ls`) only ever read, so their heading is always
// `exploring` whatever their arguments are. `read`, `write` and `edit` are declared for a different reason:
// the file card is painted only while the bridge's line resolves to this design for the tool being
// drawn, and the bridge resolves coverage from this list, so a read, a write and an edit have to be
// named here for the file card to be asked about them. The design itself paints nothing for any of
// them (see
// `READ_TOOL`, `WRITE_TOOL` and `EDIT_TOOL`): `exploring` names what a SHELL COMMAND does, and a read
// is not one, so a read card comes back exactly as the host drew it.
// `write` and `edit` are also SCOPEd to the paths the file card itself claims (`FILE_CARD_SCOPE`),
// so this line owns only the writes and edits of a skill or an ODD artifact and every other one is
// another line's call: one unscoped claim plus any number of scoped ones is what the bridge allows.
// A bridge older than the line (0.6.0) takes exactly the single `bash` design it always took, and one
// older than a scoped claim (0.9.0) takes today's unscoped list, so nothing regresses and no
// registration is ever refused.
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
const { fileCardIdentity, FILE_CARD_TOOLS } = require('./skill-odd-card.js');
// The four background-job tools: the jobs card (`lib/jobs-card.js`) draws them, and it is painted
// only while this line answers that this design draws the tool being drawn.
const { JOB_TOOLS } = require('./jobs-card.js');
const { CODEGRAPH_MCP_PREFIXED_TOOL, CODEGRAPH_MCP_TOOL, CODEGRAPH_TOOL } = require('./codegraph-card.js');
// Both spellings the host reports for the same program, plus the native tool: one card, one line.
const CODEGRAPH_TOOLS = Object.freeze([CODEGRAPH_TOOL, CODEGRAPH_MCP_TOOL, CODEGRAPH_MCP_PREFIXED_TOOL]);
const { cardElapsed, charColumns, elapsedRow, paintFrame, rowColumns, sgrBefore, textColumns, visibleChars } = require('./bash-frame.js');

const TOOL_NAME = 'bash';
// The bridge line every covered tool is switched by. The bridge names the row `Card <line>` — a line
// has no label of its own — so this key IS the row: `Card tools` -> `Card activity` (S10) -> `Card activity`
// (S3 of modular-tools, the human's own call on the name). The stored choice follows in
// `carryOverLineSelection`, once per rename.
const TOOLS_LINE = 'activity';
// The line keys this package shipped before, newest first. Read only by the one-time carry-over.
const PREVIOUS_TOOLS_LINES = Object.freeze(['tags', 'tools']);
// The bridge release that can take one line over several tools; earlier ones refuse a grouped
// registration and record the refusal, so the shape is chosen BEFORE anything is registered.
const TOOLS_LINE_VERSION = [0, 6, 0];
// The bridge release that can take a per-(line, tool) SCOPE; earlier ones refuse a scoped
// registration WHOLE, which would cost the user the `activity` design itself, so the claim on
// `write` and `edit` is narrowed only where the release is known to read it.
const SCOPED_CLAIMS_VERSION = [0, 9, 0];
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
// `Card activity` line answers that this design draws the tool being drawn — an answer the bridge
// derives from the line's own `tools`. So `write` is DECLARED here, for that question alone: the
// design paints nothing for it, because `computeActivity` knows only bash and the read-only shell
// marks and answers `undefined` for any other tool, which hands the host's rows back untouched.
const WRITE_TOOL = 'write';
// S3: `edit` is the third tool the file card owns, and until a scoped claim existed the bridge could
// not let this line name it without also taking every edit in the session. It is declared for the
// same reason as `write`, and scoped with it (`FILE_CARD_SCOPE`), so an edit of a skill or an ODD
// artifact wears the file card for the first time and every other edit stays another line's call.
const EDIT_TOOL = 'edit';
// The tools of the line, in the order they have always been declared; the scoped shape appends the
// tool that only a scoped claim can carry.
// The background-job tools are declared for the same reason as `read` and `write`: the jobs card is the
// only surface that draws them, and it is painted only while this line resolves to this design for them.
// `computeActivity` knows no mark for them, so the design itself returns their rows exactly as drawn.
// The two CodeGraph tools are declared for the same reason (modular-tools S11): the CodeGraph card is a
// DESIGN, so the line is what claims the tool it paints, and `not-covered` would be a card nobody
// could ever switch on. `computeActivity` answers no mark for them either, so the design paints
// nothing of its own there.
const LINE_TOOLS = [
  TOOL_NAME,
  ...READ_TOOL_GLYPHS.keys(),
  READ_TOOL,
  WRITE_TOOL,
  ...JOB_TOOLS,
  ...CODEGRAPH_TOOLS,
];

// The bridge keeps ONE persisted value per tool, in its own store (`bridge-tool-designs` →
// `selections` → `{ "bash": <design id> }`, documented in the bridge's contract), and one per LINE
// under the reserved `$lines` key of that same document (`selections.$lines[lineKey]`). It has no
// notion of a default design: an absent value reads `native`. So a first run would open on `native`
// unless this package offers `activity` once, itself.
const BRIDGE_SELECTION_STORE = 'bridge-tool-designs';
const BRIDGE_SELECTION_KEY = 'selections';
// The reserved key INSIDE that value holding the per-line map: a tool name can never be `$lines`, so
// the per-tool map and the per-line one are one document and one `get` (the bridge's own choice, D6).
const BRIDGE_LINES_KEY = '$lines';
// This package's own marker that `activity` was already offered on this machine. Without it a
// user who later picks `native` would get `activity` back on the next load.
const OWN_STORE = 'odd-worktree';
const SEEDED_KEY = 'bashActivitySeeded';

// The outline frame's side and closing rules: a `$` on such a row is output, never a heading.
const FRAME_BODY_STARTS = new Set(['│', '╰']);

/**
 * S3: the scope of this line's claim on `write` and `edit` — exactly the calls whose path the FILE
 * CARD claims, which is `lib/skill-odd-card.js`'s own rule and never a path test copied here. ONE
 * object for both tools, so the two claims can never come to disagree about which files those are.
 * Cheap and pure, and it reads only the stable `args.path` (never a body Pi rewrites while the call
 * streams); a throw is the bridge's to isolate, and this one answers `false` instead.
 */
const FILE_CARD_SCOPE = Object.freeze({
  description: 'paths under skills/ or odd/',
  matches(call) {
    try {
      return fileCardIdentity(call?.args?.path) !== undefined;
    } catch {
      return false;
    }
  },
});

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
 * disagree about which paths those are, and so is the list of tools that card claims (`read`, `edit`,
 * `write`): a `grep` or an `ls` that names a skill's path is no file card's row, so this design keeps
 * drawing it. A read is never painted here at all (it is declared for coverage alone, `READ_TOOL`), so
 * every read row is the host's or that card's, never a status line of this design's.
 */
function computeActivity(lines, ctx) {
  const unchanged = () => (Array.isArray(lines) ? [...lines] : []);
  try {
    if (!Array.isArray(lines) || ctx === null || typeof ctx !== 'object') return unchanged();
    const render = ctx.render !== null && typeof ctx.render === 'object' ? ctx.render : undefined;
    const path = render?.args?.path;
    // Only the tools the file card claims can be its row; every other tool's path is this
    // design's to head and frame as it always did.
    if (FILE_CARD_TOOLS.includes(ctx.tool) && fileCardIdentity(path) !== undefined) return unchanged();
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
// S4 (modular-tools): the preview's TITLE is the line's own name — what the bridge shows for the
// `default` value — so the two options of one line read as one line, and the SAMPLE is what tells
// them apart. The bridge derives the row from the line key (`Card <line>`), so the title is derived
// from the same key here and can never drift from it.
const cardRowName = (line) => `Card ${line}`;
const TOOLS_DESIGN_PREVIEW = {
  title: `Cards · ${cardRowName(TOOLS_LINE)}`,
  // One row, like every other Cards preview: the families a heading can wear.
  sample: '⌕ exploring  ✓ checking  ⎇ versioning  ↑ publishing  ⚠ destructive',
};
// The older single-tool registration names its own implicit line (`Card bash`).
const BASH_DESIGN_PREVIEW = {
  title: `Cards · ${cardRowName(TOOL_NAME)}`,
  sample: TOOLS_DESIGN_PREVIEW.sample,
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
 * The grouped registration: ONE `Card activity` line over bash, the three read-only shell tools, `read`,
 * `write` and, where the bridge can take a scope, `edit`. The bridge names the row after the line
 * (`Card activity`), keeps `default` first and stores the choice under its own reserved key, so the
 * per-tool value stays where an older bridge put it.
 *
 * `read`, `write` and `edit` are on the line so the file card can ask about them (S1/S3): the card is
 * the only surface that draws them, and it is painted only while this line answers for that tool.
 * This design never heads a read, a write or an edit itself — `computeActivity` answers `undefined`
 * for a tool it knows no mark for, so their rows come back exactly as the host drew them.
 *
 * `{ scopes: false }` is the registration a bridge older than 0.9.0 can take (S6): today's tools, no
 * scope, so `write` keeps its whole claim there and `edit` is not registered at all.
 */
function toolsActivityDesign(options) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const scoped = settings.scopes !== false;
  const design = {
    line: TOOLS_LINE,
    tools: scoped ? [...LINE_TOOLS, EDIT_TOOL] : [...LINE_TOOLS],
    id: BASH_DESIGN_ID,
    name: BASH_DESIGN_PLUGIN_NAME,
    label: BASH_DESIGN_LABEL,
    description: 'heads a tools card with the activity its call names; the read-only shell tools are always exploring',
    preview: () => ({ ...TOOLS_DESIGN_PREVIEW }),
    apply: applyBashActivityHeading,
  };
  // The scope belongs to the `(line, tool)` claim, so it is added only where the bridge reads it and
  // never as an empty map: a bridge older than a scope refuses a registration that carries one whole.
  if (scoped) design.scopes = { [WRITE_TOOL]: FILE_CARD_SCOPE, [EDIT_TOOL]: FILE_CARD_SCOPE };
  return design;
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

/**
 * Whether the bridge's published release is at least `floor`, or `undefined` when the release string
 * cannot be read as one. Read defensively: another copy of the bridge, or a host that publishes no
 * release, must never be mistaken for a newer one.
 *
 * S6: a release string carrying a prerelease or a build suffix (`0.9.0-rc.1`, `0.9.0+build.7`) does
 * NOT meet a cutoff its own numbers equal. Semver puts a prerelease BELOW its release, and a refused
 * registration is worse than a missing row. Its numbers still clear a LOWER cutoff (`0.9.0-rc.1` is
 * above 0.6.0, so the grouped line stays), and a string that cannot be read at all stays `undefined`
 * so the caller can fall back to its own capability probe.
 */
function releaseAtLeast(version, floor) {
  if (typeof version !== 'string') return undefined;
  const parts = version.split('.').slice(0, 3).map((part) => {
    const digits = /^\d+/u.exec(part);
    return digits === null ? Number.NaN : Number(digits[0]);
  });
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const suffixed = !/^\d+(?:\.\d+){1,2}$/u.test(version);
  const [major, minor, patch = 0] = parts;
  if (major !== floor[0]) return major > floor[0];
  if (minor !== floor[1]) return minor > floor[1];
  if (patch !== floor[2]) return patch > floor[2];
  return !suffixed;
}

function bridgeSupportsToolLines(api) {
  const readable = releaseAtLeast(api?.VERSION, TOOLS_LINE_VERSION);
  return readable === undefined ? probeToolLines(api) : readable;
}

/**
 * Whether a published bridge can take a per-(line, tool) SCOPE (gentle-shell-bridge 0.9.0). A release
 * this cannot read answers NO: the probe above asks whether a GROUPED line is accepted, never whether
 * a scope is, and an unknown release that refused the scoped registration whole would take the
 * `activity` design away from every card — an unscoped line is the safer reading of an older bridge.
 */
function bridgeSupportsScopes(api) {
  return releaseAtLeast(api?.VERSION, SCOPED_CLAIMS_VERSION) === true;
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

/**
 * S10: carry a line value stored under an OLD line key over to the new one, ONCE, and report whether
 * it wrote. `Card tools` became `Card activity` and `Card activity` became `Card activity`, because the bridge
 * derives the row from the line key and has no rename or alias path of its own. The keys are read
 * NEWEST FIRST: the most recent rename wins, and a present-but-invalid value is no migration at all
 * rather than a reason to fall through to an older key.
 *
 * It cannot be left to the bridge's registration-time migration: that one runs only while the line has
 * NO value, and what it then copies is the legacy per-tool entry — the `bash` = `activity` this package
 * seeds on a first run. A user who chose `default` there would be handed `activity` back. So the copy
 * is made here, BEFORE the registration, and the bridge then finds its key taken and does nothing.
 *
 * Only `$lines[<old>]` is touched: the per-tool map and every other line are preserved as they are, and
 * a value already stored under the new key is never overwritten. The stored value must itself be one the
 * bridge reads as a choice — a non-empty, non-blank id string (`native` included), exactly its own
 * `storedId`; anything else (`42`, `null`, `{}`, `' '`) is carried NOWHERE, because the copy would write
 * garbage under the new key and delete the old one. Anything else — no store, no `createStore`, an
 * unreadable document, a shape this build does not know, a store that throws, an invalid value — is NO
 * migration: nothing is written, the document stays byte-identical, and nothing is thrown. Never throws:
 * the design is cosmetic.
 */
function carryOverLineSelection(api) {
  try {
    if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return false;
    const bridge = api.createStore(BRIDGE_SELECTION_STORE);
    const stored = bridge.get(BRIDGE_SELECTION_KEY, {});
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
    const lines = stored[BRIDGE_LINES_KEY];
    if (lines === null || typeof lines !== 'object' || Array.isArray(lines)) return false;
    if (Object.hasOwn(lines, TOOLS_LINE)) return false;
    const previous = PREVIOUS_TOOLS_LINES.find((key) => Object.hasOwn(lines, key));
    if (previous === undefined) return false;
    const chosen = lines[previous];
    if (typeof chosen !== 'string' || chosen.trim().length === 0) return false;
    const others = { ...lines };
    delete others[previous];
    bridge.set(BRIDGE_SELECTION_KEY, { ...stored, [BRIDGE_LINES_KEY]: { ...others, [TOOLS_LINE]: chosen } });
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
 * The shape is decided BEFORE anything is registered: one `Card activity` line on a bridge that can
 * take one, today's single `Card bash` design on anything older. The seed and the line-key carry-over
 * run BEFORE the registration too, because a 0.6.0 bridge inherits a joining tool's legacy per-tool
 * choice into the line's own value at REGISTRATION time — a choice written after would be missed, and a
 * line value left under the old key would be replaced there by that inherited legacy choice.
 */
function registerBashDesign(api) {
  if (api === null || typeof api !== 'object' || typeof api.registerToolDesign !== 'function') return null;
  if (designDisposer !== null) return designDisposer;
  seedBashDesignSelection(api);
  carryOverLineSelection(api);
  let registered;
  try {
    registered = api.registerToolDesign(
      bridgeSupportsToolLines(api) ? toolsActivityDesign({ scopes: bridgeSupportsScopes(api) }) : bashActivityDesign(),
    );
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
  // The line key itself, for a surface that must name the switch this design is selected on
  // (`lib/message-card.js` follows it) instead of re-typing it.
  TOOLS_LINE,
  applyBashActivityHeading,
  bashActivityDesign,
  carryOverLineSelection,
  registerBashDesign,
  seedBashDesignSelection,
  toolsActivityDesign,
};

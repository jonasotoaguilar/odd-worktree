'use strict';
// The bash activity DESIGN: the one way this package changes how a `bash` call is drawn.
//
// It is a `registerToolDesign` registration on gentle-shell-bridge's published API, not a
// renderer. The bridge owns Pi's one `registerToolRenderer` resolver, builds the HOST's own
// card (Gentle Shell's, in whatever style and content level is chosen) and hands this module
// the rows that card drew:
//
//     apply(lines, { width, tool, theme, part }) -> lines
//
// So the frame is the host's by construction, the choice is the bridge's own `bash` line in
// `/gentle:customize` → `Cards` (`native` | `activity`), it is read on every paint so cards
// already on screen repaint when it changes, and extension load order does not matter.
//
// What the design changes is exactly one thing, on the card's heading row: the host's `$` mark
// becomes the activity the command names — `⌕ exploring`, `✓ checking`, … — using the one
// classifier (`lib/bash-activity.js`). The columns the longer mark adds are taken back from the
// row's own fill, so the row keeps the width the host made it. Everything else comes back byte
// for byte.
//
// The rule is the classifier's: never guess. The heading is the only evidence this module has
// (the design context carries no arguments), so it names a call only when the heading provably
// shows the WHOLE command: no `…` abbreviation, no `… +N lines` fold, no continuation row, and
// nothing after the command but the host's own fill and hint. Anything else, and every command
// the classifier cannot name, is drawn exactly as the host drew it. Pure: no Pi, no theme, no
// colour, no filesystem — the heading keeps the host's own paint.

const { SHELL_ACTIVITY_IDENTITY, inferBashActivity } = require('./bash-activity.js');

const TOOL_NAME = 'bash';
// Stable across loads and unique per tool: a reload replaces this design, never stacks one.
const BASH_DESIGN_ID = 'odd-worktree.bash-activity';
// The value the user reads on the bridge's `bash` line, next to the reserved `native`.
const BASH_DESIGN_LABEL = 'activity';
const BASH_DESIGN_PLUGIN_NAME = 'Odd worktree';
const MARK = '$';

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
const ESCAPE = /\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/uy;

/** The row's visible characters with their raw offsets (SGR and OSC-8 skipped). */
function visibleChars(line) {
  const chars = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === '\u001b') {
      ESCAPE.lastIndex = index;
      const escape = ESCAPE.exec(line);
      if (escape !== null) {
        index += escape[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(line.codePointAt(index));
    chars.push({ char, raw: index });
    index += char.length;
  }
  return chars;
}

const isWordCharacter = (char) => /[\p{L}\p{N}]/u.test(char);

/** Columns one character takes: combining marks none, East Asian wide and emoji two. */
function charColumns(char) {
  const code = char.codePointAt(0);
  if (/\p{M}/u.test(char) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

const textColumns = (text) => Array.from(text).reduce((sum, char) => sum + charColumns(char), 0);
const rowColumns = (line) => visibleChars(line).reduce((sum, entry) => sum + charColumns(entry.char), 0);

/** `ctrl+o to expand`-style hints the host prints after the fill. */
const HOST_HINT = /^[\s─╮╯│]*(?:(?:ctrl\+\w+|click|enter) to \w+[\s─╮╯│]*)?$/iu;
// Where the command ends and the host's fill begins: two spaces, or a space and a rule.
const FILL_START = / {2,}| ─+/u;

/**
 * The command a heading row shows IN FULL, or `undefined` when it cannot be proved: an
 * abbreviation, a fold, text that is not the host's fill or hint after it, or no command.
 */
function headingCommand(chars, markIndex) {
  const text = chars
    .slice(markIndex + 1)
    .map((entry) => entry.char)
    .join('');
  if (!text.startsWith(' ')) return undefined;
  const body = text.slice(1);
  const fill = FILL_START.exec(body);
  const rest = fill === null ? '' : body.slice(fill.index);
  if (!HOST_HINT.test(rest)) return undefined;
  const command = (fill === null ? body : body.slice(0, fill.index)).replace(/ \(timeout \d+s\)$/u, '').trim();
  if (command === '' || command.endsWith('…') || /…\s*\+\d+ lines?$/u.test(command)) return undefined;
  return command;
}

/**
 * The row's widest contiguous run of spaces or rules, which is the host's fill. `undefined`
 * when no run is wider than the columns needed (the row would lose its fill or its command).
 */
function fillRun(chars, columns) {
  let best;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index].char;
    if (char !== ' ' && char !== '─') continue;
    let end = index;
    while (end + 1 < chars.length && chars[end + 1].char === char && chars[end + 1].raw === chars[end].raw + 1) end += 1;
    const length = end - index + 1;
    const before = chars[index - 1]?.char;
    const after = chars[end + 1]?.char;
    const bounded = (before === undefined || !isWordCharacter(before)) && (after === undefined || !isWordCharacter(after));
    if (length > columns && (best === undefined || length > best.length || (length === best.length && bounded && !best.bounded))) {
      best = { start: index, length, bounded };
    }
    index = end;
  }
  return best;
}

/** The mark of the card's heading and its row, or `undefined` for anything else. */
function headingSite(lines) {
  let row = -1;
  let chars = [];
  for (const [index, line] of lines.entries()) {
    const candidates = visibleChars(line);
    if (!candidates.some((entry) => isWordCharacter(entry.char) || entry.char === MARK)) continue;
    row = index;
    chars = candidates;
    break;
  }
  if (row < 0) return undefined;
  const markIndex = chars.findIndex((entry) => entry.char === MARK);
  if (markIndex < 0) return undefined;
  const first = chars.find((entry) => entry.char.trim() !== '');
  if (first !== undefined && FRAME_BODY_STARTS.has(first.char)) return undefined;
  // A blank row first is Pi's native result component, never the card's top.
  for (const previous of lines.slice(0, row)) {
    if (visibleChars(previous).every((entry) => entry.char.trim() === '')) return undefined;
  }
  const before = chars.slice(0, markIndex).map((entry) => entry.char).join('');
  if (!/^[^\p{L}\p{N}]*$/u.test(before)) return undefined;
  if (chars[markIndex + 1]?.char !== ' ') return undefined;
  // Any other row with text is a continuation of a longer command (or output): the heading
  // alone does not show what this call runs, so it is not named.
  for (const [index, line] of lines.entries()) {
    if (index !== row && visibleChars(line).some((entry) => isWordCharacter(entry.char))) return undefined;
  }
  return { row, chars, markIndex };
}

/** The heading text for a family: its mark, one gap and its word. */
function activityHeading(activity) {
  const identity = SHELL_ACTIVITY_IDENTITY[activity];
  if (identity === undefined) return undefined;
  return `${identity.glyph}${identity.glyph.endsWith(' ') ? '' : ' '}${activity}`;
}

/**
 * The design's whole behaviour. Returns the host's rows with the heading's `$` replaced by the
 * activity the command names, or a copy of them exactly as given when anything is unproven.
 */
function applyBashActivityHeading(lines, ctx) {
  const unchanged = () => (Array.isArray(lines) ? [...lines] : []);
  try {
    if (ctx?.tool !== TOOL_NAME || ctx.part === 'result') return unchanged();
    const site = headingSite(lines);
    if (site === undefined) return unchanged();
    const command = headingCommand(site.chars, site.markIndex);
    if (command === undefined) return unchanged();
    const activity = inferBashActivity(command);
    const heading = activity === undefined ? undefined : activityHeading(activity);
    if (heading === undefined) return unchanged();

    const extra = textColumns(heading) - 1;
    const fill = fillRun(site.chars, extra);
    if (fill === undefined) return unchanged();
    const row = lines[site.row];
    const mark = site.chars[site.markIndex];
    // Remove from the fill first (later offsets), then swap the mark: the offsets stay valid.
    const cut = site.chars.slice(fill.start + fill.length - extra, fill.start + fill.length);
    let next = row;
    for (const entry of [...cut].reverse()) next = `${next.slice(0, entry.raw)}${next.slice(entry.raw + entry.char.length)}`;
    next = `${next.slice(0, mark.raw)}${heading}${next.slice(mark.raw + MARK.length)}`;
    if (rowColumns(next) !== rowColumns(row)) return unchanged();
    return [...lines.slice(0, site.row), next, ...lines.slice(site.row + 1)];
  } catch {
    return unchanged();
  }
}

// The read-only picture `/gentle:customize` draws while `activity` is highlighted.
const BASH_DESIGN_PREVIEW = {
  title: `Cards · ${BASH_DESIGN_LABEL}`,
  sample: [
    "⌕ exploring   sed -n '1,40p' lib/app.js",
    '✓ checking    node --test tools/*.test.js',
    '⚠ destructive rm -rf build',
    '$ …           a command it cannot name keeps the host mark',
  ].join('\n'),
};

/** The one registration this package sends to the bridge. */
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
 * Select `activity` for `bash` ONCE, on the first load that finds no choice. Returns whether it
 * wrote the selection. A choice already stored, `native` included, is never touched, and the
 * marker is written only after the selection (or after finding one), so a failed write is tried
 * again on the next load. Never throws: the design is cosmetic.
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
 */
function registerBashDesign(api) {
  if (api === null || typeof api !== 'object' || typeof api.registerToolDesign !== 'function') return null;
  if (designDisposer !== null) return designDisposer;
  let registered;
  try {
    registered = api.registerToolDesign(bashActivityDesign());
  } catch {
    return null;
  }
  const dispose = typeof registered === 'function' ? registered : () => {};
  seedBashDesignSelection(api);
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
};

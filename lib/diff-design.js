'use strict';
// The `diff` DESIGN: the second `registerToolDesign` line this package contributes, over `write` and
// `edit`, drawn as an IDE pane in the ACTIVE THEME's own roles.
//
// It is the same shape as `lib/bash-design.js`: a registration on the shell API's published
// API, not a renderer. The shell API owns Pi's one `registerToolRenderer` resolver, builds the HOST's
// own card and hands this module the rows that card drew:
//
//     apply(lines, { width, tool, theme, part, render }) -> lines
//
// ONE line, `diff`, covers the two tools that change a file. `/gentle:customize` -> `Cards` draws
// it as `Card diff`, keeps the host's own card first as `default` (stored `native`) and shows this
// design's value as `color`. The line is UNSCOPED: the path scope belongs to the `Card activity`
// line's own claim on the same two tools (shell API 0.9.0 maps a scope to ONE
// (`line`, `tool`) claim, so one unscoped claim and any number of scoped ones coexist), and a call
// that line owns is painted by it before this one is asked.
//
// What it draws:
//   * `write` — an IDE pane built from the call's own `content`: a line-number gutter and the
//     syntax-highlighted body the host's highlighter paints (`agent.highlightCode` through the seam
//     `extensions/odd-worktree-tools.ts` hands over, exactly the one `/files` uses). Collapsed shows
//     the host's own budget (ten lines) and states the rest in a fold row; `ctx.render.expanded`
//     shows all of it. The pane is measured and clipped to the width it draws at as PLAIN text and
//     painted afterwards (invariant 17), so no painted row is ever measured or clipped.
//
//     WHERE it draws is the host's shape, not this module's. Gentle Shell's quiet tool card is
//     `renderShell: "self"` and splits one card across the two halves: the CALL rows are the frame's
//     top rule — the heading and, once the call finished, the host's own `ctrl+o to expand` hint —
//     and the RESULT rows are the body between the frame's sides plus the closing rule. So the call
//     half is handed back BYTE for BYTE (nothing of the host's frame or hint is lost), and the pane
//     is painted in the result half INSIDE that frame: the host's leading band row (float) and its
//     closing rule stay exactly as drawn, and every pane row reuses the host's own frame cells —
//     `│ `…` │` for neon, ` ▎ `…three columns for float — measured against the frame's inner width.
//     A host whose rows carry no frame (Pi's own shell draws the frame outside the renderer, so the
//     design only ever sees the body there) gets the whole pane from the call half instead, and the
//     host's own hint row, when it drew one, follows the fold row unchanged. No hint is ever
//     invented and none is ever dropped.
//   * `edit` — the host's own diff, recoloured and divided: every row that states a line gets the
//     same `N │ code` gutter the write pane draws, in the write pane's own role for the rule, and a
//     line the call DELETED is painted whole in the theme's `toolDiffRemoved` role and a line it
//     ADDED whole in `toolDiffAdded` — marker, number, divider and code — as `git diff` paints
//     them, so a changed row carries no syntax colour of its own. A context row keeps the gutter,
//     the divider and the code highlighted with the language `args.path` names; a hunk header is
//     `muted`. Every row is measured as PLAIN text and its code clipped to what the divider leaves,
//     so the row keeps the width the host gave it, and the transform is idempotent: a row already
//     wearing this paint — divider included — comes back byte-identical.
//
// S6: every shell API member stays optional and defensive. A shell API without `registerToolDesign`, or
// one older than the release that can take a second line on these two tools (0.9.0, whose per-
// (`line`, `tool`) claim is what lets `diff` and `tools` both name a write), registers NOTHING: the
// host keeps drawing its own card and no value is offered for a row the shell API would refuse.
//
// Nothing here writes a colour: every colour is a theme role handed to `theme.fg`, every throw
// degrades to the host's rows, and a path the FILE card claims (`lib/skill-odd-card.js`) is left
// exactly as the host drew it.

const { charColumns, textColumns, visibleChars } = require('./bash-frame.js');
const { fileCardIdentity } = require('./skill-odd-card.js');

// The shell API line this design is the value of. The shell API names the row `Card <line>` — `Card diff`.
const LINE_NAME = 'diff';
// The tools the line covers: the two that change a file.
const WRITE_TOOL = 'write';
const EDIT_TOOL = 'edit';
// The shell API release that can take a per-(`line`, `tool`) claim (shell API 0.9.0). Older
// releases let ONE line own a tool and refuse a second one whole, so this design is registered only
// where the release is known to read the claim: an unregistered row is better than a refusal.
const LINE_VERSION = [0, 9, 0];
// Stable across loads and unique per line: a reload replaces this design, never stacks one.
const DIFF_DESIGN_ID = 'odd-worktree.diff';
// The value the user reads on the shell API's line, next to the reserved `default`.
const DIFF_DESIGN_LABEL = 'color';
const DIFF_DESIGN_PLUGIN_NAME = 'Odd worktree';

// Pi's own collapsed budget for a write body (`dist/core/tools/renderers/write.js`), so the pane is
// as tall as the card it replaces and `ctrl+o` reveals the rest exactly as it did.
const COLLAPSED_LINES = 10;
// The narrowest pane that still reads as an IDE: a gutter plus a few columns of code. Below it the
// host's own rows are drawn instead of a broken layout.
const MIN_CODE_COLUMNS = 8;
// The narrowest gutter: two digits, a rule and a space.
const MIN_NUMBER_WIDTH = 2;
// Trailing cells that are the host's frame rather than the row's own text.
const TRAILING_CHROME = new Set(['│', '▎', '|', '┃', '║', '╮', '╯']);

// The shell API keeps ONE persisted value per line in its own store (`bridge-tool-designs` ->
// `selections` -> `{ "$lines": { "diff": <design id> } }`, documented in the shell API's contract). It
// has no notion of a default design: an absent value reads `native`. So a first run would open on
// `default` unless this package offers `color` once, itself.
const LEGACY_TOOL_DESIGN_STORE_ID = 'bridge-tool-designs';
const SHELL_SELECTION_KEY = 'selections';
const SHELL_LINES_KEY = '$lines';
// This package's own marker that `color` was already offered on this machine. Without it a user who
// later picks `default` would get `color` back on the next load.
const OWN_STORE = 'odd-worktree';
const SEEDED_KEY = 'diffDesignSeeded';

// Nothing here caches a drawing or a highlight. A theme is a LIVE object Pi can switch under a
// renderer and the host's highlighter resolves the global theme on every call, so a cached row — or a
// cached escape — is a function of state this module cannot key (see `highlightLines` and
// `applyDiffDesign`). The card re-renders only while a call streams or when something repaints.

// ---- plain text, measured before it is painted (invariant 17) ----

/** A row's visible characters, every escape dropped. */
function plainOf(row) {
  return visibleChars(row).map((entry) => entry.char).join('');
}

/** `text` clipped to `width` columns with an ellipsis; plain text in, plain text out. */
function clipPlain(text, width, ellipsis = '…') {
  const target = Math.max(0, Math.floor(width));
  if (target <= 0) return '';
  if (textColumns(text) <= target) return text;
  const markColumns = textColumns(ellipsis);
  if (markColumns > target) return clipPlain(text, target, '');
  const keep = target - markColumns;
  let kept = '';
  let used = 0;
  for (const char of text) {
    const columns = charColumns(char);
    if (used + columns > keep) break;
    kept += char;
    used += columns;
  }
  return `${kept}${ellipsis}`;
}

/** One theme role's paint, or the plain text when this theme cannot paint that role. */
function paint(theme, role, text) {
  try {
    if (theme === null || typeof theme !== 'object' || typeof theme.fg !== 'function') return text;
    const painted = theme.fg(role, text);
    return typeof painted === 'string' && painted.includes(text) ? painted : text;
  } catch {
    return text;
  }
}

/** The path a call names: `path` first (the stable field), then the alias Pi's own write reads. */
function callPath(args) {
  if (args === null || typeof args !== 'object') return undefined;
  if (typeof args.path === 'string' && args.path.length > 0) return args.path;
  if (typeof args.file_path === 'string' && args.file_path.length > 0) return args.file_path;
  return undefined;
}

// ---- the host's highlighter, through the seam this package already wraps for `/files` ----

/**
 * The language `path` names, or `undefined`. The seam is `filesAgentSeam`'s: `getLanguageFromPath`
 * answers a language only when Pi knows one, and every throw degrades to no language at all.
 */
function languageOf(path, seam) {
  try {
    if (typeof path !== 'string' || path.length === 0) return undefined;
    const read = seam !== null && typeof seam === 'object' ? seam.languageForPath : undefined;
    if (typeof read !== 'function') return undefined;
    const language = read(path);
    return typeof language === 'string' && language.length > 0 ? language : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `text` as the host's own highlighter paints it — one string per line, the theme's roles already
 * applied — or `undefined` when there is no highlighter, it throws, or it hands back different text
 * than it was given. A paint never changes what the row says, so a line count or a text that
 * disagrees is not a paint and the caller draws plain text instead.
 *
 * S1: NOT memoized, deliberately. The host's highlighter resolves the ACTIVE theme on every call, so
 * its answer is a function of the theme as well as of the text — and a theme is a live object Pi can
 * switch under a renderer, with roles this module cannot enumerate to fingerprint. A cache keyed on
 * (seam, language, text) would therefore hand a switched theme the syntax escapes of the old one,
 * which is the one thing this card exists to get right. The card re-renders only while a call streams
 * or when something repaints, so correctness is cheaper than the stale colour.
 */
function highlightLines(text, language, seam) {
  const plain = String(text).split('\n');
  try {
    const highlight = seam !== null && typeof seam === 'object' ? seam.highlight : undefined;
    if (typeof highlight !== 'function') return undefined;
    const answer = highlight(String(text), language);
    const usable = Array.isArray(answer)
      && answer.length === plain.length
      && answer.every((line, index) => typeof line === 'string' && plainOf(line) === plain[index]);
    return usable ? answer : undefined;
  } catch {
    return undefined;
  }
}

// ---- the `write` pane ----

/** The content a write draws, tabs expanded and trailing blank lines dropped, exactly as the host does. */
function contentLines(content) {
  const expanded = String(content).replace(/\t/g, '   ');
  const lines = expanded.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end -= 1;
  return lines.slice(0, end);
}

/** The pane's width, or `undefined` when the host gave none to draw at. */
function paneWidth(width) {
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined;
  const target = Math.floor(width);
  return target > 0 ? target : undefined;
}

/**
 * The heading row: the tool and the path it wrote, with the file's line count right-aligned when
 * the columns are there. Composed as plain text, clipped as plain text, painted afterwards.
 */
function headingRow(path, total, width, theme) {
  const head = `✎ ${WRITE_TOOL}`;
  const count = `${total} ${total === 1 ? 'line' : 'lines'}`;
  const countColumns = textColumns(count);
  const keepsCount = textColumns(head) + 1 + 1 + countColumns + 2 <= width;
  const pathRoom = width - textColumns(head) - 1 - (keepsCount ? countColumns + 2 : 0);
  const shownPath = typeof path === 'string' && path.length > 0 && pathRoom >= 1 ? clipPlain(path, pathRoom) : '';
  let row = paint(theme, 'toolTitle', head);
  let used = textColumns(head);
  if (shownPath !== '') {
    row += ` ${paint(theme, 'accent', shownPath)}`;
    used += 1 + textColumns(shownPath);
  }
  if (keepsCount) {
    const gap = Math.max(1, width - used - countColumns);
    row += `${' '.repeat(gap)}${paint(theme, 'muted', count)}`;
    used += gap + countColumns;
  }
  return row + ' '.repeat(Math.max(0, width - used));
}

/**
 * One body row: the line-number gutter and the code. `painted` is the highlighter's own line for
 * this code, used only when the whole line fits — the clip is a PLAIN measurement, so a clipped
 * line is drawn as plain text in the theme's `text` role rather than cut out of a painted string.
 */
function codeRow(spec) {
  const number = String(spec.number).padStart(spec.numberWidth);
  const gutterPlain = `${number} │ `;
  const room = spec.width - textColumns(gutterPlain);
  let code = spec.code;
  let painted = spec.painted;
  if (room <= 0) {
    code = '';
    painted = undefined;
  } else if (textColumns(code) > room) {
    code = clipPlain(code, room);
    painted = undefined;
  }
  const gutter = `${paint(spec.theme, 'muted', number)} ${paint(spec.theme, 'dim', '│')} `;
  const body = typeof painted === 'string' ? painted : paint(spec.theme, 'text', code);
  const used = textColumns(gutterPlain) + textColumns(code);
  return `${gutter}${body}${' '.repeat(Math.max(0, spec.width - used))}`;
}

/** The row that states how much of a collapsed body is folded away. */
function foldRow(remaining, numberWidth, width, theme) {
  const plain = `${' '.repeat(numberWidth)} … +${remaining} ${remaining === 1 ? 'line' : 'lines'}`;
  const shown = clipPlain(plain, width);
  return `${paint(theme, 'muted', shown)}${' '.repeat(Math.max(0, width - textColumns(shown)))}`;
}

// A cell the host's own card draws around its body. Its first non-space column is one of these on
// every row of a framed card, and on no row of Pi's renderer output (whose shell is drawn outside).
const FRAME_CELLS = new Set(['╭', '╰', '│', '▎']);
// The words the host's own affordance states in its own row: `ctrl+o to expand` / `… to collapse`.
const EXPAND_HINT = /to (?:expand|collapse)\b/iu;
// The rows a framed card's frame cells may stand on, once the row's leading margin is skipped.
const FRAME_LEADS = [
  ['│', ' ', 2],
  [' ', '▎', 3],
  ['▎', ' ', 2],
];

/** Whether the host drew its frame AROUND these rows, rather than outside them. */
function framed(lines) {
  return lines.some((row) => {
    if (typeof row !== 'string') return false;
    const first = visibleChars(row).find((entry) => entry.char !== ' ');
    return first !== undefined && FRAME_CELLS.has(first.char);
  });
}

/**
 * The frame one host BODY row wears, as the host's OWN bytes: the leading cells (margin, side and
 * lead) and the same number of trailing columns — the space before the rail, the rail and the
 * margin — which is where the host's background reset lives. `undefined` when the row wears no
 * frame, so a host that draws its frame outside its renderer is never treated as if it did.
 */
function frameOf(row) {
  if (typeof row !== 'string') return undefined;
  const chars = visibleChars(row);
  const lead = FRAME_LEADS.find(([first, second]) => chars[0]?.char === first && chars[1]?.char === second);
  if (lead === undefined) return undefined;
  const columns = lead[2];
  if (chars[columns - 1]?.char !== ' ' || chars.length < columns * 2) return undefined;
  const lastPrefix = chars[columns - 1];
  const beforeSuffix = chars[chars.length - columns - 1];
  return {
    columns,
    prefix: row.slice(0, lastPrefix.raw + lastPrefix.char.length),
    tail: row.slice(beforeSuffix.raw + beforeSuffix.char.length),
  };
}

/** Whether a framed row carries no body content of its own — the band row a float card pads with. */
function bandRow(row, frame) {
  if (typeof row !== 'string') return false;
  const chars = visibleChars(row);
  if (chars.length < frame.columns * 2) return false;
  return chars.slice(frame.columns, chars.length - frame.columns).every((entry) => entry.char === ' ');
}

/**
 * The pane's body rows at `width` columns: the numbered lines and — collapsed, with more content
 * than the host's budget — the fold row. No heading: a framed host's own frame already states the
 * call, and the unframed caller composes its heading beside this.
 */
function bodyPane(body, highlighted, expanded, numberWidth, width, theme) {
  const shown = expanded ? body.length : Math.min(body.length, COLLAPSED_LINES);
  const out = [];
  for (let index = 0; index < shown; index += 1) {
    out.push(codeRow({
      number: index + 1,
      numberWidth,
      code: body[index],
      painted: highlighted === undefined ? undefined : highlighted[index],
      width,
      theme,
    }));
  }
  if (shown < body.length) out.push(foldRow(body.length - shown, numberWidth, width, theme));
  return out;
}

/** The body one call's pane draws, or `undefined` when there is nothing to draw at `width`. */
function paneBody(render, seam, width) {
  if (typeof width !== 'number' || width <= 0) return undefined;
  const content = render?.args?.content;
  if (typeof content !== 'string' || content.length === 0) return undefined;
  const body = contentLines(content);
  if (body.length === 0) return undefined;
  const numberWidth = Math.max(MIN_NUMBER_WIDTH, String(body.length).length);
  if (width < numberWidth + 3 + MIN_CODE_COLUMNS) return undefined;
  const highlighted = highlightLines(body.join('\n'), languageOf(callPath(render?.args), seam), seam);
  return { body, highlighted, numberWidth };
}

/**
 * The pane painted INSIDE the host's own frame, for the half of the card that draws the body: the
 * host's leading band row and its closing rule come back byte for byte, the pane takes the place of
 * the body rows between them, and every pane row reuses the host's own frame cells so the tone paint
 * and the background reset stay exactly where the host put them.
 *
 * `undefined` when these rows wear no frame, the call failed (its error rows ARE the card), or there
 * is nothing to draw — the host's card is then drawn as it is.
 */
function framedPane(lines, ctx, render, seam) {
  if (render?.isError === true) return undefined;
  const closing = lines.length - 1;
  if (closing < 1) return undefined;
  const frame = frameOf(lines[closing - 1]);
  if (frame === undefined) return undefined;
  const width = paneWidth(ctx.width);
  if (width === undefined) return undefined;
  const inner = width - frame.columns * 2;
  const pane = paneBody(render, seam, inner);
  if (pane === undefined) return undefined;
  const rows = bodyPane(pane.body, pane.highlighted, render?.expanded === true, pane.numberWidth, inner, ctx.theme);
  const lead = bandRow(lines[0], frame) ? [lines[0]] : [];
  return [...lead, ...rows.map((row) => `${frame.prefix}${row}${frame.tail}`), lines[closing]];
}

/** The host's own expand-affordance rows, exactly as it drew them. */
function hintRows(lines) {
  return lines.filter((row) => typeof row === 'string' && EXPAND_HINT.test(plainOf(row)));
}

/**
 * The whole pane, heading included, for a host whose renderer output carries no frame (Pi draws its
 * own shell AROUND the renderer, so a design sees the body alone there). The host's own expand-hint
 * row, when it drew one, follows the fold row exactly as drawn; when it drew none, none is invented.
 */
function unframedPane(lines, ctx, render, seam) {
  const width = paneWidth(ctx.width);
  if (width === undefined) return undefined;
  const pane = paneBody(render, seam, width);
  if (pane === undefined) return undefined;
  const out = [headingRow(callPath(render?.args), pane.body.length, width, ctx.theme)];
  out.push(...bodyPane(pane.body, pane.highlighted, render?.expanded === true, pane.numberWidth, width, ctx.theme));
  return [...out, ...hintRows(lines)];
}

/**
 * The call half of a `write`. A framed host owns this half — its top rule, the heading and its own
 * `ctrl+o to expand` hint ride it — so it comes back byte for byte. An unframed host draws the whole
 * card here, so the pane is drawn here and any hint row it drew is kept after the fold row.
 */
function writeCallRows(lines, ctx, render, seam) {
  if (framed(lines)) return [...lines];
  return unframedPane(lines, ctx, render, seam) ?? [...lines];
}

// ---- the `edit` diff, recoloured ----

const HUNK = /^@@/u;
// The marker and the line number of a row the host numbered. A NUMBER is required: `renderDiff`
// always states one, and a row the host wrapped onto a continuation row states neither (the wrap
// carries on at the row's own left column). A continuation is recognised only when its own text
// happens to read as `<number> ` — the one ambiguity a plain-text layout cannot answer.
const ADDED = /^\+(\s*\d+)\s/u;
const REMOVED = /^-(\s*\d+)\s/u;
const CONTEXT = /^(\d+)\s/u;
const HUNK_TOKEN = /^@@.*?@@/u;
// The rule between a line-number gutter and its code, exactly the one the write pane's `codeRow`
// draws: `${number} │ ${code}`. It is read back off a row's PLAIN text, so a row this design already
// divided is divided no further (S12/S14) — which is also this design's one plain-text ambiguity: a
// row whose own code begins with `│ ` is read as one that already wears the divider.
const DIVIDER = '│';
const DIVIDER_TAIL = `${DIVIDER} `;
const DIVIDER_RUN = ` ${DIVIDER_TAIL}`;
// The cells a diff row's own text is padded by on the left: the frame's sides and its spaces.
const LEADING_CHROME = new Set([' ', '│', '▎', '|', '┃', '║']);
// The paint that governs the span this design repaints stands at that span's two edges: the escapes
// that OPEN it are the last ones before the span, and the RESET that closes it is the first one
// after. Both belong to a span that is rebuilt from the row's plain text, so dropping them is what
// makes a second pass a no-op (S8b) instead of a row carrying every escape twice. The opening run is
// dropped whole, which is what a row this design already painted needs: its own last escape there.
// The closing run is dropped only while it CLEARS a state, because a frame cell's own paint starts
// there too (`\u001b[32m│`) and is the host's to keep.
const TRAILING_SGR = /(?:\u001b\[[0-9;]*m)+$/u;
// A row whose first cell is the host's frame rule, and the skip marker the host draws between hunks:
// neither is the rest of a wrapped diff line.
const WRAP_BREAK_CELLS = new Set(['╭', '╰', '╮', '╯', '─']);
const SKIP_MARKER = /^\.\.\./u;
const SGR_CLEARS = new Set(['0', '22', '23', '24', '25', '27', '28', '29', '39', '49', '55', '59']);

/** Whether one SGR escape CLEARS a state rather than opening one. */
function clearsSgr(params) {
  return params === '' || params.split(';').some((code) => SGR_CLEARS.has(code));
}

/**
 * `text` with the RESET that closes the paint of the span this design repaints dropped from its
 * START, and nothing that OPENS a paint: the frame cell that follows the span is already painted.
 */
function withoutClosingPaint(text) {
  const one = /\u001b\[([0-9;]*)m/uy;
  let index = 0;
  while (index < text.length) {
    one.lastIndex = index;
    const escape = one.exec(text);
    if (escape === null || !clearsSgr(escape[1])) break;
    index += escape[0].length;
  }
  return text.slice(index);
}

/** The last character of a row's own TEXT, or `-1` when the row is chrome alone. */
function contentLast(chars) {
  let last = chars.length - 1;
  const trim = () => {
    while (last >= 0 && chars[last].char === ' ') last -= 1;
  };
  trim();
  for (let pass = 0; pass < 2 && last >= 0; pass += 1) {
    if (!TRAILING_CHROME.has(chars[last].char)) break;
    last -= 1;
    trim();
  }
  return last;
}

/**
 * The first character of a diff row's own text, or `-1` when the row states no diff line at all.
 * The chrome the host draws around the row is skipped, never guessed from the tool: a heading, a
 * blank row and a fold notice all answer `-1` and come back exactly as the host drew them.
 */
function diffStart(chars) {
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index].char;
    if (LEADING_CHROME.has(char)) continue;
    const rest = chars.slice(index).map((entry) => entry.char).join('');
    if (HUNK.test(rest) || ADDED.test(rest) || REMOVED.test(rest) || CONTEXT.test(rest)) return index;
    return -1;
  }
  return -1;
}

/**
 * The bytes a row keeps AFTER its own text, split into the padding it may give back to the gutter and
 * the host's own tail (its frame cells and the reset they carry). `columns` is the padding's width,
 * which is what a row with no slack needs to know before it can be divided.
 */
function afterChrome(row, last) {
  const after = withoutClosingPaint(row.slice(last.raw + last.char.length));
  const chars = visibleChars(after);
  let pad = 0;
  while (pad < chars.length && chars[pad].char === ' ') pad += 1;
  const cut = pad === 0 ? 0 : chars[pad - 1].raw + chars[pad - 1].char.length;
  return { padding: after.slice(0, cut), rest: after.slice(cut), columns: pad };
}

/** `padding` with `drop` of its trailing space columns given back, every other byte untouched. */
function giveBack(padding, drop) {
  if (drop <= 0) return padding;
  const chars = visibleChars(padding);
  if (chars.length <= drop) return '';
  return padding.slice(0, chars[chars.length - drop].raw);
}

/**
 * One diff row with this design's drawing on it: the line-number gutter, the divider the write pane
 * draws, and the code. A row that states a DELETION is painted whole in `toolDiffRemoved` and one
 * that states an ADDITION whole in `toolDiffAdded` — marker, number, divider and code — because the
 * role's colour is the whole point (S13), so neither carries a syntax colour of its own. A CONTEXT
 * row keeps the gutter, the divider in the role the write pane paints its own, and the code in the
 * highlighter's roles. A hunk header states no line, so it has no gutter to divide and keeps today's
 * drawing. Every other cell of the host's row — the frame, its padding, the background — is the
 * host's, byte for byte, and a row that is not a diff row comes back untouched.
 *
 * S12: the divider costs two columns, and they come out of the row's own padding, so the row keeps
 * the width the host gave it; a row with no padding to give back loses the tail of its CODE to a
 * PLAIN clip (never a cut through a painted string, invariant 17), never the frame.
 *
 * S8b/S14: the row is RECOGNISED and MEASURED through its plain text (`visibleChars` drops every SGR
 * sequence), the span that carries the gutter and the code is rebuilt from that plain text, and the
 * two SGR runs that stand immediately beside that span are dropped — one is the host's own paint of
 * that span, the other is this design's own `theme.fg` codes when the row it is handed was already
 * painted. The divider is read back off the same plain text, so it is never added twice, and nothing
 * this design added survives into the rewritten row: a second pass is a byte-identical no-op.
 */
function recolourDiffRow(row, spec) {
  const chars = visibleChars(row);
  const start = diffStart(chars);
  if (start < 0) return row;
  const last = contentLast(chars);
  if (last < start) return row;
  const rest = chars.slice(start, last + 1).map((entry) => entry.char).join('');
  const before = row.slice(0, chars[start].raw).replace(TRAILING_SGR, '');
  const after = withoutClosingPaint(row.slice(chars[last].raw + chars[last].char.length));
  const hunk = HUNK_TOKEN.exec(rest);
  if (HUNK.test(rest)) {
    const token = hunk === null ? '@@' : hunk[0];
    const code = rest.slice(token.length);
    const paintedCode = code === '' ? '' : highlightRow(code, 'muted', spec.language, spec.seam, spec.theme);
    return `${before}${paint(spec.theme, 'muted', token)}${paintedCode}${after}`;
  }
  // The number's trailing space is the row's padding when the row states no code of its own (the host
  // flushed it before a word wider than the row), so the row is read with that space restored.
  const probe = `${rest} `;
  const match = ADDED.exec(probe) ?? REMOVED.exec(probe) ?? CONTEXT.exec(probe);
  if (match === null) return row;
  // `undefined` marks a context row, whose marker is a space and already part of the row's chrome.
  const added = ADDED.test(probe);
  const role = added ? 'toolDiffAdded' : REMOVED.test(probe) ? 'toolDiffRemoved' : undefined;
  const gutter = role === undefined ? match[1] : `${rest[0]}${match[1]}`;
  const head = `${gutter}${DIVIDER_RUN}`;
  const headColumns = textColumns(head);
  const tail = afterChrome(row, chars[last]);
  // The row's own drawing width: its text plus the padding the divider may take from.
  const room = textColumns(rest) + tail.columns;
  // Too narrow to hold even the gutter: the host's own drawing (whole row in its role) stays.
  if (room - headColumns < 1) return row;
  const tailText = rest.slice(match[0].length);
  // A row this design already divided wears the rule right after its number: read it back, so the
  // second pass rebuilds the same row instead of adding a second divider (S14).
  const code = tailText.startsWith(DIVIDER_TAIL) ? tailText.slice(DIVIDER_TAIL.length) : tailText;
  // S15: a line the host wrapped states the rest of it on rows this design drops. The row is drawn
  // from the WHOLE line, so it fills its width like the write pane's and ends in the ellipsis that
  // pane writes for a line that did not fit.
  const whole = joinWrapped(code, rest, spec.rest ?? [], room);
  const base = whole;
  const overflow = headColumns + textColumns(base) > room;
  const clipped = overflow;
  const shown = overflow ? clipPlain(base, room - headColumns) : base;
  let body;
  if (role !== undefined) {
    body = paint(spec.theme, role, `${head}${shown}`);
  } else {
    const paintedCode = shown === ''
      ? ''
      : clipped
        ? paint(spec.theme, 'text', shown)
        : highlightRow(shown, 'text', spec.language, spec.seam, spec.theme);
    body = `${paint(spec.theme, 'muted', gutter)} ${paint(spec.theme, 'dim', DIVIDER)} ${paintedCode}`;
  }
  const slack = Math.max(0, room - headColumns - textColumns(shown));
  return `${before}${body}${giveBack(tail.padding, tail.columns - slack)}${tail.rest}`;
}

/**
 * The code of one row whose whole line the highlighter can paint: the host's highlighter when it
 * paints this exact line, else the plain text in `fallback`.
 */
function highlightRow(code, fallback, language, seam, theme) {
  if (language !== undefined) {
    const painted = highlightLines(code, language, seam);
    if (painted !== undefined && painted.length === 1) return painted[0];
  }
  return paint(theme, fallback === 'muted' ? 'text' : fallback, code);
}

/** Whether a row states a numbered diff line (a hunk header and a skip marker state none). */
function statesLine(row) {
  const chars = visibleChars(row);
  const start = diffStart(chars);
  if (start < 0) return false;
  const rest = chars.slice(start).map((entry) => entry.char).join('');
  return !HUNK.test(rest) && (ADDED.test(rest) || REMOVED.test(rest) || CONTEXT.test(rest));
}

/**
 * Whether a row is the REST of a diff line the host wrapped: text with no number, at the row's own
 * left column. A blank band row, a frame rule, a skip marker and the host's expand hint are the
 * host's own rows and never the rest of a line.
 */
function wrappedRest(row) {
  if (typeof row !== 'string' || statesLine(row)) return undefined;
  const chars = visibleChars(row);
  const first = chars.findIndex((entry) => !LEADING_CHROME.has(entry.char));
  const last = contentLast(chars);
  if (first < 0 || last < first) return undefined;
  if (WRAP_BREAK_CELLS.has(chars[first].char)) return undefined;
  const text = chars.slice(first, last + 1).map((entry) => entry.char).join('');
  return HUNK.test(text) || SKIP_MARKER.test(text) || EXPAND_HINT.test(plainOf(row)) ? undefined : text;
}

/**
 * The code of a wrapped diff line put back together: the numbered row's code and the rows the host
 * wrapped it onto. The host broke each row at a space it then ate, or — for a word longer than the
 * width — through the word, which leaves the row FULL and with no space to break at. `room` is the
 * width the host wrapped at.
 */
function joinWrapped(code, rowText, rest, room) {
  let whole = code;
  let previous = rowText;
  let previousCode = code;
  for (const piece of rest) {
    const hardBreak = textColumns(previous) >= room && !previousCode.trim().includes(' ');
    // A numbered row with no code of its own (the host flushed it before a word wider than the row)
    // has nothing to separate the rest from.
    whole += `${hardBreak || whole === '' ? '' : ' '}${piece}`;
    previous = piece;
    previousCode = piece;
  }
  return whole;
}

// ---- the edit heading: what the call changed ----

// The heading the host draws for an `edit`: its frame cells, an optional icon, the tool and the path.
const EDIT_HEADING = /^[╭─\s▎│]*(?:✎\s*)?edit\s+\S+/u;
// The most cells the line comparison may fill; a bigger block is counted without one.
const MAX_DIFF_CELLS = 4_000_000;

function textLines(text) {
  return text === '' ? [] : text.split('\n');
}

/** How many lines of `before` a change to `after` deletes and adds, by the longest common subsequence. */
function lineDelta(before, after) {
  const a = textLines(before);
  const b = textLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);
  if (left.length === 0 || right.length === 0 || left.length * right.length > MAX_DIFF_CELLS) {
    return { added: right.length, removed: left.length };
  }
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[right.length];
  return { added: right.length - common, removed: left.length - common };
}

/** The `(+added · -removed)` an edit call states, or `undefined` when it changes no line. A zero is not written. */
function changeCount(args) {
  if (args === null || typeof args !== 'object') return undefined;
  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') edits.push(args);
  let added = 0;
  let removed = 0;
  for (const entry of edits) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.oldText !== 'string' || typeof entry.newText !== 'string') continue;
    const delta = lineDelta(entry.oldText, entry.newText);
    added += delta.added;
    removed += delta.removed;
  }
  const parts = [added > 0 ? `+${added}` : '', removed > 0 ? `-${removed}` : ''].filter((part) => part !== '');
  return parts.length === 0 ? undefined : `(${parts.join(' · ')})`;
}

/** The SGR escapes in force at the end of `text`: every one since the last full reset. */
function sgrInForce(text) {
  let state = [];
  for (const escape of text.matchAll(/\u001b\[([0-9;]*)m/gu)) {
    if (escape[1] === '' || escape[1] === '0') state = [];
    else state.push(escape[0]);
  }
  return state.join('');
}

/**
 * The host's heading row with `count` written after the path, in the `muted` role. The columns come
 * out of the rule (or the padding) that follows the path, so the row keeps its width and the frame
 * does not move; a heading with no room for it, or whose filler carries a paint of its own, is the
 * host's. A heading that already wears a count has no filler right after its path, so it is a no-op.
 */
function headingWithCount(row, count, theme) {
  const chars = visibleChars(row);
  const matched = EDIT_HEADING.exec(chars.map((entry) => entry.char).join(''));
  if (matched === null) return row;
  const end = Array.from(matched[0]).length;
  let filler = 0;
  while (end + filler < chars.length && (chars[end + filler].char === ' ' || chars[end + filler].char === '─')) filler += 1;
  const need = textColumns(count) + 1;
  if (chars[end]?.char !== ' ' || filler < need + 3) return row;
  const from = chars[end + 1].raw;
  const to = chars[end + 1 + need].raw;
  if (row.slice(from, to).includes('\u001b')) return row;
  const at = chars[end].raw;
  const before = row.slice(0, at);
  return `${before} ${paint(theme, 'muted', count)}${sgrInForce(before)}${row.slice(at, from)}${row.slice(to)}`;
}

/**
 * Every row of an `edit` card, recoloured and divided. Idempotent (S8b/S14): each row is read as its
 * PLAIN text and rebuilt from it, divider included, so a row already wearing this drawing states the
 * same visible characters and comes back byte for byte — never with a second copy of an escape, a
 * reset or the divider.
 *
 * S15: the host wraps a long diff line onto rows that carry no number and no gutter, which would
 * draw at the frame's left column with no divider. This design draws ONE row per line, like the
 * write pane: the rows after a numbered one that are the rest of its line are dropped, and that row
 * ends in `…`. A row that fit is never marked.
 */
function editRows(lines, render, ctx, seam) {
  const language = languageOf(callPath(render?.args), seam);
  const count = render?.isError === true ? undefined : changeCount(render?.args);
  let headed = count === undefined;
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const row = lines[index];
    index += 1;
    if (typeof row !== 'string') {
      out.push(String(row));
      continue;
    }
    if (!headed && statesLine(row)) headed = true;
    if (!headed && EDIT_HEADING.test(plainOf(row))) {
      headed = true;
      out.push(headingWithCount(row, count, ctx.theme));
      continue;
    }
    const rest = [];
    if (render?.isError !== true && statesLine(row)) {
      while (index < lines.length && wrappedRest(lines[index]) !== undefined) {
        rest.push(wrappedRest(lines[index]));
        index += 1;
      }
    }
    out.push(recolourDiffRow(row, { theme: ctx.theme, language, seam, rest }));
  }
  return out;
}

// ---- the design's entry point ----

/**
 * The design's whole behaviour: the IDE pane for a `write`, the recoloured diff for an `edit`, and
 * the host's rows byte for byte for anything it does not own. The shell API hands this to
 * `registerToolDesign`; it is pure (the rows and the call in, rows out) and never throws.
 *
 * A `write` is drawn ONCE: a framed host keeps its call half (the frame top and its hint) and the
 * pane goes inside the frame in the result half; an unframed host draws the pane on the call half
 * and its result half is the host's.
 *
 * S4/S6: a call whose path the FILE card claims is that card's row, and it comes back exactly as
 * the host drew it, whichever resolver runs first (the classification is `lib/skill-odd-card.js`'s,
 * so the two surfaces can never disagree).
 */
function applyDiffCard(lines, ctx, seam) {
  const unchanged = () => (Array.isArray(lines) ? [...lines] : []);
  try {
    if (!Array.isArray(lines)) return [];
    if (ctx === null || typeof ctx !== 'object') return unchanged();
    const render = ctx.render !== null && typeof ctx.render === 'object' ? ctx.render : undefined;
    if (fileCardIdentity(callPath(render?.args)) !== undefined) return unchanged();
    if (ctx.tool === WRITE_TOOL) {
      if (ctx.part === 'result') return framedPane(lines, ctx, render, seam) ?? unchanged();
      return writeCallRows(lines, ctx, render, seam);
    }
    if (ctx.tool === EDIT_TOOL) return editRows(lines, render, ctx, seam);
    return unchanged();
  } catch {
    return unchanged();
  }
}

/**
 * The design behind its never-throwing guard. S5: there is NO cache of the drawing. `args` arrives by
 * reference and Pi rewrites `content` while a call streams, so a key built from its length (or from
 * any other summary of it) would answer a brand-new body with the pane of the old one — and, as
 * `highlightLines` says, a cached pane also carries the syntax escapes of whatever theme painted it.
 * A caller always gets a fresh array.
 */
function applyDiffDesign(lines, ctx, seam) {
  try {
    return applyDiffCard(lines, ctx, seam);
  } catch {
    return Array.isArray(lines) ? [...lines] : [];
  }
}

// The read-only picture `/gentle:customize` draws while `color` is highlighted. ONE row, like every
// other Cards value: the gutter, a diff's two kinds and a hunk header on a single line.
// S4 (modular-tools): the preview's TITLE is the line's own name — what the shell API shows for the
// `default` value — so both options of `Card diff` read as one line and only the SAMPLE tells them
// apart. The shell API derives the row from the line key (`Card <line>`), and so does this title.
const DIFF_DESIGN_PREVIEW = {
  title: `Cards · Card ${LINE_NAME}`,
  sample: '  12 │ const total = items.length  + 3 added  − 1 removed  @@ -1,4 +1,4 @@',
};

/** The one registration this line carries: `Card diff` over `write` and `edit`. */
function diffColorDesign(seam) {
  return {
    line: LINE_NAME,
    tools: [WRITE_TOOL, EDIT_TOOL],
    id: DIFF_DESIGN_ID,
    name: DIFF_DESIGN_PLUGIN_NAME,
    label: DIFF_DESIGN_LABEL,
    description: 'draws a write as a syntax-highlighted IDE pane and an edit as a recoloured diff',
    preview: () => ({ ...DIFF_DESIGN_PREVIEW }),
    apply: (lines, ctx) => applyDiffDesign(lines, ctx, seam),
  };
}

/**
 * Whether the shell API's published release is at least `floor`, or `undefined` when the release string
 * cannot be read as one. Read defensively: another copy of the shell API, or a host that publishes no
 * release, is never mistaken for a newer one.
 *
 * S6: a release string carrying a prerelease or a build suffix (`0.9.0-rc.1`, `0.9.0+build.7`) does
 * NOT meet a cutoff its own numbers equal. Semver puts a prerelease BELOW its release, and the package
 * would rather miss a row than have a registration refused. Its numbers still clear a LOWER cutoff
 * (`0.9.0-rc.1` is above 0.6.0), and a string that cannot be read at all stays `undefined` so the
 * caller can fall back to its own capability probe.
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

/**
 * Whether a published shell API can take this line at all (shell API 0.9.0). A release this
 * cannot read answers NO: a probe would ask whether a grouped line is accepted, never whether a
 * SECOND line may name `write`, and a refused registration is exactly the outcome S6 refuses.
 */
function shellApiSupportsDiffLine(api) {
  return releaseAtLeast(api?.VERSION, LINE_VERSION) === true;
}

/**
 * Select `color` ONCE, on the first load that finds no choice. Returns whether it wrote the
 * selection. A choice already stored on the line, `default` (stored `native`) included, is never
 * touched, and the marker is written only after the selection, so a failed write is tried again on
 * the next load. Never throws: the design is cosmetic.
 */
function seedDiffDesignSelection(api) {
  try {
    if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return false;
    const own = api.createStore(OWN_STORE);
    if (own.get(SEEDED_KEY, false) === true) return false;
    const store = api.createStore(LEGACY_TOOL_DESIGN_STORE_ID);
    const stored = store.get(SHELL_SELECTION_KEY, {});
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
    const lines = stored[SHELL_LINES_KEY];
    if (lines !== undefined && (lines === null || typeof lines !== 'object' || Array.isArray(lines))) return false;
    const line = lines === undefined ? undefined : lines[LINE_NAME];
    if (line !== undefined) {
      own.set(SEEDED_KEY, true);
      return false;
    }
    store.set(SHELL_SELECTION_KEY, {
      ...stored,
      [SHELL_LINES_KEY]: { ...(lines ?? {}), [LINE_NAME]: DIFF_DESIGN_ID },
    });
    own.set(SEEDED_KEY, true);
    return true;
  } catch {
    return false;
  }
}

// The registration this process made: a second call is the same design, never two.
let designDisposer = null;

/**
 * Register the design on a shell API that can take one and hand back the idempotent disposer, or `null`
 * when the shell API is absent, older than the line, or refuses the registration. Never throws.
 *
 * The seed runs AFTER a registration that was accepted: unlike the `tools` line there is no legacy
 * per-tool value for this one to inherit, so a refusal must not leave a value naming a design that
 * nobody registered (the shell API's own report would call it `missing`).
 */
function registerDiffDesign(api, seam) {
  if (api === null || typeof api !== 'object' || typeof api.registerToolDesign !== 'function') return null;
  if (designDisposer !== null) return designDisposer;
  if (!shellApiSupportsDiffLine(api)) return null;
  let registered;
  try {
    registered = api.registerToolDesign(diffColorDesign(seam));
  } catch {
    return null;
  }
  seedDiffDesignSelection(api);
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
  DIFF_DESIGN_ID,
  DIFF_DESIGN_LABEL,
  DIFF_DESIGN_PREVIEW,
  LINE_VERSION,
  applyDiffCard,
  applyDiffDesign,
  shellApiSupportsDiffLine,
  diffColorDesign,
  registerDiffDesign,
  seedDiffDesignSelection,
};

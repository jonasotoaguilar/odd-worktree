'use strict';
// The `diff` DESIGN: the second `registerToolDesign` line this package contributes, over `write` and
// `edit`, drawn as an IDE pane in the ACTIVE THEME's own roles.
//
// It is the same shape as `lib/bash-design.js`: a registration on gentle-shell-bridge's published
// API, not a renderer. The bridge owns Pi's one `registerToolRenderer` resolver, builds the HOST's
// own card and hands this module the rows that card drew:
//
//     apply(lines, { width, tool, theme, part, render }) -> lines
//
// ONE line, `diff`, covers the two tools that change a file. `/gentle:customize` -> `Cards` draws
// it as `Card diff`, keeps the host's own card first as `default` (stored `native`) and shows this
// design's value as `color`. The line is UNSCOPED: the path scope belongs to the `Card tags`
// line's own claim on the same two tools (gentle-shell-bridge 0.9.0 maps a scope to ONE
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
//   * `edit` — the host's own diff, recoloured: additions in the theme's `toolDiffAdded` role,
//     deletions in `toolDiffRemoved`, hunk headers and context in `muted`/`text`, and the code of a
//     row highlighted with the language `args.path` names. The row's text is never changed, so its
//     width survives, and the transform is idempotent: a row already wearing this paint comes back
//     identical.
//
// S6: every bridge member stays optional and defensive. A bridge without `registerToolDesign`, or
// one older than the release that can take a second line on these two tools (0.9.0, whose per-
// (`line`, `tool`) claim is what lets `diff` and `tools` both name a write), registers NOTHING: the
// host keeps drawing its own card and no value is offered for a row the bridge would refuse.
//
// Nothing here writes a colour: every colour is a theme role handed to `theme.fg`, every throw
// degrades to the host's rows, and a path the FILE card claims (`lib/skill-odd-card.js`) is left
// exactly as the host drew it.

const { charColumns, textColumns, visibleChars } = require('./bash-frame.js');
const { fileCardIdentity } = require('./skill-odd-card.js');

// The bridge line this design is the value of. The bridge names the row `Card <line>` — `Card diff`.
const LINE_NAME = 'diff';
// The tools the line covers: the two that change a file.
const WRITE_TOOL = 'write';
const EDIT_TOOL = 'edit';
// The bridge release that can take a per-(`line`, `tool`) claim (gentle-shell-bridge 0.9.0). Older
// releases let ONE line own a tool and refuse a second one whole, so this design is registered only
// where the release is known to read the claim: an unregistered row is better than a refusal.
const LINE_VERSION = [0, 9, 0];
// Stable across loads and unique per line: a reload replaces this design, never stacks one.
const DIFF_DESIGN_ID = 'odd-worktree.diff';
// The value the user reads on the bridge's line, next to the reserved `default`.
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

// The bridge keeps ONE persisted value per line in its own store (`bridge-tool-designs` ->
// `selections` -> `{ "$lines": { "diff": <design id> } }`, documented in the bridge's contract). It
// has no notion of a default design: an absent value reads `native`. So a first run would open on
// `default` unless this package offers `color` once, itself.
const BRIDGE_SELECTION_STORE = 'bridge-tool-designs';
const BRIDGE_SELECTION_KEY = 'selections';
const BRIDGE_LINES_KEY = '$lines';
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
const ADDED = /^\+(\s*\d*)\s/u;
const REMOVED = /^-(\s*\d*)\s/u;
const CONTEXT = /^(\d+)\s/u;
const HUNK_TOKEN = /^@@.*?@@/u;
// The cells a diff row's own text is padded by on the left: the frame's sides and its spaces.
const LEADING_CHROME = new Set([' ', '│', '▎', '|', '┃', '║']);

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
 * One diff row with this design's paint on it: the marker and the line number in the role its kind
 * names, the code in the highlighter's own roles (or the theme's `text`), and every other cell of
 * the host's row — the frame, its padding, the background — byte for byte. A row that is not a diff
 * row, and one whose content this cannot read, come back untouched.
 */
function recolourDiffRow(row, spec) {
  const chars = visibleChars(row);
  const start = diffStart(chars);
  if (start < 0) return row;
  const last = contentLast(chars);
  if (last < start) return row;
  const rest = chars.slice(start, last + 1).map((entry) => entry.char).join('');
  let token;
  let role;
  let code;
  const hunk = HUNK_TOKEN.exec(rest);
  if (HUNK.test(rest)) {
    token = hunk === null ? '@@' : hunk[0];
    role = 'muted';
    code = rest.slice(token.length);
  } else {
    const match = ADDED.exec(rest) ?? REMOVED.exec(rest) ?? CONTEXT.exec(rest);
    if (match === null) return row;
    token = match[0];
    role = ADDED.test(rest) ? 'toolDiffAdded' : REMOVED.test(rest) ? 'toolDiffRemoved' : 'muted';
    code = rest.slice(token.length);
  }
  const language = spec.language;
  const paintedCode = code === ''
    ? ''
    : highlightRow(code, role, language, spec.seam, spec.theme);
  const rawStart = chars[start].raw;
  const rawEnd = chars[last].raw + chars[last].char.length;
  return `${row.slice(0, rawStart)}${paint(spec.theme, role, token)}${paintedCode}${row.slice(rawEnd)}`;
}

/**
 * The code of one diff row: the host's highlighter when it paints this exact line, else the plain
 * text in `fallback` (the diff's own role for an addition or a deletion, `text` for context).
 */
function highlightRow(code, fallback, language, seam, theme) {
  if (language !== undefined) {
    const painted = highlightLines(code, language, seam);
    if (painted !== undefined && painted.length === 1) return painted[0];
  }
  return paint(theme, fallback === 'muted' ? 'text' : fallback, code);
}

/**
 * Every row of an `edit` card, recoloured. Idempotent: a row already wearing this paint states the
 * same text, so a second pass paints the very same bytes.
 */
function editRows(lines, render, ctx, seam) {
  const language = languageOf(callPath(render?.args), seam);
  return lines.map((row) => (typeof row === 'string'
    ? recolourDiffRow(row, { theme: ctx.theme, language, seam })
    : String(row)));
}

// ---- the design's entry point ----

/**
 * The design's whole behaviour: the IDE pane for a `write`, the recoloured diff for an `edit`, and
 * the host's rows byte for byte for anything it does not own. The bridge hands this to
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
const DIFF_DESIGN_PREVIEW = {
  title: `Cards · ${DIFF_DESIGN_LABEL}`,
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
 * Whether the bridge's published release is at least `floor`, or `undefined` when the release string
 * cannot be read as one. Read defensively: another copy of the bridge, or a host that publishes no
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
 * Whether a published bridge can take this line at all (gentle-shell-bridge 0.9.0). A release this
 * cannot read answers NO: a probe would ask whether a grouped line is accepted, never whether a
 * SECOND line may name `write`, and a refused registration is exactly the outcome S6 refuses.
 */
function bridgeSupportsDiffLine(api) {
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
    const bridge = api.createStore(BRIDGE_SELECTION_STORE);
    const stored = bridge.get(BRIDGE_SELECTION_KEY, {});
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
    const lines = stored[BRIDGE_LINES_KEY];
    if (lines !== undefined && (lines === null || typeof lines !== 'object' || Array.isArray(lines))) return false;
    const line = lines === undefined ? undefined : lines[LINE_NAME];
    if (line !== undefined) {
      own.set(SEEDED_KEY, true);
      return false;
    }
    bridge.set(BRIDGE_SELECTION_KEY, {
      ...stored,
      [BRIDGE_LINES_KEY]: { ...(lines ?? {}), [LINE_NAME]: DIFF_DESIGN_ID },
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
 * Register the design on a bridge that can take one and hand back the idempotent disposer, or `null`
 * when the bridge is absent, older than the line, or refuses the registration. Never throws.
 *
 * The seed runs AFTER a registration that was accepted: unlike the `tools` line there is no legacy
 * per-tool value for this one to inherit, so a refusal must not leave a value naming a design that
 * nobody registered (the bridge's own report would call it `missing`).
 */
function registerDiffDesign(api, seam) {
  if (api === null || typeof api !== 'object' || typeof api.registerToolDesign !== 'function') return null;
  if (designDisposer !== null) return designDisposer;
  if (!bridgeSupportsDiffLine(api)) return null;
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
  bridgeSupportsDiffLine,
  diffColorDesign,
  registerDiffDesign,
  seedDiffDesignSelection,
};

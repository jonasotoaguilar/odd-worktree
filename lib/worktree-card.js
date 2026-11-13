'use strict';
// Reusable native Pi worktree tool card renderer (T6/S13).
//
// One factory per tool — `createWorktreeCardRenderer(toolName, deps)` —
// returning the three render hooks the parent extension spreads over its
// tool definitions (`renderShell: "self"`, `renderCall`, `renderResult`),
// so execute/schema/content/details stay exactly where they are. Compact
// collapsed cards match the gentle-shell reference: an accent left border,
// a readable operation header, a ctrl+o expand hint on that header, a
// short result, and a duration only when lifecycle timing evidence is
// supplied — that duration is the only thing the closing rule carries.
//
// S12 split of the two states: the collapsed body carries only the action
// and the identity it acted on (no full path and no thread id), while the
// expanded body formats the SAME details into ordered `label: value` rows —
// status, path, branch, warnings — instead of echoing the raw content dump.
// S1 removed issue and ODD associations from every worktree surface, so no
// card row mentions them: the registry still stores those legacy fields and
// the details may still carry them, but they are data preservation, never
// display. The content text is only the fallback for a result the details
// cannot describe. Failures always keep their honest prose.
//
// S6 worktree list: the expanded listing is a LIST of entry blocks (one
// blank row between them, one identity row per checkout) and never prints a
// `live`/`exists` status — being listed is the existence proof — while the
// statuses that carry information (`missing`, `unregistered`) ride the
// trailing cell of the entry's own identity row instead of costing a row.
//
// S19 worktree identity: one git-branch glyph for every tool and the
// git-orange tone on the opening rule. The installed Pi theme schema
// exposes no orange role, so the closest documented role — `warning`
// (yellow in the built-in themes) — carries the tone; failures keep the
// `error` role and the running marker keeps `muted`. No other role is
// ever passed to theme.fg.
//
// No new dependencies and no imports of package-private reference
// modules: width and key-hint helpers arrive via injected `deps`
// ({visibleWidth, truncateToWidth, keyHint}) with small local fallbacks,
// consistent with the libRequire architecture. Every hook returns a plain
// Pi component ({render(width), invalidate}) and never throws: untrusted
// strings (branch names, paths, result text) are sanitized so no raw ANSI
// or control character can leak into or reshape the transcript.

const WORKTREE_TOOLS = new Set([
  'worktree_create',
  'worktree_list',
  'worktree_delete',
  'worktree_session_open',
  'worktree_warp',
]);

// One branch glyph for all five tools (S19): the worktree tools share a
// single git identity instead of four unrelated marks. U+2387 renders as a
// single column through both the local fallback and pi-tui measurement.
const GLYPH = {
  worktree_create: '⎇',
  worktree_list: '⎇',
  worktree_delete: '⎇',
  worktree_session_open: '⎇',
  worktree_warp: '⎇',
};

const TITLE = {
  worktree_create: 'worktree create',
  worktree_list: 'worktree list',
  worktree_delete: 'worktree delete',
  worktree_session_open: 'worktree session open',
  worktree_warp: 'worktree warp',
};

// Collapsed budget: header + preview rows + closing rule. Operate-mode
// scanability: the transcript stays readable with five tools chattering.
const COLLAPSED_PREVIEW_ROWS = 3;
const ACCENT_BAR = '▎';
const RUNNING_MARK = '…';
const EMPTY_TEXT = '(no output)';

// Matches ANSI SGR escapes and OSC 8 hyperlinks; control characters and
// DEL are stripped separately so multi-line structure (\n, \t) survives.
const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function safeText(value) {
  if (typeof value !== 'string') return '';
  return stripAnsi(value).replace(CONTROL_PATTERN, '');
}

function asRecord(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function oneLine(value, fallback) {
  const line = safeText(value).split('\n')[0].trim().replace(/\s+/g, ' ');
  return line.length > 0 ? line : fallback;
}

function baseName(value) {
  const text = safeText(value).replace(/\/+$/, '');
  if (text.length === 0) return '';
  const parts = text.split('/');
  return parts[parts.length - 1];
}

// Minimal column-width measurement for the local fallback (used only
// when the host injects no helpers): wide East-Asian/emoji code points
// occupy two columns, combining marks none. Runtime rendering goes
// through the real pi-tui visibleWidth; this keeps the fallback honest
// at narrow widths instead of counting code points.
function charWidth(code) {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return 0;
  if (
    (code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

function localVisibleWidth(line) {
  let width = 0;
  for (const char of stripAnsi(line)) width += charWidth(char.codePointAt(0));
  return width;
}

function localTruncate(line, width, ellipsis = '…') {
  if (localVisibleWidth(line) <= width) return line;
  if (width <= 0) return '';
  const mark = localVisibleWidth(ellipsis) >= width ? '' : ellipsis;
  const budget = width - localVisibleWidth(mark);
  let used = 0;
  let out = '';
  for (const char of line) {
    const next = used + charWidth(char.codePointAt(0));
    if (next > budget) break;
    out += char;
    used = next;
  }
  return out + mark;
}

function resolveHelpers(deps) {
  const d = asRecord(deps);
  return {
    visibleWidth: typeof d.visibleWidth === 'function' ? d.visibleWidth : localVisibleWidth,
    truncateToWidth: typeof d.truncateToWidth === 'function' ? d.truncateToWidth : localTruncate,
    keyHint: typeof d.keyHint === 'function' ? d.keyHint : undefined,
    // Click-to-expand seam: the extension injects the callback that flips the
    // host's GLOBAL tool-expansion state (ctx.ui.setToolsExpanded(!ctx.ui
    // .getToolsExpanded())). It is optional — with no callback the cards stay
    // keyboard-only and expose no mouse handler at all.
    toggleExpanded: typeof d.toggleExpanded === 'function' ? d.toggleExpanded : undefined,
  };
}

function themeFg(theme, role, text) {
  try {
    if (theme && typeof theme.fg === 'function') return theme.fg(role, text);
  } catch {
    // A hostile theme never breaks the card; fall through to plain text.
  }
  return text;
}

function expandHint(helpers, expanded) {
  const suffix = expanded ? 'to collapse' : 'to expand';
  if (helpers.keyHint) {
    try {
      const hinted = helpers.keyHint('app.tools.expand', suffix);
      const clean = oneLine(hinted, '');
      if (clean.length > 0) return clean;
    } catch {
      // Fall through to the static hint below.
    }
  }
  return `ctrl+o ${suffix}`;
}

// Click-to-expand seam (opt-in, host-driven).
//
// The installed pi-tui delivers a click to the component that CLAIMED the
// press: tui-alt-screen.js records `mousePressTarget` from the press dispatch
// result and, on release at the same cell, synthesizes a `click` retargeted to
// that exact component. So the press must return { handled: true } or the click
// never arrives. Both host shells reach a card component: tool cards through
// tool-execution.js's MouseRegion (which dispatches to its child first) and
// message cards through CustomMessageComponent — a Container — forwarding to
// the renderer component.
//
// The card therefore claims the HINT's own cells and nothing else, and only a
// left press/click: everywhere else it returns undefined, so the host's own
// click behavior (the MouseRegion toggle, text selection, links) is exactly
// what it was. The callback flips the host's global expansion state — the
// renderer keeps no expansion state of its own, so the keyboard path
// (app.tools.expand / ctrl+o) stays the single source of truth.

// The hint's cell rectangle inside the rendered card: the row it was drawn on
// and its half-open column range. Read back from the rendered lines, so it
// follows the real geometry of both card styles (float heading band, outputPad
// margin, wrapped heading) instead of a second, drifting calculation. Only the
// card's top rule ever carries the hint text, and it is searched first, so the
// body can never masquerade as a click region.
function locateHint(lines, hint, helpers) {
  const text = typeof hint === 'string' ? oneLine(hint, '') : '';
  if (text.length === 0 || !Array.isArray(lines)) return undefined;
  for (let row = 0; row < lines.length; row += 1) {
    const plain = stripAnsi(String(lines[row]));
    const index = plain.indexOf(text);
    if (index < 0) continue;
    const start = floatMeasure(plain.slice(0, index), helpers);
    return { row, start, end: start + floatMeasure(text, helpers) };
  }
  return undefined;
}

function hintMouseEvent(event, rect, helpers) {
  if (!rect) return undefined;
  const e = asRecord(event);
  if (e.button !== 'left') return undefined;
  if (e.type !== 'press' && e.type !== 'click') return undefined;
  if (typeof e.x !== 'number' || typeof e.y !== 'number') return undefined;
  if (e.y !== rect.row) return undefined;
  if (!(e.x >= rect.start && e.x < rect.end)) return undefined;
  if (e.type === 'click') {
    try {
      helpers.toggleExpanded();
    } catch {
      // A hostile host callback never breaks the card or the transcript.
    }
    return { handled: true };
  }
  // The press CLAIMS the gesture so the host retargets the synthesized click
  // here, and asks for no repaint so the row it just measured stays valid.
  return { handled: true, render: false };
}

// The component shell every card returns: render once per width, remember where
// the hint landed, and — only when the toggle callback was injected — claim the
// mouse on exactly those cells.
function cardComponent({ helpers, hint, renderLines }) {
  let hintRect;
  const component = {
    render(width) {
      const lines = renderLines(width);
      hintRect = locateHint(lines, hint, helpers);
      return lines;
    },
    invalidate() {},
  };
  if (typeof helpers.toggleExpanded === 'function') {
    component.handleMouse = (event) => hintMouseEvent(event, hintRect, helpers);
  }
  return component;
}

function formatDuration(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

// Duration reads ONLY from the host's ToolRenderContext.durationMs — the
// one timing field the installed Pi contract provides (milliseconds the
// execution took, undefined while it runs). ToolRenderResultOptions
// carries no timing, so options timing is never read. Nothing here starts
// a timer, so a card can never fabricate or leak one.
function durationOf(context) {
  return formatDuration(asRecord(context).durationMs);
}

// Shared row mark (the reference's RESULT_MARK pattern): renderResult tags
// the host-owned context.state object, which Pi shares across the call
// and result renders of one execution. While unmarked, the call closes
// its own frame; once marked, the call drops to the top rule and the
// result body closes the single shared frame — never two full cards.
const RESULT_MARK = Symbol.for('pi-odd-worktree.worktree-card.result');

function markCardResult(state) {
  if (state !== null && typeof state === 'object') {
    try {
      state[RESULT_MARK] = true;
    } catch {
      // A frozen state object never breaks the result render below.
    }
  }
}

function cardAwaitingResult(context) {
  const state = asRecord(context).state;
  if (state !== null && typeof state === 'object') {
    try {
      if (state[RESULT_MARK] === true) return false;
    } catch {
      // An unreadable state reads as awaiting: closed mini-card.
    }
  }
  return true;
}

function resultTextOf(result) {
  try {
    const content = result && Array.isArray(result.content) ? result.content : [];
    const texts = content
      .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
      .map((entry) => safeText(entry.text));
    return texts.join('\n');
  } catch {
    return '';
  }
}

function isErrorResult(result, options, context) {
  if (result && result.isError === true) return true;
  if (asRecord(options).isError === true) return true;
  if (asRecord(context).isError === true) return true;
  return false;
}

// Tool-specific one-line summaries read from result.details — the same
// shapes execute() already returns. Unknown or malformed details fall back
// to the result's first line, never to a throw.
function summarizeWorktreeResult(toolName, result) {
  const details = asRecord(result ? result.details : undefined);
  const text = resultTextOf(result);
  const firstLine = oneLine(text, EMPTY_TEXT);
  const failed = result && result.isError === true;

  switch (toolName) {
    case 'worktree_create': {
      const branch = oneLine(details.branch, '');
      const target = baseName(details.path) || branch || firstLine;
      if (failed) return branch.length > 0 ? `error · ${branch}` : `error · ${firstLine}`;
      if (details.alreadyExists === true) return `already at ${target}`;
      return branch.length > 0 ? branch : target;
    }
    case 'worktree_list': {
      const count = typeof details.count === 'number' ? details.count : undefined;
      if (failed) return `error · ${firstLine}`;
      if (count === 0) return 'no worktrees';
      if (count !== undefined) return `${count} checkout${count === 1 ? '' : 's'}`;
      return firstLine;
    }
    case 'worktree_delete': {
      const target = baseName(details.path) || oneLine(details.branch, '') || firstLine;
      if (failed) return `error · ${target}`;
      return details.branchKept === false ? `removed ${target}` : `removed ${target} · branch kept`;
    }
    case 'worktree_session_open': {
      const worktree = oneLine(details.worktree, '');
      const session = oneLine(details.sessionId, '');
      const name = [worktree, session].filter((part) => part.length > 0).join(' · ') || firstLine;
      if (failed) return `error · ${name}`;
      return details.resumed === true ? `${name} · resumed` : name;
    }
    case 'worktree_warp': {
      const name = oneLine(details.name, '');
      const branch = oneLine(details.branch, '');
      const label = [name, branch].filter((part) => part.length > 0).join(' · ') || firstLine;
      if (failed) return `error · ${label}`;
      return details.resumed === true ? `${label} · resumed` : label;
    }
    default:
      return firstLine;
  }
}

// The S19 slug: mirrors lib/worktree-git.js slugifyBranch (lowercase,
// non-alphanumeric runs to one dash, trimmed, `worktree` fallback) and
// the extension's slugPart, so the card's compact rows name the same
// identifier the agent text and the listing print, without an import.
function slugify(value) {
  try {
    const slug = safeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? 'worktree' : slug;
  } catch {
    return 'worktree';
  }
}

// A thread is worth a row only when it is real: the registry's `unknown`
// placeholder carries no information.
function threadValue(value) {
  const thread = oneLine(value, '');
  return thread.length > 0 && thread !== 'unknown' ? thread : '';
}

// The create outcome in the words the agent text uses: a call that found the
// thread's checkout already there must never be reported as a fresh create
// (S12: the card never hides what really happened).
function createStatus(details) {
  return details.alreadyExists === true ? 'already existed' : 'created';
}

// S8: the collapsed create card is the STATUS ROW ONLY. The name is implied by
// the path and the branch is the tool's own input, so a collapsed
// `created: <slug> · <branch>` row repeated what the caller already knew. The
// identity, the path, the registry write and the CodeGraph state all live in
// the expanded detail.
function createHead(details) {
  if (oneLine(details.branch, '').length === 0 && oneLine(details.path, '').length === 0) return '';
  return `status: ${createStatus(details)}`;
}

// S6: the ONE CodeGraph fact of a create, read from `details.codegraph` (the
// extension publishes the creation hook's own `codegraph-init` outcome). The
// wording matches the agent text line exactly — the same status reads the same
// in both places, including when the card renderer itself is unavailable and
// the extension has to format it alone.
function codegraphValue(codegraph) {
  const record = asRecord(codegraph);
  const status = oneLine(record.status, '');
  const detail = oneLine(record.detail, '');
  if (status === 'done' || status === 'present') return 'initialized';
  if (status === 'absent') return 'not initialized';
  if (status === 'skipped' || status === 'failed') {
    return detail.length > 0 ? `not initialized (${detail})` : 'not initialized';
  }
  if (status === 'not-run') return detail.length > 0 ? `not run (${detail})` : 'not run';
  return '';
}

// S12 expanded detail: the collapsed card says only what happened, so the
// path, the status and the outcome nuances live here as ordered
// `label: value` rows read from the SAME details execute() returns. This
// is what replaces the raw content dump the transcript used to print
// (`worktree list: … thread=t issues=1 odd=a,b,c`) — no repeated prefix,
// no key=value pairs, no giant list on one line. A result the details
// cannot describe returns [] so the caller falls back to the content
// text, never to an invented or blank body.
function formattedDetailRows(toolName, details) {
  switch (toolName) {
    case 'worktree_create': {
      // S8: the branch is the tool's input and the name is implied by the
      // path, so neither gets a row. What remains is what the caller cannot
      // derive: the status, where the checkout landed, what the registry write
      // actually did (S7) and the real CodeGraph state.
      const branch = oneLine(details.branch, '');
      const target = oneLine(details.path, '');
      if (branch.length === 0 && target.length === 0) return [];
      const rows = [`status: ${createStatus(details)}`];
      if (target.length > 0) rows.push(`path: ${target}`);
      const registered = oneLine(details.registered, '');
      if (registered.length > 0) rows.push(`registered: ${registered}`);
      // S6: what CodeGraph actually did — never an issue or ODD association,
      // which a create neither accepts nor records.
      const codegraph = codegraphValue(details.codegraph);
      if (codegraph.length > 0) rows.push(`codegraph: ${codegraph}`);
      return rows;
    }
    case 'worktree_list': {
      // S6: the expanded listing is a LIST — one block per checkout, one blank
      // row between blocks — not one undifferentiated column of label rows,
      // where an entry's `path:`/`thread:` ran straight into the next entry's
      // identity.
      if (!Array.isArray(details.worktrees)) return [];
      const entries = details.worktrees;
      const count = typeof details.count === 'number' ? details.count : entries.length;
      const rows = [`checkouts: ${count}`];
      const blocks = [];
      for (const entry of entries) {
        const row = asRecord(entry);
        const name = oneLine(row.name, '') || baseName(row.path);
        const branch = oneLine(row.branch, '');
        // S6: being listed IS the existence proof — a checkout whose path is
        // gone is pruned before it can be listed — so `live`/`exists` is a row
        // that only repeats itself. The statuses that carry information
        // (`missing`: the path exists but git no longer lists the checkout;
        // `unregistered`: a live checkout the registry does not own) stay, as
        // one trailing cell of the entry's identity row instead of a row of
        // their own.
        const status = oneLine(row.status, '');
        const notable = status === 'live' || status === 'exists' ? '' : status;
        const identity = [name, branch, notable].filter((part) => part.length > 0).join(' \u00B7 ');
        const block = [];
        if (identity.length > 0) block.push(identity);
        const target = oneLine(row.path, '');
        if (target.length > 0) block.push(`path: ${target}`);
        const thread = threadValue(row.thread);
        if (thread.length > 0) block.push(`thread: ${thread}`);
        // S1: a worktree carries no issue list and no ODD document, so the
        // entry is its identity — never an `issues:`/`odd:` association row.
        // The extension publishes no association field at all, and legacy
        // fields a producer might still supply are deliberately not rendered.
        if (block.length > 0) blocks.push(block);
      }
      blocks.forEach((block, index) => {
        if (index > 0) rows.push('');
        rows.push(...block);
      });
      return rows;
    }
    case 'worktree_delete': {
      const branch = oneLine(details.branch, '');
      const target = oneLine(details.path, '');
      if (branch.length === 0 && target.length === 0) return [];
      const rows = [];
      const name = branch.length > 0 ? slugify(branch) : baseName(target);
      if (name.length > 0) rows.push(`name: ${name}`);
      if (branch.length > 0) rows.push(`branch: ${branch}`);
      if (target.length > 0) rows.push(`path: ${target}`);
      rows.push(`branch state: ${details.branchKept === false ? 'deleted' : 'kept'}`);
      const thread = threadValue(details.thread);
      if (thread.length > 0) rows.push(`thread: ${thread}`);
      return rows;
    }
    case 'worktree_session_open': {
      const worktree = oneLine(details.worktree, '');
      const session = oneLine(details.sessionId, '');
      const target = oneLine(details.path, '');
      if (worktree.length === 0 && session.length === 0 && target.length === 0) return [];
      const rows = [];
      if (worktree.length > 0) rows.push(`worktree: ${worktree}`);
      if (session.length > 0) rows.push(`session: ${session}`);
      const branch = oneLine(details.branch, '');
      if (branch.length > 0) rows.push(`branch: ${branch}`);
      if (target.length > 0) rows.push(`path: ${target}`);
      rows.push(`status: ${details.resumed === true ? 'resumed' : 'opened'}`);
      const agent = oneLine(details.agentName, '');
      if (agent.length > 0) rows.push(`agent: ${agent}`);
      return rows;
    }
    case 'worktree_warp': {
      const rows = [];
      const from = oneLine(details.fromName, '')
        || oneLine(details.fromDesc, '').split('\u00B7')[0].trim().replace(/\s+/g, ' ');
      const name = oneLine(details.name, '');
      const target = oneLine(details.path, '');
      const branch = oneLine(details.branch, '');
      if (from.length > 0) rows.push(`moved: ${from}`);
      if (name.length > 0) rows.push(`to: ${name}`);
      if (details.alreadyThere === true) rows.push('status: already there');
      if (target.length > 0) rows.push(`path: now in "${target}"`);
      if (branch.length > 0) rows.push(`branch: now in "${branch}"`);
      return rows;
    }
    default:
      return [];
  }
}

// Collapsed success bodies (S12): the precise action and the identity it
// acted on — nothing else. Paths, thread ids, issue numbers and odd
// documents belong to the expanded detail above, so a transcript of five
// calls stays scannable. Malformed details fall back to the result's first
// line, never to a throw; failures keep the summary plus preview shape
// summarizeWorktreeResult pins.
function compactBodyRows(toolName, result) {
  const details = asRecord(result ? result.details : undefined);
  const text = resultTextOf(result);
  const firstLine = oneLine(text, EMPTY_TEXT);
  switch (toolName) {
    case 'worktree_create': {
      const head = createHead(details);
      return head.length > 0 ? [head] : [firstLine];
    }
    case 'worktree_list': {
      // The listing contract puts the PRINCIPAL first and the session's own
      // checkout second when the two differ, and the result carries no field
      // naming which entry is current. So the compact card names the action
      // and the count only: a `current:` identity inferred from array order
      // would read `current: principal` for a session in a linked worktree.
      // The per-entry rows live in the expanded detail.
      const count = typeof details.count === 'number' ? details.count : undefined;
      // An empty listing compacts to one line; a result with no text at
      // all still says so, exactly as the placeholder contract pins.
      if (count === 0) return text.length > 0 ? ['no worktrees'] : ['no worktrees', EMPTY_TEXT];
      // No count in the details means no honest action line: the first line
      // of the result stands in rather than a guessed total.
      if (count === undefined) return [firstLine];
      return [`listed: ${count} checkout${count === 1 ? '' : 's'}`];
    }
    case 'worktree_delete': {
      const branch = oneLine(details.branch, '');
      const target = baseName(details.path) || branch;
      if (target.length === 0) return [firstLine];
      const name = branch.length > 0 ? branch : target;
      return [`removed: ${slugify(name)} \u00B7 ${name}`, details.branchKept === false ? 'branch deleted' : 'branch kept'];
    }
    case 'worktree_session_open': {
      const worktree = oneLine(details.worktree, '');
      const session = oneLine(details.sessionId, '');
      if (worktree.length === 0 && session.length === 0) return [firstLine];
      const head = `opened: ${worktree.length > 0 ? worktree : 'worktree'} \u00B7 ${session.length > 0 ? session : '(unknown session)'}`;
      // A resume is an outcome; the checkout path is expanded detail.
      return details.resumed === true ? [head, 'resumed'] : [head];
    }
    case 'worktree_warp': {
      // S42 compact: EXACTLY the two name-only rows, mirroring the warp
      // message renderer below — `moved: <source name>` then
      // `to: <target name>`, no branch and no path on either row. The
      // expanded form adds the S42 path/branch rows, so the collapsed pair
      // is the only special case here.
      const from = oneLine(details.fromName, '')
        || oneLine(details.fromDesc, '').split('\u00B7')[0].trim().replace(/\s+/g, ' ');
      const name = oneLine(details.name, '');
      if (from.length > 0 && name.length > 0) return [`moved: ${from}`, `to: ${name}`];
      return [firstLine];
    }
    default:
      return [firstLine];
  }
}

function callSubject(toolName, args) {
  const params = asRecord(args);
  switch (toolName) {
    case 'worktree_create':
      return oneLine(params.branch, '');
    case 'worktree_list':
      return params.all === true ? 'all' : '';
    case 'worktree_delete':
      return oneLine(params.name ?? params.branch ?? params.path, '');
    case 'worktree_session_open':
      return oneLine(params.worktree, '');
    case 'worktree_warp':
      return oneLine(params.name, '');
    default:
      return '';
  }
}

function warningLines(details) {
  const warnings = Array.isArray(details.warnings) ? details.warnings : [];
  const extra = [];
  if (typeof details.pruneError === 'string' && details.pruneError.length > 0) extra.push(details.pruneError);
  return [...warnings, ...extra]
    .map((warning) => oneLine(warning, ''))
    .filter((warning) => warning.length > 0);
}

// Host outputPad contract (installed Pi 1.3.0 ToolRenderContext):
// renderShell:self cards apply the pad themselves — the host wraps them
// in a plain Container with no padding, while default-shell content goes
// through setPaddingX(outputPad) on both sides (pi-tui Text: content in
// width − 2×pad, one margin each side). Non-finite or negative pads read
// as zero, so contexts without the field keep the unpadded shape.
function padCount(context) {
  const pad = asRecord(context).outputPad;
  if (typeof pad !== 'number' || !Number.isFinite(pad) || pad <= 0) return 0;
  return Math.floor(pad);
}

// Card affordance geometry (hint on top): the ctrl+o expand/collapse hint
// belongs on the card's TOP rule and the closing rule belongs to the
// evidence-backed duration alone (`NNNms`/`N.Ns`) — one corner, one fact. `tailParts` splits a row into its
// lead, the fill and the right-aligned tail, and drops the tail entirely when
// it would leave no fill column, so a card identity is never truncated to
// make room for an affordance. Both card styles build their top row from it.
function tailParts(lead, tail, inner, helpers) {
  const head = typeof lead === 'string' ? lead : '';
  const tailText = typeof tail === 'string' ? oneLine(tail, '') : '';
  if (tailText.length === 0) return { head, fill: '', tail: '' };
  const fill = Math.floor(inner) - floatMeasure(head, helpers) - floatMeasure(tailText, helpers);
  if (fill < 1) return { head, fill: '', tail: '' };
  return { head, fill: ' '.repeat(fill), tail: tailText };
}

// Every row opens with the accent bar (the float-card left border from the
// reference). The header row is the call card's top rule and carries the
// expand hint right-aligned; a null header means a body-only result under
// that rule (the hint lives on the call card's header above it, never
// repeated down here). The closing rule carries the duration only;
// close:false omits it so a paired call leaves the frame to its result.
// Widths too narrow for the bar-plus-space prefix degrade to the bar alone
// rather than overflowing; only width 0 — or padding that leaves no
// column — draws nothing.
function buildCard({ helpers, theme, toneRole, header, rows, hint, duration, width, close = true, context, bgRole, wrap = false }) {
  void bgRole;
  const target = Math.max(0, Math.floor(width));
  if (target === 0) return [];
  const wrapRows = (list, budget) => wrap === true
    ? list.flatMap((row) => wrapTextToWidth(row, budget, helpers))
    : list;
  // S24: the float card when the theme carries the tone background at
  // this width — full-width padded rows in one-column margins — else the
  // outlined card below, byte-identical to before.
  const open = floatOpener(theme, toneRole, target);
  if (open.length > 0) {
    return paintFloatRows(floatCardRows({
      helpers, theme, toneRole, header, rows, hint, duration, close,
      inner: target - FLOAT_MARGIN * 2, wrap,
    }), open);
  }
  const pad = padCount(context);
  const body = target - 2 * pad;
  if (body < 1) return [];
  const bar = themeFg(theme, toneRole, ACCENT_BAR);
  const roomy = body >= 2;
  const prefix = roomy ? `${bar} ` : bar;
  const inner = Math.max(0, body - (roomy ? 2 : 1));
  const fit = (text) => {
    const clean = oneLine(text, '');
    let measured = 0;
    try {
      measured = helpers.visibleWidth(stripAnsi(clean));
    } catch {
      measured = localVisibleWidth(clean);
    }
    if (measured <= inner) return clean;
    try {
      return helpers.truncateToWidth(clean, inner, '…');
    } catch {
      return localTruncate(clean, inner);
    }
  };
  const margin = ' '.repeat(pad);
  const lines = [];
  // S39: expanded wraps every row to the inner width; compact clips via fit().
  const bodyRows = wrap === true ? wrapRows(Array.isArray(rows) ? rows : [], inner) : rows;
  const headRows = header !== null && header !== undefined
    ? (wrap === true ? wrapRows([header], inner) : [fit(header)])
    : [];
  headRows.forEach((line, index) => {
    // the hint rides the last top-rule row, right-aligned; a wrapped
    // header keeps its continuation rows plain.
    const parts = index === headRows.length - 1
      ? tailParts(line, hint, inner, helpers)
      : { head: line, fill: '', tail: '' };
    lines.push(`${margin}${prefix}${themeFg(theme, toneRole, parts.head)}${parts.fill}${parts.tail}${margin}`);
  });
  for (const row of bodyRows) lines.push(`${margin}${prefix}${wrap === true ? row : fit(row)}${margin}`);
  if (close) {
    // the closing rule belongs to the duration alone — right-aligned
    // when the host supplied timing evidence, bare otherwise. Nothing is
    // invented and no placeholder dash ever stands in for a duration.
    const rule = tailParts(fit('─'), duration, inner, helpers);
    lines.push(`${margin}${prefix}${rule.head}${rule.fill}${rule.tail}${margin}`);
  }
  return lines;
}

// S24 float recipe (gentle-shell lib/shell-card.ts, CARD_STYLE.FLOAT),
// ported mechanics, not an approximation: a one-column transparent margin
// on both sides; float chrome { topLeft:"\u258E", topLead:" ",
// topRight:"  ", rule:" ", side:"\u258E", rail:" ", bottomLeft:"\u258E",
// bottomRight:" " }; every row padded to the full target width so the
// painted band is a full-width rectangle; a blank padding row above the
// heading and between heading and body; the opener is theme.bg(role,"")
// minus its trailing \x1b[49m, re-armed after every inner reset and
// closed with \x1b[49m; roles by tone (info/success toolSuccessBg,
// warning toolPendingBg, error toolErrorBg — customMessageBg is used
// nowhere in gentle-shell); outlined fallback when the theme lacks the
// role or the width is under 10; the duration rides the closing rule
// only when it fits and is omitted entirely otherwise, never as a
// placeholder dash. No invented hex ever reaches the transcript — only
// these documented role names.
const FLOAT_CHROME = { topLeft: '\u258E', topLead: ' ', topRight: '  ', rule: ' ', side: '\u258E', rail: ' ', bottomLeft: '\u258E', bottomRight: ' ' };
const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE = { info: 'toolSuccessBg', success: 'toolSuccessBg', warning: 'toolPendingBg', error: 'toolErrorBg' };
const BG_RESET = '\x1b[49m';
// Full resets (pi-tui truncation inserts one) and background resets both
// clear the background.
const BG_CLEARING = /\x1b\[(?:0|49)?m/g;

function floatBgRoleForTone(tone) {
  try {
    if (typeof tone === 'string' && Object.prototype.hasOwnProperty.call(FLOAT_BG_ROLE, tone)) {
      return FLOAT_BG_ROLE[tone];
    }
  } catch {
    // An unusable tone reads as no role: the outlined card below.
  }
  return '';
}

// The tone background opener when the float style applies at this width,
// or "" for the outlined card: width under 10, an unknown tone, a theme
// without theme.bg, or a bg that carries no role (no trailing reset).
function floatOpener(theme, tone, width) {
  try {
    if (Math.floor(width) < FLOAT_MIN_WIDTH) return '';
    const role = floatBgRoleForTone(tone);
    if (!role || !theme || typeof theme.bg !== 'function') return '';
    const painted = theme.bg(role, '');
    if (typeof painted !== 'string' || painted.length === 0) return '';
    return painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : '';
  } catch {
    return '';
  }
}

// Paints every row behind its tone background, re-armed after any reset
// the content carries, inside a transparent one-column margin on both
// sides. Padding rows keep their tone-coloured accent just like content.
function paintFloatRows(rows, open) {
  const margin = ' '.repeat(FLOAT_MARGIN);
  return rows.map((row) => `${margin}${open}${String(row).replace(BG_CLEARING, (reset) => reset + open)}${BG_RESET}${margin}`);
}

function floatMeasure(text, helpers) {
  try {
    return helpers.visibleWidth(stripAnsi(text));
  } catch {
    return localVisibleWidth(stripAnsi(text));
  }
}

function floatFit(text, width, helpers) {
  const clean = oneLine(text, '');
  if (floatMeasure(clean, helpers) <= width) return clean;
  try {
    return helpers.truncateToWidth(clean, width, '\u2026');
  } catch {
    return localTruncate(clean, width);
  }
}

// S39 expanded wrapping: in the expanded form NOTHING may be cut — long
// lines wrap to the inner width instead of truncating with an ellipsis.
// Only the compact (collapsed) row may clip. Wrapping is character based
// on visible columns, so every emitted line fits its budget.
function wrapTextToWidth(text, width, helpers) {
  const clean = oneLine(text, '');
  const budget = Math.max(0, Math.floor(width));
  if (budget <= 0) return [clean];
  const measure = (line) => floatMeasure(line, helpers);
  if (measure(clean) <= budget) return [clean];
  const lines = [];
  let current = '';
  for (const char of clean) {
    const next = current + char;
    if (measure(next) <= budget || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = char;
    }
  }
  lines.push(current);
  return lines;
}

// One float content row at exactly `inner` visible columns: the accent
// bar, one space, the text padded out, one space, the right rail. An
// optional `tail` (the expand hint on the heading row) right-aligns
// inside the content columns and is dropped when it leaves no fill column.
function floatContentRow({ helpers, theme, toneRole, text, inner, paint, noClip = false, tail }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.side);
  const contentCols = Math.max(0, inner - 4);
  // With noClip (S39 expanded) the text was already wrapped to fit, so it
  // is never truncated here.
  const fit = noClip === true ? oneLine(text, '') : floatFit(text, contentCols, helpers);
  const parts = tailParts(fit, tail, contentCols, helpers);
  const styled = typeof paint === 'function' ? paint(parts.head) : parts.head;
  const used = floatMeasure(styled, helpers) + parts.fill.length + floatMeasure(parts.tail, helpers);
  const padded = `${styled}${parts.fill}${parts.tail}${' '.repeat(Math.max(0, contentCols - used))}`;
  return `${bar} ${padded} ${FLOAT_CHROME.rail}`;
}

function floatBlankRow({ theme, toneRole, inner }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.side);
  return `${bar}${' '.repeat(Math.max(0, inner - 1))}`;
}

// The closing rule (hint on top): the evidence-backed duration alone right-aligns
// on it, and only when it fits with at least one fill column — otherwise
// it is omitted entirely, never a placeholder dash. With the float chrome
// the rule itself is spaces, so an omitted duration leaves a blank painted
// band, never a bare dash. The expand hint lives on the heading row above.
function floatBottomRow({ helpers, theme, toneRole, duration, inner }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.bottomLeft);
  const tail = typeof duration === 'string' ? oneLine(duration, '') : '';
  if (tail.length > 0) {
    const tailWidth = floatMeasure(tail, helpers);
    const fill = inner - tailWidth - 3;
    if (fill >= 1) {
      return `${bar}${' '.repeat(fill)} ${floatFit(tail, tailWidth, helpers)} `;
    }
  }
  return `${bar}${' '.repeat(Math.max(0, inner - 1))}`;
}

function floatCardRows({ helpers, theme, toneRole, header, rows, hint, duration, close, inner, wrap = false }) {
  const blank = floatBlankRow({ theme, toneRole, inner });
  const out = [];
  const contentCols = Math.max(0, inner - 4);
  // S39: expanded wraps every row to the content width (noClip below, so
  // nothing is cut); compact keeps the single clipped row.
  const wrapList = (list) => wrap === true
    ? list.flatMap((row) => wrapTextToWidth(row, contentCols, helpers))
    : list;
  const headed = header !== null && header !== undefined;
  if (headed) {
    out.push(blank);
    const headLines = wrapList([header]);
    headLines.forEach((line, index) => {
      // the hint rides the last heading row, right-aligned inside the
      // painted band; a wrapped heading keeps its continuation rows plain.
      out.push(floatContentRow({
        helpers, theme, toneRole, text: line, inner, paint: (fit) => themeFg(theme, toneRole, fit),
        noClip: wrap === true, tail: index === headLines.length - 1 ? hint : undefined,
      }));
    });
  }
  const body = wrapList(Array.isArray(rows) ? rows : []);
  if (body.length > 0) {
    // The separator between heading and body — and the leading padding
    // of a header-less result, so a paired call plus its result still
    // reads as one card with the heading set off from its body.
    out.push(blank);
    for (const row of body) out.push(floatContentRow({ helpers, theme, toneRole, text: row, inner, noClip: wrap === true }));
  }
  if (close) out.push(floatBottomRow({ helpers, theme, toneRole, duration, inner }));
  return out;
}

function createWorktreeCardRenderer(toolName, deps) {
  if (!WORKTREE_TOOLS.has(toolName)) {
    throw new Error(`unknown worktree tool: ${safeText(toolName) || typeof toolName}`);
  }
  const helpers = resolveHelpers(deps);
  const glyph = GLYPH[toolName];
  const title = TITLE[toolName];

  function renderCall(args, theme, context) {
    const ctx = asRecord(context);
    const pending = ctx.isPartial !== false;
    const failed = ctx.isError === true;
    // Git-orange (warning) while running and settled; error only on failure.
    const toneRole = failed ? 'error' : 'warning';
    const subject = callSubject(toolName, args);
    const header = `${glyph} ${title}${subject.length > 0 ? ` · ${subject}` : ''}`;
    // Paired with a result: the top rule only, so the result body below
    // closes the one shared frame. Awaiting: a closed mini-card.
    const awaiting = cardAwaitingResult(ctx);
    const finished = ctx.isPartial === false || failed;
    // the card's top rule is the expand affordance's home, so the hint is
    // computed HERE and right-aligned on the header row — it is never repeated
    // on the closing rule below, which belongs to the duration alone. The gate
    // is `finished`, NOT `!awaiting`: the host renders the call before the
    // result that marks the shared row state, so gating on the mark would
    // delay the hint to a later re-render (and hide it entirely if none came).
    const hint = finished ? expandHint(helpers, ctx.expanded === true) : undefined;
    const rows = awaiting && pending && !failed ? [themeFg(theme, 'muted', `running${RUNNING_MARK}`)] : [];
    const close = awaiting;
    return cardComponent({
      helpers,
      hint,
      renderLines: (width) => buildCard({ helpers, theme, toneRole, header, rows, hint, duration: undefined, width, close, context: ctx }),
    });
  }

  function renderResult(result, options, theme, context) {
    const opts = asRecord(options);
    const ctx = asRecord(context);
    const expanded = opts.expanded === true || ctx.expanded === true;
    const partial = opts.isPartial === true;
    const failed = isErrorResult(result, opts, ctx);
    // Git-orange (warning) settled; error only on failure.
    const toneRole = failed ? 'error' : 'warning';
    markCardResult(ctx.state);
    // No repeated title: the call card above owns the header. Failures
    // keep their honest prose (the message IS the error detail); a settled
    // success formats the details into ordered label rows (S12); a result
    // the details cannot describe falls back to the content text; and the
    // collapsed card carries only the action and its identity.
    const header = null;
    const summary = summarizeWorktreeResult(toolName, result);
    const text = resultTextOf(result);
    const bodyLines = text.length > 0 ? text.split('\n') : [EMPTY_TEXT];
    const warnings = warningLines(asRecord(result ? result.details : undefined));
    // this body-only half has no top rule, so it renders no hint — the
    // card's expand affordance rides the call card's header row above it
    // (renderCall), and this card's closing rule carries the duration alone.
    const duration = durationOf(ctx);
    let rows;
    if (failed) {
      // The prose is the error detail: expanded keeps all of it, the
      // collapsed card keeps the bounded preview.
      const prose = bodyLines.filter((line) => line.trim().length > 0);
      const shown = expanded ? prose : prose.slice(0, COLLAPSED_PREVIEW_ROWS);
      rows = [summary, ...(shown.length > 0 ? shown : [EMPTY_TEXT])];
    } else if (expanded) {
      const detail = formattedDetailRows(toolName, asRecord(result ? result.details : undefined));
      rows = detail.length > 0 ? detail : [summary, ...bodyLines];
    } else {
      rows = compactBodyRows(toolName, result);
    }
    if (partial && !failed) {
      rows.push(`receiving${RUNNING_MARK}`);
    } else if ((expanded || failed) && !partial) {
      for (const warning of warnings) rows.push(`! ${warning}`);
    }
    return cardComponent({
      helpers,
      // No hint on this half (header is null): the seam's rect lookup finds
      // nothing, so the result body never claims a mouse cell.
      hint: undefined,
      // S39: expanded wraps long lines to the inner width (nothing cut);
      // only the compact row may clip.
      renderLines: (width) => buildCard({ helpers, theme, toneRole, header, rows, duration, width, close: true, context: ctx, wrap: expanded === true }),
    });
  }

  return { renderShell: 'self', renderCall, renderResult };
}

// Warp confirmation message renderer (customize-command T13/S20).
//
// The warp is a COMMAND, so it never passes through the tool cards above:
// its one visible confirmation is this custom-message renderer, which the
// extension registers for the `worktree-warp` customType via
// `pi.registerMessageRenderer`. Compact shows the capitalised label plus
// the two ordered lines; expanded adds the checkout path on ctrl+o (S41:
// never repeats in the card body what the notice already says) — the same
// geometry as the tool cards
// (accent bar, right-aligned hint, outputPad on the outlined fallback;
// one-column margins and full-width painted rows on the float card). The
// tone is the documented `warning` role: the installed Pi theme schema
// exposes no orange role, so warning (yellow in the built-in themes) is
// the closest documented match for git-orange, and the float card paints
// it behind `toolPendingBg` per the tone table. Compact shows the
// capitalised label plus the two S42 name-only rows; expanded appends
// exactly `path: now in "<path>"` and `branch: now in "<branch>"` in
// that order (S41/S42: the long prose notice never enters the card body).
// Warp failures never send a message (they notify instead), so `error`
// never appears here. The compact rows read from
// message.details — never by parsing text — with a content fallback when
// details are malformed; a foreign customType returns undefined so the
// host default renderer takes over. Untrusted strings are sanitized
// exactly like the tool cards, and the hook never throws.
const WARP_CUSTOM_TYPE = 'worktree-warp';
const WARP_GLYPH = '\u2387';
const WARP_TITLE = 'Warp \u00B7 moved';

function warpMessageText(message) {
  const content = message ? message.content : undefined;
  if (typeof content === 'string') return safeText(content);
  if (Array.isArray(content)) {
    try {
      return content
        .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
        .map((entry) => safeText(entry.text))
        .join('\n');
    } catch {
      return '';
    }
  }
  return '';
}

// S42 warp compact: EXACTLY two name-only rows — `moved: <source name>`
// then `to: <target name>` — with no branch and no path on either row.
// The source name travels explicitly as details.fromName; details written
// before that field fall back to the name segment of fromDesc (the text
// before "·"), and the target name is details.name. A foreign or
// malformed payload falls back to the message content, never to a throw.
function warpSourceName(details) {
  const named = oneLine(details.fromName, '');
  if (named.length > 0) return named;
  const cut = oneLine(details.fromDesc, '').split('\u00B7')[0].trim().replace(/\s+/g, ' ');
  return cut;
}

function warpCompactRows(message) {
  const details = asRecord(message ? message.details : undefined);
  const from = warpSourceName(details);
  const name = oneLine(details.name, '');
  if (from.length > 0 && name.length > 0) {
    return [`moved: ${from}`, `to: ${name}`];
  }
  return [oneLine(warpMessageText(message), EMPTY_TEXT)];
}

function createWarpMessageRenderer(deps) {
  const helpers = resolveHelpers(deps);
  return function renderWarpMessage(message, options, theme) {
    if (!message || message.customType !== WARP_CUSTOM_TYPE) return undefined;
    const opts = asRecord(options);
    const expanded = opts.expanded === true;
    const context = { outputPad: opts.outputPad };
    const header = `${WARP_GLYPH} ${WARP_TITLE}`;
    let rows = warpCompactRows(message);
    if (expanded) {
      // S42: expanded adds exactly these two rows after the compact pair,
      // in this order — and nothing else (never the prose notice).
      const detail = asRecord(message.details);
      const to = oneLine(detail.to, '');
      const branch = oneLine(detail.branch, '');
      if (to.length > 0) rows = [...rows, `path: now in "${to}"`];
      if (branch.length > 0) rows = [...rows, `branch: now in "${branch}"`];
    }
    const hint = expandHint(helpers, expanded);
    return cardComponent({
      helpers,
      hint,
      // S39: expanded wraps long lines to the inner width (nothing cut);
      // only the compact row may clip.
      renderLines: (width) => buildCard({ helpers, theme, toneRole: 'warning', header, rows, hint, duration: undefined, width, close: true, context, wrap: expanded === true }),
    });
  };
}

module.exports = {
  createWorktreeCardRenderer,
  createWarpMessageRenderer,
  wrapTextToWidth,
  summarizeWorktreeResult,
  floatBgRoleForTone,
  safeText,
  stripAnsi,
  WORKTREE_TOOLS: [...WORKTREE_TOOLS],
};

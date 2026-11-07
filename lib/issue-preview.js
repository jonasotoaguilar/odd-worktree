'use strict';
// ONE issue preview, migrated from the source package's issue panel (S16), where
// it was shared by every surface that shows an issue beside a list and was
// extracted whole so a field added once showed up everywhere. That second,
// smaller formatter had left the detail pane without assignees, comments or
// projects. Here `/issues` renders through this formatter once it is wired, and
// the field set is the original one whole — nothing shrank in the move.
//
// Purity: plain data in, styled strings out. The caller injects `paint`,
// `emphasis`, its own `wrap` and, for deterministic tests, the clock. No
// filesystem, network or registry access happens here.
//
// Contract
//   issueDetailLines(detail, comments, options) -> string[]
//     detail   an issue as `gh` normalizes it (number, title, state, author,
//              labels, assignees, createdAt, updatedAt, commentsCount,
//              reactions{plusOne}, projects, linkedPullRequestCount,
//              metadataError, body). Every field is optional.
//     comments an array of `{ author, body, createdAt }`; anything else is
//              treated as "no comments yet".
//     options  { width, paint, emphasis, wrap, cache, note, pending, now }
//              `note`    an extra short fact for the state row (a caller may
//                        pass a worktree's assignment state); it never
//                        replaces a fact of the issue itself.
//              `pending` true while a richer read is still in flight: the
//                        fields already known render, the read is named, and
//                        the body/comments are NOT invented from the row.
//              `now`     epoch ms for the relative ages.
//              `cache`   a wrap memo from `createWrapCache()`; the default is
//                        the module's shared instance (S23).
//
// S23: the wrap is memoized. A repaint at an unchanged width used to re-wrap
// the whole body and every comment of the issue on screen; the memo is keyed
// by the EXACT text and the width it was wrapped for, so an unchanged repaint
// wraps nothing while a changed body or pane always misses — a stale row can
// never be served.
//
// Absent metadata is omitted rather than printed as "none" or "0": an empty
// assignee/project list or a zero PR count does not add an optional row;
// reaction/comment counters remain explicit facts, including measured zeros.
//
// S13: the title is a TITLE, not a control. Its role comes from the shared
// table in `lib/tui-paint.js` (`ROLES.title`) instead of a role name written
// here, so this preview cannot drift into its own title colour: the `/issues`
// reading pane, the reader frames and the warp/create panels all paint their
// titles with the one role, and a change to that table moves every one of them
// at once. That role is `customMessageLabel` — the one the
// Pi Agents view paints its own frame title with (`gentle-pi/lib/agents-view.ts:42`
// maps `TITLE: "customMessageLabel"`, painted at line 437). The rest of the formatter keeps the
// roles it already had (`accent` state, `muted` notes, `border` comment rule,
// `dim` end marker) and everything else stays the caller's plain text.

const { ROLES: PALETTE_ROLES } = require('./tui-paint.js');

// The one role a title is painted with. Read once from the shared table: a
// surface that injects its own `paint` still resolves the ROLE (never a colour)
// through its own theme.
const TITLE_ROLE = PALETTE_ROLES.title;

function labelName(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return '';
}

function assigneeName(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.login === 'string') return entry.login;
  return '';
}

function commentAuthor(comment) {
  if (typeof comment.author === 'string') return comment.author;
  if (comment.author && typeof comment.author.login === 'string') return comment.author.login;
  return 'unknown';
}

// The package's one clock style (issues view, warp facts): just now, minutes,
// hours, days, months, years, always with the `ago` suffix so two surfaces
// never describe the same instant two different ways.
function relativeTime(iso, nowMs) {
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return 'unknown time';
  const diff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - when;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Word wrap that never splits a word unless the word alone is wider than the
// pane, and that keeps blank lines as blank rows.
function wrapText(text, width) {
  const room = Math.max(1, Math.floor(Number(width) || 1));
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (line !== '' && (line + ' ' + word).length <= room) {
        line += ' ' + word;
        continue;
      }
      if (line !== '') out.push(line);
      let tail = word;
      while (tail.length > room) {
        out.push(tail.slice(0, room));
        tail = tail.slice(room);
      }
      line = tail;
    }
    out.push(line);
  }
  return out.length === 0 ? [''] : out;
}

// One wrap memo entry holds the rows of ONE `wrap` call (a body, a comment),
// and the smallest real caller adds a handful of short lines per paint, so this
// budget covers several issues at both pane widths instead of thrashing.
const WRAP_CACHE_ENTRIES = 400;
// A pathological result (a very narrow pane over a huge body) is returned
// without being stored, so one odd paint cannot pin an enormous row set.
const WRAP_CACHE_ROWS = 20000;

/**
 * A bounded memo of finished wraps, keyed by width + the exact text.
 *
 * Both halves of the key are the whole input of `wrapText`, so a hit can only
 * return rows that the same text at the same width already produced: the memo
 * changes cost, never output. Callers treat the returned rows as read-only —
 * `issueDetailLines` spreads them into its own array.
 *
 * `stats.wraps` counts the wraps actually performed and `stats.hits` the
 * reuses, which is what makes "a repaint re-wraps nothing" observable.
 */
function createWrapCache(limit = WRAP_CACHE_ENTRIES) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : WRAP_CACHE_ENTRIES;
  const entries = new Map();
  const stats = { wraps: 0, hits: 0 };

  function wrap(text, width) {
    const room = Math.max(1, Math.floor(Number(width) || 1));
    const source = String(text ?? '');
    const key = `${room}\u0000${source}`;
    const cached = entries.get(key);
    if (cached) {
      stats.hits += 1;
      // Re-insert, so the Map's own order is the eviction order.
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    stats.wraps += 1;
    const lines = wrapText(source, room);
    if (lines.length <= WRAP_CACHE_ROWS) {
      entries.set(key, lines);
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    }
    return lines;
  }

  return { wrap, stats };
}

// Every caller that does not inject its own `wrap` shares this instance — every
// reading surface relies on the default — so the memo lives here instead of
// being wired twice.
const defaultWrapCache = createWrapCache();

function identity(_role, text) {
  return String(text);
}

function bold(text) {
  return String(text);
}

/**
 * The preview pane for ONE issue: identity, state, labels, assignees, author
 * and ages, reaction/comment counts, projects, linked PRs, the body and every
 * comment, in that order (S16).
 *
 * @returns {string[]} styled lines, already wrapped to `options.width`
 */
function issueDetailLines(detail, comments, options = {}) {
  const entry = detail && typeof detail === 'object' ? detail : {};
  const settings = options && typeof options === 'object' ? options : {};
  const width = Math.max(1, Math.floor(Number(settings.width) || 1));
  const paint = typeof settings.paint === 'function' ? settings.paint : identity;
  const emphasize = typeof settings.emphasis === 'function' ? settings.emphasis : bold;
  const cache = settings.cache && typeof settings.cache.wrap === 'function' ? settings.cache : defaultWrapCache;
  const wrap = typeof settings.wrap === 'function' ? settings.wrap : (text) => cache.wrap(text, width);
  const list = Array.isArray(comments) ? comments : [];
  const nowMs = Number.isFinite(settings.now) ? settings.now : Date.now();

  const lines = [];
  // S13: the title asks for the shared title role, and keeps its emphasis.
  lines.push(emphasize(paint(TITLE_ROLE, `#${entry.number} ${entry.title || '(no title)'}`)));
  const state = String(entry.state || 'open');
  const stateLine = [paint(state === 'closed' ? 'muted' : 'accent', `[${state}]`)];
  if (typeof settings.note === 'string' && settings.note.length > 0) {
    stateLine.push(paint('muted', settings.note));
  }
  lines.push(stateLine.join(' · '));

  const labels = (Array.isArray(entry.labels) ? entry.labels : []).map(labelName).filter(Boolean);
  lines.push(labels.length > 0 ? `labels: ${labels.join(', ')}` : paint('muted', '(no labels)'));
  const assignees = (Array.isArray(entry.assignees) ? entry.assignees : []).map(assigneeName).filter(Boolean);
  if (assignees.length > 0) lines.push(`assignees: ${assignees.join(', ')}`);

  // S16: while a richer read is in flight the row's own facts are already on
  // screen and the read is NAMED — an empty-looking pane must not read as
  // "this issue has no body". The counters and the body are not invented from
  // a row that never carried them.
  if (settings.pending === true) {
    const pending = [];
    for (const line of lines) pending.push(...wrap(line));
    pending.push(paint('muted', 'loading…'));
    return pending;
  }

  lines.push(
    `by ${entry.author || 'unknown'} · created ${relativeTime(entry.createdAt, nowMs)} · updated ${relativeTime(entry.updatedAt, nowMs)}`,
  );
  const plusOne = entry.reactions && Number.isFinite(Number(entry.reactions.plusOne))
    ? Number(entry.reactions.plusOne)
    : 0;
  const stored = Number.isFinite(Number(entry.commentsCount)) ? Number(entry.commentsCount) : 0;
  lines.push(`👍 ${plusOne} · ${Math.max(stored, list.length)} comments`);
  // S9/S6: only data the issue actually has. An empty relation is omitted, not
  // rendered as "none", and an unreadable relation is one short status instead
  // of the scopes or reasons behind it.
  const projects = (Array.isArray(entry.projects) ? entry.projects : [])
    .map((project) => (project && project.title ? String(project.title) : ''))
    .filter(Boolean);
  if (projects.length > 0) lines.push(`projects: ${projects.join(', ')}`);
  const linkedPrs = Number(entry.linkedPullRequestCount);
  if (Number.isFinite(linkedPrs) && linkedPrs > 0) lines.push(`linked PRs: ${linkedPrs}`);
  if (entry.metadataError) lines.push(paint('muted', 'metadata unavailable'));

  const out = [];
  lines.push('');
  for (const line of lines) out.push(...wrap(line));
  out.push(...wrap(entry.body || '(no description)'));
  list.forEach((comment, at) => {
    out.push('');
    out.push(paint('border', `─ ${commentAuthor(comment)} · ${relativeTime(comment.createdAt, nowMs)} ─`));
    const body = typeof comment.body === 'string' ? comment.body : '';
    out.push(...wrap(body));
    if (at === list.length - 1) out.push(paint('dim', '(end of issue)'));
  });
  if (list.length === 0) {
    out.push('');
    out.push(paint('dim', '(end of issue)'));
  }
  return out;
}

module.exports = { issueDetailLines, relativeTime, wrapText, createWrapCache, defaultWrapCache };

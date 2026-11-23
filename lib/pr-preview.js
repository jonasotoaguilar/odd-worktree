'use strict';
// ONE pull request preview, cloned from `lib/issue-preview.js` (prs-panel T2).
// Same shape, same field ORDER, same omission of absent metadata, same pending
// rendering — applied to a pull request: the identity block, the reviewers with
// their own state marks, the linked issues, and the two summary blocks S3 asks
// for, `Changes` and `Checks`, before the body and the comments.
//
// Purity: plain data in, styled strings out. The caller injects `paint`,
// `emphasis`, its own `wrap` and, for deterministic tests, the clock. No
// filesystem, network or registry access happens here.
//
// S6: `options.links` is the ONE published click surface. While the
// `linked issues:` row is composed, every `#N` token records its own cell range
// (`{line, start, end, number}`) instead of leaving the view to find the number
// again in the painted text — a number that wraps, a truncated list and a
// narrow pane all keep an exact target, and the whole line is never one range.
//
// `options.hover` names the linked issue the pointer is over: that one `#N`
// token is painted in the hover role the rail gives a hovered row, and no range
// moves — the caller passes what the SAME hit test as the click answered, so the
// two can never disagree.
//
// The pane's blocks are separated by the full-width rule the ODD reader already
// draws (`lib/odd-markdown.js` paints `'─'.repeat(width)`, here in the muted
// role): the metadata block (the `Changes` and `Checks` summaries included) from
// the body, the body from the comments and each comment from the next. No rule
// precedes the first row, none follows the last, and a block the pull request
// does not have adds none.
//
// The small pure helpers below (`relativeTime`, `wrapText`, the wrap memo) are
// deliberate copies of the issues preview's, not imports: the two panels are
// owned by parallel units, so neither may gain a load-time dependency on the
// other's module shape. Their wording is the package's one clock style, so a
// reader of both panes never sees two ways to say the same age.

const { ROLES: PALETTE_ROLES } = require('./tui-paint.js');

// The one role a title is painted with, read from the shared table so this
// preview cannot drift into its own title colour.
const TITLE_ROLE = PALETTE_ROLES.title;
// The role a hovered click target takes: the rail's own choice for a hovered row
// (`lib/files-scope-view.js` paints it with the palette `key`).
const HOVER_ROLE = PALETTE_ROLES.key;

// The horizontal rule the ODD reader draws between its blocks, as wide as the
// pane and in the muted role. One helper, so every boundary of both reading
// panes draws the same characters.
function ruleRow(width, paint) {
  return paint('muted', '─'.repeat(Math.max(1, Math.floor(Number(width) || 1))));
}

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

function reviewerName(reviewer) {
  return assigneeName(reviewer);
}

// The review state GitHub reports, said in the reader's words. An unknown state
// adds no mark at all instead of printing the raw enum.
const REVIEW_MARKS = {
  REQUESTED: 'review requested',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

function reviewMark(state) {
  const key = String(state || '').toUpperCase();
  return REVIEW_MARKS[key] || '';
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function plural(count, single, many) {
  return `${count} ${count === 1 ? single : many}`;
}

// The package's one clock style (issues view, warp facts): just now, minutes,
// hours, days, months, years, always with the `ago` suffix.
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

function plainWidth(text) {
  return [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].length;
}

const WRAP_CACHE_ENTRIES = 400;
const WRAP_CACHE_ROWS = 20000;

/**
 * A bounded memo of finished wraps, keyed by width + the exact text, so an
 * unchanged repaint wraps nothing while a changed body or pane always misses.
 * `stats` makes "a repaint re-wraps nothing" observable.
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

const defaultWrapCache = createWrapCache();

function identity(_role, text) {
  return String(text);
}

function bold(text) {
  return String(text);
}

// The `linked issues:` row, composed token by token so every number keeps its
// own cell range even when the pane forces the row onto several lines.
// `hoverPaint(text, number)` paints the hovered token and leaves every other one
// exactly as it was, so the ranges below stay the columns of the same cells.
function linkedIssuesBlock(numbers, truncated, width, measure, hoverPaint) {
  const lines = [];
  const ranges = [];
  let text = '';
  let length = 0;
  const push = (piece) => (text += piece);
  const setLength = () => { length = measure(text); };
  const append = (piece, link) => {
    const current = text === '' ? 0 : length;
    if (current > 0 && measure(piece) > width - current) {
      lines.push(text.replace(/^\s+/g, ''));
      text = '';
      length = 0;
      piece = piece.replace(/^\s+/, '');
    }
    const before = text === '' ? 0 : length;
    // The separator between two numbers belongs to the row, not to the click
    // target: the range starts at the `#` itself.
    const lead = measure(piece) - measure(piece.replace(/^\s+/, ''));
    push(typeof hoverPaint === 'function' ? hoverPaint(piece, link) : piece);
    setLength();
    if (link !== undefined) ranges.push({ line: lines.length, start: before + lead, end: length, number: link });
  };
  append('linked issues:');
  numbers.forEach((number, at) => {
    // The separator is its own piece, so the range below starts at the `#`
    // itself and never covers the comma or the space before it.
    append(at === 0 ? ' ' : ', ');
    append(`#${number}`, number);
  });
  if (truncated) append(', …');
  lines.push(text.replace(/^\s+/g, ''));
  return { lines, ranges };
}

/**
 * The preview pane for ONE pull request: identity and state, labels, assignees
 * and reviewers with their state marks, author and ages, the reaction/comment
 * counters, the linked issues, the `Changes` and `Checks` summaries, then the
 * body and every comment (S3).
 *
 * @returns {string[]} styled lines, already wrapped to `options.width`
 */
function pullRequestDetailLines(pullRequest, comments, options = {}) {
  const entry = pullRequest && typeof pullRequest === 'object' ? pullRequest : {};
  const settings = options && typeof options === 'object' ? options : {};
  const width = Math.max(1, Math.floor(Number(settings.width) || 1));
  const paint = typeof settings.paint === 'function' ? settings.paint : identity;
  const emphasize = typeof settings.emphasis === 'function' ? settings.emphasis : bold;
  const cache = settings.cache && typeof settings.cache.wrap === 'function' ? settings.cache : defaultWrapCache;
  const wrap = typeof settings.wrap === 'function' ? settings.wrap : (text) => cache.wrap(text, width);
  const measure = typeof settings.measure === 'function' ? settings.measure : plainWidth;
  const links = Array.isArray(settings.links) ? settings.links : null;
  // The pointer's target: the linked issue number it is over, if any.
  const hover = Number.isInteger(settings.hover) && settings.hover > 0 ? settings.hover : null;
  const hoverPaint = hover === null
    ? null
    : (text, number) => (number === hover ? emphasize(paint(HOVER_ROLE, text)) : text);
  const list = Array.isArray(comments) ? comments : [];
  const nowMs = Number.isFinite(settings.now) ? settings.now : Date.now();

  const out = [];
  const flush = (text) => {
    for (const row of wrap(String(text))) out.push(row);
  };

  // S13: the title asks for the shared title role, and keeps its emphasis.
  out.push(emphasize(paint(TITLE_ROLE, `#${entry.number} ${entry.title || '(no title)'}`)));
  // S3: the state row says `[draft]` for a draft, never a bare `[open]`.
  const state = entry.isDraft === true ? 'draft' : String(entry.state || 'open').toLowerCase();
  out.push(paint(state === 'open' ? 'accent' : 'muted', `[${state}]`));

  const labels = (Array.isArray(entry.labels) ? entry.labels : []).map(labelName).filter(Boolean);
  flush(labels.length > 0 ? `labels: ${labels.join(', ')}` : paint('muted', '(no labels)'));
  const assignees = (Array.isArray(entry.assignees) ? entry.assignees : []).map(assigneeName).filter(Boolean);
  if (assignees.length > 0) flush(`assignees: ${assignees.join(', ')}`);
  const reviewers = (Array.isArray(entry.reviewers) ? entry.reviewers : [])
    .map((reviewer) => {
      const login = reviewerName(reviewer);
      if (login === '') return '';
      const mark = reviewMark(reviewer && reviewer.state);
      return mark === '' ? login : `${login} (${mark})`;
    })
    .filter(Boolean);
  if (reviewers.length > 0) flush(`reviewers: ${reviewers.join(', ')}`);

  // S16 of the issues pane, kept here: while the richer read is in flight the
  // row's own facts are already painted and the read is NAMED — the body, the
  // counters and the summaries are not invented from a row that never carried
  // them, and a pending row publishes no click range.
  if (settings.pending === true) {
    if (typeof entry.author === 'string' && entry.author.length > 0) flush(`by ${entry.author}`);
    out.push(paint('muted', 'loading…'));
    return out;
  }

  flush(`by ${entry.author || 'unknown'} · created ${relativeTime(entry.createdAt, nowMs)} · updated ${relativeTime(entry.updatedAt, nowMs)}`);
  const plusOne = entry.reactions && Number.isFinite(Number(entry.reactions.plusOne))
    ? Number(entry.reactions.plusOne)
    : 0;
  const stored = Number.isFinite(Number(entry.commentsCount)) ? Number(entry.commentsCount) : 0;
  flush(`👍 ${plusOne} · ${Math.max(stored, list.length)} comments`);

  // S6: every linked issue is named by number, ascending, never counted; a
  // capped page stays honest with a trailing ellipsis.
  const linked = (Array.isArray(entry.linkedIssues) ? entry.linkedIssues : [])
    .filter((number) => Number.isInteger(number) && number > 0);
  if (linked.length > 0) {
    const block = linkedIssuesBlock(linked, entry.linkedIssuesTruncated === true, width, measure, hoverPaint);
    const base = out.length;
    for (const line of block.lines) out.push(line);
    if (links !== null) {
      for (const range of block.ranges) {
        links.push({ line: base + range.line, start: range.start, end: range.end, number: range.number });
      }
    }
  }

  // S3: the two summary blocks, in the contract's order and only when the read
  // carried the numbers they summarise.
  const files = numberOrNull(entry.changedFiles);
  const additions = numberOrNull(entry.additions);
  const deletions = numberOrNull(entry.deletions);
  const commits = numberOrNull(entry.commits);
  if (files !== null || additions !== null || deletions !== null || commits !== null) {
    out.push(emphasize('Changes'));
    if (files !== null) {
      const plus = additions === null ? '' : ` +${additions}`;
      const minus = deletions === null ? '' : ` -${deletions}`;
      flush(`${plural(files, 'file', 'files')} changed${plus}${minus}`);
    }
    if (commits !== null) {
      const age = Number.isFinite(Date.parse(entry.committedAt)) ? ` ${relativeTime(entry.committedAt, nowMs)}` : '';
      flush(`${plural(commits, 'commit', 'commits')}${age}`);
    }
  }

  const checks = entry.checks && typeof entry.checks === 'object' ? entry.checks : null;
  if (checks !== null) {
    const total = numberOrNull(checks.total);
    const failed = numberOrNull(checks.failed) || 0;
    const pending = numberOrNull(checks.pending) || 0;
    const stateWord = String(checks.state || '').toUpperCase();
    out.push(emphasize('Checks'));
    if (total === null) {
      flush(failed > 0 ? `${plural(failed, 'check', 'checks')} failed` : 'checks unknown');
    } else if (total === 0) {
      flush('no checks');
    } else {
      let word;
      if (failed > 0) word = `${failed} failed`;
      else if (stateWord === 'SUCCESS') word = 'all passed';
      else if (stateWord === 'PENDING' || pending > 0) word = 'pending';
      else if (stateWord === 'NONE') word = 'no checks';
      else word = stateWord === '' ? 'unknown' : stateWord.toLowerCase();
      flush(`${plural(total, 'check', 'checks')} · ${word}`);
    }
    const failing = (Array.isArray(checks.failing) ? checks.failing : []).filter((name) => typeof name === 'string' && name !== '');
    if (failing.length > 0) flush(`failing: ${failing.join(', ')}`);
  }

  // A relation that could not be read paints NOTHING: the pane stays quiet,
  // exactly as it does for a relation the pull request does not have.
  // The metadata block ends here, and the body follows behind ONE full-width
  // rule; the comments and every comment-to-comment boundary get the same one.
  out.push(ruleRow(width, paint));
  for (const row of wrap(entry.body || '(no description)')) out.push(row);
  list.forEach((comment, at) => {
    out.push(ruleRow(width, paint));
    out.push(paint('border', `─ ${commentAuthor(comment)} · ${relativeTime(comment.createdAt, nowMs)} ─`));
    const body = typeof comment.body === 'string' ? comment.body : '';
    for (const row of wrap(body)) out.push(row);
    if (at === list.length - 1) out.push(paint('dim', '(end of pull request)'));
  });
  if (list.length === 0) {
    out.push('');
    out.push(paint('dim', '(end of pull request)'));
  }
  return out;
}

module.exports = { pullRequestDetailLines, relativeTime, wrapText, createWrapCache, defaultWrapCache };

'use strict';
// T2 (prs-panel S3,S6): the pull request preview formatter, lib/pr-preview.js.
// It is the issues preview's row/pane design applied to a pull request: the
// same identity block, the same omission of absent metadata, the same pending
// rendering, plus the two blocks S3 asks for — `Changes` and `Checks` — and the
// `linked issues:` row whose every number S6 makes its own click target. These
// tests pin the ORDER, the exact wording, the omitted empties and the click
// ranges the pane publishes, so the view that consumes them cannot drift.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { pullRequestDetailLines } = require('../lib/pr-preview.js');

const plain = (_role, text) => String(text);
const bold = (text) => String(text);
const NOW = Date.parse('2026-03-01T00:00:00.000Z');

function render(pullRequest, comments, options = {}) {
  return pullRequestDetailLines(pullRequest, comments, {
    width: 80,
    paint: plain,
    emphasis: bold,
    now: NOW,
    ...options,
  }).join('\n');
}

const FULL = {
  number: 87,
  title: 'parity title',
  state: 'open',
  isDraft: false,
  author: 'octo',
  labels: [{ name: 'bug' }, 'docs'],
  assignees: [{ login: 'ana' }, 'beto'],
  createdAt: '2026-02-25T00:00:00.000Z',
  updatedAt: '2026-02-26T00:00:00.000Z',
  commentsCount: 2,
  reactions: { plusOne: 3 },
  reviewers: [
    { login: 'cara', state: 'APPROVED' },
    { login: 'dan', state: 'CHANGES_REQUESTED' },
    { login: 'eve', state: 'REQUESTED' },
    { login: 'fay', state: 'COMMENTED' },
  ],
  linkedIssues: [12, 14],
  additions: 40,
  deletions: 5,
  changedFiles: 3,
  commits: 7,
  committedAt: '2026-02-27T00:00:00.000Z',
  checks: { total: 5, passed: 4, failed: 1, pending: 0, state: 'FAILURE', failing: ['build'] },
  body: 'the body',
};

function linesOf(pullRequest, comments = [], options = {}) {
  return pullRequestDetailLines(pullRequest, comments, {
    width: 80,
    paint: plain,
    emphasis: bold,
    now: NOW,
    ...options,
  });
}

describe('pull request preview formatter (S3)', () => {
  test('renders the summary fields in the contract order', () => {
    const lines = linesOf(FULL, [
      { author: 'ana', body: 'first comment', createdAt: '2026-02-28T00:00:00.000Z' },
      { author: 'beto', body: 'second comment', createdAt: '2026-02-28T12:00:00.000Z' },
    ]);
    const at = (needle) => {
      const index = lines.findIndex((line) => line.includes(needle));
      assert.notEqual(index, -1, `not painted: ${needle}`);
      return index;
    };
    assert.equal(lines[0], '#87 parity title');
    assert.match(lines[1], /\[open\]/);
    assert.match(lines.join('\n'), /labels: bug, docs/);
    assert.match(lines.join('\n'), /assignees: ana, beto/);
    assert.match(
      lines.join('\n').replace(/\s+/g, ' '),
      /reviewers: cara \(approved\), dan \(changes requested\), eve \(review requested\), fay \(commented\)/,
      'every reviewer carries its own state mark',
    );
    assert.match(lines.join('\n'), /by octo · created 4d ago · updated 3d ago/);
    assert.match(lines.join('\n'), /👍 3 · 2 comments/);
    assert.match(lines.join('\n'), /linked issues: #12, #14/);
    assert.match(lines.join('\n'), /3 files changed \+40 -5/);
    assert.match(lines.join('\n'), /7 commits 2d ago/);
    assert.match(lines.join('\n'), /5 checks · 1 failed/);
    assert.match(lines.join('\n'), /failing: build/);
    assert.match(lines.join('\n'), /the body/);
    assert.match(lines.join('\n'), /─ ana · 1d ago ─/);
    assert.match(lines.join('\n'), /first comment/);
    assert.match(lines.join('\n'), /second comment/);
    assert.equal((lines.join('\n').match(/\(end of pull request\)/g) || []).length, 1);

    // S3's order: identity, relations, then the two summary blocks, then the
    // body the reader came for.
    assert.ok(at('[open]') < at('labels:'), 'labels follow the state row');
    assert.ok(at('assignees:') < at('reviewers:'), 'reviewers follow assignees');
    assert.ok(at('reviewers:') < at('by octo'), 'the author row follows the reviewers');
    assert.ok(at('by octo') < at('linked issues:'), 'linked issues follow the author row');
    assert.ok(at('linked issues:') < at('Changes'), 'the Changes block follows the relations');
    assert.ok(at('Changes') < at('Checks'), 'the Checks block follows Changes');
    assert.ok(at('Checks') < at('the body'), 'the body closes the pane');
  });

  test('a draft is marked as a draft, never as an open pull request', () => {
    assert.match(render({ ...FULL, isDraft: true }), /\[draft\]/);
    assert.doesNotMatch(linesOf({ ...FULL, isDraft: true }).join('\n'), /\[open\]/);
    assert.match(linesOf({ ...FULL, state: 'closed' }).join('\n'), /\[closed\]/);
  });

  test('a reviewer without a known state is named without an invented mark', () => {
    const text = render({ ...FULL, reviewers: [{ login: 'gus' }, { login: 'hal', state: 'DISMISSED' }] });
    assert.match(text, /reviewers: gus, hal \(dismissed\)/);
  });

  test('omits empty optional metadata instead of printing a zero or "none"', () => {
    const text = render(
      {
        ...FULL,
        labels: [],
        assignees: [],
        reviewers: [],
        linkedIssues: [],
        commentsCount: 0,
        reactions: { plusOne: 0 },
      },
      [],
    );
    assert.doesNotMatch(text, /assignees:/);
    assert.doesNotMatch(text, /reviewers:/);
    assert.doesNotMatch(text, /linked issues:/);
    assert.match(text, /\(no labels\)/, 'the empty label row stays explicit, as in issues');
    assert.match(text, /👍 0 · 0 comments/);
    assert.match(text, /\(end of pull request\)/);
  });

  test('the Changes and Checks blocks are omitted when the read carried nothing', () => {
    const bare = {
      number: 5,
      title: 'bare',
      additions: undefined,
      deletions: undefined,
      changedFiles: undefined,
      commits: undefined,
      committedAt: undefined,
      checks: undefined,
    };
    const text = render(bare, []);
    assert.doesNotMatch(text, /Changes/);
    assert.doesNotMatch(text, /files changed/);
    assert.doesNotMatch(text, /Checks/);
    assert.doesNotMatch(text, /checks/);
  });

  test('a green and a running checks read each say what they are', () => {
    const green = render(
      { ...FULL, checks: { total: 5, passed: 5, failed: 0, pending: 0, state: 'SUCCESS', failing: [] } },
      [],
    );
    assert.match(green, /5 checks · all passed/);
    assert.doesNotMatch(green, /failing:/);
    const running = render(
      { ...FULL, checks: { total: 3, passed: 1, failed: 0, pending: 2, state: 'PENDING', failing: [] } },
      [],
    );
    assert.match(running, /3 checks · pending/);
    const none = render({ ...FULL, checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'NONE', failing: [] } }, []);
    assert.match(none, /no checks/);
    const several = render(
      { ...FULL, checks: { total: 6, passed: 3, failed: 3, pending: 0, state: 'FAILURE', failing: ['build', 'lint'] } },
      [],
    );
    assert.match(several, /6 checks · 3 failed/);
    assert.match(several, /failing: build, lint/, 'every failing check is named');
  });

  test('a single commit and a single check are not pluralised', () => {
    const text = render(
      { ...FULL, commits: 1, checks: { total: 1, passed: 1, failed: 0, pending: 0, state: 'SUCCESS', failing: [] } },
      [],
    );
    assert.match(text, /1 commit 2d ago/);
    assert.match(text, /1 check · all passed/);
  });

  test('a pending read paints the known fields and names the read', () => {
    const text = render(
      {
        number: 12,
        title: 'pull request title 12',
        author: 'octo',
        labels: [{ name: 'bug' }],
        assignees: [{ login: 'ana' }],
        reviewers: [{ login: 'cara', state: 'APPROVED' }],
      },
      [],
      { pending: true },
    );
    assert.match(text, /#12 pull request title 12/);
    assert.match(text, /labels: bug/);
    assert.match(text, /assignees: ana/);
    assert.match(text, /reviewers: cara \(approved\)/);
    assert.match(text, /by octo/);
    assert.match(text, /loading…/);
    assert.doesNotMatch(text, /the body|no description|\(end of pull request\)|Checks|Changes/);
  });

  test('a capped linked-issue page is marked instead of passing for the whole list', () => {
    assert.doesNotMatch(render({ ...FULL, linkedIssues: [] }, []), /linked issues:/);
    assert.match(
      render({ ...FULL, linkedIssues: [12], linkedIssuesTruncated: true }, []),
      /linked issues: #12, …/,
    );
  });

  test('ages come from the injected clock, so no assertion depends on the host time', () => {
    const text = render({ ...FULL, createdAt: '2026-02-28T23:59:30.000Z', updatedAt: '2026-02-28T23:00:00.000Z' });
    assert.match(text, /created just now · updated 1h ago/);
  });

  test('an unreadable relation paints no note about it', () => {
    const text = render({ ...FULL, unavailable: ['checks'], metadataError: 'boom' }, []);
    assert.doesNotMatch(text, /metadata|boom|unavailable/i);
    assert.match(text, /linked issues: #12, #14/, 'the relations that did resolve still render');
  });
});

// S6: every linked issue number is its own click target. The formatter
// publishes the cell ranges instead of leaving the view to guess them by
// searching the painted text, so a number that wraps, a truncated list and a
// narrow pane all keep exact targets.
describe('linked issue click ranges (S6)', () => {
  test('each number publishes its own range on the painted line', () => {
    const links = [];
    const lines = linesOf(FULL, [], { links });
    assert.equal(links.length, 2, 'one range per linked issue, never one per line');
    assert.deepEqual(links.map((link) => link.number), [12, 14]);
    for (const link of links) {
      const line = lines[link.line];
      assert.ok(line !== undefined, `range points at a painted line: ${JSON.stringify(link)}`);
      assert.equal(line.slice(link.start, link.end), `#${link.number}`,
        'the range covers exactly the number and nothing else');
    }
    const [first, second] = links;
    assert.ok(first.end <= second.start || first.line < second.line, 'the ranges never overlap');
  });

  test('a narrow pane still gives every number its own exact range', () => {
    const links = [];
    const lines = linesOf(FULL, [], { width: 14, links });
    assert.equal(links.length, 2);
    for (const link of links) {
      const line = lines[link.line];
      assert.ok(line !== undefined);
      assert.equal(line.slice(link.start, link.end), `#${link.number}`);
      assert.ok([...line].length <= 14, `"${line}" fits the pane`);
    }
    assert.ok(lines.some((line) => line.includes('linked issues:')), 'the row survives the wrap');
  });

  test('a truncated list publishes no range for the ellipsis', () => {
    const links = [];
    linesOf({ ...FULL, linkedIssues: [12], linkedIssuesTruncated: true }, [], { links });
    assert.deepEqual(links.map((link) => link.number), [12]);
  });

  test('a pending read and a missing relation publish no range at all', () => {
    const pendingLinks = [];
    linesOf({ number: 9, title: 'x', linkedIssues: [12, 14] }, [], { pending: true, links: pendingLinks });
    assert.deepEqual(pendingLinks, [], 'a pending row carries no linked issues to click');
    const emptyLinks = [];
    linesOf({ ...FULL, linkedIssues: [] }, [], { links: emptyLinks });
    assert.deepEqual(emptyLinks, []);
  });
});

'use strict';
// T2 (issues-panel S1,S3): the migrated issue preview formatter,
// lib/issue-preview.js. In the source package (S16) one formatter served the
// worktree detail/edit pane and the Issues viewer; it is migrated whole, so its
// field set cannot shrink in the move. These tests pin the formatter's own
// contract (field order, omitted empties, pending read, injected clock) so the
// `/issues` wiring that lands later renders exactly what the source did.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { issueDetailLines, relativeTime, wrapText } = require('../lib/issue-preview.js');

const plain = (_role, text) => String(text);
const bold = (text) => String(text);
const NOW = Date.parse('2026-03-01T00:00:00.000Z');

function render(detail, comments, options = {}) {
  return issueDetailLines(detail, comments, {
    width: 80,
    paint: plain,
    emphasis: bold,
    now: NOW,
    ...options,
  }).join('\n');
}

const FULL = {
  number: 77,
  title: 'parity title',
  state: 'open',
  author: 'octo',
  labels: [{ name: 'bug' }, 'docs'],
  assignees: [{ login: 'ana' }, 'beto'],
  createdAt: '2026-02-25T00:00:00.000Z',
  updatedAt: '2026-02-26T00:00:00.000Z',
  commentsCount: 2,
  reactions: { plusOne: 3 },
  projects: [{ title: 'Roadmap' }],
  linkedPullRequestCount: 2,
  body: 'the body',
};

describe('issue preview formatter (S16)', () => {
  test('renders every present field and every comment', () => {
    const text = render(FULL, [
      { author: 'ana', body: 'first comment', createdAt: '2026-02-27T00:00:00.000Z' },
      { author: 'beto', body: 'second comment', createdAt: '2026-02-28T00:00:00.000Z' },
    ]);
    assert.match(text, /^#77 parity title/);
    assert.match(text, /\[open\]/);
    assert.match(text, /labels: bug, docs/);
    assert.match(text, /assignees: ana, beto/);
    assert.match(text, /by octo · created 4d ago · updated 3d ago/);
    assert.match(text, /👍 3 · 2 comments/);
    assert.match(text, /projects: Roadmap/);
    assert.match(text, /linked PRs: 2/);
    assert.match(text, /the body/);
    assert.match(text, /─ ana · 2d ago ─/);
    assert.match(text, /first comment/);
    assert.match(text, /second comment/);
    assert.equal((text.match(/\(end of issue\)/g) || []).length, 1, 'the end marker closes the last comment');
  });

  test('omits empty optional metadata instead of printing a zero or "none"', () => {
    const text = render(
      { ...FULL, assignees: [], projects: [], linkedPullRequestCount: 0, commentsCount: 0, reactions: { plusOne: 0 } },
      [],
    );
    assert.doesNotMatch(text, /assignees:/);
    assert.doesNotMatch(text, /projects:/);
    assert.doesNotMatch(text, /linked PRs:/);
    assert.match(text, /👍 0 · 0 comments/, 'the reaction/comment counter is one honest line');
    assert.match(text, /\(end of issue\)/, 'an uncommented issue still ends');
  });

  test('a pending read paints the known fields and names the read', () => {
    const text = render({ number: 12, title: 'issue title 12', labels: [{ name: 'bug' }] }, [], { pending: true });
    assert.match(text, /#12 issue title 12/);
    assert.match(text, /labels: bug/);
    assert.match(text, /loading…/);
    assert.doesNotMatch(text, /the body|no description|\(end of issue\)/);
  });

  test('the caller note rides the state row and never replaces a fact', () => {
    const text = render(FULL, [], { note: 'assigned to this worktree' });
    assert.match(text, /\[open\] · assigned to this worktree/);
    assert.match(text, /labels: bug, docs/);
  });

  test('ages come from the injected clock, so no assertion depends on the host time', () => {
    assert.equal(relativeTime('2026-02-28T23:59:30.000Z', NOW), 'just now');
    assert.equal(relativeTime('2026-02-28T23:00:00.000Z', NOW), '1h ago');
    assert.equal(relativeTime('2026-02-01T00:00:00.000Z', NOW), '28d ago');
    assert.equal(relativeTime('2025-01-01T00:00:00.000Z', NOW), '1y ago');
    assert.equal(relativeTime('not a date', NOW), 'unknown time');
  });

  test('a narrow pane wraps every field instead of dropping it', () => {
    const lines = issueDetailLines({ ...FULL, body: 'alpha beta gamma delta' }, [], {
      width: 12,
      paint: plain,
      emphasis: bold,
      now: NOW,
    });
    // The two chrome markers (the comment rule and `(end of issue)`) are single
    // tokens the caller's own padding clips; every content line is wrapped.
    const chrome = (line) => /^─ /.test(line) || line === '(end of issue)';
    for (const line of lines.filter((entry) => !chrome(entry))) {
      assert.ok([...line].length <= 12, `"${line}" fits 12 cells`);
    }
    assert.match(lines.join('\n'), /assignees:/);
    assert.match(lines.join('\n'), /ana, beto/);
    assert.match(lines.join('\n'), /delta/);
    assert.equal(wrapText('', 20).length, 1, 'an empty body is one blank row, not zero rows');
  });

  test('a comment without an author still names itself honestly', () => {
    const text = render({ number: 5, title: 't' }, [{ body: 'orphan' }]);
    assert.match(text, /─ unknown · unknown time ─/);
    assert.match(text, /orphan/);
  });

  test('a long comment retains its complete body beyond 2000 characters', () => {
    const body = `${'complete comment '.repeat(180)}TAIL_AFTER_2000`;
    const text = render({ number: 5, title: 't' }, [{ body }]);
    assert.ok(text.includes('TAIL_AFTER_2000'), 'sharing the formatter must not truncate a comment');
    const flattened = text.replace(/\s+/g, ' ');
    assert.ok(flattened.includes(body), 'every word survives, not just the final marker');
  });

  test('wrapping a token wider than the preview preserves all its characters', () => {
    const token = 'https://example.test/' + 'x'.repeat(180);
    const lines = wrapText(token, 12);
    assert.equal(lines.join(''), token, 'long tokens wrap rather than losing their suffix');
    assert.ok(lines.every((line) => line.length <= 12));
  });
});

// T9 (S13): the preview's OWN TITLE is a title, not a control. It asks the
// injected paint seam for the SAME role the shared table gives every other
// title — `customMessageLabel`, the role the Pi Agents view paints its own frame
// title with (`gentle-pi/lib/agents-view.ts:42`, painted at line 437) — so the Issues reading
// pane, the two readers' frames and the plugin's panels cannot drift into two
// title colours. Every non-title role stays exactly where it was.
describe('the preview title follows the shared palette (S13)', () => {
  // A paint seam that RECORDS which role each string was painted with, so the
  // assertion is about the ROLE behind the title instead of a colour.
  function spyPaint() {
    const calls = [];
    const paint = (role, text) => {
      calls.push({ role, text: String(text) });
      return String(text);
    };
    return { calls, paint };
  }

  function renderSpy(detail, comments, options = {}) {
    const spy = spyPaint();
    const emphasised = [];
    const lines = issueDetailLines(detail, comments, {
      width: 80,
      now: NOW,
      paint: spy.paint,
      emphasis: (text) => {
        emphasised.push(String(text));
        return String(text);
      },
      ...options,
    });
    return { ...spy, emphasised, lines };
  }

  test('the title asks for the Agents view title role, never the button accent', () => {
    const { calls } = renderSpy(FULL, []);
    const titleCall = calls.find((call) => call.text === '#77 parity title');
    assert.ok(titleCall, 'the title is painted through the caller seam');
    assert.equal(titleCall.role, 'customMessageLabel',
      'the title uses the role the Pi Agents view paints its own title with');
    assert.notEqual(titleCall.role, 'accent',
      'the title is never painted with the button role');
    assert.notEqual(titleCall.role, 'mdHeading',
      'a markdown heading role is not a UI title role');
  });

  test('the title keeps its emphasis and every metadata role is unchanged', () => {
    const { calls, emphasised, lines } = renderSpy(FULL, [{ author: 'ana', body: 'first comment', createdAt: '2026-02-27T00:00:00.000Z' }]);
    assert.ok(emphasised.includes('#77 parity title'), 'the title is still emphasised through the theme');
    const roleOf = (needle) => {
      const call = calls.find((entry) => entry.text.includes(needle));
      assert.ok(call, `no painted call carries ${JSON.stringify(needle)}`);
      return call.role;
    };
    assert.equal(roleOf('[open]'), 'accent', 'the open state keeps its own role');
    assert.equal(roleOf('(end of issue)'), 'dim', 'the end marker stays dim');
    assert.equal(roleOf('─ ana · 2d ago ─'), 'border', 'the comment rule stays the border role');
    assert.equal(roleOf('#77 parity title'), 'customMessageLabel', 'the title is a title');
    // The remaining fields are the formatter's plain text: no role is invented
    // for labels, assignees, counters or the body.
    const bodyLine = lines.find((line) => line.includes('the body'));
    assert.ok(bodyLine !== undefined, 'the body still renders');
    assert.ok(!calls.some((call) => call.text.includes('the body')), 'the body is painted by the caller, not roled here');
    assert.ok(!calls.some((call) => call.text.startsWith('labels:')), 'labels stay plain text');
    assert.ok(!calls.some((call) => call.text.startsWith('👍')), 'the counter stays plain text');
  });

  test('a closed issue and an unreadable-metadata note keep their own roles', () => {
    const { calls } = renderSpy({ ...FULL, state: 'closed', metadataError: 'boom' }, []);
    assert.ok(calls.some((call) => call.role === 'muted' && call.text === '[closed]'),
      'a closed state is muted, not the title role');
    assert.ok(calls.some((call) => call.role === 'muted' && call.text === 'metadata unavailable'),
      'the unreadable-metadata note stays muted');
    assert.ok(calls.some((call) => call.role === 'muted' && call.text === 'loading…') === false,
      'a ready read paints no pending word');
  });
});

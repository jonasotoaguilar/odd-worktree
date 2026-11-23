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
  linkedPullRequests: [69, 77],
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
    assert.match(text, /linked PRs: #69, #77/, 'every linked PR is named by number, never counted');
    assert.match(text, /the body/);
    assert.match(text, /─ ana · 2d ago ─/);
    assert.match(text, /first comment/);
    assert.match(text, /second comment/);
    assert.equal((text.match(/\(end of issue\)/g) || []).length, 1, 'the end marker closes the last comment');
  });

  test('omits empty optional metadata instead of printing a zero or "none"', () => {
    const text = render(
      { ...FULL, assignees: [], projects: [], linkedPullRequests: [], commentsCount: 0, reactions: { plusOne: 0 } },
      [],
    );
    assert.doesNotMatch(text, /assignees:/);
    assert.doesNotMatch(text, /projects:/);
    assert.doesNotMatch(text, /linked PRs:/);
    assert.match(text, /👍 0 · 0 comments/, 'the reaction/comment counter is one honest line');
    assert.match(text, /\(end of issue\)/, 'an uncommented issue still ends');
  });

  test('a pending read paints the known fields and names the read', () => {
    const text = render(
      {
        number: 12,
        title: 'issue title 12',
        author: 'octo',
        labels: [{ name: 'bug' }],
        assignees: [{ login: 'ana' }],
      },
      [],
      { pending: true },
    );
    assert.match(text, /#12 issue title 12/);
    assert.match(text, /labels: bug/);
    assert.match(text, /assignees: ana/);
    // S9 (T10): the row the rail caches already names its author, so the first
    // frame of a numbered open carries it instead of withholding it until the
    // detail read lands.
    assert.match(text, /by octo/);
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

  test('a metadata read that lost a relation paints no note about it, and the rest still renders', () => {
    const text = render({ ...FULL, projects: [], unavailable: ['projects'] }, []);
    assert.doesNotMatch(text, /metadata/i, 'the pane never announces a lost relation');
    assert.doesNotMatch(text, /read:project|scope/i, 'the scope behind the failure never leaks');
    assert.doesNotMatch(text, /projects:/, 'a relation that could not be read adds no row');
    assert.match(text, /linked PRs: #69, #77/, 'the relations that did resolve still render');
  });

  test('a whole failed metadata read paints no note either', () => {
    const text = render({ ...FULL, metadataError: 'boom', unavailable: ['linked PRs', 'projects'] }, []);
    assert.doesNotMatch(text, /metadata|boom/i);
    assert.match(text, /assignees: ana, beto/, 'the facts the row already had still render');
  });

  test('an absent list and a truncated list stay honest', () => {
    assert.doesNotMatch(render({ ...FULL, linkedPullRequests: [] }, []), /linked PRs:/);
    assert.match(
      render({ ...FULL, linkedPullRequests: [69], linkedPullRequestsTruncated: true }, []),
      /linked PRs: #69, …/,
      'a capped page is marked as truncated instead of passing for the whole list',
    );
  });

  test('a closed issue keeps its own role and an unreadable read paints no note', () => {
    const { calls } = renderSpy({ ...FULL, state: 'closed', metadataError: 'boom' }, []);
    assert.ok(calls.some((call) => call.role === 'muted' && call.text === '[closed]'),
      'a closed state is muted, not the title role');
    assert.ok(!calls.some((call) => /metadata/i.test(call.text)), 'no metadata note is painted in any role');
    assert.ok(calls.some((call) => call.role === 'muted' && call.text === 'loading…') === false,
      'a ready read paints no pending word');
  });
});

// S6 (prs cross-links): the pane's `linked PRs:` row is a set of INDEPENDENT
// click ranges the caller owns. The formatter reports each number it printed
// with the row it landed on (wrapping included) and its own plain columns, so a
// click can never open the whole line, a separator, or the truncation ellipsis.
// The collector is optional: without it the returned rows are byte for byte the
// ones this preview always produced.
describe('linked PR click ranges (S6)', () => {
  function rangesOf(detail, options = {}) {
    const ranges = [];
    const lines = issueDetailLines(detail, [], {
      width: 80,
      paint: plain,
      emphasis: bold,
      now: NOW,
      ranges,
      ...options,
    });
    return { lines, ranges };
  }

  test('each linked PR number is one range, on the row that carries it', () => {
    const { lines, ranges } = rangesOf(FULL);
    assert.deepEqual(ranges.map((range) => range.number), [69, 77], 'every number, in print order');
    assert.ok(ranges.every((range) => range.kind === 'pullRequest'), 'the range names the relation it opens');
    for (const range of ranges) {
      assert.equal(lines[range.line].slice(range.start, range.end), `#${range.number}`,
        `the range covers exactly #${range.number} and nothing else`);
    }
    assert.equal(ranges[0].line, ranges[1].line, 'the wide pane prints both numbers on their one row');
  });

  test('the truncation ellipsis is not a range', () => {
    const { lines, ranges } = rangesOf({
      ...FULL,
      linkedPullRequests: [69],
      linkedPullRequestsTruncated: true,
    });
    assert.deepEqual(ranges.map((range) => range.number), [69], 'only the number is clickable');
    const row = lines[ranges[0].line];
    assert.match(row, /, …$/, 'the capped page still ends with the ellipsis');
    assert.ok(ranges.every((range) => !row.slice(range.start, range.end).includes('…')), 'the ellipsis carries no range');
  });

  test('a wrapped row keeps each range on the row its own number landed on', () => {
    const { lines, ranges } = rangesOf(FULL, { width: 6 });
    assert.equal(ranges.length, 2);
    assert.notEqual(ranges[0].line, ranges[1].line, 'the narrow pane wraps the two numbers onto two rows');
    for (const range of ranges) {
      assert.equal(lines[range.line].slice(range.start, range.end), `#${range.number}`,
        `#${range.number} is range-mapped on the row it was printed on`);
    }
  });

  test('the body, the title and a pending read carry no range', () => {
    const withBody = rangesOf({ ...FULL, title: '#69 title', body: 'linked PRs: #69, #77' });
    assert.deepEqual(withBody.ranges.map((range) => range.number), [69, 77],
      'only the linked row produces ranges, never the title or the body text');
    assert.ok(
      withBody.ranges.every((range) => withBody.lines[range.line].startsWith('linked PRs:')),
      'every range lives on the one relation row',
    );
    const pending = rangesOf(FULL, { pending: true });
    assert.deepEqual(pending.ranges, [], 'a pending read has not painted the relation row yet');
  });

  test('a caller that passes no collector gets exactly the rows it always did', () => {
    const collected = rangesOf(FULL);
    const plainRows = issueDetailLines(FULL, [], { width: 80, paint: plain, emphasis: bold, now: NOW });
    assert.deepEqual(collected.lines, plainRows, 'the collector changes nothing about the painted rows');
  });
});

// S6/D29: a linked pull request is identified by REPOSITORY and number. One of
// another repository is painted with the repository it belongs to — never as a
// bare `#N` that would read as this repository's number — and it owns no click
// range, because this panel cannot open a pull request it has no identity for.
describe('a linked PR of another repository (D29)', () => {
  function rangesOf(detail, options = {}) {
    const ranges = [];
    const lines = issueDetailLines(detail, [], {
      width: 80,
      paint: plain,
      emphasis: bold,
      now: NOW,
      ranges,
      ...options,
    });
    return { lines, ranges };
  }

  test('renders as plain owner/repo#N and owns no click range', () => {
    const { lines, ranges } = rangesOf({
      ...FULL,
      linkedPullRequests: [69],
      linkedPullRequestsForeign: [{ repository: 'oak/payroll', number: 381 }],
    });
    const row = lines.find((line) => line.includes('linked PRs:'));
    assert.ok(row, 'the relation row is painted');
    assert.equal(row.trim(), 'linked PRs: #69, oak/payroll#381',
      'the foreign link names its repository, so it cannot read as this one');
    assert.deepEqual(ranges.map((range) => range.number), [69], 'only the same-repository number is a target');
  });

  test('a foreign link with the same number as a linked one is still not a target', () => {
    const { ranges } = rangesOf({
      ...FULL,
      linkedPullRequests: [69],
      linkedPullRequestsForeign: [{ repository: 'oak/payroll', number: 69 }],
    });
    assert.equal(ranges.length, 1, 'the bare #69 is the only range');
    assert.equal(ranges[0].number, 69);
  });

  test('an absent foreign list paints nothing extra', () => {
    const text = render(FULL, []);
    assert.match(text, /linked PRs: #69, #77/);
  });
});

// The reading pane separates its blocks with the horizontal rule the ODD reader
// already draws (`lib/odd-markdown.js` paints `'─'.repeat(width)`), as wide as
// the pane and in the muted role: the metadata block from the body, the body
// from the comments and each comment from the next. No rule before the first
// row, none after the last, and none for a block the issue does not have.
describe('the pane separates its blocks with a full-width rule', () => {
  const WIDTH = 40;
  const RULE = '─'.repeat(WIDTH);

  function painted(detail, comments, options = {}) {
    const calls = [];
    const paint = (role, text) => {
      calls.push({ role, text: String(text) });
      return String(text);
    };
    const lines = issueDetailLines(detail, comments, {
      width: WIDTH,
      paint,
      emphasis: bold,
      now: NOW,
      ...options,
    });
    return { lines, calls };
  }

  const ruleRows = (lines) => lines.reduce((found, line, at) => (line === RULE ? [...found, at] : found), []);

  test('the metadata block, the body and each comment are separated by one rule', () => {
    const { lines, calls } = painted(FULL, [
      { author: 'ana', body: 'first comment', createdAt: '2026-02-27T00:00:00.000Z' },
      { author: 'beto', body: 'second comment', createdAt: '2026-02-28T00:00:00.000Z' },
    ]);
    const at = (needle) => {
      const index = lines.findIndex((line) => line.includes(needle));
      assert.notEqual(index, -1, `not painted: ${needle}`);
      return index;
    };
    assert.equal(lines[0], '#77 parity title', 'no rule before the first row');
    assert.equal(lines.at(-1), '(end of issue)', 'no rule after the last row');
    assert.equal(lines[at('the body') - 1], RULE, 'the metadata block and the body are separated');
    assert.equal(lines[at('─ ana') - 1], RULE, 'the body and the comments are separated');
    assert.equal(lines[at('─ beto') - 1], RULE, 'each comment is separated from the next');
    assert.deepEqual(ruleRows(lines), [at('the body') - 1, at('─ ana') - 1, at('─ beto') - 1],
      'exactly those three rows carry a rule and no two rules are adjacent');
    const paintedRules = calls.filter((call) => call.text === RULE);
    assert.equal(paintedRules.length, 3, 'each rule is painted through the caller seam');
    assert.ok(paintedRules.every((call) => call.role === 'muted'), 'the rule takes the muted role');
    assert.equal([...RULE].length, WIDTH, 'the rule spans the whole pane');
  });

  test('a comment-free issue draws only the rule before the body', () => {
    const { lines } = painted({ ...FULL, body: '' }, []);
    const body = lines.indexOf('(no description)');
    assert.notEqual(body, -1, 'the placeholder is still the body block');
    assert.deepEqual(ruleRows(lines), [body - 1], 'nothing separates a body from no comments');
    assert.equal(lines.at(-1), '(end of issue)');
  });

  test('a pending read separates nothing it has not painted', () => {
    const { lines } = painted({ number: 12, title: 'pending read' }, [], { pending: true });
    assert.ok(!lines.includes(RULE), 'a pane with no body and no comments draws no rule');
  });

  test('the rule is exactly the pane width at any width', () => {
    for (const width of [12, 40, 121]) {
      const rule = '─'.repeat(width);
      const lines = issueDetailLines(FULL, [], { width, paint: plain, emphasis: bold, now: NOW });
      assert.deepEqual(lines.reduce((found, line, at) => (line === rule ? [...found, at] : found), []),
        [lines.indexOf('the body') - 1], `one full-width rule at ${width}`);
    }
  });
});

// The hover highlight paints the linked number the pointer is over, through the
// same role the rail uses for a hovered row, and changes nothing about the
// published click geometry.
describe('the hovered linked PR is the one painted as the target', () => {
  function paintedCalls(hover) {
    const calls = [];
    const ranges = [];
    const paint = (role, text) => {
      calls.push({ role, text: String(text) });
      return String(text);
    };
    const lines = issueDetailLines(FULL, [], {
      width: 80,
      paint,
      emphasis: bold,
      now: NOW,
      ranges,
      hover,
    });
    return { calls, lines, ranges };
  }

  test('only the hovered number takes the hover role', () => {
    const { calls, lines } = paintedCalls(77);
    const targets = calls.filter((call) => call.role === 'accent').map((call) => call.text);
    assert.ok(targets.includes('#77'), 'the hovered number is painted as the target');
    assert.ok(!targets.includes('#69'), 'the other number keeps its plain text');
    assert.match(lines.find((line) => line.includes('linked PRs:')), /#69, #77/,
      'the painted row still carries both numbers');
  });

  test('no hover paints no target, and the click geometry is identical either way', () => {
    const hovered = paintedCalls(77);
    const plainRun = paintedCalls(null);
    assert.ok(!plainRun.calls.some((call) => call.role === 'accent' && call.text === '#77'),
      'without hover no number takes the switch role');
    assert.deepEqual(hovered.ranges, plainRun.ranges, 'hover never moves a click range');
  });
});
